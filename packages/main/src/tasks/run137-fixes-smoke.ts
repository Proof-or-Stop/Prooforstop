#!/usr/bin/env node
/**
 * Lab run137 (old-PoS run 137, bench-staging/oldpos/run137-analysis.md; new-PoS ADR-056 / ADR-070 / ADR-071 / ADR-082
 * direction): unit level, made-up `clip` helpers only (no benchmark-task material). The lifecycle shapes are harness
 * NRR / NRR-OFF / NCK / NCP / NCP-F / NCP-X / NCP-N / NCP-P / NGX / NCL / NCL-OFF in tasks/e2e-review-to-done-smoke.ts.
 *
 *   M. Repair regression check (switch remediation.regressionCheck, default off since old-PoS runs 149-151; on = the lab arm): before a finding-repair run seals, the
 *      covering tests of the Story's resolved findings and the pinned checklist verifications of the changed packages
 *      are re-run (a dry guard run: nothing is journaled as a guard verdict); a failure goes back to the same session
 *      with the failing output. A repair that changed a shared helper (a function with several call sites in the Story
 *      diff) owes one `[caller-check]` line per caller (base vs HEAD), asked for in the same session.
 *   N. Conflict pin without a PLAN trip (switch remediation.conflictPin, default off since old-PoS runs 149-151; on = the lab arm): a finding conflict no row pins is
 *      decided by the framework only when the request quotes the case's value verbatim (never the finding text, never a
 *      base test line, never an executed finding expression: N3 / N5 / N6); else the PLAN trip writes the pin first.
 *   O. A failed grouped repair (no commit naming a member) is split: the per-finding relaunch is a framework step; the
 *      thinking-mode pass-back 400 that killed run 137's grouped run is a classified provider transport error.
 *   P. R1 class enumeration (switch review.classEnumeration, DEFAULT OFF: needs a detection A/B): concept and quality
 *      lanes get the shared helpers the Story changed with every caller, to enumerate and check against the base.
 *
 * Usage: node packages/main/dist/tasks/run137-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const commit = (root: string, subject: string): string => {
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', subject]);
  return git(root, ['rev-parse', 'HEAD']);
};

const STORY = 'B-1370';
/** A made-up helper `bound` shared by two readers; the Story adds `Step`, which calls it too. */
const CLIP_BASE = [
  'package clip', '',
  '// bound clamps i into [0, n].',
  'func bound(i, n int) int {',
  '\tif i < 0 {', '\t\treturn 0', '\t}',
  '\tif i > n {', '\t\treturn n', '\t}',
  '\treturn i',
  '}', '',
  '// Slice returns s[a:b] with both ends clamped.',
  'func Slice(s string, a, b int) string {',
  '\treturn s[bound(a, len(s)):bound(b, len(s))]',
  '}', '',
  '// From returns s from a on.',
  'func From(s string, a int) string {',
  '\treturn s[bound(a, len(s)):]',
  '}', '',
].join('\n');
const CLIP_STORY = `${CLIP_BASE}// Step returns every k-th byte of s from a on.\nfunc Step(s string, a, k int) string {\n\tout := []byte{}\n\tfor i := bound(a, len(s)); i < len(s); i += k {\n\t\tout = append(out, s[i])\n\t}\n\treturn string(out)\n}\n`;
/** The repair "fix": a negative start now counts from the end, which changes Slice and From too. */
const CLIP_REPAIRED = CLIP_STORY.replace('\tif i < 0 {\n\t\treturn 0\n\t}', '\tif i < 0 {\n\t\ti += n\n\t\tif i < 0 {\n\t\t\treturn 0\n\t\t}\n\t}');
const CLIP_TEST = [
  'package clip', '', 'import "testing"', '',
  'func TestSlice(t *testing.T) {', '\tif Slice("abcd", -1, 2) != "ab" {', '\t\tt.Fatal("negative start clamps to 0")', '\t}', '}', '',
  'func TestStep(t *testing.T) {', '\tif Step("abcdef", 0, 2) != "ace" {', '\t\tt.Fatal("step")', '\t}', '}', '',
].join('\n');

/** A repo: base (CLIP_BASE), the Story commit (Step + tests), then optionally the repair commit. */
function clipRepo(repaired: boolean): { root: string; base: string; story: string; head: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run137-clip-')));
  git(root, ['init', '-q', '-b', 'main']);
  write(root, 'go.mod', 'module example.invalid/clip\n\ngo 1.21\n');
  write(root, 'clip/clip.go', CLIP_BASE);
  const base = commit(root, 'base');
  write(root, 'clip/clip.go', CLIP_STORY);
  write(root, 'clip/clip_test.go', CLIP_TEST);
  const story = commit(root, `${STORY} CHK-001: Step`);
  if (!repaired) return { root, base, story, head: story };
  write(root, 'clip/clip.go', CLIP_REPAIRED);
  const head = commit(root, `${STORY} F-002: negative start counts from the end`);
  return { root, base, story, head };
}

// ---------------------------------------------------------------------------
// M. Repair regression check

await check('M1 a repair that changed a shared helper lists every caller of it in the Story diff (base..HEAD), its own body excluded', async () => {
  const changed = await load('../core/shared-helper-callers.js', 'changedSharedHelpers');
  const fx = clipRepo(true);
  try {
    const helpers = changed({ gitCwd: fx.root, from: fx.story, to: fx.head, baseRef: fx.base }) as Array<{ fn: string; sites: Array<{ caller: string; file: string }> }>;
    assert.deepEqual(helpers.map(row => row.fn), ['bound'], JSON.stringify(helpers));
    assert.deepEqual([...new Set(helpers[0]!.sites.map(site => site.caller))].sort(), ['From', 'Slice', 'Step']);
    assert.equal(changed({ gitCwd: fx.root, from: fx.head, to: fx.head, baseRef: fx.base }).length, 0, 'no change: no helper');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

await check('M2 the repair prompt names the shared helper a finding sits in, with its callers and the exact [caller-check] line form', async () => {
  const atFinding = await load('../core/shared-helper-callers.js', 'sharedHelpersAtFinding');
  const render = await load('../core/shared-helper-callers.js', 'renderSharedHelperCallers');
  const form = (await import('../core/repair-report-lines.js') as Record<string, unknown>).CALLER_CHECK_LINE_FORM as string | undefined;
  assert.ok(form, 'repair-report-lines exports CALLER_CHECK_LINE_FORM');
  const fx = clipRepo(false);
  try {
    const helpers = atFinding({ gitCwd: fx.root, baseRef: fx.base, finding: { desc: 'clip/clip.go:4 bound clamps a negative Step start to 0; Repro: `Step("abc", -1, 1)`', files: ['clip/clip.go'] } });
    assert.equal(helpers.length, 1, JSON.stringify(helpers));
    const lines = (render(helpers, 'repair') as string[]).join('\n');
    assert.match(lines, /bound \(clip\/clip\.go:4\)/);
    assert.match(lines, /in Slice/); assert.match(lines, /in From/); assert.match(lines, /in Step/);
    assert.ok(lines.includes(form!), lines);
    assert.deepEqual(atFinding({ gitCwd: fx.root, baseRef: fx.base, finding: { desc: 'clip/clip.go:21 From is wrong', files: ['clip/clip.go'] } }), [], 'a function with one caller (none) is no shared helper');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

await check('M3 the in-session follow-up asks for the missing [caller-check] lines only (one per caller); a complete report owes none', async () => {
  const followUp = await load('../core/repair-report-lines.js', 'repairReportFollowUp');
  const helpers = [{ fn: 'bound', file: 'clip/clip.go', line: 4, sites: [
    { file: 'clip/clip.go', line: 16, caller: 'Slice', text: 'return s[bound(a, len(s)):bound(b, len(s))]' },
    { file: 'clip/clip.go', line: 21, caller: 'From', text: 'return s[bound(a, len(s)):]' },
    { file: 'clip/clip.go', line: 27, caller: 'Step', text: 'for i := bound(a, len(s)); i < len(s); i += k {' }] }];
  const partial = 'Fixed the negative start.\n[caller-check] Step -> bound: Step("abc", -1, 1) base=abc HEAD=c changed: request "a negative start counts from the end"\n[intent-conflict] none';
  const asked = followUp({ report: partial, matrices: [], mechanisms: [], callerChecks: helpers }) as string | null;
  assert.ok(asked, 'asked');
  assert.match(asked!, /Slice/); assert.match(asked!, /From/);
  assert.doesNotMatch(asked!.split('\n').filter(line => /^\s*- /.test(line)).join('\n'), /in Step\b/, 'the reported caller is not asked again');
  assert.match(asked!, /\[caller-check\] <caller> -> <helper>/);
  const full = `${partial}\n[caller-check] Slice -> bound: Slice("abcd", -1, 2) base=ab HEAD="" changed: request "a negative start counts from the end"\n[caller-check] From -> bound: From("abc", -1) base=abc HEAD=c unchanged`;
  assert.equal(followUp({ report: full, matrices: [], mechanisms: [], callerChecks: helpers }), null);
});

/** A repo with a resolved finding G whose repair added TestFromNegative; then a repair of F breaks it. */
function guardRepo(): { root: string; base: string; gRepair: string; fRepair: string } {
  const fx = clipRepo(false);
  write(fx.root, 'clip/clip_test.go', `${CLIP_TEST}\nfunc TestFromNegative(t *testing.T) {\n\tif From("abc", -1) != "abc" {\n\t\tt.Fatal("negative start clamps")\n\t}\n}\n`);
  const gRepair = commit(fx.root, `${STORY} F-001: negative From start clamps`);
  write(fx.root, 'clip/clip.go', CLIP_REPAIRED);
  const fRepair = commit(fx.root, `${STORY} F-002: negative start counts from the end`);
  return { root: fx.root, base: fx.base, gRepair, fRepair };
}
const G = (gRepair: string) => ({ id: `${STORY}:F-001`, desc: 'clip/clip.go:21 From with a negative start must clamp to 0. Repro: `From("abc", -1)`', files: ['clip/clip.go'], severity: 'medium', category: 'edge',
  status: 'resolved', resolutionType: 'fixed', resolvedAt: '2026-10-21T00:00:00.000Z', resolvedReason: `Framework-verified repair of ${STORY}:F-001: material commit ${gRepair.slice(0, 12)} of managed finding-repair run r1` });
const F = { id: `${STORY}:F-002`, desc: 'clip/clip.go:27 Step with a negative start should count from the end. Repro: `Step("abc", -1, 1)`', files: ['clip/clip.go'], severity: 'medium', category: 'edge', status: 'open', evidenceState: 'verified' };

await check('M4 the dry pre-seal check reports a resolved finding whose covering test the repair broke, and journals no guard verdict', async () => {
  const failuresOf = await load('../core/repair-regression-check.js', 'repairRegressionFailures');
  const fx = guardRepo();
  try {
    const appended: unknown[] = [];
    const out = failuresOf({ projectRoot: fx.root, gitCwd: fx.root, storyId: STORY, findings: [G(fx.gRepair), F], items: [], findingIds: [F.id], launchHead: fx.gRepair,
      events: [], baseRef: fx.base, onEvent: (event: unknown) => appended.push(event) }) as { failures: Array<{ kind: string; id: string; command: string; outputTail: string }> };
    assert.equal(out.failures.length, 1, JSON.stringify(out));
    assert.equal(out.failures[0]!.kind, 'resolved_finding');
    assert.equal(out.failures[0]!.id, G(fx.gRepair).id);
    assert.match(out.failures[0]!.command, /TestFromNegative/);
    assert.match(out.failures[0]!.outputTail, /FAIL/);
    assert.equal(appended.filter(event => (event as { type?: string }).type === 'resolved_finding_guard_checked').length, 0, 'never a guard verdict (finding_resolve stays the gate)');
    const clean = failuresOf({ projectRoot: fx.root, gitCwd: fx.root, storyId: STORY, findings: [G(fx.gRepair), F], items: [], findingIds: [F.id], launchHead: fx.gRepair,
      events: [], baseRef: fx.base, headRef: fx.gRepair }) as { failures: unknown[] };
    assert.equal(clean.failures.length, 0, 'nothing committed by the repair: nothing to check');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

await check('M5 a pinned checklist verification of a changed package that passed at launch and fails now is reported; one failing at launch too is not', async () => {
  const failuresOf = await load('../core/repair-regression-check.js', 'repairRegressionFailures');
  const fx = clipRepo(true);
  try {
    const item = (command: string, selector: string) => ({ id: 'CHK-001', title: 'Step', status: 'done', verificationIntent: { happy: [{ desc: 'Slice clamps a negative start', verification: { command, selector } }], edge: [], adversarial: [] } });
    const out = failuresOf({ projectRoot: fx.root, gitCwd: fx.root, storyId: STORY, findings: [F], items: [item('go test -v ./clip -run ^TestSlice$', '--- PASS: TestSlice')], findingIds: [F.id],
      launchHead: fx.story, events: [], baseRef: fx.base }) as { failures: Array<{ kind: string; id: string }> };
    assert.deepEqual(out.failures.map(row => [row.kind, row.id]), [['pinned_verification', 'CHK-001:happy:0']], JSON.stringify(out));
    const stale = failuresOf({ projectRoot: fx.root, gitCwd: fx.root, storyId: STORY, findings: [F], items: [item('go test -v ./clip -run ^TestMissing$', '--- PASS: TestMissing')], findingIds: [F.id],
      launchHead: fx.story, events: [], baseRef: fx.base }) as { failures: unknown[] };
    assert.equal(stale.failures.length, 0, 'failing at launch too: not the repair\'s regression');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

await check('M6 the regression follow-up names each failing check, command and output, and the rule (fix the code; never edit the resolved test; [intent-conflict] for a true conflict)', async () => {
  const prompt = await load('../core/repair-regression-check.js', 'repairRegressionFollowUp');
  const text = prompt([{ kind: 'resolved_finding', id: `${STORY}:F-001`, command: 'go test -v ./clip -run ^(TestFromNegative)$', outputTail: '--- FAIL: TestFromNegative' },
    { kind: 'pinned_verification', id: 'CHK-001:happy:0', command: 'go test -v ./clip -run ^TestSlice$', outputTail: '--- FAIL: TestSlice' }], [`${STORY}:F-002`]) as string;
  assert.match(text, /F-001/); assert.match(text, /CHK-001:happy:0/);
  assert.match(text, /TestFromNegative/); assert.match(text, /--- FAIL: TestSlice/);
  assert.match(text, /\[intent-conflict\]/);
  assert.match(text, /do not (?:edit|change|weaken)/i);
});

await check('M7 remediation.regressionCheck: default off since old-PoS runs 149-151 (nothing recorded), `on` recorded as the lab arm, malformed = off where consumed', async () => {
  const { resolveAbVariants, abVariantEvidence, AB_VARIANT_FLAGS } = await import('../core/ab-variants.js') as unknown as Record<string, Fn> & { AB_VARIANT_FLAGS: Record<string, readonly string[]> };
  assert.deepEqual(AB_VARIANT_FLAGS['remediation.regressionCheck'], ['off', 'on']);
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ remediation: { regressionCheck: 'on' } })).flags, { 'remediation.regressionCheck': 'on' });
  assert.equal(abVariantEvidence(resolveAbVariants({})), undefined);
  const on = await load('../core/ab-variants.js', 'regressionCheckOn');
  assert.equal(on({}), false); assert.equal(on({ remediation: { regressionCheck: 'loud' } }), false); assert.equal(on({ remediation: { regressionCheck: 'on' } }), true);
});

// ---------------------------------------------------------------------------
// N. Conflict pin

/** Run 137 F-006's shape (made-up values): the finding states the Story base value and the HEAD value of each case. */
const N_F = { id: `${STORY}:F-006`, desc: 'clip/clip.go:16 Slice now clamps an oversized end. On the base `Slice("abcd", 1, 99)` returns `bcd`; HEAD returns `` (empty). Conversely `From("abcd", 99)` returns `abcd` on base but `` on HEAD.',
  files: ['clip/clip.go'], severity: 'medium', status: 'open', evidenceState: 'verified' };
const N_G = { id: `${STORY}:F-004`, desc: 'clip/clip.go:4 bound wraps an oversized index. Repro: `Step("abcd", 0, 99)`', files: ['clip/clip.go'], severity: 'medium', status: 'resolved', resolutionType: 'fixed' };
const N_CONFLICT = { findingId: N_F.id, resolvedId: N_G.id, kind: 'rejected', since: '2026-10-21T00:00:00.000Z', why: 'the repair of F-006 was rejected' };

await check('N1 the Story base values a finding states are read per case (base and HEAD); prose without a stated base value gives none', async () => {
  const stated = await load('../core/finding-conflict-pin.js', 'statedBaseCases');
  assert.deepEqual(stated(N_F.desc), [{ expr: 'Slice("abcd", 1, 99)', base: 'bcd', head: '' }, { expr: 'From("abcd", 99)', base: 'abcd', head: '' }]);
  assert.deepEqual(stated('Base: `Step("ab", 0, 1)` -> `ab`.'), [{ expr: 'Step("ab", 0, 1)', base: 'ab' }]);
  assert.deepEqual(stated(N_G.desc), []);
});

/** Test lines at the Story base naming N_F's cases (what `git grep` at the base SHA would return): never a pin source. */
const N_BASE_TESTS: Record<string, Array<{ file: string; line: number; text: string }>> = {
  'Slice("abcd", 1, 99)': [{ file: 'clip/clip_test.go', line: 7, text: '\tif got := Slice("abcd", 1, 99); got != "bcd" {' }],
  'From("abcd", 99)': [{ file: 'clip/clip_test.go', line: 12, text: '\tif From("abcd", 99) != "abcd" {' }],
};
const N_BASE = (expr: string) => N_BASE_TESTS[expr] ?? [];
/** Security review 4: negated asserts and the value in a non-expected position (they name E and V on one line, but deny it). */
const N_NEGATED_TESTS: Record<string, Array<{ file: string; line: number; text: string }>> = {
  'Slice("abcd", 1, 99)': [{ file: 'clip/clip_test.go', line: 7, text: '\tif Slice("abcd", 1, 99) == "bcd" { t.Fatal("must not keep bcd") }' }],
  'From("abcd", 99)': [{ file: 'clip/clip_test.go', line: 12, text: '\tassert.NotEqual(t, "abcd", From("abcd", 99))' }],
};
const N_NEGATED = (expr: string) => N_NEGATED_TESTS[expr] ?? [];
const N_SILENT = 'Add Step.\n\n- Existing Slice and From behaviour stays the same.\n';

await check('N2 the framework pin decides only from a verbatim request-quoted value (request > reviewer): the request\'s value picks the side; a silent request is the PLAN pin\'s, even with base tests naming the cases; no stated value or a precedent conflict: no pin', async () => {
  const pin = await load('../core/finding-conflict-pin.js', 'frameworkConflictPin');
  const won = pin({ finding: N_F, resolved: N_G, conflict: N_CONFLICT, requestText: 'Add Step.\n\n- `Slice("abcd", 1, 99)` returns `bcd`.\n- `From("abcd", 99)` returns `abcd`.\n' });
  assert.equal(won?.side, 'finding', JSON.stringify(won));
  assert.equal(won.source, 'request');
  assert.deepEqual(won.cases, [{ expr: 'Slice("abcd", 1, 99)', value: 'bcd' }, { expr: 'From("abcd", 99)', value: 'abcd' }]);
  const request = pin({ finding: N_F, resolved: N_G, conflict: N_CONFLICT, requestText: 'Add Step.\n\n- `Slice("abcd", 1, 99)` returns `` (an oversized end is empty).\n' });
  assert.equal(request?.side, 'resolved', `the request states the HEAD value: the finding loses (${JSON.stringify(request)})`);
  assert.equal(request.source, 'request');
  assert.equal(pin({ finding: N_F, resolved: N_G, conflict: N_CONFLICT, requestText: N_SILENT, baseTests: N_BASE }), null, 'a silent request: the PLAN pin, whatever a base test says');
  assert.equal(pin({ finding: { ...N_F, desc: 'clip/clip.go:16 Slice clamps an oversized end; it should not.' }, resolved: N_G, conflict: N_CONFLICT, requestText: 'Add Step.' }), null, 'undeterminable: the PLAN pin stays');
  assert.equal(pin({ finding: N_F, resolved: N_G, conflict: { ...N_CONFLICT, kind: 'precedent' }, requestText: '- `Slice("abcd", 1, 99)` returns `bcd`.' }), null, 'a precedent conflict is never the framework\'s');
});

await check('N3 security review 4: a negated base assert (`== V { t.Fatal }`, NotEqual) or the value in a non-expected position is no statement: the PLAN pin; and no base-test tier exists to misread one', async () => {
  const pin = await load('../core/finding-conflict-pin.js', 'frameworkConflictPin');
  assert.equal(pin({ finding: N_F, resolved: N_G, conflict: N_CONFLICT, requestText: N_SILENT, baseTests: N_NEGATED }), null, 'negated asserts never confirm');
  assert.equal(pin({ finding: N_F, resolved: N_G, conflict: N_CONFLICT, requestText: 'Add Step.', baseTests: N_BASE }), null, 'nor do affirmative ones: no base-test tier');
  const pinModule = await import('../core/finding-conflict-pin.js') as Record<string, unknown>;
  const settleModule = await import('../handlers/finding-conflict-settle.js') as Record<string, unknown>;
  assert.equal(pinModule.baseTestStatesCase, undefined, 'no line matcher');
  assert.equal(settleModule.storyBaseTestLines, undefined, 'no base test reader');
});

await check('N5 security: the finding\'s own statement is never evidence: a request silent on the cases gives no pin (no source but the request exists); a request-quoted value decides', async () => {
  const pin = await load('../core/finding-conflict-pin.js', 'frameworkConflictPin');
  assert.equal(pin({ finding: N_F, resolved: N_G, conflict: N_CONFLICT, requestText: N_SILENT }), null, 'silent request');
  assert.equal(pin({ finding: N_F, resolved: N_G, conflict: N_CONFLICT, requestText: null }), null, 'no request');
  assert.equal(pin({ finding: N_F, resolved: N_G, conflict: N_CONFLICT, requestText: 'Add Step.\n\nSlice("abcd", 1, 99) returns bcd.\n' }), null, 'an unquoted mention is not a stated value');
  const quoted = pin({ finding: N_F, resolved: N_G, conflict: N_CONFLICT, requestText: 'Add Step.\n\n- `Slice("abcd", 1, 99)` returns `bcd`.\n' });
  assert.equal(quoted?.source, 'request', `a request-quoted value decides: ${JSON.stringify(quoted)}`);
  assert.deepEqual(quoted.cases, [{ expr: 'Slice("abcd", 1, 99)', value: 'bcd' }], 'only the cases the request quotes');
});

await check('N6 security: a crafted case expression is never executed (no probe input exists); a confirmation record other than the request\'s own values is rejected', async () => {
  const pin = await load('../core/finding-conflict-pin.js', 'frameworkConflictPin');
  const confirmed = await load('../core/finding-conflict-pin.js', 'frameworkPinConfirmed');
  const module = await import('../core/finding-conflict-pin.js') as Record<string, unknown>;
  assert.equal(module.probeExprTrust, undefined, 'no expression sanitizer tier');
  const crafted = (expr: string) => ({ ...N_F, desc: `clip/clip.go:16 Slice clamps. On the base \`${expr}\` returns \`bcd\`; HEAD returns \`\`.` });
  for (const expr of ['print("[0]"); x', '"bcd" || Slice("abcd", 1, 99)', 'e("abcd", 1, 99)']) {
    assert.equal(pin({ finding: crafted(expr), resolved: N_G, conflict: N_CONFLICT, requestText: N_SILENT, baseTests: N_BASE, baseProbe: () => 'bcd' }), null, `no pin from ${expr}`);
  }
  const cases = [{ expr: 'Slice("abcd", 1, 99)', value: 'bcd' }];
  assert.equal(confirmed({ side: 'finding', source: 'story_base', cases, reason: 'x',
    confirmation: { kind: 'base_test', cases: [{ ...cases[0], file: 'clip/clip_test.go', line: 7, text: '\tif Slice("abcd", 1, 99) != "bcd" {' }] } }), false, 'a base-test record is no confirmation');
  assert.equal(confirmed({ side: 'finding', source: 'request', cases, reason: 'x', confirmation: { kind: 'request', cases: [] } }), false, 'a request record missing the case');
  assert.equal(confirmed({ side: 'finding', source: 'request', cases, reason: 'x', confirmation: { kind: 'request', cases } }), true);
});

await check('N4 remediation.conflictPin: default off since old-PoS runs 149-151 (nothing recorded), `on` recorded as the lab arm', async () => {
  const { resolveAbVariants, abVariantEvidence, AB_VARIANT_FLAGS } = await import('../core/ab-variants.js') as unknown as Record<string, Fn> & { AB_VARIANT_FLAGS: Record<string, readonly string[]> };
  assert.deepEqual(AB_VARIANT_FLAGS['remediation.conflictPin'], ['off', 'on']);
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ remediation: { conflictPin: 'on' } })).flags, { 'remediation.conflictPin': 'on' });
  const on = await load('../core/ab-variants.js', 'conflictPinOn');
  assert.equal(on({}), false); assert.equal(on({ remediation: { conflictPin: 'maybe' } }), false); assert.equal(on({ remediation: { conflictPin: 'on' } }), true);
});

// ---------------------------------------------------------------------------
// O. Failed grouped repair

await check('O1 the relaunch after a grouped repair that ended without a commit naming the finding is the framework\'s (split), bounded; any other failed run stays the agent\'s', async () => {
  const split = await load('../handlers/next-driver.js', 'groupSplitRelaunchIsFramework');
  assert.equal(split([{ autoReplaceable: false, groupSplit: true }]), true);
  assert.equal(split([{ autoReplaceable: true }, { autoReplaceable: false, groupSplit: true }]), true);
  assert.equal(split([{ autoReplaceable: false, groupSplit: true }, { autoReplaceable: false }]), false, 'the per-finding run failed too: the agent\'s call');
  assert.equal(split([{ autoReplaceable: false }]), false);
  assert.equal(split([]), true, 'a first launch');
});

await check('O2 the thinking-mode pass-back 400 that killed run 137 2373e8ff is classified as a provider transport error (not an opaque exit)', async () => {
  const diagnostic = await load('../core/managed-host-run.js', 'providerTransportDiagnosticLine');
  const line = JSON.stringify({ type: 'error', message: 'Upstream request failed: [invalid_request_error] The `reasoning_content` in the thinking mode must be passed back to the API. (request_id: 00000000-0000-0000-0000-000000000000)' });
  assert.ok(diagnostic(line), 'classified');
  assert.equal(diagnostic(JSON.stringify({ type: 'error', message: 'model refused the request' })), null, 'any other error stays unclassified');
});

// ---------------------------------------------------------------------------
// P. R1 class enumeration

await check('P1 review.classEnumeration: DEFAULT OFF (on = the experimental arm, recorded); only concept and quality lanes get the block', async () => {
  const { resolveAbVariants, abVariantEvidence, AB_VARIANT_FLAGS } = await import('../core/ab-variants.js') as unknown as Record<string, Fn> & { AB_VARIANT_FLAGS: Record<string, readonly string[]> };
  assert.deepEqual(AB_VARIANT_FLAGS['review.classEnumeration'], ['off', 'on']);
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ review: { classEnumeration: 'on' } })).flags, { 'review.classEnumeration': 'on' });
  assert.equal(abVariantEvidence(resolveAbVariants({})), undefined, 'the default (off) records nothing');
  const on = await load('../core/ab-variants.js', 'classEnumerationOn');
  assert.equal(on({}), false); assert.equal(on({ review: { classEnumeration: 'maybe' } }), false, 'malformed = off');
  const lane = await load('../core/managed-review-evidence.js', 'classEnumerationLane');
  assert.equal(lane('proof-or-stop-review-concept'), true); assert.equal(lane('proof-or-stop-review-quality'), true);
  assert.equal(lane('proof-or-stop-review-test-coverage'), false); assert.equal(lane('proof-or-stop-review-docs'), false);
});

await check('P2 the review block names every caller and asks for each altered behaviour per caller against the base, in addition to the lane\'s own checks (not a broad family sentence)', async () => {
  const render = await load('../core/shared-helper-callers.js', 'renderSharedHelperCallers');
  const text = (render([{ fn: 'bound', file: 'clip/clip.go', line: 4, sites: [{ file: 'clip/clip.go', line: 16, caller: 'Slice', text: 'x' }, { file: 'clip/clip.go', line: 27, caller: 'Step', text: 'y' }] }], 'review') as string[]).join('\n');
  assert.match(text, /In addition to your lane's own checks/);
  assert.match(text, /in Slice/); assert.match(text, /in Step/);
  assert.match(text, /Story base/);
  assert.deepEqual(render([], 'review'), [], 'no shared helper: no block');
});

if (failures.length) {
  console.log(`run137-fixes-smoke: FAIL (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('run137-fixes-smoke: PASS');
