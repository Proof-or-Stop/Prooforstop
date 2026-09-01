
import type { HandlerContext } from '@proof-or-stop/core/extension-api';
import { requireCoreRuntime } from '../core-runtime.js';
import { join, relative, dirname } from 'path';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';

const DEFAULT_DOC_DIRS = ['docs', 'requirements'];
const ROOT_DOC_FILES = ['CLAUDE.md', 'README.md', 'AGENTS.md'];
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'coverage',
  '.git', '.worktrees', '.next', '.cache',
]);

interface DocEntry {
  path: string;        // relative to project root
  title: string;       // first H1 line, or filename if no H1
  modifiedDays: number; // days since last modified
}

function extractH1(content: string): string {
  for (const line of content.split('\n', 50)) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1];
  }
  return '';
}

function scanMdDir(dir: string, root: string, out: DocEntry[], skipPaths: Set<string>): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      // Skip Proof-or-Stop-managed runtime data subtrees (storyDir / fixturesDir)
      const rel = relative(root, full).split('\\').join('/');
      if (skipPaths.has(rel)) continue;
      scanMdDir(full, root, out, skipPaths);
    } else if (e.isFile() && e.name.endsWith('.md') && !e.name.endsWith('.trace.md')) {
      try {
        const content = readFileSync(full, 'utf-8');
        const stat = statSync(full);
        const days = Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24));
        out.push({
          path: relative(root, full).split('\\').join('/'),
          title: extractH1(content) || e.name,
          modifiedDays: days,
        });
      } catch { /* ignore unreadable */ }
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
  const { root } = ctx;
  const { loadConfig } = requireCoreRuntime(ctx);
  return {
    /**
     * List project docs (for picking relatedDocs in the PLAN phase).
     * Scans the docDirs from the resolved project config (proof-or-stop.config.json) (defaults to docs/, requirements/),
     * plus CLAUDE.md / README.md / AGENTS.md at the project root.
     * Extracts the H1 title of each markdown file and groups the output by directory.
     */
    aux_doc_list(args?: { format?: 'text' | 'json' }): string {
      const config = loadConfig(root);
      const docDirs = config.docDirs ?? DEFAULT_DOC_DIRS;
      const all: DocEntry[] = [];
      // Proof-or-Stop-managed runtime data subtrees (story/fixtures); skipped while scanning
      const skipPaths = new Set<string>();
      if (config.storyDir) skipPaths.add(config.storyDir.split('\\').join('/'));
      if (config.fixturesDir) skipPaths.add(config.fixturesDir.split('\\').join('/'));
      // storyDir is usually docs/story/actives; also skip the parent docs/story
      if (config.storyDir) {
        const parent = dirname(config.storyDir).split('\\').join('/');
        if (parent !== '.' && parent !== '') skipPaths.add(parent);
      }

      // Fixed markdown files at the project root
      for (const name of ROOT_DOC_FILES) {
        const full = join(root, name);
        if (!existsSync(full)) continue;
        try {
          const content = readFileSync(full, 'utf-8');
          const stat = statSync(full);
          const days = Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24));
          all.push({
            path: name,
            title: extractH1(content) || name,
            modifiedDays: days,
          });
        } catch { /* ignore */ }
      }

      // Configured docDirs
      for (const dir of docDirs) {
        const full = join(root, dir);
        if (!existsSync(full)) continue;
        scanMdDir(full, root, all, skipPaths);
      }

      if (args?.format === 'json') {
        return JSON.stringify({ count: all.length, docs: all }, null, 2);
      }

      // text format: grouped by top-level directory
      const groups = new Map<string, DocEntry[]>();
      for (const d of all) {
        const top = d.path.includes('/') ? d.path.split('/')[0] + '/' : '<root>';
        if (!groups.has(top)) groups.set(top, []);
        groups.get(top)!.push(d);
      }

      const lines: string[] = [];
      lines.push(`# Project docs (${all.length} files)`);
      lines.push('');
      for (const [group, items] of groups.entries()) {
        items.sort((a, b) => a.path.localeCompare(b.path));
        lines.push(group === '<root>' ? '## (root)' : `## ${group}`);
        // Align the path column width
        const maxPath = Math.max(...items.map(i => i.path.length));
        for (const item of items) {
          const pad = ' '.repeat(Math.max(2, maxPath - item.path.length + 2));
          lines.push(`  ${item.path}${pad}# ${item.title}  [${formatAge(item.modifiedDays)}]`);
        }
        lines.push('');
      }
      lines.push('→ Put the paths above in a checklist item\'s relatedDocs field (a #anchor may be appended)');
      return lines.join('\n');
    },
  };
}
