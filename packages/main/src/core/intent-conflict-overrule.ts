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

/** What the row states and what replaces it: whole statements when both sides are `<case> == <value>`, else values. */
function sides(conflict: Pick<JournaledIntentConflict, 'intentPins' | 'requestImplies'>): { pinned: string; implied: string; caseText: string | null; oldValue: string; newValue: string } | null {
  const pinned = conflictFieldLiteral(conflict.intentPins);
  const implied = conflictFieldLiteral(conflict.requestImplies);
  if (!pinned || !implied || squash(pinned) === squash(implied)) return null;
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
