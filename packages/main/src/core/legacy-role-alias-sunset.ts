import { CANONICAL_AGENT_ROLE_IDS, LEGACY_AGENT_ROLE_ALIASES } from './agent-role-identity.js';
import { nextPatch } from './version-bump.js';

const LEGACY_ROLE_ALIAS_BASES = Object.freeze(
  [...new Set(Object.values(LEGACY_AGENT_ROLE_ALIASES).flat())],
);
const CANONICAL_ROLE_BASES = new Set<string>(CANONICAL_AGENT_ROLE_IDS);

/** Machine-defined compatibility window for the role-identity migration. */
export const LEGACY_ROLE_ALIAS_SUNSET_CONTRACT = Object.freeze({
  schemaVersion: 'proof-or-stop.legacy-role-alias-sunset.v1',
  minimumReleasedCliPatchObservations: 2,
  legacyAliasesRemainReadable: false,
  legacyAliases: LEGACY_ROLE_ALIAS_BASES,
} as const);

export interface LegacyRoleReference {
  roleId: string;
  terminal: boolean;
}

export interface CliPatchReleaseObservation {
  fromVersion: string;
  toVersion: string;
  released: boolean;
}

export interface LegacyRoleAliasSunsetInput {
  references: readonly LegacyRoleReference[];
  releaseObservations: readonly CliPatchReleaseObservation[];
}

export type LegacyRoleAliasSunsetBlocker =
  | 'non-terminal-legacy-references'
  | 'insufficient-released-cli-patch-observations';

export interface LegacyRoleAliasSunsetResult {
  schemaVersion: typeof LEGACY_ROLE_ALIAS_SUNSET_CONTRACT.schemaVersion;
  legacyAliasesReadable: false;
  /** Audit-only rollout observation; never authorizes a read alias or a lifecycle transition. */
  removalEligible: boolean;
  nonTerminalLegacyReferenceCount: number;
  releasedCliPatchObservationCount: number;
  blockers: readonly LegacyRoleAliasSunsetBlocker[];
}

function roleBase(roleId: string): string {
  const separator = roleId.indexOf('@');
  return separator === -1 ? roleId : roleId.slice(0, separator);
}

function isCanonicalRoleReference(roleId: string): boolean {
  return CANONICAL_ROLE_BASES.has(roleBase(roleId.trim()));
}

function countNonTerminalLegacyReferences(references: readonly LegacyRoleReference[]): number {
  let count = 0;
  for (const reference of references) {
    if (!reference || typeof reference !== 'object') {
      count += 1;
      continue;
    }
    if (typeof reference.roleId !== 'string' || typeof reference.terminal !== 'boolean') {
      count += 1;
      continue;
    }
    // Terminal rows remain immutable history. Every live role that is not a
    // known canonical role is conservatively counted, even though the runtime
    // alias registry is intentionally empty after cutover.
    if (!reference.terminal && !isCanonicalRoleReference(reference.roleId)) count += 1;
  }
  return count;
}

function countReleasedCliPatchObservations(
  observations: readonly CliPatchReleaseObservation[],
): number {
  const releasedVersions = new Set<string>();
  for (const observation of observations) {
    if (!observation || typeof observation !== 'object') continue;
    if (
      observation.released !== true
      || typeof observation.fromVersion !== 'string'
      || typeof observation.toVersion !== 'string'
    ) continue;
    try {
      if (nextPatch(observation.fromVersion) !== observation.toVersion) continue;
    } catch {
      continue;
    }
    releasedVersions.add(observation.toVersion);
  }
  return releasedVersions.size;
}

/**
 * Observe whether the historical alias-removal rollout has enough release and
 * reference evidence. This audit result is never consumed as role-read or gate
 * authority and cannot re-enable an alias. Malformed facts are conservative:
 * they cannot establish eligibility.
 */
export function evaluateLegacyRoleAliasSunset(
  input: LegacyRoleAliasSunsetInput,
): LegacyRoleAliasSunsetResult {
  const nonTerminalLegacyReferenceCount = countNonTerminalLegacyReferences(input.references);
  const releasedCliPatchObservationCount = countReleasedCliPatchObservations(input.releaseObservations);
  const blockers: LegacyRoleAliasSunsetBlocker[] = [];
  if (nonTerminalLegacyReferenceCount > 0) blockers.push('non-terminal-legacy-references');
  if (
    releasedCliPatchObservationCount
    < LEGACY_ROLE_ALIAS_SUNSET_CONTRACT.minimumReleasedCliPatchObservations
  ) blockers.push('insufficient-released-cli-patch-observations');

  return {
    schemaVersion: LEGACY_ROLE_ALIAS_SUNSET_CONTRACT.schemaVersion,
    legacyAliasesReadable: false,
    removalEligible: blockers.length === 0,
    nonTerminalLegacyReferenceCount,
    releasedCliPatchObservationCount,
    blockers,
  };
}
