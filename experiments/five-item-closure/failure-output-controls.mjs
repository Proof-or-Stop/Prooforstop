import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runValidationCommand } from '../../packages/main/dist/core/validation-executor.js';
const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-failure-output-'));
try {
  const result = await runValidationCommand({ label: 'failure diagnostics after verbose output', command: process.execPath,
    args: ['-e', "process.stdout.write('BEGIN_REAL_COMMAND\\n'+'progress\\n'.repeat(6000),()=>{process.stderr.write('FINAL_ASSERTION_CAUSE\\n',()=>{process.exitCode=7;});});"], timeoutMs: 10000 }, root);
  assert.equal(result.code, 7);
  assert.equal(result.failureKind, 'validation_failure');
  assert.match(result.output, /BEGIN_REAL_COMMAND/);
  assert.match(result.output, /FINAL_ASSERTION_CAUSE/, 'LATE_FAILURE_DIAGNOSTIC_LOST: long validation hides its actual failure');
  assert.match(result.output, /truncated/);
  assert.ok(result.output.length < 12500, 'diagnostic retention must remain bounded');
  const success = await runValidationCommand({ label: 'successful output compatibility', command: process.execPath,
    args: ['-e', "process.stdout.write('X'.repeat(13000)+'SUCCESS_TAIL');"], timeoutMs: 10000 }, root);
  assert.equal(success.code, 0);
  assert.equal(success.output, 'X'.repeat(12000) + '\n...[truncated 1012 chars]', 'SUCCESS_OUTPUT_COMPATIBILITY: success keeps the existing exact bounded prefix format');
  console.log('FAILURE_OUTPUT_CONTROLS_GREEN ' + JSON.stringify({code: result.code, capturedLength: result.output.length, finalCauseRetained: true}));
} finally { rmSync(root, { recursive: true, force: true }); }
