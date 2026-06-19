#!/usr/bin/env node
/**
 * B-7691 CHK-002 — Regression coverage for the review_run_start material-source
 * clean-tree preflight.
 *
 * review_run_start now runs a fail-fast clean-tree preflight (handlers/review-run.ts)
 * AFTER the REVIEW phase check and BEFORE capturing the review-run snapshot. It
 * reuses the DONE gate's shared git-status read (readGitStatusLines) + classifier
 * options (classifierOptionsForCheck) + the shared DIRTY_GATE_POLICY blocking
 * table (via isBlockingDirty) — all relocated to core/dirty-worktree-gate.ts.
 *
 * Each scenario runs in an isolated OS-temp git repo (cleaned up). The story is a
 * synthetic REVIEW-phase story on a `story/<id>` branch (no worktree binding, so
 * the signed workspace resolves to the repo root — the same shape
 * field-regression-cli-smoke uses to drive review_run_start).
 *
 * Asserts:
 *   (a) uncommitted MATERIAL-SOURCE change  -> review_run_start REFUSES, no run recorded
 *   (b) uncommitted FIXTURE change          -> REFUSES (fixtures are blocking)
 *   (c) clean tree                          -> PROCEEDS + records the run
 *   (d) only .lattice metadata dirty        -> PROCEEDS (non-blocking category)
 *   (e) refusal message names the offending material-source file
 *   (f) PARITY: isBlockingDirty(classifyGitStatusRows(...)) gives the SAME blocked
 *       verdict the DONE gate's evaluateDirtyGitStatus would for an identical git status
 *   (g) REGRESSION: the DONE gate still classifies/blocks identically after the extraction
 *   (h) FAIL-OPEN: an unreadable git status does NOT block review_run_start
 *   (i) ORDERING: a dirty tree whose HEAD cannot produce materialHash reports
 *       the preflight dirty-tree refusal, not the snapshot missing_material_hash
 *
 * On success prints `✓ review-run-clean-tree-preflight-smoke passed`; any assert
 * failure throws -> exit 1.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resetConfigCache, loadConfig } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { buildDoneChecklist, type DoneCheckRow } from '../core/done-oracle.js';
import {
  readGitStatusLines,
  classifierOptionsForCheck,
  classifyGitStatusRows,
  isBlockingDirty,
} from '../core/dirty-worktree-gate.js';
import { evaluateDirtyGate } from '../core/dirty-gate-policy.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commit(cwd: string, message: string): void {
  git(cwd, ['add', '.']);
  git(cwd, [
    '-c', 'user.name=Lattice Smoke',
    '-c', 'user.email=smoke@example.test',
    '-c', 'commit.gpgsign=false',
    'commit',
    '-m', message,
  ]);
}

function runLatticeRaw(
  cwd: string,
  command: string,
  args: Record<string, unknown> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, command, JSON.stringify(args)], {
      cwd,
      env: { ...process.env, LATTICE_PROJECT_ROOT: cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', code => resolvePromise({ code: code ?? 0, stdout, stderr }));
  });
}

const now = '2026-06-19T00:00:00.000Z';

/** A REVIEW-phase story on a story/<id> branch with NO worktree binding so the
 * signed workspace resolves to the repo root (mirrors field-regression-cli-smoke). */
function writeReviewStory(store: StoryStore, storyId: string): void {
  const story: StoryInfo = {
    storyId,
    name: `${storyId.toLowerCase()}-clean-tree-preflight`,
    title: `${storyId} clean-tree preflight`,
    description: 'Synthetic REVIEW story for the review_run_start clean-tree preflight smoke.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    currentReviewRound: now,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic item',
      context: 'Synthetic context',
      status: 'done',
      startTime: now,
      endTime: now,
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
}

/** Initialize a clean git repo + lattice project + a committed REVIEW story on a
 * story/<id> branch. Returns the repo root. Working tree is CLEAN on return. */
function initReviewRepo(prefix: string, storyId: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Lattice Smoke']);
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    fixturesDir: 'tests/fixtures',
    worktreeDir: '.worktrees',
    workflow: { profile: 'balanced' },
  }, null, 2));
  write(root, '.gitignore', [
    '.worktrees/',
    '.lattice/*',
    '!.lattice/story/',
    '!.lattice/story/**',
    '',
  ].join('\n'));
  write(root, 'README.md', 'review-run clean-tree preflight smoke\n');
  write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
  commit(root, 'base');
  resetConfigCache();

  git(root, ['checkout', '-b', `story/${storyId}`]);
  const store = new StoryStore(root);
  writeReviewStory(store, storyId);
  commit(root, 'story metadata');
  return root;
}

/** Initialize a repo whose HEAD has no material files, then leave both project
 * config/story metadata and a material-source file dirty. If snapshot capture
 * runs before the preflight, this shape reports missing_material_hash. */
function initEmptyHeadDirtyReviewRepo(prefix: string, storyId: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Lattice Smoke']);
  git(root, [
    '-c', 'user.name=Lattice Smoke',
    '-c', 'user.email=smoke@example.test',
    '-c', 'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m', 'empty material base',
  ]);
  git(root, ['checkout', '-b', `story/${storyId}`]);
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    fixturesDir: 'tests/fixtures',
    worktreeDir: '.worktrees',
    workflow: { profile: 'balanced' },
  }, null, 2));
  resetConfigCache();
  const store = new StoryStore(root);
  writeReviewStory(store, storyId);
  write(root, 'packages/main/src/ordering.ts', 'export const dirtyBeforeSnapshot = true;\n');
  return root;
}

function gitWorkingTreeRow(rows: DoneCheckRow[]): DoneCheckRow {
  const row = rows.find((r) => r.id === 'git-working-tree');
  assert.ok(row, 'DONE checklist must include a git-working-tree row');
  return row!;
}

function reviewRunCount(root: string, storyId: string): number {
  return new StoryStore(root).readReviewRuns(storyId).runs.length;
}

// ════════════════════════════════════════════════════════════════════════════
// (i) ORDERING: blocking dirty-tree preflight runs BEFORE snapshot capture.
// ════════════════════════════════════════════════════════════════════════════
async function assertDirtyPreflightBeatsMissingMaterialSnapshot(): Promise<void> {
  const storyId = 'B-ord';
  const root = initEmptyHeadDirtyReviewRepo('lattice-rrclean-ordering-', storyId);
  try {
    const result = await runLatticeRaw(root, 'review_run_start', {
      storyId,
      agent: 'lattice-review-quality',
      prompt: 'inspect diff',
    });
    const combined = result.stdout + result.stderr;
    assert.notEqual(result.code, 0, `ordering dirty tree must fail, got:\n${combined}`);
    assert.match(combined, /git working tree has uncommitted/, '(i) preflight refusal must win before snapshot diagnostics');
    assert.match(combined, /material_source_changes/, '(i) refusal must include the dirty material-source category');
    assert.doesNotMatch(combined, /missing_material_hash/, '(i) snapshot missing_material_hash would prove capture ran before preflight');
    assert.equal(reviewRunCount(root, storyId), 0, '(i) no review run must be recorded on preflight refusal');
    console.log('  ✓ (i) ordering: dirty preflight beats missing-material snapshot diagnostics');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// (a) uncommitted MATERIAL-SOURCE change -> REFUSES, no run recorded
// (e) refusal message names the offending material-source file
// ════════════════════════════════════════════════════════════════════════════
async function assertMaterialSourceDirtyRefuses(): Promise<void> {
  const storyId = 'B-mat';
  const root = initReviewRepo('lattice-rrclean-material-', storyId);
  try {
    // Uncommitted material-source change under the configured rootDir.
    write(root, 'packages/main/src/foo.ts', 'export const drift = true;\n');

    const result = await runLatticeRaw(root, 'review_run_start', {
      storyId,
      agent: 'lattice-review-quality',
      prompt: 'inspect diff',
    });
    const combined = result.stdout + result.stderr;
    assert.notEqual(result.code, 0, `material-source dirty must make review_run_start FAIL, got:\n${combined}`);
    assert.match(combined, /git working tree has uncommitted/, 'refusal must mention uncommitted working tree changes');
    assert.match(combined, /material_source_changes/, 'refusal must name the blocking category');
    assert.match(combined, /packages\/main\/src\/foo\.ts/, '(e) refusal must name the offending material-source file');
    assert.match(combined, /rerun review_run_start/, 'refusal must give the actionable rerun guidance');
    assert.equal(reviewRunCount(root, storyId), 0, '(a) no review run must be recorded on refusal');
    console.log('  ✓ (a)+(e) material-source dirty: review_run_start REFUSES, names the file, no run recorded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// (b) uncommitted FIXTURE change -> REFUSES
// ════════════════════════════════════════════════════════════════════════════
async function assertFixtureDirtyRefuses(): Promise<void> {
  const storyId = 'B-fix';
  const root = initReviewRepo('lattice-rrclean-fixture-', storyId);
  try {
    // Uncommitted change under the configured fixturesDir.
    write(root, 'tests/fixtures/sample.json', '{"drift":true}\n');

    const result = await runLatticeRaw(root, 'review_run_start', {
      storyId,
      agent: 'lattice-review-quality',
      prompt: 'inspect diff',
    });
    const combined = result.stdout + result.stderr;
    assert.notEqual(result.code, 0, `fixture dirty must make review_run_start FAIL, got:\n${combined}`);
    assert.match(combined, /fixture_changes/, '(b) refusal must name the fixture_changes blocking category');
    assert.match(combined, /tests\/fixtures\/sample\.json/, 'refusal must name the offending fixture file');
    assert.equal(reviewRunCount(root, storyId), 0, '(b) no review run must be recorded on fixture refusal');
    console.log('  ✓ (b) fixture dirty: review_run_start REFUSES, no run recorded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// (c) clean tree -> PROCEEDS + records the run
// ════════════════════════════════════════════════════════════════════════════
async function assertCleanTreeProceeds(): Promise<void> {
  const storyId = 'B-cln';
  const root = initReviewRepo('lattice-rrclean-clean-', storyId);
  try {
    const result = await runLatticeRaw(root, 'review_run_start', {
      storyId,
      agent: 'lattice-review-quality',
      prompt: 'inspect diff',
    });
    const combined = result.stdout + result.stderr;
    assert.equal(result.code, 0, `clean tree must let review_run_start SUCCEED, got:\n${combined}`);
    assert.match(result.stdout, /Review run B-cln:RR-001 started/, '(c) clean tree must start a review run');
    assert.equal(reviewRunCount(root, storyId), 1, '(c) exactly one review run must be recorded on a clean tree');
    console.log('  ✓ (c) clean tree: review_run_start PROCEEDS, records RR-001');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// (d) only .lattice metadata dirty -> PROCEEDS (non-blocking category)
// ════════════════════════════════════════════════════════════════════════════
async function assertMetadataOnlyDirtyProceeds(): Promise<void> {
  const storyId = 'B-meta';
  const root = initReviewRepo('lattice-rrclean-metadata-', storyId);
  try {
    // Dirty ONLY lattice-owned story metadata (a non-blocking category). Use a
    // throwaway file under the story dir — NOT the story's own index.json (that
    // is the story record itself; corrupting it would break the phase check
    // BEFORE the preflight, which is not what this case is exercising).
    write(root, `.lattice/story/actives/${storyId}/scratch.json`, JSON.stringify({ touched: true }) + '\n');

    // Pre-condition: classify confirms ONLY the non-blocking lattice_metadata
    // category is dirty (no blocking categories) — so PROCEEDS is meaningful.
    const store = new StoryStore(root);
    const status = readGitStatusLines(root);
    assert.ok(status.ok, 'pre-condition: git status must be readable');
    const classification = classifyGitStatusRows(
      status.ok ? status.lines : [],
      classifierOptionsForCheck(loadConfig(root), storyId, store, root),
    );
    assert.equal(classification.groups.lattice_metadata_changes.length > 0, true, 'pre-condition: metadata must be dirty');
    assert.equal(isBlockingDirty(classification).blocked, false, 'pre-condition: metadata-only dirt must be non-blocking');

    const result = await runLatticeRaw(root, 'review_run_start', {
      storyId,
      agent: 'lattice-review-quality',
      prompt: 'inspect diff',
    });
    const combined = result.stdout + result.stderr;
    assert.equal(result.code, 0, `metadata-only dirty must let review_run_start SUCCEED, got:\n${combined}`);
    assert.match(result.stdout, /Review run B-meta:RR-001 started/, '(d) metadata-only dirty must start a review run');
    assert.equal(reviewRunCount(root, storyId), 1, '(d) exactly one review run must be recorded on metadata-only dirt');
    console.log('  ✓ (d) metadata-only dirty: review_run_start PROCEEDS (non-blocking category)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// (f) PARITY + (g) REGRESSION: isBlockingDirty parity with the DONE gate's
//     evaluateDirtyGate over the SAME git status; DONE classify/block unchanged.
// ════════════════════════════════════════════════════════════════════════════
function assertParityAndDoneRegression(): void {
  const storyId = 'B-par';
  const root = initReviewRepo('lattice-rrclean-parity-', storyId);
  try {
    const store = new StoryStore(root);
    const config = loadConfig(root);
    const options = classifierOptionsForCheck(config, storyId, store, root);

    // A representative mixed dirty status: one blocking material-source change,
    // one blocking fixture change, one non-blocking lattice-metadata change.
    const sampleStatuses: { label: string; lines: string[]; expectBlocked: boolean }[] = [
      { label: 'clean', lines: [], expectBlocked: false },
      { label: 'metadata-only', lines: [` M .lattice/story/actives/${storyId}/index.json`], expectBlocked: false },
      { label: 'material-source', lines: [' M packages/main/src/foo.ts'], expectBlocked: true },
      { label: 'fixture', lines: ['?? tests/fixtures/sample.json'], expectBlocked: true },
      { label: 'unexpected', lines: ['?? random/path/thing.bin'], expectBlocked: true },
      {
        label: 'mixed',
        lines: [
          ' M packages/main/src/foo.ts',
          '?? tests/fixtures/sample.json',
          ` M .lattice/story/actives/${storyId}/index.json`,
        ],
        expectBlocked: true,
      },
    ];

    for (const sample of sampleStatuses) {
      const classification = classifyGitStatusRows(sample.lines, options);

      // (f) PARITY: isBlockingDirty vs the DONE gate's evaluateDirtyGate
      // (!result.allPass means the DONE gate would block, since auditFailure is
      // null with a null writer — both derive from the SAME DIRTY_GATE_POLICY).
      const preflight = isBlockingDirty(classification);
      const doneGate = evaluateDirtyGate(classification, { storyId, gate: 'done-gate', writer: null });
      const doneBlocked = !doneGate.allPass;
      assert.equal(
        preflight.blocked,
        doneBlocked,
        `(f) PARITY [${sample.label}]: isBlockingDirty.blocked=${preflight.blocked} must equal ` +
          `the DONE gate's blocked verdict (!allPass=${doneBlocked})`,
      );
      assert.equal(
        preflight.blocked,
        sample.expectBlocked,
        `(f) [${sample.label}]: blocked verdict must be ${sample.expectBlocked}`,
      );
    }

    // (g) REGRESSION: the live DONE gate row reflects the same blocking semantics
    // after the extraction. Dirty the real tree with a blocking material change
    // and confirm buildDoneChecklist's git-working-tree row blocks; then revert
    // and confirm it passes on a clean tree.
    write(root, 'packages/main/src/regression.ts', 'export const reg = true;\n');
    const dirtyRows = buildDoneChecklist(storyId, store, root, { auditWriter: null });
    const dirtyRow = gitWorkingTreeRow(dirtyRows);
    assert.equal(dirtyRow.status, 'fail', `(g) DONE git-working-tree must FAIL on dirty material source: ${dirtyRow.detail}`);
    assert.equal(dirtyRow.blocking, true, '(g) the failing DONE git-working-tree row must be blocking');
    assert.match(dirtyRow.detail ?? '', /material_source_changes/, '(g) DONE row must classify the dirt as material_source_changes');

    rmSync(join(root, 'packages/main/src/regression.ts'), { force: true });
    const cleanRows = buildDoneChecklist(storyId, store, root, { auditWriter: null });
    const cleanRow = gitWorkingTreeRow(cleanRows);
    assert.equal(cleanRow.status, 'pass', `(g) DONE git-working-tree must PASS on a clean tree: ${cleanRow.detail}`);
    assert.equal(cleanRow.detail, 'clean', '(g) clean DONE git-working-tree detail must read "clean"');

    console.log('  ✓ (f) isBlockingDirty parity with DONE evaluateDirtyGate; (g) DONE gate classify/block unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// (h) FAIL-OPEN: an unreadable git status does NOT block review_run_start.
//     Unit-level proof on the shared read (the handler proceeds when !status.ok).
// ════════════════════════════════════════════════════════════════════════════
function assertFailOpenOnUnreadableStatus(): void {
  const nonRepo = mkdtempSync(join(tmpdir(), 'lattice-rrclean-failopen-'));
  try {
    const status = readGitStatusLines(nonRepo);
    assert.equal(status.ok, false, '(h) readGitStatusLines on a non-git dir must report ok=false');
    // The handler's contract: when !status.ok it skips the classify/block path
    // entirely and proceeds. Prove that branch is what makes it fail-open by
    // showing the only code that can throw (isBlockingDirty over a classified
    // status) is never reachable for an unreadable status.
    assert.equal(
      'lines' in status,
      false,
      '(h) an unreadable status carries no lines to classify — the preflight cannot block',
    );
    console.log('  ✓ (h) fail-open: unreadable git status yields ok=false and skips the blocking path');
  } finally {
    rmSync(nonRepo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await assertDirtyPreflightBeatsMissingMaterialSnapshot();
  await assertMaterialSourceDirtyRefuses();
  await assertFixtureDirtyRefuses();
  await assertCleanTreeProceeds();
  await assertMetadataOnlyDirtyProceeds();
  assertParityAndDoneRegression();
  assertFailOpenOnUnreadableStatus();
  console.log('✓ review-run-clean-tree-preflight-smoke passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
