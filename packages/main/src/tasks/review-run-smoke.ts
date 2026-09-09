import assert from 'node:assert/strict';

import { BASELINE_RUNTIME_CONTRACT } from '../core/prompt-measurement.js';
import { assembleFullPromptEnvelope } from '../core/prompt-envelope.js';
import {
  promptRoleContract,
  resolvePromptRoleBody,
  reviewerHostRenderIdentity,
} from '../core/prompt-role-contract-registry.js';
import {
  reviewerDispatchBindingDigest,
  reviewerDispatchPromptDigest,
} from '../core/prompt-contracts.js';
import {
  signReviewRun,
  verifyReviewRun,
  verifyReviewRunPromptEnvelope,
} from '../core/review-run.js';
import { signReviewPass, verifyReviewPass } from '../core/finding-verify.js';
import type { ReviewPass, ReviewRun } from '../core/types.js';

const fullRollout = {
  version: 'proof-or-stop.prompt-envelope-rollout.v1',
  roles: { 'proof-or-stop-review-quality': 'full-envelope' },
} as const;
const qualityPrompt = resolvePromptRoleBody('proof-or-stop-review-quality', fullRollout).body;
const dispatchPrompt = 'As proof-or-stop-review-quality, review story B-run in full.';
const hostIdentity = reviewerHostRenderIdentity(process.cwd(), 'proof-or-stop-review-quality', 'codex', 'full-envelope');
const dispatchPromptDigest = reviewerDispatchPromptDigest(dispatchPrompt);
const dispatchBindingDigest = reviewerDispatchBindingDigest({
  storyId: 'B-run',
  lane: 'proof-or-stop-review-quality',
  reviewRound: 'round-1',
  dispatchPromptDigest,
  hostRenderIdentityDigest: hostIdentity.identityDigest,
});
const envelope = assembleFullPromptEnvelope({
  roleContract: promptRoleContract('proof-or-stop-review-quality'),
  runtimeContract: BASELINE_RUNTIME_CONTRACT,
  rolePrompt: qualityPrompt,
  taskContext: {
    schemaVersion: 'proof-or-stop.full-task-context.v1',
    storyId: 'B-run',
    title: 'Review run envelope',
    description: 'Bind reviewer authority to a content-addressed full Prompt Envelope.',
    phase: 'REVIEW',
    priority: 'high',
    checklist: [{
      id: 'CHK-001',
      title: 'Bind',
      status: 'done',
      relatedDocs: [],
      files: { modify: ['src/review.ts'], create: [], test: ['tests/review.ts'] },
      verificationIntent: {
        happy: [{ id: 'CHK-001:happy:0', desc: 'Prompt bytes are bound.', type: 'logic' }],
        edge: [],
        adversarial: [],
      },
    }],
    headHash: 'a'.repeat(40),
    materialHash: 'b'.repeat(64),
    storyFilesHash: 'c'.repeat(64),
  },
  dispatchKind: 'review-run',
  reviewRunId: 'B-run:RR-001',
  reviewRound: 'round-1',
  lane: 'proof-or-stop-review-quality',
  dispatchPrompt,
  hostRenderIdentityDigest: hostIdentity.identityDigest,
  createdAt: '2026-07-18T00:00:00.000Z',
});

const run: ReviewRun = {
  reviewRunId: 'B-run:RR-001',
  storyId: 'B-run',
  agent: 'proof-or-stop-review-quality',
  lane: 'proof-or-stop-review-quality',
  reviewRound: 'round-1',
  startedAt: '2026-07-18T00:00:00.000Z',
  headHash: 'a'.repeat(40),
  materialHash: 'b'.repeat(64),
  storyFilesHash: 'c'.repeat(64),
  promptHash: envelope.envelope.assembledPromptDigest,
  envelopeId: envelope.envelope.envelopeId,
  assembledPrompt: envelope.prompt,
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
  readProcessEvents: () => [{
    type: 'dispatch',
    targetKind: 'story-review',
    agentType: 'proof-or-stop-review-quality',
    reviewRound: 'round-1',
    dispatchPrompt,
    dispatchPromptDigest,
    hostRenderHost: 'codex',
    hostRenderIdentityDigest: hostIdentity.identityDigest,
    dispatchBindingDigest,
  }],
};
assert.deepEqual(verifyReviewRunPromptEnvelope(store as never, run), { ok: true });
assert.equal(verifyReviewRun({ ...run, envelopeId: 'e'.repeat(64) }), false, 'envelopeId is signed by ReviewRun');
assert.equal(
  verifyReviewRunPromptEnvelope({
    readPromptEnvelopes: () => ({ envelopes: [{ ...envelope.envelope, headHash: 'f'.repeat(40) }] }),
    readProcessEvents: store.readProcessEvents,
  } as never, run).ok,
  false,
  'payload tamper is rejected even when the outer ReviewRun remains signed',
);
const wrongPromptRun = {
  ...run,
  assembledPrompt: run.assembledPrompt!.replace(qualityPrompt, 'attacker-controlled prompt'),
};
wrongPromptRun.promptHash = envelope.envelope.assembledPromptDigest;
wrongPromptRun._hash = signReviewRun(
  wrongPromptRun.storyId,
  wrongPromptRun.reviewRunId,
  wrongPromptRun.agent,
  wrongPromptRun.lane,
  wrongPromptRun.reviewRound,
  wrongPromptRun.startedAt,
  wrongPromptRun.headHash,
  wrongPromptRun.materialHash,
  wrongPromptRun.promptHash,
  undefined,
  undefined,
  wrongPromptRun.storyFilesHash,
  wrongPromptRun.envelopeId,
);
assert.equal(verifyReviewRun(wrongPromptRun), false, 'signed promptHash cannot bless substituted assembled bytes');
assert.equal(
  verifyReviewRunPromptEnvelope(store as never, { ...run, lane: 'proof-or-stop-review-behavior' }).ok,
  false,
  'cross-lane envelope replay is rejected by the shared gate verifier',
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

const preEnvelope: ReviewRun = { ...run };
delete preEnvelope.envelopeId;
delete preEnvelope.assembledPrompt;
preEnvelope._hash = signReviewRun(
  preEnvelope.storyId,
  preEnvelope.reviewRunId,
  preEnvelope.agent,
  preEnvelope.lane,
  preEnvelope.reviewRound,
  preEnvelope.startedAt,
  preEnvelope.headHash,
  preEnvelope.materialHash,
  preEnvelope.promptHash,
  undefined,
  undefined,
  preEnvelope.storyFilesHash,
);
assert.equal(verifyReviewRun(preEnvelope), false, 'pre-envelope ReviewRun is inert and rejected by the current reader');
assert.deepEqual(
  verifyReviewRunPromptEnvelope({
    readPromptEnvelopes: () => ({ envelopes: [] }),
    readProcessEvents: () => [],
  } as never, preEnvelope),
  { ok: false, reason: 'ReviewRun without a current Prompt Envelope identity is unsupported' },
  'current Prompt Envelope consumer rejects pre-binding historical runs without rewriting them',
);

console.log('review-run Prompt Envelope smoke: PASS');
