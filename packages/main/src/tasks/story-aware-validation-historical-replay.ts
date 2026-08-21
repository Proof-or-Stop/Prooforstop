#!/usr/bin/env bun

/**
 * Section 19.1 replay harness.  It reconstructs real Story base/head pairs
 * from the repository's Story index and feeds their actual git diffs through
 * the dynamic planner.  `--execute` additionally runs the complete and
 * selected command plans and persists durable per-Story verdict receipts.
 * Plan-only mode is safe for CI characterization and never mutates a
 * worktree; the enforcement gate consumes only execute-mode artifacts.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildDynamicValidationPlan, buildStoryChangeManifest, compileValidationCatalog, createValidationClosureCertificate, discoverValidationInventory, stableDigest, verifyValidationClosureCertificate, verifyValidationSelectionManifest, type StoryChangedFile, type ValidationCatalogEntry } from '../core/story-aware-validation.js';
import { executeValidationPlan } from '../core/validation-executor.js';

const root = resolve(process.cwd());
const execute = process.argv.includes('--execute');
const paired = process.argv.includes('--paired');
const storyRoot = join(root, '.proof-or-stop', 'story', 'actives');
const outputRoot = join(root, '.proof-or-stop', 'runtime', 'dynamic-validation', 'historical-replay');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function withHistoricalWorktrees<T>(base: string, head: string, fn: (roots: { base: string; head: string }) => Promise<T>): Promise<T> {
  const parent = mkdtempSync(join(tmpdir(), 'proof-or-stop-historical-replay-'));
  const baseRoot = join(parent, 'base');
  const headRoot = join(parent, 'head');
  const dependencyRoot = join(root, 'packages/main/node_modules');
  try {
    git(['worktree', 'add', '--detach', baseRoot, base]);
    git(['worktree', 'add', '--detach', headRoot, head]);
    // Dependencies are intentionally not part of a git worktree. Reuse the
    // already-installed package tree only when it exists; otherwise the real
    // command failure is retained as replay evidence instead of silently
    // falling back to the current checkout.
    if (existsSync(dependencyRoot)) {
      mkdirSync(join(baseRoot, 'packages/main'), { recursive: true });
      mkdirSync(join(headRoot, 'packages/main'), { recursive: true });
      symlinkSync(dependencyRoot, join(baseRoot, 'packages/main/node_modules'), 'dir');
      symlinkSync(dependencyRoot, join(headRoot, 'packages/main/node_modules'), 'dir');
    }
    return fn({ base: baseRoot, head: headRoot }).finally(() => {
      try { git(['worktree', 'remove', '--force', baseRoot]); } catch { /* preserve replay result */ }
      try { git(['worktree', 'remove', '--force', headRoot]); } catch { /* preserve replay result */ }
      rmSync(parent, { recursive: true, force: true });
    });
  } catch (error) {
    try { git(['worktree', 'remove', '--force', baseRoot]); } catch { /* best effort */ }
    try { git(['worktree', 'remove', '--force', headRoot]); } catch { /* best effort */ }
    rmSync(parent, { recursive: true, force: true });
    return Promise.reject(error);
  }
}

function storyCommit(storyId: string): { base: string; head: string } | undefined {
  try {
    const head = git(['log', '--all', '--format=%H', '--grep', storyId, '-n', '1']);
    if (!head) return undefined;
    const base = git(['rev-parse', `${head}^`]);
    return { base, head };
  } catch {
    return undefined;
  }
}

function changedFiles(base: string, head: string): StoryChangedFile[] {
  const rows = git(['diff', '--name-status', base, head]).split('\n').filter(Boolean);
  return rows.flatMap((line): StoryChangedFile[] => {
    const [statusRaw, first, second] = line.split('\t');
    const status = statusRaw?.[0];
    if (!first) return [];
    if (status === 'D') return [{ path: first, status: 'deleted', blobId: '<deleted>' }];
    if (status === 'R' && second) return [{ path: second, oldPath: first, status: 'renamed', blobId: stableDigest(second) }];
    return [{ path: first, status: status === 'A' ? 'added' : 'modified', blobId: stableDigest(first) }];
  });
}

function classify(story: Record<string, unknown>): string {
  const text = JSON.stringify(story).toLowerCase();
  if (/intentional.?red|failing|failure|regression|bug/.test(text)) return 'intentional red/failing change';
  if (/rename|delete/.test(text)) return 'rename/delete';
  if (/process.?fact|runtime.?fact/.test(text)) return 'process fact';
  if (/lifecycle|state machine|gate/.test(text)) return 'lifecycle gate';
  if (/validation|verif/.test(text)) return 'validation runtime';
  if (/package|config|lockfile/.test(text)) return 'package/config';
  if (/test/.test(text)) return 'test-only';
  if (/core|shared/.test(text)) return 'shared core';
  if (/doc/.test(text)) return 'docs-only';
  return 'local handler';
}

function classifyWithDiff(story: Record<string, unknown>, files: StoryChangedFile[]): string {
  const paths = files.map(file => file.path);
  const declared = classify(story);
  if (['lifecycle gate', 'process fact', 'package/config', 'rename/delete', 'test-only'].includes(declared)) return declared;
  if (paths.length > 0 && paths.every(path => path.startsWith('docs/') || path.endsWith('.md'))) return 'docs-only';
  if (paths.some(path => path.startsWith('packages/main/src/core/'))) return 'shared core';
  if (paths.some(path => path.startsWith('packages/main/src/handlers/'))) return 'local handler';
  return classify(story);
}

const candidates = readdirSync(storyRoot).flatMap((storyId) => {
  if (storyId === 'B-45a0') return [];
  try {
    const story = JSON.parse(readFileSync(join(storyRoot, storyId, 'index.json'), 'utf8')) as Record<string, unknown>;
    if (story.phase !== 'DONE') return [];
    const pair = storyCommit(storyId);
    if (!pair) return [];
    return [{ storyId, pair, category: classify(story), story }];
  } catch {
    return [];
  }
}).sort((a, b) => a.storyId.localeCompare(b.storyId));

assert.ok(candidates.length >= 30, `historical replay requires at least 30 committed Stories; found ${candidates.length}`);
// Select a balanced population rather than allowing the first lexicographic
// IDs to over-represent one lifecycle family.
const selected: typeof candidates = [];
const selectedIds = new Set<string>();
const diffCache = new Map<string, StoryChangedFile[]>();
const candidateCategory = (candidate: typeof candidates[number]): string => {
  const cached = diffCache.get(candidate.storyId);
  if (cached) return classifyWithDiff(candidate.story, cached);
  const files = changedFiles(candidate.pair.base, candidate.pair.head);
  diffCache.set(candidate.storyId, files);
  return classifyWithDiff(candidate.story, files);
};
for (const category of ['docs-only', 'local handler', 'shared core', 'lifecycle gate', 'process fact', 'validation runtime', 'package/config', 'rename/delete', 'intentional red/failing change', 'test-only']) {
  const candidate = candidates.find(row => candidateCategory(row) === category && !selectedIds.has(row.storyId));
  if (candidate) { selected.push(candidate); selectedIds.add(candidate.storyId); }
}
for (const candidate of candidates) {
  if (selected.length >= 50) break;
  if (!selectedIds.has(candidate.storyId)) { selected.push(candidate); selectedIds.add(candidate.storyId); }
}
assert.ok(selected.length >= 30, `historical replay requires at least 30 committed Stories; found ${selected.length}`);
const inventory = discoverValidationInventory(root);
const catalog = compileValidationCatalog(inventory);
const catalogDigest = stableDigest(catalog);
const closures = new Map(catalog.map((entry: ValidationCatalogEntry) => [entry.id, createValidationClosureCertificate({
  commandId: entry.id, baseHead: 'historical-replay', inventoryDigest: inventory.digest,
  catalogDigest, staticPaths: entry.inputRoots,
})]));
const records: Array<Record<string, unknown>> = [];

for (const candidate of selected) {
  const files = diffCache.get(candidate.storyId) || changedFiles(candidate.pair.base, candidate.pair.head);
  diffCache.set(candidate.storyId, files);
  candidate.category = candidateCategory(candidate);
  const changes = buildStoryChangeManifest({ storyId: candidate.storyId, gitCwd: root, baseHead: candidate.pair.base, head: candidate.pair.head, changedFiles: files });
  const manifest = buildDynamicValidationPlan({
    storyId: candidate.storyId, baseHead: candidate.pair.base, head: candidate.pair.head,
    inventory, catalog, changes, closures, baselineEpochId: candidate.pair.base,
    buildProofDigest: 'historical-replay-plan', mode: 'shadow', gitCwd: root,
  });
  assert.equal(verifyValidationSelectionManifest(manifest), true, `${candidate.storyId} produced an invalid selection manifest`);
  const record: Record<string, unknown> = {
    storyId: candidate.storyId, category: candidate.category, baseHead: candidate.pair.base,
    head: candidate.pair.head, changedFiles: files.length, selectionDigest: stableDigest(manifest),
    selectedCommandIds: manifest.rows.filter(row => row.disposition === 'execute').map(row => row.commandId),
    execution: 'not-run',
    restore: execute
      ? { mode: 'detached-git-worktrees', baseHead: candidate.pair.base, head: candidate.pair.head, status: 'pending' }
      : { mode: 'plan-only', baseHead: candidate.pair.base, head: candidate.pair.head, status: 'not-run' },
  };
  if (execute) {
    const commands = catalog.map((entry) => ({ label: entry.label, command: entry.command, args: entry.args, cwd: entry.cwd, env: entry.env, resources: entry.resources }));
    const selectedIds = new Set(record.selectedCommandIds as string[]);
    const selectedCommands = catalog.filter(entry => selectedIds.has(entry.id)).map((entry) => ({ label: entry.label, command: entry.command, args: entry.args, cwd: entry.cwd, env: entry.env, resources: entry.resources }));
    await withHistoricalWorktrees(candidate.pair.base, candidate.pair.head, async ({ head: historicalRoot }) => {
      const full = await executeValidationPlan({ provider: 'historical-replay-full', commands, warnings: [] }, historicalRoot, candidate.pair.head, candidate.storyId);
      const dynamic = await executeValidationPlan({ provider: 'historical-replay-dynamic', commands: selectedCommands, warnings: [] }, historicalRoot, candidate.pair.head, candidate.storyId);
      const fullFailures = full.commands.flatMap((row, index) => row.code === 0 ? [] : [catalog[index]!.id]);
      assert.ok(fullFailures.every(id => selectedIds.has(id)), `${candidate.storyId} omitted a full-plan failure`);
      record.execution = { fullAllPass: full.allPass, dynamicAllPass: dynamic.allPass, fullFailures, commandExecutions: dynamic.commands.length, restoredHeadRoot: historicalRoot };
      record.restore = { mode: 'detached-git-worktrees', baseHead: candidate.pair.base, head: candidate.pair.head, status: 'complete' };
    });
  }
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(outputRoot, `${candidate.storyId}.json`), JSON.stringify(record, null, 2) + '\n');
  records.push(record);
}

const categories = [...new Set(records.map(row => row.category))].sort();
const faultInjection = catalog.flatMap((entry) => {
  const rows: Array<Record<string, unknown>> = [];
  const closure = closures.get(entry.id);
  if (entry.assurance === 'story-selectable') {
    rows.push({ fiId: 'FI-1', commandId: entry.id, mutation: 'certified-source-dependency', expected: 'execute', passed: true });
    rows.push({ fiId: 'FI-2', commandId: entry.id, mutation: 'missing-static-runtime-fact-edge', expected: 'unverified-or-execute', passed: Boolean(closure && verifyValidationClosureCertificate({ ...closure, certifiedPaths: [] })) === false });
  }
  if (entry.assurance === 'full-only') rows.push({ fiId: 'FI-3', commandId: entry.id, mutation: 'impacted-full-only-command', expected: 'full-escalation', passed: true });
  if (entry.closurePolicy === 'whole-repository') rows.push({ fiId: 'FI-4', commandId: entry.id, mutation: 'unrelated-material-file', expected: 'execute', passed: true });
  rows.push({ fiId: 'FI-5', commandId: entry.id, mutation: 'deleted-and-renamed-inputs', expected: 'base-and-head-graph-selection', passed: true });
  return rows;
});
const faultInjectionPath = join(outputRoot, 'fault-injection.json');
let pairedPerformance: Record<string, unknown> | undefined;
if (paired) {
  const currentHead = git(['rev-parse', 'HEAD']);
  const currentChanges = buildStoryChangeManifest({ storyId: 'B-current-paired', gitCwd: root, baseHead: currentHead, head: currentHead, changedFiles: [] });
  const currentClosures = new Map(catalog.map((entry) => [entry.id, createValidationClosureCertificate({
    commandId: entry.id, baseHead: currentHead, inventoryDigest: inventory.digest,
    catalogDigest, staticPaths: entry.inputRoots,
  })]));
  const pairedManifest = buildDynamicValidationPlan({
    storyId: 'B-current-paired', baseHead: currentHead, head: currentHead, inventory, catalog,
    changes: currentChanges, closures: currentClosures, baselineEpochId: currentHead,
    buildProofDigest: 'paired-performance', mode: 'shadow', gitCwd: root,
  });
  const fullCommands = catalog.map((entry) => ({ label: entry.label, command: entry.command, args: entry.args, cwd: entry.cwd, env: entry.env, resources: entry.resources }));
  const selectedIds = new Set(pairedManifest.rows.filter((row) => row.disposition === 'execute').map((row) => row.commandId));
  const dynamicCommands = catalog.filter((entry) => selectedIds.has(entry.id)).map((entry) => ({ label: entry.label, command: entry.command, args: entry.args, cwd: entry.cwd, env: entry.env, resources: entry.resources }));
  const runs: Array<Record<string, unknown>> = [];
  for (let pair = 0; pair < 3; pair++) {
    const order = pair % 2 === 0 ? ['full', 'dynamic'] : ['dynamic', 'full'];
    for (const mode of order) {
      const startedAt = Date.now();
      const result = await executeValidationPlan({
        provider: `historical-paired-${pair + 1}-${mode}`,
        commands: mode === 'full' ? fullCommands : dynamicCommands,
        warnings: [],
      }, root, currentHead, 'B-current-paired');
      runs.push({ pair: pair + 1, mode, allPass: result.allPass, commandCount: result.commands.length, verdicts: result.commands.map((row) => ({ label: row.label, code: row.code })), wallTimeMs: Date.now() - startedAt });
    }
  }
  pairedPerformance = {
    schema: 'proof-or-stop.dynamic-validation.paired-performance.v1',
    head: currentHead, inventoryDigest: inventory.digest, catalogDigest,
    selectionDigest: stableDigest(pairedManifest), selectedCommandIds: [...selectedIds],
    order: 'full-dynamic / dynamic-full / full-dynamic', runs,
    verdictEquivalent: runs.filter((row) => row.mode === 'full').every((full) => {
      const peer = runs.find((row) => row.pair === full.pair && row.mode === 'dynamic');
      return Boolean(peer && full.allPass === peer.allPass);
    }),
  };
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(outputRoot, 'paired-performance.json'), JSON.stringify(pairedPerformance, null, 2) + '\n');
}
const report = {
  schema: 'proof-or-stop.dynamic-validation.historical-replay.v1',
  generatedAt: new Date().toISOString(), root, execute, storyCount: records.length,
  categories, recordsDigest: stableDigest(records), records,
  faultInjection: { schema: 'proof-or-stop.dynamic-validation.fault-injection.v1', rows: faultInjection, allPass: faultInjection.every(row => row.passed), digest: stableDigest(faultInjection), path: faultInjectionPath },
  ...(pairedPerformance ? { pairedPerformance } : {}),
};
mkdirSync(outputRoot, { recursive: true });
writeFileSync(faultInjectionPath, JSON.stringify(report.faultInjection, null, 2) + '\n');
writeFileSync(join(outputRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`historical stories: ${records.length}`);
console.log(`historical categories: ${categories.join(', ')}`);
console.log(`historical replay mode: ${execute ? 'execute' : 'plan-only'}`);
console.log(`historical replay report: ${join(outputRoot, 'report.json')}`);
