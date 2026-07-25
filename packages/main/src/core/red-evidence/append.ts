// §3.5 / §4.1 chain-append pipeline for the trusted RED-evidence subsystem
// (W2c / B-506e).
//
// Spec: docs/requirements/decisions/red-evidence-subsystem-spec.md §3.5
// (lines 1051-1075) and §4.1 (lines 1122-1171). The mandated ORDER is:
//   derive key (caller) -> dedupe search -> replay short-circuit -> resolve head
//   -> reference/transition legality -> integrity checks -> append.
//
// §4.1 known-limitation mitigation: the owner lease is NOT yet a same-owner
// mutex, so ALL chain appends are serialized under ONE atomic mkdir claim — the
// same primitive the transition orchestrator uses (acquireMkdirLock,
// mkdir-lock.ts:253, via withMkdirLock:477) — covering read-head, dedupe,
// validate, and write. This closes the two-process race (RED signal B): a loser
// acquires the claim only after the winner's append is durable, re-reads the
// now-advanced head, and is rejected because its referenced record is no longer
// the head — exactly one record, one head.

import type { RedEvidenceData } from '../types.js';
import { canonDigest } from './canon.js';
import { withMkdirLock } from '../mkdir-lock.js';
import {
  computeRecordDigest,
  first12hex,
  isControlRecordV2,
  recordDigestMatches,
  RED_EVIDENCE_FILE_SCHEMA_VERSION,
  RED_EVIDENCE_V2_SCHEMA_VERSION,
  type ControlRecordV2,
  type RedEvidenceOperation,
  type RedEvidenceRecordV2,
} from './record-v2.js';
import { controlOperationKey, deriveRecordId, normalizeReason } from './operation-key.js';
import {
  checkChainIntegrity,
  effectiveHeadOperation,
  isRetiredByQuarantine,
  isTransitionLegal,
  partitionChain,
  resolveChainHead,
  REASON_ILLEGAL_TRANSITION,
} from './chain.js';

/** Error tag for a store whose own key/id/digest do not recompute (§3.5). */
export const REASON_STORE_CORRUPTION = 'red-evidence-store-corruption' as const;
/** Error tag for a reference that is not the current head in the required state (§4.1). */
export const REASON_REFERENCE_INVALID = 'red-evidence-reference-invalid' as const;
/** Error tag for a store whose non-empty chain has no unique head (§3.2). */
export const REASON_CORRUPT_CHAIN = 'red-evidence-corrupt-chain' as const;

/** A tagged chain-append error carrying a machine-readable `reasonId`. */
export class RedEvidenceChainError extends Error {
  constructor(public readonly reasonId: string, message: string) {
    super(message);
    this.name = 'RedEvidenceChainError';
  }
}

/** The minimal StoryStore surface the append pipeline depends on. */
export interface RedEvidenceChainStore {
  readRedEvidence(storyId: string): RedEvidenceData | null;
  writeRedEvidence(storyId: string, data: RedEvidenceData): void;
  runtimeLockDirPath(storyId: string, category: string, name: string): string;
}

export interface AppendControlRecordInput {
  store: RedEvidenceChainStore;
  storyId: string;
  acceptanceTargetRef: string;
  operation: 'quarantine' | 'recover';
  operationKey: string;
  recoversRecordId: string;
  referencedRecordDigest: string;
  linkKind: 'quarantines' | 'recovers';
  reason: string;
  approvedBy: string;
  /**
   * §4.1 reference validation (checked UNDER the lock): the current head MUST be
   * the record named by `recoversRecordId`, and its LITERAL operation MUST be one
   * of these. Quarantine: {red-assert, green-confirm, recover}. Recover:
   * {quarantine}.
   */
  requiredHeadOperations: readonly RedEvidenceOperation[];
  now?: string;
}

export interface AppendResult {
  record: RedEvidenceRecordV2;
  /** True iff a §3.5 replay short-circuit returned an existing record (no write). */
  replayed: boolean;
}

/** A per-(story,target) lock dir under the gitignored runtime lock prefix. */
function chainLockDir(store: RedEvidenceChainStore, storyId: string, acceptanceTargetRef: string): string {
  // A CANON-derived name is filesystem-safe AND collision-free across targets.
  const name = `chain-${first12hex(canonDigest(acceptanceTargetRef))}`;
  return store.runtimeLockDirPath(storyId, 'red-evidence-chain', name);
}

function emptyRedEvidenceData(storyId: string, now: string): RedEvidenceData {
  return {
    schemaVersion: RED_EVIDENCE_FILE_SCHEMA_VERSION,
    storyId,
    records: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * §3.5 store-corruption detector: a stored control record whose own key/id/digest
 * do not recompute from its stored fields surfaces a CONFLICT at append time
 * (nothing written), rather than silently propagating.
 */
function assertStoredControlRecordConsistent(record: RedEvidenceRecordV2): void {
  if (!recordDigestMatches(record)) {
    throw new RedEvidenceChainError(
      REASON_STORE_CORRUPTION,
      `stored record ${record.id} recordDigest does not recompute from its own bytes (store corruption)`,
    );
  }
  if (!isControlRecordV2(record)) return; // run-record key derivation is W2d/W2e's contract
  const recomputedKey = controlOperationKey({
    operation: record.operation,
    storyId: record.storyId,
    acceptanceTargetRef: record.acceptanceTargetRef,
    recoversRecordId: record.recoversRecordId,
    referencedRecordDigest: record.referencedRecordDigest,
    reason: record.reason,
  });
  if (recomputedKey !== record.operationKey) {
    throw new RedEvidenceChainError(
      REASON_STORE_CORRUPTION,
      `stored record ${record.id} operationKey does not recompute from its stored key fields (store corruption)`,
    );
  }
  const recomputedId = deriveRecordId(record.operation, record.operationKey, record.seq);
  if (recomputedId !== record.id) {
    throw new RedEvidenceChainError(
      REASON_STORE_CORRUPTION,
      `stored record id ${record.id} does not derive from its operationKey + seq (store corruption)`,
    );
  }
}

/**
 * Append a quarantine / recover control record to its target chain, serialized
 * under one atomic mkdir claim. Returns the existing record with `replayed:true`
 * on a §3.5 dedupe hit (no write, chain unchanged).
 */
export function appendControlRecord(input: AppendControlRecordInput): AppendResult {
  const now = input.now ?? new Date().toISOString();
  const lockDir = chainLockDir(input.store, input.storyId, input.acceptanceTargetRef);

  return withMkdirLock(
    lockDir,
    () => {
      const data = input.store.readRedEvidence(input.storyId) ?? emptyRedEvidenceData(input.storyId, now);
      const records = data.records;
      const chain = partitionChain(records, input.storyId, input.acceptanceTargetRef);

      // ── §3.5 dedupe search (scoped: retired records are excluded so a
      // deliberate replacement is never swallowed, §3.6). A retired-record check
      // is unnecessary for control records here because the search key embeds the
      // operation, but the scope is applied uniformly for correctness.
      const dedupeHit = chain.find(
        (record) => record.operationKey === input.operationKey && !isRetiredByQuarantine(record, chain),
      );
      if (dedupeHit) {
        assertStoredControlRecordConsistent(dedupeHit); // CONFLICT if it does not recompute
        return { record: dedupeHit, replayed: true };
      }

      // ── resolve head (§3.2). A non-empty chain with no unique head is corrupt.
      const head = resolveChainHead(chain);
      if (chain.length > 0 && head === null) {
        throw new RedEvidenceChainError(
          REASON_CORRUPT_CHAIN,
          `target chain for ${input.storyId}/${input.acceptanceTargetRef} has no unique head (§3.2 corrupt-chain)`,
        );
      }

      // ── §4.1 reference validation (under the lock — TOCTOU-safe).
      if (head === null) {
        throw new RedEvidenceChainError(
          REASON_REFERENCE_INVALID,
          `${input.operation} refused: target chain is empty — there is no head to reference`,
        );
      }
      if (head.id !== input.recoversRecordId) {
        throw new RedEvidenceChainError(
          REASON_REFERENCE_INVALID,
          `${input.operation} refused: referenced record ${input.recoversRecordId} is not the current chain head ${head.id}`,
        );
      }
      if (!input.requiredHeadOperations.includes(head.operation)) {
        throw new RedEvidenceChainError(
          REASON_REFERENCE_INVALID,
          `${input.operation} refused: current head operation "${head.operation}" is not one of {${input.requiredHeadOperations.join(', ')}}`,
        );
      }
      if (head.recordDigest !== input.referencedRecordDigest) {
        throw new RedEvidenceChainError(
          REASON_REFERENCE_INVALID,
          `${input.operation} refused: referencedRecordDigest does not match the current head digest`,
        );
      }

      // ── transition legality via the EFFECTIVE head operation (§3.3 table).
      const effectiveOp = effectiveHeadOperation(chain, head);
      if (!isTransitionLegal(effectiveOp, input.operation)) {
        throw new RedEvidenceChainError(
          REASON_ILLEGAL_TRANSITION,
          `${input.operation} refused: illegal transition from effective head operation "${effectiveOp}"`,
        );
      }

      // ── chain placement + deterministic id (§3.4).
      const seq = head.seq + 1;
      const priorRecordDigest = head.recordDigest;
      const supersedes = head.id;
      const recordId = deriveRecordId(input.operation, input.operationKey, seq);

      const draft: Omit<ControlRecordV2, 'recordDigest'> = {
        id: recordId,
        schemaVersion: RED_EVIDENCE_V2_SCHEMA_VERSION,
        operation: input.operation,
        seq,
        priorRecordDigest,
        supersedes,
        storyId: input.storyId,
        acceptanceTargetRef: input.acceptanceTargetRef,
        recoversRecordId: input.recoversRecordId,
        referencedRecordDigest: input.referencedRecordDigest,
        linkKind: input.linkKind,
        reason: input.reason,
        approvedBy: input.approvedBy,
        operationKey: input.operationKey,
        createdAt: now,
      };
      const recordDigest = computeRecordDigest(draft as unknown as Record<string, unknown>);
      // Runtime: operation + linkKind are a matched pair, so this IS a
      // QuarantineRecordV2 | RecoverRecordV2; the union narrows via the operation
      // discriminator that TS cannot statically prove from the union-typed input.
      const record = { ...draft, recordDigest } as RedEvidenceRecordV2;

      // ── §3.3 integrity checks (defense — must pass by construction).
      const integrity = checkChainIntegrity(chain, head, record);
      if (!integrity.ok) {
        throw new RedEvidenceChainError(
          integrity.reasonId ?? 'red-evidence-integrity-failure',
          `${input.operation} refused: ${integrity.message}`,
        );
      }

      // ── append + write (one atomic mkdir claim covers read-head..write).
      const updated: RedEvidenceData = {
        ...data,
        records: [...records, record],
        updatedAt: now,
      };
      input.store.writeRedEvidence(input.storyId, updated);
      return { record, replayed: false };
    },
    { label: 'red-evidence chain append' },
  );
}
