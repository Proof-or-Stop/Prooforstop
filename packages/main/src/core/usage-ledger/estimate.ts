/**
 * B-a5c9 (Slice 3): the LLM usage ledger preflight ESTIMATE path.
 *
 * Implements "Usage Source Semantics", "Estimate accuracy and fallback order",
 * and the prompt-size-estimate "Required record constraints" from
 * docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md.
 *
 * This is the PURE estimate path. It computes a preflight `prompt-size-estimate`
 * token count BEFORE any provider dispatch and assembles a validated ledger
 * record body for it. It does NOT:
 *   - call any network / provider HTTP client (the real provider `count_tokens`
 *     endpoint is a PLUGGABLE, caller-INJECTED function — see selectEstimate);
 *   - wire live dispatch, budget enforcement, or the Authority receipt path;
 *   - default the ledger on (the writer's opt-in flag stays the gate).
 *
 * Boundary invariant (load-bearing): the whole `core/usage-ledger` module keeps
 * its zero-cross-module-import property. This file may import ONLY sibling
 * usage-ledger files (./record, ./ids) and node builtins. It must NOT import any
 * provider adapter, dispatch-runner, lattice-dispatch, or any other Lattice
 * subsystem. The smoke statically asserts this.
 *
 * Fallback order (spec "Estimate accuracy and fallback order"):
 *   1. count_tokens   (provider endpoint, injected) -> confidence HIGH
 *   2. local_tokenizer (local tokenizer, injected)  -> confidence MEDIUM
 *   3. bytes_chars    (offline heuristic, built-in) -> confidence LOW
 * The bytes/chars heuristic is ALWAYS available and is the lowest-confidence
 * floor; it must never be promoted above an available higher tier.
 */

import {
  SCHEMA_VERSION,
  type EstimatorConfidence,
  type LedgerUsage,
  type UsageLedgerRecordInput,
  validateUsageLedgerRecord,
} from './record.js';
import { mintRecordId } from './ids.js';

// =============================================================================
// CHK-001: estimator interface + confidence model
// =============================================================================

/**
 * The three estimator tiers, ordered highest-fidelity first. A `prompt-size-
 * estimate` record names which tier produced it via its confidence.
 */
export type EstimatorKind = 'count_tokens' | 'local_tokenizer' | 'bytes_chars';

/**
 * Strict tier ordering for the fallback chain. Index 0 is the most preferred.
 * The selector walks this list and uses the first available estimator.
 */
export const ESTIMATOR_PRIORITY: readonly EstimatorKind[] = Object.freeze([
  'count_tokens',
  'local_tokenizer',
  'bytes_chars',
]);

/**
 * Maps each estimator tier to its `usage.estimator.confidence`, per the spec:
 * `high` for the provider count_tokens endpoint, `medium` for a local
 * tokenizer, `low` for the bytes/chars heuristic.
 *
 * Frozen so the confidence model cannot be tampered with at runtime. Typed as a
 * Record over EstimatorKind so accessing an UNKNOWN key returns `undefined`
 * (never a silent valid-confidence fallback).
 */
export const CONFIDENCE_MAP: Readonly<Record<EstimatorKind, EstimatorConfidence>> = Object.freeze({
  count_tokens: 'high',
  local_tokenizer: 'medium',
  bytes_chars: 'low',
});

/** The shape every estimator returns: a token count plus which tier produced it. */
export interface EstimateOutput {
  estimatedInputTokens: number;
  kind: EstimatorKind;
}

/**
 * A token estimator: `(model, input) -> {estimatedInputTokens, kind}`.
 *
 * Optionally async: the count_tokens variant is a real provider endpoint and is
 * therefore typically async; a local tokenizer or the bytes/chars heuristic is
 * synchronous. The return type permits BOTH (`EstimateOutput | Promise<...>`),
 * and the selector always `await`s the result, so a plain sync estimator works
 * unchanged (await of a non-promise is the value itself).
 */
export type TokenEstimator = (
  model: string,
  input: string,
) => EstimateOutput | Promise<EstimateOutput>;

// =============================================================================
// CHK-002: deterministic OFFLINE bytes/chars heuristic estimator
// =============================================================================

/**
 * Average bytes-per-token divisor for the offline heuristic. ~4 UTF-8 bytes per
 * token is a coarse, widely-cited rule of thumb for English-ish text. It is a
 * DIAGNOSTIC GUARD, not an accurate count.
 *
 * Deliberately NOT tiktoken: tiktoken is OpenAI's BPE and undercounts Claude
 * (different vocab/merges), and it would also pull in a non-builtin dependency,
 * breaking this module's zero-cross-module-import / offline-only property. The
 * spec explicitly forbids promoting a bytes/chars heuristic and forbids leaning
 * on an OpenAI-specific tokenizer for Claude.
 */
const BYTES_PER_TOKEN = 4;

export const BYTES_CHARS_ESTIMATOR_NAME = 'bytes-chars-heuristic';
export const BYTES_CHARS_ESTIMATOR_VERSION = '1';
/** UTF-8 bytes are the measured unit (NOT JS UTF-16 code units / chars). */
export const BYTES_CHARS_ESTIMATOR_UNIT = 'utf8-bytes';

/**
 * Pure, deterministic, OFFLINE bytes/chars heuristic (kind `bytes_chars`,
 * confidence `low`). No network, no provider client, no randomness, no clock —
 * the same input ALWAYS yields the same output.
 *
 * Counts UTF-8 BYTES (via Buffer.byteLength) rather than `String.length`, so
 * multi-byte input (CJK, emoji) is measured by its real byte footprint and
 * coarse monotonicity holds: appending text can only add bytes, so the estimate
 * is non-decreasing. The empty string yields 0.
 *
 * Defensive: a non-string `input` (null/undefined/number) is treated as the
 * empty string and yields 0 — never NaN, never negative.
 */
export function bytesCharsEstimator(_model: string, input: string): EstimateOutput {
  const text = typeof input === 'string' ? input : '';
  // UTF-8 byte length: multi-byte chars count for their true byte size.
  const bytes = Buffer.byteLength(text, 'utf8');
  // ceil so any non-empty input estimates at least 1 token; empty stays 0.
  const estimatedInputTokens = bytes === 0 ? 0 : Math.ceil(bytes / BYTES_PER_TOKEN);
  return { estimatedInputTokens, kind: 'bytes_chars' };
}

// =============================================================================
// CHK-003: estimate selector (count_tokens > local_tokenizer > bytes_chars)
// =============================================================================

/** Arguments to the estimate selector. */
export interface SelectEstimateArgs {
  /** Exact provider/model id the estimate is bound to (echoed back verbatim). */
  model: string;
  /** The prompt text to estimate. */
  input: string;
  /**
   * Provider count_tokens endpoint (highest fidelity). Injected by the caller —
   * this module NEVER constructs or calls a provider HTTP client itself. When
   * absent or when it throws / returns an invalid count, the selector falls back
   * to the next tier.
   */
  countTokens?: TokenEstimator;
  /**
   * Local tokenizer (mid fidelity). Injected by the caller. When absent or
   * when it throws / returns an invalid count, the selector falls back to
   * bytes/chars.
   */
  localTokenizer?: TokenEstimator;
}

/** The selected estimate, bound to the exact model id passed in. */
export interface SelectedEstimate {
  estimatedInputTokens: number;
  kind: EstimatorKind;
  confidence: EstimatorConfidence;
  /** The EXACT model id passed to selectEstimate (never normalized/aliased). */
  model: string;
}

/** A token count is usable only if it is a finite, non-negative integer. */
function isValidTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

/**
 * Try one injected estimator tier. Returns its output ONLY when it produces a
 * valid (finite, non-negative integer) token count. Any throw, rejected
 * promise, NaN, negative, non-integer, or mismatched `kind` yields `null` so the
 * selector degrades to the next tier instead of propagating a bad estimate.
 */
async function tryEstimator(
  estimator: TokenEstimator | undefined,
  expectedKind: EstimatorKind,
  model: string,
  input: string,
): Promise<EstimateOutput | null> {
  if (typeof estimator !== 'function') return null;
  try {
    // await works for both sync and async estimators (await of a value is the value).
    const out = await estimator(model, input);
    if (out === null || typeof out !== 'object') return null;
    if (!isValidTokenCount(out.estimatedInputTokens)) return null;
    // Force the tier's canonical kind: the selector — not the injected fn — is
    // the source of truth for which tier was used, so a stub cannot mislabel its
    // confidence by returning a different kind.
    return { estimatedInputTokens: out.estimatedInputTokens, kind: expectedKind };
  } catch {
    return null;
  }
}

/**
 * Select the highest-available estimate in strict order
 * count_tokens > local_tokenizer > bytes_chars.
 *
 * - count_tokens / localTokenizer are OPTIONAL injected functions. When an
 *   injected estimator is absent, throws, or returns an invalid count, the
 *   selector falls back to the next tier.
 * - bytes_chars is ALWAYS available (the offline floor).
 * - the result is bound to the EXACT `model` id passed (no normalization).
 *
 * Always async (it may await an injected provider endpoint). The bytes/chars
 * path resolves without any I/O.
 */
export async function selectEstimate(args: SelectEstimateArgs): Promise<SelectedEstimate> {
  const { model, input, countTokens, localTokenizer } = args;

  const countTokensResult = await tryEstimator(countTokens, 'count_tokens', model, input);
  if (countTokensResult) {
    return bind(countTokensResult, model);
  }

  const localResult = await tryEstimator(localTokenizer, 'local_tokenizer', model, input);
  if (localResult) {
    return bind(localResult, model);
  }

  // Offline floor: pure, never throws on string input.
  return bind(bytesCharsEstimator(model, input), model);
}

function bind(output: EstimateOutput, model: string): SelectedEstimate {
  return {
    estimatedInputTokens: output.estimatedInputTokens,
    kind: output.kind,
    confidence: CONFIDENCE_MAP[output.kind],
    model,
  };
}

// =============================================================================
// CHK-004: buildEstimateRecord -> validated prompt-size-estimate record
// =============================================================================

/** Default redaction profile id (the ledger stores no raw content). */
export const DEFAULT_REDACTION_PROFILE = 'no-raw-content-v1';

/**
 * Correlation handle minted locally BEFORE dispatch (ids.ts). These ids are the
 * primary keys of the record and must never be derived from a provider id.
 * Mirrors assemble.ts's RecordCorrelation.
 */
export interface EstimateCorrelation {
  ledgerCallId: string;
  attemptId: string;
  sequence: number;
  supersedesRecordIds: string[];
}

/**
 * Attribution context. `storyId` is nullable (non-story calls) but never
 * omitted — it is always written, as null when absent. Mirrors assemble.ts's
 * RecordAttribution.
 */
export interface EstimateAttribution {
  storyId: string | null;
  phase: string;
  agentType: string;
  subagentId?: string | null;
  threadId?: string | null;
}

/**
 * Optional environment context. `recordedAt` and `projectRootHash` are caller-
 * supplied (this module never calls Date.now(), matching assemble.ts's PURE
 * boundary). When omitted, deterministic placeholders are used so a smoke can
 * build a record without a clock; real callers should supply real values.
 */
export interface EstimateContext {
  recordedAt?: string;
  projectRootHash?: string;
  redactionProfile?: string;
  /** Optional provider metadata. The model is also bound on the estimate itself. */
  provider?: UsageLedgerRecordInput['provider'];
  /** Optional decision metadata; defaults to {kind:'allowed'}. */
  decision?: UsageLedgerRecordInput['decision'];
  command?: string;
  host?: UsageLedgerRecordInput['host'];
}

/** Deterministic placeholders for an estimate built without explicit context. */
const PLACEHOLDER_RECORDED_AT = '1970-01-01T00:00:00.000Z';
const PLACEHOLDER_PROJECT_ROOT_HASH = 'sha256:unknown';

/**
 * Assemble a full, validated `prompt-size-estimate` ledger record body from a
 * selected estimate. Mirrors assemble.ts's buildProviderRecord assembly:
 *   - correlation ids come ONLY from the correlation arg (ids.ts-minted),
 *     never from a provider response;
 *   - recordId is freshly minted via mintRecordId();
 *   - authority is always {mode:'local', receiptId:null, receiptVerified:false};
 *   - integrity is left to the writer.
 *
 * The estimate's token shape is PREFLIGHT: only `input` is estimated. Output,
 * cacheCreation, and cacheRead are `null` (UNKNOWN — nothing has been generated
 * yet), never 0, per the per-dimension absence rule. `usage.source` is
 * `prompt-size-estimate` and `usage.estimator` carries {name, version, unit,
 * confidence}.
 *
 * THROWS when the assembled record fails the B-253e validator, so a bad estimate
 * (e.g. a negative count that slipped past) can never produce a record the
 * writer would later reject. `model` binds `provider.model` to the exact id the
 * estimate was computed for.
 */
export function buildEstimateRecord(
  model: string,
  estimate: SelectedEstimate,
  correlation: EstimateCorrelation,
  attribution: EstimateAttribution,
  context: EstimateContext = {},
): UsageLedgerRecordInput {
  const usage: LedgerUsage = {
    source: 'prompt-size-estimate',
    // Only input is estimated. The other three dimensions are UNKNOWN (null,
    // never 0) — nothing has been generated at preflight time.
    inputTokens: estimate.estimatedInputTokens,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    canonical: {
      input: estimate.estimatedInputTokens,
      output: null,
      cacheCreation: null,
      cacheRead: null,
    },
    estimator: {
      name: estimatorNameForKind(estimate.kind),
      version: estimatorVersionForKind(estimate.kind),
      unit: estimatorUnitForKind(estimate.kind),
      confidence: estimate.confidence,
    },
  };

  // Bind provider.model to the EXACT model the estimate was computed for. If the
  // caller passed provider metadata, keep its name but enforce the bound model.
  const provider = {
    name: context.provider?.name ?? 'unknown',
    model,
    ...(context.provider?.requestIdHash !== undefined
      ? { requestIdHash: context.provider.requestIdHash }
      : {}),
  };

  const record: UsageLedgerRecordInput = {
    schemaVersion: SCHEMA_VERSION,
    recordId: mintRecordId(),
    ledgerCallId: correlation.ledgerCallId,
    attemptId: correlation.attemptId,
    sequence: correlation.sequence,
    supersedesRecordIds: [...correlation.supersedesRecordIds],
    recordedAt: context.recordedAt ?? PLACEHOLDER_RECORDED_AT,
    projectRootHash: context.projectRootHash ?? PLACEHOLDER_PROJECT_ROOT_HASH,
    storyId: attribution.storyId,
    phase: attribution.phase,
    agentType: attribution.agentType,
    subagentId: attribution.subagentId ?? null,
    threadId: attribution.threadId ?? null,
    decision: context.decision ?? { kind: 'allowed' },
    usage,
    provider,
    privacy: {
      promptStored: false,
      transcriptStored: false,
      redactionProfile: context.redactionProfile ?? DEFAULT_REDACTION_PROFILE,
    },
    // Local records NEVER claim receipt verification.
    authority: { mode: 'local', receiptId: null, receiptVerified: false },
    // integrity is intentionally omitted: the writer owns it.
  };

  if (context.command !== undefined) record.command = context.command;
  if (context.host !== undefined) record.host = context.host;

  const result = validateUsageLedgerRecord(record, { expectIntegrity: false });
  if (!result.ok) {
    throw new Error(
      `usage-ledger estimate: assembled an invalid prompt-size-estimate record:\n - ${result.errors.join('\n - ')}`,
    );
  }

  return record;
}

/** Estimator metadata per tier. Only bytes_chars is built-in here; the injected */
/** tiers carry generic names since the concrete fn is supplied by the caller.   */
function estimatorNameForKind(kind: EstimatorKind): string {
  switch (kind) {
    case 'count_tokens':
      return 'provider-count-tokens';
    case 'local_tokenizer':
      return 'local-tokenizer';
    case 'bytes_chars':
      return BYTES_CHARS_ESTIMATOR_NAME;
    default: {
      const never: never = kind;
      throw new Error(`usage-ledger estimate: unknown estimator kind "${String(never)}"`);
    }
  }
}

function estimatorVersionForKind(kind: EstimatorKind): string {
  return kind === 'bytes_chars' ? BYTES_CHARS_ESTIMATOR_VERSION : '1';
}

function estimatorUnitForKind(kind: EstimatorKind): string {
  return kind === 'bytes_chars' ? BYTES_CHARS_ESTIMATOR_UNIT : 'tokens';
}

// =============================================================================
// CHK-005: supersedes wiring + estimate-never-final guarantee
// =============================================================================

/**
 * Re-export buildSupersedes from ids.ts as the supersedes helper for the estimate
 * path. A later provider-reported FINAL record lists the preflight estimate's
 * recordId here so the summary excludes the superseded estimate from
 * providerReportedTotal. The estimate-never-final guarantee itself lives in
 * summary.ts (it buckets by `usage.source`: prompt-size-estimate is NEVER counted
 * as provider-reported final usage), which the smoke confirms.
 */
export { buildSupersedes } from './ids.js';
