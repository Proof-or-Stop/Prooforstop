import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildCanonicalStory } from '../core/canonical-story.js';
import type { HandlerContext } from './context.js';

function writeJsonNoOverwrite(file: string, value: unknown): void {
  if (existsSync(file)) throw new Error(`refusing to overwrite existing file: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function createStoryExportHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    story_export(args: { storyId: string; format?: 'text' | 'json'; output?: string }) {
      const result = buildCanonicalStory(ctx.store, ctx.root, args.storyId);
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, result.story);
      }

      if (args.format === 'json') return result.story;

      const receiptNote = result.story.authority.receiptRefs.length > 0
        ? `${result.story.authority.receiptRefs.length} unverified receipt ref(s); local assurance only`
        : 'no signed/offline receipt bundle refs; local assurance only';
      const warningNote = result.warnings.length > 0
        ? `; degradations=${result.story.degradations.length}`
        : '';
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [
        `Canonical Story export (${result.story.schemaVersion})`,
        `storyId: ${result.story.storyId}`,
        `phase: ${result.story.lifecycle.phase}`,
        `localDone: ${result.story.lifecycle.localDone}`,
        `admissibilityStatus: canonical-story-export`,
        `assuranceLevel: local`,
        `evidenceScope: story-export`,
        `localAssurance: ${receiptNote}${warningNote}`,
        `evidence: ${result.story.evidence.length}`,
        `reviews: ${result.story.reviews.length}`,
        outputNote.trimEnd(),
      ].filter(Boolean).join('\n');
    },
  };
}
