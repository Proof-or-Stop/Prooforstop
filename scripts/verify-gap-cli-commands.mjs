#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { join } from 'path';

const root = process.cwd();
const cli = join(root, 'packages/main/dist/cli.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, payload) {
  const args = [cli, command];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  return execFileSync('node', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`no JSON payload found in output: ${text}`);
  return JSON.parse(text.slice(start));
}

const help = run('help');
assert(help.includes('gap_analyze'), 'proof-or-stop help missing gap_analyze');
assert(help.includes('convergence_check'), 'proof-or-stop help missing convergence_check');
assert(help.includes('Gap:'), 'proof-or-stop help missing Gap group');

const gap = extractJsonObject(run('gap_analyze'));
assert(typeof gap.coveragePercent === 'number', 'gap_analyze missing coveragePercent');
assert(Array.isArray(gap.gaps), 'gap_analyze missing gaps array');

const convergence = extractJsonObject(run('convergence_check'));
assert(typeof convergence.converged === 'boolean', 'convergence_check missing converged boolean');
assert(Array.isArray(convergence.checks), 'convergence_check missing checks array');
assert(convergence.checks.some((check) => check.name === 'Flow 链路完整'), 'convergence_check missing Flow 链路完整 check');

console.log('gap CLI commands verified');
