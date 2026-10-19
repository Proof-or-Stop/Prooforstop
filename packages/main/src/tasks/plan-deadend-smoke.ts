#!/usr/bin/env node
/**
 * Lab plan-deadend (old-PoS run 121; bench-staging/oldpos/run121-analysis.md): unit level, made-up rows only (no
 * benchmark-task material). The lifecycle shape is harness NPDE / NPDE-D / NPDE-S in tasks/e2e-review-to-done-smoke.ts.
 *
 * Run 121 (pipeline.lean=on) ended in PLAN: the last story_review round had three scope_gap blockers, none of which
 * carried a row patch (a pre-existing doc/code drift sourced from a documentation file, and two coverage gaps whose text
 * matched neither the precedent-conflict nor the changing-behaviour template). storyReviewBlockersStep returned the agent
 * step plan_review_blockers with no command, renderNextStep printed `Next: none runnable (see Why)`, and the owner
 * stopped as its guidance says for "no runnable step". Before that, every plan_pin_dispute step listed the round's other
 * blockers from the story_review round of the PREVIOUS verdict (the dispute was decided before story_review reran), so the
 * current verdict's other gaps were never shown with a remedy.
 *
 *   D. A scope gap sourced from a documentation file that the request neither names nor asks to change, that no item
 *      modifies, and that reports a conflict with the existing behaviour is pre-existing doc/code drift: settled by the
 *      framework (precedence request text > scope boundary > reviewer opinion), not a blocker. Anything else is not.
 *   R. Every other plain scope gap carries a ready covering-row patch on the item it names (else the item whose title /
 *      userSees / files share its terms, else the first open item), so plan_review_blockers always has a command.
 *   N. An agent step never renders "none runnable"; an open question gets its scope_question_resolve call.
 *   S. The switch plan.docDriftSettle (default on, `off` = rollback, malformed = on).
 *
 * Usage: node packages/main/dist/tasks/plan-deadend-smoke.js
 */
import assert from 'node:assert/strict';

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

const REQUEST = [
  'Support stepped ranges on lists and text values.', '',
  '- `xs[a:b:c]` selects every c-th element from a up to b.',
  '- Text slicing counts runes, not bytes.',
  '- Existing two-part ranges keep their current behaviour.', ''].join('\n');
const DOC = 'docs/types/list.md';
const DRIFT = `Applicable list documentation conflict: ${DOC} says xs[0:2] returns [a, b, c], while the existing evaluator excludes the end and returns [a, b]; the PLAN promises unchanged existing behaviour without resolving this published promise`;
const item = (id: string, title: string, userSees: string, modify: string[] = ['eval/eval.go'], status = 'pending') =>
  ({ id, title, userSees, status, files: { modify, create: [], test: ['eval/eval_test.go'] }, excludes: [] as string[] });
const ITEMS = [
  item('CHK-001', 'Parse stepped list ranges', 'xs[0:4:2] parses as a stepped range'),
  item('CHK-002', 'Evaluate stepped list ranges', 'xs[0:4:2] returns every second element'),
  item('CHK-003', 'Evaluate stepped text ranges by rune', 'text ranges select runes, multibyte text included'),
];

// ---------------------------------------------------------------------------
// D. Pre-existing doc/code drift on unrequested documentation is settled by the framework.

await check('D1 a doc-sourced conflict gap on a doc the request neither names nor asks to change, no item modifying it, is settled', async () => {
  const settle = await load('../core/plan-gap-remedy.js', 'docDriftSettlement');
  const settled = settle({ feature: DRIFT, source: DOC, items: ITEMS, requestText: REQUEST });
  assert.ok(settled, 'settled');
  assert.equal(settled.path, DOC);
  assert.match(settled.why, /pre-existing/);
  assert.match(settled.why, /request text > scope boundary > reviewer/);
  // The doc path named only in the text (no source) settles as well; a leading `[tag]` changes nothing.
  assert.ok(settle({ feature: `[docs] ${DRIFT}`, source: null, items: ITEMS, requestText: REQUEST }), 'path named in the text');
});

await check('D2 no settlement when the request names the doc, asks for docs work, an item modifies it, the gap is not doc-sourced, not a conflict, or the request is unknown', async () => {
  const settle = await load('../core/plan-gap-remedy.js', 'docDriftSettlement');
  assert.equal(settle({ feature: DRIFT, source: DOC, items: ITEMS, requestText: `${REQUEST}- Ranges behave as list.md shows.\n` }), null, 'the request names the doc');
  assert.equal(settle({ feature: DRIFT, source: DOC, items: ITEMS, requestText: `${REQUEST}- Update the documentation for ranges.\n` }), null, 'the request asks for docs work');
  assert.equal(settle({ feature: DRIFT, source: DOC, items: [...ITEMS, item('CHK-004', 'Fix list docs', 'list.md shows [a, b]', [DOC])], requestText: REQUEST }), null, 'an item modifies the doc');
  assert.equal(settle({ feature: 'Text slicing counts runes: no multibyte case', source: 'request.md', items: ITEMS, requestText: REQUEST }), null, 'request-sourced gap');
  assert.equal(settle({ feature: `${DOC} describes xs.map(f); no item covers it`, source: DOC, items: ITEMS, requestText: REQUEST }), null, 'no conflict with existing behaviour');
  assert.equal(settle({ feature: DRIFT, source: DOC, items: ITEMS, requestText: null }), null, 'no request text: no precedence');
  assert.equal(settle({ feature: DRIFT.replace(DOC, 'AGENTS.md'), source: 'AGENTS.md', items: ITEMS, requestText: REQUEST }), null, 'agent control files are not documentation');
});

// ---------------------------------------------------------------------------
// R. Every plain scope gap carries a ready covering-row patch.

await check('R1 the covering-row target: the item the gap names, else the best term overlap, else the first open item', async () => {
  const target = await load('../core/plan-gap-remedy.js', 'gapCoveringTarget');
  assert.equal(target('Text ranges are rune-correct: CHK-003 has no multibyte two-part case', ITEMS), 'CHK-003');
  assert.equal(target('CHK-009 and CHK-002 lack a negative step case', ITEMS), 'CHK-002', 'an unknown id is skipped');
  const withdrawn = ITEMS.map(row => row.id === 'CHK-003' ? { ...row, status: 'withdrawn' } : row);
  assert.notEqual(target('CHK-003 lacks a multibyte case for text ranges by rune', withdrawn), 'CHK-003', 'a withdrawn item is never the target');
  assert.equal(target('Multibyte text ranges select runes', ITEMS), 'CHK-003', 'term overlap');
  assert.equal(target('Something unrelated entirely', ITEMS), 'CHK-001', 'first open item');
  assert.equal(target('anything', []), null);
});

await check('R2 the plain-gap remedy names a ready covering row and keeps the excludes route; plan_review_blockers gets one checklist_update per item', async () => {
  const remedy = await load('../core/plan-gap-remedy.js', 'plainScopeGapRemedy');
  const blockersStep = await load('../handlers/next-driver.js', 'storyReviewBlockersStep');
  const render = await load('../handlers/next-driver.js', 'renderNextStep');
  const rerun = 'proof-or-stop next --storyId=B-0001 --run';
  const messages = [
    remedy({ storyId: 'B-0001', feature: 'Text ranges are rune-correct: CHK-003 has no multibyte two-part case after removing its former row', source: ' (source: request.md)', items: ITEMS, rerun, rerunWhat: 'it reruns' }),
    remedy({ storyId: 'B-0001', feature: 'Text assignment distinguishes rune length from byte length: replacement cases are all ASCII', source: ' (source: request.md)', items: ITEMS, rerun, rerunWhat: 'it reruns' }),
  ];
  for (const message of messages) {
    assert.match(message, /neither covered by a checklist item/, 'the finding text stays');
    assert.match(message, /--intentRows='\[\{"ref":"CHK-00\d:edge:\+"/, `a ready covering row: ${message.slice(0, 600)}`);
    assert.match(message, /excludes entry/, 'the reference-only route stays named');
  }
  const next = blockersStep({ storyId: 'B-0001', phase: 'PLAN' }, 'Cannot enter DEV: Latest story_review round has 2 unresolved blocker(s).', messages.map(message => ({ type: 'scope_gap', message })));
  assert.equal(next.reason, 'plan_review_blockers');
  const calls = (next.batch ?? []).map((call: { cli: { command: string; payload: Record<string, unknown> } }) => call.cli);
  assert.ok(calls.length >= 1, 'a batch of row patches');
  const refs = calls.flatMap((call: { payload: { intentRows?: Array<{ ref: string }> } }) => (call.payload.intentRows ?? []).map(row => row.ref));
  assert.ok(refs.includes('CHK-003:edge:+'), `CHK-003 gets a covering row: ${refs.join(', ')}`);
  const text = render(next);
  assert.doesNotMatch(text, /none runnable/, 'never "none runnable" while blockers remain');
});

await check('R3 the run-121 round: two coverage gaps get rows, the doc drift is not among the blockers', async () => {
  const settle = await load('../core/plan-gap-remedy.js', 'docDriftSettlement');
  const remedy = await load('../core/plan-gap-remedy.js', 'plainScopeGapRemedy');
  const gaps = [
    { feature: DRIFT, source: DOC },
    { feature: 'Text ranges are rune-correct: CHK-003 has no multibyte two-part case', source: 'request.md' },
    { feature: 'Text assignment distinguishes rune length from byte length: CHK-003 replacement cases are all ASCII', source: 'request.md' },
  ];
  const blockers = gaps.filter(gap => !settle({ ...gap, items: ITEMS, requestText: REQUEST }));
  assert.deepEqual(blockers.map(gap => gap.source), ['request.md', 'request.md'], 'only the coverage gaps block');
  for (const gap of blockers) assert.match(remedy({ storyId: 'B-0001', feature: gap.feature, source: ` (source: ${gap.source})`, items: ITEMS, rerun: 'x', rerunWhat: 'y' }), /CHK-003:edge:\+/);
});

// ---------------------------------------------------------------------------
// N. No "none runnable" agent step; open questions get their command.

await check('N1 an agent step without a command never renders "none runnable"; a human step still does', async () => {
  const render = await load('../handlers/next-driver.js', 'renderNextStep');
  const step = await load('../handlers/next-driver.js', 'step');
  const agent = render(step({ storyId: 'B-0001', phase: 'PLAN' }, 'agent', 'plan_review_blockers', null, 'fix the listed blockers', 'test'));
  assert.doesNotMatch(agent, /none runnable/, agent);
  assert.match(agent, /proof-or-stop next --storyId=B-0001 --run/, 'the agent step names how to continue');
  const human = render(step({ storyId: 'B-0001', phase: 'PLAN' }, 'human', 'story_resume_needed', null, 'a person decides', 'test'));
  assert.match(human, /none runnable/, 'a human step keeps the stop line');
});

await check('N2 an open-question blocker alone gives a scope_question_resolve call (resolution authored)', async () => {
  const blockersStep = await load('../handlers/next-driver.js', 'storyReviewBlockersStep');
  // RED marker: the module this lab adds (N2 on its own passes on the base only if the batch already existed).
  await load('../core/plan-gap-remedy.js', 'gapCoveringTarget');
  const next = blockersStep({ storyId: 'B-0001', phase: 'PLAN' }, 'Cannot enter DEV: 1 unresolved blocker.', [{ type: 'scope_open_question_unresolved',
    message: 'scope_open_question_unresolved: OQ-1 unresolved — "Which end rule?". Please run `proof-or-stop scope_question_resolve --storyId=B-0001 --oqId=OQ-1 --resolution=...` to provide a written resolution (the main agent is responsible for the conclusion)' }]);
  const calls = (next.batch ?? []).map((call: { cli: { command: string; payload: Record<string, unknown> } }) => call.cli);
  assert.equal(calls.length, 1, `one call: ${JSON.stringify(next).slice(0, 400)}`);
  assert.equal(calls[0].command, 'scope_question_resolve');
  assert.equal(calls[0].payload.oqId, 'OQ-1');
  assert.match(String(calls[0].payload.resolution), /^<.*>$/, 'the resolution is the owner\'s to author');
});

// ---------------------------------------------------------------------------
// S. The switch.

await check('S1 plan.docDriftSettle: default on, off = rollback, malformed = on where consumed', async () => {
  const on = await load('../core/ab-variants.js', 'docDriftSettleOn');
  const resolve = await load('../core/ab-variants.js', 'resolveAbVariants');
  assert.equal(on({}), true);
  assert.equal(on({ plan: { docDriftSettle: 'off' } }), false);
  assert.equal(on({ plan: { docDriftSettle: 'maybe' } }), true);
  assert.throws(() => resolve({ plan: { docDriftSettle: 'maybe' } }), /invalid_ab_variant_config: plan\.docDriftSettle/);
});

if (failures.length) {
  console.log(`\nplan-deadend-smoke: ${failures.length} FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nplan-deadend-smoke: all checks passed');
