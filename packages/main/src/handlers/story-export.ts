import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildCanonicalStory } from '../core/canonical-story.js';
import type { HandlerContext } from './context.js';

export function createStoryExportHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    story_export(args: { storyId: string; format?: 'text' | 'json'; output?: string }) {
      const result = buildCanonicalStory(ctx.store, ctx.root, args.storyId);
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, JSON.stringify(result.story, null, 2) + '\n', 'utf8');
      }

      if (args.format === 'json') return result.story;

      const receiptNote = result.story.authority.receiptRefs.length > 0
        ? `${result.story.authority.receiptRefs.length} receipt ref(s)`
        : 'no server receipt refs; productionDone=false';
      const warningNote = result.warnings.length > 0
        ? `; degradations=${result.story.degradations.length}`
        : '';
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [
        `Canonical Story export (${result.story.schemaVersion})`,
        `storyId: ${result.story.storyId}`,
        `phase: ${result.story.lifecycle.phase}`,
        `localDone: ${result.story.lifecycle.localDone}`,
        `productionDone: ${result.story.lifecycle.productionDone}`,
        `authority: ${receiptNote}${warningNote}`,
        `evidence: ${result.story.evidence.length}`,
        `reviews: ${result.story.reviews.length}`,
        outputNote.trimEnd(),
      ].filter(Boolean).join('\n');
    },
  };
}
