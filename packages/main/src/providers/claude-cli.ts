
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  writeFileSync, unlinkSync, mkdirSync,
  existsSync, rmSync,
} from 'fs';
import { spawn } from 'child_process';
import type { ILLMProvider, LLMCallOptions, LLMResponse } from './types.js';

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

const DEFAULTS: Required<ClaudeCliProviderOptions> = {
  model: 'claude-sonnet-4-20250514',
  debug: false,
  retries: 5,
  timeout: 600_000,
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
