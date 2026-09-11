/** Narrow unrelated-material release. Old observations remain immutable; fresh
 * same-command executions and independent current review are mandatory. */
import { execFileSync } from 'node:child_process';
import type { HandlerContext } from './context.js';
import type { JsonValue } from '../core/finding-ledger.js';
import { applicabilityDigest, verifyApplicabilityAssessment, verifyDynamicFindingRecord, type FindingApplicabilityAssessment } from '../core/finding-applicability.js';
import { currentApplicabilityContext, repairClosureContext } from '../core/finding-applicability-projection.js';
import { isMaterialExcludedPath } from '../core/evidence-freshness.js';
import { identityTrust, readCanonicalCatalog, verifiedIdentityCarrier } from './finding-identity-store.js';
import { exactLedgerRecordHash, readCurrentFindingRuntimeEvidence, readHistoricalFindingRuntimeEvidence, readMaterialBoundReattestationRuntimeEvidence } from './finding-ledger.js';
import { readFindingRouteDependencyTuple, proposalFindingHash, proposalAuthorityDigest } from './finding-route.js';
import { FINDING_PROOF_POLICY } from './finding-applicability-proof.js';
import { readBrandEnv } from '../core/brand-env.js';
import { resolveRegisteredAgentActor } from '../core/agent-dispatch-registry.js';
import { collectReviewerEvidenceState } from '../core/review-run.js';

function processDependencies(ctx: HandlerContext) {
  const entries = execFileSync('git', ['ls-tree', '-rz', 'HEAD'], { cwd: ctx.root, encoding: 'utf8' }).split('\0').filter(Boolean);
  // Closed exception: only audit narrative can be unrelated under this policy.
  // Unknown extensions, extensionless files, assets and symlinks stay protected.
  // Fresh identical built artifacts/witnesses and independent review are still
  // required; this exception alone never supplies gate authority.
  const protectedRows = entries.filter(row => {
    const path = row.slice(row.indexOf('\t') + 1);
    if (isMaterialExcludedPath(path, ctx.root)) return false;
    return !/^100644 blob /.test(row) || !/^docs\/audits\/[a-zA-Z0-9._/-]+\.md$/.test(path)
      || /(^|\/)(?:AGENTS|CLAUDE|SKILL)\.md$/.test(path);
  });
  return applicabilityDigest({ protectedRows, proofPolicy: FINDING_PROOF_POLICY });
}

export function findingMaterialDependencySnapshot(ctx: HandlerContext, storyId: string, assessment: FindingApplicabilityAssessment) {
  const ref = assessment.proposalRef; const route = assessment.acceptedRoute;
  if (!ref || !route?.receiptRecordId || !route.receiptRecordHash) throw new Error('reattestation: exact proposal/route dependency required');
  const ledger = ctx.store.readFindingLedger<JsonValue>(storyId);
  const proposal = verifiedIdentityCarrier(ledger, storyId, ref.recordId, identityTrust(ctx)).record.payload as Record<string, unknown>;
  const findingRef = proposal.findingRef as { storyId: string; findingId: string; recordId: string };
  const findingRecord = ledger.records.find(row => row.recordId === findingRef.recordId);
  if (!findingRecord) throw new Error('reattestation: source observation missing');
  return { processPolicyDigest: processDependencies(ctx),
    reviewerAuthorityDigest: proposalAuthorityDigest(String(proposal.assessedBy)),
    findingHash: proposalFindingHash(ctx, { ...findingRef, recordHash: exactLedgerRecordHash(findingRecord) }),
    canonicalDigest: applicabilityDigest(readCanonicalCatalog(ctx).input),
    routeDigest: applicabilityDigest(readFindingRouteDependencyTuple(ctx, { storyId: route.ownerStoryId,
      recordId: route.receiptRecordId, recordHash: route.receiptRecordHash })) };
}

function checkedReexecution(ctx: HandlerContext, storyId: string, oldIds: string[], currentIds: string[], reuse = false) {
  if (!oldIds.length || oldIds.length !== currentIds.length || new Set(currentIds).size !== currentIds.length) throw new Error('reattestation: exact runtime mapping required');
  return oldIds.map((id, index) => {
    const old = readHistoricalFindingRuntimeEvidence(ctx, storyId, id);
    const current = (reuse ? readMaterialBoundReattestationRuntimeEvidence : readCurrentFindingRuntimeEvidence)(ctx, storyId, currentIds[index]!);
    const semantics = (stdout: string) => {
      const lines = stdout.split(/\r?\n/).filter(line => line.startsWith('FINDING_WITNESS '));
      if (lines.length !== 1) throw new Error('reattestation: structured witness missing');
      const { headHash: _head, baseHash: _base, ...body } = JSON.parse(lines[0]!.slice('FINDING_WITNESS '.length));
      return body;
    };
    const artifacts = (receipt: typeof old.receipt) => receipt.artifacts.map(({ sourceHead: _head, ...artifact }) => artifact);
    if (id === currentIds[index] || old.receipt.exitCode !== current.receipt.exitCode || current.receipt.exitCode === 0
      || old.receipt.executionCommandDigest !== current.receipt.executionCommandDigest || old.receipt.buildCommandDigest !== current.receipt.buildCommandDigest
      || old.receipt.environmentDigest !== current.receipt.environmentDigest || old.receipt.buildPolicyDigest !== current.receipt.buildPolicyDigest
      || applicabilityDigest(old.receipt.toolchain) !== applicabilityDigest(current.receipt.toolchain)
      || applicabilityDigest(artifacts(old.receipt)) !== applicabilityDigest(artifacts(current.receipt))
      || applicabilityDigest(semantics(old.stdout)) !== applicabilityDigest(semantics(current.stdout))) throw new Error('reattestation: runtime dependency changed or unknown');
    return { priorId: id, priorHash: old.receipt.receiptHash, currentId: current.receipt.receiptId, currentHash: current.receipt.receiptHash };
  });
}

export function prepareMaterialDriftReattestation(ctx: HandlerContext, input: { storyId: string; assessmentId: string; runtimeReceiptIds: string[] }) {
  const actor = resolveRegisteredAgentActor(readBrandEnv('AGENT'));
  if (!actor?.reviewerLane || ctx.store.readStory(input.storyId).phase !== 'REVIEW') throw new Error('reattestation: current independent reviewer required');
  const ledger = ctx.store.readFindingLedger<JsonValue>(input.storyId); const trust = identityTrust(ctx);
  const row = ledger.records.find(row => row.recordType === 'finding_applicability_assessment'
    && (row.payload as unknown as FindingApplicabilityAssessment).assessmentId === input.assessmentId);
  if (!row) throw new Error('reattestation: assessment missing');
  verifiedIdentityCarrier(ledger, input.storyId, row.recordId, trust);
  const assessment = row.payload as unknown as FindingApplicabilityAssessment;
  const finding = ctx.store.readFindings(input.storyId).findings.find(item => item.id === assessment.findingId);
  if (!finding || finding.agent === actor.canonicalName) throw new Error('reattestation: source observer cannot self-adjudicate');
  const latest = [...ledger.records].reverse().find(item => item.recordType === 'finding_applicability_assessment'
    && (item.payload as unknown as FindingApplicabilityAssessment).findingId === assessment.findingId);
  if (latest?.recordId !== row.recordId) throw new Error('reattestation: latest assessment required');
  if (!verifyApplicabilityAssessment(assessment, trust.publicKey) || assessment.dispositionPlan !== 'defer_with_proof'
    || assessment.verdict !== 'applicable' || !assessment.dependencySnapshot || !assessment.runtimeReceiptIds) throw new Error('reattestation: eligible signed dependency baseline required');
  const current = currentApplicabilityContext(ctx.store, ctx.root, input.storyId, assessment.runtimeReceiptIds);
  const old = assessment.integrity;
  if (old.materialHash === current.materialHash || old.storyFilesHash !== current.storyFilesHash || old.scopeDigest !== current.scopeDigest
    || old.acceptanceDigest !== current.acceptanceDigest || old.runtimeReceiptDigest !== current.runtimeReceiptDigest
    || !old.expiresAt || Date.parse(old.expiresAt) <= Date.now()) throw new Error('reattestation: not an isolated current material drift');
  const dependencies = findingMaterialDependencySnapshot(ctx, input.storyId, assessment);
  if (applicabilityDigest(dependencies) !== applicabilityDigest(assessment.dependencySnapshot)) throw new Error('reattestation: process/route/canonical dependency changed');
  const runtime = checkedReexecution(ctx, input.storyId, assessment.runtimeReceiptIds, input.runtimeReceiptIds);
  const claim = [...ledger.records].reverse().find(row => row.recordType === 'finding_deferral_disposition'
    && (row.payload as Record<string, unknown>).assessmentId === assessment.assessmentId);
  if (!claim || Date.parse(String((claim.payload as Record<string, unknown>).expiresAt)) <= Date.now()
    || !verifyDynamicFindingRecord(claim.payload as Record<string, unknown>, trust.publicKey)) throw new Error('reattestation: exact live signed historical deferral required');
  const marker = `finding-reattest:${assessment.assessmentId}:${applicabilityDigest(runtime)}`;
  const reviewer = collectReviewerEvidenceState(ctx.store, input.storyId, ctx.root).valid.find(row => row.kind === 'pass'
    && row.agent === actor.canonicalName && row.pass?.note?.split(/\r?\n/).includes(marker));
  if (!reviewer) throw new Error(`reattestation: current signed independent PASS must bind ${marker}`);
  return { assessmentRecord: row, claim, record: { schemaVersion: 1, action: 'unrelated_material_reattestation',
    storyId: input.storyId, findingId: assessment.findingId, assessmentId: assessment.assessmentId, proposalRecordId: assessment.proposalRef!.recordId,
    assessmentRecordId: row.recordId, assessmentRecordHash: exactLedgerRecordHash(row), claimRecordId: claim.recordId, claimRecordHash: exactLedgerRecordHash(claim),
    priorMaterialHash: old.materialHash, currentBinding: current, dependencies, runtime, actor: actor.canonicalName,
    reviewRunId: reviewer.reviewRunId, reviewPassId: reviewer.pass!.id, reviewPassDigest: applicabilityDigest(reviewer.pass),
    issuedAt: new Date().toISOString(), expiresAt: old.expiresAt } };
}

/** Used by both the gate and source-route verifier. No stored 'fresh' bit. */
export function readMaterialDriftReattestation(ctx: HandlerContext, storyId: string, proposalRecordId: string) {
  const ledger = ctx.store.readFindingLedger<JsonValue>(storyId); const trust = identityTrust(ctx);
  const row = [...ledger.records].reverse().find(row => row.recordType === 'material_drift_reattestation'
    && (row.payload as Record<string, unknown>).action === 'unrelated_material_reattestation'
    && (row.payload as Record<string, unknown>).proposalRecordId === proposalRecordId);
  if (!row) return undefined;
  verifiedIdentityCarrier(ledger, storyId, row.recordId, trust);
  const record = row.payload as unknown as ReturnType<typeof prepareMaterialDriftReattestation>['record'] & Record<string, unknown>;
  if (!verifyDynamicFindingRecord(record, trust.publicKey) || record.storyId !== storyId || Date.parse(record.expiresAt) <= Date.now()) throw new Error('reattestation: invalid/expired signature');
  const source = verifiedIdentityCarrier(ledger, storyId, record.assessmentRecordId, trust).record;
  const claim = verifiedIdentityCarrier(ledger, storyId, record.claimRecordId, trust).record;
  const assessment = source.payload as unknown as FindingApplicabilityAssessment;
  const latest = [...ledger.records].reverse().find(item => item.recordType === 'finding_applicability_assessment'
    && (item.payload as unknown as FindingApplicabilityAssessment).findingId === assessment.findingId);
  const observer = ctx.store.readFindings(storyId).findings.find(item => item.id === assessment.findingId);
  if (latest?.recordId !== source.recordId || !observer || observer.agent === record.actor) throw new Error('reattestation: superseded assessment or non-independent actor');
  if (exactLedgerRecordHash(source) !== record.assessmentRecordHash || exactLedgerRecordHash(claim) !== record.claimRecordHash
    || assessment.proposalRef?.recordId !== proposalRecordId || assessment.findingId !== record.findingId
    || !verifyApplicabilityAssessment(assessment, trust.publicKey)) throw new Error('reattestation: wrong subject or substituted predecessor');
  const current = currentApplicabilityContext(ctx.store, ctx.root, storyId, assessment.runtimeReceiptIds);
  if (applicabilityDigest(repairClosureContext(current)) !== applicabilityDigest(repairClosureContext(record.currentBinding))
    || current.storyFilesHash !== assessment.integrity.storyFilesHash || record.priorMaterialHash !== assessment.integrity.materialHash
    || applicabilityDigest(findingMaterialDependencySnapshot(ctx, storyId, assessment)) !== applicabilityDigest(record.dependencies)
    || applicabilityDigest(record.dependencies) !== applicabilityDigest(assessment.dependencySnapshot)
    || applicabilityDigest(checkedReexecution(ctx, storyId, record.runtime.map(row => row.priorId), record.runtime.map(row => row.currentId), true)) !== applicabilityDigest(record.runtime)) {
    throw new Error('reattestation: current dependencies drifted');
  }
  const reviewer = collectReviewerEvidenceState(ctx.store, storyId, ctx.root).valid.find(row => row.kind === 'pass'
    && row.reviewRunId === record.reviewRunId && row.pass?.id === record.reviewPassId && row.agent === record.actor);
  if (!reviewer || applicabilityDigest(reviewer.pass) !== record.reviewPassDigest) throw new Error('reattestation: reviewer authority stale');
  return { record, current, assessment, runtimeReceiptIds: record.runtime.map(row => row.currentId), materialDriftState: 'unrelated_re_attested' as const };
}
