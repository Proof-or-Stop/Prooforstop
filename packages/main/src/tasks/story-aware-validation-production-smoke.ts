#!/usr/bin/env bun

/** Production-path integration seam for DYN-3/DYN-5. */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runStoryAwareDynamicValidation } from '../handlers/story-aware-validation.js';
import { verifyValidationShardReceipt } from '../core/story-aware-validation.js';

const root = mkdtempSync(join(tmpdir(), 'proof-story-aware-production-'));
const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/.keep'), '\n');
  const caseRegistryPath = 'packages/main/src/review-pass-cases.json';
  const adapterPath = 'packages/main/src/tasks/story-aware-validation-case-adapter.mjs';
  const adapterSource = readFileSync(new URL('./story-aware-validation-case-adapter.mjs', import.meta.url), 'utf8');
  const runtimeNode = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim();
  writeFileSync(join(root, caseRegistryPath), JSON.stringify([
    { caseId: 'review-pass:case-1', domain: 'review-pass', sentinel: true },
    { caseId: 'review-pass:case-2', domain: 'review-pass', sentinel: true },
    { caseId: 'review-pass:case-3', domain: 'review-pass', sentinel: true },
  ]) + '\n');
  mkdirSync(join(root, 'packages/main/src/tasks'), { recursive: true });
  writeFileSync(join(root, adapterPath), adapterSource);
  mkdirSync(join(root, 'packages/main/src/core'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/core/validation-runtime-tracer.cjs'), readFileSync(new URL('../core/validation-runtime-tracer.cjs', import.meta.url), 'utf8'));
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    validate: {
      commands: [
        { command: runtimeNode, args: ['-e', "process.stdout.write('build\\n')", 'build'], label: 'build', assurance: 'story-selectable', riskTier: 'local', closurePolicy: 'static-and-traced', fullBaselineReusePolicy: 'not-applicable' },
        { command: runtimeNode, args: [adapterPath, 'review-pass'], label: 'review-pass-discard-smoke', env: { LATTICE_VALIDATION_SHARD_ADAPTER: 'case-registry-output-v1' }, caseRegistryPath, assurance: 'story-selectable', riskTier: 'local', closurePolicy: 'static-and-traced', fullBaselineReusePolicy: 'not-applicable' },
      ],
    },
  }, null, 2));
  git(['init']);
  git(['config', 'user.email', 'smoke@example.test']);
  git(['config', 'user.name', 'Proof-or-Stop Smoke']);
  git(['add', '.']);
  git(['commit', '-m', 'production validation fixture']);
  const head = git(['rev-parse', 'HEAD']);
  const run = await runStoryAwareDynamicValidation({
    projectRoot: root,
    gitCwd: root,
    storyId: 'B-production',
    baseHead: head,
    head,
    changedFiles: [],
    mode: 'enforce-low-risk',
  });
  assert.equal(run.buildResult.allPass, true);
  assert.equal(run.authority.authoritative, false, 'no canonical baseline must fail closed');
  const shardRoot = join(root, '.proof-or-stop/runtime/dynamic-validation/B-production/shards');
  assert.equal(existsSync(shardRoot), true, 'production run must persist shard artifacts');
  const shardFiles = readFileSync(join(shardRoot, readdirSync(shardRoot).find(name => name.endsWith('aggregate.json'))!), 'utf8');
  assert.match(shardFiles, /coveredCaseIds/);
  const receiptFiles = readdirSync(shardRoot).filter(name => name.startsWith('shard-receipt-') && name.endsWith('.json'));
  assert.equal(receiptFiles.length, 3, 'registered adapter must emit one receipt per review-pass shard');
  for (const name of receiptFiles) {
    const receipt = JSON.parse(readFileSync(join(shardRoot, name), 'utf8'));
    assert.equal(verifyValidationShardReceipt(receipt), true, `invalid persisted shard receipt ${name}`);
    assert.equal(receipt.registryObserved, true);
    assert.equal(receipt.sentinelObserved, true);
    assert.equal(receipt.residue.length, 0);
  }
  const aggregate = JSON.parse(shardFiles);
  assert.deepEqual(aggregate.coveredCaseIds.sort(), ['review-pass:case-1', 'review-pass:case-2', 'review-pass:case-3']);
  console.log('story-aware validation production path PASS');
  console.log('production shard receipts PASS');
  console.log('gate-owned authority fallback PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
