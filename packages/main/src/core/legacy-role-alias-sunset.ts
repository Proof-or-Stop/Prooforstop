import { LEGACY_AGENT_ROLE_ALIASES } from './agent-role-identity.js';
import { nextPatch } from './version-bump.js';

const LEGACY_ROLE_ALIAS_BASES = Object.freeze(
  [...new Set(Object.values(LEGACY_AGENT_ROLE_ALIASES).flat())],
);

/** Machine-defined compatibility window for the role-identity migration. */
export const LEGACY_ROLE_ALIAS_SUNSET_CONTRACT = Object.freeze({
  schemaVersion: 'proof-or-stop.legacy-role-alias-sunset.v1',
  minimumReleasedCliPatchObservations: 2,
  legacyAliasesRemainReadable: true,
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
  legacyAliasesReadable: true;
  removalEligible: boolean;
  nonTerminalLegacyReferenceCount: number;
  releasedCliPatchObservationCount: number;
  blockers: readonly LegacyRoleAliasSunsetBlocker[];
}

function roleBase(roleId: string): string {
  const separator = roleId.indexOf('@');
  return separator === -1 ? roleId : roleId.slice(0, separator);
}

function isLegacyRoleAlias(roleId: string): boolean {
  return LEGACY_ROLE_ALIAS_BASES.includes(roleBase(roleId.trim()));
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
    if (!reference.terminal && isLegacyRoleAlias(reference.roleId)) count += 1;
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
 * Evaluate alias removal eligibility without changing the read path or any
 * persisted state. Malformed facts are conservative: they cannot establish
 * eligibility.
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
    legacyAliasesReadable: true,
    removalEligible: blockers.length === 0,
    nonTerminalLegacyReferenceCount,
    releasedCliPatchObservationCount,
    blockers,
  };
}
