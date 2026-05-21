
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
import { withReentrantMainWriteLock } from '../core/main-write-lock.js';
import { resolveMainRepoRoot } from '../core/partial-done-recovery.js';
import { normalizeName, keywordOverlap } from '../core/story-dedup.js';

/**
 * B-6812 F-003: typed error raised when a keyword-full-overlap duplicate of an
 * ACTIVE non-terminal story is detected. The idempotency loop's catch block
 * must distinguish "this is the duplicate-guard rejection, re-throw it" from
 * "reading some unrelated story failed, swallow it" — a brittle
 * `message.startsWith(...)` prefix check silently changes behavior the moment
 * the message wording is edited and would also swallow genuine read failures
 * (OOM / fs permission) that happen to start with the same text. An
 * `instanceof` check on a dedicated class is wording-independent and only ever
 * matches the intentional rejection.
 */
export class DuplicateStoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateStoryError';
  }
}

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

/**
 * B-6812 CHK-003 (G4): how far back the "recently created concurrent story"
 * scan looks. Hardcoded constant on purpose — exposing it as a config option
 * would add a knob nobody tunes (YAGNI). 30 minutes is long enough to surface
 * a parallel agent racing the same backlog, short enough not to spam noise
 * from unrelated earlier work in the same session.
 */
const RECENT_CONCURRENT_WINDOW_MS = 30 * 60 * 1000;

/**
 * B-6812 CHK-003 (G4): after a successful create, scan for OTHER stories
 * created within the last 30 minutes that are still active (phase ∉
 * DONE/DISCARDED). If any exist, the operator likely has a parallel agent
 * working the same backlog — surface the list on stderr so it is visible even
 * under a `koala story_create | tail` pipe. Returns '' when nothing matches so
 * the caller never emits a false-positive line.
 *
 * `justCreatedId` is excluded so the freshly minted story does not list
 * itself. Unreadable / malformed story index files are skipped silently — one
 * corrupt index must not crash a successful create.
 */
function recentConcurrentStoriesNote(
  store: HandlerContext['store'],
  justCreatedId: string,
  nowMs: number,
): string {
  const recent: Array<{ id: string; phase: string; title: string }> = [];
  for (const sid of store.listStoryIds()) {
    if (sid === justCreatedId) continue;
    try {
      const other = store.readStory(sid);
      if (other.phase === 'DONE' || other.phase === 'DISCARDED') continue;
      const createdMs = Date.parse(other.createdAt);
      if (!Number.isFinite(createdMs)) continue;
      // Strictly within the window: createdMs must be at or after the cutoff
      // and not in the future relative to `nowMs`.
      if (createdMs < nowMs - RECENT_CONCURRENT_WINDOW_MS || createdMs > nowMs) continue;
      recent.push({ id: sid, phase: other.phase, title: other.title });
    } catch {
      /* ignore unreadable story */
    }
  }
  if (recent.length === 0) return '';
  const lines = [`⚠ 最近 30 分钟内还创建了 ${recent.length} 个 story：`];
  for (const r of recent) {
    lines.push(`  - ${r.id} [${r.phase}] ${r.title}`);
  }
  return lines.join('\n');
}

/**
 * B-6812 F-004: scan for DONE / DISCARDED (terminal) stories whose keyword set
 * FULLY overlaps the new story's keywords (ratio === 1 && shared >= 2). Active
 * non-terminal full overlap hard-blocks the create; terminal full overlap is
 * non-blocking but still worth surfacing — finishing a same-domain story is a
 * useful FYI ("you may be redoing work that just shipped"). plan.md CHK-002
 * and AGENTS.md both promise this warn, so the code must actually emit it
 * (silently `continue`-ing a terminal story produced zero output → doc drift).
 *
 * Returns '' when nothing matches so the caller never prints a blank line.
 * Unreadable / malformed story index files are skipped silently.
 */
function terminalKeywordOverlapNote(
  store: HandlerContext['store'],
  newKeywords: string[],
): string {
  if (newKeywords.length === 0) return '';
  const hits: Array<{ id: string; phase: string; title: string; shared: string[] }> = [];
  for (const sid of store.listStoryIds()) {
    try {
      const other = store.readStory(sid);
      if (other.phase !== 'DONE' && other.phase !== 'DISCARDED') continue;
      const overlap = keywordOverlap(newKeywords, other.keywords ?? []);
      if (overlap.ratio === 1 && overlap.shared.length >= 2) {
        hits.push({ id: sid, phase: other.phase, title: other.title, shared: overlap.shared });
      }
    } catch {
      /* ignore unreadable story */
    }
  }
  if (hits.length === 0) return '';
  const lines = ['⚠ keyword 与已完成 story 完全重叠（仅提示，不阻止创建）:'];
  for (const h of hits) {
    lines.push(`  - ${h.id} [${h.phase}] ${h.title} (共同关键词: ${h.shared.join(', ')})`);
  }
  return lines.join('\n');
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
      // B-6812 CHK-001 / B-f60c CHK-003: serialize the whole story_create body
      // (fromDraft branch + normal branch) so the idempotency scan →
      // nextStoryId → writeStory → writeChecklist sequence is atomic against
      // concurrent story_create invocations (closes the G1 TOCTOU window).
      //
      // B-f60c CHK-003: story_create writes shared main metadata, so per
      // session-ownership-and-write-leases.md it must serialize on the unified
      // MAIN WRITE LOCK (Rule 5) — not the former story-dir-scoped
      // `.create.lock`. The unified lock subsumes the old lock's job: every
      // concurrent story_create still contends on one directory, the dedup
      // scan still runs strictly inside the lock. The lock is reentrant so a
      // future shared-write command that nests story_create cannot self-
      // deadlock. Lock path resolves to the main repo root via
      // resolveMainRepoRoot (a worktree subdir falls back to the main root).
      const createLockMainRepoRoot = resolveMainRepoRoot(ctx.root);
      return withReentrantMainWriteLock(createLockMainRepoRoot, () => {
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
      // B-0af4 CHK-001 / B-6812 CHK-002: Idempotency check — 存在未 DONE/DISCARDED
      // 的语义重复 story 时返回已有 storyId（或对 keyword 完全重叠硬 block），
      // 而不是静默新建 duplicate。LLM 跨轮 session / 多 agent 并发跑同一 backlog
      // 时容易重复创建，这个护栏防止重复污染。forceNew=true 绕过整段检查。
      //
      // B-6812 CHK-002 把 G2 缺口（exact-name 漏过归一化差异 + keyword 重叠）补上：
      //  - normalized-name 匹配：normalizeName(name) 相等即视为同一 story。
      //    **仅当 normalizeName(args.name) 非空才参与匹配** —— 旧数据多 name 为
      //    空串/全特殊字符，归一化后为 ""，绝不能让两个空 normalized name 互相
      //    误判成同一个 story。
      //  - keyword 完全重叠 block：对 active non-terminal story（phase ∉
      //    DONE/DISCARDED）算 keywordOverlap；ratio === 1 且 shared.length >= 2
      //    时抛错要求 forceNew:true。DONE/DISCARDED story 的完全重叠仅 warn（见
      //    下方关键词查重段，CHK-003 统一改走 stderr）。
      if (!args.forceNew) {
        const normNewName = normalizeName(args.name);
        const newKeywords = args.keywords ?? [];
        for (const sid of store.listStoryIds()) {
          try {
            const other = store.readStory(sid);
            if (other.phase === 'DONE' || other.phase === 'DISCARDED') continue;

            // 1) normalized-name idempotency. Empty normalized name never
            // participates: an empty new name OR an empty stored name is a
            // fallback, not a match key.
            const normOtherName = normalizeName(other.name);
            if (normNewName.length > 0 && normNewName === normOtherName) {
              // 找到同名（归一化后相等）未完成 story → 返回已有
              return [
                `⚠ Story already exists: ${sid} (name="${other.name}", phase=${other.phase})`,
                `归一化 name "${normNewName}" 与已有 story 一致；复用已有 storyId 而非新建。如需强制新建，传 forceNew:true。`,
                `已有 story: ${sid} [${other.phase}] ${other.title}`,
                `→ story_get '{"storyId":"${sid}"}' 查看详情`,
                `→ story_advance '{"storyId":"${sid}","phase":"<next>"}' 继续推进`,
              ].join('\n');
            }

            // 2) keyword 完全重叠 → 对 active non-terminal story 硬 block。
            // ratio === 1 表示新 story 的每个 keyword 都被已有 story 覆盖；
            // shared.length >= 2 避免单 keyword 巧合命中误伤。
            const overlap = keywordOverlap(newKeywords, other.keywords ?? []);
            if (overlap.ratio === 1 && overlap.shared.length >= 2) {
              throw new DuplicateStoryError(
                `❌ 疑似重复 story ${sid}（keyword 完全重叠: ${overlap.shared.join(', ')}），` +
                `确认要新建请加 forceNew:true`,
              );
            }
          } catch (e: any) {
            // B-6812 F-003: the duplicate-guard rejection must propagate; only
            // genuine read errors on unrelated stories may be swallowed so one
            // corrupt index.json cannot mask the guard. An `instanceof`
            // check on a typed error is wording-independent and never
            // mis-swallows a real failure (OOM / fs permission) that happens
            // to start with the same text.
            if (e instanceof DuplicateStoryError) {
              throw e;
            }
            /* ignore unreadable story */
          }
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

      // B-6812 CHK-003 (G3): advisory text — riskHint, keyword-overlap
      // dupWarning — is collected here but written to STDERR right before the
      // create result is returned, never spliced into the stdout return value.
      // Rationale: `koala story_create | tail` silently swallows stdout tail
      // lines; the create conclusion (`Story B-xxxx created ...`) must stay on
      // stdout as the command's return value, while duplicate / concurrency
      // warnings must survive pipes by going to stderr (matches the existing
      // normal-channel DEPRECATED warning above).

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
          dupWarning = '⚠ 疑似重复 story（关键词重叠）:\n' +
            overlaps.map(o => `  - ${o.id} [${o.phase}] ${o.title} (共同关键词: ${o.common.join(', ')})`).join('\n');
        }
      }

      /**
       * B-6812 CHK-003 (G3 + G4) + F-004: emit all advisory text to STDERR
       * right before returning the create conclusion. `riskHint` and
       * `dupWarning` (G3) are collected earlier; the recent-concurrent-stories
       * note (G4) and the terminal-keyword-overlap note (F-004) are computed
       * here against the freshly written story so `justCreatedId` is already
       * on disk and excluded from the scans. Each block is trimmed and skipped
       * when empty so we never print blank stderr lines. The create conclusion
       * stays on stdout via the return value.
       */
      const emitAdvisoryToStderr = (): void => {
        const blocks: string[] = [];
        if (riskHint.trim().length > 0) blocks.push(riskHint.trim());
        if (dupWarning.trim().length > 0) blocks.push(dupWarning.trim());
        const concurrentNote = recentConcurrentStoriesNote(store, storyId, Date.parse(now));
        if (concurrentNote.length > 0) blocks.push(concurrentNote);
        // B-6812 F-004: keyword full overlap with a DONE/DISCARDED story is
        // non-blocking but still surfaced as a same-domain FYI on stderr —
        // plan.md CHK-002 + AGENTS.md promise this warn, so it must be emitted.
        const terminalNote = terminalKeywordOverlapNote(store, args.keywords ?? []);
        if (terminalNote.length > 0) blocks.push(terminalNote);
        if (blocks.length > 0) {
          process.stderr.write(blocks.join('\n') + '\n');
        }
      };

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
        // B-6812 CHK-003 (G3): duplicate / concurrency warnings go to stderr;
        // only the create conclusion + non-advisory guidance stays on stdout.
        emitAdvisoryToStderr();
        return `Story ${storyId} created (${args.phase})${hasChecklist ? ` with ${args.checklist!.length} checklist items` : ''}${riskHint}${nonGitHint}`;
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
        // B-6812 CHK-003 (G3): duplicate / concurrency warnings go to stderr;
        // the create conclusion + INIT-review guidance stays on stdout.
        emitAdvisoryToStderr();
        return `Story ${storyId} created (INIT) with ${checklist.items.length} checklist items${hint}${riskHint}${initReviewHint}${nonGitHint}`;
      }

      // B-6812 CHK-003 (G3): duplicate / concurrency warnings go to stderr.
      emitAdvisoryToStderr();
      return `Story ${storyId} created (IDEA)`;
      // story_create is a sub-second critical section: concurrent callers must
      // SERIALIZE-AND-WAIT (every invocation completes, the loser then hits the
      // idempotency reuse branch) — never fail-fast. This preserves the
      // pre-B-f60c "winner creates, the rest reuse, all exit 0" contract that
      // story-create-concurrency-smoke asserts.
      }, { label: 'story_create', onContention: 'wait' });
    },
  };
}
