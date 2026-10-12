#!/usr/bin/env node
/**
 * Old-PoS run 58 (bench-staging/oldpos/run58-analysis.md §4, §7 fixes A-H):
 * unit level, with real git repositories and real `go test` runs. Generic
 * examples only: a toy `seq` package over a fixed list with a pre-existing
 * two-part window `Win(lo)` (a negative start is clamped to 0) and the Story's
 * new stepped form `Step(lo, st)`. No benchmark-task material.
 *
 * Run 58 timed out in REVIEW: the resolved-finding regression guard replayed
 * whole old test functions from repair-commit snapshots, some of which encoded
 * pre-pin or wrong behaviour, so it blamed correct repairs; every pin reset all
 * touched items to pending; a pin reversed an earlier PLAN pin against the
 * oracle order; duplicate conflict findings were pinned one at a time; a
 * suspected conflict waited a full round.
 *
 *   A. The guard runs the finding's own repro rows (the table rows of its repair
 *      test that state its repro), not every row of every touched test
 *      function: a stale row of another case no longer blames a later repair.
 *      Control: a repair that breaks the repro row itself is still blamed.
 *   B. Before blaming, the failing guard is run on the Story base: when the
 *      current code fails it exactly like the base (it keeps the base's
 *      behaviour) and no current checklist row pins the case, the snapshot is
 *      wrong, not the repair (excused). Controls: a current pin that states the
 *      snapshot's value keeps the blame; a reversal of NEW behaviour (the base
 *      cannot build the test) keeps the blame.
 *   C. Checklist epoch: a guard whose case a checklist row re-pinned after the
 *      finding's resolution (to a value the snapshot does not state) is retired.
 *      Control: an unchanged pin keeps the guard.
 *   D. A PLAN amendment keeps a done item done when the pinned tests of its rows
 *      pass on the current code (and an amended row is covered by its pinned
 *      test); only failing items go pending.
 *   E. finding_conflict_pin gives the oracle order and the rows that pin the case
 *      now; a re-PLAN checklist_update that silently reverses an earlier pin is
 *      refused ([pin_reversal_unstated]) until the row states the re-pin.
 *   F. Conflict findings on one case fold into ONE pin step; an open SUSPECTED
 *      `[precedent-conflict]` finding joins it (no extra round); a case a current
 *      checklist row already pins needs no pin step.
 *   G. plan.baseDisagreement asks for combined special cases (a negative bound
 *      together with a negative step), generically.
 *   H. review_round_prepare defaults the fullScanReason when the earlier
 *      full-scan route only went stale.
 *   P. review.siblingParity defaults to off (on = the recorded arm; malformed = off).
 *
 * Usage: node packages/main/dist/tasks/run58-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as abVariants from '../core/ab-variants.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, ChecklistItem, Finding, StoryInfo } from '../core/types.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import * as nextDriver from '../handlers/next-driver.js';
import * as roundPrepare from '../handlers/review-round-prepare.js';

type Fn = (...args: unknown[]) => unknown;
const loadModule = async (path: string): Promise<object> => { try { return await import(path) as object; } catch { return {}; } };
const guardModule = await loadModule('../core/resolved-finding-guard.js');
const api = (module: object, name: string): Fn => {
  const fn = (module as Record<string, unknown>)[name];
  assert.equal(typeof fn, 'function', `${name} is exported`);
  return fn as Fn;
};
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error)}`); }
}
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const commit = (root: string, message: string): string => { git(root, ['add', '-A']); git(root, ['commit', '-qm', message]); return git(root, ['rev-parse', 'HEAD']); };
const sleep = (seconds: number): void => { execFileSync('sleep', [String(seconds)]); };

// ---------------------------------------------------------------------------
// Toy Go package: Win (pre-existing, clamps a negative start) and the Story's Step

const HEAD = ['package seq', '', 'import "fmt"', '', 'var xs = []int{0, 1, 2, 3, 4, 5}', ''];
const WIN_CLAMP = ['// Win is the two-part window: a negative start is clamped to 0.', 'func Win(lo int) string {', '\tif lo < 0 {', '\t\tlo = 0', '\t}',
  '\tif lo > len(xs) {', '\t\tlo = len(xs)', '\t}', '\treturn fmt.Sprint(xs[lo:])', '}', ''];
const WIN_ERRORS = ['// Win is the two-part window.', 'func Win(lo int) string {', '\tif lo < 0 {', '\t\treturn "error"', '\t}',
  '\tif lo > len(xs) {', '\t\tlo = len(xs)', '\t}', '\treturn fmt.Sprint(xs[lo:])', '}', ''];
/** Step v0 (the Story's first cut): a start past the end is an error. */
const STEP_V0 = ['// Step is the stepped window.', 'func Step(lo, st int) string {', '\tif lo >= len(xs) {', '\t\treturn "error"', '\t}', '\tif lo < 0 {', '\t\tlo = 0', '\t}', '\tout := []int{}',
  '\tfor i := lo; i < len(xs); i += st {', '\t\tout = append(out, xs[i])', '\t}', '\treturn fmt.Sprint(out)', '}', ''];
/** Step v1: a start past the end is empty; a negative start is clamped (the first PLAN pin). */
const STEP_CLAMP = ['// Step is the stepped window.', 'func Step(lo, st int) string {', '\tif lo < 0 {', '\t\tlo = 0', '\t}', '\tout := []int{}',
  '\tif lo >= len(xs) {', '\t\treturn fmt.Sprint(out)', '\t}', '\tfor i := lo; i < len(xs); i += st {', '\t\tout = append(out, xs[i])', '\t}', '\treturn fmt.Sprint(out)', '}', ''];
/** Step v2: a negative start counts from the end (the later pin). */
const STEP_FROM_END = ['// Step is the stepped window.', 'func Step(lo, st int) string {', '\tif lo < 0 {', '\t\tlo += len(xs)', '\t}', '\tif lo < 0 {', '\t\tlo = 0', '\t}', '\tout := []int{}',
  '\tif lo >= len(xs) {', '\t\treturn fmt.Sprint(out)', '\t}', '\tfor i := lo; i < len(xs); i += st {', '\t\tout = append(out, xs[i])', '\t}', '\treturn fmt.Sprint(out)', '}', ''];
/** Step v2 with the out-of-range guard lost (a real reversal of F-001's fix). */
const STEP_FROM_END_UNGUARDED = ['// Step is the stepped window.', 'func Step(lo, st int) string {', '\tif lo < 0 {', '\t\tlo += len(xs)', '\t}', '\tif lo < 0 {', '\t\tlo = 0', '\t}', '\tout := []int{}',
  '\tfor i := lo; i < len(xs); i += st {', '\t\tout = append(out, xs[i])', '\t}', '\tif len(out) == 0 {', '\t\treturn "error"', '\t}', '\treturn fmt.Sprint(out)', '}', ''];

const testFile = (fns: string[][]): string => ['package seq', '', 'import "testing"', '', ...fns.flat()].join('\n');
const tableTest = (name: string, rows: string[]): string[] => [`func ${name}(t *testing.T) {`, '\ttests := []struct {', '\t\tname string', '\t\tgot  string', '\t\twant string', '\t}{',
  ...rows.map(row => `\t\t${row},`), '\t}', '\tfor _, tt := range tests {', '\t\tif tt.got != tt.want {', '\t\t\tt.Errorf("%s: got %s, want %s", tt.name, tt.got, tt.want)', '\t\t}', '\t}', '}', ''];

const STORY_ID = 'B-58a1';
const F = (n: number) => `${STORY_ID}:F-${String(n).padStart(3, '0')}`;
const NOW = '2026-10-12T03:00:00.000Z';
const CHECKLIST_REL = '.proof-or-stop/story/actives/B-58a1/checklist.json';

interface Repo { root: string; store: StoryStore; base: string }

function repo(baseFiles: Record<string, string>, checklistRows: string[] = []): Repo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run58-seq-')));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' } }, null, 2));
  write(root, 'go.mod', 'module example.com/seq\n\ngo 1.21\n');
  for (const [path, text] of Object.entries(baseFiles)) write(root, path, text);
  const base = commit(root, 'baseline');
  resetConfigCache();
  const store = new StoryStore(root);
  store.writeStory(STORY_ID, { storyId: STORY_ID, name: 'seq-step', title: 'Stepped window', description: 'Add Step.', type: 'feature', phase: 'DEV', priority: 'high',
    createdAt: NOW, startedAt: NOW, endedAt: null, events: [{ phase: 'PLAN', action: 'advance', timestamp: NOW }, { phase: 'DEV', action: 'advance', timestamp: NOW }] } as StoryInfo);
  // The Story has been in DEV: a recorded phase_transition (the story events list alone is not evidence, a refused DEV entry leaves it too).
  store.appendProcessEvent(STORY_ID, { type: 'phase_transition', storyId: STORY_ID, fromPhase: 'PLAN', toPhase: 'DEV' } as never);
  setRows(store, checklistRows);
  commit(root, 'B-58a1 metadata');
  return { root, store, base };
}
function setRows(store: StoryStore, rows: string[]): void {
  store.writeChecklist(STORY_ID, { items: [{ id: 'CHK-001', title: 'Step', context: 'seq/seq.go', userSees: 'Step(1, 2) returns [1 3 5]',
    files: { modify: ['seq/seq.go'], create: [], test: ['seq/seq_test.go'] }, status: 'done', startTime: null, endTime: null,
    ...(rows.length ? { verificationIntent: { happy: rows.map(desc => ({ desc, type: 'logic', priority: 'must' })) } } : {}) }] as unknown as ChecklistItem[] } as ChecklistData);
}
const finding = (n: number, desc: string, extra: Partial<Finding> = {}): Finding => ({ id: F(n), desc, severity: 'medium', category: 'edge', status: 'open',
  evidenceState: 'verified', agent: 'proof-or-stop-review-test-coverage', createdAt: NOW, files: ['seq/seq.go'], ...extra } as Finding);
const resolvedAt = (n: number, desc: string, commitSha: string, at = NOW): Finding => finding(n, desc, { status: 'resolved', resolutionType: 'fixed', resolvedAt: at,
  resolvedReason: `Framework-verified repair of ${F(n)}: material commit ${commitSha.slice(0, 12)} of managed finding-repair run run-${n}, bound to ${F(n)} and completed.` });
const memoryEvents = () => {
  const events: Array<Record<string, unknown>> = [];
  return { events, store: { readProcessEvents: () => events, appendProcessEvent: (_id: string, event: Record<string, unknown>) => { events.push(event); } } };
};
type GuardFailure = { guarded: Finding; result: { passed: boolean; command: string; restoredTests: boolean }; blamed: Array<{ findingId: string; commit: string }> };
function guardCheck(fx: Repo, findings: Finding[], repair: { findingId: string; commit: string }, memory = memoryEvents()): { out: GuardFailure[]; events: Array<Record<string, unknown>> } {
  const checklist = {
    current: fx.store.readChecklist(STORY_ID).items,
    at: (iso: string) => { try {
      const sha = git(fx.root, ['log', '-1', '--format=%H', `--before=${iso}`, '--', CHECKLIST_REL]);
      return sha ? (JSON.parse(git(fx.root, ['show', `${sha}:${CHECKLIST_REL}`])) as ChecklistData).items : undefined;
    } catch { return undefined; } },
  };
  const out = api(guardModule, 'regressionGuardCheck')({ store: memory.store, projectRoot: fx.root, gitCwd: fx.root, storyId: STORY_ID, findings,
    repairs: [repair], repairCommitOf: (row: Finding) => api(guardModule, 'repairCommitFromResolution')(fx.root, row), coverageOf: () => null,
    headHash: repair.commit, materialHash: null, baseRef: fx.base, checklist }) as GuardFailure[];
  return { out, events: memory.events };
}

// ---------------------------------------------------------------------------
// A. the guard runs the finding's own repro rows

const F1_DESC = 'seq/seq.go Step panics on a start past the end. Repro: `Step(9, 1)`';
const F2_DESC = 'seq/seq.go Step must count a negative start from the end (the re-pinned row). Repro: `Step(-2, 1)`';

/** Base (Win), the Story's Step v0, F-001's repair (Step v1 + TestStep with its repro row AND the then-pinned clamp row of another case). */
function staleRowFixture(): Repo & { repair1: string } {
  const fx = repo({ 'seq/seq.go': [...HEAD, ...WIN_CLAMP].join('\n'), 'seq/seq_test.go': testFile([['func TestBaseline(t *testing.T) {}', '']]) });
  write(fx.root, 'seq/seq.go', [...HEAD, ...WIN_CLAMP, ...STEP_V0].join('\n'));
  commit(fx.root, 'B-58a1 CHK-001: Step');
  write(fx.root, 'seq/seq.go', [...HEAD, ...WIN_CLAMP, ...STEP_CLAMP].join('\n'));
  write(fx.root, 'seq/seq_test.go', testFile([tableTest('TestStep', ['{"Step(9, 1)", Step(9, 1), "[]"}', '{"Step(-2, 1)", Step(-2, 1), "[0 1 2 3 4 5]"}', '{"Step(1, 2)", Step(1, 2), "[1 3 5]"}'])]));
  const repair1 = commit(fx.root, 'B-58a1 F-001: Step of a start past the end is empty');
  return { ...fx, repair1 };
}

await check('A1 the guard runs only the rows of the repair test that state the finding\'s repro: a stale row of another case no longer blames a later repair', () => {
  const fx = staleRowFixture();
  try {
    // F-002's repair implements the later pin (negative start from the end) and updates the row.
    write(fx.root, 'seq/seq.go', [...HEAD, ...WIN_CLAMP, ...STEP_FROM_END].join('\n'));
    write(fx.root, 'seq/seq_test.go', testFile([tableTest('TestStep', ['{"Step(9, 1)", Step(9, 1), "[]"}', '{"Step(-2, 1)", Step(-2, 1), "[4 5]"}', '{"Step(1, 2)", Step(1, 2), "[1 3 5]"}'])]));
    const repair2 = commit(fx.root, 'B-58a1 F-002: Step counts a negative start from the end');
    const { out, events } = guardCheck(fx, [resolvedAt(1, F1_DESC, fx.repair1), finding(2, F2_DESC)], { findingId: F(2), commit: repair2 });
    assert.deepEqual(out.map(row => row.guarded.id), [], `F-001's own case Step(9, 1) still holds; the stale clamp row of Step(-2, 1) is not F-001's: ${JSON.stringify(events)}`);
    const event = events.find(row => row.findingId === F(1));
    assert.equal(event?.passed, true, 'F-001\'s guard ran and passed');
    assert.equal(event?.scope, 'repro', 'the guard ran the repro rows (scope recorded)');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

await check('A2 control: a repair that breaks the finding\'s own repro row (and rewrites the test to hide it) is still blamed, the Story base check does not excuse new behaviour', () => {
  const fx = staleRowFixture();
  try {
    write(fx.root, 'seq/seq.go', [...HEAD, ...WIN_CLAMP, ...STEP_FROM_END_UNGUARDED].join('\n'));
    write(fx.root, 'seq/seq_test.go', testFile([tableTest('TestStep', ['{"Step(9, 1)", Step(9, 1), "error"}', '{"Step(-2, 1)", Step(-2, 1), "[4 5]"}'])]));
    const repair2 = commit(fx.root, 'B-58a1 F-002: Step counts a negative start from the end');
    const { out } = guardCheck(fx, [resolvedAt(1, F1_DESC, fx.repair1), finding(2, F2_DESC)], { findingId: F(2), commit: repair2 });
    assert.deepEqual(out.map(row => row.guarded.id), [F(1)], 'F-001\'s repro row fails as recorded');
    assert.deepEqual(out[0]!.blamed, [{ findingId: F(2), commit: repair2 }], 'the repair that broke it is blamed');
    assert.equal(out[0]!.result.restoredTests, true, 'the row ran as recorded (the repair rewrote it)');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

await check('A3 filterGoTestRows keeps the rows stating a repro (whole groups otherwise untouched); no match leaves the body unchanged', () => {
  const body = tableTest('TestStep', ['{"Step(9, 1)", Step(9, 1), "[]"}', '{"Step(-2, 1)", Step(-2, 1), "[0 1 2 3 4 5]"}']).join('\n');
  const kept = api(guardModule, 'filterGoTestRows')(body, ['Step(9, 1)']) as { body: string; matched: boolean; dropped: number };
  assert.equal(kept.matched, true);
  assert.equal(kept.dropped, 1, 'one other row dropped');
  assert.match(kept.body, /Step\(9, 1\)/);
  assert.doesNotMatch(kept.body, /Step\(-2, 1\)/);
  const none = api(guardModule, 'filterGoTestRows')(body, ['Win(3)']) as { body: string; matched: boolean; dropped: number };
  assert.equal(none.matched, false);
  assert.equal(none.body, body);
  const nested = ['func TestNested(t *testing.T) {', '\twant := [][]int{{1}, {2}}', '\tif len(want) != 2 || Step(9, 1) != "[]" {', '\t\tt.Fatal("x")', '\t}', '}'].join('\n');
  const plain = api(guardModule, 'filterGoTestRows')(nested, ['Step(9, 1)']) as { body: string; matched: boolean; dropped: number };
  assert.deepEqual([plain.matched, plain.dropped, plain.body], [true, 0, nested], 'a literal group without a repro row is never filtered');
});

// ---------------------------------------------------------------------------
// B. the Story base and the current pins before blaming

const F3_DESC = 'seq/seq.go Win of a negative start must report an error. Repro: `Win(-2)`';
const F4_DESC = 'seq/seq.go Win(-2) now errors: the request keeps the existing window unchanged. Repro: `Win(-3)`';

/** Base (Win clamps); F-003's (wrong) repair makes Win(-2) an error with a test row; F-004's repair restores the base behaviour. */
function baseFixture(rows: string[] = []): Repo & { repair1: string; repair2: string } {
  const fx = repo({ 'seq/seq.go': [...HEAD, ...WIN_CLAMP].join('\n'), 'seq/seq_test.go': testFile([['func TestBaseline(t *testing.T) {}', '']]) }, rows);
  write(fx.root, 'seq/seq.go', [...HEAD, ...WIN_ERRORS].join('\n'));
  write(fx.root, 'seq/seq_test.go', testFile([tableTest('TestWinNegative', ['{"Win(-2)", Win(-2), "error"}'])]));
  const repair1 = commit(fx.root, 'B-58a1 F-003: Win reports a negative start');
  write(fx.root, 'seq/seq.go', [...HEAD, ...WIN_CLAMP].join('\n'));
  write(fx.root, 'seq/seq_test.go', testFile([tableTest('TestWinNegative', ['{"Win(-2)", Win(-2), "[0 1 2 3 4 5]"}', '{"Win(-3)", Win(-3), "[0 1 2 3 4 5]"}'])]));
  const repair2 = commit(fx.root, 'B-58a1 F-004: Win keeps the base clamp');
  return { ...fx, repair1, repair2 };
}

await check('B1 a guard that fails exactly as the Story base does (the code keeps the base behaviour) and no current pin states the case is excused, not blamed', () => {
  const fx = baseFixture();
  try {
    const { out, events } = guardCheck(fx, [resolvedAt(3, F3_DESC, fx.repair1), finding(4, F4_DESC)], { findingId: F(4), commit: fx.repair2 });
    assert.deepEqual(out.map(row => row.guarded.id), [], `F-003's snapshot contradicts the Story base: ${JSON.stringify(events)}`);
    const event = events.find(row => row.findingId === F(3));
    assert.equal(event?.passed, false, 'the guard itself failed');
    assert.equal(event?.excused, 'story_base', 'excused: the current code computes what the Story base computes');
    assert.equal(event?.rejectedRepairs, undefined, 'no repair is rejected');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

await check('B2 control: a current checklist row pinning the snapshot\'s value keeps the blame (the Story deliberately changes that base behaviour)', () => {
  const fx = baseFixture(['`Win(-2) -> error` (the Story changes the window)']);
  try {
    const { out } = guardCheck(fx, [resolvedAt(3, F3_DESC, fx.repair1), finding(4, F4_DESC)], { findingId: F(4), commit: fx.repair2 });
    assert.deepEqual(out.map(row => row.guarded.id), [F(3)], 'the pin states the snapshot value: a real regression of the pin');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

await check('B3 a guard whose snapshot contradicts a current checklist pin of the case is excused (the pin decides)', () => {
  const fx = baseFixture(['`Win(-2) -> [0 1 2 3 4 5]` (the existing window is unchanged)']);
  try {
    const { out, events } = guardCheck(fx, [resolvedAt(3, F3_DESC, fx.repair1), finding(4, F4_DESC)], { findingId: F(4), commit: fx.repair2 });
    assert.deepEqual(out.map(row => row.guarded.id), [], 'the current pin contradicts the snapshot');
    assert.equal(events.find(row => row.findingId === F(3))?.excused, 'checklist_pin');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// C. checklist epoch

const F5_DESC = 'seq/seq.go Step of a negative start is wrong. Repro: `Step(-2, 1)`';
const F6_DESC = 'seq/seq.go Step must follow the re-pinned row. Repro: `Step(-3, 1)`';
/** F-005 resolved with its repro row pinned to the clamp; later the checklist row of that case changes (or not); F-006's repair implements from-end. */
function epochFixture(repin: boolean): { fx: Repo; findings: Finding[]; repair2: string } {
  const fx = repo({ 'seq/seq.go': [...HEAD, ...WIN_CLAMP].join('\n'), 'seq/seq_test.go': testFile([['func TestBaseline(t *testing.T) {}', '']]) }, ['`Step(-2, 1) -> [0 1 2 3 4 5]` (clamped like Win)']);
  write(fx.root, 'seq/seq.go', [...HEAD, ...WIN_CLAMP, ...STEP_CLAMP].join('\n'));
  write(fx.root, 'seq/seq_test.go', testFile([tableTest('TestStepNegative', ['{"Step(-2, 1)", Step(-2, 1), "[0 1 2 3 4 5]"}'])]));
  const repair1 = commit(fx.root, 'B-58a1 F-005: Step clamps a negative start');
  sleep(1.1);
  const at = new Date().toISOString();
  sleep(1.1);
  if (repin) { setRows(fx.store, ['`Step(-2, 1) -> [4 5]` (from the end; re-pin of the clamp row)']); commit(fx.root, 'B-58a1 PLAN re-pin'); }
  write(fx.root, 'seq/seq.go', [...HEAD, ...WIN_CLAMP, ...STEP_FROM_END].join('\n'));
  write(fx.root, 'seq/seq_test.go', testFile([tableTest('TestStepNegative', ['{"Step(-2, 1)", Step(-2, 1), "[4 5]"}', '{"Step(-3, 1)", Step(-3, 1), "[3 4 5]"}'])]));
  const repair2 = commit(fx.root, 'B-58a1 F-006: Step counts a negative start from the end');
  return { fx, findings: [resolvedAt(5, F5_DESC, repair1, at), finding(6, F6_DESC)], repair2 };
}

await check('C1 a guard whose case was re-pinned after the finding\'s resolution is retired by the checklist epoch (recorded), not run against the new code', () => {
  const { fx, findings, repair2 } = epochFixture(true);
  try {
    const { out, events } = guardCheck(fx, findings, { findingId: F(6), commit: repair2 });
    assert.deepEqual(out.map(row => row.guarded.id), [], `the re-pin changed F-005's expectation: ${JSON.stringify(events)}`);
    const retired = events.find(row => row.type === 'resolved_finding_guard_retired' && row.findingId === F(5));
    assert.ok(retired, 'a retirement event is recorded');
    assert.equal(retired!.reason, 'checklist_epoch');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

await check('C2 control: with the pin unchanged since the resolution, a repair contradicting it is blamed', () => {
  const { fx, findings, repair2 } = epochFixture(false);
  try {
    const { out } = guardCheck(fx, findings, { findingId: F(6), commit: repair2 });
    assert.deepEqual(out.map(row => row.guarded.id), [F(5)], 'the unchanged pin still states the snapshot\'s value');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// D. a pin keeps done items done when their pinned tests pass

function planStory(): { fx: Repo; handlers: { checklist_update: (args: Record<string, unknown>) => unknown } } {
  const fx = repo({ 'seq/seq.go': [...HEAD, ...WIN_CLAMP].join('\n'), 'seq/seq_test.go': testFile([['func TestBaseline(t *testing.T) {}', '']]) });
  write(fx.root, 'seq/seq.go', [...HEAD, ...WIN_CLAMP, ...STEP_FROM_END].join('\n'));
  write(fx.root, 'seq/seq_test.go', testFile([tableTest('TestStep', ['{"Step(1, 2)", Step(1, 2), "[1 3 5]"}', '{"Step(-2, 1)", Step(-2, 1), "[4 5]"}']),
    tableTest('TestWin', ['{"Win(2)", Win(2), "[2 3 4 5]"}'])]));
  commit(fx.root, 'B-58a1 CHK-001 CHK-002');
  const pin = (test: string) => ({ command: `go test -v ./seq -run ^${test}$`, selector: `--- PASS: ${test}` });
  fx.store.writeStory(STORY_ID, { ...fx.store.readStory(STORY_ID), phase: 'PLAN', events: [...(fx.store.readStory(STORY_ID).events ?? []), { phase: 'PLAN', action: 'rollback', timestamp: NOW }] } as StoryInfo);
  fx.store.writeChecklist(STORY_ID, { items: [
    { id: 'CHK-001', title: 'Step', context: 'seq/seq.go', userSees: 'Step(1, 2) returns [1 3 5]', files: { modify: ['seq/seq.go'], create: [], test: ['seq/seq_test.go'] }, status: 'done', startTime: null, endTime: null,
      verificationIntent: { happy: [{ desc: '`Step(1, 2) -> [1 3 5]`', type: 'logic', priority: 'must', verification: pin('TestStep') }] } },
    { id: 'CHK-002', title: 'Win next to Step', context: 'seq/seq.go; shares the bounds of CHK-001', userSees: 'Win(2) returns [2 3 4 5]', files: { modify: ['seq/seq.go'], create: [], test: ['seq/seq_test.go'] }, status: 'done', startTime: null, endTime: null,
      verificationIntent: { happy: [{ desc: '`Win(2) -> [2 3 4 5]`', type: 'logic', priority: 'must', verification: pin('TestWin') }] } },
  ] as unknown as ChecklistItem[] } as ChecklistData);
  commit(fx.root, 'B-58a1 back to PLAN');
  const created = createChecklistHandlers({ store: fx.store, root: fx.root, scanRoot: fx.root } as never);
  return { fx, handlers: { checklist_update: (args: Record<string, unknown>) => created.checklist_update(args as never) } };
}
const statusOf = (fx: Repo, id: string) => fx.store.readChecklist(STORY_ID).items.find(item => item.id === id)?.status;

await check('D1 a pin that the code already satisfies (its row is in a passing pinned test) keeps the amended item and its dependent done', () => {
  const { fx, handlers } = planStory();
  try {
    const out = String(handlers.checklist_update({ storyId: STORY_ID, itemId: 'CHK-001', verificationIntent: { happy: [
      { desc: '`Step(1, 2) -> [1 3 5]`', type: 'logic', priority: 'must', verification: { command: 'go test -v ./seq -run ^TestStep$', selector: '--- PASS: TestStep' } },
      { desc: '`Step(-2, 1) -> [4 5]` (from the end, pinned for the conflict)', type: 'logic', priority: 'must', verification: { command: 'go test -v ./seq -run ^TestStep$', selector: '--- PASS: TestStep' } }] } }));
    assert.equal(statusOf(fx, 'CHK-001'), 'done', `the amended item stays done: ${out}`);
    assert.equal(statusOf(fx, 'CHK-002'), 'done', 'the dependent item stays done (its pinned test passes)');
    assert.match(out, /kept done/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

await check('D2 control: an amended row no pinned test covers sends the item to pending; a dependent whose pinned test fails goes pending too', () => {
  const { fx, handlers } = planStory();
  try {
    write(fx.root, 'seq/seq_test.go', testFile([tableTest('TestStep', ['{"Step(1, 2)", Step(1, 2), "[1 3 5]"}']), tableTest('TestWin', ['{"Win(2)", Win(2), "[9]"}'])]));
    commit(fx.root, 'B-58a1 a failing Win test');
    handlers.checklist_update({ storyId: STORY_ID, itemId: 'CHK-001', verificationIntent: { happy: [
      { desc: '`Step(1, 2) -> [1 3 5]`', type: 'logic', priority: 'must', verification: { command: 'go test -v ./seq -run ^TestStep$', selector: '--- PASS: TestStep' } },
      { desc: '`Step(-3, 1) -> [3 4 5]` (from the end)', type: 'logic', priority: 'must' }] } });
    assert.equal(statusOf(fx, 'CHK-001'), 'pending', 'the new row is not covered by a pinned test');
    assert.equal(statusOf(fx, 'CHK-002'), 'pending', 'the dependent\'s pinned test fails');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// E. pin oracle order and the silent reversal of an earlier pin

await check('E1 a re-PLAN checklist_update that reverses an earlier pinned value without stating it is refused; stating the re-pin passes; the first PLAN is free', () => {
  const { fx, handlers } = planStory();
  try {
    const row = (desc: string, computation?: string) => ({ storyId: STORY_ID, itemId: 'CHK-001', verificationIntent: { happy: [
      { desc, type: 'logic', priority: 'must', ...(computation ? { derivation: { requestQuote: 'Step works like Win.', computation } } : {}) }] } });
    assert.throws(() => handlers.checklist_update(row('`Step(1, 2) -> [1]`')), (error: Error) => /\[pin_reversal_unstated\]/.test(error.message)
      && /Step\(1, 2\)/.test(error.message) && /\[1 3 5\]/.test(error.message) && /SAME receiver's pre-existing counterpart/.test(error.message), 'refused with the case, the earlier value and the oracle order');
    assert.equal(statusOf(fx, 'CHK-001'), 'done', 'nothing written');
    const out = String(handlers.checklist_update(row('`Step(1, 2) -> [1]`', 're-pin: Step(1, 2) was [1 3 5]; the request sentence decides [1]')));
    assert.match(out, /verificationIntent updated/);
    // First PLAN (never in DEV): no refusal.
    fx.store.writeStory(STORY_ID, { ...fx.store.readStory(STORY_ID), events: [{ phase: 'PLAN', action: 'advance', timestamp: NOW }] } as StoryInfo);
    rmSync(join(fx.root, '.proof-or-stop/story/actives', STORY_ID, 'process-events.jsonl'), { force: true });
    handlers.checklist_update(row('`Step(1, 2) -> [9]`'));
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// F. conflict findings fold into one pin step; suspected conflicts join it

const PRECEDENT = (n: number, extra = '') => `[precedent-conflict] seq/seq.go Step of a negative start: Win clamps it, a single index counts it from the end; nothing pins which applies${extra}. Repro: \`Step(-2, -1)\``;
await check('F1 one pin step folds every conflict finding (a suspected [precedent-conflict] included) and gives the oracle order and the rows pinning the case', () => {
  const fx = repo({ 'seq/seq.go': [...HEAD, ...WIN_CLAMP].join('\n') }, ['`Step(-2, 1) -> [0 1 2 3 4 5]` (clamped like Win)']);
  try {
    sleep(1.1);
    const at = new Date().toISOString();
    const suspected = finding(4, PRECEDENT(4), { evidenceState: 'suspected', createdAt: at });
    const open = [finding(7, PRECEDENT(7, ' (again)'), { createdAt: at }), finding(9, PRECEDENT(9, ' (third filing)'), { createdAt: at })];
    fx.store.writeFindings(STORY_ID, { findings: [suspected, ...open] } as never);
    const step = api(nextDriver, 'findingConflictStep')({ root: fx.root, gitCwd: fx.root, store: fx.store, base: { storyId: STORY_ID, phase: 'DEV' }, open, repaired: () => false }) as { reason: string; why: string } | null;
    assert.equal(step?.reason, 'finding_conflict_pin');
    for (const id of ['F-004', 'F-007', 'F-009']) assert.match(step!.why, new RegExp(`${STORY_ID}:${id}`), `${id} is folded into the one pin step`);
    assert.match(step!.why, /Oracle order/, 'the oracle order');
    assert.match(step!.why, /SAME receiver's pre-existing counterpart/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

await check('F2 a conflict whose case a current checklist row already pins needs no pin step (the row decides; the finding is repaired against it)', () => {
  const fx = repo({ 'seq/seq.go': [...HEAD, ...WIN_CLAMP].join('\n') }, ['`Step(-2, -1) -> [4 3 2 1 0]` (from the end, pinned in PLAN)']);
  try {
    sleep(1.1);
    const open = [finding(7, PRECEDENT(7), { createdAt: new Date().toISOString() })];
    fx.store.writeFindings(STORY_ID, { findings: open } as never);
    const step = api(nextDriver, 'findingConflictStep')({ root: fx.root, gitCwd: fx.root, store: fx.store, base: { storyId: STORY_ID, phase: 'DEV' }, open, repaired: () => false });
    assert.equal(step, null, 'already pinned');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// G / P. prompts and the switch default

function dispatchPrompt(agentType: string, config: Record<string, unknown> = {}, phase = 'PLAN'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run58-lane-')));
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'Bench Owner']);
    git(root, ['config', 'user.email', 'owner@bench.invalid']);
    write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' }, ...config }, null, 2));
    write(root, 'README.md', 'fixture\n');
    commit(root, 'baseline');
    resetConfigCache();
    const store = new StoryStore(root);
    store.writeStory(STORY_ID, { storyId: STORY_ID, name: 'seq-step', title: 'Stepped window', description: 'Add Step.', type: 'feature', phase, priority: 'high',
      createdAt: NOW, startedAt: NOW, endedAt: null, events: [{ phase, action: 'advance', timestamp: NOW }], ...(phase === 'REVIEW' ? { currentReviewRound: '2026-10-12T04:00:00.000Z' } : {}) } as StoryInfo);
    store.writeChecklist(STORY_ID, { items: [{ id: 'CHK-001', title: 'Step', context: 'seq/seq.go', userSees: 'Step(1, 2) returns [1 3 5]',
      files: { modify: ['seq/seq.go'], create: [], test: ['seq/seq_test.go'] }, status: 'pending', startTime: null, endTime: null }] as unknown as ChecklistItem[] } as ChecklistData);
    store.writeDevMemoryPreflightAck(STORY_ID, { schemaVersion: 'proof-or-stop.dev_memory_preflight_ack.v1', storyId: STORY_ID, topHitIds: [], acknowledgedAt: NOW, acknowledgedBy: 'smoke' } as never);
    return (createStoryDispatchHandlers({ store, root, scanRoot: root } as never).dispatch({ storyId: STORY_ID, agentType }) as { prompt: string }).prompt;
  } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
}

await check('G plan.baseDisagreement asks for the special cases in combination (a negative bound together with a negative step), generically', () => {
  const prompt = dispatchPrompt('proof-or-stop-review-scope-plan');
  assert.match(prompt, /Base-disagreement check/);
  assert.match(prompt, /alone and in combination/, 'combined cases');
  assert.match(prompt, /negative or omitted bound together with a negative step/, 'the negative-start negative-step class, named generically');
});

await check('P review.siblingParity defaults to off (on is the recorded arm; a malformed value keeps off)', () => {
  const { resolveAbVariants, abVariantEvidence } = abVariants as unknown as { resolveAbVariants: (c: unknown) => Record<string, string>; abVariantEvidence: (v: unknown) => unknown };
  assert.equal(resolveAbVariants({}).siblingParity, 'off', 'default off');
  assert.equal(abVariantEvidence(resolveAbVariants({})), undefined, 'the default is production: not recorded');
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ review: { siblingParity: 'on' } })), { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.siblingParity': 'on' } });
  assert.equal(api(abVariants, 'siblingParityOn')({ review: { siblingParity: 'loud' } }), false, 'malformed keeps the default');
  for (const lane of ['proof-or-stop-review-test-coverage', 'proof-or-stop-review-quality']) {
    assert.doesNotMatch(dispatchPrompt(lane, {}, 'REVIEW'), /Sibling parity/, `${lane}: no parity block by default`);
    assert.match(dispatchPrompt(lane, { review: { siblingParity: 'on' } }, 'REVIEW'), /Sibling parity \(required\)/, `${lane}: on adds it`);
  }
});

// ---------------------------------------------------------------------------
// H. review_round_prepare defaults a stale full-scan route's reason

await check('H review_round_prepare reroutes a stale full-scan route with a framework reason instead of refusing for an owner-written one', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run58-rrp-')));
  try {
    git(root, ['init', '-q', '-b', 'main']);
    write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }, null, 2));
    resetConfigCache();
    const store = new StoryStore(root);
    store.writeStory(STORY_ID, { storyId: STORY_ID, name: 'seq-step', title: 'Stepped window', description: 'Add Step.', type: 'feature', phase: 'REVIEW', priority: 'high',
      createdAt: NOW, startedAt: NOW, endedAt: null, events: [], currentReviewRound: '2026-10-12T04:00:00.000Z' } as StoryInfo);
    const routed: Array<Record<string, unknown>> = [];
    let plans = 0;
    const blocked = { status: 'blocked', reason: 'managed_review_candidate_binding_stale: materialHash, storyFilesHash',
      nextAction: `proof-or-stop candidate_spec_route '{"storyId":"${STORY_ID}","fullScanReason":"<specific justified tool-driven broad-scan reason>"}'` };
    const handlers: Record<string, Fn> = {
      reviewer_batch: () => { plans += 1; return { reviewRound: null, executionPlan: { launchableLanes: plans === 1 ? ['proof-or-stop-review-docs'] : [] }, managedReviewReadiness: plans === 1 ? blocked : { status: 'ready' } }; },
      candidate_spec_route: (args: unknown) => { routed.push(args as Record<string, unknown>); return {}; },
    };
    const prepare = (roundPrepare as unknown as { createReviewRoundPrepareHandlers: (ctx: unknown, lookup: (name: string) => Fn | undefined) => { review_round_prepare: (args: unknown) => Promise<unknown> } })
      .createReviewRoundPrepareHandlers({ store, root, scanRoot: root }, name => handlers[name]);
    await prepare.review_round_prepare({ storyId: STORY_ID, json: true });
    assert.equal(routed.length, 1, 'one reroute');
    assert.match(String(routed[0]!.fullScanReason ?? ''), /stale/, `a framework reason naming the stale binding: ${JSON.stringify(routed)}`);
  } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
});

if (failures.length) {
  console.error(`run58-fixes-smoke: FAIL (${failures.length}: ${failures.join('; ')})`);
  process.exit(1);
}
console.log('run58-fixes-smoke: PASS');
