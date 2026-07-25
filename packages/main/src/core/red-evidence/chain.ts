// §3.1-§3.3 chain plane for the trusted RED-evidence subsystem (W2c / B-506e).
//
// Spec: docs/requirements/decisions/red-evidence-subsystem-spec.md §3.1-§3.3
// (lines 937-998) and §4.1 (lines 1122-1142). Records live in ONE append-only
// `records[]`; LOGICALLY they form independent supersedes chains keyed by
// `(storyId, acceptanceTargetRef)`. All chain logic here is per-target.
//
// The three integrity checks (§3.3) each carry their OWN reason id so a store
// corruption / concurrency FORK (check 3) is diagnosably distinct from a broken
// prior-digest LINK (check 2).

import {
  isRedEvidenceV2,
  type RedEvidenceOperation,
  type RedEvidenceRecordV2,
} from './record-v2.js';

// ── Rejection reason ids (each integrity failure mode is independently named) ──
export const REASON_SEQ_INVALID = 'red-evidence-chain-seq-invalid' as const;
export const REASON_PRIOR_DIGEST_MISMATCH = 'red-evidence-prior-digest-mismatch' as const;
export const REASON_CHAIN_FORK = 'red-evidence-chain-fork' as const;
export const REASON_ILLEGAL_TRANSITION = 'red-evidence-illegal-transition' as const;

/**
 * The per-target chain of a store's `records[]`: every v2 record whose
 * `(storyId, acceptanceTargetRef)` matches, in stored order. Non-v2 (legacy v1)
 * records never participate in a v2 chain. Matching is CASE-SENSITIVE.
 */
export function partitionChain(
  records: readonly unknown[],
  storyId: string,
  acceptanceTargetRef: string,
): RedEvidenceRecordV2[] {
  const chain: RedEvidenceRecordV2[] = [];
  for (const record of records) {
    if (!isRedEvidenceV2(record)) continue;
    if (record.storyId === storyId && record.acceptanceTargetRef === acceptanceTargetRef) {
      chain.push(record);
    }
  }
  return chain;
}

/**
 * §3.2 CHAIN-HEAD: the unique record of a target chain that (a) is NOT referenced
 * by any other record's `priorRecordDigest` AND (b) has the maximal `seq`. A
 * well-formed chain has exactly one head. Returns `null` for an empty chain.
 *
 * BOTH conjuncts are enforced: a record that satisfies (a) but not (b) — or vice
 * versa — is not returned; a chain with zero or more than one such record is
 * malformed and yields `null` (callers surface this as corrupt-chain).
 */
export function resolveChainHead(chain: readonly RedEvidenceRecordV2[]): RedEvidenceRecordV2 | null {
  if (chain.length === 0) return null;
  const consumedPriorDigests = new Set<string>();
  for (const record of chain) {
    if (typeof record.priorRecordDigest === 'string') consumedPriorDigests.add(record.priorRecordDigest);
  }
  const maxSeq = Math.max(...chain.map((r) => r.seq));
  const heads = chain.filter(
    (record) => !consumedPriorDigests.has(record.recordDigest) && record.seq === maxSeq,
  );
  return heads.length === 1 ? heads[0] : null;
}

export interface ChainIntegrityResult {
  ok: boolean;
  reasonId?: string;
  message?: string;
}

/**
 * §3.3 the three required integrity checks on `newRecord` against its target
 * chain (`chain` = the records already present, `head` = its resolved head, or
 * `null` when empty). ALL THREE must hold. Each failure carries its own reason id.
 */
export function checkChainIntegrity(
  chain: readonly RedEvidenceRecordV2[],
  head: RedEvidenceRecordV2 | null,
  newRecord: Pick<RedEvidenceRecordV2, 'seq' | 'priorRecordDigest'>,
): ChainIntegrityResult {
  // 1. Monotonic seq — exactly head.seq + 1 (1 iff the chain is empty).
  const expectedSeq = head ? head.seq + 1 : 1;
  if (newRecord.seq !== expectedSeq) {
    return {
      ok: false,
      reasonId: REASON_SEQ_INVALID,
      message: `seq ${newRecord.seq} is not exactly ${expectedSeq} (head.seq${head ? `=${head.seq}` : ' empty'} + 1); no gaps, no reuse`,
    };
  }
  // 2. Prior-digest link — resolves to the current head's canonical digest
  //    (null iff empty).
  const expectedPrior = head ? head.recordDigest : null;
  if (newRecord.priorRecordDigest !== expectedPrior) {
    return {
      ok: false,
      reasonId: REASON_PRIOR_DIGEST_MISMATCH,
      message: `priorRecordDigest ${JSON.stringify(newRecord.priorRecordDigest)} does not link to the current head ${JSON.stringify(expectedPrior)}`,
    };
  }
  // 3. Fork rejection — no EXISTING record already claims newRecord's
  //    priorRecordDigest as ITS priorRecordDigest (independent of check 2).
  if (newRecord.priorRecordDigest !== null) {
    const forked = chain.some((record) => record.priorRecordDigest === newRecord.priorRecordDigest);
    if (forked) {
      return {
        ok: false,
        reasonId: REASON_CHAIN_FORK,
        message: `prior digest ${newRecord.priorRecordDigest} is already consumed by another record — a second record claiming it is a fork (store corruption / concurrency)`,
      };
    }
  }
  return { ok: true };
}

/**
 * §3.3 / §4.1 effective-head RECORD resolution. Returns the head record itself,
 * EXCEPT a `recover` head resolves to the record it reinstates, walked
 * TRANSITIVELY through chained recovers. Cycle-safe: a self-referential or
 * looping recover chain TERMINATES (a `visited` set stops the walk on a repeat).
 *
 * Returns `null` when the chain has no head. This is the single source of truth
 * for the effective head; {@link effectiveHeadOperation} and
 * {@link resolveGoverningRedAssert} both project from it.
 */
function resolveEffectiveHeadRecord(
  chain: readonly RedEvidenceRecordV2[],
  head: RedEvidenceRecordV2 | null,
): RedEvidenceRecordV2 | null {
  if (!head) return null;
  const byId = new Map<string, RedEvidenceRecordV2>(chain.map((record) => [record.id, record]));
  const visited = new Set<string>();
  let current: RedEvidenceRecordV2 | undefined = head;
  while (current && current.operation === 'recover') {
    if (visited.has(current.id)) break; // cycle — terminate, do not recurse forever
    visited.add(current.id);
    // A recover references the quarantine it undoes; that quarantine references
    // the record it retired. Reinstating the recover re-exposes that record.
    const quarantine: RedEvidenceRecordV2 | undefined = byId.get(current.recoversRecordId);
    if (!quarantine || quarantine.operation !== 'quarantine') break;
    const reinstated: RedEvidenceRecordV2 | undefined = byId.get(quarantine.recoversRecordId);
    if (!reinstated) break;
    current = reinstated;
  }
  return current ?? null;
}

/**
 * §3.3 / §4.1 effective head operation. The head's operation, EXCEPT a `recover`
 * head resolves to the operation of the record it reinstates, walked
 * TRANSITIVELY through chained recovers. Cycle-safe (see
 * {@link resolveEffectiveHeadRecord}).
 *
 * Returns `'empty'` when the chain has no head.
 */
export function effectiveHeadOperation(
  chain: readonly RedEvidenceRecordV2[],
  head: RedEvidenceRecordV2 | null,
): RedEvidenceOperation | 'empty' {
  const record = resolveEffectiveHeadRecord(chain, head);
  return record ? record.operation : 'empty';
}

/**
 * §3.3 governing-red-assert derivation. The red-assert record that currently
 * governs a chain — the record every green-confirm on this chain must confirm.
 * It is the EFFECTIVE head when that resolves to a `red-assert`; when the
 * effective head is a `green-confirm` it is the red-assert that green-confirm
 * names via `confirmsRecordId` (a re-confirmation governs through its own
 * confirmed assertion). Returns `null` when no red-assert governs (empty chain,
 * a broken/cyclic recover residue, or a green-confirm whose `confirmsRecordId`
 * does not resolve to a red-assert).
 */
export function resolveGoverningRedAssert(
  chain: readonly RedEvidenceRecordV2[],
  head: RedEvidenceRecordV2 | null,
): RedEvidenceRecordV2 | null {
  const effective = resolveEffectiveHeadRecord(chain, head);
  if (!effective) return null;
  if (effective.operation === 'red-assert') return effective;
  if (effective.operation === 'green-confirm') {
    const byId = new Map<string, RedEvidenceRecordV2>(chain.map((record) => [record.id, record]));
    const governed = byId.get(effective.confirmsRecordId);
    return governed && governed.operation === 'red-assert' ? governed : null;
  }
  return null;
}

/**
 * §3.3 closed transition table. Legal next operations per EFFECTIVE head
 * operation. Anything not listed is REJECTED. (`recover` never appears as an
 * effective op — it is resolved by {@link effectiveHeadOperation} — so a residual
 * `'recover'`, only reachable on a broken cycle, admits nothing.)
 */
const TRANSITION_TABLE: Record<RedEvidenceOperation | 'empty', ReadonlySet<RedEvidenceOperation>> = {
  empty: new Set<RedEvidenceOperation>(['red-assert']),
  'red-assert': new Set<RedEvidenceOperation>(['green-confirm', 'red-assert', 'quarantine']),
  'green-confirm': new Set<RedEvidenceOperation>(['red-assert', 'green-confirm', 'quarantine']),
  quarantine: new Set<RedEvidenceOperation>(['recover', 'red-assert']),
  recover: new Set<RedEvidenceOperation>(),
};

/** True iff appending `next` is legal given the chain's effective head operation. */
export function isTransitionLegal(
  effectiveHeadOp: RedEvidenceOperation | 'empty',
  next: RedEvidenceOperation,
): boolean {
  return TRANSITION_TABLE[effectiveHeadOp].has(next);
}

/**
 * §3.3 green-confirm TARGET legality. A green-confirm candidate is ADMISSIBLE
 * only when BOTH (a) `green-confirm` is a legal successor of the chain's
 * effective head operation AND (b) its `confirmsRecordId` names the chain's
 * current governing red-assert (see {@link resolveGoverningRedAssert}). A
 * candidate whose `confirmsRecordId` is a foreign or stale id is REJECTED with
 * {@link REASON_ILLEGAL_TRANSITION}, regardless of chain ordering — the
 * green-confirm must confirm the SAME governing assertion, not an old or foreign
 * one. (The green-confirm WRITER is W2e; this is the append-validation predicate
 * it will call, exercisable in isolation over a synthetic `records[]` fixture.)
 */
export function checkGreenConfirmTarget(
  chain: readonly RedEvidenceRecordV2[],
  head: RedEvidenceRecordV2 | null,
  candidate: { confirmsRecordId: string },
): ChainIntegrityResult {
  const effectiveOp = effectiveHeadOperation(chain, head);
  if (!isTransitionLegal(effectiveOp, 'green-confirm')) {
    return {
      ok: false,
      reasonId: REASON_ILLEGAL_TRANSITION,
      message: `green-confirm refused: illegal transition from effective head operation "${effectiveOp}"`,
    };
  }
  const governing = resolveGoverningRedAssert(chain, head);
  if (!governing) {
    return {
      ok: false,
      reasonId: REASON_ILLEGAL_TRANSITION,
      message: 'green-confirm refused: no governing red-assert resolves for this chain',
    };
  }
  if (candidate.confirmsRecordId !== governing.id) {
    return {
      ok: false,
      reasonId: REASON_ILLEGAL_TRANSITION,
      message: `green-confirm refused: confirmsRecordId ${JSON.stringify(candidate.confirmsRecordId)} does not name the current governing red-assert ${JSON.stringify(governing.id)}`,
    };
  }
  return { ok: true };
}

/**
 * §3.6 / §4.1 retirement predicate for dedupe scoping. A record is RETIRED iff a
 * later `quarantine` record references it (`recoversRecordId === record.id`) AND
 * no `recover` record reinstates that quarantine (`recoversRecordId ===
 * quarantine.id`). A retired (quarantined-and-not-recovered) record is EXCLUDED
 * from the dedupe search so a deliberate replacement append is not swallowed by
 * the quarantined original (§3.6 / CHK-008).
 */
export function isRetiredByQuarantine(
  record: RedEvidenceRecordV2,
  chain: readonly RedEvidenceRecordV2[],
): boolean {
  const quarantines = chain.filter(
    (r) => r.operation === 'quarantine' && 'recoversRecordId' in r && r.recoversRecordId === record.id,
  );
  if (quarantines.length === 0) return false;
  // Retired unless SOME quarantine of this record is itself reinstated by a recover.
  const reinstatedQuarantineIds = new Set(
    chain
      .filter((r) => r.operation === 'recover' && 'recoversRecordId' in r)
      .map((r) => (r as { recoversRecordId: string }).recoversRecordId),
  );
  return !quarantines.some((q) => reinstatedQuarantineIds.has(q.id));
}
