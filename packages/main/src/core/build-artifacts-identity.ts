import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gitObservationKey, readObservedGitState } from './git-tree-observation.js';

/**
 * Content identity of the compiled artifacts that validation commands execute.
 *
 * headHash, materialHash and storyFilesHash are all derived from the COMMITTED
 * tree. The registered validation commands run `packages/main/dist` and
 * `packages/utils/dist`, which are gitignored, so none of those digests can see
 * a rebuilt, partial or stale dist. Two validations could therefore share a
 * byte-identical evidence binding while executing different compiled code, and a
 * PASS produced against one dist stayed reusable and admissible after dist
 * changed. This digest closes that gap: evidence writers record it, and the
 * reuse, admissibility and DONE-required freshness consumers refuse evidence
 * whose recorded build no longer matches the artifacts on disk.
 *
 * The per-root digest mirrors scripts/full-suite-build-binding.mjs (relative
 * path plus bytes, the binding manifest itself excluded), so it changes exactly
 * when that manifest's distDigest would.
 */
export const BUILD_ARTIFACT_ROOTS = ['packages/main/dist', 'packages/utils/dist'] as const;

/** Written by the build scripts inside each dist tree; it changes on every write, so it never folds into the tree digest. */
const BUILD_BINDING_BASENAME = 'full-suite-build-binding.json';

/**
 * A symbolic link anywhere in an artifact tree makes the digest meaningless:
 * its target can change without any byte below the root changing, so the
 * identity is refused rather than silently narrowed to the link's own bytes.
 */
class BuildArtifactsIdentityUnavailable extends Error {
  constructor(readonly path: string) {
    super(`build artifacts identity unavailable: symbolic link at ${path}`);
  }
}

function filesBelow(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new BuildArtifactsIdentityUnavailable(path);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result.push(path);
      else throw new BuildArtifactsIdentityUnavailable(path);
    }
  };
  visit(root);
  return result.sort();
}

/**
 * sha256 over (relative path, bytes) of every regular file below `root`, or
 * `absent` when the root does not exist. A root that is itself a symbolic link
 * is not a tree this process can vouch for and throws.
 */
function artifactTreeDigest(root: string): string {
  let stat;
  try {
    stat = lstatSync(root);
  } catch {
    return 'absent';
  }
  if (stat.isSymbolicLink()) throw new BuildArtifactsIdentityUnavailable(root);
  if (!stat.isDirectory()) return 'absent';
  const hash = createHash('sha256');
  for (const path of filesBelow(root)) {
    const rel = relative(root, path);
    if (rel === BUILD_BINDING_BASENAME) continue;
    hash.update(rel).update('\0').update(readFileSync(path)).update('\0');
  }
  return hash.digest('hex');
}

/**
 * Digest of every build artifact root under `projectRoot` (the git cwd whose
 * dist the commands execute, so a Story worktree binds its own build). An
 * absent root contributes a stable `absent` marker: a fixture or a repository
 * without a compiled tree still binds deterministically, and a tree that later
 * appears or disappears changes the digest. Only an unreadable tree yields
 * `undefined`, which every consumer treats as "cannot vouch" and refuses.
 * Memoized per synchronous git observation like the committed-tree digests.
 */
/**
 * Binding for a PASS that is republished without executing anything. The
 * republished record must carry the identity the authenticated prior record
 * was earned against; it never adopts the dist on disk. Publication may only
 * proceed while the dist on disk still equals that prior identity.
 */
export function resolveReusedBuildArtifactsBinding(args: {
  prior: string | undefined;
  current: string | undefined;
}): { ok: true; buildArtifactsHash: string } | { ok: false; reason: string } {
  if (!args.prior) return { ok: false, reason: 'prior evidence has no buildArtifactsHash binding [build_artifacts_unbound]' };
  if (!args.current) return { ok: false, reason: 'current build artifacts identity is unavailable [build_artifacts_unavailable]' };
  if (args.prior !== args.current) return { ok: false, reason: 'build artifacts changed since the reused PASS was earned [build_artifacts_mismatch]' };
  return { ok: true, buildArtifactsHash: args.prior };
}

export function currentBuildArtifactsHash(projectRoot: string): string | undefined {
  const root = resolve(projectRoot);
  return readObservedGitState(gitObservationKey(['build-artifacts-hash', root, BUILD_ARTIFACT_ROOTS]), () => {
    try {
      const hash = createHash('sha256');
      for (const relativeRoot of BUILD_ARTIFACT_ROOTS) {
        hash.update(relativeRoot).update('\0').update(artifactTreeDigest(join(root, relativeRoot))).update('\0');
      }
      return hash.digest('hex');
    } catch {
      return undefined;
    }
  });
}
