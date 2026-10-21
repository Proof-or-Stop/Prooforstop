/**
 * Lab run137 (bench-staging/oldpos/run137-analysis.md "Framework waste", fix N): a finding conflict no checklist row pins,
 * decided by the framework without a PLAN trip.
 *
 * Run 137: the repair of F-006 ("two-part oversized bounds now clamp; on the base `[0,1,2,3,4][1e20:]` returns
 * `[0, 1, 2, 3, 4]`, HEAD returns `[]`") broke resolved F-004's covering test, which locked the clamped values. No row
 * pinned the case, so lab run131's finding_conflict_settled could not fire: `next` sent the Story to PLAN
 * (finding_conflict_pin). The first trip was eaten by a scope-plan rerun (340 s, no pin), the second wrote six pin rows
 * whose derivations were exactly F-006's stated base values (the request only says existing two-part ranges "stay the
 * same"); then an implementer rerun, a second F-006 repair and an F-008 repair that only added tests: about 23 min.
 *
 * frameworkConflictPin decides such a conflict by the same precedence as finding_conflict_settled (request text > Story
 * base > reviewer opinion), from inputs the framework reads itself:
 *   - the request: a request line naming a case's expression with a value decides it (the side that demands that value
 *     wins, source `request`);
 *   - else the Story base value the open finding states for each case (statedBaseCases: "on the base `E` returns `V`",
 *     "`E` returns `V` on base but `W` on HEAD", "Base: `E` -> `V`"): the finding demands the base behaviour and the
 *     resolved finding's test pins something else, so the finding wins (source `story_base`). A base probe (the Story's
 *     declared evaluator) can only refute a stated value: a disagreeing probe leaves the case to the PLAN pin; a probe
 *     that cannot run accepts the statement (the finding passed the review's evidence check);
 *   - else (no stated base value, a `[precedent-conflict]`, a request value matching neither side) null: the PLAN pin
 *     stays (finding_conflict_pin), and that PLAN trip writes the pin before any scope-plan rerun (handlers/next-driver.ts).
 * Pure: the decision is recomputed from the finding text, the request and the base on every call (no runtime file is
 * read back); the settle step journals it as evidence only. Switch remediation.conflictPin (default on; off = rollback).
 */
import { normalizeProbe } from './probe-text.js';

export const FINDING_CONFLICT_FRAMEWORK_PIN = 'finding_conflict_framework_pin';

export interface StatedBaseCase { expr: string; base: string; head?: string }
export interface FrameworkConflictPin {
  /** `finding`: the open finding's demand wins (the resolved finding's test is wrong for the cases); `resolved`: it loses. */
  side: 'finding' | 'resolved';
  source: 'request' | 'story_base';
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

/**
 * The framework's pin for a finding conflict no checklist row pins, or null when it is not the framework's to decide
 * (see the module comment). `baseProbe(expr)` returns the Story base's printed value, or null when it cannot run.
 */
export function frameworkConflictPin(args: { finding: { id: string; desc?: string }; resolved: { id: string; desc?: string };
  conflict: { kind?: string; resolvedId?: string | null }; requestText: string | null | undefined; baseProbe?: (expr: string) => string | null }): FrameworkConflictPin | null {
  if (args.conflict.kind === 'precedent' || !args.conflict.resolvedId || /\[precedent-conflict\]/i.test(args.finding.desc ?? '')) return null;
  const cases = statedBaseCases(args.finding.desc).filter(row => row.head === undefined || !sameValue(row.head, row.base));
  if (!cases.length) return null;
  const f = short(args.finding.id);
  const g = short(args.resolved.id);
  // 1. The request decides a case it states (precedence: request text first).
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
    return { side, source: 'request', cases: stated.map(({ row, value }) => ({ expr: row.expr, value })),
      reason: `the request states ${list}, which ${side === 'finding' ? `open ${f} demands; resolved ${g}'s covering test states otherwise` : `resolved ${g}'s repair keeps; open ${f} demands otherwise`}` };
  }
  // 2. The Story base: the finding states the base value of each case; a base probe can only refute it.
  for (const row of cases) {
    let probed: string | null = null;
    try { probed = args.baseProbe ? args.baseProbe(row.expr) : null; } catch { probed = null; }
    if (probed !== null && !sameValue(probed, row.base)) return null;
  }
  const list = cases.map(row => `\`${row.expr}\` -> \`${row.base}\``).join(', ');
  return { side: 'finding', source: 'story_base', cases: cases.map(row => ({ expr: row.expr, value: row.base })),
    reason: `the request is silent on ${cases.length > 1 ? 'these cases' : 'this case'} and open ${f} states the Story base behaviour (${list}); resolved ${g}'s covering test pins a value the request does not ask for, so the base behaviour stands` };
}

/** The repair prompt block of a finding whose conflict the framework pinned on its side (the repair keeps the pinned values). */
export function renderFrameworkConflictPin(pin: FrameworkConflictPin, resolvedId: string): string[] {
  return [
    `Framework pin (${FINDING_CONFLICT_FRAMEWORK_PIN}, precedence request text > Story base > reviewer opinion): ${pin.reason}.`,
    ...pin.cases.map(row => `- \`${row.expr}\` must give \`${row.value}\`.`),
    `- Keep these values, and update the rows of resolved ${short(resolvedId)}'s covering test that state otherwise to them (in the same commit as the code): that finding's guard yields to this pin, its other rows still guard it.`,
  ];
}
