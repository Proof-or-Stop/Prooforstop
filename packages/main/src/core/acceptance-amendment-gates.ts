import type { StoryStore } from './store.js';
import type { ChecklistItem, ScopeContractData } from './types.js';
import { collectVerificationIntents } from './verification.js';
import { acceptanceAmendmentBlocker } from './acceptance-amendment-journal.js';
import { canonicalDigest } from './authority-signing.js';
import { pathMatchesScopePattern } from './scope-path-classifier.js';

// Literal scope entries authorize descendants, so matching one path against a glob
// cannot prove that the whole replacement language is contained.
export function scopeEntryContained(path: string, allowed: string[]): boolean {
  return allowed.includes(path) || (!/[*?[\]{}]/.test(path) && allowed.some(pattern => !/[*?[\]{}]/.test(pattern) && pathMatchesScopePattern(path, pattern)));
}

export function missingAcceptance(item: ChecklistItem): boolean {
  return collectVerificationIntents(item).length === 0 && (item.verificationEvidence?.length ?? 0) === 0;
}
export function acceptanceCompletionBlocker(store: StoryStore, storyId: string, root: string): string | null {
  const pending = acceptanceAmendmentBlocker(store, storyId, root);
  if (pending) return pending;
  try {
    const empty = store.readChecklist(storyId).items.filter(i => i.status === 'done' && missingAcceptance(i));
    return empty.length ? `Acceptance verification missing: done item(s) have zero intent and zero evidence: ${empty.map(i => i.id).join(', ')}. Return to DEV and propose an additive acceptance amendment.` : null;
  } catch (error) { return `Acceptance verification invalid: ${error instanceof Error ? error.message : String(error)}`; }
}

/** Frozen DEV scope can be narrowed or initialized from existing declarations, never silently expanded. */
export function assertAcceptanceScopeReplacementAllowed(store: StoryStore, storyId: string, next: ScopeContractData, root: string): void {
  if (!['DEV', 'REVIEW', 'TEST', 'DONE'].includes(store.readStory(storyId).phase)) return;
  const blocker = acceptanceAmendmentBlocker(store, storyId, root);
  if (blocker) throw new Error(blocker);
  const previous = store.readScopeContract(storyId); // Corruption is not authority for a new scope.
  const declared = store.readChecklist(storyId).items.filter(i => i.status !== 'withdrawn');
  for (const [key, kind] of [['allowedModify', 'modify'], ['allowedCreate', 'create'], ['allowedTest', 'test']] as const) {
    const allowed = previous?.[key] ?? declared.flatMap(i => i.files?.[kind] ?? []);
    if (next[key].some(path => !scopeEntryContained(path, allowed))) {
      throw new Error('DEV scope growth requires acceptance_amendment_propose and independent approval in DEV');
    }
  }
  if (previous && (['protectedFiles', 'explicitExcludes', 'protectedAnchors'] as const).some(key => (previous[key] ?? []).some(path => !(next[key] ?? []).includes(path)))) {
    throw new Error('Acceptance amendment cannot weaken existing scope protections');
  }
  if (previous && (['mode', 'fileRules'] as const).some(key => canonicalDigest({ value: previous[key] ?? null }) !== canonicalDigest({ value: next[key] ?? null }))) {
    throw new Error('Frozen scope enforcement changes require an explicit scope decision; additive acceptance amendment cannot weaken them');
  }
}
