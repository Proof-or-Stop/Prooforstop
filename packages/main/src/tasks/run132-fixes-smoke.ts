#!/usr/bin/env node
/**
 * Lab run132 (old-PoS run 132; bench-staging/oldpos/run132-analysis.md): unit level, made-up rows only (no
 * benchmark-task material). The lifecycle shapes are harness NUA / NAB / NBP in tasks/e2e-review-to-done-smoke.ts.
 *
 *   A. Unknown arguments (run 132 I1, ~3.3 min): `story_update {"background": ...}` printed "updated" and wrote nothing
 *      (the CLI strips a key the schema does not declare). A Story-metadata edit command now refuses an undeclared key,
 *      naming the command that owns it (one ready Next when the value carries over); output flags stay accepted. The
 *      INIT blocker guidance names the exact command per cited input instead of "story_update / checklist_update /
 *      background".
 *   C. Bare intent-conflict values (run 132 D1, ~1.0 min): an `[intent-conflict]` whose two values are unbackticked
 *      variants of one error text is read as two literals (ready amend patch, adoption), and a `re-pin:` clause in a
 *      row's computation (which keeps the old value by design) does not count as the row still stating the old pin.
 *   D. Base printer (run 132 D2, ~1.5 min): a pinned message that instantiates a Story base format string is compared
 *      with what that format prints (its fixed text, a quoting verb, and base test instances of the same format);
 *      a mismatch is ONE ready row patch; a quoted slot value no base evidence decides is an advisory only.
 *
 * Usage: node packages/main/dist/tasks/run132-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const noPlaceholder = (value: unknown): void => assert.doesNotMatch(JSON.stringify(value), /<[a-z][^<>]*>/i, `no placeholder: ${JSON.stringify(value).slice(0, 400)}`);

const STORY = 'B-1320';
const BACKGROUND = '## Trigger Event\nOn 2026-10-21 ...';

// ---------------------------------------------------------------------------
// A. Unknown arguments

await check('A1 story_update with a key it does not declare (background) is refused, naming the command that owns it, with ONE ready Next', async () => {
  const refusalOf = await load('../cli/unknown-argument.js', 'unknownArgumentRefusal');
  const tools = (await import('../cli/command-catalog.js')).MAIN_TOOLS;
  const out = refusalOf({ command: 'story_update', parsed: { storyId: STORY, background: BACKGROUND }, tools });
  assert.ok(out, 'refused');
  assert.deepEqual(out.keys, ['background']);
  assert.match(out.text, /story_update REFUSED, nothing was written/);
  assert.match(out.text, /\[unknown_argument\]/);
  assert.match(out.text, /background_set/, 'names the command that owns the key');
  assert.match(out.text, /background_append/, 'and its sibling');
  assert.match(out.next, /^proof-or-stop background_set /, `the Next: ${out.next}`);
  const payload = JSON.parse(out.next.slice('proof-or-stop background_set '.length).replace(/^'|'$/g, '').replace(/'\\''/g, "'")) as Record<string, unknown>;
  assert.deepEqual(payload, { storyId: STORY, content: BACKGROUND }, 'the value carries over to the owning field');
});

await check('A2 a key that is a typo of the command\'s own argument names it (did you mean --title); the Next is the corrected call', async () => {
  const refusalOf = await load('../cli/unknown-argument.js', 'unknownArgumentRefusal');
  const tools = (await import('../cli/command-catalog.js')).MAIN_TOOLS;
  const out = refusalOf({ command: 'story_update', parsed: { storyId: STORY, titel: 'New title' }, tools });
  assert.ok(out, 'refused');
  assert.match(out.text, /--title/);
  const payload = JSON.parse(out.next.slice('proof-or-stop story_update '.length).replace(/^'|'$/g, '').replace(/'\\''/g, "'")) as Record<string, unknown>;
  assert.deepEqual(payload, { storyId: STORY, title: 'New title' });
});

await check('A3 declared keys, output flags and owner-lease meta pass; commands outside the metadata editors keep the permissive parser', async () => {
  const refusalOf = await load('../cli/unknown-argument.js', 'unknownArgumentRefusal');
  const tools = (await import('../cli/command-catalog.js')).MAIN_TOOLS;
  assert.equal(refusalOf({ command: 'story_update', parsed: { storyId: STORY, title: 'x', json: true, takeover: true }, tools }), null);
  assert.equal(refusalOf({ command: 'checklist_update', parsed: { storyId: STORY, itemId: 'CHK-001', intentRows: [], reason: 'r', status: 'pending' }, tools }), null);
  assert.equal(refusalOf({ command: 'validate', parsed: { story: STORY, legacyFlag: 'x' }, tools }), null, 'validate keeps its non-strict contract');
  const cl = refusalOf({ command: 'checklist_update', parsed: { storyId: STORY, itemId: 'CHK-001', background: 'x' }, tools });
  assert.ok(cl && /background_set/.test(cl.text), 'checklist_update shares the mechanism');
});

await check('A4 a long carried value is staged in a payload file (the Next is `@<file>`)', async () => {
  const refusalOf = await load('../cli/unknown-argument.js', 'unknownArgumentRefusal');
  const tools = (await import('../cli/command-catalog.js')).MAIN_TOOLS;
  const staged: Array<{ command: string; payload: Record<string, unknown> }> = [];
  const long = `${BACKGROUND}\n${'x'.repeat(3000)}`;
  const out = refusalOf({ command: 'story_update', parsed: { storyId: STORY, background: long }, tools,
    stage: (command: string, payload: Record<string, unknown>) => { staged.push({ command, payload }); return '/tmp/staged.json'; } });
  assert.equal(out.next, 'proof-or-stop background_set @/tmp/staged.json');
  assert.deepEqual(staged, [{ command: 'background_set', payload: { storyId: STORY, content: long } }]);
});

await check('A5 the INIT blocker guidance names the exact command for each input an issue cites', async () => {
  const commandsOf = await load('../core/init-blocker-fix.js', 'initBlockerFixCommands');
  const lines = commandsOf(STORY, [
    { agentId: 'proof-or-stop-product-reviewer', issue: { severity: 'high', kind: 'requirements_ambiguous', requirementRef: 'background:Solution Tradeoffs', desc: 'The background says inclusive.' } },
    { agentId: 'proof-or-stop-product-reviewer', issue: { severity: 'high', kind: 'requirements_ambiguous', requirementRef: 'checklist:CHK-002', desc: 'CHK-002 context says inclusive.' } },
    { agentId: 'proof-or-stop-product-reviewer', issue: { severity: 'high', kind: 'verification_plan_unexecutable', requirementRef: 'verification-intent:CHK-003:edge:1', desc: 'row unexecutable' } },
    { agentId: 'proof-or-stop-review-story-init', issue: { severity: 'high', kind: 'story_metadata_inconsistent', requirementRef: 'story:priority', desc: 'priority high' } },
  ]) as string[];
  const text = lines.join('\n');
  assert.match(text, /background_set --storyId=B-1320/, text);
  assert.match(text, /"itemId":"CHK-002"/, text);
  assert.match(text, /"itemId":"CHK-003"[^\n]*"intentRows":\[\{"ref":"CHK-003:edge:1"/, text);
  assert.match(text, /story_update --storyId=B-1320 --priority=/, text);
  assert.doesNotMatch(text, /story_update \/ checklist_update \/ background/);
  // An issue citing no input: every editor is named.
  const none = (commandsOf(STORY, [{ agentId: 'x', issue: { severity: 'high', desc: 'unclear' } }]) as string[]).join('\n');
  assert.match(none, /background_set/);
  assert.match(none, /checklist_update/);
  assert.match(none, /story_update/);
});

// ---------------------------------------------------------------------------
// C. Bare intent-conflict values

const PINNED = 'unsupported operand: "k" for LIST';
const IMPLIED = 'unsupported operand: k for LIST';
const CONFLICT = { itemId: 'CHK-001', intentRef: 'CHK-001:adversarial:0', intentPins: PINNED, requestImplies: IMPLIED, requestSentence: 'A non-numeric operand keeps the existing operand error format', runId: 'run-1' };
const CASE = 'xs["k"]';
const ROW = { desc: `${CASE} -> ${PINNED}`, derivation: { requestQuote: 'A non-numeric operand keeps the existing operand error format.', computation: 'the operand is the string k' } };
const item = (row: Record<string, unknown>, userSees = 'xs[i] errors on a non-numeric operand') => ({ id: 'CHK-001', status: 'pending', userSees, verificationIntent: { happy: [], edge: [], adversarial: [row] } });

await check('C1 unbackticked variants of one error text are read as the pinned and the implied literal; prose is not', async () => {
  const pairOf = await load('../core/intent-conflict-overrule.js', 'intentConflictPair');
  assert.deepEqual(pairOf(CONFLICT), { pinned: PINNED, implied: IMPLIED });
  assert.equal(pairOf({ ...CONFLICT, intentPins: 'pins the byte slice', requestImplies: 'a rune slice' }), null, 'prose states no literal');
  assert.equal(pairOf({ ...CONFLICT, intentPins: 'the error text', requestImplies: 'unsupported operand: k for LIST' }), null, 'not variants of one text');
  assert.deepEqual(pairOf({ ...CONFLICT, intentPins: '`Upper("ab") == "ab"`', requestImplies: '`Upper("ab") == "AB"`' }), { pinned: 'Upper("ab") == "ab"', implied: 'Upper("ab") == "AB"' }, 'backticked values as before');
});

await check('C2 intent_conflict_amend is ready for bare values: the row re-pinned to the implied text, the re-pin stated', async () => {
  const readyRows = await load('../core/intent-conflict-overrule.js', 'intentConflictReadyRows');
  const rows = readyRows(item(ROW), [CONFLICT], null) as Array<{ ref: string; desc: string; derivation: { computation: string } }>;
  assert.ok(rows?.length === 1, JSON.stringify(rows));
  assert.equal(rows[0]!.desc, `${CASE} -> ${IMPLIED}`);
  assert.match(rows[0]!.derivation.computation, new RegExp(`^re-pin: ${CASE.replace(/[[\]"]/g, '\\$&')} was ${PINNED.replace(/"/g, '\\"')}, now ${IMPLIED}`));
  noPlaceholder(rows);
});

await check('C3 adoption: the amended row states the implied text; its re-pin clause naming the old text does not count as the old pin', async () => {
  const adopted = await load('../core/intent-conflict-overrule.js', 'intentConflictAdopted');
  const readyRows = await load('../core/intent-conflict-overrule.js', 'intentConflictReadyRows');
  const [patch] = readyRows(item(ROW), [CONFLICT], null) as Array<Record<string, unknown>>;
  const amended = item({ ...ROW, ...patch });
  assert.equal(adopted(amended, CONFLICT), true, 'adopted after the ready patch');
  assert.equal(adopted(item(ROW), CONFLICT), false, 'not before');
  const clauseOnly = item({ ...ROW, derivation: { ...ROW.derivation, computation: `${ROW.derivation.computation}; re-pin: ${CASE} was ${PINNED}, now ${IMPLIED}: x` } });
  assert.equal(adopted(clauseOnly, CONFLICT), false, 'a re-pin clause alone (the row still pins the old text) is not an amendment');
  assert.equal(adopted(amended, { ...CONFLICT, intentPins: 'pins the byte slice', requestImplies: 'a rune slice' }), false, 'prose never counts as adopted');
});

// ---------------------------------------------------------------------------
// D. Base printer

const GO_SOURCE = ['package eval', '', 'import "fmt"', '',
  'func operandError(v Value, kind string) error {', '\treturn fmt.Errorf("unsupported operand: %s for %s", v.Inspect(), kind)', '}', '',
  'func typeError(v Value) error {', '\treturn fmt.Errorf("operands must be numbers: got \\"%s\\" (kind %s)", v.Inspect(), v.Kind())', '}', '',
  'func nameError(name string) error {', '\treturn fmt.Errorf("unknown binding %q in scope", name)', '}', ''].join('\n');
/** Base tests: the operand error of a quoted string input prints the bare value. */
const GO_TEST = ['package eval', '', 'import "testing"', '', 'var errorCases = []struct {', '\tinput    string', '\texpected string', '}{',
  '\t{`ys["q"]`, "unsupported operand: q for LIST"},', '\t{"5[1]", "unsupported operand: 1 for NUMBER"},', '}', '',
  'func TestErrors(t *testing.T) {}', ''].join('\n');
const SOURCES = [{ path: 'eval/eval.go', text: GO_SOURCE }];
const WITH_TEST = [...SOURCES, { path: 'eval/eval_test.go', text: GO_TEST }];
const REQUEST = ['Add stepped operands.', '', '- A non-numeric operand keeps the existing operand error format.', ''].join('\n');
const row = (desc: string) => ({ desc, type: 'logic', priority: 'must', derivation: { requestQuote: 'A non-numeric operand keeps the existing operand error format.', computation: 'the operand is the string k' } });
const items = (...rows: Array<Record<string, unknown>>) => [{ id: 'CHK-001', title: 'Operands', status: 'pending', verificationIntent: { happy: [], edge: [], adversarial: rows } }];

await check('D1 a quoted slot value the base test instances print bare is a conflict with the base form, the format and its sample cited', async () => {
  const conflictsOf = await load('../core/pin-base-print.js', 'pinBasePrintConflicts');
  const out = conflictsOf({ items: items(row(`${CASE} -> ${PINNED}`)), requestText: REQUEST, files: WITH_TEST }) as Array<Record<string, unknown>>;
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0]!.ref, 'CHK-001:adversarial:0');
  assert.equal(out[0]!.kind, 'slot_quoting');
  assert.equal(out[0]!.baseForm, IMPLIED);
  assert.equal(out[0]!.format, 'unsupported operand: %s for %s');
  assert.match(String(out[0]!.at), /^eval\/eval\.go:\d+$/);
  assert.match(String(out[0]!.sample), /^eval\/eval_test\.go:\d+$/);
});

await check('D2 no base evidence for the slot rendering: only an advisory (unverified, no patch); a base-matching pin and a request-stated pin are fine', async () => {
  const conflictsOf = await load('../core/pin-base-print.js', 'pinBasePrintConflicts');
  const out = conflictsOf({ items: items(row(`${CASE} -> ${PINNED}`)), requestText: REQUEST, files: SOURCES }) as Array<Record<string, unknown>>;
  assert.deepEqual(out.map(entry => [entry.kind, entry.baseForm]), [['unverified', null]], JSON.stringify(out));
  assert.deepEqual(conflictsOf({ items: items(row(`${CASE} -> ${IMPLIED}`)), requestText: REQUEST, files: WITH_TEST }), [], 'the base form');
  assert.deepEqual(conflictsOf({ items: items(row(`${CASE} -> ${PINNED}`)), requestText: `${REQUEST}- \`${CASE}\` fails with \`${PINNED}\`.\n`, files: WITH_TEST }), [], 'the request states the pin');
  assert.deepEqual(conflictsOf({ items: items(row('f(1) -> 2')), requestText: REQUEST, files: WITH_TEST }), [], 'a value pin is not a message');
});

await check('D3 the base format\'s fixed text (its own quotes) and a %q verb decide: the pin is re-rendered from the format', async () => {
  const conflictsOf = await load('../core/pin-base-print.js', 'pinBasePrintConflicts');
  const fixed = conflictsOf({ items: items(row('1 + "k" -> operands must be numbers: got k (kind STRING)')), requestText: REQUEST, files: SOURCES }) as Array<Record<string, unknown>>;
  assert.deepEqual(fixed.map(entry => [entry.kind, entry.baseForm]), [['fixed_text', 'operands must be numbers: got "k" (kind STRING)']], JSON.stringify(fixed));
  const quoted = conflictsOf({ items: items(row('lookup(zz) -> unknown binding zz in scope')), requestText: REQUEST, files: SOURCES }) as Array<Record<string, unknown>>;
  assert.deepEqual(quoted.map(entry => [entry.kind, entry.baseForm]), [['quoted_verb', 'unknown binding "zz" in scope']], JSON.stringify(quoted));
});

await check('D4 the row patch is ready (base form, the row\'s quote, the format and sample in the computation, the re-pin stated)', async () => {
  const conflictsOf = await load('../core/pin-base-print.js', 'pinBasePrintConflicts');
  const patchOf = await load('../core/pin-base-print.js', 'pinBasePrintRowPatch');
  const source = row(`${CASE} -> ${PINNED}`);
  const [conflict] = conflictsOf({ items: items(source), requestText: REQUEST, files: WITH_TEST }) as unknown[];
  const patch = patchOf(conflict, source) as { ref: string; desc: string; derivation: { requestQuote: string; computation: string } };
  assert.equal(patch.ref, 'CHK-001:adversarial:0');
  assert.equal(patch.desc, `${CASE} -> ${IMPLIED}`);
  assert.equal(patch.derivation.requestQuote, source.derivation.requestQuote);
  assert.match(patch.derivation.computation, /re-pin: /);
  assert.match(patch.derivation.computation, /eval\/eval\.go:\d+/);
  assert.match(patch.derivation.computation, /eval\/eval_test\.go:\d+/);
  noPlaceholder(patch);
});

await check('D5 the PLAN pre-check lists the conflict [pin_base_print] with its patch, and the advisory [pin_base_print_unverified] without one', async () => {
  const conflictsOf = await load('../core/pin-base-print.js', 'pinBasePrintConflicts');
  const describe = await load('../core/pin-base-print.js', 'describePinBasePrint');
  const [conflict] = conflictsOf({ items: items(row(`${CASE} -> ${PINNED}`)), requestText: REQUEST, files: WITH_TEST }) as unknown[];
  assert.match(describe(conflict), /CHK-001:adversarial:0 pins `unsupported operand: "k" for LIST`/);
  const [advisory] = conflictsOf({ items: items(row(`${CASE} -> ${PINNED}`)), requestText: REQUEST, files: SOURCES }) as unknown[];
  assert.match(describe(advisory), /no Story base instance/);
  // End to end on a real repo (the base read from git objects).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run132-print-')));
  try {
    git(root, ['init', '-q', '-b', 'main']);
    for (const file of WITH_TEST) write(root, file.path, file.text);
    git(root, ['add', '-A']);
    git(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
    const plan = await load('../core/pin-base-print.js', 'planPinBasePrint');
    const storyDir = join(root, '.proof-or-stop', 'story', STORY);
    write(storyDir, 'request.md', REQUEST);
    write(storyDir, 'request.json', JSON.stringify({ sha256: createHash('sha256').update(REQUEST).digest('hex') }));
    const store = { readStory: () => ({ storyId: STORY }), readChecklist: () => ({ items: items(row(`${CASE} -> ${PINNED}`)) }), storyFilePath: (_id: string, file: string) => join(storyDir, file) };
    const evidence = plan(store, root, STORY, root) as { conflicts: Array<Record<string, unknown>> } | null;
    assert.equal(evidence?.conflicts.length, 1, JSON.stringify(evidence));
    assert.equal(evidence!.conflicts[0]!.kind, 'slot_quoting');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(failures.length ? `\nrun132-fixes-smoke: ${failures.length} FAIL (${failures.join(', ')})` : '\nrun132-fixes-smoke: all checks passed');
process.exit(failures.length ? 1 : 0);
