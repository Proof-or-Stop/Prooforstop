import {execFileSync} from 'node:child_process';
import {canonicalJson} from './digest.js';
import {observedGit} from './git-tree-observation.js';
import type {ReviewRun, StoryInfo} from './types.js';

export function evaluatePersistedReviewToTestIndexTransition(
  gitCwd: string,
  indexGitPath: string,
  run: Pick<ReviewRun, 'headHash' | 'storyId' | 'reviewRound'>,
  currentStory: StoryInfo,
): { ok: boolean; reason?: string } {
  let reviewedStory: StoryInfo;
  try {
    const argv = ['show', `${run.headHash}:${indexGitPath}`];
    reviewedStory = JSON.parse(observedGit(gitCwd, argv, () => execFileSync('git', argv, {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }))) as StoryInfo;
  } catch {
    return { ok: false, reason: 'signed REVIEW index snapshot is unreadable' };
  }
  if (reviewedStory.storyId !== run.storyId || currentStory.storyId !== run.storyId) {
    return { ok: false, reason: 'index storyId does not match the signed review run' };
  }
  if (reviewedStory.phase !== 'REVIEW' || currentStory.phase !== 'TEST') {
    return { ok: false, reason: `phase delta is ${reviewedStory.phase}->${currentStory.phase}, not REVIEW->TEST` };
  }
  if (!run.reviewRound || reviewedStory.currentReviewRound !== run.reviewRound || currentStory.currentReviewRound !== run.reviewRound) {
    return { ok: false, reason: 'currentReviewRound changed or does not match the signed review run' };
  }
  const reviewedEvents = reviewedStory.events ?? [];
  const currentEvents = currentStory.events ?? [];
  if (currentEvents.length !== reviewedEvents.length + 1 || canonicalJson(currentEvents.slice(0, -1)) !== canonicalJson(reviewedEvents)) {
    return { ok: false, reason: 'events are not the reviewed prefix plus exactly one transition event' };
  }
  const event = currentEvents.at(-1)!;
  const allowedEventKeys = new Set(['phase', 'action', 'timestamp', 'branch', 'user', 'sessionId', 'agent']);
  if (Object.keys(event).some((key) => !allowedEventKeys.has(key))) {
    return { ok: false, reason: 'transition event contains fields not emitted by collectContext' };
  }
  if (event.phase !== 'TEST' || event.action !== 'advance') {
    return { ok: false, reason: 'transition event is not exactly TEST/advance' };
  }
  // Local event identity/timing strings are cooperative runtime audit context,
  // not writer authentication, and git user.name is legitimately absent in
  // env-only commit setups. They therefore cannot affect retention. Only
  // reject malformed types when a field exists;
  // the gate authority comes from the already-verified signed review
  // run/pass/round plus the exact stable index delta above/below.
  for (const key of ['timestamp', 'branch', 'user', 'sessionId', 'agent'] as const) {
    if (event[key] !== undefined && typeof event[key] !== 'string') {
      return { ok: false, reason: `transition event audit field ${key} is not a string` };
    }
  }
  const { phase: _reviewedPhase, events: _reviewedEvents, ...reviewedStable } = reviewedStory;
  const { phase: _currentPhase, events: _currentEvents, ...currentStable } = currentStory;
  if (canonicalJson(reviewedStable) !== canonicalJson(currentStable)) {
    return { ok: false, reason: 'index fields outside the canonical phase/event delta changed' };
  }
  return { ok: true };
}

