
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'fs';
import { join, relative, basename } from 'path';
import { loadConfig } from '../core/config.js';

/** 从 md 文件中提取的条目 */
export interface TruthEntry {
  /** 来源文件（相对路径） */
  file: string;
  /** 条目类型 */
  type: 'requirement' | 'decision' | 'constraint' | 'question';
  /** 内容摘要 */
  summary: string;
  /** 所在行号 */
  line: number;
}

/** 扫描结果 */
export interface TruthScanResult {
  filesScanned: number;
  entries: TruthEntry[];
  topics: string[];
  _summary?: string;
}

/** 递归收集 md 文件 */
function collectMdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectMdFiles(full));
    } else if (entry.endsWith('.md') && entry !== 'NAV.md') {
      results.push(full);
    }
  }
  return results;
}

/**
 * 从 md 内容中提取需求点、决策、约束
 *
 * 识别规则：
 * - 以"需求"、"要求"、"必须"、"应该"开头或包含这些词的段落 → requirement
 * - 以"决定"、"决策"、"选择"、"采用"开头的段落 → decision
 * - 以"约束"、"限制"、"不能"、"禁止"开头的段落 → constraint
 * - 以"?"、"？"结尾或包含"待定"、"待确认"的段落 → question
 */
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

    if (/[?？]$/.test(text) || /待定|待确认|待讨论|TBD/i.test(text)) {
      type = 'question';
    } else if (/需求|要求|必须|应该|需要支持|用户可以|支持/.test(text)) {
      type = 'requirement';
    } else if (/决定|决策|选择|采用|确定使用|方案/.test(text)) {
      type = 'decision';
    } else if (/约束|限制|不能|禁止|不允许|不可以/.test(text)) {
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

  // 扫描 decisions/ 和 extracted/ 两个子目录，也扫根目录的 md
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

  // summary 模式：只统计，不返回全部 entries
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

  // 完整模式
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

  const lines: string[] = ['# 真相源导航', '', `> ${files.length} 个文件`, ''];

  // Group by subdirectory
  const groups = new Map<string, Array<{ rel: string; title: string }>>();

  for (const filePath of files) {
    const rel = relative(reqDir, filePath);
    const parts = rel.split(/[\\/]/);
    const group = parts.length > 1 ? parts[0] : '根目录';

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
