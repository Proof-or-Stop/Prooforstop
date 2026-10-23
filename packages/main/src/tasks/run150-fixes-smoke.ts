#!/usr/bin/env node
/**
 * Lab group-conflict-blame (old-PoS run 150, Story B-9985): unit level, with real git repositories and real `go test` runs.
 * Generic toy package only (`rng.Sel(lo, hi, step)` over [1 2 3 4]; `Nil` is an explicit null end, step 0 a two-part
 * range); no benchmark-task material.
 *
 * Run 150: resolved F-001's repair made an explicit null end mean an omitted end, for stepped ranges too, and its covering
 * test pinned that. One grouped round-3 repair committed F-007 (fe24f7e, aliasing), F-008 (ae048e0, step overflow) and
 * F-009 (133f9f8 + c7c1951: a stepped null end errors, as the request wants; it genuinely contradicts F-001's test). The
 * guard of F-001 failed at the batch acceptance and blamed EVERY repair whose commit touched F-001's cited file
 * (resolved-finding-guard.ts regressionGuardCheck `blamed`), so all three were rejected, findingConflictOf returned
 * `rejected` for each, finding_conflict_pin listed three conflicts, and all three were re-repaired (~33 min, past the
 * run's timeout). Only F-009 conflicts with F-001.
 *
 *   B. Per-member blame (switch remediation.groupConflictBlame, default on): when a failed guard blames two or more repairs
 *      whose commits are separable (one linear chain, each after the guard's snapshot), the framework re-runs the guard's
 *      recorded test at the member commits, latest first; at the newest commit where it passes, every member whose commit
 *      is that commit or before it is cleared (its work is proven not to break the guard) and only the later members stay
 *      blamed. Event `blameAttribution` (implicated, cleared, greenAt, checked).
 *   Ambiguous (fail closed, current behaviour): one shared commit; no member commit where the guard passes (the culprit
 *      is first); a non-linear set of commits. The newest member is never cleared, so attribution never empties a blame.
 *   Security: only executed git commits and the guard's recorded test decide; commit labels can only move blame between
 *      members, never drop the regression (a breaking change labelled with an innocent member's id blames that label; a
 *      breaking commit after every member commit stays on the newest member). No report text, resolution text or
 *      [intent-conflict] line is read.
 *   Dry run: the managed regression check names the implicated member(s) in its resumed-turn prompt.
 *
 * Usage: node packages/main/dist/tasks/run150-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resetConfigCache } from '../core/config.js';
import type { Finding } from '../core/types.js';

type Fn = (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
const loadModule = async (path: string): Promise<object> => { try { return await import(path) as object; } catch { return {}; } };
const guardModule = await loadModule('../core/resolved-finding-guard.js');
const api = (module: object, name: string): Fn => {
  const fn = (module as Record<string, unknown>)[name];
  assert.equal(typeof fn, 'function', `${name} is exported`);
  return fn as Fn;
};
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error)}`); }
}
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const commit = (root: string, message: string): string => { git(root, ['add', '-A']); git(root, ['commit', '-qm', message]); return git(root, ['rev-parse', 'HEAD']); };

// ---------------------------------------------------------------------------
// Toy Go package

const STORY = 'B-150a';
const F = (n: number): string => `${STORY}:F-${String(n).padStart(3, '0')}`;
const NOW = '2026-10-23T08:00:00.000Z';

/** The three independent fixes of the grouped repair. */
interface Fix { nil: 'error' | 'omitted' | 'stepped-error'; clamp: boolean; overflow: boolean }
const selFn = (o: Fix): string => ['package rng', '', 'import "fmt"', '', '// Nil marks an explicit null end.', 'const Nil = -1 << 31', '',
  '// Huge is the largest int step.', 'const Huge = int(^uint(0) >> 1)', '',
  '// Sel selects xs[lo:hi:step] of [1 2 3 4] (step 0: a two-part range).', 'func Sel(lo, hi, step int) string {', '\txs := []int{1, 2, 3, 4}',
  ...(o.nil === 'error' ? ['\tif hi == Nil {', '\t\treturn "error"', '\t}']
    : o.nil === 'omitted' ? ['\tif hi == Nil {', '\t\thi = len(xs)', '\t}']
    : ['\tif hi == Nil && step != 0 {', '\t\treturn "error"', '\t}', '\tif hi == Nil {', '\t\thi = len(xs)', '\t}']),
  ...(o.clamp ? ['\tif hi > len(xs) {', '\t\thi = len(xs)', '\t}'] : []),
  '\tif step == 0 {', '\t\tstep = 1', '\t}', '\tout := []int{}', '\tfor i := lo; i < hi; i += step {', '\t\tout = append(out, xs[i])',
  ...(o.overflow ? ['\t\tif step > hi-i {', '\t\t\tbreak', '\t\t}'] : []), '\t}', '\treturn fmt.Sprint(out)', '}', ''].join('\n');

const ROW_PAIR = '{"Sel(0, 2, 0)", Sel(0, 2, 0), "[1 2]"}';
const ROW_NIL_TWO = '{"Sel(1, Nil, 0)", Sel(1, Nil, 0), "[2 3 4]"}';
const ROW_NIL_STEP = '{"Sel(1, Nil, 2)", Sel(1, Nil, 2), "[2 4]"}';
const ROW_NIL_STEP_ERROR = '{"Sel(1, Nil, 2)", Sel(1, Nil, 2), "error"}';
const tableTest = (rows: string[]): string => ['package rng', '', 'import "testing"', '', 'func TestSel(t *testing.T) {', '\ttests := []struct {', '\t\tname string', '\t\tgot  string', '\t\twant string', '\t}{',
  ...rows.map(row => `\t\t${row},`), '\t}', '\tfor _, tt := range tests {', '\t\tif tt.got != tt.want {', '\t\t\tt.Errorf("%s: got %s, want %s", tt.name, tt.got, tt.want)', '\t\t}', '\t}', '}', ''].join('\n');
const oneTest = (name: string, call: string, want: string): string => ['package rng', '', 'import "testing"', '', `func ${name}(t *testing.T) {`,
  `\tif got := ${call}; got != "${want}" {`, `\t\tt.Fatalf("${call.replace(/"/g, '\\"')}: got %s", got)`, '\t}', '}', ''].join('\n');

/** F-001 states its case in prose only: its guard is scope `functions` (every row of TestSel as its repair wrote it), as in run 150. */
const F1_DESC = 'rng/rng.go:12: Sel rejects an explicit Nil end in a two-part range where the base treated it as omitted, for example Sel(1, Nil, 0) errors instead of [2 3 4].';
const F7_DESC = 'rng/rng.go:15: an end past the length panics. Repro: `Sel(1, 9, 0)` panics, want [2 3 4].';
const F8_DESC = 'rng/rng.go:20: a huge step overflows the index. Repro: `Sel(1, 4, Huge)` panics, want [2].';
const F9_DESC = 'rng/rng.go:12: a stepped range treats an explicit Nil end as omitted; the request wants an error. Repro: `Sel(1, Nil, 2)` returns [2 4], want error.';

/** One member's commit: the product state after it and its own test file. */
type Member = 7 | 8 | 9;
const MEMBER_TEST: Record<Member, { file: string; text: string }> = {
  7: { file: 'rng/clamp_test.go', text: oneTest('TestSelClamp', 'Sel(1, 9, 0)', '[2 3 4]') },
  8: { file: 'rng/step_test.go', text: oneTest('TestSelHugeStep', 'Sel(1, 4, Huge)', '[2]') },
  9: { file: 'rng/stepnil_test.go', text: oneTest('TestSelStepNil', 'Sel(1, Nil, 2)', 'error') },
};

interface Fx { root: string; base: string; repair1: string; commits: Record<string, string>; head: string }

/**
 * Base (no Sel), the Story's DEV commit (Nil errors), resolved F-001's repair (Nil = omitted everywhere, TestSel pins the
 * stepped row too), then the grouped repair: one commit per member in `order` (each applies that member's fix and adds its
 * test; F-009 also re-pins F-001's stepped row). `label` overrides the id a commit message names (abuse checks); `shared`
 * makes ONE commit naming every member; `trailing` adds an unnamed commit after the members.
 */
function fixture(opts: { order?: Member[]; label?: Partial<Record<Member, string>>; shared?: boolean; trailing?: Fix; harmless9?: boolean } = {}): Fx {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run150-rng-')));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  write(root, 'go.mod', 'module example.com/rng\n\ngo 1.21\n');
  write(root, 'rng/doc.go', 'package rng\n');
  const base = commit(root, 'baseline');
  write(root, 'rng/rng.go', selFn({ nil: 'error', clamp: false, overflow: false }));
  write(root, 'rng/rng_test.go', tableTest([ROW_PAIR]));
  commit(root, `${STORY} CHK-001: Sel`);
  write(root, 'rng/rng.go', selFn({ nil: 'omitted', clamp: false, overflow: false }));
  write(root, 'rng/rng_test.go', tableTest([ROW_PAIR, ROW_NIL_TWO, ROW_NIL_STEP]));
  const repair1 = commit(root, `${STORY} F-001: resolve finding`);
  const state: Fix = { nil: 'omitted', clamp: false, overflow: false };
  const apply = (member: Member): void => {
    if (member === 7) state.clamp = true;
    if (member === 8) state.overflow = true;
    if (member === 9 && !opts.harmless9) {
      state.nil = 'stepped-error';
      write(root, 'rng/rng_test.go', tableTest([ROW_PAIR, ROW_NIL_TWO, ROW_NIL_STEP_ERROR]));
    }
    write(root, 'rng/rng.go', `${selFn(state)}${member === 9 && opts.harmless9 ? '\n// Sel keeps an explicit Nil end as omitted.\n' : ''}`);
    if (member !== 9 || !opts.harmless9) write(root, MEMBER_TEST[member].file, MEMBER_TEST[member].text);
    else write(root, 'rng/note_test.go', 'package rng\n');
  };
  const commits: Record<string, string> = {};
  const order = opts.order ?? [7, 8, 9];
  if (opts.shared) {
    for (const member of order) apply(member);
    const sha = commit(root, `${STORY} ${order.map(member => `F-00${member}`).join(' ')}: resolve findings`);
    for (const member of order) commits[F(member)] = sha;
  } else {
    for (const member of order) {
      apply(member);
      commits[F(member)] = commit(root, `${STORY} ${opts.label?.[member] ?? `F-00${member}`}: resolve finding`);
    }
  }
  if (opts.trailing) {
    write(root, 'rng/rng.go', selFn(opts.trailing));
    commit(root, 'tidy');
  }
  return { root, base, repair1, commits, head: git(root, ['rev-parse', 'HEAD']) };
}
const finding = (n: number, desc: string, files: string[], extra: Partial<Finding> = {}): Finding => ({ id: F(n), desc, severity: 'medium', category: 'edge', status: 'open',
  evidenceState: 'verified', agent: 'proof-or-stop-review-quality', createdAt: NOW, files, ...extra } as Finding);
const resolvedF1 = (fx: Fx): Finding => finding(1, F1_DESC, ['rng/rng.go'], { status: 'resolved', resolutionType: 'fixed', resolvedAt: NOW,
  resolvedReason: `Repaired. [repair commit ${fx.repair1.slice(0, 12)} of managed finding-repair run run-1]` });
const members = (): Finding[] => [finding(7, F7_DESC, ['rng/rng.go']), finding(8, F8_DESC, ['rng/rng.go']), finding(9, F9_DESC, ['rng/rng.go'])];
const memoryEvents = () => {
  const events: Array<Record<string, unknown>> = [];
  return { events, store: { readProcessEvents: () => events, appendProcessEvent: (_id: string, event: Record<string, unknown>) => { events.push(event); } } };
};
type GuardFailure = { guarded: Finding; result: { passed: boolean; command: string }; blamed: Array<{ findingId: string; commit: string }> };
/** finding_resolve's guard as handlers/finding.ts calls it, with the framework-bound member commits as the repairs. */
function guardCheck(fx: Fx, repairs: Array<{ findingId: string; commit: string }>, opts: { groupConflictBlame?: boolean } = {}) {
  const memory = memoryEvents();
  const out = api(guardModule, 'regressionGuardCheck')({ store: memory.store, projectRoot: fx.root, gitCwd: fx.root, storyId: STORY, findings: [resolvedF1(fx), ...members()], repairs,
    repairCommitOf: (row: Finding) => api(guardModule, 'repairCommitFromResolution')(fx.root, row), coverageOf: () => null,
    headHash: fx.head, materialHash: null, baseRef: fx.base, sanctionCommitOf: () => null,
    ...(opts.groupConflictBlame === undefined ? {} : { groupConflictBlame: opts.groupConflictBlame }) }) as GuardFailure[];
  return { out, events: memory.events };
}
const batch = (fx: Fx, ids: Member[] = [7, 8, 9]) => ids.map(member => ({ findingId: F(member), commit: fx.commits[F(member)]! }));
const guardEvent = (events: Array<Record<string, unknown>>, id: string) => events.filter(event => event.type === 'resolved_finding_guard_checked' && event.findingId === id).at(-1);
const f1Failure = (out: GuardFailure[]) => out.find(row => row.guarded.id === F(1));
const blamedIds = (out: GuardFailure[]) => (f1Failure(out)?.blamed ?? []).map(row => row.findingId).sort();
const cleanup = (fx: Fx): void => rmSync(fx.root, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// B. The run-150 shape

await check('B1 run 150: F-001\'s guard fails after the grouped repair F-007 -> F-008 -> F-009; only F-009 (whose commit breaks it) is blamed; F-007 and F-008 are cleared by the guard passing at F-008\'s commit', () => {
  const fx = fixture();
  try {
    const { out, events } = guardCheck(fx, batch(fx));
    assert.ok(f1Failure(out), `F-001's guard still fails (the regression stays open): ${JSON.stringify(events.map(event => [event.findingId, event.passed]))}`);
    assert.deepEqual(blamedIds(out), [F(9)], `only F-009 is blamed: ${JSON.stringify(guardEvent(events, F(1)))}`);
    const event = guardEvent(events, F(1));
    assert.deepEqual(event?.rejectedRepairs, [{ findingId: F(9), commit: fx.commits[F(9)] }], 'only F-009\'s repair is rejected');
    const attribution = event?.blameAttribution as { implicated?: string[]; cleared?: string[]; greenAt?: string } | undefined;
    assert.deepEqual(attribution?.implicated, [F(9)]);
    assert.deepEqual(attribution?.cleared, [F(7), F(8)]);
    assert.equal(attribution?.greenAt, fx.commits[F(8)], 'the evidence names the commit where the recorded test passes');
    // Downstream: findingConflictOf (finding_conflict_pin / settle) and the repair state read rejectedRepairs only.
    const rejected = api(guardModule, 'rejectedRepairCommits')(events) as Map<string, unknown>;
    assert.deepEqual([...rejected.keys()], [F(9)], 'only F-009 goes to the conflict path');
    const conflictOf = api(guardModule, 'findingConflictOf');
    const all = [resolvedF1(fx), ...members()];
    assert.equal(conflictOf({ finding: all[1], findings: all, storyId: STORY, rejected }), null, 'F-007 is no conflict');
    assert.equal(conflictOf({ finding: all[2], findings: all, storyId: STORY, rejected }), null, 'F-008 is no conflict');
    assert.equal(conflictOf({ finding: all[3], findings: all, storyId: STORY, rejected })?.resolvedId, F(1), 'F-009 conflicts with F-001');
    const desc = api(guardModule, 'regressionFindingDesc')({ storyId: STORY, guarded: f1Failure(out)!.guarded, result: f1Failure(out)!.result, blamed: f1Failure(out)!.blamed }) as string;
    assert.match(desc, /^\[regression-of F-001\] the repair of F-009 \(commit [0-9a-f]{12}\) broke/);
  } finally { cleanup(fx); }
});

await check('B2 middle culprit (F-007 -> F-009 -> F-008): F-007 is cleared; F-009 and the later F-008 stay blamed (nothing after the breaking commit is ever cleared)', () => {
  const fx = fixture({ order: [7, 9, 8] });
  try {
    const { out, events } = guardCheck(fx, batch(fx));
    assert.deepEqual(blamedIds(out), [F(8), F(9)], JSON.stringify(guardEvent(events, F(1))?.blameAttribution) ?? 'no attribution');
  } finally { cleanup(fx); }
});

// ---------------------------------------------------------------------------
// Ambiguous: the current safe behaviour

await check('B3 ambiguous: the culprit is first (F-009 -> F-007 -> F-008): no member commit passes the guard, every member stays blamed', () => {
  const fx = fixture({ order: [9, 7, 8] });
  try {
    const { out, events } = guardCheck(fx, batch(fx));
    assert.deepEqual(blamedIds(out), [F(7), F(8), F(9)]);
    assert.equal(guardEvent(events, F(1))?.blameAttribution, undefined, 'no attribution recorded');
  } finally { cleanup(fx); }
});

await check('B4 ambiguous: one shared commit naming every member is not separable: every member stays blamed', () => {
  const fx = fixture({ shared: true });
  try {
    const { out } = guardCheck(fx, batch(fx));
    assert.deepEqual(blamedIds(out), [F(7), F(8), F(9)]);
  } finally { cleanup(fx); }
});

// ---------------------------------------------------------------------------
// Security: commit labels move blame between members at most; the regression is never dropped

await check('B5 security: a breaking change bundled under an innocent member\'s label is blamed on that label (the commit that broke it), never cleared; the regression stays open', () => {
  // The F-009 change is committed as "F-007", the clamp fix as "F-009".
  const fx = fixture({ order: [8, 7, 9], label: { 7: 'F-009', 9: 'F-007' } });
  try {
    const repairs = [{ findingId: F(8), commit: fx.commits[F(8)]! }, { findingId: F(9), commit: fx.commits[F(7)]! }, { findingId: F(7), commit: fx.commits[F(9)]! }];
    const { out } = guardCheck(fx, repairs);
    assert.ok(f1Failure(out), 'the regression stays');
    assert.deepEqual(f1Failure(out)!.blamed.map(row => row.commit), [fx.commits[F(9)]], 'the commit that broke the guard is the one blamed');
  } finally { cleanup(fx); }
});

await check('B6 security: a breaking commit after every member commit (unnamed) is never cleared away: the newest member stays blamed and the regression stays open', () => {
  const fx = fixture({ harmless9: true, trailing: { nil: 'stepped-error', clamp: true, overflow: true } });
  try {
    const { out, events } = guardCheck(fx, batch(fx));
    assert.ok(f1Failure(out), `the regression stays: ${JSON.stringify(guardEvent(events, F(1)))}`);
    assert.ok(blamedIds(out).length >= 1, 'attribution never empties the blame');
    assert.ok(blamedIds(out).includes(F(9)), 'the newest member is never cleared');
  } finally { cleanup(fx); }
});

// ---------------------------------------------------------------------------
// Dry run: the managed repair regression check names the implicated member

await check('B7 the managed regression check (dry run) of the grouped run names F-009 as implicated and F-007, F-008 as cleared in its resumed-turn prompt', async () => {
  const fx = fixture();
  try {
    const check = await import('../core/repair-regression-check.js') as unknown as { repairRegressionFailures: Fn; repairRegressionFollowUp: Fn };
    const dry = check.repairRegressionFailures({ projectRoot: fx.root, gitCwd: fx.root, storyId: STORY, findings: [resolvedF1(fx), ...members()], items: [],
      findingIds: [F(7), F(8), F(9)], launchHead: fx.repair1, events: [], baseRef: fx.base }) as { failures: Array<{ id: string; implicated?: string[]; cleared?: string[] }> };
    const f1 = dry.failures.find(row => row.id === F(1));
    assert.ok(f1, `F-001 still reported: ${JSON.stringify(dry.failures)}`);
    assert.deepEqual(f1!.implicated, [F(9)], JSON.stringify(f1));
    assert.deepEqual(f1!.cleared, [F(7), F(8)]);
    const prompt = check.repairRegressionFollowUp(dry.failures, [F(7), F(8), F(9)]) as string;
    assert.match(prompt, /resolved finding F-001/);
    assert.match(prompt, /F-009/);
    assert.match(prompt, /F-007, F-008/);
    assert.match(prompt, /\[intent-conflict\]/);
  } finally { cleanup(fx); }
});

// ---------------------------------------------------------------------------
// Switch

await check('B8 switch remediation.groupConflictBlame: default on, off = rollback (run 150 behaviour: every member blamed), malformed = on, read from the project config', async () => {
  const abVariants = await loadModule('../core/ab-variants.js') as Record<string, unknown>;
  const on = api(abVariants, 'groupConflictBlameOn');
  assert.equal(on({}), true);
  assert.equal(on({ remediation: { groupConflictBlame: 'off' } }), false);
  assert.equal(on({ remediation: { groupConflictBlame: 'maybe' } }), true);
  assert.deepEqual((abVariants.AB_VARIANT_FLAGS as Record<string, unknown>)['remediation.groupConflictBlame'], ['on', 'off']);
  const fx = fixture();
  try {
    assert.deepEqual(blamedIds(guardCheck(fx, batch(fx), { groupConflictBlame: false }).out), [F(7), F(8), F(9)], 'off: every member blamed, as in run 150');
    write(fx.root, 'proof-or-stop.config.json', JSON.stringify({ remediation: { groupConflictBlame: 'off' } }));
    resetConfigCache();
    assert.deepEqual(blamedIds(guardCheck(fx, batch(fx)).out), [F(7), F(8), F(9)], 'the project config switch is read when no explicit value is passed');
  } finally { cleanup(fx); resetConfigCache(); }
});

if (failures.length) {
  console.log(`run150-fixes-smoke: FAIL (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('run150-fixes-smoke: PASS');
