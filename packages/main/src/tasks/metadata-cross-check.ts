
import type { TaskRecord } from './metadata-store.js';

export interface ChecklistItem {
  id: string;
  title: string;
  status: string;
}

export interface CrossCheckResult {
  errors: string[];
  passed: boolean;
}

export function validateMetadataCrossCheck(
  storyId: string,
  storyTasks: TaskRecord[],
  checklistItems: ChecklistItem[],
): CrossCheckResult {
  const validChecklistIds = new Set(checklistItems.map(i => i.id));
  const errors: string[] = [];

  // CHK-001: entry for current story in task.json, validate task field
  for (const t of storyTasks) {
    if (!t.task || t.task.trim() === '') {
      errors.push(`${t.key}: task field is empty`);
    }
    if (!t.checklist || t.checklist.length === 0) {
      errors.push(`${t.key}: checklist field is empty`);
    }
  }

  // CHK-002: checklist IDs in task.json must exist in checklist.json
  for (const t of storyTasks) {
    for (const chkId of t.checklist || []) {
      if (!validChecklistIds.has(chkId)) {
        errors.push(`${t.key}: references non-existent ${chkId} (no such ID in checklist.json)`);
      }
    }
  }

  // CHK-003: checklist done items must have a corresponding entry in task.json
  const referencedChkIds = new Set(storyTasks.flatMap(t => t.checklist || []));
  for (const item of checklistItems) {
    if (item.status === 'done' && !referencedChkIds.has(item.id)) {
      errors.push(`${item.id} "${item.title}" is marked done, but no entry in task.json references it`);
    }
  }

  // empty task.json gives a warning (non-blocking)
  if (storyTasks.length === 0) {
    return { errors: [], passed: true };
  }

  return { errors, passed: errors.length === 0 };
}
