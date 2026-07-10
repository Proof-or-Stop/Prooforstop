/**
 * Finding integrity: sign & verify (shared between handlers and machine guards)
 */

import { createHash } from 'crypto';
import type { ReviewerReadManifest } from './types.js';
import { digestCanonicalJson } from './digest.js';
import { normalizeReviewerReadManifest } from './reviewer-read-evidence.js';

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
): string {
  return createHash('sha256').update(`${storyId}:${id}:${desc}:${severity}:${timestamp}:${reviewRound}:${reviewRunId}:${FINDING_SALT}`).digest('hex');
}

/** Verify finding signature (compatible with old and new formats) */
export function verifyFinding(
  storyId: string,
  f: { id: string; desc: string; severity: string; createdAt?: string; _hash?: string; reviewRound?: string; reviewRunId?: string },
): boolean {
  if (!f._hash || !f.createdAt) return false;
  const reviewRunId = f.reviewRunId?.trim() || '';
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

export function signReviewPass(
  storyId: string,
  id: string,
  agent: string,
  note: string,
  timestamp: string,
  reviewRound: string,
  reviewRunId = '',
  readManifest?: ReviewerReadManifest,
): string {
  if (readManifest !== undefined) {
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
      readManifest: normalizeReviewerReadManifest(readManifest),
    });
  }
  return createHash('sha256').update(`${storyId}:${id}:${agent}:${note}:${timestamp}:${reviewRound}:${reviewRunId}:${REVIEW_PASS_SALT}`).digest('hex');
}

export function verifyReviewPass(
  storyId: string,
  p: { id: string; agent?: string; note?: string; createdAt?: string; _hash?: string; reviewRound?: string; reviewRunId?: string; readManifest?: ReviewerReadManifest },
): boolean {
  if (!p._hash || !p.createdAt || !p.agent || !p.note) return false;
  const reviewRunId = p.reviewRunId?.trim() || '';
  if (p.readManifest !== undefined) {
    let readManifest: ReviewerReadManifest;
    try {
      readManifest = normalizeReviewerReadManifest(p.readManifest);
    } catch {
      return false;
    }
    return p._hash === signReviewPass(storyId, p.id, p.agent, p.note, p.createdAt, p.reviewRound || '', reviewRunId, readManifest);
  }
  if (reviewRunId) {
    return p._hash === signReviewPass(storyId, p.id, p.agent, p.note, p.createdAt, p.reviewRound || '', reviewRunId);
  }
  const previousExpected = signReviewPass(storyId, p.id, p.agent, p.note, p.createdAt, p.reviewRound || '');
  return p._hash === previousExpected;
}
