import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface LabProjectConfig {
  storyDir: string;
  fixturesDir: string;
  worktreeDir: string;
}

export function loadLabProjectConfig(root: string): LabProjectConfig {
  const defaults: LabProjectConfig = {
    storyDir: 'docs/story/actives',
    fixturesDir: 'tests/fixtures',
    worktreeDir: '.worktrees',
  };
  const configPath = join(root, 'koala.config.json');
  if (!existsSync(configPath)) return defaults;
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<LabProjectConfig>;
    return {
      storyDir: parsed.storyDir || defaults.storyDir,
      fixturesDir: parsed.fixturesDir || defaults.fixturesDir,
      worktreeDir: parsed.worktreeDir || defaults.worktreeDir,
    };
  } catch {
    return defaults;
  }
}
