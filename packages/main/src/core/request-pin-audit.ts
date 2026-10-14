/**
 * Old-PoS run 73 (bench-staging/oldpos/run73-analysis.md §6 D): the row-vs-request audit of the rows that answer a
 * scope-plan gap.
 *
 * Run 73's owner resolved two scope-plan gaps from the base's counterpart and pinned `[1,2,3][::-1] -> [1]` while the request
 * sentence "Negative step iterates backward." decides the opposite; the second scope-plan run passed the pins and the
 * implementer raised the conflict (one DEV->PLAN trip, about 8 min). The oracle order is the one `pin_reversal_unstated`
 * (run 58) enforces for re-pins: a request sentence decides; a base-counterpart derivation is allowed only when no request
 * sentence speaks to the case.
 *
 * Two mechanical checks (the rest is prompt-only, see GAP_ROW_QUOTE_RULE):
 *   contradiction      a row pins `<case> -> <value>` and a request example states the same case with another value
 *                      (the request's literal `<input> -> <output>` spans, core/request-literal-examples.ts); the request
 *                      sentence is quoted.
 *   unquoted_sentence  a row added or changed since the last scope-plan verdict (the rows that answer its gaps) carries a
 *                      derivation whose requestQuote is not the request sentence nearest the row's case
 *                      (closestRequestSentence): the owner is asked to quote it, or to say why it does not decide the case.
 * ONE skippable PLAN step lists them (`request_pin_check`, offered once per set of rows, at most twice per Story, before the
 * scope-plan reviewer); the framework never rewrites a pin and nothing blocks on it. Generic: no task values.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChecklistItem } from './types.js';
import { VERIFICATION_LANES } from './verification.js';
import { normalizeProbe } from './probe-text.js';
import { requestLiteralExamples } from './request-literal-examples.js';
import { closestRequestSentence } from './intent-derivation.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';

export const REQUEST_PIN_AUDIT_SCHEMA = 'proof-or-stop.request-pin-audit.v1' as const;
const MAX_OFFERS = 2;

/** Owner-facing rule for every row added or changed in answer to a scope-plan blocker (the `plan_review_blockers` step). */
export const GAP_ROW_QUOTE_RULE = 'For each row you add or change to answer a blocker, quote the request sentence that decides the case (derivation.requestQuote, verbatim); '
  + 'a derivation from the base counterpart (an existing operation of the same receiver) is allowed only when no request sentence speaks to the case, and then say so in the computation.';

export interface RequestPinFinding { itemId: string; ref: string; kind: 'contradiction' | 'unquoted_sentence'; desc: string; pinned: string; sentence: string; requestValue?: string }

type Row = { desc?: string; derivation?: { requestQuote?: string; computation?: string } };

/** The request line that states a literal (the sentence the example is part of), else the literal itself. */
function lineStating(requestText: string, input: string): string {
  const line = requestText.split('\n').find(row => row.includes(input));
  return (line ?? input).trim();
}

/**
 * Rows whose pin contradicts a request example, and (for `changedRefs`) rows whose derivation does not quote the request sentence
 * nearest their case. Withdrawn items are skipped; no request text, nothing to audit.
 */
export function requestPinFindings(items: readonly Pick<ChecklistItem, 'id' | 'status' | 'verificationIntent'>[], requestText: string | null,
  opts: { changedRefs?: ReadonlySet<string> } = {}): RequestPinFinding[] {
  if (!requestText) return [];
  const examples = requestLiteralExamples(requestText);
  const byInput = new Map<string, { output: string; input: string }>();
  for (const example of examples) if (!byInput.has(normalizeProbe(example.input))) byInput.set(normalizeProbe(example.input), example);
  const out: RequestPinFinding[] = [];
  for (const item of items) {
    if (item.status === 'withdrawn') continue;
    for (const lane of VERIFICATION_LANES) {
      ((item.verificationIntent as unknown as Record<string, Row[] | undefined> | undefined)?.[lane] ?? []).forEach((row, index) => {
        const desc = String(row.desc ?? '');
        const ref = `${item.id}:${lane}:${index}`;
        // The row's own `<case> -> <value>` pins (one span, or two spans joined by an arrow / connector), as the request's examples are read.
        const contradiction = requestLiteralExamples(desc).map(pin => ({ pin, example: byInput.get(normalizeProbe(pin.input)) })).find(entry => entry.example && normalizeProbe(entry.example.output) !== normalizeProbe(entry.pin.output));
        if (contradiction?.example) {
          out.push({ itemId: item.id, ref, kind: 'contradiction', desc, pinned: contradiction.pin.output, requestValue: contradiction.example.output, sentence: lineStating(requestText, contradiction.example.input) });
          return;
        }
        if (!opts.changedRefs?.has(ref) || !row.derivation) return;
        const nearest = closestRequestSentence(desc, requestText);
        if (!nearest) return;
        const quote = normalizeProbe(String(row.derivation.requestQuote ?? ''));
        const sentence = normalizeProbe(nearest);
        if (quote.length >= 12 && (quote.includes(sentence) || sentence.includes(quote))) return;
        out.push({ itemId: item.id, ref, kind: 'unquoted_sentence', desc, pinned: String(row.derivation.requestQuote ?? ''), sentence: nearest });
      });
    }
  }
  return out;
}

function offerFile(root: string, storyId: string): string {
  return join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'request-pin-audit', `${storyId}.jsonl`);
}

export function requestPinSignature(rows: readonly RequestPinFinding[]): string {
  return createHash('sha256').update(rows.map(row => `${row.ref}\u0000${row.kind}\u0000${row.desc}`).join('\n')).digest('hex').slice(0, 16);
}

/** Whether the step is due: rows are listed, this set was not offered yet, fewer than MAX_OFFERS were made. */
export function requestPinOfferDue(root: string, storyId: string, rows: readonly RequestPinFinding[]): boolean {
  if (!rows.length) return false;
  let offered: string[] = [];
  try {
    offered = readFileSync(offerFile(root, storyId), 'utf8').split('\n').flatMap(line => {
      try { const row = JSON.parse(line) as { signature?: string }; return typeof row.signature === 'string' ? [row.signature] : []; } catch { return []; }
    });
  } catch { offered = []; }
  return offered.length < MAX_OFFERS && !offered.includes(requestPinSignature(rows));
}

/** Record the offer (evidence only; the step is skippable, never a gate). */
export function recordRequestPinOffer(root: string, storyId: string, rows: readonly RequestPinFinding[]): void {
  try {
    mkdirSync(join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'request-pin-audit'), { recursive: true });
    writeFileSync(offerFile(root, storyId), `${JSON.stringify({ schema: REQUEST_PIN_AUDIT_SCHEMA, storyId, at: 'next_offer', checkedAt: new Date().toISOString(),
      signature: requestPinSignature(rows), rows: rows.map(row => ({ ref: row.ref, kind: row.kind })) })}\n`, { flag: 'a' });
  } catch { /* evidence only */ }
}
