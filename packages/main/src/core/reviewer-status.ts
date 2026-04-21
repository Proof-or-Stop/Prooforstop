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
import { resolveOptInReviewers, resolveChannel, findingAgentMatchesReviewer } from './reviewer-opt-in.js';
import { isAdvisoryThisRound, resolveReviewRoundCount } from './advisory.js';
import { verifyFinding } from './finding-verify.js';

// ── Public types ──

export interface ReviewerStatusEntry {
  name: string;
  required: boolean;
  present: boolean;
  verdict: 'pass' | 'fail' | 'pending';
  blockerCount: number;
}

export interface ReviewerStatusSummary {
  entries: ReviewerStatusEntry[];
  allPassed: boolean;
  totalBlockers: number;
}

// ── Constants ──

const REVIEW_SALT = 'koala-review-integrity-v1';

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
export function summarizeReviewerStatus(store: StoryStore, storyId: string): ReviewerStatusSummary {
  const story = store.readStory(storyId);
  const checklist = store.readChecklist(storyId);
  const understanding = store.readUnderstanding(storyId);
  const touchpoints = understanding?.touchpoints ?? [];

  const channel = resolveChannel(
    checklist.items.length,
    story.riskSignals,
  );
  const reviewers = resolveOptInReviewers(story, channel, touchpoints);
  const round = resolveReviewRoundCount(store, storyId);

  const findingData = store.readFindings(storyId);
  const findings = findingData.findings ?? [];

  // story-review entry (always required)
  const storyReviewEntry = summarizeStoryReview(store, storyId);

  // Build entries for each opted-in LLM reviewer
  const reviewerEntries: ReviewerStatusEntry[] = reviewers.map(r => {
    const matched = findings.filter(f => findingAgentMatchesReviewer(f.agent, r.name));
    const present = matched.length > 0;

    // Count open blockers (not advisory this round, not resolved/dismissed, valid signature)
    const blockerCount = matched.filter(f =>
      f.status === 'open'
      && !isAdvisoryThisRound(f.severity, round)
      && verifyFinding(storyId, f),
    ).length;

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
    };
  });

  const entries = [storyReviewEntry, ...reviewerEntries];
  const totalBlockers = entries.reduce((sum, e) => sum + e.blockerCount, 0);
  const allPassed = entries.every(e => e.verdict === 'pass');

  return { entries, allPassed, totalBlockers };
}
