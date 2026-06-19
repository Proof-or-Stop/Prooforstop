
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import type { ProviderExecRequest, ProviderExecResult } from './types.js';

/** Local Gemini CLI binary name. */
export const GEMINI_CLI_BINARY = 'gemini';

/**
 * Bounded preflight: is the Gemini CLI binary resolvable on PATH?
 *
 * Used by the planned-steps executor / lattice-dispatch live-dispatch routing
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
  error?: NodeJS.ErrnoException;
}

export type ProviderProcessRunner = (
  binary: string,
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => ProviderProcessOutcome;

const defaultGeminiProcessRunner: ProviderProcessRunner = (binary, argv, opts) => {
  const proc = spawnSync(binary, argv, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs,
    // Close stdin: a bounded, non-interactive action must never block waiting
    // for a prompt. An unattended runner must not hang on an open gemini
    // stdin pipe.
    input: '',
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: proc.status,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    signal: proc.signal,
    error: proc.error as NodeJS.ErrnoException | undefined,
  };
};

function providerDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
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

/** A usageMetadata object is one carrying any of the Gemini token-count fields. */
function isGeminiUsageObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const u = value as Record<string, unknown>;
  return (
    'promptTokenCount' in u || 'candidatesTokenCount' in u || 'cachedContentTokenCount' in u
  );
}

/**
 * Best-effort token-count usage extraction from Gemini JSON output; never required
 * for success. Contract-parallel to extractGeminiModel: iterate the JSONL lines,
 * skip blanks, JSON.parse each in a try/catch, and return the FIRST Gemini-shape
 * `usageMetadata` sub-object found — checked at the top level
 * (`obj.usageMetadata`) and nested under `response` (`obj.response.usageMetadata`).
 * Returns ONLY the numeric usageMetadata sub-object (the token-count fields),
 * NEVER the whole line/envelope or any transcript text. Never throws; returns
 * undefined when no usageMetadata object is present.
 */
function extractGeminiUsage(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as {
        usageMetadata?: unknown;
        response?: { usageMetadata?: unknown };
      };
      if (isGeminiUsageObject(obj.usageMetadata)) return obj.usageMetadata;
      if (obj.response && isGeminiUsageObject(obj.response.usageMetadata)) {
        return obj.response.usageMetadata;
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
  let timedOut = false;

  while (attempts < maxAttempts) {
    attempts++;
    const out = runner(GEMINI_CLI_BINARY, request.argv, {
      cwd: request.cwd,
      env: request.env,
      timeoutMs: request.timeoutMs,
    });
    spawnError = !!out.error && out.error.code === 'ENOENT';
    timedOut = out.signal === 'SIGTERM' || out.signal === 'SIGKILL'
      || (!!out.error && out.error.code === 'ETIMEDOUT');
    status = out.status;
    stdout = out.stdout ?? '';
    stderr = out.stderr ?? '';
    if (spawnError) break; // missing binary is not retryable
    if (!timedOut) break;  // success or non-zero exit is terminal
  }

  const model = extractGeminiModel(stdout);
  const reportedUsage = extractGeminiUsage(stdout);
  return {
    provider: 'gemini',
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
  };
}
