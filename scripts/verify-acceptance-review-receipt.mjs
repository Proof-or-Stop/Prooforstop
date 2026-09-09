import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as managed from '../packages/main/dist/core/managed-host-run.js';
import { defaultHostRunRunner } from '../packages/main/dist/core/host-run.js';
import { currentMaterialHash, currentStoryFilesHash } from '../packages/main/dist/core/evidence-freshness.js';
assert.equal(typeof managed.readManagedAcceptanceReviewReceipt, 'function', 'U05 requires independently sealed DEV amendment review');
const root = mkdtempSync(join(tmpdir(), 'amendment-review-'));
const workers = [];
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
try {
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Lab review'); git('config', 'user.email', 'lab@example.invalid');
  writeFileSync(join(root, 'sum.cjs'), 'module.exports=(a,b)=>a+b;\n');
  git('add', '.'); git('commit', '-qm', 'immutable review source');
  const prompt = 'Independently review amendment AM-1 and report its exact bound acceptance verdict.';
  const subject = { amendmentId: 'AM-1', amendmentDigest: 'a'.repeat(64), baseDigest: 'b'.repeat(64), submitterSessionId: 'owner-session' };
  const args = { root, cwd: root, host: 'codex', storyId: 'B-amendment', phase: 'DEV', agentType: 'proof-or-stop-acceptance-intent-reviewer', lane: 'proof-or-stop-acceptance-intent-reviewer',
    reviewRunId: 'B-amendment:AMR-1', profile: 'acceptance_amendment_reviewer', isolateManagedReview: true,
    acceptanceReviewBinding: subject, promptText: prompt, deadlineMs: 20000, projectRootHash: sha(root),
    reviewBinding: { headHash: git('rev-parse', 'HEAD'), materialHash: currentMaterialHash(root), storyFilesHash: currentStoryFilesHash(root), promptHash: sha(prompt), managedPromptDigest: sha(prompt), envelopeId: null } };
  let launches = 0;
  const launch = (mutate = value => value, count = 1, exitCode = 0) => ({ launchWorker: request => {
    launches++;
    const body = mutate({ schemaVersion: 'proofbound.acceptance_amendment_review_final.v1', runId: request.runId, storyId: args.storyId, ...subject,
      decision: 'approve', rationale: 'The added negative-input verification is mandatory and preserves the original intent.', readRefs: ['sum.cjs'] });
    const event = { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(body) } };
    const script = `if(process.env.LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY)throw Error('private capability leaked'); ${Array.from({length:count},()=>`console.log(${JSON.stringify(JSON.stringify(event))});`).join('')} process.exitCode=${exitCode};`;
    workers.push(managed.runManagedHostRunWorker(request, { env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
      runner: plan => defaultHostRunRunner({ ...plan, command: process.execPath, argv: ['-e', script], stdinText: '' }) }));
    return { pid: process.pid };
  }, claimTimeoutMs: 2000, claimPollMs: 5 });
  await assert.rejects(managed.submitManagedHostRun({ ...args, phase: 'REVIEW' }, launch()), /DEV|amendment/);
  assert.equal(launches, 0, 'amendment profile cannot mint REVIEW credentials');
  const run = await managed.submitManagedHostRun(args, launch());
  const publicKey = managed.managedAcceptanceReviewPublicKey(root, run.runId);
  assert.ok(publicKey);
  await Promise.all(workers);
  const accepted = managed.readManagedAcceptanceReviewReceipt(root, run.runId, { ...subject, storyId: args.storyId, promptDigest: sha(prompt), publicKey });
  assert.equal(accepted.proposal.decision, 'approve');
  assert.equal(accepted.receipt.state, 'completed');
  assert.equal(accepted.receipt.processCleanup.reaped, true, 'approval came from a real child exit and cleanup');
  assert.throws(() => managed.readManagedAcceptanceReviewReceipt(root, run.runId, { ...subject, amendmentDigest: 'c'.repeat(64), storyId: args.storyId, promptDigest: sha(prompt), publicKey }), /binding|subject|amendment/);
  const path = join(managed.managedHostRunDirectory(root, run.runId), 'evidence-proposal.json');
  const bytes = readFileSync(path); const tampered = JSON.parse(bytes); tampered.proposal.decision = 'reject'; writeFileSync(path, JSON.stringify(tampered));
  assert.throws(() => managed.readManagedAcceptanceReviewReceipt(root, run.runId, { ...subject, storyId: args.storyId, promptDigest: sha(prompt), publicKey }), /signature|digest|receipt|proposal/);
  writeFileSync(path, bytes);
  for (const [index, options] of [[2, launch(value => ({ ...value, amendmentDigest: 'd'.repeat(64) }))], [3, launch(value => value, 2)], [4, launch(value => value, 1, 1)]]) {
    const rejected = await managed.submitManagedHostRun({ ...args, reviewRunId: `B-amendment:AMR-${index}` }, options);
    await Promise.all(workers);
    assert.equal(managed.managedHostRunReceipt(root, rejected.runId).state, 'failed', 'mismatch, duplicate final result and nonzero exit cannot approve');
  }
  console.log('PASS U05 independent signed DEV amendment review');
} finally { await Promise.allSettled(workers); rmSync(root, { recursive: true, force: true }); }
