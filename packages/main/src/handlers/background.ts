/**
 * background CLI trio — B-45ed CHK-007
 *
 * background.md is the "why" dimension (first layer) in the source-of-truth hierarchy,
 * fixed path: docs/story/actives/{storyId}/background.md
 *
 * Three commands:
 *   - background_set({ storyId, content })        full overwrite, reuses CHK-006's validateBackground format check
 *   - background_append({ storyId, section, content }) appends content to the end of the specified section, leaves other sections untouched
 *   - background_get({ storyId })                  returns current background.md content
 *
 * Design constraints:
 *   - Does not read/write paths outside docs/story/actives/{storyId}/
 *   - append's section whitelist = BACKGROUND_SECTION_IDS (4 entries); legacy Chinese section names are normalized at entry
 *   - When background.md does not exist, append / get errors out and points to `background_set`
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { HandlerContext } from './context.js';
import {
  BACKGROUND_SECTION_IDS,
  REQUIRED_SECTIONS,
  backgroundSectionTitle,
  normalizeBackgroundSection,
  parseSections,
  validateBackground,
} from '../core/background-validator.js';

function backgroundPath(ctx: HandlerContext, storyId: string): string {
  return ctx.store.storyFilePath(storyId, 'background.md');
}

export function createBackgroundHandlers(ctx: HandlerContext) {
  return {
    background_get(args: { storyId: string }): { content: string } {
      if (!args.storyId) throw new Error('storyId is required');
      const p = backgroundPath(ctx, args.storyId);
      if (!existsSync(p)) {
        throw new Error(
          `background.md not found for ${args.storyId}, use background_set first`
        );
      }
      return { content: readFileSync(p, 'utf-8') };
    },

    background_set(args: { storyId: string; content: string }): { path: string; bytes: number } {
      if (!args.storyId) throw new Error('storyId is required');
      if (typeof args.content !== 'string') throw new Error('content is required (string)');

      const result = validateBackground(args.content);
      if (!result.ok) {
        throw new Error(
          'background format validation failed:\n' +
          result.errors.map(e => `  - ${e}`).join('\n') + '\n' +
          'expected 4 sections: "## Trigger Event" / "## Key Insights" / "## Solution Tradeoffs" / "## Conversational Texture"\n' +
          'each section ≥ 50 chars, total length ≥ 300 chars, the trigger event section must include a concrete id'
        );
      }

      const p = backgroundPath(ctx, args.storyId);
      // ensure trailing newline, consistent with story_create on-disk convention
      const content = args.content.endsWith('\n') ? args.content : args.content + '\n';
      writeFileSync(p, content, 'utf-8');
      return { path: p, bytes: Buffer.byteLength(content, 'utf-8') };
    },

    background_append(args: {
      storyId: string;
      section: string;
      content: string;
    }): { path: string; section: string; appendedBytes: number } {
      if (!args.storyId) throw new Error('storyId is required');
      if (!args.section) throw new Error('section is required');
      if (typeof args.content !== 'string' || args.content.length === 0) {
        throw new Error('content is required (non-empty string)');
      }

      const targetSectionId = normalizeBackgroundSection(args.section);
      if (!targetSectionId) {
        throw new Error(
          `illegal section "${args.section}"; valid section ids: ${BACKGROUND_SECTION_IDS.map(s => `"${s}"`).join(' / ')}; ` +
          `legacy Chinese section name compatibility: ${REQUIRED_SECTIONS.map(s => `"${s}"`).join(' / ')}`
        );
      }
      const targetSection = backgroundSectionTitle(targetSectionId);

      const p = backgroundPath(ctx, args.storyId);
      if (!existsSync(p)) {
        throw new Error(
          `background.md not found for ${args.storyId}, use background_set first`
        );
      }

      const original = readFileSync(p, 'utf-8');
      const lines = original.split(/\r?\n/);
      // record whether the original ends with a newline (split produces a trailing empty string); preserve when writing back
      const hadTrailingNewline = original.endsWith('\n');
      const workLines = hadTrailingNewline && lines[lines.length - 1] === ''
        ? lines.slice(0, -1)
        : lines;

      // locate target section: section header line index + section end index (next "## " or EOF)
      let startIdx = -1;
      for (let i = 0; i < workLines.length; i++) {
        const m = workLines[i].match(/^##\s+(.+?)\s*$/);
        if (m && m[1] === targetSection) { startIdx = i; break; }
      }
      if (startIdx === -1) {
        // section header missing (background.md missing the section) — error out and point to background_set to fix the format
        const existing = parseSections(original);
        throw new Error(
          `Section "## ${targetSection}" not found in background.md; ` +
          `current section headers: ${existing.headers.length > 0 ? existing.headers.map(h => `"## ${h}"`).join(', ') : '(none)'}; ` +
          `please fix the four-section format with background_set first`
        );
      }

      let endIdx = workLines.length;
      for (let i = startIdx + 1; i < workLines.length; i++) {
        if (/^##\s+/.test(workLines[i])) { endIdx = i; break; }
      }

      // Walk backward, skipping trailing blank lines at the end of the section, to find the insertion point after the last non-empty content line
      let insertAfter = endIdx - 1;
      while (insertAfter > startIdx && workLines[insertAfter].trim() === '') {
        insertAfter--;
      }

      // Append: insert new content after insertAfter (original section content + \n + content)
      const contentLines = args.content.split(/\r?\n/);
      const newLines = [
        ...workLines.slice(0, insertAfter + 1),
        ...contentLines,
        ...workLines.slice(insertAfter + 1),
      ];
      const rebuilt = newLines.join('\n') + (hadTrailingNewline ? '\n' : '');
      writeFileSync(p, rebuilt, 'utf-8');
      return {
        path: p,
        section: targetSectionId,
        appendedBytes: Buffer.byteLength(args.content, 'utf-8'),
      };
    },
  };
}
