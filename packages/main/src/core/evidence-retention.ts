// Runtime evidence retention + garbage collection (§B4b of
// proof-or-stop-authority-live-integration.md). The planner emits a per-kind
// `retentionClassByKind` policy and `assertJobPolicyConsistency` rejects unknown
// classes — but that is policy only. This module is the runtime layer that
// actually decides what may be deleted and performs a deterministic sweep.
//
// Hard rules enforced here (§B4b):
//   - artifacts referenced by a passing `gate_decision` receipt must NOT be
//     garbage collected before the configured receipt-bound retention window
//     expires;
//   - receipt JSON and final host verdict records are `protected` and are NEVER
//     deleted;
//   - `final_summary` evidence remains queryable indefinitely (never GC'd) so
//     final blocked summaries and decision reasons stay available;
//   - GC deletes ONLY artifacts whose retention class AND expiry both allow it;
//   - fail-closed: any uncertainty (unknown class, non-finite age) retains.
//
// Purity: no clock. The caller passes `nowMs`. The sweep is deterministic
// (artifacts evaluated in artifactId order) so the same store + same clock
// always produces the same deletion set.

import {
  DEFAULT_RETENTION_BY_KIND,
  EVIDENCE_RETENTION_CLASSES,
  type EvidenceRetentionClass,
} from './planner.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface RetentionPolicy {
  /** Retention window per class in ms. `Infinity` means "never delete". */
  windowMsByClass: Record<EvidenceRetentionClass, number>;
  /** Configured receipt-bound retention window — the floor for any receipt-referenced artifact. */
  receiptBoundWindowMs: number;
}

// Conservative defaults. Short-lived run logs roll off fast; verification
// artifacts persist a week; receipt-bound artifacts persist a quarter; final
// summaries are permanent. These are the runtime windows the policy classes map
// onto — tune via an explicit RetentionPolicy, never by widening a class.
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  windowMsByClass: {
    short_lived_run_log: 1 * DAY_MS,
    verification_artifact: 7 * DAY_MS,
    receipt_bound_artifact: 90 * DAY_MS,
    final_summary: Infinity,
  },
  receiptBoundWindowMs: 90 * DAY_MS,
};

export interface RetainedArtifact {
  /** Stable identity used both for deletion and for deterministic sweep ordering. */
  artifactId: string;
  /** Evidence kind (run_record, validation_evidence, gate_request, stop_summary, ...). */
  kind: string;
  /** Retention class assigned by the JobPlan's evidencePolicy.retentionClassByKind. */
  retentionClass: EvidenceRetentionClass;
  /** Creation time in epoch ms. */
  createdAtMs: number;
  /** True when a passing `gate_decision` receipt references this artifact. */
  receiptBound: boolean;
  /** True for receipt JSON / final host verdict records — NEVER deletable. */
  protected: boolean;
}

export interface RetentionDecision {
  artifactId: string;
  delete: boolean;
  reason: string;
  /** The window actually applied (after receipt-bound floor / class). `Infinity` = never. */
  effectiveWindowMs: number;
  ageMs: number;
}

function isKnownClass(cls: string): cls is EvidenceRetentionClass {
  return (EVIDENCE_RETENTION_CLASSES as readonly string[]).includes(cls);
}

/**
 * Conservative fallback class for an evidence kind with no policy mapping AND no
 * canonical default — receipt_bound_artifact (the longest finite window). This is
 * deliberately the *fail-closed-but-deletable* choice: an unknown kind is retained
 * for a long window rather than rolled off as a short-lived log, but is not pinned
 * `final_summary` forever (which would defeat GC for a typo'd kind). A truly unknown
 * class still fails closed in {@link evaluateRetention}.
 */
const UNMAPPED_KIND_RETENTION_CLASS: EvidenceRetentionClass = 'receipt_bound_artifact';

/**
 * Classify a single evidence kind into its retention class, consistently across the
 * run record, provider events, command/validation/git evidence, and the final
 * summary (§B4b). A JobPlan's `evidencePolicy.retentionClassByKind` override wins
 * when it names a KNOWN class for the kind; otherwise the canonical
 * {@link DEFAULT_RETENTION_BY_KIND} mapping (the same one the planner emits) applies;
 * a kind with neither mapping falls back to {@link UNMAPPED_KIND_RETENTION_CLASS}.
 *
 * Single source of truth: the default mapping is imported from the planner, so the
 * runtime classifier can never drift from the policy the planner certifies.
 */
export function classifyRetention(
  kind: string,
  retentionClassByKind?: Record<string, EvidenceRetentionClass>,
): EvidenceRetentionClass {
  const override = retentionClassByKind?.[kind];
  if (typeof override === 'string' && isKnownClass(override)) return override;
  const canonical = DEFAULT_RETENTION_BY_KIND[kind];
  if (canonical && isKnownClass(canonical)) return canonical;
  return UNMAPPED_KIND_RETENTION_CLASS;
}

/**
 * Decide whether a single artifact may be garbage collected at `nowMs`.
 * Fail-closed: anything ambiguous is retained, never deleted.
 */
export function evaluateRetention(
  artifact: RetainedArtifact,
  nowMs: number,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): RetentionDecision {
  const ageMs = nowMs - artifact.createdAtMs;
  const base = { artifactId: artifact.artifactId, ageMs };

  // Receipt JSON / final host verdict records are never deletable.
  if (artifact.protected) {
    return { ...base, delete: false, reason: 'protected_record_never_deleted', effectiveWindowMs: Infinity };
  }

  // Unknown retention class → fail closed (retain). The policy gate should have
  // rejected it upstream, but the GC layer must not delete on uncertainty.
  if (!isKnownClass(artifact.retentionClass)) {
    return { ...base, delete: false, reason: 'unknown_retention_class_retained', effectiveWindowMs: Infinity };
  }

  // Final summaries remain queryable indefinitely (§B4b).
  if (artifact.retentionClass === 'final_summary') {
    return { ...base, delete: false, reason: 'final_summary_retained_for_query', effectiveWindowMs: Infinity };
  }

  const classWindow = policy.windowMsByClass[artifact.retentionClass];

  // Receipt-bound artifacts must outlive the configured receipt-bound window
  // regardless of their own (possibly shorter) class window.
  const effectiveWindowMs = artifact.receiptBound
    ? Math.max(classWindow, policy.receiptBoundWindowMs)
    : classWindow;

  if (!Number.isFinite(effectiveWindowMs)) {
    return { ...base, delete: false, reason: 'infinite_retention_window', effectiveWindowMs };
  }

  // Non-finite or negative age (clock skew / bad input) → fail closed.
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return { ...base, delete: false, reason: 'non_monotonic_age_retained', effectiveWindowMs };
  }

  if (ageMs > effectiveWindowMs) {
    const reason = artifact.receiptBound
      ? 'receipt_bound_window_expired'
      : 'retention_window_expired';
    return { ...base, delete: true, reason, effectiveWindowMs };
  }

  const reason = artifact.receiptBound ? 'within_receipt_bound_window' : 'within_retention_window';
  return { ...base, delete: false, reason, effectiveWindowMs };
}

export interface SweepResult {
  decisions: RetentionDecision[];
  deleted: string[];
  retained: string[];
}

/**
 * Deterministically evaluate an entire artifact store. Pure: returns which
 * artifacts WOULD be deleted; performs no side effects. Decisions are ordered
 * by artifactId so the result is reproducible.
 */
export function sweepRetention(
  artifacts: readonly RetainedArtifact[],
  nowMs: number,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): SweepResult {
  const ordered = [...artifacts].sort((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0));
  const decisions = ordered.map(a => evaluateRetention(a, nowMs, policy));
  return {
    decisions,
    deleted: decisions.filter(d => d.delete).map(d => d.artifactId),
    retained: decisions.filter(d => !d.delete).map(d => d.artifactId),
  };
}

export interface RunSweepResult extends SweepResult {
  /** artifactIds the deleteFn refused / failed to delete (kept out of `deleted`). */
  failed: Array<{ artifactId: string; error: string }>;
}

/**
 * Execute a retention sweep, invoking `deleteFn` for each artifact the policy
 * allows deleting. Only allowed artifacts are passed to `deleteFn`; protected /
 * receipt-bound / final-summary / not-yet-expired artifacts are never touched.
 * A deleteFn that throws moves the artifact to `failed` and out of `deleted`.
 */
export function runRetentionSweep(
  artifacts: readonly RetainedArtifact[],
  nowMs: number,
  deleteFn: (artifactId: string) => void,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): RunSweepResult {
  const plan = sweepRetention(artifacts, nowMs, policy);
  const deleted: string[] = [];
  const failed: Array<{ artifactId: string; error: string }> = [];
  for (const id of plan.deleted) {
    try {
      deleteFn(id);
      deleted.push(id);
    } catch (err) {
      failed.push({ artifactId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { decisions: plan.decisions, deleted, retained: plan.retained, failed };
}
