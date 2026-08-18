import type { HandlerContext } from './context.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import {
  currentGitHead,
  currentMaterialHash,
  currentStoryFilesHash,
} from '../core/evidence-freshness.js';
import { reportHealthIssue } from '../core/health.js';
import {
  persistFinalizedReviewInventory,
  renderFinalizedReviewInventory,
} from '../core/review-inventory-epoch.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';

function persistHint(root: string, storyId: string, command: string): string {
  try {
    return autoCommitStoryMetadata(root, storyId, command);
  } catch (error) {
    const reported = error instanceof Error ? error : { message: String(error) };
    reportHealthIssue(`persist:review-inventory:${command}`, reported, { storyId, root });
    return '';
  }
}

export function createReviewInventoryHandlers(ctx: HandlerContext) {
  return {
    review_inventory_finalize(args: { storyId: string }): string {
      const storyId = (args.storyId ?? '').trim();
      if (!storyId) throw new Error('review_inventory_finalize: storyId is required');

      const story = ctx.store.readStory(storyId);
      const gitCwd = resolveGitCwd({
        store: ctx.store,
        storyId,
        metadataRoot: ctx.root,
        projectRoot: ctx.root,
      });
      const headHash = currentGitHead(gitCwd);
      const materialHash = currentMaterialHash(gitCwd, 'HEAD', ctx.root);
      const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', ctx.root);
      if (!headHash || !materialHash || !storyFilesHash) {
        throw new Error(
          'review_inventory_finalize: current headHash/materialHash/storyFilesHash are missing; refuse rather than invent a second freshness hash',
        );
      }

      const persisted = persistFinalizedReviewInventory({
        store: ctx.store,
        storyId,
        reviewRound: story.currentReviewRound ?? '',
        cutoff: { headHash, materialHash, storyFilesHash },
      });
      const hint = persistHint(ctx.root, storyId, 'review_inventory_finalize');
      const rendered = renderFinalizedReviewInventory(persisted.epoch, persisted.receipt);
      return hint ? `${rendered}${hint}` : rendered;
    },
  };
}
