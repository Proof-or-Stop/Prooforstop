/**
 * Init Check handler — koala init_check_set command shell + metadata lock.
 *
 * The signature/gate primitives (INIT_CHECK_SALT, REQUIRED_INIT_CHECK_AGENTS,
 * normalize/match/results helpers, missingRequiredInitCheckAgents,
 * blockingInitCheckIssues, computeBackgroundHash, computeChecklistHash,
 * signInitCheck, recomputeInitCheckHash) live in core/init-check-gate.ts so that
 * core consumers (machine.ts) can verify the hash and evaluate the INIT_CHECK
 * gate without an upward core→handlers import (B-37e9 F-001 layering fix). This
 * file imports them and re-exports them for backward-compatible callers while
 * keeping the init_check_set handler factory and the metadata-write lock here.
 *
 * INIT → INIT_CHECK 硬门槛产物 init-check.json 的签名结构与 gate 语义详见
 * core/init-check-gate.ts 模块注释。
 */

import { mkdirSync, rmSync, statSync } from 'fs';
import { StoryStore } from '../core/store.js';
import type { HandlerContext } from './context.js';
import type { InitCheckData, InitCheckIssue } from '../core/types.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import {
  INIT_CHECK_SALT,
  REQUIRED_INIT_CHECK_AGENTS,
  normalizeAgentId,
  initCheckAgentMatches,
  initCheckAgentResults,
  missingRequiredInitCheckAgents,
  blockingInitCheckIssues,
  computeBackgroundHash,
  computeChecklistHash,
  signInitCheck,
  recomputeInitCheckHash,
} from '../core/init-check-gate.js';

// Backward-compatible re-exports: existing importers (core/machine.ts now reads
// from core directly; story-create.ts / draft-check.ts still import from here).
export {
  INIT_CHECK_SALT,
  REQUIRED_INIT_CHECK_AGENTS,
  normalizeAgentId,
  initCheckAgentMatches,
  initCheckAgentResults,
  missingRequiredInitCheckAgents,
  blockingInitCheckIssues,
  computeBackgroundHash,
  computeChecklistHash,
  signInitCheck,
  recomputeInitCheckHash,
};

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withInitCheckLock<T>(store: StoryStore, storyId: string, fn: () => T): T {
  const lockDir = store.storyFilePath(storyId, 'init-check.lock');
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (e: any) {
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > 10000) rmSync(lockDir, { recursive: true, force: true });
      } catch { /* PROBE: lock disappeared between mkdir attempts */ }
      if (Date.now() > deadline) {
        throw new Error(`init_check_set: timed out waiting for metadata lock (${e?.message || e})`);
      }
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * init_check_set handler 工厂。
 *
 * 由 koala-review-story-init subagent 调用（CHK-002 模板），写入 init-check.json。
 * 不校验调用方 agentId（EXP-001 已证伪 subagent 与主 agent 在 CLI 视角下机械可区分性）；
 * agentId 仅作为 reviewer 自报的审计字段透传。反自豁免靠 (1) 签名机制 +
 * (2) reviewer 模板 fence + (3) CLAUDE.md 行为规约 三层（同 B-ed3e scope-check 已落地架构）。
 *
 * 三层校验（packages/koala/CLAUDE.md「Handler 编码约定」）：
 * - Zod schema：cli-engine.ts 注册端定义 issues 数组结构 + severity enum + desc min(1)
 * - runtime（本 handler 入口）：再校验 desc.trim().length >= 1，防绕过 Zod 路径
 * - gate 决策点（CHK-005 实现）：消费 init-check.json.issues 时按同标准 trim 校验
 */
export function createInitCheckHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;
  return {
    init_check_set(args: {
      storyId: string;
      issues: InitCheckIssue[];
      agent?: string;
      agentId?: string;
    }): string {
      return withInitCheckLock(store, args.storyId, () => {
      // 1) story 存在性校验（同 scope_check_save 套路）
      let title = '';
      let description = '';
      let reviewRound = '';
      try {
        const story = store.readStory(args.storyId);
        title = story.title;
        description = story.description;
        reviewRound = story.currentReviewRound || '';
      } catch {
        throw new Error(`Story ${args.storyId} not found`);
      }

      // 2) issues runtime 校验（防 Zod 绕过路径，与 gate 端 trim 标准对齐）
      const issues = Array.isArray(args.issues) ? args.issues : [];
      for (const issue of issues) {
        if (!issue || typeof issue.desc !== 'string' || issue.desc.trim().length < 1) {
          throw new Error(
            `init_check_set: 每个 issue.desc 必须 trim 后 ≥ 1 字符（reviewer 主观判断需具体）`,
          );
        }
      }

      // 3) 计算签名所需的三块 hash
      const backgroundHash = computeBackgroundHash(root, args.storyId);
      let items: Array<{ title: string; context?: string }> = [];
      try {
        const checklist = store.readChecklist(args.storyId);
        items = checklist.items.map(i => ({ title: i.title, context: i.context }));
      } catch {
        // checklist.json 不存在时按空数组算 hash（与 recomputeInitCheckHash 行为一致）
      }
      const checklistHash = computeChecklistHash(items);

      // 4) 调签名函数（与 recomputeInitCheckHash 共用 signInitCheck，单一真相源）
      const _hash = signInitCheck(args.storyId, backgroundHash, title, description, checklistHash, reviewRound);

      // 5) 构造 InitCheckData 并落盘
      const checkedAt = new Date().toISOString();
      const agentId = normalizeAgentId(args.agentId || args.agent);
      const previous = store.readInitCheck(args.storyId);
      const agentResults = previous ? initCheckAgentResults(previous).filter(
        result => !initCheckAgentMatches(result.agentId, agentId) && result.agentId !== agentId,
      ) : [];
      agentResults.push({ agentId, checkedAt, issues });

      const data: InitCheckData = {
        storyId: args.storyId,
        checkedAt,
        reviewRound,
        agentId,
        issues,
        agentResults,
        _hash,
      };
      store.writeInitCheck(args.storyId, data);

      // 6) 返回值含按 severity 分桶的 issue 计数（advisory 模式：critical 也不阻塞这里，
      //    由 reviewer 模板自律拒调；CHK-005 gate 端 advance 成功消息再 echo critical 警告）
      let critical = 0, high = 0, medium = 0, low = 0;
      for (const issue of issues) {
        switch (issue.severity) {
          case 'critical': critical++; break;
          case 'high': high++; break;
          case 'medium': medium++; break;
          case 'low': low++; break;
        }
      }
      const missing = missingRequiredInitCheckAgents(data);
      const commitHint = autoCommitStoryMetadata(root, args.storyId, 'init_check_set');
      return `Init check saved for ${args.storyId}: ${issues.length} issues (${critical}/${high}/${medium}/${low}); recorded agents: ${agentResults.map(r => r.agentId || '<unknown>').join(', ')}${missing.length > 0 ? `; missing required agents: ${missing.join(', ')}` : ''}${commitHint}`;
      });
    },
  };
}
