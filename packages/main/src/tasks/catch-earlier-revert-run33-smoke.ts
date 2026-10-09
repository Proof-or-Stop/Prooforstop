#!/usr/bin/env node
/**
 * Old-PoS run 33 (bench-staging/oldpos/run33-analysis.md §3, §4): the "catch
 * defects earlier" line (runs 30-33) cost about 38 min / 31M tokens per run
 * with no demonstrated detection benefit. Unit level:
 *
 *   A. Detection-neutral fixes
 *     A1. the CLI phase gate admits scope_check_save in DEV (the handler then
 *         admits only the live PLAN-launched managed scope-plan run); REVIEW
 *         still refuses it;
 *     A1b. a save reviewer's (scope-plan / delivery) managed run that ended
 *         managed_dispatch_output_missing, or with a classified deterministic
 *         save refusal, and left no work product is auto-replaceable (next
 *         relaunches it, <= 3 per target); an implementer's is not;
 *     A3. probe case isolation: independent examples chained in one row each
 *         run from the row's prelude (a mutation statement of an earlier case
 *         is not carried into the next case); a row whose pin matches the
 *         cumulative run (intended chaining) is not flagged either; only a pin
 *         neither run matches is a flag; a `[probe-row] <row> | ok: <why>` line
 *         disposes a `pin` flag as the refusal text says;
 *     A4. a stored finding that cites Story metadata and product code, whose
 *         correction target (item + field / row) is the target of a lane
 *         finding reclassified as metadata, is a metadata finding (never
 *         repair work); a product finding with no such target is not.
 *   B. Default-off switches (core/ab-variants.ts): plan.coverageMatrix=off
 *      keeps only the exact-text rows; dev.probeEnforcement=advisory runs the
 *      probes at done and never refuses; implementation.probeMatrix=off;
 *      plan.scopeDeferral=off; plan.pinAuditEnforcement=off.
 *
 * Usage: node packages/main/dist/tasks/catch-earlier-revert-run33-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isCommandAllowed } from '../core/config.js';
import * as abVariants from '../core/ab-variants.js';
import * as managedHostRun from '../core/managed-host-run.js';
import * as probes from '../core/request-probes.js';
import * as coverage from '../core/plan-coverage-matrix.js';
import * as metadata from '../core/metadata-correction.js';
import type { ChecklistItem, VerificationIntent } from '../core/types.js';

type Fn = (...args: unknown[]) => unknown;
const api = (module: object, name: string): Fn => {
  const fn = (module as Record<string, unknown>)[name];
  assert.equal(typeof fn, 'function', `${name} is exported`);
  return fn as Fn;
};
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 3).join(' | ') : String(error)}`); }
}

const row = (desc: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story', ...extra });
const item = (id: string, edge: Array<string | Record<string, unknown>>, status: ChecklistItem['status'] = 'done', extra: Record<string, unknown> = {}): ChecklistItem => ({ id, title: `item ${id}`, status,
  verificationIntent: { happy: [], edge: edge.map(entry => (typeof entry === 'string' ? row(entry) : row(String(entry.desc), entry))), adversarial: [] } as unknown as VerificationIntent, ...extra } as ChecklistItem);

await check('A1 phase gate: scope_check_save is admitted in DEV (deferred N8 save) and still refused in REVIEW', () => {
  assert.equal(isCommandAllowed('scope_check_save', 'PLAN'), true);
  assert.equal(isCommandAllowed('scope_check_save', 'DEV'), true, 'runs 30/33: DEFAULT_PHASE_TOOLS.DEV lacked scope_check_save, so the deferred save failed in every Story worktree');
  assert.equal(isCommandAllowed('scope_check_save', 'REVIEW'), false);
});

await check('A1b auto-replace: a save reviewer that left no output and no work product is relaunched by next; an implementer is not', () => {
  const auto = api(managedHostRun, 'isAutoReplaceableManagedLaunchFailure');
  const run = (terminalReason: string, agentType: string, replacementSafe = true) => auto({ state: 'failed', replacementSafe, terminalReason, agentType });
  assert.equal(run('managed_dispatch_output_missing', 'proof-or-stop-review-scope-plan'), true, 'run 33: scope-plan #1 output_missing, replacementSafe');
  assert.equal(run('managed_dispatch_output_missing', 'proof-or-stop-review-delivery'), true);
  assert.equal(run('managed_dispatch_output_missing', 'proof-or-stop-review-scope-plan', false), false, 'work product left: the agent decides');
  assert.equal(run('managed_dispatch_output_missing', 'proof-or-stop-implementer'), false, 'a code writer is never auto-replaced on output_missing');
  assert.equal(run('managed_dispatch_save_refused:phase_gate: Command "scope_check_save" is not available in DEV phase', 'proof-or-stop-review-scope-plan'), true,
    'a classified deterministic save refusal ends the run and is auto-replaceable');
  assert.equal(auto({ state: 'failed', replacementSafe: true, terminalReason: 'managed_dispatch_output_missing' }), false, 'without the role nothing changes');
});

// Run 33 CHK-003:edge:7 as authored at PLAN (independent examples, each meant to start from a=[0,1,2,3]).
const RUN33_EDGE7 = 'a=[0,1,2,3]; a[1::2]=9; str(a) -> [0, 9, 2, 9]; a[:4:2]=9 -> [9, 1, 9, 3]; a[1:3:]=9 -> [0, 9, 9, 3]';

await check('A3 extraction: each case of a chained row has an isolated program (the row prelude + its own statements)', () => {
  const cases = probes.probeCasesOf('CHK-003:edge:7', 'CHK-003', RUN33_EDGE7) as Array<{ key: string; statements: string[]; isolatedStatements?: string[] }>;
  assert.equal(cases.length, 3);
  assert.deepEqual(cases[0]!.statements, ['a=[0,1,2,3]', 'a[1::2]=9'], 'case 1 keeps its own write');
  assert.deepEqual(cases[1]!.statements, ['a=[0,1,2,3]', 'a[1::2]=9', 'a[:4:2]=9'], 'the cumulative program (run 32 rule) is kept');
  assert.deepEqual(cases[1]!.isolatedStatements, ['a=[0,1,2,3]', 'a[:4:2]=9'], `case 2 also runs from the prelude alone: ${JSON.stringify(cases[1])}`);
  assert.deepEqual(cases[2]!.isolatedStatements, ['a=[0,1,2,3]', 'a[1:3:]=9'], 'case 3 likewise');
  const single = probes.probeCasesOf('CHK-004:edge:0', 'CHK-004', 'a=[0,1,2,3,4]; a[1:4]=[9,8,7]; a -> [0,9,8,7,4]') as Array<{ isolatedStatements?: string[] }>;
  assert.equal(single[0]!.isolatedStatements, undefined, 'a one-case row has no separate isolated program');
});

// ---- runner fixture (node evaluator: literal bindings, two-part range writes, echo)
const EVAL = [
  "const fs = require('fs');",
  "const lines = fs.readFileSync(process.argv[2], 'utf8').split('\\n').map(l => l.trim()).filter(Boolean);",
  'const vars = {};',
  "const lit = t => JSON.parse(t.replace(/'/g, '\"'));",
  "const show = v => Array.isArray(v) ? '[' + v.map(show).join(', ') + ']' : String(v);",
  "const ref = n => { if (!(n in vars)) { console.log('identifier not found: ' + n); process.exit(99); } return vars[n]; };",
  'for (const line of lines) {',
  "  const w = line.match(/^([A-Za-z_]\\w*)\\[(\\d*):(\\d*)\\]\\s*=\\s*(.+)$/); if (w) { const t = ref(w[1]); const s = w[2] === '' ? 0 : Number(w[2]); const e = w[3] === '' ? t.length : Number(w[3]); const val = lit(w[4]); t.splice(s, e - s, ...val); continue; }",
  "  const a = line.match(/^([A-Za-z_]\\w*)\\s*=\\s*(.+)$/); if (a) { vars[a[1]] = lit(a[2]); continue; }",
  "  const e = line.match(/^echo\\((.*)\\)$/); if (e) { const x = e[1].trim(); console.log(show(/^[\\[\\d]/.test(x) ? lit(x) : ref(x))); continue; }",
  "  console.log('evaluation error: ' + line); process.exit(99);",
  '}', '',
].join('\n');

const root = mkdtempSync(join(tmpdir(), 'catch-earlier-revert-run33-'));
try {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Smoke'); git('config', 'user.email', 'smoke@local.invalid');
  writeFileSync(join(root, '.git/info/exclude'), '.proof-or-stop/\n');
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools/mini.js'), EVAL);
  const runnerConfig = { command: process.execPath, args: ['tools/mini.js', '{file}'], program: 'echo({input})', extension: '.mini',
    skipPattern: 'identifier not found', selfTest: { input: '[1, 2]', output: '[1, 2]' } };
  // Production default: no dev.probeEnforcement key (advisory).
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ probeRunner: runnerConfig }));
  git('add', '-A'); git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'story/B-1');
  writeFileSync(join(root, 'impl.txt'), 'change\n');
  git('add', '-A'); git('commit', '-qm', 'implement');
  const store = { readStory: () => ({}) };
  const advisory = probes.storyProbeRunner(store, root, 'B-1', root) as (probes.ProbeRunnerContext & { enforcement?: string }) | null;

  await check('B dev.probeEnforcement: the runner declared without the switch is advisory', () => {
    assert.ok(advisory, 'the declared runner is prepared');
    assert.equal(advisory!.enforcement, 'advisory', `production default: advisory (got ${String(advisory!.enforcement)})`);
  });
  const enforce = advisory ? { ...advisory, enforcement: 'enforce' } as probes.ProbeRunnerContext : null;

  await check('A3 runner: a chained row of independent examples raises no pin flag; intended chaining neither; a wrong pin still does', () => {
    const chained = item('CHK-010', ['a=[0,1,2,3]; a[0:1]=[9]; a -> [9, 1, 2, 3]; a[1:2]=[8] -> [0, 8, 2, 3]']);
    const done = probes.probeDoneCheck(enforce!, root, 'B-1', chained, [chained], null);
    assert.equal(done.refusal, null, `run 33 trip 4: independent cases are judged from the row prelude:\n${done.refusal}`);
    const table = probes.readProbeState(root, 'B-1', 'CHK-010').table as { rows: Array<{ key: string; flags: string[]; chainedCases?: boolean }> } | null;
    const second = table?.rows.find(entry => entry.key === 'CHK-010:edge:0#2');
    assert.ok(second, `the second case is in the table: ${JSON.stringify(table?.rows)}`);
    assert.deepEqual(second!.flags, []);
    assert.equal(second!.chainedCases, true, 'the row is marked: its cumulative run differs from the pin (a PLAN advisory, never a flag)');
    const intended = item('CHK-011', ['a=[0,1,2,3]; a[0:1]=[9]; a -> [9, 1, 2, 3]; a[1:2]=[8] -> [9, 8, 2, 3]']);
    assert.equal(probes.probeDoneCheck(enforce!, root, 'B-1', intended, [intended], null).refusal, null, 'a pin the cumulative run matches (intended chaining) is no flag');
    const wrong = item('CHK-012', ['s=[1,2,3]; s[0:1]=[7]; s -> [9, 2, 3]']);
    assert.ok(probes.probeDoneCheck(enforce!, root, 'B-1', wrong, [wrong], null).refusal, 'a pin no run matches is still flagged (enforce)');
  });

  await check('A3 report: `[probe-row] <row> | ok: <why>` disposes a pin flag (the refusal text promises it)', () => {
    const wrong = item('CHK-013', ['s=[1,2,3]; s[0:1]=[7]; s -> [9, 2, 3]']);
    assert.ok(probes.probeDoneCheck(enforce!, root, 'B-1', wrong, [wrong], null).refusal);
    const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
    const ignored = probes.runnerProbeDecision(enforce!, root, 'B-1', wrong, [wrong], null, [{ runId: 'r1', createdAt: at(30), text: 'done' }]);
    assert.ok(ignored, 'an undisposed flag is decided on');
    const ok = probes.runnerProbeDecision(enforce!, root, 'B-1', wrong, [wrong], null,
      [{ runId: 'r1', createdAt: at(30), text: 'done\n[probe-row] CHK-013:edge:0 | ok: the example rows are independent; each starts from s=[1,2,3]' }]);
    assert.equal(ok, null, `run 33 trip 4: the implementer's [probe-row] ... ok disposed the pin flag: ${JSON.stringify(ok)}`);
  });

  await check('B dev.probeEnforcement=advisory: done is never refused; the table is shown and kept for the REVIEW lanes', () => {
    const wrong = item('CHK-014', ['s=[1,2,3]; s[0:1]=[7]; s -> [9, 2, 3]']);
    const done = probes.probeDoneCheck(advisory!, root, 'B-1', wrong, [wrong], null);
    assert.equal(done.refusal, null, 'advisory never refuses done');
    assert.match(done.note ?? '', /CHK-014:edge:0/, `the flagged row is shown to the implementer: ${done.note}`);
    assert.match(done.note ?? '', /advisory/i, 'the note says it is advisory');
    assert.ok(probes.readProbeState(root, 'B-1', 'CHK-014').table, 'the table is stored (REVIEW lane evidence)');
    assert.ok(probes.renderProbeEvidence(root, 'B-1', ['CHK-014']).some(line => line.includes('CHK-014:edge:0')), 'the lanes get the flagged row as evidence');
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

await check('A4 metadata finding by correction target: a docs-lane copy citing product code is metadata when a lane copy was reclassified', () => {
  const isTarget = api(metadata, 'isMetadataTargetFinding');
  const dir = mkdtempSync(join(tmpdir(), 'catch-earlier-revert-meta-'));
  try {
    const items = [item('CHK-003', ['a=[0,1,2]; a[1:null:1]=9 -> [0, 9, 9]', 's="abc"; s[1:null:1]="X" -> aXX'])];
    const reclassified = { type: 'review_metadata_finding_reclassified', agent: 'proof-or-stop-review-test-coverage', reclassified: [{ desc: 'CHK-003:edge:0 pins success',
      corrections: [{ itemId: 'CHK-003', field: 'verificationIntent', rowRefs: ['CHK-003:edge:0'], wrongLiteral: null, correctedValue: null, fieldHash: null }] }] };
    const storeOf = (events: unknown[]) => ({ readProcessEvents: () => events, readChecklist: () => ({ items }), readFindings: () => ({ findings: [] }),
      storyFilePath: (_id: string, name: string) => join(dir, name) });
    // Run 33 F-003 (docs lane): cites checklist.json, the product file and its test.
    const docsCopy = { id: 'B-1:F-003', status: 'open', severity: 'medium', category: 'edge', createdAt: new Date().toISOString(),
      files: ['.proof-or-stop/story/actives/B-1/checklist.json', 'evaluator/evaluator.go', 'evaluator/evaluator_test.go'],
      desc: 'checklist-intent-drift: CHK-003 edge:0 verificationIntent says explicit null end in stepped assignment should succeed (`a=[0,1,2]; a[1:null:1]=9` -> `[0, 9, 9]`), but the request requires the numeric-range error. The implementation and evaluator_test.go correctly return the error.' };
    assert.equal(isTarget({ store: storeOf([reclassified]), storyId: 'B-1', gitCwd: dir, finding: docsCopy }), true,
      'run 33 F-003: the same correction target as the reclassified lane copy -> metadata, no repair run');
    assert.equal(isTarget({ store: storeOf([]), storyId: 'B-1', gitCwd: dir, finding: docsCopy }), false, 'no reclassified copy: it stays a product finding (NRI)');
    const product = { ...docsCopy, id: 'B-1:F-001', files: ['evaluator/evaluator.go'], desc: 'evaluator/evaluator.go:10 panics on an empty array.' };
    assert.equal(isTarget({ store: storeOf([reclassified]), storyId: 'B-1', gitCwd: dir, finding: product }), false, 'a pure product finding is never metadata');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await check('B switches: absent keys resolve to the run-27 behaviour; each is recorded only when set', () => {
  const variants = abVariants.resolveAbVariants({}) as unknown as Record<string, string>;
  assert.equal(variants.coverageMatrix, 'off');
  assert.equal(variants.scopeDeferral, 'off');
  assert.equal(variants.pinAuditEnforcement, 'off');
  assert.equal(variants.probeEnforcement, 'advisory');
  assert.equal(variants.probeMatrix, 'off');
  assert.equal(abVariants.abVariantEvidence(abVariants.resolveAbVariants({})), undefined, 'production records nothing');
  const all = abVariants.resolveAbVariants({ plan: { coverageMatrix: 'on', scopeDeferral: 'on', pinAuditEnforcement: 'on' }, dev: { probeEnforcement: 'enforce' }, implementation: { probeMatrix: 'on' } });
  assert.deepEqual(abVariants.abVariantEvidence(all)?.flags, { 'plan.coverageMatrix': 'on', 'plan.scopeDeferral': 'on', 'plan.pinAuditEnforcement': 'on', 'dev.probeEnforcement': 'enforce', 'implementation.probeMatrix': 'on' });
  for (const name of ['coverageMatrixOn', 'scopeDeferralOn', 'pinAuditEnforcementOn', 'probeEnforcementOn', 'probeMatrixOn']) {
    const fn = api(abVariants, name);
    assert.equal(fn({}), false, `${name}: off by default`);
    assert.equal(fn({ plan: { coverageMatrix: 'bogus', scopeDeferral: 7 }, dev: { probeEnforcement: 'loud' }, implementation: { probeMatrix: [] } }), false, `${name}: malformed keeps production`);
  }
  assert.equal(api(abVariants, 'coverageMatrixOn')({ plan: { coverageMatrix: 'on' } }), true);
  assert.equal(api(abVariants, 'probeEnforcementOn')({ dev: { probeEnforcement: 'enforce' } }), true);
});

await check('B plan.coverageMatrix=off: only the exact-text coverage rows remain', () => {
  const request = [
    'Extend slices with a step.', '',
    '1. Reads', '- Support `value[start:end:step]`, `value[start:end:]`, `value[:end:step]`, `value[::step]`.', '- Negative step iterates backward.',
    '- Non-numeric `end` or `step` values must keep the numeric-range error format.', '',
    '2. Errors', '- Error strings must match exactly:', '  - `slice step cannot be 0`', '',
  ].join('\n');
  const items = [item('CHK-001', ['[0,1,2][::2] -> [0, 2]'], 'pending')];
  const gapsFor = api(coverage, 'planCoverageGapsFor');
  const all = gapsFor({ plan: { coverageMatrix: 'on' } }, items, request) as Array<{ rule: string }>;
  const off = gapsFor({}, items, request) as Array<{ rule: string }>;
  assert.ok(all.some(gap => gap.rule !== 'exact-text'), `on: the full matrix: ${JSON.stringify(all.map(gap => gap.rule))}`);
  assert.ok(off.length > 0 && off.every(gap => gap.rule === 'exact-text'), `off: exact-text rows only: ${JSON.stringify(off.map(gap => gap.rule))}`);
});

if (failures.length) {
  console.log(`catch-earlier-revert-run33-smoke: FAIL (${failures.length}: ${failures.join('; ')})`);
  process.exit(1);
}
console.log('catch-earlier-revert-run33-smoke: PASS');
