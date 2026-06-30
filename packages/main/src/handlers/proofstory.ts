/**
 * ProofStory handlers.
 *
 * These commands persist story-scoped intent-hardening artifacts and expose
 * observe/warn/enforce diagnostics. Enforcement is opt-in by command mode or
 * project policy; this file does not create a parallel lifecycle machine.
 */

import type { HandlerContext } from './context.js';
import type { ChecklistData, ProofStoryGateMode } from '../core/types.js';
import {
  addMilestoneToLedger,
  appendRedEvidence,
  buildIntentCollision,
  buildMilestoneLedger,
  buildOriginalIntentSnapshot,
  buildParentLedgerRollup,
  buildProofStoryContract,
  buildScopeShrinkageDecision,
  buildSlicePlan,
  confirmMilestoneLedger,
  evaluateDoneIntentEquivalence,
  evaluateProofStoryDiagnostics,
  evaluateReviewCompleteness,
  renderProofStoryDiagnosticReport,
  setSpikeResult,
  setSpikeStatus,
  startSpike,
  type ProofStoryDiagnosticInput,
} from '../core/proofstory.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';

type JsonFlag = { json?: boolean };
type ModeFlag = { mode?: ProofStoryGateMode; dryRun?: boolean };

function emptyChecklist(): ChecklistData {
  return { items: [] };
}

function stringify(data: unknown, pretty = true): string {
  return JSON.stringify(data, null, pretty ? 2 : 0);
}

function renderStored(kind: string, data: unknown, args: JsonFlag): string {
  if (args.json) return stringify(data);
  return `${kind}: configured\n${stringify(data)}`;
}

function resolveMode(args: ModeFlag): ProofStoryGateMode {
  return args.mode ?? 'observe';
}

function enforceOrRender(report: { blocking: boolean; mode: ProofStoryGateMode }, text: string): string {
  if (report.mode === 'enforce' && report.blocking) {
    throw new Error(text);
  }
  return text;
}

export function createProofStoryHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store } = ctx;

  function readChecklistSafe(storyId: string): ChecklistData {
    try {
      return store.readChecklist(storyId);
    } catch {
      return emptyChecklist();
    }
  }

  function diagnosticInput(storyId: string): ProofStoryDiagnosticInput {
    const story = store.readStory(storyId);
    const checklist = readChecklistSafe(storyId);
    return {
      story,
      checklist,
      originalIntentSnapshot: store.readOriginalIntentSnapshot(storyId),
      milestoneLedger: store.readMilestoneLedger(storyId),
      slicePlan: store.readProofStorySlicePlan(storyId),
      parentLedgerRollup: store.readProofStoryParentLedgerRollup(storyId),
      proofStoryContract: store.readProofStoryContract(storyId),
      intentCollision: store.readIntentCollision(storyId),
      scopeContract: store.readScopeContract(storyId),
      scopeShrinkageDecision: store.readScopeShrinkageDecision(storyId),
      redEvidence: store.readRedEvidence(storyId),
      spikeEvidence: store.readProofStorySpikes(storyId),
      summary: store.readSummary(storyId),
    };
  }

  function renderGateReport(storyId: string, args: JsonFlag & ModeFlag): string {
    const report = evaluateProofStoryDiagnostics(diagnosticInput(storyId), resolveMode(args));
    if (args.json) return enforceOrRender(report, stringify(report));
    return enforceOrRender(report, renderProofStoryDiagnosticReport(report));
  }

  return {
    original_intent_snapshot_set(args: {
      storyId: string;
      sourceText: string;
      normalizedOutcome: string;
      acceptanceClaim: string;
      keyRequirementIds?: string[];
      json?: boolean;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const existing = store.readOriginalIntentSnapshot(args.storyId);
      const snapshot = buildOriginalIntentSnapshot(args, existing);
      store.writeOriginalIntentSnapshot(args.storyId, snapshot);
      if (args.json) return stringify(snapshot);
      return [
        'Original intent snapshot: configured',
        `Story: ${snapshot.storyId}`,
        `Request hash: ${snapshot.requestHash}`,
        `Key requirement ids: [${snapshot.keyRequirementIds.join(', ')}]`,
      ].join('\n');
    },

    original_intent_snapshot_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const snapshot = store.readOriginalIntentSnapshot(args.storyId);
      if (!snapshot) {
        const result = {
          storyId: args.storyId,
          status: 'not_configured',
          message: 'No original intent snapshot. Run original_intent_snapshot_set.',
        };
        return args.json ? stringify(result) : `Original intent snapshot: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('Original intent snapshot', snapshot, args);
    },

    milestone_ledger_set(args: { storyId: string; milestones: unknown[]; state?: 'candidate' | 'confirmed'; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const existing = store.readMilestoneLedger(args.storyId);
      const ledger = buildMilestoneLedger({
        storyId: args.storyId,
        milestones: args.milestones ?? [],
        existing,
        state: args.state,
      });
      store.writeMilestoneLedger(args.storyId, ledger);
      if (args.json) return stringify(ledger);
      return [
        'Milestone ledger: configured',
        `Story: ${ledger.storyId}`,
        `State: ${ledger.state ?? 'candidate'}`,
        `Ledger hash: ${ledger.ledgerHash}`,
        `Milestones: ${ledger.milestones.length}`,
        ...ledger.milestones.map((milestone) => `  - ${milestone.id}: ${milestone.claim}`),
      ].join('\n');
    },

    milestone_ledger_add(args: {
      storyId: string;
      milestone?: unknown;
      id?: string;
      sourceRequirementId?: string;
      claim?: string;
      doneMeans?: string;
      requiredEvidence?: string[];
      checklistRefs?: string[];
      verificationIntentRefs?: string[];
      parentLedgerId?: string;
      assignedStory?: string;
      status?: string;
      json?: boolean;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const existing = store.readMilestoneLedger(args.storyId);
      const rawMilestone = args.milestone ?? {
        id: args.id,
        sourceRequirementId: args.sourceRequirementId,
        claim: args.claim,
        doneMeans: args.doneMeans,
        requiredEvidence: args.requiredEvidence,
        checklistRefs: args.checklistRefs,
        verificationIntentRefs: args.verificationIntentRefs,
        parentLedgerId: args.parentLedgerId,
        assignedStory: args.assignedStory,
        status: args.status,
      };
      const ledger = addMilestoneToLedger(args.storyId, rawMilestone, existing);
      store.writeMilestoneLedger(args.storyId, ledger);
      if (args.json) return stringify(ledger);
      return `Milestone ledger: added ${ledger.milestones.at(-1)?.id ?? '(unknown)'}\nState: ${ledger.state ?? 'candidate'}\nMilestones: ${ledger.milestones.length}`;
    },

    milestone_ledger_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const ledger = store.readMilestoneLedger(args.storyId);
      if (!ledger) {
        const result = {
          storyId: args.storyId,
          status: 'not_configured',
          message: 'No milestone ledger. It is optional unless structural/semantic milestone triggers exist or milestones are provided.',
        };
        return args.json ? stringify(result) : `Milestone ledger: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('Milestone ledger', ledger, args);
    },

    slice_plan_set(args: { storyId: string; slices: unknown[]; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const plan = buildSlicePlan({
        storyId: args.storyId,
        ledger: store.readMilestoneLedger(args.storyId),
        slices: args.slices ?? [],
        existing: store.readProofStorySlicePlan(args.storyId),
      });
      store.writeProofStorySlicePlan(args.storyId, plan);
      if (args.json) return stringify(plan);
      return [
        'Slice plan: configured',
        `Story: ${plan.storyId}`,
        `Ledger hash: ${plan.ledgerHash}`,
        `Plan hash: ${plan.planHash}`,
        `Slices: ${plan.slices.length}`,
        ...plan.slices.map((slice) => `  - ${slice.id}: ${slice.milestoneIds.join(', ')}${slice.assignedStory ? ` -> ${slice.assignedStory}` : ''}`),
        'No child stories were created automatically.',
      ].join('\n');
    },

    slice_plan_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const plan = store.readProofStorySlicePlan(args.storyId);
      if (!plan) {
        const result = {
          storyId: args.storyId,
          status: 'not_configured',
          message: 'No slice plan. It is optional unless the milestone ledger exceeds the single-story threshold.',
        };
        return args.json ? stringify(result) : `Slice plan: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('Slice plan', plan, args);
    },

    parent_ledger_rollup_set(args: { storyId: string; children: unknown[]; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const rollup = buildParentLedgerRollup({
        storyId: args.storyId,
        ledger: store.readMilestoneLedger(args.storyId),
        slicePlan: store.readProofStorySlicePlan(args.storyId),
        children: args.children ?? [],
        existing: store.readProofStoryParentLedgerRollup(args.storyId),
      });
      store.writeProofStoryParentLedgerRollup(args.storyId, rollup);
      if (args.json) return stringify(rollup);
      return [
        'Parent ledger roll-up: configured',
        `Story: ${rollup.storyId}`,
        `Ledger hash: ${rollup.ledgerHash}`,
        `Slice plan hash: ${rollup.slicePlanHash ?? 'none'}`,
        `Children: ${rollup.children.length}`,
        ...rollup.children.map((child) => `  - ${child.storyId} [${child.status}]: ${child.milestoneIds.join(', ')}`),
      ].join('\n');
    },

    parent_ledger_rollup_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const rollup = store.readProofStoryParentLedgerRollup(args.storyId);
      if (!rollup) {
        const result = {
          storyId: args.storyId,
          status: 'not_configured',
          message: 'No parent ledger roll-up. It is optional unless a slice plan exists and DONE equivalence needs child coverage.',
        };
        return args.json ? stringify(result) : `Parent ledger roll-up: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('Parent ledger roll-up', rollup, args);
    },

    intent_collision_set(args: {
      storyId: string;
      decision: 'pass' | 'revise_intent' | 'human_gate' | 'stop';
      acceptedInterpretation?: string;
      notes?: string;
      id?: string;
      json?: boolean;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const existing = store.readIntentCollision(args.storyId);
      const ledger = store.readMilestoneLedger(args.storyId);
      const collision = buildIntentCollision(args, existing, ledger);
      store.writeIntentCollision(args.storyId, collision);
      const confirmed = confirmMilestoneLedger(args.storyId, ledger, collision);
      if (confirmed && confirmed !== ledger) store.writeMilestoneLedger(args.storyId, confirmed);
      const result = { collision, confirmedLedger: confirmed?.state === 'confirmed' ? confirmed : null };
      if (args.json) return stringify(result);
      return [
        'Intent collision: configured',
        `Story: ${collision.storyId}`,
        `Decision: ${collision.decision}`,
        `Status: ${collision.status}`,
        confirmed?.state === 'confirmed' ? `Confirmed ledger hash: ${confirmed.ledgerHash}` : 'Confirmed ledger hash: none',
      ].join('\n');
    },

    intent_collision_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const collision = store.readIntentCollision(args.storyId);
      if (!collision) {
        const result = {
          storyId: args.storyId,
          status: 'not_configured',
          message: 'No intent collision artifact. Run intent_collision_set.',
        };
        return args.json ? stringify(result) : `Intent collision: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('Intent collision', collision, args);
    },

    proofstory_contract_set(args: {
      storyId: string;
      acceptanceBindings?: unknown[];
      note?: string;
      json?: boolean;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const state = diagnosticInput(args.storyId);
      const existing = store.readProofStoryContract(args.storyId);
      const contract = buildProofStoryContract(
        { storyId: args.storyId, acceptanceBindings: args.acceptanceBindings, note: args.note },
        {
          story: state.story,
          checklist: state.checklist,
          originalIntentSnapshot: state.originalIntentSnapshot,
          milestoneLedger: state.milestoneLedger,
          slicePlan: state.slicePlan,
          parentLedgerRollup: state.parentLedgerRollup,
          intentCollision: state.intentCollision,
          scopeContract: state.scopeContract,
          scopeShrinkageDecision: state.scopeShrinkageDecision,
          redEvidence: state.redEvidence,
          spikeEvidence: state.spikeEvidence,
          summary: state.summary,
        },
        existing,
      );
      store.writeProofStoryContract(args.storyId, contract);
      if (args.json) return stringify(contract);
      return [
        'ProofStory contract: configured',
        `Story: ${contract.storyId}`,
        `Hardening level: ${contract.hardeningLevel}`,
        `Acceptance bindings: ${contract.acceptanceBindings.length}`,
        `Diagnostic gaps: ${contract.diagnosticGaps.length}`,
      ].join('\n');
    },

    proofstory_contract_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const contract = store.readProofStoryContract(args.storyId);
      if (!contract) {
        const result = {
          storyId: args.storyId,
          status: 'not_configured',
          message: 'No ProofStory contract. Run proofstory_contract_set.',
        };
        return args.json ? stringify(result) : `ProofStory contract: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('ProofStory contract', contract, args);
    },

    scope_shrinkage_decision_set(args: {
      storyId: string;
      decision: 'confirmed' | 'rejected';
      userConfirmed?: boolean;
      removedMilestoneIds?: string[];
      reason: string;
      approvedBy: string;
      json?: boolean;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const decision = buildScopeShrinkageDecision(args, store.readScopeShrinkageDecision(args.storyId));
      store.writeScopeShrinkageDecision(args.storyId, decision);
      if (args.json) return stringify(decision);
      return [
        `Scope shrinkage decision: ${decision.decision}`,
        `User confirmed: ${decision.userConfirmed ? 'yes' : 'no'}`,
        `Removed milestones: ${decision.removedMilestoneIds.join(', ') || 'none'}`,
      ].join('\n');
    },

    scope_shrinkage_decision_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const decision = store.readScopeShrinkageDecision(args.storyId);
      if (!decision) {
        const result = { storyId: args.storyId, status: 'not_configured', message: 'No scope shrinkage decision.' };
        return args.json ? stringify(result) : `Scope shrinkage decision: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('Scope shrinkage decision', decision, args);
    },

    red_evidence_create(args: {
      storyId: string;
      trigger: string;
      acceptanceTargetRef?: string;
      baselineHeadHash?: string;
      baselineMaterialHash?: string;
      observedFailure: string;
      failingCommand?: string;
      failureReceiptHash?: string;
      expectedGreenCommand?: string;
      greenTargetRef?: string;
      greenRelation?: 'same_acceptance' | 'regression_to_green' | 'replacement';
      greenHeadHash?: string;
      greenMaterialHash?: string;
      note?: string;
      id?: string;
      json?: boolean;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const baselineHeadHash = args.baselineHeadHash ?? currentGitHead(ctx.root);
      const baselineMaterialHash = args.baselineMaterialHash ?? currentMaterialHash(ctx.root, 'HEAD', ctx.root);
      const evidence = appendRedEvidence({
        ...args,
        baselineHeadHash,
        baselineMaterialHash,
      }, store.readRedEvidence(args.storyId));
      store.writeRedEvidence(args.storyId, evidence);
      if (args.json) return stringify(evidence);
      const latest = evidence.records.at(-1);
      return [
        'Red evidence: recorded',
        `Records: ${evidence.records.length}`,
        `Target: ${latest?.acceptanceTargetRef ?? 'unknown'}`,
        `Baseline head: ${latest?.baselineHeadHash ?? 'unknown'}`,
        `Baseline material: ${latest?.baselineMaterialHash ?? 'unknown'}`,
      ].join('\n');
    },

    red_evidence_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const evidence = store.readRedEvidence(args.storyId);
      if (!evidence) {
        const result = { storyId: args.storyId, status: 'not_configured', message: 'No red evidence.' };
        return args.json ? stringify(result) : `Red evidence: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('Red evidence', evidence, args);
    },

    spike_start(args: { storyId: string; id?: string; question: string; disposableCodePaths?: string[]; note?: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const spikes = startSpike(args, store.readProofStorySpikes(args.storyId));
      store.writeProofStorySpikes(args.storyId, spikes);
      if (args.json) return stringify(spikes);
      return `Spike: started ${spikes.spikes.at(-1)?.id ?? '(unknown)'}\nActive spikes: ${spikes.spikes.filter(s => s.status === 'active').length}`;
    },

    spike_result_set(args: { storyId: string; id: string; result: string; note?: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const spikes = setSpikeResult(args, store.readProofStorySpikes(args.storyId));
      store.writeProofStorySpikes(args.storyId, spikes);
      if (args.json) return stringify(spikes);
      return `Spike: resolved ${args.id}`;
    },

    spike_result(args: { storyId: string; id: string; result: string; note?: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const spikes = setSpikeResult(args, store.readProofStorySpikes(args.storyId));
      store.writeProofStorySpikes(args.storyId, spikes);
      if (args.json) return stringify(spikes);
      return `Spike: resolved ${args.id}`;
    },

    spike_discard(args: { storyId: string; id: string; note?: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const spikes = setSpikeStatus(args, store.readProofStorySpikes(args.storyId), 'discarded');
      store.writeProofStorySpikes(args.storyId, spikes);
      if (args.json) return stringify(spikes);
      return `Spike: discarded ${args.id}`;
    },

    spike_promote(args: { storyId: string; id: string; promotedAs?: 'red_evidence' | 'verification_evidence' | 'scope_decision' | 'implementation_note'; note?: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const spikes = setSpikeStatus(args, store.readProofStorySpikes(args.storyId), 'promoted');
      store.writeProofStorySpikes(args.storyId, spikes);
      if (args.json) return stringify(spikes);
      return `Spike: promoted ${args.id}\nPromotion is audit metadata only; create red or verification evidence separately.`;
    },

    spike_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const spikes = store.readProofStorySpikes(args.storyId);
      if (!spikes) {
        const result = { storyId: args.storyId, status: 'not_configured', message: 'No spike evidence.' };
        return args.json ? stringify(result) : `Spike evidence: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('Spike evidence', spikes, args);
    },

    intent_coverage_check(args: { storyId: string; dryRun?: boolean; mode?: ProofStoryGateMode; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const report = evaluateProofStoryDiagnostics(diagnosticInput(args.storyId), resolveMode(args));
      const coverageGaps = [
        ...report.missingMvpArtifacts,
        ...report.missingMilestoneCoverage,
        ...report.missingConfirmedLedger,
        ...report.missingAcceptanceBindings,
      ];
      const coverageBlocking = report.mode === 'enforce' && coverageGaps.length > 0;
      const coverageStatus: 'pass' | 'warn' | 'fail' = coverageBlocking ? 'fail' : coverageGaps.length > 0 ? 'warn' : 'pass';
      const coverageReport = {
        ...report,
        status: coverageStatus,
        blocking: coverageBlocking,
        gaps: coverageGaps,
        wouldBlockFutureDevAdmission: coverageGaps.length > 0,
      };
      if (args.json) return enforceOrRender(coverageReport, stringify(coverageReport));
      return enforceOrRender(coverageReport, renderProofStoryDiagnosticReport(coverageReport));
    },

    proofstory_gate_check(args: { storyId: string; dryRun?: boolean; mode?: ProofStoryGateMode; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      return renderGateReport(args.storyId, args);
    },

    done_intent_equivalence_check(args: { storyId: string; mode?: ProofStoryGateMode; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const report = evaluateDoneIntentEquivalence(diagnosticInput(args.storyId), resolveMode(args));
      if (args.json) return enforceOrRender(report, stringify(report));
      return enforceOrRender(
        report,
        [
          `DONE intent equivalence for ${report.storyId}`,
          `Mode: ${report.mode}`,
          `Equivalence mode: ${report.equivalenceMode}`,
          `Status: ${report.status}`,
          `Blocking: ${report.blocking ? 'yes' : 'no'}`,
          `Uncovered required milestones: ${report.uncoveredRequiredMilestoneIds.join(', ') || 'none'}`,
          `Accepted shrinkage milestones: ${report.acceptedShrinkageMilestoneIds.join(', ') || 'none'}`,
          `Gaps: ${report.gaps.length}`,
          ...report.gaps.map((gap) => `  - ${gap.code}: ${gap.message}`),
        ].join('\n'),
      );
    },

    proofstory_review_completeness_check(args: { storyId: string; mode?: ProofStoryGateMode; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const report = evaluateReviewCompleteness(diagnosticInput(args.storyId), resolveMode(args));
      if (args.json) return enforceOrRender(report, stringify(report));
      return enforceOrRender(
        report,
        [
          `ProofStory REVIEW completeness for ${report.storyId}`,
          `Mode: ${report.mode}`,
          `Status: ${report.status}`,
          `Blocking: ${report.blocking ? 'yes' : 'no'}`,
          `Gaps: ${report.gaps.length}`,
          ...report.gaps.map((gap) => `  - ${gap.code}: ${gap.message}`),
        ].join('\n'),
      );
    },
  };
}
