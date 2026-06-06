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
  const lattice = env[`LATTICE_AUTHORITY_${name}`];
  if (typeof lattice === 'string') return lattice;
  return env[`KOALA_AUTHORITY_${name}`];
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
