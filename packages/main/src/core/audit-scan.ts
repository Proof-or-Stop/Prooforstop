/**
 * audit-scan — mechanically scan for drift between CLAUDE.md promises and actual CLI behavior (B-9bd9 CHK-001).
 *
 * Three pure scanner functions:
 *   - scanCommandDrift: extract `lattice <cmd>` command name → run `lattice <cmd> --help`, exit≠0 → drift
 *   - scanFlagDrift:    extract `lattice <cmd> ... --<flag>` → `lattice <cmd> --help` doesn't contain → drift
 *   - scanPathDrift:    extract path assertions from docs → grep whole repo → not found → drift
 *
 * All scanners are pure functions (input md text + repo root); the top-level `runMechanicalAudit`
 * aggregates and returns `{drifts, skipped}`. skipped records commands that couldn't be run (ENOENT / timeout /
 * permissions), not counted as drift, to avoid treating lattice itself not being installed as a doc error.
 */

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkDocsDrift,
  DOCS_DRIFT_ALLOWLIST,
} from '../handlers/validate-docs-drift.js';

export interface DriftCandidate {
  sectionPath: string; // e.g., "CLAUDE.md#lattice CLI quick reference"
  symbol: string;      // e.g., "lattice finding_cluster" / "--channel" / "foo/bar.json"
  driftType: 'missing-command' | 'missing-flag' | 'missing-path';
  severity: 'medium' | 'low';
  desc: string;        // one-line readable description (used for finding desc)
  evidence: string;    // evidence (help output snippet / grep missing info)
}

export interface SkippedEntry {
  sectionPath: string;
  symbol: string;
  driftType: 'missing-command' | 'missing-flag' | 'missing-path';
  reason: string; // "timeout" / "ENOENT" / ...
}

export interface AuditReport {
  drifts: DriftCandidate[];
  skipped: SkippedEntry[];
}

/** Internal: extract the nearest top-level heading for each line ("# " / "## " / "### " etc.) */
function buildHeadingIndex(md: string): Array<{ line: number; heading: string }> {
  const out: Array<{ line: number; heading: string }> = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{1,6}\s+(.+?)\s*$/);
    if (m) out.push({ line: i, heading: m[1] });
  }
  return out;
}

function headingFor(lineNo: number, headings: Array<{ line: number; heading: string }>): string {
  let last = '';
  for (const h of headings) {
    if (h.line <= lineNo) last = h.heading;
    else break;
  }
  return last;
}

/**
 * Command name whitelist — not real lattice commands (keywords in docs); don't emit drift when these are scanned.
 * help/status/init are real commands but don't go through --help detection (have dedicated bin entry or would hang).
 */
const COMMAND_SCAN_IGNORE = new Set<string>([
  'help', 'init', 'status',
]);

/**
 * Explicit YAGNI command whitelist — commands for which CLAUDE.md text explicitly explains "why this CLI is not provided".
 * Don't report missing-command drift when these are scanned (it's a false positive); record in skipped with reason=explicit-yagni-whitelist.
 * Example: `lattice audit_config_set` (CLAUDE.md explicitly states editing JSON is enough, no command created).
 */
const EXPLICIT_YAGNI_COMMANDS = new Set<string>([
  'audit_config_set',
]);

/**
 * scanCommandDrift: extract command names of the form `lattice <cmd>` from md;
 * for each one not in the ignore list, run `lattice <cmd> --help`, exit≠0 → drift.
 *
 * Regex: \blattice\s+([a-z][a-z0-9_]*)\b
 * Bare lattice (without arguments) is not extracted; expressions like $(lattice) are also not falsely extracted (the prefix is not $ directly followed by a letter).
 */
export function scanCommandDrift(
  md: string,
  mdPath: string,
  opts: { runHelp?: (cmd: string) => { ok: boolean; reason?: string; output?: string } } = {},
): { drifts: DriftCandidate[]; skipped: SkippedEntry[] } {
  const runHelp = opts.runHelp ?? defaultRunHelp;
  const headings = buildHeadingIndex(md);
  const lines = md.split('\n');
  const seen = new Set<string>();
  const drifts: DriftCandidate[] = [];
  const skipped: SkippedEntry[] = [];

  // Commands must end with a letter or digit; bare prefixes like `story_` / `checklist_` are not allowed as wildcard matches
  const re = /\blattice\s+([a-z](?:[a-z0-9_]*[a-z0-9])?)\b/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      const cmd = m[1];
      if (COMMAND_SCAN_IGNORE.has(cmd)) continue;
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      const sectionPath = `${mdPath}#${headingFor(i, headings)}`;
      const symbol = `lattice ${cmd}`;
      // Commands explicitly marked YAGNI (CLAUDE.md itself explains why this CLI is not provided) → record as skipped, do not report drift
      if (EXPLICIT_YAGNI_COMMANDS.has(cmd)) {
        skipped.push({ sectionPath, symbol, driftType: 'missing-command', reason: 'explicit-yagni-whitelist' });
        continue;
      }
      const r = runHelp(cmd);
      if (r.ok) continue;
      if (r.reason && r.reason !== 'exit-nonzero') {
        // Cannot run: ENOENT / timeout / other exceptions, record as skipped, do not report drift
        skipped.push({ sectionPath, symbol, driftType: 'missing-command', reason: r.reason });
        continue;
      }
      drifts.push({
        sectionPath,
        symbol,
        driftType: 'missing-command',
        severity: 'medium',
        desc: `CLAUDE.md references command \`lattice ${cmd}\`, but \`lattice ${cmd} --help\` exited non-zero (command not registered or removed)`,
        evidence: (r.output || '').slice(0, 400),
      });
    }
  }
  return { drifts, skipped };
}

/**
 * scanFlagDrift: extract flag assertions of the form `lattice <cmd> [^\n]*--<flag>`;
 * for each pair <cmd, flag>, run `lattice <cmd> --help`; output not containing `--<flag>` → drift.
 *
 * Note: only scan flags inside code fences / inline code, to avoid falsely extracting prose like "with --json option".
 * Simplification: scan the full text directly with regex (doc flags are generally in bash snippets).
 */
export function scanFlagDrift(
  md: string,
  mdPath: string,
  opts: { runHelp?: (cmd: string) => { ok: boolean; reason?: string; output?: string } } = {},
): { drifts: DriftCandidate[]; skipped: SkippedEntry[] } {
  const runHelp = opts.runHelp ?? defaultRunHelp;
  const headings = buildHeadingIndex(md);
  const lines = md.split('\n');
  const seen = new Set<string>(); // "cmd|flag"
  const drifts: DriftCandidate[] = [];
  const skipped: SkippedEntry[] = [];
  const helpCache = new Map<string, { ok: boolean; reason?: string; output?: string }>();

  // Multiple flags may appear on a single line: `lattice validate --full --json`
  const cmdRe = /\blattice\s+([a-z](?:[a-z0-9_]*[a-z0-9])?)\b([^\n`]*)/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let cm: RegExpExecArray | null;
    cmdRe.lastIndex = 0;
    while ((cm = cmdRe.exec(line))) {
      const cmd = cm[1];
      if (COMMAND_SCAN_IGNORE.has(cmd)) continue;
      const tail = cm[2] || '';
      const flagRe = /--([a-z][a-z0-9-]*)/g;
      let fm: RegExpExecArray | null;
      while ((fm = flagRe.exec(tail))) {
        const flag = fm[1];
        const key = `${cmd}|${flag}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sectionPath = `${mdPath}#${headingFor(i, headings)}`;
        const symbol = `lattice ${cmd} --${flag}`;
        let r = helpCache.get(cmd);
        if (!r) {
          r = runHelp(cmd);
          helpCache.set(cmd, r);
        }
        if (!r.ok) {
          // help cannot run (command itself does not exist / timeout): do not report flag drift here
          // scanCommandDrift has already reported missing-command, just record a skipped entry here
          skipped.push({ sectionPath, symbol, driftType: 'missing-flag', reason: r.reason || 'help-not-runnable' });
          continue;
        }
        const output = r.output || '';
        // Simple containment search: --<flag> appearing counts as present
        if (output.includes(`--${flag}`)) continue;
        drifts.push({
          sectionPath,
          symbol,
          driftType: 'missing-flag',
          severity: 'medium',
          desc: `CLAUDE.md references \`lattice ${cmd} --${flag}\`, but help output does not contain the \`--${flag}\` parameter`,
          evidence: output.slice(0, 400),
        });
      }
    }
  }
  return { drifts, skipped };
}

/**
 * scanPathDrift: extract file paths asserted in docs from md; in-repo grep for string literal not found → drift (low).
 *
 * Two sentence patterns:
 *   1. A standalone relative path of the form a/b/c.{json|md|ts|js|py}
 *   2. "written to <path>" / "stored at <path>" / "storage location: <path>"
 *
 * grep strategy: use fs.existsSync to check if the file actually exists; if not, grep the full repo source code (string literals).
 * Both fail → drift. Noise control: ignore paths that themselves start with "docs/story/" (story's own paths should not be audited).
 */
export function scanPathDrift(
  md: string,
  mdPath: string,
  repoRoot: string,
  opts: { grepLiteral?: (literal: string) => boolean; pathExists?: (abs: string) => boolean } = {},
): { drifts: DriftCandidate[]; skipped: SkippedEntry[] } {
  const headings = buildHeadingIndex(md);
  const lines = md.split('\n');
  const seen = new Set<string>();
  const drifts: DriftCandidate[] = [];
  const skipped: SkippedEntry[] = [];

  const grep = opts.grepLiteral ?? ((literal: string) => defaultGrepLiteral(literal, repoRoot));
  const pathExists = opts.pathExists ?? ((abs: string) => {
    try { return existsSync(abs); } catch { return false; }
  });

  // Pattern 1: pure path assertion a/b/c.ext
  const pathRe = /(?<![\w./-])((?:[a-z0-9][a-z0-9-_]*\/){1,}[a-z0-9][a-z0-9-_.]*\.(?:json|md|ts|js|py))/gi;
  // Pattern 2: legacy Chinese prose variants for "<path> was written/stored here".
  const cnRe = /(?:\u5199\u5165|\u5b58\u50a8\u4e8e|\u5b58\u50a8\u4f4d\u7f6e[:\uff1a]|\u8def\u5f84[:\uff1a])\s*([a-zA-Z0-9./_\-]+\.(?:json|md|ts|js|py))/g;

  const collect = (p: string, lineNo: number) => {
    if (seen.has(p)) return;
    seen.add(p);
    // Ignore story's own artifact paths (audit does not check artifacts inside story)
    if (p.startsWith('docs/story/')) return;
    // Ignore obvious template placeholders (containing uppercase X or Han characters)
    if (/[A-Z]{3,}/.test(p)) return;

    const sectionPath = `${mdPath}#${headingFor(lineNo, headings)}`;
    const symbol = p;

    let exists = false;
    try {
      exists = pathExists(join(repoRoot, p));
    } catch {/* pass */}
    if (exists) return;

    let inCode = false;
    try {
      inCode = grep(p);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      skipped.push({ sectionPath, symbol, driftType: 'missing-path', reason: msg || 'grep-failed' });
      return;
    }
    if (inCode) return;

    drifts.push({
      sectionPath,
      symbol,
      driftType: 'missing-path',
      severity: 'low',
      desc: `CLAUDE.md references path \`${p}\` but the file does not exist in the repo and no string literal reference was found`,
      evidence: `path not found at <repo>/${p}, no grep hit in source`,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    pathRe.lastIndex = 0;
    while ((m = pathRe.exec(line))) collect(m[1], i);
    cnRe.lastIndex = 0;
    while ((m = cnRe.exec(line))) collect(m[1], i);
  }
  return { drifts, skipped };
}

/**
 * runMechanicalAudit: top-level aggregating scanner.
 *
 * Reads mdPaths (array of absolute paths), runs the three scanners separately, and merges drifts/skipped.
 * mdPath is presented in sectionPath as a path relative to repoRoot (stable driftHash).
 */
export function runMechanicalAudit(
  mdPaths: string[],
  repoRoot: string,
  opts: {
    runHelp?: (cmd: string) => { ok: boolean; reason?: string; output?: string };
    grepLiteral?: (literal: string) => boolean;
    pathExists?: (abs: string) => boolean;
    /** B-805f CHK-003: set of registry command names; when provided, appends docs-drift pure-function comparison (advisory) */
    registryNames?: Set<string>;
  } = {},
): AuditReport {
  const drifts: DriftCandidate[] = [];
  const skipped: SkippedEntry[] = [];

  for (const abs of mdPaths) {
    let md = '';
    try { md = readFileSync(abs, 'utf-8'); } catch { continue; }
    const rel = relPath(abs, repoRoot);

    const c = scanCommandDrift(md, rel, { runHelp: opts.runHelp });
    drifts.push(...c.drifts);
    skipped.push(...c.skipped);

    const f = scanFlagDrift(md, rel, { runHelp: opts.runHelp });
    drifts.push(...f.drifts);
    skipped.push(...f.skipped);

    const p = scanPathDrift(md, rel, repoRoot, { grepLiteral: opts.grepLiteral, pathExists: opts.pathExists });
    drifts.push(...p.drifts);
    skipped.push(...p.skipped);
  }

  // B-805f CHK-003: docs-drift registry-based scan (advisory, dedup vs scanCommandDrift)
  if (opts.registryNames && mdPaths.length > 0) {
    const allMd = mdPaths.map(abs => {
      try { return readFileSync(abs, 'utf-8'); } catch { return ''; }
    }).join('\n');
    const result = checkDocsDrift(allMd, opts.registryNames, DOCS_DRIFT_ALLOWLIST);
    for (const cmd of result.missing) {
      const alreadyCaught = drifts.some(d => d.symbol === `lattice ${cmd}` && d.driftType === 'missing-command');
      if (!alreadyCaught) {
        drifts.push({
          sectionPath: 'docs-drift-registry',
          symbol: `lattice ${cmd}`,
          driftType: 'missing-command',
          severity: 'low',
          desc: `CLAUDE.md references \`lattice ${cmd}\` but registry has no such command (docs-drift advisory)`,
          evidence: 'registry.list() does not contain this command',
        });
      }
    }
  }

  return { drifts, skipped };
}

/** Default runHelp: invokes `lattice <cmd> --help` with a 2-second timeout. */
function defaultRunHelp(cmd: string): { ok: boolean; reason?: string; output?: string } {
  try {
    const out = execFileSync('lattice', [cmd, '--help'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: out };
  } catch (e: unknown) {
    const err = e as { code?: string; signal?: string; killed?: boolean; status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    if (err?.code === 'ENOENT') return { ok: false, reason: 'ENOENT' };
    if (err?.signal === 'SIGTERM' || err?.killed) return { ok: false, reason: 'timeout' };
    // The lattice main entry typically uses stderr for help output
    const merged = (err?.stdout?.toString?.() || '') + (err?.stderr?.toString?.() || '');
    if (err?.status === 0) return { ok: true, output: merged };
    return { ok: false, reason: 'exit-nonzero', output: merged };
  }
}

/** Default grepLiteral: searches string literals using `git grep -F`, not restricted by file type. */
function defaultGrepLiteral(literal: string, repoRoot: string): boolean {
  try {
    execSync(`git grep -F -l -- ${JSON.stringify(literal)}`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch (e: unknown) {
    const err = e as { status?: number };
    // git grep exit 1 = no match; other codes are treated as grep failure (propagated upward and caught by scanPathDrift to be recorded as skipped)
    if (err?.status === 1) return false;
    if (err?.status === 0) return true;
    throw e;
  }
}

function relPath(abs: string, repoRoot: string): string {
  if (abs.startsWith(repoRoot + '/')) return abs.slice(repoRoot.length + 1);
  if (abs === repoRoot) return '.';
  return abs;
}
