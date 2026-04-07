/**
 * Hook dispatcher — spawn shell commands at koala lifecycle events.
 *
 * 灵感来自 Claude Code 的 PreToolUse / PostToolUse / SessionStart / Stop hooks。
 * koala 的事件点：
 *   - preCommand     : 在每条 koala command handler 执行前
 *   - postCommand    : 每条 command 成功后
 *   - onError        : 每条 command 抛错时
 *   - onPhaseChange  : story_advance 成功后，按 "FROM->TO" 匹配
 *
 * 用户在 koala.config.json 的 hooks 字段配置：
 *   "hooks": {
 *     "preCommand": { "*": ["./scripts/notify"] , "story_advance": ["./scripts/sync"] },
 *     "onPhaseChange": { "*": ["echo $KOALA_OLD_PHASE"], "DEV->TEST_CASE": ["./scripts/freeze"] }
 *   }
 *
 * 设计原则：
 *   - 非阻塞：任何 hook 失败 / 超时都只 stderr warning + reportHealthIssue('hook:...'),
 *     不影响主命令继续
 *   - 30 秒 timeout：每条 hook 命令独立计时，超时 SIGKILL
 *   - stdout 限制：只在 stderr echo 前 200 字符，避免污染主命令的 JSON 输出
 *   - 顺序执行：精确匹配 + "*" 通配，两组都跑（不是 fallback），按数组顺序串行
 *   - env 隔离：基于 process.env 派生，每条 hook 拿到完整 KOALA_* 变量
 */

import { spawn } from 'child_process';
import { reportHealthIssue } from './health.js';
import type { KoalaConfig } from './config.js';

export type HookStage = 'preCommand' | 'postCommand' | 'onError' | 'onPhaseChange';

export const HOOK_TIMEOUT_MS = 30_000;
const STDOUT_ECHO_LIMIT = 200;
/** Per-stream cap for hook stdout/stderr collection. 16KB so multi-line greps don't truncate. */
const STREAM_BUFFER_LIMIT = 16 * 1024;

export interface HookConfig {
  preCommand?: Record<string, string[]>;
  postCommand?: Record<string, string[]>;
  onError?: Record<string, string[]>;
  onPhaseChange?: Record<string, string[]>;
}

/**
 * Truncate a string to maxBytes, appending [...truncated] if cut.
 * Used for KOALA_RESULT_JSON which can blow up env vars.
 */
export function truncateForEnv(value: string, maxBytes = 8192): string {
  if (typeof value !== 'string') return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  // naive char-based truncate; fine for ascii-heavy JSON
  return value.slice(0, maxBytes - 20) + '...[truncated]';
}

/**
 * Compose the env var bag passed to a hook command. Caller fills in stage-specific
 * extras (KOALA_RESULT_JSON / KOALA_ERROR / KOALA_OLD_PHASE / ...). Common fields
 * are populated here so every stage stays consistent — including KOALA_ARGS_JSON,
 * which used to be missing on onPhaseChange.
 */
export function buildHookEnv(opts: {
  stage: HookStage;
  command: string;
  cwd: string;
  root: string;
  argsJson?: string;
  storyId?: string | null;
  phase?: string | null;
  extra?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {
    KOALA_STAGE: opts.stage,
    KOALA_COMMAND: opts.command,
    KOALA_CWD: opts.cwd,
    KOALA_ROOT: opts.root,
  };
  if (opts.argsJson !== undefined) {
    env.KOALA_ARGS_JSON = truncateForEnv(opts.argsJson);
  }
  if (opts.storyId) env.KOALA_STORY_ID = opts.storyId;
  if (opts.phase) env.KOALA_PHASE = opts.phase;
  if (opts.extra) {
    for (const [k, v] of Object.entries(opts.extra)) {
      if (typeof v === 'string') env[k] = v;
    }
  }
  return env;
}

interface ResolvedHookCmd {
  /** "exact" 或 "*" 来源，仅用于 health 上下文 */
  source: 'exact' | 'wildcard';
  cmd: string;
}

function resolveHookCommands(stage: HookStage, key: string, cfg: KoalaConfig): ResolvedHookCmd[] {
  const hooks = (cfg as any)?.hooks as HookConfig | undefined;
  if (!hooks) return [];
  const stageMap = hooks[stage];
  if (!stageMap || typeof stageMap !== 'object') return [];

  const out: ResolvedHookCmd[] = [];
  const exact = stageMap[key];
  if (Array.isArray(exact)) {
    for (const c of exact) {
      if (typeof c === 'string' && c.length > 0) out.push({ source: 'exact', cmd: c });
    }
  }
  const wild = stageMap['*'];
  if (Array.isArray(wild) && key !== '*') {
    for (const c of wild) {
      if (typeof c === 'string' && c.length > 0) out.push({ source: 'wildcard', cmd: c });
    }
  }
  return out;
}

interface SpawnResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: Error;
}

function isWindows(): boolean {
  return process.platform === 'win32';
}

function spawnHook(cmd: string, env: Record<string, string>, cwd: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    let proc;
    try {
      const shell = isWindows() ? 'cmd.exe' : '/bin/sh';
      const args = isWindows() ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
      proc = spawn(shell, args, {
        env: { ...process.env, ...env },
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      resolve({ ok: false, exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, error: e });
      return;
    }

    const killTimer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, HOOK_TIMEOUT_MS);
    killTimer.unref?.();

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < STREAM_BUFFER_LIMIT) stdout += chunk.toString('utf-8');
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STREAM_BUFFER_LIMIT) stderr += chunk.toString('utf-8');
    });
    proc.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ ok: false, exitCode: null, signal: null, stdout, stderr, timedOut, error: err });
    });
    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const ok = !timedOut && code === 0;
      resolve({ ok, exitCode: code, signal, stdout, stderr, timedOut });
    });
  });
}

/**
 * Public entry. Run all hooks matching `stage`+`key`. Always resolves; never throws.
 */
export async function runHooks(
  stage: HookStage,
  key: string,
  env: Record<string, string>,
  cfg: KoalaConfig | null | undefined,
  cwd: string,
): Promise<void> {
  if (!cfg) return;
  const validStages: HookStage[] = ['preCommand', 'postCommand', 'onError', 'onPhaseChange'];
  if (!validStages.includes(stage)) return;

  let cmds: ResolvedHookCmd[];
  try {
    cmds = resolveHookCommands(stage, key, cfg);
  } catch (e: any) {
    reportHealthIssue('hook:resolve', e, { stage, key });
    return;
  }
  if (cmds.length === 0) return;

  for (const { source, cmd } of cmds) {
    let result: SpawnResult;
    try {
      result = await spawnHook(cmd, env, cwd);
    } catch (e: any) {
      // safety net — spawnHook itself never rejects, but defensive
      reportHealthIssue('hook:exec', e, { stage, key, cmd, source });
      try { process.stderr.write(`[koala-hook] internal error (${stage} ${cmd}): ${e?.message || e}\n`); } catch { /* debug */ }
      continue;
    }

    if (result.timedOut) {
      reportHealthIssue('hook:timeout', new Error(`hook timed out after ${HOOK_TIMEOUT_MS}ms`), {
        stage, key, cmd, source,
      });
      try { process.stderr.write(`[koala-hook] timeout (${HOOK_TIMEOUT_MS / 1000}s): ${stage} ${cmd}\n`); } catch { /* debug */ }
      continue;
    }

    if (!result.ok) {
      reportHealthIssue('hook:exec', new Error(`hook exit ${result.exitCode}: ${(result.stderr || '').slice(0, 200)}`), {
        stage, key, cmd, source, exitCode: result.exitCode,
      });
      try {
        process.stderr.write(`[koala-hook] failed (exit ${result.exitCode}): ${stage} ${cmd}\n`);
        if (result.stderr) {
          process.stderr.write(`[koala-hook]   stderr: ${result.stderr.slice(0, STDOUT_ECHO_LIMIT)}\n`);
        }
      } catch { /* debug */ }
      continue;
    }

    // success — only echo stdout if non-empty (small head)
    if (result.stdout && result.stdout.trim().length > 0) {
      try {
        const head = result.stdout.slice(0, STDOUT_ECHO_LIMIT);
        process.stderr.write(`[koala-hook] ok: ${stage} ${cmd}\n`);
        process.stderr.write(`[koala-hook]   stdout: ${head}${result.stdout.length > STDOUT_ECHO_LIMIT ? '...' : ''}\n`);
      } catch { /* debug */ }
    }
  }
}
