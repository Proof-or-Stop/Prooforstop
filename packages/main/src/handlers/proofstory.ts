/**
 * ProofStory handlers — M0-M2 progressive intent hardening diagnostics.
 *
 * These handlers persist the MVP artifacts and expose dry-run diagnostics only.
 * They are not wired into story_advance or lifecycle gates.
 */

import { existsSync } from 'node:fs';
import type { HandlerContext } from './context.js';
import type { ChecklistData } from '../core/types.js';
import {
  addMilestoneToLedger,
  buildMilestoneLedger,
  buildOriginalIntentSnapshot,
  buildProofStoryContract,
  evaluateProofStoryDiagnostics,
  renderProofStoryDiagnosticReport,
  type ProofStoryDiagnosticInput,
} from '../core/proofstory.js';

type JsonFlag = { json?: boolean };

function emptyChecklist(): ChecklistData {
  return { items: [] };
}

function requireDryRun(commandName: string, dryRun?: boolean): void {
  if (dryRun !== true) {
    throw new Error(`${commandName} is diagnostic-only in M0-M2; pass dryRun:true`);
  }
}

function stringify(data: unknown, pretty = true): string {
  return JSON.stringify(data, null, pretty ? 2 : 0);
}

function renderStored(kind: string, data: unknown, args: JsonFlag): string {
  if (args.json) return stringify(data);
  return `${kind}: configured\n${stringify(data)}`;
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
    const originalIntentSnapshot = store.readOriginalIntentSnapshot(storyId);
    const milestoneLedger = store.readMilestoneLedger(storyId);
    const proofStoryContract = store.readProofStoryContract(storyId);
    const intentCollision = store.readIntentCollision(storyId);
    const scopeContract = store.readScopeContract(storyId);
    return {
      story,
      checklist,
      originalIntentSnapshot,
      milestoneLedger,
      proofStoryContract,
      intentCollision,
      scopeContract,
      redEvidencePresent: existsSync(store.storyFilePath(storyId, 'red-evidence.json')),
      spikeEvidencePresent: existsSync(store.storyFilePath(storyId, 'spike.json')),
    };
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

    milestone_ledger_set(args: { storyId: string; milestones: unknown[]; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const existing = store.readMilestoneLedger(args.storyId);
      const ledger = buildMilestoneLedger({ storyId: args.storyId, milestones: args.milestones ?? [], existing });
      store.writeMilestoneLedger(args.storyId, ledger);
      if (args.json) return stringify(ledger);
      return [
        'Milestone ledger: configured',
        `Story: ${ledger.storyId}`,
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
        status: args.status,
      };
      const ledger = addMilestoneToLedger(args.storyId, rawMilestone, existing);
      store.writeMilestoneLedger(args.storyId, ledger);
      if (args.json) return stringify(ledger);
      return `Milestone ledger: added ${ledger.milestones.at(-1)?.id ?? '(unknown)'}\nMilestones: ${ledger.milestones.length}`;
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
          intentCollision: state.intentCollision,
          scopeContract: state.scopeContract,
          redEvidencePresent: state.redEvidencePresent,
          spikeEvidencePresent: state.spikeEvidencePresent,
        },
        existing,
      );
      store.writeProofStoryContract(args.storyId, contract);
      if (args.json) return stringify(contract);
      return [
        'ProofStory contract: configured',
        'Mode: diagnostic-only',
        `Story: ${contract.storyId}`,
        `Hardening level: ${contract.hardeningLevel}`,
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
          message: 'No ProofStory diagnostic envelope. Run proofstory_contract_set to persist one.',
        };
        return args.json ? stringify(result) : `ProofStory contract: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('ProofStory contract', contract, args);
    },

    intent_collision_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const collision = store.readIntentCollision(args.storyId);
      if (!collision) {
        const result = {
          storyId: args.storyId,
          status: 'not_configured',
          diagnosticOnly: true,
          message: 'No intent collision artifact. M0-M2 implements read-only diagnostics only; intent_collision_set is intentionally not available.',
        };
        return args.json ? stringify(result) : `Intent collision: not configured\nStory: ${args.storyId}\nM0-M2 read-only diagnostic only.`;
      }
      return renderStored('Intent collision', collision, args);
    },

    intent_coverage_check(args: { storyId: string; dryRun?: boolean; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      requireDryRun('intent_coverage_check', args.dryRun);
      const report = evaluateProofStoryDiagnostics(diagnosticInput(args.storyId));
      const coverageReport = {
        ...report,
        gaps: [
          ...report.missingMvpArtifacts,
          ...report.missingMilestoneCoverage,
          ...report.missingAcceptanceBindings,
        ],
        wouldBlockFutureDevAdmission: [
          ...report.missingMvpArtifacts,
          ...report.missingMilestoneCoverage,
          ...report.missingAcceptanceBindings,
        ].length > 0,
      };
      if (args.json) return stringify(coverageReport);
      return renderProofStoryDiagnosticReport(coverageReport);
    },

    proofstory_gate_check(args: { storyId: string; dryRun?: boolean; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      requireDryRun('proofstory_gate_check', args.dryRun);
      const report = evaluateProofStoryDiagnostics(diagnosticInput(args.storyId));
      if (args.json) return stringify(report);
      return renderProofStoryDiagnosticReport(report);
    },
  };
}
