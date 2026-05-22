/**
 * B-1fca CHK-002: Reviewer quorum evaluation — pure, no I/O.
 *
 * Evaluates whether the set of active reviewer lanes have sufficient evidence
 * coverage and verifier independence, returning structured diagnostics.
 */

export type ReviewerQuorumProfile = 'light' | 'balanced' | 'strict';

export interface ProducerVerifierMetadata {
  /** identity of the entity that produced the review (e.g. agent id, session id) */
  actor?: string;
  /** provider name, e.g. "anthropic" */
  provider?: string;
  /** vendor/org name */
  vendor?: string;
  /** model id, e.g. "claude-opus-4-7" */
  model?: string;
  /** unique run id */
  runId?: string;
}

export interface ReviewerEvidenceEntry {
  /** lane, e.g. "koala-review-concept" */
  lane: string;
  /** agent string, e.g. "koala-review-concept" or bare "concept" */
  agent?: string;
  /** evidence kind */
  kind: 'finding' | 'pass';
  /** true = signature verified */
  signatureValid?: boolean;
  /** producer metadata */
  producer?: ProducerVerifierMetadata;
  /** verifier metadata (the entity that independently ran/verified the review) */
  verifier?: ProducerVerifierMetadata;
}

export interface ReviewerQuorumInput {
  /** active reviewer short names, e.g. ["concept", "quality", "test-coverage"] */
  activeReviewers: string[];
  /** evidence records collected for the current review round */
  evidence: ReviewerEvidenceEntry[];
  /** profile that determines blocking thresholds */
  profile: ReviewerQuorumProfile;
  /**
   * When true (strict only): absence of verifier metadata on an evidence entry
   * blocks even if other quorum requirements are met.
   */
  requireDifferentiatedVerifier?: boolean;
}

export interface QuorumDiagnostic {
  code: string;
  severity: 'blocking' | 'warning' | 'info';
  /** reviewer lane this diagnostic applies to, if lane-specific */
  lane?: string;
  message: string;
}

export interface ReviewerQuorumResult {
  ok: boolean;
  blocking: string[];
  warnings: string[];
  diagnostics: QuorumDiagnostic[];
}

/** Map reviewer short name to canonical lane string */
function toLane(name: string): string {
  if (name.startsWith('koala-review-')) return name;
  return `koala-review-${name}`;
}

/** Check if an evidence entry covers the given lane */
function entryCoversLane(entry: ReviewerEvidenceEntry, lane: string): boolean {
  if (entry.lane === lane) return true;
  if (entry.agent) {
    if (entry.agent === lane) return true;
    if (toLane(entry.agent) === lane) return true;
  }
  return false;
}

function metadataKey(m: ProducerVerifierMetadata | undefined): string | null {
  if (!m) return null;
  const parts: string[] = [];
  if (m.actor?.trim()) parts.push(`actor:${m.actor.trim()}`);
  if (m.provider?.trim()) parts.push(`provider:${m.provider.trim()}`);
  if (m.vendor?.trim()) parts.push(`vendor:${m.vendor.trim()}`);
  if (m.model?.trim()) parts.push(`model:${m.model.trim()}`);
  return parts.length > 0 ? parts.join('|') : null;
}

function hasMetadata(m: ProducerVerifierMetadata | undefined): boolean {
  if (!m) return false;
  return !!(m.actor?.trim() || m.provider?.trim() || m.vendor?.trim() || m.model?.trim() || m.runId?.trim());
}

function sameActorOrProvider(
  producer: ProducerVerifierMetadata | undefined,
  verifier: ProducerVerifierMetadata | undefined,
): boolean {
  if (!producer || !verifier) return false;

  // Same actor
  if (producer.actor?.trim() && verifier.actor?.trim()) {
    if (producer.actor.trim() === verifier.actor.trim()) return true;
  }

  // Same provider + vendor + model (all three present and equal)
  const pHasProviderKey = producer.provider?.trim() && producer.vendor?.trim() && producer.model?.trim();
  const vHasProviderKey = verifier.provider?.trim() && verifier.vendor?.trim() && verifier.model?.trim();
  if (pHasProviderKey && vHasProviderKey) {
    if (
      producer.provider!.trim() === verifier.provider!.trim()
      && producer.vendor!.trim() === verifier.vendor!.trim()
      && producer.model!.trim() === verifier.model!.trim()
    ) return true;
  }

  return false;
}

/**
 * Evaluate reviewer quorum for the current REVIEW round.
 * Pure function — no side effects, no I/O.
 */
export function evaluateReviewerQuorum(input: ReviewerQuorumInput): ReviewerQuorumResult {
  const { activeReviewers, evidence, profile, requireDifferentiatedVerifier } = input;
  const diagnostics: QuorumDiagnostic[] = [];
  const blockingMessages: string[] = [];
  const warningMessages: string[] = [];

  const requiredLanes = activeReviewers.map(toLane);

  for (const lane of requiredLanes) {
    const coveringEntries = evidence.filter(e => entryCoversLane(e, lane) && e.signatureValid !== false);

    // ── Missing lane ───────────────────────────────────────────────────────
    if (coveringEntries.length === 0) {
      if (profile === 'strict') {
        const msg = `Missing required reviewer lane: ${lane}`;
        blockingMessages.push(msg);
        diagnostics.push({ code: 'missing_lane', severity: 'blocking', lane, message: msg });
      } else if (profile === 'balanced') {
        const msg = `Reviewer lane not yet covered: ${lane}`;
        warningMessages.push(msg);
        diagnostics.push({ code: 'missing_lane', severity: 'warning', lane, message: msg });
      }
      // light: no diagnostic for missing lane
      continue;
    }

    // ── Per-entry checks ───────────────────────────────────────────────────
    for (const entry of coveringEntries) {
      // Blocking finding → dispute
      if (entry.kind === 'finding') {
        if (profile === 'strict') {
          const msg = `Blocking finding from lane ${lane} — dispute required before quorum can pass`;
          blockingMessages.push(msg);
          diagnostics.push({ code: 'open_finding_dispute', severity: 'blocking', lane, message: msg });
        } else if (profile === 'balanced') {
          const msg = `Open finding from lane ${lane} — advisory; resolve before marking done`;
          warningMessages.push(msg);
          diagnostics.push({ code: 'open_finding_dispute', severity: 'warning', lane, message: msg });
        }
        // light: no diagnostic for open findings
      }

      // Same producer/verifier — only when both sides present
      if (hasMetadata(entry.producer) && hasMetadata(entry.verifier)) {
        if (sameActorOrProvider(entry.producer, entry.verifier)) {
          if (profile === 'strict') {
            const msg = `Producer and verifier are the same entity in lane ${lane} — independent verification required`;
            blockingMessages.push(msg);
            diagnostics.push({ code: 'same_producer_verifier', severity: 'blocking', lane, message: msg });
          } else if (profile === 'balanced') {
            const msg = `Producer and verifier appear to be the same entity in lane ${lane}`;
            warningMessages.push(msg);
            diagnostics.push({ code: 'same_producer_verifier', severity: 'warning', lane, message: msg });
          }
        }
      }

      // Missing verifier metadata
      if (requireDifferentiatedVerifier && !hasMetadata(entry.verifier)) {
        if (profile === 'strict') {
          const msg = `Missing verifier metadata in lane ${lane} — requireDifferentiatedVerifier is enabled`;
          blockingMessages.push(msg);
          diagnostics.push({ code: 'missing_verifier_metadata', severity: 'blocking', lane, message: msg });
        } else if (profile === 'balanced') {
          const msg = `Verifier metadata absent in lane ${lane}`;
          warningMessages.push(msg);
          diagnostics.push({ code: 'missing_verifier_metadata', severity: 'warning', lane, message: msg });
        }
        // light: no diagnostic
      }
    }
  }

  const ok = blockingMessages.length === 0;
  return { ok, blocking: blockingMessages, warnings: warningMessages, diagnostics };
}
