#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateEd25519KeyPair } from '../core/authority-signing.js';
import { PROOF_OR_STOP_DIR } from '../core/proof-or-stop-paths.js';
import { resetConfigCache } from '../core/config.js';
import { signNativeReviewInvocationAttestation } from '../core/native-review-attestation.js';
import { issueNativeReviewEvidenceBinding, verifyNativeReviewEvidenceBinding } from '../core/native-review-evidence.js';

const root = mkdtempSync(join(tmpdir(), 'native-review-attestation-consumption-'));
const keys = generateEd25519KeyPair();
const broker = {
  brokerId: 'smoke-native-broker',
  adapterId: 'smoke-codex-adapter',
  host: 'codex' as const,
  publicKey: keys.publicKey,
};
const dispatch = {
  hostRenderHost: 'codex' as const,
  dispatchPromptDigest: `sha256:${'1'.repeat(64)}`,
  dispatchBindingDigest: `sha256:${'2'.repeat(64)}`,
  hostRenderIdentityDigest: `sha256:${'3'.repeat(64)}`,
};
const invocation = {
  schemaVersion: 'lattice.native_review_invocation_attestation.v1' as const,
  brokerId: broker.brokerId,
  adapterId: broker.adapterId,
  host: 'codex' as const,
  storyId: 'B-native-consumption',
  agent: 'lattice-review-quality',
  lane: 'lattice-review-quality',
  reviewRunId: 'B-native-consumption:RR-001',
  writerSessionId: 'native-consumption-session',
  dispatchPromptDigest: dispatch.dispatchPromptDigest,
  dispatchBindingDigest: dispatch.dispatchBindingDigest,
  hostRenderIdentityDigest: dispatch.hostRenderIdentityDigest,
  invocationNonce: randomUUID(),
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

try {
  writeFileSync(join(root, 'lattice.config.json'), `${JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    nativeReviewInvocation: { brokers: [broker] },
  })}\n`, 'utf8');
  resetConfigCache();
  const attestation = signNativeReviewInvocationAttestation(invocation, keys.privateKey);
  const binding = issueNativeReviewEvidenceBinding({
    projectRoot: root,
    storyId: invocation.storyId,
    agent: invocation.agent,
    lane: invocation.lane,
    reviewRunId: invocation.reviewRunId,
    identity: {
      sessionId: invocation.writerSessionId,
      sessionSource: 'host-adapter',
      hostProvider: 'codex',
      nativeSessionRef: 'codex:smoke-native-consumption',
    },
    dispatch,
    attestation,
    trustedBrokers: [broker],
    observeProcess: () => null,
  });
  const gateBinding = () => verifyNativeReviewEvidenceBinding({
    binding,
    projectRoot: root,
    storyId: invocation.storyId,
    agent: invocation.agent,
    lane: invocation.lane,
    reviewRunId: invocation.reviewRunId,
    dispatch,
    writerSessionId: invocation.writerSessionId,
    sessionSource: 'host-adapter',
  });
  assert.equal(gateBinding(), true, 'a valid signature plus matching durable one-shot consumption record is accepted');

  const consumptionPath = join(root, PROOF_OR_STOP_DIR, 'runtime', 'native-review-invocations', broker.brokerId, `${invocation.invocationNonce}.json`);
  const consumption = readFileSync(consumptionPath, 'utf8');
  unlinkSync(consumptionPath);
  assert.equal(gateBinding(), false, 'a copied signed direct-review binding is rejected after its consumption record is deleted');

  const tampered = JSON.parse(consumption) as Record<string, unknown>;
  tampered.attestationDigest = `sha256:${'f'.repeat(64)}`;
  writeFileSync(consumptionPath, `${JSON.stringify(tampered)}\n`, 'utf8');
  assert.equal(gateBinding(), false, 'a consumption record with a mismatched broker/nonce digest binding is rejected');

  writeFileSync(consumptionPath, consumption, 'utf8');
  assert.equal(gateBinding(), true, 'restoring the exact consumption record preserves valid native review evidence');
  console.log('native-review-attestation-consumption-smoke PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
