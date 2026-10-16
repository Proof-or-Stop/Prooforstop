#!/usr/bin/env node
/**
 * Old-PoS runs 100-103 (bench-staging/oldpos/run100-103-analysis.md §5; lab `codex/lab-run102`). Unit level on made-up
 * stores and a made-up interpreter (no benchmark-task material). The lifecycle shapes are harness NCD, NCE and NCS.
 *
 *   V. Value-aware counterpart coverage: a row pinning an error / rejection for a case the same receiver's counterpart
 *      RESOLVES (it counts a negative index from the end: a wrap assignment in its body, or a base probe answering a
 *      value) is no coverage; the refusal names it and its Next re-pins that row to the counterpart's value (computed
 *      for a single-character string write, else a placeholder naming the counterpart). A row agreeing with the
 *      counterpart is counterpart-backed; a negative index past the length (the counterpart does not resolve it) and a
 *      request sentence that states the case keep their old meaning.
 *   P. The pin dispute never removes / excludes a case the counterpart gate requires: a counterpart-backed row is not
 *      disputed (null), a contradicted row is re-pinned to the counterpart value, an error row of a case the counterpart
 *      does not resolve is relaxed (the case kept); `index out of range: N` is an error pin.
 *   G. A pin-audit gap that cites only counterpart-backed rows is settled by the framework (precedence: request text >
 *      the same receiver's base counterpart > reviewer opinion); the scope-plan prompt lists those rows.
 *   C. Cycle breaker: a PLAN remedy that reverses another step's remedy on the same case is a conflict resolved by the
 *      precedence (request > base / counterpart > reviewer), never alternated; repeats of one step are no conflict.
 *   S. plan.counterpartCoverage is on by default (`off` is the recorded rollback).
 *
 * Usage: node packages/main/dist/tasks/run102-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const row = (desc: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story',
  verification: { command: 'go test -v ./eval -run ^TestAssign$', selector: '--- PASS: TestAssign' }, derivation: { requestQuote: QUOTE, computation: 'x' }, ...extra });
const item = (id: string, rows: { happy?: string[]; edge?: string[]; adversarial?: string[] }, extra: Record<string, unknown> = {}) => ({
  id, title: 'Character assignment on text values', status: 'pending', userSees: 'A text variable accepts `t[i] = "c"`.', context: '', excludes: [] as string[],
  files: { modify: ['eval/eval.go'], create: [], test: ['eval/eval_test.go'] },
  verificationIntent: { happy: (rows.happy ?? []).map(desc => row(desc)), edge: (rows.edge ?? []).map(desc => row(desc)), adversarial: (rows.adversarial ?? []).map(desc => row(desc)) }, ...extra,
});

// A made-up interpreter: the text read counts a negative index from the end (a wrap), the list write rejects it.
const EVAL = [
  'package eval', '',
  'func evalStringIndexExpression(str, index Object) Object {',
  '\ts := str.(*String).Value',
  '\tidx := index.(*Number).Int()',
  '\tmax := len(s) - 1',
  '\tif idx > max {', '\t\treturn &String{Value: ""}', '\t}',
  '\tif idx < 0 {', '\t\tlength := max + 1',
  '\t\tif -idx > length {', '\t\t\treturn &String{Value: ""}', '\t\t}',
  '\t\tidx = length + idx', '\t}',
  '\treturn &String{Value: string(s[idx])}', '}', '',
  'func evalIndexAssignment(target, index, value Object) Object {',
  '\tswitch left := target.(type) {',
  '\tcase *Array:',
  '\t\tidx := index.(*Number).Int()',
  '\t\tif idx < 0 {', '\t\t\treturn newError("index out of range: %d", idx)', '\t\t}',
  '\t\tleft.Elements[idx] = value',
  '\t\treturn value',
  '\t}',
  '\treturn newError("index assignment not supported: %s", target.Type())', '}', '',
].join('\n');
const EVAL_TEST = [
  'package eval', '',
  'var stringIndexTests = []struct{ input, want string }{',
  '\t{`"pqr"[0]`, "p"},',
  '\t{`"pqr"[-1]`, "r"},',
  '\t{`"pqr"[7]`, ""},',
  '}', '',
].join('\n');
const INTERP = [{ path: 'eval/eval.go', text: EVAL }, { path: 'eval/eval_test.go', text: EVAL_TEST }];
const QUOTE = 'A text variable accepts `t[i] = "c"`, which replaces the character at index i.';
const REQUEST = `Add character assignment to text values.\n\n- ${QUOTE}\n`;
const HAPPY = 't = "pqr"; t[1] = "z"; t -> "pzr"';
const ERROR_NEG = 't = "pqr"; t[-1] = "z" -> index out of range: -1';
const VALUE_NEG = 't = "pqr"; t[-1] = "z"; t -> "pqz"';
const OOR = 't = "pqr"; t[5] = "z" -> index out of range: 5';

// A made-up Go store (method form): Rack.Get wraps a negative index (`i += len(...)`), Tray.Put rejects it.
const RACK = [
  'package store', '', 'import "errors"', '',
  'var ErrOutOfRange = errors.New("index out of range")', '',
  'type Rack struct {', '\tslots []string', '}', '',
  'func NewRack(slots ...string) *Rack { return &Rack{slots: slots} }', '',
  'func (r *Rack) Get(i int) (string, error) {',
  '\tif i < 0 {', '\t\ti += len(r.slots)', '\t}',
  '\tif i < 0 || i >= len(r.slots) {', '\t\treturn "", ErrOutOfRange', '\t}',
  '\treturn r.slots[i], nil', '}', '',
].join('\n');
const TRAY = [
  'package store', '',
  'type Tray struct {', '\tslots []string', '}', '',
  'func (t *Tray) Put(i int, v string) error {',
  '\tif i < 0 || i >= len(t.slots) {', '\t\treturn ErrOutOfRange', '\t}',
  '\tt.slots[i] = v', '\treturn nil', '}', '',
].join('\n');
const RACK_TEST = [
  'package store', '', 'import "testing"', '',
  'func TestRackGet(t *testing.T) {',
  '\tr := NewRack("a", "b", "c")',
  '\tif got, _ := r.Get(-1); got != "c" {', '\t\tt.Fatalf("Get(-1) = %q", got)', '\t}',
  '\tif _, err := r.Get(3); err != ErrOutOfRange {', '\t\tt.Fatalf("Get(3) err = %v", err)', '\t}',
  '}', '',
].join('\n');
const STORE = [{ path: 'store/rack.go', text: RACK }, { path: 'store/tray.go', text: TRAY }, { path: 'store/rack_test.go', text: RACK_TEST }];

const edgeOf = (result: any, edge: string): any => result.checks.flatMap((c: any) => c.edges).find((e: any) => e.edge === edge);

// ---------------------------------------------------------------------------
// V. Value-aware coverage

await check('V1 an error row for a negative index the counterpart wraps is no coverage: refused, the row named, the Next re-pins it to the computed counterpart value', async () => {
  const coverage = await load('../core/counterpart-coverage.js', 'counterpartCoverage');
  const payloadOf = await load('../core/counterpart-coverage.js', 'counterpartNextPayload');
  const describe = await load('../core/counterpart-coverage.js', 'describeCounterpartRefusal');
  const chk = item('CHK-001', { happy: [HAPPY], edge: [ERROR_NEG, OOR] });
  const result = coverage({ files: INTERP, items: [chk], requestText: REQUEST });
  const negative = edgeOf(result, 'negative');
  assert.equal(negative?.coveredBy, null, `the error row does not cover the negative class: ${JSON.stringify(negative)}`);
  assert.match(String(negative?.resolves?.text ?? ''), /idx = length \+ idx/, 'the wrap is the evidence that the counterpart resolves the case');
  assert.equal(result.refusals.length, 1, JSON.stringify(result.refusals));
  assert.deepEqual(result.refusals[0].edges, ['negative'], 'out of range stays covered by its error row (the counterpart does not resolve it)');
  assert.match(describe(result.refusals[0]), /CHK-001:edge:0 pins an error[^]*resolves/, describe(result.refusals[0]));
  const payload = payloadOf('B-1021', chk, result.refusals[0]);
  assert.deepEqual(payload.intentRows.map((r: any) => r.ref), ['CHK-001:edge:0'], 'the contradicting row is patched in place (no appended placeholder)');
  assert.equal(payload.intentRows[0].desc, VALUE_NEG, 'the counterpart value is computed: the last character replaced');
  assert.doesNotMatch(JSON.stringify(payload), /"<[^"]*>"/, 'nothing to author');
});

await check('V2 a counterpart-consistent row covers and is counterpart-backed; a negative index past the length keeps an error row as coverage', async () => {
  const coverage = await load('../core/counterpart-coverage.js', 'counterpartCoverage');
  const result = coverage({ files: INTERP, items: [item('CHK-001', { happy: [HAPPY], edge: [VALUE_NEG, OOR] })], requestText: REQUEST });
  assert.equal(result.refusals.length, 0, JSON.stringify(result.refusals));
  assert.deepEqual(edgeOf(result, 'negative')?.backed, ['CHK-001:edge:0'], 'the value the framework computes from the counterpart');
  const far = coverage({ files: INTERP, items: [item('CHK-001', { happy: [HAPPY], edge: ['t = "pqr"; t[-7] = "z" -> index out of range: -7', OOR] })], requestText: REQUEST });
  assert.equal(edgeOf(far, 'negative')?.coveredBy, 'CHK-001:edge:0', 'the counterpart does not resolve -7 on a 3-character value');
});

await check('V3 the request stating the error for the operation and case keeps the error row (no refusal)', async () => {
  const coverage = await load('../core/counterpart-coverage.js', 'counterpartCoverage');
  const request = `${REQUEST}- A negative index in a text assignment is rejected with an error.\n`;
  const result = coverage({ files: INTERP, items: [item('CHK-001', { happy: [HAPPY], edge: [ERROR_NEG, OOR] })], requestText: request });
  assert.equal(result.refusals.length, 0, JSON.stringify(result.refusals));
  assert.equal(edgeOf(result, 'negative')?.stated, true);
});

await check('V4 method form: Put(-1) pinned to an error on a 3-slot receiver whose Get wraps is no coverage; the Next names the counterpart (placeholder value)', async () => {
  const coverage = await load('../core/counterpart-coverage.js', 'counterpartCoverage');
  const payloadOf = await load('../core/counterpart-coverage.js', 'counterpartNextPayload');
  const chk = { ...item('CHK-001', { happy: ['r := NewRack("a", "b", "c"); r.Put(1, "x"); r.Get(1) -> "x"'],
    edge: ['r := NewRack("a", "b", "c"); r.Put(-1, "z") -> ErrOutOfRange', 'r := NewRack("a", "b", "c"); r.Put(3, "z") -> ErrOutOfRange'] }), title: 'Add Rack.Put' };
  const result = coverage({ files: STORE, items: [chk], requestText: 'Add `Rack.Put(i, v)`, which replaces the slot at position i.' });
  assert.equal(result.refusals.length, 1, JSON.stringify(result.checks.map((c: any) => c.edges)));
  assert.deepEqual(result.refusals[0].edges, ['negative']);
  const payload = payloadOf('B-1021', chk, result.refusals[0]);
  assert.equal(payload.intentRows[0].ref, 'CHK-001:edge:0');
  assert.match(payload.intentRows[0].desc, /^<.*Rack\.Get/, 'a placeholder naming the counterpart');
});

// ---------------------------------------------------------------------------
// P. Pin dispute vs the counterpart gate

const DISPUTE = (index: number) => ({ ref: `CHK-001:edge:${index}`, itemId: 'CHK-001', lane: 'edge', index, verdicts: 2, features: [] });

await check('P1 a disputed row the counterpart gate requires is never removed or excluded: backed = no remedy, contradicted = re-pin to the counterpart value', async () => {
  const coverage = await load('../core/counterpart-coverage.js', 'counterpartCoverage');
  const remedyOf = await load('../core/pin-dispute.js', 'pinDisputeRemedy');
  const backedItem = item('CHK-001', { happy: [HAPPY], edge: [VALUE_NEG, OOR] });
  const backed = coverage({ files: INTERP, items: [backedItem], requestText: REQUEST });
  assert.equal(remedyOf({ storyId: 'B-1021', item: backedItem, dispute: DISPUTE(0), requestText: REQUEST, counterpart: backed }), null,
    'a counterpart-backed row is settled: no exclude / relax / repin');
  const errorItem = item('CHK-001', { happy: [HAPPY], edge: [ERROR_NEG, OOR] });
  const contradicted = coverage({ files: INTERP, items: [errorItem], requestText: REQUEST });
  const repin = remedyOf({ storyId: 'B-1021', item: errorItem, dispute: DISPUTE(0), requestText: REQUEST, counterpart: contradicted });
  assert.equal(repin?.kind, 'counterpart', JSON.stringify(repin));
  assert.deepEqual(repin.payload.intentRows.map((r: any) => [r.ref, r.desc]), [['CHK-001:edge:0', VALUE_NEG]]);
  assert.equal(repin.payload.excludes, undefined, 'no exclusion of a required case');
});

await check('P2 an error row of a case the counterpart does not resolve (out of range) is relaxed, the case kept; `index out of range: N` is an error pin', async () => {
  const coverage = await load('../core/counterpart-coverage.js', 'counterpartCoverage');
  const remedyOf = await load('../core/pin-dispute.js', 'pinDisputeRemedy');
  const chk = item('CHK-001', { happy: [HAPPY], edge: [VALUE_NEG, OOR] });
  const result = coverage({ files: INTERP, items: [chk], requestText: REQUEST });
  const relax = remedyOf({ storyId: 'B-1021', item: chk, dispute: DISPUTE(1), requestText: REQUEST, counterpart: result });
  assert.equal(relax?.kind, 'relax', JSON.stringify(relax));
  assert.equal(relax.payload.intentRows[0].desc, 't = "pqr"; t[5] = "z" -> error');
  // Without the counterpart result (switch off), the same error row is still relaxed, never excluded.
  const plain = remedyOf({ storyId: 'B-1021', item: chk, dispute: DISPUTE(1), requestText: REQUEST });
  assert.equal(plain?.kind, 'relax', JSON.stringify(plain));
});

// ---------------------------------------------------------------------------
// G. Gaps on counterpart-backed rows

await check('G1 a pin-audit gap citing only counterpart-backed rows is settled (with its reason); a gap on another row is not', async () => {
  const coverage = await load('../core/counterpart-coverage.js', 'counterpartCoverage');
  const settledOf = await load('../core/counterpart-coverage.js', 'counterpartSettledGaps');
  const result = coverage({ files: INTERP, items: [item('CHK-001', { happy: [HAPPY], edge: [VALUE_NEG, OOR] })], requestText: REQUEST });
  const gaps = [
    { feature: 'pin-audit CHK-001:edge:0: pins "pqz"; request gives no settled value (the list write rejects a negative index)', status: 'gap' },
    { feature: 'pin-audit CHK-001:edge:1: pins index out of range: 5; request gives no error text', status: 'gap' },
  ];
  const settled = settledOf(result, gaps) as Map<string, string>;
  assert.deepEqual([...settled.keys()], [gaps[0]!.feature]);
  assert.match(settled.get(gaps[0]!.feature)!, /evalStringIndexExpression[^]*request text > the same receiver's base counterpart > reviewer/, settled.get(gaps[0]!.feature));
});

await check('G2 the scope-plan prompt lists the counterpart-backed rows with the precedence', async () => {
  const coverage = await load('../core/counterpart-coverage.js', 'counterpartCoverage');
  const render = await load('../core/counterpart-coverage.js', 'renderCounterpartBackedRows');
  const result = coverage({ files: INTERP, items: [item('CHK-001', { happy: [HAPPY], edge: [VALUE_NEG, OOR] })], requestText: REQUEST });
  const lines = (render(result) as string[]).join('\n');
  assert.match(lines, /CHK-001:edge:0/);
  assert.match(lines, /evalStringIndexExpression/);
  assert.match(lines, /request text > the same receiver's base counterpart > /);
  assert.equal((render({ checks: [], refusals: [], advisories: [] }) as string[]).length, 0, 'nothing when no row is counterpart-backed');
});

// ---------------------------------------------------------------------------
// C. Cycle breaker

await check('C1 a remedy reversing another step\'s remedy on the same case is a conflict resolved by precedence; a repeat of one step is not', async () => {
  const record = await load('../core/plan-remedy-cycle.js', 'recordPlanRemedy');
  const conflictOf = await load('../core/plan-remedy-cycle.js', 'planRemedyConflict');
  const settledKeys = await load('../core/plan-remedy-cycle.js', 'settledRemedyKeys');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run102-cycle-')));
  try {
    const key = 'CHK-001|text[i] = v|negative';
    record(root, 'B-1021', { kind: 'plan_pin_dispute', keys: [{ key, dir: 'drop' }] });
    assert.equal(conflictOf(root, 'B-1021', { kind: 'plan_pin_dispute', keys: [{ key, dir: 'drop' }] }), null, 'the same step again: no conflict');
    const conflict = conflictOf(root, 'B-1021', { kind: 'counterpart_coverage_missing', keys: [{ key, dir: 'require' }] });
    assert.ok(conflict, 'the counterpart gate reverses the dispute remedy');
    assert.equal(conflict.winner, 'counterpart_coverage_missing', 'base counterpart > reviewer opinion');
    assert.equal(conflict.candidateWins, true);
    record(root, 'B-1021', { kind: 'counterpart_coverage_missing', keys: [{ key, dir: 'require' }] }, conflict);
    assert.deepEqual(settledKeys(root, 'B-1021'), [key], 'the resolution is recorded: the losing remedy is not offered again');
    const reverse = conflictOf(root, 'B-1021', { kind: 'plan_pin_dispute', keys: [{ key, dir: 'drop' }] });
    assert.equal(reverse?.candidateWins, false, 'the dispute remedy loses against the settled case: suppressed');
    assert.equal(conflictOf(root, 'B-1022', { kind: 'counterpart_coverage_missing', keys: [{ key, dir: 'require' }] }), null, 'another Story: no history');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// S. Default

await check('S1 plan.counterpartCoverage is on by default; off is the recorded rollback; malformed keeps the default', async () => {
  const resolve = await load('../core/ab-variants.js', 'resolveAbVariants');
  const evidence = await load('../core/ab-variants.js', 'abVariantEvidence');
  const on = await load('../core/ab-variants.js', 'counterpartCoverageOn');
  assert.equal(resolve({}).counterpartCoverage, 'on');
  assert.equal(on({}), true);
  assert.deepEqual(evidence(resolve({ plan: { counterpartCoverage: 'off' } }))?.flags, { 'plan.counterpartCoverage': 'off' });
  assert.equal(on({ plan: { counterpartCoverage: 'off' } }), false);
  assert.equal(on({ plan: { counterpartCoverage: 'loud' } }), true, 'malformed = the production default');
});

if (failures.length) {
  console.log(`\nrun102-fixes-smoke: ${failures.length} FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nrun102-fixes-smoke: all checks passed');
