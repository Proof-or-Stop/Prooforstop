
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
