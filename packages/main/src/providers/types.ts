
export interface LLMCallOptions {
  /** 调用标签（用于日志） */
  label?: string;
  /** 超时时间（ms） */
  timeout?: number;
  /** 重试次数 */
  retries?: number;
  /** 流式回调 */
  onStream?: (type: string, data: unknown) => void;
  /** 心跳回调 */
  onHeartbeat?: (elapsedSec: number, stdoutBytes: number, stderrBytes: number) => void;
  /** 调试回调 */
  onDebug?: (msg: string) => void;
}

export interface LLMResponse {
  /** 模型输出文本 */
  text: string;
  /** 耗时（ms） */
  elapsed: number;
}

export interface ILLMProvider {
  /** Provider 名称 */
  readonly name: string;

  /** 单次调用 */
  call(prompt: string, options?: LLMCallOptions): Promise<LLMResponse>;

  /** 带重试的调用 */
  callWithRetry(prompt: string, options?: LLMCallOptions): Promise<LLMResponse>;
}
