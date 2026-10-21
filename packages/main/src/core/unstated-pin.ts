/**
 * Lab run95 (bench-staging/oldpos/run93-96-analysis.md §5.2, §7 fix 1a): an exact expected TEXT pinned by a PLAN row
 * that neither the request nor the Story base supports, listed before the scope-plan reviewer judges it.
 *
 * Run 95's owner answered a scope-plan gap ("the request does not settle <case>") with a row pinning an exact error
 * text for that case: an instance of a request error template the request scopes to ANOTHER operation. Five scope-plan
 * verdicts in a row disputed the same row (+25 min); the last accepted variant instantiated yet another template whose
 * parameter the case does not have, and the invented message shipped. Lab run89's `pin_base_form_check` covers printed
 * operator spacing only; `request_pin_check` covers a pin that contradicts a request example. Neither looks at an
 * expected text the request simply does not state.
 *
 * The check (generic, static; no evaluator needed):
 *   pinned text   the first literal on a row's expected side (after its last arrow) with three words or more: an error
 *                 message or an output sentence, not a value such as `"AB"` or `42` (those stay with the derivation and
 *                 pin-oracle rules).
 *   supported by  (1) the request: the text is a request literal, or a request sentence states it verbatim;
 *                 (2) the Story base: a string literal of a base source equals it, is a format string it instantiates
 *                     (`%s`, `%d`, `{}`), or is a message prefix (twelve characters or more) it starts with;
 *                 (3) a request template (`<X>`, `{n}`, `%s`) it instantiates, unless the row answers a scope-plan
 *                     verdict (added or changed since it) and its derivation quotes no line of that template's scope (the
 *                     template line, or the list lines that introduce it): then it is listed as `template_scope`, the
 *                     run-95 shape, with the scope the request gives the template.
 *   listed        `unstated` (no support at all) or `template_scope`, in the PLAN pre-check (story_create / an INIT or
 *                 PLAN checklist_update) and as ONE skippable PLAN lint step `unstated_pin_check` (merged with the other
 *                 PLAN lints, offered once per set of rows, at most twice per Story) with a ready row patch: an error
 *                 row is relaxed to "<case> -> error" (the request states no text for it), any other row is removed.
 * Detection-neutral: no gate, no lane, critic or verification change; the owner may skip it (the request decides, then
 * the base, as request_pin_check and pin_base_form_check). A request-stated text is never listed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChecklistItem } from './types.js';
import type { StoryStore } from './store.js';
import { VERIFICATION_LANES } from './verification.js';
import { expectedSide, instantiatesRequestLiteral, literals, PLACEHOLDER } from './exact-error-pin-lint.js';
import { closestRequestSentence } from './intent-derivation.js';
import { readBaseSources } from './counterpart-coverage.js';
import { pinOracleStoryBase } from './pin-oracle.js';
import { readStoryRequest } from './story-request.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';

export const UNSTATED_PIN_SCHEMA = 'proof-or-stop.unstated-pin.v1' as const;
const MAX_OFFERS = 2;
const MIN_WORDS = 3;
const MIN_PREFIX = 12;

type IntentRow = { id?: string; desc?: string; derivation?: { requestQuote?: string; computation?: string } };
type ItemLike = Pick<ChecklistItem, 'id' | 'status'> & { verificationIntent?: Partial<Record<string, IntentRow[]>> | null };
export interface SourceText { path: string; text: string }

export interface UnstatedPin {
  itemId: string; ref: string; desc: string;
  /** The pinned text (the expected side's literal). */
  value: string;
  kind: 'unstated' | 'template_scope';
  /** The row expects an error (its expected side names an error / its text is an error message). */
  error: boolean;
  /** template_scope: the request template the text instantiates and the request lines that scope it. */
  template?: string; scope?: string[];
}

const words = (text: string): number => (text.match(/[A-Za-z]{2,}/g) ?? []).length;
const squash = (text: string): string => text.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
/** A request / quote line compared loosely: list marker, backticks and closing punctuation dropped, lower-case. */
const lineKey = (text: string): string => squash(text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')).replace(/[:.;,]+$/, '').toLowerCase();
const ERROR_TEXT = /\b(?:error|errors|errored|raise[sd]?|throws?|exception|fails?|failed|panic|reject(?:s|ed)?|invalid|not supported|cannot|can't|must not|expects?)\b/i;

/** The pinned text of a row: the first expected-side literal with three words or more; null when the row pins no text. */
export function pinnedText(desc: string): string | null {
  const side = expectedSide(desc);
  return literals(side).find(text => words(text) >= MIN_WORDS) ?? null;
}

/** The case side of a row (the desc before its last arrow outside literals), or the whole desc without one. */
export function caseSide(desc: string): string {
  const side = expectedSide(desc);
  if (side.length === desc.length) return desc.trim();
  return desc.slice(0, desc.length - side.length).replace(/\s*(?:->|→|=>)\s*$/, '').trim();
}

/** Every backticked request literal with a placeholder, with the request lines that scope it (its line, then the list lines above it). */
export function requestTemplates(requestText: string | null): Array<{ template: string; scope: string[] }> {
  if (!requestText) return [];
  const lines = requestText.split('\n');
  const indent = (line: string): number => line.match(/^\s*/)![0].length;
  const out: Array<{ template: string; scope: string[] }> = [];
  lines.forEach((line, at) => {
    for (const span of line.matchAll(/`([^`\n]+)`/g)) {
      const template = span[1]!.trim();
      if (!new RegExp(PLACEHOLDER.source).test(template) || words(template) < MIN_WORDS) continue;
      const scope = [line.trim()];
      let level = indent(line);
      for (let up = at - 1; up >= 0 && scope.length < 4 && level > 0; up -= 1) {
        const above = lines[up]!;
        if (!above.trim()) continue;
        if (indent(above) < level) { scope.push(above.trim()); level = indent(above); }
      }
      out.push({ template, scope });
    }
  });
  return out;
}

/** Whether a quote cites one of the scope lines (either contains the other, twelve characters or more). */
function quotesScope(quote: string, scope: readonly string[]): boolean {
  const q = lineKey(quote);
  if (q.length < MIN_PREFIX) return false;
  return scope.some(line => {
    const key = lineKey(line);
    return key.length >= MIN_PREFIX && (q.includes(key) || key.includes(q));
  });
}

const STRING_LITERAL = /"((?:[^"\\\n]|\\.)*)"|`([^`\n]*)`|'((?:[^'\\\n]|\\.){12,})'/g;

/** The base's string literals of two words or more (messages and format strings), deduplicated. */
export function baseMessageLiterals(files: readonly SourceText[]): string[] {
  const out = new Set<string>();
  for (const file of files) {
    for (const match of file.text.matchAll(STRING_LITERAL)) {
      const text = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\\(["\\'])/g, '$1');
      if (words(text) >= 2) out.add(text);
    }
  }
  return [...out];
}

/** Whether a base literal supports the pinned text: equal, a format string it instantiates, or a message prefix it starts with. */
export function baseSupports(value: string, baseLiterals: readonly string[]): boolean {
  const text = value.trim();
  return baseLiterals.some(literal => literal === text || instantiatesRequestLiteral(text, literal)
    || (literal.trim().length >= MIN_PREFIX && /[:\s]$/.test(literal) && text.startsWith(literal)));
}

const rowsOf = (item: ItemLike): Array<{ ref: string; row: IntentRow }> => VERIFICATION_LANES.flatMap(lane =>
  ((item.verificationIntent?.[lane] ?? []) as IntentRow[]).map((row, index) => ({ ref: `${item.id}:${lane}:${index}`, row })));

/** Rows pinning a text the request does not state (cheap: no base read); each with the template it instantiates, if any. */
function candidates(items: readonly ItemLike[], requestText: string | null) {
  const request = squash(requestText ?? '');
  const templates = requestTemplates(requestText);
  const out: Array<{ itemId: string; ref: string; row: IntentRow; value: string; template: { template: string; scope: string[] } | null }> = [];
  for (const item of items) {
    if (item.status === 'withdrawn') continue;
    for (const { ref, row } of rowsOf(item)) {
      const value = pinnedText(String(row.desc ?? ''));
      if (!value || (request && request.includes(squash(value)))) continue;
      out.push({ itemId: item.id, ref, row, value, template: templates.find(entry => instantiatesRequestLiteral(value, entry.template)) ?? null });
    }
  }
  return out;
}

/**
 * The listed rows. `changedRefs`: rows added or changed since the last scope-plan verdict (the rows that answer it); a
 * template instance is judged by its scope only there. `files`: the Story base sources; null = the base could not be read,
 * so no `unstated` row is listed (its support is unknown), only `template_scope` rows.
 */
export function unstatedPins(args: { items: readonly ItemLike[]; requestText: string | null; files: readonly SourceText[] | null; changedRefs?: ReadonlySet<string> }): UnstatedPin[] {
  const rows = candidates(args.items, args.requestText);
  if (!rows.length) return [];
  let base: string[] | null = null;
  const out: UnstatedPin[] = [];
  for (const { itemId, ref, row, value, template } of rows) {
    const desc = String(row.desc ?? '');
    const error = ERROR_TEXT.test(expectedSide(desc).replace(value, '')) || ERROR_TEXT.test(value);
    if (template) {
      if (!args.changedRefs?.has(ref) || quotesScope(String(row.derivation?.requestQuote ?? ''), template.scope)) continue;
      out.push({ itemId, ref, desc, value, kind: 'template_scope', error, template: template.template, scope: template.scope });
      continue;
    }
    if (!args.files) continue;
    base ??= baseMessageLiterals(args.files);
    if (baseSupports(value, base)) continue;
    out.push({ itemId, ref, desc, value, kind: 'unstated', error });
  }
  return out;
}

/**
 * The ready row patch of a listed row: an error row keeps its case and pins only that an error is raised (the request
 * states no text for it); any other row is removed.
 */
export function unstatedPinRowPatch(pin: UnstatedPin, row: IntentRow | undefined, requestText: string | null): Record<string, unknown> {
  if (!pin.error) return { ref: pin.ref, remove: true };
  const desc = String(row?.desc ?? pin.desc);
  const quote = String(row?.derivation?.requestQuote ?? '').trim() || (requestText ? closestRequestSentence(desc, requestText) ?? '' : '');
  return { ref: pin.ref, desc: `${caseSide(desc)} -> error`, derivation: { requestQuote: quote,
    computation: `The request states no error text for this case${pin.template ? ` (its template \`${pin.template}\` is scoped to: "${pin.scope?.at(-1) ?? ''}")` : ''}; the row pins only that the operation is refused with an error, not the text: error` } };
}

/** One line per listed row for a step / pre-check text. */
export function describeUnstatedPin(pin: UnstatedPin): string {
  return pin.kind === 'template_scope'
    ? `${pin.ref} pins \`${pin.value.slice(0, 100)}\`, an instance of the request template \`${pin.template}\`, which the request scopes to "${(pin.scope ?? []).slice(1).reverse().join(' / ').slice(0, 200) || pin.scope?.[0]}"; the row's derivation quotes no line of that scope`
    : `${pin.ref} pins \`${pin.value.slice(0, 100)}\`, which neither the request states nor a Story base source contains`;
}

// ---------------------------------------------------------------------------
// Per-Story evaluation (cached by base + checklist + request), offers

export interface UnstatedPinEvidence { schema: typeof UNSTATED_PIN_SCHEMA; storyId: string; checkedAt: string; base: string | null; inputsDigest: string; scanned: number; pins: UnstatedPin[] }
const memo = new Map<string, UnstatedPinEvidence>();
const evidencePath = (root: string, storyId: string): string => join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'unstated-pin', `${storyId}.json`);

/** The Story's listed rows (base sources read only when a row pins a text the request does not state); null when unreadable. */
export function planUnstatedPins(store: Pick<StoryStore, 'readStory' | 'readChecklist' | 'storyFilePath'>, root: string, storyId: string, gitCwd: string | (() => string),
  changedRefs?: ReadonlySet<string>): UnstatedPinEvidence | null {
  try {
    const items = store.readChecklist(storyId).items as unknown as ItemLike[];
    const request = readStoryRequest(store as never, storyId);
    const requestText = request.status === 'ok' ? request.text : null;
    const empty = (): UnstatedPinEvidence => ({ schema: UNSTATED_PIN_SCHEMA, storyId, checkedAt: new Date().toISOString(), base: null, inputsDigest: '', scanned: 0, pins: [] });
    if (!requestText || !candidates(items, requestText).length) return empty();
    const cwd = typeof gitCwd === 'function' ? gitCwd() : gitCwd;
    const story = store.readStory(storyId) as { integrationTarget?: { parentCommitAtCreation?: string } };
    const base = pinOracleStoryBase(cwd, story.integrationTarget?.parentCommitAtCreation);
    const changed = [...(changedRefs ?? [])].sort();
    const inputsDigest = createHash('sha256').update(JSON.stringify({ v: 1, base, requestText, changed, items: items.map(item => ({ id: item.id, status: item.status, intent: item.verificationIntent })) })).digest('hex');
    const path = evidencePath(root, storyId);
    const cached = memo.get(path);
    // Security (lab run132 review): recomputed in this process (in-process memo only); the runtime file is a write-only
    // journal and never read back: the owner can write it with a matching inputsDigest (computable from public inputs).
    if (cached?.inputsDigest === inputsDigest) return cached;
    const files = base ? readBaseSources(cwd, base) : null;
    const evidence: UnstatedPinEvidence = { schema: UNSTATED_PIN_SCHEMA, storyId, checkedAt: new Date().toISOString(), base, inputsDigest, scanned: files?.length ?? 0,
      pins: unstatedPins({ items, requestText, files, changedRefs }) };
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

const offerFile = (root: string, storyId: string): string => join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'unstated-pin', `${storyId}.offers.jsonl`);

export function unstatedPinSignature(pins: readonly UnstatedPin[]): string {
  return createHash('sha256').update(pins.map(row => `${row.ref}\u0000${row.desc}`).join('\n')).digest('hex').slice(0, 16);
}

/** Whether the PLAN step is due: rows listed, this set not offered yet, fewer than MAX_OFFERS made. */
export function unstatedPinOfferDue(root: string, storyId: string, pins: readonly UnstatedPin[]): boolean {
  if (!pins.length) return false;
  let offered: string[] = [];
  try {
    offered = readFileSync(offerFile(root, storyId), 'utf8').split('\n').flatMap(line => {
      try { const row = JSON.parse(line) as { signature?: string }; return typeof row.signature === 'string' ? [row.signature] : []; } catch { return []; }
    });
  } catch { offered = []; }
  return offered.length < MAX_OFFERS && !offered.includes(unstatedPinSignature(pins));
}

/** Record the offer (evidence only; the step is skippable, never a gate). */
export function recordUnstatedPinOffer(root: string, storyId: string, pins: readonly UnstatedPin[]): void {
  try {
    mkdirSync(dirname(offerFile(root, storyId)), { recursive: true });
    writeFileSync(offerFile(root, storyId), `${JSON.stringify({ schema: UNSTATED_PIN_SCHEMA, storyId, at: 'next_offer', checkedAt: new Date().toISOString(),
      signature: unstatedPinSignature(pins), rows: pins.map(row => ({ ref: row.ref, kind: row.kind })) })}\n`, { flag: 'a' });
  } catch { /* evidence only */ }
}
