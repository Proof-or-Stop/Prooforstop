#!/usr/bin/env node
/**
 * Lab run131 (old-PoS runs 127-131; bench-staging/oldpos/run131-analysis.md, run127-129-phase-cost.md, run127-analysis.md):
 * unit level, made-up rows only (no benchmark-task material). The lifecycle shapes are harness NSG / NSG-X / NIO / NFC /
 * NPV / NMC / NDI / NSL in tasks/e2e-review-to-done-smoke.ts; the proxy's stream-timeout retry is adapter
 * scripts/test_opencode_credential_proxy.py.
 *
 *   A. Scope gate (run 131 F-024, ~30-45 min): a reviewer "scope violation" finding against documentation the
 *      deterministic scope gate admits (classifyScopePath: documentation-default / allowedModify) is the losing side of a
 *      file-state conflict: settled once (resolutionType superseded, `[file_state_conflict]` reason with the gate verdict),
 *      never repaired, never guarded, never a finding_conflict_pin. A scope finding about an excluded / unknown path or a
 *      code file stands. Review lanes are told which docs the gate admits. Switch remediation.scopeGateSettle.
 *   B. Intent conflict overrule (run 131 cycle 1): an amend that re-asserts the pin an implementer's [intent-conflict]
 *      disputed, with no request sentence stating it and no base check confirming it, is refused with ONE ready row
 *      patch to the implementer's value; intent_conflict_amend carries that ready patch. Switch plan.intentConflictGuard.
 *   C. Finding conflict settle (runs 128 / 129 null-end ping-pong): a finding whose repair was rejected for breaking a
 *      resolved finding's covering test, on a case a current checklist row pins the way that test states, loses once
 *      (precedence request text > base behaviour > reviewer opinion): closed by a framework step, never reopened, never
 *      guarded. Switch remediation.conflictSettle.
 *   D. Pin reversal (run 131 PLAN-C): the first `pin_reversal_unstated` refusal carries the remedy as ONE ready command
 *      (request text, else the counterpart, else the pin-dispute remedy), no placeholder.
 *   E. Metadata correction (run 131 PLAN-B: 15 refusals): the framework writes the corrected rows; a refusal names the
 *      exact next command.
 *   F. Lane import lineage (run 127 R2 discarded): a delta-confirmation refusal commit (process-events only, delta-round
 *      records) does not invalidate a sibling lane reviewed before it; any other event type still does.
 *   G. Provider stalls (run 131 ~22 min): a no-item stall window, review_round_prepare for named lanes only.
 *
 * Usage: node packages/main/dist/tasks/run131-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const noPlaceholder = (value: unknown): void => assert.doesNotMatch(JSON.stringify(value), /<[a-z][^<>]*>/i, `no placeholder: ${JSON.stringify(value).slice(0, 400)}`);

const STORY = 'B-1310';
const DOC = 'docs/types/list.md';
const contractOf = (extra: Record<string, unknown> = {}) => ({
  storyId: STORY, mode: 'enforce', allowedModify: ['eval/eval.go'], allowedCreate: [], allowedTest: ['eval/eval_test.go'],
  protectedFiles: [], explicitExcludes: [], acknowledgements: [], pathCanonicalizerVersion: 'repo-relative-v1', pathCanonicalizationMode: 'enforce',
  createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z', ...extra,
});
/** Run 131 F-024's shape (made-up text): a lane calls the repair's doc edit a scope violation. */
const SCOPE_FINDING = { id: `${STORY}:F-024`, desc: `Scope violation: the repair of F-016 edited ${DOC}, but the scope-contract allowedModify lists no docs (only eval/eval.go); revert the documentation edit.`,
  files: [DOC], severity: 'medium', status: 'open', evidenceState: 'verified' };
const REQUEST = ['Support stepped ranges on lists.', '', '- `xs[a:b:c]` selects every c-th element from a up to b.', '- Existing two-part ranges keep their current behaviour.', ''].join('\n');

// ---------------------------------------------------------------------------
// A. Scope gate

await check('A1 a scope-violation finding on a doc the scope gate admits (documentation-default) is settled once: gate verdict recorded, no repair', async () => {
  const conflictOf = await load('../core/file-state-conflict.js', 'fileStateConflictOf');
  const out = conflictOf({ finding: SCOPE_FINDING, findings: [], contract: contractOf(), requestText: REQUEST, boundaryExcluded: [] });
  assert.equal(out?.settle, true, JSON.stringify(out));
  assert.equal(out.winner, 'scope_gate');
  assert.deepEqual(out.files, [DOC]);
  assert.match(out.reason, /^\[file_state_conflict\]/);
  assert.match(out.reason, /documentation-default/);
  assert.match(out.reason, /scope_contract_check/);
  assert.match(out.reason, /severity unchanged/);
});

await check('A2 a scope finding stands when the doc is excluded or protected, the path is unknown to the contract, or a code file is named', async () => {
  const conflictOf = await load('../core/file-state-conflict.js', 'fileStateConflictOf');
  const pattern = (await load('../core/boundary-path-excludes.js', 'DOCUMENTATION_EXCLUDE_PATTERN') as unknown as string);
  assert.ok(!conflictOf({ finding: SCOPE_FINDING, findings: [], contract: contractOf({ explicitExcludes: [pattern] }), requestText: REQUEST, boundaryExcluded: ['changes to docs'] })?.settle, 'excluded doc');
  assert.ok(!conflictOf({ finding: SCOPE_FINDING, findings: [], contract: contractOf({ protectedFiles: [DOC] }), requestText: REQUEST, boundaryExcluded: [] })?.settle, 'protected doc');
  const unknown = { ...SCOPE_FINDING, desc: 'Scope violation: the repair edited internal/cache/cache.go, outside the scope contract; revert it.', files: ['internal/cache/cache.go'] };
  assert.ok(!conflictOf({ finding: unknown, findings: [], contract: contractOf(), requestText: REQUEST, boundaryExcluded: [] })?.settle, 'a path the gate refuses');
  const code = { ...SCOPE_FINDING, desc: 'Scope violation: eval/eval.go now also changes map iteration order, outside the Story scope; revert it.', files: ['eval/eval.go'] };
  assert.ok(!conflictOf({ finding: code, findings: [], contract: contractOf(), requestText: REQUEST, boundaryExcluded: [] })?.settle, 'a code file: a behavioural scope concern stands');
  const mixed = { ...SCOPE_FINDING, files: [DOC, 'internal/cache/cache.go'], desc: `Scope violation: ${DOC} and internal/cache/cache.go are outside the scope contract.` };
  assert.ok(!conflictOf({ finding: mixed, findings: [], contract: contractOf(), requestText: REQUEST, boundaryExcluded: [] })?.settle, 'one refused path keeps it');
});

await check('A3 the gate admission is exported per path (source documentation-default / scope-contract.allowedModify), refusals listed', async () => {
  const admission = await load('../core/file-state-conflict.js', 'scopeGateAdmission');
  const yes = admission(contractOf({ allowedModify: ['eval/eval.go', 'docs/types/string.md'] }), [DOC, 'docs/types/string.md']);
  assert.equal(yes.admitted, true, JSON.stringify(yes));
  assert.deepEqual(yes.rows.map((row: { source: string }) => row.source), ['documentation-default', 'scope-contract.allowedModify']);
  const no = admission(contractOf(), [DOC, 'internal/x.go']);
  assert.equal(no.admitted, false);
});

await check('A4 switch remediation.scopeGateSettle: default on, off = rollback (no settle), malformed = on', async () => {
  const conflictOf = await load('../core/file-state-conflict.js', 'fileStateConflictOf');
  const on = await load('../core/ab-variants.js', 'scopeGateSettleOn');
  assert.equal(on({}), true);
  assert.equal(on({ remediation: { scopeGateSettle: 'off' } }), false);
  assert.equal(on({ remediation: { scopeGateSettle: 'nonsense' } }), true);
  assert.ok(!conflictOf({ finding: SCOPE_FINDING, findings: [], contract: contractOf(), requestText: REQUEST, boundaryExcluded: [], scopeGateSettle: false })?.settle, 'off: rollback');
});

await check('A5 a code review lane is told which documentation the scope gate admits (the inverse of the excluded-docs block)', async () => {
  const lines = await load('../core/file-state-conflict.js', 'scopeAdmittedDocumentationLines');
  const out = (lines({ contract: contractOf(), docs: [DOC] }) as string[]).join('\n');
  assert.match(out, /BEGIN SCOPE-ADMITTED DOCUMENTATION/);
  assert.match(out, new RegExp(DOC.replace(/[.]/g, '\\.')));
  assert.match(out, /documentation-default/);
  assert.match(out, /not a scope violation/i);
  const pattern = (await load('../core/boundary-path-excludes.js', 'DOCUMENTATION_EXCLUDE_PATTERN') as unknown as string);
  assert.deepEqual(lines({ contract: contractOf({ explicitExcludes: [pattern] }), docs: [DOC] }), [], 'excluded docs: the excluded block speaks');
  assert.deepEqual(lines({ contract: contractOf(), docs: [] }), [], 'no doc in the Story diff: nothing to say');
});

// ---------------------------------------------------------------------------
// B. Intent conflict overrule

const LIST_ITEM = (desc: string, computation = 'two-part ranges are exclusive at the end') => ({ id: 'CHK-002', title: 'Evaluate stepped list ranges', userSees: 'xs[1:4:2] returns every second element', status: 'pending',
  verificationIntent: { happy: [{ desc, derivation: { requestQuote: '`xs[a:b:c]` selects every c-th element from a up to b.', computation } }], edge: [], adversarial: [] } });
const CONFLICT = { itemId: 'CHK-002', intentRef: 'CHK-002:happy:0', intentPins: '[10, 30, 50]', requestImplies: '[10, 30]',
  requestSentence: 'Existing two-part ranges keep their current behaviour.', runId: 'run-impl-1' };

await check('B1 an amend that re-asserts the disputed pin (request silent, no base check confirms) is refused with ONE ready row patch to the implementer\'s value', async () => {
  const overrule = await load('../core/intent-conflict-overrule.js', 'intentConflictOverrule');
  const before = LIST_ITEM('`[10, 20, 30, 40, 50][0:4:2] -> [10, 30, 50]`');
  const after = LIST_ITEM('`[10, 20, 30, 40, 50][0:4:2] -> [10, 30, 50]`', 'the end index is inclusive for stepped ranges (re-asserted)');
  const out = overrule({ storyId: STORY, itemId: 'CHK-002', before, afterIntent: after.verificationIntent, conflicts: [CONFLICT], requestText: REQUEST, baseConfirms: () => false });
  assert.ok(out, 'refused');
  assert.match(out.refusal, /\[intent_conflict_overruled\]/);
  assert.match(out.refusal, /Next: proof-or-stop checklist_update '/);
  assert.equal(out.patch.ref, 'CHK-002:happy:0');
  assert.match(out.patch.desc, /-> \[10, 30\]`?$/);
  assert.match(out.patch.derivation.computation, /re-pin: .* was \[10, 30, 50\], now \[10, 30\]/);
  noPlaceholder(out.payload);
});

await check('B2 not refused: the request states the pinned value, the amend adopts the implementer\'s value, a base check confirms the pin, or no open conflict', async () => {
  const overrule = await load('../core/intent-conflict-overrule.js', 'intentConflictOverrule');
  const before = LIST_ITEM('`[10, 20, 30, 40, 50][0:4:2] -> [10, 30, 50]`');
  const kept = LIST_ITEM('`[10, 20, 30, 40, 50][0:4:2] -> [10, 30, 50]`');
  const args = { storyId: STORY, itemId: 'CHK-002', before, afterIntent: kept.verificationIntent, conflicts: [CONFLICT], requestText: REQUEST, baseConfirms: () => false };
  assert.equal(overrule({ ...args, requestText: `${REQUEST}- \`[10, 20, 30, 40, 50][0:4:2]\` gives [10, 30, 50].\n` }), null, 'the request states it');
  assert.equal(overrule({ ...args, afterIntent: LIST_ITEM('`[10, 20, 30, 40, 50][0:4:2] -> [10, 30]`').verificationIntent }), null, 'adopted');
  assert.equal(overrule({ ...args, baseConfirms: () => true }), null, 'a base check confirms the pin');
  assert.equal(overrule({ ...args, conflicts: [] }), null, 'no open conflict');
});

await check('B3 intent_conflict_amend carries the ready row patch (no placeholder) when the conflict names literals', async () => {
  const stepOf = await load('../handlers/next-driver.js', 'intentConflictStep');
  const item = LIST_ITEM('`[10, 20, 30, 40, 50][0:4:2] -> [10, 30, 50]`');
  const step = stepOf({ storyId: STORY, phase: 'PLAN' }, [{ runId: 'run-impl-1', agentType: 'proof-or-stop-implementer', createdAt: '2026-10-21T00:00:00Z', itemId: 'CHK-002',
    conflict: { itemId: 'CHK-002', intentRef: 'CHK-002:happy:0', intentPins: '[10, 30, 50]', requestImplies: '[10, 30]', requestSentence: CONFLICT.requestSentence, raw: 'x' } }], [item]);
  assert.equal(step.reason, 'intent_conflict_amend');
  const call = step.cli ?? step.batch?.[0]?.cli;
  assert.ok(call?.payload?.intentRows, JSON.stringify(step).slice(0, 600));
  noPlaceholder(call.payload);
  assert.match(JSON.stringify(call.payload.intentRows), /\[10, 30\]/);
});

await check('B4 switch plan.intentConflictGuard: default on, off = rollback, malformed = on', async () => {
  const on = await load('../core/ab-variants.js', 'intentConflictGuardOn');
  assert.equal(on({}), true);
  assert.equal(on({ plan: { intentConflictGuard: 'off' } }), false);
  assert.equal(on({ plan: { intentConflictGuard: 'x' } }), true);
});

// ---------------------------------------------------------------------------
// C. Finding conflict settle (null-end / pinned-test ping-pong)

const CASE = '[1, 2, 3][0:null]';
const RESOLVED_G = { id: `${STORY}:F-001`, desc: `eval/eval.go:40 a null end is accepted silently. Repro: \`${CASE}\``, files: ['eval/eval.go'], status: 'resolved', resolutionType: 'fixed',
  resolvedReason: 'Repaired [repair commit abc123]', severity: 'medium', evidenceState: 'verified' };
const OPEN_F = { id: `${STORY}:F-005`, desc: `eval/eval.go:40 a null end should behave like an omitted end. Repro: \`${CASE}\``, files: ['eval/eval.go'], status: 'open', severity: 'medium', evidenceState: 'verified' };
const PIN_ROW_ITEMS = [{ id: 'CHK-001', title: 'Slice bounds', userSees: 'a null bound is an error', status: 'done',
  verificationIntent: { happy: [], edge: [{ desc: `\`${CASE} -> error\``, derivation: { requestQuote: 'A null bound is an error.', computation: 'stated' } }], adversarial: [] } }];
const REJECTED_CONFLICT = { findingId: OPEN_F.id, resolvedId: RESOLVED_G.id, kind: 'rejected', since: '2026-10-21T01:00:00Z', why: 'the repair of F-005 (commit def456) was rejected: it broke resolved F-001' };

await check('C1 a finding whose repair broke a resolved finding\'s test, on a case a row pins as that test states, loses once (request text decides)', async () => {
  const settle = await load('../core/finding-conflict-settle.js', 'findingConflictSettlement');
  const out = settle({ finding: OPEN_F, conflict: REJECTED_CONFLICT, guarded: RESOLVED_G, pins: { pins: ['error'], agrees: true }, items: PIN_ROW_ITEMS,
    requestText: `${REQUEST}- A null bound is an error.\n`, repros: [CASE] });
  assert.equal(out?.settle, true, JSON.stringify(out));
  assert.equal(out.winner, 'request');
  assert.match(out.reason, /^\[finding_conflict_settled\]/);
  assert.match(out.reason, /request text > base behaviour > reviewer opinion/);
  assert.match(out.reason, /F-005/);
  assert.match(out.reason, /F-001/);
  const pinned = settle({ finding: OPEN_F, conflict: REJECTED_CONFLICT, guarded: RESOLVED_G, pins: { pins: ['error'], agrees: true }, items: PIN_ROW_ITEMS, requestText: REQUEST, repros: [CASE] });
  assert.equal(pinned?.winner, 'checklist_pin', 'the PLAN pin decides when the request is silent');
});

await check('C2 not settled: the pin disagrees with the resolved test (the guard excuses it, the finding is repaired), no row pins the case, a [precedent-conflict]', async () => {
  const settle = await load('../core/finding-conflict-settle.js', 'findingConflictSettlement');
  const base = { finding: OPEN_F, conflict: REJECTED_CONFLICT, guarded: RESOLVED_G, items: PIN_ROW_ITEMS, requestText: REQUEST, repros: [CASE] };
  assert.equal(settle({ ...base, pins: { pins: ['[1, 2, 3]'], agrees: false } }), null, 'pin agrees with the finding');
  assert.equal(settle({ ...base, pins: null }), null, 'no row pins the case: one finding_conflict_pin decides it');
  assert.equal(settle({ ...base, pins: { pins: ['error'], agrees: true }, conflict: { ...REJECTED_CONFLICT, resolvedId: null, kind: 'precedent' } }), null, 'precedent conflict');
});

await check('C3 a conflict-settled finding is framework-settled: never guarded, never a conflict partner, never re-verified', async () => {
  const isSettled = await load('../core/finding-conflict-settle.js', 'isConflictSettled');
  const isFrameworkSettled = await load('../core/finding-conflict-settle.js', 'isFrameworkSettled');
  const guardable = await load('../core/resolved-finding-guard.js', 'guardableResolved');
  const closed = { ...OPEN_F, status: 'resolved', resolutionType: 'superseded', resolvedReason: '[finding_conflict_settled] F-005 loses' };
  assert.equal(isSettled(closed), true);
  assert.equal(isFrameworkSettled(closed), true);
  assert.equal(isFrameworkSettled({ ...closed, resolvedReason: '[file_state_conflict] x' }), true);
  assert.deepEqual(guardable([closed]).map((row: { id: string }) => row.id), []);
});

await check('C4 next\'s step is a framework finding_resolve with disposition finding_conflict_settled; the settled case is journaled once and recognised later', async () => {
  const stepOf = await load('../handlers/next-driver.js', 'findingConflictSettleStep');
  const record = await load('../core/finding-conflict-settle.js', 'recordConflictSettlement');
  const settled = await load('../core/finding-conflict-settle.js', 'conflictSettlements');
  const step = stepOf({ storyId: STORY, phase: 'DEV' }, { id: OPEN_F.id, severity: 'medium' }, { settle: true, winner: 'request', reason: '[finding_conflict_settled] x', cases: [CASE] });
  assert.equal(step.kind, 'framework');
  assert.equal(step.reason, 'finding_conflict_settled');
  assert.equal(step.cli.command, 'finding_resolve');
  assert.equal(step.cli.payload.disposition, 'finding_conflict_settled');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run131-c-')));
  try {
    record(root, STORY, { findingId: OPEN_F.id, resolvedId: RESOLVED_G.id, cases: [CASE], winner: 'request', why: 'x' });
    record(root, STORY, { findingId: OPEN_F.id, resolvedId: RESOLVED_G.id, cases: [CASE], winner: 'request', why: 'x' });
    const rows = settled(root, STORY);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.deepEqual(rows[0].cases, [CASE]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await check('C5 a later finding re-judging a settled case against the same resolved finding (same-case conflict) is settled by the record, no PLAN trip', async () => {
  const settle = await load('../core/finding-conflict-settle.js', 'findingConflictSettlement');
  const later = { ...OPEN_F, id: `${STORY}:F-009`, desc: `eval/eval.go:41 null end must mean an omitted end. Repro: \`${CASE}\`` };
  const out = settle({ finding: later, conflict: { findingId: later.id, resolvedId: RESOLVED_G.id, kind: 'same_case', since: '2026-10-21T02:00:00Z', why: 're-judges' },
    guarded: RESOLVED_G, pins: null, items: PIN_ROW_ITEMS, requestText: REQUEST, repros: [CASE], settledCases: [{ resolvedId: RESOLVED_G.id, cases: [CASE], winner: 'request' }] });
  assert.equal(out?.settle, true, JSON.stringify(out));
});

await check('C6 switch remediation.conflictSettle: default on, off = rollback, malformed = on', async () => {
  const on = await load('../core/ab-variants.js', 'conflictSettleOn');
  assert.equal(on({}), true);
  assert.equal(on({ remediation: { conflictSettle: 'off' } }), false);
  assert.equal(on({ remediation: { conflictSettle: 'x' } }), true);
});

// ---------------------------------------------------------------------------
// D. Pin reversal: the remedy at the first refusal

const REV_ITEM = (desc: string, computation = 'stepped end') => ({ id: 'CHK-001', title: 'Stepped text ranges', userSees: 'text ranges step by rune', status: 'pending', excludes: [] as string[],
  files: { modify: ['eval/eval.go'] }, verificationIntent: { happy: [{ desc, derivation: { requestQuote: '`xs[a:b:c]` selects every c-th element from a up to b.', computation } }], edge: [], adversarial: [] } });

await check('D1 the request states the new value: the refusal carries the owner\'s update with the re-pin stated (ready, passes the reversal check)', async () => {
  const remedy = await load('../core/pin-amendment.js', 'pinReversalRemedy');
  const reversals = await load('../core/pin-amendment.js', 'unstatedPinReversals');
  const before = REV_ITEM('`"abcdef"[:4:2] -> "ace"`');
  const after = REV_ITEM('`"abcdef"[:4:2] -> "ac"`');
  const request = `${REQUEST}- \`"abcdef"[:4:2]\` gives "ac".\n`;
  const out = remedy({ storyId: STORY, item: before, afterIntent: after.verificationIntent, reversals: reversals(before.verificationIntent, after.verificationIntent), requestText: request });
  assert.ok(out, 'remedy');
  assert.equal(out.kind, 'repin');
  noPlaceholder(out.payload);
  assert.deepEqual(reversals(before.verificationIntent, out.payload.verificationIntent), [], 'the ready update passes the reversal check');
  assert.match(JSON.stringify(out.payload), /re-pin: .*was \\?"ace\\?", now \\?"ac\\?"/);
});

await check('D2 the request states the old value: the ready update keeps the earlier pin', async () => {
  const remedy = await load('../core/pin-amendment.js', 'pinReversalRemedy');
  const reversals = await load('../core/pin-amendment.js', 'unstatedPinReversals');
  const before = REV_ITEM('`"abcdef"[:4:2] -> "ace"`');
  const after = REV_ITEM('`"abcdef"[:4:2] -> "ac"`');
  const out = remedy({ storyId: STORY, item: before, afterIntent: after.verificationIntent, reversals: reversals(before.verificationIntent, after.verificationIntent),
    requestText: `${REQUEST}- \`"abcdef"[:4:2]\` gives "ace".\n` });
  assert.equal(out?.kind, 'keep');
  assert.match(JSON.stringify(out.payload), /\\"ace\\"/);
  assert.deepEqual(reversals(before.verificationIntent, out.payload.verificationIntent), []);
  noPlaceholder(out.payload);
});

await check('D3 the request is silent and no counterpart decides: the pin-dispute remedy applies at the FIRST reversal (ready, no placeholder)', async () => {
  const remedy = await load('../core/pin-amendment.js', 'pinReversalRemedy');
  const reversals = await load('../core/pin-amendment.js', 'unstatedPinReversals');
  const before = REV_ITEM('`"abcdef"[:4:2] -> "ace"`');
  const after = REV_ITEM('`"abcdef"[:4:2] -> "ac"`');
  const out = remedy({ storyId: STORY, item: before, afterIntent: after.verificationIntent, reversals: reversals(before.verificationIntent, after.verificationIntent), requestText: REQUEST });
  assert.ok(out, 'remedy');
  assert.match(out.kind, /^(?:exclude|relax|counterpart)$/);
  noPlaceholder(out.payload);
});

await check('D4 the refusal renders the remedy as its ONE Next (no placeholder)', async () => {
  const refusal = await load('../core/pin-amendment.js', 'pinReversalRefusal');
  const text = refusal({ storyId: STORY, itemId: 'CHK-001', reversals: [{ caseText: '"abcdef"[:4:2]', oldValue: '"ace"', newValue: '"ac"' }],
    remedy: { kind: 'repin', why: 'the request states "ac"', payload: { storyId: STORY, itemId: 'CHK-001', verificationIntent: { happy: [] } } } }) as string;
  assert.match(text, /\[pin_reversal_unstated\]/);
  const next = text.slice(text.indexOf('Next:'));
  assert.doesNotMatch(next, /<[a-z][^<>]*>/i, next);
  assert.match(next, /checklist_update '\{"storyId":"B-1310","itemId":"CHK-001"/);
});

// ---------------------------------------------------------------------------
// E. Metadata correction

const META_ITEM = { id: 'CHK-005', title: 'Assign through text ranges', userSees: 'assigning `s[0:2] = "xy"` replaces two runes', status: 'pending',
  verificationIntent: { happy: [{ desc: 's = "abcd"; s[0:2] = "xy" makes s "xycd"', derivation: { requestQuote: 'Text ranges count runes.', computation: 's[0:2] = "xy" covers runes 0 and 1' } }], edge: [], adversarial: [] } };
const META_CORRECTION = { itemId: 'CHK-005', field: 'verificationIntent', rowRefs: ['CHK-005:happy:0'], wrongLiteral: 's[0:2] = "xy"', correctedValue: '"ab"', fieldHash: null };

await check('E1 a statement literal is corrected on its value side in desc and computation, and the result clears the correction', async () => {
  const ready = await load('../core/metadata-correction.js', 'metadataCorrectionReadyPatch');
  const cleared = await load('../core/metadata-correction.js', 'metadataCorrectionCleared');
  const out = ready(META_ITEM, META_CORRECTION);
  assert.ok(out?.intentRows?.length, JSON.stringify(out));
  assert.equal(out.intentRows[0].ref, 'CHK-005:happy:0');
  assert.match(out.intentRows[0].desc, /s\[0:2\] = "ab"/);
  assert.doesNotMatch(`${out.intentRows[0].desc} ${out.intentRows[0].derivation.computation}`, /s\[0:2\] = "xy"/);
  const patched = structuredClone(META_ITEM);
  patched.verificationIntent.happy[0] = { ...patched.verificationIntent.happy[0], ...out.intentRows[0] };
  assert.equal(cleared(patched, META_CORRECTION), true);
  noPlaceholder(out);
});

await check('E2 userSees is corrected in place; no ready patch when the reviewer gave no value', async () => {
  const ready = await load('../core/metadata-correction.js', 'metadataCorrectionReadyPatch');
  const out = ready(META_ITEM, { ...META_CORRECTION, field: 'userSees', rowRefs: [] });
  assert.match(out?.userSees ?? '', /s\[0:2\] = "ab"/);
  assert.equal(ready(META_ITEM, { ...META_CORRECTION, correctedValue: null }), null);
});

await check('E3 metadata_correction in PLAN carries the ready rows (no placeholder)', async () => {
  const stepOf = await load('../handlers/next-driver.js', 'metadataCorrectionStep');
  const step = stepOf({ storyId: STORY, phase: 'PLAN' }, [{ ...META_CORRECTION, key: 'k', sources: [{ desc: 'CHK-005:happy:0 states s[0:2] = "xy"; it should be "ab"', findingId: `${STORY}:F-014` }] }], [META_ITEM]);
  const call = step.cli ?? step.batch?.[0]?.cli;
  noPlaceholder(call?.payload);
  assert.equal(call.payload.metadataCorrection, true);
});

await check('E4 the refusals name the exact next command: _unchanged the ready rows, _none the same update without metadataCorrection (PLAN) or the open corrections', async () => {
  const unchanged = await load('../core/metadata-correction.js', 'metadataCorrectionUnchangedNext');
  const none = await load('../core/metadata-correction.js', 'metadataCorrectionNoneNext');
  const a = unchanged({ storyId: STORY, item: META_ITEM, corrections: [META_CORRECTION] }) as string;
  assert.match(a, /^Next: proof-or-stop checklist_update '/);
  assert.match(a, /s\[0:2\] = \\"ab\\"/);
  const b = none({ storyId: STORY, phase: 'PLAN', args: { storyId: STORY, itemId: 'CHK-003', intentRows: [{ ref: 'CHK-003:happy:0', desc: 'x -> y' }], metadataCorrection: true }, open: [META_CORRECTION] }) as string;
  assert.match(b, /^Next: proof-or-stop checklist_update '/);
  assert.doesNotMatch(b, /metadataCorrection/);
  assert.match(b, /CHK-005/, 'names the open correction');
});

// ---------------------------------------------------------------------------
// F. Lane import lineage

await check('F1 a delta-confirmation refusal commit (process-events only, delta-round records) keeps a sibling lane\'s evidence valid; another event type is still refused', async () => {
  const verify = await load('../core/managed-review-evidence.js', 'verifyManagedReviewLiveBinding');
  const { currentMaterialHash, currentStoryFilesHash } = await import('../core/evidence-freshness.js');
  const { resetConfigCache } = await import('../core/config.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run131-f-')));
  try {
    resetConfigCache();
    git(root, ['init', '-q', '-b', 'main']);
    const events = `.proof-or-stop/story/actives/${STORY}/process-events.jsonl`;
    write(root, 'eval/eval.go', 'package eval\n');
    write(root, events, `${JSON.stringify({ type: 'dispatch', storyId: STORY })}\n`);
    const reviewed = commit(root, 'story');
    const expected = { headHash: reviewed, materialHash: currentMaterialHash(root, 'HEAD', root)!, storyFilesHash: currentStoryFilesHash(root, 'HEAD', root)! };
    const subject = `proof-or-stop: record ${STORY} managed_review_evidence_import metadata`;
    const append = (types: string[]) => { writeFileSync(join(root, events), `${readFileSync(join(root, events), 'utf8')}${types.map(type => JSON.stringify({ type, storyId: STORY })).join('\n')}\n`); return commit(root, subject); };
    append(['delta_round_reverified', 'delta_round_confirmation_gap', 'managed_review_import_refused']);
    const ok = verify({ gitCwd: root, metadataRoot: root, storyId: STORY, expected });
    assert.equal(ok.valid, true, JSON.stringify(ok));
    append(['finding_resolved']);
    const refused = verify({ gitCwd: root, metadataRoot: root, storyId: STORY, expected });
    assert.equal(refused.valid, false, 'a non-refusal record still invalidates');
    assert.match(String(refused.reason), /managed_review_live_head_lineage_invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); resetConfigCache(); }
});

// ---------------------------------------------------------------------------
// G. Provider stalls

await check('G1 a managed provider with no item yet has a shorter stall window (default 150 s, env override, 0 = the ordinary window only)', async () => {
  const windowOf = await load('../core/managed-host-run.js', 'managedProviderFirstItemWindowMs');
  assert.equal(windowOf({}), 150_000);
  assert.equal(windowOf({ PROOF_OR_STOP_MANAGED_PROVIDER_FIRST_ITEM_MS: '20000' }), 20_000);
  assert.equal(windowOf({ PROOF_OR_STOP_MANAGED_PROVIDER_FIRST_ITEM_MS: '0' }), 0);
  assert.throws(() => windowOf({ PROOF_OR_STOP_MANAGED_PROVIDER_FIRST_ITEM_MS: '-1' }));
});

await check('G2 the stdout event that ends the no-item phase: an item / turn end / error event, never thread.started or turn.started', async () => {
  const isItem = await load('../core/managed-host-run.js', 'providerItemEventSeen');
  assert.equal(isItem('{"type":"thread.started","thread_id":"t"}\n{"type":"turn.started"}\n'), false);
  assert.equal(isItem('{"type":"item.completed","item":{"type":"reasoning"}}\n'), true);
  assert.equal(isItem('{"type":"turn.failed","error":{}}\n'), true);
});

await check('G3 review_round_prepare accepts lanes (only the named lanes are dispatched; a running sibling is never restarted)', async () => {
  const catalog = await import('../cli/command-catalog.js') as Record<string, unknown>;
  const rows = (Object.values(catalog).find(value => Array.isArray(value) && (value as Array<{ name?: string }>).some(row => row?.name === 'review_round_prepare')) ?? []) as Array<{ name: string; schema: Record<string, unknown> }>;
  const entry = rows.find(row => row.name === 'review_round_prepare');
  assert.ok(entry?.schema?.lanes, 'review_round_prepare schema has lanes');
});

console.log(failures.length ? `\nrun131-fixes-smoke: ${failures.length} FAIL (${failures.join(', ')})` : '\nrun131-fixes-smoke: all checks passed');
process.exit(failures.length ? 1 : 0);
