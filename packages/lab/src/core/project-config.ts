import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface LabProjectConfig {
  storyDir: string;
  fixturesDir: string;
  worktreeDir: string;
}

/**
 * Accepted project config filenames, canonical FIRST (B-cc10 CHK-004).
 *
 * Deliberately a local copy rather than an import of `core/brand-paths.ts`: this
 * package only depends on the BUILT core package, and reaching into core for two
 * string constants would couple lab's compile to core's dist layout. The
 * canonical-first ordering is what implements canonical-wins here, same as in the
 * core resolver.
 */
const CONFIG_FILENAMES: readonly string[] = ['proof-or-stop.config.json', 'proof-or-stop.config.json'];

export function loadLabProjectConfig(root: string): LabProjectConfig {
  const defaults: LabProjectConfig = {
    storyDir: 'docs/story/actives',
    fixturesDir: 'tests/fixtures',
    worktreeDir: '.worktrees',
  };
  // Probe both spellings so an unmigrated checkout keeps resolving instead of
  // silently falling through to defaults.
  const configPath = CONFIG_FILENAMES
    .map((name) => join(root, name))
    .find((candidate) => existsSync(candidate));
  if (!configPath) return defaults;
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
