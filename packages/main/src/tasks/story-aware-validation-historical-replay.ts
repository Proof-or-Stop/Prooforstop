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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildDynamicValidationPlan, buildStoryChangeManifest, compileValidationCatalog, createValidationClosureCertificate, discoverValidationInventory, stableDigest, verifyValidationSelectionManifest, type StoryChangedFile, type ValidationCatalogEntry } from '../core/story-aware-validation.js';
import { executeValidationPlan } from '../core/validation-executor.js';

const root = resolve(process.cwd());
const execute = process.argv.includes('--execute');
const storyRoot = join(root, '.proof-or-stop', 'story', 'actives');
const outputRoot = join(root, '.proof-or-stop', 'runtime', 'dynamic-validation', 'historical-replay');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
for (const category of ['docs-only', 'local handler', 'shared core', 'lifecycle gate', 'process fact', 'validation runtime', 'package/config', 'rename/delete', 'test-only']) {
  const candidate = candidates.find(row => row.category === category && !selectedIds.has(row.storyId));
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
  const files = changedFiles(candidate.pair.base, candidate.pair.head);
  candidate.category = classifyWithDiff(candidate.story, files);
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
  };
  if (execute) {
    const commands = catalog.map((entry) => ({ label: entry.label, command: entry.command, args: entry.args, cwd: entry.cwd, env: entry.env, resources: entry.resources }));
    const selectedIds = new Set(record.selectedCommandIds as string[]);
    const selectedCommands = catalog.filter(entry => selectedIds.has(entry.id)).map((entry) => ({ label: entry.label, command: entry.command, args: entry.args, cwd: entry.cwd, env: entry.env, resources: entry.resources }));
    const full = await executeValidationPlan({ provider: 'historical-replay-full', commands, warnings: [] }, root, candidate.pair.head, candidate.storyId);
    const dynamic = await executeValidationPlan({ provider: 'historical-replay-dynamic', commands: selectedCommands, warnings: [] }, root, candidate.pair.head, candidate.storyId);
    const fullFailures = full.commands.flatMap((row, index) => row.code === 0 ? [] : [catalog[index]!.id]);
    assert.ok(fullFailures.every(id => selectedIds.has(id)), `${candidate.storyId} omitted a full-plan failure`);
    record.execution = { fullAllPass: full.allPass, dynamicAllPass: dynamic.allPass, fullFailures, commandExecutions: dynamic.commands.length };
  }
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(outputRoot, `${candidate.storyId}.json`), JSON.stringify(record, null, 2) + '\n');
  records.push(record);
}

const categories = [...new Set(records.map(row => row.category))].sort();
const report = {
  schema: 'proof-or-stop.dynamic-validation.historical-replay.v1',
  generatedAt: new Date().toISOString(), root, execute, storyCount: records.length,
  categories, recordsDigest: stableDigest(records), records,
};
mkdirSync(outputRoot, { recursive: true });
writeFileSync(join(outputRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`historical stories: ${records.length}`);
console.log(`historical categories: ${categories.join(', ')}`);
console.log(`historical replay mode: ${execute ? 'execute' : 'plan-only'}`);
console.log(`historical replay report: ${join(outputRoot, 'report.json')}`);
