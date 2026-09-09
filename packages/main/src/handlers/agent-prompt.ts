/**
 * agent-prompt.ts — `proof-or-stop agent_prompt --role=<name>` (B-097f CHK-002)
 *
 * Host-neutral package-registry endpoint. Role-only calls return the canonical
 * host render: a body-free `review_run_start` bootstrap for the five active
 * REVIEW lanes among the six migrated reviewer definitions, the rollout-selected
 * body for migrated complex roles, and the package role body for ordinary roles
 * (including topology-critic). For the five active REVIEW lanes,
 * `review_run_start` selects and returns exactly one legacy or modular body.
 * Codex registry mode resolves the same bootstrap/body split.
 *
 * Contract: docs/requirements/decisions/lifecycle-artifact-scope.md
 *   §"Policy: host-neutral prompt content, thin host adapters (B-097f)" point 2.
 *
 * Handler 编码约定 (CLAUDE.md): the `role` arg has a non-empty constraint in the
 * Zod schema, so this handler RE-validates it at runtime (not just via Zod) —
 * any path (CLI JSON entry, internal fn call, test fixture) that reaches this
 * handler with a blank/missing role is rejected here.
 */

import {
  readPromptRegistry,
  renderPromptEntryForHost,
  type PromptRegistryEntry,
} from '../core/prompt-registry.js';
import type { HandlerContext } from './context.js';
import { loadConfig } from '../core/config.js';
import {
  ACTIVE_MODULAR_COMPLEX_ROLE_IDS,
  promptRoleContract,
  resolvePromptRoleBody,
} from '../core/prompt-role-contract-registry.js';
import { BASELINE_RUNTIME_CONTRACT } from '../core/prompt-measurement.js';
import {
  assembleFullPromptEnvelope,
  buildFullTaskContext,
  verifyPromptEnvelopeIntegrity,
} from '../core/prompt-envelope.js';
import { captureReviewRunSnapshot } from '../core/review-run.js';
import { canonicalJsonStringify } from '../core/prompt-contracts.js';
import { withReviewMetadataTicketLock } from '../core/mkdir-lock.js';
import {
  acquireOrRefreshOwnerLease,
  formatNonOwnerError,
} from '../core/story-owner-lease.js';
import { getSessionId } from '../core/owner-session.js';
import { isBudgetedComplexRole, observeComplexRolePromptBudget } from '../core/prompt-budget.js';
import { canonicalAgentRoleId } from '../core/agent-role-identity.js';
import { PROMPT_ENVELOPE_ROLLOUT_VERSION } from '../core/prompt-role-contract-registry.js';

/**
 * Resolve the registry entry for a role name. Roles are the template basenames
 * with the `.md` extension stripped (`agentId`). Returns null when not found.
 */
export function findRoleEntry(role: string, templateDir?: string): PromptRegistryEntry | null {
  const snapshot = readPromptRegistry(templateDir);
  const canonicalRole = canonicalAgentRoleId(role);
  return snapshot.agents.find(entry => entry.agentId === canonicalRole) ?? null;
}

/** List available role names (sorted) for error messages. */
export function listAvailableRoles(templateDir?: string): string[] {
  return readPromptRegistry(templateDir).agents.map(entry => entry.agentId);
}

type AgentPromptArgs = {
  role?: string;
  storyId?: string;
  format?: 'text' | 'json';
  auditExperiment?: boolean;
  experimentalModeOverride?: 'full-envelope';
};

function validateAgentPromptArgs(args: unknown): asserts args is AgentPromptArgs {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.getPrototypeOf(args) !== Object.prototype) {
    throw new Error('agent_prompt: arguments must be a plain object');
  }
  const record = args as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['role', 'storyId', 'format', 'auditExperiment', 'experimentalModeOverride'].includes(key)) {
      throw new Error(`agent_prompt: unsupported caller-controlled field "${key}"`);
    }
  }
  if (record.storyId !== undefined && (typeof record.storyId !== 'string' || record.storyId.trim().length === 0)) {
    throw new Error('agent_prompt: storyId must be a nonblank string');
  }
  if (record.format !== undefined && !['text', 'json'].includes(record.format as string)) {
    throw new Error('agent_prompt: format must be text or json');
  }
  if (record.auditExperiment !== undefined && typeof record.auditExperiment !== 'boolean') {
    throw new Error('agent_prompt: auditExperiment must be boolean');
  }
  if (record.experimentalModeOverride !== undefined && record.experimentalModeOverride !== 'full-envelope') {
    throw new Error('agent_prompt: experimentalModeOverride must be full-envelope');
  }
  if (record.experimentalModeOverride && record.auditExperiment !== true) {
    throw new Error('agent_prompt: experimentalModeOverride requires auditExperiment=true');
  }
}

export function createAgentPromptHandlers(ctx?: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    agent_prompt(args: AgentPromptArgs = {}): string {
      validateAgentPromptArgs(args);
      // Runtime re-validation (Handler 编码约定): reject blank/missing role even
      // though the Zod schema declares a min-length constraint.
      const requestedRole = (args.role ?? '').trim();
      if (requestedRole.length === 0) {
        const available = listAvailableRoles();
        throw new Error(
          `agent_prompt: --role is required. Available roles: ${available.join(', ')}`,
        );
      }

      const role = canonicalAgentRoleId(requestedRole);
      const entry = findRoleEntry(role);
      if (!entry) {
        const available = listAvailableRoles();
        throw new Error(
          `agent_prompt: unknown role "${requestedRole}". Available roles: ${available.join(', ')}`,
        );
      }

      const configuredPromptEnvelope = ctx ? loadConfig(ctx.root).promptEnvelope : undefined;
      if (args.auditExperiment && (!args.storyId || args.format !== 'json')) {
        throw new Error('agent_prompt: auditExperiment requires storyId and format=json');
      }
      if (args.auditExperiment && !ACTIVE_MODULAR_COMPLEX_ROLE_IDS.includes(role as any)) {
        throw new Error('agent_prompt: auditExperiment is restricted to Story 6 complex roles');
      }
      const effectivePromptEnvelope = args.experimentalModeOverride === 'full-envelope'
        ? {
            version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
            roles: { ...(configuredPromptEnvelope?.roles ?? {}), [role]: 'full-envelope' as const },
          }
        : configuredPromptEnvelope;
      const resolvedRoleBody = resolvePromptRoleBody(
        role,
        effectivePromptEnvelope,
      );
      const rolePrompt = resolvedRoleBody.body;
      if (!args.storyId || !ctx) {
        return renderPromptEntryForHost(entry, 'claude', resolvedRoleBody.mode);
      }

      // Rollback is exact: a disabled role follows the original no-Story path
      // even when a host still supplies storyId/format during rollout.
      if (resolvedRoleBody.mode === 'legacy-full-context' && !args.auditExperiment) return rolePrompt;

      const storyId = args.storyId.trim();
      const leaseResult = acquireOrRefreshOwnerLease(ctx.store.storyDirPath(storyId), {
        command: 'agent_prompt',
        cwd: process.cwd(),
      });
      if (leaseResult.action === 'foreign') {
        throw new Error(formatNonOwnerError(leaseResult.lease, {
          storyId,
          command: 'agent_prompt',
          ownershipClass: 'storyScopedMutating',
          currentSessionId: getSessionId(),
          currentCwd: process.cwd(),
        }));
      }
      const story = ctx.store.readStory(storyId);
      const checklist = ctx.store.readChecklist(storyId);
      const snapshot = captureReviewRunSnapshot(ctx.root, { storyId, storyPhase: story.phase }, ctx.root);
      const taskContext = buildFullTaskContext({
        story,
        checklist,
        ...snapshot,
        scopeContract: ctx.store.readScopeContract(storyId),
      });
      const assembly = resolvedRoleBody.mode === 'full-envelope' ? assembleFullPromptEnvelope({
        roleContract: promptRoleContract(role),
        runtimeContract: BASELINE_RUNTIME_CONTRACT,
        rolePrompt,
        taskContext,
        dispatchKind: 'story-dispatch',
        createdAt: new Date().toISOString(),
      }) : null;
      if (!assembly) {
        const prompt = `${rolePrompt}\n\n## Task Context\n${canonicalJsonStringify(taskContext)}`;
        ctx.store.appendProcessEvent(storyId, {
          type: 'dispatch',
          storyId,
          phase: story.phase,
          source: 'proof-or-stop agent_prompt audit experiment',
          targetKind: 'story-dispatch',
          agentType: role,
        });
        return canonicalJsonStringify({
          schemaVersion: 'proof-or-stop.agent-prompt-response.v1',
          mode: resolvedRoleBody.mode,
          roleBodyDigest: resolvedRoleBody.bodyDigest,
          legacyBytesRestored: resolvedRoleBody.legacyBytesRestored,
          auditOnly: true,
          auditExperiment: true,
          canMintReviewEvidence: false,
          prompt,
          taskContext,
          envelope: null,
        });
      }
      // B-d877 R3 FIX B: relocate out of the git-tracked story dir to the gitignored
      // shared `.proof-or-stop/locks/prompt-envelopes/<id>-prompt-envelopes.lock` (same
      // canonical lock the review_run_start prompt-envelope write uses).
      const lockDir = ctx.store.runtimeLockDirPath(storyId, 'review-run', 'review-runs');
      const promptBudget = isBudgetedComplexRole(role)
        ? observeComplexRolePromptBudget({
            roleId: role,
            contextMode: 'full',
            bytes: assembly.envelope.bytes,
            estimatedTokens: assembly.envelope.estimatedTokens,
          })
        : undefined;
      const envelope = withReviewMetadataTicketLock(lockDir, `agent_prompt for ${storyId}/${role}`, () => {
        const data = ctx.store.readPromptEnvelopes(storyId);
        const existing = data.envelopes.find(candidate => candidate.envelopeId === assembly.envelope.envelopeId);
        if (existing) {
          if (!verifyPromptEnvelopeIntegrity(existing)) {
            throw new Error(`agent_prompt: persisted envelope ${existing.envelopeId} failed integrity verification`);
          }
          ctx.store.appendProcessEvent(storyId, {
            type: 'dispatch', storyId, phase: story.phase, source: 'proof-or-stop agent_prompt',
            targetKind: 'story-dispatch', agentType: role,
            promptEnvelopeId: existing.envelopeId, promptEnvelopeDigest: existing.contextDigest,
            assembledPromptDigest: existing.assembledPromptDigest,
            ...(promptBudget ? { promptBudget } : {}),
            ...(promptBudget && !promptBudget.withinBudget ? { budgetViolation: 'full' as const } : {}),
          });
          return existing;
        }
        data.envelopes.push(assembly.envelope);
        ctx.store.writePromptEnvelopes(storyId, data);
        try {
          const persisted = ctx.store.readPromptEnvelopes(storyId).envelopes.find(
            candidate => candidate.envelopeId === assembly.envelope.envelopeId,
          );
          if (!persisted || !verifyPromptEnvelopeIntegrity(persisted)) {
            throw new Error(`agent_prompt: envelope ${assembly.envelope.envelopeId} was not durably persisted`);
          }
          ctx.store.appendProcessEvent(storyId, {
            type: 'dispatch', storyId, phase: story.phase, source: 'proof-or-stop agent_prompt',
            targetKind: 'story-dispatch', agentType: role,
            promptEnvelopeId: persisted.envelopeId, promptEnvelopeDigest: persisted.contextDigest,
            assembledPromptDigest: persisted.assembledPromptDigest,
            ...(promptBudget ? { promptBudget } : {}),
            ...(promptBudget && !promptBudget.withinBudget ? { budgetViolation: 'full' as const } : {}),
          });
          return persisted;
        } catch (error) {
          const rollback = ctx.store.readPromptEnvelopes(storyId);
          rollback.envelopes = rollback.envelopes.filter(candidate => candidate.envelopeId !== assembly.envelope.envelopeId);
          ctx.store.writePromptEnvelopes(storyId, rollback);
          throw error;
        }
      });
      // Story 6 production receipt: the same trusted envelope persisted above
      // is also visible in the append-only dispatch event stream. This is
      // diagnostic/audit evidence only and cannot mint REVIEW evidence.
      if (args.format === 'json') {
        return canonicalJsonStringify({
        schemaVersion: 'proof-or-stop.agent-prompt-response.v1',
          mode: resolvedRoleBody.mode,
          roleBodyDigest: resolvedRoleBody.bodyDigest,
          legacyBytesRestored: resolvedRoleBody.legacyBytesRestored,
          auditOnly: true,
          ...(args.auditExperiment ? { auditExperiment: true } : {}),
          canMintReviewEvidence: false,
          prompt: assembly.prompt,
          taskContext: assembly.taskContext,
          knownExecutionEnvironment: assembly.knownExecutionEnvironment,
          envelope,
          ...(promptBudget ? { promptBudget } : {}),
        });
      }

      // Story-aware assembly returns the selected canonical body plus trusted
      // context. Migrated role-only calls above intentionally return only the
      // bootstrap and enter this path through review_run_start instead.
      return assembly.prompt;
    },
  };
}
