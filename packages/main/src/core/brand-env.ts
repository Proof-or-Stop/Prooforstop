/**
 * brand-env.ts — the single read-both resolver for brand-prefixed environment
 * variables (B-cdf6 CHK-006 Pass B).
 *
 * WHY THIS EXISTS
 * ---------------
 * The brand rename maps every `LATTICE_*` variable to `PROOF_OR_STOP_*`. Env-var
 * names are pure COUPLING, not past evidence (nothing hashes them), so
 * `docs/requirements/decisions/brand-rename-mapping.md`'s corrected governing rule
 * classifies them RENAMED.
 *
 * But the repository is multi-developer, and teammate branches / CI configs /
 * operator shells written against `LATTICE_*` WILL merge in. A silent behaviour
 * change on merge is the worst outcome: a teammate exporting
 * `LATTICE_BRIEF_OUTPUT=0` would suddenly be ignored and it would surface as
 * *their* bug in *their* branch. So the rename is ADDITIVE:
 *
 *   - the NEW name (`PROOF_OR_STOP_*`) is canonical and WINS when both are set;
 *   - the OLD name (`LATTICE_*`) is still READ as a fallback, forever;
 *   - the new name is never REQUIRED.
 *
 * Routing all reads through one helper instead of open-coding
 * `process.env.NEW ?? process.env.OLD` at ~150 call sites is what makes the
 * contract auditable: there is exactly one place where precedence is decided,
 * and exactly one list of prefixes to change if the brand ever moves again.
 *
 * WRITES
 * ------
 * `setBrandEnv` / `applyBrandEnv` write BOTH names. That is deliberate and is not
 * redundancy: the value frequently has to survive a hop into a child process
 * (`lattice-dispatch`, the smoke tasks, hook subprocesses) whose code may be a
 * teammate's pre-rename build that only knows `LATTICE_*`. Writing both keeps the
 * hop working in either direction of the migration.
 */

/** Canonical (new) prefix. Reads prefer this; writes always emit it. */
export const BRAND_ENV_PREFIX = 'PROOF_OR_STOP_';

/**
 * Deprecated (old) prefix. Still read as a fallback so a pre-rename export keeps
 * working; still written alongside the new name so a pre-rename READER keeps
 * working. Never removed — see the multi-developer constraint above.
 */
export const DEPRECATED_BRAND_ENV_PREFIX = 'LATTICE_';

/** True when `name` is spelled with either brand prefix. */
export function isBrandEnvName(name: string): boolean {
  return name.startsWith(BRAND_ENV_PREFIX) || name.startsWith(DEPRECATED_BRAND_ENV_PREFIX);
}

/**
 * Normalize any accepted spelling of a brand env var to its bare suffix.
 *
 * Accepts the canonical name (`PROOF_OR_STOP_AGENT`), the deprecated name
 * (`LATTICE_AGENT`) or the bare suffix (`AGENT`), so call sites can pass whatever
 * spelling reads most naturally at that point without changing behaviour.
 */
function brandEnvSuffix(name: string): string {
  if (name.startsWith(BRAND_ENV_PREFIX)) return name.slice(BRAND_ENV_PREFIX.length);
  if (name.startsWith(DEPRECATED_BRAND_ENV_PREFIX)) {
    return name.slice(DEPRECATED_BRAND_ENV_PREFIX.length);
  }
  return name;
}



/**
 * Both accepted names for a variable, canonical first. Useful for allowlists /
 * env-passthrough sets that must forward whichever spelling the caller used.
 */
export function brandEnvNames(name: string): readonly [string, string] {
  const suffix = brandEnvSuffix(name);
  return [`${BRAND_ENV_PREFIX}${suffix}`, `${DEPRECATED_BRAND_ENV_PREFIX}${suffix}`];
}

/**
 * Read a brand env var, preferring the canonical name and falling back to the
 * deprecated one.
 *
 * Precedence is by PRESENCE, not truthiness: a canonical name set to the empty
 * string still wins over a deprecated name set to a value. That matters because
 * several call sites treat `''` as a meaningful "explicitly cleared" signal, and
 * silently promoting the old value there would be a behaviour change rather than
 * a compatibility shim.
 */
export function readBrandEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const [canonical, deprecated] = brandEnvNames(name);
  const preferred = env[canonical];
  if (preferred !== undefined) return preferred;
  return env[deprecated];
}

/** `readBrandEnv` trimmed, with blank / whitespace-only collapsed to undefined. */
export function readBrandEnvTrimmed(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = readBrandEnv(name, env);
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}


/**
 * Set a brand env var under BOTH names so the value survives a hop into a
 * pre-rename child process. Passing `undefined` deletes both.
 */
export function setBrandEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  value: string | undefined,
): void {
  const [canonical, deprecated] = brandEnvNames(name);
  if (value === undefined) {
    delete env[canonical];
    delete env[deprecated];
    return;
  }
  env[canonical] = value;
  env[deprecated] = value;
}

/** Delete both spellings of a brand env var. */
export function deleteBrandEnv(env: NodeJS.ProcessEnv, name: string): void {
  setBrandEnv(env, name, undefined);
}

/**
 * Apply a suffix-or-name keyed patch to an env object, writing both spellings for
 * every entry. `undefined` values delete. Returns the same object for chaining.
 */
export function applyBrandEnv<T extends NodeJS.ProcessEnv>(
  env: T,
  patch: Record<string, string | undefined>,
): T {
  for (const [name, value] of Object.entries(patch)) {
    setBrandEnv(env, name, value);
  }
  return env;
}

