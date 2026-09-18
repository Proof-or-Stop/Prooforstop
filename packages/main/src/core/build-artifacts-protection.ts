import { accessSync, constants, existsSync, lstatSync, realpathSync, rmSync, rmdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { BUILD_ARTIFACT_ROOTS } from './build-artifacts-identity.js';

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
  /** Rewrites a launch so the child and its descendants cannot write the artifact roots. */
  wrap(launch: { command: string; args: readonly string[]; shell: boolean }): { command: string; args: string[]; shell: boolean };
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
 * Whether a recorded label satisfies the executed-build contract: the writes
 * were demonstrably denied on this host, by a mechanism that passed its
 * self-test, and nothing else. An `unenforced:` label, the retired
 * not-applicable label, a registered-build label on a non-build command, or a
 * missing label never satisfies it.
 */
export function artifactProtectionSatisfied(label: string | undefined): boolean {
  return typeof label === 'string' && label.startsWith('enforced:');
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

function executableOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  return undefined;
}

function unenforced(reason: string): ArtifactWriteProtection {
  return {
    enforced: false,
    label: `unenforced:${reason}`,
    wrap: (launch) => ({ command: launch.command, args: [...launch.args], shell: launch.shell }),
  };
}

type Mechanism = { name: 'sandbox-exec' | 'bwrap'; wrap: ArtifactWriteProtection['wrap'] };

function sandboxExecMechanism(denied: string[]): Mechanism | string {
  try { accessSync(SANDBOX_EXEC, constants.X_OK); } catch { return 'sandbox-exec is not executable on this host'; }
  const profile = `(version 1)(allow default)(deny file-write* ${denied.map((path) => `(subpath ${quote(path)})`).join(' ')})`;
  return {
    name: 'sandbox-exec',
    wrap: (launch) => (launch.shell
      // A shell launch is one command line; re-express it as an explicit shell
      // under the sandbox rather than letting the spawn layer build it, so the
      // sandbox is the parent of the shell and therefore of everything it runs.
      ? { command: SANDBOX_EXEC, args: ['-p', profile, '/bin/sh', '-c', [launch.command, ...launch.args].join(' ')], shell: false }
      : { command: SANDBOX_EXEC, args: ['-p', profile, launch.command, ...launch.args], shell: false }),
  };
}

function bwrapMechanism(existingRoots: string[], allRoots: string[]): Mechanism | string {
  const bwrap = executableOnPath('bwrap');
  if (!bwrap) return 'bwrap (bubblewrap) is not on PATH';
  // bwrap re-binds a tree read-only over itself, so it can only protect a tree
  // that exists. An absent root would stay creatable inside the namespace, and
  // a command could create, execute and remove artifacts there between two
  // observations of "absent"; that is not enforcement. Every configured root
  // must therefore exist before bwrap is reported as enforcing anything.
  const absent = allRoots.filter((root) => !existingRoots.includes(root));
  if (absent.length > 0) return `bwrap cannot protect the absent artifact root(s) ${absent.join(', ')}; every configured root must exist (a build creates them) before evidence can be authoritative`;
  // The whole filesystem stays visible and writable as on the host; only the
  // artifact trees are re-bound read-only over themselves, for the command and
  // everything it spawns inside the namespace. The namespace gets its own PID
  // space and a private /proc: with the host's /proc visible, a same-user
  // process's /proc/<pid>/root (or cwd, or fd) is an alias into the host mount
  // namespace, where the trees are still writable underneath the bind.
  const binds = existingRoots.flatMap((root) => ['--ro-bind', root, root]);
  const prefix = ['--dev-bind', '/', '/', '--unshare-pid', '--proc', '/proc', ...binds, '--die-with-parent', '--'];
  return {
    name: 'bwrap',
    wrap: (launch) => (launch.shell
      ? { command: bwrap, args: [...prefix, '/bin/sh', '-c', [launch.command, ...launch.args].join(' ')], shell: false }
      : { command: bwrap, args: [...prefix, launch.command, ...launch.args], shell: false }),
  };
}

/**
 * Attempt, under the wrapper, the exact write the mechanism must deny, on
 * EVERY configured root: a file inside a tree that exists, or the creation of
 * the tree itself where it does not. Enforced only when each probe reports the
 * refusal AND nothing was written. Any other outcome (the write succeeded, the
 * wrapper itself failed to start, an unexpected exit) is reported, never
 * assumed away. An absent root whose parent directory is also absent cannot be
 * probed without first creating that parent, which the mechanism does not deny;
 * it is covered by the same rule as its siblings but is reported as unprobed.
 */
function selfTest(mechanism: Mechanism, existingRoots: string[], allRoots: string[]): string | undefined {
  for (const root of allRoots) {
    const existing = existingRoots.includes(root);
    if (!existing && !isDirectory(dirname(root))) continue;
    const target = existing ? join(root, `.proof-or-stop-write-probe-${process.pid}-${Date.now()}`) : root;
    const probe = existing
      ? `try { require('node:fs').writeFileSync(process.argv[1], 'probe'); process.exit(0); } catch (error) { process.exit(['EPERM','EACCES','EROFS'].includes(error && error.code) ? ${PROBE_DENIED_EXIT} : 4); }`
      : `try { require('node:fs').mkdirSync(process.argv[1]); process.exit(0); } catch (error) { process.exit(['EPERM','EACCES','EROFS'].includes(error && error.code) ? ${PROBE_DENIED_EXIT} : 4); }`;
    const launch = mechanism.wrap({ command: process.execPath, args: ['-e', probe, target], shell: false });
    const run = spawnSync(launch.command, launch.args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
    // Only what the probe itself demonstrably created is removed: the uniquely
    // named probe file, or the root directory when the probe reported that it
    // created it — never recursively, and never a directory that exists for
    // any other reason (a build running elsewhere may have just created it).
    const written = existing ? existsSync(target) : run.status === 0 && isDirectory(target);
    if (written) { try { if (existing) rmSync(target, { force: true }); else rmdirSync(target); } catch { /* reported below */ } }
    if (run.error) return `${mechanism.name} self-test on ${root} could not start the wrapper: ${run.error.message}`;
    if (written) return `${mechanism.name} self-test on ${root} did not deny the write (exit ${run.status})`;
    if (run.status !== PROBE_DENIED_EXIT) return `${mechanism.name} self-test on ${root} ended unexpectedly (exit ${run.status}${run.signal ? `, signal ${run.signal}` : ''}): ${(run.stderr || '').trim().split('\n')[0].slice(0, 160)}`;
  }
  return undefined;
}

/** Whether any configured artifact root exists under this project root right now. */
export function hasAnyArtifactRoot(artifactsRoot: string): boolean {
  const root = resolve(artifactsRoot);
  return BUILD_ARTIFACT_ROOTS.some((relative) => isDirectory(canonicalize(join(root, relative))));
}

/**
 * Whether a protection resolved earlier in a run may no longer describe the
 * host: a registered build has run since (it may have created or replaced the
 * trees), or the resolution was `not-applicable` because no tree existed and a
 * tree exists now. The exemption for a project without artifact trees is valid
 * only while that absence holds; a plan that starts without `dist`, builds it,
 * and then tests must protect those tests. Callers re-resolve when this is true.
 */
export function artifactProtectionStale(
  protection: Pick<ArtifactWriteProtection, 'label'>,
  state: { buildRanSinceResolve: boolean; anyRootExists: boolean },
): boolean {
  if (state.buildRanSinceResolve) return true;
  return protection.label === NOT_APPLICABLE_PROTECTION_LABEL && state.anyRootExists;
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
 */
export function resolveArtifactWriteProtection(artifactsRoot: string): ArtifactWriteProtection {
  const root = resolve(artifactsRoot);
  const allRoots = BUILD_ARTIFACT_ROOTS.map((relative) => canonicalize(join(root, relative)));
  const existingRoots = allRoots.filter((path) => isDirectory(path));
  let mechanism: Mechanism | string;
  if (process.platform === 'darwin') mechanism = sandboxExecMechanism(allRoots);
  else if (process.platform === 'linux') mechanism = bwrapMechanism(existingRoots, allRoots);
  else mechanism = `no artifact write-protection mechanism is implemented for platform ${process.platform}`;
  if (typeof mechanism === 'string') {
    return unenforced(existingRoots.length === 0 ? `${mechanism}; no artifact tree exists yet, but a command could create, execute and remove one` : mechanism);
  }
  const failure = selfTest(mechanism, existingRoots, allRoots);
  if (failure) return unenforced(failure);
  return { enforced: true, label: `enforced:${mechanism.name}`, wrap: mechanism.wrap };
}
