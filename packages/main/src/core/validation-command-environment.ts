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
): Record<string, string> {
  const effective: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnvironment)) {
    if (value !== undefined && !VALIDATION_TRANSPORT_ENV_KEYS.has(key) && key !== 'PWD') {
      effective[key] = value;
    }
  }
  effective.PWD = cwd;
  if (overlay) Object.assign(effective, overlay);
  return effective;
}
