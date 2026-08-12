#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const root = process.cwd();
const receiptPath = process.env.B9812_SELECTOR_RECEIPT ?? '/tmp/b9812-final-v2-contract-capture.json';
const artifacts = [
  '/tmp/b9812-final-v2-cohort-jobs1.json', '/tmp/b9812-final-v2-cohort-jobs1.identity',
  '/tmp/b9812-final-v2-cohort-jobs3.json', '/tmp/b9812-final-v2-cohort-jobs3.identity',
  '/tmp/b9812-final-v2-serial.json', '/tmp/b9812-final-v2-serial.exit', '/tmp/b9812-final-v2-serial.identity', '/tmp/b9812-final-v2-serial.timing',
  ...[1, 2, 3].flatMap(index => [`/tmp/b9812-final-v2-run${index}.json`, `/tmp/b9812-final-v2-run${index}.exit`, `/tmp/b9812-final-v2-run${index}.identity`, `/tmp/b9812-final-v2-run${index}.timing`]),
  '.lattice/story/actives/B-9812/done-required-evidence.json',
  'scripts/verify-full-suite-contract.mjs',
];
const digest = value => createHash('sha256').update(value).digest('hex');
const fileDigests = () => Object.fromEntries(artifacts.map(path => {
  assert.ok(existsSync(path), `capture artifact missing: ${path}`);
  return [path, digest(readFileSync(path))];
}));
const identity = () => ({
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  material: execFileSync(process.execPath, ['--input-type=module', '-e', "import{currentMaterialHash}from'./packages/main/dist/core/evidence-freshness.js';process.stdout.write(currentMaterialHash(process.cwd())??'')"], { cwd: root, encoding: 'utf8' }),
});

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--capture') {
  const output = execFileSync(process.execPath, ['scripts/verify-full-suite-contract.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const selectors = output.split(/\r?\n/).filter(line => line.startsWith('VERIFIED ')).map(line => line.slice('VERIFIED '.length));
  assert.equal(selectors.length, 52, 'capture requires all 52 conditional selectors');
  const current = identity();
  writeFileSync(receiptPath, `${JSON.stringify({ schema: 'b9812.full-suite-contract-capture.v1', ...current, selectors, fileDigests: fileDigests() }, null, 2)}\n`);
  process.stdout.write(`FULL_SUITE_SELECTOR_CAPTURE=PASS selectors=${selectors.length} head=${current.head} material=${current.material}\n`);
} else if (args.length === 2 && args[0] === '--selector') {
  const selector = args[1];
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const current = identity();
  assert.equal(receipt.schema, 'b9812.full-suite-contract-capture.v1');
  assert.equal(receipt.head, current.head, 'capture HEAD changed; metadata descendants require a new capture');
  assert.equal(receipt.material, current.material, 'capture material changed');
  assert.deepEqual(receipt.fileDigests, fileDigests(), 'captured artifact digest changed');
  assert.ok(receipt.selectors.includes(selector), `selector not proven by capture: ${selector}`);
  process.stdout.write(`VERIFIED ${selector}\n`);
} else {
  throw new Error('usage: verify-full-suite-selector.mjs --capture | --selector CHK-nnn:lane:index');
}
