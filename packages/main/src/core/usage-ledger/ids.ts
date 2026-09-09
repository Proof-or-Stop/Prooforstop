/**
 * B-253e CHK-003: correlation-id minting helpers for the LLM usage ledger.
 *
 * Implements "Call and Attempt Correlation Semantics" from
 * docs/requirements/decisions/proof-or-stop-identity-cutover.md.
 *
 * Identity is minted LOCALLY by Proof-or-Stop BEFORE any provider dispatch. Crucially,
 * `ledgerCallId` and `attemptId` must NEVER be derived from
 * `provider.requestIdHash` — a preflight estimate or a blocked refusal has no
 * provider request yet, so a provider-derived id could not exist there. The
 * mint functions therefore take NO provider input at all.
 *
 * This module owns id minting + a per-(call+attempt) monotonic sequence counter
 * and the supersedes wiring helper. It does not write files and does not
 * dispatch.
 */

import { randomUUID } from 'node:crypto';

export const LEDGER_CALL_ID_PREFIX = 'llmcall_';
export const ATTEMPT_ID_PREFIX = 'llmatt_';
export const RECORD_ID_PREFIX = 'llmuse_';

function mintId(prefix: string): string {
  // randomUUID() is collision-resistant under concurrency; the prefix makes the
  // id self-describing in the JSONL. No provider input is accepted by design.
  return `${prefix}${randomUUID()}`;
}

/**
 * Mint a stable id for one logical LLM call, BEFORE preflight budget checks.
 * Reused by every record for that logical call (preflight, blocked, postflight).
 *
 * Takes no arguments: it must not be derivable from any provider request id.
 */
export function mintLedgerCallId(): string {
  return mintId(LEDGER_CALL_ID_PREFIX);
}

/**
 * Mint a stable id for one execution attempt within a `ledgerCallId`. Retries
 * reuse the same `ledgerCallId` and call this again for a fresh `attemptId`.
 */
export function mintAttemptId(): string {
  return mintId(ATTEMPT_ID_PREFIX);
}

/** Mint a unique id for a single ledger record line. */
export function mintRecordId(): string {
  return mintId(RECORD_ID_PREFIX);
}

function sequenceKey(ledgerCallId: string, attemptId: string): string {
  return `${ledgerCallId}\u0000${attemptId}`;
}

/**
 * Per-(ledgerCallId + attemptId) monotonic sequence allocator.
 *
 * `sequence` is a positive integer ordered WITHIN the same call+attempt: the
 * preflight estimate comes before the blocked refusal / final record for that
 * attempt. A NEW attemptId under the same ledgerCallId restarts the sequence at
 * 1 (sequence is per-attempt, not per-call).
 *
 * The allocator is in-memory and process-local. It guarantees monotonicity
 * within a process; it never accepts a caller-supplied non-monotonic value.
 */
export class SequenceAllocator {
  private readonly counters = new Map<string, number>();

  /** Return the next sequence (1-based) for this call+attempt. */
  next(ledgerCallId: string, attemptId: string): number {
    const key = sequenceKey(ledgerCallId, attemptId);
    const current = this.counters.get(key) ?? 0;
    const next = current + 1;
    this.counters.set(key, next);
    return next;
  }

  /** Peek the last allocated sequence (0 if none allocated yet). */
  peek(ledgerCallId: string, attemptId: string): number {
    return this.counters.get(sequenceKey(ledgerCallId, attemptId)) ?? 0;
  }

  /** Forget a call+attempt's counter (e.g. once the attempt is finalized). */
  reset(ledgerCallId: string, attemptId: string): void {
    this.counters.delete(sequenceKey(ledgerCallId, attemptId));
  }
}

/**
 * Build a `supersedesRecordIds` array. Filters falsy/duplicate ids and always
 * returns a fresh array (never shares a reference with the input). An empty
 * input yields `[]` — the field is required and "supersedes nothing" is `[]`,
 * not omission.
 */
export function buildSupersedes(...recordIds: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of recordIds) {
    if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Stable correlation handle minted before dispatch. A caller mints one of these
 * for a logical call, then issues one or more records (preflight, postflight)
 * that all share `ledgerCallId` + `attemptId` with increasing `sequence`.
 */
export interface CallCorrelation {
  ledgerCallId: string;
  attemptId: string;
}

/** Mint a fresh call+attempt correlation handle before any dispatch. */
export function mintCallCorrelation(): CallCorrelation {
  return { ledgerCallId: mintLedgerCallId(), attemptId: mintAttemptId() };
}

/** Mint a new attempt under an existing logical call (retry semantics). */
export function mintRetryAttempt(ledgerCallId: string): CallCorrelation {
  return { ledgerCallId, attemptId: mintAttemptId() };
}
