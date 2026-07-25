/**
 * Red-evidence target-binding handler — the trusted RED-evidence subsystem's
 * FIRST mutating CLI command (W2b / B-e10d).
 *
 * `red_evidence_binding_set(storyId, acceptanceTargetRef, adapterId, testCaseRef)`
 * registers the per-story target binding (§1.1.3) that later authorizes a RED
 * run. Authorization is layered exactly like every other mutating story command:
 *
 *   1. The story-owner LEASE is enforced UPSTREAM at the single CLI choke point
 *      (cli-engine.ts:1372 enforceStoryOwnerLeaseGate) because command-policy
 *      classifies red_evidence_binding_set as `storyScopedMutating`. A foreign
 *      active lease rejects the command before this handler runs (§4.1).
 *   2. Actor MUTATION AUTHORITY is resolved here via resolveAgentMutationAuthority
 *      (agent-dispatch-registry.ts) — the same mechanism init_check_set uses — so
 *      a dispatched role without red_evidence_binding_set authority fails closed,
 *      independently of lease ownership.
 *
 * Write-time gates (this handler):
 *   - §3.3 membership: acceptanceTargetRef MUST be in expectedRedTargets
 *     (resolveExpectedRedTargets over the story's ProofStory diagnostic input),
 *     case-sensitively; otherwise the write is rejected.
 *   - §1.1.3 uniqueness: exactly one binding per acceptanceTargetRef — a
 *     duplicate-target write is rejected (RedTargetBindingDuplicateError), never
 *     an overwrite. The read-append-write runs under an mkdir claim so concurrent
 *     same-owner writes serialize (the B-d877 R3 discipline §4.1 prescribes).
 *
 * OUT of scope (W2c / W3, deliberately not here): the binding-FREEZE rule
 * (chain EMPTY / quarantine-head / frozen-once-run), run-time adapterId /
 * testCaseRef validation, any chain append/read, and any gate rewiring. This
 * command changes NO existing gate verdict.
 */

import type { HandlerContext } from './context.js';
import { StoryStore } from '../core/store.js';
import { resolveAgentMutationAuthority } from '../core/agent-dispatch-registry.js';
import { resolveExpectedRedTargets } from '../core/proofstory.js';
import { proofStoryDiagnosticInput } from './phase-gates.js';
import {
  appendTargetBinding,
  emptyRedTargetBindingsFile,
  targetBindingDigest,
} from '../core/red-evidence/target-bindings.js';
import { withMkdirLock } from '../core/mkdir-lock.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';

function withBindingLock<T>(store: StoryStore, storyId: string, fn: () => T): T {
  const lockDir = store.runtimeLockDirPath(storyId, 'red-target-bindings', 'red-target-bindings');
  return withMkdirLock(lockDir, fn, { label: 'red-target-bindings metadata' });
}

export function createRedEvidenceHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;
  return {
    red_evidence_binding_set(args: {
      storyId: string;
      acceptanceTargetRef: string;
      adapterId: string;
      testCaseRef: string;
      agent?: string;
      actor?: string;
    }): string {
      // Actor mutation authority (owner LEASE is enforced upstream at the CLI
      // choke point; this is the independent role-authority gate).
      resolveAgentMutationAuthority({
        command: 'red_evidence_binding_set',
        payloadActors: [args.agent, args.actor],
      });

      // Runtime validation (three-layer convention: guard the Zod-bypass path).
      const acceptanceTargetRef = String(args.acceptanceTargetRef ?? '').trim();
      const adapterId = String(args.adapterId ?? '').trim();
      const testCaseRef = String(args.testCaseRef ?? '').trim();
      if (!acceptanceTargetRef || !adapterId || !testCaseRef) {
        throw new Error(
          'red_evidence_binding_set: acceptanceTargetRef, adapterId, and testCaseRef must each be non-blank strings',
        );
      }

      // Story existence.
      try {
        store.readStory(args.storyId);
      } catch {
        throw new Error(`Story ${args.storyId} not found`);
      }

      // §3.3 write-time membership gate (case-sensitive). Uses the SAME exported
      // resolver the ProofStory red-evidence diagnostics compute expectedRedTargets from.
      const expected = resolveExpectedRedTargets(proofStoryDiagnosticInput(store, args.storyId, root));
      if (!expected.has(acceptanceTargetRef)) {
        throw new Error(
          `red_evidence_binding_set: acceptanceTargetRef "${acceptanceTargetRef}" is not in expectedRedTargets for ${args.storyId} ` +
            `(§3.3 write-time membership gate). Known targets: ${expected.size === 0 ? '<none>' : [...expected].join(', ')}`,
        );
      }

      return withBindingLock(store, args.storyId, () => {
        const existing = store.readRedTargetBindings(args.storyId) ?? emptyRedTargetBindingsFile(args.storyId);
        // §1.1.3 uniqueness: appendTargetBinding throws on a duplicate target.
        const updated = appendTargetBinding(existing, { acceptanceTargetRef, adapterId, testCaseRef });
        store.writeRedTargetBindings(args.storyId, updated);

        const digest = targetBindingDigest({ acceptanceTargetRef, adapterId, testCaseRef });
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'red_evidence_binding_set');
        return `Target binding recorded for ${args.storyId} ${acceptanceTargetRef} → adapter=${adapterId} test=${testCaseRef} (targetBindingDigest ${digest})${commitHint}`;
      });
    },
  };
}
