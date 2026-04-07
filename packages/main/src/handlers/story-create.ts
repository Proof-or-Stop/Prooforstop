
import type { HandlerContext } from './context.js';
import { collectContext, nextStoryId } from './context.js';
import type { StoryInfo, StoryPhase, StoryType } from '../core/types.js';

/**
 * 高风险关键词检测（OMX ralplan --deliberate 风格）。
 * 命中任一 pattern 时自动 elevate priority + 写 riskSignals。
 * story_review 看到 riskSignals 时强制要求 decision.json + ≥3 preMortem（决策 3 落地后生效）。
 */
const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\b(auth|authn|authz|security|password|token|secret|credential)\b/i, category: '安全/凭证' },
  { pattern: /\b(migration|schema migration|destructive|drop\s+table|truncate)\b/i, category: '数据迁移/破坏性' },
  { pattern: /\b(machine\.ts|state machine|guard|gate)\b/i, category: '状态机/门禁' },
  { pattern: /\b(fixture\s*runner|test_auto|cleanupFixtureDir)\b/i, category: 'test runner 框架' },
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
      checklist?: Array<{ title: string; context?: string; relatedDocs?: string[]; phase?: 'DEV' | 'TEST_CASE'; testIntent?: { happy: string[]; edge: string[]; adversarial: string[] } }>;
      prefix?: string;
      phase?: StoryPhase;
      forceNew?: boolean; // B-0af4 CHK-001: 绕过 idempotency 强制新建
    }): string {
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

      const storyId = nextStoryId(store, args.prefix);
      const now = new Date().toISOString();
      const hasChecklist = args.checklist && args.checklist.length > 0;

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
        lines.push('PLAN 阶段强制要求（高风险路径）:');
        lines.push('  - understanding_set 落 task 理解快照（unknowns/touchpoints 必填）');
        lines.push('  - decision_set 必须包含 ≥3 preMortem 场景');
        lines.push('  - story_review 通过（缺 decision 或 preMortem < 3 视为 blocker）');
        riskHint = lines.join('\n');
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
        // 注：直接指定 phase 路径走的是 onboard 等场景，正常不需要 riskHint，但保持一致
        if (hasChecklist) {
          const isDone = args.phase === 'DONE';
          const checklist = {
            items: args.checklist!.map((c: any, i: number) => ({
              id: `CHK-${String(i + 1).padStart(3, '0')}`,
              title: c.title,
              ...(c.context ? { context: c.context } : {}),
              ...(c.relatedDocs !== undefined ? { relatedDocs: c.relatedDocs } : {}),
              ...(c.phase !== undefined ? { phase: c.phase } : {}),
              ...(c.testIntent ? { testIntent: c.testIntent } : {}),
              status: (isDone ? 'done' : 'pending') as 'done' | 'pending',
              startTime: isDone ? now : null,
              endTime: isDone ? now : null,
            })),
          };
          store.writeChecklist(storyId, checklist);
        }
        return `Story ${storyId} created (${args.phase})${hasChecklist ? ` with ${args.checklist!.length} checklist items` : ''}${dupWarning}${riskHint}`;
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

      if (hasChecklist) {
        const checklist = {
          items: args.checklist!.map((c: any, i: number) => ({
            id: `CHK-${String(i + 1).padStart(3, '0')}`,
            title: c.title,
            ...(c.context ? { context: c.context } : {}),
            ...(c.relatedDocs !== undefined ? { relatedDocs: c.relatedDocs } : {}),
            ...(c.testIntent ? { testIntent: c.testIntent } : {}),
            status: 'pending' as const,
            startTime: null,
            endTime: null,
          })),
        };
        store.writeChecklist(storyId, checklist);
        const noContext = args.checklist!.filter((c: any) => !c.context).length;
        const noIntent = args.checklist!.filter((c: any) => !c.testIntent).length;
        const hints: string[] = [];
        if (noContext > 0) hints.push(`${noContext} 项缺少 context（根因/参考），建议补充`);
        if (noIntent > 0) hints.push(`${noIntent} 项缺少 testIntent（happy/edge/adversarial），建议补充后跑 story_review 审查`);
        const hint = hints.length > 0 ? '\n⚠ ' + hints.join('\n⚠ ') : '';
        return `Story ${storyId} created (INIT) with ${checklist.items.length} checklist items${hint}${dupWarning}${riskHint}`;
      }

      return `Story ${storyId} created (IDEA)${dupWarning}${riskHint}`;
    },
  };
}
