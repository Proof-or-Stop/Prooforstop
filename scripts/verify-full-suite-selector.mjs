#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

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
const atomicWrite = (path, value) => { const temporary = `${path}.tmp-${process.pid}`; writeFileSync(temporary, value); renameSync(temporary, path); };
const fileDigests = () => Object.fromEntries(artifacts.map(path => {
  assert.ok(existsSync(path), `capture artifact missing: ${path}`);
  return [path, digest(readFileSync(path))];
}));
const identity = () => ({
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  material: execFileSync(process.execPath, ['--input-type=module', '-e', "import{currentMaterialHash}from'./packages/main/dist/core/evidence-freshness.js';process.stdout.write(currentMaterialHash(process.cwd())??'')"], { cwd: root, encoding: 'utf8' }),
});
export function validateSelectorReceipt(receipt, selector, current, currentFileDigests) {
  assert.equal(receipt.schema, 'b9812.full-suite-contract-capture.v2');
  assert.equal(receipt.head, current.head, 'capture HEAD changed; non-ancestor or metadata descendant requires a new capture');
  assert.equal(receipt.material, current.material, 'capture material changed');
  assert.deepEqual(receipt.fileDigests, currentFileDigests, 'captured artifact or verifier source digest changed');
  assert.ok(Object.hasOwn(receipt.predicates, selector), `selector missing from capture: ${selector}`);
  assert.equal(receipt.predicates[selector].passed, true, `selector predicate did not pass: ${selector}`);
  assert.equal(receipt.predicates[selector].outputDigest, digest(`VERIFIED ${selector}`), `selector predicate digest changed: ${selector}`);
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--capture') {
  const output = execFileSync(process.execPath, ['scripts/verify-full-suite-contract.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const selectors = output.split(/\r?\n/).filter(line => line.startsWith('VERIFIED ')).map(line => line.slice('VERIFIED '.length));
  assert.equal(selectors.length, 52, 'capture requires all 52 conditional selectors');
  const current = identity();
  const predicates = Object.fromEntries(selectors.map(selector => [selector, { passed: true, outputDigest: digest(`VERIFIED ${selector}`) }]));
  const serialized = `${JSON.stringify({ schema: 'b9812.full-suite-contract-capture.v2', ...current, predicates, fileDigests: fileDigests() }, null, 2)}\n`;
  atomicWrite(receiptPath, serialized);
  atomicWrite(`${receiptPath}.sha256`, `${digest(serialized)}\n`);
  process.stdout.write(`FULL_SUITE_SELECTOR_CAPTURE=PASS selectors=${selectors.length} head=${current.head} material=${current.material}\n`);
} else if (args.length === 2 && args[0] === '--selector') {
  const selector = args[1];
  const serialized = readFileSync(receiptPath, 'utf8');
  assert.equal(readFileSync(`${receiptPath}.sha256`, 'utf8').trim(), digest(serialized), 'capture receipt bytes changed');
  const receipt = JSON.parse(serialized);
  const current = identity();
  validateSelectorReceipt(receipt, selector, current, fileDigests());
  process.stdout.write(`VERIFIED ${selector}\n`);
} else if (args.length === 1 && args[0] === '--self-test') {
  const current = { head: 'h', material: 'm' };
  const files = { verifier: 'd' };
  const selector = 'CHK-001:happy:0';
  const valid = { schema: 'b9812.full-suite-contract-capture.v2', ...current, fileDigests: files, predicates: { [selector]: { passed: true, outputDigest: digest(`VERIFIED ${selector}`) } } };
  validateSelectorReceipt(valid, selector, current, files);
  for (const [label, mutation] of [
    ['missing selector', value => { value.predicates = {}; }],
    ['failed selector', value => { value.predicates[selector].passed = false; }],
    ['changed verifier source', value => { value.fileDigests.verifier = 'changed'; }],
    ['non-ancestor/source drift identity', value => { value.head = 'other'; }],
  ]) {
    const changed = structuredClone(valid); mutation(changed);
    let rejected = false; try { validateSelectorReceipt(changed, selector, current, files); } catch { rejected = true; }
    assert.equal(rejected, true, `${label} must fail closed`);
  }
  const bytes = JSON.stringify(valid); assert.notEqual(digest(`${bytes}x`), digest(bytes), 'changed receipt byte must alter sidecar digest');
  process.stdout.write('FULL_SUITE_SELECTOR_SELF_TEST=PASS assertions=6\n');
} else {
  throw new Error('usage: verify-full-suite-selector.mjs --capture | --selector CHK-nnn:lane:index | --self-test');
}
