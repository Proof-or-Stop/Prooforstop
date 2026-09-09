import type { HandlerContext } from './context.js';
import { resolveStorySignedWorkspace } from '../core/story-signed-workspace-resolution.js';

type FormatArgs = { json?: boolean; format?: 'text' | 'json' };

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

export function createStoryResolveHandlers(ctx: HandlerContext) {
  return {
    story_resolve(args: { storyId: string } & FormatArgs) {
      const story = ctx.store.readStory(args.storyId);
      const resolution = resolveStorySignedWorkspace({
        store: ctx.store,
        storyId: args.storyId,
        metadataRoot: ctx.root,
      });
      const result = {
        schemaVersion: 'proof-or-stop.story_resolve.v1' as const,
        storyId: story.storyId,
        phase: story.phase,
        exists: true,
        storyDir: resolution.storyDir,
        worktree: story.worktree ?? null,
        authoritativeCwd: resolution.authoritativeCwd,
        requiresWorktree: resolution.requiresWorktree,
        metadataRoot: resolution.metadataRoot,
        signedWorkspaceRoot: resolution.signedWorkspaceRoot,
        repoRoot: resolution.repoRoot,
        resolved: resolution.resolved,
        resolutionSource: resolution.resolutionSource,
        worktreePath: resolution.worktreePath,
        unresolvedReason: resolution.unresolvedReason,
      };
      if (wantsJson(args)) return result;
      return [
        `Proof-or-Stop story resolve (${result.schemaVersion})`,
        `storyId: ${result.storyId}`,
        `phase: ${result.phase}`,
        `metadataRoot: ${result.metadataRoot}`,
        `signedWorkspaceRoot: ${result.signedWorkspaceRoot ?? 'unresolved'}`,
        `repoRoot: ${result.repoRoot ?? 'unresolved'}`,
        `authoritativeCwd: ${result.authoritativeCwd ?? 'unresolved'}`,
        `resolved: ${result.resolved}`,
        `resolutionSource: ${result.resolutionSource}`,
        ...(result.unresolvedReason ? [`unresolvedReason: ${result.unresolvedReason}`] : []),
        `requiresWorktree: ${result.requiresWorktree}`,
      ].join('\n');
    },
  };
}
