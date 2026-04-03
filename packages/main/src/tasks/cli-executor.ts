/**
 * cli-executor: CLI 交互式真机测试执行器
 *
 * 完整生命周期：
 * 1. spawn 目标 CLI 进程
 * 2. 按 fixture steps 顺序驱动交互（stdin write → stdout expect）
 * 3. 收集每步结果
 * 4. kill 进程，返回结果
 */

import { spawn, ChildProcess } from 'child_process';

const DEFAULT_TIMEOUT = 5000;

export interface CliStep {
  /** 发送到 stdin 的文本（自动追加 \n） */
  input?: string;
  /** 期望 stdout 中出现的文本或正则 */
  expect?: string;
  /** expect 等待超时（ms），默认 5000 */
  timeoutMs?: number;
}

export interface CliCaseResult {
  name: string;
  passed: boolean;
  steps: Array<{ input?: string; expect?: string; passed: boolean; actual?: string; error?: string }>;
  durationMs: number;
}

export interface CliTestResult {
  cases: CliCaseResult[];
}

export interface CliTestConfig {
  /** 启动命令，如 "node dist/main.js" */
  command: string;
  /** 工作目录 */
  cwd: string;
  /** 全局超时（ms） */
  timeoutMs?: number;
  /** 额外环境变量 */
  env?: Record<string, string>;
}

/** 去除 ANSI 颜色码和 emoji */
function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

class CliDriver {
  private proc: ChildProcess;
  private buffer = '';
  /** 已消费到的位置，waitFor 只在 cursor 之后的内容中匹配 */
  private cursor = 0;
  private waiters: Array<{ pattern: string; resolve: (matched: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];

  constructor(command: string, cwd: string, env?: Record<string, string>) {
    const [cmd, ...args] = command.split(' ');
    // Python 命令自动加 unbuffered 环境变量
    const isPython = cmd.includes('python');
    const pythonEnv = isPython ? { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } : {};
    this.proc = spawn(cmd, args, {
      cwd,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...pythonEnv, ...env },
    });

    const onData = (data: Buffer) => {
      this.buffer += stripAnsi(data.toString());
      this.checkWaiters();
    };

    this.proc.stdout?.on('data', onData);
    this.proc.stderr?.on('data', onData);
  }

  private tail(): string {
    return this.buffer.slice(this.cursor);
  }

  private checkWaiters(): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (this.tail().includes(w.pattern)) {
        clearTimeout(w.timer);
        const matched = this.tail();
        this.cursor = this.buffer.length;
        w.resolve(matched);
        this.waiters.splice(i, 1);
      }
    }
  }

  /** 等待 stdout 中（cursor 之后）出现匹配文本，匹配后推进 cursor */
  waitFor(pattern: string, timeoutMs = DEFAULT_TIMEOUT): Promise<string> {
    if (this.tail().includes(pattern)) {
      const matched = this.tail();
      this.cursor = this.buffer.length;
      return Promise.resolve(matched);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex(w => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for "${pattern}". Buffer: "${this.tail().slice(-200)}"`));
      }, timeoutMs);
      this.waiters.push({ pattern, resolve, reject, timer });
    });
  }

  /** 发送输入到 stdin */
  send(text: string): void {
    this.proc.stdin?.write(text + '\n');
  }

  /** 获取 cursor 之后的 buffer 内容 */
  getBuffer(): string {
    return this.tail();
  }

  /** 关闭进程 */
  kill(): void {
    this.proc.stdin?.end();
    this.proc.kill();
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function executeCliCases(
  config: CliTestConfig,
  cases: Array<{ name: string; steps: CliStep[] }>,
): Promise<CliTestResult> {
  const results: CliCaseResult[] = [];

  for (const tc of cases) {
    const start = Date.now();
    const stepResults: CliCaseResult['steps'] = [];
    const driver = new CliDriver(config.command, config.cwd, config.env);
    let casePassed = true;

    try {
      for (const step of tc.steps) {
        const timeoutMs = step.timeoutMs || config.timeoutMs || DEFAULT_TIMEOUT;

        // 如果有 expect，先等待期望输出
        if (step.expect) {
          try {
            const actual = await driver.waitFor(step.expect, timeoutMs);
            stepResults.push({ input: step.input, expect: step.expect, passed: true, actual: actual.slice(-200) });
          } catch (e: any) {
            stepResults.push({ input: step.input, expect: step.expect, passed: false, error: e.message, actual: driver.getBuffer().slice(-200) });
            casePassed = false;
            break;
          }
        }

        // 如果有 input，发送到 stdin
        if (step.input !== undefined) {
          driver.send(step.input);
        }
      }
    } catch (e: any) {
      stepResults.push({ passed: false, error: e.message });
      casePassed = false;
    } finally {
      driver.kill();
    }

    results.push({
      name: tc.name,
      passed: casePassed,
      steps: stepResults,
      durationMs: Date.now() - start,
    });
  }

  return { cases: results };
}
