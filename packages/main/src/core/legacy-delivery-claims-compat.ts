/**
 * Narrow compatibility boundary for the retired completion fields persisted by
 * delivery-context-pack. Active callers may only construct the fixed local-only
 * shape or validate that exact shape; field names never escape as reusable keys.
 */

export interface LegacyLocalOnlyDeliveryClaims {
  authorityDone: false;
  fullAuthorityDone: false;
  productionDone: false;
}

export function createLegacyLocalOnlyDeliveryClaims(): LegacyLocalOnlyDeliveryClaims {
  return {
    authorityDone: false,
    fullAuthorityDone: false,
    productionDone: false,
  };
}

export function isExactLegacyLocalOnlyDeliveryClaims(value: unknown): value is LegacyLocalOnlyDeliveryClaims {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const expected = createLegacyLocalOnlyDeliveryClaims();
  const keys = Object.keys(expected);
  return Object.keys(record).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(record, key) && record[key] === false);
}
