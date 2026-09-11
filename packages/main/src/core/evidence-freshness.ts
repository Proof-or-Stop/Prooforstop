import { readObservedGitTree, withGitTreeObservation } from './git-tree-observation.js';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { lstatSync, readFileSync, realpathSync } from 'fs';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'path';
import { isMaterialExcludedRuntimeArtifactPath } from './runtime-artifact-registry.js';
import { loadConfig } from './config.js';
import { effectiveValidationCommandEnvironment } from './validation-command-environment.js';
import type {
  VerificationDependencyManifestBindingV1,
  VerificationDependencyManifestBindingV2,
  VerifierDependencyManifestV1,
  VerifierDependencyManifestV2,
} from './types.js';
import {
  buildVerificationReuseCapsuleInvocation,
  isExactVerificationReuseCapsuleInvocation,
  VERIFICATION_DEPENDENCY_MANIFEST_BINDING_V2,
  VERIFICATION_DEPENDENCY_MANIFEST_V2,
  VERIFICATION_REUSE_CAPSULE_PROFILE,
  VERIFICATION_REUSE_CAPSULE_POLICY_DIGEST,
  verificationReuseCapsuleEnvironment,
  verificationReuseCapsuleEnforcementSupported,
} from './verification-reuse-capsule.js';
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

export function isCanonicalGitHeadHash(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

export function isCanonicalSha256Hash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

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

export const EVIDENCE_FRESHNESS_CLASSIFIER_VERSION = 'proof-or-stop.evidence-freshness-classifier.v1';

export type EvidenceFreshnessClassification =
  | 'CURRENT_MATERIAL'
  | 'KNOWN_METADATA_ONLY_HEAD_DRIFT'
  | 'KNOWN_UNRELATED_MATERIAL_DRIFT'
  | 'RELATED_STORY_MATERIAL_DRIFT'
  | 'LEGACY_UNBOUND'
  | 'RUNTIME_UNAVAILABLE'
  | 'UNCOMPARABLE';

export const VERIFIER_DEPENDENCY_MANIFEST_VERSION = 'proof-or-stop.verifier-dependency-manifest.v1' as const;
export const VERIFIER_DEPENDENCY_MANIFEST_BINDING_VERSION = 'proof-or-stop.verifier-dependency-manifest-binding.v1' as const;

export type VerifierReuseDenialReason =
  | 'missing_dependency_manifest'
  | 'malformed_dependency_manifest'
  | 'incomplete_input_closure'
  | 'dynamic_file_reads'
  | 'network_inputs'
  | 'undeclared_environment'
  | 'side_effectful_command'
  | 'unsafe_input_path'
  | 'missing_input'
  | 'non_regular_input'
  | 'untrusted_dependency_manifest'
  | 'unsupported_capsule_enforcement';

export interface VerifierDependencyAssessment {
  reusable: boolean;
  reason: VerifierReuseDenialReason | null;
  manifest: VerifierDependencyManifestV1 | VerifierDependencyManifestV2 | null;
  manifestBinding: VerificationDependencyManifestBindingV1 | VerificationDependencyManifestBindingV2 | null;
  environmentDigest: string;
  evidenceInputDigest: string | null;
  inputFiles: Array<{ path: string; digest: string }>;
}

function canonicalizeDigestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeDigestValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalizeDigestValue(child)]));
  }
  return value;
}

function digestCanonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalizeDigestValue(value))).digest('hex');
}

function denial(
  reason: VerifierReuseDenialReason,
  environmentDigest: string,
  manifest: VerifierDependencyManifestV1 | VerifierDependencyManifestV2 | null = null,
  manifestBinding: VerificationDependencyManifestBindingV1 | VerificationDependencyManifestBindingV2 | null = null,
): VerifierDependencyAssessment {
  return { reusable: false, reason, manifest, manifestBinding, environmentDigest, evidenceInputDigest: null, inputFiles: [] };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

function escapesRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Parse and hash an explicit dependency manifest. Reuse is denied unless the
 * manifest enumerates the exact effective child-environment key set and a safe,
 * regular, repository-contained file closure. Values are hashed, never stored.
 */
export function assessVerifierDependencyManifest(args: {
  gitCwd: string;
  manifestPath?: string;
  processEnvironment?: NodeJS.ProcessEnv;
  executable?: string;
  argv?: readonly string[];
}): VerifierDependencyAssessment {
  const ordinaryEnvironment = effectiveValidationCommandEnvironment(
    args.processEnvironment ?? process.env,
    undefined,
    args.gitCwd,
  );
  const ordinaryEnvironmentEntries = Object.entries(ordinaryEnvironment).sort(([left], [right]) => left.localeCompare(right));
  const ordinaryEnvironmentDigest = digestCanonical(ordinaryEnvironmentEntries);
  const manifestPath = args.manifestPath?.trim();
  if (!manifestPath) return denial('missing_dependency_manifest', ordinaryEnvironmentDigest);
  if (isAbsolute(manifestPath)) return denial('unsafe_input_path', ordinaryEnvironmentDigest);
  const normalizedManifestPath = manifestPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalizedManifestPath.split('/').includes('..')) return denial('unsafe_input_path', ordinaryEnvironmentDigest);
  const absoluteManifestPath = resolvePath(args.gitCwd, normalizedManifestPath);
  if (escapesRoot(args.gitCwd, absoluteManifestPath)) {
    return denial('unsafe_input_path', ordinaryEnvironmentDigest);
  }

  let raw: unknown;
  try {
    const stat = lstatSync(absoluteManifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return denial('non_regular_input', ordinaryEnvironmentDigest);
    if (escapesRoot(realpathSync(args.gitCwd), realpathSync(absoluteManifestPath))) {
      return denial('unsafe_input_path', ordinaryEnvironmentDigest);
    }
    raw = JSON.parse(readFileSync(absoluteManifestPath, 'utf8')) as unknown;
  } catch {
    return denial('malformed_dependency_manifest', ordinaryEnvironmentDigest);
  }
  if (!raw || typeof raw !== 'object') return denial('malformed_dependency_manifest', ordinaryEnvironmentDigest);
  const value = raw as Record<string, unknown>;
  const legacyManifestKeys = [
    'schemaVersion', 'fileClosure', 'files', 'environmentVariables', 'deterministic',
    'dynamicFileReads', 'networkInputs', 'undeclaredEnvironment', 'sideEffects',
  ];
  if (value.schemaVersion === VERIFIER_DEPENDENCY_MANIFEST_VERSION) {
    if (
      Object.keys(value).some(key => !legacyManifestKeys.includes(key))
      || Object.keys(value).length !== legacyManifestKeys.length
    || (value.fileClosure !== 'complete' && value.fileClosure !== 'partial')
    || !isStringArray(value.files)
    || !isStringArray(value.environmentVariables)
    || typeof value.deterministic !== 'boolean'
    || typeof value.dynamicFileReads !== 'boolean'
    || typeof value.networkInputs !== 'boolean'
    || typeof value.undeclaredEnvironment !== 'boolean'
    || typeof value.sideEffects !== 'boolean'
    ) return denial('malformed_dependency_manifest', ordinaryEnvironmentDigest);

    const legacyManifest: VerifierDependencyManifestV1 = {
      schemaVersion: VERIFIER_DEPENDENCY_MANIFEST_VERSION,
      fileClosure: value.fileClosure,
      files: [...value.files],
      environmentVariables: [...value.environmentVariables],
      deterministic: value.deterministic,
      dynamicFileReads: value.dynamicFileReads,
      networkInputs: value.networkInputs,
      undeclaredEnvironment: value.undeclaredEnvironment,
      sideEffects: value.sideEffects,
    };
    const legacyBinding: VerificationDependencyManifestBindingV1 = {
      schemaVersion: VERIFIER_DEPENDENCY_MANIFEST_BINDING_VERSION,
      path: normalizedManifestPath,
      manifestDigest: digestCanonical(legacyManifest),
    };
    // v1 statements describe what the caller claims, not what the tool proved.
    return denial('untrusted_dependency_manifest', ordinaryEnvironmentDigest, legacyManifest, legacyBinding);
  }

  const manifestKeys = ['schemaVersion', 'capsuleProfile', 'files'];
  if (
    Object.keys(value).some(key => !manifestKeys.includes(key))
    || Object.keys(value).length !== manifestKeys.length
    || value.schemaVersion !== VERIFICATION_DEPENDENCY_MANIFEST_V2
    || value.capsuleProfile !== VERIFICATION_REUSE_CAPSULE_PROFILE
    || !isStringArray(value.files)
  ) return denial('malformed_dependency_manifest', ordinaryEnvironmentDigest);

  const manifest: VerifierDependencyManifestV2 = {
    schemaVersion: VERIFICATION_DEPENDENCY_MANIFEST_V2,
    capsuleProfile: VERIFICATION_REUSE_CAPSULE_PROFILE,
    files: [...value.files],
  };
  const closedEnvironment = verificationReuseCapsuleEnvironment(realpathSync(args.gitCwd));
  const environmentEntries = Object.entries(closedEnvironment).sort(([left], [right]) => left.localeCompare(right));
  const environmentDigest = digestCanonical(environmentEntries);
  if (!verificationReuseCapsuleEnforcementSupported()) {
    return denial('unsupported_capsule_enforcement', environmentDigest, manifest);
  }
  const manifestBinding: VerificationDependencyManifestBindingV2 = {
    schemaVersion: VERIFICATION_DEPENDENCY_MANIFEST_BINDING_V2,
    path: normalizedManifestPath,
    manifestDigest: digestCanonical(manifest),
    capsulePolicyDigest: VERIFICATION_REUSE_CAPSULE_POLICY_DIGEST,
  };

  const normalizedFiles = [...manifest.files]
    .map(path => path.replace(/\\/g, '/').replace(/^\.\//, ''))
    .sort((left, right) => left.localeCompare(right));
  if (new Set(normalizedFiles).size !== normalizedFiles.length) {
    return denial('incomplete_input_closure', environmentDigest, manifest, manifestBinding);
  }
  if (normalizedFiles.some((path, index) => path !== manifest.files[index])) {
    return denial('malformed_dependency_manifest', environmentDigest, manifest, manifestBinding);
  }
  const inputFiles: Array<{ path: string; digest: string }> = [];
  for (const path of normalizedFiles) {
    if (!path || /[\0\r\n]/u.test(path) || isAbsolute(path) || path.split('/').includes('..')) {
      return denial('unsafe_input_path', environmentDigest, manifest, manifestBinding);
    }
    const absolutePath = resolvePath(args.gitCwd, path);
    if (escapesRoot(args.gitCwd, absolutePath)) {
      return denial('unsafe_input_path', environmentDigest, manifest, manifestBinding);
    }
    try {
      const stat = lstatSync(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return denial('non_regular_input', environmentDigest, manifest, manifestBinding);
      if (escapesRoot(realpathSync(args.gitCwd), realpathSync(absolutePath))) {
        return denial('unsafe_input_path', environmentDigest, manifest, manifestBinding);
      }
      inputFiles.push({ path, digest: createHash('sha256').update(readFileSync(absolutePath)).digest('hex') });
    } catch {
      return denial('missing_input', environmentDigest, manifest, manifestBinding);
    }
  }
  const expectedInvocation = buildVerificationReuseCapsuleInvocation({
    cwd: args.gitCwd,
    manifestPath: normalizedManifestPath,
    files: normalizedFiles,
  });
  if (!args.executable || !args.argv || !isExactVerificationReuseCapsuleInvocation({
    executable: args.executable,
    argv: args.argv,
    expected: expectedInvocation,
  })) {
    return denial('untrusted_dependency_manifest', environmentDigest, manifest, manifestBinding);
  }
  return {
    reusable: true,
    reason: null,
    manifest,
    manifestBinding,
    environmentDigest,
    evidenceInputDigest: digestCanonical({
      manifestDigest: manifestBinding.manifestDigest,
      capsulePolicyDigest: manifestBinding.capsulePolicyDigest,
      environmentDigest,
      inputFiles,
    }),
    inputFiles,
  };
}

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

export function readMaterialDirtyFiles(gitCwd: string, metadataRoot: string): { files: string[]; error?: string } {
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
  return withGitTreeObservation(() => {
    const gitCwd = normalizeSnapshotRoot(args.gitCwd);
    const metadataRoot = normalizeSnapshotRoot(args.metadataRoot ?? args.gitCwd);
    const ref = args.ref ?? 'HEAD';
    const dirty = readMaterialDirtyFiles(gitCwd, metadataRoot);
    const headHash = gitCommitAtRef(gitCwd, ref);
    const observedRef = isCanonicalGitHeadHash(headHash) ? headHash as string : ref;
    const materialHash = currentMaterialHash(gitCwd, observedRef, metadataRoot);
    const storyFilesHash = currentStoryFilesHash(gitCwd, observedRef, metadataRoot);
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
  });
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
  const customReplacementBase = process.env.GIT_REPLACE_REF_BASE !== undefined;
  // A custom prefix need not end in '/', unlike for-each-ref path matching.
  const replacements = customReplacementBase || execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/replace/'], {
    cwd, ...GIT_EXEC_OPTS,
  }).trim();
  const previous = treeMemo.get(cwd);
  if (replacements) {
    if (previous) { treeMemo.delete(cwd); treeMemoBytes -= previous.bytes; }
    return readObservedGitTree(cwd, sha);
  }
  if (previous?.sha === sha) return previous.raw;
  const raw = readObservedGitTree(cwd, sha);
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
    const mergeBase = resolveStoryMergeBase(gitCwd, ref);
    if (!mergeBase) return undefined;
    const entries = resolveStoryChangedFiles(gitCwd, ref, metadataRoot, mergeBase)
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
  return withGitTreeObservation(() => {
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
    const materialHash = currentMaterialHash(gitCwd, currentHead, metadataRoot);
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
        const storyFilesHash = currentStoryFilesHash(gitCwd, currentHead, metadataRoot);
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
    const changedFiles = changedFilesBetween(gitCwd, evidenceHash, currentHead);
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
  });
}

/**
 * Strict fallback for executions whose input closure is not tool-proven. HEAD
 * may move for metadata-only commits, but both material digests must be present,
 * canonical and equal to freshly computed values. Runtime uncertainty denies.
 */
export function checkStrictVerificationEvidenceFreshnessForGit(
  gitCwd: string,
  evidenceHeadHash: string | undefined,
  evidenceMaterialHash: string | undefined,
  metadataRoot: string = gitCwd,
  evidenceStoryFilesHash: string | undefined,
): EvidenceFreshness {
  return withGitTreeObservation(() => {
    const malformed = !isCanonicalGitHeadHash(evidenceHeadHash)
      || !isCanonicalSha256Hash(evidenceMaterialHash)
      || !isCanonicalSha256Hash(evidenceStoryFilesHash);
    if (malformed) {
      return {
        fresh: false,
        reason: 'strict verification freshness requires canonical full headHash, materialHash, and storyFilesHash bindings',
        changedFiles: [],
        materialFiles: ['<malformed-or-partial-hash-binding>'],
      };
    }
    const currentHead = currentGitHead(gitCwd);
    const currentMaterial = currentMaterialHash(gitCwd, isCanonicalGitHeadHash(currentHead) ? currentHead as string : 'HEAD', metadataRoot);
    const currentStoryFiles = currentStoryFilesHash(gitCwd, isCanonicalGitHeadHash(currentHead) ? currentHead as string : 'HEAD', metadataRoot);
    if (
      !isCanonicalGitHeadHash(currentHead)
      || !isCanonicalSha256Hash(currentMaterial)
      || !isCanonicalSha256Hash(currentStoryFiles)
    ) {
      return {
        fresh: false,
        reason: 'strict verification freshness could not resolve canonical current git/material/story hashes',
        changedFiles: [],
        materialFiles: ['<freshness-runtime-unavailable>'],
      };
    }
    if (currentMaterial !== evidenceMaterialHash || currentStoryFiles !== evidenceStoryFilesHash) {
      return {
        fresh: false,
        reason: currentMaterial !== evidenceMaterialHash
          ? 'strict verification freshness materialHash does not match current material state'
          : 'strict verification freshness storyFilesHash does not match current story-owned state',
        currentHead,
        currentMaterialHash: currentMaterial,
        currentStoryFilesHash: currentStoryFiles,
        changedFiles: [],
        materialFiles: [currentMaterial !== evidenceMaterialHash ? '<material-tree-changed>' : '<story-files-changed>'],
      };
    }
    return {
      fresh: true,
      reason: currentHead === evidenceHeadHash
        ? 'strict verification freshness full hash tuple matches current state'
        : 'strict verification freshness material/story hashes match; metadata-only HEAD drift accepted',
      currentHead,
      currentMaterialHash: currentMaterial,
      currentStoryFilesHash: currentStoryFiles,
      changedFiles: currentHead === evidenceHeadHash ? [] : ['<metadata-only-head-drift>'],
      materialFiles: [],
    };
  });
}
