import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { resolveProjectGitCwd } from './story-signed-workspace-resolution.js';
import { compileValidationCatalog, discoverValidationInventory, stableDigest, verifyPayload } from './story-aware-validation.js';

const REPORT_SCHEMA = 'proof-or-stop.dynamic-validation.historical-replay.v1';
const PAIRED_SCHEMA = 'proof-or-stop.dynamic-validation.paired-performance.v1';
const FAULT_SCHEMA = 'proof-or-stop.dynamic-validation.fault-injection.v1';
const RECEIPT_SCHEMA = 'proof-or-stop.dynamic-validation.replay-command-receipt.v1';
const REQUIRED_FAULT_FAMILIES = ['FI-1', 'FI-2', 'FI-3', 'FI-4', 'FI-5'];
const MINIMUM_HISTORICAL_STORIES = 50;

export interface HistoricalReplayArtifactAdmission {
  ok: boolean;
  reasons: string[];
  reportPath: string;
  pairedPerformancePath: string;
  head?: string;
  inventoryDigest?: string;
  catalogDigest?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function withoutSignature(value: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...value };
  delete copy.signature;
  return copy;
}

function signed(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && typeof value.signature === 'string'
    && verifyPayload(withoutSignature(value), value.signature);
}

function readArtifact(path: string, label: string, reasons: string[]): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    reasons.push(`${label}-missing`);
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(parsed)) {
      reasons.push(`${label}-malformed`);
      return undefined;
    }
    return parsed;
  } catch {
    reasons.push(`${label}-malformed`);
    return undefined;
  }
}

function checkReceipt(
  receipt: unknown,
  expected: { storyId: string; baseHead: string; head: string },
): string | undefined {
  if (!signed(receipt)) return 'receipt-signature-invalid';
  if (receipt.schema !== RECEIPT_SCHEMA) return 'receipt-schema-invalid';
  if (receipt.storyId !== expected.storyId || receipt.baseHead !== expected.baseHead || receipt.head !== expected.head) {
    return 'receipt-identity-mismatch';
  }
  if (receipt.mode !== 'full' && receipt.mode !== 'dynamic') return 'receipt-mode-invalid';
  return undefined;
}

function checkHistoricalRecord(record: unknown, index: number): string[] {
  const prefix = `record-${index + 1}`;
  if (!isRecord(record)) return [`${prefix}-malformed`];
  if (typeof record.storyId !== 'string' || typeof record.baseHead !== 'string' || typeof record.head !== 'string') {
    return [`${prefix}-identity-missing`];
  }
  const execution = record.execution;
  if (!isRecord(execution)) return [`${prefix}-execution-missing`];
  if (!Array.isArray(execution.receipts) || execution.receipts.length !== 2) return [`${prefix}-receipt-count-invalid`];
  if (!Array.isArray(execution.residue) || execution.residue.length !== 0) return [`${prefix}-residue-invalid`];
  const selectedCommandIds = Array.isArray(record.selectedCommandIds) ? record.selectedCommandIds : undefined;
  if (!Array.isArray(execution.fullFailures) || !selectedCommandIds
    || !execution.fullFailures.every((id) => typeof id === 'string' && selectedCommandIds.includes(id))) {
    return [`${prefix}-full-failure-coverage-invalid`];
  }
  if (typeof execution.perCommandEquivalent !== 'boolean'
    || typeof execution.selectedCount !== 'number'
    || typeof execution.reusedCount !== 'number'
    || typeof execution.fullEscalated !== 'boolean'
    || typeof execution.dependencyGraphDigest !== 'string'
    || execution.dependencyGraphDigest.length === 0) {
    return [`${prefix}-execution-summary-invalid`];
  }
  const modes = new Set<string>();
  for (const receipt of execution.receipts) {
    const issue = checkReceipt(receipt, {
      storyId: record.storyId,
      baseHead: record.baseHead,
      head: record.head,
    });
    if (issue) return [`${prefix}-${issue}`];
    modes.add((receipt as Record<string, unknown>).mode as string);
  }
  return modes.size === 2 && modes.has('full') && modes.has('dynamic')
    ? []
    : [`${prefix}-receipt-modes-invalid`];
}

function checkFaultInjection(value: unknown): string[] {
  if (!signed(value)) return ['fault-injection-signature-invalid'];
  if (value.schema !== FAULT_SCHEMA || value.allPass !== true) return ['fault-injection-summary-invalid'];
  const families = value.requiredFamilies;
  const rows = value.rows;
  if (!Array.isArray(families) || stableDigest(families.slice().sort()) !== stableDigest(REQUIRED_FAULT_FAMILIES)) {
    return ['fault-injection-families-invalid'];
  }
  if (!Array.isArray(rows)) return ['fault-injection-rows-invalid'];
  for (const family of REQUIRED_FAULT_FAMILIES) {
    const matching = rows.filter((row) => isRecord(row) && row.fiId === family);
    if (matching.length === 0 || matching.some((row) => row.passed !== true)) return [`fault-injection-${family}-invalid`];
  }
  return [];
}

function checkPairedPerformance(
  value: unknown,
  expected: { head: string; inventoryDigest: string; catalogDigest: string },
): string[] {
  if (!signed(value)) return ['paired-performance-signature-invalid'];
  if (value.schema !== PAIRED_SCHEMA) return ['paired-performance-schema-invalid'];
  if (value.head !== expected.head) return ['paired-performance-head-stale'];
  if (value.inventoryDigest !== expected.inventoryDigest) return ['paired-performance-inventory-stale'];
  if (value.catalogDigest !== expected.catalogDigest) return ['paired-performance-catalog-stale'];
  if (value.perCommandEquivalent !== true || value.verdictEquivalent !== true) return ['paired-performance-equivalence-invalid'];
  if (value.order !== 'full-dynamic / dynamic-full / full-dynamic') return ['paired-performance-order-invalid'];
  if (!Array.isArray(value.runs) || value.runs.length !== 6) return ['paired-performance-runs-invalid'];
  for (let pair = 1; pair <= 3; pair++) {
    const modes = new Set<string>();
    for (const run of value.runs.filter((candidate) => isRecord(candidate) && candidate.pair === pair)) {
      if (!Array.isArray(run.residue) || run.residue.length !== 0 || !Array.isArray(run.verdicts) || typeof run.commandCount !== 'number') {
        return [`paired-performance-pair-${pair}-invalid`];
      }
      if (run.mode !== 'full' && run.mode !== 'dynamic') return [`paired-performance-pair-${pair}-mode-invalid`];
      modes.add(run.mode);
    }
    if (modes.size !== 2 || !modes.has('full') || !modes.has('dynamic')) return [`paired-performance-pair-${pair}-missing`];
  }
  return [];
}

/**
 * Admit a persisted historical replay only when it is a signed, complete proof for
 * this exact repository root, current commit, and current validation catalog. This
 * function never invokes the replay producer; callers use it to keep a verifier
 * mechanical without turning a threshold check into an unbounded campaign.
 */
export function verifyHistoricalReplayArtifact(projectRoot: string): HistoricalReplayArtifactAdmission {
  const root = resolve(projectRoot);
  const outputRoot = join(root, '.proof-or-stop', 'runtime', 'dynamic-validation', 'historical-replay');
  const reportPath = join(outputRoot, 'report.json');
  const pairedPerformancePath = join(outputRoot, 'paired-performance.json');
  const reasons: string[] = [];
  const report = readArtifact(reportPath, 'historical-replay-report', reasons);
  if (!report) return { ok: false, reasons, reportPath, pairedPerformancePath };
  if (!signed(report)) reasons.push('historical-replay-report-signature-invalid');
  if (report.schema !== REPORT_SCHEMA) reasons.push('historical-replay-report-schema-invalid');
  if (report.root !== root) reasons.push('historical-replay-report-root-mismatch');
  if (report.execute !== true) reasons.push('historical-replay-report-not-executed');
  if (!isRecord(report.admissibility) || report.admissibility.execute !== true
    || report.admissibility.pairedRequested !== true || report.admissibility.admissible !== true
    || !Array.isArray(report.admissibility.reasons) || report.admissibility.reasons.length !== 0) {
    reasons.push('historical-replay-report-inadmissible');
  }
  const records = Array.isArray(report.records) ? report.records : undefined;
  if (!records || records.length < MINIMUM_HISTORICAL_STORIES || report.storyCount !== records.length) {
    reasons.push('historical-replay-record-count-invalid');
  } else {
    if (report.recordsDigest !== stableDigest(records)) reasons.push('historical-replay-records-digest-invalid');
    const storyIds = new Set<string>();
    records.forEach((record, index) => {
      const recordReasons = checkHistoricalRecord(record, index);
      reasons.push(...recordReasons);
      if (isRecord(record) && typeof record.storyId === 'string') storyIds.add(record.storyId);
    });
    if (storyIds.size !== records.length) reasons.push('historical-replay-record-identities-invalid');
  }
  reasons.push(...checkFaultInjection(report.faultInjection));

  let gitCwd = root;
  let head: string | undefined;
  let inventoryDigest: string | undefined;
  let catalogDigest: string | undefined;
  try {
    gitCwd = resolveProjectGitCwd(root, root, loadConfig(root));
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const inventory = discoverValidationInventory(root);
    inventoryDigest = inventory.digest;
    catalogDigest = stableDigest(compileValidationCatalog(inventory));
  } catch {
    reasons.push('historical-replay-current-source-unavailable');
  }

  const pairedOnDisk = readArtifact(pairedPerformancePath, 'paired-performance', reasons);
  const pairedInReport = report.pairedPerformance;
  if (!pairedOnDisk || !isRecord(pairedInReport)) {
    reasons.push('paired-performance-missing');
  } else if (stableDigest(pairedOnDisk) !== stableDigest(pairedInReport)) {
    reasons.push('paired-performance-report-mismatch');
  }
  if (head && inventoryDigest && catalogDigest) {
    reasons.push(...checkPairedPerformance(pairedInReport, { head, inventoryDigest, catalogDigest }));
    if (pairedOnDisk) reasons.push(...checkPairedPerformance(pairedOnDisk, { head, inventoryDigest, catalogDigest }));
  }

  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    reportPath,
    pairedPerformancePath,
    ...(head ? { head } : {}),
    ...(inventoryDigest ? { inventoryDigest } : {}),
    ...(catalogDigest ? { catalogDigest } : {}),
  };
}
