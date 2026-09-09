#!/usr/bin/env node
/**
 * B-1e1f CHK-001..CHK-005: CertificationWindow signed process-fact, admit,
 * heavy choke, invalidation, and PRE_CERT replay smoke.
 *
 * Covers status surface, process-fact registration, tamper fail-closed,
 * inventory-is-not-PRE_CERT, and PRE_CERT admit from inventory/merge/clean/coverage.
 * Production inventory APIs are present; default begin without a FINALIZED
 * receipt stays fail-closed as [pre_cert_inventory_not_finalized]. A dedicated
 * null-API override exercises [pre_cert_inventory_api_absent]; never stub-always-admit.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { StoryStore } from '../core/store.js';
import { CERTIFICATION_DOMAIN_PATH_RULES, deriveCertificationDomainInputHashes, buildCertificationDecision } from '../handlers/certification-window.js';
import { causalDigest } from '../core/causal-evidence.js';
import { resolveStoryChangedFiles } from '../core/story-aware-validation.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';
import { PROCESS_FACT_REGISTRY } from '../core/process-fact-registry.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { createCertificationWindowHandlers } from '../handlers/certification-window.js';
import { createReviewInventoryHandlers } from '../handlers/review-inventory.js';
import { createDoneRequiredValidationHandlers } from '../handlers/done-required-validation.js';
import { safeDoneRequiredRecoveryCommand } from '../handlers/done-prepare.js';
import { acquireOwnerLease } from '../core/story-owner-lease.js';
import { createVerifierHandlers, probeValidationCausalPreflightFacts } from '../handlers/verifier.js';
import { runValidateGate } from '../handlers/phase-gates.js';
import { computeActiveReviewers } from '../handlers/reviewer-list.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { buildRoutineValidationIdentity } from '../core/validation-evidence-reuse.js';
import {
  CERTIFICATION_WINDOW_FILE,
  CERTIFICATION_WINDOW_STATES,
  INVENTORY_COMPLETENESS_AUTHORITY,
  PRE_CERT_BLOCKING_FINDINGS_OPEN,
  PRE_CERT_COVERAGE_MISSING,
  PRE_CERT_CHEAP_CHECK_REQUIRED,
  PRE_CERT_DIRTY_TREE,
  PRE_CERT_INVENTORY_API_ABSENT,
  PRE_CERT_INVENTORY_NOT_FINALIZED,
  PRE_CERT_INVENTORY_PROBE_FAILED,
  PRE_CERT_MAIN_NOT_MERGED,
  PRE_CERT_ROUTINE_PASS_REQUIRED,
  PRE_CERT_WINDOW_REQUIRED,
  PRE_CERT_WINDOW_TAMPERED,
  PRECERT_TEST_IDENTITY,
  PRECERT_VERIFIER_IDENTITY,
  PRECERT_CHEAP_CHECK_AUTHORITY,
  PRECERT_CHEAP_CHECK_RECEIPT_SCHEMA,
  currentPrecertCheapCheckReceipt,
  detectCertificationWindowMaterialDrift,
  isOfficialHeavyValidateInvocation,
  emptyCertificationWindowData,
  evaluateCertificationWindowAdmit,
  inventoryReceiptAuthorizesPrecert,
  isSaturatedReviewInventoryForPrecert,
  loadReviewInventoryAdmitApis,
  nextCommandForBlocker,
  persistBlockedCertificationWindow,
  persistPrecertCheapCheckReceipt,
  receiptForWindow,
  nextPrecertReceiptId,
  projectCertificationWindowStatus,
  renderCertificationWindowStatus,
  setReviewInventoryAdmitApisForTest,
  verifyCertificationWindow,
  verifyPrecertCheapCheckReceipt,
  verifyPrecertReceipt,
  windowAuthorizesHeavyCertification,
  withSignedCertificationWindow,
  withSignedPrecertReceipt,
  withSignedPrecertCheapCheckReceipt,
  type CertificationWindow,
  type CertificationWindowAdmitFacts,
  type PrecertReceipt,
  type ReviewInventoryAdmitApis,
} from '../core/certification-window.js';
import { signReviewInventoryEpoch, signReviewInventoryReceipt } from '../core/review-inventory-epoch.js';

function signedFastCheapReceipt(args: {
  storyId: string;
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  full?: boolean | string | null;
  focus?: string | null;
  commandCount?: number;
}) {
  const commandCount = args.commandCount ?? 1;
  const identity = buildRoutineValidationIdentity({
    projectRoot: process.cwd(),
    sourceKind: 'configured',
    sourceInputs: { fixture: 'pre-cert-cheap-check' },
    commands: Array.from({ length: commandCount }, (_, index) => ({
      label: `fast-${index + 1}`,
      command: 'node',
      args: ['--version'],
      timeoutMs: 15_000,
      focus: ['fast'],
    })),
    ...(args.full === undefined || args.full === null ? {} : { full: args.full }),
    ...(args.focus === undefined || args.focus === null ? { focus: 'fast' } : { focus: args.focus }),
    profile: 'standard',
    verificationPolicyInputs: { fixture: 'pre-cert-cheap-check' },
  });
  const unsigned = {
    schemaVersion: PRECERT_CHEAP_CHECK_RECEIPT_SCHEMA as typeof PRECERT_CHEAP_CHECK_RECEIPT_SCHEMA,
    receiptId: `${args.storyId}:CHEAP-CHECK-001`,
    storyId: args.storyId,
    authority: PRECERT_CHEAP_CHECK_AUTHORITY as typeof PRECERT_CHEAP_CHECK_AUTHORITY,
    result: 'PASS' as const,
    routineValidationIdentity: identity,
    commandExecution: {
      schema: 'proofOrStop.routine-validation-command-execution' as const,
      version: 1 as const,
      status: 'PASS' as const,
      complete: true,
      commandCount,
      requiredFailureCount: 0,
      optionalFailureCount: 0,
    },
    headHash: args.headHash,
    materialHash: args.materialHash,
    storyFilesHash: args.storyFilesHash,
    createdAt: '2026-08-20T00:00:00.000Z',
  };
  return withSignedPrecertCheapCheckReceipt(unsigned);
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-certification-window-smoke-'));
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    storyDir: '.proof-or-stop/story/actives',
    storyPrefix: 'B',
  }));
  return root;
}

function makeStore(root: string, storyId: string, phase: 'DEV' | 'TEST' = 'DEV'): StoryStore {
  const store = new StoryStore(root);
  mkdirSync(join(root, '.proof-or-stop', 'story', 'actives', storyId), { recursive: true });
  store.writeStory(storyId, {
    storyId,
    name: 'certification-window-smoke',
    title: 'Certification window smoke',
    description: 'Smoke test story',
    type: 'feature',
    phase,
    priority: 'high',
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    events: [],
  });
  acquireOwnerLease(store.storyDirPath(storyId), { command: 'fixture-owner', cwd: root });
  return store;
}

function persistCurrentFastCheapReceipt(store: StoryStore, root: string, storyId: string) {
  const receipt = signedFastCheapReceipt({
    storyId,
    headHash: currentGitHead(root)!,
    materialHash: currentMaterialHash(root, 'HEAD', root)!,
    storyFilesHash: currentStoryFilesHash(root, 'HEAD', root)!,
  });
  return persistPrecertCheapCheckReceipt({
    store,
    storyId,
    routineValidationIdentity: receipt.routineValidationIdentity,
    commandExecution: receipt.commandExecution,
    headHash: receipt.headHash,
    materialHash: receipt.materialHash,
    storyFilesHash: receipt.storyFilesHash,
  });
}

function countPrefix(text: string, prefix: string): number {
  return text.split('\n').filter(line => line.startsWith(prefix)).length;
}

function assertStatusSurface(text: string, state: string): void {
  assert.equal(countPrefix(text, 'State:'), 1, `expected exactly one State: line\n${text}`);
  assert.equal(countPrefix(text, 'Next:'), 1, `expected exactly one Next: line\n${text}`);
  assert.match(text, new RegExp(`^State: ${state}$`, 'm'));
  assert.match(text, /^Next: proof-or-stop /m);
  assert.ok(
    CERTIFICATION_WINDOW_STATES.includes(state as typeof CERTIFICATION_WINDOW_STATES[number]),
    `unknown state ${state}`,
  );
  assert.doesNotMatch(text, /inventory completeness is certification|inventory receipt authorizes certification/i);
}

const storyId = 'B-cw01';
const root = makeRoot();
const store = makeStore(root, storyId);
const handlers = createCertificationWindowHandlers({
  store,
  root,
  scanRoot: join(root, 'packages', 'main'),
});

const missingStatus = handlers.certification_window_status({ storyId });
assertStatusSurface(missingStatus, 'BLOCKED');
assert.doesNotMatch(missingStatus, /^headHash:/m);
assert.doesNotMatch(missingStatus, /^expectedMainSha:/m);
assert.doesNotMatch(missingStatus, /^storyFilesHash:/m);
assert.match(missingStatus, /\[pre_cert_window_missing\]/);

let beginOutput = '';
let beginFailed = false;
try {
  handlers.certification_window_begin({ storyId });
} catch (error) {
  beginFailed = true;
  beginOutput = error instanceof Error ? error.message : String(error);
}
assert.equal(beginFailed, true, 'begin must fail-closed when no finalized inventory receipt exists');
assertStatusSurface(beginOutput, 'BLOCKED');
assert.match(beginOutput, new RegExp(`\\[${PRE_CERT_INVENTORY_NOT_FINALIZED}\\]`));
assert.doesNotMatch(beginOutput, new RegExp(`\\[${PRE_CERT_INVENTORY_API_ABSENT}\\]`));
assert.match(beginOutput, /^Next: proof-or-stop review_inventory_finalize /m);
assert.doesNotMatch(beginOutput, /^State: ADMITTED$/m);
const productionApis = loadReviewInventoryAdmitApis();
assert.ok(productionApis, 'production loader must return the real inventory admit APIs');
assert.equal(typeof productionApis.finalizedUnconsumedReviewInventory, 'function');
assert.equal(typeof productionApis.consumeReviewInventoryCompletenessReceipt, 'function');
assert.equal(
  productionApis.consumeReviewInventoryCompletenessReceipt.name,
  'consumeReviewInventoryCompletenessReceipt',
  'production admit APIs must bind PRE_CERT completeness consume, not remediation consume',
);

const blockedStatus = handlers.certification_window_status({ storyId });
assertStatusSurface(blockedStatus, 'BLOCKED');
assert.doesNotMatch(blockedStatus, /^headHash:/m);
assert.doesNotMatch(blockedStatus, /^expectedMainSha:/m);
assert.doesNotMatch(blockedStatus, /^storyFilesHash:/m);

const blockedReuseStoryId = 'B-cw-blocked-reuse';
const blockedReuseStore = makeStore(root, blockedReuseStoryId);
const firstBlocked = persistBlockedCertificationWindow({
  store: blockedReuseStore,
  storyId: blockedReuseStoryId,
  blockerCode: PRE_CERT_INVENTORY_NOT_FINALIZED,
  blockerDetail: 'No FINALIZED unconsumed Review Inventory receipt is present.',
});
const reusedBlocked = persistBlockedCertificationWindow({
  store: blockedReuseStore,
  storyId: blockedReuseStoryId,
  blockerCode: PRE_CERT_INVENTORY_NOT_FINALIZED,
  blockerDetail: 'No FINALIZED unconsumed Review Inventory receipt is present.',
});
assert.equal(reusedBlocked.windowId, firstBlocked.windowId, 'same code+detail reuses the BLOCKED window');
assert.equal(blockedReuseStore.readCertificationWindows(blockedReuseStoryId).windows.length, 1);
const consumeFailedBlocked = persistBlockedCertificationWindow({
  store: blockedReuseStore,
  storyId: blockedReuseStoryId,
  blockerCode: PRE_CERT_INVENTORY_NOT_FINALIZED,
  blockerDetail: 'Inventory consume failed: REVIEW_INVENTORY_LIVE_AGGREGATE_CHANGED: final saturated wave is missing or invalid',
});
assert.notEqual(consumeFailedBlocked.windowId, firstBlocked.windowId, 'same code+new detail must not reuse the stale BLOCKED window');
assert.match(consumeFailedBlocked.blockerDetail ?? '', /Inventory consume failed/);
assert.equal(
  blockedReuseStore.readCertificationWindows(blockedReuseStoryId).windows.at(-1)?.blockerDetail,
  consumeFailedBlocked.blockerDetail,
  'latest BLOCKED window must surface the consume-failure detail',
);

const inventoryReceipt = {
  receiptId: 'INV-1',
  authority: 'inventory-completeness-only' as const,
  authorizesTest: false,
};
assert.equal(inventoryReceiptAuthorizesPrecert(inventoryReceipt), false);
assert.equal(inventoryReceiptAuthorizesPrecert({ authority: 'pre-cert', authorizesTest: true }), false);

const frozen = {
  headHash: 'a'.repeat(40),
  materialHash: 'b'.repeat(64),
  storyFilesHash: 'c'.repeat(64),
  expectedMainSha: 'd'.repeat(40),
  verifierIdentity: 'node:test-verifier',
  testIdentity: 'npm test',
};
const admittedStoryId = 'B-cw02';
const admittedStore = makeStore(root, admittedStoryId);
const admittedData = emptyCertificationWindowData();
const admittedWindow: CertificationWindow = withSignedCertificationWindow({
  schemaVersion: 'proofbound.certification_window.v1',
  windowId: `${admittedStoryId}:CW-001`,
  storyId: admittedStoryId,
  state: 'ADMITTED',
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
  frozen,
  receiptId: nextPrecertReceiptId(admittedData, admittedStoryId),
});
const admittedReceipt: PrecertReceipt = withSignedPrecertReceipt({
  schemaVersion: 'proofbound.precert_receipt.v1',
  receiptId: admittedWindow.receiptId!,
  windowId: admittedWindow.windowId,
  storyId: admittedStoryId,
  authority: 'pre-cert',
  authorizesHeavyCertification: true,
  frozen,
  createdAt: '2026-08-18T00:00:00.000Z',
});
assert.equal(verifyCertificationWindow(admittedWindow), true);
assert.equal(verifyPrecertReceipt(admittedReceipt), true);
assert.equal(windowAuthorizesHeavyCertification(admittedWindow, admittedReceipt), true);
admittedData.windows.push(admittedWindow);
admittedData.receipts.push(admittedReceipt);
admittedStore.writeCertificationWindows(admittedStoryId, admittedData);

const admittedHandlers = createCertificationWindowHandlers({
  store: admittedStore,
  root,
  scanRoot: join(root, 'packages', 'main'),
});
const admittedStatus = admittedHandlers.certification_window_status({ storyId: admittedStoryId });
assertStatusSurface(admittedStatus, 'ADMITTED');
assert.match(admittedStatus, new RegExp(`^headHash: ${frozen.headHash}$`, 'm'));
assert.match(admittedStatus, new RegExp(`^expectedMainSha: ${frozen.expectedMainSha}$`, 'm'));
assert.match(admittedStatus, new RegExp(`^storyFilesHash: ${frozen.storyFilesHash}$`, 'm'));

const inventoryAsWindowStoryId = 'B-cw03';
const inventoryStore = makeStore(root, inventoryAsWindowStoryId);
const inventoryData = emptyCertificationWindowData();
inventoryData.windows.push(withSignedCertificationWindow({
  schemaVersion: 'proofbound.certification_window.v1',
  windowId: `${inventoryAsWindowStoryId}:CW-001`,
  storyId: inventoryAsWindowStoryId,
  state: 'BLOCKED',
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
  inventory: {
    epochId: 'epoch-1',
    receiptId: inventoryReceipt.receiptId,
    authority: inventoryReceipt.authority,
    authorizesTest: inventoryReceipt.authorizesTest,
  },
  blockerCode: 'pre_cert_inventory_not_certification_authority',
  blockerDetail: 'FINALIZED inventory receipt is completeness-only',
}));
inventoryStore.writeCertificationWindows(inventoryAsWindowStoryId, inventoryData);
const inventoryHandlers = createCertificationWindowHandlers({
  store: inventoryStore,
  root,
  scanRoot: join(root, 'packages', 'main'),
});
const inventoryStatus = inventoryHandlers.certification_window_status({ storyId: inventoryAsWindowStoryId });
assertStatusSurface(inventoryStatus, 'BLOCKED');
assert.equal(
  windowAuthorizesHeavyCertification(inventoryData.windows[0], null),
  false,
  'inventory completeness receipt must not authorize heavy certification',
);

const tamperStoryId = 'B-cw04';
const tamperStore = makeStore(root, tamperStoryId);
const tamperData = emptyCertificationWindowData();
const signed = withSignedCertificationWindow({
  schemaVersion: 'proofbound.certification_window.v1',
  windowId: `${tamperStoryId}:CW-001`,
  storyId: tamperStoryId,
  state: 'ADMITTED',
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
  frozen,
  receiptId: 'tampered-receipt',
});
tamperData.windows.push(signed);
tamperStore.writeCertificationWindows(tamperStoryId, tamperData);
const filePath = join(root, '.proof-or-stop', 'story', 'actives', tamperStoryId, CERTIFICATION_WINDOW_FILE);
const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as { windows: Array<Record<string, unknown>> };
onDisk.windows[0].state = 'ADMITTED';
onDisk.windows[0].frozen = { ...frozen, headHash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' };
writeFileSync(filePath, `${JSON.stringify(onDisk, null, 2)}\n`);
const tamperHandlers = createCertificationWindowHandlers({
  store: tamperStore,
  root,
  scanRoot: join(root, 'packages', 'main'),
});
let tamperFailed = false;
let tamperOutput = '';
try {
  tamperHandlers.certification_window_status({ storyId: tamperStoryId });
} catch (error) {
  tamperFailed = true;
  tamperOutput = error instanceof Error ? error.message : String(error);
}
assert.equal(tamperFailed, true, 'tampered window must fail closed');
assert.match(tamperOutput, new RegExp(`\\[${PRE_CERT_WINDOW_TAMPERED}\\]`));
assert.doesNotMatch(tamperOutput, /^State: ADMITTED$/m);

const cancel = handlers.certification_window_cancel({ storyId, reason: 'operator cancelled the blocked window' });
assertStatusSurface(cancel, 'CANCELLED');

const rendered = renderCertificationWindowStatus(projectCertificationWindowStatus(storyId, null));
assertStatusSurface(rendered, 'BLOCKED');

const precertConsumerSet = 'done_required_validate / validate --full PRE_CERT certification-window gate / unscoped validate --story / runValidateGate / certification_window_begin';
for (const name of ['certification_window_begin', 'certification_window_status', 'certification_window_cancel']) {
  const level = PROCESS_FACT_LEVELS.find(entry => entry.name === name);
  assert.ok(level, `${name} missing from PROCESS_FACT_LEVELS`);
  assert.equal(level?.level, 'L4');
  assert.equal(level?.gateConsumer, precertConsumerSet);
  const policy = COMMAND_POLICIES[name as keyof typeof COMMAND_POLICIES];
  assert.equal(policy.status, 'gateEvidence');
  assert.equal(policy.gateEvidence, true);
  const registry = PROCESS_FACT_REGISTRY.find(entry => entry.name === name);
  assert.ok(registry, `${name} missing from PROCESS_FACT_REGISTRY`);
  assert.equal(registry?.level, 'L4');
  assert.equal(registry?.artifact?.path, 'certification-window.json');
  assert.equal(registry?.artifact?.signed, true);
  assert.equal(registry?.artifact?.consumerGate, precertConsumerSet);
  assert.ok(registry?.semantics.includes('signed-artifact'));
  assert.ok(registry?.semantics.includes('gate-evidence'));
}

function baseAdmitFacts(overrides: Partial<CertificationWindowAdmitFacts> = {}): CertificationWindowAdmitFacts {
  return {
    inventoryApisPresent: true,
    inventory: {
      epoch: {
        epochId: 'epoch-1',
        storyId: 'B-cw10',
        reviewRound: 'round-1',
        cutoff: { headHash: 'a'.repeat(40), materialHash: 'm'.repeat(64), storyFilesHash: 's'.repeat(64) },
      },
      receipt: {
        receiptId: 'INV-1',
        storyId: 'B-cw10',
        reviewRound: 'round-1',
        authority: INVENTORY_COMPLETENESS_AUTHORITY,
        authorizesTest: false,
        cutoff: { headHash: 'a'.repeat(40), materialHash: 'm'.repeat(64), storyFilesHash: 's'.repeat(64) },
      },
    },
    inventorySaturated: true,
    cheapCheckReceipt: signedFastCheapReceipt({
      storyId: 'B-cw10',
      headHash: 'a'.repeat(40),
      materialHash: 'm'.repeat(64),
      storyFilesHash: 's'.repeat(64),
    }),
    currentStoryId: 'B-cw10',
    headHash: 'a'.repeat(40),
    materialHash: 'm'.repeat(64),
    storyFilesHash: 's'.repeat(64),
    expectedMainSha: 'd'.repeat(40),
    mainIsAncestor: true,
    openBlockingFindingIds: [],
    missingRequiredIntents: 0,
    dirtyNonRuntimePaths: [],
    gitIndexReadable: true,
    evidenceTargetWritable: true,
    ...overrides,
  };
}

const admittedDecision = evaluateCertificationWindowAdmit(baseAdmitFacts());
assert.equal(admittedDecision.admit, true, 'full fact set must admit');

const missingCheapDecision = evaluateCertificationWindowAdmit(baseAdmitFacts({ cheapCheckReceipt: null }));
assert.equal(missingCheapDecision.admit, false);
assert.equal(missingCheapDecision.blockerCode, PRE_CERT_CHEAP_CHECK_REQUIRED);
assert.match(String(missingCheapDecision.blockerDetail), /validate --story=<id> --focus=fast --json/);

const tamperedCheap = baseAdmitFacts().cheapCheckReceipt!;
const tamperedCheapDecision = evaluateCertificationWindowAdmit(baseAdmitFacts({
  cheapCheckReceipt: { ...tamperedCheap, _hash: '0'.repeat(64) },
}));
assert.equal(tamperedCheapDecision.admit, false);
assert.equal(tamperedCheapDecision.blockerCode, PRE_CERT_CHEAP_CHECK_REQUIRED);

const failedCheapDecision = evaluateCertificationWindowAdmit(baseAdmitFacts({
  cheapCheckReceipt: withSignedPrecertCheapCheckReceipt({
    ...tamperedCheap,
    commandExecution: {
      ...tamperedCheap.commandExecution,
      status: 'FAIL',
      requiredFailureCount: 1,
      failureKind: 'validation_failure',
    },
  }),
}));
assert.equal(failedCheapDecision.admit, false);
assert.equal(failedCheapDecision.blockerCode, PRE_CERT_CHEAP_CHECK_REQUIRED);

const wrongFocusCheapDecision = evaluateCertificationWindowAdmit(baseAdmitFacts({
  cheapCheckReceipt: signedFastCheapReceipt({
    storyId: 'B-cw10',
    headHash: 'a'.repeat(40),
    materialHash: 'm'.repeat(64),
    storyFilesHash: 's'.repeat(64),
    focus: 'slow',
  }),
}));
assert.equal(wrongFocusCheapDecision.admit, false);
assert.equal(wrongFocusCheapDecision.blockerCode, PRE_CERT_CHEAP_CHECK_REQUIRED);

const fullCheapDecision = evaluateCertificationWindowAdmit(baseAdmitFacts({
  cheapCheckReceipt: signedFastCheapReceipt({
    storyId: 'B-cw10',
    headHash: 'a'.repeat(40),
    materialHash: 'm'.repeat(64),
    storyFilesHash: 's'.repeat(64),
    full: false,
  }),
}));
assert.equal(fullCheapDecision.admit, false);
assert.equal(fullCheapDecision.blockerCode, PRE_CERT_CHEAP_CHECK_REQUIRED);

const crossStoryCheapDecision = evaluateCertificationWindowAdmit(baseAdmitFacts({
  cheapCheckReceipt: signedFastCheapReceipt({
    storyId: 'B-other',
    headHash: 'a'.repeat(40),
    materialHash: 'm'.repeat(64),
    storyFilesHash: 's'.repeat(64),
  }),
}));
assert.equal(crossStoryCheapDecision.admit, false);
assert.equal(crossStoryCheapDecision.blockerCode, PRE_CERT_CHEAP_CHECK_REQUIRED);

const staleCheapDecision = evaluateCertificationWindowAdmit(baseAdmitFacts({
  cheapCheckReceipt: signedFastCheapReceipt({
    storyId: 'B-cw10',
    headHash: 'z'.repeat(40),
    materialHash: 'm'.repeat(64),
    storyFilesHash: 's'.repeat(64),
  }),
}));
assert.equal(staleCheapDecision.admit, false);
assert.equal(staleCheapDecision.blockerCode, PRE_CERT_CHEAP_CHECK_REQUIRED);

for (const [materialHash, storyFilesHash] of [
  ['z'.repeat(64), 's'.repeat(64)],
  ['m'.repeat(64), 'z'.repeat(64)],
]) {
  const driftDecision = evaluateCertificationWindowAdmit(baseAdmitFacts({
    cheapCheckReceipt: signedFastCheapReceipt({
      storyId: 'B-cw10',
      headHash: 'a'.repeat(40),
      materialHash,
      storyFilesHash,
    }),
  }));
  assert.equal(driftDecision.admit, false, 'materialHash/storyFilesHash cheap receipt drift must fail closed');
  assert.equal(driftDecision.blockerCode, PRE_CERT_CHEAP_CHECK_REQUIRED);
}

const missingApiDecision = evaluateCertificationWindowAdmit(baseAdmitFacts({ inventoryApisPresent: false }));
assert.equal(missingApiDecision.admit, false);
assert.equal(missingApiDecision.blockerCode, PRE_CERT_INVENTORY_NOT_FINALIZED);
assert.match(String(missingApiDecision.blockerDetail), new RegExp(`\\[${PRE_CERT_INVENTORY_API_ABSENT}\\]`));

const missingInventory = evaluateCertificationWindowAdmit(baseAdmitFacts({ inventory: null }));
assert.equal(missingInventory.admit, false);
assert.equal(missingInventory.blockerCode, PRE_CERT_INVENTORY_NOT_FINALIZED);

const completenessOnlyInventory = evaluateCertificationWindowAdmit(baseAdmitFacts({ inventorySaturated: false }));
assert.equal(completenessOnlyInventory.admit, false, 'a completeness-only receipt must never admit PRE_CERT');
assert.equal(completenessOnlyInventory.blockerCode, PRE_CERT_INVENTORY_NOT_FINALIZED);
assert.match(String(completenessOnlyInventory.blockerDetail), /saturated FINALIZED receipt/);

const wholeTreeDrift = evaluateCertificationWindowAdmit(baseAdmitFacts({
  materialHash: 'z'.repeat(64),
}));
assert.equal(wholeTreeDrift.admit, false, 'materialHash-only drift must not admit');
assert.equal(wholeTreeDrift.blockerCode, PRE_CERT_INVENTORY_NOT_FINALIZED);
assert.match(String(wholeTreeDrift.blockerDetail), /Whole-tree materialHash drift/);

const headLineageDrift = evaluateCertificationWindowAdmit(baseAdmitFacts({
  headHash: 'z'.repeat(40),
}));
assert.equal(headLineageDrift.admit, false, 'headHash drift must not reuse an inventory receipt');
assert.equal(headLineageDrift.blockerCode, PRE_CERT_INVENTORY_NOT_FINALIZED);
assert.match(String(headLineageDrift.blockerDetail), /current headHash lineage/);

const otherStoryInventory = evaluateCertificationWindowAdmit(baseAdmitFacts({
  inventory: {
    epoch: { epochId: 'epoch-x', storyId: 'B-other', cutoff: { materialHash: 'm'.repeat(64), storyFilesHash: 's'.repeat(64) } },
    receipt: { receiptId: 'INV-x', storyId: 'B-other', cutoff: { materialHash: 'm'.repeat(64), storyFilesHash: 's'.repeat(64) } },
  },
}));
assert.equal(otherStoryInventory.admit, false);
assert.equal(otherStoryInventory.blockerCode, PRE_CERT_INVENTORY_NOT_FINALIZED);

const findingsDecision = evaluateCertificationWindowAdmit(baseAdmitFacts({
  openBlockingFindingIds: ['B-cw10:F-001'],
}));
assert.equal(findingsDecision.admit, false);
assert.equal(findingsDecision.blockerCode, PRE_CERT_BLOCKING_FINDINGS_OPEN);

const coverageDecision = evaluateCertificationWindowAdmit(baseAdmitFacts({ missingRequiredIntents: 2 }));
assert.equal(coverageDecision.admit, false);
assert.equal(coverageDecision.blockerCode, PRE_CERT_COVERAGE_MISSING);
assert.equal(
  nextCommandForBlocker('B-cw-coverage', PRE_CERT_COVERAGE_MISSING),
  'proof-or-stop story_advance --storyId=B-cw-coverage --phase=DEV',
  'missing required coverage must return to DEV instead of suggesting a PRE_CERT-gated routine validate',
);

function coverageMissingAfterHeadDrift(args: {
  currentStoryFilesHash?: string;
  evidenceStoryFilesHash?: string;
}): number {
  return buildVerificationCoverage({
    items: [{
      id: 'CHK-001',
      title: 'headHash-only drift coverage',
      context: 'coverage remains admissible when storyFilesHash matches',
      status: 'done',
      startTime: null,
      endTime: null,
      verificationIntent: {
        happy: [{ desc: 'mechanical coverage stays fresh', type: 'logic', priority: 'must' }],
        edge: [],
        adversarial: [],
      },
      verificationEvidence: [{
        intentRef: 'CHK-001:happy:0',
        kind: 'logic_test',
        result: 'pass',
        note: 'headHash-only drift fixture',
        headHash: 'e'.repeat(40),
        ...(args.evidenceStoryFilesHash ? { storyFilesHash: args.evidenceStoryFilesHash } : {}),
      }],
    }],
  }, 'f'.repeat(40), (_evidenceHead, evidence) => {
    const recorded = evidence?.storyFilesHash;
    return Boolean(args.currentStoryFilesHash && recorded && recorded === args.currentStoryFilesHash);
  }).missingRequired;
}

const matchingStoryFilesMissing = coverageMissingAfterHeadDrift({
  currentStoryFilesHash: 's'.repeat(64),
  evidenceStoryFilesHash: 's'.repeat(64),
});
assert.equal(matchingStoryFilesMissing, 0, 'matching storyFilesHash must not count headHash-only drift as missing');
assert.equal(
  evaluateCertificationWindowAdmit(baseAdmitFacts({ missingRequiredIntents: matchingStoryFilesMissing })).admit,
  true,
  'evaluate must still admit when coverage evidence headHash differs but storyFilesHash matches',
);
assert.ok(
  coverageMissingAfterHeadDrift({ currentStoryFilesHash: 's'.repeat(64) }) > 0,
  'missing evidence storyFilesHash must stay missing/stale',
);
assert.ok(
  coverageMissingAfterHeadDrift({ evidenceStoryFilesHash: 's'.repeat(64) }) > 0,
  'missing current storyFilesHash must stay missing/stale',
);

const mainDecision = evaluateCertificationWindowAdmit(baseAdmitFacts({ mainIsAncestor: false }));
assert.equal(mainDecision.admit, false);
assert.equal(mainDecision.blockerCode, PRE_CERT_MAIN_NOT_MERGED);

const dirtyDecision = evaluateCertificationWindowAdmit(baseAdmitFacts({ dirtyNonRuntimePaths: ['src/foo.ts'] }));
assert.equal(dirtyDecision.admit, false);
assert.equal(dirtyDecision.blockerCode, PRE_CERT_DIRTY_TREE);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function makeGitRoot(): string {
  const gitRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-certification-window-git-'));
  git(gitRoot, ['init', '-b', 'main']);
  git(gitRoot, ['config', 'user.email', 'cert-window@example.test']);
  git(gitRoot, ['config', 'user.name', 'cert-window']);
  writeFileSync(join(gitRoot, 'proof-or-stop.config.json'), JSON.stringify({
    storyDir: '.proof-or-stop/story/actives',
    storyPrefix: 'B',
  }));
  writeFileSync(join(gitRoot, 'README.md'), 'certification window smoke\n');
  git(gitRoot, ['add', 'proof-or-stop.config.json', 'README.md']);
  git(gitRoot, ['commit', '-m', 'init']);
  return gitRoot;
}

function macosVarAliasPair(path: string): { aliasRoot: string; canonicalRoot: string } | null {
  if (process.platform !== 'darwin') return null;
  const canonicalRoot = realpathSync(path);
  if (!canonicalRoot.startsWith('/private/var/')) return null;
  const aliasRoot = canonicalRoot.replace(/^\/private\/var\//, '/var/');
  if (aliasRoot === canonicalRoot || !existsSync(aliasRoot) || realpathSync(aliasRoot) !== canonicalRoot) return null;
  return { aliasRoot, canonicalRoot };
}

function mockInventoryApis(args: {
  storyId: string;
  materialHash: string;
  storyFilesHash: string;
  headHash: string;
  otherStoryId?: string;
  driftedHeadHash?: string;
  driftedMaterialHash?: string;
  completenessOnly?: boolean;
  authority?: string;
  authorizesTest?: boolean;
  verifyEpoch?: boolean;
  verifyReceipt?: boolean;
  consumeError?: string;
  epochConsumed?: boolean;
  receiptConsumed?: boolean;
  receiptInvalidated?: boolean;
  downgradeOnConsume?: boolean;
  beforeConsumeContext?: () => void;
}): { apis: ReviewInventoryAdmitApis; consumed: string[] } {
  const consumed: string[] = [];
  const inventoryStoryId = args.otherStoryId ?? args.storyId;
  const headHash = args.driftedHeadHash ?? args.headHash;
  const materialHash = args.driftedMaterialHash ?? args.materialHash;
  let finalizedReadCount = 0;
  const pair = (completenessOnly: boolean) => {
    const requiredLanes = completenessOnly ? [] : ['lattice-review-contract', 'lattice-review-quality'];
    const finalWave = completenessOnly ? [] : [{
    lanes: requiredLanes.map(lane => ({
      lane,
      terminal: 'pass',
      evidenceIds: [`${lane}:PASS-001`],
      coverageDigest: `${lane}-coverage`,
    })),
    newVerifiedFindingCount: 0,
    criticDigest: 'critic-digest',
    saturated: true,
  }];
    return {
      epoch: {
        epochId: 'epoch-1',
        storyId: inventoryStoryId,
        reviewRound: 'round-1',
        state: 'FINALIZED',
        receiptId: 'INV-1',
        cutoff: { headHash, materialHash, storyFilesHash: args.storyFilesHash },
        requiredLanes,
        waves: finalWave,
        ...(args.epochConsumed ? { consumedAt: '2026-08-20T00:02:00.000Z' } : {}),
      },
      receipt: {
        receiptId: 'INV-1',
        epochId: 'epoch-1',
        storyId: inventoryStoryId,
        reviewRound: 'round-1',
        authority: args.authority ?? INVENTORY_COMPLETENESS_AUTHORITY,
        authorizesTest: args.authorizesTest ?? false,
        cutoff: { headHash, materialHash, storyFilesHash: args.storyFilesHash },
        requiredLanes,
        waveCount: finalWave.length,
        saturationResult: 'ZERO_NEW_VERIFIED_FINDINGS',
        scopeDigest: 'scope-digest',
        findingSetDigest: 'finding-set-digest',
        coverageDigest: 'coverage-digest',
        ...(args.receiptConsumed ? { consumedAt: '2026-08-20T00:02:00.000Z' } : {}),
        ...(args.receiptInvalidated ? { invalidatedAt: '2026-08-20T00:02:00.000Z' } : {}),
      },
    };
  };
  const apis: ReviewInventoryAdmitApis = {
    finalizedUnconsumedReviewInventory: () => pair(
      Boolean(args.completenessOnly || (args.downgradeOnConsume && finalizedReadCount++ > 0)),
    ),
    consumeReviewInventoryCompletenessReceipt: (_store, _storyId, _reviewRound, _cutoff, validateInventoryContext) => {
      args.beforeConsumeContext?.();
      validateInventoryContext?.();
      if (args.consumeError) throw new Error(args.consumeError);
      consumed.push('INV-1');
      return 'INV-1';
    },
    verifyReviewInventoryEpoch: () => args.verifyEpoch ?? true,
    verifyReviewInventoryReceipt: () => args.verifyReceipt ?? true,
    isInventoryCompletenessOnlyReceipt: (epoch) => (epoch as { requiredLanes?: string[] }).requiredLanes?.length === 0,
  };
  return { apis, consumed };
}

function beginCaught(handlers: ReturnType<typeof createCertificationWindowHandlers>, id: string): string {
  try {
    return handlers.certification_window_begin({ storyId: id });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function assertRejectedInventoryAdmission(args: {
  storyId: string;
  mock: Omit<Parameters<typeof mockInventoryApis>[0], 'storyId' | 'headHash' | 'materialHash' | 'storyFilesHash'>;
  detail: RegExp;
}): void {
  const rejectionRoot = makeGitRoot();
  const rejectionStore = makeStore(rejectionRoot, args.storyId);
  rejectionStore.writeChecklist(args.storyId, { items: [] });
  persistCurrentFastCheapReceipt(rejectionStore, rejectionRoot, args.storyId);
  const rejectionMock = mockInventoryApis({
    storyId: args.storyId,
    headHash: currentGitHead(rejectionRoot)!,
    materialHash: currentMaterialHash(rejectionRoot, 'HEAD', rejectionRoot)!,
    storyFilesHash: currentStoryFilesHash(rejectionRoot, 'HEAD', rejectionRoot)!,
    ...args.mock,
  });
  setReviewInventoryAdmitApisForTest(rejectionMock.apis);
  const rejectionOutput = beginCaught(createCertificationWindowHandlers({
    store: rejectionStore,
    root: rejectionRoot,
    scanRoot: join(rejectionRoot, 'packages', 'main'),
  }), args.storyId);
  assertStatusSurface(rejectionOutput, 'BLOCKED');
  assert.match(rejectionOutput, new RegExp(`\\[${PRE_CERT_INVENTORY_NOT_FINALIZED}\\]`));
  assert.match(rejectionOutput, args.detail);
  assert.equal(rejectionMock.consumed.length, 0, `${args.storyId} must not consume a rejected inventory receipt`);
  assert.equal(rejectionStore.readCertificationWindows(args.storyId).windows.at(-1)?.state, 'BLOCKED');
}

setReviewInventoryAdmitApisForTest(null);
const absentApiHandlers = createCertificationWindowHandlers({
  store,
  root,
  scanRoot: join(root, 'packages', 'main'),
});
const absentApiOutput = beginCaught(absentApiHandlers, 'B-cw23');
assertStatusSurface(absentApiOutput, 'BLOCKED');
assert.match(absentApiOutput, new RegExp(`\\[${PRE_CERT_INVENTORY_API_ABSENT}\\]`));
assert.doesNotMatch(absentApiOutput, /^State: ADMITTED$/m);
setReviewInventoryAdmitApisForTest(undefined);

setReviewInventoryAdmitApisForTest({
  finalizedUnconsumedReviewInventory: () => null,
  consumeReviewInventoryCompletenessReceipt: () => {
    throw new Error('consume must not run without a finalized inventory');
  },
  verifyReviewInventoryEpoch: () => {
    throw new Error('verification must not run without a finalized inventory');
  },
  verifyReviewInventoryReceipt: () => {
    throw new Error('verification must not run without a finalized inventory');
  },
  isInventoryCompletenessOnlyReceipt: () => {
    throw new Error('classification must not run without a finalized inventory');
  },
});
const noInventoryHandlers = createCertificationWindowHandlers({
  store,
  root,
  scanRoot: join(root, 'packages', 'main'),
});
const noInventoryOutput = beginCaught(noInventoryHandlers, 'B-cw11');
assertStatusSurface(noInventoryOutput, 'BLOCKED');
assert.match(noInventoryOutput, new RegExp(`\\[${PRE_CERT_INVENTORY_NOT_FINALIZED}\\]`));
assert.match(noInventoryOutput, /^Next: proof-or-stop review_inventory_finalize /m);
assert.doesNotMatch(noInventoryOutput, /^State: ADMITTED$/m);

const gitRoot = makeGitRoot();
const admitStoryId = 'B-cw12';
const admitStore = makeStore(gitRoot, admitStoryId);
admitStore.writeChecklist(admitStoryId, { items: [] });
persistCurrentFastCheapReceipt(admitStore, gitRoot, admitStoryId);
const admitHead = currentGitHead(gitRoot);
const admitMaterial = currentMaterialHash(gitRoot, 'HEAD', gitRoot);
const admitStoryFiles = currentStoryFilesHash(gitRoot, 'HEAD', gitRoot);
assert.ok(admitHead && admitMaterial && admitStoryFiles, 'git-backed hashes must resolve');
const admitMock = mockInventoryApis({
  storyId: admitStoryId,
  headHash: admitHead!,
  materialHash: admitMaterial,
  storyFilesHash: admitStoryFiles,
});
setReviewInventoryAdmitApisForTest(admitMock.apis);
const admitHandlers = createCertificationWindowHandlers({
  store: admitStore,
  root: gitRoot,
  scanRoot: join(gitRoot, 'packages', 'main'),
});
const admittedBegin = admitHandlers.certification_window_begin({ storyId: admitStoryId });
assertStatusSurface(admittedBegin, 'ADMITTED');
assert.match(admittedBegin, new RegExp(`^Next: proof-or-stop validate --story=${admitStoryId} --json$`, 'm'));
assert.doesNotMatch(admittedBegin, /done_required_validate/, 'an admitted window must direct the single REVIEW routine validate, not DONE-required validation');
assert.match(admittedBegin, new RegExp(`^headHash: ${admitHead}$`, 'm'));
assert.match(admittedBegin, /^expectedMainSha: /m);
assert.match(admittedBegin, new RegExp(`^storyFilesHash: ${admitStoryFiles}$`, 'm'));
assert.deepEqual(admitMock.consumed, ['INV-1']);
const admittedOnDisk = admitStore.readCertificationWindows(admitStoryId);
assert.equal(admittedOnDisk.windows.at(-1)?.inventory?.epochId, 'epoch-1');
assert.equal(admittedOnDisk.windows.at(-1)?.inventory?.receiptId, 'INV-1');
assert.equal(admittedOnDisk.windows.at(-1)?.inventory?.authorizesTest, false, 'inventory remains completeness-only after PRE_CERT admission');

assertRejectedInventoryAdmission({
  storyId: 'B-cw-saturated-fallback',
  mock: { completenessOnly: true },
  detail: /saturated FINALIZED receipt/,
});
assertRejectedInventoryAdmission({
  storyId: 'B-cw-signed-tamper',
  mock: { verifyReceipt: false },
  detail: /saturated FINALIZED receipt/,
});
assertRejectedInventoryAdmission({
  storyId: 'B-cw-consumed-inventory',
  mock: { epochConsumed: true, receiptConsumed: true },
  detail: /saturated FINALIZED receipt/,
});
assertRejectedInventoryAdmission({
  storyId: 'B-cw-invalidated-inventory',
  mock: { receiptInvalidated: true },
  detail: /saturated FINALIZED receipt/,
});
assertRejectedInventoryAdmission({
  storyId: 'B-cw-forged-authority',
  mock: { authority: 'pre-cert', authorizesTest: true },
  detail: /saturated FINALIZED receipt/,
});
assertRejectedInventoryAdmission({
  storyId: 'B-cw-live-aggregate-drift',
  mock: { consumeError: 'REVIEW_INVENTORY_LIVE_AGGREGATE_CHANGED: final saturated wave is missing or invalid' },
  detail: /Inventory consume failed: REVIEW_INVENTORY_LIVE_AGGREGATE_CHANGED/,
});
assertRejectedInventoryAdmission({
  storyId: 'B-cw-consume-time-downgrade',
  mock: { downgradeOnConsume: true },
  detail: /Inventory consume failed: REVIEW_INVENTORY_PRE_CERT_BLOCKED/,
});

const consumeHeadRaceRoot = makeGitRoot();
const consumeHeadRaceStoryId = 'B-cw-consume-head-race';
const consumeHeadRaceStore = makeStore(consumeHeadRaceRoot, consumeHeadRaceStoryId);
consumeHeadRaceStore.writeChecklist(consumeHeadRaceStoryId, { items: [] });
const consumeHeadRaceBefore = {
  headHash: currentGitHead(consumeHeadRaceRoot)!,
  materialHash: currentMaterialHash(consumeHeadRaceRoot, 'HEAD', consumeHeadRaceRoot)!,
  storyFilesHash: currentStoryFilesHash(consumeHeadRaceRoot, 'HEAD', consumeHeadRaceRoot)!,
};
const consumeHeadRaceMock = mockInventoryApis({
  storyId: consumeHeadRaceStoryId,
  ...consumeHeadRaceBefore,
  beforeConsumeContext: () => {
    const metadataPath = join(
      consumeHeadRaceRoot,
      '.proof-or-stop',
      'story',
      'actives',
      consumeHeadRaceStoryId,
      'consume-head-race.json',
    );
    mkdirSync(dirname(metadataPath), { recursive: true });
    writeFileSync(metadataPath, '{"race":"head-only"}\n');
    git(consumeHeadRaceRoot, ['add', metadataPath]);
    git(consumeHeadRaceRoot, ['commit', '-m', 'metadata-only consume race']);
  },
});
setReviewInventoryAdmitApisForTest(consumeHeadRaceMock.apis);
persistCurrentFastCheapReceipt(consumeHeadRaceStore, consumeHeadRaceRoot, consumeHeadRaceStoryId);
const consumeHeadRaceOutput = beginCaught(createCertificationWindowHandlers({
  store: consumeHeadRaceStore,
  root: consumeHeadRaceRoot,
  scanRoot: join(consumeHeadRaceRoot, 'packages', 'main'),
}), consumeHeadRaceStoryId);
assertStatusSurface(consumeHeadRaceOutput, 'BLOCKED');
assert.match(
  consumeHeadRaceOutput,
  /Inventory consume failed: REVIEW_INVENTORY_PRE_CERT_BLOCKED: current certification identity changed before inventory consume/,
);
assert.equal(consumeHeadRaceMock.consumed.length, 0, 'head-only drift beneath the consume lock must refuse before consumption');
assert.notEqual(currentGitHead(consumeHeadRaceRoot), consumeHeadRaceBefore.headHash, 'race must advance only headHash');
assert.equal(
  currentMaterialHash(consumeHeadRaceRoot, 'HEAD', consumeHeadRaceRoot),
  consumeHeadRaceBefore.materialHash,
  'metadata-only race must retain materialHash',
);
assert.equal(
  currentStoryFilesHash(consumeHeadRaceRoot, 'HEAD', consumeHeadRaceRoot),
  consumeHeadRaceBefore.storyFilesHash,
  'metadata-only race must retain storyFilesHash',
);

// REVIEW pass/finding metadata is normally committed after its frozen
// inventory cutoff. That exact runtime-authored, story-local linear chain is
// admissible at begin, while a lookalike commit stays outside the exception.
const continuitySeedRoot = makeGitRoot();
const continuityAliasPair = macosVarAliasPair(continuitySeedRoot);
if (process.platform === 'darwin') {
  assert.ok(continuityAliasPair, 'macOS smoke must exercise the real /var -> /private/var alias pair');
}
const continuityRoot = continuityAliasPair?.canonicalRoot ?? continuitySeedRoot;
const continuityMetadataRoot = continuityAliasPair?.aliasRoot ?? continuityRoot;
const continuityStoryId = 'B-cw-review-metadata-continuity';
const continuityStore = makeStore(continuityMetadataRoot, continuityStoryId);
if (continuityAliasPair) {
  const lexicalStoryRel = relative(continuityRoot, continuityStore.storyDirPath(continuityStoryId)).replaceAll('\\', '/');
  assert.ok(
    lexicalStoryRel.startsWith('../'),
    'the /var metadata alias must look outside the /private/var git root to a lexical-only continuity check',
  );
}
continuityStore.writeChecklist(continuityStoryId, { items: [] });
const continuityBefore = {
  headHash: currentGitHead(continuityRoot)!,
  materialHash: currentMaterialHash(continuityRoot, 'HEAD', continuityRoot)!,
  storyFilesHash: currentStoryFilesHash(continuityRoot, 'HEAD', continuityRoot)!,
};
const continuityMetadataPath = join(
  continuityMetadataRoot,
  '.proof-or-stop',
  'story',
  'actives',
  continuityStoryId,
  'review-passes.json',
);
writeFileSync(continuityMetadataPath, '{"runtime":"review-pass"}\n');
git(continuityRoot, ['add', `.proof-or-stop/story/actives/${continuityStoryId}/review-passes.json`]);
git(continuityRoot, ['commit', '-m', `proof-or-stop: record ${continuityStoryId} review_pass_set metadata`]);
assert.notEqual(currentGitHead(continuityRoot), continuityBefore.headHash, 'canonical review metadata must advance HEAD');
assert.equal(currentMaterialHash(continuityRoot, 'HEAD', continuityRoot), continuityBefore.materialHash);
assert.equal(currentStoryFilesHash(continuityRoot, 'HEAD', continuityRoot), continuityBefore.storyFilesHash);
const continuityMock = mockInventoryApis({ storyId: continuityStoryId, ...continuityBefore });
setReviewInventoryAdmitApisForTest(continuityMock.apis);
persistCurrentFastCheapReceipt(continuityStore, continuityRoot, continuityStoryId);
const continuityOutput = beginCaught(createCertificationWindowHandlers({
  store: continuityStore,
  root: continuityRoot,
  scanRoot: join(continuityRoot, 'packages', 'main'),
}), continuityStoryId);
assertStatusSurface(continuityOutput, 'ADMITTED');
assert.equal(continuityMock.consumed.length, 1, 'only the verified REVIEW metadata bridge may consume inventory');
if (continuityAliasPair) {
  assert.match(continuityOutput, /^State: ADMITTED$/m, 'canonical path continuity must admit the /var metadata alias');
}

// A completed inventory normally adds its own epoch/critic/wave/finalization
// metadata alongside reviewer evidence after the frozen cutoff. Review runs
// are part of that exact chain too: every terminal pass is bound to a current
// ReviewRun, so a saturated four-lane inventory necessarily contains the
// reviewer-run commits before its pass/critic/finalization commits. Every one
// of those exact runtime-written subjects is admissible, but the set is closed.
const inventoryContinuityRoot = makeGitRoot();
const inventoryContinuityStoryId = 'B-cw-inventory-metadata-continuity';
git(inventoryContinuityRoot, ['checkout', '-b', `story/${inventoryContinuityStoryId}`]);
const inventoryContinuityStore = makeStore(inventoryContinuityRoot, inventoryContinuityStoryId);
inventoryContinuityStore.writeChecklist(inventoryContinuityStoryId, { items: [] });
const inventoryContinuityBefore = {
  headHash: currentGitHead(inventoryContinuityRoot)!,
  materialHash: currentMaterialHash(inventoryContinuityRoot, 'HEAD', inventoryContinuityRoot)!,
  storyFilesHash: currentStoryFilesHash(inventoryContinuityRoot, 'HEAD', inventoryContinuityRoot)!,
};
const inventoryContinuityReasons = [
  'review_inventory_begin',
  'review_run_start',
  'review_pass_set',
  'review_pass_set',
  'review_pass_set',
  'review_pass_set',
  'review_run_start',
  'review_pass_set',
  'review_inventory_critic_set',
  'review_inventory_finalize',
];
for (const [index, reason] of inventoryContinuityReasons.entries()) {
  writeFileSync(
    join(inventoryContinuityRoot, '.proof-or-stop', 'story', 'actives', inventoryContinuityStoryId, `inventory-chain-${index}.json`),
    JSON.stringify({ reason, index }),
  );
  const commitHint = autoCommitStoryMetadata(inventoryContinuityRoot, inventoryContinuityStoryId, reason);
  assert.match(
    commitHint,
    new RegExp(`record ${inventoryContinuityStoryId} ${reason} metadata`),
    `${reason} must use the canonical runtime metadata subject`,
  );
}
assert.notEqual(currentGitHead(inventoryContinuityRoot), inventoryContinuityBefore.headHash);
assert.equal(
  currentMaterialHash(inventoryContinuityRoot, 'HEAD', inventoryContinuityRoot),
  inventoryContinuityBefore.materialHash,
  'the completed inventory metadata chain must remain head-only drift',
);
assert.equal(
  currentStoryFilesHash(inventoryContinuityRoot, 'HEAD', inventoryContinuityRoot),
  inventoryContinuityBefore.storyFilesHash,
  'the completed inventory metadata chain must remain outside story-owned source material',
);
const inventoryContinuityMock = mockInventoryApis({ storyId: inventoryContinuityStoryId, ...inventoryContinuityBefore });
setReviewInventoryAdmitApisForTest(inventoryContinuityMock.apis);
persistCurrentFastCheapReceipt(inventoryContinuityStore, inventoryContinuityRoot, inventoryContinuityStoryId);
const inventoryContinuityOutput = beginCaught(createCertificationWindowHandlers({
  store: inventoryContinuityStore,
  root: inventoryContinuityRoot,
  scanRoot: join(inventoryContinuityRoot, 'packages', 'main'),
}), inventoryContinuityStoryId);
assertStatusSurface(inventoryContinuityOutput, 'ADMITTED');
assert.equal(
  inventoryContinuityMock.consumed.length,
  1,
  'the canonical completed-inventory metadata chain must bridge a FINALIZED cutoff into PRE_CERT',
);

// A merge commit must never reuse that otherwise-valid metadata bridge. Even
// when every reachable commit carries a canonical story-local runtime subject,
// PRE_CERT admits only the unmerged linear chain after the frozen inventory
// cutoff. This is a real two-parent Git merge, rather than a synthetic parent
// list, so the continuity check exercises the repository proof boundary.
const mergedInventoryRoot = makeGitRoot();
const mergedInventoryStoryId = 'B-cw-inventory-metadata-merged-lineage';
git(mergedInventoryRoot, ['checkout', '-b', `story/${mergedInventoryStoryId}`]);
const mergedInventoryStore = makeStore(mergedInventoryRoot, mergedInventoryStoryId);
mergedInventoryStore.writeChecklist(mergedInventoryStoryId, { items: [] });
const mergedInventoryBefore = {
  headHash: currentGitHead(mergedInventoryRoot)!,
  materialHash: currentMaterialHash(mergedInventoryRoot, 'HEAD', mergedInventoryRoot)!,
  storyFilesHash: currentStoryFilesHash(mergedInventoryRoot, 'HEAD', mergedInventoryRoot)!,
};
for (const [index, reason] of inventoryContinuityReasons.entries()) {
  writeFileSync(
    join(mergedInventoryRoot, '.proof-or-stop', 'story', 'actives', mergedInventoryStoryId, `linear-chain-${index}.json`),
    JSON.stringify({ reason, index }),
  );
  autoCommitStoryMetadata(mergedInventoryRoot, mergedInventoryStoryId, reason);
}
git(mergedInventoryRoot, ['checkout', '-b', `${mergedInventoryStoryId}-reviewer-side`]);
writeFileSync(
  join(mergedInventoryRoot, '.proof-or-stop', 'story', 'actives', mergedInventoryStoryId, 'reviewer-side.json'),
  '{"runtime":"review-pass-side"}\n',
);
const mergedInventorySidePath = `.proof-or-stop/story/actives/${mergedInventoryStoryId}/reviewer-side.json`;
git(mergedInventoryRoot, ['add', mergedInventorySidePath]);
git(
  mergedInventoryRoot,
  ['commit', '-m', `proof-or-stop: record ${mergedInventoryStoryId} review_pass_set metadata`],
);
git(mergedInventoryRoot, ['checkout', `story/${mergedInventoryStoryId}`]);
git(
  mergedInventoryRoot,
  ['merge', '--no-ff', `${mergedInventoryStoryId}-reviewer-side`, '-m', `proof-or-stop: record ${mergedInventoryStoryId} review_inventory_finalize metadata`],
);
assert.equal(
  git(mergedInventoryRoot, ['show', '-s', '--format=%P', 'HEAD']).split(/\s+/).filter(Boolean).length,
  2,
  'the post-cutoff metadata lineage fixture must contain a genuine two-parent merge commit',
);
const mergedInventoryMock = mockInventoryApis({ storyId: mergedInventoryStoryId, ...mergedInventoryBefore });
setReviewInventoryAdmitApisForTest(mergedInventoryMock.apis);
persistCurrentFastCheapReceipt(mergedInventoryStore, mergedInventoryRoot, mergedInventoryStoryId);
const mergedInventoryOutput = beginCaught(createCertificationWindowHandlers({
  store: mergedInventoryStore,
  root: mergedInventoryRoot,
  scanRoot: join(mergedInventoryRoot, 'packages', 'main'),
}), mergedInventoryStoryId);
assertStatusSurface(mergedInventoryOutput, 'BLOCKED');
assert.match(mergedInventoryOutput, new RegExp(`\\[${PRE_CERT_INVENTORY_NOT_FINALIZED}\\]`));
assert.match(mergedInventoryOutput, /current headHash lineage/);
assert.equal(
  mergedInventoryMock.consumed.length,
  0,
  'a two-parent merge after the canonical metadata lineage must not consume the inventory receipt',
);

const forgedInventoryReasonRoot = makeGitRoot();
const forgedInventoryReasonStoryId = 'B-cw-inventory-metadata-forged-reason';
const forgedInventoryReasonStore = makeStore(forgedInventoryReasonRoot, forgedInventoryReasonStoryId);
forgedInventoryReasonStore.writeChecklist(forgedInventoryReasonStoryId, { items: [] });
const forgedInventoryReasonBefore = {
  headHash: currentGitHead(forgedInventoryReasonRoot)!,
  materialHash: currentMaterialHash(forgedInventoryReasonRoot, 'HEAD', forgedInventoryReasonRoot)!,
  storyFilesHash: currentStoryFilesHash(forgedInventoryReasonRoot, 'HEAD', forgedInventoryReasonRoot)!,
};
const forgedInventoryReasonPath = `.proof-or-stop/story/actives/${forgedInventoryReasonStoryId}/forged-inventory.json`;
writeFileSync(join(forgedInventoryReasonRoot, forgedInventoryReasonPath), '{"forged":true}\n');
git(forgedInventoryReasonRoot, ['add', forgedInventoryReasonPath]);
git(
  forgedInventoryReasonRoot,
  ['commit', '-m', `proof-or-stop: record ${forgedInventoryReasonStoryId} review_inventory_finalize_extra metadata`],
);
const forgedInventoryReasonMock = mockInventoryApis({
  storyId: forgedInventoryReasonStoryId,
  ...forgedInventoryReasonBefore,
});
setReviewInventoryAdmitApisForTest(forgedInventoryReasonMock.apis);
persistCurrentFastCheapReceipt(forgedInventoryReasonStore, forgedInventoryReasonRoot, forgedInventoryReasonStoryId);
const forgedInventoryReasonOutput = beginCaught(createCertificationWindowHandlers({
  store: forgedInventoryReasonStore,
  root: forgedInventoryReasonRoot,
  scanRoot: join(forgedInventoryReasonRoot, 'packages', 'main'),
}), forgedInventoryReasonStoryId);
assertStatusSurface(forgedInventoryReasonOutput, 'BLOCKED');
assert.match(forgedInventoryReasonOutput, /current headHash lineage/);
assert.equal(
  forgedInventoryReasonMock.consumed.length,
  0,
  'a canonical-prefix inventory lookalike must not forge the closed PRE_CERT metadata bridge',
);

const lookalikeRoot = makeGitRoot();
const lookalikeStoryId = 'B-cw-review-metadata-lookalike';
const lookalikeStore = makeStore(lookalikeRoot, lookalikeStoryId);
lookalikeStore.writeChecklist(lookalikeStoryId, { items: [] });
const lookalikeBefore = {
  headHash: currentGitHead(lookalikeRoot)!,
  materialHash: currentMaterialHash(lookalikeRoot, 'HEAD', lookalikeRoot)!,
  storyFilesHash: currentStoryFilesHash(lookalikeRoot, 'HEAD', lookalikeRoot)!,
};
const lookalikeMetadataPath = join(
  lookalikeRoot,
  '.proof-or-stop',
  'story',
  'actives',
  lookalikeStoryId,
  'note.json',
);
writeFileSync(lookalikeMetadataPath, '{"lookalike":true}\n');
git(lookalikeRoot, ['add', `.proof-or-stop/story/actives/${lookalikeStoryId}/note.json`]);
git(lookalikeRoot, ['commit', '-m', 'metadata-only review note']);
assert.equal(currentMaterialHash(lookalikeRoot, 'HEAD', lookalikeRoot), lookalikeBefore.materialHash);
assert.equal(currentStoryFilesHash(lookalikeRoot, 'HEAD', lookalikeRoot), lookalikeBefore.storyFilesHash);
const lookalikeMock = mockInventoryApis({ storyId: lookalikeStoryId, ...lookalikeBefore });
setReviewInventoryAdmitApisForTest(lookalikeMock.apis);
persistCurrentFastCheapReceipt(lookalikeStore, lookalikeRoot, lookalikeStoryId);
const lookalikeOutput = beginCaught(createCertificationWindowHandlers({
  store: lookalikeStore,
  root: lookalikeRoot,
  scanRoot: join(lookalikeRoot, 'packages', 'main'),
}), lookalikeStoryId);
assertStatusSurface(lookalikeOutput, 'BLOCKED');
assert.match(lookalikeOutput, /current headHash lineage/);
assert.equal(lookalikeMock.consumed.length, 0, 'an arbitrary metadata commit must not forge the REVIEW bridge');

const crossStoryRoot = makeGitRoot();
const crossStoryId = 'B-cw-review-metadata-cross-story';
const crossStoryStore = makeStore(crossStoryRoot, crossStoryId);
crossStoryStore.writeChecklist(crossStoryId, { items: [] });
const crossStoryBefore = {
  headHash: currentGitHead(crossStoryRoot)!,
  materialHash: currentMaterialHash(crossStoryRoot, 'HEAD', crossStoryRoot)!,
  storyFilesHash: currentStoryFilesHash(crossStoryRoot, 'HEAD', crossStoryRoot)!,
};
const otherStoryId = 'B-cw-unrelated-metadata';
const otherStoryMetadataPath = join(crossStoryRoot, '.proof-or-stop', 'story', 'actives', otherStoryId, 'review-passes.json');
mkdirSync(dirname(otherStoryMetadataPath), { recursive: true });
writeFileSync(otherStoryMetadataPath, '{"crossStory":true}\n');
git(crossStoryRoot, ['add', `.proof-or-stop/story/actives/${otherStoryId}/review-passes.json`]);
git(crossStoryRoot, ['commit', '-m', `proof-or-stop: record ${crossStoryId} review_pass_set metadata`]);
assert.equal(currentMaterialHash(crossStoryRoot, 'HEAD', crossStoryRoot), crossStoryBefore.materialHash);
assert.equal(currentStoryFilesHash(crossStoryRoot, 'HEAD', crossStoryRoot), crossStoryBefore.storyFilesHash);
const crossStoryMock = mockInventoryApis({ storyId: crossStoryId, ...crossStoryBefore });
setReviewInventoryAdmitApisForTest(crossStoryMock.apis);
persistCurrentFastCheapReceipt(crossStoryStore, crossStoryRoot, crossStoryId);
const crossStoryOutput = beginCaught(createCertificationWindowHandlers({
  store: crossStoryStore,
  root: crossStoryRoot,
  scanRoot: join(crossStoryRoot, 'packages', 'main'),
}), crossStoryId);
assertStatusSurface(crossStoryOutput, 'BLOCKED');
assert.match(crossStoryOutput, /current headHash lineage/);
assert.equal(crossStoryMock.consumed.length, 0, 'a canonical-looking commit for another story must not bridge this inventory');

assertRejectedInventoryAdmission({
  storyId: 'B-cw-head-lineage-drift',
  mock: { driftedHeadHash: 'f'.repeat(40) },
  detail: /current headHash lineage/,
});

const malformedApiRoot = makeGitRoot();
const malformedApiStoryId = 'B-cw-malformed-api';
const malformedApiStore = makeStore(malformedApiRoot, malformedApiStoryId);
malformedApiStore.writeChecklist(malformedApiStoryId, { items: [] });
const malformedApi = mockInventoryApis({
  storyId: malformedApiStoryId,
  headHash: currentGitHead(malformedApiRoot)!,
  materialHash: currentMaterialHash(malformedApiRoot, 'HEAD', malformedApiRoot)!,
  storyFilesHash: currentStoryFilesHash(malformedApiRoot, 'HEAD', malformedApiRoot)!,
}).apis as Partial<ReviewInventoryAdmitApis>;
delete malformedApi.verifyReviewInventoryEpoch;
setReviewInventoryAdmitApisForTest(malformedApi as ReviewInventoryAdmitApis);
const malformedApiOutput = beginCaught(createCertificationWindowHandlers({
  store: malformedApiStore,
  root: malformedApiRoot,
  scanRoot: join(malformedApiRoot, 'packages', 'main'),
}), malformedApiStoryId);
assertStatusSurface(malformedApiOutput, 'BLOCKED');
assert.match(malformedApiOutput, new RegExp(`\\[${PRE_CERT_INVENTORY_NOT_FINALIZED}\\]`));
assert.match(malformedApiOutput, /saturated FINALIZED receipt/);
assert.equal(malformedApiStore.readCertificationWindows(malformedApiStoryId).windows.at(-1)?.state, 'BLOCKED');

const headDriftRoot = makeGitRoot();
const headDriftStoryId = 'B-cw24';
const headDriftStore = makeStore(headDriftRoot, headDriftStoryId);
const headDriftStoryFiles = currentStoryFilesHash(headDriftRoot, 'HEAD', headDriftRoot)!;
headDriftStore.writeChecklist(headDriftStoryId, {
  items: [{
    id: 'CHK-001',
    title: 'headHash-only drift coverage',
    context: 'collectAdmitFacts must not treat matching storyFilesHash as missing',
    status: 'done',
    startTime: null,
    endTime: null,
    verificationIntent: {
      happy: [{ desc: 'mechanical coverage stays fresh', type: 'logic', priority: 'must' }],
      edge: [],
      adversarial: [],
    },
    verificationEvidence: [{
      intentRef: 'CHK-001:happy:0',
      kind: 'logic_test',
      result: 'pass',
      note: 'headHash-only drift fixture',
      headHash: 'e'.repeat(40),
      storyFilesHash: headDriftStoryFiles,
    }],
  }],
});
const headDriftMock = mockInventoryApis({
  storyId: headDriftStoryId,
  headHash: currentGitHead(headDriftRoot)!,
  materialHash: currentMaterialHash(headDriftRoot, 'HEAD', headDriftRoot)!,
  storyFilesHash: headDriftStoryFiles,
});
setReviewInventoryAdmitApisForTest(headDriftMock.apis);
persistCurrentFastCheapReceipt(headDriftStore, headDriftRoot, headDriftStoryId);
const headDriftHandlers = createCertificationWindowHandlers({
  store: headDriftStore,
  root: headDriftRoot,
  scanRoot: join(headDriftRoot, 'packages', 'main'),
});
const headDriftBegin = headDriftHandlers.certification_window_begin({ storyId: headDriftStoryId });
assertStatusSurface(headDriftBegin, 'ADMITTED');
assert.equal(headDriftMock.consumed.length, 1, 'matching storyFilesHash must admit even when evidence headHash differs');
assert.equal(
  headDriftStore.readCertificationWindows(headDriftStoryId).windows.at(-1)?.inventory?.authorizesTest,
  false,
);

const unmergedRoot = makeGitRoot();
git(unmergedRoot, ['checkout', '-b', 'story/B-cw13']);
git(unmergedRoot, ['checkout', 'main']);
writeFileSync(join(unmergedRoot, 'README.md'), 'main moved ahead\n');
git(unmergedRoot, ['add', 'README.md']);
git(unmergedRoot, ['commit', '-m', 'main ahead']);
git(unmergedRoot, ['checkout', 'story/B-cw13']);
const unmergedStoryId = 'B-cw13';
const unmergedStore = makeStore(unmergedRoot, unmergedStoryId);
unmergedStore.writeChecklist(unmergedStoryId, { items: [] });
const unmergedMock = mockInventoryApis({
  storyId: unmergedStoryId,
  headHash: currentGitHead(unmergedRoot)!,
  materialHash: currentMaterialHash(unmergedRoot, 'HEAD', unmergedRoot)!,
  storyFilesHash: currentStoryFilesHash(unmergedRoot, 'HEAD', unmergedRoot)!,
});
setReviewInventoryAdmitApisForTest(unmergedMock.apis);
persistCurrentFastCheapReceipt(unmergedStore, unmergedRoot, unmergedStoryId);
const unmergedHandlers = createCertificationWindowHandlers({
  store: unmergedStore,
  root: unmergedRoot,
  scanRoot: join(unmergedRoot, 'packages', 'main'),
});
const unmergedOutput = beginCaught(unmergedHandlers, unmergedStoryId);
assertStatusSurface(unmergedOutput, 'BLOCKED');
assert.match(unmergedOutput, new RegExp(`\\[${PRE_CERT_MAIN_NOT_MERGED}\\]`));
assert.match(unmergedOutput, /^Next: proof-or-stop done_prepare /m);
assert.equal(unmergedMock.consumed.length, 0);

const findingRoot = makeGitRoot();
const findingStoryId = 'B-cw14';
const findingStore = makeStore(findingRoot, findingStoryId);
findingStore.writeChecklist(findingStoryId, { items: [] });
findingStore.writeFindings(findingStoryId, {
  findings: [{
    id: `${findingStoryId}:F-001`,
    desc: 'open verified blocker',
    severity: 'critical',
    category: 'missing',
    status: 'open',
    evidenceState: 'verified',
  }],
});
const findingMock = mockInventoryApis({
  storyId: findingStoryId,
  headHash: currentGitHead(findingRoot)!,
  materialHash: currentMaterialHash(findingRoot, 'HEAD', findingRoot)!,
  storyFilesHash: currentStoryFilesHash(findingRoot, 'HEAD', findingRoot)!,
});
setReviewInventoryAdmitApisForTest(findingMock.apis);
persistCurrentFastCheapReceipt(findingStore, findingRoot, findingStoryId);
const findingHandlers = createCertificationWindowHandlers({
  store: findingStore,
  root: findingRoot,
  scanRoot: join(findingRoot, 'packages', 'main'),
});
const findingOutput = beginCaught(findingHandlers, findingStoryId);
assertStatusSurface(findingOutput, 'BLOCKED');
assert.match(findingOutput, new RegExp(`\\[${PRE_CERT_BLOCKING_FINDINGS_OPEN}\\]`));
assert.match(findingOutput, /^Next: proof-or-stop finding_list /m);
assert.equal(findingMock.consumed.length, 0);

const dirtyRoot = makeGitRoot();
const dirtyStoryId = 'B-cw15';
const dirtyStore = makeStore(dirtyRoot, dirtyStoryId);
dirtyStore.writeChecklist(dirtyStoryId, { items: [] });
writeFileSync(join(dirtyRoot, 'oops.txt'), 'non-runtime dirty');
const dirtyMock = mockInventoryApis({
  storyId: dirtyStoryId,
  headHash: currentGitHead(dirtyRoot)!,
  materialHash: currentMaterialHash(dirtyRoot, 'HEAD', dirtyRoot)!,
  storyFilesHash: currentStoryFilesHash(dirtyRoot, 'HEAD', dirtyRoot)!,
});
setReviewInventoryAdmitApisForTest(dirtyMock.apis);
persistCurrentFastCheapReceipt(dirtyStore, dirtyRoot, dirtyStoryId);
const dirtyHandlers = createCertificationWindowHandlers({
  store: dirtyStore,
  root: dirtyRoot,
  scanRoot: join(dirtyRoot, 'packages', 'main'),
});
const dirtyOutput = beginCaught(dirtyHandlers, dirtyStoryId);
assertStatusSurface(dirtyOutput, 'BLOCKED');
assert.match(dirtyOutput, new RegExp(`\\[${PRE_CERT_DIRTY_TREE}\\]`));
assert.equal(dirtyMock.consumed.length, 0);

const driftRoot = makeGitRoot();
const driftStoryId = 'B-cw16';
const driftStore = makeStore(driftRoot, driftStoryId);
driftStore.writeChecklist(driftStoryId, { items: [] });
const driftMock = mockInventoryApis({
  storyId: driftStoryId,
  headHash: currentGitHead(driftRoot)!,
  materialHash: currentMaterialHash(driftRoot, 'HEAD', driftRoot)!,
  storyFilesHash: currentStoryFilesHash(driftRoot, 'HEAD', driftRoot)!,
  driftedMaterialHash: 'f'.repeat(64),
});
setReviewInventoryAdmitApisForTest(driftMock.apis);
const driftHandlers = createCertificationWindowHandlers({
  store: driftStore,
  root: driftRoot,
  scanRoot: join(driftRoot, 'packages', 'main'),
});
const driftOutput = beginCaught(driftHandlers, driftStoryId);
assertStatusSurface(driftOutput, 'BLOCKED');
assert.match(driftOutput, new RegExp(`\\[${PRE_CERT_INVENTORY_NOT_FINALIZED}\\]`));
assert.match(driftOutput, /Whole-tree materialHash drift/);
assert.equal(driftMock.consumed.length, 0);

assert.equal(isOfficialHeavyValidateInvocation({ channel: true }), false);
assert.equal(isOfficialHeavyValidateInvocation({ concept: true }), false);
assert.equal(isOfficialHeavyValidateInvocation({ lint: true }), false);
assert.equal(isOfficialHeavyValidateInvocation({ story: 'B-cw20', focus: 'fast' }), false);
assert.equal(isOfficialHeavyValidateInvocation({}), false);
assert.equal(isOfficialHeavyValidateInvocation({ full: true }), false, 'no-story validate must stay non-heavy');
assert.equal(isOfficialHeavyValidateInvocation({ story: 'B-cw20' }), true, 'routine story validation must be official heavy certification');
assert.equal(isOfficialHeavyValidateInvocation({ story: 'B-cw20', full: true }), true);
assert.equal(isOfficialHeavyValidateInvocation({ story: 'B-cw20', full: 'filter' }), true);
assert.equal(isOfficialHeavyValidateInvocation({ story: 'B-cw20', full: true, focus: 'fast' }), true, '--full must remain heavy even when a caller adds focus');

const heavyMarker = 'HEAVY_RAN';
const routineMarker = 'ROUTINE_RAN';
function markerRunCount(dir: string, marker: string): number {
  const markerPath = join(dir, marker);
  return existsSync(markerPath) ? Number(readFileSync(markerPath, 'utf8')) : 0;
}

function markerPathRunCount(markerPath: string): number {
  return existsSync(markerPath) ? Number(readFileSync(markerPath, 'utf8')) : 0;
}

// CHK-004: a generic PASS or any REVIEW preflight does not stand in for the
// persisted cheap receipt. The exact focused JSON producer runs only the
// fast-tagged command, writes a signed current receipt, and only then lets
// begin consume the inventory.
const cheapCheckRoot = makeGitRoot();
const cheapMarkers = writeCheapCheckConfig(cheapCheckRoot);
const cheapCheckStoryId = 'B-cw-cheap';
const cheapCheckStore = makeStore(cheapCheckRoot, cheapCheckStoryId);
cheapCheckStore.writeChecklist(cheapCheckStoryId, { items: [] });
cheapCheckStore.writeTestEvidence(cheapCheckStoryId, {
  command: `proof-or-stop validate --story=${cheapCheckStoryId} --json`,
  output: '{"status":"pass","allPass":true}',
  result: 'PASS',
  timestamp: '2026-08-20T00:00:00.000Z',
  headHash: currentGitHead(cheapCheckRoot)!,
  materialHash: currentMaterialHash(cheapCheckRoot, 'HEAD', cheapCheckRoot)!,
  storyFilesHash: currentStoryFilesHash(cheapCheckRoot, 'HEAD', cheapCheckRoot)!,
});
let cheapMock = mockInventoryApis({
  storyId: cheapCheckStoryId,
  headHash: currentGitHead(cheapCheckRoot)!,
  materialHash: currentMaterialHash(cheapCheckRoot, 'HEAD', cheapCheckRoot)!,
  storyFilesHash: currentStoryFilesHash(cheapCheckRoot, 'HEAD', cheapCheckRoot)!,
});
setReviewInventoryAdmitApisForTest(cheapMock.apis);
const cheapCheckCtx = { store: cheapCheckStore, root: cheapCheckRoot, scanRoot: join(cheapCheckRoot, 'packages', 'main'), log: () => {} };
const cheapCheckWindowHandlers = createCertificationWindowHandlers(cheapCheckCtx);
const cheapCheckMissing = beginCaught(cheapCheckWindowHandlers, cheapCheckStoryId);
assert.match(cheapCheckMissing, new RegExp(`\\[${PRE_CERT_CHEAP_CHECK_REQUIRED}\\]`));
assert.match(cheapCheckMissing, new RegExp(`^Next: proof-or-stop validate --story=${cheapCheckStoryId} --focus=fast --json$`, 'm'));
assert.equal(cheapMock.consumed.length, 0, 'missing cheap receipt must block before inventory consumption');

// begin may persist its BLOCKED projection; bind the actual receipt and
// inventory to the resulting current identity, not the stale preflight head.
cheapMock = mockInventoryApis({
  storyId: cheapCheckStoryId,
  headHash: currentGitHead(cheapCheckRoot)!,
  materialHash: currentMaterialHash(cheapCheckRoot, 'HEAD', cheapCheckRoot)!,
  storyFilesHash: currentStoryFilesHash(cheapCheckRoot, 'HEAD', cheapCheckRoot)!,
});
setReviewInventoryAdmitApisForTest(cheapMock.apis);
const cheapCheckValidate = createVerifierHandlers(cheapCheckCtx);
await cheapCheckValidate.validate({ storyId: cheapCheckStoryId, focus: 'fast' });
assert.equal(
  currentPrecertCheapCheckReceipt({
    data: cheapCheckStore.readCertificationWindows(cheapCheckStoryId),
    storyId: cheapCheckStoryId,
    headHash: currentGitHead(cheapCheckRoot),
    materialHash: currentMaterialHash(cheapCheckRoot, 'HEAD', cheapCheckRoot),
    storyFilesHash: currentStoryFilesHash(cheapCheckRoot, 'HEAD', cheapCheckRoot),
  }),
  null,
  'focused non-JSON invocation must not mint a PRE_CERT cheap receipt',
);
const exactCheapResult = JSON.parse(await cheapCheckValidate.validate({
  storyId: cheapCheckStoryId,
  focus: 'fast',
  json: true,
}));
assert.equal(exactCheapResult.status, 'pass');
assert.equal(exactCheapResult.commandExecutions, 1);
assert.equal(exactCheapResult.precertCheapCheckReceipt?.authority, PRECERT_CHEAP_CHECK_AUTHORITY);
assert.equal(existsSync(cheapMarkers.fastMarker), true, 'exact cheap producer must run the fast-tagged command');
assert.equal(existsSync(cheapMarkers.fullMarker), false, 'exact cheap producer must not run an unscoped child command');
const cheapReceipt = currentPrecertCheapCheckReceipt({
  data: cheapCheckStore.readCertificationWindows(cheapCheckStoryId),
  storyId: cheapCheckStoryId,
  headHash: currentGitHead(cheapCheckRoot),
  materialHash: currentMaterialHash(cheapCheckRoot, 'HEAD', cheapCheckRoot),
  storyFilesHash: currentStoryFilesHash(cheapCheckRoot, 'HEAD', cheapCheckRoot),
});
assert.ok(cheapReceipt, 'only exact focused JSON validation must persist a current cheap receipt');
assert.equal(verifyPrecertCheapCheckReceipt(cheapReceipt!), true);
assert.equal(cheapReceipt?.routineValidationIdentity.invocation.full, null);
assert.equal(cheapReceipt?.routineValidationIdentity.invocation.focus, 'fast');
const cheapCheckAdmitted = cheapCheckWindowHandlers.certification_window_begin({ storyId: cheapCheckStoryId });
assertStatusSurface(cheapCheckAdmitted, 'ADMITTED');
assert.deepEqual(cheapMock.consumed, ['INV-1'], 'admit consumes inventory once after the exact cheap receipt exists');
assert.equal(existsSync(cheapMarkers.fullMarker), false, 'admission itself must not start the unscoped routine suite');

// CHK-005: replay the B-cc10 failure shape against the real shared choke. A
// focused receipt is the only precondition; after admission one bare routine
// suite persists its PASS, while both the REVIEW→TEST gate and a second direct
// request reuse it without another validate.commands child.
const atMostOnceRoot = makeGitRoot();
const atMostOnceMarker = writeRuntimeCounterConfig(atMostOnceRoot);
const atMostOnceStoryId = 'B-cw-at-most-once';
git(atMostOnceRoot, ['switch', '-c', `story/${atMostOnceStoryId}`]);
const atMostOnceStore = makeStore(atMostOnceRoot, atMostOnceStoryId);
atMostOnceStore.writeChecklist(atMostOnceStoryId, { items: [] });
const atMostOnceCtx = {
  store: atMostOnceStore,
  root: atMostOnceRoot,
  scanRoot: join(atMostOnceRoot, 'packages', 'main'),
  log: () => {},
};
const atMostOnceMock = mockInventoryApis({
  storyId: atMostOnceStoryId,
  headHash: currentGitHead(atMostOnceRoot)!,
  materialHash: currentMaterialHash(atMostOnceRoot, 'HEAD', atMostOnceRoot)!,
  storyFilesHash: currentStoryFilesHash(atMostOnceRoot, 'HEAD', atMostOnceRoot)!,
});
setReviewInventoryAdmitApisForTest(atMostOnceMock.apis);
const atMostOnceValidate = createVerifierHandlers(atMostOnceCtx);
const atMostOnceFast = JSON.parse(await atMostOnceValidate.validate({
  storyId: atMostOnceStoryId,
  focus: 'fast',
  json: true,
}));
assert.equal(atMostOnceFast.status, 'pass');
assert.equal(markerPathRunCount(atMostOnceMarker), 1, 'the fast producer runs one focused child');
const atMostOnceWindowHandlers = createCertificationWindowHandlers(atMostOnceCtx);
const atMostOnceAdmit = atMostOnceWindowHandlers.certification_window_begin({ storyId: atMostOnceStoryId });
assertStatusSurface(atMostOnceAdmit, 'ADMITTED');
assert.deepEqual(atMostOnceMock.consumed, ['INV-1'], 'a matching signed fast receipt admits exactly one saturated inventory');

const beforeBareRoutine = markerPathRunCount(atMostOnceMarker);
const admittedWithoutPass = await caught(() => runValidateGate(atMostOnceCtx, atMostOnceStoryId, { stop: () => {} }));
assert.match(admittedWithoutPass, new RegExp(`\\[${PRE_CERT_ROUTINE_PASS_REQUIRED}\\]`));
assert.match(admittedWithoutPass, new RegExp(`Return to DEV: proof-or-stop story_advance --storyId=${atMostOnceStoryId} --phase=DEV`));
assert.match(admittedWithoutPass, new RegExp(`proof-or-stop validate --story=${atMostOnceStoryId} --json`));
assert.equal(markerPathRunCount(atMostOnceMarker), beforeBareRoutine, 'an ADMITTED window without a stored PASS must refuse TEST before any configured child starts');
assert.equal(atMostOnceStore.readTestEvidence(atMostOnceStoryId), null, 'the TEST gate must not synthesize evidence when the sole REVIEW routine PASS is absent');

const unreadableIndexValidator = createVerifierHandlers({
  ...atMostOnceCtx,
  causalPreflightFacts: input => ({
    ...probeValidationCausalPreflightFacts(atMostOnceCtx, atMostOnceStoryId, input),
    gitIndex: { readable: false, reason: 'fixture-index-temporarily-unreadable' },
  }),
});
const preflightRefusal = await caught(() => unreadableIndexValidator.validate({ storyId: atMostOnceStoryId, json: true }));
assert.match(preflightRefusal, /causal_preflight_refused/);
assert.equal(markerPathRunCount(atMostOnceMarker), beforeBareRoutine, 'failed read-only preflight launches no child');
assert.equal(atMostOnceStore.readCertificationWindows(atMostOnceStoryId).windows.at(-1)?.state, 'ADMITTED', 'zero-launch preflight failure must preserve the initial execution allocation');

const firstBareRoutine = JSON.parse(await atMostOnceValidate.validate({ storyId: atMostOnceStoryId, json: true }));
assert.equal(firstBareRoutine.status, 'pass');
assert.equal(firstBareRoutine.commandExecutions, 1, 'the admitted bare routine validates once');
assert.equal(markerPathRunCount(atMostOnceMarker), beforeBareRoutine + 1, 'the admitted bare routine starts exactly one validate.commands child');
const firstRoutineEvidence = atMostOnceStore.readTestEvidence(atMostOnceStoryId);
assert.equal(firstRoutineEvidence?.result, 'PASS', 'the one admitted bare routine persists canonical PASS evidence');

await runValidateGate(atMostOnceCtx, atMostOnceStoryId, { stop: () => {} });
assert.equal(markerPathRunCount(atMostOnceMarker), beforeBareRoutine + 1, 'REVIEW-to-TEST reuses the fresh stored PASS without another child');
const currentRoutineEvidence = atMostOnceStore.readTestEvidence(atMostOnceStoryId)!;
atMostOnceStore.writeTestEvidence(atMostOnceStoryId, { ...currentRoutineEvidence, result: 'FAIL' });
const failedPassTransition = await caught(() => runValidateGate(atMostOnceCtx, atMostOnceStoryId, { stop: () => {} }));
assert.match(failedPassTransition, new RegExp(`\\[${PRE_CERT_ROUTINE_PASS_REQUIRED}\\]`));
assert.equal(markerPathRunCount(atMostOnceMarker), beforeBareRoutine + 1, 'a failed stored routine result must refuse TEST without launching a replacement child');
atMostOnceStore.writeTestEvidence(atMostOnceStoryId, { ...currentRoutineEvidence, headHash: '0'.repeat(40) });
const stalePassTransition = await caught(() => runValidateGate(atMostOnceCtx, atMostOnceStoryId, { stop: () => {} }));
assert.match(stalePassTransition, new RegExp(`\\[${PRE_CERT_ROUTINE_PASS_REQUIRED}\\]`));
assert.equal(markerPathRunCount(atMostOnceMarker), beforeBareRoutine + 1, 'stale stored routine evidence must refuse TEST without launching a replacement child');
atMostOnceStore.writeTestEvidence(atMostOnceStoryId, currentRoutineEvidence);
const secondBareRoutine = JSON.parse(await atMostOnceValidate.validate({ storyId: atMostOnceStoryId, json: true }));
assert.equal(secondBareRoutine.status, 'pass');
assert.equal(markerPathRunCount(atMostOnceMarker), beforeBareRoutine + 1, 'a second direct bare routine request must not start a second child');
const reusedRoutineTimestamp = atMostOnceStore.readTestEvidence(atMostOnceStoryId)?.timestamp;
assert.ok(reusedRoutineTimestamp, 'a reused direct request must retain canonical PASS evidence');

// A no-validator result is still the one official routine-validation attempt.
// It must consume the admitted window before persisting its warn/PASS evidence,
// otherwise an unchanged retry could repeatedly mint TEST-admissible evidence.
const noValidatorRoot = makeGitRoot();
const noValidatorStoryId = 'B-cw-no-validator';
git(noValidatorRoot, ['switch', '-c', `story/${noValidatorStoryId}`]);
const noValidatorStore = makeStore(noValidatorRoot, noValidatorStoryId);
noValidatorStore.writeChecklist(noValidatorStoryId, { items: [] });
const noValidatorCtx = {
  store: noValidatorStore,
  root: noValidatorRoot,
  scanRoot: join(noValidatorRoot, 'packages', 'main'),
  log: () => {},
};
const noValidatorMock = mockInventoryApis({
  storyId: noValidatorStoryId,
  headHash: currentGitHead(noValidatorRoot)!,
  materialHash: currentMaterialHash(noValidatorRoot, 'HEAD', noValidatorRoot)!,
  storyFilesHash: currentStoryFilesHash(noValidatorRoot, 'HEAD', noValidatorRoot)!,
});
setReviewInventoryAdmitApisForTest(noValidatorMock.apis);
persistCurrentFastCheapReceipt(noValidatorStore, noValidatorRoot, noValidatorStoryId);
const noValidatorWindowHandlers = createCertificationWindowHandlers(noValidatorCtx);
assertStatusSurface(noValidatorWindowHandlers.certification_window_begin({ storyId: noValidatorStoryId }), 'ADMITTED');
const noValidatorValidate = createVerifierHandlers(noValidatorCtx);
const noValidatorResult = JSON.parse(await noValidatorValidate.validate({ storyId: noValidatorStoryId, json: true }));
assert.equal(noValidatorResult.status, 'warn');
assert.equal(noValidatorResult.commandExecutions, 0, 'no-validator result has no child process to execute');
assert.equal(noValidatorStore.readCertificationWindows(noValidatorStoryId).windows.at(-1)?.state, 'RUNNING',
  'the no-validator terminal result must consume the one admitted routine-validation window');
const noValidatorRetry = JSON.parse(await noValidatorValidate.validate({ storyId: noValidatorStoryId, json: true }));
assert.equal(noValidatorRetry.commandExecutions, 0,
  'an unchanged no-validator retry must reuse evidence rather than write another TEST-admissible execution');
assert.equal(noValidatorStore.readCertificationWindows(noValidatorStoryId).windows.at(-1)?.state, 'RUNNING',
  'reusing no-validator evidence must not reopen the consumed routine-validation window');

// A failed first routine creates no reusable PASS. Its RUNNING window has
// nevertheless spent the one authorization, so an unchanged retry must refuse
// before the configured child can start again.
const spentWindowRoot = makeGitRoot();
const spentWindowMarker = writeRuntimeCounterConfig(spentWindowRoot, 1);
const spentWindowStoryId = 'B-cw-spent-window';
git(spentWindowRoot, ['switch', '-c', `story/${spentWindowStoryId}`]);
const spentWindowStore = makeStore(spentWindowRoot, spentWindowStoryId);
spentWindowStore.writeChecklist(spentWindowStoryId, { items: [] });
const spentWindowCtx = {
  store: spentWindowStore,
  root: spentWindowRoot,
  scanRoot: join(spentWindowRoot, 'packages', 'main'),
  log: () => {},
};
const spentWindowMock = mockInventoryApis({
  storyId: spentWindowStoryId,
  headHash: currentGitHead(spentWindowRoot)!,
  materialHash: currentMaterialHash(spentWindowRoot, 'HEAD', spentWindowRoot)!,
  storyFilesHash: currentStoryFilesHash(spentWindowRoot, 'HEAD', spentWindowRoot)!,
});
setReviewInventoryAdmitApisForTest(spentWindowMock.apis);
persistCurrentFastCheapReceipt(spentWindowStore, spentWindowRoot, spentWindowStoryId);
const spentWindowHandlers = createCertificationWindowHandlers(spentWindowCtx);
assertStatusSurface(spentWindowHandlers.certification_window_begin({ storyId: spentWindowStoryId }), 'ADMITTED');
const spentWindowValidate = createVerifierHandlers(spentWindowCtx);
const firstSpentRoutine = JSON.parse(await spentWindowValidate.validate({ storyId: spentWindowStoryId, json: true }));
assert.equal(firstSpentRoutine.status, 'fail', 'the first routine may fail after consuming the window');
assert.equal(markerPathRunCount(spentWindowMarker), 1, 'the first failed routine starts exactly one child');
const secondSpentRoutine = await caught(() => spentWindowValidate.validate({ storyId: spentWindowStoryId, json: true }));
assert.match(secondSpentRoutine, /pre_cert_window_already_consumed/);
assert.equal(markerPathRunCount(spentWindowMarker), 1, 'a RUNNING window without a reusable PASS must not start a second child');
for (const dynamicMode of ['observe', 'shadow', 'enforce-low-risk'] as const) {
  const retry = await caught(() => spentWindowValidate.validate({ storyId: spentWindowStoryId, json: true, dynamicMode }));
  assert.match(retry, /pre_cert_window_already_consumed/, `${dynamicMode}: claim refusal must precede dynamic execution and remain outside its fallback catch`);
  assert.equal(markerPathRunCount(spentWindowMarker), 1, `${dynamicMode}: a consumed window cannot launch dynamic children`);
}

const receiptCountBeforeRelatedDrift = atMostOnceStore.readCertificationWindows(atMostOnceStoryId).receipts.length;
mkdirSync(join(atMostOnceRoot, 'src'), { recursive: true });
mkdirSync(join(atMostOnceRoot, 'tests'), { recursive: true });
writeFileSync(join(atMostOnceRoot, 'src', 'at-most-once.ts'), 'export const current = true;\n');
writeFileSync(join(atMostOnceRoot, 'tests', 'at-most-once.test.ts'), 'export const covered = true;\n');
git(atMostOnceRoot, ['add', 'src/at-most-once.ts', 'tests/at-most-once.test.ts']);
git(atMostOnceRoot, ['commit', '-m', 'related source and test drift']);
const atMostOnceInvalidated = atMostOnceWindowHandlers.certification_window_status({ storyId: atMostOnceStoryId });
assertStatusSurface(atMostOnceInvalidated, 'INVALIDATED');
assert.equal(
  currentPrecertCheapCheckReceipt({
    data: atMostOnceStore.readCertificationWindows(atMostOnceStoryId),
    storyId: atMostOnceStoryId,
    headHash: currentGitHead(atMostOnceRoot),
    materialHash: currentMaterialHash(atMostOnceRoot, 'HEAD', atMostOnceRoot),
    storyFilesHash: currentStoryFilesHash(atMostOnceRoot, 'HEAD', atMostOnceRoot),
  }),
  null,
  'related source/test drift invalidates the old fast receipt instead of re-signing it',
);
const staleDirectRoutine = await caught(() => atMostOnceValidate.validate({ storyId: atMostOnceStoryId }));
assertBoundedPrecertRecovery(staleDirectRoutine, atMostOnceStoryId);
assert.equal(markerPathRunCount(atMostOnceMarker), beforeBareRoutine + 1, 'drifted window/receipt must refuse before reusing or starting a child');
assert.equal(atMostOnceStore.readCertificationWindows(atMostOnceStoryId).receipts.length, receiptCountBeforeRelatedDrift, 'stale evidence must not be re-signed as current authority');
assert.equal(atMostOnceStore.readTestEvidence(atMostOnceStoryId)?.timestamp, reusedRoutineTimestamp, 'drifted direct validation must not replace the old PASS as current evidence');

function assertBoundedPrecertRecovery(text: string, id: string): void {
  assert.match(text, new RegExp(`\\[${PRE_CERT_WINDOW_REQUIRED}\\]`));
  assert.equal(countPrefix(text, 'Next:'), 1, `PRE_CERT refusal must render exactly one recovery\n${text}`);
  assert.match(text, new RegExp(`^Next: proof-or-stop (?:certification_window_begin --storyId=${id}|review_inventory_finalize --storyId=${id}|story_advance --storyId=${id} --phase=REVIEW)$`, 'm'));
  assert.doesNotMatch(text, /proof-or-stop story_advance .* --phase=TEST|proof-or-stop validate --story=/);
}

function writeHeavyConfig(dir: string, commit = false): void {
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify({
    storyDir: '.proof-or-stop/story/actives',
    storyPrefix: 'B',
    validate: {
      commands: [{
        label: 'routine-spawn-detector',
        command: 'node',
        args: ['-e', `const fs=require('fs');const p=${JSON.stringify(join(dir, routineMarker))};const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1))`],
        timeoutMs: 15000,
        focus: ['fast'],
      }],
    },
    doneRequiredCommands: [{
      label: 'spawn-detector',
      command: 'node',
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, heavyMarker))}, '1')`],
      timeoutMs: 15000,
    }],
  }));
  if (commit) {
    git(dir, ['add', 'proof-or-stop.config.json']);
    git(dir, ['commit', '-m', 'heavy detector config']);
  }
}

setReviewInventoryAdmitApisForTest({
  verifyReviewInventoryEpoch: () => true,
  verifyReviewInventoryReceipt: () => true,
  isInventoryCompletenessOnlyReceipt: () => true,
  finalizedUnconsumedReviewInventory: () => null,
  consumeReviewInventoryCompletenessReceipt: () => null,
});

function writeRuntimeCounterConfig(dir: string, exitCode = 0): string {
  const markerPath = join(dir, '.proof-or-stop', 'runtime', 'AT_MOST_ONCE_ROUTINE_RAN');
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify({
    storyDir: '.proof-or-stop/story/actives',
    storyPrefix: 'B',
    validate: {
      commands: [{
        label: 'runtime-routine-spawn-detector',
        command: 'node',
        args: ['-e', `const fs=require('fs');const p=${JSON.stringify(markerPath)};fs.mkdirSync(require('path').dirname(p),{recursive:true});const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));process.exit(${exitCode})`],
        timeoutMs: 15000,
        focus: ['fast'],
      }],
    },
  }));
  git(dir, ['add', 'proof-or-stop.config.json']);
  git(dir, ['commit', '-m', 'runtime routine detector config']);
  return markerPath;
}

function writeCheapCheckConfig(dir: string): { fastMarker: string; fullMarker: string } {
  const fastMarker = join(dir, '.proof-or-stop', 'runtime', 'FAST_FOCUSED_RAN');
  const fullMarker = join(dir, '.proof-or-stop', 'runtime', 'FULL_UNSCOPED_RAN');
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify({
    storyDir: '.proof-or-stop/story/actives',
    storyPrefix: 'B',
    validate: {
      commands: [
        {
          label: 'fast-focused-detector',
          command: 'node',
          args: ['-e', `const fs=require('fs');fs.mkdirSync(${JSON.stringify(join(dir, '.proof-or-stop', 'runtime'))},{recursive:true});fs.writeFileSync(${JSON.stringify(fastMarker)}, '1')`],
          timeoutMs: 15_000,
          focus: ['fast'],
        },
        {
          label: 'unscoped-detector',
          command: 'node',
          args: ['-e', `const fs=require('fs');fs.mkdirSync(${JSON.stringify(join(dir, '.proof-or-stop', 'runtime'))},{recursive:true});fs.writeFileSync(${JSON.stringify(fullMarker)}, '1')`],
          timeoutMs: 15_000,
        },
      ],
    },
  }));
  git(dir, ['add', 'proof-or-stop.config.json']);
  git(dir, ['commit', '-m', 'cheap check validator config']);
  return { fastMarker, fullMarker };
}

const chokeRoot = makeGitRoot();
writeHeavyConfig(chokeRoot);
const chokeStoryId = 'B-cw20';
const chokeStore = makeStore(chokeRoot, chokeStoryId, 'TEST');
chokeStore.writeChecklist(chokeStoryId, { items: [] });
const chokeCtx = { store: chokeStore, root: chokeRoot, scanRoot: join(chokeRoot, 'packages', 'main'), log: () => {} };
const chokeDone = createDoneRequiredValidationHandlers(chokeCtx);
const chokeValidate = createVerifierHandlers(chokeCtx);

async function caught(fn: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await fn();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const prematureDone = await caught(() => chokeDone.done_required_validate({ storyId: chokeStoryId }));
assert.match(prematureDone, new RegExp(`\\[${PRE_CERT_WINDOW_REQUIRED}\\]`));
assert.match(prematureDone, new RegExp(`Next: proof-or-stop review_inventory_finalize --storyId=${chokeStoryId}`));
assert.equal(existsSync(join(chokeRoot, heavyMarker)), false, 'done_required_validate must not spawn heavy children without an admitted window');
for (let i = 0; i < 3; i += 1) {
  const storm = await caught(() => chokeDone.done_required_validate({ storyId: chokeStoryId }));
  assert.match(storm, new RegExp(`\\[${PRE_CERT_WINDOW_REQUIRED}\\]`));
}
assert.equal(existsSync(join(chokeRoot, heavyMarker)), false, 'retry storm must not spawn a heavy child');

const prematureFull = await caught(() => chokeValidate.validate({ storyId: chokeStoryId, full: true }));
assert.match(prematureFull, new RegExp(`\\[${PRE_CERT_WINDOW_REQUIRED}\\]`));
assert.match(prematureFull, new RegExp(`Next: proof-or-stop review_inventory_finalize --storyId=${chokeStoryId}`));
assert.equal(existsSync(join(chokeRoot, heavyMarker)), false, 'validate --full must not spawn heavy children without an admitted window');
assert.equal(existsSync(join(chokeRoot, routineMarker)), false, 'validate --full must not spawn configured validation children without an admitted window');

const prematureFullFocus = await caught(() => chokeValidate.validate({ storyId: chokeStoryId, full: true, focus: 'fast' }));
assertBoundedPrecertRecovery(prematureFullFocus, chokeStoryId);
assert.equal(existsSync(join(chokeRoot, heavyMarker)), false, 'validate --full --focus must not tunnel around PRE_CERT');
assert.equal(markerRunCount(chokeRoot, routineMarker), 0, 'validate --full --focus must reject before any configured child starts');

const prematureRoutine = await caught(() => chokeValidate.validate({ storyId: chokeStoryId }));
assertBoundedPrecertRecovery(prematureRoutine, chokeStoryId);
assert.equal(existsSync(join(chokeRoot, heavyMarker)), false, 'routine story validation must not spawn done-required children without an admitted window');
assert.equal(markerRunCount(chokeRoot, routineMarker), 0, 'routine story validation must reject before configured validation children start');
for (let retry = 0; retry < 3; retry += 1) {
  const retryOutput = await caught(() => chokeValidate.validate({ storyId: chokeStoryId }));
  assertBoundedPrecertRecovery(retryOutput, chokeStoryId);
}
assert.equal(markerRunCount(chokeRoot, routineMarker), 0, 'routine validation retries must not spawn configured children');

const prematureTransition = await caught(() => runValidateGate(chokeCtx, chokeStoryId, { stop: () => {} }));
assertBoundedPrecertRecovery(prematureTransition, chokeStoryId);
assert.equal(markerRunCount(chokeRoot, routineMarker), 0, 'REVIEW-to-TEST validation gate must reject before configured children start');

const chokeWindowHandlers = createCertificationWindowHandlers(chokeCtx);
const blockedWindow = caught(() => chokeWindowHandlers.certification_window_begin({ storyId: chokeStoryId }));
assert.match(await blockedWindow, new RegExp(`\\[${PRE_CERT_INVENTORY_NOT_FINALIZED}\\]`));
const blockedTransition = await caught(() => runValidateGate(chokeCtx, chokeStoryId, { stop: () => {} }));
assertBoundedPrecertRecovery(blockedTransition, chokeStoryId);
assert.equal(markerRunCount(chokeRoot, routineMarker), 0, 'BLOCKED windows must not allow cached-PASS or child execution');
const cancelledWindow = chokeWindowHandlers.certification_window_cancel({ storyId: chokeStoryId, reason: 'test terminal window refusal' });
assertStatusSurface(cancelledWindow, 'CANCELLED');
const cancelledTransition = await caught(() => runValidateGate(chokeCtx, chokeStoryId, { stop: () => {} }));
assertBoundedPrecertRecovery(cancelledTransition, chokeStoryId);
assert.equal(markerRunCount(chokeRoot, routineMarker), 0, 'CANCELLED windows must not allow cached-PASS or child execution');
const cachedPass = {
  command: `proof-or-stop validate --story=${chokeStoryId} --json`,
  output: '{"allPass":true,"summary":"current cached PASS"}',
  result: 'PASS' as const,
  timestamp: '2026-08-20T00:00:00.000Z',
  headHash: currentGitHead(chokeRoot)!,
  materialHash: currentMaterialHash(chokeRoot, 'HEAD', chokeRoot)!,
  storyFilesHash: currentStoryFilesHash(chokeRoot, 'HEAD', chokeRoot)!,
  verificationCoverage: { total: 0, required: 0, covered: 0, missingRequired: 0, entries: [] },
};
chokeStore.writeTestEvidence(chokeStoryId, cachedPass);
const cachedPassCancelledTransition = await caught(() => runValidateGate(chokeCtx, chokeStoryId, { stop: () => {} }));
assertBoundedPrecertRecovery(cachedPassCancelledTransition, chokeStoryId);
assert.equal(markerRunCount(chokeRoot, routineMarker), 0, 'a current-hash PASS must not bypass a CANCELLED window');
assert.equal(chokeStore.readTestEvidence(chokeStoryId)?.timestamp, cachedPass.timestamp, 'terminal PRE_CERT refusal must not rewrite cached PASS evidence');

setReviewInventoryAdmitApisForTest({
  verifyReviewInventoryEpoch: () => true,
  verifyReviewInventoryReceipt: () => true,
  isInventoryCompletenessOnlyReceipt: () => true,
  finalizedUnconsumedReviewInventory: () => {
    throw new Error('inventory store unreadable');
  },
  consumeReviewInventoryCompletenessReceipt: () => null,
});
const failedProbeStoryId = 'B-cw-inventory-probe';
const failedProbeStore = makeStore(chokeRoot, failedProbeStoryId);
const failedInventoryProbe = await caught(() => createVerifierHandlers({ ...chokeCtx, store: failedProbeStore }).validate({ storyId: failedProbeStoryId, full: true }));
assert.match(failedInventoryProbe, new RegExp(`\\[${PRE_CERT_INVENTORY_PROBE_FAILED}\\]`));
assert.match(failedInventoryProbe, /Review Inventory probe failed: inventory store unreadable/);
assert.match(failedInventoryProbe, new RegExp(`Next: proof-or-stop certification_window_status --storyId=${failedProbeStoryId}`));
assert.doesNotMatch(failedInventoryProbe, new RegExp(`Next: proof-or-stop certification_window_begin --storyId=${failedProbeStoryId}`));
setReviewInventoryAdmitApisForTest(null);

const donePrepareFallback = `proof-or-stop done_required_validate --storyId=${chokeStoryId}`;
assert.equal(
  safeDoneRequiredRecoveryCommand(
    chokeStoryId,
    `[pre_cert_window_required]\nNext: proof-or-stop review_inventory_finalize --storyId=${chokeStoryId}`,
    donePrepareFallback,
  ),
  `proof-or-stop review_inventory_finalize --storyId=${chokeStoryId}`,
  'done_prepare must propagate the authoritative inventory-finalization recovery command',
);
assert.equal(
  safeDoneRequiredRecoveryCommand(
    chokeStoryId,
    `Next: proof-or-stop review_inventory_finalize --storyId=B-other`,
    donePrepareFallback,
  ),
  donePrepareFallback,
  'done_prepare must not propagate a recovery command for another Story',
);
assert.equal(
  safeDoneRequiredRecoveryCommand(
    chokeStoryId,
    'Next: proof-or-stop review_inventory_finalize --storyId=',
    donePrepareFallback,
  ),
  donePrepareFallback,
  'done_prepare must reject a malformed inventory recovery command',
);
assert.equal(
  safeDoneRequiredRecoveryCommand(
    chokeStoryId,
    `Next: proof-or-stop review_inventory_finalize --storyId=${chokeStoryId};touch /tmp/proof-or-stop-smoke`,
    donePrepareFallback,
  ),
  donePrepareFallback,
  'done_prepare must reject shell metacharacters in a recovery command',
);
assert.equal(
  safeDoneRequiredRecoveryCommand(
    chokeStoryId,
    'refusal without an authoritative Next line',
    donePrepareFallback,
  ),
  donePrepareFallback,
  'done_prepare must retain the caller fallback when Next is absent',
);
assert.equal(
  safeDoneRequiredRecoveryCommand(
    chokeStoryId,
    `Next: proof-or-stop finding_list --storyId=${chokeStoryId}`,
    donePrepareFallback,
  ),
  `proof-or-stop finding_list --storyId=${chokeStoryId}`,
  'done_prepare must retain a non-inventory caller-specific recovery command',
);

const cheapChannel = await caught(() => chokeValidate.validate({ storyId: chokeStoryId, channel: true }));
assert.doesNotMatch(cheapChannel, new RegExp(`\\[${PRE_CERT_WINDOW_REQUIRED}\\]`));
const cheapConcept = await caught(() => chokeValidate.validate({ storyId: chokeStoryId, concept: true }));
assert.doesNotMatch(cheapConcept, new RegExp(`\\[${PRE_CERT_WINDOW_REQUIRED}\\]`));
const cheapLint = await caught(() => chokeValidate.validate({ storyId: chokeStoryId, lint: true }));
assert.doesNotMatch(cheapLint, new RegExp(`\\[${PRE_CERT_WINDOW_REQUIRED}\\]`));
const cheapFocus = await caught(() => chokeValidate.validate({ storyId: chokeStoryId, focus: 'fast' }));
assert.doesNotMatch(cheapFocus, new RegExp(`\\[${PRE_CERT_WINDOW_REQUIRED}\\]`));
assert.equal(existsSync(join(chokeRoot, routineMarker)), true, 'focused validation must remain available before PRE_CERT admission');
rmSync(join(chokeRoot, routineMarker));
const noStoryValidate = await caught(() => chokeValidate.validate({}));
assert.doesNotMatch(noStoryValidate, new RegExp(`\\[${PRE_CERT_WINDOW_REQUIRED}\\]`));
assert.equal(existsSync(join(chokeRoot, routineMarker)), true, 'no-story validation must remain non-heavy');

const replayRoot = makeGitRoot();
writeHeavyConfig(replayRoot, true);
const replayStoryId = 'B-cw21';
const replayStore = makeStore(replayRoot, replayStoryId);
replayStore.writeChecklist(replayStoryId, { items: [] });
const replayHead = currentGitHead(replayRoot)!;
const replayMaterial = currentMaterialHash(replayRoot, 'HEAD', replayRoot)!;
const replayStoryFiles = currentStoryFilesHash(replayRoot, 'HEAD', replayRoot)!;
const replayMock = mockInventoryApis({
  storyId: replayStoryId,
  headHash: currentGitHead(replayRoot)!,
  materialHash: replayMaterial,
  storyFilesHash: replayStoryFiles,
});
setReviewInventoryAdmitApisForTest(replayMock.apis);
persistCurrentFastCheapReceipt(replayStore, replayRoot, replayStoryId);
const replayWindowHandlers = createCertificationWindowHandlers({
  store: replayStore,
  root: replayRoot,
  scanRoot: join(replayRoot, 'packages', 'main'),
});
const replayAdmit = replayWindowHandlers.certification_window_begin({ storyId: replayStoryId });
assertStatusSurface(replayAdmit, 'ADMITTED');
const replayAdmittedWindow = replayStore.readCertificationWindows(replayStoryId).windows.at(-1) ?? null;
const replayAdmittedReceipt = receiptForWindow(replayStore.readCertificationWindows(replayStoryId), replayAdmittedWindow);
const admittedReceiptHash = replayAdmittedReceipt?._hash;
const admittedFrozen = structuredClone(replayAdmittedReceipt?.frozen);
const replayDone = createDoneRequiredValidationHandlers({
  store: replayStore,
  root: replayRoot,
  scanRoot: join(replayRoot, 'packages', 'main'),
  log: () => {},
});
const replayValidate = createVerifierHandlers({
  store: replayStore,
  root: replayRoot,
  scanRoot: join(replayRoot, 'packages', 'main'),
  log: () => {},
});
const admittedHeavy = await caught(() => replayDone.done_required_validate({ storyId: replayStoryId }));
assert.doesNotMatch(admittedHeavy, new RegExp(`\\[${PRE_CERT_WINDOW_REQUIRED}\\]`));
assert.equal(existsSync(join(replayRoot, heavyMarker)), true, 'DONE-required validation may start its independent policy command');
const unchangedStatus = replayWindowHandlers.certification_window_status({ storyId: replayStoryId });
assertStatusSurface(unchangedStatus, 'ADMITTED');
const routineWindow = replayStore.readCertificationWindows(replayStoryId).windows.at(-1);
const routineReceipt = receiptForWindow(replayStore.readCertificationWindows(replayStoryId), routineWindow ?? null);
assert.ok(routineWindow && routineReceipt, 'independent DONE-required validation must retain the signed routine receipt');
assert.equal(
  windowAuthorizesHeavyCertification(routineWindow, routineReceipt),
  true,
  'DONE-required validation must leave the routine window bound to its frozen receipt identity',
);
assert.deepEqual(routineReceipt.frozen, routineWindow.frozen);
assert.equal(routineReceipt.frozen.verifierIdentity, PRECERT_VERIFIER_IDENTITY);
assert.equal(routineReceipt.frozen.testIdentity, PRECERT_TEST_IDENTITY);

writeFileSync(join(replayRoot, '.proof-or-stop', 'story', 'actives', replayStoryId, 'note.md'), 'metadata-only\n');
git(replayRoot, ['add', `.proof-or-stop/story/actives/${replayStoryId}/note.md`]);
git(replayRoot, ['commit', '-m', 'metadata-only']);
const metadataStatus = replayWindowHandlers.certification_window_status({ storyId: replayStoryId });
assertStatusSurface(metadataStatus, 'ADMITTED');

// F-142: the production handler must construct a signed causal decision and
// pass it through lineage refresh so an unrelated material commit stays
// admitted while a story-owned commit invalidates the same window.
const selectiveRoot = makeGitRoot();
git(selectiveRoot, ['checkout', '-b', 'story/B-cw-selective']);
mkdirSync(join(selectiveRoot, 'packages/main/src/core'), { recursive: true });
writeFileSync(join(selectiveRoot, 'packages/main/src/core/app.ts'), 'export const n = 1;\n');
git(selectiveRoot, ['add', 'packages/main/src/core/app.ts']);
git(selectiveRoot, ['commit', '-m', 'story source baseline']);
const selectiveStoryId = 'B-cw-selective';
const selectiveStore = makeStore(selectiveRoot, selectiveStoryId);
selectiveStore.writeChecklist(selectiveStoryId, { items: [] });
const selectiveMock = mockInventoryApis({
  storyId: selectiveStoryId,
  headHash: currentGitHead(selectiveRoot)!,
  materialHash: currentMaterialHash(selectiveRoot, 'HEAD', selectiveRoot)!,
  storyFilesHash: currentStoryFilesHash(selectiveRoot, 'HEAD', selectiveRoot)!,
});
setReviewInventoryAdmitApisForTest(selectiveMock.apis);
const selectiveHandlers = createCertificationWindowHandlers({
  store: selectiveStore,
  root: selectiveRoot,
  scanRoot: join(selectiveRoot, 'packages', 'main'),
});
persistCurrentFastCheapReceipt(selectiveStore, selectiveRoot, selectiveStoryId);
assertStatusSurface(selectiveHandlers.certification_window_begin({ storyId: selectiveStoryId }), 'ADMITTED');
git(selectiveRoot, ['checkout', 'main']);
writeFileSync(join(selectiveRoot, 'unrelated.txt'), 'unrelated material\n');
git(selectiveRoot, ['add', 'unrelated.txt']);
git(selectiveRoot, ['commit', '-m', 'unrelated material change']);
git(selectiveRoot, ['checkout', 'story/B-cw-selective']);
git(selectiveRoot, ['merge', 'main', '--no-edit']);
assertStatusSurface(selectiveHandlers.certification_window_status({ storyId: selectiveStoryId }), 'ADMITTED');
writeFileSync(join(selectiveRoot, 'packages/main/src/core/app.ts'), 'export const n = 2;\n');
git(selectiveRoot, ['add', 'packages/main/src/core/app.ts']);
git(selectiveRoot, ['commit', '-m', 'story source change']);
assertStatusSurface(selectiveHandlers.certification_window_status({ storyId: selectiveStoryId }), 'INVALIDATED');

mkdirSync(join(replayRoot, 'src'), { recursive: true });
mkdirSync(join(replayRoot, 'tests'), { recursive: true });
writeFileSync(join(replayRoot, 'src', 'app.ts'), 'export const n = 1;\n');
writeFileSync(join(replayRoot, 'tests', 'app.test.ts'), 'export const t = 1;\n');
git(replayRoot, ['add', 'src/app.ts', 'tests/app.test.ts']);
git(replayRoot, ['commit', '-m', 'source and test change']);
const invalidatedStatus = replayWindowHandlers.certification_window_status({ storyId: replayStoryId });
assertStatusSurface(invalidatedStatus, 'INVALIDATED');
assert.match(invalidatedStatus, /^Next: proof-or-stop story_advance .* --phase=REVIEW$/m);
const afterReceipt = receiptForWindow(
  replayStore.readCertificationWindows(replayStoryId),
  replayStore.readCertificationWindows(replayStoryId).windows.at(-1) ?? null,
);
assert.equal(afterReceipt?._hash, admittedReceiptHash, 'stored receipt hash must not be rewritten');
assert.deepEqual(afterReceipt?.frozen, admittedFrozen, 'stored receipt frozen identity must keep original hashes');

rmSync(join(replayRoot, heavyMarker));
const postCertRoutine = await caught(() => replayValidate.validate({ storyId: replayStoryId }));
assert.match(postCertRoutine, new RegExp(`\\[${PRE_CERT_WINDOW_REQUIRED}\\]`));
assertBoundedPrecertRecovery(postCertRoutine, replayStoryId);
assert.equal(existsSync(join(replayRoot, routineMarker)), false, 'an invalidated window must reject routine validation before configured children start');
const invalidatedTransition = await caught(() => runValidateGate({
  store: replayStore,
  root: replayRoot,
  scanRoot: join(replayRoot, 'packages', 'main'),
  log: () => {},
}, replayStoryId, { stop: () => {} }));
assertBoundedPrecertRecovery(invalidatedTransition, replayStoryId);
assert.equal(markerRunCount(replayRoot, routineMarker), 0, 'an invalidated window must reject REVIEW-to-TEST before configured children start');
const postCertHeavy = await caught(() => replayDone.done_required_validate({ storyId: replayStoryId }));
assertBoundedPrecertRecovery(postCertHeavy, replayStoryId);
assert.equal(existsSync(join(replayRoot, heavyMarker)), false,
  'DONE-required must retain PRE_CERT invalidation protection before launching children');

const verifierDrift = detectCertificationWindowMaterialDrift(routineWindow!, {
  materialHash: routineWindow!.frozen?.materialHash,
  storyFilesHash: routineWindow!.frozen?.storyFilesHash,
  verifierIdentity: 'mutated-verifier',
  testIdentity: PRECERT_TEST_IDENTITY,
});
assert.equal(verifierDrift.drifted, true, 'official verifier identity change must drift');
assert.match(String(verifierDrift.reason), /verifier identity/);

const peerStoryId = 'B-cw22';
const peerStore = makeStore(replayRoot, peerStoryId);
peerStore.writeStory(peerStoryId, {
  ...peerStore.readStory(peerStoryId),
  title: 'peer story still writable',
});
peerStore.writeChecklist(peerStoryId, { items: [] });
assert.equal(
  replayWindowHandlers.certification_window_status({ storyId: replayStoryId }).includes('State: INVALIDATED'),
  true,
  'peer story metadata write must not restore this window',
);
assert.ok(peerStore.readStory(peerStoryId).title.includes('peer'), 'peer DEV write must succeed without a repo-wide lock');

const reviewerNames = computeActiveReviewers(
  { riskSignals: [] },
  { items: [] },
).map(row => row.name);
assert.ok(
  ['concept', 'quality', 'test-coverage'].every(name => reviewerNames.includes(name)),
  `baseline reviewer lanes must remain present, got ${JSON.stringify(reviewerNames)}`,
);

const testIdentityDrift = detectCertificationWindowMaterialDrift(routineWindow!, {
  materialHash: routineWindow!.frozen?.materialHash,
  storyFilesHash: routineWindow!.frozen?.storyFilesHash,
  verifierIdentity: PRECERT_VERIFIER_IDENTITY,
  testIdentity: 'mutated-test-suite',
});
assert.equal(testIdentityDrift.drifted, true, 'official test identity change must drift');

setReviewInventoryAdmitApisForTest(undefined);
const restoredApis = loadReviewInventoryAdmitApis();
assert.ok(restoredApis, 'production loader is non-null after test override reset');
assert.equal(typeof restoredApis.finalizedUnconsumedReviewInventory, 'function');
assert.equal(typeof restoredApis.consumeReviewInventoryCompletenessReceipt, 'function');
assert.equal(
  restoredApis.consumeReviewInventoryCompletenessReceipt.name,
  'consumeReviewInventoryCompletenessReceipt',
);

const saturatedInventoryCutoff = {
  headHash: 'a'.repeat(40),
  materialHash: 'b'.repeat(64),
  storyFilesHash: 'c'.repeat(64),
};
const saturatedInventoryLanes = ['lattice-review-contract', 'lattice-review-quality'];
const saturatedInventoryWave = {
  wave: 1,
  startedAt: '2026-08-20T00:00:00.000Z',
  completedAt: '2026-08-20T00:01:00.000Z',
  lanes: saturatedInventoryLanes.map(lane => ({
    lane,
    reviewRunId: `B-cw-saturated:RR-${lane}`,
    terminal: 'pass' as const,
    hostIdentity: `${lane}-host`,
    promptIdentity: `${lane}-prompt`,
    evidenceIds: [`${lane}:PASS-001`],
    coverageDigest: `${lane}-coverage`,
  })),
  verifiedFindingFamilies: [],
  verifiedFindingSetDigest: 'd'.repeat(64),
  newVerifiedFindingCount: 0,
  criticDigest: 'e'.repeat(64),
  saturated: true,
};
const saturatedInventoryEpochUnsigned = {
  schemaVersion: 'proofbound.review_inventory_epoch.v1' as const,
  epochId: 'B-cw-saturated:RIE-001',
  storyId: 'B-cw-saturated',
  reviewRound: 'round-1',
  state: 'FINALIZED' as const,
  begunAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:01:00.000Z',
  cutoff: saturatedInventoryCutoff,
  scopeDigest: 'f'.repeat(64),
  requiredLanes: saturatedInventoryLanes,
  maxWaves: 3,
  waves: [saturatedInventoryWave],
  receiptId: 'B-cw-saturated:RIE-001:RCP-001',
};
const saturatedInventoryEpoch = {
  ...saturatedInventoryEpochUnsigned,
  _hash: signReviewInventoryEpoch(saturatedInventoryEpochUnsigned),
};
const saturatedInventoryReceiptUnsigned = {
  schemaVersion: 'proofbound.review_inventory_receipt.v1' as const,
  receiptId: saturatedInventoryEpoch.receiptId,
  epochId: saturatedInventoryEpoch.epochId,
  storyId: saturatedInventoryEpoch.storyId,
  reviewRound: saturatedInventoryEpoch.reviewRound,
  cutoff: saturatedInventoryCutoff,
  scopeDigest: saturatedInventoryEpoch.scopeDigest,
  requiredLanes: saturatedInventoryLanes,
  waveCount: 1,
  findingSetDigest: 'd'.repeat(64),
  coverageDigest: 'g'.repeat(64),
  saturationResult: 'ZERO_NEW_VERIFIED_FINDINGS' as const,
  authority: 'inventory-completeness-only' as const,
  authorizesTest: false as const,
  issuedAt: '2026-08-20T00:01:00.000Z',
};
const saturatedInventoryReceipt = {
  ...saturatedInventoryReceiptUnsigned,
  _hash: signReviewInventoryReceipt(saturatedInventoryReceiptUnsigned),
};
assert.equal(
  isSaturatedReviewInventoryForPrecert(restoredApis, {
    epoch: saturatedInventoryEpoch,
    receipt: saturatedInventoryReceipt,
  }, saturatedInventoryEpoch.storyId),
  true,
  'a signed B-3f3d FINALIZED receipt with every terminal lane, critic, and zero-new wave is PRE_CERT-admissible input',
);
assert.equal(
  isSaturatedReviewInventoryForPrecert(restoredApis, {
    epoch: saturatedInventoryEpoch,
    receipt: { ...saturatedInventoryReceipt, _hash: '0'.repeat(64) },
  }, saturatedInventoryEpoch.storyId),
  false,
  'a tampered B-3f3d receipt must fail closed before consume',
);
assert.equal(
  isSaturatedReviewInventoryForPrecert(restoredApis, {
    epoch: { ...saturatedInventoryEpoch, waves: [], _hash: signReviewInventoryEpoch({
      ...saturatedInventoryEpochUnsigned,
      waves: [],
    }) },
    receipt: { ...saturatedInventoryReceipt, waveCount: 0, _hash: signReviewInventoryReceipt({
      ...saturatedInventoryReceiptUnsigned,
      waveCount: 0,
    }) },
  }, saturatedInventoryEpoch.storyId),
  false,
  'a signed zero-wave completeness-shaped receipt must not become PRE_CERT authority',
);

const realInventoryRoot = makeGitRoot();
const realInventoryStoryId = 'B-cw-real';
const realInventoryStore = makeStore(realInventoryRoot, realInventoryStoryId);
realInventoryStore.writeChecklist(realInventoryStoryId, { items: [] });
const realInventoryHandlers = createReviewInventoryHandlers({
  store: realInventoryStore,
  root: realInventoryRoot,
  scanRoot: join(realInventoryRoot, 'packages', 'main'),
});
const finalizedInventory = realInventoryHandlers.review_inventory_finalize({ storyId: realInventoryStoryId });
assert.match(finalizedInventory, /^State: FINALIZED$/m);
assert.match(finalizedInventory, /^headHash: /m);
assert.match(finalizedInventory, /^materialHash: /m);
assert.match(finalizedInventory, /^storyFilesHash: /m);
assert.match(finalizedInventory, /authorizesTest: false/);
const idempotentFinalize = realInventoryHandlers.review_inventory_finalize({ storyId: realInventoryStoryId });
assert.match(idempotentFinalize, /^State: FINALIZED$/m);
assert.equal(
  realInventoryStore.readReviewInventoryEpochs(realInventoryStoryId).epochs.length,
  1,
  'finalize must be idempotent on the same cutoff',
);
const realPair = restoredApis.finalizedUnconsumedReviewInventory(realInventoryStore, realInventoryStoryId);
assert.ok(realPair?.receipt?.receiptId, 'production loader must see the FINALIZED completeness receipt');
const realCutoff = {
  materialHash: realPair?.receipt?.cutoff?.materialHash ?? '',
  ...(realPair?.receipt?.cutoff?.storyFilesHash
    ? { storyFilesHash: realPair.receipt.cutoff.storyFilesHash }
    : {}),
};
const consumedViaLoader = restoredApis.consumeReviewInventoryCompletenessReceipt(
  realInventoryStore,
  realInventoryStoryId,
  realPair?.epoch?.reviewRound ?? realPair?.receipt?.reviewRound ?? '',
  realCutoff,
);
assert.equal(consumedViaLoader, realPair?.receipt?.receiptId);
assert.ok(realInventoryStore.readReviewInventoryEpochs(realInventoryStoryId).receipts[0]?.consumedAt);
assert.throws(
  () => restoredApis.consumeReviewInventoryCompletenessReceipt(
    realInventoryStore,
    realInventoryStoryId,
    realPair?.epoch?.reviewRound ?? realPair?.receipt?.reviewRound ?? '',
    realCutoff,
  ),
  /REVIEW_INVENTORY_RECEIPT_ALREADY_CONSUMED/,
);

const shippedRoot = process.cwd();
const windowSource = readFileSync(join(shippedRoot, 'packages/main/src/core/certification-window.ts'), 'utf8');
const handlerSource = readFileSync(join(shippedRoot, 'packages/main/src/handlers/done-required-validation.ts'), 'utf8');
const verifierSource = readFileSync(join(shippedRoot, 'packages/main/src/handlers/verifier.ts'), 'utf8');
assert.doesNotMatch(windowSource, /main-write-lock|acquireMainWriteLock/, 'CertificationWindow must not take the main write lock');
assert.match(handlerSource, /requireCurrentHeavyCertificationWindow/, 'DONE-required retains admission without consuming the routine execution claim');
assert.match(handlerSource, /withOfficialValidationExecution/, 'done_required_validate must retain the shared validation capacity lease');
assert.match(verifierSource, /refuseHeavyCertificationUnlessAdmitted/, 'validate --full must call the shared choke');
// Branch-wide path allowlists belong to the originating Story's review.
// This reusable runtime smoke runs in aggregated maintenance branches too.

console.log('PRE_CERT replay: routine_premature_heavy_runs=0 premature_done_required_runs=0 post_cert_source_commits=0');
console.log(prematureDone);
console.log(invalidatedStatus);
console.log('certification-window-smoke: PASS');
console.log(blockedStatus);
console.log(admittedBegin);
console.log(absentApiOutput);
console.log(noInventoryOutput);
console.log(unmergedOutput);
console.log(findingOutput);

// B-5a15:F-393 regression guard. certificationDomainForPath requires
// `matches.length === 1`, so a path matching TWO rules fails closed to undefined
// exactly like a path matching none -- and that aborts the entire
// deriveCertificationDomainInputHashes pass, which surfaces as
// certification_window_begin [pre_cert_causal_freshness_required]. The rules must
// therefore stay mutually exclusive BY HAND, and until now nothing enforced that.
//
// This bites for real: an earlier draft of the packages/*/scripts/ rule omitted its
// `(?!utils\/|lab\/)` lookahead and double-matched packages/utils/scripts/** and
// packages/lab/scripts/**. It passed every check at the time only because the story
// that introduced it touched neither package -- i.e. the defect was latent and would
// have detonated on some unrelated future story.
{
  const probePaths = [
    // one representative per declared domain
    'packages/main/tests/foo.test.mjs',
    'packages/main/src/tasks/foo.ts',
    'packages/main/src/core/foo.ts',
    'package.json',
    'packages/main/tsconfig.json',
    'proof-or-stop.config.json',
    'lattice.config.json',
    '.claude/agents/foo.md',
    '.proof-or-stop/proof-or-stop.json',
    'bin/proof-or-stop.js',
    'scripts/foo.mjs',
    '.githooks/pre-push',
    'docs/requirements/decisions/foo.md',
    'CLAUDE.md',
    'AGENTS.md',
    'README.md',
    // the packages/*/scripts/ family -- the exact shape that regressed
    'packages/utils/scripts/foo.mjs',
    'packages/lab/scripts/foo.mjs',
    'packages/graph/scripts/verify-missing-assets-fail.mjs',
    'packages/main/scripts/foo.mjs',
    // adjacent names that must NOT be caught by the utils/lab lookahead
    'packages/utils-extra/scripts/foo.mjs',
    'packages/lab-extra/scripts/foo.mjs',
    // non-scripts paths under the wholesale utils/lab rule
    'packages/utils/src/foo.ts',
    'packages/lab/src/foo.ts',
  ];
  const ambiguous: string[] = [];
  for (const probe of probePaths) {
    const hits = CERTIFICATION_DOMAIN_PATH_RULES.filter(([, pattern]) => pattern.test(probe));
    if (hits.length > 1) ambiguous.push(`${probe} -> ${hits.map(([domain]) => domain).join('+')}`);
  }
  assert.deepEqual(
    ambiguous,
    [],
    `CERTIFICATION_DOMAIN_PATH_RULES must be mutually exclusive; these paths match multiple rules and would fail closed: ${ambiguous.join(', ')}`,
  );

  // Positive control: the guard must be able to FAIL. A deliberately overlapping
  // rule set has to be detected, otherwise the assertion above proves nothing.
  const overlapping: ReadonlyArray<readonly [string, RegExp]> = [
    ['integration', /^packages\/[^/]+\/scripts\//],
    ['integration', /^packages\/(?:utils|lab)\//],
  ];
  const controlHits = overlapping.filter(([, pattern]) => pattern.test('packages/utils/scripts/foo.mjs'));
  assert.equal(controlHits.length, 2, 'positive control: overlapping rules must be observable as a double match');

  console.log('certification domain path rules: mutually exclusive across 24 probe paths (F-393 guard, with positive control)');
}

// BUG-CERT-001: use the real Git resolver and production derivation, not a
// classifier imitation. Historical inputs below are migration-only fixtures;
// live files in the retired namespace must never gain current authority.
{
  const failures: string[] = [];
  const check = (name: string, test: () => void): void => {
    try {
      test();
      console.log(`certification path regression: PASS ${name}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${detail}`);
      console.error(`certification path regression: RED ${name}: ${detail}`);
    }
  };
  const write = (dir: string, path: string, content: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const commit = (dir: string, label: string): void => {
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', label]);
  };
  const historicalRoot = '.lattice/story/actives/B-c011';
  const historicalNames = [
    'background.md', 'checklist.json', 'execution-boundary.json', 'index.json',
    'init-check.json', 'process-events.jsonl', 'scope-boundary.json', 'scope-freeze-check.json',
  ];
  const buildPaths = ['packages/lab/package-lock.json', 'packages/utils/package-lock.json'];

  check('canonical agent templates bind exact manifest blobs and reject neighboring namespaces', () => {
    const path = 'packages/main/templates/agents/proof-or-stop-review-topology-critic.md';
    assert.deepEqual(CERTIFICATION_DOMAIN_PATH_RULES.filter(([, rule]) => rule.test(path)).map(([domain]) => domain), ['manifest-semantic']);
    const dir = makeGitRoot();
    try {
      write(dir, path, 'baseline canonical role\n');
      commit(dir, 'canonical role baseline');
      git(dir, ['checkout', '-b', 'story/template-domain']);
      write(dir, path, 'changed canonical role\n');
      commit(dir, 'change canonical role');
      const changed = deriveCertificationDomainInputHashes(dir, 'HEAD', dir)!;
      assert.ok(changed);
      const entry = resolveStoryChangedFiles(dir, 'HEAD', dir).find(row => row.path === path)!;
      assert.equal(changed['certification:manifest-semantic'], causalDigest([`${path}\0${entry.blobId}`]));
      rmSync(join(dir, path));
      commit(dir, 'delete canonical role');
      const deleted = deriveCertificationDomainInputHashes(dir, 'HEAD', dir)!;
      assert.ok(deleted);
      assert.equal(deleted['certification:manifest-semantic'], causalDigest([`${path}\0<deleted>`]));
      assert.notEqual(deleted['certification:manifest-semantic'], changed['certification:manifest-semantic']);
      for (const unknown of ['packages/main/templates/unknown.md', 'packages/main/templates/agents/nested/unknown.md', 'packages/main/templates/agents/unknown.json']) {
        write(dir, unknown, 'unknown input\n');
        commit(dir, 'add unknown neighboring input');
        assert.equal(deriveCertificationDomainInputHashes(dir, 'HEAD', dir), undefined);
        rmSync(join(dir, unknown));
        commit(dir, 'remove unknown neighboring input');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  check('sibling build inputs have one domain and nearby ordinary files remain integration', () => {
    const mismatches: string[] = [];
    for (const pkg of ['lab', 'utils']) {
      for (const dir of ['', 'src/', 'scripts/']) {
        for (const name of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'tsconfig.json', 'tsconfig.build.json', 'proof-or-stop.config.json']) {
          const path = `packages/${pkg}/${dir}${name}`;
          const hits = CERTIFICATION_DOMAIN_PATH_RULES.filter(([, pattern]) => pattern.test(path)).map(([domain]) => domain);
          if (JSON.stringify(hits) !== JSON.stringify(['build-input'])) mismatches.push(`${path} => ${hits.join('+')}`);
        }
      }
      for (const name of ['package-lock.json.backup', 'scripts/check.mjs', 'src/logic.ts']) {
        const path = `packages/${pkg}/${name}`;
        assert.deepEqual(CERTIFICATION_DOMAIN_PATH_RULES.filter(([, pattern]) => pattern.test(path)).map(([domain]) => domain),
          ['integration'], `nearby non-build input remains integration: ${path}`);
      }
    }
    assert.deepEqual(mismatches, [], `ambiguous sibling build inputs: ${mismatches.join('; ')}`);
  });

  check('current build roots retain unique classification and actual blob hashes', () => {
    const paths = ['', 'bin/', 'scripts/', '.githooks/', 'packages/main/', 'packages/graph/', 'packages/graph/scripts/']
      .flatMap(prefix => ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
        'tsconfig.json', 'tsconfig.build.json', 'proof-or-stop.config.json'].map(name => `${prefix}${name}`));
    for (const path of paths) {
      assert.deepEqual(CERTIFICATION_DOMAIN_PATH_RULES.filter(([, pattern]) => pattern.test(path)).map(([domain]) => domain),
        ['build-input'], `current build input must have exactly one domain: ${path}`);
    }
    const dir = makeGitRoot();
    try {
      git(dir, ['checkout', '-b', 'story/B-c011']);
      for (const path of paths) write(dir, path, `${JSON.stringify({
        storyDir: '.proof-or-stop/story/actives', storyPrefix: 'B', fixture: path,
      })}\n`);
      commit(dir, 'exercise current build roots');
      const entries = resolveStoryChangedFiles(dir, 'HEAD', dir);
      assert.deepEqual(entries.map(entry => entry.path).sort(), [...paths].sort());
      const hashes = deriveCertificationDomainInputHashes(dir, 'HEAD', dir);
      assert.ok(hashes, 'legitimate root, package and integration build inputs must remain admitted');
      assert.equal(hashes['certification:build-input'], causalDigest(entries.map(entry => `${entry.path}\0${entry.blobId}`).sort()),
        'every admitted current build input must bind its actual Git blob');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  check('release provenance ledgers bind actual added, modified and deleted Git inputs', () => {
    for (const path of ['.proof-or-stop/artifact-releases.jsonl', '.proof-or-stop/capability-releases.jsonl']) {
      assert.deepEqual(CERTIFICATION_DOMAIN_PATH_RULES.filter(([, pattern]) => pattern.test(path)).map(([domain]) => domain),
        ['review-subject'], `release ledger must have exactly one review-subject domain: ${path}`);
      for (const action of ['added', 'modified', 'deleted'] as const) {
        const dir = makeGitRoot();
        try {
          if (action !== 'added') {
            write(dir, path, '{"fixture":"baseline provenance"}\n');
            commit(dir, 'baseline release provenance');
          }
          git(dir, ['checkout', '-b', 'story/B-c011']);
          if (action === 'deleted') rmSync(join(dir, path));
          else write(dir, path, '{"fixture":"current provenance"}\n');
          commit(dir, `exercise ${action} release provenance`);
          const entries = resolveStoryChangedFiles(dir, 'HEAD', dir);
          assert.equal(entries.length, 1, 'fixture must exercise only its exact release ledger');
          assert.equal(entries[0].path, path);
          assert.equal(entries[0].status, action);
          if (action === 'deleted') assert.equal(entries[0].blobId, '<deleted>');
          const hashes = deriveCertificationDomainInputHashes(dir, 'HEAD', dir);
          assert.ok(hashes, 'tracked release provenance must not strand certification');
          assert.equal(hashes['certification:review-subject'], causalDigest(entries.map(entry => `${entry.path}\0${entry.blobId}`).sort()),
            'release provenance binds the actual Git blob or deletion tombstone');
          if (action !== 'deleted') {
            const frozen = {
              headHash: currentGitHead(dir)!, materialHash: currentMaterialHash(dir, 'HEAD', dir)!,
              storyFilesHash: currentStoryFilesHash(dir, 'HEAD', dir)!, causalInputHashes: hashes,
              expectedMainSha: git(dir, ['rev-parse', 'main']), verifierIdentity: 'proof-or-stop:done_required_validate',
              testIdentity: 'npm test',
            };
            write(dir, path, '{"fixture":"changed provenance bytes"}\n');
            commit(dir, 'change release provenance bytes');
            const changed = deriveCertificationDomainInputHashes(dir, 'HEAD', dir)!;
            assert.ok(changed);
            assert.notEqual(changed['certification:review-subject'], hashes['certification:review-subject']);
            for (const domain of Object.keys(hashes).filter(key => key !== 'certification:review-subject')) {
              assert.equal(changed[domain], hashes[domain], `release provenance must not alter unrelated direct input ${domain}`);
            }
            const decision = buildCertificationDecision('B-c011', {
              headHash: currentGitHead(dir), materialHash: currentMaterialHash(dir, 'HEAD', dir),
              storyFilesHash: currentStoryFilesHash(dir, 'HEAD', dir), causalInputHashes: changed,
            }, frozen);
            assert.deepEqual(decision?.affectedNodeIds,
              ['certification-integration', 'certification-review-subject', 'certification-test'],
              'release provenance drift must invalidate the complete integration/test dependent closure');
            assert.equal(decision?.gateAdmissible, false, 'changed provenance must not reuse certification without reruns');
          }
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }
    }
  });

  check('release ledger near misses remain unclassified', () => {
    for (const path of ['.proof-or-stop/artifact-releases.jsonl.backup', '.proof-or-stop/capability-releases.jsonl/child',
      '.proof-or-stop/nested/artifact-releases.jsonl', '.proof-or-stop/other-releases.jsonl',
      '.lattice/artifact-releases.jsonl', '.proof-or-stop-extra/capability-releases.jsonl']) {
      const dir = makeGitRoot();
      try {
        git(dir, ['checkout', '-b', 'story/B-c011']);
        write(dir, path, 'unknown provenance-shaped path\n');
        commit(dir, 'exercise release ledger near miss');
        assert.ok(resolveStoryChangedFiles(dir, 'HEAD', dir).some(entry => entry.path === path));
        assert.equal(deriveCertificationDomainInputHashes(dir, 'HEAD', dir), undefined,
          `a familiar ledger name must not authorize an unknown path: ${path}`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  check('build-like basenames do not admit unknown namespaces', () => {
    const unexpectedAdmissions: string[] = [];
    for (const path of ['unknown-build/package.json', 'unknown-build/nested/tsconfig.json',
      '.unrecognized/package.json', '.unrecognized/nested/tsconfig.build.json',
      'packages-extra/package.json', 'scripts-extra/tsconfig.json']) {
      const dir = makeGitRoot();
      try {
        git(dir, ['checkout', '-b', 'story/B-c011']);
        write(dir, path, 'an unknown namespace is not a current build surface\n');
        commit(dir, 'exercise unknown build-like path');
        assert.equal(resolveStoryChangedFiles(dir, 'HEAD', dir).find(entry => entry.path === path)?.status, 'added');
        if (deriveCertificationDomainInputHashes(dir, 'HEAD', dir) !== undefined) unexpectedAdmissions.push(path);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    assert.deepEqual(unexpectedAdmissions, [], 'BUG-CERT-002: a familiar basename must not authorize an unknown namespace');
  });

  check('real deleted and renamed migration inputs retain exact tombstone and blob hashes', () => {
    const dir = makeGitRoot();
    try {
      for (const name of historicalNames) write(dir, `${historicalRoot}/${name}`, `unique historical ${name}\n`);
      const laterTombstone = '.lattice/story/actives/B-c012/background.md';
      write(dir, laterTombstone, 'a separate retained historical subject\n');
      for (const path of buildPaths) write(dir, path, '{"fixture":"baseline"}\n');
      commit(dir, 'baseline historical metadata and sibling build inputs');
      git(dir, ['checkout', '-b', 'story/B-c011']);
      const renamed = new Set(['background.md', 'execution-boundary.json', 'scope-boundary.json', 'scope-freeze-check.json']);
      for (const name of historicalNames) {
        const oldPath = `${historicalRoot}/${name}`;
        if (renamed.has(name)) {
          const currentPath = `.proof-or-stop/story/actives/B-c011/${name}`;
          mkdirSync(dirname(join(dir, currentPath)), { recursive: true });
          renameSync(join(dir, oldPath), join(dir, currentPath));
        } else rmSync(join(dir, oldPath));
      }
      for (const path of buildPaths) write(dir, path, '{"fixture":"current"}\n');
      commit(dir, 'migrate retained old metadata and change sibling lockfiles');
      const entries = resolveStoryChangedFiles(dir, 'HEAD', dir);
      const oldEntries = entries.filter(entry => entry.path.startsWith(`${historicalRoot}/`));
      assert.equal(oldEntries.length, historicalNames.length, 'the actual resolver must retain every historical old-side path');
      assert.equal(oldEntries.filter(entry => entry.status === 'deleted').length, 4);
      assert.equal(oldEntries.filter(entry => entry.status === 'renamed' && entry.oldPath === entry.path).length, 4);
      assert.ok(oldEntries.every(entry => entry.blobId === '<deleted>'));
      const hashes = deriveCertificationDomainInputHashes(dir, 'HEAD', dir);
      assert.ok(hashes, 'known migration tombstones and sibling lockfiles must produce complete causal hashes');
      assert.equal(hashes['certification:review-subject'], causalDigest(oldEntries.map(entry => `${entry.path}\0<deleted>`).sort()),
        'no historical path may be discarded from the review-subject digest');
      assert.equal(hashes['certification:build-input'], causalDigest(entries.filter(entry => buildPaths.includes(entry.path))
        .map(entry => `${entry.path}\0${entry.blobId}`).sort()), 'sibling build inputs bind the real current Git blobs');

      write(dir, buildPaths[0], '{"fixture":"changed bytes"}\n');
      commit(dir, 'change actual build input blob');
      const changed = deriveCertificationDomainInputHashes(dir, 'HEAD', dir)!;
      assert.ok(changed);
      assert.notEqual(changed['certification:build-input'], hashes['certification:build-input'], 'content drift changes its causal hash');
      assert.equal(changed['certification:review-subject'], hashes['certification:review-subject']);
      rmSync(join(dir, buildPaths[1]));
      commit(dir, 'delete actual build input');
      const deleted = deriveCertificationDomainInputHashes(dir, 'HEAD', dir)!;
      assert.ok(deleted);
      assert.notEqual(deleted['certification:build-input'], changed['certification:build-input'], 'a deletion cannot reuse the live blob digest');
      assert.equal(resolveStoryChangedFiles(dir, 'HEAD', dir).find(entry => entry.path === buildPaths[1])?.blobId, '<deleted>');
      rmSync(join(dir, laterTombstone));
      commit(dir, 'retain another historical migration tombstone');
      const extended = deriveCertificationDomainInputHashes(dir, 'HEAD', dir)!;
      assert.ok(extended);
      assert.notEqual(extended['certification:review-subject'], deleted['certification:review-subject'], 'changing the tombstone path set changes its causal hash');
      assert.equal(extended['certification:build-input'], deleted['certification:build-input']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  check('unknown paths, near misses and live retired-namespace files fail closed', () => {
    const scenarios: Array<{ path: string; action: 'added' | 'modified' | 'renamed' | 'deleted' }> = [
      { path: `${historicalRoot}/background.md`, action: 'added' },
      { path: `${historicalRoot}/checklist.json`, action: 'modified' },
      { path: `${historicalRoot}/background.md`, action: 'renamed' },
      { path: `${historicalRoot}/findings.json`, action: 'deleted' },
      { path: `${historicalRoot}/nested/background.md`, action: 'deleted' },
      { path: '.lattice/story/archives/B-c011/background.md', action: 'deleted' },
      { path: '.lattice-other/story/actives/B-c011/background.md', action: 'deleted' },
      { path: '.lattice/story/actives/not-a-story/background.md', action: 'deleted' },
      { path: 'unclassified-input.txt', action: 'added' },
      ...(['package.json', 'tsconfig.json'] as const).flatMap(name =>
        (['added', 'modified', 'renamed', 'deleted'] as const).map(action => ({ path: `${historicalRoot}/nested/${name}`, action }))),
    ];
    for (const { path, action } of scenarios) {
      const dir = makeGitRoot();
      try {
        const before = action === 'renamed' ? 'docs/old-copy.md' : path;
        if (action !== 'added') {
          write(dir, before, 'original historical bytes\n');
          commit(dir, 'seed negative control');
        }
        git(dir, ['checkout', '-b', 'story/B-c011']);
        if (action === 'deleted') rmSync(join(dir, path));
        else if (action === 'renamed') {
          mkdirSync(dirname(join(dir, path)), { recursive: true });
          renameSync(join(dir, before), join(dir, path));
        } else write(dir, path, 'new untrusted live bytes\n');
        commit(dir, 'exercise fail-closed path control');
        const entry = resolveStoryChangedFiles(dir, 'HEAD', dir).find(candidate => candidate.path === path);
        assert.equal(entry?.status, action, `real resolver must exercise ${action} ${path}`);
        assert.equal(deriveCertificationDomainInputHashes(dir, 'HEAD', dir), undefined,
          `${action} ${path} must not be silently skipped or admitted as a migration tombstone`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
  assert.deepEqual(failures, [], 'BUG-CERT-001: every real path regression must pass');
  console.log('certification migration and sibling build-input regression: PASS');
}
