
import { join } from 'path';
import { randomUUID, createHash } from 'crypto';
import {
  writeFileSync, unlinkSync, mkdirSync,
  existsSync, rmSync,
} from 'fs';
import { spawn, spawnSync } from 'child_process';
import type {
  ILLMProvider, LLMCallOptions, LLMResponse,
  ProviderExecRequest, ProviderExecResult,
} from './types.js';

/** Local Claude Code CLI binary name. */
export const CLAUDE_CLI_BINARY = 'claude';

/**
 * Bounded preflight: is the Claude Code CLI binary resolvable on PATH?
 *
 * Used by the planned-steps executor to fail closed with `provider_unavailable`
 * BEFORE a `provider.claude` step starts, instead of discovering a missing CLI
 * mid-run. Probes via `command -v` and never spawns an interactive session.
 */
export function claudeCliAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const probe = spawnSync('command', ['-v', CLAUDE_CLI_BINARY], {
      env,
      shell: '/bin/sh',
      stdio: 'ignore',
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

export interface ClaudeCliProviderOptions {
  model?: string;
  debug?: boolean;
  retries?: number;
  timeout?: number;
  heartbeatInterval?: number;
  tools?: boolean;
  allowedTools?: string[];
  skills?: boolean;
  tmpDir?: string;
}

export const CLAUDE_CLI_DEFAULT_TIMEOUT_MS = 600_000;

const DEFAULTS: Required<ClaudeCliProviderOptions> = {
  model: 'claude-sonnet-4-20250514',
  debug: false,
  retries: 5,
  timeout: CLAUDE_CLI_DEFAULT_TIMEOUT_MS,
  heartbeatInterval: 30_000,
  tools: false,
  allowedTools: [],
  skills: false,
  tmpDir: '.tmp-claude-session',
};

export class ClaudeCliProvider implements ILLMProvider {
  readonly name = 'claude-cli';
  private opts: Required<ClaudeCliProviderOptions>;
  private tmpDir: string;

  constructor(options: ClaudeCliProviderOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.tmpDir = this.opts.tmpDir;
    if (!existsSync(this.tmpDir)) mkdirSync(this.tmpDir, { recursive: true });
  }

  private dbg(label: string, msg: string, onDebug?: (m: string) => void): void {
    if (!this.opts.debug) return;
    const line = `[DEBUG ${label}] ${msg}`;
    if (onDebug) onDebug(line);
    else console.log(`    ${line}`);
  }

  async call(prompt: string, options: LLMCallOptions = {}): Promise<LLMResponse> {
    const label = options.label ?? '';
    const timeout = options.timeout ?? this.opts.timeout;
    const tmpFile = join(this.tmpDir, `${randomUUID()}.txt`);
    writeFileSync(tmpFile, prompt, 'utf-8');
    const startTime = Date.now();

    const dbg = (msg: string) => this.dbg(label, msg, options.onDebug);

    const skillFlags = this.opts.skills ? '' : ' --disable-slash-commands --setting-sources user';
    const toolFlags = this.opts.tools
      ? (this.opts.allowedTools.length
        ? ` --allowedTools ${this.opts.allowedTools.join(' ')}`
        : '')
      : ' --disallowedTools Bash Read Edit Write Glob Grep Agent NotebookEdit';
    const debugFlag = this.opts.debug ? ' --debug' : '';

    const cmd = `cat "${tmpFile}" | claude -p --verbose --model ${this.opts.model} --output-format stream-json --no-session-persistence --dangerously-skip-permissions${skillFlags}${toolFlags}${debugFlag}`;
    dbg(`cmd: ${cmd}`);

    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith('CLAUDE')) delete env[key];
      }

      const child = spawn('sh', ['-c', cmd], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      dbg(`child PID: ${child.pid}`);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let killed = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        stdoutChunks.push(chunk);

        if (options.onStream) {
          const raw = chunk.toString('utf-8');
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              options.onStream(obj.type, obj);
            } catch { /* skip non-json lines */ }
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        stderrChunks.push(chunk);
      });

      const timer = setTimeout(() => {
        killed = true;
        dbg(`TIMEOUT after ${Date.now() - startTime}ms`);
        child.kill('SIGKILL');
      }, timeout);

      const heartbeat = setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        dbg(`heartbeat: ${elapsed}s elapsed, stdout: ${stdoutBytes} bytes`);
        if (options.onHeartbeat) options.onHeartbeat(elapsed, stdoutBytes, stderrBytes);
      }, this.opts.heartbeatInterval);

      child.on('close', (code) => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        try { unlinkSync(tmpFile); } catch { /* ignore */ }

        const elapsed = Date.now() - startTime;
        const rawStdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');

        let output = '';
        for (const line of rawStdout.split('\n')) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'result' && obj.result) {
              output = obj.result;
            }
            if (!output && obj.type === 'assistant' && obj.message?.content) {
              output = obj.message.content
                .filter((c: { type: string }) => c.type === 'text')
                .map((c: { text: string }) => c.text)
                .join('\n');
            }
          } catch { /* skip */ }
        }
        output = output.trim();

        dbg(`closed: code=${code} elapsed=${elapsed}ms output=${output.length} chars`);

        if (killed) {
          return reject(new Error(`claude CLI timeout (${timeout / 1000}s)`));
        }
        if (output && (code === 0 || output.length > 50)) {
          return resolve({ text: output, elapsed });
        }
        const errMsg = !output
          ? `claude returned empty output (code=${code}, elapsed=${elapsed}ms, stderr=${stderr.trim().slice(0, 200)})`
          : (stderr.trim() || `exit code ${code}`);
        reject(new Error(errMsg));
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
        reject(err);
      });
    });
  }

  async callWithRetry(prompt: string, options: LLMCallOptions = {}): Promise<LLMResponse> {
    const label = options.label ?? '';
    const retries = options.retries ?? this.opts.retries;
    let lastErr: Error | undefined;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await this.call(prompt, options);
      } catch (e) {
        lastErr = e as Error;
        if (attempt < retries && this.isRetryable(lastErr)) {
          const isEmpty = lastErr.message.includes('empty output');
          const delay = isEmpty ? 0 : Math.min(1000 * 2 ** (attempt - 1), 30_000);
          this.dbg(label, `attempt ${attempt} failed (${lastErr.message.slice(0, 80)}), retry in ${delay}ms...`, options.onDebug);
          if (delay) await new Promise(r => setTimeout(r, delay));
        } else if (!this.isRetryable(lastErr)) {
          break;
        }
      }
    }
    throw new Error(`claude CLI call failed (${retries} attempts): ${lastErr!.message.slice(0, 300)}`);
  }

  private isRetryable(err: Error): boolean {
    const msg = err.message.toLowerCase();
    return msg.includes('empty output') || msg.includes('network') ||
      msg.includes('timeout') || msg.includes('econnreset') ||
      msg.includes('econnrefused') || msg.includes('socket') ||
      msg.includes('overloaded') || msg.includes('529') ||
      msg.includes('500') || msg.includes('502') || msg.includes('503') ||
      msg.includes('rate') || msg.includes('etimedout') || msg.includes('epipe');
  }

  cleanup(): void {
    try { rmSync(this.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// --- Bounded provider.claude execution (M7) ----------------------------------
//
// This is the REAL bounded executor for the `provider.claude` planned step type.
// It is NOT the open-ended ClaudeCliProvider chat above: a bounded action is a
// single argv-mapped, stdin-closed Claude CLI invocation with explicit cwd, a hard
// timeout, and an attempt cap. It captures stdout/stderr/exit/duration as DIGESTS
// only (+ best-effort model metadata) so a provider transcript can never leak
// secrets or be promoted into validation / gate evidence.

/**
 * Env vars the Claude Code CLI recognizes for NON-INTERACTIVE authentication.
 * Unattended bounded execution must authenticate through one of these; it must
 * never fall back to an interactive login prompt.
 */
export const CLAUDE_NONINTERACTIVE_AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

function nonEmptyEnv(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Claude noninteractive auth preflight (B3b). Auth is "available" ONLY when a
 * recognized Claude auth credential is BOTH allowlisted (so the redacted env
 * projection will actually carry it to the child) AND present non-empty. A
 * credential that is not allowlisted would be stripped by redaction and never
 * reach the CLI, so it does not count — this fails closed against an interactive
 * login fallback in unattended mode.
 */
export function claudeNoninteractiveAuthAvailable(
  env: NodeJS.ProcessEnv,
  credentialsEnvAllowlist: readonly string[],
): boolean {
  return CLAUDE_NONINTERACTIVE_AUTH_ENV_VARS.some(
    name => credentialsEnvAllowlist.includes(name) && nonEmptyEnv(env[name]),
  );
}

/** Bounded provider.claude availability: the Claude CLI binary must resolve on PATH. */
export function claudeProviderAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return claudeCliAvailable(env);
}

/** Injectable process runner so smoke tests never spawn a real Claude CLI. */
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

const defaultClaudeProcessRunner: ProviderProcessRunner = (binary, argv, opts) => {
  const proc = spawnSync(binary, argv, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs,
    // Close stdin: a bounded, non-interactive action must never block waiting for
    // a prompt. Combined with the auth preflight this keeps unattended runs hang-free.
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

/** Best-effort model extraction from Claude stream-json output; never required. */
function extractClaudeModel(stdout: string): string | undefined {
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
 * Run a single bounded `provider.claude` request, capturing structured evidence.
 *
 * The caller (planned-steps executor) is responsible for the policy/availability/
 * credential/auth preflight gates BEFORE this runs; this function performs the
 * bounded spawn itself: stdin-closed argv invocation with the already-redacted env,
 * retrying ONLY on timeout (a missing binary or a non-zero exit is terminal — real
 * provider work never burns repair loops on a definite failure).
 */
export function runBoundedClaudeProvider(
  request: ProviderExecRequest,
  runner: ProviderProcessRunner = defaultClaudeProcessRunner,
): ProviderExecResult {
  // Delegated `provider.claude` is evidence-only execution; it must never mint local authority receipts or alter DONE semantics.
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
    const out = runner(CLAUDE_CLI_BINARY, request.argv, {
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

  const model = extractClaudeModel(stdout);
  return {
    provider: 'claude',
    ...(model ? { model } : {}),
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
