import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { isMaterialExcludedRuntimeArtifactPath } from './runtime-artifact-registry.js';
import { loadConfig } from './config.js';
import { LATTICE_STORY_DIR, LEGACY_DOCS_STORY_DIR } from './lattice-paths.js';

export type EvidenceFreshness = {
  fresh: boolean;
  reason: string;
  currentHead?: string;
  changedFiles: string[];
  materialFiles: string[];
};

function headMatches(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

const DEFAULT_STORY_METADATA_PREFIXES = [
  `${LATTICE_STORY_DIR.replace(/\/actives$/, '')}/`,
  `${LEGACY_DOCS_STORY_DIR.replace(/\/actives$/, '')}/`,
  'docs/koala/framework-audit/',
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
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

// B-6666 CHK-002: gitCwd is the resolved git invocation cwd (wrapper-root
// aware). Callers thread resolveGitCwd(...); plain repos pass projectRoot==gitCwd
// so behavior is byte-identical.
export function changedFilesBetween(gitCwd: string, fromHead: string, toHead = 'HEAD'): string[] {
  const raw = execFileSync('git', ['diff', '--name-only', `${fromHead}..${toHead}`], {
    cwd: gitCwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
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
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
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
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
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
          changedFiles: [],
          materialFiles: [],
        };
      }
      return {
        fresh: false,
        reason: `evidence materialHash does not match current entity file state`,
        currentHead,
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
