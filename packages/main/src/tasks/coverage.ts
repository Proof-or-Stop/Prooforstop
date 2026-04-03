
import { scan } from './extract.js';
import type { StoryStore } from '../story/store.js';
import type { CoverageResult } from './types.js';

/** 检查指定 Story 的 checklist 覆盖率 */
export function checkCoverage(
  storyId: string,
  store: StoryStore,
  scanRoot: string,
): CoverageResult {
  const checklist = store.readChecklist(storyId);
  const tasks = scan(scanRoot);

  // 构建 checklistId → 源码位置 的映射
  const locationMap = new Map<string, Array<{ file: string; line: number; functionName?: string }>>();
  for (const t of tasks) {
    if (!t.checklist) continue;
    for (const chkId of t.checklist) {
      const trimmed = chkId.trim();
      if (!locationMap.has(trimmed)) {
        locationMap.set(trimmed, []);
      }
      locationMap.get(trimmed)!.push({ file: t.sourceFile, line: t.sourceLine, functionName: t.functionName });
    }
  }

  const items = checklist.items.map(item => {
    const locations = locationMap.get(item.id) || [];
    return {
      checklistId: item.id,
      title: item.title,
      covered: locations.length > 0,
      locations,
    };
  });

  const covered = items.filter(i => i.covered).length;
  const missing = items.length - covered;

  return {
    storyId,
    total: items.length,
    covered,
    missing,
    items,
    passed: missing === 0,
  };
}
