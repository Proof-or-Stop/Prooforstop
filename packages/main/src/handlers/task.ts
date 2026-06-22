import type { HandlerContext } from './context.js';
import { checkCoverage } from '../tasks/coverage.js';

export function createTaskHandlers(ctx: HandlerContext) {
  const { store, scanRoot } = ctx;

  return {
    task_coverage(args: { storyId: string | string[] }) {
      if (Array.isArray(args.storyId)) {
        const result: Record<string, ReturnType<typeof checkCoverage>> = {};
        for (const storyId of args.storyId) {
          result[storyId] = checkCoverage(storyId, store, scanRoot);
        }
        return result;
      }
      return checkCoverage(args.storyId, store, scanRoot);
    },
  };
}
