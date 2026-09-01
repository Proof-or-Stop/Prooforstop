/**
 * Finding-owned handler facade for the runtime-evidence adapter.
 *
 * The shared ledger handler remains the single executable implementation so
 * runtime receipts and ledger receipts cannot diverge across entry points.
 */
export { createFindingLedgerHandlers as createFindingRuntimeEvidenceHandlers } from './finding-ledger.js';

export const FINDING_RUNTIME_EVIDENCE_COMMANDS = Object.freeze([
  'finding_runtime_evidence_run',
  'finding_runtime_evidence_verify',
] as const);
