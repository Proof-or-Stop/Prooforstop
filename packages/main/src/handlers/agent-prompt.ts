/**
 * agent-prompt.ts — `lattice agent_prompt --role=<name>` (B-097f CHK-002)
 *
 * Host-neutral shared content endpoint. Returns the canonical role prompt BODY
 * straight from the package prompt registry (`readPromptRegistry()` over
 * `templates/agents`), byte-for-byte identical to what the Codex manifest
 * resolves. Claude thin-shims fetch from this command; Codex resolves the same
 * registry. There is ONE content source.
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
  type PromptRegistryEntry,
} from '../core/prompt-registry.js';
import type { HandlerContext } from './context.js';
import { loadConfig } from '../core/config.js';
import {
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
import { withMkdirLock } from '../core/mkdir-lock.js';
import {
  acquireOrRefreshOwnerLease,
  formatNonOwnerError,
} from '../core/story-owner-lease.js';
import { getSessionId } from '../core/owner-session.js';

/**
 * Resolve the registry entry for a role name. Roles are the template basenames
 * with the `.md` extension stripped (`agentId`). Returns null when not found.
 */
export function findRoleEntry(role: string, templateDir?: string): PromptRegistryEntry | null {
  const snapshot = readPromptRegistry(templateDir);
  return snapshot.agents.find(entry => entry.agentId === role) ?? null;
}

/** List available role names (sorted) for error messages. */
export function listAvailableRoles(templateDir?: string): string[] {
  return readPromptRegistry(templateDir).agents.map(entry => entry.agentId);
}

function validateAgentPromptArgs(args: unknown): asserts args is { role?: string; storyId?: string; format?: 'text' | 'json' } {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.getPrototypeOf(args) !== Object.prototype) {
    throw new Error('agent_prompt: arguments must be a plain object');
  }
  const record = args as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['role', 'storyId', 'format'].includes(key)) {
      throw new Error(`agent_prompt: unsupported caller-controlled field "${key}"`);
    }
  }
  if (record.storyId !== undefined && (typeof record.storyId !== 'string' || record.storyId.trim().length === 0)) {
    throw new Error('agent_prompt: storyId must be a nonblank string');
  }
  if (record.format !== undefined && !['text', 'json'].includes(record.format as string)) {
    throw new Error('agent_prompt: format must be text or json');
  }
}

export function createAgentPromptHandlers(ctx?: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    agent_prompt(args: { role?: string; storyId?: string; format?: 'text' | 'json' } = {}): string {
      validateAgentPromptArgs(args);
      // Runtime re-validation (Handler 编码约定): reject blank/missing role even
      // though the Zod schema declares a min-length constraint.
      const role = (args.role ?? '').trim();
      if (role.length === 0) {
        const available = listAvailableRoles();
        throw new Error(
          `agent_prompt: --role is required. Available roles: ${available.join(', ')}`,
        );
      }

      const entry = findRoleEntry(role);
      if (!entry) {
        const available = listAvailableRoles();
        throw new Error(
          `agent_prompt: unknown role "${role}". Available roles: ${available.join(', ')}`,
        );
      }

      const resolvedRoleBody = resolvePromptRoleBody(
        role,
        ctx ? loadConfig(ctx.root).promptEnvelope : undefined,
      );
      const rolePrompt = resolvedRoleBody.body;
      if (!args.storyId || !ctx) return rolePrompt;

      // Rollback is exact: a disabled role follows the original no-Story path
      // even when a host still supplies storyId/format during rollout.
      if (resolvedRoleBody.mode === 'legacy-full-context') return rolePrompt;

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
      const assembly = assembleFullPromptEnvelope({
        roleContract: promptRoleContract(role),
        runtimeContract: BASELINE_RUNTIME_CONTRACT,
        rolePrompt,
        taskContext,
        dispatchKind: 'story-dispatch',
        createdAt: new Date().toISOString(),
      });
      const lockDir = ctx.store.storyFilePath(storyId, 'prompt-envelopes.lock');
      const envelope = withMkdirLock(lockDir, () => {
        const data = ctx.store.readPromptEnvelopes(storyId);
        const existing = data.envelopes.find(candidate => candidate.envelopeId === assembly.envelope.envelopeId);
        if (existing) {
          if (!verifyPromptEnvelopeIntegrity(existing)) {
            throw new Error(`agent_prompt: persisted envelope ${existing.envelopeId} failed integrity verification`);
          }
          return existing;
        }
        data.envelopes.push(assembly.envelope);
        ctx.store.writePromptEnvelopes(storyId, data);
        const persisted = ctx.store.readPromptEnvelopes(storyId).envelopes.find(
          candidate => candidate.envelopeId === assembly.envelope.envelopeId,
        );
        if (!persisted || !verifyPromptEnvelopeIntegrity(persisted)) {
          throw new Error(`agent_prompt: envelope ${assembly.envelope.envelopeId} was not durably persisted`);
        }
        return persisted;
      }, { label: 'prompt-envelopes metadata' });
      if (args.format === 'json') {
        return canonicalJsonStringify({
          schemaVersion: 'proofbound.agent-prompt-response.v1',
          mode: resolvedRoleBody.mode,
          roleBodyDigest: resolvedRoleBody.bodyDigest,
          legacyBytesRestored: resolvedRoleBody.legacyBytesRestored,
          auditOnly: true,
          canMintReviewEvidence: false,
          prompt: assembly.prompt,
          taskContext: assembly.taskContext,
          knownExecutionEnvironment: assembly.knownExecutionEnvironment,
          envelope,
        });
      }

      // Return the canonical body byte-for-byte from the registry (the same
      // source the Codex manifest resolves via readPromptTemplate). No host
      // transform is applied — this is the single neutral content source.
      return assembly.prompt;
    },
  };
}
