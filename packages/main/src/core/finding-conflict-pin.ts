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
 *     "`E` returns `V` on base but `W` on HEAD", "Base: `E` -> `V`"), CONFIRMED by the Story's declared base evaluator:
 *     the probe ran and printed the stated value for every case. Then the finding demands the base behaviour and the
 *     resolved finding's test pins something else, so the finding wins (source `story_base`). The finding's statement
 *     alone is never evidence (security review of this lab: a reviewer-authored claim must not become a framework pin):
 *     no evaluator, a probe that cannot run or throws, or one that disagrees leaves the case to the PLAN pin. Only a
 *     trusted case expression is ever run (probeExprTrust: verbatim in a trusted source, or one plain expression), so a
 *     crafted case cannot print its own claim; the pin carries a positive confirmation record (frameworkPinConfirmed);
 *   - else (no stated base value, a `[precedent-conflict]`, a request value matching neither side) null: the PLAN pin
 *     stays (finding_conflict_pin), and that PLAN trip writes the pin before any scope-plan rerun (handlers/next-driver.ts).
 * Pure: the decision is recomputed from the finding text, the request and the base probe on every call (no runtime file
 * is read back; the caller's probe runs in a fresh private base tree, handlers/finding-conflict-settle.ts); the settle step journals it as evidence only. Switch remediation.conflictPin (default on; off = rollback).
 */
import { normalizeProbe } from './probe-text.js';

export const FINDING_CONFLICT_FRAMEWORK_PIN = 'finding_conflict_framework_pin';

export interface StatedBaseCase { expr: string; base: string; head?: string }
export interface FrameworkConflictPin {
  /** `finding`: the open finding's demand wins (the resolved finding's test is wrong for the cases); `resolved`: it loses. */
  side: 'finding' | 'resolved';
  source: 'request' | 'story_base';
  /**
   * The positive record of what decided it (never finding text): the request lines' values, or, per case, what the Story
   * base evaluator printed for an expression a trusted source names (`source`) or the strict grammar admits (`grammar`).
   * frameworkPinConfirmed re-checks it against `cases` before anything is settled.
   */
  confirmation: { kind: 'request'; cases: Array<{ expr: string; value: string }> }
    | { kind: 'base_probe'; cases: Array<{ expr: string; printed: string; trustedBy: ProbeExprTrust }> };
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

export type ProbeExprTrust = 'source' | 'grammar';

/** Identifiers a probed case may never name (output, control flow, process, module and shell access). */
const PROBE_BANNED = /(?<![\w$])(?:print|println|printf|sprintf|puts|echo|exit|quit|die|panic|abort|process|require|import|eval|exec|system|spawn|popen|subprocess|os|fmt|console|log|open|write|read|sh|bash|globalThis|global|window|Deno|Bun|Function|setTimeout|__\w*)(?![\w$])/i;

/** The expression with string literal contents blanked (they are data, not code); null when a literal is unterminated. */
function blankStrings(expr: string): string | null {
  let out = '';
  let quote: string | null = null;
  for (let index = 0; index < expr.length; index += 1) {
    const char = expr[index]!;
    if (quote) {
      if (char === '\\') { index += 1; continue; }
      if (char === quote) { quote = null; out += char; }
      continue;
    }
    if (char === '"' || char === "'") { quote = char; out += char; continue; }
    out += char;
  }
  return quote ? null : out;
}

const flatText = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Whether a finding-authored case expression may be probed on the Story base (security review of this lab: a crafted
 * expression such as `print("[0]"); x` or `"" && E` would make the evaluator print the finding's own claim):
 *   - `source`: it appears verbatim (whitespace-normalized, one line) in a trusted source: the request, a checklist row,
 *     or the resolved finding's covering test file at its recorded repair commit;
 *   - `grammar`: ONE plain expression: one line, at most 240 characters, string contents treated as data; no `;`, `&`,
 *     `|`, `=`, backtick, braces, top-level comma, or banned identifier (print / exit / process / require / import ...);
 *     balanced brackets; and every call (`name(`) is to a function a trusted source calls the same way. With no trusted
 *     source nothing is callable.
 * Anything else: null (no framework pin; the PLAN pin decides).
 */
export function probeExprTrust(expr: string, trustedTexts: readonly string[]): ProbeExprTrust | null {
  if (!expr || /[\r\n]/.test(expr) || expr.length > 240) return null;
  const flat = flatText(expr);
  if (trustedTexts.some(text => flatText(text).includes(flat))) return 'source';
  const code = blankStrings(expr);
  if (code === null || /[;&|=`{}]|\$\(/.test(code) || PROBE_BANNED.test(code)) return null;
  let depth = 0;
  for (const char of code) {
    if ('([' .includes(char)) depth += 1;
    else if (')]'.includes(char)) { depth -= 1; if (depth < 0) return null; }
    else if (char === ',' && depth === 0) return null;
  }
  if (depth !== 0) return null;
  for (const call of code.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = call[1]!;
    if (!trustedTexts.some(text => new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}\\s*\\(`).test(text))) return null;
  }
  return 'grammar';
}

/** probeExprTrust as a yes / no. */
export const trustedProbeExpr = (expr: string, trustedTexts: readonly string[]): boolean => probeExprTrust(expr, trustedTexts) !== null;

/** Whether a pin carries a positive confirmation of every case it decides (re-checked before anything is settled). */
export function frameworkPinConfirmed(pin: FrameworkConflictPin): boolean {
  if (!pin.cases.length) return false;
  if (pin.source === 'request') return pin.confirmation.kind === 'request'
    && pin.cases.every(row => (pin.confirmation as { cases: Array<{ expr: string; value: string }> }).cases.some(seen => seen.expr === row.expr && sameValue(seen.value, row.value)));
  return pin.confirmation.kind === 'base_probe'
    && pin.cases.every(row => (pin.confirmation as { cases: Array<{ expr: string; printed: string; trustedBy: ProbeExprTrust }> }).cases
      .some(seen => seen.expr === row.expr && (seen.trustedBy === 'source' || seen.trustedBy === 'grammar') && sameValue(seen.printed, row.value)));
}

/**
 * The framework's pin for a finding conflict no checklist row pins, or null when it is not the framework's to decide
 * (see the module comment). `baseProbe(expr)` returns the Story base's printed value, or null when it cannot run.
 */
export function frameworkConflictPin(args: { finding: { id: string; desc?: string }; resolved: { id: string; desc?: string };
  conflict: { kind?: string; resolvedId?: string | null }; requestText: string | null | undefined; baseProbe?: (expr: string) => string | null;
  /** Trusted sources a probed expression must appear in, or whose calls it may use (probeExprTrust). */
  trustedTexts?: readonly string[] }): FrameworkConflictPin | null {
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
    const decided = stated.map(({ row, value }) => ({ expr: row.expr, value }));
    return { side, source: 'request', confirmation: { kind: 'request', cases: decided }, cases: decided,
      reason: `the request states ${list}, which ${side === 'finding' ? `open ${f} demands; resolved ${g}'s covering test states otherwise` : `resolved ${g}'s repair keeps; open ${f} demands otherwise`}` };
  }
  // 2. The Story base: the finding states the base value of each case, and the base evaluator must have run and printed
  // it for every case (fail closed: no probe, an unrunnable or throwing one, or a disagreement leaves it to PLAN).
  // Only an expression a trusted source names, or a plain one (probeExprTrust), is ever run: a finding-authored case could
  // otherwise print its own claim.
  if (!args.baseProbe) return null;
  const probed: Array<{ expr: string; printed: string; trustedBy: ProbeExprTrust }> = [];
  for (const row of cases) {
    const trustedBy = probeExprTrust(row.expr, args.trustedTexts ?? []);
    if (!trustedBy) return null;
    let printed: string | null = null;
    try { printed = args.baseProbe(row.expr); } catch { printed = null; }
    if (printed === null || !sameValue(printed, row.base)) return null;
    probed.push({ expr: row.expr, printed, trustedBy });
  }
  const list = cases.map(row => `\`${row.expr}\` -> \`${row.base}\``).join(', ');
  return { side: 'finding', source: 'story_base', confirmation: { kind: 'base_probe', cases: probed }, cases: cases.map(row => ({ expr: row.expr, value: row.base })),
    reason: `the request is silent on ${cases.length > 1 ? 'these cases' : 'this case'} and open ${f} states the Story base behaviour (${list}); the Story base evaluator prints the same; resolved ${g}'s covering test pins a value the request does not ask for, so the base behaviour stands` };
}

/** The repair prompt block of a finding whose conflict the framework pinned on its side (the repair keeps the pinned values). */
export function renderFrameworkConflictPin(pin: FrameworkConflictPin, resolvedId: string): string[] {
  return [
    `Framework pin (${FINDING_CONFLICT_FRAMEWORK_PIN}, precedence request text > Story base > reviewer opinion): ${pin.reason}.`,
    ...pin.cases.map(row => `- \`${row.expr}\` must give \`${row.value}\`.`),
    `- Keep these values, and update the rows of resolved ${short(resolvedId)}'s covering test that state otherwise to them (in the same commit as the code): that finding's guard yields to this pin, its other rows still guard it.`,
  ];
}
