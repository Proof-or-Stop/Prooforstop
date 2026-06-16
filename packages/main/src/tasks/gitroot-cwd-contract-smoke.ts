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
import { isAbsolute, resolve } from 'node:path';

// ── Canonical regex (KEEP IN SYNC with the project-level contract) ──────────
// Captures `(execFileSync|spawnSync|execSync)\(['"]git['"]` to identify a git
// child-process call. The cwd lookahead is a separate parse step (callee may
// span multiple lines) — we scan a sliding window per match.
const GIT_CALL_REGEX = /(execFileSync|spawnSync|execSync)\(['"]git['"]/g;

// Bare-cwd antipattern: `cwd:` followed by one of the project-root identifiers
// (no qualifier / call expression). Matches both single-line and multi-line.
const BARE_CWD_REGEX = /\bcwd:\s*(projectRoot|root|metadataRoot)\s*[,}]/;

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

/** Returns true if the repo-relative path should be skipped by the contract. */
function isAllowlisted(repoRelPath: string): boolean {
  if (ALLOWLIST_EXACT.has(repoRelPath)) return true;
  // Smoke tasks (packages/<pkg>/src/tasks/*-smoke.ts) build their own fixtures
  // and are deliberately self-contained git scenarios.
  if (/^packages\/[^/]+\/src\/tasks\/[^/]+-smoke\.ts$/.test(repoRelPath)) return true;
  return false;
}

// ── Detection: given a file's text + a byte offset of a git-call match,
//    look ahead for the call's cwd: argument. Returns the violation column +
//    line number, or null when the call's cwd source is acceptable.
//
// We scan up to 1500 chars after the match (enough to span a typical multi-
// line options literal). The first `cwd:` we find in that window is treated
// as the call's cwd binding (no nested-call handling — production code does
// not nest git calls inside the options literal).
function scanFileForViolations(absPath: string, repoRelPath: string): Array<{ line: number; matchedIdent: string }> {
  const text = readFileSync(absPath, 'utf-8');
  const violations: Array<{ line: number; matchedIdent: string }> = [];

  GIT_CALL_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GIT_CALL_REGEX.exec(text)) !== null) {
    const callStart = m.index;
    const window = text.slice(callStart, Math.min(text.length, callStart + 1500));
    const bare = BARE_CWD_REGEX.exec(window);
    if (!bare) continue;
    // Compute the absolute line number of the BARE-CWD position (not the git
    // call): the error must point at the offending `cwd:` line so the user can
    // jump straight to the bug.
    const offsetOfBare = callStart + bare.index;
    const line = countLines(text, offsetOfBare);
    violations.push({ line, matchedIdent: bare[1] });
  }
  return violations;
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

/** Run the same per-file scan logic against an inline string. */
function scanText(text: string): Array<{ line: number; matchedIdent: string }> {
  const out: Array<{ line: number; matchedIdent: string }> = [];
  GIT_CALL_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GIT_CALL_REGEX.exec(text)) !== null) {
    const callStart = m.index;
    const window = text.slice(callStart, Math.min(text.length, callStart + 1500));
    const bare = BARE_CWD_REGEX.exec(window);
    if (!bare) continue;
    const offsetOfBare = callStart + bare.index;
    out.push({ line: countLines(text, offsetOfBare), matchedIdent: bare[1] });
  }
  return out;
}

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

// ── Step 1: scan the live repo ──────────────────────────────────────────────
const root = repoRoot();
const files = listRepoTsFiles(root);

const violations: string[] = [];
for (const rel of files) {
  if (isAllowlisted(rel)) continue;
  const abs = isAbsolute(rel) ? rel : resolve(root, rel);
  const hits = scanFileForViolations(abs, rel);
  for (const hit of hits) {
    violations.push(
      `${abs}:${hit.line}: bare projectRoot/root/metadataRoot used as git ` +
      `cwd — route through resolveGitCwd ` +
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
console.log('\n✓ gitroot-cwd-contract smoke passed');
