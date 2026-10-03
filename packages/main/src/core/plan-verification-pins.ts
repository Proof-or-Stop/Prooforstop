/**
 * PLAN requires a pinned verifier on every executable must/should intent
 * (run 16): without pins, DEV could not batch receipts (`verification_run
 * --pending` covers pinned intents only), the owner hand-authored 32 receipts
 * (5.3 min, 15 quoting failures), and the evidence chain had to guess which
 * changed test proves which intent. The owner knows the test names in PLAN:
 * the implementer prompt lists the pins and requires exactly these names.
 *
 * Exempt: manual/docs intents (not executable) and nice-priority intents.
 * Paths that skip story_review (express channel, light profile) can still reach
 * DEV unpinned; there the evidence chain emits one agent-authored
 * verification_evidence_batch_add.
 */
import type { ChecklistData, ChecklistItem } from './types.js';
import { collectVerificationIntents, isExecutableIntentType } from './verification.js';

export const MISSING_VERIFICATION_PIN = 'missing_verification_pin';

/** Executable must/should intents of one item without verification:{command,selector}. */
export function unpinnedPlanIntents(item: ChecklistItem): Array<{ ref: string; priority: string; type: string }> {
  return collectVerificationIntents(item)
    .filter(entry => isExecutableIntentType(entry.intent.type))
    .filter(entry => (entry.intent.priority ?? 'must') === 'must' || entry.intent.priority === 'should')
    .filter(entry => !entry.intent.verification?.command?.trim() || !entry.intent.verification?.selector?.trim())
    .map(entry => ({ ref: entry.ref, priority: entry.intent.priority ?? 'must', type: entry.intent.type }));
}

/** One story_review blocker per item with unpinned executable must/should intents. */
export function missingVerificationPinIssues(storyId: string, checklist: ChecklistData): Array<{ type: string; severity: 'blocker'; itemId: string; message: string }> {
  return checklist.items
    .filter(item => item.status !== 'withdrawn')
    .flatMap(item => {
      const unpinned = unpinnedPlanIntents(item);
      if (unpinned.length === 0) return [];
      const example = JSON.stringify({ verification: { command: 'go test -v ./pkg -run ^TestStepSlice$', selector: '--- PASS: TestStepSlice' } }).slice(1, -1);
      return [{
        type: MISSING_VERIFICATION_PIN,
        severity: 'blocker' as const,
        itemId: item.id,
        message: `${MISSING_VERIFICATION_PIN}: ${item.id} has executable must/should intents without a pinned verifier: `
          + `${unpinned.map(row => `${row.ref} (${row.priority}, ${row.type})`).join(', ')}. `
          + `Pin each in PLAN: proof-or-stop checklist_update '{"storyId":"${storyId}","itemId":"${item.id}","verificationIntent":{...}}' with the same intents, each carrying ${example} `
          + '(executable and argv, no shell; the test may not exist yet, the implementer is told to use exactly these test names). '
          + `With pins, DEV records every receipt in one \`proof-or-stop verification_run '{"storyId":"${storyId}","pending":true}'\` and no test has to be matched to an intent afterwards.`,
      }];
    });
}
