
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

  // CHK-001: task.json 中当前 story 的条目，task 字段校验
  for (const t of storyTasks) {
    if (!t.task || t.task.trim() === '') {
      errors.push(`${t.key}: task 字段为空`);
    }
    if (!t.checklist || t.checklist.length === 0) {
      errors.push(`${t.key}: checklist 字段为空`);
    }
  }

  // CHK-002: task.json 中的 checklist ID 必须存在于 checklist.json
  for (const t of storyTasks) {
    for (const chkId of t.checklist || []) {
      if (!validChecklistIds.has(chkId)) {
        errors.push(`${t.key}: 引用了不存在的 ${chkId}（checklist.json 中无此 ID）`);
      }
    }
  }

  // CHK-003: checklist done item 必须有对应的 task.json 条目
  const referencedChkIds = new Set(storyTasks.flatMap(t => t.checklist || []));
  for (const item of checklistItems) {
    if (item.status === 'done' && !referencedChkIds.has(item.id)) {
      errors.push(`${item.id}「${item.title}」已标 done，但 task.json 中无任何条目引用它`);
    }
  }

  // 空 task.json 给 warning（不阻塞）
  if (storyTasks.length === 0) {
    return { errors: [], passed: true };
  }

  return { errors, passed: errors.length === 0 };
}
