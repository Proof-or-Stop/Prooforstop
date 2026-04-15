import type { StoryPhase, StoryInfo } from './types.js';
import type { StoryStore } from './store.js';

export interface ArtifactContractEntry {
  key: 'understanding' | 'decision' | 'review' | 'test_evidence' | 'summary';
  label: string;
  required: boolean;
  present: boolean;
  detail: string;
}

export interface ArtifactContractStatus {
  phase: StoryPhase;
  entries: ArtifactContractEntry[];
}

function isHighRiskStory(story: StoryInfo): boolean {
  return story.priority === 'high' || story.priority === 'critical' || (story.riskSignals?.length ?? 0) > 0;
}

function hasUnderstanding(store: StoryStore, storyId: string): boolean {
  try {
    const data = store.readUnderstanding(storyId);
    return !!data && !!data.task;
  } catch {
    return false;
  }
}

function hasDecision(store: StoryStore, storyId: string): boolean {
  try {
    const data = store.readDecision(storyId);
    return !!data && Array.isArray(data.options) && data.options.length > 0;
  } catch {
    return false;
  }
}

function hasReview(store: StoryStore, storyId: string): boolean {
  try {
    const data = store.readReview(storyId);
    return !!data && Array.isArray(data.reviews) && data.reviews.length > 0;
  } catch {
    return false;
  }
}

function hasTestEvidence(store: StoryStore, storyId: string): boolean {
  try {
    return store.readTestEvidence(storyId) !== null;
  } catch {
    return false;
  }
}

function hasSummary(store: StoryStore, storyId: string): boolean {
  try {
    return store.readSummary(storyId) !== null;
  } catch {
    return false;
  }
}

export function getArtifactContractStatus(
  storyId: string,
  store: StoryStore,
  phase: StoryPhase,
): ArtifactContractStatus {
  const story = store.readStory(storyId);
  const highRisk = isHighRiskStory(story);

  const entries: ArtifactContractEntry[] = [
    {
      key: 'understanding',
      label: 'understanding',
      required: ['PLAN', 'DEV', 'TEST_CASE', 'TEST_CASE_REVIEW', 'TEST'].includes(phase),
      present: hasUnderstanding(store, storyId),
      detail: 'task / outcome / facts / constraints / unknowns / touchpoints snapshot',
    },
    {
      key: 'decision',
      label: 'decision',
      required: phase === 'PLAN' ? highRisk : ['DEV', 'TEST_CASE', 'TEST_CASE_REVIEW', 'TEST'].includes(phase) && highRisk,
      present: hasDecision(store, storyId),
      detail: highRisk ? 'high-risk story requires principles / drivers / options / rationale / preMortem' : 'optional on non-high-risk stories',
    },
    {
      key: 'review',
      label: 'review',
      required: ['DEV', 'TEST_CASE', 'TEST_CASE_REVIEW', 'TEST', 'DONE'].includes(phase),
      present: hasReview(store, storyId),
      detail: 'latest story_review record with valid review round',
    },
    {
      key: 'test_evidence',
      label: 'test evidence',
      required: ['TEST', 'DONE'].includes(phase),
      present: hasTestEvidence(store, storyId),
      detail: 'latest story-level test run evidence',
    },
    {
      key: 'summary',
      label: 'summary',
      required: phase === 'DONE',
      present: hasSummary(store, storyId),
      detail: 'changes / usage / limitations / pitfalls completion summary',
    },
  ];

  return { phase, entries };
}
