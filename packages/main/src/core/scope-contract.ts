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
  FileRule,
  ChangeKind,
} from './types.js';
import { execFileSync } from 'node:child_process';
import { classifyLifecycleArtifact } from './lifecycle-registry.js';
import { isRuntimeArtifactPath } from './runtime-artifact-registry.js';

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

// ── v2 validation helpers ──

const VALID_CHANGE_KINDS = new Set<ChangeKind>(['add', 'remove', 'modify', 'rename']);

/** Valid anchor: identifier chars plus dots for qualified names (e.g. MyClass.method). No slashes, spaces, or path chars. */
const ANCHOR_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

export function validateAnchors(anchors: unknown, fieldName: string): string[] {
  if (anchors == null) return [];
  if (!Array.isArray(anchors)) throw new Error(`${fieldName} must be an array`);
  const out: string[] = [];
  for (const a of anchors) {
    if (typeof a !== 'string' || a.trim().length === 0) {
      throw new Error(`${fieldName} contains an invalid anchor: ${JSON.stringify(a)}`);
    }
    const trimmed = a.trim();
    if (!ANCHOR_RE.test(trimmed)) {
      throw new Error(`${fieldName} contains an invalid anchor (must be a valid identifier or qualified name): ${JSON.stringify(a)}`);
    }
    out.push(trimmed);
  }
  return out;
}

/** Valid hunk digest: hex string 8–128 chars. */
const HEX_RE = /^[0-9a-fA-F]{8,128}$/;

export function validateHunkDigest(digest: unknown, fieldName: string): string {
  if (typeof digest !== 'string') throw new Error(`${fieldName} must be a string`);
  const trimmed = digest.trim();
  if (!HEX_RE.test(trimmed)) {
    throw new Error(`${fieldName} must be a hex string between 8 and 128 characters`);
  }
  return trimmed.toLowerCase();
}

export function validateFileRules(rules: unknown): FileRule[] {
  if (rules == null) return [];
  if (!Array.isArray(rules)) throw new Error('fileRules must be an array');
  const out: FileRule[] = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (typeof r !== 'object' || r === null) {
      throw new Error(`fileRules[${i}] must be an object`);
    }
    const rule = r as Record<string, unknown>;
    const pathArr = validatePaths([rule.path], `fileRules[${i}].path`);
    if (pathArr.length === 0) throw new Error(`fileRules[${i}].path is required`);
    const item: FileRule = { path: pathArr[0] };
    if (rule.allowedAnchors !== undefined) {
      item.allowedAnchors = validateAnchors(rule.allowedAnchors, `fileRules[${i}].allowedAnchors`);
    }
    if (rule.deniedAnchors !== undefined) {
      item.deniedAnchors = validateAnchors(rule.deniedAnchors, `fileRules[${i}].deniedAnchors`);
    }
    if (rule.protectedAnchors !== undefined) {
      item.protectedAnchors = validateAnchors(rule.protectedAnchors, `fileRules[${i}].protectedAnchors`);
    }
    if (rule.allowedChangeKinds !== undefined) {
      if (!Array.isArray(rule.allowedChangeKinds)) {
        throw new Error(`fileRules[${i}].allowedChangeKinds must be an array`);
      }
      for (const k of rule.allowedChangeKinds) {
        if (!VALID_CHANGE_KINDS.has(k as ChangeKind)) {
          throw new Error(`fileRules[${i}].allowedChangeKinds contains invalid kind: ${JSON.stringify(k)}`);
        }
      }
      item.allowedChangeKinds = rule.allowedChangeKinds as ChangeKind[];
    }
    if (rule.intentRefs !== undefined) {
      if (!Array.isArray(rule.intentRefs)) {
        throw new Error(`fileRules[${i}].intentRefs must be an array`);
      }
      item.intentRefs = rule.intentRefs.map((ref, idx) => {
        if (typeof ref !== 'string' || ref.trim().length === 0) {
          throw new Error(`fileRules[${i}].intentRefs[${idx}] must be a non-empty string`);
        }
        return ref.trim();
      });
    }
    out.push(item);
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
    fileRules?: FileRule[];
    protectedAnchors?: string[];
  },
  existing?: ScopeContractData,
): ScopeContractData {
  const now = new Date().toISOString();
  const contract: ScopeContractData = {
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
  // v2 fields: only set when provided or already present
  const fileRules = args.fileRules ?? existing?.fileRules;
  if (fileRules !== undefined) contract.fileRules = fileRules;
  const protectedAnchors = args.protectedAnchors ?? existing?.protectedAnchors;
  if (protectedAnchors !== undefined) contract.protectedAnchors = protectedAnchors;
  return contract;
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
    // B-b9d0 CHK-001/002: command-generated Koala lifecycle artifacts are
    // recognized via lifecycle-artifact-scope. A strict `lifecycle` match
    // means `<storyDir>/<storyId>/<known artifact filename>` — narrow,
    // story-scoped, filename-aware. Legacy story-tree paths
    // (`docs/story/.../B-xxx/...`, `.koala/story/.../B-xxx/...`) still pass
    // for back-compat with PLAN-time files (plan.md, understanding.json, …).
    //
    // Runtime artifacts (`.koala/activity.jsonl`, `.koala/runtime/`,
    // `.koala/traces/`, `.koala/locks/`, owner-lease.json, …) are skipped via
    // the registry predicate — NOT a blanket `.koala/` exemption. An arbitrary
    // unknown file like `.koala/foo.json` is NOT a runtime artifact and NOT a
    // lifecycle artifact, so it falls through to normal scope enforcement
    // (adversarial requirement: product source and arbitrary JSON still fail).
    if (classifyLifecycleArtifact(file, { storyId: contract.storyId })) continue;
    if (isRuntimeArtifactPath(file)) continue;

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
  // v2 semantic block (B-6bfd CHK-003): explicit "Semantic scope gate: pass/fail"
  // with the violating path, anchor, and hunkDigest. Skipped for v1 contracts,
  // which never attach `semantic`, keeping their output path-only.
  if (result.semantic && result.semantic.status !== 'skip') {
    lines.push('');
    lines.push(result.semantic.summary);
    for (const v of [...result.semantic.violations, ...result.semantic.warnings]) {
      const ackTag = v.acknowledged ? ' [acknowledged]' : '';
      const anchor = v.anchor ? ` anchor=${v.anchor}` : ' anchor=(none)';
      const digest = v.hunkDigest ? ` hunkDigest=${v.hunkDigest}` : '';
      lines.push(`  ${v.rule.toUpperCase()}: ${v.path}${anchor}${digest}${ackTag}`);
    }
  }
  return lines.join('\n');
}
