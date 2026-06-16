#!/usr/bin/env node

import { readFileSync } from 'fs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const claude = readFileSync('.claude/agents/test-intent.md', 'utf8');
const codex = readFileSync('.lattice-codex/agents/test-intent.md', 'utf8');

for (const [label, content] of [['claude', claude], ['codex', codex]]) {
  assert(content.includes('fixture-heavy item 的推荐字段'), `${label} prompt missing fixture-heavy section`);
  assert(content.includes('"input"'), `${label} prompt missing input example`);
  assert(content.includes('"expect"'), `${label} prompt missing expect example`);
  assert(content.includes('WHY:'), `${label} prompt missing WHY guidance`);
  assert(content.includes('不是所有简单 story 的硬性要求'), `${label} prompt should not make input/expect globally mandatory`);
  assert(content.includes('操作/条件 → 预期结果'), `${label} prompt should preserve desc format rule`);
  assert(content.includes('type'), `${label} prompt should preserve type guidance`);
}

assert(!codex.includes('Claude Code 的 `isolation'), 'Codex prompt should not contain Claude Code isolation wording');

console.log('fixture-friendly prompt rule verified');
