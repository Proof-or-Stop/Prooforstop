import {
  allContextPackRequiredRefs,
  buildTargetBoundEvidenceEnvelope,
  type EvidenceEnvelopeContract,
  type RepoSnapshotContract,
  type VerificationContextPackContract,
  type VerificationTargetContract,
} from './authority-contracts.js';

export interface EvidenceMaterial {
  evidenceId: string;
  projectId: string;
  storyId: string;
  producerActorId: string;
  producerRunId?: string;
  verifierRunId?: string;
  provider?: string;
  model?: string;
  vendor?: string;
  command?: string;
  exitCode?: number;
  commandDigest?: string;
  transcriptHash?: string;
  diffHash?: string;
  note?: string;
  verificationTarget?: VerificationTargetContract;
  verificationContextPack?: VerificationContextPackContract;
  verificationContextPackDigest?: string;
  coveredRefs?: string[];
  inspectedPackRefs?: string[];
  repo?: RepoSnapshotContract;
  nonce: string;
  createdAt: string;
}

export class EvidenceCollector {
  collect(material: EvidenceMaterial): EvidenceEnvelopeContract {
    const packRefs = material.verificationContextPack
      ? allContextPackRequiredRefs(material.verificationContextPack)
      : [];
    return buildTargetBoundEvidenceEnvelope({
      ...material,
      coveredRefs: [...(material.coveredRefs ?? []), ...packRefs],
      inspectedPackRefs: material.inspectedPackRefs ?? packRefs,
    });
  }
}
