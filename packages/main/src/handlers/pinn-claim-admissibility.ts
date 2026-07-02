import { readFileSync } from 'node:fs';
import type { HandlerContext } from './context.js';
import {
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
  productionDone?: never;
  authorityDone?: never;
  fullAuthorityDone?: never;
  pdeCorrectnessClaim?: never;
}

interface PinnBenchmarkArgs extends FormatArgs {
  productionDone?: never;
  authorityDone?: never;
  fullAuthorityDone?: never;
  pdeCorrectnessClaim?: never;
}

interface PinnReportArgs extends FormatArgs {
  benchmarkJson?: string;
  benchmarkPath?: string;
  productionDone?: never;
  authorityDone?: never;
  fullAuthorityDone?: never;
  pdeCorrectnessClaim?: never;
}

const UNSUPPORTED_FLAGS = [
  'runCommands',
  'writeEvidence',
  'advancePhase',
  'launchReviewers',
  'authorityDone',
  'fullAuthorityDone',
  'productionDone',
  'pdeCorrectnessClaim',
  'write',
  'apply',
  'execute',
  'run',
  'launch',
  'capture',
  'refresh',
] as const;

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

function benchmarkFromArgs(args: PinnReportArgs): PinnBenchmarkReport {
  if (args.benchmarkJson) return parseJsonObject(args.benchmarkJson, 'benchmarkJson') as unknown as PinnBenchmarkReport;
  if (args.benchmarkPath) return parseJsonObject(readFileSync(args.benchmarkPath, 'utf-8'), 'benchmarkPath') as unknown as PinnBenchmarkReport;
  return runPinnClaimBenchmark();
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
