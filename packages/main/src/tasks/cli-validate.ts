#!/usr/bin/env node

import { join } from 'path';
import { validate } from './validate.js';
import { loadConfig } from '../core/config.js';

const rootDir = process.env.PROOF_OR_STOP_PROJECT_ROOT || process.cwd();
const scanRoot = join(rootDir, loadConfig(rootDir).scanRoot);

const result = validate(scanRoot);

// Output error
for (const e of result.errors) {
  console.error(`  ERROR  ${e.loc}  ${e.msg}`);
}
for (const w of result.warnings) {
  console.warn(`  WARN   ${w.loc}  ${w.msg}`);
}

// Summary
console.log('');
console.log('── Task Annotation Report ──');
console.log(`  Files scanned:    ${result.filesScanned}`);
console.log(`  Tasks found:      ${result.tasksFound}`);
console.log(`  Errors:           ${result.errors.length}`);
console.log(`  Warnings:         ${result.warnings.length}`);

if (result.filesWithoutTask.length > 0) {
  console.log(`  Files without @task (${result.filesWithoutTask.length}):`);
  for (const f of result.filesWithoutTask) {
    console.log(`    - ${f}`);
  }
}

console.log('');

if (!result.passed) {
  console.error(`FAILED: ${result.errors.length} error(s) found. Fix them before proceeding.`);
  process.exit(1);
} else {
  console.log('PASSED: All task annotations are valid.');
  process.exit(0);
}
