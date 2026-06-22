#!/usr/bin/env node
/**
 * done-oracle-wrapper-root-smoke (B-6666 CHK-001)
 *
 * Regression for the wrapper-root (metadataRoot != gitRoot) DONE false-block in
 * the DONE-oracle git-status path. buildDoneChecklist's `git-working-tree` row
 * reads `git status --porcelain` via readGitStatusLines. Before CHK-001 it ran
 * from the bare metadataRoot (the `root` argument). On a wrapper-root layout the
 * metadataRoot is NOT a git repo and the real repo is a configured gitRoot
 * subdir, so `git status` from the metadataRoot errors with
 * `fatal: not a git repository` -> the git-working-tree row reads
 * status=fail/blocking -> DONE is falsely blocked (ClawCreek-class projects can
 * never reach DONE).
 *
 * CHK-001 threads a resolved `gitCwd` (resolved ONCE at the
 * transition-orchestrator DONE boundary via resolveGitCwd) down to
 * buildDoneChecklist and on into readGitStatusLines. When gitCwd is absent it
 * falls back to `root`, so plain repos (projectRoot==gitCwd) stay byte-identical.
 *
 * Fixture (real disk, cleaned up):
 *   metadataRoot/                <- NON-git directory (the wrapper metadata root);
 *                                   `git status` from here errors.
 *     lattice.config.json        <- { gitRoot: "repo" } so resolveGitCwd resolves
 *                                   to the subdir via the configured-git-root branch
 *     .lattice/story/actives/... <- real StoryStore metadata (story + checklist)
 *     repo/                      <- the REAL inner `git init` repo (the gitRoot),
 *                                   branch main, one CLEAN commit
 *
 * Proofs:
 *   (1) RED baseline: buildDoneChecklist with gitCwd absent (falls back to the
 *       bare, non-git metadataRoot) -> the git-working-tree row is fail/blocking
 *       (git status errors). This is exactly the wrapper-root false-block.
 *   (2) GREEN: buildDoneChecklist with the resolved gitCwd (the real, clean
 *       gitRoot) -> the git-working-tree row reads clean/pass.
 *   (3) PLAIN-REPO byte-identity: on a plain repo (metadataRoot==gitRoot), the
 *       FULL buildDoneChecklist row set is byte-identical whether gitCwd is
 *       absent or explicitly equals root.
 *
 * B-6666 CHK-002 extends this with the evidence-freshness git probes
 * (currentGitHead / currentMaterialHash). Before CHK-002 those probes used a
 * no-op `const gitCwd = projectRoot` alias (zero resolveGitCwd routing), so on a
 * wrapper-root layout they ran git from the bare metadataRoot and returned
 * undefined hashes. CHK-002 renames the probe param to gitCwd (resolved at the
 * caller boundary) so:
 *   (4) RED probes: currentGitHead/currentMaterialHash(bare metadataRoot) ===
 *       undefined (the bare non-git root errors).
 *   (5) GREEN probes: currentGitHead/currentMaterialHash(resolvedGitCwd) are
 *       DEFINED hashes (run against the real gitRoot).
 *   (6) PLAIN-REPO probe byte-identity: on a plain repo the probes return the
 *       same value whether called with the bare root or the resolved gitCwd
 *       (which equals root) — proving the root fallback is byte-identical.
 *
 * B-6666 F-001 (REVIEW fix) extends this with a wrapper-root + CUSTOM storyDir
 * fixture. CHK-002 passed gitCwd into isMaterialExcludedPath -> isStoryMetadataPath
 * -> loadConfig at two sites in evidence-freshness.ts. But the lattice.config.json
 * that declares a CUSTOM storyDir lives at the metadataRoot, NOT the gitCwd. On a
 * wrapper-root layout with a non-default storyDir, loadConfig(gitCwd) silently
 * misses the custom storyDir, falls back to default prefixes, and the custom
 * story-metadata paths are WRONGLY included in the material hash. The F-001 fix
 * threads metadataRoot (not gitCwd) into isMaterialExcludedPath's config load:
 *   (7) RED (buggy): currentMaterialHash(gitCwd, 'HEAD', gitCwd) — passing
 *       gitCwd-as-metadataRoot — loads config from the inner gitRoot (no custom
 *       storyDir) so the custom-storyDir file is INCLUDED in the hash.
 *   (8) GREEN (fixed): currentMaterialHash(gitCwd, 'HEAD', metadataRoot) — passing
 *       the real metadataRoot — loads the custom storyDir from the config there so
 *       the custom-storyDir file is EXCLUDED from the hash.
 *   The RED and GREEN hashes MUST DIFFER (the buggy one includes the file the
 *   fixed one excludes). A control hash that excludes only the runtime artifacts
 *   (no story metadata at all) proves the GREEN hash truly dropped the file.
 *
 * On success prints `done-oracle wrapper-root smoke passed`; any assert failure
 * throws -> exit 1.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDoneChecklist, type DoneCheckRow } from '../core/done-oracle.js';
import { currentGitHead, currentMaterialHash, isMaterialExcludedPath } from '../core/evidence-freshness.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

const STORY_ID = 'B-6666';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'smoke',
      GIT_AUTHOR_EMAIL: 'smoke@example.com',
      GIT_COMMITTER_NAME: 'smoke',
      GIT_COMMITTER_EMAIL: 'smoke@example.com',
    },
  });
}

const CONFIG = (gitRoot: string | undefined) =>
  JSON.stringify(
    {
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
      ...(gitRoot ? { gitRoot } : {}),
      workflow: { profile: 'light' },
    },
    null,
    2,
  );

/** A minimal TEST-phase story with NO worktree binding (so resolveGitCwd uses
 * the configured-git-root branch driven by lattice.config.json gitRoot). */
function writeStory(store: StoryStore, storyId: string): void {
  const now = '2026-06-17T00:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'wrapper-root-fixture',
    title: 'Wrapper root fixture story',
    description: 'Drive the DONE-oracle git-status row over a wrapper-root layout.',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    // NO worktree binding -> configured-git-root branch resolves to the subdir.
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic item',
      context: 'Synthetic context',
      status: 'done',
      startTime: null,
      endTime: null,
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
}

function gitWorkingTreeRow(rows: DoneCheckRow[]): DoneCheckRow {
  const row = rows.find((r) => r.id === 'git-working-tree');
  assert.ok(row, 'DONE checklist must include a git-working-tree row');
  return row!;
}

// ════════════════════════════════════════════════════════════════════════════
// Wrapper-root fixture: metadataRoot (NON-git) + gitRoot subdir (clean git repo).
// ════════════════════════════════════════════════════════════════════════════
function buildWrapperFixture(): { metadataRoot: string; gitRoot: string } {
  const metadataRoot = mkdtempSync(join(tmpdir(), 'lattice-done-oracle-wrapper-'));
  // metadataRoot is deliberately NOT a git repo: `git status` from here errors.
  writeFileSync(join(metadataRoot, 'lattice.config.json'), CONFIG('repo'), 'utf-8');

  // gitRoot = a real INNER git repo in a subdir, branch main, one clean commit.
  const gitRoot = join(metadataRoot, 'repo');
  mkdirSync(gitRoot, { recursive: true });
  git(gitRoot, ['init']);
  git(gitRoot, ['checkout', '-b', 'main']);
  writeFileSync(join(gitRoot, 'README.md'), '# wrapper root inner repo\n', 'utf-8');
  git(gitRoot, ['add', '.']);
  git(gitRoot, ['commit', '-m', 'base']);
  // Working tree is clean after the commit (README is committed, nothing else).
  return { metadataRoot, gitRoot };
}

// ════════════════════════════════════════════════════════════════════════════
// (1) RED baseline + (2) GREEN, same fixture.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const { metadataRoot, gitRoot } = buildWrapperFixture();
  try {
    const store = new StoryStore(metadataRoot);
    writeStory(store, STORY_ID);

    // (1) RED baseline: gitCwd absent -> falls back to the bare, non-git
    // metadataRoot. `git status` from there errors -> git-working-tree fails.
    const redRows = buildDoneChecklist(STORY_ID, store, metadataRoot, { auditWriter: null });
    const redRow = gitWorkingTreeRow(redRows);
    assert.equal(
      redRow.status,
      'fail',
      `RED: git-working-tree row must FAIL on the bare non-git metadataRoot ` +
        `(got status=${redRow.status}, detail=${JSON.stringify(redRow.detail)}). ` +
        `This is the wrapper-root DONE false-block CHK-001 fixes.`,
    );
    assert.equal(
      redRow.blocking,
      true,
      `RED: the failing git-working-tree row must be blocking (got blocking=${redRow.blocking})`,
    );
    assert.ok(
      (redRow.detail ?? '').includes('unable to read git status'),
      `RED: the failure must be the git-status read error (got detail=${JSON.stringify(redRow.detail)})`,
    );

    // Resolve the gitCwd ONCE via the production choke-point. Must resolve to the
    // real inner gitRoot subdir (proving the wrapper-root layout is wired).
    const resolvedGitCwd = resolveGitCwd({
      store,
      storyId: STORY_ID,
      metadataRoot,
      projectRoot: metadataRoot,
    });
    assert.notEqual(
      resolvedGitCwd,
      metadataRoot,
      `resolveGitCwd must resolve to the configured gitRoot subdir, not the metadataRoot ` +
        `(got ${resolvedGitCwd})`,
    );

    // (2) GREEN: buildDoneChecklist with the resolved gitCwd -> the row reads
    // clean/pass because git status runs in the real, clean gitRoot.
    const greenRows = buildDoneChecklist(STORY_ID, store, metadataRoot, {
      auditWriter: null,
      gitCwd: resolvedGitCwd,
    });
    const greenRow = gitWorkingTreeRow(greenRows);
    assert.equal(
      greenRow.status,
      'pass',
      `GREEN: git-working-tree row must PASS with the resolved gitCwd ` +
        `(got status=${greenRow.status}, detail=${JSON.stringify(greenRow.detail)})`,
    );
    assert.equal(
      greenRow.detail,
      'clean',
      `GREEN: git-working-tree detail must read 'clean' (got ${JSON.stringify(greenRow.detail)})`,
    );

    // RED vs GREEN MUST differ — that is the whole point: gitCwd selection is
    // load-bearing for the DONE-oracle git-status row.
    assert.notEqual(
      redRow.status,
      greenRow.status,
      'RED (bare metadataRoot) and GREEN (resolved gitCwd) must produce DIFFERENT git-working-tree outcomes',
    );

    // ── B-6666 CHK-002: evidence-freshness probe RED/GREEN on the same fixture ──
    // (4) RED probes: bare non-git metadataRoot -> undefined hashes.
    const redHead = currentGitHead(metadataRoot);
    const redMaterial = currentMaterialHash(metadataRoot);
    assert.equal(
      redHead,
      undefined,
      `RED probe: currentGitHead(bare metadataRoot) must be undefined ` +
        `(got ${JSON.stringify(redHead)}). The bare non-git root errors on git rev-parse.`,
    );
    assert.equal(
      redMaterial,
      undefined,
      `RED probe: currentMaterialHash(bare metadataRoot) must be undefined ` +
        `(got ${JSON.stringify(redMaterial)}). The bare non-git root errors on git ls-tree.`,
    );

    // (5) GREEN probes: resolved gitCwd (real inner gitRoot) -> defined hashes.
    const greenHead = currentGitHead(resolvedGitCwd);
    const greenMaterial = currentMaterialHash(resolvedGitCwd);
    assert.ok(
      typeof greenHead === 'string' && greenHead.length > 0,
      `GREEN probe: currentGitHead(resolvedGitCwd) must be a defined hash ` +
        `(got ${JSON.stringify(greenHead)})`,
    );
    assert.ok(
      typeof greenMaterial === 'string' && greenMaterial.length > 0,
      `GREEN probe: currentMaterialHash(resolvedGitCwd) must be a defined hash ` +
        `(got ${JSON.stringify(greenMaterial)})`,
    );
    // RED vs GREEN probes MUST differ (undefined vs defined) — gitCwd selection
    // is load-bearing for the evidence-freshness probes too.
    assert.notEqual(
      redHead,
      greenHead,
      'RED probe (bare metadataRoot) and GREEN probe (resolved gitCwd) must differ',
    );

    void gitRoot;
  } finally {
    rmSync(metadataRoot, { recursive: true, force: true });
    resetConfigCache();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// (3) PLAIN-REPO byte-identity: metadataRoot==gitRoot. The FULL row set must be
//     byte-identical whether gitCwd is absent or explicitly equals root.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-oracle-plain-'));
  try {
    writeFileSync(join(root, 'lattice.config.json'), CONFIG(undefined), 'utf-8');
    writeFileSync(join(root, 'README.md'), '# plain repo\n', 'utf-8');
    git(root, ['init']);
    git(root, ['checkout', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);

    const store = new StoryStore(root);
    writeStory(store, STORY_ID);
    // Commit the story metadata so the working tree is clean either way.
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'story metadata']);

    // auditWriter:null keeps both runs read-only so neither appends process
    // events that would make the second run observe a different tree.
    const absentGitCwd = buildDoneChecklist(STORY_ID, store, root, { auditWriter: null });
    const explicitGitCwd = buildDoneChecklist(STORY_ID, store, root, { auditWriter: null, gitCwd: root });

    assert.deepEqual(
      explicitGitCwd,
      absentGitCwd,
      'PLAIN: buildDoneChecklist output must be byte-identical when gitCwd is absent vs explicitly equals root',
    );

    // And specifically the git-working-tree row is clean/pass on both.
    const absentRow = gitWorkingTreeRow(absentGitCwd);
    const explicitRow = gitWorkingTreeRow(explicitGitCwd);
    assert.equal(absentRow.status, 'pass', `PLAIN: git-working-tree must pass (gitCwd absent), got ${absentRow.status}`);
    assert.equal(explicitRow.status, 'pass', `PLAIN: git-working-tree must pass (gitCwd=root), got ${explicitRow.status}`);
    assert.deepEqual(
      explicitRow,
      absentRow,
      'PLAIN: the git-working-tree row must be byte-identical with gitCwd absent vs gitCwd=root',
    );

    // ── B-6666 CHK-002: evidence-freshness probe plain-repo byte-identity ──
    // On a plain repo the resolved gitCwd points at the SAME git repo as root
    // (resolveGitCwd may canonicalize via realpath — e.g. macOS /var ->
    // /private/var — so compare the PROBE OUTPUTS, not the path strings). The
    // probes must return identical, defined hashes whether called with the bare
    // root or the resolved gitCwd: that is the byte-identity the root fallback
    // promises.
    const plainResolvedGitCwd = resolveGitCwd({ store, storyId: STORY_ID, metadataRoot: root, projectRoot: root });
    const bareHead = currentGitHead(root);
    const resolvedHead = currentGitHead(plainResolvedGitCwd);
    const bareMaterial = currentMaterialHash(root);
    const resolvedMaterial = currentMaterialHash(plainResolvedGitCwd);
    assert.ok(typeof bareHead === 'string' && bareHead.length > 0, `PLAIN: currentGitHead(root) must be defined (got ${JSON.stringify(bareHead)})`);
    assert.equal(resolvedHead, bareHead, 'PLAIN: currentGitHead must be byte-identical with bare root vs resolved gitCwd');
    assert.ok(typeof bareMaterial === 'string' && bareMaterial.length > 0, `PLAIN: currentMaterialHash(root) must be defined (got ${JSON.stringify(bareMaterial)})`);
    assert.equal(resolvedMaterial, bareMaterial, 'PLAIN: currentMaterialHash must be byte-identical with bare root vs resolved gitCwd');
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// B-6666 F-001: wrapper-root + CUSTOM storyDir. Proves currentMaterialHash's
// metadata exclusion loads lattice.config.json from the metadataRoot (where the
// custom storyDir is declared), NOT from the gitCwd.
//
// Layout:
//   metadataRoot/                <- NON-git wrapper metadata root.
//     lattice.config.json        <- { gitRoot: "repo", storyDir: "custom/story" }
//   metadataRoot/repo/           <- the REAL inner git repo (gitRoot), branch main.
//     src/keep.ts                <- a MATERIAL (non-metadata) file: always hashed.
//     custom/story/B-6666/index.json  <- a CUSTOM-storyDir metadata file. Only the
//                                  metadataRoot config knows "custom/story" is the
//                                  storyDir; from the gitCwd it looks like ordinary
//                                  source and is wrongly hashed.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const metadataRoot = mkdtempSync(join(tmpdir(), 'lattice-done-oracle-customstory-'));
  try {
    const CUSTOM_STORY_DIR = 'custom/story';
    const customConfig = JSON.stringify(
      {
        scanRoot: 'packages/main',
        rootDir: 'src',
        storyDir: CUSTOM_STORY_DIR,
        requirementsDir: 'docs/requirements',
        worktreeDir: '.worktrees',
        gitRoot: 'repo',
        workflow: { profile: 'light' },
      },
      null,
      2,
    );
    // metadataRoot is deliberately NOT a git repo; the config (with the custom
    // storyDir) lives here, at the metadataRoot.
    writeFileSync(join(metadataRoot, 'lattice.config.json'), customConfig, 'utf-8');

    // Inner gitRoot subdir: a real git repo with one material file + one
    // custom-storyDir metadata file, all committed (clean working tree).
    const gitRoot = join(metadataRoot, 'repo');
    mkdirSync(join(gitRoot, 'src'), { recursive: true });
    mkdirSync(join(gitRoot, CUSTOM_STORY_DIR, STORY_ID), { recursive: true });
    git(gitRoot, ['init']);
    git(gitRoot, ['checkout', '-b', 'main']);
    writeFileSync(join(gitRoot, 'src', 'keep.ts'), 'export const keep = 1;\n', 'utf-8');
    writeFileSync(
      join(gitRoot, CUSTOM_STORY_DIR, STORY_ID, 'index.json'),
      JSON.stringify({ storyId: STORY_ID, note: 'custom-storyDir metadata' }, null, 2),
      'utf-8',
    );
    git(gitRoot, ['add', '.']);
    git(gitRoot, ['commit', '-m', 'base with custom-storyDir metadata']);

    // gitCwd is the real inner repo (where git ls-tree must run).
    const gitCwd = gitRoot;

    // (7) RED (the OLD buggy behavior): pass gitCwd as the metadataRoot. The
    // config load runs from the inner gitRoot, which has NO lattice.config.json,
    // so loadConfig falls back to the default storyDir prefixes — none of which
    // match "custom/story/" — and the custom-storyDir file is INCLUDED.
    const redHash = currentMaterialHash(gitCwd, 'HEAD', gitCwd);

    // (8) GREEN (the F-001 fix): pass the real metadataRoot. loadConfig finds the
    // custom storyDir "custom/story" declared there, so the custom-storyDir file
    // is EXCLUDED from the material hash.
    const greenHash = currentMaterialHash(gitCwd, 'HEAD', metadataRoot);

    assert.ok(
      typeof redHash === 'string' && redHash.length > 0,
      `F-001 RED: currentMaterialHash(gitCwd-as-metadataRoot) must be a defined hash (got ${JSON.stringify(redHash)})`,
    );
    assert.ok(
      typeof greenHash === 'string' && greenHash.length > 0,
      `F-001 GREEN: currentMaterialHash(metadataRoot) must be a defined hash (got ${JSON.stringify(greenHash)})`,
    );

    // The whole point: the custom-storyDir file is hashed in RED but excluded in
    // GREEN, so the two hashes MUST DIFFER. Identical hashes would mean the
    // metadataRoot threading made no difference (the F-001 bug never red).
    assert.notEqual(
      redHash,
      greenHash,
      'F-001: the gitCwd-as-metadataRoot hash (custom-storyDir file INCLUDED) must DIFFER ' +
        'from the metadataRoot-threaded hash (custom-storyDir file EXCLUDED). ' +
        'Equal hashes mean isMaterialExcludedPath is not loading the custom storyDir from the metadataRoot.',
    );

    // Cross-check the direct exclusion predicate: with metadataRoot the custom
    // path is excluded; with gitCwd-as-metadataRoot it is NOT excluded. This is
    // the exact call-shape currentMaterialHash uses internally.
    const customMetadataPath = `${CUSTOM_STORY_DIR}/${STORY_ID}/index.json`;
    assert.equal(
      isMaterialExcludedPath(customMetadataPath, metadataRoot),
      true,
      `F-001: isMaterialExcludedPath('${customMetadataPath}', metadataRoot) must be true ` +
        '(loadConfig finds the custom storyDir from the metadataRoot)',
    );
    assert.equal(
      isMaterialExcludedPath(customMetadataPath, gitCwd),
      false,
      `F-001: isMaterialExcludedPath('${customMetadataPath}', gitCwd-as-metadataRoot) must be false ` +
        '(loadConfig from the inner gitRoot misses the custom storyDir — the original bug)',
    );

    // And the material file is ALWAYS hashed regardless of which root is used —
    // it is never excluded, so it is not what makes the hashes differ.
    assert.equal(
      isMaterialExcludedPath('src/keep.ts', metadataRoot),
      false,
      "F-001: the material file 'src/keep.ts' must never be excluded",
    );
  } finally {
    rmSync(metadataRoot, { recursive: true, force: true });
    resetConfigCache();
  }
}

console.log('done-oracle wrapper-root smoke passed');
