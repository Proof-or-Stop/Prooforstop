import type { HandlerContext } from './context.js';
import {
  buildBaselineSuiteReport,
  evaluateFormalLayer2EngineeringClaim,
  evaluateCapabilityClaim,
  renderBaselineRunText,
  renderBaselineSuiteText,
  renderCapabilityClaimText,
  runBaseline,
  type BaselineLayer,
} from '../core/proof-or-stop-baseline.js';

type FormatArgs = { format?: 'text' | 'json'; json?: boolean };

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.format === 'json' || args?.json === true;
}

export function createProofOrStopBaselineHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const baselineSuiteReport = (args: {
    layer: BaselineLayer | string;
    artifactsRoot?: string;
  } & FormatArgs) => {
    const result = buildBaselineSuiteReport({
      root: ctx.root,
      layer: args.layer,
      artifactsRoot: args.artifactsRoot,
      format: args.format,
    });
    if (wantsJson(args)) return result;
    return renderBaselineSuiteText(result);
  };

  return {
    baseline_run(args: {
      baselineId: string;
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
    } & FormatArgs) {
      const result = runBaseline({
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
      if (wantsJson(args)) return result;
      return renderBaselineRunText(result);
    },
    baseline_suite(args: {
      layer: BaselineLayer | string;
      artifactsRoot?: string;
    } & FormatArgs) {
      return baselineSuiteReport(args);
    },
    baseline_suite_report: baselineSuiteReport,
    capability_claim_evaluate(args: {
      target?: string;
      claimId?: string;
      requestedClaim?: string;
      runId?: string;
      artifactsRoot?: string;
      output?: string;
      outputDir?: string;
      writeReport?: boolean;
    } & FormatArgs) {
      const result = evaluateCapabilityClaim({
        root: ctx.root,
        target: args.target,
        claimId: args.claimId,
        requestedClaim: args.requestedClaim,
        runId: args.runId,
        artifactsRoot: args.artifactsRoot,
        output: args.output,
        outputDir: args.outputDir,
        writeReport: args.writeReport,
      });
      if (wantsJson(args)) return result;
      return renderCapabilityClaimText(result);
    },
    capability_claim_formal_evaluate(args: {
      target?: string;
      claimId?: string;
      requestedClaim?: string;
      runId?: string;
      artifactsRoot?: string;
      output?: string;
      outputDir?: string;
      writeReport?: boolean;
    } & FormatArgs) {
      const result = evaluateFormalLayer2EngineeringClaim({
        root: ctx.root,
        target: args.target,
        claimId: args.claimId,
        requestedClaim: args.requestedClaim,
        runId: args.runId,
        artifactsRoot: args.artifactsRoot,
        output: args.output,
        outputDir: args.outputDir,
        writeReport: args.writeReport,
        formal: true,
      });
      if (wantsJson(args)) return result;
      return renderCapabilityClaimText(result);
    },
  };
}
