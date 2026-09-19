#!/usr/bin/env bun
import { withValidationSigningRoot } from '../core/validation-signing-context.js';

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
import { buildDualRevisionImpactGraph, buildDynamicValidationPlan, buildStoryChangeManifest, classifyFullValidationReasons, compileValidationCatalog, createValidationClosureCertificate, createValidationCommandReceipt, discoverValidationInventory, signPayload, stableDigest, verifyPayload, verifyValidationClosureCertificate, verifyValidationSelectionManifest, type StoryChangedFile, type ValidationCatalogEntry, type ValidationCommandReceipt } from '../core/story-aware-validation.js';
import { loadConfig } from '../core/config.js';
import { resolveProjectGitCwd } from '../core/story-signed-workspace-resolution.js';
import { executeValidationPlan } from '../core/validation-executor.js';
import { canonicalizeExistingPath, launchDirectoryOf } from '../core/build-artifacts-identity.js';

const root = resolve(process.cwd());
await withValidationSigningRoot(root, async () => {
// Historical replay has no live Story worktree of its own. Route every Git
// invocation through the id-independent project resolver so wrapper-root
// layouts use the configured repository even though no synthetic Story exists.
const gitCwd = resolveProjectGitCwd(root, root, loadConfig(root));
const execute = process.argv.includes('--execute');
const repairStoryId = process.argv.find((arg) => arg.startsWith('--repair-story='))?.slice('--repair-story='.length);
if (repairStoryId !== undefined) assert.match(repairStoryId, /^B-[a-z0-9]+$/i, '--repair-story must name one Story ID');
// An executable campaign is assurance evidence, not merely a cheaper replay
// mode.  It must therefore include the alternating full/dynamic pairs; a
// caller cannot accidentally produce an admissible execute-only report.
// `--repair-story` is an explicitly non-authoritative recovery tool: it
// rewrites one interrupted historical record and never emits a paired report.
const paired = !repairStoryId && (execute || process.argv.includes('--paired'));
// A paired campaign may be interrupted after every historical Story has
// already produced a durable comparison. Resume verifies those records against
// a fresh manifest and executes only missing or incompatible cases before the
// still-required current-HEAD paired campaign.
const resumeHistorical = execute && process.argv.includes('--resume');
// `--resume` alone is diagnostic and fail-closed: it stops at the first
// missing/incompatible record. A human must opt into this separate mode to
// repair only that bounded remainder, while preserving every signed record
// that already passed the reuse checks.
const repairMissingHistorical = resumeHistorical && process.argv.includes('--repair-missing');
assert.ok(!process.argv.includes('--repair-missing') || resumeHistorical, '--repair-missing requires --execute --resume');
const storyRoot = join(root, '.proof-or-stop', 'story', 'actives');
const outputRoot = join(root, '.proof-or-stop', 'runtime', 'dynamic-validation', 'historical-replay');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function withHistoricalWorktrees<T>(base: string, head: string, fn: (roots: { base: string; head: string }) => Promise<T>): Promise<T> {
  const parent = mkdtempSync(join(tmpdir(), 'proof-or-stop-historical-replay-'));
  const baseRoot = join(parent, 'base');
  const headRoot = join(parent, 'head');
  // The full plan and the selected plan run in the SAME detached head
  // checkout: a receipt binds the canonical directory its command ran in, so
  // a selection that reuses the full plan's receipts can only be planned and
  // executed where those receipts were earned. (A second, fresh checkout was
  // once used for the selected plan; it is another directory, and no receipt
  // from the head checkout is its receipt, so it could only ever replay
  // full-versus-full.)
  const dependencyRoot = join(root, 'packages/main/node_modules');
  try {
    git(['worktree', 'add', '--detach', baseRoot, base]);
    git(['worktree', 'add', '--detach', headRoot, head]);
    // Dependencies are intentionally not part of a git worktree. Reuse the
    // already-installed package tree only when it exists; otherwise the real
    // command failure is retained as replay evidence instead of silently
    // falling back to the current checkout.
    if (existsSync(dependencyRoot)) {
      for (const worktreeRoot of [baseRoot, headRoot]) {
        mkdirSync(join(worktreeRoot, 'packages/main'), { recursive: true });
        symlinkSync(dependencyRoot, join(worktreeRoot, 'packages/main/node_modules'), 'dir');
      }
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
    // A Story can be mentioned by many later release, validation, or follow-up
    // commits.  Replay the canonical implementation boundary only: the local
    // Story workflow records it as `merge: B-xxxx ...`.  Matching the subject
    // exactly by this prefix avoids treating an incidental body mention as a
    // Story head and makes the paired diff correspond to the Story change.
    // DONE Stories are integrated through the local main branch.  Other refs
    // retain abandoned/rebased Story branches and can contain duplicate merge
    // subjects, which would make the canonical boundary ambiguous.
    const escapedStoryId = storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rows = git([
      'log', 'main', '--format=%H%x00%s', '--extended-regexp',
      '--grep', `^merge: ${escapedStoryId}( |$)`,
    ]).split('\n').filter(Boolean);
    const prefix = `merge: ${storyId}`;
    const matches = rows.flatMap((row) => {
      const separator = row.indexOf('\0');
      if (separator < 0) return [];
      const head = row.slice(0, separator);
      const subject = row.slice(separator + 1);
      return subject === prefix || subject.startsWith(`${prefix} `) ? [head] : [];
    });
    if (matches.length !== 1) return undefined;
    const [head] = matches;
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
const replayStories = repairStoryId ? selected.filter((candidate) => candidate.storyId === repairStoryId) : selected;
assert.ok(replayStories.length >= (repairStoryId ? 1 : 30), repairStoryId
  ? `historical replay repair could not find ${repairStoryId}`
  : `historical replay requires at least 30 committed Stories; found ${replayStories.length}`);
const inventory = discoverValidationInventory(root);
const catalog = compileValidationCatalog(inventory);
const catalogDigest = stableDigest(catalog);
const closures = new Map(catalog.map((entry: ValidationCatalogEntry) => [entry.id, createValidationClosureCertificate({
  commandId: entry.id, baseHead: 'historical-replay', inventoryDigest: inventory.digest,
  catalogDigest, staticPaths: entry.inputRoots,
})]));
const records: Array<Record<string, unknown>> = [];
let resumedHistoricalRecords = 0;
let reexecutedHistoricalRecords = 0;
let historicalResumeFailure: string | undefined;

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

function sameStringSet(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value) => typeof value === 'string')
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

/**
 * The complete manifest digest intentionally covers the whole catalog and
 * inventory. That is the right integrity identifier for a newly emitted
 * plan, but is too broad to decide whether a historical record can be
 * resumed: an unrelated catalog member can change the raw digest without
 * changing this Story's selected execution set. Keep the resume identity
 * deliberately small and fail-closed around the decisions that historical
 * replay actually proves.
 */
function historicalSelectionSemantics(manifest: ReturnType<typeof buildDynamicValidationPlan>) {
  const fullInventorySelection = manifest.fullEscalated && manifest.totals.executed === manifest.totals.inventory;
  return {
    schema: 'proof-or-stop.dynamic-validation.historical-selection-semantics.v1',
    selectedCommandIds: manifest.rows
      .filter((row) => row.disposition === 'execute')
      .map((row) => row.commandId)
      .sort(),
    selectedCount: manifest.totals.executed,
    reusedCount: manifest.totals.reused,
    fullEscalated: manifest.fullEscalated,
    // A full escalation executes the entire inventory, so no graph edge can
    // affect the selected command set. Do not invalidate a complete legacy
    // full replay merely because it predates graph fingerprinting.
    dependencyGraphDigest: fullInventorySelection ? '' : manifest.dependencyGraphDigest,
  };
}

/**
 * Reuse only a complete, signed historical comparison whose identity still
 * matches the manifest just derived from current source. Malformed, unsigned,
 * partial, or incompatible records fall through to the normal replay path.
 */
function reusableHistoricalRecord(
  candidate: { storyId: string; pair: { base: string; head: string } },
  manifest: ReturnType<typeof buildDynamicValidationPlan>,
): Record<string, unknown> | undefined {
  if (!resumeHistorical) return undefined;
  const reject = (reason: string): undefined => {
    historicalResumeFailure ||= `${candidate.storyId}: ${reason}`;
    return undefined;
  };
  try {
    const record = JSON.parse(readFileSync(join(outputRoot, `${candidate.storyId}.json`), 'utf8')) as Record<string, unknown>;
    const execution = record.execution as Record<string, unknown> | undefined;
    const selectedCommandIds = manifest.rows.filter((row) => row.disposition === 'execute').map((row) => row.commandId);
    const selectionSemantics = historicalSelectionSemantics(manifest);
    const selectionSemanticsDigest = stableDigest(selectionSemantics);
    const fullInventorySelection = manifest.fullEscalated && manifest.totals.executed === manifest.totals.inventory;
    if (!execution) return reject('missing execution evidence');
    if (record.storyId !== candidate.storyId || record.baseHead !== candidate.pair.base || record.head !== candidate.pair.head) return reject('base/head identity mismatch');
    if (record.selectedCount !== manifest.totals.executed || record.reusedCount !== manifest.totals.reused || record.fullEscalated !== manifest.fullEscalated) return reject('record totals mismatch');
    if (!fullInventorySelection && record.dependencyGraphDigest !== manifest.dependencyGraphDigest) return reject('dependency graph digest mismatch');
    if (!sameStringSet(record.selectedCommandIds, selectedCommandIds)) return reject('selected command set mismatch');
    // Records emitted before v1 did not persist this narrow digest. Their
    // individually checked fields above are exactly the v1 payload, so they
    // remain safely resumable rather than being forced through an unrelated
    // full-population replay solely because the raw catalog digest changed.
    if (record.selectionSemanticsDigest !== undefined && !fullInventorySelection && record.selectionSemanticsDigest !== selectionSemanticsDigest) return reject('selection semantics digest mismatch');
    if (execution.selectedCount !== manifest.totals.executed || execution.reusedCount !== manifest.totals.reused || execution.fullEscalated !== manifest.fullEscalated) return reject('execution totals mismatch');
    if (!fullInventorySelection && execution.dependencyGraphDigest !== manifest.dependencyGraphDigest) return reject('execution graph digest mismatch');
    // Historical replay proves fail-closed selection: every full-plan failure
    // must be selected dynamically. Exact historical command equality is
    // recorded for diagnosis but is not an admission predicate because old
    // toolchains may add a dynamic-only environmental failure. The controlled
    // current-HEAD paired campaign below retains exact verdict equivalence.
    if (typeof execution.perCommandEquivalent !== 'boolean' || !Array.isArray(execution.residue) || execution.residue.length !== 0) return reject('execution comparison or residue invalid');
    if (!Array.isArray(execution.fullFailures) || !execution.fullFailures.every((id) => typeof id === 'string' && selectedCommandIds.includes(id))) return reject('full failure coverage invalid');

    const receipts = Array.isArray(execution.receipts) ? execution.receipts : [];
    if (receipts.length !== 2) return reject('expected two signed receipts');
    const receiptByMode = new Map<string, Record<string, unknown>>();
    for (const receipt of receipts) {
      if (!receipt || typeof receipt !== 'object') return reject('receipt shape invalid');
      const signed = receipt as Record<string, unknown>;
      const body = { ...signed };
      delete body.signature;
      if (signed.schema !== 'proof-or-stop.dynamic-validation.replay-command-receipt.v1'
        || signed.storyId !== candidate.storyId
        || signed.baseHead !== candidate.pair.base
        || signed.head !== candidate.pair.head
        || typeof signed.mode !== 'string'
        || !verifyPayload(body, signed.signature)) return reject('receipt identity or signature invalid');
      receiptByMode.set(signed.mode, signed);
    }
    const full = receiptByMode.get('full');
    const dynamic = receiptByMode.get('dynamic');
    if (!full || !dynamic
      || full.allPass !== execution.fullAllPass
      || dynamic.allPass !== execution.dynamicAllPass
      || stableDigest(full.verdicts) !== stableDigest(execution.fullVerdicts)
      || stableDigest(dynamic.verdicts) !== stableDigest(execution.dynamicVerdicts)) return reject('receipt verdict binding invalid');
    return record;
  } catch (error) {
    return reject(error instanceof Error ? `record unreadable (${error.message})` : 'record unreadable');
  }
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
    // The replayed command result carries the artifacts it executed and the
    // protection it ran under when it came through the executor; a replay that
    // lacks them produces a receipt verification refuses, which is correct.
    buildArtifactsDigest: (args.result as { buildArtifactsBefore?: string }).buildArtifactsBefore ?? '',
    buildArtifactsProtection: (args.result as { buildArtifactsProtection?: string }).buildArtifactsProtection ?? '',
    durationMs: args.result.durationMs,
    createdAt,
    revocationLedgerDigest: stableDigest({}),
  });
}

for (const candidate of replayStories) {
  const files = diffCache.get(candidate.storyId) || changedFiles(candidate.pair.base, candidate.pair.head);
  diffCache.set(candidate.storyId, files);
  candidate.category = candidateCategory(candidate);
  const changes = buildStoryChangeManifest({ storyId: candidate.storyId, gitCwd, baseHead: candidate.pair.base, head: candidate.pair.head, changedFiles: files });
  // Graph extraction is needed for executable assurance. Plan-only mode keeps
  // the inexpensive inventory characterization path and does not pretend to
  // have executed dual-revision closure evidence.
  const graph = execute ? buildDualRevisionImpactGraph({ gitCwd, baseHead: candidate.pair.base, head: candidate.pair.head, catalog }) : undefined;
  const manifest = buildDynamicValidationPlan({
    storyId: candidate.storyId, baseHead: candidate.pair.base, head: candidate.pair.head,
    inventory, catalog, changes, closures, baselineEpochId: candidate.pair.base, graph,
    buildProofDigest: 'historical-replay-plan', mode: 'shadow', gitCwd,
  });
  assert.equal(verifyValidationSelectionManifest(manifest), true, `${candidate.storyId} produced an invalid selection manifest`);
  const reusable = reusableHistoricalRecord(candidate, manifest);
  if (reusable) {
    records.push(reusable);
    resumedHistoricalRecords += 1;
    continue;
  }
  if (resumeHistorical && !repairMissingHistorical) {
    throw new Error(`historical replay resume refused without re-execution: ${historicalResumeFailure || `${candidate.storyId}: record unavailable`}`);
  }
  if (execute) reexecutedHistoricalRecords += 1;
  const record: Record<string, unknown> = {
    storyId: candidate.storyId, category: candidate.category, baseHead: candidate.pair.base,
    head: candidate.pair.head, changedFiles: files.length, selectionDigest: stableDigest(manifest),
    selectionSemanticsDigest: stableDigest(historicalSelectionSemantics(manifest)),
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
      // A receipt binds the canonical directory its command ran in, so the
      // baseline identities are prepared in the workspace the full plan
      // actually executed in — not in the invoking checkout — and the
      // selection that consumes them is planned and executed in that same
      // workspace. (A second, fresh checkout cannot host the dynamic pass:
      // it is another directory, and no receipt from here is its receipt.)
      const baselineManifest = buildDynamicValidationPlan({
        storyId: candidate.storyId, baseHead: candidate.pair.base, head: candidate.pair.head,
        inventory, catalog, changes, closures, baselineEpochId: candidate.pair.base, graph,
        buildProofDigest: 'historical-replay-plan', mode: 'shadow', gitCwd: historicalRoot,
      });
      const baselineReceipts = catalog.flatMap((entry, index) => {
        const row = baselineManifest.rows.find((candidateRow) => candidateRow.commandId === entry.id);
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
        baselineEpochId: candidate.pair.base, graph, buildProofDigest: 'historical-replay-plan', buildArtifactsHash: full.buildArtifactsHash,
        mode: 'shadow', gitCwd: historicalRoot,
      });
      // Positive reuse contract: every baseline receipt names the identity the
      // selection computes for its command in this workspace (launch
      // directory included), so a receipt that could be reused IS matched; a
      // campaign can no longer degenerate silently into full-versus-full.
      for (const receipt of baselineReceipts) {
        const row = dynamicManifest.rows.find((candidateRow) => candidateRow.commandId === receipt.commandId);
        assert.equal(row?.inputDigest, receipt.inputDigest, `${candidate.storyId}: baseline receipt for ${receipt.commandId} does not name the selection's input identity (launch directory disagreement)`);
        assert.equal(row?.resolvedCwd, canonicalizeExistingPath(launchDirectoryOf(historicalRoot, catalog.find((entry) => entry.id === receipt.commandId)?.cwd)), `${candidate.storyId}: selection row for ${receipt.commandId} is not bound to the baseline's launch directory`);
      }
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

if (repairStoryId) {
  assert.equal(records.length, 1, `historical replay repair must write exactly one record for ${repairStoryId}`);
  console.log(`historical replay repair complete: ${repairStoryId}`);
  process.exit(0);
}

const categories = [...new Set(records.map(row => row.category))].sort();
const fiCandidate = selected.find(candidate => changedFiles(candidate.pair.base, candidate.pair.head).some(change => change.status === 'renamed' && change.path.startsWith('packages/main/src/')))
  || selected.find(candidate => changedFiles(candidate.pair.base, candidate.pair.head).some(change => change.status === 'deleted' && change.path.startsWith('packages/main/src/')))
  || candidates.find(candidate => changedFiles(candidate.pair.base, candidate.pair.head).some(change => change.status === 'renamed'))
  || candidates.find(candidate => changedFiles(candidate.pair.base, candidate.pair.head).some(change => change.status === 'deleted'))
  || selected[0];
const fiPair = fiCandidate?.pair || { base: git(['rev-parse', 'HEAD^']), head: git(['rev-parse', 'HEAD']) };
const fiReferenceBase = fiPair.base;
const fiReferenceHead = fiPair.head;
const fiGraph = buildDualRevisionImpactGraph({ gitCwd, baseHead: fiReferenceBase, head: fiReferenceHead, catalog });
const fiRevisionChanges = changedFiles(fiReferenceBase, fiReferenceHead);
const fiDeletedPath = fiRevisionChanges.find(change => change.status === 'deleted')?.path || fiRevisionChanges.find(change => change.status === 'renamed')?.oldPath;
const fiRenamed = fiRevisionChanges.find(change => change.status === 'renamed');
const fiFallbackPath = fiRevisionChanges[0]?.path;
const focusedSelectionFaults = (() => {
  const candidates = catalog.filter(entry => entry.assurance === 'story-selectable' && entry.inputRoots.length > 0);
  const sourceChange = fiRevisionChanges.find(change => change.status !== 'deleted' && change.path.startsWith('packages/main/src/'));
  const directSeed = candidates[0];
  const directPath = sourceChange?.path;
  const directProbe = directSeed && directPath ? { ...directSeed, inputRoots: [directPath] } : undefined;
  const targetSeedBase = candidates.find(entry => entry.id !== directProbe?.id);
  const targetSeed = targetSeedBase ? { ...targetSeedBase, triggerExtensions: { ...targetSeedBase.triggerExtensions, processFacts: ['validate'], capabilities: ['file-edit'] } } : undefined;
  const findDependentPath = (change: StoryChangedFile | undefined, direct: typeof directProbe, target: typeof targetSeed) => {
    if (!change || !direct || !target) return undefined;
    const stem = (change.path || '').split('/').pop()!.replace(/\.[^.]+$/, '');
    const refs = [...new Set([fiReferenceHead, fiReferenceBase])];
    let matches: string[] = [];
    for (const ref of refs) {
      try {
        matches.push(...execFileSync('git', ['grep', '-l', stem, ref, '--', 'packages/main/src'], { cwd: gitCwd, encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(path => path.includes(':') ? path.slice(path.indexOf(':') + 1) : path));
      } catch { /* no textual candidates at this ref */ }
    }
    for (const path of [...new Set(matches)]) {
      if (path === change.path || path === change.path.replace(/\.[^.]+$/, '.js')) continue;
      const targetProbe = { ...target, inputRoots: [path] };
      const graph = buildDualRevisionImpactGraph({ gitCwd, baseHead: fiReferenceBase, head: fiReferenceHead, catalog: [direct, targetProbe] });
      if (graph.commandsAffectedBy(change).includes(target.id)) return path;
    }
    return undefined;
  };
  const dependentPath = findDependentPath(sourceChange, directProbe, targetSeed);
  const targetMatch = directProbe && sourceChange && targetSeed && dependentPath
    ? { target: { ...targetSeed, inputRoots: [dependentPath] }, graph: buildDualRevisionImpactGraph({ gitCwd, baseHead: fiReferenceBase, head: fiReferenceHead, catalog: [directProbe, { ...targetSeed, inputRoots: [dependentPath] }] }) }
    : undefined;
  const targetEntry = targetMatch?.target;
  const withGraph = targetMatch?.graph;
  // Some deletion Story diffs include several removed files.  The first file
  // is not necessarily a module with a retained reverse edge, so select the
  // actual renamed/deleted source that the dual-revision graph can prove has
  // a dependent instead of making the FI depend on diff ordering.
  const graphChangeCandidates = [
    ...(fiRenamed ? [fiRenamed] : []),
    ...fiRevisionChanges.filter(change => change.status === 'deleted'),
    ...(sourceChange ? [sourceChange] : []),
  ];
  const graphSourceChange = graphChangeCandidates.find(change => {
    // A head-only reuse probe must avoid an independently full-escalating
    // path.  Otherwise both graph modes execute for that separate policy
    // reason and the FI cannot measure the base-only reverse dependency.
    const changeManifest = buildStoryChangeManifest({
      storyId: 'B-fi-focused-graph-candidate', gitCwd,
      baseHead: fiReferenceBase, head: fiReferenceHead, changedFiles: [change],
    });
    if (classifyFullValidationReasons(changeManifest, catalog).length > 0) return false;
    const probe = directSeed ? { ...directSeed, inputRoots: [change.path] } : undefined;
    return Boolean(findDependentPath(change, probe, targetSeed));
  });
  const graphDirectPath = graphSourceChange?.path;
  const graphDirectProbe = directSeed && graphDirectPath ? { ...directSeed, inputRoots: [graphDirectPath] } : undefined;
  const graphDependentPath = findDependentPath(graphSourceChange, graphDirectProbe, targetSeed);
  const graphTargetMatch = graphDirectProbe && targetSeed && graphDependentPath
    ? { target: { ...targetSeed, inputRoots: [graphDependentPath] }, graph: buildDualRevisionImpactGraph({ gitCwd, baseHead: fiReferenceBase, head: fiReferenceHead, catalog: [graphDirectProbe, { ...targetSeed, inputRoots: [graphDependentPath] }] }) }
    : undefined;
  if (!directProbe || !targetEntry || !withGraph || !sourceChange || withGraph.graphUnknown) {
    const probeFailure = { directPath, sourceChange, directCommandId: directProbe?.id, targetSeedId: targetSeed?.id, dependentPath, graphUnknown: withGraph?.graphUnknown };
    return [{ fiId: 'FI-2', commandId: 'focused-selection-probe', mutation: 'receipt-signature-and-closure-edge-rejection', expected: 'valid-reuse-forged-execute-incomplete-closure-escalates', observed: probeFailure, passed: false }, { fiId: 'FI-5', commandId: 'focused-selection-probe', mutation: 'dual-revision-graph-causal-dependent', expected: 'unimpacted-reuse-graph-impact-execute', observed: probeFailure, passed: false }];
  }
  const probeCommands = inventory.commands.filter(command => command.id === directProbe.id || command.id === targetEntry.id);
  const probeInventory = { ...inventory, commands: probeCommands, digest: stableDigest(probeCommands) };
  const probeCatalog = [directProbe, targetEntry];
  const probeCatalogDigest = stableDigest(probeCatalog);
  const probeClosures = new Map(probeCatalog.map(entry => [entry.id, createValidationClosureCertificate({ commandId: entry.id, baseHead: fiReferenceBase, inventoryDigest: probeInventory.digest, catalogDigest: probeCatalogDigest, staticPaths: entry.inputRoots, processFacts: entry.triggerExtensions.processFacts, capabilities: entry.triggerExtensions.capabilities })]));
  const probeChanges = buildStoryChangeManifest({ storyId: 'B-fi-focused', gitCwd, baseHead: fiReferenceBase, head: fiReferenceHead, changedFiles: [sourceChange] });
  const baseContext = { storyId: 'B-fi-focused', baseHead: fiReferenceBase, head: fiReferenceHead, inventory: probeInventory, catalog: probeCatalog, changes: probeChanges, closures: probeClosures, baselineEpochId: 'fi-focused-epoch', buildProofDigest: 'fi-focused-build', buildArtifactsHash: 'fixture-build-artifacts', mode: 'observe' as const };
  const noGraphPlan = buildDynamicValidationPlan(baseContext);
  const targetRow = noGraphPlan.rows.find(row => row.commandId === targetEntry.id)!;
  const targetClosure = probeClosures.get(targetEntry.id)!;
  const makeProbeReceipt = (closure: typeof targetClosure) => createValidationCommandReceipt({ buildArtifactsDigest: 'fixture-build-artifacts', buildArtifactsProtection: 'enforced:fixture',
    id: 'fi-focused-receipt', commandId: targetEntry.id,
    commandIdentityDigest: stableDigest({ command: targetEntry.command, args: targetEntry.args }),
    inputDigest: targetRow.inputDigest, closureCertificateDigest: closure.signature,
    catalogDigest: probeCatalogDigest, inventoryDigest: probeInventory.digest,
    runnerDigest: stableDigest(targetEntry.runnerSourceDigest || ''), toolchainDigest: '', buildProofDigest: 'fi-focused-build',
    sourceHead: fiReferenceHead, sourceBaseHead: fiReferenceBase, canonicalBaselineEpochId: 'fi-focused-epoch',
    producedBy: 'story-execution', cleanTreeDigest: stableDigest({ focused: true }),
    executionEnvironmentDigest: stableDigest({ node: process.version, platform: process.platform, arch: process.arch }),
    result: 'PASS', exitCode: 0, outputDigest: stableDigest('fi-focused-pass'), durationMs: 1,
    createdAt: new Date().toISOString(), revocationLedgerDigest: stableDigest({}),
  });
  const probeReceipt = makeProbeReceipt(targetClosure);
  const validReuse = buildDynamicValidationPlan({ ...baseContext, receipts: [probeReceipt] });
  const forgedReceipt = { ...probeReceipt, signature: '0'.repeat(64) };
  const forgedExecute = buildDynamicValidationPlan({ ...baseContext, receipts: [forgedReceipt] });
  const incompleteClosure = createValidationClosureCertificate({
    commandId: targetEntry.id, baseHead: fiReferenceBase, inventoryDigest: probeInventory.digest, catalogDigest: probeCatalogDigest,
    staticPaths: targetEntry.inputRoots, processFacts: targetEntry.triggerExtensions.processFacts, capabilities: targetEntry.triggerExtensions.capabilities,
    runtimeTrace: { readPaths: [targetEntry.inputRoots[0]!, directPath!], unknownRuntimeInputs: ['fi-focused-undeclared-runtime-edge'] },
  });
  const incompleteExecute = buildDynamicValidationPlan({ ...baseContext, closures: new Map([...probeClosures, [targetEntry.id, incompleteClosure]]), receipts: [makeProbeReceipt(incompleteClosure)] });
  const omittedStaticClosure = createValidationClosureCertificate({ commandId: targetEntry.id, baseHead: fiReferenceBase, inventoryDigest: probeInventory.digest, catalogDigest: probeCatalogDigest, staticPaths: [], processFacts: targetEntry.triggerExtensions.processFacts, capabilities: targetEntry.triggerExtensions.capabilities });
  const omittedFactClosure = createValidationClosureCertificate({ commandId: targetEntry.id, baseHead: fiReferenceBase, inventoryDigest: probeInventory.digest, catalogDigest: probeCatalogDigest, staticPaths: targetEntry.inputRoots, processFacts: [], capabilities: targetEntry.triggerExtensions.capabilities });
  const omittedCapabilityClosure = createValidationClosureCertificate({ commandId: targetEntry.id, baseHead: fiReferenceBase, inventoryDigest: probeInventory.digest, catalogDigest: probeCatalogDigest, staticPaths: targetEntry.inputRoots, processFacts: targetEntry.triggerExtensions.processFacts, capabilities: [] });
  const staticExecute = buildDynamicValidationPlan({ ...baseContext, closures: new Map([...probeClosures, [targetEntry.id, omittedStaticClosure]]), receipts: [makeProbeReceipt(omittedStaticClosure)] });
  const factExecute = buildDynamicValidationPlan({ ...baseContext, closures: new Map([...probeClosures, [targetEntry.id, omittedFactClosure]]), receipts: [makeProbeReceipt(omittedFactClosure)] });
  const capabilityExecute = buildDynamicValidationPlan({ ...baseContext, closures: new Map([...probeClosures, [targetEntry.id, omittedCapabilityClosure]]), receipts: [makeProbeReceipt(omittedCapabilityClosure)] });
  const validTarget = validReuse.rows.find(row => row.commandId === targetEntry.id)!;
  const forgedTarget = forgedExecute.rows.find(row => row.commandId === targetEntry.id)!;
  const incompleteTarget = incompleteExecute.rows.find(row => row.commandId === targetEntry.id)!;
  const staticTarget = staticExecute.rows.find(row => row.commandId === targetEntry.id)!;
  const factTarget = factExecute.rows.find(row => row.commandId === targetEntry.id)!;
  const capabilityTarget = capabilityExecute.rows.find(row => row.commandId === targetEntry.id)!;
  const graphCatalog = graphDirectProbe && graphTargetMatch?.target ? [graphDirectProbe, graphTargetMatch.target] : undefined;
  const graphInventory = graphCatalog ? { ...inventory, commands: inventory.commands.filter(command => graphCatalog.some(entry => entry.id === command.id)), digest: stableDigest(inventory.commands.filter(command => graphCatalog.some(entry => entry.id === command.id))) } : undefined;
  const graphClosures = graphCatalog && graphInventory ? new Map(graphCatalog.map(entry => [entry.id, createValidationClosureCertificate({ commandId: entry.id, baseHead: fiReferenceBase, inventoryDigest: graphInventory.digest, catalogDigest: stableDigest(graphCatalog), staticPaths: entry.inputRoots, processFacts: entry.triggerExtensions.processFacts, capabilities: entry.triggerExtensions.capabilities })])) : undefined;
  const graphChanges = graphSourceChange && graphCatalog && graphInventory && graphClosures ? buildStoryChangeManifest({ storyId: 'B-fi-focused-graph', gitCwd, baseHead: fiReferenceBase, head: fiReferenceHead, changedFiles: [graphSourceChange] }) : undefined;
  const graphContext = graphCatalog && graphInventory && graphClosures && graphChanges ? { storyId: 'B-fi-focused-graph', baseHead: fiReferenceBase, head: fiReferenceHead, inventory: graphInventory, catalog: graphCatalog, changes: graphChanges, closures: graphClosures, baselineEpochId: 'fi-focused-epoch', buildProofDigest: 'fi-focused-build', buildArtifactsHash: 'fixture-build-artifacts', mode: 'observe' as const } : undefined;
  const graphTargetRow = graphContext && graphTargetMatch?.target ? buildDynamicValidationPlan(graphContext).rows.find(row => row.commandId === graphTargetMatch.target.id) : undefined;
  const graphReceipt = graphContext && graphTargetMatch?.target && graphTargetRow && graphClosures ? createValidationCommandReceipt({ buildArtifactsDigest: 'fixture-build-artifacts', buildArtifactsProtection: 'enforced:fixture',
    id: 'fi-focused-graph-receipt', commandId: graphTargetMatch.target.id,
    commandIdentityDigest: stableDigest({ command: graphTargetMatch.target.command, args: graphTargetMatch.target.args }), inputDigest: graphTargetRow.inputDigest,
    closureCertificateDigest: graphClosures.get(graphTargetMatch.target.id)!.signature, catalogDigest: stableDigest(graphCatalog), inventoryDigest: graphInventory!.digest,
    runnerDigest: stableDigest(graphTargetMatch.target.runnerSourceDigest || ''), toolchainDigest: '', buildProofDigest: 'fi-focused-build', sourceHead: fiReferenceHead, sourceBaseHead: fiReferenceBase,
    canonicalBaselineEpochId: 'fi-focused-epoch', producedBy: 'story-execution', cleanTreeDigest: stableDigest({ focused: true }), executionEnvironmentDigest: stableDigest({ node: process.version, platform: process.platform, arch: process.arch }),
    result: 'PASS', exitCode: 0, outputDigest: stableDigest('fi-focused-graph-pass'), durationMs: 1, createdAt: new Date().toISOString(), revocationLedgerDigest: stableDigest({}),
  }) : undefined;
  const graphNoGraphPlan = graphContext && graphReceipt ? buildDynamicValidationPlan({ ...graphContext, receipts: [graphReceipt] }) : undefined;
  const graphExecute = graphContext && graphReceipt && graphTargetMatch?.graph ? buildDynamicValidationPlan({ ...graphContext, graph: graphTargetMatch.graph, receipts: [graphReceipt] }) : undefined;
  const graphNoGraphTarget = graphNoGraphPlan && graphTargetMatch?.target ? graphNoGraphPlan.rows.find(row => row.commandId === graphTargetMatch.target.id) : undefined;
  const graphExecuteTarget = graphExecute && graphTargetMatch?.target ? graphExecute.rows.find(row => row.commandId === graphTargetMatch.target.id) : undefined;
  const headOnlyChangedFile = graphSourceChange?.status === 'renamed' && graphSourceChange.oldPath
    ? { path: graphSourceChange.oldPath, status: 'deleted' as const, blobId: '<deleted>' }
    : graphSourceChange;
  const headOnlyDirectProbe = graphDirectProbe && headOnlyChangedFile ? { ...graphDirectProbe, inputRoots: [headOnlyChangedFile.path] } : undefined;
  const headOnlyCatalog = headOnlyDirectProbe && graphTargetMatch?.target ? [headOnlyDirectProbe, graphTargetMatch.target] : undefined;
  const headOnlyInventory = headOnlyCatalog ? { ...inventory, commands: inventory.commands.filter(command => headOnlyCatalog.some(entry => entry.id === command.id)), digest: stableDigest(inventory.commands.filter(command => headOnlyCatalog.some(entry => entry.id === command.id))) } : undefined;
  const headOnlyCatalogDigest = headOnlyCatalog ? stableDigest(headOnlyCatalog) : undefined;
  const headOnlyClosures = headOnlyCatalog && headOnlyInventory && headOnlyCatalogDigest ? new Map(headOnlyCatalog.map(entry => [entry.id, createValidationClosureCertificate({ commandId: entry.id, baseHead: fiReferenceBase, inventoryDigest: headOnlyInventory.digest, catalogDigest: headOnlyCatalogDigest, staticPaths: entry.inputRoots, processFacts: entry.triggerExtensions.processFacts, capabilities: entry.triggerExtensions.capabilities })])) : undefined;
  const headOnlyGraph = headOnlyCatalog && graphSourceChange
    ? buildDualRevisionImpactGraph({ gitCwd, baseHead: fiReferenceHead, head: fiReferenceHead, catalog: headOnlyCatalog })
    : undefined;
  const headOnlyChanges = headOnlyChangedFile && headOnlyCatalog && headOnlyInventory && headOnlyClosures
    ? buildStoryChangeManifest({ storyId: 'B-fi-focused-head-only', gitCwd, baseHead: fiReferenceBase, head: fiReferenceHead, changedFiles: [headOnlyChangedFile] })
    : undefined;
  const headOnlyContext = headOnlyCatalog && headOnlyInventory && headOnlyClosures && headOnlyChanges
    ? { storyId: 'B-fi-focused-head-only', baseHead: fiReferenceBase, head: fiReferenceHead, inventory: headOnlyInventory, catalog: headOnlyCatalog, changes: headOnlyChanges, closures: headOnlyClosures, baselineEpochId: 'fi-focused-epoch', buildProofDigest: 'fi-focused-build', buildArtifactsHash: 'fixture-build-artifacts', mode: 'observe' as const }
    : undefined;
  const headOnlyPrePlan = headOnlyContext && headOnlyGraph ? buildDynamicValidationPlan({ ...headOnlyContext, graph: headOnlyGraph }) : undefined;
  const headOnlyTargetRow = headOnlyPrePlan && graphTargetMatch?.target ? headOnlyPrePlan.rows.find(row => row.commandId === graphTargetMatch.target.id) : undefined;
  const headOnlyReceipt = graphReceipt && headOnlyTargetRow && headOnlyCatalogDigest && headOnlyInventory && headOnlyClosures && graphTargetMatch?.target ? (() => {
    const { signature: _signature, schema: _schema, expiresAt: _expiresAt, ...receiptBody } = graphReceipt;
    return createValidationCommandReceipt({ ...receiptBody, id: 'fi-focused-head-only-receipt', inputDigest: headOnlyTargetRow.inputDigest, closureCertificateDigest: headOnlyClosures.get(graphTargetMatch.target.id)!.signature, catalogDigest: headOnlyCatalogDigest, inventoryDigest: headOnlyInventory.digest });
  })() : undefined;
  const headOnlyPlan = headOnlyContext && headOnlyGraph && headOnlyReceipt ? buildDynamicValidationPlan({ ...headOnlyContext, graph: headOnlyGraph, receipts: [headOnlyReceipt] }) : undefined;
  const headOnlyTarget = headOnlyPlan && graphTargetMatch?.target ? headOnlyPlan.rows.find(row => row.commandId === graphTargetMatch.target.id) : undefined;
  return [
    { fiId: 'FI-2', commandId: targetEntry.id, mutation: 'receipt-signature-and-closure-edge-rejection', expected: 'valid-reuse-forged-execute-static-runtime-fact-capability-escalate', observed: { valid: validTarget.disposition, forged: forgedTarget.disposition, forgedFullEscalated: forgedExecute.fullEscalated, incomplete: incompleteTarget.disposition, incompleteFullEscalated: incompleteExecute.fullEscalated, static: staticTarget.disposition, fact: factTarget.disposition, capability: capabilityTarget.disposition, incompleteReasons: incompleteTarget.reasons, staticCertificateValid: verifyValidationClosureCertificate(omittedStaticClosure), factCertificateValid: verifyValidationClosureCertificate(omittedFactClosure), capabilityCertificateValid: verifyValidationClosureCertificate(omittedCapabilityClosure), runtimeCertificateValid: verifyValidationClosureCertificate(incompleteClosure), undeclaredRuntimeInputs: incompleteClosure.undeclaredObservedPaths }, passed: validTarget.disposition === 'reuse' && forgedTarget.disposition === 'execute' && forgedExecute.fullEscalated === false && verifyValidationClosureCertificate(omittedStaticClosure) && verifyValidationClosureCertificate(omittedFactClosure) && verifyValidationClosureCertificate(omittedCapabilityClosure) && !verifyValidationClosureCertificate(incompleteClosure) && [incompleteExecute, staticExecute, factExecute, capabilityExecute].every(plan => plan.fullEscalated === true) && [incompleteTarget, staticTarget, factTarget, capabilityTarget].every(row => row.disposition === 'execute') },
    { fiId: 'FI-5', commandId: graphTargetMatch?.target.id || targetEntry.id, mutation: 'dual-revision-graph-causal-dependent-delete-rename', expected: 'delete-or-rename-head-only-reuse-dual-revision-execute', observed: { noGraph: graphNoGraphTarget?.disposition, headOnly: headOnlyTarget?.disposition, headOnlyReasons: headOnlyTarget?.reasons, graph: graphExecuteTarget?.disposition, graphReasons: graphExecuteTarget?.reasons, baseHead: fiReferenceBase, head: fiReferenceHead, change: graphSourceChange, headOnlyChangedFile: headOnlyChangedFile, baseGraphDigest: graphTargetMatch?.graph.baseGraphDigest, headGraphDigest: graphTargetMatch?.graph.headGraphDigest, headOnlyGraphDigest: headOnlyGraph?.headGraphDigest }, passed: Boolean(graphSourceChange && ['deleted', 'renamed'].includes(graphSourceChange.status) && graphTargetMatch?.graph && graphTargetMatch.graph.graphUnknown === false && headOnlyGraph && headOnlyGraph.graphUnknown === false && headOnlyTarget?.disposition === 'reuse' && graphExecuteTarget?.disposition === 'execute' && graphExecuteTarget.reasons.some(reason => reason.startsWith('reverse-dependency:'))) },
  ];
})();
const faultInjection = [...catalog.flatMap((entry) => {
  const rows: Array<Record<string, unknown>> = [];
  const closure = closures.get(entry.id);
  const fiContext = (changedFiles: StoryChangedFile[], closureSet = closures) => {
    const changes = buildStoryChangeManifest({ storyId: `B-fi-${entry.id}`, gitCwd, baseHead: fiReferenceBase, head: fiReferenceHead, changedFiles });
    return buildDynamicValidationPlan({
      storyId: `B-fi-${entry.id}`, baseHead: fiReferenceBase, head: fiReferenceHead, inventory, catalog,
      changes, closures: closureSet, baselineEpochId: 'fi-epoch', buildProofDigest: 'fi-build', mode: 'observe', graph: fiGraph, gitCwd,
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
  const deleted = fiContext([{ path: fiDeletedPath || fiFallbackPath || entry.inputRoots[0] || 'packages/main/src/fi-deleted.ts', status: 'deleted', blobId: '<deleted>' }]);
  const renamed = fiContext([{
    path: fiRenamed?.path || fiFallbackPath || entry.inputRoots[0] || 'packages/main/src/fi-renamed.ts',
    oldPath: fiRenamed?.oldPath || fiDeletedPath || entry.inputRoots[0] || 'packages/main/src/fi-old.ts',
    status: 'renamed', blobId: stableDigest('fi-renamed'),
  }]);
  const deletedRow = deleted.rows.find((row) => row.commandId === entry.id);
  const renamedRow = renamed.rows.find((row) => row.commandId === entry.id);
  rows.push({ fiId: 'FI-5', commandId: entry.id, mutation: 'deleted-and-renamed-inputs', expected: 'base-and-head-graph-selection', observed: { baseHead: fiReferenceBase, head: fiReferenceHead, revisionChanges: fiRevisionChanges.length, deletedPath: fiDeletedPath, renamedPath: fiRenamed?.path, deletedManifest: verifyValidationSelectionManifest(deleted), renamedManifest: verifyValidationSelectionManifest(renamed), deletedDisposition: deletedRow?.disposition, renamedDisposition: renamedRow?.disposition, deletedGraph: deleted.dependencyGraphDigest, renamedGraph: renamed.dependencyGraphDigest }, passed: fiReferenceBase !== fiReferenceHead && fiRevisionChanges.length > 0 && Boolean(fiDeletedPath || fiRenamed) && verifyValidationSelectionManifest(deleted) && verifyValidationSelectionManifest(renamed) && deleted.dependencyGraphDigest.length > 0 && renamed.dependencyGraphDigest.length > 0 && deletedRow?.disposition === 'execute' && renamedRow?.disposition === 'execute' });
  return rows;
}), ...focusedSelectionFaults];
const faultInjectionPath = join(outputRoot, 'fault-injection.json');
let pairedPerformance: Record<string, unknown> | undefined;
if (paired) {
  const currentHead = git(['rev-parse', 'HEAD']);
  const currentChanges = buildStoryChangeManifest({ storyId: 'B-current-paired', gitCwd, baseHead: currentHead, head: currentHead, changedFiles: [] });
  const currentClosures = new Map(catalog.map((entry) => [entry.id, createValidationClosureCertificate({
    commandId: entry.id, baseHead: currentHead, inventoryDigest: inventory.digest,
    catalogDigest, staticPaths: entry.inputRoots,
  })]));
  const currentGraph = buildDualRevisionImpactGraph({ gitCwd, baseHead: currentHead, head: currentHead, catalog });
  const fullCommands = validationCommands(catalog);
  let pairedManifest: ReturnType<typeof buildDynamicValidationPlan> | undefined;
  let selectedIds = new Set<string>();
  let dynamicCommands: ReturnType<typeof validationCommands> = [];
  const runs: Array<Record<string, unknown>> = [];
  await withHistoricalWorktrees(currentHead, currentHead, async ({ head: pairedRoot }) => {
    // Baseline identities are prepared in the workspace the baseline runs in
    // (a receipt binds its launch directory), never in the invoking checkout.
    const pairedBaseline = buildDynamicValidationPlan({
      storyId: 'B-current-paired', baseHead: currentHead, head: currentHead, inventory, catalog,
      changes: currentChanges, closures: currentClosures, baselineEpochId: currentHead,
      buildProofDigest: 'paired-performance', graph: currentGraph, mode: 'shadow', gitCwd: pairedRoot,
    });
    const baseline = await executeValidationPlan({ provider: 'historical-paired-canonical-baseline', commands: fullCommands, warnings: [] }, pairedRoot, currentHead, 'B-current-paired');
    const baselineReceipts = catalog.flatMap((entry, index) => {
      const row = pairedBaseline.rows.find((candidateRow) => candidateRow.commandId === entry.id);
      const result = baseline.commands[index];
      const receipt = row && result ? receiptForBaseline({
        entry, row, result, storyId: 'B-current-paired', baseHead: currentHead, head: currentHead,
        catalogDigest, inventoryDigest: inventory.digest, baselineEpoch: currentHead,
        buildProofDigest: 'paired-performance',
      }) : undefined;
      return receipt ? [receipt] : [];
    });
    const pairedSelection = buildDynamicValidationPlan({
      storyId: 'B-current-paired', baseHead: currentHead, head: currentHead, inventory, catalog,
      changes: currentChanges, closures: currentClosures, receipts: baselineReceipts,
      baselineEpochId: currentHead, buildProofDigest: 'paired-performance', buildArtifactsHash: baseline.buildArtifactsHash, graph: currentGraph,
      mode: 'shadow', gitCwd: pairedRoot,
    });
    // Positive reuse contract for the paired campaign: nothing changed, so
    // every receipt names the identity the selection computes in this
    // workspace, every receipt whose command the planner MAY reuse is reused,
    // and every command the planner must always execute (always-assurance,
    // never-reuse closure, forbidden full-only baseline reuse) is executed.
    // At least one reusable command is required as the positive control.
    const mandatoryExecution = (entry: ValidationCatalogEntry): boolean => entry.assurance === 'always' || entry.closurePolicy === 'never-reuse' || (entry.assurance === 'full-only' && entry.fullBaselineReusePolicy === 'forbidden');
    const receiptedEntries = baselineReceipts.map((receipt) => ({ receipt, entry: catalog.find((entry) => entry.id === receipt.commandId)! }));
    for (const { receipt, entry } of receiptedEntries) {
      const row = pairedSelection.rows.find((candidateRow) => candidateRow.commandId === receipt.commandId);
      assert.equal(row?.inputDigest, receipt.inputDigest, `paired: baseline receipt for ${receipt.commandId} does not name the selection's input identity (launch directory disagreement)`);
      if (pairedSelection.fullEscalated) continue;
      if (mandatoryExecution(entry)) assert.equal(row?.disposition, 'execute', `paired: ${receipt.commandId} must always execute but was ${row?.disposition}`);
      else assert.equal(row?.disposition, 'reuse', `paired: ${receipt.commandId} has a valid receipt in this workspace but was ${row?.disposition}; the paired campaign would silently run full-versus-full`);
    }
    if (!pairedSelection.fullEscalated) {
      const reusable = receiptedEntries.filter(({ entry }) => !mandatoryExecution(entry));
      assert.ok(reusable.length > 0, 'paired: no reusable command with a baseline receipt; the campaign has no positive reuse control');
      assert.equal(pairedSelection.totals.reused, reusable.length, `paired: ${reusable.length} reusable receipts but ${pairedSelection.totals.reused} reused rows`);
    }
    pairedManifest = pairedSelection;
    selectedIds = new Set(pairedSelection.rows.filter((row) => row.disposition === 'execute').map((row) => row.commandId));
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
  const finalPairedManifest = pairedManifest;
  if (!finalPairedManifest) throw new Error('paired campaign: the selection manifest was not prepared in the paired workspace');
  pairedPerformance = signedArtifact({
    schema: 'proof-or-stop.dynamic-validation.paired-performance.v1',
    head: currentHead, inventoryDigest: inventory.digest, catalogDigest,
    selectionDigest: stableDigest(finalPairedManifest),
    dependencyGraphDigest: finalPairedManifest.dependencyGraphDigest,
    closureCertificateSetDigest: finalPairedManifest.closureCertificateSetDigest,
    canonicalBaselineEpochId: finalPairedManifest.canonicalBaselineEpochId,
    toolchainDigest: finalPairedManifest.toolchainDigest,
    revocationLedgerDigest: finalPairedManifest.receiptRevocationLedgerDigest,
    selectedCommandIds: [...selectedIds],
    selectedCount: finalPairedManifest.totals.executed,
    executedCount: finalPairedManifest.totals.executed,
    reusedCount: finalPairedManifest.totals.reused,
    unverifiedCount: finalPairedManifest.totals.unverified,
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
      return Boolean(peer && full.allPass === peer.allPass && peer.commandCount === finalPairedManifest.totals.executed);
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
const replayExecutionSafe = executableRecords.every((row) => {
  const execution = row.execution as Record<string, unknown>;
  const selectedCommandIds = Array.isArray(row.selectedCommandIds) ? row.selectedCommandIds : [];
  return Array.isArray(execution.fullFailures)
    && execution.fullFailures.every((id) => typeof id === 'string' && selectedCommandIds.includes(id))
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
  !replayExecutionSafe ? 'replay full-failure selection or residue check failed' : '',
  !verifyPayload(faultInjectionBody, faultInjectionArtifact.signature) ? 'fault-injection artifact signature is invalid' : '',
  !faultInjectionArtifact.allPass ? 'FI-1..FI-5 coverage is incomplete or failing' : '',
  !paired || !pairedPerformance
    || pairedPerformance.verdictEquivalent !== true
    || pairedPerformance.perCommandEquivalent !== true
    || !Array.isArray(pairedPerformance.runs)
    || (pairedPerformance.runs as Array<Record<string, unknown>>).some((run) => !Array.isArray(run.residue) || run.residue.length > 0)
    || !verifyPayload(Object.fromEntries(Object.entries(pairedPerformance).filter(([key]) => key !== 'signature')), String(pairedPerformance.signature || '')) ? 'paired full/dynamic per-command equivalence, residue, verdict or signature is missing' : '',
].filter(Boolean);
const reportBody = {
  schema: 'proof-or-stop.dynamic-validation.historical-replay.v1',
  generatedAt: new Date().toISOString(), root, execute, storyCount: records.length,
  categories, recordsDigest: stableDigest(records), records,
  historicalVerdictDriftCount: executableRecords.filter((row) => (row.execution as Record<string, unknown>).perCommandEquivalent !== true).length,
  replayExecution: {
    resumeRequested: resumeHistorical,
    repairMissingRequested: repairMissingHistorical,
    resumedHistoricalRecords,
    reexecutedHistoricalRecords,
  },
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

});
