#!/usr/bin/env node

/**
 * B-2856 smoke: git child-process cwd routing through the resolved gitRoot.
 *
 * BUG: ~14 git call sites defaulted their cwd to projectRoot/root (the
 * metadataRoot). In a WRAPPER-ROOT layout the metadataRoot is NOT a git repo and
 * the real repo is a configured gitRoot subdir, so those ops failed with
 * `fatal: not a git repository` (symptom: story_discard, validate --channel,
 * validate --concept). The fix reroutes every site through the resolved gitRoot
 * via resolveGitCwd()/resolveStorySignedWorkspace().
 *
 * This smoke asserts, for the rerouted sites:
 *  - WRAPPER-ROOT fixture (metadataRoot NOT git; gitRoot subdir IS git):
 *      each git op runs against the gitRoot subdir, succeeds (no
 *      'not a git repository'), and the EXACT cwd used == the gitRoot, not the
 *      metadataRoot.
 *  - PLAIN-REPO fixture (metadataRoot == gitRoot):
 *      each op runs with cwd == projectRoot (resolver null/unresolved →
 *      projectRoot fallback) and behavior is byte-identical.
 *
 * Coverage map (rerouted sites → assertion):
 *   resolveGitCwd helper ......................... direct unit assertions
 *   validate-channel git readers ................. injected cwd capture
 *   validate-concept git diff + repo-wide grep ... injected cwd capture
 *   core/cluster-sync git log main..HEAD ......... real git (no fatal) + cwd
 *   worktree story_discard branch -D / branchExists  real git (no fatal) + cwd
 *   worktree dev_merge top-of-repo gitRoot ....... resolver repoRoot assertion
 *
 * Prints ✓/✗ per check; exits non-zero on first failure.
 */

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StoryStore } from '../core/store.js';
import {
  resolveGitCwd,
  resolveStorySignedWorkspace,
} from '../core/story-signed-workspace-resolution.js';
import {
  checkCommitAuthor,
  type GitChangedFilesReader,
  type GitLogReader,
} from '../handlers/validate-channel.js';
import {
  checkConcept,
  type GitDiffReader,
  type GrepReader,
} from '../handlers/validate-concept.js';
import { syncClusterResolves } from '../core/cluster-sync.js';
import { createWorktreeHandlers } from '../handlers/worktree.js';

const STORY_DIR_REL = '.proof-or-stop/story/actives';
const STORY_ID = 'B-2856t';

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git('init -b main', dir);
  git('config user.email smoke@test.local', dir);
  git('config user.name smoke', dir);
  git('config commit.gpgsign false', dir);
}

/** proof-or-stop.config.json so StoryStore + resolution share storyDir / gitRoot. */
function writeConfig(metadataRoot: string, gitRoot?: string): void {
  const cfg: Record<string, unknown> = { storyDir: STORY_DIR_REL };
  if (gitRoot !== undefined) cfg.gitRoot = gitRoot;
  writeFileSync(join(metadataRoot, 'proof-or-stop.config.json'), JSON.stringify(cfg, null, 2));
}

/**
 * Materialize a NORMAL-channel story (>5 checklist items so the channel gate
 * reaches the git log reader rather than short-circuiting to skipped) under the
 * metadataRoot's configured storyDir.
 */
function writeStoryArtifacts(metadataRoot: string): void {
  const storyDir = join(metadataRoot, STORY_DIR_REL, STORY_ID);
  mkdirSync(storyDir, { recursive: true });
  const story = {
    storyId: STORY_ID,
    name: 'smoke',
    title: 'smoke',
    description: 'smoke',
    phase: 'REVIEW',
    type: 'feature',
    priority: 'high',
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(storyDir, 'index.json'), JSON.stringify(story, null, 2));
  const items = Array.from({ length: 6 }, (_, i) => ({
    id: `CHK-00${i + 1}`,
    title: `item ${i + 1}`,
    status: 'done',
  }));
  writeFileSync(
    join(storyDir, 'checklist.json'),
    JSON.stringify({ storyId: STORY_ID, items }, null, 2),
  );
}

function pass(msg: string): void {
  console.log(`✓ ${msg}`);
}

const base = mkdtempSync(join(tmpdir(), 'gitroot-cwd-routing-smoke-'));

try {
  // ── Build the WRAPPER-ROOT fixture ─────────────────────────────────────────
  // metadataRoot (wrapper) is NOT a git repo; gitRoot subdir IS a git repo with
  // a commit and a story branch.
  const wrapper = join(base, 'wrapper');
  mkdirSync(wrapper, { recursive: true });
  const gitRootDir = join(wrapper, 'repo');
  initGitRepo(gitRootDir);
  writeFileSync(join(gitRootDir, 'seed.txt'), 'seed\n');
  git('add seed.txt', gitRootDir);
  git('commit -m initial', gitRootDir);
  git(`branch story/${STORY_ID}`, gitRootDir);
  writeConfig(wrapper, 'repo'); // gitRoot = subdir; storyDir at wrapper root
  writeStoryArtifacts(wrapper);
  const wrapperStore = new StoryStore(wrapper);
  const wrapperGitRoot = realpathSync(gitRootDir);
  const wrapperMeta = realpathSync(wrapper);

  // ── Build the PLAIN-REPO fixture ───────────────────────────────────────────
  // metadataRoot == gitRoot: resolver returns null/unresolved gitRoot for the
  // cwd helper path (no configured gitRoot subdir), so callers fall back to
  // projectRoot. (resolveGitCwd plain-repo path is the metadata-git-root, which
  // canonically equals projectRoot here, proving byte-identical behavior.)
  const plain = join(base, 'plain');
  initGitRepo(plain);
  writeFileSync(join(plain, 'seed.txt'), 'seed\n');
  git('add seed.txt', plain);
  git('commit -m initial', plain);
  git(`branch story/${STORY_ID}`, plain);
  writeConfig(plain); // no configured gitRoot; metadataRoot itself is git-backed
  writeStoryArtifacts(plain);
  const plainStore = new StoryStore(plain);
  const plainRoot = realpathSync(plain);

  // ── resolveGitCwd helper: direct assertions ────────────────────────────────
  {
    const wrapperCwd = realpathSync(
      resolveGitCwd({ store: wrapperStore, storyId: STORY_ID, metadataRoot: wrapper, projectRoot: wrapper }),
    );
    assert.equal(
      wrapperCwd,
      wrapperGitRoot,
      'resolveGitCwd(wrapper) must resolve to the gitRoot subdir, not metadataRoot',
    );
    assert.notEqual(wrapperCwd, wrapperMeta, 'wrapper resolved cwd must NOT be the metadataRoot');

    // Plain repo: metadataRoot IS the git root → resolveGitCwd returns it
    // (== projectRoot canonically); proves the fallback keeps cwd == projectRoot.
    const plainCwd = realpathSync(
      resolveGitCwd({ store: plainStore, storyId: STORY_ID, metadataRoot: plain, projectRoot: plain }),
    );
    assert.equal(plainCwd, plainRoot, 'resolveGitCwd(plain) cwd must equal projectRoot');

    // Unresolved gitRoot (non-git metadataRoot, no configured gitRoot) → fallback
    // returns the passed projectRoot verbatim (byte-identical for plain layouts).
    const noGitRoot = join(base, 'no-git');
    mkdirSync(noGitRoot, { recursive: true });
    writeConfig(noGitRoot);
    writeStoryArtifacts(noGitRoot);
    const noGitStore = new StoryStore(noGitRoot);
    const fallbackSentinel = '/sentinel/project/root';
    const unresolved = resolveGitCwd({
      store: noGitStore,
      storyId: STORY_ID,
      metadataRoot: noGitRoot,
      projectRoot: fallbackSentinel,
    });
    assert.equal(
      unresolved,
      fallbackSentinel,
      'unresolved gitRoot must return the passed projectRoot fallback verbatim',
    );

    // Resolver-throws edge (absent story metadata) → fallback to projectRoot,
    // never crash the pipeline.
    const absentFallback = resolveGitCwd({
      store: wrapperStore,
      storyId: 'B-missing',
      metadataRoot: wrapper,
      projectRoot: fallbackSentinel,
    });
    assert.equal(
      absentFallback,
      fallbackSentinel,
      'resolver-throws (absent story) must fall back to projectRoot, not throw',
    );
  }
  pass('resolveGitCwd: wrapper→gitRoot, plain→projectRoot, unresolved/throws→fallback');

  // ── validate-channel git readers: injected cwd capture ─────────────────────
  {
    // wrapper-root: readers must receive cwd == gitRoot (not metadataRoot).
    const gitCwd = resolveGitCwd({
      store: wrapperStore,
      storyId: STORY_ID,
      metadataRoot: wrapper,
      projectRoot: wrapper,
    });
    const seenLogCwd: string[] = [];
    const seenChangedCwd: string[] = [];
    const logReader: GitLogReader = ({ projectRoot }) => {
      seenLogCwd.push(projectRoot);
      return 'abc1234|proof-or-stop-implementer|proof-or-stop: story init';
    };
    const changedReader: GitChangedFilesReader = ({ projectRoot }) => {
      seenChangedCwd.push(projectRoot);
      return [`${STORY_DIR_REL}/${STORY_ID}/index.json`];
    };
    const result = checkCommitAuthor(STORY_ID, {
      store: wrapperStore,
      projectRoot: wrapper,
      gitCwd,
      gitLogReader: logReader,
      gitChangedFilesReader: changedReader,
    });
    assert.equal(realpathSync(seenLogCwd[0]), wrapperGitRoot, 'channel gitLogReader cwd == gitRoot');
    assert.equal(
      realpathSync(seenChangedCwd[0]),
      wrapperGitRoot,
      'channel gitChangedFilesReader cwd == gitRoot',
    );
    assert.notEqual(realpathSync(seenLogCwd[0]), wrapperMeta, 'channel reader cwd must NOT be metadataRoot');
    // Gate semantics unchanged: a proof-or-stop-implementer commit still passes.
    assert.equal(result.status, 'pass', 'channel gate semantics unchanged after reroute (pass)');

    // plain-repo: default gitCwd (= projectRoot) → reader cwd == projectRoot.
    const seenPlainCwd: string[] = [];
    const plainLogReader: GitLogReader = ({ projectRoot }) => {
      seenPlainCwd.push(projectRoot);
      return '';
    };
    checkCommitAuthor(STORY_ID, {
      store: plainStore,
      projectRoot: plain,
      // no gitCwd passed → defaults to projectRoot (byte-identical)
      gitLogReader: plainLogReader,
    });
    assert.equal(seenPlainCwd[0], plain, 'channel reader cwd defaults to projectRoot on plain repo');
  }
  pass('validate-channel: readers get gitRoot (wrapper) / projectRoot (plain); gate semantics unchanged');

  // ── validate-concept git diff + repo-wide grep: injected cwd capture ───────
  {
    const gitCwd = resolveGitCwd({
      store: wrapperStore,
      storyId: STORY_ID,
      metadataRoot: wrapper,
      projectRoot: wrapper,
    });
    const seenDiffCwd: string[] = [];
    const seenGrepCwd: string[] = [];
    const diffReader: GitDiffReader = ({ projectRoot }) => {
      seenDiffCwd.push(projectRoot);
      return '-export function removedSymbol() {}\n';
    };
    const grepReader: GrepReader = ({ projectRoot }) => {
      seenGrepCwd.push(projectRoot);
      return ''; // no residuals
    };
    const result = checkConcept({ projectRoot: wrapper, gitCwd, gitDiffReader: diffReader, grepReader });
    assert.equal(realpathSync(seenDiffCwd[0]), wrapperGitRoot, 'concept gitDiffReader cwd == gitRoot');
    assert.equal(realpathSync(seenGrepCwd[0]), wrapperGitRoot, 'concept grepReader cwd == gitRoot');
    assert.notEqual(realpathSync(seenDiffCwd[0]), wrapperMeta, 'concept diff cwd must NOT be metadataRoot');
    // Gate semantics unchanged: deleted symbol detected, no residuals → pass.
    assert.equal(result.status, 'pass', 'concept gate semantics unchanged (deleted symbol, no residual → pass)');
    assert.deepEqual(result.deletedSymbols, ['removedSymbol'], 'deleted symbol extraction unchanged');

    // plain-repo: default gitCwd (= projectRoot) → reader cwd == projectRoot.
    const seenPlainDiff: string[] = [];
    checkConcept({
      projectRoot: plain,
      gitDiffReader: ({ projectRoot }) => {
        seenPlainDiff.push(projectRoot);
        return '';
      },
    });
    assert.equal(seenPlainDiff[0], plain, 'concept diff cwd defaults to projectRoot on plain repo');
  }
  pass('validate-concept: diff + repo-wide grep get gitRoot (wrapper) / projectRoot (plain); semantics unchanged');

  // ── core/cluster-sync git log main..HEAD: REAL git, no 'not a git repository' ─
  {
    // wrapper-root: previously `git log main..HEAD` ran in the non-git
    // metadataRoot → fatal. Now it runs in the gitRoot subdir and succeeds.
    wrapperStore.writeClusters(STORY_ID, { clusters: [] });
    wrapperStore.writeFindings(STORY_ID, { findings: [] });
    const warnings: string[] = [];
    const wrapperSync = syncClusterResolves(STORY_ID, wrapperStore, wrapper, (m) => warnings.push(m));
    assert.equal(wrapperSync.resolved, 0, 'wrapper cluster-sync: no findings to resolve');
    assert.ok(
      !warnings.some((w) => /not a git repository/i.test(w)),
      `wrapper cluster-sync must NOT fail with 'not a git repository' (warnings: ${warnings.join(' | ')})`,
    );
    // Exact-cwd proof: the resolved cwd for this story is the gitRoot subdir.
    const syncCwd = realpathSync(
      resolveGitCwd({ store: wrapperStore, storyId: STORY_ID, metadataRoot: wrapper, projectRoot: wrapper }),
    );
    assert.equal(syncCwd, wrapperGitRoot, 'cluster-sync resolved cwd == gitRoot, not metadataRoot');

    // plain-repo: byte-identical — runs from projectRoot, succeeds.
    plainStore.writeClusters(STORY_ID, { clusters: [] });
    plainStore.writeFindings(STORY_ID, { findings: [] });
    const plainWarnings: string[] = [];
    syncClusterResolves(STORY_ID, plainStore, plain, (m) => plainWarnings.push(m));
    assert.ok(
      !plainWarnings.some((w) => /not a git repository/i.test(w)),
      'plain cluster-sync must succeed from projectRoot',
    );
  }
  pass('cluster-sync: git log main..HEAD runs against gitRoot (wrapper) / projectRoot (plain), no fatal');

  // ── worktree story_discard: REAL branch -D / branchExists against gitRoot ───
  {
    // wrapper-root: branch story/B-2856t exists in the gitRoot subdir. The
    // previous code ran `git branch -D` / branchExists from the non-git
    // metadataRoot → fatal. Now they run from the resolved gitRoot.
    // dev_merge top-of-repo ops use the resolver's repoRoot — assert it equals
    // the gitRoot (proves dev_merge/story_discard route to the real repo).
    const wrapperResolution = resolveStorySignedWorkspace({
      store: wrapperStore,
      storyId: STORY_ID,
      metadataRoot: wrapper,
    });
    assert.ok(wrapperResolution.repoRoot, 'wrapper resolution exposes a repoRoot for worktree ops');
    assert.equal(
      realpathSync(wrapperResolution.repoRoot!),
      wrapperGitRoot,
      'worktree top-of-repo gitRoot (dev_merge/story_discard) resolves to the gitRoot subdir',
    );

    // Verify the branch is present in the gitRoot before discard.
    assert.equal(
      git('rev-parse --verify --quiet refs/heads/story/' + STORY_ID, gitRootDir).length > 0,
      true,
      'story branch exists in gitRoot before discard',
    );
    const wrapperHandlers = createWorktreeHandlers({ store: wrapperStore, root: wrapper, scanRoot: wrapper });
    const discardOut = wrapperHandlers.story_discard({ storyId: STORY_ID, reason: 'smoke' });
    assert.ok(
      !/not a git repository/i.test(discardOut),
      `wrapper story_discard must NOT fail with 'not a git repository':\n${discardOut}`,
    );
    assert.match(discardOut, /Branch story\/B-2856t deleted/, 'wrapper story_discard deleted the branch via gitRoot');
    // The branch must actually be gone from the gitRoot subdir (exact-cwd proof).
    const remaining = git('branch --list story/' + STORY_ID, gitRootDir);
    assert.equal(remaining, '', 'story branch removed from the gitRoot subdir, not the metadataRoot');

    // plain-repo: byte-identical — branch -D runs from projectRoot and succeeds.
    const plainHandlers = createWorktreeHandlers({ store: plainStore, root: plain, scanRoot: plain });
    const plainDiscard = plainHandlers.story_discard({ storyId: STORY_ID, reason: 'smoke' });
    assert.ok(
      !/not a git repository/i.test(plainDiscard),
      `plain story_discard must succeed from projectRoot:\n${plainDiscard}`,
    );
    assert.match(plainDiscard, /Branch story\/B-2856t deleted/, 'plain story_discard deleted the branch from projectRoot');
    assert.equal(git('branch --list story/' + STORY_ID, plain), '', 'plain story branch removed from projectRoot');
  }
  pass('worktree story_discard: branch -D / branchExists run against gitRoot (wrapper) / projectRoot (plain), no fatal');

  console.log('\n✓ gitroot-cwd-routing smoke passed (wrapper-root + plain-repo)');
} catch (err) {
  console.error('\n✗ gitroot-cwd-routing smoke FAILED');
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  rmSync(base, { recursive: true, force: true });
  process.exit(1);
}

rmSync(base, { recursive: true, force: true });
