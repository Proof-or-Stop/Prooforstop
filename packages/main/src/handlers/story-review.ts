/**
 * @task B-ef9c
 * @checklist CHK-001
 * @title story review enforces multi layer requirement completeness
 * @type feature
 * @priority high
 * @description
 *   Requirement completeness has no silver bullet; Koala lowers omission risk
 *   through multiple defenses: understanding, decision, scope check, related
 *   docs, checklist quality, verificationIntent lanes, and reviewer prompts.
 *   Agent A is responsible for decomposing requirements and implementing code,
 *   while review checks whether the plan has enough structure before DEV.
 * @changes
 *   - [CHK-001] Review checklist item quality and reject weak or empty items
 *   - [CHK-001] Require qualified items to carry observable userSees plus happy/edge/adversarial verification intent in strict paths
 */

import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { loadConfig } from '../core/config.js';
import { computeChannel, resolveWorkflowPolicy } from '../core/workflow-policy.js';
import { computeProcessMetrics } from '../core/process-metrics.js';
import { SCOPE_CHECK_SALT, signScopeCheck } from './scope-check.js';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { VERIFICATION_LANES, collectVerificationIntents } from '../core/verification.js';

function normalizeTouchpointPath(value: string): string {
  const trimmed = value
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^`|`$/g, '')
    .trim();
  const firstSegment = trimmed.split(/\s+\(/)[0].split(/\s+-\s+/)[0].trim();
  const token = firstSegment.split(/\s+/)[0] || firstSegment;
  return token.replace(/[),:;]+$/g, '').replace(/^`|`$/g, '').trim();
}

export function createStoryReviewHandlers(ctx: HandlerContext) {
  const { store } = ctx;

  return {
    story_review(args: { storyId: string }): object {
      const story = store.readStory(args.storyId);
      assertCwdInWorktree(store, args.storyId);
      const cl = store.readChecklist(args.storyId);

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
      const info: Array<{ type: string; message: string }> = [];

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
        if (!item.context || item.context.trim().length < 8) {
          issues.push({ type: 'split_quality', severity: 'advisory', itemId: item.id, message: `${item.id} 缺少 context（根因/参考方案）` });
        }
        // userSees 检查：用户可见输出描述
        const userSees = item.userSees;
        if (!userSees || userSees.trim().length < 10) {
          issues.push({ type: 'missing_user_sees', severity: 'advisory', itemId: item.id, message: `${item.id} 缺少 userSees（用户完成此 item 后在终端/UI 看到的具体文本）。写法示例：'用户看到 "✓ 文件已创建: hello.txt" 然后返回提示符'` });
        } else {
          // 检测抽象描述：如果 userSees 不包含任何引号括起来的具体文本，可能太抽象
          const hasConcreteText = /["'「」`]/.test(userSees) || /[✓✗→>$#]/.test(userSees);
          if (!hasConcreteText) {
            issues.push({ type: 'abstract_user_sees', severity: 'advisory', itemId: item.id, message: `${item.id} userSees 可能太抽象（未包含引号括起来的具体输出文本）。应该写用户看到的精确文字，不是"功能正常工作"这类描述` });
          }
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

      // 0.4 审计日志：展示所有被删除的 item（disposition 在 checklist_remove 时已强制填写）
      const auditLog = cl.auditLog;
      if (auditLog && auditLog.length > 0) {
        const deletions = auditLog.filter(e => e.action === 'delete');
        const additions = auditLog.filter(e => e.action === 'add');
        for (const add of additions) {
          issues.push({
            type: 'scope_change',
            severity: 'advisory',
            itemId: add.itemId,
            message: `${add.itemId}（"${add.addedTitle || '?'}"）在 ${add.phase || '未知'} 阶段被新增: ${add.reason || ''}`,
          });
        }
        for (const del of deletions) {
          issues.push({
            type: 'scope_change',
            severity: 'advisory',
            itemId: del.itemId,
            message: `${del.itemId}（"${del.removedTitle || '?'}"）在 ${del.phase || '未知'} 阶段被删除 [${del.disposition}]: ${del.justification || ''}`,
          });
        }
      }

      // 1. 检查 checklist item 完整性（title/context 非空）
      for (const item of cl.items) {
        if (!item.title || item.title.trim().length < 3) {
          issues.push({ type: 'weak_item', severity: 'blocker', itemId: item.id, message: `${item.id} title 过短或为空` });
        }
      }

      // 2. 检查 item 之间是否可能遗漏交叉场景
      if (cl.items.length >= 2) {
        issues.push({
          type: 'cross_scenario',
          severity: 'advisory',
          message: `${cl.items.length} 个 checklist item，请检查是否有组合场景遗漏（如：${cl.items[0].title} + ${cl.items[1].title} 同时操作会怎样？）`,
        });
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
      if (dismissedCats.size > 0) {
        issues.push({
          type: 'risk_signals_dismissed',
          severity: 'advisory',
          message: `${dismissedCats.size} 个 risk signal 已被主 agent 驳回（理由见 story.riskSignalsDismissed）: ${Array.from(dismissedCats).join(', ')}`,
        });
      }

      // 2.45. RALPLAN-DR decision.json 检查（OMX ralplan 风格）
      // Respect workflow policy: skip check when policy says 'never', only check high_risk stories when 'high_risk'
      const policy = resolveWorkflowPolicy(config, story);

      // B-aa48 CHK-005: check if checklist references design documents
      const allRelatedDocs = cl.items.flatMap(item => item.relatedDocs || []);
      const hasDesignDocs = allRelatedDocs.some((doc: string) =>
        doc.startsWith('decisions/') || doc.startsWith('requirements/') ||
        doc.includes('/decisions/') || doc.includes('/requirements/')
      );

      // B-aa48 CHK-005: balanced profile + design docs referenced -> skip for non-high-risk
      // (symmetric with shouldCheckUnderstanding; currently redundant under balanced's
      // requireDecision='high_risk', but keeps intent explicit if config changes)
      const shouldCheckDecision = (() => {
        if (policy.plan.requireDecision === 'never') return false;
        if (policy.plan.requireDecision === 'high_risk' && !isHighRisk) return false;
        if (policy.profile === 'balanced' && hasDesignDocs && !isHighRisk) return false;
        return true;
      })();
      const decision = store.readDecision(args.storyId);
      const channel = computeChannel(story, cl, decision);
      if (shouldCheckDecision) {
        if (!decision) {
          issues.push({
            type: 'missing_decision',
            severity: isHighRisk ? 'blocker' : 'advisory',
            message: isHighRisk
              ? `高风险 story 必须填 decision.json (principles/drivers/options/chosen/≥3 preMortem)。调用: koala decision_set '{...}'`
              : '未填 decision.json。非高风险 story 可选，但建议补上以便 reviewer 审设计思路。',
          });
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
      }

      // 2.47. Verification intent discipline: fold old testIntent rigor into PLAN without reviving TEST_CASE phases.
      // Normal/high-risk stories must define happy/edge/adversarial intent per checklist item.
      // Express/fast paths can skip explicit PLAN intent; their validation remains evidence/finding based.
      const requireFullVerificationIntent = isHighRisk || channel === 'normal' || policy.profile === 'strict';
      if (requireFullVerificationIntent) {
        for (const item of cl.items) {
          const intents = item.verificationIntent;
          for (const lane of VERIFICATION_LANES) {
            const entries = intents?.[lane] || [];
            if (entries.length === 0) {
              issues.push({
                type: 'missing_verification_intent',
                severity: 'blocker',
                itemId: item.id,
                message: `${item.id} 缺少 verificationIntent.${lane}。第二套流程保留 happy/edge/adversarial 测试纪律：在 PLAN 写 intent，在 DEV/TEST 通过 verification_evidence_add 或 validate 覆盖。`,
              });
            }
          }
        }
      } else {
        const missingHappy = cl.items.filter(item => (item.verificationIntent?.happy || []).length === 0);
        if (missingHappy.length > 0) {
          issues.push({
            type: 'verification_intent_advisory',
            severity: 'advisory',
            message: `${channel} 通道允许快速路径，但建议为 ${missingHappy.map(i => i.id).join(', ')} 至少补一条 verificationIntent.happy，方便 REVIEW/test-coverage reviewer 对齐。`,
          });
        }
      }

      // 2.5. Pre-context Intake snapshot 检查（OMX 风格，软引入）
      // Respect workflow policy: skip check when policy says 'never', only check high_risk stories when 'high_risk'
      const shouldCheckUnderstanding = (() => {
        if (policy.plan.requireUnderstanding === 'never') return false;
        if (policy.plan.requireUnderstanding === 'high_risk' && !isHighRisk) return false;
        // B-aa48 CHK-005: balanced profile + design docs referenced -> skip for non-high-risk
        if (policy.profile === 'balanced' && hasDesignDocs && !isHighRisk) return false;
        return true;
      })();
      const understanding = store.readUnderstanding(args.storyId);
      const grill = store.readGrill(args.storyId);
      if (grill) {
        const openSessions = grill.sessions.filter(session => session.status === 'open');
        for (const session of openSessions) {
          issues.push({
            type: 'grill_session_open',
            severity: 'advisory',
            message: `grill session ${session.sessionId} 仍 open${session.topic ? ` (${session.topic})` : ''}。Grill clarifies intent; evidence proves behavior.`,
          });
        }
        for (const session of grill.sessions) {
          const unresolved = session.questions.filter(question => question.status === 'unresolved');
          if (unresolved.length > 0) {
            issues.push({
              type: 'grill_question_unresolved',
              severity: 'advisory',
              message: `grill session ${session.sessionId} 还有 ${unresolved.length} 个 unresolved question: ${unresolved.slice(0, 3).map(q => q.question).join('; ')}${unresolved.length > 3 ? '…' : ''}`,
            });
          }
        }
      }
      if (shouldCheckUnderstanding) {
        if (!understanding) {
          issues.push({
            type: 'missing_understanding',
            severity: 'advisory',
            message: '未填 understanding snapshot。建议在拆 checklist 前先调用 understanding_set 落 task/outcome/facts/constraints/unknowns/touchpoints 6 个字段，避免理解错误后期修复贵',
          });
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
        }
      }

      // 2.52. B-45ed CHK-002: touchpoints → checklist.files 覆盖校验
      // 若 understanding.touchpoints 非空：
      //   - 若至少一个 checklist item 填了 files 字段 → 硬校验模式，每个未被覆盖的 touchpoint 计一条 blocker
      //   - 若所有 item 都无 files 字段（旧 story）→ fallback advisory `touchpoint_mapping_missing`
      // 覆盖判定：提取 path 前缀后比较，允许 "src/foo.ts (reason)" 这类人类说明。
      if (understanding && understanding.touchpoints && understanding.touchpoints.length > 0) {
        const itemsWithFiles = cl.items.filter(i => !!i.files);
        if (itemsWithFiles.length === 0) {
          issues.push({
            type: 'touchpoint_mapping_missing',
            severity: 'advisory',
            message: 'checklist 所有 item 均未填写 files 字段（旧 story 兼容模式），无法对 understanding.touchpoints 做覆盖校验。请为至少一个 item 的 files.modify/create/test 列出改动文件，以启用 touchpoint→files 强校验',
          });
        } else {
          // 硬校验模式：收集所有 item 已声明的 files 路径
          const covered = new Set<string>();
          for (const item of itemsWithFiles) {
            const f = item.files!;
            for (const p of f.modify || []) covered.add(normalizeTouchpointPath(p));
            for (const p of f.create || []) covered.add(normalizeTouchpointPath(p));
            for (const p of f.test || []) covered.add(normalizeTouchpointPath(p));
          }
          for (const tp of understanding.touchpoints) {
            const normalizedTp = normalizeTouchpointPath(tp);
            if (!covered.has(normalizedTp)) {
              issues.push({
                type: 'touchpoint_uncovered',
                severity: 'blocker',
                message: `touchpoint_uncovered: ${tp} 未被任何 checklist item 的 files 字段覆盖（请为相应 item 的 files.modify/create/test 加上此路径或用 excludes 显式排除）`,
              });
            }
          }
        }
      }

      // 2.55. plan.md 检查（respect policy.plan.requirePlanMd）
      const shouldCheckPlanMd = (() => {
        if (policy.plan.requirePlanMd === 'never') return false;
        if (policy.plan.requirePlanMd === 'normal') return cl.items.length > 2 || isHighRisk;
        return true; // 'always'
      })();
      if (shouldCheckPlanMd) {
        const planPath = join(ctx.root, config.storyDir, args.storyId, 'plan.md');
        if (!existsSync(planPath)) {
          issues.push({
            type: 'missing_plan_md',
            severity: isHighRisk ? 'blocker' : 'advisory',
            message: isHighRisk
              ? '高风险 story 必须有 plan.md（执行计划）。按 CLAUDE.md plan.md 模板写，每个 CHK-xxx 一个章节'
              : '未找到 plan.md。正常通道建议写 plan.md 明确执行顺序和依赖',
          });
        }
      }

      // 2.6. Scope check: read scope-check.json (written by koala-review-scope-plan agent)
      // Only check scope when understanding exists and checklist has items
      // (without these, scope check is meaningless and would block trivial stories)
      const scopeData = store.readScopeCheck(args.storyId);
      if (!scopeData && understanding && cl.items.length > 0) {
        issues.push({
          type: 'missing_scope_check',
          severity: 'blocker',
          message: '未跑 scope check。请先启动 koala-review-scope-plan agent，agent 会自动调 scope_check_save 写入结果',
        });
      } else if (scopeData) {
        // Verify signature using shared signScopeCheck function
        const expectedHash = signScopeCheck(args.storyId, scopeData.checkedAt, scopeData.summary.gaps, scopeData.summary.covered, scopeData.reviewRound || '');
        if (!scopeData._hash || scopeData._hash !== expectedHash) {
          issues.push({
            type: 'scope_check_tampered',
            severity: 'blocker',
            message: 'scope-check.json 签名校验失败，必须由 scope agent 通过 scope_check_save 写入',
          });
        } else {
          // Verify review round matches current round
          if (story.currentReviewRound && scopeData.reviewRound !== story.currentReviewRound) {
            issues.push({
              type: 'scope_check_stale',
              severity: 'blocker',
              message: `scope-check.json 的 reviewRound (${scopeData.reviewRound || '无'}) 与当前 review round (${story.currentReviewRound}) 不匹配，请重新跑 scope agent`,
            });
          }
          // Report gaps as blocker
          const gaps = (scopeData.features || []).filter(f => f.status === 'gap');
          for (const gap of gaps) {
            issues.push({
              type: 'scope_gap',
              severity: 'blocker',
              message: `scope gap: description 提到 "${gap.feature}" 但无对应 checklist item 且未 exclude`,
            });
          }
          // Report excluded as info (not counted as issue)
          const excluded = (scopeData.features || []).filter(f => f.status === 'excluded');
          if (excluded.length > 0) {
            info.push({
              type: 'scope_excluded_info',
              message: `${excluded.length} 个功能点已显式 exclude: ${excluded.map(e => e.feature).join(', ')}`,
            });
          }
          // F-018/F-021: orphan-suspect 作为 advisory 输出（不 block，但让主 agent 可见）
          // drift 在 PLAN 阶段恒为空集，S3 规划，此处不输出。
          const orphanSuspect = (scopeData.features || []).filter(f => f.status === 'orphan-suspect');
          for (const feat of orphanSuspect) {
            const src = feat.source ? ` 见 ${feat.source}` : '';
            issues.push({
              type: 'scope_orphan_suspect',
              severity: 'advisory',
              message: `scope feature ${feat.feature} orphan-suspect:${src} 未被任何 CHK 覆盖但未显式 exclude，请确认`,
            });
          }
        }
      }

      // 2.65. B-ed3e CHK-004: Open Questions gate —— 任何未 resolve 的 OQ 都 block PLAN→DEV。
      // 防主 agent 对 scope-plan reviewer 的疑问装没看见（自我赦免）。向后兼容：
      // 老 scope-check.json 无 openQuestions 字段（undefined）或空数组时不触发。
      if (scopeData && scopeData.openQuestions && scopeData.openQuestions.length > 0) {
        // F-019: 与 cli-engine.ts Zod schema (resolution.min(20)) 对齐；
        // 1-19 字符的 resolution 视为未 resolve，防绕过。
        const unresolved = scopeData.openQuestions.filter(
          oq => !oq.resolution || oq.resolution.trim().length < 20,
        );
        for (const oq of unresolved) {
          // F-017: oq.q 为空时用 '(无疑问文本)' 兜底，防输出 "... 未 resolve — """
          const rawQ = oq.q ?? '';
          const qText = rawQ.length > 80
            ? `${rawQ.slice(0, 77)}...`
            : (rawQ.length > 0 ? rawQ : '(无疑问文本)');
          // F-019: 已写但 < 20 字符的 resolution 在消息里额外标注
          const trimmedLen = (oq.resolution ?? '').trim().length;
          const shortTag = (trimmedLen > 0 && trimmedLen < 20)
            ? '（< 20 字符，视为未 resolve）'
            : '';
          issues.push({
            type: 'scope_open_question_unresolved',
            severity: 'blocker',
            message: `scope_open_question_unresolved: ${oq.id} 未 resolve — "${qText}"${shortTag}。请跑 \`koala scope_question_resolve --storyId=${args.storyId} --oqId=${oq.id} --resolution=...\` 书面消解（主 agent 对结论负责）`,
          });
        }
      }

      // 3. 确保 issueCount > 0（审查必须产出至少一个 advisory）
      if (issues.length === 0) {
        issues.push({
          type: 'review_advisory',
          severity: 'advisory',
          message: '审查未发现 blocker，但建议对照 _reviewPrompt 中的真相源文档人工复核 checklist 完整性',
        });
      }

      // 4. 统计
      const totalItems = cl.items.length;
      const blockerCount = issues.filter(i => i.severity === 'blocker').length;

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

      // B-aa48 CHK-002: write plan_reviewed process event
      try {
        store.appendProcessEvent(args.storyId, {
          type: 'plan_reviewed',
          round: reviewData.reviews.length,
          blockerCount,
          issueCount: issues.length,
        });
      } catch (e) {
        console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
      }

      // B-abd8: auto-recompute process metrics
      try {
        const pm = computeProcessMetrics(args.storyId, store, ctx.root);
        store.writeProcessMetrics(args.storyId, pm);
      } catch (e) {
        console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
      }

      const planReviewRound = reviewData.reviews.length;

      return {
        storyId: args.storyId,
        title: story.title,
        planReviewRound,
        // Legacy compatibility alias for story_review callers. This is the
        // numeric PLAN review count, not the signed artifact ISO reviewRound.
        reviewRound: planReviewRound,
        summary: {
          totalItems,
          issueCount: issues.length,
          blockerCount,
        },
        issues,
        ...(info.length > 0 ? { info } : {}),
        truthDocsCount: truthDocs.length,
        _hint: blockerCount > 0
          ? `第 ${reviewData.reviews.length} 轮审查发现 ${blockerCount} 个 blocker，请修复后再次 story_review`
          : `✅ 第 ${reviewData.reviews.length} 轮审查通过（${blockerCount} blocker, ${issues.length} advisory），可进入开发`,
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
          const grillSection = grill
            ? `\n---\nGrill Planning Context (advisory only):\n` +
              `Grill clarifies intent; evidence proves behavior.\n` +
              grill.sessions.map(session => {
                const questionLines = session.questions.length > 0
                  ? session.questions.map(q => `    - ${q.id} [${q.status}] ${q.question}${q.answer ? ` -> ${q.answer}` : ''}`).join('\n')
                  : '    (no questions recorded)';
                return `  - ${session.sessionId} [${session.status}]${session.topic ? ` ${session.topic}` : ''}\n${questionLines}`;
              }).join('\n')
            : '';
          const checklistSection = `\n---\nChecklist:\n${cl.items.map(i => {
            const vi = collectVerificationIntents(i);
            const intentLines = vi.length > 0
              ? `\n  verificationIntent:\n${vi.map(v => `    - ${v.ref} [${v.lane}/${v.intent.priority || 'must'}/${v.intent.type}] ${v.intent.desc}`).join('\n')}`
              : '';
            return `- ${i.id}: ${i.title}${i.context ? ` (${i.context})` : ''}${intentLines}`;
          }).join('\n')}`;
          const truthSection = truthDocs.length > 0
            ? `\n---\nTruth Source (${truthDocs.length} 篇):\n${truthDocs.join('\n---\n')}`
            : '';
          // 没有 truth docs + 没有 understanding + 没有 decision 时，仍然要返回基础 prompt 而不是 undefined
          if (truthDocs.length === 0 && !understanding && !decision && !grill) return undefined;
          return `请审查以下 story 的 PLAN 阶段产物。重点检查:\n` +
            `  1. understanding 是否真切（unknowns 是否被 facts 自相矛盾，touchpoints 是否真实）\n` +
            `  2. decision 是否选择合理（为什么不选其他 option，rationale 是否呼应 drivers）\n` +
            `  3. checklist 是否覆盖 description + truth docs 中的所有场景\n` +
            `  4. preMortem 是否列出了真实的失败模式（不是凑数）\n\n` +
            `---\nStory: ${story.title}\nDescription: ${story.description}\nPriority: ${story.priority}` +
            (story.riskSignals && story.riskSignals.length > 0
              ? ` (riskSignals: ${story.riskSignals.map((r: any) => r.category).join(', ')})`
              : '') +
            understandingSection + decisionSection + grillSection + checklistSection + truthSection;
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
