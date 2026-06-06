/**
 * cli-executor: CLI interactive real-machine test executor
 *
 * Complete lifecycle:
 * 1. spawn the target CLI process
 * 2. Drive interactions in fixture steps order (stdin write → stdout expect)
 * 3. Collect results for each step
 * 4. kill the process and return the results
 */

import { spawn, ChildProcess } from 'child_process';

const DEFAULT_TIMEOUT = 5000;

export interface CliStep {
  /** Text sent to stdin (\n is auto-appended) */
  input?: string;
  /** Text or regex expected to appear in stdout */
  expect?: string;
  /** expect wait timeout (ms), default 5000 */
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
  /** Startup command, e.g. "node dist/main.js" */
  command: string;
  /** Working directory */
  cwd: string;
  /** Global timeout (ms) */
  timeoutMs?: number;
  /** Extra environment variables */
  env?: Record<string, string>;
}

/** Strip ANSI color codes and emoji */
function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

class CliDriver {
  private proc: ChildProcess;
  private buffer = '';
  /** Position already consumed; waitFor only matches content after the cursor */
  private cursor = 0;
  private waiters: Array<{ pattern: string; resolve: (matched: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];

  constructor(command: string, cwd: string, env?: Record<string, string>) {
    const [cmd, ...args] = command.split(' ');
    // Python commands automatically get the unbuffered environment variable
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

  /** Wait for matching text to appear in stdout (after the cursor); advance the cursor after a match */
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

  /** Send input to stdin */
  send(text: string): void {
    this.proc.stdin?.write(text + '\n');
  }

  /** Get the buffer content after the cursor */
  getBuffer(): string {
    return this.tail();
  }

  /** Close the process */
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

        // If expect is provided, wait for the expected output first
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

        // If input is provided, send it to stdin
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
