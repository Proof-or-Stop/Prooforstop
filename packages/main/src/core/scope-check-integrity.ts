import { digestCanonicalJson } from './digest.js';
import { normalizeReviewerReadManifest } from './reviewer-read-evidence.js';
import type { ChecklistData, ReviewerReadManifest, ScopeCheckData, ScopeCheckFeature } from './types.js';

export const SCOPE_CHECK_SALT = 'proof-or-stop-scope-check-integrity-v1';

/**
 * Digest of the checklist fields the scope-plan reviewer judges coverage from
 * (id, title, excludes, userSees, verificationIntent). Recorded beside a
 * scope verdict so story_review can tell the owner that a gap predates a PLAN
 * checklist repair and the one remaining action is a reviewer rerun. It only
 * selects guidance wording: a gap blocks either way, so it is deliberately
 * outside the signature domain.
 */
export function scopeReviewChecklistDigest(checklist: Pick<ChecklistData, 'items'>): string {
  return digestCanonicalJson({
    version: 1,
    items: checklist.items.map(item => ({
      id: item.id,
      title: item.title,
      excludes: item.excludes ?? [],
      userSees: item.userSees ?? null,
      verificationIntent: item.verificationIntent ?? null,
    })),
  });
}

export interface ScopeCheckSignatureMaterial {
  features: ScopeCheckFeature[];
  summary: ScopeCheckData['summary'];
  readManifest: ReviewerReadManifest;
  deliveryRunId?: string;
}

export function scopeCheckContentHash(
  storyId: string,
  timestamp: string,
  reviewRound: string,
  material: ScopeCheckSignatureMaterial,
): string {
  const deliveryRunId = material.deliveryRunId?.trim();
  return digestCanonicalJson({
    version: deliveryRunId ? 3 : 2,
    salt: SCOPE_CHECK_SALT,
    storyId,
    timestamp,
    reviewRound,
    features: material.features,
    summary: material.summary,
    readManifest: normalizeReviewerReadManifest(material.readManifest),
    ...(deliveryRunId ? { deliveryRunId } : {}),
  });
}

export function verifyScopeCheckContentSignature(storyId: string, data: ScopeCheckData): boolean {
  if (!data._hash || !data.checkedAt || !data.summary || data.readManifest === undefined) return false;
  try {
    const summary = {
      total: data.summary.total ?? 0,
      covered: data.summary.covered ?? 0,
      excluded: data.summary.excluded ?? 0,
      gaps: data.summary.gaps ?? 0,
      orphanSuspect: data.summary.orphanSuspect ?? 0,
      drift: data.summary.drift ?? 0,
    };
    return data._hash === scopeCheckContentHash(storyId, data.checkedAt, data.reviewRound || '', {
      features: data.features || [],
      summary,
      readManifest: normalizeReviewerReadManifest(data.readManifest),
      ...(data.deliveryRunId ? { deliveryRunId: data.deliveryRunId } : {}),
    });
  } catch {
    return false;
  }
}
