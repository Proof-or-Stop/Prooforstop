import { createHash, type Hash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
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
 * What the identity bounds: the bytes on disk at the observation points (plan
 * and command boundaries for routine plans, receipt boundaries for DONE-required
 * runs). What it does not bound: a command that rewrites an artifact tree and
 * restores it inside its own window, the same limit the executor's
 * sourceProvenance head/clean observations accept. Closing that window needs
 * OS-enforced write denial on the trees for every non-build command and its
 * descendants, which is a platform policy rather than an observation.
 *
 * The digest covers the same files as the distDigest of
 * scripts/full-suite-build-binding.mjs (relative path plus bytes, the binding
 * manifest itself excluded) but frames every field by its byte length under a
 * versioned domain string, so two different trees cannot share an identity
 * through NUL bytes inside a file (a single file holding `X\0b.js\0Y` is not
 * the pair `a.js=X, b.js=Y`). The two digests are therefore not comparable.
 */
export const BUILD_ARTIFACT_ROOTS = ['packages/main/dist', 'packages/utils/dist'] as const;

/** Versioned domain of the digest; bump it whenever the framing below changes. */
const DIGEST_DOMAIN = 'proof-or-stop.build-artifacts-identity.v2';

/**
 * Unambiguous framing: every field is preceded by its byte length, so the
 * concatenation of fields parses one way only, whatever bytes a field holds.
 */
function frame(hash: Hash, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  hash.update(String(bytes.length)).update(':').update(bytes).update(';');
}

/** Written by the build scripts inside each dist tree; it changes on every write, so it never folds into the tree digest. */
const BUILD_BINDING_BASENAME = 'full-suite-build-binding.json';

/**
 * A symbolic link anywhere in an artifact tree makes the digest meaningless:
 * its target can change without any byte below the root changing, so the
 * identity is refused rather than silently narrowed to the link's own bytes.
 */
class BuildArtifactsIdentityUnavailable extends Error {
  constructor(readonly path: string, reason = 'symbolic link') {
    super(`build artifacts identity unavailable: ${reason} at ${path}`);
  }
}

function filesBelow(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new BuildArtifactsIdentityUnavailable(path);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        // A regular file with more than one link has an alias outside this
        // tree through which its bytes stay writable whatever protection the
        // tree itself is under; such a tree is not one this process can vouch for.
        if (lstatSync(path).nlink > 1) throw new BuildArtifactsIdentityUnavailable(path, 'hard-linked file');
        result.push(path);
      }
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
  } catch (error) {
    // Only a confirmed missing root is `absent`. Any other observation failure
    // (EACCES, EIO, ...) means this process cannot inspect the tree at all;
    // that is unavailable, never a valid identity.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent';
    throw new BuildArtifactsIdentityUnavailable(root);
  }
  if (stat.isSymbolicLink()) throw new BuildArtifactsIdentityUnavailable(root);
  if (!stat.isDirectory()) return 'absent';
  const hash = createHash('sha256');
  frame(hash, `${DIGEST_DOMAIN}/tree`);
  const files = filesBelow(root).filter((path) => relative(root, path) !== BUILD_BINDING_BASENAME);
  frame(hash, String(files.length));
  for (const path of files) {
    frame(hash, relative(root, path));
    frame(hash, readFileSync(path));
  }
  return hash.digest('hex');
}

/**
 * Repo-relative logical cwd of a command: `.` for the project root, otherwise a
 * `/`-separated path. A relative cwd is resolved in the project root's own path
 * space (so `./packages/../packages/main` is `packages/main`); an absolute cwd
 * is canonicalised through the filesystem together with the root, so a
 * symlinked checkout still resolves to the same logical location. Shared by the
 * plan-time build recogniser and the DONE-required receipt recogniser so the
 * two can never classify one command differently.
 */
export function logicalCommandCwd(projectRoot: string, cwd?: string): string {
  const root = resolve(projectRoot);
  const raw = (cwd ?? '').trim();
  if (!raw) return '.';
  let rel: string;
  if (isAbsolute(raw)) {
    const canonical = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
    rel = relative(canonical(root), canonical(raw));
  } else {
    rel = relative(root, resolve(root, raw));
  }
  rel = rel.replace(/\\/g, '/').replace(/\/+$/, '');
  return rel === '' ? '.' : rel;
}

/**
 * The registered packages/main build shapes a validation plan may contain.
 * These are the only commands allowed to change the build identity during a
 * plan and the only ones launched without artifact write protection. Pass the
 * project root so the cwd is judged logically; without one, a relative cwd is
 * still normalised but an absolute one can only be compared as written. A
 * relative cwd is where the launcher resolves it (the project root); its
 * logical location is judged against the ARTIFACT root, which on a wrapper-root
 * layout (metadata root with a configured git root beneath it) is that git
 * root, so `repo/packages/main` under the wrapper is `packages/main` there.
 */
export function isRegisteredPackagesMainBuildCommand(command: {
  command: string;
  args?: readonly string[];
  cwd?: string;
  shell?: boolean;
  providesBuildProof?: unknown;
  proof?: unknown;
}, projectRoot?: string, artifactsRoot: string | undefined = projectRoot): boolean {
  if (command.providesBuildProof === 'packages-main-build' || command.proof === 'packages-main-build') return true;
  // Recognition by shape exempts a command from write protection, so only a
  // COMPLETE, unambiguous build invocation qualifies: never a shell command
  // line (`npm run build && node swap.js` is one string to the shell), and
  // never an invocation with anything appended to the build arguments.
  if (command.shell === true) return false;
  const args = Array.isArray(command.args) ? command.args : [];
  const raw = (command.cwd ?? '').replace(/\\/g, '/');
  const cwd = projectRoot
    ? logicalCommandCwd(artifactsRoot ?? projectRoot, isAbsolute(raw) ? raw : resolve(projectRoot, raw || '.'))
    : (isAbsolute(raw) ? raw.replace(/\/+$/, '') : (posix.normalize(raw || '.').replace(/\/+$/, '') || '.'));
  const atRoot = cwd === '.';
  const atPackagesMain = cwd === 'packages/main';
  const exactly = (expected: readonly string[]): boolean => args.length === expected.length && expected.every((value, index) => args[index] === value);
  if (command.command === 'npm' && atRoot) return exactly(['--prefix', 'packages/main', 'run', 'build']);
  if (command.command === 'npm' && atPackagesMain) return exactly(['run', 'build']);
  if ((command.command === 'tsc' || command.command.endsWith('/tsc')) && atPackagesMain) return exactly([]) || exactly(['-b']) || exactly(['--build']);
  return false;
}

/** One plan of a sequence: its own plan-level binding, as the executor stamped it. */
export interface SequencedBuildArtifactsMember {
  provider?: string;
  commands?: readonly unknown[];
  buildArtifactsHash?: string;
  buildArtifacts?: { root?: string; start?: string; end?: string };
  /** Protection label the member's non-build commands ran under, as the executor stamped it. */
  buildArtifactsProtection?: string;
}

/**
 * Binding of several plans that ran one after another against the same
 * artifact trees: a dynamic build wave followed by its selected plans, or the
 * shards of one command. Each member is bound by its own plan-level rules; the
 * sequence binds only when every non-empty member is bound, each member
 * started on exactly the bytes the previous one left behind, every member's
 * own binding is the identity the sequence ends on (so no member executed
 * bytes the sequence does not bind) and all members digested the same root.
 * A member with no commands and no binding (an empty selected plan)
 * contributes nothing, so the build wave's validated binding stays in force.
 * Failures are reported, never silently dropped: a sequence that cannot bind
 * has no identity, and its consumers refuse publication.
 */
export function combineSequencedBuildArtifactsBindings(members: readonly SequencedBuildArtifactsMember[]): {
  buildArtifactsHash?: string;
  buildArtifacts?: { root?: string; start?: string; end?: string };
  /** Weakest protection label among the members; absent when no member recorded one. */
  buildArtifactsProtection?: string;
  failures: string[];
} {
  const failures: string[] = [];
  const active = members.filter((member) => (member.commands?.length ?? 0) > 0 || member.buildArtifactsHash || member.buildArtifacts?.start || member.buildArtifacts?.end);
  if (active.length === 0) return { failures };
  const label = (member: SequencedBuildArtifactsMember, index: number): string => member.provider || `plan ${index}`;
  for (let i = 0; i < active.length; i++) {
    const member = active[i];
    if (!member.buildArtifactsHash || !member.buildArtifacts?.start || !member.buildArtifacts?.end) {
      failures.push(`${label(member, i)}: carries no build binding of its own [build_artifacts_member_unbound]`);
      continue;
    }
    if (i === 0) continue;
    const previous = active[i - 1];
    if (previous.buildArtifacts?.end && member.buildArtifacts.start !== previous.buildArtifacts.end) {
      failures.push(`${label(member, i)}: started on compiled artifacts that differ from what ${label(previous, i - 1)} left behind [build_artifacts_changed_between_plans]`);
    }
    if (previous.buildArtifacts?.root && member.buildArtifacts.root && previous.buildArtifacts.root !== member.buildArtifacts.root) {
      failures.push(`${label(member, i)}: digested a different artifact root than ${label(previous, i - 1)} [build_artifacts_root_mismatch]`);
    }
  }
  if (failures.length > 0) return { failures };
  const first = active[0];
  const last = active[active.length - 1];
  const final = last.buildArtifactsHash as string;
  for (let i = 0; i < active.length; i++) {
    if (active[i].buildArtifactsHash !== final) {
      failures.push(`${label(active[i], i)}: executed bytes that differ from the artifacts the sequence ended on [build_artifacts_member_not_bound_to_final_build]`);
    }
  }
  if (failures.length > 0) return { failures };
  // The sequence ran under the weakest protection any member ran under: one
  // unenforced member makes the whole sequence observation-only.
  const labels = active.map((member) => member.buildArtifactsProtection).filter((value): value is string => typeof value === 'string' && value.length > 0);
  const protection = labels.find((value) => !(value.startsWith('enforced:') || value === 'not-applicable:no-artifact-trees')) ?? labels[0];
  return {
    buildArtifactsHash: final,
    buildArtifacts: {
      ...(first.buildArtifacts?.root ? { root: first.buildArtifacts.root } : {}),
      start: first.buildArtifacts?.start as string,
      end: last.buildArtifacts?.end as string,
    },
    ...(protection ? { buildArtifactsProtection: protection } : {}),
    failures,
  };
}

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

/**
 * Digest of every build artifact root under `projectRoot` (the git cwd whose
 * dist the commands execute, so a Story worktree binds its own build). An
 * absent root contributes a stable `absent` marker: a fixture or a repository
 * without a compiled tree still binds deterministically, and a tree that later
 * appears or disappears changes the digest. Only an unreadable tree yields
 * `undefined`, which every consumer treats as "cannot vouch" and refuses.
 * Memoized per synchronous git observation like the committed-tree digests.
 */
export function currentBuildArtifactsHash(projectRoot: string): string | undefined {
  const root = resolve(projectRoot);
  return readObservedGitState(gitObservationKey(['build-artifacts-hash', root, BUILD_ARTIFACT_ROOTS]), () => {
    try {
      const hash = createHash('sha256');
      frame(hash, `${DIGEST_DOMAIN}/roots`);
      frame(hash, String(BUILD_ARTIFACT_ROOTS.length));
      for (const relativeRoot of BUILD_ARTIFACT_ROOTS) {
        // A symbolic link anywhere between the project root and the tree
        // (`packages` or `packages/main`) re-targets the whole tree without
        // touching a byte inside it, and no protection of the resolved tree
        // covers the link itself; such a layout is not one this process can
        // vouch for. The project root itself may be reached through links
        // (a temporary directory often is) and is not judged.
        let ancestor = root;
        for (const component of relativeRoot.split('/').slice(0, -1)) {
          ancestor = join(ancestor, component);
          let stat;
          try { stat = lstatSync(ancestor); } catch (error) {
            const code = (error as NodeJS.ErrnoException | null)?.code;
            if (code === 'ENOENT' || code === 'ENOTDIR') { stat = undefined; break; }
            throw new BuildArtifactsIdentityUnavailable(ancestor, 'uninspectable ancestor');
          }
          if (stat.isSymbolicLink()) throw new BuildArtifactsIdentityUnavailable(ancestor, 'symbolic link on the path to the artifact tree');
        }
        frame(hash, relativeRoot);
        frame(hash, artifactTreeDigest(join(root, relativeRoot)));
      }
      return hash.digest('hex');
    } catch {
      return undefined;
    }
  });
}
