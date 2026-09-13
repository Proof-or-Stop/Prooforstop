import { createCertificationWindowHandlers } from '../packages/main/dist/handlers/certification-window.js';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildVerificationCoverage } from '../packages/main/dist/core/verification.js';
import { checkEvidenceFreshnessForGit } from '../packages/main/dist/core/evidence-freshness.js';
import { runManagedHostRunWorker } from '../packages/main/dist/core/managed-host-run.js';
import { defaultHostRunRunner } from '../packages/main/dist/core/host-run.js';
import { createVerifierHandlers } from '../packages/main/dist/handlers/verifier.js';
import { createDoneRequiredValidationHandlers } from '../packages/main/dist/handlers/done-required-validation.js';
import { StoryStore } from '../packages/main/dist/core/store.js';
import { createChecklistHandlers } from '../packages/main/dist/handlers/checklist.js';
import { createScopeContractHandlers } from '../packages/main/dist/handlers/scope-contract.js';
import { getGuardFailureReason, checklistAllDoneGuard, evaluateReviewVerdict, firstDonePredicateFailure } from '../packages/main/dist/core/machine.js';
import { acquireOwnerLease } from '../packages/main/dist/core/story-owner-lease.js';
import { base, delta } from './verify-acceptance-amendment-delta.mjs';
const moduleUrl = new URL('../packages/main/dist/handlers/acceptance-amendment.js', import.meta.url);
assert.ok(existsSync(moduleUrl), 'U05 requires public amendment commands and completion gates');
const { createAcceptanceAmendmentHandlers } = await import(moduleUrl);
const workers = [];
const root = mkdtempSync(join(tmpdir(), 'amendment-gates-')), previousCwd = process.cwd();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
try {
  process.chdir(root);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Lab witness'); git('config', 'user.email', 'lab@example.invalid');
  writeFileSync(join(root, '.gitignore'), '.proof-or-stop/runtime/\n.proof-or-stop/locks/\n**/owner-lease.json\n');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives' }));
  writeFileSync(join(root, 'sum.cjs'), 'module.exports=(a,b)=>a+b;\n');
  writeFileSync(join(root, 'verify.cjs'), `const assert=require('node:assert/strict'); const sum=require('./sum.cjs'); for(let i=1;i<=35;i++){assert.equal(sum(i,i+1),2*i+1); console.log('case-'+i+'-PASS')} assert.equal(sum(-3,3),0); console.log('case-36-PASS');\n`);
  git('add', '.'); git('commit', '-qm', 'baseline'); git('switch', '-qc', `story/${base.storyId}`);
  const store = new StoryStore(root), storyId = base.storyId;
  store.writeStory(storyId, { storyId, name: 'amendment', title: 'Acceptance addition', phase: 'DEV', priority: 'medium', createdAt: new Date().toISOString(), events: [] });
  acquireOwnerLease(store.storyDirPath(storyId), { command: 'amendment-fixture', cwd: root });
  const originalChecklist = structuredClone(base.checklist);
  originalChecklist.items.slice(0, 5).forEach((item, index) => {
    item.verificationEvidence = [];
    item.verificationIntent.happy.forEach((intent, j) => { const input = index * 7 + j + 1; intent.desc = `Adding ${input} and ${input + 1} returns ${2 * input + 1}`; });
  });
  store.writeChecklist(storyId, originalChecklist); store.writeScopeContract(storyId, base.scope); store.writeProofStoryContract(storyId, base.proofStory);
  git('add', '.'); git('commit', '-qm', 'original acceptance');
  const ctx = { root, scanRoot: root, store, log() {} };
  const amendments = createAcceptanceAmendmentHandlers(ctx), checklist = createChecklistHandlers(ctx);
  const proposed = JSON.parse(amendments.acceptance_amendment_propose({ storyId, amendmentId: 'AM-1', delta }));
  assert.equal(proposed.state, 'PROPOSED');
  assert.throws(() => checklist.checklist_update({ storyId, itemId: 'CHK-006', status: 'done' }), /amendment.*pending|Acceptance amendment/i);
  for (const phase of ['REVIEW', 'TEST', 'DONE']) assert.match(getGuardFailureReason(storyId, store, phase, root), /Acceptance amendment pending/, `${phase} diagnostic must consume the same pending fact`);
  const context = { storyId, store, projectRoot: root };
  assert.equal(checklistAllDoneGuard(context), false);
  assert.match(evaluateReviewVerdict(context).message, /Acceptance amendment pending/);
  assert.match(firstDonePredicateFailure(context).failureReason, /Acceptance amendment pending/);
  assert.throws(() => createCertificationWindowHandlers(ctx).certification_window_begin({ storyId }), /Acceptance amendment pending/);
  await assert.rejects(createVerifierHandlers(ctx).validate({ storyId }), /Acceptance amendment pending/);
  await assert.rejects(createDoneRequiredValidationHandlers(ctx).done_required_validate({ storyId }), /Acceptance amendment pending/);
  assert.throws(() => checklist.checklist_add({ storyId, title: 'Unreviewed DEV scope', reason: 'Attempt to bypass the signed amendment requirement' }), /amendment/i);
  assert.throws(() => createScopeContractHandlers(ctx).scope_contract_set({ storyId, mode: 'enforce', allowedModify: [...base.scope.allowedModify, 'src/unreviewed.ts'] }), /amendment/i);
  assert.throws(() => amendments.acceptance_amendment_approve({ storyId, amendmentId: 'AM-1', decision: 'approve', publicKey: 'caller-key' }), /unknown|caller|field/i);
  amendments.acceptance_amendment_cancel({ storyId, amendmentId: 'AM-1', reason: 'The test cancels the unapplied proposal while retaining its signed audit history.' });
  assert.throws(() => checklist.checklist_update({ storyId, itemId: 'CHK-006', status: 'done' }), /intent.*evidence|verification/i, 'zero intent and zero evidence cannot be marked done');
  store.writeScopeContract(storyId, { ...base.scope, allowedModify: ['src/?.ts'] });
  assert.throws(() => createScopeContractHandlers(ctx).scope_contract_set({ storyId, mode: 'enforce', allowedModify: ['src/*.ts'] }), /amendment|scope/i, 'a new glob must not broaden an existing glob without approval');
  store.writeScopeContract(storyId, { ...base.scope, allowedCreate: ['src/*.ts'] });
  assert.throws(() => createScopeContractHandlers(ctx).scope_contract_set({ storyId, mode: 'enforce', allowedCreate: ['src/a.ts'] }), /amendment|scope/i, 'literal directory prefixes must not widen a glob into descendant paths');
  store.writeScopeContract(storyId, base.scope);
  assert.throws(() => createScopeContractHandlers(ctx).scope_contract_acknowledge({ storyId, paths: ['src/outside.ts'], reason: 'Attempt to acknowledge unreviewed DEV scope instead of obtaining independent acceptance approval.' }), /amendment/i, 'scope acknowledgement cannot substitute for additive approval');
  const evidences = originalChecklist.items.slice(0, 5).flatMap((item, i) => item.verificationIntent.happy.map((intent, j) => ({
    itemId: item.id, intentRef: `${item.id}:happy:${j}`, kind: 'integration_test', command: 'node verify.cjs', selector: `case-${i * 7 + j + 1}-PASS`,
    note: `Executed actual sum assertions for original input ${i * 7 + j + 1}; preserve this receipt through the amendment.`,
  })));
  await checklist.verification_evidence_batch_add({ storyId, evidences });
  const coverage = () => buildVerificationCoverage(store.readChecklist(storyId), git('rev-parse', 'HEAD'),
    (head, evidence) => checkEvidenceFreshnessForGit(root, head, evidence?.materialHash, root, evidence?.storyFilesHash).fresh);
  assert.equal(coverage().covered, 35, JSON.stringify(coverage()));
  assert.equal(coverage().total, 36, 'bare CHK-006 remains visible before amendment');
  assert.equal(coverage().missingRequired, 1, '35 executed receipts do not cover the omitted item');
  assert.match(coverage().entries.find(e => e.itemId === 'CHK-006').desc, /acceptance_amendment_propose/);
  const preservedHistory = store.readChecklist(storyId).items.slice(0, 5);
  const verifiedHandlers = createAcceptanceAmendmentHandlers(ctx, { launchWorker: request => {
    const entry = store.readAcceptanceAmendments(storyId).entries.find(e => e.review?.runId === request.runId);
    const body = { schemaVersion: 'proof-or-stop.acceptance_amendment_review_final.v1', runId: request.runId, storyId,
      amendmentId: entry.amendmentId, amendmentDigest: entry.amendmentDigest, baseDigest: entry.baseDigest, submitterSessionId: entry.submitterSessionId,
      decision: 'approve', rationale: 'The new zero-sum boundary has mandatory verification and topology, preserving all thirty-five original requirements.', readRefs: ['sum.cjs', 'verify.cjs'] };
    const event = { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(body) } };
    workers.push(runManagedHostRunWorker(request, { env: { PROOF_OR_STOP_USAGE_LEDGER: '0' }, runner: plan => defaultHostRunRunner({ ...plan, command: process.execPath, argv: ['-e', `console.log(${JSON.stringify(JSON.stringify(event))})`], stdinText: '' }) }));
    return { pid: process.pid };
  }, claimTimeoutMs: 2000, claimPollMs: 5 });
  verifiedHandlers.acceptance_amendment_propose({ storyId, amendmentId: 'AM-2', delta });
  await verifiedHandlers.acceptance_amendment_review({ storyId, amendmentId: 'AM-2', host: 'codex' });
  const reviewerHead = git('rev-parse', 'HEAD');
  verifiedHandlers.acceptance_amendment_propose({ storyId, amendmentId: 'AM-2', delta });
  assert.equal(git('rev-parse', 'HEAD'), reviewerHead, 'exact proposal retry must not commit the live reviewer key pin');
  verifiedHandlers.acceptance_amendment_cancel({ storyId, amendmentId: 'AM-1', reason: 'Retry cancellation without changing another active approval.' });
  assert.equal(git('rev-parse', 'HEAD'), reviewerHead, 'cancel retry must not commit another reviewer key pin');
  await Promise.all(workers);
  verifiedHandlers.acceptance_amendment_approve({ storyId, amendmentId: 'AM-2' });
  await checklist.verification_evidence_add({ storyId, itemId: 'CHK-006', intentRef: 'CHK-006:happy:0', kind: 'integration_test',
    command: 'node verify.cjs', selector: 'case-36-PASS', note: 'Executed the actual zero-sum boundary and bound it to the legally approved missing acceptance intent.' });
  checklist.checklist_update({ storyId, itemId: 'CHK-006', status: 'done' });
  assert.equal(coverage().total, 36); assert.equal(coverage().covered, 36); assert.equal(coverage().missingRequired, 0);
  assert.deepEqual(store.readChecklist(storyId).items.slice(0, 5), preservedHistory, 'original thirty-five intents and executed evidence retain their exact history');
  assert.equal(store.readChecklist(storyId).items.flatMap(i => i.verificationEvidence ?? []).filter(e => e.kind === 'waiver').length, 0);
  assert.equal(checklistAllDoneGuard(context), true, 'legal additive approval and actual verification unblock the acceptance gate');
  const stricter = JSON.parse(JSON.stringify(delta).replaceAll('AB-NEW', 'AB-RETRY').replaceAll('CHK-006:happy:0', 'CHK-006:happy:1'));
  stricter.appendIntents[0].verificationIntent.happy[0].desc = 'Additional zero-sum check preserves the first approved acceptance';
  verifiedHandlers.acceptance_amendment_propose({ storyId, amendmentId: 'AM-3', delta: stricter });
  await verifiedHandlers.acceptance_amendment_review({ storyId, amendmentId: 'AM-3', host: 'codex' });
  const nextReviewerHead = git('rev-parse', 'HEAD');
  verifiedHandlers.acceptance_amendment_approve({ storyId, amendmentId: 'AM-2' });
  verifiedHandlers.acceptance_amendment_cancel({ storyId, amendmentId: 'AM-1', reason: 'Retry cancellation while another amendment review is active.' });
  assert.equal(git('rev-parse', 'HEAD'), nextReviewerHead, 'terminal approval and cancellation retries must not commit another live key pin');
  await Promise.all(workers);
  verifiedHandlers.acceptance_amendment_approve({ storyId, amendmentId: 'AM-3' });
  store.writeStory(storyId, { ...store.readStory(storyId), phase: 'REVIEW' });
  assert.throws(() => amendments.acceptance_amendment_propose({ storyId, amendmentId: 'AM-4', delta }), /DEV/);
  console.log('PASS U05 public amendment flow blocks all completion and scope bypasses');
} finally { await Promise.allSettled(workers); process.chdir(previousCwd); rmSync(root, { recursive: true, force: true }); }
