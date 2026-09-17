import { execFileSync } from 'node:child_process';
import { isMaterialExcludedPath } from './material-path-policy.js';

/**
 * Shared git-exec buffer, mirroring evidence-freshness.ts GIT_EXEC_OPTS. Node's
 * default execFileSync maxBuffer is 1 MiB; a large main-sync net diff can exceed
 * that, so without this the call would throw ENOBUFS (see B-f492).
 */
const GIT_LINEAGE_MAXBUFFER = 1024 * 1024 * 1024;

/**
 * Files whose CONTENT differs between two endpoint commits, computed as a NET
 * tree diff (`git diff-tree <evidenceHead> <currentHead>`), NOT a per-commit
 * `-m` union. A merge commit that re-touches a content-unchanged file therefore
 * does not appear here; a genuinely content-changed file does. `-z` avoids
 * git-quoting pathnames that contain spaces or non-ASCII bytes.
 */
export function netDiffChangedPaths(evidenceHead: string, currentHead: string, gitCwd: string): string[] {
  const out = execFileSync(
    'git',
    ['diff-tree', '-r', '--no-commit-id', '--name-only', '--no-renames', '-z', evidenceHead, currentHead],
    { cwd: gitCwd, encoding: 'utf8', maxBuffer: GIT_LINEAGE_MAXBUFFER },
  );
  return out.split('\0').map(path => path.trim()).filter(Boolean);
}

export type MergeLineageClassification =
  | { kind: 'exact-head' }
  | { kind: 'trusted-descendant' }
  | { kind: 'untrusted'; untrustedPaths: string[] }
  | { kind: 'not-ancestor' }
  | { kind: 'diff-failed'; error: string };

/**
 * Canonical merge-lineage classifier shared by validation-evidence-reuse.ts and
 * validation-evidence-admissibility.ts so the two can never diverge (they were
 * previously byte-equivalent copies of a per-commit `-m` union that flagged a
 * story's own content-unchanged files as untrusted after a main-merge).
 *
 * An empty net diff means the endpoint trees are byte-identical, which is
 * strictly safer than a metadata-only change, so it classifies as trusted.
 * Trust uses the SAME path policy as materialHash (isMaterialExcludedPath: story
 * metadata, evidence output locations, registry-declared runtime artifacts such
 * as dev-memory records). A path materialHash ignores cannot change what a
 * validation executed, so refusing it here only forced identical re-execution
 * while materialHash stayed equal. Any content-changed material path classifies
 * as untrusted.
 * The ancestry check and the net-diff computation are caught separately so a
 * diff failure is never mislabeled as a non-ancestor.
 */
export function classifyMergeLineage(
  args: {
    evidenceHead: string;
    currentHead: string;
    gitCwd: string;
    metadataRoot: string;
  },
  // Injected only so the diff-failure branch (ancestry OK, diff throws) can be
  // exercised at runtime by tests; production callers use the default.
  changedPathsFn: (evidenceHead: string, currentHead: string, gitCwd: string) => string[] = netDiffChangedPaths,
): MergeLineageClassification {
  if (args.evidenceHead === args.currentHead) return { kind: 'exact-head' };
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', args.evidenceHead, args.currentHead], {
      cwd: args.gitCwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    return { kind: 'not-ancestor' };
  }
  let changed: string[];
  try {
    changed = changedPathsFn(args.evidenceHead, args.currentHead, args.gitCwd);
  } catch (error) {
    return { kind: 'diff-failed', error: error instanceof Error ? error.message : String(error) };
  }
  const untrustedPaths = changed.filter(path => !isMaterialExcludedPath(path, args.metadataRoot));
  if (untrustedPaths.length > 0) return { kind: 'untrusted', untrustedPaths };
  return { kind: 'trusted-descendant' };
}
