
import type { TruthEntry, TruthScanResult } from './truth.js';
import { scanTruth } from './truth.js';

/** Issues found during analysis */
export interface AnalysisIssue {
  type: 'contradiction' | 'ambiguity' | 'missing' | 'question';
  description: string;
  sources: Array<{ file: string; line: number }>;
  severity: 'high' | 'medium' | 'low';
}

/** Analysis result */
export interface AnalysisResult {
  totalEntries: number;
  requirements: number;
  decisions: number;
  constraints: number;
  questions: number;
  issues: AnalysisIssue[];
  healthy: boolean;
}

/** Auto-decomposed Story suggestions */
export interface StorySuggestion {
  title: string;
  description: string;
  type: 'feature' | 'bug' | 'refactor' | 'chore';
  priority: string;
  checklist: Array<{ id: string; title: string }>;
  sourceEntries: TruthEntry[];
}

export function analyzeTruth(projectRoot: string): AnalysisResult {
  const scan = scanTruth(projectRoot);
  const issues: AnalysisIssue[] = [];

  const requirements = scan.entries.filter(e => e.type === 'requirement');
  const decisions = scan.entries.filter(e => e.type === 'decision');
  const constraints = scan.entries.filter(e => e.type === 'constraint');
  const questions = scan.entries.filter(e => e.type === 'question');

  // Issue 1: Unresolved questions
  for (const q of questions) {
    issues.push({
      type: 'question',
      description: `Unresolved question: ${q.summary}`,
      sources: [{ file: q.file, line: q.line }],
      severity: 'medium',
    });
  }

  // Issue 2: Requirements without corresponding decisions
  // Simple heuristic: if a requirement mentions a concept that no decision addresses
  if (requirements.length > 0 && decisions.length === 0) {
    issues.push({
      type: 'missing',
      description: `Has ${requirements.length} requirements but no technical decision records`,
      sources: requirements.slice(0, 3).map(r => ({ file: r.file, line: r.line })),
      severity: 'high',
    });
  }

  // Issue 3: Check for potential contradictions (same topic, different files, conflicting keywords)
  const fileGroups = new Map<string, TruthEntry[]>();
  for (const entry of scan.entries) {
    if (!fileGroups.has(entry.file)) fileGroups.set(entry.file, []);
    fileGroups.get(entry.file)!.push(entry);
  }

  // Cross-file contradiction check: look for requirements that mention the same entity
  // but with different descriptions (simplified heuristic)
  const reqByKeyword = new Map<string, TruthEntry[]>();
  for (const req of requirements) {
    // Extract key nouns (simplified: words > 3 chars that aren't common)
    const words = req.summary.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z_]{4,}/g) || [];
    for (const word of words) {
      const lower = word.toLowerCase();
      if (!reqByKeyword.has(lower)) reqByKeyword.set(lower, []);
      reqByKeyword.get(lower)!.push(req);
    }
  }

  for (const [keyword, entries] of reqByKeyword) {
    if (entries.length > 1) {
      const files = new Set(entries.map(e => e.file));
      if (files.size > 1) {
        issues.push({
          type: 'ambiguity',
          description: `Keyword "${keyword}" is mentioned in multiple files, possible inconsistency`,
          sources: entries.slice(0, 3).map(e => ({ file: e.file, line: e.line })),
          severity: 'low',
        });
      }
    }
  }

  return {
    totalEntries: scan.entries.length,
    requirements: requirements.length,
    decisions: decisions.length,
    constraints: constraints.length,
    questions: questions.length,
    issues,
    healthy: issues.filter(i => i.severity === 'high').length === 0,
  };
}

export function truthToStory(projectRoot: string): StorySuggestion[] {
  const scan = scanTruth(projectRoot);
  const requirements = scan.entries.filter(e => e.type === 'requirement');

  if (requirements.length === 0) return [];

  // Group requirements by source file (each file = one topic = one potential Story)
  const byFile = new Map<string, TruthEntry[]>();
  for (const req of requirements) {
    if (!byFile.has(req.file)) byFile.set(req.file, []);
    byFile.get(req.file)!.push(req);
  }

  const suggestions: StorySuggestion[] = [];
  let chkCounter = 1;

  for (const [file, entries] of byFile) {
    const topicName = file.replace(/\.md$/, '').replace(/[\\/]/g, ' ').trim();

    suggestions.push({
      title: `${topicName} feature implementation`,
      description: entries.map(e => e.summary).join('\n'),
      type: 'feature',
      priority: 'medium',
      checklist: entries.map((e, i) => ({
        id: `CHK-${String(chkCounter + i).padStart(3, '0')}`,
        title: e.summary.length > 80 ? e.summary.slice(0, 80) + '...' : e.summary,
      })),
      sourceEntries: entries,
    });

    chkCounter += entries.length;
  }

  return suggestions;
}
