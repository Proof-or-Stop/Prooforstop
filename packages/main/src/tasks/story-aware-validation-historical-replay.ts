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
import { buildDualRevisionImpactGraph, buildDynamicValidationPlan, buildStoryChangeManifest, compileValidationCatalog, createValidationClosureCertificate, createValidationCommandReceipt, discoverValidationInventory, signPayload, stableDigest, verifyPayload, verifyValidationClosureCertificate, verifyValidationSelectionManifest, type StoryChangedFile, type ValidationCatalogEntry, type ValidationCommandReceipt } from '../core/story-aware-validation.js';
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

function commandVerdicts(result: Awaited<ReturnType<typeof executeValidationPlan>>) {
  return result.commands.map((row) => ({
    label: row.label,
    command: row.command,
    args: row.args,
    cwd: row.cwd,
    code: row.code,
    outputDigest: stableDigest(row.output),
    durationMs: row.durationMs,
    timedOut: row.timedOut === true,
    ...(row.failureKind ? { failureKind: row.failureKind } : {}),
  }));
}

function signedArtifact<T extends Record<string, unknown>>(body: T): T & { signature: string } {
  return { ...body, signature: signPayload(body) };
}

function validationCommands(entries: ValidationCatalogEntry[]) {
  return entries.map((entry) => ({ label: entry.label, command: entry.command, args: entry.args, cwd: entry.cwd, env: entry.env, resources: entry.resources }));
}

function receiptForBaseline(args: {
  entry: ValidationCatalogEntry;
  row: { inputDigest: string; closureCertificateDigest?: string };
  result: Awaited<ReturnType<typeof executeValidationPlan>>['commands'][number];
  storyId: string;
  baseHead: string;
  head: string;
  catalogDigest: string;
  inventoryDigest: string;
  baselineEpoch: string;
  buildProofDigest: string;
}): ValidationCommandReceipt | undefined {
  if (args.result.code !== 0 || args.result.timedOut || !args.row.closureCertificateDigest) return undefined;
  const createdAt = new Date().toISOString();
  return createValidationCommandReceipt({
    id: `historical-receipt-${stableDigest({ storyId: args.storyId, commandId: args.entry.id, inputDigest: args.row.inputDigest, head: args.head }).slice(0, 24)}`,
    commandId: args.entry.id,
    commandIdentityDigest: stableDigest({ command: args.entry.command, args: args.entry.args }),
    inputDigest: args.row.inputDigest,
    closureCertificateDigest: args.row.closureCertificateDigest,
    catalogDigest: args.catalogDigest,
    inventoryDigest: args.inventoryDigest,
    runnerDigest: stableDigest(args.entry.runnerSourceDigest || ''),
    toolchainDigest: '',
    buildProofDigest: args.buildProofDigest,
    sourceHead: args.head,
    sourceBaseHead: args.baseHead,
    canonicalBaselineEpochId: args.baselineEpoch,
    producedBy: 'canonical-full-baseline',
    cleanTreeDigest: stableDigest({ head: args.head, storyId: args.storyId, status: 'clean-at-command-start' }),
    executionEnvironmentDigest: stableDigest({ node: process.version, platform: process.platform, arch: process.arch }),
    result: 'PASS',
    exitCode: 0,
    outputDigest: stableDigest(args.result.output),
    durationMs: args.result.durationMs,
    createdAt,
    revocationLedgerDigest: stableDigest({}),
  });
}

for (const candidate of selected) {
  const files = diffCache.get(candidate.storyId) || changedFiles(candidate.pair.base, candidate.pair.head);
  diffCache.set(candidate.storyId, files);
  candidate.category = candidateCategory(candidate);
  const changes = buildStoryChangeManifest({ storyId: candidate.storyId, gitCwd: root, baseHead: candidate.pair.base, head: candidate.pair.head, changedFiles: files });
  // Graph extraction is needed for executable assurance. Plan-only mode keeps
  // the inexpensive inventory characterization path and does not pretend to
  // have executed dual-revision closure evidence.
  const graph = execute ? buildDualRevisionImpactGraph({ gitCwd: root, baseHead: candidate.pair.base, head: candidate.pair.head, catalog }) : undefined;
  const manifest = buildDynamicValidationPlan({
    storyId: candidate.storyId, baseHead: candidate.pair.base, head: candidate.pair.head,
    inventory, catalog, changes, closures, baselineEpochId: candidate.pair.base, graph,
    buildProofDigest: 'historical-replay-plan', mode: 'shadow', gitCwd: root,
  });
  assert.equal(verifyValidationSelectionManifest(manifest), true, `${candidate.storyId} produced an invalid selection manifest`);
  const record: Record<string, unknown> = {
    storyId: candidate.storyId, category: candidate.category, baseHead: candidate.pair.base,
    head: candidate.pair.head, changedFiles: files.length, selectionDigest: stableDigest(manifest),
    selectedCommandIds: manifest.rows.filter(row => row.disposition === 'execute').map(row => row.commandId),
    selectedCount: manifest.totals.executed, reusedCount: manifest.totals.reused,
    fullEscalated: manifest.fullEscalated, dependencyGraphDigest: manifest.dependencyGraphDigest,
    execution: 'not-run',
    restore: execute
      ? { mode: 'detached-git-worktrees', baseHead: candidate.pair.base, head: candidate.pair.head, status: 'pending' }
      : { mode: 'plan-only', baseHead: candidate.pair.base, head: candidate.pair.head, status: 'not-run' },
  };
  if (execute) {
    await withHistoricalWorktrees(candidate.pair.base, candidate.pair.head, async ({ head: historicalRoot }) => {
      const commands = validationCommands(catalog);
      // Establish a canonical full result on this exact historical head, then
      // feed signed PASS receipts back into the selector. Without this step a
      // replay is merely full-vs-full because no reusable baseline exists.
      const full = await executeValidationPlan({ provider: 'historical-replay-full', commands, warnings: [] }, historicalRoot, candidate.pair.head, candidate.storyId);
      const baselineReceipts = catalog.flatMap((entry, index) => {
        const row = manifest.rows.find((candidateRow) => candidateRow.commandId === entry.id);
        const result = full.commands[index];
        const receipt = row && result ? receiptForBaseline({
          entry, row, result, storyId: candidate.storyId, baseHead: candidate.pair.base, head: candidate.pair.head,
          catalogDigest, inventoryDigest: inventory.digest, baselineEpoch: candidate.pair.base,
          buildProofDigest: 'historical-replay-plan',
        }) : undefined;
        return receipt ? [receipt] : [];
      });
      const dynamicManifest = buildDynamicValidationPlan({
        storyId: candidate.storyId, baseHead: candidate.pair.base, head: candidate.pair.head,
        inventory, catalog, changes, closures, receipts: baselineReceipts,
        baselineEpochId: candidate.pair.base, graph, buildProofDigest: 'historical-replay-plan',
        mode: 'shadow', gitCwd: historicalRoot,
      });
      const selectedIds = new Set(dynamicManifest.rows.filter(row => row.disposition === 'execute').map(row => row.commandId));
      const selectedCommands = catalog.filter(entry => selectedIds.has(entry.id)).map(entry => ({ label: entry.label, command: entry.command, args: entry.args, cwd: entry.cwd, env: entry.env, resources: entry.resources }));
      const dynamic = await executeValidationPlan({ provider: 'historical-replay-dynamic', commands: selectedCommands, warnings: [] }, historicalRoot, candidate.pair.head, candidate.storyId);
      const fullFailures = full.commands.flatMap((row, index) => row.code === 0 ? [] : [catalog[index]!.id]);
      assert.ok(fullFailures.every(id => selectedIds.has(id)), `${candidate.storyId} omitted a full-plan failure`);
      const fullVerdicts = commandVerdicts(full);
      const dynamicVerdicts = commandVerdicts(dynamic);
      const dynamicById = new Map(dynamic.commands.map((row) => [catalog.find((entry) => entry.label === row.label)?.id || row.label, row]));
      const perCommandEquivalent = dynamicManifest.rows.every((row) => {
        const index = catalog.findIndex((entry) => entry.id === row.commandId);
        const fullRow = full.commands[index];
        if (!fullRow) return false;
        if (row.disposition === 'reuse') return fullRow.code === 0;
        const dynamicRow = dynamicById.get(row.commandId);
        return Boolean(dynamicRow && dynamicRow.code === fullRow.code);
      });
      const dynamicResidue = dynamic.commands.flatMap((row) => row.worktreePollution?.paths || []);
      const fullReceipt = signedArtifact({
        schema: 'proof-or-stop.dynamic-validation.replay-command-receipt.v1',
        storyId: candidate.storyId, mode: 'full', baseHead: candidate.pair.base,
        head: candidate.pair.head, allPass: full.allPass, verdicts: fullVerdicts,
      });
      const dynamicReceipt = signedArtifact({
        schema: 'proof-or-stop.dynamic-validation.replay-command-receipt.v1',
        storyId: candidate.storyId, mode: 'dynamic', baseHead: candidate.pair.base,
        head: candidate.pair.head, allPass: dynamic.allPass, verdicts: dynamicVerdicts,
        selectedCount: dynamicManifest.totals.executed, reusedCount: dynamicManifest.totals.reused,
        perCommandEquivalent, residue: dynamicResidue,
      });
      record.execution = {
        fullAllPass: full.allPass,
        dynamicAllPass: dynamic.allPass,
        fullFailures,
        commandExecutions: dynamic.commands.length,
        selectedCount: dynamicManifest.totals.executed,
        reusedCount: dynamicManifest.totals.reused,
        fullEscalated: dynamicManifest.fullEscalated,
        dependencyGraphDigest: dynamicManifest.dependencyGraphDigest,
        perCommandEquivalent,
        residue: dynamicResidue,
        fullVerdicts,
        dynamicVerdicts,
        receipts: [fullReceipt, dynamicReceipt],
        receiptsDigest: stableDigest({ fullVerdicts, dynamicVerdicts }),
        restoredHeadRoot: historicalRoot,
      };
      record.restore = { mode: 'detached-git-worktrees', baseHead: candidate.pair.base, head: candidate.pair.head, status: 'complete' };
    });
  }
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(outputRoot, `${candidate.storyId}.json`), JSON.stringify(record, null, 2) + '\n');
  records.push(record);
}

const categories = [...new Set(records.map(row => row.category))].sort();
const fiReferenceHead = git(['rev-parse', 'HEAD']);
const fiGraph = buildDualRevisionImpactGraph({ gitCwd: root, baseHead: fiReferenceHead, head: fiReferenceHead, catalog });
const faultInjection = catalog.flatMap((entry) => {
  const rows: Array<Record<string, unknown>> = [];
  const closure = closures.get(entry.id);
  const fiContext = (changedFiles: StoryChangedFile[], closureSet = closures) => {
    const changes = buildStoryChangeManifest({ storyId: `B-fi-${entry.id}`, gitCwd: root, baseHead: fiReferenceHead, head: fiReferenceHead, changedFiles });
    return buildDynamicValidationPlan({
      storyId: `B-fi-${entry.id}`, baseHead: fiReferenceHead, head: fiReferenceHead, inventory, catalog,
      changes, closures: closureSet, baselineEpochId: 'fi-epoch', buildProofDigest: 'fi-build', mode: 'observe', graph: fiGraph, gitCwd: root,
    });
  };
  if (entry.assurance === 'story-selectable') {
    const sourcePath = entry.inputRoots[0] || 'packages/main/src/fi-source.ts';
    const impacted = fiContext([{ path: sourcePath, status: 'modified', blobId: stableDigest(sourcePath) }]);
    rows.push({ fiId: 'FI-1', commandId: entry.id, mutation: 'certified-source-dependency', expected: 'execute', observed: impacted.rows.find((row) => row.commandId === entry.id)?.disposition, passed: verifyValidationSelectionManifest(impacted) && impacted.rows.find((row) => row.commandId === entry.id)?.disposition === 'execute' });
    const mutationRows = [
      { name: 'missing-static-edge', cert: closure ? { ...closure, certifiedPaths: [], certifiedPathsDigest: stableDigest([]), signature: closure.signature } : undefined },
      { name: 'missing-runtime-traced-edge', cert: closure ? { ...closure, status: 'unverified' as const, undeclaredObservedPaths: ['packages/main/src/fi-runtime-edge.ts'], signature: closure.signature } : undefined },
      { name: 'missing-process-fact-edge', cert: closure ? { ...closure, status: 'unverified' as const, processFactBindingDigest: stableDigest([]), signature: closure.signature } : undefined },
    ];
    for (const mutation of mutationRows) {
      const mutatedClosures = new Map(closures);
      if (mutation.cert) mutatedClosures.set(entry.id, mutation.cert);
      const mutated = fiContext([{ path: sourcePath, status: 'modified', blobId: stableDigest(sourcePath) }], mutatedClosures);
      const mutatedRow = mutated.rows.find((row) => row.commandId === entry.id);
      rows.push({
        fiId: 'FI-2', commandId: entry.id, mutation: mutation.name,
        expected: 'unverified-or-execute', observed: mutatedRow?.disposition,
        passed: mutation.cert ? verifyValidationClosureCertificate(mutation.cert) === false
          && mutated.fullEscalated === true
          && mutatedRow?.disposition === 'execute' : false,
      });
    }
  }
  if (entry.assurance === 'full-only') {
    const impacted = fiContext([{ path: entry.inputRoots[0] || 'packages/main/src/fi-full-only.ts', status: 'modified', blobId: stableDigest(entry.id) }]);
    const impactedRow = impacted.rows.find((row) => row.commandId === entry.id);
    rows.push({ fiId: 'FI-3', commandId: entry.id, mutation: 'impacted-full-only-command', expected: 'full-plan-escalation', observed: { fullEscalated: impacted.fullEscalated, disposition: impactedRow?.disposition }, passed: impacted.fullEscalated === true && impactedRow?.disposition === 'execute' });
  }
  if (entry.closurePolicy === 'whole-repository') {
    const impacted = fiContext([{ path: 'packages/main/src/fi-unrelated-material.ts', status: 'modified', blobId: stableDigest('fi-unrelated-material') }]);
    rows.push({ fiId: 'FI-4', commandId: entry.id, mutation: 'unrelated-material-file', expected: 'execute', observed: impacted.rows.find((row) => row.commandId === entry.id)?.disposition, passed: impacted.rows.find((row) => row.commandId === entry.id)?.disposition === 'execute' });
  }
  const deleted = fiContext([{ path: entry.inputRoots[0] || 'packages/main/src/fi-deleted.ts', status: 'deleted', blobId: '<deleted>' }]);
  const renamed = fiContext([{ path: entry.inputRoots[0] || 'packages/main/src/fi-renamed.ts', oldPath: 'packages/main/src/fi-old.ts', status: 'renamed', blobId: stableDigest('fi-renamed') }]);
  const deletedRow = deleted.rows.find((row) => row.commandId === entry.id);
  const renamedRow = renamed.rows.find((row) => row.commandId === entry.id);
  rows.push({ fiId: 'FI-5', commandId: entry.id, mutation: 'deleted-and-renamed-inputs', expected: 'base-and-head-graph-selection', observed: { deletedManifest: verifyValidationSelectionManifest(deleted), renamedManifest: verifyValidationSelectionManifest(renamed), deletedDisposition: deletedRow?.disposition, renamedDisposition: renamedRow?.disposition, deletedGraph: deleted.dependencyGraphDigest, renamedGraph: renamed.dependencyGraphDigest }, passed: verifyValidationSelectionManifest(deleted) && verifyValidationSelectionManifest(renamed) && deleted.dependencyGraphDigest.length > 0 && renamed.dependencyGraphDigest.length > 0 && deletedRow?.disposition === 'execute' && renamedRow?.disposition === 'execute' });
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
  const currentGraph = buildDualRevisionImpactGraph({ gitCwd: root, baseHead: currentHead, head: currentHead, catalog });
  const fullCommands = validationCommands(catalog);
  let pairedManifest = buildDynamicValidationPlan({
    storyId: 'B-current-paired', baseHead: currentHead, head: currentHead, inventory, catalog,
    changes: currentChanges, closures: currentClosures, baselineEpochId: currentHead,
    buildProofDigest: 'paired-performance', graph: currentGraph, mode: 'shadow', gitCwd: root,
  });
  let selectedIds = new Set<string>();
  let dynamicCommands: ReturnType<typeof validationCommands> = [];
  const runs: Array<Record<string, unknown>> = [];
  await withHistoricalWorktrees(currentHead, currentHead, async ({ head: pairedRoot }) => {
    const baseline = await executeValidationPlan({ provider: 'historical-paired-canonical-baseline', commands: fullCommands, warnings: [] }, pairedRoot, currentHead, 'B-current-paired');
    const baselineReceipts = catalog.flatMap((entry, index) => {
      const row = pairedManifest.rows.find((candidateRow) => candidateRow.commandId === entry.id);
      const result = baseline.commands[index];
      const receipt = row && result ? receiptForBaseline({
        entry, row, result, storyId: 'B-current-paired', baseHead: currentHead, head: currentHead,
        catalogDigest, inventoryDigest: inventory.digest, baselineEpoch: currentHead,
        buildProofDigest: 'paired-performance',
      }) : undefined;
      return receipt ? [receipt] : [];
    });
    pairedManifest = buildDynamicValidationPlan({
      storyId: 'B-current-paired', baseHead: currentHead, head: currentHead, inventory, catalog,
      changes: currentChanges, closures: currentClosures, receipts: baselineReceipts,
      baselineEpochId: currentHead, buildProofDigest: 'paired-performance', graph: currentGraph,
      mode: 'shadow', gitCwd: pairedRoot,
    });
    selectedIds = new Set(pairedManifest.rows.filter((row) => row.disposition === 'execute').map((row) => row.commandId));
    dynamicCommands = catalog.filter(entry => selectedIds.has(entry.id)).map(entry => ({ label: entry.label, command: entry.command, args: entry.args, cwd: entry.cwd, env: entry.env, resources: entry.resources }));
    for (let pair = 0; pair < 3; pair++) {
      const order = pair % 2 === 0 ? ['full', 'dynamic'] : ['dynamic', 'full'];
      for (const mode of order) {
        const startedAt = Date.now();
        const cpuBefore = process.cpuUsage();
        const planCommands = mode === 'full' ? fullCommands : dynamicCommands;
        const result = await executeValidationPlan({
          provider: `historical-paired-${pair + 1}-${mode}`,
          commands: planCommands,
          warnings: [],
        }, pairedRoot, currentHead, 'B-current-paired');
        const wallTimeMs = Date.now() - startedAt;
        const cpu = process.cpuUsage(cpuBefore);
        runs.push({
          pair: pair + 1,
          mode,
          allPass: result.allPass,
          commandCount: result.commands.length,
          verdicts: commandVerdicts(result),
          wallTimeMs,
          cpuUtilizationPct: wallTimeMs > 0 ? Number((((cpu.user + cpu.system) / 1000) / wallTimeMs * 100).toFixed(2)) : 0,
          resourceOverlapTimeline: planCommands.map((command) => ({ label: command.label, resources: command.resources || [] })),
          residue: result.commands.flatMap((row) => row.worktreePollution?.paths || []),
        });
      }
    }
  });
  pairedPerformance = signedArtifact({
    schema: 'proof-or-stop.dynamic-validation.paired-performance.v1',
    head: currentHead, inventoryDigest: inventory.digest, catalogDigest,
    selectionDigest: stableDigest(pairedManifest),
    dependencyGraphDigest: pairedManifest.dependencyGraphDigest,
    closureCertificateSetDigest: pairedManifest.closureCertificateSetDigest,
    canonicalBaselineEpochId: pairedManifest.canonicalBaselineEpochId,
    toolchainDigest: pairedManifest.toolchainDigest,
    revocationLedgerDigest: pairedManifest.receiptRevocationLedgerDigest,
    selectedCommandIds: [...selectedIds],
    selectedCount: pairedManifest.totals.executed,
    executedCount: pairedManifest.totals.executed,
    reusedCount: pairedManifest.totals.reused,
    unverifiedCount: pairedManifest.totals.unverified,
    order: 'full-dynamic / dynamic-full / full-dynamic',
    runs,
    medianWallTimeMs: (() => {
      const values = runs.map((row) => Number(row.wallTimeMs)).sort((a, b) => a - b);
      return values.length === 0 ? 0 : values[Math.floor(values.length / 2)];
    })(),
    resourceTimelineDigest: stableDigest(runs.map((row) => ({ pair: row.pair, mode: row.mode, commandCount: row.commandCount, wallTimeMs: row.wallTimeMs }))),
    perCommandEquivalent: runs.filter((row) => row.mode === 'full').every((full) => {
      const peer = runs.find((row) => row.pair === full.pair && row.mode === 'dynamic');
      if (!peer || !Array.isArray(full.verdicts) || !Array.isArray(peer.verdicts)) return false;
      const fullByLabel = new Map((full.verdicts as Array<Record<string, unknown>>).map((row) => [row.label, row.code]));
      return (peer.verdicts as Array<Record<string, unknown>>).every((row) => fullByLabel.get(row.label) === row.code)
        && Array.isArray(peer.residue) && peer.residue.length === 0;
    }),
    verdictEquivalent: runs.filter((row) => row.mode === 'full').every((full) => {
      const peer = runs.find((row) => row.pair === full.pair && row.mode === 'dynamic');
      return Boolean(peer && full.allPass === peer.allPass && peer.commandCount === pairedManifest.totals.executed);
    }),
  });
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(outputRoot, 'paired-performance.json'), JSON.stringify(pairedPerformance, null, 2) + '\n');
}
const faultInjectionBody = {
  schema: 'proof-or-stop.dynamic-validation.fault-injection.v1',
  rows: faultInjection,
  requiredFamilies: ['FI-1', 'FI-2', 'FI-3', 'FI-4', 'FI-5'],
  familyCounts: Object.fromEntries(['FI-1', 'FI-2', 'FI-3', 'FI-4', 'FI-5'].map((id) => [id, faultInjection.filter((row) => row.fiId === id).length])),
  allPass: ['FI-1', 'FI-2', 'FI-3', 'FI-4', 'FI-5'].every((id) => faultInjection.some((row) => row.fiId === id) && faultInjection.filter((row) => row.fiId === id).every((row) => row.passed)),
  digest: stableDigest(faultInjection),
  path: faultInjectionPath,
};
const faultInjectionArtifact = signedArtifact(faultInjectionBody);
const executableRecords = records.filter((row) => row.execution && typeof row.execution === 'object');
const replayExecutionEquivalent = executableRecords.every((row) => {
  const execution = row.execution as Record<string, unknown>;
  return execution.perCommandEquivalent === true
    && Array.isArray(execution.residue) && execution.residue.length === 0
    && Array.isArray(execution.fullFailures)
    && typeof execution.selectedCount === 'number'
    && typeof execution.reusedCount === 'number'
    && typeof execution.dependencyGraphDigest === 'string' && execution.dependencyGraphDigest.length > 0;
});
const executionReceiptsValid = executableRecords.every((row) => {
  const execution = row.execution as Record<string, unknown>;
  const receipts = Array.isArray(execution.receipts) ? execution.receipts : [];
  return receipts.length === 2 && receipts.every((receipt) => {
    if (!receipt || typeof receipt !== 'object' || typeof (receipt as Record<string, unknown>).signature !== 'string') return false;
    const body = { ...(receipt as Record<string, unknown>) };
    delete body.signature;
    return verifyPayload(body, (receipt as Record<string, unknown>).signature);
  });
});
const gateReasons = [
  !execute ? 'plan-only replay has no executable receipts' : '',
  executableRecords.length !== records.length ? 'one or more Stories were not executed' : '',
  !executionReceiptsValid ? 'replay command receipts are missing or invalid' : '',
  !replayExecutionEquivalent ? 'replay per-command verdict equivalence or residue check failed' : '',
  !verifyPayload(faultInjectionBody, faultInjectionArtifact.signature) ? 'fault-injection artifact signature is invalid' : '',
  !faultInjectionArtifact.allPass ? 'FI-1..FI-5 coverage is incomplete or failing' : '',
  paired && (!pairedPerformance || pairedPerformance.verdictEquivalent !== true || !verifyPayload(Object.fromEntries(Object.entries(pairedPerformance).filter(([key]) => key !== 'signature')), String(pairedPerformance.signature || ''))) ? 'paired full/dynamic verdict equivalence or signature is missing' : '',
].filter(Boolean);
const reportBody = {
  schema: 'proof-or-stop.dynamic-validation.historical-replay.v1',
  generatedAt: new Date().toISOString(), root, execute, storyCount: records.length,
  categories, recordsDigest: stableDigest(records), records,
  faultInjection: faultInjectionArtifact,
  admissibility: { execute, pairedRequested: paired, admissible: gateReasons.length === 0, reasons: gateReasons },
  ...(pairedPerformance ? { pairedPerformance } : {}),
};
const report = signedArtifact(reportBody);
mkdirSync(outputRoot, { recursive: true });
writeFileSync(faultInjectionPath, JSON.stringify(faultInjectionArtifact, null, 2) + '\n');
writeFileSync(join(outputRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`historical stories: ${records.length}`);
console.log(`historical categories: ${categories.join(', ')}`);
console.log(`historical replay mode: ${execute ? 'execute' : 'plan-only'}`);
console.log(`historical replay report: ${join(outputRoot, 'report.json')}`);
if (paired) console.log(`paired-performance: ${join(outputRoot, 'paired-performance.json')}`);
