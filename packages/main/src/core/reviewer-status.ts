import { rethrowIntentAmendmentIntegrityError } from './verification-intent-amendment.js';
/**
 * B-c622 CHK-008: Reviewer status aggregation.
 *
 * Provides two functions:
 *   - summarizeStoryReview: check review.json signature + blocker count
 *   - summarizeReviewerStatus: aggregate all reviewer statuses from findings + review
 *
 * Pure read-only module -- no I/O mutations. Consumes StoryStore for data access
 * and reuses existing reviewer-opt-in / advisory / finding-verify modules.
 */

import { createHash } from 'crypto';
import type { StoryStore } from './store.js';
import { findingAgentMatchesReviewer } from './reviewer-opt-in.js';
import { isFindingBlocking } from './advisory.js';
import { detectMdTouchpointsFromGit } from './touchpoints-fallback.js';
import { computeActiveReviewers } from '../handlers/reviewer-list.js';
import { resolveEffectiveBlockingSeverities } from './guard-utils.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
import { loadConfig } from './config.js';
import { collectReviewerEvidenceState } from './review-run.js';

// ── Public types ──

export interface ReviewerStatusEntry {
  name: string;
  required: boolean;
  present: boolean;
  verdict: 'pass' | 'fail' | 'pending';
  blockerCount: number;
  detail?: string;
}

export interface ReviewerStatusSummary {
  entries: ReviewerStatusEntry[];
  allPassed: boolean;
  totalBlockers: number;
}

export function resolveReviewerTouchpoints(
  store: StoryStore,
  storyId: string,
  projectRoot?: string,
): string[] | undefined {
  const understanding = store.readUnderstanding(storyId);
  return understanding?.touchpoints
    ?? (projectRoot ? detectMdTouchpointsFromGit(projectRoot) : undefined);
}

// ── Constants ──

const REVIEW_SALT = 'proof-or-stop-review-integrity-v1';

// ── Public API ──

/**
 * Summarize story_review (review.json) status.
 * Checks the latest review entry's signature and counts blockers.
 */
export function summarizeStoryReview(store: StoryStore, storyId: string): ReviewerStatusEntry {
  const entry: ReviewerStatusEntry = {
    name: 'story-review',
    required: true,
    present: false,
    verdict: 'pending',
    blockerCount: 0,
  };

  const reviewData = store.readReview(storyId);
  if (!reviewData.reviews || reviewData.reviews.length === 0) {
    return entry;
  }

  const latest = reviewData.reviews[reviewData.reviews.length - 1];
  entry.present = true;

  // Verify signature: sha256(storyId:timestamp:issueCount:blockerCount:salt)
  if (latest._hash) {
    const expectedHash = createHash('sha256')
      .update(`${storyId}:${latest.timestamp}:${latest.issueCount}:${latest.blockerCount ?? 0}:${REVIEW_SALT}`)
      .digest('hex');
    if (latest._hash !== expectedHash) {
      entry.verdict = 'fail';
      entry.blockerCount = 1; // tampered signature counts as a blocker
      return entry;
    }
  }

  entry.blockerCount = latest.blockerCount ?? 0;
  entry.verdict = entry.blockerCount === 0 ? 'pass' : 'fail';
  return entry;
}

/**
 * Aggregate reviewer status from opt-in reviewers + findings.
 *
 * For each opted-in reviewer, checks whether findings from that reviewer exist
 * and whether any open blockers remain (respecting round-based advisory rules).
 */
export function summarizeReviewerStatus(store: StoryStore, storyId: string, projectRoot?: string): ReviewerStatusSummary {
  const story = store.readStory(storyId);
  let checklist: { items: unknown[] } = { items: [] };
  try { checklist = store.readChecklist(storyId); } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError); /* probe: no checklist yet */ }
  const decision = store.readDecision(storyId);
  const touchpoints = resolveReviewerTouchpoints(store, storyId, projectRoot);
  const reviewers = computeActiveReviewers(story, checklist, decision, touchpoints);

  // F-001: align the reviewer-status display path with the REVIEW->TEST gate.
  // The gate (machine.ts canPassReview / guard-utils.ts) uses isFindingBlocking,
  // which carries the evidenceState dimension (suspected/disproven never block).
  // Resolve effective blocking severities + round the same way the gate does so a
  // suspected open critical/high finding is not counted as a blocker here.
  const config = loadConfig(projectRoot);
  const policy = resolveWorkflowPolicy(config, story);
  const { effectiveBlockingSeverities, roundCount } = resolveEffectiveBlockingSeverities(store, storyId, policy);

  const evidenceState = collectReviewerEvidenceState(store, storyId, projectRoot ?? process.cwd());
  const validFindings = evidenceState.valid.map((entry) => entry.finding).filter(Boolean);
  const validPasses = evidenceState.valid.map((entry) => entry.pass).filter(Boolean);

  // story-review entry (always required)
  const storyReviewEntry = summarizeStoryReview(store, storyId);

  // Build entries for each opted-in LLM reviewer
  const reviewerEntries: ReviewerStatusEntry[] = reviewers.map(r => {
    const matched = validFindings.filter(f => findingAgentMatchesReviewer(f?.agent, r.name));
    const matchedPasses = validPasses.filter(p => findingAgentMatchesReviewer(p?.agent, r.name));
    const invalid = evidenceState.invalid.filter(issue => findingAgentMatchesReviewer(issue.agent, r.name));
    const present = matched.length > 0 || matchedPasses.length > 0 || invalid.length > 0;

    // Count open blockers using the same predicate as the REVIEW->TEST gate
    // (status open + blocking severity + verified evidenceState + not advisory this round).
    const openBlockers = matched.filter(f =>
      !!f && isFindingBlocking(f, effectiveBlockingSeverities, roundCount)
    ).length;
    const blockerCount = openBlockers + invalid.length;

    let verdict: 'pass' | 'fail' | 'pending';
    if (!present) {
      verdict = 'pending';
    } else if (blockerCount > 0) {
      verdict = 'fail';
    } else {
      verdict = 'pass';
    }

    return {
      name: r.name,
      required: true,
      present,
      verdict,
      blockerCount,
      ...(invalid[0] ? { detail: invalid[0].message } : {}),
    };
  });

  const entries = [storyReviewEntry, ...reviewerEntries];
  const totalBlockers = entries.reduce((sum, e) => sum + e.blockerCount, 0);
  const allPassed = entries.every(e => e.verdict === 'pass');

  return { entries, allPassed, totalBlockers };
}
