import type { HandlerContext } from './context.js';
import {
  buildParentRoadmapSampleCase,
  evaluateParentRoadmapClaim,
  evaluateParentRoadmapLedger,
  evaluateParentRoadmapProofStoryBinding,
  renderParentRoadmapStatus,
} from '../core/parent-roadmap-totality.js';

type JsonFlag = { json?: boolean };
type ParentRoadmapMode = 'observe' | 'warn' | 'enforce';

interface ParentRoadmapEvalArgs extends JsonFlag {
  ledger?: unknown;
  case?: string;
  storyId?: string;
  summaryText?: string;
  mode?: ParentRoadmapMode;
  currentHeadHash?: string;
  currentMaterialHash?: string;
  currentStoryFilesHash?: string;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function resolveLedger(args: ParentRoadmapEvalArgs): unknown {
  if (args.ledger) return args.ledger;
  if (args.case) return buildParentRoadmapSampleCase(args.case);
  if (args.storyId) {
    if (args.storyId === 'B-43de') return buildParentRoadmapSampleCase('migration');
    throw new Error(`No parent roadmap ledger is registered for storyId ${args.storyId}. Pass a ledger or explicit case to evaluate parent-roadmap semantics.`);
  }
  return buildParentRoadmapSampleCase('migration');
}

function evaluate(args: ParentRoadmapEvalArgs) {
  const ledger = resolveLedger(args);
  const rollup = evaluateParentRoadmapLedger(ledger, {
    currentHeadHash: args.currentHeadHash,
    currentMaterialHash: args.currentMaterialHash,
    currentStoryFilesHash: args.currentStoryFilesHash,
  });
  const claim = args.summaryText
    ? evaluateParentRoadmapClaim({ rollup, summaryText: args.summaryText, mode: args.mode })
    : undefined;
  const proofstoryBinding = args.summaryText
    ? evaluateParentRoadmapProofStoryBinding({
      ledger,
      rollup,
      originalIntentSnapshot: {
        requestHash: 'sha256:parent-roadmap-status',
        sourceText: 'Parent-roadmap status CLI binds summary wording to row-totality rollup.',
      },
      proofstoryContract: { acceptanceBindings: [{ id: 'parent-roadmap-status', milestoneIds: rollup.rowResults.map((row) => row.rowId) }] },
      summaryText: args.summaryText,
      mode: args.mode,
    })
    : undefined;
  return { ledger, rollup, claim, proofstoryBinding };
}

function enforceNoBlockingResult(result: ReturnType<typeof evaluate>): void {
  const reasons = [
    ...(result.claim?.blocking ? result.claim.reasons : []),
    ...(result.proofstoryBinding?.blocking ? result.proofstoryBinding.gaps.map((gap) => `${gap.code}: ${gap.message}`) : []),
  ];
  if (reasons.length === 0) return;
  throw new Error(`parent-roadmap enforce failed: ${reasons.join(' ')}`);
}

export function createParentRoadmapHandlers(_ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    parent_roadmap_status(args: ParentRoadmapEvalArgs): string {
      const result = evaluate(args);
      enforceNoBlockingResult(result);
      if (args.json) return stringify(result);
      return renderParentRoadmapStatus(result.rollup, result.claim);
    },

    parent_roadmap_evaluate(args: ParentRoadmapEvalArgs): string {
      if (!args.ledger && !args.case && !args.storyId) {
        throw new Error('parent_roadmap_evaluate requires ledger, case, or storyId');
      }
      const result = evaluate(args);
      enforceNoBlockingResult(result);
      if (args.json) return stringify(result);
      return renderParentRoadmapStatus(result.rollup, result.claim);
    },
  };
}
