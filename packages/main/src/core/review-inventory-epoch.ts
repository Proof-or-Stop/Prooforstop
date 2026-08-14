import { createHash } from 'node:crypto';
import type { StoryStore } from './store.js';
import type {
  Finding,
  ReviewInventoryEpoch,
  ReviewInventoryCriticReceipt,
  ReviewInventoryFindingDisposition,
  ReviewInventoryLaneTerminal,
  ReviewInventoryReceipt,
  ReviewInventoryWave,
  ReviewPass,
  ReviewRun,
} from './types.js';
import { verifyReviewRun } from './review-run.js';
import { verifyFinding, verifyReviewPass } from './finding-verify.js';

const EPOCH_DOMAIN = 'proofbound.review-inventory-epoch.v1';
const RECEIPT_DOMAIN = 'proofbound.review-inventory-receipt.v1';
const CRITIC_RECEIPT_DOMAIN = 'proofbound.review-inventory-critic-receipt.v1';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

export function reviewInventoryDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function signReviewInventoryEpoch(epoch: Omit<ReviewInventoryEpoch, '_hash'>): string {
  return reviewInventoryDigest({ domain: EPOCH_DOMAIN, ...epoch });
}

export function verifyReviewInventoryEpoch(epoch: ReviewInventoryEpoch): boolean {
  if (!epoch._hash || epoch.schemaVersion !== 'proofbound.review_inventory_epoch.v1') return false;
  const { _hash, ...unsigned } = epoch;
  return _hash === signReviewInventoryEpoch(unsigned);
}

export function signReviewInventoryReceipt(receipt: Omit<ReviewInventoryReceipt, '_hash'>): string {
  return reviewInventoryDigest({ domain: RECEIPT_DOMAIN, ...receipt });
}

export function verifyReviewInventoryReceipt(receipt: ReviewInventoryReceipt): boolean {
  if (!receipt._hash || receipt.schemaVersion !== 'proofbound.review_inventory_receipt.v1') return false;
  const { _hash, ...unsigned } = receipt;
  return _hash === signReviewInventoryReceipt(unsigned)
    && receipt.authority === 'inventory-completeness-only'
    && receipt.authorizesTest === false
    && receipt.saturationResult === 'ZERO_NEW_VERIFIED_FINDINGS';
}

export function signReviewInventoryCriticReceipt(receipt: Omit<ReviewInventoryCriticReceipt, '_hash'>): string {
  return reviewInventoryDigest({ domain: CRITIC_RECEIPT_DOMAIN, ...receipt });
}

export function verifyReviewInventoryCriticReceipt(receipt: ReviewInventoryCriticReceipt): boolean {
  if (!receipt._hash || receipt.schemaVersion !== 'proofbound.review_inventory_critic_receipt.v1') return false;
  const { _hash, ...unsigned } = receipt;
  return _hash === signReviewInventoryCriticReceipt(unsigned)
    && receipt.criticLane === 'lattice-review-topology-critic'
    && receipt.terminalEvidenceIds.length > 0
    && Array.isArray(receipt.findingDispositions)
    && Boolean(receipt.readEvidenceDigest);
}

export function reviewInventoryAggregateFamilies(epoch: ReviewInventoryEpoch, evaluation: ReviewInventoryEvaluation): string[] {
  return [...new Set([
    ...epoch.waves.flatMap(wave => wave.verifiedFindingFamilies),
    ...evaluation.families,
  ])].sort();
}

export function reviewInventoryLaneCoverageDigest(evaluation: ReviewInventoryEvaluation): string {
  return reviewInventoryDigest(evaluation.lanes
    .map(lane => ({ lane: lane.lane, reviewRunId: lane.reviewRunId, coverageDigest: lane.coverageDigest }))
    .sort((a, b) => a.lane.localeCompare(b.lane)));
}

export function validateReviewInventoryCriticReceipt(args: {
  receipt: ReviewInventoryCriticReceipt | undefined;
  epoch: ReviewInventoryEpoch;
  evaluation: ReviewInventoryEvaluation;
  runs: ReviewRun[];
  passes: ReviewPass[];
  findings: Finding[];
}): { ok: boolean; reason?: string } {
  const { receipt, epoch } = args;
  if (!receipt) return { ok: false, reason: 'critic receipt missing' };
  if (!verifyReviewInventoryCriticReceipt(receipt)) return { ok: false, reason: 'critic receipt signature invalid' };
  const dispositionEvaluation = evaluateReviewInventoryWave({
    epoch,
    runs: args.runs,
    passes: args.passes,
    findings: args.findings,
    findingDispositions: receipt.findingDispositions,
  });
  if (dispositionEvaluation.unresolvedFindingIds.length > 0) {
    return { ok: false, reason: `critic finding dispositions missing: ${dispositionEvaluation.unresolvedFindingIds.join(', ')}` };
  }
  if (dispositionEvaluation.invalidDispositionIds.length > 0) {
    return { ok: false, reason: `critic finding dispositions invalid: ${dispositionEvaluation.invalidDispositionIds.join(', ')}` };
  }
  if (receipt.storyId !== epoch.storyId || receipt.epochId !== epoch.epochId
    || receipt.reviewRound !== epoch.reviewRound || receipt.wave !== epoch.waves.length + 1) {
    return { ok: false, reason: 'critic receipt epoch/round/wave binding mismatch' };
  }
  if (canonical(receipt.cutoff) !== canonical(epoch.cutoff)) return { ok: false, reason: 'critic receipt cutoff mismatch' };
  const aggregateDigest = reviewInventoryDigest(reviewInventoryAggregateFamilies(epoch, dispositionEvaluation));
  if (receipt.aggregateFindingSetDigest !== aggregateDigest) return { ok: false, reason: 'critic aggregate finding-set digest mismatch' };
  if (receipt.requiredLaneCoverageDigest !== reviewInventoryLaneCoverageDigest(dispositionEvaluation)) {
    return { ok: false, reason: 'critic required-lane coverage digest mismatch' };
  }
  const run = args.runs.find(row => row.reviewRunId === receipt.reviewRunId);
  if (!run || !verifyReviewRun(run) || run.lane !== receipt.criticLane
    || run.reviewRound !== epoch.reviewRound || run.materialHash !== epoch.cutoff.materialHash
    || (run.storyFilesHash ?? '') !== (epoch.cutoff.storyFilesHash ?? '')) {
    return { ok: false, reason: 'critic ReviewRun missing, stale, or invalid' };
  }
  const latestCriticRun = args.runs
    .filter(row => verifyReviewRun(row) && row.lane === receipt.criticLane
      && row.reviewRound === epoch.reviewRound && row.materialHash === epoch.cutoff.materialHash
      && (row.storyFilesHash ?? '') === (epoch.cutoff.storyFilesHash ?? ''))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (latestCriticRun?.reviewRunId !== run.reviewRunId) return { ok: false, reason: 'critic ReviewRun was superseded' };
  const passes = args.passes.filter(row => row.reviewRunId === run.reviewRunId && verifyReviewPass(epoch.storyId, row));
  const findings = args.findings.filter(row => row.reviewRunId === run.reviewRunId && verifyFinding(epoch.storyId, row));
  const terminal = [...passes, ...findings];
  const ids = terminal.map(row => row.id).sort();
  if (canonical(ids) !== canonical([...receipt.terminalEvidenceIds].sort())) return { ok: false, reason: 'critic terminal evidence mismatch' };
  const readEvidence = terminal.map(row => ({ id: row.id, readManifest: row.readManifest ?? null, readLog: row.readLog?.digest ?? null }));
  if (readEvidence.some(row => row.readManifest === null || row.readLog === null)) {
    return { ok: false, reason: 'critic terminal evidence missing read manifest or mechanical read log' };
  }
  if (receipt.readEvidenceDigest !== reviewInventoryDigest(readEvidence)) return { ok: false, reason: 'critic read evidence digest mismatch' };
  const latestTerminalAt = Math.max(...terminal.map(row => Date.parse(row.createdAt ?? '')).filter(Number.isFinite));
  if (!Number.isFinite(latestTerminalAt) || Date.parse(receipt.createdAt) < latestTerminalAt) {
    return { ok: false, reason: 'critic receipt predates terminal evidence' };
  }
  const latestLaneEvidenceAt = Math.max(...dispositionEvaluation.lanes.flatMap(lane => lane.evidenceIds.map(id => {
    const evidence = [...args.passes, ...args.findings].find(row => row.id === id);
    return Date.parse(evidence?.createdAt ?? '');
  })).filter(Number.isFinite));
  if (!Number.isFinite(latestLaneEvidenceAt) || Date.parse(run.startedAt) <= latestLaneEvidenceAt) {
    return { ok: false, reason: 'critic ReviewRun started before required lanes reached terminal state' };
  }
  return { ok: true };
}

export function findingFamily(finding: Finding): string {
  // signatureTag is deliberately audit-only and therefore excluded. The family
  // is derived only from fields in signFinding's canonical domain. category,
  // files, evidenceState and dispositions are intentionally excluded because
  // their current Finding signature does not authenticate them.
  return reviewInventoryDigest({
    desc: finding.desc.trim().replace(/\s+/g, ' ').toLowerCase(),
    severity: finding.severity,
  });
}

function evidenceForRun(run: ReviewRun, passes: ReviewPass[], findings: Finding[]): {
  terminal: ReviewInventoryLaneTerminal | null;
  findings: Finding[];
} {
  if (!verifyReviewRun(run)) return { terminal: null, findings: [] };
  const runPasses = passes.filter(pass => pass.reviewRunId === run.reviewRunId && verifyReviewPass(run.storyId, pass));
  const runFindings = findings.filter(finding => finding.reviewRunId === run.reviewRunId
    && verifyFinding(run.storyId, finding) && Boolean(finding.readManifest) && Boolean(finding.readLog));
  if (runPasses.length === 0 && runFindings.length === 0) return { terminal: null, findings: [] };
  const evidenceIds = [...runPasses.map(row => row.id), ...runFindings.map(row => row.id)].sort();
  const coverageDigest = reviewInventoryDigest({
    runId: run.reviewRunId,
    envelopeId: run.envelopeId ?? null,
    manifests: [...runPasses, ...runFindings].map(row => row.readManifest ?? null),
    readLogs: [...runPasses, ...runFindings].map(row => row.readLog?.digest ?? null),
    evidenceIds,
  });
  return {
    terminal: {
      lane: run.lane,
      reviewRunId: run.reviewRunId,
      terminal: runFindings.length > 0 ? 'finding' : 'pass',
      hostIdentity: run.workspaceBinding?.bindingHash ?? run.agent,
      promptIdentity: run.envelopeId ?? run.promptHash,
      evidenceIds,
      coverageDigest,
    },
    // A suspected/disproven terminal still closes its reviewer lane, but it
    // cannot enter the critic's verified-family disposition set. Legacy rows
    // without evidenceState retain the repository's verified compatibility.
    findings: runFindings.filter(finding => finding.evidenceState === 'verified' || finding.evidenceState === undefined),
  };
}

export interface ReviewInventoryEvaluation {
  lanes: ReviewInventoryLaneTerminal[];
  missingLanes: string[];
  duplicateIdentities: string[];
  families: string[];
  newFamilies: string[];
  rawFindingIds: string[];
  unresolvedFindingIds: string[];
  invalidDispositionIds: string[];
  criticDigest: string;
}

export function evaluateReviewInventoryWave(args: {
  epoch: ReviewInventoryEpoch;
  runs: ReviewRun[];
  passes: ReviewPass[];
  findings: Finding[];
  findingDispositions?: ReviewInventoryFindingDisposition[];
}): ReviewInventoryEvaluation {
  const waveStart = args.epoch.waves.at(-1)?.completedAt ?? args.epoch.begunAt;
  const candidates = args.runs.filter(run =>
    run.storyId === args.epoch.storyId
    && run.reviewRound === args.epoch.reviewRound
    && run.materialHash === args.epoch.cutoff.materialHash
    && (run.storyFilesHash ?? '') === (args.epoch.cutoff.storyFilesHash ?? '')
    && run.startedAt >= waveStart,
  );
  const lanes: ReviewInventoryLaneTerminal[] = [];
  const rawFindings = new Map<string, Finding>();
  for (const lane of args.epoch.requiredLanes) {
    const laneRuns = candidates.filter(run => run.lane === lane).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const selected = laneRuns.map(run => evidenceForRun(run, args.passes, args.findings)).find(row => row.terminal);
    if (!selected?.terminal) continue;
    lanes.push(selected.terminal);
    selected.findings.forEach(finding => rawFindings.set(finding.id, finding));
  }
  const identities = new Map<string, string[]>();
  for (const lane of lanes) {
    const key = `${lane.hostIdentity}:${lane.promptIdentity}`;
    identities.set(key, [...(identities.get(key) ?? []), lane.lane]);
  }
  const duplicateIdentities = [...identities.values()].filter(group => group.length > 1).flat();
  const dispositions = args.findingDispositions ?? [];
  const byFinding = new Map(dispositions.map(row => [row.findingId, row]));
  const dispositionCounts = new Map<string, number>();
  dispositions.forEach(row => dispositionCounts.set(row.findingId, (dispositionCounts.get(row.findingId) ?? 0) + 1));
  const rawFindingIds = [...rawFindings.keys()].sort();
  const unresolvedFindingIds = rawFindingIds.filter(id => !byFinding.has(id));
  const invalidDispositionIds = dispositions.filter(row => {
    if (dispositionCounts.get(row.findingId) !== 1 || !rawFindings.has(row.findingId) || !row.reason.trim()) return true;
    if (!['verified_family', 'duplicate', 'not_verified'].includes(row.disposition)) return true;
    if (row.disposition === 'verified_family') return !row.familyKey?.trim();
    if (row.disposition === 'duplicate') {
      const canonicalDisposition = row.canonicalFindingId ? byFinding.get(row.canonicalFindingId) : undefined;
      return !row.familyKey?.trim() || !canonicalDisposition
        || canonicalDisposition.disposition !== 'verified_family'
        || canonicalDisposition.familyKey !== row.familyKey;
    }
    return row.familyKey !== undefined || row.canonicalFindingId !== undefined;
  }).map(row => row.findingId).filter((id, index, rows) => rows.indexOf(id) === index).sort();
  const familyList = [...new Set(dispositions
    .filter(row => row.disposition === 'verified_family' && rawFindings.has(row.findingId) && !invalidDispositionIds.includes(row.findingId))
    .map(row => row.familyKey!))].sort();
  const priorFamilies = new Set(args.epoch.waves.flatMap(wave => wave.verifiedFindingFamilies));
  const newFamilies = familyList.filter(family => !priorFamilies.has(family));
  return {
    lanes,
    missingLanes: args.epoch.requiredLanes.filter(lane => !lanes.some(row => row.lane === lane)),
    duplicateIdentities,
    families: familyList,
    newFamilies,
    rawFindingIds,
    unresolvedFindingIds,
    invalidDispositionIds,
    criticDigest: reviewInventoryDigest({
      epochId: args.epoch.epochId,
      wave: args.epoch.waves.length + 1,
      requiredLanes: args.epoch.requiredLanes,
      lanes,
      aggregateFamilies: [...new Set([...priorFamilies, ...familyList])].sort(),
    }),
  };
}

export function currentOpenReviewInventory(store: StoryStore, storyId: string): ReviewInventoryEpoch | null {
  const epochs = store.readReviewInventoryEpochs(storyId).epochs;
  const open = epochs.filter(epoch => epoch.state === 'OPEN').at(-1);
  if (!open) return null;
  if (!verifyReviewInventoryEpoch(open)) throw new Error(`review inventory epoch ${open.epochId} signature mismatch`);
  return open;
}

/** Authoritative consumer-side freshness barrier. Call under the caller's story metadata lock. */
export function assertReviewInventoryCutoff(store: StoryStore, storyId: string, current: {
  materialHash: string;
  storyFilesHash?: string;
}): void {
  const epoch = currentOpenReviewInventory(store, storyId);
  if (!epoch) return;
  if (current.materialHash === epoch.cutoff.materialHash
    && (current.storyFilesHash ?? '') === (epoch.cutoff.storyFilesHash ?? '')) return;
  const now = new Date().toISOString();
  const { _hash: _oldHash, ...old } = epoch;
  const unsigned: Omit<ReviewInventoryEpoch, '_hash'> = {
    ...old,
    state: 'INVALIDATED',
    updatedAt: now,
    invalidation: {
      detectedAt: now,
      oldMaterialHash: epoch.cutoff.materialHash,
      currentMaterialHash: current.materialHash,
      ...(epoch.cutoff.storyFilesHash ? { oldStoryFilesHash: epoch.cutoff.storyFilesHash } : {}),
      ...(current.storyFilesHash ? { currentStoryFilesHash: current.storyFilesHash } : {}),
      blockerCode: 'OPEN_REVIEW_INVENTORY_MATERIAL_MUTATION',
    },
  };
  const invalidated: ReviewInventoryEpoch = { ...unsigned, _hash: signReviewInventoryEpoch(unsigned) };
  const data = store.readReviewInventoryEpochs(storyId);
  data.criticReceipts ??= [];
  data.epochs = data.epochs.map(row => row.epochId === epoch.epochId ? invalidated : row);
  store.writeReviewInventoryEpochs(storyId, data);
  throw new Error(
    `OPEN_REVIEW_INVENTORY_MATERIAL_MUTATION\nEpoch: ${epoch.epochId}\n` +
    `Changed lineage: ${epoch.cutoff.materialHash} -> ${current.materialHash}\n` +
    `Recovery: lattice review_inventory_begin --storyId=${storyId}`,
  );
}

export function finalizedUnconsumedReviewInventory(store: StoryStore, storyId: string): {
  epoch: ReviewInventoryEpoch;
  receipt: ReviewInventoryReceipt;
} | null {
  const data = store.readReviewInventoryEpochs(storyId);
  const epoch = data.epochs.at(-1);
  if (epoch?.state !== 'FINALIZED' || epoch.consumedAt) return null;
  if (!epoch || !verifyReviewInventoryEpoch(epoch) || !epoch.receiptId) return null;
  const receipt = data.receipts.find(row => row.receiptId === epoch.receiptId);
  if (!receipt || !verifyReviewInventoryReceipt(receipt) || receipt.consumedAt) return null;
  if (receipt.epochId !== epoch.epochId || receipt.storyId !== storyId || receipt.reviewRound !== epoch.reviewRound) return null;
  return { epoch, receipt };
}

export function reviewInventoryRemediationGate(store: StoryStore, storyId: string, reviewRound?: string): {
  required: boolean;
  ok: boolean;
  reason?: string;
  nextCommand?: string;
} {
  const data = store.readReviewInventoryEpochs(storyId);
  if (data.epochs.length === 0) return {
    required: true,
    ok: false,
    reason: 'no frozen review inventory epoch exists for this remediation',
    nextCommand: `lattice review_inventory_begin --storyId=${storyId}`,
  };
  const latest = data.epochs.at(-1);
  if (latest?.state === 'OPEN') return {
    required: true,
    ok: false,
    reason: `latest review inventory ${latest.epochId} is still OPEN`,
    nextCommand: `lattice review_inventory_status --storyId=${storyId}`,
  };
  const pair = finalizedUnconsumedReviewInventory(store, storyId);
  if (!pair) return {
    required: true,
    ok: false,
    reason: 'missing valid unconsumed FINALIZED review inventory receipt',
    nextCommand: `lattice review_inventory_status --storyId=${storyId}`,
  };
  if (reviewRound && pair.epoch.reviewRound !== reviewRound) {
    return {
      required: true,
      ok: false,
      reason: `receipt reviewRound ${pair.epoch.reviewRound} != current ${reviewRound}`,
      nextCommand: `lattice review_inventory_begin --storyId=${storyId}`,
    };
  }
  return { required: true, ok: true };
}

export function consumeReviewInventoryReceipt(
  store: StoryStore,
  storyId: string,
  reviewRound: string,
  currentCutoff: { materialHash: string; storyFilesHash?: string },
): string | null {
  const gate = reviewInventoryRemediationGate(store, storyId, reviewRound);
  if (!gate.ok) throw new Error(`REVIEW_INVENTORY_REMEDIATION_BLOCKED: ${gate.reason}`);
  const pair = finalizedUnconsumedReviewInventory(store, storyId)!;
  if (pair.receipt.cutoff.materialHash !== currentCutoff.materialHash
    || (pair.receipt.cutoff.storyFilesHash ?? '') !== (currentCutoff.storyFilesHash ?? '')) {
    throw new Error('REVIEW_INVENTORY_REMEDIATION_BLOCKED: current material/storyFiles no longer match the finalized cutoff');
  }
  const now = new Date().toISOString();
  const data = store.readReviewInventoryEpochs(storyId);
  data.epochs = data.epochs.map(row => {
    if (row.epochId !== pair.epoch.epochId) return row;
    const { _hash, ...unsigned } = row;
    const consumed: Omit<ReviewInventoryEpoch, '_hash'> = { ...unsigned, consumedAt: now, consumedByReviewRound: reviewRound, updatedAt: now };
    return { ...consumed, _hash: signReviewInventoryEpoch(consumed) };
  });
  data.receipts = data.receipts.map(row => {
    if (row.receiptId !== pair.receipt.receiptId) return row;
    const { _hash, ...unsigned } = row;
    const consumed: Omit<ReviewInventoryReceipt, '_hash'> = { ...unsigned, consumedAt: now };
    return { ...consumed, _hash: signReviewInventoryReceipt(consumed) };
  });
  store.writeReviewInventoryEpochs(storyId, data);
  return pair.receipt.receiptId;
}

export function buildWave(epoch: ReviewInventoryEpoch, evaluation: ReviewInventoryEvaluation, now: string): ReviewInventoryWave {
  const aggregate = [...new Set([...epoch.waves.flatMap(row => row.verifiedFindingFamilies), ...evaluation.families])].sort();
  return {
    wave: epoch.waves.length + 1,
    startedAt: epoch.waves.at(-1)?.completedAt ?? epoch.begunAt,
    completedAt: now,
    lanes: evaluation.lanes,
    verifiedFindingFamilies: aggregate,
    verifiedFindingSetDigest: reviewInventoryDigest(aggregate),
    newVerifiedFindingCount: evaluation.newFamilies.length,
    criticDigest: evaluation.criticDigest,
    saturated: evaluation.newFamilies.length === 0,
  };
}
