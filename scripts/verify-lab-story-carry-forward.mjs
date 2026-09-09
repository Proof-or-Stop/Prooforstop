#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/lab-worktree.mjs');
const temp = mkdtempSync(join(tmpdir(), 'lab-story-carry-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (cwd, path, body) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), body);
};
const commit = (cwd, message) => {
  git(cwd, 'add', '-A', '--', '.', ':!AGENTS.override.md');
  git(cwd, 'commit', '-m', message);
};
const invoke = (cwd, args, expected = 0, match) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, npm_config_prefix: join(temp, 'global'), NPM_CONFIG_PREFIX: join(temp, 'global') },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (/Unknown command/.test(output)) {
    console.error('STORY_CARRY_FORWARD_RULE_MISSING');
  }
  assert.equal(result.status, expected, `${args.join(' ')}\n${output}`);
  if (match) assert.match(output, match);
  return result.stdout || '';
};

try {
  const repo = join(temp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Lab Carry Test');
  git(repo, 'config', 'user.email', 'lab-carry@example.invalid');
  write(repo, '.gitignore', '.worktrees/\n.proof-or-stop/locks/\n');
  write(repo, 'CHANGELOG.md', '# Changelog\n');
  for (const rel of ['package.json', 'packages/main/package.json']) {
    write(repo, rel, JSON.stringify({ name: 'proof-or-stop', version: '1.0.0' }, null, 2));
  }
  for (const rel of ['package-lock.json', 'packages/main/package-lock.json']) {
    write(repo, rel, JSON.stringify({ name: 'proof-or-stop', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'proof-or-stop', version: '1.0.0' } } }, null, 2));
  }
  write(repo, 'packages/main/src/core/proof-or-stop-brand.ts', "export const PROOF_OR_STOP_CLI_VERSION = '1.0.0';\n");
  for (const name of ['main-write-lock', 'mkdir-lock', 'brand-env', 'brand-paths', 'proof-or-stop-paths', 'runtime-artifact-registry', 'version-bump', 'runtime-version-policy']) {
    write(repo, `packages/main/src/core/${name}.ts`, readFileSync(join(root, `packages/main/src/core/${name}.ts`)));
  }
  write(repo, 'feature.txt', 'old\n');
  write(repo, 'target.cjs', "const fs=require('fs'); if(fs.readFileSync('feature.txt','utf8')!=='new\\n'){console.error('TARGET_STORY_CHANGE_MISSING');process.exit(1)} console.log('TARGET PASS');\n");
  write(repo, 'baseline.cjs', "console.error('BASELINE_STABLE'); process.exit(1);\n");
  commit(repo, 'fixture baseline');

  const story = join(repo, '.worktrees/B-test');
  git(repo, 'worktree', 'add', '-b', 'story/B-test', story, 'main');
  write(story, 'feature.txt', 'new\n');
  commit(story, 'fix: story-owned behavior');
  const evidenceHead = git(story, 'rev-parse', 'HEAD');
  const binding = 'a'.repeat(64);
  const intent = { desc: 'Exercise the story-owned behavior.', type: 'cli', priority: 'must', verification: { command: 'node target.cjs', selector: 'TARGET PASS' } };
  const evidence = {
    intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'node target.cjs', result: 'pass', mechanical: true,
    headHash: evidenceHead, materialHash: 'b'.repeat(64), storyFilesHash: binding,
    receipt: { exitCode: 0, selector: 'TARGET PASS', selectorMatched: true, outputDigest: 'c'.repeat(64), causalReceiptHash: 'd'.repeat(64) },
  };
  const storyDir = '.proof-or-stop/story/actives/B-test';
  write(story, `${storyDir}/index.json`, JSON.stringify({ storyId: 'B-test', phase: 'REVIEW' }, null, 2));
  write(story, `${storyDir}/checklist.json`, JSON.stringify({ items: [{ id: 'CHK-001', status: 'done', verificationIntent: { happy: [intent], edge: [], adversarial: [] }, verificationEvidence: [evidence] }] }, null, 2));
  write(story, `${storyDir}/findings.json`, '[]\n');
  write(story, `${storyDir}/test-evidence.json`, JSON.stringify({
    result: 'FAIL', headHash: evidenceHead, materialHash: 'b'.repeat(64), storyFilesHash: binding, disposition: 'executed',
    output: JSON.stringify({
      status: 'fail', allPass: false, commandExecutions: 2,
      verificationCoverage: { total: 1, required: 1, covered: 1, missingRequired: 0, entries: [{ intentRef: 'CHK-001:happy:0', status: 'covered', evidence }] },
      commands: [
        { label: 'target', command: 'node', args: ['target.cjs'], code: 0, output: 'TARGET PASS\n' },
        { label: 'baseline', command: 'node', args: ['baseline.cjs'], code: 1, output: 'BASELINE_STABLE\n' },
      ],
    }),
  }, null, 2));
  commit(story, 'proof-or-stop: record story evidence');

  invoke(repo, ['create', 'carry']);
  const lab = join(repo, '.worktrees/Lab-carry');
  invoke(repo, ['carry', 'carry', '--story', 'B-test', '--source', story], 1, /--confirm/);
  invoke(repo, ['carry', 'carry', '--story', 'B-test', '--source', story, '--confirm'], 0, /Story evidence captured and patch applied/);
  assert.equal(readFileSync(join(lab, 'feature.txt'), 'utf8'), 'new\n');
  assert.equal(git(lab, 'status', '--short'), 'M  feature.txt');
  assert.equal(git(lab, 'status', '--short').includes('.proof-or-stop/story'), false);
  commit(lab, 'fix: carry verified Story patch');
  assert.match(execFileSync(process.execPath, ['target.cjs'], { cwd: lab, encoding: 'utf8' }), /TARGET PASS/);
  const state = JSON.parse(invoke(repo, ['status', 'carry']));
  assert.equal(state.storyCarry.storyId, 'B-test');
  assert.equal(state.storyCarry.sourceHead, git(story, 'rev-parse', 'HEAD'));
  assert.equal(state.storyCarry.storyFilesHash, binding);
  assert.deepEqual(state.storyCarry.importedPaths, ['feature.txt']);
  assert.equal(state.storyCarry.baselineWitnesses.length, 1);
  assert.equal(state.storyCarry.baselineWitnesses[0].mainExitCode, 1);
  assert.equal(state.storyCarry.verificationIntentCount, 1);
  console.log('STORY_CARRY_FORWARD PASS');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
