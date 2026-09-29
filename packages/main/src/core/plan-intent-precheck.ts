import type { ChecklistItem } from './types.js';

/**
 * PLAN-time heads-up for intent problems story_review would otherwise report
 * only after every item is written (runs 1-7, 2026-09-29: one PLAN rework each).
 * Advisory: checklist_update still accepts partial intent written lane by lane.
 */
export function planIntentPrecheckWarnings(_item: Pick<ChecklistItem, 'id' | 'verificationIntent'>): string[] {
  return [];
}
