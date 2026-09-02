#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptanceMatrixEvidenceProvenance,
  isAcceptanceMatrixDerivedEvidence,
} from '../dist/core/acceptance-topology.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const storyId = 'B-historical-provenance';
const historicalCommand = 'lattice acceptance_matrix';
const historicalWrapper = 'bin/lattice';
const historicalWrapperScript = `${historicalWrapper}.js`;

for (const command of [
  `proof-or-stop acceptance_matrix --storyId=${storyId}`,
  `node bin/proof-or-stop.js --root=/tmp/project acceptance_matrix --storyId=${storyId}`,
]) {
  assert.deepEqual(
    acceptanceMatrixEvidenceProvenance({ kind: 'logic_test', command }),
    { kind: 'producer_command', producerCommand: 'acceptance_matrix' },
    `canonical producer remains classified as non-evidentiary provenance: ${command}`,
  );
}

for (const command of [
  `${historicalCommand} --storyId=${storyId}`,
  `${historicalWrapper} acceptance_matrix --storyId=${storyId}`,
  `${historicalWrapperScript} acceptance_matrix --storyId=${storyId}`,
  `node ${historicalWrapperScript} acceptance_matrix --storyId=${storyId}`,
  `/usr/bin/node ./${historicalWrapperScript} --root=/tmp/x acceptance_matrix --storyId=${storyId}`,
]) {
  assert.deepEqual(
    acceptanceMatrixEvidenceProvenance({ kind: 'logic_test', command }),
    { kind: 'producer_command', producerCommand: 'acceptance_matrix' },
    `historical producer remains classified as non-evidentiary provenance: ${command}`,
  );
}

for (const command of [
  'proof-or-stop check acceptance_matrix',
  `${historicalCommand.split(' ', 1)[0]} check acceptance_matrix`,
  `${historicalWrapper} help acceptance_matrix`,
  `${historicalWrapperScript} help acceptance_matrix`,
  `node ${historicalWrapperScript} help acceptance_matrix`,
  `echo ${historicalCommand}`,
]) {
  assert.equal(
    isAcceptanceMatrixDerivedEvidence({ kind: 'logic_test', command }),
    false,
    `non-producer token placement is not provenance: ${command}`,
  );
}

const packageManifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
assert.deepEqual(packageManifest.bin, { 'proof-or-stop': 'dist/cli.js' }, 'only the canonical CLI bin is active');
for (const retiredWrapper of [historicalWrapper, historicalWrapperScript]) {
  assert.equal(existsSync(resolve(repositoryRoot, retiredWrapper)), false, `retired wrapper is unavailable: ${retiredWrapper}`);
}

console.log('PASS acceptance topology provenance: canonical and historical matrix producers classify as non-evidentiary while retired active aliases remain unavailable');
