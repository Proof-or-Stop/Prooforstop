#!/usr/bin/env node
/**
 * Old-PoS run 31 request-anchored probes (core/request-probes.ts), unit level.
 *
 *   A. Probe cases from run 31's own intent descs (B-6f26): multi-case rows,
 *      `over` bindings, statement prefixes, writes, error pins, prose skipped.
 *   B. Anchoring on run 31's request: the DEV-time null rows (F-006) and the
 *      two-part write `a[null:3]=[9]` (F-008, via "same semantics as read")
 *      are request-defined errors; their value pins contradict the request.
 *   C. Coverage rows 3c/3d: lvalue receiver kinds and per-form explicit null
 *      writes are demanded by run 31's request; a member-receiver row
 *      satisfies its row.
 *   D. A project probe runner (node evaluator committed at the base) runs the
 *      cases on the base and on HEAD, flags a request contradiction the pin
 *      agrees with, refuses done once per flagged set, decides reopen then
 *      escalate; a failing selfTest disables the runner.
 *   E. [probe-row] reports (no runner): contradiction -> reopen, repeated ->
 *      escalate, conflict-listed rows disposed.
 *   F. Prompt texts: the anchored table (S#, PIN CONTRADICTS REQUEST), the
 *      compact framework contract, the scope-plan pairing.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  anchorCase, itemProbeCases, matchesPin, normalizeProbeValue, parseExpectation, parseProbeRows, pinRequestContradiction, probeAnchorContext, probeCasesOf,
  probeDoneCheck, readProbeState, renderAnchoredProbeTable, renderFrameworkProbeContract, renderProbeEvidence, renderRequestAnchoredPinAudit,
  reportProbeDecision, runnerProbeDecision, storyProbeRunner, PROBE_REQUEST_MISMATCH,
} from '../core/request-probes.js';
import { lvalueReceiverKinds, planCoverageGaps } from '../core/plan-coverage-matrix.js';
import type { ChecklistItem, VerificationIntent } from '../core/types.js';

const RUN31_REQUEST = [
  'Extend indexing ranges so arrays and strings support a third slice component:',
  '',
  '- `value[start:end:step]`',
  '',
  '## Expected Behavior',
  '',
  '1. Parser support',
  '- Accept omitted components for stepped slices: `value[:end:step]`, `value[start::step]`, and `value[::step]`.',
  '',
  '2. Runtime support for arrays and strings',
  '- A step of `0` must raise an error that starts with: `slice step cannot be 0`.',
  '- A non-numeric `start` in array/string slices must keep the existing index-operator error format:',
  '  - `index operator not supported: <inspect> on ARRAY`',
  '  - `index operator not supported: <inspect> on STRING`',
  '- Non-numeric `end` or `step` values in ranges must keep the existing numeric-range error format:',
  '  - `index ranges can only be numerical: got "<inspect>" (type <TYPE>)`',
  '',
  '3. Array and string range assignment',
  '- Support assigning to array ranges selected with either two-part or three-part slice syntax:',
  '  - `array[start:end] = [...]`',
  '  - `array[start:end:step] = [...]`',
  '- Use the same index-selection semantics as read slicing.',
  '- Support assigning to string indexes/ranges:',
  '  - `string[i] = "x"`',
  '  - `string[start:end] = "..."` and `string[start:end:step] = "..."`',
].join('\n');

const row = (desc: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story', ...extra });

// ---- A. cases
{
  const multi = probeCasesOf('CHK-002:edge:0', 'CHK-002', 'stepped read forms over a=[0,1,2,3,4,5]: a[1:5:2]->[1, 3]; a[:4:2]->[0, 2]; a[1::2]->[1, 3, 5]');
  assert.equal(multi.length, 3, 'one case per `;` segment');
  assert.deepEqual(multi.map(entry => entry.key), ['CHK-002:edge:0#1', 'CHK-002:edge:0#2', 'CHK-002:edge:0#3']);
  assert.deepEqual(multi[0]!.statements, ['a=[0,1,2,3,4,5]'], 'the prefix `over a=[...]` binds each case');
  assert.equal(multi[0]!.expr, 'a[1:5:2]');
  assert.deepEqual(multi[1]!.pinned, { kind: 'value', text: '[0, 2]' });

  const over = probeCasesOf('CHK-002:happy:0', 'CHK-002', 'a[::2] over [0,1,2,3,4,5] -> [0, 2, 4]');
  assert.deepEqual(over[0]!.statements, ['a=[0,1,2,3,4,5]'], '`<case> over <literal>` binds the root variable');

  const write = probeCasesOf('CHK-005:edge:1', 'CHK-005', "string stepped write asymmetric s='hello'; s[::2]='ABC' -> 'AeBlC'");
  assert.equal(write.length, 1);
  assert.deepEqual(write[0]!.statements, ["s='hello'", "s[::2]='ABC'"], 'a statement segment then the write');
  assert.equal(write[0]!.expr, 's', 'a write compares its receiver');
  assert.equal(write[0]!.write, true);
  assert.deepEqual(write[0]!.pinned, { kind: 'either', text: 'AeBlC' });

  const member = probeCasesOf('CHK-005:edge:20', 'CHK-005', 'member receiver h={"s": "hello"}; h.s[0]="H" -> "Hello"');
  assert.equal(member[0]!.expr, 'h.s', 'the receiver of `h.s[0]=` is `h.s`');
  const nested = probeCasesOf('CHK-005:edge:21', 'CHK-005', 'nested receiver a=["hello"]; a[0][0]="H" -> "Hello"');
  assert.equal(nested[0]!.expr, 'a[0]');

  const error = probeCasesOf('CHK-002:edge:2', 'CHK-002', "a[::0] over [1,2] -> error starts with 'slice step cannot be 0'");
  assert.deepEqual(error[0]!.pinned, { kind: 'error', text: 'slice step cannot be 0' });
  const unbound = probeCasesOf('CHK-002:edge:2', 'CHK-002', "a[::0] -> error starts with 'slice step cannot be 0'");
  assert.equal(unbound[0]!.unbound, true, 'an unbound receiver is not runnable');
  // Run 31 CHK-002: the error rows named `a` and relied on a sibling row's `over a=[...]`.
  const borrowed = itemProbeCases({ id: 'CHK-002', verificationIntent: { happy: [row('a[::2] over [0,1,2,3,4,5] -> [0, 2, 4]')], edge: [row("a[::0] -> error starts with 'slice step cannot be 0'")], adversarial: [] } as unknown as VerificationIntent });
  assert.deepEqual(borrowed[1]!.statements, ['a=[0,1,2,3,4,5]'], 'an unbound case borrows the binding its item\'s other rows use');
  assert.equal(borrowed[1]!.unbound, false);
  assert.deepEqual(probeCasesOf('CHK-001:happy:0', 'CHK-001', 'myArray[99 : 101 : 2] -> (myArray[99:101:2])'), [], 'a stringify row is not an evaluation');
  assert.deepEqual(probeCasesOf('x', 'CHK-005', "string single-index out-of-range write s='hello'; s[9]='x' -> unchanged 'hello' or documented error"), [], 'prose result: no case');
  assert.deepEqual(probeCasesOf('x', 'CHK-001', 'TestUpper passes'), []);
  assert.equal(probeCasesOf('x', 'CHK-006', "rune single-index 'héllo'[1] -> 'é'")[0]!.expr, "'héllo'[1]", 'a literal receiver needs no binding');
  assert.deepEqual(parseExpectation("error prefix 'slice step cannot be 0'"), { kind: 'error', text: 'slice step cannot be 0' });
  assert.equal(parseExpectation('unchanged or documented error'), null);
  assert.equal(normalizeProbeValue("['é', 1]"), normalizeProbeValue('["é", 1]'), "'' and \"\" quotes compare alike in a group");
  assert.equal(matchesPin({ status: 'error', text: '&{index operator not supported: null on ARRAY\n\t[1:13]' }, { kind: 'either', text: 'index operator not supported: null on ARRAY' }), true, 'an error message pin matches the error output');
  assert.equal(matchesPin({ status: 'value', text: '[0, 2]' }, { kind: 'either', text: 'index operator not supported: null on ARRAY' }), false);
  assert.equal(matchesPin({ status: 'value', text: 'hlo' }, { kind: 'either', text: 'hlo' }), true, 'a printed string matches its quoted pin');
}

// ---- B. anchoring (run 31 request)
const item = (id: string, title: string, lanes: { happy?: string[]; edge?: string[]; adversarial?: string[] }): ChecklistItem => ({ id, title, status: 'pending',
  verificationIntent: { happy: (lanes.happy ?? []).map(desc => row(desc)), edge: (lanes.edge ?? []).map(desc => row(desc)), adversarial: (lanes.adversarial ?? []).map(desc => row(desc)) } as unknown as VerificationIntent } as ChecklistItem);
// Run 31 at DEV start (git 747d9d6): the owner pinned explicit null start/end as omitted.
const DEV_ITEMS = [
  item('CHK-002', 'Evaluate stepped slices over arrays', { happy: ['a[::2] over [0,1,2,3,4,5] -> [0, 2, 4]'],
    edge: ['explicit null start a[null:4:2] over [0,1,2,3,4,5] -> [0, 2]; explicit null end a[1:null:2] over [0,1,2,3,4,5] -> [1, 3, 5]', "a[::0] over [1,2] -> error starts with 'slice step cannot be 0'"] }),
  item('CHK-004', 'Support range assignment on arrays with two- and three-part slices', { edge: ['two-part null start write a[null:3]=[9] over [1,2,3] -> [9, 2, 3]', 'a[1:3]=[7,7] over [0,1,2,3] -> [0, 7, 7, 3]'] }),
];
{
  const ctx = probeAnchorContext(DEV_ITEMS, RUN31_REQUEST);
  const nullStart = probeCasesOf('CHK-002:edge:0', 'CHK-002', DEV_ITEMS[0]!.verificationIntent!.edge[0]!.desc);
  const startAnchor = anchorCase(ctx, nullStart[0]!);
  assert.equal(startAnchor.expectsError, true, 'F-006: the request gives an explicit null start an error');
  assert.match(startAnchor.sentences[0]!, /non-numeric `start`/, 'anchored to the non-numeric start sentence');
  assert.ok(startAnchor.stems.includes('index operator not supported:'), `the error format stem: ${JSON.stringify(startAnchor.stems)}`);
  assert.match(pinRequestContradiction(nullStart[0]!, startAnchor) ?? '', /pins the value \[0, 2\]/, 'the value pin contradicts the request');
  const endAnchor = anchorCase(ctx, nullStart[1]!);
  assert.equal(endAnchor.expectsError, true);
  assert.ok(endAnchor.stems.some(stem => stem.startsWith('index ranges can only be numerical')), `null end -> numeric-range format: ${JSON.stringify(endAnchor.stems)}`);
  const write = probeCasesOf('CHK-004:edge:0', 'CHK-004', DEV_ITEMS[1]!.verificationIntent!.edge[0]!.desc);
  const writeAnchor = anchorCase(ctx, write[0]!);
  assert.equal(writeAnchor.expectsError, true, 'F-008: the two-part write follows read semantics, so the null start read sentence defines it');
  assert.ok(pinRequestContradiction(write[0]!, writeAnchor));
  const plain = anchorCase(ctx, probeCasesOf('CHK-002:happy:0', 'CHK-002', 'a[::2] over [0,1,2,3,4,5] -> [0, 2, 4]')[0]!);
  assert.equal(plain.expectsError, false, 'an ordinary read expects no error');
  const assign = anchorCase(ctx, probeCasesOf('CHK-004:edge:1', 'CHK-004', 'a[1:3]=[7,7] over [0,1,2,3] -> [0, 7, 7, 3]')[0]!);
  assert.equal(assign.expectsError, false);
  const zero = probeCasesOf('CHK-002:edge:1', 'CHK-002', "a[::0] over [1,2] -> error starts with 'slice step cannot be 0'");
  const zeroAnchor = anchorCase(ctx, zero[0]!);
  assert.equal(zeroAnchor.expectsError, true);
  assert.equal(pinRequestContradiction(zero[0]!, zeroAnchor), null, 'an error pin in the request format agrees');
}

// ---- C. coverage rows 3c / 3d
{
  const gaps = planCoverageGaps(DEV_ITEMS, RUN31_REQUEST).map(gap => gap.key);
  assert.ok(gaps.some(key => /member\/property assignment receiver on string/.test(key)), `3c member receiver on string: ${gaps.join(' | ')}`);
  assert.ok(gaps.some(key => /index-of-index assignment receiver on array/.test(key)), '3c index-of-index receiver on array');
  assert.ok(gaps.some(key => /call-result assignment receiver/.test(key)), '3c call-result receiver');
  assert.ok(gaps.some(key => /write: explicit null start on string via two-part range/.test(key)), `3d null start x two-part write on string: ${gaps.join(' | ')}`);
  assert.ok(gaps.some(key => /write: explicit null end on array via three-part range/.test(key)), '3d null end x three-part write on array');
  assert.deepEqual(lvalueReceiverKinds('h.s[0]="H" -> "Hello"'), ['receiver-member']);
  assert.deepEqual(lvalueReceiverKinds('a[0][0]="H" -> "Hello"'), ['receiver-nested']);
  assert.deepEqual(lvalueReceiverKinds('h["s"][0]="H"'), ['receiver-member'], 'a string-keyed receiver is a member, not an index-of-index');
  assert.deepEqual(lvalueReceiverKinds('f()[0]=9 -> error'), ['receiver-call']);
  assert.deepEqual(lvalueReceiverKinds('a[1:3]=[7,7] -> [0, 7, 7, 3]'), []);
  const withMember = [...DEV_ITEMS, item('CHK-005', 'Support index and range assignment on strings', { edge: ['string member receiver h={"s": "hello"}; h.s[0]="H" -> "Hello"'] })];
  const after = planCoverageGaps(withMember, RUN31_REQUEST).map(gap => gap.key);
  assert.ok(!after.some(key => /member\/property assignment receiver on string/.test(key)), 'a member-receiver string row satisfies 3c');
}

// ---- D. framework probe runner (a node evaluator committed at the base)
const EVAL = [
  "const fs = require('fs'); const path = require('path');",
  "const mode = fs.readFileSync(path.join(__dirname, '..', 'lib', 'impl.txt'), 'utf8').includes('null-start: omit') ? 'omit' : 'error';",
  "const vars = {}; const lit = t => JSON.parse(t.replace(/'/g, '\"'));",
  'const fail = m => { console.log(m); process.exit(99); };',
  "const show = v => Array.isArray(v) ? '[' + v.map(x => typeof x === 'string' ? JSON.stringify(x) : String(x)).join(', ') + ']' : String(v);",
  'function val(e) {',
  '  const m = e.match(/^([A-Za-z_]\\w*)\\[(.*)\\]$/); if (!m) return lit(e);',
  "  if (!(m[1] in vars)) fail('identifier not found: ' + m[1]);",
  "  const v = vars[m[1]]; const p = m[2].split(':').map(x => x.trim());",
  "  const num = (x, name) => { if (x === '') return null; if (x === 'null') { if (name === 'start' && mode === 'omit') return null; if (name === 'start') fail('index operator not supported: null on ARRAY'); fail('index ranges can only be numerical: got \"null\" (type NULL)'); } return Number(x); };",
  '  if (p.length === 1) return v[Number(p[0])];',
  "  const s = num(p[0], 'start'), e2 = num(p[1], 'end'), st = p.length > 2 ? (num(p[2], 'step') ?? 1) : 1;",
  "  if (st === 0) fail('slice step cannot be 0');",
  '  const out = []; for (let i = s ?? 0; i < (e2 ?? v.length) && i < v.length; i += st) out.push(v[i]); return out;',
  '}',
  "for (const line of fs.readFileSync(process.argv[2], 'utf8').split('\\n').map(l => l.trim()).filter(Boolean)) {",
  '  const a = line.match(/^([A-Za-z_]\\w*)\\s*=(?!=)\\s*(.+)$/); if (a) { vars[a[1]] = lit(a[2]); continue; }',
  '  const e = line.match(/^echo\\((.*)\\)$/); if (e) { console.log(show(val(e[1]))); continue; }',
  "  fail('parse error: ' + line);",
  '}', '',
].join('\n');
{
  const root = mkdtempSync(join(tmpdir(), 'request-probes-run31-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Smoke'); git('config', 'user.email', 'smoke@local.invalid');
    mkdirSync(join(root, 'tools')); mkdirSync(join(root, 'lib'));
    writeFileSync(join(root, 'tools/mini.js'), EVAL);
    writeFileSync(join(root, 'lib/impl.txt'), 'base\n');
    const runner = { command: process.execPath, args: ['tools/mini.js', '{file}'], program: 'echo({input})', extension: '.mini', selfTest: { input: '[1, 2]', output: '[1, 2]' } };
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ probeRunner: runner, dev: { probeEnforcement: 'enforce' } }));
    git('add', '-A'); git('commit', '-qm', 'base');
    git('checkout', '-q', '-b', 'story/B-1');
    // The Story's head treats an explicit null start as omitted (run 31 F-006).
    writeFileSync(join(root, 'lib/impl.txt'), 'stepped slices\n// null-start: omit\n');
    git('commit', '-qam', 'implement');
    const store = { readStory: () => ({}) };
    const ctx = storyProbeRunner(store, root, 'B-1', root);
    assert.ok(ctx, 'the declared runner is prepared from the base commit');
    const items = DEV_ITEMS.map(entry => ({ ...entry, status: 'done' as const }));
    const done = probeDoneCheck(ctx!, root, 'B-1', items[0]!, items, RUN31_REQUEST);
    assert.ok(done.refusal, 'done is refused on a flagged row');
    assert.match(done.refusal!, new RegExp(`\\[${PROBE_REQUEST_MISMATCH}\\]`));
    assert.match(done.refusal!, /CHK-002:edge:0#1: [^\n]*HEAD \[0, 2\][^\n]*non-numeric `start`[^\n]*FLAG: the request sentence gives this input an error/, `the flagged F-006 row with its request sentence:\n${done.refusal}`);
    assert.doesNotMatch(done.refusal!, /CHK-002:happy:0/, 'a row that agrees with pin and request is not flagged');
    const table = readProbeState(root, 'B-1', 'CHK-002').table!;
    assert.ok(table.rows.find(entry => entry.key === 'CHK-002:edge:0#1')!.base!.status === 'error', 'the base column is the base evaluator');
    const again = probeDoneCheck(ctx!, root, 'B-1', items[0]!, items, RUN31_REQUEST);
    assert.equal(again.refusal, null, 'the same flagged set is refused once');
    assert.match(again.note ?? '', /still flagged/);
    const run = (runId: string, createdAt: string, text: string) => ({ runId, createdAt, text });
    const before = new Date(Date.now() - 60_000).toISOString();
    const reopen = runnerProbeDecision(ctx!, root, 'B-1', items[0]!, items, RUN31_REQUEST, [run('r1', before, 'done\n[intent-conflict] none')]);
    assert.equal(reopen?.action, 'reopen', 'a run dispatched before the flags reopens the item');
    const later = new Date(Date.now() + 60_000).toISOString();
    const escalate = runnerProbeDecision(ctx!, root, 'B-1', items[0]!, items, RUN31_REQUEST, [run('r1', before, ''), run('r2', later, 'done\n[intent-conflict] none')]);
    assert.equal(escalate?.action, 'escalate', 'the relaunch saw the rows and they are still flagged: owner');
    const disposed = runnerProbeDecision(ctx!, root, 'B-1', items[0]!, items, RUN31_REQUEST, [run('r2', later,
      'done\n[intent-conflict] CHK-002:edge:0 | request: "A non-numeric `start` ..." | request implies: error | intent pins: [0, 2]')]);
    assert.equal(disposed, null, 'a row listed under [intent-conflict] is left to the intent-conflict step');
    const evidence = renderProbeEvidence(root, 'B-1', ['CHK-002', 'CHK-004']);
    assert.match(evidence[0] ?? '', /Framework probe evidence[^\n]*flagged/);
    assert.ok(evidence.some(line => /CHK-002:edge:0#1/.test(line)), 'lanes see the flagged row');
    // A runner whose selfTest the base fails is never used (a wrong declaration flags nothing).
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ probeRunner: { ...runner, selfTest: { input: '[1, 2]', output: '[9]' } }, dev: { probeEnforcement: 'enforce' } }));
    git('checkout', '-q', 'main'); git('commit', '-qam', 'bad self test'); git('checkout', '-q', 'story/B-1'); git('merge', '-q', 'main', '-m', 'merge');
    git('reset', '-q', '--hard', 'HEAD');
    assert.equal(storyProbeRunner(store, root, 'B-1', root), null, 'a failing selfTest disables the runner');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- E. [probe-row] reports (no runner)
{
  const lines = parseProbeRows([
    '[probe-row] CHK-002:edge:0#1 | request: error index operator not supported | observed: [0, 2] | contradiction',
    '[probe-row] CHK-002:happy:0 | request: [0, 2, 4] | observed: [0, 2, 4] | ok',
    '[probe-row] <row> | request: ... | ok|contradiction',
  ].join('\n'));
  assert.deepEqual(lines.map(entry => [entry.row, entry.verdict]), [['CHK-002:edge:0#1', 'contradiction'], ['CHK-002:happy:0', 'ok']], 'the format line is no row');
  const contradiction = '[intent-conflict] none\n[probe-row] CHK-002:edge:0#1 | request: error | observed: [0, 2] | contradiction';
  const first = reportProbeDecision('CHK-002', ['CHK-002:edge:0#1'], [{ runId: 'r1', createdAt: '2026-10-09T01:00:00Z', text: contradiction }]);
  assert.equal(first?.action, 'reopen');
  const repeated = reportProbeDecision('CHK-002', ['CHK-002:edge:0#1'], [{ runId: 'r1', createdAt: '2026-10-09T01:00:00Z', text: contradiction }, { runId: 'r2', createdAt: '2026-10-09T02:00:00Z', text: contradiction }]);
  assert.equal(repeated?.action, 'escalate', 'the same contradiction after a relaunch goes to the owner');
  const conflicted = reportProbeDecision('CHK-002', ['CHK-002:edge:0#1'], [{ runId: 'r1', createdAt: '2026-10-09T01:00:00Z',
    text: `${contradiction}\n[intent-conflict] CHK-002:edge:0 | request: "x" | request implies: error | intent pins: [0, 2]` }]);
  assert.equal(conflicted, null, 'a contradiction listed under [intent-conflict] is the conflict step\'s');
  const missing = reportProbeDecision('CHK-002', ['CHK-002:edge:0#1'], [{ runId: 'r1', createdAt: '2026-10-09T01:00:00Z', text: 'done\n[intent-conflict] none' }]);
  assert.equal(missing?.action, 'reopen', 'no [probe-row] report for anchored rows reopens once');
  assert.equal(reportProbeDecision('CHK-002', ['CHK-002:edge:0#1'], [{ runId: 'r1', createdAt: '2026-10-09T01:00:00Z', text: 'x' }, { runId: 'r2', createdAt: '2026-10-09T02:00:00Z', text: 'y' }]), null, '... once');
}

// ---- F. prompt texts
{
  const table = renderAnchoredProbeTable(DEV_ITEMS, RUN31_REQUEST, 'CHK-002').join('\n');
  assert.match(table, /S\d: "A non-numeric `start`/, 'the defining sentence is printed once');
  assert.match(table, /CHK-002:edge:0#1: a=\[0,1,2,3,4,5\]; a\[null:4:2\] -> \[0, 2\] \| S\d \(request expects an error[^\n]*PIN CONTRADICTS REQUEST/, `the F-006 row:\n${table}`);
  assert.match(table, /\[probe-row\] <row> \| request: <expected per the sentence> \| observed: <HEAD output> \| ok\|contradiction/);
  assert.deepEqual(renderAnchoredProbeTable(DEV_ITEMS, null, 'CHK-002'), [], 'no request, no table');
  const contract = renderFrameworkProbeContract(DEV_ITEMS, RUN31_REQUEST, 'CHK-002', { base: 'a'.repeat(40) }).join('\n');
  assert.match(contract, /Write no probe program/);
  assert.match(contract, /member\/property `h\.s\[i\]`, index-of-index `a\[0\]\[i\]`, call result `f\(\)\[i\]`/, 'the receiver kinds are named');
  assert.match(contract, /two-part and three-part\) with explicit null/);
  assert.match(contract, /CONTRADICTS: pins the value \[0, 2\]/, 'the item\'s contradicting pins are listed before coding');
  assert.ok(contract.length < 2500, `the framework contract stays compact (${contract.length} chars)`);
  const audit = renderRequestAnchoredPinAudit(DEV_ITEMS, RUN31_REQUEST).join('\n');
  assert.match(audit, /Request-anchored pins[^\n]*the framework marked 3/, `the scope-plan pairing marks the three null pins:\n${audit}`);
  assert.match(audit, /CHK-004:edge:0: a=\[1,2,3\]; a\[null:3\]=\[9\] -> \[9, 2, 3\][^\n]*PIN CONTRADICTS REQUEST/);
}

console.log('request-probes-run31-smoke: PASS');
