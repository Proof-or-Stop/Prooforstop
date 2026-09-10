import type { ChecklistItem } from './types.js';

export function normalizeTouchpointPath(value: string): string {
  const trimmed = value
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^`|`$/g, '')
    .trim();
  const firstSegment = trimmed.split(/\s+\(/)[0].split(/\s+-\s+/)[0].trim();
  const token = firstSegment.split(/\s+/)[0] || firstSegment;
  return token.replace(/[),:;]+$/g, '').replace(/^`|`$/g, '').trim();
}

export function assessPlanTouchpointCoverage(touchpoints: readonly string[], items: readonly Pick<ChecklistItem, 'files'>[]) {
  const issues: Array<{ type: 'touchpoint_mapping_missing' | 'touchpoint_uncovered'; severity: 'advisory' | 'blocker'; message: string }> = [];
  if (touchpoints.length > 0) {
    const itemsWithFiles = items.filter(i => !!i.files);
    if (itemsWithFiles.length === 0) {
      issues.push({
        type: 'touchpoint_mapping_missing',
        severity: 'advisory',
        message: 'None of the checklist items have the files field filled in (legacy story compatibility mode); cannot perform coverage validation on understanding.touchpoints. Please list the changed files in files.modify/create/test for at least one item to enable strict touchpoint-to-files validation',
      });
    } else {
      // Strict validation mode: collect all file paths declared by items
      const covered = new Set<string>();
      for (const item of itemsWithFiles) {
        const f = item.files!;
        for (const p of f.modify || []) covered.add(normalizeTouchpointPath(p));
        for (const p of f.create || []) covered.add(normalizeTouchpointPath(p));
        for (const p of f.test || []) covered.add(normalizeTouchpointPath(p));
      }
      for (const tp of touchpoints) {
        const normalizedTp = normalizeTouchpointPath(tp);
        if (!covered.has(normalizedTp)) {
          issues.push({
            type: 'touchpoint_uncovered',
            severity: 'blocker',
            message: `touchpoint_uncovered: ${tp} is not covered by the files field of any checklist item (please add this path to the corresponding item's files.modify/create/test or explicitly exclude it via excludes)`,
          });
        }
      }
    }
  }

  return issues;
}
