/**
 * Stable public surface for Dynamic Finding runtime evidence.
 *
 * The implementation remains in runtime-evidence-receipt so existing imports
 * keep working; this facade gives Finding consumers a component-owned entry
 * point without duplicating signing, execution, or freshness logic.
 */
export * from './runtime-evidence-receipt.js';

export const FINDING_RUNTIME_EVIDENCE_ADAPTER_CONTRACT = Object.freeze({
  runCommand: 'finding_runtime_evidence_run',
  verifyCommand: 'finding_runtime_evidence_verify',
  appendOperation: 'append_runtime_receipt',
  artifactRealpathBinding: 'realpathPolicyDigest',
} as const);
