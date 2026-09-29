import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';







import { managedHostRunDirectory, managedHostRunReceipt, getManagedHostRunStatus, readManagedReviewImportSeal, readManagedHostRunBinding, writeManagedReviewEvidenceProposal } from "../../core/managed-host-run.js";
import { classifyReviewerExecutionAuthority, createManagedReviewEvidenceBinding } from "../../core/managed-review-evidence.js";




import { collectReviewerEvidenceState } from "../../core/review-run.js";

import { isFindingBlocking } from "../../core/advisory.js";




import { StoryStore } from "../../core/store.js";




import { createManagedReviewEvidenceHandlers } from "../../handlers/managed-review-evidence.js";
import { createHostRunHandlers, type HostRunDetachResult } from "../../handlers/host-run.js";
import { STORY_ID, LANE, MANAGED_REVIEW_FIXTURE_DEADLINE_MS, SELF, hostOwnedChildEnv } from "./environment.js";
import { managedReadEvidence, eventually, waitForExit } from "./fixtures.js";
import type { runPhase as previousPhase } from './native-attestation.js';
export async function runPhase(context: NonNullable<Awaited<ReturnType<typeof previousPhase>>>) {

context.store.writeReviewPasses(STORY_ID, { passes: [context.degradedPass] });

const degradedGate = collectReviewerEvidenceState(context.store, STORY_ID, context.root);

assert.ok(
      degradedGate.invalid.some(candidate => candidate.code === 'review_execution_authority_missing'),
      'the actual REVIEW gate keeps degraded-single-host local evidence out of native and managed authority paths',
    );

assert.equal(degradedGate.valid.some(candidate => candidate.id === context.degradedPass.id), false);

assert.deepEqual(classifyReviewerExecutionAuthority({
      executionMode: 'cross-provider-cli',
      assuranceLevel: 'ordinary-review',
      hasManagedEvidenceBinding: false,
    }), {
      classification: 'cross-provider-advisory-only',
      directSignedReviewAllowed: false,
      managedReceiptRequired: true,
      reviewGatePath: 'none',
    }, 'cross-provider CLI without a managed receipt remains advisory-only');

context.store.writeReviewPasses(STORY_ID, { passes: [context.originalPass] });

const findingRaceReviewRunId = context.newAttempt('findingRace').reviewRunId;

const findingHandlers = createHostRunHandlers(
      { store: context.store, root: context.root, scanRoot: join(context.root, 'packages/main') },
      { runner: async () => {
        const finalAssistantResult = JSON.stringify({
          schemaVersion: 'lattice.managed_review_final_proposal.v1',
            storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: findingRaceReviewRunId,
            conclusion: 'findings',
            findings: [{
              desc: 'packages/main/src/example.ts:1 managed provider found a blocking behavior defect',
              severity: 'high', category: 'adversarial', files: ['packages/main/src/example.ts'],
            }],
            ...managedReadEvidence(context.root),
        });
        return {
          stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
          finalAssistantResult, finalAssistantResultCount: 1, finalAssistantResultTruncated: false,
        };
      } },
    );

const findingRun = await findingHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: findingRaceReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;

await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: findingRun.run.runId })).run.state === 'completed', 'managed finding run did not complete');

const findingReceipt = managedHostRunReceipt(context.root, findingRun.run.runId);

const secondFindingRun = await findingHandlers.host_run({
      host: 'claude', storyId: STORY_ID, agentType: LANE, reviewRunId: findingRaceReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;

await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: secondFindingRun.run.runId })).run.state === 'completed',
      'second managed finding run did not complete');

const secondFindingReceipt = managedHostRunReceipt(context.root, secondFindingRun.run.runId);

const findingStartBarrier = join(context.root, 'distinct-finding-import-start.go');

const findingPersistBarrier = join(context.root, 'distinct-finding-import-persist.go');

const findingImportWorkers = [
      { runId: findingRun.run.runId, receiptId: findingReceipt.receiptId },
      { runId: secondFindingRun.run.runId, receiptId: secondFindingReceipt.receiptId },
    ].map((candidate, index) => {
      const readyPath = join(context.root, `distinct-finding-worker-${index}.ready`);
      const resultPath = join(context.root, `distinct-finding-worker-${index}.result`);
      const afterReadPath = join(context.root, `distinct-finding-worker-${index}.after-read`);
      const child = spawn(process.execPath, [
        SELF, '--import-worker', context.root, candidate.runId, candidate.receiptId,
        readyPath, findingStartBarrier, resultPath, afterReadPath, findingPersistBarrier,
      ], { cwd: context.root, env: hostOwnedChildEnv(), stdio: 'ignore' });
      return { child, exit: waitForExit(child), readyPath, afterReadPath };
    });

await eventually(async () => findingImportWorkers.every(worker => existsSync(worker.readyPath)),
      'different-receipt finding workers did not reach the start barrier');

writeFileSync(findingStartBarrier, 'start');

await eventually(async () => findingImportWorkers.some(worker => existsSync(worker.afterReadPath)),
      'no different-receipt finding importer reached its pre-persist boundary');

await new Promise(resolve => setTimeout(resolve, 500));

writeFileSync(findingPersistBarrier, 'persist');

assert.deepEqual(await Promise.all(findingImportWorkers.map(worker => worker.exit)), [0, 0]);

const racedFindings = context.store.readFindings(STORY_ID).findings;

assert.equal(racedFindings.length, 2, 'different receipt finding imports lose no concurrent update');

assert.equal(new Set(racedFindings.map(finding => finding.id)).size, 2, 'different receipt finding imports allocate unique ids');

assert.deepEqual(
      new Set(racedFindings.map(finding => finding.managedEvidenceBinding?.receiptId)),
      new Set([findingReceipt.receiptId, secondFindingReceipt.receiptId]),
    );

const importedFinding = racedFindings.find(finding => finding.managedEvidenceBinding?.receiptId === findingReceipt.receiptId)!;

const importedFindings = [importedFinding];

context.store.writeFindings(STORY_ID, { findings: importedFindings });

assert.equal(importedFindings[0]?.agent, LANE);

assert.equal(importedFindings[0]?.managedEvidenceBinding?.receiptId, findingReceipt.receiptId);

assert.equal(importedFindings[0]?.desc, 'packages/main/src/example.ts:1 managed provider found a blocking behavior defect');

assert.equal(importedFindings[0]?.severity, 'high');

assert.equal(importedFindings[0]?.category, 'adversarial');

assert.deepEqual(importedFindings[0]?.files, ['packages/main/src/example.ts']);

assert.deepEqual(importedFindings[0]?.readManifest, managedReadEvidence(context.root).readManifest);

assert.equal(
      isFindingBlocking(importedFindings[0]!, ['critical', 'high'], 1),
      true,
      'an exact imported verified/high provider finding remains REVIEW-blocking',
    );

const findingEvidence = collectReviewerEvidenceState(context.store, STORY_ID, context.root);

assert.ok(findingEvidence.valid.some(candidate => candidate.id === importedFindings[0]?.id), 'REVIEW gate must revalidate an imported provider finding through the shared evaluator');

const originalFinding = structuredClone(importedFindings[0]!);

const rewrittenFinding = { ...originalFinding, severity: 'low' as const };

rewrittenFinding._hash = (await import("../../core/finding-verify.js")).signFinding(
      STORY_ID,
      rewrittenFinding.id,
      rewrittenFinding.desc,
      rewrittenFinding.severity,
      rewrittenFinding.createdAt!,
      rewrittenFinding.reviewRound ?? '',
      rewrittenFinding.reviewRunId ?? '',
      rewrittenFinding.readManifest,
      rewrittenFinding.readLog,
      rewrittenFinding.readDiagnostics,
      undefined,
      rewrittenFinding.managedEvidenceBinding,
    );

context.store.writeFindings(STORY_ID, { findings: [rewrittenFinding] });

const rewrittenFindingEvidence = collectReviewerEvidenceState(context.store, STORY_ID, context.root);

assert.ok(
      rewrittenFindingEvidence.invalid.some(candidate => candidate.code === 'managed_receipt_invalid'),
      'a controller cannot downgrade provider severity and re-sign the imported finding',
    );

assert.throws(
      () => context.handlers.managed_review_evidence_import({ runId: findingRun.run.runId, receiptId: findingReceipt.receiptId }),
      /existing imported evidence is no longer admissible/,
      'idempotent importer replay revalidates the exact persisted provider finding instead of trusting receipt identity alone',
    );

context.store.writeFindings(STORY_ID, { findings: [originalFinding] });

const secondReceiptHandlers = createHostRunHandlers(
      { store: context.store, root: context.root, scanRoot: join(context.root, 'packages/main') },
      { runner: async plan => {
        writeManagedReviewEvidenceProposal({
          root: context.root,
          runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!,
          environment: plan.env,
          proposal: {
            storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: readManagedHostRunBinding(context.root, plan.env.LATTICE_MANAGED_HOST_RUN_ID!).reviewRunId!,
            conclusion: 'pass', note: 'A second authentic receipt is a distinct provider proposal, never a rewrite of the first.',
            ...managedReadEvidence(context.root),
          },
        });
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
      } },
    );

const secondReceiptRun = await secondReceiptHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: context.newAttempt('receipt-recovery').reviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;

await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: secondReceiptRun.run.runId })).run.state === 'completed',
      'second authentic receipt run did not complete');

const secondReceipt = managedHostRunReceipt(context.root, secondReceiptRun.run.runId);

assert.throws(
      () => context.handlers.managed_review_evidence_import({ runId: context.submitted.runId, receiptId: secondReceipt.receiptId }),
      /producer_owned_required|signature_invalid/,
      'an authentic receipt from a different run cannot be swapped onto the already imported provider proposal',
    );

const thirdReceiptRun = await secondReceiptHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: context.newAttempt('receipt-recovery').reviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;

await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: thirdReceiptRun.run.runId })).run.state === 'completed',
      'third authentic receipt run did not complete');

const thirdReceipt = managedHostRunReceipt(context.root, thirdReceiptRun.run.runId);

const distinctReceiptStartBarrier = join(context.root, 'distinct-receipt-import-start.go');

const distinctReceiptPersistBarrier = join(context.root, 'distinct-receipt-import-persist.go');

const distinctReceiptWorkers = [
      { runId: secondReceiptRun.run.runId, receiptId: secondReceipt.receiptId },
      { runId: thirdReceiptRun.run.runId, receiptId: thirdReceipt.receiptId },
    ].map((candidate, index) => {
      const readyPath = join(context.root, `distinct-receipt-worker-${index}.ready`);
      const resultPath = join(context.root, `distinct-receipt-worker-${index}.result`);
      const afterReadPath = join(context.root, `distinct-receipt-worker-${index}.after-read`);
      const child = spawn(process.execPath, [
        SELF, '--import-worker', context.root, candidate.runId, candidate.receiptId,
        readyPath, distinctReceiptStartBarrier, resultPath, afterReadPath, distinctReceiptPersistBarrier,
      ], { cwd: context.root, env: hostOwnedChildEnv(), stdio: 'ignore' });
      return { child, exit: waitForExit(child), readyPath, resultPath, afterReadPath };
    });

await eventually(async () => distinctReceiptWorkers.every(worker => existsSync(worker.readyPath)),
      'distinct receipt import workers did not reach the start barrier');

writeFileSync(distinctReceiptStartBarrier, 'start');

await eventually(async () => distinctReceiptWorkers.some(worker => existsSync(worker.afterReadPath)),
      'no distinct receipt importer reached its pre-persist boundary');

await new Promise(resolve => setTimeout(resolve, 500));

writeFileSync(distinctReceiptPersistBarrier, 'persist');

assert.deepEqual(await Promise.all(distinctReceiptWorkers.map(worker => worker.exit)), [0, 0],
      'real different-receipt importer processes both complete under the shared story metadata lock');

const afterSecondReceipt = context.store.readReviewPasses(STORY_ID).passes;

assert.equal(afterSecondReceipt.length, 3, 'two concurrently imported authentic receipts create two distinct evidence identities');

assert.equal(new Set(afterSecondReceipt.map(pass => pass.id)).size, 3, 'concurrent different receipts never allocate a duplicate review-pass id');

assert.deepEqual(
      new Set(afterSecondReceipt.map(pass => pass.managedEvidenceBinding?.receiptId)),
      new Set([context.receipt.receiptId, secondReceipt.receiptId, thirdReceipt.receiptId]),
      'concurrent different receipts are neither lost nor duplicated',
    );

assert.deepEqual(
      afterSecondReceipt.find(candidate => candidate.id === context.originalPass.id),
      context.originalPass,
      'the first imported provider proposal remains byte-semantically unchanged after a different authentic receipt import',
    );

assert.ok(
      collectReviewerEvidenceState(context.store, STORY_ID, context.root).valid.some(candidate => candidate.id === context.originalPass.id),
      'the prior authentic receipt remains independently valid at the REVIEW gate',
    );

const prePersistCrashRun = await secondReceiptHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: context.newAttempt('receipt-recovery').reviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;

await eventually(async () => (await getManagedHostRunStatus({
      root: context.root,
      runId: prePersistCrashRun.run.runId,
    })).run.state === 'completed', 'pre-persist crash receipt run did not complete');

const prePersistCrashReceipt = managedHostRunReceipt(context.root, prePersistCrashRun.run.runId);

const originalPrePersistWrite = context.store.writeReviewPasses.bind(context.store);

let injectedPrePersistCrash = false;

context.store.writeReviewPasses = ((storyId: string, data: Parameters<StoryStore['writeReviewPasses']>[1]) => {
      if (!injectedPrePersistCrash
        && data.passes.some(pass => pass.managedEvidenceBinding?.receiptId === prePersistCrashReceipt.receiptId)) {
        injectedPrePersistCrash = true;
        throw new Error('injected crash before story evidence persistence');
      }
      originalPrePersistWrite(storyId, data);
    }) as typeof context.store.writeReviewPasses;

try {
      assert.throws(
        () => context.handlers.managed_review_evidence_import({
          runId: prePersistCrashRun.run.runId,
          receiptId: prePersistCrashReceipt.receiptId,
        }),
        /injected crash before story evidence persistence/,
      );
    } finally {
      context.store.writeReviewPasses = originalPrePersistWrite;
    }

const prePersistRunDir = managedHostRunDirectory(context.root, prePersistCrashRun.run.runId);

assert.equal(existsSync(join(prePersistRunDir, 'evidence-binding.json')), false,
      'a pre-persist crash cannot seal an RP id that the story has not durably claimed');

assert.equal(
      context.store.readReviewPasses(STORY_ID).passes.some(pass => pass.managedEvidenceBinding?.receiptId === prePersistCrashReceipt.receiptId),
      false,
      'pre-persist crash cannot expose partial story evidence',
    );

const interveningRun = await secondReceiptHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: context.newAttempt('receipt-recovery').reviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;

await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: interveningRun.run.runId })).run.state === 'completed',
      'intervening receipt run did not complete');

const interveningReceipt = managedHostRunReceipt(context.root, interveningRun.run.runId);

assert.match(
      context.handlers.managed_review_evidence_import({ runId: interveningRun.run.runId, receiptId: interveningReceipt.receiptId }),
      /Managed review evidence imported/,
      'an intervening authentic receipt can claim the next RP id after the crash',
    );

const interveningPass = context.store.readReviewPasses(STORY_ID).passes.find(
      pass => pass.managedEvidenceBinding?.receiptId === interveningReceipt.receiptId,
    );

assert.ok(interveningPass, 'the intervening receipt owns one durable review-pass identity');

assert.match(
      context.handlers.managed_review_evidence_import({
        runId: prePersistCrashRun.run.runId,
        receiptId: prePersistCrashReceipt.receiptId,
      }),
      /Managed review evidence imported/,
      'retry after a pre-persist crash converges after an intervening receipt claimed the original candidate id',
    );

const recoveredPasses = context.store.readReviewPasses(STORY_ID).passes.filter(
      pass => pass.managedEvidenceBinding?.receiptId === prePersistCrashReceipt.receiptId,
    );

assert.equal(recoveredPasses.length, 1, 'crash recovery creates exactly one provider-authored pass');

assert.notEqual(recoveredPasses[0]!.id, interveningPass.id,
      'the recovering receipt never rewrites or collides with the intervening receipt identity');

assert.equal(existsSync(join(prePersistRunDir, 'evidence-binding.json')), true,
      'the retry seals the recovered receipt against its own durable RP id');

const crashRun = await secondReceiptHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: context.newAttempt('receipt-recovery').reviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;

await eventually(async () => (await getManagedHostRunStatus({ root: context.root, runId: crashRun.run.runId })).run.state === 'completed',
      'crash-consistency receipt run did not complete');

const crashReceipt = managedHostRunReceipt(context.root, crashRun.run.runId);

const originalWriteReviewPasses = context.store.writeReviewPasses.bind(context.store);

let injectedPostPersistCrash = false;

context.store.writeReviewPasses = ((storyId: string, data: Parameters<StoryStore['writeReviewPasses']>[1]) => {
      originalWriteReviewPasses(storyId, data);
      if (!injectedPostPersistCrash && data.passes.some(pass => pass.managedEvidenceBinding?.receiptId === crashReceipt.receiptId)) {
        injectedPostPersistCrash = true;
        throw new Error('injected crash after story evidence persistence');
      }
    }) as typeof context.store.writeReviewPasses;

try {
      assert.throws(
        () => context.handlers.managed_review_evidence_import({ runId: crashRun.run.runId, receiptId: crashReceipt.receiptId }),
        /injected crash after story evidence persistence/,
      );
    } finally {
      context.store.writeReviewPasses = originalWriteReviewPasses;
    }

const crashRunDir = managedHostRunDirectory(context.root, crashRun.run.runId);

assert.equal(existsSync(join(crashRunDir, 'evidence-binding.json')), false,
      'a post-persist crash leaves no premature external receipt seal');

assert.equal(existsSync(join(crashRunDir, 'evidence-binding.seal.json')), false,
      'a post-persist crash leaves the binding seal absent for retry repair');

const recoveredImport = context.handlers.managed_review_evidence_import({ runId: crashRun.run.runId, receiptId: crashReceipt.receiptId });

assert.match(
      recoveredImport,
      /already imported/,
      'retry after the post-persist crash seals the exact persisted evidence without duplication',
    );

assert.equal(
      context.store.readProcessEvents(STORY_ID).filter((event) =>
        event.type === 'review_pass'
        && event.command === 'managed_review_evidence_import'
        && event.managedRunId === crashRun.run.runId
        && event.managedReceiptId === crashReceipt.receiptId,
      ).length,
      1,
      'retry after a post-persist crash restores the missing receipt-bound review audit event exactly once',
    );

assert.ok(
      collectReviewerEvidenceState(context.store, STORY_ID, context.root).valid.some(candidate => candidate.pass?.managedEvidenceBinding?.receiptId === crashReceipt.receiptId),
      'retry repairs receipt authority before the persisted pass can become admissible',
    );

const bindingSealCrashRun = await secondReceiptHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: context.newAttempt('receipt-recovery').reviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;

await eventually(async () => (await getManagedHostRunStatus({
      root: context.root,
      runId: bindingSealCrashRun.run.runId,
    })).run.state === 'completed', 'binding-seal crash receipt run did not complete');

const bindingSealCrashReceipt = managedHostRunReceipt(context.root, bindingSealCrashRun.run.runId);

let injectedBindingSealCrash = false;

const bindingSealCrashHandlers = createManagedReviewEvidenceHandlers(
      { store: context.store, root: context.root, scanRoot: join(context.root, 'packages/main') },
      {
        afterManagedHostRunEvidenceBindingWrite: () => {
          if (!injectedBindingSealCrash) {
            injectedBindingSealCrash = true;
            throw new Error('injected crash between evidence binding and seal writes');
          }
        },
      },
    );

assert.throws(
      () => bindingSealCrashHandlers.managed_review_evidence_import({
        runId: bindingSealCrashRun.run.runId,
        receiptId: bindingSealCrashReceipt.receiptId,
      }),
      /injected crash between evidence binding and seal writes/,
      'the regression injects the exact binding-to-seal crash window',
    );

const bindingSealCrashDir = managedHostRunDirectory(context.root, bindingSealCrashRun.run.runId);

assert.equal(injectedBindingSealCrash, true, 'binding-to-seal crash seam ran after the durable binding write');

assert.equal(existsSync(join(bindingSealCrashDir, 'evidence-binding.json')), true,
      'crash leaves its exact terminal-bound evidence binding available for recovery');

assert.equal(existsSync(join(bindingSealCrashDir, 'evidence-binding.seal.json')), false,
      'crash occurs before the external binding seal is published');

assert.doesNotThrow(
      () => managedHostRunReceipt(context.root, bindingSealCrashRun.run.runId),
      'an exact terminal-bound unsealed binding remains receipt-readable for importer recovery',
    );

assert.equal(readManagedReviewImportSeal(context.root, bindingSealCrashRun.run.runId), null,
      'the incomplete pair remains inadmissible to REVIEW evidence before retry repair');

const bindingSealCrashPass = context.store.readReviewPasses(STORY_ID).passes.find(
      pass => pass.managedEvidenceBinding?.receiptId === bindingSealCrashReceipt.receiptId,
    );

assert.ok(bindingSealCrashPass, 'crash window persists exactly one receipt-bound review pass before repair');

assert.ok(
      collectReviewerEvidenceState(context.store, STORY_ID, context.root).invalid.some(candidate => (
        candidate.code === 'managed_receipt_invalid' && candidate.evidenceId === bindingSealCrashPass.id
      )),
      'the REVIEW gate refuses persisted managed evidence until the binding seal is recovered',
    );

assert.match(
      context.handlers.managed_review_evidence_import({
        runId: bindingSealCrashRun.run.runId,
        receiptId: bindingSealCrashReceipt.receiptId,
      }),
      /already imported/,
      'retry repairs the exact incomplete binding-seal pair without duplicating story evidence',
    );

assert.ok(readManagedReviewImportSeal(context.root, bindingSealCrashRun.run.runId),
      'retry publishes the terminal-bound binding seal');

assert.equal(
      context.store.readReviewPasses(STORY_ID).passes.filter(pass => pass.managedEvidenceBinding?.receiptId === bindingSealCrashReceipt.receiptId).length,
      1,
      'binding-seal recovery preserves exactly one provider-authored review pass',
    );

assert.ok(
      collectReviewerEvidenceState(context.store, STORY_ID, context.root).valid.some(candidate => candidate.pass?.managedEvidenceBinding?.receiptId === bindingSealCrashReceipt.receiptId),
      'recovered binding seal restores the exact receipt to REVIEW admissibility',
    );

const sealedRunDir = managedHostRunDirectory(context.root, context.submitted.runId);

const terminalPath = join(sealedRunDir, 'terminal.json');

const originalTerminal = readFileSync(terminalPath, 'utf8');

const incompleteTerminal = JSON.parse(originalTerminal) as Record<string, unknown>;

incompleteTerminal.processCleanup = null;

writeFileSync(terminalPath, `${JSON.stringify(incompleteTerminal)}\n`);

assert.throws(
      () => managedHostRunReceipt(context.root, context.submitted.runId),
      /sealed artifact digest mismatch \(binding\)/,
      'a post-import terminal rewrite invalidates the sealed evidence binding instead of minting a recomputed receipt',
    );

assert.ok(
      collectReviewerEvidenceState(context.store, STORY_ID, context.root).invalid.some(candidate => candidate.code === 'managed_receipt_invalid'),
      'the REVIEW gate independently rejects incomplete or ambiguous cleanup',
    );

writeFileSync(terminalPath, originalTerminal);

const conflictingProposalArtifact = join(sealedRunDir, 'evidence-proposal-conflict.json');

writeFileSync(conflictingProposalArtifact, readFileSync(join(sealedRunDir, 'evidence-proposal.json')));

assert.throws(
      () => createManagedReviewEvidenceBinding(context.exactIntake),
      /managed_review_evidence_import:/,
      'multiple proposal artifacts are ambiguous and fail closed at fresh intake',
    );

assert.ok(
      collectReviewerEvidenceState(context.store, STORY_ID, context.root).invalid.some(candidate => candidate.code === 'managed_receipt_invalid'),
      'multiple proposal artifacts also fail the persisted REVIEW gate',
    );

unlinkSync(conflictingProposalArtifact);

assert.ok(collectReviewerEvidenceState(context.store, STORY_ID, context.root).valid.some(candidate => candidate.id === context.originalPass.id));

for (const artifact of ['spec.json', 'events.jsonl', 'result.json', 'terminal.json']) {
      const artifactPath = join(sealedRunDir, artifact);
      const original = readFileSync(artifactPath, 'utf8');
      writeFileSync(artifactPath, `${original} `);
      assert.throws(
        () => createManagedReviewEvidenceBinding(context.exactIntake),
        /managed_review_evidence_import:/,
        `fresh intake must reject post-terminal ${artifact} tampering`,
      );
      const invalid = collectReviewerEvidenceState(context.store, STORY_ID, context.root);
      assert.ok(
        invalid.invalid.some(candidate => candidate.code === 'managed_receipt_invalid'),
        `REVIEW gate must reject post-terminal ${artifact} tampering`,
      );
      writeFileSync(artifactPath, original);
      const restored = collectReviewerEvidenceState(context.store, STORY_ID, context.root);
      assert.equal(restored.invalid.some(candidate => candidate.code === 'managed_receipt_invalid'), false, `${artifact} byte restoration should restore exact receipt validity`);
    }

const proposalPath = join(sealedRunDir, 'evidence-proposal.json');

const proposal = JSON.parse(readFileSync(proposalPath, 'utf8')) as Record<string, unknown>;

writeFileSync(proposalPath, `${JSON.stringify({ ...proposal, note: 'tampered after terminal' })}\n`);

assert.throws(
      () => createManagedReviewEvidenceBinding(context.exactIntake),
      /managed_review_evidence_import:/,
      'fresh intake must reject post-terminal proposal tampering',
    );

const tampered = collectReviewerEvidenceState(context.store, STORY_ID, context.root);

assert.ok(tampered.invalid.some(candidate => candidate.code === 'managed_receipt_invalid'), 'REVIEW gate must recheck and reject post-terminal proposal tampering');

if (context.fullRun) console.log('managed-review-evidence-smoke PASS');

return Object.defineProperties(context, {
  degradedGate: { enumerable: true, get: () => degradedGate },
  findingRaceReviewRunId: { enumerable: true, get: () => findingRaceReviewRunId },
  findingHandlers: { enumerable: true, get: () => findingHandlers },
  findingRun: { enumerable: true, get: () => findingRun },
  findingReceipt: { enumerable: true, get: () => findingReceipt },
  secondFindingRun: { enumerable: true, get: () => secondFindingRun },
  secondFindingReceipt: { enumerable: true, get: () => secondFindingReceipt },
  findingStartBarrier: { enumerable: true, get: () => findingStartBarrier },
  findingPersistBarrier: { enumerable: true, get: () => findingPersistBarrier },
  findingImportWorkers: { enumerable: true, get: () => findingImportWorkers },
  racedFindings: { enumerable: true, get: () => racedFindings },
  importedFinding: { enumerable: true, get: () => importedFinding },
  importedFindings: { enumerable: true, get: () => importedFindings },
  findingEvidence: { enumerable: true, get: () => findingEvidence },
  originalFinding: { enumerable: true, get: () => originalFinding },
  rewrittenFinding: { enumerable: true, get: () => rewrittenFinding },
  rewrittenFindingEvidence: { enumerable: true, get: () => rewrittenFindingEvidence },
  secondReceiptHandlers: { enumerable: true, get: () => secondReceiptHandlers },
  secondReceiptRun: { enumerable: true, get: () => secondReceiptRun },
  secondReceipt: { enumerable: true, get: () => secondReceipt },
  thirdReceiptRun: { enumerable: true, get: () => thirdReceiptRun },
  thirdReceipt: { enumerable: true, get: () => thirdReceipt },
  distinctReceiptStartBarrier: { enumerable: true, get: () => distinctReceiptStartBarrier },
  distinctReceiptPersistBarrier: { enumerable: true, get: () => distinctReceiptPersistBarrier },
  distinctReceiptWorkers: { enumerable: true, get: () => distinctReceiptWorkers },
  afterSecondReceipt: { enumerable: true, get: () => afterSecondReceipt },
  prePersistCrashRun: { enumerable: true, get: () => prePersistCrashRun },
  prePersistCrashReceipt: { enumerable: true, get: () => prePersistCrashReceipt },
  originalPrePersistWrite: { enumerable: true, get: () => originalPrePersistWrite },
  injectedPrePersistCrash: { enumerable: true, get: () => injectedPrePersistCrash, set: (value: typeof injectedPrePersistCrash) => { injectedPrePersistCrash = value; } },
  prePersistRunDir: { enumerable: true, get: () => prePersistRunDir },
  interveningRun: { enumerable: true, get: () => interveningRun },
  interveningReceipt: { enumerable: true, get: () => interveningReceipt },
  interveningPass: { enumerable: true, get: () => interveningPass },
  recoveredPasses: { enumerable: true, get: () => recoveredPasses },
  crashRun: { enumerable: true, get: () => crashRun },
  crashReceipt: { enumerable: true, get: () => crashReceipt },
  originalWriteReviewPasses: { enumerable: true, get: () => originalWriteReviewPasses },
  injectedPostPersistCrash: { enumerable: true, get: () => injectedPostPersistCrash, set: (value: typeof injectedPostPersistCrash) => { injectedPostPersistCrash = value; } },
  crashRunDir: { enumerable: true, get: () => crashRunDir },
  recoveredImport: { enumerable: true, get: () => recoveredImport },
  bindingSealCrashRun: { enumerable: true, get: () => bindingSealCrashRun },
  bindingSealCrashReceipt: { enumerable: true, get: () => bindingSealCrashReceipt },
  injectedBindingSealCrash: { enumerable: true, get: () => injectedBindingSealCrash, set: (value: typeof injectedBindingSealCrash) => { injectedBindingSealCrash = value; } },
  bindingSealCrashHandlers: { enumerable: true, get: () => bindingSealCrashHandlers },
  bindingSealCrashDir: { enumerable: true, get: () => bindingSealCrashDir },
  bindingSealCrashPass: { enumerable: true, get: () => bindingSealCrashPass },
  sealedRunDir: { enumerable: true, get: () => sealedRunDir },
  terminalPath: { enumerable: true, get: () => terminalPath },
  originalTerminal: { enumerable: true, get: () => originalTerminal },
  incompleteTerminal: { enumerable: true, get: () => incompleteTerminal },
  conflictingProposalArtifact: { enumerable: true, get: () => conflictingProposalArtifact },
  proposalPath: { enumerable: true, get: () => proposalPath },
  proposal: { enumerable: true, get: () => proposal },
  tampered: { enumerable: true, get: () => tampered },
}) as typeof context & {
  readonly degradedGate: typeof degradedGate;
  readonly findingRaceReviewRunId: typeof findingRaceReviewRunId;
  readonly findingHandlers: typeof findingHandlers;
  readonly findingRun: typeof findingRun;
  readonly findingReceipt: typeof findingReceipt;
  readonly secondFindingRun: typeof secondFindingRun;
  readonly secondFindingReceipt: typeof secondFindingReceipt;
  readonly findingStartBarrier: typeof findingStartBarrier;
  readonly findingPersistBarrier: typeof findingPersistBarrier;
  readonly findingImportWorkers: typeof findingImportWorkers;
  readonly racedFindings: typeof racedFindings;
  readonly importedFinding: typeof importedFinding;
  readonly importedFindings: typeof importedFindings;
  readonly findingEvidence: typeof findingEvidence;
  readonly originalFinding: typeof originalFinding;
  readonly rewrittenFinding: typeof rewrittenFinding;
  readonly rewrittenFindingEvidence: typeof rewrittenFindingEvidence;
  readonly secondReceiptHandlers: typeof secondReceiptHandlers;
  readonly secondReceiptRun: typeof secondReceiptRun;
  readonly secondReceipt: typeof secondReceipt;
  readonly thirdReceiptRun: typeof thirdReceiptRun;
  readonly thirdReceipt: typeof thirdReceipt;
  readonly distinctReceiptStartBarrier: typeof distinctReceiptStartBarrier;
  readonly distinctReceiptPersistBarrier: typeof distinctReceiptPersistBarrier;
  readonly distinctReceiptWorkers: typeof distinctReceiptWorkers;
  readonly afterSecondReceipt: typeof afterSecondReceipt;
  readonly prePersistCrashRun: typeof prePersistCrashRun;
  readonly prePersistCrashReceipt: typeof prePersistCrashReceipt;
  readonly originalPrePersistWrite: typeof originalPrePersistWrite;
  injectedPrePersistCrash: typeof injectedPrePersistCrash;
  readonly prePersistRunDir: typeof prePersistRunDir;
  readonly interveningRun: typeof interveningRun;
  readonly interveningReceipt: typeof interveningReceipt;
  readonly interveningPass: typeof interveningPass;
  readonly recoveredPasses: typeof recoveredPasses;
  readonly crashRun: typeof crashRun;
  readonly crashReceipt: typeof crashReceipt;
  readonly originalWriteReviewPasses: typeof originalWriteReviewPasses;
  injectedPostPersistCrash: typeof injectedPostPersistCrash;
  readonly crashRunDir: typeof crashRunDir;
  readonly recoveredImport: typeof recoveredImport;
  readonly bindingSealCrashRun: typeof bindingSealCrashRun;
  readonly bindingSealCrashReceipt: typeof bindingSealCrashReceipt;
  injectedBindingSealCrash: typeof injectedBindingSealCrash;
  readonly bindingSealCrashHandlers: typeof bindingSealCrashHandlers;
  readonly bindingSealCrashDir: typeof bindingSealCrashDir;
  readonly bindingSealCrashPass: typeof bindingSealCrashPass;
  readonly sealedRunDir: typeof sealedRunDir;
  readonly terminalPath: typeof terminalPath;
  readonly originalTerminal: typeof originalTerminal;
  readonly incompleteTerminal: typeof incompleteTerminal;
  readonly conflictingProposalArtifact: typeof conflictingProposalArtifact;
  readonly proposalPath: typeof proposalPath;
  readonly proposal: typeof proposal;
  readonly tampered: typeof tampered;
};
}
