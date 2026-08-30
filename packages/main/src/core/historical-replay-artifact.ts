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
const MINIMUM_HISTORICAL_STORIES = 30;
const MAXIMUM_HISTORICAL_STORIES = 50;

// A historical replay proves the validation subject (inventory, catalog, and
// executed runners), not the bookkeeping that subsequently records its use.
// These are the only non-metadata paths that may appear after the recorded
// replay HEAD. They are consumers of the signed artifact or exact decision
// records describing that consumer behavior, never inputs to its replay
// campaign. Keep this list deliberately exact; a config, catalog, runner, or
// producer change must force a new signed replay.
const REPLAY_ADMISSION_NONEXECUTING_PATHS = new Set([
  'packages/main/src/core/historical-replay-artifact.ts',
  'packages/main/src/tasks/historical-replay-artifact-smoke.ts',
  // These paths only consume or mechanically guard evidence after a replay
  // completed. They neither participate in inventory/catalog derivation nor
  // execute, select, or configure replay runners.
  'packages/main/src/core/closeout-trust.ts',
  'packages/main/src/handlers/checklist.ts',
  'packages/main/src/tasks/closeout-trust-smoke.ts',
  'packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts',
  'scripts/verify-process-fact-contract.mjs',
  // This smoke reads pre-review evidence after it exists. It is not selected by
  // the replay producer and cannot affect inventory, catalog, or execution.
  'packages/main/src/tasks/proofstory-pre-review-check-smoke.ts',
  // These documents explain the verify-only/execute split. They are exact
  // records, rather than a broad docs/** exception, to keep the admission
  // boundary auditable.
  'docs/requirements/decisions/dynamic-validation-enforcement-evidence.md',
  'docs/requirements/decisions/story-aware-dynamic-validation-current-main-characterization.md',
  'docs/requirements/decisions/story-lifecycle.md',
]);

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
  expected: {
    head: string;
    inventoryDigest: string;
    catalogDigest: string;
    admittedHistoricalHead?: string;
    historicalHeadRejection?: string;
  },
): string[] {
  if (!signed(value)) return ['paired-performance-signature-invalid'];
  if (value.schema !== PAIRED_SCHEMA) return ['paired-performance-schema-invalid'];
  if (value.head !== expected.head && value.head !== expected.admittedHistoricalHead) {
    return ['paired-performance-head-stale', expected.historicalHeadRejection || 'paired-performance-head-drift-unadmitted'];
  }
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

function isPermittedReplayHeadDriftPath(path: string): boolean {
  return /^\.proof-or-stop\/story\/(?:actives|archived)\/[^/]+\//.test(path)
    || REPLAY_ADMISSION_NONEXECUTING_PATHS.has(path);
}

function readGitNameStatus(gitCwd: string, recordedHead: string, currentHead: string): { ok: true; paths: string[] } | { ok: false; reason: string } {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', recordedHead, currentHead], {
      cwd: gitCwd,
      stdio: 'ignore',
    });
  } catch {
    return { ok: false, reason: 'paired-performance-head-nonancestor' };
  }

  try {
    const output = execFileSync('git', [
      'diff', '--name-status', '-z', '--find-renames', '--find-copies', recordedHead, currentHead,
    ], { cwd: gitCwd, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
    const tokens = output.toString('utf8').split('\0');
    if (tokens[tokens.length - 1] === '') tokens.pop();
    const paths: string[] = [];
    for (let index = 0; index < tokens.length;) {
      const status = tokens[index++];
      if (!status) return { ok: false, reason: 'paired-performance-head-drift-unreadable' };
      const requiresTwoPaths = status.startsWith('R') || status.startsWith('C');
      const count = requiresTwoPaths ? 2 : 1;
      const changedPaths = tokens.slice(index, index + count);
      if (changedPaths.length !== count || changedPaths.some((path) => !path)) {
        return { ok: false, reason: 'paired-performance-head-drift-unreadable' };
      }
      index += count;
      paths.push(...changedPaths);
    }
    return { ok: true, paths };
  } catch {
    return { ok: false, reason: 'paired-performance-head-drift-unreadable' };
  }
}

function admitMetadataOnlyReplayHeadDrift(
  gitCwd: string,
  recordedHead: string,
  currentHead: string,
): { ok: true } | { ok: false; reason: string } {
  if (recordedHead === currentHead) return { ok: true };
  const diff = readGitNameStatus(gitCwd, recordedHead, currentHead);
  if (!diff.ok) return diff;
  return diff.paths.every(isPermittedReplayHeadDriftPath)
    ? { ok: true }
    : { ok: false, reason: 'paired-performance-head-drift-nonadmissible' };
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
  if (!records
    || records.length < MINIMUM_HISTORICAL_STORIES
    || records.length > MAXIMUM_HISTORICAL_STORIES
    || report.storyCount !== records.length) {
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
    let admittedHistoricalHead: string | undefined;
    let historicalHeadRejection: string | undefined;
    if (isRecord(pairedInReport) && signed(pairedInReport) && typeof pairedInReport.head === 'string') {
      const admission = admitMetadataOnlyReplayHeadDrift(gitCwd, pairedInReport.head, head);
      if (admission.ok) admittedHistoricalHead = pairedInReport.head;
      else historicalHeadRejection = admission.reason;
    }
    const expected = { head, inventoryDigest, catalogDigest, admittedHistoricalHead, historicalHeadRejection };
    reasons.push(...checkPairedPerformance(pairedInReport, expected));
    if (pairedOnDisk) reasons.push(...checkPairedPerformance(pairedOnDisk, expected));
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
