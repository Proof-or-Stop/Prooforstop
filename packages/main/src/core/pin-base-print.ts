/**
 * Lab run132 (bench-staging/oldpos/run132-analysis.md D2, ~1.5 min): a pinned error / output MESSAGE compared with what
 * the Story base's own format string for it prints, before DEV builds anything for it.
 *
 * Run 132's owner pinned `<case with a quoted string operand> -> <existing error format with the operand quoted>`; the
 * base format prints the operand with `%s` of its rendering, which for a string is the bare text (the base's own tests
 * show a quoted string input printed bare). Nothing at PLAN compared the two: request_pin_check reads request literals
 * only, pin_base_form_check operator spacing only, and unstated_pin_check counts any instance of a base format string as
 * supported (its slot matches anything). The implementer built to the base form and declared an `[intent-conflict]`, so
 * the Story went DEV -> PLAN -> DEV for one quote pair.
 *
 * The check, generic and static (no evaluator needed; with plan.pinProbe a declared base evaluator judges error families
 * dynamically too):
 *   pinned message  the expected side of a row (after its last arrow): its first literal of three words or more, else the
 *                   bare side itself (run 132's rows were unbackticked).
 *   base format     a string literal of a Story base NON-test source with printf (`%s %v %d %q`) or brace (`{}` `{0}`
 *                   `${x}`) slots and fixed text of two words or more; the pin instantiates it when the fixed parts
 *                   appear in order (a wrapping prefix ending in `: ` or a space allowed).
 *   kinds           fixed_text    no base format matches as written, exactly one matches once quote characters are
 *                                 ignored: the format's own quotes (or their absence) are fixed text, so the base form
 *                                 re-renders the pin's slot values with the format;
 *                   quoted_verb   a `%q` slot pinned without quotes (Go prints `%q` quoted): base form `"value"`;
 *                   slot_quoting  a `%s`-like slot pinned as a quoted value the row's case quotes, where every base test
 *                                 instance of the same format whose input quotes the slot value prints it the other way
 *                                 (bare, or the reverse): the base form follows the instances;
 *                   unverified    a quoted slot value no base instance decides (advisory only: no patch; probe it).
 *   skipped         a pin the request states verbatim, or instantiating a request template that quotes a placeholder
 *                   itself; a format a request span rewrites (it shares the format's longest fixed part but is no
 *                   instance of it). A request template that keeps the format (run 132: `... <inspect> on ARRAY`) names
 *                   the base format, not how a slot value prints, so the base decides the slot.
 * Each conflict comes with the base form, the format's file:line, the instance sample, and a concrete row patch
 * (`pinBasePrintRowPatch`: the row's request quote kept, the re-pin stated, the format and sample cited).
 *
 * Where it acts (detection-neutral; no gate, no lane, critic or verification change): the PLAN pre-check printed by
 * story_create / checklist_update, and ONE skippable PLAN lint step `pin_base_print_check` (merged with the other PLAN
 * lints, offered once per set of rows, at most twice per Story), before the scope-plan reviewer. A row another base check
 * lists (pin_base_form, unstated_pin, pin_probe) is left to it. Limits: messages built by one format call (not by
 * concatenation), slot renderings judged only by quoting; dynamic output (the slot value's own printer) is plan.pinProbe's.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChecklistItem } from './types.js';
import type { StoryStore } from './store.js';
import { VERIFICATION_LANES } from './verification.js';
import { expectedSide, instantiatesRequestLiteral, literals, PLACEHOLDER } from './exact-error-pin-lint.js';
import { caseSide } from './unstated-pin.js';
import { closestRequestSentence } from './intent-derivation.js';
import { isTestSource, readBaseSources } from './counterpart-coverage.js';
import { pinOracleStoryBase } from './pin-oracle.js';
import { readStoryRequest } from './story-request.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';

export const PIN_BASE_PRINT = 'pin_base_print';
export const PIN_BASE_PRINT_UNVERIFIED = 'pin_base_print_unverified';
export const PIN_BASE_PRINT_SCHEMA = 'proof-or-stop.pin-base-print.v1' as const;
const MAX_OFFERS = 2;
const MIN_WORDS = 3;
const MIN_FIXED = 10;

type IntentRow = { id?: string; desc?: string; derivation?: { requestQuote?: string; computation?: string } };
type ItemLike = Pick<ChecklistItem, 'id' | 'status'> & { verificationIntent?: Partial<Record<string, IntentRow[]>> | null };
export interface SourceText { path: string; text: string }

export interface PinBasePrintConflict {
  itemId: string; ref: string; desc: string; caseText: string; pinned: string;
  kind: 'fixed_text' | 'quoted_verb' | 'slot_quoting' | 'unverified';
  /** The pin re-rendered the way the base prints it; null for an advisory. */
  baseForm: string | null;
  /** The base format string and where it is. */
  format: string; at: string;
  /** slot_quoting: a base test instance of the format (file:line) and its text. */
  sample: string | null; sampleText: string | null;
  requestQuote: string | null;
}

const words = (text: string): number => (text.match(/[A-Za-z]{2,}/g) ?? []).length;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const QUOTES = /["'`]/g;
const SLOT = /%[-+# 0-9.]*[sdvqfxXT]|\$\{[^{}\n]*\}|\{[\w.!:]*\}/g;
const STRING_LITERAL = /"((?:[^"\\\n]|\\.)*)"|`([^`\n]*)`|'((?:[^'\\\n]|\\.){12,})'/g;
const unescape = (text: string): string => text.replace(/\\(["\\'`])/g, '$1');
/** A quoted slot value: the whole value wrapped in one quote pair. */
const QUOTED_VALUE = /^(["'])([^"']*)\1$/;

interface BaseFormat { format: string; parts: string[]; slots: string[]; at: string }
interface Literal { text: string; path: string; line: number; raw: string }

function stringLiterals(files: readonly SourceText[], tests: boolean): Literal[] {
  const out: Literal[] = [];
  for (const file of files) {
    if (isTestSource(file.path) !== tests) continue;
    file.text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(STRING_LITERAL)) out.push({ text: unescape(match[1] ?? match[2] ?? match[3] ?? ''), path: file.path, line: index + 1, raw: line });
    });
  }
  return out;
}

/** The base's format strings: a non-test string literal with slots and fixed text of two words / ten characters or more. */
export function baseFormats(files: readonly SourceText[]): BaseFormat[] {
  const out = new Map<string, BaseFormat>();
  for (const literal of stringLiterals(files, false)) {
    const slots = literal.text.match(SLOT) ?? [];
    if (!slots.length || out.has(literal.text)) continue;
    const parts = literal.text.split(SLOT);
    const fixed = parts.join('');
    if (words(fixed) < 2 || fixed.replace(/\s/g, '').length < MIN_FIXED) continue;
    out.set(literal.text, { format: literal.text, parts, slots, at: `${literal.path}:${literal.line}` });
  }
  return [...out.values()];
}

/** The wrapping prefix and slot values of `text` rendered by `format`, or null; `loose` ignores quote characters. */
function instantiation(format: BaseFormat, text: string, loose = false): { prefix: string; values: string[] } | null {
  const clean = (part: string): string => (loose ? part.replace(QUOTES, '') : part);
  const pattern = format.parts.map((part, index) => escape(clean(part)) + (index < format.slots.length ? (index === format.slots.length - 1 && format.parts.at(-1) === '' ? '(.+)' : '(.+?)') : '')).join('');
  const match = clean(text).match(new RegExp(`^((?:.*?(?:: |\\s))?)${pattern}$`, 's'));
  return match ? { prefix: match[1]!, values: match.slice(2).map(value => value.trim()) } : null;
}

function render(format: BaseFormat, values: readonly string[]): string {
  return format.parts.map((part, index) => part + (index < values.length ? values[index]! : '')).join('');
}

/** The pinned message of a row: the expected side's first literal of three words or more, else the bare expected side. */
export function pinnedMessage(desc: string): string | null {
  const side = expectedSide(desc);
  if (side.length === desc.length) return null;
  const literal = literals(side).find(text => words(text) >= MIN_WORDS);
  if (literal) return literal;
  const bare = side.trim();
  return !bare.includes('`') && words(bare) >= MIN_WORDS ? bare : null;
}

/** How base test instances of `format` render slot `index` when their input quotes that value: 'bare' / 'quoted' / null (none, or mixed). */
function instanceRendering(format: BaseFormat, index: number, tests: readonly Literal[]): { rendering: 'bare' | 'quoted'; sample: Literal } | null {
  const seen = new Map<'bare' | 'quoted', Literal>();
  for (const literal of tests) {
    const value = instantiation(format, literal.text)?.values[index];
    if (!value) continue;
    const quoted = value.match(QUOTED_VALUE);
    const inner = quoted ? quoted[2]! : value;
    if (!/^[\w.-]+$/.test(inner)) continue;
    // The input on the same line (outside this literal) states the value quoted.
    const rest = literal.raw.replace(literal.text, '');
    if (![`"${inner}"`, `\\"${inner}\\"`, `'${inner}'`].some(form => rest.includes(form))) continue;
    const rendering = quoted ? 'quoted' : 'bare';
    if (!seen.has(rendering)) seen.set(rendering, literal);
  }
  if (seen.size !== 1) return null;
  const [rendering, sample] = [...seen][0]!;
  return { rendering, sample };
}

const rowsOf = (item: ItemLike): Array<{ ref: string; row: IntentRow }> => VERIFICATION_LANES.flatMap(lane =>
  ((item.verificationIntent?.[lane] ?? []) as IntentRow[]).map((row, index) => ({ ref: `${item.id}:${lane}:${index}`, row })));

/** A request template that quotes one of its placeholders (`got "<value>"`): the request decides that slot's quoting. */
const QUOTED_PLACEHOLDER = /["'`](?:<[^<>\n]+>|\{[^{}\n]*\}|%[sdvqfx])|(?:<[^<>\n]+>|\{[^{}\n]*\}|%[sdvqfx])["'`]/;

/**
 * Rows pinning a message the request does not state (cheap; no base read). A pin instantiating a request template is
 * kept (run 132: `<existing format with <inspect>>` names the base format, not how the slot prints), unless the
 * template quotes a placeholder itself.
 */
function candidates(items: readonly ItemLike[], requestText: string | null) {
  const request = (requestText ?? '').replace(/\s+/g, ' ');
  const spans = [...(requestText ?? '').matchAll(/`([^`\n]+)`/g)].map(match => match[1]!.trim());
  const out: Array<{ itemId: string; ref: string; row: IntentRow; pinned: string }> = [];
  for (const item of items) {
    if (item.status === 'withdrawn') continue;
    for (const { ref, row } of rowsOf(item)) {
      const pinned = pinnedMessage(String(row.desc ?? ''));
      if (!pinned || request.includes(pinned.replace(/\s+/g, ' ')) || spans.some(span => QUOTED_PLACEHOLDER.test(span) && instantiatesRequestLiteral(pinned, span))) continue;
      out.push({ itemId: item.id, ref, row, pinned });
    }
  }
  return { rows: out, spans };
}

/** Rows whose pinned message the Story base prints differently (and advisories for quoted slot values nothing decides). */
export function pinBasePrintConflicts(args: { items: readonly ItemLike[]; requestText: string | null; files: readonly SourceText[] }): PinBasePrintConflict[] {
  const { rows, spans } = candidates(args.items, args.requestText);
  if (!rows.length) return [];
  // A format the request rewrites (a request span with its longest fixed part that is no instance of it, placeholders
  // read as slot values) is the request's to decide; a span that keeps the format (run 132) leaves the slots to the base.
  const formats = baseFormats(args.files).filter(format => {
    const longest = [...format.parts].sort((a, b) => b.length - a.length)[0]!.trim();
    return longest.length < MIN_FIXED || !spans.some(span => span.includes(longest) && !instantiation(format, span.replace(new RegExp(PLACEHOLDER.source, 'g'), 'x')));
  });
  if (!formats.length) return [];
  const tests = stringLiterals(args.files, true);
  const out: PinBasePrintConflict[] = [];
  for (const { itemId, ref, row, pinned } of rows) {
    const desc = String(row.desc ?? '');
    const caseText = caseSide(desc);
    const entry = (kind: PinBasePrintConflict['kind'], format: BaseFormat, baseForm: string | null, sample: Literal | null = null): PinBasePrintConflict => ({
      itemId, ref, desc, caseText, pinned, kind, baseForm, format: format.format, at: format.at,
      sample: sample ? `${sample.path}:${sample.line}` : null, sampleText: sample?.text ?? null,
      requestQuote: row.derivation?.requestQuote?.trim() || (args.requestText ? closestRequestSentence(desc, args.requestText) : null) || null });
    const strict = formats.flatMap(format => { const match = instantiation(format, pinned); return match ? [{ format, ...match }] : []; });
    if (!strict.length) {
      const loose = formats.flatMap(format => { const match = instantiation(format, pinned, true); return match ? [{ format, ...match }] : []; });
      const forms = new Set(loose.map(({ format, prefix, values }) => `${prefix}${render(format, values)}`));
      const baseForm = [...forms][0];
      // The prefix is read without quotes: kept only when the pin states it as is.
      if (loose.length && forms.size === 1 && pinned.startsWith(loose[0]!.prefix) && baseForm !== pinned) out.push(entry('fixed_text', loose[0]!.format, baseForm!));
      continue;
    }
    // One instantiating format decides; several (generic `%s: %s` shapes) are ambiguous.
    if (strict.length !== 1) continue;
    const { format, prefix, values } = strict[0]!;
    const next = [...values];
    let kind: PinBasePrintConflict['kind'] | null = null;
    let sample: Literal | null = null;
    for (const [index, verb] of format.slots.entries()) {
      const value = values[index]!;
      const quoted = value.match(QUOTED_VALUE);
      if (verb.endsWith('q')) {
        if (!quoted && /^[A-Za-z_][\w.-]*$/.test(value)) { next[index] = `"${value}"`; kind ??= 'quoted_verb'; }
        continue;
      }
      const inner = quoted ? quoted[2]! : value;
      if (!/^[\w.-]+$/.test(inner) || ![`"${inner}"`, `'${inner}'`].some(form => caseText.includes(form))) continue;
      const evidence = instanceRendering(format, index, tests);
      if (!evidence) { if (quoted) kind ??= 'unverified'; continue; }
      if (evidence.rendering === 'bare' && quoted) next[index] = inner;
      else if (evidence.rendering === 'quoted' && !quoted) next[index] = `"${inner}"`;
      else continue;
      if (kind === null || kind === 'unverified') { kind = 'slot_quoting'; sample = evidence.sample; }
    }
    if (!kind) continue;
    if (kind === 'unverified') { out.push(entry('unverified', format, null)); continue; }
    const rendered = `${prefix}${render(format, next)}`;
    if (rendered !== pinned) out.push(entry(kind, format, rendered, sample));
  }
  return out;
}

/** The concrete row patch of one conflict (not an advisory): the base form, the row's request quote, the re-pin stated with the base evidence. */
export function pinBasePrintRowPatch(conflict: PinBasePrintConflict, row?: IntentRow): { ref: string; desc: string; derivation: { requestQuote: string; computation: string } } | null {
  if (!conflict.baseForm) return null;
  const desc = String(row?.desc ?? conflict.desc);
  const at = desc.lastIndexOf(conflict.pinned);
  const patched = at >= 0 ? `${desc.slice(0, at)}${conflict.baseForm}${desc.slice(at + conflict.pinned.length)}` : `${conflict.caseText} -> ${conflict.baseForm}`;
  const why = conflict.kind === 'fixed_text' ? 'whose quotes are fixed text'
    : conflict.kind === 'quoted_verb' ? 'whose %q slot prints the value quoted'
      : `and its base test instance ${conflict.sampleText ? `\`${conflict.sampleText}\` ` : ''}(${conflict.sample}) prints a quoted input value that way`;
  return { ref: conflict.ref, desc: patched, derivation: {
    requestQuote: String(row?.derivation?.requestQuote ?? conflict.requestQuote ?? '').trim(),
    computation: `re-pin: ${conflict.caseText} was ${conflict.pinned}, now ${conflict.baseForm}: the request does not state this text; the Story base prints it with the format \`${conflict.format}\` (${conflict.at}) ${why}`,
  } };
}

/** One line per listed row for a step / pre-check text. */
export function describePinBasePrint(conflict: PinBasePrintConflict): string {
  return conflict.baseForm
    ? `${conflict.ref} pins \`${conflict.pinned}\`; the Story base prints it with \`${conflict.format}\` (${conflict.at})${conflict.sample ? `, as its test instance ${conflict.sample} shows` : ''}: base form \`${conflict.baseForm}\``
    : `${conflict.ref} pins \`${conflict.pinned}\` with a quoted value in a slot of the Story base format \`${conflict.format}\` (${conflict.at}); no Story base instance shows how that slot prints a quoted input: probe the base before DEV builds it`;
}

// ---------------------------------------------------------------------------
// Per-Story evaluation (cached by base + checklist + request), offers

export interface PinBasePrintEvidence { schema: typeof PIN_BASE_PRINT_SCHEMA; storyId: string; checkedAt: string; base: string | null; inputsDigest: string; scanned: number; conflicts: PinBasePrintConflict[] }
const memo = new Map<string, PinBasePrintEvidence>();
const evidencePath = (root: string, storyId: string): string => join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'pin-base-print', `${storyId}.json`);

/** The Story's listed rows (base sources read only when a row pins a message the request does not state); null when unreadable. */
export function planPinBasePrint(store: Pick<StoryStore, 'readStory' | 'readChecklist' | 'storyFilePath'>, root: string, storyId: string, gitCwd: string | (() => string),
  requestOverride?: string | null): PinBasePrintEvidence | null {
  try {
    const items = store.readChecklist(storyId).items as unknown as ItemLike[];
    const request = requestOverride === undefined ? readStoryRequest(store as never, storyId) : null;
    const requestText = requestOverride !== undefined ? requestOverride : request?.status === 'ok' ? request.text : null;
    const empty = (): PinBasePrintEvidence => ({ schema: PIN_BASE_PRINT_SCHEMA, storyId, checkedAt: new Date().toISOString(), base: null, inputsDigest: '', scanned: 0, conflicts: [] });
    if (!candidates(items, requestText).rows.length) return empty();
    const cwd = typeof gitCwd === 'function' ? gitCwd() : gitCwd;
    const story = store.readStory(storyId) as { integrationTarget?: { parentCommitAtCreation?: string } };
    const base = pinOracleStoryBase(cwd, story.integrationTarget?.parentCommitAtCreation);
    const inputsDigest = createHash('sha256').update(JSON.stringify({ v: 1, base, requestText, items: items.map(item => ({ id: item.id, status: item.status, intent: item.verificationIntent })) })).digest('hex');
    const path = evidencePath(root, storyId);
    const cached = memo.get(path);
    if (cached?.inputsDigest === inputsDigest) return cached;
    if (existsSync(path)) {
      try {
        const stored = JSON.parse(readFileSync(path, 'utf8')) as PinBasePrintEvidence;
        if (stored.schema === PIN_BASE_PRINT_SCHEMA && stored.inputsDigest === inputsDigest) { memo.set(path, stored); return stored; }
      } catch { /* recomputed below */ }
    }
    const files = base ? readBaseSources(cwd, base) ?? [] : [];
    const evidence: PinBasePrintEvidence = { schema: PIN_BASE_PRINT_SCHEMA, storyId, checkedAt: new Date().toISOString(), base, inputsDigest, scanned: files.length,
      conflicts: pinBasePrintConflicts({ items, requestText, files }) };
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

const offerFile = (root: string, storyId: string): string => join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'pin-base-print', `${storyId}.offers.jsonl`);

export function pinBasePrintSignature(conflicts: readonly PinBasePrintConflict[]): string {
  return createHash('sha256').update(conflicts.map(row => `${row.ref}\u0000${row.desc}`).join('\n')).digest('hex').slice(0, 16);
}

/** Whether the PLAN step is due: conflicts with a patch listed, this set not offered yet, fewer than MAX_OFFERS made. */
export function pinBasePrintOfferDue(root: string, storyId: string, conflicts: readonly PinBasePrintConflict[]): boolean {
  if (!conflicts.length) return false;
  let offered: string[] = [];
  try {
    offered = readFileSync(offerFile(root, storyId), 'utf8').split('\n').flatMap(line => {
      try { const row = JSON.parse(line) as { signature?: string }; return typeof row.signature === 'string' ? [row.signature] : []; } catch { return []; }
    });
  } catch { offered = []; }
  return offered.length < MAX_OFFERS && !offered.includes(pinBasePrintSignature(conflicts));
}

/** Record the offer (evidence only; the step is skippable, never a gate). */
export function recordPinBasePrintOffer(root: string, storyId: string, conflicts: readonly PinBasePrintConflict[]): void {
  try {
    mkdirSync(dirname(offerFile(root, storyId)), { recursive: true });
    writeFileSync(offerFile(root, storyId), `${JSON.stringify({ schema: PIN_BASE_PRINT_SCHEMA, storyId, at: 'next_offer', checkedAt: new Date().toISOString(),
      signature: pinBasePrintSignature(conflicts), rows: conflicts.map(row => row.ref) })}\n`, { flag: 'a' });
  } catch { /* evidence only */ }
}
