#!/usr/bin/env node

import { scan, extractFlows } from './extract.js';
import { runFlowE2E } from './test-flow-e2e.js';
import { loadConfig } from '../core/config.js';

// scanRoot 从环境变量或 config 取，CLI 参数只接 flow 名称
const config = loadConfig();
const scanRoot = process.env.KOALA_SCAN_ROOT || config.scanRoot;
const targetFlow = process.argv[2];

const tasks = scan(scanRoot);
const flows = extractFlows(tasks);

if (flows.length === 0) {
  console.log('No @flow annotations found.');
  process.exit(0);
}

const toRun = targetFlow
  ? flows.filter(f => f.name === targetFlow)
  : flows;

if (toRun.length === 0) {
  console.error(`Flow "${targetFlow}" not found. Available: ${flows.map(f => f.name).join(', ')}`);
  process.exit(1);
}

let allPassed = true;

for (const flow of toRun) {
  const result = await runFlowE2E(flow.name, scanRoot);
  const icon = result.allPassed ? '✓' : '✗';
  console.log(`\n${icon} ${result.flow} (${result.steps.length} steps)`);
  for (const step of result.steps) {
    console.log(`  ${step.passed ? '✓' : '✗'} ${step.step}`);
    if (!step.passed) {
      console.log(`    error: ${step.error}`);
      if (step.input) console.log(`    input: ${JSON.stringify(step.input)}`);
      if (step.hint) console.log(`    hint: ${step.hint}`);
    }
  }
  if (!result.allPassed) allPassed = false;
}

console.log(`\n${allPassed ? '✓ ALL PASS' : '✗ SOME FAILED'}`);
process.exit(allPassed ? 0 : 1);
