/** Actual same-command executions at two Git revisions, never an operational cohort. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import { createFindingLedgerHandlers, setRuntimeEvidenceKeyStatusForTest } from '../handlers/finding-ledger.js';
import { readFindingBaseHeadPair } from '../handlers/finding-runtime-pair.js';
import { RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY } from '../core/evidence/artifact-store.js';

const root = mkdtempSync(join(tmpdir(), 'finding-pair-'));
const cwd = process.cwd();
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
const write = (path: string, text: string) => writeFileSync(join(root, path), text);
const storyId = 'B-pair';
try {
  write('proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives' }));
  write('.gitignore', '.proof-or-stop/\nbuild/\n');
  write('defect.json', JSON.stringify({ failures: 1 }));
  write('build.mjs', "import{mkdirSync,copyFileSync}from'node:fs';mkdirSync('build',{recursive:true});copyFileSync('defect.json','build/defect.json');");
  write('witness.mjs', `import{readFileSync}from'node:fs';import{execFileSync}from'node:child_process';
const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();const{failures}=JSON.parse(readFileSync('build/defect.json','utf8'));
console.log('FINDING_WITNESS '+JSON.stringify({storyId:'B-pair',findingId:'F-pair',headHash:git('rev-parse','HEAD'),baseHash:git('merge-base','main','HEAD'),reproduced:failures>0,failureFingerprint:'controlled-defect',impactVector:{failures}}));process.exitCode=failures>0?1:0;`);
  git('init', '-b', 'main'); git('config', 'user.name', 'Runtime pair fixture'); git('config', 'user.email', 'pair@example.invalid');
  git('add', '.'); git('commit', '-m', 'baseline'); const baseHash = git('rev-parse', 'HEAD');
  git('checkout', '-b', `story/${storyId}`); process.chdir(root); resetConfigCache();
  const store = new StoryStore(root);
  store.writeStory(storyId, { storyId, name: 'pair', title: 'Runtime pair fixture', description: 'Isolated adapter execution.', phase: 'REVIEW', type: 'feature', priority: 'medium',
    createdAt: new Date().toISOString(), startedAt: null, endedAt: null, events: [] });
  const ctx = { root, store, scanRoot: root }; const handlers = createFindingLedgerHandlers(ctx);
  const args = { storyId, buildCommand: { executable: process.execPath, args: ['build.mjs'], cwd: '.' },
    executionCommand: { executable: process.execPath, args: ['witness.mjs'], cwd: '.' }, artifactPaths: ['build/defect.json'],
    compilerVersion: 'fixture-v1', environmentAllowlist: ['PATH'], storageCapability: RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY };
  write('unrelated.txt', 'Unrelated content\n'); git('add', 'unrelated.txt'); git('commit', '-m', 'unrelated change');
  const ownerHead = git('rev-parse', 'HEAD');
  const base = handlers.finding_runtime_evidence_run({ ...args, idempotencyKey: 'base', sourceRef: baseHash });
  assert.equal(git('rev-parse', 'HEAD'), ownerHead);
  assert.equal(base.receipt.headHash, baseHash);
  const headHash = git('rev-parse', 'HEAD'); const head = handlers.finding_runtime_evidence_run({ ...args, idempotencyKey: 'head' });
  const pair = [base.runtimeReceiptId, head.runtimeReceiptId];
  assert.ok(readFindingBaseHeadPair(ctx, storyId, pair, baseHash, headHash).digest);
  assert.throws(() => readFindingBaseHeadPair(ctx, storyId, [head.runtimeReceiptId], baseHash, headHash), /ordered/);
  assert.throws(() => readFindingBaseHeadPair(ctx, storyId, [head.runtimeReceiptId, head.runtimeReceiptId], baseHash, headHash), /ordered/);
  assert.throws(() => readFindingBaseHeadPair(ctx, storyId, [...pair].reverse(), baseHash, headHash));
  assert.throws(() => readFindingBaseHeadPair(ctx, storyId, pair, headHash, headHash), /mismatch/);
  write('defect.json', JSON.stringify({ failures: 2 })); git('add', 'defect.json'); git('commit', '-m', 'worsen controlled defect');
  const worse = handlers.finding_runtime_evidence_run({ ...args, idempotencyKey: 'worse' });
  assert.throws(() => readFindingBaseHeadPair(ctx, storyId, [base.runtimeReceiptId, worse.runtimeReceiptId], baseHash, git('rev-parse', 'HEAD')), /worsened/);
  write('defect.json', JSON.stringify({ failures: 0 })); git('add', 'defect.json'); git('commit', '-m', 'fix controlled defect');
  const green = handlers.finding_runtime_evidence_run({ ...args, idempotencyKey: 'fixed' });
  assert.throws(() => readFindingBaseHeadPair(ctx, storyId, [base.runtimeReceiptId, green.runtimeReceiptId], baseHash, git('rev-parse', 'HEAD')), /same defect/);
  setRuntimeEvidenceKeyStatusForTest(root, 'revoked');
  assert.throws(() => readFindingBaseHeadPair(ctx, storyId, pair, baseHash, headHash), /signature|revoked/);
  console.log('FINDING_RUNTIME_PAIR PASS 10');
} finally { process.chdir(cwd); resetConfigCache(); rmSync(root, { recursive: true, force: true }); }
