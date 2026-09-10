#!/usr/bin/env node

import assert from 'node:assert/strict';
import { validateSelectorReceiptCore } from './full-suite-selector-contract.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
execFileSync(process.execPath, ['scripts/verify-full-suite-build-binding.mjs'], { cwd: root, stdio: 'pipe' });
const receiptPath = process.env.B9812_SELECTOR_RECEIPT ?? '/tmp/b9812-final-v3-contract-capture.json';
const artifacts = [
  '/tmp/b9812-final-v3-cohort-jobs1.json', '/tmp/b9812-final-v3-cohort-jobs1.identity',
  '/tmp/b9812-final-v3-cohort-jobs3.json', '/tmp/b9812-final-v3-cohort-jobs3.identity',
  '/tmp/b9812-final-v3-serial.json', '/tmp/b9812-final-v3-serial.exit', '/tmp/b9812-final-v3-serial.identity', '/tmp/b9812-final-v3-serial.timing',
  ...[1, 2, 3].flatMap(index => [`/tmp/b9812-final-v3-run${index}.json`, `/tmp/b9812-final-v3-run${index}.exit`, `/tmp/b9812-final-v3-run${index}.identity`, `/tmp/b9812-final-v3-run${index}.timing`]),
  ...[3, 5].flatMap(jobs => [`/tmp/b9812-final-v3-jobs${jobs}.json`, `/tmp/b9812-final-v3-jobs${jobs}.exit`, `/tmp/b9812-final-v3-jobs${jobs}.identity`, `/tmp/b9812-final-v3-jobs${jobs}.timing`]),
  '/tmp/b9812-final-v3-stress20.log', '/tmp/b9812-final-v3-stress20.exit', '/tmp/b9812-final-v3-stress20.timing',
  '/tmp/b9812-final-v3-injected-fixtures.log', '/tmp/b9812-final-v3-injected-fixtures.exit',
  '/tmp/b9812-final-v3-fixed-port-os.json',
  '.proof-or-stop/story/actives/B-9812/done-required-evidence.json',
  'scripts/verify-full-suite-contract.mjs',
  'scripts/verify-full-suite-selector.mjs',
  'scripts/full-suite-selector-contract.mjs',
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
const METADATA_PREFIX = '.proof-or-stop/story/actives/B-9812/';
const METADATA_ALLOWLIST = new Set(['owner-lease.json', 'closeout-write-receipts.jsonl', 'done-required-evidence.json', 'test-evidence.json', 'checklist.json', 'findings.json', 'gate-failure-counts.json', 'process-events.jsonl', 'index.json', 'process-metrics.json', 'prompt-envelopes.json', 'review-runs.json', 'review-passes.json', 'delivery-check.json', 'stall-adjudication.json', 'scope-contract.json']);
export const captureHeadIsAdmissible = (receiptHead, currentHead, cwd = root) => {
  try { execFileSync('git', ['merge-base', '--is-ancestor', receiptHead, currentHead], { cwd, stdio: 'ignore' }); }
  catch { return false; }
  const changed = execFileSync('git', ['diff', '--name-only', `${receiptHead}..${currentHead}`], { cwd, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  return changed.every(path => path.startsWith(METADATA_PREFIX) && METADATA_ALLOWLIST.has(path.slice(METADATA_PREFIX.length)));
};
export function validateSelectorReceipt(receipt, selector, current, currentFileDigests, headAdmissible = captureHeadIsAdmissible) {
  return validateSelectorReceiptCore(receipt, selector, current, currentFileDigests, headAdmissible);
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--capture') {
  const output = execFileSync(process.execPath, ['scripts/verify-full-suite-contract.mjs', '--evaluate-internal'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
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
} else if (args.length === 1 && args[0] === '--all') {
  const started = performance.now();
  const serialized = readFileSync(receiptPath, 'utf8');
  assert.equal(readFileSync(`${receiptPath}.sha256`, 'utf8').trim(), digest(serialized), 'capture receipt bytes changed');
  const receipt = JSON.parse(serialized);
  const current = identity();
  const currentDigests = fileDigests();
  const selectors = Object.keys(receipt.predicates);
  assert.equal(selectors.length, 52, 'capture must contain exactly 52 predicates');
  for (const selector of selectors) {
    validateSelectorReceipt(receipt, selector, current, currentDigests);
    process.stdout.write(`VERIFIED ${selector}\n`);
  }
  assert.ok(performance.now() - started < 2_000, 'fast verifier exceeded 2 seconds');
  process.stdout.write(`FULL_SUITE_CONTRACT=PASS selectors=${selectors.length}\n`);
} else if (args.length === 1 && args[0] === '--self-test') {
  const current = { head: 'h', material: 'm' };
  const files = { verifier: 'd' };
  const selector = 'CHK-001:happy:0';
  const retainedSelector = 'CHK-001:edge:0';
  const valid = { schema: 'b9812.full-suite-contract-capture.v2', ...current, fileDigests: files, predicates: {
    [selector]: { passed: true, outputDigest: digest(`VERIFIED ${selector}`) },
    [retainedSelector]: { passed: true, outputDigest: digest(`VERIFIED ${retainedSelector}`) },
  } };
  const sameHead = (a, b) => a === b;
  validateSelectorReceipt(valid, selector, current, files, sameHead);
  for (const [label, mutation] of [
    ['missing selector', value => { value.predicates = {}; }],
    ['failed selector', value => { value.predicates[selector].passed = false; }],
    ['changed verifier source', value => { value.fileDigests.verifier = 'changed'; }],
    ['non-ancestor/source drift identity', value => { value.head = 'other'; }],
  ]) {
    const changed = structuredClone(valid); mutation(changed);
    let rejected = false; try { validateSelectorReceipt(changed, selector, current, files, sameHead); } catch { rejected = true; }
    assert.equal(rejected, true, `${label} must fail closed`);
  }
  const removedOne = structuredClone(valid);
  delete removedOne.predicates[selector];
  validateSelectorReceipt(removedOne, retainedSelector, current, files, sameHead);
  let removedSelectorRejected = false;
  try { validateSelectorReceipt(removedOne, selector, current, files, sameHead); } catch { removedSelectorRejected = true; }
  assert.equal(removedSelectorRejected, true, 'removing one evidence component suppresses only its selector');
  const bytes = JSON.stringify(valid); assert.notEqual(digest(`${bytes}x`), digest(bytes), 'changed receipt byte must alter sidecar digest');
  const metadataDescendant = { head: 'new', material: 'm' };
  validateSelectorReceipt(valid, selector, metadataDescendant, files, () => true);
  let sourceDriftRejected = false;
  try { validateSelectorReceipt(valid, selector, metadataDescendant, files, () => false); } catch { sourceDriftRejected = true; }
  assert.equal(sourceDriftRejected, true, 'non-metadata descendant must fail closed');
  assert.equal(METADATA_ALLOWLIST.has('prompt-envelopes.json') && METADATA_ALLOWLIST.has('review-runs.json') && METADATA_ALLOWLIST.has('review-passes.json'), true, 'normal REVIEW dispatch and pass metadata is allowlisted');
  assert.equal(METADATA_ALLOWLIST.has('delivery-check.json'), true, 'normal delivery approval metadata is allowlisted');
  assert.equal(METADATA_ALLOWLIST.has('stall-adjudication.json') && METADATA_ALLOWLIST.has('scope-contract.json'), true, 'normal convergence and scope metadata is allowlisted');
  assert.equal(METADATA_ALLOWLIST.has('test-evidence.json'), true, 'normal DONE-required command evidence metadata is allowlisted');
  assert.equal(METADATA_ALLOWLIST.has('gate-failure-counts.json'), true, 'normal lifecycle gate-attempt metadata is allowlisted');
  assert.equal(METADATA_ALLOWLIST.has('unknown-review-metadata.json'), false, 'unknown REVIEW metadata remains denied');
  const fixture = mkdtempSync(join(tmpdir(), 'b9812-selector-metadata-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: fixture });
    execFileSync('git', ['config', 'user.email', 'selector@example.test'], { cwd: fixture });
    execFileSync('git', ['config', 'user.name', 'Selector Fixture'], { cwd: fixture });
    writeFileSync(join(fixture, 'base.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: fixture });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: fixture });
    const fixtureBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
    const metadataRoot = join(fixture, METADATA_PREFIX);
    mkdirSync(metadataRoot, { recursive: true });
    writeFileSync(join(metadataRoot, 'stall-adjudication.json'), '{}\n');
    writeFileSync(join(metadataRoot, 'scope-contract.json'), '{}\n');
    writeFileSync(join(metadataRoot, 'review-passes.json'), '{}\n');
    writeFileSync(join(metadataRoot, 'delivery-check.json'), '{}\n');
    writeFileSync(join(metadataRoot, 'test-evidence.json'), '{}\n');
    writeFileSync(join(metadataRoot, 'gate-failure-counts.json'), '{}\n');
    execFileSync('git', ['add', '.'], { cwd: fixture });
    execFileSync('git', ['commit', '-qm', 'normal lifecycle descendant'], { cwd: fixture });
    const lifecycleHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
    assert.equal(captureHeadIsAdmissible(fixtureBase, lifecycleHead, fixture), true, 'actual lifecycle metadata descendant is admissible');
    writeFileSync(join(metadataRoot, 'unknown-review-metadata.json'), '{}\n');
    execFileSync('git', ['add', '.'], { cwd: fixture });
    execFileSync('git', ['commit', '-qm', 'unknown metadata descendant'], { cwd: fixture });
    const unknownHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
    assert.equal(captureHeadIsAdmissible(fixtureBase, unknownHead, fixture), false, 'actual unknown metadata descendant is denied');
  } finally { rmSync(fixture, { recursive: true, force: true }); }
  process.stdout.write('FULL_SUITE_SELECTOR_SELF_TEST=PASS assertions=11\n');
} else {
  throw new Error('usage: verify-full-suite-selector.mjs --capture | --all | --selector CHK-nnn:lane:index | --self-test');
}
