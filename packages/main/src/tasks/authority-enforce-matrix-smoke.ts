#!/usr/bin/env node
//
// authority-enforce-matrix-smoke (B-2522 CHK-002)
//
// Deterministic in-process smoke proving the five-cell matrix:
//   1. local/off  — loadAuthoritySettings({}) is off; authorityModeEnabled false;
//                   classifyCliAuthoritySubmission("off") returns local-only.
//   2. shadow warning — createAuthoritySubmitter(shadow, fake-failing client) returns
//                   proceed=true with a warning.
//   3. enforce fake-server receipt — fake AuthorityClient accepted=true returns
//                   proceed=true; ordinary CLI classification is thin-client-transport-accepted;
//                   a fully-bound envelope + signed AuthorityReceipt verified through
//                   classifyReceiptBackedEvidence reaches receipt-backed-l2-plus.
//   4. enforce no-server — createAuthoritySubmitter(enforce, no baseURL) → submitSingle
//                   returns proceed=false/error (fail-closed).
//   5. parallel_report — buildParallelReport(wave) has authority.productionDone=false,
//                   authorityChanged=false, receiptRefs=[].
//
// Exits 0 on all pass, 1 on any assertion failure.
//

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuthorityClient,
  type AuthorityFetch,
} from '../core/authority-client.js';
import {
  authorityModeEnabled,
  loadAuthoritySettings,
} from '../core/authority-mode.js';
import {
  classifyCliAuthoritySubmission,
  createAuthoritySubmitter,
} from '../core/authority-submit.js';
import {
  classifyReceiptBackedEvidence,
  envelopeSubjectDigest,
  RECEIPT_SUBJECT_KIND_EVIDENCE,
} from '../core/authority-receipt-classification.js';
import {
  generateEd25519KeyPair,
  signCanonical,
  stripSignature,
} from '../core/authority-signing.js';
import type { AuthorityReceipt } from '../core/authority-runner-contracts.js';
import type { EvidenceEnvelopeContract } from '../core/authority-contracts.js';
import {
  buildParallelReport,
  createParallelWave,
} from '../core/lattice-parallel-wave.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import { resetConfigCache } from '../core/config.js';
import { execFileSync } from 'node:child_process';

// ─── helpers ───────────────────────────────────────────────────────────────────

function fetchReturning(status: number, body: string): { calls: number; fetch: AuthorityFetch } {
  const state = { calls: 0 } as { calls: number; fetch: AuthorityFetch };
  state.fetch = async () => {
    state.calls += 1;
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return state;
}

function fetchThrowing(err: Error): { calls: number; fetch: AuthorityFetch } {
  const state = { calls: 0 } as { calls: number; fetch: AuthorityFetch };
  state.fetch = async () => {
    state.calls += 1;
    throw err;
  };
  return state;
}

function fullEnvelope(): EvidenceEnvelopeContract {
  const ISSUED_AT = '2026-06-02T18:30:00.000Z';
  return {
    evidenceId: 'B-2522:CHK-002:happy:0',
    projectId: 'B-2522',
    storyId: 'B-2522',
    producerActorId: 'producer-actor',
    role: 'verifier',
    kind: 'logic_test',
    trustLevel: 2,
    repo: { headHash: 'sha256:head', materialHash: 'sha256:material' },
    coveredRefs: ['ref-1'],
    uncoveredRefs: [],
    failedRefs: [],
    inspectedArtifacts: ['artifact-1'],
    inspectedFiles: ['packages/main/src/core/authority-receipt-classification.ts'],
    inspectedHunks: [],
    inspectedPackRefs: [],
    producerRunId: 'producer-run-1',
    verifierRunId: 'verifier-run-1',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    vendor: 'anthropic',
    commandDigest: 'sha256:cmd',
    transcriptHash: 'sha256:tx',
    diffHash: 'sha256:diff',
    signature: 'ed25519:envelope-signature',
    nonce: 'B-2522:CHK-002',
    createdAt: ISSUED_AT,
  };
}

function signedReceipt(envelope: EvidenceEnvelopeContract, privateKey: string): AuthorityReceipt {
  const ISSUED_AT = '2026-06-02T18:30:00.000Z';
  const base: AuthorityReceipt = {
    receiptId: 'rcpt-matrix-1',
    subjectId: envelope.evidenceId,
    subjectKind: RECEIPT_SUBJECT_KIND_EVIDENCE,
    issuedAt: ISSUED_AT,
    authorityActorId: 'python-authority-1',
    subjectDigest: envelopeSubjectDigest(envelope),
  } as AuthorityReceipt;
  const sig = signCanonical(stripSignature(base), privateKey);
  return { ...base, signature: sig };
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function createTmpRepo(): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-matrix-'));
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'balanced' },
  }));
  writeFileSync(join(root, 'README.md'), 'matrix smoke\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Lattice Smoke', 'commit', '-m', 'base']);
  resetConfigCache();
  const store = new StoryStore(root);
  return { root, store };
}

// ─── cell 1: local/off ─────────────────────────────────────────────────────────
{
  const settings = loadAuthoritySettings({});
  assert.equal(settings.mode, 'off', 'cell1: mode must be off');
  assert.equal(authorityModeEnabled(settings.mode), false, 'cell1: authorityModeEnabled must be false');

  // classifyCliAuthoritySubmission with off envelope stays local-only
  const offEnv: EvidenceEnvelopeContract = {
    evidenceId: 'EV-off-1',
    projectId: 'proj',
    storyId: 'B-2522',
    producerActorId: 'actor-1',
    command: 'lattice validate',
    exitCode: 0,
    nonce: 'nonce-off',
    createdAt: '2026-06-02T00:00:00.000Z',
  } as unknown as EvidenceEnvelopeContract;
  const offResult = classifyCliAuthoritySubmission('off', offEnv, false);
  assert.equal(offResult.klass, 'local-only', 'cell1: off mode classification must be local-only');
}

// ─── cell 2: shadow warning ─────────────────────────────────────────────────────
{
  const settings = { mode: 'shadow' as const, baseURL: 'https://auth.test', timeoutMS: 1000 };
  const failFetch = fetchThrowing(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
  const fakeClient = new AuthorityClient(settings.baseURL, failFetch.fetch);
  const submitter = createAuthoritySubmitter(settings, fakeClient);

  // Submit a minimal material to get a decision without calling the real handler
  const decision = await submitter.submitSingle({
    storyId: 'B-2522',
    itemId: 'CHK-002',
    intentRef: 'CHK-002:happy:0',
    kind: 'logic_test',
    note: 'matrix shadow warning cell',
    createdAt: '2026-06-02T00:00:00.000Z',
    root: process.cwd(),
    store: null as unknown as StoryStore,
  } as Parameters<typeof submitter.submitSingle>[0]);

  assert.equal(decision.proceed, true, 'cell2: shadow + failure must return proceed=true');
  assert.ok(decision.warning, 'cell2: shadow + failure must have a warning');
  assert.match(decision.warning!, /\[warning\]/, 'cell2: warning must contain [warning] marker');
}

// ─── cell 3: enforce fake-server receipt ──────────────────────────────────────
{
  // 3a: fake AuthorityClient accepted=true → proceed=true for submitter
  const settings = { mode: 'enforce' as const, baseURL: 'https://auth.test', timeoutMS: 1000 };
  const okFetch = fetchReturning(200, JSON.stringify({ accepted: true, evidenceId: 'EV-ok' }));
  const fakeClient = new AuthorityClient(settings.baseURL, okFetch.fetch, settings.timeoutMS, { customerApiKey: 'matrix-test-key' });
  const submitter = createAuthoritySubmitter(settings, fakeClient, { customerApiKey: 'matrix-test-key' });
  const decision = await submitter.submitSingle({
    storyId: 'B-2522',
    itemId: 'CHK-002',
    intentRef: 'CHK-002:happy:0',
    kind: 'logic_test',
    note: 'matrix enforce accepted receipt',
    createdAt: '2026-06-02T00:00:00.000Z',
    root: process.cwd(),
    store: null as unknown as StoryStore,
  } as Parameters<typeof submitter.submitSingle>[0]);
  assert.equal(decision.proceed, true, 'cell3a: enforce + accepted must return proceed=true');

  // 3b: ordinary CLI classification stays thin-client-transport-accepted
  const fullEnv = fullEnvelope();
  const cliResult = classifyCliAuthoritySubmission('enforce', fullEnv, true);
  assert.notEqual(cliResult.klass, 'receipt-backed-l2-plus', 'cell3b: CLI classification must not promote to receipt-backed-l2-plus');
  assert.equal(cliResult.klass, 'thin-client-transport-accepted', 'cell3b: CLI classification must be thin-client-transport-accepted');
  assert.ok(cliResult.missing.includes('verifiedAuthorityReceipt'), 'cell3b: must flag missing verifiedAuthorityReceipt');

  // 3c: fully bound envelope + signed receipt → receipt-backed-l2-plus
  const kp = generateEd25519KeyPair();
  const receipt = signedReceipt(fullEnv, kp.privateKey);
  const { classification, receipt: verification } = classifyReceiptBackedEvidence({
    mode: 'enforce',
    envelope: fullEnv,
    receipt,
    authorityPublicKey: kp.publicKey,
    transportAccepted: true,
  });
  assert.equal(verification.verified, true, 'cell3c: receipt must verify');
  assert.equal(classification.klass, 'receipt-backed-l2-plus', 'cell3c: verified receipt + bound envelope must reach receipt-backed-l2-plus');
}

// ─── cell 4: enforce no-server runner fail-closed ─────────────────────────────
{
  // createAuthoritySubmitter with enforce + no baseURL → submitSingle returns proceed=false
  const settings = { mode: 'enforce' as const, timeoutMS: 1000 };
  const submitter = createAuthoritySubmitter(settings, undefined, { customerApiKey: 'matrix-test-key' });
  const decision = await submitter.submitSingle({
    storyId: 'B-2522',
    itemId: 'CHK-002',
    intentRef: 'CHK-002:happy:0',
    kind: 'logic_test',
    note: 'matrix enforce no-server fail-closed',
    createdAt: '2026-06-02T00:00:00.000Z',
    root: process.cwd(),
    store: null as unknown as StoryStore,
  } as Parameters<typeof submitter.submitSingle>[0]);
  assert.equal(decision.proceed, false, 'cell4: enforce + no baseURL must return proceed=false');
  assert.ok(decision.error, 'cell4: enforce + no baseURL must return an error');
  assert.match(decision.error!.message, /LATTICE_AUTHORITY_URL/, 'cell4: error must mention LATTICE_AUTHORITY_URL');
}

// ─── cell 5: parallel_report productionDone=false ─────────────────────────────
{
  const { root, store } = createTmpRepo();
  try {
    // Seed a minimal B-2522 story so createParallelWave can read it
  const now = '2026-06-02T00:00:00.000Z';
  const seedStory: StoryInfo = {
    storyId: 'B-2522',
    name: 'authority-enforce-matrix',
    title: 'Authority enforce matrix CHK-002',
    description: 'Seeded for parallel_report productionDone assertion.',
    type: 'feature',
    phase: 'DEV',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now }],
  };
  store.writeStory('B-2522', seedStory);

  const wave = createParallelWave(store, root, {
      storyIds: ['B-2522'],
      hosts: ['codex', 'claude-code'],
    });
    const report = buildParallelReport(wave);
    assert.equal(report.authority.productionDone, false, 'cell5: productionDone must be false');
    assert.equal(report.authority.authorityChanged, false, 'cell5: authorityChanged must be false');
    assert.deepEqual(report.authority.receiptRefs, [], 'cell5: receiptRefs must be empty');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(
  'authority enforce matrix smoke passed: local/off PASS; shadow warning PASS; enforce fake-server receipt PASS; enforce no-server runner fail-closed PASS; parallel_report productionDone=false PASS',
);
