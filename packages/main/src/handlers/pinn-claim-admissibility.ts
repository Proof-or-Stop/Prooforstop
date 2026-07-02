import { readFileSync } from 'node:fs';
import type { HandlerContext } from './context.js';
import {
  PINN_BOUNDARY_PARAGRAPH,
  PINN_CLAIM_BOUNDARY_NARRATIVE_OVERCLAIM_PATTERN,
  buildCompletePinnEvidence,
  buildInjectedPinnEvidence,
  evaluatePinnClaim,
  renderPinnBenchmarkText,
  renderPinnClaimCheckText,
  renderPinnReportText,
  runPinnClaimBenchmark,
  type PinnArmMetrics,
  type PinnArtifactIndexEntry,
  type PinnBenchmarkReport,
  type PinnClaimCheckInput,
  type PinnClaimId,
  type PinnInjectionSpec,
} from '../core/pinn-claim-admissibility.js';

interface FormatArgs {
  format?: 'text' | 'json';
  json?: boolean;
}

interface PinnClaimCheckArgs extends FormatArgs {
  claimId?: PinnClaimId;
  fixture?: 'complete';
  injection?: string;
  evidenceJson?: string;
  evidencePath?: string;
  deploymentReadyClaim?: never;
  productionReadyClaim?: never;
  externalCompletionClaim?: never;
  terminalCompletionClaim?: never;
  pdeCorrectnessClaim?: never;
}

interface PinnBenchmarkArgs extends FormatArgs {
  deploymentReadyClaim?: never;
  productionReadyClaim?: never;
  externalCompletionClaim?: never;
  terminalCompletionClaim?: never;
  pdeCorrectnessClaim?: never;
}

interface PinnReportArgs extends FormatArgs {
  benchmarkJson?: string;
  benchmarkPath?: string;
  deploymentReadyClaim?: never;
  productionReadyClaim?: never;
  externalCompletionClaim?: never;
  terminalCompletionClaim?: never;
  pdeCorrectnessClaim?: never;
}

const UNSUPPORTED_FLAGS = [
  'runCommands',
  'writeEvidence',
  'advancePhase',
  'launchReviewers',
  'deploymentReadyClaim',
  'productionReadyClaim',
  'externalCompletionClaim',
  'terminalCompletionClaim',
  'pdeCorrectnessClaim',
  'write',
  'apply',
  'execute',
  'run',
  'launch',
  'capture',
  'refresh',
] as const;

const RETIRED_REPORT_CLAIM_FIELDS = [
  ['production', 'Done'].join(''),
  ['authority', 'Done'].join(''),
  ['full', 'Authority', 'Done'].join(''),
] as readonly string[];

const REPORT_CLAIM_FIELDS = ['deploymentReadyClaim', 'productionReadyClaim', 'externalCompletionClaim', 'terminalCompletionClaim', 'pdeCorrectnessClaim'] as const;
const REPORT_OVERCLAIM_FIELDS = [...REPORT_CLAIM_FIELDS, ...RETIRED_REPORT_CLAIM_FIELDS] as const;
const REPORT_FIELD_OVERCLAIM_PATTERN = new RegExp(String.raw`(?:^|[^A-Za-z0-9_])["']?(?:${REPORT_OVERCLAIM_FIELDS.join('|')})["']?\s*[:=]\s*(?:true|1|yes|y|on)\b`, 'i');
const BENCHMARK_SCHEMA_VERSION = 'lattice.pinn_claim_admissibility_benchmark.v1' as const;
const REPORT_INJECTION_CLASSES = ['missing', 'stale', 'unsafe', 'overclaim'] as const;
const REPORT_ARM_IDS = ['A1', 'A2', 'A3', 'A4'] as const;

const SAFE_REPORT_CLAIMS = {
  deploymentReadyClaim: false,
  productionReadyClaim: false,
  externalCompletionClaim: false,
  terminalCompletionClaim: false,
  pdeCorrectnessClaim: false,
} as const;

const TRUEISH_OVERCLAIM_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);

function wantsJson(args: FormatArgs = {}): boolean {
  return args.json === true || args.format === 'json';
}

function assertReadOnlyBoundary(command: string, args: Record<string, unknown>): void {
  const rejected = UNSUPPORTED_FLAGS.filter((flag) => Object.prototype.hasOwnProperty.call(args, flag));
  if (rejected.length === 0) return;
  throw new Error(`${command} refuses unsupported side effects or overclaims: ${rejected.join(', ')}.`);
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function isUnsafeOverclaimValue(value: unknown): boolean {
  if (value === true) return true;
  if (value === 1) return true;
  if (typeof value !== 'string') return false;
  return TRUEISH_OVERCLAIM_VALUES.has(value.trim().toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUnsafeReportText(value: string): boolean {
  if (value === PINN_BOUNDARY_PARAGRAPH) return false;
  return REPORT_FIELD_OVERCLAIM_PATTERN.test(value) || PINN_CLAIM_BOUNDARY_NARRATIVE_OVERCLAIM_PATTERN.test(value);
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function scanBenchmarkReportOverclaims(value: unknown, path: string, overclaims: string[], seen = new WeakSet<object>()): void {
  if (typeof value === 'string') {
    if (isUnsafeReportText(value)) pushUnique(overclaims, path);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanBenchmarkReportOverclaims(item, `${path}[${index}]`, overclaims, seen));
    return;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedPath = path ? `${path}.${key}` : key;
    if (isUnsafeReportText(key)) pushUnique(overclaims, `${nestedPath} key`);
    if ((REPORT_OVERCLAIM_FIELDS as readonly string[]).includes(key) && isUnsafeOverclaimValue(nestedValue)) {
      pushUnique(overclaims, nestedPath);
    }
    scanBenchmarkReportOverclaims(nestedValue, nestedPath, overclaims, seen);
  }
}

function assertValidBenchmarkShape(condition: unknown, label: string, path: string): asserts condition {
  if (!condition) throw new Error(`${label} has invalid benchmark report shape at ${path}.`);
}

function stringField(value: unknown, label: string, path: string): string {
  assertValidBenchmarkShape(typeof value === 'string', label, path);
  return value;
}

function numberField(value: unknown, label: string, path: string): number {
  assertValidBenchmarkShape(typeof value === 'number' && Number.isFinite(value), label, path);
  return value;
}

function stringArrayField(value: unknown, label: string, path: string): string[] {
  assertValidBenchmarkShape(Array.isArray(value), label, path);
  return value.map((item, index) => stringField(item, label, `${path}[${index}]`));
}

function recordField(value: unknown, label: string, path: string): Record<string, unknown> {
  assertValidBenchmarkShape(isRecord(value), label, path);
  return value;
}

function isInjectionClass(value: string): value is PinnInjectionSpec['class'] {
  return (REPORT_INJECTION_CLASSES as readonly string[]).includes(value);
}

function isArmId(value: string): value is PinnArmMetrics['armId'] {
  return (REPORT_ARM_IDS as readonly string[]).includes(value);
}

function sanitizeInjectionSpec(value: unknown, label: string, path: string): PinnInjectionSpec {
  const record = recordField(value, label, path);
  const injectionClass = stringField(record.class, label, `${path}.class`);
  assertValidBenchmarkShape(isInjectionClass(injectionClass), label, `${path}.class`);
  return {
    id: stringField(record.id, label, `${path}.id`),
    title: stringField(record.title, label, `${path}.title`),
    class: injectionClass,
    expectedA4Reason: stringField(record.expectedA4Reason, label, `${path}.expectedA4Reason`),
  };
}

function sanitizeWilsonInterval(value: unknown, label: string, path: string): PinnArmMetrics['rejectionWilson95'] {
  const record = recordField(value, label, path);
  return {
    low: numberField(record.low, label, `${path}.low`),
    high: numberField(record.high, label, `${path}.high`),
  };
}

function sanitizeArmMetrics(value: unknown, label: string, path: string): PinnArmMetrics {
  const record = recordField(value, label, path);
  const armId = stringField(record.armId, label, `${path}.armId`);
  assertValidBenchmarkShape(isArmId(armId), label, `${path}.armId`);
  return {
    armId,
    name: stringField(record.name, label, `${path}.name`),
    total: numberField(record.total, label, `${path}.total`),
    acceptedCount: numberField(record.acceptedCount, label, `${path}.acceptedCount`),
    rejectedCount: numberField(record.rejectedCount, label, `${path}.rejectedCount`),
    unsupportedAcceptanceCount: numberField(record.unsupportedAcceptanceCount, label, `${path}.unsupportedAcceptanceCount`),
    staleAcceptanceCount: numberField(record.staleAcceptanceCount, label, `${path}.staleAcceptanceCount`),
    rejectedInjectionCount: numberField(record.rejectedInjectionCount, label, `${path}.rejectedInjectionCount`),
    rejectionRate: numberField(record.rejectionRate, label, `${path}.rejectionRate`),
    rejectionWilson95: sanitizeWilsonInterval(record.rejectionWilson95, label, `${path}.rejectionWilson95`),
    meanWallTimeMs: numberField(record.meanWallTimeMs, label, `${path}.meanWallTimeMs`),
    meanInterventionCount: numberField(record.meanInterventionCount, label, `${path}.meanInterventionCount`),
    acceptedInjectionIds: stringArrayField(record.acceptedInjectionIds, label, `${path}.acceptedInjectionIds`),
    rejectedInjectionIds: stringArrayField(record.rejectedInjectionIds, label, `${path}.rejectedInjectionIds`),
  };
}

function sanitizeArtifactIndexEntry(value: unknown, label: string, path: string): PinnArtifactIndexEntry {
  const record = recordField(value, label, path);
  return {
    id: stringField(record.id, label, `${path}.id`),
    kind: stringField(record.kind, label, `${path}.kind`),
    digest: stringField(record.digest, label, `${path}.digest`),
  };
}

function evidenceFromArgs(args: PinnClaimCheckArgs): PinnClaimCheckInput {
  if (args.evidenceJson) return parseJsonObject(args.evidenceJson, 'evidenceJson') as unknown as PinnClaimCheckInput;
  if (args.evidencePath) return parseJsonObject(readFileSync(args.evidencePath, 'utf-8'), 'evidencePath') as unknown as PinnClaimCheckInput;
  if (args.injection) return buildInjectedPinnEvidence(args.injection);
  return buildCompletePinnEvidence(args.claimId ?? 'C9');
}

function normalizeBenchmarkReport(report: unknown, label: string): PinnBenchmarkReport {
  const rawReport = recordField(report, label, 'report');
  const rawClaims = rawReport.claims;
  const claimRecord = isRecord(rawClaims) ? rawClaims : {};
  const overclaims: string[] = [];
  scanBenchmarkReportOverclaims(rawReport, '', overclaims);
  for (const field of REPORT_CLAIM_FIELDS) {
    if (isUnsafeOverclaimValue(rawReport[field]) || isUnsafeOverclaimValue(claimRecord[field])) pushUnique(overclaims, field);
  }
  for (const field of RETIRED_REPORT_CLAIM_FIELDS) {
    if (isUnsafeOverclaimValue(rawReport[field]) || isUnsafeOverclaimValue(claimRecord[field])) pushUnique(overclaims, field);
  }
  if (rawReport.boundary !== undefined && rawReport.boundary !== PINN_BOUNDARY_PARAGRAPH) pushUnique(overclaims, 'boundary');
  if (overclaims.length > 0) {
    throw new Error(`${label} refuses benchmark report overclaims: ${overclaims.join(', ')}.`);
  }
  const suiteStatus = stringField(rawReport.suiteStatus, label, 'suiteStatus');
  assertValidBenchmarkShape(suiteStatus === 'PASS' || suiteStatus === 'FAIL', label, 'suiteStatus');
  const rawInjections = rawReport.injections;
  assertValidBenchmarkShape(Array.isArray(rawInjections), label, 'injections');
  const rawArms = rawReport.arms;
  assertValidBenchmarkShape(Array.isArray(rawArms), label, 'arms');
  const rawArtifactIndex = rawReport.artifactIndex;
  assertValidBenchmarkShape(Array.isArray(rawArtifactIndex), label, 'artifactIndex');
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    suiteStatus,
    generatedAt: stringField(rawReport.generatedAt, label, 'generatedAt'),
    totalInjections: numberField(rawReport.totalInjections, label, 'totalInjections'),
    injections: rawInjections.map((injection, index) => sanitizeInjectionSpec(injection, label, `injections[${index}]`)),
    arms: rawArms.map((arm, index) => sanitizeArmMetrics(arm, label, `arms[${index}]`)),
    a4: sanitizeArmMetrics(rawReport.a4, label, 'a4'),
    claims: { ...SAFE_REPORT_CLAIMS },
    boundary: PINN_BOUNDARY_PARAGRAPH,
    artifactIndex: rawArtifactIndex.map((entry, index) => sanitizeArtifactIndexEntry(entry, label, `artifactIndex[${index}]`)),
  };
}

function benchmarkFromArgs(args: PinnReportArgs): PinnBenchmarkReport {
  if (args.benchmarkJson) return normalizeBenchmarkReport(parseJsonObject(args.benchmarkJson, 'benchmarkJson') as unknown as PinnBenchmarkReport, 'benchmarkJson');
  if (args.benchmarkPath) return normalizeBenchmarkReport(parseJsonObject(readFileSync(args.benchmarkPath, 'utf-8'), 'benchmarkPath') as unknown as PinnBenchmarkReport, 'benchmarkPath');
  return normalizeBenchmarkReport(runPinnClaimBenchmark(), 'generated benchmark');
}

export function createPinnClaimAdmissibilityHandlers(_ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    pinn_claim_check(args: PinnClaimCheckArgs = {}) {
      assertReadOnlyBoundary('pinn_claim_check', args as Record<string, unknown>);
      const result = evaluatePinnClaim(evidenceFromArgs(args));
      return wantsJson(args) ? result : renderPinnClaimCheckText(result);
    },
    pinn_benchmark_run(args: PinnBenchmarkArgs = {}) {
      assertReadOnlyBoundary('pinn_benchmark_run', args as Record<string, unknown>);
      const result = runPinnClaimBenchmark();
      return wantsJson(args) ? result : renderPinnBenchmarkText(result);
    },
    pinn_report_render(args: PinnReportArgs = {}) {
      assertReadOnlyBoundary('pinn_report_render', args as Record<string, unknown>);
      const result = benchmarkFromArgs(args);
      return wantsJson(args) ? result : renderPinnReportText(result);
    },
  };
}
