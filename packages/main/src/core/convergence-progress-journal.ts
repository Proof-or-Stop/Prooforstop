import { hasMechanicalExecutionAuthority } from './verification-receipt-authority.js';
/** Tool-owned observation boundary. Callers supply identifiers, never progress counts. */
import { existsSync, readFileSync } from 'node:fs';
import type { StoryStore } from './store.js';
import { canonicalDigest } from './authority-signing.js';
import { signValidationArtifact, verifyValidationArtifact } from './validation-artifact-signing.js';
import { assessEffectiveProgress, type EffectiveProgressState, type EffectiveProgressSnapshot } from './convergence-effective-progress.js';
import { finalizedLiveAggregateError, verifyReviewInventoryEpoch, verifyReviewInventoryReceipt, withReviewInventoryMutationLock } from './review-inventory-epoch.js';
import { collectReviewerEvidenceState } from './review-run.js';
import { verifyFinding } from './finding-verify.js';
import { buildVerificationCoverage, collectVerificationIntents } from './verification.js';
import { captureEvidenceHashSnapshot, checkEvidenceFreshnessForGit } from './evidence-freshness.js';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
import { ACTIVE_PHASE_ORDER } from './phase-flow.js';

export interface ConvergenceProgressJournal {
  schemaVersion: 'proofbound.convergence_progress_journal.v1';
  storyId: string;
  state: EffectiveProgressState;
  openVerifiedFindingIds: string[];
  completedEpochBindings: { epochId: string; claimDigest: string }[];
  revokedCompletedEpochIds: string[];
  signature: string;
}
function completedClaim(store: StoryStore, storyId: string, epochId: string, allowRevoked = false) {
  const data = store.readReviewInventoryEpochs(storyId);
  const epoch = data.epochs.find(e => e.epochId === epochId);
  const receipt = data.receipts.find(r => r.receiptId === epoch?.receiptId);
  const revoked = Boolean(allowRevoked && epoch?.state === 'CANCELLED' && !epoch.consumedAt && !receipt?.consumedAt
    && epoch.cancelledAt && epoch.cancelledAt === receipt?.invalidatedAt
    && epoch.cancelReason?.trim() && epoch.cancelReason === receipt?.invalidationReason);
  if (!epoch || !receipt || !verifyReviewInventoryEpoch(epoch) || !verifyReviewInventoryReceipt(receipt)
    || (!revoked && epoch.state !== 'FINALIZED') || epoch.invalidation || (!revoked && receipt.invalidatedAt) || !epoch.waves.length || !epoch.requiredLanes.length
    || epoch.storyId !== storyId || receipt.storyId !== storyId || receipt.epochId !== epochId
    || receipt.reviewRound !== epoch.reviewRound || canonicalDigest(receipt.cutoff) !== canonicalDigest(epoch.cutoff)
    || receipt.scopeDigest !== epoch.scopeDigest || canonicalDigest(receipt.requiredLanes) !== canonicalDigest(epoch.requiredLanes)
    || receipt.waveCount !== epoch.waves.length) throw new Error('Invalid completed convergence epoch or receipt');
  // Consumption is a legitimate later lifecycle write; completion facts stay fixed.
  const { _hash: _epochHash, consumedAt: _consumed, consumedByReviewRound: _round, updatedAt: _updated, state: _state, cancelledAt: _cancelled, cancelReason: _reason, terminalRunSequenceBoundary: _boundary, ...epochClaims } = epoch;
  const { _hash: _receiptHash, consumedAt: _receiptConsumed, invalidatedAt: _invalidated, invalidationReason: _invalidationReason, ...receiptClaims } = receipt;
  return { epoch, receipt, revoked, claimDigest: canonicalDigest({ epoch: epochClaims, receipt: receiptClaims }) };
}
export function readConvergenceProgress(store: StoryStore, storyId: string, root: string): ConvergenceProgressJournal | null {
  const journal = store.readConvergenceProgress(storyId);
  if (!journal) return null;
  const { signature, ...claims } = journal;
  if (journal.schemaVersion !== 'proofbound.convergence_progress_journal.v1' || journal.storyId !== storyId
    || !verifyValidationArtifact(claims, signature, root)) throw new Error('Convergence progress journal signature invalid');
  assessEffectiveProgress(journal.state, journal.state.snapshot); // Validate state shape without changing it.
  if (canonicalDigest(journal.completedEpochBindings.map(b => b.epochId)) !== canonicalDigest(journal.state.snapshot.completedEpochIds)) throw new Error('Convergence epoch binding history invalid');
  for (const binding of journal.completedEpochBindings) {
    if (completedClaim(store, storyId, binding.epochId, true).claimDigest !== binding.claimDigest) throw new Error('Convergence completed epoch history changed');
  }
  return journal;
}
function collect(store: StoryStore, storyId: string, root: string, prior: ConvergenceProgressJournal | null, completedEpochIds: string[]) {
  // StoryStore's legacy reader intentionally tolerates a broken mirror. That is
  // unsuitable for proving a decrease: distinguish corruption from an empty set.
  const mirror = store.storyFilePath(storyId, 'findings.json');
  if (existsSync(mirror)) {
    const parsed = JSON.parse(readFileSync(mirror, 'utf8'));
    if (!Array.isArray(parsed?.findings)) throw new Error('Invalid finding mirror');
  }
  const findings = store.readFindings(storyId).findings;
  for (const id of prior?.openVerifiedFindingIds ?? []) {
    if (!findings.some(f => f.id === id)) throw new Error(`Convergence finding history missing: ${id}`);
  }
  const ledger = store.readFindingLedger<{ id?: string; findingId?: string }>(storyId);
  const authenticated = (finding: typeof findings[number]) => Boolean(finding.recordId && finding.ledgerCommitReceiptId
    && ledger.records.some(record => record.recordId === finding.recordId
      && ((record.recordType === 'finding' && record.payload?.id === finding.id)
        || (record.recordType === 'legacy_identity_binding' && record.payload?.findingId === finding.id)))
    && ledger.receipts.some(receipt => receipt.receiptId === finding.ledgerCommitReceiptId && receipt.recordIds.includes(finding.recordId!)));
  // readFindings verifies actual ledger carriers and projects their signed state.
  // Mirror-only marker fields are never a substitute for those authenticated rows.
  for (const finding of findings) {
    if (!authenticated(finding) && !verifyFinding(storyId, finding)) throw new Error(`Invalid finding authority: ${finding.id}`);
    if (prior?.openVerifiedFindingIds.includes(finding.id)) {
      if (!authenticated(finding) && (finding.status !== 'open' || (finding.evidenceState !== undefined && finding.evidenceState !== 'verified')))
        throw new Error(`Convergence finding transition requires ledger authority: ${finding.id}`);
      if (finding.evidenceState === 'suspected') throw new Error(`Convergence finding downgrade is not repair: ${finding.id}`);
    }
  }
  const verified = findings.filter(f => f.evidenceState === 'verified' || f.evidenceState === undefined);
  // A compatibility dismissal is not proof of repair and cannot reduce outstanding work.
  const open = verified.filter(f => f.status === 'open' || (f.status === 'dismissed' && prior?.openVerifiedFindingIds.includes(f.id)));
  const story = store.readStory(storyId), checklist = store.readChecklist(storyId);
  const metadataRoot = store.projectRoot;
  const source = captureEvidenceHashSnapshot({ gitCwd: root, metadataRoot });
  if (source.materialDirtyFiles.length) throw new Error('Convergence source has dirty material; current committed PASS cannot prove progress');
  const head = source.headHash, materialHash = source.materialHash;
  if (!head || !materialHash) throw new Error('Convergence source identity unavailable');
  const profile = resolveWorkflowPolicy(loadConfig(metadataRoot), story).profile;
  for (const item of checklist.items) for (const evidence of item.verificationEvidence ?? []) {
    if (evidence.mechanical === true && evidence.result === 'pass' && !hasMechanicalExecutionAuthority(store, storyId, item, evidence))
      throw new Error(`Convergence verification execution authority missing or invalid: ${evidence.intentRef}`);
  }
  const coverage = buildVerificationCoverage(checklist, head,
    (evidenceHead, evidence) => checkEvidenceFreshnessForGit(root, evidenceHead, evidence?.materialHash, metadataRoot, evidence?.storyFilesHash).fresh,
    { deferredGateEvidence: 'missing', evidenceQualityProfile: profile });
  const emptyItems = checklist.items.filter(i => i.status !== 'withdrawn' && !collectVerificationIntents(i).length && !(i.verificationEvidence?.length));
  const evidence = collectReviewerEvidenceState(store, storyId, metadataRoot);
  const currentPassLanes = [...new Set(evidence.valid.filter(row => row.kind === 'pass').map(row => row.agent))].sort();
  const rank = (phase: string) => (ACTIVE_PHASE_ORDER as readonly string[]).indexOf(phase);
  const snapshot: EffectiveProgressSnapshot = {
    completedEpochIds, openVerifiedFindings: open.length, missingRequired: coverage.missingRequired + emptyItems.length,
    blockingSignature: canonicalDigest({ findings: open.map(f => ({ id: f.id, severity: f.severity })).sort((a, b) => a.id.localeCompare(b.id)),
      verification: coverage.entries.filter(e => e.priority === 'must' && !['covered', 'waived', ...(profile === 'strict' ? [] : ['weak'])].includes(e.status)).map(e => ({ ref: e.intentRef, status: e.status })).sort((a, b) => a.ref.localeCompare(b.ref)),
      emptyItems: emptyItems.map(i => i.id).sort() }),
    materialHash, currentPassLanes,
    phaseAdvanceOrdinal: Math.max(0, rank(story.phase), ...(story.events ?? []).filter(e => e.action === 'advance').map(e => rank(e.phase))),
  };
  return { snapshot, openVerifiedFindingIds: open.map(f => f.id).sort() };
}
function revocationState(store: StoryStore, storyId: string, prior: ConvergenceProgressJournal | null) {
  const revokedIds = (prior?.completedEpochBindings ?? []).filter(binding => completedClaim(store, storyId, binding.epochId, true).revoked).map(binding => binding.epochId);
  if ((prior?.revokedCompletedEpochIds ?? []).some(id => !revokedIds.includes(id))) throw new Error('Convergence revoked epoch history changed');
  const changed = revokedIds.some(id => !(prior?.revokedCompletedEpochIds ?? []).includes(id));
  const state = prior && changed ? { ...prior.state, epochBaseline: structuredClone(prior.state.snapshot), stagnantEpochIds: [], stablePassProgress: [] } : prior?.state ?? null;
  return { state, revokedIds };
}
/** Read-only live comparison; it does not sign, refresh a lease, or append an observation. */
export function evaluateConvergenceProgress(store: StoryStore, storyId: string, root: string) {
  const prior = readConvergenceProgress(store, storyId, root);
  const current = collect(store, storyId, root, prior, prior?.state.snapshot.completedEpochIds ?? []);
  return assessEffectiveProgress(revocationState(store, storyId, prior).state, current.snapshot);
}
export function recordConvergenceProgress(store: StoryStore, storyId: string, root: string, options: { completedEpochId?: string } = {}) {
  return withReviewInventoryMutationLock(store, storyId, () => recordConvergenceProgressUnlocked(store, storyId, root, options));
}
/** The inventory owner already holds this lock when beginning or finalizing a wave. */
export function recordConvergenceProgressUnlocked(store: StoryStore, storyId: string, root: string, options: { completedEpochId?: string } = {}) {
  const prior = readConvergenceProgress(store, storyId, root);
  const bindings = [...(prior?.completedEpochBindings ?? [])];
  if (options.completedEpochId && !bindings.some(b => b.epochId === options.completedEpochId)) {
    if (store.readReviewInventoryEpochs(storyId).epochs.at(-1)?.epochId !== options.completedEpochId) throw new Error('Convergence completion requires the latest epoch, not a historical replay');
    const completed = completedClaim(store, storyId, options.completedEpochId);
    const error = finalizedLiveAggregateError(store, completed);
    if (error) throw new Error(`Convergence epoch is not independently complete: ${error}`);
    bindings.push({ epochId: options.completedEpochId, claimDigest: completed.claimDigest });
  }
  const current = collect(store, storyId, root, prior, bindings.map(b => b.epochId));
  const revocation = revocationState(store, storyId, prior);
  const assessment = assessEffectiveProgress(revocation.state, current.snapshot);
  const claims = { schemaVersion: 'proofbound.convergence_progress_journal.v1' as const, storyId,
    state: assessment.state, revokedCompletedEpochIds: revocation.revokedIds, openVerifiedFindingIds: current.openVerifiedFindingIds, completedEpochBindings: bindings };
  // Compare claims explicitly so repeated observations remain byte-identical.
  const previousClaims = prior ? (({ signature: _signature, ...rest }: ConvergenceProgressJournal) => rest)(prior) : null;
  if (!previousClaims || canonicalDigest(previousClaims) !== canonicalDigest(claims)) {
    store.writeConvergenceProgress(storyId, { ...claims, signature: signValidationArtifact(claims, root) });
  }
  return assessment;
}
