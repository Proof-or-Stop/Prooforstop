#!/usr/bin/env node
/**
 * Old-PoS round-count cuts (bench-staging/oldpos/run74-75-analysis.md §7 N1-N4; lab
 * `codex/lab-round-cut`). Unit level (pure functions, real git repositories, real `go test`).
 * Generic examples only (made-up `window` / `kv` / `strs` code); no benchmark-task material.
 * The lifecycle shapes are harness NRC (N1), NRM (N2) and NRD (N3).
 *
 *   G. N1 removed-guard scan at DEV exit: a base→HEAD diff that removes or weakens an operand
 *      guard (a null / omitted operand branch, a `< 0` clause, a `>= len` clause, an empty check)
 *      in a function that still exists is listed with its base line, the base tests that exercise
 *      the class and a confidence; a guard that only moved, an `err != nil` check, a guard
 *      a checklist row / request sentence states, are not. Switch dev.removedGuardScan.
 *   M. N2 bound matrix: a finding located in a helper that branches on several operands (or on
 *      the sign of one) gets a matrix block naming every branch; the repair's final report must
 *      carry one `[branch-test]` line per operand (lab run89: the exact line is printed and a
 *      missing one is asked for by the worker in the same session, never a rejected repair).
 *   D. N3 framework duplicate closure: a critic duplicate whose own repro is stated in a test
 *      the canonical's repair commit added gets its coverage command from the framework.
 *   X. N3b request exact-text literals in the implementer and repair prompts at launch.
 *   P. N4 pin probe: an inline index suffix on an assignment's right-hand side is kept; a write
 *      whose form the request itself defines is new behaviour (advisory); a whole-intent
 *      authoring payload built from older rows is refused instead of overwriting a newer fix.
 *
 * Usage: node packages/main/dist/tasks/round-cut-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { writeStoryRequest } from '../core/story-request.js';
import type { ChecklistData, ChecklistItem, Finding, StoryInfo } from '../core/types.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';

type Fn = (...args: unknown[]) => unknown;
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error)}`); }
}
/** A module export that may not exist yet (RED: the check fails, the smoke still runs). */
async function load(path: string, name: string): Promise<Fn> {
  let module: Record<string, unknown> = {};
  try { module = await import(path) as Record<string, unknown>; } catch { module = {}; }
  const fn = module[name];
  assert.equal(typeof fn, 'function', `${path} exports ${name}`);
  return fn as Fn;
}
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const commit = (root: string, message: string): string => { git(root, ['add', '-A']); git(root, ['commit', '-qm', message]); return git(root, ['rev-parse', 'HEAD']); };
const NOW = '2026-10-14T05:00:00.000Z';
function repo(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  return root;
}

// ---------------------------------------------------------------------------
// G. N1 removed-guard scan (run-75 shape: a refactor routes the two-part window through a new
// stepped helper and the `end != NULL` branch becomes `!end_omitted`; run-73/71/65 the same)

const WINDOW_BASE = [
  '#include <stddef.h>',
  '',
  '/* window copies items[lo:hi]; a NULL start or end means "omitted". */',
  'int window(const int *items, int len, const int *start, const int *end, int *out) {',
  '    int lo = 0;',
  '    int hi = len;',
  '    if (start != NULL) {',
  '        lo = *start;',
  '    }',
  '    if (end != NULL) {',
  '        hi = *end;',
  '    }',
  '    if (lo < 0) {',
  '        lo = 0;',
  '    }',
  '    int n = 0;',
  '    for (int i = lo; i < hi && i < len; i++) out[n++] = items[i];',
  '    return n;',
  '}',
  '',
].join('\n');
const WINDOW_HEAD = [
  '#include <stddef.h>',
  '',
  '/* window copies items[lo:hi:step]; a NULL start means "omitted". */',
  'int window(const int *items, int len, const int *start, const int *end, int end_omitted, int step, int *out) {',
  '    int lo = 0;',
  '    int hi = len;',
  '    if (start != NULL) {',
  '        lo = *start;',
  '    }',
  '    if (!end_omitted) {',
  '        hi = *end;',
  '    }',
  '    if (lo < 0) {',
  '        lo = 0;',
  '    }',
  '    int n = 0;',
  '    for (int i = lo; i < hi && i < len; i += step) out[n++] = items[i];',
  '    return n;',
  '}',
  '',
].join('\n');
const WINDOW_TEST = ['#include "window.h"', '', 'void test_window_open_end(void) {', '    int out[4];', '    check(window(ITEMS, 4, &ONE, NULL, out) == 3);', '}', ''].join('\n');

const AT_BASE = ['package kv', '', 'import "errors"', '', 'var errRange = errors.New("index out of range")', '',
  '// At returns s[i]; i must lie in [0, len(s)).', 'func At(s string, i int) (byte, error) {', '\tif i < 0 || i >= len(s) {', '\t\treturn 0, errRange', '\t}', '\treturn s[i], nil', '}', '',
  '// Load reads a record; a nil cache means "no cache".', 'func Load(key string, cache map[string]string) (string, error) {', '\tv, err := fetch(key)', '\tif err != nil {', '\t\treturn "", err', '\t}',
  '\tif cache != nil {', '\t\tcache[key] = v', '\t}', '\treturn v, nil', '}', '', 'func fetch(key string) (string, error) { return key, nil }', ''].join('\n');
const AT_HEAD = ['package kv', '', 'import "errors"', '', 'var errRange = errors.New("index out of range")', '',
  '// At returns s[i]; i must lie in [0, len(s)).', 'func At(s string, i int) (byte, error) {', '\tif i >= len(s) {', '\t\treturn 0, errRange', '\t}', '\treturn s[i], nil', '}', '',
  '// Load reads a record; a nil cache means "no cache".', 'func Load(key string, cache map[string]string) (string, error) {', '\tv := fetchOrEmpty(key)', '\tif v == "" {', '\t\treturn "", errors.New("missing")', '\t}',
  '\tstoreIn(cache, key, v)', '\treturn v, nil', '}', '', 'func fetch(key string) (string, error) { return key, nil }', '',
  'func fetchOrEmpty(key string) string { v, _ := fetch(key); return v }', '',
  'func storeIn(cache map[string]string, key, v string) {', '\t\tif cache != nil {', '\t\tcache[key] = v', '\t}', '}', ''].join('\n');
const AT_TEST = ['package kv', '', 'import "testing"', '', 'func TestAtNegative(t *testing.T) {', '\tif _, err := At("abc", -1); err == nil {', '\t\tt.Fatal("negative index accepted")', '\t}', '}', ''].join('\n');

function guardRepo(): { root: string; base: string } {
  const root = repo('round-cut-guard-');
  write(root, 'src/window.c', WINDOW_BASE);
  write(root, 'tests/window_test.c', WINDOW_TEST);
  write(root, 'kv/kv.go', AT_BASE);
  write(root, 'kv/kv_test.go', AT_TEST);
  const base = commit(root, 'baseline');
  write(root, 'src/window.c', WINDOW_HEAD);
  write(root, 'kv/kv.go', AT_HEAD);
  commit(root, 'refactor: stepped window, single At bound');
  return { root, base };
}
type Guard = { file: string; line: number; fn: string; text: string; cls: string; operand: string; confidence: string; reason: string; baseTests: string[] };

await check('G1 a removed `end != NULL` branch (run-75 shape) and a weakened `i < 0 || i >= len(s)` clause in functions that still exist are listed as clear removed guards with their base lines and base tests', async () => {
  const scan = await load('../core/removed-guard-scan.js', 'scanRemovedGuards');
  const { root, base } = guardRepo();
  try {
    const guards = scan({ gitCwd: root, base }) as Guard[];
    const window = guards.find(row => row.file === 'src/window.c' && row.operand === 'end');
    assert.ok(window, `the end guard is listed: ${JSON.stringify(guards)}`);
    assert.equal(window!.cls, 'null');
    assert.equal(window!.fn, 'window');
    assert.equal(window!.line, 10, 'base line of the removed branch');
    assert.match(window!.text, /end != NULL/);
    assert.equal(window!.confidence, 'clear', `the operand is still used and nothing else guards it: ${window!.reason}`);
    assert.ok(window!.baseTests.some(line => /window_test\.c:5/.test(line) && /NULL/.test(line)), `the base test of the null class is quoted: ${JSON.stringify(window!.baseTests)}`);
    const at = guards.find(row => row.file === 'kv/kv.go' && row.fn === 'At');
    assert.ok(at, `the weakened bound is listed: ${JSON.stringify(guards)}`);
    assert.equal(at!.cls, 'negative');
    assert.equal(at!.operand, 'i');
    assert.equal(at!.confidence, 'clear');
    assert.ok(at!.baseTests.some(line => /TestAtNegative|At\("abc", -1\)/.test(line)), `base test quoted: ${JSON.stringify(at!.baseTests)}`);
    assert.ok(!guards.some(row => row.fn === 'At' && row.cls === 'out_of_range'), 'the kept >= len(s) clause is not listed');
    assert.ok(!guards.some(row => row.operand === 'err'), 'an err != nil check is not an operand guard');
    assert.ok(!guards.some(row => row.operand === 'start'), 'an unchanged guard is not listed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await check('G2 a guard moved into a new helper the function calls is weak (advisory only), never clear', async () => {
  const scan = await load('../core/removed-guard-scan.js', 'scanRemovedGuards');
  const { root, base } = guardRepo();
  try {
    const guards = scan({ gitCwd: root, base }) as Guard[];
    const load2 = guards.find(row => row.fn === 'Load' && row.operand === 'cache');
    assert.ok(load2, `the moved cache guard is listed: ${JSON.stringify(guards)}`);
    assert.equal(load2!.confidence, 'weak', `moved into storeIn: ${load2!.reason}`);
    assert.match(load2!.reason, /storeIn|added elsewhere/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await check('G3 a checklist row or request sentence that states the class for the function or operand justifies the change (not listed)', async () => {
  const scan = await load('../core/removed-guard-scan.js', 'scanRemovedGuards');
  const { root, base } = guardRepo();
  try {
    const guards = scan({ gitCwd: root, base, rowTexts: ['`At("abc", -1)` -> `c` (a negative index counts from the end)'] }) as Guard[];
    assert.ok(!guards.some(row => row.fn === 'At'), `the row states the negative class of At: ${JSON.stringify(guards.map(row => row.fn))}`);
    assert.ok(guards.some(row => row.operand === 'end'), 'other guards stay');
    const byRequest = scan({ gitCwd: root, base, requestText: 'An explicit NULL `end` is now an error; callers pass end_omitted.' }) as Guard[];
    assert.ok(!byRequest.some(row => row.operand === 'end'), 'the request states the null end change');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await check('G4 dev.removedGuardScan resolves advisory by default, off / on as set, malformed = advisory; on records A/B evidence', async () => {
  const mode = await load('../core/ab-variants.js', 'removedGuardScanMode');
  const { abVariantEvidenceOf } = await import('../core/ab-variants.js');
  assert.equal(mode({}), 'advisory');
  assert.equal(mode({ dev: { removedGuardScan: 'on' } }), 'on');
  assert.equal(mode({ dev: { removedGuardScan: 'off' } }), 'off');
  assert.equal(mode({ dev: { removedGuardScan: 'yes' } }), 'advisory');
  assert.deepEqual(abVariantEvidenceOf({ dev: { removedGuardScan: 'on' } })?.flags, { 'dev.removedGuardScan': 'on' });
  assert.equal(abVariantEvidenceOf({}), undefined);
});

// ---------------------------------------------------------------------------
// M. N2 bound matrix (run-75 shape: F-001 fixed only the start clamp of a stepped-bounds helper; the end
// clamp 20 lines below was found by the next round)

const SPAN = ['package span', '', '// Bounds normalises a stepped range over n items.', 'func Bounds(n, start, end, step int) (int, int) {', '\tif step < 0 {',
  '\t\tif start < 0 {', '\t\t\tstart += n', '\t\t}', '\t\tif end < -n {', '\t\t\tend = 0', '\t\t}', '\t\treturn start, end', '\t}',
  '\tif start < 0 {', '\t\tstart = 0', '\t}', '\tif end > n {', '\t\tend = n', '\t}', '\treturn start, end', '}', '',
  '// Clamp keeps v in [0, max].', 'func Clamp(v, max int) int {', '\tif v > max {', '\t\treturn max', '\t}', '\treturn v', '}', ''].join('\n');

function matrixRepo(): string {
  const root = repo('round-cut-matrix-');
  write(root, 'span/span.go', SPAN);
  commit(root, 'span');
  return root;
}

await check('M1 a finding located in a helper that branches on several operands gets a bound matrix naming every operand and branch line; a one-branch helper gets none', async () => {
  const matrixFor = await load('../core/bound-matrix.js', 'boundMatrixFor');
  const render = await load('../core/bound-matrix.js', 'renderBoundMatrix');
  const root = matrixRepo();
  try {
    const finding = { id: 'B-1:F-001', desc: 'span/span.go:6 a negative step with a negative start wraps once but never clamps to 0. Repro: `Bounds(4, -9, 0, -1)`', files: ['span/span.go'] };
    const matrix = matrixFor({ gitCwd: root, finding }) as { fn: string; operands: string[]; branches: Array<{ line: number }> } | null;
    assert.ok(matrix, 'a matrix');
    assert.equal(matrix!.fn, 'Bounds');
    assert.deepEqual([...matrix!.operands].sort(), ['end', 'start', 'step']);
    assert.ok(matrix!.branches.length >= 5, `every branch line: ${JSON.stringify(matrix!.branches)}`);
    const text = (render(matrix) as string[]).join('\n');
    assert.match(text, /\[branch-test\]/);
    assert.match(text, /every branch/i);
    // Lab run89 (fix 2b-c): the exact line per operand; a missing one is asked for before the run ends (not a relaunch).
    assert.match(text, /^\s*\[branch-test\] Bounds start=<case>: <test name> -> <result>$/m, 'the exact line is stated');
    assert.match(text, /asked for the missing line/i, 'the check is stated');
    const byName = matrixFor({ gitCwd: root, finding: { id: 'B-1:F-002', desc: 'Bounds drops index 0 when end is below -n.', files: ['span/span.go'] } }) as { fn: string } | null;
    assert.equal(byName?.fn, 'Bounds', 'a finding naming the function (no line) is located by name');
    assert.equal(matrixFor({ gitCwd: root, finding: { id: 'B-1:F-003', desc: 'span/span.go:26 Clamp returns max for v == max.', files: ['span/span.go'] } }), null, 'one branch, one operand: no matrix');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await check('M2 the repair report must carry one [branch-test] line per operand of the matrix; a report covering only the reported branch is a problem', async () => {
  const problem = await load('../core/bound-matrix.js', 'branchTestProblem');
  const matrix = { fn: 'Bounds', file: 'span/span.go', line: 4, operands: ['end', 'start', 'step'], branches: [] };
  const partial = 'Fixed the start clamp.\n[branch-test] Bounds start=-9 step=-1: TestBoundsStart -> 0\n';
  const missing = problem(partial, matrix) as string | null;
  assert.ok(missing, 'missing operands are a problem');
  assert.match(missing!, /end/);
  assert.doesNotMatch(missing!, /\bstart\b.*\bstart\b/);
  const full = `${partial}[branch-test] Bounds end=-9 step=-1: TestBoundsEnd -> 0\n[branch-test] Bounds step=1: TestBoundsForward -> ok\n`;
  assert.equal(problem(full, matrix), null);
  assert.ok(problem(null, matrix), 'no report retained is a problem');
});

// ---------------------------------------------------------------------------
// D. N3 framework duplicate closure

await check('D1 a duplicate whose repro a test of the canonical repair commit states gets a framework coverage command; no repro or an absent repro keeps the owner step', async () => {
  const derive = await load('../core/duplicate-auto-coverage.js', 'frameworkDuplicateCoverage');
  const root = repo('round-cut-dup-');
  try {
    write(root, 'go.mod', 'module example.com/strs\n\ngo 1.21\n');
    write(root, 'strs/strs.go', 'package strs\n\nfunc Reverse(s string) string { r := []rune(s); for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 { r[i], r[j] = r[j], r[i] }; return string(r) }\n');
    write(root, 'strs/strs_test.go', 'package strs\n\nimport "testing"\n\nfunc TestBaseline(t *testing.T) {}\n');
    commit(root, 'base');
    write(root, 'strs/strs_test.go', 'package strs\n\nimport "testing"\n\nfunc TestBaseline(t *testing.T) {}\n\nfunc TestReverseEmpty(t *testing.T) {\n\tif Reverse("") != "" {\n\t\tt.Fatal("empty")\n\t}\n}\n');
    const repair = commit(root, 'B-1 F-001: resolve finding');
    const canonical = { id: 'B-1:F-001', status: 'resolved', resolutionType: 'fixed', desc: 'Reverse has no empty-string test.', resolvedReason: `Framework-verified repair: material commit ${repair.slice(0, 12)}.` } as unknown as Finding;
    const dup = { id: 'B-1:F-002', status: 'open', desc: 'Reverse of an empty string indexes past the end. Repro: `Reverse("")`', files: ['strs/strs.go'] } as unknown as Finding;
    const derived = derive({ gitCwd: root, finding: dup, canonical }) as { command: string; selector: string; resolution: string } | null;
    assert.ok(derived, 'derived');
    assert.equal(derived!.command, 'go test -v ./strs -run ^TestReverseEmpty$');
    assert.equal(derived!.selector, '--- PASS: TestReverseEmpty');
    assert.match(derived!.resolution, /TestReverseEmpty/);
    assert.match(derived!.resolution, new RegExp(repair.slice(0, 12)));
    assert.equal(derive({ gitCwd: root, finding: { ...dup, desc: 'Reverse of an empty string indexes past the end.' }, canonical }), null, 'no repro: the owner names the coverage');
    assert.equal(derive({ gitCwd: root, finding: { ...dup, desc: 'Reverse of a lone surrogate. Repro: `Reverse("\\xff")`' }, canonical }), null, 'a repro no repair test states: the owner step');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// X. N3b request exact-text literals at launch

const EXACT_REQUEST = 'Add `strs.Head(s, n)`.\nAn empty input fails with `strs: empty input not allowed for Head` (exact text).\n';

function dispatchStore(): { root: string; store: StoryStore; storyId: string } {
  const root = repo('round-cut-exact-');
  write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }, null, 2));
  write(root, 'strs/strs.go', 'package strs\n');
  commit(root, 'base');
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-7a3b';
  store.writeStory(storyId, { storyId, name: 'head', title: 'Head', description: 'Head.', type: 'feature', phase: 'DEV', priority: 'high',
    createdAt: NOW, startedAt: NOW, endedAt: null, events: [] } as unknown as StoryInfo);
  const files = { modify: ['strs/strs.go'], create: [], test: ['strs/strs_test.go'] };
  const row = (id: string, desc: string) => ({ id, desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' });
  store.writeChecklist(storyId, { items: [
    { id: 'CHK-001', title: 'Head of a string', context: 'Head returns the first n runes.', userSees: 'go test prints --- PASS: TestHead', status: 'in_progress', files,
      verificationIntent: { happy: [row('CHK-001:happy:0', 'Head("abc", 2) -> "ab"')], edge: [row('CHK-001:edge:0', 'Head("", 1) fails with strs: empty input not allowed for Head')], adversarial: [] } },
  ] } as unknown as ChecklistData);
  writeStoryRequest(store, { storyId, phase: 'INIT', request: EXACT_REQUEST, source: 'smoke' });
  return { root, store, storyId };
}

await check('X1 the implementer and the finding-repair prompts carry the request\'s exact-text literals with the whole-text assertion rule at launch', async () => {
  const render = await load('../core/exact-text-assertions.js', 'renderRequestExactLiterals');
  const lines = render(EXACT_REQUEST) as string[];
  assert.match(lines.join('\n'), /strs: empty input not allowed for Head/);
  assert.match(lines.join('\n'), /whole/i);
  assert.deepEqual(render('No literal here.'), []);
  const { root, store, storyId } = dispatchStore();
  try {
    const handlers = createStoryDispatchHandlers({ store, root, scanRoot: root } as never);
    const impl = (handlers.dispatch({ storyId, agentType: 'proof-or-stop-implementer', itemId: 'CHK-001' }) as { prompt: string }).prompt;
    assert.match(impl, /Request exact-text literals/, 'implementer prompt');
    store.writeFindings(storyId, { findings: [{ id: `${storyId}:F-001`, severity: 'medium', category: 'edge', desc: 'Head("") panics.', files: ['strs/strs.go'], status: 'open',
      evidenceState: 'verified', agent: 'proof-or-stop-review-quality', createdAt: NOW }] } as never);
    const repairPrompt = (handlers.dispatch({ storyId, agentType: 'proof-or-stop-finding-repair', findingId: 'F-001' }) as { prompt: string }).prompt;
    assert.match(repairPrompt, /Request exact-text literals/, 'repair prompt');
  } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// P. N4 pin probe

await check('P1 an inline index / range suffix on an assignment\'s right-hand side stays in the probe program (run-75 false positive)', async () => {
  const { probeCasesOf } = await import('../core/request-probes.js');
  const cases = probeCasesOf('CHK-002:adversarial:1', 'CHK-002', 'a = [1..9][1:4]; a.len() -> 3', null, { prose: true });
  assert.equal(cases.length, 1, JSON.stringify(cases));
  assert.deepEqual(cases[0]!.statements, ['a=[1..9][1:4]'], `the suffix is kept: ${JSON.stringify(cases[0]!.statements)}`);
  const plain = probeCasesOf('CHK-002:happy:0', 'CHK-002', 'a = [1, 2, 3]; a.len() -> 3', null, { prose: true });
  assert.deepEqual(plain[0]!.statements, ['a=[1, 2, 3]'], 'a plain literal binding is unchanged');
});

await check('P2 a probed write whose target form a request example defines is new behaviour (advisory with the base value), not a refusal; a read of the same receiver stays judged', async () => {
  const isNew = await load('../core/plan-pin-probe.js', 'requestDefinesWrite');
  const { probeCasesOf } = await import('../core/request-probes.js');
  const request = 'Range assignment: `a[1:3] = [20, 30]` replaces the elements 1 and 2.\nReads stay as they are: `a[1]` returns the element.';
  const [write1] = probeCasesOf('CHK-004:happy:0', 'CHK-004', 'a = [1, 2, 3, 4, 5]; a[1:3] = [20, 30]; a -> [1, 20, 30, 4, 5]', null, { prose: true });
  assert.ok(write1, 'case');
  assert.equal(isNew(write1, request), true, 'the request defines range assignment');
  const [read1] = probeCasesOf('CHK-004:happy:1', 'CHK-004', 'a = [1, 2, 3]; a[1] -> 2', null, { prose: true });
  assert.equal(isNew(read1, request), false, 'a read is still judged on the base');
  const [single] = probeCasesOf('CHK-004:happy:2', 'CHK-004', 'a = [1, 2, 3]; a[1] = 9; a -> [1, 9, 3]', null, { prose: true });
  assert.equal(isNew(single, request), false, 'a write form the request does not show stays judged');
});

await check('P3 a whole-intent checklist_update built from older rows (intentBasis) is refused instead of overwriting the owner\'s newer row fix', async () => {
  const basisOf = await load('../core/intent-basis.js', 'intentBasisDigest');
  const { root, store, storyId } = dispatchStore();
  try {
    const story = store.readStory(storyId);
    store.writeStory(storyId, { ...story, phase: 'PLAN' } as StoryInfo);
    const item = store.readChecklist(storyId).items[0]! as ChecklistItem;
    const stale = basisOf(item.verificationIntent) as string;
    // The owner fixes a row after the authoring payload was built.
    const fixed = { ...item.verificationIntent!, happy: [{ ...item.verificationIntent!.happy[0]!, desc: 'Head("abc", 2) -> "ab" (owner fix)' }] };
    store.writeChecklist(storyId, { items: [{ ...item, verificationIntent: fixed }] } as unknown as ChecklistData);
    const { createChecklistHandlers } = await import('../handlers/checklist.js') as unknown as { createChecklistHandlers: (ctx: unknown) => Record<string, Fn> };
    const handlers = createChecklistHandlers({ store, root, scanRoot: root });
    assert.throws(() => handlers.checklist_update!({ storyId, itemId: 'CHK-001', verificationIntent: item.verificationIntent, intentBasis: stale }),
      /authoring_payload_stale[\s\S]*Next: proof-or-stop next/, 'refused with one Next');
    assert.equal(store.readChecklist(storyId).items[0]!.verificationIntent!.happy[0]!.desc, 'Head("abc", 2) -> "ab" (owner fix)', 'the newer fix stays');
  } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
});

if (failures.length) {
  console.error(`round-cut-smoke: FAIL (${failures.length}: ${failures.join('; ')})`);
  process.exit(1);
}
console.log('round-cut-smoke: PASS');
