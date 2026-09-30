/**
 * evidence_plan listed every stale pinned intent as `action=rerun` but never
 * named the one command that reruns them all (at most once per execution
 * key). On the abs benchmark (run 11) the owner replayed receipts with 72
 * separate verification_evidence_add calls and never ran
 * verification_evidence_refresh_stale. The plan must hand the owner that one
 * next action whenever a rerun row has a pinned command.
 */
import assert from 'node:assert/strict';
import { renderEvidencePlanReport } from '../handlers/evidence-plan.js';

const entry = (intentRef: string, command?: string) => ({
  intentRef, itemId: 'CHK-001', priority: 'must', required: true, bucket: 'rerun', hasEvidence: true, result: 'pass',
  ...(command ? { command } : {}),
});
const report = (rerun: unknown[]) => ({
  storyId: 'B-x',
  mode: { runCommands: false, writeEvidence: false },
  readinessReport: { target: 'REVIEW', readiness: [] },
  fingerprints: { intents: [], executions: [], rootFingerprint: 'r' },
  buckets: { missing: [], rerun, refreshOnly: [], fresh: [] },
  summary: { missing: 0, rerun: rerun.length, refreshOnly: 0, fresh: 0 },
  claims: { authorityDone: false, productionDone: false },
}) as any;

const REFRESH = 'proof-or-stop verification_evidence_refresh_stale --storyId=B-x';
const stale = renderEvidencePlanReport(report([entry('CHK-001:happy:0', 'go test ./parser'), entry('CHK-001:edge:0', 'go test ./ast')]));
assert.ok(stale.includes(`next: ${REFRESH}`), `stale pinned intents must name the single batch refresh command; got:\n${stale}`);

const clean = renderEvidencePlanReport(report([]));
assert.ok(!clean.includes('verification_evidence_refresh_stale'), 'no stale rows: no refresh suggestion');

const manual = renderEvidencePlanReport(report([entry('CHK-001:manual:0')]));
assert.ok(!manual.includes('verification_evidence_refresh_stale'), 'a rerun row with no pinned command cannot be batch-refreshed');
console.log('plan-refresh-next-smoke: PASS');
