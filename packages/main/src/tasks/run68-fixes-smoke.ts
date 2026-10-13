#!/usr/bin/env node
/**
 * Old-PoS run 68 detection-neutral fixes (bench-staging/oldpos/run68-analysis.md §4-§6;
 * lab `codex/lab-run68-fixes`). Unit level (pure functions, one real git repository).
 * Generic examples only (a toy `Reverse` / `Pick` module); no benchmark-task material.
 * The lifecycle shapes are harness NMW (metadata-only wave) and NRV (repair re-pin).
 *
 *   G. Dead end (fix 2): REVIEW->DEV refused for an OPEN epoch of the round pointed at the
 *      read-only `review_inventory_status`; the gate's Next is now `next --run` (it launches
 *      the critic / finalizes the epoch).
 *   X. Repair re-pin (fix 3): a verified finding's repair changes the expected literal of a
 *      test row; every checklist intent row stating `<same case> -> <old value>` gets a
 *      framework row patch (`re-pin: <case> was <old>, now <new>`) applied in PLAN before
 *      the next round. A case the request states literally is never re-pinned.
 *      X1 the test-diff parser; X2 the row patch; X3 a real repair commit; X4 the open
 *      correction and its framework steps (DEV hop, PLAN patch); X5 the request guard.
 *   P. Pattern propagation (fix 4): an [intent-conflict] whose pin differs from the
 *      request in FORM (not only in its literal) sweeps every row of any item stating the
 *      same form with another literal (P1), never a row that only shares the literal kind
 *      (P2). PLAN lint (P3-P5): exact whole-error-text pins are flagged (advisory), a
 *      request exact string is never flagged, and a base error rendering with a trailing
 *      decoration is recognised.
 *
 * Usage: node packages/main/dist/tasks/run68-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as nextDriver from '../handlers/next-driver.js';
import * as epochModule from '../core/review-inventory-epoch.js';
import * as metadataModule from '../core/metadata-correction.js';
import { unstatedPinReversals } from '../core/pin-amendment.js';
import type { ChecklistItem, VerificationIntent } from '../core/types.js';

type Fn = (...args: unknown[]) => unknown;
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error)}`); }
}
/** A module export that may not exist yet (RED: the check fails, the smoke still runs). */
async function load(path: string, name: string): Promise<Fn> {
  const module = await import(path) as Record<string, unknown>;
  const fn = module[name];
  assert.equal(typeof fn, 'function', `${path} exports ${name}`);
  return fn as Fn;
}
const api = (module: object, name: string): Fn => {
  const fn = (module as Record<string, unknown>)[name];
  assert.equal(typeof fn, 'function', `${name} is exported`);
  return fn as Fn;
};
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const row = (desc: string, extra: Record<string, unknown> = {}) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story', ...extra });
const item = (id: string, lanes: { happy?: Array<string | Record<string, unknown>>; edge?: Array<string | Record<string, unknown>>; adversarial?: Array<string | Record<string, unknown>> },
  status: ChecklistItem['status'] = 'pending'): ChecklistItem => {
  const of = (rows?: Array<string | Record<string, unknown>>) => (rows ?? []).map(entry => (typeof entry === 'string' ? row(entry) : entry));
  return { id, title: `item ${id}`, status, verificationIntent: { happy: of(lanes.happy), edge: of(lanes.edge), adversarial: of(lanes.adversarial) } as unknown as VerificationIntent } as ChecklistItem;
};

// ---------------------------------------------------------------------------
// G. dead end

await check('G1 REVIEW->DEV refused for an OPEN epoch of the round points at next --run, never at the read-only status', () => {
  const store = { readReviewInventoryEpochs: () => ({ epochs: [{ epochId: 'B-1:RI-002', state: 'OPEN', reviewRound: 'R2' }] }) };
  const gate = api(epochModule, 'reviewInventoryRemediationGate')(store, 'B-1', 'R2') as { ok: boolean; reason?: string; nextCommand?: string };
  assert.equal(gate.ok, false);
  assert.match(gate.reason ?? '', /still OPEN/);
  assert.equal(gate.nextCommand, 'proof-or-stop next --storyId=B-1 --run', `the OPEN-epoch pointer: ${gate.nextCommand}`);
});

// ---------------------------------------------------------------------------
// X. repair re-pin

const MODULE = '../core/repair-value-change.js';
const TABLE_DIFF = [
  'diff --git a/kv/reverse_test.go b/kv/reverse_test.go',
  '--- a/kv/reverse_test.go',
  '+++ b/kv/reverse_test.go',
  '@@ -12,2 +12,2 @@ func TestReverseEdges(t *testing.T) {',
  '-\t\t{"trailing newline", Reverse("ab\\n"), "\\nba"},',
  '-\t\t{"negative start", `[1,2,3][-1::-1]`, "[1]"},',
  '+\t\t{"trailing newline", Reverse("ab\\n"), "ba\\n"},',
  '+\t\t{"negative start", `[1,2,3][-1::-1]`, "[3, 2, 1]"},',
  'diff --git a/kv/reverse.go b/kv/reverse.go',
  '--- a/kv/reverse.go',
  '+++ b/kv/reverse.go',
  '@@ -3 +3 @@',
  '-\treturn "x"',
  '+\treturn "y"',
  'diff --git a/kv/pick_test.go b/kv/pick_test.go',
  '--- a/kv/pick_test.go',
  '+++ b/kv/pick_test.go',
  '@@ -4,0 +5 @@',
  '+\t\t{"added", Pick(1), "1"},',
  '@@ -9 +10 @@',
  '-\t\t{"two literals", Pick("a"), "1"},',
  '+\t\t{"two literals", Pick("b"), "2"},',
].join('\n');

await check('X1 the test diff yields each changed expected literal with its unchanged case (product files, additions and multi-literal edits ignored)', async () => {
  const changes = (await load(MODULE, 'testLiteralChanges'))(TABLE_DIFF) as Array<{ file: string; old: string; new: string; before: string }>;
  assert.deepEqual(changes.map(change => [change.file, change.old, change.new]), [
    ['kv/reverse_test.go', '"\\nba"', '"ba\\n"'],
    ['kv/reverse_test.go', '"[1]"', '"[3, 2, 1]"'],
  ], JSON.stringify(changes));
  assert.ok(changes[0]!.before.includes('Reverse("ab\\n")'), 'the removed line is kept as the case context');
});

const REVERSE_ITEM = () => item('CHK-002', {
  edge: [row('Reverse keeps every rune: `Reverse("ab\\n") -> "\\nba"`', { derivation: { requestQuote: 'Reverse reverses by rune.', computation: 'the runes of "ab\\n" reversed' } }),
    '`[1,2,3][-1::-1]` -> `[1]`', 'Reverse("xy") -> "yx"'],
}, 'done');
const CHANGES = [
  { file: 'kv/reverse_test.go', before: '{"trailing newline", Reverse("ab\\n"), "\\nba"},', after: '{"trailing newline", Reverse("ab\\n"), "ba\\n"},', old: '"\\nba"', new: '"ba\\n"' },
  { file: 'kv/reverse_test.go', before: '{"negative start", `[1,2,3][-1::-1]`, "[1]"},', after: '{"negative start", `[1,2,3][-1::-1]`, "[3, 2, 1]"},', old: '"[1]"', new: '"[3, 2, 1]"' },
];

await check('X2 every intent row stating <case> -> <old value> gets a row patch with the new value and the stated re-pin (the run-58 reversal check passes)', async () => {
  const before = REVERSE_ITEM();
  const patches = (await load(MODULE, 'repairRowPatches'))([before], CHANGES, null) as Array<{ itemId: string; ref: string; desc: string; derivation?: { computation?: string }; caseText: string; oldValue: string; newValue: string }>;
  assert.deepEqual(patches.map(patch => patch.ref), ['CHK-002:edge:0', 'CHK-002:edge:1'], JSON.stringify(patches));
  assert.equal(patches[0]!.desc, 'Reverse keeps every rune: `Reverse("ab\\n") -> "ba\\n"`');
  assert.equal(patches[1]!.desc, '`[1,2,3][-1::-1]` -> `[3, 2, 1]`', 'the quote style of the row is kept (unquoted value stays unquoted)');
  for (const patch of patches) assert.match(`${patch.desc} ${patch.derivation?.computation ?? ''}`, /re-pin: .+ was .+, now .+/, `re-pin stated: ${JSON.stringify(patch)}`);
  assert.equal(patches[0]!.derivation?.computation?.includes('re-pin: Reverse("ab\\n") was "\\nba", now "ba\\n"'), true, JSON.stringify(patches[0]));
  const after = structuredClone(before.verificationIntent!) as unknown as { edge: Array<Record<string, unknown>> };
  for (const patch of patches) {
    const index = Number(patch.ref.split(':')[2]);
    after.edge[index] = { ...after.edge[index], desc: patch.desc, ...(patch.derivation ? { derivation: patch.derivation } : {}) };
  }
  assert.deepEqual(unstatedPinReversals(before.verificationIntent, after as unknown as VerificationIntent), [], 'the patch states every re-pin (pin_reversal_unstated would not fire)');
  const unrelated = (await load(MODULE, 'repairRowPatches'))([item('CHK-003', { edge: ['Reverse("zz\\n") -> "\\nba"'] })], CHANGES, null) as unknown[];
  assert.deepEqual(unrelated, [], 'the same old value on another case is never touched');
});

await check('X3 a real repair commit: the changed expected literal is read from its own test diff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'run68-x3-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q'); git('config', 'user.email', 'x@example.invalid'); git('config', 'user.name', 'x');
    write(root, 'kv/reverse.go', 'package kv\n\nfunc Reverse(s string) string { return s }\n');
    write(root, 'kv/reverse_test.go', 'package kv\n\nvar cases = []struct{ in, want string }{\n\t{"ab\\n", "\\nba"},\n\t{"xy", "yx"},\n}\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    write(root, 'kv/reverse.go', 'package kv\n\nfunc Reverse(s string) string { return s + "" }\n');
    write(root, 'kv/reverse_test.go', 'package kv\n\nvar cases = []struct{ in, want string }{\n\t{"ab\\n", "ba\\n"},\n\t{"xy", "yx"},\n}\n');
    git('add', '-A'); git('commit', '-qm', 'repair');
    const changes = (await load(MODULE, 'repairValueChangesOfCommit'))(root, git('rev-parse', 'HEAD')) as Array<{ old: string; new: string }>;
    assert.deepEqual(changes.map(change => [change.old, change.new]), [['"\\nba"', '"ba\\n"']], JSON.stringify(changes));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await check('X4 the journaled change is an open intent-row correction: DEV hops to PLAN (framework), PLAN applies the row patch as a framework checklist_update', async () => {
  const eventType = String(((await import(MODULE)) as Record<string, unknown>).REPAIR_VALUE_CHANGED_EVENT ?? '');
  assert.equal(eventType, 'repair_expected_value_changed');
  const items = [item('CHK-001', { happy: ['Upper("ab") -> "AB"'] }, 'done'), REVERSE_ITEM()];
  const events = [{ type: eventType, storyId: 'B-1', findingIds: ['B-1:F-001'], commit: 'a'.repeat(40), changes: CHANGES }];
  const store = { readProcessEvents: () => events, readChecklist: () => ({ items }), readFindings: () => ({ findings: [] }), storyFilePath: (_: string, name: string) => `/nonexistent/${name}` };
  const open = api(metadataModule, 'openMetadataCorrections')({ store, storyId: 'B-1', gitCwd: '/nonexistent' }) as Array<{ itemId: string; field: string; rowRefs: string[] }>;
  assert.deepEqual(open.map(row => [row.itemId, row.field, row.rowRefs]), [['CHK-002', 'verificationIntent', ['CHK-002:edge:0', 'CHK-002:edge:1']]], JSON.stringify(open));
  const dev = nextDriver.metadataCorrectionStep({ storyId: 'B-1', phase: 'DEV' }, open as never, items);
  assert.equal(dev.reason, 'metadata_correction_plan');
  assert.equal(dev.kind, 'framework');
  const plan = nextDriver.metadataCorrectionStep({ storyId: 'B-1', phase: 'PLAN' }, open as never, items);
  assert.equal(plan.kind, 'framework', `the derived row patch is the framework's (no owner authoring): ${plan.why}`);
  assert.equal(plan.cli?.command, 'checklist_update');
  const payload = plan.cli!.payload as { itemId: string; metadataCorrection?: boolean; intentRows?: Array<{ ref: string; desc: string }>; reason?: string };
  assert.equal(payload.itemId, 'CHK-002');
  assert.equal(payload.metadataCorrection, true);
  assert.deepEqual(payload.intentRows?.map(patch => patch.ref), ['CHK-002:edge:0', 'CHK-002:edge:1']);
  assert.ok(!JSON.stringify(payload).match(/"<[^"]*>"/), `no placeholder: ${JSON.stringify(payload)}`);
  assert.match(String(payload.reason), /repair/);
  // Once the rows state the new values, nothing is open.
  const patched = REVERSE_ITEM();
  const intent = patched.verificationIntent as unknown as { edge: Array<Record<string, unknown>> };
  for (const patch of payload.intentRows!) intent.edge[Number(patch.ref.split(':')[2])] = { ...intent.edge[Number(patch.ref.split(':')[2])], ...patch, ref: undefined };
  const store2 = { ...store, readChecklist: () => ({ items: [items[0]!, patched] }) };
  assert.deepEqual(api(metadataModule, 'openMetadataCorrections')({ store: store2, storyId: 'B-1', gitCwd: '/nonexistent' }), [], 'cleared after the patch');
});

await check('X5 a case the request states literally with the old value is never re-pinned (the request outranks the repair)', async () => {
  const request = 'Keep the existing behaviour: `Reverse("ab\\n") -> "\\nba"`.';
  const patches = (await load(MODULE, 'repairRowPatches'))([REVERSE_ITEM()], CHANGES, request) as Array<{ ref: string }>;
  assert.deepEqual(patches.map(patch => patch.ref), ['CHK-002:edge:1'], JSON.stringify(patches));
});

// ---------------------------------------------------------------------------
// P. pattern propagation + PLAN lint

const ERROR_ITEMS = () => [
  item('CHK-002', { edge: ['`Pick(0, 0)` -> exact whole error equals `step cannot be 0`', '`Pick(1, 1)` -> exact whole error equals `start out of range`'] }, 'done'),
  item('CHK-003', { edge: ['`Pick("a", 1)` -> exact whole error equals `start must be INTEGER, got STRING`'] }, 'pending'),
  item('CHK-004', { adversarial: ['`Pick(1, "b")` -> exact whole error equals `step must be INTEGER, got STRING`'], happy: ['`Pick(1, 2)` -> `[1, 2]`'] }, 'pending'),
  item('CHK-005', { edge: ['`Pick(9, 1)` -> an error whose message starts with `start out of range`'] }, 'pending'),
];
const FORM_CONFLICT = { runId: 'r1', agentType: 'proof-or-stop-implementer', createdAt: new Date().toISOString(), itemId: 'CHK-002',
  conflict: { intentRef: 'CHK-002:edge:0', itemId: 'CHK-002', requestSentence: 'Errors keep the existing error format: the message starts with the reason.',
    requestImplies: 'an error whose message starts with `step cannot be 0`', intentPins: 'exact whole error equals `step cannot be 0`', raw: '[intent-conflict] CHK-002:edge:0 | ...', undeclared: false } };

await check('P1 a form conflict (exact whole error vs "starts with") sweeps every row stating the same form, any item and the same item, with row-level patches in ONE step', () => {
  const next = nextDriver.intentConflictStep({ storyId: 'B-1', phase: 'PLAN' }, [FORM_CONFLICT], ERROR_ITEMS());
  const calls = (next.batch ?? [{ cli: next.cli }]).map(call => call.cli as { command: string; payload: Record<string, unknown> });
  assert.deepEqual(calls.map(call => String(call.payload.itemId)), ['CHK-002', 'CHK-003', 'CHK-004'], `one step for every item stating the form: ${JSON.stringify(calls.map(call => call.payload.itemId))}`);
  for (const ref of ['CHK-002:edge:1', 'CHK-003:edge:0', 'CHK-004:adversarial:0']) assert.ok(next.why.includes(ref), `the step lists ${ref}: ${next.why.slice(0, 600)}`);
  assert.ok(!next.why.includes('CHK-004:happy:0'), 'a value row of the same item is not swept');
  assert.ok(!next.why.includes('CHK-005'), 'a row already stating the request form is not swept');
  const sibling = calls.find(call => call.payload.itemId === 'CHK-004')!.payload;
  assert.deepEqual((sibling.intentRows as Array<{ ref: string }>).map(patch => patch.ref), ['CHK-004:adversarial:0'], 'row-level patch of the sibling rows only');
});

await check('P2 a value conflict (same form, another literal) still sweeps only the identical literal (no form sweep)', () => {
  const conflict = { ...FORM_CONFLICT, conflict: { ...FORM_CONFLICT.conflict, requestImplies: 'exact whole error equals `step must not be 0`', intentPins: 'exact whole error equals `step cannot be 0`' } };
  const next = nextDriver.intentConflictStep({ storyId: 'B-1', phase: 'PLAN' }, [conflict], ERROR_ITEMS());
  const calls = (next.batch ?? [{ cli: next.cli }]).map(call => call.cli as { command: string; payload: Record<string, unknown> });
  assert.deepEqual(calls.map(call => String(call.payload.itemId)), ['CHK-002'], `only the conflicting item: ${JSON.stringify(calls.map(call => call.payload.itemId))}`);
});

const LINT = '../core/exact-error-pin-lint.js';
await check('P3 PLAN lint: rows pinning the exact whole error text are listed; prefix rows and value rows are not', async () => {
  const pins = (await load(LINT, 'exactWholeErrorPins'))(ERROR_ITEMS(), null) as Array<{ ref: string; message: string }>;
  assert.deepEqual(pins.map(pin => pin.ref), ['CHK-002:edge:0', 'CHK-002:edge:1', 'CHK-003:edge:0', 'CHK-004:adversarial:0'], JSON.stringify(pins));
  assert.equal(pins[0]!.message, 'step cannot be 0');
});

await check('P4 PLAN lint never flags an error text the request says must match exactly', async () => {
  const request = 'The error message must match exactly: `step cannot be 0`.';
  const pins = (await load(LINT, 'exactWholeErrorPins'))(ERROR_ITEMS(), request) as Array<{ ref: string }>;
  assert.ok(!pins.some(pin => pin.ref === 'CHK-002:edge:0'), `the request-exact row is not flagged: ${JSON.stringify(pins)}`);
  assert.ok(pins.some(pin => pin.ref === 'CHK-003:edge:0'), 'other rows still are');
});

await check('P5 a base error rendering with a trailing decoration (a position / source line after the message) is recognised; a bare message is not', async () => {
  const decoration = await load(LINT, 'errorDecoration');
  assert.equal(decoration('ERROR: step cannot be 0\n\t[1:5]\tPick(0, 0)'), '\n\t[1:5]\tPick(0, 0)');
  assert.equal(decoration('step cannot be 0'), null);
  assert.equal(decoration('step cannot be 0\n'), null, 'a trailing newline alone is no decoration');
});

if (failures.length) {
  console.error(`run68-fixes-smoke: FAIL (${failures.length}: ${failures.join('; ')})`);
  process.exit(1);
}
console.log('run68-fixes-smoke: PASS');
