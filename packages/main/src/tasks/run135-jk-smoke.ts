#!/usr/bin/env node
/**
 * Lab run132, old-PoS run 135 items J and K (bench-staging/oldpos/run135-analysis.md, framework waste 3 and 4): unit
 * level, made-up rows only (no benchmark-task material).
 *
 *   J. plan_review_blockers (run 135 PLAN, ~5 min): the step Why and its `-why.txt` "full text" listed 8 of 16 scope_gap
 *      blockers ("+8 more") and cut each one at 600 characters, so the owner dug the rest out of `story_get`; the 16
 *      appended covering rows all read `<the case the gap names -> the expected result>` (no case named); the owner's
 *      apply_patch on the printed payload files used a path relative to /app and failed. Now every blocker is listed in
 *      full (the why file holds the whole list), each placeholder row names the case of its gap, and a spilled step says
 *      the payload files are edited at their absolute paths.
 *   K. pin_reversal_unstated (run 135 PLAN after DEV, ~2 min): the gate compared every pin of a case with the FIRST old
 *      pin of that case, so an unchanged prefix-pinned adversarial row (`<case> -> error starts with: ...`) counted as
 *      a reversal of the edge row's exact text; the framework's remedy re-pinned one row, failed its own re-check and was
 *      not offered (a placeholder template with the case's quotes stripped instead), and the next remedy was an 8k
 *      whole-intent command. Now (plan.repinAllRows, default on) a pin whose value the case already had is no reversal,
 *      the remedy re-pins every row of the item (and of other items) pinning the old value of that case, as row patches,
 *      and no framework remedy generator emits a payload its own gate refuses (invariant K5).
 *
 * Usage: node packages/main/dist/tasks/run135-jk-smoke.js
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const PLACEHOLDER = /"<[a-z][^"]*>"|<(?:the|a|pinned|line|request) [^<>]*>/i;
const noPlaceholder = (value: unknown): void => assert.doesNotMatch(JSON.stringify(value), PLACEHOLDER, `no placeholder: ${JSON.stringify(value).slice(0, 400)}`);
const STORY = 'B-1350';

// ---------------------------------------------------------------------------
// J. plan_review_blockers

const FEATURES = Array.from({ length: 16 }, (_, index) => `Existing widget ${index + 1} behaviour for negative, out-of-range and omitted bounds stays unchanged, including the "<inspect>" form that the receiver's error prints for case ${index + 1}`);
const items = [
  { id: 'CHK-001', title: 'Widget ranges', status: 'pending', userSees: 'widget ranges', files: { modify: ['widget/range.go'] }, verificationIntent: { happy: [], edge: [], adversarial: [] } },
  { id: 'CHK-002', title: 'Widget errors', status: 'pending', userSees: 'widget errors', files: { modify: ['widget/errors.go'] }, verificationIntent: { happy: [], edge: [], adversarial: [] } },
];
async function blockers(): Promise<Array<{ type: string; message: string }>> {
  const remedy = await load('../core/plan-gap-remedy.js', 'plainScopeGapRemedy');
  return FEATURES.map(feature => ({ type: 'scope_gap', message: remedy({ storyId: STORY, feature, source: ' (source: request.md)', items, rerun: `proof-or-stop next --storyId=${STORY} --run`, rerunWhat: 'it relaunches the scope-plan reviewer once' }) }));
}
const FAILURE = 'Cannot enter DEV:\n- Latest story_review round has 16 unresolved blocker(s)';

await check('J1 every blocker is listed in full (16 of 16, no "+N more", no message cut)', async () => {
  const stepOf = await load('../handlers/next-driver.js', 'storyReviewBlockersStep');
  const rows = await blockers();
  const out = stepOf({ storyId: STORY, phase: 'PLAN' }, FAILURE, rows);
  for (let index = 1; index <= 16; index += 1) assert.match(out.why, new RegExp(`\\(${index}\\) scope_gap`), `blocker ${index} listed`);
  assert.doesNotMatch(out.why, /\+\d+ more/);
  for (const feature of FEATURES) assert.ok(out.why.includes(feature), `"${feature.slice(0, 40)}..." in full`);
  assert.match(out.why, /16 blockers/, 'the count is stated');
});

await check('J2 a spilled step keeps the whole list in its why file, states where it is, and names the payload files by absolute path', async () => {
  const stepOf = await load('../handlers/next-driver.js', 'storyReviewBlockersStep');
  const spill = await load('../handlers/next-driver.js', 'spillLargeNextStep');
  const render = await load('../handlers/next-driver.js', 'renderNextStep');
  const dir = mkdtempSync(join(tmpdir(), 'run135-j2-'));
  try {
    const out = spill(stepOf({ storyId: STORY, phase: 'PLAN' }, FAILURE, await blockers()), join(dir, 'next-steps'));
    const file = out.why.match(/full text[^:]*: (\S+?-why\.txt)/)?.[1];
    assert.ok(file && file.startsWith('/'), `absolute why file: ${out.why.slice(-400)}`);
    const full = readFileSync(file, 'utf8');
    assert.equal((full.match(/\(\d+\) scope_gap/g) ?? []).length, 16, 'the why file lists all 16');
    for (const feature of FEATURES) assert.ok(full.includes(feature));
    const text = render(out);
    const paths = [...text.matchAll(/@(\S+\.json)/g)].map(match => match[1]!);
    assert.ok(paths.length >= 1 && paths.every(path => path.startsWith('/')), `payload files by absolute path: ${paths.join(', ')}`);
    assert.match(out.why, /absolute path/i, 'the step says to edit the payload files at their absolute paths');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await check('J3 each placeholder covering row names the case of its gap (still one placeholder, parseable, shell-safe)', async () => {
  const gapRow = await load('../core/plan-gap-remedy.js', 'gapCoveringRowPatch');
  const covering = await load('../core/scope-exclusion-rationale.js', 'coveringRowPatch');
  const feature = FEATURES[3]!;
  for (const row of [gapRow('CHK-001', feature), covering('CHK-001', 'changing', feature), covering('CHK-001', 'precedent', feature)]) {
    const desc = String(row.desc);
    assert.match(desc, /^<[^<>]*>$/, `one placeholder: ${desc}`);
    assert.match(desc, /Existing widget 4 behaviour/, `the case is named: ${desc}`);
    assert.doesNotMatch(desc, /'/, 'shell-safe inside --intentRows=\'...\'');
  }
  const rows = await blockers();
  const step = (await load('../handlers/next-driver.js', 'storyReviewBlockersStep'))({ storyId: STORY, phase: 'PLAN' }, FAILURE, rows);
  const descs = (step.batch ?? []).flatMap((call: { cli: { payload: { intentRows?: Array<{ desc: string }> } } }) => call.cli.payload.intentRows ?? []).map((row: { desc: string }) => row.desc);
  assert.equal(descs.length, 16, `every gap has its row in the batch: ${descs.length}`);
  assert.equal(new Set(descs).size, 16, 'each row names its own case');
});

// ---------------------------------------------------------------------------
// K. Re-pin remedies cover every row of the case; no generator emits a call its gate refuses

const CASE = '[1, 2, 3]["x":2]';
const OLD = 'index operator not supported: "x" on ARRAY';
const NEW = 'index operator not supported: x on ARRAY';
const Q = 'A non-numeric start keeps the existing error format: `index operator not supported: <inspect> on ARRAY`.';
const REQUEST = `${Q}\nThe start \`${CASE}\` raises \`${NEW}\`.\nTwo-part ranges are unchanged.\n`;
const row = (desc: string, computation: string) => ({ desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story',
  derivation: { requestQuote: Q, computation }, verification: { command: 'go test -v ./lang -run ^TestRanges$', selector: '--- PASS: TestRanges' } });
const kItem = (id = 'CHK-001') => ({ id, title: `${id} range errors`, status: 'pending', userSees: `${id} range errors`, excludes: [] as string[], files: { modify: ['lang/range.go'] },
  verificationIntent: {
    happy: [row('[1, 2, 3][0:2] -> [1, 2]', 'the two-part range is unchanged: [1, 2]'), row(`${CASE} -> ${OLD}`, `the error names the start: ${OLD}`)],
    edge: [row(`${CASE} -> ${OLD}`, `the error names the start: ${OLD}`)],
    adversarial: [row(`${CASE} -> error starts with: index operator not supported:`, 'only the error prefix is pinned')],
  } });
const withEdge = (item: ReturnType<typeof kItem>, desc: string, computation: string) => ({ ...item, verificationIntent: { ...item.verificationIntent, edge: [row(desc, computation)] } });

async function applied(before: ReturnType<typeof kItem>, payload: Record<string, unknown>): Promise<unknown> {
  if (payload.verificationIntent) return payload.verificationIntent;
  const apply = await load('../core/intent-row-patch.js', 'applyIntentRowPatches');
  return apply({ storyId: STORY, item: before, patches: payload.intentRows, withWholeIntent: false, withProposalApproval: false }).verificationIntent;
}
async function gateClean(label: string, before: ReturnType<typeof kItem>, payload: Record<string, unknown> | null | undefined): Promise<void> {
  assert.ok(payload, `${label}: a remedy is offered`);
  noPlaceholder(payload);
  const reversals = await load('../core/pin-amendment.js', 'unstatedPinReversals');
  const after = await applied(before, payload!);
  assert.deepEqual(reversals(before.verificationIntent, after), [], `${label}: the payload passes pin_reversal_unstated`);
  const derivation = await load('../core/intent-derivation.js', 'intentDerivationFailure');
  assert.equal(derivation('checklist_update', before.id, after, REQUEST), null, `${label}: the payload passes the derivation rule`);
}

await check('K1 an unchanged prefix-pinned row of a case is no reversal (the gate compares with every earlier pin of the case)', async () => {
  const reversals = await load('../core/pin-amendment.js', 'unstatedPinReversals');
  const before = kItem();
  assert.deepEqual(reversals(before.verificationIntent, structuredClone(before.verificationIntent)), [], 'an unchanged intent reverses nothing');
  const changed = withEdge(before, `${CASE} -> ${NEW}`, `the error names the start: ${NEW}`);
  const out = reversals(before.verificationIntent, changed.verificationIntent);
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0].newValue, NEW, 'the changed row is the reversal, not the prefix row');
});

await check('K2 the reversal remedy re-pins EVERY row of the item pinning the old value, as a short row patch that passes the gate', async () => {
  const remedy = await load('../core/pin-amendment.js', 'pinReversalRemedy');
  const reversals = await load('../core/pin-amendment.js', 'unstatedPinReversals');
  const before = kItem();
  const after = withEdge(before, `${CASE} -> ${NEW}`, `the error names the start: ${NEW}`).verificationIntent;
  const out = remedy({ storyId: STORY, item: before, afterIntent: after, reversals: reversals(before.verificationIntent, after), requestText: REQUEST,
    ownerArgs: { storyId: STORY, itemId: 'CHK-001', intentRows: [{ ref: 'CHK-001:edge:0', desc: `${CASE} -> ${NEW}` }], status: 'pending' } });
  assert.equal(out?.kind, 'repin', JSON.stringify(out)?.slice(0, 300));
  await gateClean('reversal remedy', before, out.payload);
  const fixed = await applied(before, out.payload) as ReturnType<typeof kItem>['verificationIntent'];
  assert.match(String(fixed.happy[1]!.desc), /x on ARRAY$/, 'the duplicate happy row is re-pinned too');
  assert.doesNotMatch(String(fixed.happy[1]!.desc), /"x"/);
  assert.match(String(fixed.happy[1]!.derivation.computation), /re-pin: .* was .*"x".*, now /);
  assert.equal(fixed.adversarial[0]!.desc, before.verificationIntent.adversarial[0]!.desc, 'the prefix row still holds and is left as it is');
  assert.ok(Array.isArray(out.payload.intentRows), 'a row patch, not the whole intent');
  assert.ok(JSON.stringify(out.payload).length < 2500, `short: ${JSON.stringify(out.payload).length} chars`);
});

await check('K3 another item pinning the same case with the old value gets its own ready call, and that call passes its gate', async () => {
  const remedy = await load('../core/pin-amendment.js', 'pinReversalRemedy');
  const reversals = await load('../core/pin-amendment.js', 'unstatedPinReversals');
  const before = kItem();
  const other = kItem('CHK-002');
  const after = withEdge(before, `${CASE} -> ${NEW}`, `the error names the start: ${NEW}`).verificationIntent;
  const out = remedy({ storyId: STORY, item: before, afterIntent: after, reversals: reversals(before.verificationIntent, after), requestText: REQUEST, otherItems: [other] });
  const also = (out?.also ?? []) as Array<Record<string, unknown>>;
  assert.equal(also.length, 1, `one call for CHK-002: ${JSON.stringify(also).slice(0, 300)}`);
  assert.equal(also[0]!.itemId, 'CHK-002');
  await gateClean('other item', other, also[0]!);
  const refusal = await load('../core/pin-amendment.js', 'pinReversalRefusal');
  const text = refusal({ storyId: STORY, itemId: 'CHK-001', reversals: reversals(before.verificationIntent, after), remedy: out }) as string;
  assert.match(text, /CHK-002/, 'the refusal names the other item\'s call');
});

await check('K4 without a remedy the refusal template keeps the case and the old value exactly (quotes kept, valid JSON)', async () => {
  const refusal = await load('../core/pin-amendment.js', 'pinReversalRefusal');
  const text = refusal({ storyId: STORY, itemId: 'CHK-001', reversals: [{ caseText: CASE, oldValue: OLD, newValue: NEW }], remedy: null }) as string;
  const next = text.slice(text.indexOf('Next: proof-or-stop checklist_update ') + 'Next: proof-or-stop checklist_update '.length).trim();
  const json = next.startsWith("'") ? next.slice(1, -1).replace(/'"'"'/g, "'") : next;
  const payload = JSON.parse(json) as { intentRows: Array<{ derivation: { computation: string } }> };
  assert.ok(payload.intentRows[0]!.derivation.computation.includes(`re-pin: ${CASE} was ${OLD}, now `), payload.intentRows[0]!.derivation.computation);
});

await check('K5 invariant: no framework remedy generator emits a payload its own gate refuses (case pinned in several rows, one prefix-pinned)', async () => {
  const before = kItem();
  const errors: string[] = [];
  const attempt = async (label: string, make: () => Promise<Record<string, unknown> | null | undefined>, required = true): Promise<void> => {
    try {
      const payload = await make();
      if (!payload && !required) return; // not offered: allowed
      await gateClean(label, before, payload);
    } catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`); }
  };
  const reversals = await load('../core/pin-amendment.js', 'unstatedPinReversals');
  await attempt('pin reversal remedy', async () => {
    const after = withEdge(before, `${CASE} -> ${NEW}`, `the error names the start: ${NEW}`).verificationIntent;
    return (await load('../core/pin-amendment.js', 'pinReversalRemedy'))({ storyId: STORY, item: before, afterIntent: after, reversals: reversals(before.verificationIntent, after), requestText: REQUEST })?.payload;
  });
  const doubt = { itemId: 'CHK-001', intentRef: 'CHK-001:edge:0', intentPins: null, requestImplies: `\`${NEW}\``, requestSentence: null, runId: 'run-1' };
  await attempt('pin-doubt ready rows', async () => {
    const rows = (await load('../core/intent-conflict-overrule.js', 'pinDoubtReadyRows'))(before, [doubt]);
    return rows ? { storyId: STORY, itemId: 'CHK-001', intentRows: rows } : null;
  }, false);
  await attempt('intent-conflict ready rows', async () => {
    const rows = (await load('../core/intent-conflict-overrule.js', 'intentConflictReadyRows'))(before,
      [{ ...doubt, intentPins: `\`${OLD}\``, requestSentence: `The start \`${CASE}\` raises \`${NEW}\`.` }], REQUEST);
    return rows ? { storyId: STORY, itemId: 'CHK-001', intentRows: rows } : null;
  });
  await attempt('plan_pin_dispute remedy', async () => (await load('../core/pin-dispute.js', 'pinDisputeRemedy'))({ storyId: STORY, item: before,
    dispute: { ref: 'CHK-001:edge:0', itemId: 'CHK-001', lane: 'edge', index: 0, verdicts: 2, features: [] }, requestText: REQUEST })?.payload, false);
  await attempt('pin_audit_correction', async () => {
    const digest = (await import('../core/scope-check-integrity.js')).scopeReviewChecklistDigest({ items: [before] } as never);
    const scope = { checkedAt: '2026-10-22T00:00:00.000Z', checklistDigest: digest, features: [{ feature: `pin-audit CHK-001:edge:0: pins ${OLD}; request gives ${NEW} (the request's inspect form)`, status: 'gap', source: 'request.md' }] };
    const out = (await load('../handlers/next-driver.js', 'pinAuditCorrectionStep'))({ storyId: STORY, phase: 'PLAN' }, { readScopeCheck: () => scope, readChecklist: () => ({ items: [before] }) }, new Set());
    return (out?.batch?.[0]?.cli ?? out?.cli)?.payload ?? null;
  });
  await attempt('metadata_correction', async () => (await load('../core/metadata-correction.js', 'metadataCorrectionReadyPayload'))(STORY, before,
    [{ itemId: 'CHK-001', field: 'verificationIntent', rowRefs: ['CHK-001:edge:0'], wrongLiteral: OLD, correctedValue: NEW, fieldHash: null }]));
  assert.deepEqual(errors, [], errors.join(" || "));
});

await check('K6 the switch: plan.repinAllRows=off keeps the earlier gate (first pin of the case) and remedy; a known A/B flag, default on', async () => {
  const reversals = await load('../core/pin-amendment.js', 'unstatedPinReversals');
  const before = kItem();
  assert.equal(reversals(before.verificationIntent, structuredClone(before.verificationIntent), { allEarlierPins: false }).length, 1, 'off: the first-pin comparison as before');
  const flags = await import('../core/ab-variants.js') as { AB_VARIANT_FLAGS: Record<string, readonly string[]>; repinAllRowsOn?: Fn };
  assert.deepEqual([...(flags.AB_VARIANT_FLAGS['plan.repinAllRows'] ?? [])], ['on', 'off']);
  assert.equal(flags.repinAllRowsOn?.({ plan: { repinAllRows: 'maybe' } }), true, 'malformed = on');
});

if (failures.length) {
  console.log(`run135-jk-smoke: ${failures.length} check(s) FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('run135-jk-smoke: all checks passed');
