/**
 * Machine helpers extracted out of machine.ts to satisfy the "Machine = pure
 * config object, zero function definitions" rule (CLAUDE.md §code-paradigm).
 *
 * These helpers back the xstate guards in machine.ts as well as the handler-
 * layer preflight logic in handlers/phase-gates.ts. They perform I/O
 * (store.readStory / store.readReview / store.readFindings / store.readChecklist
 * / store.readTestEvidence / store.readBugs / loadConfig) and so deliberately
 * do NOT live in machine.ts.
 *
 * See B-c351 F-006 for the extraction rationale.
 */

import { createActor } from 'xstate';
import { createHash } from 'crypto';
import type { StoryStore } from './store.js';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
import { verifyFinding } from './finding-verify.js';
import type { Finding } from './types.js';
import { evaluateReviewVerdict, storyMachine, type StoryMachineContext } from './machine.js';
import { isFindingBlocking } from './advisory.js';
import { isTerminalChecklistStatus } from './checklist-status.js';

/**
 * Resolve effective blocking severities with round decay.
 * Round count is derived from story events (how many times the story entered REVIEW phase),
 * not from review.json which also contains PLAN-phase story_review entries.
 */
export function resolveEffectiveBlockingSeverities(
  store: StoryStore,
  storyId: string,
  policy: { review: { blockingSeverities: readonly string[] | string[] } },
): { effectiveBlockingSeverities: string[]; roundCount: number } {
  let roundCount = 1;
  try {
    const story = store.readStory(storyId);
    if (story.events) {
      const reviewEntries = story.events.filter(
        (e: any) => e.phase === 'REVIEW' && e.action === 'advance',
      );
      roundCount = reviewEntries.length || 1;
    }
  } catch { /* fallback to 1 */ }

  let effectiveBlockingSeverities: string[];
  if (roundCount >= 3) {
    effectiveBlockingSeverities = ['critical'];
  } else if (roundCount >= 2) {
    effectiveBlockingSeverities = ['critical', 'high'];
  } else {
    effectiveBlockingSeverities = policy.review.blockingSeverities as string[];
  }
  return { effectiveBlockingSeverities, roundCount };
}

export function createStoryActor(
  storyId: string,
  store: StoryStore,
  restoredState?: string,
  projectRoot?: string,
) {
  const context: StoryMachineContext = { storyId, store, projectRoot: projectRoot ?? process.cwd() };

  if (restoredState) {
    const snapshot = storyMachine.resolveState({
      value: restoredState,
      context,
    });
    return createActor(storyMachine, { snapshot, input: context });
  }

  return createActor(storyMachine, { input: context });
}

export function getStateName(actor: ReturnType<typeof createActor<typeof storyMachine>>): string {
  const snapshot = actor.getSnapshot();
  return typeof snapshot.value === 'string' ? snapshot.value : JSON.stringify(snapshot.value);
}

export function getGuardFailureReason(
  storyId: string,
  store: StoryStore,
  targetPhase: string,
  projectRoot?: string,
): string | null {
  // B-e71f F-006/F-012: INIT_CHECK branch has been migrated out of this file.
  // Historical status: the entire guard-utils.ts file is not imported by any source (grep `from.*guard-utils` only hits CLAUDE.md path docs),
  // the source of truth for INIT_CHECK is getGuardFailureReason in machine.ts (called by resolveGuardFailure in phase-gates.ts to render failure messages) +
  // the canEnterInitCheck guard (actor.can() decides transition). Removing the dead branch here eliminates a DRY violation.
  // Other branches (DEV/REVIEW/TEST/DONE) are kept for now — they are also dead code but are historical leftovers outside B-e71f scope.

  if (targetPhase === 'DEV') {
    // First check whether to take the express channel from INIT_CHECK
    const story = store.readStory(storyId);
    if (story.phase === 'INIT_CHECK') {
      // Express channel failure reasons — read WorkflowPolicy
      const reasons: string[] = [];
      try {
        const config = loadConfig(projectRoot);
        const policy = resolveWorkflowPolicy(config, story);
        if (!policy.quickPath.enabled) {
          reasons.push(`Current profile=${policy.profile} disables the express channel`);
        } else {
          if (!policy.quickPath.allowRiskSignals && story.riskSignals && story.riskSignals.length > 0) {
            reasons.push(`Has high-risk signals (${story.riskSignals.map(r => r.category).join(', ')}), must go through full PLAN`);
          }
          try {
            const cl = store.readChecklist(storyId);
            if (cl.items.length > policy.quickPath.maxChecklistItems) {
              reasons.push(`checklist has ${cl.items.length} items (> ${policy.quickPath.maxChecklistItems}), must go through full PLAN`);
            }
          } catch {
            reasons.push('No checklist, must first story_advance PLAN');
          }
        }
      } catch {
        reasons.push('Unable to load config, must go through full PLAN');
      }
      if (reasons.length > 0) {
        return `Cannot skip PLAN:\n${reasons.map(r => `  - ${r}`).join('\n')}\n→ story_advance '{"storyId":"${storyId}","phase":"PLAN"}' to enter full PLAN flow`;
      }
    }

    // Normal PLAN → DEV path: requires story_review to pass (unless policy does not require it)
    try {
      const config2 = loadConfig(projectRoot);
      const story2 = store.readStory(storyId);
      const policy2 = resolveWorkflowPolicy(config2, story2);
      if (!policy2.plan.requireStoryReview) {
        // policy says no review needed — pass through
      } else {
        const reasons: string[] = [];
        try {
          const review = store.readReview(storyId);
          if (!review || !review.reviews || review.reviews.length === 0) {
            reasons.push('story_review not passed (no review record)');
          } else {
            const lastRound = review.reviews[review.reviews.length - 1];
            const REVIEW_SALT = 'lattice-review-integrity-v1';
            const hashInput = `${storyId}:${lastRound.timestamp}:${lastRound.issueCount}:${lastRound.blockerCount ?? lastRound.issueCount}:${REVIEW_SALT}`;
            const expectedHash = createHash('sha256').update(hashInput).digest('hex');
            if (!lastRound._hash || lastRound._hash !== expectedHash) {
              reasons.push('review.json signature verification failed, review report must be generated by the story_review CLI');
            } else if ((lastRound.blockerCount ?? lastRound.issueCount) > 0) {
              reasons.push(`The most recent story_review round has ${lastRound.blockerCount ?? lastRound.issueCount} unresolved blockers`);
            }
          }
        } catch {
          reasons.push('story_review not passed (no review record)');
        }
        if (reasons.length > 0) {
          return `Cannot enter DEV:\n${reasons.map(r => `  - ${r}`).join('\n')}`;
        }
      }
    } catch {
      // config load failed — fall through (don't block on config error)
    }
  }

  if (targetPhase === 'REVIEW') {
    const cl = store.readChecklist(storyId);
    // B-1909 CHK-002: withdrawn items are terminal, not outstanding.
    const pending = cl.items.filter(i => !isTerminalChecklistStatus(i.status));
    if (pending.length > 0) {
      return `Cannot enter REVIEW: ${pending.length} checklist item(s) not done: ${pending.map(i => i.id).join(', ')}`;
    }
  }

  if (targetPhase === 'TEST') {
    const verdict = evaluateReviewVerdict({ storyId, store, projectRoot: projectRoot ?? process.cwd() });
    if (!verdict.ok) return `Cannot enter TEST: ${verdict.message ?? verdict.code ?? 'review verdict blocked'}`;
  }

  if (targetPhase === 'DONE') {
    const evidence = store.readTestEvidence(storyId);
    if (!evidence) {
      return 'Cannot enter DONE: no test evidence (run lattice validate first)';
    }
    if (evidence.result !== 'PASS') {
      return `Cannot enter DONE: test ${evidence.result}: ${evidence.output}`;
    }
    const bugs = store.readBugs(storyId);
    const openBugs = bugs.bugs.filter(b => b.status !== 'fixed');
    if (openBugs.length > 0) {
      return `Cannot enter DONE: ${openBugs.length} unfixed bug(s): ${openBugs.map(b => b.id).join(', ')}`;
    }
  }

  return null;
}
