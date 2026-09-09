import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
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
  const handlers = createVerifierHandlers({ store, root, scanRoot: root, log() {} });
  const result = await handlers.validate({ story: storyId, focus: 'fast', json: true });
  assert.match(typeof result === 'string' ? result : JSON.stringify(result), /FAST_CONTRACT_PASS/,
    'real configured fast command must run before checking the receipt');
  const receipts = store.readCertificationWindows(storyId).receipts;
  assert.ok(receipts.some(row => row.authority === 'pre-cert-cheap-check' && row.result === 'PASS'),
    'U01: successful fast preparation must publish a bound PRE_CERT cheap-check receipt');
  console.log('PASS U01 precert-fast-producer');
} finally { rmSync(root, { recursive: true, force: true }); }
