#!/usr/bin/env node
/**
 * Smoke coverage for Lattice autopilot dual-mode boundaries:
 * - local mode remains usable without Python authority configuration.
 * - shadow mode reports authority readiness without blocking local workflow.
 * - authority mode fail-closes when Python authority prerequisites or DONE
 *   receipts are missing.
 * - non-dry-run autopilot records only a projection event, not gate evidence.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAutopilotRun, buildAutopilotStatus } from '../core/autopilot.js';
import { generateEd25519KeyPair, signCanonical, stripSignature } from '../core/authority-signing.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import type { AuthorityReceipt } from '../core/authority-runner-contracts.js';
import { createAutopilotHandlers } from '../handlers/autopilot.js';

const PASS_LINE =
  '✓ autopilot authority smoke passed: local usable, shadow advisory, authority fail-closed, projection-only event recorded';

type JsonObject = Record<string, unknown>;
type EnvOverride = Record<string, string | undefined>;

const EMPTY_AUTHORITY_ENV: EnvOverride = {
  LATTICE_AUTHORITY_MODE: '',
  LATTICE_AUTHORITY_URL: '',
  LATTICE_AUTHORITY_TIMEOUT_MS: '',
  LATTICE_AUTHORITY_ACTOR_KEY: '',
  LATTICE_AUTHORITY_ACTOR_KEY_PATH: '',
  LATTICE_AUTHORITY_RUNNER_ID: '',
  LATTICE_AUTHORITY_SESSION_ID: '',
};

const READY_AUTHORITY_ENV: EnvOverride = {
  LATTICE_AUTHORITY_MODE: 'enforce',
  LATTICE_AUTHORITY_URL: 'https://authority.test',
  LATTICE_AUTHORITY_ACTOR_KEY: 'test-actor-key',
  // Production now requires a customer API key for authority-mode runs (B-ea92+).
  LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'test-customer-key',
  LATTICE_AUTHORITY_RUNNER_ID: 'runner-1',
};

function writeConfig(root: string): void {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  resetConfigCache();
}

function seedStory(store: StoryStore): void {
  const now = '2026-06-04T00:00:00.000Z';
  const story: StoryInfo = {
    storyId: 'B-auto',
    name: 'autopilot-smoke',
    title: 'Autopilot smoke',
    description: 'Verify autopilot dual-mode boundaries.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now }],
  };
  store.writeStory('B-auto', story);
}

function assertNoProductionOverclaim(value: unknown, label: string): void {
  const offenders: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(node as JsonObject)) {
      const childPath = path ? `${path}.${key}` : key;
      if (
        (key === 'productionDone' ||
          key === 'receiptVerified' ||
          key === 'canClaimProductionDone' ||
          key === 'authorityChanged') &&
        child === true
      ) {
        offenders.push(childPath);
      }
      visit(child, childPath);
    }
  };
  visit(value, '');
  assert.deepEqual(offenders, [], `${label} must not claim production authority`);
}

function signedReceipt(overrides: Partial<AuthorityReceipt> = {}): { receipt: AuthorityReceipt; publicKey: string } {
  const keypair = generateEd25519KeyPair();
  const base: AuthorityReceipt = {
    receiptId: 'rcpt-autopilot-1',
    subjectId: 'autopilot-done-B-auto',
    subjectKind: 'story-done',
    issuedAt: '2026-06-04T00:00:00.000Z',
    authorityActorId: 'python-authority-1',
    ...overrides,
  };
  const signature = signCanonical(stripSignature(base), keypair.privateKey);
  return { receipt: { ...base, signature }, publicKey: keypair.publicKey };
}

type NativeReceipt = {
  receiptId: string;
  kind: string;
  projectId: string;
  storyId: string;
  actorId: string;
  role: string;
  stateVersion: number;
  policyVersion: string;
  inputDigest: string;
  decisionDigest: string;
  issuedAt: string;
  serverKeyId: string;
  signature?: string;
};

function signedNativeGateReceipt(overrides: Partial<NativeReceipt> = {}): { receipt: NativeReceipt; serverPublicKeyHex: string } {
  const keypair = generateEd25519KeyPair();
  const base: NativeReceipt = {
    receiptId: 'rcpt-gate-1',
    kind: 'gate_decision',
    projectId: 'project-1',
    storyId: 'B-auto',
    actorId: 'lattice-authority-server',
    role: 'server',
    stateVersion: 1,
    policyVersion: 'policy-v1',
    inputDigest: 'input-digest-1',
    decisionDigest: 'decision-digest-1',
    issuedAt: new Date().toISOString(),
    serverKeyId: 'server-key-1',
    ...overrides,
  };
  const signature = Buffer.from(signCanonical(stripSignature(base), keypair.privateKey), 'base64').toString('hex');
  return {
    receipt: { ...base, signature },
    serverPublicKeyHex: Buffer.from(keypair.publicKey, 'base64').toString('hex'),
  };
}

function runCliJson<T>(root: string, args: string[], env: EnvOverride = {}): T {
  const taskDir = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(taskDir, '..', 'cli.js');
  const out = execFileSync(process.execPath, [cliPath, '--root', root, ...args], {
    cwd: root,
    env: { ...process.env, ...EMPTY_AUTHORITY_ENV, ...env },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out) as T;
}

const root = mkdtempSync(join(tmpdir(), 'lattice-autopilot-authority-'));
try {
  writeConfig(root);
  const store = new StoryStore(root);
  seedStory(store);

  const local = buildAutopilotRun(store, { mode: 'local', until: 'DONE', storyId: 'B-auto' }, EMPTY_AUTHORITY_ENV);
  assert.equal(local.status, 'pass');
  assert.equal(local.localWorkflowUsable, true);
  assert.equal(local.authorityRequired, false);
  assert.equal(local.receiptRequired, false);
  assert.equal(local.receipt.verified, false);
  assert.equal(local.authorityRequired, false, 'local mode must stay usable without any authority requirement');
  assert.equal(local.authorityDone, false, 'local mode never claims authority DONE');
  assertNoProductionOverclaim(local, 'local autopilot');

  const shadow = buildAutopilotRun(store, { mode: 'shadow', storyId: 'B-auto' }, EMPTY_AUTHORITY_ENV);
  assert.equal(shadow.status, 'warn');
  assert.equal(shadow.localWorkflowUsable, true);
  assert.equal(shadow.authorityRequired, false);
  assert(shadow.authority.readinessWarnings.length > 0, 'shadow mode should surface authority warnings');

  const authorityMissing = buildAutopilotRun(store, { mode: 'authority', until: 'DONE', storyId: 'B-auto' }, EMPTY_AUTHORITY_ENV);
  assert.equal(authorityMissing.status, 'fail');
  assert.equal(authorityMissing.localWorkflowUsable, true);
  assert.equal(authorityMissing.authorityRequired, true);
  assert.equal(authorityMissing.receiptRequired, true);
  assert.equal(authorityMissing.receipt.verified, false);
  assert(authorityMissing.nextActions.some(action => action.includes('receiptFile')));
  assertNoProductionOverclaim(authorityMissing, 'authority missing receipt');

  const authorityReadyForTest = buildAutopilotRun(
    store,
    { mode: 'authority', until: 'TEST', storyId: 'B-auto' },
    { ...EMPTY_AUTHORITY_ENV, ...READY_AUTHORITY_ENV },
  );
  assert.equal(authorityReadyForTest.status, 'pass');
  assert.equal(authorityReadyForTest.receiptRequired, false);
  assert.deepEqual(authorityReadyForTest.authority.runnerPlannedSteps, ['register_runner', 'runner_heartbeat', 'claim_job']);

  const authorityDoneWithoutReceipt = buildAutopilotRun(
    store,
    { mode: 'authority', until: 'DONE', storyId: 'B-auto' },
    { ...EMPTY_AUTHORITY_ENV, ...READY_AUTHORITY_ENV },
  );
  assert.equal(authorityDoneWithoutReceipt.status, 'fail');
  assert.equal(authorityDoneWithoutReceipt.receiptRequired, true);
  assert.equal(authorityDoneWithoutReceipt.receipt.verified, false);
  assert.equal(authorityDoneWithoutReceipt.authorityDone, false, 'authorityDone must stay false without a verified native receipt');

  const receiptPath = join(root, 'authority-receipt.json');
  const { receipt, publicKey } = signedReceipt();
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  const legacyReceiptCannotSatisfyNativeDone = buildAutopilotRun(
    store,
    {
      mode: 'authority',
      until: 'DONE',
      storyId: 'B-auto',
      receiptFile: receiptPath,
      authorityPublicKey: publicKey,
    },
    { ...EMPTY_AUTHORITY_ENV, ...READY_AUTHORITY_ENV },
  );
  assert.equal(legacyReceiptCannotSatisfyNativeDone.status, 'fail');
  assert.equal(legacyReceiptCannotSatisfyNativeDone.receipt.verified, false);
  assert.equal(legacyReceiptCannotSatisfyNativeDone.receipt.native, true);
  assert.match(legacyReceiptCannotSatisfyNativeDone.receipt.reason, /serverPublicKey/);

  const nativeReceiptPath = join(root, 'native-gate-receipt.json');
  const { receipt: nativeReceipt, serverPublicKeyHex } = signedNativeGateReceipt();
  writeFileSync(nativeReceiptPath, JSON.stringify(nativeReceipt, null, 2));
  const authorityWrongStoryReceipt = buildAutopilotRun(
    store,
    {
      mode: 'authority',
      until: 'DONE',
      storyId: 'B-auto',
      receiptFile: nativeReceiptPath,
      serverPublicKey: serverPublicKeyHex,
      receiptStoryId: 'B-other',
    },
    { ...EMPTY_AUTHORITY_ENV, ...READY_AUTHORITY_ENV },
  );
  assert.equal(authorityWrongStoryReceipt.status, 'fail');
  assert.equal(authorityWrongStoryReceipt.receipt.verified, false);
  assert.match(authorityWrongStoryReceipt.receipt.reason, /storyId expected/);

  const authorityNativeReceipt = buildAutopilotRun(
    store,
    {
      mode: 'authority',
      until: 'DONE',
      storyId: 'B-auto',
      receiptFile: nativeReceiptPath,
      serverPublicKey: serverPublicKeyHex,
      receiptKind: 'gate_decision',
      receiptProjectId: nativeReceipt.projectId,
      receiptStoryId: nativeReceipt.storyId,
      serverKeyId: nativeReceipt.serverKeyId,
      expectedDecisionDigest: nativeReceipt.decisionDigest,
      receiptMaxAgeMs: 60_000,
      receiptClockSkewMs: 60_000,
    },
    { ...EMPTY_AUTHORITY_ENV, ...READY_AUTHORITY_ENV },
  );
  assert.equal(authorityNativeReceipt.status, 'pass');
  assert.equal(authorityNativeReceipt.receiptRequired, true);
  assert.equal(authorityNativeReceipt.receipt.verified, true);
  assert.equal(authorityNativeReceipt.receipt.native, true);
  assert.equal(authorityNativeReceipt.receipt.kind, 'gate_decision');
  assert.equal(authorityNativeReceipt.receipt.expectedDecisionDigest, nativeReceipt.decisionDigest);
  assert.equal(
    authorityNativeReceipt.authorityDone,
    false,
    'a verified native receipt while the story is still in DEV must not claim authorityDone',
  );

  // Programmatic buildAutopilotRun coverage (complements the CLI receipt-verify paths above):
  // a stale native gate_decision receipt must fail-close the authority DONE projection.
  const staleRunReceiptPath = join(root, 'native-gate-receipt-run-stale.json');
  const { receipt: staleRunReceipt, serverPublicKeyHex: staleRunPublicKeyHex } = signedNativeGateReceipt({
    issuedAt: '2026-01-01T00:00:00.000Z',
  });
  writeFileSync(staleRunReceiptPath, JSON.stringify(staleRunReceipt, null, 2));
  const authorityStaleNativeReceipt = buildAutopilotRun(
    store,
    {
      mode: 'authority',
      until: 'DONE',
      storyId: 'B-auto',
      receiptFile: staleRunReceiptPath,
      serverPublicKey: staleRunPublicKeyHex,
      receiptKind: 'gate_decision',
      receiptProjectId: staleRunReceipt.projectId,
      receiptStoryId: staleRunReceipt.storyId,
      serverKeyId: staleRunReceipt.serverKeyId,
      expectedDecisionDigest: staleRunReceipt.decisionDigest,
      receiptMaxAgeMs: 60_000,
      receiptClockSkewMs: 0,
    },
    { ...EMPTY_AUTHORITY_ENV, ...READY_AUTHORITY_ENV },
  );
  assert.equal(authorityStaleNativeReceipt.status, 'fail');
  assert.equal(authorityStaleNativeReceipt.receipt.verified, false);
  assert.equal(authorityStaleNativeReceipt.receipt.native, true);
  assert.equal(authorityStaleNativeReceipt.authorityDone, false);
  assert.match(authorityStaleNativeReceipt.receipt.reason, /stale/);
  assertNoProductionOverclaim(authorityStaleNativeReceipt, 'authority stale native receipt');

  // A native gate_decision receipt missing decisionDigest must fail-close the authority DONE projection.
  const missingDigestRunPath = join(root, 'native-gate-receipt-run-missing-decision.json');
  const { receipt: missingDigestRunReceipt, serverPublicKeyHex: missingDigestRunPublicKeyHex } = signedNativeGateReceipt({
    decisionDigest: undefined,
  });
  writeFileSync(missingDigestRunPath, JSON.stringify(missingDigestRunReceipt, null, 2));
  const authorityMissingDigestReceipt = buildAutopilotRun(
    store,
    {
      mode: 'authority',
      until: 'DONE',
      storyId: 'B-auto',
      receiptFile: missingDigestRunPath,
      serverPublicKey: missingDigestRunPublicKeyHex,
      receiptKind: 'gate_decision',
      receiptProjectId: missingDigestRunReceipt.projectId,
      receiptStoryId: missingDigestRunReceipt.storyId,
      serverKeyId: missingDigestRunReceipt.serverKeyId,
      receiptMaxAgeMs: 60_000,
      receiptClockSkewMs: 60_000,
    },
    { ...EMPTY_AUTHORITY_ENV, ...READY_AUTHORITY_ENV },
  );
  assert.equal(authorityMissingDigestReceipt.status, 'fail');
  assert.equal(authorityMissingDigestReceipt.receipt.verified, false);
  assert.equal(authorityMissingDigestReceipt.receipt.native, true);
  assert.equal(authorityMissingDigestReceipt.authorityDone, false);
  assert.match(authorityMissingDigestReceipt.receipt.reason, /decisionDigest/);
  assertNoProductionOverclaim(authorityMissingDigestReceipt, 'authority missing decisionDigest receipt');

  // CLI `lattice authority receipt verify` was redesigned in 9581a0f9c
  // ("verify and consume authority receipt refs") to accept an Authority gate
  // proof object (--proof / --proofFile / --proofPath + --storyId) instead of
  // the legacy native-receipt args (--receiptFile / --serverPublicKey / …).
  // The programmatic equivalents for valid / stale / missing-decisionDigest
  // outcomes are already exercised above via buildAutopilotRun(); the new
  // CLI-surface contract is covered by authority-receipt-proof-smoke.ts.

  const status = buildAutopilotStatus(EMPTY_AUTHORITY_ENV);
  assert.equal(status.localAvailable, true);
  assert.equal(status.defaultMode, 'local');
  assert.equal(status.productionDone, false);
  assert.equal(status.receiptVerified, false);
  assert.equal(status.authorityReady, false);

  const handlers = createAutopilotHandlers({ root, scanRoot: 'packages/main', store });
  const defaultDryRun = handlers.autopilot_run({
    mode: 'local',
    storyId: 'B-auto',
    until: 'TEST',
    json: true,
  }) as ReturnType<typeof buildAutopilotRun>;
  assert.equal(defaultDryRun.dryRun, true);
  assert.equal(defaultDryRun.executedSteps.length, 0);
  assert.equal(store.readProcessEvents('B-auto').length, 0, 'default dry-run must not append projection events');

  const projected = handlers.autopilot_run({
    mode: 'local',
    storyId: 'B-auto',
    until: 'TEST',
    dryRun: false,
    maxSteps: 2,
    json: true,
  }) as ReturnType<typeof buildAutopilotRun>;
  assert.equal(projected.status, 'pass');
  assert.equal(projected.executedSteps.length, 2);
  const events = store.readProcessEvents('B-auto');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'autopilot_projection');
  assert.equal(events[0].receiptVerified, false);

  // CLI `lattice autopilot status` and `lattice autopilot run` were redesigned
  // (autopilot_status now reads ONE persisted run by --runId; autopilot_run now
  // runs a saved --policy=<name>, not --mode=local/--mode=authority). The
  // schema-version + pass/fail intent of these three calls is already covered
  // programmatically by buildAutopilotStatus()/buildAutopilotRun() above; the
  // policy-based CLI surface is covered by dedicated autopilot-run/policy smokes.
  void runCliJson;
} finally {
  rmSync(root, { recursive: true, force: true });
  resetConfigCache();
}

console.log(PASS_LINE);
