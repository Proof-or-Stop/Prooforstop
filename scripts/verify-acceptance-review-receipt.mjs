import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as managed from '../packages/main/dist/core/managed-host-run.js';
import { defaultHostRunRunner, FinalAssistantResultScanner } from '../packages/main/dist/core/host-run.js';
import { generateEd25519KeyPair, signCanonical } from '../packages/main/dist/core/authority-signing.js';
import { parseAcceptanceReviewFinal, ACCEPTANCE_REVIEW_FINAL_SCHEMA } from '../packages/main/dist/core/acceptance-amendment-review.js';
import { currentMaterialHash, currentStoryFilesHash } from '../packages/main/dist/core/evidence-freshness.js';
assert.equal(typeof managed.readManagedAcceptanceReviewReceipt, 'function', 'U05 requires independently sealed DEV amendment review');
const root = mkdtempSync(join(tmpdir(), 'amendment-review-'));
const workers = [];
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
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
  const launch = (mutate = value => value, count = 1, exitCode = 0, host = 'codex') => ({ launchWorker: request => {
    launches++;
    const body = mutate({ schemaVersion: 'proof-or-stop.acceptance_amendment_review_final.v1', runId: request.runId, storyId: args.storyId, ...subject,
      decision: 'approve', rationale: 'The added negative-input verification is mandatory and preserves the original intent.', readRefs: ['sum.cjs'] });
    const event = host === 'claude' ? { type: 'result', subtype: 'success', structured_output: body } : { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(body) } };
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
  assert.equal(managed.managedHostRunReceipt(root, run.runId).state, 'completed', readFileSync(join(managed.managedHostRunDirectory(root, run.runId), 'terminal.json'), 'utf8') + JSON.stringify(managed.readManagedHostRunResult(root, run.runId)));
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
  const retired = await managed.submitManagedHostRun({ ...args, reviewRunId: 'B-amendment:AMR-retired-schema' },
    launch(value => ({ ...value, schemaVersion: 'proofbound.acceptance_amendment_review_final.v1' })));
  await Promise.all(workers);
  assert.equal(managed.managedHostRunReceipt(root, retired.runId).state, 'failed', 'retired inner schema cannot obtain worker approval');
  assert.throws(() => managed.readManagedAcceptanceReviewReceipt(root, retired.runId,
    { ...subject, storyId: args.storyId, promptDigest: sha(prompt), publicKey: managed.managedAcceptanceReviewPublicKey(root, retired.runId) }), /proposal|receipt|signature|binding/);
  // Test-owned signed container: first prove this exact key/container is readable,
  // then change only inner schema and sign again under the same explicit key.
  const fixtureKey = generateEd25519KeyPair();
  const originalSeal = JSON.parse(bytes);
  const { signature: originalSignature, ...fixtureClaims } = originalSeal;
  const fixtureExpected = { ...subject, storyId: args.storyId, promptDigest: sha(prompt), publicKey: fixtureKey.publicKey };
  const terminalPath = join(managed.managedHostRunDirectory(root, run.runId), 'terminal.json');
  const terminalBytes = readFileSync(terminalPath);
  const writeFixtureSeal = claims => {
    const text = JSON.stringify({ ...claims, signature: signCanonical(claims, fixtureKey.privateKey) });
    writeFileSync(path, text);
    writeFileSync(terminalPath, JSON.stringify({ ...JSON.parse(terminalBytes), evidenceProposalDigest: sha(text) }));
  };
  try {
    writeFixtureSeal(fixtureClaims);
    assert.equal(managed.readManagedAcceptanceReviewReceipt(root, run.runId, fixtureExpected).proposal.schemaVersion, ACCEPTANCE_REVIEW_FINAL_SCHEMA,
      'test-owned signed canonical inner schema positive control');
    const retiredClaims = { ...fixtureClaims, proposal: { ...fixtureClaims.proposal, schemaVersion: 'proofbound.acceptance_amendment_review_final.v1' } };
    writeFixtureSeal(retiredClaims);
    assert.throws(() => managed.readManagedAcceptanceReviewReceipt(root, run.runId, fixtureExpected), /subject binding invalid/,
      'authentic signed retired inner schema is not current authority');
  } finally { writeFileSync(path, bytes); writeFileSync(terminalPath, terminalBytes); }
  const actualResult = managed.readManagedHostRunResult(root, run.runId);
  assert.throws(() => parseAcceptanceReviewFinal({ ...actualResult, finalAssistantResult: JSON.stringify({ ...accepted.proposal, schemaVersion: 'proofbound.acceptance_amendment_review_final.v1' }) }, { ...subject, runId: run.runId, storyId: args.storyId }), /subject or verdict invalid/);
  for (const change of [{ closeObserved: false }, { processIdentity: null }, { replacementSafe: false }, { finalAssistantResultTruncated: true }, { processCleanup: { reaped: false, residualProcessGroup: true } }]) {
    assert.throws(() => parseAcceptanceReviewFinal({ ...actualResult, ...change }, { ...subject, runId: run.runId, storyId: args.storyId }), /cleanup|final/);
  }
  const oldScanner = new FinalAssistantResultScanner('codex');
  oldScanner.push(JSON.stringify(accepted.proposal)); oldScanner.flush();
  assert.equal(oldScanner.snapshot().count, 0, 'DEV approval cannot become an old REVIEW final result');
  const newScanner = new FinalAssistantResultScanner('codex', 2048, ACCEPTANCE_REVIEW_FINAL_SCHEMA);
  newScanner.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(accepted.proposal) } }) + '\n');
  newScanner.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Later ordinary terminal prose.' } }) + '\n');
  newScanner.flush(); assert.equal(newScanner.snapshot().count, 0, 'nonterminal approval cannot survive later ordinary prose');
  const claude = await managed.submitManagedHostRun({ ...args, host: 'claude', reviewRunId: 'B-amendment:AMR-5' }, launch(value => ({ ...value, decision: 'reject' }), 1, 0, 'claude'));
  const claudeKey = managed.managedAcceptanceReviewPublicKey(root, claude.runId);
  await Promise.all(workers);
  assert.equal(managed.readManagedAcceptanceReviewReceipt(root, claude.runId, { ...subject, storyId: args.storyId, promptDigest: sha(prompt), publicKey: claudeKey }).proposal.decision, 'reject', 'honest rejection is a completed review, never implicit approval');
  const expected = { ...subject, storyId: args.storyId, promptDigest: sha(prompt), publicKey };
  const gc = managed.pruneExpiredManagedHostRuns(root, { now: Date.now() + 365 * 86400000, retentionMs: 1 });
  assert.ok(gc.removed.includes(run.runId), JSON.stringify(gc));
  assert.equal(managed.readManagedAcceptanceReviewReceipt(root, run.runId, expected).proposal.decision, 'approve', 'GC preserves approval under the original pinned key');
  const archivePath = join(managed.managedHostRunReceiptsRoot(root), `${run.runId}.json`);
  const originalArchive = readFileSync(archivePath, 'utf8');
  const forge = (replacementKey = false) => {
    const archive = JSON.parse(originalArchive);
    const seal = JSON.parse(archive.evidenceProposalText);
    seal.proposal.decision = 'reject';
    if (replacementKey) {
      const { signature, ...claims } = seal;
      seal.signature = signCanonical(claims, generateEd25519KeyPair().privateKey);
    }
    archive.evidenceProposalText = JSON.stringify(seal);
    archive.receipt.evidenceProposalDigest = sha(archive.evidenceProposalText);
    const { receiptId, ...payload } = archive.receipt;
    archive.receipt.receiptId = sha(canonical(payload));
    writeFileSync(archivePath, JSON.stringify(archive));
    assert.throws(() => managed.readManagedAcceptanceReviewReceipt(root, run.runId, expected), /signature/, 'recomputing every unsigned digest cannot replace the pinned worker signature');
  };
  forge(); forge(true); writeFileSync(archivePath, originalArchive);
  console.log('PASS U05 independent signed DEV amendment review');
} finally { await Promise.allSettled(workers); rmSync(root, { recursive: true, force: true }); }
