/**
 * D4 + pin audit + D5 (old-PoS run 23 at its source,
 * bench-staging/oldpos/run22-24-analysis.md §1g).
 *
 * Run 23's owner pinned `a[::-1]=[9,8,7,6,5,4] -> [9,8,7,6,5,4]` at INIT
 * (story_create). The request never quotes that value; its rule ("Use the
 * same index-selection semantics as read slicing") gives [4,5,6,7,8,9]. No
 * PLAN check recomputed it, the implementer obeyed it and REVIEW deferred to it.
 *
 * D4 (deterministic, here): every verificationIntent EXAMPLE (a desc with an
 * input -> expected-output separator and a concrete expected value) whose
 * expected value is not quoted verbatim from request.md carries
 * `derivation: { requestQuote, computation }`:
 *   - requestQuote: a verbatim sentence (or clause) of request.md, the rule the
 *     value follows from (whitespace, backticks and case aside; `...` may elide);
 *   - computation: the steps from that sentence to the value; it must state the
 *     pinned value (a computation that reaches another value is the run-23 slip
 *     caught by the owner's own arithmetic).
 * story_create, checklist_update and plan_acceptance_* refuse a missing or
 * invalid derivation ([intent_derivation_required], nothing written);
 * story_review reports a stored one (request recorded or amended later) as
 * `missing_intent_derivation`, and next's plan_authoring batch carries the
 * exact checklist_update with a derivation placeholder.
 *
 * Pin audit (reviewer, scope-plan prompt): whether the derivation is RIGHT is
 * a judgment. The scope-plan reviewer gets the request and every derived row
 * (ref, desc, requestQuote, computation) and recomputes each value from the
 * request; a mismatch is a blocking `pin-audit <ref>` gap.
 *
 * D5 (reviewer rule, not a parser): when the request equates two behaviours
 * ("same ... semantics as X"), at least one intent must use an input where the
 * plausible readings give different outputs; otherwise an `asymmetric-example`
 * gap.
 *
 * Only Stories with a readable request.md are checked; no request, no rule.
 */
import type { ChecklistItem, VerificationIntent, VerificationIntentDerivation, VerificationLane } from './types.js';
import { VERIFICATION_LANES } from './verification.js';

export const INTENT_DERIVATION_REQUIRED = 'intent_derivation_required';
export const MISSING_INTENT_DERIVATION = 'missing_intent_derivation';
export const PIN_AUDIT_GAP_PREFIX = 'pin-audit';
export const ASYMMETRIC_EXAMPLE_GAP_PREFIX = 'asymmetric-example';
/** A requestQuote shorter than this (non-whitespace characters) cites a phrase, not a rule. */
export const DERIVATION_QUOTE_MIN_CHARS = 12;
export const DERIVATION_COMPUTATION_MIN_CHARS = 10;

/** input -> expected separators of an example desc: an arrow (first one) wins over a verb. */
const ARROW = /\s*(?:->|→|=>|⇒|==)\s*/;
const VERB = /\s*\b(?:returns?|yields?|evaluates to|produces?|becomes?|gives?|prints?|outputs?)\b\s*/i;

/** Values compare exactly (case matters: "ab" is not "AB"), whitespace and backticks aside. */
const squash = (text: string): string => text.replace(/[`*]/g, '').replace(/\s+/g, '');
/** A cited sentence compares case-insensitively. */
const squashQuote = (text: string): string => squash(text).toLowerCase();

/** Balanced [...] / {...} groups of a text, outermost only. */
function bracketGroups(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let open = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (depth === 0 && (char === '[' || char === '{')) { depth = 1; start = index; open = char; continue; }
    if (depth > 0) {
      if (char === open) depth += 1;
      else if ((open === '[' && char === ']') || (open === '{' && char === '}')) {
        depth -= 1;
        if (depth === 0) out.push(text.slice(start, index + 1));
      }
    }
  }
  return out;
}

export interface ExpectedValueToken {
  /** The value as written in the desc (a quoted string without its quotes). */
  value: string;
  kind: 'literal' | 'string' | 'group' | 'number';
}

/**
 * The concrete expected values of an example desc: the text after the first
 * input -> output separator, its backticked literals if any, else its
 * double-quoted strings, bracket groups and standalone numbers. null when the
 * desc is not an example (no separator, or no concrete value after it, e.g.
 * "TestUpper passes" or "-> error is reported").
 */
export function intentExampleExpectedValues(desc: string): ExpectedValueToken[] | null {
  const match = desc.match(ARROW) ?? desc.match(VERB);
  if (!match || match.index === undefined) return null;
  const expected = desc.slice(match.index + match[0].length);
  const literals = [...expected.matchAll(/`([^`\n]+)`/g)].map(row => row[1]!.trim()).filter(Boolean);
  if (literals.length) return literals.map(value => ({ value, kind: 'literal' as const }));
  const tokens: ExpectedValueToken[] = [];
  let rest = expected;
  for (const row of expected.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    // An empty string is no checkable value.
    if (row[1]!.trim()) tokens.push({ value: row[1]!, kind: 'string' });
    rest = rest.replace(row[0], ' ');
  }
  for (const group of bracketGroups(rest)) {
    tokens.push({ value: group, kind: 'group' });
    rest = rest.replace(group, ' ');
  }
  for (const row of rest.matchAll(/(?<![\w.:-])-?\d+(?:\.\d+)?(?![\w.:])/g)) tokens.push({ value: row[0], kind: 'number' });
  return tokens.length ? tokens : null;
}

/** True when the value occurs verbatim in the request (whitespace/backticks/case aside; numbers as a whole token). */
function quotedInRequest(token: ExpectedValueToken, squashedRequest: string, requestText: string): boolean {
  if (token.kind === 'number') return new RegExp(`(?<![\\w.])${token.value.replace(/[.-]/g, '\\$&')}(?![\\w])`).test(requestText);
  const target = squash(token.value);
  return target.length > 0 && squashedRequest.includes(target);
}

/** True when the quote (`...` / `…` may elide) occurs in the request, fragments in order. */
export function requestQuoteFound(quote: string, requestText: string): boolean {
  const haystack = squashQuote(requestText);
  let from = 0;
  const fragments = quote.split(/\.\.\.|…/).map(squashQuote).filter(Boolean);
  if (!fragments.length) return false;
  for (const fragment of fragments) {
    const at = haystack.indexOf(fragment, from);
    if (at < 0) return false;
    from = at + fragment.length;
  }
  return true;
}

export type DerivationProblem = 'missing' | 'quote_too_short' | 'quote_not_in_request' | 'computation_too_short' | 'computation_missing_value';

export interface IntentDerivationRow {
  ref: string;
  lane: VerificationLane;
  index: number;
  desc: string;
  /** The expected values not quoted from the request. */
  unquoted: string[];
  derivation?: VerificationIntentDerivation;
  problem: DerivationProblem | null;
}

function derivationProblem(row: { derivation?: unknown }, unquoted: ExpectedValueToken[], requestText: string): DerivationProblem | null {
  const derivation = row.derivation as Partial<VerificationIntentDerivation> | undefined;
  if (!derivation || typeof derivation !== 'object') return 'missing';
  const quote = typeof derivation.requestQuote === 'string' ? derivation.requestQuote : '';
  const computation = typeof derivation.computation === 'string' ? derivation.computation : '';
  if (squash(quote).length < DERIVATION_QUOTE_MIN_CHARS) return 'quote_too_short';
  if (!requestQuoteFound(quote, requestText)) return 'quote_not_in_request';
  if (computation.trim().length < DERIVATION_COMPUTATION_MIN_CHARS) return 'computation_too_short';
  const said = squash(computation);
  if (!unquoted.every(token => said.includes(squash(token.value)))) return 'computation_missing_value';
  return null;
}

/**
 * Every example row of the item whose expected value is not quoted from the
 * request, with its derivation and the problem (null = valid derivation).
 */
export function intentDerivationRows(itemId: string, verificationIntent: VerificationIntent | undefined, requestText: string): IntentDerivationRow[] {
  if (!verificationIntent) return [];
  const squashedRequest = squash(requestText);
  const rows: IntentDerivationRow[] = [];
  for (const lane of VERIFICATION_LANES) {
    for (const [index, intent] of (verificationIntent[lane] ?? []).entries()) {
      const tokens = intentExampleExpectedValues(String(intent.desc ?? ''));
      if (!tokens) continue;
      const unquoted = tokens.filter(token => !quotedInRequest(token, squashedRequest, requestText));
      if (!unquoted.length) continue;
      const problem = derivationProblem(intent, unquoted, requestText);
      rows.push({ ref: intent.id ?? `${itemId}:${lane}:${index}`, lane, index, desc: intent.desc, unquoted: unquoted.map(token => token.value),
        ...(intent.derivation ? { derivation: intent.derivation } : {}), problem });
    }
  }
  return rows;
}

const PROBLEM_TEXT: Record<DerivationProblem, string> = {
  missing: 'no derivation',
  quote_too_short: `requestQuote shorter than ${DERIVATION_QUOTE_MIN_CHARS} characters (cite the whole rule sentence)`,
  quote_not_in_request: 'requestQuote is not a verbatim sentence of request.md',
  computation_too_short: `computation shorter than ${DERIVATION_COMPUTATION_MIN_CHARS} characters`,
  computation_missing_value: 'computation does not state the pinned value',
};

export function describeDerivationProblem(row: IntentDerivationRow): string {
  return `${row.ref} pins ${row.unquoted.map(value => JSON.stringify(value)).join(', ')}: ${row.problem ? PROBLEM_TEXT[row.problem] : 'derivation valid'}`;
}

/** The placeholder derivation next's plan_authoring writes on a row that needs one. */
export function derivationPlaceholder(row: Pick<IntentDerivationRow, 'unquoted'>): VerificationIntentDerivation {
  return {
    requestQuote: '<the request.md sentence this expected value follows from, quoted verbatim>',
    computation: `<the steps from that sentence to ${row.unquoted.join(', ')} (e.g. read slicing a[::-1] selects indexes 5,4,3,2,1,0, so values are assigned in that order); if they reach another value, fix the pinned value>`,
  };
}

export type DerivationCommand = 'story_create' | 'checklist_add' | 'checklist_update' | 'plan_acceptance_prepare' | 'plan_acceptance_apply';

/** The refusal text when any example row of the item lacks a valid derivation, else null. */
export function intentDerivationFailure(command: DerivationCommand, itemId: string, verificationIntent: VerificationIntent | undefined, requestText: string | null): string | null {
  if (requestText === null) return null;
  const bad = intentDerivationRows(itemId, verificationIntent, requestText).filter(row => row.problem !== null);
  if (!bad.length) return null;
  const next = command === 'story_create'
    ? 'Next: rerun story_create with a derivation on each listed row, or quote the expected value from request.md (no Story was created).'
    : `Next: rerun ${command} with the complete verificationIntent and a derivation on each listed row.`;
  return `${command} REFUSED, nothing was written: an example whose expected value is not quoted verbatim from request.md must carry a derivation [${INTENT_DERIVATION_REQUIRED}]\n`
    + `${bad.map(describeDerivationProblem).join('\n')}\n`
    + 'Add to each row: "derivation":{"requestQuote":"<verbatim request.md sentence the value follows from>","computation":"<steps from that sentence to the pinned value, ending at that value>"}. '
    + 'If the computation reaches a different value, the pinned value is wrong: fix it.\n'
    + next;
}

/** Underived rows of a checklist (story_review / next pre-scope), by item. */
export function checklistDerivationGaps(items: readonly Pick<ChecklistItem, 'id' | 'status' | 'verificationIntent'>[], requestText: string): Array<{ itemId: string; rows: IntentDerivationRow[] }> {
  return items.filter(item => item.status !== 'withdrawn')
    .map(item => ({ itemId: item.id, rows: intentDerivationRows(item.id, item.verificationIntent, requestText).filter(row => row.problem !== null) }))
    .filter(entry => entry.rows.length > 0);
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * D5's trigger phrasing, as the same-semantics rule states it: a request
 * sentence making one behaviour follow another ("same ... semantics as X",
 * "works like X", "consistent with X"). Deliberately broad: it only decides
 * whether the scope-plan verdict may be deferred past DEV entry (N8), so a
 * false positive costs one wait, a false negative a run-23 slip.
 */
const SAME_SEMANTICS = /\bsame\b[^.!?\n]{0,80}?\bsemantics?\b|\b(?:works?|behaves?|acts?)\s+(?:just\s+|exactly\s+)?like\b|\bconsistent\s+with\b|\bsame\s+(?:behaviou?r|way)\s+as\b/i;

/** The request sentences the same-semantics rule (D5) applies to. */
export function sameSemanticsSentences(requestText: string): string[] {
  return requestText.split(/(?<=[.!?])\s+|\n+/).map(sentence => sentence.trim()).filter(sentence => sentence && SAME_SEMANTICS.test(sentence));
}

/** Every non-withdrawn intent row pinning a value the request does not quote (the pin-audit rows), with or without a valid derivation. */
export function pinAuditRows(items: readonly Pick<ChecklistItem, 'id' | 'status' | 'verificationIntent'>[], requestText: string): IntentDerivationRow[] {
  return items.filter(item => item.status !== 'withdrawn').flatMap(item => intentDerivationRows(item.id, item.verificationIntent, requestText));
}

/**
 * The scope-plan reviewer's pin audit (D4) and same-semantics rule (D5): the
 * rules plus every row pinning a value the request does not quote, explicitly
 * (ref, desc, requestQuote, computation). A row without a valid derivation is
 * listed too; the reviewer then derives the value itself.
 */
export function renderPinAudit(items: readonly Pick<ChecklistItem, 'id' | 'status' | 'verificationIntent'>[], requestText: string): string[] {
  const rows = pinAuditRows(items, requestText);
  const lines = [
    `Pin audit (blocking): intents pin expected values the request does not quote; the owner can be wrong and DEV will enforce the pin. For each row below, recompute the expected value yourself from the request (the cited sentence and every other request sentence that applies), independently of the computation shown. If your value differs from the pinned one, or the cited sentence does not imply it, record a feature row {"feature":"${PIN_AUDIT_GAP_PREFIX} CHK-<id>:<lane>:<n>: pins <pinned>; request gives <yours> (<why>)","status":"gap","source":"request.md"}. A matching row needs no feature row.`,
  ];
  if (rows.length) {
    lines.push(...rows.map(row => `- ${row.ref}: ${clip(row.desc, 220)}${row.derivation
      ? ` | requestQuote: ${clip(String(row.derivation.requestQuote ?? ''), 240)} | computation: ${clip(String(row.derivation.computation ?? ''), 320)}`
      : ''}${row.problem ? ` | ${PROBLEM_TEXT[row.problem]}: derive it yourself` : ''}`));
  } else {
    lines.push('- (no intent pins a value the request does not quote)');
  }
  lines.push(`Same-semantics rule: when a request sentence makes one behaviour follow another ("same ... semantics as X", "works like X", "consistent with X"), at least one intent must use an input on which the plausible readings give different outputs (e.g. a negative or partial step with unequal values, so selection order matters), with a derivation. If none does, record a gap {"feature":"${ASYMMETRIC_EXAMPLE_GAP_PREFIX}: <the request sentence>","status":"gap","source":"request.md"}.`);
  return lines;
}
