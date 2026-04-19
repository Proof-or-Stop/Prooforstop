/**
 * @task B-727f
 * @checklist CHK-002
 * @title story_review encodes Agent B adversarial review and checklist split quality
 * @type feature
 * @priority high
 * @description
 *   Agent B 负责审查 testIntent 完整性，而不是让 Agent A 自己审自己。
 *   story_review 在实现层承担这条职责：检查每个 checklist item 是否具备
 *   happy/edge/adversarial 三栏、是否遗漏交叉场景，以及 checklist item 是否
 *   同时满足“可观测结果 + 明确触发输入 + 三栏可填满”的拆解标准。
 * @changes
 *   - [CHK-002] 用独立 reviewer 检查 testIntent 完整性，覆盖 Agent A/B 分工
 *   - [CHK-002] 用 split_quality / cross_scenario / weak_intent 规则实现需求完整性的多层防线与 item 拆解标准
 */

import type { HandlerContext } from './context.js';
import { loadConfig } from '../core/config.js';
import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import type { StoryInfo } from '../core/types.js';
import { summarizeParallelPolicy } from '../core/parallel-policy.js';
import { getArtifactContractStatus } from '../core/artifact-contract.js';

function outcomeLooksAbstract(outcome: string): boolean {
  const text = outcome.trim();
  if (text.length < 100) return true;
  const abstractTerms = ['链路', '事件', '机制', '闭环', '打通', '触发', '状态', '流程'];
  const hits = abstractTerms.filter((term) => text.includes(term)).length;
  const transcriptSignals = ['>', '>>>', '[', '✓', '选项', '你选', '完成', 'Resume:', 'Next step'];
  const transcriptLike = transcriptSignals.some((sig) => text.includes(sig));
  return hits >= 2 && !transcriptLike;
}

export function createStoryReviewHandlers(ctx: HandlerContext) {
  const { store } = ctx;

  return {
    story_review(args: { storyId: string }): object {
      const story = store.readStory(args.storyId);
      const cl = store.readChecklist(args.storyId);
      const storiesById = new Map<string, StoryInfo>();
      for (const storyId of store.listStoryIds()) {
        try {
          storiesById.set(storyId, store.readStory(storyId));
        } catch { /* skip unreadable */ }
      }
      const parallelPolicy = summarizeParallelPolicy(story, storiesById);

      // 读取真相源
      const config = loadConfig(ctx.root);
      const reqDir = join(ctx.root, config.requirementsDir);
      const truthDocs: string[] = [];
      if (existsSync(reqDir)) {
        const scanDir = (dir: string) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) { scanDir(join(dir, entry.name)); continue; }
            if (entry.name.endsWith('.md')) {
              truthDocs.push(readFileSync(join(dir, entry.name), 'utf-8'));
            }
          }
        };
        scanDir(reqDir);
      }

      const issues: Array<{ type: string; severity: 'blocker' | 'advisory'; itemId?: string; message: string }> = [];

      // 0. checklist 拆分质量静态检查
      // 0.1 数量异常
      if (cl.items.length === 0) {
        issues.push({ type: 'split_quality', severity: 'blocker', message: 'checklist 为空' });
      } else if (cl.items.length > 15) {
        issues.push({ type: 'split_quality', severity: 'advisory', message: `checklist 项数过多 (${cl.items.length})，可能存在过碎的拆分，建议合并相关 item` });
      }
      // 0.2 title/context 质量
      for (const item of cl.items) {
        if (!item.title || item.title.trim().length < 4) {
          issues.push({ type: 'split_quality', severity: 'blocker', itemId: item.id, message: `${item.id} title 过短或缺失` });
        }
        if (!(item as any).context || (item as any).context.trim().length < 8) {
          issues.push({ type: 'split_quality', severity: 'advisory', itemId: item.id, message: `${item.id} 缺少 context（根因/参考方案）` });
        }
      }
      // 0.3 颗粒度一致性：title 长度差异过大可能表示颗粒度不一致
      if (cl.items.length >= 3) {
        const titleLens = cl.items.map(i => (i.title || '').length);
        const avg = titleLens.reduce((a, b) => a + b, 0) / titleLens.length;
        const maxDiff = Math.max(...titleLens) - Math.min(...titleLens);
        if (avg > 0 && maxDiff > avg * 2) {
          issues.push({
            type: 'split_quality',
            severity: 'advisory',
            message: `checklist item 颗粒度可能不一致（title 长度差异较大: ${Math.min(...titleLens)}~${Math.max(...titleLens)}），请检查是否需要拆分/合并`,
          });
        }
      }

      // B-0af4 CHK-002: trivial-story 模式 — priority=low + <=1 item + type 在
      // [chore, refactor, docs]。这类 story 跳过 testIntent 的 blocker 门禁（降级
      // 为 advisory），与 machine.ts 的 PLAN→DEV guard 保持一致。
      const trivialTypes = ['chore', 'refactor', 'docs'];
      const isTrivial =
        (story as any)?.priority === 'low' &&
        cl.items.length <= 1 &&
        trivialTypes.includes((story as any)?.type);
      const intentSeverity: 'blocker' | 'advisory' = isTrivial ? 'advisory' : 'blocker';

      // 1. 检查每个 item 是否有 testIntent（happy 必填，edge/adversarial 选填但建议补全）
      for (const item of cl.items) {
        if (item.testIntent === null) continue; // 标记为不可自动化测试，跳过
        if (!item.testIntent) {
          issues.push({ type: 'missing_intent', severity: intentSeverity, itemId: item.id, message: `${item.id}「${item.title}」缺少 testIntent${isTrivial ? '（trivial-story 降级为 advisory）' : ''}` });
          continue;
        }
        if (!item.testIntent.happy || item.testIntent.happy.length === 0) {
          issues.push({ type: 'weak_intent', severity: intentSeverity, itemId: item.id, message: `${item.id} happy 栏为空${isTrivial ? '（trivial-story 降级为 advisory）' : '（必填）'}` });
        }
        if (!item.testIntent.edge || item.testIntent.edge.length === 0) {
          issues.push({ type: 'weak_intent', severity: 'advisory', itemId: item.id, message: `${item.id} edge 栏为空（建议补全）` });
        }
        if (!item.testIntent.adversarial || item.testIntent.adversarial.length === 0) {
          issues.push({ type: 'weak_intent', severity: 'advisory', itemId: item.id, message: `${item.id} adversarial 栏为空（建议补全）` });
        }
      }

      // 2. intent-case 覆盖率报告
      const config2 = loadConfig(ctx.root);
      const fixturesDir2 = join(ctx.root, config2.fixturesDir);
      const allIntentRefs = new Set<string>();
      if (existsSync(fixturesDir2)) {
        const scanFixtures = (dir: string) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) { scanFixtures(join(dir, entry.name)); continue; }
            if (!entry.name.endsWith('.json')) continue;
            try {
              const content = JSON.parse(readFileSync(join(dir, entry.name), 'utf-8'));
              for (const c of content.cases || []) {
                if (c.intentRef && typeof c.intentRef === 'string') {
                  allIntentRefs.add(c.intentRef);
                }
              }
            } catch { /* ignore */ }
          }
        };
        scanFixtures(fixturesDir2);
      }

      const intentCoverage: Array<{ itemId: string; lane: string; index: number; text: string; covered: boolean }> = [];
      for (const item of cl.items) {
        if (!item.testIntent) continue;
        for (const lane of ['happy', 'edge', 'adversarial'] as const) {
          const entries = item.testIntent[lane] || [];
          for (let i = 0; i < entries.length; i++) {
            const ref = `${item.id}:${lane}:${i}`;
            const entry = entries[i];
            const text = typeof entry === 'string' ? entry : (entry as { desc: string }).desc;
            intentCoverage.push({
              itemId: item.id,
              lane,
              index: i,
              text,
              covered: allIntentRefs.has(ref),
            });
          }
        }
      }

      const coveredCount = intentCoverage.filter(c => c.covered).length;
      const totalIntentEntries = intentCoverage.length;
      const coveragePct = totalIntentEntries > 0 ? Math.round(coveredCount / totalIntentEntries * 100) : 100;

      // 3. 检查 item 之间的交叉场景
      if (cl.items.length >= 2) {
        const crossPairs: Array<[string, string]> = [];
        for (let i = 0; i < cl.items.length; i++) {
          for (let j = i + 1; j < cl.items.length; j++) {
            crossPairs.push([cl.items[i].id, cl.items[j].id]);
          }
        }
        // 检查是否有任何 testIntent 提到了其他 item 的关键词（简单文本匹配）
        const extractText = (e: string | { desc: string }) => typeof e === 'string' ? e : e.desc;

        if (crossPairs.length > 0 && cl.items.every(i => i.testIntent)) {
          // 如果没有任何 intent 文本引用其他 item 的关键词，提示可能遗漏交叉场景
          let hasCrossRef = false;
          for (const item of cl.items) {
            if (!item.testIntent) continue;
            const texts = [
              ...(item.testIntent.happy || []).map(extractText),
              ...(item.testIntent.edge || []).map(extractText),
              ...(item.testIntent.adversarial || []).map(extractText),
            ].join(' ');
            for (const other of cl.items) {
              if (other.id === item.id) continue;
              // 从 title 提取关键词（去掉常见虚词）
              const keywords = other.title.split(/[\s,，、]+/).filter(w => w.length > 1);
              if (keywords.some(kw => texts.includes(kw))) { hasCrossRef = true; break; }
            }
            if (hasCrossRef) break;
          }
          if (!hasCrossRef) {
            issues.push({
              type: 'cross_scenario',
              severity: 'advisory',
              message: `${cl.items.length} 个 checklist item 的 testIntent 之间没有交叉引用，可能遗漏组合场景（如：${cl.items[0].title} + ${cl.items[1].title} 同时操作会怎样？）`,
            });
          }
        }
      }

      // 2.4. 高风险信号提示（OMX 风格，story_create 已自动打标）
      // B-5010 CHK-004: 过滤掉被主 agent 显式 dismiss 的 signal（误报白名单）
      const dismissedCats = new Set((story.riskSignalsDismissed || []).map((d: any) => d.category));
      const activeRiskSignals = (story.riskSignals || []).filter((r: any) => !dismissedCats.has(r.category));
      const isHighRisk = story.priority === 'high' || story.priority === 'critical'
        || activeRiskSignals.length > 0;
      if (activeRiskSignals.length > 0) {
        issues.push({
          type: 'risk_signals',
          severity: 'advisory',
          message: `story 命中 ${activeRiskSignals.length} 个高风险信号: ${activeRiskSignals.map((r: any) => r.category).join(', ')}。建议用更严格的审查标准（≥ 3 preMortem 场景、明确的回滚路径）`,
        });
      }

      // 2.43. Multi-session parallel policy（B-d307）：并行调度元数据和热点冲突提示
      if (!story.lane) {
        issues.push({
          type: 'parallel_policy_missing_lane',
          severity: 'advisory',
          message: `未声明 lane。当前默认会按 ${parallelPolicy.lane} 推断，但建议显式设置 mainline/supporting/exploratory，避免并行调度时主线判断漂移`,
        });
      }
      if (!story.parallelSafe) {
        issues.push({
          type: 'parallel_policy_missing_safety',
          severity: 'advisory',
          message: `未声明 parallelSafe。当前默认会按 ${parallelPolicy.safety} 推断，建议显式设置 yes/no/plan_only，让 session_brief 能稳定给出并行建议`,
        });
      }
      if ((story.phase === 'PLAN' || story.phase === 'DEV') && parallelPolicy.sharedHotspots.length === 0) {
        issues.push({
          type: 'parallel_policy_missing_hotspots',
          severity: 'advisory',
          message: 'sharedHotspots 为空。建议列出会争抢的核心文件或模块，便于 session_brief 提前提示冲突',
        });
      }
      if ((story.depends?.length ?? 0) > 0 && parallelPolicy.safety === 'yes') {
        issues.push({
          type: 'parallel_policy_depends_conflict',
          severity: 'advisory',
          message: `story 有 depends=${story.depends!.join(', ')}，但 parallelSafe=yes。通常更适合先标成 plan_only，避免下游 story 抢跑 DEV`,
        });
      }
      for (const conflict of parallelPolicy.conflicts) {
        issues.push({
          type: 'parallel_policy_conflict',
          severity: 'advisory',
          message: `并行风险：${conflict}`,
        });
      }
      if (dismissedCats.size > 0) {
        issues.push({
          type: 'risk_signals_dismissed',
          severity: 'advisory',
          message: `${dismissedCats.size} 个 risk signal 已被主 agent 驳回（理由见 story.riskSignalsDismissed）: ${Array.from(dismissedCats).join(', ')}`,
        });
      }

      // 2.45. RALPLAN-DR decision.json 检查（OMX ralplan 风格）
      const artifactContract = getArtifactContractStatus(args.storyId, store, story.phase);
      const decision = store.readDecision(args.storyId);
      if (!decision) {
        const contractDecision = artifactContract.entries.find((entry) => entry.key === 'decision');
        if (contractDecision?.required || contractDecision?.present === false) {
          issues.push({
            type: 'missing_decision',
            severity: isHighRisk ? 'blocker' : 'advisory',
            message: isHighRisk
              ? `高风险 story 必须填 decision.json (principles/drivers/options/chosen/≥3 preMortem)。调用: koala decision_set '{...}'`
              : '未填 decision.json。非高风险 story 可选，但建议补上以便 reviewer 审设计思路。',
          });
        }
      } else {
        // decision 已存在，检查质量
        if (decision.options.length < 2) {
          // 单 option 必须 cons 里有 invalidation rationale（decision_set 写入时已校验，这里兜底）
          const single = decision.options[0];
          if (!single.cons || single.cons.length === 0) {
            issues.push({
              type: 'missing_alternatives',
              severity: 'blocker',
              message: 'decision.options 只有 1 个且 cons 为空。OMX Critic 同款要求: 必须有 fair alternatives 或显式 invalidation rationale',
            });
          }
        }
        if (isHighRisk && (!decision.preMortem || decision.preMortem.length < 3)) {
          issues.push({
            type: 'insufficient_premortem',
            severity: 'blocker',
            message: `高风险 story 必须有 ≥ 3 个 preMortem 场景（当前: ${decision.preMortem?.length ?? 0}）`,
          });
        }
      }

      // 2.5. Pre-context Intake snapshot 检查（OMX 风格，软引入）
      const understanding = store.readUnderstanding(args.storyId);
      if (!understanding) {
        const contractUnderstanding = artifactContract.entries.find((entry) => entry.key === 'understanding');
        if (contractUnderstanding?.required || contractUnderstanding?.present === false) {
          issues.push({
            type: 'missing_understanding',
            severity: 'advisory',
            message: '未填 understanding snapshot。建议在拆 checklist 前先调用 understanding_set 落 task/outcome/facts/constraints/unknowns/touchpoints 6 个字段，避免理解错误后期修复贵',
          });
        }
      } else {
        if (understanding.unknowns.length > 0) {
          issues.push({
            type: 'unresolved_unknowns',
            severity: 'advisory',
            message: `understanding 还有 ${understanding.unknowns.length} 个未消化的 unknowns: ${understanding.unknowns.slice(0, 3).join('; ')}${understanding.unknowns.length > 3 ? '…' : ''}`,
          });
        }
        if (understanding.touchpoints.length === 0) {
          issues.push({
            type: 'empty_touchpoints',
            severity: 'advisory',
            message: 'understanding.touchpoints 为空。补一下能让 reviewer 了解影响范围',
          });
        }
        if (outcomeLooksAbstract(understanding.outcome || '')) {
          issues.push({
            type: 'weak_outcome_transcript',
            severity: 'advisory',
            message: 'understanding.outcome 看起来偏抽象，不像用户真正会看到的 transcript。建议改成具体终端/UI 文本，避免工程通过但用户仍然会问“然后呢？”',
          });
        }
      }

      // 3. 确保 issueCount > 0（审查必须产出至少一个 advisory）
      if (issues.length === 0) {
        issues.push({
          type: 'review_advisory',
          severity: 'advisory',
          message: '审查未发现 blocker，但建议对照 _reviewPrompt 中的真相源文档人工复核 testIntent 完整性',
        });
      }

      // 4. 统计
      const totalItems = cl.items.length;
      const withIntent = cl.items.filter(i => i.testIntent && i.testIntent !== null).length;
      const totalIntents = cl.items.reduce((sum, i) => {
        if (!i.testIntent || i.testIntent === null) return sum;
        return sum + (i.testIntent.happy?.length || 0) + (i.testIntent.edge?.length || 0) + (i.testIntent.adversarial?.length || 0);
      }, 0);
      const blockerCount = issues.filter(i => i.severity === 'blocker').length;
      const blockerTypes = Array.from(new Set(issues.filter(i => i.severity === 'blocker').map(i => i.type)));
      const advisoryTypes = Array.from(new Set(issues.filter(i => i.severity === 'advisory').map(i => i.type)));
      const missingIntentItems = issues
        .filter(i => i.type === 'missing_intent' || i.type === 'weak_intent')
        .map(i => i.itemId)
        .filter((id): id is string => Boolean(id));
      const blockingMissingIntentItems = issues
        .filter(i => i.severity === 'blocker' && (i.type === 'missing_intent' || i.type === 'weak_intent'))
        .map(i => i.itemId)
        .filter((id): id is string => Boolean(id));
      const nextFix = blockerCount > 0
        ? (blockingMissingIntentItems.length > 0
          ? `运行 koala testintent_handoff '{"storyId":"${args.storyId}"}'，把 prompt 交给 test-intent agent 补齐 ${Array.from(new Set(blockingMissingIntentItems)).join(', ')}，然后重新 story_review`
          : '修复 blocker 后重新 story_review')
        : (coveragePct < 100
          ? `补齐 fixture intentRef 覆盖后继续（当前 intent 覆盖率 ${coveragePct}%）`
          : '无 blocker，可进入 DEV；建议人工快速复核 advisory');
      const reviewPromptSummary = {
        hasUnderstanding: Boolean(understanding),
        hasDecision: Boolean(decision),
        hasPreMortem: Boolean(decision?.preMortem && decision.preMortem.length > 0),
        hasRiskSignals: activeRiskSignals.length > 0,
        truthDocsCount: truthDocs.length,
        checklistItems: totalItems,
        testIntentEntries: totalIntents,
        hasFullPrompt: truthDocs.length > 0 || Boolean(understanding) || Boolean(decision),
      };

      // 5. 写入 review.json（带签名，防止主 agent 伪造）
      const reviewData = store.readReview(args.storyId);
      const timestamp = new Date().toISOString();
      const reviewEntry = {
        timestamp,
        issueCount: issues.length,
        blockerCount,
        issues,
        _hash: '',
      };
      // 签名 = sha256(storyId + timestamp + issueCount + blockerCount + 固定盐)
      const REVIEW_SALT = 'koala-review-integrity-v1';
      const hashInput = `${args.storyId}:${timestamp}:${issues.length}:${blockerCount}:${REVIEW_SALT}`;
      reviewEntry._hash = createHash('sha256').update(hashInput).digest('hex');
      reviewData.reviews.push(reviewEntry);
      store.writeReview(args.storyId, reviewData);

      return {
        storyId: args.storyId,
        title: story.title,
        reviewRound: reviewData.reviews.length,
        summary: {
          totalItems,
          withIntent,
          withoutIntent: totalItems - withIntent,
          totalIntents,
          issueCount: issues.length,
          blockerCount,
          intentCoverage: {
            covered: coveredCount,
            total: totalIntentEntries,
            percentage: coveragePct,
          },
        },
        issues,
        actionSummary: {
          canEnterDev: blockerCount === 0,
          hasBlockers: blockerCount > 0,
          blockerTypes,
          advisoryTypes,
          missingIntentItems: Array.from(new Set(missingIntentItems)),
          nextFix,
        },
        reviewPromptSummary,
        intentCoverageDetail: intentCoverage.length > 0
          ? intentCoverage.filter(c => !c.covered).map(c => `${c.itemId}:${c.lane}:${c.index} → ${c.text}`)
          : undefined,
        truthDocsCount: truthDocs.length,
        _hint: blockerCount > 0
          ? (blockingMissingIntentItems.length > 0
            ? `第 ${reviewData.reviews.length} 轮审查发现 ${blockerCount} 个 blocker。下一步: koala testintent_handoff '{"storyId":"${args.storyId}"}'，交给 test-intent agent 后再次 story_review`
            : `第 ${reviewData.reviews.length} 轮审查发现 ${blockerCount} 个 blocker，请修复后再次 story_review`)
          : `✅ 第 ${reviewData.reviews.length} 轮审查通过（${blockerCount} blocker, ${issues.length} advisory）${coveragePct < 100 ? `，intent 覆盖率 ${coveragePct}%（${coveredCount}/${totalIntentEntries}）` : ''}，可进入开发`,
        _reviewPrompt: (() => {
          // 拼出完整 review prompt：truth docs + checklist/intent + understanding + decision
          // 让 reviewer 不光能审需求覆盖度，还能审"主 agent 是否真的理解了任务"和"为什么选这个设计"
          const understandingSection = understanding
            ? `\n---\nUnderstanding Snapshot:\n` +
              `task: ${understanding.task}\n` +
              `outcome: ${understanding.outcome}\n` +
              `facts:\n${understanding.facts.map((f: string) => `  - ${f}`).join('\n') || '  (none)'}\n` +
              `constraints:\n${understanding.constraints.map((c: string) => `  - ${c}`).join('\n') || '  (none)'}\n` +
              `unknowns:\n${understanding.unknowns.map((u: string) => `  - ${u}`).join('\n') || '  (none)'}\n` +
              `touchpoints:\n${understanding.touchpoints.map((t: string) => `  - ${t}`).join('\n') || '  (none)'}`
            : '\n---\nUnderstanding Snapshot: (not provided)';
          const decisionSection = decision
            ? `\n---\nDecision (RALPLAN-DR):\n` +
              `principles:\n${decision.principles.map((p: string) => `  - ${p}`).join('\n')}\n` +
              `drivers:\n${decision.drivers.map((d: string) => `  - ${d}`).join('\n')}\n` +
              `options:\n${decision.options.map((o: any) => `  - ${o.name}\n    pros: ${o.pros.join('; ')}\n    cons: ${o.cons.join('; ')}`).join('\n')}\n` +
              `chosen: ${decision.chosen}\n` +
              `rationale: ${decision.rationale}` +
              (decision.preMortem && decision.preMortem.length > 0
                ? `\npreMortem:\n${decision.preMortem.map((pm: any) => `  - ${pm.scenario} (trigger: ${pm.trigger}; consequence: ${pm.consequence}; mitigation: ${pm.mitigation})`).join('\n')}`
                : '')
            : '\n---\nDecision: (not provided)';
          const checklistSection = `\n---\nChecklist + TestIntent:\n${cl.items.map(i => {
            const et = (e: string | { desc: string }) => typeof e === 'string' ? e : e.desc;
            return `- ${i.id}: ${i.title}\n  ${i.testIntent ? `happy: ${(i.testIntent.happy || []).map(et).join('; ')}\n  edge: ${(i.testIntent.edge || []).map(et).join('; ')}\n  adversarial: ${(i.testIntent.adversarial || []).map(et).join('; ')}` : '(无 testIntent)'}`;
          }).join('\n')}`;
          const truthSection = truthDocs.length > 0
            ? `\n---\nTruth Source (${truthDocs.length} 篇):\n${truthDocs.join('\n---\n')}`
            : '';
          // 没有 truth docs + 没有 understanding + 没有 decision 时，仍然要返回基础 prompt 而不是 undefined
          if (truthDocs.length === 0 && !understanding && !decision) return undefined;
          return `请审查以下 story 的 PLAN 阶段产物。重点检查:\n` +
            `  1. understanding 是否真切（unknowns 是否被 facts 自相矛盾，touchpoints 是否真实）\n` +
            `  2. decision 是否选择合理（为什么不选其他 option，rationale 是否呼应 drivers）\n` +
            `  3. testIntent 是否覆盖 description + truth docs 中的所有场景\n` +
            `  4. preMortem 是否列出了真实的失败模式（不是凑数）\n\n` +
            `---\nStory: ${story.title}\nDescription: ${story.description}\nPriority: ${story.priority}` +
            (story.riskSignals && story.riskSignals.length > 0
              ? ` (riskSignals: ${story.riskSignals.map((r: any) => r.category).join(', ')})`
              : '') +
            understandingSection + decisionSection + checklistSection + truthSection;
        })(),
      };
    },

    /**
     * B-5010 CHK-004: 驳回一个被误报的 riskSignal 分类。
     * 将 {category, reason, at} append 到 story.riskSignalsDismissed，后续 story_review
     * 和 decision_set 的高风险判定会跳过被 dismiss 的 category。不支持撤销。
     */
    story_review_dismiss(args: { storyId: string; category: string; reason: string }): object {
      if (!args.reason || args.reason.trim().length < 5) {
        throw new Error('story_review_dismiss: reason 必须 ≥ 5 字符，说清楚为什么该 signal 在本 story 是误报');
      }
      const story = store.readStory(args.storyId);
      const knownCategories = new Set((story.riskSignals || []).map(r => r.category));
      if (!knownCategories.has(args.category)) {
        throw new Error(
          `story_review_dismiss: category "${args.category}" 不在当前 story.riskSignals 里。` +
          `已有的: [${Array.from(knownCategories).join(', ') || '无'}]`
        );
      }
      const existing = story.riskSignalsDismissed || [];
      if (existing.some(d => d.category === args.category)) {
        return {
          ok: true,
          alreadyDismissed: true,
          message: `category "${args.category}" 已经被驳回过，无需重复操作`,
        };
      }
      const updated = {
        ...story,
        riskSignalsDismissed: [
          ...existing,
          { category: args.category, reason: args.reason.trim(), at: new Date().toISOString() },
        ],
      };
      store.writeStory(args.storyId, updated);
      return {
        ok: true,
        dismissed: args.category,
        reason: args.reason.trim(),
        message: `已驳回 riskSignal "${args.category}"，story_review 将不再 advisory 提示此分类`,
      };
    },
  };
}
