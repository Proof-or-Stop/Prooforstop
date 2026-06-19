#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_TOOLS } from '../cli-engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..');
const repoRoot = join(pkgRoot, '..', '..');

const toolNames = MAIN_TOOLS.map(tool => tool.name);
const toolByName = new Map(MAIN_TOOLS.map(tool => [tool.name, tool]));

function findTool(name: string) {
  const tool = toolByName.get(name);
  assert.ok(tool, `expected command in MAIN_TOOLS: ${name}`);
  return tool;
}

function schemaDescription(command: string, key: string): string {
  const schema = findTool(command).schema[key] as { description?: unknown } | undefined;
  return typeof schema?.description === 'string' ? schema.description : '';
}

function runCli(args: string[]): string {
  const binCli = join(repoRoot, 'bin', 'lattice.js');
  const distCli = join(pkgRoot, 'dist', 'cli.js');
  const cliPath = existsSync(binCli) ? binCli : distCli;
  return execFileSync('node', [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LATTICE_NO_HOOKS: '1',
    },
  });
}

const duplicateNames = toolNames.filter((name, index) => toolNames.indexOf(name) !== index);
assert.deepEqual([...new Set(duplicateNames)], [], 'MAIN_TOOLS must not contain duplicate commands');

assert.deepEqual(toolNames.slice(0, 8), [
  'story_create',
  'story_advance',
  'story_update',
  'story_get',
  'story_list',
  'story_resolve',
  'story_reconcile',
  'story_discard',
], 'MAIN_TOOLS leading command order changed');

assert.deepEqual(toolNames.slice(-6), [
  'dev_memory_capture',
  'dev_memory_list',
  'dev_memory_search',
  'dev_memory_preflight',
  'dev_memory_finish',
  'dev_memory_start',
], 'MAIN_TOOLS trailing command order changed');

for (const command of [
  'story_create',
  'story_advance',
  'validate',
  'authority_receipt_verify',
  'host_runtime_list',
  'host_runtime_probe',
  'dispatch_policy_create',
  'dispatch_auto',
]) {
  findTool(command);
}

const currentHostText = [
  findTool('host_runtime_list').description,
  findTool('host_runtime_probe').description,
  schemaDescription('host_runtime_probe', 'host'),
  schemaDescription('dispatch_policy_create', 'allowedHosts'),
  findTool('dispatch_auto').description,
].join('\n').toLowerCase();

assert.match(currentHostText, /antigravity/, 'current host text should include antigravity');
assert.match(currentHostText, /\bagy\b/, 'current host text should include agy alias');
assert.match(currentHostText, /gemini is legacy-only/, 'Gemini should be described only as legacy host text');
assert.doesNotMatch(
  currentHostText,
  /current[^\n.]*gemini|gemini[^\n.]*current/,
  'Gemini must not be advertised as a current host',
);

const commandHelpExpectations: Array<{ args: string[]; includes: string[] }> = [
  {
    args: ['story_create', '--help'],
    includes: ['Lattice CLI', 'lattice story_create', '--checklist', '--scopeBoundary'],
  },
  {
    args: ['story_advance', '--help'],
    includes: [
      'Lattice CLI',
      'lattice story_advance',
      '--phase',
      'INIT_CHECK',
      '--dryRun',
      'Dry-run: optional via --dryRun',
      'Owner lease meta options',
      '--takeover',
      '--forceTakeover',
    ],
  },
  {
    args: ['validate', '--help'],
    includes: ['Lattice CLI', 'lattice validate', '--story', '--json'],
  },
  {
    args: ['authority_receipt_verify', '--help'],
    includes: ['Lattice CLI', 'lattice authority_receipt_verify', '--storyId', '--proofFile'],
  },
];

for (const { args, includes } of commandHelpExpectations) {
  const output = runCli(args);
  for (const expected of includes) {
    assert.match(output, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${args.join(' ')} missing ${expected}`);
  }
}

const helpOutput = runCli(['help']);
assert.match(helpOutput, /Lattice CLI/, 'lattice help should retain Lattice branding');
assert.match(helpOutput, /host_runtime_probe/, 'lattice help should include host runtime commands');
assert.match(helpOutput, /antigravity/, 'lattice help should include antigravity host text');

process.stdout.write(`command catalog smoke passed: ${MAIN_TOOLS.length} commands\n`);
