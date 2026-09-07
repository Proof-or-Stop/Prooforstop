import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const distRoot = join(repoRoot, 'packages', 'main', 'dist');
const { createValidationCausalPreflightGate } = await import(pathToFileURL(join(distRoot, 'handlers/verifier.js')).href);
const { executeValidationPlan } = await import(pathToFileURL(join(distRoot, 'core/validation-executor.js')).href);
const { StoryStore } = await import(pathToFileURL(join(distRoot, 'core/store.js')).href);
const { CAUSAL_AUTHORITY_KEY_FILE } = await import(pathToFileURL(join(distRoot, 'core/causal-evidence.js')).href);
const {
  STALE_LEASE_THRESHOLD_MS,
  acquireOwnerLease,
  getSessionId,
  isLeaseStale,
  ownerLeasePath,
  readOwnerLease,
  refreshOwnerLease,
} = await import(pathToFileURL(join(distRoot, 'core/story-owner-lease.js')).href);

function validFacts(repoPath) {
  return {
    cli: { available: true, path: join(repoPath, 'proof-or-stop.js') },
    worktree: { expected: repoPath, actual: repoPath },
    gitIndex: { readable: true, path: join(repoPath, 'index'), contentDigest: 'sha256:test-index' },
    gitMaterial: { available: true, headHash: 'head-a', materialHash: 'material-a', storyFilesHash: 'story-a' },
    writerLease: { available: true, valid: true },
    providerCapability: { required: ['validation-plan', 'bounded-output'], available: ['validation-plan', 'bounded-output'] },
    resources: { required: { timeoutMs: 1000 }, available: { timeoutMs: 1000 } },
    evidenceTarget: { writable: true, path: join(repoPath, 'causal-evidence') },
    sideChannel: { available: true, maxOutputChars: 12000, maxProgressEvents: 1 },
  };
}

test('B-fe8f: launch refusal diagnostics distinguish lease, signed preflight, and changed fact fields without leaking values', async t => {
  const scenarios = [
    { name: 'missing lease precedes invalid signature and changed facts', lease: 'missing', rotateKey: true,
      changes: { 'gitIndex.contentDigest': 'sha256:private-index-after' }, reason: 'lease_missing_or_invalid', probes: 0 },
    { name: 'foreign lease precedes invalid signature and changed facts', lease: 'foreign', rotateKey: true,
      changes: { 'gitIndex.contentDigest': 'sha256:private-index-after' }, reason: 'lease_foreign_session', probes: 0 },
    { name: 'replaced signing key precedes changed facts', rotateKey: true,
      changes: { 'gitIndex.contentDigest': 'sha256:private-index-after' }, reason: 'preflight_verification_failed', probes: 0 },
    ...['gitIndex.contentDigest', 'gitMaterial.headHash', 'gitMaterial.materialHash', 'gitMaterial.storyFilesHash'].map(field => ({
      name: `${field} drift names only its changed field`,
      changes: { [field]: `private-new-value-for-${field}` }, reason: 'facts_changed', probes: 1,
    })),
    { name: 'multiple changed facts use a sorted field-name list',
      changes: { 'gitMaterial.storyFilesHash': 'private-story-after', 'gitIndex.contentDigest': 'private-index-after' },
      reason: 'facts_changed', probes: 1 },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const root = mkdtempSync(join(tmpdir(), 'verifier-refusal-diagnostic-'));
      try {
        const storyId = 'B-verifier-refusal-diagnostic';
        const store = new StoryStore(root);
        const storyDir = store.storyDirPath(storyId);
        const marker = join(root, 'launched');
        const command = { label: 'refusal-diagnostic-marker', command: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`] };
        acquireOwnerLease(storyDir, { command: 'validate', cwd: root });
        let currentFacts = validFacts(root);
        let probeCalls = 0;
        const ctx = { root, store, causalPreflightFacts: () => { probeCalls++; return structuredClone(currentFacts); } };
        const gate = createValidationCausalPreflightGate(ctx, storyId, [command], root);
        const beforeLaunchProbeCalls = probeCalls;
        const keyPath = join(root, '.proof-or-stop', 'runtime', CAUSAL_AUTHORITY_KEY_FILE);
        const originalKey = readFileSync(keyPath, 'utf8').trim();
        const replacementKey = Buffer.alloc(32, 7).toString('base64');
        const foreignSession = 'private-foreign-session-for-diagnostic-test';
        for (const [field, value] of Object.entries(scenario.changes)) {
          const [group, name] = field.split('.');
          currentFacts = { ...currentFacts, [group]: { ...currentFacts[group], [name]: value } };
        }
        if (scenario.rotateKey) writeFileSync(keyPath, replacementKey, 'utf8');
        if (scenario.lease === 'missing') rmSync(ownerLeasePath(storyDir));
        if (scenario.lease === 'foreign') {
          writeFileSync(ownerLeasePath(storyDir), JSON.stringify({ ...readOwnerLease(storyDir), sessionId: foreignSession }), 'utf8');
        }
        let refusal = null;
        try {
          await executeValidationPlan({ provider: 'test', commands: [command] }, root, undefined, storyId,
            { jobs: 1, beforeLaunch: gate.beforeLaunch });
        } catch (error) { refusal = error; }
        assert.equal(existsSync(marker), false, 'every refused branch must prevent the actual child marker from being written');
        assert.ok(refusal instanceof Error, 'the actual verifier plan must reject, not silently omit its command');
        assert.equal(probeCalls - beforeLaunchProbeCalls, scenario.probes,
          'lease then signed-preflight then facts short-circuit ordering must not change');
        const message = refusal.message;
        for (const value of [originalKey, replacementKey, foreignSession, root,
          'sha256:test-index', 'head-a', 'material-a', 'story-a', ...Object.values(scenario.changes)]) {
          assert.equal(message.includes(value), false, 'refusal diagnostics must not expose keys, identities, paths, or fact values');
        }
        assert.match(message, new RegExp(`^validate preflight refused: state_changed_before_launch reason=${scenario.reason}(?: |$)`));
        assert.match(message, /commandExecutions=0 evidenceWrites=0 \[causal_preflight_refused\]/);
        if (scenario.reason === 'facts_changed') {
          const fields = /(?:^| )changedFields=([^ ]+)/.exec(message)?.[1];
          assert.equal(fields, Object.keys(scenario.changes).sort().join(','), 'only sorted changed field names belong in the diagnostic');
        } else {
          assert.doesNotMatch(message, /changedFields=/, 'earlier short-circuit branches must not probe or claim facts drift');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('B-5a15 F-012: verifier plan launches are refused when the causal preflight snapshot changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'verifier-causal-preflight-'));
  try {
    const marker = join(root, 'launched');
    const storyId = 'B-verifier-preflight';
    const store = new StoryStore(root);
    acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: root });
    const command = {
      label: 'preflight-marker',
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`],
    };
    const plan = { provider: 'test', commands: [command] };
    let currentFacts = validFacts(root);
    const ctx = {
      root,
      store,
      causalPreflightFacts: () => structuredClone(currentFacts),
    };
    const gate = createValidationCausalPreflightGate(ctx, storyId, [command], root);
    currentFacts = { ...currentFacts, gitIndex: { ...currentFacts.gitIndex, contentDigest: 'sha256:index-after' } };
    await assert.rejects(
      executeValidationPlan(plan, root, undefined, storyId, { jobs: 1, beforeLaunch: gate.beforeLaunch }),
      /state_changed_before_launch.*causal_preflight_refused/,
    );
    assert.equal(existsSync(marker), false, 'the changed preflight must block before the child process is launched');

    currentFacts = validFacts(root);
    const freshGate = createValidationCausalPreflightGate(ctx, storyId, [command], root);
    const result = await executeValidationPlan(plan, root, undefined, storyId, { jobs: 1, beforeLaunch: freshGate.beforeLaunch });
    assert.equal(result.allPass, true);
    assert.equal(existsSync(marker), true, 'an unchanged preflight permits the real verifier child launch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B-5a15 F-012: verifier plan refreshes the same-owner lease before a later launch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'verifier-causal-lease-heartbeat-'));
  const storyId = 'B-verifier-lease-heartbeat';
  const store = new StoryStore(root);
  const storyDir = store.storyDirPath(storyId);
  const marker = join(root, 'launched');
  const command = {
    label: 'lease-heartbeat-marker',
    command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`],
  };
  try {
    acquireOwnerLease(storyDir, { command: 'validate', cwd: root });
    const ctx = {
      root,
      store,
      causalPreflightFacts: () => ({
        ...validFacts(root),
        writerLease: (() => {
          const lease = readOwnerLease(storyDir);
          const valid = Boolean(lease && lease.sessionId === getSessionId() && !isLeaseStale(lease));
          return { available: Boolean(lease), valid, ...(valid ? {} : { reason: 'lease_stale' }) };
        })(),
      }),
    };
    const gate = createValidationCausalPreflightGate(ctx, storyId, [command], root);
    const staleHeartbeat = new Date(Date.now() - STALE_LEASE_THRESHOLD_MS - 1).toISOString();
    refreshOwnerLease(storyDir, { command: 'validate', cwd: root, now: () => staleHeartbeat });
    assert.equal(isLeaseStale(readOwnerLease(storyDir)), true, 'the test starts after the lease crosses the stale threshold');

    const result = await executeValidationPlan(
      { provider: 'test', commands: [command] },
      root,
      undefined,
      storyId,
      { jobs: 1, beforeLaunch: gate.beforeLaunch },
    );
    assert.equal(result.allPass, true);
    assert.equal(existsSync(marker), true, 'a same-owner heartbeat refresh permits the later child launch');
    assert.equal(isLeaseStale(readOwnerLease(storyDir)), false, 'the validation launch refreshed the owner lease');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
