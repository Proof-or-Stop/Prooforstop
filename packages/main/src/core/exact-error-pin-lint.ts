/**
 * Old-PoS run 68 (bench-staging/oldpos/run68-analysis.md §4, fix 4, PLAN half): a PLAN lint for
 * rows that pin the EXACT WHOLE error text.
 *
 * Run 68's owner pinned four items' error rows as "exact whole error equals <message>". The
 * engine renders every error with a position suffix after the message, and the request said the
 * message "starts with" the reason, so every one of those rows was wrong; the implementer found
 * them one item at a time (four DEV->PLAN intent-conflict trips, +19 min).
 *
 * The lint lists every open item's row whose expected side says the error text is exact / whole /
 * entire / full / complete / verbatim (literals masked, so the message itself never triggers it)
 * and names a message literal. A message the request itself says must match exactly
 * (requestExactStrings) is never listed: the request outranks the lint. Lab run89 (run88-89-analysis.md §2.2,
 * fix 6): a request literal with placeholders (`size mismatch: want=<X> got=<Y>`) is a template, and a row
 * whose message instantiates it is the text the request demands; a flat list right after an "... must match
 * exactly:" sentence belongs to it as well (run 89 weakened three request-exact pins on the false positive).
 * When the project declares
 * an evaluator (probeRunner, else pinOracle), the listed cases run on the Story base and an error
 * rendered with a trailing decoration after its first line (a position, a source line) confirms the
 * engine's format; without one the lint is advisory text only. Either way it is ONE skippable PLAN
 * step (`exact_error_pin_check`, offered once per set of rows, before the scope-plan reviewer);
 * the framework never rewrites a pin and nothing blocks on it.
 *
 * Generic: no task values, no engine-specific format; the decoration is whatever follows the
 * first line of the base's own error output.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ChecklistItem } from './types.js';
import { VERIFICATION_LANES } from './verification.js';
import { maskLiterals, MASKED_LITERAL } from './request-authority.js';
import { requestExactStrings } from './plan-coverage-matrix.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';

export const EXACT_ERROR_PIN_SCHEMA = 'proof-or-stop.exact-error-pin.v1' as const;
/** The step is offered at most this many times per Story (each for a new set of rows). */
const MAX_OFFERS = 2;

export interface ExactErrorPin { itemId: string; ref: string; desc: string; message: string }

const EXACT_WORD = /\b(?:exact(?:ly)?|verbatim|whole|entire|full|complete)\b/i;
const ERROR_WORD = /\b(?:error|errors|message)\b/i;

const LITERAL = /`([^`\n]*)`|"((?:[^"\\\n]|\\.)*)"|(?<![A-Za-z0-9])'((?:[^'\\\n]|\\.)*)'(?![A-Za-z0-9])/g;

/** The literal spans of a text, in order, without their quotes. */
function literals(text: string): string[] {
  return [...text.matchAll(LITERAL)].map(match => (match[1] ?? match[2] ?? match[3] ?? '').trim());
}

/** The expected side of a row: the text after its last arrow outside any literal, else the whole desc. */
function expectedSide(desc: string): string {
  let cut = 0;
  let last = 0;
  const scan = (from: number, to: number): void => {
    const arrows = [...desc.slice(from, to).matchAll(/->|→|=>/g)];
    if (arrows.length) cut = from + arrows.at(-1)!.index! + arrows.at(-1)![0].length;
  };
  for (const match of desc.matchAll(LITERAL)) { scan(last, match.index!); last = match.index! + match[0].length; }
  scan(last, desc.length);
  return desc.slice(cut);
}

/**
 * Rows of the Story's items (withdrawn ones aside) that pin the exact whole error text: the expected side (after the row's
 * last arrow, else the whole desc), literals masked, names an error / message and says it is
 * exact / whole / entire / full / complete / verbatim, and a literal follows that wording.
 * Rows whose message the request says must match exactly are not listed.
 */
const EXACT_LEAD = /\bmust\s+match\s+exactly\b|\bmust\s+exactly\s+match\b|\bmatch(?:es)?\s+exactly\b|\bexact(?:ly)?\s+(?:the\s+)?(?:errors?|messages?|text|strings?|output)\b|\bverbatim\b|\bbyte-for-byte\b/i;
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+|^\s{2,}\S|^\s*```/;

/**
 * Lab run89 (fix 6): the request's exact literals, plus the backticked literals of a list that follows an "... exactly:"
 * sentence at the same indentation (requestExactStrings reads only deeper-indented continuation lines).
 */
export function requestExactLiterals(requestText: string | null): string[] {
  if (!requestText) return [];
  const out = new Set(requestExactStrings(requestText).map(row => row.literal.trim()));
  const lines = requestText.split('\n');
  lines.forEach((line, at) => {
    if (!EXACT_LEAD.test(line) || !/:\s*$/.test(line) || !/\b(?:errors?|messages?|strings?|text|output)\b/i.test(line)) return;
    let next = at + 1;
    while (next < lines.length && !lines[next]!.trim()) next += 1;
    for (; next < lines.length && lines[next]!.trim() && LIST_LINE.test(lines[next]!); next += 1) {
      for (const span of lines[next]!.matchAll(/`([^`\n]+)`/g)) if (span[1]!.trim().length >= 6) out.add(span[1]!.trim());
    }
  });
  return [...out];
}

const PLACEHOLDER = /<[^<>\n]+>|\{[^{}\n]*\}|%[sdvqfx]/g;
/** Whether a pinned message is a request literal, or instantiates one whose placeholders (`<X>`, `{n}`, `%s`) stand for values. */
export function instantiatesRequestLiteral(message: string, literal: string): boolean {
  const text = message.trim();
  if (text === literal) return true;
  if (!new RegExp(PLACEHOLDER.source).test(literal)) return false;
  const pattern = literal.split(PLACEHOLDER).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?');
  return new RegExp(`^${pattern}$`, 's').test(text);
}

export function exactWholeErrorPins(items: readonly Pick<ChecklistItem, 'id' | 'status' | 'verificationIntent'>[], requestText: string | null): ExactErrorPin[] {
  const exactStrings = requestExactLiterals(requestText);
  const out: ExactErrorPin[] = [];
  for (const item of items) {
    if (item.status === 'withdrawn') continue;
    for (const lane of VERIFICATION_LANES) {
      (item.verificationIntent?.[lane] ?? []).forEach((row, index) => {
        const desc = String(row.desc ?? '');
        const expected = expectedSide(desc);
        const expectedMasked = maskLiterals(expected);
        if (!EXACT_WORD.test(expectedMasked) || !ERROR_WORD.test(expectedMasked) || !expectedMasked.includes(MASKED_LITERAL)) return;
        const message = literals(expected).find(text => /[A-Za-z]/.test(text));
        if (!message || exactStrings.some(literal => instantiatesRequestLiteral(message, literal))) return;
        out.push({ itemId: item.id, ref: `${item.id}:${lane}:${index}`, desc, message });
      });
    }
  }
  return out;
}

/** What follows the first line of an error output (a position, a source line), or null when the output is one line. */
export function errorDecoration(text: string): string | null {
  const trimmed = text.replace(/\s+$/, '');
  const at = trimmed.indexOf('\n');
  if (at < 0) return null;
  const rest = trimmed.slice(at);
  return rest.trim() ? rest : null;
}

function offerFile(root: string, storyId: string): string {
  return join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'exact-error-pin', `${storyId}.jsonl`);
}

export function exactErrorPinSignature(pins: readonly ExactErrorPin[]): string {
  return createHash('sha256').update(pins.map(pin => `${pin.ref}\u0000${pin.desc}`).join('\n')).digest('hex').slice(0, 16);
}

/** Whether the lint step is due: rows are listed, this set was not offered yet, fewer than MAX_OFFERS were made. */
export function exactErrorPinOfferDue(root: string, storyId: string, pins: readonly ExactErrorPin[]): boolean {
  if (!pins.length) return false;
  let offered: string[] = [];
  try {
    offered = readFileSync(offerFile(root, storyId), 'utf8').split('\n').flatMap(line => {
      try { const row = JSON.parse(line) as { signature?: string }; return typeof row.signature === 'string' ? [row.signature] : []; } catch { return []; }
    });
  } catch { offered = []; }
  return offered.length < MAX_OFFERS && !offered.includes(exactErrorPinSignature(pins));
}

/** Record the offer (evidence only; the step is skippable, never a gate). */
export function recordExactErrorPinOffer(root: string, storyId: string, pins: readonly ExactErrorPin[], decoration: { ref: string; sample: string } | null): void {
  try {
    mkdirSync(join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'exact-error-pin'), { recursive: true });
    writeFileSync(offerFile(root, storyId), `${JSON.stringify({ schema: EXACT_ERROR_PIN_SCHEMA, storyId, at: 'next_offer', checkedAt: new Date().toISOString(),
      signature: exactErrorPinSignature(pins), rows: pins.map(pin => pin.ref), baseDecoration: decoration })}\n`, { flag: 'a' });
  } catch { /* evidence only */ }
}
