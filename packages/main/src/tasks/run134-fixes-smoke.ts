#!/usr/bin/env node
/**
 * Lab run132, third part (old-PoS run 134; bench-staging/oldpos/run134-analysis.md items 1-3): unit level plus one git
 * fixture, made-up rows only (no benchmark-task material).
 *
 *   E. (item 1) The pin-audit correction applied the reviewer's value blind ("Apply the value the verdict requests"); run
 *      134's reviewer asked for an end-inclusive value of an existing end-exclusive range. Now (plan.baseEvidence) the
 *      requested value is checked against Story-base evidence (core/pin-base-evidence.ts): refuted = the gap closes with
 *      the pin kept (journaled, advisory in story_review), a third base value = the row states the base value, no
 *      evidence or a request sentence stating the reviewer's value = the correction is offered as before.
 *   F. (item 2) plan_pin_dispute and the pin-reversal remedy excluded an existing-behaviour case because neither the
 *      request nor the counterpart states its value. Now a case with base evidence is re-pinned to the base value (or
 *      settled); exclusion stays only where no base evidence exists.
 *   G. (item 3) The scope-plan prompt listed plan.md as required reading although this flow writes none; the reviewer
 *      raised an open question "plan.md absent". Now plan.md is named only when the Story has one.
 *
 * Usage: node packages/main/dist/tasks/run134-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const noPlaceholder = (value: unknown): void => assert.doesNotMatch(JSON.stringify(value), /"<[a-z][^"]*>"|-> <[a-z]/i, `no placeholder: ${JSON.stringify(value).slice(0, 400)}`);

const STORY = 'B-1340';
type Row = { desc: string; derivation?: { requestQuote?: string; computation?: string } };
const item = (id: string, lanes: Partial<Record<'happy' | 'edge' | 'adversarial', Row[]>>, extra: Record<string, unknown> = {}) => ({
  id, title: `${id} three-part slices`, status: 'pending', userSees: `${id} user sees`, excludes: [] as string[], files: { modify: ['lang/slice.go'], create: [] },
  verificationIntent: { happy: lanes.happy ?? [], edge: lanes.edge ?? [], adversarial: lanes.adversarial ?? [] }, ...extra,
});
const digestOf = async (items: unknown[]): Promise<string> => (await import('../core/scope-check-integrity.js')).scopeReviewChecklistDigest({ items } as never);
const storeOf = (scope: unknown, items: unknown[]) => ({ readScopeCheck: () => scope, readChecklist: () => ({ items }) });
const scopeOf = async (items: unknown[], features: string[]) => ({ checkedAt: '2026-10-22T00:00:00.000Z', checklistDigest: await digestOf(items),
  features: features.map(feature => ({ feature, status: 'gap', source: 'request.md' })) });

// The existing two-part range is end-exclusive on the base; the reviewer reasons from an end-inclusive background.
const ROW: Row = { desc: '[0,1,2,3][1:2] -> [1]', derivation: { requestQuote: 'existing two-part ranges are unchanged', computation: 'the two-part range [1:2] selects index 1: [1]' } };
const judged = (row: Row = ROW) => [item('CHK-001', { edge: [row] })];
const GAP = 'pin-audit CHK-001:edge:0: pins [0,1,2,3][1:2] -> [1]; request gives [2] because ranges include the end';
const BASE_TEST = (value: string) => ({ path: 'lang/slice_test.go', text: `var cases = []struct{ in, want string }{\n\t{"[0,1,2,3][1:2]", "${value}"},\n\t{"[0,1,2,3][0:1]", "[0]"},\n}\n` });
const ctxOf = (opts: { request?: string | null; tests?: Array<{ path: string; text: string }> } = {}) => ({
  requestText: opts.request ?? 'Add a three-part slice form [a:b:c]. Existing two-part ranges are unchanged.',
  evaluator: () => null,
  baseTests: () => opts.tests ?? [],
});

// ---------------------------------------------------------------------------
// E. Pin-audit value checked against the base

await check('E1 a base test stating the case with the PINNED value refutes the reviewer: decision settle, the gap closes with the row unchanged', async () => {
  const decide = await load('../core/pin-base-evidence.js', 'pinAuditBaseDecisions');
  const items = judged();
  const scope = await scopeOf(items, [GAP]);
  const [decision] = decide(ctxOf({ tests: [BASE_TEST('[1]')] }), items, scope.features);
  assert.equal(decision?.decision, 'settle', JSON.stringify(decision));
  assert.equal(decision.evidence?.source, 'base_test');
  assert.match(decision.why, /slice_test\.go:2/, 'the journaled reason names the base test line');
  const open = await load('../core/pin-audit-correction.js', 'openScopeGaps');
  assert.deepEqual(open(scope, { items }, new Map([[decision.feature, decision.value]])).map((gap: { feature: string }) => gap.feature), [], 'the base-settled gap is closed');
  assert.equal(open(scope, { items }).length, 1, 'without the base value the gap stays open (as before)');
});

await check('E2 next offers no correction to the refuted value; without base evidence (switch off) the reviewer\'s value is offered as before', async () => {
  const decide = await load('../core/pin-base-evidence.js', 'pinAuditBaseDecisions');
  const stepOf = await load('../handlers/next-driver.js', 'pinAuditCorrectionStep');
  const items = judged();
  const scope = await scopeOf(items, [GAP]);
  const decisions = decide(ctxOf({ tests: [BASE_TEST('[1]')] }), items, scope.features);
  assert.equal(stepOf({ storyId: STORY, phase: 'PLAN' }, storeOf(scope, items), new Set(), undefined, { decisions }), null, 'no pin_audit_correction step');
  const blind = stepOf({ storyId: STORY, phase: 'PLAN' }, storeOf(scope, items), new Set(), undefined, null);
  assert.equal(blind?.reason, 'pin_audit_correction', 'off: the step as before');
  assert.match(JSON.stringify(blind.cli.payload), /\[0,1,2,3\]\[1:2\] -> \[2\]/);
});

await check('E3 detection-neutral: no base evidence, base agreeing with the reviewer, or a request sentence stating the reviewer\'s value all keep the correction', async () => {
  const decide = await load('../core/pin-base-evidence.js', 'pinAuditBaseDecisions');
  const items = judged();
  const scope = await scopeOf(items, [GAP]);
  assert.equal(decide(ctxOf(), items, scope.features)[0]?.decision, 'keep', 'no evidence');
  assert.equal(decide(ctxOf({ tests: [BASE_TEST('[2]')] }), items, scope.features)[0]?.decision, 'keep', 'the base agrees with the reviewer');
  assert.equal(decide(ctxOf({ tests: [BASE_TEST('[1]'), { path: 'lang/more_test.go', text: '{"[0,1,2,3][1:2]", "[9]"},\n' }] }), items, scope.features)[0]?.decision, 'keep', 'base tests disagree: no evidence');
  assert.equal(decide(ctxOf({ tests: [{ path: 'lang/slice.go', text: '{"[0,1,2,3][1:2]", "[1]"},\n' }] }), items, scope.features)[0]?.decision, 'keep', 'a non-test source is no evidence');
  const stated = decide(ctxOf({ request: 'Ranges include the end: `[0,1,2,3][1:2] -> [2]`.', tests: [BASE_TEST('[1]')] }), items, scope.features)[0];
  assert.equal(stated?.decision, 'keep', 'a request sentence stating the reviewer\'s value outranks the base');
});

await check('E4 a third base value: the correction offers the BASE value, not the reviewer\'s', async () => {
  const decide = await load('../core/pin-base-evidence.js', 'pinAuditBaseDecisions');
  const stepOf = await load('../handlers/next-driver.js', 'pinAuditCorrectionStep');
  const items = judged({ ...ROW, desc: '[0,1,2,3][1:2] -> [7]' });
  const gap = 'pin-audit CHK-001:edge:0: pins [0,1,2,3][1:2] -> [7]; request gives [2] because ranges include the end';
  const scope = await scopeOf(items, [gap]);
  const decisions = decide(ctxOf({ tests: [BASE_TEST('[1]')] }), items, scope.features);
  assert.equal(decisions[0]?.decision, 'correct');
  assert.equal(decisions[0]?.value, '[1]', 'the quoted base-test group in the row\'s unquoted form');
  const out = stepOf({ storyId: STORY, phase: 'PLAN' }, storeOf(scope, items), new Set(), undefined, { decisions });
  assert.equal(out?.reason, 'pin_audit_correction');
  const payload = JSON.stringify(out.cli.payload);
  assert.match(payload, /\[0,1,2,3\]\[1:2\] -> \[1\]/, payload.slice(0, 300));
  assert.doesNotMatch(payload, /-> \[2\]/);
  noPlaceholder(out.cli.payload);
  assert.match(out.why, /Story base/);
});

// Security review (lab pin-base-assert): the base_test line matcher took any string literal equal to the case followed by
// a value literal. Base evidence REFUTES a reviewer's correction, so a line that names the case and the pinned value but
// denies it (negated / conditional-failure asserts), states the value outside the expected position, comments, or a
// literal that is only part of the subject must never decide.
const ROW_TEST = (text: string) => ({ path: 'lang/slice_test.go', text });
const NOT_EVIDENCE: Record<string, string> = {
  'Go assert.NotEqual(t, case, pinned)': '\tassert.NotEqual(t, "[0,1,2,3][1:2]", "[1]")\n',
  'Python assertNotEqual(case, pinned)': '        self.assertNotEqual("[0,1,2,3][1:2]", "[1]")\n',
  'Go if case == pinned { t.Fatal }': '\tif "[0,1,2,3][1:2]" == "[1]" { t.Fatal("must not give [1]") }\n',
  'JS expect(case).not.toEqual(pinned)': '  expect("[0,1,2,3][1:2]", "[1]").not.toEqual(true)\n',
  'a comment naming the old value': '\t// "[0,1,2,3][1:2]" -> "[1]" was the old, wrong result\n',
  'a commented-out row': '\t// {"[0,1,2,3][1:2]", "[1]"},\n',
  'a three-column row (pinned not in the expected column)': '\t{"[0,1,2,3][1:2]", "[1]", "[2]"},\n',
  'a negation flag column': '\t{"[0,1,2,3][1:2]", "[1]", false},\n',
  'a row of a not-want table': 'var notWant = []struct{ in, notWant string }{\n\t{"[0,1,2,3][1:2]", "[1]"},\n}\n',
  'a row with a doubting trailing comment': '\t{"[0,1,2,3][1:2]", "[1]"}, // wrong, should be [2]\n',
  'Python implicit concatenation (the case is only part of the subject)': '    ("[0,1,2,3][1:2]" "[0]", "[1]"),\n',
  'a parser table row (the printed input, not a value)': '\t{"[0,1,2,3][1:2]", "[0, 1, 2, 3][1:2]"},\n',
};

await check('E8 security: a negated / conditional-failure assert, the value outside the expected position, a comment or a partial subject never refutes a correction', async () => {
  const decide = await load('../core/pin-base-evidence.js', 'pinAuditBaseDecisions');
  const items = judged();
  const scope = await scopeOf(items, [GAP]);
  const wrong: string[] = [];
  for (const [label, text] of Object.entries(NOT_EVIDENCE)) {
    const decision = decide(ctxOf({ tests: [ROW_TEST(text)] }), items, scope.features)[0];
    if (decision?.decision !== 'keep' || decision.evidence) wrong.push(`${label}: ${decision?.decision} (${decision?.why?.slice(0, 80)})`);
  }
  // A third-value line of the same shapes must not re-pin the row either (decision correct).
  const third = judged({ ...ROW, desc: '[0,1,2,3][1:2] -> [7]' });
  const thirdScope = await scopeOf(third, ['pin-audit CHK-001:edge:0: pins [0,1,2,3][1:2] -> [7]; request gives [2] because ranges include the end']);
  for (const [label, text] of Object.entries(NOT_EVIDENCE)) {
    const decision = decide(ctxOf({ tests: [ROW_TEST(text)] }), third, thirdScope.features)[0];
    if (decision?.decision !== 'keep') wrong.push(`third value, ${label}: ${decision?.decision} ${decision?.value}`);
  }
  assert.deepEqual(wrong, [], wrong.join(' ;; '));
});

await check('E9 security: whitespace inside a string literal of the case is significant (len("a b") is not len("ab")); a negated line naming the case vetoes a positive row', async () => {
  const decide = await load('../core/pin-base-evidence.js', 'pinAuditBaseDecisions');
  const items = judged({ desc: 'len("a b") -> 3', derivation: { requestQuote: 'existing len is unchanged', computation: 'three characters' } });
  const scope = await scopeOf(items, ['pin-audit CHK-001:edge:0: pins len("a b") -> 3; request gives 4 because it counts bytes']);
  const squashed = decide(ctxOf({ tests: [ROW_TEST('\t{`len("ab")`, 3},\n')] }), items, scope.features)[0];
  assert.equal(squashed?.decision, 'keep', `a different string literal is another case: ${JSON.stringify(squashed)?.slice(0, 300)}`);
  const base = judged();
  const baseScope = await scopeOf(base, [GAP]);
  const vetoed = decide(ctxOf({ tests: [BASE_TEST('[1]'), ROW_TEST('\tassert.NotEqual(t, "[0,1,2,3][1:2]", "[1]")\n')] }), base, baseScope.features)[0];
  assert.equal(vetoed?.decision, 'keep', `a base that also denies the value does not decide: ${JSON.stringify(vetoed)?.slice(0, 300)}`);
});

await check('E10 the strict positive shapes still decide (Go / JS / Python table rows, keyed rows, a Go composite, a map entry; spacing outside literals is free)', async () => {
  const decide = await load('../core/pin-base-evidence.js', 'pinAuditBaseDecisions');
  const items = judged();
  const scope = await scopeOf(items, [GAP]);
  const positive: Record<string, string> = {
    'Go table row': '\t{"[0,1,2,3][1:2]", "[1]"},\n',
    'Go table row, spaced case': '\t{"[0, 1, 2, 3][1:2]", "[1]"},\n',
    'Go composite value': '\t{"[0,1,2,3][1:2]", []int{1}},\n',
    'Go keyed row': '\t{input: "[0,1,2,3][1:2]", expected: "[1]"},\n',
    'JS array row': '  ["[0,1,2,3][1:2]", "[1]"],\n',
    'JS keyed row': '  { input: "[0,1,2,3][1:2]", want: "[1]" },\n',
    'Python tuple row': '    ("[0,1,2,3][1:2]", "[1]"),\n',
    'Python keyed dict row': '    {"input": "[0,1,2,3][1:2]", "expected": "[1]"},\n',
    'map entry': '    "[0,1,2,3][1:2]": "[1]",\n',
  };
  const missed: string[] = [];
  for (const [label, text] of Object.entries(positive)) {
    const decision = decide(ctxOf({ tests: [ROW_TEST(`var tests = []struct{ input, expected string }{\n${text}}\n`)] }), items, scope.features)[0];
    if (decision?.decision !== 'settle' || decision.evidence?.source !== 'base_test') missed.push(`${label}: ${decision?.decision} (${decision?.why?.slice(0, 80)})`);
  }
  assert.deepEqual(missed, [], missed.join(' ;; '));
});

// ---------------------------------------------------------------------------
// F. Existing-behaviour remedies re-pin to the base instead of excluding

const DISPUTE = { ref: 'CHK-001:edge:0', itemId: 'CHK-001', lane: 'edge', index: 0, verdicts: 2, features: [GAP] };
const evidence = (value: string) => ({ value, status: 'value', source: 'base_test', detail: `the Story base test lang/slice_test.go:2 states \`[0,1,2,3][1:2]\` with "${value}"` });

await check('F1 plan_pin_dispute: a value row whose case the base decides is re-pinned to the base value (ready), not excluded; no evidence = exclude as before', async () => {
  const remedy = await load('../core/pin-dispute.js', 'pinDisputeRemedy');
  const [row] = judged({ ...ROW, desc: '[0,1,2,3][1:2] -> [2]' });
  const based = remedy({ storyId: STORY, item: row, dispute: DISPUTE, requestText: 'Add a three-part slice form.', baseOf: () => evidence('[1]') });
  assert.equal(based?.kind, 'base', JSON.stringify(based));
  noPlaceholder(based.payload);
  assert.equal(based.payload.intentRows[0].desc, '[0,1,2,3][1:2] -> [1]');
  assert.ok(!('excludes' in based.payload), 'no exclusion');
  const settled = remedy({ storyId: STORY, item: judged()[0], dispute: DISPUTE, requestText: 'Add a three-part slice form.', baseOf: () => evidence('[1]') });
  assert.equal(settled?.kind, 'settle', 'a row already pinning the base value stands');
  const blind = remedy({ storyId: STORY, item: row, dispute: DISPUTE, requestText: 'Add a three-part slice form.', baseOf: null });
  assert.equal(blind?.kind, 'exclude', 'no base evidence: exclude as before');
});

await check('F2 pin reversal: request and counterpart silent, the base decides (the earlier pin kept / the base value), never an exclusion', async () => {
  const remedy = await load('../core/pin-amendment.js', 'pinReversalRemedy');
  const [before] = judged();
  const after = { edge: [{ ...ROW, desc: '[0,1,2,3][1:2] -> [2]' }], happy: [], adversarial: [] };
  const reversal = { caseText: '[0,1,2,3][1:2]', oldValue: '[1]', newValue: '[2]' };
  const kept = remedy({ storyId: STORY, item: before, afterIntent: after, reversals: [reversal], requestText: 'Add a three-part slice form.', baseOf: () => evidence('[1]') });
  assert.equal(kept?.kind, 'keep', JSON.stringify(kept)?.slice(0, 300));
  assert.match(JSON.stringify(kept.payload), /\[0,1,2,3\]\[1:2\] -> \[1\]/);
  const third = remedy({ storyId: STORY, item: before, afterIntent: after, reversals: [reversal], requestText: 'Add a three-part slice form.', baseOf: () => evidence('[5]') });
  assert.equal(third?.kind, 'base');
  assert.match(JSON.stringify(third.payload), /-> \[5\]/);
  const blind = remedy({ storyId: STORY, item: before, afterIntent: after, reversals: [reversal], requestText: 'Add a three-part slice form.', baseOf: null });
  assert.notEqual(blind?.kind, 'base', 'no base evidence: the previous remedy');
});

await check('F3 the switch: plan.baseEvidence=off gives no lookup (remedies as before); a known A/B flag, default on', async () => {
  const lookup = await load('../core/pin-base-evidence.js', 'storyBaseEvidenceLookup');
  const resetConfig = await load('../core/config.js', 'resetConfigCache');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run134-f3-')));
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({ plan: { baseEvidence: 'off' } }));
    resetConfig();
    assert.equal(lookup({ readStory: () => ({}) }, root, STORY, root), null);
  } finally { rmSync(root, { recursive: true, force: true }); resetConfig(); }
  const flags = await import('../core/ab-variants.js') as { AB_VARIANT_FLAGS: Record<string, readonly string[]> };
  assert.deepEqual([...(flags.AB_VARIANT_FLAGS['plan.baseEvidence'] ?? [])], ['on', 'off']);
});

// ---------------------------------------------------------------------------
// E5 / G: a real Story (git base with a base test; the dispatch prompt)

async function fixture(opts: { plan?: string; config?: Record<string, unknown> } = {}) {
  const { resetConfigCache } = await import('../core/config.js');
  const { StoryStore } = await import('../core/store.js');
  const { writeStoryRequest } = await import('../core/story-request.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run134-')));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' },
    validate: { commands: [{ id: 'fixture-check', command: process.execPath, args: ['-e', 'console.log("ok")'], env: {}, timeoutMs: 60000 }] }, ...(opts.config ?? {}) }, null, 2));
  write(root, BASE_TEST('[1]').path, BASE_TEST('[1]').text);
  write(root, 'lang/slice.go', 'package lang\n');
  git(root, ['add', '-A']); git(root, ['commit', '-qm', 'baseline']);
  resetConfigCache();
  const store = new StoryStore(root);
  const now = '2026-10-22T03:00:00.000Z';
  store.writeStory(STORY, { storyId: STORY, name: 'three-part-slices', title: 'Three-part slices', description: 'Add [a:b:c].', type: 'feature', phase: 'PLAN', priority: 'high',
    createdAt: now, startedAt: now, endedAt: null, events: [{ phase: 'PLAN', action: 'advance', timestamp: now }] } as never);
  // Complete rows (the dispatch validates the full task context).
  const items = judged().map(entry => ({ ...entry, context: 'lang/slice.go', files: { modify: ['lang/slice.go'], create: [], test: ['lang/slice_test.go'] }, startTime: null, endTime: null,
    verificationIntent: { ...entry.verificationIntent, edge: entry.verificationIntent.edge.map(row => ({ ...row, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass',
      requirementSource: 'story', verification: { command: 'go test -v ./lang -run ^TestSlice$', selector: '--- PASS: TestSlice' } })) } }));
  store.writeChecklist(STORY, { items } as never);
  writeStoryRequest(store, { storyId: STORY, phase: 'INIT', request: 'Add a three-part slice form [a:b:c]. Existing two-part ranges are unchanged.', source: 'smoke', now });
  if (opts.plan) writeFileSync(store.storyFilePath(STORY, 'plan.md'), opts.plan);
  store.writeScopeCheck(STORY, await scopeOf(items, [GAP]) as never);
  return { root, store, cleanup: () => { rmSync(root, { recursive: true, force: true }); resetConfigCache(); } };
}

await check('E5 a real Story: the base test at the Story base refutes the reviewer; the decision is journaled; plan.baseEvidence=off = no decision', async () => {
  const planBase = await load('../core/pin-base-evidence.js', 'planPinAuditBase');
  const on = await fixture();
  try {
    const evidence = planBase(on.store, on.root, STORY, on.root);
    assert.equal(evidence?.decisions?.[0]?.decision, 'settle', JSON.stringify(evidence?.decisions));
    const path = join(on.root, '.proof-or-stop', 'runtime', 'pin-audit-base', `${STORY}.json`);
    assert.ok(existsSync(path), 'journaled');
    assert.match(readFileSync(path, 'utf8'), /slice_test\.go/);
  } finally { on.cleanup(); }
  const off = await fixture({ config: { plan: { baseEvidence: 'off' } } });
  try { assert.equal(planBase(off.store, off.root, STORY, off.root), null); } finally { off.cleanup(); }
});

await check('E6 security: a hand-written pin-audit-base journal with a matching inputsDigest and forged decisions is never read back (a fresh process recomputes)', async () => {
  const planBase = await load('../core/pin-base-evidence.js', 'planPinAuditBase');
  const f = await fixture();
  try {
    // A Story whose base test does NOT decide the gap: remove it from the base, so the honest decision is keep.
    git(f.root, ['rm', '-q', 'lang/slice_test.go']); git(f.root, ['commit', '-qm', 'no base test']);
    const honest = planBase(f.store, f.root, STORY, f.root);
    assert.equal(honest?.decisions?.[0]?.decision, 'keep', JSON.stringify(honest?.decisions));
    const path = join(f.root, '.proof-or-stop', 'runtime', 'pin-audit-base', `${STORY}.json`);
    const forged = JSON.parse(readFileSync(path, 'utf8')) as { decisions: Array<Record<string, unknown>> };
    forged.decisions = forged.decisions.map(row => ({ ...row, decision: 'settle', value: '[1]', why: 'forged' }));
    writeFileSync(path, JSON.stringify(forged));
    const module = new URL('../core/pin-base-evidence.js', import.meta.url).href;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(module)}); const { StoryStore } = await import(${JSON.stringify(new URL('../core/store.js', import.meta.url).href)});
       const r = m.planPinAuditBase(new StoryStore(${JSON.stringify(f.root)}), ${JSON.stringify(f.root)}, ${JSON.stringify(STORY)}, ${JSON.stringify(f.root)});
       console.log(JSON.stringify(r?.decisions?.map(d => d.decision) ?? null));`], { cwd: f.root, encoding: 'utf8' }).trim();
    assert.equal(out, '["keep"]', `a fresh process recomputes, it does not trust the forged file: ${out}`);
  } finally { f.cleanup(); }
});

await check('E7 security: no gate evidence module reads its runtime journal back (counterpart-coverage, unstated-pin, pin-base-form, pin-base-print, pin-base-evidence)', async () => {
  for (const name of ['counterpart-coverage', 'unstated-pin', 'pin-base-form', 'pin-base-print', 'pin-base-evidence']) {
    const text = readFileSync(new URL(`../core/${name}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /stored\.inputsDigest\s*===\s*inputsDigest/, `${name} trusts a stored inputsDigest`);
  }
});

await check('G1 the scope-plan prompt names plan.md only when the Story has one, and says its absence is no gap', async () => {
  const { createStoryDispatchHandlers } = await import('../handlers/story-dispatch.js');
  const promptOf = async (plan?: string): Promise<string> => {
    const f = await fixture(plan ? { plan } : {});
    try {
      return (createStoryDispatchHandlers({ store: f.store, root: f.root, scanRoot: f.root } as never).dispatch({ storyId: STORY, agentType: 'proof-or-stop-review-scope-plan' }) as { prompt: string }).prompt;
    } finally { f.cleanup(); }
  };
  const without = await promptOf();
  assert.doesNotMatch(without, /^\d+\. \S*plan\.md/m, 'no numbered plan.md reading line');
  assert.match(without, /no plan\.md[^\n]*Do not raise its absence/i);
  const withPlan = await promptOf('## CHK-001\nthe plan\n');
  assert.match(withPlan, /^4\. \S*plan\.md$/m, 'a Story with plan.md: named as before');
});

if (failures.length) {
  console.log(`run134-fixes-smoke: ${failures.length} check(s) FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('run134-fixes-smoke: all checks passed');
