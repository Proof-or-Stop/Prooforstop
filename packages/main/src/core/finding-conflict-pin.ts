/**
 * Lab run137 (bench-staging/oldpos/run137-analysis.md "Framework waste", fix N): a finding conflict no checklist row pins,
 * decided by the framework without a PLAN trip, ONLY from sources the framework trusts.
 *
 * Run 137: the repair of F-006 ("two-part oversized bounds now clamp; on the base `[0,1,2,3,4][1e20:]` returns
 * `[0, 1, 2, 3, 4]`, HEAD returns `[]`") broke resolved F-004's covering test, which locked the clamped values. No row
 * pinned the case, so lab run131's finding_conflict_settled could not fire: `next` sent the Story to PLAN
 * (finding_conflict_pin). The first trip was eaten by a scope-plan rerun (340 s, no pin), the second wrote six pin rows
 * whose derivations were exactly F-006's stated base values (the request only says existing two-part ranges "stay the
 * same"); then an implementer rerun, a second F-006 repair and an F-008 repair that only added tests: about 23 min.
 *
 * frameworkConflictPin decides such a conflict by the same precedence as finding_conflict_settled (request text > Story
 * base > reviewer opinion), for the cases the open finding names (statedBaseCases: "on the base `E` returns `V`", "`E`
 * returns `V` on base but `W` on HEAD", "Base: `E` -> `V`"), and ONLY from the request: a request line quoting the case's
 * expression with its value (a whole backticked span, `E` -> `V` or `E` then `V`); the side that demands that value wins
 * (source `request`). Nothing a finding wrote is evidence, and no finding-authored expression is executed or matched
 * against project files. Security reviews of this lab removed every other tier: a base probe of a finding's expression
 * could print the finding's own claim; a lexical sanitizer of the expression was bypassable; and a Story-base test line
 * that merely contains the expression and the value also matches a negated assert (`== V { t.Fatal }`, `NotEqual`) or the
 * value in a non-expected position. Run 137 could not have used those tiers anyway (F-006's case is the finding's own
 * expression). Anything else (no request value, a request value neither side demands, a `[precedent-conflict]`) is null:
 * the PLAN pin stays (finding_conflict_pin), and that PLAN trip writes the pin before any scope-plan rerun
 * (handlers/next-driver.ts planConflictPinStep). The pin carries the request's own values as its confirmation record
 * (frameworkPinConfirmed re-checks it). Pure: recomputed from the request on every call (no runtime file is read back);
 * the settle step journals it as evidence only. Switch remediation.conflictPin (default OFF since old-PoS runs 149-151; on = the lab arm).
 */
import { normalizeProbe } from './probe-text.js';

export const FINDING_CONFLICT_FRAMEWORK_PIN = 'finding_conflict_framework_pin';

export interface StatedBaseCase { expr: string; base: string; head?: string }
export interface FrameworkConflictPin {
  /** `finding`: the open finding's demand wins (the resolved finding's test is wrong for the cases); `resolved`: it loses. */
  side: 'finding' | 'resolved';
  source: 'request';
  /** The positive record of what decided each case (never finding text): the request's own value. frameworkPinConfirmed re-checks it. */
  confirmation: { kind: 'request'; cases: Array<{ expr: string; value: string }> };
  /** Each decided case and the value the framework pins for it. */
  cases: Array<{ expr: string; value: string }>;
  reason: string;
}

const VERB = '(?:returns|gives|prints|yields|evaluates to|is|->|=>)';
const SPAN = '`([^`\\n]+)`';
const VALUE = '`([^`\\n]*)`';
const ON_BASE = new RegExp(`\\bon (?:the )?(?:story )?base,?\\s+${SPAN}\\s+(?:it\\s+)?${VERB}\\s+${VALUE}`, 'gi');
const ON_BASE_AFTER = new RegExp(`${SPAN}\\s+${VERB}\\s+${VALUE}\\s+on (?:the )?(?:story )?base\\b(?:[^\`\\n]{0,40}?\\bbut\\s+${VALUE}\\s+on\\s+HEAD\\b)?`, 'gi');
const BASE_COLON = new RegExp(`\\b(?:story )?base:\\s*${SPAN}\\s*(?:->|=>|returns)\\s*${VALUE}`, 'gi');
const HEAD_AFTER = new RegExp(`^[^\`\\n]{0,200}?\\bHEAD\\b\\s+(?:it\\s+)?(?:now\\s+)?${VERB}\\s+${VALUE}`, 'i');

const norm = (text: string): string => normalizeProbe(text).replace(/^(['"])(.*)\1$/, '$2');
const sameValue = (a: string, b: string): boolean => norm(a) === norm(b);

/** The Story base values a finding states, per case (expression), with the HEAD value when it states one too. */
export function statedBaseCases(desc: string | null | undefined): StatedBaseCase[] {
  const text = String(desc ?? '');
  const out: StatedBaseCase[] = [];
  const add = (row: StatedBaseCase): void => {
    if (norm(row.expr).length < 3 || out.some(seen => norm(seen.expr) === norm(row.expr))) return;
    out.push(row.head === undefined ? { expr: row.expr, base: row.base } : row);
  };
  const found: Array<{ at: number; row: StatedBaseCase }> = [];
  for (const match of text.matchAll(ON_BASE)) {
    const head = text.slice(match.index! + match[0].length).match(HEAD_AFTER);
    found.push({ at: match.index!, row: { expr: match[1]!, base: match[2]!, ...(head ? { head: head[1]! } : {}) } });
  }
  for (const match of text.matchAll(ON_BASE_AFTER)) found.push({ at: match.index!, row: { expr: match[1]!, base: match[2]!, ...(match[3] !== undefined ? { head: match[3] } : {}) } });
  for (const match of text.matchAll(BASE_COLON)) found.push({ at: match.index!, row: { expr: match[1]!, base: match[2]! } });
  for (const { row } of found.sort((a, b) => a.at - b.at)) add(row);
  return out;
}

/** The value a request line states for `expr` (the span after it on the line, or `expr -> value` in one span), or null. */
export function requestStatedValue(requestText: string | null | undefined, expr: string): string | null {
  const key = norm(expr);
  for (const line of String(requestText ?? '').split('\n')) {
    if (!normalizeProbe(line).includes(key)) continue;
    const spans = [...line.matchAll(/`([^`\n]*)`/g)].map(match => match[1]!);
    for (let index = 0; index < spans.length; index += 1) {
      const span = spans[index]!;
      const arrow = span.match(/^(.*?)\s*(?:->|=>|==)\s*(.*)$/);
      if (arrow && norm(arrow[1]!) === key) return arrow[2]!.trim();
      if (norm(span) === key && index + 1 < spans.length) return spans[index + 1]!;
    }
  }
  return null;
}

const short = (id: string): string => id.replace(/^[^:]+:(?=F-)/, '');

/** Whether a pin carries a positive record of every case it decides (re-checked before anything is settled). */
export function frameworkPinConfirmed(pin: FrameworkConflictPin): boolean {
  if (!pin.cases.length) return false;
  const confirmation = pin.confirmation;
  return pin.source === 'request' && confirmation?.kind === 'request'
    && pin.cases.every(row => confirmation.cases.some(seen => seen.expr === row.expr && sameValue(seen.value, row.value)));
}

/**
 * The framework's pin for a finding conflict no checklist row pins, or null when it is not the framework's to decide
 * (see the module comment): only a request-quoted value decides.
 */
export function frameworkConflictPin(args: { finding: { id: string; desc?: string }; resolved: { id: string; desc?: string };
  conflict: { kind?: string; resolvedId?: string | null }; requestText: string | null | undefined }): FrameworkConflictPin | null {
  if (args.conflict.kind === 'precedent' || !args.conflict.resolvedId || /\[precedent-conflict\]/i.test(args.finding.desc ?? '')) return null;
  const cases = statedBaseCases(args.finding.desc).filter(row => row.head === undefined || !sameValue(row.head, row.base));
  if (!cases.length) return null;
  const f = short(args.finding.id);
  const g = short(args.resolved.id);
  // The request decides the cases it quotes (precedence: request text first); a silent request is the PLAN pin's.
  const stated = cases.flatMap(row => {
    const value = requestStatedValue(args.requestText, row.expr);
    return value === null ? [] : [{ row, value }];
  });
  if (stated.length) {
    const sides = new Set(stated.map(({ row, value }) => sameValue(value, row.base) ? 'finding' : row.head !== undefined && sameValue(value, row.head) ? 'resolved' : 'neither'));
    // A request value neither side demands, or cases the request decides for different sides: the PLAN pin decides.
    if (sides.size !== 1 || sides.has('neither')) return null;
    const side = [...sides][0] as 'finding' | 'resolved';
    const list = stated.map(({ row, value }) => `\`${row.expr}\` -> \`${value}\``).join(', ');
    const decided = stated.map(({ row, value }) => ({ expr: row.expr, value }));
    return { side, source: 'request', confirmation: { kind: 'request', cases: decided }, cases: decided,
      reason: `the request states ${list}, which ${side === 'finding' ? `open ${f} demands; resolved ${g}'s covering test states otherwise` : `resolved ${g}'s repair keeps; open ${f} demands otherwise`}` };
  }
  return null;
}

/** The repair prompt block of a finding whose conflict the framework pinned on its side (the repair keeps the pinned values). */
export function renderFrameworkConflictPin(pin: FrameworkConflictPin, resolvedId: string): string[] {
  return [
    `Framework pin (${FINDING_CONFLICT_FRAMEWORK_PIN}, precedence request text > Story base > reviewer opinion): ${pin.reason}.`,
    ...pin.cases.map(row => `- \`${row.expr}\` must give \`${row.value}\`.`),
    `- Keep these values, and update the rows of resolved ${short(resolvedId)}'s covering test that state otherwise to them (in the same commit as the code): that finding's guard yields to this pin, its other rows still guard it.`,
  ];
}
