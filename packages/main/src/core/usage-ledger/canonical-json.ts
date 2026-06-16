/**
 * B-08a1 (Slice 2): the SINGLE canonical-JSON serializer for the usage ledger.
 *
 * Extracted from writer.ts and adapters/shared.ts (which each had a verbatim
 * copy) so the writer's record `recordHash` and the adapters' `payloadDigest`
 * cannot silently diverge — both now hash the SAME canonical bytes. Any change
 * to canonicalization happens here, once, for both consumers.
 *
 * PURE: no fs, no dispatch, no Date.now(). Keys are sorted recursively,
 * `undefined` is omitted, JSON `null` is preserved. Deterministic regardless of
 * a value's key insertion order.
 */

/**
 * Canonical JSON serialization for hashing: keys sorted recursively, `undefined`
 * omitted, JSON `null` preserved. Self-contained so the ledger does not couple
 * to the Authority signing module. Deterministic across insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sortValue(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      out[key] = sortValue(child);
    }
    return out;
  }
  return value;
}
