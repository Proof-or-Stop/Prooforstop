
import { setup, createActor, type SnapshotFrom } from 'xstate';
import type { StoryStore } from './store.js';
import { createHash } from 'crypto';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
import type { Finding } from './types.js';
import { REQUIRED_INIT_CHECK_AGENTS, blockingInitCheckIssues, missingRequiredInitCheckAgents, recomputeInitCheckHash } from './init-check-gate.js';
import { recomputeDeliveryCheckHash } from './delivery-check-hash.js';
import { getBlockingVerificationEvidenceIssues } from './verification.js';
import { normalizeLegacyPhase } from './phase-flow.js';
import { findingAgentMatchesReviewer } from './reviewer-opt-in.js';
import { detectMdTouchpointsFromGit } from './touchpoints-fallback.js';
import { computeActiveReviewers } from '../handlers/reviewer-list.js';
import { collectReviewerEvidenceState } from './review-run.js';
import { isFindingBlocking } from './advisory.js';
import { evaluateReviewerQuorum } from './reviewer-quorum.js';
import type { ReviewerEvidenceEntry } from './reviewer-quorum.js';

/**
 * Resolve effective blocking severities with round decay.
 * Round count is derived from story events (how many times the story entered REVIEW phase),
 * not from review.json which also contains PLAN-phase story_review entries.
 */
function resolveEffectiveBlockingSeverities(
  store: StoryStore, storyId: string, policy: { review: { blockingSeverities: readonly string[] | string[] } }
): { effectiveBlockingSeverities: string[]; roundCount: number } {
  let roundCount = 1;
  try {
    const story = store.readStory(storyId);
    if (story.events) {
      const reviewEntries = story.events.filter(
        (e: any) => e.phase === 'REVIEW' && e.action === 'advance'
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

function buildQuorumEvidence(
  evidenceRecords: { agent: string; kind: string; signatureValid?: boolean }[],
): ReviewerEvidenceEntry[] {
  return evidenceRecords.map(e => ({
    lane: e.agent,
    agent: e.agent,
    // Production finding severity/round-decay remains owned by the existing
    // isFindingBlocking section; quorum only needs lane coverage here.
    kind: 'pass',
    signatureValid: e.signatureValid,
  }));
}

export interface StoryMachineContext {
  storyId: string;
  store: StoryStore;
  projectRoot: string;
}

export const storyMachine = setup({
  types: {
    context: {} as StoryMachineContext,
    input: {} as StoryMachineContext,
    events: {} as
      | { type: 'INIT' }
      | { type: 'INIT_CHECK' }
      | { type: 'PLAN' }
      | { type: 'START' }
      | { type: 'REPLAN' }
      | { type: 'CODE_REVIEW' }
      | { type: 'REVIEW_PASS' }
      | { type: 'FINISH' },
  },
  guards: {
    checklistAllDone: ({ context }) => {
      const cl = context.store.readChecklist(context.storyId);
      if (!cl.items.every(item => item.status === 'done')) return false;
      const story = context.store.readStory(context.storyId);
      const policy = resolveWorkflowPolicy(loadConfig(context.projectRoot), story);
      return getBlockingVerificationEvidenceIssues(cl, undefined, policy.profile).length === 0;
    },
    // B-e71f CHK-006: xstate-side fallback for the INIT→INIT_CHECK hard gate.
    // getGuardFailureReason in phase-gates.ts is only invoked by resolveGuardFailure when actor.can() returns false,
    // so a guard must be attached to the INIT→INIT_CHECK transition here; otherwise can() will always be true and the gate will never fire.
    // The guard and getGuardFailureReason share the same decision logic: missing init-check.json → false;
    // _hash mismatch → false; pass → true. The failure reason is rendered as a human-readable message by getGuardFailureReason.
    canEnterInitCheck: ({ context }) => {
      try {
        const story = context.store.readStory(context.storyId);
        if (story.phase !== 'INIT') return true; // Other sources such as IDEA→INIT_CHECK are not gated
        const initCheck = context.store.readInitCheck(context.storyId);
        if (!initCheck) return false;
        const expected = recomputeInitCheckHash(context.storyId, context.store, context.projectRoot);
        return initCheck._hash === expected
          && missingRequiredInitCheckAgents(initCheck).length === 0
          && blockingInitCheckIssues(initCheck).length === 0;
      } catch (err) {
        // B-e71f F-016: xstate guard must not throw (it would push the actor into the error state), but going completely silent
        // would swallow the underlying store exceptions (fs read failure / json parse failure / recompute path bug)——
        // the user would only see the gate rejection without any diagnostics. console.warn here does not affect the guard return value.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[canEnterInitCheck] ${context.storyId}: ${msg}`);
        return false;
      }
    },
    canStartDev: ({ context }) => {
      // Passing story_review is a prerequisite for entering DEV (unless policy does not require it)
      try {
        const config = loadConfig(context.projectRoot);
        const story = context.store.readStory(context.storyId);
        const policy = resolveWorkflowPolicy(config, story);
        if (!policy.plan.requireStoryReview) return true;
        const review = context.store.readReview(context.storyId);
        if (!review || !review.reviews || review.reviews.length === 0) return false;
        const lastRound = review.reviews[review.reviews.length - 1];
        const REVIEW_SALT = 'koala-review-integrity-v1';
        const hashInput = `${context.storyId}:${lastRound.timestamp}:${lastRound.issueCount}:${lastRound.blockerCount ?? lastRound.issueCount}:${REVIEW_SALT}`;
        const expectedHash = createHash('sha256').update(hashInput).digest('hex');
        if (!lastRound._hash || lastRound._hash !== expectedHash) return false;
        return (lastRound.blockerCount ?? lastRound.issueCount) === 0;
      } catch {
        return false;
      }
    },
    canSkipPlan: ({ context }) => {
      // Express channel: WorkflowPolicy decides whether skipping PLAN is allowed
      try {
        const config = loadConfig(context.projectRoot);
        const story = context.store.readStory(context.storyId);
        const policy = resolveWorkflowPolicy(config, story);
        if (!policy.quickPath.enabled) return false;
        if (!policy.quickPath.allowRiskSignals && story.riskSignals && story.riskSignals.length > 0) return false;
        const cl = context.store.readChecklist(context.storyId);
        return cl.items.length <= policy.quickPath.maxChecklistItems;
      } catch {
        return false;
      }
    },
    canPassReview: ({ context }) => {
      try {
        const config = loadConfig(context.projectRoot);
        const story = context.store.readStory(context.storyId);
        const policy = resolveWorkflowPolicy(config, story);

        // If policy doesn't require reviewer, skip finding checks entirely
        if (!policy.review.requireReviewer) return true;

        const findings = context.store.readFindings(context.storyId);
        const reviewPasses = context.store.readReviewPasses(context.storyId);
        if ((!findings.findings || findings.findings.length === 0) && (!reviewPasses.passes || reviewPasses.passes.length === 0)) return false;
        const evidenceState = collectReviewerEvidenceState(context.store, context.storyId, context.projectRoot);
        if (evidenceState.invalid.length > 0) return false;

        // Check for reviewer-produced finding if policy requires it
        if (policy.review.requireReviewerFinding) {
          const currentRoundReviewerEvidence = evidenceState.valid.map((e) => ({ agent: e.agent, kind: e.kind }));

          const { roundCount } = resolveEffectiveBlockingSeverities(context.store, context.storyId, policy);
          if (roundCount <= 1) {
            // Round 1: require findings from every opt-in reviewer (same source as reviewer_list).
            let checklist: { items: unknown[] } = { items: [] };
            try { checklist = context.store.readChecklist(context.storyId); } catch {}
            let decision = null;
            try { decision = context.store.readDecision(context.storyId); } catch {}
            const understanding = context.store.readUnderstanding(context.storyId);
            const touchpoints = understanding?.touchpoints
              ?? detectMdTouchpointsFromGit(context.projectRoot ?? process.cwd());
            const optIn = computeActiveReviewers(story, checklist, decision, touchpoints);
            const missing = optIn.filter(reviewer => !currentRoundReviewerEvidence.some(
              e => findingAgentMatchesReviewer(e.agent, reviewer.name),
            ));
            if (missing.length > 0) return false;

            // B-1fca CHK-002: quorum gate for round 1
            const quorum = evaluateReviewerQuorum({
              activeReviewers: optIn.map(r => r.name),
              evidence: buildQuorumEvidence(evidenceState.valid),
              profile: policy.profile as 'light' | 'balanced' | 'strict',
            });
            if (!quorum.ok) return false;
          } else {
            // Round 2+: require at least 1 reviewer finding or pass receipt
            if (currentRoundReviewerEvidence.length === 0) return false;
          }
        }

        const { effectiveBlockingSeverities, roundCount } = resolveEffectiveBlockingSeverities(context.store, context.storyId, policy);

        // Check blocking severities from policy (with round decay).
        // B-3fad CHK-001: evidenceState dimension — only verified (or legacy missing-field) open findings block;
        // suspected / disproven do not block REVIEW→TEST.
        const blocking = evidenceState.valid
          .map((e) => e.finding)
          .filter((finding): finding is Finding => !!finding)
          .filter((f) => isFindingBlocking(f, effectiveBlockingSeverities, roundCount));
        return blocking.length === 0;
      } catch {
        return false;
      }
    },
    canFinish: ({ context }) => {
      // verifier result (test-evidence.json) must be PASS + all bugs fixed
      const evidence = context.store.readTestEvidence(context.storyId);
      const hasEvidence = evidence !== null && evidence.result === 'PASS';
      const bugs = context.store.readBugs(context.storyId);
      const bugsOk = bugs.bugs.every(b => b.status === 'fixed');
      if (!hasEvidence || !bugsOk) return false;

      // delivery-check.json must exist and _hash must match
      const deliveryCheck = context.store.readDeliveryCheck(context.storyId);
      if (!deliveryCheck) return false;
      const expectedHash = recomputeDeliveryCheckHash(context.storyId, context.store);
      if (expectedHash === null || deliveryCheck._hash !== expectedHash) return false;

      // every docsPromise must be verified or waived
      const unverified = deliveryCheck.docsPromises.filter(
        p => !p.verifiedBy && !p.waiverReason && !['met', 'verified', 'waived'].includes(p.status || ''),
      );
      if (unverified.length > 0) return false;

      return true;
    },
  },
}).createMachine({
  id: 'story',
  context: ({ input }: { input: StoryMachineContext }) => input,
  initial: 'IDEA',
  states: {
    IDEA: {
      on: {
        INIT: { target: 'INIT' },
        PLAN: { target: 'PLAN' }, // legacy direct path
      },
    },
    INIT: {
      on: {
        // B-e71f CHK-006: The guard must be attached; otherwise actor.can() will always be true,
        // and the failure message rendering in phase-gates.ts's getGuardFailureReason will never trigger.
        INIT_CHECK: { target: 'INIT_CHECK', guard: 'canEnterInitCheck' },
      },
    },
    INIT_CHECK: {
      on: {
        PLAN: { target: 'PLAN' },
        START: { target: 'DEV', guard: 'canSkipPlan' },
      },
    },
    PLAN: {
      on: {
        START: { target: 'DEV', guard: 'canStartDev' },
      },
    },
    DEV: {
      on: {
        CODE_REVIEW: {
          target: 'REVIEW',
          guard: 'checklistAllDone',
        },
        REPLAN: {
          target: 'PLAN',
        },
      },
    },
    REVIEW: {
      on: {
        REVIEW_PASS: {
          target: 'TEST',
          guard: 'canPassReview',
        },
        START: {
          target: 'DEV',
        },
      },
    },
    TEST: {
      on: {
        FINISH: {
          target: 'DONE',
          guard: 'canFinish',
        },
        START: {
          target: 'DEV',
        },
      },
    },
    DONE: {
      type: 'final',
    },
  },
});

export type StoryMachineSnapshot = SnapshotFrom<typeof storyMachine>;

export function createStoryActor(
  storyId: string,
  store: StoryStore,
  restoredState?: string,
  projectRoot?: string,
) {
  const context: StoryMachineContext = { storyId, store, projectRoot: projectRoot ?? process.cwd() };
  const normalizedState = restoredState ? normalizeLegacyPhase(restoredState) : undefined;

  if (normalizedState) {
    const snapshot = storyMachine.resolveState({
      value: normalizedState,
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
  // B-e71f CHK-005: INIT→INIT_CHECK hard gate.
  // Only enabled when story.phase === 'INIT'; other sources such as IDEA→INIT_CHECK are not gated.
  // Missing init-check.json → missing_init_check; _hash mismatch → init_check_tampered.
  // recomputeInitCheckHash reuses the function already exported by CHK-001 (no duplicate implementations).
  if (targetPhase === 'INIT_CHECK') {
    const story = store.readStory(storyId);
    if (story.phase !== 'INIT') return null;
    const initCheck = store.readInitCheck(storyId);
    if (!initCheck) {
      return `Cannot enter INIT_CHECK: init-check.json is missing. [missing_init_check]\n` +
        `Missing required reviewer records: ${REQUIRED_INIT_CHECK_AGENTS.join(', ')}\n` +
        `→ Preferred: spawn an independent reviewer\n` +
        `   Agent({ subagent_type: "koala-review-story-init", prompt: \`koala dispatch '{"storyId":"${storyId}","agentType":"koala-review-story-init"}'\` })\n` +
        `   and have product-reviewer call init_check_set as well; if the reviewer produces no output for 4 minutes, re-dispatch and restart the reviewer.\n` +
        `→ Fallback (only when subagents cannot be spawned, controlled and audited):\n` +
        `   koala init_check_repair '{"storyId":"${storyId}","acknowledge":true,"fallbackReason":"<why the reviewer cannot run + what you manually verified, >=30 chars>"}'`;
    }
    const expected = recomputeInitCheckHash(storyId, store, projectRoot ?? process.cwd());
    if (initCheck._hash !== expected) {
      return `Cannot enter INIT_CHECK: init-check.json _hash mismatch (background/title/description/checklist were modified); please re-run the koala-review-story-init agent. [init_check_tampered]`;
    }
    const missingAgents = missingRequiredInitCheckAgents(initCheck);
    if (missingAgents.length > 0) {
      return `Cannot enter INIT_CHECK: init-check.json is missing required reviewer records: ${missingAgents.join(', ')}. [missing_init_check_agent]\n` +
        `→ Preferred: separately run koala dispatch '{"storyId":"${storyId}","agentType":"koala-review-story-init"}' and product-reviewer; every reviewer must call init_check_set regardless of pass/fail.\n` +
        `→ Fallback (only when subagents cannot be spawned, controlled and audited):\n` +
        `   koala init_check_repair '{"storyId":"${storyId}","acknowledge":true,"fallbackReason":"<why the reviewer cannot run + what you manually verified, >=30 chars>"}'`;
    }
    const blockers = blockingInitCheckIssues(initCheck);
    if (blockers.length > 0) {
      const lines = blockers.slice(0, 8).map(({ agentId, issue }) =>
        `  - ${agentId}: ${issue.severity} ${issue.id ? `${issue.id} ` : ''}${issue.desc}`,
      );
      return `Cannot enter INIT_CHECK: init-check reviewer recorded high/critical issues; you must fix them and re-run the corresponding reviewer first. [init_check_blocking_issues]\n${lines.join('\n')}`;
    }
    return null;
  }

  if (targetPhase === 'DEV') {
    // First check whether taking the express channel from INIT_CHECK
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
            reasons.push(`Has high-risk signals (${story.riskSignals.map(r => r.category).join(', ')}); must go through the full PLAN`);
          }
          try {
            const cl = store.readChecklist(storyId);
            if (cl.items.length > policy.quickPath.maxChecklistItems) {
              reasons.push(`Checklist has ${cl.items.length} items (> ${policy.quickPath.maxChecklistItems}); must go through the full PLAN`);
            }
          } catch {
            reasons.push('No checklist; must run story_advance PLAN first');
          }
        }
      } catch {
        reasons.push('Unable to load configuration; must go through the full PLAN');
      }
      if (reasons.length > 0) {
        return `Cannot skip PLAN:\n${reasons.map(r => `  - ${r}`).join('\n')}\n→ story_advance '{"storyId":"${storyId}","phase":"PLAN"}' to enter the full PLAN flow`;
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
            reasons.push('story_review check not passed (no review record)');
          } else {
            const lastRound = review.reviews[review.reviews.length - 1];
            const REVIEW_SALT = 'koala-review-integrity-v1';
            const hashInput = `${storyId}:${lastRound.timestamp}:${lastRound.issueCount}:${lastRound.blockerCount ?? lastRound.issueCount}:${REVIEW_SALT}`;
            const expectedHash = createHash('sha256').update(hashInput).digest('hex');
            if (!lastRound._hash || lastRound._hash !== expectedHash) {
              reasons.push('review.json signature verification failed; review report must be generated by story_review CLI');
            } else if ((lastRound.blockerCount ?? lastRound.issueCount) > 0) {
              reasons.push(`Latest story_review round has ${lastRound.blockerCount ?? lastRound.issueCount} unresolved blocker(s)`);
            }
          }
        } catch {
          reasons.push('story_review check not passed (no review record)');
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
    const pending = cl.items.filter(i => i.status !== 'done');
    if (pending.length > 0) {
      return `Cannot enter REVIEW: ${pending.length} checklist item(s) not done: ${pending.map(i => i.id).join(', ')}`;
    }
    const reviewStory = store.readStory(storyId);
    const reviewPolicy = resolveWorkflowPolicy(loadConfig(projectRoot), reviewStory);
    const missingEvidence = getBlockingVerificationEvidenceIssues(cl, undefined, reviewPolicy.profile);
    if (missingEvidence.length > 0) {
      return `Cannot enter REVIEW: ${missingEvidence.length} required verification intent(s) lack passing evidence or waiver:\n${missingEvidence.map(i => `  - ${i}`).join('\n')}\n→ Run verification_evidence_add to record logic/integration/browser/manual evidence, or use waiver to explicitly exempt`;
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
        const reviewPasses = store.readReviewPasses(storyId);
        if ((!findings.findings || findings.findings.length === 0) && (!reviewPasses.passes || reviewPasses.passes.length === 0)) {
          return `Cannot enter TEST: reviewer not run (no findings or review pass)\n→ Start reviewers per opt-in results (see koala reviewer_list); when no issues, use review_pass_set to record pass`;
        }
        const evidenceState = collectReviewerEvidenceState(store, storyId, projectRoot ?? process.cwd());
        if (evidenceState.invalid.length > 0) {
          return `Cannot enter TEST: reviewer evidence has invalid/expired review run bindings:\n${evidenceState.invalid.slice(0, 5).map(issue => `  - ${issue.message}`).join('\n')}`;
        }
        if (policy.review.requireReviewerFinding) {
          const currentRound = story.currentReviewRound;
          const currentRoundReviewerEvidence = evidenceState.valid.map((e) => ({ agent: e.agent, kind: e.kind }));

          const { roundCount: rc } = resolveEffectiveBlockingSeverities(store, storyId, policy);
          if (rc <= 1) {
            // Round 1: require findings from every opt-in reviewer (same source as reviewer_list).
            let checklist: { items: unknown[] } = { items: [] };
            try { checklist = store.readChecklist(storyId); } catch {}
            let decision = null;
            try { decision = store.readDecision(storyId); } catch {}
            const understanding = store.readUnderstanding(storyId);
            const touchpoints = understanding?.touchpoints
              ?? detectMdTouchpointsFromGit(projectRoot ?? process.cwd());
            const optIn = computeActiveReviewers(story, checklist, decision, touchpoints);
            const missing = optIn.filter(reviewer => !currentRoundReviewerEvidence.some(
              e => findingAgentMatchesReviewer(e.agent, reviewer.name),
            ));
            if (missing.length > 0) {
              const names = optIn.map(r => r.name).join(',');
              const missingNames = missing.map(r => r.name).join(',');
              const presentAgents = Array.from(new Set(currentRoundReviewerEvidence.map(e => e.agent))).join(', ') || 'none';
              return `Cannot enter TEST: Expected ${optIn.length} reviewers (opt-in: ${names}); currently ${currentRoundReviewerEvidence.length} reviewer evidence covers ${optIn.length - missing.length} reviewer(s) (Missing: ${missingNames}; agents seen: ${presentAgents})\n→ Start the missing koala-review-* agents in parallel; when no issues, use review_pass_set`;
            }

            // B-1fca CHK-002: quorum diagnostics for round 1 disputes/missing lanes
            const quorumR1 = evaluateReviewerQuorum({
              activeReviewers: optIn.map(r => r.name),
              evidence: buildQuorumEvidence(currentRoundReviewerEvidence),
              profile: policy.profile as 'light' | 'balanced' | 'strict',
            });
            if (!quorumR1.ok) {
              return `Cannot enter TEST: Reviewer quorum not met (Round 1):\n${quorumR1.blocking.map(m => `  - ${m}`).join('\n')}\n→ Re-run the corresponding reviewer after fixing reviewer dispute; when no issues, use review_pass_set`;
            }
          } else {
            if (currentRoundReviewerEvidence.length === 0) {
              return currentRound
                ? `Cannot enter TEST: Round ${rc} current review round (${currentRound}) has no reviewer finding/pass; please start the corresponding koala-review-* agents`
                : `Cannot enter TEST: findings all come from main agent (reviewer not run)\n→ Start koala-review-* subagent`;
            }
          }
        }
        const { effectiveBlockingSeverities, roundCount } = resolveEffectiveBlockingSeverities(store, storyId, policy);

        // B-3fad CHK-001: evidenceState dimension — only verified (or legacy missing-field) open findings block.
        const blocking = evidenceState.valid
          .map((e) => e.finding)
          .filter((finding): finding is Finding => !!finding)
          .filter((f) => isFindingBlocking(f, effectiveBlockingSeverities, roundCount));
        if (blocking.length > 0) {
          return `Cannot enter TEST: ${blocking.length} blocking finding(s) open (Round ${roundCount}, blocking: ${effectiveBlockingSeverities.join('/')}):\n${blocking.map(f => `  - ${f.id} [${f.severity}] ${f.desc}`).join('\n')}\n→ After fixing, finding_resolve, or to confirm not fixing use finding_dismiss (reason ≥10 characters required)`;
        }
      } catch {
        return `Cannot enter TEST: reviewer not run (no findings.json)\n→ Start reviewers per opt-in results (see koala reviewer_list)`;
      }
    }
  }

  if (targetPhase === 'DONE') {
    const evidence = store.readTestEvidence(storyId);
    if (!evidence) {
      return 'Cannot enter DONE: no test evidence (run koala validate first)';
    }
    if (evidence.result !== 'PASS') {
      return `Cannot enter DONE: test ${evidence.result}: ${evidence.output}`;
    }
    const bugs = store.readBugs(storyId);
    const openBugs = bugs.bugs.filter(b => b.status !== 'fixed');
    if (openBugs.length > 0) {
      return `Cannot enter DONE: ${openBugs.length} unfixed bug(s): ${openBugs.map(b => b.id).join(', ')}`;
    }

    // delivery-check.json signature verification
    const deliveryCheck = store.readDeliveryCheck(storyId);
    if (!deliveryCheck) {
      return `Cannot enter DONE: missing delivery-check.json (requires koala-review-delivery reviewer signature). [missing_delivery_check] → Run story_advance DEV to rework and fill in`;
    }
    const expectedDeliveryHash = recomputeDeliveryCheckHash(storyId, store);
    if (expectedDeliveryHash === null || deliveryCheck._hash !== expectedDeliveryHash) {
      return `Cannot enter DONE: delivery-check.json _hash mismatch (content has been tampered with); please re-run koala-review-delivery reviewer. [delivery_check_tampered] → Run story_advance DEV to rework and fill in`;
    }

    // every docsPromise must be verified or waived
    const unverifiedPromises = deliveryCheck.docsPromises.filter(
      p => !p.verifiedBy && !p.waiverReason && !['met', 'verified', 'waived'].includes(p.status || ''),
    );
    if (unverifiedPromises.length > 0) {
      const names = unverifiedPromises.map(p => p.docPath).join(', ');
      return `Cannot enter DONE: ${unverifiedPromises.length} docsPromise entries unverified and not waived: ${names}. [unverified_promise] → Use delivery_waiver_add to write a waiver or re-run reviewer → Run story_advance DEV to rework and fill in`;
    }
  }

  return null;
}
