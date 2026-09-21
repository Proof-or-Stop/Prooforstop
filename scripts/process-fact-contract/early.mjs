
import { verificationFailureMessage } from ".././verification-subprocess-budget.mjs";


import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import ts from 'typescript';
import nodeAssert from 'node:assert/strict';

import { assertStoryWriterRuntimeAdmissionContract, assertProcessFactCommandInventory } from './scope-runtime.mjs';
import { failures, read, assert, processFactRegistryPath, root } from './support.mjs';
import { assertProofStoryProgressiveBoundary } from './proofstory-closeout.mjs';
import { assertCommandPolicyInventory } from './command-contracts.mjs';
import { extractCliToolNames } from './registry-parser.mjs';

export async function runEarlyProcessChecks() {

assertStoryWriterRuntimeAdmissionContract();

if (failures.length) {
  console.error('');
  console.error('Process fact contract failed:');
  for (const message of failures.sort()) console.error(`- ${message}`);
  process.exit(1);
}

assertProofStoryProgressiveBoundary();

if (failures.length) {
  console.error('');
  console.error('Process fact contract failed:');
  for (const message of failures.sort()) console.error(`- ${message}`);
  process.exit(1);
}

assertCommandPolicyInventory(extractCliToolNames(read('packages/main/src/cli/command-catalog.ts')));

if (failures.length) {
  console.error('');
  console.error('Process fact contract failed:');
  for (const message of failures.sort()) console.error(`- ${message}`);
  process.exit(1);
}

assertProcessFactCommandInventory();

if (failures.length) {
  console.error('');
  console.error('Process fact contract failed:');
  for (const message of failures.sort()) console.error(`- ${message}`);
  process.exit(1);
}

assert(read(processFactRegistryPath).includes("name: 'runtime:changelog_history_compaction'"),
  'The exact changelog compaction exception must remain registered');

try {
  const output = execFileSync(process.execPath, [join(root, 'scripts/verify-changelog-compaction.mjs')], { cwd: root, encoding: 'utf8', timeout: 60000 });
  assert(output.includes('CHANGELOG_COMPACTION_GREEN'), 'changelog compaction executable proof must pass');
} catch (error) {
  assert(false, verificationFailureMessage('changelog compaction', error));
}
}
