/**
 * koala CLI 引擎
 *
 * 把 dispatch / parse / log / phase gate 这些通用逻辑包成可调用的 runCli 函数。
 * main 自己的 cli.ts 是 bin 入口，直接调 runCli()；
 * 第三方 bootstrap 脚本可以在 runCli({extraTools, extraRegister}) 时把 utils
 * 的工具和 handler 一起合进来。
 */

import { z, ZodType, ZodOptional, ZodEnum, ZodArray, ZodUnion, ZodString, ZodBoolean, ZodNumber, ZodObject } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { appendActivityLog } from './core/activity-log.js';
import { inferActivityRole } from './core/activity-role.js';
import { join } from 'path';
import { StoryStore } from './core/store.js';
import { createMainRegistry, type Registry } from './registry.js';
import type { HandlerContext } from './handlers/context.js';
import { execSync } from 'child_process';
import { loadConfig, isCommandAllowed, getAllowedPatterns } from './core/config.js';
import { formatCommandLifecycleHint } from './core/command-policy.js';
import { decorateResult, type ActiveStoryInfo } from './handlers/hints.js';
import { reportHealthIssue } from './core/health.js';
import { detectStaleState } from './core/stale-detector.js';
import { runHooks, truncateForEnv, buildHookEnv as buildSharedHookEnv, HOOK_TIMEOUT_MS } from './core/hooks.js';
import { gitProbe, isGitRepository } from './core/git-probe.js';
import { STORY_OUTCOME_KINDS, VERIFICATION_EVIDENCE_VERDICTS } from './core/types.js';
import {
  STORY_CREATE_LONG, STORY_ADVANCE_LONG, CHECKLIST_UPDATE_LONG,
  STORY_REVIEW_LONG, BUG_REPORT_LONG, VALIDATE_LONG,
  SESSION_BRIEF_FOOTER,
} from './cli-prompts.js';

// ── Tool Registry ──

export interface ToolDef {
  name: string;
  /** 一行描述（出现在 koala help 列表里） */
  description: string;
  /** 完整 PROMPT（出现在 koala <cmd> --help 里）。可选；缺省时只显示 description */
  longHelp?: string;
  schema: Record<string, ZodType>;
}

const verificationIntentTypeSchema = z.preprocess((value) => {
  if (value === 'cli_blackbox') return 'cli';
  if (value === 'browser_blackbox') return 'browser';
  return value;
}, z.enum(['logic', 'cli', 'browser', 'manual', 'docs']));

/**
 * @task B-ef9c
 * @checklist CHK-003
 * @title normalize legacy verificationIntent type aliases
 * @type feature
 * @priority high
 * @description
 *   The shared CLI schema accepts legacy verificationIntent aliases before enum
 *   validation, so story_create, checklist_add, and checklist_update all parse
 *   cli_blackbox/browser_blackbox and persist the normalized cli/browser types.
 * @changes
 *   - [CHK-003] Map cli_blackbox to cli and browser_blackbox to browser in the shared schema
 *   - [CHK-003] Keep old testIntent types untouched; only verificationIntent is normalized
 */
const verificationIntentItemSchema = z.object({
  id: z.string().optional().describe('可选稳定 id；缺省时自动按 CHK-001:happy:0 推导'),
  desc: z.string().describe('验证意图描述'),
  type: verificationIntentTypeSchema.describe('验证类型'),
  requiredIn: z.enum(['light', 'balanced', 'strict']).optional().describe('从哪个 workflow profile 起要求'),
  priority: z.enum(['must', 'should', 'nice']).optional().describe('must 会进入 evidence gate'),
});

/**
 * @task B-ef9c
 * @checklist CHK-001
 * @title automated interface owns workflow extension
 * @type feature
 * @priority high
 * @description
 *   Koala exposes code/story operations through a managed automated interface:
 *   people and AI both go through CLI schemas, command gates, handlers, and logs.
 *   Superpowers can trigger workflow by registering extra tools and handlers, but
 *   main command definitions win because MAIN_TOOLS are searched before extras.
 *   更准确的说法是代码应该是被一个自动化的接口所管理的，人和ai都是通过这个接口来操作代码。
 * @changes
 *   - [CHK-001] Preserve CLI schema/handler dispatch as the operation interface for humans and AI
 *   - [CHK-001] Allow superpowers to trigger workflow through extraRegister without redefining core workflow
 */

const verificationIntentSchema = z.object({
  happy: z.array(verificationIntentItemSchema).optional().default([]),
  edge: z.array(verificationIntentItemSchema).optional().default([]),
  adversarial: z.array(verificationIntentItemSchema).optional().default([]),
});

const verificationEvidenceKindSchema = z.enum([
  'logic_test',
  'integration_test',
  'browser_test',
  'manual_transcript',
  'docs_check',
  'waiver',
  'cli',
  'logic',
]).describe('证据类型；aliases: cli→manual_transcript, logic→logic_test');

const verificationEvidenceSchema = z.object({
  intentRef: z.string().describe('如 CHK-001:happy:0 或自定义 intent id'),
  kind: verificationEvidenceKindSchema,
  verdict: z.enum(VERIFICATION_EVIDENCE_VERDICTS).optional().describe('证据结论语义；不覆盖 result pass/fail gate'),
  waiverType: z.enum(['permanent', 'deferred_gate_evidence']).optional().describe('kind=waiver 时可标记为临时 gate 自测 evidence；后续 validate 会要求替换真实证据'),
  file: z.string().optional().describe('测试/文档文件路径'),
  command: z.string().optional().describe('执行命令'),
  result: z.enum(['pass', 'fail']).optional().describe('执行结果'),
  note: z.string().describe('为什么此证据覆盖该 intent'),
  headHash: z.string().optional().describe('记录证据时的 git HEAD'),
  materialHash: z.string().optional().describe('记录证据时的非 story-metadata 实体文件哈希'),
  timestamp: z.string().optional().describe('记录时间'),
});

const storyTypeSchema = z.preprocess((value) => {
  if (value === 'test') return 'chore';
  return value;
}, z.enum(['feature','bug','refactor','chore']));

/** main 自带的 CLI 工具定义 */
export const MAIN_TOOLS: ToolDef[] = [
  // Story
  { name: 'story_create', description: '创建 Story 条目', longHelp: STORY_CREATE_LONG, schema: {
    name: z.string().optional().describe('短名称'),
    title: z.string().optional().describe('标题'),
    description: z.string().optional().describe('描述'),
    type: storyTypeSchema.optional().describe('类型；test 会归一为 chore'),
    priority: z.string().optional().describe('优先级'),
    source: z.string().optional().describe('来源'),
    depends: z.array(z.string()).optional().describe('依赖 Story ID'),
    keywords: z.array(z.string()).optional().describe('关键词（领域/模块/概念，用于查重）'),
    checklist: z.array(z.object({ title: z.string(), context: z.string().optional(), relatedDocs: z.array(z.string()).optional().describe('关联文档路径（用于三次提醒）'), userSees: z.string().optional().describe('用户可见输出'), excludes: z.array(z.string()).optional().describe('显式声明不做的功能点'), verificationIntent: verificationIntentSchema.optional().describe('happy/edge/adversarial 验证意图') })).optional().describe('开发清单'),
    prefix: z.string().optional().describe('ID 前缀(默认 B)'),
    phase: z.enum(['IDEA','INIT','INIT_CHECK','PLAN','DEV','REVIEW','TEST','DONE']).optional().describe('直接指定阶段'),
    forceNew: z.boolean().optional().describe('B-0af4: 绕过同名 story idempotency 强制新建（同名未完成 story 默认会被复用）'),
    background: z.string().optional().describe('B-45ed CHK-006: 四段式 background.md 内容。需含 "## 触发事件" / "## 关键洞察" / "## 方案取舍" / "## 对话纹理" 4 段，每段 ≥ 50 字符，总长 ≥ 300，触发事件段须含具体编号（B-xxxx / F-xxx / CHK-xxx / commit hash / YYYY-MM-DD）。fromDraft 模式下不需要'),
    fromDraft: z.string().optional().describe('B-9975: 从已审查的 draft 创建 story（传 draft name）。三层 gate 校验后直接进 INIT_CHECK'),
  }},
  { name: 'story_advance', description: '推进 Story 到下一阶段', longHelp: STORY_ADVANCE_LONG, schema: {
    storyId: z.string().describe('Story ID'), phase: z.enum(['IDEA','INIT','INIT_CHECK','PLAN','DEV','REVIEW','TEST','DONE']).describe('目标阶段'),
    checklist: z.array(z.object({ id: z.string(), title: z.string() })).optional().describe('开发清单'),
    dryRun: z.boolean().optional().describe('只预览 INIT_CHECK bootstrap，不推进 phase/创建 worktree'),
    confirm: z.boolean().optional().describe('确认执行有副作用的推进（兼容脚本参数）'),
  }},
  { name: 'story_update', description: '编辑 Story 信息', schema: {
    storyId: z.string().describe('Story ID'), title: z.string().optional().describe('新标题'),
    description: z.string().optional().describe('新描述'), priority: z.string().optional().describe('新优先级'),
  }},
  { name: 'story_get', description: '读取 Story 详情', schema: { storyId: z.string().describe('Story ID'), detail: z.boolean().optional().describe('附带 index.json 全字段（phase/priority/name/description/...）到 result.index') }},
  { name: 'story_list', description: '列出全部 Story', schema: {
    phase: z.enum(['IDEA','INIT','INIT_CHECK','PLAN','DEV','REVIEW','TEST','DONE','DISCARDED']).optional().describe('按阶段过滤（与 active 互斥）'),
    active: z.boolean().optional().describe('仅列出非终态 story（排除 DONE/DISCARDED/IDEA）。B-89c7 CHK-016 新增'),
  }},
  { name: 'story_reconcile', description: '检测并修复僵尸 story / 终态 worktree residue（默认 dry run）', schema: {
    dryRun: z.boolean().optional().describe('true=只报告；false=执行修复（默认 true）'),
  }},
  { name: 'story_discard', description: '废弃 Story：清理 worktree/分支并标记为 DISCARDED', schema: {
    storyId: z.string().describe('Story ID'),
    reason: z.string().optional().describe('废弃原因（写入事件记录）'),
    force: z.boolean().optional().describe('强制丢弃未提交改动'),
    purge: z.boolean().optional().describe('临时 story 专用：删除 story metadata，并在安全时回退纯 metadata init commit'),
  }},

  // Draft (B-9975: iterate on story shape before formal story_create)
  { name: 'story_draft', description: '创建 draft（不分配 B-xxxx id，写到 docs/story/drafts/<name>/）', schema: {
    name: z.string().describe('短名称（字母数字+连字符，3-60 字符）'),
    title: z.string().describe('标题（≥ 5 字符）'),
    description: z.string().describe('描述（≥ 5 字符）'),
    type: storyTypeSchema.describe('类型；test 会归一为 chore'),
    priority: z.string().describe('优先级'),
    checklist: z.array(z.object({ title: z.string(), context: z.string().optional() })).describe('开发清单（≥ 1 项）'),
    background: z.string().describe('四段式 background.md 内容（必填，同 story_create 校验）'),
    keywords: z.array(z.string()).optional().describe('关键词'),
  }},
  { name: 'story_draft_list', description: '列出所有 draft', schema: {} },
  { name: 'story_draft_discard', description: '删除指定 draft', schema: {
    name: z.string().describe('要删除的 draft 名称'),
  }},
  { name: 'draft_check_set', description: '保存 draft check 结果（由 reviewer 调用，签名 draft 的 background + checklist）', schema: {
    draftName: z.string().describe('Draft 名称'),
    issues: z.array(z.object({
      id: z.string().optional().describe('reviewer 自分配 id（如 INIT-001），可选（自动分配）'),
      severity: z.enum(['critical', 'high', 'medium', 'low']).describe('issue 严重度'),
      desc: z.string().min(1, 'desc 必填且 ≥ 1 字符').describe('issue 具体描述'),
    })).describe('Reviewer 提出的 issue 列表（允许空数组）'),
    agentId: z.string().optional().describe('Reviewer 自报 agent id，仅审计追溯用'),
  }},
  { name: 'draft_issue_resolve', description: '对 draft check 中的 issue 写入 resolution（≥ 20 字符）', schema: {
    draftName: z.string().describe('Draft 名称'),
    issueId: z.string().describe('Issue ID（如 INIT-001）'),
    resolution: z.string().min(20, 'resolution ≥ 20 字符').describe('书面消解结论'),
  }},

  // Review
  { name: 'story_review', description: '对抗审查 checklist 完整性', longHelp: STORY_REVIEW_LONG, schema: {
    storyId: z.string().describe('Story ID'),
  }},
  { name: 'story_review_dismiss', description: '驳回一个被误报的 riskSignal 分类（B-5010）', schema: {
    storyId: z.string().describe('Story ID'),
    category: z.string().describe('要驳回的 riskSignal.category（如 "状态机/门禁"、"test runner 框架"）'),
    reason: z.string().describe('驳回理由（≥ 5 字符，写清楚为什么该 signal 在本 story 是误报）'),
  }},
  { name: 'testintent_handoff', description: '生成 test-intent agent 交接包（PLAN 阶段）', schema: {
    storyId: z.string().describe('Story ID'),
    itemIds: z.array(z.string()).optional().describe('只交接指定 checklist item ID；缺省为全部'),
  }},

  // Checklist
  { name: 'checklist_get', description: '读取 checklist', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'checklist_add', description: '向已有 story 追加 checklist item', schema: {
    storyId: z.string().describe('Story ID'), title: z.string().describe('做什么（一句话）'),
    context: z.string().optional().describe('根因/参考方案'),
    relatedDocs: z.array(z.string()).optional().describe('关联文档路径（用于三次提醒）'),
    userSees: z.string().optional().describe('用户完成此 item 后在终端/UI 看到的具体文本'),
    excludes: z.array(z.string()).optional().describe('显式声明不做的功能点'),
    files: z.object({
      modify: z.array(z.string()),
      create: z.array(z.string()),
      test: z.array(z.string()),
    }).optional().describe('B-45ed: 受影响的文件集合（PLAN 阶段声明，story_review 做 touchpoints→files 覆盖校验）'),
    verificationIntent: verificationIntentSchema.optional().describe('happy/edge/adversarial 验证意图（PLAN 阶段）'),
    reason: z.string().optional().describe('PLAN 阶段追加 item 时必须提供的 replan/scope audit 理由（≥10 字符）'),
  }},
  { name: 'checklist_remove', description: '从 story 中移除一个 checklist item（必须给出裁决 + 理由）', schema: {
    storyId: z.string().describe('Story ID'), itemId: z.string().describe('要移除的项 ID'),
    disposition: z.enum(['accept', 'reject', 'partial']).describe('裁决: accept=确认删除合理 / reject=不该删但要移除 / partial=部分合理'),
    justification: z.string().describe('删除理由（≥10 字符）'),
  }},
  { name: 'checklist_update', description: '更新 checklist 项 (status/relatedDocs；title/context 从 PLAN 冻结，userSees 从 DEV 冻结)', longHelp: CHECKLIST_UPDATE_LONG, schema: {
    storyId: z.string().describe('Story ID'), itemId: z.string().describe('项 ID'),
    status: z.enum(['pending','in_progress','done']).optional().describe('新状态'),
    title: z.string().optional().describe('新标题（PLAN 起冻结）'),
    context: z.string().optional().describe('新 context（PLAN 起冻结）'),
    relatedDocs: z.array(z.string()).optional().describe('关联文档路径（用于三次提醒）'),
    userSees: z.string().optional().describe('用户完成此 item 后在终端/UI 看到的具体文本（PLAN 之前可写，DEV 起冻结）'),
    files: z.object({
      modify: z.array(z.string()),
      create: z.array(z.string()),
      test: z.array(z.string()),
    }).optional().describe('B-45ed: 受影响的文件集合（PLAN 阶段声明）'),
    verificationIntent: verificationIntentSchema.optional().describe('happy/edge/adversarial 验证意图（DEV 起冻结）'),
    verificationEvidence: z.array(verificationEvidenceSchema).optional().describe('覆盖 verificationIntent 的证据列表'),
    reason: z.string().optional().describe('变更原因'), agent: z.string().optional().describe('操作者'),
    success: z.boolean().optional().describe('subagent 结果是否成功（仅 status=done 时有效，默认 true）'),
  }},
  { name: 'verification_evidence_add', description: '为 checklist item 追加/更新 verificationIntent 覆盖证据', schema: {
    storyId: z.string().describe('Story ID'),
    itemId: z.string().describe('Checklist item ID'),
    intentRef: z.string().describe('如 CHK-001:happy:0 或自定义 intent id'),
    kind: verificationEvidenceKindSchema,
    verdict: z.enum(VERIFICATION_EVIDENCE_VERDICTS).optional().describe('证据结论语义；不覆盖 result pass/fail gate'),
    waiverType: z.enum(['permanent', 'deferred_gate_evidence']).optional().describe('kind=waiver 时可标记为临时 gate 自测 evidence'),
    file: z.string().optional().describe('测试/文档文件路径'),
    command: z.string().optional().describe('执行命令'),
    result: z.enum(['pass', 'fail']).optional().describe('执行结果'),
    note: z.string().describe('为什么此证据覆盖该 intent'),
  }},
  { name: 'verification_evidence_batch_add', description: '批量追加/更新 verificationIntent 覆盖证据（避免并发写 checklist 丢 evidence）', schema: {
    storyId: z.string().describe('Story ID'),
    evidences: z.array(z.object({
      itemId: z.string().describe('Checklist item ID'),
      intentRef: z.string().describe('如 CHK-001:happy:0 或自定义 intent id'),
      kind: verificationEvidenceKindSchema,
      verdict: z.enum(VERIFICATION_EVIDENCE_VERDICTS).optional().describe('证据结论语义；不覆盖 result pass/fail gate'),
      waiverType: z.enum(['permanent', 'deferred_gate_evidence']).optional().describe('kind=waiver 时可标记为临时 gate 自测 evidence'),
      file: z.string().optional().describe('测试/文档文件路径'),
      command: z.string().optional().describe('执行命令'),
      result: z.enum(['pass', 'fail']).optional().describe('执行结果'),
      note: z.string().describe('为什么此证据覆盖该 intent'),
    })).describe('证据数组；同一次调用内读写 checklist 一次'),
  }},
  { name: 'verification_evidence_refresh_stale', description: '刷新 stale verificationEvidence 的 HEAD/material hash（需先重跑对应验证命令）', schema: {
    storyId: z.string().describe('Story ID'),
    dryRun: z.boolean().optional().describe('只报告将刷新的 stale evidence，不写入'),
  }},
  { name: 'light_review', description: '记录一次轻量 review（DEV 阶段每完成一批 item 后调用）', schema: {
    storyId: z.string().describe('Story ID'),
    checklistIds: z.array(z.string()).describe('本次 review 覆盖的 checklist item ID 列表'),
    note: z.string().optional().describe('review 备注'),
  }},
  { name: 'review_pass_set', description: '记录 reviewer 已审查且无 blocking finding 的通过凭证', schema: {
    storyId: z.string().describe('Story ID'),
    agent: z.string().optional().describe('reviewer agent id（如 koala-review-quality；默认 KOALA_AGENT）'),
    note: z.string().describe('审查范围与无 blocker 理由（≥10 字符）'),
  }},

  // Understanding (Pre-context Intake snapshot, OMX 风格)
  { name: 'understanding_set', description: 'PLAN 阶段落 task 理解快照（task/outcome/facts/constraints/unknowns/touchpoints）', schema: {
    storyId: z.string().describe('Story ID'),
    task: z.string().describe('一句话描述要解决的问题'),
    outcome: z.string().describe('完成后能观察到什么变化'),
    facts: z.array(z.string()).describe('已知事实'),
    constraints: z.array(z.string()).describe('约束条件'),
    unknowns: z.array(z.string()).describe('未知问题（拆 checklist 前应消化）'),
    touchpoints: z.array(z.string()).describe('可能的代码触点'),
  }},
  { name: 'understanding_get', description: '读取 understanding snapshot', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  // Decision (RALPLAN-DR 结构化决策, OMX ralplan 风格)
  { name: 'decision_set', description: 'PLAN 阶段落结构化决策（principles/drivers/options/chosen/preMortem）', schema: {
    storyId: z.string().describe('Story ID'),
    principles: z.array(z.string()).describe('3-5 条设计原则'),
    drivers: z.array(z.string()).describe('top 3 关键约束'),
    options: z.array(z.object({
      name: z.string(),
      pros: z.array(z.string()),
      cons: z.array(z.string()),
    })).describe('≥ 2 个备选 + pros/cons'),
    chosen: z.string().describe('选择的 option.name'),
    rationale: z.string().describe('选择理由 (≥ 10 字符)'),
    preMortem: z.array(z.object({
      scenario: z.string(),
      trigger: z.string(),
      consequence: z.string(),
      mitigation: z.string(),
    })).optional().describe('预演失败场景（高风险 story 要求 ≥ 3）'),
  }},
  { name: 'decision_get', description: '读取 decision snapshot', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  // Summary (B-093b: DONE-gate forced completion summary)
  { name: 'summary_set', description: 'DONE 前必须落：story 完成总结（changes/usage/user acceptance/limitations/pitfalls + 自动扫真机覆盖骨架）', schema: {
    storyId: z.string().describe('Story ID'),
    changes: z.string().describe('改了什么（每个文件关键改动，用户视角，≥ 10 字符）'),
    usage: z.string().describe('怎么用（slash / tool / 调用示例，≥ 10 字符）'),
    expectedOutcome: z.string().optional().describe('DONE gate 必填：用户视角的预期可见结果 / expected transcript（≥ 10 字符）'),
    actualTranscript: z.string().optional().describe('DONE gate 必填：实际运行看到的用户可见 transcript / 输出摘要（≥ 10 字符）'),
    outcomeDiff: z.string().optional().describe('DONE gate 必填：expected vs actual 差异；没有差异也要明说（≥ 5 字符）'),
    acceptanceVerdict: z.enum(['accepted', 'partial', 'rejected']).optional().describe('DONE gate 必填：用户价值验收结论'),
    outcomeKind: z.enum(STORY_OUTCOME_KINDS).optional().describe('DONE outcome classification: success / blocked / audit_only'),
    limitations: z.string().describe('已知限制 / 设计偏离（没有就写 "none — fully covered"）'),
    pitfalls: z.string().describe('踩坑记录（卡在哪、绕了几次路、下个人应该知道什么，≥ 10 字符；禁止空话）'),
    skipReasons: z.record(z.string(), z.string()).optional().describe('{case name: reason} 对每条 sandbox:false 但没跑的 case 说明原因；未提供则 koala 报错列出缺失项'),
  }},
  { name: 'summary_get', description: '读取 story summary', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  // Bug
  { name: 'bug_report', description: '报告 bug', longHelp: BUG_REPORT_LONG, schema: {
    storyId: z.string().describe('Story ID'), id: z.string().describe('Bug ID'),
    title: z.string().describe('描述'), checklistId: z.string().optional().describe('关联 checklist ID'),
  }},
  { name: 'bug_update', description: '更新 bug 状态', schema: {
    storyId: z.string().describe('Story ID'), id: z.string().describe('Bug ID'),
    status: z.enum(['open','fixed']).describe('新状态'),
    evidence: z.object({
      symptom: z.string().describe('用户可观测的症状'),
      reproSteps: z.array(z.string()).describe('最小复现步骤'),
      hypothesis: z.string().optional().describe('验证过的假设'),
      rootCause: z.string().describe('确认的根因'),
      fixEvidence: z.string().describe('修复点说明'),
      reproTest: z.string().optional().describe('复现测试路径'),
    }).optional().describe('调试证据链（标 fixed 时建议提供）'),
  }},
  { name: 'bug_list', description: '查看 bug 列表（不传 storyId 时全局汇总）', schema: { storyId: z.string().optional().describe('Story ID；不传则列出全部 story 的 bugs') }},
  { name: 'bug_analyze', description: '跨 story bug 质量仪表盘（markdown/json）', schema: {
    format: z.enum(['json','markdown']).optional().describe('输出格式（默认 json）'),
  }},

  // Test
  { name: 'test_add', description: '记录测试证据', schema: {
    storyId: z.string().describe('Story ID'), id: z.string().describe('TE ID'),
    scenario: z.string().describe('场景'), command: z.string().describe('命令'),
    output: z.string().describe('输出'), expected: z.string().describe('预期'),
    result: z.enum(['PASS','FAIL']).describe('结果'),
  }},
  { name: 'test_list', description: '查看最新测试证据快照（当前不是历史列表）', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'fixture_get', description: '读取 fixture 文件', schema: {
    fixturePath: z.string().describe('fixture 路径（相对 fixturesDir，不含 .json）'),
  }},
  { name: 'fixture_update', description: '替换 fixture cases（兼容维护命令）', schema: {
    fixturePath: z.string().describe('fixture 路径（相对 fixturesDir，不含 .json）'),
    cases: z.array(z.record(z.string(), z.unknown())).describe('完整 cases 数组'),
  }},
  { name: 'fixture_batch_add', description: '批量追加 fixture case（支持 executor / command / legacy execute）', schema: {
    fixturePath: z.string().describe('fixture 路径（相对 fixturesDir，不含 .json）'),
    cases: z.array(z.record(z.string(), z.unknown())).describe('要追加的 case 数组'),
    storyId: z.string().optional().describe('用于自动补全 intentRef story 前缀'),
    dryRun: z.boolean().optional().describe('只预览，不落盘'),
    validateExecute: z.boolean().optional().describe('追加前预执行 CLI case'),
  }},
  { name: 'test_auto', description: 'legacy 全量 fixture 回归（真实执行需 confirm；dryRun 预览）', schema: {
    storyId: z.string().optional().describe('已废弃；当前 story 验证请用 koala validate --story=<storyId> 并记录 verificationEvidence'),
    trace: z.boolean().optional().describe('收集 trace'),
    enableProfiler: z.boolean().optional().describe('启用 profiler'),
    dryRun: z.boolean().optional().describe('只输出执行计划'),
    confirm: z.boolean().optional().describe('确认执行有副作用的全量回归'),
  }},
  { name: 'test_story', description: '按 story 过滤并执行关联 fixture case', schema: {
    storyId: z.string().describe('Story ID'),
    trace: z.boolean().optional().describe('收集 trace'),
  }},
  { name: 'test_fixture', description: '按 fixtureId 执行单 case 或链', schema: {
    fixtureId: z.string().describe('fixture case _id'),
  }},
  { name: 'task_coverage', description: '检查 story checklist 与代码任务元数据覆盖率', schema: {
    storyId: z.union([z.string(), z.array(z.string())]).describe('Story ID 或 Story ID 数组'),
  }},

  // Truth / Gap
  { name: 'truth_scan', description: '扫描真相源目录，提取需求点/决策/约束/问题', schema: {
    summary: z.boolean().optional().describe('只返回统计摘要'),
  }},
  { name: 'truth_nav', description: '生成真相源导航', schema: {} },
  { name: 'truth_analyze', description: '分析真相源中的矛盾/模糊/缺失', schema: {} },
  { name: 'truth_to_story', description: '从真相源提取候选 story', schema: {} },
  { name: 'truth_extract', description: '从代码元数据提取 requirements 文档', schema: {} },
  { name: 'gap_analyze', description: '对比真相源 vs 代码现实，输出差距报告', schema: {} },
  { name: 'convergence_check', description: '判断项目是否收敛（需求覆盖、测试通过、无差距）', schema: {} },
  // Dashboard (实时看板)
  { name: 'dashboard', description: '实时 story 进度看板（每 N 秒刷新，支持多项目切换）', schema: {
    roots: z.string().optional().describe('项目根目录（逗号分隔多个路径；默认当前目录）'),
    interval: z.number().optional().describe('刷新间隔秒数（默认 5）'),
  }},
  { name: 'session_brief', description: '跨 session 开场简报（active story / phase / checklist / bug / next step）', schema: {
    concise: z.boolean().optional().describe('轻量模式（默认 false）'),
  }},
  { name: 'next', description: '只输出当前最可信的下一步（复用 session_brief 的权威 phase 判断）', schema: {
    concise: z.boolean().optional().describe('轻量模式（默认 true）'),
  }},
  { name: 'aux_doc_list', description: '列出项目文档（PLAN 阶段挑选 relatedDocs 用）', schema: {
    format: z.enum(['text', 'json']).optional().describe('输出格式（默认 text）'),
  }},

  // Doctor (health issue 巡检)
  { name: 'doctor', description: '查看 koala 自身的 health issue（被 silent catch 接住的 PERSIST 失败）+ 扫 .worktrees/ 孤儿目录', schema: {
    format: z.enum(['text', 'json']).optional().describe('输出格式（默认 text）'),
    limit: z.number().optional().describe('最多读取条数（默认 1000）'),
    repair: z.boolean().optional().describe('清理 DONE/DISCARDED terminal worktree 注册项、孤儿目录与 prunable 元数据'),
  }},
  { name: 'verify_codex', description: '验证 Codex adapter 资产、入口 heartbeat 与硬证据', schema: {
    json: z.boolean().optional().describe('结构化 JSON 输出'),
    storyId: z.string().optional().describe('可选 Story ID；缺省从 story/* 分支推断并记录 process-event evidence'),
  }},

  // Audit (framework self-audit — 跨 story 扫 CLAUDE.md 承诺 vs 实际 CLI 行为 drift)
  { name: 'audit', description: '框架自省 audit（机械扫 CLAUDE.md drift → 写 B-META-framework-audit finding + report.md）', schema: {
    framework: z.boolean().optional().describe('扫 CLAUDE.md / packages/koala/CLAUDE.md 的 CLI 命令/flag/路径 drift（当前 MVP 唯一档）'),
    mode: z.enum(['semi-auto', 'full-auto', 'off']).optional().describe('覆盖配置默认模式；off = 直接退出不跑'),
  }},

  // Verifier (koala 内建代码验证)
  { name: 'validate', description: '运行项目验证（静态 + 逻辑 + 集成测试）', longHelp: VALIDATE_LONG, schema: {
    full: z.union([z.string(), z.boolean()]).optional().describe('含真机测试（--full 或 --full=PvE 按名称过滤）'),
    story: z.string().optional().describe('只跑 story 改动涉及的 transition（TEST gate 用）'),
    json: z.boolean().optional().describe('结构化 JSON 输出（ExternalVerifierResult）'),
    // B-9d95 CHK-006: REVIEW→TEST preflight CLI gate 独立分流 flag
    // 任一 flag 命中 → 只跑对应 CLI gate，不 spawn pytest（秒级返回）
    // 同时传多个 flag → Promise.all 并行；任一 fail → exit 1
    channel: z.boolean().optional().describe('B-9d95: 只跑 --channel gate（commit author 扫描，需配合 --story）'),
    concept: z.boolean().optional().describe('B-9d95: 只跑 --concept gate（deleted symbol 残留扫描）'),
    lint: z.boolean().optional().describe('B-9d95: 只跑 --lint gate（tsc + ruff + import-graph）'),
    noSync: z.boolean().optional().describe('跳过 validate 前的 cluster commit auto-resolve 同步（诊断用）'),
  }},
  { name: 'status', description: '项目全貌（story 进度 + 代码验证状态）', schema: {
    concise: z.boolean().optional().describe('轻量模式（跳过代码验证，< 4KB，用于 hook 注入）'),
  }},
  { name: 'serve', description: '启动 HTTP API 调试服务（watch 文件 + 实时验证 + 浏览器代理）', schema: {
    dev: z.string().optional().describe('Dev server 命令（如 "npm run dev"），启用浏览器代理'),
    port: z.number().optional().describe('API 端口（默认 3456）'),
  }},

  // Evaluate (browser 项目 AI 评估)
  { name: 'evaluate', description: '调 evaluator agent 对 browser 应用打分（功能完整性 + 可用性）', schema: {
    storyId: z.string().describe('Story ID'),
    port: z.number().optional().describe('koala serve 端口（默认 3456）'),
  }},
  { name: 'evaluate_save', description: '保存 evaluator 打分结果到 eval-evidence.json', schema: {
    storyId: z.string().describe('Story ID'),
    result: z.string().describe('evaluator 输出的 JSON 字符串'),
  }},

  // Finding (koala-reviewer 发现项)
  { name: 'finding_add', description: '添加 finding（koala-reviewer 发现项）', schema: {
    storyId: z.string().describe('Story ID'),
    desc: z.string().describe('发现描述'),
    severity: z.enum(['critical', 'high', 'medium', 'low']).describe('严重程度'),
    category: z.enum([
      'happy',
      'edge',
      'adversarial',
      'missing',
      'cleanup',
      'doc-promise-undelivered',
      'doc-code-drift',
      'spec-boundary',
    ]).describe('分类（legacy category 会归一为 missing）'),
    agent: z.string().optional().describe('调用者身份（可选，默认从 KOALA_AGENT 环境变量读）'),
    files: z.array(z.string()).optional().describe('关联文件路径（用于 reviewer finding cluster 与溯源）'),
  }},
  { name: 'finding_list', description: '查看 story 的 findings', schema: {
    storyId: z.string().describe('Story ID'),
    cluster: z.boolean().optional().describe('B-9d95 CHK-005: 返回 cluster 视图 { clusters, ungrouped } 而非 findings 平铺'),
  }},
  { name: 'finding_resolve', description: '标记 finding 为已解决', schema: {
    storyId: z.string().describe('Story ID'),
    findingId: z.string().describe('Finding ID（如 B-xxx:F-001）'),
  }},
  { name: 'finding_dismiss', description: '确认 finding 不修（需说明理由）', schema: {
    storyId: z.string().describe('Story ID'),
    findingId: z.string().describe('Finding ID（如 B-xxx:F-001）'),
    reason: z.string().describe('不修的理由（≥10 字符）'),
  }},

  // Finding Cluster (B-e8c8 / B-9d95 CHK-005: 自动聚簇 + 手动 merge/split)
  //
  // 无参（默认模式）：按 files 交集 ≥ 50% + severity 一致自动聚簇，写回 clusters.json + findings.clusterId。
  // merge：将给定 finding id 列表强制合为一个新簇。
  // split：删除该簇，成员 finding 回 singleton。
  // 阶段：与 finding_list 对齐，REVIEW/TEST 可用（详见 config.ts DEFAULT_PHASE_TOOLS）。
  { name: 'finding_cluster', description: 'B-9d95: 聚簇 findings（auto / merge / split），输出簇摘要', schema: {
    storyId: z.string().describe('Story ID'),
    merge: z.union([z.array(z.string()), z.string()]).optional().describe('强制合为一个新簇：finding id 数组或逗号分隔字符串（F-001,F-002）'),
    split: z.string().optional().describe('拆分目标簇 ID（CL-xxx），成员 finding 回 singleton'),
  }},

  // Init Check (B-e71f CHK-003: init reviewers write signed init-check.json)
  // INIT→INIT_CHECK 硬门槛产物。EXP-001 已证伪调用方机械可校验性，故 agentId/agent 仍是自报；
  // gate 会校验必需 reviewer 名称是否已记录，prompt 必须传准确名称。
  // 三层校验中的 Zod 层（CLAUDE.md「Handler 编码约定」）：severity enum + desc.min(1)。
  { name: 'init_check_set', description: '保存 init check 结果（由 INIT reviewer 调用）', schema: {
    storyId: z.string().describe('Story ID'),
    issues: z.array(z.object({
      id: z.string().optional().describe('reviewer 自分配 id（如 I-1），可选'),
      severity: z.enum(['critical', 'high', 'medium', 'low']).describe('issue 严重度'),
      desc: z.string().min(1, 'desc 必填且 ≥ 1 字符').describe('issue 具体描述（reviewer 主观判断需具体）'),
    })).describe('Reviewer 提出的 issue 列表；critical/high 会阻塞 INIT_CHECK，允许空数组'),
    agent: z.string().optional().describe('Reviewer 自报 agent 名；product-reviewer 必须传 product-reviewer'),
    agentId: z.string().optional().describe('Reviewer 自报 agent id；product-reviewer 必须传 product-reviewer，不能传 koala-review-story-init'),
  }},

  // Delivery Check (B-35ed: koala-review-delivery reviewer writes signed delivery-check.json)
  // TEST→DONE 硬门槛产物。签名域：storyId + docsPromises + realMachineTests + closingSelfCheck + reviewRound。
  { name: 'delivery_check_set', description: '保存 delivery check 结果（由 koala-review-delivery reviewer 调用）', schema: {
    storyId: z.string().describe('Story ID'),
    docsPromises: z.array(z.object({
      docPath: z.string().describe('文档路径'),
      promise: z.string().describe('文档中的承诺描述'),
      status: z.enum(['met', 'verified', 'waived', 'unverified']).optional().describe('可选状态；met/verified 视为已验证，waived 需 waiverReason'),
      verifiedBy: z.string().optional().describe('验证方式（如 grep/test/manual）'),
      evidence: z.string().optional().describe('验证证据'),
      waiverReason: z.string().optional().describe('文档承诺豁免理由（status=waived 时 ≥ 30 字符）'),
    })).describe('文档承诺列表'),
    realMachineTests: z.array(z.object({
      featureId: z.string().describe('功能点 ID（如 CHK-xxx）'),
      transcript: z.string().describe('真机测试 transcript 或摘要'),
      waiverReason: z.string().optional().describe('豁免理由（非空时 ≥ 30 字符，入签名）'),
    })).describe('真机测试记录'),
    closingSelfCheck: z.object({
      hasRealMachineTest: z.boolean().describe('是否有真机测试'),
      hasEdgeCaseCoverage: z.boolean().describe('是否覆盖边界情况'),
      hasUnresolvedTodos: z.boolean().describe('是否有未解决的 TODO'),
      summary: z.string().min(10, 'summary ≥ 10 字符').describe('闭合自检总结'),
    }).describe('闭合自检'),
    agentId: z.string().optional().describe('Reviewer 自报 agent id，仅审计追溯'),
  }},

  // Delivery Waiver (B-35ed CHK-005: 豁免审计，主 agent 为未验证的 docsPromise 补充豁免理由)
  { name: 'delivery_waiver_add', description: '为 delivery-check.json 中某条 docsPromise 添加豁免理由（重签名）', schema: {
    storyId: z.string().describe('Story ID'),
    promiseId: z.string().describe('要豁免的 docPath（匹配 docsPromises[].docPath）'),
    waiverReason: z.string().min(30, 'waiverReason must be at least 30 characters').describe('豁免理由（≥ 30 字符）'),
  }},

  // Scope Check (B-d4d1: scope agent writes signed scope-check.json)
  { name: 'scope_check_save', description: '保存 scope check 结果（由 scope agent 调用）', schema: {
    storyId: z.string().describe('Story ID'),
    features: z.array(z.object({
      feature: z.string(),
      covered_by: z.string().nullable(),
      // B-ed3e CHK-002: 5 档 status
      status: z.enum(['covered', 'excluded', 'gap', 'orphan-suspect', 'drift']),
      excluded_by: z.string().nullable(),
      // B-ed3e CHK-002: source 标注来源（description / decisions:<path> / relatedDocs:<path>）
      source: z.string().optional(),
    })).describe('功能点覆盖分析结果'),
    summary: z.object({
      total: z.number(),
      covered: z.number(),
      excluded: z.number(),
      gaps: z.number(),
      // B-ed3e CHK-002: 新字段可选，默认 0；drift PLAN 阶段恒 0
      orphanSuspect: z.number().optional(),
      drift: z.number().optional(),
    }).describe('汇总'),
    // B-ed3e CHK-003: 第 6 通道 Open Questions（可选）。reviewer 写入时只做类型校验，
    // 不校验业务完整性；主 agent 之后用 scope_question_resolve 书面消解。
    openQuestions: z.array(z.object({
      id: z.string(),
      q: z.string(),
      evidence: z.string(),
      sourcePointers: z.array(z.string()),
    })).optional().describe('Open Questions：reviewer 在 decisions/ 扫到"看见但不归类"的矛盾/疑问，主 agent 必须用 scope_question_resolve 消解'),
  }},

  // B-ed3e CHK-003: scope_question_resolve — 主 agent 对 reviewer 抛出的 OQ 写入书面 resolution
  // 设计原则：resolution 不入签名 _hash（resolution 是 main agent 动作，不污染 reviewer 判定签名域）
  { name: 'scope_question_resolve', description: '主 agent 对 scope reviewer 抛出的 Open Question 写入书面 resolution（防自我赦免）', schema: {
    storyId: z.string().describe('Story ID'),
    oqId: z.string().describe('Open Question ID（如 OQ-1）'),
    resolution: z.string().min(20, 'resolution 必填且 ≥ 20 字符（书面消解，防自我赦免）').describe('主 agent 的书面消解结论（≥ 20 字符，应引 decisions/ 原文）'),
    sourcePointers: z.array(z.string()).optional().describe('resolution 的证据指针（decisions/ 路径或 checklist item id），默认 []'),
  }},

  // Story dispatch (B-45ed CHK-005: implementer prompt generator)
  { name: 'story_dispatch', description: '生成标准 implementer prompt 字符串（主 agent 派发 CHK-xxx 用）', schema: {
    storyId: z.string().describe('Story ID'),
    itemId: z.string().describe('Checklist item ID（如 CHK-001）'),
    agentType: z.string().optional().describe('subagent 类型（如 koala-implementer / koala-review-channel）；CHK-008 will expand matrix'),
  }},

  // Finding dispatch (B-45ed CHK-010: reviewer-finding 修复 prompt generator，与 story_dispatch 同构)
  // B-9d95 CHK-004: deprecated alias，首行 stdout 打印 deprecation warning，建议改用 `koala dispatch`
  { name: 'finding_dispatch', description: '[deprecated: 请改用 koala dispatch] 生成标准 reviewer-finding 修复 prompt 字符串', schema: {
    storyId: z.string().describe('Story ID'),
    findingId: z.string().describe('Finding ID（如 F-001 或 B-xxx:F-001 完整形式）'),
    agentType: z.string().optional().describe('subagent 类型（如 koala-implementer / koala-review-channel）；复用 CHK-008 分级矩阵'),
  }},

  // Unified dispatch (B-9d95 CHK-004: story_dispatch / finding_dispatch 合并为 `koala dispatch`，全阶段开放)
  { name: 'dispatch', description: '统一派发入口：按 itemId / findingId / clusterId 恰好一个生成 subagent prompt（全阶段可用）', schema: {
    storyId: z.string().describe('Story ID'),
    itemId: z.string().optional().describe('Checklist item ID（CHK-xxx）；与 findingId / clusterId 互斥，恰好提供一个'),
    findingId: z.string().optional().describe('Finding ID（F-xxx 或 B-xxx:F-xxx）；与 itemId / clusterId 互斥'),
    clusterId: z.string().optional().describe('Cluster ID（CL-xxx）；与 itemId / findingId 互斥'),
    agentType: z.string().optional().describe('subagent 类型；INIT reviewer 可只传 koala-review-story-init，其他场景与 itemId/findingId/clusterId 搭配'),
  }},

  // Background CLI 三件套 (B-45ed CHK-007: background.md set/append/get)
  { name: 'background_set', description: '全量写入 background.md（四段式格式校验，复用 CHK-006 validator）', schema: {
    storyId: z.string().describe('Story ID'),
    content: z.string().describe('background.md 完整内容（四段式）'),
  }},
  { name: 'background_append', description: '追加内容到 background.md 指定段末尾，不影响其他段', schema: {
    storyId: z.string().describe('Story ID'),
    section: z.enum(['触发事件', '关键洞察', '方案取舍', '对话纹理']).describe('目标段名（四段之一）'),
    content: z.string().describe('要追加的内容（通常是单行 bullet 或若干行）'),
  }},
  { name: 'background_get', description: '读取 background.md 全文', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  { name: 'plan_set', description: '全量写入 plan.md（每个 checklist item 需有 ## CHK-xxx 章节）', schema: {
    storyId: z.string().describe('Story ID'),
    content: z.string().describe('plan.md 完整内容'),
  }},
  { name: 'plan_get', description: '读取 plan.md 全文', schema: {
    storyId: z.string().describe('Story ID'),
  }},

  // Reviewer list (B-fdcf CHK-001: opt-in 名单查询，按 riskSignals / touchpoints 实时计算)
  { name: 'reviewer_list', description: '列出当前 story 的 opt-in reviewer 名单（baseline concept/quality/test-coverage + 按信号挂载 behavior/docs；channel LLM 已退役）', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('输出结构化 JSON（含 reviewers 数组）'),
    forceReviewer: z.string().optional().describe('逗号分隔的 reviewer 名称，强制加挂；写入 story.events 审计（reviewer_forced）'),
  }},

  // Workflow profile
  { name: 'workflow_set', description: '设置项目 workflow profile（light/balanced/strict）', schema: {
    profile: z.string().describe('目标 profile：light / balanced / strict'),
  }},
  { name: 'workflow_show', description: '显示当前 workflow profile 和生效策略', schema: {} },
  { name: 'workflow_explain', description: '解释某个 story 的实际生效 profile（project / required / effective）', schema: {
    storyId: z.string().describe('Story ID'),
  }},

];

/**
 * 运行时工具列表 — runCli() 启动时会赋值，包括 main 自带的 + extras。
 * 之后所有 helper（printHelp、dispatch lookup 等）都通过这个变量访问，
 * 不直接引用 MAIN_TOOLS。
 */
let TOOLS: ToolDef[] = MAIN_TOOLS;

// ── Phase detection ──

interface ActiveStory { storyId: string; phase: string; }

/**
 * 从 git 分支名检测 active story。
 * 分支格式: story/B-xxxx → storyId = B-xxxx
 * 返回 null 表示非 story 分支（全量可用）。
 */
function detectActiveStory(root: string): ActiveStory | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!branch.startsWith('story/')) return null;
    const storyId = branch.slice('story/'.length);
    if (!storyId) return null;
    const store = new StoryStore(root);
    try {
      const story = store.readStory(storyId);
      return { storyId, phase: story.phase };
    } catch {
      // story 文件不存在，不过滤
      return null;
    }
  } catch {
    // 非 git 目录或其他错误，不过滤
    return null;
  }
}

// ── Help ──

function describeType(t: ZodType): string {
  if (t instanceof ZodOptional) return describeType((t as any)._def.innerType);
  if (t instanceof ZodString) return 'string';
  if (t instanceof ZodNumber) return 'number';
  if (t instanceof ZodBoolean) return 'boolean';
  if (t instanceof ZodEnum) return ((t as any).options || []).join('|');
  if (t instanceof ZodArray) return 'array';
  if (t instanceof ZodObject) return 'object';
  if (t instanceof ZodUnion) return 'string|array';
  return 'any';
}

function getDesc(t: ZodType): string {
  return (t as any).description || '';
}

function unwrapOptional(t: ZodType): ZodType {
  return t instanceof ZodOptional ? (t as any)._def.innerType : t;
}

function objectShape(t: ZodObject<any>): Record<string, ZodType> {
  const anyType = t as any;
  const shape = anyType.shape ?? anyType._def?.shape;
  return typeof shape === 'function' ? shape() : shape || {};
}

function arrayElement(t: ZodArray<any>): ZodType | null {
  const anyType = t as any;
  return anyType.element || anyType._def?.type || null;
}

function nestedSchemaLines(t: ZodType, prefix: string, indent = '      '): string[] {
  const inner = unwrapOptional(t);
  if (inner instanceof ZodArray) {
    const element = arrayElement(inner);
    if (!element) return [];
    const elementInner = unwrapOptional(element);
    if (elementInner instanceof ZodObject) {
      return nestedSchemaLines(elementInner, `${prefix}[]`, indent);
    }
    return [`${indent}${prefix}[]: ${describeType(elementInner)} ${getDesc(elementInner)}`.trimEnd()];
  }
  if (!(inner instanceof ZodObject)) return [];
  const shape = objectShape(inner);
  const lines: string[] = [];
  for (const [key, child] of Object.entries(shape)) {
    const optional = child instanceof ZodOptional;
    const childInner = unwrapOptional(child);
    const path = prefix ? `${prefix}.${key}` : key;
    lines.push(`${indent}${path}${optional ? '?' : ''}: ${describeType(child)} ${getDesc(child)}`.trimEnd());
    if (childInner instanceof ZodObject || childInner instanceof ZodArray) {
      lines.push(...nestedSchemaLines(childInner, path, indent + '  '));
    }
  }
  return lines;
}

type HelpOutputOptions = {
  stream?: { write(chunk: string): unknown };
  includeFooter?: boolean;
};

function printToolHelp(tool: ToolDef, options: HelpOutputOptions = {}) {
  const out = (line = '') => {
    if (options.stream) options.stream.write(`${line}\n`);
    else console.log(line);
  };
  const includeFooter = options.includeFooter !== false;

  out(`\n  koala ${tool.name} — ${tool.description}\n`);

  // 如果有 longHelp（核心命令），先打印完整 PROMPT
  if (tool.longHelp) {
    out(tool.longHelp);
    out('');
  }

  const entries = Object.entries(tool.schema);
  if (entries.length === 0) {
    out('  无参数\n');
    out(`  用法: koala ${tool.name}`);
    if (includeFooter) out(SESSION_BRIEF_FOOTER);
    return;
  }
  out('  参数:');
  const maxN = Math.max(...entries.map(([k]) => k.length));
  for (const [name, type] of entries) {
    const opt = type instanceof ZodOptional;
    const req = opt ? '' : ' *';
    const inner = type instanceof ZodOptional ? (type as any)._def.innerType : type;
    const isComplex = inner instanceof ZodArray || inner instanceof ZodObject;
    const flagHint = isComplex ? '(JSON)' : '';
    out(`    --${name.padEnd(maxN + 2)} ${describeType(type).padEnd(16)} ${getDesc(type)}${req} ${flagHint}`);
    if (isComplex) {
      for (const line of nestedSchemaLines(type, name)) out(line);
    }
  }
  const required = entries.filter(([, t]) => !(t instanceof ZodOptional));
  const optional = entries.filter(([, t]) => t instanceof ZodOptional);
  const reqParts = required.map(([k]) => `--${k}=值`);
  const optParts = optional.map(([k]) => {
    const inner = (entries.find(([n]) => n === k)?.[1] as any);
    const base = inner instanceof ZodOptional ? (inner as any)._def.innerType : inner;
    return base instanceof ZodBoolean ? `[--${k}]` : `[--${k}=值]`;
  });
  out(`\n  用法: koala ${tool.name} ${[...reqParts, ...optParts].join(' ')}`);
  out('  (* = 必填)');
  if (includeFooter) out(SESSION_BRIEF_FOOTER);
}

function formatValidationIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `  ${path}: ${issue.message}`;
}

function printValidationFailure(tool: ToolDef, issues: z.ZodIssue[]) {
  const lines = issues.map(formatValidationIssue);
  process.stderr.write('参数校验失败:\n');
  for (const line of lines) process.stderr.write(`${line}\n`);
  printToolHelp(tool, { stream: process.stderr, includeFooter: false });
  process.stderr.write('\n参数校验失败（摘要）:\n');
  for (const line of lines) process.stderr.write(`${line}\n`);
}

function printHelp(activeStory?: ActiveStory | null) {
  console.log('\n  koala — AI-driven project management CLI\n');
  console.log('  用法: koala <command> --key=value         执行命令');
  console.log('        koala <command> --help              查看参数');
  console.log('        koala help                          显示此帮助');
  console.log('        koala --root <path> ...             指定项目根目录\n');

  if (activeStory) {
    console.log(`  当前 Story: ${activeStory.storyId}  阶段: ${activeStory.phase}\n`);
  }

  const config = loadConfig();
  const phaseTools = config.phaseTools;

  // 已知前缀 → 显示分组名（特殊情况优先）
  const KNOWN_GROUP: Record<string, string> = {
    story: 'Story',
    checklist: 'Checklist',
    bug: 'Bug',
    test: 'Test',
    validate: 'Validate',
    status: 'Status',
    serve: 'Serve',
    aux: 'Aux',
    evaluate: 'Evaluate',
    dashboard: 'Session',
    session: 'Session',
    audit: 'Audit',
  };
  // 已知分组的展示顺序；不在列表里的分组（来自 extras）按字母序追加
  const KNOWN_ORDER = ['Story', 'Review', 'Checklist', 'Bug', 'Test', 'Validate', 'Evaluate', 'Workflow', 'Status', 'Serve', 'Session', 'Aux', 'Audit'];

  const groups: Record<string, ToolDef[]> = {};
  for (const t of TOOLS) {
    // 有 active story 时只列出当前阶段可用命令
    if (activeStory && !isCommandAllowed(t.name, activeStory.phase, phaseTools)) continue;
    const p = t.name.split('_')[0];
    let g: string;
    if (t.name === 'story_review' || t.name === 'story_review_dismiss') g = 'Review';
    else if (KNOWN_GROUP[p]) g = KNOWN_GROUP[p];
    else g = p.charAt(0).toUpperCase() + p.slice(1); // 未知前缀：首字母大写
    (groups[g] = groups[g] || []).push(t);
  }
  const filteredTools = activeStory ? TOOLS.filter(t => isCommandAllowed(t.name, activeStory.phase, phaseTools)) : TOOLS;
  const maxN = Math.max(...filteredTools.map(t => t.name.length), 0);

  const presentGroups = Object.keys(groups);
  const orderedGroups = [
    ...KNOWN_ORDER.filter(g => groups[g]),
    ...presentGroups.filter(g => !KNOWN_ORDER.includes(g)).sort(),
  ];
  for (const g of orderedGroups) {
    console.log(`  ${g}:`);
    for (const t of groups[g]) console.log(`    ${t.name.padEnd(maxN + 2)} ${t.description}`);
  }
  console.log(`
  开发流程:
    ── PLAN ──
    1. koala story_create '{"name":"x","title":"..","description":"..","type":"feature","priority":"high","checklist":[{"title":"做什么","context":"上下文"}]}'
    2. koala story_advance --storyId=B-xxx --phase=INIT_CHECK # 创建 worktree
    3. cd .worktrees/B-xxx
    4. koala story_review --storyId=B-xxx                     # 审查通过后进 DEV
    5. koala story_advance --storyId=B-xxx --phase=DEV

    ── DEV ──
    6. 写代码 + 写验证（fixture / 项目原生测试 / validate.ts 可选）
    7. koala validate                                         # 验证（按项目语言自动发现或读取配置）
    8. koala checklist_update --storyId=B-xxx --itemId=CHK-001 --status=done

    ── REVIEW ──
    9. koala story_advance --storyId=B-xxx --phase=REVIEW    # 进入代码审查
   10. koala-reviewer 审查代码，提 finding                     # critical/high 必须 resolve

    ── TEST → DONE ──
   11. koala story_advance --storyId=B-xxx --phase=TEST
   12. koala story_advance --storyId=B-xxx --phase=DONE

  初始化新项目:
    koala init                          # 在当前目录初始化 koala

  提示: 简单参数用 --key=value，复杂参数(array/object)用 JSON 格式
  出错? 用 koala <command> --help 查看完整参数说明
`);
}

// ── Flag parser ──

/** 测试入口：接受 JSON 描述的 schema（"string"|"number"|"boolean"|"array"|"object"），内部转 Zod */
export function parseFlagsTest(rawArgs: string[], schemaDesc: Record<string, string>): Record<string, unknown> {
  const schema: Record<string, ZodType> = {};
  for (const [k, v] of Object.entries(schemaDesc)) {
    if (v === 'number') schema[k] = z.number();
    else if (v === 'boolean') schema[k] = z.boolean().optional();
    else if (v === 'array') schema[k] = z.array(z.string());
    else if (v === 'object') schema[k] = z.object({}).passthrough();
    else schema[k] = z.string();
  }
  return parseFlags(rawArgs, schema);
}

export function parseFlags(rawArgs: string[], schema: Record<string, ZodType>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const arrayKeys = new Set(
    Object.entries(schema).filter(([, t]) => {
      const inner = t instanceof ZodOptional ? (t as any)._def.innerType : t;
      return inner instanceof ZodArray;
    }).map(([k]) => k),
  );

  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];

    if (arg.startsWith('--')) {
      // --key=value or --key value or --flag (boolean)
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        addValue(result, key, coerce(val, schema[key]), arrayKeys.has(key));
      } else {
        const key = arg.slice(2);
        // 下一个参数不是 flag → 当作 value
        if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('--')) {
          addValue(result, key, coerce(rawArgs[i + 1], schema[key]), arrayKeys.has(key));
          i++;
        } else {
          // bare --flag → true
          result[key] = true;
        }
      }
    } else if (arg.includes('=') && !arg.startsWith('{')) {
      // key=value (无 -- 前缀，兼容旧格式)
      const eqIdx = arg.indexOf('=');
      const key = arg.slice(0, eqIdx);
      const val = arg.slice(eqIdx + 1);
      addValue(result, key, coerce(val, schema[key]), arrayKeys.has(key));
    }
    // 忽略无法识别的 positional 参数
    i++;
  }
  return result;
}

export function coerce(val: string, schemaDef?: ZodType): unknown {
  // JSON object/array
  if ((val.startsWith('{') || val.startsWith('[')) && val.length > 1) {
    try { return JSON.parse(val); } catch { /* fall through */ }
  }
  // boolean
  if (val === 'true') return true;
  if (val === 'false') return false;
  // number (only if schema expects it)
  const inner = schemaDef instanceof ZodOptional ? (schemaDef as any)._def.innerType : schemaDef;
  if (inner instanceof ZodNumber && /^-?\d+(\.\d+)?$/.test(val)) return Number(val);
  return val;
}

export function addValue(obj: Record<string, unknown>, key: string, val: unknown, isArray: boolean) {
  if (isArray) {
    if (!Array.isArray(obj[key])) obj[key] = obj[key] !== undefined ? [obj[key]] : [];
    if (Array.isArray(val)) {
      (obj[key] as unknown[]).push(...val);
    } else {
      (obj[key] as unknown[]).push(val);
    }
  } else {
    obj[key] = val;
  }
}

// ── Resolve root ──

function resolveRoot(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.KOALA_PROJECT_ROOT) return process.env.KOALA_PROJECT_ROOT;
  // 向上查找 koala.config.json 确定项目根
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'koala.config.json'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  // fallback: git worktree root
  const commonDir = gitProbe('git rev-parse --git-common-dir');
  if (commonDir.ok) {
    const cd = commonDir.output;
    if (cd !== '.git' && !cd.endsWith('/.git') && !cd.endsWith('\\.git')) {
      const wtList = gitProbe('git worktree list --porcelain');
      if (wtList.ok) {
        return wtList.output.split('\n')[0]?.replace('worktree ', '').trim() || process.cwd();
      }
    }
  }
  return process.cwd();
}

function resolveMainRootFromWorktreeRoot(root: string): string | null {
  try {
    const dotGit = join(root, '.git');
    if (!existsSync(dotGit)) return null;
    const content = readFileSync(dotGit, 'utf-8').trim();
    const m = content.match(/^gitdir:\s*(.+)$/i);
    if (!m) return null;
    const gitdir = m[1].trim();
    const absGitdir = gitdir.startsWith('/') ? gitdir : join(root, gitdir);
    const marker = `${join('.git', 'worktrees')}`;
    const normalized = absGitdir.replace(/\\/g, '/');
    const markerNormalized = marker.replace(/\\/g, '/');
    const idx = normalized.indexOf(`/${markerNormalized}/`);
    if (idx === -1) return null;
    return normalized.slice(0, idx);
  } catch {
    return null;
  }
}

function resolveRootForCommand(cmd: string, explicit?: string): string {
  const root = resolveRoot(explicit);
  if (cmd !== 'story_discard') return root;
  return resolveMainRootFromWorktreeRoot(root) || root;
}

// ── Activity log filter ──

/**
 * Read-only commands that should NOT write activity.jsonl by default.
 * These are pure queries / status checks — logging them pollutes
 * the audit trail and can cause DONE dirty-self-block (B-c622).
 * Codex wrapper sessions opt in because session_brief is their primary
 * cross-session tracking heartbeat.
 */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'session_brief',
  'next',
  'status',
  'story_get',
  'story_list',
  'checklist_get',
  'finding_list',
  'bug_list',
  'test_list',
  'aux_doc_list',
  'reviewer_list',
  'workflow_explain',
  'help',
]);

function inferCodexEntrypoint(): string {
  if (process.env.KOALA_CODEX_ENTRYPOINT) return process.env.KOALA_CODEX_ENTRYPOINT;
  const invoked = process.argv[1] || '';
  if (invoked.includes('koala-codex')) return 'local-wrapper';
  if (process.env.KOALA_ACTIVITY_SOURCE === 'codex') return 'global-fallback';
  return 'cli';
}

function storyIdFromArgs(args: Record<string, unknown>, activeStory?: ActiveStory | null): string | null {
  if (typeof args.storyId === 'string' && args.storyId.trim()) return args.storyId.trim();
  if (typeof args.story === 'string' && args.story.trim()) return args.story.trim();
  return activeStory?.storyId || null;
}

/**
 * Decide whether a CLI invocation should be recorded in activity.jsonl.
 * Returns false for read-only commands and dry-run invocations.
 */
export function shouldWriteActivityLog(cmdName: string, args: Record<string, unknown>): boolean {
  if (READ_ONLY_COMMANDS.has(cmdName)) {
    return process.env.KOALA_ACTIVITY_RECORD_READONLY === '1';
  }
  if (args.dryRun === true) return false;
  return true;
}

// ── Main ──

/**
 * runCli — koala CLI 运行时入口
 *
 * @param opts.extraTools     第三方包的 ToolDef 列表，会合进 help 和 dispatch
 * @param opts.extraRegister  第三方包的 register 函数，在 createMainRegistry 之后调用
 *                            （收到 Registry 实例后用 registry.registerBatch(...) 注入 handler）
 */
export async function runCli(opts?: {
  extraTools?: ToolDef[];
  extraRegister?: (registry: Registry, ctx: HandlerContext) => void;
}): Promise<void> {
  // 注入 extras：合并 tool defs，并保留 extras register 待会儿调用
  TOOLS = opts?.extraTools && opts.extraTools.length > 0
    ? [...MAIN_TOOLS, ...opts.extraTools]
    : MAIN_TOOLS;

  const argv = process.argv.slice(2);

  // --root flag
  let rootOverride: string | undefined;
  const ri = argv.indexOf('--root');
  if (ri !== -1 && argv[ri + 1]) { rootOverride = argv[ri + 1]; argv.splice(ri, 2); }

  const cmd = argv[0];
  const arg = argv[1];

  // Detect active story from git branch
  const root0 = resolveRootForCommand(cmd, rootOverride);
  const activeStory = detectActiveStory(root0);
  const gitReady = isGitRepository(root0);

  if (!cmd || cmd === 'help' || cmd === '--help') { printHelp(activeStory); return; }

  // init 走独立脚本
  if (cmd === 'init') {
    const initPath = new URL('./cli-init.js', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
    await import(`file://${initPath}`);
    return;
  }

  // dashboard 走独立长驻模式
  if (cmd === 'dashboard') {
    const dashArgs = parseFlags(argv.slice(1), {
      roots: z.string().optional(),
      interval: z.number().optional(),
    });
    // 如果没指定 roots，用 --root（或自动检测）作为默认
    if (!dashArgs.roots) dashArgs.roots = root0;
    const { runDashboard } = await import('./dashboard.js');
    await runDashboard(dashArgs as { roots?: string; interval?: number });
    return;
  }

  const tool = TOOLS.find(t => t.name === cmd);
  if (!tool) {
    console.error(`未知命令: ${cmd}`);
    const m = TOOLS.filter(t => t.name.includes(cmd) || cmd.includes(t.name.split('_')[0]));
    if (m.length) { console.error('你是不是要找:'); for (const t of m) console.error(`  koala ${t.name}`); }
    console.error('用 koala help 查看所有命令');
    process.exit(1);
  }

  if (arg === '--help' || arg === '-h') { printToolHelp(tool); return; }

  // Phase gate: 有 active story 时，拒绝不在白名单中的命令
  if (activeStory) {
    const config = loadConfig(root0);
    if (!isCommandAllowed(cmd, activeStory.phase, config.phaseTools)) {
      const allowed = getAllowedPatterns(activeStory.phase, config.phaseTools);
      console.error(`❌ 命令 "${cmd}" 在 ${activeStory.phase} 阶段不可用`);
      console.error(`   Story: ${activeStory.storyId}  Phase: ${activeStory.phase}`);
      for (const line of formatCommandLifecycleHint(cmd, activeStory.phase, allowed)) console.error(line);
      console.error(`   当前阶段可用命令: ${allowed.join(', ')}`);
      process.exit(1);
    }
  }

  // Parse arguments — 支持三种格式：
  //   1. --key=value --flag (标准 flag)
  //   2. key=value          (简写 flag)
  //   3. '{"key":"value"}'  (JSON body, 兼容旧用法)
  let parsed: Record<string, unknown> = {};
  {
    const rawArgs = argv.slice(1);
    if (rawArgs.length === 0) {
      // 无参数，空对象
    } else if (rawArgs.length === 1 && rawArgs[0].startsWith('{')) {
      // JSON body 格式（兼容旧用法）
      try { parsed = JSON.parse(rawArgs[0]); }
      catch (e) {
        console.error(`JSON 解析失败: ${(e as Error).message}\n输入: ${rawArgs[0]}`);
        printToolHelp(tool, { stream: process.stderr, includeFooter: false });
        process.exit(1);
      }
    } else {
      // flag 格式解析
      parsed = parseFlags(rawArgs, tool.schema);
    }
  }

  // Validate
  const schema = z.object(tool.schema);
  const v = schema.safeParse(parsed);
  if (!v.success) {
    printValidationFailure(tool, v.error.issues);
    process.exit(1);
  }

  // Execute
  const root = resolveRootForCommand(cmd, rootOverride);
  const store = new StoryStore(root);
  const _cliStart = Date.now();
  let log: (msg: string) => void = (msg) => {
    const elapsed = ((Date.now() - _cliStart) / 1000).toFixed(1);
    process.stderr.write(`[${elapsed}s] ${msg}\n`);
  };

  const config0 = loadConfig(root);
  const scanRoot = join(root, config0.scanRoot);
  const ctx: HandlerContext = { store, root, scanRoot, log };
  const registry = createMainRegistry(ctx);
  if (opts?.extraRegister) opts.extraRegister(registry, ctx);
  const handlers = registry.toObject() as Record<string, Function>;

  // Stale state warnings — soft, never blocks. Print before handler dispatch
  // so the agent sees the reminder along with the command output. The captured
  // warnings are also passed into writeLog so activity.jsonl preserves them
  // for trend analysis (how often does the agent forget to advance?).
  let staleWarnings: string[] = [];
  try {
    staleWarnings = detectStaleState(ctx);
    if (staleWarnings.length > 0) {
      process.stderr.write('⚠ koala stale state warnings:\n');
      for (const w of staleWarnings) process.stderr.write(`  - ${w}\n`);
    }
  } catch { /* never block */ }

  // 心跳：默认 5 分钟无输出 = 卡死；15 分钟绝对保底。
  // 可通过 KOALA_IDLE_TIMEOUT_MS / KOALA_MAX_TIMEOUT_MS 覆盖，
  // 真机 smoke 的单轮 LLM 调用偶尔 > 2 分钟（text-adventure 卸载等非确定性 case）。
  const IDLE_TIMEOUT = Number(process.env.KOALA_IDLE_TIMEOUT_MS) || (5 * 60 * 1000);
  const MAX_TIMEOUT = Number(process.env.KOALA_MAX_TIMEOUT_MS) || (15 * 60 * 1000);
  const startTime = Date.now();
  let lastActivity = Date.now();
  const originalLog = log;
  log = (msg: string) => { lastActivity = Date.now(); originalLog(msg); };

  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - startTime > MAX_TIMEOUT) {
      originalLog(`${cmd} 超过 10 分钟，强制退出`);
      process.exit(2);
    }
    if (now - lastActivity > IDLE_TIMEOUT) {
      originalLog(`${cmd} 卡死：${IDLE_TIMEOUT / 1000} 秒无输出，强制退出`);
      process.exit(2);
    }
  }, 10000);
  watchdog.unref();

  // 统一日志：写入 .koala/activity.jsonl（双源模块，legacy 路径只读兼容）
  // 写入失败属于 PERSIST 类（audit 不完整 → 事后无法回溯），改为 reportHealthIssue
  // staleWarnings 也一并落盘，便于事后做趋势分析（agent 多久会忘记 advance 一次）
  function writeLog(entry: {
    command: string;
    args: unknown;
    startTime: string;
    endTime: string;
    success: boolean;
    error?: string;
    staleWarnings?: string[];
  }) {
    try {
      // B-9cd4 follow-up bug: story_advance --phase=DONE removes the current
      // worktree mid-command. The `root` captured at command start still
      // points at that worktree. If we appendActivityLog on the now-ghost
      // path, we re-create dirs and leave a dangling audit log that
      // masquerades as an active worktree.
      //
      // Detect this by checking if `root` still has koala.config.json. If
      // not (the worktree was removed), fall back to a fresh resolveRoot()
      // which walks up past the ghost to the real main project. If that
      // also lacks koala.config.json, skip logging entirely rather than
      // pollute the filesystem.
      let effectiveRoot = root;
      if (!existsSync(join(effectiveRoot, 'koala.config.json'))) {
        effectiveRoot = resolveRoot();
        if (!existsSync(join(effectiveRoot, 'koala.config.json'))) {
          return;
        }
      }
      const record: Record<string, unknown> = {
        source: process.env.KOALA_ACTIVITY_SOURCE || 'cli',
        session: process.env.KOALA_ACTIVITY_SESSION || '',
        entrypoint: inferCodexEntrypoint(),
        startTime: entry.startTime,
        endTime: entry.endTime,
        tool: entry.command,
        detail: entry.command,
        args: entry.args,
        status: entry.success ? 'ok' : 'fail',
        result: entry.success ? null : undefined,
        error: entry.error || null,
        storyId: storyIdFromArgs(entry.args as Record<string, unknown>, activeStory),
        phase: activeStory?.phase || null,
        role: inferActivityRole(entry.args, process.env.KOALA_ACTIVITY_ROLE || process.env.KOALA_AGENT),
      };
      if (entry.staleWarnings && entry.staleWarnings.length > 0) {
        record.staleWarnings = entry.staleWarnings;
      }
      appendActivityLog(effectiveRoot, record);
    } catch (e: unknown) {
      reportHealthIssue('persist:writeLog', e as Error, {
        command: entry.command,
        logDir: join(root, '.koala'),
      });
    }
  }

  function writeCodexProcessEvent(entry: {
    command: string;
    args: unknown;
    success: boolean;
    error?: string;
  }) {
    if ((process.env.KOALA_ACTIVITY_SOURCE || '') !== 'codex') return;
    const argsObject = entry.args && typeof entry.args === 'object' && !Array.isArray(entry.args)
      ? entry.args as Record<string, unknown>
      : {};
    const storyId = storyIdFromArgs(argsObject, activeStory);
    if (!storyId) return;
    try {
      let phase = activeStory?.phase || '';
      if (!phase) {
        try { phase = store.readStory(storyId).phase; } catch { phase = ''; }
      }
      store.appendProcessEvent(storyId, {
        type: 'codex_cli',
        source: 'codex',
        session: process.env.KOALA_ACTIVITY_SESSION || '',
        role: inferActivityRole(entry.args, process.env.KOALA_ACTIVITY_ROLE || process.env.KOALA_AGENT),
        storyId,
        phase,
        command: entry.command,
        entrypoint: inferCodexEntrypoint(),
        result: entry.success ? 'pass' : 'fail',
        ...(entry.error ? { errorSummary: entry.error.slice(0, 300) } : {}),
      });
    } catch (e: unknown) {
      reportHealthIssue('persist:codexProcessEvent', e as Error, {
        command: entry.command,
        storyId,
      });
    }
  }

  // Hook env factory — delegates to the shared helper in core/hooks.ts so
  // story-advance can call it the same way for onPhaseChange.
  function buildHookEnvLocal(stage: 'preCommand' | 'postCommand' | 'onError', extra: Record<string, string> = {}): Record<string, string> {
    return buildSharedHookEnv({
      stage,
      command: cmd,
      cwd: process.cwd(),
      root,
      argsJson: JSON.stringify(parsed),
      storyId: activeStory?.storyId,
      phase: activeStory?.phase,
      extra,
    });
  }

  async function run(fn: () => unknown | Promise<unknown>) {
    const runStart = new Date().toISOString();
    log(`running ${cmd}...`);
    // preCommand hook — non-blocking failure, awaited so it always runs before the handler
    if (config0?.hooks?.preCommand && !READ_ONLY_COMMANDS.has(cmd)) {
      process.stderr.write(`[koala-hook] running preCommand hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
    }
    if (!READ_ONLY_COMMANDS.has(cmd)) {
      await runHooks('preCommand', cmd, buildHookEnvLocal('preCommand'), config0, root);
    }
    try {
      let result = fn();
      if (result && typeof (result as any).then === 'function') result = await result;
      clearInterval(watchdog);
      log(`${cmd} done`);
      if (shouldWriteActivityLog(cmd, parsed) || staleWarnings.length > 0) {
        writeLog({ command: cmd, args: parsed, startTime: runStart, endTime: new Date().toISOString(), success: true, staleWarnings });
      }
      writeCodexProcessEvent({ command: cmd, args: parsed, success: true });
      // 注入 next-step hint（hints.ts 注册的命令才有效；其它命令原样返回）
      const hintActive: ActiveStoryInfo | null = activeStory
        ? { storyId: activeStory.storyId, phase: activeStory.phase }
        : null;
      result = decorateResult({
        cmd,
        args: parsed,
        result,
        store,
        root,
        activeStory: hintActive,
      });
      // postCommand hook — runs before we exit; failure does not block exit(0)
      const resultText = typeof result === 'string' ? result : JSON.stringify(result);
      if (config0?.hooks?.postCommand && !READ_ONLY_COMMANDS.has(cmd)) {
        process.stderr.write(`[koala-hook] running postCommand hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
      }
      if (!READ_ONLY_COMMANDS.has(cmd)) {
        await runHooks('postCommand', cmd, buildHookEnvLocal('postCommand', {
          KOALA_RESULT_JSON: truncateForEnv(resultText),
        }), config0, root);
      }
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } catch (e: any) {
      clearInterval(watchdog);
      log(`${cmd} failed: ${e.message}`);
      if (shouldWriteActivityLog(cmd, parsed) || staleWarnings.length > 0) {
        writeLog({ command: cmd, args: parsed, startTime: runStart, endTime: new Date().toISOString(), success: false, error: e.message, staleWarnings });
      }
      writeCodexProcessEvent({ command: cmd, args: parsed, success: false, error: e.message });
      // onError hook — best-effort; always runs before exit(1).
      // Print a hint so the user knows why a failed command takes a few extra seconds.
      if (config0?.hooks?.onError) {
        process.stderr.write(`[koala-hook] running onError hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
      }
      await runHooks('onError', cmd, buildHookEnvLocal('onError', {
        KOALA_ERROR: String(e?.message || e),
      }), config0, root);
      console.error(`错误: ${e.message}`);
      process.exit(1);
    }
  }

  // story_create: 停在 INIT 时追加下一步提示
  if (cmd === 'story_create') {
    await run(() => {
      const result = handlers.story_create(v.data);
      if (result.includes('created from draft') && result.includes('(phase=INIT_CHECK)')) {
        const storyId = result.match(/Story\s+([\w-]+)/)?.[1];
        if (!storyId) return result;
        if (!gitReady) {
          return `${result}\n⚠ 当前目录不是 git 仓库：story 已记录，但 from-draft worktree 不能自动创建。\n→ 先 git init + 首次 commit 后重试 story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}'`;
        }
        try {
          const wtResult = handlers.dev_start({ storyId });
          return `${result}\n\n${wtResult}\n\n→ 现在请 cd 到上述 worktree 路径，然后调 story_advance phase=PLAN 进入 PLAN`;
        } catch (e: any) {
          return `${result}\n⚠ worktree 创建失败: ${e.message}\n→ 排查后再次执行 story_advance --phase=INIT_CHECK 自动重试，或手动 dev_start '{"storyId":"${storyId}"}'`;
        }
      }
      if (!result.includes('(INIT)')) return result;
      const storyId = result.match(/Story\s+([\w-]+)/)?.[1];
      if (!storyId) return result;
      if (result.includes('当前目录不是 git 仓库')) return result;
      if (!gitReady) {
        return `${result}\n⚠ 当前目录不是 git 仓库：story 已记录，但 INIT_CHECK/worktree 流程还不能顺畅跑。\n→ 先在项目根执行 git init && git add . && git commit -m \"init\"，再 story_advance '{\"storyId\":\"${storyId}\",\"phase\":\"INIT_CHECK\"}'`;
      }
      return `${result}\n→ Story 停在 INIT 阶段。下一步:\n  1. story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}' 创建 worktree\n  2. cd 到提示的 worktree 路径\n  3. story_advance '{"storyId":"${storyId}","phase":"PLAN"}' 进入 PLAN（cwd 必须是 worktree）`;
    });
    return;
  }

  // story_advance phase=INIT_CHECK：成功后自动调 dev_start 创建 worktree
  // B-5246: phase 已经在 INIT_CHECK 时（重试场景）允许 dev_start 重跑而不抛
  // "Cannot transition INIT_CHECK→INIT_CHECK"。这样 worktree 第一次创建失败时 agent
  // 可以再次调 story_advance INIT_CHECK 重试，不必走 manual dev_start 这条隐藏路径。
  if (cmd === 'story_advance' && (v.data as any)?.phase === 'INIT_CHECK') {
    await run(async () => {
      const storyId = (v.data as any).storyId;
      if ((v.data as any).dryRun === true) {
        const story: any = handlers.story_get({ storyId, detail: true });
        const currentPhase = story?.index?.phase || 'unknown';
        return [
          `[DRY-RUN] INIT_CHECK bootstrap plan for ${storyId}`,
          `- current phase: ${currentPhase}`,
          `- would verify init-check gate without mutating story metadata`,
          `- would create/update branch story/${storyId} with scoped story bootstrap files`,
          `- would create worktree under configured worktreeDir`,
          `- no phase, branch, commit, or worktree changes were made`,
        ].join('\n');
      }
      // 探测当前 phase；若已在 INIT_CHECK 就跳过 advance 直接 dev_start 重试
      // story_get 默认返回 {checklist, review}；phase 需要 detail:true 才在 result.index.phase
      let advanceResult = '';
      try {
        const story: any = handlers.story_get({ storyId, detail: true });
        const currentPhase = story?.index?.phase;
        if (currentPhase === 'INIT_CHECK') {
          advanceResult = `Story ${storyId} 已在 INIT_CHECK 阶段，重试 worktree 创建`;
        } else {
          advanceResult = await handlers.story_advance(v.data);
        }
      } catch {
        // story_get 失败时退回原行为
        advanceResult = await handlers.story_advance(v.data);
      }
      try {
        const wtResult = handlers.dev_start({ storyId });
        return `${advanceResult}\n\n${wtResult}\n\n→ 现在请 cd 到上述 worktree 路径，然后调 story_advance phase=PLAN 进入 PLAN`;
      } catch (e: any) {
        return `${advanceResult}\n⚠ worktree 创建失败: ${e.message}\n→ 排查后再次执行 story_advance --phase=INIT_CHECK 自动重试，或手动 dev_start '{"storyId":"${storyId}"}'`;
      }
    });
    return;
  }

  const handler = handlers[cmd];
  if (!handler) { console.error(`handler not found: ${cmd}`); process.exit(1); }

  await run(() => Object.keys(tool.schema).length === 0 ? handler() : handler(v.data));
}
