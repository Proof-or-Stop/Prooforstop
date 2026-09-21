import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { StoryStore } = await import('../dist/core/store.js');
const { createHostRunHandlers } = await import('../dist/handlers/host-run.js');
const {
  managedHostRunReceipt,
  readManagedHostRunBinding,
  verifyManagedDispatchDelivery,
} = await import('../dist/core/managed-host-run.js');

const root = mkdtempSync(join(tmpdir(), 'managed-finding-repair-dispatch-'));
const storyId = 'B-managed-finding-repair';
const findingId = `${storyId}:F-001`;
const oldHome = process.env.HOME;

try {
  process.env.HOME = root;
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: 'src', outDir: 'dist', testsDir: 'tests',
    fixturesDir: 'tests/fixtures', storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
  }));
  const store = new StoryStore(root);
  const now = new Date().toISOString();
  store.writeStory(storyId, {
    storyId, name: 'managed-finding-repair', title: 'Managed finding repair',
    description: 'Exercise the exact DEV finding-repair managed dispatch target.',
    type: 'bug', phase: 'DEV', priority: 'high', createdAt: now, events: [],
  });
  store.writeFindings(storyId, { findings: [{
    id: findingId,
    desc: 'The focused regression remains open until the controller verifies the repair.',
    severity: 'high', category: 'adversarial', status: 'open',
    evidenceState: 'verified', agent: 'proof-or-stop-review-quality',
    createdAt: now, reviewRound: now, _hash: 'fixture-finding-hash',
  }] });

  let deliveredPrompt = '';
  const handlers = createHostRunHandlers({ root, scanRoot: root, store }, {
    runner: async plan => {
      deliveredPrompt = plan.stdinText;
      return {
        stdout: '{"type":"turn.completed","usage":{}}\n', stderr: '', exitCode: 0,
        timedOut: false, terminalReason: 'completed', replacementSafe: true,
      };
    },
  });

  let result;
  try {
    result = await handlers.host_run({
      host: 'codex', storyId, findingId,
      agentType: 'proof-or-stop-finding-repair', managedDispatch: true,
      deadlineMs: 30_000, timeoutMs: 20_000, json: true,
    });
  } catch (error) {
    assert.fail(`MANAGED_FINDING_REPAIR_DISPATCH_REQUIRED: ${error instanceof Error ? error.message : String(error)}`);
  }

  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.ok(result.runId);
  assert.match(deliveredPrompt, new RegExp(`fix ${storyId} F-001`));
  assert.match(deliveredPrompt, /repair worker must not call finding_resolve/i);
  const binding = readManagedHostRunBinding(root, result.runId);
  assert.deepEqual(binding.managedDispatchTarget, { findingId });
  const receipt = managedHostRunReceipt(root, result.runId);
  assert.equal(receipt.state, 'completed');
  assert.ok(receipt.stdoutDigest, 'repair completion must seal provider output');
  assert.equal(receipt.managedDispatchOutputDigest, receipt.stdoutDigest,
    'repair output must be bound to the complete provider stdout digest');
  assert.deepEqual(verifyManagedDispatchDelivery({
    root, runId: result.runId, storyId,
    agentType: 'proof-or-stop-finding-repair', findingId,
  }), { valid: true });
  assert.equal(store.readFindings(storyId).findings[0].status, 'open',
    'the repair worker must not resolve its own finding');
  assert.equal(verifyManagedDispatchDelivery({
    root, runId: result.runId, storyId,
    agentType: 'proof-or-stop-finding-repair', findingId: `${storyId}:F-999`,
  }).valid, false, 'a completed repair run must not authorize another finding');

  await assert.rejects(() => handlers.host_run({
    host: 'codex', storyId,
    agentType: 'proof-or-stop-finding-repair', managedDispatch: true,
  }), /requires exactly one findingId/);
  await assert.rejects(() => handlers.host_run({
    host: 'codex', storyId, findingId: `${storyId}:F-999`,
    agentType: 'proof-or-stop-finding-repair', managedDispatch: true,
  }), /does not exist in Story/);
  await assert.rejects(() => handlers.host_run({
    host: 'codex', storyId, findingId,
    agentType: 'proof-or-stop-implementer', managedDispatch: true,
  }), /findingId is valid only/);

  const shortTargetRun = await handlers.host_run({
    host: 'codex', storyId, findingId: 'F-001',
    agentType: 'proof-or-stop-finding-repair', managedDispatch: true, json: true,
  });
  assert.equal(readManagedHostRunBinding(root, shortTargetRun.runId).managedDispatchTarget?.findingId, findingId,
    'short finding references must be canonicalized before they are sealed');

  const findings = store.readFindings(storyId);
  findings.findings[0].status = 'resolved';
  store.writeFindings(storyId, findings);
  await assert.rejects(() => handlers.host_run({
    host: 'codex', storyId, findingId,
    agentType: 'proof-or-stop-finding-repair', managedDispatch: true,
  }), /target .* is not open/);

  console.log('MANAGED_FINDING_REPAIR_DISPATCH_GREEN');
} finally {
  try {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
