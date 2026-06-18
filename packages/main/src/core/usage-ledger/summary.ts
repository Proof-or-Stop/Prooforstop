/**
 * B-253e CHK-006: informational summary reader for the LLM usage ledger.
 *
 * Implements the "Derived Totals" identity and the summary selection rules from
 * docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md
 * ("Call and Attempt Correlation Semantics", "Derived Totals", Status and
 * diagnostics touchpoint).
 *
 * INFORMATIONAL ONLY. This reader MUST NOT feed any gate. Its return type
 * carries no gate/decision/verdict field, and no gate code may consume it. It
 * exists for operator diagnostics: parse the JSONL, select the latest
 * non-superseded accounting record per (ledgerCallId + attemptId), derive the
 * total via the four-field identity, keep prompt-size-estimate records OUT of
 * provider-reported totals, and report unavailable / null dimensions as
 * unknown (never 0).
 */

import { existsSync, readFileSync } from 'node:fs';

import type { TokenDimension, UsageLedgerRecord } from './record.js';

/**
 * Fields shared by every derived per-record total, regardless of known/unknown.
 */
interface DerivedRecordTotalBase {
  recordId: string;
  ledgerCallId: string;
  attemptId: string;
  source: UsageLedgerRecord['usage']['source'];
}

/**
 * A derived per-record total, modeled as a discriminated union on `unknown` so
 * that `total` narrows to a concrete shape after a `unknown` check:
 *
 *   - `unknown: true`  => `total: null` (the source is unavailable, or a
 *     contributing dimension is null). Unknown is NEVER coerced to 0.
 *   - `unknown: false` => `total: number` (all four dimensions are known and
 *     summed).
 *
 * Because the union ties `unknown` to `total`, code that does
 * `if (item.unknown) continue;` lets TypeScript narrow the survivor to the
 * `unknown: false` member, so `item.total` is a `number` without any `?? 0`
 * fallback (which could otherwise silently turn a null total into 0).
 */
export type DerivedRecordTotal =
  | (DerivedRecordTotalBase & {
      /** True when the record carries no usable count (unavailable / all-null). */
      unknown: true;
      /** Always null when unknown — never substitute 0. */
      total: null;
    })
  | (DerivedRecordTotalBase & {
      unknown: false;
      /** Sum of the four token fields; only present when fully known. */
      total: number;
    });

export interface UsageLedgerSummary {
  /** Count of lines parsed from the ledger. */
  recordCount: number;
  /** The selected accounting record per (ledgerCallId+attemptId), derived. */
  selected: DerivedRecordTotal[];
  /**
   * Aggregate total of provider-reported selected records that have a fully
   * known total. Records with any unknown dimension are excluded from this sum
   * and surfaced via `unknownCount` instead — unknown is never treated as 0.
   */
  providerReportedTotal: number;
  /** How many selected provider-reported records contributed to the total. */
  providerReportedCount: number;
  /**
   * Estimate records are kept OUT of provider-reported totals. Their derived
   * subtotal lives here, separately, and never merges into the provider total.
   */
  estimateSubtotal: number;
  estimateCount: number;
  /** Selected records reported as unknown (unavailable / null dimensions). */
  unknownCount: number;
}

/**
 * Derive the per-record total via the identity
 * `input + output + cacheCreation + cacheRead`.
 *
 * Returns `null` (unknown) when the source is `unavailable` or when ANY of the
 * four dimensions is `null` — a null dimension is "unavailable for this
 * dimension" and must never silently become 0 in a total.
 */
export function deriveRecordTotal(record: UsageLedgerRecord): DerivedRecordTotal {
  const { usage } = record;
  const base: DerivedRecordTotalBase = {
    recordId: record.recordId,
    ledgerCallId: record.ledgerCallId,
    attemptId: record.attemptId,
    source: usage.source,
  };

  if (usage.source === 'unavailable') {
    return { ...base, total: null, unknown: true };
  }

  const dims: TokenDimension[] = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheCreationInputTokens,
    usage.cacheReadInputTokens,
  ];

  // Any null dimension makes the total unknown — never substitute 0.
  if (dims.some((d) => d === null)) {
    return { ...base, total: null, unknown: true };
  }

  const total = (dims as number[]).reduce((acc, d) => acc + d, 0);
  return { ...base, total, unknown: false };
}

function attemptKey(record: { ledgerCallId: string; attemptId: string }): string {
  return `${record.ledgerCallId} ${record.attemptId}`;
}

/**
 * Select the latest non-superseded accounting record per
 * (ledgerCallId + attemptId).
 *
 * Selection rule:
 *   1. Drop any record whose recordId appears in another record's
 *      `supersedesRecordIds` (it has been superseded).
 *   2. Among the survivors for each (call+attempt), pick the highest `sequence`.
 *
 * This prevents double-counting a preflight estimate once a provider-reported
 * final record supersedes it.
 */
export function selectLatestRecords(records: UsageLedgerRecord[]): UsageLedgerRecord[] {
  const superseded = new Set<string>();
  for (const record of records) {
    for (const id of record.supersedesRecordIds ?? []) {
      superseded.add(id);
    }
  }

  const byAttempt = new Map<string, UsageLedgerRecord>();
  for (const record of records) {
    if (superseded.has(record.recordId)) continue;
    const key = attemptKey(record);
    const existing = byAttempt.get(key);
    if (!existing || record.sequence > existing.sequence) {
      byAttempt.set(key, record);
    }
  }
  return [...byAttempt.values()];
}

/**
 * Parse JSONL ledger lines into records. Skips blank lines. Non-JSON lines
 * throw, since a corrupt ledger should be surfaced, not silently dropped.
 */
export function parseLedgerLines(content: string): UsageLedgerRecord[] {
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as UsageLedgerRecord;
    } catch {
      throw new Error(`usage-ledger summary: line ${index} is not valid JSON`);
    }
  });
}

/** Build an informational summary from a list of records. */
export function summarizeRecords(records: UsageLedgerRecord[]): UsageLedgerSummary {
  const selected = selectLatestRecords(records).map(deriveRecordTotal);

  let providerReportedTotal = 0;
  let providerReportedCount = 0;
  let estimateSubtotal = 0;
  let estimateCount = 0;
  let unknownCount = 0;

  for (const item of selected) {
    if (item.unknown) {
      unknownCount += 1;
      continue;
    }
    // `if (item.unknown) continue;` above narrowed `item` to the `unknown: false`
    // member, so `item.total` is a `number` here — no `?? 0` fallback needed.
    if (item.source === 'provider-reported') {
      providerReportedTotal += item.total;
      providerReportedCount += 1;
    } else if (item.source === 'prompt-size-estimate') {
      // Estimates are kept OUT of provider-reported totals — separate subtotal.
      estimateSubtotal += item.total;
      estimateCount += 1;
    }
  }

  return {
    recordCount: records.length,
    selected,
    providerReportedTotal,
    providerReportedCount,
    estimateSubtotal,
    estimateCount,
    unknownCount,
  };
}

/**
 * Read and summarize a ledger file. Returns an empty summary when the file does
 * not exist (an absent ledger is "no usage recorded", not an error).
 */
export function summarizeLedgerFile(ledgerPath: string): UsageLedgerSummary {
  if (!existsSync(ledgerPath)) {
    return {
      recordCount: 0,
      selected: [],
      providerReportedTotal: 0,
      providerReportedCount: 0,
      estimateSubtotal: 0,
      estimateCount: 0,
      unknownCount: 0,
    };
  }
  return summarizeRecords(parseLedgerLines(readFileSync(ledgerPath, 'utf8')));
}
