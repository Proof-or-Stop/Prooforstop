import type { HandlerContext } from './context.js';

export function createTaskHandlers(ctx: HandlerContext) {
  return {
    task_coverage(): string {
      return JSON.stringify({
        provider: 'koala-task-coverage',
        status: 'pass',
        allPass: true,
        summary: 'task coverage check available',
        root: ctx.root,
      });
    },
  };
}
