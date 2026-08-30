import { join } from 'node:path';
import type { HandlerContext } from './context.js';
import {
  BASELINE_IDS,
  aggregateBaselineReports,
  collectBaselineReports,
  loadBaselineReport,
  runBaseline as runScenarioBaseline,
  writeSuiteReport,
  type BaselineAuthorityMode,
  type BaselineExpectedOutcome,
  type BaselineId,
} from '../core/baseline.js';
import { PROOF_OR_STOP_DIR } from '../core/proof-or-stop-paths.js';
import {
  buildBaselineSuiteReport as buildLegacyBaselineSuiteReport,
  renderBaselineRunText as renderLegacyBaselineRunText,
  renderBaselineSuiteText as renderLegacyBaselineSuiteText,
  runBaseline as runLegacyBaseline,
  type BaselineLayer,
} from '../core/proof-or-stop-baseline.js';

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
      baselineId: BaselineId | string;
      runId?: string;
      artifactsRoot?: string;
      formal?: boolean;
      suiteRunId?: string;
      claimTarget?: string;
      outcome?: 'PASS' | 'FAIL' | 'EXPECTED_BLOCK' | 'ESCALATED';
      verifiedAt?: string;
      verificationEvidenceRefs?: string[] | string;
      reviewEvidenceRefs?: string[] | string;
      lifecycleGateEvidenceRefs?: string[] | string;
      gateEvidenceRefs?: string[] | string;
      receiptRefs?: string[] | string;
      plannedStepRefs?: string[] | string;
      reviewLoopRefs?: string[] | string;
      hostVerdictRefs?: string[] | string;
      budgetReportRef?: string;
      stopConditionRefs?: string[] | string;
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
      localReviewEvidenceRefs?: string[] | string;
      requiredIndependentHosts?: number;
      independentHosts?: number;
      passingIndependentHosts?: number;
      authorityServerContact?: boolean;
      retryCount?: number;
      repairCount?: number;
      blockedReason?: string;
    } & JsonArgs) {
      if (!(BASELINE_IDS as readonly string[]).includes(args.baselineId)) {
        const legacy = runLegacyBaseline({
          root: ctx.root,
          baselineId: args.baselineId,
          runId: args.runId,
          artifactsRoot: args.artifactsRoot,
          format: args.format,
          formal: args.formal,
          suiteRunId: args.suiteRunId,
          claimTarget: args.claimTarget,
          outcome: args.outcome,
          verifiedAt: args.verifiedAt,
          verificationEvidenceRefs: args.verificationEvidenceRefs,
          reviewEvidenceRefs: args.reviewEvidenceRefs,
          lifecycleGateEvidenceRefs: args.lifecycleGateEvidenceRefs,
          gateEvidenceRefs: args.gateEvidenceRefs,
          receiptRefs: args.receiptRefs,
          plannedStepRefs: args.plannedStepRefs,
          reviewLoopRefs: args.reviewLoopRefs,
          hostVerdictRefs: args.hostVerdictRefs,
          budgetReportRef: args.budgetReportRef,
          stopConditionRefs: args.stopConditionRefs,
        });
        return wantsJson(args) ? legacy : renderLegacyBaselineRunText(legacy);
      }
      const result = runScenarioBaseline(ctx.root, {
        ...args,
        baselineId: args.baselineId as BaselineId,
        localReviewEvidenceRefs: splitFiles(args.localReviewEvidenceRefs),
      });
      return wantsJson(args)
        ? result
        : render(`Proof-or-Stop baseline run (${result.schemaVersion})`, {
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
      layer?: BaselineLayer | string;
      artifactsRoot?: string;
      reportsRoot?: string;
      reportFiles?: string[] | string;
      outputDir?: string;
    } & JsonArgs = {}) {
      if (args.layer) {
        const legacy = buildLegacyBaselineSuiteReport({
          root: ctx.root,
          layer: args.layer,
          artifactsRoot: args.artifactsRoot,
          format: args.format,
        });
        return wantsJson(args) ? legacy : renderLegacyBaselineSuiteText(legacy);
      }
      const reportFiles = splitFiles(args.reportFiles);
      const root = args.reportsRoot
        ? (args.reportsRoot.startsWith('/') ? args.reportsRoot : join(ctx.root, args.reportsRoot))
        : join(ctx.root, PROOF_OR_STOP_DIR, 'artifacts', 'baseline');
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
        : render(`Proof-or-Stop baseline suite (${suite.schemaVersion})`, {
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
