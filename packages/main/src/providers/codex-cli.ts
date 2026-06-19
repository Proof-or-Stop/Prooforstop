
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
  error?: NodeJS.ErrnoException;
}

export type ProviderProcessRunner = (
  binary: string,
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => ProviderProcessOutcome;

const defaultCodexProcessRunner: ProviderProcessRunner = (binary, argv, opts) => {
  const proc = spawnSync(binary, argv, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs,
    // Close stdin: a bounded, non-interactive action must never block waiting for
    // a prompt. An unattended runner must not hang on an open codex stdin pipe.
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

/** A usage object is one carrying any of the OpenAI token-count fields. */
function isCodexUsageObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const u = value as Record<string, unknown>;
  return 'prompt_tokens' in u || 'completion_tokens' in u || 'prompt_tokens_details' in u;
}

/**
 * Best-effort token-count usage extraction from Codex JSON output; never required
 * for success. EXACTLY analogous to extractCodexModel: iterate the JSONL lines,
 * skip blanks, JSON.parse each in a try/catch, and return the FIRST OpenAI-shape
 * `usage` sub-object found — checked at the top level (`obj.usage`) and nested
 * under `message` (`obj.message.usage`), mirroring extractCodexModel's
 * obj.message.model precedent. Returns ONLY the numeric usage sub-object (the
 * token-count fields), NEVER the whole line/envelope or any transcript text.
 * Never throws; returns undefined when no usage object is present.
 */
function extractCodexUsage(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { usage?: unknown; message?: { usage?: unknown } };
      if (isCodexUsageObject(obj.usage)) return obj.usage;
      if (obj.message && isCodexUsageObject(obj.message.usage)) return obj.message.usage;
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
    const out = runner(CODEX_CLI_BINARY, request.argv, {
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

  const model = extractCodexModel(stdout);
  const reportedUsage = extractCodexUsage(stdout);
  return {
    provider: 'codex',
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
