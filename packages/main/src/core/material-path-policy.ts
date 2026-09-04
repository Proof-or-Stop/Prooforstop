import { isMaterialExcludedRuntimeArtifactPath } from './runtime-artifact-registry.js';
import { loadConfig } from './config.js';
import { PROOF_OR_STOP_STORY_DIR_NAMES, LEGACY_DOCS_STORY_DIR } from './proof-or-stop-paths.js';

const DEFAULT_STORY_METADATA_PREFIXES = [
  ...PROOF_OR_STOP_STORY_DIR_NAMES.map(dir => dir.replace(/\/actives$/, '') + '/'),
  LEGACY_DOCS_STORY_DIR.replace(/\/actives$/, '') + '/',
  'docs/framework-audit/',
].filter((value, index, all) => all.indexOf(value) === index);

export function isStoryMetadataPath(path: string, projectRoot?: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const prefixes = [...DEFAULT_STORY_METADATA_PREFIXES];
  if (projectRoot) {
    try {
      const cfg = loadConfig(projectRoot);
      const storyDir = cfg.storyDir?.replace(/\\/g, '/').toLowerCase();
      if (storyDir) {
        const prefix = storyDir.endsWith('/') ? storyDir : storyDir + '/';
        if (!prefixes.some(value => value === prefix || prefix.startsWith(value))) prefixes.push(prefix);
      }
    } catch { /* malformed config: use canonical defaults */ }
  }
  return prefixes.some(prefix => normalized.startsWith(prefix));
}

export function isMaterialExcludedPath(path: string, projectRoot?: string): boolean {
  return isStoryMetadataPath(path, projectRoot) || isMaterialExcludedRuntimeArtifactPath(path);
}
