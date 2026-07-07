#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { currentStoryFilesHash, EMPTY_STORY_FILES_HASH } from '../core/evidence-freshness.js';

const COMMIT_ENV = ['-c', 'user.email=story-files-hash@example.test', '-c', 'user.name=Story Files Hash Smoke'];

let passed = 0;

function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, 'utf8');
}

function commitAll(root: string, message: string): string {
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function expectedStoryHash(root: string, base: string, ref = 'HEAD'): string {
  const raw = git(root, ['diff', '--name-status', '-M', `${base}..${ref}`]);
  const entries: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split('\t').map(part => part.trim()).filter(Boolean);
    const status = cols[0] ?? '';
    const add = (path: string, deleted: boolean) => {
      let objectId: string | undefined;
      if (!deleted) {
        try {
          const tree = git(root, ['ls-tree', '-z', ref, '--', path]);
          const first = tree.split('\0').find(Boolean);
          const meta = first?.split('\t')[0] ?? '';
          objectId = meta.trim().split(/\s+/)[2];
        } catch {
          objectId = undefined;
        }
      }
      entries.push(`${path}\0${objectId || '<deleted>'}`);
    };
    if ((status.startsWith('R') || status.startsWith('C')) && cols.length >= 3) {
      add(cols[1], true);
      add(cols[2], status.startsWith('D'));
    } else if (cols.length >= 2) {
      add(cols[cols.length - 1], status.startsWith('D'));
    }
  }
  return createHash('sha256').update(entries.sort().join('\0')).digest('hex');
}

function withRepo(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'proofbound-story-files-hash-'));
  try {
    git(root, ['init', '-q']);
    write(root, 'README.md', 'base\n');
    commitAll(root, 'base');
    git(root, ['branch', '-M', 'main']);
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

check('empty story diff returns the explicit empty-set digest', () => {
  withRepo((root) => {
    assert.equal(currentStoryFilesHash(root, 'HEAD', root), EMPTY_STORY_FILES_HASH);
  });
});

check('small changed-file set matches the legacy per-path digest semantics', () => {
  withRepo((root) => {
    const base = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-q', '-b', 'story/B-small-batch']);
    for (let i = 0; i < 12; i += 1) {
      write(root, `experiments/cell03/workspaces/case-${String(i).padStart(4, '0')}/solution.mjs`, `export default ${i};\n`);
    }
    commitAll(root, 'add story-owned files');
    assert.equal(currentStoryFilesHash(root, 'HEAD', root), expectedStoryHash(root, base));
  });
});

check('large changed-file set completes through the batched lookup path', () => {
  withRepo((root) => {
    git(root, ['checkout', '-q', '-b', 'story/B-large-batch']);
    for (let i = 0; i < 700; i += 1) {
      write(root, `experiments/cell03/workspaces/case-${String(i).padStart(4, '0')}/solution.mjs`, `export default ${i};\n`);
    }
    commitAll(root, 'add many story-owned files');
    const start = Date.now();
    const hash = currentStoryFilesHash(root, 'HEAD', root);
    const durationMs = Date.now() - start;
    assert.match(hash ?? '', /^[0-9a-f]{64}$/);
    assert.ok(durationMs < 5000, `large storyFilesHash should complete through batched git lookup, took ${durationMs}ms`);
  });
});

check('delete and rename entries remain part of the story-owned hash', () => {
  withRepo((root) => {
    write(root, 'src/keep.ts', 'export const keep = 1;\n');
    write(root, 'src/delete-me.ts', 'export const gone = 1;\n');
    write(root, 'src/rename-me.ts', 'export const renamed = 1;\n');
    commitAll(root, 'seed files');
    const base = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-q', '-b', 'story/B-rename-delete']);
    git(root, ['rm', '-q', 'src/delete-me.ts']);
    git(root, ['mv', 'src/rename-me.ts', 'src/renamed.ts']);
    write(root, 'src/keep.ts', 'export const keep = 2;\n');
    commitAll(root, 'delete rename and modify');
    assert.equal(currentStoryFilesHash(root, 'HEAD', root), expectedStoryHash(root, base));
  });
});

console.log(`story-files-hash-batch smoke passed (${passed} checks)`);
