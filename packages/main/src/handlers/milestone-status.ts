import type { HandlerContext } from './context.js';
import {
  buildMilestoneStatusReport,
  renderMilestoneStatusReport,
  type MilestoneStatusReport,
} from '../core/milestone-status.js';
import type { ChecklistData } from '../core/types.js';

interface MilestoneStatusArgs {
  storyId: string;
  format?: 'text' | 'json';
  json?: boolean;
  runCommands?: unknown;
  writeEvidence?: unknown;
  advancePhase?: unknown;
  launchReviewers?: unknown;
  write?: unknown;
  apply?: unknown;
  execute?: unknown;
  run?: unknown;
  launch?: unknown;
  capture?: unknown;
  refresh?: unknown;
  authorityClaim?: unknown;
  productionClaim?: unknown;
  productionReadyClaim?: unknown;
  deploymentReadyClaim?: unknown;
  externalCompletionClaim?: unknown;
  terminalCompletionClaim?: unknown;
}

const MUTATION_LIKE_FLAGS = [
  'runCommands',
  'writeEvidence',
  'advancePhase',
  'launchReviewers',
  'write',
  'apply',
  'execute',
  'run',
  'launch',
  'capture',
  'refresh',
  'authorityClaim',
  'productionClaim',
  'productionReadyClaim',
  'deploymentReadyClaim',
  'externalCompletionClaim',
  'terminalCompletionClaim',
] as const;

function wantsJson(args: MilestoneStatusArgs): boolean {
  return args.json === true || args.format === 'json';
}

/**
 * Fail closed before any store read. milestone_status V1 is an observer:
 * no commands, no evidence writes, no reviewer launch, no phase advancement,
 * and no retired Authority/production completion claim flags.
 */
export function assertMilestoneStatusReadOnlyBoundary(args: MilestoneStatusArgs): void {
  const rejected = MUTATION_LIKE_FLAGS.filter((flag) =>
    Object.prototype.hasOwnProperty.call(args, flag) && args[flag] !== undefined
  );
  if (rejected.length === 0) return;
  throw new Error(
    `milestone_status V1 is read-only and rejects mutation-like flags before reading story facts: ${rejected.join(', ')}. ` +
    'No story facts were read, no commands were run, no evidence/summaries/review passes were written, ' +
    'no reviewers were launched, and no phase was advanced.',
  );
}

function readChecklist(ctx: HandlerContext, storyId: string): ChecklistData {
  try {
    return ctx.store.readChecklist(storyId);
  } catch {
    return { items: [] };
  }
}

export function createMilestoneStatusHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  function milestoneStatus(args: MilestoneStatusArgs): MilestoneStatusReport | string {
    assertMilestoneStatusReadOnlyBoundary(args);
    const story = ctx.store.readStory(args.storyId);
    const checklist = readChecklist(ctx, args.storyId);
    const report = buildMilestoneStatusReport({
      story,
      checklist,
      milestoneLedger: ctx.store.readMilestoneLedger(args.storyId),
      summary: ctx.store.readSummary(args.storyId),
    });
    return wantsJson(args) ? report : renderMilestoneStatusReport(report);
  }

  return {
    milestone_status: milestoneStatus,
  };
}
