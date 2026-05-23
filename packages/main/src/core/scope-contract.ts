/**
 * scope-contract.ts — story scope contract model, validation, and check logic.
 *
 * Core pure logic (no I/O). Handlers in handlers/scope-contract.ts wire this to CLI.
 */

import type {
  ScopeContractData,
  ScopeContractMode,
  ScopeCheckResult,
  ScopeViolation,
} from './types.js';
import { execFileSync } from 'node:child_process';

// ── Validation ──

const VALID_MODES = new Set<ScopeContractMode>(['local', 'shadow', 'enforce']);

export function validateMode(mode: unknown): ScopeContractMode {
  if (!VALID_MODES.has(mode as ScopeContractMode)) {
    throw new Error(`Invalid mode "${mode}". Must be one of: local, shadow, enforce`);
  }
  return mode as ScopeContractMode;
}

export function validatePaths(paths: unknown, fieldName: string): string[] {
  if (paths == null) return [];
  if (!Array.isArray(paths)) throw new Error(`${fieldName} must be an array`);
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || p.trim().length === 0) {
      throw new Error(`${fieldName} contains an invalid path: ${JSON.stringify(p)}`);
    }
    const normalized = p.trim().replace(/\\/g, '/');
    if (normalized.includes('\0')) {
      throw new Error(`${fieldName} contains a path with null byte: ${JSON.stringify(p)}`);
    }
    if (normalized.startsWith('/') || normalized.includes('../') || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`${fieldName} contains an unsafe relative path: ${JSON.stringify(p)}`);
    }
    out.push(normalized);
  }
  return out;
}

// ── Contract construction helper ──

export function buildScopeContract(
  storyId: string,
  args: {
    mode: ScopeContractMode;
    allowedModify?: string[];
    allowedCreate?: string[];
    allowedTest?: string[];
    protectedFiles?: string[];
    explicitExcludes?: string[];
    scopeChangeReason?: string;
  },
  existing?: ScopeContractData,
): ScopeContractData {
  const now = new Date().toISOString();
  return {
    storyId,
    mode: args.mode,
    allowedModify: args.allowedModify ?? existing?.allowedModify ?? [],
    allowedCreate: args.allowedCreate ?? existing?.allowedCreate ?? [],
    allowedTest: args.allowedTest ?? existing?.allowedTest ?? [],
    protectedFiles: args.protectedFiles ?? existing?.protectedFiles ?? [],
    explicitExcludes: args.explicitExcludes ?? existing?.explicitExcludes ?? [],
    scopeChangeReason: args.scopeChangeReason ?? existing?.scopeChangeReason,
    acknowledgements: existing?.acknowledgements ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

// ── Git diff reader ──

export type GitChangedFilesReader = (projectRoot: string) => string[];

/**
 * Returns all files changed relative to main (staged + unstaged + untracked).
 * Falls back to empty array on git errors (e.g. no commits yet).
 */
export function readChangedFiles(projectRoot: string): string[] {
  const files = new Set<string>();
  try {
    // Tracked changed files vs merge-base with main
    const tracked = execFileSync(
      'git', ['diff', '--name-only', 'main...HEAD'],
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    if (tracked) {
      for (const f of tracked.split('\n')) {
        const t = f.trim();
        if (t) files.add(t);
      }
    }
  } catch { /* not a git repo or no main branch */ }
  try {
    // Unstaged changes on top of HEAD
    const unstaged = execFileSync(
      'git', ['diff', '--name-only'],
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    if (unstaged) {
      for (const f of unstaged.split('\n')) {
        const t = f.trim();
        if (t) files.add(t);
      }
    }
  } catch { /* ignore */ }
  try {
    // Staged changes not yet committed
    const staged = execFileSync(
      'git', ['diff', '--name-only', '--cached'],
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    if (staged) {
      for (const f of staged.split('\n')) {
        const t = f.trim();
        if (t) files.add(t);
      }
    }
  } catch { /* ignore */ }
  try {
    // Untracked files
    const untracked = execFileSync(
      'git', ['ls-files', '--others', '--exclude-standard'],
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    if (untracked) {
      for (const f of untracked.split('\n')) {
        const t = f.trim();
        if (t) files.add(t);
      }
    }
  } catch { /* ignore */ }
  return [...files].sort();
}

// ── Path matching (simple prefix/exact; globs treated as prefix patterns) ──

function pathMatchesPattern(filePath: string, pattern: string): boolean {
  // exact match
  if (filePath === pattern) return true;
  // directory prefix (e.g. "src/core" matches "src/core/foo.ts")
  if (filePath.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`)) return true;
  // glob-like: pattern ends with /* or /** — treat as prefix
  const globless = pattern.replace(/\/\*\*?$/, '').replace(/\*$/, '');
  if (globless !== pattern && filePath.startsWith(globless)) return true;
  // wildcard extension: *.ts → any .ts file
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1);
    if (filePath.endsWith(ext)) return true;
  }
  return false;
}

function isAllowed(filePath: string, lists: string[][]): boolean {
  return lists.some(list => list.some(p => pathMatchesPattern(filePath, p)));
}

function isAcknowledged(filePath: string, contract: ScopeContractData): boolean {
  return contract.acknowledgements.some(ack => ack.paths.some(p => pathMatchesPattern(filePath, p)));
}

// ── Core check function ──

export function checkScopeContract(
  contract: ScopeContractData,
  changedFiles: string[],
): ScopeCheckResult {
  const violations: ScopeViolation[] = [];
  const warnings: ScopeViolation[] = [];

  const allAllowedLists = [
    contract.allowedModify,
    contract.allowedCreate,
    contract.allowedTest,
  ];

  for (const file of changedFiles) {
    // story metadata files are always allowed
    if (file.startsWith('docs/story/')) continue;
    if (file.startsWith('.koala/')) continue;

    const isProtected = contract.protectedFiles.some(p => pathMatchesPattern(file, p));
    const isExcluded = contract.explicitExcludes.some(p => pathMatchesPattern(file, p));
    const isInScope = isAllowed(file, allAllowedLists);
    const acked = isAcknowledged(file, contract);

    if (isProtected) {
      violations.push({ path: file, rule: 'protected', acknowledged: false });
    } else if (isExcluded) {
      violations.push({ path: file, rule: 'excluded', acknowledged: false });
    } else if (!isInScope && allAllowedLists.some(l => l.length > 0)) {
      // only flag out_of_scope when at least one allowedXxx list is non-empty
      const v: ScopeViolation = { path: file, rule: 'out_of_scope', acknowledged: acked };
      if (contract.mode === 'shadow') {
        warnings.push(v);
      } else {
        violations.push(v);
      }
    }
  }

  const unackedViolations = violations.filter(v => !v.acknowledged);
  const acknowledgedPaths = contract.acknowledgements.flatMap(a => a.paths);

  let status: ScopeCheckResult['status'];
  if (contract.mode === 'local') {
    status = violations.length > 0 || warnings.length > 0 ? 'warn' : 'pass';
  } else if (contract.mode === 'shadow') {
    status = warnings.length > 0 || violations.length > 0 ? 'warn' : 'pass';
  } else {
    // enforce
    status = unackedViolations.length > 0 ? 'fail' : (violations.length > 0 && violations.every(v => v.acknowledged) ? 'warn' : 'pass');
    if (warnings.length > 0 && status === 'pass') status = 'warn';
  }

  const violationCount = unackedViolations.length;
  const warnCount = warnings.length;
  const summary = status === 'pass'
    ? `Scope gate: pass (${changedFiles.length} changed file(s), 0 unacknowledged violations)`
    : status === 'warn'
    ? `Scope gate: warn (${warnCount + violations.filter(v => v.acknowledged).length} warning(s), mode=${contract.mode})`
    : `Scope gate: fail (${violationCount} unacknowledged violation(s), mode=enforce)`;

  return {
    status,
    mode: contract.mode,
    changedFiles,
    violations,
    warnings,
    acknowledgedPaths,
    summary,
  };
}

export function renderScopeCheckResult(result: ScopeCheckResult): string {
  const lines: string[] = [result.summary];
  if (result.changedFiles.length > 0) {
    lines.push(`Changed files (${result.changedFiles.length}):`);
    for (const f of result.changedFiles) lines.push(`  ${f}`);
  }
  const allProblems = [...result.violations, ...result.warnings];
  if (allProblems.length > 0) {
    lines.push('Violations/warnings:');
    for (const v of allProblems) {
      const ackTag = v.acknowledged ? ' [acknowledged]' : '';
      lines.push(`  ${v.rule.toUpperCase()}: ${v.path}${ackTag}`);
    }
  }
  if (result.acknowledgedPaths.length > 0) {
    lines.push(`Acknowledged paths: ${result.acknowledgedPaths.join(', ')}`);
  }
  return lines.join('\n');
}
