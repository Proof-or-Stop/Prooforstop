/**
 * @task B-3b99
 * @checklist CHK-002
 * @title Export local assurance degradation instead of authority receipt closure
 * @type refactor
 * @priority high
 * @description
 *   Canonical story export maps old done-closure authorityImpact local-only /
 *   receipt-required intent into local assurance degradation rows. Local
 *   completion remains local, and missing release-readiness proof appears as
 *   local-assurance-incomplete with a blocking local-completion impact. This
 *   does not revive remote authority-service receipt behavior.
 * @changes
 *   - [CHK-002] Local assurance gaps are exported as visible degradations.
 *   - [CHK-002] Canonical authority tier stays local-evidence with signed/offline receipt references only as local inputs.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { StoryStore } from './store.js';
import type {
  ChecklistData,
  ChecklistItem,
  ReviewData,
  StoryInfo,
  StoryPhase,
  VerificationEvidence,
} from './types.js';

export interface CanonicalStory {
  schemaVersion: 'canonical-story-v0';
  storyId: string;
  title: string;
  lifecycle: {
    phase: Exclude<StoryPhase, 'TEST_CASE' | 'TEST_CASE_REVIEW' | 'META'>;
    localDone: boolean;
    productionDone: boolean;
  };
  checklist: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  authority: {
    tier: 'local-evidence' | 'legacy-record' | 'legacy-receipt';
    receiptRefs: string[];
    canonicalStoryDigest?: string;
    gateInputDigest?: string;
  };
  degradations: Array<{
    id: string;
    host: string;
    capability: string;
    severity: 'info' | 'warn' | 'block';
    visible: true;
    reason: string;
    fallback: string;
    authorityImpact: 'none' | 'evidence-local-only' | 'verification-evidence-limited' | 'local-assurance-required' | 'blocks-production-done';
    recovery?: string;
  }>;
  lineage: Record<string, unknown>;
}

export interface CanonicalStoryBuildResult {
  story: CanonicalStory;
  warnings: string[];
}

function sha256(value: unknown): string {
  const json = JSON.stringify(value);
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}

function canonicalPhase(phase: StoryPhase): CanonicalStory['lifecycle']['phase'] {
  if (phase === 'TEST_CASE' || phase === 'TEST_CASE_REVIEW') return 'TEST';
  if (phase === 'META') return 'INIT';
  return phase;
}

function safeRead<T>(label: string, fn: () => T, warnings: string[], fallback: T): T {
  try {
    return fn();
  } catch {
    warnings.push(`missing optional story artifact: ${label}`);
    return fallback;
  }
}

function checklistProjection(checklist: ChecklistData): Array<Record<string, unknown>> {
  return checklist.items.map((item: ChecklistItem) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    ...(item.context ? { context: item.context } : {}),
    ...(item.relatedDocs ? { relatedDocs: item.relatedDocs } : {}),
    ...(item.files ? { files: item.files } : {}),
    ...(item.verificationIntent ? { verificationIntent: item.verificationIntent } : {}),
    ...(item.verificationEvidence ? {
      verificationEvidenceRefs: item.verificationEvidence.map((ev, index) =>
        evidenceRefFor(item.id, ev, index)
      ),
    } : {}),
  }));
}

function evidenceRefFor(itemId: string, evidence: VerificationEvidence, index: number): string {
  return evidence.intentRef || `${itemId}:evidence:${index}`;
}

function checklistEvidence(checklist: ChecklistData): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const item of checklist.items) {
    for (const [index, evidence] of (item.verificationEvidence ?? []).entries()) {
      records.push({
        id: evidenceRefFor(item.id, evidence, index),
        source: 'checklist.verificationEvidence',
        itemId: item.id,
        ...evidence,
      });
    }
  }
  return records;
}

function testEvidenceRecord(testEvidence: unknown): Record<string, unknown> | null {
  if (!testEvidence || typeof testEvidence !== 'object') return null;
  return {
    id: 'test-evidence',
    source: 'test-evidence.json',
    ...(testEvidence as Record<string, unknown>),
  };
}

function reviewProjection(
  review: ReviewData,
  reviewRuns: unknown,
  reviewPasses: unknown,
  findings: unknown,
  deliveryCheck: unknown,
): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const [index, entry] of review.reviews.entries()) {
    records.push({ id: `review:${index}`, source: 'review.json', ...entry });
  }
  if (reviewRuns && typeof reviewRuns === 'object') records.push({ id: 'review-runs', source: 'review-runs.json', ...(reviewRuns as Record<string, unknown>) });
  if (reviewPasses && typeof reviewPasses === 'object') records.push({ id: 'review-passes', source: 'review-passes.json', ...(reviewPasses as Record<string, unknown>) });
  if (findings && typeof findings === 'object') records.push({ id: 'findings', source: 'findings.json', ...(findings as Record<string, unknown>) });
  if (deliveryCheck && typeof deliveryCheck === 'object') records.push({ id: 'delivery-check', source: 'delivery-check.json', ...(deliveryCheck as Record<string, unknown>) });
  return records;
}

export function collectReceiptRefs(...values: unknown[]): string[] {
  const refs = new Set<string>();
  const visit = (value: unknown, keyHint = ''): void => {
    if (!value) return;
    if (typeof value === 'string') {
      if (/legacyReceipt|receiptRef/i.test(keyHint)) refs.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, keyHint);
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(legacyReceiptRefs?|receiptRefs?)$/i.test(key)) {
        visit(child, key);
      }
    }
  };
  for (const value of values) visit(value);
  return [...refs].sort();
}

function localAssuranceDegradation(productionDone: boolean): CanonicalStory['degradations'][number][] {
  if (productionDone) return [];
  return [{
    id: 'local-assurance-incomplete',
    host: 'lattice-cli',
    capability: 'local-proof-admissibility',
    severity: 'block',
    visible: true,
    reason: 'Current local assurance does not establish release readiness; rely on proof-admissibility, receipt-bundle, and review quorum evidence for local gates.',
    fallback: 'Keep evidenceScope at local evidence until release-readiness evidence is admissible.',
    authorityImpact: 'blocks-production-done',
    recovery: 'Record fresh local proof-admissibility, receipt-bundle, and review quorum evidence for the current story/head/material tuple.',
  }];
}

function missingArtifactDegradations(warnings: string[]): CanonicalStory['degradations'][number][] {
  return warnings.map((warning) => ({
    id: `missing-${basename(warning.split(':').pop()?.trim() || 'story-artifact')}`.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase(),
    host: 'lattice-cli',
    capability: 'story-projection',
    severity: 'info',
    visible: true,
    reason: warning,
    fallback: 'Export the available canonical fields and keep the missing artifact explicit.',
    authorityImpact: 'none',
  }));
}

export function buildCanonicalStory(store: StoryStore, root: string, storyId: string): CanonicalStoryBuildResult {
  const warnings: string[] = [];
  const story = store.readStory(storyId);
  const checklist = safeRead('checklist.json', () => store.readChecklist(storyId), warnings, { items: [] });
  const review = safeRead('review.json', () => store.readReview(storyId), warnings, { reviews: [] });
  const reviewRuns = safeRead('review-runs.json', () => store.readReviewRuns(storyId), warnings, null);
  const reviewPasses = safeRead('review-passes.json', () => store.readReviewPasses(storyId), warnings, null);
  const findings = safeRead('findings.json', () => store.readFindings(storyId), warnings, null);
  const deliveryCheck = safeRead('delivery-check.json', () => store.readDeliveryCheck(storyId), warnings, null);
  const testEvidence = safeRead('test-evidence.json', () => store.readTestEvidence(storyId), warnings, null);
  const events = safeRead('process-events.jsonl', () => store.readProcessEvents(storyId), warnings, []);

  const evidence = checklistEvidence(checklist);
  const testRecord = testEvidenceRecord(testEvidence);
  if (testRecord) evidence.push(testRecord);

  const reviews = reviewProjection(review, reviewRuns, reviewPasses, findings, deliveryCheck);
  const receiptRefs = collectReceiptRefs(evidence, reviews, deliveryCheck, testEvidence);
  const productionDone = false;
  const authorityTier: CanonicalStory['authority']['tier'] = 'local-evidence';
  const canonical: CanonicalStory = {
    schemaVersion: 'canonical-story-v0',
    storyId,
    title: story.title,
    lifecycle: {
      phase: canonicalPhase(story.phase),
      localDone: story.phase === 'DONE',
      productionDone,
    },
    checklist: checklistProjection(checklist),
    evidence,
    reviews,
    authority: {
      tier: authorityTier,
      receiptRefs,
    },
    degradations: [
      ...localAssuranceDegradation(productionDone),
      ...missingArtifactDegradations(warnings),
    ],
    lineage: {
      source: 'lattice-story-store',
      storyDir: store.storyDirRel(),
      worktree: story.worktree ?? null,
      processEvents: events,
      recoveryPoints: [
        {
          id: `${storyId}:story-store`,
          kind: 'story-store',
          path: store.storyDirPath(storyId).startsWith(root) ? store.storyDirRel() : store.storyDirPath(storyId),
        },
      ],
      artifacts: {
        checklist: existsSync(store.storyFilePath(storyId, 'checklist.json')),
        processEvents: existsSync(store.storyFilePath(storyId, 'process-events.jsonl')),
        deliveryCheck: existsSync(store.storyFilePath(storyId, 'delivery-check.json')),
      },
    },
  };

  const gateInput = {
    storyId: canonical.storyId,
    lifecycle: canonical.lifecycle,
    checklist: canonical.checklist,
    evidence: canonical.evidence,
    reviews: canonical.reviews,
    receiptRefs,
  };
  canonical.authority.gateInputDigest = sha256(gateInput);
  canonical.authority.canonicalStoryDigest = sha256({
    ...canonical,
    authority: {
      ...canonical.authority,
      canonicalStoryDigest: undefined,
    },
  });

  return { story: canonical, warnings };
}
