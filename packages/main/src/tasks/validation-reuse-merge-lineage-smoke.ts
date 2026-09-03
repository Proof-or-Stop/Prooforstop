#!/usr/bin/env node
// Guards the merge-lineage classifier fix (B-f00c): a main-merge that re-introduces
// the story's own content-unchanged files must NOT force a validation re-run, while a
// genuinely content-changed non-metadata file still must. Exercises BOTH classifier
// copies (reuse + admissibility) through the shared net-diff classifier.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

// B-cc10: these fixtures cleaned up with recursive+force but NO retries, so when the full
// validate suite runs them alongside other temp-dir work the teardown lost a race and threw
// ENOTEMPTY — the smoke passes standalone and failed only in-suite. maxRetries is Node's
// supported answer for exactly this; it does not weaken any assertion.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyMergeLineage, netDiffChangedPaths } from '../core/validation-lineage.js';
import { classifyTrustedValidationLineage } from '../core/validation-evidence-reuse.js';
import { evaluateValidationEvidenceAdmissibility } from '../core/validation-evidence-admissibility.js';

// B-3f3d/B-49ed: rmSync with force:true still throws ENOTEMPTY here on macOS when the tree is
// a git repo -- the platform has not released every entry by the time the recursive unlink
// walks it, so a fresh scratch dir fails on its own cleanup rather than on leftover residue.
// maxRetries makes Node re-attempt with a backoff instead of failing the whole smoke, which
// was blocking command 20 of 103 in validate and therefore every REVIEW to TEST on this branch.
function rmScratch(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}


function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function rmForce(root: string): void {
  rmScratch(root);
}

/**
 * Retries on ENOBUFS only: a machine under heavy concurrent-process load can hit
 * transient kernel pipe/mbuf exhaustion independent of Node's own maxBuffer size
 * check (B-f00c:F-005 — observed ~16% flake rate when several large buffered
 * execFileSync calls run back-to-back on a loaded host). Any other error, or the
 * final attempt, rethrows immediately.
 */
function withEnobufsRetry<T>(fn: () => T, attempts = 3): T {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === attempts || !/ENOBUFS/i.test(message)) throw error;
      const until = Date.now() + 150 * attempt;
      while (Date.now() < until) { /* brief synchronous backoff for transient OS resource pressure */ }
    }
  }
  throw new Error('unreachable');
}

/** Reference implementation of the OLD per-commit `-m` union (pre-fix behavior). */
function perCommitUnionChanged(root: string, evidenceHead: string, currentHead: string): string[] {
  const commits = git(root, ['rev-list', '--reverse', `${evidenceHead}..${currentHead}`]).split('\n').map(s => s.trim()).filter(Boolean);
  return [...new Set(commits.flatMap(commit => git(root,
    ['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-m', commit],
  ).split('\n').map(s => s.trim()).filter(Boolean)))];
}

/**
 * Build a repo: base -> foo.ts(H1) -> main advances (metadata only, or a genuine
 * material change) -> merge main into story (H2). foo.ts is byte-identical at H1/H2.
 */
function buildMergeRepo(opts: { genuineChange: boolean }): { root: string; H1: string; H2: string } {
  const root = mkdtempSync(join(tmpdir(), 'merge-lineage-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 't@t']); git(root, ['config', 'user.name', 't']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'README.md'), 'base\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'base']);
  const story = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  git(root, ['branch', 'mainx']);
  writeFileSync(join(root, 'foo.ts'), 'export const x = 1;\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'story: foo.ts']);
  const H1 = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '-q', 'mainx']);
  mkdirSync(join(root, '.proof-or-stop/story/actives/B-x'), { recursive: true });
  writeFileSync(join(root, '.proof-or-stop/story/actives/B-x/meta.json'), '{}\n');
  if (opts.genuineChange) writeFileSync(join(root, 'shared.ts'), 'export const y = 2;\n'); // non-metadata file landing on main
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'main: advance']);
  git(root, ['checkout', '-q', story]);
  git(root, ['merge', '--no-ff', '-q', 'mainx', '-m', 'Merge mainx into story']);
  const H2 = git(root, ['rev-parse', 'HEAD']);
  return { root, H1, H2 };
}

function admissibilityLineage(root: string, evidenceHead: string): string {
  // Only the lineage field is asserted; other admissibility factors are irrelevant here.
  const evidence = { result: 'PASS', headHash: evidenceHead, materialHash: 'm', storyFilesHash: 's' } as never;
  const result = evaluateValidationEvidenceAdmissibility({
    evidence,
    expectedCommand: 'x',
    gitCwd: root,
    metadataRoot: root,
  } as never);
  return (result as { lineage: string }).lineage;
}

// 1) Merge re-introduces a content-unchanged story file -> BOTH copies trust it (GREEN).
{
  const { root, H1, H2 } = buildMergeRepo({ genuineChange: false });
  try {
    assert.equal(git(root, ['diff', '--name-only', H1, H2]).split('\n').includes('foo.ts'), false, 'foo.ts must be net-unchanged H1->H2');
    // shared classifier
    assert.deepEqual(classifyMergeLineage({ evidenceHead: H1, currentHead: H2, gitCwd: root, metadataRoot: root }), { kind: 'trusted-descendant' }, 'merge of unchanged file is trusted-descendant');
    // reuse copy
    assert.equal(classifyTrustedValidationLineage({ root, gitCwd: root, evidenceHead: H1, currentHead: H2 }).lineage, 'trusted-story-metadata-descendant', 'reuse copy trusts merge of unchanged file');
    // admissibility copy (same shared classifier)
    assert.equal(admissibilityLineage(root, H1), 'trusted-story-metadata-descendant', 'admissibility copy trusts merge of unchanged file');
    // Mutation resistance / RED: the OLD per-commit -m union DID list foo.ts as changed.
    assert.equal(perCommitUnionChanged(root, H1, H2).includes('foo.ts'), true, 'the reverted per-commit -m union would (wrongly) flag foo.ts — proves the fix changed behavior');
  } finally { rmForce(root); }
}

// 2) NEGATIVE: a genuine non-metadata content change lands on main -> BOTH copies refuse.
{
  const { root, H1, H2 } = buildMergeRepo({ genuineChange: true });
  try {
    assert.equal(git(root, ['diff', '--name-only', H1, H2]).split('\n').includes('shared.ts'), true, 'shared.ts genuinely changed H1->H2');
    const c = classifyMergeLineage({ evidenceHead: H1, currentHead: H2, gitCwd: root, metadataRoot: root });
    assert.equal(c.kind, 'untrusted', 'genuine content change is untrusted');
    assert.equal(c.kind === 'untrusted' && c.untrustedPaths.includes('shared.ts'), true, 'untrusted lists the genuinely-changed path');
    assert.equal(classifyTrustedValidationLineage({ root, gitCwd: root, evidenceHead: H1, currentHead: H2 }).lineage, 'rejected', 'reuse copy refuses genuine change');
    assert.equal(admissibilityLineage(root, H1), 'rejected', 'admissibility copy refuses genuine change');
  } finally { rmForce(root); }
}

// 3) exact-head fast path.
{
  const { root, H2 } = buildMergeRepo({ genuineChange: false });
  try {
    assert.deepEqual(classifyMergeLineage({ evidenceHead: H2, currentHead: H2, gitCwd: root, metadataRoot: root }), { kind: 'exact-head' });
  } finally { rmForce(root); }
}

// 4) Empty net diff between two DISTINCT commits (a no-op merge commit) -> trusted.
{
  const root = mkdtempSync(join(tmpdir(), 'merge-lineage-empty-'));
  try {
    git(root, ['init', '-q']); git(root, ['config', 'user.email', 't@t']); git(root, ['config', 'user.name', 't']); git(root, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(root, 'a.txt'), 'a\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'base']);
    const story = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const H1 = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-qb', 'sidebranch']);
    writeFileSync(join(root, 'a.txt'), 'b\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'side change']);
    writeFileSync(join(root, 'a.txt'), 'a\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'revert bytes']);
    git(root, ['checkout', '-q', story]);
    git(root, ['merge', '--no-ff', '-q', 'sidebranch', '-m', 'merge reverted branch']);
    const H2 = git(root, ['rev-parse', 'HEAD']);
    assert.notEqual(H1, H2, 'distinct heads');
    assert.deepEqual(netDiffChangedPaths(H1, H2, root), [], 'net diff empty for byte-identical endpoints');
    assert.deepEqual(classifyMergeLineage({ evidenceHead: H1, currentHead: H2, gitCwd: root, metadataRoot: root }), { kind: 'trusted-descendant' }, 'empty net diff is trusted, not rejected');
  } finally { rmForce(root); }
}

// 5) Large diff output actually EXCEEDS Node's default 1 MiB child_process maxBuffer, and
//    classifyMergeLineage/netDiffChangedPaths (which use GIT_LINEAGE_MAXBUFFER=1GiB) still
//    succeed instead of throwing ENOBUFS. This block must be self-verifying: it first proves
//    the SAME raw `git diff-tree` call throws when run WITHOUT the override (Node's default),
//    so the fixture is provably large enough to exercise the fix. (B-f00c:F-004 — the prior
//    1500-file fixture only produced ~118KB, far under the 1 MiB default, so the old version
//    of this assertion never actually exercised GIT_LINEAGE_MAXBUFFER at all: it would have
//    passed identically even if that constant were reverted or removed.)
{
  const root = mkdtempSync(join(tmpdir(), 'merge-lineage-large-'));
  try {
    git(root, ['init', '-q']); git(root, ['config', 'user.email', 't@t']); git(root, ['config', 'user.name', 't']); git(root, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(root, 'seed'), 'x\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'seed']);
    const H1 = git(root, ['rev-parse', 'HEAD']);
    // 8000 files x ~230-byte padded names ~= 1.8 MiB of raw diff-tree output (measured),
    // comfortably past Node's 1 MiB default, while staying fast to create (~1s vs ~18s at
    // 25k tiny files) — file COUNT dominates wall time far more than per-file byte size.
    const FILE_COUNT = 8_000;
    mkdirSync(join(root, '.proof-or-stop/story/actives/B-big'), { recursive: true });
    for (let i = 0; i < FILE_COUNT; i++) writeFileSync(join(root, `.proof-or-stop/story/actives/B-big/f${i}-${'p'.repeat(220)}.json`), `{"i":${i}}\n`);
    git(root, ['add', '.']); git(root, ['commit', '-qm', 'many metadata files']);
    const H2 = git(root, ['rev-parse', 'HEAD']);

    const rawArgs = ['diff-tree', '-r', '--no-commit-id', '--name-only', '--no-renames', '-z', H1, H2];
    // Node's child_process default maxBuffer is 1 MiB. Calling the SAME diff-tree command
    // with no override must throw, proving the fixture's raw output genuinely exceeds it.
    // This is the ONLY spawn without the override, so it also doubles as the size proof —
    // no separate measurement spawn is needed (fewer large back-to-back spawns = less
    // exposure to the transient-ENOBUFS flake this block used to cause, B-f00c:F-005).
    assert.throws(
      () => execFileSync('git', rawArgs, { cwd: root, encoding: 'utf8' }),
      /maxBuffer|ENOBUFS/i,
      `fixture must exceed Node's default 1 MiB maxBuffer to be a discriminating test for GIT_LINEAGE_MAXBUFFER (increase FILE_COUNT if this stops throwing)`,
    );

    // Single real (override-buffered) spawn for this block, wrapped against transient
    // OS-level ENOBUFS. classifyMergeLineage below reuses this result via its injectable
    // changedPathsFn instead of re-spawning git a second time — its default git-calling
    // path is already covered by the small-diff blocks above/below.
    const changed = withEnobufsRetry(() => netDiffChangedPaths(H1, H2, root));
    assert.equal(changed.length >= FILE_COUNT, true, `large net diff returns all paths (got ${changed.length})`);
    assert.deepEqual(
      classifyMergeLineage({ evidenceHead: H1, currentHead: H2, gitCwd: root, metadataRoot: root }, () => changed),
      { kind: 'trusted-descendant' },
      'large metadata-only diff (>1 MiB raw output) is trusted, not ENOBUFS',
    );
  } finally { rmForce(root); }
}

// 6) not-ancestor fails closed.
{
  const root = mkdtempSync(join(tmpdir(), 'merge-lineage-unrel-'));
  try {
    git(root, ['init', '-q']); git(root, ['config', 'user.email', 't@t']); git(root, ['config', 'user.name', 't']); git(root, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(root, 'a'), '1\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'c1']);
    const A = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-q', '--orphan', 'orphanx']);
    writeFileSync(join(root, 'b'), '2\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'c2']);
    const B = git(root, ['rev-parse', 'HEAD']);
    assert.equal(classifyMergeLineage({ evidenceHead: A, currentHead: B, gitCwd: root, metadataRoot: root }).kind, 'not-ancestor', 'unrelated history is not-ancestor (fail-closed)');
  } finally { rmForce(root); }
}

// 7) diff-failed is DISTINCT from not-ancestor: with ancestry OK, a throwing diff
//    surfaces {kind:'diff-failed'} (split-catch guarantee), not not-ancestor.
{
  const { root, H1, H2 } = buildMergeRepo({ genuineChange: false });
  try {
    const classified = classifyMergeLineage(
      { evidenceHead: H1, currentHead: H2, gitCwd: root, metadataRoot: root },
      () => { throw new Error('simulated diff failure'); },
    );
    assert.equal(classified.kind, 'diff-failed', 'ancestry-OK diff throw is diff-failed, not not-ancestor');
    assert.equal(classified.kind === 'diff-failed' && classified.error.includes('simulated diff failure'), true, 'diff-failed carries the underlying error');
  } finally { rmForce(root); }
}

process.stdout.write('validation reuse merge-lineage smoke passed\n');
