/**
 * B-ed3e CHK-003: Open Question resolve handler — koala scope_question_resolve
 *
 * Main agent writes a written resolution for Open Questions raised by the scope-plan reviewer.
 *
 * Design principles (see docs/story/actives/B-ed3e/decision.json option A):
 * - resolution is not included in the signature _hash: the signature domain of the scope-check.json written by the reviewer stays unchanged,
 *   the main agent only appends resolution/resolvedAt fields to entries in openQuestions[].
 * - handler does not verify caller identity (CLI layer is unreliable); anti-self-pardon is guaranteed jointly by the PLAN gate's
 *   blocker message + resolution ≥ 20 characters + background.md principles.
 * - oqId not found → throw Error with non-zero exit.
 * - Already resolved oqId overwrites the original resolution, and the return message contains "overwritten".
 */

import type { HandlerContext } from './context.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';

export function createScopeQuestionResolveHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;
  return {
    scope_question_resolve(args: {
      storyId: string;
      oqId: string;
      resolution: string;
      sourcePointers?: string[];
    }): string {
      // B-ed3e REVIEW F-005/F-019: runtime validation of resolution ≥ 20 characters (after trim)
      // Prevents bypassing the cli-engine.ts Zod schema layer via direct registry calls or test environments.
      const trimmedLen = (args.resolution ?? '').trim().length;
      if (trimmedLen < 20) {
        throw new Error(`resolution must be ≥ 20 characters (after trim), current: ${trimmedLen}`);
      }
      const data = store.readScopeCheck(args.storyId);
      if (!data) {
        throw new Error(`Scope check not found for ${args.storyId}: please have the scope-plan reviewer run scope_check_save first`);
      }
      const oqs = data.openQuestions ?? [];
      const idx = oqs.findIndex((o) => o.id === args.oqId);
      if (idx < 0) {
        const known = oqs.map((o) => o.id).join(', ') || '(no openQuestions)';
        throw new Error(`Open Question ${args.oqId} not found in scope-check.json of ${args.storyId}. Existing OQ: ${known}`);
      }
      const prior = oqs[idx];
      const overwritten = typeof prior.resolution === 'string' && prior.resolution.length > 0;
      oqs[idx] = {
        ...prior,
        resolution: args.resolution,
        resolvedAt: new Date().toISOString(),
        // If sourcePointers is provided at resolve time, overwrite/merge — per the rule simply overwrite the original pointers
        // (the reviewer's original sourcePointers remain traceable in the evidence section)
        sourcePointers: (args.sourcePointers && args.sourcePointers.length > 0)
          ? args.sourcePointers
          : prior.sourcePointers,
      };
      data.openQuestions = oqs;
      // No re-signing: resolution is not included in _hash (see decision option A)
      store.writeScopeCheck(args.storyId, data);

      // F-006/F-019: resolvedCount judgment aligns with the PLAN gate standard (≥ 20 characters after trim)
      const resolvedCount = oqs.filter((o) => typeof o.resolution === 'string' && o.resolution.trim().length >= 20).length;
      const total = oqs.length;
      const overwriteTag = overwritten ? ' (overwritten)' : '';
      const commitHint = autoCommitStoryMetadata(root, args.storyId, 'scope_question_resolve');
      const msg = `${args.oqId} resolved for ${args.storyId} (${resolvedCount}/${total})${overwriteTag}\n→ OQ has recorded the main agent's resolution. The reviewer will not verify again; the main agent is responsible for the conclusion${commitHint}`;
      return msg;
    },
  };
}
