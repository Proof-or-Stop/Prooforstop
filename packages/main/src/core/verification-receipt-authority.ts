/** Exact execution identity shared by remediation and progress observation. */
import type { StoryStore } from './store.js';
import type { ChecklistItem, VerificationEvidence } from './types.js';
import { canonicalDigest } from './authority-signing.js';
import { createCausalExecutionKey, verifyCausalEvidenceReceipt } from './causal-evidence.js';
import { collectVerificationIntents } from './verification.js';

export function hasMechanicalExecutionAuthority(store: StoryStore, storyId: string, item: ChecklistItem, evidence: VerificationEvidence): boolean {
  const executed = evidence.receipt;
  const pin = collectVerificationIntents(item).find(i => i.ref === evidence.intentRef)?.intent.verification;
  if (evidence.mechanical !== true || evidence.result !== 'pass' || evidence.kind === 'waiver'
    || !executed || executed.exitCode !== 0 || executed.selectorMatched !== true
    || !pin || pin.command !== evidence.command || pin.selector !== executed.selector) return false;
  const causal = executed.executionKey ? store.readCausalEvidenceReceipt(storyId, executed.executionKey) : undefined;
  if (!causal || !verifyCausalEvidenceReceipt(causal, executed.executionKey) || causal.storyId !== storyId
    || causal.receiptHash !== executed.causalReceiptHash || causal.status !== 'pass' || causal.exitCode !== 0
    || causal.outputDigest !== executed.outputDigest || causal.executedAt !== executed.executedAt
    || !executed.selector || !(causal.outputProbe.includes(executed.selector) || causal.outputTail.includes(executed.selector))
    || !evidence.command || canonicalDigest(createCausalExecutionKey({ ...causal.identity, command: evidence.command }).identity.command) !== canonicalDigest(causal.identity.command)
    || (causal.identity.inputs as Record<string, unknown>)?.materialHash !== evidence.materialHash
    || causal.identity.storyFilesHash !== evidence.storyFilesHash) return false;
  return true;
}
