#!/usr/bin/env node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import ts from '../packages/main/node_modules/typescript/lib/typescript.js';

const root = '/Users/jek/Documents/Work/Orchestrate/.worktrees/B-1860/packages/main';
const temp = mkdtempSync(join(tmpdir(), 'koala-flow-desc-'));

function emit(relPath) {
  const srcPath = join(root, 'src', relPath);
  const outPath = join(temp, relPath.replace(/\.ts$/, '.js'));
  mkdirSync(dirname(outPath), { recursive: true });
  const source = readFileSync(srcPath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Node16,
      moduleResolution: ts.ModuleResolutionKind.Node16,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
    fileName: srcPath,
  });
  writeFileSync(outPath, outputText);
}

for (const rel of [
  'tasks/types.ts',
  'tasks/metadata-store.ts',
  'core/config.ts',
  'tasks/extract.ts',
  'tasks/validate.ts',
]) {
  emit(rel);
}

try {
  const extract = await import('file://' + join(temp, 'tasks/extract.js'));
  const validate = await import('file://' + join(temp, 'tasks/validate.js'));

  const raw = [
    '/**',
    ' * @task B-1860',
    ' * @flow sample-flow',
    ' * @step 1',
    ' * @desc 读取输入并准备输出',
    ' * @input { value }',
    ' * @output { value }',
    ' */',
  ].join('\n');
  const parsed = extract.parseBlock(raw);
  if (parsed.desc !== '读取输入并准备输出') {
    throw new Error('parseBlock did not preserve @desc');
  }

  const tasks = [
    {
      task: 'B-1860',
      sourceFile: 'flow.ts',
      sourceLine: 1,
      functionName: 'firstStep',
      functionSignature: 'function firstStep()',
      flow: 'sample-flow',
      step: 1,
      desc: '第一步说明',
      input: '{ value }',
      output: '{ value }',
      next: 'secondStep',
      test: 'flow-step-desc',
    },
    {
      task: 'B-1860',
      sourceFile: 'flow.ts',
      sourceLine: 20,
      functionName: 'secondStep',
      functionSignature: 'function secondStep()',
      flow: 'sample-flow',
      step: 2,
      desc: '第二步说明',
      input: '{ value }',
      output: '{ done }',
      test: 'flow-step-desc',
    },
  ];

  const chains = extract.extractFlows(tasks);
  if (chains[0]?.steps[0]?.desc !== '第一步说明' || chains[0]?.steps[1]?.desc !== '第二步说明') {
    throw new Error('extractFlows did not carry step descriptions');
  }

  const missingDescTasks = [
    tasks[0],
    { ...tasks[1], desc: undefined },
  ];
  const missingDescIssues = validate.validateFlows(extract.extractFlows(missingDescTasks), missingDescTasks).issues;
  if (!missingDescIssues.some((issue) => issue.msg.includes('missing @desc annotation'))) {
    throw new Error('validateFlows did not reject missing @desc');
  }

  const lastStepNextTasks = [
    tasks[0],
    { ...tasks[1], next: 'ghostStep' },
  ];
  const nextIssues = validate.validateFlows(extract.extractFlows(lastStepNextTasks), lastStepNextTasks).issues;
  if (!nextIssues.some((issue) => issue.msg.includes('is the last step but has @next'))) {
    throw new Error('validateFlows no longer catches legacy @next rule');
  }

  console.log('flow step desc verified');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
