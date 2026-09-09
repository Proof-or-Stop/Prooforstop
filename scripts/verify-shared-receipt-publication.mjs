import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StoryStore } from '../packages/main/dist/core/store.js';
import { runValidationCommand } from '../packages/main/dist/core/validation-executor.js';
const root = mkdtempSync(join(tmpdir(), 'shared-receipt-publication-'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
try {
  git('init', '-q'); git('config', 'user.name', 'Receipt witness'); git('config', 'user.email', 'receipt@example.invalid');
  writeFileSync(join(root, '.gitignore'), readFileSync(new URL('../.gitignore', import.meta.url)));
  writeFileSync(join(root, 'witness.mjs'), 'console.log(crypto.randomUUID());\n');
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
  const command = { label: 'receipt witness', command: process.execPath, args: ['witness.mjs'], executionReuse: 'exact-inputs', executionInputs: [] };
  const options = { sharedExecution: { storyId: 'B-receipt-witness', receiptStore: new StoryStore(root), probe } };
  let first;
  try { first = await runValidationCommand(command, root, 10000, options); }
  catch (error) {
    console.error({ outputs: options.sharedExecution.receiptStore.causalEvidenceOutputPaths?.('B-receipt-witness'), status: git('status', '--porcelain', '--untracked-files=all') });
    assert.fail(`U03: own receipt publication must not invalidate unchanged inputs: ${error.message}`);
  }
  assert.equal(first.code, 0);
  const second = await runValidationCommand(command, root, 10000, options);
  assert.equal(second.output, first.output, 'U03: durable receipt must avoid a second process execution');
  assert.equal(second.executionReceipt.executionKey, first.executionReceipt.executionKey);
  writeFileSync(join(root, 'witness.mjs'), 'console.log("changed material");\n');
  const changed = await runValidationCommand(command, root, 10000, options);
  assert.equal(changed.output.trim(), 'changed material');
  assert.equal(changed.executionReceipt, undefined, 'dirty material cannot consume a shared receipt');
  console.log('PASS U03 shared-receipt-publication');
} finally { rmSync(root, { recursive: true, force: true }); }
