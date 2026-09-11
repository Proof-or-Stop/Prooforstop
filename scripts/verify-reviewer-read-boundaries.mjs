import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prepared = spawnSync(process.execPath, [join(repo, 'scripts/ensure-dist.mjs')], { cwd: repo, encoding: 'utf8', timeout: 180000 });
assert.equal(prepared.status, 0, `SETUP_BUILD_FAILED: ${prepared.stderr}\n${prepared.stdout}`);
const root = mkdtempSync(join(tmpdir(), 'reviewer-read-boundaries-'));
const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const sid = 'B-read-boundaries';
const roles = ['proof-or-stop-review-story-init', 'proof-or-stop-product-reviewer'];
const results = [];
const invocations = [];
const env = { ...process.env, CODEX_THREAD_ID: `read-boundary-owner-${process.pid}` };
for (const key of ['NODE_OPTIONS', 'PROOF_OR_STOP_REVIEWER_READONLY', 'PROOF_OR_STOP_IMPLEMENTATION_MANIFEST',
  'PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN', 'PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST',
  'PROOF_OR_STOP_SESSION_ID', 'PROOF_OR_STOP_OWNER_SESSION_ID', 'PROOF_OR_STOP_HOST_SESSION_TOKEN', 'PROOF_OR_STOP_AGENT']) delete env[key];
const invoke = (command, args, { reviewer = true, readOnly = false } = {}) => {
  const childEnv = { ...env, CODEX_THREAD_ID: reviewer ? `read-boundary-reviewer-${process.pid}` : env.CODEX_THREAD_ID };
  if (readOnly) childEnv.PROOF_OR_STOP_REVIEWER_READONLY = '1';
  const started = performance.now();
  const result = spawnSync(process.execPath, [join(repo, 'bin/proof-or-stop.js'), command, ...args], {
    cwd: root, env: childEnv, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.error, undefined, 'CLI must start');
  assert.equal(result.signal, null, 'timeout/signal is never target RED');
  const row = { command, args, reviewer, readOnly, exitCode: result.status,
    elapsedMs: performance.now() - started, stdout: result.stdout, stderr: result.stderr };
  invocations.push(row);
  return row;
};
const check = (id, run) => {
  const start = performance.now();
  try { run(); results.push({ id, pass: true, elapsedMs: performance.now() - start }); }
  catch (error) { results.push({ id, pass: false, elapsedMs: performance.now() - start, error: error.message }); }
};
const git = (...args) => {
  const p = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr); return p.stdout.trim();
};
const snapshot = path => {
  const entries = [];
  const walk = (dir, rel = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(rel, entry.name), abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, name);
      else entries.push([name, createHash('sha256').update(readFileSync(abs)).digest('hex')]);
    }
  };
  walk(path); return entries;
};
try {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  process.chdir(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/base.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, '.gitignore'), '.proof-or-stop/\n');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', outDir: 'dist',
    testsDir: 'tests', fixturesDir: 'tests/fixtures' }));
  git('init', '-b', 'work'); git('config', 'user.email', 'lab@example.test'); git('config', 'user.name', 'Lab regression');
  git('add', '.'); git('commit', '-m', 'seed isolated reviewer read regression'); git('branch', 'main');
  const { StoryStore } = await import(join(repo, 'packages/main/dist/core/store.js'));
  const { acquireOwnerLease, getSessionId } = await import(join(repo, 'packages/main/dist/core/story-owner-lease.js'));
  const { createReviewInventoryHandlers, assertOpenInventoryFresh } = await import(join(repo, 'packages/main/dist/handlers/review-inventory.js'));
  const { createAgentPromptHandlers } = await import(join(repo, 'packages/main/dist/handlers/agent-prompt.js'));
  const { enforceStoryOwnerLeaseGate } = await import(join(repo, 'packages/main/dist/cli/ownership-gate.js'));
  const { verifyReviewInventoryEpoch } = await import(join(repo, 'packages/main/dist/core/review-inventory-epoch.js'));
  const store = new StoryStore(root);
  const now = new Date().toISOString();
  // Isolated fixture state uses production Store and handlers; no real Story is changed.
  store.writeStory(sid, { storyId: sid, name: 'reviewer-read-boundaries', title: 'Inspect reviewer task context',
    description: 'Read the current task and keep observation separate from evidence publication.', type: 'chore', phase: 'REVIEW',
    priority: 'medium', createdAt: now, startedAt: now, endedAt: null, currentReviewRound: now });
  store.writeChecklist(sid, { items: [{ id: 'CHK-001', title: 'Read scoped context', context: 'Keep task content available to independent readers.',
    status: 'pending', startTime: null, endTime: null }] });
  const ctx = { store, root, scanRoot: root };
  const owner = acquireOwnerLease(store.storyDirPath(sid), { command: 'isolated-fixture-setup', cwd: root });
  assert.equal(owner.sessionId, getSessionId());
  const handlers = createReviewInventoryHandlers(ctx);
  handlers.review_inventory_begin({ storyId: sid });
  assert.equal(store.readReviewInventoryEpochs(sid).epochs.at(-1).state, 'OPEN', 'valid OPEN control required');
  const control = invoke('story_get', [`--storyId=${sid}`], { readOnly: true });
  assert.equal(control.exitCode, 0, `SETUP_READ_CONTROL_FAILED: ${control.stderr}`);

  check('R1_STORY_PROMPT_READ', () => {
    const before = snapshot(store.storyDirPath(sid));
    for (const role of roles) {
      const read = invoke('agent_prompt', [`--storyId=${sid}`, `--role=${role}`, '--readOnly', '--format=json'], { readOnly: true });
      assert.equal(read.exitCode, 0, `REVIEWER_READ_BOUNDARY_RED: contextual prompt denied: ${read.stderr}`);
      const body = JSON.parse(read.stdout);
      assert.equal(body.readOnly, true); assert.equal(body.canMintReviewEvidence, false); assert.equal(body.envelope, null);
      assert.match(body.prompt, new RegExp(sid)); assert.match(body.prompt, /Read scoped context/);
      assert.deepEqual(snapshot(store.storyDirPath(sid)), before, 'prompt reads must preserve all Story bytes and lease');
    }
    const write = invoke('agent_prompt', [`--storyId=${sid}`, `--role=${roles[0]}`]);
    assert.notEqual(write.exitCode, 0); assert.match(write.stderr, /owner-gated/);
    assert.throws(() => createAgentPromptHandlers(ctx).agent_prompt({ role: roles[0], storyId: sid, readOnly: true, auditExperiment: true, format: 'json' }), /readOnly.*auditExperiment|auditExperiment.*readOnly/);
  });

  check('R2_INVENTORY_STATUS_READ', () => {
    const before = snapshot(store.storyDirPath(sid));
    const status = invoke('review_inventory_status', [`--storyId=${sid}`], { readOnly: true });
    assert.equal(status.exitCode, 0, `REVIEWER_READ_BOUNDARY_RED: status denied: ${status.stderr}`);
    assert.match(status.stdout, /OPEN/);
    assert.deepEqual(snapshot(store.storyDirPath(sid)), before);
    writeFileSync(join(root, 'src/base.ts'), 'export const value = 2;\n');
    const drifted = invoke('review_inventory_status', [`--storyId=${sid}`], { readOnly: true });
    assert.equal(drifted.exitCode, 0, drifted.stderr); assert.match(drifted.stdout, /INVALIDATED/);
    assert.match(drifted.stdout, /OPEN_REVIEW_INVENTORY_MATERIAL_MUTATION/);
    assert.deepEqual(snapshot(store.storyDirPath(sid)), before, 'drift observation must not sign/persist an epoch');
    const refresh = invoke('review_inventory_status', [`--storyId=${sid}`, '--refresh']);
    assert.notEqual(refresh.exitCode, 0); assert.match(refresh.stderr, /owner-gated/);
    assert.deepEqual(snapshot(store.storyDirPath(sid)), before, 'foreign refresh must not mutate Story');
    // The existing consumer rechecks live drift even though readonly observation kept OPEN on disk.
    assert.throws(() => assertOpenInventoryFresh(ctx, sid), /OPEN_REVIEW_INVENTORY_MATERIAL_MUTATION/);
    assert.equal(store.readReviewInventoryEpochs(sid).epochs.at(-1).state, 'INVALIDATED');
    assert.ok(verifyReviewInventoryEpoch(store.readReviewInventoryEpochs(sid).epochs.at(-1)));
  });

  check('R3_DISPATCH_READER_RECOVERY', () => {
    const before = snapshot(store.storyDirPath(sid));
    const refusal = invoke('dispatch', [`--storyId=${sid}`, `--agentType=${roles[0]}`]);
    assert.notEqual(refusal.exitCode, 0); assert.match(refusal.stderr, /owner-gated/);
    const prefix = 'Read-only prompt: ';
    const line = refusal.stderr.split('\n').find(line => line.includes(prefix));
    assert.ok(line, 'REVIEWER_READ_BOUNDARY_RED: dispatch refusal lacks executable read-only recovery');
    const command = line.slice(line.indexOf(prefix) + prefix.length).trim();
    assert.equal(command, `proof-or-stop agent_prompt --role=${roles[0]} --storyId=${sid} --readOnly`);
    const retry = invoke('agent_prompt', command.split(' ').slice(2), { readOnly: true });
    assert.equal(retry.exitCode, 0, retry.stderr); assert.match(retry.stdout, new RegExp(sid));
    assert.deepEqual(snapshot(store.storyDirPath(sid)), before, 'recovery requires no owner relay or dispatch write');
  });

  check('R4_CHECK_READONLY_ADMISSION', () => {
    const before = snapshot(store.storyDirPath(sid));
    const control = invoke('check', ['--json'], { reviewer: false });
    assert.equal(control.exitCode, 0, control.stderr);
    const read = invoke('check', ['--json'], { readOnly: true });
    assert.equal(read.exitCode, 0, `REVIEWER_READ_BOUNDARY_RED: default check denied: ${read.stderr}`);
    assert.equal(JSON.parse(read.stdout).mode, 'check');
    assert.deepEqual(JSON.parse(read.stdout).applied, []);
    for (const flag of ['--apply', '--upgrade']) {
      const write = invoke('check', ['--json', flag], { readOnly: true });
      assert.notEqual(write.exitCode, 0); assert.match(write.stderr, /REVIEWER_READONLY=1/);
    }
    assert.deepEqual(snapshot(store.storyDirPath(sid)), before);
  });
  console.log(JSON.stringify({ rootIsTemporary: true, implementation: gitVersion(), results, invocations }, null, 2));
  if (results.some(row => !row.pass)) {
    console.error('REVIEWER_READ_BOUNDARY_RED: ' + results.filter(row => !row.pass).map(row => row.id).join(', '));
    process.exitCode = 1;
  } else console.log('REVIEWER_READ_BOUNDARY_GREEN: four historical failure classes repaired with write protection retained');
} finally {
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(root, { recursive: true, force: true });
}
function gitVersion() {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
}
