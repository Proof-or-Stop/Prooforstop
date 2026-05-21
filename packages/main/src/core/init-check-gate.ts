/**
 * Init Check gate/hash primitives — core signature + gate helpers for init-check.json.
 *
 * This module is the single source of truth for the init-check.json signature
 * algorithm and the INIT_CHECK gate helpers. It lives in core/ (depends only on
 * StoryStore + crypto + fs) so that core consumers (machine.ts) can verify the
 * hash and evaluate the gate without an upward core→handlers import — the same
 * layering fix applied to delivery-check-hash.ts in B-37e9 F-001. The
 * init_check_set command shell (handlers/init-check.ts) re-uses these same
 * functions and re-exports them for backward compatibility.
 *
 * 签名结构抄 scope-check.ts 的 signScopeCheck 套路（B-d4d1 / B-ed3e 已落地架构），
 * 区别在于签名域：scope-check 用 `storyId:timestamp:gaps:covered:reviewRound:salt`，
 * init-check 用 `storyId:backgroundHash:title:description:checklistHash:reviewRound:salt`，
 * 把"主 agent 立 story 时的真相源（background + 元数据 + 初版 checklist）"全部纳入签名。
 *
 * 主 agent 改 background.md / title / description / checklist.items[*].{title,context}
 * 任何一处 → recomputeInitCheckHash 重算 → 与 init-check.json._hash 失配 →
 * story_advance INIT_CHECK 报 init_check_tampered blocker。
 *
 * agentId 字段不参与签名（EXP-001 已证伪 agentId 机械可校验性，详见
 * docs/story/actives/B-e71f/experiments/exp-001.md），仅作审计追溯。
 * issues 字段不参与签名（reviewer 主观判断，advisory 模式，允许后续修）。
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { StoryStore } from './store.js';
import type { InitCheckData, InitCheckIssue } from './types.js';

export const INIT_CHECK_SALT = 'koala-init-check-integrity-v1';
export const REQUIRED_INIT_CHECK_AGENTS = ['koala-review-story-init', 'product-reviewer'] as const;

/**
 * B-95d8 CHK-001: suffix appended to required-agent ids when init-check.json is
 * produced by the manual `init_check_repair` fallback rather than an independent
 * reviewer run. `<required>@fallback` still satisfies missingRequiredInitCheckAgents
 * (initCheckAgentMatches matches the `<required>@` prefix), so the fallback passes
 * the gate WITHOUT weakening it, while remaining mechanically distinguishable from
 * a real reviewer record (which is the bare `<required>` id).
 */
export const INIT_CHECK_FALLBACK_AGENT_SUFFIX = 'fallback';

/**
 * Classify how an init-check.json was attested:
 *  - `'fallback'`  → produced by the manual `init_check_repair` command
 *    (`data.fallback` block present, or any agent id carries the `@fallback` suffix).
 *  - `'independent'` → produced by independent reviewer runs via `init_check_set`.
 *
 * Pure derivation over persisted data; used by story_get / dashboard / report to
 * surface "this gate was passed by a human fallback, not a reviewer".
 */
export function initCheckAttestationMode(data: InitCheckData): 'independent' | 'fallback' {
  if (data.fallback) return 'fallback';
  const suffix = `@${INIT_CHECK_FALLBACK_AGENT_SUFFIX}`;
  for (const result of initCheckAgentResults(data)) {
    if (normalizeAgentId(result.agentId).endsWith(suffix)) return 'fallback';
  }
  return 'independent';
}

export function normalizeAgentId(agentId: string | undefined): string {
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
 * gate 端复用的重算入口：读当前 story.title / story.description /
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
