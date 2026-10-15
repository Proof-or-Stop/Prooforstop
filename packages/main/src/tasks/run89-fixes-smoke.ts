#!/usr/bin/env node
/**
 * Old-PoS runs 88 / 89 (bench-staging/oldpos/run88-89-analysis.md §5 fixes 1-3, 5, 6; lab
 * `codex/lab-run89`). Unit level (pure functions, real git repositories). Generic examples only
 * (a made-up `pipe` printer, `span` / `kind` helpers); no benchmark-task material. The lifecycle
 * shapes are harness NPB, NPD, NTS, NFR and NRX.
 *
 *   B. Pinned printed form vs the base printer: a row whose expected output is a rendering of its
 *      input (same words, other spacing / parentheses) and renders an operator the base already
 *      prints differently (base printer tests) is listed with the base sample and a concrete row
 *      patch to the base form, unless the request itself shows that form.
 *   D. `[pin-doubt]`: the implementer / repair return contract names it; a `[pin-doubt]` line is
 *      parsed as a conflict the framework routes to a row re-derivation.
 *   T. Bound matrix: a single-operand type switch is a dispatch table (no operand gate); the
 *      matrix prints the exact `[branch-test]` line per operand; an error value's nil check is
 *      not an operand branch; the report follow-up asks for the missing lines only.
 *   C. Regression chain: the third finding of one chain (two `[regression-of]` links) gets the
 *      mechanism-level repair block and must report which request sentence / row requires it.
 *   E. exact_error_pin: a row whose message instantiates a template the request says must match
 *      exactly is never listed; the story_create template names the payload-file form and that
 *      story_create itself reports every rule (no reading of the installed framework).
 *
 * Usage: node packages/main/dist/tasks/run89-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { writeStoryRequest } from '../core/story-request.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
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
const commit = (root: string, message: string): string => { git(root, ['add', '-A']); git(root, ['commit', '-qm', message]); return git(root, ['rev-parse', 'HEAD']); };
const NOW = '2026-10-15T05:00:00.000Z';
function repo(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  return root;
}
const row = (desc: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story',
  verification: { command: 'go test -v ./pipe -run ^TestPipePrint$', selector: '--- PASS: TestPipePrint' }, ...extra });

// ---------------------------------------------------------------------------
// B. Pinned printed form vs the base printer (run-89 shape: the owner pinned a compact infix form the
// base printer renders spaced; the request only shows the new construct's own form)

/** The base printer tests: infix operators render spaced inside parentheses. */
const PRINTER_TEST = ['package pipe', '', 'import "testing"', '', 'var printCases = []struct {', '\tinput    string', '\texpected string', '}{',
  '\t{"a + b", "(a + b)"},', '\t{"a * b - c", "((a * b) - c)"},', '\t{"-a + b", "((-a) + b)"},', '\t{"f(a, b)", "f(a, b)"},', '}', '',
  'func TestPrintCases(t *testing.T) {', '\tif len(printCases) == 0 {', '\t\tt.Fatal("no cases")', '\t}', '}', ''].join('\n');
const PIPE_REQUEST = [
  'Add a pipe operator `x |> f` that passes `x` to `f`.',
  '',
  '- Accept `value |> fn` as an expression.',
  '- AST stringification must parenthesize pipes, for example:',
  '  - `x |> f` -> `(x |> f)`',
  '  - `x |> f |> g` -> `((x |> f) |> g)`',
  '',
].join('\n');
const QUOTE = 'Accept `value |> fn` as an expression.';
const INVENTED = row('1 + 2 |> f -> ((1+2) |> f)', { derivation: { requestQuote: QUOTE, computation: 'each operand is a full expression, so the printer keeps the infix compact: ((1+2) |> f)' } });

function pipeItems(extra: Array<Record<string, unknown>> = [INVENTED]) {
  return [{ id: 'CHK-001', title: 'Pipe operator', status: 'pending', verificationIntent: {
    happy: [row('x |> f -> (x |> f)'), row('x |> f |> g -> ((x |> f) |> g)')], edge: [], adversarial: extra } }];
}

await check('B1 a printer pin rendering an operator the base prints differently is a conflict with the base sample and the base form; the request\'s own forms and a base-form pin are not', async () => {
  const conflictsOf = await load('../core/pin-base-form.js', 'pinBaseFormConflicts');
  const printerPin = await load('../core/pin-base-form.js', 'printerPin');
  assert.deepEqual(printerPin('1 + 2 |> f -> ((1+2) |> f)'), { input: '1 + 2 |> f', output: '((1+2) |> f)' }, 'a rendering pin');
  assert.equal(printerPin('[1, 2].len() -> 2'), null, 'an evaluation pin is not a rendering');
  const files = [{ path: 'pipe/print_test.go', text: PRINTER_TEST }];
  const conflicts = conflictsOf({ items: pipeItems(), requestText: PIPE_REQUEST, files }) as Array<{ ref: string; pinned: string; baseForm: string; operators: Array<{ op: string; sample: { path: string; line: number } }> }>;
  assert.equal(conflicts.length, 1, JSON.stringify(conflicts));
  assert.equal(conflicts[0]!.ref, 'CHK-001:adversarial:0');
  assert.equal(conflicts[0]!.pinned, '((1+2) |> f)');
  assert.equal(conflicts[0]!.baseForm, '((1 + 2) |> f)', 'the base form re-renders only the conflicting operator');
  assert.deepEqual(conflicts[0]!.operators.map(entry => entry.op), ['+']);
  assert.equal(conflicts[0]!.operators[0]!.sample.path, 'pipe/print_test.go');
  assert.ok(conflicts[0]!.operators[0]!.sample.line > 0, 'with the base test line');
  // A base-form pin, the request's own examples, and a request that itself shows the compact form are not conflicts.
  const fine = row('1 + 2 |> f -> ((1 + 2) |> f)', { derivation: INVENTED.derivation });
  assert.deepEqual(conflictsOf({ items: pipeItems([fine]), requestText: PIPE_REQUEST, files }), [], 'a base-form pin');
  const stated = `${PIPE_REQUEST}  - \`1 + 2 |> f\` -> \`((1+2) |> f)\`\n`;
  assert.deepEqual(conflictsOf({ items: pipeItems(), requestText: stated, files }), [], 'the request states the pinned value');
  assert.deepEqual(conflictsOf({ items: pipeItems(), requestText: PIPE_REQUEST, files: [] }), [], 'no base printer evidence: nothing listed');
});

await check('B2 the row patch is concrete (base form, kept quote, base sample in the computation) and the PLAN pre-check lists it', async () => {
  const patchOf = await load('../core/pin-base-form.js', 'pinBaseFormRowPatch');
  const conflictsOf = await load('../core/pin-base-form.js', 'pinBaseFormConflicts');
  const [conflict] = conflictsOf({ items: pipeItems(), requestText: PIPE_REQUEST, files: [{ path: 'pipe/print_test.go', text: PRINTER_TEST }] }) as unknown[];
  const patch = patchOf(conflict, INVENTED) as { ref: string; desc: string; derivation: { requestQuote: string; computation: string } };
  assert.equal(patch.ref, 'CHK-001:adversarial:0');
  assert.equal(patch.desc, '1 + 2 |> f -> ((1 + 2) |> f)');
  assert.equal(patch.derivation.requestQuote, QUOTE, 'the row keeps its request quote');
  assert.match(patch.derivation.computation, /pipe\/print_test\.go:\d+/, 'the computation cites the base sample');
  assert.match(patch.derivation.computation, /\(\(1 \+ 2\) \|> f\)$/, 'and ends at the base form');
  assert.doesNotMatch(JSON.stringify(patch), /<[a-z][^>]*>/, 'no placeholder');

  const root = repo('run89-pin-');
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }, null, 2));
    write(root, 'go.mod', 'module example.com/pipe\n\ngo 1.21\n');
    write(root, 'pipe/pipe.go', 'package pipe\n');
    write(root, 'pipe/print_test.go', PRINTER_TEST);
    commit(root, 'base');
    resetConfigCache();
    const store = new StoryStore(root);
    const storyId = 'B-8901';
    store.writeStory(storyId, { storyId, name: 'pipe', title: 'Pipe', description: 'Pipe.', type: 'feature', phase: 'PLAN', priority: 'medium',
      createdAt: NOW, startedAt: NOW, endedAt: null, events: [] } as unknown as StoryInfo);
    store.writeChecklist(storyId, { items: pipeItems().map(item => ({ ...item, context: 'parser', userSees: 'x |> f prints (x |> f)', files: { modify: ['pipe/pipe.go'], create: [], test: ['pipe/pipe_test.go'] } })) } as unknown as ChecklistData);
    writeStoryRequest(store, { storyId, phase: 'INIT', request: PIPE_REQUEST, source: 'smoke' });
    const { planLintPreview } = await import('../core/plan-lint-preview.js');
    const text = planLintPreview({ store, root, storyId }) ?? '';
    assert.match(text, /CHK-001:adversarial:0[^\n]*\[pin_base_form\]/, `the pre-check lists the row: ${text.slice(0, 600)}`);
    assert.match(text, /\(\(1 \+ 2\) \|> f\)/, 'with the base form in its row patch');
  } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// D. [pin-doubt] (run 89: the implementer saw the pin was odd, the request silent, and built a mechanism for it)

await check('D1 a [pin-doubt] line is parsed as a conflict naming the row and the base value; the implementer and repair contracts name the route', async () => {
  const { parseIntentConflicts, INTENT_CONFLICT_RETURN_CONTRACT } = await import('../core/request-authority.js') as unknown as {
    parseIntentConflicts: (text: string, bound?: string | null) => { section: string; conflicts: Array<Record<string, unknown>> }; INTENT_CONFLICT_RETURN_CONTRACT: string };
  const report = parseIntentConflicts('Implemented the pipe printer.\n[pin-doubt] CHK-001:adversarial:0 | base prints: ((1 + 2) |> f) | request: silent\n[intent-conflict] none', 'CHK-001');
  assert.equal(report.section, 'declared');
  assert.equal(report.conflicts.length, 1, JSON.stringify(report));
  const conflict = report.conflicts[0]!;
  assert.equal(conflict.pinDoubt, true, 'flagged as a pin doubt');
  assert.equal(conflict.intentRef, 'CHK-001:adversarial:0');
  assert.equal(conflict.itemId, 'CHK-001');
  assert.match(String(conflict.requestImplies), /\(\(1 \+ 2\) \|> f\)/, 'the base value stands where the request is silent');
  assert.match(INTENT_CONFLICT_RETURN_CONTRACT, /\[pin-doubt\]/, 'the return contract names the pin-doubt line');
  assert.match(INTENT_CONFLICT_RETURN_CONTRACT, /do not build/i, 'and says not to build a mechanism for such a pin');
});

// ---------------------------------------------------------------------------
// T. Bound matrix (run 89 REM3: a type switch's eleven case arms were one operand's "branches"; the check wanted a
// standalone operand word the prompt never showed; a commit-bearing repair counted as "no repair commit")

const KIND = ['package kind', '', '// Label names the node kind of v.', 'func Label(v interface{}) string {', '\tswitch v := v.(type) {', '\tcase *Num:', '\t\treturn "num"',
  '\tcase *Str:', '\t\treturn "str:" + v.S', '\tcase *Call:', '\t\treturn "call"', '\tdefault:', '\t\treturn "?"', '\t}', '}', '',
  'type Num struct{ N int }', 'type Str struct{ S string }', 'type Call struct{}', '',
  '// Store writes v at i.', 'func Store(xs []int, i int, v int) error {', '\terrObj := check(i)', '\tif errObj != nil {', '\t\treturn errObj', '\t}',
  '\tif i < 0 {', '\t\ti += len(xs)', '\t}', '\tif i >= len(xs) {', '\t\treturn nil', '\t}', '\txs[i] = v', '\treturn nil', '}', '',
  'func check(i int) error { return nil }', ''].join('\n');
const SPAN = ['package span', '', '// Bounds normalises a range over n items.', 'func Bounds(n, start, end int) (int, int) {', '\tif start < 0 {', '\t\tstart = 0', '\t}',
  '\tif end > n {', '\t\tend = n', '\t}', '\treturn start, end', '}', ''].join('\n');

await check('T1 a single-operand type switch is a dispatch table: no operand gate and no [branch-test] requirement; an error value\'s nil check is not an operand', async () => {
  const matrixFor = await load('../core/bound-matrix.js', 'boundMatrixFor');
  const render = await load('../core/bound-matrix.js', 'renderBoundMatrix');
  const problem = await load('../core/bound-matrix.js', 'branchTestProblem');
  const root = repo('run89-kind-');
  try {
    write(root, 'kind/kind.go', KIND);
    commit(root, 'kind');
    const label = matrixFor({ gitCwd: root, finding: { desc: 'kind/kind.go:9 Label drops the string of a nested Str. Repro: `Label(&Str{S: "a b"})`', files: ['kind/kind.go'] } }) as { kind?: string; operands: string[] } | null;
    if (label) {
      assert.equal(label.kind, 'dispatch', `a type switch is a dispatch table: ${JSON.stringify(label)}`);
      const text = (render(label) as string[]).join('\n');
      assert.doesNotMatch(text, /not accepted/, 'no acceptance rule for a dispatch table');
      assert.equal(problem('Fixed Str.', label), null, 'no [branch-test] line is required');
    }
    const store = matrixFor({ gitCwd: root, finding: { desc: 'kind/kind.go:27 Store wraps a negative index once. Repro: `Store(xs, -9, 1)`', files: ['kind/kind.go'] } }) as { operands: string[] } | null;
    assert.ok(store, 'Store branches on i in two forms');
    assert.deepEqual(store!.operands, ['i'], `the error value is not an operand: ${JSON.stringify(store)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await check('T2 the matrix prints the exact [branch-test] line per operand; a line in that form (any case) satisfies it', async () => {
  const matrixFor = await load('../core/bound-matrix.js', 'boundMatrixFor');
  const render = await load('../core/bound-matrix.js', 'renderBoundMatrix');
  const problem = await load('../core/bound-matrix.js', 'branchTestProblem');
  const root = repo('run89-span-');
  try {
    write(root, 'span/span.go', SPAN);
    commit(root, 'span');
    const matrix = matrixFor({ gitCwd: root, finding: { desc: 'span/span.go:5 Bounds clamps start without a test. Repro: `Bounds(3, -1, 2)`', files: ['span/span.go'] } }) as { operands: string[] };
    const text = (render(matrix) as string[]).join('\n');
    assert.match(text, /^\s*\[branch-test\] Bounds start=<case>: <test name> -> <result>$/m, `the literal start line: ${text}`);
    assert.match(text, /^\s*\[branch-test\] Bounds end=<case>: <test name> -> <result>$/m, 'the literal end line');
    assert.equal(problem('[branch-test] Bounds START=-1: TestBoundsStart -> 0\n[branch-test] Bounds end=9: TestBoundsEnd -> 3', matrix), null);
    const missing = problem('[branch-test] Bounds start=-1: TestBoundsStart -> 0', matrix) as string;
    assert.match(missing, /\[branch-test\] Bounds end=<case>: <test name> -> <result>/, `the problem quotes the exact missing line: ${missing}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await check('T3 the report follow-up asks only for the missing lines (exact template), and nothing when the report is complete', async () => {
  const followUp = await load('../core/repair-report-lines.js', 'repairReportFollowUp');
  const matrix = { fn: 'Bounds', file: 'span/span.go', line: 4, operands: ['end', 'start'], branches: [] };
  const prompt = followUp({ report: 'Fixed start.\n[branch-test] Bounds start=-1: TestBoundsStart -> 0', matrices: [{ findingId: 'B-1:F-001', matrix }], mechanisms: [] }) as string | null;
  assert.ok(prompt, 'a follow-up');
  assert.match(prompt!, /\[branch-test\] Bounds end=<case>: <test name> -> <result>/, 'the exact missing line');
  assert.doesNotMatch(prompt!, /Bounds start=<case>/, 'not the line already given');
  assert.match(prompt!, /do not redo/i, 'not a new repair');
  assert.equal(followUp({ report: '[branch-test] Bounds start=-1: T -> 0\n[branch-test] Bounds end=9: T2 -> 3', matrices: [{ findingId: 'B-1:F-001', matrix }], mechanisms: [] }), null);
});

// ---------------------------------------------------------------------------
// C. Regression chain (run 89: F-004 -> F-007 -> F-010 -> F-011, each repair patched one more variant of one mechanism)

function chainFindings(storyId: string) {
  const base = { severity: 'medium', category: 'edge', files: ['pipe/pipe.go'], evidenceState: 'verified', agent: 'proof-or-stop-review-concept', createdAt: NOW };
  return [
    { ...base, id: `${storyId}:F-001`, desc: 'pipe/pipe.go:3 the printer drops the space of a string operand. Repro: `"a b" |> f`', status: 'resolved', resolvedReason: 'repaired' },
    { ...base, id: `${storyId}:F-002`, desc: '[regression-of F-001] a nested string operand is still compacted. Repro: `g("a b") |> f`', status: 'resolved', resolvedReason: 'repaired' },
    { ...base, id: `${storyId}:F-003`, desc: '[regression-of F-002] a block operand is compacted. Repro: `{ "a b" } |> f`', status: 'open' },
  ];
}

await check('C1 the second [regression-of] link of a chain adds the mechanism-level block ([mechanism] line, remove when nothing requires it, [pin-doubt] for a row-only pin); the first link does not', async () => {
  const brief = await load('../core/regression-family-brief.js', 'regressionFamilyBrief');
  const storyId = 'B-8902';
  const findings = chainFindings(storyId);
  const third = (brief({ findings, storyId, finding: findings[2], gitCwd: tmpdir() }) as string[]).join('\n');
  assert.match(third, /Mechanism-level repair/, `chain depth 2: ${third.slice(0, 400)}`);
  assert.match(third, /F-001 -> F-002 -> F-003/, 'the chain is named');
  assert.match(third, /\[mechanism\]/, 'the report line');
  assert.match(third, /remove the mechanism/i, 'remove it when nothing requires it');
  assert.match(third, /\[pin-doubt\]/, 'a row-only pin is a pin doubt');
  const second = (brief({ findings: findings.map(row => row.id.endsWith('F-002') ? { ...row, status: 'open' } : row), storyId, finding: { ...findings[1], status: 'open' }, gitCwd: tmpdir() }) as string[]).join('\n');
  assert.doesNotMatch(second, /Mechanism-level repair/, 'one link: the family brief only');
});

await check('C2 the [mechanism] line must exist and cite a request sentence verbatim or a row, or say none', async () => {
  const problemOf = await load('../core/repair-report-lines.js', 'mechanismLineProblem');
  const requirement = { findingId: 'B-1:F-003', chain: ['F-001', 'F-002', 'F-003'], requestText: PIPE_REQUEST };
  assert.match(String(problemOf(null, requirement)), /\[mechanism\]/, 'no report');
  assert.match(String(problemOf('Fixed blocks.', requirement)), /\[mechanism\]/, 'no line');
  assert.match(String(problemOf('[mechanism] compact printer: required by request "operands print without spaces"', requirement)), /not .*request/i, 'an invented quote');
  assert.equal(problemOf(`[mechanism] pipe printer: required by request "${QUOTE}"`, requirement), null, 'a verbatim quote');
  assert.equal(problemOf('[mechanism] compact printer: required by row CHK-001:adversarial:0', requirement), null, 'a row');
  assert.equal(problemOf('[mechanism] compact printer: none -> removed, base printing restored', requirement), null, 'none');
});

// ---------------------------------------------------------------------------
// E. exact_error_pin exemption and the INIT payload guidance

await check('E1 a row whose message instantiates a template the request says must match exactly is not listed; a row pinning an unstated whole text still is', async () => {
  const pins = await load('../core/exact-error-pin-lint.js', 'exactWholeErrorPins');
  const request = ['Add range writes.', '', '- Write errors must match exactly:', '  - Length mismatch:', '    - `size mismatch: want=<X> got=<Y>`', '  - Wrong value type:', '    - `write expects LIST value, got <TYPE>`', ''].join('\n');
  const items = [{ id: 'CHK-001', status: 'pending', verificationIntent: { happy: [], adversarial: [], edge: [
    row('xs[0:2] = [1] -> exact whole error equals "size mismatch: want=2 got=1"'),
    row('xs[0:2] = 5 -> exact whole error equals "write expects LIST value, got NUMBER"'),
    row('xs[9] -> exact whole error equals "index 9 out of bounds at line 1"'),
  ] } }];
  const listed = (pins(items, request) as Array<{ ref: string }>).map(pin => pin.ref);
  assert.deepEqual(listed, ['CHK-001:edge:2'], `only the unstated whole text is listed: ${JSON.stringify(listed)}`);
  // Same-indent list after an "exactly:" sentence (common Markdown) is the same block.
  const flat = ['Write errors must match exactly:', '- `size mismatch: want=<X> got=<Y>`', ''].join('\n');
  assert.deepEqual((pins([{ ...items[0], verificationIntent: { happy: [], adversarial: [], edge: [items[0]!.verificationIntent.edge[0]] } }], flat) as unknown[]), [], 'a flat list after the sentence');
});

await check('E2 the story_create template names the payload-file form and says story_create reports every rule itself (no reading of the installed framework)', async () => {
  const { storyCreateTemplateStep } = await import('../handlers/next-driver.js');
  const root = repo('run89-tpl-');
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }, null, 2));
    commit(root, 'base');
    resetConfigCache();
    const why = storyCreateTemplateStep(root).why;
    assert.match(why, /story_create @<file\.json>/, `the payload-file form: ${why.slice(0, 300)}`);
    assert.match(why, /installed (?:framework|Proof-or-Stop) (?:source|code)/i, 'the installed framework is not the project');
  } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
});

// The repair prompt of a chain finding carries the block (story-dispatch wiring).
await check('C3 the finding-repair prompt of the third chain finding carries the mechanism-level block', async () => {
  const root = repo('run89-chain-');
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }, null, 2));
    write(root, 'pipe/pipe.go', 'package pipe\n\nfunc Print() string { return "" }\n');
    commit(root, 'base');
    resetConfigCache();
    const store = new StoryStore(root);
    const storyId = 'B-8903';
    store.writeStory(storyId, { storyId, name: 'pipe', title: 'Pipe', description: 'Pipe.', type: 'feature', phase: 'DEV', priority: 'medium',
      createdAt: NOW, startedAt: NOW, endedAt: null, events: [] } as unknown as StoryInfo);
    store.writeChecklist(storyId, { items: pipeItems().map(item => ({ ...item, status: 'done', context: 'parser', userSees: 'x |> f prints (x |> f)', files: { modify: ['pipe/pipe.go'], create: [], test: ['pipe/pipe_test.go'] } })) } as unknown as ChecklistData);
    writeStoryRequest(store, { storyId, phase: 'INIT', request: PIPE_REQUEST, source: 'smoke' });
    store.writeFindings(storyId, { findings: chainFindings(storyId) } as never);
    const handlers = createStoryDispatchHandlers({ store, root, scanRoot: root } as never);
    const prompt = (handlers.dispatch({ storyId, agentType: 'proof-or-stop-finding-repair', findingId: 'F-003' }) as { prompt: string }).prompt;
    assert.match(prompt, /Mechanism-level repair/, 'the block');
    assert.match(prompt, /\[mechanism\]/, 'the report line');
  } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
});

if (failures.length) {
  console.error(`run89-fixes-smoke: FAIL (${failures.length}: ${failures.join('; ')})`);
  process.exit(1);
}
console.log('run89-fixes-smoke: PASS');
