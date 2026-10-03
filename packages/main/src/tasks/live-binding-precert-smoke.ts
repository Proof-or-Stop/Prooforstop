#!/usr/bin/env node
/**
 * Lab live-binding-precert: run 7 (2026-09-30) passed REVIEW, admitted its
 * certification window and passed full validation, then `story_advance
 * --phase=TEST` refused every managed pass with
 * managed_review_live_head_lineage_invalid: the PRE_CERT commands the gate
 * itself requires (certification_window_begin/cancel, review_inventory_*, validate)
 * auto-commit story metadata and move HEAD. Those commits must not invalidate
 * a pass on unchanged material; any other commit still must.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { verifyManagedReviewLiveBinding } from '../core/managed-review-evidence.js';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const storyId = 'B-live';

function fixture(): { root: string; storyDir: string; expected: { headHash: string; materialHash: string; storyFilesHash: string } } {
  const root = mkdtempSync(join(tmpdir(), 'live-binding-precert-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'lab@example.test']);
  git(root, ['config', 'user.name', 'lab']);
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ storyDir: '.proof-or-stop/story/actives', storyPrefix: 'B' }));
  writeFileSync(join(root, 'main.go'), 'package main\n');
  const storyDir = join(root, '.proof-or-stop', 'story', 'actives', storyId);
  mkdirSync(storyDir, { recursive: true });
  writeFileSync(join(storyDir, 'story.json'), '{}\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'reviewed candidate']);
  return { root, storyDir, expected: {
    headHash: currentGitHead(root)!, materialHash: currentMaterialHash(root, 'HEAD', root)!, storyFilesHash: currentStoryFilesHash(root, 'HEAD', root)!,
  } };
}
function metadataCommit(root: string, storyDir: string, command: string): void {
  writeFileSync(join(storyDir, 'certification-window.json'), `{"command":"${command}"}\n`);
  writeFileSync(join(storyDir, 'process-events.jsonl'), `{"event":"${command}"}\n`);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', `proof-or-stop: record ${storyId} ${command} metadata`]);
}

const precert = fixture();
metadataCommit(precert.root, precert.storyDir, 'certification_window_begin');
metadataCommit(precert.root, precert.storyDir, 'certification_window_cancel');
const afterPrecert = verifyManagedReviewLiveBinding({ gitCwd: precert.root, metadataRoot: precert.root, storyId, expected: precert.expected });
assert.equal(afterPrecert.valid, true, `PRE_CERT metadata commits invalidated a managed pass: ${afterPrecert.reason}`);

const other = fixture();
metadataCommit(other.root, other.storyDir, 'checklist_update');
assert.equal(verifyManagedReviewLiveBinding({ gitCwd: other.root, metadataRoot: other.root, storyId, expected: other.expected }).valid, false,
  'a non-PRE_CERT metadata commit still invalidates the pass');

const code = fixture();
writeFileSync(join(code.root, 'main.go'), 'package main\n// changed\n');
git(code.root, ['commit', '-qam', `proof-or-stop: record ${storyId} certification_window_begin metadata`]);
assert.equal(verifyManagedReviewLiveBinding({ gitCwd: code.root, metadataRoot: code.root, storyId, expected: code.expected }).valid, false,
  'a material change is never accepted, whatever its subject');

const testPhase = fixture();
for (const command of ['TEST', 'delivery_check_set', 'summary_set', 'delivery_waiver_add', 'evaluate_save', 'live_smoke_transcript', 'done_prepare']) {
  metadataCommit(testPhase.root, testPhase.storyDir, command);
}
const afterTest = verifyManagedReviewLiveBinding({ gitCwd: testPhase.root, metadataRoot: testPhase.root, storyId, expected: testPhase.expected });
assert.equal(afterTest.valid, true, `TEST-phase metadata commits invalidated a managed pass: ${afterTest.reason}`);
console.log('live-binding-precert-smoke: PASS');
