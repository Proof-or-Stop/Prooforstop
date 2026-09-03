import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { isStoryMetadataPath } from './evidence-freshness.js';
import { parseGitPorcelainRow, type DirtyWorktreeParsedRow } from './dirty-worktree.js';
import { classifySharedLifecycleMetadata } from './lifecycle-registry.js';
import { DONE_PREPARE_GENERATED_METADATA_SCHEMA } from './artifact-schema.js';

export { DONE_PREPARE_GENERATED_METADATA_SCHEMA };

/**
 * Explicit output ceiling for every `git` read this module performs.
 *
 * Node applies a 1,048,576-byte `maxBuffer` default to `execFileSync`, and a read above it throws
 * ENOBUFS rather than returning truncated content. The managed metadata this module commits is not
 * bounded by that number: `test-evidence.json` serialises one entry per configured validate command,
 * so it grows with the command count, and it measured 1,369,692 bytes on story B-9ff1. Under the
 * default every such read failed, and the failure surfaced as a digest comparison against a null,
 * i.e. as "verified metadata changed after manifest verification".
 *
 * 32 MiB is 32x the Node default, far above any observed artifact, and cheap: Node grows the pipe
 * buffer on demand, so a high ceiling costs nothing until content actually arrives. The evidence
 * writer in core/validation-executor.ts derives its warning and bounding thresholds from THIS
 * constant so the two cannot drift apart.
 *
 * What this ceiling does NOT promise: that every managed file stays under it. Only
 * `test-evidence.json` has an aggregate bound. `process-events.jsonl` is append-only and never
 * truncated, and `done-required-evidence.json` is written by other paths entirely, so either can
 * reach the ceiling in time. That is why a read above the ceiling must fail DIAGNOSTICALLY - see
 * describeContentReadFailure, which names the ceiling and the measured capture and never returns
 * content - rather than being assumed unreachable.
 */
export const METADATA_BLOB_READ_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** Why a blob read did not produce a digest. Absent and unreadable are deliberately distinct. */
export type MetadataBlobReadFailureKind = 'absent' | 'unreadable';

/**
 * The outcome of reading one managed blob. A failed read is a tagged object, never a bare string
 * or null, so it is structurally incapable of comparing equal to an expected sha256 digest.
 */
export type MetadataBlobRead =
  | { ok: true; hash: string }
  | { ok: false; kind: MetadataBlobReadFailureKind; error: string };

export type DonePrepareGeneratedMetadataSafety =
  | 'safe_lifecycle_metadata'
  | 'unsafe_preexisting_dirty'
  | 'unsafe_untrusted_process_events_delta'
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
  initialContents: Record<string, string>;
}

export interface DonePrepareGeneratedProcessEventBinding {
  storyId: string;
  attemptId: string;
  reviewRound: string;
  commandSetHash: string;
  materialHash: string;
  storyFilesHash: string;
  phase: 'TEST';
  disposition: 'reused';
  result: 'pass';
  commandExecutions: 0;
  notBefore: string;
  notAfter: string;
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

export interface DonePrepareGeneratedMetadataIndexEntry {
  mode: string;
  object: string;
  stage: string;
  path: string;
}

export interface DonePrepareGeneratedMetadataPathState {
  path: string;
  worktreeContent: Buffer | null;
  indexEntries: DonePrepareGeneratedMetadataIndexEntry[];
}

export interface DonePrepareGeneratedMetadataTransaction {
  paths: string[];
  states: DonePrepareGeneratedMetadataPathState[];
}

export interface DonePrepareGeneratedMetadataRollbackResult {
  ok: boolean;
  files: string[];
  errors: string[];
}

const SAFE_GENERATED_METADATA_FILENAMES = new Set([
  'done-required-evidence.json',
  'process-events.jsonl',
  'test-evidence.json',
]);

const VALIDATION_TERMINAL_KEYS = new Set([
  'attemptId',
  'commandExecutions',
  'commandSetHash',
  'disposition',
  'materialHash',
  'phase',
  'result',
  'reviewRound',
  'storyFilesHash',
  'storyId',
  'timestamp',
  'type',
]);

function isSha256(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isTrustedReusedValidationTerminal(
  value: unknown,
  expected: DonePrepareGeneratedProcessEventBinding,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (Object.keys(event).some((key) => !VALIDATION_TERMINAL_KEYS.has(key))) return false;
  const timestamp = typeof event.timestamp === 'string' ? event.timestamp : '';
  const timestampMs = Date.parse(timestamp);
  return event.type === 'validation_terminal'
    && event.storyId === expected.storyId
    && event.attemptId === expected.attemptId
    && event.reviewRound === expected.reviewRound
    && event.commandSetHash === expected.commandSetHash
    && event.materialHash === expected.materialHash
    && event.storyFilesHash === expected.storyFilesHash
    && event.phase === expected.phase
    && event.disposition === expected.disposition
    && event.commandExecutions === expected.commandExecutions
    && event.result === expected.result
    && isSha256(event.commandSetHash)
    && isSha256(event.materialHash)
    && isSha256(event.storyFilesHash)
    && Number.isFinite(timestampMs)
    && timestampMs >= Date.parse(expected.notBefore)
    && timestampMs <= Date.parse(expected.notAfter);
}

function isTrustedProcessEventsAppend(args: {
  before: string | undefined;
  after: string;
  expected: DonePrepareGeneratedProcessEventBinding | undefined;
}): boolean {
  const expected = args.expected;
  if (!expected) return false;
  const before = args.before ?? '';
  if (!args.after.startsWith(before)) return false;
  if (before.length > 0 && !before.endsWith('\n')) return false;
  const appended = args.after.slice(before.length);
  if (!appended || !appended.endsWith('\n')) return false;
  const lines = appended.split('\n').filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((line) => {
    try {
      return isTrustedReusedValidationTerminal(JSON.parse(line), expected);
    } catch {
      return false;
    }
  });
}

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

function readStoryMetadataContents(root: string, storyMetadataDir: string): Record<string, string> {
  const relPath = normalizeRelPath(`${storyMetadataDir}/process-events.jsonl`);
  const absPath = join(root, relPath);
  return existsSync(absPath) && statSync(absPath).isFile()
    ? { [relPath]: readFileSync(absPath, 'utf8') }
    : {};
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
  expectedProcessEventBinding?: DonePrepareGeneratedProcessEventBinding;
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
    return unsafe('unsafe_not_story_lifecycle_metadata', 'path is not classified as Proof-or-Stop story metadata');
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
  if (basename(path) === 'process-events.jsonl') {
    const after = readFileSync(join(args.root, path), 'utf8');
    if (!isTrustedProcessEventsAppend({
      before: args.baseline.initialContents[path],
      after,
      expected: args.expectedProcessEventBinding,
    })) {
      return unsafe(
        'unsafe_untrusted_process_events_delta',
        'process-events delta is not an append-only exact match for this done_prepare invocation reused validation_terminal binding',
      );
    }
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
    maxBuffer: METADATA_BLOB_READ_MAX_BUFFER_BYTES,
  }).trim();
}

function gitMaybe(gitCwd: string, args: string[]): { ok: true; output: string } | { ok: false; error: string } {
  try {
    return { ok: true, output: git(gitCwd, args) };
  } catch (err: any) {
    return { ok: false, error: describeContentReadFailure(err) };
  }
}

function gitRaw(gitCwd: string, args: string[]): string {
  return childProcess.execFileSync('git', args, {
    cwd: gitCwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: METADATA_BLOB_READ_MAX_BUFFER_BYTES,
  });
}

export function gitStatusRowsForDonePrepareGeneratedMetadata(gitCwd: string): string[] {
  // gitRaw, not git(): a full-output trim() strips the first porcelain row's
  // leading status space (" M path" -> "M path"), shifting the fixed-width
  // path offset and corrupting the first reported path (".proof-or-stop/x" -> "proofOrStop/x").
  const raw = gitRaw(gitCwd, ['status', '--porcelain=v1', '--untracked-files=all']);
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
    initialContents: readStoryMetadataContents(args.root, storyMetadataDirRel),
  };
}

function parseLsFilesStageRecord(record: string): DonePrepareGeneratedMetadataIndexEntry | null {
  const tab = record.indexOf('\t');
  if (tab < 0) return null;
  const metadata = record.slice(0, tab).split(' ');
  if (metadata.length !== 3) return null;
  const [mode, object, stage] = metadata;
  const path = record.slice(tab + 1);
  if (!mode || !object || !stage || !path) return null;
  return { mode, object, stage, path: normalizeRelPath(path) };
}

function indexEntriesForPaths(gitCwd: string, paths: string[]): DonePrepareGeneratedMetadataIndexEntry[] {
  if (paths.length === 0) return [];
  const raw = gitRaw(gitCwd, ['ls-files', '--stage', '-z', '--', ...paths]);
  return raw
    .split('\0')
    .filter(Boolean)
    .map(parseLsFilesStageRecord)
    .filter((entry): entry is DonePrepareGeneratedMetadataIndexEntry => Boolean(entry));
}

function restoreIndexEntries(gitCwd: string, path: string, entries: DonePrepareGeneratedMetadataIndexEntry[]): void {
  childProcess.execFileSync('git', ['update-index', '--force-remove', '--', path], {
    cwd: gitCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: METADATA_BLOB_READ_MAX_BUFFER_BYTES,
  });
  if (entries.length === 0) return;
  const input = entries
    .map((entry) => `${entry.mode} ${entry.object} ${entry.stage}\t${entry.path}`)
    .join('\n') + '\n';
  childProcess.execFileSync('git', ['update-index', '--index-info'], {
    cwd: gitCwd,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: METADATA_BLOB_READ_MAX_BUFFER_BYTES,
  });
}

function restoreWorktreeContent(root: string, path: string, content: Buffer | null): void {
  const abs = join(root, path);
  if (content === null) {
    if (existsSync(abs)) unlinkSync(abs);
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

export function captureDonePrepareGeneratedMetadataTransaction(args: {
  root: string;
  gitCwd: string;
  paths: string[];
}): DonePrepareGeneratedMetadataTransaction {
  const paths = sortedUnique(args.paths);
  const indexEntries = indexEntriesForPaths(args.gitCwd, paths);
  const states = paths.map((path) => {
    const abs = join(args.root, path);
    return {
      path,
      worktreeContent: existsSync(abs) ? readFileSync(abs) : null,
      indexEntries: indexEntries.filter((entry) => entry.path === path),
    };
  });
  return { paths, states };
}

export function rollbackDonePrepareGeneratedMetadataTransaction(args: {
  root: string;
  gitCwd: string;
  transaction: DonePrepareGeneratedMetadataTransaction;
}): DonePrepareGeneratedMetadataRollbackResult {
  const errors: string[] = [];
  for (const state of args.transaction.states) {
    try {
      restoreIndexEntries(args.gitCwd, state.path, state.indexEntries);
      restoreWorktreeContent(args.root, state.path, state.worktreeContent);
    } catch (err: any) {
      errors.push(`${state.path}: ${describeDiagnosticStreamFailure(err)}`);
    }
  }
  return {
    ok: errors.length === 0,
    files: args.transaction.paths,
    errors,
  };
}

export function buildDonePrepareGeneratedMetadataManifest(args: {
  root: string;
  storyId: string;
  storyDirRel: string;
  baseline: DonePrepareGeneratedMetadataBaseline;
  statusRows: string[];
  expectedProcessEventBinding?: DonePrepareGeneratedProcessEventBinding;
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
    const parsedEntryPaths = parsedPaths(parsed).map((path) => canonicalStatusPath(args.root, path));
    const indexOnly = hasIndexChange(parsed.statusCode) && parsed.statusCode[1] === ' ';
    if (
      indexOnly
      && parsedEntryPaths.length > 0
      && parsedEntryPaths.every((path) => !isSameStoryPath(storyMetadataDirRel, path))
    ) {
      // The isolated closeout index never consumes unrelated real-index state.
      // Preserve an index-only user change verbatim instead of treating it as
      // part of the generated-metadata transaction.
      continue;
    }
    entries.push(classifyEntry({
      root: args.root,
      storyId: args.storyId,
      storyMetadataDirRel,
      baseline: args.baseline,
      parsed,
      expectedProcessEventBinding: args.expectedProcessEventBinding,
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

export function filterDonePrepareTrustedMetadataRows(
  root: string,
  rows: string[],
  ignoredPaths: readonly string[] = [],
  gitCwd = root,
): string[] {
  const ignored = new Set(ignoredPaths.map(normalizeRelPath));
  return rows.filter((row) => {
    const parsed = parseGitPorcelainRow(row);
    if (!parsed) return true;
    const paths = parsedPaths(parsed).map((path) => canonicalStatusPath(root, path));
    if (paths.length === 0) return true;
    if (paths.every((path) => ignored.has(path))) return false;
    // Shared B-META is not path-whitelisted: only the exact current content
    // with a valid official gap_log binding is non-blocking.
    if (paths.every((path) => classifySharedLifecycleMetadata(root, path, gitCwd)?.trusted === true)) return false;
    return true;
  });
}

function isolatedGit(gitCwd: string, indexFile: string, args: string[]): string {
  return childProcess.execFileSync('git', args, {
    cwd: gitCwd,
    env: { ...process.env, GIT_INDEX_FILE: indexFile },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: METADATA_BLOB_READ_MAX_BUFFER_BYTES,
  });
}

function isolatedChangedPaths(gitCwd: string, indexFile: string, parent: string): string[] {
  const raw = isolatedGit(gitCwd, indexFile, ['diff', '--cached', '--name-only', '-z', parent]);
  return sortedUnique(raw.split('\0').filter(Boolean));
}

/**
 * Hard cap on any rendered diagnostic.
 *
 * A failure description travels: blob read failure to commitImmutableMetadataTree reason to
 * commitDonePrepareGeneratedMetadata reason to the done_prepare step/blocked text the CLI prints.
 * Nothing along that path bounds it, so an unbounded description is an unbounded artifact blocking
 * a phase transition - the exact shape of the defect this module was repaired for. The cap makes
 * the bound a property of the renderer rather than an assumption about the source.
 */
const MAX_DIAGNOSTIC_CHARS = 2000;

function capDiagnostic(text: string): string {
  if (text.length <= MAX_DIAGNOSTIC_CHARS) return text;
  return `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}...[diagnostic truncated ${text.length - MAX_DIAGNOSTIC_CHARS} chars]`;
}

function streamText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function streamByteLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (Buffer.isBuffer(value)) return value.length;
  return Buffer.byteLength(String(value), 'utf8');
}

function failureCode(err: any): string {
  if (typeof err?.code === 'string' && err.code) return err.code;
  return Number.isInteger(err?.status) ? `exit ${err.status}` : '';
}

/** Node raises ENOBUFS when a captured stream passes maxBuffer, and keeps the partial capture. */
function isBufferCeilingFailure(err: any): boolean {
  return err?.code === 'ENOBUFS' || /maxBuffer/i.test(String(err?.message ?? ''));
}

function bufferCeilingDiagnostic(err: any): string {
  const partial = Math.max(streamByteLength(err?.stdout), streamByteLength(err?.stderr));
  return `ENOBUFS: output exceeded the ${METADATA_BLOB_READ_MAX_BUFFER_BYTES}-byte read ceiling`
    + (partial > 0 ? `; ${partial} bytes were captured before the ceiling and discarded` : '');
}

/**
 * Describe a failure of a command whose STDOUT IS CONTENT, not diagnostics - anything of the
 * `git show` / `git rev-parse` / `git diff --cached` family.
 *
 * Why this is a separate helper rather than one describer used everywhere: for such a command the
 * partial stdout captured before a buffer failure is a slice of the blob, so treating stdout as a
 * fallback diagnostic hands the reader tens of millions of characters of file content in place of
 * an explanation. The stream that carries the explanation here is stderr, and above the ceiling
 * there is no explanation to carry - Node failed before git wrote one - so the diagnostic has to be
 * synthesised from the ceiling and the measured capture instead.
 */
function describeContentReadFailure(err: any): string {
  if (isBufferCeilingFailure(err)) return bufferCeilingDiagnostic(err);
  const detail = streamText(err?.stderr) || String(err?.message ?? err ?? '').trim() || 'no diagnostic output';
  const code = failureCode(err);
  return capDiagnostic(code ? `${code}: ${detail}` : detail);
}

/**
 * Describe a failure of a command whose stdout is genuinely diagnostic - a commit hook, which
 * commonly prints its reason to stdout, or index plumbing that emits no content at all.
 *
 * The ENOBUFS branch still runs first: a buffer failure never renders a partial stream, whichever
 * stream it came from.
 *
 * Unlike describeContentReadFailure this does not prefix a plain exit status ONTO TEXT THE PROCESS
 * PRINTED. A hook that wrote a message has already explained itself, so `exit 1: ` in front of it
 * adds noise, and the operator-facing wording of these reasons is depended on elsewhere.
 *
 * But that reasoning holds only while there IS printed text. A hook can exit non-zero having
 * written nothing to either stream - `#!/bin/sh` and `exit 7` is enough - and for that shape Node
 * puts the status in `err.status` and nowhere else: `message` is only "Command failed: <path>".
 * With no streams the status is the sole surviving cause, so it must appear. Silence is a case, not
 * an impossibility, which is what the earlier wording of this comment assumed.
 */
function describeDiagnosticStreamFailure(err: any): string {
  if (isBufferCeilingFailure(err)) return bufferCeilingDiagnostic(err);
  const nodeLevelCode = typeof err?.code === 'string' && err.code ? err.code : '';
  const streamDetail = streamText(err?.stderr) || streamText(err?.stdout);
  if (streamDetail) {
    return capDiagnostic(nodeLevelCode ? `${nodeLevelCode}: ${streamDetail}` : streamDetail);
  }
  const detail = String(err?.message ?? err ?? '').trim() || 'no diagnostic output';
  const code = nodeLevelCode || failureCode(err);
  return capDiagnostic(code ? `${code}: ${detail}` : detail);
}

/**
 * Absent means git ran and reported that the path is not in the index or tree. Everything else -
 * a buffer ceiling, a permission error, a corrupt object store, a missing git binary - is an
 * infrastructure failure and must never be mistaken for a missing blob.
 */
function classifyMetadataBlobReadFailure(err: any): { kind: MetadataBlobReadFailureKind; error: string } {
  const error = describeContentReadFailure(err);
  const nodeLevelFailure = typeof err?.code === 'string' && err.code.length > 0;
  const absent = !nodeLevelFailure
    && (/fatal:\s+path\s+.+\s+does not exist/i.test(error)
      || /fatal:\s+path\s+.+\s+exists on disk, but not in/i.test(error));
  return { kind: absent ? 'absent' : 'unreadable', error };
}

/**
 * Read a staged blob out of an isolated index and digest it.
 *
 * Named for grep continuity with the incident that produced it. It returns a tagged read rather
 * than `string | null`: the previous bare `catch { return null }` turned every infrastructure
 * failure into a value the caller compared against an expected digest, so an unreadable blob was
 * reported as "verified metadata changed after manifest verification".
 */
export function isolatedBlobHash(gitCwd: string, indexFile: string, path: string): MetadataBlobRead {
  try {
    const content = childProcess.execFileSync('git', ['show', `:${path}`], {
      cwd: gitCwd,
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: METADATA_BLOB_READ_MAX_BUFFER_BYTES,
    });
    return { ok: true, hash: sha256(content) };
  } catch (err: any) {
    return { ok: false, ...classifyMetadataBlobReadFailure(err) };
  }
}

function treeChangedPaths(gitCwd: string, parentTree: string, tree: string): string[] {
  const raw = gitRaw(gitCwd, ['diff-tree', '-r', '--name-only', '-z', parentTree, tree]);
  return sortedUnique(raw.split('\0').filter(Boolean));
}

/** Tree-side counterpart of isolatedBlobHash, with the identical ceiling and failure taxonomy. */
export function treeBlobHash(gitCwd: string, tree: string, path: string): MetadataBlobRead {
  try {
    const content = childProcess.execFileSync('git', ['show', `${tree}:${path}`], {
      cwd: gitCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: METADATA_BLOB_READ_MAX_BUFFER_BYTES,
    });
    return { ok: true, hash: sha256(content) };
  } catch (err: any) {
    return { ok: false, ...classifyMetadataBlobReadFailure(err) };
  }
}

/**
 * The only sanctioned way to compare a blob read against a verified digest.
 *
 * Fail-closed by construction: a failed read never reaches the equality test, so no read failure
 * can be reported as a match regardless of what the caller expected - including an undefined
 * expectation, which the previous `null !== undefined` comparison silently classified as a change.
 */
export function classifyMetadataBlobDigestComparison(
  read: MetadataBlobRead,
  expected: string | undefined,
): 'match' | 'changed' | 'absent' | 'unreadable' {
  if (!read.ok) return read.kind;
  return typeof expected === 'string' && read.hash === expected ? 'match' : 'changed';
}

interface MetadataBlobVerification {
  changed: string[];
  failed: string[];
  reason?: string;
}

/**
 * Partition one set of blob reads into genuine digest changes and read failures, and render the
 * read failures as a message that names the underlying cause. The two failure classes get
 * textually distinct sentences, and both are distinct from the digest-change message, because
 * conflating them is the defect that cost hours of misattribution on story B-9ff1.
 */
function verifyMetadataBlobDigests(
  source: string,
  reads: Array<{ path: string; read: MetadataBlobRead }>,
  verifiedHashes: Map<string, string>,
): MetadataBlobVerification {
  const changed: string[] = [];
  const unreadable: Array<{ path: string; error: string }> = [];
  const absent: Array<{ path: string; error: string }> = [];
  for (const entry of reads) {
    const classification = classifyMetadataBlobDigestComparison(entry.read, verifiedHashes.get(entry.path));
    if (classification === 'match') continue;
    if (classification === 'changed') { changed.push(entry.path); continue; }
    const error = entry.read.ok ? '' : entry.read.error;
    (classification === 'absent' ? absent : unreadable).push({ path: entry.path, error });
  }
  const sentences: string[] = [];
  if (unreadable.length > 0) {
    sentences.push(
      `verified metadata could not be read from the ${source}: `
      + unreadable.map((entry) => `${entry.path}: ${entry.error}`).join('; ')
      + ` (read ceiling ${METADATA_BLOB_READ_MAX_BUFFER_BYTES} bytes)`,
    );
  }
  if (absent.length > 0) {
    sentences.push(
      `verified metadata is absent from the ${source}: `
      + absent.map((entry) => `${entry.path}: ${entry.error}`).join('; '),
    );
  }
  const failed = [...unreadable, ...absent].map((entry) => entry.path);
  return {
    changed,
    failed,
    // Each per-path error is already capped, but N of them concatenated is an aggregate nobody
    // caps. Today N is the small fixed lifecycle-metadata manifest, so the worst case is a few
    // kilobytes and this is not load-bearing - it is here because commitImmutableMetadataTree is
    // exported and takes an arbitrary `paths` array, and "the current callers pass a small set" is
    // an assumption about callers rather than a property of this function. The whole story is about
    // not resting on that kind of assumption, and the cost is one call.
    ...(sentences.length > 0 ? { reason: capDiagnostic(sentences.join(' | ')) } : {}),
  };
}

function runCommitHook(
  gitCwd: string,
  indexFile: string,
  name: 'pre-commit' | 'prepare-commit-msg' | 'commit-msg' | 'post-commit',
  hookArgs: string[] = [],
): { ok: true } | { ok: false; error: string } {
  const hookPathResult = gitMaybe(gitCwd, ['rev-parse', '--git-path', `hooks/${name}`]);
  if (!hookPathResult.ok) return { ok: false, error: hookPathResult.error };
  const hookPath = isAbsolute(hookPathResult.output)
    ? hookPathResult.output
    : join(gitCwd, hookPathResult.output);
  if (!existsSync(hookPath) || (statSync(hookPath).mode & 0o111) === 0) return { ok: true };
  try {
    childProcess.execFileSync(hookPath, hookArgs, {
      cwd: gitCwd,
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: METADATA_BLOB_READ_MAX_BUFFER_BYTES,
    });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: describeDiagnosticStreamFailure(err) };
  }
}

function optionalGitConfig(gitCwd: string, args: string[]): string | undefined {
  try {
    return childProcess.execFileSync('git', ['config', '--get', ...args], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: METADATA_BLOB_READ_MAX_BUFFER_BYTES,
    }).trim() || undefined;
  } catch (err: any) {
    if (err?.status === 1) return undefined;
    throw err;
  }
}

function updateRealIndexFromTree(gitCwd: string, tree: string, paths: string[]): void {
  for (const path of paths) {
    const row = gitRaw(gitCwd, ['ls-tree', tree, '--', path]).trim();
    const match = row.match(/^(\d+)\s+blob\s+([a-f0-9]+)\t/);
    if (!match) throw new Error(`committed tree entry unavailable for ${path}`);
    childProcess.execFileSync('git', ['update-index', '--add', '--cacheinfo', match[1], match[2], path], {
      cwd: gitCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: METADATA_BLOB_READ_MAX_BUFFER_BYTES,
    });
  }
}

export interface ImmutableMetadataCommitTestHooks {
  beforeAdd?: (temporaryIndexFile: string) => void;
  afterAddBeforeCommit?: (temporaryIndexFile: string) => void;
  afterTreeVerificationBeforeCommit?: (temporaryIndexFile: string) => void;
  beforeCommitTree?: (commitTreeArgs: string[], signing: {
    enabled: boolean;
    key?: string;
    format?: string;
  }) => void;
  beforeCasUpdate?: (oldHead: string, targetRef: string) => void;
}

export interface ImmutableMetadataCommitResult {
  ok: boolean;
  commitSha?: string;
  files: string[];
  reason?: string;
}

/**
 * Shared immutable metadata commit primitive. It freezes an exact verified tree
 * in a temporary index, runs the normal hook/message/signing policy, and only
 * installs the commit through an old-HEAD CAS.
 */
export function commitImmutableMetadataTree(args: {
  root: string;
  gitCwd: string;
  paths: string[];
  verifiedHashes: Map<string, string>;
  message: string;
  testHooks?: ImmutableMetadataCommitTestHooks;
}): ImmutableMetadataCommitResult {
  const paths = sortedUnique(args.paths);
  const ident = gitMaybe(args.gitCwd, ['var', 'GIT_AUTHOR_IDENT']);
  if (!ident.ok) return { ok: false, files: paths, reason: `git author identity is unavailable: ${ident.error}` };
  const oldHeadResult = gitMaybe(args.gitCwd, ['rev-parse', 'HEAD']);
  const oldTreeResult = gitMaybe(args.gitCwd, ['rev-parse', 'HEAD^{tree}']);
  const targetRefResult = gitMaybe(args.gitCwd, ['symbolic-ref', '-q', 'HEAD']);
  if (!oldHeadResult.ok || !oldTreeResult.ok || !targetRefResult.ok) {
    return { ok: false, files: paths, reason: 'cannot capture the current branch HEAD/tree for isolated metadata commit' };
  }
  const oldHead = oldHeadResult.output;
  const oldTree = oldTreeResult.output;
  const targetRef = targetRefResult.output;
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-immutable-metadata-index-'));
  const temporaryIndexFile = join(tempDir, 'index');
  const messageFile = join(tempDir, 'COMMIT_EDITMSG');
  try {
    writeFileSync(messageFile, `${args.message}\n`, 'utf8');
    isolatedGit(args.gitCwd, temporaryIndexFile, ['read-tree', oldHead]);
    args.testHooks?.beforeAdd?.(temporaryIndexFile);
    isolatedGit(args.gitCwd, temporaryIndexFile, ['add', '--', ...paths]);
    args.testHooks?.afterAddBeforeCommit?.(temporaryIndexFile);

    for (const [name, hookArgs] of [
      ['pre-commit', []],
      ['prepare-commit-msg', [messageFile, 'message']],
      ['commit-msg', [messageFile]],
    ] as const) {
      const hook = runCommitHook(args.gitCwd, temporaryIndexFile, name, [...hookArgs]);
      if (!hook.ok) return { ok: false, files: paths, reason: `git ${name} hook failed: ${hook.error}` };
    }

    const isolatedPaths = isolatedChangedPaths(args.gitCwd, temporaryIndexFile, oldHead);
    const isolatedUnexpected = isolatedPaths.filter((path) => !paths.includes(path));
    const isolatedMissing = paths.filter((path) => !isolatedPaths.includes(path));
    if (isolatedUnexpected.length > 0 || isolatedMissing.length > 0) {
      return {
        ok: false,
        files: sortedUnique([...isolatedUnexpected, ...isolatedMissing]),
        reason: 'isolated index paths do not exactly match the verified metadata manifest',
      };
    }
    const isolatedVerification = verifyMetadataBlobDigests(
      'isolated index',
      paths.map((path) => ({ path, read: isolatedBlobHash(args.gitCwd, temporaryIndexFile, path) })),
      args.verifiedHashes,
    );
    const worktreeMissing = paths.filter((path) => hashFile(args.root, path) === null);
    const worktreeDigestMismatch = paths.filter(
      (path) => !worktreeMissing.includes(path) && hashFile(args.root, path) !== args.verifiedHashes.get(path),
    );
    // A read that could not complete is reported on its own terms and takes precedence: it is the
    // class an operator cannot diagnose from a digest-change sentence.
    if (isolatedVerification.reason || worktreeMissing.length > 0) {
      // capDiagnostic here for the same reason verifyMetadataBlobDigests caps its equivalent: the
      // path list is caller-supplied, and this composition had been left uncapped while its sibling
      // was capped - the inconsistency being the tell. Reachable whenever a hook, a test seam or a
      // concurrent process removes files after isolated staging.
      const worktreeReason = worktreeMissing.length > 0
        ? capDiagnostic(`verified metadata is absent from the worktree: ${worktreeMissing.join('; ')}`)
        : '';
      return {
        ok: false,
        files: sortedUnique([...isolatedVerification.failed, ...worktreeMissing]),
        reason: [isolatedVerification.reason, worktreeReason].filter(Boolean).join(' | '),
      };
    }
    if (isolatedVerification.changed.length > 0 || worktreeDigestMismatch.length > 0) {
      return {
        ok: false,
        files: sortedUnique([...isolatedVerification.changed, ...worktreeDigestMismatch]),
        reason: 'verified metadata changed after manifest verification',
      };
    }

    const tree = isolatedGit(args.gitCwd, temporaryIndexFile, ['write-tree']).trim();
    const treePaths = treeChangedPaths(args.gitCwd, oldTree, tree);
    const treeUnexpected = treePaths.filter((path) => !paths.includes(path));
    const treeMissing = paths.filter((path) => !treePaths.includes(path));
    const treeVerification = verifyMetadataBlobDigests(
      'isolated tree',
      paths.map((path) => ({ path, read: treeBlobHash(args.gitCwd, tree, path) })),
      args.verifiedHashes,
    );
    if (treeVerification.reason) {
      return {
        ok: false,
        files: sortedUnique(treeVerification.failed),
        reason: treeVerification.reason,
      };
    }
    if (treeUnexpected.length > 0 || treeMissing.length > 0 || treeVerification.changed.length > 0) {
      return {
        ok: false,
        files: sortedUnique([...treeUnexpected, ...treeMissing, ...treeVerification.changed]),
        reason: 'isolated tree does not exactly match the verified metadata manifest',
      };
    }
    args.testHooks?.afterTreeVerificationBeforeCommit?.(temporaryIndexFile);

    const signingEnabled = optionalGitConfig(args.gitCwd, ['--bool', 'commit.gpgSign']) === 'true';
    const signingKey = optionalGitConfig(args.gitCwd, ['user.signingKey']);
    const signingFormat = optionalGitConfig(args.gitCwd, ['gpg.format']);
    const commitTreeArgs = [
      'commit-tree',
      tree,
      '-p',
      oldHead,
      '-F',
      messageFile,
      ...(signingEnabled ? [signingKey ? `-S${signingKey}` : '-S'] : []),
    ];
    args.testHooks?.beforeCommitTree?.(commitTreeArgs, {
      enabled: signingEnabled,
      ...(signingKey ? { key: signingKey } : {}),
      ...(signingFormat ? { format: signingFormat } : {}),
    });
    const commitSha = isolatedGit(args.gitCwd, temporaryIndexFile, commitTreeArgs).trim();
    args.testHooks?.beforeCasUpdate?.(oldHead, targetRef);
    const cas = gitMaybe(args.gitCwd, ['update-ref', targetRef, commitSha, oldHead]);
    if (!cas.ok) {
      return {
        ok: false,
        files: paths,
        reason: `HEAD changed before isolated metadata commit CAS: ${cas.error}`,
      };
    }
    const realIndexBefore = indexEntriesForPaths(args.gitCwd, paths);
    try {
      updateRealIndexFromTree(args.gitCwd, tree, paths);
    } catch (err: any) {
      for (const path of paths) {
        restoreIndexEntries(args.gitCwd, path, realIndexBefore.filter((entry) => entry.path === path));
      }
      const rollbackRef = gitMaybe(args.gitCwd, ['update-ref', targetRef, oldHead, commitSha]);
      return {
        ok: false,
        files: paths,
        reason: `real index refresh after isolated commit failed: ${describeContentReadFailure(err)}`
          + (rollbackRef.ok ? '' : `; HEAD rollback CAS failed: ${rollbackRef.error}`),
      };
    }
    runCommitHook(args.gitCwd, temporaryIndexFile, 'post-commit');
    return { ok: true, commitSha, files: paths };
  } catch (err: any) {
    return {
      ok: false,
      files: paths,
      reason: `isolated metadata commit failed: ${describeContentReadFailure(err)}`,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function commitMessage(storyId: string): string {
  return `proof-or-stop: auto-close ${storyId} generated DONE metadata`;
}

export function commitDonePrepareGeneratedMetadata(args: {
  root: string;
  gitCwd: string;
  storyId: string;
  storyDirRel: string;
  baseline: DonePrepareGeneratedMetadataBaseline;
  expectedProcessEventBinding?: DonePrepareGeneratedProcessEventBinding;
  ignoredPaths?: readonly string[];
  /** Hermetic TOCTOU seams. Production callers must omit these hooks. */
  testHooks?: {
    beforeAdd?: (temporaryIndexFile: string) => void;
    afterAddBeforeCommit?: (temporaryIndexFile: string) => void;
    afterTreeVerificationBeforeCommit?: (temporaryIndexFile: string) => void;
    beforeCommitTree?: (commitTreeArgs: string[], signing: {
      enabled: boolean;
      key?: string;
      format?: string;
    }) => void;
    beforeCasUpdate?: (oldHead: string, targetRef: string) => void;
  };
}): DonePrepareGeneratedMetadataCommitResult {
  const rows = filterDonePrepareTrustedMetadataRows(
    args.root,
    gitStatusRowsForDonePrepareGeneratedMetadata(args.gitCwd),
    args.ignoredPaths,
    args.gitCwd,
  );
  const manifest = buildDonePrepareGeneratedMetadataManifest({
    root: args.root,
    storyId: args.storyId,
    storyDirRel: args.storyDirRel,
    baseline: args.baseline,
    statusRows: rows,
    expectedProcessEventBinding: args.expectedProcessEventBinding,
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

  const verifiedHashes = new Map(manifest.entries
    .filter((entry) => entry.safeToAutoStage && entry.afterHash)
    .map((entry) => [entry.path, entry.afterHash!]));
  const committed = commitImmutableMetadataTree({
    root: args.root,
    gitCwd: args.gitCwd,
    paths: manifest.safePaths,
    verifiedHashes,
    message,
    testHooks: args.testHooks,
  });
  return {
    ...committed,
    ...(!committed.ok ? { reason: `isolated generated metadata commit failed: ${committed.reason}` } : {}),
    message,
    manifest,
  };
}
