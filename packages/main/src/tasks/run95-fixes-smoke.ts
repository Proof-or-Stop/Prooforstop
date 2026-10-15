#!/usr/bin/env node
/**
 * Old-PoS runs 93-96 (bench-staging/oldpos/run93-96-analysis.md §7 fixes 1, 2, 4; lab `codex/lab-run95`). Unit level
 * (pure functions and real git repositories). Generic examples only (a made-up `kv` store with `put` / `del` / `run`);
 * no benchmark-task material. The lifecycle shapes are harness NUP, NPR, NPR-C and NPXF.
 *
 *   R. Row patches: `{ref, remove: true}` (also `drop: true`) removes the row and names the index moves; a remove with
 *      other fields, a remove of an append and a removal that would re-point recorded evidence are refused; a field
 *      that is not a row field is refused (nothing written), with the allowed fields; the authoring templates no
 *      longer say "drop" for "leave out of the patch".
 *   U. Unstated pinned text: a row pinning an exact text neither the request nor the Story base states is listed with
 *      a ready patch (an error row relaxed to "<case> -> error", other rows removed); a request literal, a base
 *      message / format string and a template instance quoting its scope are not; a template instance answering a
 *      verdict whose quote is outside the template's scope is (`template_scope`).
 *   X. Exclusion vs userSees: an excludes entry the item's own userSees names gets the userSees without those clauses
 *      (one command, both fields); one the item's title adds cannot be excluded at all.
 *   D. Pin dispute: a row cited by gaps of two consecutive verdicts is disputed; its remedy is a ready command
 *      (relax an error pin; remove + exclude with the userSees edit; else re-pin).
 *   N. Near-miss exact rows: an exact-text gap whose string a row of the item already carries is a patch of that row.
 *   B. The pre-existing disposition is a framework step.
 *   S. The A/B switch plan.disputeConfirm (default off).
 *   F. The story_create template states the row rules and the framework-source rule.
 *
 * Usage: node packages/main/dist/tasks/run95-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { verificationIntentItemSchema } from '../cli/command-schemas.js';

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
  assert.ok(fn !== undefined, `${path} exports ${name}`);
  return fn as Fn;
}
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const row = (desc: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story',
  verification: { command: 'go test -v ./kv -run ^TestKv$', selector: '--- PASS: TestKv' }, ...extra });
const refusal = (fn: () => unknown): string => {
  try { fn(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error('expected a refusal');
};

// ---------------------------------------------------------------------------
// R. Row patches

const ITEM = { id: 'CHK-001', verificationIntent: { happy: [row('kv.put("a", "1"); kv.get("a") -> "1"')],
  edge: [row('kv.get("x") -> error "first"'), row('kv.get("y") -> error "second"'), row('kv.get("z") -> error "third"')], adversarial: [] } };
const patch = async (patches: unknown, item: Record<string, unknown> = ITEM) => (await load('../core/intent-row-patch.js', 'applyIntentRowPatches'))(
  { storyId: 'B-9501', item, patches, withWholeIntent: false, withProposalApproval: false }) as { verificationIntent: Record<string, Array<{ desc: string }>>; refs: string[]; removed: string[]; moved: Array<{ from: string; to: string }> };

await check('R1 {ref, remove:true} removes the row (drop:true is the same op), later rows move up, and the result names the removal and each move', async () => {
  const removed = await patch([{ ref: 'CHK-001:edge:0', remove: true }]);
  assert.deepEqual(removed.verificationIntent.edge!.map(entry => entry.desc), ['kv.get("y") -> error "second"', 'kv.get("z") -> error "third"']);
  assert.deepEqual(removed.removed, ['CHK-001:edge:0']);
  assert.deepEqual(removed.moved, [{ from: 'CHK-001:edge:1', to: 'CHK-001:edge:0' }, { from: 'CHK-001:edge:2', to: 'CHK-001:edge:1' }]);
  assert.ok(!JSON.stringify(removed.verificationIntent).includes('"remove"'), 'the op is never written into a row');
  const dropped = await patch([{ ref: 'CHK-001:edge:1', drop: true }, { ref: 'CHK-001:edge:2', desc: 'kv.get("z") -> error "3rd"' }]);
  assert.deepEqual(dropped.verificationIntent.edge!.map(entry => entry.desc), ['kv.get("x") -> error "first"', 'kv.get("z") -> error "3rd"'], 'a patch of a later row in the same call keeps its target');
  assert.deepEqual(dropped.refs, ['CHK-001:edge:1'], 'the patched row is named by its new ref');
  const note = await load('../core/intent-row-patch.js', 'intentRowPatchNote');
  assert.match(String(note(dropped)), /removed CHK-001:edge:1; renumbered CHK-001:edge:2 -> CHK-001:edge:1/);
});

await check('R2 a remove with other fields, a remove of an append and a removal that re-points recorded evidence are refused [intent_rows_invalid]', async () => {
  const apply = await load('../core/intent-row-patch.js', 'applyIntentRowPatches');
  const run = (patches: unknown, item: Record<string, unknown> = ITEM) => () => apply({ storyId: 'B-9501', item, patches, withWholeIntent: false, withProposalApproval: false });
  assert.match(refusal(run([{ ref: 'CHK-001:edge:0', remove: true, desc: 'x -> y' }])), /intent_rows_invalid[\s\S]*remove/);
  assert.match(refusal(run([{ ref: 'CHK-001:edge:+', desc: 'a -> b', remove: true }])), /intent_rows_invalid/);
  const withEvidence = { ...ITEM, verificationEvidence: [{ intentRef: 'CHK-001:edge:2', kind: 'logic_test', note: 'n' }] };
  assert.match(refusal(run([{ ref: 'CHK-001:edge:0', remove: true }], withEvidence)), /re-point the recorded verification evidence of CHK-001:edge:2/);
  // A removal after the evidence-bound row shifts nothing bound: allowed.
  const tail = await patch([{ ref: 'CHK-001:edge:2', remove: true }], withEvidence as never).catch(() => null);
  assert.equal(tail, null, 'removing the bound row itself is refused too');
});

await check('R3 a field that is not a row field is refused and nothing is written; the allowed fields are the row schema\'s', async () => {
  const fields = await load('../core/intent-row-patch.js', 'INTENT_ROW_FIELDS') as unknown as string[];
  const schemaKeys = Object.keys((verificationIntentItemSchema as unknown as { shape: Record<string, unknown> }).shape).filter(key => key !== 'id');
  assert.deepEqual([...fields].sort(), schemaKeys.sort(), 'the allowed list is the schema');
  const apply = await load('../core/intent-row-patch.js', 'applyIntentRowPatches');
  const message = refusal(() => apply({ storyId: 'B-9501', item: ITEM, patches: [{ ref: 'CHK-001:edge:0', bogus: true }], withWholeIntent: false, withProposalApproval: false }));
  assert.match(message, /"bogus", which is not a row field[\s\S]*\[intent_rows_invalid\]/);
  assert.match(message, /remove":true\} removes a row/);
  assert.match(refusal(() => apply({ storyId: 'B-9501', item: ITEM, patches: [{ ref: 'CHK-001:edge:+', desc: 'a -> b', kind: 'x' }], withWholeIntent: false, withProposalApproval: false })), /"kind", which is not a row field/);
});

await check('R4 the authoring templates say "leave out of the patch", never "drop" an appended row', async () => {
  const payloadOf = await load('../core/plan-lint-preview.js', 'preScopeItemPayload');
  const payload = payloadOf('B-9501', ITEM, undefined, [], ['put rejected']) as Record<string, unknown>;
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /drop this row/i);
  assert.match(text, /leave this append out of the patch/);
});

// ---------------------------------------------------------------------------
// U. Unstated pinned text

const KV_REQUEST = [
  'Add `kv.put(key, value)` and `kv.del(key)` to the store.',
  '',
  '- `kv.put(k, v)` stores v under k.',
  '- `kv.del(k)` removes k.',
  '- Error strings must match exactly:',
  '  - Putting a value under a frozen key:',
  '    - `put rejected: key <K> is frozen`',
  '  - Putting a non-string key:',
  '    - `put expects STRING key, got <TYPE>`',
  '',
].join('\n');
const KV_BASE = [{ path: 'kv/kv.go', text: 'package kv\n\nfunc run(name string) error { return fmt.Errorf("unknown command: %s", name) }\nvar errEmpty = errors.New("store is empty right now")\n' }];
const kvItems = (edge: Array<Record<string, unknown>>) => [{ id: 'CHK-001', status: 'pending', verificationIntent: { happy: [row('kv.put("a", "1"); kv.get("a") -> "1"')], edge, adversarial: [] } }];

await check('U1 an exact text neither the request nor the base states is listed; request literals, base messages / format strings and scoped template instances are not', async () => {
  const pinsOf = await load('../core/unstated-pin.js', 'unstatedPins');
  const edge = [
    row('kv.get("missing") -> error "no such key in the store: missing"'),
    row('kv.put("f", "1") on a frozen key -> error "put rejected: key f is frozen"', { derivation: { requestQuote: 'Putting a value under a frozen key:', computation: 'K=f: put rejected: key f is frozen' } }),
    row('kv.run("zap") -> error "unknown command: zap"'),
    row('kv.get("") on an empty store -> error "store is empty right now"'),
    row('kv.get("a") -> "1"'),
  ];
  const pins = pinsOf({ items: kvItems(edge), requestText: KV_REQUEST, files: KV_BASE }) as Array<{ ref: string; kind: string; value: string; error: boolean }>;
  assert.deepEqual(pins.map(pin => [pin.ref, pin.kind]), [['CHK-001:edge:0', 'unstated']], JSON.stringify(pins));
  assert.equal(pins[0]!.error, true);
  assert.deepEqual(pinsOf({ items: kvItems(edge), requestText: KV_REQUEST, files: null }), [], 'an unreadable base lists no unstated row');
});

await check('U2 a template instance answering a verdict is listed when its derivation quotes no line of the template\'s scope (run-95 shape), not when it does', async () => {
  const pinsOf = await load('../core/unstated-pin.js', 'unstatedPins');
  const misScoped = row('kv.del(5) -> error, and the whole error equals "put expects STRING key, got NUMBER"', { derivation: { requestQuote: '`kv.del(k)` removes k.', computation: 'a NUMBER key is rejected: put expects STRING key, got NUMBER' } });
  const scoped = row('kv.put(5, "1") -> error "put expects STRING key, got NUMBER"', { derivation: { requestQuote: 'Putting a non-string key:', computation: 'TYPE=NUMBER: put expects STRING key, got NUMBER' } });
  const changed = new Set(['CHK-001:edge:0', 'CHK-001:edge:1']);
  const pins = pinsOf({ items: kvItems([misScoped, scoped]), requestText: KV_REQUEST, files: KV_BASE, changedRefs: changed }) as Array<{ ref: string; kind: string; template?: string; scope?: string[] }>;
  assert.deepEqual(pins.map(pin => [pin.ref, pin.kind]), [['CHK-001:edge:0', 'template_scope']], JSON.stringify(pins));
  assert.equal(pins[0]!.template, 'put expects STRING key, got <TYPE>');
  assert.ok(pins[0]!.scope!.some(line => /Putting a non-string key/.test(line)), 'the scope the request gives the template');
  assert.deepEqual(pinsOf({ items: kvItems([misScoped]), requestText: KV_REQUEST, files: KV_BASE }), [], 'not answering a verdict: left to the reviewer');
});

await check('U3 the ready row patch relaxes an error row to "<case> -> error" (derivation kept), removes any other row; the pre-check text names [unstated_pin]', async () => {
  const pinsOf = await load('../core/unstated-pin.js', 'unstatedPins');
  const patchOf = await load('../core/unstated-pin.js', 'unstatedPinRowPatch');
  const describe = await load('../core/unstated-pin.js', 'describeUnstatedPin');
  const errorRow = row('kv.get("missing") -> error "no such key in the store: missing"', { derivation: { requestQuote: '`kv.put(k, v)` stores v under k.', computation: 'x' } });
  const valueRow = row('kv.dump() -> "store holds exactly one key now"');
  const pins = pinsOf({ items: kvItems([errorRow, valueRow]), requestText: KV_REQUEST, files: KV_BASE }) as Array<Record<string, unknown>>;
  assert.equal(pins.length, 2);
  const relaxed = patchOf(pins[0], errorRow, KV_REQUEST) as { ref: string; desc: string; derivation: { requestQuote: string; computation: string } };
  assert.equal(relaxed.desc, 'kv.get("missing") -> error');
  assert.equal(relaxed.derivation.requestQuote, '`kv.put(k, v)` stores v under k.');
  assert.match(relaxed.derivation.computation, /error$/);
  assert.deepEqual(patchOf(pins[1], valueRow, KV_REQUEST), { ref: 'CHK-001:edge:1', remove: true });
  assert.match(String(describe(pins[0])), /neither the request states nor a Story base source contains/);
});

// ---------------------------------------------------------------------------
// X. Exclusion vs userSees

await check('X1 an excludes entry the item\'s userSees names: the userSees without those clauses; one the title adds: no exclusion route', async () => {
  const remedyOf = await load('../core/scope-exclusion-rationale.js', 'exclusionUserSeesRemedy');
  const item = { id: 'CHK-002', title: 'Store put and get commands', status: 'pending',
    userSees: 'kv.put stores a value under its key. A frozen bucket rejects writes with the frozen-bucket error. kv.get returns the stored value.' };
  const entry = 'Writes to a frozen bucket: the request does not state the error text';
  const remedy = remedyOf(entry, item) as { contradictedBy: string; userSees?: string; dropped: string[] };
  assert.equal(remedy.contradictedBy, 'userSees', JSON.stringify(remedy));
  assert.deepEqual(remedy.dropped, ['A frozen bucket rejects writes with the frozen-bucket error.']);
  assert.equal(remedy.userSees, 'kv.put stores a value under its key. kv.get returns the stored value.');
  const titled = remedyOf('Store put of a frozen bucket: out of scope', { ...item, title: 'Store put into a frozen bucket' }) as { contradictedBy: string };
  assert.equal(titled.contradictedBy, 'title_or_files');
  assert.equal((remedyOf('Network sync replication: out of scope', item) as { contradictedBy: string }).contradictedBy, 'none');
});

// ---------------------------------------------------------------------------
// D. Pin dispute

await check('D1 a row cited by gaps of two consecutive verdicts is disputed (streak counted); a row cited once is not', async () => {
  const disputedOf = await load('../core/pin-dispute.js', 'disputedRows');
  const verdict = (at: string, gaps: string[]) => ({ checkedAt: at, features: gaps.map(feature => ({ feature, status: 'gap', covered_by: null, excluded_by: null })) });
  const history = [
    verdict('t3', ['pin-audit CHK-001:edge:0: pins "x"; request gives nothing', 'Precedent conflict: something CHK-001:edge:2']),
    verdict('t2', ['pin-audit CHK-001:edge:0: pins "y"; request gives nothing']),
    verdict('t1', ['pin-audit CHK-001:edge:0: pins "z"; request gives nothing', 'pin-audit CHK-001:edge:2: pins "w"; request gives v']),
  ];
  const disputes = disputedOf(history) as Array<{ ref: string; verdicts: number }>;
  assert.deepEqual(disputes.map(row => [row.ref, row.verdicts]), [['CHK-001:edge:0', 3]]);
  assert.deepEqual(disputedOf(history.slice(0, 1)), []);
});

await check('D2 the remedy is ONE ready command: relax an error pin; remove + exclude with the userSees edit for a value pin; re-pin when the item adds the case', async () => {
  const remedyOf = await load('../core/pin-dispute.js', 'pinDisputeRemedy');
  const dispute = { ref: 'CHK-002:edge:0', itemId: 'CHK-002', lane: 'edge', index: 0, verdicts: 2, features: [] };
  const base = { id: 'CHK-002', title: 'Store put and get commands', status: 'pending', excludes: [] as string[],
    userSees: 'kv.put stores a value under its key. A dump of a frozen bucket prints its summary line. kv.get returns the stored value.' };
  const errorItem = { ...base, verificationIntent: { happy: [], edge: [row('kv.put(5, "1") -> error, whole error equals "put expects STRING key, got NUMBER"', { derivation: { requestQuote: 'Putting a non-string key:', computation: 'x' } })], adversarial: [] } };
  const relax = remedyOf({ storyId: 'B-9501', item: errorItem, dispute, requestText: KV_REQUEST }) as { kind: string; payload: { intentRows: Array<{ desc: string }> } };
  assert.equal(relax.kind, 'relax');
  assert.equal(relax.payload.intentRows[0]!.desc, 'kv.put(5, "1") -> error');
  const valueItem = { ...base, verificationIntent: { happy: [], edge: [row('kv.dump() of a frozen bucket -> "frozen bucket summary line"')], adversarial: [] } };
  const exclude = remedyOf({ storyId: 'B-9501', item: valueItem, dispute, requestText: KV_REQUEST }) as { kind: string; payload: Record<string, unknown> };
  assert.equal(exclude.kind, 'exclude', JSON.stringify(exclude));
  assert.deepEqual(exclude.payload.intentRows, [{ ref: 'CHK-002:edge:0', remove: true }]);
  assert.match(String((exclude.payload.excludes as string[])[0]), /^kv\.dump\(\) of a frozen bucket: the request does not state/);
  assert.equal(exclude.payload.userSees, 'kv.put stores a value under its key. kv.get returns the stored value.');
  assert.doesNotMatch(JSON.stringify(exclude.payload), /"<[^"]*>"/, 'nothing to author');
  const titled = { ...valueItem, title: 'Store dump of a frozen bucket summary line' };
  assert.equal((remedyOf({ storyId: 'B-9501', item: titled, dispute, requestText: KV_REQUEST }) as { kind: string }).kind, 'repin');
});

await check('D3 the verdict history is the current scope-check.json plus its Git history (one entry per checkedAt)', async () => {
  const historyOf = await load('../core/pin-dispute.js', 'scopeVerdictHistory');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run95-history-')));
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'o']);
    git(root, ['config', 'user.email', 'o@x.invalid']);
    const dir = join(root, '.proof-or-stop', 'story', 'actives', 'B-9501');
    for (const at of ['t1', 't2']) {
      write(root, '.proof-or-stop/story/actives/B-9501/scope-check.json', JSON.stringify({ checkedAt: at, features: [{ feature: `pin-audit CHK-001:edge:0 (${at})`, status: 'gap' }] }));
      git(root, ['add', '-A']);
      git(root, ['commit', '-qm', at]);
    }
    const store = { readScopeCheck: () => ({ checkedAt: 't2', features: [] }), storyDirPath: () => dir };
    const history = historyOf({ store, storyId: 'B-9501', gitCwd: root }) as Array<{ checkedAt: string }>;
    assert.deepEqual(history.map(row => row.checkedAt), ['t2', 't1']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// N, B, S, F

await check('N1 an exact-text gap whose string a row of the item carries is a patch of that row (it states the exact comparison), not a new placeholder', async () => {
  const rowsOf = await load('../core/plan-lint-preview.js', 'coverageIntentRows');
  const item = { id: 'CHK-001', verificationIntent: { happy: [], edge: [row('kv.put(5, "1") -> `put expects STRING key, got NUMBER`')], adversarial: [] } };
  const gap = { rule: 'exact-text', key: 'coverage-gap exact-text put expects STRING key', itemId: 'CHK-001', op: 'exact', literal: 'put expects STRING key, got <TYPE>',
    sentences: ['Putting a non-string key:'], example: 'x', nearMiss: ['CHK-001:edge:0'] };
  const rows = rowsOf([gap], 'CHK-001', item) as Array<Record<string, unknown>>;
  assert.deepEqual(rows, [{ ref: 'CHK-001:edge:0', desc: 'kv.put(5, "1") -> `put expects STRING key, got NUMBER` (exact: the whole text equals it)' }]);
  assert.equal((rowsOf([gap], 'CHK-001') as unknown[]).length, 1, 'without the item: the placeholder as before');
});

await check('B1 the pre-existing finding disposition is a framework step (next --run records it and launches the repair of the others)', async () => {
  const stepOf = await load('../handlers/next-driver.js', 'preexistingDispositionStep');
  const step = stepOf({ storyId: 'B-9501', phase: 'DEV' }, { id: 'B-9501:F-001', severity: 'medium', desc: 'docs drift at docs/x.md:3' }, { eligible: true, reason: 'pre-existing at the Story base' }) as { kind: string; reason: string; cli: { command: string; payload: Record<string, unknown> } };
  assert.equal(step.kind, 'framework');
  assert.equal(step.reason, 'finding_preexisting_disposition');
  assert.equal(step.cli.payload.disposition, 'preexisting_out_of_scope');
  assert.doesNotMatch(JSON.stringify(step.cli.payload), /"<[^"]*>"/);
});

await check('S1 plan.disputeConfirm is a known A/B switch, default off, malformed = off where consumed', async () => {
  const flags = await import('../core/ab-variants.js') as unknown as { AB_VARIANT_FLAGS: Record<string, readonly string[]>; resolveAbVariants: Fn; disputeConfirmOn?: Fn };
  assert.deepEqual([...(flags.AB_VARIANT_FLAGS['plan.disputeConfirm'] ?? [])], ['off', 'on']);
  assert.equal((flags.resolveAbVariants({}) as Record<string, unknown>).disputeConfirm, 'off');
  assert.equal(typeof flags.disputeConfirmOn, 'function');
  assert.equal(flags.disputeConfirmOn!({ plan: { disputeConfirm: 'maybe' } }), false);
  assert.equal(flags.disputeConfirmOn!({ plan: { disputeConfirm: 'on' } }), true);
});

await check('F1 the story_create template states the row rules and that the installed framework is not the project (never read it)', async () => {
  const templateOf = await load('../handlers/next-driver.js', 'storyCreateTemplateStep');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run95-template-')));
  try {
    const step = templateOf(root) as { why: string };
    assert.match(step.why, /`<input> -> <expected>`/);
    assert.match(step.why, /\[unstated_pin\]/);
    assert.match(step.why, /do not read or grep its source/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

if (failures.length) {
  console.error(`run95-fixes-smoke: FAIL (${failures.length}: ${failures.join('; ')})`);
  process.exit(1);
}
console.log('run95-fixes-smoke: PASS');
