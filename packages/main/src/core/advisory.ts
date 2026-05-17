/**
 * B-e8c8 CHK-007: 轮次递减 advisory 规则（共享函数）
 *
 * REVIEW 阶段 finding 的 blocking 严重级别随 Round 递减：
 *   - Round 1: critical + high + medium 为 blocking；low 始终 advisory（policy 的
 *     effectiveBlockingSeverities 从不含 low，让 low 在 Round 1 返 false 会误导
 *     finding_list 把 low 归到 Blocking 分组里，与 gate 实际行为不一致）
 *   - Round 2: medium 降为 advisory；critical + high 仍 blocking；low 仍 advisory
 *   - Round 3+: high 降为 advisory；critical 仍 blocking（critical 永远 blocking）
 *
 * 该函数由 handlers/finding.ts（finding_list 打标签）和 core/machine.ts
 * （canPassReview gate 判断是否跳过 blocker 计算）共用，避免两处各写一份硬编码。
 */
import type { StoryStore } from './store.js';
import type { Finding, FindingEvidenceState, StoryEvent } from './types.js';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * B-3fad CHK-001: 合法 evidenceState 取值集合。
 * handler runtime / gate 消费点都要按此集合校验（不只靠 Zod，见 CLAUDE.md「Handler 编码约定」）。
 */
export const FINDING_EVIDENCE_STATES: readonly FindingEvidenceState[] = ['suspected', 'verified', 'disproven'] as const;

/** B-3fad CHK-001: runtime narrow，拒非法 evidenceState 字符串。 */
export function isFindingEvidenceState(value: unknown): value is FindingEvidenceState {
  return typeof value === 'string' && (FINDING_EVIDENCE_STATES as readonly string[]).includes(value);
}

/**
 * B-3fad CHK-001: REVIEW→TEST gate blocking 判定的 evidenceState 维度。
 *
 * 一条 finding 只有 evidenceState 为 'verified'（或字段缺失 = legacy 兼容视同 verified）
 * 才可能阻塞 REVIEW→TEST。'suspected' / 'disproven' 一律不阻塞（suspected 只 advisory，
 * disproven 已被反证）。非法字符串保守视同非 verified（不阻塞，避免污染 gate）。
 *
 * 完整 gate predicate（machine.ts canPassReview / guard-utils.ts）：
 *   status === 'open'
 *   && severity ∈ {critical,high}（来自 effectiveBlockingSeverities）
 *   && isEvidenceStateBlocking(evidenceState)
 *   && !isAdvisoryThisRound(severity, round)
 */
export function isEvidenceStateBlocking(evidenceState: FindingEvidenceState | string | undefined | null): boolean {
  if (evidenceState == null) return true; // legacy finding 缺字段 → 视同 verified
  return evidenceState === 'verified';
}

/**
 * B-3fad CHK-001: 完整的「这条 finding 是否阻塞 REVIEW→TEST」判定。
 * effectiveBlockingSeverities 由调用方按 round decay 解析后传入。
 */
export function isFindingBlocking(
  finding: Pick<Finding, 'status' | 'severity' | 'evidenceState'>,
  effectiveBlockingSeverities: readonly string[],
  round: number,
): boolean {
  return finding.status === 'open'
    && effectiveBlockingSeverities.includes(finding.severity)
    && isEvidenceStateBlocking(finding.evidenceState)
    && !isAdvisoryThisRound(finding.severity, round);
}

/**
 * 判断某个 severity 的 finding 在当前 round 是否为 advisory（不 blocking）。
 * critical 永远返回 false（任何轮次都 blocking）。
 * low 永远返回 true（policy.blockingSeverities 从不含 low，low 从不 blocking）。
 */
export function isAdvisoryThisRound(severity: FindingSeverity | string, round: number): boolean {
  if (severity === 'critical') return false;
  // low 从不 blocking：policy.review.blockingSeverities 在任何 profile 都不含 low，
  // 所以 low 在所有 round 都按 advisory 归组，避免 finding_list 把 low 错挂到 Blocking。
  if (severity === 'low') return true;
  if (round >= 3) {
    // Round 3+: high 与 medium 降为 advisory
    return severity === 'high' || severity === 'medium';
  }
  if (round >= 2) {
    // Round 2: medium 降为 advisory
    return severity === 'medium';
  }
  // Round 1: critical/high/medium 全 blocking（low 已在上面短路）
  return false;
}

/**
 * 给出 Round N 的 advisory 标签文本（如 "R2-ADVISORY"），Round 1 或 critical 返回 null。
 */
export function advisoryLabelFor(severity: FindingSeverity | string, round: number): string | null {
  if (!isAdvisoryThisRound(severity, round)) return null;
  return `R${round}-ADVISORY`;
}

/**
 * 从 story.events 推导当前 REVIEW roundCount。
 * 与 machine.ts 的 resolveEffectiveBlockingSeverities 保持同源：
 *   roundCount = events 中 phase==='REVIEW' && action==='advance' 的条目数，
 *   无匹配时默认 1（避免除零 / 首轮边界）。
 *
 * 依据：handlers/transition-orchestrator.ts 在 DEV→REVIEW（以及 REVIEW 回退后再推进）时
 * 调用 collectContext('REVIEW', 'advance') 写入 events（见 handlers/context.ts
 * 的 collectContext 签名 `action: 'create' | 'advance' | 'discard'` + transition-orchestrator
 * 里 story.events.push(collectContext(args.phase, 'advance'))）。因此
 * phase==='REVIEW' && action==='advance' 恰好匹配每次进入 REVIEW 的那次事件。
 */
export function resolveReviewRoundCount(store: StoryStore, storyId: string): number {
  try {
    const story = store.readStory(storyId);
    if (story.events) {
      const reviewEntries = story.events.filter(
        (e: StoryEvent) => e.phase === 'REVIEW' && e.action === 'advance',
      );
      return reviewEntries.length || 1;
    }
  } catch { /* fallback */ }
  return 1;
}
