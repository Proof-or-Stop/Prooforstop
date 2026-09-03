#!/usr/bin/env node

/**
 * B-db56 CHK-002 smoke: grep-contract gate over every git child-process call site.
 *
 * BUG CLASS: across the codebase, ~193 sites invoke
 *   (execFileSync|spawnSync|execSync)('git', ...)
 * and the recurring P1 defect is "the cwd argument is a bare projectRoot /
 * root / metadataRoot identifier — i.e. the metadataRoot — but in a
 * WRAPPER-ROOT layout the metadataRoot is NOT a git repo and the real repo is
 * a configured gitRoot subdir". B-2856 and B-3990 fixed two batches of sites
 * by routing through `resolveGitCwd()`; B-db56 (this smoke) is the standing
 * contract that NEW occurrences of the antipattern fail CI immediately.
 *
 * Rule (lexical):
 *   For every git child-process call expression found by the canonical regex
 *   below, the literal `cwd:` argument MUST NOT be one of the bare project-root
 *   identifiers `projectRoot`, `root`, or `metadataRoot`. The cwd source must
 *   be either:
 *     (a) the result of `resolveGitCwd(...)` (the single choke-point), OR
 *     (b) an allowlisted local variable, parameter, or expression — typically a
 *         caller-resolved `gitCwd` / `cwd` parameter forwarded by an ad-hoc
 *         git helper.
 *
 * Failure message (EXACT format):
 *   <absoluteFilePath>:<line>: bare projectRoot/root/metadataRoot used as git
 *   cwd — route through resolveGitCwd (packages/main/src/core/story-signed-workspace-resolution.ts)
 *
 * Allowlist (lives at the top of this source so a reviewer can see what is
 * exempted at a glance):
 *  - the resolver itself (`core/story-signed-workspace-resolution.ts`) is
 *    allowed to make raw git probes while computing the cwd.
 *  - the 3 ad-hoc git helpers explicitly named in B-db56:
 *      packages/lab/src/handlers/lab.ts           (runGit)
 *      packages/main/src/cli-engine.ts            (runGitNoThrow)
 *      packages/main/src/core/declared-artifact-commit-check.ts (runGit)
 *  - smoke tasks (`packages/<pkg>/src/tasks/*-smoke.ts`) that construct
 *    deliberately-bad git scenarios for test fixtures.
 *  - `packages/main/src/tasks/main-write-lock-coverage.ts` is a STATIC-SCAN
 *    audit task that contains git-call-pattern STRINGS for its own AST checks;
 *    its own greppable text is part of the audit fixture.
 *
 * Self-test: this smoke processes 2 inline string fixtures BEFORE scanning the
 * repo so detection logic bugs surface before false negatives reach the build.
 *  - KNOWN-GOOD:  execFileSync('git', ['status'], { cwd: resolveGitCwd(...) })
 *  - KNOWN-BAD:   execFileSync('git', ['status'], { cwd: projectRoot })
 *
 * Exit code: 0 on clean; 1 on any violation OR self-test mismatch.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

// ── Canonical regex (KEEP IN SYNC with the project-level contract) ──────────
// Captures `(execFileSync|spawnSync|execSync)\(<q>git` to identify a git
// child-process call, where <q> is a string-literal quote (' or ") OR a
// backtick template opener (`). The cwd lookahead is a separate parse step
// (callee may span multiple lines) — we scan a sliding window per match.
//
// B-6666 BLIND SPOT B (backtick): the old regex matched ONLY ['"]git['"] so
// backtick-template forms like execSync(`git status`, { cwd: projectRoot })
// were entirely invisible to the contract (~14 non-smoke backtick git sites
// existed, 4 with a confirmed bare-root cwd). The quote class is now [`'"] and
// the trailing quote requirement is dropped (a backtick template's literal does
// not close before the args), so both literal and template git calls are seen.
const GIT_CALL_REGEX = /(execFileSync|spawnSync|execSync)\([`'"]git/g;

// Bare-cwd antipattern: `cwd:` followed by one of the project-root identifiers
// (no qualifier / call expression). Matches both single-line and multi-line.
const BARE_CWD_REGEX = /\bcwd:\s*(projectRoot|root|metadataRoot)\s*[,}]/;

// ── B-6666 BLIND SPOT A (alias) ─────────────────────────────────────────────
// The d93b69b8f silencing renamed bad roots to a fresh local so the literal
// BARE_CWD_REGEX (which only matches the three bare identifiers AT the cwd:
// site) no longer fired:
//   const gitCwd = projectRoot;            // no resolveGitCwd — still the bad root
//   execSync('git ...', { cwd: gitCwd });  // PASSES the old regex
// This is a no-op alias: it launders a bare projectRoot/root/metadataRoot into a
// new name that is then used as a git cwd, defeating the contract WITHOUT routing
// through resolveGitCwd.
//
// Detection (proximity-scoped — see preMortem #3): we first collect every
// `const <name> = projectRoot|root|metadataRoot;` declaration whose RHS is a
// BARE project-root identifier (no resolveGitCwd / no member access / no call).
// Such a name is a "tainted alias". A tainted alias is a VIOLATION *only* when it
// is subsequently used as the `cwd:` of a git call window — so a legitimate
// `const x = projectRoot` that is never a git cwd is NOT flagged.

// `const <name> = projectRoot|root|metadataRoot ;`  (RHS must be EXACTLY a bare
// project-root identifier; `const x = resolveGitCwd(...)` / `const x = root.foo`
// / `const x = gitCwd ?? root` do NOT match because of the `;` terminator and
// the single-identifier RHS).
const TAINTED_ALIAS_DECL_REGEX = /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(projectRoot|root|metadataRoot)\s*;/g;

// `cwd: <identifier>` — captures the identifier used as a git cwd so it can be
// cross-checked against the tainted-alias set. Bare project-root identifiers are
// already caught by BARE_CWD_REGEX; this catches the laundered-alias case.
const CWD_IDENT_REGEX = /\bcwd:\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[,}]/;

// ── Allowlist ────────────────────────────────────────────────────────────────
// Paths are repository-relative (POSIX separators). A file is exempt if its
// relative path is one of these exact strings OR matches one of the glob-ish
// suffix patterns below.
const ALLOWLIST_EXACT = new Set<string>([
  // The resolver itself probes git while computing the cwd — bootstrap path.
  'packages/main/src/core/story-signed-workspace-resolution.ts',
  // The 3 ad-hoc git helpers explicitly preserved by B-db56.
  'packages/lab/src/handlers/lab.ts',
  'packages/main/src/cli-engine.ts',
  'packages/main/src/core/declared-artifact-commit-check.ts',
  // Static-scan audit task that contains git-call literal STRINGS in its
  // assertion fixtures (the strings themselves are part of the audit).
  'packages/main/src/tasks/main-write-lock-coverage.ts',
]);

// ── B-6666 / B-75f0 NEW-RULES EXEMPTION ALLOWLISTS (split into two sets) ──────
// When B-6666 strengthened this contract to close the alias (BLIND SPOT A) and
// backtick (BLIND SPOT B) blind spots, the strengthened rules surfaced the FULL
// d93b69b8f silencing batch — ~two dozen `const <name> = projectRoot|root|
// metadataRoot;` no-op aliases plus a handful of bare-root backtick / inline-arg
// git calls. B-6666 DEFERRED that whole batch as a single time-boxed follow-up.
//
// B-75f0 BURNED THAT FOLLOW-UP DOWN. It is now split into TWO clearly-separated
// sets so a reviewer can tell a permanent exemption from a pending debt:
//
//   1. BENIGN_BOOTSTRAP_ALLOWLIST (PERMANENT) — self-bootstrap / no-story-context
//      git probes where threading resolveGitCwd is either circular (the call IS
//      the toplevel-discovery step) or meaningless (no store/storyId exists at the
//      site; the cwd is the repo root by construction). These are NOT debt; each
//      carries a one-line rationale. They keep their original "deferred from the
//      NEW alias + backtick rules only" behavior (the original literal-string
//      bare-cwd rule still applies to them).
//
//   2. DEFERRED_ALLOWLIST_EXACT (PENDING BURNDOWN) — now EMPTY. The B-75f0 charter
//      threaded resolveGitCwd into the 13 real wrapper-root sites (CHK-001/002/003)
//      and renamed the 3 lexical false-positives (CHK-004 PART A). Nothing remains
//      pending. If a future story re-introduces a deferrable real site, add it here
//      WITH its tracking B-id — never silently into BENIGN_BOOTSTRAP.
//
// Neither set may contain the 3 CHK-004-renamed files (done-effects.ts,
// handlers/review-run.ts, core/review-run.ts) nor any of the 13 CHK-001/002/003
// fixed sites — those are genuinely resolved now and must face the full ruleset.

// PERMANENT self-bootstrap / no-story-context exemptions. Each entry: a one-line
// reason it is permanently benign (NOT a burndown target).
const BENIGN_BOOTSTRAP_ALLOWLIST = new Set<string>([
  // lab sandbox bootstrap: createSandbox(root) runs `git worktree add` from the
  // repo root to materialize a lab sandbox; the lab subsystem owns its own
  // root-level worktree and has no story store/storyId at the call site.
  'packages/lab/src/core/sandbox.ts',
  // self-bootstrap repo probe: isGitRepo(root) runs `git rev-parse
  // --is-inside-work-tree` purely to answer "is this a git repo at all"; there is
  // no story context and the answer is about `root` itself.
  'packages/main/src/core/rollout-check.ts',
  // detectActiveStoryId branch probe: reads the current branch from the repo root
  // to INFER which story is active — it cannot resolveGitCwd by storyId because
  // discovering the storyId is its whole purpose (chicken-and-egg, no-story-context).
  'packages/main/src/core/stale-detector.ts',
  // detectStoryIdFromBranch: same no-story-context branch probe as stale-detector —
  // reads the branch to derive the storyId, so a storyId-keyed resolve is circular.
  'packages/main/src/handlers/codex-adapter.ts',
  // inferStoryIdFromGit: infers the active story from the repo-root branch before
  // any storyId is known; self-bootstrap discovery, nothing to key a resolve on.
  'packages/main/src/handlers/fixture.ts',
  // branch / status probes: detectActiveStoryFromGit runs `git rev-parse
  // --abbrev-ref HEAD` at ctx.root to INFER the active story before a storyId is
  // in scope (no-story-context, same shape as stale-detector), and the brief's
  // `git status --porcelain` / `git log -3 --oneline` describe the invocation
  // root itself. Worktree enumeration is no longer inline here: since B-41c8
  // CHK-003 session_brief resolves each story through resolveStoryWorkspace
  // (core/story-workspace.ts), which takes gitCwd from resolveGitCwd.
  'packages/main/src/handlers/session.ts',
  // test_auto harness branch bookkeeping: snapshots branches before a full
  // regression and prunes the ones it created afterward, from the repo root; this
  // is test-fixture bookkeeping over the whole repo, not a story-scoped operation.
  'packages/main/src/handlers/test-auto.ts',
  // self-bootstrapping toplevel discovery: `const gitCwd = root` at :43 runs
  // `git rev-parse --show-toplevel` where `root` is the SEARCH ORIGIN (threading
  // resolveGitCwd would be circular); the fixture cleanup (`git restore/clean`)
  // operates on the test-fixture dir, not a story workspace.
  'packages/main/src/handlers/test-runner-core.ts',
  // getRepoRoot(): self-bootstrapping `git rev-parse --show-toplevel` from `root`
  // (root is the search origin, with `?? root` fallback) — discovering the toplevel
  // cannot itself depend on a resolved toplevel; no story context.
  'packages/main/src/handlers/worktree.ts',
  // standalone regression task: `git diff --name-only` from the repo root to list
  // changed files for the test runner; a CLI task with no store/storyId at the site.
  'packages/main/src/tasks/test-runner.ts',
  // trace snapshot bookkeeping: getCurrentCommit(root) reads `git rev-parse HEAD`
  // from the repo root to stamp a trace snapshot, returning 'unknown' on failure;
  // no story context, the commit is the repo's own HEAD.
  'packages/main/src/tasks/trace-store.ts',
  // aux-diagnose (packages/utils): `git diff` from the repo root for a diagnostic
  // report; outside the main package, with no store/storyId — a whole-repo probe.
  'packages/utils/src/handlers/aux-diagnose.ts',
]);

// PENDING BURNDOWN set — EMPTY. B-75f0 closed the B-6666 follow-up: the 13 real
// wrapper-root sites were threaded through resolveGitCwd (CHK-001/002/003) and the
// 3 lexical false-positives were renamed projectRoot→gitCwd (CHK-004 PART A), so
// nothing is pending. Kept as an explicitly-empty set (rather than deleted) so a
// future deferral has an obvious, NAMED home — any new entry MUST carry its
// tracking B-id and is a debt, never a permanent benign exemption.
const DEFERRED_ALLOWLIST_EXACT = new Set<string>([]);

/** Returns true if the repo-relative path is exempt from ALL contract rules. */
function isAllowlisted(repoRelPath: string): boolean {
  if (ALLOWLIST_EXACT.has(repoRelPath)) return true;
  // Smoke tasks (packages/<pkg>/src/tasks/*-smoke.ts) build their own fixtures
  // and are deliberately self-contained git scenarios.
  if (/^packages\/[^/]+\/src\/tasks\/[^/]+-smoke\.ts$/.test(repoRelPath)) return true;
  return false;
}

/**
 * B-6666 / B-75f0: returns true if the file is exempt ONLY from the new alias +
 * backtick-bare-root rules (the original literal-string bare-cwd rule still
 * applies). Covers BOTH the permanent BENIGN_BOOTSTRAP_ALLOWLIST (self-bootstrap /
 * no-story-context probes) and the now-EMPTY pending DEFERRED_ALLOWLIST_EXACT set.
 */
function isDeferredFromNewRules(repoRelPath: string): boolean {
  return BENIGN_BOOTSTRAP_ALLOWLIST.has(repoRelPath) || DEFERRED_ALLOWLIST_EXACT.has(repoRelPath);
}

// ── Detection ────────────────────────────────────────────────────────────────
// Rule kinds the contract enforces, per git-call window (string-literal OR
// backtick template, since B-6666 widened GIT_CALL_REGEX):
//   'bare'  — `cwd:` is one of the three BARE project-root identifiers
//             (projectRoot|root|metadataRoot) directly (BARE_CWD_REGEX).
//   'alias' — `cwd:` is an identifier that was declared earlier in the file as
//             `const <name> = projectRoot|root|metadataRoot;` with no
//             resolveGitCwd (the d93b69b8f laundering). Proximity-scoped: a
//             tainted alias is only a violation when used as a git cwd window's
//             cwd: (a `const x = projectRoot` never used as a git cwd is NOT
//             flagged).
export type ViolationKind = 'bare' | 'alias';

export interface Violation {
  line: number;
  matchedIdent: string;
  kind: ViolationKind;
}

export interface DetectOptions {
  /**
   * When true, only the original literal-string bare-cwd rule is applied (the
   * file is on the B-6666 deferred allowlist for the NEW alias + backtick rules).
   * We still report a 'bare' violation ONLY if it occurs in a STRING-LITERAL git
   * call window — the original B-db56 coverage — never in a backtick window.
   */
  deferredFromNewRules?: boolean;
}

/** Collect the set of tainted no-op alias names declared in the file text. */
function collectTaintedAliases(text: string): Set<string> {
  const names = new Set<string>();
  TAINTED_ALIAS_DECL_REGEX.lastIndex = 0;
  let d: RegExpExecArray | null;
  while ((d = TAINTED_ALIAS_DECL_REGEX.exec(text)) !== null) {
    names.add(d[1]);
  }
  return names;
}

// The ORIGINAL (pre-B-6666) GIT_CALL_REGEX only matched `(...)(['"]git['"]` —
// i.e. `git` immediately followed by the CLOSING quote (`'git'` / `"git"`), the
// execFileSync('git', ['rev-parse', ...]) form. It was BLIND to both backtick
// templates AND inline-arg string literals (execSync('git rev-parse ...', ...)).
// For DEFERRED files we keep the original coverage only — a bare violation in a
// deferred file is reported ONLY if the OLD regex would also have seen it.
const OLD_GIT_CALL_REGEX = /(execFileSync|spawnSync|execSync)\(['"]git['"]/;
function isOldRegexVisible(window: string): boolean {
  return OLD_GIT_CALL_REGEX.test(window);
}

// We scan up to 1500 chars after the match (enough to span a typical multi-
// line options literal). The first `cwd:` we find in that window is treated
// as the call's cwd binding (no nested-call handling — production code does
// not nest git calls inside the options literal).
function detectViolations(text: string, opts: DetectOptions = {}): Violation[] {
  const violations: Violation[] = [];
  const taintedAliases = collectTaintedAliases(text);

  GIT_CALL_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GIT_CALL_REGEX.exec(text)) !== null) {
    const callStart = m.index;
    const window = text.slice(callStart, Math.min(text.length, callStart + 1500));

    // Rule 1: BARE cwd (BARE_CWD_REGEX). For DEFERRED files, only windows the OLD
    // regex would also have seen count (preserves the original B-db56 coverage;
    // the NEW backtick + inline-arg-literal catches are deferred for those files).
    const bare = BARE_CWD_REGEX.exec(window);
    if (bare && !(opts.deferredFromNewRules && !isOldRegexVisible(window))) {
      const offsetOfBare = callStart + bare.index;
      violations.push({ line: countLines(text, offsetOfBare), matchedIdent: bare[1], kind: 'bare' });
      continue; // one violation per window is enough to fail the gate
    }

    // Rules 2/3 are NEW (alias + backtick) — fully skipped for deferred files.
    if (opts.deferredFromNewRules) continue;

    // Rule 2: ALIAS cwd — the cwd: identifier is a tainted no-op alias.
    const cwdIdent = CWD_IDENT_REGEX.exec(window);
    if (cwdIdent && taintedAliases.has(cwdIdent[1])) {
      const offsetOfCwd = callStart + cwdIdent.index;
      violations.push({ line: countLines(text, offsetOfCwd), matchedIdent: cwdIdent[1], kind: 'alias' });
    }
  }
  return violations;
}

// ── Detection: per-file repo scan (reads the file, applies the deferred policy).
function scanFileForViolations(absPath: string, repoRelPath: string): Violation[] {
  const text = readFileSync(absPath, 'utf-8');
  return detectViolations(text, { deferredFromNewRules: isDeferredFromNewRules(repoRelPath) });
}

/** 1-indexed line number of byte `offset` within `text`. */
function countLines(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) n++;
  }
  return n;
}

// ── Self-test fixtures ──────────────────────────────────────────────────────
// We pretend each fixture is a tiny `.ts` file and feed it through the same
// scan function used on the real repo. If our detection logic is broken, this
// surfaces a hard failure BEFORE we scan the codebase.
const SELF_TEST_GOOD = [
  `import { execFileSync } from 'child_process';`,
  `import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';`,
  `export function good(store: any, storyId: string, projectRoot: string) {`,
  `  return execFileSync('git', ['status'], {`,
  `    cwd: resolveGitCwd({ store, storyId, metadataRoot: projectRoot, projectRoot }),`,
  `    encoding: 'utf8',`,
  `  });`,
  `}`,
].join('\n');

const SELF_TEST_BAD = [
  `import { execFileSync } from 'child_process';`,
  `export function bad(projectRoot: string) {`,
  `  return execFileSync('git', ['status'], { cwd: projectRoot, encoding: 'utf8' });`,
  `}`,
].join('\n');

// ── B-6666 self-test fixtures: ALIAS rule (BLIND SPOT A) ─────────────────────
// KNOWN-BAD: the exact d93b69b8f silencing — a no-op `const gitCwd = projectRoot`
// laundered into a git cwd without resolveGitCwd. Must yield EXACTLY 1 violation.
const SELF_TEST_ALIAS_BAD = [
  `import { execSync } from 'child_process';`,
  `export function bad(projectRoot: string) {`,
  `  const gitCwd = projectRoot;`,
  `  return execSync('git', ['status'], { cwd: gitCwd, encoding: 'utf8' });`,
  `}`,
].join('\n');

// KNOWN-GOOD #1: a `const x = projectRoot` that is NEVER used as a git cwd —
// proximity scoping means it must NOT be flagged (preMortem #3).
const SELF_TEST_ALIAS_GOOD_UNUSED = [
  `export function ok(projectRoot: string) {`,
  `  const x = projectRoot;`,
  `  return x.length; // not a git cwd`,
  `}`,
].join('\n');

// KNOWN-GOOD #2: an alias whose value CAME FROM resolveGitCwd, used as a git cwd
// — must NOT be flagged (the RHS is a call, not a bare project-root identifier).
const SELF_TEST_ALIAS_GOOD_RESOLVED = [
  `import { execSync } from 'child_process';`,
  `import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';`,
  `export function good(store: any, storyId: string, projectRoot: string) {`,
  `  const gitCwd = resolveGitCwd({ store, storyId, metadataRoot: projectRoot, projectRoot });`,
  `  return execSync('git', ['status'], { cwd: gitCwd, encoding: 'utf8' });`,
  `}`,
].join('\n');

// ── B-6666 self-test fixtures: BACKTICK rule (BLIND SPOT B) ──────────────────
// KNOWN-BAD: a backtick-template git call with a BARE project-root cwd — invisible
// to the OLD ['"]git['"] regex. Must be flagged ('bare' kind).
const SELF_TEST_BACKTICK_BAD = [
  `import { execSync } from 'child_process';`,
  `export function bad(projectRoot: string) {`,
  '  return execSync(`git status`, { cwd: projectRoot, encoding: \'utf8\' });',
  `}`,
].join('\n');

// KNOWN-GOOD: a backtick-template git call with a resolved cwd — NOT flagged.
const SELF_TEST_BACKTICK_GOOD = [
  `import { execSync } from 'child_process';`,
  `export function good(resolvedGitCwd: string) {`,
  '  return execSync(`git status`, { cwd: resolvedGitCwd, encoding: \'utf8\' });',
  `}`,
].join('\n');

/** Run the same per-file scan logic against an inline string. */
function scanText(text: string): Violation[] {
  return detectViolations(text);
}

// ════════════════════════════════════════════════════════════════════════════
// B-f882 CHK-003: review-preflight docs-drift repoRoot must be the resolved gitCwd
// ════════════════════════════════════════════════════════════════════════════
//
// DEFECT CLASS THIS ADDS (the gap the BARE_CWD_REGEX above could NOT catch):
//   In packages/main/src/handlers/review-preflight.ts, runReviewCliGates resolves
//   `const gitCwd = resolveGitCwd({...})` once and threads it into the
//   channel / concept / english git-invoking gates. The docs-drift gate is invoked
//   via `runDocsDriftGate(mdContents, registryNames, { repoRoot: <X>, ... })`, and
//   `runDocsDriftGate` -> checkPathDrift -> scanPathDrift uses that `repoRoot` as a
//   git child-process cwd (fs.existsSync + `git grep`). The B-f882 bug was
//   `repoRoot: deps.projectRoot` (the metadataRoot) forwarded under the param name
//   `repoRoot` — so on wrapper-root layouts (metadataRoot != gitRoot) docs-drift ran
//   from the non-git metadataRoot, real files looked absent, and REVIEW→TEST was
//   falsely blocked.
//
//   The lexical BARE_CWD_REGEX (`cwd: projectRoot|root|metadataRoot`) is BLIND to
//   this: the bad root was passed as `repoRoot:` (a param-named forward), not a
//   literal `cwd:`, and `runDocsDriftGate` is not a `(execFileSync|spawnSync|
//   execSync)('git', ...)` call site. So a separate, focused assertion is needed.
//
// MECHANISM (tightest robust check):
//   Parse review-preflight.ts, isolate the EXACT `runDocsDriftGate( ... )` call
//   expression (balanced-paren walk so trailing comments/other code stay out of
//   scope), then within that call body assert the `repoRoot:` value token is the
//   resolved `gitCwd` identifier — and explicitly NOT `deps.projectRoot` / bare
//   `projectRoot` / `metadataRoot` / `root`.
//
// COVERAGE — what this DOES catch:
//   - The review-preflight docs-drift gate being wired `repoRoot: deps.projectRoot`
//     (the exact B-f882 / B-0740 param-named-metadataRoot-forward defect for THIS
//     gate), or any of `projectRoot` / `metadataRoot` / `root` as that repoRoot.
//
// COVERAGE — what this does NOT cover (intentional, per CHK-003):
//   - It is review-preflight-specific (single file, single gate call). It is NOT a
//     general repo-wide dataflow guard.
//   - It does not catch param-named root forwards into OTHER gates or other files
//     (e.g. a future new git-invoking gate added to runReviewCliGates with its own
//     repoRoot-like param). A full lexical/AST rewrite that tracks every
//     metadataRoot forward into every git-cwd-consuming callee was judged
//     impractical and out of scope for this checklist; the legitimate
//     `deps.projectRoot` uses in this same file (managedAssetDefs resolution,
//     mdReader, codex summaries) must NOT be flagged, which a broad scan would.
//   - It asserts only the identifier wiring; it does not prove resolveGitCwd's
//     runtime correctness (covered by docs-drift-wrapper-root-smoke / B-2856).

const REVIEW_PREFLIGHT_REL = 'packages/main/src/handlers/review-preflight.ts';
const EXPECTED_DOCS_DRIFT_REPO_ROOT = 'gitCwd';
const FORBIDDEN_REPO_ROOT_TOKENS = new Set<string>([
  'deps.projectRoot',
  'projectRoot',
  'metadataRoot',
  'root',
]);

/**
 * Extract the FULL `runDocsDriftGate( ... )` call expression(s) from source text
 * by walking balanced parens from each `runDocsDriftGate(` token. Returns each
 * call's inner argument text (between the outer parens). Skips the import-list
 * token (`runDocsDriftGate,`) and the JSDoc reference (`runDocsDriftGate `) because
 * those are not immediately followed by `(`.
 */
function extractRunDocsDriftGateCalls(text: string): string[] {
  const calls: string[] = [];
  const CALL_TOKEN = 'runDocsDriftGate(';
  let searchFrom = 0;
  for (;;) {
    const tokenIdx = text.indexOf(CALL_TOKEN, searchFrom);
    if (tokenIdx === -1) break;
    const openParen = tokenIdx + CALL_TOKEN.length - 1; // index of the '('
    let depth = 0;
    let i = openParen;
    let closeIdx = -1;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          closeIdx = i;
          break;
        }
      }
    }
    if (closeIdx === -1) {
      // Unbalanced — treat as a hard parse failure (do not silently pass).
      calls.push(text.slice(openParen + 1)); // best-effort tail for diagnostics
      break;
    }
    calls.push(text.slice(openParen + 1, closeIdx));
    searchFrom = closeIdx + 1;
  }
  return calls;
}

/**
 * Given a `runDocsDriftGate(...)` call's inner-argument text, return the verbatim
 * `repoRoot:` value token (trimmed, up to the next ',' or '}'), or null if the
 * call does not pass a `repoRoot:` option.
 */
function extractRepoRootValue(callArgs: string): string | null {
  const m = /\brepoRoot\s*:\s*([^,}]+)/.exec(callArgs);
  if (!m) return null;
  return m[1].trim();
}

/**
 * Verdict for one source text: returns a violation message, or null if the
 * review-preflight docs-drift `repoRoot:` is wired to `gitCwd`.
 */
function checkDocsDriftRepoRoot(text: string, label: string): string | null {
  const calls = extractRunDocsDriftGateCalls(text);
  if (calls.length === 0) {
    return `${label}: no runDocsDriftGate(...) call found — the review-preflight ` +
      `docs-drift gate this guard protects has moved or been renamed; update ` +
      `gitroot-cwd-contract-smoke.ts (B-f882 CHK-003).`;
  }
  for (const callArgs of calls) {
    const repoRoot = extractRepoRootValue(callArgs);
    if (repoRoot === null) {
      // No repoRoot passed → gate degrades to command-only (no git cwd consumed),
      // which is acceptable wiring (cannot trigger the wrapper-root false-block).
      continue;
    }
    if (FORBIDDEN_REPO_ROOT_TOKENS.has(repoRoot)) {
      return `${label}: runDocsDriftGate(...) repoRoot is '${repoRoot}' — must be ` +
        `the resolved '${EXPECTED_DOCS_DRIFT_REPO_ROOT}' (the value threaded into ` +
        `the channel/concept/english git gates), NOT a metadataRoot forward. ` +
        `Forwarding deps.projectRoot/projectRoot/metadataRoot here makes ` +
        `scanPathDrift run git from the non-git metadataRoot on wrapper-root ` +
        `layouts → false missing-path drift → false REVIEW→TEST block (B-f882).`;
    }
    if (repoRoot !== EXPECTED_DOCS_DRIFT_REPO_ROOT) {
      return `${label}: runDocsDriftGate(...) repoRoot is '${repoRoot}' — expected ` +
        `'${EXPECTED_DOCS_DRIFT_REPO_ROOT}'. If this is an intentional new wiring, ` +
        `update EXPECTED_DOCS_DRIFT_REPO_ROOT in gitroot-cwd-contract-smoke.ts ` +
        `(B-f882 CHK-003) after confirming it is git-root-resolved.`;
    }
  }
  return null;
}

// ── Self-test fixtures for the review-preflight docs-drift repoRoot assertion ──
const DOCS_DRIFT_SELF_TEST_GOOD = [
  `    docsDrift = runDocsDriftGate(mdContents, deps.registryNames, {`,
  `      repoRoot: gitCwd,`,
  `      managedAssetDefs,`,
  `    });`,
].join('\n');

// Negative fixture reproduces the exact B-f882 pre-fix defect: the metadataRoot
// (deps.projectRoot) forwarded under the param name `repoRoot`.
const DOCS_DRIFT_SELF_TEST_BAD = [
  `    docsDrift = runDocsDriftGate(mdContents, deps.registryNames, {`,
  `      repoRoot: deps.projectRoot,`,
  `      managedAssetDefs,`,
  `    });`,
].join('\n');

// ── Main ────────────────────────────────────────────────────────────────────

function listRepoTsFiles(repoRoot: string): string[] {
  // `git ls-files` is the canonical "what is tracked" — keeps the smoke fast
  // and ignores node_modules / dist by default.
  const raw = execSync('git ls-files -z -- "packages/**/*.ts"', {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return raw.split('\0').filter(Boolean);
}

function repoRoot(): string {
  return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
}

function pass(msg: string): void {
  console.log(`✓ ${msg}`);
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ── Step 0: self-test ───────────────────────────────────────────────────────
const goodHits = scanText(SELF_TEST_GOOD);
if (goodHits.length !== 0) {
  fail(
    `self-test KNOWN-GOOD fixture produced ${goodHits.length} false-positive ` +
    `violation(s) — detection logic is over-aggressive. Hit(s): ` +
    goodHits.map(h => `line ${h.line} (${h.matchedIdent})`).join(', '),
  );
}
pass('self-test: KNOWN-GOOD fixture produces 0 violations');

const badHits = scanText(SELF_TEST_BAD);
if (badHits.length !== 1 || badHits[0].matchedIdent !== 'projectRoot') {
  fail(
    `self-test KNOWN-BAD fixture must produce EXACTLY one violation on ` +
    `'projectRoot' — got ${badHits.length}: ` +
    JSON.stringify(badHits),
  );
}
pass('self-test: KNOWN-BAD fixture produces exactly 1 violation on projectRoot');

// ── Step 0a: B-6666 ALIAS rule self-tests (BLIND SPOT A) ─────────────────────
const aliasBadHits = scanText(SELF_TEST_ALIAS_BAD);
if (aliasBadHits.length !== 1 || aliasBadHits[0].kind !== 'alias' || aliasBadHits[0].matchedIdent !== 'gitCwd') {
  fail(
    `self-test ALIAS KNOWN-BAD fixture (const gitCwd = projectRoot used as git cwd) ` +
    `must produce EXACTLY one 'alias' violation on 'gitCwd' — got ` +
    JSON.stringify(aliasBadHits),
  );
}
pass('self-test: ALIAS KNOWN-BAD (const gitCwd = projectRoot → git cwd) produces exactly 1 alias violation');

const aliasGoodUnusedHits = scanText(SELF_TEST_ALIAS_GOOD_UNUSED);
if (aliasGoodUnusedHits.length !== 0) {
  fail(
    `self-test ALIAS KNOWN-GOOD (const x = projectRoot NOT used as git cwd) was ` +
    `flagged — alias rule is not proximity-scoped (preMortem #3). Hit(s): ` +
    JSON.stringify(aliasGoodUnusedHits),
  );
}
pass('self-test: ALIAS KNOWN-GOOD (const x = projectRoot, not a git cwd) produces 0 violations');

const aliasGoodResolvedHits = scanText(SELF_TEST_ALIAS_GOOD_RESOLVED);
if (aliasGoodResolvedHits.length !== 0) {
  fail(
    `self-test ALIAS KNOWN-GOOD (const gitCwd = resolveGitCwd(...) used as git cwd) ` +
    `was flagged — a resolved alias must NOT count as tainted. Hit(s): ` +
    JSON.stringify(aliasGoodResolvedHits),
  );
}
pass('self-test: ALIAS KNOWN-GOOD (const gitCwd = resolveGitCwd(...) → git cwd) produces 0 violations');

// ── Step 0c: B-6666 BACKTICK rule self-tests (BLIND SPOT B) ──────────────────
const backtickBadHits = scanText(SELF_TEST_BACKTICK_BAD);
if (backtickBadHits.length !== 1 || backtickBadHits[0].kind !== 'bare' || backtickBadHits[0].matchedIdent !== 'projectRoot') {
  fail(
    `self-test BACKTICK KNOWN-BAD fixture (execSync(\`git ...\`, { cwd: projectRoot })) ` +
    `must produce EXACTLY one 'bare' violation on 'projectRoot' — got ` +
    JSON.stringify(backtickBadHits),
  );
}
pass('self-test: BACKTICK KNOWN-BAD (execSync(`git`, { cwd: projectRoot })) produces exactly 1 bare violation');

const backtickGoodHits = scanText(SELF_TEST_BACKTICK_GOOD);
if (backtickGoodHits.length !== 0) {
  fail(
    `self-test BACKTICK KNOWN-GOOD (execSync(\`git ...\`, { cwd: resolvedGitCwd })) was ` +
    `flagged — backtick rule must not false-positive on a resolved cwd. Hit(s): ` +
    JSON.stringify(backtickGoodHits),
  );
}
pass('self-test: BACKTICK KNOWN-GOOD (execSync(`git`, { cwd: resolvedGitCwd })) produces 0 violations');

// ── Step 0b: self-test the review-preflight docs-drift repoRoot assertion ─────
const docsDriftGoodViolation = checkDocsDriftRepoRoot(DOCS_DRIFT_SELF_TEST_GOOD, 'self-test GOOD');
if (docsDriftGoodViolation !== null) {
  fail(
    `self-test docs-drift KNOWN-GOOD fixture (repoRoot: gitCwd) wrongly flagged: ` +
    docsDriftGoodViolation,
  );
}
pass('self-test: docs-drift KNOWN-GOOD fixture (repoRoot: gitCwd) produces 0 violations');

const docsDriftBadViolation = checkDocsDriftRepoRoot(DOCS_DRIFT_SELF_TEST_BAD, 'self-test BAD');
if (docsDriftBadViolation === null) {
  fail(
    `self-test docs-drift KNOWN-BAD fixture (repoRoot: deps.projectRoot) was NOT ` +
    `flagged — the review-preflight docs-drift assertion is broken.`,
  );
}
pass('self-test: docs-drift KNOWN-BAD fixture (repoRoot: deps.projectRoot) is flagged');

// ── Step 1: scan the live repo ──────────────────────────────────────────────
const root = repoRoot();
const files = listRepoTsFiles(root);

const violations: string[] = [];
for (const rel of files) {
  if (isAllowlisted(rel)) continue;
  const abs = isAbsolute(rel) ? rel : resolve(root, rel);
  const hits = scanFileForViolations(abs, rel);
  for (const hit of hits) {
    const detail = hit.kind === 'alias'
      ? `no-op alias '${hit.matchedIdent}' (= bare projectRoot/root/metadataRoot) used as git ` +
        `cwd — this launders a bare root past the contract (the d93b69b8f shape); ` +
        `assign it from resolveGitCwd(...) instead`
      : `bare projectRoot/root/metadataRoot used as git cwd — route through resolveGitCwd`;
    violations.push(
      `${abs}:${hit.line}: ${detail} ` +
      `(packages/main/src/core/story-signed-workspace-resolution.ts)`,
    );
  }
}

if (violations.length > 0) {
  console.error('\n✗ gitroot-cwd-contract smoke FAILED');
  console.error(`Found ${violations.length} bare-cwd git call site(s):`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    '\nFix: at each site, replace the bare projectRoot/root/metadataRoot cwd\n' +
    'with the value of resolveGitCwd(...) (story-keyed) or with an already-\n' +
    'resolved gitCwd local variable. Allowlist policy is at the top of\n' +
    'packages/main/src/tasks/gitroot-cwd-contract-smoke.ts.',
  );
  process.exit(1);
}

pass(`repo scan clean: ${files.length} .ts files inspected, 0 bare-cwd violations`);

// ── Step 2: live review-preflight docs-drift repoRoot assertion (B-f882) ──────
const reviewPreflightAbs = join(root, REVIEW_PREFLIGHT_REL);
let reviewPreflightText: string;
try {
  reviewPreflightText = readFileSync(reviewPreflightAbs, 'utf-8');
} catch (e) {
  fail(
    `cannot read ${REVIEW_PREFLIGHT_REL} for the docs-drift repoRoot assertion ` +
    `(${e instanceof Error ? e.message : String(e)}) — the file this guard ` +
    `protects has moved; update gitroot-cwd-contract-smoke.ts (B-f882 CHK-003).`,
  );
}
const docsDriftViolation = checkDocsDriftRepoRoot(reviewPreflightText, reviewPreflightAbs);
if (docsDriftViolation !== null) {
  console.error('\n✗ gitroot-cwd-contract smoke FAILED (review-preflight docs-drift)');
  console.error(`  ${docsDriftViolation}`);
  process.exit(1);
}
pass(`review-preflight docs-drift gate wires repoRoot: ${EXPECTED_DOCS_DRIFT_REPO_ROOT} (not metadataRoot)`);

console.log('\n✓ gitroot-cwd-contract smoke passed');
