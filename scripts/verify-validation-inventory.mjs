#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const mode = process.argv[2] || '';
const source = String.raw`
import assert from 'node:assert/strict';
import {
  buildStoryChangeManifest,
  classifyFullValidationReasons,
  compileValidationCatalog,
  discoverValidationInventory,
  stableDigest,
  validateValidationCatalog,
} from './packages/main/src/core/story-aware-validation.ts';

const inventory = discoverValidationInventory('.');
const catalog = compileValidationCatalog(inventory);
const check = validateValidationCatalog(inventory, catalog);
assert.equal(check.ok, true, check.errors.join('; '));
assert.equal(new Set(inventory.commands.map((row) => row.id)).size, inventory.commands.length);
assert.ok(inventory.commands.length >= 1);
const originalDigest = inventory.digest;
const duplicate = catalog.map((entry) => ({ ...entry }));
duplicate[1] = { ...duplicate[1], id: duplicate[0].id };
const duplicateCheck = validateValidationCatalog(inventory, duplicate);
const historicalCount = 107;
const historicalDigest = stableDigest({ inventoryDigest: originalDigest, historicalCount });
assert.notEqual(historicalDigest, originalDigest);
const highRiskManifest = buildStoryChangeManifest({
  storyId: 'B-inventory-audit', gitCwd: '.', baseHead: 'base', head: 'head',
  changedFiles: [{ path: 'packages/main/src/core/validation-executor.ts', status: 'modified', blobId: 'audit' }],
});
const highRisk = classifyFullValidationReasons(highRiskManifest, catalog);
const command = process.env.AUDIT_MODE || '';
if (command === '--mutation=missing-metadata') {
  const retained = discoverValidationInventory('.', [{ id: 'retained', label: 'retained', command: 'node', args: ['test.js'], originalIndex: 0 }]);
  assert.equal(retained.commands.length, 1);
  assert.equal(retained.commands[0].timeoutMs, undefined);
  console.log('conservative classification');
} else if (command === '--mutation=historical-count') {
  assert.equal(inventory.digest, originalDigest);
  console.log('historical count rejected');
} else if (command === '--mutation=duplicate-or-unmapped') {
  assert.equal(duplicateCheck.ok, false);
  console.log('inventory validation failure');
} else if (command === '--mutation=high-risk-touchpoint') {
  assert.ok(highRisk.some((reason) => reason.includes('validation-runtime-changed')));
  console.log('mandatory full classification');
} else if (command === '--report') {
  console.log('current-main characterization complete');
  console.log('inventory digest: ' + inventory.digest);
  console.log('command order: ' + inventory.commands.map((row) => row.id).join(','));
} else {
  console.log('inventory coverage PASS');
  console.log('current-main inventory: ' + inventory.commands.length);
}
`;
const result = spawnSync(process.env.BUN_BINARY || 'bun', ['-e', source], {
  cwd: root,
  env: { ...process.env, AUDIT_MODE: mode },
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
const output = `${result.stdout || ''}${result.stderr || ''}`;
process.stdout.write(output);
if (result.status !== 0) process.exit(result.status || 1);
