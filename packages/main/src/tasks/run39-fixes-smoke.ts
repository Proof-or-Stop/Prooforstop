#!/usr/bin/env node
/**
 * Old-PoS runs 35-39 (bench-staging/oldpos/run36-a1-analysis.md,
 * run37-a2-analysis.md §3 and §5, run38-a3-analysis.md §2): unit level, with
 * real git repositories and a node evaluator where Git or a probe runner is
 * involved. Generic examples only (no benchmark-task material).
 *
 *   P. Probe rows (runs 35/38/39: every owner row was prose such as "... returns
 *      [1, 3]" / "... evaluates to ..." / "... outputs ...", the extractor only
 *      knew `->` `→` `=>` `==`, so the probe runner extracted 0 rows, silently):
 *      P1 with probe extraction on, a prose connector after a code input and
 *         before a concrete value is a probe case (the same small verb set the
 *         derivation rule already treats as an example separator);
 *      P2 prose rows without a code input or a concrete value stay no case (no
 *         false extraction);
 *      P3 with probe extraction off (A0: no probeRunner, no probe matrix) the
 *         scope-plan pin audit extracts exactly what it did before (arrow only);
 *      P4 an example-shaped row the probe cannot run is reported when it is
 *         saved (one Next: rewrite it as `<input> -> <expected>` with the row
 *         patch), and the implementer contract and the done note say "N rows
 *         not extractable" instead of a silent "0 example rows";
 *      P5 the INIT/PLAN row guidance states the arrow form with an example.
 *   D. preexisting_out_of_scope for doc-code-drift findings (runs 36/37 §5):
 *      D1 documentation anchors are the defect sites, code anchors evidence;
 *      D2 a drift whose code evidence is unchanged at the base (run 37 F-002
 *         shape: the Story only moved the code) is pre-existing, and the code
 *         file being in the scope contract does not make it in scope;
 *      D3 code evidence inside a Story hunk is not proof (the Story may have
 *         changed the behaviour the doc describes): not pre-existing;
 *      D4 a doc the Story edited (run 37 F-003 follow-on) is the Story's own;
 *      D5 a finding that is not doc-code-drift keeps every anchor a defect site.
 *   I. intent_conflict cross-item propagation (run 37 trips 1-3): the PLAN
 *      amendment step for one conflict lists every row of every item that
 *      carries the same wrong pinned fragment, in ONE batch step.
 *
 * Usage: node packages/main/dist/tasks/run39-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as probes from '../core/request-probes.js';
import * as preexisting from '../core/finding-preexisting.js';
import * as nextDriver from '../handlers/next-driver.js';
import type { ChecklistItem, VerificationIntent } from '../core/types.js';

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

const row = (desc: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story', ...extra });
const item = (id: string, lanes: { happy?: string[]; edge?: string[]; adversarial?: string[] }, status: ChecklistItem['status'] = 'pending'): ChecklistItem => ({ id, title: `item ${id}`, status,
  verificationIntent: { happy: (lanes.happy ?? []).map(desc => row(desc)), edge: (lanes.edge ?? []).map(desc => row(desc)), adversarial: (lanes.adversarial ?? []).map(desc => row(desc)) } as unknown as VerificationIntent } as ChecklistItem);

// ---------------------------------------------------------------------------
// P. probe rows

const PROSE_ROWS = [
  'positive stepped slice [0, 1, 2, 3, 4][1:5:2] returns [1, 3]',
  '[0, 1, 2, 3, 4, 5][::2] evaluates to [0, 2, 4].',
  'a = [1, 2, 3, 4]; a[1:3] = [8, 9]; show(a) outputs [1, 8, 9, 4].',
  'size("abc") gives 3',
];
const NOT_CASES = [
  'single-index and two-part ranges still parse without a step',
  'zero selected indexes returns an empty array or string',
  'the evaluator returns the same value as before for existing reads',
  'f(x) returns the result of g(x)',
  'go test -v ./pkg prints --- PASS: TestX',
  'print(a) is unchanged',
];

await check('P1 a prose connector after a code input and before a concrete value is a probe case (extraction on)', () => {
  for (const desc of PROSE_ROWS) {
    const cases = probes.probeCasesOf('CHK-001:happy:0', 'CHK-001', desc);
    assert.equal(cases.length, 1, `one case for ${JSON.stringify(desc)}: ${JSON.stringify(cases)}`);
  }
  const [stepped] = probes.probeCasesOf('CHK-001:happy:0', 'CHK-001', PROSE_ROWS[0]!);
  assert.equal(stepped!.expr, '[0, 1, 2, 3, 4][1:5:2]');
  assert.equal(stepped!.pinned.text, '[1, 3]');
  const [write] = probes.probeCasesOf('CHK-001:happy:2', 'CHK-001', PROSE_ROWS[2]!);
  assert.deepEqual(write!.statements, ['a=[1, 2, 3, 4]', 'a[1:3]=[8, 9]'], `the statements run in order: ${JSON.stringify(write)}`);
  assert.equal(write!.expr, 'show(a)');
  assert.equal(write!.pinned.text, '[1, 8, 9, 4]');
  // The arrow form keeps winning over a verb in the same row.
  const [arrow] = probes.probeCasesOf('CHK-001:happy:3', 'CHK-001', 'size("returns") -> 7');
  assert.equal(arrow!.pinned.text, '7');
});

await check('P2 prose rows without a code input or a concrete value are no case (no false extraction)', () => {
  for (const desc of NOT_CASES) {
    assert.deepEqual(probes.probeCasesOf('CHK-001:edge:0', 'CHK-001', desc), [], `no case for ${JSON.stringify(desc)}`);
  }
});

await check('P3 extraction off (A0): the pin-audit cases are the arrow rows only, as before', () => {
  const anchored = api(probes, 'anchoredCases');
  const audit = api(probes, 'renderRequestAnchoredPinAudit');
  const items = [item('CHK-001', { edge: ['[1, 2, 3][0:3:2] returns [1, 3]', '[1, 2, 3][0:2:1] -> [1, 2]'] })];
  const keys = (opts: Record<string, unknown>) => (anchored(items, '', undefined, opts) as Array<{ probe: { expr: string } }>).map(entry => entry.probe.expr);
  assert.deepEqual(keys({ prose: false }), ['[1, 2, 3][0:2:1]'], 'A0: a prose row is not a case of the scope-plan pin audit');
  assert.deepEqual(keys({ prose: true }), ['[1, 2, 3][0:3:2]', '[1, 2, 3][0:2:1]'], 'extraction on: the prose row is a case too');
  assert.ok(audit.length >= 3, 'renderRequestAnchoredPinAudit takes the extraction option (items, request, options)');
});

await check('P4 an example-shaped row no probe can run is reported at save and in the contract (N rows not extractable)', () => {
  const unextractable = 'after the call, x.push(2) twice gives [1, 2]';
  const rows = item('CHK-002', { happy: ['[1, 2][0:1] -> [1]', unextractable, 'Upper of "ab" gives "AB"'], edge: ['TestUpper passes'] });
  const saveNote = api(probes, 'probeRowSaveNote');
  const note = String(saveNote({ storyId: 'B-1', itemId: 'CHK-002', verificationIntent: rows.verificationIntent, enabled: true }));
  assert.match(note, /2 rows? (?:are )?not extractable/i, `the save note counts the rows: ${note}`);
  assert.match(note, /CHK-002:happy:1/);
  assert.match(note, /CHK-002:happy:2/);
  assert.ok(!note.includes('CHK-002:edge:0'), 'a row with no example is not reported');
  assert.match(note, /<input> -> <expected>/, 'the note names the accepted form');
  assert.equal((note.match(/Next: proof-or-stop /g) ?? []).length, 1, `ONE next action: ${note}`);
  assert.match(note, /intentRows/, 'the Next patches the listed rows only');
  assert.equal(saveNote({ storyId: 'B-1', itemId: 'CHK-002', verificationIntent: rows.verificationIntent, enabled: false }), '', 'extraction off (A0): no note');
  const contract = probes.renderFrameworkProbeContract([rows], null, 'CHK-002', { base: 'a'.repeat(40) }).join('\n');
  assert.match(contract, /1 example rows?/, `the runnable count: ${contract}`);
  assert.match(contract, /2 rows? (?:are )?not extractable/i, `the contract states the unextractable rows instead of a silent count: ${contract}`);
});

await check('P4b the done note states "N rows not extractable" when no row runs (no silent 0)', () => {
  const root = mkdtempSync(join(tmpdir(), 'run39-probe-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Smoke'); git('config', 'user.email', 'smoke@local.invalid');
    writeFileSync(join(root, '.git/info/exclude'), '.proof-or-stop/\n');
    mkdirSync(join(root, 'tools'));
    writeFileSync(join(root, 'tools/echo.js'), "const fs=require('fs');const t=fs.readFileSync(process.argv[2],'utf8').trim();const m=t.match(/^echo\\((.*)\\)$/);console.log(m?m[1]:t);\n");
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ probeRunner: { command: process.execPath, args: ['tools/echo.js', '{file}'], program: 'echo({input})', extension: '.txt' } }));
    git('add', '-A'); git('commit', '-qm', 'base');
    git('checkout', '-q', '-b', 'story/B-1');
    writeFileSync(join(root, 'impl.txt'), 'x\n'); git('add', '-A'); git('commit', '-qm', 'impl');
    const ctx = probes.storyProbeRunner({ readStory: () => ({}) }, root, 'B-1', root);
    assert.ok(ctx, 'the declared runner is prepared');
    const prose = item('CHK-003', { happy: ['after the call, x.push(2) twice gives [1, 2]', 'Upper of "ab" gives "AB"'] }, 'in_progress');
    const done = probes.probeDoneCheck(ctx!, root, 'B-1', prose, [prose], null);
    assert.equal(done.refusal, null);
    assert.match(String(done.note), /0 of 2 example rows?[^\n]*run/i, `the done note counts the rows: ${done.note}`);
    assert.match(String(done.note), /2 rows? (?:are )?not extractable/i, `the done note says why nothing ran: ${done.note}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await check('P5 the row guidance states the arrow form with a generic example', () => {
  const template = nextDriver.storyCreateTemplateStep(mkdtempSync(join(tmpdir(), 'run39-tpl-')));
  const hint = String((template as unknown as { placeholderHints?: Record<string, string> }).placeholderHints?.['checklist[0].verificationIntent.happy[0].desc'] ?? '');
  assert.match(hint, /`<input> -> <expected[^`]*>`/, `the hint states the arrow form: ${hint}`);
  assert.match(hint, /e\.g\. `[^`]+ -> [^`]+`/, `with a generic example: ${hint}`);
});

// ---------------------------------------------------------------------------
// D. pre-existing doc-code-drift

function driftRepo(): { root: string; git: (...args: string[]) => string; base: string } {
  const root = mkdtempSync(join(tmpdir(), 'run39-drift-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Smoke'); git('config', 'user.email', 'smoke@local.invalid');
  mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'docs/range.md'), '# Ranges\n\n`[0, 1, 2, 3][0:2]` returns `[0, 1, 2]`.\nThe end index is exclusive.\n');
  writeFileSync(join(root, 'src/range.go'), ['package src', '', 'func Range(a []int, s, e int) []int {', '\tout := []int{}', '\tfor i := s; i < e; i++ {', '\t\tout = append(out, a[i])', '\t}', '\treturn out', '}', ''].join('\n'));
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'story/B-1');
  // The Story adds a stepped helper ABOVE the existing loop: the loop is unchanged, only shifted.
  writeFileSync(join(root, 'src/range.go'), ['package src', '', 'func Stepped(a []int, s, e, st int) []int {', '\tout := []int{}', '\tfor i := s; i < e; i += st {', '\t\tout = append(out, a[i])', '\t}', '\treturn out', '}', '',
    'func Range(a []int, s, e int) []int {', '\tout := []int{}', '\tfor i := s; i < e; i++ {', '\t\tout = append(out, a[i])', '\t}', '\treturn out', '}', ''].join('\n'));
  git('commit', '-qam', 'stepped');
  return { root, git, base };
}
const drift = (code: string) => ({ desc: `doc-code-drift: docs/range.md:3 shows [0, 1, 2, 3][0:2] returning [0, 1, 2], but ${code} selects while i < e, so the result is [0, 1].`,
  files: ['docs/range.md', 'src/range.go'] });
const CONTRACT = { allowedModify: ['src/range.go'], allowedCreate: [], allowedTest: [] };

await check('D1 doc-code-drift: documentation anchors are defect sites, code anchors evidence', () => {
  const sites = api(preexisting, 'findingSites')(drift('src/range.go:13')) as { defects: Array<{ path: string }>; evidence: Array<{ path: string }> };
  assert.deepEqual(sites.defects.map(anchor => anchor.path), ['docs/range.md']);
  assert.deepEqual(sites.evidence.map(anchor => anchor.path), ['src/range.go']);
});

await check('D2 code evidence unchanged at the base (only moved): pre-existing; the code file in scope does not make the doc in scope', () => {
  const { root, base } = driftRepo();
  try {
    const finding = drift('src/range.go:13');
    const presence = preexisting.assessFindingBasePresence({ gitCwd: root, base, head: 'HEAD', finding });
    assert.equal(presence.preExisting, true, `run 37 F-002 shape: ${presence.reason}`);
    const sites = api(preexisting, 'findingSites')(finding) as { defects: Array<{ path: string }> };
    const coverage = preexisting.findingScopeCoverage({ paths: [...new Set(sites.defects.map(anchor => anchor.path))], contract: CONTRACT, itemFiles: ['src/range.go'], requestText: 'Add stepped ranges to src.', scopeAllowed: [] });
    assert.equal(coverage.inScope, false, `only the doc decides scope: ${coverage.reason}`);
    const reason = preexisting.preexistingDispositionReason(presence, coverage, '');
    assert.match(reason, /src\/range\.go:13/, `the record names the code evidence: ${reason}`);
    assert.match(reason, /base line 5/, `with its base line: ${reason}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await check('D3 code evidence inside a Story hunk: not pre-existing (the Story may have caused the drift)', () => {
  const { root, base } = driftRepo();
  try {
    const presence = preexisting.assessFindingBasePresence({ gitCwd: root, base, head: 'HEAD', finding: drift('src/range.go:5') });
    assert.equal(presence.preExisting, false, presence.reason);
    assert.match(presence.reason, /src\/range\.go/);
    assert.match(presence.reason, /Story/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await check('D4 a drift in a doc the Story edited is the Story\'s own (run 37 F-003 follow-on)', () => {
  const { root, git, base } = driftRepo();
  try {
    writeFileSync(join(root, 'docs/range.md'), '# Ranges\n\n`[0, 1, 2, 3][0:2]` returns `[0, 1, 2]`.\nThe end index is exclusive.\nAn omitted end is the length.\n');
    git('commit', '-qam', 'docs edit elsewhere in the file');
    const presence = preexisting.assessFindingBasePresence({ gitCwd: root, base, head: 'HEAD', finding: drift('src/range.go:13') });
    assert.equal(presence.preExisting, false, presence.reason);
    assert.match(presence.reason, /docs\/range\.md/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await check('D5 a finding that is not doc-code-drift keeps every anchor a defect site', () => {
  const finding = { desc: 'docs/range.md:3 and src/range.go:13 disagree about the end index.', files: ['docs/range.md', 'src/range.go'] };
  const sites = api(preexisting, 'findingSites')(finding) as { defects: Array<{ path: string }>; evidence: unknown[] };
  assert.deepEqual(sites.defects.map(anchor => anchor.path), ['docs/range.md', 'src/range.go']);
  assert.deepEqual(sites.evidence, []);
});

// ---------------------------------------------------------------------------
// I. intent_conflict cross-item propagation

await check('I1 one amendment step lists every row carrying the same wrong pinned fragment (run 37: one trip per item)', () => {
  const items = [
    item('CHK-002', { edge: ['[1, 2] lookup with a non-numeric start: [1, 2]["x":1] -> error \'index operator not supported: "x" on ARRAY\''] }, 'done'),
    item('CHK-003', { edge: ['"ab" lookup with a non-numeric start: "ab"["x":1] -> error \'index operator not supported: "x" on STRING\''] }, 'pending'),
    item('CHK-004', { happy: ['[1, 2][0:1] -> [1]'] }, 'pending'),
    item('CHK-005', { edge: ['s = "ab"; s["x":1] = "z" -> error \'index operator not supported: "x" on STRING\''] }, 'pending'),
  ];
  const conflict = { runId: 'r1', agentType: 'proof-or-stop-implementer', createdAt: new Date().toISOString(), itemId: 'CHK-002',
    conflict: { intentRef: 'CHK-002:edge:0', itemId: 'CHK-002', requestSentence: 'A non-numeric start keeps the existing error: `index operator not supported: <inspect> on ARRAY`',
      requestImplies: 'index operator not supported: x on ARRAY', intentPins: 'index operator not supported: "x" on ARRAY', raw: '[intent-conflict] CHK-002:edge:0 | ...', undeclared: false } };
  const next = nextDriver.intentConflictStep({ storyId: 'B-1', phase: 'PLAN' }, [conflict], items);
  const calls = (next.batch ?? [{ cli: next.cli }]).map(call => call.cli as { command: string; payload: Record<string, unknown> });
  const touched = calls.map(call => String(call.payload.itemId));
  assert.deepEqual(touched, ['CHK-002', 'CHK-003', 'CHK-005'], `ONE step amends the conflicting item and every sibling row with the same pinned fragment: ${JSON.stringify(calls)}`);
  for (const ref of ['CHK-003:edge:0', 'CHK-005:edge:0']) assert.ok(next.why.includes(ref), `the step lists ${ref}: ${next.why}`);
  assert.ok(!next.why.includes('CHK-004'), 'an unrelated item is not touched');
  const sibling = calls.find(call => call.payload.itemId === 'CHK-003')!.payload;
  assert.ok(Array.isArray(sibling.intentRows), `a sibling is patched row by row (no whole-intent resubmission): ${JSON.stringify(sibling)}`);
  assert.equal((sibling.intentRows as Array<{ ref: string }>)[0]!.ref, 'CHK-003:edge:0');
});

if (failures.length) {
  console.error(`run39-fixes-smoke: FAIL (${failures.length}: ${failures.join('; ')})`);
  process.exit(1);
}
console.log('run39-fixes-smoke: PASS');
