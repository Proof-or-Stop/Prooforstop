#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();
const cli = join(root, 'packages/main/dist/cli.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, payload, projectRoot = root) {
  const args = [cli, '--root', projectRoot, command];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  return execFileSync('node', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`no JSON payload found in output: ${text}`);
  return JSON.parse(text.slice(start));
}

const temp = mkdtempSync(join(tmpdir(), 'koala-flow-tool-meta-'));

try {
  mkdirSync(join(temp, 'packages', 'main', 'src'), { recursive: true });
  mkdirSync(join(temp, 'docs', 'metadata'), { recursive: true });
  mkdirSync(join(temp, 'docs', 'requirements'), { recursive: true });

  writeFileSync(join(temp, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));

  writeFileSync(join(temp, 'packages', 'main', 'src', 'keep.ts'), [
    '/**',
    ' * @task B-keep',
    ' * @checklist CHK-001',
    ' * @title keep current flow extraction support',
    ' * @type feature',
    ' * @priority medium',
    ' * @description current live task that should remain after metadata cleanup',
    ' * @changes',
    ' *   - [CHK-001] keep live metadata entry',
    ' * @test keep-live-task',
    ' */',
    'export function keepFlowTask() {',
    '  return true;',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(temp, 'docs', 'metadata', 'task.json'), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    tasks: [
      {
        key: 'src/mcp/handlers/flow.ts:flow_trace',
        task: 'B-old',
        checklist: ['CHK-001'],
        title: 'flow_trace handler',
        type: 'feature',
        priority: 'high',
        description: 'stale deleted flow handler metadata',
        changes: ['- [CHK-001] stale flow trace entry'],
        sourceFile: 'src/mcp/handlers/flow.ts',
        sourceLine: 1,
        functionName: 'flow_trace',
        functionSignature: 'flow_trace(...)',
        test: 'tools-flow_trace',
      },
      {
        key: 'src/mcp/handlers/flow.ts:flow_list',
        task: 'B-old',
        checklist: ['CHK-002'],
        title: 'flow_list handler',
        type: 'feature',
        priority: 'high',
        description: 'stale deleted flow list metadata',
        changes: ['- [CHK-002] stale flow list entry'],
        sourceFile: 'src/mcp/handlers/flow.ts',
        sourceLine: 10,
        functionName: 'flow_list',
        functionSignature: 'flow_list(...)',
        test: 'tools-flow_list',
      },
      {
        key: 'keep.ts:keepFlowTask',
        task: 'B-keep',
        checklist: ['CHK-001'],
        title: 'keep current flow extraction support',
        type: 'feature',
        priority: 'medium',
        description: 'live metadata record should stay visible',
        changes: ['- [CHK-001] keep live metadata entry'],
        sourceFile: 'keep.ts',
        sourceLine: 1,
        functionName: 'keepFlowTask',
        functionSignature: 'export function keepFlowTask()',
        test: 'keep-live-task',
      },
    ],
  }, null, 2));

  const gap = extractJson(run('gap_analyze', undefined, temp));
  const noTestDescriptions = gap.gaps.filter((g) => g.type === 'no_test').map((g) => g.description);

  assert(!noTestDescriptions.some((d) => d.includes('tools-flow_trace')), 'stale tools-flow_trace no_test still reported');
  assert(!noTestDescriptions.some((d) => d.includes('tools-flow_list')), 'stale tools-flow_list no_test still reported');
  assert(noTestDescriptions.some((d) => d.includes('keep-live-task')), 'live metadata-backed task should still participate in no_test analysis');

  const help = execFileSync('node', [cli, 'help'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert(!help.includes('flow_trace') && !help.includes('flow_list'), 'cleanup-legacy decision regressed: flow CLI commands reappeared');

  console.log('flow tool metadata cleanup verified');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
