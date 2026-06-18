/**
 * @task B-5155
 * @checklist CHK-002
 * @title Map project requirementsDir config to truth scan/navigation roots
 * @type chore
 * @priority high
 * @description
 *   scanTruth and generateNav resolve `loadConfig(projectRoot).requirementsDir`
 *   to locate the project's requirements source of truth and build the NAV
 *   index from that directory.
 *   This is local truth-source coverage only; it does not claim any Authority
 *   Server completion.
 * @changes
 *   - Add a truthful B-5155 anchor on the real requirementsDir consumer
 *     without changing runtime behavior.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, lstatSync } from 'fs';
import { join, relative, basename } from 'path';
import { loadConfig } from '../core/config.js';

/**
 * B-b9d0 CHK-003: derived runtime directories that must be skipped while
 * collecting markdown truth sources. docs/story and docs/requirements are
 * intentionally absent — they must remain visible to convergence scanning.
 */
const TRUTH_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.build',
  '.next', '.turbo', '.cache', '.svelte-kit', '.parcel-cache',
  '__pycache__',
  '.worktrees',
]);

/** Entry extracted from md file */
export interface TruthEntry {
  /** Source file (relative path) */
  file: string;
  /** Entry type */
  type: 'requirement' | 'decision' | 'constraint' | 'question';
  /** Content summary */
  summary: string;
  /** Line number */
  line: number;
}

/** Scan result */
export interface TruthScanResult {
  filesScanned: number;
  entries: TruthEntry[];
  topics: string[];
  _summary?: string;
}

/** Recursively collect md files */
function collectMdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (TRUTH_SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    // B-b9d0 CHK-003: lstatSync + symlink skip prevents ELOOP on derived
    // .build/checkouts trees (SwiftPM GRDB CustomSQLite).
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      try {
        results.push(...collectMdFiles(full));
      } catch {
        // Defensive: keep scanning siblings if a derived tree raises an error.
      }
    } else if (entry.endsWith('.md') && entry !== 'NAV.md') {
      results.push(full);
    }
  }
  return results;
}

/**
 * Extract requirements, decisions, constraints from md content
 *
 * Recognition rules:
 * - Paragraphs starting with or containing "requirement", "requires", "must", "should" → requirement
 * - Paragraphs starting with "decide", "decision", "choose", "adopt" → decision
 * - Paragraphs starting with "constraint", "restriction", "cannot", "prohibit" → constraint
 * - Paragraphs ending with "?" or a Unicode full-width question mark, or containing "pending", "to be confirmed" → question
 */
const QUESTION_RE = /[?\uff1f]$|pending|to be confirmed|to be discussed|TBD/iu;
const REQUIREMENT_RE = /requirement|requires|must|should|need to support|user can|support/iu;
const DECISION_RE = /decide|decision|choose|adopt|confirmed to use|solution/iu;
const CONSTRAINT_RE = /constraint|restriction|cannot|prohibit|not allowed|not permitted/iu;

function extractEntries(content: string, file: string): TruthEntry[] {
  const entries: TruthEntry[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    // Strip markdown list markers
    const text = line.replace(/^[-*>]\s*/, '').trim();
    if (text.length < 5) continue;

    let type: TruthEntry['type'] | null = null;

    if (QUESTION_RE.test(text)) {
      type = 'question';
    } else if (REQUIREMENT_RE.test(text)) {
      type = 'requirement';
    } else if (DECISION_RE.test(text)) {
      type = 'decision';
    } else if (CONSTRAINT_RE.test(text)) {
      type = 'constraint';
    }

    if (type) {
      entries.push({
        file,
        type,
        summary: text.length > 200 ? text.slice(0, 200) + '...' : text,
        line: i + 1,
      });
    }
  }

  return entries;
}

export function scanTruth(projectRoot: string, options?: { summary?: boolean }): TruthScanResult {
  const config = loadConfig(projectRoot);
  const reqDir = join(projectRoot, config.requirementsDir);

  // Scan decisions/ and extracted/ subdirectories, also scan md in root directory
  const dirs = [reqDir, join(reqDir, 'decisions'), join(reqDir, 'extracted')];
  const fileSet = new Set<string>();
  for (const d of dirs) {
    if (existsSync(d)) {
      for (const f of collectMdFiles(d)) fileSet.add(f);
    }
  }
  const files = [...fileSet];

  const topicSet = new Set<string>();
  const fileSummaries: Array<{ file: string; topic: string; entryCount: number }> = [];

  // summary mode: only count, do not return all entries
  if (options?.summary) {
    for (const filePath of files) {
      const content = readFileSync(filePath, 'utf-8');
      const rel = relative(reqDir, filePath);
      const entries = extractEntries(content, rel);
      const headingMatch = content.match(/^#\s+(.+)/m);
      const topic = headingMatch ? headingMatch[1].trim() : basename(rel, '.md');
      topicSet.add(topic);
      fileSummaries.push({ file: rel, topic, entryCount: entries.length });
    }
    return {
      filesScanned: files.length,
      entries: [],
      topics: [...topicSet],
      _summary: fileSummaries.map(f => `${f.file} (${f.topic}): ${f.entryCount} entries`).join('\n'),
    };
  }

  // full mode
  const allEntries: TruthEntry[] = [];
  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const rel = relative(reqDir, filePath);
    const entries = extractEntries(content, rel);
    allEntries.push(...entries);
    const headingMatch = content.match(/^#\s+(.+)/m);
    const topic = headingMatch ? headingMatch[1].trim() : basename(rel, '.md');
    topicSet.add(topic);
  }

  return {
    filesScanned: files.length,
    entries: allEntries,
    topics: [...topicSet],
  };
}

export function generateNav(projectRoot: string): string {
  const config = loadConfig(projectRoot);
  const reqDir = join(projectRoot, config.requirementsDir);
  const files = collectMdFiles(reqDir);

  if (files.length === 0) {
    return 'No requirement files found in docs/requirements/';
  }

  const lines: string[] = ['# Source of Truth Navigation', '', `> ${files.length} files`, ''];

  // Group by subdirectory
  const groups = new Map<string, Array<{ rel: string; title: string }>>();

  for (const filePath of files) {
    const rel = relative(reqDir, filePath);
    const parts = rel.split(/[\\/]/);
    const group = parts.length > 1 ? parts[0] : 'root';

    const content = readFileSync(filePath, 'utf-8');
    const headingMatch = content.match(/^#\s+(.+)/m);
    const title = headingMatch ? headingMatch[1].trim() : basename(rel, '.md');

    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push({ rel, title });
  }

  for (const [group, items] of groups) {
    lines.push(`## ${group}`);
    lines.push('');
    for (const item of items) {
      lines.push(`- [${item.title}](${item.rel})`);
    }
    lines.push('');
  }

  // Write NAV.md
  const navPath = join(reqDir, 'NAV.md');
  writeFileSync(navPath, lines.join('\n'), 'utf-8');

  return lines.join('\n');
}
