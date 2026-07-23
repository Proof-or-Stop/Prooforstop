/**
 * Shell/launcher and owner-session identity bookkeeping that is not part of a
 * validation command's semantics. These values routinely change when the same
 * command is reached through a direct CLI, wrapper, or independent reviewer.
 *
 * Keep this list deliberately narrow. All other ambient values (including
 * PATH, NODE_OPTIONS, CI, and locale) remain behavior-affecting inputs.
 */
const VALIDATION_TRANSPORT_ENV_KEYS = new Set([
  '_',
  'OLDPWD',
  'SHLVL',
  // Host/session/role identity controls Proofbound ownership and audit
  // attribution, not validation command behavior. Keeping these ambient values
  // in the receipt digest makes one session's PASS unverifiable by an
  // independent reviewer. Explicit command.env overlays remain semantic below.
  'LATTICE_SESSION_ID',
  'LATTICE_ACTIVITY_SOURCE',
  'LATTICE_ACTIVITY_SESSION',
  'LATTICE_ACTIVITY_RECORD_READONLY',
  'LATTICE_AGENT',
  'LATTICE_CODEX_ENTRYPOINT',
  'LATTICE_OWNER_SESSION_ADAPTER_PROVIDER',
  'LATTICE_OWNER_SESSION_ADAPTER_SESSION',
  'LATTICE_OWNER_SESSION_ADAPTER_TASK',
  'LATTICE_OWNER_SESSION_ADAPTER_AGENT',
  'LATTICE_OWNER_SESSION_ADAPTER_ROLE',
  'LATTICE_OWNER_SESSION_ADAPTER_BOUNDARY',
  'LATTICE_OWNER_SESSION_ADAPTER_GENERATED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'OPENAI_SESSION_ID',
  'TERM_SESSION_ID',
  'ANTIGRAVITY_SESSION_ID',
  'AGY_SESSION_ID',
  'GEMINI_SESSION_ID',
]);

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
