
import { scan } from './extract.js';
import type { LocateResult } from './types.js';

export function locateTasks(query: string, scanRoot: string): LocateResult {
  const tasks = scan(scanRoot);
  const q = query.trim().toLowerCase();

  const matches = tasks.filter(t => {
    // Match checklist ID
    if (t.checklist?.some(c => c.trim().toLowerCase() === q)) return true;
    // Match task ID
    if (t.task.toLowerCase() === q) return true;
    // Keyword match against title / description
    if (t.title?.toLowerCase().includes(q)) return true;
    if (t.description?.toLowerCase().includes(q)) return true;
    return false;
  });

  return {
    query,
    matches: matches.map(m => ({
      task: m.task,
      checklist: m.checklist,
      title: m.title,
      file: m.sourceFile,
      line: m.sourceLine,
      functionName: m.functionName,
      functionSignature: m.functionSignature,
    })),
  };
}
