import { createHash } from 'node:crypto';

/**
 * Leaf module for canonical-JSON digesting.
 *
 * Extracted VERBATIM from handlers/decision-doc-promotion.ts (B-2ccc). This is a
 * behaviour-preserving move: the canonicalization (recursive key sorting,
 * undefined/function/symbol omission, array null-coalescing) and the sha256
 * hashing are byte-identical to the previous inline definitions. Imports ONLY
 * node:crypto so it can be reused without dragging handler dependencies along.
 */

export type Digestable =
  | null
  | string
  | number
  | boolean
  | Digestable[]
  | { [key: string]: Digestable };

function normalizeJson(value: unknown): Digestable | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item) ?? null);
  if (typeof value === 'object') {
    const out: Record<string, Digestable> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      const normalized = normalizeJson(item);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return String(value);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function digestCanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function digestText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
