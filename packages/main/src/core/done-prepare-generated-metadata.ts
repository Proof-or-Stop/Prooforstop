import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { isStoryMetadataPath } from './evidence-freshness.js';
import { parseGitPorcelainRow, type DirtyWorktreeParsedRow } from './dirty-worktree.js';

export const DONE_PREPARE_GENERATED_METADATA_SCHEMA = 'lattice.done-prepare-generated-metadata.v1' as const;

export type DonePrepareGeneratedMetadataSafety =
  | 'safe_lifecycle_metadata'
  | 'unsafe_preexisting_dirty'
  | 'unsafe_not_story_lifecycle_metadata'
  | 'unsafe_wrong_story'
  | 'unsafe_unsupported_lifecycle_metadata'
  | 'unsafe_deleted'
  | 'unsafe_rename'
  | 'unsafe_missing_after'
  | 'unsafe_unparsed_status';

export interface DonePrepareGeneratedMetadataBaseline {
  storyMetadataDir: string;
  initialDirtyPaths: string[];
  initialHashes: Record<string, string>;
}

export interface DonePrepareGeneratedMetadataEntry {
  path: string;
  originalPath?: string;
  statusCode: string;
  beforeHash: string | null;
  afterHash: string | null;
  producer: 'done_prepare';
  safety: DonePrepareGeneratedMetadataSafety;
  safeToAutoStage: boolean;
  currentRunGenerated: boolean;
  reason: string;
}

export interface DonePrepareGeneratedMetadataManifest {
  schema: typeof DONE_PREPARE_GENERATED_METADATA_SCHEMA;
  storyId: string;
  storyMetadataDir: string;
  safeFilenames: string[];
  entries: DonePrepareGeneratedMetadataEntry[];
  safePaths: string[];
  unsafePaths: string[];
}

export interface DonePrepareGeneratedMetadataCommitResult {
  ok: boolean;
  commitSha?: string;
  files: string[];
  message: string;
  reason?: string;
  manifest: DonePrepareGeneratedMetadataManifest;
}

const SAFE_GENERATED_METADATA_FILENAMES = new Set([
  'done-required-evidence.json',
  'test-evidence.json',
]);

function normalizeRelPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function canonicalStatusPath(root: string, path: string): string {
  const normalized = normalizeRelPath(path);
  if (existsSync(join(root, normalized))) return normalized;
  if (!normalized.startsWith('.') && existsSync(join(root, `.${normalized}`))) return `.${normalized}`;
  return normalized;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set([...values].map(normalizeRelPath).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function hashFile(root: string, relPath: string): string | null {
  const abs = join(root, relPath);
  if (!existsSync(abs)) return null;
  const stat = statSync(abs);
  if (!stat.isFile()) return null;
  return sha256(readFileSync(abs));
}

function readStoryMetadataHashes(root: string, storyMetadataDir: string): Record<string, string> {
  const base = join(root, storyMetadataDir);
  const hashes: Record<string, string> = {};
  if (!existsSync(base)) return hashes;

  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        visit(abs);
      } else if (stat.isFile()) {
        const rel = normalizeRelPath(relative(root, abs));
        hashes[rel] = sha256(readFileSync(abs));
      }
    }
  };
  visit(base);
  return hashes;
}

function storyMetadataDir(storyDirRel: string, storyId: string): string {
  return normalizeRelPath(`${storyDirRel}/${storyId}`);
}

function parsedPaths(parsed: DirtyWorktreeParsedRow): string[] {
  return [parsed.path, parsed.originalPath].filter((path): path is string => Boolean(path));
}

function isSameStoryPath(storyMetadataDirRel: string, path: string): boolean {
  const normalized = normalizeRelPath(path);
  return normalized === storyMetadataDirRel || normalized.startsWith(`${storyMetadataDirRel}/`);
}

function hasIndexChange(statusCode: string): boolean {
  return statusCode[0] !== ' ' && statusCode[0] !== '?';
}

function classifyEntry(args: {
  root: string;
  storyId: string;
  storyMetadataDirRel: string;
  baseline: DonePrepareGeneratedMetadataBaseline;
  parsed: DirtyWorktreeParsedRow;
}): DonePrepareGeneratedMetadataEntry {
  const path = canonicalStatusPath(args.root, args.parsed.path);
  const originalPath = args.parsed.originalPath ? canonicalStatusPath(args.root, args.parsed.originalPath) : undefined;
  const paths = [path, originalPath].filter((candidate): candidate is string => Boolean(candidate));
  const statusCode = args.parsed.statusCode;
  const beforeHash = args.baseline.initialHashes[path] ?? null;
  const afterHash = hashFile(args.root, path);
  const initiallyDirty = paths.some((candidate) => args.baseline.initialDirtyPaths.includes(normalizeRelPath(candidate)));
  const base = {
    path,
    ...(originalPath ? { originalPath } : {}),
    statusCode,
    beforeHash,
    afterHash,
    producer: 'done_prepare' as const,
  };

  const unsafe = (
    safety: Exclude<DonePrepareGeneratedMetadataSafety, 'safe_lifecycle_metadata'>,
    reason: string,
  ): DonePrepareGeneratedMetadataEntry => ({
    ...base,
    safety,
    safeToAutoStage: false,
    currentRunGenerated: false,
    reason,
  });

  if (paths.length !== 1 || originalPath || statusCode.startsWith('R') || statusCode.startsWith('C')) {
    return unsafe('unsafe_rename', 'renames and copies are not current-run generated metadata');
  }
  if (statusCode.includes('D')) {
    return unsafe('unsafe_deleted', 'deleted files are never safe auto-closeout metadata');
  }
  if (!paths.every((candidate) => isStoryMetadataPath(candidate, args.root))) {
    return unsafe('unsafe_not_story_lifecycle_metadata', 'path is not classified as Proofbound story metadata');
  }
  if (!paths.every((candidate) => isSameStoryPath(args.storyMetadataDirRel, candidate))) {
    return unsafe('unsafe_wrong_story', `path is not under ${args.storyMetadataDirRel}`);
  }
  if (initiallyDirty) {
    return unsafe('unsafe_preexisting_dirty', 'path was dirty before this done_prepare run');
  }
  if (!SAFE_GENERATED_METADATA_FILENAMES.has(basename(path))) {
    return unsafe('unsafe_unsupported_lifecycle_metadata', 'file is lifecycle metadata but not a generated DONE/test evidence file');
  }
  if (!afterHash) {
    return unsafe('unsafe_missing_after', 'safe metadata candidate is missing or not a file after done_prepare');
  }

  return {
    ...base,
    safety: 'safe_lifecycle_metadata',
    safeToAutoStage: true,
    currentRunGenerated: true,
    reason: 'current-run generated DONE/test lifecycle metadata',
  };
}

function git(gitCwd: string, args: string[]): string {
  return childProcess.execFileSync('git', args, {
    cwd: gitCwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function gitMaybe(gitCwd: string, args: string[]): { ok: true; output: string } | { ok: false; error: string } {
  try {
    return { ok: true, output: git(gitCwd, args) };
  } catch (err: any) {
    return { ok: false, error: String(err?.stderr || err?.stdout || err?.message || err).trim() };
  }
}

export function gitStatusRowsForDonePrepareGeneratedMetadata(gitCwd: string): string[] {
  const raw = git(gitCwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  return raw.split('\n').map((line) => line.trimEnd()).filter(Boolean);
}

export function captureDonePrepareGeneratedMetadataBaseline(args: {
  root: string;
  storyDirRel: string;
  storyId: string;
  initialDirtyRows: string[];
}): DonePrepareGeneratedMetadataBaseline {
  const storyMetadataDirRel = storyMetadataDir(args.storyDirRel, args.storyId);
  const initialDirtyPaths = sortedUnique(args.initialDirtyRows.flatMap((row) => {
    const parsed = parseGitPorcelainRow(row);
    return parsed ? parsedPaths(parsed).map((path) => canonicalStatusPath(args.root, path)) : [];
  }));
  return {
    storyMetadataDir: storyMetadataDirRel,
    initialDirtyPaths,
    initialHashes: readStoryMetadataHashes(args.root, storyMetadataDirRel),
  };
}

export function buildDonePrepareGeneratedMetadataManifest(args: {
  root: string;
  storyId: string;
  storyDirRel: string;
  baseline: DonePrepareGeneratedMetadataBaseline;
  statusRows: string[];
}): DonePrepareGeneratedMetadataManifest {
  const storyMetadataDirRel = storyMetadataDir(args.storyDirRel, args.storyId);
  const entries: DonePrepareGeneratedMetadataEntry[] = [];
  for (const row of args.statusRows) {
    const parsed = parseGitPorcelainRow(row);
    if (!parsed) {
      entries.push({
        path: row,
        statusCode: '',
        beforeHash: null,
        afterHash: null,
        producer: 'done_prepare',
        safety: 'unsafe_unparsed_status',
        safeToAutoStage: false,
        currentRunGenerated: false,
        reason: 'git status row could not be parsed',
      });
      continue;
    }
    entries.push(classifyEntry({
      root: args.root,
      storyId: args.storyId,
      storyMetadataDirRel,
      baseline: args.baseline,
      parsed,
    }));
  }
  const safePaths = sortedUnique(entries.filter((entry) => entry.safeToAutoStage).map((entry) => entry.path));
  const unsafePaths = sortedUnique(entries.filter((entry) => !entry.safeToAutoStage).map((entry) => entry.path));
  return {
    schema: DONE_PREPARE_GENERATED_METADATA_SCHEMA,
    storyId: args.storyId,
    storyMetadataDir: storyMetadataDirRel,
    safeFilenames: [...SAFE_GENERATED_METADATA_FILENAMES].sort((a, b) => a.localeCompare(b)),
    entries,
    safePaths,
    unsafePaths,
  };
}

function stagedRows(rows: string[]): string[] {
  return rows.filter((row) => {
    const parsed = parseGitPorcelainRow(row);
    return parsed ? hasIndexChange(parsed.statusCode) : true;
  });
}

function filterIgnoredRows(root: string, rows: string[], ignoredPaths: readonly string[] = []): string[] {
  const ignored = new Set(ignoredPaths.map(normalizeRelPath));
  if (ignored.size === 0) return rows;
  return rows.filter((row) => {
    const parsed = parseGitPorcelainRow(row);
    if (!parsed) return true;
    const paths = parsedPaths(parsed).map((path) => canonicalStatusPath(root, path));
    return paths.length === 0 || !paths.every((path) => ignored.has(path));
  });
}

function hasCachedChanges(gitCwd: string, paths: string[]): boolean {
  try {
    childProcess.execFileSync('git', ['diff', '--cached', '--quiet', '--', ...paths], {
      cwd: gitCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return false;
  } catch (err: any) {
    if (err?.status === 1) return true;
    throw err;
  }
}

function commitMessage(storyId: string): string {
  return `lattice: auto-close ${storyId} generated DONE metadata`;
}

export function commitDonePrepareGeneratedMetadata(args: {
  root: string;
  gitCwd: string;
  storyId: string;
  storyDirRel: string;
  baseline: DonePrepareGeneratedMetadataBaseline;
  ignoredPaths?: readonly string[];
}): DonePrepareGeneratedMetadataCommitResult {
  const rows = filterIgnoredRows(args.root, gitStatusRowsForDonePrepareGeneratedMetadata(args.gitCwd), args.ignoredPaths);
  const manifest = buildDonePrepareGeneratedMetadataManifest({
    root: args.root,
    storyId: args.storyId,
    storyDirRel: args.storyDirRel,
    baseline: args.baseline,
    statusRows: rows,
  });
  const message = commitMessage(args.storyId);

  if (manifest.safePaths.length === 0) {
    return {
      ok: false,
      files: [],
      message,
      reason: 'no current-run generated DONE/test lifecycle metadata is safe to auto-close',
      manifest,
    };
  }
  if (manifest.unsafePaths.length > 0) {
    return {
      ok: false,
      files: manifest.unsafePaths,
      message,
      reason: 'git status contains path(s) outside the safe generated metadata manifest',
      manifest,
    };
  }

  const stagedBefore = stagedRows(rows);
  const stagedOutsideManifest = stagedBefore
    .map((row) => parseGitPorcelainRow(row))
    .filter((row): row is DirtyWorktreeParsedRow => Boolean(row))
    .flatMap(parsedPaths)
    .map((path) => canonicalStatusPath(args.root, path))
    .filter((path) => !manifest.safePaths.includes(path));
  if (stagedOutsideManifest.length > 0) {
    return {
      ok: false,
      files: sortedUnique(stagedOutsideManifest),
      message,
      reason: 'staged changes outside the safe generated metadata manifest are present',
      manifest,
    };
  }

  const ident = gitMaybe(args.gitCwd, ['var', 'GIT_AUTHOR_IDENT']);
  if (!ident.ok) {
    return {
      ok: false,
      files: manifest.safePaths,
      message,
      reason: `git author identity is unavailable: ${ident.error}`,
      manifest,
    };
  }

  childProcess.execFileSync('git', ['add', '--', ...manifest.safePaths], {
    cwd: args.gitCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rowsAfterAdd = gitStatusRowsForDonePrepareGeneratedMetadata(args.gitCwd);
  const stagedAfterAdd = stagedRows(rowsAfterAdd)
    .map((row) => parseGitPorcelainRow(row))
    .filter((row): row is DirtyWorktreeParsedRow => Boolean(row));
  const stagedPaths = sortedUnique(stagedAfterAdd.flatMap(parsedPaths).map((path) => canonicalStatusPath(args.root, path)));
  const stagedUnexpected = stagedPaths.filter((path) => !manifest.safePaths.includes(path));
  if (stagedUnexpected.length > 0) {
    return {
      ok: false,
      files: stagedUnexpected,
      message,
      reason: 'git add would stage paths outside the safe generated metadata manifest',
      manifest,
    };
  }
  if (!hasCachedChanges(args.gitCwd, manifest.safePaths)) {
    return {
      ok: false,
      files: manifest.safePaths,
      message,
      reason: 'safe generated metadata has no staged content to commit',
      manifest,
    };
  }

  const commit = gitMaybe(args.gitCwd, ['commit', '-m', message, '--', ...manifest.safePaths]);
  if (!commit.ok) {
    return {
      ok: false,
      files: manifest.safePaths,
      message,
      reason: `git commit failed: ${commit.error}`,
      manifest,
    };
  }
  const commitSha = git(args.gitCwd, ['rev-parse', 'HEAD']);
  return {
    ok: true,
    commitSha,
    files: manifest.safePaths,
    message,
    manifest,
  };
}
