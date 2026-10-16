/**
 * EXPERIMENTAL A/B variant V1 — `review.criticOnCleanRound: "skip"`.
 *
 * When every required lane of an inventory epoch's FIRST wave passed with zero
 * findings (no verified, suspected or disproven finding terminal, no baseline
 * findings, no missing/duplicate lanes), the epoch may be finalized without the
 * completeness critic. The finalized wave then carries a `criticSkip` record
 * (reason + the A/B evidence + the clean lane-terminal digest) that the epoch
 * `_hash` covers. Finalize, the status projection and the consume-time replay
 * (finalizedLiveAggregateError) accept the missing critic receipt ONLY while
 * the switch is still set in the project config and the live wave is still
 * clean; with the switch absent every path requires the critic as before.
 *
 * EXPERIMENTAL A/B review.deltaRounds=on (core/review-delta-round.ts) reuses
 * the same record for a DELTA round: an epoch whose roster basis is a delta
 * round's (signed into the epoch) and whose first wave is clean (no lane
 * reported any finding, so the round raised no new finding) finalizes without
 * the critic, with its own reason and the arm's evidence; a delta round with
 * any finding runs the critic. Replay accepts it only while the switch is on
 * (or `confirm`, lab lean) and the epoch is still a delta-round epoch.
 */
import { createHash } from 'node:crypto';
import { abVariantEvidence, resolveAbVariants, type AbVariantEvidence } from './ab-variants.js';
import { loadConfig } from './config.js';
import type { ReviewInventoryCriticSkip, ReviewInventoryEpoch, ReviewInventoryLaneTerminal } from './types.js';
import { DELTA_ROUND_CRITIC_SKIP_REASON, deltaRoundsVariant, isDeltaRoundRosterBasis } from './review-delta-round.js';

export const REVIEW_INVENTORY_CRITIC_SKIP_REASON =
  'A/B review.criticOnCleanRound=skip: every required lane of this round returned zero findings; completeness critic not run';

interface CleanWaveEvaluation {
  lanes: ReviewInventoryLaneTerminal[];
  missingLanes: string[];
  duplicateIdentities: string[];
  newFamilies: string[];
  rawFindingIds: string[];
  unresolvedFindingIds: string[];
  invalidDispositionIds: string[];
  baselineMismatchIds: string[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function cleanLaneTerminalDigest(lanes: readonly ReviewInventoryLaneTerminal[]): string {
  const rows = lanes.map(lane => ({ lane: lane.lane, reviewRunId: lane.reviewRunId, terminal: lane.terminal, evidenceIds: [...lane.evidenceIds].sort(), coverageDigest: lane.coverageDigest }))
    .sort((a, b) => a.lane.localeCompare(b.lane));
  return createHash('sha256').update(canonical(rows)).digest('hex');
}

/** The switch as the gate reads it now; a malformed value fails closed (no skip). */
export function criticOnCleanRoundSkipEvidence(projectRoot: string): AbVariantEvidence | undefined {
  try {
    const variants = resolveAbVariants(loadConfig(projectRoot));
    return variants.criticOnCleanRound === 'skip' ? abVariantEvidence(variants) : undefined;
  } catch {
    return undefined;
  }
}

/** Is this (first) wave clean: every required lane terminal `pass`, nothing to disposition? */
export function isCleanFirstWave(epoch: Pick<ReviewInventoryEpoch, 'requiredLanes' | 'baselineFindingIds'>, waveIndex: number, evaluation: CleanWaveEvaluation): boolean {
  if (waveIndex !== 0) return false;
  if ((epoch.baselineFindingIds?.length ?? 0) > 0) return false;
  if (evaluation.missingLanes.length || evaluation.duplicateIdentities.length || evaluation.newFamilies.length
    || evaluation.rawFindingIds.length || evaluation.unresolvedFindingIds.length || evaluation.invalidDispositionIds.length
    || evaluation.baselineMismatchIds.length) return false;
  if (evaluation.lanes.length === 0 || evaluation.lanes.some(lane => lane.terminal !== 'pass')) return false;
  const lanes = new Set(evaluation.lanes.map(lane => lane.lane));
  return epoch.requiredLanes.every(lane => lanes.has(lane));
}

/** Finalize-time: the skip record to seal into the wave, or undefined (critic required). */
export function cleanRoundCriticSkip(projectRoot: string, epoch: ReviewInventoryEpoch, evaluation: CleanWaveEvaluation): ReviewInventoryCriticSkip | undefined {
  const abVariant = criticOnCleanRoundSkipEvidence(projectRoot);
  if (abVariant) {
    if (!isCleanFirstWave(epoch, epoch.waves.length, evaluation)) return undefined;
    return { reason: REVIEW_INVENTORY_CRITIC_SKIP_REASON, abVariant, laneTerminalDigest: cleanLaneTerminalDigest(evaluation.lanes) };
  }
  // EXPERIMENTAL review.deltaRounds=on: a clean delta-round wave (no new finding) needs no critic.
  const delta = isDeltaRoundRosterBasis(epoch.rosterBasis) ? deltaRoundsVariant(projectRoot) : undefined;
  if (!delta || !isCleanFirstWave(epoch, epoch.waves.length, evaluation)) return undefined;
  return { reason: DELTA_ROUND_CRITIC_SKIP_REASON, abVariant: delta, laneTerminalDigest: cleanLaneTerminalDigest(evaluation.lanes) };
}

/**
 * Consume-time replay: undefined when the sealed skip is still acceptable,
 * otherwise the reason it is not (the caller then requires the critic receipt).
 */
export function criticSkipReplayError(projectRoot: string, epoch: ReviewInventoryEpoch, skip: ReviewInventoryCriticSkip, evaluation: CleanWaveEvaluation): string | undefined {
  if (skip.reason === DELTA_ROUND_CRITIC_SKIP_REASON) {
    // EXPERIMENTAL review.deltaRounds=on: honoured only while the switch is on and the epoch is a delta round's.
    if (!deltaRoundsVariant(projectRoot)) return 'critic was skipped under review.deltaRounds=on, which is no longer set';
    // Lab lean: the confirm arm (review.deltaRounds=confirm, also implied by pipeline.lean=on) records 'confirm'.
    if (!['on', 'confirm'].includes(String(skip.abVariant?.flags?.['review.deltaRounds']))) return 'critic skip record is malformed';
    if (!isDeltaRoundRosterBasis(epoch.rosterBasis)) return 'critic was skipped for a delta round but the epoch is not a delta-round epoch';
  } else {
    if (!criticOnCleanRoundSkipEvidence(projectRoot)) return 'critic was skipped under review.criticOnCleanRound=skip, which is no longer set';
    if (skip.reason !== REVIEW_INVENTORY_CRITIC_SKIP_REASON || skip.abVariant?.flags?.['review.criticOnCleanRound'] !== 'skip') return 'critic skip record is malformed';
  }
  // The replay epoch has the final wave removed, so the skipped wave is wave index 0 again.
  if (!isCleanFirstWave(epoch, epoch.waves.length, evaluation)) return 'critic was skipped but the live wave is no longer clean';
  if (skip.laneTerminalDigest !== cleanLaneTerminalDigest(evaluation.lanes)) return 'critic skip lane-terminal digest differs from the live wave';
  return undefined;
}
