#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function run(root: string, command: string, args: Record<string, unknown>, allowFailure = false): string {
  try {
    return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(args)], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    const text = String(error.stdout || '') + String(error.stderr || '') + String(error.message || '');
    if (allowFailure) return text;
    throw new Error(text);
  }
}

const root = mkdtempSync(join(tmpdir(), 'koala-init-required-agents-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Koala Smoke']);
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  write(root, 'README.md', 'smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  const created = run(root, 'story_create', {
    name: 'init-required-agents',
    title: 'Init required agents',
    description: 'Verify INIT_CHECK requires both init reviewers.',
    type: 'chore',
    priority: 'medium',
    background: [
      '## Trigger Event',
      '2026-05-01 B-0000 smoke needs enough trigger detail to satisfy background validation for init required agents.',
      '## Key Insights',
      'The workflow must distinguish text-only reviewer output from persisted init_check_set records so skipped calls cannot pass.',
      '## Tradeoffs',
      'The smoke writes both reviewer records through the CLI instead of editing JSON directly, preserving the artifact protocol.',
      '## Conversation Texture',
      'A maintainer sees a clear blocker naming product-reviewer until that reviewer records pass or fail with init_check_set.',
    ].join('\n\n'),
    checklist: [{ title: 'Verify init reviewer records', context: 'Both init reviewers must persist their result.' }],
  });
  const storyId = created.match(/B-[a-f0-9]+/)?.[0];
  assert.ok(storyId, 'story_create should return story id');

  run(root, 'init_check_set', { storyId, issues: [], agentId: 'koala-review-story-init' });
  const missingProduct = run(root, 'story_advance', { storyId, phase: 'INIT_CHECK' }, true);
  assert.match(missingProduct, /missing_init_check_agent/);
  assert.match(missingProduct, /product-reviewer/);

  run(root, 'init_check_set', { storyId, issues: [{ severity: 'high', desc: 'Product value is not yet clear.' }], agentId: 'product-reviewer' });
  const blockingProduct = run(root, 'story_advance', { storyId, phase: 'INIT_CHECK' }, true);
  assert.match(blockingProduct, /init_check_blocking_issues/);
  assert.match(blockingProduct, /Product value is not yet clear/);

  run(root, 'init_check_set', { storyId, issues: [{ severity: 'medium', desc: 'Product wording could be clearer but is not blocking.' }], agent: 'product-reviewer' });
  const advanced = run(root, 'story_advance', { storyId, phase: 'INIT_CHECK' });
  assert.match(advanced, /advanced to INIT_CHECK/);

  const tamperCreated = run(root, 'story_create', {
    name: 'init-check-tamper',
    title: 'Init tamper gate',
    description: 'Verify INIT_CHECK rejects stale init-check signatures.',
    type: 'chore',
    priority: 'medium',
    background: [
      '## Trigger Event',
      '2026-05-01 B-0000 smoke needs a stale signature case so init_check_tampered cannot regress silently.',
      '## Key Insights',
      'The signature binds story title, description, background, checklist and review round; changing one after init_check_set must block.',
      '## Tradeoffs',
      'The smoke uses story_update to mutate signed story metadata instead of editing JSON directly, preserving the public CLI path.',
      '## Conversation Texture',
      'A maintainer sees init_check_tampered when a reviewer pass was recorded against an older story snapshot.',
    ].join('\n\n'),
    checklist: [{ title: 'Verify tamper blocker', context: 'Stale init-check hash must prevent INIT_CHECK.' }],
  });
  const tamperStoryId = tamperCreated.match(/B-[a-f0-9]+/)?.[0];
  assert.ok(tamperStoryId, 'story_create should return tamper story id');

  run(root, 'init_check_set', { storyId: tamperStoryId, issues: [], agentId: 'koala-review-story-init' });
  run(root, 'init_check_set', { storyId: tamperStoryId, issues: [], agentId: 'product-reviewer' });
  run(root, 'story_update', { storyId: tamperStoryId, title: 'Init tamper gate changed after review' });
  const tampered = run(root, 'story_advance', { storyId: tamperStoryId, phase: 'INIT_CHECK' }, true);
  assert.match(tampered, /init_check_tampered/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ init check required agents smoke passed');
