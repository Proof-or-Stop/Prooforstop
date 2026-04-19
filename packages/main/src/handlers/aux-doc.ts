/**
 * @task B-d139
 * @checklist CHK-003
 * @title core CLI exposes aux_doc_list without utils bootstrap
 * @type bugfix
 * @priority high
 * @description
 *   AGENTS requires aux_doc_list before related work, but the core-only
 *   global koala binary previously did not include that command. Keep the
 *   document-listing behavior in core so default installs can satisfy the
 *   workflow, while utils bootstrap remains compatible through duplicate
 *   registration guards.
 * @changes
 *   - [CHK-003] Add a core aux_doc_list handler that scans root docs and configured doc dirs
 *   - [CHK-003] Skip Koala-managed story/fixture runtime directories from relatedDocs candidates
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { loadConfig } from '../core/config.js';
import type { HandlerContext } from './context.js';

const DEFAULT_DOC_DIRS = ['docs', 'requirements'];
const ROOT_DOC_FILES = ['CLAUDE.md', 'README.md', 'AGENTS.md'];
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'coverage',
  '.git', '.worktrees', '.next', '.cache',
]);

interface DocEntry {
  path: string;
  title: string;
  modifiedDays: number;
}

function normalizeRel(path: string): string {
  return path.split('\\').join('/');
}

function extractH1(content: string): string {
  for (const line of content.split('\n', 50)) {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match) return match[1];
  }
  return '';
}

function scanMdDir(dir: string, root: string, out: DocEntry[], skipPaths: Set<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const rel = normalizeRel(relative(root, full));
      if (skipPaths.has(rel)) continue;
      scanMdDir(full, root, out, skipPaths);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.endsWith('.trace.md')) continue;
    try {
      const content = readFileSync(full, 'utf-8');
      const stat = statSync(full);
      out.push({
        path: normalizeRel(relative(root, full)),
        title: extractH1(content) || entry.name,
        modifiedDays: Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24)),
      });
    } catch {
      // PROBE: unreadable docs should not block planning context discovery.
    }
  }
}

function formatAge(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return '1 week ago';
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return '1 month ago';
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

export function createAuxDocHandlers(ctx: HandlerContext) {
  return {
    aux_doc_list(args?: { format?: 'text' | 'json' }): string {
      const config = loadConfig(ctx.root);
      const docDirs = config.docDirs ?? DEFAULT_DOC_DIRS;
      const all: DocEntry[] = [];
      const skipPaths = new Set<string>();

      if (config.storyDir) {
        const storyDir = normalizeRel(config.storyDir);
        skipPaths.add(storyDir);
        const storyParent = normalizeRel(dirname(storyDir));
        if (storyParent !== '.' && storyParent !== '') skipPaths.add(storyParent);
      }
      if (config.fixturesDir) skipPaths.add(normalizeRel(config.fixturesDir));

      for (const name of ROOT_DOC_FILES) {
        const full = join(ctx.root, name);
        if (!existsSync(full)) continue;
        try {
          const content = readFileSync(full, 'utf-8');
          const stat = statSync(full);
          all.push({
            path: name,
            title: extractH1(content) || name,
            modifiedDays: Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24)),
          });
        } catch {
          // PROBE: optional root docs may be unreadable in partial checkouts.
        }
      }

      for (const dir of docDirs) {
        const full = join(ctx.root, dir);
        if (existsSync(full)) scanMdDir(full, ctx.root, all, skipPaths);
      }

      if (args?.format === 'json') return JSON.stringify({ count: all.length, docs: all }, null, 2);

      const groups = new Map<string, DocEntry[]>();
      for (const doc of all) {
        const top = doc.path.includes('/') ? `${doc.path.split('/')[0]}/` : '<root>';
        if (!groups.has(top)) groups.set(top, []);
        groups.get(top)!.push(doc);
      }

      const lines: string[] = [`# Project docs (${all.length} files)`, ''];
      for (const [group, items] of groups.entries()) {
        items.sort((a, b) => a.path.localeCompare(b.path));
        lines.push(group === '<root>' ? '## (root)' : `## ${group}`);
        const maxPath = Math.max(...items.map((item) => item.path.length));
        for (const item of items) {
          const pad = ' '.repeat(Math.max(2, maxPath - item.path.length + 2));
          lines.push(`  ${item.path}${pad}# ${item.title}  [${formatAge(item.modifiedDays)}]`);
        }
        lines.push('');
      }
      lines.push('→ 在 checklist item 的 relatedDocs 字段填写上述路径（可带 #锚点）');
      return lines.join('\n');
    },
  };
}
