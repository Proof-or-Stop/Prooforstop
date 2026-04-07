
import type { HandlerContext } from './context.js';
import { createStoryCreateHandlers } from './story-create.js';
import { createStoryAdvanceHandlers } from './story-advance.js';
import { createStoryQueryHandlers } from './story-query.js';
import { createStoryReviewHandlers } from './story-review.js';

export function createStoryHandlers(ctx: HandlerContext) {
  return {
    ...createStoryCreateHandlers(ctx),
    ...createStoryAdvanceHandlers(ctx),
    ...createStoryQueryHandlers(ctx),
    ...createStoryReviewHandlers(ctx),
  };
}
