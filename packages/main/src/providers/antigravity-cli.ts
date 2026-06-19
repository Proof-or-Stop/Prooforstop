
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import type { ProviderExecRequest, ProviderExecResult } from './types.js';

/** Local Antigravity CLI binary name. */
export const ANTIGRAVITY_CLI_BINARY = 'agy';

/**
 * Bounded preflight: is the Antigravity CLI binary resolvable on PATH?
 *
 * Used by the planned-steps executor / lattice-dispatch live-dispatch routing
 * to fail closed with `provider_unavailable` BEFORE a `provider.antigravity`
 * step starts, instead of discovering a missing CLI mid-run. Probes via
 * `command -v` and never spawns an interactive session. Contract-parallel to
 * `codexCliAvailable` (codex-cli.ts) — availability is a preflight requirement,
 * not a runtime surprise.
 */
export function antigravityCliAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const probe = spawnSync('command', ['-v', ANTIGRAVITY_CLI_BINARY], {
      env,
      shell: '/bin/sh',
      stdio: 'ignore',
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

/** Injectable process runner so smoke tests never spawn a real Antigravity CLI. */
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

const defaultAntigravityProcessRunner: ProviderProcessRunner = (binary, argv, opts) => {
  const proc = spawnSync(binary, argv, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs,
    // Close stdin: a bounded, non-interactive action must never block waiting
    // for a prompt. An unattended runner must not hang on an open agy stdin
    // pipe.
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

/**
 * Best-effort model extraction from an `agy --log-file` `label="..."` line; never
 * required for success. `agy --print` writes ONLY the response text to stdout (no
 * model envelope), so when a `--log-file` is wired the runner may parse the
 * `label="<model>"` token from the captured log/stderr to attribute the model.
 * Returns undefined when no line carries a label, in which case the dispatch
 * layer falls back to the REQUESTED `--model` (or 'unknown'). Reads ONLY the
 * label token, NEVER any transcript text. Never throws.
 */
function extractAntigravityModel(logText: string): string | undefined {
  for (const line of logText.split('\n')) {
    const match = /\blabel="([^"]+)"/.exec(line);
    if (match && match[1].trim()) return match[1].trim();
  }
  return undefined;
}

/**
 * Run a single bounded `provider.antigravity` request, capturing structured
 * evidence.
 *
 * Contract-parallel to `runBoundedCodexProvider` (codex-cli.ts) — caller is
 * responsible for the policy/availability/credential preflight gates BEFORE
 * this runs; this function performs the bounded spawn itself: a stdin-closed
 * argv invocation with the already-redacted env, retrying ONLY on timeout (a
 * missing binary or a non-zero exit is terminal — real provider work never
 * burns repair loops on a definite failure). Captures stdout/stderr as digests
 * + byte counts only; raw output is never surfaced, so a provider transcript
 * can neither leak credentials nor be promoted into gate evidence.
 *
 * `agy --print` does NOT emit per-call token usage (no usageMetadata), so
 * `reportedUsage` is NEVER set — antigravity finals always land in the
 * source=unavailable ledger branch (never-infer-an-unreported-value).
 */
export function runBoundedAntigravityProvider(
  request: ProviderExecRequest,
  runner: ProviderProcessRunner = defaultAntigravityProcessRunner,
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
    const out = runner(ANTIGRAVITY_CLI_BINARY, request.argv, {
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

  // agy --print emits only response text on stdout (no model envelope). Best-effort
  // parse a `label="..."` token from stderr (where agy may echo a `--log-file`
  // style line); the dispatch layer records the REQUESTED model when this is
  // absent.
  const model = extractAntigravityModel(stderr);
  return {
    provider: 'antigravity',
    ...(model ? { model } : {}),
    // reportedUsage is intentionally NEVER set: agy print mode surfaces no
    // per-call token usage, and fabricating one would violate
    // never-infer-an-unreported-value.
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
