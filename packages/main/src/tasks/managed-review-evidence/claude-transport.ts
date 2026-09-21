import { withManagedFixturePrompt } from './prompt-fixture.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import { resetConfigCache } from "../../core/config.js";

import { PROOF_OR_STOP_DIR } from "../../core/proof-or-stop-paths.js";



import { cancelManagedHostRun, managedHostRunDirectory, managedHostRunReceipt, getManagedHostRunStatus, readManagedReviewEvidenceProposal, readManagedHostRunResult, readManagedHostRunBinding, signManagedReviewProposalInvocation, submitManagedHostRun, writeManagedReviewEvidenceProposal } from "../../core/managed-host-run.js";
import { buildManagedReviewerPrompt, verifyManagedReviewEvidence, type ManagedReviewExpectedBinding } from "../../core/managed-review-evidence.js";












import { defaultHostRunRunner, type HostRunRunner } from "../../core/host-run.js";

import { createFindingHandlers } from "../../handlers/finding.js";

import { createManagedReviewEvidenceHandlers } from "../../handlers/managed-review-evidence.js";
import { createHostRunHandlers, type HostRunDetachResult } from "../../handlers/host-run.js";
import { REQUESTED_CLAUDE_MODEL, REQUESTED_CLAUDE_REASONING, REVIEW_RUN_ID, STORY_ID, LANE, MANAGED_REVIEW_FIXTURE_DEADLINE_MS, withHostOwnedMutationEnv, SELF, CLI, MANAGED_REVIEW_DESCRIPTOR_DEADLINE_MS, MANAGED_REVIEW_DESCRIPTOR_CLAIM_TIMEOUT_MS } from "./environment.js";
import { eventually, seedReviewStory, managedReadEvidence, waitForExit } from "./fixtures.js";
import { runManagedProposalCliWithAttestation } from "./transport-workers.js";
import type { runPhase as previousPhase } from './codex-transport.js';
export async function runPhase(context: NonNullable<Awaited<ReturnType<typeof previousPhase>>>) {

let claudePromptFile: string | null = null;

const previousWorkerCapabilityFd = process.env.LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD;

process.env.LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD = '3';

const claudeManagedRun = await createHostRunHandlers(
      { store: context.store, root: context.root, scanRoot: join(context.root, 'packages/main') },
      { runner: plan => {
        claudePromptFile = plan.promptFile ?? null;
        assert.equal(plan.command, 'claude');
        assert.equal(plan.env.LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD, undefined,
          'worker descriptor capability metadata is not inherited as ordinary provider authority');
        assert.ok(claudePromptFile && !isAbsolute(relative(plan.cwd, claudePromptFile))
          && !relative(plan.cwd, claudePromptFile).split(/[\\/]/).includes('..'),
        'public managed Claude prompt is inside the exact provider cwd');
        assert.equal(statSync(claudePromptFile).mode & 0o777, 0o600, 'public managed Claude prompt is mode 0600');
        assert.match(readFileSync(claudePromptFile, 'utf8'), /BEGIN MANAGED REVIEW EVIDENCE PROTOCOL/,
          'public managed Claude prompt carries the authoritative review protocol');
        assert.equal(plan.argv.includes(readFileSync(claudePromptFile, 'utf8')), false, 'managed prompt plaintext is absent from Claude argv');
        assert.deepEqual(
          plan.argv.slice(plan.argv.indexOf('--permission-mode'), plan.argv.indexOf('--permission-mode') + 2),
          ['--permission-mode', 'bypassPermissions'],
          'public managed Claude launch cannot block on interactive tool approval',
        );
        const schemaIndex = plan.argv.indexOf('--json-schema');
        assert.ok(schemaIndex >= 0 && typeof plan.argv[schemaIndex + 1] === 'string',
          'public managed Claude launch supplies its bounded structured-output schema');
        const modelIndex = plan.argv.indexOf('--model');
        const effortIndex = plan.argv.indexOf('--effort');
        assert.deepEqual(plan.argv.slice(modelIndex, modelIndex + 2), ['--model', REQUESTED_CLAUDE_MODEL],
          'managed review model selection reaches the exact Claude invocation');
        assert.deepEqual(plan.argv.slice(effortIndex, effortIndex + 2), ['--effort', REQUESTED_CLAUDE_REASONING],
          'managed review reasoning selection reaches the exact Claude invocation');
        assert.deepEqual(plan.argv, [
          '--print', '--verbose', '--output-format=stream-json',
          '--model', REQUESTED_CLAUDE_MODEL,
          '--effort', REQUESTED_CLAUDE_REASONING,
          '--permission-mode', 'bypassPermissions',
          '--json-schema', plan.argv[schemaIndex + 1]!,
          claudePromptFile,
        ], 'managed Claude model selection preserves the complete canonical argv');
        const fencedProse = `Review complete.\n\`\`\`json\n${context.finalEnvelopeFor(REVIEW_RUN_ID)}\n\`\`\``;
        return defaultHostRunRunner({
          ...plan,
          command: process.execPath,
          argv: ['-e', `process.stdout.write(${JSON.stringify(`${JSON.stringify({
            type: 'result',
            subtype: 'success',
            result: fencedProse,
            structured_output: JSON.parse(context.finalEnvelopeFor(REVIEW_RUN_ID)),
          })}\n`)})`],
        });
      } },
    ).host_run({
      host: 'claude', storyId: STORY_ID, agentType: LANE, reviewRunId: REVIEW_RUN_ID, lane: LANE,
      model: REQUESTED_CLAUDE_MODEL, reasoningEffort: REQUESTED_CLAUDE_REASONING,
      managedReview: true, detach: true, deadlineMs: 5_000, json: true,
    } as Parameters<ReturnType<typeof createHostRunHandlers>['host_run']>[0] & {
      model: string;
      reasoningEffort: string;
    }) as HostRunDetachResult;

await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: claudeManagedRun.run.runId })).run.terminal !== null,
      'public managed Claude transport did not reach terminal');

assert.ok(claudePromptFile);

assert.equal(existsSync(claudePromptFile!), false, 'public managed Claude prompt is removed after provider settlement');

const claudeManagedReceipt = managedHostRunReceipt(context.root, claudeManagedRun.run.runId);

assert.equal(claudeManagedReceipt.state, 'completed', 'Claude final proposal retains strict managed terminal semantics');

assert.match(claudeManagedReceipt.evidenceProposalDigest ?? '', /^sha256:/);

assert.deepEqual(
      [(claudeManagedReceipt as typeof claudeManagedReceipt & { model?: string }).model,
        (claudeManagedReceipt as typeof claudeManagedReceipt & { reasoningEffort?: string }).reasoningEffort],
      [REQUESTED_CLAUDE_MODEL, REQUESTED_CLAUDE_REASONING],
      'Claude managed receipt seals the exact launched model selection',
    );

assert.match(
      context.handlers.managed_review_evidence_import({ runId: claudeManagedRun.run.runId, receiptId: claudeManagedReceipt.receiptId }),
      /Managed review evidence imported/,
      'public managed Claude final proposal is exactly importable',
    );

context.store.writeReviewPasses(STORY_ID, {
      passes: context.store.readReviewPasses(STORY_ID).passes.filter(
        pass => pass.managedEvidenceBinding?.receiptId !== claudeManagedReceipt.receiptId,
      ),
    });

if (previousWorkerCapabilityFd === undefined) delete process.env.LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD;
    else process.env.LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD = previousWorkerCapabilityFd;

const findingsBeforeLifecycleCase = structuredClone(context.store.readFindings(STORY_ID));

{
      const root = mkdtempSync(join(tmpdir(), 'managed-finding-lifecycle-'));
      try {
      const {store, run} = seedReviewStory(root, context.brokerKeys.publicKey);
      const handlers = createManagedReviewEvidenceHandlers({store, root, scanRoot: join(root, 'packages/main')});
    const findingsFinalReviewRunId = REVIEW_RUN_ID;
    const findingsExplanation = 'Provider explanation remains diagnostic and cannot become a formal finding or evidence field.';
    const findingsEnvelope = JSON.stringify({
      schemaVersion: 'lattice.managed_review_final_proposal.v1',
      storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: findingsFinalReviewRunId,
      ...managedReadEvidence(root),
      conclusion: 'findings',
      note: findingsExplanation,
      findings: [{
        desc: 'The provider found one exact managed-review defect.',
        severity: 'high',
        category: 'adversarial',
        files: ['packages/main/src/example.ts'],
        evidenceState: 'verified',
      }],
    });
    const findingsRun = await createHostRunHandlers(
      { store, root, scanRoot: join(root, 'packages/main') },
      { runner: async () => ({
        stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
        finalAssistantResult: findingsEnvelope,
        finalAssistantResultCount: 1,
        finalAssistantResultTruncated: false,
      }) },
    ).host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: findingsFinalReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: findingsRun.run.runId })).run.terminal !== null,
      'findings-with-explanation final result did not reach terminal');
    const findingsReceipt = managedHostRunReceipt(root, findingsRun.run.runId);
    assert.equal(findingsReceipt.state, 'completed', 'strict findings plus optional explanation complete the managed run');
    const findingsProposal = readManagedReviewEvidenceProposal(root, findingsRun.run.runId);
    assert.equal(findingsProposal?.conclusion, 'findings');
    assert.equal(findingsProposal?.findings?.length, 1, 'only the strict provider finding enters the immutable proposal');
    assert.equal(findingsProposal?.findings?.[0]?.desc, 'The provider found one exact managed-review defect.');
    assert.equal(findingsProposal?.note, undefined,
      'the optional findings explanation is deliberately discarded before formal proposal persistence');
    assert.equal(JSON.stringify(findingsProposal).includes(findingsExplanation), false,
      'diagnostic explanation bytes never become formal finding/proposal evidence');

    // B-137a:F-100 regression. The authorship digest once compared the LIVE
    // finding status against a hardcoded 'open' on the proposal side, so
    // finding_resolve (which mutates status in place) invalidated the finding's
    // OWN receipt: managed_receipt_invalid is absent from
    // SUPERSEDED_PASS_ISSUE_CODES, so it reached evidenceState.invalid and
    // machine.ts blocked REVIEW->TEST before the severity filter -- resolving a
    // managed finding deadlocked the gate at any severity. Import the finding,
    // then walk it through BOTH terminal lifecycle transitions and assert the
    // receipt survives each one. Re-pinning the literal makes this fail.
    const f100ImportOutput = handlers.managed_review_evidence_import({
      runId: findingsRun.run.runId,
      receiptId: findingsReceipt.receiptId,
    });
    assert.match(String(f100ImportOutput), /Managed review evidence imported/,
      'F-100 fixture: the provider-authored finding imports cleanly');
    const f100Imported = store.readFindings(STORY_ID).findings.find(
      finding => finding.managedEvidenceBinding?.receiptId === findingsReceipt.receiptId,
    );
    assert.ok(f100Imported, 'F-100 fixture: the imported managed finding is retrievable');
    const f100ManagedBinding = readManagedHostRunBinding(root, findingsRun.run.runId);
    const f100Expected: ManagedReviewExpectedBinding = {
      providerHost: f100ManagedBinding.host,
      model: f100ManagedBinding.model ?? null,
      reasoningEffort: f100ManagedBinding.reasoningEffort ?? null,
      headHash: run.headHash,
      materialHash: run.materialHash,
      storyFilesHash: run.storyFilesHash ?? '',
      promptHash: run.promptHash,
      envelopeId: run.envelopeId ?? null,
      managedPromptDigest: f100ManagedBinding.promptDigest,
    };
    const verifyF100 = (label: string) => {
      const current = store.readFindings(STORY_ID).findings.find(finding => finding.id === f100Imported!.id);
      assert.ok(current, `F-100 ${label}: finding still present`);
      const verification = verifyManagedReviewEvidence({
        root,
        storyId: STORY_ID,
        agent: current!.agent ?? LANE,
        reviewRunId: current!.reviewRunId ?? findingsFinalReviewRunId,
        lane: LANE,
        binding: current!.managedEvidenceBinding!,
        expected: f100Expected,
        evidence: { kind: 'finding', finding: current! },
      });
      assert.equal(verification.valid, true,
        `F-100 ${label}: the managed receipt must stay valid (reason=${verification.reason ?? 'none'})`);
      for (const rejectedExpected of [
        { ...f100Expected, model: null, reasoningEffort: null },
        { ...f100Expected, model: 'different-model' },
        { ...f100Expected, reasoningEffort: 'low' as const },
      ]) {
        assert.equal(verifyManagedReviewEvidence({
          root, storyId: STORY_ID, agent: current!.agent ?? LANE,
          reviewRunId: current!.reviewRunId ?? findingsFinalReviewRunId,
          lane: LANE, binding: current!.managedEvidenceBinding!,
          expected: rejectedExpected, evidence: { kind: 'finding', finding: current! },
        }).valid, false, `F-100 ${label}: omitted or mismatched model selection must fail closed`);
      }
    };
    verifyF100('as imported (status=open)');
    const f100Findings = createFindingHandlers({ store, root, scanRoot: join(root, 'packages/main') });
    // Host-owned finding_resolve is not a reviewer mutation. A leaked
    // PROOF_OR_STOP_AGENT from the managed-review boundary must be dropped first.
    // B-137a main-merge fix: this used the RETIRED LATTICE_* spellings, but
    // brandEnvNames() returns a canonical-only tuple, so readBrandEnv never read
    // them -- the guard could not fire and the negative assertion silently
    // stopped testing anything. Use the canonical names the guard actually reads.
    const previousAgent = process.env.PROOF_OR_STOP_AGENT;
    const previousRole = process.env.PROOF_OR_STOP_ACTIVITY_ROLE;
    process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-review-test-coverage';
    process.env.PROOF_OR_STOP_ACTIVITY_ROLE = 'proof-or-stop-review-test-coverage';
    try {
      assert.throws(
        () => f100Findings.finding_resolve({
          storyId: STORY_ID,
          findingId: f100Imported!.id,
          resolution: 'must not resolve under leaked reviewer dispatch authority',
        }),
        /agent_dispatch_mutation_denied/,
        'leaked PROOF_OR_STOP_AGENT must not reach host-owned finding_resolve',
      );
      assert.equal(
        store.readFindings(STORY_ID).findings.find(finding => finding.id === f100Imported!.id)?.status,
        'open',
        'denied finding_resolve must leave the managed finding open',
      );
      withHostOwnedMutationEnv(() => {
        assert.equal(process.env.PROOF_OR_STOP_AGENT, undefined, 'host-owned finding_resolve drops PROOF_OR_STOP_AGENT');
        assert.equal(process.env.PROOF_OR_STOP_ACTIVITY_ROLE, undefined, 'host-owned finding_resolve drops PROOF_OR_STOP_ACTIVITY_ROLE');
        f100Findings.finding_resolve({
          storyId: STORY_ID,
          findingId: f100Imported!.id,
          resolution: 'F-100 regression fixture: resolved to prove the managed receipt survives a host-owned lifecycle transition.',
        });
      });
    } finally {
      if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
      else process.env.PROOF_OR_STOP_AGENT = previousAgent;
      if (previousRole === undefined) delete process.env.PROOF_OR_STOP_ACTIVITY_ROLE;
      else process.env.PROOF_OR_STOP_ACTIVITY_ROLE = previousRole;
    }
    assert.equal(
      store.readFindings(STORY_ID).findings.find(finding => finding.id === f100Imported!.id)?.status,
      'resolved',
      'F-100 fixture: finding_resolve actually moved the lifecycle status',
    );
    verifyF100('after finding_resolve (status=resolved)');
    // B-137a:F-120: the runtime artifact reads after the receipt/proposal guard
    // are now inside the same fail-closed try/catch (see
    // managed-review-evidence.ts). This suite deliberately carries NO negative
    // fixture for it, because none is constructible: managedHostRunReceipt --
    // which runs inside the FIRST guard -- already reads terminal.json and
    // seal-validates spec.json / evidence-proposal.json / the binding, so every
    // corruption or removal of those artifacts is caught before the second block
    // executes, and deleting the whole run directory is caught there too
    // (verified empirically: each attempt refused with 'artifact read failed',
    // never 'runtime artifact read failed').
    //
    // The second guard is therefore defense-in-depth against a future reordering
    // or a partially written directory, NOT a currently reachable path -- so it
    // is asserted by inspection, not by a passing negative control. Recording
    // that honestly, rather than shipping a fixture that green-lights the first
    // guard while appearing to cover the second.
    const f120Verification = verifyManagedReviewEvidence({
      root,
      storyId: STORY_ID,
      agent: LANE,
      reviewRunId: findingsFinalReviewRunId,
      lane: LANE,
      binding: f100Imported!.managedEvidenceBinding!,
      expected: {
        providerHost: readManagedHostRunBinding(root, findingsRun.run.runId).host,
        model: f100ManagedBinding.model ?? null,
        reasoningEffort: f100ManagedBinding.reasoningEffort ?? null,
        headHash: run.headHash,
        materialHash: run.materialHash,
        storyFilesHash: run.storyFilesHash ?? '',
        promptHash: run.promptHash,
        envelopeId: run.envelopeId ?? null,
        managedPromptDigest: readManagedHostRunBinding(root, findingsRun.run.runId).promptDigest,
      },
      evidence: { kind: 'finding', finding: f100Imported! },
    });
    assert.equal(f120Verification.valid, true,
      `F-120: an intact managed run must still verify cleanly (reason=${f120Verification.reason ?? 'none'})`);

      } finally { resetConfigCache(); rmSync(root, {recursive: true, force: true}); }
    }

assert.deepEqual(context.store.readFindings(STORY_ID), findingsBeforeLifecycleCase,
      'independent finding lifecycle case leaves the main fixture unchanged');

for (const control of [
      { name: 'missing', result: {} },
      { name: 'malformed', result: { finalAssistantResult: '{', finalAssistantResultCount: 1, finalAssistantResultTruncated: false } },
      { name: 'multiple', result: { finalAssistantResult: context.finalEnvelope, finalAssistantResultCount: 2, finalAssistantResultTruncated: false } },
      { name: 'oversize', result: { finalAssistantResult: null, finalAssistantResultCount: 1, finalAssistantResultTruncated: true } },
    ] as const) {
      const controlledReviewRunId = context.newAttempt(`final-control-${control.name}`).reviewRunId;
      const controlled = await createHostRunHandlers(
        { store: context.store, root: context.root, scanRoot: join(context.root, 'packages/main') },
        { runner: async () => ({
          stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
          ...control.result,
        }) },
      ).host_run({
        host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: controlledReviewRunId, lane: LANE,
        managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
      }) as HostRunDetachResult;
      await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: controlled.run.runId })).run.terminal !== null,
        `${control.name} final-result control did not reach terminal`);
      const controlledStatus = await getManagedHostRunStatus({ root: context.root, runId: controlled.run.runId });
      const controlledReceipt = managedHostRunReceipt(context.root, controlled.run.runId);
      assert.equal(controlledReceipt.state, 'failed', `${control.name} final result fails closed`);
      assert.match(controlledStatus.run.terminal?.reason ?? '', new RegExp(`managed_review_final_result_(?:invalid:managed_review_final_result_)?${control.name}`));
      assert.equal(controlledReceipt.evidenceProposalDigest, null, `${control.name} final result cannot mint proposal evidence`);
    }

if (!context.evaluatorMutationBoundary) {
    const sanitizedReviewRunId = context.newAttempt('sanitized').reviewRunId;
    let sanitizedAttestation: ReturnType<typeof signManagedReviewProposalInvocation> | null = null;
    const sanitizedToolRunner: HostRunRunner = async plan => {
      const gatePath = join(context.root, `${plan.env.LATTICE_MANAGED_HOST_RUN_ID}-sanitized-tool.go`);
      const child = spawn(process.execPath, [SELF, '--sanitized-proposal-tool', context.root, gatePath, sanitizedReviewRunId], {
        cwd: context.root,
        detached: true,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      });
      assert.ok(child.pid);
      const providerIdentity = {
        pid: child.pid!,
        pgid: child.pid!,
        spawnedAt: new Date().toISOString(),
        startFingerprint: 'sanitized-provider-start-fingerprint',
        processGroupIsolated: true as const,
      };
      plan.onSpawn?.(providerIdentity);
      const privateKey = plan.env.LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY!;
      const attestation = signManagedReviewProposalInvocation({
        schemaVersion: 'lattice.managed_review_proposal_invocation.v1',
        runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!,
        storyId: STORY_ID,
        providerAgent: LANE,
        lane: LANE,
        reviewRunId: sanitizedReviewRunId,
        providerIdentity,
        invocationNonce: randomUUID(),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }, privateKey);
      sanitizedAttestation = attestation;
      const descriptor = child.stdio[3] as NodeJS.WritableStream;
      descriptor.write(`${JSON.stringify(attestation)}\n`);
      descriptor.end();
      writeFileSync(gatePath, 'go');
      let stdout = '';
      let stderr = '';
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', chunk => { stdout += String(chunk); });
      child.stderr!.on('data', chunk => { stderr += String(chunk); });
      const status = await waitForExit(child);
      if (status !== 0) throw new Error(`sanitized provider tool failed: ${stderr}${stdout}`);
      return {
        stdout,
        stderr,
        exitCode: status ?? 1,
        timedOut: false,
        terminalReason: status === 0 ? 'completed' : 'exit_nonzero',
        finalAssistantResult: 'Compatibility adapter already submitted its signed provider proposal.',
        finalAssistantResultCount: 1,
        finalAssistantResultTruncated: false,
      };
    };
    const sanitizedRun = await createHostRunHandlers(
      { store: context.store, root: context.root, scanRoot: join(context.root, 'packages/main') },
      { runner: sanitizedToolRunner },
    ).host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: sanitizedReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: 5_000, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: sanitizedRun.run.runId })).run.terminal !== null,
      'sanitized provider tool run did not reach terminal');
    const sanitizedStatus = await getManagedHostRunStatus({ root: context.root, runId: sanitizedRun.run.runId });
    const sanitizedReceipt = managedHostRunReceipt(context.root, sanitizedRun.run.runId);
    assert.equal(sanitizedReceipt.state, 'completed',
      `sanitized Codex-style tool environment can submit a provider proposal without inherited bearer env: ${sanitizedStatus.run.terminal?.reason}`);
    assert.match(sanitizedReceipt.evidenceProposalDigest ?? '', /^sha256:/, 'successful formal provider terminal seals its proposal');
    const sanitizedImport = context.handlers.managed_review_evidence_import({
      runId: sanitizedRun.run.runId,
      receiptId: sanitizedReceipt.receiptId,
    });
    assert.match(sanitizedImport, /Managed review evidence imported/, 'exact sanitized provider receipt is importable');
    assert.ok(sanitizedAttestation, 'sanitized provider emitted one signed invocation attestation');
    const replayedSanitizedAttestation = await runManagedProposalCliWithAttestation(context.root, {
      storyId: STORY_ID,
      providerAgent: LANE,
      lane: LANE,
      reviewRunId: sanitizedReviewRunId,
      conclusion: 'pass',
      note: 'An old provider invocation attestation cannot authorize a later write.',
      ...managedReadEvidence(context.root),
    }, sanitizedAttestation);
    assert.notEqual(replayedSanitizedAttestation.status, 0,
      'old provider attestation replay fails after its exact managed run reaches terminal');
    assert.match(`${replayedSanitizedAttestation.stderr}\n${replayedSanitizedAttestation.stdout}`,
      /proposal is accepted only while the managed provider run is active|proposal invocation attestation is invalid or already consumed/,
      'old provider attestation replay is rejected by terminal/one-shot authority');
    // Keep the existing mutation matrix isolated from this additional transport E2E.
    // The assertion above exercised the real importer; subsequent checks retain their
    // historical single managed receipt fixture.
    context.store.writeReviewPasses(STORY_ID, {
      passes: context.store.readReviewPasses(STORY_ID).passes.filter(
        pass => pass.managedEvidenceBinding?.receiptId !== sanitizedReceipt.receiptId,
      ),
    });
    }

if (!context.evaluatorMutationBoundary) {
    const descriptorReviewRun = context.newAttempt('descriptor');
    const descriptorReviewRunId = descriptorReviewRun.reviewRunId;
    const fakeBin = join(context.root, PROOF_OR_STOP_DIR, 'runtime', 'fake-provider-bin');
    mkdirSync(fakeBin, { recursive: true });
    const fakeCodex = join(fakeBin, 'codex');
    const providerProposal = JSON.stringify({
      storyId: STORY_ID,
      providerAgent: LANE,
      lane: LANE,
      reviewRunId: descriptorReviewRunId,
      conclusion: 'pass',
      note: 'Real descriptor-brokered Codex-style tool submitted this exact verdict.',
      ...managedReadEvidence(context.root),
    });
    writeFileSync(fakeCodex, `#!/bin/sh
cat >/dev/null
exec /usr/bin/env -i PATH="$PATH" LATTICE_MANAGED_REVIEW_INVOCATION_FD=3 "$LATTICE_TEST_NODE" "$LATTICE_TEST_CLI" managed_review_proposal_set '${providerProposal}'
`);
    chmodSync(fakeCodex, 0o700);
    let descriptorPrivateKey = '';
    const descriptorLauncher: import("../../core/managed-host-run.js").ManagedHostRunWorkerLauncher = request => {
      const child = spawn(process.execPath, [CLI, '--root', request.root, 'host_run_worker', JSON.stringify({ runId: request.runId })], {
        cwd: request.root,
        detached: true,
        env: {
          ...process.env,
          LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD: '3',
        },
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      });
      assert.ok(child.pid && request.proposalInvocationPrivateKey);
      descriptorPrivateKey = request.proposalInvocationPrivateKey!;
      const capabilityPipe = child.stdio[3];
      assert.ok(capabilityPipe && 'end' in capabilityPipe);
      capabilityPipe.end(request.proposalInvocationPrivateKey);
      child.unref();
      return { pid: child.pid! };
    };
    const descriptorRun = await submitManagedHostRun(withManagedFixturePrompt({
      root: context.root,
      cwd: context.root,
      host: 'codex',
      storyId: STORY_ID,
      phase: 'REVIEW',
      agentType: LANE,
      reviewRunId: descriptorReviewRunId,
      lane: LANE,
      promptText: buildManagedReviewerPrompt(context.root, context.store.readReviewRuns(STORY_ID).runs.find(candidate => candidate.reviewRunId === descriptorReviewRunId)!),
      deadlineMs: MANAGED_REVIEW_DESCRIPTOR_DEADLINE_MS,
      projectRootHash: `sha256:${'1'.repeat(64)}`,
      profile: 'managed_reviewer',
      environment: {
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        LATTICE_TEST_NODE: process.execPath,
        LATTICE_TEST_CLI: CLI,
        PROOF_OR_STOP_USAGE_LEDGER: '0',
      },
      reviewBinding: {
        headHash: descriptorReviewRun.headHash,
        materialHash: descriptorReviewRun.materialHash,
        storyFilesHash: descriptorReviewRun.storyFilesHash ?? '',
        promptHash: descriptorReviewRun.promptHash,
        envelopeId: descriptorReviewRun.envelopeId ?? null,
      },
    }), {
      launchWorker: descriptorLauncher,
      workerCapabilityTransport: 'descriptor',
      claimTimeoutMs: MANAGED_REVIEW_DESCRIPTOR_CLAIM_TIMEOUT_MS,
      claimPollMs: 10,
    });
    await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: descriptorRun.runId })).run.terminal !== null,
      'real descriptor-brokered provider did not reach terminal');
    const descriptorStatus = await getManagedHostRunStatus({ root: context.root, runId: descriptorRun.runId });
    const descriptorResult = readManagedHostRunResult(context.root, descriptorRun.runId);
    assert.equal(descriptorStatus.run.terminal?.state, 'completed',
      `real Codex-style sanitized tool env reaches a successful provider terminal: ${descriptorStatus.run.terminal?.reason}; `
      + `stderr=${descriptorResult?.stderr ?? '<no result>'}`);
    const descriptorReceipt = managedHostRunReceipt(context.root, descriptorRun.runId);
    assert.match(descriptorReceipt.evidenceProposalDigest ?? '', /^sha256:/,
      'the descriptor-brokered provider proposal is sealed into its terminal receipt');
    assert.equal(existsSync(join(managedHostRunDirectory(context.root, descriptorRun.runId), 'input.cap')), false,
      'production descriptor transport never persists its private proposal signing key');
    const persistedRunFiles = readdirSync(managedHostRunDirectory(context.root, descriptorRun.runId))
      .map(name => join(managedHostRunDirectory(context.root, descriptorRun.runId), name))
      .filter(path => statSync(path).isFile());
    assert.ok(descriptorPrivateKey.length > 0 && persistedRunFiles.every(path => !readFileSync(path).includes(descriptorPrivateKey)),
      'the worker/provider private proposal signing key appears in no durable run artifact');
    assert.match(
      context.handlers.managed_review_evidence_import({ runId: descriptorRun.runId, receiptId: descriptorReceipt.receiptId }),
      /Managed review evidence imported/,
      'the real sanitized provider proposal remains exactly importable',
    );
    context.store.writeReviewPasses(STORY_ID, {
      passes: context.store.readReviewPasses(STORY_ID).passes.filter(
        pass => pass.managedEvidenceBinding?.receiptId !== descriptorReceipt.receiptId,
      ),
    });
    }

if (!context.evaluatorMutationBoundary) {
    const previousManagedRun = process.env.LATTICE_MANAGED_HOST_RUN_ID;
    const previousAgent = process.env.PROOF_OR_STOP_AGENT;
    process.env.LATTICE_MANAGED_HOST_RUN_ID = context.submitted.runId;
    process.env.PROOF_OR_STOP_AGENT = LANE;
    try {
      const ordinaryEvidence = createFindingHandlers({ store: context.store, root: context.root, scanRoot: join(context.root, 'packages/main') });
      assert.throws(() => ordinaryEvidence.review_pass_set({
        storyId: STORY_ID,
        agent: LANE,
        reviewRunId: REVIEW_RUN_ID,
        note: 'Attempt to bypass the managed terminal receipt.',
        readManifest: { filesReadFully: ['packages/main/src/example.ts'], filesTriagedByName: [], scanEscalationReason: null },
      }), /direct final reviewer evidence is forbidden[\s\S]*final assistant result[\s\S]*managed adapter/i);
      assert.throws(() => ordinaryEvidence.finding_add({
        storyId: STORY_ID,
        agent: LANE,
        reviewRunId: REVIEW_RUN_ID,
        desc: 'Attempt to bypass the managed terminal receipt with a direct finding.',
        severity: 'high',
        category: 'adversarial',
        readManifest: { filesReadFully: ['packages/main/src/example.ts'], filesTriagedByName: [], scanEscalationReason: null },
      }), /direct final reviewer evidence is forbidden[\s\S]*final assistant result[\s\S]*managed adapter/i);
    } finally {
      if (previousManagedRun === undefined) delete process.env.LATTICE_MANAGED_HOST_RUN_ID;
      else process.env.LATTICE_MANAGED_HOST_RUN_ID = previousManagedRun;
      if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
      else process.env.PROOF_OR_STOP_AGENT = previousAgent;
    }

    assert.throws(
      () => (context.handlers.managed_review_evidence_import as (value: Record<string, unknown>) => unknown)({
        runId: context.submitted.runId,
        receiptId: context.receipt.receiptId,
        conclusion: 'findings',
      }),
      /verdict overrides are not accepted/,
      'controller must not be able to add or override proposal verdict fields',
    );
    assert.throws(
      () => context.handlers.managed_review_evidence_import({ runId: context.submitted.runId, receiptId: 'sha256:forged' }),
      /signature_invalid|producer_owned_required/,
    );

    let releasePreterminal!: () => void;
    let duplicateProposalRejected = false;
    const preterminalGate = new Promise<void>(resolve => { releasePreterminal = resolve; });
    const preterminalReviewRunId = context.newAttempt('preterminal').reviewRunId;
    const preterminalHandlers = createHostRunHandlers(
      { store: context.store, root: context.root, scanRoot: join(context.root, 'packages/main') },
      { runner: async plan => {
        const proposal = {
          storyId: STORY_ID,
          providerAgent: LANE,
          lane: LANE,
          reviewRunId: preterminalReviewRunId,
          conclusion: 'pass' as const,
          note: 'Provider proposal exists but the terminal has not been sealed yet.',
          ...managedReadEvidence(context.root),
        };
        writeManagedReviewEvidenceProposal({ root: context.root, runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!, environment: plan.env, proposal });
        try {
          writeManagedReviewEvidenceProposal({ root: context.root, runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!, environment: plan.env, proposal });
        } catch (error) {
          duplicateProposalRejected = /already has an immutable evidence proposal/.test(error instanceof Error ? error.message : String(error));
        }
        await preterminalGate;
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
      } },
    );
    const preterminal = await preterminalHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: preterminalReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => duplicateProposalRejected, 'provider proposal was not durably written before the preterminal assertion');
    assert.throws(
      () => context.handlers.managed_review_evidence_import({ runId: preterminal.run.runId, receiptId: 'sha256:not-terminal' }),
      /producer_owned_required|signature_invalid/,
      'a provider proposal before terminal must not become final evidence',
    );
    assert.equal(duplicateProposalRejected, true, 'a provider can author exactly one immutable proposal per run');
    releasePreterminal();
    await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: preterminal.run.runId })).run.state === 'completed', 'preterminal control run did not finish');

    let releaseForgery!: () => void;
    let forgedTargetEnvironment: NodeJS.ProcessEnv | null = null;
    const forgeryGate = new Promise<void>(resolve => { releaseForgery = resolve; });
    const forgeryReviewRunId = context.newAttempt('forgery').reviewRunId;
    const forgeryHandlers = createHostRunHandlers(
      { store: context.store, root: context.root, scanRoot: join(context.root, 'packages/main') },
      { runner: async plan => {
        forgedTargetEnvironment = { ...plan.env };
        await forgeryGate;
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
      } },
    );
    const forgeryRun = await forgeryHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: forgeryReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: 5_000, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => forgedTargetEnvironment !== null, 'managed provider did not receive its proposal environment');
    const forgedProposal = {
      storyId: STORY_ID,
      providerAgent: LANE,
      lane: LANE,
      reviewRunId: forgeryReviewRunId,
      conclusion: 'pass' as const,
      note: 'Authentic provider-only proposal capability control.',
      ...managedReadEvidence(context.root),
    };
    assert.throws(
      () => writeManagedReviewEvidenceProposal({
        root: context.root,
        runId: forgeryRun.run.runId,
        environment: forgedTargetEnvironment!,
        proposal: {
          ...forgedProposal,
          conclusion: 'findings',
          note: undefined,
          findings: [{
            desc: 'Provider supplied an unknown nested finding vocabulary.',
            severity: 'urgent',
            category: 'invented',
            evidenceState: 'trusted',
            files: ['packages/main/src/example.ts'],
            controllerOverride: true,
          }],
        } as unknown as Parameters<typeof writeManagedReviewEvidenceProposal>[0]['proposal'],
      }),
      /strict managed finding schema/,
      'proposal persistence rejects unknown nested severity/category/evidenceState and extra fields',
    );
    assert.throws(
      () => writeManagedReviewEvidenceProposal({
        root: context.root,
        runId: forgeryRun.run.runId,
        environment: forgedTargetEnvironment!,
        proposal: {
          ...forgedProposal,
          conclusion: 'findings',
          note: 'short one',
          findings: [{
            desc: 'Compatibility ingress must preserve the documented note minimum.',
            severity: 'high',
            category: 'adversarial',
            evidenceState: 'verified',
          }],
        },
      }),
      /diagnostic note >= 10 chars/,
      'compatibility proposal ingress rejects a trimmed findings note shorter than ten characters',
    );
    const rawSameUidProposal = spawnSync(process.execPath, [CLI, 'managed_review_proposal_set', JSON.stringify(forgedProposal)], {
      cwd: context.root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    assert.notEqual(rawSameUidProposal.status, 0,
      'same-UID raw CLI without the broker descriptor cannot submit a managed reviewer proposal');
    assert.match(`${rawSameUidProposal.stderr ?? ''}\n${rawSameUidProposal.stdout ?? ''}`,
      /match exactly one active managed reviewer|proposal capability or agent identity is missing or mismatched/,
      'same-UID raw CLI remains outside the provider invocation authority boundary');
    const detachedToolChild = spawn(process.execPath, [CLI, 'managed_review_proposal_set', JSON.stringify(forgedProposal)], {
      cwd: context.root,
      detached: true,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let detachedToolStdout = '';
    let detachedToolStderr = '';
    detachedToolChild.stdout!.setEncoding('utf8');
    detachedToolChild.stderr!.setEncoding('utf8');
    detachedToolChild.stdout!.on('data', chunk => { detachedToolStdout += String(chunk); });
    detachedToolChild.stderr!.on('data', chunk => { detachedToolStderr += String(chunk); });
    const detachedToolStatus = await waitForExit(detachedToolChild);
    assert.notEqual(detachedToolStatus, 0,
      'a provider tool moved into a different process group/session fails closed without its signed descriptor');
    assert.match(`${detachedToolStderr}\n${detachedToolStdout}`,
      /match exactly one active managed reviewer|proposal capability or agent identity is missing or mismatched/,
      'PGID fallback never authorizes an ambiguous or different-session tool process');
    for (const [name, environment] of [
      ['missing capability', { LATTICE_MANAGED_HOST_RUN_ID: forgeryRun.run.runId, PROOF_OR_STOP_AGENT: LANE }],
      ['forged capability', { LATTICE_MANAGED_HOST_RUN_ID: forgeryRun.run.runId, PROOF_OR_STOP_AGENT: LANE, LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY: 'forged-same-uid-capability' }],
      ['wrong provider agent', { ...forgedTargetEnvironment!, PROOF_OR_STOP_AGENT: 'proof-or-stop-review-concept' }],
    ] as const) {
      assert.throws(
        () => writeManagedReviewEvidenceProposal({ root: context.root, runId: forgeryRun.run.runId, environment, proposal: forgedProposal }),
        /proposal capability or agent identity is missing or mismatched/,
        `${name} cannot impersonate the active managed provider`,
      );
    }
    releaseForgery();
    await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: forgeryRun.run.runId })).run.state === 'failed', 'forgery negative-control run did not fail closed', 5_000);
    const forgeryReceipt = managedHostRunReceipt(context.root, forgeryRun.run.runId);
    assert.equal(forgeryReceipt.evidenceProposalDigest, null,
      'a managed reviewer with no trusted final result cannot seal a null-proposal success');
    assert.throws(
      () => context.handlers.managed_review_evidence_import({ runId: forgeryRun.run.runId, receiptId: forgeryReceipt.receiptId }),
      /producer_owned_required|signature_invalid/,
      'a successful terminal without an authenticated provider proposal remains inadmissible',
    );

    const failedReviewRunId = context.newAttempt('failed').reviewRunId;
    const failedHandlers = createHostRunHandlers(
      { store: context.store, root: context.root, scanRoot: join(context.root, 'packages/main') },
      { runner: async plan => {
        writeManagedReviewEvidenceProposal({
          root: context.root,
          runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!,
          environment: plan.env,
          proposal: {
            storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: failedReviewRunId,
            conclusion: 'pass', note: 'Provider proposal cannot survive a failed provider terminal.',
            ...managedReadEvidence(context.root),
          },
        });
        return { stdout: '', stderr: 'failed', exitCode: 7, timedOut: false, terminalReason: 'exit_nonzero' };
      } },
    );
    const failed = await failedHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: failedReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: failed.run.runId })).run.state === 'failed', 'failed managed reviewer did not reach terminal');
    const failedReceipt = managedHostRunReceipt(context.root, failed.run.runId);
    assert.throws(
      () => context.handlers.managed_review_evidence_import({ runId: failed.run.runId, receiptId: failedReceipt.receiptId }),
      /producer_owned_required|signature_invalid/,
      'a failed terminal must not become final reviewer evidence',
    );

    let releaseCancelled!: () => void;
    let cancelledProposalReady = false;
    const cancelledGate = new Promise<void>(resolve => { releaseCancelled = resolve; });
    const cancelledReviewRunId = context.newAttempt('cancelled').reviewRunId;
    const cancelledHandlers = createHostRunHandlers(
      { store: context.store, root: context.root, scanRoot: join(context.root, 'packages/main') },
      { runner: async plan => {
        writeManagedReviewEvidenceProposal({
          root: context.root,
          runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!,
          environment: plan.env,
          proposal: {
            storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: cancelledReviewRunId,
            conclusion: 'pass', note: 'Cancellation must defeat this otherwise authentic proposal.',
            ...managedReadEvidence(context.root),
          },
        });
        cancelledProposalReady = true;
        await cancelledGate;
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
      } },
    );
    const cancelled = await cancelledHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: cancelledReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => cancelledProposalReady, 'cancelled managed reviewer did not publish its provider proposal');
    await cancelManagedHostRun({ root: context.root, runId: cancelled.run.runId, reason: 'cancelled evidence control' });
    releaseCancelled();
    await eventually(async () => (await getManagedHostRunStatus({
      root: context.root,
      runId: cancelled.run.runId,
    })).run.state === 'cancelled', 'cancelled managed reviewer did not converge after its fenced provider returned');
    const cancelledStatus = await getManagedHostRunStatus({ root: context.root, runId: cancelled.run.runId });
    assert.equal(cancelledStatus.run.state, 'cancelled');
    const cancelledReceipt = managedHostRunReceipt(context.root, cancelled.run.runId);
    assert.throws(
      () => context.handlers.managed_review_evidence_import({ runId: cancelled.run.runId, receiptId: cancelledReceipt.receiptId }),
      /producer_owned_required|signature_invalid/,
      'a cancelled terminal cannot upgrade an authentic provider proposal into REVIEW evidence',
    );
    const timedOutReviewRunId = context.newAttempt('timedOut').reviewRunId;
    const timedOutHandlers = createHostRunHandlers(
      { store: context.store, root: context.root, scanRoot: join(context.root, 'packages/main') },
      { runner: async plan => {
        writeManagedReviewEvidenceProposal({
          root: context.root,
          runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!,
          environment: plan.env,
          proposal: {
            storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: timedOutReviewRunId,
            conclusion: 'pass', note: 'Timed-out evidence control.',
            ...managedReadEvidence(context.root),
          },
        });
        return { stdout: '', stderr: '', exitCode: 124, timedOut: true, timeoutKind: 'total_timeout', terminalReason: 'total_timeout' };
      } },
    );
    const timedOut = await timedOutHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: timedOutReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: timedOut.run.runId })).run.state === 'timed_out',
      'timed-out managed reviewer did not reach terminal truth');
    const timedOutReceipt = managedHostRunReceipt(context.root, timedOut.run.runId);
    assert.throws(
      () => context.handlers.managed_review_evidence_import({ runId: timedOut.run.runId, receiptId: timedOutReceipt.receiptId }),
      /producer_owned_required|signature_invalid/,
      'a timed_out terminal cannot upgrade an authentic provider proposal into REVIEW evidence',
    );

    let rawProposalRejected = false;
    const rawReviewRunId = context.newAttempt('raw').reviewRunId;
    const rawHandlers = createHostRunHandlers(
      { store: context.store, root: context.root, scanRoot: join(context.root, 'packages/main') },
      { runner: async plan => {
        try {
          writeManagedReviewEvidenceProposal({
            root: context.root,
            runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!,
            environment: plan.env,
            proposal: {
              storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: rawReviewRunId,
              conclusion: 'pass', note: 'Raw execution must not author formal reviewer evidence.',
              ...managedReadEvidence(context.root),
            },
          });
        } catch (error) {
          rawProposalRejected = /not a formal managed_reviewer execution/.test(error instanceof Error ? error.message : String(error));
        }
        return { stdout: 'manual raw reviewer output', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
      } },
    );
    const raw = await rawHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: rawReviewRunId, lane: LANE,
      prompt: 'manual raw reviewer prompt', detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: raw.run.runId })).run.state === 'completed', 'raw control run did not complete');
    assert.equal(rawProposalRejected, true, 'ordinary managed runs cannot author formal reviewer proposals');
    const rawReceipt = managedHostRunReceipt(context.root, raw.run.runId);
    assert.throws(
      () => context.handlers.managed_review_evidence_import({ runId: raw.run.runId, receiptId: rawReceipt.receiptId }),
      /not an exact managed_reviewer binding/,
      'ordinary/raw CLI output cannot upgrade into formal managed reviewer evidence',
    );
    }

assert.equal(context.concurrentImportResults.filter(result => /Managed review evidence imported/.test(result)).length, 1);

assert.equal(context.concurrentImportResults.filter(result => /already imported/.test(result)).length, 1,
      'real proposal/terminal/import race converges on one creator and one exact reuse');

const passes = context.store.readReviewPasses(STORY_ID).passes;

return Object.defineProperties(context, {
  claudePromptFile: { enumerable: true, get: () => claudePromptFile, set: (value: typeof claudePromptFile) => { claudePromptFile = value; } },
  previousWorkerCapabilityFd: { enumerable: true, get: () => previousWorkerCapabilityFd },
  claudeManagedRun: { enumerable: true, get: () => claudeManagedRun },
  claudeManagedReceipt: { enumerable: true, get: () => claudeManagedReceipt },
  findingsBeforeLifecycleCase: { enumerable: true, get: () => findingsBeforeLifecycleCase },
  passes: { enumerable: true, get: () => passes },
}) as typeof context & {
  claudePromptFile: typeof claudePromptFile;
  readonly previousWorkerCapabilityFd: typeof previousWorkerCapabilityFd;
  readonly claudeManagedRun: typeof claudeManagedRun;
  readonly claudeManagedReceipt: typeof claudeManagedReceipt;
  readonly findingsBeforeLifecycleCase: typeof findingsBeforeLifecycleCase;
  readonly passes: typeof passes;
};
}
