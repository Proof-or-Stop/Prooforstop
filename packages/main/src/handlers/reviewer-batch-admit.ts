import { ReviewerBatchAdmitArgsSchema } from '../core/reviewer-batch-admit-schema.js';
import type { HandlerContext } from './context.js';
import type { StoryStore } from '../core/store.js';
import type { ReviewerBatchAdmissionResult, ReviewerBatchAssignment } from '../core/reviewer-batch-admission.js';
import { deriveReviewerBatchSubject, validateReviewerBatchAssignments } from '../core/reviewer-batch-subject.js';

/** Required trusted core producer seam. No default/no-op implementation or caller-supplied READY is provided. */
export type ReviewerBatchAdmissionProducer = (input: {
  store: StoryStore; root: string; storyId: string; epochId: string; wave: number; assignments: ReviewerBatchAssignment[]; retryFromGeneration?: number;
}) => Promise<ReviewerBatchAdmissionResult>;

export function createReviewerBatchAdmitHandlers(ctx: HandlerContext, producer: ReviewerBatchAdmissionProducer) {
  return {
    async reviewer_batch_admit(rawArgs: unknown): Promise<string> {
      // Direct calls get the same strict validation as CLI catalog calls.
      const args = ReviewerBatchAdmitArgsSchema.parse(rawArgs);
      const subject = deriveReviewerBatchSubject(ctx.store, ctx.root, args);
      const assignments = validateReviewerBatchAssignments(subject.requiredLanes, args.assignments);
      // Producer must freeze the roster and rederive current inputs under the
      // actual inventory/runtime locks before performing supervised probes.
      const result = await producer({ store: ctx.store, root: ctx.root, storyId: args.storyId,
        epochId: subject.subject.binding.epochId, wave: subject.subject.binding.wave, assignments, retryFromGeneration:args.retryFromGeneration });
      if (args.json) return JSON.stringify(result);
      return `Reviewer batch admission: ${result.state}${result.reason ? ` (${result.reason})` : ''}`;
    },
  };
}
