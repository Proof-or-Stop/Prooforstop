#!/usr/bin/env node
// Lab validation-terminal-refusal-reasons RED/GREEN.
//
// Bug: a Story validation that is NOT reused prints its reuse refusal only to
// stderr ("routine validation reuse refused: refusalReasons=..."). The durable
// validation_terminal event records disposition=executed and nothing about why.
// On main, 647 executed terminals across 394 Stories carry no refusal reason, so
// 63 same-identity re-executions (5,140 command runs) cannot be attributed after
// the session transcript is gone.
//
// This script builds this checkout's packages/main, then drives the real CLI
// against disposable Git fixtures. It asserts on the persisted process events
// only, and proves the repair is observational: reuse still happens when it did
// before, the TEST gate still reuses, and the duplicate-suite grouping keys are
// unchanged.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MARKER = 'executed validation terminal does not record why reuse was refused';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repoRoot, 'packages/main/dist/cli.js');

const build = spawnSync('npm', ['--prefix', 'packages/main', 'run', 'build'], { cwd: repoRoot, encoding: 'utf8' });
if (build.status !== 0) {
  process.stderr.write(`${build.stdout}\n${build.stderr}\n`);
  throw new Error('packages/main build failed; this is not the target RED');
}

const { StoryStore } = await import(pathToFileURL(join(repoRoot, 'packages/main/dist/core/store.js')).href);
const { persistSyntheticAdmittedWindowForTest } = await import(pathToFileURL(join(repoRoot, 'packages/main/dist/core/certification-window.js')).href);
const { deriveCertificationDomainInputHashes } = await import(pathToFileURL(join(repoRoot, 'packages/main/dist/handlers/certification-window.js')).href);

const red = [];
let checks = 0;
const expectRepaired = (ok, message) => { if (ok) checks++; else red.push(message); };
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(name, validateConfig, { noValidator = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), `pos-terminal-reasons-${name}-`));
  const counter = join(root, '.probe-counter.log');
  const storyId = `B-trr-${name}`;
  writeFileSync(join(root, '.gitignore'), ['.proof-or-stop/activity.jsonl', '.proof-or-stop/locks/', '.proof-or-stop/runtime/', '.probe-counter.log', ''].join('\n'));
  writeFileSync(join(root, 'probe.mjs'), "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.TRR_COUNTER, 'run\\n');\nconsole.log('terminal reasons probe PASS');\n");
  writeFileSync(join(root, 'README.md'), 'fixture v1\n');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
    workflow: { profile: 'light' },
    ...(noValidator ? {} : { validate: { commands: [{ label: 'terminal reasons probe', command: process.execPath, args: ['probe.mjs'], timeoutMs: 20_000 }], ...validateConfig } }),
  }, null, 2));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Terminal Reasons Fixture']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['checkout', '-q', '-b', 'main']);
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'base']);
  git(root, ['checkout', '-q', '-b', `story/${storyId}`]);
  const now = '2026-09-17T00:00:00.000Z';
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: `trr-${name}`, title: 'terminal refusal reasons fixture',
    description: 'Isolated fixture for validation terminal refusal reasons.', type: 'bug', phase: 'REVIEW',
    priority: 'medium', createdAt: now, startedAt: now, endedAt: null, riskSignals: [], currentReviewRound: now,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: now }],
  });
  store.writeChecklist(storyId, { items: [{
    id: 'CHK-001', title: 'terminal reasons', context: 'No required intents keep coverage complete.', status: 'done',
    verificationIntent: { happy: [{ desc: 'Exercise routine validation', type: 'logic', priority: 'should' }], edge: [], adversarial: [] },
    startTime: now, endTime: now,
  }] });
  const causalInputHashes = deriveCertificationDomainInputHashes(root, 'HEAD', root);
  persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes });
  git(root, ['add', '.proof-or-stop']); git(root, ['commit', '-qm', 'seed story metadata']);
  const run = (args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PROOF_OR_STOP_PROJECT_ROOT: root, PROOF_OR_STOP_SESSION_ID: `trr-${name}`, PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex', TRR_COUNTER: counter },
  });
  const executions = () => existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const terminals = () => readFileSync(join(root, `.proof-or-stop/story/actives/${storyId}/process-events.jsonl`), 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.type === 'validation_terminal');
  const refreshWindow = () => {
    persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes: deriveCertificationDomainInputHashes(root, 'HEAD', root) });
  };
  return { root, storyId, run, executions, terminals, refreshWindow, store };
}

const loggedReasons = (result) => {
  const match = /routine validation reuse refused: refusalReasons=(\S+)/.exec(`${result.stdout}\n${result.stderr}`);
  return match ? match[1].split(',').filter(Boolean).sort() : null;
};
const rows = [];
const record = (scenario, terminal, logged) => rows.push({
  scenario, disposition: terminal?.disposition, loggedReasons: logged?.join(',') ?? '-',
  terminalReasons: Array.isArray(terminal?.reuse?.refusalReasons) ? terminal.reuse.refusalReasons.join(',') || '(none)' : 'NOT RECORDED',
  declined: terminal?.reuse?.declinedReason ?? '-',
});

const sandboxes = [];
try {
  // Scenario A: configured validation with default (off) dynamic mode.
  const a = fixture('configured', {});
  sandboxes.push(a.root);
  const first = a.run(['validate', `--story=${a.storyId}`, '--json']);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(a.executions(), 1);
  let t = a.terminals().at(-1);
  record('A1 first run (no evidence)', t, loggedReasons(first));
  assert.equal(t.disposition, 'executed');
  expectRepaired(t.reuse?.evaluated === true && t.reuse?.reusable === false, 'A1 executed terminal must record that reuse was evaluated and refused');
  expectRepaired(JSON.stringify(t.reuse?.refusalReasons) === JSON.stringify(loggedReasons(first)),
    `A1 terminal refusal reasons must equal the logged reasons ${JSON.stringify(loggedReasons(first))}`);

  writeFileSync(join(a.root, 'README.md'), 'fixture v2 material change\n');
  git(a.root, ['add', 'README.md']); git(a.root, ['commit', '-qm', 'material change']);
  a.refreshWindow();
  const second = a.run(['validate', `--story=${a.storyId}`, '--json']);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(a.executions(), 2, 'a material change must re-execute');
  t = a.terminals().at(-1);
  record('A2 material change', t, loggedReasons(second));
  assert.equal(t.disposition, 'executed');
  const logged2 = loggedReasons(second);
  assert.ok(logged2 && logged2.includes('material-hash-changed-or-missing'), `material change must be logged as a refusal: ${second.stderr}`);
  expectRepaired(JSON.stringify(t.reuse?.refusalReasons) === JSON.stringify(logged2),
    `A2 terminal refusal reasons must equal the logged reasons ${JSON.stringify(logged2)}`);

  const third = a.run(['validate', `--story=${a.storyId}`, '--json']);
  assert.equal(third.status, 0, `${third.stdout}\n${third.stderr}`);
  assert.equal(a.executions(), 2, 'observational change: an unchanged re-run must still reuse');
  t = a.terminals().at(-1);
  record('A3 unchanged re-run', t, loggedReasons(third));
  assert.equal(t.disposition, 'reused');
  assert.equal(loggedReasons(third), null, 'a reused run logs no refusal');
  checks += 3;
  // Grouping keys used by the duplicate-suite and done_prepare readers keep their contract.
  for (const event of a.terminals()) {
    for (const key of ['commandSetHash', 'materialHash', 'storyFilesHash', 'disposition', 'commandExecutions', 'result']) {
      assert.ok(key in event, `terminal keeps ${key}`); checks++;
    }
  }
  const advance = a.run(['story_advance', JSON.stringify({ storyId: a.storyId, phase: 'TEST' })]);
  assert.equal(advance.status, 0, `${advance.stdout}\n${advance.stderr}`);
  assert.equal(a.executions(), 2, 'observational change: the TEST gate must still reuse the fresh PASS');
  checks++;

  // Scenario B: observe dynamic mode without the complete-PASS reuse opt-in.
  // The evaluator reports the PASS reusable, but the observe path declines it.
  const b = fixture('observe', { dynamic: { mode: 'observe' }, reuseFreshRoutinePass: false });
  sandboxes.push(b.root);
  const b1 = b.run(['validate', `--story=${b.storyId}`, '--json']);
  assert.equal(b1.status, 0, `${b1.stdout}\n${b1.stderr}`);
  b.refreshWindow();
  const b2 = b.run(['validate', `--story=${b.storyId}`, '--json']);
  assert.equal(b2.status, 0, `${b2.stdout}\n${b2.stderr}`);
  t = b.terminals().at(-1);
  record('B2 observe, reuse not opted in', t, loggedReasons(b2));
  assert.equal(t.disposition, 'executed', 'observe mode without the reuse opt-in must execute, not reuse');
  assert.equal(b.executions(), 2, 'the declined reuse must actually re-run the command');
  assert.equal(loggedReasons(b2), null, 'the evaluator itself did not refuse; the observe path declined');
  checks += 3;
  expectRepaired(t.reuse?.evaluated === true && t.reuse?.reusable === true && t.reuse?.declinedReason === 'observe-reuse-not-opted-in',
    `B2 executed terminal must record declinedReason observe-reuse-not-opted-in (got ${JSON.stringify(t.reuse)})`);

  // Scenario C: no project validator configured; the Story path still evaluates reuse.
  const c = fixture('no-validator', {}, { noValidator: true });
  sandboxes.push(c.root);
  const c1 = c.run(['validate', `--story=${c.storyId}`, '--json']);
  assert.equal(c1.status, 0, `${c1.stdout}\n${c1.stderr}`);
  t = c.terminals().at(-1);
  record('C1 no validator configured', t, loggedReasons(c1));
  assert.equal(t?.disposition, 'executed', 'no-validator first run persists an executed terminal');
  const loggedC = loggedReasons(c1);
  assert.ok(loggedC && loggedC.length > 0, `no-validator refusal must be logged: ${c1.stderr}`);
  checks += 2;
  expectRepaired(t.reuse?.evaluated === true && JSON.stringify(t.reuse?.refusalReasons) === JSON.stringify(loggedC),
    `C1 no-validator terminal refusal reasons must equal the logged reasons ${JSON.stringify(loggedC)}`);
} finally {
  for (const root of sandboxes) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log('scenario | disposition | stderr reasons | terminal reasons | declined');
for (const row of rows) console.log(`${row.scenario} | ${row.disposition} | ${row.loggedReasons} | ${row.terminalReasons} | ${row.declined}`);
const executed = rows.filter((row) => row.disposition === 'executed');
console.log(`executed terminals: ${executed.length}; attributable from the event alone: ${executed.filter((row) => row.terminalReasons !== 'NOT RECORDED').length}`);
if (red.length) {
  console.log(`${MARKER} (${red.length} failing expectations, ${checks} passing checks)`);
  for (const line of red) console.log(`  - ${line}`);
  process.exit(1);
}
console.log(`validation terminal refusal reasons recorded (${checks} checks)`);
