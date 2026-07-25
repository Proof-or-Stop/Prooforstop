/**
 * Red-evidence mutating CLI commands for the trusted RED-evidence subsystem.
 *
 *   - `red_evidence_binding_set` (W2b / B-e10d) registers the per-story target
 *     binding (§1.1.3). W2c ADDS the §1.1.3 binding-FREEZE rule now that
 *     chain-head semantics exist.
 *   - `red_evidence_quarantine` / `red_evidence_recover` (W2c / B-506e) append the
 *     two chain-control records (§4.1), owner-gated and serialized under one
 *     mkdir claim (append.ts), with a DERIVED `approvedBy` and the §3.3 write-time
 *     expectedRedTargets membership gate (CHK-012).
 *
 * Authorization is layered exactly like every other mutating story command:
 *   1. The story-owner LEASE is enforced UPSTREAM at the single CLI choke point
 *      (cli-engine enforceStoryOwnerLeaseGate) because command-policy classifies
 *      all three as `storyScopedMutating`. A foreign active lease rejects the
 *      command before the handler runs (§4.1).
 *   2. Actor MUTATION AUTHORITY is resolved here via resolveAgentMutationAuthority
 *      — a dispatched role without the authority fails closed, independently of
 *      lease ownership.
 *
 * These commands change NO existing gate verdict: the v2 chain records they write
 * are invisible to the v1 gate predicate (proofstory.ts skips them by schema
 * discriminator), and no gate consumes the chain in this leaf.
 */

import type { HandlerContext } from './context.js';
import { StoryStore } from '../core/store.js';
import { resolveAgentMutationAuthority } from '../core/agent-dispatch-registry.js';
import { getSessionId } from '../core/owner-session.js';
import { resolveExpectedRedTargets } from '../core/proofstory.js';
import { proofStoryDiagnosticInput } from './phase-gates.js';
import {
  appendTargetBinding,
  emptyRedTargetBindingsFile,
  targetBindingDigest,
} from '../core/red-evidence/target-bindings.js';
import { isRedEvidenceV2, type RedEvidenceRecordV2 } from '../core/red-evidence/record-v2.js';
import { partitionChain, resolveChainHead } from '../core/red-evidence/chain.js';
import { controlOperationKey } from '../core/red-evidence/operation-key.js';
import { appendControlRecord, type AppendResult } from '../core/red-evidence/append.js';
import { withMkdirLock } from '../core/mkdir-lock.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';

function withBindingLock<T>(store: StoryStore, storyId: string, fn: () => T): T {
  const lockDir = store.runtimeLockDirPath(storyId, 'red-target-bindings', 'red-target-bindings');
  return withMkdirLock(lockDir, fn, { label: 'red-target-bindings metadata' });
}

/** Locate a v2 chain record by id within a story's store (§4.1 reference lookup). */
function findV2Record(store: StoryStore, storyId: string, recordId: string): RedEvidenceRecordV2 {
  const data = store.readRedEvidence(storyId);
  const record = (data?.records ?? []).find(
    (r): r is RedEvidenceRecordV2 => isRedEvidenceV2(r) && r.id === recordId,
  );
  if (!record) {
    throw new Error(
      `red_evidence chain reference refused: record "${recordId}" is not a v2 chain record in story ${storyId} ` +
        `(a nonexistent id, or a record from a different story, is rejected — §4.1)`,
    );
  }
  return record;
}

/** §3.3 write-time expectedRedTargets membership gate (CHK-012), case-sensitive. */
function assertTargetInExpected(store: StoryStore, root: string, storyId: string, acceptanceTargetRef: string, command: string): void {
  const expected = resolveExpectedRedTargets(proofStoryDiagnosticInput(store, storyId, root));
  if (!expected.has(acceptanceTargetRef)) {
    throw new Error(
      `${command}: derived acceptanceTargetRef "${acceptanceTargetRef}" is not in expectedRedTargets for ${storyId} ` +
        `(§3.3 write-time membership gate; nothing written). Known targets: ${expected.size === 0 ? '<none>' : [...expected].join(', ')}`,
    );
  }
}

/** The DERIVED `approvedBy` = `<actor>@<sessionId>` (§4.1) — never a caller arg. */
function deriveApprovedBy(actor: string | undefined): string {
  return `${actor ?? 'unknown'}@${getSessionId()}`;
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
      resolveAgentMutationAuthority({
        command: 'red_evidence_binding_set',
        payloadActors: [args.agent, args.actor],
      });

      const acceptanceTargetRef = String(args.acceptanceTargetRef ?? '').trim();
      const adapterId = String(args.adapterId ?? '').trim();
      const testCaseRef = String(args.testCaseRef ?? '').trim();
      if (!acceptanceTargetRef || !adapterId || !testCaseRef) {
        throw new Error(
          'red_evidence_binding_set: acceptanceTargetRef, adapterId, and testCaseRef must each be non-blank strings',
        );
      }

      try {
        store.readStory(args.storyId);
      } catch {
        throw new Error(`Story ${args.storyId} not found`);
      }

      // §3.3 write-time membership gate (case-sensitive).
      assertTargetInExpected(store, root, args.storyId, acceptanceTargetRef, 'red_evidence_binding_set');

      return withBindingLock(store, args.storyId, () => {
        // §1.1.3 binding-FREEZE (W2c): a binding is FROZEN once a run record
        // exists on an UNQUARANTINED chain for the target. Setting is legal while
        // the chain is EMPTY or its head is a `quarantine` record; a run-record
        // head (red-assert / green-confirm / a recover reinstating one) freezes
        // the binding — retire the assertion (quarantine) first. Read fresh here.
        const evidence = store.readRedEvidence(args.storyId);
        const chain = partitionChain(evidence?.records ?? [], args.storyId, acceptanceTargetRef);
        const head = resolveChainHead(chain);
        if (head && head.operation !== 'quarantine') {
          throw new Error(
            `red_evidence_binding_set: the target binding for "${acceptanceTargetRef}" is FROZEN — a run record exists on an ` +
              `unquarantined chain (head operation "${head.operation}", §1.1.3). Quarantine the head first to rebind.`,
          );
        }

        const existing = store.readRedTargetBindings(args.storyId) ?? emptyRedTargetBindingsFile(args.storyId);
        const updated = appendTargetBinding(existing, { acceptanceTargetRef, adapterId, testCaseRef });
        store.writeRedTargetBindings(args.storyId, updated);

        const digest = targetBindingDigest({ acceptanceTargetRef, adapterId, testCaseRef });
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'red_evidence_binding_set');
        return `Target binding recorded for ${args.storyId} ${acceptanceTargetRef} → adapter=${adapterId} test=${testCaseRef} (targetBindingDigest ${digest})${commitHint}`;
      });
    },

    red_evidence_quarantine(args: {
      storyId: string;
      recordId: string;
      reason: string;
      agent?: string;
      actor?: string;
      approvedBy?: string; // caller value is DELIBERATELY IGNORED (§4.1).
    }): string {
      return appendChainControl(ctx, {
        command: 'red_evidence_quarantine',
        operation: 'quarantine',
        linkKind: 'quarantines',
        requiredHeadOperations: ['red-assert', 'green-confirm', 'recover'],
        args,
      });
    },

    red_evidence_recover(args: {
      storyId: string;
      recordId: string;
      reason: string;
      agent?: string;
      actor?: string;
      approvedBy?: string; // caller value is DELIBERATELY IGNORED (§4.1).
    }): string {
      return appendChainControl(ctx, {
        command: 'red_evidence_recover',
        operation: 'recover',
        linkKind: 'recovers',
        requiredHeadOperations: ['quarantine'],
        args,
      });
    },
  };
}

interface ChainControlDispatch {
  command: 'red_evidence_quarantine' | 'red_evidence_recover';
  operation: 'quarantine' | 'recover';
  linkKind: 'quarantines' | 'recovers';
  requiredHeadOperations: readonly ('red-assert' | 'green-confirm' | 'quarantine' | 'recover')[];
  args: { storyId: string; recordId: string; reason: string; agent?: string; actor?: string };
}

function appendChainControl(ctx: HandlerContext, dispatch: ChainControlDispatch): string {
  const { store, root } = ctx;
  const { command, operation, linkKind, requiredHeadOperations, args } = dispatch;

  // Actor mutation authority (owner LEASE is enforced upstream at the CLI choke
  // point; this is the independent role-authority gate). approvedBy is DERIVED
  // from this resolved actor + the session id — never a caller argument.
  const authority = resolveAgentMutationAuthority({
    command,
    payloadActors: [args.agent, args.actor],
  });

  const recordId = String(args.recordId ?? '').trim();
  const reason = String(args.reason ?? '').trim();
  if (!recordId || !reason) {
    throw new Error(`${command}: recordId and reason must each be non-blank strings`);
  }

  try {
    store.readStory(args.storyId);
  } catch {
    throw new Error(`Story ${args.storyId} not found`);
  }

  // Derive the target + referenced digest from the referenced record's chain —
  // never a caller argument. (Immutable records, so this pre-lock read is safe;
  // head-ness is re-validated under the lock inside appendControlRecord.)
  const referenced = findV2Record(store, args.storyId, recordId);
  const acceptanceTargetRef = referenced.acceptanceTargetRef;
  const referencedRecordDigest = referenced.recordDigest;

  // CHK-012 §3.3 write-time membership gate on the DERIVED target.
  assertTargetInExpected(store, root, args.storyId, acceptanceTargetRef, command);

  const operationKey = controlOperationKey({
    operation,
    storyId: args.storyId,
    acceptanceTargetRef,
    recoversRecordId: recordId,
    referencedRecordDigest,
    reason,
  });
  const approvedBy = deriveApprovedBy(authority.actor);

  const result: AppendResult = appendControlRecord({
    store,
    storyId: args.storyId,
    acceptanceTargetRef,
    operation,
    operationKey,
    recoversRecordId: recordId,
    referencedRecordDigest,
    linkKind,
    reason,
    approvedBy,
    requiredHeadOperations,
  });

  const commitHint = result.replayed ? '' : autoCommitStoryMetadata(root, args.storyId, command);
  const verb = operation === 'quarantine' ? 'Quarantined' : 'Recovered';
  const replayNote = result.replayed ? ' (replay — existing record returned, nothing written)' : '';
  return (
    `${verb} ${acceptanceTargetRef}: ${result.record.id} seq=${result.record.seq} ` +
    `references=${recordId} approvedBy=${approvedBy}${replayNote}${commitHint}`
  );
}
