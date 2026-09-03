#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
// B-cc10 F-055: resolve whichever adapter dir exists. Hardcoding the renamed one made this
// read a path that no longer exists (ENOENT) or scan zero files.
function adapterDirName(base) {
  return existsSync(join(base, '.proof-or-stop-codex')) ? '.proof-or-stop-codex' : '.proof-or-stop-codex';
}


const root = process.cwd();
const IMPLEMENTATION_REVIEWER_ROLE = 'proof-or-stop-implementation-reviewer';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function resolveSupportedAgentPath(baseDir, roleId) {
  const basenames = [roleId, ...legacyAgentRoleIds(roleId)];
  for (const relativeDir of baseDir) {
    for (const basename of basenames) {
      const path = join(root, relativeDir, 'agents', `${basename}.md`);
      if (existsSync(path)) return path;
    }
  }
  return join(root, baseDir[0], 'agents', `${roleId}.md`);
}

const agentPaths = [
  resolveSupportedAgentPath(['.claude'], IMPLEMENTATION_REVIEWER_ROLE),
  resolveSupportedAgentPath(ADAPTER_DIR_NAMES, IMPLEMENTATION_REVIEWER_ROLE),
];

for (const path of agentPaths) {
  assert(existsSync(path), `missing implementation-reviewer agent: ${path}`);
  const text = read(path);
  assert(text.includes('implementation code itself') || text.includes('implementation risks') || text.includes('实现代码本身') || text.includes('实现风险'), `${path} missing implementation scope`);
  assert(text.includes('Not modifying code') || text.includes('not modifying code') || text.includes('不改代码') || text.includes('不推进 phase'), `${path} missing non-edit boundary`);
  assert(text.includes('severity'), `${path} missing severity guidance`);
}

const initAssets = read(join(root, 'packages/main/src/init-assets.ts'));
assert(initAssets.includes('listAgentPromptFiles'), 'init assets missing full agent prompt discovery');

console.log('implementation reviewer verified');
