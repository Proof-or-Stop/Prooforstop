import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';



import { PROOF_OR_STOP_DIR } from "../../core/proof-or-stop-paths.js";



import { readManagedHostRunBinding } from "../../core/managed-host-run.js";
import { classifyReviewerExecutionAuthority, createManagedReviewEvidenceBinding, verifyManagedReviewEvidence, type ManagedReviewExpectedBinding } from "../../core/managed-review-evidence.js";
import { reviewerHostRenderIdentity } from "../../core/prompt-role-contract-registry.js";


import { reviewerDispatchBindingDigest, reviewerDispatchPromptDigest } from "../../core/prompt-contracts.js";
import { collectReviewerEvidenceState, signReviewRun } from "../../core/review-run.js";
import { signFinding, signReviewPass } from "../../core/finding-verify.js";


import { signNativeReviewInvocationAttestation } from "../../core/native-review-attestation.js";
import { issueNativeReviewEvidenceBinding } from "../../core/native-review-evidence.js";



import type { Finding, ReviewRun } from "../../core/types.js";




import { LANE, STORY_ID, REVIEW_RUN_ID, REVIEW_ROUND } from "./environment.js";
import { bindCurrentReviewEnvelope } from "./fixtures.js";
import { runBrokeredNativeBindingFixture } from "./transport-workers.js";
import type { runPhase as previousPhase } from './claude-transport.js';
export async function runPhase(context: NonNullable<Awaited<ReturnType<typeof previousPhase>>>) {

assert.equal(context.passes.length, 1);

assert.equal(context.passes[0]?.agent, LANE);

assert.equal(context.passes[0]?.writerSessionId, `managed:${context.submitted.runId}`);

assert.deepEqual(context.passes[0]?.readManifest?.filesReadFully, ['docs/requirements/decisions/managed-review-evidence.md', 'packages/main/src/example.ts']);

assert.equal(context.passes[0]?.managedEvidenceBinding?.receiptId, context.receipt.receiptId);

const managedBinding = readManagedHostRunBinding(context.root, context.submitted.runId);

const expectedBinding: ManagedReviewExpectedBinding = {
      providerHost: managedBinding.host,
      model: managedBinding.model ?? null,
      reasoningEffort: managedBinding.reasoningEffort ?? null,
      headHash: context.run.headHash,
      materialHash: context.run.materialHash,
      storyFilesHash: context.run.storyFilesHash ?? '',
      promptHash: context.run.promptHash,
      envelopeId: context.run.envelopeId ?? null,
      managedPromptDigest: managedBinding.promptDigest,
    };

const verifySelectedBinding = (
      binding: NonNullable<typeof context.passes[0]>['managedEvidenceBinding'],
    ) => verifyManagedReviewEvidence({
      root: context.root,
      storyId: STORY_ID,
      agent: LANE,
      lane: LANE,
      reviewRunId: REVIEW_RUN_ID,
      binding: binding!,
      expected: expectedBinding,
    });

assert.equal(
      verifySelectedBinding({ ...context.passes[0]!.managedEvidenceBinding!, model: 'different-model' }).valid,
      false,
      'REVIEW verification rejects a persisted model that differs from the sealed spec, receipt, and result',
    );

assert.equal(
      verifySelectedBinding({ ...context.passes[0]!.managedEvidenceBinding!, reasoningEffort: 'low' }).valid,
      false,
      'REVIEW verification rejects persisted reasoning that differs from the sealed spec, receipt, and result',
    );

type IntakeArgs = Parameters<typeof createManagedReviewEvidenceBinding>[0];

const exactIntake: IntakeArgs = {
      root: context.root,
      storyId: STORY_ID,
      providerAgent: LANE,
      lane: LANE,
      reviewRunId: REVIEW_RUN_ID,
      runId: context.submitted.runId,
      receiptId: context.receipt.receiptId,
      expected: expectedBinding,
    };

type MutationCase = {
      name: string;
      mutateIntake: (value: IntakeArgs) => IntakeArgs;
      mutateBinding: (value: NonNullable<typeof context.passes[0]>['managedEvidenceBinding']) => NonNullable<typeof context.passes[0]>['managedEvidenceBinding'];
      /** Story ownership is implicit in the store key and is exercised by the real cross-story gate below. */
      gateCoveredSeparately?: boolean;
    };

const mutationCases: MutationCase[] = [
      { name: 'agent', mutateIntake: value => ({ ...value, providerAgent: 'proof-or-stop-review-concept' }), mutateBinding: value => ({ ...value!, providerAgent: 'proof-or-stop-review-concept' }) },
      {
        name: 'story',
        mutateIntake: value => ({ ...value, storyId: 'B-cross-story' }),
        mutateBinding: value => value!,
        gateCoveredSeparately: true,
      },
      { name: 'lane', mutateIntake: value => ({ ...value, lane: 'proof-or-stop-review-concept' }), mutateBinding: value => ({ ...value!, lane: 'proof-or-stop-review-concept' }) },
      { name: 'reviewRun', mutateIntake: value => ({ ...value, reviewRunId: `${STORY_ID}:RR-999` }), mutateBinding: value => ({ ...value!, reviewRunId: `${STORY_ID}:RR-999` }) },
      { name: 'provider', mutateIntake: value => ({ ...value, expected: { ...value.expected, providerHost: 'claude' } }), mutateBinding: value => ({ ...value!, providerHost: 'claude' }) },
      { name: 'head', mutateIntake: value => ({ ...value, expected: { ...value.expected, headHash: 'other-head' } }), mutateBinding: value => ({ ...value!, headHash: 'other-head' }) },
      { name: 'material', mutateIntake: value => ({ ...value, expected: { ...value.expected, materialHash: 'other-material' } }), mutateBinding: value => ({ ...value!, materialHash: 'other-material' }) },
      { name: 'storyFiles', mutateIntake: value => ({ ...value, expected: { ...value.expected, storyFilesHash: 'other-story-files' } }), mutateBinding: value => ({ ...value!, storyFilesHash: 'other-story-files' }) },
      { name: 'prompt', mutateIntake: value => ({ ...value, expected: { ...value.expected, promptHash: 'other-prompt' } }), mutateBinding: value => ({ ...value!, promptHash: 'other-prompt' }) },
      { name: 'envelope', mutateIntake: value => ({ ...value, expected: { ...value.expected, envelopeId: 'a'.repeat(64) } }), mutateBinding: value => ({ ...value!, envelopeId: 'a'.repeat(64) }) },
      { name: 'managedPrompt', mutateIntake: value => ({ ...value, expected: { ...value.expected, managedPromptDigest: 'sha256:other-managed-prompt' } }), mutateBinding: value => ({ ...value!, managedPromptDigest: 'sha256:other-managed-prompt' }) },
    ];

const originalPass = structuredClone(context.passes[0]!);

for (const mutation of mutationCases) {
      if (context.bindingMutationTarget && mutation.name !== context.bindingMutationTarget) continue;
      let intakeReason = '';
      if (context.evaluatorMutationBoundary !== 'gate') {
        try {
          createManagedReviewEvidenceBinding(mutation.mutateIntake(exactIntake));
          assert.fail(`fresh intake rejects ${mutation.name} mutation`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message === `fresh intake rejects ${mutation.name} mutation`) throw error;
          assert.match(message, /managed_review_evidence_import:/, `fresh intake rejects ${mutation.name} mutation`);
          intakeReason = message.replace(/^managed_review_evidence_import:\s*/, '');
        }
      }
      const mutatedBinding = mutation.mutateBinding(originalPass.managedEvidenceBinding)!;
      const mutatedPass = { ...originalPass, managedEvidenceBinding: mutatedBinding };
      mutatedPass._hash = signReviewPass(
        STORY_ID,
        mutatedPass.id,
        mutatedPass.agent,
        mutatedPass.note,
        mutatedPass.createdAt,
        mutatedPass.reviewRound ?? '',
        mutatedPass.reviewRunId ?? '',
        mutatedPass.readManifest,
        mutatedPass.readLog,
        mutatedPass.readDiagnostics,
        { writerSessionId: mutatedPass.writerSessionId!, sessionSource: mutatedPass.sessionSource! },
        mutatedPass.envelopeId,
        mutatedBinding,
      );
      context.store.writeReviewPasses(STORY_ID, { passes: [mutatedPass] });
      if (context.evaluatorMutationBoundary !== 'intake' && !mutation.gateCoveredSeparately) {
        const gate = collectReviewerEvidenceState(context.store, STORY_ID, context.root);
        const gateInvalid = gate.invalid.find(candidate => candidate.code === 'managed_receipt_invalid');
        assert.ok(gateInvalid, `REVIEW gate rejects persisted ${mutation.name} mutation`);
        // Agent is represented identically at importer and persisted-evidence
        // boundaries, so it also proves the shared evaluator's reason remains
        // canonical. Material tuple mutations necessarily enter through
        // importer `expected` versus persisted binding fields and may surface
        // different individual failed checks while both remain fail-closed.
        if (intakeReason && mutation.name === 'agent') {
          assert.ok(gateInvalid!.message.endsWith(intakeReason),
            `fresh intake and REVIEW gate retain one canonical reason for ${mutation.name} mutation`);
        }
      }
      context.store.writeReviewPasses(STORY_ID, { passes: [originalPass] });
      if (context.evaluatorMutationBoundary || context.bindingMutationTarget) break;
    }

const evidence = collectReviewerEvidenceState(context.store, STORY_ID, context.root);

assert.ok(evidence.valid.some(candidate => candidate.id === context.passes[0]?.id), 'REVIEW gate must accept the exact sealed managed evidence');

assert.equal(evidence.invalid.some(candidate => candidate.code === 'managed_receipt_invalid'), false);

const crossStoryId = 'B-cross-story';

const sourceStory = context.store.readStory(STORY_ID);

context.store.writeStory(crossStoryId, {
      ...sourceStory,
      storyId: crossStoryId,
      name: 'managed-review-cross-story-control',
      title: 'Managed review cross-story control',
    });

context.store.writeChecklist(crossStoryId, context.store.readChecklist(STORY_ID));

const crossDispatchPrompt = 'Perform the exact native-host review for this story.';

const crossHostIdentity = reviewerHostRenderIdentity(context.root, LANE, 'codex', 'full-envelope');

context.store.appendProcessEvent(crossStoryId, {
      type: 'dispatch',
      storyId: crossStoryId,
      agentType: LANE,
      targetKind: 'story-review',
      reviewRound: REVIEW_ROUND,
      dispatchPrompt: crossDispatchPrompt,
      dispatchPromptDigest: reviewerDispatchPromptDigest(crossDispatchPrompt),
      hostRenderHost: 'codex',
      hostRenderIdentityDigest: crossHostIdentity.identityDigest,
      dispatchBindingDigest: reviewerDispatchBindingDigest({
        storyId: crossStoryId,
        lane: LANE,
        reviewRound: REVIEW_ROUND,
        dispatchPromptDigest: reviewerDispatchPromptDigest(crossDispatchPrompt),
        hostRenderIdentityDigest: crossHostIdentity.identityDigest,
      }),
    });

const crossRun: ReviewRun = {
      ...context.run,
      storyId: crossStoryId,
      _hash: signReviewRun(
        crossStoryId,
        context.run.reviewRunId,
        context.run.agent,
        context.run.lane,
        context.run.reviewRound,
        context.run.startedAt,
        context.run.headHash,
        context.run.materialHash,
        context.run.promptHash,
        undefined,
        undefined,
        context.run.storyFilesHash,
      ),
    };

bindCurrentReviewEnvelope(context.root, context.store, crossRun);

context.store.writeReviewRuns(crossStoryId, { runs: [crossRun] });

const crossPass = { ...structuredClone(originalPass), id: `${crossStoryId}:RP-001`, envelopeId: crossRun.envelopeId };

crossPass._hash = signReviewPass(
      crossStoryId,
      crossPass.id,
      crossPass.agent,
      crossPass.note,
      crossPass.createdAt,
      crossPass.reviewRound ?? '',
      crossPass.reviewRunId ?? '',
      crossPass.readManifest,
      crossPass.readLog,
      crossPass.readDiagnostics,
      { writerSessionId: crossPass.writerSessionId!, sessionSource: crossPass.sessionSource! },
      crossPass.envelopeId,
      crossPass.managedEvidenceBinding,
    );

context.store.writeReviewPasses(crossStoryId, { passes: [crossPass] });

const crossStoryGate = collectReviewerEvidenceState(context.store, crossStoryId, context.root);

assert.ok(
      crossStoryGate.invalid.some(candidate => candidate.code === 'managed_receipt_invalid'),
      'persisting and re-signing an authentic managed pass under a different story is rejected by the actual REVIEW gate storyMatches boundary',
    );

assert.deepEqual(classifyReviewerExecutionAuthority({
      executionMode: 'cross-provider-cli',
      assuranceLevel: 'ordinary-review',
      hasManagedEvidenceBinding: true,
    }), {
      classification: 'managed-cross-provider-receipt',
      directSignedReviewAllowed: false,
      managedReceiptRequired: true,
      reviewGatePath: 'managed-receipt',
    });

const nativePass = structuredClone(originalPass);

delete nativePass.managedEvidenceBinding;

nativePass.writerSessionId = 'native-host-reviewer-session';

nativePass.sessionSource = 'host-adapter';

nativePass._hash = signReviewPass(
      STORY_ID,
      nativePass.id,
      nativePass.agent,
      nativePass.note,
      nativePass.createdAt,
      nativePass.reviewRound ?? '',
      nativePass.reviewRunId ?? '',
      nativePass.readManifest,
      nativePass.readLog,
      nativePass.readDiagnostics,
      { writerSessionId: nativePass.writerSessionId, sessionSource: nativePass.sessionSource },
      nativePass.envelopeId,
      undefined,
    );

context.store.writeReviewPasses(STORY_ID, { passes: [nativePass] });

const unboundDirectEvidence = collectReviewerEvidenceState(context.store, STORY_ID, context.root);

assert.equal(
      unboundDirectEvidence.valid.some(candidate => candidate.id === nativePass.id),
      false,
      'absence of a managed binding is not proof that direct evidence came from the native host',
    );

assert.ok(
      unboundDirectEvidence.invalid.some(candidate => String(candidate.code) === 'review_execution_authority_missing'),
      'an otherwise correctly re-signed direct pass without a broker invocation attestation fails closed',
    );

nativePass.nativeEvidenceBinding = issueNativeReviewEvidenceBinding({
      projectRoot: context.root,
      storyId: STORY_ID,
      agent: LANE,
      lane: LANE,
      reviewRunId: REVIEW_RUN_ID,
      identity: {
        sessionId: nativePass.writerSessionId,
        sessionSource: 'host-adapter',
        hostProvider: 'codex',
        nativeSessionRef: 'codex:validated-composite',
      },
      dispatch: {
        hostRenderHost: 'codex',
        dispatchPromptDigest: context.nativeDispatch.dispatchPromptDigest,
        hostRenderIdentityDigest: context.nativeDispatch.hostRenderIdentityDigest,
        dispatchBindingDigest: context.nativeDispatch.dispatchBindingDigest,
      },
      attestation: context.brokerAttestation,
      observeProcess: () => null,
    });

nativePass._hash = signReviewPass(
      STORY_ID,
      nativePass.id,
      nativePass.agent,
      nativePass.note,
      nativePass.createdAt,
      nativePass.reviewRound ?? '',
      nativePass.reviewRunId ?? '',
      nativePass.readManifest,
      nativePass.readLog,
      nativePass.readDiagnostics,
      { writerSessionId: nativePass.writerSessionId, sessionSource: nativePass.sessionSource },
      nativePass.envelopeId,
      undefined,
      nativePass.nativeEvidenceBinding,
    );

context.store.writeReviewPasses(STORY_ID, { passes: [nativePass] });

assert.ok(
      collectReviewerEvidenceState(context.store, STORY_ID, context.root).valid.some(candidate => candidate.id === nativePass.id),
      'a registered-broker native invocation preserves the direct signed review path without OS ancestry',
    );

const nativeConsumptionPath = join(
      context.root,
      PROOF_OR_STOP_DIR,
      'runtime',
      'native-review-invocations',
      nativePass.nativeEvidenceBinding!.brokerId,
      `${nativePass.nativeEvidenceBinding!.invocationNonce}.json`,
    );

const nativeConsumption = readFileSync(nativeConsumptionPath, 'utf8');

unlinkSync(nativeConsumptionPath);

assert.ok(
      collectReviewerEvidenceState(context.store, STORY_ID, context.root).invalid.some(candidate => candidate.evidenceId === nativePass.id),
      'deleting the persisted one-shot native broker consumption record invalidates the otherwise signed direct-review pass',
    );

writeFileSync(nativeConsumptionPath, nativeConsumption, 'utf8');

const tamperedNativeConsumption = JSON.parse(nativeConsumption) as Record<string, unknown>;

tamperedNativeConsumption.attestationDigest = `sha256:${'f'.repeat(64)}`;

writeFileSync(nativeConsumptionPath, `${JSON.stringify(tamperedNativeConsumption)}\n`, 'utf8');

assert.ok(
      collectReviewerEvidenceState(context.store, STORY_ID, context.root).invalid.some(candidate => candidate.evidenceId === nativePass.id),
      'tampering the persisted one-shot native broker consumption digest invalidates current review acceptance',
    );

writeFileSync(nativeConsumptionPath, nativeConsumption, 'utf8');

assert.ok(
      collectReviewerEvidenceState(context.store, STORY_ID, context.root).valid.some(candidate => candidate.id === nativePass.id),
      'restoring the exact consumption record preserves valid existing native review evidence',
    );

const brokeredCliSession = 'brokered-codex-cli-session';

const brokeredCliClaims = {
      ...context.invocationClaims,
      writerSessionId: brokeredCliSession,
      invocationNonce: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

const brokeredFixture = await runBrokeredNativeBindingFixture(
      context.root,
      {
        storyId: STORY_ID,
        agent: LANE,
        lane: LANE,
        reviewRunId: REVIEW_RUN_ID,
        dispatch: {
          ...context.nativeDispatch,
          hostRenderHost: 'codex',
        },
      },
      signNativeReviewInvocationAttestation(brokeredCliClaims, context.brokerKeys.privateKey),
      {
        ...process.env,
        // A brokered native fixture must not inherit authority from an outer
        // managed Claude/Codex review. These values deliberately model the
        // real nested-provider environment that exposed F-098.
        LATTICE_MANAGED_HOST_RUN_ID: 'ambient-managed-review-run',
        LATTICE_MANAGED_REVIEW_INVOCATION_FD: '99',
        CLAUDE_CODE_SESSION_ID: 'ambient-claude-host-session',
        PROOF_OR_STOP_SESSION_ID: brokeredCliSession,
        PROOF_OR_STOP_AGENT: LANE,
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'codex-desktop-brokered-tool-invocation',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: LANE,
      },
    );

assert.equal(brokeredFixture.status, 0,
      `isolated broker-signature fixture succeeds without consulting ambient provider ancestry: ${brokeredFixture.stderr}`);

const brokeredFixtureBinding = JSON.parse(brokeredFixture.stdout) as {
      writerSessionId: string;
      adapterId: string;
      brokerId: string;
    };

assert.deepEqual(
      {
        writerSessionId: brokeredFixtureBinding.writerSessionId,
        adapterId: brokeredFixtureBinding.adapterId,
        brokerId: brokeredFixtureBinding.brokerId,
      },
      {
        writerSessionId: brokeredCliSession,
        adapterId: 'codex-desktop',
        brokerId: 'smoke-codex-broker',
      },
      'independent fixture process consumes the exact registered-broker attestation without an OS-ancestry prerequisite',
    );

const passesBeforeDuplicateMutation = structuredClone(context.store.readReviewPasses(STORY_ID).passes);

const duplicatedNativePass = {
      ...structuredClone(nativePass),
      id: `${STORY_ID}:RP-900`,
      createdAt: new Date(Date.now() + 1).toISOString(),
    };

duplicatedNativePass._hash = signReviewPass(
      STORY_ID,
      duplicatedNativePass.id,
      duplicatedNativePass.agent,
      duplicatedNativePass.note,
      duplicatedNativePass.createdAt,
      duplicatedNativePass.reviewRound ?? '',
      duplicatedNativePass.reviewRunId ?? '',
      duplicatedNativePass.readManifest,
      duplicatedNativePass.readLog,
      duplicatedNativePass.readDiagnostics,
      { writerSessionId: duplicatedNativePass.writerSessionId!, sessionSource: duplicatedNativePass.sessionSource! },
      duplicatedNativePass.envelopeId,
      undefined,
      duplicatedNativePass.nativeEvidenceBinding,
    );

context.store.writeReviewPasses(STORY_ID, { passes: [...passesBeforeDuplicateMutation, duplicatedNativePass] });

const duplicateGate = collectReviewerEvidenceState(context.store, STORY_ID, context.root);

assert.equal(
      duplicateGate.valid.some(candidate => candidate.id === nativePass.id || candidate.id === duplicatedNativePass.id),
      false,
      'persisted duplicate evidence cannot reuse one broker invocation nonce',
    );

assert.equal(
      duplicateGate.invalid.filter(candidate => /broker attestations are one-shot/.test(candidate.message)).length,
      2,
      'both artifacts sharing the consumed nonce are rejected rather than choosing an attacker-controlled winner',
    );

context.store.writeReviewPasses(STORY_ID, { passes: passesBeforeDuplicateMutation });

const findingsBeforeNativeBroker = structuredClone(context.store.readFindings(STORY_ID).findings);

const nativeFindingReviewRunId = context.newAttempt('native-finding').reviewRunId;

const nativeFindingClaims = {
      ...context.invocationClaims,
      reviewRunId: nativeFindingReviewRunId,
      writerSessionId: 'native-brokered-finding-session',
      invocationNonce: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

const nativeFindingBinding = issueNativeReviewEvidenceBinding({
      projectRoot: context.root,
      storyId: STORY_ID,
      agent: LANE,
      lane: LANE,
      reviewRunId: nativeFindingReviewRunId,
      identity: {
        sessionId: nativeFindingClaims.writerSessionId,
        sessionSource: 'host-adapter',
        hostProvider: 'codex',
        nativeSessionRef: 'codex:validated-composite',
      },
      dispatch: {
        hostRenderHost: 'codex',
        dispatchPromptDigest: context.nativeDispatch.dispatchPromptDigest,
        hostRenderIdentityDigest: context.nativeDispatch.hostRenderIdentityDigest,
        dispatchBindingDigest: context.nativeDispatch.dispatchBindingDigest,
      },
      attestation: signNativeReviewInvocationAttestation(nativeFindingClaims, context.brokerKeys.privateKey),
      observeProcess: () => null,
    });

const nativeFinding: Finding = {
      id: `${STORY_ID}:F-900`,
      desc: 'Registered broker authorizes this exact native reviewer finding closeout.',
      severity: 'low',
      category: 'edge',
      status: 'open',
      evidenceState: 'disproven',
      disprovenEvidence: {
        summary: 'The brokered native finding was refuted by the exact signed counter-evidence.',
        sourceRefs: ['packages/main/src/core/finding-verify.ts:1'],
        reproCommand: 'node packages/main/dist/tasks/managed-review-evidence-smoke.js',
      },
      agent: LANE,
      createdAt: new Date().toISOString(),
      reviewRound: REVIEW_ROUND,
      reviewRunId: nativeFindingReviewRunId,
      nativeEvidenceBinding: nativeFindingBinding,
      _hash: '',
    };

nativeFinding._hash = signFinding(
      STORY_ID,
      nativeFinding.id!,
      nativeFinding.desc,
      nativeFinding.severity,
      nativeFinding.createdAt!,
      nativeFinding.reviewRound ?? '',
      nativeFinding.reviewRunId ?? '',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      nativeFindingBinding,
      {
        category: nativeFinding.category,
        evidenceState: nativeFinding.evidenceState ?? null,
        uncertaintyReason: nativeFinding.uncertaintyReason ?? null,
        files: nativeFinding.files ?? [],
        disprovenEvidence: nativeFinding.disprovenEvidence,
      },
    );

return Object.defineProperties(context, {
  managedBinding: { enumerable: true, get: () => managedBinding },
  expectedBinding: { enumerable: true, get: () => expectedBinding },
  verifySelectedBinding: { enumerable: true, get: () => verifySelectedBinding },
  exactIntake: { enumerable: true, get: () => exactIntake },
  mutationCases: { enumerable: true, get: () => mutationCases },
  originalPass: { enumerable: true, get: () => originalPass },
  evidence: { enumerable: true, get: () => evidence },
  crossStoryId: { enumerable: true, get: () => crossStoryId },
  sourceStory: { enumerable: true, get: () => sourceStory },
  crossDispatchPrompt: { enumerable: true, get: () => crossDispatchPrompt },
  crossHostIdentity: { enumerable: true, get: () => crossHostIdentity },
  crossRun: { enumerable: true, get: () => crossRun },
  crossPass: { enumerable: true, get: () => crossPass },
  crossStoryGate: { enumerable: true, get: () => crossStoryGate },
  nativePass: { enumerable: true, get: () => nativePass },
  unboundDirectEvidence: { enumerable: true, get: () => unboundDirectEvidence },
  nativeConsumptionPath: { enumerable: true, get: () => nativeConsumptionPath },
  nativeConsumption: { enumerable: true, get: () => nativeConsumption },
  tamperedNativeConsumption: { enumerable: true, get: () => tamperedNativeConsumption },
  brokeredCliSession: { enumerable: true, get: () => brokeredCliSession },
  brokeredCliClaims: { enumerable: true, get: () => brokeredCliClaims },
  brokeredFixture: { enumerable: true, get: () => brokeredFixture },
  brokeredFixtureBinding: { enumerable: true, get: () => brokeredFixtureBinding },
  passesBeforeDuplicateMutation: { enumerable: true, get: () => passesBeforeDuplicateMutation },
  duplicatedNativePass: { enumerable: true, get: () => duplicatedNativePass },
  duplicateGate: { enumerable: true, get: () => duplicateGate },
  findingsBeforeNativeBroker: { enumerable: true, get: () => findingsBeforeNativeBroker },
  nativeFindingReviewRunId: { enumerable: true, get: () => nativeFindingReviewRunId },
  nativeFindingClaims: { enumerable: true, get: () => nativeFindingClaims },
  nativeFindingBinding: { enumerable: true, get: () => nativeFindingBinding },
  nativeFinding: { enumerable: true, get: () => nativeFinding },
}) as typeof context & {
  readonly managedBinding: typeof managedBinding;
  readonly expectedBinding: typeof expectedBinding;
  readonly verifySelectedBinding: typeof verifySelectedBinding;
  readonly exactIntake: typeof exactIntake;
  readonly mutationCases: typeof mutationCases;
  readonly originalPass: typeof originalPass;
  readonly evidence: typeof evidence;
  readonly crossStoryId: typeof crossStoryId;
  readonly sourceStory: typeof sourceStory;
  readonly crossDispatchPrompt: typeof crossDispatchPrompt;
  readonly crossHostIdentity: typeof crossHostIdentity;
  readonly crossRun: typeof crossRun;
  readonly crossPass: typeof crossPass;
  readonly crossStoryGate: typeof crossStoryGate;
  readonly nativePass: typeof nativePass;
  readonly unboundDirectEvidence: typeof unboundDirectEvidence;
  readonly nativeConsumptionPath: typeof nativeConsumptionPath;
  readonly nativeConsumption: typeof nativeConsumption;
  readonly tamperedNativeConsumption: typeof tamperedNativeConsumption;
  readonly brokeredCliSession: typeof brokeredCliSession;
  readonly brokeredCliClaims: typeof brokeredCliClaims;
  readonly brokeredFixture: typeof brokeredFixture;
  readonly brokeredFixtureBinding: typeof brokeredFixtureBinding;
  readonly passesBeforeDuplicateMutation: typeof passesBeforeDuplicateMutation;
  readonly duplicatedNativePass: typeof duplicatedNativePass;
  readonly duplicateGate: typeof duplicateGate;
  readonly findingsBeforeNativeBroker: typeof findingsBeforeNativeBroker;
  readonly nativeFindingReviewRunId: typeof nativeFindingReviewRunId;
  readonly nativeFindingClaims: typeof nativeFindingClaims;
  readonly nativeFindingBinding: typeof nativeFindingBinding;
  readonly nativeFinding: typeof nativeFinding;
};
}
