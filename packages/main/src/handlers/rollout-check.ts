import type { HandlerContext } from './context.js';
import {
  buildRolloutCheck,
  renderRolloutCheckText,
  type RolloutFormat,
} from '../core/rollout-check.js';

type RolloutCheckArgs = {
  projects?: string | string[];
  maxDepth?: number;
  format?: RolloutFormat;
  json?: boolean;
};

function wantsJson(args: RolloutCheckArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

export function createRolloutCheckHandlers(ctx: HandlerContext) {
  return {
    rollout_check(args: RolloutCheckArgs = {}) {
      const result = buildRolloutCheck({
        root: ctx.root,
        projects: args.projects,
        maxDepth: args.maxDepth,
      });
      return wantsJson(args) ? result : renderRolloutCheckText(result);
    },
  };
}
