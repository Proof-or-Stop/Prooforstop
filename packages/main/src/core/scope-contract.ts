/**
 * scope-contract.ts — story scope contract model, validation, and check logic.
 *
 * Core pure logic (no I/O). Handlers in handlers/scope-contract.ts wire this to CLI.
 */

import type {
  ScopeContractData,
  ScopeContractMode,
  ScopeCheckResult,
  ScopeCheckRow,
  ScopeViolation,
  FileRule,
  ChangeKind,
  ScopePathClassification,
  ScopeGateStatus,
} from './types.js';
import { execFileSync } from 'node:child_process';
import { loadConfig } from './config.js';
import {
  canonicalizeScopePath,
  classifyScopePath,
  normalizeScopePath,
  pathMatchesScopePattern,
  SCOPE_PATH_CANONICALIZER_VERSION,
} from './scope-path-classifier.js';

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
  const addNameStatus = (output: string): void => {
    for (const line of output.trim().split('\n')) {
      if (!line) continue;
      const fields = line.split('\t');
      const status = fields[0] ?? '';
      if (/^[RC]\d+$/.test(status) && fields.length >= 3) {
        // Both identities matter: a rename removes the old path and introduces
        // the new path. Keeping only the target can bypass old-path protection.
        files.add(fields[1]!.trim());
        files.add(fields[2]!.trim());
      } else {
        const path = fields.at(-1)?.trim();
        if (path) files.add(path);
      }
    }
  };
  try {
    // Tracked changed files vs merge-base with main
    const tracked = execFileSync(
      'git', ['diff', '--name-status', '--find-renames', 'main...HEAD'],
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    if (tracked) addNameStatus(tracked);
  } catch { /* not a git repo or no main branch */ }
  try {
    // Unstaged changes on top of HEAD
    const unstaged = execFileSync(
      'git', ['diff', '--name-status', '--find-renames'],
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    if (unstaged) addNameStatus(unstaged);
  } catch { /* ignore */ }
  try {
    // Staged changes not yet committed
    const staged = execFileSync(
      'git', ['diff', '--name-status', '--find-renames', '--cached'],
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    if (staged) addNameStatus(staged);
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

/**
 * Return only exact repo-root paths removed by the current story diff: deleted
 * paths and the old side of a rename. These identities are useful when a
 * one-shot migration has already removed the old file, leaving filesystem
 * ancestry unable to distinguish repo-root from source-root.
 *
 * The NUL-delimited parser is deliberately narrower than readChangedFiles:
 * additions, modifications, copies, rename destinations, untracked files and
 * arbitrary missing paths never enter this set.
 */
export function readRetiredRepoRootDiffPaths(gitCwd: string): string[] {
  const paths = new Set<string>();
  const addNameStatus = (output: string): void => {
    const fields = output.split('\0');
    let index = 0;
    while (index < fields.length) {
      const status = fields[index++];
      if (!status) continue;
      if (status === 'D') {
        const removed = fields[index++];
        if (removed) paths.add(normalizeScopePath(removed));
        continue;
      }
      if (/^R\d+$/.test(status)) {
        const removed = fields[index++];
        index++; // the rename destination is active, not retired
        if (removed) paths.add(normalizeScopePath(removed));
        continue;
      }
      if (/^C\d+$/.test(status)) {
        // Copies carry two paths like renames, but their source remains active.
        index += 2;
        continue;
      }
      // All remaining name-status records have exactly one path.
      index++;
    }
  };
  for (const args of [
    ['diff', '--name-status', '-z', '--find-renames', 'main...HEAD'],
    ['diff', '--name-status', '-z', '--find-renames'],
    ['diff', '--name-status', '-z', '--find-renames', '--cached'],
  ]) {
    try {
      addNameStatus(execFileSync('git', args, {
        cwd: gitCwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }));
    } catch { /* no repository/main ref: no trusted retired-path provenance */ }
  }
  return [...paths].filter(Boolean).sort();
}

// ── Path matching ──

function isAcknowledged(filePath: string, contract: ScopeContractData): boolean {
  return contract.acknowledgements.some(ack => ack.paths.some(p => pathMatchesScopePattern(filePath, p)));
}

function rowPathSlug(path: string): string {
  const slug = normalizeScopePath(path)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'root';
}

function scopeRowId(classification: ScopePathClassification, rule = classification.rule): string {
  if (rule === 'lifecycle_artifact') {
    const segments = classification.normalizedPath.split('/');
    const storyId = segments.find((segment) => /^B-[A-Za-z0-9-]+$/.test(segment)) ?? 'unknown-story';
    const fileName = segments[segments.length - 1] || rowPathSlug(classification.normalizedPath);
    return `scope.lifecycle_artifact:${storyId}:${fileName}`;
  }
  if (rule === 'runtime_artifact') {
    return `scope.runtime_artifact:${classification.registryId ?? 'registered'}:${classification.normalizedPath}`;
  }
  return `scope.${rule}:${classification.normalizedPath || rowPathSlug(classification.path)}`;
}

function passRow(classification: ScopePathClassification): ScopeCheckRow {
  return {
    id: scopeRowId(classification),
    status: 'pass',
    blocking: false,
    path: classification.path,
    source: classification.path,
    classifierSource: classification.source,
    category: classification.category,
    rule: classification.rule,
    detail: classification.detail,
    hint: classification.hint ?? 'This path is non-blocking under the shared scope classifier.',
  };
}

function violationStatus(contract: ScopeContractData, violation: ScopeViolation, emittedAsWarning: boolean): ScopeGateStatus {
  if (emittedAsWarning) return 'warn';
  if (contract.mode === 'enforce' && !violation.acknowledged) return 'fail';
  return 'warn';
}

function nextActionForViolation(contract: ScopeContractData, violation: ScopeViolation): string {
  if (violation.acknowledged) {
    return 'No blocking action; keep the acknowledgement visible for review.';
  }
  if (violation.rule === 'protected') {
    return 'Revert the protected path or re-plan with an explicit reviewed scope change.';
  }
  if (violation.rule === 'excluded') {
    return 'Revert the excluded path or re-plan before continuing this work.';
  }
  if (contract.mode === 'enforce') {
    return 'Run scope_contract_acknowledge with a reviewer-visible reason, add the path to the contract, or revert it.';
  }
  return 'Treat as advisory now; acknowledge, declare scope, or revert before enforcing this contract.';
}

function problemRow(
  contract: ScopeContractData,
  classification: ScopePathClassification,
  violation: ScopeViolation,
  emittedAsWarning: boolean,
): ScopeCheckRow {
  const status = violationStatus(contract, violation, emittedAsWarning);
  return {
    id: scopeRowId(classification, violation.rule),
    status,
    blocking: status === 'fail',
    path: violation.path,
    source: violation.path,
    classifierSource: classification.source,
    category: classification.category,
    rule: violation.rule,
    detail: `${classification.detail}${violation.acknowledged ? ' A matching acknowledgement exists.' : ''}`,
    nextAction: nextActionForViolation(contract, violation),
    hint: classification.hint ?? 'Scope rows are derived from the shared path classifier; unclassified paths use out_of_scope behavior.',
  };
}

// ── Core check function ──

export function checkScopeContract(
  originalContract: ScopeContractData,
  changedFiles: string[],
  options: { projectRoot?: string; gitCwd?: string } = {},
): ScopeCheckResult {
  let contract = originalContract;
  const violations: ScopeViolation[] = [];
  const warnings: ScopeViolation[] = [];
  const rows: ScopeCheckRow[] = [];
  const livePathMode = options.projectRoot
    ? (loadConfig(options.projectRoot).scopeProtection?.pathCanonicalization ?? 'enforce')
    : contract.pathCanonicalizationMode;
  const versionCurrent = contract.pathCanonicalizerVersion === SCOPE_PATH_CANONICALIZER_VERSION;
  let migrationWarning: string | undefined;

  if (livePathMode === 'enforce' && !versionCurrent) {
    const violations = changedFiles.map((path) => ({
      path,
      rule: 'out_of_scope' as const,
      acknowledged: false,
    }));
    return {
      status: 'fail',
      mode: contract.mode,
      changedFiles,
      violations,
      warnings: [],
      acknowledgedPaths: [],
      rows: changedFiles.map((path) => ({
        id: `scope.out_of_scope:${normalizeScopePath(path)}`,
        status: 'fail',
        blocking: true,
        path,
        source: path,
        classifierSource: 'changed-files',
        category: 'unknown',
        rule: 'out_of_scope',
        detail: `Scope path artifact is stale: observed canonicalizer=${contract.pathCanonicalizerVersion ?? 'legacy'}, expected=${SCOPE_PATH_CANONICALIZER_VERSION}.`,
        nextAction: 'Re-run scope_contract_init_from_plan (or scope_contract_set) to re-attest paths under the current canonicalizer.',
      })),
      summary: 'Scope gate: fail (path canonicalizer version drift; re-attestation required)',
    };
  }
  if (livePathMode === 'warn' && !versionCurrent) {
    migrationWarning = `Scope path migration advisory: observed canonicalizer=${contract.pathCanonicalizerVersion ?? 'legacy'}, expected=${SCOPE_PATH_CANONICALIZER_VERSION}; artifact was interpreted in memory and not rewritten.`;
    if (!contract.pathCanonicalizerVersion && options.projectRoot) {
      const config = loadConfig(options.projectRoot);
      const canonicalize = (values: string[]): string[] => values.map((input) => canonicalizeScopePath({
        projectRoot: options.projectRoot!,
        scanRoot: config.scanRoot,
        sourceRoot: config.rootDir ?? config.scanRoot,
        input,
      }).canonicalPath);
      try {
        contract = {
          ...contract,
          allowedModify: canonicalize(contract.allowedModify),
          allowedCreate: canonicalize(contract.allowedCreate),
          allowedTest: canonicalize(contract.allowedTest),
          protectedFiles: canonicalize(contract.protectedFiles),
          explicitExcludes: canonicalize(contract.explicitExcludes),
          fileRules: contract.fileRules?.map((rule) => ({ ...rule, path: canonicalize([rule.path])[0]! })),
          acknowledgements: contract.acknowledgements.map((ack) => ({ ...ack, paths: canonicalize(ack.paths) })),
        };
      } catch (error) {
        migrationWarning += ` Legacy canonicalization failed closed to original spelling: ${(error as Error).message}`;
      }
    }
  }

  const allAllowedLists = [
    contract.allowedModify,
    contract.allowedCreate,
    contract.allowedTest,
  ];
  const hasAllowedScope = allAllowedLists.some(l => l.length > 0);

  for (const file of changedFiles) {
    const classification = classifyScopePath(contract, file, options);
    const acked = isAcknowledged(file, contract);

    if (classification.allowed) {
      rows.push(passRow(classification));
    } else if (classification.registryId === 'shared-gap-log-metadata-v1') {
      const v: ScopeViolation = { path: file, rule: 'out_of_scope', acknowledged: false };
      violations.push(v);
      rows.push(problemRow(contract, classification, v, false));
    } else if (classification.category === 'protected') {
      const v: ScopeViolation = { path: file, rule: 'protected', acknowledged: false };
      violations.push(v);
      rows.push(problemRow(contract, classification, v, false));
    } else if (classification.category === 'excluded') {
      const v: ScopeViolation = { path: file, rule: 'excluded', acknowledged: false };
      violations.push(v);
      rows.push(problemRow(contract, classification, v, false));
    } else if (hasAllowedScope) {
      // only flag out_of_scope when at least one allowedXxx list is non-empty
      const v: ScopeViolation = { path: file, rule: 'out_of_scope', acknowledged: acked };
      if (contract.mode === 'shadow') {
        warnings.push(v);
        rows.push(problemRow(contract, classification, v, true));
      } else {
        violations.push(v);
        rows.push(problemRow(contract, classification, v, false));
      }
    } else {
      rows.push({
        ...passRow(classification),
        detail: `${classification.detail} No allowed path set is configured, so v1 compatibility leaves this path unblocked.`,
      });
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

  if (migrationWarning) {
    rows.push({
      id: 'scope.path_migration',
      status: 'warn',
      blocking: false,
      classifierSource: 'changed-files',
      category: 'unknown',
      rule: 'out_of_scope',
      detail: migrationWarning,
      nextAction: 'Re-attest the scope contract under the current canonicalizer before enabling enforce mode.',
    });
    if (status === 'pass') status = 'warn';
  }

  return {
    status,
    mode: contract.mode,
    changedFiles,
    violations,
    warnings,
    acknowledgedPaths,
    rows,
    summary: migrationWarning ? `${summary}; ${migrationWarning}` : summary,
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
  const actionableRows = (result.rows ?? []).filter(row => row.status !== 'pass' || row.nextAction);
  if (actionableRows.length > 0) {
    lines.push('Scope rows:');
    for (const row of actionableRows) {
      const blocking = row.blocking ? ' blocking=true' : ' blocking=false';
      const path = row.path ? ` path=${row.path}` : '';
      const source = row.source ? ` source=${row.source}` : '';
      const classifierSource = row.classifierSource ? ` classifierSource=${row.classifierSource}` : '';
      const category = row.category ? ` category=${row.category}` : '';
      const rule = row.rule ? ` rule=${row.rule}` : '';
      lines.push(`  ${row.id}: ${row.status}${blocking}${path}${source}${classifierSource}${category}${rule}`);
      lines.push(`    detail: ${row.detail}`);
      if (row.nextAction) lines.push(`    nextAction: ${row.nextAction}`);
      if (row.hint) lines.push(`    hint: ${row.hint}`);
    }
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
      const anchorKind = v.anchorKind ? ` anchorKind=${v.anchorKind}` : '';
      const anchorRange = v.anchorRange ? ` anchorRange=${v.anchorRange.start}-${v.anchorRange.end}` : '';
      const versions = v.anchorParserVersion
        ? ` parserVersion=${v.anchorParserVersion} artifactVersion=${v.anchorArtifactVersion ?? '(missing)'}`
        : '';
      const digest = v.hunkDigest ? ` hunkDigest=${v.hunkDigest}` : '';
      lines.push(`  ${v.rule.toUpperCase()}: ${v.path}${anchor}${anchorKind}${anchorRange}${versions}${digest}${ackTag}`);
      if (v.detail) lines.push(`    detail: ${v.detail}`);
      if (v.nextAction) lines.push(`    nextAction: ${v.nextAction}`);
    }
  }
  return lines.join('\n');
}
