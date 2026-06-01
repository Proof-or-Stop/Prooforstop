import type { KoalaConfig } from './config.js';
import { isStoryMetadataPath } from './evidence-freshness.js';
import { findRuntimeArtifactEntry } from './runtime-artifact-registry.js';
import type { StoryStore } from './store.js';

// Task B-6326: central ownership classifier for dirty git porcelain rows.
export const DIRTY_WORKTREE_CATEGORIES = [
  'koala_metadata_changes',
  'runtime_artifact_changes',
  'declared_artifact_changes',
  'material_source_changes',
  'fixture_changes',
  'unexpected_dirty_files',
] as const;

export type DirtyWorktreeCategory = typeof DIRTY_WORKTREE_CATEGORIES[number];

export interface DirtyWorktreeParsedRow {
  raw: string;
  statusCode: string;
  rawPath: string;
  path: string;
  originalRawPath?: string;
  originalPath?: string;
}

export interface DirtyWorktreeEntry extends DirtyWorktreeParsedRow {
  category: DirtyWorktreeCategory;
  runtimeArtifactId?: string;
}

export type DirtyDeclaredArtifactMatcher = (path: string, row: DirtyWorktreeParsedRow) => boolean;

export interface DirtyWorktreeClassifierOptions {
  fixtureDirs?: string[];
  materialSourcePrefixes?: string[];
  materialSourceFiles?: string[];
  declaredArtifactPaths?: string[];
  declaredArtifactMatcher?: DirtyDeclaredArtifactMatcher;
  /** When set, passed to isStoryMetadataPath so configured storyDir is honoured. */
  projectRoot?: string;
}

export type DirtyWorktreeGroups = Record<DirtyWorktreeCategory, DirtyWorktreeEntry[]>;

export interface DirtyWorktreeClassification {
  total: number;
  entries: DirtyWorktreeEntry[];
  groups: DirtyWorktreeGroups;
}

function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function joinRelPath(...parts: Array<string | undefined>): string {
  return normalizePath(parts.filter(Boolean).join('/'));
}

function unquoteGitPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.slice(1, -1);
  }
}

function splitRenamePath(path: string): { from: string; to: string } | undefined {
  const arrow = ' -> ';
  const index = path.lastIndexOf(arrow);
  if (index < 0) return undefined;
  return {
    from: path.slice(0, index),
    to: path.slice(index + arrow.length),
  };
}

export function parseGitPorcelainRow(row: string): DirtyWorktreeParsedRow | undefined {
  const raw = row.trimEnd();
  if (!raw) return undefined;

  const statusCode = raw.slice(0, 2).padEnd(2, ' ');
  const rawPathPart = raw.length > 3 ? raw.slice(3) : '';
  const rename = splitRenamePath(rawPathPart);
  if (rename) {
    const originalRawPath = unquoteGitPath(rename.from);
    const rawPath = unquoteGitPath(rename.to);
    return {
      raw,
      statusCode,
      rawPath,
      path: normalizePath(rawPath),
      originalRawPath,
      originalPath: normalizePath(originalRawPath),
    };
  }

  const rawPath = unquoteGitPath(rawPathPart);
  return {
    raw,
    statusCode,
    rawPath,
    path: normalizePath(rawPath),
  };
}

function pathMatchesSpec(path: string, spec: string): boolean {
  const normalized = normalizePath(spec);
  if (!normalized) return false;
  if (normalized.endsWith('/')) return path.startsWith(normalized);
  return path === normalized || path.startsWith(`${normalized}/`);
}

function pathSet(row: DirtyWorktreeParsedRow): string[] {
  return [row.path, row.originalPath].filter((path): path is string => Boolean(path));
}

function isFixturePath(path: string, options: DirtyWorktreeClassifierOptions): boolean {
  return (options.fixtureDirs ?? []).some((dir) => pathMatchesSpec(path, dir));
}

function isDeclaredArtifactPath(row: DirtyWorktreeParsedRow, options: DirtyWorktreeClassifierOptions): boolean {
  for (const path of pathSet(row)) {
    if ((options.declaredArtifactPaths ?? []).some((spec) => pathMatchesSpec(path, spec))) return true;
    if (options.declaredArtifactMatcher?.(path, row)) return true;
  }
  return false;
}

function isMaterialSourcePath(path: string, options: DirtyWorktreeClassifierOptions): boolean {
  if ((options.materialSourceFiles ?? []).some((file) => normalizePath(file) === path)) return true;
  return (options.materialSourcePrefixes ?? []).some((prefix) => pathMatchesSpec(path, prefix));
}

function classifyParsedRow(row: DirtyWorktreeParsedRow, options: DirtyWorktreeClassifierOptions): DirtyWorktreeEntry {
  const paths = pathSet(row);
  if (paths.some((p) => isStoryMetadataPath(p, options.projectRoot))) {
    return { ...row, category: 'koala_metadata_changes' };
  }

  const runtimeArtifact = paths.map((path) => findRuntimeArtifactEntry(path)).find(Boolean);
  if (runtimeArtifact) {
    return { ...row, category: 'runtime_artifact_changes', runtimeArtifactId: runtimeArtifact.id };
  }

  if (paths.some((path) => isFixturePath(path, options))) {
    return { ...row, category: 'fixture_changes' };
  }

  if (paths.some((path) => isMaterialSourcePath(path, options))) {
    return { ...row, category: 'material_source_changes' };
  }

  // B-8db9 CRITICAL hard gate: the declared-artifact check runs AFTER fixture
  // AND material so a declared path can only RESCUE rows that would otherwise
  // fall through to unexpected_dirty_files. It must never reclassify a blocking
  // material_source_changes / fixture_changes row — `koala artifact_declare`
  // (or a hand-injected declared-artifacts.json) of a dirty source/fixture file
  // can no longer downgrade it to non-blocking declared_artifact_changes.
  if (isDeclaredArtifactPath(row, options)) {
    return { ...row, category: 'declared_artifact_changes' };
  }

  return { ...row, category: 'unexpected_dirty_files' };
}

/**
 * B-8db9 CHK-002 — fail-fast entry gate for `artifact_declare`.
 *
 * Classifies a single relative path against the SAME classifier vocabulary
 * used by `classifyParsedRow` (`isStoryMetadataPath` / `isFixturePath` /
 * `isMaterialSourcePath`, with `materialSourceFiles` carrying config files via
 * `dirtyWorktreeClassifierOptionsFromConfig`). Returns the non-declarable
 * category a path belongs to, or `null` when the path is safe to declare as a
 * generated output.
 *
 * The classifier reorder (CHK-001) is the hard gate that catches every path
 * including hand-injected declared-artifacts.json entries; this fn is the
 * fail-fast UX layer so a bad `artifact_declare` is rejected immediately. Both
 * layers share this module's matchers so they cannot disagree (preMortem #3).
 */
export type NonDeclarableCategory =
  | 'koala_metadata_changes'
  | 'runtime_artifact_changes'
  | 'fixture_changes'
  | 'material_source_changes';

export function classifyDeclarablePath(
  rawPath: string,
  options: DirtyWorktreeClassifierOptions,
): NonDeclarableCategory | null {
  const path = normalizePath(rawPath);
  if (isStoryMetadataPath(path, options.projectRoot)) return 'koala_metadata_changes';
  // B-8db9 F-002: a runtime artifact path (.koala/activity.jsonl, .koala-serve.json, …)
  // is already routed to runtime_artifact_changes by `classifyParsedRow`, so declaring
  // it as a product artifact is meaningless — reject it at declare time. Mirrors the
  // `findRuntimeArtifactEntry` check `classifyParsedRow` runs before fixture/material.
  if (findRuntimeArtifactEntry(path)) return 'runtime_artifact_changes';
  if (isFixturePath(path, options)) return 'fixture_changes';
  if (isMaterialSourcePath(path, options)) return 'material_source_changes';
  return null;
}

export function emptyDirtyWorktreeGroups(): DirtyWorktreeGroups {
  return DIRTY_WORKTREE_CATEGORIES.reduce((groups, category) => {
    groups[category] = [];
    return groups;
  }, {} as DirtyWorktreeGroups);
}

export function classifyGitStatusRows(
  rows: string[],
  options: DirtyWorktreeClassifierOptions = {},
): DirtyWorktreeClassification {
  const groups = emptyDirtyWorktreeGroups();
  const entries = rows
    .map(parseGitPorcelainRow)
    .filter((row): row is DirtyWorktreeParsedRow => Boolean(row))
    .map((row) => classifyParsedRow(row, options));

  for (const entry of entries) {
    groups[entry.category].push(entry);
  }

  return {
    total: entries.length,
    entries,
    groups,
  };
}

/**
 * B-cf60: Read per-story declared-artifacts.json and merge its `entries[*].path`
 * into the classifier's `declaredArtifactPaths`. Story-less callers should keep
 * using `dirtyWorktreeClassifierOptionsFromConfig` (returns the baseline empty
 * list — the classifier then never groups anything as declared_artifact_changes).
 *
 * The classifier matches with `pathMatchesSpec` (exact match for non-trailing-slash
 * specs), so the declared path is enforced as an exact relative path; sibling
 * paths like `tests/output/other.json` remain `unexpected_dirty_files`.
 */
export function dirtyWorktreeClassifierOptionsForStory(
  config: KoalaConfig,
  storyId: string,
  store: StoryStore,
  projectRoot?: string,
): DirtyWorktreeClassifierOptions {
  const base = dirtyWorktreeClassifierOptionsFromConfig(config, projectRoot);
  let declared: string[] = [];
  try {
    const data = store.readDeclaredArtifacts(storyId);
    declared = (data.entries || [])
      .map((e) => (typeof e?.path === 'string' ? e.path.trim() : ''))
      .filter((p) => p.length > 0);
  } catch {
    // PROBE: declared-artifacts.json missing or unreadable → fall back to base.
    declared = [];
  }
  return {
    ...base,
    declaredArtifactPaths: [
      ...(base.declaredArtifactPaths ?? []),
      ...declared,
    ],
  };
}

export function dirtyWorktreeClassifierOptionsFromConfig(config: KoalaConfig, projectRoot?: string): DirtyWorktreeClassifierOptions {
  const sourceRoot = joinRelPath(config.scanRoot, config.rootDir || undefined);
  const packageRoot = normalizePath(config.scanRoot);
  const configFiles = [
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
    '.gitignore',
    'koala.config.json',
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    'tsconfig.json',
    joinRelPath(packageRoot, 'package.json'),
    joinRelPath(packageRoot, 'package-lock.json'),
    joinRelPath(packageRoot, 'tsconfig.json'),
  ];

  return {
    fixtureDirs: [config.fixturesDir],
    materialSourcePrefixes: [
      sourceRoot,
      config.requirementsDir,
    ].filter(Boolean),
    materialSourceFiles: Array.from(new Set(configFiles.map(normalizePath).filter(Boolean))),
    declaredArtifactPaths: [],
    projectRoot,
  };
}

export function summarizeDirtyWorktreeClassification(classification: DirtyWorktreeClassification): string {
  const counts = DIRTY_WORKTREE_CATEGORIES
    .map((category) => ({ category, count: classification.groups[category].length }))
    .filter(({ count }) => count > 0)
    .map(({ category, count }) => `${category}=${count}`)
    .join(', ');
  return `${classification.total} dirty path(s) by category: ${counts || 'none'}`;
}

export function renderDirtyWorktreeGroups(
  classification: DirtyWorktreeClassification,
  options: { sampleLimit?: number; indent?: string } = {},
): string[] {
  const sampleLimit = options.sampleLimit ?? 4;
  const indent = options.indent ?? '';
  const lines: string[] = [];

  for (const category of DIRTY_WORKTREE_CATEGORIES) {
    const entries = classification.groups[category];
    if (entries.length === 0) continue;
    lines.push(`${indent}${category} (${entries.length}):`);
    for (const entry of entries.slice(0, sampleLimit)) {
      lines.push(`${indent}  ${entry.raw}`);
    }
    if (entries.length > sampleLimit) {
      lines.push(`${indent}  ... ${entries.length - sampleLimit} more`);
    }
  }

  return lines;
}
