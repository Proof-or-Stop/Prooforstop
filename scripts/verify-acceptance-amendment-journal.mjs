import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { StoryStore } from '../packages/main/dist/core/store.js';
import { runManagedHostRunWorker } from '../packages/main/dist/core/managed-host-run.js';
import { defaultHostRunRunner } from '../packages/main/dist/core/host-run.js';
import { base, delta } from './verify-acceptance-amendment-delta.mjs';
const moduleUrl = new URL('../packages/main/dist/core/acceptance-amendment-journal.js', import.meta.url);
assert.ok(existsSync(moduleUrl), 'U05 requires signed amendment application journal');
const { createAcceptanceAmendmentController, acceptanceAmendmentBlocker } = await import(moduleUrl);
const root = mkdtempSync(join(tmpdir(), 'amendment-journal-'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
const workers = [];
const scopeBudgetCase = process.argv.includes('--scope-budget');
try {
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Lab witness'); git('config', 'user.email', 'lab@example.invalid');
  writeFileSync(join(root, '.gitignore'), '.proof-or-stop/runtime/\n.proof-or-stop/locks/\n');
  writeFileSync(join(root, 'sum.cjs'), 'module.exports=(a,b)=>a+b;\n');
  if (scopeBudgetCase) writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives',
    storyScopeBudget: {schemaVersion:'story-scope-budget.v1',mode:'enforce',
      limits:{responsibilityDomains:10,hostAdapters:10,processFacts:100,publicCommands:100,acceptanceTopology:100,devScopeDelta:0,validationGroups:100},
      responsibilities:[{id:'addition',paths:['src/**','tests/**'],hostAdapters:[],validationGroups:[]}]},
  }));
  const store = new StoryStore(root), storyId = base.storyId;
  store.writeStory(storyId, { storyId, name: 'amendment', title: 'Acceptance addition', phase: 'DEV', priority: 'medium', createdAt: new Date().toISOString(), events: [] });
  store.writeChecklist(storyId, base.checklist); store.writeScopeContract(storyId, base.scope); store.writeProofStoryContract(storyId, base.proofStory);
  git('add', '.'); git('commit', '-qm', 'baseline acceptance');
  const controller = createAcceptanceAmendmentController(store, root);
  const request = { storyId, amendmentId: 'AM-1', delta, submitterSessionId: 'owner-1' };
  controller.propose({ ...request, amendmentId: 'AM-failed' });
  let failedLaunches = 0;
  const failedRun = await controller.startReview({ storyId, amendmentId: 'AM-failed', host: 'codex' }, {
    beforeOneShotInputWrite: () => { throw new Error('injected input write failure after pin'); },
    launchWorker: () => { failedLaunches++; throw new Error('must not launch'); },
  });
  assert.equal(failedLaunches, 0);
  const pinnedFailure = store.readAcceptanceAmendments(storyId).entries[0].review.publicKey;
  const failedRetry = await controller.startReview({ storyId, amendmentId: 'AM-failed', host: 'codex' });
  assert.equal(failedRetry.runId, failedRun.runId);
  assert.match(failedRetry.recoveryHint, /cancel.*new amendment ID/);
  assert.equal(store.readAcceptanceAmendments(storyId).entries[0].review.publicKey, pinnedFailure);
  controller.cancel({ storyId, amendmentId: 'AM-failed', reason: 'The private input write failed before worker launch; retain attempt and start a new amendment.' });
  const before = readFileSync(store.storyFilePath(storyId, 'checklist.json'));
  const proposal = controller.propose(request);
  assert.equal(proposal.state, 'PROPOSED');
  assert.deepEqual(readFileSync(store.storyFilePath(storyId, 'checklist.json')), before, 'proposal cannot mutate acceptance');
  assert.match(acceptanceAmendmentBlocker(store, storyId, root), /pending|PROPOSED/);
  const originalJournal = store.readAcceptanceAmendments(storyId);
  store.writeAcceptanceAmendments(storyId, { ...originalJournal, entries: [] });
  assert.match(acceptanceAmendmentBlocker(store, storyId, root), /signature|invalid/, 'deleting pending entries cannot erase the gate');
  store.writeAcceptanceAmendments(storyId, originalJournal);
  assert.throws(() => controller.approve({ storyId, amendmentId: 'AM-1' }), /review|receipt/);
  assert.deepEqual(controller.propose(request), proposal, 'exact proposal retry is stable');
  assert.throws(() => controller.propose({ ...request, delta: { ...delta, scopeDelta: { ...delta.scopeDelta, modify: ['different.ts'] } } }), /conflict|IDEMPOTENCY/);
  const launch = { launchWorker: worker => {
    const journal = store.readAcceptanceAmendments(storyId);
    const entry = journal.entries.find(e => e.amendmentId === 'AM-1');
    assert.ok(entry.review.publicKey, 'journal pins key before worker launch');
    const body = { schemaVersion: 'proofbound.acceptance_amendment_review_final.v1', runId: worker.runId, storyId,
      amendmentId: 'AM-1', amendmentDigest: entry.amendmentDigest, baseDigest: entry.baseDigest, submitterSessionId: 'owner-1', decision: 'approve',
      rationale: 'The new required intent completes missing acceptance without weakening any original requirement.', readRefs: ['sum.cjs'] };
    const event = { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(body) } };
    workers.push(runManagedHostRunWorker(worker, { env: { PROOF_OR_STOP_USAGE_LEDGER: '0' }, runner: plan => defaultHostRunRunner({ ...plan, command: process.execPath, argv: ['-e', `console.log(${JSON.stringify(JSON.stringify(event))})`], stdinText: '' }) }));
    return { pid: process.pid };
  }, claimPollMs: 5, claimTimeoutMs: 2000 };
  await controller.startReview({ storyId, amendmentId: 'AM-1', host: 'codex' }, launch);
  await Promise.all(workers);
  if (scopeBudgetCase) {
    const beforeBudget = [store.readChecklist(storyId), store.readScopeContract(storyId), store.readProofStoryContract(storyId), store.readAcceptanceAmendments(storyId)];
    assert.throws(() => controller.approve({storyId,amendmentId:'AM-1'}), /Scope budget.*devScopeDelta/,
      'independent approval cannot bypass the configured semantic delta budget');
    assert.deepEqual([store.readChecklist(storyId), store.readScopeContract(storyId), store.readProofStoryContract(storyId), store.readAcceptanceAmendments(storyId)], beforeBudget,
      'over-budget approval changes neither acceptance nor the signed application journal');
    assert.equal(store.readAcceptanceAmendments(storyId).entries.find(entry=>entry.amendmentId==='AM-1').state,'REVIEWING',
      'budget rejection precedes the APPLYING marker');
    console.log('PASS U06 reviewed amendment cannot apply over semantic budget');
  } else {
  const changed = store.readChecklist(storyId); changed.items[0].title += ' changed'; store.writeChecklist(storyId, changed);
  assert.throws(() => controller.approve({ storyId, amendmentId: 'AM-1' }), /base|drift/);
  store.writeChecklist(storyId, base.checklist);
  const originalWriter = store.writeScopeContract.bind(store);
  store.writeScopeContract = () => { throw new Error('injected second artifact write failure'); };
  assert.throws(() => controller.approve({ storyId, amendmentId: 'AM-1' }), /injected/);
  assert.match(acceptanceAmendmentBlocker(store, storyId, root), /APPLYING|pending/);
  store.writeScopeContract = originalWriter;
  writeFileSync(join(root, 'sum.cjs'), 'module.exports=(a,b)=>a-b;\n');
  assert.throws(() => controller.approve({ storyId, amendmentId: 'AM-1' }), /source drift/, 'interrupted application never approves changed source');
  assert.match(acceptanceAmendmentBlocker(store, storyId, root), /APPLYING/);
  writeFileSync(join(root, 'sum.cjs'), 'module.exports=(a,b)=>a+b;\n');
  const approved = controller.approve({ storyId, amendmentId: 'AM-1' });
  assert.equal(approved.state, 'APPROVED');
  assert.equal(acceptanceAmendmentBlocker(store, storyId, root), null);
  assert.deepEqual(store.readChecklist(storyId).items.slice(0, 5), base.checklist.items.slice(0, 5), 'original history remains unchanged after repair');
  assert.equal(store.readChecklist(storyId).items.flatMap(i => Object.values(i.verificationIntent).flat()).length, 36);
  const journalBytes = readFileSync(store.storyFilePath(storyId, 'acceptance-amendments.json'));
  assert.deepEqual(controller.approve({ storyId, amendmentId: 'AM-1' }), approved);
  assert.deepEqual(readFileSync(store.storyFilePath(storyId, 'acceptance-amendments.json')), journalBytes, 'applied retry writes no new authority');
  const forged = store.readAcceptanceAmendments(storyId); forged.entries[0].delta.appendIntents[0].verificationIntent.happy[0].desc = 'weakened'; store.writeAcceptanceAmendments(storyId, forged);
  assert.match(acceptanceAmendmentBlocker(store, storyId, root), /signature|invalid/);
  assert.throws(() => controller.approve({ storyId, amendmentId: 'AM-1' }), /signature|invalid/);
  console.log('PASS U05 signed amendment application and interrupted recovery');
  }
} finally { await Promise.allSettled(workers); rmSync(root, { recursive: true, force: true }); }
