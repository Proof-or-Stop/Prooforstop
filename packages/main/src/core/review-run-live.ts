/**
 * Old-PoS run 44 (R2, run44-analysis.md §2.3): the owner started six ReviewRuns
 * for one critic target (RR-014..RR-019, grep variants of one command); five were
 * never launched and stayed orphaned. A ReviewRun is a lane's (or critic's)
 * reservation for one target: round, lane, purpose, inventory epoch and wave,
 * and the material it reviews. While the latest run of that target has no
 * evidence yet and its managed run was not launched or is still running, a
 * second start for the same target is refused and the one Next is `next --run`,
 * which launches or waits on the live run.
 *
 * Never refused: a run whose managed run ended (failed or completed without
 * evidence: a replacement is legitimate), a run that has evidence, a run on other
 * material, a critic run superseded by a later lane run of the round (its import
 * would be refused), and a dispatched reviewer's own start of a run nobody
 * launched (non-managed reviewers start their run themselves).
 */
import { existsSync, readdirSync } from 'node:fs';
import type { StoryStore } from './store.js';
import type { ReviewRun } from './types.js';
import { agentRoleIdsEqual } from './agent-role-identity.js';
import { managedHostRunsRoot, readManagedHostRunProjection } from './managed-host-run.js';

export const REVIEW_RUN_LIVE = 'review_run_live';

export interface LiveReviewRun {
  run: ReviewRun;
  /** The managed host run bound to it, or null when it was never launched. */
  hostRun: { runId: string; state: string } | null;
}

function hostRunOf(root: string, storyId: string, reviewRunId: string): { runId: string; state: string; terminal: boolean } | null {
  const dir = managedHostRunsRoot(root);
  if (!existsSync(dir)) return null;
  let found: { runId: string; state: string; terminal: boolean; createdAt: string } | null = null;
  for (const runId of readdirSync(dir)) {
    try {
      const run = readManagedHostRunProjection(root, runId);
      if (run.storyId !== storyId || run.reviewRunId !== reviewRunId) continue;
      if (!found || run.createdAt > found.createdAt) found = { runId, state: run.state, terminal: run.terminal !== null, createdAt: run.createdAt };
    } catch { /* not a readable managed run */ }
  }
  return found;
}

/** The live ReviewRun of a start target, or null (see the module comment). */
export function liveReviewRunForTarget(args: {
  store: StoryStore;
  root: string;
  storyId: string;
  round: string;
  lane: string;
  reviewPurpose?: string;
  inventoryEpochId?: string;
  /** The OPEN epoch's current wave (a critic run of an earlier wave is not this target). */
  inventoryWave?: number;
  materialHash: string;
  /** A dispatched reviewer starting its own (non-managed) run. */
  dispatchedReviewer: boolean;
}): LiveReviewRun | null {
  const critic = args.reviewPurpose === 'inventory-completeness';
  const roundRuns = args.store.readReviewRuns(args.storyId).runs.filter(run => run.reviewRound === args.round);
  const candidate = roundRuns.filter(run => agentRoleIdsEqual(run.lane, args.lane)
    && (run.reviewPurpose === 'inventory-completeness') === critic).at(-1);
  if (!candidate || candidate.materialHash !== args.materialHash) return null;
  if (critic && (candidate.inventoryBinding?.epochId !== args.inventoryEpochId || candidate.inventoryBinding?.wave !== args.inventoryWave)) return null;
  if (critic) {
    const index = roundRuns.indexOf(candidate);
    if (roundRuns.slice(index + 1).some(run => run.reviewPurpose !== 'inventory-completeness')) return null;
  }
  const id = candidate.reviewRunId;
  if ((args.store.readFindings(args.storyId).findings ?? []).some(row => row.reviewRunId === id)) return null;
  if ((args.store.readReviewPasses(args.storyId).passes ?? []).some(row => row.reviewRunId === id)) return null;
  if (args.store.readReviewInventoryEpochs(args.storyId).criticReceipts.some(row => row.reviewRunId === id)) return null;
  const hostRun = hostRunOf(args.root, args.storyId, id);
  if (hostRun?.terminal) return null;
  if (!hostRun && args.dispatchedReviewer) return null;
  return { run: candidate, hostRun: hostRun ? { runId: hostRun.runId, state: hostRun.state } : null };
}

/** The refusal of a second start for a live target: one line of why, ONE Next. */
export function liveReviewRunRefusal(storyId: string, live: LiveReviewRun): string {
  const target = `${live.run.lane}${live.run.reviewPurpose === 'inventory-completeness' ? ` (inventory critic, epoch ${live.run.inventoryBinding?.epochId ?? '?'} wave ${live.run.inventoryBinding?.wave ?? '?'})` : ''}`;
  const state = live.hostRun ? `its managed run ${live.hostRun.runId} is ${live.hostRun.state}` : 'it was prepared but not launched yet';
  return `review_run_start refused: ReviewRun ${live.run.reviewRunId} of ${target} in round ${live.run.reviewRound} is still live for this target `
    + `(no evidence yet; ${state}); a second ReviewRun would orphan one of them [${REVIEW_RUN_LIVE}]\n`
    + `Next: proof-or-stop next --storyId=${storyId} --run`;
}
