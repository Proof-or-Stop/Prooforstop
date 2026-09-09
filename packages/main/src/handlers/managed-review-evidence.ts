import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { signFinding, signReviewPass } from '../core/finding-verify.js';
import {
  readManagedHostRunBinding,
  readManagedReviewEvidenceProposal,
  readManagedReviewProposalInvocationFromFd,
  resolveManagedReviewProposalInvocation,
  writeManagedHostRunEvidenceBinding,
  writeManagedReviewEvidenceProposal,
  type ManagedReviewEvidenceFindingProposal,
} from '../core/managed-host-run.js';
import {
  createManagedReviewEvidenceBinding,
  managedReviewerPromptDigest,
  verifyManagedReviewEvidence,
  verifyManagedReviewLiveBinding,
} from '../core/managed-review-evidence.js';
import { assertCandidateReadBinding, digestCandidateRoutingValue } from '../core/candidate-spec-routing.js';
import { withMkdirLock } from '../core/mkdir-lock.js';
import { assertCurrentReviewRunForEvidence, captureReviewRunSnapshot } from '../core/review-run.js';
import { currentStoryRoutingInput } from './candidate-spec-routing.js';
import { loadConfig } from '../core/config.js';
import type { Finding, ManagedReviewEvidenceBinding, ReviewPass } from '../core/types.js';

function assertOnlyKeys(command: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${command}: unexpected fields ${unexpected.sort().join(', ')}; verdict overrides are not accepted`);
  }
}

/**
 * The importer owns only review-passes/findings plus its optional process
 * event. The importer stages only its exact artifacts, but an already-staged
 * index can still be committed by an implementation regression. Refuse that
 * state before intake; ordinary untracked/unstaged story state remains safe
 * because the exact-path auto-commit allowlist cannot sweep it into the commit.
 */
function assertManagedReviewImportStagingClean(ctx: HandlerContext, storyId: string, gitCwd: string): void {
  const storyDir = ctx.store.storyDirPath(storyId);
  const storyPath = relative(gitCwd, storyDir);
  if (!storyPath || storyPath === '.' || storyPath === '..' || storyPath.startsWith('../')) {
    throw new Error('managed_review_evidence_import: story metadata directory is outside the canonical git workspace');
  }
  const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--', storyPath], {
    cwd: gitCwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (staged) {
    throw new Error('managed_review_evidence_import: story metadata has staged changes; refuse an importer transaction that could commit adjacent artifacts');
  }
}

export function createManagedReviewEvidenceHandlers(
  ctx: HandlerContext,
  options: {
    /** Test seam for the binding-write → seal-write crash window. */
    afterManagedHostRunEvidenceBindingWrite?: (args: { runId: string; receiptId: string }) => void;
  } = {},
) {
  return {
    managed_review_proposal_set(args: {
      runId?: string;
      storyId?: string;
      providerAgent?: string;
      lane?: string;
      reviewRunId?: string;
      conclusion?: 'pass' | 'findings';
      note?: string;
      findings?: ManagedReviewEvidenceFindingProposal[];
      readManifest?: unknown;
      readLog?: unknown;
      readDiagnostics?: unknown;
    }) {
      assertOnlyKeys('managed_review_proposal_set', args as Record<string, unknown>, [
        'runId', 'storyId', 'providerAgent', 'lane', 'reviewRunId', 'conclusion',
        'note', 'findings', 'readManifest', 'readLog', 'readDiagnostics',
      ]);
      if (!args.storyId || !args.providerAgent || !args.lane || !args.reviewRunId || !args.conclusion || args.readManifest === undefined) {
        throw new Error('managed_review_proposal_set: storyId/providerAgent/lane/reviewRunId/conclusion/readManifest are required');
      }
      let runId = args.runId?.trim() || process.env.LATTICE_MANAGED_HOST_RUN_ID?.trim() || '';
      let providerInvocationPid: number | undefined;
      const providerInvocationAttestation = readManagedReviewProposalInvocationFromFd();
      if (!runId) {
        if (providerInvocationAttestation) {
          runId = providerInvocationAttestation.runId;
        } else {
          runId = resolveManagedReviewProposalInvocation({
            root: ctx.root,
            binding: {
              storyId: args.storyId,
              providerAgent: args.providerAgent,
              lane: args.lane,
              reviewRunId: args.reviewRunId,
            },
          });
          providerInvocationPid = process.pid;
        }
      }
      const proposal = writeManagedReviewEvidenceProposal({
        root: ctx.root,
        runId,
        environment: process.env,
        ...(providerInvocationPid !== undefined ? { providerInvocationPid } : {}),
        ...(providerInvocationAttestation ? { providerInvocationAttestation } : {}),
        proposal: {
          storyId: args.storyId,
          providerAgent: args.providerAgent,
          lane: args.lane,
          reviewRunId: args.reviewRunId,
          conclusion: args.conclusion,
          ...(args.note !== undefined ? { note: args.note } : {}),
          ...(args.findings !== undefined ? { findings: args.findings } : {}),
          readManifest: args.readManifest as never,
          ...(args.readLog !== undefined ? { readLog: args.readLog as never } : {}),
          ...(args.readDiagnostics !== undefined ? { readDiagnostics: args.readDiagnostics as never } : {}),
        },
      });
      return {
        schemaVersion: proposal.schemaVersion,
        runId,
        conclusion: proposal.conclusion,
        authoredAt: proposal.authoredAt,
      };
    },

    managed_review_evidence_import(args: { runId?: string; receiptId?: string }) {
      assertOnlyKeys('managed_review_evidence_import', args as Record<string, unknown>, ['runId', 'receiptId']);
      const runId = args.runId?.trim() || '';
      const receiptId = args.receiptId?.trim() || '';
      if (!runId || !receiptId) throw new Error('managed_review_evidence_import: runId and receiptId are required; verdict overrides are not accepted');
      const managedRun = readManagedHostRunBinding(ctx.root, runId);
      if (!managedRun.storyId || !managedRun.reviewRunId || !managedRun.lane || managedRun.profile !== 'managed_reviewer') {
        throw new Error('managed_review_evidence_import: run is not an exact managed_reviewer binding');
      }
      assertCwdInWorktree(ctx.store, managedRun.storyId);
      const story = ctx.store.readStory(managedRun.storyId);
      const reviewRun = assertCurrentReviewRunForEvidence(
        ctx.store,
        story,
        ctx.root,
        managedRun.lane,
        managedRun.reviewRunId,
      );
      // ReviewRun's advisory freshness policy is deliberately permissive for
      // some consumers, but receipt import is an authority-creating write. It
      // must bind to the LIVE tree, not merely an old otherwise-valid review
      // tuple: once either head or material changed, re-dispatch/re-review is
      // required before a managed provider verdict can become gate evidence.
      // Match REVIEW gate consumption: a signed workspace root is canonical;
      // legacy runs use the handler project root rather than a second resolver
      // with subtly different wrapper/worktree fallback behavior.
      const gitCwd = reviewRun.workspaceBinding?.signedWorkspaceRoot ?? ctx.root;
      assertManagedReviewImportStagingClean(ctx, managedRun.storyId, gitCwd);
      const expected = {
        providerHost: managedRun.host,
        headHash: reviewRun.headHash,
        materialHash: reviewRun.materialHash,
        storyFilesHash: reviewRun.storyFilesHash ?? reviewRun.workspaceBinding?.storyFilesHash ?? '',
        promptHash: reviewRun.promptHash,
        envelopeId: reviewRun.envelopeId ?? null,
        // Public managedReview runs seal the derived provider prompt digest in
        // their immutable spec. It includes controller-fetched, root-redacted
        // canonical report statuses, which must not be re-evaluated from this
        // later import transaction. Pre-snapshot historical runs retain their
        // exact legacy renderer fallback.
        managedPromptDigest: managedRun.reviewBinding?.managedPromptDigest
          ?? managedReviewerPromptDigest(reviewRun.workspaceBinding?.metadataRoot ?? ctx.root, reviewRun),
      };
      // This check deliberately remains a closure rather than a one-time
      // preflight. Receipt verification and lock acquisition can take long
      // enough for a concurrent commit to change the reviewed tree. Recheck
      // while both canonical persistence locks are held immediately before
      // admitting an existing receipt or writing any new evidence/binding.
      const assertLiveReviewBinding = (): void => {
        const live = verifyManagedReviewLiveBinding({
          gitCwd,
          metadataRoot: ctx.root,
          storyId: managedRun.storyId!,
          expected,
        });
        if (!live.valid) {
          throw new Error(`managed_review_evidence_import: ${live.reason}; rerun the managed reviewer`);
        }
      };
      // Fail before any receipt/proposal intake or lock acquisition as well as
      // at each persistence edge below. This makes the shared live-binding
      // decision observable for every import path; the in-lock checks close
      // the remaining TOCTOU window.
      assertLiveReviewBinding();
      const sealedProposal = readManagedReviewEvidenceProposal(ctx.root, runId);
      const intake = createManagedReviewEvidenceBinding({
        root: ctx.root,
        storyId: managedRun.storyId,
        providerAgent: managedRun.agentType,
        lane: managedRun.lane,
        reviewRunId: managedRun.reviewRunId,
        runId,
        receiptId,
        expected,
        // The import transaction identity must survive a crash after sealing
        // evidence-binding.json but before story metadata persistence. Bind its
        // timestamp to the immutable provider proposal rather than a retry-local
        // wall clock so the same receipt reconstructs byte-identical evidence.
        importedAt: sealedProposal?.authoredAt,
      });
      const proposal = intake.verification.proposal ?? sealedProposal;
      if (!proposal) throw new Error('managed_review_evidence_import: shared Proof Admissibility accepted no provider proposal');
      const lockDir = ctx.store.runtimeLockDirPath(proposal.storyId, 'managed-review-evidence', receiptId.replace(/[^A-Za-z0-9._-]/g, '_'));
      // The receipt lock makes replay of one receipt idempotent. A second,
      // story-level lock is still required because distinct receipts allocate
      // ids and replace the same review-passes/findings artifact. Use the exact
      // canonical lock paths shared by review_pass_set/finding_add so managed
      // and native writers cannot lose one another's updates.
      const storyMetadataLockDir = proposal.conclusion === 'pass'
        ? ctx.store.runtimeLockDirPath(proposal.storyId, 'finding', 'review-passes')
        : ctx.store.storyFilePath(proposal.storyId, 'findings.lock');
      const assertCurrentCandidateReadBinding = (): void => {
        const routingMode = loadConfig(ctx.root).candidateSpecRouting?.mode ?? 'shadow';
        const currentStory = ctx.store.readStory(proposal.storyId);
        const snapshot = captureReviewRunSnapshot(ctx.root, {
          storyId: proposal.storyId,
          storyPhase: currentStory.phase,
        });
        assertCandidateReadBinding({
          manifest: proposal.readManifest,
          artifact: ctx.store.readCandidateSpecSet(proposal.storyId),
          mode: routingMode,
          strict: true,
          currentMaterialHash: snapshot.materialHash,
          currentStoryFilesHash: snapshot.storyFilesHash,
          currentStoryInputDigest: digestCandidateRoutingValue(currentStoryRoutingInput(ctx, proposal.storyId)),
        });
      };
      const writeImportBinding = (importedIds: string[], importedAt: string): void => {
        writeManagedHostRunEvidenceBinding(ctx.root, runId, {
          schemaVersion: 'lattice.managed_review_evidence_import.v1',
          runId,
          receiptId,
          storyId: proposal.storyId,
          reviewRunId: proposal.reviewRunId,
          lane: proposal.lane,
          importedIds,
          importedAt,
        }, {
          ...(options.afterManagedHostRunEvidenceBindingWrite ? {
            afterBindingWrite: () => options.afterManagedHostRunEvidenceBindingWrite!({ runId, receiptId }),
          } : {}),
        });
      };
      const importResult = withMkdirLock(lockDir, () => withMkdirLock(storyMetadataLockDir, (): {
        importedIds: string[];
        binding: ManagedReviewEvidenceBinding;
        created: boolean;
      } => {
        const existingPass = ctx.store.readReviewPasses(proposal.storyId).passes.find(pass => pass.managedEvidenceBinding?.receiptId === receiptId);
        const existingFindings = ctx.store.readFindings(proposal.storyId).findings.filter(finding => finding.managedEvidenceBinding?.receiptId === receiptId);
        if (existingPass || existingFindings.length > 0) {
          // Reuse is authority admission too: a retry must not make an old
          // receipt current merely because the first intake happened before a
          // concurrent source commit. Keep this under the same canonical locks
          // used by native pass/finding persistence.
          assertLiveReviewBinding();
          if (existingPass && existingFindings.length > 0) {
            throw new Error('managed_review_evidence_import: existing receipt evidence mixes pass and finding conclusions');
          }
          if (proposal.conclusion === 'pass' ? !existingPass : existingFindings.length !== proposal.findings?.length) {
            throw new Error('managed_review_evidence_import: existing receipt evidence does not exactly cover the provider proposal');
          }
          const existingEvidence = existingPass
            ? [{ binding: existingPass.managedEvidenceBinding, evidence: { kind: 'pass' as const, pass: existingPass } }]
            : existingFindings.map(finding => ({
              binding: finding.managedEvidenceBinding,
              evidence: { kind: 'finding' as const, finding },
            }));
          const findingIndexes = existingEvidence
            .map(candidate => candidate.binding?.proposalFindingIndex)
            .filter((index): index is number => Number.isInteger(index))
            .sort((a, b) => a - b);
          if (!existingPass && findingIndexes.some((index, position) => index !== position)) {
            throw new Error('managed_review_evidence_import: existing receipt findings do not exactly cover every provider proposal index');
          }
          const existingBinding = existingEvidence[0]?.binding;
          if (!existingBinding || existingBinding.runId !== runId) {
            throw new Error('managed_review_evidence_import: existing receipt evidence has an inconsistent managed binding');
          }
          const importedIds = existingPass ? [existingPass.id] : existingFindings.map(finding => finding.id);
          // Seal the external receipt-to-story binding before any existing
          // evidence can be admitted on retry. If a prior process crashed after
          // story persistence, this repairs authority before revalidation.
          assertLiveReviewBinding();
          writeImportBinding(importedIds, existingBinding.importedAt);
          for (const candidate of existingEvidence) {
            if (!candidate.binding || candidate.binding.runId !== runId) {
              throw new Error('managed_review_evidence_import: existing receipt evidence has an inconsistent managed binding');
            }
            const existingVerification = verifyManagedReviewEvidence({
              root: ctx.root,
              storyId: proposal.storyId,
              agent: proposal.providerAgent,
              lane: proposal.lane,
              reviewRunId: proposal.reviewRunId,
              binding: candidate.binding,
              expected,
              evidence: candidate.evidence,
            });
            if (!existingVerification.valid) {
              throw new Error(`managed_review_evidence_import: existing imported evidence is no longer admissible (${existingVerification.reason})`);
            }
          }
          return { importedIds, binding: existingBinding, created: false };
        }

        // Native review_pass_set/finding_add validate this same candidate
        // read binding before minting evidence. Keep the managed pass and
        // finding imports under their receipt and canonical story locks too,
        // so a provider cannot claim matching routing digests while omitting
        // required full reads. Existing receipt retries remain idempotent:
        // they revalidate their exact persisted evidence above rather than
        // retroactively changing its historic routing input.
        assertCurrentCandidateReadBinding();

        const importedAt = intake.binding.importedAt;
        const binding = intake.binding;
        let importedIds: string[];
        if (proposal.conclusion === 'pass') {
          const data = ctx.store.readReviewPasses(proposal.storyId);
          const nextNum = data.passes.reduce((max, pass) => {
            const match = pass.id.match(/:RP-(\d+)$/);
            return match ? Math.max(max, Number(match[1])) : max;
          }, 0) + 1;
          const id = `${proposal.storyId}:RP-${String(nextNum).padStart(3, '0')}`;
          const provenance = {
            writerSessionId: `managed:${runId}`,
            sessionSource: 'managed-provider-import',
          };
          const pass: ReviewPass = {
            id,
            agent: proposal.lane,
            note: proposal.note!,
            createdAt: importedAt,
            reviewRound: story.currentReviewRound || '',
            reviewRunId: proposal.reviewRunId,
            ...(reviewRun.envelopeId ? { envelopeId: reviewRun.envelopeId } : {}),
            writerSessionId: provenance.writerSessionId,
            sessionSource: provenance.sessionSource,
            readManifest: proposal.readManifest,
            ...(proposal.readLog ? { readLog: proposal.readLog } : {}),
            ...(proposal.readDiagnostics ? { readDiagnostics: proposal.readDiagnostics } : {}),
            managedEvidenceBinding: binding,
            _hash: signReviewPass(
              proposal.storyId,
              id,
              proposal.lane,
              proposal.note!,
              importedAt,
              story.currentReviewRound || '',
              proposal.reviewRunId,
              proposal.readManifest,
              proposal.readLog,
              proposal.readDiagnostics,
              provenance,
              reviewRun.envelopeId,
              binding,
            ),
          };
          data.passes.push(pass);
          assertLiveReviewBinding();
          ctx.store.writeReviewPasses(proposal.storyId, data);
          // Persist the receipt-owned evidence identity before sealing its
          // immutable external binding. A crash in the opposite order left a
          // binding for an as-yet-unwritten RP id; another receipt could then
          // allocate that id, making the authentic retry irreconcilable.
          // The existing-evidence branch above repairs the inverse crash
          // window (story persisted, binding not yet sealed) idempotently.
          assertLiveReviewBinding();
          writeImportBinding([id], binding.importedAt);
          importedIds = [id];
        } else {
          const data = ctx.store.readFindings(proposal.storyId);
          const start = data.findings.reduce((max, finding) => {
            const match = finding.id.match(/:F-(\d+)$/);
            return match ? Math.max(max, Number(match[1])) : max;
          }, 0);
          const findings: Finding[] = proposal.findings!.map((candidate, index) => {
            const id = `${proposal.storyId}:F-${String(start + index + 1).padStart(3, '0')}`;
            const findingBinding: ManagedReviewEvidenceBinding = { ...binding, proposalFindingIndex: index };
            const finding: Finding = {
              id,
              desc: candidate.desc,
              severity: candidate.severity,
              category: candidate.category,
              status: 'open',
              evidenceState: candidate.evidenceState ?? 'verified',
              ...(candidate.uncertaintyReason ? { uncertaintyReason: candidate.uncertaintyReason } : {}),
              agent: proposal.lane,
              createdAt: importedAt,
              reviewRound: story.currentReviewRound || '',
              reviewRunId: proposal.reviewRunId,
              readManifest: proposal.readManifest,
              ...(proposal.readLog ? { readLog: proposal.readLog } : {}),
              ...(proposal.readDiagnostics ? { readDiagnostics: proposal.readDiagnostics } : {}),
              ...(candidate.files ? { files: candidate.files } : {}),
              managedEvidenceBinding: findingBinding,
              _hash: signFinding(
                proposal.storyId,
                id,
                candidate.desc,
                candidate.severity,
                importedAt,
                story.currentReviewRound || '',
                proposal.reviewRunId,
                proposal.readManifest,
                proposal.readLog,
                proposal.readDiagnostics,
                undefined,
                findingBinding,
              ),
            };
            return finding;
          });
          const findingIds = findings.map(finding => finding.id);
          data.findings.push(...findings);
          assertLiveReviewBinding();
          ctx.store.writeFindings(proposal.storyId, data);
          // Keep the multi-finding conclusion on the same recovery ordering as
          // review passes: durable story evidence first, immutable receipt seal
          // second. Retry then repairs an absent seal from the exact persisted
          // evidence instead of allocating a fresh conflicting id set.
          assertLiveReviewBinding();
          writeImportBinding(findingIds, binding.importedAt);
          importedIds = findingIds;
        }
        return { importedIds, binding, created: true };
      }, { label: `managed review ${proposal.conclusion} metadata` }));

      const { importedIds, created } = importResult;
      // A crash may have persisted the reviewer evidence before recording its
      // process event or committing the Story metadata. On recovery, repair
      // those bookkeeping effects once for this exact sealed receipt. Normal
      // idempotent re-imports observe the existing event and stay write-free.
      const eventType = proposal.conclusion === 'pass' ? 'review_pass' : 'reviewer_finding';
      const alreadyAudited = ctx.store.readProcessEvents(proposal.storyId).some((event) =>
        event.type === eventType
        && event.command === 'managed_review_evidence_import'
        && event.managedRunId === runId
        && event.managedReceiptId === receiptId,
      );
      if (!alreadyAudited) {
        ctx.store.appendProcessEvent(proposal.storyId, {
          type: eventType,
          storyId: proposal.storyId,
          command: 'managed_review_evidence_import',
          role: 'reviewer',
          agent: proposal.lane,
          result: 'pass',
          managedRunId: runId,
          managedReceiptId: receiptId,
          importedIds,
          readManifest: proposal.readManifest,
          ...(proposal.readLog ? { readLog: proposal.readLog } : {}),
        });
      }
      const commitHint = autoCommitStoryMetadata(ctx.root, proposal.storyId, 'managed_review_evidence_import', {
        exactStoryArtifactNames: [
          proposal.conclusion === 'pass' ? 'review-passes.json' : 'findings.json',
          ...(alreadyAudited ? [] : ['process-events.jsonl']),
        ],
      });
      const summary = created
        ? `Managed review evidence imported from ${runId}: ${importedIds.join(', ')}`
        : `Managed review evidence already imported from ${runId}: ${importedIds.join(', ')}`;
      return `${summary}${commitHint}`;
    },
  };
}
