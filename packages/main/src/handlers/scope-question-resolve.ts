/**
 * B-ed3e CHK-003: Open Question resolve handler — koala scope_question_resolve
 *
 * 主 agent 对 scope-plan reviewer 抛出的 Open Question 写入书面 resolution。
 *
 * 设计原则（见 docs/story/actives/B-ed3e/decision.json 方案 A）：
 * - resolution 不入签名 _hash：reviewer 写的 scope-check.json 签名域保持不变，
 *   主 agent 只是在 openQuestions[] 条目上追加 resolution/resolvedAt 字段。
 * - handler 不校验调用者身份（CLI 层不可靠）；防自我赦免由 PLAN gate 的
 *   blocker 文案 + resolution ≥ 20 字符 + background.md 原则共同保障。
 * - 找不到 oqId → 抛 Error 非零退出。
 * - 已 resolved 的 oqId 覆盖原 resolution，并在返回消息中含 "overwritten"。
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
      // B-ed3e REVIEW F-005/F-019: runtime 校验 resolution ≥ 20 字符（trim 后）
      // 防通过 registry 直接调用或测试环境绕过 cli-engine.ts Zod schema 层。
      const trimmedLen = (args.resolution ?? '').trim().length;
      if (trimmedLen < 20) {
        throw new Error(`resolution 必须 ≥ 20 字符（trim 后），当前: ${trimmedLen}`);
      }
      const data = store.readScopeCheck(args.storyId);
      if (!data) {
        throw new Error(`Scope check not found for ${args.storyId}: 请先让 scope-plan reviewer 跑 scope_check_save`);
      }
      const oqs = data.openQuestions ?? [];
      const idx = oqs.findIndex((o) => o.id === args.oqId);
      if (idx < 0) {
        const known = oqs.map((o) => o.id).join(', ') || '(无 openQuestions)';
        throw new Error(`Open Question ${args.oqId} not found in scope-check.json of ${args.storyId}. 已有 OQ: ${known}`);
      }
      const prior = oqs[idx];
      const overwritten = typeof prior.resolution === 'string' && prior.resolution.length > 0;
      oqs[idx] = {
        ...prior,
        resolution: args.resolution,
        resolvedAt: new Date().toISOString(),
        // sourcePointers 若 resolve 时提供，则覆盖/合并——按规则简单覆盖原指针
        // （reviewer 的原始 sourcePointers 仍在 evidence 段可溯源）
        sourcePointers: (args.sourcePointers && args.sourcePointers.length > 0)
          ? args.sourcePointers
          : prior.sourcePointers,
      };
      data.openQuestions = oqs;
      // 不重新签名：resolution 不入 _hash（见 decision 方案 A）
      store.writeScopeCheck(args.storyId, data);

      // F-006/F-019: resolvedCount 判定与 PLAN gate 标准对齐（trim 后 ≥ 20 字符）
      const resolvedCount = oqs.filter((o) => typeof o.resolution === 'string' && o.resolution.trim().length >= 20).length;
      const total = oqs.length;
      const overwriteTag = overwritten ? ' (overwritten)' : '';
      const commitHint = autoCommitStoryMetadata(root, args.storyId, 'scope_question_resolve');
      const msg = `${args.oqId} resolved for ${args.storyId} (${resolvedCount}/${total})${overwriteTag}\n→ OQ 已记录主 agent 的 resolution。reviewer 不会再验证，主 agent 对结论负责${commitHint}`;
      return msg;
    },
  };
}
