#!/usr/bin/env node

/**
 * B-6efb (B1 of the test-runner consolidation): in-house parallel smoke runner.
 *
 * Per the A0 decision doc (B-35aa, docs/requirements/decisions/test-runner-consolidation-plan.md):
 *
 *   "Build a small TypeScript runner that scans packages/main/src/tasks/*-smoke.ts,
 *    spawns smokes in parallel (default = os.cpus().length workers), reads a manifest
 *    (packages/main/smoke-manifest.json) controlling per-smoke timeout and optional tags,
 *    and supports --tag <tag> + --select <pattern> filters."
 *
 * Each existing smoke is a standalone executable invoked as
 *   node packages/main/dist/tasks/<name>-smoke.js
 * preserving the dist-standalone-executable pattern that aligns with testing-infra.md's
 * general-black-box-command policy.
 *
 * Usage:
 *   node packages/main/dist/tasks/run-all-smokes.js [options]
 *   npm run test:all -- [options]
 *
 * Options:
 *   --jobs N            override worker pool size (default os.cpus().length)
 *   --tag <tag>         run only smokes whose manifest tags include <tag>
 *   --select <pattern>  run only smokes whose name contains <pattern> (substring match)
 *   --manifest <path>   override manifest path (default packages/main/smoke-manifest.json)
 *   --smokes-dir <dir>  override smoke discovery dir (default packages/main/dist/tasks)
 *   --quiet             suppress per-smoke output, print only the aggregate summary
 *
 * Exit code: 0 on all-pass, 1 on any failure / timeout / runner error.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';

interface ManifestEntry {
  name: string;
  tags?: string[];
  timeoutMs?: number;
  skip?: boolean;
  /**
   * B-2941: if true, this smoke is NOT retried in pass 2 even if it times out
   * in pass 1. Reserved escape hatch for smokes where retry would mask a real
   * regression. Default false (i.e. all smokes participate in retry).
   */
  noRetry?: boolean;
  /**
   * B-348d: if true, this smoke is ALSO retried in pass 2 on a FAIL (exit 1),
   * not only on TIMEOUT. OPT-IN allowlist for a small, documented set of
   * smokes that pass standalone serial but intermittently FAIL under heavy
   * parallel worker-pool load (shared /tmp / git index / port contention).
   * Default false: a FAIL stays terminal for every other smoke, so a genuine
   * regression is never silently retried to green. This is a stopgap; the
   * shared-state root cause is a deferred follow-up. A flagged smoke that FAILs
   * BOTH passes still counts as a final FAIL.
   */
  retryOnAnyFailure?: boolean;
}

interface Manifest {
  smokes?: ManifestEntry[];
}

interface RunOptions {
  jobs: number;
  tag?: string;
  select?: string;
  manifestPath: string;
  smokesDir: string;
  quiet: boolean;
  /**
   * B-2941: --no-retry CLI flag (CI strict mode). When true, pass 2 retry is
   * skipped — pass 1 result is the final result. Default false (two-pass).
   */
  noRetry: boolean;
}

interface SmokeResult {
  // B-6efb F-009: 'SKIP' removed — filter happens in selectSmokes before runOneSmoke,
  // so no SmokeResult ever carries SKIP. Dropping the dead union member.
  name: string;
  status: 'PASS' | 'FAIL' | 'TIMEOUT';
  durationMs: number;
  reason?: string;
  stdout?: string;
  stderr?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {
    jobs: cpus().length,
    manifestPath: 'packages/main/smoke-manifest.json',
    smokesDir: 'packages/main/dist/tasks',
    quiet: false,
    noRetry: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--jobs') { opts.jobs = Math.max(1, parseInt(argv[++i] ?? '1', 10) || 1); }
    else if (a === '--tag') { opts.tag = argv[++i]; }
    else if (a === '--select') { opts.select = argv[++i]; }
    else if (a === '--manifest') { opts.manifestPath = argv[++i]!; }
    else if (a === '--smokes-dir') { opts.smokesDir = argv[++i]!; }
    else if (a === '--quiet') { opts.quiet = true; }
    else if (a === '--no-retry') { opts.noRetry = true; }
  }
  return opts;
}

function readManifest(manifestPath: string): Manifest {
  if (!existsSync(manifestPath)) return {};
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest;
  } catch (e) {
    throw new Error(`run-all-smokes: failed to parse manifest at ${manifestPath}: ${(e as Error).message}`);
  }
}

export function discoverSmokes(smokesDir: string): string[] {
  if (!existsSync(smokesDir)) return [];
  return readdirSync(smokesDir)
    .filter((f) => f.endsWith('-smoke.js'))
    .map((f) => f.replace(/-smoke\.js$/, ''))
    .sort();
}

export function selectSmokes(
  discovered: string[],
  manifest: Manifest,
  opts: { tag?: string; select?: string },
): ManifestEntry[] {
  const byName = new Map<string, ManifestEntry>();
  for (const m of manifest.smokes ?? []) byName.set(m.name, m);
  const all: ManifestEntry[] = discovered.map((name) => byName.get(name) ?? { name });
  // Include manifest-only entries (e.g. fixture smokes referenced explicitly) that
  // are not in the discovery dir but are listed in the manifest, so tag filtering
  // can target them. The runner will report them as MISSING if absent on disk.
  // B-6efb F-008: dedupe via byName (manifest may list the same name twice; the
  // map keeps the last config, and we push that single entry).
  const discoveredSet = new Set(discovered);
  for (const m of byName.values()) {
    if (!discoveredSet.has(m.name)) all.push(m);
  }
  return all.filter((e) => {
    if (e.skip) return false;
    if (opts.tag && !(e.tags ?? []).includes(opts.tag)) return false;
    if (opts.select && !e.name.includes(opts.select)) return false;
    return true;
  });
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

async function runOneSmoke(entry: ManifestEntry, smokesDir: string): Promise<SmokeResult> {
  const smokePath = join(smokesDir, `${entry.name}-smoke.js`);
  if (!existsSync(smokePath)) {
    return { name: entry.name, status: 'FAIL', durationMs: 0, reason: `smoke file missing at ${smokePath}` };
  }
  const timeoutMs = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  return await new Promise<SmokeResult>((resolveResult) => {
    const child = spawn(process.execPath, [smokePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolveResult({
        name: entry.name,
        status: 'TIMEOUT',
        durationMs: Date.now() - start,
        reason: `exceeded ${timeoutMs} ms`,
        stdout, stderr,
      });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        name: entry.name, status: 'FAIL', durationMs: Date.now() - start,
        reason: `spawn error: ${err.message}`, stdout, stderr,
      });
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      if (code === 0) resolveResult({ name: entry.name, status: 'PASS', durationMs, stdout, stderr });
      else resolveResult({
        name: entry.name, status: 'FAIL', durationMs,
        reason: signal ? `signal ${signal}` : `exit code ${code}`,
        stdout, stderr,
      });
    });
  });
}

/**
 * B-2941: shared worker-pool driver used by both pass 1 (jobs from opts) and
 * pass 2 (jobs forced to 1). Selecting a specific entry subset overrides the
 * tag/select filters — pass 2 retries the literal timeout-name set computed
 * from pass 1 (excluding any manifest entry with noRetry=true).
 */
async function runEntrySet(
  entries: ManifestEntry[],
  smokesDir: string,
  jobs: number,
  quiet: boolean,
  passLabel?: string,
): Promise<SmokeResult[]> {
  const results: SmokeResult[] = [];
  if (entries.length === 0) return results;
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(jobs, entries.length); w++) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= entries.length) return;
        const entry = entries[idx]!;
        const result = await runOneSmoke(entry, smokesDir);
        results.push(result);
        if (!quiet) {
          const tag = result.status === 'PASS' ? 'PASS' : result.status === 'TIMEOUT' ? 'TIMEOUT' : 'FAIL';
          const suffix = result.reason ? ` [${result.reason}]` : '';
          const prefix = passLabel ? `${passLabel} ` : '';
          process.stdout.write(`${prefix}${tag} ${result.name} (${formatDuration(result.durationMs)})${suffix}\n`);
        }
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

export async function runAllSmokes(opts: RunOptions): Promise<{ results: SmokeResult[]; passed: number; total: number; durationMs: number; retried: boolean }> {
  const start = Date.now();
  const manifest = readManifest(opts.manifestPath);
  const discovered = discoverSmokes(opts.smokesDir);
  const selected = selectSmokes(discovered, manifest, { tag: opts.tag, select: opts.select });

  if (selected.length === 0) {
    return { results: [], passed: 0, total: 0, durationMs: 0, retried: false };
  }

  // Pass 1: high-concurrency worker pool per opts.jobs.
  const pass1 = await runEntrySet(selected, opts.smokesDir, opts.jobs, opts.quiet);

  // B-2941: identify pass-1 entries to retry serially in pass 2 (forces --jobs 1),
  // then merge results. A TIMEOUT is always retryable (single-process resolves
  // the parallel-load race). B-348d: a FAIL is retryable ONLY for smokes
  // explicitly flagged retryOnAnyFailure (a documented load-flake allowlist) —
  // every other FAIL stays terminal so a genuine regression is never masked.
  const byName = new Map(selected.map((e) => [e.name, e] as const));
  const retryEntries: ManifestEntry[] = opts.noRetry
    ? []
    : pass1
        .filter((r) => {
          const entry = byName.get(r.name);
          if (!entry || entry.noRetry === true) return false;
          if (r.status === 'TIMEOUT') return true;
          if (r.status === 'FAIL' && entry.retryOnAnyFailure === true) return true;
          return false;
        })
        .map((r) => byName.get(r.name))
        .filter((e): e is ManifestEntry => !!e);

  if (retryEntries.length === 0) {
    const passed = pass1.filter((r) => r.status === 'PASS').length;
    return { results: pass1, passed, total: selected.length, durationMs: Date.now() - start, retried: false };
  }

  if (!opts.quiet) {
    process.stdout.write(
      `\nPass 1: ${pass1.filter((r) => r.status === 'PASS').length}/${selected.length} passed; ${retryEntries.length} retryable failure(s) → retrying serially...\n`,
    );
  }
  const pass2 = await runEntrySet(retryEntries, opts.smokesDir, 1, opts.quiet, 'Pass 2:');

  // Merge: pass 2 result REPLACES pass 1 result for the same name.
  const pass2ByName = new Map(pass2.map((r) => [r.name, r] as const));
  const merged: SmokeResult[] = pass1.map((r) => pass2ByName.get(r.name) ?? r);
  const passed = merged.filter((r) => r.status === 'PASS').length;
  if (!opts.quiet) {
    const retriedPassed = pass2.filter((r) => r.status === 'PASS').length;
    process.stdout.write(`Pass 2: ${retriedPassed}/${pass2.length} passed\n`);
  }
  return { results: merged, passed, total: selected.length, durationMs: Date.now() - start, retried: true };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  // Resolve relative paths against process.cwd() so the runner can be invoked
  // from anywhere (especially under git worktrees where the proofOrStop CLI is).
  opts.manifestPath = resolve(opts.manifestPath);
  opts.smokesDir = resolve(opts.smokesDir);
  try {
    const summary = await runAllSmokes(opts);
    if (summary.total === 0) {
      process.stdout.write(`run-all-smokes: 0 smokes matched filters (tag=${opts.tag ?? '*'} select=${opts.select ?? '*'})\n`);
      process.exit(0);
    }
    // B-2941: if pass 2 actually ran, label the closing line "Final:" so
    // downstream tooling (and humans) can distinguish a two-pass result from
    // a single-pass result. Without retry, the closing line stays identical to
    // pre-B-2941 output (preMortem D3 — pass 1 format preserved).
    const closingLabel = summary.retried ? 'Final: ' : '';
    process.stdout.write(`\n${closingLabel}${summary.passed}/${summary.total} passed in ${formatDuration(summary.durationMs)}\n`);
    const anyFail = summary.results.some((r) => r.status !== 'PASS');
    process.exit(anyFail ? 1 : 0);
  } catch (e) {
    process.stderr.write(`run-all-smokes: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

// Run when invoked directly (not when imported by the self-smoke).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('run-all-smokes.js');
if (invokedDirectly) {
  void main();
}
