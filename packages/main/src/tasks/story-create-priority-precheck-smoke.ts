#!/usr/bin/env node

// Regression: an owner-chosen priority=high with no risk wording in the title or
// description is a deterministic INIT story-review high issue. story_create
// accepted it silently, so the owner only learned about it from the first
// INIT review round and had to re-run both INIT reviewers after fixing it.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { createStoryCreateHandlers } from '../handlers/story-create.js';

const MARKER = 'story_create does not warn about priority=high without risk wording';
const background = '## Trigger Event\nA benchmark request on 2026-09-29 asks for stepped index ranges in the evaluator.\n\n## Key Insights\nThe parser and evaluator both need the third component.\n\n## Solution Tradeoffs\nExtend the existing range node instead of adding a new node.\n\n## Conversational Texture\nThe requester wants exact error strings preserved.';

function create(priority: string, title: string): string {
  const root = mkdtempSync(join(tmpdir(), 'story-create-priority-precheck-'));
  try {
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=p@example.invalid', '-c', 'user.name=P', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
    resetConfigCache();
    const handlers = createStoryCreateHandlers({ root, store: new StoryStore(root), scanRoot: root, log: () => {} });
    let stderr = '';
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown as (chunk: string | Uint8Array) => boolean) = chunk => { stderr += String(chunk); return true; };
    let out: unknown;
    try {
      out = handlers.story_create({
        name: `prio-${priority}`, title, type: 'feature', priority,
        description: 'Arrays and strings accept start:end:step slices with omitted components.',
        background, checklist: [{ title: 'Parse stepped slices', context: 'parser and AST' }], forceNew: true,
      } as never);
    } finally {
      process.stderr.write = originalWrite as typeof process.stderr.write;
    }
    return `${typeof out === 'string' ? out : JSON.stringify(out)}\n${stderr}`;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const flagged = create('high', 'Support stepped index ranges');
assert.match(flagged, /priority=high[^\n]*(no|without) risk/i, `${MARKER}\n${flagged.slice(0, 2000)}`);
const medium = create('medium', 'Support stepped index ranges');
assert.doesNotMatch(medium, /priority=high[^\n]*(no|without) risk/i, 'medium priority is not flagged');
const risky = create('high', 'Support stepped index ranges behind the auth token gate');
assert.doesNotMatch(risky, /priority=high[^\n]*(no|without) risk/i, 'high priority with risk wording in the title is not flagged');
console.log('story-create-priority-precheck-smoke: PASS');
