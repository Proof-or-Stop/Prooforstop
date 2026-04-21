
import type { HandlerContext } from './context.js';
import { validateBackground } from '../core/background-validator.js';
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * B-9975 CHK-001: story_draft handler
 *
 * Writes draft story content to docs/story/drafts/<name>/ without allocating a B-xxxx story id.
 * Allows iterating on story shape before committing to formal story_create.
 */

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,58}[a-zA-Z0-9]$/;

function getDraftsDir(ctx: HandlerContext): string {
  // ctx.root points to <projectRoot> (where koala.config lives).
  // Drafts go to <projectRoot>/docs/story/drafts/
  return join(ctx.root, 'docs', 'story', 'drafts');
}

export function createStoryDraftHandlers(ctx: HandlerContext) {
  return {
    story_draft(args: {
      name: string;
      title: string;
      description: string;
      type: string;
      priority: string;
      checklist: Array<{ title: string; context?: string }>;
      background: string;
      keywords?: string[];
    }): string {
      // Validate name
      if (!args.name || args.name.length < 3 || args.name.length > 60) {
        throw new Error('name 必须 3-60 字符（字母数字 + 连字符）');
      }
      if (!NAME_REGEX.test(args.name)) {
        throw new Error('name 只允许字母数字和连字符（不能以连字符开头/结尾）');
      }

      // Validate title
      if (!args.title || args.title.length < 5) {
        throw new Error('title 必须 >= 5 字符');
      }

      // Validate description
      if (!args.description || args.description.length < 5) {
        throw new Error('description 必须 >= 5 字符');
      }

      // Validate checklist
      if (!args.checklist || args.checklist.length < 1) {
        throw new Error('checklist 至少需要 1 项');
      }

      // Validate background (4-section format)
      if (typeof args.background !== 'string' || args.background.length === 0) {
        throw new Error(
          'background 必填（四段式格式）\n' +
          '期望 4 段: "## 触发事件" / "## 关键洞察" / "## 方案取舍" / "## 对话纹理"\n' +
          '每段 ≥ 50 字符，总长 ≥ 300 字符，触发事件段须含具体编号'
        );
      }
      const bgResult = validateBackground(args.background);
      if (!bgResult.ok) {
        throw new Error(
          'background 格式校验失败:\n' +
          bgResult.errors.map(e => `  - ${e}`).join('\n')
        );
      }

      // Check uniqueness
      const draftsDir = getDraftsDir(ctx);
      const draftDir = join(draftsDir, args.name);
      if (existsSync(draftDir)) {
        throw new Error(`Draft '${args.name}' already exists. Use story_draft_discard to remove it first.`);
      }

      // Write files
      mkdirSync(draftDir, { recursive: true });

      // background.md
      const bgContent = args.background.endsWith('\n') ? args.background : args.background + '\n';
      writeFileSync(join(draftDir, 'background.md'), bgContent, 'utf-8');

      // checklist.json
      const now = new Date().toISOString();
      const checklist = {
        items: args.checklist.map((c, i) => ({
          id: `CHK-${String(i + 1).padStart(3, '0')}`,
          title: c.title,
          ...(c.context ? { context: c.context } : {}),
          status: 'pending' as const,
          startTime: null,
          endTime: null,
        })),
      };
      writeFileSync(join(draftDir, 'checklist.json'), JSON.stringify(checklist, null, 2) + '\n', 'utf-8');

      // index.json
      const index = {
        name: args.name,
        title: args.title,
        description: args.description,
        type: args.type,
        priority: args.priority,
        keywords: args.keywords ?? [],
        createdAt: now,
      };
      writeFileSync(join(draftDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf-8');

      return `Draft '${args.name}' created at docs/story/drafts/${args.name}/`;
    },

    story_draft_list(): string {
      const draftsDir = getDraftsDir(ctx);
      if (!existsSync(draftsDir)) {
        return 'No drafts found.';
      }

      const entries = readdirSync(draftsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      if (entries.length === 0) {
        return 'No drafts found.';
      }

      const lines: string[] = [`Drafts (${entries.length}):`];
      for (const entry of entries) {
        const indexPath = join(draftsDir, entry.name, 'index.json');
        try {
          const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
          lines.push(`  - ${entry.name}: ${index.title || '(no title)'}`);
        } catch {
          lines.push(`  - ${entry.name}: (index.json unreadable)`);
        }
      }
      return lines.join('\n');
    },

    story_draft_discard(args: { name: string }): string {
      if (!args.name) {
        throw new Error('name 必填');
      }
      const draftsDir = getDraftsDir(ctx);
      const draftDir = join(draftsDir, args.name);
      if (!existsSync(draftDir)) {
        throw new Error(`Draft '${args.name}' does not exist.`);
      }

      // Collect file list before deletion
      const files: string[] = [];
      const collectFiles = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            collectFiles(full);
          } else {
            files.push(full.replace(draftDir + '/', '').replace(draftDir + '\\', ''));
          }
        }
      };
      collectFiles(draftDir);

      rmSync(draftDir, { recursive: true, force: true });

      return `Draft '${args.name}' discarded. Deleted files:\n` +
        files.map(f => `  - ${f}`).join('\n');
    },
  };
}
