/**
 * Delivery Check hash — core signature primitives for delivery-check.json.
 *
 * This module is the single source of truth for the delivery-check.json
 * signature algorithm. It lives in core/ (depends only on StoryStore + crypto)
 * so that core consumers (done-oracle.ts, machine.ts) can verify the hash
 * without an upward core→handlers import. The delivery_check_set handler
 * (handlers/delivery-check.ts) re-uses these same functions.
 *
 * Signature domain for new writes: storyId + JSON.stringify(docsPromises)
 *          + JSON.stringify(realMachineTests) + JSON.stringify(closingSelfCheck)
 *          + reviewRound + materialHash + storyFilesHash + salt
 *
 * storyFilesHash is folded into the signature so the DONE-gate drift-advisory
 * downgrade (whole-tree materialHash drift accepted when story-owned files are
 * unchanged) cannot be forged by editing an unsigned field.
 *
 * waiverReason (≥ 30 characters) is included in JSON.stringify of realMachineTests / docsPromises,
 * automatically incorporated into the signature.
 */

import { createHash } from 'crypto';
import type { StoryStore } from './store.js';
import type { DocsPromise, RealMachineTest, ClosingSelfCheck } from './types.js';
import { currentMaterialHash, currentStoryFilesHash, EMPTY_STORY_FILES_HASH } from './evidence-freshness.js';

export const DELIVERY_CHECK_SALT = 'proof-or-stop-delivery-check-integrity-v1';

/**
 * Signing function (deterministic: same input yields same output).
 *
 * Signature domain: storyId / docsPromises(JSON) / realMachineTests(JSON) /
 * closingSelfCheck(JSON) / reviewRound / materialHash / storyFilesHash + salt.
 *
 * materialHash and storyFilesHash are optional and appended only when present,
 * so legacy delivery-check fixtures (without either) recompute byte-identically
 * and stay recognizable as untampered; DONE freshness gates reject a missing
 * materialHash as stale. storyFilesHash is signed so the drift-advisory
 * downgrade keyed on it is non-forgeable.
 */
export function signDeliveryCheck(
  storyId: string,
  docsPromises: DocsPromise[],
  realMachineTests: RealMachineTest[],
  closingSelfCheck: ClosingSelfCheck,
  reviewRound: string,
  materialHash?: string,
  storyFilesHash?: string,
): string {
  const payload = [
    storyId,
    JSON.stringify(docsPromises),
    JSON.stringify(realMachineTests),
    JSON.stringify(closingSelfCheck),
    reviewRound,
    ...(materialHash ? [materialHash] : []),
    ...(storyFilesHash ? [storyFilesHash] : []),
    DELIVERY_CHECK_SALT,
  ].join(':');
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Recompute entry reused on the gate side: read delivery-check.json, take its fields and re-sign,
 * compare _hash to determine whether it has been tampered with.
 */
export function recomputeDeliveryCheckHash(storyId: string, store: StoryStore): string | null {
  const data = store.readDeliveryCheck(storyId);
  if (!data) return null;
  return signDeliveryCheck(
    data.storyId,
    data.docsPromises,
    data.realMachineTests,
    data.closingSelfCheck,
    data.reviewRound,
    data.materialHash,
    data.storyFilesHash,
  );
}

export type DeliveryCheckFreshnessCode =
  | 'delivery_check_passed'
  | 'delivery_check_drift_advisory'
  | 'missing_delivery_check'
  | 'delivery_check_tampered'
  | 'stale_delivery_check';

interface DeliveryCheckFreshnessResultBase {
  ok: boolean;
  reason: string;
  deliveryCheck: ReturnType<StoryStore['readDeliveryCheck']>;
  expectedHash: string | null;
  currentMaterialHash?: string;
  currentStoryFilesHash?: string;
}

/**
 * B-d243 F-001: discriminated union so the drift-advisory variant CANNOT be
 * constructed without its mandatory loud advisory text. A
 * delivery_check_drift_advisory result with an absent/empty advisory is a type
 * error at the construction site (and, for the consumer, advisory is a non-empty
 * string by the type), so the gate can never silently swallow the re-attestation
 * warning. Every other code variant has no advisory field.
 */
export type DeliveryCheckFreshnessResult =
  | (DeliveryCheckFreshnessResultBase & {
      code: 'delivery_check_drift_advisory';
      /** Mandatory loud advisory text; required by the type for this variant. */
      advisory: string;
    })
  | (DeliveryCheckFreshnessResultBase & {
      code: Exclude<DeliveryCheckFreshnessCode, 'delivery_check_drift_advisory'>;
      advisory?: undefined;
    });

export function evaluateDeliveryCheckFreshness(
  storyId: string,
  store: StoryStore,
  gitCwd: string,
  metadataRoot: string = gitCwd,
): DeliveryCheckFreshnessResult {
  const deliveryCheck = store.readDeliveryCheck(storyId);
  if (!deliveryCheck) {
    return {
      ok: false,
      code: 'missing_delivery_check',
      reason: 'Missing delivery-check.json (requires proof-or-stop-review-delivery reviewer signature)',
      deliveryCheck,
      expectedHash: null,
    };
  }

  const expectedHash = recomputeDeliveryCheckHash(storyId, store);
  if (expectedHash === null || deliveryCheck._hash !== expectedHash) {
    return {
      ok: false,
      code: 'delivery_check_tampered',
      reason: 'delivery-check.json _hash mismatch',
      deliveryCheck,
      expectedHash,
    };
  }

  if (!deliveryCheck.materialHash) {
    return {
      ok: false,
      code: 'stale_delivery_check',
      reason: 'stale delivery-check: delivery-check.json is missing materialHash binding',
      deliveryCheck,
      expectedHash,
    };
  }

  const materialHash = currentMaterialHash(gitCwd, 'HEAD', metadataRoot);
  if (!materialHash) {
    return {
      ok: false,
      code: 'stale_delivery_check',
      reason: 'stale delivery-check: current materialHash could not be computed',
      deliveryCheck,
      expectedHash,
    };
  }

  if (materialHash !== deliveryCheck.materialHash) {
    // storyFilesHash secondary-freshness downgrade (decision: story-files-hash-material-drift,
    // DONE Sub-Gate amendment). The reviewer's signed attestation covers the story's own
    // diff/doc-promises; when the whole-tree materialHash drifts (e.g. an unrelated main
    // merge) but the SIGNED storyFilesHash still matches the current story-owned file state,
    // the diff the reviewer signed is byte-identical, so the gate downgrades to a MANDATORY
    // re-attestation advisory instead of rejecting as stale. The stored record is never
    // rebound. A missing storyFilesHash (legacy) or a mismatch (story-owned change) keeps
    // the strict stale behavior. storyFilesHash is inside _hash, so it cannot be forged.
    //
    // B-d243 (host-2 soundness fix): defensively guard against the EMPTY-set hash
    // on BOTH sides. currentStoryFilesHash returns sha256('') for an empty
    // story-owned diff (HEAD on main / story resolved on main); that value
    // vouches for NOTHING. delivery_check_set already drops the empty-set value
    // at sign time, but this gate must also refuse to downgrade when either the
    // stored or the current storyFilesHash is the empty-set hash — otherwise a
    // record that attested no story diff could re-match under whole-tree drift
    // and wrongly take the advisory. An empty-set stored or current hash keeps
    // strict stale.
    if (deliveryCheck.storyFilesHash && deliveryCheck.storyFilesHash !== EMPTY_STORY_FILES_HASH) {
      const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', metadataRoot);
      if (
        storyFilesHash &&
        storyFilesHash !== EMPTY_STORY_FILES_HASH &&
        storyFilesHash === deliveryCheck.storyFilesHash
      ) {
        return {
          ok: true,
          code: 'delivery_check_drift_advisory',
          reason: `delivery-check storyFilesHash matches current story-owned files; whole-tree materialHash drift (recorded ${deliveryCheck.materialHash.slice(0, 12)}, current ${materialHash.slice(0, 12)}) requires re-attestation advisory`,
          advisory: 'whole-tree materialHash drift detected while the signed delivery-check storyFilesHash matches; the story diff the reviewer attested is unchanged. Re-attestation advisory: re-run the proof-or-stop-review-delivery reviewer if the merged-in (non-story) code could affect the real-machine test claims.',
          deliveryCheck,
          expectedHash,
          currentMaterialHash: materialHash,
          currentStoryFilesHash: storyFilesHash,
        };
      }
    }
    return {
      ok: false,
      code: 'stale_delivery_check',
      reason: `stale delivery-check: materialHash mismatch (recorded ${deliveryCheck.materialHash.slice(0, 12)}, current ${materialHash.slice(0, 12)})`,
      deliveryCheck,
      expectedHash,
      currentMaterialHash: materialHash,
    };
  }

  return {
    ok: true,
    code: 'delivery_check_passed',
    reason: 'delivery-check materialHash matches current material',
    deliveryCheck,
    expectedHash,
    currentMaterialHash: materialHash,
  };
}
