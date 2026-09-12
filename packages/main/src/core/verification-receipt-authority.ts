/** Exact authenticated execution identity shared by remediation and progress observation. */
import type { StoryStore } from './store.js';
import type { ChecklistItem, VerificationEvidence } from './types.js';
import { collectVerificationIntents } from './verification.js';
import { validateVerificationReceipt } from './verification-execution-evidence.js';

export function hasMechanicalExecutionAuthority(store: StoryStore, storyId: string, item: ChecklistItem, evidence: VerificationEvidence): boolean {
  const executed = evidence.receipt;
  const pin = collectVerificationIntents(item).find(i => i.ref === evidence.intentRef)?.intent.verification;
  if (evidence.mechanical !== true || evidence.result !== 'pass' || evidence.kind === 'waiver'
    || !executed || executed.exitCode !== 0 || executed.selectorMatched !== true
    || !pin || !pin.selector || pin.command !== evidence.command || pin.selector !== executed.selector
    || !evidence.headHash || !evidence.materialHash || !evidence.storyFilesHash) return false;
  try {
    const validation = validateVerificationReceipt(store.projectRoot, executed, {
      storyId, intentRef: evidence.intentRef, command: pin.command, selector: pin.selector,
      freshness: { headHash: evidence.headHash, materialHash: evidence.materialHash, storyFilesHash: evidence.storyFilesHash },
    });
    // Readable legacy bundles do not authenticate publication scope or freshness.
    // Reuse eligibility is independent of authority for this recorded execution.
    return validation.ok && validation.kind === 'split-v5';
  } catch {
    return false;
  }
}
