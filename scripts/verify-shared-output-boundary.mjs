import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runValidationCommand } from '../packages/main/dist/core/validation-executor.js';
const root = mkdtempSync(join(tmpdir(), 'shared-output-boundary-'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
try {
  git('init', '-q'); git('config', 'user.name', 'Receipt witness'); git('config', 'user.email', 'receipt@example.invalid');
  writeFileSync(join(root, '.gitignore'), readFileSync(new URL('../.gitignore', import.meta.url)));
  writeFileSync(join(root, 'witness.mjs'), "process.stdout.write('A'.repeat(Number(process.argv[2]))+'MIDDLE_SELECTOR'+'B'.repeat(Number(process.argv[2])));\n");
  git('add', '.'); git('commit', '-qm', 'witness');
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const probe = () => ({
    cli: { available: true, path: process.execPath }, worktree: { expected: root, actual: root },
    gitIndex: { readable: true, path: join(root, '.git/index'), contentDigest: digest(readFileSync(join(root, '.git/index'))) },
    gitMaterial: { available: true, headHash: git('rev-parse', 'HEAD'), materialHash: git('rev-parse', 'HEAD^{tree}'), storyFilesHash: git('rev-parse', 'HEAD^{tree}') },
    writerLease: { available: true, valid: true }, providerCapability: { required: ['validation-plan'], available: ['validation-plan'] },
    resources: { required: { slots: 1 }, available: { slots: 1 } }, evidenceTarget: { writable: true, path: root },
    sideChannel: { available: true, maxOutputChars: 12000, maxProgressEvents: 1 },
  });
  const receipts = new Map();
  const receiptStore = {
    readCausalEvidenceReceipt: (_story, key) => receipts.get(key) ?? null,
    writeCausalEvidenceReceipt: (_story, receipt) => receipts.set(receipt.executionKey, receipt),
  };
  for (const size of [8000, 5992]) {
    // Cover both a truncated output and a complete output just below the limit.
    const command = { label: 'output boundary', command: process.execPath,
      args: ['witness.mjs', String(size)], executionReuse: 'exact-inputs', executionInputs: [] };
    const options = { sharedExecution: { storyId: 'B-output-boundary', receiptStore, probe } };
    const first = await runValidationCommand(command, root, 10000, options);
    const receipt = receipts.get(first.executionReceipt.executionKey);
    const complete = 'A'.repeat(size) + 'MIDDLE_SELECTOR' + 'B'.repeat(size);
    assert.equal(receipt.reusable, complete.length <= 12000,
      'U03: truncated capture must never become reusable evidence');
    assert.equal(receipt.outputDigest, digest(complete), 'receipt digest binds complete captured output');
    const second = await runValidationCommand(command, root, 10000, options);
    assert.equal(second.executionReceipt.disposition, complete.length <= 12000 ? 'reused' : 'executed');
    assert.ok(first.output.length <= 12000, 'public display remains bounded');
  }
  const exact = { label: 'exact limit', command: process.execPath,
    args: ['-e', "process.stdout.write('X'.repeat(12000))"], executionReuse: 'exact-inputs', executionInputs: [] };
  const options = { sharedExecution: { storyId: 'B-output-boundary', receiptStore, probe } };
  const first = await runValidationCommand(exact, root, 10000, options);
  assert.equal(receipts.get(first.executionReceipt.executionKey).reusable, true, 'exactly 12000 complete characters remain reusable');
  assert.equal((await runValidationCommand(exact, root, 10000, options)).executionReceipt.disposition, 'reused');
  console.log('PASS U03 shared-output-boundary');
} finally { rmSync(root, { recursive: true, force: true }); }
