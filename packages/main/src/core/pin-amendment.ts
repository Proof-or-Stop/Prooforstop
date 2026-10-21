/**
 * Old-PoS run 58 (bench-staging/oldpos/run58-analysis.md §3, §4, §7 fixes D
 * and E): what a PLAN pin may change and what it costs.
 *
 *   E. Silent pin reversal. Run 58's first `finding_conflict_pin` replaced a
 *      PLAN row (`<case> -> <value A>`, from the base-disagreement check) with
 *      `<case> -> <value B>`, the secondary precedent, quoting a request
 *      sentence that said the opposite; nothing compared the new pin with the
 *      row it replaced. After the Story has been in DEV, a checklist_update
 *      that changes the value an existing row pins for a case is refused
 *      (`[pin_reversal_unstated]`) unless the new row states the re-pin
 *      (`re-pin: <case> was <old>, now <new>` in its desc or derivation,
 *      naming the old value). The refusal gives the oracle order. The first
 *      PLAN (never in DEV) is free: rows are still being authored.
 *   D. Keep done. Each run-58 pin reset every done item it touched (and every
 *      done item naming it) to pending, so 14 implementer re-runs (14.4M) ran,
 *      several of them no-ops ("the pins are satisfied"). A done item now stays
 *      done when the pinned tests of its rows (`verification` command +
 *      selector) pass on the current code and every row the amendment added or
 *      changed is pinned to a passing test whose source states the row's case
 *      and value; otherwise it goes pending as before (a row without a pinned
 *      test, a failing test, or an unreadable case is never assumed done).
 *
 * Generic: rows are read as `<case> -> <value>` (also inside backticks); no
 * task values.
 */
import type { ChecklistItem, VerificationIntent } from './types.js';
import { goSelectedTests, normalizeProbe, runCommand } from './resolved-finding-guard.js';
import { pinDisputeRemedy } from './pin-dispute.js';
import { counterpartRowRoles, type CounterpartCoverageResult } from './counterpart-coverage.js';
import { shellQuote } from './shell-quote.js';

export const PIN_REVERSAL_UNSTATED = 'pin_reversal_unstated';
const LANES = ['happy', 'edge', 'adversarial'] as const;
type Row = { desc?: string; derivation?: { requestQuote?: string; computation?: string }; verification?: { command?: string; selector?: string } };

const rowsOf = (intent: VerificationIntent | undefined): Row[] => LANES.flatMap(lane => ((intent as unknown as Record<string, Row[] | undefined>)?.[lane] ?? []));

/** The `<case> -> <value>` pairs a row states (each backticked span, else the desc), case and value normalized. */
export function rowPins(desc: string): Array<{ caseKey: string; caseText: string; value: string; valueText: string }> {
  const spans = [...desc.matchAll(/`([^`]+)`/g)].map(match => match[1]!);
  const out: Array<{ caseKey: string; caseText: string; value: string; valueText: string }> = [];
  for (const text of spans.length ? spans : [desc]) {
    const arrow = text.match(/\s*(?:->|→|=>)\s*/);
    if (!arrow || arrow.index === undefined || arrow.index === 0) continue;
    const caseText = text.slice(0, arrow.index).trim();
    const valueText = text.slice(arrow.index + arrow[0].length).trim();
    const caseKey = normalizeProbe(caseText);
    const value = normalizeProbe(valueText);
    if (caseKey.length >= 3 && value) out.push({ caseKey, caseText, value, valueText });
  }
  return out;
}

export interface PinReversal { caseText: string; oldValue: string; newValue: string }

/**
 * E: the cases whose pinned value the new intent changes without stating it.
 * A row states the re-pin when its desc or derivation says `re-pin` and names
 * the old value.
 */
export function unstatedPinReversals(before: VerificationIntent | undefined, after: VerificationIntent | undefined): PinReversal[] {
  const old = new Map<string, { caseText: string; value: string; valueText: string }>();
  for (const row of rowsOf(before)) for (const pin of rowPins(String(row.desc ?? ''))) if (!old.has(pin.caseKey)) old.set(pin.caseKey, pin);
  const out: PinReversal[] = [];
  for (const row of rowsOf(after)) {
    const statement = `${row.desc ?? ''} ${row.derivation?.computation ?? ''} ${row.derivation?.requestQuote ?? ''}`;
    for (const pin of rowPins(String(row.desc ?? ''))) {
      const earlier = old.get(pin.caseKey);
      if (!earlier || earlier.value === pin.value) continue;
      const stated = /\bre-?pin/i.test(statement) && normalizeProbe(statement).includes(earlier.value);
      if (!stated && !out.some(row => row.caseText === pin.caseText)) out.push({ caseText: pin.caseText, oldValue: earlier.valueText, newValue: pin.valueText });
    }
  }
  return out;
}

export const PIN_ORACLE_ORDER = 'Oracle order: a request sentence decides; else the SAME receiver\'s pre-existing counterpart (its read for a new write, its write for a new read); another receiver\'s same operation is only secondary.';

/**
 * Lab run131 (run 131 PLAN-C: five `pin_reversal_unstated` refusals, then `plan_pin_dispute` after three scope-plan reruns,
 * ~10-12 min): the refusal's remedy, decided at the FIRST reversal by the oracle order, as ONE ready command (the owner's own
 * update, corrected):
 *   repin        the request states the new value: the row keeps it and states the re-pin;
 *   keep         the request states the old value: the earlier row is restored;
 *   counterpart  the counterpart gate re-pins the row to the same receiver's base value;
 *   relax / exclude  the request and the counterpart are silent: the plan_pin_dispute remedy of the earlier row
 *                (core/pin-dispute.ts pinDisputeRemedy: an error row pins only the error, a value row's case is excluded);
 *   repin        (fallback) the dispute remedy cannot hold (the item itself adds the case): the owner's value stands with
 *                the re-pin stated.
 * Every remedy passes unstatedPinReversals against the stored rows. Null when no row of a reversal is found.
 */
export interface PinReversalRemedy { kind: 'repin' | 'keep' | 'counterpart' | 'relax' | 'exclude'; why: string; payload: Record<string, unknown> }

type IntentRow = Row & Record<string, unknown>;
type ItemLike = Pick<ChecklistItem, 'id' | 'title' | 'userSees' | 'status' | 'excludes'> & { verificationIntent?: VerificationIntent | unknown; files?: { modify?: readonly string[]; create?: readonly string[] } };

function findPinRow(intent: unknown, caseKey: string, value?: string): { lane: (typeof LANES)[number]; index: number; row: IntentRow } | null {
  let fallback: { lane: (typeof LANES)[number]; index: number; row: IntentRow } | null = null;
  for (const lane of LANES) {
    const rows = ((intent as Record<string, IntentRow[] | undefined>)?.[lane] ?? []);
    for (let index = 0; index < rows.length; index += 1) {
      const pins = rowPins(String(rows[index]!.desc ?? '')).filter(pin => pin.caseKey === caseKey);
      if (!pins.length) continue;
      if (value === undefined || pins.some(pin => pin.value === value)) return { lane, index, row: rows[index]! };
      fallback ??= { lane, index, row: rows[index]! };
    }
  }
  return fallback;
}

const statesBoth = (text: string, caseText: string, valueText: string): boolean => {
  const squashed = text.replace(/\s+/g, '');
  return squashed.includes(caseText.replace(/\s+/g, '')) && squashed.includes(valueText.replace(/\s+/g, ''));
};
const withRepin = (row: IntentRow, reversal: PinReversal, why: string, now = reversal.newValue): IntentRow => ({ ...row,
  derivation: { ...(row.derivation ?? {}), requestQuote: String(row.derivation?.requestQuote ?? ''),
    computation: `${String(row.derivation?.computation ?? '').trim()}${row.derivation?.computation ? '; ' : ''}re-pin: ${reversal.caseText} was ${reversal.oldValue}, now ${now}: ${why}` } });

export function pinReversalRemedy(args: { storyId: string; item: ItemLike; afterIntent: unknown; reversals: readonly PinReversal[]; requestText: string | null;
  counterpart?: Pick<CounterpartCoverageResult, 'checks'> | null; ownerArgs?: Record<string, unknown> }): PinReversalRemedy | null {
  if (!args.reversals.length) return null;
  const next = structuredClone(args.afterIntent ?? {}) as Record<string, IntentRow[] | undefined>;
  const kinds: PinReversalRemedy['kind'][] = [];
  const whys: string[] = [];
  const extra: Record<string, unknown> = {};
  const removals: Array<{ lane: (typeof LANES)[number]; index: number }> = [];
  for (const reversal of args.reversals) {
    const caseKey = normalizeProbe(reversal.caseText);
    const target = findPinRow(next, caseKey, normalizeProbe(reversal.newValue));
    const earlier = findPinRow(args.item.verificationIntent, caseKey, normalizeProbe(reversal.oldValue));
    if (!target || !earlier) return null;
    const rows = next[target.lane]!;
    const request = args.requestText ?? '';
    const statesNew = statesBoth(request, reversal.caseText, reversal.newValue);
    const statesOld = statesBoth(request, reversal.caseText, reversal.oldValue);
    if (statesNew && !statesOld) {
      rows[target.index] = withRepin(target.row, reversal, 'the request states it');
      kinds.push('repin'); whys.push(`\`${reversal.caseText}\`: the request states ${reversal.newValue}, so the new pin stands with the re-pin stated`);
      continue;
    }
    if (statesOld && !statesNew) {
      rows[target.index] = { ...target.row, desc: earlier.row.desc, ...(earlier.row.derivation ? { derivation: earlier.row.derivation } : {}) };
      kinds.push('keep'); whys.push(`\`${reversal.caseText}\`: the request states ${reversal.oldValue}, so the earlier pin is kept`);
      continue;
    }
    const earlierRef = `${args.item.id}:${earlier.lane}:${earlier.index}`;
    const role = (counterpartRowRoles(args.counterpart).get(earlierRef) ?? []).find(entry => entry.required && entry.repin);
    if (role?.repin) {
      const value = rowPins(role.repin.desc).find(pin => pin.caseKey === caseKey)?.valueText ?? reversal.newValue;
      const patched: IntentRow = { ...target.row, desc: role.repin.desc, derivation: { requestQuote: String(target.row.derivation?.requestQuote ?? earlier.row.derivation?.requestQuote ?? ''), computation: role.repin.computation } };
      rows[target.index] = normalizeProbe(value) === normalizeProbe(reversal.oldValue) ? patched : withRepin(patched, reversal, `the same receiver's counterpart ${role.counterpart} gives it`, value);
      kinds.push('counterpart'); whys.push(`\`${reversal.caseText}\`: the request is silent; the same receiver's counterpart ${role.counterpart} decides it`);
      continue;
    }
    const dispute = pinDisputeRemedy({ storyId: args.storyId, item: args.item as never, requestText: args.requestText, counterpart: args.counterpart ?? null,
      dispute: { ref: earlierRef, itemId: args.item.id, lane: earlier.lane, index: earlier.index, verdicts: 1, features: [] } });
    const ready = dispute?.payload && !/<[a-z][^<>]*>/i.test(JSON.stringify(dispute.payload));
    if (dispute && ready && dispute.kind === 'relax') {
      const patch = ((dispute.payload!.intentRows as IntentRow[] | undefined) ?? [])[0] ?? {};
      const relaxed: IntentRow = { ...target.row, desc: String(patch.desc ?? target.row.desc), derivation: { ...(target.row.derivation ?? {}), ...((patch.derivation as object | undefined) ?? {}) } };
      const value = rowPins(String(relaxed.desc ?? '')).find(pin => pin.caseKey === caseKey)?.valueText ?? 'error';
      rows[target.index] = withRepin(relaxed, reversal, 'the request states no text for this error (plan_pin_dispute: relaxed to the error, the case kept)', value);
      kinds.push('relax'); whys.push(`\`${reversal.caseText}\`: neither the request nor the counterpart states the text; the row pins only the error`);
      continue;
    }
    if (dispute && ready && dispute.kind === 'exclude') {
      removals.push({ lane: target.lane, index: target.index });
      const excludes = (dispute.payload!.excludes as string[] | undefined) ?? [];
      extra.excludes = [...new Set([...((extra.excludes as string[] | undefined) ?? (args.ownerArgs?.excludes as string[] | undefined) ?? []), ...excludes])];
      if (dispute.payload!.userSees !== undefined) extra.userSees = dispute.payload!.userSees;
      kinds.push('exclude'); whys.push(`\`${reversal.caseText}\`: neither the request nor the counterpart states its value; the case is excluded and its row removed (plan_pin_dispute)`);
      continue;
    }
    rows[target.index] = withRepin(target.row, reversal, 'the request and the same receiver\'s counterpart are silent and the item itself adds the case; the PLAN value stands');
    kinds.push('repin'); whys.push(`\`${reversal.caseText}\`: no oracle decides it; the new pin stands with the re-pin stated`);
  }
  for (const removal of removals.sort((a, b) => b.index - a.index)) next[removal.lane]!.splice(removal.index, 1);
  if (unstatedPinReversals(args.item.verificationIntent as VerificationIntent, next as unknown as VerificationIntent).length) return null;
  const { intentRows: _rows, verificationIntent: _intent, intentBasis: _basis, ...owner } = args.ownerArgs ?? {};
  const kind = kinds.find(entry => entry !== 'repin') ?? 'repin';
  const payload: Record<string, unknown> = { ...owner, storyId: args.storyId, itemId: args.item.id, verificationIntent: next, ...extra,
    reason: String(owner.reason ?? '').trim() ? `${String(owner.reason).trim()} (pin reversal settled: ${kinds.join(', ')})` : `pin reversal settled by the oracle order: ${kinds.join(', ')}` };
  return { kind, why: whys.join('; '), payload: { storyId: payload.storyId, itemId: payload.itemId, ...payload } };
}

/** E: the refusal text (one Next), or null. Lab run131: with `remedy`, the Next is that ready command. */
export function pinReversalRefusal(args: { storyId: string; itemId: string; reversals: readonly PinReversal[]; remedy?: Pick<PinReversalRemedy, 'kind' | 'why' | 'payload'> | null }): string | null {
  if (!args.reversals.length) return null;
  const listed = args.reversals.slice(0, 6).map(row => `\`${row.caseText}\` was pinned ${row.oldValue}, the update pins ${row.newValue}`).join('; ');
  const head = `checklist_update refused: the update silently reverses ${args.reversals.length} earlier pin(s) of ${args.itemId} [${PIN_REVERSAL_UNSTATED}]: ${listed}. ${PIN_ORACLE_ORDER} `;
  if (args.remedy) {
    return `${head}The framework applied that order now (${args.remedy.kind}): ${args.remedy.why}. Run this update (your update with the remedy applied; nothing else changes):\n`
      + `Next: proof-or-stop checklist_update ${shellQuote(JSON.stringify(args.remedy.payload))}`;
  }
  return `${head}If the earlier pin is right, keep it; if the new value is right, state the re-pin on the row (derivation computation \`re-pin: <case> was <old>, now <new>: <the request sentence or the same receiver's counterpart that decides it>\`).\n`
    + `Next: proof-or-stop checklist_update '{"storyId":"${args.storyId}","itemId":"${args.itemId}","intentRows":[{"ref":"<the row's ref>","derivation":{"requestQuote":"<request sentence>","computation":"re-pin: ${args.reversals[0]!.caseText.replace(/["\\]/g, '')} was ${args.reversals[0]!.oldValue.replace(/["\\]/g, '')}, now <new value>: <why>"}}]}'`;
}

/**
 * Whether the Story has been in DEV before (a re-PLAN): a recorded phase_transition to DEV. The story `events` list is
 * not evidence: a refused DEV entry (pin oracle, plan-light probe) leaves an `advance DEV` event on a Story that never
 * left PLAN, and correcting a wrong pin before any DEV work is the ordinary PLAN loop, not a reversal. Lab run131: a recorded
 * transition FROM DEV counts too (a Story whose DEV entry predates the process journal still left DEV).
 */
export function storyWasInDev(_story: unknown, processEvents: ReadonlyArray<Record<string, unknown>>): boolean {
  return processEvents.some(event => event.type === 'phase_transition' && (event.toPhase === 'DEV' || event.fromPhase === 'DEV'));
}

// ---------------------------------------------------------------------------
// D. keep a done item done when its pinned tests pass

export interface KeepDone { keep: boolean; why: string }

/**
 * D: whether `item` (its intent after the amendment) still holds on the current
 * code. `before` is its intent before the amendment (the rows the amendment
 * added or changed must each be covered by a pinned passing test that states
 * the case and the value); `cache` shares command results between items.
 */
export function keepDoneAfterPin(args: { projectRoot: string; gitCwd: string; item: Pick<ChecklistItem, 'id' | 'verificationIntent'>; before?: VerificationIntent;
  cache?: Map<string, boolean> }): KeepDone {
  const rows = rowsOf(args.item.verificationIntent);
  const pinned = rows.filter(row => row.verification?.command && row.verification.selector);
  if (!pinned.length) return { keep: false, why: 'no row has a pinned test' };
  const beforeDescs = new Set(rowsOf(args.before).map(row => normalizeProbe(String(row.desc ?? ''))));
  const changed = args.before ? rows.filter(row => !beforeDescs.has(normalizeProbe(String(row.desc ?? '')))) : [];
  for (const row of changed) {
    const pins = rowPins(String(row.desc ?? ''));
    if (!row.verification?.command || !pins.length) return { keep: false, why: `amended row "${String(row.desc ?? '').slice(0, 80)}" has no pinned test or no readable case` };
    const tests = goSelectedTests(args.gitCwd, row.verification.command, null);
    const source = normalizeProbe((tests ?? []).map(test => test.body).join('\n'));
    if (!pins.every(pin => source.includes(pin.caseKey) && source.includes(pin.value))) {
      return { keep: false, why: `the pinned test of amended row "${String(row.desc ?? '').slice(0, 80)}" does not state its case and value` };
    }
  }
  const cache = args.cache ?? new Map<string, boolean>();
  const commands = [...new Map(pinned.map(row => [`${row.verification!.command}\u0000${row.verification!.selector}`, row.verification!])).values()];
  for (const pin of commands) {
    const key = `${pin.command}\u0000${pin.selector}`;
    if (!cache.has(key)) {
      let passed = false;
      try {
        const run = runCommand(args.projectRoot, args.gitCwd, pin.command!);
        passed = run.status === 0 && run.output.includes(pin.selector!);
      } catch { passed = false; }
      cache.set(key, passed);
    }
    if (!cache.get(key)) return { keep: false, why: `pinned test \`${pin.command}\` does not pass on the current code` };
  }
  return { keep: true, why: `the pinned tests of its rows pass on the current code (${commands.map(pin => `\`${pin.command}\``).join(', ')})${changed.length ? ' and state every amended row' : ''}` };
}
