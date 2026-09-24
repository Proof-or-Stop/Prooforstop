import { withManagedFixturePrompt } from './prompt-fixture.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';




import { MAIN_TOOLS } from "../../cli/command-catalog.js";
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from "../../core/evidence-freshness.js";

import { managedHostRunDirectory, managedHostRunReceipt, getManagedHostRunStatus, readManagedReviewEvidenceProposal, readManagedHostRunResult, readManagedHostRunBinding, runManagedHostRunWorker, submitManagedHostRun, writeManagedReviewEvidenceProposal } from "../../core/managed-host-run.js";
import { buildManagedReviewerPrompt, createManagedReviewEvidenceBinding, type ManagedReviewExpectedBinding } from "../../core/managed-review-evidence.js";




import { collectReviewerEvidenceState, hashReviewPrompt, signReviewRun } from "../../core/review-run.js";
import { signReviewPass } from "../../core/finding-verify.js";

import { generateEd25519KeyPair } from "../../core/authority-signing.js";
import {
  signNativeReviewInvocationAttestation,
  verifyNativeReviewInvocationAttestation,
} from "../../core/native-review-attestation.js";
import { classifyNativeHostProcessLineage } from "../../core/native-review-evidence.js";


import { defaultHostRunRunner, type HostRunRunner } from "../../core/host-run.js";
import type { ReviewRun } from "../../core/types.js";


import { createManagedReviewEvidenceHandlers } from "../../handlers/managed-review-evidence.js";
import { createHostRunHandlers, type HostRunDetachResult } from "../../handlers/host-run.js";
import { seedReviewStory, bindCurrentReviewEnvelope, waitForExit, eventually, managedReadEvidence } from "./fixtures.js";
import { REVIEW_RUN_ID, STORY_ID, LANE, REVIEW_ROUND, SELF, REQUESTED_CODEX_MODEL, REQUESTED_CODEX_REASONING, MANAGED_REVIEW_FIXTURE_DEADLINE_MS, hostOwnedChildEnv, MANAGED_REVIEW_DESCRIPTOR_DEADLINE_MS, MANAGED_REVIEW_NESTED_CLAIM_DELAY_MS, MANAGED_REVIEW_DESCRIPTOR_CLAIM_TIMEOUT_MS } from "./environment.js";
import { assertDescriptorBackedProviderProposalTransport } from "./transport-workers.js";
import { assertManagedImportAllowsSameMaterialMetadataAdvance, assertManagedImportRejectsLiveMaterialDrift, assertManagedImportRejectsLateLiveMaterialDrift, assertManagedImportEnforcesCandidateReadBinding } from "./live-binding.js";
export function assertImportedPass(store: ReturnType<typeof seedReviewStory>['store'], runId: string, receiptId: string): void {
  const passes = store.readReviewPasses(STORY_ID).passes;
assert.equal(passes.length, 1);

assert.equal(passes[0]?.agent, LANE);

assert.equal(passes[0]?.writerSessionId, `managed:${runId}`);

assert.deepEqual(passes[0]?.readManifest?.filesReadFully, ['docs/requirements/decisions/managed-review-evidence.md', 'packages/main/src/example.ts']);

assert.equal(passes[0]?.managedEvidenceBinding?.receiptId, receiptId);

}

export interface BaseContext { root: string; evaluatorMutationBoundary: string | undefined; bindingMutationTarget: string | undefined; fullRun: boolean; descriptorOnly: boolean; }
export async function runPhase(context: BaseContext) {

const brokerKeys = generateEd25519KeyPair();

const { store, run, nativeDispatch } = seedReviewStory(context.root, brokerKeys.publicKey);

let attemptSequence = 0;

const newAttempt = (name: string): ReviewRun => {
      // Separate experiments need distinct signed runs, not another dispatch
      // that supersedes the native-authority control shared by this fixture.
      const reviewRunId = `${REVIEW_RUN_ID}:${name}-${++attemptSequence}`;
      const headHash = currentGitHead(context.root)!;
      const materialHash = currentMaterialHash(context.root)!;
      const storyFilesHash = currentStoryFilesHash(context.root)!;
      const attempt: ReviewRun = { ...run, reviewRunId, headHash, materialHash, storyFilesHash,
        _hash: signReviewRun(STORY_ID, reviewRunId, LANE, LANE, REVIEW_ROUND,
          REVIEW_ROUND, headHash, materialHash, run.promptHash, undefined, undefined, storyFilesHash),
      };
      bindCurrentReviewEnvelope(context.root, store, attempt);
      store.writeReviewRuns(STORY_ID, { runs: [...store.readReviewRuns(STORY_ID).runs, attempt] });
      return attempt;
    };

if (process.argv[2] === '--descriptor-proposal-transport' || context.descriptorOnly) {
      await assertDescriptorBackedProviderProposalTransport(context.root, store, run);
      console.log('managed-review-evidence descriptor-proposal-transport PASS');
      return;
    }

const preEnvelopeRun: ReviewRun = { ...run, envelopeId: undefined, assembledPrompt: undefined,
      promptHash: hashReviewPrompt('retired pre-envelope fixture body') };

assert.throws(() => buildManagedReviewerPrompt(context.root, preEnvelopeRun),
      /managed reviewer requires a current canonical full-envelope ReviewRun; pre-envelope runs must be renewed/,
      'managed reviewer must reject missing current envelope instead of reconstructing legacy authority');

await assertManagedImportAllowsSameMaterialMetadataAdvance(brokerKeys.publicKey);

await assertManagedImportRejectsLiveMaterialDrift(brokerKeys.publicKey);

await assertManagedImportRejectsLateLiveMaterialDrift(brokerKeys.publicKey);

await assertManagedImportEnforcesCandidateReadBinding(brokerKeys.publicKey);

process.chdir(context.root);

assert.equal(
      MAIN_TOOLS.some(tool => tool.name === 'native_review_invocation_issue'),
      false,
      'ordinary dispatch/review_run_start/raw CLI have no broker-attestation issuer command',
    );

const mixedLineage = classifyNativeHostProcessLineage([
      { pid: 303, ppid: 202, comm: 'codex', command: 'codex exec' },
      { pid: 202, ppid: 1, comm: 'claude', command: 'claude review' },
    ]);

assert.deepEqual(mixedLineage.providerFamilies, ['codex', 'claude']);

assert.equal(mixedLineage.mixedProviderFamilies, true, 'full ancestry rejects Claude to Codex even when the nearest provider matches');

const invocationClaims = {
      schemaVersion: 'lattice.native_review_invocation_attestation.v1' as const,
      brokerId: 'smoke-codex-broker',
      adapterId: 'codex-desktop',
      host: 'codex' as const,
      storyId: STORY_ID,
      agent: LANE,
      lane: LANE,
      reviewRunId: REVIEW_RUN_ID,
      writerSessionId: 'native-host-reviewer-session',
      dispatchPromptDigest: nativeDispatch.dispatchPromptDigest,
      dispatchBindingDigest: nativeDispatch.dispatchBindingDigest,
      hostRenderIdentityDigest: nativeDispatch.hostRenderIdentityDigest,
      invocationNonce: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

const brokerAttestation = signNativeReviewInvocationAttestation(invocationClaims, brokerKeys.privateKey);

assert.equal(verifyNativeReviewInvocationAttestation({
      attestation: brokerAttestation,
      trustedBrokers: [{
        brokerId: 'smoke-codex-broker',
        adapterId: 'codex-desktop',
        host: 'codex',
        publicKey: brokerKeys.publicKey,
      }],
      expected: invocationClaims,
    }).ok, true, 'registered broker signature authorizes the exact native invocation without OS ancestry');

let deliveredPrompt = '';

let deliveredEnvironment: NodeJS.ProcessEnv = {};

let deliveredArgv: string[] = [];

let proposalRaceReady = false;

let releaseTerminal!: () => void;

const terminalGate = new Promise<void>(resolve => { releaseTerminal = resolve; });

const runner: HostRunRunner = async plan => {
      deliveredPrompt = plan.stdinText ?? '';
      deliveredEnvironment = { ...plan.env };
      deliveredArgv = [...plan.argv];
      const runId = plan.env.LATTICE_MANAGED_HOST_RUN_ID!;
      const proposalBarrier = join(context.root, `${runId}-proposal.go`);
      const workers = [0, 1].map(index => {
        const readyPath = join(context.root, `${runId}-proposal-${index}.ready`);
        const resultPath = join(context.root, `${runId}-proposal-${index}.result`);
        const child = spawn(process.execPath, [SELF, '--proposal-worker', context.root, runId, readyPath, proposalBarrier, resultPath], {
          cwd: context.root,
          env: plan.env,
          stdio: 'ignore',
        });
        return { child, exit: waitForExit(child), readyPath, resultPath };
      });
      await eventually(async () => workers.every(worker => {
        try { readFileSync(worker.readyPath); return true; } catch { return false; }
      }), 'real proposal workers did not reach their barrier');
      writeFileSync(proposalBarrier, 'go');
      assert.deepEqual(await Promise.all(workers.map(worker => worker.exit)), [0, 0]);
      const results = workers.map(worker => readFileSync(worker.resultPath, 'utf8'));
      assert.equal(results.filter(result => result === 'created').length, 1, 'real multiprocess proposal race has exactly one immutable winner');
      assert.equal(results.filter(result => /already has an immutable evidence proposal/.test(result)).length, 1,
        'real multiprocess proposal loser observes the immutable provider proposal');
      proposalRaceReady = true;
      await terminalGate;
      return { stdout: '{}\n', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
    };

const hostHandlers = createHostRunHandlers({ store, root: context.root, scanRoot: join(context.root, 'packages/main') }, { runner });

const managedSelectionRequest = {
      host: 'codex',
      storyId: STORY_ID,
      agentType: LANE,
      reviewRunId: REVIEW_RUN_ID,
      lane: LANE,
      model: REQUESTED_CODEX_MODEL,
      reasoningEffort: REQUESTED_CODEX_REASONING,
      managedReview: true,
      detach: true,
      deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS,
      json: true,
    } as const;

const detached = await hostHandlers.host_run(managedSelectionRequest) as HostRunDetachResult;

await assert.rejects(
      hostHandlers.host_run({ ...managedSelectionRequest, model: 'gpt-5.6-sol' }),
      /idempotency input conflict; keep the original run/,
      'resubmitting one review identity with a different model cannot silently reuse or replace the original run',
    );

const submitted = detached.run;

assert.match(deliveredPrompt, /BEGIN MANAGED REVIEW EVIDENCE PROTOCOL/);

assert.match(deliveredPrompt, /overrides any generic reviewer-role instruction/i,
      'the managed final-envelope protocol explicitly supersedes generic reviewer role write instructions');

assert.match(deliveredPrompt, /Do not call review_run_start, review_pass_set, or finding_add/);

assert.match(
      deliveredEnvironment.LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY ?? '',
      /^[A-Za-z0-9+/]{43}=$/,
      'the provider receives an unguessable proposal bearer capability distinct from runId',
    );

const codexModelIndex = deliveredArgv.indexOf('--model');

const codexReasoningIndex = deliveredArgv.indexOf('--config');

assert.deepEqual(
      deliveredArgv.slice(codexModelIndex, codexModelIndex + 2),
      ['--model', REQUESTED_CODEX_MODEL],
      'managed review model selection reaches the exact Codex invocation',
    );

assert.deepEqual(
      deliveredArgv.slice(codexReasoningIndex, codexReasoningIndex + 2),
      ['--config', `model_reasoning_effort="${REQUESTED_CODEX_REASONING}"`],
      'managed review reasoning selection reaches the exact Codex invocation',
    );

await eventually(async () => proposalRaceReady, 'real proposal workers did not finish before the terminal/import race');

const importBarrier = join(context.root, 'import-barrier.go');

const importWorkers = [0, 1].map(index => {
      const readyPath = join(context.root, `import-worker-${index}.ready`);
      const resultPath = join(context.root, `import-worker-${index}.result`);
      const child = spawn(process.execPath, [
        SELF, '--import-worker', context.root, submitted.runId, 'AUTO',
        readyPath, importBarrier, resultPath,
      ], { cwd: context.root, env: hostOwnedChildEnv(), stdio: 'ignore' });
      return { child, exit: waitForExit(child), readyPath, resultPath };
    });

await eventually(async () => importWorkers.every(worker => {
      try { readFileSync(worker.readyPath); return true; } catch { return false; }
    }), 'concurrent import workers did not reach the pre-terminal barrier');

writeFileSync(importBarrier, 'go');

releaseTerminal();

await eventually(async () => {
      const status = await getManagedHostRunStatus({ root: context.root, runId: submitted.runId });
      return status.run.state === 'completed';
    }, 'managed reviewer did not complete');

const receipt = managedHostRunReceipt(context.root, submitted.runId);

const selectedRunBinding = readManagedHostRunBinding(context.root, submitted.runId) as ReturnType<typeof readManagedHostRunBinding> & {
      model?: string | null;
      reasoningEffort?: string | null;
    };

const selectedReceipt = receipt as typeof receipt & { model?: string | null; reasoningEffort?: string | null };

const selectedResult = readManagedHostRunResult(context.root, submitted.runId) as (ReturnType<typeof readManagedHostRunResult> & {
      model?: string | null;
      reasoningEffort?: string | null;
    });

assert.deepEqual(
      [selectedRunBinding.model, selectedRunBinding.reasoningEffort],
      [REQUESTED_CODEX_MODEL, REQUESTED_CODEX_REASONING],
      'managed review model selection is sealed in the immutable run binding',
    );

assert.deepEqual(
      [selectedReceipt.model, selectedReceipt.reasoningEffort],
      [REQUESTED_CODEX_MODEL, REQUESTED_CODEX_REASONING],
      'managed review model selection is sealed in the terminal receipt',
    );

assert.deepEqual(
      [selectedResult?.model, selectedResult?.reasoningEffort],
      [REQUESTED_CODEX_MODEL, REQUESTED_CODEX_REASONING],
      'managed review result records the exact launched model selection',
    );

assert.deepEqual(await Promise.all(importWorkers.map(worker => worker.exit)), [0, 0],
      'real importer processes waiting before terminal creation both converge cleanly after the exclusive receipt appears');

const concurrentImportResults = importWorkers.map(worker => readFileSync(worker.resultPath, 'utf8'));
assertImportedPass(store, submitted.runId, receipt.receiptId);

assert.equal(concurrentImportResults.filter(result => /Managed review evidence imported/.test(result)).length, 1);

assert.equal(concurrentImportResults.filter(result => /already imported/.test(result)).length, 1,
      'real proposal/terminal/import race converges on one creator and one exact reuse');

const handlers = createManagedReviewEvidenceHandlers({ store, root: context.root, scanRoot: join(context.root, 'packages/main') });

const assertSelectedEvaluatorMutation = (): void => {
      const passes = store.readReviewPasses(STORY_ID).passes;
      assert.equal(passes.length, 1,
        'the selected evaluator mutation fixture requires exactly one imported sealed pass');
      const originalPass = structuredClone(passes[0]!);
      const originalBinding = originalPass.managedEvidenceBinding;
      assert.ok(originalBinding,
        'the selected evaluator mutation fixture requires the imported pass to retain its managed evidence binding');
      const managedBinding = readManagedHostRunBinding(context.root, submitted.runId);
      const expectedBinding: ManagedReviewExpectedBinding = {
        providerHost: managedBinding.host,
        model: managedBinding.model ?? null,
        reasoningEffort: managedBinding.reasoningEffort ?? null,
        headHash: run.headHash,
        materialHash: run.materialHash,
        storyFilesHash: run.storyFilesHash ?? '',
        promptHash: run.promptHash,
        envelopeId: run.envelopeId ?? null,
        managedPromptDigest: managedBinding.promptDigest,
      };
      type IntakeArgs = Parameters<typeof createManagedReviewEvidenceBinding>[0];
      const exactIntake: IntakeArgs = {
        root: context.root,
        storyId: STORY_ID,
        providerAgent: LANE,
        lane: LANE,
        reviewRunId: REVIEW_RUN_ID,
        runId: submitted.runId,
        receiptId: receipt.receiptId,
        expected: expectedBinding,
      };
      type MutationCase = {
        name: string;
        mutateIntake: (value: IntakeArgs) => IntakeArgs;
        mutateBinding: (value: NonNullable<typeof originalPass.managedEvidenceBinding>) => NonNullable<typeof originalPass.managedEvidenceBinding>;
        /** Story ownership is implicit in the store key and is covered by the full normal matrix. */
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
        { name: 'model', mutateIntake: value => ({ ...value, expected: { ...value.expected, model: 'different-model' } }), mutateBinding: value => ({ ...value!, model: 'different-model' }) },
        { name: 'reasoningEffort', mutateIntake: value => ({ ...value, expected: { ...value.expected, reasoningEffort: 'low' } }), mutateBinding: value => ({ ...value!, reasoningEffort: 'low' }) },
        { name: 'head', mutateIntake: value => ({ ...value, expected: { ...value.expected, headHash: 'other-head' } }), mutateBinding: value => ({ ...value!, headHash: 'other-head' }) },
        { name: 'material', mutateIntake: value => ({ ...value, expected: { ...value.expected, materialHash: 'other-material' } }), mutateBinding: value => ({ ...value!, materialHash: 'other-material' }) },
        { name: 'storyFiles', mutateIntake: value => ({ ...value, expected: { ...value.expected, storyFilesHash: 'other-story-files' } }), mutateBinding: value => ({ ...value!, storyFilesHash: 'other-story-files' }) },
        { name: 'prompt', mutateIntake: value => ({ ...value, expected: { ...value.expected, promptHash: 'other-prompt' } }), mutateBinding: value => ({ ...value!, promptHash: 'other-prompt' }) },
        { name: 'envelope', mutateIntake: value => ({ ...value, expected: { ...value.expected, envelopeId: 'a'.repeat(64) } }), mutateBinding: value => ({ ...value!, envelopeId: 'a'.repeat(64) }) },
        { name: 'managedPrompt', mutateIntake: value => ({ ...value, expected: { ...value.expected, managedPromptDigest: 'sha256:other-managed-prompt' } }), mutateBinding: value => ({ ...value!, managedPromptDigest: 'sha256:other-managed-prompt' }) },
      ];
      const selectedMutations = context.bindingMutationTarget
        ? mutationCases.filter(mutation => mutation.name === context.bindingMutationTarget)
        : [mutationCases[0]!];
      assert.equal(selectedMutations.length, 1,
        'the bounded evaluator mutation fixture requires one explicit binding target');
      const mutation = selectedMutations[0]!;
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
      const mutatedBinding = mutation.mutateBinding(originalBinding);
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
      store.writeReviewPasses(STORY_ID, { passes: [mutatedPass] });
      if (context.evaluatorMutationBoundary !== 'intake' && !mutation.gateCoveredSeparately) {
        const gate = collectReviewerEvidenceState(store, STORY_ID, context.root);
        const gateInvalid = gate.invalid.find(candidate => candidate.code === 'managed_receipt_invalid');
        assert.ok(gateInvalid, `REVIEW gate rejects persisted ${mutation.name} mutation`);
        if (intakeReason && mutation.name === 'agent') {
          assert.ok(gateInvalid!.message.endsWith(intakeReason),
            `fresh intake and REVIEW gate retain one canonical reason for ${mutation.name} mutation`);
        }
      }
      store.writeReviewPasses(STORY_ID, { passes: [originalPass] });
      const evidence = collectReviewerEvidenceState(store, STORY_ID, context.root);
      assert.ok(evidence.valid.some(candidate => candidate.id === originalPass.id),
        'the exact sealed managed evidence remains accepted after the selected mutation control');
      assert.equal(evidence.invalid.some(candidate => candidate.code === 'managed_receipt_invalid'), false);
    };

if (context.evaluatorMutationBoundary || context.bindingMutationTarget) {
      assertSelectedEvaluatorMutation();
      console.log('managed-review-evidence selected-evaluator-mutation PASS');
      return;
    }

const finalResultReviewRunId = newAttempt('finalResult').reviewRunId;

const finalEnvelope = JSON.stringify({
      schemaVersion: 'lattice.managed_review_final_proposal.v1',
      storyId: STORY_ID,
      providerAgent: LANE,
      lane: LANE,
      reviewRunId: finalResultReviewRunId,
      conclusion: 'pass',
      note: 'The provider reviewed the exact managed material and found no blocking issue.',
      ...managedReadEvidence(context.root),
    });

const codexMultiMessageRunner: HostRunRunner = plan => defaultHostRunRunner({
      ...plan,
      command: process.execPath,
      argv: ['-e', `for (const event of ${JSON.stringify([
        { type: 'item.completed', item: { type: 'agent_message', text: 'DISPATCH_START reviewer accepted the managed assignment' } },
        { type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning is not a proposal candidate' } },
        { type: 'item.completed', item: { type: 'command_execution', aggregated_output: finalEnvelope } },
        { type: 'item.completed', item: { type: 'agent_message', text: 'Reviewed the first evidence group; continuing with adversarial paths.' } },
        { type: 'item.completed', item: { type: 'agent_message', text: finalEnvelope } },
      ])}) process.stdout.write(JSON.stringify(event) + '\\n');`],
    });

const finalResultRun = await createHostRunHandlers(
      { store, root: context.root, scanRoot: join(context.root, 'packages/main') },
      { runner: codexMultiMessageRunner },
    ).host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: finalResultReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: 5_000, json: true,
    }) as HostRunDetachResult;

await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: finalResultRun.run.runId })).run.terminal !== null,
      'final-result managed reviewer did not reach terminal');

const finalResultReceipt = managedHostRunReceipt(context.root, finalResultRun.run.runId);

assert.equal(finalResultReceipt.state, 'completed', 'an exact bounded final proposal completes the formal managed run');

assert.match(finalResultReceipt.evidenceProposalDigest ?? '', /^sha256:/,
      'the worker seals the provider final-result proposal into terminal.json');

assert.match(
      handlers.managed_review_evidence_import({ runId: finalResultRun.run.runId, receiptId: finalResultReceipt.receiptId }),
      /Managed review evidence imported/,
      'the exact provider final-result proposal is importable without a provider tool-shell callback',
    );

store.writeReviewPasses(STORY_ID, {
      passes: store.readReviewPasses(STORY_ID).passes.filter(
        pass => pass.managedEvidenceBinding?.receiptId !== finalResultReceipt.receiptId,
      ),
    });

const finalEnvelopeFor = (reviewRunId: string): string => JSON.stringify({ ...JSON.parse(finalEnvelope), reviewRunId });

const submitProposalRace = async (
      runnerFor: (reviewRunId: string) => HostRunRunner,
      afterManagedReviewProposalPreRead?: (args: { runId: string; reviewRunId: string }) => void,
    ) => {
      const raceRun = newAttempt('proposal-race');
      return submitManagedHostRun(withManagedFixturePrompt({
      root: context.root,
      cwd: context.root,
      host: 'codex',
      storyId: STORY_ID,
      phase: 'REVIEW',
      agentType: LANE,
      reviewRunId: raceRun.reviewRunId,
      lane: LANE,
      promptText: buildManagedReviewerPrompt(context.root, raceRun),
      deadlineMs: 5_000,
      projectRootHash: `sha256:${'a'.repeat(64)}`,
      profile: 'managed_reviewer',
      reviewBinding: {
        headHash: raceRun.headHash,
        materialHash: raceRun.materialHash,
        storyFilesHash: raceRun.storyFilesHash ?? '',
        promptHash: raceRun.promptHash,
        envelopeId: raceRun.envelopeId ?? null,
      },
    }), {
      launchWorker: async request => {
        void runManagedHostRunWorker(request, {
          runner: runnerFor(raceRun.reviewRunId),
          afterManagedReviewProposalPreRead: args => afterManagedReviewProposalPreRead?.({ runId: args.runId, reviewRunId: raceRun.reviewRunId }),
        });
        return { pid: process.pid };
      },
      claimTimeoutMs: 2_000,
      claimPollMs: 10,
    });
    };

const delayedClaimReviewRunId = newAttempt('delayedClaim').reviewRunId;

let delayedClaimWorkerError: unknown = null;

let resolveDelayedClaimWorker: (() => void) | null = null;

const delayedClaimWorkerFinished = new Promise<void>(resolve => {
      resolveDelayedClaimWorker = resolve;
    });

const delayedClaimRun = await submitManagedHostRun(withManagedFixturePrompt({
      root: context.root,
      cwd: context.root,
      host: 'codex',
      storyId: STORY_ID,
      phase: 'REVIEW',
      agentType: LANE,
      reviewRunId: delayedClaimReviewRunId,
      lane: LANE,
      promptText: buildManagedReviewerPrompt(context.root, store.readReviewRuns(STORY_ID).runs.find(candidate => candidate.reviewRunId === delayedClaimReviewRunId)!),
      deadlineMs: MANAGED_REVIEW_DESCRIPTOR_DEADLINE_MS,
      projectRootHash: `sha256:${'f'.repeat(64)}`,
      profile: 'managed_reviewer',
      reviewBinding: {
        headHash: run.headHash,
        materialHash: run.materialHash,
        storyFilesHash: run.storyFilesHash ?? '',
        promptHash: run.promptHash,
        envelopeId: run.envelopeId ?? null,
      },
    }), {
      launchWorker: async request => {
        setTimeout(() => {
          void runManagedHostRunWorker(request, {
            runner: async () => ({
              stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
              finalAssistantResult: finalEnvelopeFor(delayedClaimReviewRunId),
              finalAssistantResultCount: 1,
              finalAssistantResultTruncated: false,
            }),
          }).catch(error => {
            delayedClaimWorkerError = error;
          }).finally(() => {
            resolveDelayedClaimWorker?.();
          });
        }, MANAGED_REVIEW_NESTED_CLAIM_DELAY_MS);
        return { pid: process.pid };
      },
      workerCapabilityTransport: 'descriptor',
      claimTimeoutMs: MANAGED_REVIEW_DESCRIPTOR_CLAIM_TIMEOUT_MS,
      claimPollMs: 10,
    });

await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: delayedClaimRun.runId })).run.terminal !== null,
      'aggregate-pressure delayed descriptor worker did not reach terminal', MANAGED_REVIEW_DESCRIPTOR_DEADLINE_MS);

await delayedClaimWorkerFinished;

assert.equal(delayedClaimWorkerError, null,
      'aggregate-pressure delayed descriptor worker must claim and settle without an execution error');

const delayedClaimStatus = await getManagedHostRunStatus({ root: context.root, runId: delayedClaimRun.runId });

assert.equal(delayedClaimStatus.run.terminal?.state, 'completed',
      `aggregate-pressure delayed descriptor worker reaches completed rather than worker_claim_timeout: ${delayedClaimStatus.run.terminal?.reason}`);

let compatibilityProviderEnv: NodeJS.ProcessEnv | null = null;

const compatibilityRaceRun = await submitProposalRace(
      reviewRunId => async plan => {
        compatibilityProviderEnv = { ...plan.env };
        return {
          stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
          finalAssistantResult: finalEnvelopeFor(reviewRunId),
          finalAssistantResultCount: 1,
          finalAssistantResultTruncated: false,
        };
      },
      ({ runId, reviewRunId }) => {
        writeManagedReviewEvidenceProposal({
          root: context.root,
          runId,
          environment: compatibilityProviderEnv!,
          proposal: {
            storyId: STORY_ID,
            providerAgent: LANE,
            lane: LANE,
            reviewRunId,
            conclusion: 'pass',
            note: 'Compatibility proposal won exactly after the final-result pre-read.',
            ...managedReadEvidence(context.root),
          },
        });
      },
    );

await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: compatibilityRaceRun.runId })).run.terminal !== null,
      'compatibility proposal race run did not reach terminal');

const compatibilityRaceReceipt = managedHostRunReceipt(context.root, compatibilityRaceRun.runId);

assert.equal(compatibilityRaceReceipt.state, 'completed',
      'a valid compatibility proposal that wins the final-result write race converges to one completed terminal');

assert.equal(
      readManagedReviewEvidenceProposal(context.root, compatibilityRaceRun.runId)?.note,
      'Compatibility proposal won exactly after the final-result pre-read.',
      'the immutable compatibility proposal, rather than the losing final result, is sealed into the terminal binding',
    );

assert.match(
      handlers.managed_review_evidence_import({ runId: compatibilityRaceRun.runId, receiptId: compatibilityRaceReceipt.receiptId }),
      /Managed review evidence imported/,
      'the completed race winner remains importable through the exact receipt binding',
    );

store.writeReviewPasses(STORY_ID, {
      passes: store.readReviewPasses(STORY_ID).passes.filter(
        pass => pass.managedEvidenceBinding?.receiptId !== compatibilityRaceReceipt.receiptId,
      ),
    });

const corruptCompatibilityRaceRun = await submitProposalRace(
      reviewRunId => async () => ({
        stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
        finalAssistantResult: finalEnvelopeFor(reviewRunId),
        finalAssistantResultCount: 1,
        finalAssistantResultTruncated: false,
      }),
      ({ runId }) => writeFileSync(join(
        managedHostRunDirectory(context.root, runId),
        'evidence-proposal.json',
      ), '{corrupted'),
    );

await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: corruptCompatibilityRaceRun.runId })).run.terminal !== null,
      'corrupt compatibility proposal race run did not reach terminal');

const corruptCompatibilityRaceReceipt = managedHostRunReceipt(context.root, corruptCompatibilityRaceRun.runId);

const corruptCompatibilityRaceStatus = await getManagedHostRunStatus({ root: context.root, runId: corruptCompatibilityRaceRun.runId });

assert.equal(corruptCompatibilityRaceReceipt.state, 'failed',
      'a corrupted proposal cannot be mistaken for the valid immutable race winner');

assert.match(corruptCompatibilityRaceStatus.run.terminal?.reason ?? '', /^managed_review_final_result_invalid:/,
      'a corrupt competing proposal retains fail-closed final-result semantics');

const missingProposalRun = await submitProposalRace(
      reviewRunId => async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' }),
    );

await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: missingProposalRun.runId })).run.terminal !== null,
      'missing proposal control run did not reach terminal');

const missingProposalReceipt = managedHostRunReceipt(context.root, missingProposalRun.runId);

const missingProposalStatus = await getManagedHostRunStatus({ root: context.root, runId: missingProposalRun.runId });

assert.equal(missingProposalReceipt.state, 'failed', 'a nonexistent proposal remains fail-closed');

assert.match(missingProposalStatus.run.terminal?.reason ?? '', /^managed_review_final_result_invalid:managed_review_final_result_missing$/,
      'the race recovery cannot turn a missing proposal into a completed terminal');

return Object.defineProperties(context, {
  brokerKeys: { enumerable: true, get: () => brokerKeys },
  store: { enumerable: true, get: () => store },
  run: { enumerable: true, get: () => run },
  nativeDispatch: { enumerable: true, get: () => nativeDispatch },
  attemptSequence: { enumerable: true, get: () => attemptSequence, set: (value: typeof attemptSequence) => { attemptSequence = value; } },
  newAttempt: { enumerable: true, get: () => newAttempt },
  preEnvelopeRun: { enumerable: true, get: () => preEnvelopeRun },
  mixedLineage: { enumerable: true, get: () => mixedLineage },
  invocationClaims: { enumerable: true, get: () => invocationClaims },
  brokerAttestation: { enumerable: true, get: () => brokerAttestation },
  deliveredPrompt: { enumerable: true, get: () => deliveredPrompt, set: (value: typeof deliveredPrompt) => { deliveredPrompt = value; } },
  deliveredEnvironment: { enumerable: true, get: () => deliveredEnvironment, set: (value: typeof deliveredEnvironment) => { deliveredEnvironment = value; } },
  deliveredArgv: { enumerable: true, get: () => deliveredArgv, set: (value: typeof deliveredArgv) => { deliveredArgv = value; } },
  proposalRaceReady: { enumerable: true, get: () => proposalRaceReady, set: (value: typeof proposalRaceReady) => { proposalRaceReady = value; } },
  releaseTerminal: { enumerable: true, get: () => releaseTerminal, set: (value: typeof releaseTerminal) => { releaseTerminal = value; } },
  terminalGate: { enumerable: true, get: () => terminalGate },
  runner: { enumerable: true, get: () => runner },
  hostHandlers: { enumerable: true, get: () => hostHandlers },
  managedSelectionRequest: { enumerable: true, get: () => managedSelectionRequest },
  detached: { enumerable: true, get: () => detached },
  submitted: { enumerable: true, get: () => submitted },
  codexModelIndex: { enumerable: true, get: () => codexModelIndex },
  codexReasoningIndex: { enumerable: true, get: () => codexReasoningIndex },
  importBarrier: { enumerable: true, get: () => importBarrier },
  importWorkers: { enumerable: true, get: () => importWorkers },
  receipt: { enumerable: true, get: () => receipt },
  selectedRunBinding: { enumerable: true, get: () => selectedRunBinding },
  selectedReceipt: { enumerable: true, get: () => selectedReceipt },
  selectedResult: { enumerable: true, get: () => selectedResult },
  concurrentImportResults: { enumerable: true, get: () => concurrentImportResults },
  handlers: { enumerable: true, get: () => handlers },
  assertSelectedEvaluatorMutation: { enumerable: true, get: () => assertSelectedEvaluatorMutation },
  finalResultReviewRunId: { enumerable: true, get: () => finalResultReviewRunId },
  finalEnvelope: { enumerable: true, get: () => finalEnvelope },
  codexMultiMessageRunner: { enumerable: true, get: () => codexMultiMessageRunner },
  finalResultRun: { enumerable: true, get: () => finalResultRun },
  finalResultReceipt: { enumerable: true, get: () => finalResultReceipt },
  finalEnvelopeFor: { enumerable: true, get: () => finalEnvelopeFor },
  submitProposalRace: { enumerable: true, get: () => submitProposalRace },
  delayedClaimReviewRunId: { enumerable: true, get: () => delayedClaimReviewRunId },
  delayedClaimWorkerError: { enumerable: true, get: () => delayedClaimWorkerError, set: (value: typeof delayedClaimWorkerError) => { delayedClaimWorkerError = value; } },
  resolveDelayedClaimWorker: { enumerable: true, get: () => resolveDelayedClaimWorker, set: (value: typeof resolveDelayedClaimWorker) => { resolveDelayedClaimWorker = value; } },
  delayedClaimWorkerFinished: { enumerable: true, get: () => delayedClaimWorkerFinished },
  delayedClaimRun: { enumerable: true, get: () => delayedClaimRun },
  delayedClaimStatus: { enumerable: true, get: () => delayedClaimStatus },
  compatibilityProviderEnv: { enumerable: true, get: () => compatibilityProviderEnv, set: (value: typeof compatibilityProviderEnv) => { compatibilityProviderEnv = value; } },
  compatibilityRaceRun: { enumerable: true, get: () => compatibilityRaceRun },
  compatibilityRaceReceipt: { enumerable: true, get: () => compatibilityRaceReceipt },
  corruptCompatibilityRaceRun: { enumerable: true, get: () => corruptCompatibilityRaceRun },
  corruptCompatibilityRaceReceipt: { enumerable: true, get: () => corruptCompatibilityRaceReceipt },
  corruptCompatibilityRaceStatus: { enumerable: true, get: () => corruptCompatibilityRaceStatus },
  missingProposalRun: { enumerable: true, get: () => missingProposalRun },
  missingProposalReceipt: { enumerable: true, get: () => missingProposalReceipt },
  missingProposalStatus: { enumerable: true, get: () => missingProposalStatus },
}) as typeof context & {
  readonly brokerKeys: typeof brokerKeys;
  readonly store: typeof store;
  readonly run: typeof run;
  readonly nativeDispatch: typeof nativeDispatch;
  attemptSequence: typeof attemptSequence;
  readonly newAttempt: typeof newAttempt;
  readonly preEnvelopeRun: typeof preEnvelopeRun;
  readonly mixedLineage: typeof mixedLineage;
  readonly invocationClaims: typeof invocationClaims;
  readonly brokerAttestation: typeof brokerAttestation;
  deliveredPrompt: typeof deliveredPrompt;
  deliveredEnvironment: typeof deliveredEnvironment;
  deliveredArgv: typeof deliveredArgv;
  proposalRaceReady: typeof proposalRaceReady;
  releaseTerminal: typeof releaseTerminal;
  readonly terminalGate: typeof terminalGate;
  readonly runner: typeof runner;
  readonly hostHandlers: typeof hostHandlers;
  readonly managedSelectionRequest: typeof managedSelectionRequest;
  readonly detached: typeof detached;
  readonly submitted: typeof submitted;
  readonly codexModelIndex: typeof codexModelIndex;
  readonly codexReasoningIndex: typeof codexReasoningIndex;
  readonly importBarrier: typeof importBarrier;
  readonly importWorkers: typeof importWorkers;
  readonly receipt: typeof receipt;
  readonly selectedRunBinding: typeof selectedRunBinding;
  readonly selectedReceipt: typeof selectedReceipt;
  readonly selectedResult: typeof selectedResult;
  readonly concurrentImportResults: typeof concurrentImportResults;
  readonly handlers: typeof handlers;
  readonly assertSelectedEvaluatorMutation: typeof assertSelectedEvaluatorMutation;
  readonly finalResultReviewRunId: typeof finalResultReviewRunId;
  readonly finalEnvelope: typeof finalEnvelope;
  readonly codexMultiMessageRunner: typeof codexMultiMessageRunner;
  readonly finalResultRun: typeof finalResultRun;
  readonly finalResultReceipt: typeof finalResultReceipt;
  readonly finalEnvelopeFor: typeof finalEnvelopeFor;
  readonly submitProposalRace: typeof submitProposalRace;
  readonly delayedClaimReviewRunId: typeof delayedClaimReviewRunId;
  delayedClaimWorkerError: typeof delayedClaimWorkerError;
  resolveDelayedClaimWorker: typeof resolveDelayedClaimWorker;
  readonly delayedClaimWorkerFinished: typeof delayedClaimWorkerFinished;
  readonly delayedClaimRun: typeof delayedClaimRun;
  readonly delayedClaimStatus: typeof delayedClaimStatus;
  compatibilityProviderEnv: typeof compatibilityProviderEnv;
  readonly compatibilityRaceRun: typeof compatibilityRaceRun;
  readonly compatibilityRaceReceipt: typeof compatibilityRaceReceipt;
  readonly corruptCompatibilityRaceRun: typeof corruptCompatibilityRaceRun;
  readonly corruptCompatibilityRaceReceipt: typeof corruptCompatibilityRaceReceipt;
  readonly corruptCompatibilityRaceStatus: typeof corruptCompatibilityRaceStatus;
  readonly missingProposalRun: typeof missingProposalRun;
  readonly missingProposalReceipt: typeof missingProposalReceipt;
  readonly missingProposalStatus: typeof missingProposalStatus;
};
}
