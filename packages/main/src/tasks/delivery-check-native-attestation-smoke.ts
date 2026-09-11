#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetSessionIdForTest } from '../core/owner-session.js';
import { StoryStore } from '../core/store.js';
import { createDeliveryCheckHandlers } from '../handlers/delivery-check.js';
import { evaluateDeliveryCheckFreshness, recomputeDeliveryCheckHash } from '../core/delivery-check-hash.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import {
  nativeReviewFixtureBrokers,
  withBrokeredNativeDeliveryInvocation,
  withNativeReviewFixtureHostIdentity,
} from './native-review-fixture.js';

const root = mkdtempSync(join(tmpdir(), 'delivery-native-attestation-'));
const storyId = 'B-delivery-native';

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

try {
  git('init');
  git('config', 'user.name', 'Smoke');
  git('config', 'user.email', 'smoke@example.test');
  writeFileSync(join(root, 'README.md'), 'delivery native authority smoke\n');
  writeFileSync(join(root, 'proof-or-stop.config.json'), `${JSON.stringify({
    nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() },
  }, null, 2)}\n`);
  git('add', 'README.md', 'proof-or-stop.config.json');
  git('commit', '-m', 'init');

  const store = new StoryStore(root);
  const now = new Date().toISOString();
  store.writeStory(storyId, {
    storyId,
    name: 'delivery-native',
    title: 'Delivery native authority',
    description: 'Broker authority smoke.',
    type: 'chore',
    priority: 'medium',
    phase: 'TEST',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [],
  });
  store.writeChecklist(storyId, { items: [] });
  const ctx = { root, scanRoot: join(root, 'packages/main'), store };
  // B-137a: pin the dispatch host explicitly. The raw-identity probe below
  // declares host=codex, so an ambiently-resolved dispatch host (claude in a
  // Claude session) made the call fail with a HOST-MISMATCH message instead of
  // the broker-provenance refusal this fixture asserts -- the check still failed
  // closed, but for the wrong reason, which is exactly what the assertion exists
  // to distinguish.
  withNativeReviewFixtureHostIdentity({
    agent: 'proof-or-stop-review-delivery',
    host: 'codex',
    invoke: () => createStoryDispatchHandlers(ctx).dispatch({
      storyId,
      agentType: 'proof-or-stop-review-delivery',
    }),
  });

  const previous = {
    agent: process.env.PROOF_OR_STOP_AGENT,
    sessionId: process.env.PROOF_OR_STOP_SESSION_ID,
    provider: process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER,
    task: process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK,
    adapterAgent: process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT,
  };
  try {
    process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-review-delivery';
    process.env.PROOF_OR_STOP_SESSION_ID = 'raw-delivery-reviewer-session';
    process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER = 'codex';
    process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK = 'raw-delivery-reviewer-task';
    process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT = 'proof-or-stop-review-delivery';
    resetSessionIdForTest();

    const handlers = createDeliveryCheckHandlers(ctx);
    assert.throws(
      () => handlers.delivery_check_set({
        storyId,
        agentId: 'proof-or-stop-review-delivery',
        docsPromises: [],
        realMachineTests: [],
        closingSelfCheck: {
          hasRealMachineTest: false,
          hasEdgeCaseCoverage: true,
          hasUnresolvedTodos: false,
          summary: 'Raw delivery actor cannot author formal gate evidence.',
        },
      }),
      /registered host-adapter invocation attestation|trusted delivery-review dispatch provenance/i,
      'a raw delivery-reviewer identity without broker provenance must fail closed',
    );
    assert.equal(store.readDeliveryCheck(storyId), null, 'rejected raw delivery evidence must not be persisted');

    const saved = withBrokeredNativeDeliveryInvocation({
      root,
      store,
      storyId,
      invoke: () => handlers.delivery_check_set({
        storyId,
        agentId: 'proof-or-stop-review-delivery',
        docsPromises: [],
        realMachineTests: [],
        closingSelfCheck: {
          hasRealMachineTest: false,
          hasEdgeCaseCoverage: true,
          hasUnresolvedTodos: false,
          summary: 'Brokered delivery reviewer authors exact formal evidence.',
        },
      }),
    });
    assert.match(saved, /Delivery check saved/);
    const delivery = store.readDeliveryCheck(storyId);
    assert.equal(delivery?.agentId, 'proof-or-stop-review-delivery');
    assert.ok(delivery?.nativeEvidenceBinding, 'delivery check persists the broker evidence binding it consumed');
    assert.equal(evaluateDeliveryCheckFreshness(storyId, store, root, root).ok, true,
      'canonical delivery dispatch preserves valid broker provenance at the DONE reader');
    const canonicalDelivery = structuredClone(delivery!);
    for (const field of ['agent', 'lane'] as const) {
      const retired = structuredClone(canonicalDelivery);
      retired.nativeEvidenceBinding = { ...retired.nativeEvidenceBinding!, [field]: 'lattice-review-delivery' };
      store.writeDeliveryCheck(storyId, retired);
      retired._hash = recomputeDeliveryCheckHash(storyId, store)!;
      store.writeDeliveryCheck(storyId, retired);
      assert.equal(evaluateDeliveryCheckFreshness(storyId, store, root, root).ok, false,
        `retired delivery ${field} cannot acquire broker authority through a recomputed public hash`);
    }
    store.writeDeliveryCheck(storyId, canonicalDelivery);
    const originalHash = delivery!._hash;
    delivery!.nativeEvidenceBinding = { ...delivery!.nativeEvidenceBinding!, brokerId: 'forged-broker' };
    store.writeDeliveryCheck(storyId, delivery!);
    assert.notEqual(recomputeDeliveryCheckHash(storyId, store), originalHash, 'delivery-check signature binds broker provenance');
    // An attacker can recompute the public integrity hash, but cannot forge the
    // registered broker attestation. DONE/read freshness therefore re-verifies
    // the binding rather than treating the hash alone as native provenance.
    delivery!._hash = recomputeDeliveryCheckHash(storyId, store)!;
    store.writeDeliveryCheck(storyId, delivery!);
    const provenance = evaluateDeliveryCheckFreshness(storyId, store, root, root);
    assert.equal(provenance.ok, false);
    assert.match(provenance.reason, /native broker provenance/i,
      'DONE freshness mechanically rejects a rehashed forged broker binding');
  } finally {
    resetSessionIdForTest();
    if (previous.agent === undefined) delete process.env.PROOF_OR_STOP_AGENT; else process.env.PROOF_OR_STOP_AGENT = previous.agent;
    if (previous.sessionId === undefined) delete process.env.PROOF_OR_STOP_SESSION_ID; else process.env.PROOF_OR_STOP_SESSION_ID = previous.sessionId;
    if (previous.provider === undefined) delete process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER; else process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER = previous.provider;
    if (previous.task === undefined) delete process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK; else process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK = previous.task;
    if (previous.adapterAgent === undefined) delete process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT; else process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT = previous.adapterAgent;
  }

  console.log('delivery-check-native-attestation smoke: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
