import { accessSync, constants, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
 * What this does NOT establish, on any platform: that a command executed the
 * protected bytes. A command denied writes here can still copy the artifacts
 * elsewhere, alter the copy and execute that, leaving these trees untouched.
 * Protection removes the in-place swap; it is not proof of what ran.
 */
export interface ArtifactWriteProtection {
  /** True only when a mechanism actually denies the writes. */
  enforced: boolean;
  /** Recorded on results, receipts and evidence: `enforced:<mechanism>` or `unenforced:<reason>`. */
  label: string;
  /** Rewrites a launch so the child and its descendants cannot write the artifact roots. */
  wrap(launch: { command: string; args: readonly string[]; shell: boolean }): { command: string; args: string[]; shell: boolean };
}

/** A command the plan permits to write the artifacts, so it is deliberately launched unprotected. */
export const REGISTERED_BUILD_PROTECTION_LABEL = 'registered-build:writes-permitted';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

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

function unenforced(reason: string): ArtifactWriteProtection {
  return {
    enforced: false,
    label: `unenforced:${reason}`,
    wrap: (launch) => ({ command: launch.command, args: [...launch.args], shell: launch.shell }),
  };
}

/**
 * Resolve the protection available for this platform and artifact root. Every
 * artifact root is denied whether or not it exists yet, so a command cannot
 * create a tree that a later observation would count.
 */
export function resolveArtifactWriteProtection(artifactsRoot: string): ArtifactWriteProtection {
  if (process.platform !== 'darwin') {
    return unenforced(`no artifact write-protection mechanism is implemented for platform ${process.platform}`);
  }
  try {
    accessSync(SANDBOX_EXEC, constants.X_OK);
  } catch {
    return unenforced('sandbox-exec is not executable on this host');
  }
  const root = resolve(artifactsRoot);
  const denied = BUILD_ARTIFACT_ROOTS.map((relative) => canonicalize(join(root, relative)));
  const profile = `(version 1)(allow default)(deny file-write* ${denied.map((path) => `(subpath ${quote(path)})`).join(' ')})`;
  return {
    enforced: true,
    label: 'enforced:sandbox-exec',
    wrap: (launch) => (launch.shell
      // A shell launch is one command line; re-express it as an explicit shell
      // under the sandbox rather than letting the spawn layer build it, so the
      // sandbox is the parent of the shell and therefore of everything it runs.
      ? { command: SANDBOX_EXEC, args: ['-p', profile, '/bin/sh', '-c', [launch.command, ...launch.args].join(' ')], shell: false }
      : { command: SANDBOX_EXEC, args: ['-p', profile, launch.command, ...launch.args], shell: false }),
  };
}
