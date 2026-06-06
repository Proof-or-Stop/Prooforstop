/**
 * validate-lint — CLI gate: tsc + ruff + import-graph boundaries
 *
 * koala validate runs three lint categories before spawning validate.ts by default; any failure causes overall failure
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
 *     provider: "koala-lint",
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
 * See docs/koala/reviewer-redesign.md §3 S1 item 3.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

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
  provider: 'koala-lint';
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

// ── tsc ──

/**
 * B-5a28 CHK-002: recursively enumerate all tsconfig.json under projectRoot.
 *
 * Why recursive: compilation errors in monorepo sub-packages (e.g. packages/koala/packages/main/tsconfig.json)
 * were missed by single-root scanning — the entire koala package's TS2451 compilation errors were only found by an independent sonnet reviewer after the
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
}): TscCheck {
  const run = deps.run ?? defaultRunner;
  const tsconfigs = findTsconfigs(deps.projectRoot, {
    readdir: deps.readdir,
    stat: deps.stat,
    fileExists: deps.fileExists,
  });
  if (tsconfigs.length === 0) {
    return { status: 'skipped', output: 'no tsconfig.json found' };
  }

  // F-007 / F-014: Explicitly track passes count, don't use fails.length === 0 as a proxy for "never ran".
  // The old code path [pass, pass, toolMissing] would erroneously short-circuit and return skipped,
  // swallowing all the prior pass results. Correct semantics:
  //   - "no tsc ever started successfully" (passes=0 && fails=0) → skipped
  //   - "at least one ran" → any subsequent toolMissing is recorded as fail (don't silently swallow)
  const fails: Array<{ path: string; output: string }> = [];
  let passes = 0;
  for (const tsconfig of tsconfigs) {
    const r = runSingleTsc(tsconfig, deps.projectRoot, run);
    if (r.kind === 'toolMissing') {
      // Tool missing: only treat as skipped when "never had a pass and never had a fail".
      if (passes === 0 && fails.length === 0) {
        return { status: 'skipped', output: `tsc not found: ${r.output}` };
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
    return { status: 'fail', output: `${header}\n${body}` };
  }

  return { status: 'pass', output: `tsc: checked ${tsconfigs.length} tsconfigs` };
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
      // so `koala validate --lint` output directly shows how many tsconfigs were scanned.
      const passOut =
        name === 'tsc' ? tsc.output ?? '' :
        '';
      details.push(`[lint] pass: ${name}${passOut ? ` (${passOut})` : ''}`);
    }
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
    provider: 'koala-lint',
    status,
    summary,
    details,
    checks,
  };
}

/**
 * B-9d95 CHK-006: CLI entry for `koala validate --lint`.
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
