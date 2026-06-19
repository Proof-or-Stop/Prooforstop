/**
 * Canonical path classifier for scope-contract checks.
 *
 * This module answers "what kind of path is this?" only. Gate severity still
 * lives in scope-contract.ts so existing pass/warn/fail behavior stays stable.
 */

import { classifyLifecycleArtifact } from './lifecycle-registry.js';
import { findRuntimeArtifactEntry } from './runtime-artifact-registry.js';
import type {
  ScopeContractData,
  ScopePathCategory,
  ScopePathClassification,
  ScopePathRule,
  ScopePathSource,
} from './types.js';

export function normalizeScopePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

export function pathMatchesScopePattern(filePath: string, pattern: string): boolean {
  const normalizedFile = normalizeScopePath(filePath);
  const normalizedPattern = normalizeScopePath(pattern);
  if (!normalizedFile || !normalizedPattern) return false;
  if (normalizedFile === normalizedPattern) return true;
  if (normalizedFile.startsWith(normalizedPattern.endsWith('/') ? normalizedPattern : `${normalizedPattern}/`)) return true;
  const globless = normalizedPattern.replace(/\/\*\*?$/, '').replace(/\*$/, '');
  if (globless !== normalizedPattern && normalizedFile.startsWith(globless)) return true;
  if (normalizedPattern.startsWith('*.') && normalizedFile.endsWith(normalizedPattern.slice(1))) return true;
  return false;
}

function firstMatchedPattern(filePath: string, patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => pathMatchesScopePattern(filePath, pattern));
}

function classification(args: {
  path: string;
  category: ScopePathCategory;
  source: ScopePathSource;
  rule: ScopePathRule;
  allowed: boolean;
  detail: string;
  matchedPattern?: string;
  registryId?: string;
  hint?: string;
}): ScopePathClassification {
  return {
    path: args.path,
    normalizedPath: normalizeScopePath(args.path),
    category: args.category,
    source: args.source,
    rule: args.rule,
    allowed: args.allowed,
    detail: args.detail,
    ...(args.matchedPattern ? { matchedPattern: args.matchedPattern } : {}),
    ...(args.registryId ? { registryId: args.registryId } : {}),
    ...(args.hint ? { hint: args.hint } : {}),
  };
}

export function classifyScopePath(
  contract: Pick<
    ScopeContractData,
    'storyId' | 'allowedModify' | 'allowedCreate' | 'allowedTest' | 'protectedFiles' | 'explicitExcludes'
  >,
  path: string,
): ScopePathClassification {
  const normalizedPath = normalizeScopePath(path);

  const lifecycle = classifyLifecycleArtifact(normalizedPath, { storyId: contract.storyId });
  if (lifecycle) {
    return classification({
      path,
      category: 'lifecycle_artifact',
      source: 'lifecycle-registry',
      rule: 'lifecycle_artifact',
      allowed: true,
      detail: `${lifecycle.label}: ${lifecycle.storyDir}/${lifecycle.storyId}/${lifecycle.fileName}`,
      registryId: lifecycle.kind,
      hint: 'Lifecycle classification is provenance only; gate evidence is still checked separately.',
    });
  }

  const runtime = findRuntimeArtifactEntry(normalizedPath);
  if (runtime) {
    return classification({
      path,
      category: 'runtime_artifact',
      source: 'runtime-artifact-registry',
      rule: 'runtime_artifact',
      allowed: true,
      detail: runtime.description,
      registryId: runtime.id,
      hint: 'Runtime artifacts are skipped only when registered; nearby unregistered files fall through to scope enforcement.',
    });
  }

  const protectedPattern = firstMatchedPattern(normalizedPath, contract.protectedFiles);
  if (protectedPattern) {
    return classification({
      path,
      category: 'protected',
      source: 'scope-contract.protectedFiles',
      rule: 'protected',
      allowed: false,
      detail: `Matches protectedFiles pattern ${protectedPattern}.`,
      matchedPattern: protectedPattern,
    });
  }

  const excludedPattern = firstMatchedPattern(normalizedPath, contract.explicitExcludes);
  if (excludedPattern) {
    return classification({
      path,
      category: 'excluded',
      source: 'scope-contract.explicitExcludes',
      rule: 'excluded',
      allowed: false,
      detail: `Matches explicitExcludes pattern ${excludedPattern}.`,
      matchedPattern: excludedPattern,
    });
  }

  const allowedModifyPattern = firstMatchedPattern(normalizedPath, contract.allowedModify);
  if (allowedModifyPattern) {
    return classification({
      path,
      category: 'allowed_modify',
      source: 'scope-contract.allowedModify',
      rule: 'allowed_modify',
      allowed: true,
      detail: `Matches allowedModify pattern ${allowedModifyPattern}.`,
      matchedPattern: allowedModifyPattern,
    });
  }

  const allowedCreatePattern = firstMatchedPattern(normalizedPath, contract.allowedCreate);
  if (allowedCreatePattern) {
    return classification({
      path,
      category: 'allowed_create',
      source: 'scope-contract.allowedCreate',
      rule: 'allowed_create',
      allowed: true,
      detail: `Matches allowedCreate pattern ${allowedCreatePattern}.`,
      matchedPattern: allowedCreatePattern,
    });
  }

  const allowedTestPattern = firstMatchedPattern(normalizedPath, contract.allowedTest);
  if (allowedTestPattern) {
    return classification({
      path,
      category: 'allowed_test',
      source: 'scope-contract.allowedTest',
      rule: 'allowed_test',
      allowed: true,
      detail: `Matches allowedTest pattern ${allowedTestPattern}.`,
      matchedPattern: allowedTestPattern,
    });
  }

  return classification({
    path,
    category: 'unknown',
    source: 'changed-files',
    rule: 'unknown',
    allowed: false,
    detail: 'No lifecycle/runtime registry entry and no scope-contract path pattern matched.',
    hint: 'Unknown paths fail closed when this contract declares an allowed path set.',
  });
}
