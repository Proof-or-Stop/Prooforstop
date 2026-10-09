#!/usr/bin/env node
/**
 * Old-PoS run 32 framework-probe faults (bench-staging/oldpos/run32-analysis.md
 * §3, §4), unit level with a real git repo and a node evaluator.
 *
 *   A. Extraction keeps every statement of a row in order (run 32 3a: the
 *      write `h.a[0:2]=[9,8]` was silently dropped, so `h.a -> [9,8,2]` was
 *      probed as a plain read and falsely flagged); a bare-identifier subject a
 *      row's own statements bind is a case; a row with a code statement the
 *      extractor cannot place is unextractable (never run, never flagged) and is
 *      listed, with the rows no probe can run, for PLAN.
 *   B. Run 32's member / index-of-index / bare write rows produce no flag.
 *   C. Staleness (3b): the table is keyed on material + base + rows digest; rows
 *      amended to zero cases clear the table and its flagged set; a flag whose
 *      item intent changed since it was raised is not escalated.
 *   D. Parse errors (3c): with `parseErrorPattern` + `newSyntaxPattern`, a base
 *      parse error inside the new-syntax region is expected and one outside it
 *      (`f(){...}`) is an authoring error listed at PLAN, never a code flag; the
 *      pin oracle reports the same class. Positions are the real abs image's
 *      (2026-10-09, read-only container).
 *   E. Exact text (§4, F-001): a request-quoted exact string the Story's added
 *      tests assert only through a prefix / contains comparison (directly or via
 *      a helper such as `logErrorWithPosition`) is found; an exact comparison of
 *      the same string anywhere in the added tests clears it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as probes from '../core/request-probes.js';
import * as oracle from '../core/pin-oracle.js';
import type { ChecklistItem, VerificationIntent } from '../core/types.js';

type Fn = (...args: unknown[]) => unknown;
const api = (module: object, name: string): Fn => {
  const fn = (module as Record<string, unknown>)[name];
  assert.equal(typeof fn, 'function', `${name} is exported`);
  return fn as Fn;
};

const row = (desc: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story', ...extra });
const item = (id: string, edge: Array<string | Record<string, unknown>>, status: ChecklistItem['status'] = 'done'): ChecklistItem => ({ id, title: `item ${id}`, status,
  verificationIntent: { happy: [], edge: edge.map(entry => (typeof entry === 'string' ? row(entry) : row(String(entry.desc), entry))), adversarial: [] } as unknown as VerificationIntent } as ChecklistItem);

// ---- A. extraction
{
  const member = probes.probeCasesOf('CHK-004:edge:2', 'CHK-004', 'h={"a":[0,1,2]}; h.a[0:2]=[9,8]; h.a -> [9,8,2]');
  assert.equal(member.length, 1);
  assert.deepEqual(member[0]!.statements, ['h={"a":[0,1,2]}', 'h.a[0:2]=[9,8]'], `run 32 3a: the write statement is kept in order: ${JSON.stringify(member[0])}`);
  assert.equal(member[0]!.expr, 'h.a');
  const nested = probes.probeCasesOf('CHK-004:edge:3', 'CHK-004', 'x=[[0,1,2]]; x[0][0:2]=[9,8]; x[0] -> [9,8,2]');
  assert.deepEqual(nested[0]!.statements, ['x=[[0,1,2]]', 'x[0][0:2]=[9,8]']);
  const bare = probes.probeCasesOf('CHK-004:edge:0', 'CHK-004', 'a=[0,1,2,3,4]; a[1:4]=[9,8,7]; a -> [0,9,8,7,4]');
  assert.equal(bare.length, 1, 'a bare-identifier subject the row binds is a case');
  assert.deepEqual(bare[0]!.statements, ['a=[0,1,2,3,4]', 'a[1:4]=[9,8,7]']);
  assert.equal(bare[0]!.expr, 'a');
  const fn = probes.probeCasesOf('CHK-004:edge:4', 'CHK-004', 'h={"a":[0,1,2]}; f(){ h.a[0:2]=[9,8]; return h.a }; a=f(); a -> [9,8,2]');
  assert.deepEqual(fn[0]!.statements, ['h={"a":[0,1,2]}', 'f(){ h.a[0:2]=[9,8]; return h.a }', 'a=f()'], 'the whole program runs (run 32 3c)');
  const prose = probes.probeCasesOf('CHK-002:edge:9', 'CHK-002', 'stepped read; a=[0,1,2]; a[0] -> 0');
  assert.equal((prose[0] as unknown as { dropped: string[] }).dropped.length, 0, 'a prose-only segment is no dropped statement');
  const dropped = probes.probeCasesOf('CHK-004:edge:8', 'CHK-004', 'x=[1]; x.push(2) twice; x -> [1, 2]');
  assert.equal(dropped.length, 1);
  assert.deepEqual((dropped[0] as unknown as { dropped: string[] }).dropped, ['x.push(2) twice'], 'a code segment the extractor cannot place is recorded');
  const listed = api(probes, 'unextractableRows')([item('CHK-004', ['x=[1]; x.push(2) twice; x -> [1, 2]', 'a[::0] -> raises index operator not supported: 0 on ARRAY', 'h={"a":[0,1,2]}; h.a[0:2]=[9,8]; h.a -> [9,8,2]', 'TestUpper passes'])]) as Array<{ ref: string; reason: string }>;
  assert.deepEqual(listed.map(entry => entry.ref), ['CHK-004:edge:0', 'CHK-004:edge:1'], `rows no probe runs are listed (prose rows without an example are not): ${JSON.stringify(listed)}`);
  assert.match(listed[0]!.reason, /x\.push\(2\) twice/);
  assert.match(listed[1]!.reason, /expected value/);
}

// ---- runner fixture: a node evaluator with statements, range writes and abs-shaped parse errors
const EVAL = [
  "const fs = require('fs'); const path = require('path');",
  "const stepped = fs.readFileSync(path.join(__dirname, '..', 'lib', 'impl.txt'), 'utf8').includes('stepped');",
  "const lines = fs.readFileSync(process.argv[2], 'utf8').split('\\n').filter(l => l.trim());",
  "const parseError = (ln, col, msg) => { console.log(' parser errors:\\n \\t' + msg + '\\n\\t[' + ln + ':' + col + ']\\t' + lines[ln - 1]); process.exit(99); };",
  'lines.forEach((line, i) => {',
  "  const s = line.match(/\\[[^\\[\\]]*:[^\\[\\]]*:[^\\[\\]]*\\]/); if (s && !stepped) parseError(i + 1, s.index + s[0].lastIndexOf(':') + 1, 'expected next token to be NUMBER, got : instead');",
  "  const f = line.match(/\\bf\\(\\)\\s*\\{/); if (f) parseError(i + 1, f.index + f[0].length, 'expected next token to be ), got { instead');",
  '});',
  'const vars = {};',
  "const lit = t => JSON.parse(t.replace(/'/g, '\"'));",
  "const show = v => Array.isArray(v) ? '[' + v.map(show).join(', ') + ']' : typeof v === 'string' ? v : String(v);",
  "function ref(p) { const m = p.match(/^([A-Za-z_]\\w*)(.*)$/); if (!(m[1] in vars)) { console.log('identifier not found: ' + m[1]); process.exit(99); } let v = vars[m[1]];",
  "  for (const t of m[2].match(/\\.[A-Za-z_]\\w*|\\[[^\\]]*\\]/g) ?? []) { if (t[0] === '.') v = v[t.slice(1)]; else { const parts = t.slice(1, -1).split(':'); if (parts.length === 1) v = v[Number(parts[0])]; else { const st = parts[2] ? Number(parts[2]) : 1; const out = []; for (let k = parts[0] === '' ? 0 : Number(parts[0]); k < (parts[1] === '' ? v.length : Number(parts[1])) && k < v.length; k += st) out.push(v[k]); v = out; } } } return v; }",
  'for (const line of lines.map(l => l.trim())) {',
  "  const w = line.match(/^(.+)\\[(\\d*):(\\d*)\\]\\s*=\\s*(.+)$/); if (w) { const t = ref(w[1]); const s = w[2] === '' ? 0 : Number(w[2]); const e = w[3] === '' ? t.length : Number(w[3]); const val = lit(w[4]); if (val.length !== e - s) { console.log('range assignment size mismatch: target=' + (e - s) + ' value=' + val.length); process.exit(99); } t.splice(s, e - s, ...val); continue; }",
  "  const a = line.match(/^([A-Za-z_]\\w*)\\s*=\\s*(.+)$/); if (a) { vars[a[1]] = lit(a[2]); continue; }",
  "  const e = line.match(/^echo\\((.*)\\)$/); if (e) { const x = e[1].trim(); console.log(show(/^[\\[\\d\"']/.test(x) && !/^\\[[^\\]]*\\]\\[/.test(x) ? lit(x) : ref(x))); continue; }",
  "  console.log('evaluation error: ' + line); process.exit(99);",
  '}', '',
].join('\n');
const SYNTAX = { parseErrorPattern: 'parser errors:[\\s\\S]*?\\[(?<line>\\d+):(?<col>\\d+)\\]', newSyntaxPattern: '\\[[^\\[\\]\\n]*:[^\\[\\]\\n]*:[^\\[\\]\\n]*\\]' };

const root = mkdtempSync(join(tmpdir(), 'probe-extraction-run32-'));
try {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Smoke'); git('config', 'user.email', 'smoke@local.invalid');
  writeFileSync(join(root, '.git/info/exclude'), '.proof-or-stop/\n');
  mkdirSync(join(root, 'tools')); mkdirSync(join(root, 'lib')); mkdirSync(join(root, 'evaluator'));
  writeFileSync(join(root, 'tools/mini.js'), EVAL);
  writeFileSync(join(root, 'lib/impl.txt'), 'base\n');
  const runnerConfig = { command: process.execPath, args: ['tools/mini.js', '{file}'], program: 'echo({input})', extension: '.mini',
    skipPattern: 'identifier not found', selfTest: { input: '[1, 2]', output: '[1, 2]' }, ...SYNTAX };
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ probeRunner: runnerConfig, pinOracle: { ...runnerConfig, selfTest: undefined },
    // Old-PoS run 33: the probe gate is the A/B arm dev.probeEnforcement=enforce (default advisory).
    dev: { probeEnforcement: 'enforce' } }));
  writeFileSync(join(root, 'evaluator/evaluator_test.go'), [
    'package evaluator', '', 'import (', '\t"strings"', '\t"testing"', ')', '',
    'func logErrorWithPosition(t *testing.T, got string, want string) {', '\tif !strings.HasPrefix(got, want) {', '\t\tt.Errorf("got %q want %q", got, want)', '\t}', '}', '',
  ].join('\n'));
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'story/B-1');
  writeFileSync(join(root, 'lib/impl.txt'), 'stepped slices\n');
  git('commit', '-qam', 'implement');
  const store = { readStory: () => ({}) };
  const ctx = probes.storyProbeRunner(store, root, 'B-1', root);
  assert.ok(ctx, 'the declared runner is prepared');

  // ---- B. run 32 write rows: no false flag
  {
    const writes = item('CHK-004', ['h={"a":[0,1,2]}; h.a[0:2]=[9,8]; h.a -> [9,8,2]', 'x=[[0,1,2]]; x[0][0:2]=[9,8]; x[0] -> [9,8,2]', 'a=[0,1,2,3,4]; a[1:4]=[9,8,7]; a -> [0,9,8,7,4]']);
    const done = probes.probeDoneCheck(ctx!, root, 'B-1', writes, [writes], null);
    assert.equal(done.refusal, null, `run 32 3a: correct write pins are not flagged:\n${done.refusal}`);
    assert.match(done.note ?? '', /3 rows run[^\n]*none flagged/, `all three write rows run: ${done.note}`);
  }

  // ---- C. staleness
  {
    const wrong = item('CHK-005', ['s=[1,2,3]; s[0:1]=[7]; s -> [9, 2, 3]']);
    const first = probes.probeDoneCheck(ctx!, root, 'B-1', wrong, [wrong], null);
    assert.ok(first.refusal, 'a wrong pin is flagged');
    const amended = item('CHK-005', ['TestStringWrites passes']);
    const before = new Date(Date.now() - 60_000).toISOString();
    const decision = probes.runnerProbeDecision(ctx!, root, 'B-1', amended, [amended], null, [{ runId: 'r1', createdAt: before, text: 'done\n[intent-conflict] none' }]);
    assert.equal(decision, null, `run 32 3b: rows amended to zero cases leave no flag (material unchanged): ${JSON.stringify(decision)}`);
    const state = probes.readProbeState(root, 'B-1', 'CHK-005');
    assert.equal(state.table, null, 'the stale table is cleared');
    assert.equal(state.flaggedKey, null);

    const pinned = item('CHK-006', ['s=[1,2,3]; s[0:1]=[7]; s -> [9, 2, 3]']);
    assert.ok(probes.probeDoneCheck(ctx!, root, 'B-1', pinned, [pinned], null).refusal);
    // The flag was raised two minutes ago; r1 ran before it, the relaunch r2 after it.
    const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
    probes.writeProbeState(root, 'B-1', 'CHK-006', { ...probes.readProbeState(root, 'B-1', 'CHK-006'), flaggedSince: at(-120) });
    const reopen = probes.runnerProbeDecision(ctx!, root, 'B-1', pinned, [pinned], null, [{ runId: 'r1', createdAt: at(-180), text: '' }]);
    assert.equal(reopen?.action, 'reopen');
    const runs = [{ runId: 'r1', createdAt: at(-180), text: '' }, { runId: 'r2', createdAt: at(-60), text: 'done\n[intent-conflict] none' }];
    assert.equal(probes.runnerProbeDecision(ctx!, root, 'B-1', pinned, [pinned], null, runs)?.action, 'escalate', 'unchanged intent: the relaunch saw the row');
    const rederived = item('CHK-006', [{ desc: 's=[1,2,3]; s[0:1]=[7]; s -> [9, 2, 3]', derivation: { requestQuote: 'Support assigning', computation: 'owner amended' } }]);
    const after = probes.runnerProbeDecision(ctx!, root, 'B-1', rederived, [rederived], null, runs);
    assert.notEqual(after?.action, 'escalate', `run 32 3b: a flag whose item intent changed since it was raised is not escalated: ${JSON.stringify(after)}`);
  }

  // ---- D. parse errors inside / outside the new-syntax region
  {
    const outside = api(oracle, 'parseErrorOutsideNewSyntax');
    // Real abs outputs (hb__datacurve-abs-stepped-slices image, Story base, 2026-10-09).
    const absInside = ' parser errors:\n \tno prefix parse function for \':\' found\n\t[1:15]\techo([1,2,3][::2])\n \texpected next token to be :, got NUMBER instead\n\t[1:15]\techo([1,2,3][::2])';
    assert.equal(outside(SYNTAX, 'echo([1,2,3][::2])', absInside), null, 'a parse error inside `[::2]` is the expected new-syntax error');
    const absMulti = ' parser errors:\n \texpected next token to be NUMBER, got : instead\n\t[2:5]\ta[1:4:2]=[9,8]';
    assert.equal(outside(SYNTAX, 'a=[0,1,2,3,4]\na[1:4:2]=[9,8]\necho(a)', absMulti), null, 'line 2 column 5 lies inside `[1:4:2]`');
    const absOutside = ' parser errors:\n \texpected next token to be ), got IDENT instead\n\t[3:5]\ta=f()';
    assert.match(String(outside(SYNTAX, 'h={"a":[0,1,2]}\nf(){ h.a[0:2]=[9,8]; return h.a }\na=f()\necho(a)', absOutside)), /expected next token to be \), got IDENT instead/, 'a parse error outside any new-syntax region is an authoring error');
    assert.equal(outside({}, 'x', absOutside), null, 'without the declaration nothing is judged');
    assert.equal(outside(SYNTAX, 'echo(a)', '[1, 2]'), null, 'a value is no parse error');

    const rows = item('CHK-004', ['h={"a":[0,1,2]}; f(){ h.a[0:2]=[9,8]; return h.a }; a=f(); a -> [9,8,2]', 'a=[0,1,2,3,4,5]; a[1:6:2] -> [1, 3, 5]'], 'pending');
    const syntax = api(probes, 'probeSyntaxErrors')(ctx, [rows]) as Array<{ ref: string; error: string }>;
    assert.deepEqual(syntax.map(entry => entry.ref), ['CHK-004:edge:0'], `run 32 3c: only the f(){} row is an authoring error at PLAN: ${JSON.stringify(syntax)}`);
    // DEV: the broken row is never a code flag.
    const broken = item('CHK-007', ['h={"a":[0,1,2]}; f(){ h.a[0:2]=[9,8]; return h.a }; a=f(); a -> [9,8,2]']);
    assert.equal(probes.probeDoneCheck(ctx!, root, 'B-1', broken, [broken], null).refusal, null, 'a row the base cannot parse outside the new syntax is never a code flag');
    // Pin oracle: same class.
    const pinCtx = oracle.preparePinOracle(root, root, base);
    assert.ok(pinCtx);
    const mismatched = oracle.pinOracleMismatches(pinCtx!, [item('CHK-008', ['echo2(f(){ 1 }) -> 1', '[0,1,2,3][::2] -> [0, 2]'], 'pending')]);
    assert.equal(mismatched[0]?.rows.length, 1, `the pin oracle reports the out-of-region parse error only: ${JSON.stringify(mismatched)}`);
    assert.match(mismatched[0]!.rows[0]!.computed, /parse error outside the new syntax/);
  }

  // ---- E. exact text asserted through a prefix helper
  {
    const request = '3. Assignment\n- Assignment error strings must match exactly:\n  - `range assignment size mismatch: target=<X> value=<Y>`\n  - `range assignment expects STRING value, got <TYPE>`\n';
    writeFileSync(join(root, 'evaluator/assign_test.go'), [
      'package evaluator', '', 'import "testing"', '',
      'func TestEvalAssignArrayRanges(t *testing.T) {',
      '\ttests := []struct{ input, expected string }{',
      '\t\t{"a=[1,2]; a[0:2]=[1]", "range assignment size mismatch: target=2 value=1"},',
      '\t}',
      '\tfor _, tt := range tests {',
      '\t\tlogErrorWithPosition(t, run(tt.input), tt.expected)',
      '\t}',
      '}', '',
    ].join('\n'));
    git('add', '-A'); git('commit', '-qm', 'tests');
    const exactModule = ['..', 'core', 'exact-text-assertions.js'].join('/');
    const exact = await import(exactModule).catch(() => null) as Record<string, Fn> | null;
    assert.ok(exact, 'core/exact-text-assertions.js exists');
    const gaps = exact!.exactTextPrefixAssertions!({ gitCwd: root, base, requestText: request }) as Array<{ literal: string; file: string; test: string; via: string }>;
    assert.equal(gaps.length, 1, `run 32 F-001: the prefix-helper assertion of a request-quoted string is found: ${JSON.stringify(gaps)}`);
    assert.equal(gaps[0]!.file, 'evaluator/assign_test.go');
    assert.equal(gaps[0]!.test, 'TestEvalAssignArrayRanges');
    assert.equal(gaps[0]!.via, 'logErrorWithPosition');
    assert.match(gaps[0]!.literal, /^range assignment size mismatch: target=/);
    writeFileSync(join(root, 'evaluator/assign_exact_test.go'), [
      'package evaluator', '', 'import "testing"', '',
      'func TestAssignErrorExact(t *testing.T) {',
      '\tif got := run("a=[1,2]; a[0:2]=[1]"); got != "range assignment size mismatch: target=2 value=1" {',
      '\t\tt.Fatalf("got %q", got)',
      '\t}',
      '}', '',
    ].join('\n'));
    git('add', '-A'); git('commit', '-qm', 'exact test');
    assert.deepEqual(exact!.exactTextPrefixAssertions!({ gitCwd: root, base, requestText: request }), [], 'an exact comparison of the string in the added tests clears it');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('probe-extraction-run32-smoke: PASS');
