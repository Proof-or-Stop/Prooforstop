/**
 * Canonical path classifier for scope-contract checks.
 *
 * This module answers "what kind of path is this?" only. Gate severity still
 * lives in scope-contract.ts so existing pass/warn/fail behavior stays stable.
 */

import { classifyLifecycleArtifact, classifySharedLifecycleMetadata } from './lifecycle-registry.js';
import { findRuntimeArtifactEntry } from './runtime-artifact-registry.js';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { STATE_DIR_NAMES } from './brand-paths.js';
import type {
  ScopeContractData,
  ScopePathCategory,
  ScopePathClassification,
  ScopePathRule,
  ScopePathSource,
} from './types.js';

export const SCOPE_PATH_CANONICALIZER_VERSION = 'repo-relative-v1' as const;

export interface CanonicalScopePathResult {
  originalInput: string;
  canonicalPath: string;
  base: 'repo-root' | 'source-root';
  version: typeof SCOPE_PATH_CANONICALIZER_VERSION;
  rule: 'exact' | 'subtree' | 'glob';
}

function hasWindowsAbsolutePrefix(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\/\/[^/]+\/[^/]+/.test(value);
}

function pathRule(value: string): CanonicalScopePathResult['rule'] {
  if (/[*?[\]{}]/.test(value)) return 'glob';
  return value.endsWith('/') ? 'subtree' : 'exact';
}

function staticPatternPrefix(value: string): string {
  const index = value.search(/[*?[\]{}]/);
  return index < 0 ? value : value.slice(0, index);
}

function nearestExistingPath(path: string): string | null {
  let candidate = path;
  while (candidate && candidate !== dirname(candidate)) {
    if (existsSync(candidate)) return candidate;
    candidate = dirname(candidate);
  }
  return existsSync(candidate) ? candidate : null;
}

function assertContained(root: string, candidate: string, label: string): void {
  const rootReal = realpathSync.native(root);
  const existing = nearestExistingPath(staticPatternPrefix(candidate));
  if (!existing) throw new Error(`scope path ${label} has no resolvable repository ancestor`);
  const real = realpathSync.native(existing);
  if (real !== rootReal && !real.startsWith(`${rootReal}${sep}`)) {
    throw new Error(`scope path ${label} escapes repository through symlink (${real})`);
  }
}

/**
 * Canonicalize one user/checklist scope path to a repo-root-relative identity.
 * The configured source root is `<scanRoot>/<rootDir>`. Existing ancestors
 * decide ambiguous spellings; a path valid below both bases is rejected rather
 * than guessed. Non-existing paths inherit the nearest existing parent.
 */
export function canonicalizeScopePath(args: {
  projectRoot: string;
  scanRoot: string;
  sourceRoot?: string;
  input: string;
  /**
   * Trusted, exact repo-root identities supplied by a caller that has already
   * established removal/rename provenance. This is intentionally not a glob
   * or prefix escape hatch: only an exact normalized path can affect the base.
   */
  exactRepoRootPaths?: readonly string[];
}): CanonicalScopePathResult {
  const originalInput = args.input;
  const blocked = (reason: string, attempted = '(unavailable)', base = 'unresolved'): Error => new Error(
    `${reason}; input=${JSON.stringify(originalInput)} attempted=${attempted} base=${base} `
    + `version=${SCOPE_PATH_CANONICALIZER_VERSION} rule=${pathRule(String(originalInput ?? ''))} status=BLOCKED`,
  );
  const trimmed = String(originalInput ?? '').trim();
  if (!trimmed || trimmed.includes('\0')) throw blocked('invalid empty/null scope path');
  if (isAbsolute(trimmed) || hasWindowsAbsolutePrefix(trimmed)) {
    throw blocked('absolute scope path is forbidden');
  }
  if (/%(?:2e|2f|5c)/i.test(trimmed)) {
    throw blocked('encoded traversal/separator is forbidden');
  }
  const slash = trimmed.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (/[*?[\]{}]/.test(slash) && scopeGlobRegex(slash) === null) {
    throw blocked('malformed glob syntax', slash);
  }
  const segments = slash.split('/');
  const normalizedSegments: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (normalizedSegments.length === 0) {
        throw blocked('scope path traversal is forbidden', normalizedSegments.join('/'));
      }
      normalizedSegments.pop();
      continue;
    }
    normalizedSegments.push(segment);
  }
  const normalized = normalizedSegments.join('/');
  if (!normalized) throw blocked('scope path resolves to repository root', normalized);

  const projectRoot = realpathSync.native(resolve(args.projectRoot));
  const configuredSourceRel = [args.scanRoot, args.sourceRoot ?? args.scanRoot]
    .filter(Boolean)
    .join('/')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
  const sourceRoot = resolve(projectRoot, configuredSourceRel);
  try {
    assertContained(projectRoot, sourceRoot, 'source-root');
  } catch (error) {
    throw blocked((error as Error).message, configuredSourceRel, 'source-root');
  }

  const repoCandidate = resolve(projectRoot, normalized);
  const sourceCandidate = resolve(sourceRoot, normalized);
  try {
    assertContained(projectRoot, repoCandidate, JSON.stringify(originalInput));
    assertContained(projectRoot, sourceCandidate, JSON.stringify(originalInput));
  } catch (error) {
    throw blocked((error as Error).message, normalized);
  }

  const repoAncestor = nearestExistingPath(staticPatternPrefix(repoCandidate));
  const sourceAncestor = nearestExistingPath(staticPatternPrefix(sourceCandidate));
  const repoDirectExists = existsSync(staticPatternPrefix(repoCandidate));
  const sourceDirectExists = existsSync(staticPatternPrefix(sourceCandidate));
  const repoSpecific = repoAncestor && realpathSync.native(repoAncestor) !== projectRoot;
  const sourceRootIdentity = existsSync(sourceRoot) ? realpathSync.native(sourceRoot) : sourceRoot;
  const sourceSpecific = existsSync(sourceRoot)
    && sourceAncestor
    && (realpathSync.native(sourceAncestor) === sourceRootIdentity
      || realpathSync.native(sourceAncestor).startsWith(`${sourceRootIdentity}${sep}`));
  const alreadySourcePrefixed = normalized === configuredSourceRel || normalized.startsWith(`${configuredSourceRel}/`);
  const exactRepoRoot = pathRule(slash) === 'exact'
    && (args.exactRepoRootPaths ?? []).some((candidate) => normalizeScopePath(candidate) === normalized);
  const topLevel = normalized.split('/')[0];
  // B-cc10 CHK-002: the state dir comes from the resolver (every accepted
  // spelling), so a path under the canonical state dir is still classified
  // repo-root after the rename. Hardcoding one spelling would silently
  // reclassify those paths to source-root — a wrong base, not an error.
  const explicitRepoTopLevel = new Set([
    ...STATE_DIR_NAMES,
    '.github', 'docs', 'requirements', 'scripts', 'tests', 'test',
    'specs', 'fixtures', 'packages', 'src',
  ]).has(topLevel);
  let base: CanonicalScopePathResult['base'];
  if (exactRepoRoot || alreadySourcePrefixed || explicitRepoTopLevel) {
    base = 'repo-root';
  } else if (repoDirectExists !== sourceDirectExists) {
    base = repoDirectExists ? 'repo-root' : 'source-root';
  } else if (repoSpecific && sourceSpecific) {
    const repoIdentity = realpathSync.native(repoAncestor!);
    const sourceIdentity = realpathSync.native(sourceAncestor!);
    if (repoIdentity !== sourceIdentity) {
      throw blocked(
        `ambiguous scope path resolves under both repo-root (${relative(projectRoot, repoCandidate)}) `
        + `and source-root (${relative(projectRoot, sourceCandidate)})`,
        normalized,
        'ambiguous',
      );
    }
    base = 'repo-root';
  } else if (repoSpecific) {
    base = 'repo-root';
  } else {
    base = 'source-root';
  }
  const selected = base === 'repo-root' ? repoCandidate : sourceCandidate;
  const selectedExisting = nearestExistingPath(staticPatternPrefix(selected));
  const physicalSelected = selectedExisting
    ? resolve(realpathSync.native(selectedExisting), relative(selectedExisting, selected))
    : selected;
  const canonicalPath = relative(projectRoot, physicalSelected).replace(/\\/g, '/');
  if (!canonicalPath || canonicalPath.startsWith('../') || isAbsolute(canonicalPath)) {
    throw blocked('canonical scope path escaped repository', canonicalPath, base);
  }
  return {
    originalInput,
    canonicalPath,
    base,
    version: SCOPE_PATH_CANONICALIZER_VERSION,
    rule: pathRule(slash),
  };
}

export function normalizeScopePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function globFragment(pattern: string): string | null {
  let out = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        const previous = index === 0 ? '' : pattern[index - 1];
        const following = pattern[index + 2] ?? '';
        if ((previous && previous !== '/') || (following && following !== '/')) return null;
        index++;
        if (pattern[index + 1] === '/') {
          index++;
          out += '(?:[^/]+/)*';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    if (char === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close < 0) return null;
      let body = pattern.slice(index + 1, close);
      if (!body || body.includes('/')) return null;
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      if (body === '^') return null;
      out += `[${body.replace(/\\/g, '\\\\')}]`;
      index = close;
      continue;
    }
    if (char === ']' || char === '}') return null;
    if (char === '{') {
      const close = pattern.indexOf('}', index + 1);
      if (close < 0) return null;
      const alternatives = pattern.slice(index + 1, close).split(',');
      if (alternatives.length < 2 || alternatives.some((entry) => !entry || /[{}]/.test(entry))) return null;
      const rendered = alternatives.map(globFragment);
      if (rendered.some((entry) => entry === null)) return null;
      out += `(?:${rendered.join('|')})`;
      index = close;
      continue;
    }
    if ('\\.^$+()|'.includes(char)) out += `\\${char}`;
    else out += char;
  }
  return out;
}

export function scopeGlobRegex(pattern: string): RegExp | null {
  const normalized = normalizeScopePath(pattern);
  const fragment = globFragment(normalized);
  if (fragment === null) return null;
  try {
    return new RegExp(`^${fragment}$`);
  } catch {
    return null;
  }
}

export function pathMatchesScopePattern(filePath: string, pattern: string): boolean {
  const normalizedFile = normalizeScopePath(filePath);
  const normalizedPattern = normalizeScopePath(pattern);
  if (!normalizedFile || !normalizedPattern) return false;
  if (/[*?[\]{}]/.test(normalizedPattern)) {
    return scopeGlobRegex(normalizedPattern)?.test(normalizedFile) ?? false;
  }
  if (normalizedFile === normalizedPattern) return true;
  if (normalizedFile.startsWith(normalizedPattern.endsWith('/') ? normalizedPattern : `${normalizedPattern}/`)) return true;
  return false;
}

export function isMalformedScopeGlob(pattern: string): boolean {
  const normalized = normalizeScopePath(pattern);
  return /[*?[\]{}]/.test(normalized) && scopeGlobRegex(normalized) === null;
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
  options: { projectRoot?: string; gitCwd?: string } = {},
): ScopePathClassification {
  const normalizedPath = normalizeScopePath(path);
  const malformedProtected = contract.protectedFiles.find(isMalformedScopeGlob);
  if (malformedProtected) {
    return classification({
      path,
      category: 'protected',
      source: 'scope-contract.protectedFiles',
      rule: 'protected',
      allowed: false,
      matchedPattern: malformedProtected,
      detail: `Malformed protectedFiles glob fails closed: ${malformedProtected}.`,
      hint: 'Re-attest the scope contract with valid glob syntax; broad allow rules cannot override a malformed deny rule.',
    });
  }
  const malformedExcluded = contract.explicitExcludes.find(isMalformedScopeGlob);
  if (malformedExcluded) {
    return classification({
      path,
      category: 'excluded',
      source: 'scope-contract.explicitExcludes',
      rule: 'excluded',
      allowed: false,
      matchedPattern: malformedExcluded,
      detail: `Malformed explicitExcludes glob fails closed: ${malformedExcluded}.`,
      hint: 'Re-attest the scope contract with valid glob syntax; broad allow rules cannot override a malformed deny rule.',
    });
  }

  const shared = options.projectRoot
    ? classifySharedLifecycleMetadata(options.projectRoot, normalizedPath, options.gitCwd ?? options.projectRoot)
    : null;
  if (shared?.trusted) {
    return classification({
      path,
      category: 'lifecycle_artifact',
      source: 'lifecycle-registry',
      rule: 'lifecycle_artifact',
      allowed: true,
      detail: `Shared metadata: ${shared.path} | writer: ${shared.writer} | contentBinding: ${shared.contentBinding} | status: PASS`,
      registryId: shared.registryId,
      hint: 'Only an exact signed official gap_log whole-artifact binding admits shared B-META metadata.',
    });
  }
  if (shared) {
    const digestDetail = shared.expectedDigest || shared.observedDigest
      ? ` | expectedDigest=${shared.expectedDigest ?? '(none)'} | observedDigest=${shared.observedDigest ?? '(none)'}`
      : '';
    const receiptDetail = shared.findingId ? ` | receiptFindingId=${shared.findingId}` : '';
    return classification({
      path,
      category: 'unknown',
      source: 'lifecycle-registry',
      rule: 'out_of_scope',
      allowed: false,
      detail: `Untrusted shared metadata: ${shared.path} | class=${shared.registryId} | reason=${shared.reason}${digestDetail}${receiptDetail} | freshness=invalid | status=FAIL`,
      registryId: shared.registryId,
      hint: 'Run an official gap_log repair/re-attestation from an unchanged canonical artifact, or restore the last trusted findings+ledger pair; a lifecycle filename alone cannot admit shared B-META metadata.',
    });
  }

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
