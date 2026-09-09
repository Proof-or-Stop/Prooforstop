import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { resolve as resolvePath } from 'path';
import { realpathSync } from 'node:fs';
import { isMaterialExcludedRuntimeArtifactPath } from './runtime-artifact-registry.js';
import { loadConfig } from './config.js';
import {
  PROOF_OR_STOP_STORY_DIR,
  PROOF_OR_STOP_STORY_DIR_NAMES,
  LEGACY_DOCS_STORY_DIR,
} from './proof-or-stop-paths.js';
import {
  EVIDENCE_HASH_SNAPSHOT_SCHEMA,
  isEvidenceHashSnapshotSchema,
  type EvidenceHashSnapshotSchema,
} from './artifact-schema.js';
import { resolveStoryChangedFiles, resolveStoryMergeBase } from './story-aware-validation.js';
import { isMaterialExcludedPath, isStoryMetadataPath } from './material-path-policy.js';
export { isMaterialExcludedPath, isStoryMetadataPath };

export const GIT_TREE_OUTPUT_MAX_BUFFER = 32 * 1024 * 1024;

// B-d243 (host-2 soundness fix): the value currentStoryFilesHash returns for an
// EMPTY story-owned diff (HEAD == main, or the story already resolved on main).
// The shared changed-file resolver then yields zero entries, so the hash is
// sha256(''). This is NOT undefined — it is a real digest that vouches for
// NOTHING. Treating it as a positive signal would let a delivery-check signed on
// main (empty diff) re-match later under whole-tree drift while HEAD stays empty,
// wrongly firing the drift-advisory downgrade for a record that attested no
// story diff. Callers that key the advisory on storyFilesHash must therefore
// treat this empty-set value as no-signal and fall back to strict materialHash.
export const EMPTY_STORY_FILES_HASH = createHash('sha256').update('').digest('hex');

export type EvidenceFreshness = {
  fresh: boolean;
  reason: string;
  warnings?: string[];
  currentHead?: string;
  currentMaterialHash?: string;
  currentStoryFilesHash?: string;
  changedFiles: string[];
  materialFiles: string[];
};

export const EVIDENCE_FRESHNESS_CLASSIFIER_VERSION = 'proofbound.evidence-freshness-classifier.v1';

export type EvidenceFreshnessClassification =
  | 'CURRENT_MATERIAL'
  | 'KNOWN_METADATA_ONLY_HEAD_DRIFT'
  | 'KNOWN_UNRELATED_MATERIAL_DRIFT'
  | 'RELATED_STORY_MATERIAL_DRIFT'
  | 'LEGACY_UNBOUND'
  | 'RUNTIME_UNAVAILABLE'
  | 'UNCOMPARABLE';

/**
 * Canonical projection of the freshness reader result. Incremental eligibility
 * consumes this classification and never reinterprets raw hashes or reason text.
 */
export function classifyEvidenceFreshness(
  freshness: EvidenceFreshness,
  evidenceHash?: string,
): EvidenceFreshnessClassification {
  if (!evidenceHash) return 'LEGACY_UNBOUND';
  if (/Unable to get git HEAD/i.test(freshness.reason)) return 'RUNTIME_UNAVAILABLE';
  if (!freshness.fresh) {
    return freshness.materialFiles.includes('<story-files-changed>')
      ? 'RELATED_STORY_MATERIAL_DRIFT'
      : 'UNCOMPARABLE';
  }
  if (freshness.warnings?.some(warning => /whole-tree materialHash drift/i.test(warning))) {
    return 'KNOWN_UNRELATED_MATERIAL_DRIFT';
  }
  if (freshness.materialFiles.length === 0 && freshness.changedFiles.length > 0) {
    return 'KNOWN_METADATA_ONLY_HEAD_DRIFT';
  }
  if (freshness.changedFiles.length === 0 && freshness.materialFiles.length === 0) {
    return 'CURRENT_MATERIAL';
  }
  return 'UNCOMPARABLE';
}

export interface EvidenceHashSnapshot {
  schemaVersion: EvidenceHashSnapshotSchema;
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
  gitCwd: string;
  metadataRoot: string;
  ref: string;
  capturedAt: string;
  materialDirtyFiles: string[];
}

export interface EvidenceHashSnapshotCaptureArgs {
  gitCwd: string;
  metadataRoot?: string;
  ref?: string;
}

/**
 * Wave 1A coverage-basis receipts use the same canonical freshness reader as
 * other story evidence. This named adapter prevents basis consumers from
 * reinterpreting raw hashes or silently rebinding an old inventory.
 */
export function checkAcceptanceBasisBindingFreshness(args: {
  gitCwd: string;
  metadataRoot: string;
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
}): EvidenceFreshness {
  return checkEvidenceFreshnessForGit(
    args.gitCwd,
    args.headHash,
    args.materialHash,
    args.metadataRoot,
    args.storyFilesHash,
  );
}

export interface EvidenceHashSnapshotReuseCheck {
  reusable: boolean;
  materialDirty: boolean;
  materialDirtyFiles: string[];
  reasons: string[];
  currentHead?: string;
}

function headMatches(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

// B-f492 CHK-001: shared git execFileSync options. The ONLY change vs. the
// per-call inline objects is the explicit `maxBuffer`. Node's default
// execFileSync maxBuffer is 1 MiB (1048576 bytes); `git ls-tree -r -z HEAD` on
// this repo now exceeds that (~1.05 MiB), so without an explicit large buffer
// that call throws ENOBUFS, the surrounding try/catch swallows it, and
// currentMaterialHash returns undefined — breaking materialHash repo-wide
// (review_run_start, escalation/assurance-floor verdicts, the DONE gate). A 1 GiB
// ceiling removes the cap for every git read here while keeping encoding/stdio
// (and thus the parsed output and resulting hash) byte-identical. `cwd` stays
// per-call (spread on top of these shared options).
const GIT_EXEC_OPTS = {
  encoding: 'utf-8' as const,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  maxBuffer: 1024 * 1024 * 1024,
};

/**
 * B-6666 CHK-002: the parameter IS the resolved git invocation cwd
 * (wrapper-root aware), not a bare metadataRoot. Callers thread
 * `resolveGitCwd(...)` here; plain repos pass projectRoot==gitCwd so behavior is
 * byte-identical. On a wrapper-root layout (metadataRoot != gitRoot) a bare
 * metadataRoot is not a git repo, so `git rev-parse HEAD` from it returns
 * undefined — passing the resolved gitCwd is what makes the probe return a
 * defined hash.
 */
export function gitCommitAtRef(gitCwd: string, ref: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', ref], {
      cwd: gitCwd,
      ...GIT_EXEC_OPTS,
    }).trim();
  } catch {
    return undefined;
  }
}

export function currentGitHead(gitCwd: string): string | undefined {
  return gitCommitAtRef(gitCwd, 'HEAD');
}

function normalizeSnapshotRoot(path: string): string {
  return resolvePath(path);
}

function parseGitStatusPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readMaterialDirtyFiles(gitCwd: string, metadataRoot: string): { files: string[]; error?: string } {
  try {
    // No full-output trim(): it would strip the first porcelain row's leading
    // status space (" M path" -> "M path"), shifting the fixed-width path
    // offset and corrupting the first reported path (".proof-or-stop/x" -> "proofOrStop/x").
    const raw = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: gitCwd,
      ...GIT_EXEC_OPTS,
    });
    const rows = raw.split('\n').map((line) => line.trimEnd()).filter(Boolean);
    const dirty = new Set<string>();
    for (const line of rows) {
      if (line.length < 4) continue;
      const pathText = line.slice(3);
      const paths = pathText.includes(' -> ')
        ? pathText.split(' -> ').map(parseGitStatusPath)
        : [parseGitStatusPath(pathText)];
      for (const path of paths) {
        if (path && !isMaterialExcludedPath(path, metadataRoot)) dirty.add(path);
      }
    }
    return { files: [...dirty].sort() };
  } catch (err) {
    return {
      files: ['<git-status-unavailable>'],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function captureEvidenceHashSnapshot(args: EvidenceHashSnapshotCaptureArgs): EvidenceHashSnapshot {
  const gitCwd = normalizeSnapshotRoot(args.gitCwd);
  const metadataRoot = normalizeSnapshotRoot(args.metadataRoot ?? args.gitCwd);
  const ref = args.ref ?? 'HEAD';
  const dirty = readMaterialDirtyFiles(gitCwd, metadataRoot);
  const headHash = gitCommitAtRef(gitCwd, ref);
  const materialHash = currentMaterialHash(gitCwd, ref, metadataRoot);
  const storyFilesHash = currentStoryFilesHash(gitCwd, ref, metadataRoot);
  return {
    schemaVersion: EVIDENCE_HASH_SNAPSHOT_SCHEMA,
    ...(headHash ? { headHash } : {}),
    ...(materialHash ? { materialHash } : {}),
    ...(storyFilesHash ? { storyFilesHash } : {}),
    gitCwd,
    metadataRoot,
    ref,
    capturedAt: new Date().toISOString(),
    materialDirtyFiles: dirty.files,
  };
}

export function tryCaptureEvidenceHashSnapshot(args: EvidenceHashSnapshotCaptureArgs): EvidenceHashSnapshot | undefined {
  try {
    return captureEvidenceHashSnapshot(args);
  } catch {
    return undefined;
  }
}

export function checkEvidenceHashSnapshotReuse(
  snapshot: EvidenceHashSnapshot | undefined,
  args: EvidenceHashSnapshotCaptureArgs,
): EvidenceHashSnapshotReuseCheck {
  const gitCwd = normalizeSnapshotRoot(args.gitCwd);
  const metadataRoot = normalizeSnapshotRoot(args.metadataRoot ?? args.gitCwd);
  const ref = args.ref ?? 'HEAD';
  const reasons: string[] = [];
  if (!snapshot) {
    return {
      reusable: false,
      materialDirty: false,
      materialDirtyFiles: [],
      reasons: ['missing evidence hash snapshot'],
    };
  }

  if (!isEvidenceHashSnapshotSchema(snapshot.schemaVersion)) {
    reasons.push('snapshot schemaVersion is not supported');
  }
  if (snapshot.gitCwd !== gitCwd) reasons.push('snapshot gitCwd does not match current git cwd');
  if (snapshot.metadataRoot !== metadataRoot) reasons.push('snapshot metadataRoot does not match current metadata root');
  if (snapshot.ref !== ref) reasons.push('snapshot ref does not match current ref');
  if (!snapshot.materialHash) reasons.push('snapshot is missing materialHash');
  if (!snapshot.storyFilesHash) reasons.push('snapshot is missing storyFilesHash');

  const currentHead = currentGitHead(gitCwd);
  if (!currentHead) {
    reasons.push('current HEAD is unavailable');
  } else if (!snapshot.headHash) {
    reasons.push('snapshot is missing headHash');
  } else if (!headMatches(snapshot.headHash, currentHead)) {
    reasons.push('snapshot headHash does not match current HEAD');
  }

  const currentDirty = readMaterialDirtyFiles(gitCwd, metadataRoot);
  if (currentDirty.error) reasons.push('current material dirty files could not be inspected');
  if (snapshot.materialDirtyFiles.length > 0) reasons.push('snapshot captured material dirty files');
  if (currentDirty.files.length > 0) reasons.push('current material dirty files are present');
  const materialDirtyFiles = [...new Set([...snapshot.materialDirtyFiles, ...currentDirty.files])].sort();
  return {
    reusable: reasons.length === 0,
    materialDirty: materialDirtyFiles.length > 0,
    materialDirtyFiles,
    reasons,
    ...(currentHead ? { currentHead } : {}),
  };
}

// B-6666 CHK-002: gitCwd is the resolved git invocation cwd (wrapper-root
// aware). Callers thread resolveGitCwd(...); plain repos pass projectRoot==gitCwd
// so behavior is byte-identical.
export function changedFilesBetween(gitCwd: string, fromHead: string, toHead = 'HEAD'): string[] {
  const raw = execFileSync('git', ['diff', '--name-only', `${fromHead}..${toHead}`], {
    cwd: gitCwd,
    ...GIT_EXEC_OPTS,
  }).trim();
  return raw.split('\n').map(line => line.trim()).filter(Boolean);
}

/**
 * One parsed record of `git diff --name-status -M -z`.
 *
 * `status` is the raw status column (`M`, `A`, `D`, `T`, `U`, `X`, or `R<score>` /
 * `C<score>`). Rename and copy records carry the source in `oldPath` and the
 * destination in `path`; every other record carries only `path`.
 */
export type NameStatusRecord = { status: string; oldPath?: string; path: string };

// Single-path statuses git can emit in --name-status output. Rename (R) and
// copy (C) carry an optional similarity score and TWO paths.
const NAME_STATUS_SINGLE_PATH = /^[ADMTUX]$/;
const NAME_STATUS_TWO_PATH = /^[RC]\d{0,3}$/;

/**
 * B-41c8 CHK-001: the ONE parser for `git diff --name-status -M -z` output.
 *
 * `-z` terminates every field with NUL and disables C-quoting, so a path with a
 * space, a non-ASCII character or a quote character arrives verbatim instead
 * of as `"q\"uote.txt"` / `"\346\227\245\346\234\254.txt"` (which the previous
 * tab parser reported as literal strings, silently losing both sides of such a
 * rename). Record shape:
 *
 *   <status> NUL <path> NUL                      single-path statuses
 *   <R|C><score> NUL <old> NUL <new> NUL         rename / copy
 *
 * Contract: a token stream that does not fit that shape throws an Error whose
 * message contains the raw offending record. No record is ever skipped —
 * skipping would turn a parse failure into a shorter path list under a success
 * status, which is exactly the silent data loss this reader exists to prevent.
 */
export function parseNameStatusRecords(raw: string): NameStatusRecord[] {
  if (raw.length === 0) return [];
  // Every field is NUL-terminated, so a well-formed stream ends with NUL and the
  // final split element is the empty string.
  const fields = raw.split('\0');
  const terminated = fields[fields.length - 1] === '';
  if (terminated) fields.pop();
  const records: NameStatusRecord[] = [];
  const describe = (start: number, width: number): string =>
    JSON.stringify(fields.slice(start, start + width));
  const fail = (start: number, width: number, reason: string): never => {
    throw new Error(
      `git diff --name-status -z: unparseable record ${describe(start, width)} at field ${start} (${reason})`,
    );
  };
  let index = 0;
  while (index < fields.length) {
    const status = fields[index];
    if (NAME_STATUS_TWO_PATH.test(status)) {
      const oldPath = fields[index + 1];
      const path = fields[index + 2];
      if (oldPath === undefined || path === undefined || (index + 2 === fields.length - 1 && !terminated)) {
        fail(index, 3, 'rename/copy record needs two NUL-terminated paths');
      }
      if (!oldPath || !path) fail(index, 3, 'empty path');
      records.push({ status, oldPath, path });
      index += 3;
      continue;
    }
    if (NAME_STATUS_SINGLE_PATH.test(status)) {
      const path = fields[index + 1];
      if (path === undefined || (index + 1 === fields.length - 1 && !terminated)) {
        fail(index, 2, 'record needs one NUL-terminated path');
      }
      if (!path) fail(index, 2, 'empty path');
      records.push({ status, path });
      index += 2;
      continue;
    }
    fail(index, 3, `unknown status ${JSON.stringify(status)}`);
  }
  return records;
}

/**
 * Reads `git diff --name-status -M -z <fromHead>..<toHead>` and parses it.
 *
 * Contract (pinned by single-owner-extraction-smoke):
 *   - an unresolvable ref THROWS (git exits 128 and execFileSync propagates);
 *     callers classify that failure themselves — a `catch { return [] }`
 *     around this reader is forbidden because it converts "could not read" into
 *     "nothing changed";
 *   - a malformed record THROWS via parseNameStatusRecords; nothing is skipped.
 *
 * B-6666 CHK-002: gitCwd is the resolved git invocation cwd (wrapper-root
 * aware). Callers thread resolveGitCwd(...); plain repos pass projectRoot==gitCwd
 * so behavior is byte-identical.
 */
function readNameStatusRecords(gitCwd: string, fromHead: string, toHead: string): NameStatusRecord[] {
  const raw = execFileSync('git', ['diff', '--name-status', '-M', '-z', `${fromHead}..${toHead}`], {
    cwd: gitCwd,
    ...GIT_EXEC_OPTS,
  });
  return parseNameStatusRecords(raw);
}

/**
 * Rename-aware variant of changedFilesBetween. Uses `git diff --name-status -M -z`
 * so a rename (R100 old new) surfaces BOTH the old and the new path rather than
 * being collapsed into a single name-only line that may hide one side. This is a
 * strictly stronger signal than the name-only variant (it never reports fewer
 * paths), which is why the incremental-context helper relies on it: a reviewer
 * whose file was renamed since its last pass must still see scopeChanged=true.
 *
 * Output is a de-duplicated, sorted list of paths. For rename (R) and copy (C)
 * records both the source and destination paths are emitted. Throws on an
 * unresolvable ref or a malformed record (see readNameStatusRecords).
 */
export function changedFilesBetweenRenameAware(gitCwd: string, fromHead: string, toHead = 'HEAD'): string[] {
  const paths = new Set<string>();
  for (const record of readNameStatusRecords(gitCwd, fromHead, toHead)) {
    if (record.oldPath !== undefined) paths.add(record.oldPath);
    paths.add(record.path);
  }
  return [...paths].sort();
}

/**
 * Status map companion for callers whose policy must reject rename/delete.
 * Throws on an unresolvable ref or a malformed record (see readNameStatusRecords).
 */
export function changedFileStatusesBetweenRenameAware(
  gitCwd: string,
  fromHead: string,
  toHead = 'HEAD',
): Record<string, string> {
  const statuses: Record<string, string> = {};
  for (const record of readNameStatusRecords(gitCwd, fromHead, toHead)) {
    if (record.oldPath !== undefined) statuses[record.oldPath] = record.status;
    statuses[record.path] = record.status;
  }
  return Object.fromEntries(Object.entries(statuses).sort(([left], [right]) => left.localeCompare(right)));
}

function mergeBaseWithMain(gitCwd: string, ref = 'HEAD'): string | undefined {
  const mainCandidates = ['main', 'origin/main'];
  for (const candidate of mainCandidates) {
    try {
      const base = execFileSync('git', ['merge-base', candidate, ref], {
        cwd: gitCwd,
        ...GIT_EXEC_OPTS,
      }).trim();
      if (base) return base;
    } catch {
      // Try the next conventional main ref.
    }
  }
  return undefined;
}

/**
 * Story-owned file entries between two refs, feeding currentStoryFilesHash.
 * The source side of a rename or copy is recorded as deleted (its object id no
 * longer exists at `toHead`); the destination side is live. Exported so the
 * single-owner-extraction smoke can drive it directly. Throws on an
 * unresolvable ref or a malformed record (see readNameStatusRecords);
 * currentStoryFilesHash is the ONLY caller that maps that throw to undefined.
 */
export function changedStoryFilesBetween(gitCwd: string, fromHead: string, toHead = 'HEAD'): Array<{ path: string; deleted: boolean }> {
  const files = new Map<string, { path: string; deleted: boolean }>();
  const add = (path: string, deleted: boolean) => {
    const existing = files.get(path);
    files.set(path, { path, deleted: existing ? existing.deleted && deleted : deleted });
  };
  for (const record of readNameStatusRecords(gitCwd, fromHead, toHead)) {
    if (record.oldPath !== undefined) add(record.oldPath, true);
    add(record.path, record.status.startsWith('D'));
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// Cache only immutable Git bytes. Material policy and Story scope are evaluated
// on every read, so edits to configuration cannot make a cached hash false-fresh.
const treeMemo = new Map<string, { sha: string; raw: string; bytes: number }>();
let treeMemoBytes = 0;
function readCommittedTree(gitCwd: string, ref: string): string {
  const cwd = realpathSync(gitCwd);
  const sha = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{object}`], {
    cwd, ...GIT_EXEC_OPTS,
  }).trim();
  // Replacement refs can redirect commits or nested trees without changing
  // the requested object id. Ask Git so packed refs and linked worktrees work
  // too; conservatively bypass caching whenever the selected namespace is used.
  const replacementBase = process.env.GIT_REPLACE_REF_BASE ?? 'refs/replace/';
  const replacements = execFileSync('git', ['for-each-ref', '--format=%(refname)', replacementBase], {
    cwd, ...GIT_EXEC_OPTS,
  }).trim();
  const previous = treeMemo.get(cwd);
  if (replacements) {
    if (previous) { treeMemo.delete(cwd); treeMemoBytes -= previous.bytes; }
    return execFileSync('git', ['ls-tree', '-r', '-z', sha], { cwd, ...GIT_EXEC_OPTS });
  }
  if (previous?.sha === sha) return previous.raw;
  const raw = execFileSync('git', ['ls-tree', '-r', '-z', sha], { cwd, ...GIT_EXEC_OPTS });
  if (previous) { treeMemo.delete(cwd); treeMemoBytes -= previous.bytes; }
  const bytes = Buffer.byteLength(raw);
  while (treeMemo.size && treeMemoBytes + bytes > 64 * 1024 * 1024) {
    const oldest = treeMemo.keys().next().value!;
    treeMemoBytes -= treeMemo.get(oldest)!.bytes;
    treeMemo.delete(oldest);
  }
  treeMemo.set(cwd, { sha, raw, bytes });
  treeMemoBytes += bytes;
  return raw;
}

function objectIdsAtRef(gitCwd: string, ref: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const raw = readCommittedTree(gitCwd, ref);
    for (const entry of raw.split('\0')) {
      if (!entry) continue;
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const meta = entry.slice(0, tab);
      const filePath = entry.slice(tab + 1);
      const objectId = meta.trim().split(/\s+/)[2];
      if (filePath && objectId) out.set(filePath, objectId);
    }
  } catch {
    return out;
  }
  return out;
}

export function currentStoryFilesHash(gitCwd: string, ref = 'HEAD', metadataRoot: string = gitCwd): string | undefined {
  try {
    if (!resolveStoryMergeBase(gitCwd, ref)) return undefined;
    const entries = resolveStoryChangedFiles(gitCwd, ref, metadataRoot)
      .map(entry => entry.path + '\0' + (entry.blobId || '<deleted>'))
      .sort();
    return createHash('sha256').update(entries.join('\0')).digest('hex');
  } catch {
    return undefined;
  }
}

// B-6666 CHK-002: gitCwd is the resolved git invocation cwd (wrapper-root
// aware). Callers thread resolveGitCwd(...); plain repos pass
// projectRoot==gitCwd so behavior is byte-identical.
//
// B-6666 F-001 (REVIEW fix): metadataRoot — NOT gitCwd — drives the
// storyDir-aware metadata-path exclusion (isMaterialExcludedPath ->
// isStoryMetadataPath -> loadConfig). The proof-or-stop.config.json that declares a
// CUSTOM storyDir lives at the metadataRoot, not the gitCwd; on a wrapper-root
// layout (metadataRoot != gitRoot) with a non-default storyDir, loading config
// from gitCwd silently misses the custom storyDir and WRONGLY includes the
// story-metadata paths in the material hash. metadataRoot defaults to gitCwd so
// plain repos (metadataRoot==gitCwd) and every existing positional caller stay
// byte-identical.
export function currentMaterialHash(gitCwd: string, ref = 'HEAD', metadataRoot: string = gitCwd): string | undefined {
  try {
    const raw = readCommittedTree(gitCwd, ref);
    const entries = raw.split('\0').filter(Boolean);
    const materialEntries: string[] = [];
    for (const entry of entries) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const meta = entry.slice(0, tab);
      const filePath = entry.slice(tab + 1);
      if (isMaterialExcludedPath(filePath, metadataRoot)) continue;
      const objectId = meta.trim().split(/\s+/)[2];
      if (!objectId) continue;
      materialEntries.push(`${filePath}\0${objectId}`);
    }
    materialEntries.sort();
    return createHash('sha256').update(materialEntries.join('\0')).digest('hex');
  } catch {
    return undefined;
  }
}

// B-6666 CHK-002: gitCwd is the resolved git invocation cwd (wrapper-root
// aware). Callers thread resolveGitCwd(...) at their boundary; plain repos pass
// projectRoot==gitCwd so behavior is byte-identical. This wrapper forwards the
// same gitCwd into every git probe (head / material hash / diff) so all reads
// share one resolved gitRoot — no split-brain between probes.
//
// B-6666 F-001 (REVIEW fix): metadataRoot — NOT gitCwd — is the config-load root
// for the storyDir-aware metadata-path exclusion. It is forwarded into the inner
// currentMaterialHash(...) call AND into the isMaterialExcludedPath(...) filter
// below. Defaults to gitCwd so plain repos and existing positional callers stay
// byte-identical; only wrapper-root callers with a distinct metadataRoot pass it.
export function checkEvidenceFreshnessForGit(
  gitCwd: string,
  evidenceHash: string | undefined,
  evidenceMaterialHash?: string,
  metadataRoot: string = gitCwd,
  evidenceStoryFilesHash?: string,
  asOfRef: string = 'HEAD',
): EvidenceFreshness {
  if (!evidenceHash) {
    return {
      fresh: true,
      reason: 'evidence has no headHash (legacy format, skipping freshness check)',
      changedFiles: [],
      materialFiles: [],
    };
  }

  const asOf = asOfRef.trim() || 'HEAD';
  const currentHead = asOf === 'HEAD' ? currentGitHead(gitCwd) : gitCommitAtRef(gitCwd, asOf);
  if (!currentHead) {
    return {
      fresh: true,
      reason: 'Unable to get git HEAD, skipping freshness check',
      changedFiles: [],
      materialFiles: [],
    };
  }

  if (evidenceMaterialHash) {
    const materialHash = currentMaterialHash(gitCwd, asOf, metadataRoot);
    if (materialHash) {
      if (materialHash === evidenceMaterialHash) {
        return {
          fresh: true,
          reason: 'evidence materialHash matches current entity file state',
          currentHead,
          currentMaterialHash: materialHash,
          changedFiles: [],
          materialFiles: [],
        };
      }
      // review-run-binding-race (friction #2) soundness guard: an EMPTY_STORY_FILES_HASH
      // (sha256 of an empty story-owned diff — e.g. HEAD==main / no story branch) is a
      // NO-SIGNAL value, not a real vouching hash. It must never enable the drift advisory
      // (else a stale-material record whose story diff is empty on both sides would ride
      // the downgrade). Skip the advisory when either side is the empty-set value; control
      // falls through to the strict materialHash hard-reject below. Mirrors the delivery-check
      // empty-set guard, generalized here for ALL checkEvidenceFreshnessForGit callers.
      if (evidenceStoryFilesHash && evidenceStoryFilesHash !== EMPTY_STORY_FILES_HASH) {
        const storyFilesHash = currentStoryFilesHash(gitCwd, asOf, metadataRoot);
        if (storyFilesHash && storyFilesHash !== EMPTY_STORY_FILES_HASH && storyFilesHash === evidenceStoryFilesHash) {
          return {
            fresh: true,
            reason: 'evidence storyFilesHash matches current story-owned file state; whole-tree materialHash drift requires re-attestation advisory',
            warnings: ['whole-tree materialHash drift detected while storyFilesHash matches; re-attestation advisory required'],
            currentHead,
            currentMaterialHash: materialHash,
            currentStoryFilesHash: storyFilesHash,
            changedFiles: ['<material-tree-changed>'],
            materialFiles: [],
          };
        }
        if (storyFilesHash && storyFilesHash !== evidenceStoryFilesHash) {
          return {
            fresh: false,
            reason: 'evidence storyFilesHash does not match current story-owned file state',
            currentHead,
            currentMaterialHash: materialHash,
            currentStoryFilesHash: storyFilesHash,
            changedFiles: [],
            materialFiles: ['<story-files-changed>'],
          };
        }
      }
      return {
        fresh: false,
        reason: `evidence materialHash does not match current entity file state`,
        currentHead,
        currentMaterialHash: materialHash,
        changedFiles: [],
        materialFiles: ['<material-tree-changed>'],
      };
    }
  }

  if (headMatches(evidenceHash, currentHead)) {
    return {
      fresh: true,
      reason: 'evidence corresponds to current HEAD',
      currentHead,
      changedFiles: [],
      materialFiles: [],
    };
  }

  try {
    const changedFiles = changedFilesBetween(gitCwd, evidenceHash, asOf);
    const materialFiles = changedFiles.filter(f => !isMaterialExcludedPath(f, metadataRoot));
    if (materialFiles.length === 0) {
      return {
        fresh: true,
        reason: `evidence followed by ${changedFiles.length} metadata-only changes, not invalidated`,
        currentHead,
        changedFiles,
        materialFiles,
      };
    }
    return {
      fresh: false,
      reason: `evidence based on ${evidenceHash.slice(0, 7)}, but HEAD is ${currentHead.slice(0, 7)}, has code changes: ${materialFiles.slice(0, 5).join(', ')}`,
      currentHead,
      changedFiles,
      materialFiles,
    };
  } catch {
    return {
      fresh: false,
      reason: `evidence hash ${evidenceHash.slice(0, 7)} does not match HEAD ${currentHead.slice(0, 7)}, and unable to compare git diff`,
      currentHead,
      changedFiles: [],
      materialFiles: [],
    };
  }
}
