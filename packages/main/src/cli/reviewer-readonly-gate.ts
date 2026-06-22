import {
  type ActiveStoryForOwnershipGate,
  resolveEffectiveOwnershipClass,
  storyIdFromArgs,
} from './ownership-gate.js';

export const REVIEWER_READONLY_ENV = 'LATTICE_REVIEWER_READONLY';

export function isReviewerReadOnlyModeEnabled(): boolean {
  return process.env[REVIEWER_READONLY_ENV] === '1';
}

export function enforceReviewerReadOnlyCommandGate(
  cmd: string,
  args: Record<string, unknown>,
  activeStory: ActiveStoryForOwnershipGate | null,
): void {
  if (!isReviewerReadOnlyModeEnabled()) return;

  const storyId = storyIdFromArgs(args, activeStory);
  const cls = resolveEffectiveOwnershipClass(cmd, args, storyId);

  if (cls === 'readOnly') return;

  const clsLabel = cls === null ? 'unclassified' : cls;
  throw new Error(
    `[${REVIEWER_READONLY_ENV}=1] Command "${cmd}" is not allowed in read-only reviewer mode ` +
    `(effective ownershipClass: ${clsLabel}). ` +
    `Advisory read-only reviewers may only run read-only Lattice commands and should return ` +
    `structured findings to the story owner. ` +
    `To run write commands, unset ${REVIEWER_READONLY_ENV} and ensure you are the story owner.`,
  );
}
