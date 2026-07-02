import { readFileSync } from 'node:fs';
import type { HandlerContext } from './context.js';
import {
  PINN_BOUNDARY_PARAGRAPH,
  buildCompletePinnEvidence,
  buildInjectedPinnEvidence,
  evaluatePinnClaim,
  renderPinnBenchmarkText,
  renderPinnClaimCheckText,
  renderPinnReportText,
  runPinnClaimBenchmark,
  type PinnBenchmarkReport,
  type PinnClaimCheckInput,
  type PinnClaimId,
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
  externalCompletionClaim?: never;
  terminalCompletionClaim?: never;
  pdeCorrectnessClaim?: never;
}

interface PinnBenchmarkArgs extends FormatArgs {
  deploymentReadyClaim?: never;
  externalCompletionClaim?: never;
  terminalCompletionClaim?: never;
  pdeCorrectnessClaim?: never;
}

interface PinnReportArgs extends FormatArgs {
  benchmarkJson?: string;
  benchmarkPath?: string;
  deploymentReadyClaim?: never;
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

const REPORT_CLAIM_FIELDS = ['deploymentReadyClaim', 'externalCompletionClaim', 'terminalCompletionClaim', 'pdeCorrectnessClaim'] as const;

const SAFE_REPORT_CLAIMS = {
  deploymentReadyClaim: false,
  externalCompletionClaim: false,
  terminalCompletionClaim: false,
  pdeCorrectnessClaim: false,
} as const;

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

function evidenceFromArgs(args: PinnClaimCheckArgs): PinnClaimCheckInput {
  if (args.evidenceJson) return parseJsonObject(args.evidenceJson, 'evidenceJson') as unknown as PinnClaimCheckInput;
  if (args.evidencePath) return parseJsonObject(readFileSync(args.evidencePath, 'utf-8'), 'evidencePath') as unknown as PinnClaimCheckInput;
  if (args.injection) return buildInjectedPinnEvidence(args.injection);
  return buildCompletePinnEvidence(args.claimId ?? 'C9');
}

function normalizeBenchmarkReport(report: PinnBenchmarkReport, label: string): PinnBenchmarkReport {
  const rawReport = report as PinnBenchmarkReport & Record<string, unknown>;
  const rawClaims = rawReport.claims;
  const claimRecord = rawClaims && typeof rawClaims === 'object' && !Array.isArray(rawClaims)
    ? rawClaims as Record<string, unknown>
    : {};
  const overclaims: string[] = [];
  for (const field of REPORT_CLAIM_FIELDS) {
    if (rawReport[field] === true || claimRecord[field] === true) overclaims.push(field);
  }
  for (const field of RETIRED_REPORT_CLAIM_FIELDS) {
    if (rawReport[field] === true || claimRecord[field] === true) overclaims.push(field);
  }
  if (rawReport.boundary !== undefined && rawReport.boundary !== PINN_BOUNDARY_PARAGRAPH) overclaims.push('boundary');
  if (overclaims.length > 0) {
    throw new Error(`${label} refuses benchmark report overclaims: ${overclaims.join(', ')}.`);
  }
  return {
    ...report,
    claims: { ...SAFE_REPORT_CLAIMS },
    boundary: PINN_BOUNDARY_PARAGRAPH,
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
