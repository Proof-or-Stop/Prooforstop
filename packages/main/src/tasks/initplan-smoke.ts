#!/usr/bin/env node
/**
 * Old-PoS INIT + PLAN speedups (bench-staging/oldpos/initplan-breakdown.md §5 ranks 2, 4, 5, 6 and
 * 8-11; lab `codex/lab-initplan`). Unit level (pure functions and the next driver on a store
 * fixture, real git repositories). Generic examples only (made-up `store` / `strs` code); no
 * benchmark-task material. The lifecycle shape is harness NIP.
 *
 *   R. Row-level edits (rank 6): `intentRows` appends a row with `<CHK>:<lane>:+`; the derivation
 *      refusal of checklist_update names a row patch (intentRows) or the staged payload (@file),
 *      never "the complete verificationIntent"; story_review's pin-audit and precedent-gap Next
 *      lines and next's plan_review_blockers are row patches; plan_authoring is a row patch.
 *   L. Fewer PLAN round trips (rank 4 / 9): the dev-memory acknowledgement is a framework step when
 *      the preflight pack is empty; the deterministic PLAN lints (pre-scope authoring, exact whole
 *      error pins, row-vs-request audit) that are due together come as ONE step; story_create /
 *      checklist_update can print the same lints at once (planLintPreview).
 *   B. Base validation (rank 5): the framework runs the project's validate commands on the base in
 *      the background once and hands the cached result to the owner.
 *   P. Scope-plan reviewer preload (rank 2; A/B plan.reviewerPreload, default off): the dispatch
 *      prompt carries background.md, the checklist rows, plan.md / decision.json when present and the
 *      validate config, so the reviewer does not re-read them; off = prompt unchanged.
 *
 * Usage: node packages/main/dist/tasks/initplan-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as nextDriver from '../handlers/next-driver.js';
import { createMainRegistry } from '../registry.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, ChecklistItem, StoryInfo } from '../core/types.js';
import { writeStoryRequest } from '../core/story-request.js';
import { createScopeCheckHandlers } from '../handlers/scope-check.js';
import { createStoryReviewHandlers } from '../handlers/story-review.js';
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

// Isolate the global dev-memory store: the acknowledgement rule reads it.
const memoryHome = realpathSync(mkdtempSync(join(tmpdir(), 'initplan-memory-')));
process.env.PROOF_OR_STOP_GLOBAL_MEMORY_DIR = memoryHome;

// ---------------------------------------------------------------------------
// Fixture Story (toy store module: put / view)

const STORY_REQUEST = [
  '## Store',
  '- Add `putRange(lo, hi, v)` to the store.',
  '- Add single-key `put(k, v)` on read-only views (returns an error).',
  '- `putRange(lo, hi, v)` stores v under every key from lo up to but excluding hi.',
  '- A reversed range errors with `range is reversed`.',
].join('\n');
const QUOTE = 'Add `putRange(lo, hi, v)` to the store.';
const derivation = (desc: string) => ({ requestQuote: QUOTE, computation: `Applying the quoted sentence to the stated operands gives ${desc.split('->')[1]?.trim() ?? desc}.` });
const pin = (test: string) => ({ command: `go test -v ./store -run ^${test}$`, selector: `--- PASS: ${test}` });
const row = (desc: string, test: string, extra: Record<string, unknown> = {}) => ({ desc, derivation: derivation(desc), type: 'logic' as const, priority: 'must' as const, scope: 'focused' as const,
  expectation: 'absolute_pass' as const, requirementSource: 'story' as const, verification: pin(test), ...extra });
const PRECEDENT = 'Precedent conflict: single-key put on read-only views, negative key: map put rejects a negative key with "key out of range" while list put counts from the end; request.md is silent on the negative-key view write case';

function items(opts: { underived?: boolean; exactError?: boolean } = {}): ChecklistItem[] {
  const underived = { ...row('putRange(5,7,"w") -> keys 5,6', 'TestPutRangeHigh'), derivation: undefined };
  return [{
    id: 'CHK-001', title: 'Range put', context: 'store/store.go', userSees: 'putRange(lo, hi, v): putRange(1, 3, "v") stores v under 1 and 2; `range is reversed` on a reversed range',
    files: { modify: ['store/store.go'], create: [], test: ['store/store_test.go'] },
    verificationIntent: {
      happy: [row('putRange(1,3,"v") -> keys 1,2', 'TestPutRange'), ...(opts.underived ? [underived] : [])],
      edge: [row('putRange(2,2,"v") -> no key', 'TestPutRangeEmpty')],
      adversarial: [opts.exactError
        ? row('putRange(3,1,"v") -> the whole error text is exactly "range is reversed"', 'TestPutRangeReversed')
        : row('putRange(3,1,"v") -> error `range is reversed`', 'TestPutRangeReversed')],
    },
    status: 'pending', startTime: null, endTime: null,
  }, {
    id: 'CHK-002', title: 'Single-key put on read-only views', context: 'store/view.go', userSees: 'view.put(k, v) returns "read-only view"',
    files: { modify: ['store/view.go'], create: [], test: ['store/view_test.go'] },
    verificationIntent: {
      happy: [row('view.put("a","b") -> read-only view', 'TestViewPut')],
      edge: [row('view.get("a") -> stored value', 'TestViewGet')],
      adversarial: [row('view.put("","b") -> read-only view', 'TestViewPutEmpty')],
    },
    status: 'pending', startTime: null, endTime: null,
  }] as unknown as ChecklistItem[];
}

type Fixture = { root: string; storyId: string; ctx: { store: StoryStore; root: string; scanRoot: string } };
function planStory(config: Record<string, unknown> = {}, checklist: ChecklistItem[] = items(), opts: { ack?: boolean; background?: string; plan?: string } = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'initplan-')));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' },
    validate: { commands: [{ id: 'fixture-check', command: process.execPath, args: ['-e', 'console.log("base suite ok")'], env: {}, timeoutMs: 60000 }], env: { FIXTURE_CONTEXT: 'store' } }, ...config }, null, 2));
  write(root, 'README.md', 'fixture\n');
  git(root, ['add', '-A']); git(root, ['commit', '-qm', 'baseline']);
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-1a01';
  const now = '2026-10-15T03:00:00.000Z';
  store.writeStory(storyId, { storyId, name: 'store-put', title: 'Store put forms', description: 'Add range put and view put.', type: 'feature', phase: 'PLAN', priority: 'high',
    createdAt: now, startedAt: now, endedAt: null, events: [{ phase: 'PLAN', action: 'advance', timestamp: now }] } as StoryInfo);
  store.writeChecklist(storyId, { items: checklist } as ChecklistData);
  writeStoryRequest(store, { storyId, phase: 'INIT', request: STORY_REQUEST, source: 'smoke', now });
  if (opts.background) writeFileSync(store.storyFilePath(storyId, 'background.md'), opts.background);
  if (opts.plan) writeFileSync(store.storyFilePath(storyId, 'plan.md'), opts.plan);
  if (opts.ack !== false) store.writeDevMemoryPreflightAck(storyId, { schemaVersion: 'proof-or-stop.dev_memory_preflight_ack.v1', storyId, topHitIds: [], acknowledgedAt: now, acknowledgedBy: 'smoke' } as never);
  return { root, storyId, ctx: { store, root, scanRoot: root } };
}
const cleanup = (f: Fixture): void => { rmSync(f.root, { recursive: true, force: true }); resetConfigCache(); };

type Call = { command: string; cli: { command: string; payload: Record<string, unknown> }; placeholders?: string[] };
type Step = { kind: string; reason: string; why: string; cli?: { command: string; payload: Record<string, unknown> } | null; batch?: Call[]; parallel?: Call[] };
const decide = (f: Fixture): Step => {
  const registry = createMainRegistry(f.ctx as never);
  return nextDriver.createNextDriver(f.ctx as never, (name: string) => registry.get(name)).decide(f.storyId) as unknown as Step;
};
const callsOf = (step: Step): Array<{ command: string; payload: Record<string, unknown> }> =>
  step.batch?.length ? step.batch.map(call => call.cli) : step.cli ? [step.cli] : [];

const MANIFEST = { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null };
const gapVerdict = (storyId: string, feature: string) => ({ storyId,
  features: [{ feature: 'Range put', status: 'covered', covered_by: 'CHK-001', excluded_by: null, source: 'request.md' },
    { feature, status: 'gap', covered_by: null, excluded_by: null, source: 'request.md' }],
  summary: { total: 2, covered: 1, excluded: 0, gaps: 1 }, readManifest: MANIFEST, openQuestions: [] });
type Issue = { type: string; severity: string; message: string };
const review = (f: Fixture): Issue[] => (createStoryReviewHandlers(f.ctx as never).story_review({ storyId: f.storyId }) as { issues: Issue[] }).issues;
function withVerdict(feature: string, body: (f: Fixture) => void): void {
  const f = planStory();
  try {
    createScopeCheckHandlers(f.ctx as never).scope_check_save(gapVerdict(f.storyId, feature) as never);
    body(f);
  } finally { cleanup(f); }
}

// ---------------------------------------------------------------------------
// R. Row-level edits

await check('R1 intentRows appends a row with <CHK>:<lane>:+ (existing refs keep their indexes); an item without rows takes appends', async () => {
  const apply = await load('../core/intent-row-patch.js', 'applyIntentRowPatches');
  const item = items()[1]!;
  const result = apply({ storyId: 'B-1a01', item, withWholeIntent: false, withProposalApproval: false, patches: [
    { ref: 'CHK-002:edge:+', desc: 'view.put(-1,"b") -> read-only view', type: 'logic', priority: 'must' },
    { ref: 'CHK-002:happy:0', desc: 'view.put("a","c") -> read-only view' },
  ] }) as { verificationIntent: ChecklistItem['verificationIntent']; refs: string[]; patchRefs?: string[] };
  assert.equal(result.verificationIntent!.edge.length, 2, 'one row appended to edge');
  assert.equal(result.verificationIntent!.edge[0]!.desc, 'view.get("a") -> stored value', 'the existing edge row keeps its index');
  assert.equal(result.verificationIntent!.edge[1]!.desc, 'view.put(-1,"b") -> read-only view');
  assert.equal(result.verificationIntent!.happy[0]!.desc, 'view.put("a","c") -> read-only view', 'in-place patches still apply');
  assert.deepEqual(result.patchRefs, ['CHK-002:edge:1', 'CHK-002:happy:0'], 'each patch maps to its resulting row ref, in patch order');
  const empty = apply({ storyId: 'B-1a01', item: { id: 'CHK-003', verificationIntent: { happy: [], edge: [], adversarial: [] } }, withWholeIntent: false, withProposalApproval: false,
    patches: [{ ref: 'CHK-003:happy:+', desc: 'a -> b' }] }) as { verificationIntent: ChecklistItem['verificationIntent'] };
  assert.equal(empty.verificationIntent!.happy.length, 1, 'an item without rows takes an append');
  assert.throws(() => apply({ storyId: 'B-1a01', item, withWholeIntent: false, withProposalApproval: false, patches: [{ ref: 'CHK-002:edge:+' }] }), /intent_rows_invalid/, 'an appended row needs a desc');
});

await check('R2 checklist_update derivation refusal: a row patch gets ONE intentRows Next with a derivation per listed row; a whole-intent write gets the staged payload (@file); never "the complete verificationIntent"', async () => {
  const failure = await load('../core/intent-derivation.js', 'intentDerivationFailure');
  const base = items({ underived: true })[0]!;
  const viaRows = String(failure('checklist_update', 'CHK-001', base.verificationIntent, STORY_REQUEST,
    { storyId: 'B-1a01', patches: [{ ref: 'CHK-001:happy:+', desc: 'putRange(5,7,"w") -> keys 5,6' }], patchRefs: ['CHK-001:happy:1'] }) ?? '');
  assert.match(viaRows, /\[intent_derivation_required\]/);
  const next = viaRows.split('\n').filter(line => line.startsWith('Next:'));
  assert.equal(next.length, 1, `ONE Next: ${viaRows}`);
  assert.match(next[0]!, /checklist_update '[^']*"intentRows":\[\{"ref":"CHK-001:happy:\+"[^']*"derivation":\{"requestQuote"/, `the same row patch with a derivation: ${next[0]}`);
  assert.doesNotMatch(viaRows, /complete verificationIntent/, 'no whole-intent resend');
  const staged = String(failure('checklist_update', 'CHK-001', base.verificationIntent, STORY_REQUEST, { storyId: 'B-1a01', stagedPath: '/tmp/x/CHK-001.json' }) ?? '');
  assert.match(staged, /Next: [^\n]*proof-or-stop checklist_update @\/tmp\/x\/CHK-001\.json/, `the staged payload: ${staged}`);
  assert.doesNotMatch(staged, /complete verificationIntent/);
});

await check('R3 story_review: a pin-audit gap and a precedent-conflict gap name a row patch (--intentRows=), not "<full intent ...>"', () => {
  withVerdict('pin-audit CHK-001:happy:0: pins keys 1,2; request gives keys 1,2,3 (hi is inclusive per the cited sentence)', f => {
    const gap = review(f).find(issue => issue.type === 'scope_gap');
    assert.ok(gap, 'the pin-audit gap blocks');
    assert.match(gap.message, /--intentRows='\[\{"ref":"CHK-001:happy:0"/, `the pinned row is patched by ref: ${gap.message}`);
    assert.doesNotMatch(gap.message, /full intent/, 'no whole-intent resend');
  });
  withVerdict(PRECEDENT, f => {
    const gap = review(f).find(issue => issue.type === 'scope_gap');
    assert.ok(gap, 'the precedent gap blocks');
    assert.match(gap.message, /--itemId=CHK-002/, 'still the item that adds the operation');
    assert.match(gap.message, /--intentRows='\[\{"ref":"CHK-002:edge:\+"/, `the covering row is appended: ${gap.message}`);
    assert.doesNotMatch(gap.message, /full intent/, 'no whole-intent resend');
  });
});

await check('R4 plan_review_blockers carries the row patches as ONE batch (one checklist_update per item), not prose only', () => {
  withVerdict(PRECEDENT, f => {
    const blockers = review(f).filter(issue => issue.severity === 'blocker');
    const step = nextDriver.storyReviewBlockersStep({ storyId: f.storyId, phase: 'PLAN' }, 'Cannot enter DEV: 1 unresolved blocker', blockers) as unknown as Step;
    const calls = callsOf(step);
    assert.ok(calls.length >= 1, `the step carries commands: ${JSON.stringify(step).slice(0, 400)}`);
    const update = calls.find(call => call.command === 'checklist_update');
    assert.ok(update, 'a checklist_update');
    assert.equal(update!.payload.itemId, 'CHK-002');
    assert.ok(Array.isArray(update!.payload.intentRows), 'a row patch');
    assert.equal(update!.payload.verificationIntent, undefined, 'no whole intent');
  });
});

await check('R5 plan_authoring is a row patch: derivation / pin placeholders on the listed rows, appended placeholder rows, intentBasis kept', () => {
  const unpinned = items({ underived: true });
  unpinned[1]!.verificationIntent!.edge[0] = { ...unpinned[1]!.verificationIntent!.edge[0]!, verification: undefined } as never;
  const f = planStory({}, unpinned);
  try {
    const step = decide(f);
    assert.equal(step.reason, 'plan_authoring', `${step.reason}: ${step.why.slice(0, 300)}`);
    const calls = callsOf(step).filter(call => call.command === 'checklist_update');
    assert.ok(calls.length >= 2, 'one call per item');
    for (const call of calls) {
      assert.equal(call.payload.verificationIntent, undefined, `${String(call.payload.itemId)}: no whole intent`);
      assert.ok(Array.isArray(call.payload.intentRows), `${String(call.payload.itemId)}: intentRows`);
      assert.match(String(call.payload.intentBasis ?? ''), /^[a-f0-9]{16}$/, 'intentBasis kept');
    }
    const one = calls.find(call => call.payload.itemId === 'CHK-001')!.payload.intentRows as Array<Record<string, unknown>>;
    assert.ok(one.some(patch => patch.ref === 'CHK-001:happy:1' && typeof (patch.derivation as Record<string, unknown> | undefined)?.computation === 'string'), `the underived row gets a derivation: ${JSON.stringify(one)}`);
    const two = calls.find(call => call.payload.itemId === 'CHK-002')!.payload.intentRows as Array<Record<string, unknown>>;
    assert.ok(two.some(patch => patch.ref === 'CHK-002:edge:0' && patch.verification), `the unpinned row gets a pin: ${JSON.stringify(two)}`);
  } finally { cleanup(f); }
});

// ---------------------------------------------------------------------------
// L. Fewer PLAN round trips

await check('L1 dev_memory_preflight_ack with an empty preflight pack is a framework step (nothing to read or decide)', () => {
  const f = planStory({}, items(), { ack: false });
  try {
    const step = decide(f);
    assert.equal(step.reason, 'dev_memory_preflight_ack');
    assert.equal(step.kind, 'framework', `the ack is mechanical when the pack is empty: ${step.why}`);
  } finally { cleanup(f); }
  const g = planStory({}, items(), { ack: false });
  try {
    write(g.root, '.proof-or-stop/dev-memory/experience.jsonl', `${JSON.stringify({ id: 'mem0001', createdAt: '2026-10-01T00:00:00.000Z', sourceAgent: 'main-agent', category: 'failure-mode', scope: 'project', summary: 'Store keys are signed in range writes', trigger: 'range writes', lesson: 'test a negative key on every new write path', reusePrompt: 'store put negative key' })}\n`);
    const step = decide(g);
    assert.equal(step.reason, 'dev_memory_preflight_ack');
    assert.equal(step.kind, 'agent', 'a pack with lessons stays the owner\'s (it reads them)');
  } finally { cleanup(g); }
});

await check('L2 the deterministic PLAN lints due together come as ONE step (plan_authoring + exact_error_pin_check rows), each check unchanged', () => {
  const f = planStory({}, items({ underived: true, exactError: true }));
  try {
    const step = decide(f);
    assert.equal(step.reason, 'plan_authoring', `${step.reason}: ${step.why.slice(0, 300)}`);
    assert.match(step.why, /exact_error_pin/, `the exact-error lint is in the same step: ${step.why.slice(0, 600)}`);
    const one = callsOf(step).filter(call => call.command === 'checklist_update' && call.payload.itemId === 'CHK-001');
    assert.equal(one.length, 1, 'ONE checklist_update for CHK-001 carries both lints');
    const refs = (one[0]!.payload.intentRows as Array<{ ref: string }>).map(patch => patch.ref);
    assert.ok(refs.includes('CHK-001:happy:1') && refs.includes('CHK-001:adversarial:0'), `both rows: ${refs.join(', ')}`);
    const again = decide(f);
    assert.notEqual(again.reason, 'exact_error_pin_check', 'the exact-error offer was made in the merged step (offered once per set)');
  } finally { cleanup(f); }
});

await check('L3 planLintPreview lists every PLAN lint due at once (for story_create / checklist_update output), with the row patches', async () => {
  const preview = await load('../core/plan-lint-preview.js', 'planLintPreview');
  const f = planStory({}, items({ underived: true, exactError: true }));
  try {
    const text = String(preview({ store: f.ctx.store, root: f.root, storyId: f.storyId }) ?? '');
    assert.match(text, /CHK-001:happy:1/, `the underived row: ${text}`);
    assert.match(text, /CHK-001:adversarial:0/, 'the exact whole-error row');
    assert.match(text, /intentRows/, 'row patches');
    const clean = planStory();
    try { assert.equal(preview({ store: clean.ctx.store, root: clean.root, storyId: clean.storyId }) ?? null, null, 'nothing due: no note'); } finally { cleanup(clean); }
  } finally { cleanup(f); }
});

// ---------------------------------------------------------------------------
// B. Base validation in the background

await check('B1 the framework runs the validate commands on the base once, in the background; the cached result is handed out; a second start reuses it', async () => {
  const start = await load('../core/base-validation.js', 'startBaseValidation');
  const read = await load('../core/base-validation.js', 'readBaseValidation');
  const render = await load('../core/base-validation.js', 'renderBaseValidationLine');
  const f = planStory();
  try {
    const first = start(f.root) as { state: string; path: string; pid?: number };
    assert.ok(['running', 'done'].includes(first.state), `started: ${JSON.stringify(first)}`);
    const deadline = Date.now() + 20000;
    let state = read(f.root) as { state: string; status?: string; results?: Array<{ tail: string; exit: number }> } | null;
    while (state?.state !== 'done' && Date.now() < deadline) {
      execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
      state = read(f.root) as typeof state;
    }
    assert.equal(state?.state, 'done', 'the background run finished');
    assert.equal(state?.status, 'pass');
    assert.match(state!.results![0]!.tail, /base suite ok/, 'its output is kept');
    const again = start(f.root) as { state: string; pid?: number };
    assert.equal(again.state, 'done', 'a second start reuses the cached result (no second run)');
    const line = String(render(state));
    assert.match(line, /PASS/);
    assert.match(line, /do not (?:re)?run/i, `the owner is told not to rerun it: ${line}`);
    assert.equal(git(f.root, ['status', '--porcelain', '--untracked-files=no']), '', 'no tracked file changed');
  } finally { cleanup(f); }
});

// ---------------------------------------------------------------------------
// P. Scope-plan reviewer preload (A/B plan.reviewerPreload)

await check('P1 plan.reviewerPreload=on inlines background.md, the checklist rows, plan.md and the validate config in the scope-plan prompt; off = unchanged', async () => {
  const background = '## Trigger Event\nThe store has no range put; a fixture-unique sentence ZEBRA-PRELOAD-7 lives here.\n';
  const plan = '## CHK-001\nput each key of the range; fixture-unique PLAN-PRELOAD-9.\n';
  const promptOf = (config: Record<string, unknown>): string => {
    const f = planStory(config, items(), { background, plan });
    try {
      return (createStoryDispatchHandlers(f.ctx as never).dispatch({ storyId: f.storyId, agentType: 'proof-or-stop-review-scope-plan' }) as { prompt: string }).prompt;
    } finally { cleanup(f); }
  };
  const off = promptOf({});
  const on = promptOf({ plan: { reviewerPreload: 'on' } });
  assert.doesNotMatch(off, /ZEBRA-PRELOAD-7/, 'off: background.md is a path to read, as before');
  assert.match(on, /ZEBRA-PRELOAD-7/, 'on: background.md inline');
  assert.match(on, /PLAN-PRELOAD-9/, 'on: plan.md inline');
  assert.match(on, /TestPutRangeEmpty/, 'on: the checklist rows inline');
  assert.match(on, /FIXTURE_CONTEXT/, 'on: the validate config inline');
  assert.match(on, /do not re-read/i, 'on: the reviewer is told the preloaded files need no re-read');
  console.log(`     scope-plan prompt bytes: off ${Buffer.byteLength(off)} -> on ${Buffer.byteLength(on)} (+${Buffer.byteLength(on) - Buffer.byteLength(off)})`);
  const flags = await import('../core/ab-variants.js') as { AB_VARIANT_FLAGS: Record<string, readonly string[]> };
  assert.deepEqual([...(flags.AB_VARIANT_FLAGS['plan.reviewerPreload'] ?? [])], ['off', 'on'], 'the switch is a known A/B flag, default off');
});

rmSync(memoryHome, { recursive: true, force: true });
if (failures.length) {
  console.log(`\ninitplan-smoke: FAIL (${failures.length}: ${failures.join(', ')})`);
  process.exit(1);
}
console.log('\ninitplan-smoke: PASS');
