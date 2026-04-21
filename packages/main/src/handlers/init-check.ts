/**
 * Init Check handler — koala init_check_set (CHK-003 will register; CHK-001 only ships sign + helpers)
 *
 * INIT → INIT_CHECK 硬门槛产物 init-check.json 的签名工具函数。
 *
 * 签名结构抄 scope-check.ts 的 signScopeCheck 套路（B-d4d1 / B-ed3e 已落地架构），
 * 区别在于签名域：scope-check 用 `storyId:timestamp:gaps:covered:reviewRound:salt`，
 * init-check 用 `storyId:backgroundHash:title:description:checklistHash:reviewRound:salt`，
 * 把"主 agent 立 story 时的真相源（background + 元数据 + 初版 checklist）"全部纳入签名。
 *
 * 主 agent 改 background.md / title / description / checklist.items[*].{title,context}
 * 任何一处 → recomputeInitCheckHash 重算 → 与 init-check.json._hash 失配 →
 * story_advance INIT_CHECK 报 init_check_tampered blocker（CHK-005 / CHK-006）。
 *
 * agentId 字段不参与签名（EXP-001 已证伪 agentId 机械可校验性，详见
 * docs/story/actives/B-e71f/experiments/exp-001.md），仅作审计追溯。
 * issues 字段不参与签名（reviewer 主观判断，advisory 模式，允许后续修）。
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { StoryStore } from '../core/store.js';
import type { HandlerContext } from './context.js';
import type { InitCheckData, InitCheckIssue } from '../core/types.js';

export const INIT_CHECK_SALT = 'koala-init-check-integrity-v1';

/**
 * 计算 background.md 全文的 sha256。文件不存在时返回固定字符串 "missing"，
 * 这样 sign 出的 hash 也是确定的（避免抛错让 sign 函数变成可能 throw）。
 * gate 端会在调用 sign 前用 store.readStory / 文件存在校验做前置检查。
 */
export function computeBackgroundHash(root: string, storyId: string): string {
  const p = join(root, 'docs', 'story', 'actives', storyId, 'background.md');
  if (!existsSync(p)) return 'missing';
  const content = readFileSync(p, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 计算 checklist 初版的 sha256：仅取每个 item 的 title / context（其他字段如 status / startTime /
 * id 是运行时变化的，不应入签名域，否则正常 DEV 推进会反复触发 _hash 失配）。
 *
 * 输入是 ChecklistItem[]（或 Pick），输出确定性 hex。空数组也合法（hash 固定值）。
 */
export function computeChecklistHash(
  items: ReadonlyArray<{ title: string; context?: string }>,
): string {
  // 显式抽 title / context，并把 undefined 归一化成 ''，保证 JSON.stringify 输出稳定。
  const normalized = items.map(i => ({ title: i.title, context: i.context ?? '' }));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * init-check.json 的签名函数。确定性（同输入同输出）。
 *
 * 签名域：storyId / backgroundHash / title / description / checklistHash / reviewRound + salt
 *
 * 不入签名域：agentId / issues / checkedAt（避免 reviewer 重跑同输入仍产生不同 _hash）。
 */
export function signInitCheck(
  storyId: string,
  backgroundHash: string,
  title: string,
  description: string,
  checklistHash: string,
  reviewRound: string,
): string {
  return createHash('sha256')
    .update(`${storyId}:${backgroundHash}:${title}:${description}:${checklistHash}:${reviewRound}:${INIT_CHECK_SALT}`)
    .digest('hex');
}

/**
 * gate 端复用的重算入口（CHK-005 / CHK-006 消费）：读当前 story.title / story.description /
 * background.md / checklist 初版 → 调 signInitCheck → 返回当前 _hash 期望值。
 *
 * checklist 不存在时按空数组算（理论上 INIT 阶段已存在，但兜底防 fs 边界）。
 */
export function recomputeInitCheckHash(storyId: string, store: StoryStore, projectRoot: string): string {
  const story = store.readStory(storyId);
  const backgroundHash = computeBackgroundHash(projectRoot, storyId);
  let items: Array<{ title: string; context?: string }> = [];
  try {
    const checklist = store.readChecklist(storyId);
    items = checklist.items.map(i => ({ title: i.title, context: i.context }));
  } catch {
    // checklist.json 不存在 → 用空数组算 hash，gate 端语义上等同"未初始化 checklist"。
  }
  const checklistHash = computeChecklistHash(items);
  const reviewRound = story.currentReviewRound || '';
  return signInitCheck(
    storyId,
    backgroundHash,
    story.title,
    story.description,
    checklistHash,
    reviewRound,
  );
}

/**
 * CHK-003: init_check_set handler 工厂。
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
      agentId?: string;
    }): string {
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
      const data: InitCheckData = {
        storyId: args.storyId,
        checkedAt: new Date().toISOString(),
        reviewRound,
        agentId: args.agentId ?? '',
        issues,
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
      return `Init check saved for ${args.storyId}: ${issues.length} issues (${critical}/${high}/${medium}/${low})`;
    },
  };
}
