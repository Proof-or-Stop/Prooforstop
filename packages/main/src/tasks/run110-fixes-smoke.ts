#!/usr/bin/env node
/**
 * Old-PoS run 110 (bench-staging/oldpos/run110-analysis.md §4, §6; lab `codex/lab-run110`). Unit level on a made-up Go
 * repo (no benchmark-task material). The lifecycle shape is harness NFS / NFS-S / NFS-OFF.
 *
 *   B. Scope-boundary exclusions reach the scope contract: a boundary `excluded` entry that is purely about documentation
 *      ("changes to docs") or names an existing path maps to `explicitExcludes`, so the writer prompt, the write-time
 *      guard and the REVIEW gate agree; the repair prompt no longer says docs are admitted. Request text asking for
 *      documentation work, an allowed documentation path or a boundary `allowed` entry about docs keep docs admitted.
 *   D. Pre-existing disposition: leading `[...]` tags are stripped before the doc-code-drift check; a code anchor inside
 *      a Story hunk is judged by base behaviour (a base probe of the finding's repro; experimental `review.driftBaseSymbol`
 *      = the cited lines exist in the base source of the same symbol), not line identity; the Story's own edit of a doc
 *      the contract excludes does not block the disposition; an excluded doc is never "in scope" by a request mention.
 *   P. A repair-added test that hashes / git-pins an out-of-scope file is refused (managed writer turn + repair
 *      acceptance) with one next action.
 *   F. File-state conflict: a finding whose only remedy changes files the scope boundary excludes is settled once by
 *      precedence (request text > scope boundary > reviewer opinion) and closed with a recorded reason; the reverse
 *      (a scope finding against a file the request asks to change) loses to the request; a finding with an in-scope
 *      code defect site is never settled.
 *   S. Switches: scope.boundaryExcludes on, remediation.fileStateSettle on (off = rollback), review.driftBaseSymbol off.
 *
 * Usage: node packages/main/dist/tasks/run110-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type Fn = (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error)}`); }
}
/** A module export that may not exist yet (RED: the check fails, the smoke still runs). */
async function load(path: string, name: string): Promise<Fn> {
  let module: Record<string, unknown> = {};
  try { module = await import(path) as Record<string, unknown>; } catch { module = {}; }
  const fn = module[name];
  assert.ok(fn !== undefined, `${path} exports ${name}`);
  return fn as Fn;
}

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const commit = (root: string, message: string): string => { git(root, ['add', '-A']); git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-qm', message]); return git(root, ['rev-parse', 'HEAD']); };

const DOC = 'docs/types/array.md';
const DOC_TEXT = '# Array\n\n`[0, 1, 2, 3][0:2]` returns `[0, 1, 2]`.\n`[0, 1, 2, 3][:2]` returns `[0, 1, 2]`.\n\nRanges are supported.\n';
const EVAL_BASE = [
  'package eval', '',
  'func evalRange(a []int, start, end int) []int {',
  '\tout := []int{}',
  '\tfor i := start; i < end; i++ {',
  '\t\tout = append(out, a[i])',
  '\t}',
  '\treturn out',
  '}', '',
].join('\n');
// The Story rewrites evalRange (a step) but keeps the exclusive end: the drift in the doc predates it.
const EVAL_STORY = [
  'package eval', '',
  'func evalRange(a []int, start, end, step int) []int {',
  '\tif step == 0 {',
  '\t\tstep = 1',
  '\t}',
  '\tout := []int{}',
  '\tfor i := start; i < end; i++ {',
  '\t\tif (i-start)%step == 0 {',
  '\t\t\tout = append(out, a[i])',
  '\t\t}',
  '\t}',
  '\treturn out',
  '}', '',
].join('\n');
/**
 * Head lines of EVAL_STORY: the kept loop header (git aligns it with the base: outside every hunk), the re-indented
 * append (inside the Story hunk; its text is in the base symbol) and a new line (inside the hunk, not in the base).
 */
const KEPT_LOOP_LINE = 8;
const NEW_STEP_LINE = 9;
const REINDENTED_LINE = 10;

interface Fixture { root: string; base: string; head: string }
function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run110-')));
  git(root, ['init', '-q', '-b', 'main']);
  write(root, DOC, DOC_TEXT);
  write(root, 'eval/eval.go', EVAL_BASE);
  write(root, 'eval/eval_test.go', 'package eval\n\nimport "testing"\n\nfunc TestRange(t *testing.T) {}\n');
  write(root, 'testdata/golden.txt', 'golden\n');
  write(root, 'README.md', '# Project\n');
  const base = commit(root, 'base');
  write(root, 'eval/eval.go', EVAL_STORY);
  const head = commit(root, 'story: stepped ranges');
  return { root, base, head };
}

const contractOf = (extra: Record<string, unknown> = {}) => ({
  storyId: 'B-1100', mode: 'enforce', allowedModify: ['eval/eval.go'], allowedCreate: [], allowedTest: ['eval/eval_test.go', 'testdata/golden.txt'],
  protectedFiles: [], explicitExcludes: [], acknowledgements: [], pathCanonicalizerVersion: 'repo-relative-v1', pathCanonicalizationMode: 'enforce', createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z', ...extra,
});
const DRIFT = (codeLine: number, tag = '[regression-of F-005] ') => ({
  id: 'B-1100:F-011', desc: `${tag}doc-code-drift: ${DOC}:3 and :4 show \`[0, 1, 2, 3][0:2]\` returning [0, 1, 2], but eval/eval.go:${codeLine} stops before end (exclusive), so it returns [0, 1].`,
  files: [DOC, 'eval/eval.go'], severity: 'medium', status: 'open', evidenceState: 'verified',
});

// ---------------------------------------------------------------------------
// B. Scope-boundary exclusions -> explicitExcludes

await check('B1 a boundary entry purely about documentation ("changes to docs") maps to the documentation exclude pattern', async () => {
  const derive = await load('../core/boundary-path-excludes.js', 'boundaryPathExcludes');
  const pattern = (await load('../core/boundary-path-excludes.js', 'DOCUMENTATION_EXCLUDE_PATTERN') as unknown as string);
  const out = derive({ excluded: ['changes to docs', 'other string helpers'], allowed: ['stepped slices on arrays and strings'], allowedPaths: ['eval/eval.go'],
    requestText: 'Add stepped slices `a[x:y:z]` to arrays and strings.', pathExists: () => false });
  assert.deepEqual(out.patterns, [pattern], JSON.stringify(out));
  assert.equal(out.sources[0]?.entry, 'changes to docs', 'the boundary entry is recorded as the source');
});

await check('B2 docs stay admitted when the request asks for docs work, an allowed path is a doc, an allowed entry is about docs, or the entry is not purely about docs; an existing path token maps', async () => {
  const derive = await load('../core/boundary-path-excludes.js', 'boundaryPathExcludes');
  const base = { excluded: ['changes to docs'], allowed: ['stepped slices'], allowedPaths: ['eval/eval.go'], requestText: 'Add stepped slices.', pathExists: () => false };
  assert.deepEqual(derive({ ...base, requestText: 'Add stepped slices and update the docs for them.' }).patterns, [], 'request text > scope boundary');
  assert.deepEqual(derive({ ...base, allowedPaths: ['eval/eval.go', DOC] }).patterns, [], 'an allowed documentation path keeps docs admitted');
  assert.deepEqual(derive({ ...base, allowed: ['stepped slices', 'documentation of slices'] }).patterns, [], 'a boundary allowed entry about docs');
  assert.deepEqual(derive({ ...base, excluded: ['docs for unrelated types'] }).patterns, [], 'not purely about docs: no mapping');
  assert.deepEqual(derive({ ...base, excluded: ['changes to `vendor/`'], pathExists: (path: string) => path === 'vendor' }).patterns, ['vendor'], 'an existing path token maps');
  assert.deepEqual(derive({ ...base, excluded: ['changes to `eval/eval.go`'], pathExists: () => true }).patterns, [], 'never an allowed path');
});

await check('B3 with the derived pattern the gate classifies docs as excluded (not documentation-default); code stays allowed', async () => {
  const classify = await load('../core/scope-path-classifier.js', 'classifyScopePath');
  const pattern = (await load('../core/boundary-path-excludes.js', 'DOCUMENTATION_EXCLUDE_PATTERN') as unknown as string);
  assert.ok(pattern, 'DOCUMENTATION_EXCLUDE_PATTERN exported');
  const contract = contractOf({ explicitExcludes: [pattern] });
  assert.equal(classify(contract, DOC).category, 'excluded');
  assert.equal(classify(contract, 'README.md').category, 'excluded');
  assert.equal(classify(contract, 'eval/eval.go').category, 'allowed_modify');
});

await check('B4 the repair prompt does not say docs are admitted when the contract excludes them; without the exclusion it still does', async () => {
  const render = await load('../core/managed-writer-scope.js', 'renderAllowedFilesSection');
  const pattern = (await load('../core/boundary-path-excludes.js', 'DOCUMENTATION_EXCLUDE_PATTERN') as unknown as string);
  assert.ok(pattern, 'DOCUMENTATION_EXCLUDE_PATTERN exported');
  const excluded = render(contractOf({ explicitExcludes: [pattern] })).join('\n');
  assert.doesNotMatch(excluded, /admitted by the gate too/i, excluded);
  assert.match(excluded, /documentation[^\n]*not admitted/i, excluded);
  assert.doesNotMatch(excluded, /documentation files aside/i, excluded);
  assert.match(render(contractOf()).join('\n'), /admitted by the gate too/i, 'control: the run-30 rule stays without an exclusion');
});

// ---------------------------------------------------------------------------
// D. Pre-existing disposition

await check('D1 a leading [regression-of ...] (or any [...]) tag does not hide the doc-code-drift prefix; code anchors are evidence', async () => {
  const isDrift = await load('../core/finding-preexisting.js', 'isDocCodeDriftFinding');
  const sites = await load('../core/finding-preexisting.js', 'findingSites');
  assert.equal(isDrift({ desc: '[regression-of F-005] doc-code-drift: docs/a.md:3 ...' }), true);
  assert.equal(isDrift({ desc: '[regression-of F-005] [dimension:docs] doc-code-drift: docs/a.md:3 ...' }), true);
  assert.equal(isDrift({ desc: 'the doc-code-drift: docs/a.md:3' }), false, 'only a leading prefix counts');
  const out = sites(DRIFT(KEPT_LOOP_LINE));
  assert.deepEqual(out.defects.map((row: { path: string }) => row.path), [DOC, DOC]);
  assert.deepEqual(out.evidence.map((row: { path: string; line: number }) => `${row.path}:${row.line}`), [`eval/eval.go:${KEPT_LOOP_LINE}`]);
});

await check('D2 an in-hunk code anchor is judged by base behaviour: a base probe answering the same at base and head makes it pre-existing; a changed behaviour does not; no verdict keeps the old rule', async () => {
  const assess = await load('../core/finding-preexisting.js', 'assessFindingBasePresence');
  const fx = fixture();
  try {
    const args = { gitCwd: fx.root, base: fx.base, head: fx.head, finding: DRIFT(REINDENTED_LINE) };
    assert.equal(assess(args).preExisting, false, 'control: line identity alone refuses an in-hunk anchor');
    let asked = 0;
    const same = assess({ ...args, baseBehaviour: () => { asked += 1; return { verdict: 'same', detail: 'base probe `[0, 1, 2, 3][0:2]`: [0, 1] at base and head' }; } });
    assert.equal(same.preExisting, true, same.reason);
    assert.ok(asked >= 1, 'the base behaviour is consulted for the changed evidence');
    assert.match(same.reason, /base probe/i, same.reason);
    const changed = assess({ ...args, baseBehaviour: () => ({ verdict: 'changed', detail: 'base [0, 1, 2], head [0, 1]' }) });
    assert.equal(changed.preExisting, false);
    assert.match(changed.reason, /behaviour|behavior/i, changed.reason);
    assert.equal(assess({ ...args, baseBehaviour: () => ({ verdict: 'unknown', detail: 'no probe runner' }) }).preExisting, false);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

await check('D3 review.driftBaseSymbol (experimental): the cited lines found in the base source of the same symbol count; a line the Story added does not', async () => {
  const assess = await load('../core/finding-preexisting.js', 'assessFindingBasePresence');
  const fx = fixture();
  try {
    const kept = assess({ gitCwd: fx.root, base: fx.base, head: fx.head, finding: DRIFT(REINDENTED_LINE), symbolFallback: true });
    assert.equal(assess({ gitCwd: fx.root, base: fx.base, head: fx.head, finding: DRIFT(REINDENTED_LINE) }).preExisting, false, 'control: off by default');
    assert.equal(kept.preExisting, true, kept.reason);
    assert.match(kept.reason, /evalRange/, kept.reason);
    const added = assess({ gitCwd: fx.root, base: fx.base, head: fx.head, finding: DRIFT(NEW_STEP_LINE), symbolFallback: true });
    assert.equal(added.preExisting, false, added.reason);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

await check('D4 the Story\'s own edit of a doc the contract excludes does not block the disposition; an admitted doc edit still does (run 37)', async () => {
  const assess = await load('../core/finding-preexisting.js', 'assessFindingBasePresence');
  const fx = fixture();
  try {
    // A repair edited the doc (line 6, not a cited line): a scope violation the gate refuses.
    write(fx.root, DOC, DOC_TEXT.replace('Ranges are supported.', 'Ranges are end-exclusive.'));
    const head = commit(fx.root, 'repair: docs (out of scope)');
    const finding = { id: 'B-1100:F-009', desc: `[regression-of F-005] doc-code-drift: ${DOC}:3 and :4 show [0, 1, 2, 3][0:2] returning [0, 1, 2]; ranges are end-exclusive.`, files: [DOC] };
    const blocked = assess({ gitCwd: fx.root, base: fx.base, head, finding });
    assert.equal(blocked.preExisting, false, 'control: an admitted doc edit makes the drift the Story\'s own');
    const pattern = (await load('../core/boundary-path-excludes.js', 'DOCUMENTATION_EXCLUDE_PATTERN') as unknown as string);
    const excluded = (path: string) => path.endsWith('.md') && Boolean(pattern);
    const open = assess({ gitCwd: fx.root, base: fx.base, head, finding, excluded });
    assert.equal(open.preExisting, true, open.reason);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

await check('D5 a doc the contract excludes is never in scope because the request mentions it', async () => {
  const coverage = await load('../core/finding-preexisting.js', 'findingScopeCoverage');
  const pattern = (await load('../core/boundary-path-excludes.js', 'DOCUMENTATION_EXCLUDE_PATTERN') as unknown as string);
  assert.ok(pattern, 'DOCUMENTATION_EXCLUDE_PATTERN exported');
  const out = coverage({ paths: [DOC], contract: contractOf({ explicitExcludes: [pattern] }), itemFiles: [], requestText: `Add stepped slices as described in ${DOC}.`, scopeAllowed: [] });
  assert.equal(out.inScope, false, out.reason);
  assert.match(out.reason, /exclud/i, out.reason);
});

// ---------------------------------------------------------------------------
// P. Repair-added tests pinning out-of-scope files

const PIN_TEST = [
  'package eval', '', 'import (', '\t"crypto/sha256"', '\t"encoding/hex"', '\t"os"', '\t"path/filepath"', '\t"testing"', ')', '',
  'func TestRange(t *testing.T) {}', '',
  'func TestSliceDocsRemainAtStoryBaseScope(t *testing.T) {',
  '\tdata, err := os.ReadFile(filepath.Join("..", "docs", "types", "array.md"))',
  '\tif err != nil {', '\t\tt.Fatal(err)', '\t}',
  '\tsum := sha256.Sum256(data)',
  '\tif hex.EncodeToString(sum[:]) != "0f00" {', '\t\tt.Fatal("docs changed")', '\t}',
  '}', '',
].join('\n');
const GOLDEN_TEST = PIN_TEST.replace('filepath.Join("..", "docs", "types", "array.md")', 'filepath.Join("..", "testdata", "golden.txt")').replace('TestSliceDocsRemainAtStoryBaseScope', 'TestGoldenChecksum');
const READ_DOC_TEST = [
  'package eval', '', 'import (', '\t"os"', '\t"strings"', '\t"testing"', ')', '',
  'func TestRange(t *testing.T) {}', '',
  'func TestDocExample(t *testing.T) {',
  '\tdata, _ := os.ReadFile("../docs/types/array.md")',
  '\tif !strings.Contains(string(data), "Array") {', '\t\tt.Fatal("doc")', '\t}',
  '}', '',
].join('\n');

await check('P1 a repair-added test that sha256-pins an out-of-scope doc is refused with one next action; a checksum of an allowed test fixture and a plain doc read are not', async () => {
  const pins = await load('../core/scope-pin-test.js', 'outOfScopePinTests');
  const problem = await load('../core/scope-pin-test.js', 'outOfScopePinTestProblem');
  const fx = fixture();
  try {
    const contract = contractOf();
    write(fx.root, 'eval/eval_test.go', PIN_TEST);
    const pinned = commit(fx.root, 'B-1100 F-014: keep docs at the Story base');
    const rows = pins({ gitCwd: fx.root, commits: [pinned], contract });
    assert.deepEqual(rows.map((row: { testFile: string; path: string }) => `${row.testFile}>${row.path}`), [`eval/eval_test.go>${DOC}`], JSON.stringify(rows));
    const text = problem({ gitCwd: fx.root, commits: [pinned], contract });
    assert.match(String(text), /out-of-scope|outside the scope/i, String(text));
    assert.match(String(text), /remove/i, 'one next action: remove the pin test');
    write(fx.root, 'eval/eval_test.go', GOLDEN_TEST);
    const golden = commit(fx.root, 'golden checksum');
    assert.deepEqual(pins({ gitCwd: fx.root, commits: [golden], contract }), [], 'a checksum of an allowed test fixture is no scope pin');
    write(fx.root, 'eval/eval_test.go', READ_DOC_TEST);
    const read = commit(fx.root, 'doc example test');
    assert.deepEqual(pins({ gitCwd: fx.root, commits: [read], contract }), [], 'reading a doc without a hash / git pin is not flagged');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

await check('P2 the managed writer scope check reports the pin test (rule out_of_scope_pin_test) so the same session removes it', async () => {
  const violations = await load('../core/managed-writer-scope.js', 'managedWriterScopeViolations');
  const prompt = await load('../core/managed-writer-scope.js', 'managedWriterScopeRepairPrompt');
  const fx = fixture();
  try {
    const contract = contractOf();
    write(fx.root, 'eval/eval_test.go', PIN_TEST);
    commit(fx.root, 'B-1100 F-014: keep docs at the Story base');
    const rows = violations({ cwd: fx.root, baseHead: fx.head, contract });
    assert.deepEqual(rows.map((row: { rule: string }) => row.rule), ['out_of_scope_pin_test'], JSON.stringify(rows));
    assert.match(prompt(rows, contract), /TestSliceDocsRemainAtStoryBaseScope|remove the test/i, prompt(rows, contract));
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// F. File-state conflicts

await check('F1 a drift whose only remedy changes a boundary-excluded doc is settled once: scope boundary > reviewer opinion, recorded reason', async () => {
  const conflictOf = await load('../core/file-state-conflict.js', 'fileStateConflictOf');
  const pattern = (await load('../core/boundary-path-excludes.js', 'DOCUMENTATION_EXCLUDE_PATTERN') as unknown as string);
  const out = conflictOf({ finding: DRIFT(KEPT_LOOP_LINE), findings: [], contract: contractOf({ explicitExcludes: [pattern] }),
    requestText: 'Add stepped slices `a[x:y:z]`.', boundaryExcluded: ['changes to docs'] });
  assert.equal(out?.settle, true, JSON.stringify(out));
  assert.equal(out.winner, 'scope_boundary');
  assert.deepEqual(out.files, [DOC]);
  assert.match(out.reason, /^\[file_state_conflict\]/);
  assert.match(out.reason, /request text > scope boundary > reviewer/);
  assert.match(out.reason, /changes to docs/);
});

await check('F2 never settled: an in-scope code defect site, a request asking for the doc change, a doc the contract does not exclude', async () => {
  const conflictOf = await load('../core/file-state-conflict.js', 'fileStateConflictOf');
  const pattern = (await load('../core/boundary-path-excludes.js', 'DOCUMENTATION_EXCLUDE_PATTERN') as unknown as string);
  const contract = contractOf({ explicitExcludes: [pattern] });
  const code = { id: 'B-1100:F-002', desc: `${DOC}:3 is wrong and eval/eval.go:${NEW_STEP_LINE} skips elements for a negative step.`, files: [DOC, 'eval/eval.go'] };
  assert.ok(!conflictOf({ finding: code, findings: [], contract, requestText: 'Add stepped slices.', boundaryExcluded: ['changes to docs'] })?.settle, 'a genuine code defect is repaired');
  const requested = conflictOf({ finding: DRIFT(KEPT_LOOP_LINE), findings: [], contract, requestText: 'Add stepped slices and update the docs.', boundaryExcluded: ['changes to docs'] });
  assert.ok(!requested?.settle, `request text > scope boundary: ${JSON.stringify(requested)}`);
  assert.ok(!conflictOf({ finding: DRIFT(KEPT_LOOP_LINE), findings: [], contract: contractOf(), requestText: 'Add stepped slices.', boundaryExcluded: [] })?.settle, 'not excluded: no conflict');
});

await check('F3 the reverse: a scope-violation finding against a doc the request asks to change loses to the request', async () => {
  const conflictOf = await load('../core/file-state-conflict.js', 'fileStateConflictOf');
  const scope = { id: 'B-1100:F-006', desc: `The repair of F-005 edited ${DOC}, which is outside the Story's scope boundary; revert it.`, files: [DOC] };
  const out = conflictOf({ finding: scope, findings: [], contract: contractOf(), requestText: 'Add stepped slices and update the docs for them.', boundaryExcluded: [] });
  assert.equal(out?.settle, true, JSON.stringify(out));
  assert.equal(out.winner, 'request');
  assert.ok(!conflictOf({ finding: scope, findings: [], contract: contractOf(), requestText: 'Add stepped slices.', boundaryExcluded: [] })?.settle, 'without the request the scope finding stands');
});

await check('F4 settlements are journaled once per file and direction; a settled finding is no repair (no regression guard, not re-verified)', async () => {
  const record = await load('../core/file-state-conflict.js', 'recordFileStateSettlement');
  const settled = await load('../core/file-state-conflict.js', 'fileStateSettlements');
  const isSettled = await load('../core/file-state-conflict.js', 'isFileStateSettled');
  const guardable = await load('../core/resolved-finding-guard.js', 'guardableResolved');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run110-j-')));
  try {
    const entry = { files: [DOC], dir: 'unchanged', winner: 'scope_boundary', findingId: 'B-1100:F-011', why: '[file_state_conflict] x' };
    record(root, 'B-1100', entry);
    record(root, 'B-1100', { ...entry, findingId: 'B-1100:F-019' });
    const rows = settled(root, 'B-1100');
    assert.deepEqual(rows.map((row: { file: string; dir: string }) => `${row.file}:${row.dir}`), [`${DOC}:unchanged`]);
    assert.deepEqual(rows[0].findings, ['B-1100:F-011', 'B-1100:F-019']);
    const closed = { id: 'B-1100:F-011', status: 'resolved', resolutionType: 'superseded', resolvedReason: '[file_state_conflict] closed', desc: 'x' };
    assert.equal(isSettled(closed), true);
    assert.deepEqual(guardable([closed]), [], 'no repair commit to guard');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// S. Switches

await check('S1 defaults: scope.boundaryExcludes on, remediation.fileStateSettle on (off = rollback), review.driftBaseSymbol off; malformed keeps the default', async () => {
  const resolve = await load('../core/ab-variants.js', 'resolveAbVariants');
  const evidence = await load('../core/ab-variants.js', 'abVariantEvidence');
  const boundaryOn = await load('../core/ab-variants.js', 'boundaryExcludesOn');
  const settleOn = await load('../core/ab-variants.js', 'fileStateSettleOn');
  const symbolOn = await load('../core/ab-variants.js', 'driftBaseSymbolOn');
  const variants = resolve({});
  assert.equal(variants.boundaryExcludes, 'on');
  assert.equal(variants.fileStateSettle, 'on');
  assert.equal(variants.driftBaseSymbol, 'off');
  assert.equal(evidence(variants), undefined, 'production values record nothing');
  assert.equal(boundaryOn({}), true); assert.equal(settleOn({}), true); assert.equal(symbolOn({}), false);
  assert.equal(boundaryOn({ scope: { boundaryExcludes: 'off' } }), false);
  assert.equal(settleOn({ remediation: { fileStateSettle: 'off' } }), false);
  assert.equal(symbolOn({ review: { driftBaseSymbol: 'on' } }), true);
  assert.equal(symbolOn({ review: { driftBaseSymbol: 'loud' } }), false, 'malformed = the default');
  assert.deepEqual(evidence(resolve({ scope: { boundaryExcludes: 'off' }, remediation: { fileStateSettle: 'off' }, review: { driftBaseSymbol: 'on' } }))?.flags,
    { 'scope.boundaryExcludes': 'off', 'remediation.fileStateSettle': 'off', 'review.driftBaseSymbol': 'on' });
});

if (failures.length) {
  console.log(`\nrun110-fixes-smoke: ${failures.length} FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nrun110-fixes-smoke: all checks passed');
