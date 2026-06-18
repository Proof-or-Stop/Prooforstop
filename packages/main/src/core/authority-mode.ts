import { z } from 'zod';

/**
 * Authority submission mode for verification evidence commands.
 *
 * - `off`    : byte-identical to post-B-2157 main; zero network. Default whenever
 *              LATTICE_AUTHORITY_MODE is unset / empty / whitespace / not one of the
 *              three canonical values.
 * - `shadow` : best-effort observational POST; any authority result (success / HTTP
 *              error / timeout / connection-refused / thrown error) never mutates or
 *              blocks the local evidence write — failures degrade to a single stderr
 *              `[warning]` line (Blocker 3).
 * - `enforce`: gating — the authority POST happens BEFORE the local evidence commit
 *              (pre-POST verification); POST failure -> zero local write + non-zero
 *              exit, leaving no local/remote fact divergence window (Blocker 4).
 */
export type AuthorityMode = 'off' | 'shadow' | 'enforce';

export const AUTHORITY_MODES: readonly AuthorityMode[] = ['off', 'shadow', 'enforce'] as const;

/** Default authority timeout (ms) used when LATTICE_AUTHORITY_TIMEOUT_MS is unset / invalid. */
export const DEFAULT_AUTHORITY_TIMEOUT_MS = 10_000;

/**
 * Default Lattice Authority server URL. Per the requirements doc
 * (`lattice-authority-live-integration.md`, "Authority URL and key-file defaults")
 * this default applies ONLY when the user selects `authority` (transport
 * `enforce`) mode and provides no URL via CLI / env / authority.md. It is
 * production-inert: a run whose URL came from this default must never silently
 * satisfy production Authority DONE ("production enforce-mode verification must
 * not silently fall back to localhost").
 */
export const DEFAULT_AUTHORITY_URL = 'http://localhost:6789/';

/** Default internal key-management file, relative to the project root. */
export const DEFAULT_AUTHORITY_KEY_FILE = '.lattice/authority.md';

/** Default Authority trust env file, relative to the project root. */
export const DEFAULT_AUTHORITY_TRUST_ENV_FILE = 'authority_trust.env';

/** Default Lattice-prefixed trust env file emitted by the bundle helper. */
export const DEFAULT_LATTICE_AUTHORITY_TRUST_ENV_FILE = 'lattice_authority_trust.env';

/** Default Lattice-prefixed customer API key sidecar emitted by the bundle helper. */
export const DEFAULT_LATTICE_AUTHORITY_CLIENT_ENV_FILE = 'lattice_staging-client.env';

/** Default senior trust env filename emitted by the bundle helper. */
export const DEFAULT_LATTICE_SENIOR_AUTHORITY_TRUST_ENV_FILE = 'lattice_senior_authority_trust.env';

/** Default senior customer API key sidecar emitted by the bundle helper. */
export const DEFAULT_LATTICE_SENIOR_AUTHORITY_CLIENT_ENV_FILE = 'lattice_senior_staging-client.env';

export type AuthorityTrustProfileTier = 'basic' | 'senior';

export interface AuthorityTrustProfileFileNames {
  trustFileName: string;
  clientFileName: string;
}

export function authorityTrustProfileFileNames(
  tier: AuthorityTrustProfileTier = 'basic',
): AuthorityTrustProfileFileNames {
  if (tier === 'senior') {
    return {
      trustFileName: DEFAULT_LATTICE_SENIOR_AUTHORITY_TRUST_ENV_FILE,
      clientFileName: DEFAULT_LATTICE_SENIOR_AUTHORITY_CLIENT_ENV_FILE,
    };
  }
  return {
    trustFileName: DEFAULT_LATTICE_AUTHORITY_TRUST_ENV_FILE,
    clientFileName: DEFAULT_LATTICE_AUTHORITY_CLIENT_ENV_FILE,
  };
}

export const DEFAULT_AUTHORITY_TRUST_PROFILE_FILE_NAMES = authorityTrustProfileFileNames();

export interface AuthoritySettings {
  mode: AuthorityMode;
  /** Base URL of the authority server; undefined when not configured. */
  baseURL?: string;
  /** Request timeout in ms (always a positive integer after normalization). */
  timeoutMS: number;
}

/**
 * Inline overrides a CLI handler can pass to override env-derived settings.
 * Any field left undefined falls back to the env-derived value.
 */
export interface AuthoritySettingsOverride {
  authorityMode?: string;
  authorityURL?: string;
  authorityTimeoutMS?: number;
}

export function readAuthorityEnv(
  env: Record<string, string | undefined>,
  name: 'MODE' | 'URL' | 'TIMEOUT_MS',
): string | undefined {
  const value = env[`LATTICE_AUTHORITY_${name}`];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Zod schema kept as the first line of defense / API documentation. Per CLAUDE.md
 * "Handler coding convention", the runtime re-validation in {@link normalizeAuthorityMode} is
 * the authoritative gate — callers must never trust Zod alone, because the same env
 * value is read from multiple paths (env load / CLI override / gate decision).
 */
export const AuthorityModeSchema = z.enum(['off', 'shadow', 'enforce']);

/**
 * Normalize an arbitrary input into a canonical AuthorityMode.
 *
 * Runtime re-validation (NOT Zod-only): unset / empty / whitespace-only / any value
 * not exactly one of off|shadow|enforce -> `off`. This is the single source of truth
 * for mode resolution; never default to a non-off value (preMortem #4: an unset env
 * var defaulting to enforce/shadow would break the entire off-mode caller population).
 */
export function normalizeAuthorityMode(value: unknown): AuthorityMode {
  if (typeof value !== 'string') return 'off';
  const trimmed = value.trim();
  if (trimmed === 'off' || trimmed === 'shadow' || trimmed === 'enforce') {
    return trimmed;
  }
  return 'off';
}

/** Whether a normalized mode performs any authority interaction at all. */
export function authorityModeEnabled(mode: AuthorityMode): boolean {
  return mode !== 'off';
}

/** Parse a base URL: trims, returns undefined for unset / empty / whitespace-only. */
export function normalizeAuthorityURL(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Parse a positive-integer timeout, falling back to {@link DEFAULT_AUTHORITY_TIMEOUT_MS}. */
export function normalizeAuthorityTimeout(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_AUTHORITY_TIMEOUT_MS;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AUTHORITY_TIMEOUT_MS;
  }
  return DEFAULT_AUTHORITY_TIMEOUT_MS;
}

/** Safe shell quoting for generated bundle values. */
export function quoteAuthorityShellValue(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export interface AuthorityTrustProfileEnvRenderInput {
  trustEnvFilePath: string;
  authorityURL: string;
  serverPublicKey: string;
  serverKeyId: string;
  projectId: string;
  customerApiKeyPath: string;
  serverPublicKeyEncoding?: string;
}

/**
 * Render the bundle trust env as sourceable shell text.
 */
export function renderAuthorityTrustProfileEnv(
  input: AuthorityTrustProfileEnvRenderInput,
): string {
  const lines = [
    `export LATTICE_AUTHORITY_TRUST_ENV_FILE=${quoteAuthorityShellValue(input.trustEnvFilePath)}`,
    `export LATTICE_AUTHORITY_MODE=${quoteAuthorityShellValue('enforce')}`,
    `export LATTICE_AUTHORITY_URL=${quoteAuthorityShellValue(input.authorityURL)}`,
    `export LATTICE_AUTHORITY_SERVER_PUBLIC_KEY=${quoteAuthorityShellValue(input.serverPublicKey)}`,
    ...(input.serverPublicKeyEncoding
      ? [`export LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_ENCODING=${quoteAuthorityShellValue(input.serverPublicKeyEncoding)}`]
      : []),
    `export LATTICE_AUTHORITY_SERVER_KEY_ID=${quoteAuthorityShellValue(input.serverKeyId)}`,
    `export LATTICE_AUTHORITY_PROJECT_ID=${quoteAuthorityShellValue(input.projectId)}`,
    `export LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH=${quoteAuthorityShellValue(input.customerApiKeyPath)}`,
  ];
  return `${lines.join('\n')}\n`;
}

/** Render the raw customer API key sidecar payload. */
export function renderAuthorityTrustProfileClientSidecar(customerApiKey: string): string {
  return `${customerApiKey.trim()}\n`;
}

/**
 * Resolve authority settings from the environment, with optional CLI inline overrides
 * taking precedence over env. Mode/url/timeout each pass through their runtime
 * normalizer so no illegal value can survive on any path.
 */
export function loadAuthoritySettings(
  env: Record<string, string | undefined> = process.env,
  override: AuthoritySettingsOverride = {},
): AuthoritySettings {
  const envMode = readAuthorityEnv(env, 'MODE');
  const envURL = readAuthorityEnv(env, 'URL');
  const envTimeout = readAuthorityEnv(env, 'TIMEOUT_MS');

  const mode = normalizeAuthorityMode(
    override.authorityMode !== undefined ? override.authorityMode : envMode,
  );
  const baseURL = normalizeAuthorityURL(
    override.authorityURL !== undefined ? override.authorityURL : envURL,
  );
  const timeoutMS = normalizeAuthorityTimeout(
    override.authorityTimeoutMS !== undefined ? override.authorityTimeoutMS : envTimeout,
  );

  return { mode, baseURL, timeoutMS };
}

// ─────────────────────────────────────────────────────────────────────────────
// Authority config resolution: authority.md + default URL + production-inert flag
//
// `loadAuthoritySettings` above is the pure env/CLI mode+url+timeout resolver and
// keeps its exact `{ mode, baseURL, timeoutMS }` shape (consumed by deepEqual
// smokes). The layer below adds the three pieces the final audit found missing,
// WITHOUT mutating that shape:
//   1. the authority-mode localhost default URL;
//   2. the internal `.lattice/authority.md` key-management file (parsed here,
//      read from disk by the I/O shell in authority-client.ts);
//   3. a structured `productionInert` flag + reasons so default / local-test
//      material can never silently satisfy production Authority DONE.
//
// Precedence (highest first): CLI args > env LATTICE_AUTHORITY_* > authority.md >
// authority-mode local default. authority.md and the localhost default are only
// consulted when authority mode is enabled (shadow/enforce); `off` mode stays
// byte-identical to `loadAuthoritySettings` (no file, no default, no network).
// ─────────────────────────────────────────────────────────────────────────────

/** Where the resolved base URL came from (precedence audit trail). */
export type AuthorityUrlSource =
  | 'cli'
  | 'env'
  | 'authority_trust_env'
  | 'authority_md'
  | 'authority_mode_default'
  | 'none';

/** Where a resolved key-material field came from. */
export type AuthorityKeySource = 'env' | 'authority_trust_env' | 'authority_md' | 'none';

/**
 * Parsed machine-readable block of `.lattice/authority.md`. All fields optional;
 * a missing / blank value is treated as absent. Field names follow the doc's
 * camelCase block, with a few accepted aliases for the private-key/public-key
 * fields (`serverPublicKeyHex`, `actorPrivateKey`, `actorPrivateKeyPath`).
 */
export interface AuthorityMdConfig {
  serverUrl?: string;
  projectId?: string;
  runnerId?: string;
  sessionId?: string;
  serverKeyId?: string;
  serverPublicKey?: string;
  serverPublicKeyEncoding?: string;
  actorId?: string;
  actorRole?: string;
  actorKeyId?: string;
  /** Inline private key (local-test only; never for production material). */
  actorKey?: string;
  actorKeyEncoding?: string;
  /** Path to a local private-key file, read by the executor when present. */
  actorKeyPath?: string;
  /** Inline customer API key (local-test only; production should prefer env/path). */
  customerApiKey?: string;
  /** Path to a local customer API key file, read by the HTTP client when present. */
  customerApiKeyPath?: string;
  /** `local-test` marks the whole profile production-inert; `none` is inert-free. */
  testKeyProfile?: string;
}

/** Resolved server + actor key material with per-field provenance. */
export interface AuthorityKeyMaterial {
  serverPublicKey?: string;
  serverPublicKeyEncoding?: string;
  serverKeyId?: string;
  serverKeySource: AuthorityKeySource;
  actorId?: string;
  actorRole?: string;
  actorKeyId?: string;
  /** Inline private key, sourced only from env or a local-test authority.md. */
  actorKey?: string;
  actorKeyPath?: string;
  actorKeyEncoding?: string;
  actorKeySource: AuthorityKeySource;
  /** `local-test` / `none` / undefined, sourced from authority.md. */
  testKeyProfile?: string;
}

/**
 * Full authority configuration: {@link AuthoritySettings} plus the resolved URL
 * provenance, key material, and the production-inert verdict. Additive over
 * AuthoritySettings so existing consumers keep working.
 */
export interface AuthorityConfig extends AuthoritySettings {
  urlSource: AuthorityUrlSource;
  projectId?: string;
  runnerId?: string;
  sessionId?: string;
  /** True when baseURL came from the authority-mode localhost default. */
  defaultUrlApplied: boolean;
  /** True when this config must NOT satisfy production Authority DONE. */
  productionInert: boolean;
  /** Machine-readable reasons the config is production-inert (empty if not). */
  productionInertReasons: string[];
  keyMaterial: AuthorityKeyMaterial;
  /** True when a `.lattice/authority.md` file was found and parsed. */
  authorityMdLoaded: boolean;
  /** True when a root `authority_trust.env` file was found and parsed. */
  authorityTrustEnvLoaded: boolean;
}

/** Strip matching surrounding single/double quotes from a parsed scalar. */
function stripAuthorityMdQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Parse the `.lattice/authority.md` machine-readable block. Pure: takes the file
 * text, returns the typed config. Recognizes simple `key: value` lines; skips
 * blank lines, `#`/`//` comments, markdown fences, and list items. Keys are
 * matched case-insensitively. Blank values are dropped.
 */
export function parseAuthorityMd(text: unknown): AuthorityMdConfig {
  const out: AuthorityMdConfig = {};
  if (typeof text !== 'string') return out;
  const map = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#') || line.startsWith('//')) continue;
    if (line.startsWith('```') || line.startsWith('~~~')) continue;
    if (line.startsWith('- ') || line.startsWith('* ')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = stripAuthorityMdQuotes(line.slice(idx + 1).trim());
    if (value.length === 0) continue;
    // First occurrence wins (a later duplicate does not override).
    if (!map.has(key)) map.set(key, value);
  }
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = map.get(k.toLowerCase());
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
  };
  out.serverUrl = pick('serverUrl');
  out.projectId = pick('projectId');
  out.runnerId = pick('runnerId');
  out.sessionId = pick('sessionId');
  out.serverKeyId = pick('serverKeyId');
  out.serverPublicKey = pick('serverPublicKey', 'serverPublicKeyHex');
  out.serverPublicKeyEncoding = pick('serverPublicKeyEncoding');
  out.actorId = pick('actorId');
  out.actorRole = pick('actorRole');
  out.actorKeyId = pick('actorKeyId');
  out.actorKey = pick('actorKey', 'actorPrivateKey');
  out.actorKeyEncoding = pick('actorKeyEncoding');
  out.actorKeyPath = pick('actorKeyPath', 'actorPrivateKeyPath');
  out.customerApiKey = pick('customerApiKey');
  out.customerApiKeyPath = pick('customerApiKeyPath');
  out.testKeyProfile = pick('testKeyProfile');
  return out;
}

/** Strip matching surrounding single/double quotes from a parsed env scalar. */
function stripAuthorityEnvQuotes(value: string): string {
  return stripAuthorityMdQuotes(value);
}

function expandAuthorityEnvRefs(
  value: string,
  vars: Record<string, string | undefined>,
  depth = 0,
): string {
  if (depth > 5) return value;
  const withDefaults = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*):-(.*?)\}/g, (match, key: string, fallback: string) => {
    const replacement = vars[key];
    if (typeof replacement === 'string' && replacement.length > 0) return replacement;
    return expandAuthorityEnvRefs(fallback, vars, depth + 1);
  });
  return withDefaults.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string | undefined, bare: string | undefined) => {
    const key = braced ?? bare;
    const replacement = key ? vars[key] : undefined;
    return typeof replacement === 'string' ? replacement : match;
  });
}

/**
 * Parse a simple shell-style env file without command execution.
 * Supports `KEY=value`, `export KEY=value`, and text-only `$VAR`, `${VAR}`,
 * and `${VAR:-fallback}` expansion from earlier parsed keys plus the supplied
 * expansion env.
 */
export function parseAuthorityTrustEnv(
  text: unknown,
  expansionEnv: Record<string, string | undefined> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof text !== 'string') return out;
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const rawValue = line.slice(idx + 1).trim();
    const singleQuoted = rawValue.startsWith("'") && rawValue.endsWith("'");
    const stripped = stripAuthorityEnvQuotes(rawValue);
    const value = singleQuoted ? stripped : expandAuthorityEnvRefs(stripped, { ...expansionEnv, ...out });
    if (value.length > 0 && out[key] === undefined) out[key] = value;
  }
  return out;
}

function trustEnvValue(env: Record<string, string | undefined>, suffix: string): string | undefined {
  const canonical = env[`LATTICE_AUTHORITY_${suffix}`];
  return typeof canonical === 'string' && canonical.trim().length > 0 ? canonical.trim() : undefined;
}

/**
 * Normalize legacy/live aliases used by Authority trust files to the canonical
 * LATTICE_AUTHORITY_* keys consumed by the runtime config resolver.
 */
export function normalizeAuthorityTrustEnv(
  env: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  const setCanonical = (target: string, ...sources: string[]): void => {
    const targetKey = `LATTICE_AUTHORITY_${target}`;
    if (typeof out[targetKey] === 'string' && out[targetKey]!.trim().length > 0) return;
    for (const source of sources) {
      const value = trustEnvValue(out, source);
      if (typeof value === 'string' && value.length > 0) {
        out[targetKey] = value;
        return;
      }
    }
  };
  setCanonical('URL', 'LIVE_URL');
  setCanonical('SERVER_PUBLIC_KEY', 'LIVE_PUBLIC_KEY');
  setCanonical('CUSTOMER_API_KEY_PATH', 'CUSTOMER_API_KEY_FILE');
  return out;
}

/** Read an arbitrary LATTICE_AUTHORITY_<suffix> env var. */
function authorityEnvBySuffix(
  env: Record<string, string | undefined>,
  suffix: string,
): string | undefined {
  const lattice = env[`LATTICE_AUTHORITY_${suffix}`];
  return typeof lattice === 'string' && lattice.trim().length > 0 ? lattice.trim() : undefined;
}

export interface ResolveAuthorityConfigInput {
  env?: Record<string, string | undefined>;
  override?: AuthoritySettingsOverride;
  /** Already-parsed authority.md contents; file I/O happens in the caller. */
  authorityMd?: AuthorityMdConfig;
  /** True when an authority.md file was actually found + parsed. */
  authorityMdLoaded?: boolean;
  /** Already-parsed authority_trust.env contents; file I/O happens in the caller. */
  authorityTrustEnv?: Record<string, string | undefined>;
  /** True when authority_trust.env was actually found + parsed. */
  authorityTrustEnvLoaded?: boolean;
}

/**
 * Resolve the full {@link AuthorityConfig} from env/CLI override + parsed
 * authority.md. Pure (no file or network I/O). Implements the precedence
 * contract and stamps the production-inert verdict.
 */
export function resolveAuthorityConfig(input: ResolveAuthorityConfigInput = {}): AuthorityConfig {
  const env = input.env ?? {};
  const override = input.override ?? {};
  const md = input.authorityMd;
  const authorityMdLoaded = input.authorityMdLoaded === true && md !== undefined;
  const trustEnv = normalizeAuthorityTrustEnv(input.authorityTrustEnv);
  const authorityTrustEnvLoaded = input.authorityTrustEnvLoaded === true;

  const base = loadAuthoritySettings(env, override);
  const mode = base.mode;
  const enabled = authorityModeEnabled(mode);

  // URL precedence: CLI > env > authority.md > authority-mode default.
  const cliURL = normalizeAuthorityURL(override.authorityURL);
  const envURL = normalizeAuthorityURL(readAuthorityEnv(env, 'URL'));
  const trustURL = enabled ? normalizeAuthorityURL(readAuthorityEnv(trustEnv, 'URL')) : undefined;
  const mdURL = enabled ? normalizeAuthorityURL(md?.serverUrl) : undefined;
  let baseURL: string | undefined;
  let urlSource: AuthorityUrlSource = 'none';
  if (cliURL !== undefined) {
    baseURL = cliURL;
    urlSource = 'cli';
  } else if (envURL !== undefined) {
    baseURL = envURL;
    urlSource = 'env';
  } else if (trustURL !== undefined) {
    baseURL = trustURL;
    urlSource = 'authority_trust_env';
  } else if (mdURL !== undefined) {
    baseURL = mdURL;
    urlSource = 'authority_md';
  } else if (mode === 'enforce') {
    // The localhost default only applies to the user-selected `authority`
    // (enforce) mode. `shadow` keeps its prior no-URL behavior so a diagnostic
    // run never silently points at localhost.
    baseURL = DEFAULT_AUTHORITY_URL;
    urlSource = 'authority_mode_default';
  }
  const defaultUrlApplied = urlSource === 'authority_mode_default';

  // Live runner identity precedence: env > authority.md. These fields are part of
  // the same canonical config block as URL/key material, but they never apply in
  // off mode because off mode does not load authority.md.
  const projectId = authorityEnvBySuffix(env, 'PROJECT_ID') ?? (enabled ? authorityEnvBySuffix(trustEnv, 'PROJECT_ID') ?? md?.projectId : undefined);
  const runnerId = authorityEnvBySuffix(env, 'RUNNER_ID') ?? (enabled ? authorityEnvBySuffix(trustEnv, 'RUNNER_ID') ?? md?.runnerId : undefined);
  const sessionId = authorityEnvBySuffix(env, 'SESSION_ID') ?? (enabled ? authorityEnvBySuffix(trustEnv, 'SESSION_ID') ?? md?.sessionId : undefined);

  // Server key material precedence: env > authority.md (no CLI arg surface yet).
  const envServerPublicKey = authorityEnvBySuffix(env, 'SERVER_PUBLIC_KEY');
  const envServerKeyId = authorityEnvBySuffix(env, 'SERVER_KEY_ID');
  const envServerEncoding = authorityEnvBySuffix(env, 'SERVER_PUBLIC_KEY_ENCODING');
  const trustServerPublicKey = enabled ? authorityEnvBySuffix(trustEnv, 'SERVER_PUBLIC_KEY') : undefined;
  const trustServerKeyId = enabled ? authorityEnvBySuffix(trustEnv, 'SERVER_KEY_ID') : undefined;
  const trustServerEncoding = enabled ? authorityEnvBySuffix(trustEnv, 'SERVER_PUBLIC_KEY_ENCODING') : undefined;
  let serverPublicKey = envServerPublicKey;
  let serverPublicKeyEncoding = envServerEncoding;
  let serverKeyId = envServerKeyId;
  let serverKeySource: AuthorityKeySource = envServerPublicKey !== undefined ? 'env' : 'none';
  if (serverPublicKey === undefined && trustServerPublicKey !== undefined) {
    serverPublicKey = trustServerPublicKey;
    serverPublicKeyEncoding = serverPublicKeyEncoding ?? trustServerEncoding;
    serverKeyId = serverKeyId ?? trustServerKeyId;
    serverKeySource = 'authority_trust_env';
  }
  if (serverPublicKey === undefined && enabled && md?.serverPublicKey) {
    serverPublicKey = md.serverPublicKey;
    serverPublicKeyEncoding = serverPublicKeyEncoding ?? md.serverPublicKeyEncoding;
    serverKeyId = serverKeyId ?? md.serverKeyId;
    serverKeySource = 'authority_md';
  }
  // serverKeyId may still come from env/md independently of the public key.
  if (serverKeyId === undefined && enabled) serverKeyId = trustServerKeyId ?? md?.serverKeyId;

  // Actor key material precedence: env > authority.md.
  const envActorId = authorityEnvBySuffix(env, 'ACTOR_ID');
  const envActorRole = authorityEnvBySuffix(env, 'ACTOR_ROLE');
  const envActorKeyId = authorityEnvBySuffix(env, 'ACTOR_KEY_ID');
  const envActorKeyPath = authorityEnvBySuffix(env, 'ACTOR_KEY_PATH');
  const envActorKeyEncoding = authorityEnvBySuffix(env, 'ACTOR_KEY_ENCODING');
  const envActorKey = authorityEnvBySuffix(env, 'ACTOR_KEY');
  const trustActorId = enabled ? authorityEnvBySuffix(trustEnv, 'ACTOR_ID') : undefined;
  const trustActorRole = enabled ? authorityEnvBySuffix(trustEnv, 'ACTOR_ROLE') : undefined;
  const trustActorKeyId = enabled ? authorityEnvBySuffix(trustEnv, 'ACTOR_KEY_ID') : undefined;
  const trustActorKeyPath = enabled ? authorityEnvBySuffix(trustEnv, 'ACTOR_KEY_PATH') : undefined;
  const trustActorKeyEncoding = enabled ? authorityEnvBySuffix(trustEnv, 'ACTOR_KEY_ENCODING') : undefined;
  const trustActorKey = enabled ? authorityEnvBySuffix(trustEnv, 'ACTOR_KEY') : undefined;
  let actorId = envActorId;
  let actorRole = envActorRole;
  let actorKeyId = envActorKeyId;
  let actorKey = envActorKey;
  let actorKeyPath = envActorKeyPath;
  let actorKeyEncoding = envActorKeyEncoding;
  let actorKeySource: AuthorityKeySource =
    envActorKey !== undefined || envActorKeyPath !== undefined ? 'env' : 'none';
  if (enabled && (trustActorId || trustActorKeyPath || trustActorKey || trustActorKeyId)) {
    actorId = actorId ?? trustActorId;
    actorRole = actorRole ?? trustActorRole;
    actorKeyId = actorKeyId ?? trustActorKeyId;
    actorKey = actorKey ?? trustActorKey;
    actorKeyPath = actorKeyPath ?? trustActorKeyPath;
    actorKeyEncoding = actorKeyEncoding ?? trustActorKeyEncoding;
    if (actorKeySource === 'none' && (trustActorKey || trustActorKeyPath)) {
      actorKeySource = 'authority_trust_env';
    }
  }
  if (enabled && md && (md.actorId || md.actorKeyPath || md.actorKey || md.actorKeyId)) {
    actorId = actorId ?? md.actorId;
    actorRole = actorRole ?? md.actorRole;
    actorKeyId = actorKeyId ?? md.actorKeyId;
    actorKey = actorKey ?? md.actorKey;
    actorKeyPath = actorKeyPath ?? md.actorKeyPath;
    actorKeyEncoding = actorKeyEncoding ?? md.actorKeyEncoding;
    if (actorKeySource === 'none' && (md.actorKey || md.actorKeyPath)) {
      actorKeySource = 'authority_md';
    }
  }

  const testKeyProfile = enabled ? md?.testKeyProfile : undefined;

  // Production-inert verdict. Both the localhost auto-default and a declared
  // local-test authority.md profile are production-inert; either one must block a
  // production Authority DONE. Reasons are machine-readable for client output.
  const productionInertReasons: string[] = [];
  if (defaultUrlApplied) productionInertReasons.push('authority_url_localhost_default');
  if (enabled && authorityMdLoaded && (testKeyProfile ?? '').trim().toLowerCase() === 'local-test') {
    productionInertReasons.push('authority_md_local_test_profile');
  }

  return {
    mode,
    baseURL,
    timeoutMS: base.timeoutMS,
    urlSource,
    projectId,
    runnerId,
    sessionId,
    defaultUrlApplied,
    productionInert: productionInertReasons.length > 0,
    productionInertReasons,
    authorityMdLoaded,
    authorityTrustEnvLoaded,
    keyMaterial: {
      serverPublicKey,
      serverPublicKeyEncoding,
      serverKeyId,
      serverKeySource,
      actorId,
      actorRole,
      actorKeyId,
      actorKey,
      actorKeyPath,
      actorKeyEncoding,
      actorKeySource,
      testKeyProfile,
    },
  };
}
