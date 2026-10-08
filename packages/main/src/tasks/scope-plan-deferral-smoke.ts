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
 *   F. no deferral when the reviewer has something to audit (N8 x pin audit,
 *      old-PoS run 23): with an intent pinning a value the request does not
 *      quote (a pin-audit row), or a request same-semantics sentence, a live
 *      PLAN-launched run does NOT admit DEV entry: the DEV-entry predicate
 *      refuses [missing_scope_check] naming the run to wait on, story_review
 *      reports the blocker (not the scope_check_pending advisory) and `next`
 *      waits on the run instead of proposing DEV. A pin-audit gap therefore
 *      lands before any item is implemented against the pin.
 *   G. per-item hold (old-PoS run 27 §2 row 4): only the items that carry
 *      pin-audit rows or are covered by a same-semantics sentence (cite its
 *      request section) are held. DEV entry is admitted beside the live run;
 *      next implements the free items, waits on the run before a held item,
 *      the implementer dispatch of a held item is refused
 *      [scope_verdict_held_item], and a gap verdict sends the Story back to
 *      PLAN before the held item. The rerun prompt in PLAN carries the previous
 *      verdict's gaps and the checklist diff since it.
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
import { pendingScopePlanRun, scopeVerdictDeferral, scopeVerdictReviewEntryFailure } from '../core/scope-plan-deferral.js';
import { canMintReviewRoundGuard } from '../core/machine.js';
import { loadConfig, resetConfigCache } from '../core/config.js';
import { resolveWorkflowPolicy } from '../core/workflow-policy.js';
import { writeStoryRequest } from '../core/story-request.js';

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
  // A signed request with nothing to pin-audit (A-E defer); F re-records it.
  writeStoryRequest(store, { storyId, phase: 'INIT', request: 'Support value[start:end:step] slices.\n', source: 'fixture' });
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

function nextStep(f: Fixture): { reason: string; why: string; cli?: { payload: Record<string, unknown> } } {
  const run = spawnSync(process.execPath, [CLI, 'next', JSON.stringify({ storyId: f.storyId, json: true })], { cwd: f.root, encoding: 'utf8', env: process.env });
  const text = run.stdout ?? '';
  try { return JSON.parse(text.slice(text.indexOf('{'))) as never; } catch { throw new Error(`${MARKER}: next --json failed (exit ${run.status}): ${text.slice(-600)}${(run.stderr ?? '').slice(-600)}`); }
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
    assert.equal(scopeVerdictDeferral(f.store, f.root, f.storyId).kind, 'deferred', `${MARKER} A: nothing to audit, so the shared predicate defers`);
    assert.equal(missingPlanScopeCheckFailure(f.store, story, policy, () => scopeVerdictDeferral(f.store, f.root, f.storyId)), null,
      `${MARKER} A: DEV entry defers the missing verdict while its run is live`);
    enterDev(f);
    assert.match(reviewEntry(f) ?? '', /\[scope_check_pending\]/, `${MARKER} A: REVIEW entry waits for the pending verdict`);
    const devStep = nextStep(f);
    assert.ok(devStep.reason !== 'managed_run_wait' && devStep.reason !== 'scope_verdict_replan',
      `${MARKER} A: next in DEV works on the items while the scope run is live (got ${devStep.reason}: ${devStep.why})`);
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
      const replan = nextStep(f);
      assert.equal(replan.reason, 'scope_verdict_replan', `${MARKER} B: next returns the Story to PLAN before more DEV work (got ${replan.reason}: ${replan.why})`);
      assert.equal(replan.cli?.payload.phase, 'PLAN', `${MARKER} B: the replan step is story_advance PLAN`);
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

/** F: a live run whose prompt has something to audit holds DEV entry until its verdict. */
async function heldScenario(kind: 'pin' | 'same-semantics'): Promise<void> {
  const f = fixture(kind === 'pin' ? 'held-pin' : 'held-same');
  try {
    const request = kind === 'pin'
      ? 'Support value[start:end:step] assignment.\n'
      : 'Support value[start:end:step] assignment.\nUse the same index-selection semantics as read slicing.\n';
    writeStoryRequest(f.store, { storyId: f.storyId, phase: 'PLAN', request, source: 'fixture',
      amendmentReason: 'fixture: the held-deferral scenario records a signed verbatim request' });
    if (kind === 'pin') {
      const checklist = f.store.readChecklist(f.storyId);
      f.store.writeChecklist(f.storyId, { ...checklist, items: checklist.items.map(item => ({ ...item, verificationIntent: {
        happy: [{ desc: 'a[::-1]=[9,8,7,6,5,4] -> [9,8,7,6,5,4]', type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' }],
        edge: [], adversarial: [] } })) } as never);
    }
    writeFileSync(join(f.scripts, 'fresh.json'), JSON.stringify({ commands: [saveCommand(f, payload(f.storyId, [{ feature: 'value[start:end:step] assignment', status: 'covered', covered_by: 'CHK-001' }]), 'save.log')] }));
    const run = await launch(f);
    assert.equal(pendingScopePlanRun(f.root, f.storyId)?.runId, run.runId, `${MARKER} F(${kind}): the PLAN-launched scope run is live`);
    const ack = spawnSync(process.execPath, [CLI, 'dev_memory_preflight_ack', JSON.stringify({ storyId: f.storyId })], { cwd: f.root, encoding: 'utf8', env: process.env });
    assert.equal(ack.status, 0, `${MARKER} F(${kind}): dev_memory_preflight_ack: ${ack.stdout}${ack.stderr}`);
    const story = f.store.readStory(f.storyId);
    const policy = resolveWorkflowPolicy(loadConfig(f.root), story);
    const deferral = scopeVerdictDeferral(f.store, f.root, f.storyId);
    assert.equal(deferral.kind, 'held', `${MARKER} F(${kind}): the shared predicate holds the verdict (got ${deferral.kind})`);
    const refusal = missingPlanScopeCheckFailure(f.store, story, policy, () => scopeVerdictDeferral(f.store, f.root, f.storyId)) ?? '';
    assert.match(refusal, /\[missing_scope_check\]/, `${MARKER} F(${kind}): DEV entry requires the saved verdict: ${refusal}`);
    assert.match(refusal, kind === 'pin' ? /pin audit/ : /same-semantics/, `${MARKER} F(${kind}): the refusal says why it is not deferred: ${refusal}`);
    assert.match(refusal, new RegExp(`Next: proof-or-stop host_run_status --runId=${run.runId}`), `${MARKER} F(${kind}): its one next action waits on the live run: ${refusal}`);
    const review = spawnSync(process.execPath, [CLI, 'story_review', JSON.stringify({ storyId: f.storyId })], { cwd: f.root, encoding: 'utf8', env: process.env });
    const reviewOut = `${review.stdout}${review.stderr}`;
    assert.match(reviewOut, /missing_scope_check/, `${MARKER} F(${kind}): story_review blocks on the missing verdict: ${reviewOut.slice(-1500)}`);
    assert.doesNotMatch(reviewOut, /scope_check_pending/, `${MARKER} F(${kind}): story_review does not defer it: ${reviewOut.slice(-1500)}`);
    const step = nextStep(f);
    assert.equal(step.reason, 'managed_run_wait', `${MARKER} F(${kind}): next waits on the scope-plan run instead of proposing DEV (got ${step.reason}: ${step.why})`);
    writeFileSync(join(f.scripts, 'release'), '');
    await run.done;
    assert.ok(f.store.readScopeCheck(f.storyId), `${MARKER} F(${kind}): the released run saves its verdict in PLAN: ${log(f, 'save.log')}`);
    console.log(`held (${kind}) ok: live run ${run.runId} not deferred; DEV entry, story_review and next wait for its verdict`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

/** G: per-item hold; free items enter DEV implementation beside the live scope run. */
async function perItemScenario(): Promise<void> {
  const f = fixture('per-item');
  try {
    const request = [
      'Extend slices with a step.', '',
      '1. Parser support', '- Accept `start:end:step` inside index brackets.', '',
      '2. Range assignment', '- Support assigning to array ranges with three-part slices.', '- Use the same index-selection semantics as read slicing.', '',
      '3. Reads', '- Positive step iterates forward.', '- Negative step iterates backward.', '',
    ].join('\n');
    writeStoryRequest(f.store, { storyId: f.storyId, phase: 'PLAN', request, source: 'fixture',
      amendmentReason: 'fixture: the per-item hold scenario records a sectioned verbatim request' });
    const intent = (desc: string, requestQuote: string, computation = `follows from the cited sentence: ${desc}`) => ({
      happy: [{ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story', derivation: { requestQuote, computation } }],
      edge: [], adversarial: [] });
    const item = (id: string, title: string, verificationIntent: unknown) => ({ id, title, context: 'Fixture.', status: 'todo', verificationIntent });
    f.store.writeChecklist(f.storyId, { items: [
      item('CHK-001', 'Parse stepped slices', intent('value[1:5:2] parses as a stepped range', 'Accept `start:end:step` inside index brackets.')),
      item('CHK-002', 'Array range assignment', intent('a[0:4:2] assignment writes indexes 0 and 2', 'Support assigning to array ranges with three-part slices.')),
      item('CHK-003', 'Backward reads', intent('[1,2,3][::-1] -> [3,2,1]', 'Negative step iterates backward.', 'reading backward from index 2 gives [3,2,1]')),
      item('CHK-004', 'Forward reads', intent('a positive step reads forward', 'Positive step iterates forward.')),
    ] } as never);
    const gapFeature = 'asymmetric-example: Use the same index-selection semantics as read slicing.';
    writeFileSync(join(f.scripts, 'fresh.json'), JSON.stringify({ commands: [saveCommand(f, payload(f.storyId, [
      { feature: 'value[start:end:step] slices', status: 'covered', covered_by: 'CHK-001' },
      { feature: gapFeature, status: 'gap', covered_by: null }]), 'save.log')] }));
    const run = await launch(f);
    const ack = spawnSync(process.execPath, [CLI, 'dev_memory_preflight_ack', JSON.stringify({ storyId: f.storyId })], { cwd: f.root, encoding: 'utf8', env: process.env });
    assert.equal(ack.status, 0, `${MARKER} G: dev_memory_preflight_ack: ${ack.stdout}${ack.stderr}`);
    const story = f.store.readStory(f.storyId);
    const policy = resolveWorkflowPolicy(loadConfig(f.root), story);
    const deferral = scopeVerdictDeferral(f.store, f.root, f.storyId) as { kind: string; heldItemIds?: string[] };
    assert.equal(deferral.kind, 'deferred', `${MARKER} G: free items exist, so the verdict is deferred per item (got ${deferral.kind})`);
    assert.deepEqual(deferral.heldItemIds, ['CHK-002', 'CHK-003'], `${MARKER} G: exactly the same-semantics section item and the pin-audit item are held`);
    assert.equal(missingPlanScopeCheckFailure(f.store, story, policy, () => scopeVerdictDeferral(f.store, f.root, f.storyId)), null,
      `${MARKER} G: DEV entry is admitted beside the live run`);
    const review = spawnSync(process.execPath, [CLI, 'story_review', JSON.stringify({ storyId: f.storyId })], { cwd: f.root, encoding: 'utf8', env: process.env });
    const reviewOut = `${review.stdout}${review.stderr}`;
    assert.match(reviewOut, /scope_check_pending[^\n]*CHK-002, CHK-003/, `${MARKER} G: story_review defers the verdict and names the held items: ${reviewOut.slice(-1500)}`);
    enterDev(f);
    const first = nextStep(f);
    assert.equal(first.cli?.payload.itemId, 'CHK-001', `${MARKER} G: next implements the first free item (got ${first.reason}: ${JSON.stringify(first.cli?.payload)})`);
    const checklist = f.store.readChecklist(f.storyId);
    f.store.writeChecklist(f.storyId, { ...checklist, items: checklist.items.map(row => ['CHK-001', 'CHK-004'].includes(row.id) ? { ...row, status: 'done' } : row) } as never);
    const held = nextStep(f);
    assert.equal(held.reason, 'managed_run_wait', `${MARKER} G: only held items remain, so next waits on the scope run (got ${held.reason}: ${held.why})`);
    assert.match(held.why, /CHK-002/, `${MARKER} G: the wait names the held item: ${held.why}`);
    const dispatch = spawnSync(process.execPath, [CLI, 'dispatch', JSON.stringify({ storyId: f.storyId, agentType: 'proof-or-stop-implementer', itemId: 'CHK-002' })], { cwd: f.root, encoding: 'utf8', env: process.env });
    assert.notEqual(dispatch.status, 0, `${MARKER} G: the implementer dispatch of a held item is refused`);
    assert.match(`${dispatch.stdout}${dispatch.stderr}`, /\[scope_verdict_held_item\]/, `${MARKER} G: refusal code: ${dispatch.stdout}${dispatch.stderr}`);
    writeFileSync(join(f.scripts, 'release'), '');
    await run.done;
    assert.ok(f.store.readScopeCheck(f.storyId), `${MARKER} G: the deferred run saved its verdict in DEV: ${log(f, 'save.log')}`);
    const replan = nextStep(f);
    assert.equal(replan.reason, 'scope_verdict_replan', `${MARKER} G: the gap sends the Story back to PLAN before the held item (got ${replan.reason}: ${replan.why})`);
    // Rerun prompt (row 4b): back in PLAN the owner adds the asymmetric row to CHK-002.
    const devStory = f.store.readStory(f.storyId);
    f.store.writeStory(f.storyId, { ...devStory, phase: 'PLAN', events: [...(devStory.events ?? []), { phase: 'PLAN', action: 'advance', timestamp: new Date().toISOString() }] } as never);
    const planChecklist = f.store.readChecklist(f.storyId);
    const addedRow = 'a=[1,2,3]; a[::-1]=[30,20,10] assigns backward so a is [10,20,30]';
    f.store.writeChecklist(f.storyId, { ...planChecklist, items: planChecklist.items.map(row => row.id === 'CHK-002'
      ? { ...row, verificationIntent: { ...row.verificationIntent!, happy: [...(row.verificationIntent?.happy ?? []), { desc: addedRow, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story',
        derivation: { requestQuote: 'Use the same index-selection semantics as read slicing.', computation: 'read slicing a[::-1] selects indexes 2,1,0, so 30,20,10 land there: [10,20,30]' } }] } }
      : row) } as never);
    const rerun = spawnSync(process.execPath, [CLI, 'dispatch', JSON.stringify({ storyId: f.storyId, agentType: ROLE })], { cwd: f.root, encoding: 'utf8', env: process.env });
    const prompt = `${rerun.stdout}${rerun.stderr}`;
    assert.equal(rerun.status, 0, `${MARKER} G: the scope-plan rerun dispatch renders: ${prompt.slice(-800)}`);
    assert.match(prompt, /Previous scope-plan verdict/, `${MARKER} G: the rerun prompt carries the previous verdict: ${prompt.slice(-2500)}`);
    assert.ok(prompt.includes(gapFeature), `${MARKER} G: the previous verdict's gap is listed`);
    assert.match(prompt, /CHK-002[^\n]*\n[^\n]*\+ happy: a=\[1,2,3\]; a\[::-1\]=\[30,20,10\]/, `${MARKER} G: the checklist diff names the added CHK-002 row: ${prompt.slice(-2500)}`);
    console.log(`per-item ok: CHK-002/CHK-003 held beside run ${run.runId}; CHK-001 implemented; held dispatch refused; gap → PLAN; rerun prompt carries the verdict + diff`);
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
  await heldScenario('pin');
  process.env.PATH = saved.PATH;
  await heldScenario('same-semantics');
  process.env.PATH = saved.PATH;
  await perItemScenario();
  process.env.PATH = saved.PATH;
  console.log('SCOPE_PLAN_DEFERRAL_GREEN');
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
