/**
 * Finding integrity: sign & verify (shared between handlers and machine guards)
 */

import { createHash } from 'crypto';

const FINDING_SALT = 'koala-finding-integrity-v1';
const REVIEW_PASS_SALT = 'koala-review-pass-integrity-v1';

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
  // Try newest format first (with reviewRound + reviewRunId)
  const currentExpected = signFinding(storyId, f.id, f.desc, f.severity, f.createdAt, f.reviewRound || '', f.reviewRunId || '');
  if (f._hash === currentExpected) return true;
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
): string {
  return createHash('sha256').update(`${storyId}:${id}:${agent}:${note}:${timestamp}:${reviewRound}:${reviewRunId}:${REVIEW_PASS_SALT}`).digest('hex');
}

export function verifyReviewPass(
  storyId: string,
  p: { id: string; agent?: string; note?: string; createdAt?: string; _hash?: string; reviewRound?: string; reviewRunId?: string },
): boolean {
  if (!p._hash || !p.createdAt || !p.agent || !p.note) return false;
  const expected = signReviewPass(storyId, p.id, p.agent, p.note, p.createdAt, p.reviewRound || '', p.reviewRunId || '');
  if (p._hash === expected) return true;
  const previousExpected = signReviewPass(storyId, p.id, p.agent, p.note, p.createdAt, p.reviewRound || '');
  return p._hash === previousExpected;
}
