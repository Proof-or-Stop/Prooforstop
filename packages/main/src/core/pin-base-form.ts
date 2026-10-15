/**
 * Lab run89 (bench-staging/oldpos/run88-89-analysis.md §3.4, §5 fix 1): a pinned PRINTED form checked against the
 * Story base's own printer before DEV builds anything for it.
 *
 * Run 89's owner authored the PLAN row `<expr with infix operands> -> <printed form with the infix compacted>`; its
 * derivation quoted only the request sentence that adds the new syntax, and its computation asserted the compact form.
 * The request shows how the NEW construct prints and says nothing about its operands; the base printer already renders
 * an infix operand spaced (`(a + b)`, pinned by the base's own printer tests). The derivation lint accepted the row (it
 * checks that the computation states the value, not that the quote entails it), the implementer built a space-stripping
 * mechanism to satisfy it, and that mechanism produced 6 of the 11 findings, one more variant per review round (about
 * 60 of the run's 96 extra minutes).
 *
 * The check, generic and static (no evaluator needed):
 *   rendering pin   a row whose expected output is a rendering of its own input: the same words in the same order, the
 *                   same characters once spaces and parentheses are dropped (`printerPin`). Evaluation pins are never
 *                   rendering pins.
 *   base printer    string-literal pairs in the Story base's test files where the second is a rendering of the first
 *                   (`{"a + b", "(a + b)"}`): per binary operator token, the spacing the base prints around it
 *                   (`baseOperatorForms`); a convention needs two samples or more, nine in ten agreeing.
 *   conflict        the pin renders a binary operator with other spacing than the base convention, no request span
 *                   shows that operator with the pinned spacing, and the request does not state the pinned output
 *                   (oracle order: the request decides; where it is silent, the base's own rendering of the same token).
 * Each conflict comes with the base form (only the conflicting operators respaced), the base sample (file:line) and a
 * concrete row patch (`pinBaseFormRowPatch`: the row's own request quote kept, the computation citing the base sample).
 *
 * Where it acts (detection-neutral; no gate, no lane, critic or verification change): the PLAN pre-check printed by
 * story_create / checklist_update and ONE skippable PLAN lint step `pin_base_form_check` (merged with the other PLAN
 * lints, offered once per set of rows), before the scope-plan reviewer; and the implementer's `[pin-doubt]` route
 * (core/request-authority.ts), which this module verifies (`pinDoubtVerdict`) so the framework can re-derive the row
 * itself. The framework never rewrites a pin without a step; a pin the request states is never listed.
 * Limits: spacing of binary operator tokens only (parenthesisation, keyword spelling and quoting are not judged);
 * base evidence only from literal pairs in test files.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChecklistItem } from './types.js';
import type { StoryStore } from './store.js';
import { VERIFICATION_LANES } from './verification.js';
import { requestLiteralExamples } from './request-literal-examples.js';
import { closestRequestSentence } from './intent-derivation.js';
import { isTestSource, readBaseSources } from './counterpart-coverage.js';
import { pinOracleStoryBase } from './pin-oracle.js';
import { readStoryRequest } from './story-request.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';

export const PIN_BASE_FORM_SCHEMA = 'proof-or-stop.pin-base-form.v1' as const;
const MAX_OFFERS = 2;
const MIN_SAMPLES = 2;
const AGREEMENT = 0.9;

type IntentRow = { id?: string; desc?: string; derivation?: { requestQuote?: string; computation?: string } };
type ItemLike = Pick<ChecklistItem, 'id' | 'status'> & { verificationIntent?: Partial<Record<string, IntentRow[]>> | null };
export interface SourceText { path: string; text: string }

export interface BaseSample { path: string; line: number; text: string }
export interface BaseOperatorForm { op: string; before: boolean; after: boolean; count: number; total: number; sample: BaseSample }
export interface PinBaseFormConflict {
  itemId: string; ref: string; desc: string; input: string; pinned: string; baseForm: string; requestQuote: string | null;
  operators: Array<{ op: string; pinnedSpacing: string; baseSpacing: string; sample: BaseSample }>;
}

// ---------------------------------------------------------------------------
// Rendering pins and operator spacing

const WORDS = /[A-Za-z_]\w*|\d+(?:\.\d+)?/g;
const skeleton = (text: string): string => text.replace(/[\s()]/g, '');

/** Whether `output` is a rendering of `input`: other text, same words in order, same characters without spaces and parentheses. */
export function isRendering(input: string, output: string): boolean {
  if (!input || !output || input === output) return false;
  if (skeleton(input) !== skeleton(output)) return false;
  return (input.match(WORDS) ?? []).length >= 2 && /[^\w\s()]/.test(skeleton(output));
}

/** The `<input> -> <output>` of a row when its output is a rendering of its input (literal spans first, else one bare arrow), else null. */
export function printerPin(desc: string): { input: string; output: string } | null {
  const spans = requestLiteralExamples(desc);
  const bare = (() => {
    const parts = desc.split(/\s+(?:->|→|=>)\s+/);
    return parts.length === 2 ? [{ input: parts[0]!.trim(), output: parts[1]!.trim() }] : [];
  })();
  for (const candidate of [...spans, ...bare]) if (isRendering(candidate.input, candidate.output)) return candidate;
  return null;
}

/** The text with the contents of quoted strings replaced by `x` (same length), so an operator inside a string is not read. */
function maskQuoted(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, match => `${match[0]}${'x'.repeat(Math.max(0, match.length - 2))}${match.at(-1)}`);
}

interface OperatorOccurrence { op: string; before: boolean; after: boolean; start: number; end: number }
const OPERATOR_RUN = /[+\-*/%<>=!&|^~?:]+|,/g;

/** Binary operator tokens of a rendered text: an operator run between an operand end (word, closing bracket, quote) and an operand start. */
export function binaryOperators(text: string): OperatorOccurrence[] {
  const masked = maskQuoted(text);
  const out: OperatorOccurrence[] = [];
  for (const match of masked.matchAll(OPERATOR_RUN)) {
    const start = match.index!;
    const end = start + match[0].length;
    let p = start - 1;
    while (p >= 0 && masked[p] === ' ') p -= 1;
    let n = end;
    while (n < masked.length && masked[n] === ' ') n += 1;
    const prev = masked[p];
    const next = masked[n];
    if (prev === undefined || next === undefined) continue;
    if (!/[\w)\]}"'`]/.test(prev) || !/[\w(\[{"'`\-!]/.test(next)) continue;
    out.push({ op: match[0], before: masked[start - 1] === ' ', after: masked[end] === ' ', start, end });
  }
  return out;
}

const spacingOf = (before: boolean, after: boolean): string => `${before ? 'a ' : 'a'}OP${after ? ' b' : 'b'}`;
const spacingLabel = (op: string, before: boolean, after: boolean): string => spacingOf(before, after).replace('OP', op);

const LITERAL = /"((?:[^"\\\n]|\\.)*)"|`([^`\n]*)`/g;
const unescape = (text: string): string => text.replace(/\\(["\\'nt])/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));

/** The base printer's spacing per binary operator token, from rendering pairs in test files (two samples or more, nine in ten agreeing). */
export function baseOperatorForms(files: readonly SourceText[]): Record<string, BaseOperatorForm> {
  const tally = new Map<string, Map<string, { before: boolean; after: boolean; count: number; sample: BaseSample }>>();
  for (const file of files) {
    if (!isTestSource(file.path)) continue;
    const literals: Array<{ text: string; line: number }> = [];
    file.text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(LITERAL)) literals.push({ text: unescape(match[1] ?? match[2] ?? ''), line: index + 1 });
    });
    for (let i = 0; i + 1 < literals.length; i += 1) {
      const input = literals[i]!;
      const output = literals[i + 1]!;
      if (output.line - input.line > 2 || !isRendering(input.text, output.text)) continue;
      for (const occurrence of binaryOperators(output.text)) {
        const forms = tally.get(occurrence.op) ?? new Map();
        const key = spacingOf(occurrence.before, occurrence.after);
        const row = forms.get(key) ?? { before: occurrence.before, after: occurrence.after, count: 0, sample: { path: file.path, line: output.line, text: output.text } };
        row.count += 1;
        forms.set(key, row);
        tally.set(occurrence.op, forms);
      }
    }
  }
  const out: Record<string, BaseOperatorForm> = {};
  for (const [op, forms] of tally) {
    const rows = [...forms.values()].sort((a, b) => b.count - a.count);
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const top = rows[0]!;
    if (total >= MIN_SAMPLES && top.count / total >= AGREEMENT) out[op] = { op, before: top.before, after: top.after, count: top.count, total, sample: top.sample };
  }
  return out;
}

/** `text` with the listed operators respaced to the base convention. */
function respaced(text: string, forms: Record<string, BaseOperatorForm>, ops: ReadonlySet<string>): string {
  let out = text;
  for (const occurrence of binaryOperators(text).reverse()) {
    if (!ops.has(occurrence.op)) continue;
    const form = forms[occurrence.op]!;
    let left = occurrence.start;
    while (left > 0 && out[left - 1] === ' ') left -= 1;
    let right = occurrence.end;
    while (right < out.length && out[right] === ' ') right += 1;
    out = `${out.slice(0, left)}${form.before ? ' ' : ''}${occurrence.op}${form.after ? ' ' : ''}${out.slice(right)}`;
  }
  return out;
}

/** Operator spacings the request shows in its literal spans (`op` -> set of spacing keys). */
function requestSpacings(requestText: string | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const span of (requestText ?? '').matchAll(/`([^`\n]+)`/g)) {
    for (const occurrence of binaryOperators(span[1]!)) {
      const set = out.get(occurrence.op) ?? new Set<string>();
      set.add(spacingOf(occurrence.before, occurrence.after));
      out.set(occurrence.op, set);
    }
  }
  return out;
}

const rowsOf = (item: ItemLike): Array<{ ref: string; row: IntentRow }> => VERIFICATION_LANES.flatMap(lane =>
  ((item.verificationIntent?.[lane] ?? []) as IntentRow[]).map((row, index) => ({ ref: `${item.id}:${lane}:${index}`, row })));

/** The rendering pins whose output renders an operator with spacing the request does not show (cheap; no base read). */
function candidatePins(items: readonly ItemLike[], requestText: string | null) {
  const shown = requestSpacings(requestText);
  const out: Array<{ itemId: string; ref: string; row: IntentRow; pin: { input: string; output: string }; occurrences: OperatorOccurrence[] }> = [];
  for (const item of items) {
    if (item.status === 'withdrawn') continue;
    for (const { ref, row } of rowsOf(item)) {
      const pin = printerPin(String(row.desc ?? ''));
      if (!pin || (requestText && requestText.includes(pin.output))) continue;
      const occurrences = binaryOperators(pin.output).filter(occurrence => !shown.get(occurrence.op)?.has(spacingOf(occurrence.before, occurrence.after)));
      if (occurrences.length) out.push({ itemId: item.id, ref, row, pin, occurrences });
    }
  }
  return out;
}

/** Rows whose pinned printed form contradicts the base printer's spacing of an operator the request does not show. */
export function pinBaseFormConflicts(args: { items: readonly ItemLike[]; requestText: string | null; files: readonly SourceText[] }): PinBaseFormConflict[] {
  const candidates = candidatePins(args.items, args.requestText);
  if (!candidates.length) return [];
  const forms = baseOperatorForms(args.files);
  const out: PinBaseFormConflict[] = [];
  for (const { itemId, ref, row, pin, occurrences } of candidates) {
    const conflicting = new Map<string, PinBaseFormConflict['operators'][number]>();
    for (const occurrence of occurrences) {
      const form = forms[occurrence.op];
      if (!form || (form.before === occurrence.before && form.after === occurrence.after) || conflicting.has(occurrence.op)) continue;
      conflicting.set(occurrence.op, { op: occurrence.op, pinnedSpacing: spacingLabel(occurrence.op, occurrence.before, occurrence.after),
        baseSpacing: spacingLabel(occurrence.op, form.before, form.after), sample: form.sample });
    }
    if (!conflicting.size) continue;
    const baseForm = respaced(pin.output, forms, new Set(conflicting.keys()));
    if (baseForm === pin.output) continue;
    out.push({ itemId, ref, desc: String(row.desc ?? ''), input: pin.input, pinned: pin.output, baseForm,
      requestQuote: row.derivation?.requestQuote?.trim() || (args.requestText ? closestRequestSentence(String(row.desc ?? ''), args.requestText) : null) || null,
      operators: [...conflicting.values()] });
  }
  return out;
}

/** The concrete row patch of one conflict: the base form, the row's request quote, a computation citing the base sample. */
export function pinBaseFormRowPatch(conflict: PinBaseFormConflict, row?: IntentRow): { ref: string; desc: string; derivation: { requestQuote: string; computation: string } } {
  const desc = String(row?.desc ?? conflict.desc);
  const at = desc.lastIndexOf(conflict.pinned);
  const patched = at >= 0 ? `${desc.slice(0, at)}${conflict.baseForm}${desc.slice(at + conflict.pinned.length)}` : `${conflict.input} -> ${conflict.baseForm}`;
  const ops = conflict.operators.map(entry => `\`${entry.op}\` as \`${entry.sample.text}\` (${entry.sample.path}:${entry.sample.line})`).join(', ');
  return { ref: conflict.ref, desc: patched, derivation: {
    requestQuote: String(row?.derivation?.requestQuote ?? conflict.requestQuote ?? '').trim(),
    computation: `The request shows no rendering of ${conflict.operators.map(entry => `\`${entry.op}\``).join(', ')} in this position (it is silent); the Story base printer renders ${ops}, so ${conflict.input} renders as ${conflict.baseForm}`,
  } };
}

// ---------------------------------------------------------------------------
// Per-Story evaluation (cached by base + checklist + request), offers, pin doubts

export interface PinBaseFormEvidence { schema: typeof PIN_BASE_FORM_SCHEMA; storyId: string; checkedAt: string; base: string | null; inputsDigest: string; scanned: number; conflicts: PinBaseFormConflict[] }
const memo = new Map<string, PinBaseFormEvidence>();
const evidencePath = (root: string, storyId: string): string => join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'pin-base-form', `${storyId}.json`);

/** The Story's conflicts (base sources read only when a rendering pin shows an operator spacing the request does not); null when unreadable. */
export function planPinBaseForm(store: Pick<StoryStore, 'readStory' | 'readChecklist' | 'storyFilePath'>, root: string, storyId: string, gitCwd: string | (() => string)): PinBaseFormEvidence | null {
  try {
    const items = store.readChecklist(storyId).items as unknown as ItemLike[];
    const request = readStoryRequest(store as never, storyId);
    const requestText = request.status === 'ok' ? request.text : null;
    const path = evidencePath(root, storyId);
    if (!candidatePins(items, requestText).length) return { schema: PIN_BASE_FORM_SCHEMA, storyId, checkedAt: new Date().toISOString(), base: null, inputsDigest: '', scanned: 0, conflicts: [] };
    const cwd = typeof gitCwd === 'function' ? gitCwd() : gitCwd;
    const story = store.readStory(storyId) as { integrationTarget?: { parentCommitAtCreation?: string } };
    const base = pinOracleStoryBase(cwd, story.integrationTarget?.parentCommitAtCreation);
    const inputsDigest = createHash('sha256').update(JSON.stringify({ v: 1, base, requestText, items: items.map(item => ({ id: item.id, status: item.status, intent: item.verificationIntent })) })).digest('hex');
    const cached = memo.get(path);
    if (cached?.inputsDigest === inputsDigest) return cached;
    if (existsSync(path)) {
      try {
        const stored = JSON.parse(readFileSync(path, 'utf8')) as PinBaseFormEvidence;
        if (stored.schema === PIN_BASE_FORM_SCHEMA && stored.inputsDigest === inputsDigest) { memo.set(path, stored); return stored; }
      } catch { /* recomputed below */ }
    }
    const files = base ? (readBaseSources(cwd, base) ?? []).filter(file => isTestSource(file.path)) : [];
    const evidence: PinBaseFormEvidence = { schema: PIN_BASE_FORM_SCHEMA, storyId, checkedAt: new Date().toISOString(), base, inputsDigest, scanned: files.length,
      conflicts: pinBaseFormConflicts({ items, requestText, files }) };
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
    } catch { /* evidence of a check `next` repeats; never fails a step */ }
    memo.set(path, evidence);
    return evidence;
  } catch {
    return null;
  }
}

const offerFile = (root: string, storyId: string): string => join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'pin-base-form', `${storyId}.offers.jsonl`);

export function pinBaseFormSignature(conflicts: readonly PinBaseFormConflict[]): string {
  return createHash('sha256').update(conflicts.map(row => `${row.ref}\u0000${row.desc}`).join('\n')).digest('hex').slice(0, 16);
}

/** Whether the PLAN step is due: conflicts listed, this set not offered yet, fewer than MAX_OFFERS made. */
export function pinBaseFormOfferDue(root: string, storyId: string, conflicts: readonly PinBaseFormConflict[]): boolean {
  if (!conflicts.length) return false;
  let offered: string[] = [];
  try {
    offered = readFileSync(offerFile(root, storyId), 'utf8').split('\n').flatMap(line => {
      try { const row = JSON.parse(line) as { signature?: string }; return typeof row.signature === 'string' ? [row.signature] : []; } catch { return []; }
    });
  } catch { offered = []; }
  return offered.length < MAX_OFFERS && !offered.includes(pinBaseFormSignature(conflicts));
}

/** Record the offer (evidence only; the step is skippable, never a gate). */
export function recordPinBaseFormOffer(root: string, storyId: string, conflicts: readonly PinBaseFormConflict[]): void {
  try {
    mkdirSync(dirname(offerFile(root, storyId)), { recursive: true });
    writeFileSync(offerFile(root, storyId), `${JSON.stringify({ schema: PIN_BASE_FORM_SCHEMA, storyId, at: 'next_offer', checkedAt: new Date().toISOString(),
      signature: pinBaseFormSignature(conflicts), rows: conflicts.map(row => row.ref) })}\n`, { flag: 'a' });
  } catch { /* evidence only */ }
}

/** One line per conflict for a step / pre-check text. */
export function describePinBaseForm(conflict: PinBaseFormConflict): string {
  return `${conflict.ref} pins \`${conflict.pinned}\`; the Story base prints ${conflict.operators.map(entry => `\`${entry.op}\` as \`${entry.sample.text}\` (${entry.sample.path}:${entry.sample.line})`).join(', ')} and the request shows no other form: base form \`${conflict.baseForm}\``;
}

/**
 * An implementer / repair `[pin-doubt]` on `ref`, judged by the framework: refused when the row does not exist or the
 * request states the pinned output; accepted otherwise, with the framework's row patch when the base-printer check
 * confirms the doubt (then the re-derivation is the framework's), else none (the owner re-derives the row).
 */
export function pinDoubtVerdict(args: { items: readonly ItemLike[]; ref: string; requestText: string | null; conflicts: readonly PinBaseFormConflict[] }):
  { accepted: false; why: string } | { accepted: true; itemId: string; pinned: string | null; patch: ReturnType<typeof pinBaseFormRowPatch> | null } {
  const itemId = args.ref.split(':')[0];
  const item = args.items.find(row => row.id === itemId);
  const rows = item ? rowsOf(item) : [];
  const found = rows.find(entry => entry.ref === args.ref) ?? rows.find(entry => entry.row.id === args.ref);
  if (!item || !found) return { accepted: false, why: `no row ${args.ref}` };
  const desc = String(found.row.desc ?? '');
  const pinned = printerPin(desc)?.output ?? requestLiteralExamples(desc)[0]?.output ?? desc.split(/\s+(?:->|→|=>)\s+/)[1]?.trim() ?? null;
  if (pinned && args.requestText?.includes(pinned)) return { accepted: false, why: `the request states ${pinned}` };
  const conflict = args.conflicts.find(row => row.ref === found.ref);
  return { accepted: true, itemId: item.id, pinned, patch: conflict ? pinBaseFormRowPatch(conflict, found.row) : null };
}
