#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { evaluateActorTrustEvidence } from '../core/actor-trust.js';
import { buildVerificationCoverage, getBlockingVerificationEvidenceIssues, renderVerificationCoverage } from '../core/verification.js';
import type { ChecklistData, VerificationEvidence } from '../core/types.js';

function makeEvidence(overrides: Partial<VerificationEvidence>): VerificationEvidence {
  return {
    intentRef: 'CHK-001:happy:0',
    kind: 'integration_test',
    result: 'pass',
    note: 'test passed',
    ...overrides,
  };
}

// ── 1. Trusted independent actors accepted in strict ─────────────────────────

{
  const ev = makeEvidence({
    actorTrust: {
      producerActorId: 'agent-alice',
      verifierActorId: 'agent-bob',
      producerRunId: 'run-001',
      verifierRunId: 'run-002',
    },
  });
  const issues = evaluateActorTrustEvidence(ev, 'strict', {
    registry: { trustedActorIds: ['agent-alice', 'agent-bob'] },
  });
  assert.equal(issues.length, 0, 'trusted independent actors should produce no issues in strict');
}

// ── 2. Revoked actor evidence blocked in strict ───────────────────────────────

{
  const ev = makeEvidence({
    actorTrust: { producerActorId: 'agent-bad', verifierActorId: 'agent-other' },
  });
  const issues = evaluateActorTrustEvidence(ev, 'strict', {
    registry: { revokedActorIds: ['agent-bad'] },
  });
  const revoked = issues.find(i => i.code === 'actor_revoked');
  assert.ok(revoked, 'revoked actor should produce actor_revoked issue in strict');
  assert.equal(revoked?.severity, 'blocking', 'should be blocking in strict');
}

// ── 3. Revoked verifier blocked in strict ────────────────────────────────────

{
  const ev = makeEvidence({
    actorTrust: { producerActorId: 'agent-good', verifierActorId: 'agent-bad-verifier' },
  });
  const issues = evaluateActorTrustEvidence(ev, 'strict', {
    registry: { revokedActorIds: ['agent-bad-verifier'] },
  });
  const revoked = issues.find(i => i.code === 'verifier_actor_revoked');
  assert.ok(revoked, 'revoked verifier should produce verifier_actor_revoked issue in strict');
  assert.equal(revoked?.severity, 'blocking', 'should be blocking in strict');
}

// ── 4. Same producer/verifier actor blocked in strict ─────────────────────────

{
  const ev = makeEvidence({
    actorTrust: { producerActorId: 'agent-self', verifierActorId: 'agent-self' },
  });
  const issues = evaluateActorTrustEvidence(ev, 'strict');
  const selfVerify = issues.find(i => i.code === 'same_producer_verifier');
  assert.ok(selfVerify, 'same producer/verifier should produce same_producer_verifier issue in strict');
  assert.equal(selfVerify?.severity, 'blocking', 'should be blocking in strict');
}

// ── 5. Same run ID blocked in strict ─────────────────────────────────────────

{
  const ev = makeEvidence({
    actorTrust: {
      producerActorId: 'agent-a',
      verifierActorId: 'agent-b',
      producerRunId: 'run-same',
      verifierRunId: 'run-same',
    },
  });
  const issues = evaluateActorTrustEvidence(ev, 'strict');
  const sameRun = issues.find(i => i.code === 'same_run_id');
  assert.ok(sameRun, 'same producerRunId/verifierRunId should produce same_run_id issue in strict');
  assert.equal(sameRun?.severity, 'blocking', 'should be blocking in strict');
}

// ── 6. Missing actor metadata warns in balanced but compatible in light ───────

{
  const ev = makeEvidence({}); // no actorTrust
  const issuesBalanced = evaluateActorTrustEvidence(ev, 'balanced', { requireActorMetadata: true });
  assert.ok(issuesBalanced.length > 0, 'missing actor metadata should produce warning in balanced when required');
  assert.equal(issuesBalanced[0]!.severity, 'warning', 'should be warning in balanced');
  assert.equal(issuesBalanced[0]!.code, 'actor_metadata_missing');

  const issuesLight = evaluateActorTrustEvidence(ev, 'light', { requireActorMetadata: true });
  assert.equal(issuesLight.length, 0, 'light profile: no actor trust issues even when requireActorMetadata is true');
}

// ── 7. Revoked actor warns in balanced ────────────────────────────────────────

{
  const ev = makeEvidence({
    actorTrust: { producerActorId: 'revoked-agent' },
  });
  const issues = evaluateActorTrustEvidence(ev, 'balanced', {
    registry: { revokedActorIds: ['revoked-agent'] },
  });
  const revoked = issues.find(i => i.code === 'actor_revoked');
  assert.ok(revoked, 'revoked actor should produce issue in balanced');
  assert.equal(revoked?.severity, 'warning', 'should be warning in balanced');
}

// ── 8. Explicit trustStatus=revoked blocks in strict ─────────────────────────

{
  const ev = makeEvidence({
    actorTrust: { actorId: 'some-agent', trustStatus: 'revoked' },
  });
  const issues = evaluateActorTrustEvidence(ev, 'strict');
  const revoked = issues.find(i => i.code === 'actor_revoked');
  assert.ok(revoked, 'explicit trustStatus=revoked should produce actor_revoked issue in strict');
  assert.equal(revoked?.severity, 'blocking');
}

// ── 9. Suspicious always-pass pattern warns/blocks ───────────────────────────

{
  const ev = makeEvidence({
    actorTrust: { producerActorId: 'always-pass-agent' },
  });
  const actorStats = { 'always-pass-agent': { totalEvidence: 5, totalPasses: 5 } };
  const issuesStrict = evaluateActorTrustEvidence(ev, 'strict', { actorStats });
  const suspiciousStrict = issuesStrict.find(i => i.code === 'suspicious_always_pass');
  assert.ok(suspiciousStrict, 'suspicious always-pass should produce issue in strict');
  assert.equal(suspiciousStrict?.severity, 'blocking', 'should be blocking in strict');

  const issuesBalanced = evaluateActorTrustEvidence(ev, 'balanced', { actorStats });
  const suspiciousBalanced = issuesBalanced.find(i => i.code === 'suspicious_always_pass');
  assert.ok(suspiciousBalanced, 'suspicious always-pass should produce issue in balanced');
  assert.equal(suspiciousBalanced?.severity, 'warning', 'should be warning in balanced');
}

// ── 10. Low pass count does not trigger suspicious pattern ───────────────────

{
  const ev = makeEvidence({
    actorTrust: { producerActorId: 'small-agent' },
  });
  const actorStats = { 'small-agent': { totalEvidence: 2, totalPasses: 2 } };
  const issues = evaluateActorTrustEvidence(ev, 'strict', { actorStats });
  assert.equal(issues.filter(i => i.code === 'suspicious_always_pass').length, 0, 'only 2 evidence records should not trigger suspicious pattern');
}

// ── 11. Legacy evidence (no actorTrust) is compatible across profiles ─────────

{
  const ev = makeEvidence({}); // no actorTrust
  assert.equal(evaluateActorTrustEvidence(ev, 'light').length, 0, 'light: no issues for legacy evidence');
  assert.equal(evaluateActorTrustEvidence(ev, 'balanced').length, 0, 'balanced: no issues for legacy evidence without requireActorMetadata');
  assert.equal(evaluateActorTrustEvidence(ev, 'strict').length, 0, 'strict: no issues for legacy evidence without requireActorMetadata');
}

// ── 12. buildVerificationCoverage integration: actorTrustIssues emitted ────────

const clWithActorTrust: ChecklistData = {
  items: [{
    id: 'CHK-001',
    title: 'item with revoked actor',
    status: 'done',
    startTime: null,
    endTime: null,
    verificationIntent: {
      happy: [{ desc: 'feature works', type: 'cli', priority: 'must' }],
      edge: [],
      adversarial: [],
    },
    verificationEvidence: [{
      intentRef: 'CHK-001:happy:0',
      kind: 'integration_test',
      result: 'pass',
      note: 'passed',
      command: 'npm test',
      actorTrust: { producerActorId: 'bad-actor', verifierActorId: 'bad-actor' }, // same producer/verifier
    }],
  }],
};

// strict: same producer/verifier demotes to weak
{
  const r = buildVerificationCoverage(clWithActorTrust, undefined, undefined, { evidenceQualityProfile: 'strict' });
  assert.equal(r.entries[0].status, 'weak', 'strict: same producer/verifier should demote to weak');
  assert.ok(r.actorTrustIssues && r.actorTrustIssues.length > 0, 'strict: actorTrustIssues should be populated');
  assert.equal(r.missingRequired, 1, 'strict: weak counts as missing required');
}

// balanced: same producer/verifier warns but stays covered
{
  const r = buildVerificationCoverage(clWithActorTrust, undefined, undefined, { evidenceQualityProfile: 'balanced' });
  assert.equal(r.entries[0].status, 'covered', 'balanced: same producer/verifier keeps covered status');
  assert.ok(r.actorTrustIssues && r.actorTrustIssues.length > 0, 'balanced: actorTrustIssues should be populated');
  assert.equal(r.missingRequired, 0, 'balanced: still counts as covered');
}

// light: no actor trust issues
{
  const r = buildVerificationCoverage(clWithActorTrust, undefined, undefined, { evidenceQualityProfile: 'light' });
  assert.equal(r.entries[0].status, 'covered', 'light: no actor trust checking');
  assert.equal(r.actorTrustIssues, undefined, 'light: no actorTrustIssues');
}

// ── 13. getBlockingVerificationEvidenceIssues includes actor trust detail ─────

{
  const issues = getBlockingVerificationEvidenceIssues(clWithActorTrust, undefined, 'strict');
  const detail = issues.find(i => i.includes('same_producer_verifier'));
  assert.ok(detail, 'strict blocking issues should include actor trust detail entry');
  // Should not have duplicate generic [weak] entry
  const generic = issues.filter(i => i.startsWith('CHK-001:happy:0 [weak]') && !i.includes('same_producer_verifier'));
  assert.equal(generic.length, 0, 'should not have duplicate generic [weak] entry when actor trust detail is present');
}

// ── 14. renderVerificationCoverage includes Actor trust warnings section ────────

{
  const r = buildVerificationCoverage(clWithActorTrust, undefined, undefined, { evidenceQualityProfile: 'strict' });
  const rendered = renderVerificationCoverage(r);
  assert.ok(rendered.includes('Actor trust warnings:'), 'rendered output should include "Actor trust warnings:" section');
  assert.ok(rendered.includes('same_producer_verifier'), 'rendered output should include issue code');
  assert.ok(rendered.includes('[BLOCKING]'), 'strict actor trust issue should render as [BLOCKING]');
}

// ── 15. Same producerProvider/verifierProvider blocks in strict ───────────────

{
  const ev = makeEvidence({
    actorTrust: {
      producerActorId: 'agent-a',
      verifierActorId: 'agent-b',
      producerProvider: 'claude-agent',
      verifierProvider: 'claude-agent',
    },
  });
  const issues = evaluateActorTrustEvidence(ev, 'strict');
  const issue = issues.find(i => i.code === 'same_provider');
  assert.ok(issue, 'same producerProvider/verifierProvider should produce same_provider issue in strict');
  assert.equal(issue?.severity, 'blocking', 'should be blocking in strict');
}

// ── 16. Same provider warns in balanced ──────────────────────────────────────

{
  const ev = makeEvidence({
    actorTrust: {
      producerActorId: 'agent-a',
      verifierActorId: 'agent-b',
      producerProvider: 'claude-agent',
      verifierProvider: 'claude-agent',
      producerVendor: 'anthropic',
      verifierVendor: 'anthropic',
      producerModel: 'claude-opus-4',
      verifierModel: 'claude-opus-4',
    },
  });
  const issues = evaluateActorTrustEvidence(ev, 'balanced');
  const issue = issues.find(i => i.code === 'same_provider');
  assert.ok(issue, 'same provider should produce same_provider issue in balanced');
  assert.equal(issue?.severity, 'warning', 'should be warning in balanced');
  assert.ok(issue?.message.includes('anthropic'), 'message should include vendor');
  assert.ok(issue?.message.includes('claude-opus-4'), 'message should include model');
}

// ── 17. Different providers accepted ─────────────────────────────────────────

{
  const ev = makeEvidence({
    actorTrust: {
      producerActorId: 'agent-a',
      verifierActorId: 'agent-b',
      producerProvider: 'claude-agent',
      verifierProvider: 'github-actions',
    },
  });
  const issues = evaluateActorTrustEvidence(ev, 'strict');
  assert.equal(issues.filter(i => i.code === 'same_provider').length, 0, 'different providers should not produce same_provider issue');
}

console.log('✓ actor trust smoke passed');
