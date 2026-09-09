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

import { verifyFinding } from './finding-verify.js';
import { isReviewerAgent } from './review-run.js';
import { isFindingBlocking } from './advisory.js';
import { findingAgentMatchesReviewer } from './reviewer-opt-in.js';
import { detectMdTouchpointsFromGit } from './touchpoints-fallback.js';
import { computeActiveReviewers } from '../handlers/reviewer-list.js';
import type { Finding } from './types.js';
import { createActor } from 'xstate';
import { createHash } from 'crypto';
import type { StoryStore } from './store.js';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
import { evaluateReviewVerdict, storyMachine, type StoryMachineContext } from './machine.js';
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
            const REVIEW_SALT = 'proof-or-stop-review-integrity-v1';
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
    const config = loadConfig(projectRoot);
    const story = store.readStory(storyId);
    const policy = resolveWorkflowPolicy(config, story);

    // If policy doesn't require reviewer, skip finding checks
    if (!policy.review.requireReviewer) {
      // no review gate — pass through
    } else {
      try {
        const findings = store.readFindings(storyId);
        if (!findings.findings || findings.findings.length === 0) {
          return `Cannot enter TEST: reviewer has not run (findings.json is empty)\n→ Launch reviewer per opt-in results (see proof-or-stop reviewer_list)`;
        }
        if (policy.review.requireReviewerFinding) {
          const currentRound = story.currentReviewRound;
          // B-ad2c F-005: classify reviewer evidence by proof-or-stop-review-* lane prefix
          // (shared isReviewerAgent helper), NOT by `agent != main`. Otherwise
          // main / main-agent / proof-or-stop-implementer findings recorded during DEV
          // are misclassified as reviewer evidence and block REVIEW→TEST when
          // they lack a reviewRunId. Mirrors core/review-run.ts
          // collectReviewerEvidenceState (used by machine.ts canPassReview /
          // getGuardFailureReason — the live story_advance gate).
          const currentRoundReviewerFindings = findings.findings.filter(
            (f: Finding) => isReviewerAgent(f.agent) && verifyFinding(storyId, f)
              // backward compat: do not reject when legacy stories lack currentReviewRound
              && (!currentRound || f.reviewRound === currentRound),
          );

          const { roundCount: rc } = resolveEffectiveBlockingSeverities(store, storyId, policy);
          if (rc <= 1) {
            // Round 1: require findings from every opt-in reviewer (B-e8c8)
            let checklist: { items: unknown[] } = { items: [] };
            try { checklist = store.readChecklist(storyId); } catch {}
            let decision = null;
            try { decision = store.readDecision(storyId); } catch {}
            const understanding = store.readUnderstanding(storyId);
            // F-021: fall back to scanning git diff when touchpoints is empty, to avoid losing the docs reviewer for stories that only modify .md.
            const touchpoints = understanding?.touchpoints
              ?? detectMdTouchpointsFromGit(projectRoot ?? process.cwd());
            const optIn = computeActiveReviewers(story, checklist, decision, touchpoints);
            const missing = optIn.filter(reviewer => !currentRoundReviewerFindings.some(
              (f: Finding) => findingAgentMatchesReviewer(f.agent, reviewer.name),
            ));
            if (missing.length > 0) {
              const names = optIn.map(r => r.name).join(',');
              const missingNames = missing.map(r => r.name).join(',');
              const presentAgents = Array.from(new Set(currentRoundReviewerFindings.map((f: Finding) => f.agent))).join(', ') || 'none';
              return `Cannot enter TEST: Round 1 expects ${optIn.length} reviewer(s) (opt-in: ${names}); currently ${currentRoundReviewerFindings.length} finding(s) cover ${optIn.length - missing.length} reviewer(s) (missing: ${missingNames}; seen agents: ${presentAgents})\n→ Launch the missing proof-or-stop-review-* agents in parallel`;
            }
          } else {
            if (currentRoundReviewerFindings.length === 0) {
              return currentRound
                ? `Cannot enter TEST: Round ${rc} has no reviewer finding in the current review round (${currentRound}); please launch the corresponding proof-or-stop-review-* agent`
                : `Cannot enter TEST: all findings come from the main agent (reviewers did not run)\n→ Launch proof-or-stop-review-* subagents`;
            }
          }
        }
        const { effectiveBlockingSeverities, roundCount } = resolveEffectiveBlockingSeverities(store, storyId, policy);

        // B-e8c8 CHK-007: advisory findings do not count as blockers (same source as canPassReview).
        // B-3fad CHK-001: add evidenceState dimension from the same source — only verified (or legacy missing field) blocks.
        const blocking = findings.findings.filter(
          f => isFindingBlocking(f, effectiveBlockingSeverities, roundCount),
        );
        if (blocking.length > 0) {
          return `Cannot enter TEST: ${blocking.length} blocking finding(s) open (Round ${roundCount}, blocking: ${effectiveBlockingSeverities.join('/')}):\n${blocking.map(f => `  - ${f.id} [${f.severity}] ${f.desc}`).join('\n')}\n→ After fixing run finding_resolve, or to confirm not fixing run finding_dismiss (reason must be ≥10 characters)`;
        }
      } catch {
        return `Cannot enter TEST: reviewers did not run (no findings.json)\n→ Launch reviewers per opt-in result (see proof-or-stop reviewer_list)`;
      }
    }
  }

  if (targetPhase === 'DONE') {
    const evidence = store.readTestEvidence(storyId);
    if (!evidence) {
      return 'Cannot enter DONE: no test evidence (run proof-or-stop validate first)';
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
