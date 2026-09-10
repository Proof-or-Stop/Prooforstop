import { runSupervisedProviderProcess, type SupervisedProcessOptions } from './supervised-process.js';

import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import type { ProviderExecRequest, ProviderExecResult } from './types.js';

/** Local Gemini CLI binary name. */
export const GEMINI_CLI_BINARY = 'gemini';

/**
 * Bounded preflight: is the Gemini CLI binary resolvable on PATH?
 *
 * Used by the planned-steps executor / proof-or-stop-dispatch live-dispatch routing
 * to fail closed with `provider_unavailable` BEFORE a `provider.gemini` step
 * starts, instead of discovering a missing CLI mid-run. Probes via `command -v`
 * and never spawns an interactive session. Contract-parallel to
 * `codexCliAvailable` (codex-cli.ts) — availability is a preflight requirement,
 * not a runtime surprise.
 */
export function geminiCliAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const probe = spawnSync('command', ['-v', GEMINI_CLI_BINARY], {
      env,
      shell: '/bin/sh',
      stdio: 'ignore',
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

/** Injectable process runner so smoke tests never spawn a real Gemini CLI. */
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

const defaultGeminiProcessRunner: ProviderProcessRunner = runSupervisedProviderProcess;

function providerDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function classifySpawnErrorKind(code: string | undefined): ProviderExecResult['spawnErrorKind'] {
  if (code === 'ENOENT') return 'missing_executable';
  if (code === 'E2BIG') return 'argv_too_large';
  return 'spawn_failed';
}

/** Best-effort model extraction from Gemini JSON output; never required for success. */
function extractGeminiModel(stdout: string): string | undefined {
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
 * as its OWN property (never via the prototype chain). Reading a candidate
 * usageMetadata key (obj.usageMetadata / obj.response.usageMetadata) through the
 * prototype chain would let a polluted Object.prototype.usageMetadata masquerade
 * as real provider usage on a line with NO own usageMetadata key — so every read
 * goes through this guard first.
 */
function ownProp(o: unknown, k: string): boolean {
  return o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
}

/** A usageMetadata object is one carrying any of the Gemini token-count fields. */
function isGeminiUsageObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return (
    ownProp(value, 'promptTokenCount')
    || ownProp(value, 'candidatesTokenCount')
    || ownProp(value, 'cachedContentTokenCount')
  );
}

/**
 * The ONLY keys the Gemini adapter reads off a `usageMetadata` object. Everything
 * else (an embedded transcript/text/candidates/__proto__/etc.) is dropped by the
 * whitelist projection so a provider transcript can never ride along on the
 * reportedUsage surface. `cachedContentTokenCount` is preserved verbatim because
 * cacheRead depends on it.
 */
const GEMINI_USAGE_KEYS = [
  'promptTokenCount',
  'candidatesTokenCount',
  'cachedContentTokenCount',
] as const;

/**
 * Whitelist-project a matched usageMetadata object down to ONLY the adapter-read
 * keys. Own-enumerable keys only (hasOwnProperty guard on the SOURCE, so an
 * inherited / prototype-polluted key never leaks IN). Values are copied VERBATIM
 * — the adapter is the validator, so we never transform them here. A key absent
 * on the source stays absent on the result.
 *
 * SECURITY: the projected object is built with a NULL prototype
 * (Object.create(null)) so it has NO prototype chain. A normal `{}` carries
 * Object.prototype, so a downstream adapter reading a key that was NOT projected
 * (e.g. adaptGeminiUsage reading `usage.promptTokenCount` when the source carried
 * only `candidatesTokenCount`) would resolve a POLLUTED
 * Object.prototype.promptTokenCount via inheritance — a bogus provider-reported
 * count. With a null-proto result such a read resolves to `undefined`, so an
 * absent token field stays absent. The result is still a plain
 * `Record<string, unknown>` (typeof === 'object', not null) that the adapters
 * accept; they only read OWN keys, which remain present.
 */
function pickGeminiUsageKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of GEMINI_USAGE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) out[key] = obj[key];
  }
  return out;
}

/**
 * Best-effort token-count usage extraction from Gemini JSON output; never required
 * for success. Contract-parallel to extractGeminiModel: iterate the JSONL lines,
 * skip blanks, JSON.parse each in a try/catch, and return the FIRST Gemini-shape
 * `usageMetadata` sub-object found — checked at the top level
 * (`obj.usageMetadata`) and nested under `response` (`obj.response.usageMetadata`).
 * Returns a NEW object carrying ONLY the keys the Gemini adapter reads
 * (promptTokenCount / candidatesTokenCount / cachedContentTokenCount when
 * present), NEVER the whole line/envelope, any other key, or any transcript text.
 * Never throws; returns undefined when no usageMetadata object is present.
 *
 * SECURITY: every candidate read is OWN-property guarded (ownProp). A polluted
 * Object.prototype.usageMetadata must NEVER be read off a line with no own
 * usageMetadata key — we only consider `obj.usageMetadata` /
 * `obj.response.usageMetadata` when they are OWN props, so prototype-chain reads
 * can never inject bogus token counts.
 */
function extractGeminiUsage(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as {
        usageMetadata?: unknown;
        response?: { usageMetadata?: unknown };
      };
      if (ownProp(obj, 'usageMetadata') && isGeminiUsageObject(obj.usageMetadata)) {
        return pickGeminiUsageKeys(obj.usageMetadata);
      }
      const resp = ownProp(obj, 'response') ? obj.response : undefined;
      if (ownProp(resp, 'usageMetadata') && isGeminiUsageObject(resp!.usageMetadata)) {
        return pickGeminiUsageKeys(resp!.usageMetadata as Record<string, unknown>);
      }
    } catch { /* skip non-json lines */ }
  }
  return undefined;
}

/**
 * Run a single bounded `provider.gemini` request, capturing structured evidence.
 *
 * Contract-parallel to `runBoundedCodexProvider` (codex-cli.ts) — caller is
 * responsible for the policy/availability/credential preflight gates BEFORE
 * this runs; this function performs the bounded spawn itself: a stdin-closed
 * argv invocation with the already-redacted env, retrying ONLY on timeout (a
 * missing binary or a non-zero exit is terminal — real provider work never
 * burns repair loops on a definite failure). Captures stdout/stderr as digests
 * + byte counts only; raw output is never surfaced, so a provider transcript
 * can neither leak credentials nor be promoted into gate evidence.
 */
export function runBoundedGeminiProvider(
  request: ProviderExecRequest,
  runner: ProviderProcessRunner = defaultGeminiProcessRunner,
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
    const out = runner(GEMINI_CLI_BINARY, request.argv, {
      cwd: request.cwd,
      env: request.env,
      timeoutMs: request.timeoutMs,
      admission: request.admission,
      stdin: request.stdin,
    });
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

  const model = extractGeminiModel(stdout);
  const reportedUsage = extractGeminiUsage(stdout);
  return {
    provider: 'gemini',
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
