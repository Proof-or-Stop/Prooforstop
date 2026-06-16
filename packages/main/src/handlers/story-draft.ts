
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
  // ctx.root points to <projectRoot> (where lattice.config lives).
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
        throw new Error('name must be 3-60 characters (alphanumeric + hyphens)');
      }
      if (!NAME_REGEX.test(args.name)) {
        throw new Error('name allows only alphanumeric and hyphens (cannot start/end with a hyphen)');
      }

      // Validate title
      if (!args.title || args.title.length < 5) {
        throw new Error('title must be >= 5 characters');
      }

      // Validate description
      if (!args.description || args.description.length < 5) {
        throw new Error('description must be >= 5 characters');
      }

      // Validate checklist
      if (!args.checklist || args.checklist.length < 1) {
        throw new Error('checklist requires at least 1 item');
      }

      // Validate background (4-section format)
      if (typeof args.background !== 'string' || args.background.length === 0) {
        throw new Error(
          'background is required (four-section format)\n' +
          'Expected 4 sections: "## Trigger Event" / "## Key Insights" / "## Solution Tradeoffs" / "## Conversational Texture"\n' +
          'Each section >= 50 characters, total length >= 300 characters, the trigger event section must include a specific identifier'
        );
      }
      const bgResult = validateBackground(args.background);
      if (!bgResult.ok) {
        throw new Error(
          'background format validation failed:\n' +
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
        throw new Error('name is required');
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
