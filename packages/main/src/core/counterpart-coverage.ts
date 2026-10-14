/**
 * EXPERIMENTAL A/B switch `plan.counterpartCoverage` (default off; lab
 * sibling-gate, old-PoS runs 43 / 46 / 55 / 57 / 71,
 * bench-staging/oldpos/run69-72-analysis.md §1).
 *
 * The miss: a Story adds a NEW operation on a receiver type (a write path for a
 * type that only had reads, e.g. single-index assignment on strings). The
 * request is silent on an operand edge class (a negative index). The base has
 * two precedents: the SAME receiver's counterpart (its read, which counts a
 * negative index from the end) and ANOTHER receiver's same operation (its
 * write, which rejects it). The implementer copied the second; the hidden test
 * followed the first. Only a scope-plan reviewer that happened to flag the
 * precedent conflict (prompt-only `plan.baseDisagreement`) avoided it, about one
 * run in two; lane-side parity (`review.siblingParity`) looped and is off.
 *
 * This module makes the PLAN side deterministic. For every checklist item that
 * ADDS an operation on a receiver type, the framework itself finds, in the Story
 * base (never in the request, never by task names):
 *
 *   1. The operation and its receiver, from the item's own rows and title:
 *      - method form: a call token `X` (`.X(`, `X(`) whose name is one half of a
 *        generic counterpart pair (get/set, get/put, read/write, load/store,
 *        getitem/setitem, peek/poke), on a base type `T` the item names (`T`,
 *        `NewT`) that has the other half `C` and lacks `X`: an added `T.X`
 *        (has both: a changed `T.X`, advisory only);
 *      - index form: a row `v = <literal>; v[<i>] = <value>` (a single-index
 *        write on a variable bound to a string / array / map literal): an index
 *        assignment on that literal kind; its counterpart is the base function
 *        named for the kind and for indexing, not for writing or ranges
 *        (`evalStringIndexExpression`, `string_getitem`, ...). Added when the
 *        base write functions (named for indexing and writing) never dispatch on
 *        the kind (`case`, `.Type()`, `instanceof`, `isinstance`, `typeof` lines)
 *        and no base test writes into a value of that kind, or when the
 *        project's evaluator fails the item's own write on the base.
 *   2. The edge classes the counterpart special-cases, with three independent
 *      signals per class:
 *      - branch: a condition line in the counterpart's body on an operand (a
 *        parameter or a local derived from one) or its receiver: `< 0` / `>= 0`
 *        (negative), a comparison with a length expression or a local derived
 *        from one (out of range), a zero length / empty literal (empty), a
 *        comparison with nil / null / None / undefined or a NULL type constant
 *        (null), `.Type()` / `isinstance` / `typeof` / `instanceof` / a type
 *        assertion or switch (type). `err != nil`-style checks are no operand;
 *      - base test: a base test calling the counterpart on that receiver with a
 *        negative / null first argument, or near an out-of-range error name; for
 *        the index form a read of a literal of the kind (or a variable bound to
 *        one) with a negative index or an index past its length;
 *      - base probe (only with a declared evaluator, `probeRunner` else
 *        `pinOracle`; index form): the counterpart read run on the row's own
 *        receiver with index -1 and with its length.
 *
 * Confidence rule (fail-closed on clear evidence, fail-open on uncertainty).
 * A class REFUSES PLAN→DEV only when all hold:
 *   (a) the operation is ADDED (method form: the receiver type lacks it in the
 *       base; index form: as in 1.), exactly one receiver type of the item is a
 *       candidate for that operation, and exactly one counterpart definition is
 *       found for that receiver in non-test base code;
 *   (b) at least two of the three signals agree (branch + base test, branch +
 *       probe, base test + probe), or the probe alone shows the counterpart
 *       ANSWERS A VALUE for a negative or out-of-range operand (a deliberate
 *       special case: a naive implementation fails there);
 *   (c) no current row (any item) exercises the new operation on that class,
 *       and no request sentence names the operation together with that class.
 * Any other discovered class (one signal, an ambiguous pair, a changed
 * operation) is an ADVISORY note: recorded in the evidence, listed by
 * story_review as an advisory issue and in the implementer prompt, never a
 * refusal. A base that cannot be read or is larger than the scan caps refuses
 * nothing.
 *
 * The refusal names the item, the operation, the counterpart (first oracle) and
 * another receiver's same operation (second oracle), each class with its
 * evidence, and ONE `Next:` (checklist_update with the item's whole
 * verificationIntent plus one placeholder row per class: "<op on a <class>
 * operand -> the result <counterpart> gives for it ... unless the request says
 * otherwise>"). The framework never writes a value. `next` (PLAN) returns the
 * same step before the scope-plan reviewer is launched. Evidence:
 * `.proof-or-stop/runtime/counterpart-coverage/<storyId>.json` (schema,
 * abVariant, base, inputs digest = cache key, checks, refusals, advisories).
 *
 * Limits (documented in docs/CLI.md): definitions are found by line patterns
 * for Go, Python, and brace languages (JS/TS, Rust, Java, Kotlin, C#, Swift,
 * C/C++, Scala, PHP); Ruby and other `end`-delimited languages are not scanned.
 * Operations behind other names (`append`, `insert` alone, operator overloads
 * other than getitem/setitem), counterparts that delegate the edge handling to
 * a helper, and out-of-range checks written without a length expression are
 * not seen: the item is then not checked (fail-open). Only single-index writes
 * are recognised for the index form (ranges / slices are not).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChecklistItem } from './types.js';
import { VERIFICATION_LANES } from './verification.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';
import { abVariantEvidenceOf, counterpartCoverageOn, type AbVariantEvidence } from './ab-variants.js';
import { loadConfig } from './config.js';
import { readStoryRequest } from './story-request.js';
import { shellQuote } from './shell-quote.js';
import type { StoryStore } from './store.js';
import { pinOracleStoryBase } from './pin-oracle.js';
import { baseEvaluator } from './plan-pin-probe.js';
import { evaluateInTree, probeProgram, type ProbeObservation } from './request-probes.js';
import { STORY_FOCUSED_CLASSIFICATION } from './verification-intent-classification.js';

export const COUNTERPART_COVERAGE_MISSING = 'counterpart_coverage_missing';
export const COUNTERPART_COVERAGE_ADVISORY = 'counterpart_coverage_advisory';
export const COUNTERPART_COVERAGE_SCHEMA = 'proof-or-stop.counterpart-coverage.v1' as const;
/** Bumped whenever discovery changes, so a cached result of an older rule set is recomputed. */
const DISCOVERY_VERSION = 1;

export type EdgeClass = 'negative' | 'out_of_range' | 'empty' | 'null' | 'type';
export const EDGE_CLASSES: readonly EdgeClass[] = ['negative', 'out_of_range', 'empty', 'null', 'type'];
const EDGE_LABEL: Record<EdgeClass, string> = { negative: 'negative', out_of_range: 'out of range', empty: 'empty', null: 'null or omitted', type: 'wrong type' };
export const edgeLabel = (edge: EdgeClass): string => EDGE_LABEL[edge];

export interface SourceFile { path: string; text: string }
export interface Located { name: string; path: string; line: number }
export interface Signal { path: string; line: number; text: string }
export interface EdgeEvidence {
  edge: EdgeClass;
  branch?: Signal;
  test?: Signal;
  probe?: { status: ProbeObservation['status']; text: string; code: string };
  /** The confidence rule (b) holds for this class. */
  strong: boolean;
  /** Ref of the first row exercising the new operation on this class, or null. */
  coveredBy: string | null;
  /** A request sentence names the operation together with this class. */
  stated: boolean;
}
export interface CounterpartCheck {
  itemId: string;
  /** `Shelf.Put`, or `string[i] = v` (index form). */
  operation: string;
  form: 'method' | 'index';
  status: 'added' | 'changed';
  /** Confidence rule (a): added, one receiver candidate, one counterpart definition. */
  pair: 'clear' | 'weak';
  counterpart: Located | null;
  /** Other receivers' same operation (the second oracle). */
  siblings: Located[];
  edges: EdgeEvidence[];
}
export interface CounterpartRefusal { itemId: string; operation: string; counterpart: string; siblings: string[]; edges: EdgeClass[]; evidence: string[] }
export interface CounterpartAdvisory { itemId: string; operation: string; counterpart: string; edges: EdgeClass[]; reason: string }
export interface CounterpartCoverageResult {
  checks: CounterpartCheck[];
  refusals: CounterpartRefusal[];
  advisories: CounterpartAdvisory[];
}
export interface ProbeRequest { statements: string[]; expr: string }
type ItemLike = Pick<ChecklistItem, 'id' | 'title' | 'status' | 'verificationIntent'> & Partial<Pick<ChecklistItem, 'userSees' | 'context' | 'files'>>;

// ---------------------------------------------------------------------------
// Source text: paths, masking, definitions

const SOURCE_PATH = /\.(?:go|py|js|mjs|cjs|jsx|ts|tsx|mts|cts|rs|java|kt|kts|cs|swift|scala|php|c|cc|cpp|cxx|h|hpp)$/i;
const SKIPPED_DIR = /(?:^|\/)(?:node_modules|vendor|third_party|dist|build|target|out|\.git|\.proof-or-stop|\.worktrees|testdata|fixtures?)\//;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?)\/|_test\.(?:go|py)$|(?:^|\/)test_[^/]*\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$|Tests?\.(?:java|kt|cs|swift|scala)$/;
export const isScannedSource = (path: string): boolean => SOURCE_PATH.test(path) && !SKIPPED_DIR.test(path) && !path.endsWith('.d.ts');
export const isTestSource = (path: string): boolean => TEST_PATH.test(path);
export type Lang = 'go' | 'py' | 'brace';
export const langOf = (path: string): Lang => (/\.go$/i.test(path) ? 'go' : /\.py$/i.test(path) ? 'py' : 'brace');

/** The text with comment and string-literal interiors blanked (same offsets; quotes kept so `== ""` stays visible). */
export function maskSource(text: string, lang: Lang): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => { for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (lang !== 'py' && c === '/' && next === '/') { const end = text.indexOf('\n', i); const stop = end < 0 ? text.length : end; blank(i, stop); i = stop; continue; }
    if (lang !== 'py' && c === '/' && next === '*') { const end = text.indexOf('*/', i + 2); const stop = end < 0 ? text.length : end + 2; blank(i, stop); i = stop; continue; }
    if (lang === 'py' && c === '#') { const end = text.indexOf('\n', i); const stop = end < 0 ? text.length : end; blank(i, stop); i = stop; continue; }
    if (lang === 'py' && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const quote = text.slice(i, i + 3);
      const end = text.indexOf(quote, i + 3);
      const stop = end < 0 ? text.length : end + 3;
      blank(i + 3, stop - 3); i = stop; continue;
    }
    if (c === '`' && lang !== 'py') {
      const end = text.indexOf('`', i + 1);
      const stop = end < 0 ? text.length : end + 1;
      blank(i + 1, stop - 1); i = stop; continue;
    }
    if (c === '"' || c === "'") {
      // A string or char literal ends on its line; a lone quote (a Rust lifetime, an apostrophe) is left as is.
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (j < text.length && text[j] === c) { blank(i + 1, j); i = j + 1; continue; }
    }
    i += 1;
  }
  return out.join('');
}

/** Index of the brace closing the one at `open` in masked text, or -1. */
function closingBrace(masked: string, open: number): number {
  let depth = 0;
  for (let k = open; k < masked.length; k += 1) {
    if (masked[k] === '{') depth += 1;
    else if (masked[k] === '}' && --depth === 0) return k;
  }
  return -1;
}

const lineAt = (text: string, offset: number): number => {
  let line = 1;
  for (let k = 0; k < offset && k < text.length; k += 1) if (text[k] === '\n') line += 1;
  return line;
};

/** Split a parameter list on top-level commas. */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < text.length; k += 1) {
    const c = text[k]!;
    if ('([{<'.includes(c)) depth += 1;
    else if (')]}>'.includes(c)) depth -= 1;
    else if (c === ',' && depth === 0) { out.push(text.slice(start, k)); start = k + 1; }
  }
  out.push(text.slice(start));
  return out.map(part => part.trim()).filter(Boolean);
}

const RECEIVER_PARAMS = new Set(['self', 'this', 'cls', '&self', '&mut self', 'mut self']);
function paramNames(list: string, lang: Lang): string[] {
  const names: string[] = [];
  for (const raw of splitTop(list)) {
    const part = raw.replace(/=.*$/s, '').replace(/^\.\.\.|^\*{1,2}/, '').trim();
    if (!part || RECEIVER_PARAMS.has(part.replace(/\s+/g, ' '))) continue;
    let name: string | undefined;
    if (lang === 'go') name = part.match(/^([A-Za-z_]\w*)/)?.[1];
    else if (part.includes(':')) name = part.split(':')[0]!.trim().match(/([A-Za-z_$][\w$]*)\s*\??$/)?.[1];
    else name = part.match(/([A-Za-z_$][\w$]*)\s*(?:\[\s*\])?$/)?.[1];
    if (name && !RECEIVER_PARAMS.has(name)) names.push(name);
  }
  return names;
}

export interface FnDef {
  path: string; line: number; name: string; owner: string | null;
  /** Names that denote the receiver inside the body (`s` of `func (s *Shelf)`, self, this). */
  receivers: string[];
  params: string[];
  /** Original body text and its masked twin (same offsets), starting at the line of `{` / the def. */
  body: string; masked: string; bodyLine: number; test: boolean;
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try', 'new', 'function', 'sizeof', 'typeof', 'with',
  'elif', 'when', 'match', 'loop', 'unless', 'until', 'foreach', 'using', 'lock', 'fixed', 'synchronized', 'super', 'await', 'yield', 'throw', 'delete', 'void', 'in', 'of']);

function goFunctions(path: string, text: string, masked: string): FnDef[] {
  const out: FnDef[] = [];
  const pattern = /^func[ \t]*(?:\([ \t]*([A-Za-z_]\w*)?[ \t]*\*?[ \t]*([A-Za-z_]\w*)(?:\[[^\]\n]*\])?[ \t]*\))?[ \t]*([A-Za-z_]\w*)[ \t]*(?:\[[^\]\n]*\])?[ \t]*\(([^)]*)\)/gm;
  for (const match of masked.matchAll(pattern)) {
    let k = match.index! + match[0].length;
    let depth = 0;
    let open = -1;
    for (; k < masked.length && k < match.index! + match[0].length + 400; k += 1) {
      const c = masked[k]!;
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      else if (c === '{' && depth === 0) { open = k; break; }
      else if (c === '\n' && depth === 0 && masked[k - 1] !== ',' && masked[k - 1] !== '(') break;
    }
    if (open < 0) continue;
    const close = closingBrace(masked, open);
    if (close < 0) continue;
    out.push({ path, line: lineAt(text, match.index!), name: match[3]!, owner: match[2] ?? null, receivers: match[1] ? [match[1]] : [],
      params: paramNames(text.slice(match.index! + match[0].length - match[4]!.length - 1, match.index! + match[0].length - 1), 'go'),
      body: text.slice(open, close + 1), masked: masked.slice(open, close + 1), bodyLine: lineAt(text, open), test: isTestSource(path) });
  }
  return out;
}

function pythonFunctions(path: string, text: string, masked: string): FnDef[] {
  const out: FnDef[] = [];
  const lines = text.split('\n');
  const maskedLines = masked.split('\n');
  const classes: Array<{ indent: number; name: string }> = [];
  const indentOf = (line: string): number => line.match(/^[ \t]*/)![0].replace(/\t/g, '    ').length;
  for (let index = 0; index < maskedLines.length; index += 1) {
    const line = maskedLines[index]!;
    if (!line.trim()) continue;
    const indent = indentOf(line);
    while (classes.length && classes.at(-1)!.indent >= indent) classes.pop();
    const cls = line.match(/^[ \t]*class\s+([A-Za-z_]\w*)/);
    if (cls) { classes.push({ indent, name: cls[1]! }); continue; }
    const def = line.match(/^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)?/);
    if (!def) continue;
    let end = index + 1;
    while (end < maskedLines.length && (!maskedLines[end]!.trim() || indentOf(maskedLines[end]!) > indent)) end += 1;
    const owner = classes.length && classes.at(-1)!.indent < indent ? classes.at(-1)!.name : null;
    out.push({ path, line: index + 1, name: def[1]!, owner, receivers: owner ? ['self', 'cls'] : [], params: paramNames(def[2] ?? '', 'py'),
      body: lines.slice(index, end).join('\n'), masked: maskedLines.slice(index, end).join('\n'), bodyLine: index + 1, test: isTestSource(path) });
  }
  return out;
}

function braceFunctions(path: string, text: string, masked: string): FnDef[] {
  const owners: Array<{ name: string; from: number; to: number }> = [];
  for (const match of masked.matchAll(/\b(class|struct|interface|trait|object|record|impl|extension)\b([^{;()=]*?)\{/g)) {
    const head = match[2]!.trim();
    const name = match[1] === 'impl'
      ? head.replace(/^<[^>]*>\s*/, '').match(/(?:\S+\s+for\s+)?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*(?:where\b[^{]*)?$/)?.[1]
      : head.match(/^([A-Za-z_$][\w$]*)/)?.[1];
    if (!name) continue;
    const open = match.index! + match[0].length - 1;
    const close = closingBrace(masked, open);
    if (close > open) owners.push({ name, from: open, to: close });
  }
  const seen = new Set<number>();
  const out: FnDef[] = [];
  const pattern = /^[ \t]*(?:(?:public|private|protected|internal|static|async|override|readonly|final|abstract|virtual|export|default|fun|func|def|fn|function|inline|open|suspend|unsafe|const|pub(?:\([^)]*\))?|extern)\s+)*(?:[\w<>[\],.?*&:]+\s+)?\*?([A-Za-z_$][\w$]*)\s*(?:<[^>{}()]*>)?\s*\(([^)]*)\)\s*(?::\s*[^{;=]+?|->\s*[^{;]+?|throws\s+[^{;]+?)?\s*\{/gm;
  for (const match of masked.matchAll(pattern)) {
    const name = match[1]!;
    if (KEYWORDS.has(name)) continue;
    const open = match.index! + match[0].length - 1;
    if (seen.has(open)) continue;
    seen.add(open);
    const close = closingBrace(masked, open);
    if (close < 0) continue;
    const owner = owners.filter(row => row.from < match.index! && row.to > open).sort((a, b) => (a.to - a.from) - (b.to - b.from))[0]?.name ?? null;
    out.push({ path, line: lineAt(text, match.index!), name, owner, receivers: owner ? ['this', 'self'] : [],
      params: paramNames(match[2] ?? '', 'brace'),
      body: text.slice(open, close + 1), masked: masked.slice(open, close + 1), bodyLine: lineAt(text, open), test: isTestSource(path) });
  }
  return out;
}

export function extractFunctions(file: SourceFile): FnDef[] {
  const lang = langOf(file.path);
  const masked = maskSource(file.text, lang);
  return lang === 'go' ? goFunctions(file.path, file.text, masked) : lang === 'py' ? pythonFunctions(file.path, file.text, masked) : braceFunctions(file.path, file.text, masked);
}

// ---------------------------------------------------------------------------
// Names and the counterpart vocabulary (generic, no task values)

/** Lower-case words of an identifier (camelCase, PascalCase, snake_case, dunder). */
export function nameWords(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
const norm = (name: string): string => nameWords(name).join('');
/** Counterpart pairs: a read and the write of the same data. */
const PAIRS: ReadonlyArray<readonly [string, string]> = [['get', 'set'], ['get', 'put'], ['read', 'write'], ['load', 'store'], ['getitem', 'setitem'], ['peek', 'poke']];
const COUNTERPARTS = new Map<string, string[]>();
for (const [a, b] of PAIRS) { COUNTERPARTS.set(a, [...(COUNTERPARTS.get(a) ?? []), b]); COUNTERPARTS.set(b, [...(COUNTERPARTS.get(b) ?? []), a]); }

type Kind = 'string' | 'array' | 'map';
const KIND_WORDS: Record<Kind, readonly string[]> = { string: ['string', 'str', 'text'], array: ['array', 'list', 'vec', 'vector', 'arr', 'tuple'], map: ['hash', 'map', 'dict', 'dictionary', 'table'] };
const KIND_LABEL: Record<Kind, string> = { string: 'string', array: 'array', map: 'map' };
const INDEX_WORDS = new Set(['index', 'subscript', 'getitem', 'setitem']);
const WRITE_WORDS = new Set(['set', 'put', 'write', 'store', 'assign', 'assignment', 'setitem', 'poke', 'update', 'mutate']);
const RANGE_WORDS = new Set(['range', 'ranges', 'slice', 'slices', 'slicing']);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (text: string, list: Iterable<string>): RegExp => new RegExp(`(?<![\\w$])(?:${[...list].map(escapeRegExp).join('|')})(?![\\w$])`);

// ---------------------------------------------------------------------------
// Branch evidence in the counterpart body

const LENGTHISH = /\blen\s*\(|\.len\s*\(|\.length\b|\.size\s*\(|\.size\b|\.Len\s*\(|\.Count\b|\.count\b|\bcount\s*\(|\blength\s*\(/;
const CONDITION = /\b(?:if|elif|else\s+if|while|case|when|guard|unless|assert|require|ensure|match|switch)\b/;

export function derivedNames(fn: FnDef): { operands: Set<string>; lengths: Set<string> } {
  const operands = new Set(fn.params);
  const lengths = new Set<string>();
  const lines = fn.masked.split('\n');
  for (let pass = 0; pass < 3; pass += 1) {
    for (const line of lines) {
      const assignment = line.match(/^\s*(?:(?:let|const|var|val|auto|mut|final)\s+)*(?:[\w<>[\]]+\s+(?=[A-Za-z_]\w*\s*(?::=|=)))?([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?::\s*[\w<>[\]. ]+)?\s*(?::=|=(?!=))\s*(.+)$/);
      if (!assignment) continue;
      const lhs = assignment[1]!.split(',').map(name => name.trim()).filter(name => name && name !== '_' && name !== 'err' && name !== 'ok');
      const rhs = assignment[2]!;
      const lengthish = LENGTHISH.test(rhs) || [...lengths].some(name => words(rhs, [name]).test(rhs));
      const fromOperand = [...operands].some(name => words(rhs, [name]).test(rhs));
      // An operand stays an operand when it is re-assigned (`i = len(s) + i` is the wrap itself); a new name bound to a
      // length expression is a length (`max := len(s) - 1`), else a name derived from an operand is an operand.
      for (const name of lhs) {
        if (operands.has(name) || lengths.has(name)) continue;
        if (lengthish) lengths.add(name);
        else if (fromOperand) operands.add(name);
      }
    }
  }
  return { operands, lengths };
}

/** The first condition line of the counterpart that special-cases each class. */
export function branchEvidence(fn: FnDef): Partial<Record<EdgeClass, Signal>> {
  const { operands, lengths } = derivedNames(fn);
  const out: Partial<Record<EdgeClass, Signal>> = {};
  if (!operands.size) return out;
  const op = `(?:${[...operands].map(escapeRegExp).join('|')})`;
  const recv = [...operands, ...fn.receivers].map(escapeRegExp).join('|');
  const lengthName = lengths.size ? `|(?<![\\w$])(?:${[...lengths].map(escapeRegExp).join('|')})(?![\\w$])` : '';
  const lengthExpr = `(?:[^|&{};\\n]*?(?:\\blen\\s*\\(|\\.len\\s*\\(|\\.length\\b|\\.size\\b|\\.Len\\s*\\(|\\.Count\\b|\\.count\\b|\\blength\\s*\\(${lengthName}))`;
  const tests: Record<EdgeClass, RegExp> = {
    negative: new RegExp(`(?<![\\w$])${op}\\s*(?:<\\s*0(?![\\d.x])|<=\\s*-\\s*1\\b|>=\\s*0(?![\\d.x]))|\\b0\\s*(?:>|<=)\\s*${op}(?![\\w$])|(?<![\\w$])${op}\\.(?:is_negative|isNegative|signum)\\b`),
    out_of_range: new RegExp(`(?<![\\w$])${op}\\s*(?:>=|>|<=|<)(?!=)\\s*${lengthExpr}|${lengthExpr.slice(0, -1)})\\s*(?:<=|<|>=|>)(?!=)\\s*${op}(?![\\w$])`),
    empty: new RegExp(`\\blen\\s*\\(\\s*(?:${recv})(?:\\.\\w+)*\\s*\\)\\s*(?:==|<=|<)\\s*[01]\\b|(?<![\\w$])(?:${recv})(?:\\.\\w+)*\\.(?:length|size\\(\\)|Len\\(\\)|count|Count)\\s*(?:===?|<=?)\\s*[01]\\b|(?<![\\w$])(?:${recv})(?:\\.\\w+)*\\s*===?\\s*(?:""|''|\\[\\s*\\])|\\b(?:is_?empty|isEmpty|IsEmpty)\\b|\\bnot\\s+(?:${recv})(?:\\.\\w+)*\\s*:`),
    null: new RegExp(`(?<![\\w$])${op}(?:\\.\\w+\\(\\))?\\s*(?:===?|!==?|\\bis(?:\\s+not)?)\\s*(?:nil|null|None|undefined|NULL)\\b|\\b(?:nil|null|None|undefined)\\s*(?:===?|!==?)\\s*${op}(?![\\w$])|(?<![\\w$])${op}\\b[^\\n]*\\b(?:NULL_?\\w*|Null)\\b`),
    type: new RegExp(`(?<![\\w$])${op}\\.Type\\(\\)|\\bisinstance\\(\\s*${op}\\b|\\btypeof\\s+${op}\\b|(?<![\\w$])${op}\\s+instanceof\\b|(?<![\\w$])${op}\\.\\(\\s*(?:type|\\*?[\\w.]+)\\s*\\)|\\bswitch\\b[^\\n]*(?<![\\w$])${op}\\.\\(type\\)`),
  };
  const maskedLines = fn.masked.split('\n');
  const bodyLines = fn.body.split('\n');
  for (let index = 0; index < maskedLines.length; index += 1) {
    const line = maskedLines[index]!;
    // A guard clause tests the operand; a plain statement (`i += len(s)`) does not count.
    if (!CONDITION.test(line) && !/^\s*(?:return\s+)?[^=]*\?[^:]+:/.test(line)) continue;
    for (const edge of EDGE_CLASSES) {
      if (!tests[edge].test(line)) continue;
      if (edge === 'type' && /\b(?:NULL_?\w*|Null|nil|null|None)\b/.test(line) && !/\.\(\s*type\s*\)|isinstance|typeof|instanceof/.test(line)) continue;
      const original = bodyLines[index]!.trim();
      const follow = original.endsWith('{') || original.endsWith(':') ? ` ${bodyLines[index + 1]?.trim() ?? ''}` : '';
      const text = `${original}${follow}`.slice(0, 120);
      // Up to two branch lines per class (the counterpart may handle the class differently on two paths, e.g. a range
      // flag and the single index): the owner probes the base anyway, the second line keeps the first from misleading.
      const seen = out[edge];
      if (!seen) out[edge] = { path: fn.path, line: fn.bodyLine + index, text };
      else if (!seen.text.includes(' | ') && seen.text !== text) seen.text = `${seen.text} | ${fn.bodyLine + index}: ${text}`.slice(0, 260);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Literal parsing for the index form (rows, test sources)

const STRING_LITERAL = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`;
const LITERAL = new RegExp(`^(?:${STRING_LITERAL}|\\[[^\\]\\n]*\\]|\\{[^}\\n]*\\})`);
function kindOfLiteral(literal: string): Kind | null {
  if (/^["'`]/.test(literal)) return 'string';
  if (literal.startsWith('[')) return 'array';
  if (literal.startsWith('{')) return 'map';
  return null;
}
/** Length of a string literal (code points of its content) or element count of an array literal. */
function literalLength(literal: string): number | null {
  if (/^["']/.test(literal)) return [...literal.slice(1, -1).replace(/\\(.)/g, '$1')].length;
  if (literal.startsWith('[')) { const inner = literal.slice(1, -1).trim(); return inner ? splitTop(inner).length : 0; }
  return null;
}

interface Binding { name: string; literal: string; kind: Kind; statement: string }
interface IndexWrite { receiver: string; operand: string; statement: string; binding: Binding }
/** `v = <literal>` / `v := <literal>` / `let v = <literal>` bindings and `v[<i>] = <value>` single-index writes of one row. */
function rowIndexWrites(desc: string): IndexWrite[] {
  const bindings = new Map<string, Binding>();
  const out: IndexWrite[] = [];
  for (const raw of desc.split(/;|\n/)) {
    const statement = raw.trim().replace(/^(?:[A-Za-z][\w ,-]*:\s+)?`?/, '').replace(/`$/, '');
    const bind = statement.match(/^(?:(?:let|const|var|val|auto)\s+)?([A-Za-z_]\w*)\s*(?::=|=(?!=))\s*(.+)$/);
    if (bind) {
      const literal = bind[2]!.trim().match(LITERAL)?.[0];
      const kind = literal ? kindOfLiteral(literal) : null;
      if (literal && kind && bind[2]!.trim() === literal) { bindings.set(bind[1]!, { name: bind[1]!, literal, kind, statement: `${bind[1]} = ${literal}` }); continue; }
    }
    const write = statement.match(/^([A-Za-z_]\w*)\s*\[([^[\]]+)\]\s*=(?!=)\s*(.+?)(?:\s*->.*)?$/);
    if (!write || write[2]!.includes(':')) continue;
    const binding = bindings.get(write[1]!);
    if (binding) out.push({ receiver: write[1]!, operand: write[2]!.trim(), statement: `${write[1]}[${write[2]!.trim()}] = ${write[3]!.trim()}`, binding });
  }
  return out;
}

/** The edge class an index / first-argument operand exercises, given the receiver's literal length when known. */
function operandClass(operand: string, length: number | null, typedNumeric: boolean): EdgeClass | null {
  const text = operand.trim();
  if (/^-\s*(?:\d|[A-Za-z_])/.test(text)) return 'negative';
  if (/^(?:nil|null|None|undefined|NULL)$/.test(text)) return 'null';
  if (/^\d+$/.test(text) && length !== null && Number(text) >= length) return 'out_of_range';
  if (typedNumeric && (/^["'`]/.test(text) || /^(?:true|false|True|False)$/.test(text) || /^\d+\.\d+$/.test(text))) return 'type';
  return null;
}

const PROSE: Record<EdgeClass, RegExp> = {
  negative: /\bnegative\b/i,
  out_of_range: /out[\s_-]?of[\s_-]?(?:range|bounds)|past the end|beyond the end|too (?:large|big)|exceeds? the (?:length|size)|\bIndexError\b|\bRangeError\b/i,
  empty: /\bempty\b/i,
  null: /\b(?:null|nil|None|undefined|omitted)\b/,
  type: /\bwrong type\b|\btype (?:error|mismatch)\b|\bnon-?(?:integer|numeric|number)\b|\bnot an? (?:integer|number)\b/i,
};

// ---------------------------------------------------------------------------
// Discovery

interface Rows { ref: string; itemId: string; desc: string }
function rowsOf(items: readonly ItemLike[]): Rows[] {
  const out: Rows[] = [];
  for (const item of items) {
    if (item.status === 'withdrawn') continue;
    for (const lane of VERIFICATION_LANES) {
      for (const [index, row] of (item.verificationIntent?.[lane] ?? []).entries()) {
        const desc = typeof row?.desc === 'string' ? row.desc.trim() : '';
        if (!desc || /^<[^]*>$/.test(desc)) continue; // an unauthored placeholder covers nothing
        out.push({ ref: `${item.id}:${lane}:${index}`, itemId: item.id, desc });
      }
    }
  }
  return out;
}
const backtickSpans = (text: string | undefined): string => [...(text ?? '').matchAll(/`([^`\n]+)`/g)].map(match => match[1]).join('\n');

/** Request sentences (lines and `.`-ended sentences). */
const sentencesOf = (text: string | null): string[] => (text ?? '').split(/\n|(?<=[.!?])\s+/).map(sentence => sentence.trim()).filter(Boolean);
const STATE_WORDS: Record<EdgeClass, RegExp> = {
  negative: /\bnegative\s+(?:index|indexes|indices|indice|position|offset|subscript|key|argument|i|n)\b|\b(?:index|indexes|indices|position|offset)\s+(?:is|are)?\s*negative\b|\[\s*-\s*\d+\s*\]|\(\s*-\s*\d+/i,
  out_of_range: PROSE.out_of_range,
  empty: /\bempty\b/i,
  null: /\b(?:null|nil|None|undefined|omitted)\b/,
  type: PROSE.type,
};

interface Context { fns: FnDef[]; tests: SourceFile[]; byOwner: Map<string, Map<string, FnDef[]>> }
function contextOf(files: readonly SourceFile[]): Context {
  const fns = files.flatMap(file => { try { return extractFunctions(file); } catch { return []; } });
  const byOwner = new Map<string, Map<string, FnDef[]>>();
  for (const fn of fns) {
    if (fn.test || !fn.owner) continue;
    const methods = byOwner.get(fn.owner) ?? new Map<string, FnDef[]>();
    methods.set(norm(fn.name), [...(methods.get(norm(fn.name)) ?? []), fn]);
    byOwner.set(fn.owner, methods);
  }
  return { fns, tests: files.filter(file => isTestSource(file.path)), byOwner };
}

const located = (fn: FnDef, name = fn.owner ? `${fn.owner}.${fn.name}` : fn.name): Located => ({ name, path: fn.path, line: fn.line });

/** Method-form test evidence: a base test calling the counterpart on a value of the receiver type. */
function methodTestEvidence(ctx: Context, owner: string, method: string): Partial<Record<EdgeClass, Signal>> {
  const out: Partial<Record<EdgeClass, Signal>> = {};
  const ownerRef = new RegExp(`(?<![\\w$])(?:New|new|make|Make|create|Create)?${escapeRegExp(owner)}(?![\\w$])`);
  for (const file of ctx.tests) {
    if (!ownerRef.test(file.text)) continue;
    const lines = file.text.split('\n');
    const vars = new Set<string>();
    for (const line of lines) {
      const bound = line.match(new RegExp(`(?<![\\w$])([A-Za-z_]\\w*)\\s*(?::=|=(?!=))\\s*(?:&|new\\s+)?(?:[\\w.]*\\.)?(?:New|new|make|Make|create|Create)?${escapeRegExp(owner)}\\s*[({]`));
      if (bound) vars.add(bound[1]!);
    }
    const call = new RegExp(`(?:(?<![\\w$])(?:${[...vars].map(escapeRegExp).join('|') || '\\b_never_'})|${escapeRegExp(owner)}\\s*\\([^)]*\\))\\.${escapeRegExp(method)}\\s*\\(([^)]*)\\)`);
    for (const [index, line] of lines.entries()) {
      const match = line.match(call);
      if (!match) continue;
      const first = splitTop(match[1] ?? '')[0] ?? '';
      const signal = (): Signal => ({ path: file.path, line: index + 1, text: line.trim().slice(0, 160) });
      const cls = operandClass(first, null, false);
      if (cls && !out[cls]) out[cls] = signal();
      if (!out.out_of_range && cls !== 'negative' && PROSE.out_of_range.test(lines.slice(index, index + 3).join('\n').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'))) out.out_of_range = signal();
    }
  }
  return out;
}

/** Index-form test evidence: a read of a literal of the kind (or a variable bound to one) with a negative / past-the-end index. */
function indexTestEvidence(ctx: Context, kind: Kind): Partial<Record<EdgeClass, Signal>> {
  const out: Partial<Record<EdgeClass, Signal>> = {};
  const literalBody = kind === 'string' ? String.raw`\\?"(?:[^"\\\n]|\\[^"])*?\\?"|'(?:[^'\\\n])*'` : kind === 'array' ? String.raw`\[[^[\]\n]*\]` : String.raw`\{[^{}\n]*\}`;
  // A literal, not an index expression (`f(x)[0][1]` is a read of a read).
  const read = new RegExp(`(?<![\\w)\\]])(${literalBody})\\s*\\[\\s*(-?\\s*\\d+)\\s*\\](?!\\s*=[^=])`, 'g');
  for (const file of ctx.tests) {
    const lines = file.text.split('\n');
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(read)) {
        const literal = match[1]!.replace(/\\"/g, '"');
        const cls = operandClass(match[2]!.replace(/\s+/g, ''), literalLength(literal), false);
        if (cls && !out[cls]) out[cls] = { path: file.path, line: index + 1, text: line.trim().slice(0, 160) };
      }
    }
  }
  return out;
}

/** Whether a base test writes into a value of the kind (`v = <literal>` then `v[i] = ...`, escaped quotes allowed). */
function testsWriteKind(ctx: Context, kind: Kind): boolean {
  const literalStart = kind === 'string' ? String.raw`\\?["']` : kind === 'array' ? String.raw`\[` : String.raw`\{`;
  for (const file of ctx.tests) {
    const lines = file.text.split('\n');
    for (const [index, line] of lines.entries()) {
      for (const bound of line.matchAll(new RegExp(`(?<![\\w$])([A-Za-z_]\\w*)\\s*(?::=|=(?!=))\\s*${literalStart}`, 'g'))) {
        const near = lines.slice(index, index + 3).join('\n');
        if (new RegExp(`(?<![\\w$])${escapeRegExp(bound[1]!)}\\s*\\[[^\\]:\\n]+\\]\\s*=(?!=)`).test(near)) return true;
      }
    }
  }
  return false;
}

interface Pending { check: CounterpartCheck; tests: Partial<Record<EdgeClass, Signal>>; branches: Partial<Record<EdgeClass, Signal>>;
  probes: Partial<Record<EdgeClass, { status: ProbeObservation['status']; text: string; code: string }>>; mentions: RegExp; kind?: Kind; method?: string; owner?: string }

function methodChecks(ctx: Context, item: ItemLike, rows: Rows[]): Pending[] {
  const own = rows.filter(row => row.itemId === item.id);
  const code = [...own.map(row => row.desc), item.title, backtickSpans(item.userSees)].join('\n');
  const about = [item.title, backtickSpans(item.userSees), item.userSees ?? ''].join('\n');
  const text = [item.title, item.userSees ?? '', item.context ?? '', ...own.map(row => row.desc)].join('\n');
  const tokens = new Set<string>();
  for (const match of code.matchAll(/(?:\.|::)([A-Za-z_]\w*)\b|(?<![\w$.])([A-Za-z_]\w*)\s*\(/g)) {
    const token = match[1] ?? match[2]!;
    if (COUNTERPARTS.has(norm(token))) tokens.add(token);
  }
  const out: Pending[] = [];
  const mentioned = [...ctx.byOwner.keys()].filter(owner => new RegExp(`(?<![\\w$])(?:New|new|make|Make|create|Create)?${escapeRegExp(owner)}(?![\\w$])`).test(text));
  for (const token of tokens) {
    const key = norm(token);
    const candidates = mentioned.flatMap(owner => {
      const methods = ctx.byOwner.get(owner)!;
      const counterpart = (COUNTERPARTS.get(key) ?? []).map(name => methods.get(name) ?? []).find(defs => defs.length);
      return counterpart ? [{ owner, counterpart, has: methods.has(key) }] : [];
    });
    const added = candidates.filter(candidate => !candidate.has);
    for (const candidate of candidates) {
      // A changed operation is checked (advisory) only when the item is about it (title / userSees), not when a row merely calls it.
      if (candidate.has && !words(about, [token]).test(about)) continue;
      const fn = candidate.counterpart[0]!;
      const siblings = [...ctx.byOwner].filter(([owner, methods]) => owner !== candidate.owner && methods.has(key)).map(([owner, methods]) => located(methods.get(key)![0]!, `${owner}.${methods.get(key)![0]!.name}`));
      const pair = !candidate.has && added.length === 1 && candidate.counterpart.length === 1 ? 'clear' : 'weak';
      out.push({ check: { itemId: item.id, operation: `${candidate.owner}.${token}`, form: 'method', status: candidate.has ? 'changed' : 'added', pair,
        counterpart: located(fn), siblings, edges: [] },
      branches: branchEvidence(fn), tests: methodTestEvidence(ctx, candidate.owner, fn.name), probes: {},
      mentions: new RegExp(`(?<![\\w$])${escapeRegExp(token)}(?![\\w$])`), method: token, owner: candidate.owner });
    }
  }
  return out;
}

function indexChecks(ctx: Context, item: ItemLike, rows: Rows[], probe: ((cases: ProbeRequest[]) => Array<ProbeObservation | undefined>) | undefined): Pending[] {
  const writes = rows.filter(row => row.itemId === item.id).flatMap(row => rowIndexWrites(row.desc));
  const byKind = new Map<Kind, IndexWrite[]>();
  for (const write of writes) byKind.set(write.binding.kind, [...(byKind.get(write.binding.kind) ?? []), write]);
  const out: Pending[] = [];
  for (const [kind, kindWrites] of byKind) {
    const kindWord = (name: string): boolean => nameWords(name).some(word => KIND_WORDS[kind].includes(word));
    const readers = ctx.fns.filter(fn => !fn.test && (() => {
      const nameW = nameWords(fn.name);
      const byName = nameW.some(word => KIND_WORDS[kind].includes(word)) && nameW.some(word => INDEX_WORDS.has(word));
      const byOwner = Boolean(fn.owner && kindWord(fn.owner)) && norm(fn.name) === 'getitem';
      return (byName || byOwner) && !nameW.some(word => WRITE_WORDS.has(word) || RANGE_WORDS.has(word));
    })());
    if (!readers.length) continue;
    const fewest = Math.min(...readers.map(fn => nameWords(fn.name).length));
    const best = readers.filter(fn => nameWords(fn.name).length === fewest);
    const fn = best[0]!;
    const writers = ctx.fns.filter(candidate => !candidate.test && (() => {
      const nameW = nameWords(candidate.name);
      return (nameW.some(word => INDEX_WORDS.has(word)) && nameW.some(word => WRITE_WORDS.has(word)) && !nameW.some(word => RANGE_WORDS.has(word)))
        || norm(candidate.name) === 'setitem';
    })());
    const dispatchesOnKind = writers.some(writer => writer.masked.split('\n').some(line => /\bcase\b|\.Type\(\)|instanceof|isinstance|typeof|\bwhen\b|=>/.test(line)
      && [...line.matchAll(/[A-Za-z_]\w*/g)].some(match => kindWord(match[0]))) || Boolean(writer.owner && kindWord(writer.owner)));
    const first = kindWrites[0]!;
    const probes: Pending['probes'] = {};
    let status: 'added' | 'changed' = dispatchesOnKind || testsWriteKind(ctx, kind) ? 'changed' : 'added';
    let pairKnown = writers.length > 0;
    if (probe) {
      const length = literalLength(first.binding.literal);
      const cases: ProbeRequest[] = [
        { statements: [first.binding.statement, first.statement], expr: first.receiver },
        { statements: [first.binding.statement], expr: `${first.receiver}[-1]` },
        ...(length !== null ? [{ statements: [first.binding.statement], expr: `${first.receiver}[${length}]` }] : []),
      ];
      const observed = probe(cases);
      const own = observed[0];
      if (own?.status === 'value') { status = 'changed'; pairKnown = true; } else if (own?.status === 'error') { status = 'added'; pairKnown = true; }
      const code = (index: number): string => [...cases[index]!.statements, cases[index]!.expr].join('; ');
      if (observed[1] && observed[1].status !== 'unrunnable') probes.negative = { status: observed[1].status, text: observed[1].text.split('\n')[0]!.slice(0, 160), code: code(1) };
      if (observed[2] && observed[2].status !== 'unrunnable') probes.out_of_range = { status: observed[2].status, text: observed[2].text.split('\n')[0]!.slice(0, 160), code: code(2) };
    }
    const assign = /\b(?:assign\w*|writ\w*|set(?:s|ting)?|stor\w*|replac\w*|updat\w*)\b/i;
    const kindProse = new RegExp(`\\b(?:${KIND_WORDS[kind].join('|')})s?\\b`, 'i');
    out.push({ check: { itemId: item.id, operation: `${KIND_LABEL[kind]}[i] = v`, form: 'index', status, pair: status === 'added' && best.length === 1 && pairKnown ? 'clear' : 'weak',
      counterpart: located(fn), siblings: writers.filter(writer => writer.owner === null || !kindWord(writer.owner)).map(writer => located(writer)), edges: [] },
    branches: branchEvidence(fn), tests: indexTestEvidence(ctx, kind), probes, kind,
    mentions: new RegExp(`(?=[^]*${assign.source})(?=[^]*${kindProse.source})`, 'i') });
  }
  return out;
}

function coverageOf(pending: Pending, edge: EdgeClass, rows: Rows[]): string | null {
  for (const row of rows) {
    if (pending.check.form === 'index') {
      for (const write of rowIndexWrites(row.desc).filter(candidate => candidate.binding.kind === pending.kind)) {
        const length = literalLength(write.binding.literal);
        const cls = edge === 'empty' ? (length === 0 ? 'empty' : null) : operandClass(write.operand, length, pending.kind !== 'map');
        if (cls === edge) return row.ref;
        if (edge === 'out_of_range' && PROSE.out_of_range.test(row.desc)) return row.ref;
      }
      if (!rowIndexWrites(row.desc).length && pending.mentions.test(row.desc) && PROSE[edge].test(row.desc)) return row.ref;
      continue;
    }
    const method = escapeRegExp(pending.method!);
    const bound = new Map<string, string>();
    for (const match of row.desc.matchAll(/(?<![\w$])([A-Za-z_]\w*)\s*(?::=|=(?!=))\s*(?:&|new\s+)?(?:[\w.]*\.)?(?:New|new|make|Make|create|Create)?([A-Z]\w*)\s*[({]/g)) bound.set(match[1]!, match[2]!);
    const calls = [...row.desc.matchAll(new RegExp(`(?:(?<![\\w$])([A-Za-z_]\\w*)\\.)?(?<![\\w$])${method}\\s*\\(([^)]*)\\)`, 'g'))]
      .filter(match => !match[1] || !bound.has(match[1]) || bound.get(match[1]) === pending.owner);
    if (!calls.length) continue;
    for (const call of calls) {
      const first = splitTop(call[2] ?? '')[0] ?? '';
      if (operandClass(first, null, edge === 'type') === edge) return row.ref;
    }
    if (edge === 'empty' && new RegExp(`(?:New|new|make|Make)?${escapeRegExp(pending.owner!)}\\s*(?:\\(\\s*\\)|\\{\\s*\\})`).test(row.desc)) return row.ref;
    if (PROSE[edge].test(edge === 'out_of_range' ? row.desc.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2') : row.desc)) return row.ref;
  }
  return null;
}

function statedIn(pending: Pending, edge: EdgeClass, requestText: string | null): boolean {
  return sentencesOf(requestText).some(sentence => pending.mentions.test(sentence) && STATE_WORDS[edge].test(sentence));
}

/**
 * Discovery on an in-memory base snapshot (pure; the gate passes the Story base's sources and,
 * with a declared evaluator, a probe of the base). See the module comment for the confidence rule.
 */
export function counterpartCoverage(input: { files: readonly SourceFile[]; items: readonly ItemLike[]; requestText: string | null;
  probe?: (cases: ProbeRequest[]) => Array<ProbeObservation | undefined> }): CounterpartCoverageResult {
  const ctx = contextOf(input.files);
  const rows = rowsOf(input.items);
  const checks: CounterpartCheck[] = [];
  const refusals: CounterpartRefusal[] = [];
  const advisories: CounterpartAdvisory[] = [];
  for (const item of input.items) {
    if (item.status === 'withdrawn') continue;
    for (const pending of [...methodChecks(ctx, item, rows), ...indexChecks(ctx, item, rows, input.probe)]) {
      const { check } = pending;
      for (const edge of EDGE_CLASSES) {
        const branch = pending.branches[edge];
        const test = pending.tests[edge];
        const probe = pending.probes[edge];
        const answered = probe && probe.status !== 'unrunnable';
        if (!branch && !test && !answered) continue;
        const signals = [branch, test, answered ? probe : undefined].filter(Boolean).length;
        const strong = signals >= 2 || (probe?.status === 'value' && (edge === 'negative' || edge === 'out_of_range'));
        check.edges.push({ edge, ...(branch ? { branch } : {}), ...(test ? { test } : {}), ...(probe ? { probe } : {}), strong,
          coveredBy: coverageOf(pending, edge, rows), stated: statedIn(pending, edge, input.requestText) });
      }
      if (!check.edges.length) continue;
      checks.push(check);
      const open = check.edges.filter(edge => !edge.coveredBy && !edge.stated);
      const counterpart = check.counterpart ? `${check.counterpart.name} (${check.counterpart.path}:${check.counterpart.line})` : '(none)';
      const refused = check.pair === 'clear' ? open.filter(edge => edge.strong) : [];
      if (refused.length) {
        refusals.push({ itemId: check.itemId, operation: check.operation, counterpart, siblings: check.siblings.map(row => `${row.name} (${row.path}:${row.line})`),
          edges: refused.map(edge => edge.edge), evidence: refused.map(describeEvidence) });
      }
      const weak = open.filter(edge => !refused.includes(edge));
      if (weak.length) {
        advisories.push({ itemId: check.itemId, operation: check.operation, counterpart, edges: weak.map(edge => edge.edge),
          reason: check.status === 'changed' ? 'the operation already exists for this receiver in the base (its own base behaviour is the oracle)'
            : check.pair === 'weak' ? 'the operation / counterpart pair is ambiguous' : 'one signal only (no base test or probe agrees with the branch)' });
      }
    }
  }
  return { checks, refusals, advisories };
}

const describeEvidence = (edge: EdgeEvidence): string => {
  const parts = [
    edge.branch ? `branch \`${edge.branch.text}\` (${edge.branch.path}:${edge.branch.line})` : '',
    edge.test ? `base test \`${edge.test.text}\` (${edge.test.path}:${edge.test.line})` : '',
    edge.probe ? `base probe \`${edge.probe.code}\` -> ${edge.probe.status === 'error' ? 'error ' : ''}${edge.probe.text}` : '',
  ].filter(Boolean);
  return `${edgeLabel(edge.edge)}: ${parts.join('; ')}`;
};

// ---------------------------------------------------------------------------
// Rendering

function placeholderRow(desc: string): Record<string, unknown> {
  return { desc, type: 'logic', priority: 'must', ...STORY_FOCUSED_CLASSIFICATION,
    verification: { command: '<pinned test command, e.g. go test -v ./pkg -run ^TestName$>', selector: '<line its passing run prints, e.g. --- PASS: TestName>' } };
}

/** One placeholder row per uncovered class: its expected value follows the counterpart unless the request says otherwise. */
export function counterpartPlaceholderRows(refusal: CounterpartRefusal): Array<Record<string, unknown>> {
  const counterpart = refusal.counterpart.replace(/ \(.*\)$/, '');
  return refusal.edges.map(edge => ({
    ...placeholderRow(`<${refusal.operation} on ${/^[aeiou]/.test(edgeLabel(edge)) ? 'an' : 'a'} ${edgeLabel(edge)} operand -> the result ${counterpart} gives for it (probe it on the Story base), unless the request says otherwise; an input in the project syntax -> exact result or exact error>`),
    derivation: { requestQuote: `<verbatim request.md sentence that asks for ${refusal.operation}>`,
      computation: `<the ${counterpart} base probe of this case and its result, then the pinned value (or the request sentence that says otherwise)>` },
  }));
}

/** The ONE next action: the item's whole verificationIntent with the placeholder rows appended to edge. */
/**
 * Lab initplan (initplan-breakdown.md rank 6): a row patch that APPENDS one placeholder edge row per uncovered
 * class (`<item>:edge:+`), not the item's whole verificationIntent; the existing rows are untouched.
 */
export function counterpartNextPayload(storyId: string, _item: ItemLike | undefined, refusal: CounterpartRefusal): Record<string, unknown> {
  return { storyId, itemId: refusal.itemId, intentRows: counterpartPlaceholderRows(refusal).map(row => ({ ref: `${refusal.itemId}:edge:+`, ...(row as Record<string, unknown>) })) };
}

export function describeCounterpartRefusal(refusal: CounterpartRefusal): string {
  return `${refusal.itemId} adds ${refusal.operation}; the same receiver's counterpart ${refusal.counterpart} special-cases ${refusal.edges.map(edgeLabel).join(', ')}, `
    + `which no row states for ${refusal.operation} (${refusal.evidence.join('; ')})`;
}

export function counterpartRule(refusal: CounterpartRefusal): string {
  const siblings = refusal.siblings.length ? `; another receiver's same operation, ${refusal.siblings.slice(0, 3).join(', ')}, only second` : '';
  return `Add one row per class on ${refusal.itemId} whose expected value follows ${refusal.counterpart.replace(/ \(.*\)$/, '')} on that case unless the request says otherwise `
    + `(oracle order: the same receiver's counterpart first${siblings}). The framework never writes the value.`;
}

/** The PLAN→DEV refusal text (`Cannot enter DEV: ... [counterpart_coverage_missing] ...` + ONE Next), or null. */
export function counterpartRefusalText(storyId: string, result: Pick<CounterpartCoverageResult, 'refusals'> | null, items: readonly ItemLike[]): string | null {
  if (!result || !result.refusals.length) return null;
  const first = result.refusals[0]!;
  const payload = counterpartNextPayload(storyId, items.find(item => item.id === first.itemId), first);
  return `Cannot enter DEV: ${result.refusals.length} added operation(s) leave counterpart cases uncovered [${COUNTERPART_COVERAGE_MISSING}] (A/B switch plan.counterpartCoverage=on): `
    + `${result.refusals.slice(0, 4).map(describeCounterpartRefusal).join(' | ')}${result.refusals.length > 4 ? ` +${result.refusals.length - 4} more` : ''}. ${counterpartRule(first)}\n`
    + `Next: proof-or-stop checklist_update ${shellQuote(JSON.stringify(payload))}`;
}

export const IMPLEMENTER_COUNTERPART_PROBE = 'Counterpart probe (A/B plan.counterpartCoverage=on): before writing an operation the Story adds on a receiver type, '
  + 'run the SAME receiver\'s existing counterpart (its read for a new write, its write for a new read) on the Story base on each edge class '
  + '(negative, out of range, empty, null or omitted, wrong type) and make the new operation give the same result unless a checklist row or the request says otherwise; '
  + 'another receiver\'s same operation is only the second oracle. Report one line per case run: `[counterpart] <op> :: <case> -> <base result>`.';

/** The implementer block for one item: the contract plus what the framework discovered for it (refusals and advisories). */
export function counterpartImplementerLines(result: CounterpartCoverageResult | null, itemId: string): string[] {
  const lines = [IMPLEMENTER_COUNTERPART_PROBE];
  for (const check of result?.checks.filter(row => row.itemId === itemId) ?? []) {
    if (!check.counterpart) continue;
    lines.push(`- ${check.operation}: counterpart ${check.counterpart.name} (${check.counterpart.path}:${check.counterpart.line}) special-cases ${check.edges.map(edge => edgeLabel(edge.edge)).join(', ')}`
      + `${check.siblings.length ? `; second oracle ${check.siblings.slice(0, 2).map(row => row.name).join(', ')}` : ''}${check.status === 'changed' ? ' (the operation exists in the base: keep its own base behaviour)' : ''}.`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Base snapshot, cache, evidence, gate

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 400_000;
const MAX_TOTAL_BYTES = 24_000_000;

function git(cwd: string, args: string[], input?: string): Buffer | null {
  try { return execFileSync('git', args, { cwd, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); } catch { return null; }
}

/** The scanned source files of a commit (one `ls-tree` and one `cat-file --batch`), or null when unreadable or over the caps. */
export function readBaseSources(gitCwd: string, base: string): SourceFile[] | null {
  const listing = git(gitCwd, ['ls-tree', '-r', '-l', '-z', base]);
  if (!listing) return null;
  const entries: Array<{ object: string; path: string }> = [];
  let total = 0;
  for (const record of listing.toString('utf8').split('\0')) {
    const match = record.match(/^\d+ blob ([0-9a-f]{40,64})\s+(\d+)\t(.+)$/s);
    if (!match || !isScannedSource(match[3]!) || Number(match[2]) > MAX_FILE_BYTES) continue;
    total += Number(match[2]);
    entries.push({ object: match[1]!, path: match[3]! });
  }
  if (entries.length > MAX_FILES || total > MAX_TOTAL_BYTES) return null;
  if (!entries.length) return [];
  const batch = git(gitCwd, ['cat-file', '--batch'], `${entries.map(entry => entry.object).join('\n')}\n`);
  if (!batch) return null;
  const files: SourceFile[] = [];
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = batch.indexOf(0x0a, offset);
    if (headerEnd < 0) return null;
    const header = batch.subarray(offset, headerEnd).toString('utf8').split(' ');
    const size = Number(header[2]);
    if (header[1] !== 'blob' || !Number.isFinite(size)) return null;
    files.push({ path: entry.path, text: batch.subarray(headerEnd + 1, headerEnd + 1 + size).toString('utf8') });
    offset = headerEnd + 1 + size + 1;
  }
  return files;
}

export interface CounterpartCoverageEvidence extends CounterpartCoverageResult {
  schema: typeof COUNTERPART_COVERAGE_SCHEMA; storyId: string; checkedAt: string; abVariant?: AbVariantEvidence;
  base: string | null; inputsDigest: string; scanned: number; probe: 'probeRunner' | 'pinOracle' | null; note?: string;
}

function evidencePath(root: string, storyId: string): string {
  return join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'counterpart-coverage', `${storyId}.json`);
}

const memo = new Map<string, CounterpartCoverageEvidence>();

/** The switch's result for a Story (cached by base + checklist + request), or null when plan.counterpartCoverage is off or the config is unreadable. */
export function planCounterpartCoverage(store: Pick<StoryStore, 'readStory' | 'readChecklist' | 'storyFilePath'>, root: string, storyId: string, gitCwd: string | (() => string)): CounterpartCoverageEvidence | null {
  let config: unknown;
  try { config = loadConfig(root); } catch { return null; }
  if (!counterpartCoverageOn(config)) return null;
  try {
    const cwd = typeof gitCwd === 'function' ? gitCwd() : gitCwd;
    const items = store.readChecklist(storyId).items as ItemLike[];
    const request = readStoryRequest(store, storyId);
    const requestText = request.status === 'ok' ? request.text : null;
    const story = store.readStory(storyId) as { integrationTarget?: { parentCommitAtCreation?: string } };
    const base = pinOracleStoryBase(cwd, story.integrationTarget?.parentCommitAtCreation);
    const inputsDigest = createHash('sha256').update(JSON.stringify({ v: DISCOVERY_VERSION, base, requestText,
      items: items.map(item => ({ id: item.id, status: item.status, title: item.title, userSees: item.userSees, context: item.context, intent: item.verificationIntent })) })).digest('hex');
    const path = evidencePath(root, storyId);
    const cached = memo.get(path);
    if (cached?.inputsDigest === inputsDigest) return cached;
    if (existsSync(path)) {
      try {
        const stored = JSON.parse(readFileSync(path, 'utf8')) as CounterpartCoverageEvidence;
        if (stored.schema === COUNTERPART_COVERAGE_SCHEMA && stored.inputsDigest === inputsDigest) { memo.set(path, stored); return stored; }
      } catch { /* recomputed below */ }
    }
    const files = base ? readBaseSources(cwd, base) : null;
    let probeKind: CounterpartCoverageEvidence['probe'] = null;
    let probe: ((cases: ProbeRequest[]) => Array<ProbeObservation | undefined>) | undefined;
    if (files) {
      const evaluator = (() => { try { return baseEvaluator(store, root, storyId, cwd); } catch { return null; } })();
      if (evaluator) {
        probeKind = evaluator.kind;
        const runConfig = evaluator.kind === 'pinOracle' ? { ...evaluator.config, skipPattern: undefined } : evaluator.config;
        probe = cases => {
          const programs = cases.map(row => probeProgram(runConfig, row.statements, row.expr));
          const observed = evaluateInTree({ config: runConfig, env: evaluator.env }, evaluator.tree, programs);
          return programs.map(program => observed.get(program));
        };
      }
    }
    const result = files ? counterpartCoverage({ files, items, requestText, probe }) : { checks: [], refusals: [], advisories: [] };
    const evidence: CounterpartCoverageEvidence = { schema: COUNTERPART_COVERAGE_SCHEMA, storyId, checkedAt: new Date().toISOString(),
      ...(abVariantEvidenceOf(config) ? { abVariant: abVariantEvidenceOf(config) } : {}), base, inputsDigest, scanned: files?.length ?? 0, probe: probeKind, ...result,
      ...(files ? {} : { note: base ? 'the Story base could not be read or exceeds the scan caps: nothing is refused' : 'no Story base: nothing is refused' }) };
    try {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
    } catch { /* evidence of a check the gate repeats on every call; never fails the gate */ }
    memo.set(path, evidence);
    return evidence;
  } catch {
    return null;
  }
}

/** The PLAN→DEV refusal (`[counterpart_coverage_missing]` + one Next), or null. */
export function counterpartCoverageDevEntryFailure(store: Pick<StoryStore, 'readStory' | 'readChecklist' | 'storyFilePath'>, root: string, storyId: string, gitCwd: string | (() => string)): string | null {
  const result = planCounterpartCoverage(store, root, storyId, gitCwd);
  if (!result?.refusals.length) return null;
  try { return counterpartRefusalText(storyId, result, store.readChecklist(storyId).items as ItemLike[]); } catch { return null; }
}
