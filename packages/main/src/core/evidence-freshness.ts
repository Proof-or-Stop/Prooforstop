import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { resolve as resolvePath } from 'path';
import { isMaterialExcludedRuntimeArtifactPath } from './runtime-artifact-registry.js';
import { loadConfig } from './config.js';
import { LATTICE_STORY_DIR, LEGACY_DOCS_STORY_DIR } from './lattice-paths.js';

export const GIT_TREE_OUTPUT_MAX_BUFFER = 32 * 1024 * 1024;

// B-d243 (host-2 soundness fix): the value currentStoryFilesHash returns for an
// EMPTY story-owned diff (HEAD == main, or the story already resolved on main).
// `changedStoryFilesBetween` then yields zero entries, so the hash is
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

export interface EvidenceHashSnapshot {
  schemaVersion: 'lattice.evidence_hash_snapshot.v1';
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

const DEFAULT_STORY_METADATA_PREFIXES = [
  `${LATTICE_STORY_DIR.replace(/\/actives$/, '')}/`,
  `${LEGACY_DOCS_STORY_DIR.replace(/\/actives$/, '')}/`,
  'docs/framework-audit/',
];

export function isStoryMetadataPath(path: string, projectRoot?: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const prefixes = [...DEFAULT_STORY_METADATA_PREFIXES];
  if (projectRoot) {
    try {
      const cfg = loadConfig(projectRoot);
      const storyDir = cfg.storyDir?.replace(/\\/g, '/').toLowerCase();
      if (storyDir) {
        const storyDirPrefix = storyDir.endsWith('/') ? storyDir : storyDir + '/';
        if (!prefixes.some(p => p === storyDirPrefix || storyDirPrefix.startsWith(p))) {
          prefixes.push(storyDirPrefix);
        }
      }
    } catch {
      // config load failure → fall back to defaults
    }
  }
  return prefixes.some(prefix => normalized.startsWith(prefix));
}

export function isMaterialExcludedPath(path: string, projectRoot?: string): boolean {
  return isStoryMetadataPath(path, projectRoot) || isMaterialExcludedRuntimeArtifactPath(path);
}

/**
 * B-6666 CHK-002: the parameter IS the resolved git invocation cwd
 * (wrapper-root aware), not a bare metadataRoot. Callers thread
 * `resolveGitCwd(...)` here; plain repos pass projectRoot==gitCwd so behavior is
 * byte-identical. On a wrapper-root layout (metadataRoot != gitRoot) a bare
 * metadataRoot is not a git repo, so `git rev-parse HEAD` from it returns
 * undefined — passing the resolved gitCwd is what makes the probe return a
 * defined hash.
 */
export function currentGitHead(gitCwd: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: gitCwd,
      ...GIT_EXEC_OPTS,
    }).trim();
  } catch {
    return undefined;
  }
}

function gitCommitAtRef(gitCwd: string, ref: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', ref], {
      cwd: gitCwd,
      ...GIT_EXEC_OPTS,
    }).trim();
  } catch {
    return undefined;
  }
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
    const raw = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: gitCwd,
      ...GIT_EXEC_OPTS,
    }).trim();
    if (!raw) return { files: [] };
    const dirty = new Set<string>();
    for (const line of raw.split('\n')) {
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
    schemaVersion: 'lattice.evidence_hash_snapshot.v1',
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

  if (snapshot.schemaVersion !== 'lattice.evidence_hash_snapshot.v1') {
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
 * Rename-aware variant of changedFilesBetween. Uses `git diff --name-status -M`
 * so a rename (R100 old new) surfaces BOTH the old and the new path rather than
 * being collapsed into a single name-only line that may hide one side. This is a
 * strictly stronger signal than the name-only variant (it never reports fewer
 * paths), which is why the incremental-context helper relies on it: a reviewer
 * whose file was renamed since its last pass must still see scopeChanged=true.
 *
 * Output is a de-duplicated, sorted list of paths. Status prefixes (M/A/D/R###/
 * C###) are parsed out; for rename (R) and copy (C) records both the source and
 * destination columns are emitted.
 */
export function changedFilesBetweenRenameAware(gitCwd: string, fromHead: string, toHead = 'HEAD'): string[] {
  // B-6666 CHK-002: gitCwd is the resolved git invocation cwd (wrapper-root
  // aware). Callers thread resolveGitCwd(...); plain repos pass
  // projectRoot==gitCwd so behavior is byte-identical.
  const raw = execFileSync('git', ['diff', '--name-status', '-M', `${fromHead}..${toHead}`], {
    cwd: gitCwd,
    ...GIT_EXEC_OPTS,
  }).trim();
  const paths = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Columns are tab-separated: <status>\t<path> or <Rxxx>\t<old>\t<new>.
    const cols = trimmed.split('\t').map(c => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const status = cols[0];
    if ((status.startsWith('R') || status.startsWith('C')) && cols.length >= 3) {
      // rename/copy: old path = cols[1], new path = cols[2]; both are material changes.
      paths.add(cols[1]);
      paths.add(cols[2]);
    } else {
      // M/A/D/T/U: the changed path is the last column.
      paths.add(cols[cols.length - 1]);
    }
  }
  return [...paths].sort();
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

function changedStoryFilesBetween(gitCwd: string, fromHead: string, toHead = 'HEAD'): Array<{ path: string; deleted: boolean }> {
  const raw = execFileSync('git', ['diff', '--name-status', '-M', `${fromHead}..${toHead}`], {
    cwd: gitCwd,
    ...GIT_EXEC_OPTS,
  }).trim();
  const files = new Map<string, { path: string; deleted: boolean }>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split('\t').map(c => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const status = cols[0];
    const add = (path: string, deleted: boolean) => {
      const existing = files.get(path);
      files.set(path, { path, deleted: existing ? existing.deleted && deleted : deleted });
    };
    if ((status.startsWith('R') || status.startsWith('C')) && cols.length >= 3) {
      add(cols[1], true);
      add(cols[2], status.startsWith('D'));
    } else {
      add(cols[cols.length - 1], status.startsWith('D'));
    }
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function objectIdAtRef(gitCwd: string, ref: string, filePath: string): string | undefined {
  try {
    const raw = execFileSync('git', ['ls-tree', '-z', ref, '--', filePath], {
      cwd: gitCwd,
      ...GIT_EXEC_OPTS,
    });
    const first = raw.split('\0').find(Boolean);
    if (!first) return undefined;
    const tab = first.indexOf('\t');
    const meta = tab >= 0 ? first.slice(0, tab) : first;
    return meta.trim().split(/\s+/)[2] || undefined;
  } catch {
    return undefined;
  }
}

export function currentStoryFilesHash(gitCwd: string, ref = 'HEAD', metadataRoot: string = gitCwd): string | undefined {
  try {
    const base = mergeBaseWithMain(gitCwd, ref);
    if (!base) return undefined;
    const entries = changedStoryFilesBetween(gitCwd, base, ref)
      .filter(entry => !isMaterialExcludedPath(entry.path, metadataRoot))
      .map((entry) => {
        const objectId = entry.deleted ? undefined : objectIdAtRef(gitCwd, ref, entry.path);
        return `${entry.path}\0${objectId || '<deleted>'}`;
      })
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
// isStoryMetadataPath -> loadConfig). The lattice.config.json that declares a
// CUSTOM storyDir lives at the metadataRoot, not the gitCwd; on a wrapper-root
// layout (metadataRoot != gitRoot) with a non-default storyDir, loading config
// from gitCwd silently misses the custom storyDir and WRONGLY includes the
// story-metadata paths in the material hash. metadataRoot defaults to gitCwd so
// plain repos (metadataRoot==gitCwd) and every existing positional caller stay
// byte-identical.
export function currentMaterialHash(gitCwd: string, ref = 'HEAD', metadataRoot: string = gitCwd): string | undefined {
  try {
    const raw = execFileSync('git', ['ls-tree', '-r', '-z', ref], {
      cwd: gitCwd,
      ...GIT_EXEC_OPTS,
    });
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
): EvidenceFreshness {
  if (!evidenceHash) {
    return {
      fresh: true,
      reason: 'evidence has no headHash (legacy format, skipping freshness check)',
      changedFiles: [],
      materialFiles: [],
    };
  }

  const currentHead = currentGitHead(gitCwd);
  if (!currentHead) {
    return {
      fresh: true,
      reason: 'Unable to get git HEAD, skipping freshness check',
      changedFiles: [],
      materialFiles: [],
    };
  }

  if (evidenceMaterialHash) {
    const materialHash = currentMaterialHash(gitCwd, 'HEAD', metadataRoot);
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
        const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', metadataRoot);
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
    const changedFiles = changedFilesBetween(gitCwd, evidenceHash, 'HEAD');
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
