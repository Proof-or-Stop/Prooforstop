/**
 * Lab initplan (bench-staging/oldpos/initplan-breakdown.md §5 rank 5): in runs 72 / 77 / 80 the owner ran the
 * project's validation (`go test ...`) on the untouched base at the start of INIT and waited 55-58 s for it
 * (a 30 s yield plus a poll); no framework step waits on it, and the bench guidance asks for that baseline.
 *
 * The framework now starts the project's configured validate commands (`validate.commands`, with
 * `validate.env`) ONCE on the base in a detached background process, from the first owner-facing command of
 * an empty project (`next` with no Story, `session_brief`) or at the latest from `story_create`, and hands
 * the cached result to the owner (the story_create template, story_create's output). Nothing waits on it
 * and no gate reads it: it only replaces the owner's own baseline run. The record is keyed by the base
 * commit and the command set; a Story metadata commit on top of that base (story_create's safe-init commit)
 * still reads the same record. `PROOF_OR_STOP_BASE_VALIDATION=0` turns it off.
 *
 * Record: `.proof-or-stop/runtime/base-validation/<head12>-<digest8>.json` (`proof-or-stop.base-validation.v1`):
 * state running|done, head, commands, startedAt, finishedAt, status pass|fail, results[{command, exit,
 * durationMs, tail}], dirtyAfter (tracked files the run changed, if any).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { loadConfig } from './config.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { ensureRuntimeInfoExclude } from './runtime-info-exclude.js';

export const BASE_VALIDATION_SCHEMA = 'proof-or-stop.base-validation.v1' as const;
const MAX_COMMANDS = 3;
const DEFAULT_TIMEOUT_MS = 270_000;
const MAX_TIMEOUT_MS = 900_000;

export interface BaseValidationCommand { label: string; command: string; args: string[]; env: Record<string, string>; timeoutMs: number }
export interface BaseValidationResult { command: string; exit: number; durationMs: number; tail: string }
export interface BaseValidationState {
  schema: typeof BASE_VALIDATION_SCHEMA;
  state: 'running' | 'done';
  path: string;
  head: string;
  commands: string[];
  startedAt: string;
  pid?: number;
  finishedAt?: string;
  status?: 'pass' | 'fail';
  results?: BaseValidationResult[];
  dirtyAfter?: string[];
}

const git = (cwd: string, args: string[]): string | null => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return run.status === 0 ? (run.stdout ?? '').trim() : null;
};

/** The project's validate commands as the background run executes them (the first MAX_COMMANDS). */
export function baseValidationCommands(root: string): BaseValidationCommand[] {
  let config: { validate?: { commands?: unknown; env?: unknown } };
  try { config = loadConfig(root) as typeof config; } catch { return []; }
  const shared = config.validate?.env && typeof config.validate.env === 'object' ? config.validate.env as Record<string, unknown> : {};
  const strings = (value: Record<string, unknown>): Record<string, string> => Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === 'string')) as Record<string, string>;
  const rows = Array.isArray(config.validate?.commands) ? config.validate!.commands as Array<Record<string, unknown>> : [];
  return rows.flatMap(row => {
    if (!row || typeof row.command !== 'string' || !row.command.trim()) return [];
    const args = Array.isArray(row.args) ? row.args.filter((arg): arg is string => typeof arg === 'string') : [];
    const env = { ...strings(shared), ...(row.env && typeof row.env === 'object' ? strings(row.env as Record<string, unknown>) : {}) };
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, typeof row.timeoutMs === 'number' && row.timeoutMs > 0 ? row.timeoutMs : DEFAULT_TIMEOUT_MS);
    return [{ label: [row.command, ...args].join(' '), command: row.command, args, env, timeoutMs }];
  }).slice(0, MAX_COMMANDS);
}

function recordDir(root: string): string {
  return join(root, PROOF_OR_STOP_DIR, 'runtime', 'base-validation');
}

function commandsDigest(commands: readonly BaseValidationCommand[]): string {
  return createHash('sha256').update(JSON.stringify(commands.map(row => [row.command, row.args, row.env, row.timeoutMs]))).digest('hex').slice(0, 8);
}

function readRecord(path: string): BaseValidationState | null {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as BaseValidationState;
    return data.schema === BASE_VALIDATION_SCHEMA ? { ...data, path } : null;
  } catch { return null; }
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** A running record whose worker is gone (crashed, killed) counts as absent. */
function live(record: BaseValidationState | null): BaseValidationState | null {
  if (!record) return null;
  if (record.state === 'done') return record;
  if (record.pid === undefined) return Date.now() - Date.parse(record.startedAt) < 30_000 ? record : null;
  return pidAlive(record.pid) ? record : null;
}

/**
 * The base-validation record for the current base: the record of HEAD, else the newest record of an
 * earlier commit whose diff to HEAD touches only Proof-or-Stop metadata (`.proof-or-stop/`). Null when none.
 */
export function readBaseValidation(root: string): BaseValidationState | null {
  const commands = baseValidationCommands(root);
  if (!commands.length) return null;
  const head = git(root, ['rev-parse', 'HEAD']);
  if (!head) return null;
  const digest = commandsDigest(commands);
  const exact = live(readRecord(join(recordDir(root), `${head.slice(0, 12)}-${digest}.json`)));
  if (exact) return exact;
  let names: string[] = [];
  try { names = readdirSync(recordDir(root)).filter(name => name.endsWith(`-${digest}.json`)); } catch { return null; }
  const candidates = names.map(name => live(readRecord(join(recordDir(root), name)))).filter((row): row is BaseValidationState => Boolean(row))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const record of candidates) {
    if (git(root, ['merge-base', '--is-ancestor', record.head, head]) === null) continue;
    const changed = git(root, ['diff', '--name-only', record.head, head]);
    if (changed !== null && changed.split('\n').filter(Boolean).every(path => path.startsWith(`${PROOF_OR_STOP_DIR}/`))) return record;
  }
  return null;
}

/** The detached worker: runs each command in the project root, then writes the done record (atomically). */
const WORKER = [
  "const { spawnSync } = require('node:child_process');",
  "const fs = require('node:fs');",
  'const input = JSON.parse(process.argv[1]);',
  'const results = [];',
  'for (const row of input.commands) {',
  '  const started = Date.now();',
  "  const run = spawnSync(row.command, row.args, { cwd: input.root, env: { ...process.env, ...row.env }, encoding: 'utf8', timeout: row.timeoutMs, maxBuffer: 64 * 1024 * 1024 });",
  "  const out = String(run.stdout || '') + String(run.stderr || '') + (run.error ? String(run.error) : '');",
  "  const tail = out.trim().split('\\n').slice(-40).join('\\n').slice(-4000);",
  '  results.push({ command: row.label, exit: run.status === null ? -1 : run.status, durationMs: Date.now() - started, tail });',
  '}',
  "const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: input.root, encoding: 'utf8' });",
  "const dirtyAfter = String(status.stdout || '').split('\\n').map(line => line.slice(3)).filter(Boolean).filter(path => !input.dirtyBefore.includes(path));",
  "const record = { ...input.record, state: 'done', finishedAt: new Date().toISOString(), status: results.every(row => row.exit === 0) ? 'pass' : 'fail', results, ...(dirtyAfter.length ? { dirtyAfter } : {}) };",
  "fs.writeFileSync(input.path + '.tmp', JSON.stringify(record, null, 2));",
  "fs.renameSync(input.path + '.tmp', input.path);",
].join('\n');

/**
 * Start the background base validation unless a record for this base exists (running or done); returns the
 * record, or null when there is nothing to run (no validate command, not a git checkout, switched off).
 */
export function startBaseValidation(root: string): BaseValidationState | null {
  if (process.env.PROOF_OR_STOP_BASE_VALIDATION === '0') return null;
  const existing = readBaseValidation(root);
  if (existing) return existing;
  const commands = baseValidationCommands(root);
  const head = commands.length ? git(root, ['rev-parse', 'HEAD']) : null;
  if (!head) return null;
  const path = join(recordDir(root), `${head.slice(0, 12)}-${commandsDigest(commands)}.json`);
  try {
    ensureRuntimeInfoExclude(root);
    mkdirSync(dirname(path), { recursive: true });
    const dirtyBefore = (git(root, ['status', '--porcelain', '--untracked-files=no']) ?? '').split('\n').map(line => line.slice(3)).filter(Boolean);
    const record: BaseValidationState = { schema: BASE_VALIDATION_SCHEMA, state: 'running', path, head, commands: commands.map(row => row.label), startedAt: new Date().toISOString() };
    const { path: _path, ...stored } = record;
    // The running record first (no pid yet: counted live for 30 s), then the worker, then its pid if it is still running.
    writeFileSync(`${path}.start`, JSON.stringify(stored, null, 2));
    renameSync(`${path}.start`, path);
    const child = spawn(process.execPath, ['-e', WORKER, JSON.stringify({ root, path, commands, dirtyBefore, record: stored })],
      { cwd: root, detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    const now = readRecord(path);
    if (now?.state === 'running' && child.pid) {
      writeFileSync(`${path}.start`, JSON.stringify({ ...stored, pid: child.pid }, null, 2));
      if (readRecord(path)?.state === 'running') renameSync(`${path}.start`, path);
    }
    return readRecord(path) ?? record;
  } catch { return null; }
}

/** The owner-facing line for a base-validation record (null when there is none). */
export function renderBaseValidationLine(state: BaseValidationState | null): string | null {
  if (!state) return null;
  const commands = state.commands.map(command => `\`${command}\``).join(', ');
  const base = state.head.slice(0, 10);
  if (state.state === 'running') {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(state.startedAt)) / 1000));
    return `Base validation (framework, background): ${commands} on base ${base} is running (started ${seconds} s ago); its record is ${state.path}. `
      + 'This is the untouched-baseline run: do not run it yourself; story_create and `next` print its result.';
  }
  const results = state.results ?? [];
  const summary = results.map(row => `\`${row.command}\` exit ${row.exit} in ${(row.durationMs / 1000).toFixed(1)} s`).join('; ');
  const failing = results.filter(row => row.exit !== 0);
  const tail = (failing[0] ?? results[0])?.tail.split('\n').slice(-6).join(' | ') ?? '';
  return `Base validation (framework, background) on base ${base}: ${state.status === 'pass' ? 'PASS' : 'FAIL'} (${summary}). `
    + 'This is the untouched-baseline result of the project validate commands: do not rerun them yourself to get it. '
    + `${failing.length ? 'Failing on the base already (record it as the baseline failure set): ' : 'Last lines: '}${tail.slice(0, 600)}`
    + `${state.dirtyAfter?.length ? ` The run changed tracked files: ${state.dirtyAfter.slice(0, 5).join(', ')}.` : ''} Record: ${state.path}.`;
}
