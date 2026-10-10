#!/usr/bin/env node
/**
 * Old-PoS run 43 (bench-staging/oldpos/run43-analysis.md §3.3, §5.2 fixes 1, 2
 * and 4): unit level, with real git repositories where Git is involved. Generic
 * examples only (a toy `put` / `get` store module; no benchmark-task material).
 *
 *   X. Exact-text gate, cuts of the actual text (detection-neutral, no switch):
 *      X1 an equality against a variable assigned an indexed split of the actual
 *         text (`first := strings.SplitN(got, sep, 2)[0]`) is a prefix comparison;
 *      X2 the same cut written inline, `strings.Split(..)[0]`, a `strings.Cut`
 *         head whose tail is discarded, a first-line helper, and the JS / Python
 *         `.split(..)[0]` / `.splitlines()[0]` forms are prefix comparisons;
 *      X3 kept clear: a split whose other parts are also checked (the run 40
 *         exact-first-line-plus-position helper), and a full equality.
 *   S. review.siblingParity (default on): the test-coverage and quality lane
 *      dispatch prompts carry the sibling-parity check; the other lanes do not;
 *      `off` removes it and is recorded; a malformed value keeps the default.
 *   P. plan.exclusionRationaleCheck (default on):
 *      P1 a scope row closed by an excludes entry whose named behaviour another
 *         checklist item adds or changes is detected (and an unrelated exclusion
 *         is not);
 *      P2 scope_check_save refuses such an `excluded` row with the item named and
 *         saves it under `off` (recording the arm);
 *      P3 story_review rejects it in a verdict saved earlier with ONE Next (a
 *         covering row on that item), and a plain gap whose behaviour an item
 *         changes names that item instead of offering an excludes entry;
 *      P4 the stale verdict is rerun once the checklist changed (next --run);
 *      P5 the scope-plan dispatch prompt carries the reviewer half of the check.
 *
 * Usage: node packages/main/dist/tasks/run43-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as abVariants from '../core/ab-variants.js';
import * as exactText from '../core/exact-text-assertions.js';
import * as planScope from '../core/plan-scope-check-requirement.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, ChecklistItem, StoryInfo } from '../core/types.js';
import { writeStoryRequest } from '../core/story-request.js';
import { createScopeCheckHandlers } from '../handlers/scope-check.js';
import { createStoryReviewHandlers } from '../handlers/story-review.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';

type Fn = (...args: unknown[]) => unknown;
const api = (module: object, name: string): Fn => {
  const fn = (module as Record<string, unknown>)[name];
  assert.equal(typeof fn, 'function', `${name} is exported`);
  return fn as Fn;
};
const loadModule = async (path: string): Promise<object> => { try { return await import(path) as object; } catch { return {}; } };
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error)}`); }
}

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

// ---------------------------------------------------------------------------
// X. exact-text gate: cuts of the actual text

const LIT = 'unknown store key';
const REQUEST = ['## Errors', '- Error strings must match exactly:', `  - \`${LIT}: <key>\``].join('\n');

function exactRepo(): { root: string; gaps: (files: Record<string, string>) => Array<{ literal: string; via: string; line?: number }> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run43-exact-')));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Smoke']);
  git(root, ['config', 'user.email', 'smoke@example.invalid']);
  write(root, 'store/store.go', 'package store\n');
  git(root, ['add', '-A']); git(root, ['commit', '-qm', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']);
  return {
    root,
    gaps: files => {
      for (const [rel, text] of Object.entries(files)) write(root, rel, text);
      git(root, ['add', '-A']); git(root, ['commit', '-qm', 'tests']);
      return exactText.exactTextPrefixAssertions({ gitCwd: root, base, requestText: REQUEST }) as Array<{ literal: string; via: string; line?: number }>;
    },
  };
}

const goTest = (body: string[]): string => ['package store', '', 'import (', '\t"strings"', '\t"testing"', ')', '',
  'func TestGetErrors(t *testing.T) {',
  '\ttests := []struct {', '\t\tkey      string', '\t\texpected string', '\t}{',
  `\t\t{"zz", "${LIT}: zz"},`,
  '\t}',
  '\tfor _, tt := range tests {',
  '\t\terr := get(tt.key)',
  ...body,
  '\t}',
  '}', '',
  'func firstLine(s string) string { return strings.SplitN(s, "\\n", 2)[0] }', ''].join('\n');

await check('X1 an equality against a variable assigned an indexed split of the actual text is a prefix comparison', () => {
  const repo = exactRepo();
  try {
    const gaps = repo.gaps({ 'store/get_test.go': goTest([
      '\t\terrorText := strings.SplitN(err.Error(), "\\n\\t[", 2)[0]',
      '\t\tif errorText != tt.expected {', '\t\t\tt.Errorf("got %q want %q", errorText, tt.expected)', '\t\t}',
    ]) });
    assert.equal(gaps.length, 1, `the cut comparison is a gap: ${JSON.stringify(gaps)}`);
    assert.match(gaps[0]!.via, /cut/, `the Why names the cut: ${gaps[0]!.via}`);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

await check('X2 inline Split(..)[0], a Cut head with a discarded tail, a first-line helper, JS / Python split forms are prefix comparisons', () => {
  const shapes: Array<[string, Record<string, string>]> = [
    ['inline Split(..)[0]', { 'store/get_test.go': goTest(['\t\tif strings.Split(err.Error(), "\\n")[0] != tt.expected {', '\t\t\tt.Fail()', '\t\t}']) }],
    ['Cut head', { 'store/get_test.go': goTest(['\t\thead, _, _ := strings.Cut(err.Error(), "\\n")', '\t\tif head != tt.expected {', '\t\t\tt.Fail()', '\t\t}']) }],
    ['first-line helper', { 'store/get_test.go': goTest(['\t\tif firstLine(err.Error()) != tt.expected {', '\t\t\tt.Fail()', '\t\t}']) }],
    ['JS split', { 'web/get.test.js': [`test('get errors', () => {`, `  const expected = '${LIT}: zz';`, `  expect(get('zz').message.split('\\n')[0]).toBe(expected);`, '});', ''].join('\n') }],
    ['Python splitlines', { 'tools/test_get.py': ['def test_get_errors():', `    expected = "${LIT}: zz"`, '    assert str(get_error("zz")).splitlines()[0] == expected', ''].join('\n') }],
  ];
  for (const [label, files] of shapes) {
    const repo = exactRepo();
    try {
      const gaps = repo.gaps(files);
      assert.equal(gaps.length, 1, `${label}: the cut comparison is a gap: ${JSON.stringify(gaps)}`);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  }
});

await check('X3 kept clear: a split whose other parts are checked too, and a full equality', () => {
  const position = exactRepo();
  try {
    const gaps = position.gaps({ 'store/get_test.go': goTest([
      '\t\tlines := strings.SplitN(err.Error(), "\\n", 2)',
      '\t\tif lines[0] != tt.expected {', '\t\t\tt.Fail()', '\t\t}',
      '\t\tif len(lines) < 2 || !strings.HasPrefix(lines[1], "\\tat line ") {', '\t\t\tt.Fail()', '\t\t}',
    ]) });
    assert.deepEqual(gaps, [], 'exact first line plus a checked position line stays exact (run 40 E2 shape)');
  } finally { rmSync(position.root, { recursive: true, force: true }); }
  const full = exactRepo();
  try {
    assert.deepEqual(full.gaps({ 'store/get_test.go': goTest(['\t\tif err.Error() != tt.expected {', '\t\t\tt.Fail()', '\t\t}']) }), [], 'a full equality is clear');
  } finally { rmSync(full.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Fixture Story (toy store module: get / put)

const STORY_REQUEST = [
  '## Store',
  '- Add `putRange(lo, hi, v)` to the store.',
  '- Add single-key `put(k, v)` on read-only views (returns an error).',
  '- Keep existing single-key put behavior unchanged.',
].join('\n');
const row = (desc: string, test: string) => ({ desc, type: 'logic' as const, priority: 'must' as const, scope: 'focused' as const, expectation: 'absolute_pass' as const,
  requirementSource: 'story' as const, verification: { command: `go test -v ./store -run ^${test}$`, selector: `--- PASS: ${test}` } });
const EXCLUDED = 'Keep existing single-key put behavior unchanged';
const RATIONALE = `${EXCLUDED}: the existing tests exercise it, and this Story only adds range put without altering it.`;
function items(excludes: string[] = [RATIONALE]): ChecklistItem[] {
  return [{
    id: 'CHK-001', title: 'Range put', context: 'store/store.go', userSees: 'putRange(1, 3, "v") stores v under 1 and 2', excludes,
    files: { modify: ['store/store.go'], create: [], test: ['store/store_test.go'] },
    verificationIntent: { happy: [row('putRange(1,3,"v") -> keys 1,2', 'TestPutRange')], edge: [row('putRange(2,2,"v") -> no key', 'TestPutRangeEmpty')], adversarial: [row('putRange(3,1,"v") -> error', 'TestPutRangeReversed')] },
    status: 'pending', startTime: null, endTime: null,
  }, {
    id: 'CHK-002', title: 'Single-key put on read-only views', context: 'store/view.go', userSees: 'view.put(k, v) returns "read-only view"',
    files: { modify: ['store/view.go'], create: [], test: ['store/view_test.go'] },
    verificationIntent: { happy: [row('view.put("a","b") -> read-only view', 'TestViewPut')], edge: [row('view.get("a") -> stored value', 'TestViewGet')], adversarial: [row('view.put("","b") -> read-only view', 'TestViewPutEmpty')] },
    status: 'pending', startTime: null, endTime: null,
  }] as unknown as ChecklistItem[];
}

function planStory(config: Record<string, unknown> = {}): { root: string; storyId: string; ctx: { store: StoryStore; root: string; scanRoot: string } } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run43-plan-')));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' }, ...config }, null, 2));
  write(root, 'README.md', 'fixture\n');
  git(root, ['add', '-A']); git(root, ['commit', '-qm', 'baseline']);
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-43a1';
  const now = '2026-10-10T03:00:00.000Z';
  store.writeStory(storyId, { storyId, name: 'store-put', title: 'Store put forms', description: 'Add range put and view put.', type: 'feature', phase: 'PLAN', priority: 'high',
    createdAt: now, startedAt: now, endedAt: null, events: [{ phase: 'PLAN', action: 'advance', timestamp: now }] } as StoryInfo);
  store.writeChecklist(storyId, { items: items() } as ChecklistData);
  writeStoryRequest(store, { storyId, phase: 'INIT', request: STORY_REQUEST, source: 'smoke', now });
  store.writeDevMemoryPreflightAck(storyId, { schemaVersion: 'proof-or-stop.dev_memory_preflight_ack.v1', storyId, topHitIds: [], acknowledgedAt: now, acknowledgedBy: 'smoke' } as never);
  return { root, storyId, ctx: { store, root, scanRoot: root } };
}

const MANIFEST = { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null };
const excludedVerdict = (storyId: string) => ({ storyId,
  features: [{ feature: 'Range put', status: 'covered', covered_by: 'CHK-001', excluded_by: null, source: 'request.md' },
    { feature: EXCLUDED, status: 'excluded', covered_by: null, excluded_by: RATIONALE, source: 'request.md' },
    { feature: 'Network replication', status: 'excluded', covered_by: null, excluded_by: 'Network replication: reference-only background, out of scope.', source: 'background.md' }],
  summary: { total: 3, covered: 1, excluded: 2, gaps: 0 }, readManifest: MANIFEST, openQuestions: [] });

// ---------------------------------------------------------------------------
// S. sibling parity in the evidence lanes

await check('S review.siblingParity: default on in the test-coverage and quality lane prompts only; off removes it and is recorded; malformed keeps on', () => {
  const { resolveAbVariants, abVariantEvidence } = abVariants as unknown as { resolveAbVariants: (c: unknown) => Record<string, string>; abVariantEvidence: (v: unknown) => unknown };
  assert.equal(resolveAbVariants({}).siblingParity, 'on', 'default on');
  assert.equal(abVariantEvidence(resolveAbVariants({})), undefined, 'the default is production: not recorded');
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ review: { siblingParity: 'off' } })), { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.siblingParity': 'off' } });
  assert.equal(api(abVariants, 'siblingParityOn')({ review: { siblingParity: 'loud' } }), true, 'malformed keeps the default');
  const prompt = (config: Record<string, unknown>, lane: string): string => {
    const { root, storyId, ctx } = planStory(config);
    try {
      ctx.store.writeStory(storyId, { ...ctx.store.readStory(storyId), phase: 'REVIEW', currentReviewRound: '2026-10-10T04:00:00.000Z' });
      return (createStoryDispatchHandlers(ctx as never).dispatch({ storyId, agentType: lane }) as { prompt: string }).prompt;
    } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
  };
  for (const lane of ['proof-or-stop-review-test-coverage', 'proof-or-stop-review-quality']) {
    const on = prompt({}, lane);
    assert.match(on, /Sibling parity/, `${lane}: default on`);
    assert.match(on, /sibling/i);
    assert.doesNotMatch(prompt({ review: { siblingParity: 'off' } }, lane), /Sibling parity/, `${lane}: off removes it`);
    assert.match(prompt({ review: { siblingParity: 'bogus' } }, lane), /Sibling parity/, `${lane}: malformed keeps on`);
  }
  for (const lane of ['proof-or-stop-review-docs', 'proof-or-stop-review-concept']) assert.doesNotMatch(prompt({}, lane), /Sibling parity/, `${lane}: not a parity lane`);
});

// ---------------------------------------------------------------------------
// P. exclusion rationale checked against the Story's own items

await check('P1 an exclusion whose named behaviour another item changes is detected; an unrelated exclusion is not', async () => {
  const mod = await loadModule('../core/scope-exclusion-rationale.js');
  const contradicted = api(mod, 'contradictedExclusions')(excludedVerdict('B-1'), { items: items() }) as Array<{ feature: string; items: Array<{ id: string }> }>;
  assert.equal(contradicted.length, 1, JSON.stringify(contradicted));
  assert.equal(contradicted[0]!.feature, EXCLUDED);
  assert.deepEqual(contradicted[0]!.items.map(item => item.id), ['CHK-002'], 'the item that adds single-key put is named; the range item is not');
  const changing = api(mod, 'itemsChangingBehaviour')('Network replication', items()) as unknown[];
  assert.deepEqual(changing, [], 'no item changes an unrelated behaviour');
});

await check('P2 scope_check_save refuses the contradicted exclusion naming the item; off saves it and records the arm', () => {
  const on = planStory();
  try {
    assert.throws(() => createScopeCheckHandlers(on.ctx as never).scope_check_save(excludedVerdict(on.storyId) as never),
      (error: unknown) => /scope_exclusion_contradicted/.test(String(error)) && /CHK-002/.test(String(error)) && /status\W+gap/.test(String(error)),
      'refused with the item and the gap remedy');
    assert.equal(on.ctx.store.readScopeCheck(on.storyId), null, 'nothing saved');
  } finally { rmSync(on.root, { recursive: true, force: true }); resetConfigCache(); }
  const off = planStory({ plan: { exclusionRationaleCheck: 'off' } });
  try {
    createScopeCheckHandlers(off.ctx as never).scope_check_save(excludedVerdict(off.storyId) as never);
    const saved = off.ctx.store.readScopeCheck(off.storyId) as unknown as { abVariant?: { flags?: Record<string, string> } };
    assert.equal(saved?.abVariant?.flags?.['plan.exclusionRationaleCheck'], 'off', 'the off arm is recorded on the verdict');
  } finally { rmSync(off.root, { recursive: true, force: true }); resetConfigCache(); }
});

await check('P3 story_review rejects an earlier-saved contradicted exclusion with one Next; a gap whose behaviour an item changes names that item', () => {
  const fixture = planStory({ plan: { exclusionRationaleCheck: 'off' } });
  try {
    createScopeCheckHandlers(fixture.ctx as never).scope_check_save(excludedVerdict(fixture.storyId) as never);
    write(fixture.root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' } }, null, 2));
    resetConfigCache();
    const review = createStoryReviewHandlers(fixture.ctx as never).story_review({ storyId: fixture.storyId }) as { issues: Array<{ type: string; severity: string; message: string }> };
    const rejected = review.issues.filter(issue => issue.type === 'scope_exclusion_contradicted');
    assert.equal(rejected.length, 1, `one rejection: ${JSON.stringify(review.issues.map(issue => issue.type))}`);
    assert.equal(rejected[0]!.severity, 'blocker');
    assert.match(rejected[0]!.message, /CHK-002/);
    assert.equal((rejected[0]!.message.match(/Next/g) ?? []).length, 1, `one Next: ${rejected[0]!.message}`);
    assert.match(rejected[0]!.message, /checklist_update --storyId=B-43a1 --itemId=CHK-002/, 'the Next adds a covering row to that item');
    assert.match(rejected[0]!.message, /next --storyId=B-43a1 --run/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); resetConfigCache(); }
  const gap = planStory();
  try {
    createScopeCheckHandlers(gap.ctx as never).scope_check_save({ storyId: gap.storyId,
      features: [{ feature: EXCLUDED, status: 'gap', covered_by: null, excluded_by: null, source: 'request.md' }],
      summary: { total: 1, covered: 0, excluded: 0, gaps: 1 }, readManifest: MANIFEST, openQuestions: [] } as never);
    const review = createStoryReviewHandlers(gap.ctx as never).story_review({ storyId: gap.storyId }) as { issues: Array<{ type: string; message: string }> };
    const remedy = review.issues.find(issue => issue.type === 'scope_gap')!;
    assert.ok(remedy, 'the gap is reported');
    assert.match(remedy.message, /CHK-002/, `the remedy names the item that changes the behaviour: ${remedy.message}`);
    assert.doesNotMatch(remedy.message, /--excludes=/, 'no excludes escape for a behaviour the Story changes');
  } finally { rmSync(gap.root, { recursive: true, force: true }); resetConfigCache(); }
});

await check('P4 a contradicted exclusion in a verdict older than the checklist is a scope-plan rerun reason', () => {
  const fixture = planStory({ plan: { exclusionRationaleCheck: 'off' } });
  try {
    createScopeCheckHandlers(fixture.ctx as never).scope_check_save(excludedVerdict(fixture.storyId) as never);
    write(fixture.root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' } }, null, 2));
    resetConfigCache();
    const story = fixture.ctx.store.readStory(fixture.storyId);
    const rerun = api(planScope, 'scopePlanRerunReason') as (store: unknown, story: unknown, root?: string) => string | null;
    assert.equal(rerun(fixture.ctx.store, story, fixture.root), null, 'unchanged checklist: the owner acts first');
    fixture.ctx.store.writeChecklist(fixture.storyId, { items: items([]) } as ChecklistData);
    assert.match(rerun(fixture.ctx.store, story, fixture.root) ?? '', /exclu/, 'changed checklist: the verdict is rerun');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); resetConfigCache(); }
});

await check('P5 the scope-plan dispatch carries the exclusion check while on, not under off', () => {
  const prompt = (config: Record<string, unknown>): string => {
    const { root, storyId, ctx } = planStory(config);
    try { return (createStoryDispatchHandlers(ctx as never).dispatch({ storyId, agentType: 'proof-or-stop-review-scope-plan' }) as { prompt: string }).prompt; }
    finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
  };
  assert.match(prompt({}), /Exclusion check: an excludes entry closes a row only when its reason holds/);
  assert.doesNotMatch(prompt({ plan: { exclusionRationaleCheck: 'off' } }), /Exclusion check: an excludes entry/);
});

if (failures.length) {
  console.error(`run43-fixes-smoke: FAIL (${failures.length}: ${failures.join('; ')})`);
  process.exit(1);
}
console.log('run43-fixes-smoke: PASS');
