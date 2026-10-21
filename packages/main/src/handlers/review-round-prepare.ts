/**
 * review_round_prepare — one owner command for the per-round managed REVIEW
 * ceremony. It composes the EXISTING handlers in-process, in the same order an
 * owner runs them by hand:
 *
 *   1. reviewer_batch (the exact execution plan);
 *   2. candidate_spec_route --hosts=false when managed review is blocked by a
 *      missing/stale route (fullScanReason only when routing requires it; a
 *      project with no requirements corpus is routed with an automatic
 *      full-scan reason by core routing, so no owner retry), then
 *      the plan is recomputed;
 *   3. per launchable lane: dispatch --agentType=<lane> --summary=true, then
 *      review_run_start --agent=<lane> --lane=<lane> --summary=true.
 *
 * Every inner handler keeps its own validation (phase, clean tree, dispatch
 * binding, inventory locks, signatures). The outer command is owner-lease and
 * REVIEW-phase gated as storyScopedMutating (a superset of the inner gates).
 * With inventoryCritic=true (v4.1 cost plan N2) it prepares the round's
 * inventory-completeness critic in ONE step instead of three processes:
 * review_inventory_begin when the current round has no OPEN epoch, then — only
 * when review_inventory_status reports REVIEW_INVENTORY_CRITIC_INCOMPLETE — the
 * critic dispatch (skipped when its binding is already current) and its
 * review_run_start. Same handlers, same order, same gates as `next` proposes
 * them one by one.
 *
 * It launches no reviewer host, writes no review verdict, and never prints a
 * prompt body. On failure it names the failed step and lists lanes already
 * started so no partial state is hidden.
 */
import { orderLanesForLaunch } from '../core/review-lane-launch-order.js';
import type { HandlerContext } from './context.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import type { ReviewerBatchReport } from './reviewer-batch.js';
import { currentOpenReviewInventory, evaluateReviewInventoryWave, reviewInventoryPurposeBinding } from '../core/review-inventory-epoch.js';
import { currentMaterialHash } from '../core/evidence-freshness.js';
import { MANAGED_INVENTORY_CRITIC_LANE } from '../core/managed-inventory-critic.js';
import { verifyCurrentReviewerDispatchBinding } from '../core/review-run.js';

type HandlerLookup = (name: string) => ((...args: any[]) => any) | undefined;

export interface ReviewRoundPrepareArgs {
  storyId: string;
  fullScanReason?: string;
  inventoryCritic?: boolean;
  /** Lab run131: prepare only these lanes (a failed lane relaunched while its siblings still run). */
  lanes?: string[];
  json?: boolean;
}

export interface ReviewRoundPrepareReport {
  storyId: string;
  round: string | null;
  head: string | null;
  worktree: string;
  routed: boolean;
  launchableLanes: string[];
  reviewRuns: Record<string, string>;
  controllerCommand: string | null;
  /** inventoryCritic mode: the epoch begun (null when one was already open), and the critic ReviewRun started (null when none was due). */
  inventory?: { epochId: string | null; begun: boolean; criticDispatched: boolean; criticReviewRunId: string | null; status: string };
}

export const REVIEW_BATCH_CONTROLLER = 'python3 /tmp/pos-review-batch-controller.py';

export function renderReviewRoundControllerCommand(
  storyId: string,
  worktree: string,
  reviewRuns: Record<string, string>,
): string | null {
  const lanes = Object.keys(reviewRuns);
  if (lanes.length === 0) return null;
  return `${REVIEW_BATCH_CONTROLLER} --story-id=${storyId} --worktree=${worktree}`
    + lanes.map(lane => ` --review-run=${lane}=${reviewRuns[lane]}`).join('');
}

export function reviewRoundPrepareCommand(storyId: string, fullScanReason?: string): string {
  return fullScanReason === undefined
    ? `proof-or-stop review_round_prepare --storyId=${storyId}`
    : `proof-or-stop review_round_prepare --storyId=${storyId} --fullScanReason=${JSON.stringify(fullScanReason)}`;
}

function requiresFullScanReason(readiness: ReviewerBatchReport['managedReviewReadiness']): boolean {
  return readiness.status === 'blocked' && (readiness.nextAction ?? '').includes('"fullScanReason"');
}

/**
 * Old-PoS run 58 (run58-analysis.md §4 (c), fix H): the earlier full-scan
 * route only went stale (HEAD moved after repair commits); the escalation it
 * was justified for is unchanged, so the framework reroutes with a recorded
 * reason (the earlier one, if readable) instead of refusing until the owner
 * types one (run 58: 4 rounds, 4 refusals, 4 hand-written reasons). Any other
 * escalation (a fresh routing that needs one) still needs the owner's reason.
 */
export function defaultFullScanReason(readiness: ReviewerBatchReport['managedReviewReadiness'], earlierReason: string | null | undefined): string | null {
  if (readiness.status !== 'blocked' || !String(readiness.reason ?? '').startsWith('managed_review_candidate_binding_stale')) return null;
  const stale = String(readiness.reason).replace(/^managed_review_candidate_binding_stale:?\s*/, '').trim() || 'binding';
  const earlier = typeof earlierReason === 'string' && earlierReason.trim() ? ` Earlier reason: ${earlierReason.trim().slice(0, 400)}` : '';
  return `Framework reroute of the earlier full-scan candidate route: its binding is stale (${stale}) after commits since it was routed; the escalation it was justified for is unchanged.${earlier}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function renderReviewRoundPrepareReport(report: ReviewRoundPrepareReport): string {
  const lines = [
    `Review round prepared (${report.storyId})`,
    `round: ${report.round ?? '(none)'}`,
    `head: ${report.head ?? '(unknown)'}`,
    `routed: ${report.routed}`,
  ];
  const lanes = Object.entries(report.reviewRuns);
  if (lanes.length === 0) {
    lines.push('reviewRuns: none (no launchable lanes; nothing to launch or wait for)');
  } else {
    lines.push('reviewRuns:');
    for (const [lane, id] of lanes) lines.push(`  ${lane}=${id}`);
    lines.push('next:', `  ${report.controllerCommand}`);
  }
  return lines.join('\n');
}

export function createReviewRoundPrepareHandlers(ctx: HandlerContext, lookup: HandlerLookup) {
  function handler(name: string): (...args: any[]) => any {
    const fn = lookup(name);
    if (!fn) throw new Error(`review_round_prepare: required handler ${name} is not registered`);
    return fn;
  }

  function earlierScanReason(storyId: string): string | null {
    try { return ctx.store.readCandidateSpecSet(storyId)?.scanEscalationReason ?? null; } catch { return null; }
  }

  async function reviewRoundPrepare(args: ReviewRoundPrepareArgs): Promise<ReviewRoundPrepareReport | string> {
    const storyId = (args.storyId || '').trim();
    if (!storyId || !isCanonicalStoryId(storyId)) {
      throw new Error(`review_round_prepare: storyId "${storyId}" is not a canonical, path-safe Proof-or-Stop story id`);
    }
    const fullScanReason = args.fullScanReason?.trim() || undefined;
    if (args.fullScanReason !== undefined && !fullScanReason) {
      throw new Error('review_round_prepare: fullScanReason must be nonblank when provided');
    }
    const started: Record<string, string> = {};
    const step = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        const startedList = Object.entries(started).map(([lane, id]) => `${lane}=${id}`).join(', ') || 'none';
        throw new Error(`review_round_prepare failed at step ${name}: ${message(error)}\nLanes already started: ${startedList}`);
      }
    };
    const plan = (): Promise<ReviewerBatchReport> =>
      step('reviewer_batch', () => handler('reviewer_batch')({ storyId, json: true }) as ReviewerBatchReport);
    const route = (reason?: string) => step(reason ? 'candidate_spec_route(fullScanReason)' : 'candidate_spec_route',
      () => handler('candidate_spec_route')({ storyId, hosts: false, json: true, ...(reason ? { fullScanReason: reason } : {}) }));
    const stopForReason = (readiness: ReviewerBatchReport['managedReviewReadiness']): never => {
      throw new Error(
        `review_round_prepare: candidate routing requires a tool-driven broad-scan escalation (${readiness.reason}); `
        + 'no reviewer was dispatched or started. Rerun with a specific justified fullScanReason:\n'
        + `  ${reviewRoundPrepareCommand(storyId, '<specific justified tool-driven broad-scan reason>')}`,
      );
    };

    if (args.inventoryCritic === true) return prepareCritic(storyId, args.json === true, step);

    let report = await plan();
    let routed = false;
    let usedReason = false;
    const waveLanes = openEpochWaveLanes(storyId);
    if (report.executionPlan.launchableLanes.length > 0 || waveLanes.length > 0) {
      // At most two routes: an ordinary reroute, then one escalated reroute
      // when the fresh route itself proves escalation is required.
      while (report.managedReviewReadiness.status === 'blocked') {
        const needsReason = requiresFullScanReason(report.managedReviewReadiness);
        // Old-PoS run 58 (H): a full-scan route that only went stale is rerouted with a framework reason.
        const reason = fullScanReason ?? (needsReason && !usedReason ? defaultFullScanReason(report.managedReviewReadiness, earlierScanReason(storyId)) ?? undefined : undefined);
        if (needsReason && !reason) stopForReason(report.managedReviewReadiness);
        if ((needsReason && usedReason) || (!needsReason && routed)) {
          throw new Error(
            `review_round_prepare failed at step candidate_spec_route: managed review is still blocked after routing `
            + `(${report.managedReviewReadiness.reason}); next: ${report.managedReviewReadiness.nextAction}\nLanes already started: none`,
          );
        }
        await route(needsReason ? reason : undefined);
        routed = true;
        usedReason ||= needsReason;
        report = await plan();
      }
    }

    // Old-PoS run 34 (§4 sink 1d): historically slowest lanes first (the 8 s stagger then
    // delays the fastest lanes, not the round's long pole); next launches them in this order.
    // Lab run131: `lanes` restricts the preparation to the named lanes (never a running sibling).
    const wanted = args.lanes?.length ? new Set(args.lanes) : null;
    const lanes = orderLanesForLaunch([...new Set([...report.executionPlan.launchableLanes, ...waveLanes])]).filter(lane => !wanted || wanted.has(lane));
    if (wanted && !lanes.length) {
      throw new Error(`review_round_prepare: none of the named lanes (${[...wanted].join(', ')}) is launchable now (reviewer_batch launchableLanes: ${report.executionPlan.launchableLanes.join(', ') || 'none'})\nNext: proof-or-stop next --storyId=${storyId}`);
    }
    for (const lane of lanes) {
      await step(`dispatch(${lane})`, () => handler('dispatch')({ storyId, agentType: lane, summary: true }));
      const output = String(await step(`review_run_start(${lane})`,
        () => handler('review_run_start')({ storyId, agent: lane, lane, summary: true })));
      const reviewRunId = output.match(/^Review run (\S+) started for /m)?.[1];
      const persisted = reviewRunId
        ? ctx.store.readReviewRuns(storyId).runs.find(run => run.reviewRunId === reviewRunId)
        : undefined;
      if (!reviewRunId || !persisted || persisted.lane !== lane) {
        await step(`review_run_start(${lane})`, () => {
          throw new Error(`no persisted ReviewRun bound to lane ${lane} was reported`);
        });
      }
      started[lane] = reviewRunId!;
    }

    const runs = ctx.store.readReviewRuns(storyId).runs;
    const firstRun = runs.find(run => run.reviewRunId === Object.values(started)[0]);
    const worktree = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
    const result: ReviewRoundPrepareReport = {
      storyId,
      round: ctx.store.readStory(storyId).currentReviewRound ?? report.reviewRound ?? null,
      head: firstRun?.headHash ?? null,
      worktree,
      routed,
      launchableLanes: lanes,
      reviewRuns: started,
      controllerCommand: renderReviewRoundControllerCommand(storyId, worktree, started),
    };
    return args.json ? result : renderReviewRoundPrepareReport(result);
  }

  /**
   * Old-PoS run 25 (F4, item 206): after review_inventory_wave_advance the OPEN
   * epoch's next wave needs a fresh terminal of every required lane, but the
   * reviewer plan still counted the earlier wave's passes as current, so this
   * command prepared nothing and the owner launched the wave by hand. The
   * required lanes the live wave misses (no run of the lane since the wave
   * began) are prepared too, only while the epoch's cutoff is the live material.
   */
  function openEpochWaveLanes(storyId: string): string[] {
    const epoch = currentOpenReviewInventory(ctx.store, storyId);
    const round = ctx.store.readStory(storyId).currentReviewRound;
    if (!epoch || epoch.reviewRound !== round || epoch.waves.length === 0) return [];
    const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
    if (!gitCwd || currentMaterialHash(gitCwd, 'HEAD', ctx.root) !== epoch.cutoff.materialHash) return [];
    const runs = ctx.store.readReviewRuns(storyId).runs;
    const evaluation = evaluateReviewInventoryWave({ promptStore: ctx.store, epoch, runs,
      passes: ctx.store.readReviewPasses(storyId).passes, findings: ctx.store.readFindings(storyId).findings });
    const waveStart = epoch.waves.at(-1)?.completedAt ?? epoch.begunAt;
    return evaluation.missingLanes.filter(lane => !runs.some(run => run.reviewRound === round && run.lane === lane && run.startedAt > waveStart));
  }

  async function prepareCritic(storyId: string, json: boolean,
    step: <T>(name: string, fn: () => T | Promise<T>) => Promise<T>): Promise<ReviewRoundPrepareReport | string> {
    const story = ctx.store.readStory(storyId);
    const round = story.currentReviewRound ?? null;
    if (!round) throw new Error('review_round_prepare --inventoryCritic: REVIEW has no current round');
    let epoch = currentOpenReviewInventory(ctx.store, storyId);
    if (epoch && epoch.reviewRound !== round) {
      throw new Error(`review_round_prepare --inventoryCritic: OPEN epoch ${epoch.epochId} belongs to round ${epoch.reviewRound}, not ${round}; cancel it first (review_inventory_cancel)`);
    }
    let begun = false;
    if (!epoch) {
      await step('review_inventory_begin', () => handler('review_inventory_begin')({ storyId }));
      begun = true;
      epoch = currentOpenReviewInventory(ctx.store, storyId);
    }
    const status = epoch ? String(await step('review_inventory_status', () => handler('review_inventory_status')({ storyId }))) : '';
    let criticDispatched = false;
    let criticReviewRunId: string | null = null;
    if (epoch && /REVIEW_INVENTORY_CRITIC_INCOMPLETE/.test(status)) {
      const critic = MANAGED_INVENTORY_CRITIC_LANE;
      const binding = reviewInventoryPurposeBinding(epoch);
      const dispatched = verifyCurrentReviewerDispatchBinding({ store: ctx.store, storyId, lane: critic, reviewRound: round,
        projectRoot: ctx.root, reviewPurpose: 'inventory-completeness', inventoryBinding: binding });
      if (!dispatched.ok) {
        await step(`dispatch(${critic})`, () => handler('dispatch')({ storyId, agentType: critic,
          reviewPurpose: 'inventory-completeness', inventoryEpochId: epoch!.epochId, summary: true }));
        criticDispatched = true;
      }
      const output = String(await step(`review_run_start(${critic})`, () => handler('review_run_start')({ storyId, agent: critic, lane: critic,
        reviewPurpose: 'inventory-completeness', inventoryEpochId: epoch!.epochId, summary: true })));
      criticReviewRunId = output.match(/^Review run (\S+) started for /m)?.[1] ?? null;
    }
    const worktree = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
    const result: ReviewRoundPrepareReport = {
      storyId, round, head: null, worktree, routed: false, launchableLanes: [],
      reviewRuns: criticReviewRunId ? { [MANAGED_INVENTORY_CRITIC_LANE]: criticReviewRunId } : {},
      controllerCommand: null,
      inventory: { epochId: epoch?.epochId ?? null, begun, criticDispatched, criticReviewRunId, status: status.split('\n').find(row => row.startsWith('Blockers:')) ?? '' },
    };
    if (json) return result;
    return [
      `Inventory critic prepared (${storyId})`,
      `round: ${round}`,
      `epoch: ${result.inventory!.epochId ?? '(none)'}${begun ? ' (begun now)' : ''}`,
      `critic: ${criticReviewRunId ?? 'not due'}${criticDispatched ? ' (dispatched now)' : ''}`,
    ].join('\n');
  }

  return { review_round_prepare: reviewRoundPrepare };
}
