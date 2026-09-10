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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { CERTIFICATION_DOMAIN_PATH_RULES, deriveCertificationDomainInputHashes, buildCertificationDecision } from '../handlers/certification-window.js';
import { causalDigest } from '../core/causal-evidence.js';
import { resolveStoryChangedFiles } from '../core/story-aware-validation.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';
import { PROCESS_FACT_REGISTRY } from '../core/process-fact-registry.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { createCertificationWindowHandlers } from '../handlers/certification-window.js';
import { createReviewInventoryHandlers } from '../handlers/review-inventory.js';
import { createDoneRequiredValidationHandlers } from '../handlers/done-required-validation.js';
import { safeDoneRequiredRecoveryCommand } from '../handlers/done-prepare.js';
import { createVerifierHandlers } from '../handlers/verifier.js';
import { computeActiveReviewers } from '../handlers/reviewer-list.js';
import { buildVerificationCoverage } from '../core/verification.js';
import {
  createCurrentVerificationAssertionReceipt,
  captureVerificationFreshness,
  createVerificationExecutionReceipt,
} from '../core/verification-execution-evidence.js';
import { runSingleAllowlistedCommand } from '../core/validation-executor.js';
import {
  CERTIFICATION_WINDOW_FILE,
  CERTIFICATION_WINDOW_STATES,
  INVENTORY_COMPLETENESS_AUTHORITY,
  PRE_CERT_BLOCKING_FINDINGS_OPEN,
  PRE_CERT_COVERAGE_MISSING,
  PRE_CERT_DIRTY_TREE,
  PRE_CERT_INVENTORY_API_ABSENT,
  PRE_CERT_INVENTORY_NOT_FINALIZED,
  PRE_CERT_INVENTORY_PROBE_FAILED,
  PRE_CERT_MAIN_NOT_MERGED,
  PRE_CERT_WINDOW_REQUIRED,
  PRE_CERT_WINDOW_TAMPERED,
  PRECERT_TEST_IDENTITY,
  PRECERT_VERIFIER_IDENTITY,
  detectCertificationWindowMaterialDrift,
  isOfficialHeavyValidateInvocation,
  emptyCertificationWindowData,
  evaluateCertificationWindowAdmit,
  inventoryReceiptAuthorizesPrecert,
  loadReviewInventoryAdmitApis,
  persistBlockedCertificationWindow,
  nextPrecertReceiptId,
  projectCertificationWindowStatus,
  renderCertificationWindowStatus,
  setReviewInventoryAdmitApisForTest,
  verifyCertificationWindow,
  verifyPrecertReceipt,
  windowAuthorizesHeavyCertification,
  withSignedCertificationWindow,
  withSignedPrecertReceipt,
  type CertificationWindow,
  type CertificationWindowAdmitFacts,
  type PrecertReceipt,
  type ReviewInventoryAdmitApis,
} from '../core/certification-window.js';

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
  return store;
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
  authority: INVENTORY_COMPLETENESS_AUTHORITY,
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
  schemaVersion: 'proof-or-stop.certification_window.v1',
  windowId: `${admittedStoryId}:CW-001`,
  storyId: admittedStoryId,
  state: 'ADMITTED',
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
  frozen,
  receiptId: nextPrecertReceiptId(admittedData, admittedStoryId),
});
const admittedReceipt: PrecertReceipt = withSignedPrecertReceipt({
  schemaVersion: 'proof-or-stop.precert_receipt.v1',
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
  schemaVersion: 'proof-or-stop.certification_window.v1',
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
  schemaVersion: 'proof-or-stop.certification_window.v1',
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

for (const name of ['certification_window_begin', 'certification_window_status', 'certification_window_cancel']) {
  const level = PROCESS_FACT_LEVELS.find(entry => entry.name === name);
  assert.ok(level, `${name} missing from PROCESS_FACT_LEVELS`);
  assert.equal(level?.level, 'L4');
  assert.ok(level?.gateConsumer?.includes('PRE_CERT certification-window gate'));
  const policy = COMMAND_POLICIES[name as keyof typeof COMMAND_POLICIES];
  assert.equal(policy.status, 'gateEvidence');
  assert.equal(policy.gateEvidence, true);
  const registry = PROCESS_FACT_REGISTRY.find(entry => entry.name === name);
  assert.ok(registry, `${name} missing from PROCESS_FACT_REGISTRY`);
  assert.equal(registry?.level, 'L4');
  assert.equal(registry?.artifact?.path, 'certification-window.json');
  assert.equal(registry?.artifact?.signed, true);
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
        cutoff: { materialHash: 'm'.repeat(64), storyFilesHash: 's'.repeat(64) },
      },
      receipt: {
        receiptId: 'INV-1',
        storyId: 'B-cw10',
        reviewRound: 'round-1',
        authority: INVENTORY_COMPLETENESS_AUTHORITY,
        authorizesTest: false,
        cutoff: { materialHash: 'm'.repeat(64), storyFilesHash: 's'.repeat(64) },
      },
    },
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

const missingApiDecision = evaluateCertificationWindowAdmit(baseAdmitFacts({ inventoryApisPresent: false }));
assert.equal(missingApiDecision.admit, false);
assert.equal(missingApiDecision.blockerCode, PRE_CERT_INVENTORY_NOT_FINALIZED);
assert.match(String(missingApiDecision.blockerDetail), new RegExp(`\\[${PRE_CERT_INVENTORY_API_ABSENT}\\]`));

const missingInventory = evaluateCertificationWindowAdmit(baseAdmitFacts({ inventory: null }));
assert.equal(missingInventory.admit, false);
assert.equal(missingInventory.blockerCode, PRE_CERT_INVENTORY_NOT_FINALIZED);

const wholeTreeDrift = evaluateCertificationWindowAdmit(baseAdmitFacts({
  materialHash: 'z'.repeat(64),
}));
assert.equal(wholeTreeDrift.admit, false, 'materialHash-only drift must not admit');
assert.equal(wholeTreeDrift.blockerCode, PRE_CERT_INVENTORY_NOT_FINALIZED);
assert.match(String(wholeTreeDrift.blockerDetail), /Whole-tree materialHash drift/);

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

function mockInventoryApis(args: {
  storyId: string;
  materialHash: string;
  storyFilesHash: string;
  otherStoryId?: string;
  driftedMaterialHash?: string;
}): { apis: ReviewInventoryAdmitApis; consumed: string[] } {
  const consumed: string[] = [];
  const inventoryStoryId = args.otherStoryId ?? args.storyId;
  const materialHash = args.driftedMaterialHash ?? args.materialHash;
  const apis: ReviewInventoryAdmitApis = {
    finalizedUnconsumedReviewInventory: () => ({
      epoch: {
        epochId: 'epoch-1',
        storyId: inventoryStoryId,
        reviewRound: 'round-1',
        state: 'FINALIZED',
        receiptId: 'INV-1',
        cutoff: { materialHash, storyFilesHash: args.storyFilesHash },
      },
      receipt: {
        receiptId: 'INV-1',
        epochId: 'epoch-1',
        storyId: inventoryStoryId,
        reviewRound: 'round-1',
        authority: INVENTORY_COMPLETENESS_AUTHORITY,
        authorizesTest: false,
        cutoff: { materialHash, storyFilesHash: args.storyFilesHash },
      },
    }),
    consumeReviewInventoryCompletenessReceipt: () => {
      consumed.push('INV-1');
      return 'INV-1';
    },
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
const admitHead = currentGitHead(gitRoot);
const admitMaterial = currentMaterialHash(gitRoot, 'HEAD', gitRoot);
const admitStoryFiles = currentStoryFilesHash(gitRoot, 'HEAD', gitRoot);
assert.ok(admitHead && admitMaterial && admitStoryFiles, 'git-backed hashes must resolve');
const admitMock = mockInventoryApis({
  storyId: admitStoryId,
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
assert.match(admittedBegin, new RegExp(`^Next: proof-or-stop done_required_validate --storyId=${admitStoryId}$`, 'm'));
assert.match(admittedBegin, new RegExp(`^headHash: ${admitHead}$`, 'm'));
assert.match(admittedBegin, /^expectedMainSha: /m);
assert.match(admittedBegin, new RegExp(`^storyFilesHash: ${admitStoryFiles}$`, 'm'));
assert.deepEqual(admitMock.consumed, ['INV-1']);
const admittedOnDisk = admitStore.readCertificationWindows(admitStoryId);
assert.equal(admittedOnDisk.windows.at(-1)?.inventory?.epochId, 'epoch-1');
assert.equal(admittedOnDisk.windows.at(-1)?.inventory?.receiptId, 'INV-1');

const headDriftRoot = makeGitRoot();
const headDriftStoryId = 'B-cw24';
const headDriftStore = makeStore(headDriftRoot, headDriftStoryId);
const headDriftStoryFiles = currentStoryFilesHash(headDriftRoot, 'HEAD', headDriftRoot)!;
const headDriftMaterial = currentMaterialHash(headDriftRoot, 'HEAD', headDriftRoot)!;
const headDriftSelector = 'CERTIFICATION_COVERAGE_OK';
const headDriftCommand = `node -e "console.log('${headDriftSelector}')"`;
const headDriftFreshness = captureVerificationFreshness(headDriftRoot, headDriftRoot);
const headDriftRun = await runSingleAllowlistedCommand(headDriftCommand, headDriftRoot, { cwd: headDriftRoot, timeoutMs: 120_000 });
const headDriftExecution = createVerificationExecutionReceipt({
  projectRoot: headDriftRoot,
  storyId: headDriftStoryId,
  command: headDriftCommand,
  cwd: headDriftRoot,
  run: headDriftRun,
});
const headDriftReceipt = createCurrentVerificationAssertionReceipt({
  freshness: headDriftFreshness,
  projectRoot: headDriftRoot,
  storyId: headDriftStoryId,
  executionReceipt: headDriftExecution,
  intentRef: 'CHK-001:happy:0',
  selector: headDriftSelector,
});
headDriftStore.writeChecklist(headDriftStoryId, {
  items: [{
    id: 'CHK-001',
    title: 'headHash-only drift coverage',
    context: 'collectAdmitFacts must not treat matching storyFilesHash as missing',
    status: 'done',
    startTime: null,
    endTime: null,
    verificationIntent: {
      happy: [{
        desc: 'mechanical coverage stays fresh',
        type: 'logic',
        priority: 'must',
        verification: { command: headDriftCommand, selector: headDriftSelector },
      }],
      edge: [],
      adversarial: [],
    },
    verificationEvidence: [{
      intentRef: 'CHK-001:happy:0',
      kind: 'logic_test',
      mechanical: true,
      receipt: headDriftReceipt,
      command: headDriftCommand,
      result: 'pass',
      note: 'headHash-only drift fixture with authoritative V5 bundle and V3 execution component',
      headHash: headDriftFreshness.headHash,
      materialHash: headDriftMaterial,
      storyFilesHash: headDriftStoryFiles,
    }],
  }],
});
git(headDriftRoot, ['commit', '--allow-empty', '-m', 'actual metadata-only head drift after execution']);
const headDriftMock = mockInventoryApis({
  storyId: headDriftStoryId,
  materialHash: headDriftMaterial,
  storyFilesHash: headDriftStoryFiles,
});
setReviewInventoryAdmitApisForTest(headDriftMock.apis);
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
  materialHash: currentMaterialHash(unmergedRoot, 'HEAD', unmergedRoot)!,
  storyFilesHash: currentStoryFilesHash(unmergedRoot, 'HEAD', unmergedRoot)!,
});
setReviewInventoryAdmitApisForTest(unmergedMock.apis);
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
  materialHash: currentMaterialHash(findingRoot, 'HEAD', findingRoot)!,
  storyFilesHash: currentStoryFilesHash(findingRoot, 'HEAD', findingRoot)!,
});
setReviewInventoryAdmitApisForTest(findingMock.apis);
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
  materialHash: currentMaterialHash(dirtyRoot, 'HEAD', dirtyRoot)!,
  storyFilesHash: currentStoryFilesHash(dirtyRoot, 'HEAD', dirtyRoot)!,
});
setReviewInventoryAdmitApisForTest(dirtyMock.apis);
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
assert.equal(isOfficialHeavyValidateInvocation({}), false);
assert.equal(isOfficialHeavyValidateInvocation({ full: true }), true);
assert.equal(isOfficialHeavyValidateInvocation({ full: 'filter' }), true);

const heavyMarker = 'HEAVY_RAN';
function writeHeavyConfig(dir: string, commit = false): void {
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify({
    storyDir: '.proof-or-stop/story/actives',
    storyPrefix: 'B',
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
  finalizedUnconsumedReviewInventory: () => null,
  consumeReviewInventoryCompletenessReceipt: () => null,
});
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

setReviewInventoryAdmitApisForTest({
  finalizedUnconsumedReviewInventory: () => {
    throw new Error('inventory store unreadable');
  },
  consumeReviewInventoryCompletenessReceipt: () => null,
});
const failedInventoryProbe = await caught(() => chokeValidate.validate({ storyId: chokeStoryId, full: true }));
assert.match(failedInventoryProbe, new RegExp(`\\[${PRE_CERT_INVENTORY_PROBE_FAILED}\\]`));
assert.match(failedInventoryProbe, /Review Inventory probe failed: inventory store unreadable/);
assert.match(failedInventoryProbe, new RegExp(`Next: proof-or-stop certification_window_status --storyId=${chokeStoryId}`));
assert.doesNotMatch(failedInventoryProbe, new RegExp(`Next: proof-or-stop certification_window_begin --storyId=${chokeStoryId}`));
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
const routineValidate = await caught(() => chokeValidate.validate({ storyId: chokeStoryId }));
assert.doesNotMatch(routineValidate, new RegExp(`\\[${PRE_CERT_WINDOW_REQUIRED}\\]`));

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
  materialHash: replayMaterial,
  storyFilesHash: replayStoryFiles,
});
setReviewInventoryAdmitApisForTest(replayMock.apis);
const replayWindowHandlers = createCertificationWindowHandlers({
  store: replayStore,
  root: replayRoot,
  scanRoot: join(replayRoot, 'packages', 'main'),
});
const replayAdmit = replayWindowHandlers.certification_window_begin({ storyId: replayStoryId });
assertStatusSurface(replayAdmit, 'ADMITTED');
const admittedReceiptHash = replayStore.readCertificationWindows(replayStoryId).receipts.at(-1)?._hash;
const admittedFrozen = structuredClone(replayStore.readCertificationWindows(replayStoryId).receipts.at(-1)?.frozen);
const replayDone = createDoneRequiredValidationHandlers({
  store: replayStore,
  root: replayRoot,
  scanRoot: join(replayRoot, 'packages', 'main'),
  log: () => {},
});
const admittedHeavy = await caught(() => replayDone.done_required_validate({ storyId: replayStoryId }));
assert.doesNotMatch(admittedHeavy, new RegExp(`\\[${PRE_CERT_WINDOW_REQUIRED}\\]`));
assert.equal(existsSync(join(replayRoot, heavyMarker)), true, 'admitted window may start the official heavy command');
const beforeRunningStatus = structuredClone(replayStore.readCertificationWindows(replayStoryId));
const runningStatus = replayWindowHandlers.certification_window_status({ storyId: replayStoryId });
assertStatusSurface(runningStatus, 'RUNNING');
assert.deepEqual(
  replayStore.readCertificationWindows(replayStoryId),
  beforeRunningStatus,
  'no-drift certification status must stay read-only',
);
const runningWindow = replayStore.readCertificationWindows(replayStoryId).windows.at(-1);
const runningReceipt = replayStore.readCertificationWindows(replayStoryId).receipts.at(-1);
assert.ok(runningWindow && runningReceipt, 'admitted heavy must keep a signed receipt');
assert.equal(
  windowAuthorizesHeavyCertification(runningWindow, runningReceipt),
  true,
  'heavy start must stay bound to the frozen receipt identity',
);
assert.deepEqual(runningReceipt.frozen, runningWindow.frozen);
assert.equal(runningReceipt.frozen.verifierIdentity, PRECERT_VERIFIER_IDENTITY);
assert.equal(runningReceipt.frozen.testIdentity, PRECERT_TEST_IDENTITY);

writeFileSync(join(replayRoot, '.proof-or-stop', 'story', 'actives', replayStoryId, 'note.md'), 'metadata-only\n');
git(replayRoot, ['add', `.proof-or-stop/story/actives/${replayStoryId}/note.md`]);
git(replayRoot, ['commit', '-m', 'metadata-only']);
const metadataStatus = replayWindowHandlers.certification_window_status({ storyId: replayStoryId });
assertStatusSurface(metadataStatus, 'RUNNING');

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
  materialHash: currentMaterialHash(selectiveRoot, 'HEAD', selectiveRoot)!,
  storyFilesHash: currentStoryFilesHash(selectiveRoot, 'HEAD', selectiveRoot)!,
});
setReviewInventoryAdmitApisForTest(selectiveMock.apis);
const selectiveHandlers = createCertificationWindowHandlers({
  store: selectiveStore,
  root: selectiveRoot,
  scanRoot: join(selectiveRoot, 'packages', 'main'),
});
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
assertStatusSurface(selectiveHandlers.certification_window_status({ storyId: selectiveStoryId, refresh: true }), 'INVALIDATED');

mkdirSync(join(replayRoot, 'src'), { recursive: true });
mkdirSync(join(replayRoot, 'tests'), { recursive: true });
writeFileSync(join(replayRoot, 'src', 'app.ts'), 'export const n = 1;\n');
writeFileSync(join(replayRoot, 'tests', 'app.test.ts'), 'export const t = 1;\n');
git(replayRoot, ['add', 'src/app.ts', 'tests/app.test.ts']);
git(replayRoot, ['commit', '-m', 'source and test change']);
const beforeDriftStatus = structuredClone(replayStore.readCertificationWindows(replayStoryId));
const driftStatus = replayWindowHandlers.certification_window_status({ storyId: replayStoryId });
assertStatusSurface(driftStatus, 'RUNNING');
assert.match(driftStatus, /^Blocker: \[pre_cert_window_invalidated\]$/m);
assert.match(driftStatus, /^Observed drift: /m);
assert.match(driftStatus, new RegExp(`^Next: proof-or-stop certification_window_status --storyId=${replayStoryId} --refresh=true$`, 'm'));
assert.deepEqual(
  replayStore.readCertificationWindows(replayStoryId),
  beforeDriftStatus,
  'default drift status must report without persisting INVALIDATED',
);
const invalidatedStatus = replayWindowHandlers.certification_window_status({ storyId: replayStoryId, refresh: true });
assertStatusSurface(invalidatedStatus, 'INVALIDATED');
assert.match(invalidatedStatus, /^Next: proof-or-stop story_advance .* --phase=REVIEW$/m);
const afterReceipt = replayStore.readCertificationWindows(replayStoryId).receipts.at(-1);
assert.equal(afterReceipt?._hash, admittedReceiptHash, 'stored receipt hash must not be rewritten');
assert.deepEqual(afterReceipt?.frozen, admittedFrozen, 'stored receipt frozen identity must keep original hashes');

const postCertHeavy = await caught(() => replayDone.done_required_validate({ storyId: replayStoryId }));
assert.match(postCertHeavy, new RegExp(`\\[${PRE_CERT_WINDOW_REQUIRED}\\]`));

const verifierDrift = detectCertificationWindowMaterialDrift(runningWindow!, {
  materialHash: runningWindow!.frozen?.materialHash,
  storyFilesHash: runningWindow!.frozen?.storyFilesHash,
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

const testIdentityDrift = detectCertificationWindowMaterialDrift(runningWindow!, {
  materialHash: runningWindow!.frozen?.materialHash,
  storyFilesHash: runningWindow!.frozen?.storyFilesHash,
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
assert.match(handlerSource, /refuseHeavyCertificationUnlessAdmitted/, 'done_required_validate must call the shared choke');
assert.match(verifierSource, /refuseHeavyCertificationUnlessAdmitted/, 'validate --full must call the shared choke');
const branchFiles = execFileSync('git', ['diff', '--name-only', 'main...HEAD'], {
  cwd: shippedRoot,
  encoding: 'utf8',
});
assert.doesNotMatch(
  branchFiles,
  /review-escalation|three-round-two-host|quorum-submit\.ts|host-quorum/,
  'this story must not weaken host-quorum or reviewer-lane policy files',
);

console.log('PRE_CERT replay: premature_heavy_runs=0 admitted_heavy_runs=1 post_cert_source_commits=0');
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
