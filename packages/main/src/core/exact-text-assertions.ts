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
 * changed (Story base..HEAD), and per test function that has added lines and
 * contains a literal: does it compare through a prefix / contains API, directly
 * or through a helper whose own body uses one (helpers are looked up in the
 * test files of the same directories at HEAD)? A literal every such function
 * compares only that way is a gap; one exact comparison anywhere clears it.
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

/** The prefix / contains comparison a block uses, directly or through a helper (`null`: none). */
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
      const via = prefixVia(block, helpers);
      for (const literal of held) {
        if (via) gaps.push({ literal, file, test: block.name, via });
        else exact.add(literal);
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

export const describeExactTextGap = (gap: ExactTextGap): string =>
  `\`${gap.literal}...\` in ${gap.file} ${gap.test} is compared only through ${gap.via} (a prefix / contains comparison); accepted: a full-string equality of the whole message in that test (==, Equal / Equals / DeepEqual, toBe / toEqual, assertEqual), directly or through a helper whose body uses no prefix / contains API`;

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
  return ['- Reopened before REVIEW: request-quoted exact strings your tests compare only by prefix / contains. Add an exact (full-string equality) assertion of each; a reused project helper that compares by prefix does not count:',
    ...state.gaps.slice(0, 10).map(gap => `  ${describeExactTextGap(gap)}`)];
}
