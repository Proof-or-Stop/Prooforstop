import type { HandlerContext } from './context.js';
import {
  buildMilestoneCloseoutMissingReport,
  buildMilestoneCloseoutSnapshot,
  buildMilestoneStatusReport,
  currentMilestoneStatusEvidenceBinding,
  MILESTONE_CLOSEOUT_FILENAME,
  renderMilestoneCloseoutMissingReport,
  renderMilestoneCloseoutSnapshot,
  renderMilestoneStatusReport,
  type MilestoneStatusCurrentEvidenceBinding,
  type MilestoneCloseoutSnapshot,
  type MilestoneStatusReport,
} from '../core/milestone-status.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';

interface MilestoneStatusArgs {
  storyId: string;
  format?: 'text' | 'json';
  json?: boolean;
  [key: string]: unknown;
}

interface MilestoneCloseoutArgs {
  storyId: string;
  format?: 'text' | 'json';
  json?: boolean;
  [key: string]: unknown;
}

export type MilestoneCloseoutCaptureResult =
  | { status: 'skipped'; reason: 'missing_milestone_ledger'; message: string }
  | { status: 'written'; snapshot: MilestoneCloseoutSnapshot };

const ALLOWED_MILESTONE_STATUS_ARG_KEYS = new Set(['storyId', 'format', 'json']);
const ALLOWED_MILESTONE_CLOSEOUT_ARG_KEYS = new Set(['storyId', 'format', 'json']);

function wantsJson(args: MilestoneStatusArgs | MilestoneCloseoutArgs): boolean {
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
  return currentMilestoneStatusEvidenceBinding(gitCwd, ctx.root);
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

export function assertMilestoneCloseoutReadOnlyBoundary(args: MilestoneCloseoutArgs): void {
  const rejected = Object.keys(args).filter((key) => !ALLOWED_MILESTONE_CLOSEOUT_ARG_KEYS.has(key));
  if (rejected.length === 0) return;
  throw new Error(
    `milestone_closeout V1 is read-only and accepts only storyId, format, and json before reading story facts; unexpected keys: ${rejected.join(', ')}. ` +
    'No story facts were read and no side effects were attempted.',
  );
}

export function captureMilestoneCloseoutSnapshotFromStore(
  store: Pick<HandlerContext['store'], 'readStory' | 'readChecklist' | 'readMilestoneLedger' | 'readSummary' | 'writeMilestoneCloseout'>,
  storyId: string,
  options: { currentEvidenceBinding?: MilestoneStatusCurrentEvidenceBinding; generatedAt?: string } = {},
): MilestoneCloseoutCaptureResult {
  const milestoneLedger = store.readMilestoneLedger(storyId);
  if (!milestoneLedger) {
    return {
      status: 'skipped',
      reason: 'missing_milestone_ledger',
      message: `No milestone-ledger.json exists for ${storyId}; DONE milestone closeout capture skipped.`,
    };
  }

  const story = store.readStory(storyId);
  const checklist = store.readChecklist(storyId);
  const summary = store.readSummary(storyId);
  const report = buildMilestoneStatusReport({
    story,
    checklist,
    milestoneLedger,
    summary,
    currentEvidenceBinding: options.currentEvidenceBinding,
  });
  const snapshot = buildMilestoneCloseoutSnapshot({
    report,
    bindings: options.currentEvidenceBinding,
    generatedAt: options.generatedAt,
  });
  store.writeMilestoneCloseout(storyId, snapshot);
  return { status: 'written', snapshot };
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

  function milestoneCloseout(args: MilestoneCloseoutArgs): MilestoneCloseoutSnapshot | ReturnType<typeof buildMilestoneCloseoutMissingReport> | string {
    assertMilestoneCloseoutReadOnlyBoundary(args);
    const snapshot = ctx.store.readMilestoneCloseout(args.storyId);
    if (!snapshot) {
      const missing = buildMilestoneCloseoutMissingReport(
        args.storyId,
        ctx.store.storyFilePath(args.storyId, MILESTONE_CLOSEOUT_FILENAME),
      );
      return wantsJson(args) ? missing : renderMilestoneCloseoutMissingReport(missing);
    }
    if (snapshot.schemaVersion !== 'proofbound.milestone_closeout.v1') {
      throw new Error(
        `Unsupported milestone closeout snapshot schema for ${args.storyId}: ${String((snapshot as { schemaVersion?: unknown }).schemaVersion)}`,
      );
    }
    return wantsJson(args) ? snapshot : renderMilestoneCloseoutSnapshot(snapshot);
  }

  return {
    milestone_status: milestoneStatus,
    milestone_closeout: milestoneCloseout,
  };
}
