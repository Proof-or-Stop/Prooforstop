import { hasMechanicalExecutionAuthority } from '../core/verification-receipt-authority.js';
/** Owner-driven repair closeout. Evidence is checked before any terminal fact is published. */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { readGitStatusLines, classifierOptionsForCheck, classifyGitStatusRows, isBlockingDirty } from '../core/dirty-worktree-gate.js';
import { relative } from 'node:path';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import type { Finding, FindingLifecycleTransition } from '../core/types.js';
import type { MkdirLockFence } from '../core/mkdir-lock.js';
import { resolveAgentMutationAuthority } from '../core/agent-dispatch-registry.js';
import { verifyReviewInventoryEpoch, verifyReviewInventoryReceipt } from '../core/review-inventory-epoch.js';
import { checkEvidenceFreshnessForGit } from '../core/evidence-freshness.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { resolveWorkflowPolicy } from '../core/workflow-policy.js';
import { loadConfig } from '../core/config.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { getSessionIdentity } from '../core/owner-session.js';
import { readOwnerLease } from '../core/story-owner-lease.js';
import { computeProcessMetrics } from '../core/process-metrics.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { appendFindingLedger, canonicalHash, findingLedgerSignerFromWorkspace, withAtomicFindingLedgerWrites, type FindingLedgerWriteStore } from './finding-ledger.js';
import type { JsonValue } from '../core/finding-ledger.js';

export interface RepairSet {
  storyId: string;
  repairSetId: string;
  epochId: string;
  repairCommit: string;
  findings: Array<{ findingId: string; resolution: string; verification: Array<{ itemId: string; intentRef: string; evidenceDigest: string }> }>;
}
interface Dependencies {
  withLock<T>(storyId: string, action: (fence: MkdirLockFence) => T): T;
  resolve(storyId: string, finding: Finding, fence: MkdirLockFence, resolution: string, store: FindingLedgerWriteStore): FindingLifecycleTransition;
}

export function createReviewRemediationHandlers(ctx: HandlerContext, dependencies: Dependencies) {
  return {
    review_remediation_close(args: RepairSet) {
      resolveAgentMutationAuthority({ command: 'review_remediation_close' });
      assertCwdInWorktree(ctx.store, args.storyId);
      if (!args.repairSetId?.trim() || !args.epochId?.trim() || !/^[a-f0-9]{40,64}$/.test(args.repairCommit)) throw new Error('repairSet requires an ID, epoch and full repair commit');
      if (!Array.isArray(args.findings) || args.findings.length === 0 || new Set(args.findings.map(f => f.findingId)).size !== args.findings.length) throw new Error('repairSet findings must be non-empty and unique');
      for (const finding of args.findings) {
        if (!finding.findingId?.trim() || !finding.resolution?.trim() || !Array.isArray(finding.verification) || finding.verification.length === 0) throw new Error('each finding requires resolution and verification evidence');
      }
      return dependencies.withLock(args.storyId, fence => {
        const story = ctx.store.readStory(args.storyId);
        if (story.phase !== 'DEV') throw new Error('review_remediation_close requires DEV remediation');
        const gitCwd = resolveGitCwd({ store: ctx.store, storyId: args.storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
        const git = (...argv: string[]) => execFileSync('git', argv, { cwd: gitCwd, encoding: 'utf8', stdio: 'pipe' }).trim();
        const requestDigest = canonicalHash(args);
        const ledger = ctx.store.readFindingLedger<JsonValue>(args.storyId);
        // Canonical projection read verifies Finding carriers; the batch marker is verified separately.
        const current = ctx.store.readFindings(args.storyId);
        const prior = ledger.records.find(r => r.recordType === 'review_remediation' && (r.payload as Record<string, unknown>)?.repairSetId === args.repairSetId);
        if (prior && (prior.payload as Record<string, unknown>).requestDigest !== requestDigest) throw new Error('IDEMPOTENCY_CONFLICT: repairSet payload changed');
        const appendMarker = (store: FindingLedgerWriteStore) => {
          const identity = getSessionIdentity();
          return appendFindingLedger({ storyId: args.storyId, store, fence, signer: findingLedgerSignerFromWorkspace(ctx.root),
            operation: 'append_review_remediation', idempotencyKey: `review-remediation:${args.repairSetId}`,
            records: [{ recordType: 'review_remediation', uniqueBindingKey: `review-remediation:${args.repairSetId}`, payload: { ...args, requestDigest } as unknown as JsonValue }],
            writerSessionId: identity.sessionId, writerLeaseId: readOwnerLease(ctx.store.storyDirPath(args.storyId))?.sessionId ?? identity.sessionId, writerFenceToken: fence.writerFenceToken });
        };
        if (prior) {
          if (!ledger.receipts.some(r => r.idempotencyKey === `review-remediation:${args.repairSetId}` && r.recordIds.includes(prior.recordId))) throw new Error('IDEMPOTENCY_CONFLICT: repairSet marker has no carrier');
          appendMarker(ctx.store); // Exact replay verifies signer, complete payload, carrier and prefix without publishing.
          if (args.findings.some(r => !current.findings.some(f => f.id === r.findingId && f.status === 'resolved'))) throw new Error('repairSet terminal projection is incomplete');
        }
        const artifactNames = ['finding-ledger.json', 'findings.json', 'process-metrics.json'];
        let commitReadError = '';
        const artifactsCommitted = () => {
          try {
            return artifactNames.every(name => {
              const path = ctx.store.storyFilePath(args.storyId, name);
              const gitPath = relative(realpathSync(gitCwd), realpathSync(path));
              return canonicalHash(JSON.parse(git('show', `HEAD:${gitPath}`))) === canonicalHash(JSON.parse(readFileSync(path, 'utf8')));
            });
          } catch (error) { commitReadError = error instanceof Error ? error.message : String(error); return false; }
        };
        const assertCleanMaterial = () => {
          const status = readGitStatusLines(gitCwd);
          if (!status.ok) throw new Error(`repairSet dirty preflight unavailable: ${status.error}`);
          const dirty = isBlockingDirty(classifyGitStatusRows(status.lines, classifierOptionsForCheck(loadConfig(ctx.root), args.storyId, ctx.store, ctx.root)));
          if (dirty.blocked) throw new Error(`repairSet refuses dirty material: ${dirty.blockingPaths.join(', ')}`);
        };
        assertCleanMaterial();
        if (!prior) {
          const inventory = ctx.store.readReviewInventoryEpochs(args.storyId);
          const epoch = inventory.epochs.find(e => e.epochId === args.epochId);
          const receipt = inventory.receipts.find(r => r.receiptId === epoch?.receiptId);
          if (!epoch || !receipt || !verifyReviewInventoryEpoch(epoch) || !verifyReviewInventoryReceipt(receipt)
            || epoch.storyId !== args.storyId || receipt.storyId !== args.storyId || receipt.epochId !== epoch.epochId
            || epoch.state !== 'FINALIZED' || epoch.invalidation || epoch.cancelledAt || !epoch.consumedAt || !epoch.consumedByReviewRound
            || !receipt.consumedAt || receipt.invalidatedAt || receipt.reviewRound !== epoch.reviewRound
            || receipt.scopeDigest !== epoch.scopeDigest || canonicalHash(receipt.cutoff) !== canonicalHash(epoch.cutoff)
            || canonicalHash(receipt.requiredLanes) !== canonicalHash(epoch.requiredLanes)) throw new Error('repairSet requires a valid consumed finalized inventory epoch and receipt');
          git('merge-base', '--is-ancestor', epoch.cutoff.headHash, args.repairCommit);
          git('merge-base', '--is-ancestor', args.repairCommit, 'HEAD');
          if (!git('diff-tree', '--no-commit-id', '--name-only', '-r', args.repairCommit)) throw new Error('repair commit has no changes');
          const inventoryIds = new Set([...(epoch.baselineFindingIds ?? []), ...epoch.waves.flatMap(w => w.lanes.flatMap(l => l.terminal === 'finding' ? l.evidenceIds : []))]);
          const checklist = ctx.store.readChecklist(args.storyId);
          const head = git('rev-parse', 'HEAD');
          const coverage = buildVerificationCoverage(checklist, head,
            (oldHead, evidence) => checkEvidenceFreshnessForGit(gitCwd, oldHead, evidence?.materialHash, ctx.root, evidence?.storyFilesHash).fresh,
            { evidenceQualityProfile: resolveWorkflowPolicy(loadConfig(ctx.root), story).profile });
          for (const repair of args.findings) {
            const finding = current.findings.find(f => f.id === repair.findingId);
            if (!finding || finding.status !== 'open' || finding.evidenceState === 'disproven' || !inventoryIds.has(finding.id)) throw new Error(`Finding ${repair.findingId} is not an open finding in the consumed inventory`);
            for (const proof of repair.verification) {
              const item = checklist.items.find(i => i.id === proof.itemId);
              const evidence = item?.verificationEvidence?.find(e => e.intentRef === proof.intentRef && canonicalHash(e) === proof.evidenceDigest);
              if (!evidence || !evidence.headHash || !evidence.materialHash || evidence.mechanical !== true || evidence.result !== 'pass'
                || evidence.kind === 'waiver' || evidence.receipt?.exitCode !== 0 || evidence.receipt?.selectorMatched !== true
                || !coverage.entries.some(e => e.itemId === proof.itemId && e.intentRef === proof.intentRef && e.status === 'covered')
                || !checkEvidenceFreshnessForGit(gitCwd, evidence.headHash, evidence.materialHash, ctx.root, evidence.storyFilesHash).fresh) throw new Error(`Finding ${repair.findingId} requires current mechanical verification evidence`);
              if (!item || !hasMechanicalExecutionAuthority(ctx.store, args.storyId, item, evidence)) throw new Error(`Finding ${repair.findingId} verification execution authority is missing or invalid`);
              git('merge-base', '--is-ancestor', args.repairCommit, evidence.headHash);
            }
          }
          const inputDigest = canonicalHash({ inventory, checklist });
          const assertPublicationInputsCurrent = () => {
            assertCleanMaterial();
            if (git('rev-parse', 'HEAD') !== head || canonicalHash({
              inventory: ctx.store.readReviewInventoryEpochs(args.storyId), checklist: ctx.store.readChecklist(args.storyId),
            }) !== inputDigest) throw new Error('repairSet inputs changed before publication');
            for (const repair of args.findings) for (const proof of repair.verification) {
              const evidence = checklist.items.find(i => i.id === proof.itemId)!.verificationEvidence!.find(e => canonicalHash(e) === proof.evidenceDigest)!;
              const item = checklist.items.find(i => i.id === proof.itemId)!;
              if (!hasMechanicalExecutionAuthority(ctx.store, args.storyId, item, evidence)) throw new Error('repairSet execution authority changed before publication');
            }
          };
          assertPublicationInputsCurrent();
          withAtomicFindingLedgerWrites({ store: ctx.store, storyId: args.storyId, fence,
            commitOptions: { beforeRename: assertPublicationInputsCurrent },
          }, staged => {
            for (const repair of args.findings) dependencies.resolve(args.storyId, current.findings.find(f => f.id === repair.findingId)!, fence, repair.resolution, staged);
            appendMarker(staged);
          });
        }
        // Also recovers interruption after ledger publication but before metadata commit.
        const canonical = ctx.store.readFindings(args.storyId);
        const persistedHash = (value: unknown) => canonicalHash(JSON.parse(JSON.stringify(value)));
        const metrics = computeProcessMetrics(args.storyId, ctx.store, ctx.root);
        const existingMetrics = ctx.store.readProcessMetrics(args.storyId);
        const semanticMetrics = ({ generatedAt: _generatedAt, ...rest }: typeof metrics) => rest;
        let existingProjection: unknown;
        try { existingProjection = JSON.parse(readFileSync(ctx.store.storyFilePath(args.storyId, 'findings.json'), 'utf8')); } catch { /* Recover an absent projection. */ }
        if (!existingProjection || persistedHash(existingProjection) !== persistedHash(canonical)) ctx.store.writeFindings(args.storyId, canonical);
        if (!existingMetrics || persistedHash(semanticMetrics(existingMetrics)) !== persistedHash(semanticMetrics(metrics))) ctx.store.writeProcessMetrics(args.storyId, metrics);
        const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'review_remediation_close', {
          exactStoryArtifactNames: artifactNames,
        });
        if (!artifactsCommitted()) throw new Error(`repairSet facts persisted but metadata commit is pending; retry exact request. ${commitHint} ${commitReadError}`);
        return { repairSetId: args.repairSetId, replayed: Boolean(prior), openCount: ctx.store.readFindings(args.storyId).findings.filter(f => f.status === 'open').length, commitHint };
      });
    },
  };
}
