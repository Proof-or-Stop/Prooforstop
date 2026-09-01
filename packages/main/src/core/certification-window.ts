import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from './evidence-freshness.js';
import { withMkdirLock } from './mkdir-lock.js';
import {
  causalDependencyDecisionMatchesCurrentIdentity,
  verifyCausalDependencyDecision,
  type CausalDependencyDecision,
} from './causal-evidence.js';

export const CERTIFICATION_WINDOW_STATES = [
  'BLOCKED',
  'ADMITTED',
  'RUNNING',
  'FINALIZED',
  'INVALIDATED',
  'CANCELLED',
] as const;

export type CertificationWindowState = (typeof CERTIFICATION_WINDOW_STATES)[number];

export const CERTIFICATION_WINDOW_SCHEMA = 'proofbound.certification_window.v1';
export const PRECERT_RECEIPT_SCHEMA = 'proofbound.precert_receipt.v1';
export const CERTIFICATION_WINDOW_FILE_SCHEMA = 'proofbound.certification_windows.v1';
export const CERTIFICATION_WINDOW_FILE = 'certification-window.json';

const WINDOW_DOMAIN = 'proofbound.certification-window.v1';
const RECEIPT_DOMAIN = 'proofbound.precert-receipt.v1';

export const PRECERT_AUTHORITY = 'pre-cert';
export const INVENTORY_COMPLETENESS_AUTHORITY = 'inventory-completeness-only';

export const PRE_CERT_INVENTORY_API_ABSENT = 'pre_cert_inventory_api_absent';
export const PRE_CERT_INVENTORY_NOT_FINALIZED = 'pre_cert_inventory_not_finalized';
export const PRE_CERT_INVENTORY_PROBE_FAILED = 'pre_cert_inventory_probe_failed';
export const PRE_CERT_MAIN_NOT_MERGED = 'pre_cert_main_not_merged';
export const PRE_CERT_BLOCKING_FINDINGS_OPEN = 'pre_cert_blocking_findings_open';
export const PRE_CERT_COVERAGE_MISSING = 'pre_cert_coverage_missing';
export const PRE_CERT_DIRTY_TREE = 'pre_cert_dirty_tree';
export const PRE_CERT_PREFLIGHT_FAILED = 'pre_cert_preflight_failed';
export const PRE_CERT_WINDOW_MISSING = 'pre_cert_window_missing';
export const PRE_CERT_WINDOW_TAMPERED = 'pre_cert_window_tampered';
export const PRE_CERT_RECEIPT_TAMPERED = 'pre_cert_receipt_tampered';
export const PRE_CERT_INVENTORY_NOT_AUTHORITY = 'pre_cert_inventory_not_certification_authority';
export const PRE_CERT_WINDOW_REQUIRED = 'pre_cert_window_required';
export const PRE_CERT_WINDOW_INVALIDATED = 'pre_cert_window_invalidated';
export const PRE_CERT_CAUSAL_FRESHNESS_REQUIRED = 'pre_cert_causal_freshness_required';
export const PRE_CERT_MATERIAL_DRIFT_REATTESTATION_ADVISORY = 'pre_cert_material_drift_reattestation_advisory';

export const PRECERT_VERIFIER_IDENTITY = 'proof-or-stop:done_required_validate';
export const PRECERT_TEST_IDENTITY = 'npm test';

export interface CertificationWindowFrozenIdentity {
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  /** Domain inputs captured when the certification window was admitted. */
  causalInputHashes?: Record<string, string>;
  expectedMainSha: string;
  verifierIdentity: string;
  testIdentity: string;
}

export interface CertificationWindowInventoryBinding {
  epochId?: string;
  receiptId?: string;
  authority?: string;
  authorizesTest?: boolean;
}

export interface CertificationWindowInvalidation {
  detectedAt: string;
  oldHeadHash?: string;
  currentHeadHash?: string;
  oldMaterialHash?: string;
  currentMaterialHash?: string;
  oldStoryFilesHash?: string;
  currentStoryFilesHash?: string;
  blockerCode: string;
}

export interface CertificationWindow {
  schemaVersion: typeof CERTIFICATION_WINDOW_SCHEMA;
  windowId: string;
  storyId: string;
  state: CertificationWindowState;
  createdAt: string;
  updatedAt: string;
  frozen?: CertificationWindowFrozenIdentity;
  inventory?: CertificationWindowInventoryBinding;
  blockerCode?: string;
  blockerDetail?: string;
  receiptId?: string;
  cancelledAt?: string;
  cancelReason?: string;
  invalidation?: CertificationWindowInvalidation;
  _hash: string;
}

export interface PrecertReceipt {
  schemaVersion: typeof PRECERT_RECEIPT_SCHEMA;
  receiptId: string;
  windowId: string;
  storyId: string;
  authority: typeof PRECERT_AUTHORITY;
  authorizesHeavyCertification: true;
  frozen: CertificationWindowFrozenIdentity;
  inventoryEpochId?: string;
  inventoryReceiptId?: string;
  createdAt: string;
  _hash: string;
}

export interface CertificationWindowData {
  schemaVersion: typeof CERTIFICATION_WINDOW_FILE_SCHEMA;
  windows: CertificationWindow[];
  receipts: PrecertReceipt[];
}

export interface CertificationWindowStorePort {
  readCertificationWindows(storyId: string): CertificationWindowData;
  writeCertificationWindows(storyId: string, data: CertificationWindowData): void;
  runtimeLockDirPath(storyId: string, category: string, name: string): string;
}

export interface ReviewInventoryEpochAdmitView {
  epochId?: string;
  storyId?: string;
  reviewRound?: string;
  state?: string;
  consumedAt?: string;
  receiptId?: string;
  cutoff?: { headHash?: string; materialHash?: string; storyFilesHash?: string };
}

export interface InventoryCompletenessReceipt {
  receiptId?: string;
  epochId?: string;
  storyId?: string;
  reviewRound?: string;
  authority?: string;
  authorizesTest?: boolean;
  consumedAt?: string;
  invalidatedAt?: string;
  cutoff?: { headHash?: string; materialHash?: string; storyFilesHash?: string };
}

export interface ReviewInventoryAdmitPair {
  epoch?: ReviewInventoryEpochAdmitView;
  receipt?: InventoryCompletenessReceipt;
}

export interface ReviewInventoryAdmitApis {
  finalizedUnconsumedReviewInventory: (
    store: unknown,
    storyId: string,
  ) => ReviewInventoryAdmitPair | null;
  consumeReviewInventoryCompletenessReceipt: (
    store: unknown,
    storyId: string,
    reviewRound: string,
    currentCutoff: { materialHash: string; storyFilesHash?: string },
    validateInventoryContext?: () => void,
  ) => string | null;
}

export type ReviewInventoryProbeResult =
  | { status: 'present'; inventory: ReviewInventoryAdmitPair }
  | { status: 'empty'; inventory: null }
  | { status: 'failed'; error: string };

export function probeFinalizedUnconsumedReviewInventory(
  apis: ReviewInventoryAdmitApis,
  store: unknown,
  storyId: string,
): ReviewInventoryProbeResult {
  try {
    const inventory = apis.finalizedUnconsumedReviewInventory(store, storyId);
    return inventory
      ? { status: 'present', inventory }
      : { status: 'empty', inventory: null };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface CertificationWindowAdmitFacts {
  inventoryApisPresent: boolean;
  inventory: ReviewInventoryAdmitPair | null;
  currentStoryId: string;
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
  expectedMainSha?: string | null;
  mainIsAncestor: boolean;
  openBlockingFindingIds: string[];
  missingRequiredIntents: number;
  dirtyNonRuntimePaths: string[];
  gitIndexReadable: boolean;
  evidenceTargetWritable: boolean;
  causalInputHashes?: Record<string, string>;
  causalDependencyGraphDigest?: string;
  causalInputHashesDigest?: string;
  /** Optional signed decision used only by the explicit specialized consumer. */
  causalDecision?: CausalDependencyDecision;
}

export interface CertificationWindowAdmitDecision {
  admit: boolean;
  blockerCode?: string;
  blockerDetail?: string;
}

export interface CertificationWindowStatusProjection {
  storyId: string;
  window: CertificationWindow | null;
  receipt: PrecertReceipt | null;
  blockerCode: string | null;
  nextCommand: string;
  advisory?: {
    code: typeof PRE_CERT_MATERIAL_DRIFT_REATTESTATION_ADVISORY;
    detail: string;
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

export function certificationWindowDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function emptyCertificationWindowData(): CertificationWindowData {
  return { schemaVersion: CERTIFICATION_WINDOW_FILE_SCHEMA, windows: [], receipts: [] };
}

export function isCertificationWindowState(value: unknown): value is CertificationWindowState {
  return typeof value === 'string' && (CERTIFICATION_WINDOW_STATES as readonly string[]).includes(value);
}

export function signCertificationWindow(window: Omit<CertificationWindow, '_hash'>): string {
  return certificationWindowDigest({ domain: WINDOW_DOMAIN, ...window });
}

export function verifyCertificationWindow(window: CertificationWindow): boolean {
  if (!window || window.schemaVersion !== CERTIFICATION_WINDOW_SCHEMA) return false;
  if (!window._hash || !isCertificationWindowState(window.state)) return false;
  const { _hash, ...unsigned } = window;
  return _hash === signCertificationWindow(unsigned);
}

export function signPrecertReceipt(receipt: Omit<PrecertReceipt, '_hash'>): string {
  return certificationWindowDigest({ domain: RECEIPT_DOMAIN, ...receipt });
}

export function verifyPrecertReceipt(receipt: PrecertReceipt): boolean {
  if (!receipt || receipt.schemaVersion !== PRECERT_RECEIPT_SCHEMA) return false;
  if (!receipt._hash || receipt.authority !== PRECERT_AUTHORITY) return false;
  if (receipt.authorizesHeavyCertification !== true) return false;
  const { _hash, ...unsigned } = receipt;
  return _hash === signPrecertReceipt(unsigned);
}

export function withSignedCertificationWindow(
  window: Omit<CertificationWindow, '_hash'> | CertificationWindow,
): CertificationWindow {
  const { _hash: _ignored, ...unsigned } = window as CertificationWindow;
  return { ...unsigned, _hash: signCertificationWindow(unsigned) };
}

export function withSignedPrecertReceipt(
  receipt: Omit<PrecertReceipt, '_hash'> | PrecertReceipt,
): PrecertReceipt {
  const { _hash: _ignored, ...unsigned } = receipt as PrecertReceipt;
  return { ...unsigned, _hash: signPrecertReceipt(unsigned) };
}

/**
 * Inventory completeness receipts (B-3f3d) never authorize PRE_CERT.
 * authorizesTest=false / inventory-completeness-only is completeness-only.
 */
export function inventoryReceiptAuthorizesPrecert(
  receipt: InventoryCompletenessReceipt | null | undefined,
): boolean {
  if (!receipt) return false;
  if (receipt.authority === INVENTORY_COMPLETENESS_AUTHORITY) return false;
  if (receipt.authorizesTest === false) return false;
  return false;
}

export function windowAuthorizesHeavyCertification(
  window: CertificationWindow | null | undefined,
  receipt?: PrecertReceipt | null,
): boolean {
  if (!window || !verifyCertificationWindow(window)) return false;
  if (window.state !== 'ADMITTED' && window.state !== 'RUNNING') return false;
  if (!receipt || !verifyPrecertReceipt(receipt)) return false;
  if (receipt.windowId !== window.windowId || receipt.storyId !== window.storyId || receipt.receiptId !== window.receiptId) {
    return false;
  }
  const frozen = window.frozen;
  if (!frozen) return false;
  return receipt.frozen.headHash === frozen.headHash
    && receipt.frozen.materialHash === frozen.materialHash
    && receipt.frozen.storyFilesHash === frozen.storyFilesHash
    && receipt.frozen.expectedMainSha === frozen.expectedMainSha
    && receipt.frozen.verifierIdentity === frozen.verifierIdentity
    && receipt.frozen.testIdentity === frozen.testIdentity;
}

export function withCertificationWindowLock<T>(
  store: CertificationWindowStorePort,
  storyId: string,
  fn: () => T,
): T {
  return withMkdirLock(store.runtimeLockDirPath(storyId, 'certification-window', 'windows'), fn, {
    label: `certification window ${storyId}`,
  });
}

export function latestCertificationWindow(data: CertificationWindowData): CertificationWindow | null {
  return data.windows.at(-1) ?? null;
}

export function receiptForWindow(data: CertificationWindowData, window: CertificationWindow | null): PrecertReceipt | null {
  if (!window?.receiptId) return null;
  return data.receipts.find(row => row.receiptId === window.receiptId) ?? null;
}

export function nextCertificationWindowId(data: CertificationWindowData, storyId: string): string {
  return `${storyId}:CW-${String(data.windows.length + 1).padStart(3, '0')}`;
}

export function nextPrecertReceiptId(data: CertificationWindowData, storyId: string): string {
  return `${storyId}:PRECERT-${String(data.receipts.length + 1).padStart(3, '0')}`;
}

let reviewInventoryAdmitApisOverride: ReviewInventoryAdmitApis | null | undefined;

/** Test seam only. Pass `undefined` to restore production loading. */
export function setReviewInventoryAdmitApisForTest(
  apis: ReviewInventoryAdmitApis | null | undefined,
): void {
  reviewInventoryAdmitApisOverride = apis;
}

/**
 * Optional B-3f3d inventory APIs. Missing exports stay fail-closed; never stub-always-admit.
 */
export function loadReviewInventoryAdmitApis(): ReviewInventoryAdmitApis | null {
  if (reviewInventoryAdmitApisOverride !== undefined) return reviewInventoryAdmitApisOverride;
  const modulePath = fileURLToPath(new URL('./review-inventory-epoch.js', import.meta.url));
  if (!existsSync(modulePath)) return null;
  try {
    const required = createRequire(import.meta.url)('./review-inventory-epoch.js') as Record<string, unknown>;
    const finalized = required.finalizedUnconsumedReviewInventory;
    const consume = required.consumeReviewInventoryCompletenessReceipt;
    if (typeof finalized !== 'function' || typeof consume !== 'function') return null;
    return {
      finalizedUnconsumedReviewInventory: finalized as ReviewInventoryAdmitApis['finalizedUnconsumedReviewInventory'],
      consumeReviewInventoryCompletenessReceipt: consume as ReviewInventoryAdmitApis['consumeReviewInventoryCompletenessReceipt'],
    };
  } catch {
    return null;
  }
}

export function nextCommandForBlocker(storyId: string, blockerCode?: string | null): string {
  switch (blockerCode) {
    case PRE_CERT_INVENTORY_NOT_FINALIZED:
    case PRE_CERT_INVENTORY_API_ABSENT:
    case PRE_CERT_INVENTORY_NOT_AUTHORITY:
      return `proof-or-stop review_inventory_finalize --storyId=${storyId}`;
    case PRE_CERT_INVENTORY_PROBE_FAILED:
      return `proof-or-stop certification_window_status --storyId=${storyId}`;
    case PRE_CERT_MAIN_NOT_MERGED:
      return `proof-or-stop done_prepare --storyId=${storyId} --mergeMain`;
    case PRE_CERT_BLOCKING_FINDINGS_OPEN:
      return `proof-or-stop finding_list --storyId=${storyId}`;
    case PRE_CERT_COVERAGE_MISSING:
      return `proof-or-stop validate --story=${storyId}`;
    case PRE_CERT_DIRTY_TREE:
      return `proof-or-stop done_prepare --storyId=${storyId}`;
    default:
      return `proof-or-stop certification_window_begin --storyId=${storyId}`;
  }
}

export function nextCommandForState(
  storyId: string,
  state: CertificationWindowState,
  blockerCode?: string | null,
): string {
  if (state === 'INVALIDATED') {
    return `proof-or-stop story_advance --storyId=${storyId} --phase=REVIEW`;
  }
  if (state === 'ADMITTED' || state === 'RUNNING') {
    return `proof-or-stop done_required_validate --storyId=${storyId}`;
  }
  if (state === 'FINALIZED') {
    return `proof-or-stop certification_window_status --storyId=${storyId}`;
  }
  return nextCommandForBlocker(storyId, blockerCode);
}

export function projectCertificationWindowStatus(
  storyId: string,
  window: CertificationWindow | null,
  receipt: PrecertReceipt | null = null,
  advisory?: CertificationWindowStatusProjection['advisory'],
): CertificationWindowStatusProjection {
  if (!window) {
    return {
      storyId,
      window: null,
      receipt: null,
      blockerCode: PRE_CERT_WINDOW_MISSING,
      nextCommand: nextCommandForState(storyId, 'BLOCKED', PRE_CERT_WINDOW_MISSING),
      ...(advisory ? { advisory } : {}),
    };
  }
  const blockerCode = window.blockerCode
    ?? (window.state === 'INVALIDATED' ? window.invalidation?.blockerCode ?? null : null)
    ?? (window.state === 'BLOCKED' ? PRE_CERT_WINDOW_MISSING : null);
  return {
    storyId,
    window,
    receipt,
    blockerCode,
    nextCommand: nextCommandForState(storyId, window.state, blockerCode),
    ...(advisory ? { advisory } : {}),
  };
}

function inventoryLineageRefusal(facts: CertificationWindowAdmitFacts): string | null {
  const pair = facts.inventory;
  const receipt = pair?.receipt;
  const epoch = pair?.epoch;
  if (!pair || !receipt) return 'No FINALIZED unconsumed Review Inventory receipt is present.';
  const inventoryStoryId = receipt.storyId || epoch?.storyId;
  if (inventoryStoryId && inventoryStoryId !== facts.currentStoryId) {
    return `Inventory receipt belongs to ${inventoryStoryId}, not ${facts.currentStoryId}.`;
  }
  const receiptMaterial = receipt.cutoff?.materialHash ?? epoch?.cutoff?.materialHash;
  const receiptStoryFiles = receipt.cutoff?.storyFilesHash ?? epoch?.cutoff?.storyFilesHash;
  if (!facts.materialHash || !facts.storyFilesHash || !receiptMaterial || !receiptStoryFiles) {
    return 'Inventory cutoff or current certification hashes are missing; refuse rather than invent a second freshness hash.';
  }
  if (receiptStoryFiles !== facts.storyFilesHash) {
    return 'Inventory receipt is not on the current storyFilesHash lineage.';
  }
  if (receiptMaterial !== facts.materialHash) {
    return 'Whole-tree materialHash drift is not an unchanged certification identity.';
  }
  return null;
}

/**
 * Admit PRE_CERT only from inventory, merge, clean-tree, and coverage facts.
 * Whole-tree materialHash-only drift is never treated as a matching identity.
 */
export function evaluateCertificationWindowAdmit(
  facts: CertificationWindowAdmitFacts,
): CertificationWindowAdmitDecision {
  if (!facts.inventoryApisPresent) {
    return {
      admit: false,
      blockerCode: PRE_CERT_INVENTORY_NOT_FINALIZED,
      blockerDetail: `[${PRE_CERT_INVENTORY_API_ABSENT}] Review inventory admit APIs are absent; begin stays fail-closed and does not stub-always-admit. Inventory completeness is not PRE_CERT.`,
    };
  }
  const causalDecisionBindingAdmissible = !facts.causalDecision
    || causalDependencyDecisionMatchesCurrentIdentity(facts.causalDecision, {
      storyId: facts.currentStoryId,
      materialHash: facts.materialHash,
      storyFilesHash: facts.storyFilesHash,
      headHash: facts.headHash,
      dependencyGraphDigest: facts.causalDependencyGraphDigest,
      currentInputHashesDigest: facts.causalInputHashesDigest,
    });
  if (facts.causalDecision && (
    !verifyCausalDependencyDecision(facts.causalDecision)
    || !facts.causalDecision.gateAdmissible
    || !causalDecisionBindingAdmissible
  )) {
    return {
      admit: false,
      blockerCode: PRE_CERT_CAUSAL_FRESHNESS_REQUIRED,
      blockerDetail: facts.causalDecision && verifyCausalDependencyDecision(facts.causalDecision)
        ? causalDecisionBindingAdmissible
          ? `CausalEvidence requires fresh affected-node evidence: ${facts.causalDecision.reason}`
          : 'CausalEvidence decision binding does not match the live certification hashes; stale evidence is refused.'
        : 'CausalEvidence decision is missing or tampered; stale affected-node bypass is refused.',
    };
  }
  const lineageRefusal = inventoryLineageRefusal(facts);
  if (lineageRefusal) {
    return {
      admit: false,
      blockerCode: PRE_CERT_INVENTORY_NOT_FINALIZED,
      blockerDetail: lineageRefusal,
    };
  }
  if (facts.openBlockingFindingIds.length > 0) {
    return {
      admit: false,
      blockerCode: PRE_CERT_BLOCKING_FINDINGS_OPEN,
      blockerDetail: `Open verified blocking findings: ${facts.openBlockingFindingIds.join(', ')}`,
    };
  }
  if (facts.missingRequiredIntents > 0) {
    return {
      admit: false,
      blockerCode: PRE_CERT_COVERAGE_MISSING,
      blockerDetail: `${facts.missingRequiredIntents} required verification intent(s) are missing coverage.`,
    };
  }
  if (!facts.mainIsAncestor || !facts.expectedMainSha) {
    return {
      admit: false,
      blockerCode: PRE_CERT_MAIN_NOT_MERGED,
      blockerDetail: facts.expectedMainSha
        ? 'Local main is not an ancestor of HEAD.'
        : 'Local main SHA is missing; expected main SHA cannot be recorded.',
    };
  }
  if (facts.dirtyNonRuntimePaths.length > 0) {
    return {
      admit: false,
      blockerCode: PRE_CERT_DIRTY_TREE,
      blockerDetail: `Worktree has non-runtime dirty paths: ${facts.dirtyNonRuntimePaths.slice(0, 8).join(', ')}`,
    };
  }
  if (!facts.gitIndexReadable || !facts.evidenceTargetWritable) {
    return {
      admit: false,
      blockerCode: PRE_CERT_PREFLIGHT_FAILED,
      blockerDetail: !facts.gitIndexReadable
        ? 'Git index is not readable.'
        : 'Certification evidence target is not writable.',
    };
  }
  return { admit: true };
}

function countExactLines(text: string, prefix: string): number {
  return text.split('\n').filter(line => line.startsWith(prefix)).length;
}

export function renderCertificationWindowStatus(projection: CertificationWindowStatusProjection): string {
  const { window, blockerCode, nextCommand } = projection;
  const lines: string[] = [
    `Certification window: ${window?.windowId ?? 'none'}`,
    `State: ${window?.state ?? 'BLOCKED'}`,
  ];
  const printsFrozenIdentity = window
    && (window.state === 'ADMITTED' || window.state === 'RUNNING' || window.state === 'FINALIZED')
    && window.frozen;
  if (printsFrozenIdentity && window.frozen) {
    lines.push(`headHash: ${window.frozen.headHash}`);
    lines.push(`expectedMainSha: ${window.frozen.expectedMainSha}`);
    lines.push(`storyFilesHash: ${window.frozen.storyFilesHash}`);
  }
  if (projection.advisory) {
    lines.push(`Warning: [${projection.advisory.code}] ${projection.advisory.detail}`);
  }
  if (blockerCode) lines.push(`Blocker: [${blockerCode}]`);
  if (window?.blockerDetail) lines.push(`Detail: ${window.blockerDetail}`);
  lines.push(`Next: ${nextCommand}`);
  const rendered = lines.join('\n');
  if (countExactLines(rendered, 'State:') !== 1 || countExactLines(rendered, 'Next:') !== 1) {
    throw new Error(`${PRE_CERT_WINDOW_TAMPERED}: status renderer must emit exactly one State: and one Next:`);
  }
  if (rendered.includes('inventory completeness is certification')
    || rendered.includes('inventory receipt authorizes certification')
    || rendered.includes('authorizesTest=true from inventory')) {
    throw new Error(`${PRE_CERT_INVENTORY_NOT_AUTHORITY}: status must never claim inventory completeness is certification`);
  }
  return rendered;
}

export function assertVerifiedCertificationWindow(window: CertificationWindow): void {
  if (!verifyCertificationWindow(window)) {
    throw new Error(
      `[${PRE_CERT_WINDOW_TAMPERED}] CertificationWindow ${window.windowId ?? '<unknown>'} signature mismatch; `
      + 'window is not ADMITTED and cannot authorize heavy certification',
    );
  }
}

export function assertVerifiedPrecertReceipt(receipt: PrecertReceipt): void {
  if (!verifyPrecertReceipt(receipt)) {
    throw new Error(
      `[${PRE_CERT_RECEIPT_TAMPERED}] PRE_CERT receipt ${receipt.receiptId ?? '<unknown>'} signature mismatch; `
      + 'inventory completeness is not certification authority',
    );
  }
}

export function persistBlockedCertificationWindow(args: {
  store: CertificationWindowStorePort;
  storyId: string;
  blockerCode: string;
  blockerDetail: string;
  inventory?: CertificationWindowInventoryBinding;
}): CertificationWindow {
  return withCertificationWindowLock(args.store, args.storyId, () => {
    const data = args.store.readCertificationWindows(args.storyId);
    const latest = latestCertificationWindow(data);
    if (
      latest
      && verifyCertificationWindow(latest)
      && latest.state === 'BLOCKED'
      && latest.blockerCode === args.blockerCode
      && latest.blockerDetail === args.blockerDetail
    ) {
      return latest;
    }
    const now = new Date().toISOString();
    const unsigned: Omit<CertificationWindow, '_hash'> = {
      schemaVersion: CERTIFICATION_WINDOW_SCHEMA,
      windowId: nextCertificationWindowId(data, args.storyId),
      storyId: args.storyId,
      state: 'BLOCKED',
      createdAt: now,
      updatedAt: now,
      blockerCode: args.blockerCode,
      blockerDetail: args.blockerDetail,
      ...(args.inventory ? { inventory: args.inventory } : {}),
    };
    const window = withSignedCertificationWindow(unsigned);
    data.windows.push(window);
    args.store.writeCertificationWindows(args.storyId, data);
    return window;
  });
}

export function persistCancelledCertificationWindow(args: {
  store: CertificationWindowStorePort;
  storyId: string;
  reason: string;
}): CertificationWindow {
  const reason = args.reason.trim();
  if (reason.length < 5) throw new Error('certification_window_cancel: reason must be at least 5 characters');
  return withCertificationWindowLock(args.store, args.storyId, () => {
    const data = args.store.readCertificationWindows(args.storyId);
    const latest = latestCertificationWindow(data);
    if (!latest) {
      throw new Error(`certification_window_cancel: no CertificationWindow for ${args.storyId}`);
    }
    assertVerifiedCertificationWindow(latest);
    if (latest.state === 'CANCELLED') return latest;
    if (latest.state === 'FINALIZED' || latest.state === 'INVALIDATED') {
      throw new Error(
        `certification_window_cancel: ${latest.windowId} is ${latest.state} and cannot be cancelled`,
      );
    }
    const now = new Date().toISOString();
    const cancelled = withSignedCertificationWindow({
      ...latest,
      state: 'CANCELLED',
      updatedAt: now,
      cancelledAt: now,
      cancelReason: reason,
      receiptId: undefined,
    });
    data.windows = data.windows.map(row => row.windowId === latest.windowId ? cancelled : row);
    args.store.writeCertificationWindows(args.storyId, data);
    return cancelled;
  });
}

export function persistAdmittedCertificationWindow(args: {
  store: CertificationWindowStorePort;
  storyId: string;
  frozen: CertificationWindowFrozenIdentity;
  inventory: CertificationWindowInventoryBinding;
}): { window: CertificationWindow; receipt: PrecertReceipt } {
  return withCertificationWindowLock(args.store, args.storyId, () => {
    const data = args.store.readCertificationWindows(args.storyId);
    const latest = latestCertificationWindow(data);
    if (latest && verifyCertificationWindow(latest) && (latest.state === 'ADMITTED' || latest.state === 'RUNNING')) {
      const existing = receiptForWindow(data, latest);
      if (existing && verifyPrecertReceipt(existing)) {
        return { window: latest, receipt: existing };
      }
    }
    const now = new Date().toISOString();
    const windowId = nextCertificationWindowId(data, args.storyId);
    const receiptId = nextPrecertReceiptId(data, args.storyId);
    const window = withSignedCertificationWindow({
      schemaVersion: CERTIFICATION_WINDOW_SCHEMA,
      windowId,
      storyId: args.storyId,
      state: 'ADMITTED',
      createdAt: now,
      updatedAt: now,
      frozen: args.frozen,
      inventory: args.inventory,
      receiptId,
    });
    const receipt = withSignedPrecertReceipt({
      schemaVersion: PRECERT_RECEIPT_SCHEMA,
      receiptId,
      windowId,
      storyId: args.storyId,
      authority: PRECERT_AUTHORITY,
      authorizesHeavyCertification: true,
      frozen: args.frozen,
      inventoryEpochId: args.inventory.epochId,
      inventoryReceiptId: args.inventory.receiptId,
      createdAt: now,
    });
    data.windows.push(window);
    data.receipts.push(receipt);
    args.store.writeCertificationWindows(args.storyId, data);
    return { window, receipt };
  });
}

export function loadVerifiedCertificationWindow(
  store: CertificationWindowStorePort,
  storyId: string,
): { data: CertificationWindowData; window: CertificationWindow | null; receipt: PrecertReceipt | null } {
  const data = store.readCertificationWindows(storyId);
  const window = latestCertificationWindow(data);
  if (!window) return { data, window: null, receipt: null };
  assertVerifiedCertificationWindow(window);
  const receipt = receiptForWindow(data, window);
  if (receipt) assertVerifiedPrecertReceipt(receipt);
  if (window.inventory && inventoryReceiptAuthorizesPrecert(window.inventory)) {
    throw new Error(`[${PRE_CERT_INVENTORY_NOT_AUTHORITY}] inventory receipt cannot authorize PRE_CERT`);
  }
  return { data, window, receipt };
}

export interface CertificationWindowCurrentIdentity {
  storyId?: string;
  materialHash?: string;
  storyFilesHash?: string;
  /** Current hashes for the declared causal dependency inputs. */
  causalInputHashes?: Record<string, string>;
  verifierIdentity?: string;
  testIdentity?: string;
  headHash?: string;
  /** True when the workspace is a git repo but current hashes could not be read. */
  hashUnavailable?: boolean;
  causalDependencyGraphDigest?: string;
  causalInputHashesDigest?: string;
  /** Signed specialized decision; absent keeps the existing strict hash gate. */
  causalDecision?: CausalDependencyDecision;
}

function causalDecisionMatchesCertificationSnapshot(
  decision: CausalDependencyDecision,
  frozen: CertificationWindowFrozenIdentity,
  current: CertificationWindowCurrentIdentity,
): boolean {
  if (!causalDependencyDecisionMatchesCurrentIdentity(decision, {
    storyId: current.storyId,
    materialHash: current.materialHash,
    storyFilesHash: current.storyFilesHash,
    headHash: current.headHash,
    dependencyGraphDigest: current.causalDependencyGraphDigest,
    currentInputHashesDigest: current.causalInputHashesDigest,
  })) return false;
  const binding = decision.identityBinding!;
  return binding.previousMaterialHash === frozen.materialHash
    && binding.previousStoryFilesHash === frozen.storyFilesHash
    && binding.previousHeadHash === frozen.headHash;
}

export function detectCertificationWindowMaterialDrift(
  window: CertificationWindow,
  current: CertificationWindowCurrentIdentity,
): { drifted: boolean; reason?: string; advisory?: CertificationWindowStatusProjection['advisory'] } {
  const frozen = window.frozen;
  if (!frozen) return { drifted: false };
  if (current.hashUnavailable) {
    return { drifted: true, reason: 'current certification hashes are missing' };
  }
  if (current.causalDecision && !verifyCausalDependencyDecision(current.causalDecision)) {
    return { drifted: true, reason: 'causal dependency decision is missing or tampered' };
  }
  if (current.causalDecision && !current.causalDecision.gateAdmissible) {
    return { drifted: true, reason: current.causalDecision.reason };
  }
  if (current.causalDecision && !causalDecisionMatchesCertificationSnapshot(current.causalDecision, frozen, current)) {
    const binding = current.causalDecision.identityBinding;
    // B-5a15 F-338: map into the parameter shape, exactly as
    // causalDecisionMatchesCertificationSnapshot does. Passing `current` raw silently read
    // undefined for both digests -- CertificationWindowCurrentIdentity names them
    // causalDependencyGraphDigest / causalInputHashesDigest -- so the two digest comparisons
    // were skipped and this re-check blamed the FROZEN binding when only the CURRENT one had
    // drifted. The parameter type is all-optional and `current` is a variable, so excess
    // property checking never flagged it.
    const currentMatches = binding
      ? causalDependencyDecisionMatchesCurrentIdentity(current.causalDecision, {
        storyId: current.storyId,
        materialHash: current.materialHash,
        storyFilesHash: current.storyFilesHash,
        headHash: current.headHash,
        dependencyGraphDigest: current.causalDependencyGraphDigest,
        currentInputHashesDigest: current.causalInputHashesDigest,
      })
      : false;
    return {
      drifted: true,
      reason: currentMatches
        ? 'causal dependency previous binding does not match frozen certification hashes'
        : 'causal dependency current binding does not match current certification hashes [causal advisory binding mismatch]',
    };
  }
  const allowSpecializedUnrelatedDrift = current.causalDecision?.causalDecision === 'advisory'
    && current.causalDecision.storyFilesHashAdvisory;
  if (current.storyFilesHash && frozen.storyFilesHash && current.storyFilesHash !== frozen.storyFilesHash) {
    return { drifted: true, reason: 'storyFilesHash changed' };
  }
  let advisory: CertificationWindowStatusProjection['advisory'] | undefined;
  if (current.materialHash && frozen.materialHash && current.materialHash !== frozen.materialHash) {
    if (!allowSpecializedUnrelatedDrift) {
      return { drifted: true, reason: 'materialHash changed' };
    }
    advisory = {
      code: PRE_CERT_MATERIAL_DRIFT_REATTESTATION_ADVISORY,
      detail: 'Whole-tree materialHash drifted while storyFilesHash remained unchanged; specialized evidence remains usable only with mandatory re-attestation. Stored hashes are not rewritten.',
    };
  }
  if (
    frozen.verifierIdentity === PRECERT_VERIFIER_IDENTITY
    && current.verifierIdentity
    && current.verifierIdentity !== frozen.verifierIdentity
  ) {
    return { drifted: true, reason: 'verifier identity changed' };
  }
  if (
    frozen.testIdentity === PRECERT_TEST_IDENTITY
    && current.testIdentity
    && current.testIdentity !== frozen.testIdentity
  ) {
    return { drifted: true, reason: 'test identity changed' };
  }
  return { drifted: false, ...(advisory ? { advisory } : {}) };
}

export function persistInvalidatedCertificationWindow(args: {
  store: CertificationWindowStorePort;
  storyId: string;
  current: CertificationWindowCurrentIdentity;
  reason: string;
}): { window: CertificationWindow; receipt: PrecertReceipt | null } {
  return withCertificationWindowLock(args.store, args.storyId, () => {
    const data = args.store.readCertificationWindows(args.storyId);
    const latest = latestCertificationWindow(data);
    if (!latest) return { window: latest as never, receipt: null };
    assertVerifiedCertificationWindow(latest);
    if (latest.state === 'INVALIDATED' || latest.state === 'CANCELLED') {
      return { window: latest, receipt: receiptForWindow(data, latest) };
    }
    const now = new Date().toISOString();
    const invalidated = withSignedCertificationWindow({
      ...latest,
      state: 'INVALIDATED',
      updatedAt: now,
      blockerCode: PRE_CERT_WINDOW_INVALIDATED,
      blockerDetail: args.reason,
      invalidation: {
        detectedAt: now,
        oldHeadHash: latest.frozen?.headHash,
        currentHeadHash: args.current.headHash,
        oldMaterialHash: latest.frozen?.materialHash,
        currentMaterialHash: args.current.materialHash,
        oldStoryFilesHash: latest.frozen?.storyFilesHash,
        currentStoryFilesHash: args.current.storyFilesHash,
        blockerCode: PRE_CERT_WINDOW_INVALIDATED,
      },
    });
    data.windows = data.windows.map(row => row.windowId === latest.windowId ? invalidated : row);
    args.store.writeCertificationWindows(args.storyId, data);
    return { window: invalidated, receipt: receiptForWindow(data, invalidated) };
  });
}

export function persistRunningCertificationWindow(args: {
  store: CertificationWindowStorePort;
  storyId: string;
}): { window: CertificationWindow; receipt: PrecertReceipt | null } {
  return withCertificationWindowLock(args.store, args.storyId, () => {
    const data = args.store.readCertificationWindows(args.storyId);
    const latest = latestCertificationWindow(data);
    if (!latest) throw new Error(`[${PRE_CERT_WINDOW_REQUIRED}] no CertificationWindow`);
    assertVerifiedCertificationWindow(latest);
    const receipt = receiptForWindow(data, latest);
    if (receipt) assertVerifiedPrecertReceipt(receipt);
    if (latest.state === 'RUNNING') return { window: latest, receipt };
    if (latest.state !== 'ADMITTED') {
      throw new Error(`[${PRE_CERT_WINDOW_REQUIRED}] window ${latest.windowId} is ${latest.state}`);
    }
    const running = withSignedCertificationWindow({
      ...latest,
      state: 'RUNNING',
      updatedAt: new Date().toISOString(),
    });
    data.windows = data.windows.map(row => row.windowId === latest.windowId ? running : row);
    args.store.writeCertificationWindows(args.storyId, data);
    return { window: running, receipt: receiptForWindow(data, running) };
  });
}

export function refreshCertificationWindowLineage(args: {
  store: CertificationWindowStorePort;
  storyId: string;
  current: CertificationWindowCurrentIdentity;
}): { window: CertificationWindow | null; receipt: PrecertReceipt | null; advisory?: CertificationWindowStatusProjection['advisory'] } {
  const loaded = loadVerifiedCertificationWindow(args.store, args.storyId);
  if (!loaded.window) return { window: null, receipt: null };
  if (loaded.window.state !== 'ADMITTED' && loaded.window.state !== 'RUNNING') {
    return { window: loaded.window, receipt: loaded.receipt };
  }
  const drift = detectCertificationWindowMaterialDrift(loaded.window, args.current);
  if (!drift.drifted) return { window: loaded.window, receipt: loaded.receipt, advisory: drift.advisory };
  return persistInvalidatedCertificationWindow({
    store: args.store,
    storyId: args.storyId,
    current: args.current,
    reason: drift.reason ?? 'certification subject changed',
  });
}

/**
 * Test-only: persist a signed ADMITTED window + PrecertReceipt bound to the
 * current HEAD / materialHash / storyFilesHash and official verifier/test
 * identities. Inventory completeness never authorizes PRE_CERT here.
 */
export function persistSyntheticAdmittedWindowForTest(args: {
  store: CertificationWindowStorePort;
  storyId: string;
  projectRoot: string;
  gitCwd?: string;
  inventory?: CertificationWindowInventoryBinding;
  causalInputHashes?: Record<string, string>;
}): { window: CertificationWindow; receipt: PrecertReceipt } {
  if (args.inventory?.authorizesTest === true) {
    throw new Error('persistSyntheticAdmittedWindowForTest: inventory binding must not set authorizesTest=true');
  }
  const gitCwd = args.gitCwd ?? args.projectRoot;
  const headHash = currentGitHead(gitCwd) ?? '';
  const materialHash = currentMaterialHash(gitCwd, 'HEAD', args.projectRoot) ?? '';
  const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', args.projectRoot) ?? '';
  const frozen: CertificationWindowFrozenIdentity = {
    headHash,
    materialHash,
    storyFilesHash,
    causalInputHashes: args.causalInputHashes,
    expectedMainSha: headHash,
    verifierIdentity: PRECERT_VERIFIER_IDENTITY,
    testIdentity: PRECERT_TEST_IDENTITY,
  };
  const loaded = loadVerifiedCertificationWindow(args.store, args.storyId);
  const latest = loaded.window;
  const latestFrozen = latest?.frozen;
  const identityMatches = Boolean(
    latestFrozen
    && latestFrozen.headHash === frozen.headHash
    && latestFrozen.materialHash === frozen.materialHash
    && latestFrozen.storyFilesHash === frozen.storyFilesHash
    && latestFrozen.expectedMainSha === frozen.expectedMainSha
    && latestFrozen.verifierIdentity === frozen.verifierIdentity
    && latestFrozen.testIdentity === frozen.testIdentity,
  );
  if (latest && (latest.state === 'ADMITTED' || latest.state === 'RUNNING') && !identityMatches) {
    persistInvalidatedCertificationWindow({
      store: args.store,
      storyId: args.storyId,
      current: frozen,
      reason: 'synthetic test re-admit on a new frozen identity',
    });
  }
  return persistAdmittedCertificationWindow({
    store: args.store,
    storyId: args.storyId,
    frozen,
    inventory: {
      authority: INVENTORY_COMPLETENESS_AUTHORITY,
      ...args.inventory,
      authorizesTest: false,
    },
  });
}

export function refuseHeavyCertificationUnlessAdmitted(args: {
  store: CertificationWindowStorePort;
  storyId: string;
  current: CertificationWindowCurrentIdentity;
}): { window: CertificationWindow; receipt: PrecertReceipt | null } {
  const refreshed = refreshCertificationWindowLineage(args);
  if (!windowAuthorizesHeavyCertification(refreshed.window, refreshed.receipt)) {
    const projection = projectCertificationWindowStatus(args.storyId, refreshed.window, refreshed.receipt);
    if (!refreshed.window) {
      const apis = loadReviewInventoryAdmitApis();
      if (apis) {
        const inventoryProbe = probeFinalizedUnconsumedReviewInventory(apis, args.store, args.storyId);
        if (inventoryProbe.status === 'failed') {
          const rendered = renderCertificationWindowStatus({
            ...projection,
            blockerCode: PRE_CERT_INVENTORY_PROBE_FAILED,
            nextCommand: nextCommandForBlocker(args.storyId, PRE_CERT_INVENTORY_PROBE_FAILED),
          });
          throw new Error(
            `[${PRE_CERT_INVENTORY_PROBE_FAILED}] Review Inventory probe failed: ${inventoryProbe.error}\n${rendered}`,
          );
        }
        const rendered = renderCertificationWindowStatus({
          ...projection,
          // A TEST invocation with no window is blocked on the PRE_CERT inventory
          // prerequisite only when the inventory probe completed cleanly.
          nextCommand: inventoryProbe.status === 'present'
            ? projection.nextCommand
            : nextCommandForBlocker(args.storyId, PRE_CERT_INVENTORY_NOT_FINALIZED),
        });
        throw new Error(
          `[${PRE_CERT_WINDOW_REQUIRED}] Official heavy certification requires a current ADMITTED or RUNNING CertificationWindow.\n${rendered}`,
        );
      }
    }
    const rendered = renderCertificationWindowStatus({
      ...projection,
      // A TEST invocation with no window and no inventory APIs is blocked on the
      // missing PRE_CERT inventory prerequisite.
      nextCommand: refreshed.window
        ? projection.nextCommand
        : nextCommandForBlocker(args.storyId, PRE_CERT_INVENTORY_NOT_FINALIZED),
    });
    throw new Error(
      `[${PRE_CERT_WINDOW_REQUIRED}] Official heavy certification requires a current ADMITTED or RUNNING CertificationWindow.\n${rendered}`,
    );
  }
  return persistRunningCertificationWindow({ store: args.store, storyId: args.storyId });
}

export function isOfficialHeavyValidateInvocation(args: {
  full?: string | boolean;
  channel?: boolean;
  concept?: boolean;
  lint?: boolean;
}): boolean {
  if (args.channel || args.concept || args.lint) return false;
  return args.full === true || (typeof args.full === 'string' && args.full.length > 0);
}
