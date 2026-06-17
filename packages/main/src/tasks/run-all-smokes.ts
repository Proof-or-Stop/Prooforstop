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
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--jobs') { opts.jobs = Math.max(1, parseInt(argv[++i] ?? '1', 10) || 1); }
    else if (a === '--tag') { opts.tag = argv[++i]; }
    else if (a === '--select') { opts.select = argv[++i]; }
    else if (a === '--manifest') { opts.manifestPath = argv[++i]!; }
    else if (a === '--smokes-dir') { opts.smokesDir = argv[++i]!; }
    else if (a === '--quiet') { opts.quiet = true; }
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

export async function runAllSmokes(opts: RunOptions): Promise<{ results: SmokeResult[]; passed: number; total: number; durationMs: number }> {
  const start = Date.now();
  const manifest = readManifest(opts.manifestPath);
  const discovered = discoverSmokes(opts.smokesDir);
  const selected = selectSmokes(discovered, manifest, { tag: opts.tag, select: opts.select });

  if (selected.length === 0) {
    return { results: [], passed: 0, total: 0, durationMs: 0 };
  }

  const results: SmokeResult[] = [];
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(opts.jobs, selected.length); w++) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= selected.length) return;
        const entry = selected[idx]!;
        const result = await runOneSmoke(entry, opts.smokesDir);
        results.push(result);
        if (!opts.quiet) {
          const tag = result.status === 'PASS' ? 'PASS' : result.status === 'TIMEOUT' ? 'TIMEOUT' : 'FAIL';
          const suffix = result.reason ? ` [${result.reason}]` : '';
          process.stdout.write(`${tag} ${result.name} (${formatDuration(result.durationMs)})${suffix}\n`);
        }
      }
    })());
  }
  await Promise.all(workers);
  const passed = results.filter((r) => r.status === 'PASS').length;
  return { results, passed, total: selected.length, durationMs: Date.now() - start };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  // Resolve relative paths against process.cwd() so the runner can be invoked
  // from anywhere (especially under git worktrees where the lattice CLI is).
  opts.manifestPath = resolve(opts.manifestPath);
  opts.smokesDir = resolve(opts.smokesDir);
  try {
    const summary = await runAllSmokes(opts);
    if (summary.total === 0) {
      process.stdout.write(`run-all-smokes: 0 smokes matched filters (tag=${opts.tag ?? '*'} select=${opts.select ?? '*'})\n`);
      process.exit(0);
    }
    process.stdout.write(`\n${summary.passed}/${summary.total} passed in ${formatDuration(summary.durationMs)}\n`);
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
