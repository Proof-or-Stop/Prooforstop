import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withMkdirLock } from './mkdir-lock.js';

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
export const PRE_CERT_WINDOW_MISSING = 'pre_cert_window_missing';
export const PRE_CERT_WINDOW_TAMPERED = 'pre_cert_window_tampered';
export const PRE_CERT_RECEIPT_TAMPERED = 'pre_cert_receipt_tampered';
export const PRE_CERT_INVENTORY_NOT_AUTHORITY = 'pre_cert_inventory_not_certification_authority';

export interface CertificationWindowFrozenIdentity {
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
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

export interface ReviewInventoryAdmitApis {
  finalizedUnconsumedReviewInventory: (
    store: unknown,
    storyId: string,
  ) => { epoch?: { epochId?: string }; receipt?: InventoryCompletenessReceipt } | null;
}

export interface InventoryCompletenessReceipt {
  receiptId?: string;
  authority?: string;
  authorizesTest?: boolean;
}

export interface CertificationWindowStatusProjection {
  storyId: string;
  window: CertificationWindow | null;
  receipt: PrecertReceipt | null;
  blockerCode: string | null;
  nextCommand: string;
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
  if (!receipt) return Boolean(window.receiptId);
  if (!verifyPrecertReceipt(receipt)) return false;
  return receipt.windowId === window.windowId
    && receipt.storyId === window.storyId
    && receipt.receiptId === window.receiptId;
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

/**
 * Optional B-3f3d inventory APIs. This worktree does not ship them; begin stays
 * fail-closed instead of stub-always-admitting. CHK-002 wires the real import.
 */
export function loadReviewInventoryAdmitApis(): ReviewInventoryAdmitApis | null {
  const modulePath = fileURLToPath(new URL('./review-inventory-epoch.js', import.meta.url));
  if (!existsSync(modulePath)) return null;
  return null;
}

export function nextCommandForState(storyId: string, state: CertificationWindowState): string {
  if (state === 'INVALIDATED') {
    return `proof-or-stop story_advance --storyId=${storyId} --phase=REVIEW`;
  }
  if (state === 'ADMITTED' || state === 'RUNNING') {
    return `proof-or-stop done_required_validate --storyId=${storyId}`;
  }
  if (state === 'FINALIZED') {
    return `proof-or-stop certification_window_status --storyId=${storyId}`;
  }
  return `proof-or-stop certification_window_begin --storyId=${storyId}`;
}

export function projectCertificationWindowStatus(
  storyId: string,
  window: CertificationWindow | null,
  receipt: PrecertReceipt | null = null,
): CertificationWindowStatusProjection {
  if (!window) {
    return {
      storyId,
      window: null,
      receipt: null,
      blockerCode: PRE_CERT_WINDOW_MISSING,
      nextCommand: nextCommandForState(storyId, 'BLOCKED'),
    };
  }
  return {
    storyId,
    window,
    receipt,
    blockerCode: window.blockerCode
      ?? (window.state === 'INVALIDATED' ? window.invalidation?.blockerCode ?? null : null)
      ?? (window.state === 'BLOCKED' ? PRE_CERT_WINDOW_MISSING : null),
    nextCommand: nextCommandForState(storyId, window.state),
  };
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
    if (latest && verifyCertificationWindow(latest) && latest.state === 'BLOCKED' && latest.blockerCode === args.blockerCode) {
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
