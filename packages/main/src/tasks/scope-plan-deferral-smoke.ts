#!/usr/bin/env node
/**
 * N8 (v4.1 cost plan): the PLAN scope-plan reviewer runs beside the first DEV
 * implementer (core/scope-plan-deferral.ts). Before, PLAN→DEV waited 1.4-2.3
 * min per run for its verdict although nothing in DEV reads it.
 *
 * With a fake `codex` whose scope reviewer holds until released (a live
 * managed scope-plan run launched in PLAN):
 *   A. while the run is live and no verdict exists, the DEV-entry predicate
 *      defers the verdict (missingPlanScopeCheckFailure null with the pending
 *      run), and REVIEW entry refuses [scope_check_pending];
 *   B. the Story enters DEV; the released run saves its verdict IN DEV (bound to
 *      the run); a verdict with a gap blocks REVIEW entry [scope_gap] (the
 *      xstate DEV→REVIEW guard too) and names story_advance PLAN;
 *   C. a covered verdict saved in DEV admits REVIEW entry (scope part);
 *   D. in DEV, a save without a live PLAN-launched scope run is refused;
 *   E. old path: a verdict saved BEFORE DEV entry is not re-judged at REVIEW.
 *
 * Usage: node packages/main/dist/tasks/scope-plan-deferral-smoke.js
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StoryStore } from '../core/store.js';
import { createHostRunHandlers } from '../handlers/host-run.js';
import { readManagedHostRunProjection, runManagedHostRunWorker } from '../core/managed-host-run.js';
import { missingPlanScopeCheckFailure } from '../core/plan-scope-check-requirement.js';
import { pendingScopePlanRun, scopeVerdictReviewEntryFailure } from '../core/scope-plan-deferral.js';
import { canMintReviewRoundGuard } from '../core/machine.js';
import { loadConfig, resetConfigCache } from '../core/config.js';
import { resolveWorkflowPolicy } from '../core/workflow-policy.js';
import { STORY_REQUEST_FILE } from '../core/story-request.js';

const MARKER = 'scope-plan deferral (v4.1 N8)';
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const ROLE = 'proof-or-stop-review-scope-plan';
const THREAD = '019a0000-0000-7000-8000-0000000080aa';

function payload(storyId: string, features: Array<{ feature: string; status: string; covered_by: string | null }>): string {
  return JSON.stringify({
    storyId,
    features: features.map(f => ({ ...f, excluded_by: null, source: 'request.md' })),
    summary: { total: features.length, covered: features.filter(f => f.status === 'covered').length, excluded: 0, gaps: features.filter(f => f.status === 'gap').length },
    readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
    openQuestions: [],
  });
}

/** Fake Codex: waits for scripts/release, then runs scripts/fresh.json commands as Codex tool calls. */
function writeFakeCodex(bin: string, dir: string, codexHome: string): void {
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');
const dir = ${JSON.stringify(dir)};
let input = ''; process.stdin.on('data', d => { input += d; }); process.stdin.on('end', () => {
  const emit = e => process.stdout.write(JSON.stringify(e) + '\\n');
  emit({ type: 'thread.started', thread_id: ${JSON.stringify(THREAD)} });
  const sessions = path.join(${JSON.stringify(codexHome)}, 'sessions', '2026', '10', '08');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'rollout-2026-10-08T05-40-25-${THREAD}.jsonl'), '{}\\n');
  emit({ type: 'turn.started' });
  const until = Date.now() + 60000;
  const tick = () => {
    if (!fs.existsSync(path.join(dir, 'release')) && Date.now() < until) { emit({ type: 'item.completed', item: { type: 'reasoning', text: 'reading' } }); return setTimeout(tick, 200); }
    const script = JSON.parse(fs.readFileSync(path.join(dir, 'fresh.json'), 'utf8'));
    for (const command of script.commands) {
      const r = spawnSync('python3', ['-c', 'import os,sys; os.setsid(); os.execvp("/bin/sh", ["/bin/sh", "-c", sys.argv[1]])', command], { encoding: 'utf8', env: process.env });
      const out = (r.stdout || '') + (r.stderr || '');
      fs.appendFileSync(path.join(dir, 'commands.jsonl'), JSON.stringify({ command, status: r.status, out }) + '\\n');
      emit({ type: 'item.completed', item: { type: 'command_execution', command, aggregated_output: out.slice(-2000), exit_code: r.status } });
    }
    emit({ type: 'item.completed', item: { type: 'agent_message', text: 'Scope review complete.' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 } });
  };
  tick();
});
`, { mode: 0o755 });
  chmodSync(join(bin, 'codex'), 0o755);
}

interface Fixture { root: string; store: StoryStore; storyId: string; scripts: string }

function fixture(tag: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `scope-plan-deferral-${tag}-`));
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: 'src', outDir: 'dist', testsDir: 'tests',
    fixturesDir: 'tests/fixtures', storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
  }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'subject.ts'), 'export const subject = true;\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Scope deferral fixture');
  git('config', 'user.email', 'scope-deferral@example.invalid');
  const storyId = `B-scope-defer-${tag}`;
  const store = new StoryStore(root);
  const t0 = new Date(Date.now() - 60_000).toISOString();
  store.writeStory(storyId, {
    storyId, name: `scope-defer-${tag}`, title: 'Scope verdict deferred past DEV entry',
    description: 'The scope-plan reviewer runs beside DEV.', type: 'feature', phase: 'PLAN', priority: 'medium',
    createdAt: t0, events: [{ phase: 'PLAN', action: 'advance', timestamp: t0 }],
  } as never);
  store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'Stepped slices', context: 'Fixture.', status: 'todo' }] } as never);
  writeFileSync(store.storyFilePath(storyId, STORY_REQUEST_FILE), 'Support value[start:end:step] slices.\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const bin = join(root, 'bin');
  const scripts = join(root, 'scripts');
  const codexHome = join(root, 'codex-home');
  mkdirSync(bin, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  writeFakeCodex(bin, scripts, codexHome);
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  process.env.PROOF_OR_STOP_PROJECT_ROOT = root;
  process.env.CODEX_HOME = codexHome;
  resetConfigCache();
  return { root, store, storyId, scripts };
}

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

function saveCommand(f: Fixture, body: string, log: string): string {
  return `cd ${q(f.root)} && ${q(process.execPath)} ${q(CLI)} scope_check_save ${q(body)} >${q(join(f.scripts, log))} 2>&1; cat ${q(join(f.scripts, log))}`;
}

function log(f: Fixture, name: string): string {
  const path = join(f.scripts, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Launch the managed scope-plan run (in PLAN); the fake provider holds until released. */
async function launch(f: Fixture): Promise<{ runId: string; done: Promise<void> }> {
  let settle!: () => void;
  const done = new Promise<void>(resolve => { settle = resolve; });
  const handlers = createHostRunHandlers({ root: f.root, scanRoot: f.root, store: f.store } as never, {
    launchWorker: async (request: unknown) => {
      void runManagedHostRunWorker(request as never, { env: process.env } as never).finally(() => settle());
      return { pid: process.pid };
    },
  } as never);
  const result = await handlers.host_run({ host: 'codex', storyId: f.storyId, agentType: ROLE, managedDispatch: true,
    deadlineMs: 90_000, timeoutMs: 80_000, detach: true, json: true } as never) as { run: { runId: string } };
  return { runId: result.run.runId, done };
}

function enterDev(f: Fixture): void {
  const story = f.store.readStory(f.storyId);
  f.store.writeStory(f.storyId, { ...story, phase: 'DEV', events: [...(story.events ?? []), { phase: 'DEV', action: 'advance', timestamp: new Date().toISOString() }] } as never);
}

function reviewEntry(f: Fixture): string | null {
  const story = f.store.readStory(f.storyId);
  return scopeVerdictReviewEntryFailure(f.store, f.root, story, resolveWorkflowPolicy(loadConfig(f.root), story));
}

async function scenario(gap: boolean): Promise<void> {
  const f = fixture(gap ? 'gap' : 'covered');
  try {
    const features = gap
      ? [{ feature: 'value[start:end:step] slices', status: 'covered', covered_by: 'CHK-001' }, { feature: 'negative step', status: 'gap', covered_by: null }]
      : [{ feature: 'value[start:end:step] slices', status: 'covered', covered_by: 'CHK-001' }];
    writeFileSync(join(f.scripts, 'fresh.json'), JSON.stringify({ commands: [saveCommand(f, payload(f.storyId, features), 'save.log')] }));
    const run = await launch(f);
    // A: live run, no verdict.
    const pending = pendingScopePlanRun(f.root, f.storyId);
    assert.equal(pending?.runId, run.runId, `${MARKER} A: the live PLAN-launched scope run is pending`);
    const story = f.store.readStory(f.storyId);
    const policy = resolveWorkflowPolicy(loadConfig(f.root), story);
    assert.ok(missingPlanScopeCheckFailure(f.store, story, policy), `${MARKER} A: without the pending probe the verdict is still required at DEV entry`);
    assert.equal(missingPlanScopeCheckFailure(f.store, story, policy, () => pendingScopePlanRun(f.root, f.storyId) !== null), null,
      `${MARKER} A: DEV entry defers the missing verdict while its run is live`);
    enterDev(f);
    assert.match(reviewEntry(f) ?? '', /\[scope_check_pending\]/, `${MARKER} A: REVIEW entry waits for the pending verdict`);
    // B/C: the run saves its verdict in DEV.
    writeFileSync(join(f.scripts, 'release'), '');
    await run.done;
    const terminal = readManagedHostRunProjection(f.root, run.runId).terminal as { state?: string; reason?: string } | null;
    const diagnostic = `\nsave: ${log(f, 'save.log')}\nterminal: ${JSON.stringify(terminal)}`;
    assert.match(log(f, 'save.log'), /scope_check_save done/, `${MARKER} B: the deferred run saves its verdict in DEV${diagnostic}`);
    assert.equal(f.store.readScopeCheck(f.storyId)?.deliveryRunId, run.runId, `${MARKER} B: the DEV save is bound to the run${diagnostic}`);
    assert.equal(terminal?.state, 'completed', `${MARKER} B: the run completes${diagnostic}`);
    const failure = reviewEntry(f);
    const guard = canMintReviewRoundGuard({ storyId: f.storyId, store: f.store, projectRoot: f.root });
    if (gap) {
      assert.match(failure ?? '', /\[scope_gap\][\s\S]*story_advance[\s\S]*PLAN/, `${MARKER} B: a gap found after DEV started blocks REVIEW and names PLAN: ${failure}`);
      assert.equal(guard, false, `${MARKER} B: the xstate DEV→REVIEW guard refuses too`);
    } else {
      assert.equal(failure, null, `${MARKER} C: a covered deferred verdict admits REVIEW entry (scope part): ${failure}`);
    }
    // D: no live run → a DEV save is refused.
    const refused = spawnSync(process.execPath, [CLI, 'scope_check_save', payload(f.storyId, features)], { cwd: f.root, encoding: 'utf8', env: process.env });
    assert.notEqual(refused.status, 0, `${MARKER} D: a DEV-phase save without a live PLAN-launched scope run is refused`);
    assert.match(`${refused.stdout}${refused.stderr}`, /only the managed scope-plan run launched in PLAN/, `${MARKER} D: refused by the deferral rule: ${refused.stdout}${refused.stderr}`);
    console.log(`${gap ? 'gap' : 'covered'} ok: deferred, saved in DEV by ${run.runId}, REVIEW ${failure ? 'blocked' : 'admitted'}; unbound DEV save refused`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

function oldPath(): void {
  const f = fixture('old');
  try {
    const story = f.store.readStory(f.storyId);
    f.store.writeScopeCheck(f.storyId, { storyId: f.storyId, checkedAt: new Date(Date.now() - 30_000).toISOString(), features: [], summary: { total: 0, covered: 0, excluded: 0, gaps: 0 }, reviewRound: '', _hash: 'legacy' } as never);
    enterDev(f);
    assert.equal(reviewEntry(f), null, `${MARKER} E: a verdict saved before DEV entry is not re-judged at REVIEW (old path); story was ${story.phase}`);
    console.log('old path ok');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

const saved = { PATH: process.env.PATH, PROOF_OR_STOP_PROJECT_ROOT: process.env.PROOF_OR_STOP_PROJECT_ROOT, CODEX_HOME: process.env.CODEX_HOME };
try {
  for (const key of ['LATTICE_MANAGED_INIT_INVOCATION', 'LATTICE_MANAGED_HOST_RUN_ID', 'PROOF_OR_STOP_AGENT']) delete process.env[key];
  await scenario(true);
  process.env.PATH = saved.PATH;
  await scenario(false);
  process.env.PATH = saved.PATH;
  oldPath();
  console.log('SCOPE_PLAN_DEFERRAL_GREEN');
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
