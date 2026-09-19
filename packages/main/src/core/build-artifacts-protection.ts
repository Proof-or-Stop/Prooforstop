import { accessSync, closeSync, constants, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readlinkSync, realpathSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
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
 * cannot replace (neither the file nor any directory on its path is owned by
 * this user — an owner can always chmod what is read-only — or writable by
 * this process, see wrapperReplaceableBy); its identity (path, inode, size,
 * mtime, owner, mode and content digest) and that trust condition are bound
 * when it passes the self-test and re-verified before every launch (verify);
 * the artifact root is canonicalised once and every launch, observation and
 * denial rule refers to that canonical root; and each self-test
 * probe must leave an execution witness that only a probe the wrapper really
 * ran can leave, so a wrapper's exit status alone never earns enforcement.
 * The wrapper is launched with a MINIMAL environment: only a fixed allowlist
 * of harmless variables reaches the wrapper process; everything else — the
 * dynamic loader's variables (`LD_*`, `DYLD_*`, glibc's unsecure list), every
 * interpreter's startup hooks (`NODE_OPTIONS`, `PYTHONPATH`, `PERL5OPT`,
 * `RUBYOPT`, `BASH_ENV`, `JAVA_TOOL_OPTIONS`, …) and `PATH` itself — is
 * withheld from it and re-applied only inside the established sandbox, so a
 * launch environment cannot run code ahead of the mechanism
 * (partitionLaunchEnvironment). Only a NATIVE wrapper is trusted: a script
 * wrapper's interpreter reads startup files the launch chooses (zsh reads
 * `$HOME/.zshenv`) before the wrapper's own code runs, which no binding of
 * the wrapper's or the interpreter's bytes can bound, so an interpreted
 * wrapper is refused (wrapperInterpreterChain still reads the `#!` chain,
 * resolving each declared path in filesystem order and recording every link,
 * so the refusal names exactly what would have run). What this does not cover: the
 * dynamically linked libraries of the wrapper and its interpreters, which are
 * assumed to belong to the same root-owned domain as the executables and are
 * not enumerated here.
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
  wrap(launch: WrapperLaunchInput): WrapperLaunch;
  /**
   * Re-checks, against the filesystem now, that the wrapper this resolution
   * self-tested is still the executable a launch would run (same canonical
   * path, inode, size, mtime, owner, mode and content digest), that it is
   * still one this user cannot replace, and that the canonical artifact root
   * still resolves to itself. Returns the discrepancy, or undefined while the
   * binding holds. Absent on a resolution that launches nothing through a
   * wrapper.
   */
  verify?: () => string | undefined;
  /** The wrapper identity an enforcing resolution is bound to (absent otherwise). */
  wrapper?: WrapperIdentity;
  /** The wrapper's interpreter chain, outermost first (empty for a native executable; absent when not enforcing). */
  interpreters?: WrapperIdentity[];
}

/**
 * What a command would be spawned with; `env` is the environment the COMMAND
 * must see (this process's environment when omitted). An enforcing wrapper
 * returns the same command inside the wrapper, with the wrapper process's own
 * environment sanitised and the withheld variables re-applied inside the
 * sandbox, so the command still sees exactly the declared environment.
 */
export interface WrapperLaunchInput { command: string; args: readonly string[]; shell: boolean; env?: NodeJS.ProcessEnv }
export interface WrapperLaunch { command: string; args: string[]; shell: boolean; env: NodeJS.ProcessEnv }

/**
 * The only variables the WRAPPER process may see. A native wrapper needs none
 * of the rest, and anything else could run code ahead of the sandbox: the
 * loader's variables, an interpreter's startup hooks, or `PATH` (through
 * which an interpreted wrapper would find its interpreter). Everything not
 * listed here is withheld from the wrapper and re-applied inside.
 */
const WRAPPER_ENVIRONMENT = new Set(['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM']);
export function isWrapperEnvironmentVariable(name: string): boolean {
  return WRAPPER_ENVIRONMENT.has(name);
}

/**
 * Environment variables the dynamic loader reads before the executable's own
 * code runs: glibc's unsecure list, plus every `LD_*` (glibc) and `DYLD_*`
 * (macOS) name. Any of them in a wrapper's launch environment can load code
 * into the wrapper process ahead of the sandbox it is about to establish.
 * They are one class of what partitionLaunchEnvironment withholds; the
 * partition withholds everything outside WRAPPER_ENVIRONMENT.
 */
const LOADER_ENVIRONMENT = new Set(['GCONV_PATH', 'GETCONF_DIR', 'GLIBC_TUNABLES', 'HOSTALIASES', 'LOCALDOMAIN', 'LOCPATH', 'MALLOC_TRACE', 'NIS_PATH', 'NLSPATH', 'RESOLV_HOST_CONF', 'RES_OPTIONS', 'TMPDIR', 'TZDIR']);
export function isLoaderEnvironmentVariable(name: string): boolean {
  return name.startsWith('LD_') || name.startsWith('DYLD_') || LOADER_ENVIRONMENT.has(name);
}

/**
 * Split a launch environment into what the WRAPPER process may see (the
 * fixed allowlist only) and what is re-applied to the command inside the
 * sandbox (every other variable, in stable order), so the command's own
 * environment is unchanged while the wrapper starts with nothing that the
 * loader or any interpreter would act on.
 */
export function partitionLaunchEnvironment(env: NodeJS.ProcessEnv): { wrapperEnv: NodeJS.ProcessEnv; reapplied: [string, string][] } {
  const wrapperEnv: NodeJS.ProcessEnv = {};
  const reapplied: [string, string][] = [];
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (value === undefined) continue;
    if (isWrapperEnvironmentVariable(name)) wrapperEnv[name] = value; else reapplied.push([name, value]);
  }
  return { wrapperEnv, reapplied };
}

const INTERPRETER_CHAIN_DEPTH = 4;
const SYMLINK_HOPS = 40;

/** A symbolic link met while resolving a declared path: the link entry and what it pointed at. */
export interface ResolvedLink { path: string; target: string }

/**
 * Resolve a path one component at a time, recording every symbolic link met
 * on the way (a link is followed, and the walk continues through its target).
 * Unlike realpath this keeps the links themselves, so each can be judged and
 * later re-checked: an alias re-pointed after admission is a different
 * resolution even when the wrapper's own bytes never changed.
 */
export function resolvePathRecordingLinks(path: string): { canonical: string; links: ResolvedLink[] } | string {
  const links: ResolvedLink[] = [];
  // Components are walked in FILESYSTEM order, never normalised first: a
  // `..` after a symbolic link steps out of the link's TARGET, as the kernel
  // does, not out of the link's parent, so `/trusted/alias/../sh` with
  // `alias -> /user/tree` reaches /user/sh and records the link.
  let remaining = (isAbsolute(path) ? path : join(process.cwd(), path)).split('/').filter(Boolean);
  let current = '/';
  let hops = 0;
  while (remaining.length > 0) {
    const component = remaining.shift()!;
    if (component === '.') continue;
    if (component === '..') { current = dirname(current); continue; }
    const next = join(current, component);
    let entry;
    try { entry = lstatSync(next); } catch (error) {
      return `${next} cannot be inspected while resolving ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
    }
    if (entry.isSymbolicLink()) {
      if (++hops > SYMLINK_HOPS) return `${path} resolves through more than ${SYMLINK_HOPS} symbolic links`;
      let target: string;
      try { target = readlinkSync(next); } catch (error) { return `${next} cannot be read as a symbolic link: ${(error as Error).message}`; }
      links.push({ path: next, target });
      // The target's own components (its `..` included) are walked next, from
      // the filesystem root for an absolute target or from the link's
      // directory for a relative one.
      remaining = [...target.split('/').filter(Boolean), ...remaining];
      if (isAbsolute(target)) current = '/';
      continue;
    }
    current = next;
  }
  return { canonical: current, links };
}

/** One interpreter of a script wrapper: the path its `#!` line declares, the links that resolution crossed, and the executable it reached. */
export interface DeclaredInterpreter { declared: string; links: ResolvedLink[]; canonical: string }

/**
 * The interpreters a script wrapper runs under, outermost first — empty for
 * a native executable. Read from the `#!` line of the wrapper and of each
 * interpreter that is itself a script; each is kept as DECLARED, with the
 * symbolic links its resolution crossed and the canonical executable it
 * reached. An interpreter named relatively, resolved through PATH
 * (`#!/usr/bin/env node`) or nested deeper than INTERPRETER_CHAIN_DEPTH
 * cannot be bound, and the reason is returned instead.
 */
export function wrapperInterpreterChain(path: string): DeclaredInterpreter[] | string {
  const chain: DeclaredInterpreter[] = [];
  let current = path;
  for (let depth = 0; depth < INTERPRETER_CHAIN_DEPTH; depth++) {
    let head: Buffer;
    try {
      const fd = openSync(current, 'r');
      try { const buffer = Buffer.alloc(512); const length = readSync(fd, buffer, 0, buffer.length, 0); head = buffer.subarray(0, length); } finally { closeSync(fd); }
    } catch (error) {
      return `${current} cannot be read to determine its interpreter: ${(error as Error).message}`;
    }
    if (!(head.length >= 2 && head[0] === 0x23 && head[1] === 0x21)) return chain;
    const line = head.toString('utf8').split(/\r?\n/)[0].slice(2).trim();
    const interpreter = line.split(/\s+/)[0] ?? '';
    if (!interpreter) return `${current} has an empty interpreter line`;
    if (basename(interpreter) === 'env') return `${current} resolves its interpreter through PATH (#!${line}); such a wrapper cannot be bound`;
    if (!isAbsolute(interpreter)) return `${current} names a relative interpreter (#!${line})`;
    const resolved = resolvePathRecordingLinks(interpreter);
    if (typeof resolved === 'string') return `${current} names an interpreter that cannot be resolved (#!${line}): ${resolved}`;
    chain.push({ declared: interpreter, links: resolved.links, canonical: resolved.canonical });
    current = resolved.canonical;
  }
  return `${path} nests interpreters deeper than ${INTERPRETER_CHAIN_DEPTH} levels`;
}

/** What differs between a bound interpreter and what its declared path resolves to now, or undefined. */
export function interpreterResolutionDrift(bound: DeclaredInterpreter): string | undefined {
  const now = resolvePathRecordingLinks(bound.declared);
  if (typeof now === 'string') return `interpreter ${bound.declared} no longer resolves: ${now}`;
  if (now.canonical !== bound.canonical) return `interpreter ${bound.declared} now resolves to ${now.canonical} instead of ${bound.canonical}`;
  if (now.links.length !== bound.links.length || now.links.some((link, index) => link.path !== bound.links[index].path || link.target !== bound.links[index].target)) {
    return `a symbolic link on the path of interpreter ${bound.declared} was re-pointed since it was self-tested`;
  }
  return undefined;
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
/** Applies the withheld loader variables INSIDE a sandbox-exec sandbox (bwrap has --setenv). */
const ENV_BIN = '/usr/bin/env';
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
 * trusted, wherever PATH found it. Every component of the canonical path up
 * to and including the filesystem root is judged: a component OWNED by this
 * user is replaceable whatever its mode (its owner can chmod a read-only
 * file or directory writable again, so a failed W_OK check proves nothing
 * there); a component this process can write (access(2) W_OK) is replaceable;
 * a component whose ownership cannot be inspected is refused rather than
 * assumed safe. A process running as root passes every such test and a root
 * command keeps the privileges to leave either sandbox, so root is refused
 * outright rather than judged by permission bits.
 */
export function wrapperReplaceableBy(path: string, uid: number | undefined = process.getuid?.()): string | undefined {
  if (uid === 0) return 'this process runs as root, which can replace any wrapper and leave any sandbox';
  let current = resolve(path);
  for (;;) {
    let owner: number;
    // lstat: a symbolic-link entry is judged by ITS OWN owner (its owner can
    // re-point it), not by the owner of whatever it currently points at.
    try { owner = lstatSync(current).uid; } catch (error) {
      return `${current} cannot be inspected (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); its ownership is unknown`;
    }
    if (uid !== undefined && owner === uid) return `${current} is owned by this user, who can change its permissions`;
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

/** A launch handed to spawn unchanged: nothing wraps it, so nothing is withheld. */
function passthrough(launch: WrapperLaunchInput): WrapperLaunch {
  return { command: launch.command, args: [...launch.args], shell: launch.shell, env: launch.env ?? process.env };
}

function unenforced(reason: string): ArtifactWriteProtection {
  return { enforced: false, label: `unenforced:${reason}`, wrap: passthrough };
}

/** The command line that runs inside the sandbox, shell launches re-expressed explicitly. */
function innerCommandLine(launch: WrapperLaunchInput): string[] {
  // A shell launch is one command line; re-express it as an explicit shell
  // under the sandbox rather than letting the spawn layer build it, so the
  // sandbox is the parent of the shell and therefore of everything it runs.
  return launch.shell ? ['/bin/sh', '-c', [launch.command, ...launch.args].join(' ')] : [launch.command, ...launch.args];
}

/**
 * A mechanism: its wrapper identity, the launch rewrite, and `trust`, which
 * re-checks everything the mechanism was admitted on (identity drift and the
 * replaceability rule of every executable it launches through).
 */
type Mechanism = { name: 'sandbox-exec' | 'bwrap'; wrapper: WrapperIdentity; interpreters: WrapperIdentity[]; trust: () => string | undefined; wrap: ArtifactWriteProtection['wrap'] };

/** A bound interpreter: how it was declared and resolved, and the identity of the executable reached. */
type TrustedInterpreter = DeclaredInterpreter & { identity: WrapperIdentity };

/** A wrapper executable together with the interpreters it runs under, all identity-bound. */
type TrustedWrapper = { wrapper: WrapperIdentity; interpreters: TrustedInterpreter[] };

/**
 * Re-check everything a trusted wrapper involves: the wrapper's identity and
 * replaceability, and for each interpreter that its declared path still
 * resolves through the same links to the same executable, that the
 * executable's identity holds, and that neither it nor any link on the way
 * has become replaceable.
 */
function trustedWrapperDrift(name: Mechanism['name'], trusted: TrustedWrapper, trust: WrapperTrust): string | undefined {
  const wrapperDrift = wrapperIdentityDrift(trusted.wrapper) ?? replaceabilityRefusal(name, trusted.wrapper.path, trust);
  if (wrapperDrift) return wrapperDrift;
  for (const interpreter of trusted.interpreters) {
    const drift = interpreterResolutionDrift(interpreter) ?? wrapperIdentityDrift(interpreter.identity) ?? interpreterReplaceabilityRefusal(name, interpreter, trust);
    if (drift) return drift;
  }
  return undefined;
}

/** The executable an interpreter resolves to, and every link crossed on the way, must each be unreplaceable. */
function interpreterReplaceabilityRefusal(name: Mechanism['name'], interpreter: DeclaredInterpreter, trust: WrapperTrust): string | undefined {
  for (const path of [...interpreter.links.map((link) => link.path), interpreter.canonical]) {
    const refusal = replaceabilityRefusal(name, path, trust);
    if (refusal) return `interpreter ${interpreter.declared}: ${refusal}`;
  }
  return undefined;
}

type WrapperTrust = { unsafeTrustReplaceableWrapperForFixture?: boolean };

/**
 * Admit a wrapper executable into the trust domain, or say why not: it must
 * not be replaceable by this user (unless a FIXTURE explicitly waives that,
 * which production callers never do) and its identity must be readable so
 * every launch can be held to it.
 */
function replaceabilityRefusal(name: Mechanism['name'], path: string, trust: WrapperTrust): string | undefined {
  if (trust.unsafeTrustReplaceableWrapperForFixture) return undefined;
  const replaceable = wrapperReplaceableBy(path);
  return replaceable ? `${name} wrapper ${path} could be replaced by a validation command (${replaceable}); only a wrapper this user neither owns nor can write, on a path this user neither owns nor can rename, is trusted` : undefined;
}

function trustWrapper(name: Mechanism['name'], path: string, trust: WrapperTrust): TrustedWrapper | string {
  const refusal = replaceabilityRefusal(name, path, trust);
  if (refusal) return refusal;
  const chain = wrapperInterpreterChain(path);
  if (typeof chain === 'string') return `${name} wrapper ${path}: ${chain}`;
  // Only a NATIVE executable is trusted. An interpreter runs startup files
  // before the wrapper's own code (zsh reads $HOME/.zshenv, bash $BASH_ENV,
  // …), and those inputs come from the launch, not from anything bound
  // here: a launch that supplies a HOME whose startup file exits 0 would
  // never run the command yet return the wrapper's clean exit. Binding the
  // interpreter's bytes cannot bound that, so an interpreted wrapper is
  // refused outright; the chain is reported so the refusal names it.
  if (chain.length > 0) return `${name} wrapper ${path} is an interpreted script (#!${chain[0].declared}); only a native executable is trusted, because an interpreter reads startup files chosen by the launch before the wrapper's own code runs`;
  try {
    const wrapper = readWrapperIdentity(path);
    const interpreters: TrustedInterpreter[] = [];
    for (const interpreter of chain) {
      const interpreterRefusal = interpreterReplaceabilityRefusal(name, interpreter, trust);
      if (interpreterRefusal) return `${name} wrapper ${path} runs under ${interpreterRefusal}`;
      interpreters.push({ ...interpreter, identity: readWrapperIdentity(interpreter.canonical) });
    }
    return { wrapper, interpreters };
  } catch (error) {
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
  const trusted = trustWrapper('sandbox-exec', executable, trust);
  if (typeof trusted === 'string') return trusted;
  // The re-application of withheld variables runs INSIDE the sandbox through
  // /usr/bin/env, which must be as unreplaceable as the wrapper itself.
  let envBin: string;
  try { accessSync(ENV_BIN, constants.X_OK); envBin = realpathSync(ENV_BIN); } catch { return `${ENV_BIN} is not executable on this host`; }
  const envRefusal = replaceabilityRefusal('sandbox-exec', envBin, trust);
  if (envRefusal) return envRefusal;
  const profile = sandboxExecProfile(denied);
  return {
    name: 'sandbox-exec',
    wrapper: trusted.wrapper,
    interpreters: trusted.interpreters.map((interpreter) => interpreter.identity),
    trust: () => trustedWrapperDrift('sandbox-exec', trusted, trust) ?? replaceabilityRefusal('sandbox-exec', envBin, trust),
    wrap: (launch) => {
      const { wrapperEnv, reapplied } = partitionLaunchEnvironment(launch.env ?? process.env);
      const inner = innerCommandLine(launch);
      const applied = reapplied.length > 0 ? [envBin, ...reapplied.map(([name, value]) => `${name}=${value}`), ...inner] : inner;
      return { command: executable, args: ['-p', profile, ...applied], shell: false, env: wrapperEnv };
    },
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
  const trusted = trustWrapper('bwrap', bwrap, discovery);
  if (typeof trusted === 'string') return trusted;
  const prefix = bwrapLaunchPrefix(existingRoots);
  return {
    name: 'bwrap',
    wrapper: trusted.wrapper,
    interpreters: trusted.interpreters.map((interpreter) => interpreter.identity),
    trust: () => trustedWrapperDrift('bwrap', trusted, discovery),
    wrap: (launch) => {
      const { wrapperEnv, reapplied } = partitionLaunchEnvironment(launch.env ?? process.env);
      // `--setenv` applies inside the namespace, after every mount is in place.
      const setenv = reapplied.flatMap(([name, value]) => ['--setenv', name, value]);
      return { command: bwrap, args: [...prefix.slice(0, -1), ...setenv, '--', ...innerCommandLine(launch)], shell: false, env: wrapperEnv };
    },
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
  const launch = mechanism.wrap({ command: process.execPath, args: ['-e', script, target, witness, nonce], shell: false, env: process.env });
  const run = spawnSync(launch.command, launch.args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], env: launch.env });
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
  let probed = 0;
  try {
    for (const root of allRoots) {
      const existing = existingRoots.includes(root);
      if (!existing && !isDirectory(dirname(root))) continue;
      probed++;
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
    // Enforcement is never reported without a witnessed, denied probe. When
    // no root and no root's parent exists, the topology is probed through
    // the first MISSING protected ancestor of the first root: creating it is
    // a write the mechanism must deny (the ancestors are denied as literals),
    // and the wrapper must demonstrably run the probe. A topology that cannot
    // be probed at all fails closed.
    if (probed === 0) {
      const missingAncestor = firstMissingProtectedAncestor(allRoots[0]);
      if (!missingAncestor) return `${mechanism.name} self-test found nothing to probe for ${allRoots.join(', ')}; the topology cannot be tested`;
      const { run, witnessed } = runProbe(mechanism, witnessDir, `try { fs.mkdirSync(process.argv[1]); process.exit(0); } catch (error) { process.exit(['EPERM','EACCES','EROFS'].includes(error && error.code) ? ${PROBE_DENIED_EXIT} : 4); }`, missingAncestor);
      const written = run.status === 0 && isDirectory(missingAncestor);
      if (written) { try { rmdirSync(missingAncestor); } catch { /* reported below */ } }
      if (run.error) return `${mechanism.name} self-test on ${missingAncestor} could not start the wrapper: ${run.error.message}`;
      if (written) return `${mechanism.name} self-test on ${missingAncestor} did not deny creating the protected ancestor (exit ${run.status})`;
      if (!witnessed) return `${mechanism.name} self-test on ${missingAncestor} left no execution witness (exit ${run.status}${run.signal ? `, signal ${run.signal}` : ''}); the wrapper did not demonstrably run the probe`;
      if (run.status !== PROBE_DENIED_EXIT) return `${mechanism.name} self-test on ${missingAncestor} ended unexpectedly (exit ${run.status}${run.signal ? `, signal ${run.signal}` : ''}): ${(run.stderr || '').trim().split('\n')[0].slice(0, 160)}`;
    }
    // The wrapper that passed every probe must still be the one on disk and
    // still unreplaceable; a replacement during the self-test would otherwise
    // be bound as trusted.
    return mechanism.trust();
  } finally {
    try { rmSync(witnessDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** The first component on the path to `root` that does not exist yet (a protected ancestor or the root itself) whose parent does, or undefined. */
export function firstMissingProtectedAncestor(root: string): string | undefined {
  const chain: string[] = [];
  let current = root;
  while (dirname(current) !== current) { chain.unshift(current); current = dirname(current); }
  for (const path of chain) if (!existsSync(path)) return isDirectory(dirname(path)) ? path : undefined;
  return undefined;
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
 *
 * The artifact root is canonicalised here (symbolic links resolved on the
 * part that exists) and the resolution binds to THAT directory: the denial
 * rules, the self-test and `verify` all refer to the canonical root, so an
 * alias above the project that a command later re-points cannot carry the
 * protection's meaning to another checkout. Callers launch and observe
 * against the same canonical root.
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
  const root = canonicalize(resolve(artifactsRoot));
  const configRoot = options.configRoot ?? root;
  if (!projectHasArtifactContract(root, configRoot)) {
    return { enforced: false, label: NO_CONTRACT_PROTECTION_LABEL, wrap: passthrough };
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
  const failure = selfTest(mechanism, existingRoots, allRoots, root);
  if (failure) return unenforced(failure);
  const rootStable = (): string | undefined => {
    try { return realpathSync(root) === root ? undefined : `artifact root ${root} no longer resolves to itself`; } catch (error) {
      return `artifact root ${root} can no longer be resolved: ${(error as Error).message}`;
    }
  };
  const verify = () => mechanism.trust() ?? rootStable();
  return {
    enforced: true,
    label: `enforced:${mechanism.name}`,
    wrapper: mechanism.wrapper,
    interpreters: mechanism.interpreters,
    verify,
    wrap: (launch) => {
      const drift = verify();
      if (drift) throw new Error(`[artifact_protection_wrapper_drift] ${drift}; refusing to launch through an executable other than the one that passed the self-test`);
      return mechanism.wrap(launch);
    },
  };
}
