#!/usr/bin/env node
// Run 16 (old TS PoS, runs/20261003T025104Z-oldpos-8119), item 2c root cause 1:
// the quality lane reproduced a base->head regression of hash range assignment
// (`h["a":"b"] = 5` silently dropped) and rated it `low` ("hash range syntax is
// undocumented"), because no reviewer prompt said what low/medium/high mean.
// low is advisory, so the Story reached DONE with the regression open.
//
// Every REVIEW lane body, the inventory critic body and the managed final
// proposal schema must carry the one shared severity rubric: a confirmed
// regression of existing behavior, or a wrong result on a documented or tested
// path, is at least medium; low is only for cosmetic / non-behavioral issues.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const registry = await import(join(dist, 'core', 'prompt-registry.js'));
const hostRun = await import(join(dist, 'core', 'host-run.js'));

const RUBRIC_MARKERS = [
  /confirmed regression of existing behavior/i,
  /at least medium/i,
  /low[^.]*only[^.]*cosmetic|cosmetic[^.]*non-behavioral/i,
];
const failures = [];
const check = (where, text) => {
  for (const marker of RUBRIC_MARKERS) if (!marker.test(text)) failures.push(`${where}: missing ${marker}`);
};

const snapshot = registry.readPromptRegistry();
const roles = [...registry.ACTIVE_MODULAR_REVIEWER_ROLE_IDS, 'proof-or-stop-review-topology-critic'];
for (const role of roles) {
  const entry = snapshot.agents.find(row => row.agentId === role);
  assert.ok(entry, `prompt registry has ${role}`);
  check(`${role} resolved body`, registry.resolvePromptTemplateBody(entry));
}

const schema = hostRun.managedReviewFinalProposalJsonSchema({ storyId: 'B-0001', lane: 'proof-or-stop-review-quality', reviewRunId: 'RR-001', agentType: 'proof-or-stop-review-quality' });
const severity = schema.properties.findings.items.properties.severity;
assert.deepEqual(severity.enum, ['critical', 'high', 'medium', 'low'], 'severity enum unchanged');
check('managed final proposal schema severity.description', String(severity.description ?? ''));

assert.deepEqual(failures, [], `severity rubric missing:\n${failures.join('\n')}`);

// One shared text: every carrier holds the exact constant (no drifting copies).
const { REVIEW_SEVERITY_RUBRIC } = await import(join(dist, 'core', 'finding-closure-severities.js'));
assert.equal(severity.description, REVIEW_SEVERITY_RUBRIC, 'schema carries the shared rubric verbatim');
assert.ok(registry.REVIEW_FINDING_TRIAGE_CONTRACT.includes(REVIEW_SEVERITY_RUBRIC), 'lane triage contract carries the shared rubric verbatim');
const critic = snapshot.agents.find(row => row.agentId === 'proof-or-stop-review-topology-critic');
assert.ok(registry.readPromptTemplate(critic).includes(REVIEW_SEVERITY_RUBRIC), 'critic template carries the shared rubric verbatim');
console.log(`severity-rubric: PASS (${roles.length} reviewer bodies + managed final schema)`);
