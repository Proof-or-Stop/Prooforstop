/**
 * B-9bd9 CHK-002: meta-story B-META-framework-audit 容器 + drift hash + round 管理
 *
 * 职责：
 *   - ensureMetaStory(): 幂等创建 meta-story（固定 ID: B-META-framework-audit，phase=META，永不进 DONE）
 *   - beginRound(storyId): 读 story.events 推出下一轮 round number（1-based，单调递增）
 *   - upsertDrift(round, drift): driftHash 已存在 → 刷 lastSeenAt + reviewRound；不存在 → 新建 finding（带签名）
 *   - autoResolveMissing(round, seenHashes): 上一轮存在、本轮未见的 → 批量 auto-resolve
 *
 * driftHash 输入严格只有 (sectionPath, symbol, driftType) 三元组（crypto sha1 前 10 位），
 * 不含时间戳/pid/随机，保证跨进程 + 跨轮次稳定。
 *
 * 所有函数都是纯函数，通过注入 StoryStore 实例解耦文件 I/O。
 */

import { createHash } from 'crypto';
import type { StoryStore } from './store.js';
import type { DisprovenEvidence, Finding, FindingEvidenceState, StoryInfo, StoryEvent } from './types.js';
import { signFinding } from './finding-verify.js';

/** Meta-story 的固定 ID（全仓唯一容器） */
export const META_STORY_ID = 'B-META-framework-audit';

/**
 * Guard: meta-story 能否进 target phase。
 * 返回 null 表示允许；返回 string 是拒绝理由（供 story-advance 抛错消息使用）。
 *
 * 规则：B-META-* 前缀的 story 是容器，**任何 phase 推进都被拒**——它们不走 INIT/PLAN/DEV/
 * REVIEW/TEST/DONE 常规流程，只通过 audit round 累积 finding。若不在此处拦截，story-advance
 * 后续 `createStoryActor(..., 'META', ...)` 会在 xstate machine 中找不到 META 状态节点，
 * 抛出令人困惑的通用错误 `Cannot transition from META to X`。这里给出明确错误文案。
 */
export function checkMetaStoryAdvanceGuard(storyId: string, _targetPhase: string): string | null {
  if (storyId.startsWith('B-META-')) {
    return (
      `Cannot advance meta-story ${storyId}: META stories are containers; cannot advance via story_advance. ` +
      `meta-story 只通过 audit round 累积 finding，不走常规 phase 流转。` +
      `若需停止 audit 请改 .koala/audit-config.json 的 mode=off。`
    );
  }
  return null;
}

/** Drift 输入三元组（driftHash 唯一输入，任何字段变化 → hash 变） */
export interface DriftInput {
  sectionPath: string;
  symbol: string;
  driftType: string;
  desc: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

/** upsertDrift 返回的三态，方便上层（CHK-001 audit 命令）区分 */
export type DriftState = 'new' | 'still-drifting';

export interface UpsertResult {
  state: DriftState;
  driftHash: string;
  findingId: string;
}

/**
 * driftHash = sha1(sectionPath + '|' + symbol + '|' + driftType) 前 10 位。
 * 严格三元组输入，跨进程稳定。desc/severity 不入签名（允许描述微调而不新增 finding）。
 */
export function driftHash(sectionPath: string, symbol: string, driftType: string): string {
  return createHash('sha1')
    .update(`${sectionPath}|${symbol}|${driftType}`)
    .digest('hex')
    .slice(0, 10);
}

/**
 * 幂等创建 meta-story：已存在则跳过，否则按标准 StoryInfo 写入。
 * phase=META 是特殊值（types.ts 里已加），永不进 DONE；由 story-advance 的 guard 拦截。
 */
export function ensureMetaStory(store: StoryStore): { created: boolean; storyId: string } {
  if (store.storyExists(META_STORY_ID)) {
    return { created: false, storyId: META_STORY_ID };
  }
  const now = new Date().toISOString();
  const story: StoryInfo = {
    storyId: META_STORY_ID,
    name: 'framework-audit',
    title: 'koala 框架自省 audit（跨 story 长存容器）',
    description:
      'B-9bd9 引入的 meta-story 容器：承载「CLAUDE.md 承诺 vs 实际代码行为」drift finding。' +
      '每次 audit 新增一个 round，drift hash 稳定签名防重复；此 story 永不进 DONE。',
    type: 'meta',
    phase: 'META',
    priority: 'low',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [],
  };
  store.writeStory(META_STORY_ID, story);
  return { created: true, storyId: META_STORY_ID };
}

/**
 * beginRound: 返回下一轮 round number（1-based）。
 * 通过读 story.events 中 action='advance' 且 phase='REVIEW' 的条目推断已有轮数，+1 即为本轮。
 * 此函数本身不写事件——由上层（CHK-001 audit 命令）在跑完 audit 后自行 append。
 *
 * 对 meta-story：events 里只有 audit round 记录（因为 meta-story 不走常规 REVIEW），
 * 所以我们用 `phase=META` + `action=advance` 作为 round 标记。首次调用返回 1。
 */
export function beginRound(store: StoryStore, storyId: string = META_STORY_ID): number {
  try {
    const story = store.readStory(storyId);
    const events = story.events || [];
    const prior = events.filter(e => e.phase === 'META' && e.action === 'advance').length;
    return prior + 1;
  } catch (err) {
    console.warn(`[audit-meta-store] beginRound failed for ${storyId}:`, err);
    return 1;
  }
}

/**
 * 记录一轮 audit round（append event 到 meta-story.events）。
 * 与 beginRound 配对使用：beginRound 读当前轮数，audit 跑完后调此函数落盘。
 * 对测试也有用：不依赖真实 audit 流程即可模拟 round 递增。
 */
export function recordRound(store: StoryStore, round: number, storyId: string = META_STORY_ID): void {
  const story = store.readStory(storyId);
  if (!story.events) story.events = [];
  const event: StoryEvent = {
    phase: 'META',
    action: 'advance',
    timestamp: new Date().toISOString(),
    agent: 'koala-audit',
    reason: `framework audit round ${round}`,
  };
  story.events.push(event);
  store.writeStory(storyId, story);
}

/**
 * upsertDrift:
 *   - hash 已存在于 findings → 更新 lastSeenAt + reviewRound（标识本轮仍漂移），status 保持 open；
 *     若之前 auto-resolved 过（status=resolved）则重置为 open（drift 又回来了）。
 *   - hash 不存在 → 调 finding_add 路径，创建带签名 finding。
 *
 * 返回 {state, driftHash, findingId}，state='new' 或 'still-drifting'。
 * 'resolved-by-nature' 状态由 autoResolveMissing 产出，不在此函数的返回里。
 */
export function upsertDrift(
  store: StoryStore,
  round: number,
  drift: DriftInput,
  storyId: string = META_STORY_ID,
): UpsertResult {
  const hash = driftHash(drift.sectionPath, drift.symbol, drift.driftType);
  const data = store.readFindings(storyId);
  const now = new Date().toISOString();
  const roundStr = String(round);

  const existing = data.findings.find(f => f.driftHash === hash);
  if (existing) {
    existing.lastSeenAt = now;
    existing.reviewRound = roundStr;
    // drift 又回来了：之前 auto-resolved 的重新开
    if (existing.status === 'resolved') {
      existing.status = 'open';
    }
    store.writeFindings(storyId, data);
    return { state: 'still-drifting', driftHash: hash, findingId: existing.id };
  }

  // 新 finding：走 finding_add 签名路径
  const nextNum = data.findings.length + 1;
  const id = `${storyId}:F-${String(nextNum).padStart(3, '0')}`;
  const finding: Finding = {
    id,
    desc: drift.desc,
    severity: drift.severity,
    category: 'missing', // audit drift 本质是「承诺 vs 实际」缺失，归 missing 类
    status: 'open',
    agent: 'koala-audit',
    createdAt: now,
    reviewRound: roundStr,
    _hash: signFinding(storyId, id, drift.desc, drift.severity, now, roundStr),
    driftHash: hash,
    lastSeenAt: now,
    firstSeenRound: round,
  };
  data.findings.push(finding);
  store.writeFindings(storyId, data);
  return { state: 'new', driftHash: hash, findingId: id };
}

/**
 * autoResolveMissing: 上一轮存在（状态 open）、本轮传入 seen set 里缺失的 finding → 批量 auto-resolve。
 * reason = "drift cleared at round ${round}"。
 *
 * 判定「上一轮存在」的依据：finding.reviewRound < round（即不是本轮刚更新的）且 status=open 且有 driftHash。
 * 只 resolve audit finding（有 driftHash 字段），普通 finding 不受影响。
 */
export function autoResolveMissing(
  store: StoryStore,
  round: number,
  seenHashes: Set<string>,
  storyId: string = META_STORY_ID,
): string[] {
  const data = store.readFindings(storyId);
  const now = new Date().toISOString();
  const resolved: string[] = [];
  const roundStr = String(round);

  for (const f of data.findings) {
    if (!f.driftHash) continue; // 不是 audit finding
    if (f.status !== 'open') continue;
    if (seenHashes.has(f.driftHash)) continue; // 本轮仍然出现
    // 显式检查 reviewRound 字段存在性：缺失/null/undefined 视为老式数据，
    // 保守不 resolve 以免误伤（F-021）。本轮 roundStr 相等则跳过（本轮刚新建/更新）。
    if (f.reviewRound == null) continue;
    if (f.reviewRound === roundStr) continue;
    f.status = 'resolved';
    f.resolvedReason = `drift cleared at round ${round}`;
    f.resolvedAt = now;
    resolved.push(f.id);
  }
  if (resolved.length > 0) {
    store.writeFindings(storyId, data);
  }
  return resolved;
}

/**
 * B-3fad CHK-002: 人工框架 gap 归档入口（gap_log handler 调用）。
 *
 * 与 upsertDrift（机械 audit scan 写入）平行的「人工补录」路径：
 *   - upsertDrift: 机械 scan 确定 drift，可 verified，按 driftHash 幂等去重；
 *   - appendGapFinding: 人工发现的框架 gap，默认 suspected（未经机械确认），无 driftHash。
 *
 * 复用 audit-meta-store 的存储路径（B-META findings.json），不造平行存储。
 * 调用方负责先做 ensureMetaStory(store) bootstrap 容器（gap_log handler 已做）。
 *
 * evidenceState 护栏：默认 suspected；只有调用方已校验存在结构化 evidence 字段
 * 才允许传 verified —— 本函数原样信任入参的 evidenceState（runtime 降级校验在
 * gap-log.ts handler 入口完成，与 CLAUDE.md「Handler 编码约定」一致）。
 */
export interface GapFindingInput {
  /** finding 分类（happy/edge/adversarial/missing） */
  category: Finding['category'];
  /** 严重度 */
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** gap 描述（已 trim 非空，由 handler 校验） */
  desc: string;
  /** 证据状态：默认 suspected；verified 仅当 handler 已校验结构化 evidence */
  evidenceState: FindingEvidenceState;
  /** suspected 时填：为什么只是怀疑 */
  uncertaintyReason?: string;
  /** disproven 时填：反证摘要 + 命令 + 源码引用 */
  disprovenEvidence?: DisprovenEvidence;
  /** 关联文件路径（来源溯源用） */
  files?: string[];
  /** 记录调用者身份（审计字段，不入签名） */
  agent?: string;
}

export interface GapFindingResult {
  findingId: string;
  evidenceState: FindingEvidenceState;
}

export function appendGapFinding(
  store: StoryStore,
  gap: GapFindingInput,
  storyId: string = META_STORY_ID,
): GapFindingResult {
  const data = store.readFindings(storyId);
  const now = new Date().toISOString();
  const nextNum = data.findings.length + 1;
  const id = `${storyId}:F-${String(nextNum).padStart(3, '0')}`;
  const finding: Finding = {
    id,
    desc: gap.desc,
    severity: gap.severity,
    category: gap.category,
    status: 'open',
    evidenceState: gap.evidenceState,
    ...(gap.uncertaintyReason ? { uncertaintyReason: gap.uncertaintyReason } : {}),
    ...(gap.disprovenEvidence ? { disprovenEvidence: gap.disprovenEvidence } : {}),
    agent: gap.agent || 'koala-gap-log',
    createdAt: now,
    reviewRound: '',
    _hash: signFinding(storyId, id, gap.desc, gap.severity, now, ''),
    ...(gap.files && gap.files.length > 0 ? { files: gap.files } : {}),
  };
  data.findings.push(finding);
  store.writeFindings(storyId, data);
  return { findingId: id, evidenceState: gap.evidenceState };
}
