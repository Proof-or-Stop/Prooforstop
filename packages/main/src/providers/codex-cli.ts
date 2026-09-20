import { runBudgetedProviderRequest, runCoveredProviderTransport } from '../core/provider-call-budget.js';
import { runSupervisedProviderProcess, type SupervisedProcessOptions } from './supervised-process.js';

import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import type { ProviderExecRequest, ProviderExecResult } from './types.js';

/** Local Codex CLI binary name. */
export const CODEX_CLI_BINARY = 'codex';

/**
 * Bounded preflight: is the Codex CLI binary resolvable on PATH?
 *
 * Used by the planned-steps executor to fail closed with `provider_unavailable`
 * BEFORE a `provider.codex` step starts, instead of discovering a missing CLI
 * mid-run. Probes via `command -v` and never spawns an interactive session. This
 * mirrors `claudeCliAvailable` (claude-cli.ts) so both real bounded providers
 * resolve availability the same way — availability is a preflight requirement
 * (B3a), not a runtime surprise.
 */
export function codexCliAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const probe = spawnSync('command', ['-v', CODEX_CLI_BINARY], {
      env,
      shell: '/bin/sh',
      stdio: 'ignore',
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

/** Injectable process runner so smoke tests never spawn a real Codex CLI. */
export interface ProviderProcessOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  replacementSafe?: boolean;
  timedOut?: boolean;
  error?: NodeJS.ErrnoException;
}

export type ProviderProcessRunner = (
  binary: string,
  argv: string[],
  opts: SupervisedProcessOptions,
) => ProviderProcessOutcome;

const defaultCodexProcessRunner: ProviderProcessRunner = runSupervisedProviderProcess;

function providerDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function classifySpawnErrorKind(code: string | undefined): ProviderExecResult['spawnErrorKind'] {
  if (code === 'ENOENT') return 'missing_executable';
  if (code === 'E2BIG') return 'argv_too_large';
  return 'spawn_failed';
}

/** Best-effort model extraction from Codex JSON output; never required for success. */
function extractCodexModel(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { model?: unknown; message?: { model?: unknown } };
      if (typeof obj.model === 'string') return obj.model;
      if (obj.message && typeof obj.message.model === 'string') return obj.message.model;
    } catch { /* skip non-json lines */ }
  }
  return undefined;
}

/**
 * OWN-property guard: true only when `o` is a non-null object that carries `k`
 * as its OWN property (never via the prototype chain). Reading a candidate usage
 * key (obj.usage / obj.message.usage) through the prototype chain would let a
 * polluted Object.prototype.usage masquerade as real provider usage on a line
 * with NO own usage key — so every read goes through this guard first.
 */
function ownProp(o: unknown, k: string): boolean {
  return o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
}

/** A usage object is one carrying any of the OpenAI token-count fields. */
function isCodexUsageObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return (
    ownProp(value, 'prompt_tokens')
    || ownProp(value, 'completion_tokens')
    || ownProp(value, 'prompt_tokens_details')
  );
}

/**
 * The ONLY keys the OpenAI adapter reads off a codex `usage` object. Everything
 * else (an embedded transcript/text/message/role/__proto__/etc.) is dropped by
 * the whitelist projection so a provider transcript can never ride along on the
 * reportedUsage surface. `prompt_tokens_details` is preserved verbatim because
 * cacheRead depends on its nested `cached_tokens`.
 */
const CODEX_USAGE_KEYS = ['prompt_tokens', 'completion_tokens', 'prompt_tokens_details'] as const;

/** The ONLY nested key the OpenAI adapter reads off prompt_tokens_details. */
const CODEX_NESTED_DETAIL_KEYS = ['cached_tokens'] as const;

/**
 * Whitelist-project the NESTED `prompt_tokens_details` object down to ONLY the
 * single key the OpenAI adapter reads (`cached_tokens`). Builds a fresh
 * null-prototype object carrying ONLY the source's OWN `cached_tokens` (via
 * hasOwnProperty), so:
 *   - a non-token own key (e.g. `transcript`) can NEVER ride along onto the
 *     reportedUsage surface — the token-only projection contract holds at the
 *     nested level just like CODEX_USAGE_KEYS holds at the top level; and
 *   - the OpenAI adapter reads `cached_tokens` via `'cached_tokens' in details`
 *     (a prototype-chain `in`), so a polluted Object.prototype.cached_tokens on
 *     a details object that still carried Object.prototype would otherwise leak
 *     into cacheReadInputTokens — the null prototype closes that read.
 * One level is sufficient — the adapter only reads `details.cached_tokens`,
 * never deeper. A non-object value is returned VERBATIM (the adapter rejects
 * non-objects).
 */
function sanitizeNestedDetails(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const src = value as Record<string, unknown>;
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of CODEX_NESTED_DETAIL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key];
  }
  return out;
}

/**
 * Whitelist-project a matched usage object down to ONLY the adapter-read keys.
 * Own-enumerable keys only (hasOwnProperty guard on the SOURCE, so an inherited /
 * prototype-polluted key never leaks IN). Token-count values are copied VERBATIM
 * — the adapter is the validator, so we never transform them here. A key absent
 * on the source stays absent on the result.
 *
 * SECURITY: the projected object is built with a NULL prototype
 * (Object.create(null)) so it has NO prototype chain. A normal `{}` carries
 * Object.prototype, so a downstream adapter reading a key that was NOT projected
 * (e.g. adaptOpenAiUsage reading `usage.prompt_tokens` when the source carried
 * only `completion_tokens`) would resolve a POLLUTED Object.prototype.prompt_tokens
 * via inheritance — a bogus provider-reported count. With a null-proto result
 * such a read resolves to `undefined`, so an absent token field stays absent. The
 * result is still a plain `Record<string, unknown>` (typeof === 'object', not
 * null) that the adapters accept; they only read OWN keys, which remain present.
 *
 * NESTED-OBJECT HARDENING (B-fe1f): the top-level null-proto alone is NOT enough.
 * The OpenAI adapter does NOT read cacheRead off the top-level usage — it reads
 * `prompt_tokens_details.cached_tokens` via an `in`/access on the NESTED details
 * object. Copying that details object VERBATIM preserves its Object.prototype, so
 * a polluted Object.prototype.cached_tokens (with the source details carrying NO
 * own cached_tokens, e.g. an empty `{}`) would leak into cacheReadInputTokens.
 * So when `prompt_tokens_details` is a non-null object we re-copy it into a fresh
 * null-proto object (own keys only) too — making EVERY object the adapter reads
 * (top-level usage AND prompt_tokens_details) null-prototype, so no inherited key
 * can leak anywhere downstream. Absent / non-object details are preserved as-is.
 */
function pickCodexUsageKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of CODEX_USAGE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    out[key] = key === 'prompt_tokens_details' ? sanitizeNestedDetails(obj[key]) : obj[key];
  }
  return out;
}

/**
 * Best-effort token-count usage extraction from Codex JSON output; never required
 * for success. EXACTLY analogous to extractCodexModel: iterate the JSONL lines,
 * skip blanks, JSON.parse each in a try/catch, and return the FIRST OpenAI-shape
 * `usage` sub-object found — checked at the top level (`obj.usage`) and nested
 * under `message` (`obj.message.usage`), mirroring extractCodexModel's
 * obj.message.model precedent. Returns a NEW object carrying ONLY the keys the
 * OpenAI adapter reads (prompt_tokens / completion_tokens / prompt_tokens_details
 * when present), NEVER the whole line/envelope, any other key, or any transcript
 * text. Never throws; returns undefined when no usage object is present.
 *
 * SECURITY: every candidate read is OWN-property guarded (ownProp). A polluted
 * Object.prototype.usage must NEVER be read off a line with no own usage key —
 * we only consider `obj.usage` / `obj.message.usage` when they are OWN props,
 * so prototype-chain reads can never inject bogus token counts.
 */
function extractCodexUsage(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { usage?: unknown; message?: { usage?: unknown } };
      if (ownProp(obj, 'usage') && isCodexUsageObject(obj.usage)) {
        return pickCodexUsageKeys(obj.usage);
      }
      const msg = ownProp(obj, 'message') ? obj.message : undefined;
      if (ownProp(msg, 'usage') && isCodexUsageObject(msg!.usage)) {
        return pickCodexUsageKeys(msg!.usage as Record<string, unknown>);
      }
    } catch { /* skip non-json lines */ }
  }
  return undefined;
}

/**
 * Run a single bounded `provider.codex` request, capturing structured evidence.
 *
 * The caller (planned-steps executor) is responsible for the policy/availability/
 * credential preflight gates BEFORE this runs; this function performs the bounded
 * spawn itself: a stdin-closed argv invocation with the already-redacted env,
 * retrying ONLY on timeout (a missing binary or a non-zero exit is terminal — real
 * provider work never burns repair loops on a definite failure). It captures
 * stdout/stderr as digests + byte counts only; raw output is never surfaced, so a
 * provider transcript can neither leak credentials nor be promoted into gate
 * evidence.
 */
export function runBoundedCodexProvider(
  request: ProviderExecRequest,
  runner: ProviderProcessRunner = defaultCodexProcessRunner,
): ProviderExecResult {
  return runBudgetedProviderRequest(request, admitted => runAdmittedCodexProvider(admitted, runner));
}
function runAdmittedCodexProvider(
  request: ProviderExecRequest,
  runner: ProviderProcessRunner = defaultCodexProcessRunner,
): ProviderExecResult {
  const startedAt = Date.now();
  const maxAttempts = Math.max(1, Math.min(request.maxAttempts, 5));
  let attempts = 0;
  let status: number | null = null;
  let stdout = '';
  let stderr = '';
  let spawnError = false;
  let spawnErrorCode: string | undefined;
  let spawnErrorKind: ProviderExecResult['spawnErrorKind'] | undefined;
  let timedOut = false;
  let replacementSafe: boolean | undefined;

  while (attempts < maxAttempts) {
    attempts++;
    const transportOptions: SupervisedProcessOptions = {
      cwd: request.cwd,
      env: request.env,
      timeoutMs: request.timeoutMs,
      admission: request.admission,
      stdin: request.stdin,
    };
    const out = runCoveredProviderTransport(request, transportOptions, () => runner(CODEX_CLI_BINARY, request.argv, transportOptions));
    replacementSafe = out.replacementSafe;
    timedOut = out.timedOut ?? (out.signal === 'SIGTERM' || out.signal === 'SIGKILL'
      || (!!out.error && out.error.code === 'ETIMEDOUT'));
    spawnError = !!out.error && !timedOut;
    spawnErrorCode = spawnError ? out.error?.code : undefined;
    spawnErrorKind = spawnError ? classifySpawnErrorKind(spawnErrorCode) : undefined;
    status = out.status;
    stdout = out.stdout ?? '';
    stderr = out.stderr ?? '';
    if (replacementSafe === false) break;
    if (spawnError) break; // spawn setup failures are not retryable
    if (!timedOut) break;  // success or non-zero exit is terminal
  }

  const model = extractCodexModel(stdout);
  const reportedUsage = extractCodexUsage(stdout);
  return {
    provider: 'codex',
    ...(replacementSafe !== undefined ? { replacementSafe } : {}),
    ...(model ? { model } : {}),
    ...(reportedUsage ? { reportedUsage } : {}),
    argvDigest: providerDigest(request.argv),
    exitCode: spawnError ? null : status,
    stdoutDigest: providerDigest(stdout),
    stderrDigest: providerDigest(stderr),
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    durationMs: Date.now() - startedAt,
    attempts,
    timedOut,
    spawnError,
    ...(spawnErrorCode ? { spawnErrorCode } : {}),
    ...(spawnErrorKind ? { spawnErrorKind } : {}),
  };
}
