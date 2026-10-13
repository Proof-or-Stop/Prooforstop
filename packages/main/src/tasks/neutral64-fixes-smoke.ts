#!/usr/bin/env node
/**
 * Old-PoS runs 61 / 63 / 64 detection-neutral fixes (bench-staging/oldpos/run62-64-analysis.md;
 * lab `codex/lab-neutral-64`). Unit level, real git repositories. Generic examples only (a toy
 * `put` / `get` store module); no benchmark-task material.
 *
 *   E. Scope-plan "excludes loop" (runs 61 and 63: 3-6 identical scope-plan rounds, ~7 min each).
 *      Root cause: the reviewer saves a `Precedent conflict: ...` gap (plan.baseDisagreement: its
 *      remedy is a covering row, never an excludes entry), but story_review's generic scope_gap
 *      text offered "append an excludes entry" because the deterministic exclusion-rationale
 *      matcher cannot match a long gap sentence. The owner followed the framework, the reviewer
 *      (correctly) kept the gap, and the rerun judged an unchanged checklist again.
 *      E1 a precedent-conflict gap names the covering-row remedy and offers no excludes route;
 *      E2 an excludes-only checklist change does not rerun the reviewer for a gap an excludes entry
 *         cannot close (precedent conflict, or a behaviour an item changes); the blocker keeps the
 *         single covering-row Next and says the excludes entry does not close it;
 *      E3 controls: a covering-row change, a plain gap an excludes entry may close, and a legacy
 *         verdict without the digest still rerun the reviewer (what is reviewed is unchanged);
 *      E4 the rerun prompt carries the owner's excludes in full with the framework's check result.
 *
 * Usage: node packages/main/dist/tasks/neutral64-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as nextDriver from '../handlers/next-driver.js';
import { createMainRegistry } from '../registry.js';
import { rowBudgetNote } from '../core/plan-row-budget.js';
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
// Fixture Story (toy store module: get / put)

const STORY_REQUEST = [
  '## Store',
  '- Add `putRange(lo, hi, v)` to the store.',
  '- Add single-key `put(k, v)` on read-only views (returns an error).',
].join('\n');
const derivation = (desc: string) => ({ requestQuote: 'Add `putRange(lo, hi, v)` to the store.', computation: `Applying the quoted sentence to the stated operands gives ${desc.split('->')[1]?.trim() ?? desc}.` });
const row = (desc: string, test: string) => ({ desc, derivation: derivation(desc), type: 'logic' as const, priority: 'must' as const, scope: 'focused' as const, expectation: 'absolute_pass' as const,
  requirementSource: 'story' as const, verification: { command: `go test -v ./store -run ^${test}$`, selector: `--- PASS: ${test}` } });
const PRECEDENT = 'Precedent conflict: single-key put on read-only views, negative key: map put rejects a negative key with "key out of range" while list put counts from the end; request.md is silent on the negative-key view write case';
const PRECEDENT_ENTRY = `${PRECEDENT}: the request is silent on the write behavior, so this Story leaves the negative-key view write unspecified and keeps the existing read-only error.`;
const PLAIN_GAP = 'Network replication of range puts is not mentioned by any item';
function items(opts: { excludes?: string[]; extraRow?: boolean; repeated?: boolean } = {}): ChecklistItem[] {
  return [{
    id: 'CHK-001', title: 'Range put', context: 'store/store.go', userSees: 'putRange(lo, hi, v): putRange(1, 3, "v") stores v under 1 and 2',
    files: { modify: ['store/store.go'], create: [], test: ['store/store_test.go'] },
    verificationIntent: { happy: [row('putRange(1,3,"v") -> keys 1,2', 'TestPutRange'), ...(opts.repeated ? [row('reverse([1, 2]) -> [2, 1]', 'TestReverseA')] : []),
      ...(opts.repeated ? [row('reverse([3, 4]) -> [4, 3]', 'TestReverseB'), row('reverse([8, 9]) -> [9, 8]', 'TestReverseC')] : [])], edge: [row('putRange(2,2,"v") -> no key', 'TestPutRangeEmpty')], adversarial: [row('putRange(3,1,"v") -> error', 'TestPutRangeReversed')] },
    status: 'pending', startTime: null, endTime: null,
  }, {
    id: 'CHK-002', title: 'Single-key put on read-only views', context: 'store/view.go', userSees: 'view.put(k, v) returns "read-only view"',
    ...(opts.excludes ? { excludes: opts.excludes } : {}),
    files: { modify: ['store/view.go'], create: [], test: ['store/view_test.go'] },
    verificationIntent: {
      happy: [row('view.put("a","b") -> read-only view', 'TestViewPut')],
      edge: [row('view.get("a") -> stored value', 'TestViewGet'), ...(opts.extraRow ? [row('view.put(-1,"b") -> read-only view (the list precedent: counted from the end is not used)', 'TestViewPutNegative')] : [])],
      adversarial: [row('view.put("","b") -> read-only view', 'TestViewPutEmpty')],
    },
    status: 'pending', startTime: null, endTime: null,
  }] as unknown as ChecklistItem[];
}

function planStory(config: Record<string, unknown> = {}, checklist: ChecklistItem[] = items()): { root: string; storyId: string; ctx: { store: StoryStore; root: string; scanRoot: string } } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'neutral64-plan-')));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' }, ...config }, null, 2));
  write(root, 'README.md', 'fixture\n');
  git(root, ['add', '-A']); git(root, ['commit', '-qm', 'baseline']);
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-64a1';
  const now = '2026-10-13T03:00:00.000Z';
  store.writeStory(storyId, { storyId, name: 'store-put', title: 'Store put forms', description: 'Add range put and view put.', type: 'feature', phase: 'PLAN', priority: 'high',
    createdAt: now, startedAt: now, endedAt: null, events: [{ phase: 'PLAN', action: 'advance', timestamp: now }] } as StoryInfo);
  store.writeChecklist(storyId, { items: checklist } as ChecklistData);
  writeStoryRequest(store, { storyId, phase: 'INIT', request: STORY_REQUEST, source: 'smoke', now });
  store.writeDevMemoryPreflightAck(storyId, { schemaVersion: 'proof-or-stop.dev_memory_preflight_ack.v1', storyId, topHitIds: [], acknowledgedAt: now, acknowledgedBy: 'smoke' } as never);
  return { root, storyId, ctx: { store, root, scanRoot: root } };
}

const MANIFEST = { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null };
const gapVerdict = (storyId: string, feature: string) => ({ storyId,
  features: [{ feature: 'Range put', status: 'covered', covered_by: 'CHK-001', excluded_by: null, source: 'request.md' },
    { feature, status: 'gap', covered_by: null, excluded_by: null, source: 'request.md' }],
  summary: { total: 2, covered: 1, excluded: 0, gaps: 1 }, readManifest: MANIFEST, openQuestions: [] });
type Issue = { type: string; severity: string; message: string };
const review = (f: ReturnType<typeof planStory>): Issue[] => (createStoryReviewHandlers(f.ctx as never).story_review({ storyId: f.storyId }) as { issues: Issue[] }).issues;
const rerunReason = (f: ReturnType<typeof planStory>): string | null =>
  (api(planScope, 'scopePlanRerunReason') as (store: unknown, story: unknown, root?: string) => string | null)(f.ctx.store, f.ctx.store.readStory(f.storyId), f.root);
const cleanup = (f: ReturnType<typeof planStory>): void => { rmSync(f.root, { recursive: true, force: true }); resetConfigCache(); };
function withVerdict(feature: string, body: (f: ReturnType<typeof planStory>) => void): void {
  const f = planStory();
  try {
    createScopeCheckHandlers(f.ctx as never).scope_check_save(gapVerdict(f.storyId, feature) as never);
    body(f);
  } finally { cleanup(f); }
}

// ---------------------------------------------------------------------------
// E. scope-plan excludes loop

await check('E1 a precedent-conflict gap: one Next, a covering row on the item that adds the operation, no excludes route', () => {
  withVerdict(PRECEDENT, f => {
    const gap = review(f).find(issue => issue.type === 'scope_gap');
    assert.ok(gap, 'the gap blocks');
    assert.equal(gap.severity, 'blocker');
    assert.doesNotMatch(gap.message, /--excludes=/, `no excludes escape: ${gap.message}`);
    assert.match(gap.message, /--itemId=CHK-002/, `the covering row goes on the item that adds the operation: ${gap.message}`);
    assert.match(gap.message, /excludes entry (?:cannot|does not) close/i, `says why: ${gap.message}`);
    assert.equal((gap.message.match(/Next/g) ?? []).length, 1, `one Next: ${gap.message}`);
  });
});

await check('E2 an excludes-only checklist change does not rerun the reviewer for a gap an excludes entry cannot close', () => {
  withVerdict(PRECEDENT, f => {
    assert.equal(rerunReason(f), null, 'unchanged checklist: the owner acts first');
    f.ctx.store.writeChecklist(f.storyId, { items: items({ excludes: [PRECEDENT_ENTRY] }) } as ChecklistData);
    assert.equal(rerunReason(f), null, 'only an excludes entry was added: the reviewer would re-raise the same gap on the same checklist');
    const gap = review(f).find(issue => issue.type === 'scope_gap');
    assert.ok(gap, 'still blocked');
    assert.doesNotMatch(gap.message, /--excludes=/, `still no excludes route: ${gap.message}`);
    assert.match(gap.message, /--itemId=CHK-002/);
    assert.match(gap.message, /excludes entry (?:cannot|does not) close/i);
    assert.equal((gap.message.match(/Next/g) ?? []).length, 1, `one Next: ${gap.message}`);
  });
  // A gap naming a behaviour another item changes (the run-43 matcher) is the same case.
  withVerdict('Single-key put on read-only views', f => {
    f.ctx.store.writeChecklist(f.storyId, { items: items({ excludes: ['Single-key put on read-only views: the request only asks for ranges.'] }) } as ChecklistData);
    assert.equal(rerunReason(f), null, 'a behaviour the Story itself changes cannot be excluded: no rerun on an excludes-only change');
  });
});

await check('E3 controls: a covering-row change, a plain gap an excludes entry may close, and a legacy verdict still rerun the reviewer', () => {
  withVerdict(PRECEDENT, f => {
    f.ctx.store.writeChecklist(f.storyId, { items: items({ excludes: [PRECEDENT_ENTRY], extraRow: true }) } as ChecklistData);
    assert.match(rerunReason(f) ?? '', /gap/, 'a pin row was added: the reviewer judges it');
  });
  withVerdict(PLAIN_GAP, f => {
    f.ctx.store.writeChecklist(f.storyId, { items: items({ excludes: [`${PLAIN_GAP}: reference-only background, out of scope.`] }) } as ChecklistData);
    assert.match(rerunReason(f) ?? '', /gap/, 'an excludes entry may close a plain gap: the reviewer judges it');
  });
  withVerdict(PRECEDENT, f => {
    const path = join(f.root, '.proof-or-stop/story/actives', f.storyId, 'scope-check.json');
    const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete data.checklistCoreDigest;
    writeFileSync(path, JSON.stringify(data, null, 2));
    f.ctx.store.writeChecklist(f.storyId, { items: items({ excludes: [PRECEDENT_ENTRY] }) } as ChecklistData);
    assert.match(rerunReason(f) ?? '', /gap/, 'a verdict without the core digest keeps the old rule');
  });
});

await check('E4 the rerun prompt carries the owner excludes in full with the framework check result', () => {
  withVerdict(PRECEDENT, f => {
    f.ctx.store.writeChecklist(f.storyId, { items: items({ excludes: [PRECEDENT_ENTRY], extraRow: true }) } as ChecklistData);
    const prompt = (createStoryDispatchHandlers(f.ctx as never).dispatch({ storyId: f.storyId, agentType: 'proof-or-stop-review-scope-plan' }) as { prompt: string }).prompt;
    assert.ok(prompt.includes(PRECEDENT_ENTRY),'the whole excludes entry (not a 200-character clip)');
    assert.match(prompt, /Owner excludes[^\n]*\n[^\n]*CHK-002[^\n]*(?:precedent conflict|cannot close)/i, 'with the deterministic check result');
  });
});

await check('E5 the plan_review_blockers header offers no excludes route when every open scope gap is one an excludes entry cannot close', () => {
  withVerdict(PRECEDENT, f => {
    const blockers = review(f).filter(issue => issue.severity === 'blocker');
    const headerOf = (rows: Array<{ type: string; message: string }>): string =>
      (api(nextDriver, 'storyReviewBlockersStep')({ storyId: f.storyId, phase: 'PLAN' }, 'Cannot enter DEV: 1 unresolved blocker', rows) as { why: string }).why;
    assert.doesNotMatch(headerOf(blockers), /add an excludes entry/, 'no excludes route in the header');
    assert.match(headerOf([{ type: 'scope_gap', message: 'scope gap: the scope-plan reviewer found "x" neither covered nor excluded' }]), /add an excludes entry/, 'a plain gap keeps it');
  });
});

// ---------------------------------------------------------------------------
// R. plan.rowBudget: one concrete, skippable trim step

type Step = { kind: string; reason: string; why: string; batch?: Array<{ command: string; cli: { command: string; payload: Record<string, unknown> }; placeholders?: string[] }>; placeholders?: string[] };
const decide = (f: ReturnType<typeof planStory>): Step => {
  const registry = createMainRegistry(f.ctx as never);
  return nextDriver.createNextDriver(f.ctx as never, (name: string) => registry.get(name)).decide(f.storyId) as unknown as Step;
};

await check('R1 plan.rowBudget=on: ONE plan_row_trim step with the exact checklist_update commands, before the scope-plan reviewer, naming how to skip', () => {
  const f = planStory({ plan: { rowBudget: 'on' } }, items({ repeated: true }));
  try {
    const next = decide(f);
    assert.equal(next.reason, 'plan_row_trim', `the trim step: ${next.reason} ${next.why}`);
    assert.equal(next.kind, 'agent');
    const calls = next.batch ?? [{ command: '', cli: (next as never as { cli: { command: string; payload: Record<string, unknown> } }).cli }];
    assert.equal(calls.length, 1, 'one command per item with extras');
    assert.equal(calls[0]!.cli.command, 'checklist_update');
    assert.ok(!(calls[0]!.placeholders ?? []).length, 'exact commands, nothing to author');
    const intent = (calls[0]!.cli.payload.verificationIntent as { happy: unknown[] });
    assert.equal(intent.happy.length, 1, 'the two repeated rows are dropped, the first of the class stays');
    assert.match(next.why, /skip/i, 'says how to skip');
    assert.equal((next.why.match(/Next/g) ?? []).length <= 1, true);
  } finally { cleanup(f); }
});

await check('R2 skipping: the next call goes on to the scope-plan reviewer and the rows stay (never a gate)', () => {
  const f = planStory({ plan: { rowBudget: 'on' } }, items({ repeated: true }));
  try {
    assert.equal(decide(f).reason, 'plan_row_trim');
    const again = decide(f);
    assert.equal(again.reason, 'scope_plan_review_launch', `the second call does not offer it again: ${again.reason}`);
    assert.equal(f.ctx.store.readChecklist(f.storyId).items[0]!.verificationIntent!.happy.length, 3, 'nothing was dropped by the framework');
  } finally { cleanup(f); }
});

await check('R3 off (default) or nothing repeated: no trim step', () => {
  const off = planStory({}, items({ repeated: true }));
  try { assert.notEqual(decide(off).reason, 'plan_row_trim'); } finally { cleanup(off); }
  const clean = planStory({ plan: { rowBudget: 'on' } });
  try { assert.notEqual(decide(clean).reason, 'plan_row_trim'); } finally { cleanup(clean); }
});

await check('R4 after the trim no further trim step is offered', () => {
  const f = planStory({ plan: { rowBudget: 'on' } }, items({ repeated: true }));
  try {
    const next = decide(f);
    const call = (next.batch?.[0]?.cli ?? (next as never as { cli: { payload: Record<string, unknown> } }).cli);
    const intent = call.payload.verificationIntent as ChecklistItem['verificationIntent'];
    const checklist = f.ctx.store.readChecklist(f.storyId);
    checklist.items[0] = { ...checklist.items[0]!, verificationIntent: intent } as ChecklistItem;
    f.ctx.store.writeChecklist(f.storyId, checklist);
    assert.notEqual(decide(f).reason, 'plan_row_trim');
  } finally { cleanup(f); }
});

await check('R5 the story_create row-budget note ends in one optional Next with the trim command', () => {
  const note = rowBudgetNote('B-64a1', items({ repeated: true }), null);
  assert.match(note, /Next \(optional, skippable\)/);
  assert.equal((note.match(/Next/g) ?? []).length, 1);
  assert.match(note, /proof-or-stop checklist_update '/);
});

if (failures.length) {
  console.error(`neutral64-fixes-smoke: FAIL (${failures.length}: ${failures.join('; ')})`);
  process.exit(1);
}
console.log('neutral64-fixes-smoke: PASS');
