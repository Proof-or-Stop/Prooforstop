#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { evaluateFactProvenanceEvidence } from '../core/fact-provenance.js';
import { buildVerificationCoverage, getBlockingVerificationEvidenceIssues } from '../core/verification.js';
import type { ChecklistData, VerificationEvidence } from '../core/types.js';

const NOW = new Date('2025-06-01T12:00:00.000Z');

function makeEvidence(overrides: Partial<VerificationEvidence>): VerificationEvidence {
  return {
    intentRef: 'CHK-001:happy:0',
    kind: 'integration_test',
    result: 'pass',
    note: 'test passed',
    ...overrides,
  };
}

function makeChecklist(evidence: VerificationEvidence): ChecklistData {
  return {
    items: [{
      id: 'CHK-001',
      title: 'Test item',
      status: 'done',
      startTime: null,
      endTime: null,
      verificationIntent: {
        happy: [{ desc: 'happy path', type: 'logic', priority: 'must' }],
        edge: [],
        adversarial: [],
      },
      verificationEvidence: [evidence],
    }],
  };
}

// ── 1. Primary source with full provenance passes strict ─────────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceClass: 'primary',
      sourceUrl: 'https://example.com/spec',
      sourceRef: 'RFC-1234',
      fetchedAt: '2025-05-30T00:00:00.000Z',
      digest: 'sha256:abc123',
      checkedClaims: ['claim A is true'],
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  assert.equal(issues.length, 0, 'primary source with full provenance should produce no issues in strict');
  console.log('✓ primary source with full provenance passes strict');
}

// ── 2. Non-external evidence without provenance is compatible ────────────────

{
  const ev = makeEvidence({});
  const issues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  assert.equal(issues.length, 0, 'non-external evidence without factProvenance should be compatible');
  console.log('✓ non-external evidence without provenance is compatible');
}

// ── 3. local kind is compatible without provenance ───────────────────────────

{
  const ev = makeEvidence({ factProvenance: { kind: 'local' } });
  const issues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  assert.equal(issues.length, 0, 'local kind without provenance details is compatible');
  console.log('✓ local kind is compatible');
}

// ── 4. balanced warns on secondary-only without blocking ─────────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceClass: 'secondary',
      sourceUrl: 'https://example.com/secondary',
      fetchedAt: '2025-05-30T00:00:00.000Z',
      digest: 'sha256:abc123',
      checkedClaims: ['some claim'],
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'balanced', { now: NOW, requirePrimarySource: true });
  const secondaryIssue = issues.find(i => i.code === 'secondary_only_source');
  assert.ok(secondaryIssue, 'should warn on secondary-only in balanced');
  assert.equal(secondaryIssue?.severity, 'warning', 'should be warning in balanced (not blocking)');
  console.log('✓ balanced warns on secondary-only source');
}

// ── 5. balanced warns on soon-expiring provenance ────────────────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com/spec',
      fetchedAt: '2025-04-01T00:00:00.000Z', // 61 days ago from NOW
      digest: 'sha256:abc123',
      checkedClaims: ['some claim'],
    },
  });
  // maxAgeDays=60 so 61 days is stale
  const issues = evaluateFactProvenanceEvidence(ev, 'balanced', { now: NOW, maxAgeDays: 60 });
  const staleIssue = issues.find(i => i.code === 'stale_fetched_at');
  assert.ok(staleIssue, 'should warn on stale fetchedAt in balanced');
  assert.equal(staleIssue?.severity, 'warning', 'should be warning in balanced');
  console.log('✓ balanced warns on stale provenance');
}

// ── 6. balanced warns on expired expiresAt ───────────────────────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com/spec',
      fetchedAt: '2025-05-30T00:00:00.000Z',
      expiresAt: '2025-05-31T00:00:00.000Z', // before NOW
      digest: 'sha256:abc123',
      checkedClaims: ['some claim'],
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'balanced', { now: NOW });
  const expiredIssue = issues.find(i => i.code === 'expired');
  assert.ok(expiredIssue, 'should warn on expired expiresAt in balanced');
  assert.equal(expiredIssue?.severity, 'warning', 'should be warning in balanced');
  console.log('✓ balanced warns on expired provenance');
}

// ── 7. strict blocks missing source ─────────────────────────────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      digest: 'sha256:abc123',
      checkedClaims: ['some claim'],
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  const sourceIssue = issues.find(i => i.code === 'missing_source');
  assert.ok(sourceIssue, 'strict should block missing sourceUrl/sourceRef');
  assert.equal(sourceIssue?.severity, 'blocking');
  console.log('✓ strict blocks missing source');
}

// ── 8. strict blocks missing digest ──────────────────────────────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com',
      checkedClaims: ['some claim'],
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  const digestIssue = issues.find(i => i.code === 'missing_digest');
  assert.ok(digestIssue, 'strict should block missing digest');
  assert.equal(digestIssue?.severity, 'blocking');
  console.log('✓ strict blocks missing digest');
}

// ── 9. strict blocks missing checkedClaims ───────────────────────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com',
      digest: 'sha256:abc123',
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  const claimsIssue = issues.find(i => i.code === 'missing_checked_claims');
  assert.ok(claimsIssue, 'strict should block missing checkedClaims');
  assert.equal(claimsIssue?.severity, 'blocking');
  console.log('✓ strict blocks missing checkedClaims');
}

// ── 10. strict blocks stale fetchedAt ────────────────────────────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com',
      fetchedAt: '2024-01-01T00:00:00.000Z', // very old
      digest: 'sha256:abc123',
      checkedClaims: ['some claim'],
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  const staleIssue = issues.find(i => i.code === 'stale_fetched_at');
  assert.ok(staleIssue, 'strict should block stale fetchedAt');
  assert.equal(staleIssue?.severity, 'blocking');
  console.log('✓ strict blocks stale fetchedAt');
}

// ── 11. strict blocks expired expiresAt ──────────────────────────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com',
      fetchedAt: '2025-05-30T00:00:00.000Z',
      expiresAt: '2025-05-31T00:00:00.000Z', // before NOW
      digest: 'sha256:abc123',
      checkedClaims: ['some claim'],
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  const expiredIssue = issues.find(i => i.code === 'expired');
  assert.ok(expiredIssue, 'strict should block expired expiresAt');
  assert.equal(expiredIssue?.severity, 'blocking');
  console.log('✓ strict blocks expired expiresAt');
}

// ── 12. strict blocks secondary-only when primary required ───────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceClass: 'tertiary',
      sourceUrl: 'https://example.com',
      fetchedAt: '2025-05-30T00:00:00.000Z',
      digest: 'sha256:abc123',
      checkedClaims: ['some claim'],
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW, requirePrimarySource: true });
  const secondaryIssue = issues.find(i => i.code === 'secondary_only_source');
  assert.ok(secondaryIssue, 'strict should block tertiary source when primary required');
  assert.equal(secondaryIssue?.severity, 'blocking');
  console.log('✓ strict blocks secondary/tertiary-only when primary required');
}

// ── 13. strict blocks conflicting sources ────────────────────────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com',
      fetchedAt: '2025-05-30T00:00:00.000Z',
      digest: 'sha256:abc123',
      checkedClaims: ['some claim'],
      conflictingSources: ['https://other.com'],
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  const conflictIssue = issues.find(i => i.code === 'conflicting_sources');
  assert.ok(conflictIssue, 'strict should block conflicting sources');
  assert.equal(conflictIssue?.severity, 'blocking');
  console.log('✓ strict blocks conflicting sources');
}

// ── 14. light profile is always compatible ───────────────────────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      // no source, no digest, no claims — would block in strict
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'light', { now: NOW });
  assert.equal(issues.length, 0, 'light profile should produce no issues');
  console.log('✓ light profile is always compatible');
}

// ── 15. requireExternalProvenance forces checks on non-external evidence ─────

{
  const ev = makeEvidence({
    // no factProvenance — but requireExternalProvenance=true forces checks
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW, requireExternalProvenance: true });
  assert.ok(issues.length > 0, 'requireExternalProvenance should force checks on evidence without factProvenance');
  const sourceIssue = issues.find(i => i.code === 'missing_source');
  assert.ok(sourceIssue, 'should have missing_source issue');
  console.log('✓ requireExternalProvenance forces checks on non-external evidence');
}

// ── 16. buildVerificationCoverage emits factProvenanceIssues ─────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com',
      fetchedAt: '2025-05-30T00:00:00.000Z',
      digest: 'sha256:abc123',
      // missing checkedClaims
    },
  });
  const cl = makeChecklist(ev);
  const report = buildVerificationCoverage(cl, undefined, undefined, {
    evidenceQualityProfile: 'strict',
    factProvenance: { now: NOW },
  });
  assert.ok(report.factProvenanceIssues && report.factProvenanceIssues.length > 0, 'should emit factProvenanceIssues in report');
  console.log('✓ buildVerificationCoverage emits factProvenanceIssues');
}

// ── 17. strict blocking provenance issue demotes coverage to weak ─────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      // no source, no digest, no claims — multiple blocking issues
    },
  });
  const cl = makeChecklist(ev);
  const report = buildVerificationCoverage(cl, undefined, undefined, {
    evidenceQualityProfile: 'strict',
    factProvenance: { now: NOW },
  });
  const entry = report.entries.find(e => e.intentRef === 'CHK-001:happy:0');
  assert.equal(entry?.status, 'weak', 'strict blocking provenance issues should demote to weak');
  console.log('✓ strict blocking provenance issue demotes to weak');
}

// ── 18. getBlockingVerificationEvidenceIssues includes fact provenance detail ─

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com',
      fetchedAt: '2025-05-30T00:00:00.000Z',
      digest: 'sha256:abc123',
      // no checkedClaims — blocking in strict
    },
  });
  const cl = makeChecklist(ev);
  const blockingIssues = getBlockingVerificationEvidenceIssues(cl, undefined, 'strict');
  const provenanceIssue = blockingIssues.find(i => i.includes('missing_checked_claims'));
  assert.ok(provenanceIssue, 'blocking issues should include fact provenance detail');
  console.log('✓ getBlockingVerificationEvidenceIssues includes fact provenance detail');
}

// ── 19. whitespace-only sourceUrl/sourceRef treated as missing ───────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: '   ',
      sourceRef: '\t',
      digest: 'sha256:abc123',
      checkedClaims: ['some claim'],
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  const sourceIssue = issues.find(i => i.code === 'missing_source');
  assert.ok(sourceIssue, 'whitespace-only sourceUrl/sourceRef should be treated as missing in strict');
  assert.equal(sourceIssue?.severity, 'blocking');
  console.log('✓ whitespace-only sourceUrl/sourceRef treated as missing in strict');
}

// ── 20. whitespace-only digest treated as missing ─────────────────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com',
      digest: '   ',
      checkedClaims: ['some claim'],
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  const digestIssue = issues.find(i => i.code === 'missing_digest');
  assert.ok(digestIssue, 'whitespace-only digest should be treated as missing in strict');
  assert.equal(digestIssue?.severity, 'blocking');
  console.log('✓ whitespace-only digest treated as missing in strict');
}

// ── 21. whitespace-only checkedClaims entries treated as missing ──────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com',
      digest: 'sha256:abc123',
      checkedClaims: ['  ', '\t', ''],
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  const claimsIssue = issues.find(i => i.code === 'missing_checked_claims');
  assert.ok(claimsIssue, 'whitespace-only checkedClaims should be treated as missing in strict');
  assert.equal(claimsIssue?.severity, 'blocking');
  console.log('✓ whitespace-only checkedClaims entries treated as missing in strict');
}

// ── 22. whitespace-only conflictingSources do not trigger conflict ────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com',
      fetchedAt: '2025-05-30T00:00:00.000Z',
      digest: 'sha256:abc123',
      checkedClaims: ['some claim'],
      conflictingSources: ['  ', ''],
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  const conflictIssue = issues.find(i => i.code === 'conflicting_sources');
  assert.equal(conflictIssue, undefined, 'whitespace-only conflictingSources should not trigger conflicting_sources');
  console.log('✓ whitespace-only conflictingSources do not trigger conflict');
}

// ── 23. non-empty conflictingSources still trigger conflict ───────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com',
      fetchedAt: '2025-05-30T00:00:00.000Z',
      digest: 'sha256:abc123',
      checkedClaims: ['some claim'],
      conflictingSources: ['  ', 'https://other.com'],
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  const conflictIssue = issues.find(i => i.code === 'conflicting_sources');
  assert.ok(conflictIssue, 'mixed whitespace+non-empty conflictingSources should trigger conflict');
  assert.equal(conflictIssue?.severity, 'blocking');
  console.log('✓ non-empty conflictingSources still trigger conflict (mixed with whitespace)');
}

// ── 24. invalid fetchedAt emits invalid_fetched_at ───────────────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com',
      fetchedAt: 'not-a-date',
      digest: 'sha256:abc123',
      checkedClaims: ['some claim'],
    },
  });
  const strictIssues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  const strictInvalid = strictIssues.find(i => i.code === 'invalid_fetched_at');
  assert.ok(strictInvalid, 'invalid fetchedAt should emit invalid_fetched_at in strict');
  assert.equal(strictInvalid?.severity, 'blocking');

  const balancedIssues = evaluateFactProvenanceEvidence(ev, 'balanced', { now: NOW });
  const balancedInvalid = balancedIssues.find(i => i.code === 'invalid_fetched_at');
  assert.ok(balancedInvalid, 'invalid fetchedAt should emit invalid_fetched_at in balanced');
  assert.equal(balancedInvalid?.severity, 'warning');
  console.log('✓ invalid fetchedAt emits invalid_fetched_at with correct severity per profile');
}

// ── 25. invalid expiresAt emits invalid_expires_at ───────────────────────────

{
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com',
      fetchedAt: '2025-05-30T00:00:00.000Z',
      expiresAt: 'bad-date',
      digest: 'sha256:abc123',
      checkedClaims: ['some claim'],
    },
  });
  const strictIssues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  const strictInvalid = strictIssues.find(i => i.code === 'invalid_expires_at');
  assert.ok(strictInvalid, 'invalid expiresAt should emit invalid_expires_at in strict');
  assert.equal(strictInvalid?.severity, 'blocking');

  const balancedIssues = evaluateFactProvenanceEvidence(ev, 'balanced', { now: NOW });
  const balancedInvalid = balancedIssues.find(i => i.code === 'invalid_expires_at');
  assert.ok(balancedInvalid, 'invalid expiresAt should emit invalid_expires_at in balanced');
  assert.equal(balancedInvalid?.severity, 'warning');
  console.log('✓ invalid expiresAt emits invalid_expires_at with correct severity per profile');
}

// ── 26. soon_expiring: future expiresAt within soonExpiryDays emits warning ───

{
  // expiresAt is 3 days after NOW, within default 7-day window
  const soonDate = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com',
      fetchedAt: '2025-05-30T00:00:00.000Z',
      expiresAt: soonDate,
      digest: 'sha256:abc123',
      checkedClaims: ['some claim'],
    },
  });

  const strictIssues = evaluateFactProvenanceEvidence(ev, 'strict', { now: NOW });
  const strictSoon = strictIssues.find(i => i.code === 'soon_expiring');
  assert.ok(strictSoon, 'soon_expiring should be emitted in strict for near-future expiresAt');
  assert.equal(strictSoon?.severity, 'warning', 'soon_expiring should always be warning (not blocking)');
  // No expired issue should be emitted
  assert.equal(strictIssues.find(i => i.code === 'expired'), undefined, 'should not emit expired when not yet expired');

  const balancedIssues = evaluateFactProvenanceEvidence(ev, 'balanced', { now: NOW });
  const balancedSoon = balancedIssues.find(i => i.code === 'soon_expiring');
  assert.ok(balancedSoon, 'soon_expiring should be emitted in balanced for near-future expiresAt');
  assert.equal(balancedSoon?.severity, 'warning');
  console.log('✓ soon_expiring emitted as warning for future expiresAt within soonExpiryDays');
}

// ── 27. soon_expiring does not demote strict coverage to blocking ─────────────

{
  const soonDate = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com',
      fetchedAt: '2025-05-30T00:00:00.000Z',
      expiresAt: soonDate,
      digest: 'sha256:abc123',
      checkedClaims: ['some claim'],
    },
  });
  const cl = makeChecklist(ev);
  const report = buildVerificationCoverage(cl, undefined, undefined, {
    evidenceQualityProfile: 'strict',
    factProvenance: { now: NOW },
  });
  const entry = report.entries.find(e => e.intentRef === 'CHK-001:happy:0');
  assert.notEqual(entry?.status, 'weak', 'soon_expiring (warning) should not demote strict coverage to weak');
  assert.equal(entry?.status, 'covered', 'soon_expiring should leave coverage as covered');
  console.log('✓ soon_expiring warning does not demote strict coverage to blocking/weak');
}

// ── 28. soon_expiring not emitted when already expired ────────────────────────

{
  const pastDate = new Date(NOW.getTime() - 1000).toISOString(); // 1 second ago
  const ev = makeEvidence({
    factProvenance: {
      kind: 'external_fact',
      sourceUrl: 'https://example.com',
      fetchedAt: '2025-05-30T00:00:00.000Z',
      expiresAt: pastDate,
      digest: 'sha256:abc123',
      checkedClaims: ['some claim'],
    },
  });
  const issues = evaluateFactProvenanceEvidence(ev, 'balanced', { now: NOW });
  assert.equal(issues.find(i => i.code === 'soon_expiring'), undefined, 'should not emit soon_expiring when already expired');
  assert.ok(issues.find(i => i.code === 'expired'), 'should emit expired when past expiresAt');
  console.log('✓ soon_expiring not emitted when already expired');
}

console.log('\nAll fact-provenance-smoke tests passed.');
