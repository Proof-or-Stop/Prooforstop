/**
 * @task B-381e
 * @checklist CHK-001
 * @title story_authority_resolve handler (machine-readable surface)
 * @type feature
 * @priority high
 * @description
 *   Thin handler wrapping `resolveStoryAuthority` (core). The handler is
 *   intentionally L0 read-only: it never writes story state, never POSTs
 *   authority evidence, and never promotes local authority into a production
 *   receipt. Defaults to JSON output because the contract surface exists to
 *   stop adapters from parsing `session_brief` / `status` Markdown; the text
 *   format is a thin human convenience that only mirrors the same JSON fields.
 */

import {
  resolveStoryAuthority,
  type StoryAuthorityResolveResult,
} from '../core/story-authority-resolver.js';
import type { HandlerContext } from './context.js';

export interface StoryAuthorityResolveArgs {
  /** Restrict to specific story ids. */
  storyIds?: string[];
  /** Default `true` — only non-terminal stories. */
  activeOnly?: boolean;
  /** `json` (default) for machine consumers, `text` for human-readable summary. */
  format?: 'json' | 'text';
}

export function createStoryAuthorityResolveHandlers(
  ctx: HandlerContext,
): Record<string, (...args: any[]) => any> {
  return {
    story_authority_resolve(args: StoryAuthorityResolveArgs = {}): StoryAuthorityResolveResult | string {
      const result = resolveStoryAuthority(ctx.store, ctx.root, {
        storyIds: args.storyIds,
        activeOnly: args.activeOnly,
      });
      if (args.format === 'text') {
        return renderText(result);
      }
      return result;
    },
  };
}

function renderText(result: StoryAuthorityResolveResult): string {
  const header = [
    `story_authority_resolve (${result.schemaVersion})`,
    `readOnly=${result.readOnly} productionDone=${result.productionDone} receiptVerified=${result.receiptVerified} authorityChanged=${result.authorityChanged}`,
    `repoRoot: ${result.repoRoot}`,
    `stories: ${result.stories.length}`,
  ];
  const rows = result.stories.map((row) => {
    const wt = row.worktreePath ?? '(none)';
    const drift = row.mirrorPhase !== row.authoritativePhase ? ' [drift]' : '';
    return `  ${row.storyId} authority=${row.authority} mirror=${row.mirrorPhase} authoritative=${row.authoritativePhase}${drift} cwd=${row.authoritativeCwd} worktree=${wt}`;
  });
  return [...header, ...rows].join('\n');
}
