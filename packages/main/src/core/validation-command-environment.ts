/**
 * Shell/launcher and owner-session identity bookkeeping that is not part of a
 * validation command's semantics. These values routinely change when the same
 * command is reached through a direct CLI, wrapper, or independent reviewer.
 *
 * Keep this list deliberately narrow: it strips values from the SPAWNED child
 * environment too. What a receipt's environment IDENTITY binds is the narrower
 * projection {@link validationEnvironmentIdentityEntries} (declared env,
 * command-named variables, PATH as toolchain resolution, behavior-affecting
 * families) -- see VALIDATION_ENVIRONMENT_IDENTITY_SCHEMA.
 */
export const VALIDATION_TRANSPORT_ENV_KEY_LIST = [
  // Host/session/role identity controls Proof-or-Stop ownership and audit
  // attribution, not validation command behavior. Keeping these ambient values
  // in the receipt digest makes one session's PASS unverifiable by an
  // independent reviewer. Explicit command.env overlays remain semantic below.
  'AGY_SESSION_ID',
  'ANTIGRAVITY_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'GEMINI_SESSION_ID',
  'LATTICE_ACTIVITY_RECORD_READONLY',
  'LATTICE_ACTIVITY_ROLE',
  'LATTICE_ACTIVITY_SESSION',
  'LATTICE_ACTIVITY_SOURCE',
  'LATTICE_AGENT',
  'LATTICE_CODEX_ENTRYPOINT',
  'LATTICE_OWNER_SESSION_ADAPTER_AGENT',
  'LATTICE_OWNER_SESSION_ADAPTER_BOUNDARY',
  'LATTICE_OWNER_SESSION_ADAPTER_GENERATED',
  'LATTICE_OWNER_SESSION_ADAPTER_PROVIDER',
  'LATTICE_OWNER_SESSION_ADAPTER_ROLE',
  'LATTICE_OWNER_SESSION_ADAPTER_SESSION',
  'LATTICE_OWNER_SESSION_ADAPTER_TASK',
  'LATTICE_SESSION_ID',
  'OLDPWD',
  'OPENAI_SESSION_ID',
  'SHLVL',
  'TERM_SESSION_ID',
  '_',
] as const;

export const VALIDATION_TRANSPORT_ENV_KEYS_DIGEST =
  'sha256:159db7bb6593c703d112dab8973b5d650c9b43b0c02246cf18a553f7b1aa3c0c';

/**
 * THE LIST ABOVE IS FROZEN, AND UNUSUALLY SO — it is a genuine past-evidence
 * surface, not mere coupling (B-cdf6 CHK-006 Pass B).
 *
 * `VALIDATION_TRANSPORT_ENV_KEY_LIST` is the strip-list that decides which
 * ambient values are EXCLUDED from `effectiveValidationCommandEnvironment`. That
 * environment is hashed into `effectiveEnvironmentDigest`, which is persisted in
 * `done-required-evidence.json` / `test-evidence.json` and later re-derived and
 * COMPARED against the stored value (`core/done-required-validation.ts:820`).
 * Adding or renaming a member therefore changes the recomputed digest for an
 * unchanged environment and makes every stored receipt read as a
 * `effective-environment-digest-mismatch`.
 *
 * So the brand rename cannot touch the list itself. Instead the canonical
 * spellings are derived at the FILTER boundary while retired keys are omitted
 * from active matching. This keeps two properties simultaneously:
 *   - already-persisted receipts keep verifying (the pinned list is byte-stable);
 *   - a session that exports only the new spellings does not leak host/session
 *     identity into the digest, which is the security property the list exists for.
 */
const FROZEN_RETIRED_ENV_PREFIX = ['LAT', 'TICE_'].join('');
const VALIDATION_TRANSPORT_ENV_KEYS = new Set<string>([
  ...VALIDATION_TRANSPORT_ENV_KEY_LIST.filter((key) => !key.startsWith(FROZEN_RETIRED_ENV_PREFIX)),
  ...VALIDATION_TRANSPORT_ENV_KEY_LIST
    .filter((key) => key.startsWith(FROZEN_RETIRED_ENV_PREFIX))
    .map((key) => `PROOF_OR_STOP_${key.slice(FROZEN_RETIRED_ENV_PREFIX.length)}`),
]);

export function isValidationTransportEnvKey(
  key: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalizedKey = platform === 'win32' ? key.toUpperCase() : key;
  return platform === 'win32'
    ? [...VALIDATION_TRANSPORT_ENV_KEYS].some((transportKey) => transportKey.toUpperCase() === normalizedKey)
    : VALIDATION_TRANSPORT_ENV_KEYS.has(normalizedKey);
}

/**
 * Host-launcher session identity that is NOT in the frozen list above.
 *
 * These are the same class of value as `PROOF_OR_STOP_SESSION_ID` -- per-process
 * identity injected by the coding-agent host or the terminal multiplexer it runs
 * under, carrying no validation-command
 * semantics -- but they are spelled by the host, not by Proof-or-Stop, so
 * `brandEnvNames` does not reach them. Left ambient they are hashed into
 * `effectiveEnvironmentDigest`, and because they change with every session
 * (`CLAUDE_PID` is a pid, `CLAUDE_CODE_MESSAGING_SOCKET` embeds that pid, and
 * `CMUX_TERMINAL_LIFECYCLE_ID` is a per-terminal UUID) a
 * receipt written in one session can never be re-derived in another. That is
 * precisely the "one session's PASS is unverifiable by an independent
 * reviewer" failure the frozen list exists to prevent: on this repo it
 * surfaced as `effective-environment-digest-mismatch[0..1]` blocking DONE on a
 * story whose DONE-required validation had actually passed.
 *
 * They are stripped HERE rather than appended to
 * `VALIDATION_TRANSPORT_ENV_KEY_LIST` on purpose. That list is digest-pinned by
 * `VALIDATION_TRANSPORT_ENV_KEYS_DIGEST`, and every already-persisted receipt
 * verifies against the environment its members imply; appending to it would
 * change the recomputed digest for an unchanged environment and invalidate all
 * of them at once. Filtering at this seam keeps the pinned list byte-stable --
 * the same technique the brand rename used for the new `PROOF_OR_STOP_*`
 * spellings.
 *
 * Receipts written BEFORE this strip existed still mismatch, because they
 * embedded the volatile values; they are re-earned by re-running the
 * validation, which is the normal remedy for a stale receipt.
 */
export const HOST_LAUNCHER_SESSION_ENV_KEYS = [
  // Lab reuse-host-session-environment: per-session values the Claude Code host
  // injects that no validation command reads (zero readers in this repository).
  // BAGGAGE carries the host's telemetry propagation (sentry-trace_id, release);
  // CLAUDE_EFFORT is the session's effort setting; CLAUDE_CODE_HOST_SESSION_ID
  // names the host session. Left ambient, a new session or effort level re-ran
  // the full plan as validation-identity-changed.
  'BAGGAGE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CMUX_SOCKET_PATH',
  'CMUX_TERMINAL_LIFECYCLE_ID',
  'CODEX_COMPANION_SESSION_ID',
  'CODEX_COMPANION_TRANSCRIPT_PATH',
] as const;

for (const key of HOST_LAUNCHER_SESSION_ENV_KEYS) VALIDATION_TRANSPORT_ENV_KEYS.add(key);

/**
 * Return the exact environment used both for command identity and child spawn.
 * Ambient transport fields are removed, PWD is canonicalized to the effective
 * command cwd, and an explicit command.env overlay is applied last so every
 * configured override remains semantic (even for a normally-transport key).
 */
export function effectiveValidationCommandEnvironment(
  processEnvironment: NodeJS.ProcessEnv,
  overlay: Record<string, string> | undefined,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const windows = platform === 'win32';
  const canonicalKey = (key: string): string => windows ? key.toUpperCase() : key;
  const transportKeys = windows
    ? new Set([...VALIDATION_TRANSPORT_ENV_KEYS].map((key) => key.toUpperCase()))
    : VALIDATION_TRANSPORT_ENV_KEYS;
  const effective: Record<string, string> = {};
  const ambientEntries = Object.entries(processEnvironment);
  if (windows) ambientEntries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  for (const [key, value] of ambientEntries) {
    const normalizedKey = canonicalKey(key);
    if (value !== undefined && !transportKeys.has(normalizedKey) && normalizedKey !== canonicalKey('PWD')) {
      effective[normalizedKey] = value;
    }
  }
  effective[canonicalKey('PWD')] = cwd;
  for (const [key, value] of Object.entries(projectValidationEnvironment(cwd))) effective[canonicalKey(key)] = value;
  if (overlay) {
    for (const [key, value] of Object.entries(overlay)) effective[canonicalKey(key)] = value;
  }
  return effective;
}

/**
 * Domain of the environment IDENTITY (what receipts bind), as opposed to the
 * environment a child is spawned with. v1 was "every ambient variable minus the
 * transport strip-list"; v2 is the projection below. The marker is digested
 * with the entries, so a receipt recorded under v1 can never compare equal to a
 * v2 identity: it goes stale exactly once and is re-earned by one real run,
 * instead of being silently accepted.
 */
export const VALIDATION_ENVIRONMENT_IDENTITY_SCHEMA = 'proof-or-stop.validation-environment-identity.v2';

/**
 * Why a projection and not "the whole ambient environment":
 *
 * A receipt says "this command, run with these inputs, passed". Its
 * environment identity must change whenever a variable could change the
 * command's result, and must NOT change when only the owner's shell or terminal
 * differs; otherwise the same owner (or an independent reviewer) re-running
 * from another window, tmux, ssh or a wrapper sees every receipt stale
 * (COLUMNS, TERM_PROGRAM, TMUX_PANE, SSH_TTY, a wrapper's trace id, one extra
 * PATH entry...). A denylist of observed names cannot close that set, because
 * every terminal/wrapper invents new ones. So the identity is an ALLOWLIST of
 * the inputs that can change behavior:
 *
 *   (a) everything the project or command DECLARES: validate.env of the
 *       nearest config and the command's own env overlay -- the documented way
 *       to make any other variable part of a receipt;
 *   (b) every variable the pinned command text NAMES (`$FOO`,
 *       `process.env.FOO`, `os.environ["FOO"]` all contain the word FOO);
 *   (c) PATH as TOOLCHAIN RESOLUTION, not as a string: which file each
 *       executable the command may run (its executable, bare-name arguments,
 *       and the common toolchain entry points below) resolves to, with its size
 *       and mtime. A PATH entry that shadows nothing leaves this unchanged; one
 *       that resolves a different node/go/git changes it. (The command's own
 *       executable is additionally content-hashed in the toolchain digest.);
 *   (d) the variable families toolchains, runtimes and libc actually read
 *       (locale, TZ, HOME/TMPDIR, NODE_*, GO*, PYTHON*, CARGO_*, GIT_*,
 *       LD_/DYLD_ preloads, proxies, CI, color forcing, Proof-or-Stop's own
 *       PROOF_OR_STOP_* configuration, ...), plus PWD (always the canonical cwd).
 *
 * A variable outside (a)-(d) is not something another shell reproduces either,
 * so binding it only makes receipts unverifiable; a project whose tests really
 * read such a variable declares it in validate.env (a) and it binds.
 *
 * Inside the (d) families an explicit denylist removes shell/terminal/launcher
 * bookkeeping (CONDA_SHLVL, GIT_ASKPASS injected per editor session,
 * NODE_CHANNEL_FD, ...); the transport strip-list above is already gone from
 * the effective environment. Terminal variables (TERM*, COLUMNS, LINES, TMUX*,
 * SSH_*, ITERM_*, SHLVL, _, OLDPWD) are outside every family by construction.
 * Neither the denylist nor the families ever override (a) or (b): a command
 * that names COLUMNS binds COLUMNS.
 */
const BEHAVIOR_ENV_EXACT = [
  'ALL_PROXY', 'CC', 'CFLAGS', 'CI', 'COMSPEC', 'CONTINUOUS_INTEGRATION', 'CPPFLAGS', 'CXX', 'CXXFLAGS',
  'DEBUG', 'FORCE_COLOR', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'LANG', 'LANGUAGE', 'LDFLAGS', 'MAKEFLAGS',
  'NO_COLOR', 'NO_PROXY', 'PATHEXT', 'PKG_CONFIG_PATH', 'REQUESTS_CA_BUNDLE', 'SYSTEMROOT', 'TEMP', 'TMP',
  'TMPDIR', 'TZ', 'VIRTUAL_ENV', 'WINDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_DIRS', 'XDG_CONFIG_HOME',
  'XDG_DATA_DIRS', 'XDG_DATA_HOME', '_JAVA_OPTIONS', 'all_proxy', 'http_proxy', 'https_proxy', 'no_proxy',
];
const BEHAVIOR_ENV_PREFIXES = [
  'BUNDLE_', 'BUN_', 'CARGO_', 'CGO_', 'CONDA_', 'DENO_', 'DOTNET_', 'DYLD_', 'GEM_', 'GIT_', 'GO', 'GRADLE_',
  'JAVA_', 'JDK_', 'JEST_', 'LC_', 'LD_', 'MAVEN_', 'NODE_', 'NPM_CONFIG_', 'NUGET_', 'PERL', 'PHP', 'PIP_',
  'PLAYWRIGHT_', 'PNPM_', 'POETRY_', 'PROOF_OR_STOP_', 'PUPPETEER_', 'PYTEST_', 'PYTHON', 'RUBY', 'RUST',
  'SSL_CERT_', 'TS_NODE_', 'UV_', 'VITEST', 'YARN_', 'npm_config_',
];
/** Shell/terminal/launcher bookkeeping inside the allowlisted families: never a command input. */
const BOOKKEEPING_ENV_EXACT = [
  'CONDA_PROMPT_MODIFIER', 'CONDA_SHLVL', 'GIT_ASKPASS', 'GIT_PAGER', 'NODE_CHANNEL_FD',
  'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID',
];
const BOOKKEEPING_ENV_PREFIXES = ['GIT_PS1_', 'VSCODE_GIT_'];
/** Entry points whose PATH resolution is part of the identity even when the command does not name them. */
const TOOLCHAIN_PROBES = [
  'bash', 'bun', 'bundle', 'cargo', 'cc', 'clang', 'cmake', 'deno', 'gcc', 'git', 'go', 'gofmt', 'gradle',
  'java', 'javac', 'make', 'mvn', 'node', 'npm', 'npx', 'pip', 'pip3', 'pnpm', 'pytest', 'python', 'python3',
  'ruby', 'rustc', 'sh', 'tsc', 'uv', 'yarn',
];

function matchesEnvFamily(key: string, exact: readonly string[], prefixes: readonly string[], windows: boolean): boolean {
  if (!windows) return exact.includes(key) || prefixes.some(prefix => key.startsWith(prefix));
  const upper = key.toUpperCase();
  return exact.some(name => name.toUpperCase() === upper) || prefixes.some(prefix => upper.startsWith(prefix.toUpperCase()));
}

export function isBehaviorAffectingEnvKey(key: string, platform: NodeJS.Platform = process.platform): boolean {
  const windows = platform === 'win32';
  return !matchesEnvFamily(key, BOOKKEEPING_ENV_EXACT, BOOKKEEPING_ENV_PREFIXES, windows)
    && matchesEnvFamily(key, BEHAVIOR_ENV_EXACT, BEHAVIOR_ENV_PREFIXES, windows);
}

// PATH directory listings, revalidated by the directory's own mtime (adding,
// removing or renaming an entry updates it). One identity costs one stat per
// PATH directory plus one realpath/stat per probe that is actually present.
const pathDirectoryEntries = new Map<string, { mtimeMs: number; names: Set<string> }>();
function pathDirectoryNames(dir: string, windows: boolean): Set<string> | null {
  try {
    const mtimeMs = statSync(dir).mtimeMs;
    let cached = pathDirectoryEntries.get(dir);
    if (!cached || cached.mtimeMs !== mtimeMs) {
      const names = readdirSync(dir);
      cached = { mtimeMs, names: new Set(windows ? names.map(entry => entry.toLowerCase()) : names) };
      pathDirectoryEntries.set(dir, cached);
    }
    return cached.names;
  } catch {
    return null;
  }
}

/** The file one executable name resolves to over PATH (first executable regular file wins); null when absent. */
function resolveToolchainProbe(
  name: string,
  directories: ReadonlyArray<readonly [string, Set<string> | null]>,
  windows: boolean,
  pathExt: string,
): string | null {
  const names = windows && !/\.[^\\/]+$/.test(name)
    ? pathExt.split(';').map(ext => ext.trim()).filter(Boolean).map(ext => name + ext)
    : [name];
  for (const [dir, entries] of directories) {
    for (const candidate of names) {
      if (!entries?.has(windows ? candidate.toLowerCase() : candidate)) continue;
      try {
        const full = resolve(dir, candidate);
        if (!windows) accessSync(full, constants.X_OK);
        const real = realpathSync(full);
        const stat = statSync(real);
        if (!stat.isFile()) continue;
        return `${real}\u0000${stat.size}\u0000${Math.trunc(stat.mtimeMs)}`;
      } catch {
        // Non-executable or vanished candidates are skipped exactly like a PATH search.
      }
    }
  }
  return null;
}

/**
 * The environment IDENTITY of a validation/verification command: sorted
 * [key, value] entries under {@link VALIDATION_ENVIRONMENT_IDENTITY_SCHEMA}
 * (rule above). `commandWords` is the command as written (executable and
 * arguments). Spawning still uses {@link effectiveValidationCommandEnvironment}
 * unchanged; only what receipts bind is projected.
 */
export function validationEnvironmentIdentityEntries(
  processEnvironment: NodeJS.ProcessEnv,
  overlay: Record<string, string> | undefined,
  cwd: string,
  commandWords: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Array<[string, string]> {
  const windows = platform === 'win32';
  const canonicalKey = (key: string): string => windows ? key.toUpperCase() : key;
  const effective = effectiveValidationCommandEnvironment(processEnvironment, overlay, cwd, platform);
  const bound = new Set([
    ...Object.keys(projectValidationEnvironment(cwd)),
    ...Object.keys(overlay ?? {}),
  ].map(canonicalKey));
  for (const word of commandWords) {
    for (const match of word.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) bound.add(canonicalKey(match[0]));
  }
  const pathKey = canonicalKey('PATH');
  const pwdKey = canonicalKey('PWD');
  const rawPath = bound.has(pathKey);
  const entries: Array<[string, string]> = [['#schema', VALIDATION_ENVIRONMENT_IDENTITY_SCHEMA]];
  for (const [key, value] of Object.entries(effective)) {
    if (key === pathKey && !rawPath) continue;
    if (bound.has(key) || key === pwdKey || isBehaviorAffectingEnvKey(key, platform)) entries.push([key, value]);
  }
  if (!rawPath) {
    const pathExt = effective[canonicalKey('PATHEXT')] ?? '.COM;.EXE;.BAT;.CMD';
    const probes = new Set(TOOLCHAIN_PROBES);
    // A shell command line is one word with spaces; each bare token may be a program.
    for (const word of commandWords) for (const token of word.split(/\s+/)) if (/^[A-Za-z0-9._+-]+$/.test(token)) probes.add(token);
    const directories = (effective[pathKey] ?? '').split(windows ? ';' : delimiter).map(entry => {
      // Relative and empty PATH entries belong to the command's cwd.
      const dir = resolve(cwd, entry || '.');
      return [dir, pathDirectoryNames(dir, windows)] as const;
    });
    const resolution = [...probes].sort().map(name =>
      [name, resolveToolchainProbe(name, directories, windows, pathExt)]);
    entries.push(['#path-resolution', JSON.stringify(resolution)]);
  }
  return entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

export const VERIFICATION_REUSE_CAPSULE_ENVIRONMENT_KEYS = ['LANG', 'LC_ALL', 'PATH', 'PWD', 'TZ'] as const;

/**
 * Closed environment for the policy-owned deterministic reuse capsule. Ambient
 * values and overlays (especially NODE_OPTIONS/loaders/preloads) never enter it.
 */
export function closedVerificationReuseCapsuleEnvironment(cwd: string): Record<string, string> {
  return {
    LANG: 'C',
    LC_ALL: 'C',
    PATH: dirname(process.execPath),
    PWD: cwd,
    TZ: 'UTC',
  };
}
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { CONFIG_FILENAMES } from './brand-paths.js';

const projectEnvironmentCache = new Map<string, { mtimeMs: number; env: Record<string, string> }>();

/**
 * `validate.env` of the nearest Proof-or-Stop config above `cwd`: the
 * environment the project's tests require (e.g. CONTEXT=abs). It is project
 * state, so validation runs and receipt freshness see the same values whatever
 * the calling shell exported. A malformed or absent config contributes nothing.
 */
export function projectValidationEnvironment(cwd: string): Record<string, string> {
  for (let dir = cwd; ; dir = dirname(dir)) {
    for (const name of CONFIG_FILENAMES) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      try {
        const mtimeMs = statSync(path).mtimeMs;
        const cached = projectEnvironmentCache.get(path);
        if (cached && cached.mtimeMs === mtimeMs) return cached.env;
        const raw = (JSON.parse(readFileSync(path, 'utf8')) as { validate?: { env?: unknown } }).validate?.env;
        const env: Record<string, string> = {};
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') env[key] = value;
        }
        projectEnvironmentCache.set(path, { mtimeMs, env });
        return env;
      } catch {
        return {};
      }
    }
    if (dirname(dir) === dir) return {};
  }
}
