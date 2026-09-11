import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { currentPrecertFastIdentity } from '../packages/main/dist/handlers/validation-identity.js';
import { currentPrecertCheapCheckReceipt } from '../packages/main/dist/core/certification-window.js';
import { StoryStore } from '../packages/main/dist/core/store.js';
import { createVerifierHandlers } from '../packages/main/dist/handlers/verifier.js';
import { acquireOwnerLease } from '../packages/main/dist/core/story-owner-lease.js';
const root = mkdtempSync(join(tmpdir(), 'precert-fast-producer-'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
const storyId = 'B-cheap-witness';
try {
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Lab witness'); git('config', 'user.email', 'lab@example.invalid');
  writeFileSync(join(root, '.gitignore'), readFileSync(new URL('../.gitignore', import.meta.url)));
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    validate: { commands: [{ label: 'Fast contract', command: process.execPath, args: ['fast.mjs'], focus: ['fast'] }] },
  }));
  writeFileSync(join(root, 'fast.mjs'), "console.log('FAST_CONTRACT_PASS');\n");
  git('add', '.'); git('commit', '-qm', 'base'); git('checkout', '-qb', 'codex/fast-witness');
  writeFileSync(join(root, 'fast.mjs'), "// repaired source\nconsole.log('FAST_CONTRACT_PASS');\n");
  const store = new StoryStore(root);
  store.writeStory(storyId, { storyId, name: 'fast-witness', title: 'Fast producer', description: 'Fast producer',
    type: 'chore', priority: 'high', phase: 'DEV', createdAt: new Date().toISOString(), events: [],
    startedAt: null, endedAt: null, baseBranch: 'main' });
  store.writeChecklist(storyId, { items: [] });
  git('add', '.'); git('commit', '-qm', 'repair');
  acquireOwnerLease(store.storyDirPath(storyId), { command: 'fixture-owner', cwd: root });
  const ctx = { store, root, scanRoot: root, log() {} };
  const handlers = createVerifierHandlers(ctx);
  const result = await handlers.validate({ story: storyId, focus: 'fast', json: true });
  assert.match(typeof result === 'string' ? result : JSON.stringify(result), /FAST_CONTRACT_PASS/,
    'real configured fast command must run before checking the receipt');
  const first = store.readCertificationWindows(storyId).receipts.find(row => row.authority === 'pre-cert-cheap-check');
  assert.ok(first, 'real fast invocation must produce the original signed receipt');
  const repeat = JSON.parse(await handlers.validate({ story: storyId, focus: 'fast', json: true }));
  assert.equal(repeat.precertCheapCheckReceipt.receiptId, first.receiptId, 'same fast identity remains idempotent');
  assert.equal(store.readCertificationWindows(storyId).receipts.length, 1, 'same fast authority does not accumulate duplicate metadata');
  assert.equal(currentPrecertFastIdentity(ctx, storyId).digest, first.routineValidationIdentity.digest, 'admission and execution share exact identity construction');
  const matchArgs = {
    data: { ...store.readCertificationWindows(storyId), receipts: [first] }, storyId,
    headHash: first.headHash, materialHash: first.materialHash, storyFilesHash: first.storyFilesHash,
    currentIdentity: first.routineValidationIdentity,
  };
  assert.ok(currentPrecertCheapCheckReceipt(matchArgs), 'unchanged signed fast receipt remains usable');
  const originalEnvironment = process.env.PROOF_FAST_INPUT_REVISION;
  try {
    process.env.PROOF_FAST_INPUT_REVISION = 'changed-after-fast-pass';
    const changedResult = JSON.parse(await handlers.validate({ story: storyId, focus: 'fast', json: true }));
    assert.equal(changedResult.status, 'pass');
    const changed = store.readCertificationWindows(storyId).receipts.find(row => row.receiptId === changedResult.precertCheapCheckReceipt.receiptId);
    assert.equal(currentPrecertFastIdentity(ctx, storyId).digest, changed.routineValidationIdentity.digest, 'admission observes the same changed environment as the actual runner');
    assert.notEqual(changed.routineValidationIdentity.digest, first.routineValidationIdentity.digest,
      'real fast executions must distinguish changed semantic environment');
    assert.equal(currentPrecertCheapCheckReceipt({ ...matchArgs, currentIdentity: changed.routineValidationIdentity }), null,
      'U01 refuses old fast authority when the current execution environment changed');
  } finally {
    if (originalEnvironment === undefined) delete process.env.PROOF_FAST_INPUT_REVISION;
    else process.env.PROOF_FAST_INPUT_REVISION = originalEnvironment;
  }
  const configPath = join(root, 'proof-or-stop.config.json');
  const originalConfig = readFileSync(configPath, 'utf8');
  const config = JSON.parse(originalConfig);
  config.validate.commands[0].env = { FAST_EXPLICIT_INPUT: 'new-value' };
  writeFileSync(configPath, JSON.stringify(config));
  assert.notEqual(currentPrecertFastIdentity(ctx, storyId).digest, first.routineValidationIdentity.digest, 'raw config drift invalidates fast authority');
  writeFileSync(configPath, originalConfig);
  writeFileSync(join(root, 'validate.js'), 'console.log(JSON.stringify({status:"pass",allPass:true}));\n');
  const fileIdentity = currentPrecertFastIdentity(ctx, storyId);
  assert.equal(fileIdentity.source.kind, 'validate-file', 'new validate-file takes precedence over previously configured commands');
  assert.equal(currentPrecertCheapCheckReceipt({ ...matchArgs, currentIdentity: fileIdentity }), null, 'a newly authoritative entrypoint cannot reuse old configured fast authority');
  assert.equal(currentPrecertCheapCheckReceipt({ ...matchArgs, currentIdentity: undefined }), null, 'unavailable current identity fails closed');
  console.log('PASS U01 precert runtime freshness');
} finally { rmSync(root, { recursive: true, force: true }); }
