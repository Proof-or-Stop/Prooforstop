#!/usr/bin/env node

/**
 * B-854c CHK-004 smoke (broadened by B-02a6 CHK-003): regression coverage for
 * the story-metadata data-loss invariant (ClawCreek incident — 19 stories lost
 * when a broad `.lattice/` ignore left the persistent metadata neither tracked
 * nor protected; B-02a6 added the INIT-window case where an allowlisted but
 * UNCOMMITTED leaf is wiped by a plain `git clean -fd`).
 *
 * Three consumers of ONE shared pure predicate
 * (core/story-metadata-protection.ts) are covered against REAL temp git repos
 * with hand-written `.gitignore` fixtures (NOT the global `lattice` binary):
 *
 *   1. Predicate units — constructed bypassing any happy path (raw stubbed
 *      probes) so the broadened predicate (unsafe = !tracked) is asserted
 *      correct at every consumer:
 *        tracked (either ignore state) → safe;
 *        allowlisted-but-uncommitted (NOT ignored, untracked) → UNSAFE (B-02a6
 *          INIT window — removed by a plain `git clean -fd`);
 *        broad-ignore-untracked leaf → UNSAFE (ClawCreek — removed by -fdx);
 *        blank/whitespace leaf → throws.
 *   2. Bootstrap (real dev_start) — under non-ignoring .gitignore → metadata
 *      tracked after bootstrap, no warning; under broad `.lattice/` ignore →
 *      bootstrap SUCCEEDS (no "paths are ignored" error) AND warning present;
 *      under negation allowlist → succeeds, no warning (no false positive).
 *   3. Doctor (real handler) — broad-ignore-untracked fixture → predicate flags
 *      unsafe + remediation text + JSON unsafe; --repair writes the managed
 *      allowlist → re-scan safe; second --repair no-op; safe project → no false
 *      positive. B-0740 CHK-001 adds the WRAPPER-ROOT case (metadataRoot !=
 *      gitRoot): --repair must install the allowlist (wrote:true, no leading
 *      `fatal: not a git repository`) and a second run is a no-op — the prior
 *      cwd=root probe ran in the non-git wrapper and silently returned wrote:false.
 *   4. Bootstrap never silently leaves metadata in the neither-tracked-
 *      nor-protected state (force-add yields a tracked leaf even when ignored).
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StoryStore } from '../core/store.js';
import { createWorktreeHandlers } from '../handlers/worktree.js';
import { createDoctorHandlers } from '../handlers/doctor.js';
import {
  evaluateStoryMetadataProtection,
  renderStoryMetadataProtectionWarning,
  type StoryMetadataProbe,
} from '../core/story-metadata-protection.js';

const STORY_DIR_REL = '.lattice/story/actives';
const STORY_ID = 'B-test';
const LEAF_REL = `${STORY_DIR_REL}/${STORY_ID}/index.json`;
const NEGATION_ALLOWLIST = [
  '.lattice/*',
  '!.lattice/story/',
  '.lattice/story/*',
  '!.lattice/story/actives/',
  '!.lattice/story/actives/**',
].join('\n');

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init']);
  git(dir, ['checkout', '-B', 'main']);
  git(dir, ['config', 'user.email', 'smoke@test.local']);
  git(dir, ['config', 'user.name', 'smoke']);
}

function writeConfig(root: string): void {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({ storyDir: STORY_DIR_REL }, null, 2));
}

function writeStoryIndex(root: string, phase = 'DEV'): void {
  const storyDir = join(root, STORY_DIR_REL, STORY_ID);
  mkdirSync(storyDir, { recursive: true });
  writeFileSync(
    join(storyDir, 'index.json'),
    JSON.stringify(
      {
        storyId: STORY_ID,
        name: 'smoke',
        title: 'smoke',
        description: 'smoke story',
        phase,
        type: 'feature',
        priority: 'low',
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/** Stub probe: classify by a fixed (tracked, ignored) pair, bypassing real git. */
function stubRunner(probe: StoryMetadataProbe): (leaf: string) => StoryMetadataProbe {
  return () => probe;
}

/**
 * B-0740 CHK-001: build a WRAPPER-ROOT fixture (metadataRoot != gitRoot).
 *
 *   <wrapper>/                       ← metadataRoot, NOT a git repo
 *     lattice.config.json            ← storyDir under repo/, gitRoot=repo
 *     repo/                          ← the real git repo (gitRoot)
 *       .gitignore (.lattice/)       ← broad ignore → leaf unsafe → needsRepair
 *       lattice.config.json          ← also present at gitRoot for store reads
 *       .lattice/story/actives/<id>/index.json
 *
 * `repairStoryMetadataAllowlist` ran `git rev-parse --show-toplevel` in cwd=root
 * (the non-git wrapper) → threw `fatal: not a git repository` → wrote:false. The
 * fix threads the resolved gitProbeCwd so the probe runs in repo/.
 */
function buildWrapperRootFixture(wrapper: string): { wrapper: string; repo: string } {
  const repo = join(wrapper, 'repo');
  const storyDirRel = `repo/${STORY_DIR_REL}`;
  mkdirSync(wrapper, { recursive: true });
  initGitRepo(repo);
  // Broad `.lattice/` ignore → the leaf is ignored + untracked = the unsafe state.
  writeFileSync(join(repo, '.gitignore'), '.lattice/\n');
  // The store reads lattice.config.json from the metadataRoot (wrapper); the
  // configured gitRoot subdir + storyDir-inside-gitRoot makes resolveDoctorGitCwd
  // resolve to repo/ (the wrapper-root layout under test).
  writeFileSync(
    join(wrapper, 'lattice.config.json'),
    JSON.stringify({ storyDir: storyDirRel, gitRoot: 'repo' }, null, 2),
  );
  // Story leaf lives inside the gitRoot (lifecycle requirement) but is ignored.
  const storyDir = join(wrapper, storyDirRel, STORY_ID);
  mkdirSync(storyDir, { recursive: true });
  writeFileSync(
    join(storyDir, 'index.json'),
    JSON.stringify(
      {
        storyId: STORY_ID,
        name: 'smoke',
        title: 'smoke',
        description: 'smoke story',
        phase: 'DEV',
        type: 'feature',
        priority: 'low',
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  git(repo, ['add', '.gitignore']);
  git(repo, ['commit', '-m', 'base']);
  return { wrapper, repo };
}

const base = mkdtempSync(join(tmpdir(), 'lattice-metadata-protection-smoke-'));

console.log('story-metadata-protection smoke (B-854c CHK-004)');

try {
  // ── 1. Predicate units (raw stubbed probes — bypass the happy path) ─────────
  check('predicate: tracked leaf → safe (even if ignored)', () => {
    const result = evaluateStoryMetadataProtection({
      metadataLeafPath: LEAF_REL,
      runner: stubRunner({ tracked: true, ignored: true }),
    });
    assert.equal(result.tracked, true);
    assert.equal(result.unsafe, false, 'a tracked leaf is committed = clean-proof = safe');
    assert.equal(result.wouldBeCleaned, false);
  });

  // B-02a6 CHK-003: the INIT-window case. An allowlisted/not-ignored but
  // UNCOMMITTED leaf is removed by a plain `git clean -fd` (untracked + not
  // ignored = exactly its target). The broadened predicate now flags it unsafe.
  check('predicate: allowlisted-but-uncommitted (NOT ignored, untracked) → unsafe (INIT window)', () => {
    const result = evaluateStoryMetadataProtection({
      metadataLeafPath: LEAF_REL,
      runner: stubRunner({ tracked: false, ignored: false }),
    });
    assert.equal(result.unsafe, true, 'allowlisted-but-uncommitted leaf is wiped by a plain `git clean -fd`');
    assert.equal(result.wouldBeCleaned, false, 'wouldBeCleaned (ignored && !tracked) is false here — diagnostic only, no longer gates unsafe');
    assert.match(renderStoryMetadataProtectionWarning(result.leafPath), /lattice doctor --repair/);
    assert.match(renderStoryMetadataProtectionWarning(result.leafPath), /DATA-LOSS/);
  });

  check('predicate: broad-ignore + untracked leaf → unsafe (flagged)', () => {
    const result = evaluateStoryMetadataProtection({
      metadataLeafPath: LEAF_REL,
      runner: stubRunner({ tracked: false, ignored: true }),
    });
    assert.equal(result.unsafe, true, 'ignored + untracked = exactly what git clean removes');
    assert.equal(result.wouldBeCleaned, true);
    assert.match(renderStoryMetadataProtectionWarning(result.leafPath), /lattice doctor --repair/);
    assert.match(renderStoryMetadataProtectionWarning(result.leafPath), /DATA-LOSS/);
  });

  check('predicate: empty leaf path is rejected at the consumer (runtime re-validation)', () => {
    assert.throws(
      () => evaluateStoryMetadataProtection({ metadataLeafPath: '   ', runner: stubRunner({ tracked: true, ignored: false }) }),
      /non-empty/,
      'a blank leaf must never be silently classified as safe',
    );
  });

  // ── 2 + 4. Bootstrap (real dev_start) across the three .gitignore cases ─────
  // (a) non-ignoring .gitignore → metadata tracked (committed to HEAD by the
  //     B-02a6 CHK-002 safe-init commit, simulated here) → no warning.
  //     B-02a6 CHK-003: the broadened predicate (unsafe = !tracked) flags ANY
  //     untracked leaf, so "no warning" now requires the leaf to be genuinely
  //     committed onto HEAD — exactly the production invariant story_create
  //     establishes before dev_start runs.
  check('bootstrap: non-ignoring .gitignore + committed leaf → tracked, no warning', () => {
    const root = join(base, 'boot-noignore');
    initGitRepo(root);
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    writeConfig(root);
    writeStoryIndex(root);
    // Simulate the CHK-002 safe-init commit: the INIT metadata leaf is committed
    // onto HEAD before dev_start (the production path), so it is a tracked,
    // clean-proof object — not an untracked leaf the broadened predicate flags.
    git(root, ['add', '.gitignore', 'lattice.config.json', LEAF_REL]);
    git(root, ['commit', '-m', 'base']);
    const handlers = createWorktreeHandlers({ store: new StoryStore(root), root, scanRoot: root });
    const out = String(handlers.dev_start({ storyId: STORY_ID }));
    // The story branch now tracks the leaf (committed into the scoped tree).
    const branchLs = git(root, ['ls-tree', '-r', '--name-only', `story/${STORY_ID}`]);
    assert.ok(branchLs.split('\n').includes(LEAF_REL), 'leaf must be tracked on the story branch after bootstrap');
    assert.doesNotMatch(out, /DATA-LOSS/, 'a committed (tracked) leaf must not warn');
  });

  // (b) broad `.lattice/` ignore → bootstrap SUCCEEDS + warning present.
  check('bootstrap: broad `.lattice/` ignore → succeeds (force-add) AND warning', () => {
    const root = join(base, 'boot-broad');
    initGitRepo(root);
    writeFileSync(join(root, '.gitignore'), '.lattice/\n');
    writeConfig(root);
    writeStoryIndex(root);
    git(root, ['add', '.gitignore', 'lattice.config.json']);
    git(root, ['commit', '-m', 'base']);
    const handlers = createWorktreeHandlers({ store: new StoryStore(root), root, scanRoot: root });
    // Must NOT throw "The following paths are ignored…": force-add committed it.
    const out = String(handlers.dev_start({ storyId: STORY_ID }));
    const branchLs = git(root, ['ls-tree', '-r', '--name-only', `story/${STORY_ID}`]);
    assert.ok(
      branchLs.split('\n').includes(LEAF_REL),
      'force-add must commit the ignored leaf so it is never silently left untracked (CHK-004 #4)',
    );
    assert.match(out, /DATA-LOSS/, 'broad-ignore repo must surface the loud warning');
    assert.match(out, /lattice doctor --repair/, 'warning must point at the repair command');
  });

  // (c) negation allowlist + committed leaf → succeeds, no warning (no false
  //     positive). B-02a6 CHK-003: with the broadened predicate, "no false
  //     positive" now means a TRACKED leaf is not flagged — the allowlist alone
  //     (trackable but uncommitted) is itself the INIT-window unsafe state. The
  //     committed leaf here is the production invariant (CHK-002 safe-init).
  check('bootstrap: negation allowlist + committed leaf → succeeds, no false-positive warning', () => {
    const root = join(base, 'boot-allowlist');
    initGitRepo(root);
    writeFileSync(join(root, '.gitignore'), `${NEGATION_ALLOWLIST}\n`);
    writeConfig(root);
    writeStoryIndex(root);
    // Commit the leaf onto HEAD (the CHK-002 safe-init invariant) so it is a
    // tracked object; an allowlisted-but-uncommitted leaf is now itself unsafe.
    git(root, ['add', '.gitignore', 'lattice.config.json', LEAF_REL]);
    git(root, ['commit', '-m', 'base']);
    const handlers = createWorktreeHandlers({ store: new StoryStore(root), root, scanRoot: root });
    const out = String(handlers.dev_start({ storyId: STORY_ID }));
    const branchLs = git(root, ['ls-tree', '-r', '--name-only', `story/${STORY_ID}`]);
    assert.ok(branchLs.split('\n').includes(LEAF_REL), 'allowlist leaf is tracked after bootstrap');
    assert.doesNotMatch(out, /DATA-LOSS/, 'a committed (tracked) leaf under an allowlist must NOT warn (no false positive)');
  });

  // (d) B-02a6 CHK-003 INIT-window true positive: an allowlisted/not-ignored but
  //     UNCOMMITTED leaf (the leaf is NOT committed onto HEAD before dev_start,
  //     i.e. the safe-init commit is missing) is removable by a plain
  //     `git clean -fd`. The broadened predicate must surface the loud warning at
  //     the bootstrap layer — this is the exact incident the broadening defends.
  check('bootstrap: allowlist + UNcommitted leaf (INIT window) → DATA-LOSS warning', () => {
    const root = join(base, 'boot-allowlist-uncommitted');
    initGitRepo(root);
    writeFileSync(join(root, '.gitignore'), `${NEGATION_ALLOWLIST}\n`);
    writeConfig(root);
    writeStoryIndex(root);
    // NOTE: the leaf is deliberately NOT committed to HEAD (no safe-init commit),
    // so in the main checkout index it is allowlisted-not-ignored AND untracked —
    // exactly what a plain `git clean -fd` wipes (the B-02a6 INIT window).
    git(root, ['add', '.gitignore', 'lattice.config.json']);
    git(root, ['commit', '-m', 'base']);
    // Fixture invariant (by construction of NEGATION_ALLOWLIST, shared with the
    // case (c) allowlist test): the leaf is re-included = NOT ignored. The
    // difference from (c) is purely that the leaf is left UNCOMMITTED here.
    const handlers = createWorktreeHandlers({ store: new StoryStore(root), root, scanRoot: root });
    const out = String(handlers.dev_start({ storyId: STORY_ID }));
    assert.match(out, /DATA-LOSS/, 'an allowlisted-but-uncommitted leaf (INIT window) must surface the warning');
    assert.match(out, /git clean -fd/, 'the warning must name the plain `git clean -fd` removal path');
  });

  // ── 3. Doctor (real handler) — flag, repair, idempotency, no false positive ─
  check('doctor: broad-ignore-untracked fixture → unsafe + remediation + JSON unsafe', () => {
    const root = join(base, 'doctor-unsafe');
    initGitRepo(root);
    writeFileSync(join(root, '.gitignore'), '.lattice/\n');
    writeConfig(root);
    writeStoryIndex(root);
    git(root, ['add', '.gitignore', 'lattice.config.json']);
    git(root, ['commit', '-m', 'base']);
    // leaf exists on disk but is ignored + never added → the data-loss state.
    const handlers = createDoctorHandlers({ store: new StoryStore(root), root, scanRoot: root });
    const json = handlers.doctor({ format: 'json' }) as Record<string, any>;
    const block = json.storyMetadataProtection;
    assert.equal(block.evaluated, true);
    assert.equal(block.unsafe, true, 'doctor JSON must flag the unsafe leaf');
    assert.equal(block.needsRepair, true);
    const text = String(handlers.doctor({ format: 'text' }));
    assert.match(text, /✗ story metadata is NOT git-tracked \(uncommitted\) and is clean-prone/);
    assert.match(text, /ignored\+untracked → removed by `git clean -fdx`/);
    assert.match(text, /lattice doctor --repair/);
  });

  // B-02a6 CHK-003: doctor must surface the INIT-window case (allowlisted/NOT
  // ignored + UNCOMMITTED), not only the ignored case, and must NOT false-positive
  // a correctly committed (tracked) leaf.
  check('doctor: allowlisted-but-uncommitted leaf (INIT window) → unsafe + INIT-window risk line; committed → safe', () => {
    const root = join(base, 'doctor-init-window');
    initGitRepo(root);
    writeFileSync(join(root, '.gitignore'), `${NEGATION_ALLOWLIST}\n`);
    writeConfig(root);
    writeStoryIndex(root);
    // Commit only the config/.gitignore — the leaf is allowlisted (NOT ignored)
    // but left UNCOMMITTED = the B-02a6 INIT window a plain `git clean -fd` wipes.
    git(root, ['add', '.gitignore', 'lattice.config.json']);
    git(root, ['commit', '-m', 'base']);
    const handlers = createDoctorHandlers({ store: new StoryStore(root), root, scanRoot: root });

    const json = handlers.doctor({ format: 'json' }) as Record<string, any>;
    const block = json.storyMetadataProtection;
    assert.equal(block.evaluated, true);
    assert.equal(block.unsafe, true, 'doctor must flag the allowlisted-but-uncommitted INIT-window leaf');
    // The per-leaf scan records ignored=false (re-included) + tracked=false.
    const leaf = block.unsafeLeaves.find((l: any) => l.storyId === STORY_ID);
    assert.ok(leaf, 'the INIT-window leaf must appear in unsafeLeaves');
    assert.equal(leaf.ignored, false, 'INIT-window leaf is allowlisted = NOT ignored');
    assert.equal(leaf.tracked, false, 'INIT-window leaf is uncommitted = untracked');
    const text = String(handlers.doctor({ format: 'text' }));
    assert.match(text, /✗ story metadata is NOT git-tracked \(uncommitted\) and is clean-prone/);
    assert.match(
      text,
      /allowlisted-but-uncommitted \(INIT window\) → removed by a plain `git clean -fd`/,
      'the INIT-window risk line must name the plain `git clean -fd` removal path',
    );

    // Committing the now-trackable leaf clears the flag (no false positive on a
    // correctly committed leaf).
    git(root, ['add', LEAF_REL]);
    git(root, ['commit', '-m', 'track story metadata']);
    const after = handlers.doctor({ format: 'json' }) as Record<string, any>;
    assert.equal(after.storyMetadataProtection.unsafe, false, 'a committed (tracked) leaf must NOT be flagged');
  });

  check('doctor: --repair writes allowlist; leaf safe only AFTER commit; second --repair no-op', () => {
    const root = join(base, 'doctor-repair');
    initGitRepo(root);
    writeFileSync(join(root, '.gitignore'), '.lattice/\n');
    writeConfig(root);
    writeStoryIndex(root);
    git(root, ['add', '.gitignore', 'lattice.config.json']);
    git(root, ['commit', '-m', 'base']);
    const handlers = createDoctorHandlers({ store: new StoryStore(root), root, scanRoot: root });

    // First --repair: installs the managed allowlist (changes .gitignore).
    const repair1 = handlers.doctor({ format: 'json', repair: true }) as Record<string, any>;
    assert.equal(repair1.storyMetadataProtection.repairWrote, true, 'first --repair must install the allowlist');
    const gitignoreAfter = readFileSync(join(root, '.gitignore'), 'utf-8');
    assert.match(gitignoreAfter, /lattice runtime artifacts \(managed\)/, 'managed block markers present');
    assert.ok(gitignoreAfter.includes('!.lattice/story/actives/**'), 'negation allowlist installed');
    // B-02a6 CHK-003: after repair the leaf is no longer IGNORED, but it is still
    // UNCOMMITTED (untracked) → it is now precisely the INIT-window unsafe state
    // (allowlisted-not-ignored + untracked, removable by a plain `git clean -fd`).
    // The broadened predicate correctly keeps it unsafe: installing the allowlist
    // alone does NOT make an uncommitted leaf clean-proof.
    assert.equal(
      repair1.storyMetadataProtection.unsafe,
      true,
      'after --repair the (now allowlisted) leaf is still UNCOMMITTED = INIT-window unsafe',
    );

    // The operator follows the repair guidance ("→ git add + commit story
    // metadata"): committing the now-trackable leaf makes it clean-proof.
    git(root, ['add', LEAF_REL]);
    git(root, ['commit', '-m', 'track story metadata']);
    const afterCommit = handlers.doctor({ format: 'json' }) as Record<string, any>;
    assert.equal(
      afterCommit.storyMetadataProtection.unsafe,
      false,
      're-scan after committing the leaf must be safe (tracked = clean-proof)',
    );

    // Second --repair: no-op (merge finds nothing missing).
    const repair2 = handlers.doctor({ format: 'json', repair: true }) as Record<string, any>;
    assert.equal(repair2.storyMetadataProtection.repairWrote, false, 'second --repair must be a no-op');
    assert.equal(
      readFileSync(join(root, '.gitignore'), 'utf-8'),
      gitignoreAfter,
      '.gitignore must be byte-for-byte unchanged on the second --repair',
    );
  });

  // ── B-0740 CHK-001: WRAPPER-ROOT --repair (metadataRoot != gitRoot) ─────────
  // Before the fix repairStoryMetadataAllowlist ran the git probe in cwd=root
  // (the non-git wrapper) → `fatal: not a git repository` → wrote:false, the
  // protective allowlist was never installed on exactly the layout it protects.
  check('doctor: WRAPPER-ROOT --repair installs allowlist (wrote:true, no fatal) → re-scan safe', () => {
    const { wrapper, repo } = buildWrapperRootFixture(join(base, 'doctor-repair-wrapper'));
    const handlers = createDoctorHandlers({ store: new StoryStore(wrapper), root: wrapper, scanRoot: wrapper });

    // Capture live stdout/stderr too: a leaked `fatal:` line came from the
    // unpiped git probe inheriting the parent stderr, not the return value.
    const chunks: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr.write as any) = (buf: any): boolean => {
      chunks.push(typeof buf === 'string' ? buf : String(buf));
      return true;
    };
    let repair1: Record<string, any>;
    try {
      repair1 = handlers.doctor({ format: 'json', repair: true }) as Record<string, any>;
    } finally {
      (process.stderr.write as any) = origErr;
    }
    const block1 = repair1.storyMetadataProtection;
    assert.equal(block1.evaluated, true, 'wrapper-root: scan must evaluate (probe runs in gitRoot)');
    assert.equal(block1.repairRequested, true, 'wrapper-root: --repair requested');
    assert.equal(
      block1.repairWrote,
      true,
      'wrapper-root: --repair MUST install the allowlist (the prior wrote:false failure is gone)',
    );
    assert.equal(block1.repairError, null, 'wrapper-root: repair must not error (no fatal: not a git repository)');
    assert.doesNotMatch(
      chunks.join(''),
      /fatal: not a git repository/i,
      'wrapper-root: the git probe must NOT leak "fatal: not a git repository"',
    );
    // The allowlist landed in the GITROOT's .gitignore, not the wrapper's.
    const gitignoreAfter = readFileSync(join(repo, '.gitignore'), 'utf-8');
    assert.match(gitignoreAfter, /lattice runtime artifacts \(managed\)/, 'managed block markers present in gitRoot/.gitignore');
    assert.ok(gitignoreAfter.includes('!.lattice/story/actives/**'), 'negation allowlist installed in gitRoot/.gitignore');
    // B-02a6 CHK-003: same as the non-wrapper case — after repair the leaf is no
    // longer ignored but is still UNCOMMITTED (untracked) = INIT-window unsafe.
    assert.equal(block1.unsafe, true, 'wrapper-root: after --repair the uncommitted leaf is still unsafe (INIT window)');
    // Commit the now-trackable leaf in the gitRoot → clean-proof → safe.
    git(repo, ['add', LEAF_REL]);
    git(repo, ['commit', '-m', 'track story metadata']);
    const afterCommit = handlers.doctor({ format: 'json' }) as Record<string, any>;
    assert.equal(afterCommit.storyMetadataProtection.unsafe, false, 'wrapper-root: re-scan after committing the leaf must be safe');
  });

  check('doctor: WRAPPER-ROOT second --repair is a no-op (wrote:false, .gitignore byte-identical)', () => {
    const { wrapper, repo } = buildWrapperRootFixture(join(base, 'doctor-repair-wrapper-noop'));
    const handlers = createDoctorHandlers({ store: new StoryStore(wrapper), root: wrapper, scanRoot: wrapper });

    const repair1 = handlers.doctor({ format: 'json', repair: true }) as Record<string, any>;
    assert.equal(repair1.storyMetadataProtection.repairWrote, true, 'first wrapper-root --repair installs the allowlist');
    const gitignoreAfter = readFileSync(join(repo, '.gitignore'), 'utf-8');

    const repair2 = handlers.doctor({ format: 'json', repair: true }) as Record<string, any>;
    assert.equal(repair2.storyMetadataProtection.repairWrote, false, 'second wrapper-root --repair must be a no-op');
    assert.equal(repair2.storyMetadataProtection.repairError, null, 'second wrapper-root --repair must not error');
    assert.equal(
      readFileSync(join(repo, '.gitignore'), 'utf-8'),
      gitignoreAfter,
      'gitRoot/.gitignore must be byte-for-byte unchanged on the second wrapper-root --repair',
    );
  });

  check('doctor: safe project (negation allowlist) → no false positive', () => {
    const root = join(base, 'doctor-safe');
    initGitRepo(root);
    writeFileSync(join(root, '.gitignore'), `${NEGATION_ALLOWLIST}\n`);
    writeConfig(root);
    writeStoryIndex(root);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']); // leaf is tracked here
    const handlers = createDoctorHandlers({ store: new StoryStore(root), root, scanRoot: root });
    const json = handlers.doctor({ format: 'json' }) as Record<string, any>;
    assert.equal(json.storyMetadataProtection.unsafe, false, 'a tracked + allowlisted project must not be flagged');
    const text = String(handlers.doctor({ format: 'text' }));
    assert.match(text, /✓ story metadata is tracked or protected/);
    assert.doesNotMatch(text, /✗ story metadata is NOT git-tracked/);
  });

  console.log(`\n✓ story-metadata-protection smoke passed (${passed} checks)`);
} finally {
  rmSync(base, { recursive: true, force: true });
}
