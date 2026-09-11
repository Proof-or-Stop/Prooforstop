import { createHash } from 'node:crypto';
import { finalReviewRosterForStory, finalReviewRosterBasis } from '../handlers/reviewer-list.js';
import type { StoryStore } from './store.js';
import type {
  ChecklistData,
  VerificationEvidence,
  Finding,
  ReviewInventoryEpoch,
  ReviewInventoryPurposeBinding,
  ReviewInventoryCriticReceipt,
  ReviewInventoryEpochData,
  ReviewInventoryFindingDisposition,
  ReviewInventoryLaneTerminal,
  ReviewInventoryReceipt,
  ReviewInventoryWave,
  ReviewPass,
  ReviewRun,
} from './types.js';
import { verifyReviewRun } from './review-run.js';
import { verifyFinding, verifyReviewPass } from './finding-verify.js';
import { canonicalAgentRoleId } from './agent-role-identity.js';
import { withMkdirLock } from './mkdir-lock.js';
import { collectVerificationIntents } from './verification.js';
import { isSplitVerificationReceipt, validateVerificationReceipt } from './verification-execution-evidence.js';

export const REVIEW_INVENTORY_EPOCHS_FILE = 'review-inventory-epochs.json';
export const REVIEW_INVENTORY_EPOCHS_SCHEMA = 'proof-or-stop.review_inventory_epochs.v1';
export const REVIEW_INVENTORY_EPOCH_SCHEMA = 'proof-or-stop.review_inventory_epoch.v1';
export const REVIEW_INVENTORY_RECEIPT_SCHEMA = 'proof-or-stop.review_inventory_receipt.v1';
export const INVENTORY_COMPLETENESS_AUTHORITY = 'inventory-completeness-only' as const;
export type { ReviewInventoryEpochData } from './types.js';

const EPOCH_DOMAIN = 'proof-or-stop.review-inventory-epoch.v1';
const RECEIPT_DOMAIN = 'proof-or-stop.review-inventory-receipt.v1';
const CRITIC_RECEIPT_DOMAIN = 'proof-or-stop.review-inventory-critic-receipt.v1';

/**
 * One serialization boundary for inventory snapshots and reviewer terminal
 * evidence. Finalize/consume and finding/pass writers must all hold this lock:
 * otherwise a terminal can be appended just after FINALIZED and remain absent
 * from the immutable remediation receipt.
 */
export function withReviewInventoryMutationLock<T>(store: StoryStore, storyId: string, fn: () => T): T {
  return withMkdirLock(store.runtimeLockDirPath(storyId, 'review-inventory', 'epochs'), fn, {
    label: `review inventory ${storyId}`,
    heartbeatMs: 1_000,
  });
}

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

/** Stable subject of one signed epoch wave, independent of critic receipt writes. */
export function reviewInventoryPurposeBinding(epoch: ReviewInventoryEpoch): ReviewInventoryPurposeBinding {
  const boundary = epoch.waves.at(-1)?.nextRunSequenceBoundary ?? epoch.initialRunSequenceBoundary;
  if (!Number.isSafeInteger(boundary) || boundary! < 0) throw new Error('inventory purpose requires signed run-sequence boundary');
  return {
    storyId: epoch.storyId, epochId: epoch.epochId, reviewRound: epoch.reviewRound,
    wave: epoch.waves.length + 1, cutoff: { ...epoch.cutoff }, scopeDigest: epoch.scopeDigest,
    requiredLanesDigest: reviewInventoryDigest(epoch.requiredLanes),
    runSequenceBoundary: boundary!,
  };
}

export function inventoryPurposeMatchesEpoch(binding: ReviewInventoryPurposeBinding | undefined, epoch: ReviewInventoryEpoch): boolean {
  try { return Boolean(binding) && canonical(binding) === canonical(reviewInventoryPurposeBinding(epoch)); }
  catch { return false; }
}

export function emptyReviewInventoryEpochData(): ReviewInventoryEpochData {
  return { schemaVersion: REVIEW_INVENTORY_EPOCHS_SCHEMA, epochs: [], receipts: [], criticReceipts: [] };
}

/** Canonical acceptance/review subject shared by epoch writers and consumers. */
export function reviewInventoryAcceptanceSubjectDigest(
  scopeContract: unknown,
  checklist: ChecklistData,
  proofStoryContract: Record<string, unknown> | null = null,
  scopeShrinkageDecision: Record<string, unknown> | null = null,
  authentication?: { projectRoot: string; storyId: string },
): string {
  // One rule, three shapes: this helper, evidenceSemantics below, and the candidate
  // projection in handlers/review-inventory.ts captureReviewInventoryScope all bind
  // SEMANTIC CONTENT and drop BOOKKEEPING, so an idempotent retry or a pure re-pin
  // cannot manufacture acceptance drift. They stay separate because the shapes differ
  // (flat record / nested per-row array / a different artifact in another module);
  // unifying them would need an over-general abstraction. Each was driven by its own
  // independently-found defect: B-3f3d F-099, F-103/F-104, F-107.
  const withoutVolatileTimestamps = (value: Record<string, unknown> | null): Record<string, unknown> | null => {
    if (!value) return null;
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...semantic } = value;
    return semantic;
  };
  // B-3f3d F-099: bind what a verifier OBSERVED, not when it last ran. A pure
  // `verification_evidence_refresh_stale` re-pin rewrites headHash/materialHash/
  // storyFilesHash/timestamp (and receipt.executedAt) while result/command/note/
  // outputDigest stay identical. Hashing those freshness pins made an evidence
  // re-pin flip this digest and trip OPEN_REVIEW_INVENTORY_SCOPE_MUTATION, even
  // though currentMaterialHash already excludes the whole .proof-or-stop/story/ tree —
  // so a metadata-only refresh invalidated an OPEN epoch and discarded other
  // lanes' completed verdicts. Same principle as withoutVolatileTimestamps above:
  // semantic content in, bookkeeping out. Anything that should still invalidate
  // (a changed result, command, selector or captured output) remains bound.
  const evidenceSemantics = (value: unknown, item: ChecklistData['items'][number]): unknown => {
    if (!Array.isArray(value)) return value;
    const currentIntents = item.verificationIntent ? collectVerificationIntents(item) : [];
    return value.filter(row => {
      if (!item.verificationIntent) return true;
      if (!row || typeof row !== 'object') return true;
      const intentRef = (row as Record<string, unknown>).intentRef;
      return typeof intentRef !== 'string' || currentIntents.some(intent => intent.ref === intentRef);
    }).map(row => {
      if (!row || typeof row !== 'object') return row;
      const {
        headHash: _headHash, materialHash: _materialHash, storyFilesHash: _storyFilesHash,
        timestamp: _timestamp, receipt, ...semantic
      } = row as Record<string, unknown>;
      if (!receipt || typeof receipt !== 'object') return semantic;
      const evidence = row as VerificationEvidence;
      if (authentication && isSplitVerificationReceipt(evidence.receipt)) {
        const pin = currentIntents.find(intent => intent.ref === evidence.intentRef)?.intent.verification;
        if (!pin || evidence.command !== pin.command) throw new Error('inventory authenticated command binding mismatch');
        const validation = validateVerificationReceipt(authentication.projectRoot, evidence.receipt, {
          storyId: authentication.storyId, intentRef: evidence.intentRef,
          command: pin.command, selector: pin.selector,
          freshness: { headHash: evidence.headHash!, materialHash: evidence.materialHash!, storyFilesHash: evidence.storyFilesHash! },
        });
        if (!validation.ok || typeof validation.output !== 'string') {
          throw new Error(`inventory receipt authentication failed: ${validation.errors.join('; ')}`);
        }
        if (evidence.receipt.schemaVersion === 'proof-or-stop.verification-receipt-bundle.v5') {
          const execution = evidence.receipt.executionReceipt;
          const assertion = evidence.receipt.assertionReceipt;
          // Versioned whitelist, AFTER complete graph/artifact authentication.
          // Input identity includes environment, toolchain, command, cwd, timeout,
          // capture and capsule semantics. Publication and execution instance IDs
          // are not observations; the epoch's material/scope cutoffs stay separate.
          return { ...semantic, receipt: {
            schemaVersion: 'proof-or-stop.inventory-verification-observation.v1',
            executionIdentityDigest: execution.executionIdentityDigest,
            outputDigest: execution.outputArtifact.outputDigest,
            exitCode: execution.exitCode,
            timedOut: execution.timedOut,
            intentRef: assertion.intentRef,
            selectorDigest: assertion.selectorDigest,
            matcherVersion: assertion.matcherVersion,
            matched: assertion.matched,
          } };
        }
      } else if (authentication && ('executionReceipt' in receipt || 'publicationBinding' in receipt)) {
        throw new Error('inventory receipt authentication failed: unrecognized split receipt schema');
      }
      const { executedAt: _executedAt, ...receiptSemantic } = receipt as Record<string, unknown>;
      return { ...semantic, receipt: receiptSemantic };
    });
  };
  return reviewInventoryDigest({
    scopeContract,
    checklist: checklist.items.map(row => ({
      id: row.id,
      title: row.title,
      context: row.context,
      status: row.status,
      relatedDocs: row.relatedDocs,
      userSees: row.userSees,
      excludes: row.excludes,
      files: row.files,
      verificationIntent: row.verificationIntent,
      verificationEvidence: evidenceSemantics(row.verificationEvidence, row),
      userSeesSnapshot: row.userSeesSnapshot,
    })),
    // ProofStory is a second acceptance-authority surface beside checklist.
    // Bind its complete semantic contract plus the disposition decision; omit
    // only volatile persistence timestamps so an exact idempotent retry does
    // not manufacture acceptance drift.
    proofStoryContract: withoutVolatileTimestamps(proofStoryContract),
    scopeShrinkageDecision: withoutVolatileTimestamps(scopeShrinkageDecision),
  });
}

export function reviewInventoryAcceptanceSubjectDigestForStore(store: StoryStore, storyId: string): string {
  return reviewInventoryAcceptanceSubjectDigest(
    store.readScopeContract(storyId),
    store.readChecklist(storyId),
    store.readProofStoryContract(storyId) as unknown as Record<string, unknown> | null,
    store.readScopeShrinkageDecision(storyId) as unknown as Record<string, unknown> | null,
    { projectRoot: store.projectRoot, storyId },
  );
}

export function reviewRunSequence(run: Pick<ReviewRun, 'reviewRunId'>): number | null {
  const match = run.reviewRunId.match(/:RR-(\d+)$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function maxReviewRunSequence(runs: ReviewRun[]): number {
  return runs.reduce((max, run) => Math.max(max, reviewRunSequence(run) ?? -1), 0);
}

export function signReviewInventoryEpoch(epoch: Omit<ReviewInventoryEpoch, '_hash'>): string {
  return reviewInventoryDigest({ domain: EPOCH_DOMAIN, ...epoch });
}

export function verifyReviewInventoryEpoch(epoch: ReviewInventoryEpoch): boolean {
  if (!epoch._hash || epoch.schemaVersion !== 'proof-or-stop.review_inventory_epoch.v1') return false;
  const { _hash, ...unsigned } = epoch;
  return _hash === signReviewInventoryEpoch(unsigned);
}

export function signReviewInventoryReceipt(receipt: Omit<ReviewInventoryReceipt, '_hash'>): string {
  return reviewInventoryDigest({ domain: RECEIPT_DOMAIN, ...receipt });
}

export function verifyReviewInventoryReceipt(receipt: ReviewInventoryReceipt): boolean {
  if (!receipt._hash || receipt.schemaVersion !== 'proof-or-stop.review_inventory_receipt.v1') return false;
  const { _hash, ...unsigned } = receipt;
  return _hash === signReviewInventoryReceipt(unsigned)
    && receipt.authorizesTest === false
    && ((receipt.authority === 'inventory-completeness-only' && receipt.saturationResult === 'ZERO_NEW_VERIFIED_FINDINGS')
      || (receipt.authority === 'review-remediation-only' && receipt.saturationResult === 'NOT_EVALUATED_FOR_REMEDIATION'
        && Number.isSafeInteger(receipt.waveCount) && receipt.waveCount >= 1 && Array.isArray(receipt.requiredLanes) && receipt.requiredLanes.length > 0
        && receipt.requiredLanes.every(lane => typeof lane === 'string' && lane.trim().length > 0)));
}

export function signReviewInventoryCriticReceipt(receipt: Omit<ReviewInventoryCriticReceipt, '_hash'>): string {
  return reviewInventoryDigest({ domain: CRITIC_RECEIPT_DOMAIN, ...receipt });
}

export function verifyReviewInventoryCriticReceipt(receipt: ReviewInventoryCriticReceipt): boolean {
  if (!receipt._hash || receipt.schemaVersion !== 'proof-or-stop.review_inventory_critic_receipt.v1') return false;
  const { _hash, ...unsigned } = receipt;
  return _hash === signReviewInventoryCriticReceipt(unsigned)
    && canonicalAgentRoleId(receipt.criticLane) === 'proof-or-stop-review-topology-critic'
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
  promptStore?: Pick<StoryStore, 'storyDirPath'>;
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
  const dispositionEvaluation = evaluateReviewInventoryWave({ promptStore: args.promptStore,
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
  if (receipt.reviewPurpose !== 'inventory-completeness'
    || !inventoryPurposeMatchesEpoch(receipt.inventoryBinding, epoch)
    || run?.reviewPurpose !== 'inventory-completeness'
    || !inventoryPurposeMatchesEpoch(run.inventoryBinding, epoch)) {
    return { ok: false, reason: 'critic inventory purpose/subject binding missing or mismatched' };
  }
  if (!run || !verifyReviewRun(run, args.promptStore) || run.lane !== receipt.criticLane
    || run.reviewRound !== epoch.reviewRound || run.materialHash !== epoch.cutoff.materialHash
    || (run.storyFilesHash ?? '') !== (epoch.cutoff.storyFilesHash ?? '')) {
    return { ok: false, reason: 'critic ReviewRun missing, stale, or invalid' };
  }
  const latestCriticRun = args.runs
    .filter(row => verifyReviewRun(row, args.promptStore) && row.lane === receipt.criticLane
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

function evidenceForRun(run: ReviewRun, passes: ReviewPass[], findings: Finding[], promptStore?: Pick<StoryStore, 'storyDirPath'>): {
  terminal: ReviewInventoryLaneTerminal | null;
  findings: Finding[];
} {
  if (!verifyReviewRun(run, promptStore)) return { terminal: null, findings: [] };
  const runPasses = passes.filter(pass => pass.reviewRunId === run.reviewRunId
    && verifyReviewPass(run.storyId, pass) && Boolean(pass.readManifest) && Boolean(pass.readLog));
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
  baselineMismatchIds: string[];
  criticDigest: string;
}

function isEligibleBaselineFinding(epoch: ReviewInventoryEpoch, finding: Finding, runs: ReviewRun[], promptStore?: Pick<StoryStore, 'storyDirPath'>): boolean {
  if (finding.status !== 'open' || (finding.evidenceState !== 'verified' && finding.evidenceState !== undefined)) return false;
  if (!verifyFinding(epoch.storyId, finding) || !finding.readManifest || !finding.readLog) return false;
  const run = runs.find(row => row.reviewRunId === finding.reviewRunId);
  const sequence = run ? reviewRunSequence(run) : null;
  return Boolean(run && verifyReviewRun(run, promptStore)
    && run.storyId === epoch.storyId
    && run.reviewRound === epoch.reviewRound
    && run.materialHash === epoch.cutoff.materialHash
    && (run.storyFilesHash ?? '') === (epoch.cutoff.storyFilesHash ?? '')
    && (epoch.initialRunSequenceBoundary !== undefined
      ? sequence !== null && sequence <= epoch.initialRunSequenceBoundary
      : run.startedAt <= epoch.begunAt));
}

export function captureReviewInventoryBaselineFindingIds(args: {
  promptStore?: Pick<StoryStore, 'storyDirPath'>;
  epoch: ReviewInventoryEpoch;
  runs: ReviewRun[];
  findings: Finding[];
}): string[] {
  return args.findings
    .filter(finding => isEligibleBaselineFinding(args.epoch, finding, args.runs, args.promptStore))
    .map(finding => finding.id)
    .sort();
}

export function evaluateReviewInventoryWave(args: {
  promptStore?: Pick<StoryStore, 'storyDirPath'>;
  epoch: ReviewInventoryEpoch;
  runs: ReviewRun[];
  passes: ReviewPass[];
  findings: Finding[];
  findingDispositions?: ReviewInventoryFindingDisposition[];
}): ReviewInventoryEvaluation {
  const waveStart = args.epoch.waves.at(-1)?.completedAt ?? args.epoch.begunAt;
  const sequenceBoundary = args.epoch.waves.at(-1)?.nextRunSequenceBoundary
    ?? args.epoch.initialRunSequenceBoundary;
  const candidates = args.runs.filter(run =>
    run.storyId === args.epoch.storyId
    && run.reviewRound === args.epoch.reviewRound
    && run.materialHash === args.epoch.cutoff.materialHash
    && (run.storyFilesHash ?? '') === (args.epoch.cutoff.storyFilesHash ?? '')
    && (sequenceBoundary !== undefined
      ? (reviewRunSequence(run) ?? -1) > sequenceBoundary
      : run.startedAt > waveStart),
  );
  const lanes: ReviewInventoryLaneTerminal[] = [];
  const rawFindings = new Map<string, Finding>();
  for (const lane of args.epoch.requiredLanes) {
    const laneRuns = candidates.filter(run => run.lane === lane).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const runEvidence = laneRuns.map(run => evidenceForRun(run, args.passes, args.findings, args.promptStore));
    const selected = runEvidence.find(row => row.terminal);
    if (!selected?.terminal) continue;
    lanes.push(selected.terminal);
    // Coverage has one canonical terminal per lane, but completeness aggregates
    // every verified finding from every eligible same-wave run for that lane.
    runEvidence.forEach(row => row.findings.forEach(finding => rawFindings.set(finding.id, finding)));
  }
  // A completeness critic may discover a defect after required lanes finish.
  // Include every eligible same-wave critic observation, without treating the
  // critic as another required lane or accepting default topology authority.
  const inventoryCriticRuns = candidates.filter(run =>
    canonicalAgentRoleId(run.lane) === 'proof-or-stop-review-topology-critic'
    && run.reviewPurpose === 'inventory-completeness'
    && inventoryPurposeMatchesEpoch(run.inventoryBinding, args.epoch));
  for (const run of inventoryCriticRuns) {
    evidenceForRun(run, args.passes, args.findings, args.promptStore).findings
      .forEach(finding => rawFindings.set(finding.id, finding));
  }
  const signedBaselineIds = [...(args.epoch.baselineFindingIds ?? [])].sort();
  const liveBaselineIds = captureReviewInventoryBaselineFindingIds({ promptStore: args.promptStore, epoch: args.epoch, runs: args.runs, findings: args.findings });
  const baselineMismatchIds = [...new Set([
    ...signedBaselineIds.filter(id => !liveBaselineIds.includes(id)),
    ...liveBaselineIds.filter(id => !signedBaselineIds.includes(id)),
  ])].sort();
  // A baseline is carried into the first wave exactly once. Subsequent waves
  // inherit its family through the signed prior wave instead of rediscovering it.
  if (args.epoch.waves.length === 0) {
    for (const id of signedBaselineIds) {
      const finding = args.findings.find(row => row.id === id);
      if (finding && isEligibleBaselineFinding(args.epoch, finding, args.runs, args.promptStore)) rawFindings.set(id, finding);
    }
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
    baselineMismatchIds,
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
    terminalRunSequenceBoundary: maxReviewRunSequence(store.readReviewRuns(storyId).runs),
  };
  const invalidated: ReviewInventoryEpoch = { ...unsigned, _hash: signReviewInventoryEpoch(unsigned) };
  const data = store.readReviewInventoryEpochs(storyId);
  data.criticReceipts ??= [];
  data.epochs = data.epochs.map(row => row.epochId === epoch.epochId ? invalidated : row);
  store.writeReviewInventoryEpochs(storyId, data);
  throw new Error(
    `OPEN_REVIEW_INVENTORY_MATERIAL_MUTATION\nEpoch: ${epoch.epochId}\n` +
    `Changed lineage: ${epoch.cutoff.materialHash} -> ${current.materialHash}\n` +
    `Recovery: proof-or-stop review_inventory_begin --storyId=${storyId}`,
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
  if (!receipt || !verifyReviewInventoryReceipt(receipt) || receipt.consumedAt || receipt.invalidatedAt) return null;
  if (receipt.epochId !== epoch.epochId || receipt.storyId !== storyId || receipt.reviewRound !== epoch.reviewRound) return null;
  return { epoch, receipt };
}

/** Fail closed while an immutable remediation receipt is awaiting consumption. */
export function assertReviewInventoryEvidenceWritable(store: StoryStore, storyId: string, run: ReviewRun): void {
  const latest = store.readReviewInventoryEpochs(storyId).epochs.at(-1);
  if (!latest || latest.reviewRound !== run.reviewRound) return;
  if (latest.state === 'FINALIZED') {
    throw new Error(
      `REVIEW_INVENTORY_EVIDENCE_SEALED: ${latest.epochId} finalized reviewRound ${latest.reviewRound}; ` +
      (latest.consumedAt
        ? 'reviewer evidence for that round remains sealed after receipt consumption'
        : `for genuine late evidence run proof-or-stop review_inventory_cancel --storyId=${storyId} --reason="late evidence invalidated finalized receipt", then begin a fresh epoch and fresh ReviewRun`),
    );
  }
  if (latest.state === 'CANCELLED' || latest.state === 'INVALIDATED') {
    const terminalBoundary = latest.cancelledAt ?? latest.invalidation?.detectedAt ?? latest.updatedAt;
    const sequence = reviewRunSequence(run);
    const predatesBoundary = latest.terminalRunSequenceBoundary !== undefined
      ? sequence === null || sequence <= latest.terminalRunSequenceBoundary
      : run.startedAt <= terminalBoundary;
    if (predatesBoundary) {
      throw new Error(
        `REVIEW_INVENTORY_EVIDENCE_SEALED: reviewRunId ${run.reviewRunId} predates terminal epoch boundary ${terminalBoundary}; ` +
        'begin a fresh epoch and start a fresh ReviewRun',
      );
    }
    return;
  }
  if (latest.state !== 'OPEN') return;
  const waveStart = latest.waves.at(-1)?.completedAt ?? latest.begunAt;
  const sequenceBoundary = latest.waves.at(-1)?.nextRunSequenceBoundary ?? latest.initialRunSequenceBoundary;
  const sequence = reviewRunSequence(run);
  const sealed = sequenceBoundary !== undefined
    ? sequence === null || sequence <= sequenceBoundary
    : run.startedAt <= waveStart;
  if (sealed) {
    throw new Error(
      `REVIEW_INVENTORY_WAVE_EVIDENCE_SEALED: reviewRunId ${run.reviewRunId} started at ${run.startedAt} before current wave ${latest.waves.length + 1} boundary ${waveStart}; ` +
      'start a fresh ReviewRun for the current wave',
    );
  }
}

export function finalizedLiveAggregateError(store: StoryStore, pair: {
  epoch: ReviewInventoryEpoch;
  receipt: ReviewInventoryReceipt;
}): string | undefined {
  const { epoch, receipt } = pair;
  if (epoch.rosterBasis || receipt.rosterBasis) {
    try {
      const current = finalReviewRosterForStory(store, store.projectRoot, epoch.storyId);
      if (!epoch.rosterBasis || epoch.rosterBasis !== receipt.rosterBasis
        || epoch.rosterBasis !== finalReviewRosterBasis(current)
        || reviewInventoryDigest(epoch.requiredLanes) !== reviewInventoryDigest(current.selection.selectedLanes)
        || reviewInventoryDigest(receipt.requiredLanes) !== reviewInventoryDigest(epoch.requiredLanes)) {
        return 'narrowed review roster basis changed after finalize';
      }
    } catch { return 'narrowed review roster basis cannot be verified'; }
  }
  const finalWave = epoch.waves.at(-1);
  const remediationOnly = receipt.authority === 'review-remediation-only';
  if (!finalWave || !finalWave.completedAt
    || (!remediationOnly && (!finalWave.saturated || finalWave.newVerifiedFindingCount !== 0))) {
    return 'final saturated wave is missing or invalid';
  }
  const replayEpoch: ReviewInventoryEpoch = {
    ...epoch,
    state: 'OPEN',
    waves: epoch.waves.slice(0, -1),
  };
  const data = store.readReviewInventoryEpochs(epoch.storyId);
  const evaluation = evaluateReviewInventoryWave({ promptStore: store,
    epoch: replayEpoch,
    runs: store.readReviewRuns(epoch.storyId).runs,
    passes: store.readReviewPasses(epoch.storyId).passes,
    findings: store.readFindings(epoch.storyId).findings,
    findingDispositions: data.criticReceipts.find(row =>
      row.epochId === epoch.epochId && row.wave === epoch.waves.length,
    )?.findingDispositions,
  });
  if (evaluation.missingLanes.length > 0 || evaluation.duplicateIdentities.length > 0
    || evaluation.unresolvedFindingIds.length > 0 || evaluation.invalidDispositionIds.length > 0
    || evaluation.baselineMismatchIds.length > 0) {
    return 'live terminal lanes or finding dispositions differ from the finalized wave';
  }
  const critic = validateReviewInventoryCriticReceipt({ promptStore: store,
    receipt: data.criticReceipts.find(row =>
      row.epochId === epoch.epochId && row.wave === epoch.waves.length,
    ),
    epoch: replayEpoch,
    evaluation,
    runs: store.readReviewRuns(epoch.storyId).runs,
    passes: store.readReviewPasses(epoch.storyId).passes,
    findings: store.readFindings(epoch.storyId).findings,
  });
  if (!critic.ok) return `live critic binding changed: ${critic.reason}`;
  const rebuilt = buildWave(replayEpoch, evaluation, finalWave.completedAt);
  if (reviewInventoryDigest(rebuilt.lanes) !== reviewInventoryDigest(finalWave.lanes)
    || rebuilt.verifiedFindingSetDigest !== finalWave.verifiedFindingSetDigest
    || rebuilt.criticDigest !== finalWave.criticDigest
    || rebuilt.newVerifiedFindingCount !== finalWave.newVerifiedFindingCount
    || rebuilt.saturated !== finalWave.saturated
    || (!remediationOnly && (rebuilt.newVerifiedFindingCount !== 0 || !rebuilt.saturated))) {
    return 'live terminal/finding aggregate digest differs from the finalized wave';
  }
  if (receipt.findingSetDigest !== reviewInventoryDigest(rebuilt.verifiedFindingFamilies)
    || receipt.coverageDigest !== reviewInventoryDigest(epoch.waves.flatMap(row => row.lanes.map(lane => lane.coverageDigest)))) {
    return 'receipt aggregate digest differs from the live finalized wave';
  }
  return undefined;
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
    nextCommand: `proof-or-stop review_inventory_begin --storyId=${storyId}`,
  };
  const latest = data.epochs.at(-1);
  if (latest?.state === 'OPEN') return {
    required: true,
    ok: false,
    reason: `latest review inventory ${latest.epochId} is still OPEN`,
    nextCommand: `proof-or-stop review_inventory_status --storyId=${storyId}`,
  };
  const pair = finalizedUnconsumedReviewInventory(store, storyId);
  if (!pair) return {
    required: true,
    ok: false,
    reason: 'missing valid unconsumed FINALIZED review inventory receipt',
    nextCommand: `proof-or-stop review_inventory_status --storyId=${storyId}`,
  };
  if (reviewRound && pair.epoch.reviewRound !== reviewRound) {
    return {
      required: true,
      ok: false,
      reason: `receipt reviewRound ${pair.epoch.reviewRound} != current ${reviewRound}`,
      nextCommand: `proof-or-stop review_inventory_begin --storyId=${storyId}`,
    };
  }
  return { required: true, ok: true };
}

/** PRE_CERT completeness-only receipts: empty waves/lanes, never TEST authority. */
export function isInventoryCompletenessOnlyReceipt(
  epoch: ReviewInventoryEpoch,
  receipt: ReviewInventoryReceipt,
): boolean {
  return epoch.waves.length === 0
    && receipt.waveCount === 0
    && epoch.requiredLanes.length === 0
    && receipt.requiredLanes.length === 0
    && receipt.authority === INVENTORY_COMPLETENESS_AUTHORITY
    && receipt.authorizesTest === false;
}

function markReviewInventoryConsumed(
  store: StoryStore,
  storyId: string,
  pair: { epoch: ReviewInventoryEpoch; receipt: ReviewInventoryReceipt },
  reviewRound: string,
  admissionWindowId?: string,
): string {
  const now = new Date().toISOString();
  const data = store.readReviewInventoryEpochs(storyId);
  data.epochs = data.epochs.map(row => {
    if (row.epochId !== pair.epoch.epochId) return row;
    const { _hash, ...unsigned } = row;
    const consumed: Omit<ReviewInventoryEpoch, '_hash'> = { ...unsigned, consumedAt: now, ...(admissionWindowId ? { consumedByCertificationWindowId: admissionWindowId } : {}), consumedByReviewRound: reviewRound, updatedAt: now };
    return { ...consumed, _hash: signReviewInventoryEpoch(consumed) };
  });
  data.receipts = data.receipts.map(row => {
    if (row.receiptId !== pair.receipt.receiptId) return row;
    const { _hash, ...unsigned } = row;
    const consumed: Omit<ReviewInventoryReceipt, '_hash'> = { ...unsigned, consumedAt: now, ...(admissionWindowId ? { consumedByCertificationWindowId: admissionWindowId } : {}) };
    return { ...consumed, _hash: signReviewInventoryReceipt(consumed) };
  });
  store.writeReviewInventoryEpochs(storyId, data);
  return pair.receipt.receiptId;
}

export function consumeReviewInventoryReceipt(
  store: StoryStore,
  storyId: string,
  reviewRound: string,
  currentCutoff: { materialHash: string; storyFilesHash?: string },
  validateInventoryContext?: () => void,
): string | null {
  return withReviewInventoryMutationLock(store, storyId, () => {
    validateInventoryContext?.();
    const gate = reviewInventoryRemediationGate(store, storyId, reviewRound);
    if (!gate.ok) throw new Error(`REVIEW_INVENTORY_REMEDIATION_BLOCKED: ${gate.reason}`);
    const pair = finalizedUnconsumedReviewInventory(store, storyId)!;
    const currentAcceptanceSubjectDigest = reviewInventoryAcceptanceSubjectDigestForStore(store, storyId);
    if (pair.epoch.scopeDigest !== currentAcceptanceSubjectDigest
      || pair.receipt.scopeDigest !== currentAcceptanceSubjectDigest) {
      throw new Error(
        'REVIEW_INVENTORY_REMEDIATION_BLOCKED: effective ProofStory/checklist acceptance subject changed after finalize; begin a fresh inventory epoch',
      );
    }
    if (pair.receipt.cutoff.materialHash !== currentCutoff.materialHash
      || (pair.receipt.cutoff.storyFilesHash ?? '') !== (currentCutoff.storyFilesHash ?? '')) {
      throw new Error('REVIEW_INVENTORY_REMEDIATION_BLOCKED: current material/storyFiles no longer match the finalized cutoff');
    }
    const liveAggregateError = finalizedLiveAggregateError(store, pair);
    if (liveAggregateError) {
      throw new Error(`REVIEW_INVENTORY_LIVE_AGGREGATE_CHANGED: ${liveAggregateError}; begin a fresh inventory epoch`);
    }
    return markReviewInventoryConsumed(store, storyId, pair, reviewRound);
  });
}

/**
 * PRE_CERT consume. Completeness-only empty-wave receipts skip acceptance-subject
 * and live-aggregate checks. Wave-saturated receipts keep those checks so a stale
 * saturation receipt cannot enter a PRE_CERT window.
 */
export function consumeReviewInventoryCompletenessReceipt(
  store: StoryStore,
  storyId: string,
  reviewRound: string,
  currentCutoff: { materialHash: string; storyFilesHash?: string },
  validateInventoryContext?: () => void,
  admissionWindowId?: string,
): string | null {
  return withReviewInventoryMutationLock(store, storyId, () => consumeReviewInventoryCompletenessReceiptUnlocked(store, storyId, reviewRound, currentCutoff, validateInventoryContext, admissionWindowId));
}

/** Caller must already hold the review inventory mutation lock. */
export function consumeReviewInventoryCompletenessReceiptUnlocked(
  store: StoryStore,
  storyId: string,
  reviewRound: string,
  currentCutoff: { materialHash: string; storyFilesHash?: string },
  validateInventoryContext?: () => void,
  admissionWindowId?: string,
): string | null {
    validateInventoryContext?.();
    const data = store.readReviewInventoryEpochs(storyId);
    const latest = data.epochs.at(-1);
    const latestReceipt = latest?.receiptId
      ? data.receipts.find(row => row.receiptId === latest.receiptId)
      : undefined;
    if (latest && (latest.consumedAt || latestReceipt?.consumedAt)) {
      throw new Error(
        `REVIEW_INVENTORY_RECEIPT_ALREADY_CONSUMED: ${latest.receiptId ?? latest.epochId} is already consumed`,
      );
    }
    const pair = finalizedUnconsumedReviewInventory(store, storyId);
    if (pair?.receipt.authority === 'review-remediation-only') {
      throw new Error('REVIEW_INVENTORY_AUTHORITY_MISMATCH: remediation-only receipt cannot enter certification');
    }
    if (!pair) {
      throw new Error('REVIEW_INVENTORY_PRE_CERT_BLOCKED: missing valid unconsumed FINALIZED review inventory receipt');
    }
    if (reviewRound && pair.epoch.reviewRound !== reviewRound) {
      throw new Error(
        `REVIEW_INVENTORY_PRE_CERT_BLOCKED: receipt reviewRound ${pair.epoch.reviewRound} != current ${reviewRound}`,
      );
    }
    if (pair.receipt.cutoff.materialHash !== currentCutoff.materialHash
      || (pair.receipt.cutoff.storyFilesHash ?? '') !== (currentCutoff.storyFilesHash ?? '')) {
      throw new Error('REVIEW_INVENTORY_PRE_CERT_BLOCKED: current material/storyFiles no longer match the finalized cutoff');
    }
    if (!isInventoryCompletenessOnlyReceipt(pair.epoch, pair.receipt)) {
      const currentAcceptanceSubjectDigest = reviewInventoryAcceptanceSubjectDigestForStore(store, storyId);
      if (pair.epoch.scopeDigest !== currentAcceptanceSubjectDigest
        || pair.receipt.scopeDigest !== currentAcceptanceSubjectDigest) {
        throw new Error(
          'REVIEW_INVENTORY_REMEDIATION_BLOCKED: effective ProofStory/checklist acceptance subject changed after finalize; begin a fresh inventory epoch',
        );
      }
      const liveAggregateError = finalizedLiveAggregateError(store, pair);
      if (liveAggregateError) {
        throw new Error(`REVIEW_INVENTORY_LIVE_AGGREGATE_CHANGED: ${liveAggregateError}; begin a fresh inventory epoch`);
      }
    }
    return markReviewInventoryConsumed(store, storyId, pair, reviewRound, admissionWindowId);
}

export function buildWave(epoch: ReviewInventoryEpoch, evaluation: ReviewInventoryEvaluation, now: string, nextRunSequenceBoundary?: number): ReviewInventoryWave {
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
    ...(nextRunSequenceBoundary !== undefined ? { nextRunSequenceBoundary } : {}),
  };
}

function sameCutoff(
  left: { headHash: string; materialHash: string; storyFilesHash?: string },
  right: { headHash: string; materialHash: string; storyFilesHash?: string },
): boolean {
  return left.headHash === right.headHash
    && left.materialHash === right.materialHash
    && (left.storyFilesHash ?? '') === (right.storyFilesHash ?? '');
}

/** CertificationWindow PRE_CERT completeness receipt. Does not authorize TEST. */
export function persistFinalizedReviewInventory(args: {
  store: StoryStore;
  storyId: string;
  reviewRound: string;
  cutoff: { headHash: string; materialHash: string; storyFilesHash?: string };
}): { epoch: ReviewInventoryEpoch; receipt: ReviewInventoryReceipt; reused: boolean } {
  return withReviewInventoryMutationLock(args.store, args.storyId, () => persistFinalizedReviewInventoryUnlocked(args));
}

/** Caller must already hold the review-inventory epochs lock. */
export function persistFinalizedReviewInventoryUnlocked(args: {
  store: StoryStore;
  storyId: string;
  reviewRound: string;
  cutoff: { headHash: string; materialHash: string; storyFilesHash?: string };
}): { epoch: ReviewInventoryEpoch; receipt: ReviewInventoryReceipt; reused: boolean } {
    const data = args.store.readReviewInventoryEpochs(args.storyId);
    const latest = data.epochs.at(-1);
    if (latest && latest.state === 'FINALIZED' && !latest.consumedAt && latest.receiptId) {
      const existing = data.receipts.find(row => row.receiptId === latest.receiptId);
      if (
        existing
        && verifyReviewInventoryEpoch(latest)
        && verifyReviewInventoryReceipt(existing)
        && !existing.consumedAt
        && !existing.invalidatedAt
        && sameCutoff(latest.cutoff, args.cutoff)
        && sameCutoff(existing.cutoff, args.cutoff)
        && latest.storyId === args.storyId
        && existing.storyId === args.storyId
      ) {
        return { epoch: latest, receipt: existing, reused: true };
      }
    }
    const now = new Date().toISOString();
    const seq = String(data.epochs.length + 1).padStart(3, '0');
    const epochId = `${args.storyId}:RIE-${seq}`;
    const receiptId = `${epochId}:RCP-001`;
    // B-45a0: this MUST be the acceptance-subject digest, not a digest of the
    // cutoff. consumeReviewInventoryReceipt compares epoch/receipt scopeDigest
    // against reviewInventoryAcceptanceSubjectDigestForStore, so writing
    // reviewInventoryDigest(args.cutoff) here put the two in different digest
    // domains and made every receipt minted by this no-OPEN-epoch path
    // permanently unconsumable: consume failed with "effective ProofStory/
    // checklist acceptance subject changed after finalize" while the subject
    // had not changed at all. Measured on B-45a0: live subject digest
    // 0375089c… stayed byte-stable across cancel+finalize, while the stored
    // value 1b0e8855… recomputed exactly as reviewInventoryDigest(cutoff).
    // The OPEN-epoch path (currentScope in handlers/review-inventory.ts) always
    // used the subject digest; only this shortcut diverged.
    const scopeDigest = reviewInventoryAcceptanceSubjectDigestForStore(args.store, args.storyId);
    const emptyDigest = reviewInventoryDigest([]);
    const unsignedEpoch: Omit<ReviewInventoryEpoch, '_hash'> = {
      schemaVersion: REVIEW_INVENTORY_EPOCH_SCHEMA,
      epochId,
      storyId: args.storyId,
      reviewRound: args.reviewRound,
      state: 'FINALIZED',
      begunAt: now,
      updatedAt: now,
      cutoff: args.cutoff,
      scopeDigest,
      requiredLanes: [],
      maxWaves: 1,
      waves: [],
      receiptId,
    };
    const epoch: ReviewInventoryEpoch = { ...unsignedEpoch, _hash: signReviewInventoryEpoch(unsignedEpoch) };
    const unsignedReceipt: Omit<ReviewInventoryReceipt, '_hash'> = {
      schemaVersion: REVIEW_INVENTORY_RECEIPT_SCHEMA,
      receiptId,
      epochId,
      storyId: args.storyId,
      reviewRound: args.reviewRound,
      cutoff: args.cutoff,
      scopeDigest,
      requiredLanes: [],
      waveCount: 0,
      findingSetDigest: emptyDigest,
      coverageDigest: emptyDigest,
      saturationResult: 'ZERO_NEW_VERIFIED_FINDINGS',
      authority: INVENTORY_COMPLETENESS_AUTHORITY,
      authorizesTest: false,
      issuedAt: now,
    };
    const receipt: ReviewInventoryReceipt = { ...unsignedReceipt, _hash: signReviewInventoryReceipt(unsignedReceipt) };
    data.epochs.push(epoch);
    data.receipts.push(receipt);
    args.store.writeReviewInventoryEpochs(args.storyId, data);
    return { epoch, receipt, reused: false };
}

export function renderFinalizedReviewInventory(epoch: ReviewInventoryEpoch, receipt: ReviewInventoryReceipt): string {
  return [
    `State: ${epoch.state}`,
    `Epoch: ${epoch.epochId}`,
    `Receipt: ${receipt.receiptId}`,
    `headHash: ${epoch.cutoff.headHash}`,
    `materialHash: ${epoch.cutoff.materialHash}`,
    `storyFilesHash: ${epoch.cutoff.storyFilesHash ?? ''}`,
    `Authority: ${receipt.authority}`,
    `authorizesTest: ${receipt.authorizesTest}`,
  ].join('\n');
}
