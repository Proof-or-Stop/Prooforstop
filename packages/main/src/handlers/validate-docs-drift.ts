/**
 * validate-docs-drift — pure function: scan proof-or-stop command references in CLAUDE.md vs registry command name alignment.
 *
 * Two directions:
 *   - missing: md references `proof-or-stop <cmd>` but it's not registered in registry → docs promise a non-existent command
 *   - stale:   registry has it but md never mentions it → advisory (docs lag, non-blocking)
 *
 * Only parses lines starting with proof-or-stop inside fenced bash code blocks (within ```bash / ```).
 * allowlist excludes known exceptions (e.g. YAGNI commands).
 *
 * B-805f CHK-001
 *
 * B-a7b0 CHK-001: the gate optionally also runs a path-reference drift check by
 * delegating to `scanPathDrift` from core/audit-scan (NOT re-implemented here),
 * so CLAUDE.md cannot reference a file path that does not exist in the repo.
 */

import { scanPathDrift } from '../core/audit-scan.js';
import { ALL_MANAGED_ASSET_KINDS as MANAGED_ASSET_KIND_VALUES } from '../core/managed-assets.js';
import type { ManagedAssetDefinition, ManagedAssetKind } from '../core/managed-assets.js';

export interface DocsDriftResult {
  /** Commands referenced in md but not registered in registry */
  missing: string[];
  /** Commands in registry but not mentioned in md (advisory) */
  stale: string[];
}

/**
 * Extracts all `proof-or-stop <cmd>` command names from fenced bash code blocks in markdown text.
 *
 * Only matches lines inside code blocks fenced with ``` or ```bash.
 */
export function extractProofOrStopCommands(mdContent: string): Set<string> {
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

    // Inside fenced block, match proof-or-stop <cmd> pattern
    // Support optional $ / # prefix and whitespace at line start
    const match = trimmed.match(/(?:^[$#]\s+)?proof-or-stop\s+([a-z][a-z0-9_]*)/);
    if (match) {
      commands.add(match[1]);
    }
  }

  return commands;
}

/**
 * Core pure function: compare proof-or-stop commands referenced in markdown vs commands actually registered in registry.
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
  const mdCommands = extractProofOrStopCommands(mdContent);

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
  provider: 'proof-or-stop-docs-drift';
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
  /**
   * B-a7b0 CHK-002: managed-asset contradictions — CLAUDE.md "do not create"
   * claims about a path the framework actually generates (a GENERATED managed-asset
   * kind), excluding allowlisted pending claims. Additive — empty array unless
   * managedAssetDefs is supplied to runDocsDriftGate.
   */
  managedAssetContradictions: Array<{ asset: string; kind: string }>;
}

/**
 * Known YAGNI command whitelist (aligned with audit-scan.ts EXPLICIT_YAGNI_COMMANDS).
 * Commands explicitly marked as "do not build this CLI" in CLAUDE.md; not reported as missing when scanned.
 */
export const DOCS_DRIFT_ALLOWLIST = new Set<string>([
  'audit_config_set',
  // utils/bootstrap-only aux command: documented for the local Proofbound dev env, not core registry.
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
 * B-a7b0 CHK-002: managed-asset contradiction allowlist seam (reuses the same
 * allowlist-seam concept as DOCS_DRIFT_PATH_ALLOWLIST). Forbidden tokens listed
 * here are claims CLAUDE.md currently makes ("do not create <X>") that DO
 * contradict a framework-generated managed asset, but are intentionally tolerated
 * for now (e.g. a pending doc-wording fix). Each entry MUST carry an inline reason.
 *
 * The tokens below are stored path-normalized (lowercased, forward slashes,
 * trailing slash stripped) so the check can match `.Codex/hooks` ⇄ `.codex/hooks`
 * casing variants against a single canonical key.
 */
export const DOCS_DRIFT_MANAGED_ASSET_ALLOWLIST = new Set<string>([
  // (seeded empty — add a path-normalized forbidden token WITH an inline reason
  //  only when a CLAUDE.md "do not create <X>" claim about a framework-generated
  //  asset is intentionally tolerated for now, e.g. bridging a pending doc-wording
  //  fix in a sibling story.)
  //
  // B-d633: the original two bridge entries ('.codex/hooks', '.codex/settings.json')
  // were B-a7b0's temporary bridge while B-94ae fixed the CLAUDE.md wording. B-94ae
  // merged, so they were removed — keeping them would permanently mask the exact
  // '.codex/hooks' contradiction class this check exists to catch. Verified safe:
  // checkManagedAssetContradiction(real CLAUDE.md, registry, EMPTY allowlist) → 0
  // contradictions.
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
 * B-a7b0 CHK-002: the managed-asset kinds the framework itself CREATES.
 * A CLAUDE.md claim that forbids one of these (do not create / must not exist)
 * is a contradiction — the doc forbids something `proof-or-stop init` actively
 * generates. NON-generated kinds (excluded-path / remove-extra) describe paths
 * the framework deliberately does NOT create, so a "do not create" claim about
 * them is consistent, not contradictory.
 */
const GENERATED_MANAGED_ASSET_KINDS: ReadonlySet<ManagedAssetKind> = new Set<ManagedAssetKind>([
  'managed-block',
  'whole-file',
  'claude-settings',
  'codex-hooks',
  'gitignore-runtime',
]);

/**
 * All known ManagedAssetKind values (runtime re-validation, Handler Encoding
 * Convention). DERIVED from the canonical `ALL_MANAGED_ASSET_KINDS` export in
 * core/managed-assets.ts (single source of truth) so a new kind added to the
 * `ManagedAssetKind` union can never silently drift from this guard — the
 * canonical list is compile-time exhaustiveness-checked against the union there.
 */
const ALL_MANAGED_ASSET_KINDS: ReadonlySet<string> = new Set<string>(MANAGED_ASSET_KIND_VALUES);

/**
 * Path-normalize a path-ish token for casing/separator-insensitive comparison:
 * lowercase, backslashes → forward slashes, collapse repeats, strip leading
 * `./` and any trailing slash. So `.Codex/hooks/` and `.codex\hooks` both
 * normalize to `.codex/hooks`.
 */
function normalizeAssetPath(raw: string): string {
  return raw
    .trim()
    .replace(/\\+/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Is `forbidden` the generated asset itself OR an ancestor directory of it?
 * Both are stored already path-normalized. A claim forbidding a parent dir like
 * `.codex/hooks` contradicts a generated file under it like
 * `.codex/hooks/proof-or-stop-scope-pretool.cjs`.
 */
function forbidsAssetOrAncestor(forbidden: string, assetPath: string): boolean {
  if (forbidden.length === 0 || assetPath.length === 0) return false;
  if (forbidden === assetPath) return true;
  // forbidden is an ancestor directory of assetPath
  return assetPath.startsWith(`${forbidden}/`);
}

/**
 * B-a7b0 CHK-002: extract "do not create / must not exist / 禁止创建 / 不要创建"
 * style forbidden-path tokens from markdown. Returns path-normalized tokens.
 *
 * Tolerant of: surrounding backticks/quotes, both `.Codex` and `.codex` casing
 * (normalized away), Chinese ("禁止创建 X" / "不要创建 X" / "X 必须不存在") and
 * English ("do not create X" / "X must not exist") phrasings, and a single
 * sentence forbidding several paths joined by 或 / and / , / 、.
 */
function extractForbiddenPathClaims(mdContent: string): Set<string> {
  const tokens = new Set<string>();
  // A path-ish token: starts with a dot-dir, a leading slash, or a word/dot run;
  // allows /, ., _, -, alnum, and (so the lexer survives) optional surrounding
  // backticks/quotes which we strip below.
  const PATH_TOKEN = /[`'"]?((?:\.{1,2}\/|\/)?[\w.-]+(?:\/[\w.-]+)*)[`'"]?/g;

  // Phrasing patterns. Each captures the *clause* after the forbidding verb; we
  // then pull every path-ish token out of that clause (so "A 或 B" yields both).
  // NB: the clause stop-set intentionally does NOT include `.` — a `.` is a path
  // component separator (`.codex`, `settings.json`), so stopping at it would
  // truncate the clause at the first dotted path. Bound only on a fullwidth
  // sentence terminator `。` or a newline.
  const CLAUSE_PATTERNS: RegExp[] = [
    /(?:do not|don't|never)\s+create\s+([^。\n]+)/gi,
    /禁止创建\s*([^。\n]+)/g,
    /不要创建\s*([^。\n]+)/g,
    /([^。\n]+?)\s*must not exist/gi,
    /([^。\n]+?)\s*必须不存在/g,
  ];

  for (const pattern of CLAUSE_PATTERNS) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(mdContent)) !== null) {
      const clause = m[1] ?? '';
      let pm: RegExpExecArray | null;
      PATH_TOKEN.lastIndex = 0;
      while ((pm = PATH_TOKEN.exec(clause)) !== null) {
        const candidate = (pm[1] ?? '').trim();
        // Only treat tokens that look like an actual path (contain a `/` or a
        // leading dot-dir) as forbidden-path claims — avoids matching ordinary
        // words in the surrounding prose.
        if (!candidate.includes('/') && !candidate.startsWith('.')) continue;
        const normalized = normalizeAssetPath(candidate);
        if (normalized.length > 0) tokens.add(normalized);
      }
    }
  }
  return tokens;
}

/**
 * B-a7b0 CHK-002: pure managed-asset contradiction check. Flags any do-not-create /
 * must-not-exist claim in mdContent whose forbidden path matches (or is an ancestor
 * directory of) the relPath of a GENERATED managed-asset definition — i.e. the doc
 * forbids something `proof-or-stop init` actually creates.
 *
 * Provider-injected: managedDefs come from the caller (review-preflight passes the
 * real registry via listManagedAssetDefinitions); the check NEVER hardcodes asset
 * paths. NON-generated kinds (excluded-path / remove-extra) never produce a
 * contradiction. Allowlisted forbidden tokens are suppressed.
 *
 * Handler Encoding Convention: re-validates the consumed inputs at runtime
 * (malformed defs and unknown kinds are skipped defensively, not trusted).
 *
 * @param mdContent   combined CLAUDE.md text
 * @param managedDefs provider-injected managed-asset definitions (relPath + kind)
 * @param allowlist   path-normalized forbidden-token allowlist seam
 */
export function checkManagedAssetContradiction(
  mdContent: string,
  managedDefs: Pick<ManagedAssetDefinition, 'relPath' | 'kind'>[],
  allowlist: Set<string> = DOCS_DRIFT_MANAGED_ASSET_ALLOWLIST,
): { contradictions: Array<{ asset: string; kind: string }> } {
  // Handler Encoding Convention: re-validate consumed inputs at runtime.
  if (typeof mdContent !== 'string' || mdContent.length === 0) {
    return { contradictions: [] };
  }
  const defs = Array.isArray(managedDefs) ? managedDefs : [];
  const effectiveAllowlist = allowlist instanceof Set ? allowlist : new Set<string>();
  const normalizedAllowlist = new Set<string>(
    [...effectiveAllowlist].map(entry => normalizeAssetPath(String(entry))),
  );

  const forbiddenTokens = extractForbiddenPathClaims(mdContent);
  if (forbiddenTokens.size === 0) return { contradictions: [] };

  const contradictions: Array<{ asset: string; kind: string }> = [];
  const seen = new Set<string>();

  for (const def of defs) {
    // Re-validate def shape at the consumption point (do not trust upstream).
    if (!def || typeof def.relPath !== 'string' || def.relPath.trim().length === 0) continue;
    const kind = def.kind;
    if (typeof kind !== 'string' || !ALL_MANAGED_ASSET_KINDS.has(kind)) continue;
    // Only GENERATED kinds can be contradicted.
    if (!GENERATED_MANAGED_ASSET_KINDS.has(kind as ManagedAssetKind)) continue;

    const assetPath = normalizeAssetPath(def.relPath);
    if (assetPath.length === 0) continue;

    for (const forbidden of forbiddenTokens) {
      if (normalizedAllowlist.has(forbidden)) continue; // allowlisted pending claim
      if (!forbidsAssetOrAncestor(forbidden, assetPath)) continue;
      const dedupeKey = `${def.relPath} ${kind}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      contradictions.push({ asset: def.relPath, kind });
      break; // one contradiction per asset is enough
    }
  }

  contradictions.sort((a, b) => (a.asset === b.asset ? a.kind.localeCompare(b.kind) : a.asset.localeCompare(b.asset)));
  return { contradictions };
}

/**
 * Optional inputs for runDocsDriftGate.
 *
 * B-a7b0 CHK-001: when `repoRoot` is provided, the gate ADDITIONALLY runs a
 * path-reference drift check (delegating to scanPathDrift). When `repoRoot` is
 * NOT provided, behavior is byte-identical to the command-name-only gate
 * (backward compatible).
 *
 * B-a7b0 CHK-002: when `managedAssetDefs` is provided, the gate ADDITIONALLY runs
 * a managed-asset contradiction check (provider-injected registry; never
 * hardcoded). Absent → managedAssetContradictions stays empty (backward compatible).
 */
export interface DocsDriftGateOpts {
  /** Repo root; presence enables the path-drift check. */
  repoRoot?: string;
  /** Path allowlist seam (defaults to DOCS_DRIFT_PATH_ALLOWLIST). */
  pathAllowlist?: Set<string>;
  /** DI hooks forwarded to scanPathDrift (test injection). */
  grepLiteral?: (literal: string) => boolean;
  pathExists?: (abs: string) => boolean;
  /**
   * B-a7b0 CHK-002: provider-injected managed-asset registry. When present, the
   * gate runs the managed-asset contradiction check. Never hardcoded here.
   */
  managedAssetDefs?: Pick<ManagedAssetDefinition, 'relPath' | 'kind'>[];
  /** Managed-asset contradiction allowlist seam (defaults to DOCS_DRIFT_MANAGED_ASSET_ALLOWLIST). */
  managedAssetAllowlist?: Set<string>;
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
      provider: 'proof-or-stop-docs-drift',
      status: 'skipped',
      summary: 'CLAUDE.md file not found',
      missing: [],
      stale: [],
      missingPaths: [],
      managedAssetContradictions: [],
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

  // B-a7b0 CHK-002: optional managed-asset contradiction check. Only runs when a
  // provider-injected registry is supplied; otherwise contradictions stays empty.
  let managedAssetContradictions: Array<{ asset: string; kind: string }> = [];
  if (opts.managedAssetDefs !== undefined) {
    const assetResult = checkManagedAssetContradiction(
      combined,
      opts.managedAssetDefs,
      opts.managedAssetAllowlist ?? DOCS_DRIFT_MANAGED_ASSET_ALLOWLIST,
    );
    managedAssetContradictions = assetResult.contradictions;
  }

  const hasMissingCommands = result.missing.length > 0;
  const hasMissingPaths = missingPaths.length > 0;
  const hasContradictions = managedAssetContradictions.length > 0;

  if (hasMissingCommands && !hasMissingPaths && !hasContradictions) {
    // Command-only failure: preserve the exact legacy summary (byte-identical to
    // the pre-B-a7b0 command-name-only gate output).
    return {
      provider: 'proof-or-stop-docs-drift',
      status: 'fail',
      summary: `CLAUDE.md references ${result.missing.length} unregistered commands: ${result.missing.join(', ')}`,
      missing: result.missing,
      stale: result.stale,
      missingPaths: [],
      managedAssetContradictions: [],
    };
  }

  if (hasMissingCommands || hasMissingPaths || hasContradictions) {
    const parts: string[] = [];
    if (hasMissingCommands) {
      parts.push(`${result.missing.length} unregistered commands: ${result.missing.join(', ')}`);
    }
    if (hasMissingPaths) {
      parts.push(`${missingPaths.length} missing paths: ${missingPaths.join(', ')}`);
    }
    if (hasContradictions) {
      const named = managedAssetContradictions
        .map(c => `${c.asset} (${c.kind})`)
        .join(', ');
      parts.push(`${managedAssetContradictions.length} managed-asset contradiction(s): ${named}`);
    }
    return {
      provider: 'proof-or-stop-docs-drift',
      status: 'fail',
      summary: `CLAUDE.md drift — ${parts.join('; ')}`,
      missing: result.missing,
      stale: result.stale,
      missingPaths,
      managedAssetContradictions,
    };
  }

  const staleNote = result.stale.length > 0
    ? ` (${result.stale.length} stale advisory)`
    : '';
  return {
    provider: 'proof-or-stop-docs-drift',
    status: 'pass',
    summary: `CLAUDE.md command references aligned with registry${staleNote}`,
    missing: [],
    stale: result.stale,
    missingPaths: [],
    managedAssetContradictions: [],
  };
}
