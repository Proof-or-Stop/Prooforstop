import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { resolveProjectGitRoot } from './story-signed-workspace-resolution.js';

export const ARTIFACT_RELEASE_LEDGER_REL_PATH = '.lattice/artifact-releases.jsonl';
export const ARTIFACT_RELEASE_SCHEMA_VERSION = 'proofbound.artifact-release.v1';

export interface ArtifactReleaseRecordV1 {
  schemaVersion: typeof ARTIFACT_RELEASE_SCHEMA_VERSION;
  id: string;
  idempotencyKey: string;
  storyId: string;
  createdAt: string;
  mainCommit: string;
  changedPathCount: number;
  paths: string[];
  artifactSetDigest: string;
  runtimeSemverChanged: boolean;
  claimBoundary: string;
  notes: string[];
}

export interface ArtifactReleaseRecordOptions {
  /** Metadata/filesystem root for ledger paths and non-git fallback reads. */
  root: string;
  /** Already-resolved cwd for git object probes; defaults to root for plain repos. */
  gitCwd?: string;
  storyId: string;
  mainCommit?: string;
  changedPaths: string[];
  runtimeSemverChanged: boolean;
  isRuntimeBuildInput?: (path: string) => boolean;
  now?: string;
}

export interface RecordArtifactReleaseResult {
  status: 'recorded' | 'already_recorded' | 'skipped_empty';
  record?: ArtifactReleaseRecordV1;
}

export function normalizeArtifactReleasePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/').trim();
}

function uniqueSortedNormalizedPaths(paths: string[]): string[] {
  return [...new Set(paths.map(normalizeArtifactReleasePath).filter(Boolean))].sort();
}

function isRootManifestOrLock(path: string): boolean {
  return [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'npm-shrinkwrap.json',
  ].includes(path);
}

export function isArtifactReleasePathV1(
  rawPath: string,
  opts: { isRuntimeBuildInput?: (path: string) => boolean } = {},
): boolean {
  const path = normalizeArtifactReleasePath(rawPath);
  if (!path) return false;
  if (path.startsWith('.lattice/')) return false;
  if (path.startsWith('docs/story/')) return false;
  if (path.startsWith('packages/main/src/')) return false;
  if (path === 'packages/main/package.json' || path === 'packages/main/package-lock.json' || path === 'packages/main/tsconfig.json') return false;
  if (isRootManifestOrLock(path)) return false;
  if (opts.isRuntimeBuildInput?.(path)) return false;
  return path.startsWith('docs/') || path.startsWith('experiments/');
}

export function selectArtifactReleasePathsV1(
  changedPaths: string[],
  opts: { isRuntimeBuildInput?: (path: string) => boolean } = {},
): string[] {
  return uniqueSortedNormalizedPaths(changedPaths).filter(path => isArtifactReleasePathV1(path, opts));
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function gitObjectMaterial(root: string, gitCwd: string, commit: string, path: string): string {
  try {
    const blob = execFileSync('git', ['rev-parse', `${commit}:${path}`], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (blob) return `git-blob:${blob}`;
  } catch {
    // PROBE: deleted paths or non-git fixtures fall through to deterministic markers below.
  }
  try {
    execFileSync('git', ['cat-file', '-e', commit], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 'git-missing';
  } catch {
    return filesystemMaterial(root, path);
  }
}

function filesystemMaterial(root: string, path: string): string {
  const abs = join(root, path);
  if (!existsSync(abs)) return 'fs-missing';
  return `fs-sha256:${sha256Hex(readFileSync(abs))}`;
}

export function computeArtifactSetDigest(
  root: string,
  paths: string[],
  mainCommit?: string,
  gitCwd = root,
): string {
  const normalized = uniqueSortedNormalizedPaths(paths);
  const entries = normalized.map(path => ({
    path,
    material: mainCommit ? gitObjectMaterial(root, gitCwd, mainCommit, path) : filesystemMaterial(root, path),
  }));
  return `sha256:${sha256Hex(JSON.stringify(entries))}`;
}

export function artifactReleaseLedgerPath(root: string): string {
  return join(root, ARTIFACT_RELEASE_LEDGER_REL_PATH);
}

export function resolveArtifactReleaseLedgerRoot(metadataRoot: string): string {
  const root = resolve(metadataRoot);
  const config = loadConfig(root);
  return resolveProjectGitRoot(root, config.gitRoot) ?? root;
}

export function readArtifactReleaseLedger(root: string): ArtifactReleaseRecordV1[] {
  const file = artifactReleaseLedgerPath(root);
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf-8');
  const records: ArtifactReleaseRecordV1[] = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as ArtifactReleaseRecordV1;
      if (parsed.schemaVersion === ARTIFACT_RELEASE_SCHEMA_VERSION) records.push(parsed);
    } catch (e: any) {
      throw new Error(`artifact release ledger parse failed at line ${index + 1}: ${e?.message ?? e}`);
    }
  }
  return records;
}

export function buildArtifactReleaseRecord(opts: ArtifactReleaseRecordOptions): ArtifactReleaseRecordV1 | null {
  const paths = selectArtifactReleasePathsV1(opts.changedPaths, { isRuntimeBuildInput: opts.isRuntimeBuildInput });
  if (paths.length === 0) return null;
  const mainCommit = opts.mainCommit?.trim() || 'uncommitted';
  const artifactSetDigest = computeArtifactSetDigest(
    opts.root,
    paths,
    opts.mainCommit?.trim() || undefined,
    opts.gitCwd ?? opts.root,
  );
  const idempotencyKey = `${opts.storyId}:${mainCommit}:${artifactSetDigest}`;
  const idHash = sha256Hex(idempotencyKey).slice(0, 24);
  return {
    schemaVersion: ARTIFACT_RELEASE_SCHEMA_VERSION,
    id: `AR-${idHash}`,
    idempotencyKey,
    storyId: opts.storyId,
    createdAt: opts.now ?? new Date().toISOString(),
    mainCommit,
    changedPathCount: paths.length,
    paths,
    artifactSetDigest,
    runtimeSemverChanged: opts.runtimeSemverChanged,
    claimBoundary: 'provenance-only: records non-runtime artifact contents; does not activate a package release or broaden CLI semver rules',
    notes: [
      'Artifact release records are provenance for docs/** and experiments/** DONE merge contents only.',
      '.lattice/story/** lifecycle metadata and watched CLI/runtime build inputs are excluded from artifact release contents.',
      'CLI patch version remains a runtime/capability marker, not a non-runtime artifact release ledger.',
    ],
  };
}

export function appendArtifactReleaseRecord(root: string, record: ArtifactReleaseRecordV1): RecordArtifactReleaseResult {
  const existing = readArtifactReleaseLedger(root);
  const previous = existing.find(row => row.idempotencyKey === record.idempotencyKey);
  if (previous) return { status: 'already_recorded', record: previous };

  const file = artifactReleaseLedgerPath(root);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf-8');
  return { status: 'recorded', record };
}

export function recordArtifactReleaseForDoneMerge(opts: ArtifactReleaseRecordOptions): RecordArtifactReleaseResult {
  const record = buildArtifactReleaseRecord(opts);
  if (!record) return { status: 'skipped_empty' };
  return appendArtifactReleaseRecord(opts.root, record);
}

export function writeArtifactReleaseLedgerForTest(root: string, records: ArtifactReleaseRecordV1[]): void {
  const file = artifactReleaseLedgerPath(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf-8');
}

export function createArtifactReleaseRecordForTest(
  opts: Omit<ArtifactReleaseRecordOptions, 'now'> & { now?: string },
): ArtifactReleaseRecordV1 {
  const record = buildArtifactReleaseRecord(opts);
  if (!record) throw new Error('test fixture produced no artifact release record');
  return record;
}
