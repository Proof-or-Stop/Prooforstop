#!/usr/bin/env node
/**
 * Lab managed-no-start-signal: in run 7 (2026-09-30) an inventory critic wrote
 * its proposal to a file and ended its turn with only the liveness line
 * `DISPATCH_START:proof-or-stop-review-topology-critic/inventory` that the role
 * prompt asks for "after starting", so the run had no final proposal and failed.
 * A managed provider run is observed by the host itself; its prompt must not ask
 * for a start signal that competes with the one JSON final result.
 */
import assert from 'node:assert/strict';
import { renderAgentLivenessGuidance } from '../core/agent-liveness-policy.js';
import { renderManagedReviewerProviderPrompt } from '../core/managed-review-evidence.js';

const base = [
  '## Review task',
  `- ${renderAgentLivenessGuidance({ label: 'proof-or-stop-review-topology-critic/inventory', startSignal: 'DISPATCH_START:proof-or-stop-review-topology-critic/inventory' })}`,
  'Review the change.',
].join('\n');
assert.match(base, /first output `DISPATCH_START:/, 'fixture carries the native liveness start signal');
const managed = renderManagedReviewerProviderPrompt(base, '/app/.worktrees/B-x');
assert.doesNotMatch(managed, /DISPATCH_START/, `managed reviewer prompt still asks for a start signal:\n${managed}`);
assert.match(managed, /Review the change\./, 'the rest of the role prompt is kept');
console.log('managed-no-start-signal-smoke: PASS');
