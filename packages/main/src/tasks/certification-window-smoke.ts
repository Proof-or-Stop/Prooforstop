#!/usr/bin/env node
/**
 * B-1e1f CHK-001: CertificationWindow signed process-fact smoke.
 *
 * Covers status surface, process-fact registration, tamper fail-closed,
 * and the inventory-receipt-is-not-PRE_CERT fence. Begin stays fail-closed
 * when B-3f3d inventory APIs are absent.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';
import { PROCESS_FACT_REGISTRY } from '../core/process-fact-registry.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { createCertificationWindowHandlers } from '../handlers/certification-window.js';
import {
  CERTIFICATION_WINDOW_FILE,
  CERTIFICATION_WINDOW_STATES,
  INVENTORY_COMPLETENESS_AUTHORITY,
  PRE_CERT_INVENTORY_API_ABSENT,
  PRE_CERT_WINDOW_TAMPERED,
  emptyCertificationWindowData,
  inventoryReceiptAuthorizesPrecert,
  loadReviewInventoryAdmitApis,
  nextPrecertReceiptId,
  projectCertificationWindowStatus,
  renderCertificationWindowStatus,
  verifyCertificationWindow,
  verifyPrecertReceipt,
  windowAuthorizesHeavyCertification,
  withSignedCertificationWindow,
  withSignedPrecertReceipt,
  type CertificationWindow,
  type PrecertReceipt,
} from '../core/certification-window.js';

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lattice-certification-window-smoke-'));
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    storyDir: '.lattice/story/actives',
    storyPrefix: 'B',
  }));
  return root;
}

function makeStore(root: string, storyId: string): StoryStore {
  const store = new StoryStore(root);
  mkdirSync(join(root, '.lattice', 'story', 'actives', storyId), { recursive: true });
  store.writeStory(storyId, {
    storyId,
    name: 'certification-window-smoke',
    title: 'Certification window smoke',
    description: 'Smoke test story',
    type: 'feature',
    phase: 'DEV',
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
assert.equal(beginFailed, true, 'begin must fail-closed when inventory APIs are absent');
assertStatusSurface(beginOutput, 'BLOCKED');
assert.match(beginOutput, new RegExp(`\\[${PRE_CERT_INVENTORY_API_ABSENT}\\]`));
assert.doesNotMatch(beginOutput, /^State: ADMITTED$/m);
assert.equal(loadReviewInventoryAdmitApis(), null, 'this worktree must not stub inventory admit APIs');

const blockedStatus = handlers.certification_window_status({ storyId });
assertStatusSurface(blockedStatus, 'BLOCKED');
assert.doesNotMatch(blockedStatus, /^headHash:/m);
assert.doesNotMatch(blockedStatus, /^expectedMainSha:/m);
assert.doesNotMatch(blockedStatus, /^storyFilesHash:/m);

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
const filePath = join(root, '.lattice', 'story', 'actives', tamperStoryId, CERTIFICATION_WINDOW_FILE);
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

console.log('certification-window-smoke: PASS');
console.log(blockedStatus);
