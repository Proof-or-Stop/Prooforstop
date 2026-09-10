#!/usr/bin/env node
/**
 * B-5a15 CHK-001..005: focused CausalEvidence contract smoke.
 *
 * This stays on the pure core boundary so it can prove keying, CAS reuse,
 * receipt-first import, dependency closure, preflight refusal, and metrics
 * without recursively invoking an aggregate validation command.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROOF_OR_STOP_CLI_VERSION } from '../core/proof-or-stop-brand.js';
import {
  CAUSAL_DEPENDENCY_DOMAINS,
  DEFAULT_CAUSAL_SELECTOR_POLICY,
  createCausalExecutionKey,
  createCausalEvidenceBatch,
  deriveCausalMetrics,
  evaluateCausalDependencies,
  executeCausalEvidence,
  importCausalEvidenceReceipt,
  preflightCausalEvidence,
  renderCausalMetrics,
  resolveCausalToolVersion,
  verifyCausalEvidenceReceipt,
} from '../core/causal-evidence.js';
import type { CausalEvidenceReceipt } from '../core/causal-evidence.js';

class MemoryReceiptStore {
  private readonly receipts = new Map<string, CausalEvidenceReceipt>();

  readCausalEvidenceReceipt(storyId: string, executionKey: string): CausalEvidenceReceipt | null {
    return this.receipts.get(`${storyId}:${executionKey}`) ?? null;
  }

  writeCausalEvidenceReceipt(storyId: string, receipt: CausalEvidenceReceipt): void {
    const key = `${storyId}:${receipt.executionKey}`;
    const prior = this.receipts.get(key);
    if (prior && prior.receiptHash !== receipt.receiptHash) throw new Error('receipt overwrite');
    this.receipts.set(key, cloneReceipt(receipt));
  }
}

function cloneReceipt<T>(receipt: T): T {
  return structuredClone(receipt);
}

// Tool identity comes from the executing CLI, independently of both project roots.
const versionProbeRoot = mkdtempSync(join(tmpdir(), 'causal-tool-version-'));
const originalCwd = process.cwd();
let externalToolVersion: string | undefined;
try {
  const target = join(versionProbeRoot, 'target');
  const otherCwd = join(versionProbeRoot, 'cwd');
  for (const root of [target, otherCwd]) mkdirSync(join(root, 'packages', 'main'), { recursive: true });
  process.chdir(otherCwd);
  const manifest = (root: string) => join(root, 'packages', 'main', 'package.json');
  const cases = [
    { name: 'missing both manifests', target: undefined, cwd: undefined },
    { name: 'unrelated cwd fallback', target: undefined, cwd: '{"name":"business-cwd","version":"88.77.66"}' },
    { name: 'unrelated target', target: '{"name":"business-target","version":"99.88.77"}', cwd: undefined },
    { name: 'conflicting business versions', target: '{"name":"business-target","version":"99.88.77"}', cwd: '{"name":"business-cwd","version":"88.77.66"}' },
    { name: 'malformed manifests', target: '{', cwd: '{' },
    { name: 'malformed target with business cwd', target: '{', cwd: '{"name":"business-cwd","version":"88.77.66"}' },
    { name: 'copied tool manifest is not executing tool', target: '{"name":"@proof-or-stop/core","version":"0.0.1"}', cwd: undefined },
  ];
  for (const scenario of cases) {
    for (const [root, content] of [[target, scenario.target], [otherCwd, scenario.cwd]] as const) {
      if (content === undefined) rmSync(manifest(root), { force: true });
      else writeFileSync(manifest(root), content);
    }
    externalToolVersion = resolveCausalToolVersion(target);
    assert.equal(externalToolVersion, PROOF_OR_STOP_CLI_VERSION, scenario.name);
    assert.equal(resolveCausalToolVersion(otherCwd), PROOF_OR_STOP_CLI_VERSION, `${scenario.name}: target equals cwd`);
  }
} finally {
  process.chdir(originalCwd);
  rmSync(versionProbeRoot, { recursive: true, force: true });
}

const identity = {
  storyId: 'B-5a15-smoke',
  cwd: process.cwd(),
  command: { executable: process.execPath, args: ['-e', "console.log('SMOKE_MARKER')"] },
  bootstrap: { executable: 'proof-or-stop', args: ['verification-evidence'] },
  inputs: { materialHash: 'material-smoke', explicitInput: 'smoke' },
  storyFilesHash: 'story-smoke',
  effectiveEnvironment: { NODE_ENV: 'test', SECRET_TOKEN: 'secret-never-persisted' },
  runtimeVersion: process.version,
  toolVersion: externalToolVersion,
  selectorPolicy: DEFAULT_CAUSAL_SELECTOR_POLICY,
};

const readyPreflight = preflightCausalEvidence({
  cli: { available: true, path: 'proof-or-stop' },
  worktree: { expected: process.cwd(), actual: process.cwd() },
  gitIndex: { readable: true, path: `${process.cwd()}/.git/index`, expected: 'head', actual: 'head', contentDigest: 'sha256:smoke-index' },
  gitMaterial: { available: true, headHash: 'head', materialHash: 'material-smoke', storyFilesHash: 'story-smoke' },
  writerLease: { available: true, valid: true },
  providerCapability: { required: ['allowlisted-command', 'bounded-output'], available: ['allowlisted-command', 'bounded-output'] },
  resources: { required: { timeoutMs: 1000 }, available: { timeoutMs: 1000 } },
  evidenceTarget: { writable: true, path: 'B-5a15-smoke/causal-evidence/' },
  sideChannel: { available: true, maxOutputChars: 12_000, maxProgressEvents: 10 },
}, undefined, identity);
assert.equal(readyPreflight.ready, true, 'preflight readiness is admissible');
assert.equal(preflightCausalEvidence({
  cli: { available: false },
}, undefined, identity).commandExecutions, 0, 'refusal records zero command executions');

const completeKey = createCausalExecutionKey(identity);
assert.equal(completeKey.reusable, true, 'complete identity is reusable');
assert.notEqual(
  completeKey.key,
  createCausalExecutionKey({ ...identity, inputs: { materialHash: 'material-other', explicitInput: 'smoke' } }).key,
  'explicit input changes the execution key',
);
const incompleteKey = createCausalExecutionKey({ storyId: identity.storyId, cwd: identity.cwd, command: identity.command });
assert.equal(incompleteKey.reusable, false, 'incomplete identity cannot be reused');

const store = new MemoryReceiptStore();
const batch = createCausalEvidenceBatch();
let executions = 0;
const first = await executeCausalEvidence({
  identity,
  selector: 'SMOKE_MARKER',
  intentRef: 'CHK-001:happy:0',
  receiptStore: store,
  batch,
  preflight: readyPreflight,
  revalidateBeforeRun: () => true,
  run: async () => { executions++; return { code: 0, output: 'SECRET_TOKEN=secret-never-persisted SMOKE_MARKER' }; },
});
const second = await executeCausalEvidence({
  identity,
  selector: 'absent-selector',
  intentRef: 'CHK-001:edge:0',
  receiptStore: store,
  batch,
  preflight: readyPreflight,
  revalidateBeforeRun: () => true,
  run: async () => { executions++; return { code: 0, output: 'must-not-run' }; },
});
assert.equal(executions, 1, 'same key executes once');
assert.equal(first.verdict.result, 'pass');
assert.equal(second.verdict.result, 'fail', 'selectors fan out independently');
assert.equal(first.receipt.commandReruns, 0);
assert.equal(first.receipt.identity.toolVersion, PROOF_OR_STOP_CLI_VERSION, 'signed receipt records the executing CLI version');
assert.equal(first.receipt.identity.complete, true, 'external project tool version leaves a complete execution identity');
assert.equal(first.receipt.outputTail.includes('secret-never-persisted'), false, 'receipt output is redacted');
assert.equal(verifyCausalEvidenceReceipt(first.receipt, completeKey.key), true);

let commitAttempts = 0;
const importResult = importCausalEvidenceReceipt({
  receipt: first.receipt,
  expectedStoryId: identity.storyId,
  expectedExecutionKey: first.key.key,
  expectedMaterialHash: 'material-smoke',
  expectedStoryFilesHash: 'story-smoke',
  revalidate: () => true,
  commit: () => { commitAttempts++; if (commitAttempts === 1) throw new Error('simulated commit/index retry'); },
});
assert.equal(importResult.commandReruns, 0);
assert.equal(importResult.attempts, 2, 'import retries transaction only');

const nodes = CAUSAL_DEPENDENCY_DOMAINS.map((domain, index) => ({
  id: `${domain}-node`, domain, inputIds: [`${domain}-input`],
  dependencyIds: index === 0 ? [] : [`${CAUSAL_DEPENDENCY_DOMAINS[index - 1]}-node`],
  recordedInputHashes: { [`${domain}-input`]: 'old' },
}));
const dependency = evaluateCausalDependencies({
  nodes,
  currentInputHashes: Object.fromEntries(CAUSAL_DEPENDENCY_DOMAINS.map(domain => [`${domain}-input`, domain === 'source' ? 'new' : 'old'])),
  previousMaterialHash: 'm1', currentMaterialHash: 'm1', previousStoryFilesHash: 's1', currentStoryFilesHash: 's1',
  rerunNodeIds: nodes.map(node => node.id),
});
assert.equal(dependency.affectedNodeRerun, 0, 'unsigned rerun claims cannot manufacture a complete rerun');
assert.equal(dependency.falseFresh, 6, 'unsigned rerun claims leave the six-node affected closure false fresh');
assert.equal(dependency.gateAdmissible, false, 'unsigned rerun claims are not gate-admissible');

const metrics = deriveCausalMetrics(batch.ledger);
assert.equal(metrics.intentCount, 2);
assert.equal(metrics.uniqueExecutionKeys, 1);
assert.equal(metrics.commandExecutions, 1);
assert.match(renderCausalMetrics(metrics), /falseFresh=0/);

console.log(`causal-evidence-smoke: PASS — ${renderCausalMetrics(metrics)}`);
