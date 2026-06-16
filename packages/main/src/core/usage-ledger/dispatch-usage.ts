/**
 * B-0f7c CHK-001 / CHK-002: the in-module dispatch orchestrator + Claude Code CLI
 * output parser for the LLM usage ledger.
 *
 * This is the THIN ONE-WAY SEAM between live dispatch and the usage ledger:
 *   - lattice-dispatch.ts imports ONLY this file (a single thin import surface);
 *   - this file imports ONLY sibling usage-ledger modules (./record, ./ids,
 *     ./estimate, ./assemble, ./adapters/anthropic, ./writer) and node builtins.
 *     It NEVER imports lattice-dispatch, dispatch-runner, cli-engine, a handler,
 *     or any module outside core/usage-ledger/. The smoke statically asserts the
 *     whole module keeps its zero-cross-module-import property.
 *
 * Safety contract (load-bearing — these are the acceptance invariants):
 *   - every public helper is OPT-IN GATED via isUsageLedgerEnabled(): a strict
 *     no-op (no file, no directory, no side effects) when the flag is OFF;
 *   - every public helper is wrapped in try/catch and NEVER throws to the
 *     dispatch caller — a ledger error must never break dispatch;
 *   - the provider-reported final SUPERSEDES the preflight estimate (no double
 *     count): recordDispatchFinal passes supersedesRecordIds=[estimateRecordId];
 *   - parseClaudeCliOutput NEVER throws and falls back to the raw stdout text
 *     when the output is not the Claude Code JSON envelope.
 */

import { type AnthropicUsage } from './adapters/anthropic.js';
import {
  buildProviderRecord,
  type RecordAttribution,
  type RecordContext,
} from './assemble.js';
import {
  buildEstimateRecord,
  bytesCharsEstimator,
  type SelectedEstimate,
} from './estimate.js';
import {
  buildSupersedes,
  mintCallCorrelation,
  mintRecordId,
  type CallCorrelation,
} from './ids.js';
import { SCHEMA_VERSION, type LedgerUsage, type UsageLedgerRecordInput } from './record.js';
import { appendUsageRecord, isUsageLedgerEnabled } from './writer.js';

/**
 * Re-export the opt-in gate so the dispatch seam imports ONLY this module from
 * usage-ledger (the single thin import surface mandated by the one-way seam). The
 * dispatch caller computes `const ledgerOn = isUsageLedgerEnabled();` from here,
 * never reaching into writer.ts directly.
 */
export { isUsageLedgerEnabled } from './writer.js';

// =============================================================================
// CHK-002: pure Claude Code CLI output parser (with raw-text fallback)
// =============================================================================

/** Result of parsing one Claude Code CLI stdout blob. */
export interface ParsedClaudeCliOutput {
  /**
   * The human-facing result text. For a JSON envelope this is `.result`; for any
   * non-JSON / shape-mismatch input it is the raw stdout passed through verbatim.
   */
  resultText: string;
  /**
   * The extracted Anthropic usage object when the envelope carried a usable one,
   * else null. `null` is the universal fallback (non-JSON, no usage, type-confused
   * usage, etc.) and drives the dispatch seam to record an 'unavailable' final.
   */
  anthropicUsage: AnthropicUsage | null;
  /**
   * The served model id read from the envelope (top-level `.model`, else
   * `.usage.model`), or null when absent / non-string / non-JSON. Token counts
   * are model-version-specific and diagnostics group by model, so the final
   * record binds this real served model when present (best-effort default only
   * when null).
   */
  model: string | null;
}

/** A finite, non-negative integer is the only usable token count. */
function isFiniteNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 0
  );
}

/**
 * Extract a usable AnthropicUsage from a parsed `.usage` object, or null.
 *
 * Requires BOTH primaries (input_tokens / output_tokens) to be present as
 * finite non-negative integers — a type-confused usage (tokens as strings, NaN,
 * negative) or a usage missing a primary yields null so the seam records an
 * 'unavailable' final rather than a bad number. Cache fields are copied through
 * only when present (absent stays absent so the adapter maps them to null, never
 * 0). This parser does NOT itself reject negative/over-large values beyond the
 * primaries check; the adapter + validator are the final guard. The intent here
 * is "shape gate", not "semantic validation".
 */
function extractAnthropicUsage(usage: unknown): AnthropicUsage | null {
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
    return null;
  }
  const u = usage as Record<string, unknown>;
  // Both primaries must be finite non-negative integers to be a usable usage.
  if (!isFiniteNonNegativeInteger(u.input_tokens) || !isFiniteNonNegativeInteger(u.output_tokens)) {
    return null;
  }
  const out: AnthropicUsage = {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
  };
  // Cache fields: pass through ONLY when present (absent stays absent -> null on
  // the record, never 0). Non-integer cache values are dropped (treated absent).
  if (isFiniteNonNegativeInteger(u.cache_creation_input_tokens)) {
    out.cache_creation_input_tokens = u.cache_creation_input_tokens;
  }
  if (isFiniteNonNegativeInteger(u.cache_read_input_tokens)) {
    out.cache_read_input_tokens = u.cache_read_input_tokens;
  }
  return out;
}

/**
 * Read the served model from a parsed envelope: top-level `.model` first, else
 * `.usage.model`, else null. Only a non-empty string is accepted; any other type
 * (number, object, empty string) yields null so the seam falls back to the
 * best-effort default rather than recording a bad model id. Never throws.
 */
function extractModel(envelope: Record<string, unknown>): string | null {
  const top = envelope.model;
  if (typeof top === 'string' && top.length > 0) return top;
  const usage = envelope.usage;
  if (typeof usage === 'object' && usage !== null && !Array.isArray(usage)) {
    const nested = (usage as Record<string, unknown>).model;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return null;
}

/**
 * Parse Claude Code CLI stdout into {resultText, anthropicUsage, model}.
 *
 * - When stdout is the Claude Code CLI JSON envelope (e.g.
 *   `{type, result, model, usage:{input_tokens,output_tokens,...}, ...}`),
 *   extract `.result` as the result text, the `.usage` object, and the served
 *   model (top-level `.model`, else `.usage.model`).
 * - When stdout is NOT valid JSON, is not an object, lacks `.result`, or lacks a
 *   usable `.usage`, fall back to `{resultText: <raw stdout>, anthropicUsage:
 *   null, model: null}`.
 * - NEVER throws (JSON.parse is wrapped). Empty / huge / deeply-nested input all
 *   degrade gracefully.
 *
 * PURE: no fs, no clock, no provider client. A defensive non-string input is
 * coerced to '' so the caller never sees a crash.
 */
export function parseClaudeCliOutput(stdout: string): ParsedClaudeCliOutput {
  const raw = typeof stdout === 'string' ? stdout : '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON at all -> raw-text fallback, no usage, no model.
    return { resultText: raw, anthropicUsage: null, model: null };
  }

  // Valid JSON but not a plain object (array, number, string, null) -> the raw
  // stdout is the human result; there is no envelope to read usage/model from.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { resultText: raw, anthropicUsage: null, model: null };
  }

  const envelope = parsed as Record<string, unknown>;
  const anthropicUsage = extractAnthropicUsage(envelope.usage);
  const model = extractModel(envelope);

  // `.result` is the human-facing text. When it is a string, use it; otherwise
  // fall back to the raw stdout (a JSON-with-usage-but-no-result envelope still
  // surfaces its usage, but its result text is the raw blob).
  const resultText = typeof envelope.result === 'string' ? envelope.result : raw;

  return { resultText, anthropicUsage, model };
}

// =============================================================================
// CHK-001: dispatch preflight + final orchestrators (opt-in gated, never throw)
// =============================================================================

/**
 * Attribution context for a dispatch call. `storyId` is nullable (non-story
 * calls) but is never omitted from the written record. `phase` / `agentType`
 * come from the dispatch context (or documented constants). `model` is a
 * best-effort default used for the preflight estimate, before the provider has
 * reported the model it actually served.
 */
export interface DispatchUsageContext {
  storyId: string | null;
  phase: string;
  agentType: string;
  model?: string;
  subagentId?: string | null;
  threadId?: string | null;
}

/**
 * Environment context the dispatch seam supplies. `recordedAt` and
 * `projectRootHash` are caller-supplied (this module never calls Date.now()).
 * `command` / `host` are optional labels recorded for diagnostics.
 */
export interface DispatchUsageOptions {
  recordedAt: string;
  projectRootHash: string;
  command?: string;
  host?: UsageLedgerRecordInput['host'];
  /** Override env for the opt-in flag check + writer (tests). */
  env?: NodeJS.ProcessEnv;
  redactionProfile?: string;
}

/** The handle returned by recordDispatchPreflight, fed back to the final. */
export interface DispatchPreflightHandle {
  correlation: CallCorrelation;
  estimateRecordId: string;
}

/** Default model id for the preflight estimate when none is supplied. */
const DEFAULT_ESTIMATE_MODEL = 'unknown';

/**
 * Record the preflight prompt-size estimate BEFORE dispatch.
 *
 * - flag OFF -> returns null, writes nothing, creates no file/dir (strict no-op);
 * - flag ON  -> mints a fresh correlation, computes a SYNCHRONOUS bytes/chars
 *   estimate, assembles a prompt-size-estimate record (sequence 1), appends it,
 *   and returns {correlation, estimateRecordId}.
 *
 * NEVER throws: any failure (writer throw on a corrupt ledger, assembly throw)
 * is swallowed and null is returned so dispatch proceeds unaffected. The returned
 * estimateRecordId is later superseded by the final so the estimate is never
 * double-counted.
 */
export function recordDispatchPreflight(
  root: string,
  ctx: DispatchUsageContext,
  promptText: string,
  opts: DispatchUsageOptions,
): DispatchPreflightHandle | null {
  // Strict no-op when disabled. Checked first so an OFF flag never mints ids or
  // touches the filesystem.
  if (!isUsageLedgerEnabled(opts.env)) return null;

  try {
    const correlation = mintCallCorrelation();
    const model = ctx.model && ctx.model.length > 0 ? ctx.model : DEFAULT_ESTIMATE_MODEL;

    // SYNCHRONOUS bytes/chars estimator (the offline floor). No await, no I/O.
    const estimateOutput = bytesCharsEstimator(model, promptText);
    const estimate: SelectedEstimate = {
      estimatedInputTokens: estimateOutput.estimatedInputTokens,
      kind: estimateOutput.kind,
      confidence: 'low',
      model,
    };

    const record = buildEstimateRecord(
      model,
      estimate,
      {
        ledgerCallId: correlation.ledgerCallId,
        attemptId: correlation.attemptId,
        sequence: 1,
        supersedesRecordIds: [],
      },
      attributionFor(ctx),
      {
        recordedAt: opts.recordedAt,
        projectRootHash: opts.projectRootHash,
        redactionProfile: opts.redactionProfile,
        command: opts.command,
        host: opts.host,
      },
    );

    appendUsageRecord(root, record, { env: opts.env });
    return { correlation, estimateRecordId: record.recordId };
  } catch {
    // Never propagate a ledger error to the dispatch caller.
    return null;
  }
}

/**
 * Record the final usage AFTER dispatch, superseding the preflight estimate.
 *
 * - flag OFF -> returns immediately (strict no-op);
 * - anthropicUsage present -> assembles a provider-reported record (sequence 2,
 *   supersedesRecordIds=[estimateRecordId]) via the anthropic adapter + assemble
 *   and appends it. The provider-reported final SUPERSEDES the estimate so the
 *   summary counts only the final (no double count).
 * - anthropicUsage null -> appends an 'unavailable' final (source=unavailable,
 *   sequence 2, supersedes the estimate) with a reason, so a parse failure / no
 *   usage still produces an accounting record that supersedes the estimate.
 *
 * NEVER throws: any failure (adapter/assemble throw on a rogue payload, writer
 * throw) is swallowed so dispatch proceeds and returns its result text.
 *
 * `model` is the served model parsed from the envelope. When it is null (envelope
 * carried no model), the provider record falls back to the best-effort default —
 * token counts are model-version-specific and diagnostics group by model, so the
 * real served model is recorded whenever the envelope reports it.
 *
 * When no preflight handle exists (estimateRecordId omitted because preflight
 * returned null), the final still records but supersedes nothing — but in the
 * normal flow the seam always passes the preflight handle through.
 */
export function recordDispatchFinal(
  root: string,
  ctx: DispatchUsageContext,
  correlation: CallCorrelation | null,
  estimateRecordId: string | null,
  anthropicUsage: AnthropicUsage | null,
  model: string | null,
  opts: DispatchUsageOptions,
): void {
  if (!isUsageLedgerEnabled(opts.env)) return;

  try {
    // In the normal seam flow a correlation handle is always passed in. If it is
    // absent we mint a fresh correlation and still record the final; it then
    // supersedes nothing (estimateRecordId is typically null in that case), as
    // the function JSDoc describes.
    const corr = correlation ?? mintCallCorrelation();
    const supersedes = buildSupersedes(estimateRecordId);

    if (anthropicUsage !== null) {
      const record = buildProviderRecord(
        'anthropic',
        { usage: anthropicUsage },
        {
          ledgerCallId: corr.ledgerCallId,
          attemptId: corr.attemptId,
          sequence: 2,
          supersedesRecordIds: supersedes,
        },
        attributionFor(ctx),
        finalContext(opts, model),
      );
      appendUsageRecord(root, record, { env: opts.env });
      return;
    }

    // No usage -> an 'unavailable' final that still supersedes the estimate.
    const unavailable = buildUnavailableFinalRecord(
      corr,
      supersedes,
      attributionFor(ctx),
      finalContext(opts, model),
    );
    appendUsageRecord(root, unavailable, { env: opts.env });
  } catch {
    // Never propagate a ledger error to the dispatch caller.
  }
}

/** Map a DispatchUsageContext to the assemble/estimate attribution shape. */
function attributionFor(ctx: DispatchUsageContext): RecordAttribution {
  return {
    storyId: ctx.storyId,
    phase: ctx.phase,
    agentType: ctx.agentType,
    subagentId: ctx.subagentId ?? null,
    threadId: ctx.threadId ?? null,
  };
}

/**
 * Build the RecordContext for a final record, binding the served model. A null
 * or empty model (envelope carried none) falls back to the best-effort default.
 */
function finalContext(opts: DispatchUsageOptions, model: string | null): RecordContext {
  const bound = model && model.length > 0 ? model : DEFAULT_ESTIMATE_MODEL;
  return {
    recordedAt: opts.recordedAt,
    projectRootHash: opts.projectRootHash,
    redactionProfile: opts.redactionProfile,
    command: opts.command,
    host: opts.host,
    provider: { name: 'anthropic', model: bound },
  };
}

/**
 * Assemble an 'unavailable' final record body. The assemble.ts builder is keyed
 * to provider responses with usable usage, so the unavailable record is built
 * directly here (still a fully-formed, writer-validated record body). It mirrors
 * the assemble/estimate boundary: correlation ids come only from the handle,
 * recordId is minted by the writer path's caller here, authority is local.
 */
function buildUnavailableFinalRecord(
  correlation: CallCorrelation,
  supersedesRecordIds: string[],
  attribution: RecordAttribution,
  context: RecordContext,
): UsageLedgerRecordInput {
  const usage: LedgerUsage = {
    source: 'unavailable',
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    unavailableReason:
      'dispatch: provider returned no JSON usage envelope (fell back to raw stdout text)',
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    recordId: mintRecordId(),
    ledgerCallId: correlation.ledgerCallId,
    attemptId: correlation.attemptId,
    sequence: 2,
    supersedesRecordIds: [...supersedesRecordIds],
    recordedAt: context.recordedAt,
    projectRootHash: context.projectRootHash,
    storyId: attribution.storyId,
    phase: attribution.phase,
    agentType: attribution.agentType,
    subagentId: attribution.subagentId ?? null,
    threadId: attribution.threadId ?? null,
    decision: { kind: 'allowed' },
    usage,
    ...(context.provider !== undefined ? { provider: context.provider } : {}),
    ...(context.command !== undefined ? { command: context.command } : {}),
    ...(context.host !== undefined ? { host: context.host } : {}),
    privacy: {
      promptStored: false,
      transcriptStored: false,
      redactionProfile: context.redactionProfile ?? 'no-raw-content-v1',
    },
    authority: { mode: 'local', receiptId: null, receiptVerified: false },
  };
}
