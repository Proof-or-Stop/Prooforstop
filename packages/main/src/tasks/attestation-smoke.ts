#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { evaluateAttestationEvidence } from '../core/attestation.js';
import { buildVerificationCoverage, getBlockingVerificationEvidenceIssues, renderVerificationCoverage } from '../core/verification.js';
import type { ChecklistData, VerificationEvidence } from '../core/types.js';

function makeEvidence(overrides: Partial<VerificationEvidence>): VerificationEvidence {
  return {
    intentRef: 'CHK-001:happy:0',
    kind: 'manual_transcript',
    result: 'pass',
    note: 'ok',
    ...overrides,
  };
}

// ── 1. Empty human looks-good is strict-blocking ─────────────────────────────

{
  const ev = makeEvidence({ attestation: { kind: 'human', actor: 'alice' } });
  const issues = evaluateAttestationEvidence(ev, 'strict');
  assert.ok(issues.length > 0, 'empty human attestation should produce issues in strict');
  assert.equal(issues[0].severity, 'blocking', 'should be blocking in strict');
  assert.equal(issues[0].code, 'human_attestation_empty');
}

// ── 2. Empty human is warning in balanced, not blocking ──────────────────────

{
  const ev = makeEvidence({ attestation: { kind: 'human', actor: 'alice' } });
  const issues = evaluateAttestationEvidence(ev, 'balanced');
  assert.ok(issues.length > 0, 'empty human attestation should produce issues in balanced');
  assert.equal(issues[0].severity, 'warning', 'should be warning in balanced');
}

// ── 3. Empty human is no issue in light ──────────────────────────────────────

{
  const ev = makeEvidence({ attestation: { kind: 'human', actor: 'alice' } });
  const issues = evaluateAttestationEvidence(ev, 'light');
  assert.equal(issues.length, 0, 'light profile: no attestation issues');
}

// ── 4. Human with checkedClaims is accepted ───────────────────────────────────

{
  const ev = makeEvidence({ attestation: { kind: 'human', actor: 'alice', checkedClaims: ['login flow works'] } });
  const issues = evaluateAttestationEvidence(ev, 'strict');
  assert.equal(issues.length, 0, 'human attestation with checkedClaims should be accepted in strict');
}

// ── 4b. Human with only empty-string claims is strict-blocking (no-claims) ────

{
  const ev = makeEvidence({ attestation: { kind: 'human', actor: 'alice', checkedClaims: [''] } });
  const issues = evaluateAttestationEvidence(ev, 'strict');
  assert.ok(issues.length > 0, 'empty-string checkedClaims should produce issues in strict');
  assert.equal(issues[0].severity, 'blocking', 'empty-string checkedClaims should be blocking in strict');
  assert.equal(issues[0].code, 'human_attestation_empty', 'empty-string checkedClaims should be human_attestation_empty');
}

// ── 5. Human with artifact binding is accepted ────────────────────────────────

{
  const ev = makeEvidence({ attestation: { kind: 'human', actor: 'alice', command: 'npm test' } });
  const issues = evaluateAttestationEvidence(ev, 'strict');
  assert.equal(issues.length, 0, 'human attestation with command binding should be accepted in strict');
}

// ── 6. Stale CI attestation is diagnosed ─────────────────────────────────────

{
  const ev = makeEvidence({
    headHash: 'abc1234',
    attestation: { kind: 'ci', checkedClaims: ['build passes'], command: 'npm run build', artifactRef: 'ci/123' },
  });
  const issues = evaluateAttestationEvidence(ev, 'strict', { currentHead: 'def5678' });
  assert.ok(issues.some(i => i.code === 'attestation_stale'), 'stale CI attestation should be diagnosed');
  assert.equal(issues.find(i => i.code === 'attestation_stale')?.severity, 'blocking', 'stale should be blocking in strict');
}

// ── 7. Current-head CI attestation is accepted ────────────────────────────────

{
  const ev = makeEvidence({
    headHash: 'abc1234',
    attestation: { kind: 'ci', checkedClaims: ['build passes'], command: 'npm test', artifactRef: 'ci/123' },
  });
  const issues = evaluateAttestationEvidence(ev, 'strict', { currentHead: 'abc1234' });
  assert.equal(issues.length, 0, 'current-head CI attestation should be accepted');
}

// ── 8. CI attestation with no claims is diagnosed ────────────────────────────

{
  const ev = makeEvidence({
    headHash: 'abc1234',
    attestation: { kind: 'ci', command: 'npm test', artifactRef: 'ci/123' },
  });
  const issues = evaluateAttestationEvidence(ev, 'strict', { currentHead: 'abc1234' });
  assert.ok(issues.some(i => i.code === 'ci_attestation_no_claims'), 'CI with no claims should be diagnosed');
}

// ── 9. CI attestation with no binding is diagnosed ───────────────────────────

{
  const ev = makeEvidence({
    headHash: 'abc1234',
    attestation: { kind: 'ci', checkedClaims: ['login works'] },
  });
  const issues = evaluateAttestationEvidence(ev, 'strict', { currentHead: 'abc1234' });
  assert.ok(issues.some(i => i.code === 'ci_attestation_no_binding'), 'CI with no binding should be diagnosed');
}

// ── 10. Legacy evidence without attestation is compatible ─────────────────────

{
  const ev = makeEvidence({ command: 'npm test', note: 'all tests pass' });
  // no attestation field
  const issues = evaluateAttestationEvidence(ev, 'strict');
  assert.equal(issues.length, 0, 'legacy evidence without attestation should be compatible');
}

// ── 11. materialHash freshness keeps attestation fresh ───────────────────────

{
  const ev = makeEvidence({
    headHash: 'old1234',
    materialHash: 'mat-abc',
    attestation: { kind: 'ci', checkedClaims: ['build passes'], command: 'npm test' },
  });
  const isMaterialFresh = (_h: string, e: VerificationEvidence) => e.materialHash === 'mat-abc';
  const issues = evaluateAttestationEvidence(ev, 'strict', { currentHead: 'new5678', isMaterialFresh });
  assert.equal(issues.filter(i => i.code === 'attestation_stale').length, 0, 'material-fresh attestation should not be stale');
}

// ── 12. buildVerificationCoverage integration ─────────────────────────────────

// Use a quality-strong evidence (has command 'npm test') but empty attestation metadata
// so quality check passes but attestation check fires
const clWithAttestation: ChecklistData = {
  items: [{
    id: 'CHK-001',
    title: 'item with attestation',
    status: 'done',
    startTime: null,
    endTime: null,
    verificationIntent: {
      happy: [{ desc: 'login works', type: 'manual', priority: 'must' }],
      edge: [],
      adversarial: [],
    },
    verificationEvidence: [{
      intentRef: 'CHK-001:happy:0',
      kind: 'manual_transcript',
      result: 'pass',
      note: 'checked manually',
      command: 'npm test',  // quality-strong signal; attestation.command is separate
      // empty human attestation metadata (no checkedClaims, no attestation.command/artifact)
      attestation: { kind: 'human', actor: 'alice' },  // no checkedClaims, no command/artifactRef
    }],
  }],
};

// strict: attestation issue demotes to weak
{
  const r = buildVerificationCoverage(clWithAttestation, undefined, undefined, { evidenceQualityProfile: 'strict' });
  assert.equal(r.entries[0].status, 'weak', 'strict: empty human attestation should demote to weak');
  assert.ok(r.attestationIssues && r.attestationIssues.length > 0, 'strict: attestationIssues should be populated');
  assert.equal(r.missingRequired, 1, 'strict: weak counts as missing required');
}

// balanced: attestation issue present but status stays covered
{
  const r = buildVerificationCoverage(clWithAttestation, undefined, undefined, { evidenceQualityProfile: 'balanced' });
  assert.equal(r.entries[0].status, 'covered', 'balanced: empty human attestation keeps covered status');
  assert.ok(r.attestationIssues && r.attestationIssues.length > 0, 'balanced: attestationIssues should be populated');
  assert.equal(r.missingRequired, 0, 'balanced: still counts as covered');
}

// light: no attestation issues
{
  const r = buildVerificationCoverage(clWithAttestation, undefined, undefined, { evidenceQualityProfile: 'light' });
  assert.equal(r.entries[0].status, 'covered', 'light: no attestation checking');
  assert.equal(r.attestationIssues, undefined, 'light: no attestationIssues');
}

// legacy (no attestation field) — compatible
const clLegacy: ChecklistData = {
  items: [{
    id: 'CHK-001',
    title: 'legacy item',
    status: 'done',
    startTime: null,
    endTime: null,
    verificationIntent: {
      happy: [{ desc: 'runs', type: 'cli', priority: 'must' }],
      edge: [],
      adversarial: [],
    },
    verificationEvidence: [{
      intentRef: 'CHK-001:happy:0',
      kind: 'manual_transcript',
      result: 'pass',
      note: 'it works',
      command: 'npm test',
    }],
  }],
};

{
  const r = buildVerificationCoverage(clLegacy, undefined, undefined, { evidenceQualityProfile: 'strict' });
  assert.equal(r.attestationIssues, undefined, 'legacy evidence: no attestationIssues');
  // command='npm test' has STRONG_CMD_RE match so quality is strong, status covered
  assert.equal(r.entries[0].status, 'covered', 'legacy evidence with npm test command: covered');
}

// ── 13. renderVerificationCoverage includes Attestation warnings section ──────

{
  const r = buildVerificationCoverage(clWithAttestation, undefined, undefined, { evidenceQualityProfile: 'strict' });
  const rendered = renderVerificationCoverage(r);
  assert.ok(rendered.includes('Attestation warnings:'), 'renderVerificationCoverage should include "Attestation warnings:" section');
  assert.ok(rendered.includes('human_attestation_empty'), 'rendered output should include issue code');
  assert.ok(rendered.includes('looks-good claim without substance'), 'rendered output should include issue message');
  assert.ok(rendered.includes('[BLOCKING]'), 'strict attestation issue should render as [BLOCKING]');
}

// ── 14. getBlockingVerificationEvidenceIssues strict: one detailed issue, not duplicate ─

{
  const issues = getBlockingVerificationEvidenceIssues(clWithAttestation, undefined, 'strict');
  // Should have attestation detail entry
  const detailEntry = issues.find(i => i.includes('human_attestation_empty'));
  assert.ok(detailEntry, 'strict blocking issues should include attestation detail entry');
  // Should NOT have a duplicate generic [weak] entry for the same intentRef
  const genericEntries = issues.filter(i => i.startsWith('CHK-001:happy:0 [weak]') && !i.includes('human_attestation_empty'));
  assert.equal(genericEntries.length, 0, 'should not have duplicate generic [weak] entry when attestation detail is present');
}

console.log('✓ attestation smoke passed');
