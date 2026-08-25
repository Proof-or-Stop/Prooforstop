#!/usr/bin/env node

import { readFileSync } from 'fs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const claude = readFileSync('.claude/agents/proof-or-stop-verification-intent.md', 'utf8');
const codex = readFileSync('.proof-or-stop-codex/agents/proof-or-stop-verification-intent.md', 'utf8');

for (const [label, content] of [['claude', claude], ['codex', codex]]) {
  assert(content.includes('verificationIntent'), `${label} prompt must name verificationIntent`);
  assert(content.includes('checklist_update'), `${label} prompt must name checklist_update`);
  assert(content.includes('happy'), `${label} prompt should preserve happy coverage guidance`);
  assert(content.includes('edge'), `${label} prompt should preserve edge coverage guidance`);
  assert(content.includes('adversarial'), `${label} prompt should preserve adversarial coverage guidance`);
  assert(content.includes('verificationEvidence'), `${label} prompt must distinguish execution evidence`);
  assert(!/proof-or-stop-test-intent|proof-or-stop-test-case-reviewer|testIntent|testintent_/.test(content), `${label} active prompt must not teach legacy guidance`);
}

assert(!codex.includes('Claude Code 的 `isolation'), 'Codex prompt should not contain Claude Code isolation wording');

console.log('fixture-friendly prompt rule verified');
