


import assert from 'node:assert/strict';

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';


import { join } from 'node:path';



import ts from 'typescript';


import { createFixtureImplementationCommit } from "../../dist/tasks/current-implementation-fixture.js";
import { cliPath, fixtureRoots } from "./data.mjs";

export function git(cwd, args) {
  const output = execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return args.includes('-z') ? output : output.trim();
}

export function runCli(root, command, payload, env = {}, options = {}) {
  return spawnSync(process.execPath, [options.entrypoint ?? cliPath, '--root', root, command, JSON.stringify(payload)], {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    // A real source-lineage audit can emit several thousand structured records;
    // bound capture explicitly instead of killing a valid CLI at Node's 1 MiB default.
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PROOF_OR_STOP_SESSION_ID: 'sess-b49df-fixture', PROOF_OR_STOP_ACTIVITY_SOURCE: 'test', ...(command === 'acceptance_amendment_propose' ? { PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex' } : {}), ...env },
  });
}

export function initRepo(root, selfProject = false) {
  mkdirSync(join(root, 'packages', 'main'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: selfProject ? 'proof-or-stop' : 'b49df-external-consumer', version: '1.0.0', type: 'module' }) + '\n');
  writeFileSync(join(root, 'packages', 'main', 'package.json'), JSON.stringify({ name: selfProject ? '@proof-or-stop/core' : '@fixture/core', version: '1.0.0', type: 'module' }) + '\n');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', outDir: 'packages/main/dist', testsDir: 'packages/main/tests',
    storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', storyPrefix: 'B',
  }) + '\n');
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.name', 'Harmonynet']);
  git(root, ['config', 'user.email', '26995688+Harmonynet@users.noreply.github.com']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture baseline']);
}

export function establishCurrentImplementationPrerequisite(root) {
  assert.ok(fixtureRoots.includes(root), 'implementation prerequisite is restricted to generated test repositories');
  createFixtureImplementationCommit(root);
}

export function validBackground() {
  return [
    '## Trigger Event', 'B-49df requires a fresh Story to expose canonical identity fields through the public CLI.',
    'The fixture captures the generated files rather than synthesizing expected output.', '',
    '## Key Insights', 'Identity fields are checked by an explicit bounded path inventory.',
    'Historical narrative is not treated as an active identity field.', '',
    '## Solution Tradeoffs', 'A temporary git repository gives realistic persistence without touching developer Story data.',
    'The focused fixture stays independent from the active checkout lifecycle.', '',
    '## Conversational Texture', 'Operators should see one current product name in every newly generated identity field.',
    'Failures name the exact artifact and JSON path that carried the retired value.',
  ].join('\n');
}
