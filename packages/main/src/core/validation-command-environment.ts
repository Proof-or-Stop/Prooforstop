/**
 * Shell/launcher bookkeeping that is not part of a validation command's
 * semantics. These values routinely change when the same command is reached
 * through a direct CLI, a shell wrapper, or a live-smoke wrapper.
 *
 * Keep this list deliberately narrow. All other ambient values (including
 * PATH, NODE_OPTIONS, CI, and locale) remain behavior-affecting inputs.
 */
const VALIDATION_TRANSPORT_ENV_KEYS = new Set(['_', 'OLDPWD', 'SHLVL']);

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
  if (overlay) {
    for (const [key, value] of Object.entries(overlay)) effective[canonicalKey(key)] = value;
  }
  return effective;
}
