import type { HandlerContext } from './context.js';
import {
  buildMilestoneCloseoutMissingReport,
  buildMilestoneCloseoutSnapshot,
  buildMilestoneStatusReport,
  buildMilestoneStatusReportFromCloseoutSnapshot,
  currentMilestoneStatusEvidenceBinding,
  MILESTONE_CLOSEOUT_FILENAME,
  MILESTONE_CLOSEOUT_SCHEMA_VERSION,
  MILESTONE_STATUS_SCHEMA_VERSION,
  renderMilestoneCloseoutMissingReport,
  renderMilestoneCloseoutSnapshot,
  renderMilestoneStatusBrief,
  renderMilestoneStatusReport,
  type MilestoneStatusCurrentEvidenceBinding,
  type MilestoneCloseoutSnapshot,
  type MilestoneStatusReport,
} from '../core/milestone-status.js';
import { assertActiveIdentityConsumerContract } from '../core/active-identity-consumer-contract.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { wantsFullOutput } from '../cli/output-verbosity.js';

interface MilestoneStatusArgs {
  storyId: string;
  format?: 'text' | 'json';
  json?: boolean;
  full?: boolean;
  brief?: boolean;
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
  | { status: 'skipped'; reason: 'closeout_snapshot_unbuildable'; message: string }
  | { status: 'written'; snapshot: MilestoneCloseoutSnapshot };

// B-7c05 CHK-001: --full / --brief select the render verbosity of the text
// output; they are read-only display flags (never write, run, or advance).
const ALLOWED_MILESTONE_STATUS_ARG_KEYS = new Set(['storyId', 'format', 'json', 'full', 'brief']);
const ALLOWED_MILESTONE_CLOSEOUT_ARG_KEYS = new Set(['storyId', 'format', 'json']);

function wantsJson(args: MilestoneStatusArgs | MilestoneCloseoutArgs): boolean {
  return args.json === true || args.format === 'json';
}

/**
 * B-7c05 CHK-001: JSON opt-in returns the frozen report object; otherwise the
 * text output is BRIEF by default and the full 7-column table is restored by
 * --full / PROOF_OR_STOP_BRIEF_OUTPUT=0.
 */
function renderMilestoneStatus(report: MilestoneStatusReport, args: MilestoneStatusArgs): MilestoneStatusReport | string {
  if (wantsJson(args)) return report;
  return wantsFullOutput(args) ? renderMilestoneStatusReport(report) : renderMilestoneStatusBrief(report);
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

  // Reconciliation (B-f7b3 CHK-010): closeout must NOT act as a second DONE gate
  // with throw-semantics that diverge from evaluateDoneIntentEquivalence (the
  // single designed gate, which already ran before this DONE transition). It runs
  // AFTER actor.send has moved the story to DONE, so a throw here would corrupt an
  // already-committed transition that the designed gate allowed. Instead of
  // propagating buildMilestoneCloseoutSnapshot's strict rejection, degrade to a
  // non-throwing 'skipped' capture: capture what exists, and when the report is
  // incomplete/risky/stale simply record that no auditable snapshot was written.
  // buildMilestoneCloseoutSnapshot itself STAYS strict (CHK-005 still rejects a
  // stale-only report); only this DONE-time capture path is made non-blocking.
  let snapshot: MilestoneCloseoutSnapshot;
  try {
    snapshot = buildMilestoneCloseoutSnapshot({
      report,
      bindings: options.currentEvidenceBinding,
      generatedAt: options.generatedAt,
    });
  } catch (error) {
    return {
      status: 'skipped',
      reason: 'closeout_snapshot_unbuildable',
      message:
        `Milestone closeout snapshot not written for ${storyId}: ${error instanceof Error ? error.message : String(error)}. ` +
        'DONE was already permitted by the ProofStory intent-equivalence gate; closeout is snapshot-only and does not re-gate DONE.',
    };
  }
  store.writeMilestoneCloseout(storyId, snapshot);
  return { status: 'written', snapshot };
}

export function createMilestoneStatusHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  function milestoneStatus(args: MilestoneStatusArgs): MilestoneStatusReport | string {
    assertActiveIdentityConsumerContract('milestone-status', MILESTONE_STATUS_SCHEMA_VERSION);
    assertMilestoneStatusReadOnlyBoundary(args);
    const story = ctx.store.readStory(args.storyId);
    if (story.phase === 'DONE') {
      const snapshot = ctx.store.readMilestoneCloseout(args.storyId);
      if (snapshot?.schemaVersion === MILESTONE_CLOSEOUT_SCHEMA_VERSION) {
        const report = buildMilestoneStatusReportFromCloseoutSnapshot(snapshot, { phase: story.phase });
        return renderMilestoneStatus(report, args);
      }
    }

    const milestoneLedger = ctx.store.readMilestoneLedger(args.storyId);
    const summary = ctx.store.readSummary(args.storyId);
    if (!milestoneLedger) {
      const report = buildMilestoneStatusReport({
        story,
        checklist: { items: [] },
        milestoneLedger,
        summary,
      });
      return renderMilestoneStatus(report, args);
    }

    const checklist = ctx.store.readChecklist(args.storyId);
    const report = buildMilestoneStatusReport({
      story,
      checklist,
      milestoneLedger,
      summary,
      currentEvidenceBinding: currentEvidenceBinding(ctx, args.storyId),
    });
    return renderMilestoneStatus(report, args);
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
    if (snapshot.schemaVersion !== MILESTONE_CLOSEOUT_SCHEMA_VERSION) {
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
