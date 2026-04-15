#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { dirname } from 'path';

function resolveMainRepoRoot() {
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  return commonDir.endsWith('/.git') ? dirname(commonDir) : commonDir;
}

const worktreeRoot = process.cwd();
const mainRepoRoot = resolveMainRepoRoot();
const cli = `${worktreeRoot}/packages/main/dist/cli.js`;

function run(command, payload) {
  const args = ['node', cli, '--root', mainRepoRoot, command];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  return execFileSync(args[0], args.slice(1), {
    cwd: mainRepoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`no JSON payload found in output: ${text}`);
  return JSON.parse(text.slice(start));
}

const targetStoryId = 'B-6246';
const bugData = extractJson(run('bug_list', { storyId: targetStoryId }));
const openBefore = bugData.bugs.filter((bug) => bug.status === 'open');

const attempted = [];
for (const bug of openBefore) {
  try {
    const result = run('bug_update', { storyId: targetStoryId, id: bug.id, status: 'fixed' }).trim();
    attempted.push({ id: bug.id, fixed: true, result });
  } catch (error) {
    attempted.push({
      id: bug.id,
      fixed: false,
      result: String(error.stderr || error.stdout || error),
    });
  }
}

const after = extractJson(run('bug_list', { storyId: targetStoryId }));
const remaining = after.bugs.filter((bug) => bug.status === 'open').map((bug) => bug.id);

if (remaining.length > 0) {
  throw new Error(`B-6246 still has open bugs after reconcile: ${remaining.join(', ')}\n${JSON.stringify(attempted, null, 2)}`);
}

console.log('B-6246 open bugs reconciled');
