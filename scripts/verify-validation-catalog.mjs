#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const mode = process.argv[2] || '';
const source = String.raw`
import assert from 'node:assert/strict';
import {
  compileValidationCatalog,
  discoverValidationInventory,
  validateValidationCatalog,
} from './packages/main/src/core/story-aware-validation.ts';

const inventory = discoverValidationInventory('.', [
  { id: 'build', label: 'build', command: 'node', args: ['build.js'], originalIndex: 0, resources: [] },
  { id: 'test', label: 'test', command: 'node', args: ['test.js'], originalIndex: 1, resources: [] },
]);
const catalog = compileValidationCatalog(inventory, { inputRoots: ['packages/main/src'] });
const valid = validateValidationCatalog(inventory, catalog);
assert.equal(valid.ok, true, valid.errors.join('; '));
const mode = process.env.AUDIT_MODE || '';
if (mode === '--mutation=closure-policy') {
  const mutant = catalog.map((entry) => ({ ...entry }));
  mutant[0] = { ...mutant[0], closurePolicy: 'not-a-policy' };
  assert.equal(validateValidationCatalog(inventory, mutant).ok, false);
  console.log('conservative closure policy');
} else if (mode === '--mutation-suite') {
  const mutants = [
    catalog.map((entry) => ({ ...entry, schema: 'wrong-schema' })),
    catalog.map((entry) => ({ ...entry, inputRoots: ['packages/main/dist/only.js'] })),
    catalog.map((entry) => ({ ...entry, triggerExtensions: { ...entry.triggerExtensions, processFacts: ['unknown-fact'] } })),
    catalog.map((entry) => ({ ...entry, resources: [{ class: 'unknown-resource', key: '.', access: 'shared' }] })),
  ];
  for (const mutant of mutants) assert.equal(validateValidationCatalog(inventory, mutant).ok, false);
  console.log('catalog closure mutants rejected');
} else {
  console.log('validation catalog PASS');
  console.log('catalog commands: ' + catalog.length);
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
