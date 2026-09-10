import assert from 'node:assert/strict';

export const FAST_SET_ID = 'precert-adversarial.v1';
export const FAST_SET_BUDGET_MS = 180_000;
// IDs are semantic identities. Counts and timings are observations, never selectors.
export const FAST_CONTRACTS = [
  ['selector-integrity', 'unconditional-selector', 15_000],
  ['real-port-collision', 'fake-fixed-port-sentinel', 15_000],
  ['causal-launches-zero', 'launch-before-preflight', 30_000],
  ['terminal-process-cleanup', 'orphaned-process-and-owned-scratch', 60_000],
  ['source-dist-launches-zero', 'stale-source-or-dist', 30_000],
].map(([contractId, failureClassId, timeoutMs]) => Object.freeze({
  suiteId: FAST_SET_ID, contractId, assertionId: `${contractId}:adversarial-behavior`,
  failureClassId, revision: 1, timeoutMs,
  script: `precert:case:${contractId}`,
  command: `node scripts/precert-fast-case.mjs ${contractId}`,
  marker: `PRE_CERT_CONTRACT ${contractId} PASS`,
  resources: contractId === 'real-port-collision'
    ? [{class:'fixed-port',key:'43127',access:'exclusive'}] : [],
  tempOwnership: 'runner-owned-unique',
}));

export function assertFastScriptBindings(scripts) {
  for (const contract of FAST_CONTRACTS) assert.equal(scripts[contract.script], contract.command,
    `fast contract command changed: ${contract.contractId}`);
}

export function validateFastResult(contract, result) {
  assert.equal(result.name, contract.script, `wrong member for ${contract.contractId}`);
  assert.equal(result.status, 'PASS', `contract did not pass: ${contract.contractId} (${result.status})`);
  assert.equal(result.output.split(/\r?\n/).filter(line => line === contract.marker).length, 1,
    `contract requires one exact terminal marker: ${contract.contractId}`);
}
