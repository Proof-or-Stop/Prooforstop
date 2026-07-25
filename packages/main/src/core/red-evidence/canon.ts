// §0.4 CANON — the single canonical digest form for the trusted RED-evidence
// subsystem (W2a / B-c054).
//
// Spec: docs/requirements/decisions/red-evidence-subsystem-spec.md §0.4.
//   CANON serializes a value as UTF-8 JSON using RFC 8785 (JSON Canonicalization
//   Scheme) — object keys recursively sorted by UTF-16 code unit, no
//   insignificant whitespace, minimal number/string encoding — then SHA-256,
//   rendered as `sha256:<64-hex>`.
//
// This module deliberately does NOT reuse core/digest.ts or
// core/authority-signing.ts:
//   - core/digest.ts sorts keys with String.prototype.localeCompare (locale
//     collation, NOT code-unit order), which diverges from RFC 8785.
//   - core/authority-signing.ts maps JSON `null` to `undefined` and DROPS the
//     member, which would erase a chain-founding `priorRecordDigest: null`.
// Both divergences are proven, with frozen vectors, by
// packages/main/tests/red/red-w2a-canon-differential.mjs.
//
// Assurance scope (§0.6 practical tier): CANON makes a record's digest
// reproducible and detects accidental substitution / casual drift through the
// registered surfaces. It does not resist a hostile local agent that rewrites
// the evidence store and recomputes every digest offline — end-to-end
// resistance to that adversary is the separate Tier-C program.

import { createHash } from 'node:crypto';

export type CanonValue =
  | null
  | boolean
  | number
  | string
  | CanonValue[]
  | { [key: string]: CanonValue };

/**
 * Return the RFC 8785 canonical JSON string for `value`.
 *
 * Rules (§0.4):
 *   - `null` is preserved literally as `null` (never dropped, never mapped to
 *     `undefined`).
 *   - numbers use `JSON.stringify` minimal form (verified RFC-8785-equivalent:
 *     `-0` -> `0`, `1e21` -> `1e+21`, `1e-7` -> `1e-7`); a non-finite number
 *     (`NaN`/`Infinity`) is not valid JSON and THROWS.
 *   - strings/booleans use `JSON.stringify` (RFC-8785 minimal escaping; control
 *     chars -> `\uXXXX`, non-ASCII emitted as raw UTF-8, lone surrogates
 *     deterministically escaped).
 *   - arrays keep element order.
 *   - object keys are sorted by the default `Array.prototype.sort()`, i.e.
 *     UTF-16 code-unit order (= RFC 8785), NOT localeCompare.
 *   - `undefined` / function / symbol are programming errors for CANON inputs
 *     (callers omit absent optional fields via {@link omitUndefinedDeep} first)
 *     and THROW.
 */
export function canon(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`CANON: non-finite number is not valid JSON: ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canon(item)).join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    // Default sort() compares by UTF-16 code unit, which is exactly the RFC 8785
    // member ordering. Do NOT swap in localeCompare (that is digest.ts's defect).
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`).join(',')}}`;
  }
  throw new Error(
    `CANON: unsupported value of type ${t}; undefined/function/symbol are programming errors for CANON inputs`,
  );
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** `sha256:` + SHA-256 hex over the CANON bytes of `value`. */
export function canonDigest(value: unknown): string {
  return `sha256:${sha256hex(canon(value))}`;
}

/**
 * §0.4 self-omitting digest helper: `canonDigest` of `value` with the top-level
 * `field` deleted. A record's `recordDigest` is CANON over the record with the
 * `recordDigest` member itself omitted (a digest cannot contain itself).
 *
 * Omitting a field that is absent is a no-op (same digest as the original), not
 * an error. On a non-object input the field cannot be present, so this degrades
 * to {@link canonDigest}.
 */
export function canonDigestOmitting(value: unknown, field: string): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return canonDigest(value);
  }
  const clone: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete clone[field];
  return canonDigest(clone);
}

/**
 * §0.4 nullability/omission helper. Recursively strip object members whose value
 * is `undefined` (an OMITTED optional field per §0.4), while PRESERVING explicit
 * JSON `null` (chain-founding `priorRecordDigest`/`supersedes` carry `null`, not
 * omission). Arrays keep their length and element order. The result is safe to
 * pass to {@link canon}, which would otherwise throw on a surviving `undefined`.
 */
export function omitUndefinedDeep(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => omitUndefinedDeep(item));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue; // §0.4: an absent optional field is OMITTED
      out[key] = omitUndefinedDeep(item);
    }
    return out;
  }
  return value;
}

/**
 * The first 12 hex characters of a digest's 64-hex body, EXCLUDING the
 * `sha256:` prefix (a short, human-scannable handle; never used as an identity
 * on its own).
 */
export function first12hex(digest: string): string {
  const prefix = 'sha256:';
  const body = digest.startsWith(prefix) ? digest.slice(prefix.length) : digest;
  return body.slice(0, 12);
}
