import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { classifyManagedReviewFinalEnvelope } = await import('../dist/core/host-run.js');

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

console.log('MANAGED_REVIEW_CANDIDATE_PREFLIGHT_GREEN');
