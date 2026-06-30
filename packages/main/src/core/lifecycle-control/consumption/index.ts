import {
  ARTIFACT_CONSUMER_KINDS,
  PROOF_ADMISSIBILITY_CONTRACT_VERSION,
  PROOF_SURFACE_REGISTRY,
  type ArtifactConsumerKind,
  type ClaimKind,
} from '../../proof-admissibility.js';
import {
  buildProofAdmissibilityDiagnostic,
  resolveProofAdmissibilityPolicy,
} from '../../proof-admissibility-gates.js';
import type { StoryStore } from '../../store.js';
import type {
  AdmissibilityWaterlineReport,
  AdmissibilityWaterlineRow,
} from '../control-status.js';
import { buildStoryControlStatus, buildProjectControlStatus, isReadOnlyControlPlane } from '../global-control-service.js';
import { DEFAULT_CONTROL_PLANE_CAPABILITIES } from '../control-status.js';

export * from '../control-status.js';
export { buildStoryControlStatus, buildProjectControlStatus, isReadOnlyControlPlane, DEFAULT_CONTROL_PLANE_CAPABILITIES };
export type { BuildStoryControlStatusInput, BuildProjectControlStatusInput } from '../global-control-service.js';

const CONSUMER_CLAUSES: Record<ArtifactConsumerKind, readonly string[]> = {
  STORY_INTAKE: ['C1 accepted candidate', 'C2 story binding'],
  PLAN: ['C1 story binding', 'C2 planning review'],
  REVIEW: ['C1 current implementation evidence', 'C2 reviewer-owned proof'],
  TEST: ['C1 current validation evidence', 'C2 current material binding'],
  DONE: ['C1 TEST evidence', 'C3 delivery check', 'C5 summary', 'C7 review escalation', 'C8 done-required policy', 'C10 freshness', 'C11 no production overclaim'],
  DONE_REQUIRED: ['C1 local gate evidence', 'C3 command policy', 'C5 material hash', 'C7 story files hash', 'C8 receipt identity', 'C10 command set hash', 'C11 no local diagnostic'],
  HANDOFF: ['C1 context refs separated', 'C2 proof refs classified'],
  AUTHORITY_GATE_DECISION: ['C1 external gate policy', 'C2 current receipt binding', 'C3 no local release-readiness minting'],
  LEGACY_AUTHORITY_RECEIPT: ['C1 legacy compatibility input only', 'C2 no local release readiness'],
};

function firstSupportedSurface(consumer: ArtifactConsumerKind): { artifactKind: string; claim: ClaimKind } {
  for (const definition of PROOF_SURFACE_REGISTRY) {
    const policy = definition.allowedClaims.find((candidate) => (candidate.consumers as readonly ArtifactConsumerKind[]).includes(consumer));
    if ((definition.allowedConsumers as readonly ArtifactConsumerKind[]).includes(consumer) && policy) {
      return { artifactKind: definition.artifactKind, claim: policy.claim };
    }
  }
  return { artifactKind: 'legacy-evidence', claim: 'diagnostic-status' };
}

function hasConsumerEvidence(store: StoryStore, storyId: string | undefined, consumer: ArtifactConsumerKind): boolean {
  if (!storyId) return false;
  try {
    if (consumer === 'DONE_REQUIRED' || consumer === 'DONE') return store.readDoneRequiredEvidence(storyId) !== null;
    if (consumer === 'TEST') return store.readTestEvidence(storyId) !== null;
    if (consumer === 'REVIEW') return (store.readReviewPasses(storyId).passes ?? []).length > 0;
    if (consumer === 'STORY_INTAKE' || consumer === 'PLAN') return store.readStory(storyId).source !== undefined;
    if (consumer === 'HANDOFF') return store.readStoryCapsule(storyId) !== null;
    if (consumer === 'AUTHORITY_GATE_DECISION') return false;
    if (consumer === 'LEGACY_AUTHORITY_RECEIPT') return false;
  } catch {
    return false;
  }
  return false;
}

function rowStatus(
  overall: 'pass' | 'warn' | 'fail' | 'error',
  reasons: readonly string[],
): AdmissibilityWaterlineRow['status'] {
  if (overall === 'error') return 'error';
  if (reasons.includes('legacy_downgrade')) return 'legacy';
  if (reasons.some((reason) => reason.startsWith('stale_'))) return 'stale';
  if (overall === 'pass') return 'pass';
  if (overall === 'warn') return 'warn';
  return 'fail';
}

function summary(rows: readonly AdmissibilityWaterlineRow[]): AdmissibilityWaterlineReport['summary'] {
  return {
    pass: rows.filter((row) => row.status === 'pass').length,
    warn: rows.filter((row) => row.status === 'warn').length,
    fail: rows.filter((row) => row.status === 'fail').length,
    error: rows.filter((row) => row.status === 'error').length,
    stale: rows.filter((row) => row.status === 'stale').length,
    legacy: rows.filter((row) => row.status === 'legacy').length,
  };
}

export interface AdmissibilityWaterlineOptions {
  readonly storyId?: string;
  readonly consumers?: readonly ArtifactConsumerKind[];
  readonly now?: string;
}

export function projectAdmissibilityWaterline(
  store: StoryStore,
  projectRoot: string,
  options: AdmissibilityWaterlineOptions = {},
): AdmissibilityWaterlineReport {
  const consumers = options.consumers && options.consumers.length > 0
    ? options.consumers
    : ARTIFACT_CONSUMER_KINDS;
  const policy = resolveProofAdmissibilityPolicy(projectRoot);
  const rows = consumers.map((consumer): AdmissibilityWaterlineRow => {
    const surface = firstSupportedSurface(consumer);
    const present = hasConsumerEvidence(store, options.storyId, consumer);
    const diagnostic = buildProofAdmissibilityDiagnostic({
      artifactId: options.storyId ? `${options.storyId}:${consumer}` : consumer,
      artifactKind: surface.artifactKind,
      consumer,
      claim: surface.claim,
      policy,
      checks: {
        strictShapeValid: present,
        semanticDigestValid: present,
        signatureOrReceiptBindingValid: present || consumer === 'STORY_INTAKE' || consumer === 'PLAN',
        temporalAndMaterialBindingValid: present,
        subjectMatches: Boolean(options.storyId),
        storyMatches: Boolean(options.storyId),
        gatePhaseMatches: true,
        commandSpecDigestValid: present || consumer !== 'DONE_REQUIRED',
        hashTupleFresh: present,
        producerBoundaryTrusted: present,
      },
    });
    const status = rowStatus(diagnostic.overall, diagnostic.reasons);
    const requiredClauses = CONSUMER_CLAUSES[consumer];
    const reasons = [
      ...diagnostic.reasons,
    ];
    const missingClauses = status === 'pass' ? [] : reasons.length > 0 ? reasons : ['missing_admissible_evidence'];
    return {
      consumer,
      status,
      requiredClauses,
      matchedClauses: status === 'pass' ? requiredClauses : [],
      missingClauses,
      staleRows: status === 'stale' ? 1 : 0,
      legacyRows: status === 'legacy' ? 1 : 0,
      errorRows: status === 'error' ? 1 : 0,
      failRows: status === 'fail' ? 1 : 0,
      topReasons: missingClauses.slice(0, 3),
      diagnosticOnly: true,
      productionDoneEligible: false,
      source: 'proof-admissibility',
    };
  });

  return {
    schemaVersion: 'lattice.admissibility_waterline.v1',
    readOnly: true,
    diagnosticOnly: true,
    generatedAt: options.now ?? new Date().toISOString(),
    ...(options.storyId ? { storyId: options.storyId } : {}),
    policyId: PROOF_ADMISSIBILITY_CONTRACT_VERSION,
    rows,
    summary: summary(rows),
    note: 'diagnostic-only waterline; lifecycle gates remain authoritative elsewhere',
  };
}
