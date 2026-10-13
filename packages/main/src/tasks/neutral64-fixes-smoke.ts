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
const row = (desc: string, test: string) => ({ desc, type: 'logic' as const, priority: 'must' as const, scope: 'focused' as const, expectation: 'absolute_pass' as const,
  requirementSource: 'story' as const, verification: { command: `go test -v ./store -run ^${test}$`, selector: `--- PASS: ${test}` } });
const PRECEDENT = 'Precedent conflict: single-key put on read-only views, negative key: map put rejects a negative key with "key out of range" while list put counts from the end; request.md is silent on the negative-key view write case';
const PRECEDENT_ENTRY = `${PRECEDENT}: the request is silent on the write behavior, so this Story leaves the negative-key view write unspecified and keeps the existing read-only error.`;
const PLAIN_GAP = 'Network replication of range puts is not mentioned by any item';
function items(opts: { excludes?: string[]; extraRow?: boolean } = {}): ChecklistItem[] {
  return [{
    id: 'CHK-001', title: 'Range put', context: 'store/store.go', userSees: 'putRange(1, 3, "v") stores v under 1 and 2',
    files: { modify: ['store/store.go'], create: [], test: ['store/store_test.go'] },
    verificationIntent: { happy: [row('putRange(1,3,"v") -> keys 1,2', 'TestPutRange')], edge: [row('putRange(2,2,"v") -> no key', 'TestPutRangeEmpty')], adversarial: [row('putRange(3,1,"v") -> error', 'TestPutRangeReversed')] },
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

function planStory(): { root: string; storyId: string; ctx: { store: StoryStore; root: string; scanRoot: string } } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'neutral64-plan-')));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' } }, null, 2));
  write(root, 'README.md', 'fixture\n');
  git(root, ['add', '-A']); git(root, ['commit', '-qm', 'baseline']);
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-64a1';
  const now = '2026-10-13T03:00:00.000Z';
  store.writeStory(storyId, { storyId, name: 'store-put', title: 'Store put forms', description: 'Add range put and view put.', type: 'feature', phase: 'PLAN', priority: 'high',
    createdAt: now, startedAt: now, endedAt: null, events: [{ phase: 'PLAN', action: 'advance', timestamp: now }] } as StoryInfo);
  store.writeChecklist(storyId, { items: items() } as ChecklistData);
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
    assert.ok(prompt.includes(PRECEDENT_ENTRY), 'the whole excludes entry (not a 200-character clip)');
    assert.match(prompt, /Owner excludes[^\n]*\n[^\n]*CHK-002[^\n]*(?:precedent conflict|cannot close)/i, 'with the deterministic check result');
  });
});

if (failures.length) {
  console.error(`neutral64-fixes-smoke: FAIL (${failures.length}: ${failures.join('; ')})`);
  process.exit(1);
}
console.log('neutral64-fixes-smoke: PASS');
