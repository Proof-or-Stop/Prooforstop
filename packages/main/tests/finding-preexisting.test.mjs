/**
 * Old-PoS run 30 (B-c201:F-005): pre-existing findings outside the Story.
 *
 * - findingDefectAnchors reads the reviewer's `path:line` convention, including
 *   `and :52` continuations and `a-b` ranges, restricted to the finding's files.
 * - assessFindingBasePresence: cited lines byte-identical at the Story base and
 *   outside every base..head hunk -> pre-existing (also when the Story inserted
 *   lines ABOVE them); a cited line the Story changed, a file absent at the base,
 *   or a finding with no line anchor -> not pre-existing. Cited files the Story
 *   changed without an anchor are listed for the audit.
 * - findingScopeCoverage: the scope contract, a checklist file, the request
 *   naming the file, or a request asking for documentation work covers it;
 *   "as documented in docs/x.md" does not ask for documentation work.
 * - findingRepairRoute: disposition for pre-existing out-of-scope; one
 *   relaunch after a run without a commit; replan after the second.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assessFindingBasePresence, findingDefectAnchors, findingRepairRoute, findingScopeCoverage, preexistingDispositionReason } from '../dist/core/finding-preexisting.js';

const F005 = { desc: 'doc-code-drift: docs/src/docs/types/array.md:43 and :52 show array[0:2] # [0, 1, 2] and array[:2] # [0, 1, 2], but the implemented slice end is exclusive.',
  files: ['docs/src/docs/types/array.md', 'evaluator/evaluator.go'] };
assert.deepEqual(findingDefectAnchors(F005), [
  { path: 'docs/src/docs/types/array.md', line: 43, endLine: 43 }, { path: 'docs/src/docs/types/array.md', line: 52, endLine: 52 }]);
assert.deepEqual(findingDefectAnchors({ desc: 'evaluator/evaluator_test.go:17 and evaluator/evaluator_test.go:1457-1515 use a prefix check', files: ['evaluator/evaluator_test.go'] }), [
  { path: 'evaluator/evaluator_test.go', line: 17, endLine: 17 }, { path: 'evaluator/evaluator_test.go', line: 1457, endLine: 1515 }]);
assert.deepEqual(findingDefectAnchors({ desc: 'Reverse has no focused test for an empty string.', files: ['strs/strs.go'] }), [], 'no anchor, no defect site');
assert.deepEqual(findingDefectAnchors({ desc: 'other/file.go:3 is wrong', files: ['strs/strs.go'] }), [], 'anchors outside the finding files are ignored');

const root = mkdtempSync(join(tmpdir(), 'finding-preexisting-'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const write = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
try {
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 't'); git('config', 'user.email', 't@t.invalid');
  const doc = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
  doc[42] = 'array[0:2] # [0, 1, 2]'; doc[51] = 'array[:2] # [0, 1, 2]';
  write('docs/src/docs/types/array.md', `${doc.join('\n')}\n`);
  write('evaluator/evaluator.go', 'package evaluator\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  write('evaluator/evaluator.go', 'package evaluator\n\n// stepped ranges\n');
  git('commit', '-qam', 'story: code only');
  let head = git('rev-parse', 'HEAD');
  let presence = assessFindingBasePresence({ gitCwd: root, base, head, finding: F005 });
  assert.equal(presence.preExisting, true, presence.reason);
  assert.deepEqual(presence.referencedChangedFiles, ['evaluator/evaluator.go']);
  assert.deepEqual(presence.anchors.map(row => row.baseLine), [43, 52]);

  // The Story inserts two lines above the cited ones: still pre-existing (base lines 43/52 map to 45/54).
  const shifted = ['intro a', 'intro b', ...doc];
  write('docs/src/docs/types/array.md', `${shifted.join('\n')}\n`);
  git('commit', '-qam', 'story: doc intro');
  head = git('rev-parse', 'HEAD');
  presence = assessFindingBasePresence({ gitCwd: root, base, head, finding: { ...F005, desc: F005.desc.replace(':43 and :52', ':45 and :54') } });
  assert.equal(presence.preExisting, true, presence.reason);
  assert.deepEqual(presence.anchors.map(row => row.baseLine), [43, 52]);

  // The Story changed a cited line: not pre-existing.
  shifted[44] = 'array[0:2] # [0, 1, 2, 3]';
  write('docs/src/docs/types/array.md', `${shifted.join('\n')}\n`);
  git('commit', '-qam', 'story: edits the cited line');
  head = git('rev-parse', 'HEAD');
  presence = assessFindingBasePresence({ gitCwd: root, base, head, finding: { ...F005, desc: F005.desc.replace(':43 and :52', ':45 and :54') } });
  assert.equal(presence.preExisting, false);
  assert.match(presence.reason, /the Story changed docs\/src\/docs\/types\/array\.md/);

  // A file the Story created is never pre-existing.
  write('docs/new.md', 'a\nb\n'); git('add', '-A'); git('commit', '-qm', 'story: new doc');
  presence = assessFindingBasePresence({ gitCwd: root, base, head: git('rev-parse', 'HEAD'), finding: { desc: 'docs/new.md:2 is wrong', files: ['docs/new.md'] } });
  assert.equal(presence.preExisting, false);
  assert.match(presence.reason, /does not exist at the Story base/);

  // The cited file changed after the reviewed head: the reviewed lines no longer prove anything.
  presence = assessFindingBasePresence({ gitCwd: root, base, head: base, finding: F005 });
  assert.equal(presence.preExisting, false);
  assert.match(presence.reason, /changed after the reviewed head/);

  assert.equal(assessFindingBasePresence({ gitCwd: root, base, head, finding: { desc: 'Reverse has no test.', files: ['evaluator/evaluator.go'] } }).preExisting, false);

  const contract = { allowedModify: ['ast/ast.go', 'parser/parser.go', 'evaluator/evaluator.go'], allowedCreate: [], allowedTest: ['evaluator/evaluator_test.go'] };
  const paths = ['docs/src/docs/types/array.md'];
  const run30Request = 'Extend indexing ranges so arrays and strings support a third slice component:\n\n- `value[start:end:step]`\n\n## Constraints\n\n- Do not change public syntax outside index brackets.';
  assert.equal(findingScopeCoverage({ paths, contract, itemFiles: contract.allowedModify, requestText: run30Request, scopeAllowed: ['Parser and AST support for stepped index expressions inside brackets'] }).inScope, false, 'run 30: nothing covers the array doc');
  assert.equal(findingScopeCoverage({ paths, contract: { ...contract, allowedModify: [...contract.allowedModify, 'docs/**'] }, itemFiles: [], requestText: null, scopeAllowed: [] }).inScope, true, 'contract glob');
  assert.equal(findingScopeCoverage({ paths, contract, itemFiles: ['docs/src/docs/types/array.md'], requestText: null, scopeAllowed: [] }).inScope, true, 'checklist file');
  assert.equal(findingScopeCoverage({ paths, contract, itemFiles: [], requestText: 'Also fix the examples in array.md.', scopeAllowed: [] }).inScope, true, 'request names the file');
  assert.equal(findingScopeCoverage({ paths, contract, itemFiles: [], requestText: 'Document the stepped slices in the docs.', scopeAllowed: [] }).inScope, true, 'request asks for docs work');
  assert.equal(findingScopeCoverage({ paths, contract, itemFiles: [], requestText: 'Implement Upper as documented in docs/types/string.md.', scopeAllowed: [] }).inScope, false, '"as documented in" is not docs work');
  assert.equal(findingScopeCoverage({ paths: ['evaluator/evaluator.go'], contract, itemFiles: [], requestText: 'Document the stepped slices in the docs.', scopeAllowed: [] }).inScope, true, 'code file in the contract');

  presence = assessFindingBasePresence({ gitCwd: root, base, head: base, finding: { desc: 'docs/src/docs/types/array.md:43 shows a wrong range', files: ['docs/src/docs/types/array.md'] } });
  const coverage = findingScopeCoverage({ paths, contract, itemFiles: [], requestText: run30Request, scopeAllowed: [] });
  const reason = preexistingDispositionReason({ ...presence, preExisting: true, reason: 'cited lines unchanged', referencedChangedFiles: ['evaluator/evaluator.go'] }, coverage, 'fix the doc in a follow-up Story');
  assert.match(reason, /^\[preexisting_out_of_scope\] Pre-existing at the Story base /);
  assert.match(reason, /evaluator\/evaluator\.go/);
  assert.match(reason, /Follow-up: fix the doc in a follow-up Story$/);

  assert.deepEqual(findingRepairRoute({ preexistingOutOfScope: true, noCommitRunsSincePlan: 0 }), { kind: 'disposition' });
  assert.deepEqual(findingRepairRoute({ preexistingOutOfScope: false, noCommitRunsSincePlan: 0 }), { kind: 'repair', relaunch: false });
  assert.deepEqual(findingRepairRoute({ preexistingOutOfScope: false, noCommitRunsSincePlan: 1 }), { kind: 'repair', relaunch: true });
  assert.deepEqual(findingRepairRoute({ preexistingOutOfScope: false, noCommitRunsSincePlan: 2 }), { kind: 'replan' });
  console.log('finding-preexisting: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
