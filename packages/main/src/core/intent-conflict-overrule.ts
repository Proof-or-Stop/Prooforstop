/**
 * Lab run131 (bench-staging/oldpos/run131-analysis.md §3 cycle 1, ~30-40 min): the implementer reported a correct
 * `[intent-conflict]` (06:39:55: the pinned stepped-range end was inclusive, the request and the base two-part ranges are
 * exclusive); at 06:40 the owner's amend re-asserted the pinned value with no base probe and no request sentence, and the
 * wrong pin fed R1's high findings, PLAN-B, a DEV re-run, REM1 and the PLAN-C pin-reversal loop. Nothing compared the
 * amend with the conflict it answered.
 *
 *   - `next` journals the open lane-row conflicts it routes (runtime/intent-conflict/<story>.jsonl, rewritten on each
 *     intent-conflict step; a conflict naming no row literal is not journaled).
 *   - `intent_conflict_amend` carries ONE ready row patch to the implementer's value (the re-pin stated:
 *     `re-pin: <case> was <old>, now <new>`, the conflict's request sentence as the quote) when the conflict names both
 *     literals; the owner runs it or quotes the request sentence that states the pinned value.
 *   - a PLAN checklist_update that keeps a journaled row stating the disputed pin is refused
 *     (`[intent_conflict_overruled]`) unless the request states the pinned value (in its text or in the row's verbatim
 *     request quote) or a base check (counterpart backing, the base-form / request-probe checks) confirms it; the refusal's
 *     ONE Next is that ready patch.
 * Rollback: plan.intentConflictGuard=off.
 *
 * Lab run132 (run132-analysis.md D1): run 132's implementer wrote both values bare (`request implies: index operator not
 * supported: x on ARRAY | intent pins: index operator not supported: "x" on ARRAY`), so no literal was read: no ready amend,
 * and after the owner's amend the adoption check failed too, because the `re-pin: <case> was <old>, now <new>` clause
 * pin_reversal_unstated requires keeps the old text in the row's computation. Two unbackticked values that are variants of
 * one text (a shared prefix and suffix, the difference in the middle: an operand quoted or not) are read as the two
 * literals (`intentConflictPair`), and adoption (`intentConflictAdopted`, shared with next) ignores re-pin clauses.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';
import { shellQuote } from './shell-quote.js';
import { rowPins } from './pin-amendment.js';

export const INTENT_CONFLICT_OVERRULED = 'intent_conflict_overruled';
const SCHEMA = 'proof-or-stop.intent-conflict-open.v1' as const;

export interface JournaledIntentConflict { itemId: string; intentRef: string; intentPins: string | null; requestImplies: string | null; requestSentence: string | null; runId?: string }
type IntentRow = { desc?: string; derivation?: { requestQuote?: string; computation?: string } } & Record<string, unknown>;
type Intent = Partial<Record<'happy' | 'edge' | 'adversarial', IntentRow[]>>;
interface ItemSlice { id: string; verificationIntent?: Intent | unknown }

const squash = (text: string): string => text.replace(/\s+/g, '');
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const ROW_REF = /^(CHK-\d+):(happy|edge|adversarial):(\d+)$/;

/** The literal a conflict field states (its last backticked span, else the field when it is code-like); prose states none. */
export function conflictFieldLiteral(field: string | null | undefined): string | null {
  if (!field) return null;
  const spans = [...field.matchAll(/`([^`]+)`/g)].map(match => match[1]!.trim()).filter(Boolean);
  if (spans.length) return spans.at(-1)!.length >= 2 ? spans.at(-1)! : null;
  const text = field.trim();
  return /^(?:"[^"]*"|'[^']*'|\[.*\]|\{.*\}|[\w.]+\(.*\)(?:\s*(?:==|->)\s*.+)?)$/.test(text) && text.length >= 2 ? text : null;
}

const words = (text: string): number => (text.match(/[A-Za-z]{2,}/g) ?? []).length;
const MIN_SHARED = 12;

/** Lab run132 (D1): two values that are variants of one text: a shared prefix + suffix of 12+ characters, 60 % of the longer. */
function textVariants(a: string, b: string): boolean {
  const x = flat(a);
  const y = flat(b);
  if (x === y || words(x) < 3 || words(y) < 3) return false;
  let prefix = 0;
  while (prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < x.length - prefix && suffix < y.length - prefix && x[x.length - 1 - suffix] === y[y.length - 1 - suffix]) suffix += 1;
  return prefix + suffix >= MIN_SHARED && prefix + suffix >= 0.6 * Math.max(x.length, y.length);
}

/**
 * The pinned and the implied literal of a conflict: each field's literal (its last backticked span, else the code-like
 * field), or, lab run132, an unbackticked field taken whole when the two are variants of one text; null when the
 * conflict names no literal pair (prose, or the same value twice).
 */
export function intentConflictPair(conflict: Pick<JournaledIntentConflict, 'intentPins' | 'requestImplies'>): { pinned: string; implied: string } | null {
  const bare = (field: string | null | undefined): string | null => (field && !field.includes('`') ? field.trim() || null : null);
  const pinnedLiteral = conflictFieldLiteral(conflict.intentPins);
  const impliedLiteral = conflictFieldLiteral(conflict.requestImplies);
  const pinned = pinnedLiteral ?? bare(conflict.intentPins);
  const implied = impliedLiteral ?? bare(conflict.requestImplies);
  if (!pinned || !implied || squash(pinned) === squash(implied)) return null;
  if ((!pinnedLiteral || !impliedLiteral) && !textVariants(pinned, implied)) return null;
  return { pinned, implied };
}

type IntentItem = { userSees?: string | null; verificationIntent?: Intent | unknown };
/** A computation's `re-pin: <case> was <old>, now <new> ...` clause (it states the old pin by design; it runs to the end). */
const REPIN_CLAUSE = /\bre-?pin\b[\s\S]*$/i;

/** Every string an item states about its expected behaviour (userSees, intent descs and computations), re-pin clauses dropped. */
export function itemStatedIntentText(item: IntentItem): string {
  const intent = (item.verificationIntent ?? {}) as Intent;
  const rows = (['happy', 'edge', 'adversarial'] as const).flatMap(lane => intent[lane] ?? []);
  return [item.userSees ?? '', ...rows.flatMap(row => [String(row.desc ?? ''), String(row.derivation?.computation ?? '').replace(REPIN_CLAUSE, '')])].join('\n');
}

/**
 * Old-PoS run 31: the item now states what the implementer said the request implies and no longer states what it said
 * the intent pinned (whitespace aside). For a `requestImplies` `a == b` / `a -> b` statement its value side must appear;
 * the pinned literal must be gone. Lab run132: bare variant values count (intentConflictPair), and a re-pin clause is
 * not the row stating a value.
 */
export function intentConflictAdopted(item: IntentItem, conflict: Pick<JournaledIntentConflict, 'intentPins' | 'requestImplies'>): boolean {
  const pair = intentConflictPair(conflict);
  if (!pair) return false;
  const text = squash(itemStatedIntentText(item));
  const impliedValue = pair.implied.split(/\s*(?:==|->|→|=>)\s*/).at(-1)!;
  return text.includes(squash(impliedValue)) && !text.includes(squash(pair.pinned));
}

/** What the row states and what replaces it: whole statements when both sides are `<case> == <value>`, else values. */
function sides(conflict: Pick<JournaledIntentConflict, 'intentPins' | 'requestImplies'>): { pinned: string; implied: string; caseText: string | null; oldValue: string; newValue: string } | null {
  const pair = intentConflictPair(conflict);
  if (!pair) return null;
  const { pinned, implied } = pair;
  const split = (text: string) => text.split(/\s*(?:==|->|→|=>)\s*/);
  const [pl, ...pr] = split(pinned); const [il, ...ir] = split(implied);
  if (pr.length && ir.length && squash(pl!) === squash(il!)) return { pinned, implied, caseText: pl!.trim(), oldValue: pr.join(' ').trim(), newValue: ir.join(' ').trim() };
  return { pinned, implied, caseText: null, oldValue: pinned, newValue: implied };
}

function rowAt(intent: Intent | unknown, ref: string): IntentRow | undefined {
  const match = ref.match(ROW_REF);
  if (!match) return undefined;
  return ((intent as Intent | undefined)?.[match[2] as 'happy'] ?? [])[Number(match[3])];
}

function replaceLast(text: string, from: string, to: string): string | null {
  const at = text.lastIndexOf(from);
  if (at >= 0) return `${text.slice(0, at)}${to}${text.slice(at + from.length)}`;
  // Whitespace-insensitive: the literal written with other spacing.
  const pattern = new RegExp(from.trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'g');
  const all = [...text.matchAll(pattern)];
  const last = all.at(-1);
  return last && last.index !== undefined ? `${text.slice(0, last.index)}${to}${text.slice(last.index + last[0].length)}` : null;
}

/** The row patch that re-pins `ref` to the implementer's value, the re-pin stated; null when the row does not state the pin. */
export function intentConflictRowPatch(args: { row: IntentRow | undefined; conflict: JournaledIntentConflict; requestText: string | null }):
  { ref: string; desc: string; derivation: { requestQuote: string; computation: string } } | null {
  const { row, conflict } = args;
  const pair = sides(conflict);
  if (!row?.desc || !pair || !ROW_REF.test(conflict.intentRef)) return null;
  const desc = replaceLast(String(row.desc), pair.pinned, pair.implied);
  if (!desc) return null;
  const caseText = pair.caseText ?? rowPins(String(row.desc)).find(pin => squash(pin.valueText) === squash(pair.oldValue))?.caseText ?? rowPins(String(row.desc))[0]?.caseText ?? conflict.intentRef;
  const sentence = conflict.requestSentence && args.requestText && flat(args.requestText).includes(flat(conflict.requestSentence).replace(/^[-*]\s*/, '')) ? conflict.requestSentence.trim() : null;
  const quote = sentence ?? String(row.derivation?.requestQuote ?? '');
  const computation = `re-pin: ${caseText} was ${pair.oldValue}, now ${pair.newValue}: the implementer [intent-conflict]${conflict.runId ? ` (${conflict.runId})` : ''} reports the request implies ${pair.implied}`
    + `${sentence ? ` ("${sentence.slice(0, 200)}")` : ''}; no request sentence states ${pair.oldValue} and no base check confirms it, so the request side stands`;
  return { ref: conflict.intentRef, desc, derivation: { requestQuote: quote, computation } };
}

/** The ready intentRows of one item's conflicts, or null when any of them cannot be made ready (prose, userSees, no row). */
export function intentConflictReadyRows(item: ItemSlice | undefined, conflicts: readonly JournaledIntentConflict[], requestText: string | null):
  Array<{ ref: string; desc: string; derivation: { requestQuote: string; computation: string } }> | null {
  if (!item || !conflicts.length) return null;
  const out = new Map<string, NonNullable<ReturnType<typeof intentConflictRowPatch>>>();
  for (const conflict of conflicts) {
    const patch = intentConflictRowPatch({ row: rowAt(item.verificationIntent, conflict.intentRef), conflict, requestText });
    if (!patch) return null;
    out.set(patch.ref, patch);
  }
  return [...out.values()];
}

/** The request states the pinned value (its text names the case and the value, or the row's verbatim quote names the value). */
function requestStatesPin(requestText: string | null, pair: NonNullable<ReturnType<typeof sides>>, row: IntentRow | undefined): boolean {
  if (!requestText) return false;
  const text = squash(requestText);
  const caseText = pair.caseText ?? rowPins(String(row?.desc ?? '')).find(pin => squash(pin.valueText) === squash(pair.oldValue))?.caseText ?? null;
  if (text.includes(squash(pair.oldValue)) && (!caseText || text.includes(squash(caseText)))) return true;
  const quote = String(row?.derivation?.requestQuote ?? '');
  return quote.length >= 8 && flat(requestText).includes(flat(quote)) && squash(quote).includes(squash(pair.oldValue));
}

/**
 * The refusal of an amend that keeps a disputed pin (see the module comment), or null. `before` is the item as stored,
 * `afterIntent` the update's whole verificationIntent; `baseConfirms(conflict)` = a base check confirms the pinned value.
 */
export function intentConflictOverrule(args: { storyId: string; itemId: string; before: ItemSlice; afterIntent: unknown; conflicts: readonly JournaledIntentConflict[];
  requestText: string | null; baseConfirms: (conflict: JournaledIntentConflict) => boolean }): { refusal: string; patch: NonNullable<ReturnType<typeof intentConflictRowPatch>>; payload: Record<string, unknown> } | null {
  for (const conflict of args.conflicts.filter(row => row.itemId === args.itemId)) {
    const pair = sides(conflict);
    if (!pair) continue;
    const before = rowAt(args.before.verificationIntent, conflict.intentRef);
    const after = rowAt(args.afterIntent, conflict.intentRef);
    if (!before?.desc || !after?.desc) continue;
    const kept = squash(String(after.desc)).includes(squash(pair.pinned)) && !squash(String(after.desc)).includes(squash(pair.implied));
    if (!kept || !squash(String(before.desc)).includes(squash(pair.pinned))) continue;
    if (requestStatesPin(args.requestText, pair, after) || args.baseConfirms(conflict)) continue;
    const patch = intentConflictRowPatch({ row: before, conflict, requestText: args.requestText });
    if (!patch) continue;
    const payload = { storyId: args.storyId, itemId: args.itemId, intentRows: [patch],
      reason: `the implementer [intent-conflict] on ${conflict.intentRef}: the request implies ${pair.implied}; nothing states ${pair.pinned}`, status: 'pending' };
    const refusal = `checklist_update refused: ${args.itemId} re-asserts the pin ${conflict.intentRef} = ${pair.pinned} that the implementer's [intent-conflict]${conflict.runId ? ` (${conflict.runId})` : ''} disputed `
      + `(the request${conflict.requestSentence ? ` ("${conflict.requestSentence.slice(0, 200)}")` : ''} implies ${pair.implied}). No request sentence states ${pair.pinned} and no base check (counterpart, base form, request probe) confirms it [${INTENT_CONFLICT_OVERRULED}]. `
      + 'Oracle order: a request sentence decides; where the request is silent, the Story base\'s own behaviour; a re-assertion is not evidence. '
      + `If the request does state ${pair.pinned}, quote that sentence verbatim as the row's derivation.requestQuote; otherwise apply the implementer's value (the re-pin stated, the item back to pending):\n`
      + `Next: proof-or-stop checklist_update ${shellQuote(JSON.stringify(payload))}`;
    return { refusal, patch, payload };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Journal (the open conflicts next routed)

const journal = (root: string, storyId: string): string => join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'intent-conflict', `${storyId}.jsonl`);

/** Rewrite the Story's open lane-row conflicts (best effort; evidence for the PLAN amend check). */
export function recordOpenIntentConflicts(root: string, storyId: string, conflicts: readonly JournaledIntentConflict[]): void {
  try {
    const rows = conflicts.filter(row => ROW_REF.test(row.intentRef) && sides(row));
    const path = journal(root, storyId);
    let current = '';
    try { current = readFileSync(path, 'utf8'); } catch { current = ''; }
    const next = rows.map(row => JSON.stringify({ schema: SCHEMA, ...row })).join('\n') + (rows.length ? '\n' : '');
    if (next === current) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
  } catch { /* evidence only */ }
}

/** The journaled open conflicts. */
export function openIntentConflictJournal(root: string, storyId: string): JournaledIntentConflict[] {
  try {
    return readFileSync(journal(root, storyId), 'utf8').split('\n').flatMap(line => {
      try {
        const row = JSON.parse(line) as JournaledIntentConflict & { schema?: string };
        return row?.schema === SCHEMA ? [{ itemId: row.itemId, intentRef: row.intentRef, intentPins: row.intentPins, requestImplies: row.requestImplies, requestSentence: row.requestSentence, ...(row.runId ? { runId: row.runId } : {}) }] : [];
      } catch { return []; }
    });
  } catch { return []; }
}
