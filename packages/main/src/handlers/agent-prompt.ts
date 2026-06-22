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
  readPromptTemplate,
  type PromptRegistryEntry,
} from '../core/prompt-registry.js';

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

export function createAgentPromptHandlers(): Record<string, (...args: any[]) => any> {
  return {
    agent_prompt(args: { role?: string } = {}): string {
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

      // Return the canonical body byte-for-byte from the registry (the same
      // source the Codex manifest resolves via readPromptTemplate). No host
      // transform is applied — this is the single neutral content source.
      return readPromptTemplate(entry);
    },
  };
}
