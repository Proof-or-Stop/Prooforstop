import type { ProviderProcessAdmission } from '../core/provider-process-admission.js';

export interface LLMCallOptions {
  /** Call label (for logging) */
  label?: string;
  /** Timeout (ms) */
  timeout?: number;
  /** Retry count */
  retries?: number;
  /** Streaming callback */
  onStream?: (type: string, data: unknown) => void;
  /** Heartbeat callback */
  onHeartbeat?: (elapsedSec: number, stdoutBytes: number, stderrBytes: number) => void;
  /** Debug callback */
  onDebug?: (msg: string) => void;
}

export interface LLMResponse {
  /** Model output text */
  text: string;
  /** Elapsed time (ms) */
  elapsed: number;
}

export interface ILLMProvider {
  /** Provider name */
  readonly name: string;

  /** Single call */
  call(prompt: string, options?: LLMCallOptions): Promise<LLMResponse>;

  /** Call with retry */
  callWithRetry(prompt: string, options?: LLMCallOptions): Promise<LLMResponse>;
}

// --- Bounded provider execution (M7) -------------------------------------
// A bounded provider action is NOT open-ended chat. It is a single argv-mapped
// invocation of a local provider CLI (Codex / Claude Code) with an explicit cwd,
// timeout, and attempt cap. The executor captures stdout/stderr/exit/duration and
// records digests only — never raw output — so provider transcripts cannot leak
// secrets or be promoted into gate evidence.

/** Real bounded providers. `fake` is handled deterministically and never reaches this contract. */
export type BoundedProviderName = 'codex' | 'claude' | 'gemini';

export interface ProviderExecRequest {
  /** Trusted parent quota context, separate from provider credential projection. */
  budgetRoot?: string;
  budgetEnv?: NodeJS.ProcessEnv;
  /** Full supplied prompt when argv references a prompt file. */
  budgetPrompt?: string;
  admission?: ProviderProcessAdmission;
  provider: BoundedProviderName;
  /** Bounded argv. Shell strings are rejected by the executor before this point. */
  argv: string[];
  /** Optional bounded stdin payload. Omitted means stdin is closed with an empty payload. */
  stdin?: string;
  /** Explicit working directory for the provider process. */
  cwd: string;
  /** Hard wall-clock timeout for a single attempt. */
  timeoutMs: number;
  /** Maximum attempts (transient failures only; non-zero exit is terminal). */
  maxAttempts: number;
  /** Redacted environment projection actually passed to the child process. */
  env: NodeJS.ProcessEnv;
}

export interface ProviderExecResult {
  replacementSafe?: boolean;
  provider: BoundedProviderName;
  /** Provider/model metadata when the CLI reports it. */
  model?: string;
  /** Provider-reported token-count usage object (numbers only — NEVER raw transcript). OpenAI 'usage' shape for codex, Gemini 'usageMetadata' shape for gemini. Absent when the CLI reports no usage. */
  reportedUsage?: Record<string, unknown>;
  /** Digest of the argv array (never the raw argv, which may carry context). */
  argvDigest: string;
  /** Process exit code; null when killed (timeout) or never spawned. */
  exitCode: number | null;
  /** Digest of captured stdout — raw stdout is never surfaced. */
  stdoutDigest: string;
  /** Digest of captured stderr — raw stderr is never surfaced. */
  stderrDigest: string;
  stdoutBytes: number;
  stderrBytes: number;
  durationMs: number;
  attempts: number;
  timedOut: boolean;
  /** True when the provider CLI binary could not be spawned (missing / ENOENT). */
  spawnError: boolean;
  /** Spawn error code when the process failed before producing an exit code. */
  spawnErrorCode?: string;
  /** Machine-readable spawn failure class for operator diagnostics. */
  spawnErrorKind?: 'missing_executable' | 'argv_too_large' | 'spawn_failed';
}

/**
 * Bounded provider executor seam. The default implementation spawns the real
 * provider CLI; tests inject a deterministic stub so smoke runs never spawn a
 * real Codex/Claude process.
 */
export interface BoundedProviderExecutor {
  /** Preflight availability probe for the provider CLI binary. */
  available(provider: BoundedProviderName, env: NodeJS.ProcessEnv): boolean;
  /** Run a single bounded provider request, capturing structured evidence. */
  run(request: ProviderExecRequest): ProviderExecResult;
}
