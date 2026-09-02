import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { isStateDirPath, PROOF_OR_STOP_STATE_DIR } from './brand-paths.js';
import { resolveProjectGitRoot } from './story-signed-workspace-resolution.js';

// B-cc10: this was hardcoded to the artifact ledger under the retired state
// directory. The ledger file itself moved with CHK-003, so the constant pointed
// at a path that no longer holds it — the same defect class as managed-assets.json
// and the gap-log paths.
export const ARTIFACT_RELEASE_LEDGER_REL_PATH = `${PROOF_OR_STOP_STATE_DIR}/artifact-releases.jsonl`;
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

export class ArtifactReleaseLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactReleaseLedgerError';
  }
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
  // B-cc10 CHK-007: the old prefix check recognized ONLY the retired state
  // directory. After the rename that exclusion silently stopped
  // firing for canonical paths, so state-dir lifecycle metadata could be admitted
  // into an artifact release. This is the F-065/F-061 shape `core/brand-paths.ts`
  // exists to prevent; `isStateDirPath` accepts both spellings by construction.
  if (isStateDirPath(path)) return false;
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function artifactReleaseRecordValidationErrors(value: unknown): string[] {
  if (!isPlainRecord(value)) return ['record must be an object'];
  const errors: string[] = [];
  const requiredStrings = ['id', 'idempotencyKey', 'storyId', 'createdAt', 'mainCommit', 'artifactSetDigest', 'claimBoundary'] as const;
  for (const field of requiredStrings) if (!isNonEmptyString(value[field])) errors.push(`${field} must be a non-empty string`);
  if (value.schemaVersion !== ARTIFACT_RELEASE_SCHEMA_VERSION) errors.push(`schemaVersion must be ${ARTIFACT_RELEASE_SCHEMA_VERSION}`);
  if (isNonEmptyString(value.id) && !/^AR-[a-f0-9]{24}$/u.test(value.id)) errors.push('id must be AR-<24 lowercase hex>');
  if (isNonEmptyString(value.storyId) && !/^B-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(value.storyId)) errors.push('storyId must be a B-* Story id');
  if (isNonEmptyString(value.createdAt) && Number.isNaN(Date.parse(value.createdAt))) errors.push('createdAt must be an ISO-compatible timestamp');
  if (isNonEmptyString(value.mainCommit) && value.mainCommit !== 'uncommitted' && !/^[a-f0-9]{40}$/u.test(value.mainCommit)) errors.push('mainCommit must be a full lowercase Git SHA or uncommitted');
  if (!Number.isInteger(value.changedPathCount) || (value.changedPathCount as number) < 0) errors.push('changedPathCount must be a non-negative integer');
  if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.some(path => !isNonEmptyString(path))) {
    errors.push('paths must be a non-empty array of non-empty strings');
  } else {
    const normalized = uniqueSortedNormalizedPaths(value.paths as string[]);
    if (JSON.stringify(normalized) !== JSON.stringify(value.paths)) errors.push('paths must be normalized, unique, and sorted');
    if (value.changedPathCount !== value.paths.length) errors.push('changedPathCount must equal paths.length');
  }
  if (isNonEmptyString(value.artifactSetDigest) && !/^sha256:[a-f0-9]{64}$/u.test(value.artifactSetDigest)) errors.push('artifactSetDigest must be sha256:<64 lowercase hex>');
  if (typeof value.runtimeSemverChanged !== 'boolean') errors.push('runtimeSemverChanged must be boolean');
  if (!Array.isArray(value.notes) || value.notes.length === 0 || value.notes.some(note => !isNonEmptyString(note))) errors.push('notes must be a non-empty array of non-empty strings');
  if (isNonEmptyString(value.idempotencyKey) && isNonEmptyString(value.storyId) && isNonEmptyString(value.mainCommit) && isNonEmptyString(value.artifactSetDigest)) {
    const expectedKey = `${value.storyId}:${value.mainCommit}:${value.artifactSetDigest}`;
    if (value.idempotencyKey !== expectedKey) errors.push('idempotencyKey does not match storyId/mainCommit/artifactSetDigest');
    if (isNonEmptyString(value.id) && value.id !== `AR-${sha256Hex(expectedKey).slice(0, 24)}`) errors.push('id does not match idempotencyKey');
  }
  return errors;
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
      if (parsed.schemaVersion !== ARTIFACT_RELEASE_SCHEMA_VERSION) continue;
      const errors = artifactReleaseRecordValidationErrors(parsed);
      if (errors.length > 0) throw new ArtifactReleaseLedgerError(`artifact release ledger line ${index + 1}: ${errors.join('; ')}`);
      records.push(parsed);
    } catch (e: any) {
      if (e instanceof ArtifactReleaseLedgerError) throw e;
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
      '.proof-or-stop/story/** lifecycle metadata and watched CLI/runtime build inputs are excluded from artifact release contents.',
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
