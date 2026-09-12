import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { StoryStore } from '../packages/main/dist/core/store.js';
import { createChecklistHandlers } from '../packages/main/dist/handlers/checklist.js';
import { acquireOwnerLease } from '../packages/main/dist/core/story-owner-lease.js';
import { evaluateConvergenceProgress, recordConvergenceProgress, readConvergenceProgress } from '../packages/main/dist/core/convergence-progress-journal.js';
const root = mkdtempSync(join(tmpdir(), 'progress-evidence-')), originalCwd = process.cwd();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
try {
  process.chdir(root);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Progress fixture'); git('config', 'user.email', 'progress@example.invalid');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives' }));
  writeFileSync(join(root, '.gitignore'), '.proof-or-stop/keys/\n**/*.lock/\n**/owner-lease.json\n.lattice/\n');
  writeFileSync(join(root, 'subject.cjs'), 'module.exports=1;\n');
  writeFileSync(join(root, 'verify.cjs'), "require('node:assert/strict').equal(require('./subject.cjs'),1); console.log('subject exports one');\n");
  git('add', '.'); git('commit', '-qm', 'fixture');
  const storyId = 'B-progress-evidence'; git('switch', '-qc', `story/${storyId}`);
  const store = new StoryStore(root), now = new Date().toISOString();
  store.writeStory(storyId, { storyId, name: 'progress-evidence', title: 'Verify actual progress', phase: 'DEV', priority: 'medium', createdAt: now, events: [] });
  acquireOwnerLease(store.storyDirPath(storyId), { command: 'progress-fixture', cwd: root });
  const checklist = { items: [{ id: 'CHK-001', title: 'The subject exports one', status: 'in_progress', verificationIntent: { happy: [{ desc: 'The subject exports one', type: 'cli', priority: 'must' }], edge: [], adversarial: [] } }] };
  store.writeChecklist(storyId, checklist); git('add', '.'); git('commit', '-qm', 'acceptance');
  recordConvergenceProgress(store, storyId, root);
  const path = store.storyFilePath(storyId, 'convergence-progress.json'), before = readFileSync(path, 'utf8');
  store.writeChecklist(storyId, { items: [{ ...checklist.items[0], verificationEvidence: [{ intentRef: 'CHK-001:happy:0', result: 'pass', mechanical: true, receipt: { exitCode: 0, selectorMatched: true } }] }] });
  assert.throws(() => recordConvergenceProgress(store, storyId, root), /execution authority|receipt/i, 'U11 coverage progress requires actual execution authority');
  assert.equal(readFileSync(path, 'utf8'), before);
  store.writeChecklist(storyId, checklist);
  await createChecklistHandlers({ root, scanRoot: root, store, log() {} }).verification_evidence_add({ storyId, itemId: 'CHK-001', intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'node verify.cjs', selector: 'subject exports one', note: 'The real child asserts the exact exported value before emitting its contract selector.' });
  const progress = recordConvergenceProgress(store, storyId, root);
  assert.equal(progress.state.snapshot.missingRequired, 0);
  assert.ok(progress.progressReasons.includes('missing-required-decreased'));
  const evidence = store.readChecklist(storyId).items[0].verificationEvidence[0];
  const validChecklist = store.readChecklist(storyId);
  for (const mutate of [
    e => { e.receipt.publicationBinding.authenticity.signature = 'invalid'; },
    e => { e.receipt = { exitCode: 0, selectorMatched: true, selector: e.receipt.selector }; },
  ]) {
    const changed = structuredClone(validChecklist); mutate(changed.items[0].verificationEvidence[0]);
    store.writeChecklist(storyId, changed);
    assert.throws(() => recordConvergenceProgress(store, storyId, root), /execution authority|receipt/i);
  }
  store.writeChecklist(storyId, validChecklist);
  const receiptPath = join(root, '.proof-or-stop/evidence/objects/sha256', evidence.receipt.executionReceipt.outputArtifact.artifactDigest + '.json');
  const receiptBytes = readFileSync(receiptPath);
  rmSync(receiptPath);
  assert.throws(() => recordConvergenceProgress(store, storyId, root), /execution authority|receipt/i);
  assert.equal(existsSync(receiptPath), false, 'read-only progress never repairs missing evidence');
  writeFileSync(receiptPath, receiptBytes);
  assert.equal(evaluateConvergenceProgress(store, storyId, root).state.snapshot.missingRequired, 0);
  const complete = readFileSync(path, 'utf8');
  writeFileSync(join(root, 'subject.cjs'), 'module.exports=2;\n');
  assert.throws(() => recordConvergenceProgress(store, storyId, root), /dirty|source/i, 'dirty source cannot borrow a committed PASS');
  assert.equal(readFileSync(path, 'utf8'), complete);
  writeFileSync(join(root, 'subject.cjs'), 'module.exports=1;\n');
  assert.equal(readConvergenceProgress(store, storyId, root).state.snapshot.missingRequired, 0);
  console.log('PASS U11 coverage progress requires real current execution and clean source');
} finally { process.chdir(originalCwd); rmSync(root, { recursive: true, force: true }); }
