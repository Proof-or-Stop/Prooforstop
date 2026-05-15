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
        // B-ed3e CHK-002: 5 档 status
        status: 'covered' | 'excluded' | 'gap' | 'orphan-suspect' | 'drift';
        excluded_by: string | null;
        source?: string;
      }>;
      summary: {
        total: number;
        covered: number;
        excluded: number;
        gaps: number;
        // B-ed3e CHK-002: 新字段可选（向后兼容老调用者），默认 0
        orphanSuspect?: number;
        drift?: number;
      };
      // B-ed3e CHK-003: 第 6 通道 Open Questions（可选）。reviewer 写入时不校验
      // 业务完整性（只做类型校验），主 agent 之后用 scope_question_resolve 消解。
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
      // 签名域不变：仅 storyId / timestamp / gaps / covered / reviewRound
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
      // B-ed3e CHK-003: openQuestions 原样透传（不入签名域），省略时不写字段。
      // F-007/F-015: 空数组 [] 也保留为 openQuestions:[]，区分 "扫完 0 OQ"（新 agent）
      // 与 "未生成 OQ 字段"（老 agent）两种语义。只有传 undefined 才不写字段。
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
