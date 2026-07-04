import type { HandlerContext } from './context.js';
import {
  buildMilestoneStatusReport,
  renderMilestoneStatusReport,
  type MilestoneStatusCurrentEvidenceBinding,
  type MilestoneStatusReport,
} from '../core/milestone-status.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';

interface MilestoneStatusArgs {
  storyId: string;
  format?: 'text' | 'json';
  json?: boolean;
  [key: string]: unknown;
}

const ALLOWED_MILESTONE_STATUS_ARG_KEYS = new Set(['storyId', 'format', 'json']);

function wantsJson(args: MilestoneStatusArgs): boolean {
  return args.json === true || args.format === 'json';
}

function currentEvidenceBinding(ctx: HandlerContext, storyId: string): MilestoneStatusCurrentEvidenceBinding | undefined {
  const gitCwd = resolveGitCwd({
    store: ctx.store,
    storyId,
    metadataRoot: ctx.root,
    projectRoot: ctx.root,
    cwd: process.cwd(),
  });
  const headHash = currentGitHead(gitCwd);
  const materialHash = currentMaterialHash(gitCwd, 'HEAD', ctx.root);
  const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', ctx.root);
  const binding: MilestoneStatusCurrentEvidenceBinding = {
    ...(headHash ? { headHash } : {}),
    ...(materialHash ? { materialHash } : {}),
    ...(storyFilesHash ? { storyFilesHash } : {}),
  };
  return Object.keys(binding).length > 0 ? binding : undefined;
}

/**
 * Fail closed before any store read. milestone_status V1 is an observer:
 * it accepts only its read shape and rejects every unexpected key.
 */
export function assertMilestoneStatusReadOnlyBoundary(args: MilestoneStatusArgs): void {
  const rejected = Object.keys(args).filter((key) => !ALLOWED_MILESTONE_STATUS_ARG_KEYS.has(key));
  if (rejected.length === 0) return;
  throw new Error(
    `milestone_status V1 is read-only and accepts only storyId, format, and json before reading story facts; unexpected keys: ${rejected.join(', ')}. ` +
    'No story facts were read and no side effects were attempted.',
  );
}

export function createMilestoneStatusHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  function milestoneStatus(args: MilestoneStatusArgs): MilestoneStatusReport | string {
    assertMilestoneStatusReadOnlyBoundary(args);
    const story = ctx.store.readStory(args.storyId);
    const milestoneLedger = ctx.store.readMilestoneLedger(args.storyId);
    const summary = ctx.store.readSummary(args.storyId);
    if (!milestoneLedger) {
      const report = buildMilestoneStatusReport({
        story,
        checklist: { items: [] },
        milestoneLedger,
        summary,
      });
      return wantsJson(args) ? report : renderMilestoneStatusReport(report);
    }

    const checklist = ctx.store.readChecklist(args.storyId);
    const report = buildMilestoneStatusReport({
      story,
      checklist,
      milestoneLedger,
      summary,
      currentEvidenceBinding: currentEvidenceBinding(ctx, args.storyId),
    });
    return wantsJson(args) ? report : renderMilestoneStatusReport(report);
  }

  return {
    milestone_status: milestoneStatus,
  };
}
