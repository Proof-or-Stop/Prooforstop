import { join } from 'node:path';
import type { HandlerContext } from './context.js';
import {
  aggregateBaselineReports,
  collectBaselineReports,
  loadBaselineReport,
  runBaseline,
  writeSuiteReport,
  type BaselineAuthorityMode,
  type BaselineExpectedOutcome,
  type BaselineId,
} from '../core/baseline.js';

type JsonArgs = { json?: boolean; format?: 'text' | 'json' };

function wantsJson(args: JsonArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function render(title: string, data: Record<string, unknown>): string {
  return [
    title,
    ...Object.entries(data).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.length : String(value)}`),
  ].join('\n');
}

function splitFiles(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map(part => part.trim()).filter(Boolean);
  return [];
}

export function createBaselineHandlers(ctx: HandlerContext) {
  return {
    baseline_run(args: {
      baselineId: BaselineId;
      runId?: string;
      authorityMode?: BaselineAuthorityMode;
      expectedOutcome?: BaselineExpectedOutcome;
      outputRoot?: string;
      requestText?: string;
      receiptVerified?: boolean;
      gateReceiptVerifiedAgainstPinnedKey?: boolean;
      gateReceiptJson?: string;
      gateReceiptPath?: string;
      hostVerdictsJson?: string;
      hostVerdictsPath?: string;
      gateInputDigest?: string;
      receiptInputDigest?: string;
      satisfiedReviewWaves?: number;
      requiredReviewWaves?: number;
      staleVerdicts?: number;
      failingIndependentHosts?: number;
      serverBackedVerdictsAccepted?: boolean;
      localReviewCertified?: boolean;
      authorityServerContact?: boolean;
      retryCount?: number;
      repairCount?: number;
      blockedReason?: string;
    } & JsonArgs) {
      const result = runBaseline(ctx.root, args);
      return wantsJson(args)
        ? result
        : render(`Lattice baseline run (${result.schemaVersion})`, {
            baselineId: result.baselineId,
            runId: result.runId,
            outcome: result.outcome,
            authorityMode: result.authority.mode,
            falseDone: result.authority.mode === 'non-authority'
              ? result.authority.authorityDone || result.authority.receiptVerified || result.authority.multiHostVerified || result.authority.fullAuthorityDone
              : false,
          });
    },

    baseline_suite(args: {
      reportsRoot?: string;
      reportFiles?: string[] | string;
      outputDir?: string;
    } & JsonArgs = {}) {
      const reportFiles = splitFiles(args.reportFiles);
      const root = args.reportsRoot
        ? (args.reportsRoot.startsWith('/') ? args.reportsRoot : join(ctx.root, args.reportsRoot))
        : join(ctx.root, '.omx', 'artifacts', 'baseline');
      const files = reportFiles.length > 0
        ? reportFiles.map(file => file.startsWith('/') ? file : join(ctx.root, file))
        : collectBaselineReports(root);
      const reports = files.map(loadBaselineReport);
      const suite = aggregateBaselineReports(reports);
      const outputDir = args.outputDir
        ? (args.outputDir.startsWith('/') ? args.outputDir : join(ctx.root, args.outputDir))
        : join(root, 'suite');
      writeSuiteReport(outputDir, suite);
      return wantsJson(args)
        ? suite
        : render(`Lattice baseline suite (${suite.schemaVersion})`, {
            suiteStatus: suite.suiteStatus,
            validRunCount: suite.validRunCount,
            falseDoneCount: suite.falseDoneCount,
            overallCorrectnessProtectedSuccessRate: suite.overallCorrectnessProtectedSuccessRate,
            maturityStage: suite.maturityStage,
            outputDir,
          });
    },
  };
}
