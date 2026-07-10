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

import { type AnthropicUsage, ANTHROPIC_USAGE_WHITELIST } from './adapters/anthropic.js';
import { adaptCodexTurnUsage } from './adapters/openai.js';
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
import {
  SCHEMA_VERSION,
  validateUsageLedgerRecord,
  type LedgerUsage,
  type UsageCanonical,
  type UsageLedgerRecordInput,
} from './record.js';
import { appendUsageRecord, isUsageLedgerEnabled } from './writer.js';
import { ownProp, toOwnPropsNullProto } from './sanitize.js';

/**
 * B-6878 (F-006 fix): the Anthropic token keys extractAnthropicUsage reads off a
 * parsed `.usage` object are the SAME chokepoint whitelist the anthropic adapter
 * uses. Reuse the single exported ANTHROPIC_USAGE_WHITELIST (adapters/anthropic.ts)
 * rather than a local duplicate so a future whitelist change cannot silently
 * diverge between the dispatch extract entry and the adapter. Projecting through
 * toOwnPropsNullProto before the u.* reads makes a polluted Object.prototype token
 * key unreachable via the prototype chain.
 */

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
  // B-6878: project to a null-proto, whitelist-only object BEFORE any u.* read so
  // a polluted Object.prototype token key can never be resolved via inheritance
  // on a usage object that lacks that key as an own property. Legitimate
  // own-property counts are copied verbatim, so the extracted usage is unchanged.
  const u = toOwnPropsNullProto(usage, ANTHROPIC_USAGE_WHITELIST);
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
 *
 * B-6878: every CONTAINER read (envelope.model, envelope.usage, the nested
 * usage.model) is own-property guarded. An inherited (prototype-polluted)
 * `model` / `usage` is treated as ABSENT, so a polluted Object.prototype.model
 * can never become the recorded served model.
 */
function extractModel(envelope: Record<string, unknown>): string | null {
  const top = ownProp(envelope, 'model') ? envelope.model : undefined;
  if (typeof top === 'string' && top.length > 0) return top;
  const usage = ownProp(envelope, 'usage') ? envelope.usage : undefined;
  if (typeof usage === 'object' && usage !== null && !Array.isArray(usage)) {
    const nested = ownProp(usage, 'model') ? (usage as Record<string, unknown>).model : undefined;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return null;
}

function parseClaudeJsonEnvelope(envelope: Record<string, unknown>, raw: string): ParsedClaudeCliOutput {
  // B-6878: own-property guard the CONTAINER read of `usage`. An inherited
  // (prototype-polluted) Object.prototype.usage on an envelope that has no OWN
  // usage is treated as ABSENT, so the polluted container never reaches the
  // extractor (whose own-prop whitelist would otherwise accept its own props).
  const usageContainer = ownProp(envelope, 'usage') ? envelope.usage : undefined;
  const anthropicUsage = extractAnthropicUsage(usageContainer);
  const model = extractModel(envelope);

  // `.result` is the human-facing text. When it is an OWN string property, use it;
  // otherwise fall back to the raw stdout (a JSON-with-usage-but-no-result envelope
  // still surfaces its usage, but its result text is the raw blob).
  // B-6878 (F-008 fix): own-property guard the CONTAINER read. An inherited
  // (prototype-polluted) Object.prototype.result on an envelope with NO own
  // `result` is treated as ABSENT, so a polluted prototype can never replace the
  // raw-stdout fallback text.
  const ownResult = ownProp(envelope, 'result') ? envelope.result : undefined;
  const resultText = typeof ownResult === 'string' ? ownResult : raw;

  return { resultText, anthropicUsage, model };
}

function selectClaudeStreamResultEvent(raw: string): Record<string, unknown> | null {
  let selected: Record<string, unknown> | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const event = parsed as Record<string, unknown>;
    const type = ownProp(event, 'type') ? event.type : undefined;
    const result = ownProp(event, 'result') ? event.result : undefined;
    if (type === 'result' || typeof result === 'string') {
      selected = event;
    }
  }
  return selected;
}

/**
 * Parse Claude Code CLI stdout into {resultText, anthropicUsage, model}.
 *
 * - When stdout is the Claude Code CLI JSON envelope (e.g.
 *   `{type, result, model, usage:{input_tokens,output_tokens,...}, ...}`),
 *   extract `.result` as the result text, the `.usage` object, and the served
 *   model (top-level `.model`, else `.usage.model`).
 * - When stdout is Claude Code stream-json NDJSON, select the final result event
 *   line and extract the same result/usage/model fields from that event.
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
    const streamResult = selectClaudeStreamResultEvent(raw);
    if (streamResult) return parseClaudeJsonEnvelope(streamResult, raw);
    // Not JSON / no usable stream-json result event -> raw-text fallback.
    return { resultText: raw, anthropicUsage: null, model: null };
  }

  // Valid JSON but not a plain object (array, number, string, null) -> the raw
  // stdout is the human result; there is no envelope to read usage/model from.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { resultText: raw, anthropicUsage: null, model: null };
  }

  return parseClaudeJsonEnvelope(parsed as Record<string, unknown>, raw);
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
  /**
   * The preflight estimated input-token count (the bytes/chars floor). Exposed so
   * the fail-closed budget guard (B-dd44) can compare it against a configured hard
   * budget WITHOUT re-running the estimator. Backward-compatible: existing callers
   * ignore it; the value is the same number assembled into the estimate record.
   */
  estimatedInputTokens: number;
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
    return {
      correlation,
      estimateRecordId: record.recordId,
      estimatedInputTokens: estimate.estimatedInputTokens,
    };
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

/**
 * Record the final usage AFTER a codex/gemini dispatch, superseding the preflight
 * estimate. Provider-parametric sibling of recordDispatchFinal: the claude path
 * (recordDispatchFinal) is left byte-identical, while this entry point routes a
 * bare provider usage object through buildProviderRecord('openai' | 'gemini', ...).
 *
 * - flag OFF -> returns immediately (strict no-op);
 * - reportedUsage is a usable non-null object -> assembles a provider-reported
 *   record (sequence 2, supersedesRecordIds=[estimateRecordId]) via the openai /
 *   gemini adapter (buildProviderRecord runs adaptUsageFor; its extractRawUsage
 *   passes a bare `usage` / `usageMetadata` object straight to the adapter, so a
 *   bare object works directly) and appends it. The provider-reported final
 *   SUPERSEDES the estimate so the summary counts only the final (no double count).
 * - otherwise (null / non-object / garbage usage) -> appends an 'unavailable'
 *   final (sequence 2, supersedes the estimate) so the estimate is still
 *   superseded even when the CLI reported no usable usage.
 *
 * NEVER throws: any failure (adapter/assemble throw on a rogue payload, writer
 * throw) is swallowed so dispatch proceeds.
 *
 * `provider` is 'openai' for the codex host and 'gemini' for the gemini host —
 * the record's provider.name is set accordingly (NOT hardcoded anthropic).
 * `model` is the served model the provider reported; null falls back to the
 * best-effort default.
 */
export function recordDispatchFinalForProvider(
  root: string,
  ctx: DispatchUsageContext,
  correlation: CallCorrelation | null,
  estimateRecordId: string | null,
  provider: 'openai' | 'gemini',
  reportedUsage: unknown,
  model: string | null,
  opts: DispatchUsageOptions,
): void {
  if (!isUsageLedgerEnabled(opts.env)) return;

  try {
    const corr = correlation ?? mintCallCorrelation();
    const supersedes = buildSupersedes(estimateRecordId);

    // A usable usage is a non-null, non-array object. Anything else (null,
    // undefined, primitive, array) falls through to the unavailable branch so the
    // estimate is still superseded.
    const usable =
      typeof reportedUsage === 'object' && reportedUsage !== null && !Array.isArray(reportedUsage);

    if (usable) {
      // INNER try: a malformed-but-object usage (e.g. a negative / non-integer
      // token count) makes buildProviderRecord throw at validation. On a throw we
      // must NOT return — we fall through to the unavailable-final branch below so
      // the preflight estimate is STILL superseded (never left orphaned). At most
      // ONE final is appended: the record is built first and appended only AFTER a
      // successful build, so a build throw appends nothing here and only the single
      // unavailable append runs.
      try {
        const record = buildProviderRecord(
          provider,
          reportedUsage,
          {
            ledgerCallId: corr.ledgerCallId,
            attemptId: corr.attemptId,
            sequence: 2,
            supersedesRecordIds: supersedes,
          },
          attributionFor(ctx),
          finalContextForProvider(opts, provider, model),
        );
        appendUsageRecord(root, record, { env: opts.env });
        return;
      } catch {
        // Build/validation failed on a malformed usage: fall through to the
        // unavailable-final branch (do NOT return) so the estimate is superseded.
      }
    }

    // No usable usage (or a usable-but-malformed usage that failed to build) -> an
    // 'unavailable' final that still supersedes the estimate.
    const unavailable = buildUnavailableFinalRecord(
      corr,
      supersedes,
      attributionFor(ctx),
      finalContextForProvider(opts, provider, model),
    );
    appendUsageRecord(root, unavailable, { env: opts.env });
  } catch {
    // Never propagate a ledger error to the dispatch caller.
  }
}

// =============================================================================
// B-70e9 CHK-001: host-run choke-point final recorders (codex mapping, provider-
// parametric unavailable) — gated OFF => strict no-op, NEVER throw. These extend
// the seam WITHIN this module only (record.ts / writer.ts / assemble.ts stay
// untouched); they route through the same buildProviderRecord + appendUsageRecord
// choke point as the existing dispatch finals.
// =============================================================================

/** Result of recording a codex final: the mapped canonical dims + provenance. */
export interface CodexFinalResult {
  recorded: boolean;
  recordId: string | null;
  source: 'provider-reported' | 'unavailable';
  /** The mapped canonical dims (uncached-remainder input + cacheRead) when provider-reported. */
  mapped: UsageCanonical | null;
  unavailableReason: string | null;
}

/**
 * Record a codex `turn.completed` usage as the provider-reported final (openai
 * provider), superseding the preflight estimate. The codex adapter
 * (adaptCodexTurnUsage) computes canonical.input as the UNCACHED remainder
 * (input_tokens - cached_input_tokens) with cacheRead carried separately, and the
 * raw digest covers the ORIGINAL codex usage payload (reasoning_output_tokens
 * preserved). A malformed / missing usage maps to an 'unavailable' final with the
 * adapter's reason — never a fabricated zero.
 *
 * Uses the buildProviderRecord `usage` override so OUR codex canonical mapping and
 * original-payload digest are recorded verbatim (the openai adapter never carves
 * cached out of input, so the mapping is computed in the adapter, not here).
 *
 * NEVER throws: gated OFF => no-op; any assembly/write error is swallowed.
 */
export function recordDispatchFinalCodex(
  root: string,
  ctx: DispatchUsageContext,
  correlation: CallCorrelation | null,
  estimateRecordId: string | null,
  rawCodexUsage: unknown,
  model: string | null,
  opts: DispatchUsageOptions,
): CodexFinalResult {
  const off: CodexFinalResult = { recorded: false, recordId: null, source: 'unavailable', mapped: null, unavailableReason: null };
  if (!isUsageLedgerEnabled(opts.env)) return off;

  try {
    const usage = adaptCodexTurnUsage(rawCodexUsage);
    const corr = correlation ?? mintCallCorrelation();

    // A usage the codex adapter accepted (provider-reported) is recorded first; a
    // validation throw (e.g. a non-integer count that survived the adapter's shape
    // gate) falls through to the unavailable branch so the preflight estimate is
    // STILL superseded — never left orphaned — and no count is fabricated. Mirrors
    // recordDispatchFinalForProvider's inner-try fallback.
    if (usage.source === 'provider-reported') {
      try {
        const record = buildProviderRecord(
          'openai',
          {},
          {
            ledgerCallId: corr.ledgerCallId,
            attemptId: corr.attemptId,
            sequence: 2,
            supersedesRecordIds: buildSupersedes(estimateRecordId),
          },
          attributionFor(ctx),
          finalContextForProvider(opts, 'openai', model),
          { usage },
        );
        appendUsageRecord(root, record, { env: opts.env });
        return { recorded: true, recordId: record.recordId, source: 'provider-reported', mapped: usage.canonical ?? null, unavailableReason: null };
      } catch {
        // Build/validation failed on a malformed usage: fall through to unavailable.
      }
    }

    const reason = usage.source === 'unavailable' && usage.unavailableReason
      ? usage.unavailableReason
      : 'codex: turn.completed usage failed record validation';
    const res = recordDispatchUnavailableFinal(root, ctx, corr, estimateRecordId, { name: 'openai', model }, reason, opts);
    return { recorded: res.recorded, recordId: res.recordId, source: 'unavailable', mapped: null, unavailableReason: reason };
  } catch {
    return off;
  }
}

/**
 * Record a provider-parametric 'unavailable' final, superseding the preflight
 * estimate. Used by host_run for hosts / paths with no usable usage surface:
 *   - agy print mode (provider name 'antigravity', reason 'agy_print_mode_reports_no_usage');
 *   - codex with no turn.completed usage event (provider 'openai', reason 'no_turn_completed_usage_event').
 *
 * Unlike buildUnavailableFinalRecord (hardcoded provider 'anthropic' + reason via
 * finalContext), this binds an arbitrary provider NAME and an explicit reason. A
 * null/empty model falls back to the best-effort default ('unknown').
 *
 * NEVER throws: gated OFF => no-op; any assembly/write error is swallowed.
 */
export function recordDispatchUnavailableFinal(
  root: string,
  ctx: DispatchUsageContext,
  correlation: CallCorrelation | null,
  estimateRecordId: string | null,
  provider: { name: string; model: string | null },
  unavailableReason: string,
  opts: DispatchUsageOptions,
): { recorded: boolean; recordId: string | null } {
  if (!isUsageLedgerEnabled(opts.env)) return { recorded: false, recordId: null };

  try {
    const corr = correlation ?? mintCallCorrelation();
    const supersedes = buildSupersedes(estimateRecordId);
    const boundModel = provider.model && provider.model.length > 0 ? provider.model : DEFAULT_ESTIMATE_MODEL;
    const usage: LedgerUsage = {
      source: 'unavailable',
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      estimator: null,
      unavailableReason: unavailableReason && unavailableReason.length > 0 ? unavailableReason : 'host run reported no usage',
    };
    const context: RecordContext = {
      recordedAt: opts.recordedAt,
      projectRootHash: opts.projectRootHash,
      redactionProfile: opts.redactionProfile,
      command: opts.command,
      host: opts.host,
      provider: { name: provider.name, model: boundModel },
    };
    const record = buildProviderRecord(
      'openai',
      {},
      {
        ledgerCallId: corr.ledgerCallId,
        attemptId: corr.attemptId,
        sequence: 2,
        supersedesRecordIds: supersedes,
      },
      attributionFor(ctx),
      context,
      { usage },
    );
    appendUsageRecord(root, record, { env: opts.env });
    return { recorded: true, recordId: record.recordId };
  } catch {
    return { recorded: false, recordId: null };
  }
}

// =============================================================================
// B-70e9 CHK-007: host-run concurrency-cap blocked record (diagnostics-honest).
// Reuses the parametric buildBlockedBudgetRecord (reasonCode is already a param)
// so a concurrency refusal is a decision.kind='blocked' ledger row that supersedes
// the preflight estimate, exactly like a hard-budget block. record.ts is NOT
// touched — only this dispatch-usage entry point is added.
// =============================================================================

/** Reason code recorded on a host-run concurrency-cap refusal. */
export const CONCURRENCY_CAP_REASON_CODE = 'concurrency_cap_exceeded';

/**
 * Append a decision.kind='blocked' record for a host-run concurrency-cap refusal,
 * superseding the preflight estimate. The recorded usage is the prompt-size
 * estimate that would have been spawned (input only), NOT a provider usage — the
 * host was never launched. `cap` is folded into a stable budgetPolicyId
 * (`concurrency-cap:<cap>`); the reasonCode is CONCURRENCY_CAP_REASON_CODE.
 *
 * NEVER throws: gated OFF => no-op; any assembly/write error is swallowed (the
 * caller still refuses fail-closed — a write failure never converts a refusal into
 * a spawn).
 */
export function recordConcurrencyBlock(
  root: string,
  ctx: DispatchUsageContext,
  handle: DispatchPreflightHandle | null,
  promptText: string,
  cap: number,
  opts: DispatchUsageOptions,
): { recorded: boolean; recordId: string | null } {
  if (!isUsageLedgerEnabled(opts.env)) return { recorded: false, recordId: null };

  try {
    let estimatedInputTokens: number;
    if (handle && Number.isFinite(handle.estimatedInputTokens)) {
      estimatedInputTokens = handle.estimatedInputTokens;
    } else {
      try {
        const model = ctx.model && ctx.model.length > 0 ? ctx.model : DEFAULT_ESTIMATE_MODEL;
        estimatedInputTokens = bytesCharsEstimator(model, promptText).estimatedInputTokens;
      } catch {
        estimatedInputTokens = 0;
      }
    }

    const correlation = handle?.correlation ?? mintCallCorrelation();
    const budgetPolicyId = `concurrency-cap:${Number.isFinite(cap) ? cap : 0}`;
    const record = buildBlockedBudgetRecord(
      ctx.model ?? null,
      { estimatedInputTokens, estimateRecordId: handle?.estimateRecordId ?? null },
      correlation,
      attributionFor(ctx),
      finalContext(opts, ctx.model ?? null),
      budgetPolicyId,
      CONCURRENCY_CAP_REASON_CODE,
    );
    if (record === null) return { recorded: false, recordId: null };
    try {
      appendUsageRecord(root, record, { env: opts.env });
    } catch {
      // Fail-closed: the caller refuses regardless; a write failure never spawns.
      return { recorded: false, recordId: record.recordId };
    }
    return { recorded: true, recordId: record.recordId };
  } catch {
    return { recorded: false, recordId: null };
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
 * Provider-parametric sibling of finalContext: builds the RecordContext for a
 * codex/gemini final record, binding the named provider (openai/gemini) rather
 * than the hardcoded anthropic. finalContext (anthropic) stays byte-identical; a
 * null/empty served model falls back to the best-effort default.
 */
function finalContextForProvider(
  opts: DispatchUsageOptions,
  providerName: 'openai' | 'gemini',
  model: string | null,
): RecordContext {
  const bound = model && model.length > 0 ? model : DEFAULT_ESTIMATE_MODEL;
  return {
    recordedAt: opts.recordedAt,
    projectRootHash: opts.projectRootHash,
    redactionProfile: opts.redactionProfile,
    command: opts.command,
    host: opts.host,
    provider: { name: providerName, model: bound },
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

// =============================================================================
// B-dd44 CHK-001: PURE hard-budget policy resolution + over-budget predicate
//
// These are the ONLY budget POLICY primitives. They live here (zero
// cross-module imports) so the dispatch seam stays a minimal gated guard. They
// are PURE and NEVER throw: a budget-resolution / predicate error must never
// wrongly block a dispatch — the local non-authority NEVER invents a budget.
// =============================================================================

/** Default reason code recorded on a hard-budget block. */
export const HARD_BUDGET_REASON_CODE = 'hard_budget_exceeded';

/** A resolved hard budget: the numeric ceiling + the policy id it is bound to. */
export interface ResolvedHardBudget {
  /** The configured ceiling (a finite, positive, safe integer). */
  hardBudgetTokens: number;
  /** Stable policy id derived from the ceiling, recorded on the blocked record. */
  budgetPolicyId: string;
}

/**
 * Parse a candidate env string into a usable hard-budget ceiling, or null.
 *
 * A usable ceiling is a finite, positive, SAFE integer. Everything else — unset,
 * empty, non-numeric, float, zero, negative, NaN, Infinity, or above
 * Number.MAX_SAFE_INTEGER — yields null, meaning "no enforcement". Surrounding
 * whitespace is trimmed before parsing (an internal-space / unit-suffixed value
 * is still rejected because Number() of it is NaN). NEVER throws.
 */
function parsePositiveIntegerBudget(raw: string | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Number() (not parseInt) so "3.14", "5px", "1e3" do not silently truncate to
  // a misleading integer; only a clean numeric literal survives.
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  if (value <= 0) return null;
  if (value > Number.MAX_SAFE_INTEGER) return null;
  return value;
}

/**
 * Resolve the configured hard budget from the environment, or null.
 *
 * Reads `LATTICE_HARD_BUDGET_TOKENS` only. Returns:
 *   - { hardBudgetTokens, budgetPolicyId } when a valid positive-integer ceiling
 *     is configured;
 *   - null when unset / empty / non-numeric / float / <=0 / NaN / Infinity /
 *     unsafe — i.e. NO enforcement (the dispatch proceeds byte-identically).
 *
 * STATELESS: reads `env` each call, never caches — rapid sequential dispatches
 * each re-resolve from the live env. PURE and NEVER throws.
 *
 * When no explicit `env` is supplied it defaults to `process.env` (consistent
 * with isUsageLedgerEnabled). This is load-bearing: the production dispatch seam
 * does NOT thread an explicit env into the budget path, so defaulting to `{}`
 * here would silently disable the budget guard in production (every lookup would
 * miss). Tests pass an explicit env to stay hermetic.
 */
export function resolveHardBudget(env: NodeJS.ProcessEnv | undefined): ResolvedHardBudget | null {
  const source = env ?? process.env;
  const hardBudgetTokens = parsePositiveIntegerBudget(source.LATTICE_HARD_BUDGET_TOKENS);
  if (hardBudgetTokens === null) return null;
  return {
    hardBudgetTokens,
    // Stable, self-describing policy id for the audit trail on a blocked record.
    budgetPolicyId: `hard-budget:${hardBudgetTokens}`,
  };
}

/**
 * Strict over-budget predicate: the preflight estimate must EXCEED the ceiling
 * (estimate > budget) to be over budget. The exact boundary (estimate == budget)
 * is NOT over budget. PURE and NEVER throws: a non-finite or non-numeric estimate
 * is treated as "not over budget" (fail-open — never invent a block).
 */
export function isOverHardBudget(estimatedInputTokens: number, hardBudgetTokens: number): boolean {
  if (typeof estimatedInputTokens !== 'number' || !Number.isFinite(estimatedInputTokens)) {
    return false;
  }
  if (typeof hardBudgetTokens !== 'number' || !Number.isFinite(hardBudgetTokens)) {
    return false;
  }
  return estimatedInputTokens > hardBudgetTokens;
}

// =============================================================================
// B-dd44 CHK-002: PURE blocked-budget record builder (validated, never throws)
//
// Mirrors buildUnavailableFinalRecord: a fully-formed, writer-validated record
// body assembled directly here. The block decision is recorded BEFORE any
// provider call, so the record carries the prompt-size estimate that triggered
// it (NOT a provider-reported usage) and supersedes the preflight estimate so
// the summary never double-counts.
// =============================================================================

/**
 * Build a validated `decision.kind='blocked'` record for a hard-budget refusal.
 *
 * - `decision.kind='blocked'`, `decision.budgetPolicyId` = the resolved policy id,
 *   `decision.reasonCode` defaults to `hard_budget_exceeded`;
 * - `usage.source='prompt-size-estimate'`: the call was blocked BEFORE the
 *   provider was reached, so the recorded usage is the preflight estimate that
 *   triggered the block (input only; output/cache are null/unknown). It is NEVER
 *   `provider-reported` — a blocked call produced no provider usage, so summary
 *   buckets it as unknown, never inflating provider totals;
 * - `supersedesRecordIds=[estimateRecordId]` so the blocked record supersedes the
 *   preflight estimate (or `[]` when preflight returned no estimate id);
 * - authority is local; privacy stores no raw content.
 *
 * Returns a record that PASSES validateUsageLedgerRecord. NEVER throws: any
 * assembly/validation failure is swallowed and `null` is returned so the guard
 * can decide how to proceed (fail-open) rather than crashing dispatch.
 */
export function buildBlockedBudgetRecord(
  model: string | null,
  estimateResult: { estimatedInputTokens: number; estimateRecordId: string | null },
  correlation: CallCorrelation,
  attribution: RecordAttribution,
  context: RecordContext,
  budgetPolicyId: string,
  reasonCode: string = HARD_BUDGET_REASON_CODE,
): UsageLedgerRecordInput | null {
  try {
    const boundModel = model && model.length > 0 ? model : DEFAULT_ESTIMATE_MODEL;
    const estimatedInput = isFiniteNonNegativeInteger(estimateResult.estimatedInputTokens)
      ? estimateResult.estimatedInputTokens
      : null;

    const usage: LedgerUsage = {
      // The block happened at preflight: the recorded usage is the prompt-size
      // estimate that triggered it (input only; the call never reached the
      // provider, so output/cache stay null/unknown). This is NOT provider-reported.
      source: 'prompt-size-estimate',
      inputTokens: estimatedInput,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      canonical: {
        input: estimatedInput,
        output: null,
        cacheCreation: null,
        cacheRead: null,
      },
      estimator: {
        name: 'bytes-chars-heuristic',
        version: '1',
        unit: 'utf8-bytes',
        confidence: 'low',
      },
    };

    const supersedes = buildSupersedes(estimateResult.estimateRecordId);

    const record: UsageLedgerRecordInput = {
      schemaVersion: SCHEMA_VERSION,
      recordId: mintRecordId(),
      ledgerCallId: correlation.ledgerCallId,
      attemptId: correlation.attemptId,
      sequence: 2,
      supersedesRecordIds: supersedes,
      recordedAt: context.recordedAt,
      projectRootHash: context.projectRootHash,
      storyId: attribution.storyId,
      phase: attribution.phase,
      agentType: attribution.agentType,
      subagentId: attribution.subagentId ?? null,
      threadId: attribution.threadId ?? null,
      decision: {
        kind: 'blocked',
        budgetPolicyId,
        reasonCode: reasonCode && reasonCode.length > 0 ? reasonCode : HARD_BUDGET_REASON_CODE,
      },
      usage,
      provider: { name: 'anthropic', model: boundModel },
      ...(context.command !== undefined ? { command: context.command } : {}),
      ...(context.host !== undefined ? { host: context.host } : {}),
      privacy: {
        promptStored: false,
        transcriptStored: false,
        redactionProfile: context.redactionProfile ?? 'no-raw-content-v1',
      },
      authority: { mode: 'local', receiptId: null, receiptVerified: false },
    };

    const result = validateUsageLedgerRecord(record, { expectIntegrity: false });
    if (!result.ok) return null;
    return record;
  } catch {
    // Never propagate an assembly error: the guard fails open on a null record.
    return null;
  }
}

// =============================================================================
// B-dd44 CHK-003: fail-closed pre-spawn guard orchestrator (gated, never throws)
//
// The dispatch seam keeps a MINIMAL gated guard and delegates the whole
// resolve + check + build + append to recordBudgetBlock, so lattice-dispatch.ts
// still imports usage-ledger ONLY through this single module. shouldBlockDispatch
// is the extracted PURE decision the orchestrator uses (and the smoke asserts).
// =============================================================================

/**
 * PURE block decision: a dispatch is blocked ONLY when the ledger is enabled AND
 * a hard budget is configured AND the preflight estimate strictly EXCEEDS it.
 *
 * Returns the resolved budget alongside the boolean so the caller can record the
 * policy id without re-resolving. NEVER throws: any resolution/predicate error is
 * caught and treated as "do not block" (fail-open — local non-authority never
 * invents a budget). `enabled=false` short-circuits to block=false with no env
 * read, mirroring the OFF-path no-op.
 */
export function shouldBlockDispatch(
  enabled: boolean,
  env: NodeJS.ProcessEnv | undefined,
  estimatedInputTokens: number,
): { block: boolean; budget: ResolvedHardBudget | null } {
  if (!enabled) return { block: false, budget: null };
  try {
    const budget = resolveHardBudget(env);
    if (budget === null) return { block: false, budget: null };
    return { block: isOverHardBudget(estimatedInputTokens, budget.hardBudgetTokens), budget };
  } catch {
    // Fail-open: a budget-check error must NEVER wrongly block dispatch.
    return { block: false, budget: null };
  }
}

/** The decision the dispatch seam acts on after the preflight estimate. */
export interface BudgetGuardDecision {
  /** True => the seam must SKIP spawnSync and return a blocked dispatch result. */
  blocked: boolean;
  /** The policy id that triggered the block (for the blocked dispatch result). */
  budgetPolicyId: string | null;
  /** The hard ceiling that was exceeded (for the blocked dispatch result message). */
  hardBudgetTokens: number | null;
}

/**
 * Thin gated orchestrator the dispatch seam calls AFTER recordDispatchPreflight
 * and BEFORE spawnSync. It resolves the budget, applies the strict-exceed
 * predicate, and — only when over budget — appends a validated blocked record and
 * returns {blocked:true,...}. In every other case (flag OFF, no budget, within
 * budget, or ANY error) it returns {blocked:false} so the seam proceeds exactly
 * as today.
 *
 * Fail-closed semantics: once the block decision is made, a record-write failure
 * does NOT revert the decision — the seam still skips the provider (a blocked
 * record that failed to persist must not silently call the provider). A
 * build/check error BEFORE the block decision is fail-open (proceeds).
 *
 * NEVER throws: every step is wrapped so a budget error cannot break dispatch.
 */
export function recordBudgetBlock(
  root: string,
  ctx: DispatchUsageContext,
  handle: DispatchPreflightHandle | null,
  promptText: string,
  opts: DispatchUsageOptions,
): BudgetGuardDecision {
  const notBlocked: BudgetGuardDecision = {
    blocked: false,
    budgetPolicyId: null,
    hardBudgetTokens: null,
  };

  // Strict no-op when disabled: never read env, never resolve a budget. Mirrors
  // the OFF-path no-op of recordDispatchPreflight.
  if (!isUsageLedgerEnabled(opts.env)) return notBlocked;

  // The estimate to compare against the ceiling: use the preflight handle's value
  // when present (the canonical estimate already written); otherwise recompute the
  // synchronous offline floor so a null preflight handle (write failed) still
  // gets a defensible estimate for the budget decision.
  let estimatedInputTokens: number;
  if (handle && Number.isFinite(handle.estimatedInputTokens)) {
    estimatedInputTokens = handle.estimatedInputTokens;
  } else {
    try {
      const model = ctx.model && ctx.model.length > 0 ? ctx.model : DEFAULT_ESTIMATE_MODEL;
      estimatedInputTokens = bytesCharsEstimator(model, promptText).estimatedInputTokens;
    } catch {
      // Cannot even estimate -> fail-open (never invent a block).
      return notBlocked;
    }
  }

  const { block, budget } = shouldBlockDispatch(true, opts.env, estimatedInputTokens);
  if (!block || budget === null) return notBlocked;

  // Over budget: assemble + append the blocked record. A correlation handle is
  // reused from preflight when present; otherwise a fresh one is minted so the
  // blocked record still has stable ids (it then supersedes nothing).
  try {
    const correlation = handle?.correlation ?? mintCallCorrelation();
    const record = buildBlockedBudgetRecord(
      ctx.model ?? null,
      {
        estimatedInputTokens,
        estimateRecordId: handle?.estimateRecordId ?? null,
      },
      correlation,
      attributionFor(ctx),
      finalContext(opts, ctx.model ?? null),
      budget.budgetPolicyId,
    );
    if (record === null) {
      // The blocked-record builder failed (validator rejected the assembled
      // record). Fail OPEN: proceed to spawn rather than blocking without a record.
      return notBlocked;
    }
    try {
      appendUsageRecord(root, record, { env: opts.env });
    } catch {
      // Fail-closed: once the over-budget decision is made, a write failure must
      // NOT revert it and call the provider. Still return blocked.
    }
    return {
      blocked: true,
      budgetPolicyId: budget.budgetPolicyId,
      hardBudgetTokens: budget.hardBudgetTokens,
    };
  } catch {
    // An unexpected assembly error before the record was committed -> fail-open.
    return notBlocked;
  }
}
