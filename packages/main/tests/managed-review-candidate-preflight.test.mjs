import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { classifyManagedReviewFinalEnvelope } = await import('../dist/core/host-run.js');
const {
  hasPersistedManagedReceiptEvidence,
  runManagedReviewCandidatePreflight,
} = await import('../dist/handlers/managed-review-evidence.js');
const { assertManagedReviewCandidateLaunchReady } = await import('../dist/handlers/host-run.js');

assert.throws(() => assertManagedReviewCandidateLaunchReady({
  requiresEscalation: true,
  fullScan: false,
  escalationReasons: ['requirements_corpus_missing'],
}, 'B-candidate-preflight'), error => {
  assert.match(error.message, /managed_review_candidate_routing_unresolved/);
  assert.match(error.message, /requirements_corpus_missing/);
  assert.match(error.message, /candidate_spec_route/);
  assert.match(error.message, /fullScanReason/);
  return true;
}, 'managed review must refuse unresolved candidate routing before provider launch');

assert.doesNotThrow(() => assertManagedReviewCandidateLaunchReady({
  requiresEscalation: true,
  fullScan: true,
  escalationReasons: ['requirements_corpus_missing'],
}, 'B-candidate-preflight'));

const missingCandidateDigests = JSON.stringify({
  schemaVersion: 'lattice.managed_review_final_proposal.v1',
  storyId: 'B-candidate-preflight',
  providerAgent: 'proof-or-stop-review-quality',
  lane: 'proof-or-stop-review-quality',
  reviewRunId: 'B-candidate-preflight:RR-001',
  conclusion: 'pass',
  note: 'The bounded implementation review found no blocking quality issue.',
  readManifest: {
    filesReadFully: ['packages/main/src/example.ts'],
    filesTriagedByName: [],
    scanEscalationReason: null,
    candidateSpecSetDigest: null,
    corpusDigest: null,
  },
  readLog: {
    filesReadFully: ['packages/main/src/example.ts'],
    filesTriagedByName: [],
    summary: { readCount: 1, tokenCount: null },
    digest: 'a'.repeat(64),
  },
});

assert.deepEqual(
  classifyManagedReviewFinalEnvelope(missingCandidateDigests),
  { kind: 'malformed', reason: 'read_manifest_candidate_spec_digest_missing' },
  'a provider null caused by a missing candidate artifact needs a stable field-level diagnostic',
);

const handler = readFileSync(new URL('../src/handlers/host-run.ts', import.meta.url), 'utf8');
const artifactRead = handler.indexOf('const candidateArtifact = ctx.store.readCandidateSpecSet(storyId)');
const missingRefusal = handler.indexOf('managed_review_candidate_spec_missing');
const promptBuild = handler.indexOf('promptText = buildManagedReviewerPrompt', artifactRead);
const managedSubmit = handler.indexOf('submitManagedHostRun', promptBuild);
assert.ok(artifactRead >= 0 && missingRefusal > artifactRead && missingRefusal < promptBuild,
  'missing candidate routing must not launch the provider');
assert.ok(managedSubmit > promptBuild,
  'the source-order assertion must cover the real managed host submission path');
assert.match(handler.slice(missingRefusal, promptBuild), /candidate_spec_route/,
  'the refusal must give the owner the exact repair command');
assert.match(handler.slice(artifactRead, promptBuild), /assertManagedReviewCandidateLaunchReady\(candidateArtifact, storyId\)/,
  'unresolved candidate routing must be rejected before prompt construction and provider submission');

assert.equal(typeof runManagedReviewCandidatePreflight, 'function',
  'managed import must expose its executable candidate-preflight seam');
assert.equal(typeof hasPersistedManagedReceiptEvidence, 'function',
  'managed import must expose the production persisted-receipt lookup used by crash recovery');

const receiptId = `sha256:${'1'.repeat(64)}`;
const evidenceStore = (passes, findings) => ({
  readReviewPasses: () => ({ passes }),
  readFindings: () => ({ findings }),
});
assert.equal(hasPersistedManagedReceiptEvidence(evidenceStore([
  { managedEvidenceBinding: { receiptId } },
], []), 'B-candidate-preflight', receiptId), true,
'a persisted ReviewPass for the exact receipt selects authenticated recovery');
assert.equal(hasPersistedManagedReceiptEvidence(evidenceStore([], [
  { managedEvidenceBinding: { receiptId } },
]), 'B-candidate-preflight', receiptId), true,
'a persisted Finding for the exact receipt selects authenticated recovery');
assert.equal(hasPersistedManagedReceiptEvidence(evidenceStore([
  { managedEvidenceBinding: { receiptId: `sha256:${'2'.repeat(64)}` } },
], []), 'B-candidate-preflight', receiptId), false,
'foreign receipt evidence cannot bypass the fresh candidate preflight');

const proposal = { storyId: 'B-candidate-preflight' };
let candidateChecks = 0;
let intakeCalls = 0;
assert.throws(() => runManagedReviewCandidatePreflight({
  sealedProposal: proposal,
  hasPersistedReceiptEvidence: false,
  assertCurrentCandidateReadBinding: () => {
    candidateChecks += 1;
    throw new Error('STALE_CANDIDATE_BINDING');
  },
  intake: () => {
    intakeCalls += 1;
    return 'intake';
  },
}), /STALE_CANDIDATE_BINDING/);
assert.equal(candidateChecks, 1);
assert.equal(intakeCalls, 0,
  'a stale fresh import must reject before expensive receipt/proposal intake');

candidateChecks = 0;
assert.equal(runManagedReviewCandidatePreflight({
  sealedProposal: proposal,
  hasPersistedReceiptEvidence: true,
  assertCurrentCandidateReadBinding: () => { candidateChecks += 1; },
  intake: () => { intakeCalls += 1; return 'recovery'; },
}), 'recovery');
assert.equal(candidateChecks, 0,
  'persisted receipt evidence must reach authenticated crash recovery without reinterpreting historic routing');
assert.equal(intakeCalls, 1);

assert.equal(runManagedReviewCandidatePreflight({
  sealedProposal: null,
  hasPersistedReceiptEvidence: false,
  assertCurrentCandidateReadBinding: () => { candidateChecks += 1; },
  intake: () => { intakeCalls += 1; return 'compatibility'; },
}), 'compatibility');
assert.equal(candidateChecks, 0, 'legacy intake without a sealed proposal retains its compatibility path');
assert.equal(intakeCalls, 2);

const providerProtocol = readFileSync(new URL('../src/core/managed-review-evidence.ts', import.meta.url), 'utf8');
assert.match(providerProtocol, /Use a standard JSON serializer/,
  'the provider protocol must explicitly forbid non-JSON escapes such as backslash-apostrophe');
const importer = readFileSync(new URL('../src/handlers/managed-review-evidence.ts', import.meta.url), 'utf8');
assert.match(importer, /const intake = runManagedReviewCandidatePreflight\(\{/,
  'production importer must execute the tested preflight seam');
assert.match(importer, /hasPersistedManagedReceiptEvidence\(ctx\.store, managedRun\.storyId, receiptId\)/,
  'production importer must use the tested exact-receipt lookup');
assert.match(importer, /assertCurrentCandidateReadBinding\(proposal\);/,
  'production importer must retain the lock-held second candidate validation');

console.log('MANAGED_REVIEW_CANDIDATE_PREFLIGHT_GREEN');
