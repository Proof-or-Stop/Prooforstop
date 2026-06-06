/**
 * declared-artifact-gate — pure fn for DONE gate reference check (B-cf60 CHK-003).
 *
 * Reads the per-story `declared-artifacts.json` and validates every entry's
 * `relatedIntent` against actual references:
 *   - `CHK-NNN:(happy|edge|adversarial):IDX` must point to a real
 *     `checklist.items[*].verificationIntent[lane][idx]` entry.
 *   - `promise:<docPath>` must match an existing
 *     `delivery-check.docsPromises[*].docPath`.
 *
 * preMortem #2 anchor — bogus intentRefs such as `X-001:happy:0` are caught at
 * this layer because we explicitly resolve the reference, not just check the
 * field is non-empty.
 *
 * Empty `entries[]` returns `{ total: 0, unreferenced: [] }` — gate caller
 * treats that as informational-only and never blocks.
 */

import type { ChecklistData, DeclaredArtifactsData, DeliveryCheckData } from './types.js';

export interface DeclaredArtifactRefResult {
  total: number;
  unreferenced: Array<{ path: string; relatedIntent: string; reason: string }>;
}

const INTENT_REF_RE = /^CHK-\d+:(?:happy|edge|adversarial):\d+$/;

/**
 * Parses `CHK-NNN:lane:idx` → returns itemId/lane/idx; returns null if not in this form.
 */
export function parseIntentRef(ref: string): { itemId: string; lane: 'happy' | 'edge' | 'adversarial'; index: number } | null {
  if (typeof ref !== 'string' || !INTENT_REF_RE.test(ref)) return null;
  const [itemId, lane, idxStr] = ref.split(':');
  return { itemId, lane: lane as 'happy' | 'edge' | 'adversarial', index: Number(idxStr) };
}

/**
 * Does the given intentRef point to an actual verificationIntent slot?
 *
 * Acceptance is "intentRef exists in checklist or verificationEvidence" — so a
 * declared artifact can be referenced either by raw intentRef shape OR by a
 * recorded evidence entry pointing at the same ref. The DONE gate trusts
 * verificationIntent[lane][index] existence; the gate is NOT also requiring
 * evidence on the intent (that's the test-coverage reviewer's job).
 */
export function intentRefExistsInChecklist(ref: string, checklist: ChecklistData | null): boolean {
  if (!checklist) return false;
  const parsed = parseIntentRef(ref);
  if (!parsed) return false;
  const item = checklist.items.find((i) => i.id === parsed.itemId);
  if (!item) return false;
  const lane = item.verificationIntent?.[parsed.lane];
  if (!Array.isArray(lane)) return false;
  return parsed.index >= 0 && parsed.index < lane.length;
}

/**
 * Does the given `promise:<docPath>` ref match any delivery-check.docsPromises?
 */
export function promiseRefExistsInDelivery(ref: string, delivery: DeliveryCheckData | null): boolean {
  if (!delivery) return false;
  if (typeof ref !== 'string' || !ref.startsWith('promise:')) return false;
  const docPath = ref.slice('promise:'.length).trim();
  if (!docPath) return false;
  return delivery.docsPromises.some((p) => p.docPath === docPath);
}

/**
 * Pure fn evaluating the DONE-gate declared-artifacts-referenced row.
 *
 * Returns total declared count and the list of entries whose `relatedIntent`
 * does not resolve to an actual checklist verificationIntent slot or a
 * delivery-check docsPromise entry.
 *
 * Callers (buildDoneChecklist) decide row.status / blocking from the returned
 * `unreferenced` length.
 */
export function evaluateDeclaredArtifactReferences(
  declared: DeclaredArtifactsData,
  checklist: ChecklistData | null,
  delivery: DeliveryCheckData | null,
): DeclaredArtifactRefResult {
  const entries = Array.isArray(declared?.entries) ? declared.entries : [];
  const unreferenced: DeclaredArtifactRefResult['unreferenced'] = [];
  for (const entry of entries) {
    const ref = typeof entry?.relatedIntent === 'string' ? entry.relatedIntent.trim() : '';
    const matched =
      intentRefExistsInChecklist(ref, checklist) ||
      promiseRefExistsInDelivery(ref, delivery);
    if (!matched) {
      unreferenced.push({
        path: entry.path,
        relatedIntent: ref,
        reason: entry.reason || '',
      });
    }
  }
  return { total: entries.length, unreferenced };
}
