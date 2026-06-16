/**
 * validate-docs-drift — pure function: scan lattice command references in CLAUDE.md vs registry command name alignment.
 *
 * Two directions:
 *   - missing: md references `lattice <cmd>` but it's not registered in registry → docs promise a non-existent command
 *   - stale:   registry has it but md never mentions it → advisory (docs lag, non-blocking)
 *
 * Only parses lines starting with lattice inside fenced bash code blocks (within ```bash / ```).
 * allowlist excludes known exceptions (e.g. YAGNI commands).
 *
 * B-805f CHK-001
 *
 * B-a7b0 CHK-001: the gate optionally also runs a path-reference drift check by
 * delegating to `scanPathDrift` from core/audit-scan (NOT re-implemented here),
 * so CLAUDE.md cannot reference a file path that does not exist in the repo.
 */

import { scanPathDrift } from '../core/audit-scan.js';

export interface DocsDriftResult {
  /** Commands referenced in md but not registered in registry */
  missing: string[];
  /** Commands in registry but not mentioned in md (advisory) */
  stale: string[];
}

/**
 * Extracts all `lattice <cmd>` command names from fenced bash code blocks in markdown text.
 *
 * Only matches lines inside code blocks fenced with ``` or ```bash.
 */
export function extractLatticeCommands(mdContent: string): Set<string> {
  const commands = new Set<string>();
  const lines = mdContent.split('\n');
  let inFencedBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // Detect fenced block start/end
    if (trimmed.startsWith('```')) {
      if (inFencedBlock) {
        // closing fence
        inFencedBlock = false;
      } else {
        // opening fence — only match bash / sh / no-language-tag code blocks
        const lang = trimmed.slice(3).trim().toLowerCase();
        inFencedBlock = lang === '' || lang === 'bash' || lang === 'sh'
          || lang === 'shell';
      }
      continue;
    }

    if (!inFencedBlock) continue;

    // Inside fenced block, match lattice <cmd> pattern
    // Support optional $ / # prefix and whitespace at line start
    const match = trimmed.match(/(?:^[$#]\s+)?lattice\s+([a-z][a-z0-9_]*)/);
    if (match) {
      commands.add(match[1]);
    }
  }

  return commands;
}

/**
 * Core pure function: compare lattice commands referenced in markdown vs commands actually registered in registry.
 *
 * @param mdContent   - CLAUDE.md text content (can be multiple md files concatenated)
 * @param registryNames - set of command names returned by registry.list()
 * @param allowlist   - whitelist of commands not to report as missing (e.g. YAGNI commands)
 */
export function checkDocsDrift(
  mdContent: string,
  registryNames: Set<string>,
  allowlist: Set<string> = new Set(),
): DocsDriftResult {
  const mdCommands = extractLatticeCommands(mdContent);

  // Internal commands (starting with _) are not included in stale check
  const INTERNAL_PREFIX = '_';
  // Commonly ignored commands (help/status/init etc. also ignored in audit-scan)
  const SCAN_IGNORE = new Set(['help', 'init', 'status']);

  const missing: string[] = [];
  const stale: string[] = [];

  // missing: present in md but not in registry
  for (const cmd of mdCommands) {
    if (allowlist.has(cmd)) continue;
    if (SCAN_IGNORE.has(cmd)) continue;
    if (!registryNames.has(cmd)) {
      missing.push(cmd);
    }
  }

  // stale: present in registry but not mentioned in md
  for (const cmd of registryNames) {
    if (cmd.startsWith(INTERNAL_PREFIX)) continue;
    if (SCAN_IGNORE.has(cmd)) continue;
    if (!mdCommands.has(cmd)) {
      stale.push(cmd);
    }
  }

  missing.sort();
  stale.sort();

  return { missing, stale };
}

// ── Gate result type (for preflight integration) ──

export interface DocsDriftGateResult {
  provider: 'lattice-docs-drift';
  status: 'pass' | 'fail' | 'skipped';
  summary: string;
  missing: string[];
  stale: string[];
  /**
   * B-a7b0 CHK-001: paths CLAUDE.md references that do not exist in the repo
   * (and have no string-literal reference), excluding allowlisted/intentional
   * paths. Additive — empty array unless a repoRoot is supplied to runDocsDriftGate.
   */
  missingPaths: string[];
}

/**
 * Known YAGNI command whitelist (aligned with audit-scan.ts EXPLICIT_YAGNI_COMMANDS).
 * Commands explicitly marked as "do not build this CLI" in CLAUDE.md; not reported as missing when scanned.
 */
export const DOCS_DRIFT_ALLOWLIST = new Set<string>([
  'audit_config_set',
  // utils/bootstrap-only aux command: documented for the local Lattice dev env, not core registry.
  'aux_scan',
  // legacy human-resume command referenced by historical flow docs; not part of current core registry.
  'testintent_resume',
]);

/**
 * B-a7b0 CHK-001: path-reference allowlist seam (mirrors DOCS_DRIFT_ALLOWLIST for
 * command names). Paths listed here are intentionally referenced by CLAUDE.md even
 * though they do not currently exist in the repo — e.g. deleted-by-design examples,
 * or paths whose creation is gated behind a pending story. scanPathDrift already
 * ignores docs/story/ paths and uppercase-XXX template placeholders, so this seam
 * is only for legitimate-but-absent concrete paths that would otherwise false-fail.
 *
 * CHK-002 reuses this same seam to suppress the known-pending managed-asset claim.
 * Each entry MUST carry an inline reason.
 */
export const DOCS_DRIFT_PATH_ALLOWLIST = new Set<string>([
  // (seeded empty — add concrete relPaths with an inline reason when a real
  //  CLAUDE.md example path is legitimately absent.)
]);

/**
 * B-a7b0 CHK-001: pure path-drift wrapper. Delegates to scanPathDrift (core/audit-scan)
 * over the combined CLAUDE.md content, then filters out any path present in the
 * effective allowlist. Returns the deduped list of missing (drift) paths.
 *
 * Reuses scanPathDrift's existing noise controls (docs/story/ ignore, template
 * placeholder ignore, fs.existsSync → git-grep fallback); does NOT re-implement scanning.
 *
 * @param mdContent   combined CLAUDE.md text (multiple files joined with '\n')
 * @param repoRoot    repository root used by scanPathDrift for path existence / grep
 * @param allowlist   path allowlist seam (defaults to DOCS_DRIFT_PATH_ALLOWLIST)
 * @param opts        DI hooks forwarded to scanPathDrift (test injection)
 */
export function checkPathDrift(
  mdContent: string,
  repoRoot: string,
  allowlist: Set<string> = DOCS_DRIFT_PATH_ALLOWLIST,
  opts: { grepLiteral?: (literal: string) => boolean; pathExists?: (abs: string) => boolean } = {},
): { missingPaths: string[] } {
  // Handler Encoding Convention: re-validate the consumed inputs at the
  // consumption point, not only at any upstream schema boundary.
  if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0) {
    throw new Error('checkPathDrift: repoRoot must be a non-empty string');
  }
  const effectiveAllowlist = allowlist instanceof Set ? allowlist : new Set<string>();

  // scanPathDrift takes a single md string + a stable mdPath label. We scan the
  // combined content under a single 'CLAUDE.md' label: this keeps section/heading
  // context useful (the first file's headings drive sectionPath) and dedups paths
  // across the joined files via scanPathDrift's internal `seen` set.
  const { drifts } = scanPathDrift(mdContent, 'CLAUDE.md', repoRoot, {
    grepLiteral: opts.grepLiteral,
    pathExists: opts.pathExists,
  });

  const missingPaths: string[] = [];
  for (const d of drifts) {
    if (d.driftType !== 'missing-path') continue; // scanPathDrift only emits missing-path, defensive
    if (effectiveAllowlist.has(d.symbol)) continue; // intentional/allowlisted path
    missingPaths.push(d.symbol);
  }
  missingPaths.sort();
  return { missingPaths };
}

/**
 * Optional inputs for runDocsDriftGate.
 *
 * B-a7b0 CHK-001: when `repoRoot` is provided, the gate ADDITIONALLY runs a
 * path-reference drift check (delegating to scanPathDrift). When `repoRoot` is
 * NOT provided, behavior is byte-identical to the command-name-only gate
 * (backward compatible).
 */
export interface DocsDriftGateOpts {
  /** Repo root; presence enables the path-drift check. */
  repoRoot?: string;
  /** Path allowlist seam (defaults to DOCS_DRIFT_PATH_ALLOWLIST). */
  pathAllowlist?: Set<string>;
  /** DI hooks forwarded to scanPathDrift (test injection). */
  grepLiteral?: (literal: string) => boolean;
  pathExists?: (abs: string) => boolean;
}

/**
 * CLI gate entry: reads CLAUDE.md files + registry command names, returns gate result.
 *
 * @param mdContents  - array of CLAUDE.md file contents (multiple files allowed)
 * @param registryNames - set of command names from registry.list()
 * @param opts        - B-a7b0: optional path-drift inputs; when opts.repoRoot is set,
 *                      a path-reference drift check runs in addition to the command scan.
 */
export function runDocsDriftGate(
  mdContents: string[],
  registryNames: Set<string>,
  opts: DocsDriftGateOpts = {},
): DocsDriftGateResult {
  if (mdContents.length === 0) {
    return {
      provider: 'lattice-docs-drift',
      status: 'skipped',
      summary: 'CLAUDE.md file not found',
      missing: [],
      stale: [],
      missingPaths: [],
    };
  }

  const combined = mdContents.join('\n');
  const result = checkDocsDrift(combined, registryNames, DOCS_DRIFT_ALLOWLIST);

  // B-a7b0 CHK-001: optional path-reference drift check. Only runs when a
  // repoRoot is supplied; otherwise missingPaths stays empty (backward compatible).
  let missingPaths: string[] = [];
  if (opts.repoRoot !== undefined) {
    const pathResult = checkPathDrift(
      combined,
      opts.repoRoot,
      opts.pathAllowlist ?? DOCS_DRIFT_PATH_ALLOWLIST,
      { grepLiteral: opts.grepLiteral, pathExists: opts.pathExists },
    );
    missingPaths = pathResult.missingPaths;
  }

  const hasMissingCommands = result.missing.length > 0;
  const hasMissingPaths = missingPaths.length > 0;

  if (hasMissingCommands && !hasMissingPaths) {
    // Command-only failure: preserve the exact legacy summary (byte-identical to
    // the pre-B-a7b0 command-name-only gate output).
    return {
      provider: 'lattice-docs-drift',
      status: 'fail',
      summary: `CLAUDE.md references ${result.missing.length} unregistered commands: ${result.missing.join(', ')}`,
      missing: result.missing,
      stale: result.stale,
      missingPaths: [],
    };
  }

  if (hasMissingCommands || hasMissingPaths) {
    const parts: string[] = [];
    if (hasMissingCommands) {
      parts.push(`${result.missing.length} unregistered commands: ${result.missing.join(', ')}`);
    }
    if (hasMissingPaths) {
      parts.push(`${missingPaths.length} missing paths: ${missingPaths.join(', ')}`);
    }
    return {
      provider: 'lattice-docs-drift',
      status: 'fail',
      summary: `CLAUDE.md drift — ${parts.join('; ')}`,
      missing: result.missing,
      stale: result.stale,
      missingPaths,
    };
  }

  const staleNote = result.stale.length > 0
    ? ` (${result.stale.length} stale advisory)`
    : '';
  return {
    provider: 'lattice-docs-drift',
    status: 'pass',
    summary: `CLAUDE.md command references aligned with registry${staleNote}`,
    missing: [],
    stale: result.stale,
    missingPaths: [],
  };
}
