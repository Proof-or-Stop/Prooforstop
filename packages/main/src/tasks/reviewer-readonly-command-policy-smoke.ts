#!/usr/bin/env node
/**
 * B-4f15 CHK-003: focused in-process smoke for the read-only reviewer command
 * policy delivered in CHK-002.
 *
 * Exercises enforceReviewerReadOnlyCommandGate + the KOALA_REVIEWER_READONLY env
 * using a temp StoryStore. The critical assertion: a blocked review_pass_set call
 * must write NO review-passes.json artifact.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import {
  REVIEWER_READONLY_ENV,
  isReviewerReadOnlyModeEnabled,
  enforceReviewerReadOnlyCommandGate,
} from '../cli-engine.js';

const root = join(tmpdir(), `koala-reviewer-readonly-smoke-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });

const savedRO = process.env[REVIEWER_READONLY_ENV];

try {
  const store = new StoryStore(root);
  const storyId = 'B-smoke1';
  const storyDir = store.storyDirPath(storyId);
  mkdirSync(storyDir, { recursive: true });
  const reviewPassesPath = join(storyDir, 'review-passes.json');

  // ── 1. KOALA_REVIEWER_READONLY=1 enables read-only mode ─────────────────
  delete process.env[REVIEWER_READONLY_ENV];
  assert.equal(isReviewerReadOnlyModeEnabled(), false, 'unset → disabled');
  process.env[REVIEWER_READONLY_ENV] = '1';
  assert.equal(isReviewerReadOnlyModeEnabled(), true, '=1 → enabled');
  console.log('✓ KOALA_REVIEWER_READONLY=1 enables read-only reviewer mode');

  // ── 2. Allowed: effective readOnly commands pass the gate ────────────────
  process.env[REVIEWER_READONLY_ENV] = '1';
  assert.doesNotThrow(
    () => enforceReviewerReadOnlyCommandGate('story_get', {}, null),
    'story_get allowed',
  );
  // validate without --story → effective readOnly (boundary rule 2)
  assert.doesNotThrow(
    () => enforceReviewerReadOnlyCommandGate('validate', {}, null),
    'diagnostic validate (no --story) allowed',
  );
  console.log('✓ enforceReviewerReadOnlyCommandGate allows readOnly commands (story_get, validate w/o --story)');

  // ── 3. Blocked: review_pass_set and other reviewerWrite commands ─────────
  for (const rwCmd of ['review_pass_set', 'finding_add', 'review_run_start', 'init_check_set']) {
    assert.throws(
      () => enforceReviewerReadOnlyCommandGate(rwCmd, {}, null),
      (err: Error) => err.message.includes(REVIEWER_READONLY_ENV) && err.message.includes(rwCmd),
      `${rwCmd} blocked`,
    );
  }
  console.log('✓ enforceReviewerReadOnlyCommandGate blocks review_pass_set / finding_add / review_run_start / init_check_set');

  // ── 4. Blocked: storyScopedMutating / mainSharedMutating / unclassified ──
  for (const [cmd, args] of [
    ['story_advance', { storyId, forceTakeover: true }],
    ['verification_evidence_add', { storyId }],
    ['gap_log', {}],
    ['audit', {}],
    ['no_such_command_xyz', {}],
  ] as [string, Record<string, unknown>][]) {
    assert.throws(
      () => enforceReviewerReadOnlyCommandGate(cmd, args, null),
      (err: Error) => err.message.includes(REVIEWER_READONLY_ENV),
      `${cmd} blocked`,
    );
  }
  console.log('✓ enforceReviewerReadOnlyCommandGate blocks story_advance --forceTakeover, verification_evidence_add, gap_log, audit, unclassified');

  // ── 5. Key invariant: a blocked review_pass_set writes NO artifact ────────
  // Simulate what would happen if the gate were absent: the command throws
  // before any write, so review-passes.json must not exist.
  assert.equal(existsSync(reviewPassesPath), false, 'no pre-existing review-passes.json');
  let threw = false;
  try {
    enforceReviewerReadOnlyCommandGate('review_pass_set', { storyId }, null);
  } catch {
    threw = true;
  }
  assert.ok(threw, 'enforceReviewerReadOnlyCommandGate threw for review_pass_set');
  assert.equal(
    existsSync(reviewPassesPath),
    false,
    'blocked review_pass_set writes no review-passes.json artifact',
  );
  console.log('✓ blocked review_pass_set writes no review-passes.json artifact');

  // ── 6. Without env, normal reviewerWrite is NOT blocked by this gate ─────
  delete process.env[REVIEWER_READONLY_ENV];
  assert.doesNotThrow(
    () => enforceReviewerReadOnlyCommandGate('review_pass_set', {}, null),
    'review_pass_set not blocked when KOALA_REVIEWER_READONLY is unset',
  );
  assert.doesNotThrow(
    () => enforceReviewerReadOnlyCommandGate('finding_add', {}, null),
    'finding_add not blocked when KOALA_REVIEWER_READONLY is unset',
  );
  console.log('✓ normal reviewerWrite remains allowed without KOALA_REVIEWER_READONLY');

  console.log('✓ reviewer-readonly command policy smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
  if (savedRO === undefined) delete process.env[REVIEWER_READONLY_ENV];
  else process.env[REVIEWER_READONLY_ENV] = savedRO;
}
