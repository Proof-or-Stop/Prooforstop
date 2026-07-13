#!/usr/bin/env node

/**
 * B-1637 smoke: doctor's git probes resolve the gitRoot (no fatal noise on
 * wrapper-root projects; plain repos unchanged).
 *
 * BUG: `lattice doctor` ran every git probe with cwd=root (the metadataRoot).
 * On a WRAPPER-ROOT project (metadataRoot != gitRoot — e.g. ClawCreek with a
 * non-git wrapper root and a configured gitRoot subdir) the metadataRoot is NOT
 * a git repo, so the probe discovery calls (`git rev-parse --show-toplevel` /
 * `git ls-files`) emitted `fatal: not a git repository`. Every probe is wrapped
 * in try/catch (graceful degradation) so it was cosmetic stderr noise only — but
 * the two `execSync` discovery sites (orphan-worktree scan + story-metadata
 * protection scan) did not pipe stderr, leaking two leading fatal lines onto an
 * otherwise healthy report.
 *
 * FIX (CHK-001): resolve the gitRoot ONCE via the id-independent, total
 * project-level resolver
 *   evaluateStoryDirConfigInsideGitRoot({ metadataRoot: root }).gitRootAbs ?? root
 * (exposed as resolveDoctorGitCwd) and thread it as the cwd into the probe
 * functions; pipe stderr on the discovery calls so a caught failure no longer
 * leaks a fatal line; fall back to root when no gitRoot resolves → byte-identical
 * for plain repos.
 *
 * This smoke (CHK-002) asserts, on the same fixture shapes the real handler runs:
 *   1. RESOLVER unit (resolveDoctorGitCwd):
 *        wrapper-root → the configured gitRoot subdir (≠ non-git metadataRoot);
 *        plain repo   → projectRoot (byte-identical fallback);
 *        no-git/no-config → projectRoot verbatim (gitRootAbs null → ?? root).
 *   2. END-TO-END: the real doctor() handler on a WRAPPER-ROOT fixture prints
 *      NO `fatal: not a git repository` to stdout OR stderr (the user-visible
 *      symptom), while still producing its report.
 *   3. END-TO-END: the real doctor() handler on a PLAIN-REPO fixture runs
 *      unchanged (no fatal output, report produced).
 *
 * Prints ✓/✗; exits non-zero on first failure.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StoryStore } from '../core/store.js';
import { createDoctorHandlers, resolveDoctorGitCwd } from '../handlers/doctor.js';
import { evaluateStoryDirConfigInsideGitRoot } from '../core/story-signed-workspace-resolution.js';

// B-623a: keep this smoke hermetic and fast — doctor now runs an advisory host
// burn scan over the real ~/.codex / ~/.claude stores by default; 0 disables it.
process.env.LATTICE_BURN_ALERT_RECENT_HOURS = '0';

const FATAL_RE = /fatal: not a git repository/i;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'smoke@test.local']);
  git(dir, ['config', 'user.name', 'smoke']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

/**
 * lattice.config.json. `storyDir` is given relative to the metadataRoot; a
 * configured `gitRoot` subdir is written when provided (wrapper-root layout).
 */
function writeConfig(metadataRoot: string, opts: { storyDir: string; gitRoot?: string }): void {
  const cfg: Record<string, unknown> = { storyDir: opts.storyDir };
  if (opts.gitRoot !== undefined) cfg.gitRoot = opts.gitRoot;
  writeFileSync(join(metadataRoot, 'lattice.config.json'), JSON.stringify(cfg, null, 2));
}

/** Write a minimal active-story index.json under <root>/<storyDirRel>/<id>. */
function writeStoryIndex(root: string, storyDirRel: string, storyId: string, phase = 'DEV'): void {
  const storyDir = join(root, storyDirRel, storyId);
  mkdirSync(storyDir, { recursive: true });
  writeFileSync(
    join(storyDir, 'index.json'),
    JSON.stringify(
      {
        storyId,
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

/**
 * Run the real doctor() handler capturing EVERYTHING it might print. The leaked
 * fatal lines came from inherited git stderr (process.stderr) on the unpiped
 * execSync discovery calls — not from the returned string — so we must capture
 * the live stdout/stderr streams, not just the handler return value.
 */
async function runDoctorCapture(root: string): Promise<{ text: string; ret: string }> {
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const capture = (buf: any): boolean => {
    chunks.push(typeof buf === 'string' ? buf : String(buf));
    return true;
  };
  (process.stdout.write as any) = capture;
  (process.stderr.write as any) = capture;
  let ret = '';
  try {
    const handlers = createDoctorHandlers({ store: new StoryStore(root), root, scanRoot: root });
    const out = await handlers.doctor({ format: 'text' });
    ret = typeof out === 'string' ? out : JSON.stringify(out);
  } finally {
    (process.stdout.write as any) = origOut;
    (process.stderr.write as any) = origErr;
  }
  // Include the handler's own returned report text too: even if doctor printed
  // nothing to the live streams, a fatal line must never reach the user via the
  // returned string either.
  return { text: chunks.join('') + '\n' + ret, ret };
}

function pass(msg: string): void {
  console.log(`✓ ${msg}`);
}

const base = mkdtempSync(join(tmpdir(), 'doctor-gitroot-probe-smoke-'));

console.log('doctor-gitroot-probe smoke (B-1637)');

try {
  // ── 1a. RESOLVER unit — WRAPPER-ROOT ────────────────────────────────────────
  // metadataRoot (wrapper) is NOT git; configured gitRoot subdir IS git.
  // resolveDoctorGitCwd must resolve to the gitRoot subdir, not the metadataRoot.
  const wrapper = join(base, 'wrapper');
  const wrapperGit = join(wrapper, 'repo');
  {
    mkdirSync(wrapper, { recursive: true });
    initGitRepo(wrapperGit);
    writeFileSync(join(wrapperGit, 'seed.txt'), 'seed\n');
    git(wrapperGit, ['add', 'seed.txt']);
    git(wrapperGit, ['commit', '-m', 'initial']);
    // storyDir lives INSIDE the gitRoot (lifecycle requirement); gitRoot=subdir.
    writeConfig(wrapper, { storyDir: 'repo/.lattice/story/actives', gitRoot: 'repo' });
    writeStoryIndex(wrapper, 'repo/.lattice/story/actives', 'B-wrap');

    const resolved = realpathSync(resolveDoctorGitCwd(wrapper));
    assert.equal(
      resolved,
      realpathSync(wrapperGit),
      'wrapper-root: resolveDoctorGitCwd must resolve to the configured gitRoot subdir',
    );
    assert.notEqual(
      resolved,
      realpathSync(wrapper),
      'wrapper-root: resolveDoctorGitCwd must NOT be the non-git metadataRoot (the bug)',
    );
    assert.equal(
      git(resolved, ['rev-parse', '--is-inside-work-tree']),
      'true',
      'wrapper-root: resolved probe cwd is a real git work tree (no "Not a git repository")',
    );
  }
  pass('resolver: wrapper-root → configured gitRoot subdir (≠ non-git metadataRoot), is a git repo');

  // ── 1b. RESOLVER unit — PLAIN-REPO ──────────────────────────────────────────
  // metadataRoot == gitRoot; no configured gitRoot subdir → byte-identical
  // fallback: the resolved cwd canonically equals projectRoot.
  const plain = join(base, 'plain');
  {
    initGitRepo(plain);
    writeFileSync(join(plain, 'seed.txt'), 'seed\n');
    git(plain, ['add', 'seed.txt']);
    git(plain, ['commit', '-m', 'initial']);
    writeConfig(plain, { storyDir: '.lattice/story/actives' });
    writeStoryIndex(plain, '.lattice/story/actives', 'B-plain');

    assert.equal(
      realpathSync(resolveDoctorGitCwd(plain)),
      realpathSync(plain),
      'plain-repo: resolveDoctorGitCwd resolves to projectRoot (byte-identical fallback)',
    );
  }
  pass('resolver: plain-repo → projectRoot (byte-identical to old cwd=root fallback)');

  // ── 1c. RESOLVER unit — NO-GIT / NO-CONFIG → ?? root verbatim ───────────────
  {
    const noGit = join(base, 'no-git');
    mkdirSync(noGit, { recursive: true });
    writeConfig(noGit, { storyDir: '.lattice/story/actives' });

    assert.equal(
      evaluateStoryDirConfigInsideGitRoot({ metadataRoot: noGit }).gitRootAbs,
      null,
      'no-git/no-config: resolver gitRootAbs must be null (unresolved gitRoot)',
    );
    assert.equal(
      resolveDoctorGitCwd(noGit),
      noGit,
      'null gitRootAbs: resolveDoctorGitCwd falls back to root verbatim',
    );
  }
  pass('resolver: null gitRootAbs → ?? root falls back to root verbatim');

  // ── 2. END-TO-END — WRAPPER-ROOT doctor() emits NO fatal line ───────────────
  // The pre-fix symptom: two leading `fatal: not a git repository` lines from
  // the unpiped execSync discovery calls running in the non-git wrapper.
  {
    const { text } = await runDoctorCapture(wrapper);
    assert.ok(
      !FATAL_RE.test(text),
      `wrapper-root: doctor() must NOT print "fatal: not a git repository" anywhere.\n--- captured ---\n${text}\n----------------`,
    );
    // Sanity: the handler still produced a (non-empty) report.
    assert.ok(text.trim().length > 0, 'wrapper-root: doctor() still produces a report');
  }
  pass('e2e: wrapper-root doctor() → NO "fatal: not a git repository" (report still produced)');

  // ── 3. END-TO-END — PLAIN-REPO doctor() unchanged (no fatal, report ok) ──────
  {
    const { text } = await runDoctorCapture(plain);
    assert.ok(
      !FATAL_RE.test(text),
      `plain-repo: doctor() must NOT print "fatal: not a git repository".\n--- captured ---\n${text}\n----------------`,
    );
    assert.ok(text.trim().length > 0, 'plain-repo: doctor() still produces a report');
  }
  pass('e2e: plain-repo doctor() → unchanged (no fatal output, report produced)');

  console.log('\n✓ doctor-gitroot-probe smoke passed (resolver + wrapper-root e2e + plain-repo e2e)');
} catch (err) {
  console.error('\n✗ doctor-gitroot-probe smoke FAILED');
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  rmSync(base, { recursive: true, force: true });
  process.exit(1);
}

rmSync(base, { recursive: true, force: true });
