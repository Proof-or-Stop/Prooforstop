#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import {
  DEFAULT_AUTHORITY_RECEIPT_MAX_VERIFIED_AGE_MS,
  upsertAuthorityGateReceiptRef,
  type AuthorityGateDecisionReceiptRef,
} from '../core/authority-gate-receipts.js';
import { createVerifierHandlers } from '../handlers/verifier.js';
import { runAuthorityReceiptTransitionGate } from '../handlers/phase-gates.js';
import type { HandlerContext } from '../handlers/context.js';

const NOW = new Date().toISOString();

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function makeRoot(): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'authority-gate-consumption-'));
  mkdirSync(join(root, 'packages', 'main', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'main', 'src', 'index.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'lattice.config.json'), `${JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
    workflow: { profile: 'balanced' },
  }, null, 2)}\n`);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Authority Gate Smoke']);
  git(root, ['add', 'lattice.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'seed']);
  return { root, store: new StoryStore(root) };
}

function seedStory(store: StoryStore, storyId: string, phase: StoryInfo['phase'] = 'DEV'): void {
  const story: StoryInfo = {
    storyId,
    name: storyId.toLowerCase(),
    title: 'Authority gate consumption smoke story',
    description: 'Temporary story used to verify authority receipt gate consumption.',
    type: 'feature',
    phase,
    priority: 'medium',
    createdAt: NOW,
    startedAt: null,
    endedAt: null,
    events: [],
  };
  store.writeStory(storyId, story);
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'done',
      status: 'done',
      startTime: NOW,
      endTime: NOW,
    }],
  };
  store.writeChecklist(storyId, checklist);
}

function validRef(
  root: string,
  storyId: string,
  targetPhase: 'REVIEW' | 'TEST' | 'DONE',
  overrides: Partial<AuthorityGateDecisionReceiptRef> = {},
): AuthorityGateDecisionReceiptRef {
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root);
  assert.ok(headHash, 'smoke repo must have git HEAD');
  assert.ok(materialHash, 'smoke repo must have material hash');
  return {
    receiptId: `AR-${targetPhase}`,
    receiptKind: 'gate_decision',
    classification: 'production-gate-decision',
    authorityUrl: 'https://authority.example',
    authorityKeyId: 'server-key-1',
    authorityPublicKeyDigest: 'sha256:key',
    decisionId: `GD-${targetPhase}`,
    stateVersion: 7,
    gateInputDigest: `sha256:input-${targetPhase}`,
    decisionDigest: `sha256:decision-${targetPhase}`,
    decisionVerdict: 'pass',
    storyId,
    targetPhase,
    headHash,
    materialHash,
    policyMode: 'balanced',
    authorityMode: 'enforce',
    producerRunIds: ['run-producer-1'],
    verifierRunIds: ['run-verifier-1'],
    runnerSessionIds: ['session-1'],
    evidenceDigests: ['sha256:evidence-1'],
    verifiedAt: NOW,
    verifiedBy: 'lattice authority receipt verify',
    eligibleGates: [targetPhase],
    status: 'active',
    consumptionEvents: [],
    ...overrides,
  };
}

function writeRef(store: StoryStore, storyId: string, ref: AuthorityGateDecisionReceiptRef): void {
  store.writeAuthorityReceiptRefs(
    storyId,
    upsertAuthorityGateReceiptRef(store.readAuthorityReceiptRefs(storyId) ?? undefined, ref, NOW),
  );
}

{
  const { root, store } = makeRoot();
  try {
    seedStory(store, 'B-test');
    writeRef(store, 'B-test', validRef(root, 'B-test', 'TEST'));
    const ctx: HandlerContext = {
      root,
      store,
      scanRoot: join(root, 'packages', 'main'),
      authoritySettings: { mode: 'enforce', timeoutMS: 1000 },
    };
    const verifier = createVerifierHandlers(ctx);
    const result = JSON.parse(String(await verifier.validate({ story: 'B-test', json: true, noSync: true })));
    assert.equal(result.allPass, true);
    assert.equal(result.authorityGateConsumption.strongEvidenceConsumed, true);
    assert.match(result.details.join('\n'), /Authority gate consumption: PASS strongEvidenceConsumed=true story=B-test gate=TEST receiptId=AR-TEST/);
    assert.equal(store.readAuthorityReceiptRefs('B-test')?.refs[0]?.consumptionEvents?.length, 1);

    await verifier.validate({ story: 'B-test', json: true, noSync: true });
    assert.equal(store.readAuthorityReceiptRefs('B-test')?.refs[0]?.consumptionEvents?.length, 1, 'validate consumption is idempotent');

    const gateReport = runAuthorityReceiptTransitionGate(ctx, 'B-test', 'TEST');
    assert.match(gateReport, /Authority gate consumption: PASS/);
    assert.equal(store.readAuthorityReceiptRefs('B-test')?.refs[0]?.consumptionEvents?.length, 1, 'transition consumption is idempotent after validate');

    const staleVerifiedAt = new Date(Date.now() - (DEFAULT_AUTHORITY_RECEIPT_MAX_VERIFIED_AGE_MS * 2)).toISOString();
    seedStory(store, 'B-stale-validate');
    writeRef(store, 'B-stale-validate', validRef(root, 'B-stale-validate', 'TEST', { verifiedAt: staleVerifiedAt }));
    const staleValidation = JSON.parse(String(await verifier.validate({ story: 'B-stale-validate', json: true, noSync: true })));
    assert.equal(staleValidation.allPass, false, 'stale receipt blocks authority-backed validate in enforce mode');
    assert.equal(staleValidation.authorityGateConsumption.reason, 'authority_receipt_freshness_expired');

    seedStory(store, 'B-stale-transition');
    writeRef(store, 'B-stale-transition', validRef(root, 'B-stale-transition', 'TEST', { verifiedAt: staleVerifiedAt }));
    assert.throws(
      () => runAuthorityReceiptTransitionGate(ctx, 'B-stale-transition', 'TEST'),
      /authority_receipt_freshness_expired/,
    );

    seedStory(store, 'B-test-restricted');
    writeRef(store, 'B-test-restricted', validRef(root, 'B-test-restricted', 'TEST', { eligibleGates: ['DONE'] }));
    assert.throws(
      () => runAuthorityReceiptTransitionGate(ctx, 'B-test-restricted', 'TEST'),
      /authority_receipt_phase_mismatch/,
    );

    seedStory(store, 'B-done', 'TEST');
    writeRef(store, 'B-done', validRef(root, 'B-done', 'DONE'));
    const doneReport = runAuthorityReceiptTransitionGate(ctx, 'B-done', 'DONE');
    assert.match(doneReport, /Authority DONE gate: PASS strongEvidenceConsumed=true story=B-done gate=DONE receiptId=AR-DONE/);

    seedStory(store, 'B-done-test-ref', 'TEST');
    writeRef(store, 'B-done-test-ref', validRef(root, 'B-done-test-ref', 'TEST'));
    assert.throws(
      () => runAuthorityReceiptTransitionGate(ctx, 'B-done-test-ref', 'DONE'),
      /authority_receipt_phase_mismatch/,
    );

    seedStory(store, 'B-done-test-allowed', 'TEST');
    writeRef(
      store,
      'B-done-test-allowed',
      validRef(root, 'B-done-test-allowed', 'TEST', { eligibleGates: ['TEST', 'DONE'] }),
    );
    const crossPhaseDoneReport = runAuthorityReceiptTransitionGate(ctx, 'B-done-test-allowed', 'DONE');
    assert.match(crossPhaseDoneReport, /Authority DONE gate: PASS strongEvidenceConsumed=true story=B-done-test-allowed gate=DONE receiptId=AR-TEST/);

    seedStory(store, 'B-missing');
    assert.throws(
      () => runAuthorityReceiptTransitionGate(ctx, 'B-missing', 'TEST'),
      /authority_receipt_missing/,
    );

    seedStory(store, 'B-shadow');
    const shadowCtx: HandlerContext = {
      root,
      store,
      scanRoot: join(root, 'packages', 'main'),
      authoritySettings: { mode: 'shadow', timeoutMS: 1000 },
    };
    const shadowResult = JSON.parse(String(await createVerifierHandlers(shadowCtx).validate({ story: 'B-shadow', json: true, noSync: true })));
    assert.equal(shadowResult.allPass, true, 'shadow diagnostics do not block local validation');
    assert.equal(shadowResult.authorityGateConsumption.strongEvidenceConsumed, false);
    assert.equal(store.readAuthorityReceiptRefs('B-shadow'), null, 'shadow mode does not create consumption refs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('authority gate consumption smoke passed');
