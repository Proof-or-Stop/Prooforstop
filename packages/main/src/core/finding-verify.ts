/**
 * Finding integrity: sign & verify (shared between handlers and machine guards)
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
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

import { PROOF_OR_STOP_STATE_DIR } from './brand-paths.js';

export const GAP_LOG_PROVENANCE_SCHEMA = 'lattice.gap-log-provenance.v1' as const;
// B-cc10: these hardcoded '.proof-or-stop/' after CHK-003's move, so gap_log wrote to the
// DEPRECATED directory. The write reported success while the canonical B-META ledger
// never received the finding — a framework gap I believed I had recorded was in fact
// unrecorded. Derive from the resolver. GAP_LOG_PROVENANCE_SCHEMA above stays frozen:
// it is a signature identity, not a path.
export const GAP_LOG_ARTIFACT_PATH =
  `${PROOF_OR_STOP_STATE_DIR}/story/actives/B-META-framework-audit/findings.json` as const;
export const GAP_LOG_PROVENANCE_LEDGER_PATH =
  `${PROOF_OR_STOP_STATE_DIR}/story/actives/B-META-framework-audit/gap-log-provenance.jsonl` as const;

export interface GapLogProvenanceReceipt {
  schemaVersion: typeof GAP_LOG_PROVENANCE_SCHEMA;
  sequence: number;
  previousIntegrityHash: string;
  artifactPath: typeof GAP_LOG_ARTIFACT_PATH;
  ledgerPath: typeof GAP_LOG_PROVENANCE_LEDGER_PATH;
  storyId: 'B-META-framework-audit';
  writerCommand: 'gap_log';
  findingId: string;
  gapFingerprint: string;
  preArtifactDigest: string;
  postArtifactDigest: string;
  parentHead: string;
  timestamp: string;
  integrityHash: string;
}

/** Canonical whole-file semantic digest; binding/hash fields are excluded to avoid circularity. */
export function digestGapLogArtifact(data: FindingData): string {
  return digestCanonicalJson(data);
}

function gitCommonDir(gitCwd: string): string {
  const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: gitCwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  return isAbsolute(raw) ? raw : resolve(gitCwd, raw);
}

function receiptKeyPath(gitCwd: string): string {
  return join(gitCommonDir(gitCwd), 'proof-or-stop-gap-log-provenance.key');
}

function receiptPayload(receipt: Omit<GapLogProvenanceReceipt, 'integrityHash'>): string {
  return JSON.stringify(receipt);
}

function expectedReceiptHash(gitCwd: string, receipt: Omit<GapLogProvenanceReceipt, 'integrityHash'>): string | null {
  const keyPath = receiptKeyPath(gitCwd);
  if (!existsSync(keyPath)) return null;
  return createHmac('sha256', readFileSync(keyPath)).update(receiptPayload(receipt)).digest('hex');
}

function committedArtifactDigest(gitCwd: string, commit: string): string | null {
  try {
    const text = execFileSync('git', ['show', `${commit}:${GAP_LOG_ARTIFACT_PATH}`], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return digestGapLogArtifact(JSON.parse(text) as FindingData);
  } catch {
    return null;
  }
}

export function readGapLogProvenanceLedger(root: string): GapLogProvenanceReceipt[] {
  const path = join(root, GAP_LOG_PROVENANCE_LEDGER_PATH);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GapLogProvenanceReceipt);
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
  projectRoot?: string,
  gitCwdOverride?: string,
): GapLogArtifactVerification {
  if (artifactPath.replace(/\\/g, '/').replace(/^\.\//, '') !== GAP_LOG_ARTIFACT_PATH) {
    return { trusted: false, reason: 'wrong_artifact_path' };
  }
  if (!projectRoot || !gitCwdOverride) return { trusted: false, reason: 'missing_binding' };
  const gitCwd = gitCwdOverride;
  let receipts: GapLogProvenanceReceipt[];
  try {
    receipts = readGapLogProvenanceLedger(projectRoot);
  } catch {
    return { trusted: false, reason: 'invalid_binding_shape' };
  }
  if (receipts.length === 0) return { trusted: false, reason: 'missing_binding' };
  let previous = '';
  let priorPost = receipts[0].preArtifactDigest;
  const firstCommittedDigest = committedArtifactDigest(gitCwd, receipts[0].parentHead);
  const canonicalEmptyDigest = digestGapLogArtifact({ findings: [] });
  if (
    (firstCommittedDigest !== null && firstCommittedDigest !== receipts[0].preArtifactDigest)
    || (firstCommittedDigest === null && receipts[0].preArtifactDigest !== canonicalEmptyDigest)
  ) {
    return { trusted: false, reason: 'invalid_binding_shape', findingId: receipts[0].findingId };
  }
  for (let index = 0; index < receipts.length; index++) {
    const receipt = receipts[index];
    const { integrityHash, ...unsigned } = receipt;
    const expected = expectedReceiptHash(gitCwd, unsigned);
    const authentic = expected && /^[a-f0-9]{64}$/.test(integrityHash)
      && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(integrityHash, 'hex'));
    if (
      !authentic
      || receipt.schemaVersion !== GAP_LOG_PROVENANCE_SCHEMA
      || receipt.sequence !== index + 1
      || receipt.previousIntegrityHash !== previous
      || receipt.preArtifactDigest !== priorPost
      || receipt.artifactPath !== GAP_LOG_ARTIFACT_PATH
      || receipt.ledgerPath !== GAP_LOG_PROVENANCE_LEDGER_PATH
      || receipt.storyId !== 'B-META-framework-audit'
      || receipt.writerCommand !== 'gap_log'
      || !/^[a-f0-9]{40,64}$/.test(receipt.parentHead)
      || !Number.isFinite(Date.parse(receipt.timestamp))
    ) return { trusted: false, reason: 'invalid_binding_shape', findingId: receipt.findingId };
    previous = integrityHash;
    priorPost = receipt.postArtifactDigest;
  }
  const latest = receipts[receipts.length - 1];
  const expectedDigest = digestGapLogArtifact(data);
  if (latest.postArtifactDigest !== expectedDigest) {
    return {
      trusted: false,
      reason: 'content_digest_mismatch',
      expectedDigest,
      observedDigest: latest.postArtifactDigest,
      findingId: latest.findingId,
    };
  }
  const finding = data.findings.find((candidate) => candidate.id === latest.findingId);
  if (!finding || finding.gapFingerprint !== latest.gapFingerprint) {
    return { trusted: false, reason: 'finding_signature_invalid', expectedDigest, observedDigest: latest.postArtifactDigest, findingId: latest.findingId };
  }
  return {
    trusted: true,
    reason: 'valid_official_gap_log_binding',
    expectedDigest,
    observedDigest: latest.postArtifactDigest,
    findingId: latest.findingId,
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
  envelopeId?: string,
): string {
  if (envelopeId !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(envelopeId)) throw new Error('signReviewPass: envelopeId must be a SHA-256 digest');
    if (!provenance || typeof provenance.writerSessionId !== 'string' || provenance.writerSessionId.trim().length === 0) {
      throw new Error('signReviewPass: envelope-bound pass requires writer provenance');
    }
    return digestCanonicalJson({
      version: 4,
      salt: REVIEW_PASS_SALT,
      storyId,
      id,
      agent,
      note,
      timestamp,
      reviewRound,
      reviewRunId,
      envelopeId,
      writerSessionId: provenance.writerSessionId,
      sessionSource: provenance.sessionSource ?? '',
      provenanceFlag: provenance.provenanceFlag ?? '',
      ...(readManifest !== undefined ? { readManifest: normalizeReviewerReadManifest(readManifest) } : {}),
      ...(readLog !== undefined ? { readLog: normalizeReviewerReadLogEvidence(readLog) } : {}),
      ...(readDiagnostics !== undefined ? { readDiagnostics: normalizeReviewerReadDiagnostics(readDiagnostics) } : {}),
    });
  }
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
    envelopeId?: string;
  },
): boolean {
  if (!p._hash || !p.createdAt || !p.agent || !p.note) return false;
  const reviewRunId = p.reviewRunId?.trim() || '';
  if (p.envelopeId !== undefined) {
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
        p.envelopeId,
      );
    } catch {
      return false;
    }
  }
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
