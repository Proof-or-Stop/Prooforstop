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
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs';
import { StoryStore } from '../core/store.js';
import type { HandlerContext } from './context.js';
import type { InitCheckData, InitCheckIssue } from '../core/types.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';

export const INIT_CHECK_SALT = 'koala-init-check-integrity-v1';
export const REQUIRED_INIT_CHECK_AGENTS = ['koala-review-story-init', 'product-reviewer'] as const;

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

function normalizeAgentId(agentId: string | undefined): string {
  return (agentId || '').trim();
}

export function initCheckAgentMatches(agentId: string | undefined, required: string): boolean {
  const normalized = normalizeAgentId(agentId);
  return normalized === required || normalized.startsWith(`${required}@`);
}

export function initCheckAgentResults(data: InitCheckData): NonNullable<InitCheckData['agentResults']> {
  if (Array.isArray(data.agentResults) && data.agentResults.length > 0) return data.agentResults;
  return [{
    agentId: normalizeAgentId(data.agentId),
    checkedAt: data.checkedAt,
    issues: Array.isArray(data.issues) ? data.issues : [],
  }];
}

export function missingRequiredInitCheckAgents(data: InitCheckData): string[] {
  const results = initCheckAgentResults(data);
  return REQUIRED_INIT_CHECK_AGENTS.filter(required =>
    !results.some(result => initCheckAgentMatches(result.agentId, required)),
  );
}

export function blockingInitCheckIssues(data: InitCheckData): Array<{ agentId: string; issue: InitCheckIssue }> {
  const blockers: Array<{ agentId: string; issue: InitCheckIssue }> = [];
  for (const result of initCheckAgentResults(data)) {
    for (const issue of result.issues || []) {
      if (issue?.severity === 'critical' || issue?.severity === 'high') {
        blockers.push({ agentId: result.agentId || '<unknown>', issue });
      }
    }
  }
  return blockers;
}

/**
 * 计算 background.md 全文的 sha256。文件不存在时返回固定字符串 "missing"，
 * 这样 sign 出的 hash 也是确定的（避免抛错让 sign 函数变成可能 throw）。
 * gate 端会在调用 sign 前用 store.readStory / 文件存在校验做前置检查。
 */
export function computeBackgroundHash(root: string, storyId: string): string {
  const store = new StoryStore(root);
  const p = store.storyFilePath(storyId, 'background.md');
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
