/**
 * Scope Contract handlers — koala scope_contract_set / show / check / acknowledge
 *
 * scope_contract_set       — create or update the contract for a story
 * scope_contract_show      — display the current contract
 * scope_contract_check     — run the post-diff scope gate and return status
 * scope_contract_acknowledge — record an explicit out-of-scope change with reason
 */

import type { HandlerContext } from './context.js';
import type { ScopeContractData, ScopeContractAcknowledgement, ScopeContractMode } from '../core/types.js';
import {
  validateMode,
  validatePaths,
  buildScopeContract,
  checkScopeContract,
  renderScopeCheckResult,
  readChangedFiles,
} from '../core/scope-contract.js';

export function createScopeContractHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;

  return {
    scope_contract_set(args: {
      storyId: string;
      mode: string;
      allowedModify?: string[];
      allowedCreate?: string[];
      allowedTest?: string[];
      protectedFiles?: string[];
      explicitExcludes?: string[];
      scopeChangeReason?: string;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      // ensure story exists
      store.readStory(args.storyId);

      const mode = validateMode(args.mode);
      const allowedModify = validatePaths(args.allowedModify ?? [], 'allowedModify');
      const allowedCreate = validatePaths(args.allowedCreate ?? [], 'allowedCreate');
      const allowedTest = validatePaths(args.allowedTest ?? [], 'allowedTest');
      const protectedFiles = validatePaths(args.protectedFiles ?? [], 'protectedFiles');
      const explicitExcludes = validatePaths(args.explicitExcludes ?? [], 'explicitExcludes');

      const existing = store.readScopeContract(args.storyId);
      const contract = buildScopeContract(
        args.storyId,
        { mode, allowedModify, allowedCreate, allowedTest, protectedFiles, explicitExcludes, scopeChangeReason: args.scopeChangeReason },
        existing ?? undefined,
      );
      store.writeScopeContract(args.storyId, contract);
      return `Scope contract: configured\nStory: ${args.storyId}\nMode: ${mode}\nallowedModify: [${allowedModify.join(', ')}]\nallowedCreate: [${allowedCreate.join(', ')}]\nallowedTest: [${allowedTest.join(', ')}]\nprotectedFiles: [${protectedFiles.join(', ')}]\nexplicitExcludes: [${explicitExcludes.join(', ')}]`;
    },

    scope_contract_show(args: { storyId: string }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const contract = store.readScopeContract(args.storyId);
      if (!contract) {
        return `Scope contract: not configured\nStory ${args.storyId} has no scope contract. Use scope_contract_set to create one.`;
      }
      const acks = contract.acknowledgements;
      const ackSummary = acks.length === 0
        ? 'none'
        : acks.map(a => `${a.paths.join(',')} (${a.actor} @ ${a.timestamp})`).join('; ');
      return [
        `Scope contract: configured`,
        `Story: ${contract.storyId}`,
        `Mode: ${contract.mode}`,
        `allowedModify: [${contract.allowedModify.join(', ')}]`,
        `allowedCreate: [${contract.allowedCreate.join(', ')}]`,
        `allowedTest: [${contract.allowedTest.join(', ')}]`,
        `protectedFiles: [${contract.protectedFiles.join(', ')}]`,
        `explicitExcludes: [${contract.explicitExcludes.join(', ')}]`,
        `scopeChangeReason: ${contract.scopeChangeReason ?? '(none)'}`,
        `acknowledgements: ${ackSummary}`,
        `createdAt: ${contract.createdAt}`,
        `updatedAt: ${contract.updatedAt}`,
      ].join('\n');
    },

    scope_contract_check(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const contract = store.readScopeContract(args.storyId);
      if (!contract) {
        const result = { status: 'skip', summary: 'Scope gate: skip (no contract configured)', mode: null, changedFiles: [], violations: [], warnings: [], acknowledgedPaths: [] };
        if (args.json) return JSON.stringify(result, null, 2);
        return result.summary;
      }
      const changedFiles = readChangedFiles(root);
      const result = checkScopeContract(contract, changedFiles);
      if (args.json) return JSON.stringify(result, null, 2);
      return renderScopeCheckResult(result);
    },

    scope_contract_acknowledge(args: {
      storyId: string;
      paths: string[];
      reason: string;
      actor?: string;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const paths = validatePaths(args.paths, 'paths');
      if (paths.length === 0) throw new Error('paths must be a non-empty array');
      const reason = (args.reason ?? '').trim();
      if (reason.length < 20) {
        throw new Error(`reason must be at least 20 characters (got ${reason.length})`);
      }
      const actor = (args.actor ?? 'main-agent').trim();

      const contract = store.readScopeContract(args.storyId);
      if (!contract) {
        throw new Error(`Story ${args.storyId} has no scope contract. Run scope_contract_set first.`);
      }

      const ack: ScopeContractAcknowledgement = {
        actor,
        reason,
        timestamp: new Date().toISOString(),
        paths,
      };

      const updated: ScopeContractData = {
        ...contract,
        acknowledgements: [...contract.acknowledgements, ack],
        updatedAt: new Date().toISOString(),
      };
      store.writeScopeContract(args.storyId, updated);

      return [
        `Scope change acknowledged`,
        `Story: ${args.storyId}`,
        `actor: ${actor}`,
        `reason: ${reason}`,
        `addedPaths: [${paths.join(', ')}]`,
        `timestamp: ${ack.timestamp}`,
        `Total acknowledgements: ${updated.acknowledgements.length}`,
      ].join('\n');
    },
  };
}

/**
 * Run the scope gate for a story and return the check result.
 * Returns null (skip) when no contract is configured — backward compatible.
 */
export function runScopeGate(
  storyId: string,
  store: import('../core/store.js').StoryStore,
  projectRoot: string,
  gitReader?: (root: string) => string[],
): import('../core/types.js').ScopeCheckResult | null {
  const contract = store.readScopeContract(storyId);
  if (!contract) return null;
  const changedFiles = (gitReader ?? readChangedFiles)(projectRoot);
  return checkScopeContract(contract, changedFiles);
}

/**
 * Format scope gate result for lifecycle output.
 * Returns null if no contract (skip = backward-compatible).
 */
export function formatScopeGateForLifecycle(
  result: import('../core/types.js').ScopeCheckResult | null,
): string | null {
  if (!result) return null;
  return result.summary;
}
