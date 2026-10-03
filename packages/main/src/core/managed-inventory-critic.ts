// Shared runtime floor for native and managed critic receipt writers.
export const INVENTORY_CRITIC_REASON_MIN_LENGTH = 10;
export function validInventoryCriticReason(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= INVENTORY_CRITIC_REASON_MIN_LENGTH;
}
/** Provider-authored transport data. Shape validation grants no signing authority. */
export type ManagedInventoryFindingRef = { findingId: string } | { proposalFindingIndex: number };
export interface ManagedInventoryDisposition {
  finding: ManagedInventoryFindingRef;
  disposition: 'verified_family' | 'duplicate' | 'not_verified';
  familyKey?: string;
  canonicalFinding?: ManagedInventoryFindingRef;
  reason: string;
}
export interface ManagedInventoryCritic {
  epochId: string;
  wave: number;
  findingDispositions: ManagedInventoryDisposition[];
}
export const MANAGED_INVENTORY_CRITIC_LANE = 'proof-or-stop-review-topology-critic';
// Provider schema stays flat; the authoritative local parser enforces exact-one-reference.
const referenceSchema = {type: 'object', additionalProperties: false,
  properties: {findingId: {type: 'string'}, proposalFindingIndex: {type: 'integer'}}};
export const managedInventoryCriticJsonSchema = {
  type: 'object', additionalProperties: false, required: ['epochId', 'wave', 'findingDispositions'],
  properties: {
    epochId: {type: 'string'}, wave: {type: 'integer'},
    findingDispositions: {type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['finding', 'disposition', 'reason'],
      properties: {finding: referenceSchema, disposition: {type: 'string', enum: ['verified_family', 'duplicate', 'not_verified']},
        familyKey: {type: 'string'}, canonicalFinding: referenceSchema, reason: {type: 'string'}},
    }},
  },
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
function ref(v: unknown, count: number): v is ManagedInventoryFindingRef {
  if (!record(v)) return false;
  if (keys(v, ['findingId']) && text(v.findingId)) return true;
  return keys(v, ['proposalFindingIndex']) && Number.isSafeInteger(v.proposalFindingIndex)
    && (v.proposalFindingIndex as number) >= 0 && (v.proposalFindingIndex as number) < count;
}
/** Bounded JSON rendering of a provider value for a model-readable violation. */
function shown(v: unknown): string {
  if (v === undefined) return 'missing';
  const encoded = JSON.stringify(v) ?? String(v);
  return encoded.length > 80 ? `${encoded.slice(0, 77)}...` : encoded;
}
const refExpected = (count: number) => count > 0
  ? `{findingId:<existing id>} or {proposalFindingIndex:0..${count - 1}}`
  : '{findingId:<existing id>} (no own findings, so no proposalFindingIndex)';
/**
 * Every way `value` misses the managed critic contract, as `path: expected
 * ..., got ...` lines (empty when valid). The single source for both the
 * predicate below and the provider-facing rejection reason.
 */
export function managedInventoryCriticViolations(value: unknown, lane: string, agent: string, findingCount: number, path = 'inventoryCritic'): string[] {
  if (lane !== MANAGED_INVENTORY_CRITIC_LANE || agent !== MANAGED_INVENTORY_CRITIC_LANE) {
    return [`${path}: only the ${MANAGED_INVENTORY_CRITIC_LANE} lane may carry an inventoryCritic block`];
  }
  if (!record(value)) return [`${path}: expected an object {epochId,wave,findingDispositions}, got ${shown(value)}`];
  const out: string[] = [];
  const extra = Object.keys(value).filter(k => !['epochId', 'wave', 'findingDispositions'].includes(k));
  if (extra.length) out.push(`${path}: unexpected field(s) ${extra.join(', ')}; allowed epochId, wave, findingDispositions`);
  if (!text(value.epochId)) out.push(`${path}.epochId: expected a non-blank string, got ${shown(value.epochId)}`);
  if (!Number.isSafeInteger(value.wave) || (value.wave as number) < 1) out.push(`${path}.wave: expected an integer >= 1, got ${shown(value.wave)}`);
  if (!Array.isArray(value.findingDispositions)) {
    out.push(`${path}.findingDispositions: expected an array, got ${shown(value.findingDispositions)}`);
    return out;
  }
  const seen = new Set<string>();
  value.findingDispositions.forEach((row, i) => {
    const at = `${path}.findingDispositions[${i}]`;
    if (!record(row)) { out.push(`${at}: expected an object, got ${shown(row)}`); return; }
    const rowExtra = Object.keys(row).filter(k => !['finding', 'disposition', 'familyKey', 'canonicalFinding', 'reason'].includes(k));
    if (rowExtra.length) out.push(`${at}: unexpected field(s) ${rowExtra.join(', ')}; allowed finding, disposition, familyKey, canonicalFinding, reason`);
    if (!ref(row.finding, findingCount)) out.push(`${at}.finding: expected ${refExpected(findingCount)}, got ${shown(row.finding)}`);
    if (!validInventoryCriticReason(row.reason)) out.push(`${at}.reason: expected a string of at least ${INVENTORY_CRITIC_REASON_MIN_LENGTH} trimmed characters, got ${shown(row.reason)}`);
    const identity = JSON.stringify(row.finding);
    if (seen.has(identity)) out.push(`${at}.finding: ${shown(row.finding)} is classified more than once; one row per finding`);
    seen.add(identity);
    // A verified family is its own canonical finding; a canonicalFinding that
    // names the row itself is redundant (importers drop it), another is contradictory.
    if (row.disposition === 'verified_family') {
      if (!text(row.familyKey)) out.push(`${at}.familyKey: verified_family requires a non-blank familyKey, got ${shown(row.familyKey)}`);
      if (row.canonicalFinding !== undefined && JSON.stringify(row.canonicalFinding) !== identity) {
        out.push(`${at}.canonicalFinding: verified_family omits canonicalFinding (it is its own canonical finding), got ${shown(row.canonicalFinding)}`);
      }
    } else if (row.disposition === 'duplicate') {
      if (!text(row.familyKey)) out.push(`${at}.familyKey: duplicate requires a non-blank familyKey, got ${shown(row.familyKey)}`);
      if (!ref(row.canonicalFinding, findingCount)) out.push(`${at}.canonicalFinding: duplicate requires ${refExpected(findingCount)}, got ${shown(row.canonicalFinding)}`);
    } else if (row.disposition === 'not_verified') {
      if (row.familyKey !== undefined) out.push(`${at}.familyKey: not_verified permits no familyKey, got ${shown(row.familyKey)}`);
      if (row.canonicalFinding !== undefined) out.push(`${at}.canonicalFinding: not_verified permits no canonicalFinding, got ${shown(row.canonicalFinding)}`);
    } else {
      out.push(`${at}.disposition: expected one of verified_family, duplicate, not_verified, got ${shown(row.disposition)}`);
    }
  });
  return out;
}
export function isManagedInventoryCritic(value: unknown, lane: string, agent: string, findingCount: number): value is ManagedInventoryCritic {
  return managedInventoryCriticViolations(value, lane, agent, findingCount).length === 0;
}

/** Exact lane contract shared by terminal and legacy managed-review ingress. */
export function isManagedInventoryCriticEnvelopeValid(
  value: unknown,
  lane: string,
  agent: string,
  findingCount: number,
): value is ManagedInventoryCritic | undefined {
  return lane === MANAGED_INVENTORY_CRITIC_LANE
    ? isManagedInventoryCritic(value, lane, agent, findingCount)
    : value === undefined;
}
