import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { HandlerContext } from './context.js';

function planPath(ctx: HandlerContext, storyId: string): string {
  return ctx.store.storyFilePath(storyId, 'plan.md');
}

function missingChecklistSections(ctx: HandlerContext, storyId: string, content: string): string[] {
  const checklist = ctx.store.readChecklist(storyId);
  return checklist.items
    .map(item => item.id)
    .filter(id => !new RegExp(`^##\\s+${id}\\b`, 'm').test(content));
}

export function createPlanHandlers(ctx: HandlerContext) {
  return {
    plan_get(args: { storyId: string }): { content: string } {
      if (!args.storyId) throw new Error('storyId is required');
      const p = planPath(ctx, args.storyId);
      if (!existsSync(p)) {
        throw new Error(`plan.md not found for ${args.storyId}, use plan_set first`);
      }
      return { content: readFileSync(p, 'utf-8') };
    },

    plan_set(args: { storyId: string; content: string }): { path: string; bytes: number; checklistSections: number } {
      if (!args.storyId) throw new Error('storyId is required');
      if (typeof args.content !== 'string' || args.content.trim().length < 20) {
        throw new Error('plan_set: content must be plan.md content of at least 20 characters');
      }
      ctx.store.readStory(args.storyId);
      const missing = missingChecklistSections(ctx, args.storyId, args.content);
      if (missing.length > 0) {
        throw new Error(`plan_set: plan.md is missing checklist sections: ${missing.join(', ')}. Each item requires a section like "## CHK-001"`);
      }
      const content = args.content.endsWith('\n') ? args.content : `${args.content}\n`;
      const p = planPath(ctx, args.storyId);
      writeFileSync(p, content, 'utf-8');
      return {
        path: p,
        bytes: Buffer.byteLength(content, 'utf-8'),
        checklistSections: ctx.store.readChecklist(args.storyId).items.length,
      };
    },
  };
}
