/**
 * Scope Check handler — koala scope_check_save
 *
 * Lets the scope agent subagent write a signed scope-check.json.
 * The _hash field allows story_review to verify integrity (prevent manual forgery).
 */

import { createHash } from 'crypto';
import type { HandlerContext } from './context.js';
import type { ScopeCheckData, OpenQuestion } from '../core/types.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';

export const SCOPE_CHECK_SALT = 'koala-scope-check-integrity-v1';

export function signScopeCheck(storyId: string, timestamp: string, gaps: number, covered: number, reviewRound: string = ''): string {
  return createHash('sha256')
    .update(`${storyId}:${timestamp}:${gaps}:${covered}:${reviewRound}:${SCOPE_CHECK_SALT}`)
    .digest('hex');
}

export function createScopeCheckHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;
  return {
    scope_check_save(args: {
      storyId: string;
      features: Array<{
        feature: string;
        covered_by: string | null;
        // B-ed3e CHK-002: 5-tier status
        status: 'covered' | 'excluded' | 'gap' | 'orphan-suspect' | 'drift';
        excluded_by: string | null;
        source?: string;
      }>;
      summary: {
        total: number;
        covered: number;
        excluded: number;
        gaps: number;
        // B-ed3e CHK-002: new field is optional (backward compatible with old callers), defaults to 0
        orphanSuspect?: number;
        drift?: number;
      };
      // B-ed3e CHK-003: 6th channel Open Questions (optional). Not validated when reviewer writes
      // business integrity (only type check); main agent later resolves via scope_question_resolve.
      openQuestions?: OpenQuestion[];
    }): string {
      // Verify story exists and read currentReviewRound
      let reviewRound = '';
      try {
        const story = store.readStory(args.storyId);
        reviewRound = story.currentReviewRound || '';
      } catch {
        throw new Error(`Story ${args.storyId} not found`);
      }
      const timestamp = new Date().toISOString();
      // Signature domain unchanged: only storyId / timestamp / gaps / covered / reviewRound
      const _hash = signScopeCheck(args.storyId, timestamp, args.summary.gaps, args.summary.covered, reviewRound);
      const orphanSuspect = args.summary.orphanSuspect ?? 0;
      const drift = args.summary.drift ?? 0;
      const data: ScopeCheckData = {
        storyId: args.storyId,
        checkedAt: timestamp,
        features: args.features,
        summary: {
          total: args.summary.total,
          covered: args.summary.covered,
          excluded: args.summary.excluded,
          gaps: args.summary.gaps,
          orphanSuspect,
          drift,
        },
        reviewRound,
        _hash,
      };
      // B-ed3e CHK-003: openQuestions passed through as-is (not in signature domain), field omitted when absent.
      // F-007/F-015: empty array [] is preserved as openQuestions:[], distinguishing "scanned with 0 OQ" (new agent)
      // from "OQ field not generated" (old agent), two distinct semantics. Only passing undefined omits the field.
      if (Array.isArray(args.openQuestions)) {
        data.openQuestions = args.openQuestions;
      }
      store.writeScopeCheck(args.storyId, data);
      const oqCount = args.openQuestions?.length ?? 0;
      const oqSuffix = oqCount > 0 ? `, open-questions=${oqCount}` : '';
      const commitHint = autoCommitStoryMetadata(root, args.storyId, 'scope_check_save');
      return `Scope check saved for ${args.storyId}: ${args.summary.covered} covered, ${args.summary.excluded} excluded, ${args.summary.gaps} gaps, orphan-suspect=${orphanSuspect}, drift=${drift}${oqSuffix}${commitHint}`;
    },
  };
}
