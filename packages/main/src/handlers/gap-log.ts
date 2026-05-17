/**
 * B-3fad CHK-002: gap_log — 框架 gap 手动归档入口。
 *
 * 触发背景（background.md）：B-a370 收尾时主 agent 想把发现的 koala 框架 gap 归档进
 * framework-audit backlog，却发现 (1) B-META-framework-audit 容器不存在，(2) 现有
 * finding_add 是 reviewer-finding 形状（要 reviewRunId / REVIEW-phase 语义），拿来塞
 * 人工框架 gap 是滥用。gap_log 补这个缺口：一个不依赖 reviewer / review round /
 * story worktree 的手动归档入口。
 *
 * 设计要点：
 * - 必填 category / severity / evidence note(desc) / source（sourceRefs 等其一）：缺一不可，
 *   防 B-META 变垃圾桶（understanding.constraints）。
 * - 默认 evidenceState=suspected：人工补录未经机械确认，只能是怀疑（继承 bug 通道证据纪律）。
 * - verified 护栏：只有同时提供结构化 evidence 字段（sourceRefs / reproCommand /
 *   observedOutput / analysisNote 之一或多个）才允许 verified；否则即使传 verified 也强制
 *   降回 suspected（不能直接造一个 confirmed 结论）。
 * - 写入 B-META-framework-audit 容器（不存在则 ensureMetaStory bootstrap），复用
 *   audit-meta-store 的 findings.json 存储路径，不造平行存储。
 * - 不要求 story worktree、不参与 lifecycle gate（写的是长存容器，不是 active story）。
 *
 * 三层校验（CLAUDE.md「Handler 编码约定」）：
 * - Zod schema（cli-engine.ts）：category enum / severity enum / desc.min(1) 第一道防线。
 * - runtime（本 handler 入口）：再校验 desc trim 非空、source 至少一个、verified 护栏，
 *   防绕过 Zod 的内部 fn / 老 JSON 调用路径。
 * - 消费点（audit-meta-store.appendGapFinding）：原样信任已校验的入参。
 */

import type { HandlerContext } from './context.js';
import type { DisprovenEvidence, Finding, FindingEvidenceState } from '../core/types.js';
import { ensureMetaStory, appendGapFinding, META_STORY_ID } from '../core/audit-meta-store.js';

const GAP_LOG_CATEGORIES = ['happy', 'edge', 'adversarial', 'missing'] as const;
const GAP_LOG_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

/** runtime narrow：拒非法 category（不只靠 Zod）。 */
function isGapLogCategory(value: unknown): value is Finding['category'] {
  return typeof value === 'string' && (GAP_LOG_CATEGORIES as readonly string[]).includes(value);
}

/** runtime narrow：拒非法 severity（不只靠 Zod）。 */
function isGapLogSeverity(value: unknown): value is Finding['severity'] {
  return typeof value === 'string' && (GAP_LOG_SEVERITIES as readonly string[]).includes(value);
}

/**
 * 把入参里的结构化 evidence 字段归一化。
 * 返回非空数组里任意元素存在即视为「提供了结构化 evidence」（verified 护栏的判定依据）。
 */
function collectStructuredEvidence(args: {
  sourceRefs?: string[];
  reproCommand?: string;
  observedOutput?: string;
  analysisNote?: string;
}): {
  sourceRefs: string[];
  reproCommand?: string;
  observedOutput?: string;
  analysisNote?: string;
  hasAny: boolean;
} {
  const sourceRefs = Array.isArray(args.sourceRefs)
    ? args.sourceRefs.map(r => String(r ?? '').trim()).filter(r => r.length > 0)
    : [];
  const reproCommand = (args.reproCommand ?? '').trim() || undefined;
  const observedOutput = (args.observedOutput ?? '').trim() || undefined;
  const analysisNote = (args.analysisNote ?? '').trim() || undefined;
  const hasAny = sourceRefs.length > 0 || !!reproCommand || !!observedOutput || !!analysisNote;
  return { sourceRefs, reproCommand, observedOutput, analysisNote, hasAny };
}

export function createGapLogHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store } = ctx;
  return {
    /**
     * gap_log: 把一个人工发现的框架 gap 归档进 B-META-framework-audit。
     *
     * 必填：category / severity / evidence（gap 描述，即 desc）/ source（sourceRefs 等其一）。
     * 默认 evidenceState=suspected；verified 需配套结构化 evidence。
     */
    gap_log(args: {
      category?: string;
      severity?: string;
      /** gap 的 evidence note —— 即 finding 描述 */
      evidence?: string;
      sourceRefs?: string[];
      reproCommand?: string;
      observedOutput?: string;
      analysisNote?: string;
      evidenceState?: string;
      uncertaintyReason?: string;
      files?: string[];
      agent?: string;
    } = {}): string {
      // 1) category 必填 + runtime enum 校验
      if (!isGapLogCategory(args.category)) {
        throw new Error(
          `gap_log: category 必填且必须是 ${GAP_LOG_CATEGORIES.join('|')} 之一（防 B-META 变垃圾桶）`,
        );
      }
      // 2) severity 必填 + runtime enum 校验
      if (!isGapLogSeverity(args.severity)) {
        throw new Error(
          `gap_log: severity 必填且必须是 ${GAP_LOG_SEVERITIES.join('|')} 之一`,
        );
      }
      // 3) evidence note（desc）必填，trim 后非空（空串 / 纯空白拒绝）
      const desc = (args.evidence ?? '').trim();
      if (desc.length < 1) {
        throw new Error(
          'gap_log: evidence 必填且 trim 后 ≥ 1 字符（描述这个框架 gap 是什么）',
        );
      }
      // 4) source 必填：sourceRefs / reproCommand / observedOutput / analysisNote 至少一个
      const ev = collectStructuredEvidence(args);
      if (!ev.hasAny) {
        throw new Error(
          'gap_log: source 必填 —— sourceRefs / reproCommand / observedOutput / analysisNote ' +
          '至少提供一个，说明这个 gap 是从哪观察到的（防无来源的空 finding）',
        );
      }

      // 5) evidenceState 解析 + verified 护栏。
      //    默认 suspected。verified 护栏：只有同时提供结构化 evidence 字段
      //    （sourceRefs / reproCommand / observedOutput / analysisNote 之一或多个）才允许 verified。
      //    该护栏由两道防线共同保证 verified-without-evidence 在结构上不可能发生：
      //      (a) 上面 step 4 的 source 必填 gate（ev.hasAny 为 false 直接抛错）；
      //      (b) 本步 verified 分支再独立判 ev.hasAny —— 即使未来 source gate 放宽，
      //          护栏仍自洽：无结构化 evidence 一律强制降回 suspected。
      const rawState = (args.evidenceState ?? '').trim();
      let evidenceState: FindingEvidenceState = 'suspected';
      let downgraded = false;
      if (rawState === 'verified') {
        if (ev.hasAny) {
          evidenceState = 'verified';
        } else {
          // 防御性分支：当前被 step 4 的 source gate 抢先拦截而不可达；
          // 若 source gate 未来放宽，此处仍把无证据的 verified 请求降回 suspected。
          evidenceState = 'suspected';
          downgraded = true;
        }
      } else if (rawState === 'disproven') {
        // gap_log 是「归档新发现的 gap」入口，不接受直接登记 disproven（反证应走 finding 流程）。
        throw new Error(
          'gap_log: evidenceState 只接受 suspected / verified；disproven 反证请走 finding 流程',
        );
      } else if (rawState !== '' && rawState !== 'suspected') {
        throw new Error(
          `gap_log: evidenceState 非法值 "${rawState}"，只接受 suspected / verified`,
        );
      }
      // rawState === '' 或 'suspected' → 默认 suspected

      // 6) suspected 需要 uncertaintyReason（与 finding_add 同口径，防把 suspected 当随手按钮）。
      //    gap_log 默认 suspected，所以这里给一个兜底 reason，避免人工补录因缺字段被卡。
      let uncertaintyReason: string | undefined;
      if (evidenceState === 'suspected') {
        const reason = (args.uncertaintyReason ?? '').trim();
        uncertaintyReason = reason.length >= 10
          ? reason
          : 'manually logged framework gap; not yet mechanically reproduced or confirmed';
      }

      // 7) 组装 disprovenEvidence 不适用（gap_log 不收 disproven）。
      const disprovenEvidence: DisprovenEvidence | undefined = undefined;

      // 8) ensureMetaStory bootstrap 容器（不存在则建），写入 B-META findings。
      const { created } = ensureMetaStory(store);
      const result = appendGapFinding(store, {
        category: args.category,
        severity: args.severity,
        desc,
        evidenceState,
        ...(uncertaintyReason ? { uncertaintyReason } : {}),
        ...(disprovenEvidence ? { disprovenEvidence } : {}),
        ...(ev.sourceRefs.length > 0 ? { files: ev.sourceRefs } : {}),
        ...(Array.isArray(args.files) && args.files.length > 0 ? { files: args.files } : {}),
        agent: args.agent || process.env.KOALA_AGENT || 'koala-gap-log',
      });

      const bootstrapHint = created
        ? `\n→ ${META_STORY_ID} 容器不存在，已自动 bootstrap。`
        : '';
      const downgradeHint = downgraded
        ? '\n⚠ 请求 verified 但未提供结构化 evidence，已强制降回 suspected。'
        : '';
      const srcParts: string[] = [];
      if (ev.sourceRefs.length > 0) srcParts.push(`sourceRefs=${ev.sourceRefs.length}`);
      if (ev.reproCommand) srcParts.push('reproCommand');
      if (ev.observedOutput) srcParts.push('observedOutput');
      if (ev.analysisNote) srcParts.push('analysisNote');
      return (
        `Gap logged: ${result.findingId} ` +
        `(evidenceState=${result.evidenceState}, severity=${args.severity}, category=${args.category}; ` +
        `source: ${srcParts.join(', ')})` +
        bootstrapHint + downgradeHint
      );
    },
  };
}
