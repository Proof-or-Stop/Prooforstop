/**
 * Finding integrity: sign & verify (shared between handlers and machine guards)
 */

import { createHash } from 'crypto';
import type {
  FindingData,
  GapLogProvenanceBinding,
  ReviewerReadDiagnostic,
  ReviewerReadLogEvidence,
  ReviewerReadManifest,
} from './types.js';
import { digestCanonicalJson } from './digest.js';
import {
  normalizeReviewerReadDiagnostics,
  normalizeReviewerReadLogEvidence,
  normalizeReviewerReadManifest,
} from './reviewer-read-evidence.js';

const FINDING_SALT = 'lattice-finding-integrity-v1';
const REVIEW_PASS_SALT = 'lattice-review-pass-integrity-v1';

/** Sign a single finding to prevent main agent from faking reviewer findings */
export function signFinding(
  storyId: string,
  id: string,
  desc: string,
  severity: string,
  timestamp: string,
  reviewRound: string,
  reviewRunId = '',
  readManifest?: ReviewerReadManifest,
  readLog?: ReviewerReadLogEvidence,
  readDiagnostics?: ReviewerReadDiagnostic[],
  gapLogBinding?: GapLogProvenanceBinding,
): string {
  if (gapLogBinding !== undefined) {
    return digestCanonicalJson({
      version: 3,
      salt: FINDING_SALT,
      storyId,
      id,
      desc,
      severity,
      timestamp,
      reviewRound,
      reviewRunId,
      gapLogBinding,
    });
  }
  if (readManifest !== undefined || readLog !== undefined || readDiagnostics !== undefined) {
    return digestCanonicalJson({
      version: 2,
      salt: FINDING_SALT,
      storyId,
      id,
      desc,
      severity,
      timestamp,
      reviewRound,
      reviewRunId,
      ...(readManifest !== undefined ? { readManifest: normalizeReviewerReadManifest(readManifest) } : {}),
      ...(readLog !== undefined ? { readLog: normalizeReviewerReadLogEvidence(readLog) } : {}),
      ...(readDiagnostics !== undefined ? { readDiagnostics: normalizeReviewerReadDiagnostics(readDiagnostics) } : {}),
    });
  }
  return createHash('sha256').update(`${storyId}:${id}:${desc}:${severity}:${timestamp}:${reviewRound}:${reviewRunId}:${FINDING_SALT}`).digest('hex');
}

/** Verify finding signature (compatible with old and new formats) */
export function verifyFinding(
  storyId: string,
  f: {
    id: string;
    desc: string;
    severity: string;
    createdAt?: string;
    _hash?: string;
    reviewRound?: string;
    reviewRunId?: string;
    readManifest?: ReviewerReadManifest;
    readLog?: ReviewerReadLogEvidence;
    readDiagnostics?: ReviewerReadDiagnostic[];
    gapLogBinding?: GapLogProvenanceBinding;
  },
): boolean {
  if (!f._hash || !f.createdAt) return false;
  const reviewRunId = f.reviewRunId?.trim() || '';
  if (f.gapLogBinding !== undefined) {
    try {
      return f._hash === signFinding(
        storyId,
        f.id,
        f.desc,
        f.severity,
        f.createdAt,
        f.reviewRound || '',
        reviewRunId,
        undefined,
        undefined,
        undefined,
        f.gapLogBinding,
      );
    } catch {
      return false;
    }
  }
  if (f.readManifest !== undefined || f.readLog !== undefined || f.readDiagnostics !== undefined) {
    try {
      return f._hash === signFinding(
        storyId,
        f.id,
        f.desc,
        f.severity,
        f.createdAt,
        f.reviewRound || '',
        reviewRunId,
        f.readManifest,
        f.readLog,
        f.readDiagnostics,
      );
    } catch {
      return false;
    }
  }
  if (reviewRunId) {
    return f._hash === signFinding(storyId, f.id, f.desc, f.severity, f.createdAt, f.reviewRound || '', reviewRunId);
  }
  // Fallback: legacy format with reviewRound but without reviewRunId
  const newExpected = signFinding(storyId, f.id, f.desc, f.severity, f.createdAt, f.reviewRound || '');
  if (f._hash === newExpected) return true;
  // Fallback: try old format (without reviewRound) for backward compatibility
  const oldExpected = createHash('sha256').update(`${storyId}:${f.id}:${f.desc}:${f.severity}:${f.createdAt}:${FINDING_SALT}`).digest('hex');
  return f._hash === oldExpected;
}

export const GAP_LOG_PROVENANCE_SCHEMA = 'lattice.gap-log-provenance.v1' as const;
export const GAP_LOG_ARTIFACT_PATH = '.lattice/story/actives/B-META-framework-audit/findings.json' as const;

/** Canonical whole-file semantic digest; binding/hash fields are excluded to avoid circularity. */
export function digestGapLogArtifact(data: FindingData): string {
  let bindingOwner = -1;
  for (let index = 0; index < data.findings.length; index++) {
    if (data.findings[index].gapLogBinding) bindingOwner = index;
  }
  return digestCanonicalJson({
    findings: data.findings.map((finding, index) => {
      if (index !== bindingOwner) return finding;
      const { _hash: _signature, gapLogBinding: _binding, ...boundFinding } = finding;
      return boundFinding;
    }),
  });
}

export interface GapLogArtifactVerification {
  trusted: boolean;
  reason:
    | 'valid_official_gap_log_binding'
    | 'wrong_artifact_path'
    | 'missing_binding'
    | 'invalid_binding_shape'
    | 'content_digest_mismatch'
    | 'finding_signature_invalid';
  expectedDigest?: string;
  observedDigest?: string;
  findingId?: string;
}

export function verifyGapLogArtifactBinding(
  data: FindingData,
  artifactPath: string = GAP_LOG_ARTIFACT_PATH,
): GapLogArtifactVerification {
  if (artifactPath.replace(/\\/g, '/').replace(/^\.\//, '') !== GAP_LOG_ARTIFACT_PATH) {
    return { trusted: false, reason: 'wrong_artifact_path' };
  }
  const bound = data.findings.filter((finding) => finding.gapLogBinding);
  const latest = bound[bound.length - 1];
  if (!latest?.gapLogBinding) return { trusted: false, reason: 'missing_binding' };
  const binding = latest.gapLogBinding;
  if (
    binding.schemaVersion !== GAP_LOG_PROVENANCE_SCHEMA
    || binding.command !== 'gap_log'
    || binding.storyId !== 'B-META-framework-audit'
    || binding.artifactPath !== GAP_LOG_ARTIFACT_PATH
    || binding.findingId !== latest.id
    || binding.createdAt !== latest.createdAt
  ) {
    return { trusted: false, reason: 'invalid_binding_shape', findingId: latest.id };
  }
  const expectedDigest = digestGapLogArtifact(data);
  if (binding.contentDigest !== expectedDigest) {
    return {
      trusted: false,
      reason: 'content_digest_mismatch',
      expectedDigest,
      observedDigest: binding.contentDigest,
      findingId: latest.id,
    };
  }
  if (!verifyFinding('B-META-framework-audit', latest)) {
    return { trusted: false, reason: 'finding_signature_invalid', expectedDigest, observedDigest: binding.contentDigest, findingId: latest.id };
  }
  return {
    trusted: true,
    reason: 'valid_official_gap_log_binding',
    expectedDigest,
    observedDigest: binding.contentDigest,
    findingId: latest.id,
  };
}

/**
 * B-3b05: writer-session provenance signed into NEW review pass records.
 * Presence of provenance selects the version-3 domain; legacy records (no
 * writerSessionId/sessionSource) keep verifying via their original domains.
 */
export interface ReviewPassWriterProvenance {
  writerSessionId: string;
  sessionSource: string;
  /**
   * B-3b05 F-002: the audit flag itself is part of the signed domain — a flag
   * added, stripped, or flipped on an already-signed record must break
   * verification. Canonical representation: absent and empty string both sign
   * as '' (a no-flag record), so sign/verify stay symmetric for unflagged
   * records.
   */
  provenanceFlag?: string;
}

export function signReviewPass(
  storyId: string,
  id: string,
  agent: string,
  note: string,
  timestamp: string,
  reviewRound: string,
  reviewRunId = '',
  readManifest?: ReviewerReadManifest,
  readLog?: ReviewerReadLogEvidence,
  readDiagnostics?: ReviewerReadDiagnostic[],
  provenance?: ReviewPassWriterProvenance,
): string {
  if (provenance !== undefined) {
    // Runtime re-validation (CLAUDE.md handler conventions): a provenance-domain
    // signature must never bind an empty writer identity. The RAW values are
    // hashed (no trimming/normalizing here) so any byte-level tamper of the
    // persisted writerSessionId/sessionSource breaks verification.
    if (typeof provenance.writerSessionId !== 'string' || provenance.writerSessionId.trim().length === 0) {
      throw new Error('signReviewPass: provenance.writerSessionId must be a non-empty string');
    }
    return digestCanonicalJson({
      version: 3,
      salt: REVIEW_PASS_SALT,
      storyId,
      id,
      agent,
      note,
      timestamp,
      reviewRound,
      reviewRunId,
      writerSessionId: provenance.writerSessionId,
      sessionSource: provenance.sessionSource ?? '',
      provenanceFlag: provenance.provenanceFlag ?? '',
      ...(readManifest !== undefined ? { readManifest: normalizeReviewerReadManifest(readManifest) } : {}),
      ...(readLog !== undefined ? { readLog: normalizeReviewerReadLogEvidence(readLog) } : {}),
      ...(readDiagnostics !== undefined ? { readDiagnostics: normalizeReviewerReadDiagnostics(readDiagnostics) } : {}),
    });
  }
  if (readManifest !== undefined || readLog !== undefined || readDiagnostics !== undefined) {
    return digestCanonicalJson({
      version: 2,
      salt: REVIEW_PASS_SALT,
      storyId,
      id,
      agent,
      note,
      timestamp,
      reviewRound,
      reviewRunId,
      ...(readManifest !== undefined ? { readManifest: normalizeReviewerReadManifest(readManifest) } : {}),
      ...(readLog !== undefined ? { readLog: normalizeReviewerReadLogEvidence(readLog) } : {}),
      ...(readDiagnostics !== undefined ? { readDiagnostics: normalizeReviewerReadDiagnostics(readDiagnostics) } : {}),
    });
  }
  return createHash('sha256').update(`${storyId}:${id}:${agent}:${note}:${timestamp}:${reviewRound}:${reviewRunId}:${REVIEW_PASS_SALT}`).digest('hex');
}

export function verifyReviewPass(
  storyId: string,
  p: {
    id: string;
    agent?: string;
    note?: string;
    createdAt?: string;
    _hash?: string;
    reviewRound?: string;
    reviewRunId?: string;
    readManifest?: ReviewerReadManifest;
    readLog?: ReviewerReadLogEvidence;
    readDiagnostics?: ReviewerReadDiagnostic[];
    writerSessionId?: string;
    sessionSource?: string;
    provenanceFlag?: string;
  },
): boolean {
  if (!p._hash || !p.createdAt || !p.agent || !p.note) return false;
  const reviewRunId = p.reviewRunId?.trim() || '';
  // B-3b05: provenance-inclusive records verify ONLY via the version-3 domain —
  // no fallback to legacy domains (mirrors the reviewRunId rule). A record with
  // sessionSource or provenanceFlag but no writerSessionId can only be a
  // stripped/tampered new record, so it fails closed too (a legitimate flag is
  // only ever written alongside a signed writer identity). Records with NONE of
  // the three fields are pre-B-3b05 history and keep verifying via the legacy
  // domains below (never fail-closed on history).
  // F-002: provenanceFlag is bound into the v3 payload (absent ≡ '' — the same
  // canonicalization signReviewPass applies), so add/strip/flip of the flag on
  // an already-signed record breaks verification.
  if (p.writerSessionId !== undefined || p.sessionSource !== undefined || p.provenanceFlag !== undefined) {
    if (typeof p.writerSessionId !== 'string' || p.writerSessionId.trim().length === 0) return false;
    try {
      return p._hash === signReviewPass(
        storyId,
        p.id,
        p.agent,
        p.note,
        p.createdAt,
        p.reviewRound || '',
        reviewRunId,
        p.readManifest,
        p.readLog,
        p.readDiagnostics,
        {
          writerSessionId: p.writerSessionId,
          sessionSource: p.sessionSource ?? '',
          provenanceFlag: p.provenanceFlag ?? '',
        },
      );
    } catch {
      return false;
    }
  }
  if (p.readManifest !== undefined || p.readLog !== undefined || p.readDiagnostics !== undefined) {
    try {
      return p._hash === signReviewPass(
        storyId,
        p.id,
        p.agent,
        p.note,
        p.createdAt,
        p.reviewRound || '',
        reviewRunId,
        p.readManifest,
        p.readLog,
        p.readDiagnostics,
      );
    } catch {
      return false;
    }
  }
  if (reviewRunId) {
    return p._hash === signReviewPass(storyId, p.id, p.agent, p.note, p.createdAt, p.reviewRound || '', reviewRunId);
  }
  const previousExpected = signReviewPass(storyId, p.id, p.agent, p.note, p.createdAt, p.reviewRound || '');
  return p._hash === previousExpected;
}
