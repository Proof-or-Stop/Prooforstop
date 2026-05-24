/**
 * @task B-6bfd
 * @checklist CHK-003
 * @title Semantic scope gate
 * @type feature
 * @priority high
 * @description
 *   Evaluates diff-pack hunks against per-file scope contract v2 rules so a
 *   path-allowed change cannot silently edit a protected/denied anchor or an
 *   out-of-intent hunk. Pure logic, no I/O.
 *
 *   Severity routing:
 *     - protectedAnchors (global or file-level) → hard blocking violation that
 *       even an acknowledgement cannot downgrade (blocks in shadow + enforce).
 *     - deniedAnchors / unmatched allowedAnchors / disallowed changeKind →
 *       blocking violation in enforce, downgraded to a warning when the hunk is
 *       acknowledged by hunkDigest or anchor.
 *
 *   Backward compatibility: a v1 contract (no fileRules and no protectedAnchors)
 *   returns status 'skip'; mergeSemanticScopeResult then leaves the path-only
 *   result untouched so v1 stays path-only.
 */
import type {
  FileRule,
  ScopeCheckResult,
  ScopeContractAcknowledgement,
  ScopeContractData,
  ScopeDiffHunk,
  ScopeDiffPack,
  ScopeGateStatus,
  ScopeViolation,
  SemanticScopeGateResult,
} from './types.js';

/** A contract is "semantic" (v2) when it declares any file rule or global protected anchor. */
export function isSemanticContract(contract: ScopeContractData): boolean {
  return (contract.fileRules?.length ?? 0) > 0 || (contract.protectedAnchors?.length ?? 0) > 0;
}

function pathMatchesPattern(filePath: string, pattern: string): boolean {
  if (filePath === pattern) return true;
  if (filePath.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`)) return true;
  const globless = pattern.replace(/\/\*\*?$/, '').replace(/\*$/, '');
  if (globless !== pattern && filePath.startsWith(globless)) return true;
  if (pattern.startsWith('*.') && filePath.endsWith(pattern.slice(1))) return true;
  return false;
}

function ruleForHunk(rules: readonly FileRule[] | undefined, hunk: ScopeDiffHunk): FileRule | null {
  return rules?.find((rule) => pathMatchesPattern(hunk.path, rule.path)) ?? null;
}

function hunkAnchor(hunk: ScopeDiffHunk): string | undefined {
  return hunk.anchor ?? hunk.keyPath;
}

function ackCoversHunk(ack: ScopeContractAcknowledgement, hunk: ScopeDiffHunk): boolean {
  const pathCovered = ack.paths.some((path) => pathMatchesPattern(hunk.path, path));
  if (!pathCovered) return false;
  const digests = new Set([ack.hunkDigest, ...(ack.hunkDigests ?? [])].filter((d): d is string => !!d));
  if (digests.has(hunk.hunkDigest)) return true;
  const anchor = hunkAnchor(hunk);
  return !!anchor && (ack.anchors ?? []).includes(anchor);
}

function isAcknowledged(contract: ScopeContractData, hunk: ScopeDiffHunk): boolean {
  return contract.acknowledgements.some((ack) => ackCoversHunk(ack, hunk));
}

function makeViolation(
  hunk: ScopeDiffHunk,
  rule: ScopeViolation['rule'],
  acknowledged: boolean,
): ScopeViolation {
  const anchor = hunkAnchor(hunk);
  return {
    path: hunk.path,
    rule,
    acknowledged,
    ...(anchor ? { anchor } : {}),
    hunkDigest: hunk.hunkDigest,
  };
}

/**
 * Evaluate diff-pack hunks against a scope contract's v2 semantic rules.
 * Returns 'skip' for v1 (path-only) contracts so callers keep path-only behavior.
 */
export function checkSemanticScope(
  contract: ScopeContractData,
  diffPack: ScopeDiffPack,
): SemanticScopeGateResult {
  if (!isSemanticContract(contract)) {
    return {
      status: 'skip',
      violations: [],
      warnings: [],
      summary: 'Semantic scope gate: skip (v1 path-only contract)',
    };
  }

  const violations: ScopeViolation[] = [];
  const warnings: ScopeViolation[] = [];
  const globalProtected = new Set(contract.protectedAnchors ?? []);

  for (const hunk of diffPack.hunks) {
    // Story metadata / koala internal files are never semantically gated.
    if (hunk.path.startsWith('docs/story/') || hunk.path.startsWith('.koala/')) continue;

    const anchor = hunkAnchor(hunk);
    const rule = ruleForHunk(contract.fileRules, hunk);
    const acknowledged = isAcknowledged(contract, hunk);

    // 1. Global protected anchor — hard block, acknowledgement cannot downgrade.
    if (anchor && globalProtected.has(anchor)) {
      violations.push(makeViolation(hunk, 'protected_anchor', false));
      continue;
    }

    if (!rule) continue;

    // 2. File-level protected anchor — hard block, acknowledgement cannot downgrade.
    if (anchor && (rule.protectedAnchors ?? []).includes(anchor)) {
      violations.push(makeViolation(hunk, 'protected_anchor', false));
      continue;
    }

    // 3. Denied anchor — blocking unless acknowledged.
    if (anchor && (rule.deniedAnchors ?? []).includes(anchor)) {
      (acknowledged ? warnings : violations).push(makeViolation(hunk, 'denied_anchor', acknowledged));
      continue;
    }

    // 4. Disallowed change kind — blocking unless acknowledged.
    if (rule.allowedChangeKinds && hunk.changeKind && !rule.allowedChangeKinds.includes(hunk.changeKind)) {
      (acknowledged ? warnings : violations).push(makeViolation(hunk, 'change_kind', acknowledged));
      continue;
    }

    // 5. Restrictive allowedAnchors — any anchor outside the allowlist (or an
    //    unparseable hunk with no anchor) is out-of-intent; blocking unless ack'd.
    if (rule.allowedAnchors && rule.allowedAnchors.length > 0) {
      if (!anchor || !rule.allowedAnchors.includes(anchor)) {
        (acknowledged ? warnings : violations).push(makeViolation(hunk, 'unmatched_anchor', acknowledged));
      }
    }
  }

  const protectedViolations = violations.filter((v) => v.rule === 'protected_anchor');
  const concerns = violations.length + warnings.length;

  let status: ScopeGateStatus;
  let blockingCount = 0;
  if (contract.mode === 'local') {
    status = concerns > 0 ? 'warn' : 'pass';
  } else if (contract.mode === 'shadow') {
    // Only protected anchors block in shadow; everything else is advisory.
    blockingCount = protectedViolations.length;
    status = blockingCount > 0 ? 'fail' : concerns > 0 ? 'warn' : 'pass';
  } else {
    // enforce: any unacknowledged violation blocks.
    blockingCount = violations.length;
    status = blockingCount > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass';
  }

  const summary =
    status === 'pass'
      ? `Semantic scope gate: pass (${diffPack.hunks.length} hunk(s), 0 semantic violations)`
      : status === 'warn'
        ? `Semantic scope gate: warn (${concerns} concern(s), mode=${contract.mode})`
        : `Semantic scope gate: fail (${blockingCount} blocking semantic violation(s), mode=${contract.mode})`;

  return { status, violations, warnings, summary };
}

/**
 * Merge a path-level scope result with the semantic gate result.
 *
 * - semantic 'skip' (v1 contract) → return the path-only result unchanged, with
 *   no `semantic` field attached so v1 output stays byte-compatible with B-be27.
 * - otherwise → attach `semantic`, escalate status (fail dominates; warn upgrades
 *   a pass), and append the semantic summary. Semantic violations are kept in
 *   `result.semantic` (not merged into `result.violations`) so renderers show a
 *   single, anchor-aware semantic block instead of duplicate lines.
 */
export function mergeSemanticScopeResult(
  result: ScopeCheckResult,
  semantic: SemanticScopeGateResult,
): ScopeCheckResult {
  if (semantic.status === 'skip') return result;

  let status = result.status;
  if (semantic.status === 'fail') status = 'fail';
  else if (semantic.status === 'warn' && status === 'pass') status = 'warn';

  return {
    ...result,
    status,
    semantic,
    summary: `${result.summary}; ${semantic.summary}`,
  };
}
