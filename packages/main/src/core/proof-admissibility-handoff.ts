import {
  buildProofAdmissibilityDiagnostic,
  proofAdmissibilityBlockingReason,
  type ProofAdmissibilityDiagnostic,
  type ProofAdmissibilityMode,
} from './proof-admissibility-gates.js';

export interface HandoffAdmissibilitySummary {
  schemaVersion: 'lattice.handoff_admissibility_summary.v1';
  hostIdentity: {
    fromHost: string;
    toHost: string;
    quorumIdentity?: string;
  };
  context: string[];
  evidenceCandidate: string[];
  diagnosticReceipt: string[];
  admissibleProofRef: string[];
  receiptVerified: false;
  authorityDone: false;
  fullAuthorityDone: false;
  productionDone: false;
  blocked: boolean;
  reasons: string[];
  diagnostics: ProofAdmissibilityDiagnostic[];
}

export function buildHandoffAdmissibilitySummary(args: {
  fromHost: string;
  toHost: string;
  evidenceRefs?: readonly string[];
  receiptRefs?: readonly string[];
  admissibleProofRefs?: readonly string[];
  quorumIdentity?: string;
  mode?: ProofAdmissibilityMode;
}): HandoffAdmissibilitySummary {
  const evidenceCandidate = [...new Set(args.evidenceRefs ?? [])].sort();
  const diagnosticReceipt = [...new Set(args.receiptRefs ?? [])].sort();
  const admissibleProofRef = [...new Set(args.admissibleProofRefs ?? [])].sort();
  const mode = args.mode ?? 'warn';
  const diagnostics = [
    buildProofAdmissibilityDiagnostic({
      artifactKind: 'handoff-pack',
      artifactId: `${args.fromHost}->${args.toHost}`,
      consumer: 'HANDOFF',
      claim: 'diagnostic-status',
      mode,
      checks: {
        schemaVersion: 'lattice.handoff.v1',
        strictShapeValid: true,
        semanticDigestValid: true,
        subjectMatches: true,
        producerBoundaryTrusted: true,
      },
    }),
    ...admissibleProofRef.map(ref => buildProofAdmissibilityDiagnostic({
      artifactKind: 'legacy-authority-receipt-ref',
      artifactId: ref,
      consumer: 'HANDOFF',
      claim: 'production-completion',
      mode,
      checks: {
        schemaVersion: 'lattice.legacy_authority_receipt_refs.v1',
        strictShapeValid: true,
        semanticDigestValid: true,
        signatureOrReceiptBindingValid: false,
        temporalAndMaterialBindingValid: true,
        subjectMatches: true,
        producerBoundaryTrusted: true,
      },
    })),
  ];
  const reasons = diagnostics
    .map(proofAdmissibilityBlockingReason)
    .filter((reason): reason is string => Boolean(reason));
  return {
    schemaVersion: 'lattice.handoff_admissibility_summary.v1',
    hostIdentity: {
      fromHost: args.fromHost,
      toHost: args.toHost,
      ...(args.quorumIdentity ? { quorumIdentity: args.quorumIdentity } : {}),
    },
    context: ['handoff-pack', 'recovery-point', 'capability-deltas'],
    evidenceCandidate,
    diagnosticReceipt,
    admissibleProofRef,
    receiptVerified: false,
    authorityDone: false,
    fullAuthorityDone: false,
    productionDone: false,
    blocked: reasons.length > 0,
    reasons,
    diagnostics,
  };
}
