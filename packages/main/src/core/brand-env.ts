/** Canonical environment namespace. Legacy-prefixed variables are not read or written. */
export const BRAND_ENV_PREFIX = 'PROOF_OR_STOP_';

function brandEnvSuffix(name: string): string {
  return name.startsWith(BRAND_ENV_PREFIX) ? name.slice(BRAND_ENV_PREFIX.length) : name;
}

export function isBrandEnvName(name: string): boolean {
  return name.startsWith(BRAND_ENV_PREFIX);
}

export function brandEnvNames(name: string): readonly [string] {
  return [`${BRAND_ENV_PREFIX}${brandEnvSuffix(name)}`];
}

export function readBrandEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[brandEnvNames(name)[0]];
}

export function readBrandEnvTrimmed(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = readBrandEnv(name, env);
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function setBrandEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  value: string | undefined,
): void {
  const canonical = brandEnvNames(name)[0];
  if (value === undefined) delete env[canonical];
  else env[canonical] = value;
}

export function deleteBrandEnv(env: NodeJS.ProcessEnv, name: string): void {
  setBrandEnv(env, name, undefined);
}

export function applyBrandEnv<T extends NodeJS.ProcessEnv>(
  env: T,
  patch: Record<string, string | undefined>,
): T {
  for (const [name, value] of Object.entries(patch)) setBrandEnv(env, name, value);
  return env;
}

/** Remove selected canonical keys from a composed child environment. */
export function stripCanonicalBrandEnvTwins<T extends NodeJS.ProcessEnv>(
  env: T,
  suffixes: readonly string[],
): T {
  for (const suffix of suffixes) delete env[`${BRAND_ENV_PREFIX}${brandEnvSuffix(suffix)}`];
  return env;
}
