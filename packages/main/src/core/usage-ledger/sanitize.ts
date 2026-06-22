/**
 * B-6878: the single null-prototype whitelist chokepoint for the usage ledger.
 *
 * Defense-in-depth + CONSISTENCY (NOT a live-vuln fix): the ledger reads
 * token-count fields off objects that originate outside it (JSON.parse of
 * provider/CLI stdout, externally-supplied `options`). Those reads use
 * prototype-chain access (`obj.k`, `'k' in obj`), which would resolve an
 * INHERITED value if `Object.prototype` ever carried a token key. No reachable
 * live exploit exists today (JSON.parse does not mutate Object.prototype and no
 * in-repo path writes it), but the ledger is billing/usage truth, so projecting
 * externally-derived usage through one audited chokepoint makes every downstream
 * adapter/streaming read inheritance-proof by construction.
 *
 * This generalizes the own-prop + Object.create(null) whitelist projection that
 * B-30c3 shipped for the codex/gemini provider extractors
 * (providers/codex-cli.ts ~line 91 `ownProp` + `pickCodexUsageKeys`) to the rest
 * of the ledger.
 *
 * LEAF: this module imports NOTHING beyond the node runtime (in fact nothing at
 * all). It must stay a pure leaf so the entry points can route through it without
 * pulling in a cross-module dependency.
 */

/**
 * Own-property guard: true only when `o` is a non-null object that carries `k`
 * as its OWN property (never via the prototype chain). Mirrors B-30c3's `ownProp`
 * (providers/codex-cli.ts) so the whole ledger uses one consistent predicate.
 */
export function ownProp(o: unknown, k: string): boolean {
  return o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
}

/**
 * Project `obj` down to a fresh `Object.create(null)` object carrying ONLY the
 * whitelisted keys that are present as OWN properties of `obj`.
 *
 * Contract:
 *   - the result has a NULL prototype (`Object.getPrototypeOf(result) === null`),
 *     so a downstream read of a key that was NOT projected resolves to
 *     `undefined` rather than an inherited (possibly polluted) value;
 *   - a key is copied ONLY when `Object.prototype.hasOwnProperty.call(obj, k)`
 *     is true AND `k` is in the whitelist — an inherited / prototype-polluted key
 *     can never leak IN, and a non-whitelisted own key is dropped;
 *   - own-property VALUES are copied VERBATIM (no coercion / no transformation):
 *     legitimate own-property usage data is preserved byte-for-byte; only the
 *     adapter/validator decide whether a value is acceptable;
 *   - a non-object input (null, undefined, primitive, array) yields an EMPTY
 *     null-proto object, so the caller always receives a uniform null-proto shape.
 *
 * NOTE: arrays are treated as "not a usage object" and projected to empty — the
 * usage surfaces this guards are always plain objects, never arrays.
 */
export function toOwnPropsNullProto(
  obj: unknown,
  whitelist: readonly string[],
): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    return out;
  }
  for (const key of whitelist) {
    if (ownProp(obj, key)) {
      out[key] = (obj as Record<string, unknown>)[key];
    }
  }
  return out;
}
