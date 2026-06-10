import { join, isAbsolute } from 'node:path';
import type { HandlerContext } from './context.js';

type FormatArgs = { json?: boolean; format?: 'text' | 'json' };

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

export function createStoryResolveHandlers(ctx: HandlerContext) {
  return {
    story_resolve(args: { storyId: string } & FormatArgs) {
      const story = ctx.store.readStory(args.storyId);
      const configuredWorktree = story.worktree?.path
        ? isAbsolute(story.worktree.path)
          ? story.worktree.path
          : join(ctx.root, story.worktree.path)
        : null;
      const result = {
        schemaVersion: 'lattice.story_resolve.v1' as const,
        storyId: story.storyId,
        phase: story.phase,
        exists: true,
        storyDir: ctx.store.storyDirPath(story.storyId),
        worktree: story.worktree ?? null,
        authoritativeCwd: configuredWorktree ?? ctx.root,
        requiresWorktree: story.phase !== 'INIT' && story.phase !== 'DONE' && story.phase !== 'DISCARDED',
      };
      if (wantsJson(args)) return result;
      return [
        `Lattice story resolve (${result.schemaVersion})`,
        `storyId: ${result.storyId}`,
        `phase: ${result.phase}`,
        `authoritativeCwd: ${result.authoritativeCwd}`,
        `requiresWorktree: ${result.requiresWorktree}`,
      ].join('\n');
    },
  };
}
