#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const cli = join(root, 'packages/main/dist/cli.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, payload) {
  const args = [cli, command];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  return execFileSync('node', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const gapRaw = run('gap_analyze');
const gap = JSON.parse(gapRaw.slice(gapRaw.indexOf('{')));
const highSources = new Set(
  gap.gaps
    .filter((item) => item.severity === 'high' && item.source?.file)
    .map((item) => `${item.source.file}:${item.source.line}`),
);

for (const target of [
  'decisions/cc-learnings.md:307',
  'decisions/test-intent-review.md:16',
  'decisions/test-intent-review.md:39',
  'decisions/test-intent-review.md:43',
]) {
  assert(!highSources.has(target), `high gap still present for ${target}`);
}

const antiStall = readFileSync(join(root, 'packages/main/src/core/anti-stall.ts'), 'utf8');
const checklist = readFileSync(join(root, 'packages/main/src/handlers/checklist.ts'), 'utf8');
const storyReview = readFileSync(join(root, 'packages/main/src/handlers/story-review.ts'), 'utf8');
const cliPrompts = readFileSync(join(root, 'packages/main/src/cli-prompts.ts'), 'utf8');

assert(antiStall.includes('retry') && antiStall.includes('discard') && antiStall.includes('fix'), 'anti-stall implementation hints disappeared');
assert(checklist.includes('testIntent.happy is required') || checklist.includes('testIntent.happy'), 'checklist no longer enforces happy lane');
assert(storyReview.includes('split_quality') && storyReview.includes('cross_scenario'), 'story_review no longer carries checklist split / adversarial review logic');
assert(cliPrompts.includes('Main agent does NOT write testIntent') && cliPrompts.includes('happy/edge/adversarial'), 'cli prompt contract no longer documents Agent A/testIntent boundaries');

console.log('anti-stall and test-intent high gap coverage verified');
