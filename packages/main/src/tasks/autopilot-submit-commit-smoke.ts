#!/usr/bin/env node
/**
 * autopilot_review_submit must commit the canonical metadata it writes.
 *
 * The host-verdict writer appends a host_verdict row to the Story's
 * process-events.jsonl. Left uncommitted, that row is publication-set dirt:
 * the next hinted step (done_prepare -> validate) refuses with
 * VALIDATION_PUBLICATION_NOT_READY (handlers/verifier.ts). Like the other
 * metadata writers, the submit must auto-commit exactly that artifact on the
 * story branch so the tree is clean afterwards, and must not sweep anything
 * else (other story files, material code) into that commit.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeRuntimeGitignore } from '../core/managed-assets.js';
import { currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import { listVerdicts } from '../core/verdicts.js';

const STORY_ID = 'B-submit-commit';
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
const MARKER = 'AUTOPILOT_SUBMIT_LEFT_METADATA_DIRTY';
const EVENTS = `.proof-or-stop/story/actives/${STORY_ID}/process-events.jsonl`;

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function story(): StoryInfo {
  return {
    storyId: STORY_ID, name: STORY_ID, title: 'Submit commit smoke', description: 'Host verdict writer commits its metadata',
    type: 'feature', phase: 'TEST', priority: 'medium', createdAt: '2026-09-30T09:00:00.000Z', startedAt: null, endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: '2026-09-30T09:30:00.000Z' }],
  };
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-submit-commit-'));
  try {
    write(root, 'go.mod', 'module example.com/strs\n\ngo 1.22\n');
    write(root, 'strs/strs.go', 'package strs\n');
    // Managed runtime .gitignore, as a task repo gets it (activity log, verdict JSON, ...).
    write(root, '.gitignore', mergeRuntimeGitignore(''));
    write(root, 'proof-or-stop.config.json', `${JSON.stringify({ artifactContract: 'none' }, null, 2)}\n`);
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'smoke@example.invalid']);
    git(root, ['config', 'user.name', 'Submit Commit Smoke']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'seed']);
    git(root, ['checkout', '-qB', `story/${STORY_ID}`]);
    write(root, 'strs/strs.go', 'package strs\n\nfunc Upper(s string) string { return s }\n');
    const store = new StoryStore(root);
    store.writeStory(STORY_ID, story());
    store.writeChecklist(STORY_ID, { items: [] });
    store.appendProcessEvent(STORY_ID, { type: 'smoke_seed', note: 'pre-existing committed event' });
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'material change + story metadata']);
    const headBefore = git(root, ['rev-parse', 'HEAD']).trim();

    const run = spawnSync(process.execPath, [CLI, 'autopilot_review_submit', JSON.stringify({
      storyId: STORY_ID, runId: `${STORY_ID}-degraded-r1`, hostId: 'smoke-host', provider: 'local', sessionId: 'smoke-session',
      decision: 'pass', materialDigest: currentMaterialHash(root), storyFilesHash: currentStoryFilesHash(root),
      validationDigest: 'a'.repeat(64), promptDigest: 'b'.repeat(64), keyId: 'smoke-key',
    })], { cwd: root, encoding: 'utf8', env: { ...process.env, PROOF_OR_STOP_NO_HOOKS: '1', PROOF_OR_STOP_AGENT: 'main' } });
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, `autopilot_review_submit failed:\n${output.slice(-2000)}`);
    assert.equal(listVerdicts(root, 'local', STORY_ID).length, 1, 'one host verdict persisted');
    assert.equal(store.readProcessEvents(STORY_ID).filter(event => event.type === 'host_verdict').length, 1, 'host_verdict event appended');

    const dirty = git(root, ['status', '--porcelain', '--', EVENTS]).trim();
    assert.equal(dirty, '', `${MARKER}: process-events.jsonl left uncommitted after autopilot_review_submit (${dirty}); done_prepare would refuse with VALIDATION_PUBLICATION_NOT_READY`);
    assert.equal(git(root, ['status', '--porcelain']).trim(), '', 'tree is clean after the submit');
    const commits = git(root, ['rev-list', `${headBefore}..HEAD`]).trim().split('\n').filter(Boolean);
    assert.equal(commits.length, 1, 'exactly one metadata commit');
    const touched = git(root, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n');
    assert.deepEqual(touched, [EVENTS], 'the commit carries only the Story process-events.jsonl');
    assert.match(output, /metadata auto-committed/, 'the submit reports its metadata commit');
    console.log('autopilot-submit-commit-smoke: PASS (host verdict event committed; tree clean)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
