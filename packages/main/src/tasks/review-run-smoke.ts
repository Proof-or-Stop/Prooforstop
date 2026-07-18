import assert from 'node:assert/strict';

import { BASELINE_RUNTIME_CONTRACT } from '../core/prompt-measurement.js';
import { assembleFullPromptEnvelope } from '../core/prompt-envelope.js';
import { promptRoleContract } from '../core/prompt-role-contract-registry.js';
import {
  signReviewRun,
  verifyReviewRun,
  verifyReviewRunPromptEnvelope,
} from '../core/review-run.js';
import { signReviewPass, verifyReviewPass } from '../core/finding-verify.js';
import type { ReviewPass, ReviewRun } from '../core/types.js';

const envelope = assembleFullPromptEnvelope({
  roleContract: promptRoleContract('lattice-review-quality'),
  runtimeContract: BASELINE_RUNTIME_CONTRACT,
  rolePrompt: 'Review independently.',
  taskContext: {
    schemaVersion: 'proofbound.full-task-context.v1',
    storyId: 'B-run',
    title: 'Review run envelope',
    description: 'Bind reviewer authority to a content-addressed full Prompt Envelope.',
    phase: 'REVIEW',
    priority: 'high',
    checklist: [{ id: 'CHK-001', title: 'Bind', status: 'done' }],
    headHash: 'a'.repeat(40),
    materialHash: 'b'.repeat(64),
    storyFilesHash: 'c'.repeat(64),
  },
  dispatchKind: 'review-run',
  reviewRunId: 'B-run:RR-001',
  reviewRound: 'round-1',
  lane: 'lattice-review-quality',
  createdAt: '2026-07-18T00:00:00.000Z',
});

const run: ReviewRun = {
  reviewRunId: 'B-run:RR-001',
  storyId: 'B-run',
  agent: 'lattice-review-quality',
  lane: 'lattice-review-quality',
  reviewRound: 'round-1',
  startedAt: '2026-07-18T00:00:00.000Z',
  headHash: 'a'.repeat(40),
  materialHash: 'b'.repeat(64),
  storyFilesHash: 'c'.repeat(64),
  promptHash: 'd'.repeat(64),
  envelopeId: envelope.envelope.envelopeId,
};
run._hash = signReviewRun(
  run.storyId,
  run.reviewRunId,
  run.agent,
  run.lane,
  run.reviewRound,
  run.startedAt,
  run.headHash,
  run.materialHash,
  run.promptHash,
  undefined,
  undefined,
  run.storyFilesHash,
  run.envelopeId,
);
assert.equal(verifyReviewRun(run), true);
const store = {
  readPromptEnvelopes: () => ({ envelopes: [envelope.envelope] }),
};
assert.deepEqual(verifyReviewRunPromptEnvelope(store as never, run), { ok: true });
assert.equal(verifyReviewRun({ ...run, envelopeId: 'e'.repeat(64) }), false, 'envelopeId is signed by ReviewRun');
assert.equal(
  verifyReviewRunPromptEnvelope({
    readPromptEnvelopes: () => ({ envelopes: [{ ...envelope.envelope, headHash: 'f'.repeat(40) }] }),
  } as never, run).ok,
  false,
  'payload tamper is rejected even when the outer ReviewRun remains signed',
);

const provenance = {
  writerSessionId: 'reviewer-session',
  sessionSource: 'explicit-env',
};
const pass: ReviewPass = {
  id: 'B-run:RP-001',
  agent: run.agent,
  note: 'PASS',
  createdAt: '2026-07-18T00:01:00.000Z',
  reviewRound: run.reviewRound,
  reviewRunId: run.reviewRunId,
  envelopeId: run.envelopeId,
  writerSessionId: provenance.writerSessionId,
  sessionSource: provenance.sessionSource,
};
pass._hash = signReviewPass(
  run.storyId,
  pass.id,
  pass.agent,
  pass.note,
  pass.createdAt,
  pass.reviewRound!,
  pass.reviewRunId,
  undefined,
  undefined,
  undefined,
  provenance,
  pass.envelopeId,
);
assert.equal(verifyReviewPass(run.storyId, pass), true);
assert.equal(verifyReviewPass(run.storyId, { ...pass, envelopeId: 'f'.repeat(64) }), false);

const legacy: ReviewRun = { ...run };
delete legacy.envelopeId;
legacy._hash = signReviewRun(
  legacy.storyId,
  legacy.reviewRunId,
  legacy.agent,
  legacy.lane,
  legacy.reviewRound,
  legacy.startedAt,
  legacy.headHash,
  legacy.materialHash,
  legacy.promptHash,
  undefined,
  undefined,
  legacy.storyFilesHash,
);
assert.equal(verifyReviewRun(legacy), true, 'pre-envelope ReviewRun remains readable in bounded legacy mode');

console.log('review-run Prompt Envelope smoke: PASS');
