/**
 * D4 + pin audit + D5 (old-PoS run 23 at its source,
 * bench-staging/oldpos/run22-24-analysis.md §1g).
 *
 * Run 23's owner pinned, at INIT (story_create), an expected value the request
 * never quotes; the request's own rule (the new operation follows an existing
 * operation's semantics) gives a different value. No PLAN check recomputed it,
 * the implementer obeyed it and REVIEW deferred to it.
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
import { shellQuote } from './shell-quote.js';

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

/** The sentence-like units of a request: list items and lines without their markers, split at sentence ends, code fences dropped. */
function requestSentences(requestText: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of requestText.split('\n')) {
    if (/^\s*```/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const line = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^\s*#{1,6}\s+/, '').trim();
    for (const part of line.split(/(?<=[.!?])\s+(?=[A-Z`])/)) {
      const sentence = part.trim();
      if (squash(sentence).length >= DERIVATION_QUOTE_MIN_CHARS) out.push(sentence);
    }
  }
  return out;
}

const tokensOf = (text: string): Set<string> => new Set((text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []).map(word => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)));

/**
 * Old-PoS run 64: the request sentence closest to a text (a row's desc or a non-verbatim requestQuote), verbatim, or
 * null when no sentence shares at least two words and a third of the smaller word set. story_create's first refusal
 * cost the owner a minute of reading the staged request for exactly this; the owner still writes the computation and
 * judges whether the sentence is the rule the value follows from.
 */
export function closestRequestSentence(text: string, requestText: string): string | null {
  const wanted = tokensOf(text);
  if (wanted.size < 2) return null;
  let best: { sentence: string; score: number; shared: number } | null = null;
  for (const sentence of requestSentences(requestText)) {
    const have = tokensOf(sentence);
    const shared = [...wanted].filter(token => have.has(token)).length;
    const score = shared / Math.min(wanted.size, have.size);
    if (shared >= 2 && score >= 1 / 3 && (!best || score > best.score || (score === best.score && shared > best.shared))) best = { sentence, score, shared };
  }
  return best && requestQuoteFound(best.sentence, requestText) ? best.sentence : null;
}

const PROBLEM_TEXT: Record<DerivationProblem, string> = {
  missing: 'no derivation',
  quote_too_short: `requestQuote shorter than ${DERIVATION_QUOTE_MIN_CHARS} characters (cite the whole rule sentence)`,
  quote_not_in_request: 'requestQuote is not a verbatim sentence of request.md',
  computation_too_short: `computation shorter than ${DERIVATION_COMPUTATION_MIN_CHARS} characters`,
  computation_missing_value: 'computation does not state the pinned value',
};

export function describeDerivationProblem(row: IntentDerivationRow, requestText?: string): string {
  const head = `${row.ref} pins ${row.unquoted.map(value => JSON.stringify(value)).join(', ')}: ${row.problem ? PROBLEM_TEXT[row.problem] : 'derivation valid'}`;
  if (row.problem !== 'quote_not_in_request' || requestText === undefined) return head;
  const written = typeof row.derivation?.requestQuote === 'string' ? row.derivation.requestQuote : '';
  const closest = closestRequestSentence(written || row.desc, requestText) ?? closestRequestSentence(row.desc, requestText);
  return closest ? `${head}; the closest request.md sentence, verbatim: "${closest.replace(/"/g, '\\"')}"` : head;
}

/** The placeholder derivation next's plan_authoring writes on a row that needs one. */
export function derivationPlaceholder(row: Pick<IntentDerivationRow, 'unquoted'> & { desc?: string; suggestedQuote?: string | null }, requestText?: string): VerificationIntentDerivation {
  // Old-PoS run 64: the closest verbatim request sentence is pre-filled (the owner confirms or replaces it); the computation stays the owner's.
  const suggested = row.suggestedQuote ?? (requestText !== undefined && row.desc ? closestRequestSentence(row.desc, requestText) : null);
  return {
    requestQuote: suggested ?? '<the request.md sentence this expected value follows from, quoted verbatim>',
    computation: `<the steps from that sentence to ${row.unquoted.join(', ')} (e.g. the rule the sentence states, applied step by step to this input); if they reach another value, fix the pinned value>`,
  };
}

export type DerivationCommand = 'story_create' | 'checklist_add' | 'checklist_update' | 'plan_acceptance_prepare' | 'plan_acceptance_apply';

/**
 * How the refused checklist_update was sent, so its ONE Next can be a row-level fix (lab initplan,
 * initplan-breakdown.md rank 6): `patches` + `patchRefs` = it was an `intentRows` patch (the Next is
 * the same patch with a derivation added to each listed row); `stagedPath` = a whole-intent write whose
 * payload the handler staged (the Next fixes the listed rows in that file and resubmits it with @file).
 */
export interface DerivationRefusalNext {
  storyId: string;
  patches?: ReadonlyArray<Record<string, unknown>>;
  /** The resulting row ref of each patch, in patch order (applyIntentRowPatches.patchRefs). */
  patchRefs?: readonly string[];
  stagedPath?: string | null;
}

/** The refusal text when any example row of the item lacks a valid derivation, else null. */
export function intentDerivationFailure(command: DerivationCommand, itemId: string, verificationIntent: VerificationIntent | undefined, requestText: string | null,
  route?: DerivationRefusalNext): string | null {
  if (requestText === null) return null;
  const bad = intentDerivationRows(itemId, verificationIntent, requestText).filter(row => row.problem !== null);
  if (!bad.length) return null;
  let next: string;
  if (command === 'story_create') {
    next = 'Next: rerun story_create with a derivation on each listed row, or quote the expected value from request.md (no Story was created).';
  } else if (route?.patches && route.patchRefs) {
    // Lab initplan: the owner sent a row patch; the fix is the same patch with a derivation on each listed row.
    const listed = new Map(bad.map(row => [`${itemId}:${row.lane}:${row.index}`, row]));
    const patches = route.patches.map((patch, at) => {
      const row = listed.get(route.patchRefs![at] ?? '');
      return row ? { ...patch, derivation: derivationPlaceholder({ unquoted: row.unquoted, desc: row.desc }, requestText) } : patch;
    });
    const covered = new Set(route.patchRefs);
    const extra = bad.filter(row => !covered.has(`${itemId}:${row.lane}:${row.index}`))
      .map(row => ({ ref: `${itemId}:${row.lane}:${row.index}`, derivation: derivationPlaceholder({ unquoted: row.unquoted, desc: row.desc }, requestText) }));
    next = `Next: proof-or-stop ${command} ${shellQuote(JSON.stringify({ storyId: route.storyId, itemId, intentRows: [...patches, ...extra] }))}`;
  } else if (route?.stagedPath) {
    next = `Next: fix only the rows listed above in ${route.stagedPath} (the payload you submitted, staged; add each derivation or correct the value there, do not re-send the whole payload), then run: proof-or-stop ${command} @${route.stagedPath}`;
  } else if (route) {
    next = `Next: proof-or-stop ${command} ${shellQuote(JSON.stringify({ storyId: route.storyId, itemId,
      intentRows: bad.map(row => ({ ref: `${itemId}:${row.lane}:${row.index}`, derivation: derivationPlaceholder({ unquoted: row.unquoted, desc: row.desc }, requestText) })) }))}`;
  } else {
    next = `Next: rerun ${command} with a derivation on each listed row (only those rows change).`;
  }
  return `${command} REFUSED, nothing was written: an example whose expected value is not quoted verbatim from request.md must carry a derivation [${INTENT_DERIVATION_REQUIRED}]\n`
    + `${bad.map(row => describeDerivationProblem(row, requestText)).join('\n')}\n`
    + 'Add to each row: "derivation":{"requestQuote":"<verbatim request.md sentence the value follows from>","computation":"<steps from that sentence to the pinned value, ending at that value>"}. '
    + 'If the computation reaches a different value, the pinned value is wrong: fix it.\n'
    + next;
}

/**
 * Lab initplan (initplan-breakdown.md rank 6): the row patch that answers a scope-plan `pin-audit <ref>` gap
 * (the named row, its value and derivation re-authored) or an `asymmetric-example` gap (one appended row on
 * the item, `<CHK-id>` when the gap names none). Flag form, so the remedy stays ONE command line.
 */
export function pinAuditRowPatchCommand(storyId: string, feature: string): string {
  const ref = feature.match(/\b(CHK-\d+):(happy|edge|adversarial):(\d+)\b/);
  const itemId = ref?.[1] ?? feature.match(/\b(CHK-\d+)\b/)?.[1] ?? '<CHK-id>';
  const derivation = { requestQuote: '<the deciding request sentence, verbatim>', computation: '<the steps from it to the pinned value>' };
  const patch = ref
    ? { ref: ref[0], desc: `<${ref[0]} with the expected value the request gives>`, derivation }
    : { ref: `${itemId}:edge:+`, desc: '<an input the plausible readings treat differently -> the value the request gives>', type: 'logic', priority: 'must', scope: 'focused',
      expectation: 'absolute_pass', requirementSource: 'story', verification: { command: '<pinned test command>', selector: '<line its passing run prints>' }, derivation };
  return `proof-or-stop checklist_update --storyId=${storyId} --itemId=${itemId} --intentRows='${JSON.stringify([patch])}'`;
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

/**
 * The request's sections: split at markdown headings and top-level numbered
 * items ("1. Parser support"), the units a same-semantics sentence speaks
 * about. A request without that structure is one section.
 */
export function requestSections(requestText: string): string[] {
  const sections: string[][] = [[]];
  for (const line of requestText.split('\n')) {
    if (/^(?:#{1,6}\s|\d+[.)]\s)/.test(line) && sections.at(-1)!.some(row => row.trim())) sections.push([]);
    sections.at(-1)!.push(line);
  }
  return sections.map(rows => rows.join('\n')).filter(text => text.trim());
}

/**
 * Old-PoS run 27 (per-item N8 hold): the items a same-semantics sentence
 * covers, each with that sentence. An item is covered when one of its intent
 * rows cites (derivation.requestQuote) a sentence of the request section that
 * holds the same-semantics sentence, or when none of its rows cites any
 * request sentence (its scope is unknown, so it is held). Withdrawn items are
 * never held.
 */
export function sameSemanticsCoveredItems(items: readonly Pick<ChecklistItem, 'id' | 'status' | 'verificationIntent'>[], requestText: string): Map<string, string> {
  const covered = new Map<string, string>();
  const sentences = sameSemanticsSentences(requestText);
  if (!sentences.length) return covered;
  const sections = requestSections(requestText);
  const sectionOf = (sentence: string): string => sections.find(section => requestQuoteFound(sentence, section)) ?? requestText;
  const ruled = sentences.map(sentence => ({ sentence, section: sectionOf(sentence) }));
  for (const item of items) {
    if (item.status === 'withdrawn') continue;
    const quotes = VERIFICATION_LANES.flatMap(lane => (item.verificationIntent?.[lane] ?? [])
      .map(row => (row as { derivation?: Partial<VerificationIntentDerivation> }).derivation?.requestQuote)
      .filter((quote): quote is string => typeof quote === 'string' && squash(quote).length >= DERIVATION_QUOTE_MIN_CHARS && requestQuoteFound(quote, requestText)));
    const hit = quotes.length === 0 ? ruled[0] : ruled.find(rule => quotes.some(quote => requestQuoteFound(quote, rule.section)));
    if (hit) covered.set(item.id, hit.sentence);
  }
  return covered;
}

const COMPUTED_PIN = /\b[A-Za-z_][\w.]*\s*(?:==|=|\bis\b)\s*(?:nil|null|undefined|true|false|-?\d+(?:\.\d+)?|"[^"\n]*"|'[^'\n]*'|\[[^\]\n]*\]|\{[^}\n]*\})/g;

/**
 * Old-PoS run 27 (per-item N8 hold): concrete values an item's intent rows
 * state outside the example arrow, i.e. in the desc or the derivation
 * computation, that the request does not quote: `Name=value` / `Name is value`
 * assignments (desc and computation), bracket groups and quoted strings
 * (computation only; a desc's brackets are usually its input syntax). Run 27's scope-plan reviewer
 * flagged `Index=0` / `End=nil` stated only in CHK-001's computations (no
 * example arrow, so no pin-audit row). Over-inclusive on purpose: it only
 * decides whether an item waits for the scope-plan verdict.
 */
export function unquotedStatedPins(item: Pick<ChecklistItem, 'verificationIntent'>, requestText: string): string[] {
  const squashedRequest = squash(requestText);
  const pins = new Set<string>();
  for (const lane of VERIFICATION_LANES) {
    for (const row of item.verificationIntent?.[lane] ?? []) {
      const derivation = (row as { derivation?: Partial<VerificationIntentDerivation> }).derivation;
      // A desc's own brackets are usually the input syntax (an index expression); its
      // example value is the pin audit's. Computations: every stated value.
      for (const [text, all] of [[String(row.desc ?? ''), false], [typeof derivation?.computation === 'string' ? derivation.computation : '', true]] as const) {
        const found = [...text.matchAll(COMPUTED_PIN)].map(match => match[0]);
        if (all) for (const group of bracketGroups(text)) found.push(group);
        if (all) for (const match of text.matchAll(/"((?:[^"\\]|\\.)+)"/g)) found.push(match[1]!);
        for (const value of found) if (squash(value) && !squashedRequest.includes(squash(value))) pins.add(value);
      }
    }
  }
  return [...pins];
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
  lines.push(`Same-semantics rule: when a request sentence makes one behaviour follow another ("same ... semantics as X", "works like X", "consistent with X"), at least one intent must use an input on which the plausible readings give different outputs (e.g. an input the readings traverse or bound differently, with unequal values so the difference shows), with a derivation. If none does, record a gap {"feature":"${ASYMMETRIC_EXAMPLE_GAP_PREFIX}: <the request sentence>","status":"gap","source":"request.md"}.`);
  return lines;
}
