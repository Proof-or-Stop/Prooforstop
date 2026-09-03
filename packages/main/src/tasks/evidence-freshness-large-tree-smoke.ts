#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentMaterialHash, GIT_TREE_OUTPUT_MAX_BUFFER } from '../core/evidence-freshness.js';

function git(cwd: string, args: string[], options: { maxBuffer?: number } = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'evidence-freshness-smoke',
      GIT_AUTHOR_EMAIL: 'evidence-freshness-smoke@example.com',
      GIT_COMMITTER_NAME: 'evidence-freshness-smoke',
      GIT_COMMITTER_EMAIL: 'evidence-freshness-smoke@example.com',
    },
    maxBuffer: GIT_TREE_OUTPUT_MAX_BUFFER,
    ...options,
  }).trim();
}

function writeConfig(root: string): void {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2) + '\n');
}

function createLargeTreeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-material-large-tree-'));
  writeConfig(root);
  const dir = join(root, 'packages/main/src/large-tree-regression');
  mkdirSync(dir, { recursive: true });
  const prefix = 'tracked-material-path-with-a-long-name-to-expand-ls-tree-output';
  for (let i = 0; i < 8_000; i += 1) {
    const suffix = String(i).padStart(5, '0');
    writeFileSync(join(dir, `${prefix}-${suffix}.ts`), `export const value${suffix} = ${i};\n`);
  }
  git(root, ['init', '-b', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'large material tree']);
  return root;
}

const root = createLargeTreeRepo();
try {
  const raw = git(root, ['ls-tree', '-r', '-z', 'HEAD'], { maxBuffer: GIT_TREE_OUTPUT_MAX_BUFFER });
  assert.ok(raw.length > 1024 * 1024, `fixture should exceed Node's default execFileSync buffer; got ${raw.length}`);
  assert.throws(
    () => git(root, ['ls-tree', '-r', '-z', 'HEAD'], { maxBuffer: 128 * 1024 }),
    /ENOBUFS|maxBuffer|stdout maxBuffer length exceeded/,
    'small-buffer ls-tree should reproduce the buffer exhaustion class',
  );

  const materialHash = currentMaterialHash(root, 'HEAD', root);
  assert.match(materialHash ?? '', /^[a-f0-9]{64}$/, 'currentMaterialHash handles large ls-tree output');
  console.log('✓ evidence freshness large-tree smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
