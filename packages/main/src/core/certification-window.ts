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
import {
  isCompleteRoutineValidationIdentity,
  isReusableCommandPass,
} from './validation-evidence-reuse.js';
import type {
  RoutineValidationCommandExecution,
  RoutineValidationIdentity,
} from './validation-types.js';

export const CERTIFICATION_WINDOW_STATES = [
  'BLOCKED',
  'ADMITTED',
  'RUNNING',
  'FINALIZED',
  'INVALIDATED',
  'CANCELLED',
] as const;

export type CertificationWindowState = (typeof CERTIFICATION_WINDOW_STATES)[number];

export const CERTIFICATION_WINDOW_SCHEMA = 'proof-or-stop.certification_window.v1';
export const PRECERT_RECEIPT_SCHEMA = 'proof-or-stop.precert_receipt.v1';
export const PRECERT_CHEAP_CHECK_RECEIPT_SCHEMA = 'proof-or-stop.precert_cheap_check_receipt.v1';
export const CERTIFICATION_WINDOW_FILE_SCHEMA = 'proof-or-stop.certification_windows.v1';
export const CERTIFICATION_WINDOW_FILE = 'certification-window.json';

const WINDOW_DOMAIN = 'proof-or-stop.certification-window.v1';
const RECEIPT_DOMAIN = 'proof-or-stop.precert-receipt.v1';
const CHEAP_CHECK_RECEIPT_DOMAIN = 'proof-or-stop.precert-cheap-check-receipt.v1';

export const PRECERT_AUTHORITY = 'pre-cert';
export const PRECERT_CHEAP_CHECK_AUTHORITY = 'pre-cert-cheap-check';
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
export const PRE_CERT_WINDOW_ALREADY_CONSUMED = 'pre_cert_window_already_consumed';
export const PRE_CERT_CHEAP_CHECK_REQUIRED = 'pre_cert_cheap_check_required';
/** TEST consumes this signed PASS; it must never start a second routine suite. */
export const PRE_CERT_ROUTINE_PASS_REQUIRED = 'pre_cert_routine_pass_required';

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

/**
 * The sole cheap prerequisite for opening PRE_CERT. This deliberately lives in
 * the existing signed certification-window artifact: it is a process fact,
 * not canonical TEST validation evidence, and therefore cannot be replaced by
 * a generic PASS or a REVIEW preflight gate result.
 */
export interface PrecertCheapCheckReceipt {
  schemaVersion: typeof PRECERT_CHEAP_CHECK_RECEIPT_SCHEMA;
  receiptId: string;
  storyId: string;
  authority: typeof PRECERT_CHEAP_CHECK_AUTHORITY;
  result: 'PASS';
  routineValidationIdentity: RoutineValidationIdentity;
  commandExecution: RoutineValidationCommandExecution;
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  createdAt: string;
  _hash: string;
}

export type CertificationWindowReceipt = PrecertReceipt | PrecertCheapCheckReceipt;

export interface CertificationWindowData {
  schemaVersion: typeof CERTIFICATION_WINDOW_FILE_SCHEMA;
  windows: CertificationWindow[];
  receipts: CertificationWindowReceipt[];
}

export interface CertificationWindowStorePort {
  readCertificationWindows(storyId: string): CertificationWindowData;
  writeCertificationWindows(storyId: string, data: CertificationWindowData): void;
  runtimeLockDirPath(storyId: string, category: string, name: string): string;
}

export interface ReviewInventoryEpochAdmitView {
  schemaVersion?: string;
  epochId?: string;
  storyId?: string;
  reviewRound?: string;
  state?: string;
  consumedAt?: string;
  receiptId?: string;
  cutoff?: { headHash?: string; materialHash?: string; storyFilesHash?: string };
  requiredLanes?: string[];
  waves?: Array<{
    lanes?: Array<{
      lane?: string;
      terminal?: string;
      evidenceIds?: string[];
      coverageDigest?: string;
    }>;
    newVerifiedFindingCount?: number;
    criticDigest?: string;
    saturated?: boolean;
  }>;
  _hash?: string;
}

export interface InventoryCompletenessReceipt {
  schemaVersion?: string;
  receiptId?: string;
  epochId?: string;
  storyId?: string;
  reviewRound?: string;
  authority?: string;
  authorizesTest?: boolean;
  consumedAt?: string;
  invalidatedAt?: string;
  cutoff?: { headHash?: string; materialHash?: string; storyFilesHash?: string };
  requiredLanes?: string[];
  waveCount?: number;
  saturationResult?: string;
  scopeDigest?: string;
  findingSetDigest?: string;
  coverageDigest?: string;
  _hash?: string;
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
  verifyReviewInventoryEpoch: (epoch: unknown) => boolean;
  verifyReviewInventoryReceipt: (receipt: unknown) => boolean;
  isInventoryCompletenessOnlyReceipt: (epoch: unknown, receipt: unknown) => boolean;
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
  /** Derived through the B-3f3d verifier/consumer surface; never inferred from authority text alone. */
  inventorySaturated: boolean;
  /** Signed `validate --story --focus=fast --json` fact; generic test evidence is never read here. */
  cheapCheckReceipt: PrecertCheapCheckReceipt | null;
  currentStoryId: string;
  headHash?: string;
  /**
   * A narrow handler-derived bridge for runtime-authored REVIEW metadata
   * commits after the inventory cutoff. It never covers material or
   * story-files drift, and the consume-lock callback still requires the exact
   * identity it evaluated.
   */
  inventoryHeadMetadataContinuity?: boolean;
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
  observedDriftReason?: string;
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

export function signPrecertCheapCheckReceipt(
  receipt: Omit<PrecertCheapCheckReceipt, '_hash'>,
): string {
  return certificationWindowDigest({ domain: CHEAP_CHECK_RECEIPT_DOMAIN, ...receipt });
}

/**
 * A cheap receipt must prove exactly the focused profile.  In particular, a
 * syntactically valid identity for a full, channel, concept, lint, or other
 * focus invocation never becomes PRE_CERT input.
 */
export function verifyPrecertCheapCheckReceipt(receipt: PrecertCheapCheckReceipt): boolean {
  if (!receipt || receipt.schemaVersion !== PRECERT_CHEAP_CHECK_RECEIPT_SCHEMA) return false;
  if (!receipt._hash || receipt.authority !== PRECERT_CHEAP_CHECK_AUTHORITY || receipt.result !== 'PASS') return false;
  if (!receipt.storyId || !receipt.receiptId || !receipt.headHash || !receipt.materialHash || !receipt.storyFilesHash) return false;
  const identity = receipt.routineValidationIdentity;
  if (!isCompleteRoutineValidationIdentity(identity)
    || identity.invocation.full !== null
    || identity.invocation.focus !== 'fast'
    || identity.commands.length === 0
    || identity.commands.some(command => !command.focus.includes('fast'))
    || !isReusableCommandPass(receipt.commandExecution, identity.commands.length)) return false;
  const { _hash, ...unsigned } = receipt;
  return _hash === signPrecertCheapCheckReceipt(unsigned);
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

export function withSignedPrecertCheapCheckReceipt(
  receipt: Omit<PrecertCheapCheckReceipt, '_hash'> | PrecertCheapCheckReceipt,
): PrecertCheapCheckReceipt {
  const { _hash: _ignored, ...unsigned } = receipt as PrecertCheapCheckReceipt;
  return { ...unsigned, _hash: signPrecertCheapCheckReceipt(unsigned) };
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

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

/**
 * PRE_CERT consumes B-3f3d's already-signed inventory through its existing
 * consumer. This is only a fail-closed admission projection: it rejects the
 * legacy empty completeness receipt and requires the final saturated wave to
 * carry every required terminal lane and the independent critic binding.
 */
export function isSaturatedReviewInventoryForPrecert(
  apis: ReviewInventoryAdmitApis,
  pair: ReviewInventoryAdmitPair | null,
  storyId: string,
): boolean {
  const epoch = pair?.epoch;
  const receipt = pair?.receipt;
  if (!epoch || !receipt || typeof apis.verifyReviewInventoryEpoch !== 'function'
    || typeof apis.verifyReviewInventoryReceipt !== 'function'
    || typeof apis.isInventoryCompletenessOnlyReceipt !== 'function') return false;
  try {
    if (!apis.verifyReviewInventoryEpoch(epoch) || !apis.verifyReviewInventoryReceipt(receipt)) return false;
    if (apis.isInventoryCompletenessOnlyReceipt(epoch, receipt)) return false;
  } catch {
    return false;
  }
  const requiredLanes = epoch.requiredLanes;
  const receiptRequiredLanes = receipt.requiredLanes;
  const waves = epoch.waves;
  const finalWave = waves?.at(-1);
  if (epoch.state !== 'FINALIZED' || epoch.storyId !== storyId || receipt.storyId !== storyId
    || !epoch.epochId || epoch.receiptId !== receipt.receiptId || receipt.epochId !== epoch.epochId
    || !epoch.reviewRound || receipt.reviewRound !== epoch.reviewRound
    || epoch.consumedAt || receipt.consumedAt || receipt.invalidatedAt
    || receipt.authority !== INVENTORY_COMPLETENESS_AUTHORITY || receipt.authorizesTest !== false
    || !Array.isArray(requiredLanes) || requiredLanes.length === 0
    || !Array.isArray(receiptRequiredLanes) || !sameStringSet(requiredLanes, receiptRequiredLanes)
    || !Array.isArray(waves) || waves.length === 0 || receipt.waveCount !== waves.length
    || receipt.saturationResult !== 'ZERO_NEW_VERIFIED_FINDINGS'
    || !receipt.scopeDigest || !receipt.findingSetDigest || !receipt.coverageDigest
    || !finalWave || finalWave.saturated !== true || finalWave.newVerifiedFindingCount !== 0
    || !finalWave.criticDigest || !Array.isArray(finalWave.lanes)
  ) return false;
  const terminalLanes = finalWave.lanes.map(lane => lane.lane ?? '');
  if (!sameStringSet(requiredLanes, terminalLanes)) return false;
  return finalWave.lanes.every(lane => (lane.terminal === 'pass' || lane.terminal === 'finding')
    && Array.isArray(lane.evidenceIds) && lane.evidenceIds.length > 0 && Boolean(lane.coverageDigest));
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
  const receipt = data.receipts.find(row => row.receiptId === window.receiptId);
  return receipt?.schemaVersion === PRECERT_RECEIPT_SCHEMA ? receipt : null;
}

/**
 * Returns only a current, signed, exact fast receipt.  Deliberately do not
 * consult test-evidence.json: that generic artifact can describe a different
 * command set or a reused/full run and is not the PRE_CERT cheap-check fact.
 */
export function currentPrecertCheapCheckReceipt(args: {
  data: CertificationWindowData;
  storyId: string;
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
  currentIdentity?: RoutineValidationIdentity;
}): PrecertCheapCheckReceipt | null {
  if (!args.headHash || !args.materialHash || !args.storyFilesHash
    || !isCompleteRoutineValidationIdentity(args.currentIdentity)) return null;
  for (const receipt of [...args.data.receipts].reverse()) {
    if (receipt.schemaVersion !== PRECERT_CHEAP_CHECK_RECEIPT_SCHEMA) continue;
    if (!verifyPrecertCheapCheckReceipt(receipt)) continue;
    if (receipt.routineValidationIdentity.digest !== args.currentIdentity!.digest
      || receipt.storyId !== args.storyId
      || receipt.headHash !== args.headHash
      || receipt.materialHash !== args.materialHash
      || receipt.storyFilesHash !== args.storyFilesHash) continue;
    return receipt;
  }
  return null;
}

export function nextCertificationWindowId(data: CertificationWindowData, storyId: string): string {
  return `${storyId}:CW-${String(data.windows.length + 1).padStart(3, '0')}`;
}

export function nextPrecertReceiptId(data: CertificationWindowData, storyId: string): string {
  return `${storyId}:PRECERT-${String(data.receipts.length + 1).padStart(3, '0')}`;
}

export function nextPrecertCheapCheckReceiptId(data: CertificationWindowData, storyId: string): string {
  const prior = data.receipts.filter(row => row.schemaVersion === PRECERT_CHEAP_CHECK_RECEIPT_SCHEMA).length;
  return `${storyId}:CHEAP-CHECK-${String(prior + 1).padStart(3, '0')}`;
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
    const verifyEpoch = required.verifyReviewInventoryEpoch;
    const verifyReceipt = required.verifyReviewInventoryReceipt;
    const isCompletenessOnly = required.isInventoryCompletenessOnlyReceipt;
    if (typeof finalized !== 'function' || typeof consume !== 'function'
      || typeof verifyEpoch !== 'function' || typeof verifyReceipt !== 'function'
      || typeof isCompletenessOnly !== 'function') return null;
    return {
      finalizedUnconsumedReviewInventory: finalized as ReviewInventoryAdmitApis['finalizedUnconsumedReviewInventory'],
      consumeReviewInventoryCompletenessReceipt: consume as ReviewInventoryAdmitApis['consumeReviewInventoryCompletenessReceipt'],
      verifyReviewInventoryEpoch: verifyEpoch as ReviewInventoryAdmitApis['verifyReviewInventoryEpoch'],
      verifyReviewInventoryReceipt: verifyReceipt as ReviewInventoryAdmitApis['verifyReviewInventoryReceipt'],
      isInventoryCompletenessOnlyReceipt: isCompletenessOnly as ReviewInventoryAdmitApis['isInventoryCompletenessOnlyReceipt'],
    };
  } catch {
    return null;
  }
}

export function nextCommandForBlocker(storyId: string, blockerCode?: string | null): string {
  switch (blockerCode) {
    case PRE_CERT_CHEAP_CHECK_REQUIRED:
      return `proof-or-stop validate --story=${storyId} --focus=fast --json`;
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
      return `proof-or-stop story_advance --storyId=${storyId} --phase=DEV`;
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
  if (state === 'ADMITTED') {
    return `proof-or-stop validate --story=${storyId} --json`;
  }
  if (state === 'RUNNING') {
    return `proof-or-stop certification_window_status --storyId=${storyId}`;
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
  const receiptHead = receipt.cutoff?.headHash ?? epoch?.cutoff?.headHash;
  const receiptMaterial = receipt.cutoff?.materialHash ?? epoch?.cutoff?.materialHash;
  const receiptStoryFiles = receipt.cutoff?.storyFilesHash ?? epoch?.cutoff?.storyFilesHash;
  if (!facts.headHash || !facts.materialHash || !facts.storyFilesHash
    || !receiptHead || !receiptMaterial || !receiptStoryFiles) {
    return 'Inventory cutoff or current certification hashes are missing; refuse rather than invent a second freshness hash.';
  }
  if (receiptHead !== facts.headHash && !facts.inventoryHeadMetadataContinuity) {
    return 'Inventory receipt is not on the current headHash lineage.';
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
  if (!facts.inventorySaturated) {
    return {
      admit: false,
      blockerCode: PRE_CERT_INVENTORY_NOT_FINALIZED,
      blockerDetail: 'Review inventory is not a signed B-3f3d saturated FINALIZED receipt with terminal required lanes, critic binding, and a zero-new-finding final wave. Inventory completeness-only receipts never admit PRE_CERT.',
    };
  }
  const cheap = facts.cheapCheckReceipt;
  if (!cheap
    || !verifyPrecertCheapCheckReceipt(cheap)
    || cheap.storyId !== facts.currentStoryId
    || cheap.headHash !== facts.headHash
    || cheap.materialHash !== facts.materialHash
    || cheap.storyFilesHash !== facts.storyFilesHash) {
    return {
      admit: false,
      blockerCode: PRE_CERT_CHEAP_CHECK_REQUIRED,
      blockerDetail: 'A current signed complete PASS from proof-or-stop validate --story=<id> --focus=fast --json is required before PRE_CERT can consume review inventory.',
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
  if (projection.observedDriftReason) lines.push(`Observed drift: ${projection.observedDriftReason}`);
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

/**
 * Persist the actual cheap focused command outcome before PRE_CERT admission.
 * This is intentionally not auto-committed: the receipt's headHash must still
 * equal the subject being admitted. `certification_window_begin` co-commits it
 * with the ensuing BLOCKED/ADMITTED window after it has consumed the fact.
 */
export function persistPrecertCheapCheckReceipt(args: {
  store: CertificationWindowStorePort;
  storyId: string;
  routineValidationIdentity: RoutineValidationIdentity;
  commandExecution: RoutineValidationCommandExecution;
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
}): PrecertCheapCheckReceipt {
  const unsignedInput: Omit<PrecertCheapCheckReceipt, '_hash' | 'receiptId' | 'createdAt'> = {
    schemaVersion: PRECERT_CHEAP_CHECK_RECEIPT_SCHEMA,
    storyId: args.storyId,
    authority: PRECERT_CHEAP_CHECK_AUTHORITY,
    result: 'PASS' as const,
    routineValidationIdentity: args.routineValidationIdentity,
    commandExecution: args.commandExecution,
    headHash: args.headHash,
    materialHash: args.materialHash,
    storyFilesHash: args.storyFilesHash,
  };
  // Validate the semantic shape before it is ever durable. A caller cannot
  // turn a generic/full/failing result into authority merely by passing it to
  // this store helper.
  const candidate = withSignedPrecertCheapCheckReceipt({
    ...unsignedInput,
    receiptId: `${args.storyId}:CHEAP-CHECK-CANDIDATE`,
    createdAt: new Date(0).toISOString(),
  });
  if (!verifyPrecertCheapCheckReceipt(candidate)) {
    throw new Error(`[${PRE_CERT_CHEAP_CHECK_REQUIRED}] PRE_CERT cheap check must be a complete PASS from validate --story=<id> --focus=fast --json`);
  }
  return withCertificationWindowLock(args.store, args.storyId, () => {
    const data = args.store.readCertificationWindows(args.storyId);
    const existing = currentPrecertCheapCheckReceipt({
      currentIdentity: args.routineValidationIdentity,
      data,
      storyId: args.storyId,
      headHash: args.headHash,
      materialHash: args.materialHash,
      storyFilesHash: args.storyFilesHash,
    });
    if (existing
      && existing.routineValidationIdentity.digest === args.routineValidationIdentity.digest
      && existing.commandExecution.commandCount === args.commandExecution.commandCount) return existing;
    const receipt = withSignedPrecertCheapCheckReceipt({
      ...unsignedInput,
      receiptId: nextPrecertCheapCheckReceiptId(data, args.storyId),
      createdAt: new Date().toISOString(),
    });
    data.receipts.push(receipt);
    args.store.writeCertificationWindows(args.storyId, data);
    return receipt;
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
    if (latest.state === 'RUNNING') {
      throw new Error(
        `[${PRE_CERT_WINDOW_ALREADY_CONSUMED}] CertificationWindow ${latest.windowId} has already authorized one heavy certification execution; `
        + 'an unchanged retry must reuse a signed current PASS or open a new PRE_CERT window after material changes.',
      );
    }
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
  const inspected = inspectCertificationWindowLineage(args);
  if (!inspected.drift.drifted) {
    return { window: inspected.window, receipt: inspected.receipt, advisory: inspected.drift.advisory };
  }
  return persistInvalidatedCertificationWindow({
    store: args.store,
    storyId: args.storyId,
    current: args.current,
    reason: inspected.drift.reason ?? 'certification subject changed',
  });
}

export function inspectCertificationWindowLineage(args: {
  store: CertificationWindowStorePort;
  storyId: string;
  current: CertificationWindowCurrentIdentity;
}): {
  window: CertificationWindow | null;
  receipt: PrecertReceipt | null;
  drift: { drifted: boolean; reason?: string; advisory?: CertificationWindowStatusProjection['advisory'] };
} {
  const loaded = loadVerifiedCertificationWindow(args.store, args.storyId);
  if (!loaded.window) return { window: null, receipt: null, drift: { drifted: false } };
  if (loaded.window.state !== 'ADMITTED' && loaded.window.state !== 'RUNNING') {
    return { window: loaded.window, receipt: loaded.receipt, drift: { drifted: false } };
  }
  const drift = detectCertificationWindowMaterialDrift(loaded.window, args.current);
  return { window: loaded.window, receipt: loaded.receipt, drift };
}

export function heavyCertificationStatusNext(storyId: string): string {
  return `proof-or-stop certification_window_status --storyId=${storyId}`;
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

export function requireCurrentHeavyCertificationWindow(args: {
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
  // windowAuthorizesHeavyCertification is a semantic predicate rather than a
  // TypeScript type guard; make its non-null consequence explicit here.
  if (!refreshed.window) {
    throw new Error(`[${PRE_CERT_WINDOW_REQUIRED}] current CertificationWindow disappeared during authorization`);
  }
  return { window: refreshed.window, receipt: refreshed.receipt };
}

/**
 * Atomically claim the one permitted heavy execution for the current window.
 * Callers that can reuse a signed PASS must use requireCurrentHeavyCertificationWindow
 * instead, so reuse cannot consume or re-run the suite.
 */
export function refuseHeavyCertificationUnlessAdmitted(args: {
  store: CertificationWindowStorePort;
  storyId: string;
  current: CertificationWindowCurrentIdentity;
}): { window: CertificationWindow; receipt: PrecertReceipt | null } {
  requireCurrentHeavyCertificationWindow(args);
  return persistRunningCertificationWindow({ store: args.store, storyId: args.storyId });
}

export function isOfficialHeavyValidateInvocation(args: {
  story?: string;
  full?: string | boolean;
  focus?: string;
  channel?: boolean;
  concept?: boolean;
  lint?: boolean;
}): boolean {
  // A story-scoped routine validate is the suite that makes a transition to
  // TEST admissible. Keep the isolated CLI gates and focused smokes outside
  // this classification so they remain available to prepare PRE_CERT.
  if (!args.story || args.channel || args.concept || args.lint) return false;
  // `--full` is an explicit request for the heavyweight suite. It remains
  // official-heavy even when a caller also supplies `--focus`: validate-file
  // forwarding preserves both flags, so treating focus as a blanket exemption
  // would create a PRE_CERT bypass.
  return args.full !== undefined || !args.focus;
}
