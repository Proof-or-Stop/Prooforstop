/**
 * The signed finding lifecycle write (lock + terminal transition), shared by
 * finding_resolve / finding_dismiss (handlers/finding.ts) and the framework's
 * import-time closure of a recurring pre-existing finding
 * (handlers/finding-recurrence.ts, old-PoS run 52). Split out of
 * handlers/finding.ts unchanged so the managed review import can close a
 * finding without importing the finding handlers (and with them next-driver).
 */
import type { HandlerContext } from './context.js';
import type { Finding, FindingLifecycleTransition } from '../core/types.js';
import type { FindingLedgerWriteStore } from './finding-ledger.js';
import { appendFindingLedger, bindLegacyFindingLedgerReceipts, canonicalHash, exactLedgerRecordHash, findingLedgerSignerFromWorkspace } from './finding-ledger.js';
import { getSessionIdentity } from '../core/owner-session.js';
import { readOwnerLease } from '../core/story-owner-lease.js';
import { readDynamicFindingDecision, resolveDynamicFindingRollout } from '../core/finding-applicability-projection.js';
import { mainWriteLockPath, withReentrantMainWriteLock } from '../core/main-write-lock.js';
import { resolveMainRepoRoot } from '../core/partial-done-recovery.js';
import { captureMkdirLockFence, withMkdirLock, type MkdirLockFence } from '../core/mkdir-lock.js';
import { randomUUID } from 'node:crypto';

/**
 * B-f60c CHK-003: a finding mutation on the shared `B-META-framework-audit`
 * container writes shared main / B-META state, so per
 * session-ownership-and-write-leases.md Rule 5 it must serialize on the unified
 * main write lock. A mutation on a NORMAL story writes story-scoped metadata
 * and serializes on a per-story findings lock so concurrent reviewer processes
 * cannot allocate the same id and overwrite each other's read-modify-write.
 *
 * The lock is reentrant: a B-META finding mutation can be reached from inside
 * another shared-write critical section (e.g. `audit` upserts B-META findings
 * while already holding the lock), and a non-reentrant acquire would self-
 * deadlock. The reentrant wrapper makes the nested call a pass-through.
 */
export function withMetaFindingLock<T>(ctx: HandlerContext, storyId: string, fn: (fence: MkdirLockFence) => T): T {
  if (!storyId.startsWith('B-META-')) {
    const lockDir = ctx.store.storyFilePath(storyId, 'findings.lock');
    return withMkdirLock(lockDir, () => fn(captureMkdirLockFence(lockDir)), {
      label: 'findings metadata',
      requireHolderToken: true,
    });
  }
  const mainRepoRoot = resolveMainRepoRoot(ctx.root);
  // A B-META finding write is a sub-second critical section — serialize-and-wait
  // on contention so a concurrent write completes rather than fail-fasting.
  return withReentrantMainWriteLock(mainRepoRoot, () => {
    const lockDir = mainWriteLockPath(mainRepoRoot);
    return fn(captureMkdirLockFence(lockDir));
  }, {
    label: `finding write (${storyId})`,
    onContention: 'wait',
  });
}

export interface FindingLifecycleInput {
  toStatus: 'resolved' | 'dismissed';
  reason?: string;
  resolutionType?: Finding['resolutionType'];
  resolveEvidenceStrength?: Finding['resolveEvidenceStrength'];
  dismissReasonType?: Finding['dismissReasonType'];
  dismissEvidenceStrength?: Finding['dismissEvidenceStrength'];
}

/** Append the canonical terminal Finding fact while the findings fence is held. */
export function appendFindingLifecycleTransition(
  ctx: HandlerContext,
  storyId: string,
  finding: Finding,
  fence: MkdirLockFence,
  input: FindingLifecycleInput,
  ledgerStore: FindingLedgerWriteStore = ctx.store,
): FindingLifecycleTransition {
  const obligationLedger = ctx.store.readFindingLedger<import('../core/finding-ledger.js').JsonValue>(storyId);
  const hasObligation = obligationLedger.records.some(row => ['mandatory_repair', 'finding_deferral_disposition'].includes(row.recordType)
    && (row.payload as unknown as { findingId?: string })?.findingId === finding.id);
  const rollout = resolveDynamicFindingRollout(ctx.root);
  if (hasObligation && rollout.mode === 'enforce' && !rollout.killSwitch) {
    const decision = readDynamicFindingDecision({ store: ctx.store, projectRoot: ctx.root, storyId, finding,
      effectiveBlockingSeverities: ['critical', 'high', 'medium'], round: 1, diagnostic: true });
    if (decision.floors.length || decision.reason === 'repair_current') {
      throw new Error(`dynamic finding: ${input.toStatus} cannot erase ${decision.reason}; record verified RED/root-cause/fix/GREEN closure first`);
    }
  }
  const identity = getSessionIdentity();
  const signer = findingLedgerSignerFromWorkspace(ctx.root);
  bindLegacyFindingLedgerReceipts({
    storyId,
    store: ledgerStore,
    writerSessionId: identity.sessionId,
    writerLeaseId: readOwnerLease(ctx.store.storyDirPath(storyId))?.sessionId ?? identity.sessionId,
    writerFenceToken: fence.writerFenceToken,
    fence,
    signer,
  });
  let ledger = ledgerStore.readFindingLedger<import('../core/finding-ledger.js').JsonValue>(storyId);
  let source = ledger.records.find((record) => (
    record.recordType === 'finding'
    && record.payload && typeof record.payload === 'object'
    && (record.payload as Record<string, unknown>).id === finding.id
    && (!finding.recordId || record.recordId === finding.recordId)
  ));
  if (!source) {
    const legacyHash = canonicalHash(finding);
    appendFindingLedger({
      storyId,
      store: ledgerStore,
      operation: 'append_legacy_identity_binding',
      idempotencyKey: `legacy-finding-binding:${finding.id}:${legacyHash}`,
      records: [{
        recordType: 'legacy_identity_binding',
        payload: {
          schemaVersion: 1,
          bindingType: 'legacy-finding',
          findingId: finding.id,
          findingHash: legacyHash,
        },
        uniqueBindingKey: `legacy-finding:${finding.id}`,
      }],
      writerSessionId: getSessionIdentity().sessionId,
      writerLeaseId: readOwnerLease(ctx.store.storyDirPath(storyId))?.sessionId ?? getSessionIdentity().sessionId,
      writerFenceToken: fence.writerFenceToken,
      fence,
      signer,
    });
    ledger = ledgerStore.readFindingLedger<import('../core/finding-ledger.js').JsonValue>(storyId);
    source = ledger.records.find((record) => (
      record.recordType === 'legacy_identity_binding'
      && record.payload && typeof record.payload === 'object'
      && (record.payload as Record<string, unknown>).bindingType === 'legacy-finding'
      && (record.payload as Record<string, unknown>).findingId === finding.id
      && (record.payload as Record<string, unknown>).findingHash === legacyHash
    ));
    if (!source) throw new Error(`legacy binding publication failed for ${finding.id}`);
    finding.recordId = source.recordId;
  }
  const existing = ledger.records.find((record) => (
    record.recordType === 'finding_lifecycle_transition'
    && record.payload && typeof record.payload === 'object'
    && (record.payload as Record<string, unknown>).findingRecordId === source.recordId
  ));
  if (existing) {
    const prior = existing.payload as unknown as FindingLifecycleTransition;
    if (prior.toStatus !== input.toStatus) {
      throw new Error(`Finding ${finding.id} already has terminal status ${prior.toStatus}`);
    }
    // Reuse the exact immutable payload so the deterministic idempotency key
    // mechanically replays the original transition instead of creating a
    // second terminal fact or conflicting on a new timestamp.
    input = {
      toStatus: prior.toStatus,
      reason: prior.reason,
      resolutionType: prior.resolutionType,
      resolveEvidenceStrength: prior.resolveEvidenceStrength,
      dismissReasonType: prior.dismissReasonType,
      dismissEvidenceStrength: prior.dismissEvidenceStrength,
    };
  }
  const head = ledger.records.at(-1);
  const headId = head?.recordId ?? 'ledger:empty';
  const headHash = head ? canonicalHash(head) : canonicalHash([]);
  const predicateDigest = canonicalHash({
    schemaVersion: 1,
    predicate: 'finding-open-without-terminal-transition',
    findingId: finding.id,
    findingRecordId: source.recordId,
  });
  const transition: FindingLifecycleTransition = existing
    ? existing.payload as unknown as FindingLifecycleTransition
    : {
        schemaVersion: 1,
        transitionId: `finding-transition-${randomUUID()}`,
        findingId: finding.id,
        findingRecordId: source.recordId,
        fromStatus: 'open',
        toStatus: input.toStatus,
        at: new Date().toISOString(),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.resolutionType ? { resolutionType: input.resolutionType } : {}),
        ...(input.resolveEvidenceStrength ? { resolveEvidenceStrength: input.resolveEvidenceStrength } : {}),
        ...(input.dismissReasonType ? { dismissReasonType: input.dismissReasonType } : {}),
        ...(input.dismissEvidenceStrength ? { dismissEvidenceStrength: input.dismissEvidenceStrength } : {}),
      };
  const replayReceipt = existing
    ? ledger.receipts.find((receipt) => receipt.recordIds.includes(existing.recordId)) as (
        typeof ledger.receipts[number] & { findingLedgerReceipt?: { casBindings?: import('../core/types.js').FindingLedgerCasBinding[] } }
      ) | undefined
    : undefined;
  const casBindings = replayReceipt?.findingLedgerReceipt?.casBindings ?? [{
    recordType: source.recordType,
    expectedRecordId: source.recordId,
    expectedRecordHash: exactLedgerRecordHash(source),
    observedChainHeadId: headId,
    observedChainHeadHash: headHash,
    predicateDigest,
  }];
  appendFindingLedger({
    storyId,
    store: ledgerStore,
    operation: 'append_finding_lifecycle_transition',
    idempotencyKey: `finding-lifecycle:${source.recordId}:${input.toStatus}`,
    records: [{
      recordType: 'finding_lifecycle_transition',
      payload: transition as unknown as import('../core/finding-ledger.js').JsonValue,
      uniqueBindingKey: `finding-lifecycle:${source.recordId}`,
    }],
    writerSessionId: getSessionIdentity().sessionId,
    writerLeaseId: readOwnerLease(ctx.store.storyDirPath(storyId))?.sessionId ?? getSessionIdentity().sessionId,
    writerFenceToken: fence.writerFenceToken,
    fence,
    signer,
    casBindings,
    verifyPredicate: ({ ledger: current }) => ({
      accepted: !current.records.some((record) => (
        record.recordType === 'finding_lifecycle_transition'
        && record.payload && typeof record.payload === 'object'
        && (record.payload as Record<string, unknown>).findingRecordId === source.recordId
      )),
      predicateDigest,
    }),
  });
  return transition;
}
