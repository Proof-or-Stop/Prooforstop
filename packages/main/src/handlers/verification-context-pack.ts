import type { HandlerContext } from './context.js';
import {
  createVerificationContextPack,
  createVerificationContextPackExpansion,
} from '../core/verification-context-pack.js';
import type { VerificationContextPackContract } from '../core/authority-contracts.js';

export function createVerificationContextPackHandlers(ctx: HandlerContext) {
  return {
    verification_context_pack_create(args: {
      producerRunId: string;
      storyId?: string;
      baseRef?: string;
      headRef?: string;
      packId?: string;
      checklistItemIds?: string[];
      testIntentRefs?: string[];
      acceptanceCriteria?: string[];
      requiredRefs?: string[];
      oracleRefs?: string[];
      tokenBudget?: number;
      excludedPaths?: string[];
      metadata?: Record<string, unknown>;
    }) {
      const result = createVerificationContextPack({
        root: ctx.root,
        ...args,
      });
      return {
        pack: result.pack,
        packDigest: result.packDigest,
        summary: {
          changedFiles: result.pack.changedFiles?.length ?? 0,
          changedHunks: result.pack.changedHunks?.length ?? 0,
          sourceSnippets: result.pack.sourceSnippets?.length ?? 0,
          estimatedTokens: result.pack.estimatedTokens ?? 0,
          truncated: result.pack.truncated ?? false,
        },
      };
    },

    verification_context_pack_expand(args: {
      parentPack: VerificationContextPackContract;
      packId?: string;
      expansionReason: string;
      impactedFiles?: string[];
      requiredRefs?: string[];
      tokenBudget?: number;
      metadata?: Record<string, unknown>;
    }) {
      const result = createVerificationContextPackExpansion(args.parentPack, args);
      return {
        pack: result.pack,
        packDigest: result.packDigest,
        parentPackDigest: result.parentPackDigest,
      };
    },
  };
}
