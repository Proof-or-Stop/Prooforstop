/**
 * Dependency-free owner hints for the finding closure rule (core/finding-closure.ts),
 * shared by gate messages and status projections without widening their imports.
 */
/** Story phase for hint wording only; an unreadable story yields the phase-neutral hint. */
export function storyPhaseOrUndefined(store: { readStory(storyId: string): { phase: string } }, storyId: string): string | undefined {
  try { return store.readStory(storyId).phase; } catch { return undefined; }
}

export const FINDING_RESOLUTION_PLACEHOLDER = '<repair commit + passing focused evidence>';

/** The exact owner command that closes one finding with its repair evidence. */
export function findingResolveCommand(storyId: string, findingId: string): string {
  return `proof-or-stop finding_resolve --storyId=${storyId} --findingId=${findingId} --resolution="${FINDING_RESOLUTION_PLACEHOLDER}"`;
}

/**
 * One next action naming every unclosed id and the exact resolve command.
 * finding_resolve runs in DEV or REVIEW; from TEST the owner first returns to DEV.
 */
export function findingClosureAction(storyId: string, findingIds: readonly string[], phase?: string): string {
  const ids = [...new Set(findingIds)];
  const command = findingResolveCommand(storyId, ids[0] ?? '<findingId>');
  const prefix = phase === 'TEST' ? `proof-or-stop story_advance --storyId=${storyId} --phase=DEV, then ` : '';
  const each = ids.length > 1 ? `; repeat for each of ${ids.join(', ')}` : '';
  return `${prefix}${command} (close verified blocking finding ${ids.join(', ')} with its repair evidence${each}; closure is required whichever review round raised it)`;
}

/** The same action as one `Next:` line. */
export function findingClosureNextAction(storyId: string, findingIds: readonly string[], phase?: string): string {
  return `Next: ${findingClosureAction(storyId, findingIds, phase)}`;
}
