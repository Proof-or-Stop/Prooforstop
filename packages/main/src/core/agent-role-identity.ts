/**
 * Canonical agent-role identity for the proof-or-stop migration.
 *
 * The role id is an on-disk and cross-host contract.  New records and prompts
 * must use the canonical proof-or-stop spelling, while readers must accept the
 * historical lattice spelling (and the pre-registry verification aliases).
 * Keep this mapping as the only place that knows the rename relationship.
 */

export const CANONICAL_AGENT_ROLE_IDS = [
  'proof-or-stop-implementation-reviewer',
  'proof-or-stop-evaluator',
  'proof-or-stop-evaluator-cli',
  'proof-or-stop-implementer',
  'proof-or-stop-review-behavior',
  'proof-or-stop-review-channel',
  'proof-or-stop-review-concept',
  'proof-or-stop-review-delivery',
  'proof-or-stop-review-docs',
  'proof-or-stop-review-quality',
  'proof-or-stop-review-scope-plan',
  'proof-or-stop-review-story-init',
  'proof-or-stop-review-test-coverage',
  'proof-or-stop-review-topology-critic',
  'proof-or-stop-product-reviewer',
  'proof-or-stop-verification-intent',
  'proof-or-stop-test-case-reviewer',
  'proof-or-stop-test-intent',
  'proof-or-stop-finding-repair',
  'proof-or-stop-cluster-repair',
] as const;

export type CanonicalAgentRoleId = typeof CANONICAL_AGENT_ROLE_IDS[number];

/** Canonical role → accepted historical spellings, in no-authority order. */
export const LEGACY_AGENT_ROLE_ALIASES: Readonly<Record<CanonicalAgentRoleId, readonly string[]>> = Object.freeze({
  'proof-or-stop-implementation-reviewer': ['implementation-reviewer'],
  'proof-or-stop-evaluator': ['lattice-evaluator'],
  'proof-or-stop-evaluator-cli': ['lattice-evaluator-cli'],
  'proof-or-stop-implementer': ['lattice-implementer'],
  'proof-or-stop-review-behavior': ['lattice-review-behavior'],
  'proof-or-stop-review-channel': ['lattice-review-channel'],
  'proof-or-stop-review-concept': ['lattice-review-concept'],
  'proof-or-stop-review-delivery': ['lattice-review-delivery'],
  'proof-or-stop-review-docs': ['lattice-review-docs'],
  'proof-or-stop-review-quality': ['lattice-review-quality'],
  'proof-or-stop-review-scope-plan': ['lattice-review-scope-plan'],
  'proof-or-stop-review-story-init': ['lattice-review-story-init'],
  'proof-or-stop-review-test-coverage': ['lattice-review-test-coverage'],
  'proof-or-stop-review-topology-critic': ['lattice-review-topology-critic'],
  'proof-or-stop-product-reviewer': ['product-reviewer'],
  'proof-or-stop-verification-intent': ['verification-intent'],
  'proof-or-stop-test-case-reviewer': ['test-case-reviewer'],
  'proof-or-stop-test-intent': ['test-intent'],
  'proof-or-stop-finding-repair': ['lattice-finding-repair'],
  'proof-or-stop-cluster-repair': ['lattice-cluster-repair'],
});

const CANONICAL_BY_ALIAS = new Map<string, CanonicalAgentRoleId>();
for (const canonical of CANONICAL_AGENT_ROLE_IDS) {
  CANONICAL_BY_ALIAS.set(canonical, canonical);
  for (const alias of LEGACY_AGENT_ROLE_ALIASES[canonical]) {
    CANONICAL_BY_ALIAS.set(alias, canonical);
  }
}

function splitAgentRoleId(roleId: string): { base: string; suffix: string } {
  const trimmed = roleId.trim();
  const separator = trimmed.indexOf('@');
  return separator === -1
    ? { base: trimmed, suffix: '' }
    : { base: trimmed.slice(0, separator), suffix: trimmed.slice(separator) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceRoleToken(text: string, token: string, replacement: string): string {
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_-])${escapeRegExp(token)}(?=$|@|[^A-Za-z0-9_-])`,
    'g',
  );
  return text.replace(pattern, (_match, prefix: string) => `${prefix}${replacement}`);
}

function isCanonicalRoleBase(value: string): value is CanonicalAgentRoleId {
  return (CANONICAL_AGENT_ROLE_IDS as readonly string[]).includes(value);
}

export function canonicalAgentRoleId(roleId: string): string {
  const { base, suffix } = splitAgentRoleId(roleId);
  const canonical = CANONICAL_BY_ALIAS.get(base) ?? base;
  return `${canonical}${suffix}`;
}

export function legacyAgentRoleIds(roleId: string): readonly string[] {
  const canonicalized = canonicalAgentRoleId(roleId);
  const { base, suffix } = splitAgentRoleId(canonicalized);
  const aliases = isCanonicalRoleBase(base) ? LEGACY_AGENT_ROLE_ALIASES[base] : [];
  return suffix ? aliases.map(alias => `${alias}${suffix}`) : aliases;
}

export function isCanonicalAgentRoleId(roleId: string): roleId is CanonicalAgentRoleId {
  return CANONICAL_BY_ALIAS.get(roleId.trim()) === roleId.trim()
    && (CANONICAL_AGENT_ROLE_IDS as readonly string[]).includes(roleId.trim());
}

export function agentRoleIdsEqual(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalAgentRoleId(left) === canonicalAgentRoleId(right);
}

/** Replace role tokens in generated prompt text without changing unrelated prose. */
export function canonicalizeAgentRoleText(text: string): string {
  // Role IDs are hyphenated, so ordinary word-boundary matching is not enough.
  // Treat identifier characters (including '-') as part of a surrounding token
  // and allow an @suffix to remain attached to the replaced role ID.
  let result = text;
  const replacements = Object.entries(LEGACY_AGENT_ROLE_ALIASES)
    .flatMap(([canonical, aliases]) => aliases.map(alias => ({ alias, canonical })))
    .sort((left, right) => right.alias.length - left.alias.length);
  for (const { alias, canonical } of replacements) {
    result = replaceRoleToken(result, alias, canonical);
  }
  return result;
}

/**
 * Reconstruct the historical role vocabulary used by frozen prompt digests.
 * This is intentionally separate from canonicalizeAgentRoleText: new prompt
 * assets and host output stay canonical, while only the digest comparison needs
 * to project a canonical template back onto its legacy representation.
 */
export function legacyizeAgentRoleText(text: string): string {
  const replacements = Object.entries(LEGACY_AGENT_ROLE_ALIASES)
    .flatMap(([canonical, aliases]) => {
      const legacy = aliases[0];
      return legacy ? [{ canonical, legacy }] : [];
    })
    .sort((left, right) => right.canonical.length - left.canonical.length);
  let result = text;
  for (const { canonical, legacy } of replacements) {
    result = replaceRoleToken(result, canonical, legacy);
  }
  return result;
}
