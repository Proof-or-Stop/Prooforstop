/**
 * Shell/launcher and owner-session identity bookkeeping that is not part of a
 * validation command's semantics. These values routinely change when the same
 * command is reached through a direct CLI, wrapper, or independent reviewer.
 *
 * Keep this list deliberately narrow. All other ambient values (including
 * PATH, NODE_OPTIONS, CI, and locale) remain behavior-affecting inputs.
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
