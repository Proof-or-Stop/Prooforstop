/**
 * Lab run110 (bench-staging/oldpos/run110-analysis.md §4 gap 3, §6 fix 3): to prove "the docs stay unchanged" for the
 * scope findings F-014..F-017, a repair added `TestSliceDocsRemainAtStoryBaseScope`, a test that sha256-pinned the stale,
 * out-of-scope docs. That turned a scope rule into an executable oracle: the next docs-drift repair broke it, the
 * resolved findings' covering verification failed, and the framework generated "repair broke resolved finding" findings
 * (F-022..F-024, F-026, F-027) for two more rounds.
 *
 * A test a managed writer adds is a behaviour check. One that reads a file OUTSIDE the scope contract's allowed lists
 * (an excluded / protected path, a documentation file the contract does not list, any other unlisted path) and pins its
 * bytes (a hash: sha*, md5, checksum, `.Sum*(`, createHash, hashlib) or its git state (`git diff|show|status|log|
 * hash-object|ls-files`) is refused: the framework's scope gate checks scope, a test never does. Reading such a file
 * without a pin (a doc-example test) is not flagged.
 *
 * Consumers: managedWriterScopeViolations (the same writer session gets ONE turn to remove it, rule
 * out_of_scope_pin_test) and the finding-repair acceptance (handlers/next-driver.ts repairRunTestProblem: a run whose
 * commits add one is not an accepted repair; the relaunch prompt carries the reason and its one next action).
 */
import { execFileSync } from 'node:child_process';
import { isTestPath } from './probe-text.js';
import { commitsDiffText } from './commits-diff-text.js';
import { classifyScopePath, normalizeScopePath } from './scope-path-classifier.js';
import type { ScopeContractData } from './types.js';

export const OUT_OF_SCOPE_PIN_TEST = 'out_of_scope_pin_test';

export interface OutOfScopePinTest {
  /** The test file the writer changed. */
  testFile: string;
  /** The out-of-scope file (or directory) it pins. */
  path: string;
  /** The added line that names it. */
  line: string;
  /** What pins it (the hash / git call seen in the added lines). */
  pin: string;
  /** The one next action. */
  nextAction: string;
}

const HASH_PIN = /\b(?:sha(?:1|224|256|384|512)\w*|md5\w*|checksum\w*|hashlib|createHash|hash-object|crc32\w*)\b|\.Sum(?:256|512|224|384)?\s*\(/i;
const GIT_PIN = /\bgit\b[^\n]{0,40}\b(?:diff|show|status|log|hash-object|ls-files|rev-parse)\b|["'`]git["'`]\s*,\s*["'`](?:diff|show|status|log|hash-object|ls-files)["'`]/i;
const STRING_LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`\n]*)`/g;
const JOIN_CALL = /\b(?:filepath\.Join|path\.Join|path\.join|os\.path\.join|Path)\s*\(([^()\n]*)\)/g;

function git(cwd: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

/** Added lines per test file in a unified diff. */
function addedTestLines(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { const path = line.slice(4).trim(); file = path === '/dev/null' ? null : path.replace(/^b\//, ''); continue; }
    if (line.startsWith('--- ') || line.startsWith('diff --git')) continue;
    if (!file || !isTestPath(file) || !line.startsWith('+')) continue;
    out.set(file, [...(out.get(file) ?? []), line.slice(1)]);
  }
  return out;
}

/** Repo-relative path candidates one added line names: string literals and joined literal segments, `..` resolved against the test's directory. */
function pathCandidates(testFile: string, line: string): string[] {
  const dir = testFile.split('/').slice(0, -1);
  const resolve = (raw: string): string | null => {
    const text = raw.trim();
    if (!text || /\s/.test(text) || text.length > 200 || /^[a-z]+:\/\//i.test(text)) return null;
    const parts = text.replace(/\\/g, '/').split('/').filter(Boolean);
    const relative = text.startsWith('..') || text.startsWith('./');
    const stack = relative ? [...dir] : [];
    for (const part of parts) {
      if (part === '.') continue;
      if (part === '..') { if (!stack.length) return null; stack.pop(); continue; }
      stack.push(part);
    }
    const out = normalizeScopePath(stack.join('/'));
    return out && out !== '.' ? out : null;
  };
  const literals = (text: string): string[] => [...text.matchAll(STRING_LITERAL)].map(match => match[1] ?? match[2] ?? match[3] ?? '');
  const out = new Set<string>();
  for (const join of line.matchAll(JOIN_CALL)) {
    const segments = literals(join[1]!);
    if (segments.length >= 2) { const joined = resolve(segments.join('/')); if (joined) out.add(joined); }
  }
  for (const literal of literals(line)) {
    if (!/[/.]/.test(literal)) continue;
    const resolved = resolve(literal);
    if (resolved) out.add(resolved);
  }
  return [...out];
}

const ALLOWED_SOURCES = new Set(['scope-contract.allowedModify', 'scope-contract.allowedCreate', 'scope-contract.allowedTest']);

/** Whether `path` (a file, or a directory whose every tracked file is) lies outside the contract's allowed lists. */
function outOfScope(gitCwd: string, contract: ScopeContractData, path: string): boolean | null {
  const files = (git(gitCwd, ['ls-files', '--', path]) ?? '').split('\n').map(row => row.trim()).filter(Boolean);
  if (!files.length) return null;
  return files.every(file => {
    const row = classifyScopePath(contract, file);
    return !(row.allowed && ALLOWED_SOURCES.has(String(row.source)));
  });
}

/**
 * The out-of-scope pin tests a writer added: over `commits` (oldest first; their own diffs) or, for a running writer,
 * over everything since `baseHead` (commits and the uncommitted work tree). Empty when no contract binds paths.
 */
export function outOfScopePinTests(args: { gitCwd: string; contract: ScopeContractData | null; commits?: readonly string[]; baseHead?: string }): OutOfScopePinTest[] {
  const contract = args.contract;
  if (!contract || ![contract.allowedModify, contract.allowedTest, contract.allowedCreate].some(paths => paths.length > 0)) return [];
  let diff = '';
  if (args.commits?.length) diff = commitsDiffText(args.gitCwd, args.commits);
  else if (args.baseHead) {
    diff = `${git(args.gitCwd, ['diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', `${args.baseHead}..HEAD`]) ?? ''}\n`
      + `${git(args.gitCwd, ['diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', 'HEAD']) ?? ''}`;
  }
  if (!diff.trim()) return [];
  const rows: OutOfScopePinTest[] = [];
  for (const [testFile, lines] of addedTestLines(diff)) {
    const text = lines.join('\n');
    const pin = text.match(HASH_PIN)?.[0] ?? text.match(GIT_PIN)?.[0];
    if (!pin) continue;
    const seen = new Set<string>();
    for (const line of lines) {
      for (const path of pathCandidates(testFile, line)) {
        if (seen.has(path) || path === testFile) continue;
        seen.add(path);
        if (outOfScope(args.gitCwd, contract, path) !== true) continue;
        rows.push({ testFile, path, line: line.trim().slice(0, 160), pin: pin.trim(),
          nextAction: `remove the test in ${testFile} that pins ${path} (${pin.trim()}): ${path} is outside the scope contract's allowed files, `
            + 'and scope is checked by the framework\'s scope gate, never by a test; keep the product fix and its behavioural tests' });
      }
    }
  }
  return rows;
}

/** The repair-acceptance refusal for a run whose commits add an out-of-scope pin test (null when none). */
export function outOfScopePinTestProblem(args: { gitCwd: string; commits: readonly string[]; contract: ScopeContractData | null }): string | null {
  const rows = outOfScopePinTests(args);
  if (!rows.length) return null;
  const first = rows[0]!;
  return `the repair adds a test that pins an out-of-scope file (${rows.map(row => `${row.testFile} -> ${row.path}`).join(', ')}; \`${first.line}\`): ${first.nextAction}`;
}
