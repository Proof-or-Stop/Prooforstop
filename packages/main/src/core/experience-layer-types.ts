/**
 * B-000c CHK-001: Experience Layer Phase 1a — leaf types for the finding-signals
 * derived cache.
 *
 * This module is a LEAF: it has ZERO outward imports (only `node:` builtins are
 * permitted, and none are needed today). It defines the pure data shapes shared
 * by the learning-store (read/write) and the finding-signals derivation (pure +
 * store-port adapter). Keeping these shapes in an import-free leaf is the
 * load-bearing isolation bar (mirrors the usage-ledger module's isolation): the
 * Experience Layer cannot couple back into the gate/handler graph through its
 * type surface.
 *
 * Phase boundary note: the optional enum-ish fields on `SignalSourceFinding`
 * (`signatureTag`, `resolutionType`, `dismissReasonType`) are FORWARD-COMPATIBLE.
 * Real findings do NOT carry them until Phase 1b — derivation must tolerate their
 * absence and degrade conservatively (no positive/negative signal => signalScore
 * 0).
 */

/** Per-signal status/outcome tallies. All values are plain non-negative numbers. */
export interface FindingSignalCounts {
  /** Findings whose status is `resolved`. */
  resolved: number;
  /** Findings whose status is `dismissed`. */
  dismissed: number;
  /** Findings dismissed specifically as a false positive (subset of dismissed). */
  falsePositive: number;
  /** Findings dismissed/closed as accepted risk. */
  acceptedRisk: number;
  /** Findings dismissed/closed as unclear. */
  unclear: number;
  /** Findings resolved as partially mitigated (subset of resolved). */
  partiallyMitigated: number;
}

/**
 * A single aggregated signal: one row per `localSignature`. `signalScore` is a
 * conservative positive-fraction in [0, 1]; `support` is the count of decisive
 * (positive + negative) samples backing the score.
 */
export interface FindingSignal {
  /** Aggregation key: `${category}|${signatureTag ?? ''}|${fileKind}|${lifecyclePhase ?? 'review'}`. */
  localSignature: string;
  /** Finding category bucket (e.g. happy/edge/adversarial/missing or a domain tag). */
  category: string;
  /** Optional finer-grained signature tag; absent until Phase 1b. */
  signatureTag?: string;
  /** Distinct file-kind buckets observed for this signature (deduped, sorted). */
  fileKinds: string[];
  /** Status/outcome tallies. */
  counts: FindingSignalCounts;
  /** positive / (positive + negative + 1). Never NaN: zero-sample => 0. */
  signalScore: number;
  /** positive + negative — the decisive-sample count backing `signalScore`. */
  support: number;
  /** Most recent `createdAt` observed for this signature (ISO string), if any. */
  lastSeen?: string;
  /** Up to a few example story ids contributing to this signature (deduped, sorted). */
  exampleStoryIds: string[];
  /** Up to a few example finding ids contributing to this signature (deduped, sorted). */
  exampleFindingIds: string[];
}

/** The derived-cache envelope persisted to `.lattice/learning/finding-signals.json`. */
export interface FindingSignalsCache {
  /** Schema version of this cache shape. */
  schemaVersion: number;
  /** ISO timestamp the cache was derived (deterministic; passed into derivation). */
  updatedAt: string;
  /** Aggregated signals, one per `localSignature` (stable, sorted). */
  signals: FindingSignal[];
}

// ── B-8387 (Experience Layer Phase 2): staged Process Playbook lifecycle ──────
//
// A Playbook distils a resolved finding into a reusable check the team can apply
// proactively. The lifecycle is STAGED and human-gated:
//   finding -> PlaybookProposal (proposed) -> [diff] -> Playbook (candidate)
// `active` is NEVER auto-set; promoting a candidate to active is an explicit,
// out-of-scope human step (Phase 3). These shapes stay in this LEAF (zero
// outward imports) so the playbook surface cannot couple back into the
// gate/handler graph through its type surface.

/**
 * Provenance binding a playbook (and its proposal) back to the source finding it
 * was distilled from. All three carried verbatim through the approve boundary.
 */
export interface PlaybookLineage {
  /** Story the source finding belonged to. */
  sourceStoryId: string;
  /** Finding id the playbook was distilled from (e.g. `B-xxx:F-001`). */
  sourceFindingId: string;
  /** Optional coarse signatureTag of the source finding (Phase 1b), if present. */
  sourceSignature?: string;
}

/**
 * Cheap surfacing predicates: when a future surfacing step (out of scope here)
 * decides whether to remind on a playbook. All arrays may be empty (a proposal
 * with no obvious trigger is still valid; surfacing simply never fires).
 */
export interface PlaybookTrigger {
  /** Free-text keywords seeded from the finding (deduped, sorted). */
  keywords: string[];
  /** File-kind buckets seeded from the finding's files (deduped, sorted). */
  fileKinds: string[];
  /** Story phases the playbook is relevant in (deduped, sorted). */
  storyPhases: string[];
}

/** Lifecycle status of a Playbook. `active` requires an explicit human step. */
export type PlaybookStatus = 'proposed' | 'candidate' | 'active' | 'stale' | 'archived';

/**
 * A staged proposal: the pre-approval form of a Playbook, persisted to
 * `.lattice/learning/proposals/<id>.json`. `proposalDigest` binds the proposal
 * content (everything EXCEPT the digest field itself) so approve can fail closed
 * on a stale `--expectedProposalDigest` — exactly the decision-doc pattern.
 */
export interface PlaybookProposal {
  /** Minted proposal id (e.g. `PBP-001`). */
  id: string;
  title: string;
  trigger: PlaybookTrigger;
  /** The proactive check the playbook recommends. */
  check: string;
  /** Pitfalls to watch for (deduped order-preserving). */
  pitfalls: string[];
  /** How to verify the check was honoured. */
  verification: string[];
  lineage: PlaybookLineage;
  /** Always `proposed` while it lives as a proposal file. */
  status: 'proposed';
  /** sha256 over the canonical proposal domain MINUS this field. */
  proposalDigest: string;
}

/** Per-playbook usage counters. All non-negative; zeroed at candidate creation. */
export interface PlaybookUsage {
  /** Times the playbook was surfaced to a worker/reviewer. */
  surfacedCount: number;
  /** Surfaced and the worker reported it helped resolve something. */
  resolvedHits: number;
  /** Surfaced and the worker dismissed it as not relevant. */
  dismissedHits: number;
}

/**
 * An approved Playbook, persisted in `.lattice/learning/playbooks.json`. Created
 * by `playbook_approve` at status `candidate` (NEVER `active`). Carries the same
 * core content as the proposal plus a lifecycle status and usage counters.
 */
export interface Playbook {
  id: string;
  title: string;
  trigger: PlaybookTrigger;
  check: string;
  pitfalls: string[];
  verification: string[];
  lineage: PlaybookLineage;
  status: PlaybookStatus;
  usage: PlaybookUsage;
}

/**
 * The input shape the derivation reads. A narrowed projection of a real Finding
 * plus the Phase-1b forward-compatible optional fields. ALL fields are optional
 * so malformed/legacy findings are tolerated without throwing.
 */
export interface SignalSourceFinding {
  storyId?: string;
  id?: string;
  category?: string;
  status?: string;
  files?: string[];
  /** Phase 1b forward-compat: finer signature tag (absent on real findings today). */
  signatureTag?: string;
  /** Phase 1b forward-compat: e.g. `fixed` | `partially_mitigated` (absent today). */
  resolutionType?: string;
  /** Phase 1b forward-compat: e.g. `false_positive` | `out_of_scope` | ... (absent today). */
  dismissReasonType?: string;
  /** Phase 1b forward-compat: lifecycle phase the finding was raised in. */
  lifecyclePhase?: string;
  createdAt?: string;
}
