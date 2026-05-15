import { execSync, spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { loadConfig } from './config.js';
import {
  classifyGitStatusRows,
  dirtyWorktreeClassifierOptionsFromConfig,
  parseGitPorcelainRow,
  renderDirtyWorktreeGroups,
  summarizeDirtyWorktreeClassification,
} from './dirty-worktree.js';
import type {
  ValidationCommand,
  ValidationCommandResult,
  ValidationPlan,
  ValidationResult,
} from './validation-types.js';

const MAX_OUTPUT_CHARS = 12000;

export function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

export function formatValidationCommand(command: ValidationCommand): string {
  if (command.shell) return command.command;
  return [command.command, ...command.args].join(' ').trim();
}

function commandCwd(projectRoot: string, cwd?: string): string {
  if (!cwd) return projectRoot;
  return isAbsolute(cwd) ? cwd : resolve(projectRoot, cwd);
}

function trimOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const omitted = output.length - MAX_OUTPUT_CHARS;
  return output.slice(0, MAX_OUTPUT_CHARS) + `\n...[truncated ${omitted} chars]`;
}

function readGitStatus(projectRoot: string): string[] | null {
  try {
    const raw = execSync('git status --porcelain=v1 --untracked-files=all', {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return raw.split('\n').map(line => line.trimEnd()).filter(Boolean);
  } catch {
    // PROBE: validation side-effect guard is only available inside git worktrees.
    return null;
  }
}

function statusPath(line: string): string {
  return parseGitPorcelainRow(line)?.path ?? line.slice(3).trim();
}

function detectNewDirtyStatus(before: string[] | null, after: string[] | null): string[] {
  if (!before || !after || after.length === 0) return [];
  const beforePaths = new Set(before.map(statusPath));
  return after.filter(line => !beforePaths.has(statusPath(line)));
}

// @task B-6326: validation side-effect details share DONE gate dirty ownership vocabulary.
export function formatWorktreePollutionDetails(result: ValidationCommandResult, projectRoot?: string): string[] {
  const pollution = result.worktreePollution;
  if (!pollution || pollution.statusLines.length === 0) return [];
  const config = projectRoot ? loadConfig(projectRoot) : undefined;
  const classification = classifyGitStatusRows(
    pollution.statusLines,
    config ? dirtyWorktreeClassifierOptionsFromConfig(config) : {},
  );
  return [
    `✗ validation command dirtied worktree: ${result.label}: ${formatValidationCommand(result)}`,
    `  ${summarizeDirtyWorktreeClassification(classification)}`,
    ...renderDirtyWorktreeGroups(classification, { sampleLimit: 6, indent: '  ' }),
    '  validation commands must be side-effect-free by default; gate report generation behind an env var or configure side-effect-free validate.command(s)',
  ];
}

export function runValidationCommand(command: ValidationCommand, projectRoot: string): Promise<ValidationCommandResult> {
  const cwd = commandCwd(projectRoot, command.cwd);
  const started = Date.now();
  const statusBefore = readGitStatus(projectRoot);

  return new Promise((resolveResult) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const statusAfter = readGitStatus(projectRoot);
      const pollutionStatusLines = detectNewDirtyStatus(statusBefore, statusAfter);
      resolveResult({
        label: command.label,
        command: command.command,
        args: command.args,
        ...(command.shell ? { shell: true } : {}),
        ...(command.cwd ? { cwd } : {}),
        code,
        output: trimOutput(stripAnsi(output)),
        ...(command.optional ? { optional: true } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        durationMs: Date.now() - started,
        ...(pollutionStatusLines.length > 0
          ? {
              worktreePollution: {
                statusLines: pollutionStatusLines,
                paths: pollutionStatusLines.map(statusPath),
              },
            }
          : {}),
      });
    };

    const child = spawn(command.command, command.args, {
      cwd,
      env: command.env ? { ...process.env, ...command.env } : process.env,
      shell: command.shell || process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = command.timeoutMs && command.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
        }, command.timeoutMs)
      : undefined;

    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => finish(code ?? (timedOut ? 124 : 1)));
    child.on('error', (e) => {
      output += output ? `\n${e.message}` : e.message;
      finish(1);
    });
  });
}

export async function executeValidationPlan(
  plan: ValidationPlan,
  projectRoot: string,
  headSha?: string,
): Promise<ValidationResult> {
  const commands: ValidationCommandResult[] = [];
  const details: string[] = [];
  const warnings = [...(plan.warnings ?? [])];

  for (const command of plan.commands) {
    const result = await runValidationCommand(command, projectRoot);
    commands.push(result);

    const failed = result.code !== 0 || Boolean(result.timedOut);
    const mark = failed ? (result.optional ? '⚠' : '✗') : '✓';
    const suffix = result.timedOut ? ' (timed out)' : '';
    details.push(`${mark} ${result.label}: ${formatValidationCommand(command)}${suffix}`.trim());
    if (result.output.trim()) {
      details.push(...result.output.trim().split('\n').filter(Boolean).map((line) => `  ${line}`));
    }
    details.push(...formatWorktreePollutionDetails(result, projectRoot));
    if (failed && result.optional) {
      warnings.push(`optional validation failed: ${result.label}`);
    }
  }

  const requiredFailures = commands.filter((r) => !r.optional && (r.code !== 0 || r.timedOut));
  const optionalFailures = commands.filter((r) => r.optional && (r.code !== 0 || r.timedOut));
  const pollutionFailures = commands.filter((r) => r.worktreePollution && r.worktreePollution.statusLines.length > 0);
  const allPass = requiredFailures.length === 0 && pollutionFailures.length === 0;
  const status = allPass ? (optionalFailures.length > 0 || warnings.length > 0 ? 'warn' : 'pass') : 'fail';

  return {
    provider: plan.provider,
    status,
    allPass,
    summary: allPass
      ? optionalFailures.length > 0
        ? 'Required validation commands passed with optional failures'
        : 'Project validation commands passed'
      : pollutionFailures.length > 0 && requiredFailures.length === 0
        ? 'Project validation commands dirtied the worktree'
      : 'Project validation commands failed',
    details,
    warnings,
    timestamp: new Date().toISOString(),
    ...(headSha ? { headSha } : {}),
    commands,
  };
}
