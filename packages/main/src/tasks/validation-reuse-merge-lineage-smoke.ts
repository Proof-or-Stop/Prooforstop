#!/usr/bin/env node
// Guards the merge-lineage classifier fix (B-f00c): a main-merge that re-introduces
// the story's own content-unchanged files must NOT force a validation re-run, while a
// genuinely content-changed non-metadata file still must. Exercises BOTH classifier
// copies (reuse + admissibility) through the shared net-diff classifier.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyMergeLineage, netDiffChangedPaths } from '../core/validation-lineage.js';
import { classifyTrustedValidationLineage } from '../core/validation-evidence-reuse.js';
import { evaluateValidationEvidenceAdmissibility } from '../core/validation-evidence-admissibility.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
  mkdirSync(join(root, '.lattice/story/actives/B-x'), { recursive: true });
  writeFileSync(join(root, '.lattice/story/actives/B-x/meta.json'), '{}\n');
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
  } finally { rmSync(root, { recursive: true, force: true }); }
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
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// 3) exact-head fast path.
{
  const { root, H2 } = buildMergeRepo({ genuineChange: false });
  try {
    assert.deepEqual(classifyMergeLineage({ evidenceHead: H2, currentHead: H2, gitCwd: root, metadataRoot: root }), { kind: 'exact-head' });
  } finally { rmSync(root, { recursive: true, force: true }); }
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
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// 5) Large diff (>1500 changed metadata paths) does not throw ENOBUFS and stays trusted.
{
  const root = mkdtempSync(join(tmpdir(), 'merge-lineage-large-'));
  try {
    git(root, ['init', '-q']); git(root, ['config', 'user.email', 't@t']); git(root, ['config', 'user.name', 't']); git(root, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(root, 'seed'), 'x\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'seed']);
    const H1 = git(root, ['rev-parse', 'HEAD']);
    mkdirSync(join(root, '.lattice/story/actives/B-big'), { recursive: true });
    for (let i = 0; i < 1500; i++) writeFileSync(join(root, `.lattice/story/actives/B-big/f${i}-${'p'.repeat(40)}.json`), `{"i":${i}}\n`);
    git(root, ['add', '.']); git(root, ['commit', '-qm', 'many metadata files']);
    const H2 = git(root, ['rev-parse', 'HEAD']);
    const changed = netDiffChangedPaths(H1, H2, root);
    assert.equal(changed.length >= 1500, true, `large net diff returns all paths (got ${changed.length})`);
    assert.deepEqual(classifyMergeLineage({ evidenceHead: H1, currentHead: H2, gitCwd: root, metadataRoot: root }), { kind: 'trusted-descendant' }, 'large metadata-only diff is trusted');
  } finally { rmSync(root, { recursive: true, force: true }); }
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
  } finally { rmSync(root, { recursive: true, force: true }); }
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
  } finally { rmSync(root, { recursive: true, force: true }); }
}

process.stdout.write('validation reuse merge-lineage smoke passed\n');
