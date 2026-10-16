#!/usr/bin/env node
/**
 * Lab sibling-gate (switch plan.counterpartCoverage, default on since lab run102; was EXPERIMENTAL, default
 * off; core/counterpart-coverage.ts). Old-PoS runs 43 / 46 / 55 / 57 / 71
 * (bench-staging/oldpos/run69-72-analysis.md §1): a Story added a NEW write
 * path for a receiver type, the request was silent on a negative operand, and
 * the implementer copied another receiver's write guard (reject) instead of the
 * same receiver's existing read rule (count from the end). Only a scope-plan
 * reviewer that happened to flag the precedent conflict saved the case.
 *
 * Unit level on made-up stores (no task values):
 *   S.  The switch: absent = on since lab run102 (no evidence), off = recorded, malformed = the default.
 *   D1. Method form (Go): Shelf.Get counts a negative index from the end
 *       (branch + base test), Bin.Put rejects it; an item adding Shelf.Put with
 *       only in-range rows is refused for negative and out of range, the
 *       counterpart Shelf.Get named first and Bin.Put only second; an
 *       `err != nil` check is no null special case.
 *   D2. Index form (Go interpreter): the string read wraps a negative index
 *       (branch + a base test of `"abc"[-1]`), the array write rejects it; a row
 *       `s = "abc"; s[1] = "x"` adds string single-index assignment and is
 *       refused for negative and out of range.
 *   D3. Probe evidence: without base tests, a declared evaluator whose base read
 *       answers a value for a negative index makes the class clear on its own.
 *   N1. No same-receiver counterpart (only another receiver has one): no check.
 *   N2. The request states the operation's negative / out-of-range behaviour:
 *       recorded as stated, no refusal.
 *   N3. Rows on the new operation for each class: covered, no refusal.
 *   N4. One signal only (branch, no base test, no probe): advisory, no refusal.
 *   N5. The receiver already has the operation in the base (a change): advisory.
 *   T1. Refusal text: rule code, item, operation, counterpart, classes, oracle
 *       order, ONE Next (since lab initplan a row patch appending one
 *       placeholder row per uncovered class).
 *   I1. Implementer block: probe the counterpart on the Story base, report
 *       `[counterpart] <op> :: <case> -> <base result>` lines; byte size printed.
 * End to end (DEV entry refused, next step, fix, switch-absent control, the
 * implementer dispatch prompt): tasks/e2e-review-to-done-smoke.ts NCC.
 *
 * Usage: node packages/main/dist/tasks/counterpart-coverage-smoke.js
 */
import assert from 'node:assert/strict';

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

const row = (desc: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story', ...extra });
const item = (id: string, title: string, rows: { happy?: string[]; edge?: string[]; adversarial?: string[] }, extra: Record<string, unknown> = {}) => ({
  id, title, status: 'pending', userSees: `${title} works`, context: '', files: { modify: [], create: [], test: [] },
  verificationIntent: { happy: (rows.happy ?? []).map(desc => row(desc)), edge: (rows.edge ?? []).map(desc => row(desc)), adversarial: (rows.adversarial ?? []).map(desc => row(desc)) }, ...extra,
});

// A made-up Go store: Shelf.Get counts a negative index from the end; Bin.Put rejects it.
const SHELF = [
  'package store', '', 'import "errors"', '',
  '// ErrOutOfRange is returned for an index outside the store.',
  'var ErrOutOfRange = errors.New("index out of range")', '',
  '// Shelf is an ordered row of labels.',
  'type Shelf struct {', '\titems []string', '}', '',
  'func NewShelf(items ...string) *Shelf { return &Shelf{items: items} }', '',
  'func (s *Shelf) check() error { return nil }', '',
  '// Get returns the label at i; a negative i counts from the end.',
  'func (s *Shelf) Get(i int) (string, error) {',
  '\tif err := s.check(); err != nil {', '\t\treturn "", err', '\t}',
  '\tif i < 0 {', '\t\ti += len(s.items)', '\t}',
  '\tif i < 0 || i >= len(s.items) {', '\t\treturn "", ErrOutOfRange', '\t}',
  '\treturn s.items[i], nil', '}', '',
].join('\n');
const BIN = [
  'package store', '',
  '// Bin is a fixed set of slots.',
  'type Bin struct {', '\tslots []string', '}', '',
  'func NewBin(n int) *Bin { return &Bin{slots: make([]string, n)} }', '',
  'func (b *Bin) Get(i int) (string, error) {',
  '\tif i < 0 || i >= len(b.slots) {', '\t\treturn "", ErrOutOfRange', '\t}',
  '\treturn b.slots[i], nil', '}', '',
  '// Put stores v at i; a negative i is out of range.',
  'func (b *Bin) Put(i int, v string) error {',
  '\tif i < 0 || i >= len(b.slots) {', '\t\treturn ErrOutOfRange', '\t}',
  '\tb.slots[i] = v', '\treturn nil', '}', '',
].join('\n');
const SHELF_TEST = [
  'package store', '', 'import "testing"', '',
  'func TestShelfGet(t *testing.T) {',
  '\ts := NewShelf("a", "b", "c")',
  '\tif got, _ := s.Get(-1); got != "c" {', '\t\tt.Fatalf("Get(-1) = %q", got)', '\t}',
  '\tif _, err := s.Get(3); err != ErrOutOfRange {', '\t\tt.Fatalf("Get(3) err = %v", err)', '\t}',
  '}', '',
].join('\n');
const STORE = [{ path: 'store/shelf.go', text: SHELF }, { path: 'store/bin.go', text: BIN }, { path: 'store/shelf_test.go', text: SHELF_TEST }];
const SHELF_PUT = item('CHK-001', 'Add Shelf.Put', {
  happy: ['s := NewShelf("a", "b", "c"); s.Put(1, "x"); s.Get(1) -> "x"'],
  edge: ['s := NewShelf("a", "b", "c"); s.Put(0, "y"); s.Get(0) -> "y"'],
  adversarial: ['s := NewShelf("a", "b", "c"); s.Put(2, "z"); s.Get(2) -> "z"'],
});

// A made-up Go interpreter: the string read wraps a negative index; the array write rejects it.
const EVAL = [
  'package eval', '',
  'func evalStringIndexExpression(str, index Object) Object {',
  '\ts := str.(*String).Value',
  '\tidx := index.(*Number).Int()',
  '\tmax := len(s) - 1',
  '\tif idx < 0 {', '\t\tidx = len(s) + idx', '\t}',
  '\tif idx < 0 || idx > max {', '\t\treturn newError("index out of range: %d", idx)', '\t}',
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
  '\t{`"abc"[0]`, "a"},',
  '\t{`"abc"[-1]`, "c"},',
  '\t{"\\"abc\\"[5]", "index out of range: 5"},',
  '}', '',
].join('\n');
const INTERP = [{ path: 'eval/eval.go', text: EVAL }, { path: 'eval/eval_test.go', text: EVAL_TEST }];
const STRING_ASSIGN = item('CHK-002', 'String single-index assignment', {
  happy: ['s = "abc"; s[1] = "x"; s -> "axc"'],
  edge: ['s = "abc"; s[0] = "Z"; s -> "Zbc"'],
});

const edgesOf = (refusal: { edges: string[] } | undefined): string[] => [...(refusal?.edges ?? [])].sort();

await check('S1 plan.counterpartCoverage: absent = on (the default since lab run102) with no evidence, off = recorded, malformed = the default where consumed', async () => {
  const resolve = await api('ab-variants', 'resolveAbVariants');
  const evidence = await api('ab-variants', 'abVariantEvidence');
  const on = await api('ab-variants', 'counterpartCoverageOn');
  assert.equal(resolve({}).counterpartCoverage, 'on');
  assert.equal(evidence(resolve({})), undefined);
  assert.deepEqual(evidence(resolve({ plan: { counterpartCoverage: 'off' } }))?.flags, { 'plan.counterpartCoverage': 'off' });
  assert.throws(() => resolve({ plan: { counterpartCoverage: 'yes' } }), /invalid_ab_variant_config/);
  assert.equal(on({}), true);
  assert.equal(on({ plan: { counterpartCoverage: 'off' } }), false);
  assert.equal(on({ plan: { counterpartCoverage: 'loud' } }), true, 'malformed = the default');
});

await check('D1 method form: Shelf.Put added next to Shelf.Get (wraps negatives) and Bin.Put (rejects them) is refused for negative and out of range', async () => {
  const coverage = await api('counterpart-coverage', 'counterpartCoverage');
  const result = coverage({ files: STORE, items: [SHELF_PUT], requestText: 'Add `Shelf.Put(i, v)`, which replaces the label at position i.' });
  const check1 = result.checks.find((c: any) => c.operation === 'Shelf.Put');
  assert.ok(check1, `Shelf.Put is discovered as an added operation: ${JSON.stringify(result.checks.map((c: any) => c.operation))}`);
  assert.equal(check1.status, 'added');
  assert.equal(check1.counterpart?.name, 'Shelf.Get');
  assert.equal(check1.counterpart?.path, 'store/shelf.go');
  assert.deepEqual(check1.siblings.map((s: any) => s.name), ['Bin.Put'], 'another receiver\'s same operation is the secondary oracle');
  assert.ok(!check1.edges.some((e: any) => e.edge === 'null'), 'an `err != nil` check is no null special case of the operand');
  assert.equal(result.refusals.length, 1, JSON.stringify(result.refusals));
  assert.equal(result.refusals[0].itemId, 'CHK-001');
  assert.deepEqual(edgesOf(result.refusals[0]), ['negative', 'out_of_range']);
  const negative = check1.edges.find((e: any) => e.edge === 'negative');
  assert.match(negative.branch?.text ?? '', /i < 0/);
  assert.match(negative.test?.text ?? '', /s\.Get\(-1\)/);
});

await check('D2 index form: string single-index assignment next to a wrapping string read and a rejecting array write is refused for negative and out of range', async () => {
  const coverage = await api('counterpart-coverage', 'counterpartCoverage');
  const result = coverage({ files: INTERP, items: [STRING_ASSIGN], requestText: 'Support assigning to string indexes: `s[i] = "x"`.' });
  assert.equal(result.refusals.length, 1, `one refusal: ${JSON.stringify(result.checks.map((c: any) => [c.operation, c.status, c.pair, c.counterpart?.name]))}`);
  const refusal = result.refusals[0];
  assert.equal(refusal.itemId, 'CHK-002');
  assert.match(refusal.operation, /string/i);
  assert.match(refusal.counterpart, /evalStringIndexExpression/);
  assert.deepEqual(edgesOf(refusal), ['negative', 'out_of_range']);
});

await check('D3 probe evidence: no base test, the declared evaluator reads a value for a negative index on the base: clear on its own', async () => {
  const coverage = await api('counterpart-coverage', 'counterpartCoverage');
  const programs: string[] = [];
  const probe = (cases: Array<{ statements: string[]; expr: string }>) => cases.map(c => {
    programs.push([...c.statements, c.expr].join('; '));
    if (/\[-1\]$/.test(c.expr)) return { status: 'value', text: '"c"' };
    if (/\[\d+\]$/.test(c.expr)) return { status: 'error', text: 'index out of range: 4' };
    return { status: 'error', text: 'index assignment not supported: STRING' };
  });
  const result = coverage({ files: [INTERP[0]], items: [STRING_ASSIGN], requestText: null, probe });
  assert.ok(programs.some(p => /s = "abc"; s\[-1\]/.test(p)), `the counterpart read is probed with the row's own receiver: ${programs.join(' | ')}`);
  assert.equal(result.refusals.length, 1, JSON.stringify(result.advisories));
  assert.deepEqual(edgesOf(result.refusals[0]), ['negative', 'out_of_range'], 'negative: probe value alone; out of range: branch + probe');
  const negative = result.checks[0].edges.find((e: any) => e.edge === 'negative');
  assert.equal(negative.probe?.text, '"c"');
});

await check('N1 no same-receiver counterpart (only another receiver has Get/Put): no check, no refusal', async () => {
  const coverage = await api('counterpart-coverage', 'counterpartCoverage');
  const crate = { path: 'store/crate.go', text: 'package store\n\ntype Crate struct{ n int }\n\nfunc (c *Crate) Len() int { return c.n }\n' };
  const result = coverage({ files: [...STORE, crate], items: [item('CHK-003', 'Add Crate.Put', { happy: ['c := &Crate{}; c.Put(1, "x") -> nil'] })], requestText: null });
  assert.deepEqual(result.refusals, []);
  assert.deepEqual(result.checks, []);
});

await check('N2 the request states the new operation\'s negative and out-of-range behaviour: recorded as stated, no refusal', async () => {
  const coverage = await api('counterpart-coverage', 'counterpartCoverage');
  const result = coverage({ files: STORE, items: [SHELF_PUT],
    requestText: 'Add `Shelf.Put(i, v)`.\n- Shelf.Put with a negative index returns ErrOutOfRange.\n- Shelf.Put past the end returns ErrOutOfRange.' });
  assert.deepEqual(result.refusals, []);
  const edges = result.checks[0].edges.filter((e: any) => ['negative', 'out_of_range'].includes(e.edge));
  assert.ok(edges.length === 2 && edges.every((e: any) => e.stated), JSON.stringify(edges));
});

await check('N3 rows on the new operation for each class: covered, no refusal', async () => {
  const coverage = await api('counterpart-coverage', 'counterpartCoverage');
  const fixed = item('CHK-001', 'Add Shelf.Put', {
    happy: ['s := NewShelf("a", "b", "c"); s.Put(1, "x"); s.Get(1) -> "x"'],
    edge: ['s := NewShelf("a", "b", "c"); s.Put(-1, "z"); s.Get(2) -> "z"', 's := NewShelf("a", "b", "c"); s.Put(3, "z") -> ErrOutOfRange'],
  });
  const result = coverage({ files: STORE, items: [fixed], requestText: null });
  assert.deepEqual(result.refusals, []);
  const byEdge = Object.fromEntries(result.checks[0].edges.map((e: any) => [e.edge, e.coveredBy]));
  assert.equal(byEdge.negative, 'CHK-001:edge:0');
  assert.equal(byEdge.out_of_range, 'CHK-001:edge:1');
  const index = coverage({ files: INTERP, items: [item('CHK-002', 'String single-index assignment', {
    happy: ['s = "abc"; s[1] = "x"; s -> "axc"'], edge: ['s = "abc"; s[-1] = "Z"; s -> "abZ"', 's = "abc"; s[3] = "Z" -> error \'index out of range: 3\''] })], requestText: null });
  assert.deepEqual(index.refusals, [], JSON.stringify(index.refusals));
});

await check('N4 one signal only (a branch, no base test, no evaluator): advisory note, no refusal', async () => {
  const coverage = await api('counterpart-coverage', 'counterpartCoverage');
  const result = coverage({ files: STORE.filter(file => !file.path.endsWith('_test.go')), items: [SHELF_PUT], requestText: null });
  assert.deepEqual(result.refusals, []);
  assert.equal(result.advisories.length, 1, JSON.stringify(result.advisories));
  assert.deepEqual([...result.advisories[0].edges].sort(), ['negative', 'out_of_range']);
});

await check('N5 the receiver already has the operation in the base (a change, its own base behaviour is the oracle): advisory, no refusal', async () => {
  const coverage = await api('counterpart-coverage', 'counterpartCoverage');
  const withPut = { path: 'store/shelf_put.go', text: 'package store\n\nfunc (s *Shelf) Put(i int, v string) error {\n\ts.items[i] = v\n\treturn nil\n}\n' };
  const result = coverage({ files: [...STORE, withPut], items: [SHELF_PUT], requestText: null });
  assert.deepEqual(result.refusals, []);
  assert.equal(result.checks[0]?.status, 'changed');
});

await check('T1 refusal text: rule, item, operation, counterpart first, sibling second, classes, ONE Next with the whole intent plus placeholders', async () => {
  const coverage = await api('counterpart-coverage', 'counterpartCoverage');
  const render = await api('counterpart-coverage', 'counterpartRefusalText');
  const result = coverage({ files: STORE, items: [SHELF_PUT], requestText: null });
  const text = String(render('B-0001', result, [SHELF_PUT]));
  assert.match(text, /^Cannot enter DEV: /);
  assert.match(text, /\[counterpart_coverage_missing\]/);
  assert.match(text, /\(plan\.counterpartCoverage, default on\)/);
  assert.match(text, /CHK-001 adds Shelf\.Put/);
  assert.match(text, /Shelf\.Get \(store\/shelf\.go:\d+\)/);
  assert.match(text, /negative, out of range/);
  assert.match(text, /oracle order: the same receiver's counterpart first[^]*Bin\.Put[^]*second/);
  const next = text.split('\n').filter(line => line.startsWith('Next: '));
  assert.equal(next.length, 1, 'ONE Next');
  const payload = JSON.parse(next[0]!.replace(/^Next: proof-or-stop checklist_update '/, '').replace(/'$/, '')) as { itemId: string; verificationIntent?: unknown; intentRows: Array<{ ref: string; desc: string }> };
  assert.equal(payload.itemId, 'CHK-001');
  // Lab initplan: a row patch that appends the rows; the existing rows are untouched (no whole intent).
  assert.equal(payload.verificationIntent, undefined, 'existing rows are kept (row patch, no whole intent)');
  assert.ok(payload.intentRows.every(rowValue => rowValue.ref === 'CHK-001:edge:+'), 'every placeholder row is appended to edge');
  const placeholders = payload.intentRows.filter(rowValue => rowValue.desc.startsWith('<'));
  assert.equal(placeholders.length, 2, 'one placeholder row per uncovered class');
  assert.match(placeholders[0]!.desc, /Shelf\.Put on a negative operand -> the result Shelf\.Get gives for it/);
});

await check('I1 implementer block: probe the counterpart on the base, report `[counterpart]` lines (bytes printed)', async () => {
  const coverage = await api('counterpart-coverage', 'counterpartCoverage');
  const lines = await api('counterpart-coverage', 'counterpartImplementerLines');
  const result = coverage({ files: STORE, items: [SHELF_PUT], requestText: null });
  const block = (lines(result, 'CHK-001') as string[]).join('\n');
  assert.match(block, /\[counterpart\] <op> :: <case> -> <base result>/);
  assert.match(block, /Shelf\.Put: counterpart Shelf\.Get \(store\/shelf\.go:\d+\)/);
  assert.match(block, /unless a checklist row or the request says otherwise/);
  const generic = (lines(null, 'CHK-009') as string[]).join('\n');
  assert.match(generic, /\[counterpart\]/, 'the contract holds even when the framework discovered nothing for the item');
  console.log(`     implementer block: ${Buffer.byteLength(block)} B with one discovered operation, ${Buffer.byteLength(generic)} B generic`);
});

if (failures.length) {
  console.log(`counterpart-coverage-smoke: FAIL (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('counterpart-coverage-smoke: PASS');
