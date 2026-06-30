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
  proofstoryContract?: unknown;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function milestoneInventory(proofstoryContract: unknown): string[] {
  if (!isRecord(proofstoryContract)) return [];
  const bindings = Array.isArray(proofstoryContract.acceptanceBindings) ? proofstoryContract.acceptanceBindings : [];
  const ids: string[] = [];
  for (const binding of bindings) {
    if (!isRecord(binding) || !Array.isArray(binding.milestoneIds)) continue;
    for (const id of binding.milestoneIds) {
      if (typeof id === 'string' && id.trim().length > 0) ids.push(id.trim());
    }
  }
  return unique(ids);
}

function embeddedProofstoryContract(ledger: unknown): unknown {
  return isRecord(ledger) ? ledger.proofstoryContract : undefined;
}

function bindingProofstoryContract(args: ParentRoadmapEvalArgs, ledger: unknown, rollup: ReturnType<typeof evaluateParentRoadmapLedger>): unknown {
  if (args.proofstoryContract !== undefined) return args.proofstoryContract;
  if (milestoneInventory(embeddedProofstoryContract(ledger)).length > 0) return undefined;
  return { acceptanceBindings: [{ id: 'parent-roadmap-status', milestoneIds: rollup.rowResults.map((row) => row.rowId) }] };
}

function evaluate(args: ParentRoadmapEvalArgs) {
  const ledger = resolveLedger(args);
  const rollup = evaluateParentRoadmapLedger(ledger, {
    currentHeadHash: args.currentHeadHash,
    currentMaterialHash: args.currentMaterialHash,
    currentStoryFilesHash: args.currentStoryFilesHash,
    requiredRowIds: milestoneInventory(args.proofstoryContract),
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
      proofstoryContract: bindingProofstoryContract(args, ledger, rollup),
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
