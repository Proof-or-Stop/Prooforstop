#!/usr/bin/env bun

/** Production-path integration seam for DYN-3/DYN-5. */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runStoryAwareDynamicValidation } from '../handlers/story-aware-validation.js';

const root = mkdtempSync(join(tmpdir(), 'proof-story-aware-production-'));
const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/.keep'), '\n');
  const caseRegistryPath = 'packages/main/src/review-pass-cases.json';
  writeFileSync(join(root, caseRegistryPath), JSON.stringify([
    { caseId: 'review-pass:case-1', domain: 'review-pass', sentinel: true },
    { caseId: 'review-pass:case-2', domain: 'review-pass' },
    { caseId: 'review-pass:case-3', domain: 'review-pass' },
  ]) + '\n');
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    validate: {
      commands: [
        { command: process.execPath, args: ['-e', "process.stdout.write('build\\n')", 'build'], label: 'build' },
        { command: process.execPath, args: ['-e', "process.stdout.write('PROOF_OR_STOP_SENTINEL:'+process.env.LATTICE_VALIDATION_SHARD_SENTINEL+'\\n')", 'review-pass'], label: 'review-pass-discard-smoke', caseRegistryPath },
      ],
    },
  }, null, 2));
  git(['init']);
  git(['config', 'user.email', 'smoke@example.test']);
  git(['config', 'user.name', 'Proof-or-Stop Smoke']);
  git(['add', '.']);
  git(['commit', '-m', 'production validation fixture']);
  const head = git(['rev-parse', 'HEAD']);
  const commands = [
    { command: process.execPath, args: ['-e', "process.stdout.write('build\\n')", 'build'], label: 'build' },
    {
      command: process.execPath,
      args: ['-e', "const fs=require('node:fs'); const cases=JSON.parse(fs.readFileSync(process.env.LATTICE_VALIDATION_SHARD_CASE_REGISTRY,'utf8')); const ids=cases.filter(c=>process.env.LATTICE_VALIDATION_SHARD_CASE_IDS.split(',').includes(c.caseId)).map(c=>c.caseId).join(','); process.stdout.write('PROOF_OR_STOP_CASES:'+ids+'\\nPROOF_OR_STOP_SENTINEL:'+process.env.LATTICE_VALIDATION_SHARD_SENTINEL+'\\n')", 'review-pass'],
      label: 'review-pass-discard-smoke',
      env: { LATTICE_VALIDATION_SHARD_ADAPTER: 'case-registry-output-v1' },
      caseRegistryPath,
    },
  ];
  const run = await runStoryAwareDynamicValidation({
    projectRoot: root,
    gitCwd: root,
    storyId: 'B-production',
    baseHead: head,
    head,
    changedFiles: [],
    mode: 'enforce-low-risk',
    commands,
  });
  assert.equal(run.buildResult.allPass, true);
  assert.equal(run.authority.authoritative, false, 'no canonical baseline must fail closed');
  const shardRoot = join(root, '.proof-or-stop/runtime/dynamic-validation/B-production/shards');
  assert.equal(existsSync(shardRoot), true, 'production run must persist shard artifacts');
  const shardFiles = readFileSync(join(shardRoot, readdirSync(shardRoot).find(name => name.endsWith('aggregate.json'))!), 'utf8');
  assert.match(shardFiles, /coveredCaseIds/);
  console.log('story-aware validation production path PASS');
  console.log('production shard receipts PASS');
  console.log('gate-owned authority fallback PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
