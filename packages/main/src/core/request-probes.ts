/**
 * Request-anchored probes (old-PoS run 31, bench-staging/oldpos/run31-analysis.md
 * §3.3, recommendations 3 and 4).
 *
 * Run 31's implementer probe matrix cost 56 of 171 implementer turns (about
 * 11-15M tokens: a hand-written probe program, a base worktree, copy, run and
 * cleanup per item) and found no defect. It printed `a[null:4:2] -> [0, 2]`
 * next to the request sentence "A non-numeric `start` ... must keep the
 * existing index-operator error format" and nobody compared the two (F-006):
 * the matrix compared base against change, never against the request, and the
 * pin (owner-authored, wrong) agreed with the code.
 *
 * 1. Anchoring (always, when request.md exists): every executable example of
 *    an intent row (`<input> -> <value>`, also `s='hello'; s[::2]='ABC' ->
 *    'AeBlC'`, `a[::2] over [0,1,2] -> [0, 2]`, several cases per row) is a
 *    probe case. Each case is matched to the request sentences that define its
 *    behaviour by the PLAN coverage matrix (core/plan-coverage-matrix.ts
 *    caseRequirements: the requirement classes the case's own code carries,
 *    e.g. explicit null start; a write that follows read semantics brings the
 *    read sentence). A sentence that gives an operand class (null,
 *    non-numeric, step 0) an error makes the case "request expects an error",
 *    with the backticked error format(s) it quotes.
 *    - Static check (PLAN, DEV prompt): a pin that is a value where the
 *      request expects an error, or an error outside the request's format,
 *      is listed as a pin that contradicts its request sentence (scope-plan
 *      pin audit, implementer prompt).
 *    - Without a probe runner: the implementer prompt carries the anchored
 *      table and the implementer reports one `[probe-row]` line per row
 *      (expected per request vs observed); a `contradiction` row it neither
 *      fixed nor listed under `[intent-conflict]` reopens the item.
 * 2. Framework-run probes (when the project declares `probeRunner` in
 *    proof-or-stop.config.json at the Story base, same shape as `pinOracle`
 *    plus an optional `selfTest`): the framework archives the Story base and
 *    the implementer's HEAD (keyed by the material hash, so metadata commits
 *    reuse it), runs the declared setup once per tree, evaluates every case on
 *    both, and stores the table under `.proof-or-stop/runtime/probe-tables/`.
 *    `checklist_update status=done` runs it (once per flagged set it refuses
 *    done and prints the rows, so the implementer acts in the same session);
 *    `next` re-checks at the final HEAD and reopens the item for a row still
 *    flagged; a row still flagged after a relaunch becomes an owner intent
 *    conflict. REVIEW lanes get the table as evidence. The implementer writes
 *    no probe program.
 *
 * Flags (head observation): `request-error` (the request expects an error,
 * the head returns a value), `request-format` (an error outside the request's
 * quoted format), `pin` (the head differs from the pin). A `pin` flag where
 * the head satisfies the request sentence is a pin to amend
 * (`[intent-conflict]`), not code to fix.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChecklistItem, VerificationIntent } from './types.js';
import { VERIFICATION_LANES } from './verification.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';
import { caseRequirements, requestAnchorContext, type RequestAnchorContext } from './plan-coverage-matrix.js';
import { parseErrorOutsideNewSyntax, pinOracleStoryBase, prepareArchivedTree, validRunnerConfig, type PinOracleConfig } from './pin-oracle.js';
import { currentMaterialHash } from './evidence-freshness.js';
import { parseIntentConflicts } from './request-authority.js';

export const PROBE_ROW_TAG = '[probe-row]';
export const PROBE_REQUEST_MISMATCH = 'probe_request_mismatch';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Cases evaluated per tree per call (cached results do not count). */
const MAX_EVALUATIONS = 600;
/** Rows shown per prompt table. */
const MAX_PROMPT_ROWS = 40;
/** Head trees kept besides the base (older ones are pruned). */
const KEEP_HEAD_TREES = 2;

// ---------------------------------------------------------------------------
// Cases

export interface ProbeExpectation {
  /** value: a group / number / literal word; error: "error starts with 'x'"; either: a quoted string (a value or an error message). */
  kind: 'value' | 'error' | 'either';
  text: string;
}

export interface ProbeCase {
  /** Intent row ref, e.g. CHK-002:edge:3. */
  ref: string;
  /** ref, or ref#n for the n-th case of a multi-case row. */
  key: string;
  itemId: string;
  /** The case as code: its statements and subject, `; `-joined. */
  code: string;
  statements: string[];
  /** The expression whose output is compared (the read, or the receiver of a write). */
  expr: string;
  write: boolean;
  pinned: ProbeExpectation;
  /** The pinned value as written. */
  pinnedText: string;
  /** The row's derivation.requestQuote (owner-cited), if any. */
  quote: string | null;
  /** The case reads a variable no statement binds: not runnable. */
  unbound: boolean;
  /**
   * Code segments of the row before this case the extractor could not place as a
   * statement (old-PoS run 32: `h.a[0:2]=[9,8]` was silently dropped and the
   * row probed as a plain read). Non-empty: the case is unextractable, never
   * run and never flagged; PLAN lists it (unextractableRows).
   */
  dropped: string[];
}

const OPEN = '[{(';
const CLOSE = ']})';

/** Positions of `text` at bracket depth 0 outside quotes (a `'` opens a quote only after a non-word character). */
function topLevelPositions(text: string): boolean[] {
  const top: boolean[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    top.push(depth === 0 && quote === null);
    if (quote) { if (char === quote && text[index - 1] !== '\\') quote = null; continue; }
    if (char === '"' || char === '`' || (char === "'" && !/[\p{L}\p{N}_]/u.test(text[index - 1] ?? ''))) { quote = char; continue; }
    if (OPEN.includes(char)) depth += 1;
    else if (CLOSE.includes(char)) depth = Math.max(0, depth - 1);
  }
  return top;
}

function splitTopLevel(text: string, separator: string): string[] {
  const top = topLevelPositions(text);
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (top[index] && text[index] === separator) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Top-level matches of `pattern` (outside quotes and brackets), in order. */
function topLevelMatches(text: string, pattern: RegExp): Array<{ index: number; length: number }> {
  const top = topLevelPositions(text);
  const global = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, '')}g`);
  return [...text.matchAll(global)].filter(match => top[match.index ?? -1]).map(match => ({ index: match.index!, length: match[0].length }));
}
const findTopLevel = (text: string, pattern: RegExp) => topLevelMatches(text, pattern)[0] ?? null;
const findLastTopLevel = (text: string, pattern: RegExp) => topLevelMatches(text, pattern).at(-1) ?? null;

/** The leading concrete value of `text`: a quoted string, a bracket group, a number or null/true/false. */
function leadingValue(text: string): string | null {
  const trimmed = text.trimStart();
  const first = trimmed[0];
  if (first === undefined) return null;
  if (first === '"' || first === "'" || first === '`') {
    for (let index = 1; index < trimmed.length; index += 1) {
      if (trimmed[index] === first && trimmed[index - 1] !== '\\') return trimmed.slice(0, index + 1);
    }
    return null;
  }
  if (first === '[' || first === '{') {
    const top = topLevelPositions(trimmed);
    for (let index = 1; index < trimmed.length; index += 1) if (top[index] && CLOSE.includes(trimmed[index - 1]!)) return trimmed.slice(0, index);
    return /[\]}]$/.test(trimmed) ? trimmed : null;
  }
  const word = trimmed.match(/^(?:-?\d+(?:\.\d+)?(?![\w.])|(?:null|nil|true|false)\b)/);
  return word ? word[0] : null;
}

/** The trailing code-like token of `text` (no top-level whitespace), extended over a spaced `lhs = rhs`. */
function trailingCode(text: string): string | null {
  const trimmed = text.trimEnd().replace(/[:,]$/, '').trimEnd();
  if (!trimmed) return null;
  if (trimmed.endsWith('`')) {
    const open = trimmed.lastIndexOf('`', trimmed.length - 2);
    return open >= 0 ? trimmed.slice(open + 1, -1).trim() || null : null;
  }
  const top = topLevelPositions(trimmed);
  let start = 0;
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    if (top[index] && /\s/.test(trimmed[index]!)) { start = index + 1; break; }
  }
  const token = trimmed.slice(start);
  if (!token) return null;
  const before = trimmed.slice(0, start).trimEnd();
  // `s[::2] = "x"`: the token is the right-hand side of a spaced assignment.
  if (/(?<![=!<>])=$/.test(before)) {
    const lhs = trailingCode(before.slice(0, -1));
    return lhs ? `${lhs}=${token}` : null;
  }
  if (/^=(?!=)/.test(token)) return null;
  return token;
}

const ARROW = /\s*(?:->|→|=>|==)\s*/;
const OVER = /\s+over\s+/i;

/** The pinned expectation after the arrow, or null when it is prose. */
export function parseExpectation(text: string): ProbeExpectation | null {
  let rest = text.trim();
  const error = rest.match(/^(?:an?\s+)?(?:error|raises?|throws?|fails?(?:\s+with)?)\b[^'"`]*?(['"`])((?:(?!\1).)+)\1/i);
  if (error) return { kind: 'error', text: error[2]!.trim() };
  if (rest.startsWith('`')) {
    const close = rest.indexOf('`', 1);
    if (close > 1) rest = rest.slice(1, close);
  }
  const value = leadingValue(rest);
  if (!value) return null;
  if (/^['"`]/.test(value)) return { kind: 'either', text: value.slice(1, -1) };
  return { kind: 'value', text: value };
}

const ASSIGNMENT = /^([A-Za-z_][\w.]*)\s*=(?!=)\s*(.+)$/s;

/** `x = literal` / `x=literal` as a statement, else null. */
function bindingStatement(text: string): string | null {
  const match = text.trim().match(ASSIGNMENT);
  if (!match) return null;
  const value = leadingValue(match[2]!);
  return value ? `${match[1]}=${value}` : null;
}

/** Code characters: text before a statement with none is a prose label (`then`, `member receiver`). */
const CODE_CHARS = /[=[\](){}]/;
/** Code that may change state (an assignment, a call, a block): dropping it would change what the case reads. */
const EFFECT = /(?<![=!<>])=(?![=>])|[({]/;

/**
 * A `;`-segment without an arrow as a program statement, in order (old-PoS run
 * 32): a literal binding (`x = [1]`, prose before it allowed), else the whole
 * segment when it is one code token (`h.a[0:2]=[9,8]`, `a=f()`,
 * `f(){ ... }`), else an assignment after a prose label. `null` + code: the
 * segment holds state-changing code (an assignment, a call, a block) the
 * extractor cannot place, so the row is unextractable; `null` without: prose
 * or a side-effect-free expression, safe to skip.
 */
function statementOf(segment: string): { statement: string | null; code: boolean } {
  const trimmed = segment.trim();
  if (!trimmed) return { statement: null, code: false };
  const token = trailingCode(trimmed);
  const binding = token ? bindingStatement(token) : null;
  if (binding) return { statement: binding, code: true };
  if (token && token.replace(/\s+/g, '') === trimmed.replace(/\s+/g, '')) return { statement: token === trimmed ? trimmed : token, code: true };
  const before = token ? trimmed.slice(0, trimmed.length - token.length).trim() : trimmed;
  if (token && splitAssignment(token) && !CODE_CHARS.test(before)) return { statement: token, code: true };
  return { statement: null, code: EFFECT.test(trimmed) };
}

/** The top-level assignment `lhs = rhs` of a subject, or null (a read). */
function splitAssignment(subject: string): { lhs: string; rhs: string } | null {
  const found = findTopLevel(subject, /(?<![=!<>])=(?![=>])/);
  if (!found) return null;
  const lhs = subject.slice(0, found.index).trim();
  const rhs = subject.slice(found.index + 1).trim();
  return lhs && rhs ? { lhs, rhs } : null;
}

/** The object a write modifies: the target without its last top-level index group (`h.s[0]` -> `h.s`). */
function writeReceiver(lhs: string): string {
  if (!lhs.endsWith(']')) return lhs;
  let depth = 0;
  for (let index = lhs.length - 1; index >= 0; index -= 1) {
    if (lhs[index] === ']') depth += 1;
    else if (lhs[index] === '[' && --depth === 0) return lhs.slice(0, index).trim() || lhs;
  }
  return lhs;
}

const rootIdentifier = (expr: string): string | null => expr.match(/^([A-Za-z_]\w*)\s*[[.]/)?.[1] ?? null;

/**
 * The probe cases of one intent desc. A row may hold several `;`-separated
 * cases; a leading `<prose> over a=[...]:` or `s='hello';` binds the receiver
 * for each case; `<case> over <literal>` binds the case's root variable.
 */
export function probeCasesOf(ref: string, itemId: string, desc: string, quote: string | null = null): ProbeCase[] {
  let body = desc.trim();
  const prefixStatements: string[] = [];
  const prefixDropped: string[] = [];
  let prefixLiteral: string | null = null;
  const firstArrow = findTopLevel(body, ARROW);
  const colon = findTopLevel(body, /:\s+/);
  if (colon && firstArrow && colon.index < firstArrow.index) {
    const prefix = body.slice(0, colon.index);
    body = body.slice(colon.index + colon.length);
    const over = findLastTopLevel(prefix, OVER);
    if (over) {
      const receiver = prefix.slice(over.index + over.length).trim();
      const binding = bindingStatement(receiver);
      if (binding) prefixStatements.push(binding);
      else prefixLiteral = leadingValue(receiver);
    } else {
      const { statement, code } = statementOf(prefix);
      if (statement) prefixStatements.push(statement);
      else if (code) prefixDropped.push(prefix.trim());
    }
  }
  const cases: ProbeCase[] = [];
  const persistent: string[] = [];
  const dropped: string[] = [...prefixDropped];
  for (const segment of splitTopLevel(body, ';')) {
    const arrow = findTopLevel(segment, ARROW);
    if (!arrow) {
      // Old-PoS run 32: every statement runs, in order; one the extractor cannot
      // place makes the following cases unextractable (never a false flag).
      const { statement, code } = statementOf(segment);
      if (statement) persistent.push(statement);
      else if (code) dropped.push(segment.trim());
      continue;
    }
    const pinned = parseExpectation(segment.slice(arrow.index + arrow.length));
    if (!pinned) continue;
    let before = segment.slice(0, arrow.index);
    const statements = [...prefixStatements, ...persistent];
    let literal = prefixLiteral;
    const over = findLastTopLevel(before, OVER);
    if (over) {
      const receiver = before.slice(over.index + over.length).trim();
      const binding = bindingStatement(receiver);
      if (binding) { statements.push(binding); literal = null; } else literal = leadingValue(receiver) ?? literal;
      before = before.slice(0, over.index);
    }
    const subject = trailingCode(before);
    if (!subject || leadingValue(subject) === subject) continue;
    const assignment = splitAssignment(subject);
    // A bare identifier is a case when the row's own statements assign it
    // (`a=[...]; a[1:4]=[9,8,7]; a -> [...]`); otherwise it is prose.
    const assigns = (name: string) => statements.some(statement => new RegExp(`^${name}\\s*(?:=(?!=)|\\[|\\.)`).test(statement));
    if (!assignment && !/[[(.]/.test(subject) && !(/^[A-Za-z_]\w*$/.test(subject) && assigns(subject))) continue;
    const root = rootIdentifier(assignment?.lhs ?? subject);
    if (literal && root && !statements.some(statement => statement.startsWith(`${root}=`))) statements.push(`${root}=${literal}`);
    const expr = assignment ? writeReceiver(assignment.lhs) : subject;
    const program = assignment ? [...statements, subject] : statements;
    const unbound = Boolean(root && /^[A-Za-z_]\w*\s*[[.]/.test(assignment?.lhs ?? subject) && !statements.some(statement => statement.startsWith(`${root}=`)));
    cases.push({ ref, key: ref, itemId, code: [...program, ...(assignment ? [] : [subject])].join('; '), statements: program, expr, write: Boolean(assignment),
      pinned, pinnedText: pinned.kind === 'value' ? pinned.text : pinned.kind === 'error' ? `error '${pinned.text}'` : `'${pinned.text}'`, quote, unbound, dropped: [...dropped] });
  }
  if (cases.length > 1) cases.forEach((entry, index) => { entry.key = `${ref}#${index + 1}`; });
  return cases;
}

/**
 * The probe cases of an item. A case whose receiver variable no statement of
 * its own row binds (`non-numeric start a[{}::2] -> ...`) borrows the binding
 * the item's other rows use most for that variable (run 31: CHK-002/CHK-003
 * error rows named `a` / `s` and relied on the `over a=[...]` of a sibling row).
 */
export function itemProbeCases(item: Pick<ChecklistItem, 'id' | 'verificationIntent'>): ProbeCase[] {
  const intent: VerificationIntent | undefined = item.verificationIntent;
  if (!intent) return [];
  const out: ProbeCase[] = [];
  for (const lane of VERIFICATION_LANES) {
    for (const [index, row] of (intent[lane] ?? []).entries()) {
      const quote = typeof row.derivation?.requestQuote === 'string' ? row.derivation.requestQuote : null;
      out.push(...probeCasesOf(row.id ?? `${item.id}:${lane}:${index}`, item.id, String(row.desc ?? ''), quote));
    }
  }
  const counts = new Map<string, Map<string, number>>();
  for (const probe of out) {
    for (const statement of probe.statements) {
      const name = statement.match(/^([A-Za-z_]\w*)=/)?.[1];
      if (!name || !leadingValue(statement.slice(name.length + 1))) continue;
      const byValue = counts.get(name) ?? new Map<string, number>();
      byValue.set(statement, (byValue.get(statement) ?? 0) + 1);
      counts.set(name, byValue);
    }
  }
  for (const probe of out) {
    if (!probe.unbound) continue;
    const root = rootIdentifier(probe.write ? probe.statements.at(-1)! : probe.expr);
    const best = root ? [...(counts.get(root) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
    if (!best) continue;
    probe.statements = [best, ...probe.statements];
    probe.code = `${best}; ${probe.code}`;
    probe.unbound = false;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Request anchoring

export interface ProbeAnchor {
  /** Request sentences that define the case (coverage-matched), most specific first. */
  sentences: string[];
  /** A sentence gives the case's operand class an error. */
  expectsError: boolean;
  /** Error-format stems those sentences quote (text before the first `<placeholder>`). */
  stems: string[];
}

const ERROR_WORDS = /\berrors?\b|\braises?\b|\bthrows?\b|\bfails?\b|\breject(?:s|ed)?\b/i;
const ERROR_CLASS = /^(?:null|nonnumeric|zero):/;
const squashSpace = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Backticked literals of a request sentence, and of the more-indented lines under it when it ends with `:`. */
export function sentenceLiterals(requestText: string, sentence: string): string[] {
  const lines = requestText.split('\n');
  const want = squashSpace(sentence.replace(/`/g, ''));
  const at = lines.findIndex(line => squashSpace(line.replace(/`/g, '')).includes(want));
  const block = [sentence];
  if (at >= 0 && /:\s*$/.test(lines[at]!)) {
    const indent = (line: string): number => line.match(/^\s*/)![0].length;
    for (let next = at + 1; next < lines.length && lines[next]!.trim() && indent(lines[next]!) > indent(lines[at]!); next += 1) block.push(lines[next]!);
  }
  return [...block.join('\n').matchAll(/`([^`\n]+)`/g)].map(match => match[1]!.trim()).filter(text => text.length >= 6 && /[\s:]/.test(text));
}

const stemOf = (literal: string): string => literal.split('<')[0]!.trim();

export interface AnchorContext { coverage: RequestAnchorContext; requestText: string; titles: Map<string, string> }

export function probeAnchorContext(items: ReadonlyArray<Pick<ChecklistItem, 'id' | 'status' | 'verificationIntent' | 'title'>>, requestText: string): AnchorContext {
  return { coverage: requestAnchorContext(items, requestText), requestText, titles: new Map(items.map(item => [item.id, item.title ?? ''])) };
}

export function anchorCase(ctx: AnchorContext, probe: ProbeCase): ProbeAnchor {
  const requirements = caseRequirements(ctx.coverage, probe.code, ctx.titles.get(probe.itemId) ?? '');
  const errorRequirements = requirements.filter(entry => entry.classes.some(value => ERROR_CLASS.test(value)) && entry.sentences.some(sentence => ERROR_WORDS.test(sentence)));
  const ordered = [...errorRequirements, ...requirements.filter(entry => !errorRequirements.includes(entry))];
  const sentences = [...new Set(ordered.flatMap(entry => entry.sentences))];
  const errorSentences = [...new Set(errorRequirements.flatMap(entry => entry.sentences.filter(sentence => ERROR_WORDS.test(sentence))))];
  const stems = [...new Set(errorSentences.flatMap(sentence => sentenceLiterals(ctx.requestText, sentence)).map(stemOf).filter(stem => stem.length >= 6))];
  return { sentences, expectsError: errorSentences.length > 0, stems };
}

/** A pin that contradicts its request sentence (static: no run), or null. */
export function pinRequestContradiction(probe: ProbeCase, anchor: ProbeAnchor): string | null {
  if (!anchor.expectsError) return null;
  if (probe.pinned.kind === 'value') return `pins the value ${probe.pinned.text}; the request sentence gives this input an error${anchor.stems.length ? ` (${anchor.stems.map(stem => `\`${stem}\``).join(' or ')} ...)` : ''}`;
  if (anchor.stems.length && !anchor.stems.some(stem => probe.pinned.text.includes(stem))) {
    return `pins ${probe.pinned.kind === 'error' ? 'the error ' : ''}${JSON.stringify(probe.pinned.text)}; the request sentence gives this input an error in the format ${anchor.stems.map(stem => `\`${stem}\``).join(' or ')} ...`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Observation and comparison

export type ProbeObservation = { status: 'value' | 'error' | 'unrunnable'; text: string };

/** Comparison form: trimmed, one pair of surrounding quotes off; in a group, '' quotes as "" and no whitespace. */
export function normalizeProbeValue(value: string): string {
  let text = value.trim();
  if (text.length >= 2 && /^["'`]/.test(text) && text.at(-1) === text[0]) return text.slice(1, -1);
  if (/^[[{(]/.test(text)) {
    text = text.replace(/'((?:[^'\\]|\\.)*)'/g, (_match, inner: string) => `"${inner.replace(/"/g, '\\"')}"`);
    text = text.replace(/\s+/g, '');
  }
  return text;
}

/** The observation satisfies the pin (null: not runnable). */
export function matchesPin(observed: ProbeObservation, pinned: ProbeExpectation): boolean | null {
  if (observed.status === 'unrunnable') return null;
  const valueOk = observed.status === 'value' && normalizeProbeValue(observed.text) === normalizeProbeValue(pinned.kind === 'either' ? `"${pinned.text}"` : pinned.text);
  const errorOk = observed.status === 'error' && squashSpace(observed.text).includes(squashSpace(pinned.text));
  if (pinned.kind === 'value') return valueOk;
  if (pinned.kind === 'error') return errorOk;
  return valueOk || errorOk;
}

export type ProbeFlag = 'request-error' | 'request-format' | 'pin';

export function observationFlags(observed: ProbeObservation | undefined, probe: ProbeCase, anchor: ProbeAnchor): ProbeFlag[] {
  if (!observed || observed.status === 'unrunnable') return [];
  const flags: ProbeFlag[] = [];
  if (anchor.expectsError && observed.status === 'value') flags.push('request-error');
  if (anchor.expectsError && observed.status === 'error' && anchor.stems.length && !anchor.stems.some(stem => observed.text.includes(stem))) flags.push('request-format');
  if (matchesPin(observed, probe.pinned) === false) flags.push('pin');
  return flags;
}

/** The head satisfies the request sentence while differing from the pin: amend the pin, not the code. */
export const requestVouchesFor = (observed: ProbeObservation | undefined, anchor: ProbeAnchor): boolean =>
  Boolean(observed && observed.status === 'error' && anchor.expectsError && (!anchor.stems.length || anchor.stems.some(stem => observed.text.includes(stem))));

// ---------------------------------------------------------------------------
// The framework probe runner

export interface ProbeRunnerConfig extends PinOracleConfig {
  /** The base must evaluate `input` to `output`, else the runner is not used (a wrong declaration never flags rows). */
  selfTest?: { input: string; output: string };
}

export interface ProbeRunnerContext {
  config: ProbeRunnerConfig;
  env: Record<string, string>;
  base: string;
  baseTree: string;
  dir: string;
  gitCwd: string;
  metadataRoot: string;
}

function gitOut(cwd: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }).trim(); } catch { return null; }
}

/** The probeRunner (and validate.env) declared in proof-or-stop.config.json at `base`, or null. */
export function readBaseProbeRunner(gitCwd: string, base: string): { config: ProbeRunnerConfig; env: Record<string, string> } | null {
  const text = gitOut(gitCwd, ['show', `${base}:proof-or-stop.config.json`]);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { probeRunner?: unknown; validate?: { env?: Record<string, string> } };
    const config = validRunnerConfig(parsed.probeRunner) as ProbeRunnerConfig | null;
    return config ? { config, env: { ...(parsed.validate?.env ?? {}), ...(config.env ?? {}) } } : null;
  } catch { return null; }
}

const configKey = (config: ProbeRunnerConfig): string => createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 8);

/** The program text of one case. */
export function probeProgram(config: Pick<ProbeRunnerConfig, 'program'>, statements: readonly string[], expr: string): string {
  return [...statements, (config.program ?? '{input}').split('{input}').join(expr)].join('\n');
}

type Cache = Record<string, ProbeObservation>;

/** Evaluate programs in a prepared tree (cached per tree + program). */
export function evaluateInTree(ctx: Pick<ProbeRunnerContext, 'config' | 'env'>, tree: string, programs: readonly string[]): Map<string, ProbeObservation> {
  const dir = join(tree, '..');
  const cachePath = join(dir, 'results.json');
  let cache: Cache = {};
  try { cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Cache; } catch { cache = {}; }
  const out = new Map<string, ProbeObservation>();
  const programsDir = join(dir, 'programs');
  mkdirSync(programsDir, { recursive: true });
  const skip = ctx.config.skipPattern ? (() => { try { return new RegExp(ctx.config.skipPattern!, 'm'); } catch { return null; } })() : null;
  let evaluated = 0;
  let dirty = false;
  for (const program of new Set(programs)) {
    const key = createHash('sha256').update(program).digest('hex');
    if (cache[key]) { out.set(program, cache[key]!); continue; }
    if (evaluated >= MAX_EVALUATIONS) continue;
    evaluated += 1;
    const file = join(programsDir, `${key.slice(0, 16)}${ctx.config.extension ?? '.txt'}`);
    writeFileSync(file, `${program}\n`);
    const fill = (text: string) => text.split('{file}').join(file).split('{tree}').join(tree);
    const ran = spawnSync(fill(ctx.config.command), (ctx.config.args ?? ['{file}']).map(fill), {
      cwd: tree, env: { ...process.env, ...ctx.env }, encoding: 'utf8', timeout: ctx.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
    const text = `${(ran.stdout ?? '').trim()}${ran.status !== 0 && ran.stderr?.trim() ? `\n${ran.stderr.trim()}` : ''}`.trim().slice(0, 600);
    let result: ProbeObservation;
    if (ran.error) result = { status: 'unrunnable', text: `runner: ${ran.error.message}`.slice(0, 200) };
    else if (skip && skip.test(text)) result = { status: 'unrunnable', text };
    else result = { status: ran.status === 0 ? 'value' : 'error', text };
    // A timeout may be load, not the input: never cache it.
    if (!ran.error) { cache[key] = result; dirty = true; }
    out.set(program, result);
  }
  if (dirty) {
    try { writeFileSync(cachePath, `${JSON.stringify(cache)}\n`); } catch { /* the cache is an optimisation */ }
  }
  return out;
}

/** The Story's prepared probe runner (base tree built, self-test passed), or null. */
export function storyProbeRunner(store: { readStory(storyId: string): unknown }, root: string, storyId: string, gitCwd: string): ProbeRunnerContext | null {
  try {
    // Cheap pre-gate without git (the declaration that counts is the base commit's).
    if (!existsSync(join(gitCwd, 'proof-or-stop.config.json')) || !readFileSync(join(gitCwd, 'proof-or-stop.config.json'), 'utf8').includes('"probeRunner"')) return null;
    const story = store.readStory(storyId) as { integrationTarget?: { parentCommitAtCreation?: string } };
    const base = pinOracleStoryBase(gitCwd, story.integrationTarget?.parentCommitAtCreation);
    if (!base) return null;
    const declared = readBaseProbeRunner(gitCwd, base);
    if (!declared) return null;
    const dir = join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'probe-runner');
    const baseTree = prepareArchivedTree(join(dir, `base-${base.slice(0, 12)}-${configKey(declared.config)}`), gitCwd, base, declared.config.setup, declared.config.timeoutMs, declared.env);
    if (!baseTree) return null;
    const ctx: ProbeRunnerContext = { config: declared.config, env: declared.env, base, baseTree, dir, gitCwd, metadataRoot: root };
    const selfTest = declared.config.selfTest;
    if (selfTest && typeof selfTest.input === 'string' && typeof selfTest.output === 'string') {
      const program = probeProgram(declared.config, [], selfTest.input);
      const result = evaluateInTree(ctx, baseTree, [program]).get(program);
      if (!result || result.status !== 'value' || normalizeProbeValue(result.text) !== normalizeProbeValue(selfTest.output)) return null;
    }
    return ctx;
  } catch {
    return null;
  }
}

/** The head tree (keyed by the material hash of HEAD: metadata commits reuse it), or null. */
export function prepareHeadTree(ctx: ProbeRunnerContext): { tree: string; head: string; material: string } | null {
  const head = gitOut(ctx.gitCwd, ['rev-parse', 'HEAD']);
  if (!head) return null;
  const material = currentMaterialHash(ctx.gitCwd, 'HEAD', ctx.metadataRoot) ?? head;
  const name = `head-${material.slice(0, 16)}-${configKey(ctx.config)}`;
  const tree = prepareArchivedTree(join(ctx.dir, name), ctx.gitCwd, head, ctx.config.setup, ctx.config.timeoutMs, ctx.env);
  if (!tree) return null;
  try {
    // Keep the newest head trees only (each holds a build).
    const heads = readdirSync(ctx.dir).filter(entry => entry.startsWith('head-') && entry !== name)
      .map(entry => ({ entry, at: statSync(join(ctx.dir, entry)).mtimeMs })).sort((a, b) => b.at - a.at);
    for (const old of heads.slice(KEEP_HEAD_TREES - 1)) rmSync(join(ctx.dir, old.entry), { recursive: true, force: true });
  } catch { /* pruning is an optimisation */ }
  return { tree, head, material };
}

// ---------------------------------------------------------------------------
// Tables

export interface ProbeTableRow {
  key: string;
  ref: string;
  code: string;
  expr: string;
  pinned: string;
  base?: ProbeObservation;
  head?: ProbeObservation;
  /** The defining request sentence (first), clipped. */
  sentence: string | null;
  expectsError: boolean;
  stems: string[];
  flags: ProbeFlag[];
  /** The head satisfies the request sentence; the pin differs (amend the pin). */
  requestVouches: boolean;
  /** Static pin vs request contradiction. */
  pinContradiction: string | null;
  /**
   * The base cannot parse the row OUTSIDE the declared new-syntax region
   * (project `parseErrorPattern` + `newSyntaxPattern`): an authoring error the
   * PLAN step names, never a code flag (old-PoS run 32 `f(){...}`).
   */
  syntaxError?: string | null;
}

export interface ProbeTable {
  storyId: string;
  itemId: string;
  base: string;
  head: string;
  material: string;
  computedAt: string;
  ms: number;
  /** Digest of the item's runnable cases and their anchors: an amended row recomputes the table (old-PoS run 32). */
  rowsDigest?: string;
  rows: ProbeTableRow[];
}

export interface ProbeItemState {
  table: ProbeTable | null;
  /** Flagged-set keys a done call already refused once. */
  refusedKeys: string[];
  flaggedKey: string | null;
  flaggedSince: string | null;
  /** The item's verificationIntent digest when the flag was raised: an amendment since makes the flag new (never escalated). */
  flaggedIntentHash?: string | null;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function probeStatePath(root: string, storyId: string, itemId: string): string {
  return join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'probe-tables', storyId, `${itemId}.json`);
}

export function readProbeState(root: string, storyId: string, itemId: string): ProbeItemState {
  try {
    const parsed = JSON.parse(readFileSync(probeStatePath(root, storyId, itemId), 'utf8')) as Partial<ProbeItemState>;
    return { table: parsed.table ?? null, refusedKeys: Array.isArray(parsed.refusedKeys) ? parsed.refusedKeys : [], flaggedKey: parsed.flaggedKey ?? null, flaggedSince: parsed.flaggedSince ?? null,
      flaggedIntentHash: parsed.flaggedIntentHash ?? null };
  } catch {
    return { table: null, refusedKeys: [], flaggedKey: null, flaggedSince: null, flaggedIntentHash: null };
  }
}

export function writeProbeState(root: string, storyId: string, itemId: string, state: ProbeItemState): void {
  const path = probeStatePath(root, storyId, itemId);
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 1)}\n`);
  } catch { /* the state is runtime evidence; next recomputes it */ }
}

type ProbeItem = Pick<ChecklistItem, 'id' | 'status' | 'verificationIntent' | 'title'>;

/** A case the runner executes: every statement extracted, every variable bound. */
const runnable = (probe: ProbeCase): boolean => !probe.unbound && probe.dropped.length === 0;

/** Digest of runnable cases + anchors (the table's staleness key besides material and base). */
export function rowsDigestOf(rows: ReadonlyArray<{ probe: ProbeCase; anchor: ProbeAnchor }>): string {
  return createHash('sha256').update(JSON.stringify(rows.map(({ probe, anchor }) =>
    [probe.key, probe.statements, probe.expr, probe.pinnedText, anchor.expectsError, anchor.stems, anchor.sentences[0] ?? null]))).digest('hex').slice(0, 16);
}

/** Digest of an item's verificationIntent (old-PoS run 32: an amendment after a flag is not a relaunch that ignored it). */
export const intentHashOf = (item: Pick<ChecklistItem, 'verificationIntent'>): string =>
  createHash('sha256').update(JSON.stringify(item.verificationIntent ?? null)).digest('hex').slice(0, 16);

/** Drop an item's table and flagged set (its rows no longer yield a runnable case). */
function clearProbeTable(root: string, storyId: string, itemId: string): void {
  const state = readProbeState(root, storyId, itemId);
  if (state.table || state.flaggedKey || state.flaggedSince) writeProbeState(root, storyId, itemId, { ...state, table: null, flaggedKey: null, flaggedSince: null, flaggedIntentHash: null });
}

/** Static rows (no run) of the given items: cases with their anchors. */
export function anchoredCases(items: readonly ProbeItem[], requestText: string | null, itemIds?: ReadonlySet<string>): Array<{ probe: ProbeCase; anchor: ProbeAnchor }> {
  const live = items.filter(item => item.status !== 'withdrawn');
  const ctx = requestText ? probeAnchorContext(live, requestText) : null;
  const empty: ProbeAnchor = { sentences: [], expectsError: false, stems: [] };
  return live.filter(item => !itemIds || itemIds.has(item.id)).flatMap(item => itemProbeCases(item))
    .map(probe => ({ probe, anchor: ctx ? anchorCase(ctx, probe) : empty }));
}

/**
 * Run the probe cases of `items` on the base and on HEAD and store one table
 * per item (state kept). Items without a runnable case get no table.
 */
export function computeProbeTables(runner: ProbeRunnerContext, root: string, storyId: string, items: readonly ProbeItem[], allItems: readonly ProbeItem[], requestText: string | null): ProbeTable[] {
  const started = Date.now();
  const wanted = new Set(items.map(item => item.id));
  const cases = anchoredCases(allItems, requestText, wanted).filter(row => runnable(row.probe));
  // Old-PoS run 32 (3b): rows amended to zero runnable cases must not leave the
  // previous table (and its flags) in place.
  for (const itemId of wanted) if (!cases.some(row => row.probe.itemId === itemId)) clearProbeTable(root, storyId, itemId);
  if (!cases.length) return [];
  const head = prepareHeadTree(runner);
  if (!head) return [];
  const programOf = (probe: ProbeCase) => probeProgram(runner.config, probe.statements, probe.expr);
  const programs = cases.map(row => programOf(row.probe));
  const baseResults = evaluateInTree(runner, runner.baseTree, programs);
  const headResults = evaluateInTree(runner, head.tree, programs);
  const ms = Date.now() - started;
  const tables: ProbeTable[] = [];
  for (const itemId of wanted) {
    const mine = cases.filter(row => row.probe.itemId === itemId);
    if (!mine.length) continue;
    const rows = mine.map(({ probe, anchor }): ProbeTableRow => {
      const base = baseResults.get(programOf(probe));
      const observed = headResults.get(programOf(probe));
      const syntaxError = base?.status === 'error' ? parseErrorOutsideNewSyntax(runner.config, programOf(probe), base.text) : null;
      return { key: probe.key, ref: probe.ref, code: probe.code, expr: probe.expr, pinned: probe.pinnedText,
        ...(base ? { base } : {}), ...(observed ? { head: observed } : {}),
        sentence: anchor.sentences[0] ? clip(anchor.sentences[0], 240) : (probe.quote ? clip(probe.quote, 240) : null),
        expectsError: anchor.expectsError, stems: anchor.stems, flags: syntaxError ? [] : observationFlags(observed, probe, anchor),
        requestVouches: requestVouchesFor(observed, anchor), pinContradiction: pinRequestContradiction(probe, anchor), syntaxError };
    });
    const table: ProbeTable = { storyId, itemId, base: runner.base, head: head.head, material: head.material, computedAt: new Date().toISOString(), ms, rowsDigest: rowsDigestOf(mine), rows };
    writeProbeState(root, storyId, itemId, { ...readProbeState(root, storyId, itemId), table });
    tables.push(table);
  }
  return tables;
}

/** A row the base cannot parse outside the declared new-syntax region (an owner authoring error). */
export interface ProbeSyntaxError { ref: string; key: string; itemId: string; code: string; error: string }

/**
 * PLAN (old-PoS run 32 3c): every runnable case of `items`, run on the Story
 * base, whose base parse error lies outside the new-syntax region the project
 * declares (`parseErrorPattern` + `newSyntaxPattern`). A parse error inside the
 * region is the expected "base lacks the new syntax"; one outside it is a row
 * no implementation can ever satisfy (e.g. `f(){...}` for `f name(){...}`).
 * Empty without the declaration.
 */
export function probeSyntaxErrors(runner: ProbeRunnerContext, items: readonly ProbeItem[]): ProbeSyntaxError[] {
  if (!runner.config.parseErrorPattern || !runner.config.newSyntaxPattern) return [];
  const cases = anchoredCases(items, null).map(row => row.probe).filter(runnable);
  if (!cases.length) return [];
  const programOf = (probe: ProbeCase) => probeProgram(runner.config, probe.statements, probe.expr);
  const results = evaluateInTree(runner, runner.baseTree, cases.map(programOf));
  return cases.flatMap(probe => {
    const observed = results.get(programOf(probe));
    const error = observed?.status === 'error' ? parseErrorOutsideNewSyntax(runner.config, programOf(probe), observed.text) : null;
    return error ? [{ ref: probe.ref, key: probe.key, itemId: probe.itemId, code: probe.code, error }] : [];
  });
}

/** An example row (`... -> value`) no probe runs, with why. */
export interface UnextractableRow { ref: string; itemId: string; reason: string }

/**
 * PLAN (old-PoS run 32): example rows the framework probe will never run, so
 * the owner sees them before DEV instead of trusting a silent pass: a
 * state-changing statement the extractor cannot place, a variable no statement
 * binds, or a code-like input whose expected value is not recognised (an
 * unquoted error text, a value that is prose).
 */
export function unextractableRows(items: readonly ProbeItem[]): UnextractableRow[] {
  const out: UnextractableRow[] = [];
  for (const item of items.filter(entry => entry.status !== 'withdrawn')) {
    const cases = itemProbeCases(item);
    for (const lane of VERIFICATION_LANES) {
      for (const [index, entry] of (item.verificationIntent?.[lane] ?? []).entries()) {
        const ref = entry.id ?? `${item.id}:${lane}:${index}`;
        const desc = String(entry.desc ?? '');
        const arrow = findTopLevel(desc, ARROW);
        if (!arrow) continue;
        const mine = cases.filter(probe => probe.ref === ref);
        const dropped = [...new Set(mine.flatMap(probe => probe.dropped))];
        if (dropped.length) { out.push({ ref, itemId: item.id, reason: `statement ${dropped.map(text => `\`${clip(text, 60)}\``).join(', ')} not extracted` }); continue; }
        const unbound = mine.filter(probe => probe.unbound);
        if (unbound.length) { out.push({ ref, itemId: item.id, reason: `reads ${unbound.map(probe => `\`${clip(probe.expr, 40)}\``).join(', ')}, which no statement of the row binds` }); continue; }
        if (mine.length) continue;
        const left = trailingCode(desc.slice(0, arrow.index));
        const right = desc.slice(arrow.index + arrow.length).trim();
        if (!left || !/[[(.=]/.test(left) || /^(?:-{3}\s*)?(?:PASS|ok)\b/.test(right)) continue;
        out.push({ ref, itemId: item.id, reason: parseExpectation(right)
          ? `the input \`${clip(left, 60)}\` is not a probe case (a bare variable no statement of the row assigns, or a literal)`
          : `the expected value \`${clip(right, 60)}\` is not recognised (quote an error text: error 'text', or write a literal value)` });
      }
    }
  }
  return out;
}

/** One line for PLAN output: the rows no probe runs (empty when all run). */
export function describeUnextractableRows(rows: readonly UnextractableRow[], max = 12): string {
  if (!rows.length) return '';
  return `Rows the framework probe will not run (${rows.length}): ${rows.slice(0, max).map(row => `${row.ref} (${row.reason})`).join('; ')}${rows.length > max ? `; +${rows.length - max} more` : ''}.`;
}

export const flaggedRows = (table: ProbeTable | null): ProbeTableRow[] => (table?.rows ?? []).filter(row => row.flags.length > 0);
export const flaggedKeyOf = (rows: readonly ProbeTableRow[]): string => rows.map(row => `${row.key}:${row.flags.join('+')}`).sort().join(',');

const showObservation = (observed: ProbeObservation | undefined): string => {
  if (!observed) return '(not run)';
  const first = observed.text.split('\n')[0] ?? '';
  return observed.status === 'value' ? clip(first, 120) : observed.status === 'error' ? `error ${clip(first.replace(/^&\{/, ''), 120)}` : `not runnable (${clip(first, 80)})`;
};

const FLAG_TEXT: Record<ProbeFlag, string> = {
  'request-error': 'the request sentence gives this input an error; HEAD returns a value',
  'request-format': 'HEAD errors outside the request\'s error format',
  pin: 'HEAD differs from the pin',
};

export function describeProbeRow(row: ProbeTableRow): string {
  const why = row.flags.map(flag => FLAG_TEXT[flag]).join('; ');
  const amend = row.flags.includes('pin') && row.requestVouches ? ' (HEAD follows the request: the pin is wrong, list it under [intent-conflict])' : '';
  return `${row.key}: ${clip(row.code, 140)} | pin ${clip(row.pinned, 80)} | base ${showObservation(row.base)} | HEAD ${showObservation(row.head)}`
    + `${row.sentence ? ` | request: "${clip(row.sentence, 160)}"${row.expectsError ? ` (expects an error${row.stems.length ? ` ${row.stems.map(stem => `\`${stem}\``).join(' or ')}...` : ''})` : ''}` : ''}`
    + `${why ? ` | FLAG: ${why}${amend}` : ''}`;
}

/** Rows a done call refuses on: flagged, except a pin the request vouches against (the pin is amended, not the code). */
export const refusingRows = (rows: readonly ProbeTableRow[]): ProbeTableRow[] =>
  rows.filter(row => row.flags.some(flag => flag !== 'pin') || (row.flags.includes('pin') && !row.requestVouches));

/**
 * checklist_update status=done (DEV, probe runner declared): run the item's
 * cases, store the table, and refuse once per flagged set. Returns the
 * refusal (throw it) or a note to append to the done output.
 */
export function probeDoneCheck(runner: ProbeRunnerContext, root: string, storyId: string, item: ProbeItem, allItems: readonly ProbeItem[], requestText: string | null): { refusal: string | null; note: string | null } {
  const table = computeProbeTables(runner, root, storyId, [item], allItems, requestText)[0] ?? null;
  const flagged = flaggedRows(table);
  if (!table || !flagged.length) return { refusal: null, note: table ? `\nFramework probes: ${table.rows.length} rows run on the Story base and HEAD ${table.head.slice(0, 12)}, none flagged (${table.ms} ms).` : null };
  const state = readProbeState(root, storyId, item.id);
  const key = flaggedKeyOf(flagged);
  const path = probeStatePath(root, storyId, item.id);
  const listed = flagged.slice(0, 20).map(row => `- ${describeProbeRow(row)}`).join('\n');
  const intentHash = intentHashOf(item);
  const flaggedSince = state.flaggedKey === key && state.flaggedSince && (state.flaggedIntentHash ?? intentHash) === intentHash ? state.flaggedSince : new Date().toISOString();
  if (refusingRows(flagged).length && !state.refusedKeys.includes(key)) {
    writeProbeState(root, storyId, item.id, { ...state, table, refusedKeys: [...state.refusedKeys, key], flaggedKey: key, flaggedSince, flaggedIntentHash: intentHash });
    return { refusal: `checklist_update REFUSED, done was not recorded: the framework probe run (project probeRunner, Story base ${runner.base.slice(0, 12)} vs HEAD ${table.head.slice(0, 12)}) flagged ${flagged.length} of ${table.rows.length} rows of ${item.id} [${PROBE_REQUEST_MISMATCH}]\n${listed}${flagged.length > 20 ? `\n- +${flagged.length - 20} more (${path})` : ''}\n`
      + 'For each row: the request sentence outranks the pin. If HEAD contradicts the request, fix the code, commit and call done again (the rows are re-run). If HEAD follows the request and the pin does not, keep the code and list the row in your final [intent-conflict] section. If you judge a request flag wrong, add `[probe-row] <row> | ok: <why the request allows HEAD\'s output>` to your final result. '
      + `This refusal is shown once per set of flagged rows; full table: ${path}`, note: null };
  }
  writeProbeState(root, storyId, item.id, { ...state, table, flaggedKey: key, flaggedSince, flaggedIntentHash: intentHash });
  return { refusal: null, note: `\nFramework probes: ${flagged.length} of ${table.rows.length} rows still flagged at HEAD ${table.head.slice(0, 12)} [${PROBE_REQUEST_MISMATCH}]:\n${listed}\nEach must be in your final [intent-conflict] section (wrong pin) or a \`[probe-row] <row> | ok: <why>\` line; next reopens ${item.id} otherwise.` };
}

// ---------------------------------------------------------------------------
// Implementer reports ([probe-row]) and next decisions

export interface ProbeRowReport { row: string; verdict: 'ok' | 'contradiction' | 'other'; text: string }

/** `[probe-row] <row> | ... | ok|contradiction[: why]` lines of a final result (the last field decides). */
export function parseProbeRows(text: string | null | undefined): ProbeRowReport[] {
  const out: ProbeRowReport[] = [];
  for (const line of (text ?? '').split(/\r?\n/)) {
    const at = line.indexOf(PROBE_ROW_TAG);
    if (at < 0) continue;
    const fields = line.slice(at + PROBE_ROW_TAG.length).trim().split(/\s+\|\s+/);
    const row = fields[0]!.trim().replace(/[`:]+$/g, '');
    if (!/^CHK-\d+/.test(row)) continue;
    const last = (fields.at(-1) ?? '').trim();
    const verdict = fields.length < 2 ? 'other' : /^(?:contradiction|contradicts|mismatch)\b/i.test(last) ? 'contradiction' : /^(?:ok|fixed)\b/i.test(last) ? 'ok' : 'other';
    out.push({ row, verdict, text: line.trim().slice(0, 400) });
  }
  return out;
}

/** `name` (a row key or intent ref) names the row. */
const namesRow = (name: string, row: { key: string; ref: string }): boolean => name === row.key || name === row.ref || row.key.startsWith(`${name}#`);

export interface ImplementerRunReport { runId: string; createdAt: string; text: string | null }

export interface ProbeFlagDecision {
  itemId: string;
  action: 'reopen' | 'escalate';
  mode: 'runner' | 'report';
  /** Human lines, one per flagged row. */
  rows: string[];
  /** Intent refs of the rows (for the synthesized intent conflict). */
  refs: string[];
  /** The latest implementer run of the item. */
  runId: string | null;
  /** First flagged row's request sentence / pin / HEAD output (escalation text). */
  sentence: string | null;
  pinned: string | null;
  observed: string | null;
}

/** A row a run's final result already disposed of: an [intent-conflict] naming it, or `[probe-row] ... ok` for request-only flags. */
function disposed(row: { key: string; ref: string; flags: ProbeFlag[] }, report: string | null): boolean {
  if (parseIntentConflicts(report).conflicts.some(conflict => namesRow(conflict.intentRef.trim(), row))) return true;
  return !row.flags.includes('pin') && parseProbeRows(report).some(entry => entry.verdict === 'ok' && namesRow(entry.row, row));
}

const latestRun = (runs: readonly ImplementerRunReport[]): ImplementerRunReport | null => [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? null;

/**
 * Runner mode: the item's table at the current HEAD (recomputed when HEAD's
 * material changed), its flagged rows the latest run did not dispose of, and
 * whether the latest run was dispatched after the rows were flagged (the
 * relaunch saw them: escalate to the owner) or not (reopen the item).
 */
export function runnerProbeDecision(runner: ProbeRunnerContext, root: string, storyId: string, item: ProbeItem, allItems: readonly ProbeItem[], requestText: string | null,
  runs: readonly ImplementerRunReport[]): ProbeFlagDecision | null {
  const material = currentMaterialHash(runner.gitCwd, 'HEAD', runner.metadataRoot);
  // Old-PoS run 32 (3b): the table is keyed on HEAD material + base + the rows'
  // digest; amended rows recompute it (zero runnable cases clear it).
  const current = anchoredCases(allItems, requestText, new Set([item.id])).filter(row => runnable(row.probe));
  if (!current.length) { clearProbeTable(root, storyId, item.id); return null; }
  let state = readProbeState(root, storyId, item.id);
  if (!state.table || !material || state.table.material !== material || state.table.base !== runner.base || state.table.rowsDigest !== rowsDigestOf(current)) {
    if (!computeProbeTables(runner, root, storyId, [item], allItems, requestText).length) return null;
    state = readProbeState(root, storyId, item.id);
  }
  const latest = latestRun(runs);
  const open = flaggedRows(state.table).filter(row => !disposed(row, latest?.text ?? null));
  if (!open.length) return null;
  const key = flaggedKeyOf(open);
  // A flag raised before the item's intent was amended is a new flag: the
  // relaunch has not seen the amended rows, so it is reopened, never escalated.
  const intentHash = intentHashOf(item);
  const sameFlag = state.flaggedKey === key && Boolean(state.flaggedSince) && (state.flaggedIntentHash ?? intentHash) === intentHash;
  const flaggedSince = sameFlag ? state.flaggedSince! : new Date().toISOString();
  if (!sameFlag || state.flaggedIntentHash !== intentHash) writeProbeState(root, storyId, item.id, { ...state, flaggedKey: key, flaggedSince, flaggedIntentHash: intentHash });
  const first = open[0]!;
  return { itemId: item.id, action: latest && latest.createdAt > flaggedSince ? 'escalate' : 'reopen', mode: 'runner', rows: open.map(describeProbeRow),
    refs: [...new Set(open.map(row => row.ref))], runId: latest?.runId ?? null, sentence: first.sentence, pinned: first.pinned, observed: showObservation(first.head) };
}

/**
 * Report mode (no runner): the latest run of a done item reported
 * `contradiction` rows it did not list under [intent-conflict] (reopen; an
 * earlier run of the item reporting the same rows means the relaunch made no
 * progress: escalate), or its prompt carried request-anchored rows and the
 * item's only run reported no `[probe-row]` line (reopen once).
 */
export function reportProbeDecision(itemId: string, anchoredKeys: readonly string[], runs: readonly ImplementerRunReport[]): ProbeFlagDecision | null {
  if (!runs.length) return null;
  const sorted = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latest = sorted.at(-1)!;
  const rowsOf = (run: ImplementerRunReport) => {
    const conflicts = parseIntentConflicts(run.text).conflicts.map(conflict => conflict.intentRef.trim());
    return parseProbeRows(run.text).filter(entry => entry.verdict === 'contradiction'
      && !conflicts.some(name => namesRow(name, { key: entry.row, ref: entry.row.split('#')[0]! })));
  };
  const open = rowsOf(latest);
  const common = { itemId, mode: 'report' as const, runId: latest.runId, sentence: null, pinned: null, observed: null };
  if (open.length) {
    const key = open.map(entry => entry.row).sort().join(',');
    const repeated = sorted.slice(0, -1).some(run => rowsOf(run).map(entry => entry.row).sort().join(',') === key);
    return { ...common, action: repeated ? 'escalate' : 'reopen', rows: open.map(entry => entry.text), refs: [...new Set(open.map(entry => entry.row.split('#')[0]!))] };
  }
  if (anchoredKeys.length && sorted.length === 1 && !parseProbeRows(latest.text).length) {
    return { ...common, action: 'reopen', rows: [`no ${PROBE_ROW_TAG} line for the request-anchored rows ${anchoredKeys.slice(0, 8).join(', ')}${anchoredKeys.length > 8 ? ` +${anchoredKeys.length - 8}` : ''}`], refs: [] };
  }
  return null;
}

/** The request-anchored row keys of an item (report mode: the rows its implementer must report). */
export function requestAnchoredKeys(items: readonly ProbeItem[], requestText: string | null, itemId: string): string[] {
  if (!requestText) return [];
  return anchoredCases(items, requestText, new Set([itemId])).filter(requestDefined).map(row => row.probe.key);
}

// ---------------------------------------------------------------------------
// Prompt texts

/** Request-defined rows: a coverage-matched sentence defines the case (not only an owner-cited quote). */
const requestDefined = (row: { anchor: ProbeAnchor }): boolean => row.anchor.sentences.length > 0;

function anchoredLines(rows: ReadonlyArray<{ probe: ProbeCase; anchor: ProbeAnchor }>, contradictionLabel: string): string[] {
  const index = new Map<string, number>();
  for (const row of rows.slice(0, MAX_PROMPT_ROWS)) { const sentence = row.anchor.sentences[0]; if (sentence && !index.has(sentence)) index.set(sentence, index.size + 1); }
  const lines = [...index].map(([sentence, n]) => `  S${n}: "${clip(sentence, 260)}"`);
  for (const { probe, anchor } of rows.slice(0, MAX_PROMPT_ROWS)) {
    const sentence = anchor.sentences[0];
    const contradiction = pinRequestContradiction(probe, anchor);
    lines.push(`  ${probe.key}: ${clip(probe.code, 120)} -> ${clip(probe.pinnedText, 80)} | ${sentence ? `S${index.get(sentence)}` : 'no request sentence'}${anchor.expectsError ? ` (request expects an error${anchor.stems.length ? ` ${anchor.stems.map(stem => `\`${stem}\``).join(' or ')}...` : ''})` : ''}${contradiction ? ` | ${contradictionLabel}: ${contradiction}` : ''}`);
  }
  if (rows.length > MAX_PROMPT_ROWS) lines.push(`  +${rows.length - MAX_PROMPT_ROWS} more rows (same rule)`);
  return lines;
}

/**
 * Implementer prompt, no probe runner: the request-anchored rows of the item
 * and the per-row report contract. Empty when no row is request-defined.
 */
export function renderAnchoredProbeTable(items: readonly ProbeItem[], requestText: string | null, itemId: string): string[] {
  if (!requestText) return [];
  const rows = anchoredCases(items, requestText, new Set([itemId])).filter(requestDefined);
  if (!rows.length) return [];
  return [
    'Request-anchored probe rows (each row: input -> pinned | the request sentence that defines it). Probe each on your change and compare HEAD\'s output with the REQUEST SENTENCE, not only with the pin or the base:',
    ...anchoredLines(rows, 'PIN CONTRADICTS REQUEST'),
    `- Report one line per row in your final result: \`${PROBE_ROW_TAG} <row> | request: <expected per the sentence> | observed: <HEAD output> | ok|contradiction\`. A row whose observed output contradicts its sentence must be fixed (then report it ok) or listed under [intent-conflict] (the pin is wrong); an unresolved contradiction reopens the item before REVIEW.`,
  ];
}

/** Implementer prompt with a probe runner: the compact contract (no probe programs) and the item's pins that contradict the request. */
export function renderFrameworkProbeContract(items: readonly ProbeItem[], requestText: string | null, itemId: string, runner: Pick<ProbeRunnerContext, 'base'>): string[] {
  const rows = anchoredCases(items, requestText, new Set([itemId]));
  const contradicting = requestText ? rows.filter(row => pinRequestContradiction(row.probe, row.anchor)) : [];
  return [
    `Framework probes (project probeRunner, Story base ${runner.base.slice(0, 12)}): checklist_update status=done first runs this item's ${rows.length} example rows on the Story base and on your HEAD and compares each with its pin and with the request sentence that defines it. Write no probe program and no base worktree. Done is refused once per set of flagged rows, with the rows: fix each, or list a wrong pin under [intent-conflict], or add \`${PROBE_ROW_TAG} <row> | ok: <why>\` for a request flag you judge wrong.`,
    '- Behaviour no example pins is still yours to test: omitted vs explicit null per operand, an explicit value equal to the default, a target aliased by the value, assignment receivers that are not a bare identifier (member/property `h.s[i]`, index-of-index `a[0][i]`, call result `f()[i]`), and each write form (two-part and three-part) with explicit null start/end.',
    ...(contradicting.length ? ['- Pins that contradict their request sentence (the request outranks the pin: implement the request, list each under [intent-conflict]):', ...anchoredLines(contradicting, 'CONTRADICTS')] : []),
  ];
}

/** Relaunch lines for an item reopened by flagged probe rows (runner mode). */
export function renderProbeFlagRelaunch(root: string, storyId: string, itemId: string): string[] {
  const state = readProbeState(root, storyId, itemId);
  const flagged = flaggedRows(state.table);
  if (!flagged.length) return [];
  return [`- The framework probe run flagged rows of this item at HEAD ${state.table!.head.slice(0, 12)} (fix each, or list a wrong pin under [intent-conflict], or \`${PROBE_ROW_TAG} <row> | ok: <why>\` for a request flag):`,
    ...flagged.slice(0, 20).map(row => `  ${describeProbeRow(row)}`)];
}

/** Scope-plan pin audit: rows whose result a request sentence defines, paired with it; static contradictions marked. */
export function renderRequestAnchoredPinAudit(items: readonly ProbeItem[], requestText: string): string[] {
  const rows = anchoredCases(items, requestText).filter(row => row.anchor.expectsError);
  if (!rows.length) return [];
  const contradicting = rows.filter(row => pinRequestContradiction(row.probe, row.anchor)).length;
  return [
    `Request-anchored pins (a request sentence defines each row's result: compare the pin with the SENTENCE; a pin that contradicts it is a \`pin-audit <ref>\` gap${contradicting ? `; the framework marked ${contradicting}` : ''}):`,
    ...anchoredLines(rows, 'PIN CONTRADICTS REQUEST'),
  ];
}

/** REVIEW lane evidence: the latest framework probe tables (flagged rows), or nothing. */
export function renderProbeEvidence(root: string, storyId: string, itemIds: readonly string[]): string[] {
  const tables = itemIds.map(itemId => readProbeState(root, storyId, itemId).table).filter((table): table is ProbeTable => Boolean(table));
  if (!tables.length) return [];
  const rows = tables.flatMap(table => table.rows);
  const flagged = rows.filter(row => row.flags.length);
  const changed = rows.filter(row => row.base && row.head && row.base.status !== 'unrunnable' && row.head.status !== 'unrunnable'
    && (row.base.status !== row.head.status || normalizeProbeValue(row.base.text) !== normalizeProbeValue(row.head.text)) && !row.flags.length);
  const heads = [...new Set(tables.map(table => table.head.slice(0, 12)))].join(', ');
  return [
    `Framework probe evidence (project probeRunner; Story base ${tables[0]!.base.slice(0, 12)} vs HEAD ${heads}; ${rows.length} example rows, ${flagged.length} flagged, ${changed.length} changed vs base; tables: ${probeStatePath(root, storyId, '<item>')}). Evidence only: it does not replace your own checks.`,
    ...flagged.slice(0, 15).map(row => `- ${describeProbeRow(row)}`),
    ...(flagged.length > 15 ? [`- +${flagged.length - 15} more flagged rows`] : []),
  ];
}
