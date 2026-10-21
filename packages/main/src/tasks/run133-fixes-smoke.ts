#!/usr/bin/env node
/**
 * Lab run132, second part (old-PoS runs 133 / 134; bench-staging/oldpos/run133-analysis.md items A-D,
 * run134-analysis.md R2-R3): unit level, made-up rows only (no benchmark-task material). The straggler worker path end
 * to end (fake codex, stop + resumed verdict turn) is tasks/review-straggler-smoke.ts; run 134's base checks are
 * tasks/run134-fixes-smoke.ts.
 *
 *   A. Pin-audit correction (run 133 PLAN reruns 3-4, ~6.1 min; run 134 R2-R4): the step offered a placeholder call for
 *      the first gap's item only, the check was all or nothing, the literal sweep crossed row roles, and a dispute
 *      counted a row the framework never offered a correction for. Run 134's reviewer wrote `pins <case> -> <value>;
 *      request gives <value> because <why>` (the case itself containing `;`), which the parser misread. Now: ONE ready
 *      row patch per gap item, partial application, role-bounded sweep, dispute streaks only over offered rows, the
 *      gap parsed in either form.
 *   B. Pin doubt (run 133 DEV->PLAN detour): a `[pin-doubt] <ref> | base prints: <text>` states only the base side;
 *      the row's own spaced variant (`{ }` vs `{}`) is the pinned side: ONE ready row patch. PLAN lint empty_collection.
 *   C. Review straggler (run 133 R1 concept lane 13.1 min vs 3.7-7.1 min): review.stragglerVerdict.
 *   D. Duplicate closure (run 133, 16.8 min, 9 owner calls guessing JSON): the step names each finding's gist, the
 *      canonical repair commit and tests, and prefills the coverage from the canonical's repair test.
 *
 * Usage: node packages/main/dist/tasks/run133-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const noPlaceholder = (value: unknown): void => assert.doesNotMatch(JSON.stringify(value), /"<[a-z][^"]*>"/i, `no placeholder: ${JSON.stringify(value).slice(0, 400)}`);

const STORY = 'B-1330';
type Row = { desc: string; derivation?: { requestQuote?: string; computation?: string } };
const item = (id: string, lanes: Partial<Record<'happy' | 'edge' | 'adversarial', Row[]>>, extra: Record<string, unknown> = {}) => ({
  id, title: `${id} title`, status: 'pending', userSees: `${id} user sees`, excludes: [] as string[],
  verificationIntent: { happy: lanes.happy ?? [], edge: lanes.edge ?? [], adversarial: lanes.adversarial ?? [] }, ...extra,
});
const digestOf = async (items: unknown[]): Promise<string> => (await import('../core/scope-check-integrity.js')).scopeReviewChecklistDigest({ items } as never);
const storeOf = (scope: unknown, items: unknown[]) => ({ readScopeCheck: () => scope, readChecklist: () => ({ items }) });

// Two items, each with one wrong pin; CHK-002 also has a READ row stating the same list as CHK-001's write pin.
const judged = () => [
  item('CHK-001', { happy: [{ desc: 'a=[1,2,3]; a[1]=9; a -> [9, 2, 3]', derivation: { requestQuote: 'q1', computation: 'index 1 becomes 9: [9, 2, 3]' } }] }),
  item('CHK-002', { edge: [
    { desc: 'b=[9,2,3]; b -> [9, 2, 3]', derivation: { requestQuote: 'q2', computation: 'reading b gives [9, 2, 3]' } },
    { desc: '"abcdef"[1:4] -> "bcde" keeps the existing two-part range', derivation: { requestQuote: 'q3', computation: 'positions 1..4 give "bcde"' } },
  ] }),
];
const GAP1 = 'pin-audit CHK-001:happy:0: pins [9, 2, 3]; request gives [1, 9, 3] (index 1 is the second element)';
const GAP2 = 'pin-audit CHK-002:edge:1: pins "abcdef"[1:4] -> "bcde"; request gives "bcd" because existing two-part ranges are end-exclusive';
const scopeOf = async (items: unknown[], features: string[]) => ({ checkedAt: '2026-10-22T00:00:00.000Z', checklistDigest: await digestOf(items),
  features: features.map(feature => ({ feature, status: 'gap', source: 'request.md' })) });

// ---------------------------------------------------------------------------
// A. Pin-audit correction

await check('A1 run 134\'s gap forms parse: `pins <case> -> <value>; request gives <value> because ...`, a case containing `;`', async () => {
  const parse = await load('../core/pin-audit-correction.js', 'parsePinAuditGap');
  const a = parse(GAP2);
  assert.ok(a, 'parsed');
  assert.equal(a.pinned, '"bcde"');
  assert.equal(a.requestValue, '"bcd"');
  const b = parse('pin-audit CHK-003:adversarial:0: pins a=[0,1,2]; a[0:1]=[9] -> range assignment size mismatch: target=2 value=1; request gives [9, 1, 2] because [0:1] selects one target');
  assert.ok(b, 'parsed with a `;` in the case');
  assert.equal(b.pinned, 'range assignment size mismatch: target=2 value=1');
  assert.equal(b.requestValue, '[9, 1, 2]');
  const c = parse(GAP1);
  assert.equal(c.pinned, '[9, 2, 3]');
  assert.equal(c.requestValue, '[1, 9, 3]', 'the documented `(why)` form still parses');
});

await check('A2 gaps on two items: ONE ready row-level call per item (value side + computation), no placeholder, no first-item-only offer', async () => {
  const stepOf = await load('../handlers/next-driver.js', 'pinAuditCorrectionStep');
  const items = judged();
  const scope = await scopeOf(items, [GAP1, GAP2]);
  const out = stepOf({ storyId: STORY, phase: 'PLAN' }, storeOf(scope, items), new Set());
  assert.equal(out.reason, 'pin_audit_correction');
  const calls = (out.batch ?? [{ cli: out.cli }]).map((call: { cli: { payload: Record<string, unknown> } }) => call.cli.payload);
  assert.deepEqual(calls.map((payload: Record<string, unknown>) => payload.itemId).sort(), ['CHK-001', 'CHK-002'], `one call per gap item: ${JSON.stringify(calls).slice(0, 300)}`);
  noPlaceholder(calls);
  const first = calls.find((payload: Record<string, unknown>) => payload.itemId === 'CHK-001') as { intentRows: Row[] };
  assert.equal(first.intentRows[0]!.desc, 'a=[1,2,3]; a[1]=9; a -> [1, 9, 3]', 'the value side states the requested value; the case side is unchanged');
  assert.match(String(first.intentRows[0]!.derivation?.computation), /\[1, 9, 3\]/);
  const second = calls.find((payload: Record<string, unknown>) => payload.itemId === 'CHK-002') as { intentRows: Array<Row & { ref: string }> };
  assert.equal(second.intentRows.find(row => row.ref === 'CHK-002:edge:1')!.desc, '"abcdef"[1:4] -> "bcd" keeps the existing two-part range');
  assert.ok(!second.intentRows.some(row => row.ref === 'CHK-002:edge:0'), 'the read row stating the same list as the write pin is not swept (another role)');
});

await check('A3 partial application: the corrected gap closes, the uncorrected rest is the next correction step (no scope-plan rerun)', async () => {
  const applied = await load('../core/pin-audit-correction.js', 'appliedPinAuditGaps');
  const pending = await load('../core/pin-audit-correction.js', 'pinAuditGapsPending');
  const rerun = await load('../core/plan-scope-check-requirement.js', 'scopePlanRerunReason');
  const before = judged();
  const scope = await scopeOf(before, [GAP1, GAP2]);
  const after = structuredClone(before);
  after[0]!.verificationIntent.happy[0] = { desc: 'a=[1,2,3]; a[1]=9; a -> [1, 9, 3]', derivation: { requestQuote: 'q1', computation: 'index 1 becomes 9: [1, 9, 3]' } };
  assert.deepEqual([...applied(scope, { items: after })], [GAP1], 'the applied gap only');
  assert.equal(pending(scope, { items: after }), true, 'the rest is pending correction');
  assert.equal(rerun(storeOf(scope, after), { storyId: STORY, currentReviewRound: undefined }), null, 'no rerun while the rest is a pending correction');
  const both = structuredClone(after);
  both[1]!.verificationIntent.edge[1] = { desc: '"abcdef"[1:4] -> "bcd" keeps the existing two-part range', derivation: { requestQuote: 'q3', computation: 'positions 1..4 give "bcd"' } };
  assert.deepEqual([...applied(scope, { items: both })].sort(), [GAP1, GAP2].sort(), 'both applied');
  const other = structuredClone(after);
  other[1]!.title = 'a different title';
  assert.equal(applied(scope, { items: other }).size, 0, 'any other change: nothing applied (the reviewer reruns)');
});

await check('A4 a group pin matches with other spacing (`[9,2,3]` is the row\'s `[9, 2, 3]`); a non-ASCII value matches the row\'s \\u escape and keeps it', async () => {
  const patchOf = await load('../core/pin-audit-correction.js', 'pinAuditRowPatch');
  const spaced = patchOf(item('CHK-001', { happy: [{ desc: 'a -> [9, 2, 3]' }] }), { ref: 'CHK-001:happy:0', lane: 'happy', index: 0, pinned: '[9,2,3]', requestValue: '[1,9,3]' });
  assert.ok(spaced, 'patched');
  assert.equal(spaced.desc, 'a -> [1,9,3]');
  const escaped = patchOf(item('CHK-004', { edge: [{ desc: '"a\\u00e9z"[1:2] -> "\\u00e9z"' }] }), { ref: 'CHK-004:edge:0', lane: 'edge', index: 0, pinned: '"éz"', requestValue: '"é"' });
  assert.ok(escaped, 'the escaped row matches the decoded pin');
  assert.equal(escaped.desc, '"a\\u00e9z"[1:2] -> "\\u00e9"', 'the replacement keeps the row\'s escape form');
});

await check('A5 a dispute streak counts only verdicts whose row the framework offered a correction for', async () => {
  const disputed = await load('../core/pin-dispute.js', 'disputedRows');
  const gap = (at: string) => ({ checkedAt: at, features: [{ feature: 'pin-audit CHK-004:edge:1: pins "x"; request gives "y"', status: 'gap' }] });
  const history = [gap('2026-10-22T00:02:00.000Z'), gap('2026-10-22T00:01:00.000Z')];
  const named = { named: ['CHK-004:edge:1'], offered: [] as string[] };
  assert.equal(disputed(history, (at: string) => (at === '2026-10-22T00:01:00.000Z' ? named : null)).length, 0, 'named without an offer: no dispute');
  const offered = { named: ['CHK-004:edge:1'], offered: ['CHK-004:edge:1'] };
  assert.equal(disputed(history, (at: string) => (at === '2026-10-22T00:01:00.000Z' ? offered : null))[0]?.verdicts, 2, 'offered and raised again: a dispute');
  assert.equal(disputed(history)[0]?.verdicts, 2, 'no offer journal (older stories): the streak counts as before');
});

// ---------------------------------------------------------------------------
// B. Pin doubt / empty collections

const DOUBT_ROW = 'h={}; h[h:1] -> error: index ranges can only be numerical: got "{ }" (type HASH)';
await check('B1 a [pin-doubt] stating only the base print is ONE ready row patch to it (the row\'s spaced variant is the pinned side)', async () => {
  const ready = await load('../core/intent-conflict-overrule.js', 'pinDoubtReadyRows');
  const rows = ready(item('CHK-002', { adversarial: [{ desc: DOUBT_ROW, derivation: { requestQuote: 'The error names the type.' } }] }),
    [{ itemId: 'CHK-002', intentRef: 'CHK-002:adversarial:0', intentPins: null, requestImplies: '`index ranges can only be numerical: got "{}" (type HASH)`', requestSentence: null, runId: 'run-1' }]);
  assert.ok(rows?.length, 'a ready patch');
  assert.equal(rows[0].desc, 'h={}; h[h:1] -> error: index ranges can only be numerical: got "{}" (type HASH)');
  assert.equal(rows[0].derivation.requestQuote, 'The error names the type.', 'the request quote is kept');
  assert.match(rows[0].derivation.computation, /re-pin: .* was .*got "\{ \}".*, now .*got "\{\}"/);
  noPlaceholder(rows);
});

await check('B2 next (PLAN) for that doubt is intent_conflict_amend with the ready patch and status pending', async () => {
  const stepOf = await load('../handlers/next-driver.js', 'intentConflictStep');
  const items = [item('CHK-002', { adversarial: [{ desc: DOUBT_ROW, derivation: { requestQuote: 'The error names the type.' } }] })];
  const out = stepOf({ storyId: STORY, phase: 'PLAN' }, [{ runId: 'run-1', agentType: 'proof-or-stop-implementer', createdAt: '2026-10-22T00:00:00.000Z', itemId: 'CHK-002',
    conflict: { intentRef: 'CHK-002:adversarial:0', itemId: 'CHK-002', requestSentence: null, requestImplies: '`index ranges can only be numerical: got "{}" (type HASH)`',
      intentPins: '`index ranges can only be numerical: got "{ }" (type HASH)`', raw: '[pin-doubt] ...', undeclared: false, pinDoubt: true } }], items);
  assert.equal(out.reason, 'intent_conflict_amend', `${out.reason}: ${out.why.slice(0, 300)}`);
  noPlaceholder(out.cli.payload);
  assert.equal(out.cli.payload.status, 'pending');
});

await check('B3 PLAN lint empty_collection: a spaced empty group the base writes as separate bracket literals is ONE ready patch; a request stating it decides', async () => {
  const conflictsOf = await load('../core/pin-base-print.js', 'pinBasePrintConflicts');
  const files = [{ path: 'object/hash.go', text: 'func (h *Hash) Inspect() string {\n\tout.WriteString("{")\n\tout.WriteString(strings.Join(pairs, ", "))\n\tout.WriteString("}")\n}\n' }];
  const items = [item('CHK-002', { adversarial: [{ desc: 'type({}) -> got "{ }" (type HASH)' }] })];
  const out = conflictsOf({ items, requestText: 'Ranges reject a hash operand.', files }).filter((row: { kind: string }) => row.kind === 'empty_collection');
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0].baseForm, 'got "{}" (type HASH)');
  assert.equal(conflictsOf({ items, requestText: 'It prints `got "{ }"`.', files }).filter((row: { kind: string }) => row.kind === 'empty_collection').length, 0, 'the request states the spaced form');
  const spaced = [{ path: 'object/hash.go', text: 'out.WriteString("{ ")\nout.WriteString(" }")\n' }];
  assert.equal(conflictsOf({ items, requestText: null, files: spaced }).filter((row: { kind: string }) => row.kind === 'empty_collection').length, 0, 'a base that writes spaced brackets decides nothing');
});

// ---------------------------------------------------------------------------
// C. Review straggler

await check('C1 the straggler decision: every sibling terminal, past max(floor, 2 x median completed sibling)', async () => {
  const decide = await load('../core/managed-host-run.js', 'reviewStragglerDecision');
  const min = 60_000;
  const done = (minutes: number) => ({ terminal: true, completed: true, durationMs: minutes * min });
  const siblings = [done(3.7), done(4.0), done(7.1)];
  assert.equal(decide({ elapsedMs: 8.4 * min, siblings, floorMs: 8 * min }).due, true, 'past max(8, 2 x 4.0)');
  assert.equal(decide({ elapsedMs: 7.9 * min, siblings, floorMs: 8 * min }).due, false, 'under the floor');
  assert.equal(decide({ elapsedMs: 9 * min, siblings: [done(5), done(6), done(7)], floorMs: 8 * min }).due, false, 'under 2 x the median (12)');
  assert.equal(decide({ elapsedMs: 30 * min, siblings: [...siblings, { terminal: false, completed: false, durationMs: null }], floorMs: 8 * min }).due, false, 'a sibling still runs');
  assert.equal(decide({ elapsedMs: 30 * min, siblings, floorMs: 0 }).due, false, 'off');
  assert.equal(decide({ elapsedMs: 30 * min, siblings: [], floorMs: 8 * min }).due, false, 'no siblings (critic, single lane)');
});

await check('C2 the floor: default 8 min, env override (ms, 0 = off), malformed refused; review.stragglerVerdict=off seals 0; the failure is auto-replaceable', async () => {
  const floorOf = await load('../core/managed-host-run.js', 'managedReviewStragglerFloorMs');
  const replaceable = await load('../core/managed-host-run.js', 'isAutoReplaceableManagedLaunchFailure');
  const reason = await load('../core/managed-host-run.js', 'MANAGED_REVIEW_STRAGGLER_FAILED_REASON');
  assert.equal(floorOf({}), 480_000);
  assert.equal(floorOf({ PROOF_OR_STOP_MANAGED_REVIEW_STRAGGLER_MS: '120000' }), 120_000);
  assert.equal(floorOf({ PROOF_OR_STOP_MANAGED_REVIEW_STRAGGLER_MS: '0' }), 0);
  assert.throws(() => floorOf({ PROOF_OR_STOP_MANAGED_REVIEW_STRAGGLER_MS: '8m' }));
  const resetConfig = await load('../core/config.js', 'resetConfigCache');
  const root = mkdtempSync(join(tmpdir(), 'run133-c2-'));
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({ review: { stragglerVerdict: 'off' } }));
    assert.equal(floorOf({}, root), 0, 'switch off');
    write(root, 'proof-or-stop.config.json', JSON.stringify({ review: { stragglerVerdict: 'maybe' } }));
    resetConfig();
    assert.equal(floorOf({}, root), 480_000, 'malformed = on');
  } finally { rmSync(root, { recursive: true, force: true }); resetConfig(); }
  assert.equal(replaceable({ state: 'failed', replacementSafe: true, terminalReason: `${reason} the verdict-now resume exited 1` }), true);
});

await check('C3 the verdict-now prompt forbids further commands and asks for the final JSON from what was read', async () => {
  const promptOf = await load('../core/managed-host-run.js', 'managedReviewVerdictNowPrompt');
  const text = promptOf({ elapsedMs: 8.4 * 60_000, medianMs: 4 * 60_000, siblings: 3 });
  assert.match(text, /Do not run any more commands/);
  assert.match(text, /verdict now from what you have already read/);
  assert.match(text, /final JSON object/);
  assert.match(text, /8\.4 min/);
});

// ---------------------------------------------------------------------------
// D. Duplicate closure

const repo = mkdtempSync(join(tmpdir(), 'run133-d-'));
let repairCommit = '';
try {
  git(repo, ['init', '-q']);
  write(repo, 'evaluator/evaluator.go', 'package evaluator\n');
  git(repo, ['add', '.']); git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
  write(repo, 'evaluator/evaluator_test.go', 'package evaluator\n\nfunc TestUnrelatedThing(t *testing.T) {\n\tcheck(t, "len([1])", 1)\n}\n\nfunc TestStepZeroRangeError(t *testing.T) {\n\tcheck(t, "[1,2,3][::0]", "slice step cannot be zero")\n}\n');
  git(repo, ['add', '.']); git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'repair F-001']);
  repairCommit = git(repo, ['rev-parse', 'HEAD']);
} catch (error) { console.log(`setup: ${String(error)}`); }
const findings = () => [
  { id: `${STORY}:F-001`, severity: 'high', desc: 'Range step zero is accepted. evaluator/evaluator.go:120 never rejects step 0.', status: 'resolved', resolvedReason: `repaired in ${repairCommit.slice(0, 12)}`, files: ['evaluator/evaluator.go'] },
  { id: `${STORY}:F-008`, severity: 'high', desc: 'A zero step in a range slice is not rejected: [1,2,3][::0] returns a value instead of the step error.', status: 'open', files: [] },
];

await check('D1 the duplicate coverage is prefilled from the canonical repair commit\'s Go test sharing most terms with the duplicate', async () => {
  const suggest = await load('../core/duplicate-auto-coverage.js', 'duplicateCoverageSuggestion');
  const [canonical, duplicate] = findings();
  const out = suggest({ gitCwd: repo, finding: duplicate, canonical });
  assert.ok(out, 'a suggestion');
  assert.equal(out.test, 'TestStepZeroRangeError');
  assert.equal(out.command, 'go test -v ./evaluator -run ^TestStepZeroRangeError$');
  assert.equal(out.selector, '--- PASS: TestStepZeroRangeError');
  assert.equal(out.commit, repairCommit);
  assert.deepEqual(out.others, ['TestUnrelatedThing']);
});

await check('D2 the duplicate step is ready (no placeholder) and names each finding\'s gist, the repair commit and tests, and where the findings are', async () => {
  const stepOf = await load('../handlers/next-driver.js', 'duplicateFindingResolveStep');
  const batchOf = await load('../handlers/next-driver.js', 'duplicateResolveBatchStep');
  const [canonical, duplicate] = findings();
  const context = { gitCwd: repo, findings: findings(), findingsPath: `.proof-or-stop/story/actives/${STORY}/findings.json` };
  const single = stepOf({ storyId: STORY, phase: 'REVIEW' }, duplicate, canonical, null, context);
  noPlaceholder(single.cli.payload);
  assert.equal((single.cli.payload.coverage as { command: string }).command, 'go test -v ./evaluator -run ^TestStepZeroRangeError$');
  assert.match(single.why, /A zero step in a range slice is not rejected/);
  assert.match(single.why, new RegExp(repairCommit.slice(0, 12)));
  assert.match(single.why, /findings\.json/);
  const other = { ...duplicate, id: `${STORY}:F-009`, desc: 'Unrelated duplicate text.' };
  const batch = batchOf({ storyId: STORY, phase: 'REVIEW' }, [{ finding: duplicate, canonical, familyKey: null }, { finding: other, canonical, familyKey: null }],
    { ...context, findings: [...findings(), other] });
  assert.match(batch.why, /F-008: "A zero step in a range slice is not rejected/);
  assert.match(batch.why, /findings\.json/);
});
rmSync(repo, { recursive: true, force: true });

if (failures.length) {
  console.log(`run133-fixes-smoke: ${failures.length} check(s) FAILED: ${failures.join(' | ')}`);
  process.exitCode = 1;
} else {
  console.log('run133-fixes-smoke: all checks passed');
}
