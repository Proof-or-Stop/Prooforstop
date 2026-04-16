import { createHash } from 'crypto';
import type { StoryPhase } from './types.js';
import type { StoryStore } from './store.js';

export type ReviewerArtifactKey = 'story_review' | 'test_intent_review' | 'implementation_review';
export type ReviewerVerdict = 'pass' | 'fail' | 'missing';

export interface ReviewerStatusEntry {
  key: ReviewerArtifactKey;
  label: string;
  required: boolean;
  present: boolean;
  verdict: ReviewerVerdict;
  blocking: boolean;
  summary: string;
  detail: string;
  findings: number;
}

export interface ReviewerStatus {
  phase: StoryPhase;
  entries: ReviewerStatusEntry[];
  primary: ReviewerStatusEntry | null;
}

function isRequired(key: ReviewerArtifactKey, phase: StoryPhase): boolean {
  if (key === 'story_review') {
    return ['DEV', 'TEST_CASE', 'TEST_CASE_REVIEW', 'TEST', 'DONE'].includes(phase);
  }
  if (key === 'test_intent_review') {
    return ['TEST', 'DONE'].includes(phase);
  }
  if (key === 'implementation_review') {
    return ['TEST', 'DONE'].includes(phase);
  }
  return false;
}

function summarizeStoryReview(store: StoryStore, storyId: string, phase: StoryPhase): ReviewerStatusEntry {
  const review = store.readReview(storyId);
  const required = isRequired('story_review', phase);
  const last = review.reviews[review.reviews.length - 1];
  if (!last) {
    return {
      key: 'story_review',
      label: 'story review',
      required,
      present: false,
      verdict: 'missing',
      blocking: required,
      summary: 'missing',
      detail: 'no story_review record',
      findings: 0,
    };
  }

  const REVIEW_SALT = 'koala-review-integrity-v1';
  const hashInput = `${storyId}:${last.timestamp}:${last.issueCount}:${last.blockerCount ?? last.issueCount}:${REVIEW_SALT}`;
  const expectedHash = createHash('sha256').update(hashInput).digest('hex');
  const invalid = !last._hash || last._hash !== expectedHash;
  const blockers = last.blockerCount ?? last.issueCount;
  const verdict: ReviewerVerdict = invalid || blockers > 0 ? 'fail' : 'pass';

  return {
    key: 'story_review',
    label: 'story review',
    required,
    present: true,
    verdict,
    blocking: required && verdict !== 'pass',
    summary: invalid ? 'invalid signature' : `${verdict} (${blockers} blocker)`,
    detail: invalid
      ? 'review.json signature invalid'
      : `latest round: ${blockers} blocker / ${last.issueCount} total issue`,
    findings: last.issueCount,
  };
}

function summarizeTestIntentReview(store: StoryStore, storyId: string, phase: StoryPhase): ReviewerStatusEntry {
  const checklist = store.readChecklist(storyId);
  const required = isRequired('test_intent_review', phase);
  let total = 0;
  let passed = 0;
  let failed = 0;
  let missing = 0;
  let exemptOnly = checklist.items.length > 0;

  for (const item of checklist.items) {
    if (item.testIntent !== null) {
      exemptOnly = false;
    }
    if (!item.testIntent) continue;
    for (const lane of ['happy', 'edge', 'adversarial'] as const) {
      const entries = item.testIntent[lane] || [];
      for (const entry of entries) {
        total++;
        if (typeof entry === 'string') {
          missing++;
          continue;
        }
        const judgment = Array.isArray(entry.results)
          ? [...entry.results].reverse().find((result) => result.role === 'reviewer' && result.pass !== undefined)
          : undefined;
        if (!judgment) missing++;
        else if (judgment.pass === true) passed++;
        else failed++;
      }
    }
  }

  const present = total > 0;
  let verdict: ReviewerVerdict = 'missing';
  if (failed > 0) verdict = 'fail';
  else if (present && missing === 0) verdict = 'pass';
  else if (exemptOnly) verdict = 'pass';

  return {
    key: 'test_intent_review',
    label: 'test-intent review',
    required,
    present: present || exemptOnly,
    verdict,
    blocking: required && verdict !== 'pass',
    summary: exemptOnly
      ? 'pass (all checklist items marked not auto-testable)'
      : `${verdict} (${passed}/${total} pass, ${missing} missing, ${failed} fail)`,
    detail: exemptOnly
      ? 'all checklist items explicitly marked testIntent:null'
      : total === 0
      ? 'no testIntent entries'
      : `${passed}/${total} reviewer judgments passed`,
    findings: failed + missing,
  };
}

function summarizeImplementationReview(store: StoryStore, storyId: string, phase: StoryPhase): ReviewerStatusEntry {
  const data = store.readImplementationReview(storyId);
  const required = isRequired('implementation_review', phase);
  if (!data) {
    return {
      key: 'implementation_review',
      label: 'implementation review',
      required,
      present: false,
      verdict: 'missing',
      blocking: required,
      summary: 'missing',
      detail: 'no implementation-review record',
      findings: 0,
    };
  }

  return {
    key: 'implementation_review',
    label: 'implementation review',
    required,
    present: true,
    verdict: data.verdict,
    blocking: required && data.verdict !== 'pass',
    summary: `${data.verdict} (${data.findings.length} findings)`,
    detail: data.summary,
    findings: data.findings.length,
  };
}

function primaryOrder(phase: StoryPhase): ReviewerArtifactKey[] {
  if (phase === 'TEST_CASE_REVIEW' || phase === 'TEST' || phase === 'DONE') {
    return ['implementation_review', 'test_intent_review', 'story_review'];
  }
  return ['story_review', 'implementation_review', 'test_intent_review'];
}

export function getReviewerStatus(
  storyId: string,
  store: StoryStore,
  phase: StoryPhase,
): ReviewerStatus {
  const entries = [
    summarizeStoryReview(store, storyId, phase),
    summarizeTestIntentReview(store, storyId, phase),
    summarizeImplementationReview(store, storyId, phase),
  ];
  const order = primaryOrder(phase);
  const sorted = order
    .map((key) => entries.find((entry) => entry.key === key))
    .filter((entry): entry is ReviewerStatusEntry => Boolean(entry));

  const primary =
    sorted.find((entry) => entry.blocking && entry.verdict !== 'pass') ||
    sorted.find((entry) => entry.verdict === 'fail') ||
    sorted.find((entry) => entry.verdict === 'missing') ||
    sorted.find((entry) => entry.verdict === 'pass') ||
    null;

  return { phase, entries, primary };
}
