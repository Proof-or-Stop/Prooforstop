/** Story 1 verification adapter. Only this reader derives evidenceVerification. */
import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { HandlerContext } from './context.js';
import type { Finding } from '../core/types.js';
import { canonicalHash } from '../core/finding-ledger.js';
import { FINDING_PROTECTED_SURFACES, applicabilityDigest, type ApplicabilityProofProjection,
  type FindingApplicabilityAssessment, type FindingEvaluationScope } from '../core/finding-applicability.js';
import { sourceRouteRecord } from './finding-route.js';
import { readCurrentFindingRuntimeEvidence, readMaterialBoundReattestationRuntimeEvidence } from './finding-ledger.js';
import { reviewInventoryAcceptanceSubjectDigestForStore } from '../core/review-inventory-epoch.js';
import { readCanonicalCatalog } from './finding-identity-store.js';
import { canonicalCurrent } from '../core/finding-history.js';
import { readFindingBaseHeadPair } from './finding-runtime-pair.js';
import { readMaterialDriftReattestation } from './finding-material-reattestation.js';

export const FINDING_PROOF_POLICY = Object.freeze({ version: 'finding-applicability-proof-v1',
  witnessSchema: 'proof-or-stop.finding-witness.v1', protectedSurfaces: FINDING_PROTECTED_SURFACES,
  freshness: 'exact-proposal-source-and-runtime', scopeExpansion: 'never-authorized-by-finding' });

export interface FindingWitness {
  schemaVersion: typeof FINDING_PROOF_POLICY.witnessSchema;
  storyId: string; findingId: string; baseHash: string; headHash: string;
  scopeDigest: string; acceptanceDigest: string; evaluationScope: FindingEvaluationScope;
  verdict: string; reproduced: boolean; baseReproduced: boolean | null;
  introducedByCurrentStory: boolean; gateImpact: 'blocks' | 'does_not_block' | 'unknown';
  affectedPaths: string[]; checkedIntentRefs: string[];
  protectedSurfaceEvaluation: NonNullable<FindingApplicabilityAssessment['protectedSurfaceEvaluation']>;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(row => typeof row === 'string' && row.trim().length > 0)
    && new Set(value).size === value.length;
}
export function findingWitnessCommandText(command: { executable: string; args?: string[] }): string {
  return [command.executable, ...(command.args ?? [])].map(value => /^[\w./:@=-]+$/.test(value) ? value : JSON.stringify(value)).join(' ');
}

/** Executable witnesses must belong to reviewed, pinned acceptance, not echo/user strings. */
export function verifyFindingWitness(witness: FindingWitness, args: {
  storyId: string; finding: Finding; baseHash: string; headHash: string; scopeDigest: string; acceptanceDigest: string;
  evaluationScope: FindingEvaluationScope; intentRefs: string[]; changedPaths: string[];
  baseHeadPairDigest?: string;
}): void {
  const { finding } = args;
  if (!witness || witness.schemaVersion !== FINDING_PROOF_POLICY.witnessSchema || witness.storyId !== args.storyId
    || witness.findingId !== finding.id || witness.baseHash !== args.baseHash || witness.headHash !== args.headHash
    || witness.scopeDigest !== args.scopeDigest || witness.acceptanceDigest !== args.acceptanceDigest
    || witness.evaluationScope !== args.evaluationScope) throw new Error('dynamic finding: witness subject/scope/hash mismatch');
  if (!strings(witness.affectedPaths) || !witness.affectedPaths.length
    || witness.affectedPaths.some(path => isAbsolute(path) || path.split(/[\\/]/).includes('..'))
    || !strings(witness.checkedIntentRefs) || !args.intentRefs.every(ref => witness.checkedIntentRefs.includes(ref))
    || witness.checkedIntentRefs.some(ref => !args.intentRefs.includes(ref))) throw new Error('dynamic finding: incomplete path/acceptance inspection');
  if (typeof witness.reproduced !== 'boolean' || typeof witness.introducedByCurrentStory !== 'boolean'
    || ![true, false, null].includes(witness.baseReproduced)
    || !['blocks', 'does_not_block', 'unknown'].includes(witness.gateImpact)) throw new Error('dynamic finding: incomplete witness verdict');
  const surfaces = witness.protectedSurfaceEvaluation;
  if (!Array.isArray(surfaces) || surfaces.length !== FINDING_PROTECTED_SURFACES.length
    || !FINDING_PROTECTED_SURFACES.every(surface => surfaces.filter(row => row.surface === surface
      && ['clear', 'known_risk', 'unknown'].includes(row.state) && strings(row.evidenceRefs) && row.evidenceRefs.length).length === 1)) {
    throw new Error('dynamic finding: complete protected-surface evidence required');
  }
  if ((finding.files ?? []).some(path => !witness.affectedPaths.includes(path))
    || surfaces.some(row => row.evidenceRefs.some(ref => !args.intentRefs.includes(ref)))) {
    throw new Error('dynamic finding: witness omits original Finding paths or cites unreviewed surface evidence');
  }
  if (['pre_existing_unaffected', 'out_of_scope'].includes(witness.verdict)) {
    if (witness.introducedByCurrentStory || witness.gateImpact !== 'does_not_block'
      || witness.affectedPaths.some(path => args.changedPaths.includes(path))) throw new Error('dynamic finding: current diff impact cannot be called unaffected');
    if (witness.verdict === 'pre_existing_unaffected' && (!witness.reproduced || witness.baseReproduced !== true)) {
      throw new Error('dynamic finding: exact base/head reproduction required');
    }
    if (witness.verdict === 'pre_existing_unaffected' && !/^[a-f0-9]{64}$/.test(args.baseHeadPairDigest ?? '')) throw new Error('dynamic finding: verified base/head runtime pair required');
  }
  if (['disproven', 'not_reproduced_under_current_witness'].includes(witness.verdict) && witness.reproduced) throw new Error('dynamic finding: negative witness reproduced');
  if (['applicable', 'introduced', 'worsened'].includes(witness.verdict) && !witness.reproduced) throw new Error('dynamic finding: applicable witness must reproduce');
}

export function readApplicabilityProof(ctx: HandlerContext, storyId: string, finding: Finding,
  assessment: Pick<FindingApplicabilityAssessment, 'proposalRef' | 'verdict' | 'dispositionPlan' | 'gateImpact' | 'evaluationScope'>,
  requireCurrentReviewerEvidence = true) {
  const ref = assessment.proposalRef;
  if (!ref || ref.storyId !== storyId || ref.subjectKind !== 'finding_assessment_proposal') throw new Error('dynamic finding: exact receipted assessment proposal required');
  const { bound, proposal } = sourceRouteRecord(ctx, ref, requireCurrentReviewerEvidence);
  const restored = !requireCurrentReviewerEvidence ? readMaterialDriftReattestation(ctx, storyId, ref.recordId) : undefined;
  if (!proposal || (proposal.findingRef as { findingId?: string }).findingId !== finding.id) throw new Error('dynamic finding: proposal belongs to another Finding');
  if ((proposal.dependencyBundle as { proofPolicyDigest?: string }).proofPolicyDigest !== canonicalHash(FINDING_PROOF_POLICY)) {
    throw new Error('dynamic finding: proposal proof policy is stale');
  }
  const evaluationScope = assessment.evaluationScope ?? 'target_story';
  const verdict = proposal.verdict === 'applicable' && proposal.basis === 'introduced_by_diff' ? 'introduced'
    : proposal.verdict === 'applicable' && proposal.basis === 'worsened_by_diff' ? 'worsened' : proposal.verdict;
  if (verdict !== assessment.verdict || proposal.evaluationScope !== evaluationScope) throw new Error('dynamic finding: final verdict/scope diverges from immutable proposal');
  const runtimeIds = proposal.runtimeReceiptIds;
  if (!strings(runtimeIds) || runtimeIds.length === 0) throw new Error('dynamic finding: runtime witness references required');
  const checklist = ctx.store.readChecklist(storyId);
  const intents = checklist.items.flatMap(item => Object.entries(item.verificationIntent ?? {}).flatMap(([lane, rows]) =>
    Array.isArray(rows) ? rows.map((row, index) => ({ ref: `${item.id}:${lane}:${index}`, command: row.verification?.command, selector: row.verification?.selector })) : []));
  const baseHash = restored?.record.currentBinding.baseHash ?? execFileSync('git', ['merge-base', 'main', 'HEAD'], { cwd: ctx.root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const changedPaths = execFileSync('git', ['diff', '--name-only', baseHash, '--'], { cwd: ctx.root, encoding: 'utf8', stdio: 'pipe' }).trim().split('\n').filter(Boolean);
  const scopeDigest = reviewInventoryAcceptanceSubjectDigestForStore(ctx.store, storyId);
  const acceptanceDigest = applicabilityDigest(checklist);
  const pair = verdict === 'pre_existing_unaffected' ? readFindingBaseHeadPair(ctx, storyId, runtimeIds, baseHash, String(proposal.headHash)) : undefined;
  const runtime = pair ? [pair.head] : (restored?.runtimeReceiptIds ?? runtimeIds).map(id =>
    (restored ? readMaterialBoundReattestationRuntimeEvidence : readCurrentFindingRuntimeEvidence)(ctx, storyId, id));
  if (pair) {
    const command = findingWitnessCommandText(pair.head.executionCommand);
    if (!intents.some(intent => intent.command === command && typeof intent.selector === 'string'
      && intent.selector.length > 0 && pair.base.stdout.includes(intent.selector))) throw new Error('dynamic finding: base receipt misses reviewed selector');
    verifyFindingWitness(pair.before, { storyId, finding, baseHash: pair.before.baseHash, headHash: baseHash, scopeDigest,
      acceptanceDigest, evaluationScope, intentRefs: intents.map(row => row.ref), changedPaths: [], baseHeadPairDigest: pair.digest });
  }
  const commands = runtime.map(row => findingWitnessCommandText(row.executionCommand));
  if (commands.some(command => !intents.some(intent => intent.command === command))) throw new Error('dynamic finding: witness command is not a reviewed verification intent');
  const witnesses = runtime.map(row => {
    if (!intents.some(intent => intent.command === findingWitnessCommandText(row.executionCommand)
      && typeof intent.selector === 'string' && intent.selector.length > 0 && row.stdout.includes(intent.selector))) {
      throw new Error('dynamic finding: executed witness does not satisfy the reviewed selector');
    }
    const lines = row.stdout.split(/\r?\n/).filter(line => line.startsWith('FINDING_WITNESS '));
    if (lines.length !== 1) throw new Error('dynamic finding: one structured runtime witness required');
    const witness = JSON.parse(lines[0]!.slice('FINDING_WITNESS '.length)) as FindingWitness;
    verifyFindingWitness(witness, { storyId, finding, baseHash, headHash: restored?.record.currentBinding.headHash ?? String(proposal.headHash), scopeDigest, acceptanceDigest,
      evaluationScope, intentRefs: intents.map(row => row.ref), changedPaths, baseHeadPairDigest: pair?.digest });
    if (witness.verdict !== verdict || canonicalHash(witness.protectedSurfaceEvaluation) !== canonicalHash(proposal.protectedSurfaceEvaluation)) {
      throw new Error('dynamic finding: proposal and executed witness disagree');
    }
    if (witness.reproduced !== (row.receipt.exitCode !== 0)) throw new Error('dynamic finding: reproduction claim contradicts execution exit');
    if (witness.gateImpact !== (assessment.gateImpact ?? 'unknown')) throw new Error('dynamic finding: gate impact differs from executed witness');
    return witness;
  });
  if (new Set(witnesses.map(canonicalHash)).size !== 1) throw new Error('dynamic finding: conflicting witnesses require reassessment');
  const witness = witnesses[0]!;
  const exactRuntimeRefs = (value: unknown) => strings(value) && canonicalHash([...value].sort()) === canonicalHash([...runtimeIds].sort());
  if (proposal.verdict === 'applicable' && !exactRuntimeRefs((proposal.currentWitness as { receiptIds: unknown }).receiptIds)) throw new Error('dynamic finding: applicable runtime tuple mismatch');
  if (verdict === 'pre_existing_unaffected') {
    const binding = proposal.baseHead as { baseRef: string; headRef: string; receiptIds: string[]; baseReceiptId: string; headReceiptId: string; pairDigest: string };
    if (binding.baseRef !== baseHash || binding.headRef !== proposal.headHash || canonicalHash(binding.receiptIds) !== canonicalHash(runtimeIds)
      || binding.baseReceiptId !== runtimeIds[0] || binding.headReceiptId !== runtimeIds[1] || binding.pairDigest !== pair!.digest) throw new Error('dynamic finding: base/head witness tuple mismatch');
  }
  if (verdict === 'not_reproduced_under_current_witness' || verdict === 'disproven') {
    const negative = proposal.currentWitness as Record<string, unknown>;
    if (!exactRuntimeRefs(negative.receiptIds) || negative.commandPolicyDigest !== canonicalHash({ policy: FINDING_PROOF_POLICY, commands })
      || negative.runtimeEvidenceDigest !== applicabilityDigest(runtime.map(row => ({ id: row.receipt.receiptId, hash: row.receipt.receiptHash })))
      || negative.negativeWitnessDigest !== canonicalHash(witness)) throw new Error('dynamic finding: negative witness policy/runtime/report binding mismatch');
  }
  if (verdict === 'duplicate') {
    const catalog = readCanonicalCatalog(ctx); const expected = proposal.canonicalDefectRef as Record<string, unknown>;
    const canonical = catalog.rows.find(row => row.envelope.payload.canonicalDefectId === expected.canonicalDefectId);
    if (!canonical || canonicalCurrent(catalog.input, canonical.record.recordId).superseded
      || canonical.envelope.payload.identityDigest !== expected.identityDigest
      || canonical.envelope.payload.canonicalFindingRef.storyId !== expected.canonicalOwner
      || canonicalHash({ storyId: canonical.envelope.payload.canonicalFindingRef.storyId,
        findingId: canonical.envelope.payload.canonicalFindingRef.findingId, recordId: canonical.envelope.payload.canonicalFindingRef.recordId,
        hash: canonical.envelope.payload.canonicalFindingRef.recordHash }) !== canonicalHash(expected.currentCanonicalFinding)) throw new Error('dynamic finding: canonical duplicate tuple is not current');
  }
  if (assessment.dispositionPlan === 'defer_with_proof' && (witness.introducedByCurrentStory
    || witness.gateImpact !== 'does_not_block' || witness.protectedSurfaceEvaluation.some(row => row.state !== 'clear')
    || witness.affectedPaths.some(path => changedPaths.includes(path)))) throw new Error('dynamic finding: regression/protected/acceptance risk cannot be deferred');
  if (verdict === 'out_of_scope') {
    const scope = ctx.store.readScopeContract(storyId);
    if (!scope || proposal.excludedScopeProofDigest !== canonicalHash(scope)
      || !witness.affectedPaths.every(path => scope.explicitExcludes.includes(path))) throw new Error('dynamic finding: exact excluded-scope contract required');
  }
  const proof: ApplicabilityProofProjection = { state: 'verified', proposalDigest: ref.subjectHash,
    evidenceDigest: applicabilityDigest((pair ? [pair.base, pair.head] : runtime).map(row => ({ id: row.receipt.receiptId, hash: row.receipt.receiptHash }))), evaluationScope,
    ...(pair ? { baseHeadPairDigest: pair.digest } : {}),
    introducedByCurrentStory: witness.introducedByCurrentStory, acceptanceImpact: witness.gateImpact,
    requiredCommands: [...new Set(commands)].sort(), affectedPaths: witness.affectedPaths };
  return { proposal, proposalRecord: bound.record, proof, witness, runtimeIds };
}
