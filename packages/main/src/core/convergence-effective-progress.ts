/** Pure comparison of verifier-owned progress snapshots, shared by stall and burn consumers. */
export interface EffectiveProgressSnapshot {
  /** Ordered completed epochs validated by the inventory owner before collection. */
  completedEpochIds: string[];
  openVerifiedFindings: number;
  missingRequired: number;
  blockingSignature: string;
  materialHash: string;
  /** Current admissible lanes, not raw run IDs or provider success counts. */
  currentPassLanes: string[];
  /** Highest successfully reached lifecycle position; reopen loops do not increment it. */
  phaseAdvanceOrdinal: number;
}
export interface EffectiveProgressState {
  schemaVersion: 'proofbound.effective_progress.v1';
  snapshot: EffectiveProgressSnapshot;
  epochBaseline: EffectiveProgressSnapshot;
  /** Historical completed outcomes; live progress may release their block before the next completion. */
  stagnantEpochIds: string[];
  stablePassProgress: { materialHash: string; lane: string }[];
}
export interface EffectiveProgressAssessment {
  decision: 'continue' | 'request-decision';
  progressReasons: string[];
  state: EffectiveProgressState;
}
function validate(snapshot: EffectiveProgressSnapshot): void {
  if (!snapshot || !Array.isArray(snapshot.completedEpochIds) || !Array.isArray(snapshot.currentPassLanes)
    || [...snapshot.completedEpochIds, ...snapshot.currentPassLanes].some(id => typeof id !== 'string' || !id.trim())
    || new Set(snapshot.completedEpochIds).size !== snapshot.completedEpochIds.length
    || new Set(snapshot.currentPassLanes).size !== snapshot.currentPassLanes.length) throw new Error('Invalid progress snapshot: duplicate or malformed epoch/lane identity');
  if ([snapshot.openVerifiedFindings, snapshot.missingRequired, snapshot.phaseAdvanceOrdinal].some(n => !Number.isSafeInteger(n) || n < 0)
    || !snapshot.blockingSignature?.trim() || !snapshot.materialHash?.trim()) throw new Error('Invalid progress snapshot count or source identity');
}
function outcomeReasons(before: EffectiveProgressSnapshot, current: EffectiveProgressSnapshot): string[] {
  const reasons: string[] = [];
  if (current.openVerifiedFindings < before.openVerifiedFindings) reasons.push('verified-findings-decreased');
  if (current.missingRequired < before.missingRequired) reasons.push('missing-required-decreased');
  if (current.blockingSignature !== before.blockingSignature) reasons.push('blocking-signature-changed');
  if (current.phaseAdvanceOrdinal > before.phaseAdvanceOrdinal) reasons.push('legal-phase-advance');
  return reasons;
}
/** No clock, usage, heartbeat, metadata, round or retry counter independently requests a decision. */
export function assessEffectiveProgress(prior: EffectiveProgressState | null, current: EffectiveProgressSnapshot): EffectiveProgressAssessment {
  validate(current);
  const snapshot: EffectiveProgressSnapshot = {
    completedEpochIds: [...current.completedEpochIds], openVerifiedFindings: current.openVerifiedFindings,
    missingRequired: current.missingRequired, blockingSignature: current.blockingSignature, materialHash: current.materialHash,
    currentPassLanes: [...current.currentPassLanes].sort(), phaseAdvanceOrdinal: current.phaseAdvanceOrdinal,
  };
  const state: EffectiveProgressState = { schemaVersion: 'proofbound.effective_progress.v1', snapshot,
    epochBaseline: structuredClone(snapshot), stagnantEpochIds: [], stablePassProgress: [] };
  if (!prior) return { decision: 'continue', progressReasons: [], state };
  validate(prior.snapshot); validate(prior.epochBaseline);
  const before = prior.snapshot, baseline = prior.epochBaseline;
  if (prior.schemaVersion !== state.schemaVersion || !Array.isArray(prior.stagnantEpochIds) || !Array.isArray(prior.stablePassProgress)
    || new Set(prior.stagnantEpochIds).size !== prior.stagnantEpochIds.length
    || prior.stagnantEpochIds.some(id => !before.completedEpochIds.includes(id))
    || before.completedEpochIds.some((id, i) => snapshot.completedEpochIds[i] !== id)
    || baseline.completedEpochIds.join('\0') !== before.completedEpochIds.join('\0')
    || snapshot.phaseAdvanceOrdinal < before.phaseAdvanceOrdinal) throw new Error('Invalid progress epoch or phase history');
  const newEpochs = snapshot.completedEpochIds.slice(before.completedEpochIds.length);
  const witnesses = prior.stablePassProgress.filter(p => p.materialHash === snapshot.materialHash && snapshot.currentPassLanes.includes(p.lane));
  if (snapshot.materialHash === before.materialHash) {
    for (const lane of snapshot.currentPassLanes) {
      if (!before.currentPassLanes.includes(lane) && !(baseline.materialHash === snapshot.materialHash && baseline.currentPassLanes.includes(lane)) && !witnesses.some(p => p.lane === lane)) witnesses.push({ materialHash: snapshot.materialHash, lane });
    }
  }
  // Compare with the completed boundary, not the latest heartbeat observation.
  // A mid-epoch repair survives completion; an improvement later reverted does not.
  const progressReasons = outcomeReasons(baseline, snapshot);
  if (witnesses.length) progressReasons.push('current-pass-on-stable-material');
  if (!baseline.completedEpochIds.length && newEpochs.length) progressReasons.push('first-completed-epoch');
  const progressed = progressReasons.length > 0;
  if (newEpochs.length === 0) {
    state.epochBaseline = structuredClone(baseline);
    state.stagnantEpochIds = [...prior.stagnantEpochIds];
    state.stablePassProgress = witnesses;
  } else if (newEpochs.length === 1 && !progressed) {
    state.stagnantEpochIds = [...prior.stagnantEpochIds, ...newEpochs];
  }
  // Skipping multiple epoch observations leaves intermediate progress unknown.
  // That gap cannot prove two complete stagnant epochs.
  return { decision: !progressed && state.stagnantEpochIds.length >= 2 ? 'request-decision' : 'continue', progressReasons, state };
}
