import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { verificationFailureMessage } from './verification-subprocess-budget.mjs';

const root = resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const frozen = git('cat-file', 'blob', '4b874492711d5b53d4f75de7116d1a8019703217');
const previousCommit = 'a8768173bc7488aa8fdc3ef45f1ed295cbd924c8';
const previous = git('show', `${previousCommit}:CHANGELOG.md`);
const current = readFileSync(resolve(root, 'CHANGELOG.md'));
const header = Buffer.from('# Changelog\n\n');

assert.equal(sha(previous), '252e0187959b1881a4e902a32be4cd05d1355fe851e60db94d922016c87c0e5d');
assert.equal(current.includes(frozen.subarray(header.length)), false,
  'CHANGELOG_COMPACTION_RED: root still embeds the historical release body');

const { changelogPreservesHistory, reviewedChangelogCompaction: checkCompaction } = await import('./identity-maintenance-boundaries.mjs');
const row = { id: 'changelog-history', path: 'CHANGELOG.md', gitBlobOid: '4b874492711d5b53d4f75de7116d1a8019703217',
  byteSha256: 'dfac66a15ee7761396e293e915c70b3c2d3dd5b4e1317e51b18d40c30213b2f5' };
const readHistory = commit => { assert.equal(commit, previousCommit); return git('show', `${commit}:CHANGELOG.md`); };
const isAncestor = commit => { git('merge-base', '--is-ancestor', commit, 'HEAD'); return true; };
const reviewedChangelogCompaction = (row, frozen, current, reader) => checkCompaction(row, frozen, current, reader, isAncestor);
assert(!checkCompaction(row, frozen, current, readHistory, () => false), 'readable but unreachable history is refused');
assert(!checkCompaction(row, frozen, current, readHistory, () => { throw Error('ancestry unavailable'); }));
assert(!reviewedChangelogCompaction({ ...row, path: 'docs/lab-maintenance.md' }, frozen, current, readHistory));
assert(changelogPreservesHistory(frozen, previous), 'old Git history retains the original frozen bytes');
assert(reviewedChangelogCompaction(row, frozen, current, readHistory), 'exact approved compact baseline is accepted');
const next = Buffer.concat([header, Buffer.from('## Lab future - v1.2.3 - 2026-09-19\n\n- Final result.\n\n'), current.subarray(header.length)]);
assert(reviewedChangelogCompaction(row, frozen, next, readHistory), 'ordinary prepend remains accepted');
assert(!reviewedChangelogCompaction(row, frozen, current, () => { throw Error('missing history'); }));
assert(!reviewedChangelogCompaction(row, frozen, current, () => Buffer.concat([previous, Buffer.from('tamper')])));
assert(!reviewedChangelogCompaction({ ...row, id: 'other' }, frozen, current, readHistory));
assert(!reviewedChangelogCompaction({ ...row, byteSha256: '0'.repeat(64) }, frozen, current, readHistory));
assert(!reviewedChangelogCompaction(row, Buffer.from('wrong frozen body'), current, readHistory));
assert(!reviewedChangelogCompaction(row, frozen, header, readHistory), 'arbitrary truncation is refused');
assert(!reviewedChangelogCompaction(row, frozen, Buffer.from(current.toString().replace(previousCommit, '0'.repeat(40))), readHistory), 'history pointer mutation is refused');
assert(!reviewedChangelogCompaction(row, frozen, Buffer.concat([current, Buffer.from('tamper')]), readHistory));
assert(!reviewedChangelogCompaction(row, frozen, Buffer.concat([header, Buffer.from('unreviewed prefix\n\n'), current.subarray(header.length)]), readHistory));
const { verifyFrozenFiles } = await import('./verify-proof-or-stop-identity-cutover.mjs');
const tracked = new Set(git('ls-files', '-z').toString().split('\0').filter(Boolean));
assert.deepEqual(verifyFrozenFiles(root, tracked).filter(error => error.includes('changelog-history')), [],
  'the actual frozen-file gate must accept the retained-history compaction');
for (const changed of [{ ...row, byteSha256: '0'.repeat(64) }, { ...row, gitBlobOid: '0'.repeat(40) }]) {
  assert(verifyFrozenFiles(root, tracked, [changed]).some(error => error.includes('changelog-history') && error.includes('byte mutation')),
    'real gate must reject invalid historical byte or object bindings');
}
assert(verifyFrozenFiles(root, new Set([...tracked].filter(path => path !== 'CHANGELOG.md'))).some(error => error.includes('changelog-history') && error.includes('missing tracked path')));
// Exercise the actual parent block and failure collector without recursively launching this child.
const contract = readFileSync(join(root, 'scripts/verify-process-fact-contract.mjs'), 'utf8');
const blockStart = contract.indexOf('assert(read(processFactRegistryPath).includes("name: \'runtime:changelog_history_compaction\'"),');
const blockEnd = contract.indexOf('\nfunction parseDonePreflightPredicateInventory', blockStart);
assert(blockStart >= 0 && blockEnd > blockStart, 'parent wiring block must be found');
const collectors = ['fail', 'assert'].map(name => {
  const match = contract.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert(match, `parent ${name} collector must be found`);
  return match[0];
}).join('\n');
for (const scenario of ['pass', 'missing-marker', 'child-failure', 'missing-registration']) {
  const failures = [];
  let launches = 0;
  runInNewContext(collectors + '\n' + contract.slice(blockStart, blockEnd), {
    failures, root, join, process: { execPath: process.execPath }, verificationFailureMessage,
    processFactRegistryPath: 'packages/main/src/core/process-fact-registry.ts',
    read: path => scenario === 'missing-registration' ? '' : readFileSync(join(root, path), 'utf8'),
    execFileSync: (executable, argv, options) => {
      launches++;
      assert.equal(executable, process.execPath);
      assert.deepEqual(Array.from(argv), [join(root, 'scripts/verify-changelog-compaction.mjs')]);
      assert.equal(options.timeout, 60000);
      if (scenario === 'child-failure') throw Error('controlled child exit failure');
      return scenario === 'missing-marker' ? 'child output without selector' : 'CHANGELOG_COMPACTION_GREEN';
    },
  });
  assert.equal(launches, 1);
  assert.equal(failures.length, scenario === 'pass' ? 0 : 1, `parent must collect ${scenario}`);
  if (scenario === 'child-failure') assert.match(failures[0], /PROOF_ASSERTION_FAILED: changelog compaction/);
}
console.log('CHANGELOG_COMPACTION_GREEN retained Git bytes, compact baseline, prepend and tamper controls');
