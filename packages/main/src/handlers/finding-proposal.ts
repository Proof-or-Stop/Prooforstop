/** Reviewer-owned producer for the existing immutable Story 3 proposal port. */
import { readBrandEnv } from '../core/brand-env.js';
import { resolveRegisteredAgentActor } from '../core/agent-dispatch-registry.js';
import { collectReviewerEvidenceState } from '../core/review-run.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { canonicalHash, type JsonValue } from '../core/finding-ledger.js';
import { signAssessmentProposal, exactLedgerRecordHash, findingLedgerSignerFromWorkspace, readCurrentFindingRuntimeEvidence } from './finding-ledger.js';
import { proposalAuthorityDigest, proposalFindingHash, proposalScopeDigest } from './finding-route.js';
import { FINDING_PROOF_POLICY } from './finding-applicability-proof.js';
import type { HandlerContext } from './context.js';

export function prepareFindingAssessmentProposal(ctx: HandlerContext, input: {
  storyId: string; findingId: string; idempotencyKey: string; proposal: Record<string, unknown>;
}) {
  const actor = resolveRegisteredAgentActor(readBrandEnv('AGENT'));
  if (!actor?.reviewerLane || !actor.permittedMutations.includes('finding_add') || ctx.store.readStory(input.storyId).phase !== 'REVIEW') throw new Error('dynamic finding: current reviewer proposal authority required');
  const ledger = ctx.store.readFindingLedger<JsonValue>(input.storyId);
  const finding = ctx.store.readFindings(input.storyId).findings.find(row => row.id === input.findingId);
  const source = ledger.records.find(row => row.recordId === finding?.recordId && row.recordType === 'finding');
  if (!finding || finding.status !== 'open' || finding.evidenceState !== 'verified' || !source
    || !collectReviewerEvidenceState(ctx.store, input.storyId, ctx.root).valid.some(row => row.kind === 'finding' && row.id === finding.id
      && row.agent === actor.canonicalName && row.reviewRunId === finding.reviewRunId)) throw new Error('dynamic finding: exact current reviewer-owned verified Finding required');
  const desired = input.proposal; const runtimeIds = desired.runtimeReceiptIds;
  if (!Array.isArray(runtimeIds) || runtimeIds.length === 0 || runtimeIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('dynamic finding: proposal requires executed runtime witnesses');
  runtimeIds.forEach(id => readCurrentFindingRuntimeEvidence(ctx, input.storyId, id));
  const now = new Date(); const expiresAt = Date.parse(String(desired.expiresAt));
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime() || expiresAt > now.getTime() + 30 * 86_400_000) throw new Error('dynamic finding: proposal expiry must be within 30 days');
  const signer = findingLedgerSignerFromWorkspace(ctx.root); const authorityDigest = proposalAuthorityDigest(actor.canonicalName);
  const findingRef = { storyId: input.storyId, findingId: finding.id, recordId: source.recordId };
  const findingHash = proposalFindingHash(ctx, { ...findingRef, recordHash: exactLedgerRecordHash(source) });
  const dependency = { sourceFinding: { ...findingRef, hash: findingHash, version: source.recordId },
    ledgerSnapshotDigest: ledger.committedLedgerDigest, proofPolicyDigest: canonicalHash(FINDING_PROOF_POLICY), reviewerAuthorityPolicyDigest: authorityDigest };
  const proposal = signAssessmentProposal({ ...desired, schemaVersion: 1, proposalId: `proposal:${canonicalHash(input)}`,
    findingRef, findingHash, findingVersion: source.recordId, issuedAt: now.toISOString(), expiresAt: new Date(expiresAt).toISOString(),
    freshnessPolicyVersion: FINDING_PROOF_POLICY.version, maxAgeSeconds: (expiresAt - now.getTime()) / 1000,
    dependencyBundle: { ...dependency, digest: canonicalHash(dependency) },
    evidenceRefs: desired.evidenceRefs ?? runtimeIds, historicalSourceRefs: desired.historicalSourceRefs ?? [],
    reviewRunId: finding.reviewRunId, reviewRound: finding.reviewRound,
    scopeDigest: proposalScopeDigest(ctx, input.storyId), headHash: currentGitHead(ctx.root), materialHash: currentMaterialHash(ctx.root),
    storyFilesHash: currentStoryFilesHash(ctx.root, 'HEAD', ctx.root), assessedBy: actor.canonicalName,
    proposalSigner: { actorId: actor.canonicalName, authorityDigest, algorithm: 'ed25519',
      keyId: `assessment-proposal-${canonicalHash({ publicKey: signer.publicKey }).slice(0, 24)}`,
      trustRootDigest: canonicalHash({ profile: 'assessment-proposal-trust-root-v1', publicKey: signer.publicKey }) },
  }, signer.privateKey);
  return { proposal, source, authorityDigest };
}
