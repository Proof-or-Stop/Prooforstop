import type { ChecklistItem } from './types.js';
import { VERIFICATION_LANES } from './verification.js';

const REPOSITORY_WIDE_DESC = /\bgo\s+test\s+\.\/\.\.\.|\bfull[- ]suite\b|\b(?:complete|entire|full)\s+repository\b|\brepository[- ]wide\b/i;

/**
 * PLAN-time heads-up for intent problems story_review would otherwise report
 * only after every item is written (runs 1-7, 2026-09-29: one PLAN rework each).
 * Mirrors story_review's per-item intent rules; advisory, so checklist_update
 * still accepts partial intent written lane by lane.
 */
export function planIntentPrecheckWarnings(item: Pick<ChecklistItem, 'id' | 'verificationIntent'>): string[] {
  const warnings: string[] = [];
  const intent = item.verificationIntent;
  if (!intent) return warnings;
  for (const lane of VERIFICATION_LANES) {
    const entries = intent[lane] ?? [];
    if (entries.length === 0) {
      warnings.push(`${item.id} has no ${lane} intent (normal and high-risk stories need happy, edge and adversarial).`);
      continue;
    }
    for (const [index, row] of entries.entries()) {
      const ref = `${item.id}:${lane}:${index}`;
      const repositoryWide = row.scope === 'repository' || (row.scope === undefined && REPOSITORY_WIDE_DESC.test(row.desc));
      if (!repositoryWide) continue;
      const must = (row.priority ?? 'must') === 'must';
      if (must && row.requirementSource !== 'external_verifier') {
        warnings.push(`${ref} makes repository-wide success a must without requirementSource=external_verifier; keep it should/no_new_regressions unless an external verifier requires it.`);
      }
      if (row.expectation === 'no_new_regressions' && !row.baselineRef?.trim()) {
        warnings.push(`${ref} uses repository-wide no_new_regressions without baselineRef.`);
      }
      if (must && row.expectation === 'absolute_pass' && row.requirementSource === 'external_verifier' && !row.requirementRef?.trim()) {
        warnings.push(`${ref} claims an external repository-wide absolute pass without requirementRef.`);
      }
    }
  }
  return warnings;
}
