#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthorityClient, type AuthorityFetch } from '../core/authority-client.js';
import {
  AUTHORITY_GATE_RECEIPT_PROOF_SCHEMA_VERSION,
  gateDecisionDigest,
  gateDecisionInputDigest,
  normalizeAuthorityGatePhase,
  verifyAuthorityGateReceiptProof,
  type AuthorityGateDecision,
  type AuthorityGateDecisionInput,
  type AuthorityGateReceiptProof,
} from '../core/authority-gate-receipt-verifier.js';
import type { AuthorityReceipt } from '../core/authority-runner-contracts.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import {
  generateEd25519KeyPair,
  signCanonical,
} from '../core/authority-signing.js';
import { runAuthorityReceiptVerify } from '../handlers/authority-enforce.js';
import type { HandlerContext } from '../handlers/context.js';

const PASS_LINE = 'authority receipt proof smoke passed';
const ISSUED_AT = '2026-06-10T00:00:00.000Z';

type GateReceipt = AuthorityReceipt & {
  kind: 'gate_decision';
  projectId: string;
  storyId: string;
  actorId: string;
  role: 'server';
  stateVersion: number;
  policyVersion: string;
  inputDigest: string;
  decisionDigest: string;
  serverKeyId: string;
};

function hexFromBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('hex');
}

function publicKeyDigest(publicKeyBase64: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex')}`;
}

function signedReceipt(receipt: Omit<GateReceipt, 'signature'>, privateKey: string): GateReceipt {
  return {
    ...receipt,
    signature: signCanonical(receipt, privateKey),
  };
}

function buildProof(
  overrides: Partial<{
    serverKeyId: string;
    serverKeyProfile: string;
    serverKeyProductionInert: boolean;
    authorityActorId: string;
    useHexWire: boolean;
    inputPayload: AuthorityGateDecisionInput;
    decisionPayload: AuthorityGateDecision;
    decisionDigestPayload: { decision: AuthorityGateDecision; requestedByActorId: string };
    receipt: GateReceipt;
  }> = {},
): {
  proof: AuthorityGateReceiptProof;
  inputPayload: AuthorityGateDecisionInput;
  decisionPayload: AuthorityGateDecision;
  receipt: GateReceipt;
  keypair: ReturnType<typeof generateEd25519KeyPair>;
} {
  const keypair = generateEd25519KeyPair();
  const serverKeyId = overrides.serverKeyId ?? 'prod-key-1';
  const inputPayload = overrides.inputPayload ?? {
    decisionId: 'GD-proof-1',
    projectId: 'project-1',
    storyId: 'B-proof',
    targetPhase: 'test',
    repo: {
      headHash: 'h'.repeat(40),
      materialHash: 'm'.repeat(64),
      dirty: false,
    },
    policyMode: 'balanced',
    authorityMode: 'enforce',
    evidenceHashes: ['sha256:evidence-1'],
    requestedByActorId: 'main-1',
    requestedAt: ISSUED_AT,
  };
  const decisionPayload = overrides.decisionPayload ?? {
    decisionId: inputPayload.decisionId ?? 'GD-proof-1',
    projectId: inputPayload.projectId,
    storyId: inputPayload.storyId,
    verdict: 'pass',
    targetPhase: inputPayload.targetPhase,
    trustLevelRequired: 2,
    stateVersion: 7,
    repo: inputPayload.repo,
    policyMode: inputPayload.policyMode,
    authorityMode: inputPayload.authorityMode,
    evidenceDigests: ['sha256:evidence-1'],
    producerRunIds: ['run-producer-1'],
    verifierRunIds: ['run-verifier-1'],
    runnerSessionIds: ['session-1'],
    diagnostics: { adequacy: 'pass' },
  };
  const decisionDigestPayload = overrides.decisionDigestPayload ?? {
    decision: decisionPayload,
    requestedByActorId: inputPayload.requestedByActorId,
  };
  const inputDigest = gateDecisionInputDigest(inputPayload);
  const decisionDigest = gateDecisionDigest(decisionDigestPayload);
  const receipt = overrides.receipt ?? signedReceipt({
    receiptId: 'AR-proof-1',
    kind: 'gate_decision',
    subjectKind: 'gate_decision',
    subjectId: decisionPayload.decisionId,
    subjectDigest: `sha256:${decisionDigest}`,
    projectId: inputPayload.projectId,
    storyId: inputPayload.storyId,
    actorId: 'lattice-authority-server',
    authorityActorId: overrides.authorityActorId ?? 'lattice-authority-server',
    role: 'server',
    stateVersion: decisionPayload.stateVersion ?? 7,
    policyVersion: 'authority-policy.v1',
    inputDigest: `sha256:${inputDigest}`,
    decisionDigest: `sha256:${decisionDigest}`,
    issuedAt: ISSUED_AT,
    serverKeyId,
  }, keypair.privateKey);
  const proof = {
    schemaVersion: AUTHORITY_GATE_RECEIPT_PROOF_SCHEMA_VERSION,
    proofKind: 'gate_decision',
    receipt: (overrides.useHexWire
      ? { ...receipt, signature: hexFromBase64(receipt.signature ?? '') }
      : receipt) as unknown as AuthorityGateReceiptProof['receipt'],
    recordId: 'record-proof-1',
    inputPayload,
    decisionPayload,
    decisionDigestPayload,
    requestedByActorId: inputPayload.requestedByActorId,
    serverKeyId,
    serverPublicKeyHex: overrides.useHexWire ? hexFromBase64(keypair.publicKey) : keypair.publicKey,
    serverKeyProfile: overrides.serverKeyProfile ?? 'configured',
    serverKeyProductionInert: overrides.serverKeyProductionInert ?? false,
  } satisfies AuthorityGateReceiptProof;
  return { proof, inputPayload, decisionPayload, receipt, keypair };
}

function makeStoreRoot(): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'authority-receipt-proof-'));
  mkdirSync(join(root, 'packages', 'main', 'src'), { recursive: true });
  const config = {
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  };
  writeFileSync(join(root, 'lattice.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const store = new StoryStore(root);
  return { root, store, ctx: { store, root, scanRoot: join(root, 'packages', 'main') } };
}

function seedStory(store: StoryStore, storyId: string): void {
  const story: StoryInfo = {
    storyId,
    name: storyId.toLowerCase(),
    title: 'Authority receipt proof smoke story',
    description: 'Temporary story used to verify authority receipt ref writes.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: ISSUED_AT,
    startedAt: null,
    endedAt: null,
    events: [],
  };
  store.writeStory(storyId, story);
}

{
  const { proof, inputPayload, keypair } = buildProof({ useHexWire: true });
  const result = verifyAuthorityGateReceiptProof(proof, {
    expected: {
      storyId: inputPayload.storyId,
      phase: 'TEST',
      headHash: inputPayload.repo.headHash,
      materialHash: inputPayload.repo.materialHash,
      stateVersion: 7,
    },
    trust: {
      productionAuthorityKeyDigests: [publicKeyDigest(keypair.publicKey)],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.receiptVerified, true);
  assert.equal(result.productionReady, true);
  assert.equal(result.classification, 'production-gate-decision');
  assert.equal(result.receiptId, 'AR-proof-1');
  assert.equal(result.targetPhase, 'TEST');
  assert.equal(normalizeAuthorityGatePhase('test'), 'TEST');
}

{
  const base = buildProof().inputPayload;
  const { proof, inputPayload, keypair } = buildProof({
    useHexWire: true,
    inputPayload: {
      ...base,
      repo: {
        ...base.repo,
        baseHash: null,
        treeHash: null,
        diffHash: null,
        manifestHash: null,
      },
    },
  });
  const result = verifyAuthorityGateReceiptProof(proof, {
    expected: {
      storyId: inputPayload.storyId,
      phase: 'TEST',
      headHash: inputPayload.repo.headHash,
      materialHash: inputPayload.repo.materialHash,
      stateVersion: 7,
    },
    trust: {
      productionAuthorityKeyDigests: [publicKeyDigest(keypair.publicKey)],
    },
  });
  assert.equal(result.ok, true, 'proof verifier must preserve null passthrough fields in Python gate input digest');
  assert.equal(result.receiptVerified, true);
  assert.equal(result.productionReady, true);
}

{
  const base = buildProof().inputPayload;
  const explicitNull = buildProof({
    useHexWire: true,
    inputPayload: {
      ...base,
      repo: {
        ...base.repo,
        baseHash: null,
        treeHash: null,
        diffHash: null,
        manifestHash: null,
      },
    },
  });
  const proof = {
    ...explicitNull.proof,
    inputPayload: {
      ...explicitNull.inputPayload,
      repo: {
        headHash: explicitNull.inputPayload.repo.headHash,
        materialHash: explicitNull.inputPayload.repo.materialHash,
        dirty: false,
      },
    },
  };
  const result = verifyAuthorityGateReceiptProof(proof, {
    expected: {
      storyId: proof.inputPayload.storyId,
      phase: 'TEST',
      headHash: proof.inputPayload.repo.headHash,
      materialHash: proof.inputPayload.repo.materialHash,
      stateVersion: 7,
    },
    trust: {
      productionAuthorityKeyDigests: [publicKeyDigest(explicitNull.keypair.publicKey)],
    },
  });
  assert.equal(result.ok, true, 'proof verifier must normalize missing optional repo hashes to Python null digest shape');
  assert.equal(result.receiptVerified, true);
  assert.equal(result.productionReady, true);
}

{
  const base = buildProof().inputPayload;
  const { proof, inputPayload, keypair } = buildProof({
    useHexWire: true,
    inputPayload: {
      ...base,
      repo: {
        ...base.repo,
        baseHash: null,
        treeHash: null,
        diffHash: null,
        manifestHash: null,
        branchName: 'receipt-ref-smoke',
      },
    },
  });
  const result = verifyAuthorityGateReceiptProof(proof, {
    expected: {
      storyId: inputPayload.storyId,
      phase: 'TEST',
      headHash: inputPayload.repo.headHash,
      materialHash: inputPayload.repo.materialHash,
      stateVersion: 7,
    },
    trust: {
      productionAuthorityKeyDigests: [publicKeyDigest(keypair.publicKey)],
    },
  });
  assert.equal(result.ok, true, 'proof verifier must keep passthrough repo fields in the signed digest');
  assert.equal(result.receiptVerified, true);
  assert.equal(result.productionReady, true);
}

{
  const { proof, inputPayload, keypair } = buildProof({
    serverKeyProfile: 'local-test',
    serverKeyProductionInert: true,
    serverKeyId: 'dev-server-key',
  });
  const result = verifyAuthorityGateReceiptProof(proof, {
    expected: { storyId: inputPayload.storyId },
    trust: {
      productionAuthorityKeyDigests: [publicKeyDigest(keypair.publicKey)],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.receiptVerified, true);
  assert.equal(result.productionReady, false);
  assert.equal(result.classification, 'server-receipt-local-test');
}

{
  const { proof } = buildProof();
  const result = verifyAuthorityGateReceiptProof(proof);
  assert.equal(result.ok, false);
  assert.equal(result.failureReason, 'untrusted_authority_key');
  assert.ok(result.authorityPublicKeyDigest?.startsWith('sha256:'));
}

{
  const { proof } = buildProof();
  const result = verifyAuthorityGateReceiptProof({
    ...proof,
    receipt: { ...proof.receipt, signature: '00'.repeat(64) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureReason, 'receipt_signature_invalid');
}

{
  const { proof } = buildProof();
  const result = verifyAuthorityGateReceiptProof({
    ...proof,
    inputPayload: { ...proof.inputPayload, evidenceHashes: ['sha256:tampered'] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureReason, 'input_digest_mismatch');
}

{
  const { proof } = buildProof();
  const result = verifyAuthorityGateReceiptProof({
    ...proof,
    decisionDigestPayload: {
      ...proof.decisionDigestPayload,
      decision: { ...proof.decisionPayload, verdict: 'fail' },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureReason, 'decision_digest_mismatch');
}

{
  const { proof } = buildProof({
    decisionPayload: {
      ...buildProof().decisionPayload,
      verdict: 'fail',
    },
  });
  const result = verifyAuthorityGateReceiptProof(proof);
  assert.equal(result.ok, false);
  assert.equal(result.failureReason, 'decision_verdict_not_pass');
}

{
  const { proof } = buildProof();
  assert.equal(
    verifyAuthorityGateReceiptProof(proof, { expected: { storyId: 'B-other' } }).failureReason,
    'story_mismatch',
  );
  assert.equal(
    verifyAuthorityGateReceiptProof(proof, { expected: { phase: 'DONE' } }).failureReason,
    'phase_mismatch',
  );
  assert.equal(
    verifyAuthorityGateReceiptProof(proof, { expected: { headHash: 'other-head' } }).failureReason,
    'head_mismatch',
  );
  assert.equal(
    verifyAuthorityGateReceiptProof(proof, { expected: { materialHash: 'other-material' } }).failureReason,
    'material_mismatch',
  );
}

{
  const { proof } = buildProof();
  const fetchImpl: AuthorityFetch = async (input, init) => {
    assert.equal(input, 'https://authority.example/v1/receipts/AR-proof-1/proof');
    assert.equal(init.method, 'GET');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(proof),
    };
  };
  const client = new AuthorityClient('https://authority.example', fetchImpl, undefined, { customerApiKey: 'test-customer-key' });
  const outcome = await client.fetchGateReceiptProof('/v1/receipts/AR-proof-1/proof');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.kind, 'success');
  assert.equal(outcome.data?.receipt.receiptId, 'AR-proof-1');
  await assert.rejects(
    () => client.fetchGateReceiptProof('https://evil.example/proof'),
    /server-relative path/,
  );
}

{
  const { proof, keypair } = buildProof();
  const { root, store, ctx } = makeStoreRoot();
  try {
    seedStory(store, proof.inputPayload.storyId);
    const result = await runAuthorityReceiptVerify(ctx, {
      storyId: proof.inputPayload.storyId,
      proof,
      productionAuthorityKeyDigests: [publicKeyDigest(keypair.publicKey)],
      authorityURL: 'https://authority.example',
      now: '2026-06-10T00:01:00.000Z',
    });
    assert.equal(result.ok, true);
    assert.equal(result.written, true);
    assert.equal(result.ref?.targetPhase, 'TEST');
    assert.equal(result.ref?.decisionVerdict, 'pass');
    const stored = store.readAuthorityReceiptRefs(proof.inputPayload.storyId);
    assert.equal(stored?.refs.length, 1);
    assert.equal(stored?.refs[0]?.receiptId, 'AR-proof-1');
    await assert.rejects(
      () => runAuthorityReceiptVerify(ctx, {
        storyId: 'B-missing',
        proof,
        productionAuthorityKeyDigests: [publicKeyDigest(keypair.publicKey)],
        now: '2026-06-10T00:02:00.000Z',
      }),
      /existing story index/,
    );
    assert.equal(store.storyExists('B-missing'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(PASS_LINE);
