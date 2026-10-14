/**
 * Exact request strings asserted only by prefix / contains (old-PoS runs 30 and
 * 32, bench-staging/oldpos/run32-analysis.md §4).
 *
 * Both runs' only R1 finding was the same test-strength gap: the request says
 * error strings "must match exactly", the implementer's tests compared those
 * strings through a test helper of the repository that wraps a prefix
 * comparison (`strings.HasPrefix`), so an appended
 * suffix would still pass. Run 32 paid a remediation run plus a full
 * confirmation round (14.9 min / 11.2M) for it; the prompt already said
 * "compare it exactly, not a prefix / contains helper".
 *
 * Deterministic check (no model): the request's backticked message literals
 * (text before the first `<placeholder>`), the test files the Story added or
 * changed (Story base..HEAD), and per occurrence of a literal in a test
 * function that has added lines: is the expected text itself an operand of a
 * prefix / contains call (directly, or through the helper parameter it is
 * passed to; helpers are looked up in the test files of the same directories
 * at HEAD), or of an equality? Old-PoS run 40 (N2) and run 38 §3: attribution
 * is per row and per operand, not per test function: a row compared exactly
 * (its own table loop, wrapper-type branch or keyed field) is exact even when
 * the same function compares other rows by prefix, and a helper that checks the
 * expected text with equality plus a position line by prefix compares it
 * exactly. A prefix call on the expected text, or an equality on a slice of the
 * actual text, stays a gap. When no comparison of the literal can be placed,
 * the earlier function-level rule applies (any prefix API in the function or a
 * helper it calls). A literal every occurrence compares only by prefix is a
 * gap; one exact comparison anywhere clears it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';

export interface ExactTextGap {
  /** The request literal's fixed text (before its first `<placeholder>`). */
  literal: string;
  file: string;
  /** The test function that holds the literal. */
  test: string;
  /** The prefix / contains API or the helper that wraps one. */
  via: string;
  /** The line of the literal's own row (old-PoS run 40: the Why names the row compared by prefix). */
  line?: number;
}

const TEST_FILE = /(?:_test\.go|\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|(?:^|\/)test_[^/]+\.py|_test\.py|_spec\.rb|Tests?\.(?:java|cs|kt))$/;
/** A comparison that accepts a longer string: prefix, suffix, substring or pattern. */
const PREFIX_API = /\b(HasPrefix|HasSuffix|Contains|ContainsString|StartsWith|EndsWith|startsWith|endsWith|includes|toContain|toMatch|toMatchRegex|assertIn|assertRegex|assertStartsWith|startswith|endswith)\s*\(|\bassert\s+[^\n=]*\s+in\s+/;
/** A function / test block start (Go, Python, JS/TS, Ruby, Java-ish). */
const BLOCK = /^(?:func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(|\s{0,4}def\s+([A-Za-z_]\w*)\s*\(|(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(|(?:test|it|describe)\s*\(\s*['"`]([^'"`]{1,80})|\s{0,4}(?:public\s+|private\s+)?(?:void|async\s+Task)\s+([A-Za-z_]\w*)\s*\()/;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'func', 'function', 'def', 'catch', 'make', 'len', 'append', 'string', 'print', 'println']);
const MIN_LITERAL = 10;

function git(cwd: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }); } catch { return null; }
}

/** The request's backticked message literals, cut at the first `<placeholder>` (e.g. `file not found: path=`). */
export function requestExactLiterals(requestText: string): string[] {
  const out = new Set<string>();
  for (const match of requestText.matchAll(/`([^`\n]+)`/g)) {
    const literal = match[1]!.trim();
    if (!/\s/.test(literal)) continue;
    const fixed = literal.split('<')[0]!.trim();
    if (fixed.length >= MIN_LITERAL && /[A-Za-z]{3}/.test(fixed)) out.add(fixed);
  }
  return [...out];
}

interface Block { name: string; start: number; end: number; text: string }

/** Top-level function / test blocks of a file (1-based inclusive line ranges). */
function blocksOf(text: string): Block[] {
  const lines = text.split('\n');
  const starts: Array<{ name: string; start: number }> = [];
  lines.forEach((line, index) => {
    const match = line.match(BLOCK);
    if (match) starts.push({ name: (match.slice(1).find(Boolean) ?? 'test').trim(), start: index + 1 });
  });
  return starts.map((entry, index) => {
    const end = index + 1 < starts.length ? starts[index + 1]!.start - 1 : lines.length;
    return { name: entry.name, start: entry.start, end, text: lines.slice(entry.start - 1, end).join('\n') };
  });
}

/** Added line numbers (new side) per changed file. */
function addedLines(gitCwd: string, base: string, head: string, file: string): Set<number> {
  const out = new Set<number>();
  for (const match of (git(gitCwd, ['diff', '-U0', '--no-color', base, head, '--', file]) ?? '').matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let line = start; line < start + count; line += 1) out.add(line);
  }
  return out;
}

/** The prefix / contains comparison a block uses, directly or through a helper (`null`: none). The block-level fallback. */
function prefixVia(block: Block, helpers: ReadonlyMap<string, string>): string | null {
  const direct = block.text.match(PREFIX_API);
  if (direct) return direct[1] ?? 'in';
  for (const match of block.text.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = match[1]!;
    if (name === block.name || KEYWORDS.has(name)) continue;
    const body = helpers.get(name);
    if (body && PREFIX_API.test(body)) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Operand-level attribution (old-PoS run 40 N2, run 38 §3).
//
// A prefix / contains call is a gap only when one of its operands IS the
// expected text: the request literal itself, or a value that carries it (a
// variable assigned it, the table row field / loop variable that holds it, a
// helper parameter the call passes it to). A helper that compares the expected
// text with equality and additionally checks a suffix / position line with a
// prefix API compares the literal exactly. Row level: when one test function
// compares some rows exactly and others by prefix, the literal's own row
// decides (its table's loop, its wrapper type's branch, its keyed field).
// Anything the analysis cannot place falls back to the block-level rule above.

type SiteKind = 'exact' | 'prefix';
interface Site { kind: SiteKind; line: number; via: string }
/** What carries the expected text: identifiers (`want`, a loop variable), a field (`.want` / `["want"]`), the literal itself. */
interface Seeds { names: Set<string>; fields: Set<string>; literal: string }

const PREFIX_CALL = /(?:^|[^\w$])(HasPrefix|HasSuffix|Contains|ContainsString|StartsWith|EndsWith|startsWith|endsWith|includes|toContain|toMatch|toMatchRegex|assertIn|assertRegex|assertStartsWith|startswith|endswith)\s*\(/g;
const EXACT_CALL = /(?:^|[^\w$])(Equal|Equals|DeepEqual|EqualValues|assertEqual|assertEquals|assert_equal|toBe|toEqual|toStrictEqual|strictEqual|deepStrictEqual|deepEqual|Diff)\s*\(/g;
const EQUALITY = /===|!==|==|!=/g;
/** A comparison operand that is a cut of the text (a slice): comparing it with equality checks a part only. */
const SLICE_OPERAND = /\[[^\]]*:[^\]]*\]|\.(?:slice|substring|substr)\s*\(\s*0\b/;
/**
 * Old-PoS run 43 (§3.3): other cuts of the text whose remainder is discarded:
 * one indexed part of a split (`strings.SplitN(x, sep, 2)[0]`, `x.split(sep)[0]`,
 * `x.splitlines()[0]`, `x.partition(sep)[0]`) and a first-line helper call. A
 * split kept whole in a variable is judged at its use (splitCuts): its other
 * parts may be checked too.
 */
const CUT_OPERAND = /\b(?:Split|SplitN|SplitAfter|SplitAfterN|Fields|split|rsplit|splitlines|partition|rpartition|lines)\s*\([^]*\)\s*\[\s*[\w$]+\s*\]|\b(?:first_?[Ll]ine|First[Ll]ine|head_?[Ll]ine|Head[Ll]ine)\s*\(/;
/** The value of an assignment is a whole split (its parts are indexed later). */
const SPLIT_VALUE = /^\s*(?:[\w$]+\.)*(?:Split|SplitN|SplitAfter|SplitAfterN|Fields|split|rsplit|splitlines)\s*\([^]*\)\s*$/;
/**
 * Old-PoS run 44 (F-020): a call of a same-file / same-directory test helper whose
 * body returns a cut of its parameter (`return msg[:i]`, a split part, a Cut
 * head), whatever the helper is called: the whole operand is that call.
 */
const helperCutCall = (masked: string, helperCuts: ReadonlySet<string>): string | null => {
  if (!helperCuts.size) return null;
  const text = masked.trim();
  const call = /^(?:[\w$]+\.)?([A-Za-z_$][\w$]*)\s*\(/.exec(text);
  if (!call || !helperCuts.has(call[1]!)) return null;
  return matchClose(text, call[0].length - 1) === text.length - 1 ? call[1]! : null;
};
const isCut = (masked: string, cuts: ReadonlySet<string>, helperCuts: ReadonlySet<string> = new Set()): boolean => {
  if (SLICE_OPERAND.test(masked) || CUT_OPERAND.test(masked)) return true;
  const bare = masked.trim().replace(/^(?:string|String|str)\s*\(\s*([\s\S]*?)\s*\)$/, '$1');
  return cuts.has(bare) || helperCutCall(bare, helperCuts) !== null;
};
/** The Why of a cut comparison: a slice keeps its old wording; any other cut names itself. */
const cutVia = (masked: string, cuts: ReadonlySet<string>, helperCuts: ReadonlySet<string> = new Set()): string => {
  const helper = helperCutCall(masked.trim().replace(/^(?:string|String|str)\s*\(\s*([\s\S]*?)\s*\)$/, '$1'), helperCuts);
  if (helper && !SLICE_OPERAND.test(masked) && !CUT_OPERAND.test(masked)) return `${helper} (a test helper that returns a cut of its argument)`;
  return SLICE_OPERAND.test(masked) && !CUT_OPERAND.test(masked) && !cuts.has(masked.trim()) ? 'a slice of the text' : 'a cut of the text (one part of a split / first line)';
};

/**
 * Names that hold a cut of a text: assigned an indexed split, a slice or a
 * first-line helper result; the head of `head, _, _ := strings.Cut(..)` (tail
 * discarded); `parts[i]` of a whole split `parts` whose block reads no other
 * part and not its length (the run 40 exact-first-line-plus-position shape
 * reads both, so it stays exact).
 */
function cutNames(lines: readonly string[], masks: readonly string[], helperCuts: ReadonlySet<string> = new Set()): Set<string> {
  const cuts = new Set<string>();
  const block = masks.join('\n');
  masks.forEach((masked, index) => {
    const head = /^\s*([A-Za-z_$][\w$]*)\s*,\s*_\s*(?:,\s*[\w$]+\s*)?:?=\s*(?:[\w$]+\.)*Cut\s*\(/.exec(masked);
    if (head) { cuts.add(head[1]!); return; }
    const assigned = assignment(lines[index]!, masked);
    if (!assigned || assigned.names.length !== 1) return;
    const name = assigned.names[0]!;
    if (isCut(assigned.masked, cuts, helperCuts)) { cuts.add(name); return; }
    if (!SPLIT_VALUE.test(assigned.masked)) return;
    const uses = [...block.matchAll(new RegExp(`(?<![\\w$.])${escapeRe(name)}(?![\\w$])(\\s*\\[\\s*([^\\]]*)\\])?`, 'g'))].slice(1);
    const indexes = new Set(uses.map(use => use[2]?.trim() ?? '*'));
    if (indexes.size === 1 && !indexes.has('*')) cuts.add(`${name}[${[...indexes][0]}]`);
  });
  return cuts;
}
const TRIVIAL_OPERAND = /^(?:nil|null|None|undefined|true|false|True|False|-?\d+(?:\.\d+)?|""|''|``|\[\]|\{\})$/;
/** Calls whose result is their argument's text (conversions), not a computed output. */
const CONVERSIONS = new Set(['string', 'String', 'str', 'bytes', 'toString', 'Text', 'text']);

/** Mask string / char literal contents (same length, quotes kept) and line comments, so structure scans skip them. */
function maskLine(line: string): string {
  let out = '';
  let quote = '';
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at]!;
    if (quote) {
      if (char === '\\' && quote !== '`' && at + 1 < line.length) { out += '__'; at += 1; continue; }
      if (char === quote) { quote = ''; out += char; continue; }
      out += '_';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; out += char; continue; }
    if (char === '/' && line[at + 1] === '/') return out + ' '.repeat(line.length - at);
    if (char === '#' && /^\s*$/.test(line.slice(0, at))) return out + ' '.repeat(line.length - at);
    out += char;
  }
  return out;
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Index of the bracket matching the opener at `at` in masked text (or -1). */
function matchClose(masked: string, at: number): number {
  const open = masked[at]!;
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  for (let cursor = at; cursor < masked.length; cursor += 1) {
    if (masked[cursor] === open) depth += 1;
    else if (masked[cursor] === close) { depth -= 1; if (depth === 0) return cursor; }
  }
  return -1;
}

function matchOpen(masked: string, at: number): number {
  const close = masked[at]!;
  const open = close === ')' ? '(' : close === ']' ? '[' : '{';
  let depth = 0;
  for (let cursor = at; cursor >= 0; cursor -= 1) {
    if (masked[cursor] === close) depth += 1;
    else if (masked[cursor] === open) { depth -= 1; if (depth === 0) return cursor; }
  }
  return -1;
}

/** Top-level comma-separated parts of a masked argument list, as [start, end) ranges. */
function splitTop(masked: string, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let from = start;
  for (let at = start; at < end; at += 1) {
    const char = masked[at]!;
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) { out.push([from, at]); from = at + 1; }
  }
  if (masked.slice(from, end).trim()) out.push([from, end]);
  return out;
}

const OPERAND_CHAR = /[\w$.'"`]/;

/** The operand ending right before `at` (an expression of names, members, calls, indexes, literals). */
function operandBefore(masked: string, at: number): [number, number] {
  let end = at;
  while (end > 0 && masked[end - 1] === ' ') end -= 1;
  let cursor = end - 1;
  while (cursor >= 0) {
    const char = masked[cursor]!;
    if (char === ')' || char === ']') { const open = matchOpen(masked, cursor); if (open < 0) break; cursor = open - 1; continue; }
    if (char === '*' || char === '&') { if (cursor === 0 || !OPERAND_CHAR.test(masked[cursor - 1]!)) { cursor -= 1; break; } }
    if (!OPERAND_CHAR.test(char)) break;
    cursor -= 1;
  }
  return [cursor + 1, end];
}

/** The operand starting right after `at`. */
function operandAfter(masked: string, at: number): [number, number] {
  let start = at;
  while (start < masked.length && masked[start] === ' ') start += 1;
  let cursor = start;
  while (cursor < masked.length && (masked[cursor] === '*' || masked[cursor] === '&' || masked[cursor] === '!')) cursor += 1;
  while (cursor < masked.length) {
    const char = masked[cursor]!;
    if (char === '(' || char === '[') { const close = matchClose(masked, cursor); if (close < 0) break; cursor = close + 1; continue; }
    if (!OPERAND_CHAR.test(char)) break;
    cursor += 1;
  }
  return [start, cursor];
}

/**
 * The value text of an expression: argument lists of calls are dropped (a call
 * result is computed from, not equal to, its argument), conversions are
 * unwrapped. `run(tt.input)` -> `run()`, `string(want)` -> `want`,
 * `err.Error()` -> `err.Error()`.
 */
function valueText(raw: string, masked: string): string {
  let text = raw;
  let mask = masked;
  for (let guard = 0; guard < 50; guard += 1) {
    const call = /([\w$.]*)\(([^()]*)\)/.exec(mask);
    if (!call) break;
    const callee = call[1]!.split('.').at(-1)!;
    const inner = text.slice(call.index + call[1]!.length + 1, call.index + call[0].length - 1);
    const innerMask = mask.slice(call.index + call[1]!.length + 1, call.index + call[0].length - 1);
    const conversion = (CONVERSIONS.has(callee) && call[1] === callee) || call[1] === '';
    const keep = conversion ? inner : '';
    const keepMask = conversion ? innerMask : '';
    const replaceText = conversion ? `${call[1]}\u0001${keep}\u0002` : `${call[1]}\u0001\u0002`;
    const replaceMask = conversion ? `${call[1]}\u0001${keepMask}\u0002` : `${call[1]}\u0001\u0002`;
    text = text.slice(0, call.index) + replaceText + text.slice(call.index + call[0].length);
    mask = mask.slice(0, call.index) + replaceMask + mask.slice(call.index + call[0].length);
  }
  return text;
}

/** Whether an expression's value carries the expected text (a call's arguments do not, a conversion's do). */
function carries(raw: string, masked: string, seeds: Seeds): boolean {
  if (seeds.literal && raw.includes(seeds.literal)) return true;
  const valueMask = maskLine(valueText(raw, masked));
  for (const name of seeds.names) if (new RegExp(`(?<![\\w$.])${escapeRe(name)}(?![\\w$])`).test(valueMask)) return true;
  for (const field of seeds.fields) {
    if (new RegExp(`\\.${escapeRe(field)}(?![\\w$])`).test(valueMask) || new RegExp(`\\[\\s*["']${escapeRe(field)}["']\\s*\\]`).test(raw)) return true;
  }
  return false;
}

/** Names a line assigns (`x := ...`, `x, ok := ...`, `const x = ...`, `x = ...`, `switch x := ...`), with the value text. */
function assignment(line: string, masked: string): { names: string[]; raw: string; masked: string } | null {
  const match = /^\s*(?:(?:if|switch|for)\s+)?(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*(?::[^=]+)?(?<![=!<>:])(?::=|=)(?!=)\s*/.exec(masked);
  if (!match) return null;
  const at = match[0].length;
  const end = (() => { const semi = masked.indexOf(';', at); return semi < 0 ? masked.length : semi; })();
  return { names: match[1]!.split(',').map(name => name.trim()).filter(name => name !== '_'), raw: line.slice(at, end), masked: masked.slice(at, end) };
}

/** Propagate the seeds through assignments in order (two passes: loop bodies may read later lines). */
function propagate(lines: readonly string[], masks: readonly string[], seeds: Seeds): Seeds {
  const names = new Set(seeds.names);
  const out: Seeds = { names, fields: seeds.fields, literal: seeds.literal };
  for (let pass = 0; pass < 2; pass += 1) {
    lines.forEach((line, index) => {
      const assigned = assignment(line, masks[index]!);
      if (assigned && carries(assigned.raw, assigned.masked, out)) for (const name of assigned.names) names.add(name);
    });
  }
  return out;
}

/** Parameter names of a helper block's signature. */
function parametersOf(block: Block): string[] {
  const first = block.text.split('\n').slice(0, 3).join(' ');
  const masked = maskLine(first);
  const at = masked.search(new RegExp(`\\b${escapeRe(block.name)}\\s*\\(`));
  if (at < 0) return [];
  const open = masked.indexOf('(', at);
  const close = matchClose(masked, open);
  if (close < 0) return [];
  return splitTop(masked, open + 1, close).map(([from, to]) => masked.slice(from, to).trim().match(/^\.{0,3}([A-Za-z_$][\w$]*)/)?.[1] ?? '').filter(Boolean);
}

/**
 * Old-PoS run 44 (F-020): helpers (test blocks of the changed files' directories)
 * whose body returns a cut of one of its parameters: a slice / split part /
 * first-line cut of the parameter, or a name holding such a cut (a Cut head).
 * A helper returning its whole parameter (trimmed, converted) is not one.
 */
const helperCutsCache = new WeakMap<ReadonlyMap<string, string>, ReadonlySet<string>>();
function cutHelpersOf(helpers: ReadonlyMap<string, string>): ReadonlySet<string> {
  const cached = helperCutsCache.get(helpers);
  if (cached) return cached;
  const out = new Set<string>();
  for (const [name, body] of helpers) {
    const params = parametersOf({ name, start: 1, end: 1, text: body });
    if (!params.length) continue;
    const lines = body.split('\n');
    const masks = lines.map(maskLine);
    const cuts = cutNames(lines, masks);
    const mentionsParam = (masked: string): boolean => params.some(param => new RegExp(`(?<![\\w$.])${escapeRe(param)}(?![\\w$])`).test(masked));
    if (masks.some(masked => [...masked.matchAll(/\breturn\s+([^;{}]+?)\s*(?:[;}]|$)/g)].some(match => {
      const value = match[1]!;
      return (SLICE_OPERAND.test(value) || CUT_OPERAND.test(value)) ? mentionsParam(value) : cuts.has(value.trim());
    }))) out.add(name);
  }
  helperCutsCache.set(helpers, out);
  return out;
}

/** Comparison sites of a text whose operand carries the expected text; helpers are followed `depth` levels. */
function sitesOf(text: string, seeds: Seeds, helpers: ReadonlyMap<string, string>, self: string, depth: number): Site[] {
  const lines = text.split('\n');
  const masks = lines.map(maskLine);
  const live = propagate(lines, masks, seeds);
  const helperCuts = cutHelpersOf(helpers);
  const cuts = cutNames(lines, masks, helperCuts);
  const sites: Site[] = [];
  lines.forEach((line, index) => {
    const masked = masks[index]!;
    const carried = (range: [number, number]): boolean => range[1] > range[0] && carries(line.slice(...range), masked.slice(...range), live);
    for (const match of masked.matchAll(PREFIX_CALL)) {
      const open = match.index! + match[0].length - 1;
      const close = matchClose(masked, open);
      if (close < 0) continue;
      const start = match.index! + match[0].indexOf(match[1]!);
      const receiver = start > 0 && masked[start - 1] === '.' ? operandBefore(masked, start - 1) : null;
      if (splitTop(masked, open + 1, close).some(carried) || (receiver && carried(receiver))) sites.push({ kind: 'prefix', line: index, via: match[1]! });
    }
    const pyIn = /\bassert\s+(.+?)\s+(?:not\s+)?in\s+(.+)$/.exec(masked);
    if (pyIn && (carried([pyIn.index + pyIn[0].indexOf(pyIn[1]!), pyIn.index + pyIn[0].indexOf(pyIn[1]!) + pyIn[1]!.length])
      || carried([masked.length - pyIn[2]!.length, masked.length]))) sites.push({ kind: 'prefix', line: index, via: 'in' });
    for (const match of masked.matchAll(EXACT_CALL)) {
      const open = match.index! + match[0].length - 1;
      const close = matchClose(masked, open);
      if (close < 0) continue;
      const args = splitTop(masked, open + 1, close);
      if (!args.some(carried)) continue;
      // `expect(<actual>).toBe(<expected>)`: the actual side is the receiver chain's own argument.
      const start = match.index! + match[0].indexOf(match[1]!);
      const receiver = start > 0 && masked[start - 1] === '.' ? operandBefore(masked, start - 1) : null;
      const sliced = [...args, ...(receiver ? [receiver] : [])].find(range => isCut(masked.slice(...range), cuts, helperCuts));
      sites.push({ kind: sliced ? 'prefix' : 'exact', line: index, via: sliced ? cutVia(masked.slice(...sliced), cuts, helperCuts) : match[1]! });
    }
    for (const match of masked.matchAll(EQUALITY)) {
      const left = operandBefore(masked, match.index!);
      const right = operandAfter(masked, match.index! + match[0].length);
      const [l, r] = [masked.slice(...left).trim(), masked.slice(...right).trim()];
      if (!l || !r || TRIVIAL_OPERAND.test(l) || TRIVIAL_OPERAND.test(r)) continue;
      if (!carried(left) && !carried(right)) continue;
      const sliced = isCut(l, cuts, helperCuts) ? l : isCut(r, cuts, helperCuts) ? r : null;
      sites.push({ kind: sliced ? 'prefix' : 'exact', line: index, via: sliced ? cutVia(sliced, cuts, helperCuts) : match[0] });
    }
    if (depth <= 0) return;
    for (const match of masked.matchAll(/(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = match[1]!;
      if (name === self || KEYWORDS.has(name)) continue;
      const body = helpers.get(name);
      if (!body) continue;
      const open = match.index! + match[0].length - 1;
      const close = matchClose(masked, open);
      if (close < 0) continue;
      const args = splitTop(masked, open + 1, close);
      const carrying = args.map(carried);
      if (!carrying.some(Boolean)) continue;
      const helper = { name, start: 1, end: 1, text: body };
      let params = parametersOf(helper);
      if (params.length === args.length + 1 && /^(?:self|this|cls)$/.test(params[0]!)) params = params.slice(1);
      const seeded = params.filter((_, at) => carrying[at]);
      const inner = seeded.length ? sitesOf(body.split('\n').slice(1).join('\n'), { names: new Set(seeded), fields: new Set(), literal: live.literal }, helpers, name, depth - 1) : [];
      // A helper the analysis cannot read keeps the block-level rule: a prefix API in its body is a prefix comparison.
      const kind: SiteKind | null = inner.some(site => site.kind === 'prefix') ? 'prefix'
        : inner.some(site => site.kind === 'exact') ? 'exact'
        : PREFIX_API.test(body) ? 'prefix' : null;
      if (kind) sites.push({ kind, line: index, via: name });
    }
  });
  return sites;
}

/** Bracket depth change of a masked line. */
const depthOf = (masked: string): number => [...masked].reduce((sum, char) => sum + ('([{'.includes(char) ? 1 : ')]}'.includes(char) ? -1 : 0), 0);
const indentOf = (line: string): number => line.match(/^\s*/)![0].length;

/** Line ranges [from, to] (block-relative, inclusive) of a statement that opens at `start`: its braces, else its indentation. */
function regionFrom(lines: readonly string[], masks: readonly string[], start: number): [number, number] {
  if (/[{(]\s*$/.test(masks[start]!.trimEnd())) {
    let depth = 0;
    for (let at = start; at < lines.length; at += 1) {
      depth += depthOf(masks[at]!);
      if (at > start && depth <= 0) return [start, at];
    }
    return [start, lines.length - 1];
  }
  const base = indentOf(lines[start]!);
  let end = start;
  for (let at = start + 1; at < lines.length; at += 1) {
    if (!lines[at]!.trim()) continue;
    if (indentOf(lines[at]!) <= base) break;
    end = at;
  }
  return [start, end];
}

/**
 * The table a literal row belongs to: the variable assigned a composite that is
 * still open at the literal (bracket depth > 0 at the end of every line from the
 * assignment to the row, and at the literal itself), or null.
 */
function enclosingTable(lines: readonly string[], masks: readonly string[], row: number, column: number): string | null {
  for (let at = row; at >= 0; at -= 1) {
    const assigned = /^\s*(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=]+)?(?::=|=)(?!=)/.exec(masks[at]!);
    if (!assigned) continue;
    let depth = 0;
    let open = true;
    for (let cursor = at; cursor <= row && open; cursor += 1) {
      const text = cursor === row ? masks[row]!.slice(cursor === at ? assigned[0].length : 0, column) : masks[cursor]!.slice(cursor === at ? assigned[0].length : 0);
      depth += depthOf(text);
      if (depth <= 0) open = false;
    }
    if (open) return assigned[1]!;
    if (at < row) return null;
  }
  return null;
}

/** Loops over a table: their regions and loop variables. */
function tableLoops(lines: readonly string[], masks: readonly string[], table: string): Array<{ region: [number, number]; vars: string[] }> {
  const name = escapeRe(table);
  const loops: Array<{ region: [number, number]; vars: string[] }> = [];
  masks.forEach((masked, at) => {
    const go = new RegExp(`\\bfor\\s+(?:([A-Za-z_]\\w*)\\s*,\\s*)?([A-Za-z_]\\w*)\\s*:?=\\s*range\\s+${name}\\b`).exec(masked);
    const js = new RegExp(`\\bfor\\s*\\(\\s*(?:const|let|var)\\s+(?:\\[([^\\]]*)\\]|([A-Za-z_$][\\w$]*))\\s+of\\s+${name}\\b`).exec(masked);
    const py = new RegExp(`\\bfor\\s+([A-Za-z_][\\w\\s,]*?)\\s+in\\s+(?:enumerate\\()?${name}\\b`).exec(masked);
    const each = new RegExp(`\\b${name}\\.(?:forEach|map|each)\\s*\\(\\s*(?:(?:async\\s+)?function\\s*)?\\(?\\s*([A-Za-z_$][\\w$]*)`).exec(masked);
    const vars = go ? [go[2]!] : js ? (js[1] ?? js[2] ?? '').split(',').map(part => part.trim()) : py ? py[1]!.split(',').map(part => part.trim()) : each ? [each[1]!] : null;
    if (vars) loops.push({ region: regionFrom(lines, masks, at), vars: vars.filter(Boolean) });
  });
  return loops;
}

/** Branch regions guarded by a wrapper type (`case T:`, `.(T)`, `instanceof T`, `isinstance(x, T)`). */
function typeBranches(lines: readonly string[], masks: readonly string[], type: string): Array<[number, number]> {
  const name = escapeRe(type);
  const guard = new RegExp(`\\bcase\\b[^:]*\\b${name}\\b[^:]*:|\\.\\(\\s*\\*?(?:[\\w$]+\\.)?${name}\\s*\\)|\\binstanceof\\s+${name}\\b|\\bisinstance\\([^,]+,\\s*\\(?[^)]*\\b${name}\\b`);
  const out: Array<[number, number]> = [];
  masks.forEach((masked, at) => {
    if (!guard.test(masked)) return;
    if (/\bcase\b/.test(masked) && !/[{]\s*$/.test(masked.trimEnd())) {
      const base = indentOf(lines[at]!);
      let end = at;
      for (let next = at + 1; next < lines.length; next += 1) {
        if (!lines[next]!.trim()) continue;
        if (indentOf(lines[next]!) < base || (indentOf(lines[next]!) === base && /^\s*(?:case\b|default\b|\})/.test(masks[next]!))) break;
        end = next;
      }
      out.push([at, end]);
    } else out.push(regionFrom(lines, masks, at));
  });
  return out;
}

type Verdict = { kind: SiteKind; via: string } | null;

/** exact when only exact sites, prefix when only prefix sites; null when both or none. */
function verdictOf(sites: readonly Site[]): Verdict | 'both' {
  const prefix = sites.find(site => site.kind === 'prefix');
  const exact = sites.find(site => site.kind === 'exact');
  if (prefix && exact) return 'both';
  if (prefix) return { kind: 'prefix', via: prefix.via };
  if (exact) return { kind: 'exact', via: exact.via };
  return null;
}

/**
 * How one occurrence of a literal (block-relative line / column) is compared:
 * exact, prefix (with the API or helper), or null when no comparison of it is
 * found (the caller applies the block-level rule).
 */
function occurrenceVerdict(block: Block, row: number, column: number, literal: string, helpers: ReadonlyMap<string, string>): Verdict {
  const lines = block.text.split('\n');
  const masks = lines.map(maskLine);
  const before = lines[row]!.slice(0, column);
  const field = /([A-Za-z_$][\w$]*)["']?\s*[:=]\s*(?:[A-Za-z_$][\w$.]*\s*[({]\s*)?["'`]$/.exec(before)?.[1] ?? null;
  const wrapper = /([A-Za-z_$][\w$]*)\s*[({]\s*["'`]$/.exec(before)?.[1] ?? null;
  const table = enclosingTable(lines, masks, row, column);
  const loops = table ? tableLoops(lines, masks, table) : [];
  const names = new Set<string>();
  const fields = new Set<string>();
  if (table) {
    if (field) fields.add(field);
    else { names.add(table); for (const loop of loops) for (const name of loop.vars) names.add(name); }
  } else {
    const assigned = assignment(lines[row]!, masks[row]!);
    if (assigned) for (const name of assigned.names) names.add(name);
  }
  const sites = sitesOf(block.text, { names, fields, literal }, helpers, block.name, 2);
  let scope = sites;
  if (table && loops.length) {
    const inLoops = sites.filter(site => loops.some(loop => site.line >= loop.region[0] && site.line <= loop.region[1]));
    if (inLoops.length) scope = inLoops;
  }
  const first = verdictOf(scope);
  if (first !== 'both') return first;
  if (wrapper && !(field && wrapper === field)) {
    const branches = typeBranches(lines, masks, wrapper);
    const inBranch = scope.filter(site => branches.some(([from, to]) => site.line >= from && site.line <= to));
    const second = verdictOf(inBranch);
    if (second && second !== 'both') return second;
  }
  const prefix = scope.find(site => site.kind === 'prefix')!;
  return { kind: 'prefix', via: prefix.via };
}

/**
 * Request literals the Story's added tests compare only by prefix / contains.
 * Empty when the request quotes no message literal or no test changed.
 */
export function exactTextPrefixAssertions(args: { gitCwd: string; base: string; head?: string; requestText: string }): ExactTextGap[] {
  const literals = requestExactLiterals(args.requestText);
  if (!literals.length) return [];
  const head = args.head ?? 'HEAD';
  const changed = (git(args.gitCwd, ['diff', '--name-only', '--diff-filter=AM', '--no-renames', args.base, head]) ?? '').split('\n').filter(file => TEST_FILE.test(file)).slice(0, 200);
  if (!changed.length) return [];
  const show = (file: string) => git(args.gitCwd, ['show', `${head}:${file}`]) ?? '';
  // Helpers: every block of the test files in the changed files' directories at HEAD.
  const helpers = new Map<string, string>();
  const dirs = [...new Set(changed.map(file => posix.dirname(file)))];
  for (const dir of dirs) {
    const listed = (git(args.gitCwd, ['ls-tree', '--name-only', `${head}:${dir === '.' ? '' : dir}`]) ?? '').split('\n').filter(Boolean)
      .map(name => (dir === '.' ? name : `${dir}/${name}`)).filter(file => TEST_FILE.test(file)).slice(0, 200);
    for (const file of listed) for (const block of blocksOf(show(file))) if (!helpers.has(block.name)) helpers.set(block.name, block.text);
  }
  const gaps: ExactTextGap[] = [];
  const exact = new Set<string>();
  for (const file of changed) {
    const added = addedLines(args.gitCwd, args.base, head, file);
    for (const block of blocksOf(show(file))) {
      if (![...added].some(line => line >= block.start && line <= block.end)) continue;
      const held = literals.filter(literal => block.text.includes(literal));
      if (!held.length) continue;
      const fallback = prefixVia(block, helpers);
      const lines = block.text.split('\n');
      for (const literal of held) {
        lines.forEach((text, row) => {
          for (let column = text.indexOf(literal); column >= 0; column = text.indexOf(literal, column + literal.length)) {
            const verdict = occurrenceVerdict(block, row, column, literal, helpers) ?? (fallback ? { kind: 'prefix' as const, via: fallback } : { kind: 'exact' as const, via: '' });
            if (verdict.kind === 'exact') exact.add(literal);
            else gaps.push({ literal, file, test: block.name, via: verdict.via, line: block.start + row });
          }
        });
      }
    }
  }
  const seen = new Set<string>();
  return gaps.filter(gap => !exact.has(gap.literal) && !seen.has(gap.literal) && (seen.add(gap.literal), true));
}

/** The item whose userSees or intent rows state the literal (the item to reopen), if any. */
export function exactRequestLiteralItem<T extends { userSees?: unknown; verificationIntent?: { happy?: Array<{ desc?: unknown }>; edge?: Array<{ desc?: unknown }>; adversarial?: Array<{ desc?: unknown }> } }>(items: readonly T[], literal: string): T | null {
  return items.find(item => [item.userSees, ...(['happy', 'edge', 'adversarial'] as const).flatMap(lane => (item.verificationIntent?.[lane] ?? []).map(row => row.desc))]
    .some(text => typeof text === 'string' && text.includes(literal))) ?? null;
}

// The accepted wording stays the strict form (full-string equality, no prefix helper) although the gate also
// clears a helper whose prefix check covers only another part: guidance never loosens with the gate (old-PoS run 40).
export const describeExactTextGap = (gap: ExactTextGap): string =>
  `\`${gap.literal}...\` (row at ${gap.file}${gap.line ? `:${gap.line}` : ''}) in ${gap.test} is compared only through ${gap.via} (a prefix / contains comparison applied to that expected text); accepted: a full-string equality of the whole message in that test (==, Equal / Equals / DeepEqual, toBe / toEqual, assertEqual), directly or through a helper whose body uses no prefix / contains API`;

// ---------------------------------------------------------------------------
// Once-per-gap-set state (runtime): the item reopened for a set, and when.

export interface ExactTextState { key: string; itemId: string; flaggedAt: string; gaps: ExactTextGap[] }

export function exactTextStatePath(root: string, storyId: string): string {
  return join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'exact-text', `${storyId}.json`);
}

export function readExactTextState(root: string, storyId: string): ExactTextState | null {
  try { return JSON.parse(readFileSync(exactTextStatePath(root, storyId), 'utf8')) as ExactTextState; } catch { return null; }
}

export function writeExactTextState(root: string, storyId: string, state: ExactTextState): void {
  const path = exactTextStatePath(root, storyId);
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(state, null, 1)}\n`); } catch { /* runtime evidence; recomputed */ }
}

export const exactTextKeyOf = (gaps: readonly ExactTextGap[]): string => gaps.map(gap => `${gap.literal}@${gap.file}:${gap.test}`).sort().join('|');

/** Relaunch prompt lines for the item reopened for exact-text gaps. */
export function renderExactTextRelaunch(root: string, storyId: string, itemId: string): string[] {
  const state = readExactTextState(root, storyId);
  if (!state || state.itemId !== itemId || !state.gaps.length) return [];
  return ['- Reopened before REVIEW: request-quoted exact strings your tests compare only by prefix / contains (the row named below is compared that way). Add an exact (full-string equality) assertion of each; a reused project helper that compares by prefix does not count:',
    ...state.gaps.slice(0, 10).map(gap => `  ${describeExactTextGap(gap)}`)];
}

/**
 * Lab round-cut N3b (bench-staging/oldpos/run74-75-analysis.md §7 N3b): the exact-text gate reopened an
 * implementer run once per run (runs 74/75: 3 of 3; 1.1-1.9 min each) because a request literal was
 * asserted only through a cut or a prefix. The implementer and finding-repair prompts now carry the
 * request's exact-text literals (the same `requestExactLiterals` the gate checks) with the whole-text
 * rule at launch, instead of learning it from the reopen. Prompt only; the gate is unchanged.
 */
export function renderRequestExactLiterals(requestText: string | null | undefined, max = 10): string[] {
  const literals = requestText ? requestExactLiterals(requestText) : [];
  if (!literals.length) return [];
  return [
    'Request exact-text literals (the exact-text gate checks each before REVIEW): wherever a test of yours asserts one of these messages, compare the WHOLE message with full-string equality (==, Equal / DeepEqual, toBe / toEqual, assertEqual), never through HasPrefix / Contains / startsWith / a cut of the actual text or a helper that wraps one; the `<placeholder>` part is the runtime value:',
    ...literals.slice(0, max).map(literal => `  - \`${literal}\``),
    ...(literals.length > max ? [`  - ${literals.length - max} more in request.md`] : []),
  ];
}
