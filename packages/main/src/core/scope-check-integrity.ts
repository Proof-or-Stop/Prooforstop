import { digestCanonicalJson } from './digest.js';
import { normalizeReviewerReadManifest } from './reviewer-read-evidence.js';
import type { ReviewerReadManifest, ScopeCheckData, ScopeCheckFeature } from './types.js';

export const SCOPE_CHECK_SALT = 'proof-or-stop-scope-check-integrity-v1';

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
