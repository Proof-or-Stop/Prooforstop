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
import type { Finding, FindingEvidenceState } from '../core/types.js';
import { ensureMetaStory, appendGapFinding, META_STORY_ID } from '../core/audit-meta-store.js';
import { withReentrantMainWriteLock } from '../core/main-write-lock.js';
import { resolveMainRepoRoot } from '../core/partial-done-recovery.js';

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
      // Capture the runtime-narrowed values into local consts: the type guards
      // above narrow `args.category` / `args.severity` here, but TS widens a
      // captured *mutable property* back to `string` inside the closure below.
      const category: Finding['category'] = args.category;
      const severity: Finding['severity'] = args.severity;
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

      // 7) 合并 finding.files：sourceRefs（结构化 evidence 引用）与显式 files 参数都保留。
      //    F-003：旧实现两个 spread 同写 `files` 键，后者静默覆盖前者 → sourceRefs 丢失。
      //    改为合并去重，让 stored finding 同时携带两个来源的路径。
      const argFiles = Array.isArray(args.files)
        ? args.files.map(f => String(f ?? '').trim()).filter(f => f.length > 0)
        : [];
      const mergedFiles = Array.from(new Set([...ev.sourceRefs, ...argFiles]));

      // 8) ensureMetaStory bootstrap 容器（不存在则建）+ 写入 B-META findings。
      //    B-f60c CHK-003: gap_log 写共享 main / B-META 状态，必须在 main write
      //    lock 内串行化（session-ownership-and-write-leases.md Rule 5）。
      //    临界区 = ensureMetaStory（bootstrap 容器）+ appendGapFinding（去重 +
      //    append）—— 二者都写 B-META，必须原子。
      //    用 *reentrant* 变体：gap_log 当前不会嵌套在另一个持锁命令里，但若将来
      //    某条持锁命令内部调 gap_log（如 audit 归档自身发现的 gap），reentrant
      //    保证不自死锁。同进程已持锁 → pass-through 直接跑临界区。
      //    锁路径解析到 main repo root（gap_log 通常从项目根跑，但 resolveMainRepoRoot
      //    对 worktree 子目录也能正确回退到主仓根）。
      const mainRepoRoot = resolveMainRepoRoot(ctx.root);
      const { created, result } = withReentrantMainWriteLock(mainRepoRoot, () => {
        const ensured = ensureMetaStory(store);
        const appended = appendGapFinding(store, {
          category,
          severity,
          desc,
          evidenceState,
          ...(uncertaintyReason ? { uncertaintyReason } : {}),
          ...(mergedFiles.length > 0 ? { files: mergedFiles } : {}),
          ...(ev.reproCommand ? { reproCommand: ev.reproCommand } : {}),
          ...(ev.observedOutput ? { observedOutput: ev.observedOutput } : {}),
          ...(ev.analysisNote ? { analysisNote: ev.analysisNote } : {}),
          agent: args.agent || process.env.KOALA_AGENT || 'koala-gap-log',
        });
        return { created: ensured.created, result: appended };
      }, {
        // gap_log is a sub-second critical section. Concurrent callers must
        // SERIALIZE-AND-WAIT so a racing duplicate is caught by the in-lock
        // idempotency dedup (→ one canonical finding) instead of fail-fasting
        // with a contention error. Waiting still honors Rule 6 — the caller
        // never proceeds without the lock.
        label: 'gap_log',
        onContention: 'wait',
      });

      const bootstrapHint = created
        ? `\n→ ${META_STORY_ID} 容器不存在，已自动 bootstrap。`
        : '';
      const downgradeHint = downgraded
        ? '\n⚠ 请求 verified 但未提供结构化 evidence，已强制降回 suspected。'
        : '';
      // B-f60c CHK-003: when the gap fingerprint matched an existing OPEN
      // finding, no new finding was written — surface the dedup so the operator
      // knows the canonical finding was reused, not duplicated.
      const dedupHint = result.deduped
        ? `\n→ 相同 gap 已存在（fingerprint 命中），复用 canonical finding ${result.findingId}，未新建。`
        : '';
      const srcParts: string[] = [];
      if (ev.sourceRefs.length > 0) srcParts.push(`sourceRefs=${ev.sourceRefs.length}`);
      if (ev.reproCommand) srcParts.push('reproCommand');
      if (ev.observedOutput) srcParts.push('observedOutput');
      if (ev.analysisNote) srcParts.push('analysisNote');
      const verb = result.deduped ? 'Gap deduped' : 'Gap logged';
      return (
        `${verb}: ${result.findingId} ` +
        `(evidenceState=${result.evidenceState}, severity=${args.severity}, category=${args.category}; ` +
        `source: ${srcParts.join(', ')})` +
        bootstrapHint + downgradeHint + dedupHint
      );
    },
  };
}
