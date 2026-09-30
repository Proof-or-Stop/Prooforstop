#!/usr/bin/env node
/**
 * Workflow presets say what they do: every profile's review.blockingSeverities
 * equals the finding closure set (core/finding-closure-severities.ts:
 * critical/high/medium; low advisory), and workflow_show / workflow_set / the
 * synced CLAUDE.md profile section report exactly that set.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKFLOW_PRESETS, type WorkflowProfile } from '../core/types.js';
import { CLOSURE_REQUIRED_SEVERITIES, closureBlockingSeverities } from '../core/finding-closure-severities.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { createWorkflowHandlers } from '../handlers/workflow.js';
import { syncProfileSection } from '../claude-md-sync.js';

const closure = [...CLOSURE_REQUIRED_SEVERITIES];
for (const profile of ['light', 'balanced', 'strict'] as WorkflowProfile[]) {
  const policy = WORKFLOW_PRESETS[profile];
  assert.deepEqual([...policy.review.blockingSeverities], closure, `${profile} preset blockingSeverities must equal the closure set`);
  assert.deepEqual(closureBlockingSeverities(policy), closure, `${profile} closure set`);
}
console.log('✓ every preset blockingSeverities equals the closure set');

const root = mkdtempSync(join(tmpdir(), 'workflow-preset-closure-'));
try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ workflow: { profile: 'balanced' } }) + '\n');
  writeFileSync(join(root, 'CLAUDE.md'), '# Project\n');
  resetConfigCache();
  const handlers = createWorkflowHandlers({ root, store: new StoryStore(root), scanRoot: root } as never);
  const shown = handlers.workflow_show();
  assert.match(shown, /blockingSeverities=\[critical,high,medium\]/, `workflow_show reports the closure set:\n${shown}`);
  const set = handlers.workflow_set({ profile: 'light' });
  assert.doesNotMatch(set, /blockingSeverities/, `profile switch never changes blocking severities:\n${set}`);
  assert.match(set, /verified critical\/high\/medium findings must be closed before TEST and DONE/, `safety floors name the closure rule:\n${set}`);
  const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /critical, high, medium/, `light profile section names the closure set:\n${claudeMd}`);
  syncProfileSection(join(root, 'CLAUDE.md'), 'balanced');
  assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /blocking severities: \[critical, high, medium\]/);
  console.log('✓ workflow_show / workflow_set / CLAUDE.md profile section report the closure set');
} finally { rmSync(root, { recursive: true, force: true }); }
console.log('workflow-preset-closure-smoke: PASS');
