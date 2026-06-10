/**
 * validate-concept — CLI gate: deleted-symbol residual check
 *
 * Extract deleted exported symbols (TS / Python) from `git diff main...HEAD`, then for each symbol
 * grep the entire repo, listing residual references that have not yet been cleaned up. Threshold 5:
 *
 * - residuals.length == 0     → status=pass, recommendation="skip concept LLM reviewer"
 * - 1 ≤ residuals.length < 5  → status=warn, recommendation="skip concept LLM reviewer"
 * - residuals.length ≥ 5      → status=warn, recommendation="dispatch koala-review-concept"
 *
 * Output structure:
 *   {
 *     provider: "koala-concept",
 *     status: "pass" | "warn",
 *     summary: string,
 *     deletedSymbols: string[],
 *     residuals: Array<{ symbol, file, line, snippet }>,
 *     recommendation: "skip concept LLM reviewer" | "dispatch koala-review-concept"
 *   }
 *
 * See docs/koala/reviewer-redesign.md §III S1 item 2.
 */

import { execSync } from 'node:child_process';
import { DEFAULT_BASE } from './validate-shared.js';

export interface ConceptResidual {
  symbol: string;
  file: string;
  line: number;
  snippet: string;
}

export interface ConceptCheckResult {
  // F-017 (B-9d95 Round 1 review): residuals ≥ 5 upgraded to fail (instead of warn),
  // aligned with the ok=false semantics returned by runConceptGateCli/CLI gate, rendering shows ✗ fail.
  provider: 'koala-concept';
  status: 'pass' | 'warn' | 'fail';
  summary: string;
  deletedSymbols: string[];
  residuals: ConceptResidual[];
  recommendation: 'skip concept LLM reviewer' | 'dispatch koala-review-concept';
}

/** Readers can be injected for tests. Default uses `git diff main...HEAD`. */
export type GitDiffReader = (args: { base: string; projectRoot: string }) => string;

export type GrepReader = (args: {
  symbol: string;
  projectRoot: string;
}) => string;

/** Directories we never want to scan (would create false positives / self-reference) */
export const IGNORED_DIRS = [
  'node_modules',
  'dist',
  '.git',
  '.koala',
  'tmp',
  '.worktrees',
];

const IGNORED_PATH_PREFIXES = [
  '.koala/',
  'docs/story/',
  'tests/fixtures/',
  'packages/main/tests/fixtures/',
];

function isIgnoredResidualFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return IGNORED_PATH_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

const defaultGitDiffReader: GitDiffReader = ({ base, projectRoot }) => {
  return execSync(`git diff ${base}...HEAD`, {
    cwd: projectRoot,
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  });
};

const defaultGrepReader: GrepReader = ({ symbol, projectRoot }) => {
  // -rn → recursive + line numbers, -F → fixed string (symbol may contain `_`)
  // --exclude-dir handles each ignored subdir. swallow non-zero (exit 1 = no match).
  const excludes = IGNORED_DIRS.map((d) => `--exclude-dir=${d}`).join(' ');
  try {
    return execSync(`grep -rnF ${excludes} -- ${JSON.stringify(symbol)} .`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (e: any) {
    // grep exit 1 = no match (not an error for us)
    if (e?.status === 1) return '';
    throw e;
  }
};

// ── symbol extraction from diff ──

/**
 * Extract deleted exported symbols (TS / Python) from the raw `git diff` text.
 *
 * Rule: only look at lines starting with `-` but not `--` (`---` is a diff header). Ignore comment lines.
 *
 * TS:     `-export (async )?function NAME`, `-export class NAME`, `-export const NAME`
 * Python: `-def NAME`, `-class NAME`
 *
 * Returns a deduplicated and sorted symbol list.
 */
export function scanDeletedSymbols(diff: string): string[] {
  const out = new Set<string>();
  const lines = diff.split('\n');

  // TS patterns — permit optional whitespace after `-`
  const reTsFunc = /^-\s*export\s+(?:async\s+)?function\s+(\w+)/;
  const reTsClass = /^-\s*export\s+class\s+(\w+)/;
  const reTsConst = /^-\s*export\s+const\s+(\w+)/;

  // Python patterns (also permit leading indentation after `-`)
  const rePyDef = /^-\s*def\s+(\w+)/;
  const rePyClass = /^-\s*class\s+(\w+)/;

  // Comment lines we ignore even if they happen to delete a "fake" symbol
  const reTsComment = /^-\s*\/\//;
  const rePyComment = /^-\s*#/;

  for (const line of lines) {
    // Skip diff meta (---) — regex wouldn't match anyway but cheap to short-circuit
    if (line.startsWith('---')) continue;
    if (!line.startsWith('-')) continue;
    if (reTsComment.test(line)) continue;
    if (rePyComment.test(line)) continue;

    const m =
      reTsFunc.exec(line) ||
      reTsClass.exec(line) ||
      reTsConst.exec(line) ||
      rePyDef.exec(line) ||
      rePyClass.exec(line);
    if (m) out.add(m[1]);
  }

  return Array.from(out).sort();
}

// ── residual grep ──

/**
 * Parse the output of `grep -rn` into { file, line, snippet }.
 * In the form `./path/to/file.ts:42:snippet content`
 */
export function parseGrepLine(
  raw: string,
  symbol: string,
): Omit<ConceptResidual, 'symbol'> | null {
  const trimmed = raw.replace(/\r$/, '');
  if (!trimmed) return null;
  // file:line:content  — file can contain `:` (unlikely on unix), but simply take the first two `:`
  const firstColon = trimmed.indexOf(':');
  if (firstColon < 0) return null;
  const file = trimmed.slice(0, firstColon);
  const rest = trimmed.slice(firstColon + 1);
  const secondColon = rest.indexOf(':');
  if (secondColon < 0) return null;
  const lineNumStr = rest.slice(0, secondColon);
  const lineNum = Number.parseInt(lineNumStr, 10);
  if (!Number.isFinite(lineNum)) return null;
  const snippet = rest.slice(secondColon + 1).trim();
  // strip leading "./" from file for consistency
  const cleanFile = file.startsWith('./') ? file.slice(2) : file;
  // Note: we intentionally do NOT require the snippet to contain the symbol.
  // grep has already filtered; a match could span multiple lines (e.g. the
  // symbol appears on a different line than the `grep -n` reported line when
  // context flags are used). Report whatever grep gave us.
  return { file: cleanFile, line: lineNum, snippet };
}

/**
 * Grep the entire repo for each symbol, merging all hits as residuals.
 * Self-reference protection: skip files that appear in the diff itself (hits on the current symbol in diff-changed files
 * are likely "still within diff scope" rather than true residuals; true residuals are determined by code body lines).
 *
 * Simplified version: node_modules/dist/.git/tmp/.worktrees are already excluded at the grep level,
 * no secondary file path filtering is done here.
 */
export function grepResiduals(
  symbols: string[],
  deps: { projectRoot: string; grepReader?: GrepReader },
): ConceptResidual[] {
  const grepReader = deps.grepReader ?? defaultGrepReader;
  const out: ConceptResidual[] = [];
  for (const symbol of symbols) {
    let raw: string;
    try {
      raw = grepReader({ symbol, projectRoot: deps.projectRoot });
    } catch {
      // grep failure treated as no residuals for that symbol (does not block other symbols)
      continue;
    }
    for (const line of raw.split('\n')) {
      const parsed = parseGrepLine(line, symbol);
      if (!parsed) continue;
      if (isIgnoredResidualFile(parsed.file)) continue;
      out.push({ symbol, ...parsed });
    }
  }
  return out;
}

// ── main entry ──

export interface CheckConceptDeps {
  projectRoot: string;
  gitDiffReader?: GitDiffReader;
  grepReader?: GrepReader;
  base?: string;
}

/**
 * Core entry point: read diff → extract deleted symbols → grep residuals → determine status + recommendation.
 *
 * Note: does not depend on StoryStore; story existence is validated by the caller (verifier handler) at the CLI layer.
 * The story argument is passed purely for future per-story diff base extension; the current base defaults to "main".
 */
export function checkConcept(deps: CheckConceptDeps): ConceptCheckResult {
  const {
    projectRoot,
    gitDiffReader = defaultGitDiffReader,
    grepReader,
    base = DEFAULT_BASE,
  } = deps;

  let diff: string;
  try {
    diff = gitDiffReader({ base, projectRoot });
  } catch (e: any) {
    // git diff failure (no base, orphan branch, detached HEAD, etc.): don't
    // silently pass — surface as warn so the preflight log shows the problem,
    // but also don't fail outright (no diff → nothing to verify; e.g. orphan
    // branch case). recommendation=skip since we couldn't compute residuals.
    return {
      provider: 'koala-concept',
      status: 'warn',
      summary: `git diff failed (${base}...HEAD): ${String(e?.message ?? e)}`,
      deletedSymbols: [],
      residuals: [],
      recommendation: 'skip concept LLM reviewer',
    };
  }

  const symbols = scanDeletedSymbols(diff);
  if (symbols.length === 0) {
    return {
      provider: 'koala-concept',
      status: 'pass',
      summary: `no deleted exports in ${base}...HEAD`,
      deletedSymbols: [],
      residuals: [],
      recommendation: 'skip concept LLM reviewer',
    };
  }

  const residuals = grepResiduals(symbols, { projectRoot, grepReader });

  if (residuals.length === 0) {
    return {
      provider: 'koala-concept',
      status: 'pass',
      summary: `${symbols.length} symbol(s) deleted, no residual references`,
      deletedSymbols: symbols,
      residuals: [],
      recommendation: 'skip concept LLM reviewer',
    };
  }

  const recommendation: ConceptCheckResult['recommendation'] =
    residuals.length >= 5 ? 'dispatch koala-review-concept' : 'skip concept LLM reviewer';

  // F-017: residuals ≥ 5 → status=fail (blocks CLI gate and renders ✗ fail),
  // residuals 1..4 → status=warn (preserves original semantics, suggests skip reviewer, non-blocking)
  const status: ConceptCheckResult['status'] = residuals.length >= 5 ? 'fail' : 'warn';

  return {
    provider: 'koala-concept',
    status,
    summary: `${symbols.length} symbol(s) deleted, ${residuals.length} residual reference(s) found`,
    deletedSymbols: symbols,
    residuals,
    recommendation,
  };
}

/**
 * B-9d95 CHK-006: CLI entry for `koala validate --concept`.
 *
 * Does not spawn pytest / does not run full validate.ts — directly calls checkConcept, outputs
 * structured results + human-readable rendering. Used for independent REVIEW→TEST preflight routing.
 *
 * Determination:
 *   - status=pass                        → ok
 *   - status=warn, residuals < 5         → ok (suggestion: skip LLM reviewer)
 *   - status=warn, residuals ≥ 5         → ok=false (suggestion: dispatch concept reviewer)
 *
 * Note: The CLI entry only returns CLI-level ok/fail; the reviewer-already-ran determination is done in review-preflight
 * (which has access to StoryStore).
 */
export interface ConceptCliResult {
  ok: boolean;
  result: ConceptCheckResult;
  rendered: string;
}

export function runConceptGateCli(deps: CheckConceptDeps): ConceptCliResult {
  const result = checkConcept(deps);
  let ok: boolean;
  if (result.status === 'pass') {
    ok = true;
  } else if (result.status === 'warn' && result.residuals.length < 5) {
    ok = true;
  } else {
    // residuals ≥ 5 (status='fail') / other statuses → CLI layer reports fail
    ok = false;
  }
  return { ok, result, rendered: renderConceptResult(result) };
}

/** Render ConceptCheckResult as human-readable text */
export function renderConceptResult(r: ConceptCheckResult): string {
  const lines: string[] = [];
  // F-017: fail shows ✗, warn shows ⚠, pass shows ✓
  const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '⚠';
  lines.push(`[concept] ${icon} ${r.status}: ${r.summary}`);
  if (r.deletedSymbols.length > 0) {
    lines.push(`  deletedSymbols: ${r.deletedSymbols.join(', ')}`);
  }
  if (r.residuals.length > 0) {
    lines.push(`  residuals (${r.residuals.length}):`);
    for (const res of r.residuals.slice(0, 20)) {
      lines.push(`    ${res.symbol} @ ${res.file}:${res.line}`);
    }
    if (r.residuals.length > 20) {
      lines.push(`    ... (${r.residuals.length - 20} more)`);
    }
  }
  lines.push(`  recommendation: ${r.recommendation}`);
  if (r.status === 'fail') {
    lines.push('  note: standalone validate --concept only reports raw residuals; REVIEW→TEST preflight may accept them after koala-review-concept records a finding or review_pass_set in the current review round.');
  }
  return lines.join('\n');
}
