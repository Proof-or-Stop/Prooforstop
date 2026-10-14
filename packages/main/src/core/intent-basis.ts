/**
 * Lab round-cut N4c (bench-staging/oldpos/run74-75-analysis.md §4 refusal 2, §7 N4 (c)): an authoring
 * payload must not overwrite a newer row fix.
 *
 * Run 75: the owner fixed CHK-002:adversarial:1 after a pin-probe refusal (01:59:03); a PLAN
 * authoring batch built from the earlier rows was applied a minute later (02:00:48-02:01:03) and put
 * the old desc back, so the probe refused the same row a second time. A whole-intent
 * `checklist_update` that `next` builds from the item's current rows (the `plan_authoring` step)
 * now carries `intentBasis`, the digest of the verificationIntent it was built from; checklist_update
 * refuses the payload when the item's rows changed since (`[authoring_payload_stale]`, ONE Next:
 * `next --run`, which rebuilds the step from the current rows). Payloads without `intentBasis` (the
 * owner's own edits) are unaffected.
 */
import { digestCanonicalJson } from './digest.js';

export const AUTHORING_PAYLOAD_STALE = 'authoring_payload_stale';

/** The basis digest of an item's verificationIntent (16 hex characters; undefined intent = the empty one). */
export function intentBasisDigest(intent: unknown): string {
  return digestCanonicalJson(intent ?? { happy: [], edge: [], adversarial: [] }).slice(0, 16);
}

/** The refusal of a payload built from older rows than the item now has, or null. */
export function intentBasisRefusal(args: { storyId: string; itemId: string; currentIntent: unknown; basis: string | undefined }): string | null {
  if (!args.basis) return null;
  if (intentBasisDigest(args.currentIntent) === args.basis) return null;
  return `checklist_update refused: this payload was built from ${args.itemId}'s intent rows as they stood earlier (intentBasis ${args.basis}); the rows changed since (a newer fix), and applying the whole intent would overwrite it [${AUTHORING_PAYLOAD_STALE}]\n`
    + `Next: proof-or-stop next --storyId=${args.storyId} --run`;
}
