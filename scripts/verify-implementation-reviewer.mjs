#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(path) {
  return readFileSync(path, 'utf8');
}

const agentPaths = [
  join(root, '.claude', 'agents', 'implementation-reviewer.md'),
  join(root, '.Codex', 'agents', 'implementation-reviewer.md'),
];

for (const path of agentPaths) {
  assert(existsSync(path), `missing implementation-reviewer agent: ${path}`);
  const text = read(path);
  assert(text.includes('实现代码本身') || text.includes('实现风险'), `${path} missing implementation scope`);
  assert(text.includes('不改代码') || text.includes('不推进 phase'), `${path} missing non-edit boundary`);
  assert(text.includes('severity'), `${path} missing severity guidance`);
}

const initAssets = read(join(root, 'packages/main/src/init-assets.ts'));
assert(initAssets.includes('listAgentPromptFiles'), 'init assets missing full agent prompt discovery');

console.log('implementation reviewer verified');
