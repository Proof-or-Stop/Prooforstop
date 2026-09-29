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
export function isManagedInventoryCritic(value: unknown, lane: string, agent: string, findingCount: number): value is ManagedInventoryCritic {
  if (lane !== MANAGED_INVENTORY_CRITIC_LANE || agent !== MANAGED_INVENTORY_CRITIC_LANE || !record(value)
    || !keys(value, ['epochId', 'wave', 'findingDispositions']) || !text(value.epochId)
    || !Number.isSafeInteger(value.wave) || (value.wave as number) < 1 || !Array.isArray(value.findingDispositions)) return false;
  const seen = new Set<string>();
  return value.findingDispositions.every(row => {
    if (!record(row) || !keys(row, ['finding', 'disposition', 'familyKey', 'canonicalFinding', 'reason'])
      || !ref(row.finding, findingCount) || !validInventoryCriticReason(row.reason)) return false;
    const identity = JSON.stringify(row.finding);
    if (seen.has(identity)) return false;
    seen.add(identity);
    // A verified family is its own canonical finding; a canonicalFinding that
    // names the row itself is redundant (importers drop it), another is contradictory.
    if (row.disposition === 'verified_family') return text(row.familyKey)
      && (row.canonicalFinding === undefined || JSON.stringify(row.canonicalFinding) === identity);
    if (row.disposition === 'duplicate') return text(row.familyKey) && ref(row.canonicalFinding, findingCount);
    return row.disposition === 'not_verified' && row.familyKey === undefined && row.canonicalFinding === undefined;
  });
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
