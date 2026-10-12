#!/usr/bin/env node
/**
 * Old-PoS run 46 (bench-staging/oldpos/run46-analysis.md §0-§2.3, §5): unit
 * level, with real git repositories and real `go test` runs. Generic examples
 * only: a toy `kv` package with two receiver kinds, `List` (whose pre-existing
 * Get counts a negative index from the end) and `Ring` (whose pre-existing Put
 * rejects one); the Story adds `List.Put`. No benchmark-task material.
 *
 *   S. review.siblingParity ranks the oracle: the same receiver's pre-existing
 *      counterpart is primary, another receiver's same operation secondary; a
 *      base disagreement between them is one `[precedent-conflict]` question,
 *      never an alignment demand; each finding states its Repro.
 *   B. plan.baseDisagreement (default on): the scope-plan dispatch carries the
 *      base-disagreement check; `off` removes it and is recorded.
 *   G. Resolved-finding regression guard (no switch): after a repair, a
 *      resolved finding whose cited files changed is re-verified with its
 *      covering tests AS RECORDED at its resolution; a repair that reversed it
 *      (and rewrote its test to match) fails the guard and is blamed; an
 *      unrelated or benign repair passes; a pass is reused on the same material;
 *      the rejected commit is readable from the process events.
 *   R. The finding-repair prompt lists the resolved findings on the same code
 *      (do not reverse them) and a rejected earlier repair; a conflict (a
 *      `[precedent-conflict]` finding, a repair a guard rejected) reaches repair
 *      only after the owner's pin, and its prompt says the pin decides.
 *   D. Duplicate closure integrity (no switch, finding_resolve duplicateOf):
 *      D1 refused when the cited coverage never runs the duplicate's own repro
 *         (recorded as a failed coverage run: next gives it its own repair);
 *      D2 refused when the canonical's repair was rewritten by a later commit
 *         and its recorded covering test now fails, although the coverage test
 *         contains the repro and passes (the later repair rewrote it);
 *      D3 the run-44 N7 chain-to-root path is held to the same check;
 *      D4 control: a live canonical and a coverage test that runs the repro close it.
 *   L. REVIEW lanes re-probe resolved findings: the lane prompt lists them
 *      with their repro and asks for a `[regression-of <id>]` finding.
 *
 * Old-PoS run 47 (run47-analysis.md §2, §3.4, §7; scope addition):
 *   D5 a canonical whose repair commit a later commit reverted outright is not live.
 *   C. Finding conflicts: a finding that re-judges a resolved finding's case
 *      (same repro, no regression claim), a `[precedent-conflict]` finding, and
 *      a finding whose repair a resolved finding's guard rejected conflict; a
 *      regression is not a conflict; `next` (DEV) routes an unpinned conflict to
 *      PLAN with one step and lets it through once the checklist intent changed.
 *   W. A live managed writer run holding the Story worktree detached does not
 *      make the controller projection refuse the worktree (it is reused as is).
 *   (Item 7, no idle rounds, is not implemented: lane evidence is bound to its
 *   inventory wave, and closing a finding in REVIEW made the lanes rerun in the
 *   same round; see lifecycle-state-machine.md §1.1o. The RED commit's NIR
 *   harness scenario was withdrawn with it.)
 *
 * Old-PoS run 55 (run53-56-delta-ab-analysis.md fix B):
 *   T. A repair that deletes a test it added, or deletes / weakens a test line
 *      running the finding's own repro, is not a repair; the repair prompt says a
 *      failing test it added is evidence of a product defect.
 *
 * Usage: node packages/main/dist/tasks/run46-fixes-smoke.js
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
import { createFindingHandlers } from '../handlers/finding.js';
import * as nextDriver from '../handlers/next-driver.js';
import * as runtimeRoot from '../cli/runtime-root.js';

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

// ---------------------------------------------------------------------------
// Toy Go package: List (Get counts a negative index from the end) and Ring (Put rejects it)

const KV_HEAD = ['package kv', '', 'import "errors"', '', 'var ErrRange = errors.New("index out of range")', '',
  'type List struct{ items []int }', 'type Ring struct{ items []int }', '',
  'func NewList(v ...int) *List { return &List{items: v} }', 'func NewRing(v ...int) *Ring { return &Ring{items: v} }', '',
  '// Get reads a List; a negative index counts from the end.',
  'func (l *List) Get(i int) (int, error) {', '\tif i < 0 {', '\t\ti += len(l.items)', '\t}', '\tif i < 0 || i >= len(l.items) {', '\t\treturn 0, ErrRange', '\t}', '\treturn l.items[i], nil', '}', '',
  '// Put writes a Ring; a negative index is out of range.',
  'func (r *Ring) Put(i, v int) error {', '\tif i < 0 || i >= len(r.items) {', '\t\treturn ErrRange', '\t}', '\tr.items[i] = v', '\treturn nil', '}', ''];
const LIST_PUT_REJECTS = ['// Put writes a List.', 'func (l *List) Put(i, v int) error {', '\tif i < 0 || i >= len(l.items) {', '\t\treturn ErrRange', '\t}', '\tl.items[i] = v', '\treturn nil', '}', ''];
const LIST_PUT_NORMALISES = ['// Put writes a List; a negative index counts from the end, like Get.', 'func (l *List) Put(i, v int) error {', '\tif i < 0 {', '\t\ti += len(l.items)', '\t}',
  '\tif i < 0 || i >= len(l.items) {', '\t\treturn ErrRange', '\t}', '\tl.items[i] = v', '\treturn nil', '}', ''];
const TEST_HEAD = ['package kv', '', 'import "testing"', '',
  'func TestListPut(t *testing.T) {', '\tl := NewList(1, 2, 3)', '\tif err := l.Put(1, 7); err != nil {', '\t\tt.Fatal(err)', '\t}', '\tif v, _ := l.Get(1); v != 7 {', '\t\tt.Fatalf("got %d", v)', '\t}', '}', ''];
const TEST_NEGATIVE_NORMALISES = ['func TestListPutNegative(t *testing.T) {', '\tl := NewList(1, 2, 3)', '\tif err := l.Put(-1, 9); err != nil {', '\t\tt.Fatal(err)', '\t}',
  '\tif v, _ := l.Get(2); v != 9 {', '\t\tt.Fatalf("got %d", v)', '\t}', '}', ''];
const TEST_NEGATIVE_REJECTS = ['func TestListPutNegative(t *testing.T) {', '\tl := NewList(1, 2, 3)', '\tif err := l.Put(-1, 9); err != ErrRange {', '\t\tt.Fatalf("got %v", err)', '\t}', '}', ''];

const STORY_ID = 'B-46a1';
const F = (n: number) => `${STORY_ID}:F-00${n}`;
const NOW = '2026-10-11T03:00:00.000Z';
const F1_DESC = 'kv/kv.go List.Put rejects a negative index while the same receiver\'s pre-existing Get counts it from the end. Repro: `l.Put(-1, 9)`';
const F2_DESC = 'kv/kv.go List.Put normalises a negative index but Ring.Put rejects it. Repro: `r.Put(-1, 9)`';

interface Fixture { root: string; store: StoryStore; base: string; impl: string; repair1: string }

/** Base, the Story's implementation (List.Put rejects negatives), and F-001's repair (normalise + TestListPutNegative). */
function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run46-kv-')));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' } }, null, 2));
  write(root, 'go.mod', 'module example.com/kv\n\ngo 1.21\n');
  write(root, 'kv/kv.go', KV_HEAD.join('\n'));
  write(root, 'kv/kv_test.go', ['package kv', '', 'import "testing"', '', 'func TestBaseline(t *testing.T) {}', ''].join('\n'));
  write(root, 'README.md', 'kv\n');
  const base = commit(root, 'baseline');
  write(root, 'kv/kv.go', [...KV_HEAD, ...LIST_PUT_REJECTS].join('\n'));
  write(root, 'kv/kv_test.go', TEST_HEAD.join('\n'));
  const impl = commit(root, 'B-46a1 CHK-001: List.Put');
  write(root, 'kv/kv.go', [...KV_HEAD, ...LIST_PUT_NORMALISES].join('\n'));
  write(root, 'kv/kv_test.go', [...TEST_HEAD, ...TEST_NEGATIVE_NORMALISES].join('\n'));
  const repair1 = commit(root, 'B-46a1 F-001: List.Put counts a negative index from the end');
  resetConfigCache();
  const store = new StoryStore(root);
  store.writeStory(STORY_ID, { storyId: STORY_ID, name: 'kv-put', title: 'List put', description: 'Add List.Put.', type: 'feature', phase: 'DEV', priority: 'high',
    createdAt: NOW, startedAt: NOW, endedAt: null, events: [{ phase: 'DEV', action: 'advance', timestamp: NOW }] } as StoryInfo);
  store.writeChecklist(STORY_ID, { items: [{ id: 'CHK-001', title: 'List.Put', context: 'kv/kv.go', userSees: 'l.Put(1, 7) stores 7 at index 1',
    files: { modify: ['kv/kv.go'], create: [], test: ['kv/kv_test.go'] }, status: 'done', startTime: null, endTime: null }] as unknown as ChecklistItem[] } as ChecklistData);
  return { root, store, base, impl, repair1 };
}

/** The F-002 repair that reverses F-001's (rejects negatives again) and rewrites F-001's test to match. */
function reverseRepair(fx: Fixture): string {
  write(fx.root, 'kv/kv.go', [...KV_HEAD, ...LIST_PUT_REJECTS].join('\n'));
  write(fx.root, 'kv/kv_test.go', [...TEST_HEAD, ...TEST_NEGATIVE_REJECTS].join('\n'));
  return commit(fx.root, 'B-46a1 F-002: List.Put matches Ring.Put on negative indexes');
}

const finding = (n: number, desc: string, extra: Partial<Finding> = {}): Finding => ({ id: F(n), desc, severity: 'medium', category: 'edge', status: 'open',
  evidenceState: 'verified', agent: 'proof-or-stop-review-test-coverage', createdAt: NOW, files: ['kv/kv.go'], ...extra } as Finding);
const resolved1 = (fx: Fixture): Finding => finding(1, F1_DESC, { status: 'resolved', resolutionType: 'fixed', resolvedAt: NOW,
  resolvedReason: `Framework-verified repair of ${F(1)}: material commit ${fx.repair1.slice(0, 12)} of managed finding-repair run run-1, bound to ${F(1)} and completed.` });
const memoryEvents = () => {
  const events: Array<Record<string, unknown>> = [];
  return { events, store: { readProcessEvents: () => events, appendProcessEvent: (_id: string, event: Record<string, unknown>) => { events.push(event); } } };
};

// ---------------------------------------------------------------------------
// S. the sibling-parity oracle order

function reviewStory(config: Record<string, unknown> = {}, findings: Finding[] = []): { root: string; ctx: { store: StoryStore; root: string; scanRoot: string } } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run46-lane-')));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' }, ...config }, null, 2));
  write(root, 'README.md', 'fixture\n');
  commit(root, 'baseline');
  resetConfigCache();
  const store = new StoryStore(root);
  store.writeStory(STORY_ID, { storyId: STORY_ID, name: 'kv-put', title: 'List put', description: 'Add List.Put.', type: 'feature', phase: 'PLAN', priority: 'high',
    createdAt: NOW, startedAt: NOW, endedAt: null, events: [{ phase: 'PLAN', action: 'advance', timestamp: NOW }] } as StoryInfo);
  store.writeChecklist(STORY_ID, { items: [{ id: 'CHK-001', title: 'List.Put', context: 'kv/kv.go', userSees: 'l.Put(1, 7) stores 7 at index 1',
    files: { modify: ['kv/kv.go'], create: [], test: ['kv/kv_test.go'] }, status: 'pending', startTime: null, endTime: null }] as unknown as ChecklistItem[] } as ChecklistData);
  store.writeDevMemoryPreflightAck(STORY_ID, { schemaVersion: 'proof-or-stop.dev_memory_preflight_ack.v1', storyId: STORY_ID, topHitIds: [], acknowledgedAt: NOW, acknowledgedBy: 'smoke' } as never);
  if (findings.length) store.writeFindings(STORY_ID, { findings } as never);
  return { root, ctx: { store, root, scanRoot: root } };
}
function lanePrompt(lane: string, config: Record<string, unknown> = {}, findings: Finding[] = []): string {
  const { root, ctx } = reviewStory(config, findings);
  try {
    ctx.store.writeStory(STORY_ID, { ...ctx.store.readStory(STORY_ID), phase: 'REVIEW', currentReviewRound: '2026-10-11T04:00:00.000Z' });
    return (createStoryDispatchHandlers(ctx as never).dispatch({ storyId: STORY_ID, agentType: lane }) as { prompt: string }).prompt;
  } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
}

await check('S the sibling-parity check ranks the oracle (same receiver\'s counterpart first) and turns a base disagreement into a [precedent-conflict] question', () => {
  for (const lane of ['proof-or-stop-review-test-coverage', 'proof-or-stop-review-quality']) {
    // Old-PoS run 58: the switch defaults off; the arm is on.
    const prompt = lanePrompt(lane, { review: { siblingParity: 'on' } });
    const block = prompt.slice(prompt.indexOf('Sibling parity'));
    assert.match(block, /SAME receiver's pre-existing counterpart/, `${lane}: the primary reference is the same receiver's pre-existing counterpart`);
    assert.match(block, /secondary/, `${lane}: another receiver's same operation is only secondary`);
    assert.match(block, /\[precedent-conflict\]/, `${lane}: a base disagreement is a precedent-conflict question`);
    assert.match(block, /never ask to align the new path with the secondary/, `${lane}: no alignment to the secondary`);
    assert.match(block, /Repro: `<command or expression>`/, `${lane}: each finding states its repro`);
    assert.doesNotMatch(lanePrompt(lane, { review: { siblingParity: 'off' } }), /Sibling parity/, `${lane}: off removes it`);
    assert.doesNotMatch(lanePrompt(lane), /Sibling parity/, `${lane}: absent = off (old-PoS run 58)`);
  }
});

// ---------------------------------------------------------------------------
// B. plan.baseDisagreement

await check('B plan.baseDisagreement: default on in the scope-plan dispatch; off removes it and is recorded; malformed keeps on', () => {
  const { resolveAbVariants, abVariantEvidence } = abVariants as unknown as { resolveAbVariants: (c: unknown) => Record<string, string>; abVariantEvidence: (v: unknown) => unknown };
  assert.equal(resolveAbVariants({}).baseDisagreement, 'on', 'default on');
  assert.equal(abVariantEvidence(resolveAbVariants({})), undefined, 'the default is production: not recorded');
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ plan: { baseDisagreement: 'off' } })), { schema: 'proof-or-stop.ab-variants.v1', flags: { 'plan.baseDisagreement': 'off' } });
  assert.equal(api(abVariants, 'baseDisagreementOn')({ plan: { baseDisagreement: 'loud' } }), true, 'malformed keeps the default');
  const prompt = (config: Record<string, unknown>): string => {
    const { root, ctx } = reviewStory(config);
    try { return (createStoryDispatchHandlers(ctx as never).dispatch({ storyId: STORY_ID, agentType: 'proof-or-stop-review-scope-plan' }) as { prompt: string }).prompt; }
    finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
  };
  const on = prompt({});
  assert.match(on, /Base-disagreement check: for each new operation an item adds/);
  assert.match(on, /same receiver's counterpart operation and the same operation on other receivers/);
  assert.match(on, /Precedent conflict: <operation>, <case>/, 'the gap names the case and both precedents');
  assert.match(on, /covering row on that item pinning which precedent applies/, 'its remedy is a covering row');
  assert.doesNotMatch(prompt({ plan: { baseDisagreement: 'off' } }), /Base-disagreement check: for each new operation/, 'off removes it');
});

// ---------------------------------------------------------------------------
// G. the resolved-finding regression guard

await check('G1 a repair that reverses a resolved finding and rewrites its test fails that finding\'s recorded covering test and is blamed', () => {
  const fx = fixture();
  try {
    const repair2 = reverseRepair(fx);
    const memory = memoryEvents();
    const findings = [resolved1(fx), finding(2, F2_DESC)];
    const out = api(guardModule, 'regressionGuardCheck')({ store: memory.store, projectRoot: fx.root, gitCwd: fx.root, storyId: STORY_ID, findings,
      repairs: [{ findingId: F(2), commit: repair2 }], repairCommitOf: (row: Finding) => api(guardModule, 'repairCommitFromResolution')(fx.root, row),
      coverageOf: () => null, headHash: repair2, materialHash: null }) as Array<{ guarded: Finding; result: { passed: boolean; restoredTests: boolean; command: string }; blamed: Array<{ findingId: string; commit: string }> }>;
    assert.equal(out.length, 1, 'F-001 fails its guard');
    assert.equal(out[0]!.guarded.id, F(1));
    assert.equal(out[0]!.result.restoredTests, true, 'the test ran as recorded at F-001\'s resolution (the repair rewrote it)');
    assert.match(out[0]!.result.command, /go test -v \.\/kv -run \^\(TestListPutNegative\)\$/);
    assert.deepEqual(out[0]!.blamed, [{ findingId: F(2), commit: repair2 }], 'the reversing repair is blamed');
    const rejected = (api(guardModule, 'rejectedRepairCommits')(memory.events) as Map<string, Array<{ commit: string; guardedFindingId: string }>>).get(F(2));
    assert.deepEqual(rejected?.map(row => [row.commit, row.guardedFindingId]), [[repair2, F(1)]], 'the rejected commit is readable from the process events');
    const desc = api(guardModule, 'regressionFindingDesc')({ storyId: STORY_ID, guarded: findings[0], result: out[0]!.result, blamed: out[0]!.blamed }) as string;
    assert.match(desc, /^\[regression-of F-001\] the repair of F-002/, 'the regression finding names the resolved one and the repair that broke it');
    assert.match(desc, /Repro: `l\.Put\(-1, 9\)`/, 'it carries the resolved finding\'s repro');
    assert.deepEqual(api(guardModule, 'regressionTargets')(desc, STORY_ID), [F(1)]);
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

await check('G2 kept clear: an unrelated repair, a benign repair (the guard passes, reused on the same material), the regression finding\'s own repair', () => {
  const fx = fixture();
  try {
    const findings = [resolved1(fx), finding(2, F2_DESC)];
    const run = (repair: string, memory = memoryEvents(), material: string | null = null, rows = findings, id = F(2)) => (api(guardModule, 'regressionGuardCheck')({ store: memory.store, projectRoot: fx.root, gitCwd: fx.root,
      storyId: STORY_ID, findings: rows, repairs: [{ findingId: id, commit: repair }], repairCommitOf: (row: Finding) => api(guardModule, 'repairCommitFromResolution')(fx.root, row),
      coverageOf: () => null, headHash: repair, materialHash: material }) as unknown[]);
    write(fx.root, 'README.md', 'kv store\n');
    const unrelated = commit(fx.root, 'B-46a1 F-002: docs');
    const quiet = memoryEvents();
    assert.deepEqual(run(unrelated, quiet), [], 'a repair outside F-001\'s cited files does not re-run its guard');
    assert.equal(quiet.events.length, 0, 'no guard ran');
    write(fx.root, 'kv/kv.go', [...KV_HEAD, ...LIST_PUT_NORMALISES, '// Len is the List length.', 'func (l *List) Len() int { return len(l.items) }', ''].join('\n'));
    const benign = commit(fx.root, 'B-46a1 F-002: List.Len');
    const memory = memoryEvents();
    assert.deepEqual(run(benign, memory, 'm1'), [], 'a repair that keeps F-001 fixed passes its guard');
    assert.equal(memory.events.length, 1, 'the pass is recorded');
    assert.deepEqual(run(benign, memory, 'm1'), [], 'still passes');
    assert.equal(memory.events.length, 1, 'a pass on the same material is reused (no second run)');
    // A finding that declares itself a regression of F-001 supersedes F-001's old guard when it is repaired.
    const reversed = reverseRepair(fx);
    const regression = finding(3, `[regression-of F-001] the repair of F-002 broke resolved finding F-001. Repro: \`l.Put(-1, 9)\``);
    assert.deepEqual(run(reversed, memoryEvents(), null, [...findings, regression], F(3)), [], 'the regression finding\'s own repair is not judged by the guard it replaces');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// R. the finding-repair prompt

await check('R the repair prompt lists resolved findings on the same code (do not reverse) and a rejected earlier repair; a pinned conflict is implemented per the pin', () => {
  const fx = fixture();
  try {
    fx.store.writeFindings(STORY_ID, { findings: [resolved1(fx), finding(2, F2_DESC), finding(3, '[precedent-conflict] List.Get counts a negative index from the end, Ring.Put rejects it; the request does not say which List.Put follows. Repro: `l.Put(-1, 9)`')] } as never);
    const prompt = (id: string) => (createStoryDispatchHandlers({ store: fx.store, root: fx.root, scanRoot: fx.root } as never)
      .dispatch({ storyId: STORY_ID, agentType: 'proof-or-stop-finding-repair', findingId: id }) as { prompt: string }).prompt;
    const two = prompt('F-002');
    assert.match(two, /Resolved findings on the same code: do not reverse what they fixed/);
    assert.match(two, /- F-001: .*Repro: `l\.Put\(-1, 9\)`/, 'the resolved finding with its repro');
    assert.match(two, /declare `\[intent-conflict\]` instead of editing it back/);
    assert.doesNotMatch(two, /the pin decides/, 'no conflict: no pin line');
    // A precedent conflict reaches repair only after the owner's pin (next routes it to PLAN first): the pin decides.
    assert.match(prompt('F-003'), /the owner pinned it in the checklist, and the pin decides/, 'a precedent conflict is implemented per the pin');
    // F-002's repair was rejected by F-001's guard: a conflict; after the pin the prompt says the pin decides and names the rejection.
    fx.store.appendProcessEvent(STORY_ID, { type: 'resolved_finding_guard_checked', findingId: F(1), headHash: 'h', passed: false, command: 'go test -v ./kv -run ^(TestListPutNegative)$',
      rejectedRepairs: [{ findingId: F(2), commit: 'abcdef1234567890' }] } as never);
    const rejected = prompt('F-002');
    assert.match(rejected, /Earlier repair commit abcdef123456 of this finding was rejected: it broke resolved finding F-001/);
    assert.match(rejected, /the pin decides: implement exactly what the checklist states/);
    assert.doesNotMatch(rejected, /- F-001: /, 'the pinned side is not listed as "do not reverse"');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// D. duplicate closure integrity (finding_resolve duplicateOf)

function duplicateStory(fx: Fixture, duplicates: Array<{ n: number; desc: string; canonical: number }>): { handlers: ReturnType<typeof createFindingHandlers> } {
  const ctx = { store: fx.store, root: fx.root, scanRoot: fx.root };
  fx.store.writeStory(STORY_ID, { ...fx.store.readStory(STORY_ID), phase: 'REVIEW', currentReviewRound: '2026-10-11T04:00:00.000Z' });
  fx.store.writeFindings(STORY_ID, { findings: [resolved1(fx), ...duplicates.map(row => finding(row.n, row.desc))] } as never);
  const data = fx.store.readReviewInventoryEpochs(STORY_ID);
  data.criticReceipts.push({ findingDispositions: duplicates.map(row => ({ findingId: F(row.n), disposition: 'duplicate', canonicalFindingId: F(row.canonical), familyKey: 'list-put-negative', reason: 'same root cause' })) } as never);
  fx.store.writeReviewInventoryEpochs(STORY_ID, data);
  return { handlers: createFindingHandlers(ctx as never) };
}
const closeAsDuplicate = (handlers: ReturnType<typeof createFindingHandlers>, n: number, canonical: number, test: string): string =>
  handlers.finding_resolve({ storyId: STORY_ID, findingId: F(n), duplicateOf: F(canonical), resolution: `${F(canonical)}'s repair covers it`,
    coverage: { command: `go test -v ./kv -run ^${test}$`, selector: `--- PASS: ${test}` } });
const withoutAgent = <T>(fn: () => T): T => {
  const saved = process.env.PROOF_OR_STOP_AGENT;
  delete process.env.PROOF_OR_STOP_AGENT;
  try { return fn(); } finally { if (saved !== undefined) process.env.PROOF_OR_STOP_AGENT = saved; }
};
const F3_DESC = 'kv/kv.go List.Put still rejects a negative index (reintroduces F-001). Repro: `l.Put(-1, 9)`';

await check('D1 a duplicate closure whose coverage never runs the duplicate\'s own repro is refused and recorded (own repair next)', () => withoutAgent(() => {
  const fx = fixture();
  try {
    const { handlers } = duplicateStory(fx, [{ n: 3, desc: F3_DESC, canonical: 1 }]);
    assert.throws(() => closeAsDuplicate(handlers, 3, 1, 'TestListPut'), /duplicate_coverage_lacks_repro/, 'TestListPut never runs l.Put(-1, 9)');
    assert.equal(fx.store.readFindings(STORY_ID).findings.find(row => row.id === F(3))?.status, 'open', 'it stays open');
    const receipt = fx.store.readDuplicateFindingCoverage(STORY_ID).receipts.at(-1) as { passed: boolean; refusal?: string } | undefined;
    assert.equal(receipt?.passed, false, 'recorded as a failed coverage run, so next gives it its own repair');
    assert.equal(receipt?.refusal, 'duplicate_coverage_lacks_repro');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
}));

await check('D2 a duplicate of a canonical whose repair a later commit reversed is refused although its coverage contains the repro and passes', () => withoutAgent(() => {
  const fx = fixture();
  try {
    reverseRepair(fx);
    const { handlers } = duplicateStory(fx, [{ n: 3, desc: F3_DESC, canonical: 1 }]);
    assert.throws(() => closeAsDuplicate(handlers, 3, 1, 'TestListPutNegative'), /duplicate_canonical_not_live/,
      'TestListPutNegative (rewritten to expect the error) passes, but F-001\'s repair is no longer live');
    assert.equal(fx.store.readFindings(STORY_ID).findings.find(row => row.id === F(3))?.status, 'open');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
}));

await check('D3 the run-44 chain-to-root closure is held to the same liveness check', () => withoutAgent(() => {
  const fx = fixture();
  try {
    reverseRepair(fx);
    const { handlers } = duplicateStory(fx, [{ n: 3, desc: F3_DESC, canonical: 1 }, { n: 4, desc: 'kv/kv.go negative List.Put index still errors (same as F-003). Repro: `l.Put(-1, 9)`', canonical: 3 }]);
    assert.throws(() => closeAsDuplicate(handlers, 4, 1, 'TestListPutNegative'), /duplicate_canonical_not_live/, 'closing F-004 against the root F-001 is refused too');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
}));

await check('D4 control: a live canonical and a coverage test that runs the repro close the duplicate', () => withoutAgent(() => {
  const fx = fixture();
  try {
    const { handlers } = duplicateStory(fx, [{ n: 3, desc: F3_DESC, canonical: 1 }]);
    const out = closeAsDuplicate(handlers, 3, 1, 'TestListPutNegative');
    assert.match(out, /resolved/i, out);
    assert.equal(fx.store.readFindings(STORY_ID).findings.find(row => row.id === F(3))?.status, 'resolved');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
}));

await check('D5 a duplicate of a canonical whose repair commit a later commit reverted is refused', () => withoutAgent(() => {
  const fx = fixture();
  try {
    git(fx.root, ['revert', '--no-edit', fx.repair1]);
    const { handlers } = duplicateStory(fx, [{ n: 3, desc: F3_DESC, canonical: 1 }]);
    write(fx.root, 'kv/extra_test.go', ['package kv', '', 'import "testing"', '', 'func TestListPutNegativeAgain(t *testing.T) {', '\tl := NewList(1, 2, 3)', '\t_ = l.Put(-1, 9)', '}', ''].join('\n'));
    commit(fx.root, 'B-46a1: a test that runs the repro and asserts nothing');
    assert.throws(() => closeAsDuplicate(handlers, 3, 1, 'TestListPutNegativeAgain'), /duplicate_canonical_not_live/, 'the reverted canonical fix is not live');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
}));

// ---------------------------------------------------------------------------
// C. finding conflicts

const F4_CONFLICT = 'kv/kv.go List.Put must reject a negative index like Ring.Put does. Repro: `l.Put(-1, 9)`';
await check('C1 conflicts: the same case re-judged without a regression claim, a [precedent-conflict] finding, a guard-rejected repair; a regression is not one', () => {
  const fx = fixture();
  try {
    const conflictOf = api(guardModule, 'findingConflictOf');
    const resolved = resolved1(fx);
    const none = new Map();
    const of = (desc: string, rejected: Map<string, unknown> = none) => conflictOf({ finding: finding(4, desc), findings: [resolved, finding(4, desc)], storyId: STORY_ID, rejected }) as { resolvedId: string | null; why: string } | null;
    assert.equal(of(F4_CONFLICT)?.resolvedId, F(1), 'same repro, opposite demand: a conflict with F-001');
    assert.equal(of(`[regression-of F-001] still broken. Repro: \`l.Put(-1, 9)\``), null, 'a regression of F-001 is repaired, not pinned');
    assert.equal(of('kv/kv.go List.Get of an empty list. Repro: `l.Get(0)`'), null, 'another case is no conflict');
    assert.deepEqual(of('[precedent-conflict] List.Get counts a negative index from the end, Ring.Put rejects it. Repro: `l.Put(-2, 1)`')?.resolvedId, null, 'a precedent conflict needs a pin (no resolved side)');
    assert.ok(of('[precedent-conflict] List.Get counts a negative index from the end, Ring.Put rejects it.'), 'even without a repro');
    assert.equal(of('kv/kv.go List.Len is wrong. Repro: `l.Len(1)`', new Map([[F(4), [{ commit: 'abc1234', guardedFindingId: F(1) }]]]))?.resolvedId, F(1), 'a repair rejected by F-001\'s guard');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

await check('C2 next (DEV) routes an unpinned finding conflict to PLAN with one step, and lets it through once the checklist intent changed', () => {
  const fx = fixture();
  try {
    git(fx.root, ['add', '-A']); git(fx.root, ['commit', '-qm', 'B-46a1 metadata']);
    execFileSync('sleep', ['1.1']);
    const open = finding(4, F4_CONFLICT, { createdAt: new Date().toISOString() });
    fx.store.writeFindings(STORY_ID, { findings: [resolved1(fx), open] } as never);
    const step = () => api(nextDriver, 'findingConflictStep')({ root: fx.root, gitCwd: fx.root, store: fx.store, base: { storyId: STORY_ID, phase: 'DEV' }, open: [open], repaired: () => false }) as
      { reason: string; kind: string; cli: { command: string; payload: Record<string, unknown> }; why: string } | null;
    const first = step();
    assert.equal(first?.reason, 'finding_conflict_pin');
    assert.equal(first?.kind, 'agent');
    assert.deepEqual([first?.cli.command, first?.cli.payload.phase], ['story_advance', 'PLAN'], 'one Next: return to PLAN');
    assert.match(first?.why ?? '', /F-004 and resolved .*F-001/);
    assert.match(first?.why ?? '', /pin/);
    // The owner pins the case in PLAN (an intent row), committed after the conflict became known.
    execFileSync('sleep', ['1.2']);
    const items = fx.store.readChecklist(STORY_ID).items.map(item => ({ ...item, verificationIntent: { happy: [{ desc: 'l.Put(-1, 9) -> sets the last element (the same receiver\'s Get counts from the end)', type: 'logic', priority: 'must' }] } }));
    fx.store.writeChecklist(STORY_ID, { items } as never);
    git(fx.root, ['add', '-A']); git(fx.root, ['commit', '-qm', 'B-46a1 pin']);
    assert.equal(step(), null, 'pinned: the finding goes to repair against the pin');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// W. a live writer holds the Story worktree detached

await check('W the controller projection reuses a Story worktree a live managed writer run holds detached (no refusal); without a live run it still refuses', () => {
  const fx = fixture();
  try {
    git(fx.root, ['add', '-A']); git(fx.root, ['commit', '-qm', 'B-46a1 metadata']);
    const worktree = join(fx.root, '.worktrees', STORY_ID);
    git(fx.root, ['worktree', 'add', '-q', '-b', `story/${STORY_ID}`, worktree]);
    git(worktree, ['checkout', '-q', '--detach']);
    const project = () => api(runtimeRoot, 'projectControllerAssetsIntoStoryWorktree')({ controllerRoot: fx.root, worktreeRoot: worktree, storyId: STORY_ID }) as { storyRoot: string };
    assert.throws(project, /unregistered linked worktree/, 'no live writer: still refused');
    const run = join(fx.root, '.proof-or-stop', 'runtime', 'host-runs', 'run-live-1');
    write(run, 'spec.json', JSON.stringify({ storyId: STORY_ID, agentType: 'proof-or-stop-finding-repair' }));
    const out = project();
    assert.match(out.storyRoot, new RegExp(`\\.worktrees/${STORY_ID}/`), 'the worktree\'s own Story projection is used');
    write(run, 'terminal.json', '{}');
    assert.throws(project, /unregistered linked worktree/, 'a finished run holds nothing');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// T. repair test integrity

await check('T1 a repair that removes a test it added, or a test line running the finding\'s repro, is not a repair; editing that line in place is', () => {
  const fx = fixture();
  try {
    const problem = (commits: string[]) => api(guardModule, 'repairTestIntegrityProblem')({ gitCwd: fx.root, commits, desc: F1_DESC }) as string | null;
    // The repair adds TestListPutNegative (it fails on the old code), then deletes it.
    write(fx.root, 'kv/kv_test.go', [...TEST_HEAD, ...TEST_NEGATIVE_NORMALISES, 'func TestListPutNegativeTwo(t *testing.T) {', '\tif err := NewList(1).Put(-1, 2); err != nil {', '\t\tt.Fatal(err)', '\t}', '}', ''].join('\n'));
    const addTwo = commit(fx.root, 'B-46a1 F-001: TestListPutNegativeTwo');
    write(fx.root, 'kv/kv_test.go', [...TEST_HEAD, ...TEST_NEGATIVE_NORMALISES].join('\n'));
    const dropTwo = commit(fx.root, 'B-46a1 F-001: drop TestListPutNegativeTwo (base rejects it)');
    assert.match(problem([addTwo, dropTwo]) ?? '', /removes test TestListPutNegativeTwo .* that commit .* of the same repair added/, 'add then delete in one run');
    assert.equal(problem([dropTwo]), null, 'removing a test the run did not add is not (a)');
    // A commit deleting the line that runs the repro.
    write(fx.root, 'kv/kv_test.go', TEST_HEAD.join('\n'));
    const dropRepro = commit(fx.root, 'B-46a1 F-001: drop the negative case');
    assert.match(problem([dropRepro]) ?? '', /deletes or weakens a test line that runs the finding's own repro/, 'the repro line is gone');
    // Editing the repro line in place (the repro stays) is not a deletion.
    write(fx.root, 'kv/kv_test.go', [...TEST_HEAD, ...TEST_NEGATIVE_REJECTS].join('\n'));
    const restoreReject = commit(fx.root, 'B-46a1: restore rejecting case');
    write(fx.root, 'kv/kv_test.go', [...TEST_HEAD, ...TEST_NEGATIVE_NORMALISES].join('\n'));
    const editInPlace = commit(fx.root, 'B-46a1 F-001: the repro now expects the normalised write');
    assert.equal(problem([restoreReject, editInPlace]), null, 'the repro is kept (edited in place)');
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

await check('T2 the repair prompt says a failing test it added is evidence of a product defect, never to delete or weaken', () => {
  const fx = fixture();
  try {
    fx.store.writeFindings(STORY_ID, { findings: [finding(2, F2_DESC)] } as never);
    const prompt = (createStoryDispatchHandlers({ store: fx.store, root: fx.root, scanRoot: fx.root } as never)
      .dispatch({ storyId: STORY_ID, agentType: 'proof-or-stop-finding-repair', findingId: 'F-002' }) as { prompt: string }).prompt;
    assert.match(prompt, /A test you add that fails on the current code is evidence of a product defect/);
    assert.match(prompt, /never delete, skip or weaken it/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// L. REVIEW lanes re-probe resolved findings

await check('L a REVIEW lane prompt lists resolved findings with their repro to re-run, and asks for a [regression-of <id>] finding when one fails', () => {
  const resolved = finding(1, F1_DESC, { status: 'resolved', resolutionType: 'fixed', resolvedAt: NOW });
  for (const lane of ['proof-or-stop-review-test-coverage', 'proof-or-stop-review-docs']) {
    const prompt = lanePrompt(lane, {}, [resolved, finding(2, 'kv/kv.go an open finding without a repro')]);
    assert.match(prompt, /Resolved findings \(re-probe, do not trust the status\)/, `${lane}: the re-probe block`);
    assert.match(prompt, /- F-001 \(fixed\): .*Repro: `l\.Put\(-1, 9\)`/, `${lane}: the resolved finding with its repro`);
    assert.match(prompt, /\[regression-of <id>\]/, `${lane}: a failing repro is reported as a regression`);
    assert.doesNotMatch(prompt, /- F-002/, `${lane}: open findings are not listed`);
  }
  assert.doesNotMatch(lanePrompt('proof-or-stop-review-quality'), /Resolved findings \(re-probe/, 'nothing resolved (round 1): no block');
});

if (failures.length) {
  console.error(`run46-fixes-smoke: FAIL (${failures.length}: ${failures.join('; ')})`);
  process.exit(1);
}
console.log('run46-fixes-smoke: PASS');
