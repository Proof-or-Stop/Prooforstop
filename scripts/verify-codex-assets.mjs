#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  CODEX_ADAPTER_MANIFEST,
  CODEX_README_TEMPLATE,
  listAgentPromptFiles,
  renderCodexAdapterManifest,
  renderCodexAgentContent,
} from '../packages/main/dist/init-assets.js';

const root = process.cwd();
const GLOBAL_CODEX_FALLBACK = 'KOALA_ACTIVITY_SOURCE=codex KOALA_ACTIVITY_RECORD_READONLY=1 koala';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const claudeAgentDir = join(root, '.claude', 'agents');
const codexAgentDir = join(root, '.Codex', 'agents');

for (const file of listAgentPromptFiles(claudeAgentDir)) {
  const claudePath = join(root, '.claude', 'agents', file);
  const codexPath = join(root, '.Codex', 'agents', file);
  assert(existsSync(claudePath), `missing source agent: ${claudePath}`);
  assert(existsSync(codexPath), `missing codex agent: ${codexPath}`);

  const expected = renderCodexAgentContent(read(claudePath)).trim();
  const actual = read(codexPath).trim();
  assert(actual === expected, `.Codex/agents/${file} drifted from transformed .claude source`);
}

for (const file of listAgentPromptFiles(codexAgentDir)) {
  const claudePath = join(claudeAgentDir, file);
  assert(existsSync(claudePath), `stale codex agent without .claude source: ${file}`);
}

const codexReadme = read(join(root, '.Codex', 'README.md'));
assert(codexReadme.includes('node bin/koala-codex.js session_brief'), '.Codex/README missing preferred wrapper command');
assert(codexReadme.includes(`${GLOBAL_CODEX_FALLBACK} session_brief`), '.Codex/README missing fallback command');
assert(codexReadme.includes('bin/koala-codex.js'), '.Codex/README missing wrapper guidance');
assert(codexReadme.includes('.Codex/koala.json'), '.Codex/README missing adapter manifest guidance');
assert(codexReadme.includes('不创建 `.Codex/hooks`'), '.Codex/README should say Codex hooks are not generated');
assert(codexReadme.includes('不创建 `.Codex/settings.json`'), '.Codex/README should say Codex settings are not generated');

const codexManifestPath = join(root, '.Codex', 'koala.json');
assert(existsSync(codexManifestPath), 'missing .Codex/koala.json adapter manifest');
assert(read(codexManifestPath) === renderCodexAdapterManifest(), '.Codex/koala.json drifted from template');
assert(CODEX_ADAPTER_MANIFEST.adapterOwner === 'koala', 'adapter manifest owner must be koala');
assert(CODEX_ADAPTER_MANIFEST.activitySource === 'codex', 'adapter manifest source must be codex');
assert(CODEX_ADAPTER_MANIFEST.recommendedEntrypoints[0]?.command === 'node bin/koala-codex.js', 'adapter manifest should prefer wrapper first');
assert(CODEX_ADAPTER_MANIFEST.recommendedEntrypoints.some(entry => entry.command === GLOBAL_CODEX_FALLBACK), 'adapter manifest missing read-only global fallback');
assert(CODEX_ADAPTER_MANIFEST.excludedRuntimeAssets.includes('.Codex/hooks'), 'adapter manifest must exclude .Codex/hooks');
assert(CODEX_ADAPTER_MANIFEST.excludedRuntimeAssets.includes('.Codex/settings.json'), 'adapter manifest must exclude .Codex/settings.json');
assert(!existsSync(join(root, '.Codex', 'hooks')), 'Codex adapter should not create .Codex/hooks');
assert(!existsSync(join(root, '.Codex', 'settings.json')), 'Codex adapter should not create .Codex/settings.json');

const readme = read(join(root, 'README.md'));
assert(readme.includes('## Codex 使用'), 'README missing Codex section');
assert(readme.includes('node bin/koala-codex.js session_brief'), 'README missing wrapper command');
assert(readme.includes('.Codex/README.md'), 'README missing .Codex reference');
assert(readme.includes('.Codex/koala.json'), 'README missing .Codex/koala.json reference');

const agents = read(join(root, 'AGENTS.md'));
assert(agents.includes('koala session_brief'), 'AGENTS.md missing session_brief rule');
assert(agents.includes('.Codex/agents'), 'AGENTS.md missing Codex agent path guidance');
assert(agents.includes('.Codex/koala.json'), 'AGENTS.md missing Codex adapter manifest guidance');
assert(agents.includes('不要创建会误导用户的 `.Codex/hooks`'), 'AGENTS.md should reject fake Codex hooks');

assert(CODEX_README_TEMPLATE.includes('node bin/koala-codex.js session_brief'), 'template missing preferred wrapper command');
assert(CODEX_README_TEMPLATE.includes(`${GLOBAL_CODEX_FALLBACK} session_brief`), 'template missing fallback command');
assert(CODEX_README_TEMPLATE.includes('.Codex/koala.json'), 'template missing adapter manifest guidance');
assert(renderCodexAdapterManifest().includes('"activitySource": "codex"'), 'manifest template missing codex source');

console.log('codex assets verified');
