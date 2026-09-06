/**
 * Finding-owned handler facade for the runtime-evidence adapter.
 *
 * The shared ledger handler remains the single executable implementation so
 * runtime receipts and ledger receipts cannot diverge across entry points.
 */
import type { HandlerContext } from './context.js';
import { createFindingLedgerHandlers } from './finding-ledger.js';

/**
 * The runtime surface is intentionally narrower than the shared ledger
 * implementation.  Keeping the projection here prevents a future registry
 * refactor from accidentally exposing finding_ledger_query through the runtime
 * component boundary.
 */
export function createFindingRuntimeEvidenceHandlers(ctx: HandlerContext) {
  const handlers = createFindingLedgerHandlers(ctx);
  return {
    finding_runtime_evidence_run: handlers.finding_runtime_evidence_run,
    finding_runtime_evidence_verify: handlers.finding_runtime_evidence_verify,
  };
}

export const FINDING_RUNTIME_EVIDENCE_COMMANDS = Object.freeze([
  'finding_runtime_evidence_run',
  'finding_runtime_evidence_verify',
] as const);
