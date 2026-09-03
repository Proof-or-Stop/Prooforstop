#!/usr/bin/env node
/**
 * @task B-bcd4
 * @checklist CHK-003
 * @title retired-root guard smoke
 * @type feature
 * @priority high
 * @description
 *   Focused smoke coverage for the retired-root/canonical-root guard. The
 *   smoke verifies the guard uses the live command ownership classifier:
 *   read-only commands remain available, while every effective write class is
 *   blocked before handler dispatch in a retired root.
 * @changes
 *   - [CHK-002] Verify mutating workflow commands fail closed in retired roots
 *   - [CHK-003] Verify read-only and malformed-config retired-root behavior
 */
import assert from 'node:assert/strict';
import { enforceRetiredRootGuard } from '../cli/ownership-gate.js';
import type { ProofOrStopConfig } from '../core/config.js';

const retiredRoot = '/tmp/proof-or-stop-retired-root';
const canonicalRoot = '/tmp/proof-or-stop-canonical-root';
const activeStory = { storyId: 'B-bcd4', phase: 'DEV' };

const retiredConfig: Pick<ProofOrStopConfig, 'retiredRoot' | 'canonicalRoot'> = {
  retiredRoot: true,
  canonicalRoot,
};

const normalConfig: Pick<ProofOrStopConfig, 'retiredRoot' | 'canonicalRoot'> = {};

function allow(
  label: string,
  cmd: string,
  args: Record<string, unknown>,
  config: Pick<ProofOrStopConfig, 'retiredRoot' | 'canonicalRoot'> = retiredConfig,
): void {
  assert.doesNotThrow(
    () => enforceRetiredRootGuard(cmd, args, config, activeStory, retiredRoot),
    label,
  );
}

function block(
  label: string,
  cmd: string,
  args: Record<string, unknown>,
  config: Pick<ProofOrStopConfig, 'retiredRoot' | 'canonicalRoot'> = retiredConfig,
): Error {
  try {
    enforceRetiredRootGuard(cmd, args, config, activeStory, retiredRoot);
  } catch (error) {
    assert.ok(error instanceof Error, `${label}: thrown value is Error`);
    assert.match(error.message, /Proof-or-Stop root is retired:/, `${label}: retired-root phrase`);
    assert.match(error.message, /Use canonicalRoot:/, `${label}: canonicalRoot phrase`);
    return error;
  }
  assert.fail(label);
}

allow('session_brief stays available for legacy evidence lookup', 'session_brief', {});
allow('story_get stays available for legacy evidence lookup', 'story_get', { storyId: 'B-bcd4' });
allow('diagnostic validate without --story remains read-only', 'validate', {});
allow('non-retired config leaves story_create unchanged', 'story_create', {}, normalConfig);

block('story_create is a shared metadata write and is blocked', 'story_create', {});
block('checklist_update is a story-scoped write and is blocked', 'checklist_update', { storyId: 'B-bcd4' });
block('validate --story writes test evidence and is blocked', 'validate', { story: 'B-bcd4' });
block('review_pass_set is a reviewer write and is blocked', 'review_pass_set', { storyId: 'B-bcd4' });
block('story_discard is dangerous mutating and is blocked', 'story_discard', { storyId: 'B-bcd4' });

const malformed = block(
  'retiredRoot without canonicalRoot fails closed for mutating commands',
  'story_create',
  {},
  { retiredRoot: true },
);
assert.match(
  malformed.message,
  /retiredRoot is true but canonicalRoot is not configured/,
  'malformed retired-root config explains missing canonicalRoot',
);

console.log('retired-root guard smoke PASS');
