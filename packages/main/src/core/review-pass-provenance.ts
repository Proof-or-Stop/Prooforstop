/**
 * review-pass-provenance — writer-session provenance for review_pass_set (B-3b05 CHK-002).
 *
 * Pure function module: resolve the provenance mode from config and compare the
 * writing session identity against the story owner lease session.
 *
 * Decision of record (B-3b05 decision.json, chosen `B-record-plus-warn-default-enforce-optin`):
 *   - warn mode is the DEFAULT and the hardcoded fallback for absent/invalid config.
 *     A same-session write persists `provenanceFlag: "same_session_write"` plus a
 *     stderr warning naming BOTH session ids with neutral wording — a same-session
 *     write means subagent-or-self, which are NOT mechanically distinguishable
 *     (EXP-001 under B-e71f).
 *   - enforce mode is opt-in via `reviewPassProvenance.mode: "enforce"` in
 *     lattice.config.json (same in-file gate-mode section pattern as
 *     proofAdmissibility / reproFirstPreflight / candidateSpecRouting) for hosts
 *     with genuine per-thread session separation (e.g. Codex multi-thread). It
 *     rejects the write with an error naming both ids; nothing is persisted.
 *   - No lease → record identity only, nothing to compare against.
 *
 * This is a coordination-level deterrent plus a durable per-session audit trail,
 * NOT cryptographic reviewer identity: lease sessionIds are forgeable in principle
 * (an explicit-env writer is a coordination-level claim, visible via sessionSource).
 * The flag is AUDIT-ONLY — no blocking gate (canPassReviewGuard included) reads it.
 */

import { normalizeSessionSource, type SessionIdentity } from './owner-session.js';

export type ReviewPassProvenanceMode = 'warn' | 'enforce';

/** Hardcoded fallback (decision.json preMortem 1 mitigation): default is ALWAYS warn. */
export const REVIEW_PASS_PROVENANCE_DEFAULT_MODE: ReviewPassProvenanceMode = 'warn';

export const SAME_SESSION_WRITE_FLAG = 'same_session_write' as const;
export type ReviewPassProvenanceFlag = typeof SAME_SESSION_WRITE_FLAG;

/**
 * Resolve the provenance mode from the raw `reviewPassProvenance` config section.
 *
 * Failure policy (mirrors resolveAuditConfig): absent section / absent mode →
 * silent default warn; present-but-invalid section or mode → warn() message +
 * fallback to warn. This function NEVER throws and NEVER returns anything but
 * 'warn' | 'enforce' — a config typo must not hard-block every REVIEW lane.
 */
export function resolveReviewPassProvenanceMode(
  raw: unknown,
  warn: (message: string) => void = (message) => console.warn(message),
): ReviewPassProvenanceMode {
  if (raw === undefined || raw === null) return REVIEW_PASS_PROVENANCE_DEFAULT_MODE;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`[review-pass-provenance] invalid reviewPassProvenance config (expected an object); falling back to ${REVIEW_PASS_PROVENANCE_DEFAULT_MODE}`);
    return REVIEW_PASS_PROVENANCE_DEFAULT_MODE;
  }
  const mode = (raw as Record<string, unknown>).mode;
  if (mode === undefined || mode === null) return REVIEW_PASS_PROVENANCE_DEFAULT_MODE;
  if (mode === 'warn' || mode === 'enforce') return mode;
  let rendered: string;
  try {
    rendered = JSON.stringify(mode) ?? String(mode);
  } catch {
    rendered = '<unserializable>';
  }
  warn(`[review-pass-provenance] invalid reviewPassProvenance.mode ${rendered}; falling back to ${REVIEW_PASS_PROVENANCE_DEFAULT_MODE} (valid: warn|enforce)`);
  return REVIEW_PASS_PROVENANCE_DEFAULT_MODE;
}

export interface ReviewPassProvenanceResult {
  /** Non-empty trimmed writer session id (always persisted + signed). */
  writerSessionId: string;
  /** Normalized session source (always persisted + signed). */
  sessionSource: string;
  /** Set only for a same-session write in warn mode (audit-only, non-blocking). */
  provenanceFlag?: ReviewPassProvenanceFlag;
  /** stderr warning text for a same-session write in warn mode. */
  warning?: string;
  /** Rejection error text for a same-session write in enforce mode (persist nothing). */
  rejection?: string;
}

export interface ReviewPassProvenanceInput {
  /** Producing command name for error/warning texts (review_pass_set / finding_add). */
  command: string;
  /** Writer identity resolved via getSessionIdentity() in the writing process. */
  writer: SessionIdentity;
  /** Current story owner lease session id, or null when no valid lease exists. */
  leaseSessionId: string | null;
  /** Resolved mode (resolveReviewPassProvenanceMode). Re-validated here. */
  mode: ReviewPassProvenanceMode;
}

/**
 * Compare the writer session against the story owner lease session.
 *
 * Runtime re-validation (CLAUDE.md handler conventions — do not trust upstream
 * alone): writerSessionId must be non-empty after trim, sessionSource must
 * normalize to a known source, and an out-of-enum mode degrades to the hardcoded
 * warn default rather than accidentally enforcing (preMortem 1).
 */
export function evaluateReviewPassProvenance(input: ReviewPassProvenanceInput): ReviewPassProvenanceResult {
  const command = input.command || 'review_pass_set';
  const writerSessionId = (input.writer?.sessionId ?? '').trim();
  if (writerSessionId.length === 0) {
    throw new Error(`${command}: writer session identity resolved to an empty sessionId; refusing to record an unattributed review pass`);
  }
  const sessionSource = normalizeSessionSource(input.writer?.sessionSource);
  if (sessionSource === null) {
    throw new Error(`${command}: writer session identity has an unknown sessionSource (${String(input.writer?.sessionSource)}); refusing to record an unattributed review pass`);
  }
  const mode: ReviewPassProvenanceMode = input.mode === 'enforce' ? 'enforce' : REVIEW_PASS_PROVENANCE_DEFAULT_MODE;

  const leaseSessionId = (input.leaseSessionId ?? '').trim();
  if (leaseSessionId.length === 0 || leaseSessionId !== writerSessionId) {
    // No lease (nothing to compare against) or a distinct writer session: record identity only.
    return { writerSessionId, sessionSource };
  }

  if (mode === 'enforce') {
    return {
      writerSessionId,
      sessionSource,
      rejection:
        `${command}: writer-session provenance rejected (reviewPassProvenance.mode=enforce): ` +
        `writer session ${writerSessionId} (source=${sessionSource}) matches the story owner lease session ${leaseSessionId}. ` +
        `An owner-session write cannot be recorded as reviewer pass evidence under enforce mode; nothing was persisted. ` +
        `Run the reviewer from a distinct session, or use the default warn mode.`,
    };
  }

  return {
    writerSessionId,
    sessionSource,
    provenanceFlag: SAME_SESSION_WRITE_FLAG,
    warning:
      `review-pass provenance: writer session ${writerSessionId} (source=${sessionSource}) matches the story owner lease session ${leaseSessionId}. ` +
      `A same-session write means subagent-or-self — the two are not mechanically distinguishable (EXP-001). ` +
      `Recorded provenanceFlag=${SAME_SESSION_WRITE_FLAG} (audit-only; no gate consumes it).`,
  };
}
