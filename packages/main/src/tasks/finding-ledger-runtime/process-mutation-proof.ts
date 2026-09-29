import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const reasons: Readonly<Record<string, string>> = {
  'story3-promote-query-l4': 'Story 3: finding_ledger_query must stay L0, never L4 persistence authority',
  'story3-promote-runtime-run-l4': 'Story 3: finding_runtime_evidence_run must stay L2, never L4 persistence authority',
  'story3-drop-runtime-freshness': 'Story 3: finding_runtime_evidence_verify semantics incomplete',
  'story3-forbidden-story2-import': 'Story 3: forbidden Story 2/Story 1 import accepted',
  'story3-forbidden-story1-import': 'Story 3: forbidden Story 2/Story 1 import accepted',
  'story3-unregistered-direct-consumer': 'Story 3: unregistered direct lifecycle consumer in packages/main/src/core/machine.ts',
  'story3-query-path-leak': 'Story 3: protected query surface contains a path-bearing field',
};

function run(root: string, mutation?: string) {
  const env = { ...process.env };
  delete env.PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION;
  if (mutation) env.PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION = mutation;
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'verify-process-fact-contract.mjs'), '--quiet', '--capability=story3'], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, 'process capability must execute, not time out or fail to launch');
  assert.equal(result.signal, null, 'a signaled verifier is not mutation rejection evidence');
  return result;
}

export function assertStory3VerifierPositiveControl(root: string): void {
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PROCESS_PARTIAL_PASS/);
  assert.doesNotMatch(result.stderr, /PROCESS_CAPABILITY_FAIL/);
  console.log('PROCESS_MUTATION_POSITIVE_CONTROL_PASS story3');
}

export function runStory3Mutation(root: string, mutation: string): boolean {
  const persistence = mutation.startsWith('story3-promote-record-') ? mutation.slice('story3-promote-record-'.length) : undefined;
  const expected = reasons[mutation] ?? (persistence ? `Story 3: ${persistence} persistence row must remain L2/query-only/non-authoritative` : undefined);
  assert.ok(expected, 'unregistered process mutation cannot manufacture rejection evidence: ' + mutation);
  const result = run(root, mutation);
  if (result.status === 0) {
    assert.match(result.stdout, /PROCESS_PARTIAL_PASS/);
    return true;
  }
  assert.equal(result.status, 1, result.stderr);
  const records = result.stderr.split('\n').filter(line => line.startsWith('PROCESS_CAPABILITY_FAIL '));
  assert.equal(records.length, 1, 'unrelated verifier failure is not mutation rejection evidence: ' + result.stderr.slice(-2000));
  const record = JSON.parse(records[0]!.slice('PROCESS_CAPABILITY_FAIL '.length)) as { capability: string; failures: string[] };
  assert.equal(record.capability, 'story3');
  assert.ok(Array.isArray(record.failures) && record.failures.includes(expected), 'mutation must hit its exact rejection reason: ' + JSON.stringify(record));
  console.log('PROCESS_MUTATION_REJECTED ' + JSON.stringify({ mutation, reason: expected }));
  return false;
}
