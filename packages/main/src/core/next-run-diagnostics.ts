import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitSpawnCounters, type GitSpawnCounters } from './git-read-cache.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';

/**
 * Lab framework-perf (critical-path-59-61.md §6 note 2): the bench had no
 * per-step timer for `next --run`, so the framework's serial time could only
 * be inferred from event timestamps. Every `next --run` step and every step
 * decision now appends one row to
 *   <runtime root>/.proof-or-stop/runtime/next-run/diagnostics.jsonl
 *   - `decide`: the in-process step selection (wall ms, git child processes,
 *     git ms, git reads answered from the read cache);
 *   - `step`: the step's command as next --run saw it (wall ms incl. spawn,
 *     exit) and, per child CLI process, its node boot ms (start to CLI entry),
 *     own wall ms and the same git / other-child counters.
 * Diagnostic only: never gate evidence, never read by a gate. Bounded
 * (MAX_BYTES); writing never fails the step. The child reports through a
 * per-step directory named by PROOF_OR_STOP_NEXT_STEP_COUNTERS_DIR, which the
 * child removes from its own environment so its children do not report.
 */
export const NEXT_RUN_DIAGNOSTICS_FILE = 'diagnostics.jsonl';
export const STEP_COUNTERS_ENV = 'PROOF_OR_STOP_NEXT_STEP_COUNTERS_DIR';
const MAX_BYTES = 2 * 1024 * 1024;

export interface ChildStepCounters extends GitSpawnCounters { pid: number; command: string; bootMs: number; wallMs: number; exit: number | null }

/** Child side (CLI entry): report this process's counters at exit when next --run asked for them. */
export function reportStepCountersAtExit(entryMs: number): void {
  const dir = process.env[STEP_COUNTERS_ENV];
  if (!dir) return;
  delete process.env[STEP_COUNTERS_ENV];
  const command = process.argv[2] ?? '';
  process.once('exit', code => {
    try {
      const row: ChildStepCounters = { pid: process.pid, command, bootMs: Math.round(entryMs), wallMs: Math.round(performance.now()), exit: code ?? null, ...rounded(gitSpawnCounters()) };
      writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify(row));
    } catch { /* diagnostic only */ }
  });
}

function rounded(counters: GitSpawnCounters): GitSpawnCounters {
  return { ...counters, gitMs: Math.round(counters.gitMs), otherMs: Math.round(counters.otherMs) };
}

export interface NextRunDiagnostics {
  /** Wrap one step decision. */
  decide<T>(storyId: string, decide: () => T, reason: (value: T) => string): T;
  /** The env for a step's child processes, and the collector to call after it. */
  stepEnv(): { env: NodeJS.ProcessEnv; collect: (row: { storyId: string; reason: string; commands: string[]; exits: number[]; wallMs: number }) => void };
}

export function nextRunDiagnostics(root: string): NextRunDiagnostics {
  let file: string | null | undefined;
  const target = (): string | null => {
    if (file !== undefined) return file;
    try {
      const dir = join(resolveCanonicalRuntimeProjectRoot(root), '.proof-or-stop', 'runtime', 'next-run');
      mkdirSync(dir, { recursive: true });
      file = join(dir, NEXT_RUN_DIAGNOSTICS_FILE);
    } catch { file = null; }
    return file;
  };
  const write = (row: Record<string, unknown>) => {
    const path = target();
    if (!path) return;
    try {
      let size = 0;
      try { size = statSync(path).size; } catch { /* new file */ }
      if (size > MAX_BYTES) return;
      appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...row })}\n`);
    } catch { /* diagnostic only */ }
  };
  return {
    decide(storyId, decide, reason) {
      const before = gitSpawnCounters();
      const started = performance.now();
      const value = decide();
      const after = gitSpawnCounters();
      write({ type: 'decide', storyId, reason: reason(value), wallMs: Math.round(performance.now() - started),
        gitSpawns: after.gitSpawns - before.gitSpawns, gitMs: Math.round(after.gitMs - before.gitMs), gitCacheHits: after.gitCacheHits - before.gitCacheHits,
        otherSpawns: after.otherSpawns - before.otherSpawns });
      return value;
    },
    stepEnv() {
      let dir: string | null = null;
      try {
        const path = target();
        if (path) dir = mkdtempSync(join(path, '..', 'step-'));
      } catch { dir = null; }
      return {
        env: dir ? { ...process.env, [STEP_COUNTERS_ENV]: dir } : process.env,
        collect: row => {
          const children: ChildStepCounters[] = [];
          if (dir) {
            try {
              for (const name of readdirSync(dir)) {
                try { children.push(JSON.parse(readFileSync(join(dir, name), 'utf8')) as ChildStepCounters); } catch { /* torn */ }
              }
            } catch { /* none */ }
            try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
          }
          write({ type: 'step', ...row, wallMs: Math.round(row.wallMs), children });
        },
      };
    },
  };
}
