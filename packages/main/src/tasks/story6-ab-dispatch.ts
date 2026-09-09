import {
  assembleFullPromptEnvelope,
} from '../core/prompt-envelope.js';
import {
  estimatePromptTokens,
  promptUtf8Bytes,
  type FullTaskContext,
} from '../core/prompt-contracts.js';
import { BASELINE_RUNTIME_CONTRACT } from '../core/prompt-measurement.js';
import {
  promptRoleContract,
  resolvePromptRoleBody,
} from '../core/prompt-role-contract-registry.js';
import { ACTIVE_MODULAR_COMPLEX_ROLE_IDS } from '../core/prompt-role-contract-registry.js';

export interface Story6ABReceipt {
  schemaVersion: 'proof-or-stop.story6-ab-receipt.v1';
  roleId: string;
  arm: 'legacy' | 'modular';
  assembledPromptBytes: number;
  assembledPromptTokens: number;
  providerUsage: { availability: 'unavailable'; reason: string };
  outcome: 'INCONCLUSIVE';
  envelopeId?: string;
}

/**
 * Deterministic A/B receipt producer. It measures the two locally observable
 * prompt arms and explicitly records provider usage as unavailable: this
 * helper never invents provider/cache/latency numbers when no provider ran.
 */
export function buildStory6ABReceipts(taskContext: FullTaskContext, dispatchPrompt = 'Story 6 A/B dispatch'): Story6ABReceipt[] {
  const receipts: Story6ABReceipt[] = [];
  for (const roleId of ACTIVE_MODULAR_COMPLEX_ROLE_IDS) {
    const role = promptRoleContract(roleId);
    const legacyBody = resolvePromptRoleBody(roleId, undefined).body;
    receipts.push({
      schemaVersion: 'proof-or-stop.story6-ab-receipt.v1',
      roleId,
      arm: 'legacy',
      assembledPromptBytes: promptUtf8Bytes(legacyBody),
      assembledPromptTokens: estimatePromptTokens(legacyBody),
      providerUsage: { availability: 'unavailable', reason: 'No provider dispatch was run by deterministic local harness.' },
      outcome: 'INCONCLUSIVE',
    });
    const modularBody = resolvePromptRoleBody(roleId, {
      version: 'proof-or-stop.prompt-envelope-rollout.v1',
      roles: { [roleId]: 'full-envelope' },
    }).body;
    const assembly = assembleFullPromptEnvelope({
      roleContract: role,
      runtimeContract: BASELINE_RUNTIME_CONTRACT,
      rolePrompt: modularBody,
      taskContext,
      dispatchKind: 'story-dispatch',
      dispatchPrompt,
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    receipts.push({
      schemaVersion: 'proof-or-stop.story6-ab-receipt.v1',
      roleId,
      arm: 'modular',
      assembledPromptBytes: assembly.envelope.bytes,
      assembledPromptTokens: assembly.envelope.estimatedTokens,
      providerUsage: { availability: 'unavailable', reason: 'No provider dispatch was run by deterministic local harness.' },
      outcome: 'INCONCLUSIVE',
      envelopeId: assembly.envelope.envelopeId,
    });
  }
  return receipts;
}
