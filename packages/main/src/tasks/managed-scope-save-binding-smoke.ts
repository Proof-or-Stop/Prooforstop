#!/usr/bin/env node
/**
 * Regression (old-PoS bench run 20, abs-stepped-slices, PLAN scope reviewer
 * run 265cbed2): the provider worked normally (turn.completed, exit 0), but the
 * run ended managed_dispatch_output_missing and a full cold re-review followed.
 *
 *   1. The reviewer's first scope_check_save (a probe payload) consumed the
 *      run's one-shot signed invocation.
 *   2. Its real save was refused "attestation was already consumed. Use a fresh
 *      host_run managedDispatch reviewer" -- a same-run re-save had no re-bind.
 *   3. It then saved under `env -u LATTICE_MANAGED_INIT_INVOCATION`. With no
 *      invocation in the environment, scope_check_save wrote an UNBOUND
 *      scope-check (deliveryRunId null) over the bound one, so the output seal
 *      found no delivery. (The recorded "exit 1" is the failed-terminal
 *      projection of a provider exit 0, not a provider error.)
 *
 * Contract checked here, with a fake `codex` that runs each tool command in a
 * fresh session (setsid), as the real Codex tool host does:
 *   A. probe save, real save, `env -u` save in one run: the real save re-binds
 *      to the live run, the `env -u` save is refused naming the variable (it
 *      never overwrites bound output), the refusal is journaled on the run,
 *      and the run completes with the real payload sealed.
 *   B. a run whose only save is refused (`env -u`) is not output_missing: the
 *      worker resumes the same (non-ephemeral) Codex session once with the
 *      exact refusal; the corrected save binds and the run completes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StoryStore } from '../core/store.js';
import { createHostRunHandlers } from '../handlers/host-run.js';
import { managedHostRunDirectory, readManagedHostRunProjection, runManagedHostRunWorker } from '../core/managed-host-run.js';

const MARKER = 'managed scope save binding (old-PoS run 20)';
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const ROLE = 'proof-or-stop-review-scope-plan';
const THREAD = '019a0000-0000-7000-8000-0000000020aa';

function payload(storyId: string, features: Array<{ feature: string; status: string; covered_by: string | null }>): string {
  const covered = features.filter(f => f.status === 'covered').length;
  const gaps = features.filter(f => f.status === 'gap').length;
  return JSON.stringify({
    storyId,
    features: features.map(f => ({ ...f, excluded_by: null, source: 'request.md' })),
    summary: { total: features.length, covered, excluded: 0, gaps },
    readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
    openQuestions: [],
  });
}

/**
 * Fake Codex: `exec ... -` (fresh) or `exec resume ... <thread> -`. It runs the
 * commands of scripts/<mode>.json, each in a new session like Codex tool
 * calls, logging argv + output, and prints the Codex JSON event stream.
 */
function writeFakeCodex(bin: string, dir: string, codexHome: string): void {
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');
const dir = ${JSON.stringify(dir)};
let input = ''; process.stdin.on('data', d => { input += d; }); process.stdin.on('end', () => {
  const emit = e => process.stdout.write(JSON.stringify(e) + '\\n');
  const resume = process.argv[2] === 'exec' && process.argv[3] === 'resume';
  const mode = resume ? 'resume' : 'fresh';
  fs.appendFileSync(path.join(dir, 'launches.jsonl'), JSON.stringify({ mode, argv: process.argv.slice(2), prompt: input }) + '\\n');
  emit({ type: 'thread.started', thread_id: ${JSON.stringify(THREAD)} });
  const sessions = path.join(${JSON.stringify(codexHome)}, 'sessions', '2026', '10', '07');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'rollout-2026-10-07T05-40-25-${THREAD}.jsonl'), '{}\\n');
  emit({ type: 'turn.started' });
  const script = JSON.parse(fs.readFileSync(path.join(dir, mode + '.json'), 'utf8'));
  for (const command of script.commands) {
    const r = spawnSync('python3', ['-c', 'import os,sys; os.setsid(); os.execvp("/bin/sh", ["/bin/sh", "-c", sys.argv[1]])', command], { encoding: 'utf8', env: process.env });
    const out = (r.stdout || '') + (r.stderr || '');
    fs.appendFileSync(path.join(dir, 'commands.jsonl'), JSON.stringify({ mode, command, status: r.status, out }) + '\\n');
    emit({ type: 'item.completed', item: { type: 'command_execution', command, aggregated_output: out.slice(-2000), exit_code: r.status } });
  }
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'Scope review complete.' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 } });
});
`, { mode: 0o755 });
  chmodSync(join(bin, 'codex'), 0o755);
}

interface Fixture { root: string; store: StoryStore; storyId: string; scripts: string; codexHome: string }

function fixture(tag: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `managed-scope-save-${tag}-`));
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
  git('config', 'user.name', 'Managed scope save fixture');
  git('config', 'user.email', 'managed-scope-save@example.invalid');
  const storyId = `B-scope-save-${tag}`;
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: `scope-save-${tag}`, title: 'Managed scope reviewer save binding',
    description: 'A managed PLAN scope reviewer save must bind to its live run.',
    type: 'bug', phase: 'PLAN', priority: 'high', createdAt: new Date().toISOString(), events: [],
  } as never);
  store.writeChecklist(storyId, {
    items: [{ id: 'CHK-001', title: 'Stepped slices', context: 'Regression fixture.', status: 'todo' }],
  } as never);
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
  return { root, store, storyId, scripts, codexHome };
}

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

function save(f: Fixture, body: string, opts: { unset?: boolean; log: string }): string {
  const prefix = opts.unset ? 'env -u LATTICE_MANAGED_INIT_INVOCATION ' : '';
  return `cd ${q(f.root)} && ${prefix}${q(process.execPath)} ${q(CLI)} scope_check_save ${q(body)} >${q(join(f.scripts, opts.log))} 2>&1; cat ${q(join(f.scripts, opts.log))}`;
}

async function launch(f: Fixture): Promise<{ runId: string; state: string; reason: string }> {
  const handlers = createHostRunHandlers({ root: f.root, scanRoot: f.root, store: f.store } as never, {
    launchWorker: async (request: unknown) => {
      void runManagedHostRunWorker(request as never, { env: process.env } as never);
      return { pid: process.pid };
    },
  } as never);
  const result = await handlers.host_run({
    host: 'codex', storyId: f.storyId, agentType: ROLE, managedDispatch: true,
    deadlineMs: 60_000, timeoutMs: 50_000, json: true,
  } as never) as { runId: string };
  const terminal = readManagedHostRunProjection(f.root, result.runId).terminal as { state?: string; reason?: string } | null;
  return { runId: result.runId, state: String(terminal?.state ?? ''), reason: String(terminal?.reason ?? '') };
}

function events(f: Fixture, runId: string): string {
  return readFileSync(join(managedHostRunDirectory(f.root, runId), 'events.jsonl'), 'utf8');
}

function log(f: Fixture, name: string): string {
  const path = join(f.scripts, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

async function scenarioA(): Promise<void> {
  const f = fixture('a');
  try {
    const probe = payload(f.storyId, [{ feature: 'test', status: 'gap', covered_by: null }]);
    const real = payload(f.storyId, [
      { feature: 'value[start:end:step] slices arrays and strings', status: 'covered', covered_by: 'CHK-001' },
      { feature: 'step zero is an error', status: 'covered', covered_by: 'CHK-001' },
    ]);
    writeFileSync(join(f.scripts, 'fresh.json'), JSON.stringify({ commands: [
      save(f, probe, { log: 'probe.log' }),
      save(f, real, { log: 'real.log' }),
      save(f, real, { unset: true, log: 'unset.log' }),
    ] }));
    const run = await launch(f);
    const scope = f.store.readScopeCheck(f.storyId) as { deliveryRunId?: string; features: Array<{ feature: string }> } | null;
    const diagnostic = `\nprobe: ${log(f, 'probe.log')}\nreal: ${log(f, 'real.log')}\nunset: ${log(f, 'unset.log')}\nevents:\n${events(f, run.runId)}`;
    assert.match(log(f, 'probe.log'), /scope_check_save done/, `${MARKER} A: the probe save binds${diagnostic}`);
    assert.match(log(f, 'real.log'), /scope_check_save done/,
      `${MARKER} A: a second save of the same live run must re-bind, not be refused as already consumed${diagnostic}`);
    assert.doesNotMatch(log(f, 'unset.log'), /scope_check_save done/,
      `${MARKER} A: a save that strips LATTICE_MANAGED_INIT_INVOCATION while the managed run is live must be refused, not written unbound${diagnostic}`);
    assert.match(log(f, 'unset.log'), /LATTICE_MANAGED_INIT_INVOCATION/, `${MARKER} A: the refusal names the stripped variable${diagnostic}`);
    assert.doesNotMatch(log(f, 'unset.log'), /fresh host_run/, `${MARKER} A: the refusal never sends the in-run reviewer to a fresh run${diagnostic}`);
    assert.match(events(f, run.runId), /managed_dispatch_save_refused/, `${MARKER} A: the refusal is journaled on the live run${diagnostic}`);
    assert.equal(scope?.deliveryRunId, run.runId, `${MARKER} A: scope-check stays bound to the run${diagnostic}`);
    assert.deepEqual(scope?.features.map(row => row.feature), ['value[start:end:step] slices arrays and strings', 'step zero is an error'],
      `${MARKER} A: the real payload (not the probe) is sealed${diagnostic}`);
    assert.equal(`${run.state}/${run.reason}`, 'completed/provider_completed', `${MARKER} A: terminal${diagnostic}`);
    console.log(`A ok: probe + re-bind + env -u refused; run ${run.state} (${run.reason})`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

async function scenarioB(): Promise<void> {
  const f = fixture('b');
  try {
    const real = payload(f.storyId, [{ feature: 'value[start:end:step] slices arrays and strings', status: 'covered', covered_by: 'CHK-001' }]);
    writeFileSync(join(f.scripts, 'fresh.json'), JSON.stringify({ commands: [save(f, real, { unset: true, log: 'unset.log' })] }));
    writeFileSync(join(f.scripts, 'resume.json'), JSON.stringify({ commands: [save(f, real, { log: 'repair.log' })] }));
    const run = await launch(f);
    const launches = log(f, 'launches.jsonl').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { mode: string; argv: string[]; prompt: string });
    const diagnostic = `\nunset: ${log(f, 'unset.log')}\nrepair: ${log(f, 'repair.log')}\nlaunches: ${launches.map(l => `${l.mode} ${l.argv.join(' ')}`).join(' | ')}\nevents:\n${events(f, run.runId)}`;
    assert.ok(!launches[0]?.argv.includes('--ephemeral'), `${MARKER} B: the scope reviewer session is kept for repair${diagnostic}`);
    assert.equal(launches.length, 2, `${MARKER} B: an unbound save gets exactly one same-session repair turn${diagnostic}`);
    assert.deepEqual(launches[1]!.argv.slice(0, 2), ['exec', 'resume'], `${MARKER} B: the repair resumes the same session${diagnostic}`);
    assert.equal(launches[1]!.argv.at(-2), THREAD, `${MARKER} B: the repair resumes this run's own thread${diagnostic}`);
    const refusal = log(f, 'unset.log').split('\n').find(line => /^Error: /.test(line))?.replace(/^Error: /, '') ?? '';
    assert.ok(refusal.length > 0, `${MARKER} B: the stripped save was refused${diagnostic}`);
    assert.ok(launches[1]!.prompt.includes(refusal.slice(0, 200)), `${MARKER} B: the repair prompt quotes the exact refusal${diagnostic}\nprompt: ${launches[1]!.prompt}`);
    assert.match(launches[1]!.prompt, /do not review again/i);
    assert.match(events(f, run.runId), /"outcome":"bound"[^\n]*"type":"managed_dispatch_save_repair_outcome"/, `${MARKER} B: repair outcome journaled${diagnostic}`);
    assert.equal(f.store.readScopeCheck(f.storyId)?.deliveryRunId, run.runId, `${MARKER} B: the repaired save is bound${diagnostic}`);
    assert.equal(`${run.state}/${run.reason}`, 'completed/provider_completed', `${MARKER} B: terminal${diagnostic}`);
    console.log(`B ok: refused save repaired in the same session; run ${run.state} (${run.reason})`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

const saved = { PATH: process.env.PATH, PROOF_OR_STOP_PROJECT_ROOT: process.env.PROOF_OR_STOP_PROJECT_ROOT, CODEX_HOME: process.env.CODEX_HOME };
try {
  for (const key of ['LATTICE_MANAGED_INIT_INVOCATION', 'LATTICE_MANAGED_HOST_RUN_ID', 'PROOF_OR_STOP_AGENT']) delete process.env[key];
  const only = process.env.MANAGED_SCOPE_SAVE_SCENARIO;
  if (!only || only === 'A') await scenarioA();
  process.env.PATH = saved.PATH;
  if (!only || only === 'B') await scenarioB();
  console.log('MANAGED_SCOPE_SAVE_BINDING_GREEN');
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
