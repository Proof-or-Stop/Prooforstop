/**
 * Lifecycle Readiness P7: reviewer_batch — a READ-ONLY reviewer-launcher PLAN
 * producer.
 *
 * For a story in REVIEW, reviewer_batch consolidates and PRINTS the per-lane
 * reviewer-launcher plan WITHOUT launching anything:
 *
 *   - The active/required review lanes, resolved through the SAME opt-in path
 *     reviewer_list / lifecycle-readiness use (computeActiveReviewers over the
 *     story + checklist + decision + touchpoints).
 *   - Per lane, a STATE classified from existing facts:
 *       · current-pass   — a valid current-round review pass is recorded and no
 *                          material file changed since it (scopeChanged=false).
 *       · scope-changed  — the lane has a prior pass but material files changed
 *                          since the headHash it was bound to. Uses the SAME facts
 *                          as review_incremental_context (prior verdict, bound
 *                          headHash, scopeChanged, changed-files-since-last-pass).
 *       · no-receipt     — no current-round pass at all (launch / first run).
 *       · blocking       — a blocking verified finding is open for/affecting the
 *                          lane (round-decayed via isFindingBlocking).
 *   - The orchestrator launch INSTRUCTION for each lane that needs a (re-)run, in
 *     the canonical Agent subagent-spawn form
 *     `Agent({ subagent_type: "lattice-review-<lane>", prompt: "Review story <id> (<reason>)" })`
 *     (matching transition-effects.ts). This is an instruction the orchestrator
 *     executes to spawn the reviewer subagent — a CLI cannot spawn one, so it is
 *     NOT a runnable `dispatch` CLI command.
 *   - The overall REVIEW gate status (which lanes block REVIEW->TEST/DONE),
 *     consumed from the V1 buildStoryReadinessReport review readiness rows plus
 *     the per-lane blocking findings.
 *   - A read-only mode line. runCommands=false, writeEvidence=false.
 *
 * CRITICAL BOUNDARY: reviewer_batch is a strictly read-only PLAN producer. It
 * NEVER launches a reviewer, NEVER runs review_run_start, NEVER writes
 * review-runs.json / review-passes.json / findings.json or any evidence, NEVER
 * advances phase / launches reviewers / claims Authority / signs delivery. There
 * is NO --write/--launch/--run flag (pure read-only, mirroring P3 evidence_plan).
 * retired completion fields are hardcoded false. The orchestrator spawns the
 * reviewer subagents from this plan; a CLI cannot spawn them.
 */

import type { HandlerContext } from './context.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import {
  buildStoryReadinessReport,
  type StoryReadinessReport,
} from '../core/lifecycle-readiness.js';
import { computeActiveReviewers } from './reviewer-list.js';
import { reviewIncrementalContext } from '../core/review-incremental-context.js';
import {
  collectReviewerEvidenceState,
  type ReviewerEvidenceRecord,
} from '../core/review-run.js';
import { findingAgentMatchesReviewer } from '../core/reviewer-opt-in.js';
import { detectMdTouchpointsFromGit } from '../core/touchpoints-fallback.js';
import { isFindingBlocking, resolveReviewRoundCount } from '../core/advisory.js';
import { resolveWorkflowPolicy } from '../core/workflow-policy.js';
import { loadConfig } from '../core/config.js';
import type { Finding } from '../core/types.js';

interface ReviewerBatchArgs {
  storyId: string;
  format?: 'text' | 'json';
  json?: boolean;
  runCommands?: boolean;
  writeEvidence?: boolean;
  advancePhase?: boolean;
  launchReviewers?: boolean;
  authorityDone?: boolean;
  fullAuthorityDone?: boolean;
  productionDone?: boolean;
  write?: boolean;
  launch?: boolean;
  run?: boolean;
}

/** Per-lane state, classified from existing facts only (never from a launch). */
type ReviewerLaneState = 'current-pass' | 'scope-changed' | 'no-receipt' | 'blocking';

interface ReviewerLanePlan {
  /** Reviewer short name, e.g. concept / quality / behavior. */
  lane: string;
  /** Why the lane is active: baseline / "riskSignal: ..." / "touchpoints .md" / forced. */
  reason: string;
  /** Classified lane state. */
  state: ReviewerLaneState;
  /**
   * Whether material files changed since the lane's last pass headHash. Mirrors
   * review_incremental_context.scopeChanged (true on a first pass / no baseline).
   */
  scopeChanged: boolean;
  /** Material files changed since the lane's last pass (review_incremental_context.changedFiles). */
  changedFilesSinceLastPass: string[];
  /** Human summary of the prior verdict (review_incremental_context.priorVerdict), or null. */
  priorVerdict: string | null;
  /**
   * The orchestrator launch INSTRUCTION to spawn this lane's reviewer subagent,
   * in the canonical Agent(...) form, present iff the lane needs a (re-)run
   * (scope-changed / no-receipt / blocking). null for current-pass. This is an
   * instruction for the orchestrator, NOT a runnable `dispatch` CLI command.
   */
  launchInstruction: string | null;
  /** Blocking verified findings open for/affecting this lane (ids). */
  blockingFindings: string[];
}

export interface ReviewerBatchReport {
  storyId: string;
  reviewRound: string | null;
  lanes: ReviewerLanePlan[];
  gate: {
    /** Readiness-row codes/ids that block REVIEW->TEST/DONE. */
    blockedBy: string[];
    ready: boolean;
  };
  /** The V1 readiness report embedded verbatim (review-row source of truth). */
  readinessReport: StoryReadinessReport;
  mode: {
    runCommands: false;
    writeEvidence: false;
  };
  claims: {
    authorityDone: false;
    productionDone: false;
  };
}

/**
 * reviewer_batch reports the REVIEW->TEST gate (which lanes block leaving REVIEW).
 * That gate is the buildReviewGateRows projection, which buildStoryReadinessReport
 * only emits for target TEST/DONE — so we read at target=TEST to consume the
 * per-lane review rows (missing required lanes, blocking findings, quorum). The
 * embedded readinessReport is therefore the TEST-target projection.
 */
const READINESS_TARGET = 'TEST' as const;

function wantsJson(args: ReviewerBatchArgs): boolean {
  return args.json === true || args.format === 'json';
}

/**
 * Fail closed BEFORE any store read. reviewer_batch is a strictly read-only PLAN
 * producer: it launches no reviewer, runs no command, writes no evidence /
 * metadata, advances no phase, and never claims release readiness. Any flag
 * that would imply launching a reviewer, running a command, writing evidence,
 * advancing the lifecycle, or claiming Authority is rejected up front. There is
 * NO --write/--launch/--run path (the orchestrator spawns reviewer subagents
 * from this plan; the CLI never does).
 */
function assertBoundary(args: ReviewerBatchArgs): void {
  const rejected: string[] = [];
  if (args.runCommands === true) rejected.push('runCommands=true');
  if (args.writeEvidence === true) rejected.push('writeEvidence=true');
  if (args.advancePhase === true) rejected.push('advancePhase=true');
  if (args.launchReviewers === true) rejected.push('launchReviewers=true');
  if (args.authorityDone === true) rejected.push('authorityDone=true');
  if (args.fullAuthorityDone === true) rejected.push('fullAuthorityDone=true');
  if (args.productionDone === true) rejected.push('productionDone=true');
  if (args.write === true) rejected.push('write=true');
  if (args.launch === true) rejected.push('launch=true');
  if (args.run === true) rejected.push('run=true');
  if (rejected.length === 0) return;
  throw new Error(
    `reviewer_batch refuses unsupported side effects: ${rejected.join(' and ')}. ` +
    'reviewer_batch is a strictly read-only PLAN producer: no story facts were read, no reviewer was launched, ' +
    'no review_run_start was invoked, no review-runs/review-passes/findings or any evidence was written, ' +
    'no command was run, and no phase was advanced. The orchestrator spawns the reviewer subagents from this plan; ' +
    'a CLI cannot spawn them. There is NO --write/--launch/--run path.',
  );
}

/**
 * The orchestrator launch INSTRUCTION to spawn a lane's reviewer subagent, in the
 * canonical Agent subagent-spawn form (matching transition-effects.ts). This is an
 * instruction the orchestrator executes — a CLI cannot spawn a subagent — so it is
 * NOT a runnable `dispatch` CLI command. The lane's activation reason annotates the
 * prompt (falling back to "baseline" when absent).
 */
function laneLaunchInstruction(storyId: string, lane: string, reason: string): string {
  const name = lane.startsWith('lattice-review-') ? lane.slice('lattice-review-'.length) : lane;
  const why = reason && reason.trim() ? reason.trim() : 'baseline';
  return `Agent({ subagent_type: "lattice-review-${name}", prompt: "Review story ${storyId} (${why})" })`;
}

/**
 * Whether a valid current-round reviewer evidence record (finding OR pass) exists
 * for `lane` in the collected, signature-validated current-round evidence state.
 * We reuse collectReviewerEvidenceState (the SAME source the V1 review gate rows
 * consume) so the per-lane "has a current-round receipt" predicate matches the
 * gate exactly — no re-derivation from raw review-passes.json.
 */
function laneHasCurrentRoundEvidence(records: ReviewerEvidenceRecord[], lane: string): boolean {
  return records.some((record) => findingAgentMatchesReviewer(record.agent, lane));
}

/** The blocking verified findings (round-decayed) attributable to `lane`. */
function blockingFindingsForLane(
  blockingFindings: Finding[],
  lane: string,
): Finding[] {
  return blockingFindings.filter((finding) => findingAgentMatchesReviewer(finding.agent, lane));
}

/**
 * Classify a single active lane from existing facts only. Precedence:
 *   1. blocking      — a blocking verified finding is open for the lane.
 *   2. no-receipt    — no valid current-round pass/finding for the lane.
 *   3. scope-changed — has a current-round receipt but scope changed since its
 *                      last pass (review_incremental_context.scopeChanged).
 *   4. current-pass  — has a current-round receipt and nothing changed since.
 */
function classifyLaneState(
  hasCurrentEvidence: boolean,
  scopeChanged: boolean,
  laneBlockingFindings: Finding[],
): ReviewerLaneState {
  if (laneBlockingFindings.length > 0) return 'blocking';
  if (!hasCurrentEvidence) return 'no-receipt';
  if (scopeChanged) return 'scope-changed';
  return 'current-pass';
}

export function renderReviewerBatchReport(report: ReviewerBatchReport): string {
  const lines = [
    `Reviewer batch (${report.storyId})`,
    'mode: read-only (no reviewer launched, no review_run_start, no commands run, no evidence written)',
    `reviewRound: ${report.reviewRound ?? '(none)'}`,
    `readinessReport: target=${report.readinessReport.target} rows=${report.readinessReport.readiness.length}`,
    `gate: ${report.gate.ready ? 'READY' : 'BLOCKED'} blockedBy=[${report.gate.blockedBy.join(', ')}]`,
    '',
    `lanes (${report.lanes.length}):`,
  ];

  if (report.lanes.length === 0) {
    lines.push('    none');
  } else {
    for (const lane of report.lanes) {
      lines.push(`  - ${lane.lane} [${lane.state}] (${lane.reason})`);
      lines.push(`      scopeChanged: ${lane.scopeChanged}`);
      lines.push(`      priorVerdict: ${lane.priorVerdict ?? '(none)'}`);
      if (lane.changedFilesSinceLastPass.length > 0) {
        lines.push(`      changedFilesSinceLastPass (${lane.changedFilesSinceLastPass.length}):`);
        for (const file of lane.changedFilesSinceLastPass) lines.push(`        ${file}`);
      } else {
        lines.push('      changedFilesSinceLastPass: (none)');
      }
      if (lane.blockingFindings.length > 0) {
        lines.push(`      blockingFindings: ${lane.blockingFindings.join(', ')}`);
      }
      lines.push(`      launch: ${lane.launchInstruction ?? '(no re-run needed)'}`);
    }
  }

  lines.push('', 'Local assurance:');
  lines.push('  admissibilityStatus: reviewer-launch-preview');
  lines.push('  assuranceLevel: local');
  lines.push('  evidenceScope: review-readiness');
  return lines.join('\n');
}

export function createReviewerBatchHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  function reviewerBatch(args: ReviewerBatchArgs): ReviewerBatchReport | string {
    // Fail closed on ANY side-effect flag BEFORE reading a single story fact.
    assertBoundary(args);

    const storyId = (args.storyId || '').trim();
    if (!storyId) {
      throw new Error('reviewer_batch: storyId is required');
    }
    // Path-traversal guard: reuse the single source of truth (no duplicated regex)
    // so a crafted `../../outside`-style id cannot escape the story tree.
    if (!isCanonicalStoryId(storyId)) {
      throw new Error(
        `reviewer_batch: storyId "${storyId}" is not a canonical, path-safe Proofbound story id`,
      );
    }

    // V1 source of truth: the StoryReadinessReport REVIEW rows drive the gate.
    const readinessReport = buildStoryReadinessReport({
      storyId,
      target: READINESS_TARGET,
      store: ctx.store,
      root: ctx.root,
    });

    const story = ctx.store.readStory(storyId);

    // Active reviewers — resolved through the SAME opt-in path lifecycle-readiness
    // uses (computeActiveReviewers over story + checklist + decision + touchpoints).
    let checklist: { items: unknown[] } = { items: [] };
    try {
      checklist = ctx.store.readChecklist(storyId);
    } catch {
      /* no checklist yet — computeChannel treats as express */
    }
    let decision = null;
    try {
      decision = ctx.store.readDecision(storyId);
    } catch {
      decision = null;
    }
    const understanding = ctx.store.readUnderstanding(storyId);
    const touchpoints = understanding?.touchpoints ?? detectMdTouchpointsFromGit(ctx.root);
    const activeReviewers = computeActiveReviewers(story, checklist, decision, touchpoints);

    // Current-round, signature-validated reviewer evidence (the SAME records the
    // V1 review gate rows consume) + round-decayed blocking findings.
    const evidenceState = collectReviewerEvidenceState(ctx.store, storyId, ctx.root);
    const policy = resolveWorkflowPolicy(loadConfig(ctx.root), story);
    const roundCount = resolveReviewRoundCount(ctx.store, storyId);
    const blockingSeverities = policy.review.blockingSeverities;
    const blockingFindings = evidenceState.valid
      .map((record) => record.finding)
      .filter((finding): finding is Finding => !!finding)
      .filter((finding) => isFindingBlocking(finding, blockingSeverities, roundCount));

    const lanes: ReviewerLanePlan[] = activeReviewers.map((reviewer) => {
      // review_incremental_context facts: prior verdict, bound headHash,
      // scopeChanged, and the material files changed since the lane's last pass.
      const incremental = reviewIncrementalContext(ctx.store, ctx.root, storyId, reviewer.name);
      const hasCurrentEvidence = laneHasCurrentRoundEvidence(evidenceState.valid, reviewer.name);
      const laneBlocking = blockingFindingsForLane(blockingFindings, reviewer.name);
      const state = classifyLaneState(hasCurrentEvidence, incremental.scopeChanged, laneBlocking);
      const needsRun = state !== 'current-pass';
      return {
        lane: reviewer.name,
        reason: reviewer.reason,
        state,
        scopeChanged: incremental.scopeChanged,
        changedFilesSinceLastPass: incremental.changedFiles,
        priorVerdict: incremental.priorVerdict,
        launchInstruction: needsRun
          ? laneLaunchInstruction(storyId, reviewer.name, reviewer.reason)
          : null,
        blockingFindings: laneBlocking.map((finding) => finding.id),
      };
    });

    // Gate: consume the V1 review readiness rows that BLOCK (source='review',
    // blocking=true) — the authoritative REVIEW->TEST/DONE blocker set.
    const blockedBy = readinessReport.readiness
      .filter((rowEntry) => rowEntry.source === 'review' && rowEntry.blocking)
      .map((rowEntry) => rowEntry.code || rowEntry.id);
    const ready = blockedBy.length === 0;

    const report: ReviewerBatchReport = {
      storyId,
      reviewRound: readinessReport.artifacts.reviewRound,
      lanes,
      gate: { blockedBy, ready },
      readinessReport,
      mode: { runCommands: false, writeEvidence: false },
      claims: { authorityDone: false, productionDone: false },
    };

    return wantsJson(args) ? report : renderReviewerBatchReport(report);
  }

  return {
    reviewer_batch: reviewerBatch,
  };
}
