/**
 * Lab run132 (old-PoS run 135 item K): the pin-reversal gate core and the re-pin closure every framework remedy
 * generator uses, so no generator emits a call its own gate refuses.
 *
 * Run 135: a case pinned in several rows of one item (an exact text in two lanes, `error starts with: ...` in a third)
 * made the framework's own "Run this update" re-pin remedy fail `pin_reversal_unstated` twice: the gate compared every
 * pin with the FIRST pin of the case (so the unchanged prefix row counted as a reversal) and the remedy re-pinned one
 * row (the duplicate kept the old value). Here the gate compares a pin with every earlier pin of its case, and
 * `closeRepinPatch` turns a generator's row patch into one that re-pins EVERY row of the item pinning the old value
 * (a row the new value satisfies, such as a prefix pin, stays as it is), states the `re-pin:` clause on each changed
 * row, and is checked against the gate (null when it still is refused: the generator then offers no call).
 *
 * Generic: rows are read as `<case> -> <value>` (also inside backticks); no task values. Imports stay leaf-level
 * (pin-amendment, pin-dispute and intent-conflict-overrule import this module, never the other way).
 */
import type { VerificationIntent } from './types.js';
import { normalizeProbe } from './probe-text.js';
import { leadingLiteral } from './pin-audit-correction.js';
import { applyIntentRowPatches } from './intent-row-patch.js';

const LANES = ['happy', 'edge', 'adversarial'] as const;
type Row = { desc?: string; derivation?: { requestQuote?: string; computation?: string }; verification?: { command?: string; selector?: string } };
type IntentRow = Record<string, unknown> & { desc?: string; derivation?: { requestQuote?: string; computation?: string } };
const rowsOf = (intent: VerificationIntent | undefined): Row[] => LANES.flatMap(lane => ((intent as unknown as Record<string, Row[] | undefined>)?.[lane] ?? []));

/**
 * The `<case> -> <value>` pairs a row states (each backticked span, else the desc), case and value normalized. Lab run132
 * (old-PoS run 134: `[0,1,2,3][1:2] -> [1] preserves existing two-part ... behavior` vs `-> [2] preserves ...`): a value
 * side that starts with a literal (a quoted string, a bracket group, a number) followed by prose is that literal, so a
 * re-pin clause naming the old literal states the reversal, and a row whose literal is unchanged (only its prose
 * changed) reverses nothing.
 */
export function rowPins(desc: string): Array<{ caseKey: string; caseText: string; value: string; valueText: string }> {
  const spans = [...desc.matchAll(/`([^`]+)`/g)].map(match => match[1]!);
  const out: Array<{ caseKey: string; caseText: string; value: string; valueText: string }> = [];
  for (const text of spans.length ? spans : [desc]) {
    const arrow = text.match(/\s*(?:->|→|=>)\s*/);
    if (!arrow || arrow.index === undefined || arrow.index === 0) continue;
    const caseText = text.slice(0, arrow.index).trim();
    const sideText = text.slice(arrow.index + arrow[0].length).trim();
    const literal = leadingLiteral(sideText);
    const valueText = literal && /^\s+[A-Za-z(]/.test(sideText.slice(literal.length)) ? literal : sideText;
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
export function unstatedPinReversals(before: VerificationIntent | undefined, after: VerificationIntent | undefined,
  opts: { allEarlierPins?: boolean; /** every changed pin, its re-pin stated or not (closeRepinPatch) */ includeStated?: boolean } = {}): PinReversal[] {
  // Lab run132 (old-PoS run 135 item K, plan.repinAllRows; `allEarlierPins: false` = the earlier first-pin comparison):
  // a case pinned in several rows (an exact text in one, `error starts with: ...` in another) has several earlier
  // values. Run 135 compared every pin with the FIRST of them, so the unchanged prefix-pinned row counted as a reversal
  // of the exact one and every update of that item was refused. A pin whose value the case already had is no reversal.
  const all = opts.allEarlierPins !== false;
  const old = new Map<string, Array<{ caseText: string; value: string; valueText: string }>>();
  for (const row of rowsOf(before)) {
    for (const pin of rowPins(String(row.desc ?? ''))) {
      const list = old.get(pin.caseKey);
      if (!list) old.set(pin.caseKey, [pin]);
      else if (all && !list.some(entry => entry.value === pin.value)) list.push(pin);
    }
  }
  const out: PinReversal[] = [];
  for (const row of rowsOf(after)) {
    const statement = `${row.desc ?? ''} ${row.derivation?.computation ?? ''} ${row.derivation?.requestQuote ?? ''}`;
    for (const pin of rowPins(String(row.desc ?? ''))) {
      const earlier = old.get(pin.caseKey);
      if (!earlier?.length || earlier.some(entry => entry.value === pin.value)) continue;
      const stated = !opts.includeStated && /\bre-?pin/i.test(statement) && earlier.some(entry => normalizeProbe(statement).includes(entry.value));
      if (!stated && !out.some(row => row.caseText === pin.caseText)) out.push({ caseText: pin.caseText, oldValue: earlier[0]!.valueText, newValue: pin.valueText });
    }
  }
  return out;
}

/** A pin the decided value satisfies: the same value, or a prefix / containment pin (`error starts with: <text>`) of it. */
export function pinSatisfied(valueText: string, decided: string): boolean {
  const value = normalizeProbe(valueText);
  const target = normalizeProbe(decided);
  if (value === target) return true;
  const partial = valueText.match(/^\s*(?:error\s+)?(?:starts?\s+with|begins?\s+with|contains|includes|prefix(?:ed)?(?:\s+by)?)\s*:?\s*(.+)$/i)?.[1];
  return Boolean(partial && normalizeProbe(partial) && target.includes(normalizeProbe(partial).replace(/[:\s]+$/, '')));
}

/**
 * Lab run132 (old-PoS run 135 item K): every row of `intent` (except `skip`) pinning `caseKey` with the reversal's old
 * value states `decided` instead, its computation stating the re-pin; true when a row changed.
 */
export function alignCaseRows(intent: Record<string, IntentRow[] | undefined>, caseKey: string, reversal: PinReversal, decided: string, sourceRef: string,
  skip: { lane: string; index: number } | null, why?: string): boolean {
  let changed = false;
  const old = normalizeProbe(reversal.oldValue);
  for (const lane of LANES) {
    const rows = intent[lane] ?? [];
    for (let index = 0; index < rows.length; index += 1) {
      if (skip && skip.lane === lane && skip.index === index) continue;
      const row = rows[index]!;
      const desc = String(row.desc ?? '');
      const pin = rowPins(desc).find(entry => entry.caseKey === caseKey);
      if (!pin || pinSatisfied(pin.valueText, decided) || pin.value !== old) continue;
      const at = desc.lastIndexOf(pin.valueText);
      if (at < 0) continue;
      const next: IntentRow = { ...row, desc: `${desc.slice(0, at)}${decided}${desc.slice(at + pin.valueText.length)}` };
      const computation = String(row.derivation?.computation ?? '');
      const at2 = computation.lastIndexOf(pin.valueText);
      const restated = at2 >= 0 ? `${computation.slice(0, at2)}${decided}${computation.slice(at2 + pin.valueText.length)}` : computation;
      rows[index] = { ...next, derivation: { ...(row.derivation ?? {}), requestQuote: String(row.derivation?.requestQuote ?? ''),
        computation: `${restated.trim()}${restated.trim() ? '; ' : ''}re-pin: ${pin.caseText} was ${pin.valueText}, now ${decided}: ${why ?? `the same case as ${sourceRef}, re-pinned with it`}` } };
      changed = true;
    }
  }
  return changed;
}

/**
 * Lab run132 (old-PoS run 135 item K): `after` as a row patch over `before` (the changed fields of each row by ref, an
 * appended row in full as `<item>:<lane>:+`), or null when a lane got shorter (a removal needs the whole intent).
 */
export function intentRowPatchOf(itemId: string, before: unknown, after: unknown): Array<Record<string, unknown>> | null {
  const out: Array<Record<string, unknown>> = [];
  for (const lane of LANES) {
    const was = ((before as Record<string, IntentRow[] | undefined>)?.[lane] ?? []);
    const now = ((after as Record<string, IntentRow[] | undefined>)?.[lane] ?? []);
    if (now.length < was.length) return null;
    for (let index = 0; index < now.length; index += 1) {
      const row = now[index]!;
      if (index >= was.length) { out.push({ ...row, ref: `${itemId}:${lane}:+` }); continue; }
      const fields = Object.keys(row).filter(key => JSON.stringify((row as Record<string, unknown>)[key]) !== JSON.stringify((was[index] as Record<string, unknown>)[key]));
      if (Object.keys(was[index]!).some(key => !(key in row))) return null;
      if (fields.length) out.push({ ref: `${itemId}:${lane}:${index}`, ...Object.fromEntries(fields.map(key => [key, (row as Record<string, unknown>)[key]])) });
    }
  }
  return out;
}


/**
 * Lab run132 (old-PoS run 135 item K, plan.repinAllRows): a generator's row patch of `item`, closed so the gate takes it:
 * each row whose pin of a case changes states `re-pin: <case> was <old>, now <new>: <why>`, and every other row of the
 * item pinning the old value of that case gets the new value with the same clause. Returns the closed row patch, the
 * patch unchanged when it reverses nothing, or null when it cannot be made gate-clean (the generator offers no call).
 * `off` (repinAllRows false): the patch unchanged.
 */
export function closeRepinPatch(args: { storyId?: string; item: { id: string; verificationIntent?: unknown }; patch: Array<Record<string, unknown>>; why: string; repinAllRows?: boolean }): Array<Record<string, unknown>> | null {
  if (args.repinAllRows === false) return args.patch;
  const before = args.item.verificationIntent as VerificationIntent | undefined;
  let next: Record<string, IntentRow[] | undefined>;
  try {
    next = structuredClone(applyIntentRowPatches({ storyId: args.storyId ?? '', item: args.item as never, patches: args.patch, withWholeIntent: false, withProposalApproval: false }).verificationIntent) as never;
  } catch { return args.patch; }
  // Every pin the patch changes (stated or not): its other rows pinning the old value are re-pinned with it.
  const reversals = unstatedPinReversals(before, next as unknown as VerificationIntent, { includeStated: true });
  if (!reversals.length) return args.patch;
  if (args.patch.some(row => row.remove === true)) return null;
  for (const reversal of reversals) {
    const caseKey = normalizeProbe(reversal.caseText);
    const decided = reversal.newValue;
    for (const lane of LANES) {
      const rows = next[lane] ?? [];
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!;
        const pin = rowPins(String(row.desc ?? '')).find(entry => entry.caseKey === caseKey && entry.value === normalizeProbe(decided));
        if (!pin) continue;
        const computation = String(row.derivation?.computation ?? '').trim();
        if (/\bre-?pin/i.test(computation) && normalizeProbe(computation).includes(normalizeProbe(reversal.oldValue))) continue;
        rows[index] = { ...row, derivation: { ...(row.derivation ?? {}), requestQuote: String(row.derivation?.requestQuote ?? ''),
          computation: `${computation}${computation ? '; ' : ''}re-pin: ${reversal.caseText} was ${reversal.oldValue}, now ${decided}: ${args.why}` } };
      }
    }
    alignCaseRows(next, caseKey, reversal, decided, 'the row the remedy re-pins', null, args.why);
  }
  if (unstatedPinReversals(before, next as unknown as VerificationIntent).length) return null;
  // The generator's rows first (its fields as it wrote them), then the rows the closure added.
  const closed = intentRowPatchOf(args.item.id, before, next);
  if (!closed) return null;
  const extra = closed.filter(row => !args.patch.some(own => own.ref === row.ref));
  const own = args.patch.map(row => closed.find(entry => entry.ref === row.ref) ? { ...row, ...closed.find(entry => entry.ref === row.ref) } : row);
  return extra.length || own.some((row, index) => JSON.stringify(row) !== JSON.stringify(args.patch[index])) ? [...own, ...extra] : args.patch;
}
