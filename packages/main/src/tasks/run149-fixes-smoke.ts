#!/usr/bin/env node
/**
 * Lab stale-cross-pin (old-PoS run 149, Story B-55bd): unit level, with real git repositories and real `go test` runs.
 * Generic toy package only (`rng.Set(lo, hi)` writes 9 into a fresh [0 0 0]; `Nil` is an explicit null end); no
 * benchmark-task material.
 *
 * Run 149: a grouped round-1 repair committed F-001 (342d333, an aliasing fix whose finding states no backticked repro,
 * so its guard is scope `functions`: every row of the touched test function, as that commit wrote it) and then F-002
 * (b2e3f66), whose fix changed what an explicit null end means and re-pinned the DEV row of that case in the SAME test
 * function. Both were resolved in one batch, and batch members are never guarded against each other, so F-001's guard
 * was born stale. In round 2 the test-only repair of F-003 touched none of F-001's files, yet the repair regression check
 * told it "your repair of F-003 broke F-001" (two resumed turns) and finding_resolve opened F-004 `[regression-of F-001]`
 * ("a later commit broke ..."), one more repair session that only changed tests.
 *
 *   S. Stale cross-finding pin (switch remediation.staleCrossPin, default on): a failing guard row of a case that a later
 *      framework-bound repair of a verified finding re-pinned (its commit removed the row's case line and added a line
 *      stating the case, and changed a product file the guard cites) is dropped from the recorded test source; when the
 *      rest of the recorded test passes on the current code the guard is excused (`excused: sanctioned_repair`): no
 *      blame, no `[regression-of]` finding, no resumed turn. At a batch acceptance a member whose repair commit precedes
 *      another member's is now guarded too, so the stale pin is caught where it is created.
 *   Controls (fail closed): a row the guarded finding's own repair wrote, or one stating its repro, is never dropped; a
 *      deleted-not-re-pinned row, a test-only "sanction", a sanction named only in resolution text, and a remaining
 *      failure on another row keep the regression; a grouped later commit that breaks an earlier member's own row is
 *      blamed at the batch acceptance.
 *
 * Usage: node packages/main/dist/tasks/run149-fixes-smoke.js
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

const STORY = 'B-149a';
const F = (n: number): string => `${STORY}:F-${String(n).padStart(3, '0')}`;
const NOW = '2026-10-23T03:00:00.000Z';

const setFn = (body: string[]): string => ['package rng', '', 'import "fmt"', '', '// Nil marks an explicit null end.', 'const Nil = -1 << 31', '',
  '// Set writes 9 into xs[lo:hi] of a fresh [0 0 0] and prints it.', 'func Set(lo, hi int) string {', '\txs := []int{0, 0, 0}', ...body, '\treturn fmt.Sprint(xs)', '}', ''].join('\n');
/** The Story's first cut: an explicit Nil end is an error; an end past the length panics (F-001). */
const V0 = setFn(['\tif hi == Nil {', '\t\treturn "error"', '\t}', '\tfor i := lo; i < hi; i++ {', '\t\txs[i] = 9', '\t}']);
/** F-001's repair: the end is clamped to the length. */
const V1 = setFn(['\tif hi == Nil {', '\t\treturn "error"', '\t}', '\tfor i := lo; i < hi && i < len(xs); i++ {', '\t\txs[i] = 9', '\t}']);
/** F-002's repair: an explicit Nil end means an omitted end. */
const V2 = setFn(['\tif hi == Nil {', '\t\thi = len(xs)', '\t}', '\tfor i := lo; i < hi && i < len(xs); i++ {', '\t\txs[i] = 9', '\t}']);
/** A later change that breaks F-001's own case (an end past the length now stops one short). */
const V2_BROKEN_CLAMP = setFn(['\tif hi == Nil {', '\t\thi = len(xs)', '\t}', '\tif hi > len(xs) {', '\t\thi = len(xs) - 1', '\t}', '\tfor i := lo; i < hi && i < len(xs); i++ {', '\t\txs[i] = 9', '\t}']);
/** A later change that breaks a pre-existing DEV case (Set(0, 2)) the guarded finding's repair did not write. */
const V2_BROKEN_PAIR = setFn(['\tif hi == Nil {', '\t\thi = len(xs)', '\t}', '\tif lo == 0 && hi == 2 {', '\t\thi = 1', '\t}', '\tfor i := lo; i < hi && i < len(xs); i++ {', '\t\txs[i] = 9', '\t}']);

const ROW_PAIR = '{"Set(0, 2)", Set(0, 2), "[9 9 0]"}';
const ROW_NIL_ERROR = '{"Set(0, Nil)", Set(0, Nil), "error"}';
const ROW_NIL_OMITTED = '{"Set(0, Nil)", Set(0, Nil), "[9 9 9]"}';
const ROW_CLAMP = '{"Set(1, 4)", Set(1, 4), "[0 9 9]"}';
const ROW_CLAMP_HIDDEN = '{"Set(1, 4)", Set(1, 4), "[0 9 0]"}';
const testFile = (rows: string[], extra: string[] = []): string => ['package rng', '', 'import "testing"', '',
  'func TestSet(t *testing.T) {', '\t_ = "^(x)$&$1" // a body with replacement patterns', '\ttests := []struct {', '\t\tname string', '\t\tgot  string', '\t\twant string', '\t}{',
  ...rows.map(row => `\t\t${row},`), '\t}', '\tfor _, tt := range tests {', '\t\tif tt.got != tt.want {', '\t\t\tt.Errorf("%s: got %s, want %s", tt.name, tt.got, tt.want)', '\t\t}', '\t}', '}', '', ...extra].join('\n');
const OTHER_TEST = ['func TestOther(t *testing.T) {', '\tif Set(2, 3) != "[0 0 9]" {', '\t\tt.Fatal("last")', '\t}', '}', ''];

/** F-001 states its case in prose only (no backticks): its guard is scope `functions`, as in run 149. */
const F1_DESC = 'rng/rng.go:12: Set writes past the end of xs when the end is past the length, for example Set(1, 4) panics instead of clamping to [0 9 9].';
const F2_DESC = 'rng/rng.go:10: an explicit Nil end now errors where an omitted end is meant. Repro: `Set(0, Nil)` returns error, want [9 9 9].';
const F3_DESC = 'rng/rng_test.go: the last index is never asserted alone. Repro: `Set(2, 3)`';

interface Fx { root: string; base: string; dev: string; repair1: string; repair2: string }

/** Base (no Set), the Story's DEV commit (V0 + DEV rows), F-001's repair (V1 + its own row), F-002's repair (V2 + the re-pinned Nil row). */
function fixture(opts: { repair2Test?: string; repair2Code?: string } = {}): Fx {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run149-rng-')));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  write(root, 'go.mod', 'module example.com/rng\n\ngo 1.21\n');
  write(root, 'rng/doc.go', 'package rng\n');
  const base = commit(root, 'baseline');
  write(root, 'rng/rng.go', V0);
  write(root, 'rng/rng_test.go', testFile([ROW_PAIR, ROW_NIL_ERROR]));
  const dev = commit(root, `${STORY} CHK-001: Set`);
  write(root, 'rng/rng.go', V1);
  write(root, 'rng/rng_test.go', testFile([ROW_PAIR, ROW_CLAMP, ROW_NIL_ERROR]));
  const repair1 = commit(root, `${STORY} F-001: resolve finding`);
  write(root, 'rng/rng.go', opts.repair2Code ?? V2);
  write(root, 'rng/rng_test.go', opts.repair2Test ?? testFile([ROW_PAIR, ROW_CLAMP, ROW_NIL_OMITTED]));
  const repair2 = commit(root, `${STORY} F-002: resolve finding`);
  return { root, base, dev, repair1, repair2 };
}
const finding = (n: number, desc: string, files: string[], extra: Partial<Finding> = {}): Finding => ({ id: F(n), desc, severity: 'medium', category: 'edge', status: 'open',
  evidenceState: 'verified', agent: 'proof-or-stop-review-quality', createdAt: NOW, files, ...extra } as Finding);
const resolved = (n: number, desc: string, files: string[], sha: string): Finding => finding(n, desc, files, { status: 'resolved', resolutionType: 'fixed', resolvedAt: NOW,
  resolvedReason: `Repaired. [repair commit ${sha.slice(0, 12)} of managed finding-repair run run-${n}]` });
const memoryEvents = () => {
  const events: Array<Record<string, unknown>> = [];
  return { events, store: { readProcessEvents: () => events, appendProcessEvent: (_id: string, event: Record<string, unknown>) => { events.push(event); } } };
};
type GuardFailure = { guarded: Finding; result: { passed: boolean; command: string }; blamed: Array<{ findingId: string; commit: string }> };
/** finding_resolve's guard as handlers/finding.ts calls it; the sanction commits come from the framework-bound repair commits passed in. */
function guardCheck(fx: Fx, findings: Finding[], repairs: Array<{ findingId: string; commit: string }>, opts: { staleCrossPin?: boolean; frameworkCommits?: Record<string, string | null> } = {}) {
  const memory = memoryEvents();
  const framework = opts.frameworkCommits;
  const out = api(guardModule, 'regressionGuardCheck')({ store: memory.store, projectRoot: fx.root, gitCwd: fx.root, storyId: STORY, findings, repairs,
    repairCommitOf: (row: Finding) => api(guardModule, 'repairCommitFromResolution')(fx.root, row), coverageOf: () => null,
    headHash: git(fx.root, ['rev-parse', 'HEAD']), materialHash: null, baseRef: fx.base,
    ...(framework ? { sanctionCommitOf: (row: Finding) => framework[row.id] ?? null } : {}),
    ...(opts.staleCrossPin === undefined ? {} : { staleCrossPin: opts.staleCrossPin }) }) as GuardFailure[];
  return { out, events: memory.events };
}
const guardEvent = (events: Array<Record<string, unknown>>, id: string) => events.filter(event => event.type === 'resolved_finding_guard_checked' && event.findingId === id).at(-1);
const cleanup = (fx: Fx): void => rmSync(fx.root, { recursive: true, force: true });
/** Round 2 of run 149: F-003's test-only repair (it touches none of F-001's files). */
const round2TestOnly = (fx: Fx): string => {
  write(fx.root, 'rng/rng_test.go', testFile([ROW_PAIR, ROW_CLAMP, ROW_NIL_OMITTED], OTHER_TEST));
  return commit(fx.root, `${STORY} F-003: resolve finding`);
};

// ---------------------------------------------------------------------------
// S. The run-149 shape

await check('S1 run 149 round 2: F-001\'s recorded test fails only on the Nil row that resolved F-002\'s repair re-pinned: excused sanctioned_repair, no failure, no blame of F-003', () => {
  const fx = fixture();
  try {
    const repair3 = round2TestOnly(fx);
    const findings = [resolved(1, F1_DESC, ['rng/rng.go'], fx.repair1), resolved(2, F2_DESC, ['rng/rng.go', 'rng/rng_test.go'], fx.repair2), finding(3, F3_DESC, ['rng/rng_test.go'])];
    const { out, events } = guardCheck(fx, findings, [{ findingId: F(3), commit: repair3 }], { frameworkCommits: { [F(1)]: fx.repair1, [F(2)]: fx.repair2 } });
    assert.deepEqual(out.map(row => row.guarded.id), [], `no regression finding: ${JSON.stringify(events)}`);
    const event = guardEvent(events, F(1));
    assert.equal(event?.passed, false, 'F-001\'s guard ran as recorded and failed');
    assert.equal(event?.excused, 'sanctioned_repair', `excused as a stale cross-finding pin: ${JSON.stringify(event)}`);
    assert.deepEqual(event?.sanctionedBy, [{ findingId: F(2), commit: fx.repair2 }], 'the sanctioning repair is named');
    assert.deepEqual(event?.staleCases, ['Set(0, Nil)'], 'the stale case is named');
    assert.ok(!('rejectedRepairs' in (event ?? {})), 'no repair is rejected');
  } finally { cleanup(fx); }
});

await check('S2 earliest point: at the batch acceptance of the grouped repair (F-001 then F-002) F-001\'s guard runs against F-002\'s later commit and the stale pin is journaled there', () => {
  const fx = fixture();
  try {
    const findings = [finding(1, F1_DESC, ['rng/rng.go']), finding(2, F2_DESC, ['rng/rng.go', 'rng/rng_test.go'])];
    const { out, events } = guardCheck(fx, findings, [{ findingId: F(1), commit: fx.repair1 }, { findingId: F(2), commit: fx.repair2 }]);
    assert.deepEqual(out.map(row => row.guarded.id), [], `both repairs accepted: ${JSON.stringify(events)}`);
    const event = guardEvent(events, F(1));
    assert.equal(event?.excused, 'sanctioned_repair', `F-001 was guarded against its batch sibling and the stale pin recorded: ${JSON.stringify(events)}`);
    assert.deepEqual(event?.sanctionedBy, [{ findingId: F(2), commit: fx.repair2 }]);
    assert.equal(guardEvent(events, F(2)), undefined, 'the newest member has no later sibling: not guarded in its own batch');
  } finally { cleanup(fx); }
});

await check('S3 control: a later grouped commit that breaks the earlier member\'s OWN row (and rewrites or deletes it) is blamed at the batch acceptance; the own row is never dropped', () => {
  for (const hidden of [[ROW_PAIR, ROW_CLAMP_HIDDEN, ROW_NIL_OMITTED], [ROW_PAIR, ROW_NIL_OMITTED]]) {
    const fx = fixture({ repair2Code: V2_BROKEN_CLAMP, repair2Test: testFile(hidden) });
    try {
      const findings = [finding(1, F1_DESC, ['rng/rng.go']), finding(2, F2_DESC, ['rng/rng.go', 'rng/rng_test.go'])];
      const { out, events } = guardCheck(fx, findings, [{ findingId: F(1), commit: fx.repair1 }, { findingId: F(2), commit: fx.repair2 }]);
      assert.deepEqual(out.map(row => row.guarded.id), [F(1)], `F-001's own case Set(1, 4) regressed: ${JSON.stringify(events)}`);
      assert.deepEqual(out[0]!.blamed, [{ findingId: F(2), commit: fx.repair2 }], 'only the later member is blamed, never F-001 itself');
      assert.equal(guardEvent(events, F(1))?.excused, undefined, 'not excused');
    } finally { cleanup(fx); }
  }
});

await check('S4 control: a genuine regression of F-001\'s own case by a later repair is still [regression-of F-001], even with the stale Nil row present', () => {
  const fx = fixture();
  try {
    write(fx.root, 'rng/rng.go', V2_BROKEN_CLAMP);
    write(fx.root, 'rng/rng_test.go', testFile([ROW_PAIR, ROW_CLAMP_HIDDEN, ROW_NIL_OMITTED]));
    const repair3 = commit(fx.root, `${STORY} F-003: resolve finding`);
    const findings = [resolved(1, F1_DESC, ['rng/rng.go'], fx.repair1), resolved(2, F2_DESC, ['rng/rng.go', 'rng/rng_test.go'], fx.repair2), finding(3, F3_DESC, ['rng/rng.go'])];
    const { out } = guardCheck(fx, findings, [{ findingId: F(3), commit: repair3 }], { frameworkCommits: { [F(1)]: fx.repair1, [F(2)]: fx.repair2 } });
    assert.deepEqual(out.map(row => row.guarded.id).filter(id => id === F(1)), [F(1)], 'F-001 regressed');
    assert.deepEqual(out.find(row => row.guarded.id === F(1))!.blamed, [{ findingId: F(3), commit: repair3 }], 'the breaking repair is blamed');
    const desc = api(guardModule, 'regressionFindingDesc')({ storyId: STORY, guarded: out.find(row => row.guarded.id === F(1))!.guarded, result: out.find(row => row.guarded.id === F(1))!.result, blamed: out.find(row => row.guarded.id === F(1))!.blamed }) as string;
    assert.match(desc, /^\[regression-of F-001\]/);
  } finally { cleanup(fx); }
});

await check('S5 control: another failing row the sanctioning repair did not re-pin keeps the regression (dropping only the stale row is not enough)', () => {
  const fx = fixture();
  try {
    write(fx.root, 'rng/rng.go', V2_BROKEN_PAIR);
    const repair3 = commit(fx.root, `${STORY} F-003: resolve finding`);
    const findings = [resolved(1, F1_DESC, ['rng/rng.go'], fx.repair1), resolved(2, F2_DESC, ['rng/rng.go', 'rng/rng_test.go'], fx.repair2), finding(3, F3_DESC, ['rng/rng.go'])];
    const { out, events } = guardCheck(fx, findings, [{ findingId: F(3), commit: repair3 }], { frameworkCommits: { [F(1)]: fx.repair1, [F(2)]: fx.repair2 } });
    assert.ok(out.some(row => row.guarded.id === F(1)), `Set(0, 2) still fails: ${JSON.stringify(guardEvent(events, F(1)))}`);
  } finally { cleanup(fx); }
});

await check('S6 control: a sanction needs a deliberate re-pin with a product change by a framework-bound repair (a deleted row, a test-only flip, a text-only commit citation are no sanction)', () => {
  // (a) F-002's repair deletes the Nil row instead of re-pinning it.
  const deleted = fixture({ repair2Test: testFile([ROW_PAIR, ROW_CLAMP]) });
  try {
    const repair3 = round2TestOnly(deleted);
    const findings = [resolved(1, F1_DESC, ['rng/rng.go'], deleted.repair1), resolved(2, F2_DESC, ['rng/rng.go', 'rng/rng_test.go'], deleted.repair2), finding(3, F3_DESC, ['rng/rng_test.go'])];
    const { out } = guardCheck(deleted, findings, [{ findingId: F(3), commit: repair3 }], { frameworkCommits: { [F(1)]: deleted.repair1, [F(2)]: deleted.repair2 } });
    assert.ok(out.some(row => row.guarded.id === F(1)), '(a) a deleted row is no re-pin');
  } finally { cleanup(deleted); }
  // (b) the product change landed in the DEV-side commit, F-002's commit only flips the test row.
  const flip = fixture({ repair2Code: V1 });
  try {
    write(flip.root, 'rng/rng.go', V2);
    const sneak = commit(flip.root, `${STORY} CHK-001: tweak`);
    const findings = [resolved(1, F1_DESC, ['rng/rng.go'], flip.repair1), resolved(2, F2_DESC, ['rng/rng.go', 'rng/rng_test.go'], flip.repair2), finding(3, F3_DESC, ['rng/rng_test.go'])];
    const { out } = guardCheck(flip, findings, [{ findingId: F(3), commit: sneak }], { frameworkCommits: { [F(1)]: flip.repair1, [F(2)]: flip.repair2 } });
    assert.ok(out.some(row => row.guarded.id === F(1)), '(b) a test-only flip sanctions nothing');
  } finally { cleanup(flip); }
  // (c) the framework binds no repair commit to F-002 (its resolution text names the commit, and claims the conflict).
  const text = fixture();
  try {
    const repair3 = round2TestOnly(text);
    const forged = finding(2, F2_DESC, ['rng/rng.go', 'rng/rng_test.go'], { status: 'resolved', resolutionType: 'fixed', resolvedAt: NOW,
      resolvedReason: `[intent-conflict] F-001's TestSet row is stale; see ${text.repair2.slice(0, 12)}.` });
    const findings = [resolved(1, F1_DESC, ['rng/rng.go'], text.repair1), forged, finding(3, F3_DESC, ['rng/rng_test.go'])];
    const { out } = guardCheck(text, findings, [{ findingId: F(3), commit: repair3 }], { frameworkCommits: { [F(1)]: text.repair1, [F(2)]: null } });
    assert.ok(out.some(row => row.guarded.id === F(1)), '(c) resolution text is no sanction (finding_resolve)');
    const dry = guardCheck(text, findings, [{ findingId: F(3), commit: repair3 }]);
    assert.ok(dry.out.some(row => row.guarded.id === F(1)), '(c) nor in the dry run: only the framework-appended repair-commit marker counts');
  } finally { cleanup(text); }
});

await check('S7 a row stating the guarded finding\'s own repro is never dropped (scope repro / an explicit repro row)', () => {
  // F-001 states its repro this time, on the same case the later repair re-pins: the row is F-001's own evidence.
  const fx = fixture();
  try {
    const repair3 = round2TestOnly(fx);
    const own = 'rng/rng.go: Set must reject an explicit Nil end. Repro: `Set(0, Nil)`';
    const findings = [resolved(1, own, ['rng/rng.go'], fx.repair1), resolved(2, F2_DESC, ['rng/rng.go', 'rng/rng_test.go'], fx.repair2), finding(3, F3_DESC, ['rng/rng_test.go'])];
    const sources = api(guardModule, 'staleCrossPinSources');
    const guard = api(guardModule, 'findingGuard')({ gitCwd: fx.root, finding: findings[0], repairCommit: fx.repair1, coverage: null });
    const plan = sources({ gitCwd: fx.root, guard, guarded: findings[0], output: 'rng_test.go:16: Set(0, Nil): got [9 9 9], want error', sanctioners: [{ findingId: F(2), commit: fx.repair2 }] });
    assert.equal(plan, null, `the repro row is F-001's own: ${JSON.stringify(plan)}`);
    void repair3;
  } finally { cleanup(fx); }
});

await check('S8 the managed repair regression check (dry run) does not hand run 149\'s stale pin back to the F-003 session', async () => {
  const fx = fixture();
  try {
    const launch = git(fx.root, ['rev-parse', 'HEAD']);
    round2TestOnly(fx);
    const findings = [resolved(1, F1_DESC, ['rng/rng.go'], fx.repair1), resolved(2, F2_DESC, ['rng/rng.go', 'rng/rng_test.go'], fx.repair2), finding(3, F3_DESC, ['rng/rng_test.go'])];
    const { repairRegressionFailures } = await import('../core/repair-regression-check.js') as { repairRegressionFailures: Fn };
    const check1 = repairRegressionFailures({ projectRoot: fx.root, gitCwd: fx.root, storyId: STORY, findings, items: [], findingIds: [F(3)], launchHead: launch, events: [], baseRef: fx.base }) as { failures: Array<{ id: string }> };
    assert.deepEqual(check1.failures.map(row => row.id), [], `no resumed turn: ${JSON.stringify(check1.failures)}`);
  } finally { cleanup(fx); }
});

await check('S9 switch remediation.staleCrossPin: default on, off = rollback (run 149 behaviour: the regression), malformed = on', async () => {
  const abVariants = await loadModule('../core/ab-variants.js') as Record<string, unknown>;
  const on = api(abVariants, 'staleCrossPinOn');
  assert.equal(on({}), true);
  assert.equal(on({ remediation: { staleCrossPin: 'off' } }), false);
  assert.equal(on({ remediation: { staleCrossPin: 'maybe' } }), true);
  assert.deepEqual((abVariants.AB_VARIANT_FLAGS as Record<string, unknown>)['remediation.staleCrossPin'], ['on', 'off']);
  const fx = fixture();
  try {
    const repair3 = round2TestOnly(fx);
    const findings = [resolved(1, F1_DESC, ['rng/rng.go'], fx.repair1), resolved(2, F2_DESC, ['rng/rng.go', 'rng/rng_test.go'], fx.repair2), finding(3, F3_DESC, ['rng/rng_test.go'])];
    const { out } = guardCheck(fx, findings, [{ findingId: F(3), commit: repair3 }], { staleCrossPin: false, frameworkCommits: { [F(1)]: fx.repair1, [F(2)]: fx.repair2 } });
    assert.deepEqual(out.map(row => row.guarded.id), [F(1)], 'off: the stale pin opens [regression-of F-001] as in run 149');
    assert.deepEqual(out[0]!.blamed, [], 'and blames nobody ("a later commit")');
    write(fx.root, 'proof-or-stop.config.json', JSON.stringify({ remediation: { staleCrossPin: 'off' } }));
    resetConfigCache();
    const fromConfig = guardCheck(fx, findings, [{ findingId: F(3), commit: repair3 }], { frameworkCommits: { [F(1)]: fx.repair1, [F(2)]: fx.repair2 } });
    assert.deepEqual(fromConfig.out.map(row => row.guarded.id), [F(1)], 'the project config switch is read when no explicit value is passed');
  } finally { cleanup(fx); resetConfigCache(); }
});

if (failures.length) {
  console.log(`run149-fixes-smoke: FAIL (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('run149-fixes-smoke: PASS');
