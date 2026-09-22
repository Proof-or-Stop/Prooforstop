import { rethrowIntentAmendmentIntegrityError } from '../core/verification-intent-amendment.js';
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
 *       · awaiting-repair — a valid blocking observation with exact committed material
 *                          or metadata-only drift; guidance only, never a gate PASS.
 *       · blocking       — a blocking verified finding is open for/affecting the
 *                          lane (round-decayed via isFindingBlocking).
 *   - Host-neutral owner guidance for each lane that needs a (re-)run: obtain the
 *     canonical dispatch prompt, use a fresh-context host launch, and retain the
 *     exact returned child id. This is an instruction the orchestrator executes;
 *     reviewer_batch itself cannot spawn a subagent.
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
import {
  canonicalReviewerLane,
  findingAgentMatchesReviewer,
  reviewerRoleReadIds,
} from '../core/reviewer-opt-in.js';
import { detectMdTouchpointsFromGit } from '../core/touchpoints-fallback.js';
import { resolveReviewRoundCount } from '../core/advisory.js';
import { readDynamicFindingDecision } from '../core/finding-applicability-projection.js';
import { resolveWorkflowPolicy } from '../core/workflow-policy.js';
import { loadConfig } from '../core/config.js';
import type { Finding } from '../core/types.js';
import type { StoryStore } from '../core/store.js';
import { checkEvidenceFreshnessForGit, classifyEvidenceFreshness } from '../core/evidence-freshness.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import {
  renderFormalManagedReviewLaunch,
  renderReviewerDispatchLaunch,
  REVIEWER_CHILD_ID_WAIT_BOUNDARY,
} from '../core/reviewer-launch-guidance.js';

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
type ReviewerLaneState = 'current-pass' | 'scope-changed' | 'no-receipt' | 'blocking' | 'awaiting-repair' | 'outside-remediation-impact';

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
   * Host-neutral owner launch guidance, present iff the lane needs a (re-)run
   * (scope-changed / no-receipt / blocking). null for current-pass or awaiting-repair. This is an
   * instruction for the orchestrator, NOT a runnable `dispatch` CLI command.
   */
  launchInstruction: string | null;
  /** Why this plan requests a new observation or waits for the owner. */
  actionReason: string;
  /** Blocking verified findings open for/affecting this lane (ids). */
  blockingFindings: string[];
}

export interface ReviewerBatchReport {
  storyId: string;
  reviewRound: string | null;
  lanes: ReviewerLanePlan[];
  /**
   * One owner-visible concurrency barrier for all lanes that need a fresh run.
   * Hosts launch every listed lane before waiting for any individual result.
   * This is still a read-only plan; it grants no launch or review authority.
   */
  executionPlan: {
    strategy: 'parallel-barrier';
    launchableLanes: string[];
    launchAllBeforeWait: true;
    waitPolicy: 'collective-after-all-acknowledged';
    maxConcurrency: number;
  };
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
 * Host-neutral owner launch guidance. The owner first obtains the canonical
 * dispatch prompt, then launches exactly one fresh-context reviewer and retains
 * the returned child id. This remains guidance; reviewer_batch never launches it.
 */
function laneLaunchInstruction(storyId: string, lane: string, reason: string): string {
  const name = lane.startsWith('proof-or-stop-review-') ? lane.slice('proof-or-stop-review-'.length) : lane;
  const why = reason && reason.trim() ? reason.trim() : 'baseline';
  const nativeLaunch = renderReviewerDispatchLaunch({
    storyId,
    agentType: `proof-or-stop-review-${name}`,
  });
  // Keep the formal alternative explicit at this producer seam and render it
  // through the shared helper so error and batch guidance cannot describe
  // different REVIEW evidence paths.
  const managedLaunch = renderFormalManagedReviewLaunch(storyId, `proof-or-stop-review-${name}`);
  return `${nativeLaunch} ${managedLaunch} ${REVIEWER_CHILD_ID_WAIT_BOUNDARY} Every launched child id must be nonempty; when the plan launches multiple lanes, their child ids must also be distinct. Activation reason: ${why}.`;
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

/** Launch guidance only: a valid blocker must still block the lifecycle gate.
 * A prior PASS is not required for a first observed defect to await repair.
 * Validity alone is insufficient: unrelated main material drift also needs review.
 */
export function blockingObservationAwaitsRepair(
  store: StoryStore, root: string, storyId: string,
  findings: Finding[], validRecords: ReviewerEvidenceRecord[],
): boolean {
  if (findings.length === 0) return false;
  const runs = store.readReviewRuns(storyId).runs;
  return findings.every(finding => {
    const record = validRecords.find(row => row.kind === 'finding' && row.id === finding.id);
    if (!record?.reviewRunId) return false;
    const run = runs.find(row => row.reviewRunId === record.reviewRunId);
    if (!run) return false;
    try {
      const signedRoot = run.workspaceBinding?.signedWorkspaceRoot
        ?? resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });
      const freshness = checkEvidenceFreshnessForGit(signedRoot, run.headHash, run.materialHash,
        run.workspaceBinding?.metadataRoot ?? root, run.storyFilesHash ?? run.workspaceBinding?.storyFilesHash);
      const classification = classifyEvidenceFreshness(freshness, run.headHash);
      return classification === 'CURRENT_MATERIAL' || classification === 'KNOWN_METADATA_ONLY_HEAD_DRIFT';
    } catch { return false; }
  });
}

/**
 * Classify a single active lane from existing facts only. Precedence:
 *   1. awaiting-repair — current blocking observation with exact material or metadata-only head drift.
 *      blocking      — blocking evidence still requires a new/changed-input observation.
 *   2. no-receipt    — no valid current-round pass/finding for the lane.
 *   3. scope-changed — has a current-round receipt but scope changed since its
 *                      last pass (review_incremental_context.scopeChanged).
 *   4. current-pass  — has a current-round receipt and nothing changed since.
 */
export function classifyLaneState(
  hasCurrentEvidence: boolean,
  scopeChanged: boolean,
  laneBlockingFindings: Finding[],
  awaitsRepair: boolean,
  required: boolean,
): ReviewerLaneState {
  if (laneBlockingFindings.length > 0) {
    return awaitsRepair ? 'awaiting-repair' : 'blocking';
  }
  if (!required) return 'outside-remediation-impact';
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
    `parallel-barrier: launch all ${report.executionPlan.launchableLanes.length} requested lanes before waiting for any result`,
    `wait collectively only after every launched lane has acknowledged its assignment; maxConcurrency=${report.executionPlan.maxConcurrency}`,
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
      lines.push(`      action: ${lane.actionReason}`);
      lines.push(`      launch: ${lane.launchInstruction ?? (lane.state === 'awaiting-repair' ? '(await owner repair; TEST remains blocked)' : '(no re-run needed)')}`);
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
        `reviewer_batch: storyId "${storyId}" is not a canonical, path-safe Proof-or-Stop story id`,
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
    } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
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
      .filter((finding) => readDynamicFindingDecision({ store: ctx.store, projectRoot: ctx.root, storyId,
        finding, effectiveBlockingSeverities: blockingSeverities, round: roundCount }).blocking);

    const lanes: ReviewerLanePlan[] = activeReviewers.map((reviewer) => {
      // review_incremental_context facts: prior verdict, bound headHash,
      // scopeChanged, and the material files changed since the lane's last pass.
      const canonicalLane = canonicalReviewerLane(reviewer.name) ?? reviewer.name;
      const incremental = reviewIncrementalContext(ctx.store, ctx.root, storyId, canonicalLane);
      const hasCurrentEvidence = laneHasCurrentRoundEvidence(evidenceState.valid, canonicalLane);
      const laneBlocking = blockingFindingsForLane(blockingFindings, canonicalLane);
      const state = classifyLaneState(hasCurrentEvidence, incremental.scopeChanged, laneBlocking,
        blockingObservationAwaitsRepair(ctx.store, ctx.root, storyId, laneBlocking, evidenceState.valid),
        !readinessReport.reviewRoster || readinessReport.reviewRoster.requiredLanes.includes(canonicalLane));
      const needsRun = state !== 'current-pass' && state !== 'awaiting-repair' && state !== 'outside-remediation-impact';
      const actionReason = state === 'outside-remediation-impact'
        ? 'Current verified remediation selection excludes this lane; this is not a new PASS and does not grant TEST.'
        : state === 'awaiting-repair'
        ? 'Current verified blocker on unchanged committed review inputs: retain the finding, complete the current review wave, then use owner remediation before another observation; TEST remains blocked. Uncommitted repairs do not refresh this plan.'
        : needsRun ? 'A current observation is required for missing or changed review inputs.' : 'The current observation remains valid.';
      return {
        lane: canonicalLane,
        reason: reviewer.reason,
        state,
        scopeChanged: incremental.scopeChanged,
        changedFilesSinceLastPass: incremental.changedFiles,
        priorVerdict: incremental.priorVerdict,
        launchInstruction: needsRun
          ? laneLaunchInstruction(storyId, reviewer.name, reviewer.reason)
          : null,
        actionReason,
        blockingFindings: laneBlocking.map((finding) => finding.id),
      };
    });

    // Gate: consume the V1 review readiness rows that BLOCK (source='review',
    // blocking=true) — the authoritative REVIEW->TEST/DONE blocker set.
    const blockedBy = readinessReport.readiness
      .filter((rowEntry) => rowEntry.source === 'review' && rowEntry.blocking)
      .map((rowEntry) => rowEntry.code || rowEntry.id);
    const ready = blockedBy.length === 0;
    const launchableLanes = lanes
      .filter((lanePlan) => lanePlan.launchInstruction !== null)
      .map((lanePlan) => lanePlan.lane);

    const report: ReviewerBatchReport = {
      storyId,
      reviewRound: readinessReport.artifacts.reviewRound,
      lanes,
      executionPlan: {
        strategy: 'parallel-barrier',
        launchableLanes,
        launchAllBeforeWait: true,
        waitPolicy: 'collective-after-all-acknowledged',
        maxConcurrency: launchableLanes.length,
      },
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
