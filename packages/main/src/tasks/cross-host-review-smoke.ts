#!/usr/bin/env node

/**
 * Cross-host review smoke (story B-f57a).
 *
 * RED phase: this asserts the `cross_host_review` command is registered. On the
 * pre-fix baseline the command does not exist, so `registry.get('cross_host_review')`
 * returns undefined and this assertion fails — an un-gameable proof that the
 * orchestration surface is missing. GREEN assertions (fake-Codex seam: capture,
 * materialHash binding, fail-closed, disagreement surfacing) are added in DEV.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function makeRegistry(): ReturnType<typeof createMainRegistry> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-xhr-smoke-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
    proofAdmissibility: { mode: 'enforce', enforcedConsumers: ['REVIEW'] },
  }, null, 2) + '\n');
  resetConfigCache();
  const store = new StoryStore(root);
  const ctx: HandlerContext = { root, store, scanRoot: join(root, 'packages/main') };
  return createMainRegistry(ctx);
}

function main(): void {
  const registry = makeRegistry();
  assert.ok(
    registry.get('cross_host_review'),
    'cross_host_review command must be registered',
  );
  console.log('cross-host-review smoke passed: cross_host_review is registered');
}

main();
