/**
 * B-253e CHK-002 / CHK-004 / CHK-006: the single append-only writer for the LLM
 * usage ledger — the completeness choke-point.
 *
 * This module is the ONLY code that writes `.lattice/usage/llm-usage.jsonl`.
 * `fs` access to the ledger is private to this module: callers hand a record to
 * `appendUsageRecord` and never touch the file directly. The smoke test asserts
 * no other module under `core/` references the ledger path or appends to it.
 *
 * Responsibilities (per "JSONL Ledger Record Shape", "Required record
 * constraints", "Completeness Guarantee", "Privacy Constraints"):
 *   - opt-in gate (CHK-006): a strict no-op when the flag is OFF — writes
 *     nothing and creates no file/directory;
 *   - ensure `.lattice/usage/` exists;
 *   - validate the record (CHK-001) and reject privacy/secret/raw-content and
 *     stored-total fields (CHK-004) before any write;
 *   - compute `recordHash` over the canonical record minus `recordHash`, and
 *     chain `previousRecordHash` from the prior line's `recordHash` (genesis =
 *     null);
 *   - append EXACTLY one JSON line; never rewrite or edit prior lines.
 *
 * This slice is FOUNDATION only: no provider adapters, no live dispatch, no
 * estimate computation, no budget enforcement, no Authority receipt path.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { canonicalJson } from './canonical-json.js';
import {
  type UsageLedgerRecord,
  type UsageLedgerRecordInput,
  validateUsageLedgerRecord,
} from './record.js';

/** Relative path of the ledger from the project root. */
export const USAGE_LEDGER_DIR = join('.lattice', 'usage');
export const USAGE_LEDGER_FILENAME = 'llm-usage.jsonl';
export const USAGE_LEDGER_RELATIVE_PATH = join(USAGE_LEDGER_DIR, USAGE_LEDGER_FILENAME);

/**
 * Genesis sentinel for the first record's `previousRecordHash`. Stored as JSON
 * `null` on the record; this constant documents the genesis value.
 */
export const GENESIS_PREVIOUS_HASH = null;

/**
 * Opt-in flag (CHK-006). Default ON; set LATTICE_USAGE_LEDGER=0 to disable.
 * When the flag is UNSET the ledger is active by default; the explicit escape
 * hatch ('0'/'false'/'off'/'no'/'', and the legacy KOALA_ alias) restores the
 * byte-identical legacy default-off behavior (a strict no-op writer + the
 * original spawn args + an inert budget guard).
 *
 * Read every call (not memoized) so tests and operators can toggle it without
 * restarting the process. Both the Lattice-branded and legacy Koala env names
 * are honored, matching the repo's dual-brand env convention.
 */
export function isUsageLedgerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.LATTICE_USAGE_LEDGER ?? env.KOALA_USAGE_LEDGER;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

/**
 * Compute the record hash: sha256 over the canonical record with the
 * `integrity.recordHash` field removed (but `previousRecordHash` retained, so
 * the chain link is bound into the hash). Returns a `sha256:<hex>` string.
 */
export function computeRecordHash(record: UsageLedgerRecord): string {
  const forHashing: Record<string, unknown> = { ...record };
  const integrity = { ...(record.integrity ?? {}) } as Record<string, unknown>;
  delete integrity.recordHash;
  forHashing.integrity = integrity;
  const digest = createHash('sha256').update(canonicalJson(forHashing), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

/** Resolve the absolute ledger file path under a project root. */
export function resolveLedgerPath(projectRoot: string): string {
  return join(projectRoot, USAGE_LEDGER_RELATIVE_PATH);
}

/**
 * Read the last line's `recordHash` to chain from. Returns `null` when the file
 * is absent or empty (genesis). Throws when the last line is unparseable or is
 * missing a `recordHash` — a chain cannot be built from a corrupt predecessor.
 */
function readLastRecordHash(ledgerPath: string): string | null {
  if (!existsSync(ledgerPath)) return null;
  const content = readFileSync(ledgerPath, 'utf8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  const lastLine = lines[lines.length - 1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    throw new Error('usage-ledger: cannot chain from a corrupt last line (unparseable JSON)');
  }
  const hash = (parsed as { integrity?: { recordHash?: unknown } })?.integrity?.recordHash;
  if (typeof hash !== 'string' || hash.length === 0) {
    throw new Error('usage-ledger: last line is missing integrity.recordHash; cannot chain');
  }
  return hash;
}

export interface AppendResult {
  /** false when the opt-in flag was OFF (strict no-op). */
  written: boolean;
  /** The finalized record (with computed integrity), when written. */
  record?: UsageLedgerRecord;
  /** Absolute path written to, when written. */
  path?: string;
}

export interface AppendOptions {
  /** Override env for the opt-in flag check (tests). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Append exactly one record to the ledger. THE single write choke-point.
 *
 * Behaviour:
 *   - flag OFF -> strict no-op (returns {written:false}, no file, no dir);
 *   - validates the record and the privacy/secret denylist; THROWS on any
 *     violation BEFORE writing (no partial line);
 *   - computes `recordHash`, chains `previousRecordHash` from the prior line
 *     (genesis = null), overwriting any caller-supplied integrity so a caller
 *     cannot forge or inject a hash;
 *   - appends one newline-terminated JSON line; never edits prior lines.
 */
export function appendUsageRecord(
  projectRoot: string,
  input: UsageLedgerRecordInput,
  options: AppendOptions = {},
): AppendResult {
  // CHK-006: strict no-op when disabled. No file, no directory, no side effects.
  if (!isUsageLedgerEnabled(options.env)) {
    return { written: false };
  }

  // Validate the caller-supplied record body BEFORE chaining. Integrity is
  // computed by the writer, so it is not required of the caller here. This also
  // runs the CHK-004 privacy/secret/stored-total deep scan.
  const preCheck = validateUsageLedgerRecord(stripIntegrity(input), { expectIntegrity: false });
  if (!preCheck.ok) {
    throw new Error(`usage-ledger: refused to write invalid record:\n - ${preCheck.errors.join('\n - ')}`);
  }

  const ledgerPath = resolveLedgerPath(projectRoot);
  mkdirSync(dirname(ledgerPath), { recursive: true });

  // Chain from the prior line. A corrupt predecessor throws here, before write.
  const previousRecordHash = readLastRecordHash(ledgerPath);

  // Build the finalized record. The writer OWNS integrity: any caller-supplied
  // recordHash/previousRecordHash is discarded so a caller cannot forge it.
  const finalized: UsageLedgerRecord = {
    ...(input as Omit<UsageLedgerRecord, 'integrity'>),
    integrity: {
      previousRecordHash,
      recordHash: '', // filled below
    },
  };
  finalized.integrity.recordHash = computeRecordHash(finalized);

  // Defense in depth: validate the finalized record WITH integrity. This also
  // re-runs the privacy/stored-total scan on the exact bytes about to be written.
  const finalCheck = validateUsageLedgerRecord(finalized, { expectIntegrity: true });
  if (!finalCheck.ok) {
    throw new Error(`usage-ledger: finalized record failed validation:\n - ${finalCheck.errors.join('\n - ')}`);
  }

  // Append EXACTLY one line. Never rewrite or edit prior lines.
  appendFileSync(ledgerPath, `${JSON.stringify(finalized)}\n`, 'utf8');

  return { written: true, record: finalized, path: ledgerPath };
}

function stripIntegrity(input: UsageLedgerRecordInput): Omit<UsageLedgerRecordInput, 'integrity'> {
  const { integrity: _integrity, ...rest } = input;
  return rest;
}

/**
 * Verify the hash chain of a ledger file (tamper detection). Returns the parsed
 * records when valid; throws with the offending line index when a recomputed
 * `recordHash` does not match, or when `previousRecordHash` does not match the
 * predecessor's `recordHash`. This is local tamper evidence only — it does NOT
 * make the ledger Authority evidence.
 */
export function verifyLedgerChain(ledgerPath: string): UsageLedgerRecord[] {
  if (!existsSync(ledgerPath)) return [];
  const content = readFileSync(ledgerPath, 'utf8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  const records: UsageLedgerRecord[] = [];
  let expectedPrevious: string | null = GENESIS_PREVIOUS_HASH;

  lines.forEach((line, index) => {
    let record: UsageLedgerRecord;
    try {
      record = JSON.parse(line) as UsageLedgerRecord;
    } catch {
      throw new Error(`usage-ledger: line ${index} is not valid JSON`);
    }
    const recomputed = computeRecordHash(record);
    if (recomputed !== record.integrity?.recordHash) {
      throw new Error(`usage-ledger: line ${index} recordHash mismatch (tampered content)`);
    }
    if ((record.integrity?.previousRecordHash ?? null) !== expectedPrevious) {
      throw new Error(`usage-ledger: line ${index} previousRecordHash breaks the chain (tampered predecessor)`);
    }
    expectedPrevious = record.integrity.recordHash;
    records.push(record);
  });

  return records;
}
