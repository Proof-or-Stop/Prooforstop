import type { EvidenceScope } from './proof-admissibility.js';

export type LegacyProofClassification = 'legacy-observed' | 'legacy-local-only' | 'legacy-unknown-producer';

export interface LegacyProofDiagnostic {
  classification: LegacyProofClassification;
  scope: EvidenceScope;
  strongProof: false;
  reasons: string[];
  remediation: string;
}

export function classifyLegacyProofEvidence(value: unknown): LegacyProofDiagnostic {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const schema = typeof record.schema === 'string' ? record.schema : undefined;
  const schemaVersion = typeof record.schemaVersion === 'string' ? record.schemaVersion : undefined;
  const producer = typeof record.producer === 'string' ? record.producer : undefined;
  const receiptVerified = record.receiptVerified === true;
  const localMarkers = record.productionDone === false || record.authorityDone === false || record.fullAuthorityDone === false;

  if (!schema && !schemaVersion) {
    return {
      classification: 'legacy-observed',
      scope: 'legacy-observed',
      strongProof: false,
      reasons: ['missing current schemaVersion'],
      remediation: 'Keep as audit-readable legacy evidence or regenerate under the current proof admissibility contract.',
    };
  }
  if (!receiptVerified && (localMarkers || /local|diagnostic|cli/i.test(producer ?? ''))) {
    return {
      classification: 'legacy-local-only',
      scope: 'legacy-local-only',
      strongProof: false,
      reasons: ['local-only or diagnostic legacy producer'],
      remediation: 'Use as local diagnostic context only; it cannot satisfy an Authority or production gate.',
    };
  }
  return {
    classification: 'legacy-unknown-producer',
    scope: 'legacy-unknown-producer',
    strongProof: false,
    reasons: ['producer boundary predates current contract or is unknown'],
    remediation: 'Run a dry-run migration diagnostic and regenerate proof if a strong gate needs it.',
  };
}
