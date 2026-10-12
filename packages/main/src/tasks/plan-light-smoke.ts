#!/usr/bin/env node
/**
 * Lab plan-light (structural-cost-analysis.md §7 item 4; new PoS ADR-105,
 * ADR-081, ADR-043, ADR-040): three EXPERIMENTAL switches that make INIT+PLAN
 * lighter, each default off (core/ab-variants.ts).
 *
 * Unit level, generic toy values only:
 *   S. Switches: absent = off (no evidence), on = recorded in abVariantEvidence,
 *      malformed = off where consumed.
 *   P. plan.pinProbe (core/plan-pin-probe.ts): request-literal examples are
 *      parsed from one backtick span or two spans joined by an arrow / a prose
 *      connector; a row whose case is such an input must pin the stated output;
 *      the base judgement refuses a value the base computes differently, keeps
 *      a row whose baseValue records the base value, skips what the base cannot
 *      evaluate, and accepts a pin the isolated or the cumulative run satisfies.
 *   R. plan.rowBudget (core/plan-row-budget.ts): the operand class signature
 *      abstracts literals by class (sign, zero, empty, non-ASCII kept), renames
 *      assigned names; rows whose every case repeats an earlier row's class are
 *      extra, request-literal and exact-text rows never are; an empty result or
 *      an error is another behaviour; the note carries one trim command per item.
 *   M. plan.reviewMerge (core/plan-review-merge.ts): the merged prompt block and
 *      the scope-check.json record exist only with the switch on.
 * The end-to-end arms (DEV entry refused with the observed value, the merged
 * review running once with zero INIT reviewers, the confirmation re-review of
 * changed rows, the row count before/after the trim) are
 * tasks/e2e-review-to-done-smoke.ts NPP, NPM-I, NPM-P and NRB.
 *
 * Usage: node packages/main/dist/tasks/plan-light-smoke.js
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Fn = (...args: unknown[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error)}`); }
}
async function api(module: string, name: string): Promise<Fn> {
  const loaded = await import(new URL(`../core/${module}.js`, import.meta.url).href) as Record<string, unknown>;
  assert.equal(typeof loaded[name], 'function', `${name} is exported by core/${module}.ts`);
  return loaded[name] as Fn;
}
const dirs: string[] = [];
function project(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'plan-light-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify(config));
  return dir;
}

const row = (desc: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story', ...extra });
const item = (id: string, rows: Array<Record<string, unknown>>) => ({ id, title: id, status: 'pending', verificationIntent: { happy: rows, edge: [], adversarial: [] } });

await check('S1 the three switches default off, are recorded when on, and a malformed value is off where consumed', async () => {
  const resolve = await api('ab-variants', 'resolveAbVariants');
  const evidence = await api('ab-variants', 'abVariantEvidence');
  const off = resolve({});
  assert.equal(off.pinProbe, 'off');
  assert.equal(off.reviewMerge, 'off');
  assert.equal(off.rowBudget, 'off');
  assert.equal(evidence(off), undefined);
  const on = resolve({ plan: { pinProbe: 'on', reviewMerge: 'on', rowBudget: 'on' } });
  assert.deepEqual(evidence(on)?.flags, { 'plan.pinProbe': 'on', 'plan.reviewMerge': 'on', 'plan.rowBudget': 'on' });
  assert.throws(() => resolve({ plan: { pinProbe: 'yes' } }), /invalid_ab_variant_config/);
  for (const [name, key] of [['pinProbeOn', 'pinProbe'], ['reviewMergeOn', 'reviewMerge'], ['rowBudgetOn', 'rowBudget']] as const) {
    const fn = await api('ab-variants', name);
    assert.equal(fn({}), false, `${name} absent`);
    assert.equal(fn({ plan: { [key]: 'on' } }), true, `${name} on`);
    assert.equal(fn({ plan: { [key]: 'loud' } }), false, `${name} malformed = off`);
  }
});

await check('P1 request-literal examples: one span with an arrow, two spans joined by an arrow or a connector, never across lines', async () => {
  const examples = await api('plan-pin-probe', 'requestLiteralExamples');
  const text = 'Reads: `f([1, 2, 3]) -> [3, 2, 1]` for a list.\nAlso `g("ab")` returns `"BA"`, and `h(0)` → `1`.\nA name `x` alone,\n`y` is not joined to `z` across a line.';
  assert.deepEqual(examples(text), [
    { input: 'f([1, 2, 3])', output: '[3, 2, 1]' },
    { input: 'g("ab")', output: '"BA"' },
    { input: 'h(0)', output: '1' },
  ]);
});

await check('P2 a row whose input the request states literally must pin the stated output (whitespace and quotes aside)', async () => {
  const cases = await (await import(new URL('../core/request-probes.js', import.meta.url).href) as { itemProbeCases: Fn }).itemProbeCases;
  const mismatches = await api('plan-pin-probe', 'requestLiteralMismatches');
  const request = 'Example: `f([1, 2, 3]) -> [3, 2, 1]`.';
  const wrong = cases(item('CHK-001', [row('f([1,2,3]) -> [1, 2, 3]'), row('f([4]) -> [4]')]), { prose: true });
  const found = mismatches(wrong, request);
  assert.equal(found.length, 1);
  assert.equal(found[0].ref, 'CHK-001:happy:0');
  assert.equal(found[0].source, 'request');
  assert.equal(found[0].observed, '[3, 2, 1]');
  const right = cases(item('CHK-001', [row('f([1, 2, 3]) -> [3,2,1]')]), { prose: true });
  assert.deepEqual(mismatches(right, request), []);
  assert.deepEqual(mismatches(wrong, null), [], 'no request, no check');
});

await check('P3 base judgement: a differing base value is refused; baseValue, an unrunnable base and a satisfied isolated/cumulative run are not', async () => {
  const judge = await api('plan-pin-probe', 'baseDisagreement');
  const pinned = { kind: 'value', text: '[1, 2]' };
  assert.equal(judge({ pinned }, [{ status: 'value', text: '[2, 1]' }]), '[2, 1]', 'unchanged behaviour pinned wrong');
  assert.equal(judge({ pinned }, [{ status: 'value', text: '[1,2]' }]), null, 'agrees (whitespace aside)');
  assert.equal(judge({ pinned }, [{ status: 'value', text: '[2, 1]' }], '[2, 1]'), null, 'baseValue records a deliberate change');
  assert.equal(judge({ pinned }, [{ status: 'value', text: '[2, 1]' }], '[9]'), '[2, 1]', 'a wrong baseValue excuses nothing');
  assert.equal(judge({ pinned }, [{ status: 'error', text: 'parse error' }]), null, 'the base cannot run it: new behaviour, skipped');
  assert.equal(judge({ pinned }, [{ status: 'unrunnable', text: 'identifier not found' }, undefined]), null);
  assert.equal(judge({ pinned }, [{ status: 'value', text: '[9, 9]' }, { status: 'value', text: '[1, 2]' }]), null, 'the cumulative run satisfies it');
  assert.equal(judge({ pinned: { kind: 'error', text: 'out of range' } }, [{ status: 'value', text: '3' }]), '3', 'an error pin the base answers with a value');
});

await check('R1 operand class signature: literals by class, sign/zero/empty/non-ASCII kept, assigned names renamed', async () => {
  const sig = await api('plan-row-budget', 'operandClassSignature');
  assert.equal(sig('a[1:3]'), sig('a[2:4]'));
  assert.notEqual(sig('a[-1:3]'), sig('a[1:3]'));
  assert.notEqual(sig('a[0:3]'), sig('a[1:3]'));
  assert.equal(sig('f("abc")'), sig('f("xy")'));
  assert.notEqual(sig('f("héllo")'), sig('f("hello")'));
  assert.notEqual(sig('f("")'), sig('f("a")'));
  assert.equal(sig('x = [1, 2]; x[1] = 9; x'), sig('y=[3,4,5]; y[2]=7; y'));
  assert.notEqual(sig('f([])'), sig('f([1])'));
  assert.notEqual(sig('f(null)'), sig('f(1)'));
});

await check('R2 rows repeating an earlier row\'s class are extra; request-literal, exact-text, empty-result and error rows are not', async () => {
  const extras = await api('plan-row-budget', 'rowBudgetExtras');
  const request = 'For example `f([5, 6, 7]) -> [7, 6, 5]`.';
  const items = [item('CHK-001', [
    row('f([1, 2]) -> [2, 1]'),
    row('f([3, 4]) -> [4, 3]'),
    row('f([8, 9, 10]) -> [10, 9, 8]'),
    row('f([5, 6, 7]) -> [7, 6, 5]'),
    row('f([]) -> []'),
    row('f([1, 2]) -> exactly [2, 1] (exact output)'),
    row('f(null) -> error \'bad input\''),
  ])];
  const found = extras(items, request);
  assert.deepEqual(found.map((entry: { ref: string; sameAs: string }) => [entry.ref, entry.sameAs]), [['CHK-001:happy:1', 'CHK-001:happy:0'], ['CHK-001:happy:2', 'CHK-001:happy:0']]);
  const note = await api('plan-row-budget', 'rowBudgetNote');
  const text = note('B-0001', items, request);
  assert.match(text, /2 of 7 intent rows repeat an operand class/);
  assert.match(text, /\[row_budget\]/);
  assert.match(text, /proof-or-stop checklist_update '/);
  const trim = await api('plan-row-budget', 'rowBudgetTrimPayload');
  const payload = trim('B-0001', items[0], ['CHK-001:happy:1', 'CHK-001:happy:2']);
  assert.equal(payload.verificationIntent.happy.length, 5, 'the trim keeps every other row');
  assert.equal(note('B-0001', [item('CHK-002', [row('f([1]) -> [1]'), row('f([]) -> []')])], null), '', 'nothing repeats: no note');
});

await check('M1 the merged plan review prompt block and its scope-check record exist only with plan.reviewMerge=on', async () => {
  const lines = await api('plan-review-merge', 'mergedPlanReviewLines');
  const record = await api('plan-review-merge', 'mergedPlanReviewRecord');
  assert.deepEqual(lines(project({})), []);
  assert.equal(record(project({})), null);
  assert.equal(record(project({ plan: { reviewMerge: 'loud' } })), null, 'malformed = off');
  const on = project({ plan: { reviewMerge: 'on' } });
  const text = lines(on).join('\n');
  assert.match(text, /Merged plan review/);
  assert.match(text, /no INIT reviewer ran/);
  assert.match(text, /only a real gap .* or a question the owner must answer before DEV blocks/);
  assert.match(text, /never gaps or questions/);
  assert.deepEqual(record(on), { planReview: 'merged', abVariant: { schema: 'proof-or-stop.ab-variants.v1', flags: { 'plan.reviewMerge': 'on' } } });
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  console.log(`plan-light-smoke: FAIL (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('plan-light-smoke: PASS');
