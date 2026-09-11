/** Isolated smoke setup through the production dispatch/run protocol. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { StoryStore } from '../core/store.js';
import type { Finding } from '../core/types.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { createReviewRunHandlers } from '../handlers/review-run.js';
import { signFinding } from '../core/finding-verify.js';
import { withNativeReviewFixtureHostIdentity, issueBrokeredNativeReviewBinding } from './native-review-fixture.js';

const contexts = new Map<string, { root: string; store: StoryStore; storyId: string; agent: string }>();
export function registerCurrentReviewFixtureRun(root: string, store: StoryStore, storyId: string, agent: string, reviewRunId: string): void {
  const run = store.readReviewRuns(storyId).runs.find(row => row.reviewRunId === reviewRunId && row.agent === agent);
  assert.ok(run?.envelopeId, 'fixture registration requires a persisted current reviewer run');
  contexts.set(reviewRunId, { root, store, storyId, agent });
}
export function seedCurrentReviewFixture(root: string, store: StoryStore, storyId: string, agents: string[]): Map<string, string> {
  const ctx = { root, store, scanRoot: join(root, 'packages/main') };
  const result = new Map<string, string>(); const before = process.cwd();
  try {
    process.chdir(root);
    for (const agent of agents) {
      withNativeReviewFixtureHostIdentity({ agent, invoke: () => createStoryDispatchHandlers(ctx).dispatch({ storyId, agentType: agent }) });
      withNativeReviewFixtureHostIdentity({ agent, invoke: () => createReviewRunHandlers(ctx).review_run_start({ storyId, agent }) });
      const run = store.readReviewRuns(storyId).runs.filter(row => row.agent === agent).at(-1);
      assert.ok(run?.envelopeId, 'fixture uses a production full-envelope reviewer run');
      result.set(agent, run.reviewRunId); contexts.set(run.reviewRunId, { root, store, storyId, agent });
    }
  } finally { process.chdir(before); }
  return result;
}
export function bindCurrentFixtureFinding(finding: Finding): Finding {
  const ctx = contexts.get(finding.reviewRunId ?? '');
  assert.ok(ctx, 'Finding must bind a fixture-issued reviewer run');
  const nativeEvidenceBinding = issueBrokeredNativeReviewBinding({ ...ctx, reviewRunId: finding.reviewRunId! });
  return { ...finding, nativeEvidenceBinding, _hash: signFinding(ctx.storyId, finding.id, finding.desc, finding.severity,
    finding.createdAt ?? '', finding.reviewRound ?? '', finding.reviewRunId, undefined, undefined, undefined, undefined, undefined, nativeEvidenceBinding,
    { category: finding.category, evidenceState: finding.evidenceState ?? null, uncertaintyReason: finding.uncertaintyReason ?? null, files: finding.files ?? [],
      ...(finding.disprovenEvidence ? { disprovenEvidence: finding.disprovenEvidence } : {}) }) };
}
