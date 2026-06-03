/**
 * prewrite-guard.ts — pre-write scope enforcement core (pure logic, no I/O).
 *
 * Inspects target file paths for write-like tool invocations, normalizes them
 * relative to the project root, and evaluates them against the story scope
 * contract + guard session to produce a verdict before the write lands.
 *
 * Verdict semantics:
 *   allow  — path is in scope, or no story/guard-session context exists.
 *   deny   — path is out of scope in enforce mode, or the contract is corrupt,
 *             or the guard session is ambiguous (multiple active sessions).
 *   shadow — path is out of scope in shadow mode (log, do not block).
 *   ask    — path is out of scope in local mode (surface to user, do not block).
 */

import { resolve, relative, isAbsolute } from 'node:path';
import type { ScopeContractData } from './types.js';

// ── Verdict ──

export type PrewriteVerdict = 'allow' | 'deny' | 'ask' | 'shadow';

export interface PrewriteViolation {
  path: string;
  rule: 'out_of_scope' | 'protected' | 'excluded';
}

export interface PrewriteGuardResult {
  verdict: PrewriteVerdict;
  /** Normalized (project-root-relative) paths that were evaluated. */
  targetPaths: string[];
  /** Story context resolved for this check (absent when no context found). */
  storyId?: string;
  /** Human-readable reasons for the verdict. */
  reasons: string[];
  /** Specific per-path violations (present for deny/ask/shadow). */
  violations?: PrewriteViolation[];
  /**
   * True when no guard session or story context exists. The verdict is still
   * 'allow' for backward compatibility with stories that never started a guard
   * session or have no scope contract.
   */
  noDecision?: boolean;
}

// ── Write-tool path extraction ──

/**
 * Canonical names for write-like tools whose input JSON contains a target path.
 * Matched case-insensitively after stripping non-alphanumeric chars.
 */
const WRITE_TOOL_NORMALIZED = new Set([
  'edit',
  'write',
  'multiedit',
  'notebookedit',
  // common aliases
  'strreplaceeditor',
  'strreplaceeditortool',
  'strreplacemultiedittool',
  'notebookeditortool',
  'createfile',
  'writefile',
  'editfile',
]);

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isWriteLikeTool(toolName: string): boolean {
  return WRITE_TOOL_NORMALIZED.has(normalizeToolName(toolName));
}

/**
 * Extract the target file path(s) from a write-like tool's input JSON.
 * Returns an empty array when the input cannot be parsed or yields no path.
 */
export function extractPathsFromToolInput(toolName: string, toolInputJson: string): string[] {
  if (!isWriteLikeTool(toolName)) return [];
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(toolInputJson) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (typeof input !== 'object' || input === null) return [];

  const normalized = normalizeToolName(toolName);

  // NotebookEdit uses notebook_path
  if (normalized === 'notebookedit' || normalized === 'notebookeditortool') {
    const p = input['notebook_path'] ?? input['path'] ?? input['file_path'];
    return typeof p === 'string' && p.trim().length > 0 ? [p.trim()] : [];
  }

  // MultiEdit may carry edits[] array with per-file paths, but the primary path is top-level
  const p = input['path'] ?? input['file_path'] ?? input['filePath'];
  if (typeof p === 'string' && p.trim().length > 0) return [p.trim()];

  return [];
}

// ── Path normalization ──

/**
 * Normalize a raw path (possibly absolute or cwd-relative) to a path
 * relative to projectRoot. Returns null for paths that escape the project root
 * or are otherwise unsafe.
 */
export function normalizeToProjectRoot(
  rawPath: string,
  projectRoot: string,
  cwd: string,
): string | null {
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const rel = relative(projectRoot, abs);
  // Paths that escape the root start with '..' — reject them.
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

// ── Scope evaluation ──

function pathMatchesPattern(filePath: string, pattern: string): boolean {
  if (filePath === pattern) return true;
  if (filePath.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`)) return true;
  const globless = pattern.replace(/\/\*\*?$/, '').replace(/\*$/, '');
  if (globless !== pattern && filePath.startsWith(globless)) return true;
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1);
    if (filePath.endsWith(ext)) return true;
  }
  return false;
}

function isInAllowedList(filePath: string, lists: readonly string[][]): boolean {
  return lists.some(list => list.some(p => pathMatchesPattern(filePath, p)));
}

function isAcknowledged(filePath: string, contract: ScopeContractData): boolean {
  return contract.acknowledgements.some(ack =>
    ack.paths.some(p => pathMatchesPattern(filePath, p)),
  );
}

/**
 * Evaluate a single normalized path against a scope contract. Returns a
 * violation descriptor when the path is forbidden, null when allowed.
 */
export function evaluatePathAgainstContract(
  normalizedPath: string,
  contract: ScopeContractData,
): PrewriteViolation | null {
  const allAllowed: string[][] = [
    contract.allowedModify,
    contract.allowedCreate,
    contract.allowedTest,
  ];

  const isProtected = contract.protectedFiles.some(p => pathMatchesPattern(normalizedPath, p));
  if (isProtected) return { path: normalizedPath, rule: 'protected' };

  const isExcluded = contract.explicitExcludes.some(p => pathMatchesPattern(normalizedPath, p));
  if (isExcluded) return { path: normalizedPath, rule: 'excluded' };

  const hasAnyAllowedList = allAllowed.some(l => l.length > 0);
  if (!hasAnyAllowedList) return null; // no restriction defined, allow by default

  const inScope = isInAllowedList(normalizedPath, allAllowed);
  if (inScope) return null;

  const acked = isAcknowledged(normalizedPath, contract);
  if (acked) return null; // explicitly acknowledged out-of-scope change

  return { path: normalizedPath, rule: 'out_of_scope' };
}

// ── Verdict computation ──

/**
 * Compute the prewrite verdict given a set of violations and the contract mode.
 *
 * - local   → any violation → ask (surface to user, do not hard-block)
 * - shadow  → any violation → shadow (log, do not block)
 * - enforce → any violation → deny
 * - no violations → allow
 */
export function computeVerdict(
  violations: readonly PrewriteViolation[],
  mode: ScopeContractData['mode'],
): PrewriteVerdict {
  if (violations.length === 0) return 'allow';
  if (mode === 'enforce') return 'deny';
  if (mode === 'shadow') return 'shadow';
  return 'ask'; // local mode
}

// ── Main guard check (pure) ──

export interface PrewriteGuardInput {
  /** Normalized paths (project-root-relative) to evaluate. */
  normalizedPaths: string[];
  /** Contract to check against. Null → no contract (allow, noDecision). */
  contract: ScopeContractData | null;
  /** storyId associated with the contract. */
  storyId?: string;
  /** Error describing why the contract could not be loaded (corrupt). */
  contractError?: string;
  /** Error describing why story resolution failed (ambiguous sessions). */
  resolutionError?: string;
  /** Optional reason to render when no contract/context should be treated as an allow/no-decision. */
  noDecisionReason?: string;
}

/**
 * Core prewrite guard check (pure — no I/O).
 *
 * Call this after resolving paths, loading the contract, and discovering the
 * story context. The handler wires all I/O and calls this function.
 */
export function runPrewriteGuardCheck(input: PrewriteGuardInput): PrewriteGuardResult {
  const { normalizedPaths, contract, storyId, contractError, resolutionError, noDecisionReason } = input;

  // Fail-closed: corrupt contract
  if (contractError) {
    return {
      verdict: 'deny',
      targetPaths: normalizedPaths,
      storyId,
      reasons: [`Scope contract could not be loaded (fail-closed): ${contractError}`],
    };
  }

  // Fail-closed: ambiguous active guard sessions
  if (resolutionError) {
    return {
      verdict: 'deny',
      targetPaths: normalizedPaths,
      reasons: [`Guard session resolution failed (fail-closed): ${resolutionError}`],
    };
  }

  // No contract → no story context or story has no scope contract → backward-compatible allow
  if (!contract) {
    return {
      verdict: 'allow',
      targetPaths: normalizedPaths,
      storyId,
      reasons: [noDecisionReason ?? 'No scope contract found — proceeding without restriction (no-decision).'],
      noDecision: true,
    };
  }

  if (normalizedPaths.length === 0) {
    return {
      verdict: 'allow',
      targetPaths: [],
      storyId,
      reasons: ['No target paths to evaluate.'],
    };
  }

  const violations: PrewriteViolation[] = [];
  for (const p of normalizedPaths) {
    const v = evaluatePathAgainstContract(p, contract);
    if (v) violations.push(v);
  }

  const verdict = computeVerdict(violations, contract.mode);
  const reasons: string[] = [];

  if (violations.length === 0) {
    reasons.push(`All ${normalizedPaths.length} path(s) are within scope (mode=${contract.mode}).`);
  } else {
    reasons.push(
      `${violations.length} path(s) are out of scope (mode=${contract.mode}, verdict=${verdict}).`,
    );
    for (const v of violations) {
      reasons.push(`  ${v.rule.toUpperCase()}: ${v.path}`);
    }
  }

  return {
    verdict,
    targetPaths: normalizedPaths,
    storyId,
    reasons,
    ...(violations.length > 0 ? { violations } : {}),
  };
}
