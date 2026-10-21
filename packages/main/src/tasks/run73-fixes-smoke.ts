#!/usr/bin/env node
/**
 * Old-PoS run 73 detection-neutral fixes (bench-staging/oldpos/run73-analysis.md §6 A, B, D, E;
 * lab `codex/lab-run73-fixes`). Unit level (pure functions, real git repositories, real `go test`).
 * Generic examples only (a toy `kv` package, a toy `pick` request); no benchmark-task material.
 * The lifecycle shape of A / B is harness NRF.
 *
 *   A. Repair grouping: an open finding with a recorded failed / refused duplicate-coverage check,
 *      or one tagged `[regression-of F-x]` whose target is resolved, joins the grouped repair run
 *      with the other open blocking findings instead of its own serial run. A duplicate whose
 *      coverage was never refused keeps its coverage path; a regression-tagged finding is not
 *      offered the coverage path at all (the earlier repair is shown not to fix it).
 *   B. Family-complete brief: the repair prompt of a `[regression-of F-x]` finding carries the
 *      earlier repair's diff and the earlier finding's repro and requires ONE test covering every
 *      call site / target shape of the mechanism; the final report lists them (`[family-test]`).
 *   D. Row-vs-request audit: a pin whose case a request example states with another value is
 *      listed (contradiction); a row changed since the scope verdict whose derivation does not
 *      quote the request sentence nearest its case is listed (unquoted sentence); one skippable
 *      offer per set of rows; the owner-facing blocker step asks for the deciding sentence.
 *   E. Findings-scaled framework time: the resolved-finding guards that run on the current tests
 *      run in ONE `go test` invocation when they all pass; a failure falls back to the
 *      per-finding runs, so every decision (blame, events) is the one it was.
 *
 * Usage: node packages/main/dist/tasks/run73-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as duplicates from '../core/duplicate-finding-coverage.js';
import * as nextDriver from '../handlers/next-driver.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, ChecklistItem, Finding, StoryInfo } from '../core/types.js';
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
const api = (module: object, name: string): Fn => {
  const fn = (module as Record<string, unknown>)[name];
  assert.equal(typeof fn, 'function', `${name} is exported`);
  return fn as Fn;
};
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const commit = (root: string, message: string): string => { git(root, ['add', '-A']); git(root, ['commit', '-qm', message]); return git(root, ['rev-parse', 'HEAD']); };
const NOW = '2026-10-14T03:00:00.000Z';

// ---------------------------------------------------------------------------
// A. repair grouping

function groupStore(): { root: string; store: StoryStore; storyId: string; findings: Finding[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run73-grp-')));
  write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }, null, 2));
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-73a1';
  store.writeStory(storyId, { storyId, name: 'store', title: 'Store', description: 'Store.', type: 'feature', phase: 'DEV', priority: 'high',
    createdAt: NOW, startedAt: NOW, endedAt: null, events: [] } as unknown as StoryInfo);
  const f = (n: number, status: string, desc: string, extra: Record<string, unknown> = {}) => ({ id: `${storyId}:F-00${n}`, severity: 'medium', category: 'edge', desc,
    files: ['store/store.go'], status, evidenceState: 'verified', agent: 'proof-or-stop-review-quality', createdAt: NOW, ...extra });
  const findings = [
    f(1, 'resolved', 'put through a nested target is a silent no-op. Repro: `m["a"]["b"] = v`', { resolutionType: 'fixed', resolvedAt: NOW }),
    f(2, 'open', 'put through a nested target with a negative parent index is a no-op (coverage was refused)'),
    f(3, 'open', 'get of a missing key panics'),
    f(4, 'open', 'put through a nested target is a no-op (never covered)'),
    f(5, 'open', '[regression-of F-001] put through a nested target evaluates the selector twice. Repro: `m[f()]["b"] = v`'),
  ] as unknown as Finding[];
  store.writeFindings(storyId, { findings } as never);
  const dup = (n: number) => ({ findingId: `${storyId}:F-00${n}`, disposition: 'duplicate', canonicalFindingId: `${storyId}:F-001`, familyKey: 'nested-target', reason: 'same root cause' });
  const data = store.readReviewInventoryEpochs(storyId);
  data.criticReceipts.push({ findingDispositions: [dup(2), dup(4), dup(5)] } as never);
  store.writeReviewInventoryEpochs(storyId, data);
  store.writeDuplicateFindingCoverage(storyId, { schemaVersion: 'proof-or-stop.duplicate_finding_coverage.v1', receipts: [
    { findingId: `${storyId}:F-002`, canonicalFindingId: `${storyId}:F-001`, command: 'go test ./store -run X', selector: '--- PASS: X', exitCode: null, timedOut: false, selectorMatched: false,
      // Lab run132 (old-PoS run 135 item I): a single lacks-repro refusal now gets the repro append step (run135-hi-smoke I2);
      // a refusal of another kind keeps this route.
      passed: false, headHash: null, durationMs: 0, outputDigest: '', outputTail: '', executedAt: NOW, refusal: 'duplicate_canonical_not_live' }] } as never);
  return { root, store, storyId, findings };
}

await check('A1 a finding with a refused duplicate-coverage check and a regression-tagged finding join the grouped repair run; a never-refused duplicate keeps its coverage path', () => {
  const { root, store, storyId, findings } = groupStore();
  try {
    const open = findings.filter(row => row.status === 'open');
    const group = api(nextDriver, 'groupedFindingRepairIds')({ root, store, gitCwd: root, storyId, primary: { id: `${storyId}:F-003` }, primaryBound: false, findings: open, runs: [] }) as string[];
    assert.deepEqual(group.map(id => id.split(':')[1]), ['F-003', 'F-002', 'F-005'], `grouped: ${group.join(', ')} (F-004 keeps its coverage path)`);
    // The refused duplicate as the primary: the others join it.
    const asPrimary = api(nextDriver, 'groupedFindingRepairIds')({ root, store, gitCwd: root, storyId, primary: { id: `${storyId}:F-002` }, primaryBound: false, findings: open, runs: [] }) as string[];
    assert.deepEqual(asPrimary.map(id => id.split(':')[1]), ['F-002', 'F-003', 'F-005']);
  } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
});

await check('A2 a regression-tagged finding of a resolved target is never offered the duplicate-coverage path; an untagged duplicate of a resolved canonical still is', () => {
  const { root, store, storyId, findings } = groupStore();
  try {
    const candidate = (n: number) => (duplicates.duplicateResolveCandidate(store, storyId, findings.find(row => row.id === `${storyId}:F-00${n}`)!, findings))?.canonical.id ?? null;
    assert.equal(candidate(4), `${storyId}:F-001`, 'an untagged duplicate keeps the coverage path');
    assert.equal(candidate(2), null, 'a refused coverage check sends it to repair (unchanged)');
    assert.equal(candidate(5), null, 'a regression-of a resolved finding goes to repair, not to duplicate coverage');
  } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
});

await check('A3 a regression-tagged finding whose target is still open is held back like any duplicate of an open canonical', () => {
  const { root, store, storyId, findings } = groupStore();
  try {
    const rows = findings.map(row => (row.id === `${storyId}:F-001` ? { ...row, status: 'open' } : row)) as Finding[];
    assert.equal(duplicates.duplicateOfOpenCanonical(store, storyId, `${storyId}:F-005`, rows), true);
  } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// B. family-complete brief for a regression-of finding

const KV = ['package kv', '', 'type Store struct{ m map[string]int }', '',
  'func (s *Store) Put(k string, v int) { s.m[k] = v }', ''].join('\n');
const KV_REPAIRED = ['package kv', '', 'type Store struct{ m map[string]int }', '',
  'func (s *Store) Put(k string, v int) { s.m[k] = v }', '// REPAIR_MARKER_LINE: write back through the resolved target once', ''].join('\n');

await check('B the repair prompt of a [regression-of F-x] finding carries the earlier repair diff and repro and asks for one family test over every call site / target shape', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run73-brief-')));
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'Bench Owner']);
    git(root, ['config', 'user.email', 'owner@bench.invalid']);
    write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }, null, 2));
    write(root, 'kv/kv.go', KV);
    commit(root, 'baseline');
    write(root, 'kv/kv.go', KV_REPAIRED);
    const repair = commit(root, 'B-73b1 F-001: resolve finding');
    resetConfigCache();
    const store = new StoryStore(root);
    const storyId = 'B-73b1';
    store.writeStory(storyId, { storyId, name: 'kv', title: 'Kv', description: 'Kv.', type: 'feature', phase: 'DEV', priority: 'high',
      createdAt: NOW, startedAt: NOW, endedAt: null, events: [] } as unknown as StoryInfo);
    store.writeChecklist(storyId, { items: [] } as ChecklistData);
    const f = (n: number, status: string, desc: string, extra: Record<string, unknown> = {}) => ({ id: `${storyId}:F-00${n}`, severity: 'medium', category: 'edge', desc, files: ['kv/kv.go'],
      status, evidenceState: 'verified', agent: 'proof-or-stop-review-quality', createdAt: NOW, ...extra });
    store.writeFindings(storyId, { findings: [
      f(1, 'resolved', 'put through a nested target is a silent no-op. Repro: `m["a"]["b"] = v`', { resolutionType: 'fixed', resolvedAt: NOW,
        resolvedReason: `Framework-verified repair of ${storyId}:F-001: material commit ${repair.slice(0, 12)} of managed finding-repair run run-1.` }),
      f(2, 'open', '[regression-of F-001] a computed selector in the nested target is evaluated twice. Repro: `m[next()]["b"] = v`'),
    ] } as never);
    const prompt = (createStoryDispatchHandlers({ store, root, scanRoot: root } as never).dispatch({ storyId, agentType: 'proof-or-stop-finding-repair', findingId: 'F-002' }) as { prompt: string }).prompt;
    assert.match(prompt, /REPAIR_MARKER_LINE/, 'the earlier repair\'s diff is in the prompt');
    assert.match(prompt, /m\["a"\]\["b"\] = v/, 'the earlier finding\'s repro is in the prompt');
    assert.match(prompt, /every call site and every target shape/i, 'one test over every call site / target shape of the mechanism');
    assert.match(prompt, /\[family-test\]/, 'the final report lists the covered shapes');
    // A finding that is not a regression gets no such block.
    store.writeFindings(storyId, { findings: [f(1, 'open', 'put through a nested target is a silent no-op.')] } as never);
    const plain = (createStoryDispatchHandlers({ store, root, scanRoot: root } as never).dispatch({ storyId, agentType: 'proof-or-stop-finding-repair', findingId: 'F-001' }) as { prompt: string }).prompt;
    assert.doesNotMatch(plain, /\[family-test\]/, 'no family-test block for a plain finding');
    // The grouped section of host_run carries the same brief for a regression-tagged member.
    const brief = await load('../core/regression-family-brief.js', 'regressionFamilyBrief');
    store.writeFindings(storyId, { findings: [
      f(1, 'resolved', 'put through a nested target is a silent no-op. Repro: `m["a"]["b"] = v`', { resolutionType: 'fixed', resolvedAt: NOW, resolvedReason: `material commit ${repair.slice(0, 12)}` }),
      f(2, 'open', '[regression-of F-001] a computed selector in the nested target is evaluated twice. Repro: `m[next()]["b"] = v`')] } as never);
    const lines = brief({ findings: store.readFindings(storyId).findings, storyId, finding: store.readFindings(storyId).findings[1], gitCwd: root }) as string[];
    assert.match(lines.join('\n'), /REPAIR_MARKER_LINE/);
  } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// D. row-vs-request audit

const REQUEST = [
  'Add `pick(list, i)` to the list package.',
  '`pick([1,2,3], -1)` returns `3`.',
  'Negative positions count from the end of the list.',
  'An empty list reports an error.',
].join('\n');
const row = (desc: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story', ...extra });
const auditItem = (rows: Array<Record<string, unknown>>): ChecklistItem => ({ id: 'CHK-001', title: 'pick', status: 'pending',
  verificationIntent: { happy: rows, edge: [], adversarial: [] } } as unknown as ChecklistItem);

await check('D1 a pin whose case a request example states with another value is listed with the request sentence; an agreeing pin and a different input are not', async () => {
  const findingsOf = await load('../core/request-pin-audit.js', 'requestPinFindings');
  const wrong = auditItem([row('`pick([1,2,3], -1)` -> `1`', { derivation: { requestQuote: 'Negative positions count from the end of the list.', computation: 'base counterpart clamps a negative position to 0, so 1' } })]);
  const listed = findingsOf([wrong], REQUEST) as Array<{ ref: string; kind: string; sentence: string }>;
  assert.equal(listed.length, 1, JSON.stringify(listed));
  assert.equal(listed[0]!.ref, 'CHK-001:happy:0');
  assert.equal(listed[0]!.kind, 'contradiction');
  assert.match(listed[0]!.sentence, /pick\(\[1,2,3\], -1\)` returns `3`/, 'the deciding request sentence is quoted');
  assert.deepEqual(findingsOf([auditItem([row('`pick([1,2,3], -1)` -> `3`')])], REQUEST), [], 'an agreeing pin is not listed');
  assert.deepEqual(findingsOf([auditItem([row('`pick([4,5], -1)` -> `1`')])], REQUEST), [], 'another input is not judged by that example');
  assert.deepEqual(findingsOf([wrong], null), [], 'no request, no audit');
});

await check('D2 a row changed since the scope verdict whose derivation does not quote the request sentence nearest its case is listed; quoting it clears it', async () => {
  const findingsOf = await load('../core/request-pin-audit.js', 'requestPinFindings');
  const changed = new Set(['CHK-001:happy:0']);
  const unquoted = auditItem([row('`pick([1,2,3], -2)` with a negative position clamps -> `1`', { derivation: { requestQuote: 'Add `pick(list, i)` to the list package.', computation: 'the base counterpart clamps, giving 1' } })]);
  const listed = findingsOf([unquoted], REQUEST, { changedRefs: changed }) as Array<{ ref: string; kind: string; sentence: string }>;
  assert.equal(listed.length, 1, JSON.stringify(listed));
  assert.equal(listed[0]!.kind, 'unquoted_sentence');
  assert.match(listed[0]!.sentence, /Negative positions count from the end/);
  assert.deepEqual(findingsOf([unquoted], REQUEST), [], 'a row not changed since the verdict is not audited for its quote');
  const quoted = auditItem([row('`pick([1,2,3], -2)` with a negative position counts from the end -> `2`', { derivation: { requestQuote: 'Negative positions count from the end of the list.', computation: 'index -2 of 3 items is 1, value 2' } })]);
  assert.deepEqual(findingsOf([quoted], REQUEST, { changedRefs: changed }), [], 'the deciding sentence is quoted');
});

await check('D3 the audit is offered once per set of rows (skippable, evidence only)', async () => {
  const due = await load('../core/request-pin-audit.js', 'requestPinOfferDue');
  const record = await load('../core/request-pin-audit.js', 'recordRequestPinOffer');
  const findingsOf = await load('../core/request-pin-audit.js', 'requestPinFindings');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run73-offer-')));
  try {
    const rows = findingsOf([auditItem([row('`pick([1,2,3], -1)` -> `1`')])], REQUEST) as unknown[];
    assert.equal(due(root, 'B-73d1', rows), true);
    record(root, 'B-73d1', rows);
    assert.equal(due(root, 'B-73d1', rows), false, 'the same set is not offered again');
    assert.equal(due(root, 'B-73d1', []), false, 'nothing listed, nothing offered');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await check('D4 the owner-facing blocker step asks for the request sentence that decides each row it adds or changes', () => {
  const step = api(nextDriver, 'storyReviewBlockersStep')({ storyId: 'B-73d2', phase: 'PLAN' }, 'Cannot enter DEV: blockers',
    [{ type: 'scope_gap', message: 'Precedent conflict: pick, negative position: clamp vs from-the-end' }]) as { why: string };
  assert.match(step.why, /quote the request sentence that decides the case/i, 'the rule is in the step');
  assert.match(step.why, /base counterpart/i, 'a base-counterpart derivation only when no request sentence speaks');
});

// ---------------------------------------------------------------------------
// E. one invocation for the resolved-finding guards

const KV_BASE = ['package kv', '', 'type L struct{ v []int }', '', 'func (l *L) At(i int) int {', '\tif i < 0 {', '\t\ti += len(l.v)', '\t}', '\treturn l.v[i]', '}', ''];

function guardFixture(): { root: string; store: StoryStore; findings: Finding[]; storyId: string; head: string; repairs: string[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run73-guard-')));
  const storyId = 'B-73e1';
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }, null, 2));
  write(root, 'go.mod', 'module example.com/kv\n\ngo 1.21\n');
  write(root, 'kv/kv.go', KV_BASE.join('\n'));
  write(root, 'kv/kv_test.go', 'package kv\n\nimport "testing"\n\nfunc TestBaseline(t *testing.T) {}\n');
  commit(root, 'baseline');
  const repairs: string[] = [];
  for (const n of [1, 2, 3]) {
    write(root, 'kv/kv.go', [...KV_BASE, `// repair ${n}`, ''].join('\n'));
    write(root, 'kv/kv_test.go', [readFileSync(join(root, 'kv/kv_test.go'), 'utf8'), `func TestAt${n}(t *testing.T) {`, '\tl := &L{v: []int{1, 2, 3}}', n === 2 ? '\tif l.At(-2) != 2 {' : '\tif l.At(-1) != 3 {', '\t\tt.Fatal("at")', '\t}', '}', ''].join('\n'));
    repairs.push(commit(root, `${storyId} F-00${n}: resolve finding`));
  }
  resetConfigCache();
  const store = new StoryStore(root);
  const f = (n: number, status: string, extra: Record<string, unknown> = {}) => ({ id: `${storyId}:F-00${n}`, severity: 'medium', category: 'edge', desc: n === 4 ? 'Len is missing. Repro: `l.Len()`' : `At of a negative index ${n}. Repro: \`l.At(${n === 2 ? -2 : -1})\``,
    files: ['kv/kv.go'], status, evidenceState: 'verified', agent: 'proof-or-stop-review-quality', createdAt: NOW, ...extra });
  const findings = [1, 2, 3].map(n => f(n, 'resolved', { resolutionType: 'fixed', resolvedAt: NOW, resolvedReason: `Framework-verified repair of ${storyId}:F-00${n}: material commit ${repairs[n - 1]!.slice(0, 12)} of managed finding-repair run run-${n}.` }))
    .concat([f(4, 'open')]) as unknown as Finding[];
  write(root, 'kv/kv.go', [...KV_BASE, '// repair 4', 'func (l *L) Len() int { return len(l.v) }', ''].join('\n'));
  const head = commit(root, `${storyId} F-004: resolve finding`);
  return { root, store, findings, storyId, head, repairs };
}

/** A `go` shim on PATH that logs every `go test` invocation and delegates to the real toolchain. */
function goShim(): { dir: string; log: string; restore: () => void; calls: () => string[] } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'run73-shim-')));
  const log = join(dir, 'calls.log');
  const real = execFileSync('/bin/sh', ['-c', 'command -v go'], { encoding: 'utf8' }).trim();
  write(dir, 'go', `#!/bin/sh\necho "$@" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(dir, 'go'), 0o755);
  writeFileSync(log, '');
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  return { dir, log, restore: () => { process.env.PATH = before; rmSync(dir, { recursive: true, force: true }); },
    calls: () => readFileSync(log, 'utf8').split('\n').filter(line => /^test\b/.test(line)) };
}

const guardArgs = (fx: ReturnType<typeof guardFixture>, guardModule: object, repairCommit: string, memory: { store: unknown }) => ({ store: memory.store, projectRoot: fx.root, gitCwd: fx.root, storyId: fx.storyId,
  findings: fx.findings, repairs: [{ findingId: `${fx.storyId}:F-004`, commit: repairCommit }],
  repairCommitOf: (finding: Finding) => api(guardModule, 'repairCommitFromResolution')(fx.root, finding), coverageOf: () => null, headHash: repairCommit, materialHash: null });
const memoryEvents = () => {
  const events: Array<Record<string, unknown>> = [];
  return { events, store: { readProcessEvents: () => events, appendProcessEvent: (_id: string, event: Record<string, unknown>) => { events.push(event); } } };
};

await check('E1 the passing resolved-finding guards run in ONE go test invocation; the recorded decisions are unchanged', async () => {
  const guardModule = await import('../core/resolved-finding-guard.js') as object;
  const fx = guardFixture();
  const shim = goShim();
  try {
    const memory = memoryEvents();
    const out = api(guardModule, 'regressionGuardCheck')(guardArgs(fx, guardModule, fx.head, memory)) as unknown[];
    assert.deepEqual(out, [], 'every guard passes');
    const passed = memory.events.filter(event => event.type === 'resolved_finding_guard_checked' && event.passed === true).map(event => String(event.findingId).split(':')[1]).sort();
    assert.deepEqual(passed, ['F-001', 'F-002', 'F-003'], `one passing event per guarded finding: ${JSON.stringify(memory.events.map(event => [event.findingId, event.passed]))}`);
    assert.equal(shim.calls().length, 1, `one go test invocation for three guards (got ${shim.calls().length}): ${shim.calls().join(' | ')}`);
    // A pass on the same material is reused: no further run.
    api(guardModule, 'regressionGuardCheck')(guardArgs(fx, guardModule, fx.head, memory));
    assert.equal(shim.calls().length, 1, 'reused on the same head');
  } finally { shim.restore(); rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

await check('E2 when one guard fails the others keep their own pass and the failing one its own blame (per-finding fallback, same decisions)', async () => {
  const guardModule = await import('../core/resolved-finding-guard.js') as object;
  const fx = guardFixture();
  const shim = goShim();
  try {
    // The Story's last repair breaks only F-002's case (index -2); F-001 / F-003 (index -1) still hold.
    write(fx.root, 'kv/kv.go', ['package kv', '', 'type L struct{ v []int }', '', 'func (l *L) At(i int) int {', '\tif i == -2 {', '\t\treturn 0', '\t}', '\tif i < 0 {', '\t\ti += len(l.v)', '\t}', '\treturn l.v[i]', '}', ''].join('\n'));
    const breaking = commit(fx.root, `${fx.storyId} F-004: resolve finding (breaks one case)`);
    const memory = memoryEvents();
    const out = api(guardModule, 'regressionGuardCheck')(guardArgs(fx, guardModule, breaking, memory)) as Array<{ guarded: Finding; blamed: Array<{ findingId: string }> }>;
    assert.deepEqual(out.map(row => row.guarded.id.split(':')[1]), ['F-002'], `only F-002 fails: ${JSON.stringify(memory.events.map(event => [event.findingId, event.passed]))}`);
    assert.deepEqual(out[0]!.blamed.map(row => row.findingId), [`${fx.storyId}:F-004`], 'the breaking repair is blamed');
    const byFinding = Object.fromEntries(memory.events.filter(event => event.type === 'resolved_finding_guard_checked').map(event => [String(event.findingId).split(':')[1], event.passed]));
    assert.deepEqual(byFinding, { 'F-001': true, 'F-002': false, 'F-003': true }, 'each finding keeps its own decision');
  } finally { shim.restore(); rmSync(fx.root, { recursive: true, force: true }); resetConfigCache(); }
});

if (failures.length) {
  console.error(`run73-fixes-smoke: FAIL (${failures.length}: ${failures.join('; ')})`);
  process.exit(1);
}
console.log('run73-fixes-smoke: PASS');
