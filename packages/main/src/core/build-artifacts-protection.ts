import { accessSync, constants, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { BUILD_ARTIFACT_ROOTS, projectHasArtifactContract } from './build-artifacts-identity.js';

/**
 * Write protection for the compiled artifacts while a validation command runs.
 *
 * Observing the artifact identity at a command's boundaries proves what the
 * bytes were when it started and ended, and nothing about what it executed in
 * between: a command can install a different build, test against it, and put
 * the original back before it returns, so both observations agree and the
 * evidence records a build the test never ran. The only way to close that is
 * to stop the write from happening at all, for the command AND every process
 * it spawns.
 *
 * A mechanism is never assumed to work: before it is trusted it is self-tested
 * on this host against this artifact root, by attempting the very write it
 * must deny under the same wrapper, and it is reported as enforced only when
 * that write was refused. That is what makes the label authenticated rather
 * than declared, and it is how a mechanism this code cannot be run against
 * here (Linux `bwrap`) is trusted only where it demonstrably works.
 *
 * The wrapper is itself part of what is trusted, so it is held to the same
 * standard as the trees it protects: it must be an executable this user
 * cannot replace (neither the file nor any directory on its path is writable
 * by this process, see wrapperReplaceableBy); its identity (path, inode,
 * size, mtime, owner, mode and content digest) is bound when it passes the
 * self-test and re-verified before every launch (verify); and each self-test
 * probe must leave an execution witness that only a probe the wrapper really
 * ran can leave, so a wrapper's exit status alone never earns enforcement.
 * What this does not cover: the wrapper's dynamically linked libraries and
 * the environment this process inherits (`LD_PRELOAD` and its relatives) are
 * assumed to belong to the same domain as the executable and are not
 * enumerated here.
 *
 * What this does NOT establish, on any platform: that a command executed the
 * protected bytes. A command denied writes here can still copy the artifacts
 * elsewhere, alter the copy and execute that, leaving these trees untouched.
 * Protection removes the in-place swap; it is not proof of what ran.
 */
export interface ArtifactWriteProtection {
  /** True only when a mechanism actually denied the self-test write on this host. */
  enforced: boolean;
  /**
   * Recorded on results, receipts and evidence:
   * `enforced:<mechanism>` or `unenforced:<reason>` (`registered-build:writes-permitted` on a build command).
   */
  label: string;
  /**
   * Rewrites a launch so the child and its descendants cannot write the
   * artifact roots. An enforcing wrapper re-verifies the wrapper executable's
   * bound identity first and throws `[artifact_protection_wrapper_drift]`
   * rather than launch through an executable other than the one it self-tested.
   */
  wrap(launch: { command: string; args: readonly string[]; shell: boolean }): { command: string; args: string[]; shell: boolean };
  /**
   * Re-checks, against the filesystem now, that the wrapper this resolution
   * self-tested is still the executable a launch would run: same canonical
   * path, inode, size, mtime, owner, mode and content digest. Returns the
   * discrepancy, or undefined while the binding holds. Absent on a
   * resolution that launches nothing through a wrapper.
   */
  verify?: () => string | undefined;
  /** The wrapper identity an enforcing resolution is bound to (absent otherwise). */
  wrapper?: WrapperIdentity;
}

/** Identity of the wrapper executable a resolution self-tested; every field is re-compared before a launch. */
export interface WrapperIdentity {
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  uid: number;
  mode: number;
  digest: string;
}

/** A command the plan permits to write the artifacts, so it is deliberately launched unprotected. */
export const REGISTERED_BUILD_PROTECTION_LABEL = 'registered-build:writes-permitted';

/**
 * Retired label. It was recorded when no mechanism existed and no artifact tree
 * existed either, on the theory that there was nothing to protect. That theory
 * was wrong for a command that executes: it can create a tree, execute it and
 * remove it before returning, and both boundary observations still read
 * "absent". The label is kept only so evidence that carries it stays readable;
 * it never satisfies the contract.
 */
export const NOT_APPLICABLE_PROTECTION_LABEL = 'not-applicable:no-artifact-trees';

/**
 * A project that DECLARES the compiled-artifact contract inapplicable
 * (`"artifactContract": "none"` in its tracked config) and has nothing at the
 * artifact roots' paths (see projectHasArtifactContract): nothing these roots
 * describe is executed, the identity records the same fact, and the label
 * satisfies the contract on the strength of that declaration — absence alone
 * never earns it. An entry or the layout marker appearing later makes the
 * resolution stale (artifactProtectionStale), after which the ordinary rules
 * apply.
 */
export const NO_CONTRACT_PROTECTION_LABEL = 'not-applicable:no-artifact-contract';

/**
 * Whether a recorded label satisfies the executed-build contract: the writes
 * were demonstrably denied on this host, by a mechanism that passed its
 * self-test, and nothing else. An `unenforced:` label, the retired
 * not-applicable label, a registered-build label on a non-build command, or a
 * missing label never satisfies it.
 */
export function artifactProtectionSatisfied(label: string | undefined): boolean {
  return typeof label === 'string' && (label.startsWith('enforced:') || label === BUILD_ONLY_PROTECTION_LABEL || label === NO_CONTRACT_PROTECTION_LABEL);
}

/**
 * A plan that executed registered builds and nothing else. No command ran
 * that the contract requires protection for, so the evidence is admissible
 * on its own terms: it proves that the build ran and what it produced, and a
 * PASS reused on unchanged artifacts asserts nothing about protected tests.
 * It never stands in for the tests' label where tests did run (see
 * weakestProtectionLabel).
 */
export const BUILD_ONLY_PROTECTION_LABEL = 'build-only:registered-builds-only';

/**
 * The label a set of labels collectively earns, weakest first: any label the
 * contract refuses, then a build-only label, then an enforced one. A plan or
 * run that mixes a build-only member with enforced tests is enforced; one that
 * mixes anything with an unenforced member is unenforced.
 */
export function weakestProtectionLabel(labels: readonly (string | undefined)[]): string | undefined {
  const present = labels.filter((label): label is string => typeof label === 'string' && label.length > 0);
  return present.find((label) => !artifactProtectionSatisfied(label))
    ?? present.find((label) => label.startsWith('enforced:'))
    ?? present.find((label) => label === BUILD_ONLY_PROTECTION_LABEL)
    ?? present[0];
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/** Exit status the self-test probe uses to report "the write was refused". */
const PROBE_DENIED_EXIT = 3;

/** Sandbox rules match fully resolved paths, so /var and /private/var are not interchangeable. */
function canonicalize(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length > 0 ? join(real, ...[...missing].reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

/**
 * The wrapper executable, as an ABSOLUTE canonical path. A relative PATH
 * entry (`tools`) resolves against this process's cwd here, and the same
 * path is then used for every launch whatever cwd the command declares;
 * returning the relative candidate would self-test one executable and launch
 * another from `<command cwd>/tools/bwrap`.
 */
export function resolveExecutableOnPath(name: string, searchPath: string = process.env.PATH ?? '', cwd: string = process.cwd()): string | undefined {
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue;
    const candidate = resolve(cwd, dir, name);
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch { /* next */ }
  }
  return undefined;
}

/**
 * Why this process's user could replace the wrapper at `path`, or undefined
 * when it cannot. A validation command runs as this user, so a wrapper it
 * could overwrite, or reach by renaming a directory on the wrapper's path, is
 * a wrapper it could substitute between two launches; such a wrapper is never
 * trusted, wherever PATH found it. The kernel answers for every component of
 * the canonical path up to and including the filesystem root (access(2)
 * W_OK). A process running as root passes that test everywhere and a root
 * command keeps the privileges to leave either sandbox, so root is refused
 * outright rather than judged by permission bits.
 */
export function wrapperReplaceableBy(path: string, uid: number | undefined = process.getuid?.()): string | undefined {
  if (uid === 0) return 'this process runs as root, which can replace any wrapper and leave any sandbox';
  let current = resolve(path);
  for (;;) {
    let writable = false;
    try { accessSync(current, constants.W_OK); writable = true; } catch { /* not writable by this user */ }
    if (writable) return `${current} is writable by this user`;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The identity of the wrapper executable as it is on disk now. */
export function readWrapperIdentity(path: string): WrapperIdentity {
  const stat = statSync(path);
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  return { path, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, uid: stat.uid, mode: stat.mode, digest };
}

/** What differs between the bound wrapper identity and the executable on disk now, or undefined. */
export function wrapperIdentityDrift(expected: WrapperIdentity): string | undefined {
  let current: WrapperIdentity;
  try { current = readWrapperIdentity(expected.path); } catch (error) {
    return `wrapper ${expected.path} can no longer be read: ${(error as Error).message}`;
  }
  const changed = (Object.keys(expected) as (keyof WrapperIdentity)[]).filter((key) => expected[key] !== current[key]);
  return changed.length === 0 ? undefined : `wrapper ${expected.path} changed since it was self-tested (${changed.join(', ')})`;
}

function unenforced(reason: string): ArtifactWriteProtection {
  return {
    enforced: false,
    label: `unenforced:${reason}`,
    wrap: (launch) => ({ command: launch.command, args: [...launch.args], shell: launch.shell }),
  };
}

type Mechanism = { name: 'sandbox-exec' | 'bwrap'; wrapper: WrapperIdentity; wrap: ArtifactWriteProtection['wrap'] };

type WrapperTrust = { unsafeTrustReplaceableWrapperForFixture?: boolean };

/**
 * Admit a wrapper executable into the trust domain, or say why not: it must
 * not be replaceable by this user (unless a FIXTURE explicitly waives that,
 * which production callers never do) and its identity must be readable so
 * every launch can be held to it.
 */
function trustWrapper(name: Mechanism['name'], path: string, trust: WrapperTrust): WrapperIdentity | string {
  if (!trust.unsafeTrustReplaceableWrapperForFixture) {
    const replaceable = wrapperReplaceableBy(path);
    if (replaceable) return `${name} wrapper ${path} could be replaced by a validation command (${replaceable}); only a wrapper this user cannot write, on a path this user cannot rename, is trusted`;
  }
  try { return readWrapperIdentity(path); } catch (error) {
    return `${name} wrapper ${path} cannot be bound by identity: ${(error as Error).message}`;
  }
}

/**
 * The macOS profile, pure so it can be checked without running it. Writes
 * beneath each tree are denied whether or not the tree exists yet (subpath
 * rules are path-based). That alone leaves the tree movable: a command could
 * rename `packages/main` aside, edit and execute `main.saved/dist` outside
 * the denied subpath, and put it back. So every ancestor of each tree, up to
 * but excluding the filesystem root, is also denied as a LITERAL: renaming,
 * unlinking or re-moding the ancestor itself is refused, while creating and
 * replacing entries beside it (a coverage directory, a report) stays allowed,
 * because those operations are checked against their own paths.
 */
export function sandboxExecProfile(denied: readonly string[]): string {
  const ancestors = new Set<string>();
  for (const path of denied) {
    let directory = dirname(path);
    while (dirname(directory) !== directory) { ancestors.add(directory); directory = dirname(directory); }
  }
  const subpaths = denied.map((path) => `(subpath ${quote(path)})`).join(' ');
  const literals = [...ancestors].sort().map((path) => `(literal ${quote(path)})`).join(' ');
  return `(version 1)(allow default)(deny file-write* ${subpaths} ${literals})`;
}

function sandboxExecMechanism(denied: string[], trust: WrapperTrust): Mechanism | string {
  let executable: string;
  try { accessSync(SANDBOX_EXEC, constants.X_OK); executable = realpathSync(SANDBOX_EXEC); } catch { return 'sandbox-exec is not executable on this host'; }
  const wrapper = trustWrapper('sandbox-exec', executable, trust);
  if (typeof wrapper === 'string') return wrapper;
  const profile = sandboxExecProfile(denied);
  return {
    name: 'sandbox-exec',
    wrapper,
    wrap: (launch) => (launch.shell
      // A shell launch is one command line; re-express it as an explicit shell
      // under the sandbox rather than letting the spawn layer build it, so the
      // sandbox is the parent of the shell and therefore of everything it runs.
      ? { command: executable, args: ['-p', profile, '/bin/sh', '-c', [launch.command, ...launch.args].join(' ')], shell: false }
      : { command: executable, args: ['-p', profile, launch.command, ...launch.args], shell: false }),
  };
}

/**
 * The bwrap arguments that precede the command, pure so they can be checked
 * without a Linux host. Order matters: the host filesystem first, then every
 * ancestor of each tree bind-mounted onto itself (writable; a mount point
 * cannot be renamed or removed from inside the namespace) — the filesystem
 * root excluded, since it is already the namespace root and re-binding it
 * would overlay everything mounted before — then the trees read-only, and
 * only THEN the private PID space and /proc, so nothing re-exposes the host's
 * /proc (whose /proc/<pid>/root aliases would reach the writable host mounts).
 */
export function bwrapLaunchPrefix(existingRoots: readonly string[]): string[] {
  const chain = new Set<string>();
  for (const root of existingRoots) {
    let directory = dirname(root);
    while (dirname(directory) !== directory) { chain.add(directory); directory = dirname(directory); }
  }
  const binds = [...chain].sort().flatMap((directory) => ['--bind', directory, directory]);
  for (const root of existingRoots) binds.push('--ro-bind', root, root);
  return ['--dev-bind', '/', '/', ...binds, '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--'];
}

function bwrapMechanism(existingRoots: string[], allRoots: string[], discovery: { searchPath?: string; cwd?: string } & WrapperTrust): Mechanism | string {
  const bwrap = resolveExecutableOnPath('bwrap', discovery.searchPath, discovery.cwd);
  if (!bwrap) return 'bwrap (bubblewrap) is not on PATH';
  // bwrap re-binds a tree read-only over itself, so it can only protect a tree
  // that exists. An absent root would stay creatable inside the namespace, and
  // a command could create, execute and remove artifacts there between two
  // observations of "absent"; that is not enforcement. Every configured root
  // must therefore exist before bwrap is reported as enforcing anything.
  const absent = allRoots.filter((root) => !existingRoots.includes(root));
  if (absent.length > 0) return `bwrap cannot protect the absent artifact root(s) ${absent.join(', ')}; every configured root must exist (a build creates them) before evidence can be authoritative`;
  const wrapper = trustWrapper('bwrap', bwrap, discovery);
  if (typeof wrapper === 'string') return wrapper;
  const prefix = bwrapLaunchPrefix(existingRoots);
  return {
    name: 'bwrap',
    wrapper,
    wrap: (launch) => (launch.shell
      ? { command: bwrap, args: [...prefix, '/bin/sh', '-c', [launch.command, ...launch.args].join(' ')], shell: false }
      : { command: bwrap, args: [...prefix, launch.command, ...launch.args], shell: false }),
  };
}

/**
 * One self-test probe: a script launched under the wrapper that first leaves
 * an execution witness (a fresh nonce written to a file only that run knows)
 * and then attempts the operation the mechanism must deny, reporting the
 * refusal as PROBE_DENIED_EXIT. The witness is what proves the wrapper ran
 * the probe at all: a wrapper that merely exits 3 leaves none.
 */
function runProbe(mechanism: Mechanism, witnessDir: string, body: string, target: string): { run: SpawnSyncReturns<string>; witnessed: boolean } {
  const nonce = randomBytes(16).toString('hex');
  const witness = join(witnessDir, `witness-${nonce}`);
  const script = `const fs = require('node:fs'); fs.writeFileSync(process.argv[2], process.argv[3]); ${body}`;
  const launch = mechanism.wrap({ command: process.execPath, args: ['-e', script, target, witness, nonce], shell: false });
  const run = spawnSync(launch.command, launch.args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  let witnessed = false;
  try { witnessed = readFileSync(witness, 'utf8') === nonce; } catch { witnessed = false; }
  try { rmSync(witness, { force: true }); } catch { /* the directory is removed as a whole */ }
  return { run, witnessed };
}

const RENAME_PROBE = `const a = process.argv[1]; try { fs.renameSync(a, a + '.proof-or-stop-rename-probe'); try { fs.renameSync(a + '.proof-or-stop-rename-probe', a); } catch {} process.exit(0); } catch (error) { process.exit(['EPERM','EACCES','EROFS','EBUSY','EXDEV'].includes(error && error.code) ? ${PROBE_DENIED_EXIT} : 4); }`;

/**
 * Attempt, under the wrapper, the exact write the mechanism must deny, on
 * EVERY configured root: a file inside a tree that exists, or the creation of
 * the tree itself where it does not. Enforced only when each probe left its
 * execution witness, reported the refusal AND nothing was written. Any other
 * outcome (the write succeeded, the wrapper itself failed to start, no
 * witness, an unexpected exit) is reported, never assumed away. An absent
 * root whose parent directory is also absent cannot be probed without first
 * creating that parent, which the mechanism does not deny; it is covered by
 * the same rule as its siblings but is reported as unprobed.
 */
function selfTest(mechanism: Mechanism, existingRoots: string[], allRoots: string[], projectRoot: string): string | undefined {
  let witnessDir: string;
  try { witnessDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-protection-witness-')); } catch (error) {
    return `${mechanism.name} self-test cannot create its witness directory: ${(error as Error).message}`;
  }
  try {
    for (const root of allRoots) {
      const existing = existingRoots.includes(root);
      if (!existing && !isDirectory(dirname(root))) continue;
      const target = existing ? join(root, `.proof-or-stop-write-probe-${process.pid}-${Date.now()}`) : root;
      const body = existing
        ? `try { fs.writeFileSync(process.argv[1], 'probe'); process.exit(0); } catch (error) { process.exit(['EPERM','EACCES','EROFS'].includes(error && error.code) ? ${PROBE_DENIED_EXIT} : 4); }`
        : `try { fs.mkdirSync(process.argv[1]); process.exit(0); } catch (error) { process.exit(['EPERM','EACCES','EROFS'].includes(error && error.code) ? ${PROBE_DENIED_EXIT} : 4); }`;
      const { run, witnessed } = runProbe(mechanism, witnessDir, body, target);
      // Only what the probe itself demonstrably created is removed: the uniquely
      // named probe file, or the root directory when the probe reported that it
      // created it — never recursively, and never a directory that exists for
      // any other reason (a build running elsewhere may have just created it).
      const written = existing ? existsSync(target) : run.status === 0 && isDirectory(target);
      if (written) { try { if (existing) rmSync(target, { force: true }); else rmdirSync(target); } catch { /* reported below */ } }
      if (run.error) return `${mechanism.name} self-test on ${root} could not start the wrapper: ${run.error.message}`;
      if (written) return `${mechanism.name} self-test on ${root} did not deny the write (exit ${run.status})`;
      if (!witnessed) return `${mechanism.name} self-test on ${root} left no execution witness (exit ${run.status}${run.signal ? `, signal ${run.signal}` : ''}); the wrapper did not demonstrably run the probe`;
      if (run.status !== PROBE_DENIED_EXIT) return `${mechanism.name} self-test on ${root} ended unexpectedly (exit ${run.status}${run.signal ? `, signal ${run.signal}` : ''}): ${(run.stderr || '').trim().split('\n')[0].slice(0, 160)}`;
      // Every mechanism must also deny moving the tree's parent aside (the
      // rename that would carry a mount away, or move the tree out from under a
      // path rule): probe it, and if the rename unexpectedly succeeds, put the
      // directory straight back.
      if (existing) {
        const ancestor = dirname(root);
        const rename = runProbe(mechanism, witnessDir, RENAME_PROBE, ancestor);
        if (rename.run.error) return `${mechanism.name} rename self-test on ${ancestor} could not start the wrapper: ${rename.run.error.message}`;
        if (!rename.witnessed) return `${mechanism.name} rename self-test on ${ancestor} left no execution witness (exit ${rename.run.status}); the wrapper did not demonstrably run the probe`;
        if (rename.run.status !== PROBE_DENIED_EXIT) return `${mechanism.name} self-test did not deny moving ${ancestor} aside (exit ${rename.run.status})`;
      }
    }
    // A mount-based mechanism must deny moving the PROJECT's own parent aside
    // as well (the relocation that would carry every protected mount away).
    if (mechanism.name === 'bwrap' && existingRoots.length > 0) {
      const parent = dirname(projectRoot);
      if (parent !== projectRoot) {
        const rename = runProbe(mechanism, witnessDir, RENAME_PROBE, parent);
        if (rename.run.error) return `${mechanism.name} rename self-test on ${parent} could not start the wrapper: ${rename.run.error.message}`;
        if (!rename.witnessed) return `${mechanism.name} rename self-test on ${parent} left no execution witness (exit ${rename.run.status}); the wrapper did not demonstrably run the probe`;
        if (rename.run.status !== PROBE_DENIED_EXIT) return `${mechanism.name} self-test did not deny moving the project's parent ${parent} aside (exit ${rename.run.status})`;
      }
    }
    // The wrapper that passed every probe must still be the one on disk; a
    // replacement during the self-test would otherwise be bound as trusted.
    return wrapperIdentityDrift(mechanism.wrapper);
  } finally {
    try { rmSync(witnessDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Whether any configured artifact root exists under this artifact root right
 * now, or the contract applies to the project whose configuration lives at
 * `configRoot` (the artifact root itself on a plain layout).
 */
export function hasAnyArtifactRoot(artifactsRoot: string, configRoot: string = artifactsRoot): boolean {
  const root = resolve(artifactsRoot);
  return projectHasArtifactContract(root, configRoot) || BUILD_ARTIFACT_ROOTS.some((relative) => isDirectory(canonicalize(join(root, relative))));
}

/**
 * Whether a protection resolved earlier in a run may no longer describe the
 * host: the wrapper it self-tested is no longer the executable on disk, a
 * registered build has run since (it may have created or replaced the
 * trees), or the resolution was `not-applicable` because no tree existed and a
 * tree exists now. The exemption for a project without artifact trees is valid
 * only while that absence holds; a plan that starts without `dist`, builds it,
 * and then tests must protect those tests. Callers re-resolve when this is true.
 */
export function artifactProtectionStale(
  protection: Pick<ArtifactWriteProtection, 'label'> & Partial<Pick<ArtifactWriteProtection, 'verify'>>,
  state: { buildRanSinceResolve: boolean; anyRootExists: boolean },
): boolean {
  if (protection.verify && protection.verify() !== undefined) return true;
  if (state.buildRanSinceResolve) return true;
  return (protection.label === NOT_APPLICABLE_PROTECTION_LABEL || protection.label === NO_CONTRACT_PROTECTION_LABEL) && state.anyRootExists;
}

/**
 * Resolve the protection available for this platform and artifact root. Every
 * artifact root is denied whether or not it exists yet where the mechanism can
 * express that, so a command cannot create a tree that a later observation
 * would count; a mechanism that cannot express it for an absent root is not
 * reported as enforcing. Where no mechanism exists on this host the result is
 * `unenforced` whether or not the trees exist: an absent tree is not "nothing
 * to protect", because a command can create it, execute it and remove it
 * inside its own window. The consumers of that label refuse to treat the
 * evidence as authoritative, and the DONE-required writer refuses to launch.
 *
 * `configRoot` is where the project's configuration (and so its
 * `artifactContract` declaration) lives: the artifact root itself on a plain
 * layout, the wrapper metadata root on a wrapper-root layout whose
 * `gitRoot` subdirectory holds the artifacts.
 */
export function resolveArtifactWriteProtection(
  artifactsRoot: string,
  options: {
    configRoot?: string;
    /** TEST SEAM: the platform to resolve for and where to discover its wrapper. Production callers omit it. */
    platform?: NodeJS.Platform;
    searchPath?: string;
    cwd?: string;
    /**
     * TEST SEAM: admit a wrapper this user could replace, so a fixture wrapper
     * in a temporary directory can exercise the self-test. Production callers
     * never set it; a replaceable wrapper is otherwise refused before any probe.
     */
    unsafeTrustReplaceableWrapperForFixture?: boolean;
  } = {},
): ArtifactWriteProtection {
  const root = resolve(artifactsRoot);
  const configRoot = options.configRoot ?? root;
  if (!projectHasArtifactContract(root, configRoot)) {
    return { enforced: false, label: NO_CONTRACT_PROTECTION_LABEL, wrap: (launch) => ({ command: launch.command, args: [...launch.args], shell: launch.shell }) };
  }
  const allRoots = BUILD_ARTIFACT_ROOTS.map((relative) => canonicalize(join(root, relative)));
  const existingRoots = allRoots.filter((path) => isDirectory(path));
  const platform = options.platform ?? process.platform;
  const trust: WrapperTrust = { unsafeTrustReplaceableWrapperForFixture: options.unsafeTrustReplaceableWrapperForFixture };
  let mechanism: Mechanism | string;
  if (platform === 'darwin') mechanism = sandboxExecMechanism(allRoots, trust);
  else if (platform === 'linux') mechanism = bwrapMechanism(existingRoots, allRoots, { searchPath: options.searchPath, cwd: options.cwd, ...trust });
  else mechanism = `no artifact write-protection mechanism is implemented for platform ${platform}`;
  if (typeof mechanism === 'string') {
    return unenforced(existingRoots.length === 0 ? `${mechanism}; no artifact tree exists yet, but a command could create, execute and remove one` : mechanism);
  }
  const failure = selfTest(mechanism, existingRoots, allRoots, canonicalize(root));
  if (failure) return unenforced(failure);
  const verify = () => wrapperIdentityDrift(mechanism.wrapper);
  return {
    enforced: true,
    label: `enforced:${mechanism.name}`,
    wrapper: mechanism.wrapper,
    verify,
    wrap: (launch) => {
      const drift = verify();
      if (drift) throw new Error(`[artifact_protection_wrapper_drift] ${drift}; refusing to launch through an executable other than the one that passed the self-test`);
      return mechanism.wrap(launch);
    },
  };
}
