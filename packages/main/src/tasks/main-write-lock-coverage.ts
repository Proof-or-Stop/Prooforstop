#!/usr/bin/env node
/**
 * B-9177 CHK-003 — mechanical regression guard for main-write-lock coverage.
 *
 * Trigger: B-7365 fixed ONE unlocked main-mutating reconcile path
 * (`commitInitCheckMetadataAndMergeMain` committed INIT_CHECK metadata to main
 * and merged WITHOUT holding the main write lock). The CHK-001 audit then found
 * three more live siblings (from-draft commit, from-draft commit+merge,
 * story_discard commit+reset). CLAUDE.md says "DONE/done_recover/gap_log/audit/
 * story_create/B-META finding writes hold the lock" — but until now that was
 * by-convention. There was no mechanical guard, so a future B-7365-class gap
 * (a brand-new main-mutating helper shipped without the lock) would only be
 * caught by a reviewer noticing. This guard turns that into a RED test.
 *
 * WHAT IT GUARDS (decision.json preMortem, all three honored):
 *
 *  1. NO function-name allowlist as the primary check. The guard SCANS
 *     `packages/main/src` for the git main-mutation primitives themselves —
 *     exactly the verbs in MAIN_MUTATION_VERBS: `commit` / `merge` (a
 *     story-branch merge INTO main) / `reset` on the main checkout /
 *     `commit-tree` / `update-ref refs/heads/main` — and asserts each enclosing
 *     path acquires the lock. A newly-added unlocked primitive fails the guard
 *     BY CONSTRUCTION, not because a name was added to a list.
 *     (`write-tree` is intentionally NOT scanned: it only writes a dangling
 *     tree OBJECT into the object DB and cannot move any ref, so it can never
 *     mutate main — no lock is needed and listing it would over-claim coverage.
 *     `commit-tree` is scanned only so the paired ref move is reached; it too is
 *     classified as a non-mutation below because it writes no ref by itself.)
 *
 *  2. CLASSIFY by direction / target, not raw substring. `git merge main` run
 *     INSIDE a story worktree merges main INTO the story branch — it does NOT
 *     mutate main and must NOT require the lock. The guard distinguishes a
 *     main-mutation (commit/merge/reset on the MAIN checkout, or update-ref of
 *     refs/heads/main) from a worktree-only / story-branch / abort operation by
 *     the resolved git cwd symbol + merge direction + verb, exactly the way the
 *     audit did. A small, EXPLICITLY-JUSTIFIED exceptions registry covers the
 *     reviewed worktree-only sites and the reviewed cross-function-locked sites
 *     (where the lock is acquired in the caller). The DEFAULT for an
 *     unrecognized main-mutation primitive is FAIL (fail-closed).
 *
 *  3. NEGATIVE CASE is mandatory. `assertNegativeFixtureBites` feeds the scanner
 *     a synthetic source file containing an unlocked `git commit` on the main
 *     checkout and asserts the guard reports a VIOLATION. This proves the guard
 *     actually bites instead of rubber-stamping.
 *
 * Function-level + injectable: `scanMainMutationCoverage` is pure over an
 * injected `{ files, readFile }` shape, so the production tree, the negative
 * fixture, and unit cases all run in-process without shelling out.
 */

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Marker line printed by the guard so `lattice validate` output is greppable. */
export const COVERAGE_MARKER = 'main-write-lock-coverage:';

/** Lock-acquisition tokens that count as "this scope holds the main write lock". */
const LOCK_ACQUIRE_TOKENS = [
  'withMainWriteLock',
  'withReentrantMainWriteLock',
  'acquireMainWriteLockRegistered',
  'acquireDoneMainMergeLock',
] as const;

/**
 * Git verbs that, when run on the MAIN checkout (or writing main's ref), mutate
 * the `main` branch. `merge` is direction-sensitive (handled below). `branch`
 * is NOT here: deleting a `story/<id>` branch is a story-branch mutation, never
 * a main mutation. `merge --abort` / `reset` are checked with care below.
 */
const MAIN_MUTATION_VERBS = ['commit', 'merge', 'reset', 'commit-tree', 'update-ref'] as const;

export type SiteClass = 'main-mutation' | 'worktree-only';

export interface MutationSite {
  /** repo-relative source file (posix-ish) */
  readonly file: string;
  /** 1-based line of the primitive call */
  readonly line: number;
  /** the matched primitive verb (commit / merge / reset / …) */
  readonly verb: string;
  /** trimmed source line (for the report) */
  readonly snippet: string;
  /** classification: does this mutate the main branch? */
  readonly classification: SiteClass;
  /** is the mutating critical section inside a lock acquisition? */
  readonly locked: boolean;
  /** OK | VIOLATION */
  readonly verdict: 'OK' | 'VIOLATION';
  /** one-line reason (justification for an exception, or why it's a violation) */
  readonly reason: string;
}

export interface CoverageReport {
  readonly sites: readonly MutationSite[];
  readonly violations: readonly MutationSite[];
  readonly scannedFiles: number;
}

/**
 * EXPLICITLY-JUSTIFIED exceptions registry (preMortem #2).
 *
 * Each entry is keyed by a STABLE site signature — a substring of the source
 * line that uniquely identifies the call — plus the file it lives in. An entry
 * declares EITHER:
 *   - `worktreeOnly: true`  — the op does not mutate main (merge main INTO a
 *     story worktree, a story-branch delete, a `merge --abort`, a commit on a
 *     `story/*` worktree, …). NOT required to hold the lock.
 *   - `crossFunctionLocked: true` — the op DOES mutate main, but the lock is
 *     acquired in the CALLER, not lexically in this function. Reviewed + cited.
 *
 * Anything NOT matched here AND not lexically locked-in-body is treated as a
 * main mutation that MUST be locked → fail-closed default.
 *
 * Keeping this as data (not code branches) makes every exception auditable and
 * forces a reviewer to add a one-line `reason` for each.
 */
interface ExceptionEntry {
  readonly fileEndsWith: string;
  readonly lineIncludes: string;
  readonly worktreeOnly?: true;
  readonly crossFunctionLocked?: true;
  readonly reason: string;
}

const EXCEPTIONS: readonly ExceptionEntry[] = [
  // ── worktree-only: merge main INTO a story worktree (cwd = worktree) ──────
  {
    fileEndsWith: 'handlers/done-effects.ts',
    lineIncludes: "execSync('git merge main --no-edit'",
    worktreeOnly: true,
    reason: 'autoSyncMain: merges main INTO the story worktree (cwd=worktree), not a main mutation',
  },
  // NOTE: cli-engine `gitCli(worktreeAbs, …)` / `runGitNoThrow(worktreeAbs, …)`
  // story-worktree commits+merges are NOT listed here — they are classified
  // worktree-only automatically by their resolved cwd symbol (worktreeAbs ∈
  // WORKTREE_CWD_SYMBOLS), so no explicit exception is needed.
  {
    fileEndsWith: 'core/auto-commit-metadata.ts',
    lineIncludes: "'commit', '-m', subject",
    worktreeOnly: true,
    reason: 'auto-commit-metadata: self-gated to story/* branches only (returns early on non-story), commits the story worktree, never main',
  },

  // ── cross-function-locked: mutates main, lock held by the CALLER ──────────
  {
    fileEndsWith: 'handlers/done-effects.ts',
    lineIncludes: "'merge', branch, '--no-ff'",
    crossFunctionLocked: true,
    reason: 'applyDoneMergeEffects DONE merge into main; lock acquired in transition-orchestrator.ts (acquireDoneMainMergeLock) spanning this call',
  },
  {
    fileEndsWith: 'handlers/worktree.ts',
    lineIncludes: 'reset --hard HEAD~1',
    crossFunctionLocked: true,
    reason: 'story_discard purgeSafeInitCommit reset on main; lock acquired at the callsite (withReentrantMainWriteLock, label "story_discard purge reset")',
  },
  {
    fileEndsWith: 'handlers/worktree.ts',
    lineIncludes: 'commit -m "lattice: discard',
    crossFunctionLocked: true,
    reason: 'story_discard commitDiscardMetadata commit on main; lock acquired at the callsite (withReentrantMainWriteLock, label "story_discard metadata commit")',
  },
  {
    fileEndsWith: 'core/safe-init-commit.ts',
    lineIncludes: "'commit', '--only', '-m', subject",
    crossFunctionLocked: true,
    reason: 'B-02a6 CHK-002 createSafeInitCommitOnHead safe-init commit on main; lock held by the caller story_create (withReentrantMainWriteLock body) and by story_discard purge tombstone fallback',
  },
];

/** Resolve which exception (if any) a given site matches. */
function matchException(file: string, snippet: string): ExceptionEntry | null {
  for (const ex of EXCEPTIONS) {
    if (file.endsWith(ex.fileEndsWith) && snippet.includes(ex.lineIncludes)) {
      return ex;
    }
  }
  return null;
}

/**
 * Does a `git`-wrapper call on `line` carry a main-mutation verb, and if so what
 * is the resolved cwd symbol?
 *
 * Recognizes the repo's several git-wrapper shapes (cwd position differs!):
 *   - `gitCli(cwd, ['…','commit',…])`           (cli-engine.ts — cwd 1st)
 *   - `git(cwd, ['…','merge',…])`               (done-recover.ts, auxiliary — cwd 1st)
 *   - `git('reset --hard …', cwd)`              (worktree.ts — args string, cwd 2nd)
 *   - `runGitNoThrow(cwd, ['merge',…])`         (cli-engine.ts — cwd 1st)
 *   - `runGitArgs(['merge',…], cwd)`            (done-effects.ts — args 1st, cwd 2nd)
 *   - `gitFile(['commit-tree',…], cwd[, env])`  (worktree.ts — args 1st, cwd 2nd,
 *                                                 cwd OPTIONAL, defaults to `root`)
 *   - `execSync('git merge main …', { cwd })`   (done-effects.ts — cwd in opts)
 *   - `execFileSync('git', ['commit',…], {cwd})`(auto-commit-metadata.ts — cwd in opts)
 *
 * `gitFile` (handlers/worktree.ts `createScopedStoryBootstrapCommit`) is the
 * scoped story-branch bootstrap plumbing: `write-tree` / `commit-tree` /
 * `update-ref refs/heads/story/<id>`. Its mutation verbs (`commit-tree`,
 * `update-ref`) are recognized + classified by TARGET (a dangling commit object
 * / a story-branch ref ⇒ NOT main), so a FUTURE `gitFile([…,'commit',…], root)`
 * or `gitFile(['update-ref','refs/heads/main',…], root)` that DOES mutate main
 * would be caught (fail-closed) instead of slipping through unseen.
 *
 * The verb MUST be a real git SUBCOMMAND token — a standalone quoted arg
 * (`'commit'`) or the first word of a single-string git arg (`'reset --hard'`).
 * This deliberately REJECTS:
 *   - rev-specs:      `${ref}^{commit}`            (the verb is mid-token)
 *   - flags:          `--no-commit-id`             (verb embedded in a flag)
 *   - config tokens:  `commit.gpgsign=false`       (verb followed by `.`)
 *   - prose / hints:  `lines.push('… git commit …')`(verb mid-sentence)
 *   - plumbing:       `merge-tree` / `merge-base`   (read-only)
 *   - unwinds:        `merge --abort`               (does not mutate)
 *
 * Returns `{ verb, cwdSymbol }` or null. Classification (does it hit MAIN?) is
 * decided afterwards from `cwdSymbol` + merge direction + the exceptions
 * registry — never by this match alone.
 */
interface VerbMatch {
  readonly verb: string;
  readonly cwdSymbol: string | null;
}

/** git-wrapper call openers, recognized at a span start. */
const GIT_CALL_OPENERS = /\b(gitCli|runGitNoThrow|runGitArgs|gitFile|git)\s*\(|\bexec(File)?Sync\s*\(\s*['"`]git/;

/**
 * A git-wrapper call SPAN: the full call text from the opener to the matching
 * close paren, joined into one logical string (so multi-line array-arg calls
 * like `gitCli(root, [\n 'commit',\n ])` are analyzed as one unit), plus the
 * 1-based line of the opener.
 */
interface GitCallSpan {
  readonly text: string;
  readonly startLine: number;
}

/**
 * Extract every git-wrapper call span in `lines`. Walks each opener match and
 * consumes characters (across line boundaries) until parens balance. Robust to
 * the multi-line array-arg shapes used throughout the repo.
 */
function extractGitCallSpans(lines: readonly string[]): GitCallSpan[] {
  const spans: GitCallSpan[] = [];
  const full = lines.join('\n');
  // Offset → line number (1-based) for the opener.
  const lineStarts: number[] = [0];
  for (let i = 0; i < full.length; i++) if (full[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const opener = new RegExp(GIT_CALL_OPENERS.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = opener.exec(full)) !== null) {
    // Find the '(' that begins the arg list (the opener match ends at or just
    // after a '('; back up to the first '(' from the match start).
    const parenStart = full.indexOf('(', m.index);
    if (parenStart < 0) continue;
    // Walk to the matching close paren (ignoring parens inside strings).
    let depth = 0, i = parenStart;
    let inStr: string | null = null;
    for (; i < full.length; i++) {
      const c = full[i];
      if (inStr) {
        if (c === '\\') { i++; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    const text = full.slice(m.index, i).replace(/\s+/g, ' ');
    spans.push({ text, startLine: lineOf(m.index) });
    opener.lastIndex = i; // resume after this span
  }
  return spans;
}

/**
 * Extract the cwd symbol from a (single-logical-line) git-call span, by shape.
 * Returns the identifier (e.g. `wtPath`, `gitRoot`, `worktreeAbs`) or null.
 */
function extractCwdSymbol(text: string): string | null {
  // execFileSync('git', [...], { cwd: SYMBOL }) / execSync('git …', { cwd: SYMBOL })
  const optsCwd = text.match(/\bcwd\s*:\s*([A-Za-z_$][\w$.]*)/);
  if (optsCwd) return optsCwd[1];

  // git(`… template/string args …`, SYMBOL) — args is a STRING/TEMPLATE literal
  // (may embed quotes), cwd is the 2nd arg. Match the wrapper, a quoted literal
  // span, then the trailing identifier.
  const stringArgsCwd = text.match(/\b(?:git|gitCli|runGitNoThrow)\s*\(\s*(['"`]).*?\1\s*,\s*([A-Za-z_$][\w$]*)/);
  if (stringArgsCwd) return stringArgsCwd[2];

  // gitCli(SYMBOL, [...]) / git(SYMBOL, [...]) / runGitNoThrow(SYMBOL, [...])
  // — cwd is the FIRST arg, args is an ARRAY literal.
  const arrayArgsCwd = text.match(/\b(?:gitCli|git|runGitNoThrow)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*\[/);
  if (arrayArgsCwd) return arrayArgsCwd[1];

  // runGitArgs([...], SYMBOL) / gitFile([...], SYMBOL[, env]) — args FIRST, cwd
  // SECOND. `gitFile` (handlers/worktree.ts) shares this shape: `gitFile(args,
  // cwd = root, env?)`. The cwd arg is OPTIONAL (defaults to `root` when only the
  // args array is passed, e.g. `gitFile(['rev-parse', …])`), so a missing 2nd arg
  // resolves to null here and the default branch then treats it as main
  // (fail-closed) — correct, since `gitFile([...])` with no cwd runs in `root`.
  const argsThenCwd = text.match(/\b(?:runGitArgs|gitFile)\s*\(\s*\[.*?\]\s*,\s*([A-Za-z_$][\w$]*)/);
  if (argsThenCwd) return argsThenCwd[1];

  return null;
}

/**
 * Does a git-call span carry a main-mutation verb? Operates on the joined span
 * text so multi-line array-arg calls are matched. The verb MUST be a real git
 * SUBCOMMAND token (standalone quoted arg / first word of a string arg /
 * `git <verb>` embedded form), never a substring of a flag / rev-spec / config
 * token / prose. Returns `{ verb, cwdSymbol }` or null.
 */
function matchMutationVerb(text: string): VerbMatch | null {
  for (const verb of MAIN_MUTATION_VERBS) {
    // (a) verb as a standalone quoted arg:  'commit'  "merge"  `reset`
    const standalone = new RegExp(`['"\`]\\s*${verb}\\s*['"\`]`);
    // (b) verb as the FIRST word of a single-string git arg:  'reset --hard …'
    //     'commit -m …'  — followed by a SPACE then more args; never `.`/`-`/`^`/`{`.
    const firstWord = new RegExp(`['"\`]\\s*${verb}\\s+[^'"\`]`);
    // (c) embedded whole-command form:  'git merge main …'  — verb a whole word
    //     after `git `.
    const embedded = new RegExp(`['"\`]\\s*git\\s+${verb}\\b`);
    // (d) verb as the SUBCOMMAND inside a single-string git command that begins
    //     with leading `-c key=val` options:  '-c commit.gpgsign=false commit -m …'
    //     (worktree.ts `git('<full command string>', cwd)` shape). Anchored to
    //     the start of the quoted string: optional repeated `-c <cfg>` then the
    //     verb as a whole word. Rejects `commit.gpgsign` (config) and
    //     `--no-commit-id` (flag) because the verb must follow `-c <cfg> ` and
    //     be space-delimited.
    const afterDashC = new RegExp(`['"\`]\\s*(?:-c\\s+\\S+\\s+)+${verb}\\s`);
    if (
      !standalone.test(text) &&
      !firstWord.test(text) &&
      !embedded.test(text) &&
      !afterDashC.test(text)
    ) continue;

    // merge is direction/op-sensitive — reject the non-mutating forms anywhere
    // in the span (merge-tree / merge-base plumbing, merge --abort unwind).
    if (verb === 'merge' && /merge-tree|merge-base|['"`]\s*--abort|merge\s+--abort/.test(text)) {
      continue;
    }
    return { verb, cwdSymbol: extractCwdSymbol(text) };
  }
  return null;
}

/**
 * Symbol names that resolve to a STORY WORKTREE checkout (cwd ⇒ worktree-only).
 * A commit/merge with one of these as cwd does NOT mutate main.
 */
const WORKTREE_CWD_SYMBOLS = new Set([
  'wtPath', 'wtPathAbs', 'worktreeAbs', 'worktreePath', 'worktreeRoot',
]);

/**
 * Symbol names that resolve to the MAIN checkout (cwd ⇒ main mutation candidate).
 * Matches the audit's `resolveMainRepoRoot` / `gitRoot` / `mainMergeRoot` names.
 */
const MAIN_CWD_SYMBOLS = new Set([
  'root', 'gitRoot', 'gitMainRoot', 'mainMergeRoot', 'mainRepoRoot', 'repoRoot',
]);

/**
 * Does an `update-ref` call (joined span text) write a STORY-BRANCH ref rather
 * than `refs/heads/main`? Used to clear the scoped-bootstrap
 * `update-ref refs/heads/${branch}` site (story-branch creation) without opening
 * a hole for `update-ref refs/heads/main`.
 *
 * FAIL-CLOSED: returns true ONLY for a ref target that is EXPLICITLY a story
 * branch — a literal `refs/heads/story/...` or a `refs/heads/${branch|storyBranch|…}`
 * template whose interpolated variable is a recognized story-branch name. Any
 * `refs/heads/main` literal, a bare/symbolic ref (`HEAD`, `refs/heads/${ref}`
 * with an unknown var), or no parseable target → returns false → the caller
 * treats it as a main mutation (must be locked).
 */
const STORY_BRANCH_REF_VARS = new Set(['branch', 'storyBranch', 'storyBranchRef']);

function updatesStoryBranchRef(text: string): boolean {
  // The ref target is the first quoted/template arg AFTER the `update-ref` verb
  // token. Find the verb, then inspect the immediately-following quoted literal.
  const m = text.match(/['"`]\s*update-ref\s*['"`]\s*,\s*([`'"])([^`'"]*)\1/);
  if (!m) return false;
  const refLiteral = m[2];
  // Hard reject anything that targets main, HEAD, or a symbolic main ref.
  if (/(^|\/)main$/.test(refLiteral) || /\bHEAD\b/.test(refLiteral)) return false;
  // Literal story-branch ref: refs/heads/story/<id>
  if (/^refs\/heads\/story\//.test(refLiteral)) return true;
  // Templated story-branch ref: refs/heads/${branch} where the interpolated var
  // is a recognized story-branch variable (and ONLY that — fail-closed on
  // unknown vars like ${ref} that could resolve to main).
  const tmpl = refLiteral.match(/^refs\/heads\/\$\{?\s*([A-Za-z_$][\w$]*)\s*\}?$/);
  if (tmpl && STORY_BRANCH_REF_VARS.has(tmpl[1])) return true;
  return false;
}

/**
 * Find the enclosing-scope start for a site and whether a lock-acquisition
 * token appears lexically BEFORE the site within the nearest enclosing
 * function/arrow body.
 *
 * Heuristic but robust for this codebase: walk UP from the site line; the lock
 * is considered held-in-body if any LOCK_ACQUIRE_TOKEN appears between the
 * nearest `function`/`=>`-opening boundary above the site and the site itself.
 * To avoid bleeding across unrelated sibling functions we stop the upward walk
 * at a line that is a top-level `}` at column 0 followed by a blank/decl, but
 * in practice scanning the whole file region above the site within the same
 * lock variable's `try {` is sufficient — the cross-function cases are handled
 * by the exceptions registry, so a false "locked" here can only HIDE a
 * violation if a real unlocked site sits below an unrelated lock in the SAME
 * file; the negative fixture guards against that by using a fresh file.
 *
 * We implement the conservative version: a site is locked-in-body iff a lock
 * token appears earlier in the file within a window bounded by the previous
 * `export function`/`function `/`: (…) =>`/method boundary.
 */
/** JS keywords that open a brace block but are NOT a function boundary. */
const CONTROL_FLOW_KEYWORDS = new Set([
  'for', 'if', 'while', 'switch', 'catch', 'else', 'do', 'try', 'finally', 'return',
]);

/**
 * Is `line` a real FUNCTION / METHOD / ARROW boundary (a scope a site belongs
 * to), as opposed to a control-flow block (`for`/`if`/`try`/…)? Used to bound
 * the upward lock search so an intervening loop/conditional does not truncate
 * it before the enclosing function's lock acquisition.
 */
function isFunctionBoundary(line: string): boolean {
  const t = line.trim();
  // `function foo(` / `export async function foo(`
  if (/^(export\s+)?(async\s+)?function\s+\w/.test(t)) return true;
  // arrow opening that ends the line: `… () => {`  (lock callbacks land here)
  if (/=>\s*\{?\s*$/.test(t)) return true;
  // method shorthand `name(args) {` / `name(args): T {` — but NOT a control-flow
  // keyword (`for (…) {`, `if (…) {`, …) and NOT a plain call statement.
  const methodMatch = t.match(/^([\w$]+)\s*\([^)]*\)\s*(:\s*[^={]+)?\s*\{\s*$/);
  if (methodMatch && !CONTROL_FLOW_KEYWORDS.has(methodMatch[1])) return true;
  return false;
}

/**
 * Is the site at `siteIdx` lexically inside a main-write-lock acquisition?
 *
 * Two lock shapes are recognized:
 *   - callback:  `withReentrantMainWriteLock(root, () => { … site … })`
 *   - raw acquire: `const lock = acquireDoneMainMergeLock(…); try { … site … }`
 *
 * Strategy: walk UP to the nearest FUNCTION/METHOD/ARROW boundary (control-flow
 * blocks like `for`/`if`/`try` are skipped so they don't truncate the search),
 * then scan that boundary line + the region down to the site for a
 * LOCK_ACQUIRE_TOKEN. A lock-callback opener IS the boundary, so it is detected
 * directly; a raw `acquire…Lock` earlier in the enclosing function body is
 * detected by the region scan.
 */
function isLockedInBody(lines: readonly string[], siteIdx: number): boolean {
  let start = 0;
  for (let i = siteIdx - 1; i >= 0; i--) {
    if (isFunctionBoundary(lines[i])) {
      start = i;
      break;
    }
  }
  for (let i = start; i < siteIdx; i++) {
    if (LOCK_ACQUIRE_TOKENS.some((t) => lines[i].includes(t))) return true;
  }
  return false;
}

/** Strip line-leading `//` comments so a verb in a comment never matches. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

export interface ScanInput {
  /** repo-relative file paths to scan */
  readonly files: readonly string[];
  /** read a file's full text by its repo-relative path */
  readonly readFile: (file: string) => string;
}

/**
 * Pure scan: classify every git main-mutation primitive site across `files`.
 *
 * For each site:
 *   1. matchMutationVerb → is it a git mutation-verb call?
 *   2. exceptions registry → worktree-only (OK, no lock needed) or
 *      cross-function-locked (OK, lock in caller).
 *   3. otherwise classify as a MAIN mutation and require an in-body lock; an
 *      unlocked main mutation → VIOLATION (fail-closed default).
 */
export function scanMainMutationCoverage(input: ScanInput): CoverageReport {
  const sites: MutationSite[] = [];

  for (const file of input.files) {
    const text = input.readFile(file);
    const lines = text.split('\n');

    for (const span of extractGitCallSpans(lines)) {
      const lineIdx = span.startLine - 1;
      // Skip a span whose opener line is a comment (a verb in commented-out code).
      if (isCommentLine(lines[lineIdx] ?? '')) continue;

      const match = matchMutationVerb(span.text);
      if (!match) continue;
      const { verb, cwdSymbol } = match;
      const snippet = span.text.length > 160 ? `${span.text.slice(0, 157)}...` : span.text;

      // (1) Explicit, justified exception registry wins (reviewed sites).
      const ex = matchException(file, span.text);
      if (ex?.worktreeOnly) {
        sites.push({
          file, line: span.startLine, verb, snippet,
          classification: 'worktree-only', locked: false, verdict: 'OK', reason: ex.reason,
        });
        continue;
      }
      if (ex?.crossFunctionLocked) {
        sites.push({
          file, line: span.startLine, verb, snippet,
          classification: 'main-mutation', locked: true, verdict: 'OK', reason: ex.reason,
        });
        continue;
      }

      // (2) Classify by resolved git cwd symbol + merge direction (the audit's
      //     method). A commit/merge/reset with a KNOWN story-worktree cwd does
      //     not mutate main. A `merge main`/`merge <base>` (i.e. merging INTO
      //     the current checkout, not a story branch into main) is into-worktree.
      const mergeIntoWorktree =
        verb === 'merge' &&
        /['"`]\s*merge\s*['"`]\s*,\s*['"`]\s*(main|base|\$\{?\w*[Bb]ase)/.test(span.text);
      if (cwdSymbol && WORKTREE_CWD_SYMBOLS.has(cwdSymbol)) {
        sites.push({
          file, line: span.startLine, verb, snippet,
          classification: 'worktree-only', locked: false, verdict: 'OK',
          reason: `git cwd=${cwdSymbol} resolves to a story worktree — ${verb} mutates the story checkout, not main`,
        });
        continue;
      }
      if (mergeIntoWorktree) {
        sites.push({
          file, line: span.startLine, verb, snippet,
          classification: 'worktree-only', locked: false, verdict: 'OK',
          reason: 'merge of main/base INTO the current (story) checkout — not a main mutation',
        });
        continue;
      }

      // (2b) Ref-target / object-only classification (preMortem #1: classify by
      //      TARGET, not just cwd). Two plumbing verbs run against the MAIN
      //      checkout cwd (`repoRoot`) during scoped story-branch bootstrap
      //      (`createScopedStoryBootstrapCommit`, handlers/worktree.ts) but do NOT
      //      mutate main:
      //        - `commit-tree` produces a DANGLING commit object and writes NO
      //          ref. By itself it can never mutate any branch — only the paired
      //          `update-ref` moves a ref, and THAT is classified by its target
      //          below. So a bare commit-tree is never a main mutation.
      //        - `update-ref refs/heads/story/<id>` (or `refs/heads/${branch}`
      //          where `branch` is the story branch) writes a STORY-branch ref,
      //          not main. Fail-closed: only a ref EXPLICITLY recognized as a
      //          non-main branch is cleared here; `update-ref refs/heads/main`,
      //          `update-ref HEAD`, or any unrecognized/symbolic target falls
      //          through to the default branch and is treated as a main mutation.
      if (verb === 'commit-tree') {
        sites.push({
          file, line: span.startLine, verb, snippet,
          classification: 'worktree-only', locked: false, verdict: 'OK',
          reason: 'commit-tree writes a dangling commit OBJECT, not a ref — never a main mutation by itself (the paired update-ref is classified by its target)',
        });
        continue;
      }
      if (verb === 'update-ref' && updatesStoryBranchRef(span.text)) {
        sites.push({
          file, line: span.startLine, verb, snippet,
          classification: 'worktree-only', locked: false, verdict: 'OK',
          reason: 'update-ref writes a refs/heads/story/<id> (story-branch) ref, not refs/heads/main — story-branch creation, not a main mutation',
        });
        continue;
      }

      // (3) Default branch (fail-closed): a MAIN-checkout cwd (or an UNKNOWN cwd
      //     symbol — conservative) that mutates main MUST be locked in-body. An
      //     unrecognized brand-new primitive lands here and fails if unlocked.
      const locked = isLockedInBody(lines, lineIdx);
      const cwdNote = cwdSymbol
        ? (MAIN_CWD_SYMBOLS.has(cwdSymbol) ? `cwd=${cwdSymbol} (main checkout)` : `cwd=${cwdSymbol} (unrecognized — treated as main, fail-closed)`)
        : 'cwd unresolved (treated as main, fail-closed)';
      sites.push({
        file, line: span.startLine, verb, snippet,
        classification: 'main-mutation',
        locked,
        verdict: locked ? 'OK' : 'VIOLATION',
        reason: locked
          ? `main mutation (${cwdNote}) enclosed by an in-body main-write-lock acquisition`
          : `UNLOCKED main mutation (${cwdNote}) — not enclosed by a lock and not a reviewed worktree-only/cross-function-locked site`,
      });
    }
  }

  const violations = sites.filter((s) => s.verdict === 'VIOLATION');
  return { sites, violations, scannedFiles: input.files.length };
}

// ── filesystem scan (production tree) ──────────────────────────────────────

const SCAN_IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'tasks']);

/**
 * Recursively collect `.ts` files under `srcRoot`, skipping ignored dirs and
 * `tasks/` itself (the guard + smoke fixtures live there and must not be
 * scanned as production main-mutation sources). Returns repo-relative paths.
 */
function collectSourceFiles(srcRoot: string, repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SCAN_IGNORE_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        out.push(relative(repoRoot, abs));
      }
    }
  };
  walk(srcRoot);
  return out.sort();
}

/** Render the path → mutates-main? → locked? → verdict table. */
function renderTable(report: CoverageReport): string {
  const rows = report.sites.map((s) => {
    const mutates = s.classification === 'main-mutation' ? 'YES' : 'no ';
    const locked = s.classification === 'worktree-only' ? 'n/a' : s.locked ? 'YES' : 'NO ';
    const flag = s.verdict === 'VIOLATION' ? '✗' : '✓';
    return `  ${flag} ${s.file}:${s.line}  [${s.verb}]  mutates-main=${mutates}  locked=${locked}  ${s.verdict}`;
  });
  return rows.join('\n');
}

/**
 * NEGATIVE FIXTURE (preMortem #3): feed the scanner a synthetic source file
 * with an UNLOCKED `git commit` on the main checkout and assert the guard
 * reports a violation. Proves the guard bites.
 */
export function assertNegativeFixtureBites(): void {
  const fixtureFile = 'core/__negative_fixture__.ts';
  const unlockedSource = [
    'function shipsAnUnlockedMainCommit(mainRoot: string) {',
    '  // a brand-new helper that forgot the main write lock',
    "  gitCli(mainRoot, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'oops on main']);",
    '}',
  ].join('\n');

  const report = scanMainMutationCoverage({
    files: [fixtureFile],
    readFile: () => unlockedSource,
  });

  assert.equal(report.violations.length, 1, 'negative fixture must produce exactly one violation');
  const v = report.violations[0];
  assert.equal(v.verb, 'commit', 'the violated primitive is the commit');
  assert.equal(v.classification, 'main-mutation', 'the unlocked commit is classified as a main mutation');
  assert.equal(v.locked, false, 'the fixture commit is NOT locked');
  assert.equal(v.verdict, 'VIOLATION', 'an unlocked main commit must be a VIOLATION');

  // And the POSITIVE control: wrapping the same commit in a lock clears it.
  const lockedSource = [
    'function shipsALockedMainCommit(mainRoot: string) {',
    '  return withReentrantMainWriteLock(mainRoot, () => {',
    "    gitCli(mainRoot, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'safe on main']);",
    '  });',
    '}',
  ].join('\n');
  const lockedReport = scanMainMutationCoverage({
    files: ['core/__locked_fixture__.ts'],
    readFile: () => lockedSource,
  });
  assert.equal(lockedReport.violations.length, 0, 'the same commit wrapped in the lock is NOT a violation');

  // And the WORKTREE-ONLY control: `merge main` inside a worktree (cwd=worktree)
  // is classified worktree-only — must NOT demand the lock (preMortem #1/#2).
  const worktreeOnlySource = [
    'function mergesMainIntoStoryWorktree(worktreeAbs: string) {',
    "  gitCli(worktreeAbs, ['-c', 'commit.gpgsign=false', 'merge', 'main', '--no-edit']);",
    '}',
  ].join('\n');
  const worktreeReport = scanMainMutationCoverage({
    files: ['cli-engine.ts'],
    readFile: () => worktreeOnlySource,
  });
  assert.equal(worktreeReport.violations.length, 0, 'merge main into a story worktree must NOT be a violation');
  assert.equal(
    worktreeReport.sites.find((s) => s.verb === 'merge')?.classification,
    'worktree-only',
    'a worktree-cwd merge of main is classified worktree-only (no false positive)',
  );

  // ── gitFile RECOGNITION (B-9177:F-001) ────────────────────────────────────
  // The fix taught the scanner the `gitFile(args, cwd[, env])` wrapper. These
  // controls prove the recognition actually CLOSES the false-negative gap (a
  // future gitFile main mutation now bites) AND keeps the legitimate scoped
  // story-branch bootstrap shape GREEN.

  // (a) A FUTURE unlocked `gitFile([…,'commit',…], root)` on main MUST bite.
  const gitFileUnlockedCommit = [
    'function shipsAnUnlockedMainCommitViaGitFile(root: string) {',
    "  gitFile(['commit', '-m', 'oops on main via gitFile'], root);",
    '}',
  ].join('\n');
  const gitFileCommitReport = scanMainMutationCoverage({
    files: ['handlers/worktree.ts'],
    readFile: () => gitFileUnlockedCommit,
  });
  assert.equal(gitFileCommitReport.violations.length, 1, 'an unlocked gitFile commit on main MUST be a violation (recognition closed the gap)');
  assert.equal(gitFileCommitReport.violations[0].verb, 'commit', 'the gitFile violation is the commit');
  assert.equal(gitFileCommitReport.violations[0].classification, 'main-mutation', 'the gitFile commit on root is a main mutation');

  // (b) A FUTURE `gitFile(['update-ref', 'refs/heads/main', …], root)` MUST bite
  //     (the story-branch ref carve-out must NOT leak to refs/heads/main).
  const gitFileUpdateMain = [
    'function shipsAnUnlockedMainRefUpdate(root: string) {',
    "  gitFile(['update-ref', 'refs/heads/main', commit], root);",
    '}',
  ].join('\n');
  const gitFileMainRefReport = scanMainMutationCoverage({
    files: ['handlers/worktree.ts'],
    readFile: () => gitFileUpdateMain,
  });
  assert.equal(gitFileMainRefReport.violations.length, 1, 'an unlocked gitFile update-ref of refs/heads/main MUST be a violation');
  assert.equal(gitFileMainRefReport.violations[0].verb, 'update-ref', 'the gitFile main-ref violation is the update-ref');

  // (c) The LEGITIMATE scoped story-branch bootstrap shape (commit-tree builds a
  //     dangling object; update-ref writes refs/heads/${branch}) must stay GREEN
  //     — no lock required, classified worktree-only (preMortem #1: by target).
  const bootstrapShape = [
    'function createScopedStoryBootstrapCommit(repoRoot: string, branch: string) {',
    "  const commit = gitFile(['commit-tree', tree, '-p', head, '-m', 'lattice: init'], repoRoot);",
    "  gitFile(['update-ref', `refs/heads/${branch}`, commit], repoRoot);",
    '}',
  ].join('\n');
  const bootstrapReport = scanMainMutationCoverage({
    files: ['handlers/worktree.ts'],
    readFile: () => bootstrapShape,
  });
  assert.equal(bootstrapReport.violations.length, 0, 'the scoped story-branch bootstrap (commit-tree + update-ref refs/heads/${branch}) must NOT be a violation');
  assert.equal(
    bootstrapReport.sites.find((s) => s.verb === 'commit-tree')?.classification,
    'worktree-only',
    'commit-tree (dangling object, no ref write) is classified worktree-only',
  );
  assert.equal(
    bootstrapReport.sites.find((s) => s.verb === 'update-ref')?.classification,
    'worktree-only',
    'update-ref of a refs/heads/story branch is classified worktree-only',
  );

  console.log(`${COVERAGE_MARKER} negative fixture bites (unlocked main commit ⇒ VIOLATION; locked ⇒ OK; worktree-only merge ⇒ OK; gitFile commit/update-ref on main ⇒ VIOLATION; gitFile story-branch bootstrap ⇒ OK)`);
}

function runGuard(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/tasks/ → packages/main/  (src at build time; dist at runtime — both
  // resolve to the package root, and we scan the SRC tree which ships alongside).
  const packageRoot = join(here, '..', '..'); // dist/tasks → dist → packages/main
  // The shipped layout has `src/` next to `dist/`; scan the TypeScript SOURCE.
  let srcRoot = join(packageRoot, 'src');
  try {
    statSync(srcRoot);
  } catch {
    // Fallback: running from src via tsx — `here` is already src/tasks.
    srcRoot = join(here, '..');
  }
  const repoRoot = srcRoot.endsWith(join('src')) ? join(srcRoot, '..') : packageRoot;

  const files = collectSourceFiles(srcRoot, repoRoot);
  const report = scanMainMutationCoverage({
    files,
    readFile: (f) => readFileSync(join(repoRoot, f), 'utf-8'),
  });

  console.log(`${COVERAGE_MARKER} scanned ${report.scannedFiles} source files, ${report.sites.length} git mutation-verb sites`);
  console.log(renderTable(report));

  // Always run the negative fixture so a regression that neuters the scanner
  // (e.g. someone makes matchMutationVerb always return null) is caught.
  assertNegativeFixtureBites();

  if (report.violations.length > 0) {
    console.error(
      `\n${COVERAGE_MARKER} FAIL — ${report.violations.length} unlocked main-mutating path(s):`,
    );
    for (const v of report.violations) {
      console.error(`  ✗ ${v.file}:${v.line} [${v.verb}] ${v.reason}`);
    }
    console.error(
      '\nEvery commit/merge/reset/update-ref that mutates the MAIN branch must run inside\n' +
      'withMainWriteLock / withReentrantMainWriteLock / acquireMainWriteLockRegistered.\n' +
      'If this is genuinely a story-worktree-only op (merge main INTO a story branch,\n' +
      'a story-branch delete, a merge --abort), add a justified worktree-only entry to\n' +
      'EXCEPTIONS in packages/main/src/tasks/main-write-lock-coverage.ts.',
    );
    process.exit(1);
  }

  console.log(`\n${COVERAGE_MARKER} PASS — all ${report.sites.filter((s) => s.classification === 'main-mutation').length} main-mutating path(s) hold the main write lock`);
}

/**
 * `--negative-demo`: render the unlocked-fixture violation as a visible RED
 * table and exit non-zero. Proves, from the CLI, that the guard bites when an
 * unlocked main-mutating primitive is introduced (preMortem #3). The default
 * (no flag) run keeps the fixture purely in-process via `assertNegativeFixtureBites`.
 */
function runNegativeDemo(): void {
  const unlockedSource = [
    'function shipsAnUnlockedMainCommit(mainRoot: string) {',
    '  // a brand-new helper that forgot the main write lock',
    "  gitCli(mainRoot, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'oops on main']);",
    '}',
  ].join('\n');
  const report = scanMainMutationCoverage({
    files: ['core/__negative_fixture__.ts'],
    readFile: () => unlockedSource,
  });
  console.log(`${COVERAGE_MARKER} NEGATIVE DEMO — scanning a fixture with an UNLOCKED git commit on the main checkout`);
  console.log(renderTable(report));
  console.error(`\n${COVERAGE_MARKER} FAIL — ${report.violations.length} unlocked main-mutating path(s):`);
  for (const v of report.violations) {
    console.error(`  ✗ ${v.file}:${v.line} [${v.verb}] ${v.reason}`);
  }
  process.exit(report.violations.length > 0 ? 1 : 0);
}

// Only run when executed directly (not when imported by a unit test).
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  if (process.argv.includes('--negative-demo')) {
    runNegativeDemo();
  } else {
    runGuard();
  }
}
