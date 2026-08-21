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
  'proof-or-stop-test-case-reviewer': ['test-case-reviewer'],
  // The dispatch registry explicitly adds the canonical prompt role as a
  // compatibility alias for the verification-intent dispatch row.
  'proof-or-stop-test-intent': ['test-intent', 'verification-intent'],
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

export function canonicalAgentRoleId(roleId: string): string {
  const trimmed = roleId.trim();
  const separator = trimmed.indexOf('@');
  const base = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const canonical = CANONICAL_BY_ALIAS.get(base) ?? base;
  return separator === -1 ? canonical : `${canonical}${trimmed.slice(separator)}`;
}

export function legacyAgentRoleIds(roleId: string): readonly string[] {
  const canonical = canonicalAgentRoleId(roleId) as CanonicalAgentRoleId;
  return LEGACY_AGENT_ROLE_ALIASES[canonical] ?? [];
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
  // Protect canonical tokens before replacing aliases.  Several historical
  // aliases (for example `product-reviewer`) are substrings of their canonical
  // forms, so a plain global replacement would turn an already-canonical role
  // into `proof-or-stop-proof-or-stop-*` on the second pass.
  const protectedTokens = CANONICAL_AGENT_ROLE_IDS.map((canonical, index) => ({
    canonical,
    token: `\u0000proof-or-stop-role-${index}\u0000`,
  }));
  const tokenByCanonical = new Map<string, string>(
    protectedTokens.map(({ canonical, token }) => [canonical, token]),
  );
  let result = text;
  for (const { canonical, token } of protectedTokens) {
    result = result.split(canonical).join(token);
  }
  const replacements = Object.entries(LEGACY_AGENT_ROLE_ALIASES)
    .flatMap(([canonical, aliases]) => aliases.map(alias => ({ alias, canonical })))
    .sort((left, right) => right.alias.length - left.alias.length);
  for (const { alias, canonical } of replacements) {
    result = result.split(alias).join(tokenByCanonical.get(canonical) ?? canonical);
  }
  for (const { canonical, token } of protectedTokens) {
    result = result.split(token).join(canonical);
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
    result = result.split(canonical).join(legacy);
  }
  return result;
}
