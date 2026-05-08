
import type { HandlerContext } from './context.js';
import { collectContext, nextStoryId } from './context.js';
import type { StoryInfo, StoryPhase, StoryType, VerificationIntent } from '../core/types.js';
import { validateBackground } from '../core/background-validator.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { computeDraftCheckHash } from '../core/draft-check-hash.js';
import { computeChecklistHash } from './init-check.js';
import { isGitRepository } from '../core/git-probe.js';

/**
 * 高风险关键词检测（OMX ralplan --deliberate 风格）。
 * 命中任一 pattern 时自动 elevate priority + 写 riskSignals。
 * story_review 看到 riskSignals 时强制要求 decision.json + ≥3 preMortem（决策 3 落地后生效）。
 */
const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\b(auth|authn|authz|security|password|token|secret|credential)\b/i, category: '安全/凭证' },
  { pattern: /\b(migration|schema migration|destructive|drop\s+table|truncate)\b/i, category: '数据迁移/破坏性' },
  { pattern: /\b(machine\.ts|state machine|phase flow|story_advance|DONE gate|TEST gate|guard logic)\b/i, category: '状态机/门禁' },
  { pattern: /\b(validate\.ts|koala validate|validation protocol|verifier|fixture runner|test\s*runner|test_auto)\b/i, category: '验证框架' },
  { pattern: /\b(git\s+(restore|reset|clean|push --force))\b/i, category: 'git 破坏性操作' },
  { pattern: /\b(production|incident|hotfix|p0|p1)\b/i, category: '生产环境/紧急' },
  { pattern: /\b(PII|personally identifiable|GDPR|compliance)\b/i, category: '合规/隐私' },
  { pattern: /\b(public api|api break|breaking change)\b/i, category: '破坏性 API 变更' },
];

function detectRiskSignals(text: string): Array<{ category: string; matched: string }> {
  const hits: Array<{ category: string; matched: string }> = [];
  const seen = new Set<string>();
  for (const { pattern, category } of HIGH_RISK_PATTERNS) {
    const m = text.match(pattern);
    if (m && !seen.has(category)) {
      hits.push({ category, matched: m[0] });
      seen.add(category);
    }
  }
  return hits;
}

export function createStoryCreateHandlers(ctx: HandlerContext) {
  const { store } = ctx;

  return {
    story_create(args: {
      name: string;
      title: string;
      description: string;
      type: StoryType;
      priority: string;
      source?: string;
      depends?: string[];
      keywords?: string[];
      checklist?: Array<{ title: string; context?: string; relatedDocs?: string[]; userSees?: string; excludes?: string[]; verificationIntent?: VerificationIntent }>;
      prefix?: string;
      phase?: StoryPhase;
      forceNew?: boolean; // B-0af4 CHK-001: 绕过 idempotency 强制新建
      background?: string; // B-45ed CHK-006: 必填四段式 background.md 内容
      fromDraft?: string; // B-9975 CHK-003: from-draft mode
    }): string {
      // === B-9975 CHK-003: FROM-DRAFT MODE ===
      // When fromDraft is provided, bypass normal creation path entirely.
      if (args.fromDraft) {
        const draftName = args.fromDraft;
        const draftsDir = join(ctx.root, 'docs', 'story', 'drafts', draftName);

        // 1. Check draft exists
        if (!existsSync(draftsDir)) {
          throw new Error(`Draft '${draftName}' not found at docs/story/drafts/${draftName}/`);
        }

        // 2. Read draft files
        const draftIndex = JSON.parse(readFileSync(join(draftsDir, 'index.json'), 'utf-8'));
        const draftBg = readFileSync(join(draftsDir, 'background.md'), 'utf-8');
        const draftChecklist = JSON.parse(readFileSync(join(draftsDir, 'checklist.json'), 'utf-8'));

        // 3. GATE 1: missing_draft_check
        const draftCheckPath = join(draftsDir, 'draft-check.json');
        if (!existsSync(draftCheckPath)) {
          throw new Error(
            `Cannot create story from draft '${draftName}': draft-check.json 不存在。` +
            `请先 spawn koala-review-story-init reviewer 对 draft 审查并调 draft_check_set。 [missing_draft_check]`
          );
        }
        const draftCheck = JSON.parse(readFileSync(draftCheckPath, 'utf-8'));

        // 4. GATE 2: draft_check_tampered
        const bgHash = createHash('sha256').update(draftBg).digest('hex');
        const clItems = draftChecklist.items.map((i: any) => ({ title: i.title, context: i.context ?? '' }));
        const clHash = computeChecklistHash(clItems);
        const expectedHash = computeDraftCheckHash(
          draftName, bgHash, draftIndex.title, draftIndex.description, clHash, draftCheck.reviewRound || ''
        );

        if (draftCheck._hash !== expectedHash) {
          throw new Error(
            `Cannot create story from draft '${draftName}': draft-check.json _hash 失配` +
            `（背景/标题/描述/checklist 已被修改），请重跑 reviewer。 [draft_check_tampered]`
          );
        }

        // 5. GATE 3: draft_check_blocking_issues
        const blockingSeverities = ['critical', 'high'];
        const blockingIssues = (draftCheck.issues || []).filter((issue: any) =>
          blockingSeverities.includes(issue.severity) &&
          !(draftCheck.resolutions && draftCheck.resolutions[issue.id])
        );
        if (blockingIssues.length > 0) {
          const ids = blockingIssues.map((i: any) => i.id || 'unknown').join(', ');
          throw new Error(
            `Cannot create story from draft '${draftName}': ${blockingIssues.length} blocking issue(s) 未 resolve: ${ids}。` +
            `请用 draft_issue_resolve 逐条响应后重试。 [draft_check_blocking_issues]`
          );
        }

        // 6. All gates passed — materialize!
        const storyId = nextStoryId(store, args.prefix);
        const now = new Date().toISOString();

        // Detect risk signals from description + checklist
        const scanText = [draftIndex.description, ...draftChecklist.items.map((c: any) => c.title + ' ' + (c.context ?? ''))].join('\n');
        const riskSignals = detectRiskSignals(scanText);
        let priority = draftIndex.priority || 'medium';
        if (riskSignals.length > 0) {
          const order = ['low', 'medium', 'high', 'critical'];
          const curIdx = order.indexOf(priority);
          if (curIdx < order.indexOf('high')) priority = 'high';
        }

        // Write story to actives
        const story: StoryInfo = {
          storyId,
          name: draftIndex.name,
          title: draftIndex.title,
          description: draftIndex.description,
          type: draftIndex.type || 'feature',
          phase: 'INIT_CHECK' as StoryPhase,
          priority,
          ...(draftIndex.keywords?.length > 0 ? { keywords: draftIndex.keywords } : {}),
          ...(riskSignals.length > 0 ? { riskSignals } : {}),
          createdAt: now,
          startedAt: now,
          endedAt: null,
          events: [collectContext('INIT_CHECK', 'create')],
        };
        store.writeStory(storyId, story);

        // Write background.md
        const storyDir = store.storyDirPath(storyId);
        if (!existsSync(storyDir)) mkdirSync(storyDir, { recursive: true });
        const bgContent = draftBg.endsWith('\n') ? draftBg : draftBg + '\n';
        writeFileSync(join(storyDir, 'background.md'), bgContent, 'utf-8');

        // Write checklist.json (reuse draft's checklist items)
        store.writeChecklist(storyId, draftChecklist);

        // Delete draft directory
        rmSync(draftsDir, { recursive: true, force: true });

        return `Story ${storyId} created from draft '${draftName}' (phase=INIT_CHECK)\n→ draft '${draftName}' 已删除\n→ story_advance '{"storyId":"${storyId}","phase":"PLAN"}' 进 PLAN`;
      }

      // B-45ed CHK-006: background 必填 + 四段式校验。
      // 只在"新建 story"路径上强校验；走 idempotency 复用分支不需要 background。
      // 我们先查 idempotency（见下），若复用已有 story 则 return，不触及 background。
      // 新建分支（通过 idempotency 之后）对 background 做硬校验 + 落盘。
      // B-0af4 CHK-001: Idempotency check — 同 name 且存在未 DONE/DISCARDED 的
      // story 时返回已有 storyId + 明确 warning，而不是静默新建 duplicate。
      // LLM 跨轮 session 里容易忘记已经创建过，这个护栏防止重复污染。
      // 严格 name 完全相等时触发；forceNew=true 绕过。
      if (!args.forceNew) {
        for (const sid of store.listStoryIds()) {
          try {
            const other = store.readStory(sid);
            if (other.phase === 'DONE' || other.phase === 'DISCARDED') continue;
            if (other.name !== args.name) continue;
            // 找到同名未完成 story → 返回已有
            return [
              `⚠ Story already exists: ${sid} (name="${args.name}", phase=${other.phase})`,
              `复用已有 storyId 而非新建。如需强制新建，传 forceNew:true。`,
              `已有 story: ${sid} [${other.phase}] ${other.title}`,
              `→ story_get '{"storyId":"${sid}"}' 查看详情`,
              `→ story_advance '{"storyId":"${sid}","phase":"<next>"}' 继续推进`,
            ].join('\n');
          } catch { /* ignore unreadable */ }
        }
      }

      // Runtime validation for non-fromDraft path: these fields are required
      const missing = ['name','title','description','type','priority'].filter(k => !(args as any)[k]);
      if (missing.length > 0) {
        throw new Error(`story_create 非 fromDraft 模式下必填字段缺失: ${missing.join(', ')}`);
      }

      // B-45ed CHK-006: background 必填 + 四段式格式校验（硬下限）
      if (typeof args.background !== 'string' || args.background.length === 0) {
        throw new Error(
          'story_create 需 background 字段（四段式格式）\n' +
          '期望 4 段: "## 触发事件" / "## 关键洞察" / "## 方案取舍" / "## 对话纹理"\n' +
          '硬下限: 每段 ≥ 50 字符 + 总长 ≥ 300 字符 + 触发事件段含 id 正则\n' +
          '(B-[a-z0-9]{4} / F-\\d+ / CHK-\\d+ / commit hash / YYYY-MM-DD)'
        );
      }
      const bgResult = validateBackground(args.background);
      if (!bgResult.ok) {
        throw new Error(
          'background 格式校验失败:\n' +
          bgResult.errors.map(e => `  - ${e}`).join('\n') + '\n' +
          '期望 4 段: "## 触发事件" / "## 关键洞察" / "## 方案取舍" / "## 对话纹理"\n' +
          '每段 ≥ 50 字符，总长 ≥ 300 字符，触发事件段须含具体编号'
        );
      }

      const storyId = nextStoryId(store, args.prefix);
      const now = new Date().toISOString();
      const hasChecklist = args.checklist && args.checklist.length > 0;

      // B-45ed CHK-006: 落盘 background.md 到 docs/story/actives/{storyId}/background.md
      const writeBackground = () => {
        const storyDir = store.storyDirPath(storyId);
        if (!existsSync(storyDir)) mkdirSync(storyDir, { recursive: true });
        const bgPath = join(storyDir, 'background.md');
        // 保证以换行结尾，与 JSON 产物惯例一致
        const content = args.background!.endsWith('\n') ? args.background! : args.background! + '\n';
        writeFileSync(bgPath, content, 'utf-8');
      };

      // 高风险关键词检测：扫描 description + checklist titles
      const scanText = [
        args.description,
        ...(args.checklist ?? []).map(c => c.title + ' ' + (c.context ?? '')),
      ].join('\n');
      const riskSignals = detectRiskSignals(scanText);
      let elevatedPriority = args.priority;
      let riskHint = '';
      if (riskSignals.length > 0) {
        // 自动 elevate 到 high。已知 priority 列表里如果 < high 则升 high；
        // 不在列表里（如 P0/urgent 之类未规范值）直接覆盖成 high，并提示规范化。
        const order = ['low', 'medium', 'high', 'critical'];
        const curIdx = order.indexOf(args.priority);
        if (curIdx === -1) {
          elevatedPriority = 'high';
        } else if (curIdx < order.indexOf('high')) {
          elevatedPriority = 'high';
        }
        const lines = ['', '⚠ 检测到高风险信号:'];
        for (const r of riskSignals) {
          lines.push(`  - ${r.category}: "${r.matched}"`);
        }
        if (elevatedPriority !== args.priority) {
          lines.push(`已自动 elevate priority: ${args.priority} → ${elevatedPriority}`);
        }
        lines.push('说明：riskSignals 命中后按有效 high-risk priority 处理，即使原始 priority=low 也会触发高风险 gate。');
        lines.push('PLAN 阶段强制要求（高风险路径）:');
        lines.push('  - understanding_set 落 task 理解快照（unknowns/touchpoints 必填）');
        lines.push('  - decision_set 必须包含 ≥3 preMortem 场景');
        lines.push('  - story_review 通过（缺 decision 或 preMortem < 3 视为 blocker）');
        riskHint = lines.join('\n');
      }

      // B-9975 CHK-004: legacy one-step mode deprecation warning for normal-channel stories
      {
        const itemCount = args.checklist?.length ?? 0;
        let channel: 'express' | 'fast' | 'normal';
        if (riskSignals.length > 0) {
          channel = 'normal';
        } else if (itemCount <= 2) {
          channel = 'express';
        } else if (itemCount <= 5) {
          channel = 'fast';
        } else {
          channel = 'normal';
        }
        if (channel === 'normal') {
          process.stderr.write(
            '⚠ [DEPRECATED] normal 通道 story 建议使用 story_draft + story_create --from-draft 两阶段模式。\n' +
            '  直接 story_create 将在后续版本对 normal 通道硬 block。\n'
          );
        }
      }

      // 关键词查重：与已有非 DONE/DISCARDED story 比较 keywords
      let dupWarning = '';
      if (args.keywords && args.keywords.length > 0) {
        const overlaps: Array<{ id: string; title: string; phase: string; common: string[] }> = [];
        for (const sid of store.listStoryIds()) {
          try {
            const other = store.readStory(sid);
            if (other.phase === 'DONE' || other.phase === 'DISCARDED') continue;
            if (!other.keywords || other.keywords.length === 0) continue;
            const common = args.keywords.filter(k => other.keywords!.includes(k));
            if (common.length > 0) {
              overlaps.push({ id: sid, title: other.title, phase: other.phase, common });
            }
          } catch { /* ignore */ }
        }
        if (overlaps.length > 0) {
          dupWarning = '\n⚠ 疑似重复 story（关键词重叠）:\n' +
            overlaps.map(o => `  - ${o.id} [${o.phase}] ${o.title} (共同关键词: ${o.common.join(', ')})`).join('\n');
        }
      }

      // 直接指定 phase（onboard 用：已完成模块直接标 DONE）
      if (args.phase) {
        const story: StoryInfo = {
          storyId,
          name: args.name,
          title: args.title,
          description: args.description,
          type: args.type,
          phase: args.phase,
          priority: elevatedPriority,
          ...(args.source ? { source: args.source } : {}),
          ...(args.depends && args.depends.length > 0 ? { depends: args.depends } : {}),
          ...(args.keywords && args.keywords.length > 0 ? { keywords: args.keywords } : {}),
          ...(riskSignals.length > 0 ? { riskSignals } : {}),
          createdAt: now,
          startedAt: args.phase !== 'IDEA' ? now : null,
          endedAt: args.phase === 'DONE' ? now : null,
          events: [collectContext(args.phase, 'create')],
        };
        store.writeStory(storyId, story);
        writeBackground();
        // 注：直接指定 phase 路径走的是 onboard 等场景，正常不需要 riskHint，但保持一致
        if (hasChecklist) {
          const isDone = args.phase === 'DONE';
          const checklist = {
            items: args.checklist!.map((c: any, i: number) => ({
              id: `CHK-${String(i + 1).padStart(3, '0')}`,
              title: c.title,
              ...(c.context ? { context: c.context } : {}),
              ...(c.relatedDocs !== undefined ? { relatedDocs: c.relatedDocs } : {}),
              ...(c.userSees ? { userSees: c.userSees } : {}),
              ...(c.excludes !== undefined ? { excludes: c.excludes } : {}),
              ...(c.verificationIntent !== undefined ? { verificationIntent: c.verificationIntent } : {}),
              ...(c.phase !== undefined ? { phase: c.phase } : {}),
              status: (isDone ? 'done' : 'pending') as 'done' | 'pending',
              startTime: isDone ? now : null,
              endTime: isDone ? now : null,
            })),
          };
          store.writeChecklist(storyId, checklist);
        }
        const nonGitHint = !isGitRepository(ctx.root)
          ? `\n⚠ 当前目录不是 git 仓库：story 已记录，但 branch/worktree phase 还不可用。要继续 INIT_CHECK/DEV 正常流，先 git init + 首次 commit。`
          : '';
        return `Story ${storyId} created (${args.phase})${hasChecklist ? ` with ${args.checklist!.length} checklist items` : ''}${dupWarning}${riskHint}${nonGitHint}`;
      }

      // 正常模式：有 checklist → INIT（之后 story_advance INIT_CHECK 创建 worktree → PLAN）
      const phase: StoryPhase = hasChecklist ? 'INIT' : 'IDEA';
      const story: StoryInfo = {
        storyId,
        name: args.name,
        title: args.title,
        description: args.description,
        type: args.type,
        phase,
        priority: elevatedPriority,
        ...(args.source ? { source: args.source } : {}),
        ...(args.depends && args.depends.length > 0 ? { depends: args.depends } : {}),
        ...(args.keywords && args.keywords.length > 0 ? { keywords: args.keywords } : {}),
        ...(riskSignals.length > 0 ? { riskSignals } : {}),
        createdAt: now,
        startedAt: hasChecklist ? now : null,
        endedAt: null,
        events: [collectContext(phase, 'create')],
      };
      store.writeStory(storyId, story);
      writeBackground();

      if (hasChecklist) {
        const checklist = {
          items: args.checklist!.map((c: any, i: number) => ({
            id: `CHK-${String(i + 1).padStart(3, '0')}`,
            title: c.title,
            ...(c.context ? { context: c.context } : {}),
            ...(c.relatedDocs !== undefined ? { relatedDocs: c.relatedDocs } : {}),
            ...(c.userSees ? { userSees: c.userSees } : {}),
            ...(c.excludes !== undefined ? { excludes: c.excludes } : {}),
            ...(c.verificationIntent !== undefined ? { verificationIntent: c.verificationIntent } : {}),
            status: 'pending' as const,
            startTime: null,
            endTime: null,
          })),
        };
        store.writeChecklist(storyId, checklist);
        const noContext = args.checklist!.filter((c: any) => !c.context).length;
        const hints: string[] = [];
        if (noContext > 0) hints.push(`${noContext} 项缺少 context（根因/参考），建议补充`);
        const hint = hints.length > 0 ? '\n⚠ ' + hints.join('\n⚠ ') : '';
        // B-e71f CHK-004: INIT→INIT_CHECK 硬门槛引导。
        // INIT 阶段必须由独立 subagent 审查 background + checklist 初版，主 agent 不得自调
        // init_check_set 伪造签名（反自豁免）。审查通过后才能 story_advance INIT_CHECK。
        const initReviewHint =
          `\n\n→ 现在请并行 spawn 两个 INIT reviewer：\n` +
          `  · Agent({ subagent_type: "koala-review-story-init", prompt: \`审查 story ${storyId} 的 background + checklist 初版（运行 koala dispatch '{"storyId":"${storyId}","agentType":"koala-review-story-init"}' 取标准 prompt）\` })\n` +
          `  · Agent({ subagent_type: "product-reviewer", prompt: \`运行 koala dispatch '{"storyId":"${storyId}","agentType":"product-reviewer"}' 取标准 prompt；无论 pass/fail 都必须调用 init_check_set，agentId 必须精确为 product-reviewer\` })\n` +
          `  · 不要主 agent 自调 koala init_check_set（CLI 不做 agentId 机械校验，但 reviewer 模板 fresh-context fence + CLAUDE.md 行为规约要求由独立 subagent 调用——主 agent 自调相当于绕过 reviewer，违反反自豁免约定）\n` +
          `  · 如果 reviewer 4 分钟无输出，视为卡住：重新运行 koala dispatch 获取 prompt 后重启 reviewer；旧 reviewer 若之后返回，以最新 init_check_set 为准\n` +
          `  · INIT_CHECK gate 要求 koala-review-story-init 与 product-reviewer 都已通过 init_check_set 落盘；critical/high issue 会阻塞推进\n` +
          `  · 审查通过后调 koala story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}' 进 INIT_CHECK`;
        const nonGitHint = !isGitRepository(ctx.root)
          ? `\n⚠ 当前目录不是 git 仓库：story 已记录，但 INIT_CHECK/worktree 流程仍需先 git init + 首次 commit。`
          : '';
        return `Story ${storyId} created (INIT) with ${checklist.items.length} checklist items${hint}${dupWarning}${riskHint}${initReviewHint}${nonGitHint}`;
      }

      return `Story ${storyId} created (IDEA)${dupWarning}${riskHint}`;
    },
  };
}
