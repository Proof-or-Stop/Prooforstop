/**
 * story_dispatch — B-45ed CHK-005
 *
 * 生成标准 koala-implementer prompt 字符串（主 agent 复制粘贴进 Agent({subagent_type, prompt})）。
 *
 * 核心目标：
 *   - 统一主 agent 派发 implementer 的 prompt 结构，避免主 agent 粘贴转述 plan.md
 *   - prompt 强制引用 background.md + plan.md#CHK-xxx 路径，让 implementer 自己去读
 *   - 不 spawn subagent，只输出字符串，保留主 agent 的派发决策权
 *
 * agent-type 分级注入（完整矩阵见 CLAUDE.md "background.md 分级注入"）：
 *   - required: koala-implementer / koala-review-scope-plan / koala-review-behavior / koala-review-concept
 *     → prompt 首行标 "必读" 强制 subagent 读 background 理解意图
 *   - advisory: koala-review-quality / koala-review-docs
 *     → prompt 标 "可选参考"，不打断机械检查逻辑
 *   - none: koala-review-channel
 *     → 完全不注入，避免机械 commit author 检查被 background 噪音污染
 *   - 未知 agentType → 降级为 required（最安全；宁可多读也别漏读）
 *   - 不传 agentType → 默认按 koala-implementer 语义（required）
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { createClusterHandlers } from './cluster.js';
import type { StoryStore } from '../core/store.js';
import { reportHealthIssue } from '../core/health.js';

// B-45ed CHK-008: agent-type → background 注入策略映射表
// 来源：CLAUDE.md "background.md 分级注入（subagent）" 小节
type BackgroundPolicy = 'required' | 'advisory' | 'none';
const AGENT_BG_POLICY: Record<string, BackgroundPolicy> = {
  'koala-implementer': 'required',
  // B-ed3e CHK-001: scope reviewer 改名 koala-review-scope-plan（旧名 koala-review-scope 保留 legacy alias）
  'koala-review-scope-plan': 'required',
  'koala-review-behavior': 'required',
  'koala-review-concept': 'required',
  'koala-review-quality': 'advisory',
  'koala-review-docs': 'advisory',
  'koala-review-channel': 'none',
};

/**
 * B-ed3e CHK-001: 旧名 → 新名映射（legacy alias）
 * 调用方传旧 agentType 时，console.warn 提醒后内部重命名为新 agentType 继续执行。
 */
const AGENT_TYPE_ALIASES: Record<string, string> = {
  'koala-review-scope': 'koala-review-scope-plan',
};

/** 归一化 agentType：旧名 → 新名，若命中 alias 则 console.warn。未命中则原样返回。 */
function normalizeAgentType(agentType: string | undefined): string | undefined {
  if (!agentType) return agentType;
  const renamed = AGENT_TYPE_ALIASES[agentType];
  if (renamed) {
    console.warn(
      `warn: ${agentType} 已改名为 ${renamed}（B-ed3e S2）。已自动重定向，请更新调用方。`,
    );
    return renamed;
  }
  return agentType;
}

/** 解析 agentType → 注入策略；未知 agentType 降级为 required（最安全）。 */
function resolveBackgroundPolicy(agentType: string | undefined): BackgroundPolicy {
  if (!agentType) return 'required'; // 默认 koala-implementer 行为
  return AGENT_BG_POLICY[agentType] ?? 'required';
}

function isReviewAgent(agentType: string | undefined): boolean {
  return !!agentType && agentType.startsWith('koala-review-');
}

/**
 * B-9d95 CHK-004: 统一 dispatch 入口。
 *
 * story_dispatch / finding_dispatch / dispatch 三入口共享同一份 prompt 组装逻辑，避免
 * 重复实现。`dispatch` 按 itemId / findingId / clusterId 分派；老入口保留为 alias，
 * 首行 stdout 打印 deprecation warning 但返回值保持 byte-identical。
 */
export function createStoryDispatchHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;

  function appendDispatchEvent(args: {
    storyId: string;
    agentType?: string;
    targetKind: 'init-review' | 'checklist' | 'finding' | 'cluster';
    itemId?: string;
    findingId?: string;
    clusterId?: string;
  }): void {
    try {
      const story = store.readStory(args.storyId);
      const agentType = normalizeAgentType(args.agentType) || 'koala-implementer';
      store.appendProcessEvent(args.storyId, {
        type: 'dispatch',
        storyId: args.storyId,
        phase: story.phase,
        source: 'koala dispatch',
        targetKind: args.targetKind,
        agentType,
        ...(args.itemId ? { itemId: args.itemId, checklistId: args.itemId } : {}),
        ...(args.findingId ? { findingId: args.findingId } : {}),
        ...(args.clusterId ? { clusterId: args.clusterId } : {}),
      });
    } catch (e: any) {
      reportHealthIssue('persist:dispatchProcessEvent', e as Error, {
        storyId: args.storyId,
        agentType: args.agentType,
        targetKind: args.targetKind,
        itemId: args.itemId,
        findingId: args.findingId,
        clusterId: args.clusterId,
      });
      ctx.log?.(`[process-events] dispatch append failed for ${args.storyId}: ${e?.message || e}`);
    }
  }

  function appendDispatchLivenessGuidance(lines: string[], label: string): void {
    lines.push('执行节奏 / liveness:');
    lines.push(`- 开始后先输出 \`DISPATCH_START:${label}\`，让主 agent 知道进程已启动。`);
    lines.push('- 4 分钟没有任何输出时，主 agent 应询问一次状态；10 分钟/600s 仍无结果时视为 stalled，可以重启该 reviewer/worker。');
    lines.push('- 若是 retry，请在最终回复里说明前一次 stalled，避免把网络/启动失败误判为审查结论。');
    lines.push('');
  }

  function buildInitReviewPrompt(args: {
    storyId: string;
    agentType?: string;
  }): { prompt: string } {
    if (!args.storyId) throw new Error('storyId is required');
    try {
      store.readStory(args.storyId);
    } catch {
      throw new Error(`story ${args.storyId} not found`);
    }
    const bgPath = `${store.storyDirRel()}/${args.storyId}/background.md`;
    const checklistPath = `${store.storyDirRel()}/${args.storyId}/checklist.json`;
    return {
      prompt: [
        `审查 story ${args.storyId} 的 background + checklist 初版。`,
        '',
        '你是 koala-review-story-init reviewer；请 fresh-context 审查，不要沿用主 agent 的结论。',
        `必读: ${bgPath}`,
        `必读: ${checklistPath}`,
        '',
        '审查重点:',
        '- background 是否足以说明触发事件、关键洞察、方案取舍、对话纹理',
        '- checklist 是否拆成用户可观察、可验证、互不重叠的 item',
        '- 是否存在高风险信号但缺少必要的 PLAN/decision/verification 准备',
        '',
        '执行节奏 / timeout:',
        '- 开始后先输出 `INIT_REVIEW_START`，读完 background/checklist 后输出 `INIT_REVIEW_READ_DONE`。',
        '- 最晚 5 分钟内必须二选一：调用 init_check_set，或输出明确 blocker + 当前卡点。',
        '- 如果 4 分钟没有任何输出，主 agent 应视为 reviewer 卡住，可以重新运行本 dispatch 并重启 reviewer。',
        '',
        '硬性要求:',
        `- 无论结论是 pass 还是 fail，都必须调用一次 init_check_set 记录结果；只输出文字结论不算完成。`,
        `- 发现问题时也要调用: koala init_check_set '{"storyId":"${args.storyId}","issues":[{"severity":"low","desc":"..."}],"agentId":"koala-review-story-init"}'`,
        `- 如果没有问题，issues 传空数组: koala init_check_set '{"storyId":"${args.storyId}","issues":[],"agentId":"koala-review-story-init"}'`,
        '- INIT_CHECK gate 还要求 product-reviewer 也调用 init_check_set；你只负责 koala-review-story-init 这一条记录。',
        '- 不要直接编辑 story 文件。',
      ].join('\n'),
    };
  }

  function buildProductInitReviewPrompt(args: {
    storyId: string;
    agentType?: string;
  }): { prompt: string } {
    if (!args.storyId) throw new Error('storyId is required');
    try {
      store.readStory(args.storyId);
    } catch {
      throw new Error(`story ${args.storyId} not found`);
    }
    const bgPath = `${store.storyDirRel()}/${args.storyId}/background.md`;
    const checklistPath = `${store.storyDirRel()}/${args.storyId}/checklist.json`;
    return {
      prompt: [
        `从用户价值角度审查 story ${args.storyId} 的 INIT 是否可推进。`,
        '',
        '你是 product-reviewer，不是 koala-review-story-init。请 fresh-context 审查，不要沿用主 agent 的结论。',
        `必读: ${bgPath}`,
        `必读: ${checklistPath}`,
        '',
        '审查重点:',
        '- background 是否讲清用户为什么需要这件事，而不只是工程机制',
        '- checklist 的每一项是否有用户可观察结果',
        '- 完成后的 outcome 是否能让用户自然说“好了”，而不是还会问“然后呢？”',
        '',
        '硬性要求:',
        '- 无论结论是 pass 还是 fail，都必须调用一次 init_check_set 记录结果；只输出文字结论不算完成。',
        `- agentId 必须精确传 "product-reviewer"。不要传 "koala-review-story-init"，那是另一个 reviewer，会导致 INIT_CHECK gate 继续报缺 product-reviewer。`,
        `- 发现问题时也要调用: koala init_check_set '{"storyId":"${args.storyId}","issues":[{"severity":"medium","desc":"..."}],"agentId":"product-reviewer"}'`,
        `- 如果没有问题，issues 传空数组: koala init_check_set '{"storyId":"${args.storyId}","issues":[],"agentId":"product-reviewer"}'`,
        '- critical/high issue 会硬阻塞 INIT_CHECK；medium/low 会记录为 advisory。',
        '- 不要直接编辑 story 文件。',
      ].join('\n'),
    };
  }

  function buildFindingPrompt(args: {
    storyId: string;
    findingId: string;
    agentType?: string;
  }): { prompt: string } {
      if (!args.storyId) throw new Error('storyId is required');
      if (!args.findingId) throw new Error('findingId is required');

      // B-ed3e CHK-001: legacy agentType alias 归一化（旧名 console.warn + 重命名）
      const agentType = normalizeAgentType(args.agentType);

      // 1. story 存在性校验（消息比 readStory 原生错误更清晰）
      try {
        store.readStory(args.storyId);
      } catch {
        throw new Error(`story ${args.storyId} not found`);
      }

      // 2. finding 定位（findings.json 里 id 是 "B-xxx:F-NNN" 格式；允许 caller 传短形式 "F-NNN" 或长形式）
      const data = store.readFindings(args.storyId);
      const wantShort = args.findingId.startsWith(`${args.storyId}:`)
        ? args.findingId.slice(args.storyId.length + 1)
        : args.findingId;
      const finding = data.findings.find(
        f => f.id === args.findingId || f.id === `${args.storyId}:${wantShort}`,
      );
      if (!finding) {
        throw new Error(`${args.findingId} not found in story ${args.storyId}`);
      }

      // 3. background.md 存在性
      const bgPath = `${store.storyDirRel()}/${args.storyId}/background.md`;
      const bgAbs = join(root, bgPath);
      const bgExists = existsSync(bgAbs);

      // 4. agent-type 分级注入决策（完全复用 story_dispatch 的 AGENT_BG_POLICY）
      const bgPolicy = resolveBackgroundPolicy(agentType);
      const displayAgent = agentType || 'koala-implementer';

      // 5. finding 字段兜底。注意：Finding schema 没有独立 location/suggestion 字段——
      //    reviewer 把 file:line 和修复建议直接写在 desc 正文里（约定），所以这里不再单独渲染。
      const fDesc = finding.desc || '（未提供）';
      const fSeverity = finding.severity || '（未提供）';
      const fCategory = finding.category || '（未提供）';
      const fReviewer = finding.agent || '（未提供）';

      // 6. 组装 prompt
      const lines: string[] = [];
      // 首行：用 desc 作为短标题（Finding schema 没有独立 title 字段），截断到 80 字符
      const shortTitle = fDesc.length > 80 ? fDesc.slice(0, 80) + '…' : fDesc;
      // finding.id 已是 "B-45ed:F-001" 形式，显示时剥掉 storyId 前缀避免 "B-45ed B-45ed:F-001" 重复
      const shortFid = finding.id.startsWith(`${args.storyId}:`)
        ? finding.id.slice(args.storyId.length + 1)
        : finding.id;
      lines.push(`作为 ${displayAgent} 修复 ${args.storyId} ${shortFid}: ${shortTitle}`);
      lines.push('');

      // B-9d95 CHK-001: 注入 worktree 绝对路径。根因复盘（B-ed3e F-001）：subagent 继承父进程 cwd
      // 不一定落在 worktree（尤其跨仓场景），导致 reviewer/handler 在主仓 cwd 读 docs/story/...
      // 看不到 worktree 副本而误报。ctx.root 在 MCP handler 初始化时已绑定为 worktree 根，
      // 是当前最可靠的绝对路径来源（优于 process.cwd()——后者依赖调用方 shell 当前目录）。
      lines.push(`工作目录（subagent 必须 cd 到此）: ${root}`);
      lines.push('');
      appendDispatchLivenessGuidance(lines, `${displayAgent}/${shortFid}`);

      if (bgPolicy === 'required') {
        const prefix = bgExists ? '' : '⚠ 缺失，强烈建议先写 `koala background_set` — ';
        lines.push(`必读: ${prefix}${bgPath}`);
        lines.push('');
      } else if (bgPolicy === 'advisory') {
        const prefix = bgExists ? '' : '⚠ 缺失 — ';
        lines.push(`可选参考: ${prefix}${bgPath}`);
        lines.push('');
      }
      // bgPolicy === 'none' → 完全不注入 background 行

      lines.push(`Severity: ${fSeverity}  Category: ${fCategory}  Reviewer: ${fReviewer}`);
      lines.push(`Description: ${fDesc}`);
      lines.push('');
      lines.push('完成后:');
      lines.push('- git commit');
      lines.push(`- koala finding_resolve '{"storyId":"${args.storyId}","findingId":"${finding.id}","resolution":"<你的修复说明>"}'`);

      return { prompt: lines.join('\n') };
  }

  function buildItemPrompt(args: {
    storyId: string;
    itemId: string;
    agentType?: string;
  }): { prompt: string } {
      if (!args.storyId) throw new Error('storyId is required');
      if (!args.itemId) throw new Error('itemId is required');

      // B-ed3e CHK-001: legacy agentType alias 归一化（旧名 console.warn + 重命名）
      const agentType = normalizeAgentType(args.agentType);

      // 1. story 存在校验（readStory 抛错时消息不够清晰，包一层）
      let story;
      try {
        story = store.readStory(args.storyId);
      } catch {
        throw new Error(`story ${args.storyId} not found`);
      }

      // 2. checklist item 定位
      const cl = store.readChecklist(args.storyId);
      const item = cl.items.find(i => i.id === args.itemId);
      if (!item) {
        throw new Error(`${args.itemId} not found in story ${args.storyId}`);
      }

      // 3. plan.md 对应 CHK 段提取（可选——plan.md 可能不存在，走降级）
      const planSection = extractPlanSection(store, args.storyId, args.itemId);

      // 4. background.md 存在性检测（不存在 → warning 前缀，不崩溃）
      const bgPath = `${store.storyDirRel()}/${args.storyId}/background.md`;
      const bgAbs = join(root, bgPath);
      const bgExists = existsSync(bgAbs);

      // 5. Verify 段从 plan.md 段里提取（若未找到则降级）
      const verifyText = extractVerifyFromSection(planSection) || 'koala validate 全绿';

      // 6. Files 段渲染（若 item.files 缺失，显示"（未声明）"）
      const filesBlock = renderFilesBlock(item.files);

      // 7. background 注入决策（B-45ed CHK-008 完整分级矩阵）
      //    policy 来自 AGENT_BG_POLICY（CLAUDE.md 分级矩阵）：
      //    - required → 写进"必读"段首行
      //    - advisory → 写进"可选参考"段
      //    - none     → 完全不注入
      const bgPolicy = resolveBackgroundPolicy(agentType);

      if (isReviewAgent(agentType)) {
        const displayAgent = agentType!;
        const lines: string[] = [];
        lines.push(`作为 ${displayAgent} 审查 ${args.storyId} ${args.itemId}: ${item.title}`);
        lines.push('');
        lines.push(`工作目录（subagent 必须 cd 到此）: ${root}`);
        lines.push('');
        appendDispatchLivenessGuidance(lines, `${displayAgent}/${args.itemId}`);
        lines.push('角色边界:');
        lines.push('- 只审查，不改代码、不写测试、不更新 checklist。');
        lines.push('- fresh-context 阅读材料，独立判断是否存在 blocker 或需要回炉的问题。');
        lines.push('');
        lines.push('审查材料:');
        let idx = 1;
        if (bgPolicy === 'required') {
          const prefix = bgExists ? '' : '⚠ 缺失，强烈建议先写 `koala background_set` — ';
          lines.push(`${idx}. 必读 background.md 理解意图 — ${prefix}${bgPath}`);
          idx++;
        }
        const planRef = `${store.storyDirRel()}/${args.storyId}/plan.md#${args.itemId}`;
        lines.push(`${idx}. ${planRef}`);
        idx++;
        const seen = new Set<string>([bgPath, planRef]);
        if (Array.isArray(item.relatedDocs) && item.relatedDocs.length > 0) {
          for (const doc of item.relatedDocs) {
            if (seen.has(doc)) continue;
            seen.add(doc);
            lines.push(`${idx}. ${doc}`);
            idx++;
          }
        }
        if (bgPolicy === 'advisory') {
          const prefix = bgExists ? '' : '⚠ 缺失 — ';
          lines.push('');
          lines.push(`可选参考 background.md（理解意图，但本 agent 以审查职责为主）: ${prefix}${bgPath}`);
        }
        lines.push('');
        lines.push(`Context: ${item.context || '（未声明）'}`);
        lines.push('');
        lines.push('Files:');
        lines.push(`- Modify: ${filesBlock.modify}`);
        lines.push(`- Create: ${filesBlock.create}`);
        lines.push(`- Test:   ${filesBlock.test}`);
        lines.push('');
        lines.push(`Verify expectation: ${verifyText}`);
        lines.push('');
        lines.push('结论记录（必须二选一）:');
        lines.push(`- 先启动本轮 reviewer run: koala review_run_start '{"storyId":"${args.storyId}","agent":"${displayAgent}"}'`);
        lines.push(`- 有问题: koala finding_add '{"storyId":"${args.storyId}","reviewRunId":"${args.storyId}:RR-001","desc":"<file:line WHY + severity>","severity":"high|medium|low","category":"missing|edge|adversarial|happy","agent":"${displayAgent}"}'`);
        lines.push(`- 无 blocker: koala review_pass_set '{"storyId":"${args.storyId}","agent":"${displayAgent}","reviewRunId":"${args.storyId}:RR-001","note":"reviewed ${args.itemId}: checked implementation against the item context and found no blocker."}'`);

        void story;

        return { prompt: lines.join('\n') };
      }

      // 8. 组装 implementer prompt
      const lines: string[] = [];
      lines.push(`作为 koala-implementer 实施 ${args.storyId} ${args.itemId}: ${item.title}`);
      lines.push('');
      // B-9d95 CHK-001: 注入 worktree 绝对路径。根因复盘（B-ed3e F-001）：subagent 继承父进程 cwd
      // 不一定落在 worktree（尤其跨仓场景），导致 reviewer/handler 在主仓 cwd 读 docs/story/...
      // 看不到 worktree 副本而误报。ctx.root 在 MCP handler 初始化时已绑定为 worktree 根，
      // 是当前最可靠的绝对路径来源（优于 process.cwd()——后者依赖调用方 shell 当前目录）。
      lines.push(`工作目录（subagent 必须 cd 到此）: ${root}`);
      lines.push('');
      appendDispatchLivenessGuidance(lines, `${agentType || 'koala-implementer'}/${args.itemId}`);
      lines.push('必读（按顺序）:');
      let idx = 1;
      if (bgPolicy === 'required') {
        const prefix = bgExists ? '' : '⚠ 缺失，强烈建议先写 `koala background_set` — ';
        lines.push(`${idx}. 必读 background.md 理解意图 — ${prefix}${bgPath}`);
        idx++;
      }
      const planRef = `${store.storyDirRel()}/${args.storyId}/plan.md#${args.itemId}`;
      lines.push(`${idx}. ${planRef}`);
      idx++;
      // relatedDocs 追加（去重：已在前面出现的 background.md / plan.md 跳过）
      const seen = new Set<string>([bgPath, planRef]);
      if (Array.isArray(item.relatedDocs) && item.relatedDocs.length > 0) {
        for (const doc of item.relatedDocs) {
          if (seen.has(doc)) continue;
          seen.add(doc);
          lines.push(`${idx}. ${doc}`);
          idx++;
        }
      }
      // B-45ed CHK-008: advisory agent 在必读段后附"可选参考"行；none agent 完全不输出 background 行
      if (bgPolicy === 'advisory') {
        const prefix = bgExists ? '' : '⚠ 缺失 — ';
        lines.push('');
        lines.push(`可选参考 background.md（理解意图，但本 agent 以机械检查为主）: ${prefix}${bgPath}`);
      }
      lines.push('');
      lines.push(`Context: ${item.context || '（未声明）'}`);
      lines.push('');
      lines.push('Files:');
      lines.push(`- Modify: ${filesBlock.modify}`);
      lines.push(`- Create: ${filesBlock.create}`);
      lines.push(`- Test:   ${filesBlock.test}`);
      lines.push('');
      lines.push(`Verify: ${verifyText}`);
      lines.push('');
      lines.push('完成后:');
      lines.push('- git commit');
      lines.push(`- koala checklist_update '{"storyId":"${args.storyId}","itemId":"${args.itemId}","status":"done"}'`);

      // 使用 story.phase 消除未使用变量告警（同时便于 CHK-008 扩展时读取上下文）
      void story;

      return { prompt: lines.join('\n') };
  }

  return {
    /**
     * finding_dispatch — B-45ed CHK-010（**deprecated in B-9d95 CHK-004**）
     *
     * 保留为 alias，首行 stdout 打印 deprecation warning；返回值与 dispatch({findingId}) byte-identical。
     */
    finding_dispatch(args: {
      storyId: string;
      findingId: string;
      agentType?: string;
    }): { prompt: string } {
      console.log(
        '⚠ deprecation: finding_dispatch 将在 B-9d95 之后版本下线，请改用 koala dispatch',
      );
      return buildFindingPrompt(args);
    },

    /**
     * story_dispatch — B-45ed CHK-005（**deprecated in B-9d95 CHK-004**）
     *
     * 保留为 alias，首行 stdout 打印 deprecation warning；返回值与 dispatch({itemId}) byte-identical。
     */
    story_dispatch(args: {
      storyId: string;
      itemId: string;
      agentType?: string;
    }): { prompt: string } {
      console.log(
        '⚠ deprecation: story_dispatch 将在 B-9d95 之后版本下线，请改用 koala dispatch',
      );
      return buildItemPrompt(args);
    },

    /**
     * dispatch — B-9d95 CHK-004 统一入口
     *
     * 按 itemId / findingId / clusterId 恰好一个分派；若只传
     * agentType=koala-review-story-init，则生成 INIT reviewer prompt。
     *
     * 互斥校验：三者必须恰好提供一个，多 / 少均抛 Error。
     * 返回：{ prompt: string } — 与老入口 byte-identical（clusterId 分支复用 cluster.ts 文本）。
     */
    dispatch(args: {
      storyId: string;
      itemId?: string;
      findingId?: string;
      clusterId?: string;
      agentType?: string;
    }): { prompt: string } {
      if (!args.storyId) throw new Error('storyId is required');

      const provided = [
        args.itemId ? 'itemId' : null,
        args.findingId ? 'findingId' : null,
        args.clusterId ? 'clusterId' : null,
      ].filter(Boolean);
      const normalizedAgentType = normalizeAgentType(args.agentType);
      if (provided.length === 0 && normalizedAgentType === 'koala-review-story-init') {
        const result = buildInitReviewPrompt({
          storyId: args.storyId,
          agentType: args.agentType,
        });
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: args.agentType,
          targetKind: 'init-review',
        });
        return result;
      }
      if (provided.length === 0 && normalizedAgentType === 'product-reviewer') {
        const result = buildProductInitReviewPrompt({
          storyId: args.storyId,
          agentType: args.agentType,
        });
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: args.agentType,
          targetKind: 'init-review',
        });
        return result;
      }
      if (provided.length !== 1) {
        throw new Error('dispatch 需要 itemId / findingId / clusterId 中恰好一个；INIT reviewer 可只传 agentType=koala-review-story-init 或 product-reviewer');
      }

      if (args.itemId) {
        const result = buildItemPrompt({
          storyId: args.storyId,
          itemId: args.itemId,
          agentType: args.agentType,
        });
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: args.agentType,
          targetKind: 'checklist',
          itemId: args.itemId,
        });
        return result;
      }
      if (args.findingId) {
        const result = buildFindingPrompt({
          storyId: args.storyId,
          findingId: args.findingId,
          agentType: args.agentType,
        });
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: args.agentType,
          targetKind: 'finding',
          findingId: args.findingId,
        });
        return result;
      }
      // clusterId branch — 复用 cluster.ts 的 finding_dispatch（输出 string）。
      // 包装成 { prompt } 保持接口一致。
      const clusterHandlers = createClusterHandlers(ctx);
      const prompt = clusterHandlers.finding_dispatch({
        storyId: args.storyId,
        clusterId: args.clusterId!,
      });
      appendDispatchEvent({
        storyId: args.storyId,
        agentType: args.agentType,
        targetKind: 'cluster',
        clusterId: args.clusterId!,
      });
      return { prompt };
    },
  };
}

/** 从 plan.md 抽取 `## {itemId}:` 到下一个 `^## ` 之间的段落 */
function extractPlanSection(store: StoryStore, storyId: string, itemId: string): string | null {
  const planPath = store.storyFilePath(storyId, 'plan.md');
  if (!existsSync(planPath)) return null;
  const content = readFileSync(planPath, 'utf-8');
  const lines = content.split('\n');
  const startRe = new RegExp(`^## ${itemId}:`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * 从 plan.md 的 CHK-xxx 段中抽取 **Verify**: 后的内容，直到遇到下一个 **xxx**: 粗体字段或段结束。
 * 保留 bullet 形式；多行用 "; " 连接以便单行展示。
 */
function extractVerifyFromSection(section: string | null): string | null {
  if (!section) return null;
  const lines = section.split('\n');
  let verifyStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\*\*Verify\*\*\s*:/.test(lines[i])) { verifyStart = i; break; }
  }
  if (verifyStart === -1) return null;
  // 收集 verify 块
  const out: string[] = [];
  const firstLine = lines[verifyStart].replace(/^\*\*Verify\*\*\s*:\s*/, '').trim();
  if (firstLine) out.push(firstLine);
  for (let i = verifyStart + 1; i < lines.length; i++) {
    const ln = lines[i];
    // 遇到下一个粗体字段（**Xxx**:）或下一段空行结束
    if (/^\*\*\w+\*\*\s*:/.test(ln)) break;
    if (ln.trim() === '' && out.length > 0) {
      // 允许中间空行，但连续空行遇到粗体则停
      continue;
    }
    const bullet = ln.trim().replace(/^-\s*/, '');
    if (bullet) out.push(bullet);
  }
  return out.length > 0 ? out.join('; ') : null;
}

function renderFilesBlock(
  files:
    | {
        readonly modify: readonly string[];
        readonly create: readonly string[];
        readonly test: readonly string[];
      }
    | undefined,
): { modify: string; create: string; test: string } {
  const fmt = (arr: readonly string[] | undefined) =>
    arr && arr.length > 0 ? arr.join(', ') : '（未声明）';
  return {
    modify: fmt(files?.modify),
    create: fmt(files?.create),
    test: fmt(files?.test),
  };
}
