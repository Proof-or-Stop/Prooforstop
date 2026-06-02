#!/usr/bin/env node

import assert from 'node:assert/strict';
import { MAIN_TOOLS } from '../cli-engine.js';
import { StoryStore } from '../core/store.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMainRegistry } from '../registry.js';

const EXPECTED_COMMANDS = [
  'host_runtime_list',
  'host_runtime_probe',
  'dispatch_plan',
  'dispatch_prepare',
  'dispatch_run',
  'receipt_create',
  'dispatch_collect',
  'dispatch_status',
  'dispatch_list',
  'dispatch_resume',
  'dispatch_cancel',
  'dispatch_review',
  'merge_plan',
] as const;

const repoRoot = process.cwd();
const store = new StoryStore(repoRoot);
const ctx: HandlerContext = {
  store,
  root: repoRoot,
  scanRoot: `${repoRoot}/packages/main`,
};
const registry = createMainRegistry(ctx);

const missingFromMainTools = EXPECTED_COMMANDS.filter((command) =>
  !MAIN_TOOLS.some((tool) => tool.name === command),
);
const missingFromRegistry = EXPECTED_COMMANDS.filter((command) => !registry.has(command));

const missing = [...new Set([...missingFromMainTools, ...missingFromRegistry])];

assert.equal(
  missing.length,
  0,
  [
    'dispatch-run smoke is a deliberate skeleton in this story worktree.',
    'It only becomes executable after the core implementer lands the dispatch runtime commands.',
    `Missing command registration: ${missing.join(', ') || '(none)'}.`,
    'Next step: land the runtime/handler registration first, then replace this skeleton with full deterministic coverage.',
  ].join(' '),
);

assert.fail(
  [
    'dispatch-run runtime commands are now registered, but this story-owned smoke is still a placeholder.',
    'Replace it with the full deterministic assertions for host runtime probing, supervised dispatch flow, receipts, multi-agent fake runs, degradation paths, and registration coverage before treating it as passing evidence.',
  ].join(' '),
);
