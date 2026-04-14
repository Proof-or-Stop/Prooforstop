#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { CODEX_AGENT_FILES, CODEX_README_TEMPLATE, renderCodexAgentContent } from '../packages/main/dist/init-assets.js';

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

for (const file of CODEX_AGENT_FILES) {
  const claudePath = join(root, '.claude', 'agents', file);
  const codexPath = join(root, '.Codex', 'agents', file);
  assert(existsSync(claudePath), `missing source agent: ${claudePath}`);
  assert(existsSync(codexPath), `missing codex agent: ${codexPath}`);

  const expected = renderCodexAgentContent(read(claudePath)).trim();
  const actual = read(codexPath).trim();
  assert(actual === expected, `.Codex/agents/${file} drifted from transformed .claude source`);
}

const codexReadme = read(join(root, '.Codex', 'README.md'));
assert(codexReadme.includes('KOALA_ACTIVITY_SOURCE=codex koala session_brief'), '.Codex/README missing fallback command');
assert(codexReadme.includes('bin/koala-codex.js'), '.Codex/README missing wrapper guidance');

const readme = read(join(root, 'README.md'));
assert(readme.includes('## Codex 使用'), 'README missing Codex section');
assert(readme.includes('node bin/koala-codex.js session_brief'), 'README missing wrapper command');
assert(readme.includes('.Codex/README.md'), 'README missing .Codex reference');

const agents = read(join(root, 'AGENTS.md'));
assert(agents.includes('koala session_brief'), 'AGENTS.md missing session_brief rule');
assert(agents.includes('.Codex/agents'), 'AGENTS.md missing Codex agent path guidance');

assert(CODEX_README_TEMPLATE.includes('KOALA_ACTIVITY_SOURCE=codex koala session_brief'), 'template missing fallback command');

console.log('codex assets verified');
