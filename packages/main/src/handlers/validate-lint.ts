/**
 * validate-lint — CLI gate: tsc + ruff + import-graph boundaries
 *
 * proof-or-stop validate runs three lint categories before spawning validate.ts by default; any failure causes overall failure
 * and returns early without spawning. When tools are unavailable (tsc missing, ruff not installed) or the corresponding config file does not exist
 * → that sub-check is skipped, and the overall result does not fail because of it (graceful degrade).
 *
 * Three sub-checks:
 *   (a) tsc --noEmit        — if projectRoot/tsconfig.json exists
 *   (b) ruff check          — if projectRoot/pyproject.toml exists and ruff is available
 *   (c) import-graph boundaries — scan src/shells/**\/*.ts, forbid importing any `.../fn` or `.../fn.js`
 *
 * Output structure:
 *   {
 *     provider: "proof-or-stop-lint",
 *     status: "pass" | "fail" | "skipped",
 *     summary: string,
 *     details: string[],
 *     checks: {
 *       tsc?: { status, output? },
 *       ruff?: { status, output? },
 *       importGraph?: { status, violations: { file, line, importee }[] }
 *     }
 *   }
 *
 * See docs/reviewer-redesign.md §3 S1 item 3.
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { DEFAULT_BASE } from './validate-shared.js';

// B-5a28 CHK-002: directories to skip when recursively scanning tsconfig. Extracted as a constant for test coverage +
// to be extended by future stories as needed. Does not include common IDE/editor directories (.idea / .vscode won't have
// tsconfig pollution). `.worktrees` prevents a sub-agent in its own worktree from scanning into
// other stories' worktrees (self-recursion).
export const TSCONFIG_IGNORE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  '.worktrees',
  '.git',
]);

// LintSubStatus / TscCheck / RuffCheck / ImportGraphViolation /
// ImportGraphCheck / LintChecks are internal shapes consumed only by
// this module and its tests — kept non-exported per F-005 (tests import
// from this file directly, not from the package boundary). Downstream
// callers (review-preflight.ts) only need LintResult / CommandRunner /
// FileExists / FileReader, which remain exported.
type LintSubStatus = 'pass' | 'fail' | 'skipped';

interface TscCheck {
  status: LintSubStatus;
  /** Tool error / output snippet (optional when skipped) */
  output?: string;
  /**
   * B-a749: detail lines for out-of-scope tsconfigs that were skipped because
   * their package has no node_modules. Each entry is the full detail line, e.g.
   * `[lint] skipped: clawcreek/frontend/tsconfig.json (out of scope, deps absent)`.
   * These are advisory (skip != fail) and do NOT flip overall status to fail.
   */
  scopeSkips?: string[];
}

interface RuffCheck {
  status: LintSubStatus;
  output?: string;
}

interface ImportGraphViolation {
  file: string;
  line: number;
  importee: string;
}

interface ImportGraphCheck {
  status: LintSubStatus;
  violations: ImportGraphViolation[];
}

interface LintChecks {
  tsc?: TscCheck;
  ruff?: RuffCheck;
  importGraph?: ImportGraphCheck;
}

export interface LintResult {
  provider: 'proof-or-stop-lint';
  status: LintSubStatus;
  summary: string;
  details: string[];
  checks: LintChecks;
}

// ── Dependency injection ──

export interface CommandRunner {
  /**
   * Execute a command, return { code, output, spawnError }.
   * spawnError=true means the binary does not exist (ENOENT) — callers should treat this as skipped.
   */
  (cmd: string, args: string[], cwd: string): {
    code: number;
    output: string;
    spawnError: boolean;
  };
}

const defaultRunner: CommandRunner = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
    shell: false,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { code: -1, output: r.error.message, spawnError: true };
    }
    return { code: r.status ?? 1, output: (r.stdout ?? '') + (r.stderr ?? '') + r.error.message, spawnError: false };
  }
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  return { code: r.status ?? 1, output: out, spawnError: false };
};

/** File enumerator (injectable for tests) */
export type FileReader = (filePath: string) => string;
export type FileExists = (filePath: string) => boolean;

// ── change-scope (B-a749) ──

/**
 * B-a749: reads the set of repo-relative paths changed vs the base branch
 * (default `main`). Injectable for tests. Mirrors validate-concept.ts'
 * `GitDiffReader` pattern; the default uses `git diff --name-only main...HEAD`.
 *
 * Contract: returns the raw multi-line `git diff --name-only` output (one
 * repo-relative path per line). On ANY failure (no merge-base, detached HEAD,
 * orphan branch, git throwing) it MUST throw, and callers fall back to a full
 * recursive tsc (never skip-all). See `resolveChangedFiles`.
 */
export type ChangedFilesReader = (args: { base: string; projectRoot: string; gitCwd?: string }) => string;

const defaultChangedFilesReader: ChangedFilesReader = ({ base, projectRoot, gitCwd }) => {
  // B-0740 CHK-002: run `git diff` from the resolved gitRoot (gitCwd) when it is
  // known. On wrapper-root layouts (metadataRoot != gitRoot) projectRoot is NOT a
  // git repo → diffing from projectRoot throws → resolveChangedFiles falls back to
  // full recursive tsc instead of scoping. Default to projectRoot (plain repos:
  // gitCwd unset or == projectRoot → byte-identical to the prior behavior).
  return execSync(`git diff --name-only ${base}...HEAD`, {
    cwd: gitCwd ?? projectRoot,
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  });
};

/**
 * B-a749: resolve the change-scope into a normalized list of repo-relative
 * paths, or `undefined` when no reliable scope can be determined.
 *
 * `undefined` is the safe sentinel that means "no scope → run full recursive
 * tsc" (NEVER skip-all). It is returned ONLY when the reader throws (no
 * merge-base / detached HEAD / orphan branch / git error).
 *
 * Resolution order:
 *   - if a pre-resolved `changedFiles` array is passed, it is used as-is (after
 *     normalization). An EMPTY array is a real, valid scope (nothing changed vs
 *     base) and is returned as `[]` — distinct from `undefined`.
 *   - otherwise the reader (default: `git diff --name-only main...HEAD`) is run.
 *     The default reader is wired here so the production story path resolves a
 *     real scope; tests inject a stub reader (including a throwing stub) to
 *     simulate success AND failure.
 *
 * B-0740 CHK-002 — gitCwd rebase (base consistency):
 *   `git diff --name-only` emits paths relative to the git repo cwd (`gitCwd`,
 *   the resolved gitRoot), but the whole downstream pipeline
 *   (`computeOutOfScopeTsconfigs` / `findTsconfigs`) is `projectRoot`-relative.
 *   On wrapper-root layouts (gitRoot != projectRoot) those two bases differ, so
 *   the gitRoot-relative diff paths are rebased to projectRoot-relative via
 *   `relative(projectRoot, join(gitCwd, rawPath))` to preserve the single
 *   projectRoot relativity base. When `gitCwd` is unset OR equals `projectRoot`
 *   (plain repo), the rebase is the IDENTITY transform → output byte-identical.
 *   The rebase runs AFTER the throw boundary: a throwing reader still yields
 *   `undefined` (full tsc, never skip-all) and a genuinely empty diff still
 *   yields `[]` (valid empty scope) — a throw is NEVER converted into `[]`.
 */
export function resolveChangedFiles(deps: {
  /** Pre-resolved repo-relative changed paths (used as-is if provided). */
  changedFiles?: string[];
  /** Reader (default: git diff --name-only main...HEAD). Inject a throwing stub to test fallback. */
  changedFilesReader?: ChangedFilesReader;
  projectRoot: string;
  /** Resolved gitRoot to run `git diff` from + rebase its output. Default/equal projectRoot → identity. */
  gitCwd?: string;
  base?: string;
}): string[] | undefined {
  if (deps.changedFiles !== undefined) {
    // Pre-resolved array path: caller already supplied projectRoot-relative paths.
    // gitCwd rebase only applies to the reader path (raw git-diff output).
    return normalizeChangedPaths(deps.changedFiles);
  }
  const reader = deps.changedFilesReader ?? defaultChangedFilesReader;
  let raw: string;
  try {
    raw = reader({ base: deps.base ?? DEFAULT_BASE, projectRoot: deps.projectRoot, gitCwd: deps.gitCwd });
  } catch {
    // git diff failed (no base / orphan / detached HEAD / git throwing):
    // do NOT skip-all — return undefined so callers run full recursive tsc.
    return undefined;
  }
  const lines = raw.split('\n');
  // Rebase AFTER the throw boundary. Only when gitCwd is set AND differs from
  // projectRoot (wrapper-root); otherwise identity (plain repo, byte-identical).
  if (deps.gitCwd && deps.gitCwd !== deps.projectRoot) {
    const rebased: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue; // preserve the empty-line drop; an empty diff stays []
      // gitRoot-relative → absolute → projectRoot-relative. Paths outside
      // projectRoot become `..`-prefixed; isPathUnderDir simply never matches
      // them (correctly out-of-scope for projectRoot tsconfigs).
      rebased.push(relative(deps.projectRoot, join(deps.gitCwd, t)));
    }
    return normalizeChangedPaths(rebased);
  }
  return normalizeChangedPaths(lines);
}

/** Normalize raw changed-path lines: trim, drop empties, strip leading "./", backslash → slash. */
function normalizeChangedPaths(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const cleaned = t.replace(/\\/g, '/').replace(/^\.\//, '');
    if (cleaned) out.push(cleaned);
  }
  return out;
}

/**
 * B-a749: given the discovered tsconfigs (absolute paths) and a resolved
 * change-scope, return the set of tsconfig absolute paths that are OUT of scope
 * (i.e. NO changed file lives under their directory subtree).
 *
 * Fail-closed semantics (preMortem 1 / adversarial):
 *   - `changedFiles === undefined` → NO scope → return empty set (everything
 *     is in-scope; full recursive tsc).
 *   - If ANY changed file maps to ZERO tsconfig subtrees, the change-scope is
 *     ambiguous and we cannot safely declare anything out-of-scope → return
 *     empty set (treat all as in-scope). This is the conservative "when in
 *     doubt, check it" rule.
 *   - Otherwise a tsconfig is out-of-scope iff none of the changed files lives
 *     under its directory.
 *
 * "Under the directory" = relative-path prefix: the changed file's repo-relative
 * path, after the tsconfig's repo-relative directory, must be either exactly the
 * dir or descend into it (the next char is a path separator).
 */
export function computeOutOfScopeTsconfigs(deps: {
  tsconfigs: string[];
  projectRoot: string;
  changedFiles: string[] | undefined;
}): Set<string> {
  const { tsconfigs, projectRoot, changedFiles } = deps;
  // No scope → nothing is out of scope (full recursive tsc).
  if (changedFiles === undefined) return new Set<string>();

  // Map each tsconfig to its repo-relative directory (normalized, no trailing slash).
  const tsconfigDirs = tsconfigs.map((tsconfigPath) => {
    const relDir = relative(projectRoot, dirname(tsconfigPath)).replace(/\\/g, '/');
    return { tsconfigPath, relDir };
  });

  // Fail-closed: if any changed file maps to no tsconfig subtree, treat all as in-scope.
  for (const file of changedFiles) {
    const anyMatch = tsconfigDirs.some(({ relDir }) => isPathUnderDir(file, relDir));
    if (!anyMatch) {
      return new Set<string>();
    }
  }

  const outOfScope = new Set<string>();
  for (const { tsconfigPath, relDir } of tsconfigDirs) {
    const inScope = changedFiles.some((file) => isPathUnderDir(file, relDir));
    if (!inScope) outOfScope.add(tsconfigPath);
  }
  return outOfScope;
}

/**
 * Whether `file` (repo-relative) lives under `dir` (repo-relative, normalized).
 * The repo root is represented by relDir === '' (or '.'), which contains every file.
 */
export function isPathUnderDir(file: string, dir: string): boolean {
  const f = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const d = dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (d === '' || d === '.') return true; // root dir contains everything
  return f === d || f.startsWith(`${d}/`);
}

/**
 * B-a749: probe whether the package owning `tsconfigPath` has node_modules.
 * "Owning package directory" = nearest ancestor (starting at the tsconfig's
 * own directory, walking up to projectRoot) that contains a package.json; if
 * none is found, the tsconfig's own directory is used. The presence probe uses
 * the injectable `FileExists` so the smoke test needs no real install.
 */
export function packageHasNodeModules(
  tsconfigPath: string,
  projectRoot: string,
  fileExists: FileExists,
): boolean {
  const pkgDir = resolvePackageDir(tsconfigPath, projectRoot, fileExists);
  try {
    return fileExists(join(pkgDir, 'node_modules'));
  } catch {
    // Probe failure: fail-closed toward "deps present" so an in-scope-looking
    // tsconfig is never silently skipped for deps reasons (skip is reserved for
    // out-of-scope only; this helper is only called on out-of-scope tsconfigs,
    // but a probe error here should not flip behavior unpredictably). Treating
    // as "present" means we still run tsc (defense-in-depth, B-5a28 spirit).
    return true;
  }
}

/** Nearest ancestor dir (tsconfig dir → ... → projectRoot) containing package.json. */
function resolvePackageDir(
  tsconfigPath: string,
  projectRoot: string,
  fileExists: FileExists,
): string {
  let dir = dirname(tsconfigPath);
  // Walk up until we leave projectRoot's subtree (or hit fs root).
  // Guard against infinite loops via a bounded ascent.
  for (let i = 0; i < 64; i++) {
    try {
      if (fileExists(join(dir, 'package.json'))) return dir;
    } catch {
      // ignore and keep ascending
    }
    const parent = dirname(dir);
    if (parent === dir) break; // fs root
    // Stop ascending once we go above projectRoot.
    const relToRoot = relative(projectRoot, dir);
    if (relToRoot === '' || relToRoot === '.' || relToRoot.startsWith('..')) break;
    dir = parent;
  }
  return dirname(tsconfigPath);
}

// ── tsc ──

/**
 * B-5a28 CHK-002: recursively enumerate all tsconfig.json under projectRoot.
 *
 * Why recursive: compilation errors in monorepo sub-packages (e.g. a nested packages/<sub>/packages/main/tsconfig.json)
 * were missed by single-root scanning — an entire sub-package's TS2451 compilation errors were only found by an independent sonnet reviewer after the
 * two stories B-9bd9 / B-9d95 reached DONE. The root cause was that the old runTsc hardcoded
 * `<projectRoot>/tsconfig.json`, and the avalon root has no tsconfig.json → skipped → sub-package errors
 * were never visible.
 *
 * Excludes TSCONFIG_IGNORE_DIRS (node_modules / dist / build / .worktrees / .git),
 * otherwise it would scan into tsconfigs inside dependencies or copies of adjacent worktrees.
 *
 * **F-005 symlink protection**: defaults to `lstatSync` (does not follow symlinks), and always skips
 * symlink directories. Rationale: in npm link / pnpm / workspace protocol scenarios, symlinks under node_modules
 * often point back to the repo root or other package directories; if stat() follows these links,
 * TSCONFIG_IGNORE_DIRS name matching only prunes "directories named node_modules" and cannot handle "node_modules targets reached via
 * symlink", leading to infinite recursion / unbounded stack growth. Skipping
 * symlinks is simpler than a visited realpath Set and has zero collateral damage (needing to scan into symlink targets
 * is an extremely rare edge case; add a followSymlinks switch if it ever becomes a real need).
 *
 * Returns an **array of absolute paths** (relies on fileExists to check directory existence; readdir/stat can be injected for
 * unit test fixturing). Failure paths (stat/readdir throwing) are silently skipped, not failing the entire scan.
 *
 * **Signature**: `findTsconfigs(projectRoot, deps?: { readdir?, stat?, fileExists? })`.
 * The second parameter is a **dependency injection interface** (not options) — the blacklist is fixed by the module-level constant
 * TSCONFIG_IGNORE_DIRS; extensions require modifying the constant, not passing from the caller.
 */
export function findTsconfigs(
  projectRoot: string,
  deps?: {
    readdir?: (p: string) => string[];
    stat?: (p: string) => { isDirectory(): boolean; isFile(): boolean; isSymbolicLink?(): boolean };
    fileExists?: FileExists;
  },
): string[] {
  const readdir = deps?.readdir ?? ((p) => readdirSync(p));
  // F-005: defaults to lstat (does not follow symlinks), while preserving the deps.stat injection interface;
  // an injected stat should also provide isSymbolicLink() to skip symlinks the same way (tests may omit).
  const stat = deps?.stat ?? ((p) => lstatSync(p));
  const fileExists = deps?.fileExists ?? existsSync;
  try {
    if (!fileExists(projectRoot)) return [];
  } catch {
    return [];
  }
  const out: string[] = [];
  const stack: string[] = [projectRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdir(dir); } catch { continue; }
    for (const e of entries) {
      if (TSCONFIG_IGNORE_DIRS.has(e)) continue;
      const full = join(dir, e);
      let s: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink?(): boolean };
      try { s = stat(full); } catch { continue; }
      // F-005: always skip symlinks to prevent infinite recursion caused by npm link pointing back to the repo root / other packages.
      if (typeof s.isSymbolicLink === 'function' && s.isSymbolicLink()) continue;
      if (s.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!s.isFile()) continue;
      if (e === 'tsconfig.json') out.push(full);
    }
  }
  // Stable ordering for test assertion convenience + readable failure output
  out.sort();
  return out;
}

/**
 * Run `npx tsc --noEmit -p <tsconfigPath>` for a single tsconfig.
 *
 * Return values:
 *   - { kind: 'pass' }
 *   - { kind: 'fail', output }
 *   - { kind: 'toolMissing', output } — tools (tsc / npx) are all unavailable
 */
function runSingleTsc(
  tsconfigPath: string,
  cwd: string,
  run: CommandRunner,
): { kind: 'pass' } | { kind: 'fail'; output: string } | { kind: 'toolMissing'; output: string } {
  const attempts: Array<{ cmd: string; args: string[] }> = [
    { cmd: 'npx', args: ['--no-install', 'tsc', '--noEmit', '-p', tsconfigPath] },
    { cmd: 'tsc', args: ['--noEmit', '-p', tsconfigPath] },
  ];
  let lastOutput = '';
  for (const { cmd, args } of attempts) {
    const r = run(cmd, args, cwd);
    if (r.spawnError) {
      lastOutput = r.output;
      continue;
    }
    // F-018: npx exit non-zero + output like "could not determine executable" is treated as tool missing
    if (isNpxToolNotFound(r.output)) {
      lastOutput = r.output;
      continue;
    }
    return r.code === 0
      ? { kind: 'pass' }
      : { kind: 'fail', output: r.output.trim() };
  }
  return { kind: 'toolMissing', output: lastOutput };
}

/**
 * B-5a28 CHK-002: recursively scan all tsconfig.json under projectRoot and run `tsc --noEmit -p` on each one by one.
 *
 * Overall rules:
 *   - Empty result (no tsconfig at all) → skipped, output='no tsconfig.json found'
 *   - Any tool missing causing no tsc to be runnable → skipped, output='tsc not found: ...'
 *     (i.e., if the first tsconfig is toolMissing, subsequent ones inevitably are too — short-circuit directly)
 *   - Any tsconfig fail → overall fail; output aggregates all failed tsconfigs'
 *     paths + compiler output, so humans and cluster reviewers can locate them
 *   - All pass → overall pass, output='tsc: checked N tsconfigs'
 *     (format fixed as "tsc: checked N tsconfigs", N=number of tsconfigs scanned)
 *
 * Interface unchanged: still accepts projectRoot + optional run/fileExists; additionally accepts readdir/stat
 * injected into findTsconfigs, so CHK-003 unit tests don't actually scan disk.
 */
export function runTsc(deps: {
  projectRoot: string;
  run?: CommandRunner;
  fileExists?: FileExists;
  readdir?: (p: string) => string[];
  stat?: (p: string) => { isDirectory(): boolean; isFile(): boolean };
  /**
   * B-a749: optional change-scope (repo-relative paths changed vs base).
   * - `undefined` → no scope → full recursive tsc (unchanged legacy behavior).
   * - an array → tsconfigs whose subtree contains no changed file are
   *   "out of scope"; an out-of-scope tsconfig whose package lacks node_modules
   *   is skipped-with-warning (deps absent) instead of hard-failing on TS2307.
   * Empty array is a real scope (nothing changed) — every tsconfig is out of
   * scope and deps-absent ones are skipped.
   */
  changedFiles?: string[];
}): TscCheck {
  const run = deps.run ?? defaultRunner;
  const fileExists = deps.fileExists ?? existsSync;
  const tsconfigs = findTsconfigs(deps.projectRoot, {
    readdir: deps.readdir,
    stat: deps.stat,
    fileExists: deps.fileExists,
  });
  if (tsconfigs.length === 0) {
    return { status: 'skipped', output: 'no tsconfig.json found' };
  }

  // B-a749: compute out-of-scope tsconfigs from the change-scope. When no scope
  // is provided, this is empty (nothing out of scope → full recursive tsc).
  const outOfScope = computeOutOfScopeTsconfigs({
    tsconfigs,
    projectRoot: deps.projectRoot,
    changedFiles: deps.changedFiles,
  });
  const scopeSkips: string[] = [];

  // F-007 / F-014: Explicitly track passes count, don't use fails.length === 0 as a proxy for "never ran".
  // The old code path [pass, pass, toolMissing] would erroneously short-circuit and return skipped,
  // swallowing all the prior pass results. Correct semantics:
  //   - "no tsc ever started successfully" (passes=0 && fails=0) → skipped
  //   - "at least one ran" → any subsequent toolMissing is recorded as fail (don't silently swallow)
  const fails: Array<{ path: string; output: string }> = [];
  let passes = 0;
  for (const tsconfig of tsconfigs) {
    // B-a749: out-of-scope tsconfig whose package has no node_modules → skip
    // with warning rather than hard-failing on TS2307. In-scope tsconfigs are
    // NEVER deps-absent-skipped — they keep ENOENT(skip)/non-zero-exit(fail)
    // semantics below (preMortem 2). Out-of-scope WITH node_modules present →
    // still run tsc (defense-in-depth, B-5a28 spirit).
    if (outOfScope.has(tsconfig) && !packageHasNodeModules(tsconfig, deps.projectRoot, fileExists)) {
      const rel = relative(deps.projectRoot, tsconfig) || tsconfig;
      scopeSkips.push(`[lint] skipped: ${rel} (out of scope, deps absent)`);
      continue;
    }
    const r = runSingleTsc(tsconfig, deps.projectRoot, run);
    if (r.kind === 'toolMissing') {
      // Tool missing: only treat as skipped when "never had a pass and never had a fail".
      if (passes === 0 && fails.length === 0) {
        return withScopeSkips({ status: 'skipped', output: `tsc not found: ${r.output}` }, scopeSkips);
      }
      // If a pass or fail occurred earlier (proving the tool can run), a sudden later toolMissing is odd;
      // record it as a fail so it's visible — don't let earlier passes be silently swallowed.
      fails.push({ path: tsconfig, output: `tsc tool missing: ${r.output}` });
      continue;
    }
    if (r.kind === 'fail') {
      fails.push({ path: tsconfig, output: r.output });
      continue;
    }
    // r.kind === 'pass'
    passes++;
  }

  if (fails.length > 0) {
    const header = `tsc: ${fails.length} of ${tsconfigs.length} tsconfig${tsconfigs.length === 1 ? '' : 's'} failed`;
    const body = fails.map(f => {
      const rel = relative(deps.projectRoot, f.path) || f.path;
      return `=== ${rel} ===\n${f.output}`;
    }).join('\n\n');
    // skip != fail: scope-skips are advisory and do NOT contribute to the fail
    // status, but we surface them alongside so the operator still sees them.
    return withScopeSkips({ status: 'fail', output: `${header}\n${body}` }, scopeSkips);
  }

  // B-a749: if every tsconfig was scope-skipped (no tsc ever ran, no fails),
  // the overall tsc status is 'skipped' (skip != fail) rather than a hollow pass.
  if (passes === 0) {
    return withScopeSkips(
      { status: 'skipped', output: 'all tsconfigs out of scope (deps absent)' },
      scopeSkips,
    );
  }

  // Preserve the legacy output string EXACTLY when nothing was scope-skipped
  // (backward compatibility — see CLAUDE.md "tsc: checked N tsconfigs"). When
  // some tsconfigs were scope-skipped, report how many actually ran vs found.
  const checkedOut = scopeSkips.length === 0
    ? `tsc: checked ${tsconfigs.length} tsconfigs`
    : `tsc: checked ${passes} of ${tsconfigs.length} tsconfigs (${scopeSkips.length} skipped out of scope)`;
  return withScopeSkips({ status: 'pass', output: checkedOut }, scopeSkips);
}

/** Attach scope-skip detail lines to a TscCheck without mutating status (skip != fail). */
function withScopeSkips(check: TscCheck, scopeSkips: string[]): TscCheck {
  return scopeSkips.length > 0 ? { ...check, scopeSkips } : check;
}

/**
 * F-018: detect `npx --no-install tsc` style "tool not found" output.
 *
 * When the target tool is unavailable, npx prints the following kinds of messages (varies slightly by version):
 *   - "npm ERR! could not determine executable to run"
 *   - "could not determine executable to run"
 *   - "npm ERR! 404 Not Found"
 *   - "npx: installed" / "npx: command not found" (older versions)
 *   - "npm error could not determine executable to run" (npm 10+)
 *
 * These all mean tsc itself is not installed, which is different from tsc compilation failure (real lint fail).
 */
export function isNpxToolNotFound(output: string): boolean {
  if (!output) return false;
  // Only match explicit npx-can't-find-tool patterns, to avoid mistaking real tsc lint fails (such as
  // "error TS2307: Cannot find module ..." or source errors containing "not found")
  // as skipped. The patterns here are all management-level errors output by npx/npm itself.
  const patterns = [
    /could not determine executable to run/i,
    /npm\s+ERR!\s+404\s+not\s+found/i,
    /npm\s+error\s+404\s+not\s+found/i,
    /npx:\s+installed/i,
    /npx:\s+command not found/i,
    /npm\s+ERR!\s+code\s+E404/i,
  ];
  return patterns.some((re) => re.test(output));
}

// ── ruff ──

/**
 * Run `ruff check <projectRoot>`.
 * Skipped scenarios: pyproject.toml does not exist or the ruff command is unavailable.
 */
export function runRuff(deps: {
  projectRoot: string;
  run?: CommandRunner;
  fileExists?: FileExists;
}): RuffCheck {
  const fileExists = deps.fileExists ?? existsSync;
  const run = deps.run ?? defaultRunner;
  const pyproject = join(deps.projectRoot, 'pyproject.toml');
  if (!fileExists(pyproject)) {
    return { status: 'skipped', output: 'no pyproject.toml' };
  }
  const r = run('ruff', ['check', deps.projectRoot], deps.projectRoot);
  if (r.spawnError) {
    return { status: 'skipped', output: 'ruff not installed' };
  }
  return r.code === 0
    ? { status: 'pass' }
    : { status: 'fail', output: r.output.trim() };
}

// ── import-graph ──

/**
 * Determine whether an import string violates the shells→fn boundary:
 *   - The path's basename, with .js extension stripped, is exactly "fn"
 *
 * Only matches imports that look like core/fn modules; won't accidentally hit things like `from 'fastify'`.
 */
export function isFnImport(importee: string): boolean {
  // strip surrounding whitespace
  const s = importee.trim();
  // last segment after /
  const lastSlash = s.lastIndexOf('/');
  const base = lastSlash >= 0 ? s.slice(lastSlash + 1) : s;
  // strip extension
  const name = base.endsWith('.js') ? base.slice(0, -3) : base.endsWith('.ts') ? base.slice(0, -3) : base;
  return name === 'fn';
}

/**
 * Scan import violations in a single file (reported by line number).
 * Only recognizes static `import ... from '...'` / `export ... from '...'`; does not scan dynamic import().
 */
export function scanImportsInFile(
  file: string,
  content: string,
): ImportGraphViolation[] {
  const out: ImportGraphViolation[] = [];
  const lines = content.split('\n');
  const re = /^\s*(?:import|export)\b[^'"`]*from\s*['"]([^'"]+)['"]/;
  // Single-line comment prefix (after leading whitespace). We intentionally
  // do NOT try to handle block comments `/* ... */` here — a proper lexer is
  // out of scope; the common false-positive was `// import ... from 'fn.js'`
  // appearing in docs/README snippets or commented-out code (F-012).
  const reLineComment = /^\s*\/\//;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (reLineComment.test(ln)) continue;
    const m = re.exec(ln);
    if (!m) continue;
    const importee = m[1];
    if (isFnImport(importee)) {
      out.push({ file, line: i + 1, importee });
    }
  }
  return out;
}

/**
 * Recursively enumerate all .ts / .tsx files under src/shells/.
 * Directory does not exist → returns null (caller treats as skipped).
 */
export function listShellFiles(
  projectRoot: string,
  deps?: {
    readdir?: (p: string) => string[];
    stat?: (p: string) => { isDirectory(): boolean; isFile(): boolean };
    fileExists?: FileExists;
  },
): string[] | null {
  const shellsDir = join(projectRoot, 'src', 'shells');
  const readdir = deps?.readdir ?? ((p) => readdirSync(p));
  const stat = deps?.stat ?? ((p) => statSync(p));
  const fileExists = deps?.fileExists ?? existsSync;
  try {
    if (!fileExists(shellsDir)) return null;
  } catch {
    return null;
  }
  const out: string[] = [];
  const stack: string[] = [shellsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdir(dir); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e);
      let s;
      try { s = stat(full); } catch { continue; }
      if (s.isDirectory()) { stack.push(full); continue; }
      if (!s.isFile()) continue;
      if (e.endsWith('.ts') || e.endsWith('.tsx')) out.push(full);
    }
  }
  return out;
}

/**
 * Run import-graph boundary check: scan src/shells/**\/*.ts, forbid importing any fn/fn.js.
 * Empty directory or src/shells/ not existing → skipped (not fail).
 */
export function runImportGraph(deps: {
  projectRoot: string;
  readdir?: (p: string) => string[];
  stat?: (p: string) => { isDirectory(): boolean; isFile(): boolean };
  readFile?: FileReader;
  fileExists?: FileExists;
}): ImportGraphCheck {
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf-8'));
  const files = listShellFiles(deps.projectRoot, {
    readdir: deps.readdir,
    stat: deps.stat,
    fileExists: deps.fileExists,
  });
  if (files === null) {
    return { status: 'skipped', violations: [] };
  }
  if (files.length === 0) {
    return { status: 'skipped', violations: [] };
  }
  const violations: ImportGraphViolation[] = [];
  for (const f of files) {
    let content: string;
    try { content = readFile(f); } catch { continue; }
    const rel = relative(deps.projectRoot, f);
    for (const v of scanImportsInFile(rel, content)) {
      violations.push(v);
    }
  }
  return violations.length === 0
    ? { status: 'pass', violations: [] }
    : { status: 'fail', violations };
}

// ── main entry ──

export interface CheckLintDeps {
  projectRoot: string;
  /** Inject command runner (for testing) */
  run?: CommandRunner;
  /** Inject fs helpers (for testing) */
  fileExists?: FileExists;
  readFile?: FileReader;
  readdir?: (p: string) => string[];
  stat?: (p: string) => { isDirectory(): boolean; isFile(): boolean };
  /**
   * B-a749: optional change-scope (repo-relative changed paths vs base). When
   * provided, out-of-scope tsconfigs whose package lacks node_modules are
   * skipped-with-warning instead of hard-failing on missing deps. When
   * undefined (plain `--lint`, no story) the lint runs full recursive tsc —
   * exactly as before (additive, backward compatible).
   */
  changedFiles?: string[];
}

/**
 * Core entry: run the three kinds of lint, aggregate results.
 *
 * Overall status:
 *   - Any sub-check fail → fail
 *   - All skipped    → skipped
 *   - Otherwise (at least one pass, the rest skipped or pass) → pass
 */
export function checkLint(deps: CheckLintDeps): LintResult {
  const tsc = runTsc({
    projectRoot: deps.projectRoot,
    run: deps.run,
    fileExists: deps.fileExists,
    readdir: deps.readdir,
    stat: deps.stat,
    changedFiles: deps.changedFiles,
  });
  const ruff = runRuff({
    projectRoot: deps.projectRoot,
    run: deps.run,
    fileExists: deps.fileExists,
  });
  const importGraph = runImportGraph({
    projectRoot: deps.projectRoot,
    readdir: deps.readdir,
    stat: deps.stat,
    readFile: deps.readFile,
    fileExists: deps.fileExists,
  });

  const checks: LintChecks = { tsc, ruff, importGraph };
  const subs: Array<[string, LintSubStatus]> = [
    ['tsc', tsc.status],
    ['ruff', ruff.status],
    ['importGraph', importGraph.status],
  ];

  const details: string[] = [];
  for (const [name, status] of subs) {
    if (status === 'skipped') {
      const why =
        name === 'tsc' ? tsc.output ?? '' :
        name === 'ruff' ? ruff.output ?? '' :
        '';
      details.push(`[lint] skipped: ${name}${why ? ` (${why})` : ''}`);
    } else if (status === 'fail') {
      if (name === 'importGraph') {
        details.push(`[lint] fail: import-graph (${importGraph.violations.length} violation${importGraph.violations.length === 1 ? '' : 's'})`);
        for (const v of importGraph.violations) {
          details.push(`  ${v.file}:${v.line}  → ${v.importee}`);
        }
      } else {
        const out = name === 'tsc' ? tsc.output : ruff.output;
        details.push(`[lint] fail: ${name}`);
        if (out) {
          for (const line of out.split('\n').slice(0, 40)) {
            if (line.trim()) details.push(`  ${line}`);
          }
        }
      }
    } else {
      // B-5a28 CHK-002: When tsc passes, include "tsc: checked N tsconfigs" in the output,
      // so `proof-or-stop validate --lint` output directly shows how many tsconfigs were scanned.
      const passOut =
        name === 'tsc' ? tsc.output ?? '' :
        '';
      details.push(`[lint] pass: ${name}${passOut ? ` (${passOut})` : ''}`);
    }
  }

  // B-a749: surface out-of-scope deps-absent skips. These are advisory (skip !=
  // fail) and the exact detail line is `[lint] skipped: <tsconfig> (out of
  // scope, deps absent)`. Emitted regardless of the tsc sub-status.
  if (tsc.scopeSkips && tsc.scopeSkips.length > 0) {
    for (const line of tsc.scopeSkips) details.push(line);
  }

  const anyFail = subs.some(([, s]) => s === 'fail');
  const allSkipped = subs.every(([, s]) => s === 'skipped');
  let status: LintSubStatus;
  let summary: string;
  if (anyFail) {
    status = 'fail';
    const failed = subs.filter(([, s]) => s === 'fail').map(([n]) => n).join(', ');
    summary = `lint fail: ${failed}`;
  } else if (allSkipped) {
    status = 'skipped';
    summary = 'all lint checks skipped (no tsconfig/pyproject, no shells/)';
  } else {
    status = 'pass';
    const passed = subs.filter(([, s]) => s === 'pass').map(([n]) => n).join(', ');
    const skipped = subs.filter(([, s]) => s === 'skipped').map(([n]) => n);
    summary = skipped.length > 0
      ? `lint pass: ${passed} (skipped: ${skipped.join(', ')})`
      : `lint pass: ${passed}`;
  }

  return {
    provider: 'proof-or-stop-lint',
    status,
    summary,
    details,
    checks,
  };
}

/**
 * B-9d95 CHK-006: CLI entry for `proof-or-stop validate --lint`.
 *
 * Doesn't spawn pytest / doesn't run full validate.ts — directly calls checkLint, outputs
 * structured result + human-readable rendering. Used for REVIEW→TEST preflight as an independent branch.
 *
 * Determination:
 *   - status=pass or skipped → ok
 *   - status=fail            → ok=false
 */
export interface LintCliResult {
  ok: boolean;
  result: LintResult;
  rendered: string;
}

export function runLintGateCli(deps: CheckLintDeps): LintCliResult {
  const result = checkLint(deps);
  const ok = result.status === 'pass' || result.status === 'skipped';
  return { ok, result, rendered: renderLintResult(result) };
}

/** Render LintResult as human-readable text */
export function renderLintResult(r: LintResult): string {
  const lines: string[] = [];
  const icon = r.status === 'pass' ? '✓' : r.status === 'skipped' ? '·' : '✗';
  lines.push(`[lint] ${icon} ${r.status}: ${r.summary}`);
  for (const d of r.details) lines.push(`  ${d}`);
  return lines.join('\n');
}
