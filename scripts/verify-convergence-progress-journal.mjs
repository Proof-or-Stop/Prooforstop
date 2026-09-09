import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { signFinding } from '../packages/main/dist/core/finding-verify.js';
import { StoryStore } from '../packages/main/dist/core/store.js';
const source = new URL('../packages/main/dist/core/convergence-progress-journal.js', import.meta.url);
assert.ok(existsSync(source), 'U11 requires authoritative signed progress collection');
const { readConvergenceProgress, recordConvergenceProgress, evaluateConvergenceProgress } = await import(source);
const root = mkdtempSync(join(tmpdir(), 'convergence-progress-'));
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
try {
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'progress@example.invalid'); git('config', 'user.name', 'Progress fixture');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives' }));
  writeFileSync(join(root, 'subject.cjs'), 'module.exports=1;\n');
  const store = new StoryStore(root), storyId = 'B-progress', now = new Date().toISOString();
  store.writeStory(storyId, { storyId, name: 'progress', title: 'Verified progress', phase: 'DEV', priority: 'medium', createdAt: now, events: [] });
  store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'The subject exports one', status: 'pending', verificationIntent: { happy: [{ desc: 'The subject exports one', type: 'cli', priority: 'must' }], edge: [], adversarial: [] } }] });
  git('add', '.'); git('commit', '-qm', 'fixture');
  const path = store.storyFilePath(storyId, 'convergence-progress.json');
  assert.equal(readConvergenceProgress(store, storyId, root), null);
  assert.equal(evaluateConvergenceProgress(store, storyId, root).decision, 'continue');
  assert.equal(existsSync(path), false, 'read-only evaluation never creates progress authority');
  recordConvergenceProgress(store, storyId, root);
  const recorded = readConvergenceProgress(store, storyId, root);
  assert.equal(recorded.state.snapshot.missingRequired, 1);
  assert.deepEqual(recorded.state.snapshot.completedEpochIds, []);
  const bytes = readFileSync(path, 'utf8');
  recordConvergenceProgress(store, storyId, root);
  evaluateConvergenceProgress(store, storyId, root);
  assert.equal(readFileSync(path, 'utf8'), bytes, 'repeated status or same facts do not create semantic generations');
  assert.throws(() => recordConvergenceProgress(store, storyId, root, { completedEpochId: 'invented' }), /epoch|receipt/i);
  assert.equal(readFileSync(path, 'utf8'), bytes);
  const tampered = JSON.parse(bytes); tampered.state.snapshot.missingRequired = 0;
  writeFileSync(path, JSON.stringify(tampered));
  assert.throws(() => readConvergenceProgress(store, storyId, root), /signature|invalid/i);
  assert.throws(() => recordConvergenceProgress(store, storyId, root), /signature|invalid/i, 'writer must not launder caller-authored progress');
  writeFileSync(path, bytes);
  writeFileSync(store.storyFilePath(storyId, 'findings.json'), '{invalid');
  assert.throws(() => recordConvergenceProgress(store, storyId, root), /finding|JSON|invalid/i, 'a corrupt mirror must not appear as a net repair');
  assert.equal(readFileSync(path, 'utf8'), bytes);
  const findingPath = store.storyFilePath(storyId, 'findings.json');
  const finding = { id: 'F-001', desc: 'Real open regression', severity: 'high', category: 'missing',
    status: 'open', evidenceState: 'verified', createdAt: now, reviewRound: '' };
  finding._hash = signFinding(storyId, finding.id, finding.desc, finding.severity, now, '');
  writeFileSync(findingPath, JSON.stringify({ findings: [finding] }));
  recordConvergenceProgress(store, storyId, root);
  const openBytes = readFileSync(path, 'utf8');
  writeFileSync(findingPath, JSON.stringify({ findings: [{ ...finding, category: 'happy' }] }));
  recordConvergenceProgress(store, storyId, root);
  assert.equal(readFileSync(path, 'utf8'), openBytes, 'U11 unsigned legacy category is not effective progress');
  for (const patch of [
    { evidenceState: 'suspected', _hash: 'broken' },
    { evidenceState: 'suspected' },
    { status: 'resolved' },
    { status: 'dismissed' },
    { _hash: 'broken', recordId: 'invented', ledgerCommitReceiptId: 'invented' },
  ]) {
    writeFileSync(findingPath, JSON.stringify({ findings: [{ ...finding, ...patch }] }));
    assert.throws(() => recordConvergenceProgress(store, storyId, root), /finding|authority/i,
      'U11 must not certify a mirror downgrade or forged ledger marker as repair');
    assert.equal(readFileSync(path, 'utf8'), openBytes);
  }
  console.log('PASS U11 signed progress collection is read-only on status and rejects fabricated facts');
} finally { rmSync(root, { recursive: true, force: true }); }
