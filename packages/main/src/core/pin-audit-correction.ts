/**
 * Old-PoS run 31 (D8): the scope-plan reviewer was rerun (#4, #5: 3.4 min,
 * 1.16M) only because the owner applied the values its own pin audit asked for.
 *
 * A pin-audit gap reads `pin-audit CHK-<id>:<lane>:<n>: pins <pinned>; request
 * gives <value> (<why>)` (core/intent-derivation.ts renderPinAudit). When the
 * checklist's ONLY changes since the verdict are those requested values, the
 * rerun is replaced by a deterministic check: substituting each requested value
 * back by its pinned value reproduces exactly the checklist the reviewer judged
 * (scope-check.json checklistDigest), and each cited row now states the
 * requested value and no longer the pinned one. Any other change (or an
 * unparsable gap) keeps the rerun. The check can only fail toward a rerun.
 *
 * Lab run132 (bench-staging/oldpos/run133-analysis.md item 1 A, PLAN reruns 3 and 4, ~6.1 min): the correction step
 * offered a call for the first gap's item only (CHK-004:edge:1 was named, never offered), the check was all or
 * nothing, the literal sweep pointed at a read-slice row because it states the same list as a write row's pin, and a
 * row written with `\uXXXX` escapes never matched the reviewer's decoded value. Now:
 *   - a literal matches through `\uXXXX` / `\u{...}` escapes, and a replacement keeps the row's escape form;
 *   - `pinAuditRowPatch` is the ready row patch of one gap: the value side of the row's desc (after its last arrow)
 *     and its computation state the requested value; the case side keeps its text (an input stating the requested
 *     value stays);
 *   - the check applies the gaps whose cited row states the requested value (each reverted on the value side, else in
 *     the whole row), when reverting exactly those reproduces the judged checklist; the rest stays open, and a rest
 *     that is only pin-audit gaps on unchanged rows is the next correction step, not a rerun (`pinAuditGapsPending`);
 *   - the sweep (`pinAuditSweepRows`) lists only rows of the gap row's role (`rowRole`: an assignment to a target
 *     vs a read), and gives a ready patch only to a row stating the same case.
 */
import type { ChecklistData, ChecklistItem, ScopeCheckData } from './types.js';
import { PIN_AUDIT_GAP_PREFIX } from './intent-derivation.js';
import { scopeReviewChecklistDigest } from './scope-check-integrity.js';

export interface PinAuditGap { feature: string; ref: string; itemId: string; lane: string; index: number; pinned: string; requestValue: string }

const LANES = ['happy', 'edge', 'adversarial'] as const;

const ARROW = /\s*(?:->|=>|→)\s*/g;
/** Lab run132: the text after the last top-level arrow of `text` (null without one). */
function afterLastArrow(text: string): { before: string; after: string } | null {
  const arrows = [...text.matchAll(ARROW)];
  const last = arrows.at(-1);
  if (!last || last.index === undefined || last.index === 0) return null;
  return { before: text.slice(0, last.index).trim(), after: text.slice(last.index + last[0].length).trim() };
}
/** Lab run132: the leading literal of a value (a quoted string, a bracket group, a number), or null when it is prose. */
export function leadingLiteral(text: string): string | null {
  const trimmed = text.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'" || quote === '`') {
    for (let index = 1; index < trimmed.length; index += 1) {
      if (trimmed[index] === '\\') { index += 1; continue; }
      if (trimmed[index] === quote) return trimmed.slice(0, index + 1);
    }
    return null;
  }
  if (quote === '[' || quote === '{' || quote === '(') {
    let depth = 0;
    let inString: string | null = null;
    for (let index = 0; index < trimmed.length; index += 1) {
      const char = trimmed[index]!;
      if (inString) { if (char === '\\') index += 1; else if (char === inString) inString = null; continue; }
      if (char === '"' || char === "'") inString = char;
      else if ('[{('.includes(char)) depth += 1;
      else if (']})'.includes(char) && --depth === 0) return trimmed.slice(0, index + 1);
    }
    return null;
  }
  return trimmed.match(/^-?\d+(?:\.\d+)?(?![\w.])/)?.[0] ?? null;
}
/** Lab run132 (run 134): a requested / pinned value without the reviewer's explanation (`(why)`, `because ...`). */
function withoutWhy(text: string): string {
  let value = text.trim();
  const literal = leadingLiteral(value);
  // A literal value ends where its literal ends ("[2] because ..." -> "[2]").
  if (literal && /^\s*(?:$|\(|because\b|since\b|as\b|per\b|,|;|—|-\s)/i.test(value.slice(literal.length))) return literal;
  // Prose (an error text): drop a trailing "(why)", then a trailing "because ..." clause.
  if (value.endsWith(')')) {
    let depth = 0;
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const char = value[index];
      if (char === ')') depth += 1;
      else if (char === '(') { depth -= 1; if (depth === 0) { value = value.slice(0, index).trim(); break; } }
    }
  }
  return value.replace(/\s+because\s[\s\S]*$/i, '').trim();
}

/**
 * One pin-audit gap feature, parsed; null when it does not follow the audit format. Lab run132 (run 134 R2: ten gaps
 * of the form `pins <case> -> <value>; request gives <value> because <why>`, the case itself containing `;`): `pinned`
 * runs to the LAST `; request gives`; a pin stating its case (`<case> -> <value>`) is reduced to its value when the
 * cited row states that case; the requested value loses a restated case and a trailing `(why)` / `because ...`.
 */
export function parsePinAuditGap(feature: string): PinAuditGap | null {
  const match = feature.match(new RegExp(`^${PIN_AUDIT_GAP_PREFIX}\\s+((CHK-\\d+):(happy|edge|adversarial):(\\d+)):\\s*pins\\s+(.+);\\s*request gives\\s+(.+)$`, 's'));
  if (!match) return null;
  let pinned = match[5]!.trim();
  let requestValue = withoutWhy(match[6]!);
  const pinnedCase = afterLastArrow(pinned);
  if (pinnedCase) {
    pinned = withoutWhy(pinnedCase.after);
    const requestedCase = afterLastArrow(requestValue);
    if (requestedCase && requestedCase.before.replace(/\s+/g, '') === pinnedCase.before.replace(/\s+/g, '')) requestValue = withoutWhy(requestedCase.after);
  } else {
    pinned = withoutWhy(pinned);
  }
  if (!pinned || !requestValue || pinned === requestValue) return null;
  return { feature, ref: match[1]!, itemId: match[2]!, lane: match[3]!, index: Number(match[4]), pinned, requestValue };
}

function rowText(item: ChecklistItem | undefined, lane: string, index: number): string {
  const row = item?.verificationIntent?.[lane as typeof LANES[number]]?.[index] as { desc?: string; derivation?: { computation?: string } } | undefined;
  return row ? `${row.desc ?? ''}\n${row.derivation?.computation ?? ''}` : '';
}

/** The cited row's desc (its pinned example). */
function rowDesc(item: ChecklistItem | undefined, lane: string, index: number): string {
  const row = item?.verificationIntent?.[lane as typeof LANES[number]]?.[index] as { desc?: string } | undefined;
  return row?.desc ?? '';
}

/**
 * Old-PoS run 34 (F2): a value occurrence bounded as a token: a value that
 * starts / ends with a word character must not continue a longer word, so a
 * one-character pin `f` is not found inside `"abcdef"` (run 34 tested
 * `includes('f')` and `split('f')` and fell back to a full scope-plan rerun).
 */
function tokenPattern(value: string): RegExp {
  // Lab run132 (run 134): in a bracket group, spacing outside its quoted strings is free (`[1,2]` is the row's `[1, 2]`).
  const group = /^[[{(]/.test(value);
  let quote: string | null = null;
  // Lab run132 (run 133): a non-ASCII character also matches its `\uXXXX` / `\u{...}` escape (the row's source form).
  const escaped = [...value].map((char, index, chars) => {
    if (group && !quote && /\s/.test(char)) return '';
    if (group && !quote && ',[]{}()'.includes(char)) return `\\s*${char === ',' ? ',' : `\\${char}`}\\s*`;
    if (group) {
      if (quote && char === quote && chars[index - 1] !== '\\') quote = null;
      else if (!quote && (char === '"' || char === "'")) quote = char;
    }
    const plain = char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const code = char.codePointAt(0)!;
    if (code < 0x80) return plain;
    const hex = [...code.toString(16)].map(digit => (/[a-f]/.test(digit) ? `[${digit}${digit.toUpperCase()}]` : digit));
    return `(?:${plain}|\\\\u(?:${code <= 0xffff ? `${[...Array(Math.max(0, 4 - hex.length)).fill('0'), ...hex].join('')}|` : ''}\\{0*${hex.join('')}\\}))`;
  }).join('');
  // A group's own opening / closing spacing is not part of the token.
  const body = group ? escaped.replace(/^\\s\*/, '').replace(/\\s\*$/, '') : escaped;
  return new RegExp(`${/^\w/.test(value) ? '(?<!\\w)' : ''}${body}${/\w$/.test(value) ? '(?!\\w)' : ''}`, 'g');
}

/** Lab run132: `to` in the escape form of `span` (a character `span` writes as `\uXXXX` is written so in `to` too). */
function inFormOf(span: string, to: string): string {
  const escapes = new Map<string, string>();
  for (const match of span.matchAll(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g)) escapes.set(String.fromCodePoint(parseInt(match[1] ?? match[2]!, 16)), match[0]);
  return escapes.size ? [...to].map(char => escapes.get(char) ?? char).join('') : to;
}

/** `text` with every token-bounded occurrence of `from` replaced by `to`, in each occurrence's escape form. */
function replaceToken(text: string, from: string, to: string): string {
  return text.replace(tokenPattern(from), span => inFormOf(span, to));
}

/** The value side of a row: the text after its last `->` / `=>` / `→` / `==` (the whole text without one). */
function valueSide(text: string): string {
  const parts = text.split(/->|=>|→|==/);
  return parts.length > 1 ? parts.at(-1)! : text;
}

const hasToken = (text: string, value: string): boolean => tokenPattern(value).test(text);

/** The desc with `from` replaced by `to` on its value side only (the text after its last arrow); unchanged without an arrow. */
function replaceOnValueSide(desc: string, from: string, to: string): string {
  const side = valueSide(desc);
  if (side.length === desc.length) return desc;
  return `${desc.slice(0, desc.length - side.length)}${replaceToken(side, from, to)}`;
}

/**
 * The checklist with each requested value substituted back by its pinned value (token-bounded) in `scope`: the cited
 * rows only, or every text field. Lab run132: `side` 'value' reverts a cited row's desc on its value side only (a ready
 * patch leaves the case side as it was, and that side may state the requested value as an input).
 */
/**
 * Lab run132 (old-PoS run 135 item K): the `re-pin:` clause a pin_audit_correction row states (pin_reversal_unstated
 * requires it once the Story has been in DEV) ends with this text; reverting the requested values drops the clause, so
 * a checklist whose only changes are the requested values (and their re-pin clauses) still reproduces the judged one.
 */
export const PIN_AUDIT_REPIN_WHY = 'the scope-plan pin audit requests this value';
const PIN_AUDIT_REPIN_CLAUSE = new RegExp(`(?:^|;\\s*)re-pin: (?:(?!re-pin: )[\\s\\S])*?: ${PIN_AUDIT_REPIN_WHY}`, 'g');
export const withoutPinAuditRepin = (computation: string): string => computation.replace(PIN_AUDIT_REPIN_CLAUSE, '');

function revertRequestedValues(items: readonly ChecklistItem[], gaps: readonly PinAuditGap[], scope: 'cited' | 'all', side: 'value' | 'whole' = 'whole'): ChecklistItem[] {
  const revert = (text: string, gapsHere: readonly PinAuditGap[]): string => gapsHere.reduce((current, gap) => replaceToken(current, gap.requestValue, gap.pinned), text);
  const revertDesc = (text: string, gapsHere: readonly PinAuditGap[]): string => side === 'value' && scope === 'cited'
    ? gapsHere.reduce((current, gap) => replaceOnValueSide(current, gap.requestValue, gap.pinned), text) : revert(text, gapsHere);
  return items.map(item => {
    const copy = structuredClone(item);
    const mine = gaps.filter(gap => gap.itemId === item.id);
    if (scope === 'all' && typeof copy.userSees === 'string') copy.userSees = revert(copy.userSees, gaps);
    for (const lane of LANES) {
      (copy.verificationIntent?.[lane] ?? []).forEach((row, index) => {
        const applicable = scope === 'all' ? gaps : mine.filter(gap => gap.lane === lane && gap.index === index);
        if (!applicable.length) return;
        if (typeof row.desc === 'string') row.desc = revertDesc(row.desc, applicable);
        const derivation = (row as { derivation?: { computation?: string } }).derivation;
        if (derivation && typeof derivation.computation === 'string') derivation.computation = revert(withoutPinAuditRepin(derivation.computation), applicable);
      });
    }
    return copy;
  });
}

/**
 * The pin-audit gap features the checklist has applied, when its only changes
 * since the verdict are those requested values; otherwise none. Each applied
 * row states the requested value (token-bounded) on its value side and no
 * longer the pinned one, and substituting the requested values back (in the
 * cited rows, on their value side or in the whole row, else in every text field
 * for a sweep over other occurrences) reproduces the checklist the reviewer
 * judged. Lab run132 (run 133): the gaps whose row states the requested value
 * are applied together when reverting exactly those reproduces the judged
 * checklist; the other gaps (unparsable, or not corrected yet) stay open.
 */
export function appliedPinAuditGaps(scope: Pick<ScopeCheckData, 'features' | 'checklistDigest'>, checklist: Pick<ChecklistData, 'items'>,
  baseValues: ReadonlyMap<string, string> = new Map()): Set<string> {
  const gapFeatures = (scope.features ?? []).filter(feature => feature.status === 'gap' && feature.feature.startsWith(PIN_AUDIT_GAP_PREFIX));
  if (!scope.checklistDigest || gapFeatures.length === 0) return new Set();
  const parsed = gapFeatures.map(feature => parsePinAuditGap(feature.feature)).filter((gap): gap is PinAuditGap => Boolean(gap));
  // Lab run132 (run 134, plan.baseEvidence): a gap whose requested value the Story base refutes is decided by the base
  // value (core/pin-base-evidence.ts): equal to the pin, the gap closes while the row keeps it; else it is the value
  // the row must state instead of the reviewer's.
  const sideOf = (gap: PinAuditGap): string => valueSide(rowDesc(checklist.items.find(item => item.id === gap.itemId), gap.lane, gap.index));
  const settled = parsed.filter(gap => baseValues.has(gap.feature) && sameValue(baseValues.get(gap.feature)!, gap.pinned) && hasToken(sideOf(gap), gap.pinned));
  const settledSet = new Set(settled.map(gap => gap.feature));
  if (scopeReviewChecklistDigest(checklist) === scope.checklistDigest) return settledSet;
  const gaps = parsed.filter(gap => !settledSet.has(gap.feature))
    .map(gap => (baseValues.has(gap.feature) ? { ...gap, requestValue: baseValues.get(gap.feature)! } : gap))
    .filter(gap => hasToken(sideOf(gap), gap.requestValue) && !hasToken(sideOf(gap), gap.pinned));
  if (!gaps.length) return settledSet;
  const reverts: Array<['cited' | 'all', 'value' | 'whole']> = [['cited', 'value'], ['cited', 'whole'], ['all', 'whole']];
  const reproduces = reverts.some(([scopeOf, side]) => scopeReviewChecklistDigest({ items: revertRequestedValues(checklist.items, gaps, scopeOf, side) }) === scope.checklistDigest);
  return reproduces ? new Set([...settledSet, ...gaps.map(gap => gap.feature)]) : settledSet;
}

/** Lab run132: two values compare equal: trimmed, one pair of surrounding quotes off, whitespace in a group aside. */
export function sameValue(a: string, b: string): boolean {
  const norm = (value: string): string => {
    let text = value.trim();
    if (text.length >= 2 && /^["'`]/.test(text) && text.at(-1) === text[0]) return text.slice(1, -1);
    if (/^[[{(]/.test(text)) text = text.replace(/'((?:[^'\\]|\\.)*)'/g, (_match, inner: string) => `"${inner}"`).replace(/\s+/g, '');
    return text;
  };
  return norm(a) === norm(b);
}

/**
 * Gap features of a verdict that still stand (applied pin-audit corrections removed). Lab run132: `baseValues` are the
 * base-decided pin-audit gaps (feature -> base value, core/pin-base-evidence.ts pinAuditBaseValues).
 */
export function openScopeGaps<T extends { feature: string; status: string }>(scope: Pick<ScopeCheckData, 'checklistDigest'> & { features?: T[] }, checklist: Pick<ChecklistData, 'items'>,
  baseValues: ReadonlyMap<string, string> = new Map()): T[] {
  const gaps = (scope.features ?? []).filter(feature => feature.status === 'gap');
  if (gaps.length === 0) return gaps;
  const applied = appliedPinAuditGaps(scope as Pick<ScopeCheckData, 'features' | 'checklistDigest'>, checklist, baseValues);
  return applied.size ? gaps.filter(feature => !applied.has(feature.feature)) : gaps;
}

/** Pin-audit gaps whose cited row still states the pinned value (what the owner corrects next). */
export function openPinAuditGaps(scope: Pick<ScopeCheckData, 'features' | 'checklistDigest'>, checklist: Pick<ChecklistData, 'items'>,
  baseValues: ReadonlyMap<string, string> = new Map()): PinAuditGap[] {
  const open = new Set(openScopeGaps(scope, checklist, baseValues).map(feature => feature.feature));
  return (scope.features ?? []).filter(feature => feature.status === 'gap' && open.has(feature.feature))
    .map(feature => parsePinAuditGap(feature.feature)).filter((gap): gap is PinAuditGap => Boolean(gap))
    .filter(gap => hasToken(rowText(checklist.items.find(item => item.id === gap.itemId), gap.lane, gap.index), gap.pinned));
}

/**
 * Lab run132 (run 133): whether every gap still open is a pin-audit gap whose row still states the pinned value, after
 * some gaps were applied: the checklist changed only by those corrections, so the open rest is the next correction
 * step (one ready call per item), not a scope-plan rerun.
 */
export function pinAuditGapsPending(scope: Pick<ScopeCheckData, 'features' | 'checklistDigest'>, checklist: Pick<ChecklistData, 'items'>,
  baseValues: ReadonlyMap<string, string> = new Map()): boolean {
  if (!appliedPinAuditGaps(scope, checklist, baseValues).size) return false;
  const open = openScopeGaps(scope, checklist, baseValues);
  const pending = new Set(openPinAuditGaps(scope, checklist, baseValues).map(gap => gap.feature));
  return open.length > 0 && open.every(feature => pending.has(feature.feature));
}

/** Lab run132 (run 133): a row's role: an assignment to an element / member target ('write'), else a read. */
export function rowRole(desc: string): 'write' | 'read' {
  const caseText = desc.slice(0, desc.length - valueSide(desc).length);
  return /(?:[\w\])]\s*\[[^\]]*\]|\.\w+)\s*(?<![=!<>])=(?![=>])/.test(caseText || desc) ? 'write' : 'read';
}

/** The case side of a desc (before its last arrow), whitespace-normalized; the whole desc without an arrow. */
function caseOf(desc: string): string {
  const side = valueSide(desc);
  return (side.length === desc.length ? desc : desc.slice(0, desc.length - side.length)).replace(/(?:->|=>|→|==)\s*$/, '').replace(/\s+/g, ' ').trim();
}

/**
 * Lab run132 (run 133 A): the ready row patch of one pin-audit gap: the row's desc states the requested value on its
 * value side (the case side keeps its text), its computation states it wherever it stated the pinned value, its
 * request quote is kept. Null when the row is gone or its value side does not state the pinned value.
 */
export function pinAuditRowPatch(item: ChecklistItem | undefined, gap: Pick<PinAuditGap, 'ref' | 'lane' | 'index' | 'pinned' | 'requestValue'>): { ref: string; desc: string; derivation?: Record<string, unknown> } | null {
  const row = item?.verificationIntent?.[gap.lane as typeof LANES[number]]?.[gap.index] as { desc?: string; derivation?: Record<string, unknown> } | undefined;
  if (!row || typeof row.desc !== 'string' || !hasToken(valueSide(row.desc), gap.pinned) || valueSide(row.desc).length === row.desc.length) return null;
  const desc = replaceOnValueSide(row.desc, gap.pinned, gap.requestValue);
  const computation = row.derivation?.computation;
  return { ref: gap.ref, desc, ...(row.derivation ? { derivation: { ...row.derivation, ...(typeof computation === 'string' ? { computation: replaceToken(computation, gap.pinned, gap.requestValue) } : {}) } } : {}) };
}

/**
 * Lab run132 (run 133 A): other rows that state a gap's pinned value on their value side, of the gap row's role only
 * (a read row that yields the same list as a write row's wrong pin is no occurrence of that pin). `ready` rows state
 * the same case as the gap row (the same pin, so the same correction applies); `named` rows only share the role.
 */
export function pinAuditSweepRows(items: readonly ChecklistItem[], gap: PinAuditGap, skip: ReadonlySet<string>): { ready: Array<{ itemId: string; ref: string; patch: NonNullable<ReturnType<typeof pinAuditRowPatch>> }>; named: string[] } {
  const own = rowDesc(items.find(item => item.id === gap.itemId), gap.lane, gap.index);
  const ready: Array<{ itemId: string; ref: string; patch: NonNullable<ReturnType<typeof pinAuditRowPatch>> }> = [];
  const named: string[] = [];
  if (!own) return { ready, named };
  for (const item of items) {
    if (item.status === 'withdrawn') continue;
    for (const lane of LANES) {
      (item.verificationIntent?.[lane] ?? []).forEach((row, index) => {
        const ref = `${item.id}:${lane}:${index}`;
        const desc = String(row.desc ?? '');
        if (skip.has(ref) || ref === gap.ref || !hasToken(valueSide(desc), gap.pinned) || valueSide(desc).length === desc.length || rowRole(desc) !== rowRole(own)) return;
        const patch = caseOf(desc) === caseOf(own) ? pinAuditRowPatch(item, { ref, lane, index, pinned: gap.pinned, requestValue: gap.requestValue }) : null;
        if (patch) ready.push({ itemId: item.id, ref, patch }); else named.push(ref);
      });
    }
  }
  return { ready, named };
}
