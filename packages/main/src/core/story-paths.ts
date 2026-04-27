import { join } from 'path';
import { loadConfig } from './config.js';
import { getRepoRoot } from './worktree-runtime.js';

export function resolveStoryBaseDir(projectRoot: string): string {
  const config = loadConfig(projectRoot);
  const repoRoot = getRepoRoot(projectRoot);
  return join(repoRoot, config.storyDir);
}

export function resolveLegacyStoryBaseDir(projectRoot: string): string {
  return join(getRepoRoot(projectRoot), 'docs', 'story', 'actives');
}

export function resolveStoryFilePath(projectRoot: string, storyId: string, file: string): string {
  return join(resolveStoryBaseDir(projectRoot), storyId, file);
}
