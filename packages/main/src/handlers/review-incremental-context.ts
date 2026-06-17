/**
 * B-f675 CHK-002: lattice review_incremental_context CLI
 *
 * Read-only command that prints a reviewer role's prior verdict + the diff since
 * its last pass headHash + a scopeChanged flag, by delegating to the pure
 * read-only helper core/review-incremental-context.ts. It writes nothing, has no
 * gate side effects, and never touches canPassReviewGuard / review-run bindings.
 *
 * Mirrors the read-only registration shape of handlers/reviewer-list.ts
 * (createReviewerListHandlers): a handler factory returning a command keyed by
 * its schema name, wired through registry.registerBatch in registry.ts.
 */

import type { HandlerContext } from './context.js';
import { reviewIncrementalContext } from '../core/review-incremental-context.js';

function renderIncrementalContextText(
  ctx: ReturnType<typeof reviewIncrementalContext>,
): string {
  const lines: string[] = [];
  lines.push(`role: ${ctx.role}`);
  lines.push(`isFirstPass: ${ctx.isFirstPass}`);
  lines.push(`scopeChanged: ${ctx.scopeChanged}`);
  lines.push(`priorHeadHash: ${ctx.priorHeadHash ?? '(none)'}`);
  lines.push(`priorVerdict: ${ctx.priorVerdict ?? '(none)'}`);
  if (ctx.changedFiles.length === 0) {
    lines.push('changedFiles: (none)');
  } else {
    lines.push(`changedFiles (${ctx.changedFiles.length}):`);
    for (const file of ctx.changedFiles) lines.push(`  ${file}`);
  }
  return lines.join('\n');
}

export function createReviewIncrementalContextHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;
  return {
    review_incremental_context(args: { storyId: string; role: string; json?: boolean }): string {
      const storyId = (args.storyId || '').trim();
      const role = (args.role || '').trim();
      if (!storyId) {
        throw new Error('review_incremental_context: storyId is required');
      }
      if (!role) {
        throw new Error('review_incremental_context: role is required (e.g. concept / quality / test-coverage / behavior / docs)');
      }
      const result = reviewIncrementalContext(store, root, storyId, role);
      if (args.json) {
        return JSON.stringify(result);
      }
      return renderIncrementalContextText(result);
    },
  };
}
