import type { HandlerContext } from './context.js';
import {
  buildStoryReadinessReport,
  renderStoryReadinessReport,
  type LifecycleReadinessTarget,
} from '../core/lifecycle-readiness.js';

interface LifecycleCheckArgs {
  storyId: string;
  target: LifecycleReadinessTarget;
  format?: 'text' | 'json';
  json?: boolean;
  runCommands?: boolean;
  writeEvidence?: boolean;
}

function wantsJson(args: LifecycleCheckArgs): boolean {
  return args.json === true || args.format === 'json';
}

function assertV1ReadOnly(args: LifecycleCheckArgs): void {
  const rejected: string[] = [];
  if (args.runCommands === true) rejected.push('runCommands=true');
  if (args.writeEvidence === true) rejected.push('writeEvidence=true');
  if (rejected.length === 0) return;
  throw new Error(
    `lifecycle_check V1 is read-only: ${rejected.join(' and ')} belong to a later Full Vision layer. ` +
    'No story facts were read, no commands were run, and no evidence was written.',
  );
}

export function createLifecycleCheckHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  function lifecycleCheck(args: LifecycleCheckArgs) {
    assertV1ReadOnly(args);
    const report = buildStoryReadinessReport({
      storyId: args.storyId,
      target: args.target,
      store: ctx.store,
      root: ctx.root,
    });
    return wantsJson(args) ? report : renderStoryReadinessReport(report);
  }

  return {
    lifecycle_check: lifecycleCheck,
  };
}
