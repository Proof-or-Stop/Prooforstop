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
import { isAbsolute, join } from 'path';
import { StoryStore } from './core/store.js';
import { createMainRegistry, type Registry } from './registry.js';
import type { HandlerContext } from './handlers/context.js';
import { execFileSync, execSync } from 'child_process';
import { loadConfig, isCommandAllowed, getAllowedPatterns } from './core/config.js';
import { formatCommandLifecycleHint } from './core/command-policy.js';
import { decorateResult, type ActiveStoryInfo } from './handlers/hints.js';
import { reportHealthIssue } from './core/health.js';
import { detectStaleState } from './core/stale-detector.js';
import { runHooks, truncateForEnv, buildHookEnv as buildSharedHookEnv, HOOK_TIMEOUT_MS } from './core/hooks.js';
import { gitProbe, isGitRepository } from './core/git-probe.js';
import {
  acquireOrRefreshOwnerLease,
  formatLeaseAge,
  formatNonOwnerError,
  getSessionId,
  takeOverOwnerLease,
} from './core/story-owner-lease.js';
import { getCommandPolicy, isOwnershipClass, type OwnershipClass } from './core/command-policy.js';
import { STORY_OUTCOME_KINDS, VERIFICATION_EVIDENCE_VERDICTS } from './core/types.js';
import { BACKGROUND_SECTION_IDS, normalizeBackgroundSection } from './core/background-validator.js';
import {
  ContextPackDependencyEdgeContractSchema,
  ContextPackSnippetContractSchema,
  ContextPackSymbolContractSchema,
  VerificationCommandContractSchema,
  VerificationContextPackContractSchema,
} from './core/authority-contracts.js';
import {
  STORY_CREATE_LONG, STORY_ADVANCE_LONG, CHECKLIST_UPDATE_LONG,
  STORY_REVIEW_LONG, BUG_REPORT_LONG, VALIDATE_LONG,
  SESSION_BRIEF_FOOTER,
} from './cli-prompts.js';
import {
  detectLatticeBrand,
  formatLatticeProductLine,
  formatLatticeVersionLine,
} from './core/lattice-brand.js';

// ── Tool Registry ──

export interface ToolDef {
  name: string;
  /** 一行描述（出现在 lattice help 列表里） */
  description: string;
  /** 完整 PROMPT（出现在 lattice <cmd> --help 里）。可选；缺省时只显示 description */
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

const capsuleEvidenceRefSchema = z.object({
  kind: z.string().optional(),
  path: z.string().optional(),
  intentRef: z.string().optional(),
  receiptId: z.string().optional(),
  processEventLine: z.number().optional(),
  authority: z.enum(['authoritative', 'non_authoritative']).optional(),
  note: z.string().optional(),
});

const capsuleProcessEventRefSchema = z.object({
  line: z.number().optional(),
  type: z.string().optional(),
  digest: z.string().optional(),
  note: z.string().optional(),
});

const backgroundSectionSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  return normalizeBackgroundSection(value) ?? value;
}, z.enum(BACKGROUND_SECTION_IDS));

const scopeFileRuleSchema = z.object({
  path: z.string().describe('Relative file path or simple glob covered by this semantic rule'),
  allowedAnchors: z.array(z.string()).optional().describe('Only these anchors may change'),
  deniedAnchors: z.array(z.string()).optional().describe('These anchors must not change'),
  protectedAnchors: z.array(z.string()).optional().describe('Hard-protected anchors'),
  allowedChangeKinds: z.array(z.enum(['add', 'remove', 'modify', 'rename'])).optional().describe('Allowed change kinds for matching hunks'),
  intentRefs: z.array(z.string()).optional().describe('Verification intent refs this rule protects'),
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
  { name: 'verification_context_pack_create', description: '从当前 git diff 机械生成 Verification Context Pack（供 verifier job/Runner 消费）', schema: {
    producerRunId: z.string().min(1).describe('实现者 run id'),
    storyId: z.string().optional().describe('Story ID'),
    baseRef: z.string().optional().describe('diff base ref，默认 HEAD'),
    headRef: z.string().optional().describe('diff head ref；默认 WORKTREE 表示未提交工作区'),
    packId: z.string().optional().describe('显式 pack id；缺省由 diff 生成稳定 id'),
    checklistItemIds: z.array(z.string()).optional().describe('该 pack 关联的 checklist item IDs'),
    testIntentRefs: z.array(z.string()).optional().describe('该 pack 必须覆盖的 verificationIntent refs'),
    acceptanceCriteria: z.array(z.string()).optional().describe('验收标准摘要'),
    requiredRefs: z.array(z.string()).optional().describe('额外 required refs'),
    requiredCommands: z.array(VerificationCommandContractSchema).optional().describe('verifier 必须执行/覆盖的命令约束'),
    oracleRefs: z.array(z.string()).optional().describe('oracle refs'),
    tokenBudget: z.number().int().nonnegative().optional().describe('source snippets token budget'),
    excludedPaths: z.array(z.string()).optional().describe('被排除路径，进入 pack 供审计'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('附加 metadata'),
  }},
  { name: 'verification_context_pack_expand', description: '基于 parent pack 生成受控扩展包（必须说明扩展原因）', schema: {
    parentPack: VerificationContextPackContractSchema.describe('上一个 Verification Context Pack'),
    packId: z.string().optional().describe('新 pack id'),
    expansionReason: z.string().min(10).describe('扩展原因（≥10 字符）'),
    impactedFiles: z.array(z.string()).optional().describe('新增 impacted files'),
    impactedSymbols: z.array(ContextPackSymbolContractSchema).optional().describe('新增 impacted symbols'),
    sourceSnippets: z.array(ContextPackSnippetContractSchema).optional().describe('新增 source snippets'),
    dependencyEdges: z.array(ContextPackDependencyEdgeContractSchema).optional().describe('新增 dependency edges'),
    requiredRefs: z.array(z.string()).optional().describe('新增 required refs'),
    tokenBudget: z.number().int().nonnegative().optional().describe('新 token budget'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('附加 metadata'),
  }},
  // B-a2f1 CHK-003: single-shot recover — refresh stale evidence + revalidate.
  { name: 'recover_evidence', description: 'Single-shot recover：refresh stale evidence + revalidate（仅在 worktree 只剩 koala metadata / runtime / declared artifact 时放行）', schema: {
    storyId: z.string().min(1).describe('Story ID'),
  }},
  // B-cf60: per-story declared product artifact — register a generated path so
  // the dirty-worktree classifier groups it under declared_artifact_changes
  // instead of unexpected_dirty_files. DONE gate then checks every declared
  // path is referenced from verificationEvidence or delivery-check.docsPromises.
  { name: 'artifact_declare', description: '把一个生成物路径声明为本 story 的预期产出，使 dirty classifier 归为 declared_artifact_changes，并要求 DONE gate 有匹配的 verificationEvidence/promise 引用', schema: {
    storyId: z.string().min(1).describe('Story ID'),
    path: z.string().min(1).describe('相对仓库根的精确路径（无 glob/通配符；无 leading slash；无 .. 段）'),
    reason: z.string().min(10, 'reason ≥ 10 characters').describe('为什么把此文件声明为本 story 的预期产出'),
    relatedIntent: z.string().min(1).describe('关联引用：CHK-NNN:(happy|edge|adversarial):IDX 或 promise:<docPath>'),
  }},
  { name: 'light_review', description: '记录一次轻量 review（DEV 阶段每完成一批 item 后调用）', schema: {
    storyId: z.string().describe('Story ID'),
    checklistIds: z.array(z.string()).describe('本次 review 覆盖的 checklist item ID 列表'),
    note: z.string().optional().describe('review 备注'),
  }},
  { name: 'review_run_start', description: '启动一次当前 REVIEW round 的 reviewer run，并写入 signed review-runs.json', schema: {
    storyId: z.string().describe('Story ID'),
    agent: z.string().optional().describe('reviewer agent id（如 koala-review-quality；默认 KOALA_AGENT）'),
    lane: z.enum([
      'koala-review-concept',
      'koala-review-quality',
      'koala-review-test-coverage',
      'koala-review-behavior',
      'koala-review-docs',
      'koala-review-channel',
    ]).optional().describe('显式 reviewer lane；与 agent 同义，传一个即可'),
    prompt: z.string().optional().describe('reviewer 实际收到的 prompt 文本；若提供会自动计算 promptHash'),
    promptHash: z.string().optional().describe('reviewer prompt 的 sha256；若同时传 prompt，必须与 prompt 实际哈希一致'),
    reviewedIntentRefs: z.array(z.string()).optional().describe('scope-protected story：reviewer 本轮检查的 verification intent refs（计入 scope binding，可选）'),
  }},
  { name: 'review_pass_set', description: '记录 reviewer 已审查且无 blocking finding 的通过凭证', schema: {
    storyId: z.string().describe('Story ID'),
    agent: z.string().optional().describe('reviewer agent id（如 koala-review-quality；默认 KOALA_AGENT）'),
    reviewRunId: z.string().describe('当前 reviewer run id（先调用 review_run_start 获取）'),
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
  // Grill planning artifact (PLAN context only; not verification/validation evidence)
  { name: 'grill_start', description: '启动 PLAN grill 澄清 session（写 grill.json，不写证据）', schema: {
    storyId: z.string().describe('Story ID'),
    topic: z.string().optional().describe('本轮 grill 的主题或焦点'),
  }},
  { name: 'grill_record', description: '记录 grill 问题和回答（无回答则 unresolved）', schema: {
    storyId: z.string().describe('Story ID'),
    sessionId: z.string().optional().describe('Grill session ID；缺省使用最新 open session'),
    question: z.string().describe('澄清问题'),
    answer: z.string().optional().describe('回答；缺省时记录为 unresolved'),
    status: z.enum(['answered', 'unresolved']).optional().describe('问题状态；缺省由 answer 是否存在推断'),
    source: z.string().optional().describe('可选来源，如 user / reviewer / implementer'),
  }},
  { name: 'grill_close', description: '关闭 grill session，并返回 remainingUnknowns', schema: {
    storyId: z.string().describe('Story ID'),
    sessionId: z.string().optional().describe('Grill session ID；缺省使用最新 open session'),
    note: z.string().optional().describe('关闭备注'),
    closedBy: z.string().optional().describe('关闭者标识'),
  }},
  { name: 'grill_get', description: '读取 grill planning artifact', schema: {
    storyId: z.string().describe('Story ID'),
    sessionId: z.string().optional().describe('只读取指定 grill session'),
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
    skipReasons: z.record(z.string(), z.string()).optional().describe('{case name: reason} 对每条 sandbox:false 但没跑的 case 说明原因；未提供则 Lattice 报错列出缺失项'),
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
    storyId: z.string().optional().describe('已废弃；当前 story 验证请用 lattice validate --story=<storyId> 并记录 verificationEvidence'),
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
  { name: 'capsule_show', description: '显示 story session capsule（投影状态，不是 gate evidence）', schema: {
    storyId: z.string().optional().describe('Story ID'),
    story: z.string().optional().describe('Story ID alias'),
    format: z.enum(['text', 'json']).optional().describe('输出格式'),
    strict: z.boolean().optional().describe('引用缺失时 hard fail'),
  }},
  { name: 'capsule_update', description: '创建/更新 story session capsule 投影', schema: {
    storyId: z.string().optional().describe('Story ID'),
    story: z.string().optional().describe('Story ID alias'),
    rebuild: z.boolean().optional().describe('从 story/checklist/process-events 重建基础 capsule'),
    summary: z.string().optional().describe('摘要'),
    nextAction: z.string().optional().describe('下一步'),
    currentChecklistId: z.string().optional().describe('当前 checklist item'),
    activeRunId: z.string().optional().describe('当前/最近 run id'),
    openBlockers: z.array(z.string()).optional().describe('未解决 blocker 摘要'),
    evidenceRefs: z.array(capsuleEvidenceRefSchema).optional().describe('证据引用'),
    processEventRefs: z.array(capsuleProcessEventRefSchema).optional().describe('process-events 引用'),
    strict: z.boolean().optional().describe('引用缺失时拒绝写入'),
  }},
  { name: 'capsule_handoff', description: '写入 handoff.md 并更新 capsule next action', schema: {
    storyId: z.string().optional().describe('Story ID'),
    story: z.string().optional().describe('Story ID alias'),
    nextAction: z.string().describe('下一步'),
    notes: z.string().optional().describe('交接备注'),
    openBlockers: z.array(z.string()).optional().describe('未解决 blocker 摘要'),
  }},
  { name: 'capsule_run_add', description: '记录 story capsule run 摘要和指标', schema: {
    storyId: z.string().optional().describe('Story ID'),
    story: z.string().optional().describe('Story ID alias'),
    runId: z.string().optional().describe('Run ID'),
    checklistId: z.string().optional().describe('关联 checklist item'),
    provider: z.string().optional().describe('CLI/provider，如 codex/claude-code/gemini'),
    model: z.string().optional().describe('模型'),
    vendor: z.string().optional().describe('供应商'),
    role: z.enum(['implementer', 'reviewer', 'tester', 'verifier', 'main', 'other']).optional().describe('run 角色'),
    result: z.enum(['pass', 'fail', 'blocked', 'unknown']).optional().describe('run 结果'),
    commands: z.array(z.string()).optional().describe('执行命令摘要'),
    transcript: z.string().optional().describe('关键 transcript 摘录'),
    evidenceRefs: z.array(capsuleEvidenceRefSchema).optional().describe('证据引用'),
    processEventRefs: z.array(capsuleProcessEventRefSchema).optional().describe('process-events 引用'),
    metrics: z.record(z.string(), z.unknown()).optional().describe('指标摘要'),
    artifacts: z.record(z.string(), z.unknown()).optional().describe('artifact 摘要'),
  }},
  { name: 'aux_doc_list', description: '列出项目文档（PLAN 阶段挑选 relatedDocs 用）', schema: {
    format: z.enum(['text', 'json']).optional().describe('输出格式（默认 text）'),
  }},
  { name: 'capability_list', description: 'List host-neutral Koala capability profiles and degradations (text/json)', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'capability_probe', description: 'Probe one host-neutral Koala capability profile and visible degradations (text/json)', schema: {
    host: z.string().describe('Host profile id, for example codex, claude-code, local-runner, browser, server, desktop-app'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'host_list', description: 'List Lattice host profiles, visible degradations, and migration authority boundaries (text/json). Alias: lattice host list', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'host_probe', description: 'Probe one Lattice host profile without claiming production authority (text/json). Alias: lattice host probe', schema: {
    host: z.string().describe('Host profile id, for example codex, claude-code, local-runner, browser, server, desktop-app'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'host_status', description: 'Report overflow-readiness status for one Lattice host without changing authority (text/json). Alias: lattice host status', schema: {
    host: z.string().describe('Host profile id, for example claude-code or codex'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'host_install', description: 'Show dry-run Lattice host install guidance only; no third-party installs are executed. Alias: lattice host install', schema: {
    host: z.string().describe('Host profile id to show guidance for'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'lattice_config_doctor', description: 'Report Lattice CLI 0.3.5 migration readiness and Mac App demotion status (text/json). Alias: lattice config doctor', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'rollout_check', description: 'Run read-only cross-project Lattice rollout diagnostics for install drift, managed assets, runtime footprint, and transcript scope. Alias: lattice rollout check', schema: {
    projects: z.union([z.string(), z.array(z.string())]).optional().describe('Comma-separated project paths or JSON array; omit to scan the current root'),
    maxDepth: z.number().optional().describe('Discovery depth when projects is omitted (default 1)'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'authority_status', description: 'Report receipt-aware authority settings and enforce readiness diagnostics without submitting evidence or verifying receipts. Alias: lattice authority status', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
    authorityMode: z.string().optional().describe('Optional authority mode override for diagnostics only'),
    authorityURL: z.string().optional().describe('Optional authority URL override for diagnostics only'),
    authorityTimeoutMS: z.number().optional().describe('Optional authority timeout override for diagnostics only'),
  }},
  { name: 'conduit_status', description: 'Report Lattice conduit status and enforce readiness diagnostics without provisioning a runner or production authority. Alias: lattice conduit status', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'conduit_explain', description: 'Explain the CLI conduit migration boundary and no-overclaim semantics. Alias: lattice conduit explain', schema: {
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    json: z.boolean().optional().describe('Shortcut for --format=json'),
  }},
  { name: 'story_export', description: 'Export a Koala Story as Canonical Story v0 without claiming production authority', schema: {
    storyId: z.string().describe('Story ID to export'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for canonical-story JSON'),
  }},
  { name: 'handoff_create', description: 'Create a Lattice handoff pack from one host to another without manufacturing production DONE', schema: {
    storyId: z.string().describe('Story ID to include in the handoff pack'),
    fromHost: z.string().describe('Source host profile id'),
    toHost: z.string().describe('Target host profile id'),
    role: z.string().optional().describe('Optional overflow role for the external worker'),
    objective: z.string().optional().describe('Optional bounded objective for the overflow worker'),
    allowedPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Optional allowed file paths/globs for overflow edits'),
    deniedPaths: z.union([z.string(), z.array(z.string())]).optional().describe('Optional denied file paths/globs for overflow edits'),
    requiredCommands: z.union([z.string(), z.array(z.string())]).optional().describe('Optional required local commands the overflow worker must run or report'),
    successCriteria: z.union([z.string(), z.array(z.string())]).optional().describe('Optional success criteria for the overflow worker'),
    baseSha: z.string().optional().describe('Optional explicit base SHA; defaults to current HEAD'),
    packId: z.string().optional().describe('Optional explicit pack id; defaults to HP-<digest>'),
    authorityBoundary: z.string().optional().describe('Optional authority-boundary summary carried into the pack'),
    executionInstructions: z.union([z.string(), z.array(z.string())]).optional().describe('Optional execution instructions for the overflow worker'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for handoff-pack JSON'),
  }},
  { name: 'handoff_inspect', description: 'Inspect a Lattice handoff pack and show capability deltas, degradations, evidence refs, and authority boundary', schema: {
    file: z.string().describe('Handoff pack JSON file'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
  }},
  { name: 'handoff_accept', description: 'Accept a Lattice handoff pack as a process-event style projection without changing authority', schema: {
    file: z.string().describe('Handoff pack JSON file'),
    acceptedByHost: z.string().optional().describe('Accepting host profile id; defaults to the handoff target host'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for accept projection JSON; refuses to overwrite'),
  }},
  { name: 'handoff_resume', description: 'Project a resume plan from a handoff pack or accept projection without refreshing evidence or authority', schema: {
    file: z.string().describe('Handoff pack JSON file or handoff_accept projection JSON file'),
    resumeHost: z.string().optional().describe('Resume host profile id; defaults to acceptedByHost or target host'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for resume projection JSON; refuses to overwrite'),
  }},
  { name: 'handoff_receipt_submit', description: 'Validate and accept a local overflow receipt as diagnostic evidence only; never changes authority', schema: {
    file: z.string().describe('Handoff receipt JSON file'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for receipt-submit projection JSON; refuses to overwrite'),
  }},
  { name: 'handoff_worktree_create', description: 'Project isolated overflow worktree guidance from a handoff pack without creating or merging anything', schema: {
    file: z.string().describe('Handoff pack JSON file'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for worktree projection JSON; refuses to overwrite'),
  }},
  { name: 'host_dispatch', description: 'Project supervised host dispatch for an overflow pack without auto-trust, evidence submit, receipt verify, or merge', schema: {
    host: z.string().describe('Target host profile id, for example claude-code'),
    file: z.string().describe('Handoff pack JSON file'),
    mode: z.enum(['supervised']).optional().describe('Dispatch mode; only supervised projection is supported'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for dispatch projection JSON; refuses to overwrite'),
  }},
  { name: 'evidence_manifest', description: 'Create a portable evidence freshness manifest with transcript/test refs and authority guidance only', schema: {
    storyId: z.string().describe('Story ID to inspect for evidence refs'),
    sourceHost: z.string().describe('Source host profile id for portability diagnostics'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for evidence manifest JSON; refuses to overwrite'),
  }},
  { name: 'evidence_inspect', description: 'Inspect a portable evidence manifest or Story evidence against current HEAD/material hash without refreshing evidence', schema: {
    file: z.string().optional().describe('Evidence manifest JSON file; mutually exclusive with storyId'),
    storyId: z.string().optional().describe('Story ID for story-based evidence inspection; mutually exclusive with file'),
    sourceHost: z.string().optional().describe('Source host profile id for story-based inspection; defaults to codex'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for evidence inspection JSON; refuses to overwrite'),
  }},
  { name: 'parallel_wave_create', description: 'Create a Lattice Parallel Wave scheduling projection over Canonical Stories without authority changes', schema: {
    storyIds: z.array(z.string()).optional().describe('Story IDs to include; omit to analyze active stories'),
    hosts: z.array(z.string()).optional().describe('Host profile ids to consider; defaults to codex'),
    waveId: z.string().optional().describe('Optional stable wave id; defaults to a deterministic id from story refs'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for wave JSON; refuses to overwrite'),
  }},
  { name: 'parallel_wave_inspect', description: 'Inspect a Lattice Parallel Wave JSON file without refreshing evidence or authority', schema: {
    file: z.string().describe('Parallel Wave JSON file'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for inspection JSON; refuses to overwrite'),
  }},
  { name: 'parallel_plan', description: 'Produce a parallel execution plan from a wave file or active stories without creating authority evidence', schema: {
    file: z.string().optional().describe('Parallel Wave JSON file; omit to analyze active stories or provided storyIds'),
    storyIds: z.array(z.string()).optional().describe('Story IDs to include when no file is provided'),
    hosts: z.array(z.string()).optional().describe('Host profile ids to consider when no file is provided; defaults to codex'),
    waveId: z.string().optional().describe('Optional stable wave id when creating an ad hoc plan'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for plan JSON; refuses to overwrite'),
  }},
  { name: 'parallel_dispatch', description: 'Project operator-confirmed parallel dispatch entries without spawning agents or changing authority', schema: {
    file: z.string().optional().describe('Parallel Wave JSON file; omit to analyze active stories or provided storyIds'),
    storyIds: z.array(z.string()).optional().describe('Story IDs to include when no file is provided'),
    hosts: z.array(z.string()).optional().describe('Host profile ids to consider when no file is provided; defaults to codex'),
    waveId: z.string().optional().describe('Optional stable wave id when creating an ad hoc dispatch projection'),
    includeExperience: z.boolean().optional().describe('Include bounded non-authoritative dev-memory refs (default false)'),
    experienceQuery: z.string().optional().describe('Query for bounded dev-memory refs when includeExperience=true'),
    maxExperienceRefs: z.number().optional().describe('Maximum dev-memory refs to include; capped by core policy'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for dispatch JSON; refuses to overwrite'),
  }},
  { name: 'parallel_status', description: 'Project parallel wave status counts and ready/blocked guidance without authority changes', schema: {
    file: z.string().optional().describe('Parallel Wave JSON file; omit to analyze active stories or provided storyIds'),
    storyIds: z.array(z.string()).optional().describe('Story IDs to include when no file is provided'),
    hosts: z.array(z.string()).optional().describe('Host profile ids to consider when no file is provided; defaults to codex'),
    waveId: z.string().optional().describe('Optional stable wave id when creating an ad hoc status projection'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for status JSON; refuses to overwrite'),
  }},
  { name: 'parallel_merge_queue', description: 'Project merge queue readiness and blockers from a Parallel Wave without mutating story state', schema: {
    file: z.string().optional().describe('Parallel Wave JSON file; omit to analyze active stories or provided storyIds'),
    storyIds: z.array(z.string()).optional().describe('Story IDs to include when no file is provided'),
    hosts: z.array(z.string()).optional().describe('Host profile ids to consider when no file is provided; defaults to codex'),
    waveId: z.string().optional().describe('Optional stable wave id when creating an ad hoc merge queue projection'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for merge queue JSON; refuses to overwrite'),
  }},
  { name: 'parallel_report', description: 'Project a full parallel wave report with dispatch, evidence, guidance, and bounded memory refs', schema: {
    file: z.string().optional().describe('Parallel Wave JSON file; omit to analyze active stories or provided storyIds'),
    storyIds: z.array(z.string()).optional().describe('Story IDs to include when no file is provided'),
    hosts: z.array(z.string()).optional().describe('Host profile ids to consider when no file is provided; defaults to codex'),
    waveId: z.string().optional().describe('Optional stable wave id when creating an ad hoc report projection'),
    includeExperience: z.boolean().optional().describe('Include bounded non-authoritative dev-memory refs (default false)'),
    experienceQuery: z.string().optional().describe('Query for bounded dev-memory refs when includeExperience=true'),
    maxExperienceRefs: z.number().optional().describe('Maximum dev-memory refs to include; capped by core policy'),
    format: z.enum(['text', 'json']).optional().describe('Output format (default text)'),
    output: z.string().optional().describe('Optional file path for report JSON; refuses to overwrite'),
  }},

  // Doctor (health issue 巡检)
  { name: 'doctor', description: '查看 Lattice 自身的 health issue（被 silent catch 接住的 PERSIST 失败）+ 扫 .worktrees/ 孤儿目录', schema: {
    format: z.enum(['text', 'json']).optional().describe('输出格式（默认 text）'),
    limit: z.number().optional().describe('最多读取条数（默认 1000）'),
    repair: z.boolean().optional().describe('清理 DONE/DISCARDED terminal worktree 注册项、孤儿目录与 prunable 元数据'),
  }},
  { name: 'done_recover', description: '恢复 phase 已 DONE 但 story 分支尚未合并 main 的 partial-DONE story', schema: {
    storyId: z.string().describe('要恢复的 Story ID'),
  }},
  { name: 'verify_codex', description: '验证 Codex adapter 资产、入口 heartbeat 与硬证据', schema: {
    json: z.boolean().optional().describe('结构化 JSON 输出'),
    storyId: z.string().optional().describe('可选 Story ID；缺省从 story/* 分支推断并记录 process-event evidence'),
  }},
  { name: 'check', description: '检查 Koala 管理资产/模板漂移；--apply/--upgrade 显式同步安全项', schema: {
    json: z.boolean().optional().describe('结构化 JSON 输出'),
    apply: z.boolean().optional().describe('同步 MISSING/STALE_SAFE 管理资产；不会覆盖 CASE_MISMATCH/STALE_LOCAL_EDIT/INCOMPATIBLE'),
    upgrade: z.boolean().optional().describe('同步 MISSING/STALE_SAFE 管理资产到当前 Koala 模板；等价于 --apply'),
    reviewLocalEdits: z.boolean().optional().describe('输出 STALE_LOCAL_EDIT 的结构化人工审查摘要'),
    profile: z.enum(['codex', 'claude', 'all', 'core']).optional().describe('覆盖自动检测的 init profile'),
  }},

  // Audit (framework self-audit — 跨 story 扫 CLAUDE.md 承诺 vs 实际 CLI 行为 drift)
  { name: 'audit', description: '框架自省 audit（机械扫 CLAUDE.md drift → 写 B-META-framework-audit finding + report.md）', schema: {
    framework: z.boolean().optional().describe('扫 CLAUDE.md / packages/koala/CLAUDE.md 的 CLI 命令/flag/路径 drift（当前 MVP 唯一档）'),
    mode: z.enum(['semi-auto', 'full-auto', 'off']).optional().describe('覆盖配置默认模式；off = 直接退出不跑'),
  }},

  // Gap Log (B-3fad CHK-002: 框架 gap 手动归档入口)
  // 写 B-META-framework-audit findings（不存在则 ensureMetaStory bootstrap）；不依赖 reviewer /
  // review round / story worktree，不参与 lifecycle gate。默认 evidenceState=suspected；
  // verified 需配套结构化 evidence（runtime 同标准校验，见 CLAUDE.md「Handler 编码约定」）。
  { name: 'gap_log', description: '手动归档一个框架 gap 进 B-META-framework-audit backlog', schema: {
    category: z.enum(['happy', 'edge', 'adversarial', 'missing']).describe('finding 分类'),
    severity: z.enum(['critical', 'high', 'medium', 'low']).describe('严重度'),
    evidence: z.string().min(1, 'evidence 必填且 ≥ 1 字符').describe('gap 描述（即 finding 的 evidence note）'),
    sourceRefs: z.array(z.string()).optional().describe('来源溯源：源码/文档位置（如 src/foo.ts:42）'),
    reproCommand: z.string().optional().describe('来源溯源：复现/观察命令'),
    observedOutput: z.string().optional().describe('来源溯源：观察到的实际输出'),
    analysisNote: z.string().optional().describe('来源溯源：分析说明'),
    evidenceState: z.enum(['suspected', 'verified']).optional()
      .describe('证据状态：默认 suspected；verified 仅当提供结构化 evidence，否则强制降回 suspected'),
    uncertaintyReason: z.string().optional().describe('suspected 时的怀疑理由（可选，缺省自动兜底）'),
    files: z.array(z.string()).optional().describe('关联文件路径'),
    agent: z.string().optional().describe('调用者身份（审计字段，默认从 KOALA_AGENT 读）'),
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
    port: z.number().optional().describe('lattice serve 端口（默认 3456）'),
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
    reviewRunId: z.string().optional().describe('koala-review-* reviewer 当前 run id（先调用 review_run_start 获取；main finding 可省略）'),
    files: z.array(z.string()).optional().describe('关联文件路径（用于 reviewer finding cluster 与溯源）'),
    // B-3fad CHK-001: 证据状态轴。省略时默认 verified（REVIEW 阶段 reviewer finding，保持现有 gate 行为）。
    // suspected 必须带 uncertaintyReason；disproven 必须带 disprovenEvidence.summary（runtime 同标准校验）。
    evidenceState: z.enum(['suspected', 'verified', 'disproven']).optional()
      .describe('证据状态：suspected（怀疑，不阻塞 gate）/ verified（默认，有证据，阻塞）/ disproven（已反证，不阻塞）'),
    uncertaintyReason: z.string().optional()
      .describe('evidenceState=suspected 时必填（≥10 字符）：为什么只是怀疑'),
    disprovenEvidence: z.object({
      summary: z.string().describe('反证摘要：为什么这条 finding 不成立'),
      sourceRefs: z.array(z.string()).optional().describe('反证引用的源码/文档位置'),
      reproCommand: z.string().optional().describe('反证用到的复现/验证命令'),
    }).optional().describe('evidenceState=disproven 时必填：反证摘要 + 命令 + 源码引用'),
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

  // Init Check fallback/repair (B-95d8 CHK-001: explicit, auditable INIT_CHECK exit
  // for environments that cannot spawn the init reviewer subagent).
  // Default-disabled: refuses without BOTH acknowledge=true AND fallbackReason (>=30).
  // Reuses signInitCheck — does NOT weaken the gate or add agentId identity checks.
  { name: 'init_check_repair', description: '受控 fallback：无法 spawn INIT reviewer 时显式、可审计地生成签名 init-check.json（默认禁用，需 acknowledge + fallbackReason）', schema: {
    storyId: z.string().describe('Story ID'),
    fallbackReason: z.string().min(30, 'fallbackReason 必须 ≥ 30 字符').describe('为什么 INIT reviewer 无法运行 + 你人工核查了什么（durable 审计 attestation）'),
    acknowledge: z.boolean().describe('必须显式传 true：确认你在刻意顶替独立 INIT reviewer 做 attestation'),
    mode: z.enum(['repair', 'fallback']).optional().describe("审计分类：repair（修复缺失出口）/ fallback（无 subagent 环境顶替），默认 repair"),
    evidenceRefs: z.array(z.string()).optional().describe('可选：人工核查依据的证据引用（文件/URL/transcript 摘要）'),
    issues: z.array(z.object({
      id: z.string().optional().describe('自分配 id，可选'),
      severity: z.enum(['critical', 'high', 'medium', 'low']).describe('issue 严重度'),
      desc: z.string().min(1, 'desc 必填且 ≥ 1 字符').describe('issue 具体描述'),
    })).optional().describe('可选：人工 attestation 提出的 issue；high/critical 仍会阻塞 INIT_CHECK'),
    actor: z.string().optional().describe('可选：操作者标识；缺省取 git user.name'),
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
  // B-9d95 CHK-004: deprecated alias，首行 stdout 打印 deprecation warning，建议改用 `lattice dispatch`
  { name: 'finding_dispatch', description: '[deprecated: 请改用 lattice dispatch] 生成标准 reviewer-finding 修复 prompt 字符串', schema: {
    storyId: z.string().describe('Story ID'),
    findingId: z.string().describe('Finding ID（如 F-001 或 B-xxx:F-001 完整形式）'),
    agentType: z.string().optional().describe('subagent 类型（如 koala-implementer / koala-review-channel）；复用 CHK-008 分级矩阵'),
  }},

  // Unified dispatch (B-9d95 CHK-004: story_dispatch / finding_dispatch 合并为 `lattice dispatch`，全阶段开放)
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
    section: backgroundSectionSchema.describe('目标段 id：trigger_event / key_insight / tradeoff / conversation_texture；legacy 中文段名会归一'),
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
    forceReviewer: z.string().optional().describe('逗号分隔的内置 REVIEW reviewer lane 或短名，强制加挂；写入 story.events 审计（reviewer_forced）'),
  }},

  // Workflow profile
  { name: 'workflow_set', description: '设置项目 workflow profile（light/balanced/strict）', schema: {
    profile: z.string().describe('目标 profile：light / balanced / strict'),
  }},
  { name: 'workflow_show', description: '显示当前 workflow profile 和生效策略', schema: {} },
  { name: 'workflow_explain', description: '解释某个 story 的实际生效 profile（project / required / effective）', schema: {
    storyId: z.string().describe('Story ID'),
  }},

  // B-be27: Scope Contract — story-scoped allowed-file contract + post-diff gate
  { name: 'scope_contract_set', description: 'Create or update the scope contract for a story (allowed/protected/excluded files, mode)', schema: {
    storyId: z.string().describe('Story ID'),
    mode: z.enum(['local', 'shadow', 'enforce']).describe('Gate behavior: local=advisory, shadow=warn, enforce=block on violations'),
    allowedModify: z.array(z.string()).optional().describe('Files/globs allowed to be modified'),
    allowedCreate: z.array(z.string()).optional().describe('Files/globs allowed to be created'),
    allowedTest: z.array(z.string()).optional().describe('Test files/globs (always allowed)'),
    protectedFiles: z.array(z.string()).optional().describe('Files that must not change (block in enforce)'),
    explicitExcludes: z.array(z.string()).optional().describe('Files explicitly out of scope'),
    scopeChangeReason: z.string().optional().describe('Human explanation for a deliberate scope change'),
    fileRules: z.array(scopeFileRuleSchema).optional().describe('Per-file semantic anchor rules'),
    protectedAnchors: z.array(z.string()).optional().describe('Globally protected anchors'),
  }},
  { name: 'scope_contract_show', description: 'Show the current scope contract for a story', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  { name: 'scope_contract_check', description: 'Run the post-diff scope gate (compares git diff against contract)', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output structured JSON with status, violations, warnings'),
  }},
  { name: 'scope_contract_acknowledge', description: 'Record an explicit out-of-scope change acknowledgement (requires reason ≥ 20 chars)', schema: {
    storyId: z.string().describe('Story ID'),
    paths: z.array(z.string()).describe('Out-of-scope paths being acknowledged'),
    reason: z.string().min(20, 'reason must be ≥ 20 characters').describe('Why these out-of-scope paths are necessary (≥ 20 chars)'),
    actor: z.string().optional().describe('Actor making the acknowledgement (default: main-agent)'),
    anchors: z.array(z.string()).optional().describe('Semantic anchors covered by this acknowledgement'),
    hunkDigest: z.string().optional().describe('Single hunk digest covered by this acknowledgement'),
    hunkDigests: z.array(z.string()).optional().describe('Multiple hunk digests covered by this acknowledgement'),
  }},
  { name: 'scope_diff_pack', description: 'Generate a mechanical diff context pack with hunk digests and anchors', schema: {
    json: z.boolean().optional().describe('Output structured JSON'),
  }},
  { name: 'scope_contract_init_from_plan', description: 'Initialize a story scope contract from PLAN checklist files', schema: {
    storyId: z.string().describe('Story ID'),
    mode: z.enum(['local', 'shadow', 'enforce']).optional().describe('Gate behavior (default enforce)'),
    protectedFiles: z.array(z.string()).optional().describe('Files that must not change'),
    explicitExcludes: z.array(z.string()).optional().describe('Files explicitly out of scope'),
    scopeChangeReason: z.string().optional().describe('Reason recorded on the generated contract'),
  }},
  { name: 'guard_session_start', description: 'Start (or restart) a Koala-managed scope-guard session projection for a story', schema: {
    storyId: z.string().describe('Story ID'),
    provider: z.string().min(1, 'provider is required').describe('Agent provider runtime (e.g. claude-code, codex). Providers without pre-tool hooks run as watcher-fallback.'),
    json: z.boolean().optional().describe('Output structured JSON'),
  }},
  { name: 'guard_session_status', description: 'Read the current guard session projection for a story', schema: {
    storyId: z.string().describe('Story ID'),
    json: z.boolean().optional().describe('Output structured JSON'),
  }},
  { name: 'guard_session_check', description: 'Check current diff against the guard session scope contract and record any forbidden writes', schema: {
    storyId: z.string().describe('Story ID'),
    simulatedWrites: z.array(z.string()).optional().describe('Paths to evaluate as if written (test/dry-run forbidden-write simulation)'),
    json: z.boolean().optional().describe('Output structured JSON'),
  }},

  // B-ea92 M1: read-only authority policy discovery.
  // Alias: lattice authority enforce policy → authority_enforce_policy (resolved in runCli).
  { name: 'authority_enforce_policy', description: 'Discover authority policy (GET /v1/authority/policy). Read-only: no receipt, no gate pass, no evidence submission. Alias: lattice authority enforce policy', schema: {
    authorityURL: z.string().optional().describe('Authority server base URL (overrides KOALA_AUTHORITY_URL)'),
    authorityTimeoutMS: z.number().optional().describe('Request timeout in milliseconds (overrides KOALA_AUTHORITY_TIMEOUT_MS)'),
  }},

  // B-ad2c: dev-memory — lightweight non-authoritative experience capture
  { name: 'dev_memory_capture', description: '捕获一条非权威 dev-memory 经验条目到 file-backed JSONL 存储（不能满足 Koala gate evidence）', schema: {
    category: z.enum(['failure-mode','pattern','anti-pattern','workflow','tool-quirk','guard-bypass','debugging','communication','other']).describe('经验类别'),
    scope: z.enum(['project','global','story-candidate']).optional().describe('存储范围（默认 project）'),
    summary: z.string().describe('一句话摘要（≥10 字符）'),
    trigger: z.string().describe('触发场景（≥5 字符）'),
    lesson: z.string().describe('可复用的教训（≥10 字符）'),
    reusePrompt: z.string().describe('如何在下次会话中调出这条经验（≥5 字符）'),
    tags: z.union([z.array(z.string()), z.string()]).optional().describe('关键词标签（逗号分隔字符串或数组）'),
    sourceAgent: z.string().optional().describe('来源 agent（默认 koala-implementer）'),
    sourceStoryId: z.string().optional().describe('来源 story ID'),
    evidenceRefs: z.array(z.string()).optional().describe('证据引用（文件路径/commit sha）'),
  }},
  { name: 'dev_memory_list', description: '列出 dev-memory 经验条目', schema: {
    scope: z.enum(['project','global','story-candidate']).optional().describe('存储范围（默认 project）'),
    limit: z.number().optional().describe('最多返回条数（默认 50）'),
    json: z.boolean().optional().describe('JSON 格式输出'),
  }},
  { name: 'dev_memory_search', description: '按 query/category/agent/tags 搜索 dev-memory 经验条目', schema: {
    query: z.string().optional().describe('全文搜索关键词'),
    category: z.string().optional().describe('按类别过滤'),
    agent: z.string().optional().describe('按来源 agent 过滤'),
    tags: z.union([z.array(z.string()), z.string()]).optional().describe('按标签过滤（逗号分隔字符串或数组）'),
    limit: z.number().optional().describe('最多返回条数（默认 20）'),
    global: z.boolean().optional().describe('同时搜索 global 存储'),
    json: z.boolean().optional().describe('JSON 格式输出'),
  }},
  { name: 'dev_memory_preflight', description: '输出非权威 dev-memory 预飞上下文包（会话开始时调用）', schema: {
    query: z.string().optional().describe('相关性查询词'),
    maxEntries: z.number().optional().describe('最多包含条目数（默认 5）'),
    maxLines: z.number().optional().describe('行数预算（默认 60）'),
    json: z.boolean().optional().describe('JSON 格式输出'),
  }},
  { name: 'dev_memory_finish', description: '结束会话：active story 中默认写入 story 候选；无 story 时报告/晋升项目条目（不需 story 目录）', schema: {
    storyId: z.string().optional().describe('活动 story ID（如 B-xxx）；省略时 active story 分支会自动推断；Koala 外部会话可省略'),
    storyDir: z.string().optional().describe('story 目录根路径（默认 <root>/.koala/story/actives）'),
    query: z.string().optional().describe('可选：相关性过滤词'),
    scope: z.enum(['global']).optional().describe('无 storyId 时：global=将项目经验晋升到全局 dev-memory；即使在 active story 中也不写 story 候选'),
  }},
  { name: 'dev_memory_start', description: '会话启动包装器：输出 dev-memory 预飞上下文 + 结束时调 dev_memory_finish 的提醒（不启动外部 agent 二进制；不是生命周期 dev_start，不创建 worktree 或推进 phase）', schema: {
    agent: z.string().optional().describe('agent 名称（如 claude / codex；仅用于显示，不启动进程）'),
    query: z.string().optional().describe('预飞相关性查询词'),
    maxEntries: z.number().optional().describe('预飞最多条目数（默认 5）'),
    dryRun: z.boolean().optional().describe('兼容参数，始终为 dry-run 模式（不启动外部进程）'),
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
  const brand = detectLatticeBrand();
  const out = (line = '') => {
    if (options.stream) options.stream.write(`${line}\n`);
    else console.log(line);
  };
  const includeFooter = options.includeFooter !== false;

  out(`\n  ${brand.primaryBin} ${tool.name} — ${tool.description}\n`);
  out(`  ${formatLatticeProductLine(brand)}; legacy alias: ${brand.legacyAlias}\n`);

  // 如果有 longHelp（核心命令），先打印完整 PROMPT
  if (tool.longHelp) {
    out(tool.longHelp);
    out('');
  }

  const entries = Object.entries(tool.schema);
  if (entries.length === 0) {
    out('  无参数\n');
    out(`  用法: ${brand.primaryBin} ${tool.name}`);
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
  out(`\n  用法: ${brand.primaryBin} ${tool.name} ${[...reqParts, ...optParts].join(' ')}`);
  out(`  兼容: ${brand.legacyAlias} ${tool.name} ...`);
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
  const brand = detectLatticeBrand();
  console.log(`\n  ${formatLatticeProductLine(brand)} — CLI-first project workflow and host migration surface\n`);
  console.log(`  Primary entrypoint: ${brand.primaryBin}`);
  console.log(`  Legacy alias:       ${brand.legacyAlias}\n`);
  console.log(`  用法: ${brand.primaryBin} <command> --key=value         执行命令`);
  console.log(`        ${brand.primaryBin} <command> --help              查看参数`);
  console.log(`        ${brand.primaryBin} help                          显示此帮助`);
  console.log(`        ${brand.primaryBin} --version                     显示版本`);
  console.log(`        ${brand.primaryBin} --root <path> ...             指定项目根目录\n`);

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
    check: 'Check',
    host: 'Host',
    lattice: 'Lattice',
    rollout: 'Lattice',
    authority: 'Authority',
    conduit: 'Conduit',
  };
  // 已知分组的展示顺序；不在列表里的分组（来自 extras）按字母序追加
  const KNOWN_ORDER = ['Host', 'Lattice', 'Authority', 'Conduit', 'Story', 'Review', 'Checklist', 'Grill', 'Bug', 'Test', 'Validate', 'Evaluate', 'Workflow', 'Status', 'Check', 'Serve', 'Session', 'Aux', 'Audit'];

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
    1. lattice story_create '{"name":"x","title":"..","description":"..","type":"feature","priority":"high","checklist":[{"title":"做什么","context":"上下文"}]}'
    2. lattice story_advance --storyId=B-xxx --phase=INIT_CHECK # 创建 worktree
    3. cd .worktrees/B-xxx
    4. lattice story_review --storyId=B-xxx                     # 审查通过后进 DEV
    5. lattice story_advance --storyId=B-xxx --phase=DEV

    ── DEV ──
    6. 写代码 + 写验证（fixture / 项目原生测试 / validate.ts 可选）
    7. lattice validate                                         # 验证（按项目语言自动发现或读取配置）
    8. lattice checklist_update --storyId=B-xxx --itemId=CHK-001 --status=done

    ── REVIEW ──
    9. lattice story_advance --storyId=B-xxx --phase=REVIEW    # 进入代码审查
   10. koala-reviewer 审查代码，提 finding                     # critical/high 必须 resolve

    ── TEST → DONE ──
   11. lattice story_advance --storyId=B-xxx --phase=TEST
   12. lattice story_advance --storyId=B-xxx --phase=DONE

  初始化新项目:
    lattice init                          # 在当前目录初始化 Lattice/Koala project state

  提示: 简单参数用 --key=value，复杂参数(array/object)用 JSON 格式
  出错? 用 lattice <command> --help 查看完整参数说明
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

function normalizeFlagKey(key: string, schema: Record<string, ZodType>): string {
  if (schema[key]) return key;
  const camelKey = key.replace(/-([a-z0-9])/g, (_match, ch: string) => ch.toUpperCase());
  return schema[camelKey] ? camelKey : key;
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
        const key = normalizeFlagKey(arg.slice(2, eqIdx), schema);
        const val = arg.slice(eqIdx + 1);
        addValue(result, key, coerce(val, schema[key]), arrayKeys.has(key));
      } else {
        const key = normalizeFlagKey(arg.slice(2), schema);
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
      const key = normalizeFlagKey(arg.slice(0, eqIdx), schema);
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
  'capability_list',
  'capability_probe',
  'host_list',
  'host_probe',
  'host_status',
  'host_install',
  'lattice_config_doctor',
  'rollout_check',
  'authority_status',
  'conduit_status',
  'conduit_explain',
  'story_export',
  'handoff_create',
  'handoff_inspect',
  'handoff_accept',
  'handoff_resume',
  'handoff_receipt_submit',
  'handoff_worktree_create',
  'host_dispatch',
  'evidence_manifest',
  'evidence_inspect',
  'parallel_wave_create',
  'parallel_wave_inspect',
  'parallel_plan',
  'parallel_dispatch',
  'parallel_status',
  'parallel_merge_queue',
  'parallel_report',
  'grill_get',
  'reviewer_list',
  'workflow_explain',
  'help',
  'authority_enforce_policy',
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
 * B-c55d CHK-002: resolve the EFFECTIVE ownership class of a single command
 * invocation.
 *
 * The static `CommandPolicy.ownershipClass` is the base classification; this
 * function applies the four dynamic boundary rules from
 * session-ownership-and-write-leases.md (and the story plan) that depend on the
 * actual invocation arguments:
 *
 *  1. `finding_resolve` / `finding_dismiss` — `storyScopedMutating` for a normal
 *     story, but `mainSharedMutating` when the target is a B-META story (the
 *     B-f60c main write lock serializes those; `finding.ts` already routes the
 *     write through `withMetaFindingLock`). So a B-META finding mutation must
 *     NOT be owner-lease-gated.
 *  2. `validate` — `storyScopedMutating` only when `--story` is supplied (it
 *     then writes story TEST/DONE gate evidence). A diagnostic `validate` with
 *     no `--story` mutates no story state → downgraded to `readOnly`.
 *  3. `delivery_check_set` — `reviewerWrite` only when the resolved actor is
 *     `koala-review-delivery`; any other caller is treated as
 *     `storyScopedMutating` so a main agent cannot borrow it to bypass the
 *     owner lease.
 *  4. `dev_memory_finish --scope=global` with no explicit story target is
 *     `mainSharedMutating`: it promotes non-authoritative project memory to
 *     global memory and must not be owner-lease-gated by the active story.
 *
 * Returns `null` when the command has no policy entry OR its `ownershipClass`
 * is not a valid enum value — the gate treats `null` as FAIL-CLOSED (an
 * unclassified command is rejected, never default-allowed).
 */
export function resolveEffectiveOwnershipClass(
  cmd: string,
  args: Record<string, unknown>,
  storyId: string | null,
): OwnershipClass | null {
  const policy = getCommandPolicy(cmd);
  // Runtime enum re-validation (CLAUDE.md「Handler 编码约定」): a missing policy
  // OR a policy whose `ownershipClass` is not a valid enum value is fail-closed.
  if (!policy || !isOwnershipClass(policy.ownershipClass)) return null;
  let cls: OwnershipClass = policy.ownershipClass;

  // Boundary rule 1: a B-META finding mutation is mainSharedMutating.
  if ((cmd === 'finding_resolve' || cmd === 'finding_dismiss') && storyId && storyId.startsWith('B-META-')) {
    cls = 'mainSharedMutating';
  }

  // Boundary rule 2: a diagnostic `validate` without --story is readOnly.
  if (cmd === 'validate') {
    const hasStory =
      (typeof args.story === 'string' && args.story.trim().length > 0) ||
      (typeof args.storyId === 'string' && args.storyId.trim().length > 0);
    cls = hasStory ? 'storyScopedMutating' : 'readOnly';
  }

  // Boundary rule 3: delivery_check_set is reviewerWrite ONLY for the delivery
  // reviewer actor; any other caller is owner-gated as storyScopedMutating.
  if (cmd === 'delivery_check_set') {
    cls = isDeliveryReviewerActor(args) ? 'reviewerWrite' : 'storyScopedMutating';
  }

  // Boundary rule 4: global dev-memory promotion is a main shared metadata write.
  if (cmd === 'dev_memory_finish') {
    const hasExplicitStory =
      (typeof args.story === 'string' && args.story.trim().length > 0) ||
      (typeof args.storyId === 'string' && args.storyId.trim().length > 0);
    if (!hasExplicitStory && args.scope === 'global') {
      cls = 'mainSharedMutating';
    }
  }

  return cls;
}

/**
 * B-c55d CHK-002: whether a `delivery_check_set` invocation is acting AS the
 * delivery reviewer (`koala-review-delivery`).
 *
 * The actor is resolved from the explicit `agentId` argument first, then the
 * `KOALA_AGENT` environment variable — the same precedence the
 * `delivery_check_set` handler records into `delivery-check.json`. Only the
 * exact `koala-review-delivery` lane qualifies for the reviewerWrite exemption;
 * a main agent (or any other agent id) does NOT, so it cannot borrow
 * `delivery_check_set` to bypass the owner lease.
 *
 * NOTE: this only decides the owner-lease exemption. The delivery evidence's
 * own signature / phase rules are still enforced inside `delivery_check_set`
 * and by the TEST→DONE delivery-check gate — the exemption is never a free
 * pass to write.
 */
export function isDeliveryReviewerActor(args: Record<string, unknown>): boolean {
  const explicit = typeof args.agentId === 'string' ? args.agentId.trim() : '';
  const env = typeof process.env.KOALA_AGENT === 'string' ? process.env.KOALA_AGENT.trim() : '';
  const actor = explicit || env;
  return actor === 'koala-review-delivery';
}

/**
 * B-c55d CHK-003: the takeover intent of a single CLI invocation.
 *
 *  - `none`          → no takeover flag; a foreign lease stays rejected.
 *  - `takeover`      → `--takeover`; transfers a STALE foreign lease only.
 *  - `forceTakeover` → `--forceTakeover`; transfers an ACTIVE foreign lease too
 *    (deliberate human override). Implies `--takeover` semantics for a stale
 *    lease as well, so `--forceTakeover` always wins when both are present.
 */
export type TakeoverIntent = 'none' | 'takeover' | 'forceTakeover';

/**
 * Resolve the takeover intent from parsed CLI args.
 *
 * `parseFlags` records a bare `--takeover` / `--forceTakeover` as boolean
 * `true`; an `=value` form may also yield a string. Runtime re-validation (per
 * "Handler 编码约定"): the flag counts as set ONLY for a real boolean `true` or
 * the literal string `"true"` — any other value (a typo'd `--takeover=maybe`)
 * is treated as NOT set, so a malformed flag can never silently authorize a
 * dangerous lease transfer. `--forceTakeover` outranks `--takeover`.
 */
export function resolveTakeoverIntent(args: Record<string, unknown>): TakeoverIntent {
  const isSet = (v: unknown): boolean => v === true || v === 'true';
  if (isSet(args.forceTakeover)) return 'forceTakeover';
  if (isSet(args.takeover)) return 'takeover';
  return 'none';
}


/**
 * B-c55d CHK-002: the single CLI choke-point story owner lease GATE.
 *
 * Runs once in the `run()` wrapper for every command — ownership is NEVER
 * checked inside individual handlers. Behavior by effective ownership class
 * (see `resolveEffectiveOwnershipClass`):
 *
 *  - `readOnly` / `reviewerWrite` / `mainSharedMutating` → not owner-gated. The
 *    function returns without acquiring or rejecting. (`reviewerWrite` is
 *    exempt from the owner lease but still bound by its own reviewer-run /
 *    signature gates inside the handler; `mainSharedMutating` is serialized by
 *    the B-f60c main write lock.)
 *  - `storyScopedMutating` / `dangerousMutating` → owner-gated. With a
 *    resolvable story:
 *      · no lease on disk            → this session acquires it (becomes owner);
 *      · lease owned by this session → heartbeat is refreshed;
 *      · lease owned by ANOTHER session (`foreign`) → CHK-003: if the
 *        invocation carries an explicit takeover flag the lease may be
 *        transferred (`--takeover` for a STALE lease, `--forceTakeover` for an
 *        ACTIVE one) — the transfer rewrites the lease and records a
 *        `story-owner-lease-takeover` audit event, then the command proceeds.
 *        Without a flag (or a `--takeover` on a still-active lease) the command
 *        is REJECTED fail-closed with owner guidance.
 *  - unclassified (no policy / invalid `ownershipClass`) → REJECTED fail-closed.
 *    An unclassified command is never default-allowed.
 *
 * Throws an `Error` on rejection; the `run()` catch block surfaces it as the
 * command failure. A non-owner session performs NO write (the lease primitive
 * observes a foreign lease without stealing it).
 */
export function enforceStoryOwnerLeaseGate(
  cmd: string,
  args: Record<string, unknown>,
  store: StoryStore,
  activeStory: ActiveStory | null,
  projectRoot: string,
): void {
  const storyId = storyIdFromArgs(args, activeStory);
  const cls = resolveEffectiveOwnershipClass(cmd, args, storyId);

  // Fail-closed: an unclassified command (no policy entry, or a policy with an
  // invalid `ownershipClass`) is rejected, never default-allowed.
  if (cls === null) {
    throw new Error(
      `Command "${cmd}" has no valid ownershipClass in command-policy.ts and is rejected fail-closed. ` +
      `Every registered command must declare a CommandPolicy.ownershipClass (readOnly / storyScopedMutating / ` +
      `reviewerWrite / mainSharedMutating / dangerousMutating). Add a classified policy entry and rerun.`,
    );
  }

  // Not owner-gated: readOnly (no story state mutated), reviewerWrite (exempt —
  // bound by its own reviewer-run/signature gates), mainSharedMutating
  // (serialized by the B-f60c main write lock, not the owner lease).
  if (cls === 'readOnly' || cls === 'reviewerWrite' || cls === 'mainSharedMutating') {
    return;
  }

  // Owner-gated: storyScopedMutating / dangerousMutating.
  if (!storyId) return; // no story resolves → nothing to own (e.g. a draft).
  const storyDir = store.storyDirPath(storyId);
  if (!existsSync(storyDir)) return; // story dir absent → command will fail on its own.

  const { lease, action } = acquireOrRefreshOwnerLease(storyDir, {
    command: cmd,
    cwd: process.cwd(),
  });

  // `acquired` / `refreshed` → the current session owns the lease; proceed.
  if (action !== 'foreign') return;

  // `foreign` → another session owns this story.
  //
  // B-c55d CHK-003: before the fail-closed rejection, check for an explicit
  // takeover flag. A takeover is a `dangerousMutating` action — it requires
  // explicit operator intent (`--takeover` / `--forceTakeover`) and always
  // records an audit event. Without a flag, NOTHING is transferred and the
  // CHK-002 fail-closed rejection stands.
  const intent = resolveTakeoverIntent(args);
  if (intent !== 'none') {
    const result = takeOverOwnerLease(storyDir, {
      kind: intent,
      command: cmd,
      cwd: process.cwd(),
      projectRoot,
    });
    if (result.transferred) {
      // The lease now belongs to this session — the takeover event was logged.
      // Proceed: the owner-gated command runs as the new owner.
      return;
    }
    // `--takeover` on an ACTIVE (non-stale) lease → refuse, and tell the
    // operator the active lease needs the explicit `--forceTakeover` override.
    if (result.reason === 'lease-active') {
      const activeAgeMs = Date.now() - Date.parse(lease.heartbeatAt);
      const activeAge = Number.isFinite(activeAgeMs) ? formatLeaseAge(activeAgeMs) : 'unknown';
      throw new Error(
        `${storyId} is owned by another Koala session (${lease.sessionId}) whose owner lease is ` +
        `still ACTIVE (heartbeat ${activeAge} ago). --takeover only transfers a STALE lease ` +
        `(no heartbeat for 30+ minutes). To seize an active session's lock, rerun with ` +
        `--forceTakeover — a deliberate human override.`,
      );
    }
    // `no-lease` / `already-owned` are not expected here (a foreign lease was
    // just observed); fall through to the standard rejection for safety.
  }

  // No takeover flag (or a takeover that did not transfer): reject fail-closed
  // with owner guidance. The lease primitive performed NO write (no silent
  // steal). The full multi-field rejection message — story / owner sessionId /
  // owner cwd / heartbeat age / stale verdict / allowed next action — is built
  // by the single `formatNonOwnerError` pure formatter so the message can never
  // drift from the `session-ownership-and-write-leases.md` § Error UX contract.
  throw new Error(
    formatNonOwnerError(lease, {
      storyId,
      command: cmd,
      ownershipClass: cls,
      currentSessionId: getSessionId(),
    }),
  );
}

// ─── B-4f15 CHK-002: read-only reviewer command guard ───────────────────────

/** Environment variable name that activates read-only reviewer mode. */
export const REVIEWER_READONLY_ENV = 'KOALA_REVIEWER_READONLY';

/** Returns true when the process is running as a read-only reviewer. */
export function isReviewerReadOnlyModeEnabled(): boolean {
  return process.env[REVIEWER_READONLY_ENV] === '1';
}

/**
 * B-4f15 CHK-002: pre-hook, pre-lease gate for read-only reviewer mode.
 *
 * When KOALA_REVIEWER_READONLY=1, only commands whose EFFECTIVE ownershipClass
 * is `readOnly` are permitted. All other classes — `reviewerWrite`,
 * `storyScopedMutating`, `mainSharedMutating`, `dangerousMutating`, and
 * unclassified (null) — are rejected fail-closed.
 *
 * This gate must run BEFORE preCommand hooks and before enforceStoryOwnerLeaseGate
 * so a blocked command never triggers hooks or acquires/mutates lease state.
 *
 * Throws an Error on rejection; callers surface it as a command failure.
 */
export function enforceReviewerReadOnlyCommandGate(
  cmd: string,
  args: Record<string, unknown>,
  activeStory: ActiveStory | null,
): void {
  if (!isReviewerReadOnlyModeEnabled()) return;

  const storyId = storyIdFromArgs(args, activeStory);
  const cls = resolveEffectiveOwnershipClass(cmd, args, storyId);

  if (cls === 'readOnly') return;

  const clsLabel = cls === null ? 'unclassified' : cls;
  throw new Error(
    `[${REVIEWER_READONLY_ENV}=1] Command "${cmd}" is not allowed in read-only reviewer mode ` +
    `(effective ownershipClass: ${clsLabel}). ` +
    `Advisory read-only reviewers may only run read-only Koala commands and should return ` +
    `structured findings to the story owner. ` +
    `To run write commands, unset ${REVIEWER_READONLY_ENV} and ensure you are the story owner.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

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

function gitCli(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    const details = String(e?.stderr || e?.stdout || e?.message || e).trim();
    throw new Error(`git ${args.join(' ')} failed${details ? `: ${details}` : ''}`);
  }
}

function toGitRelPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function boundedMetadataPath(baseRel: string, child: string, label: string): string {
  const childPath = toGitRelPath(child);
  if (!childPath || isAbsolute(childPath) || childPath.split('/').includes('..')) {
    throw new Error(`from-draft metadata path for ${label} is not bounded: ${child}`);
  }
  return `${toGitRelPath(baseRel)}/${childPath}`;
}

function isPathUnderAny(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function stageBoundedMetadataPath(root: string, relPath: string): void {
  if (existsSync(join(root, relPath))) {
    gitCli(root, ['add', '-A', '--', relPath]);
    return;
  }

  const deleted = gitCli(root, ['ls-files', '--deleted', '--', relPath])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (deleted.length > 0) {
    gitCli(root, ['add', '-A', '--', ...deleted]);
  }
}

function preflightFromDraftMetadataBootstrap(root: string): void {
  const currentBranch = gitCli(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (currentBranch !== 'main') {
    throw new Error(`story_create --fromDraft must finalize metadata on main, but current branch is ${currentBranch}`);
  }

  const stagedBefore = gitCli(root, ['diff', '--cached', '--name-only']);
  if (stagedBefore) {
    throw new Error(
      `story_create --fromDraft requires a clean git index before mutating story/draft/worktree metadata:\n${stagedBefore}`,
    );
  }
}

function commitFromDraftMetadataAndMergeMain(root: string, store: StoryStore, storyId: string, draftName: string): string {
  preflightFromDraftMetadataBootstrap(root);

  const storyRel = boundedMetadataPath(store.storyDirRel(), storyId, 'active story');
  const draftRel = boundedMetadataPath('docs/story/drafts', draftName, 'source draft');
  const boundedPaths = [storyRel, draftRel];

  for (const path of boundedPaths) {
    stageBoundedMetadataPath(root, path);
  }
  const staged = gitCli(root, ['diff', '--cached', '--name-only']);
  const stagedPaths = staged.split('\n').map((line) => line.trim()).filter(Boolean);
  if (stagedPaths.length === 0) {
    throw new Error(`from-draft metadata commit found no changes under ${boundedPaths.join(', ')}`);
  }
  const outOfBounds = stagedPaths.filter((path) => !isPathUnderAny(path, boundedPaths));
  if (outOfBounds.length > 0) {
    throw new Error(
      `from-draft metadata commit refused out-of-bounds staged paths:\n${outOfBounds.join('\n')}`,
    );
  }

  const commitMessage = `koala: from-draft metadata ${storyId}`;
  gitCli(root, [
    '-c', 'commit.gpgsign=false',
    'commit',
    '-m', commitMessage,
  ]);
  const mainHead = gitCli(root, ['rev-parse', '--short', 'HEAD']);
  const boundedStatus = gitCli(root, ['status', '--porcelain', '--', ...boundedPaths]);
  if (boundedStatus) {
    throw new Error(
      `from-draft metadata committed, but bounded metadata paths are still dirty ` +
      `(${boundedPaths.join(', ')}):\n${boundedStatus}`,
    );
  }

  const story = store.readStory(storyId);
  const worktreePath = story.worktree?.path;
  const storyBranch = story.worktree?.branch || `story/${storyId}`;
  if (!worktreePath) {
    throw new Error(`from-draft story ${storyId} has no recorded worktree path after dev_start`);
  }
  const repoRoot = gitCli(root, ['rev-parse', '--show-toplevel']);
  const worktreeAbs = isAbsolute(worktreePath) ? worktreePath : join(repoRoot, worktreePath);
  gitCli(worktreeAbs, [
    '-c', 'commit.gpgsign=false',
    'merge',
    'main',
    '--no-edit',
  ]);
  gitCli(worktreeAbs, ['merge-base', '--is-ancestor', 'main', storyBranch]);

  return [
    `✓ from-draft metadata committed on main: ${mainHead} (${commitMessage})`,
    `✓ main merged into ${storyBranch}`,
  ].join('\n');
}

/**
 * B-f60c CHK-002 — close F-008 partial-DONE at the INIT_CHECK write side.
 *
 * Root cause (verified, B-6974 / B-ad12 real-machine repros): `story_advance
 * INIT_CHECK` runs `story_advance` (writes phase) then `dev_start` (writes
 * `story.worktree` into the MAIN repo's `.koala/story/actives/<id>/index.json`).
 * `dev_start.createScopedStoryBootstrapCommit` commits the story dir onto the
 * `story/<id>` branch via a TEMPORARY git index — it never touches the main
 * repo's working tree or index. So the main checkout is left with an
 * UNCOMMITTED story-metadata mirror (the story dir is untracked, since
 * `story_create` only wrote files without committing them).
 *
 * At DONE, `applyDoneMergeEffects` Step 3 runs `git merge story/<id>` from the
 * main repo root. The story branch carries a committed
 * `.koala/story/actives/<id>/index.json`; the main working tree has the SAME
 * path untracked → git aborts the merge ("untracked working tree files would
 * be overwritten by merge") → partial-DONE (story marked DONE, branch never
 * merged).
 *
 * Fix: commit that mirror on the current (main) branch right after `dev_start`,
 * exactly mirroring what `commitFromDraftMetadataAndMergeMain` already does for
 * the from-draft path, then merge the base branch into the story worktree so
 * the story branch still contains all of main. After this the DONE merge has
 * nothing uncommitted to collide with. Just serializing the DONE critical
 * section (CHK-001's lock) cannot close F-008 — the stale mirror must be
 * removed from the main working tree at its INIT_CHECK source.
 *
 * Idempotent: a retry where the story dir is already committed stages nothing
 * and returns '' (no-op) instead of throwing.
 */
function commitInitCheckMetadataAndMergeMain(root: string, store: StoryStore, storyId: string): string {
  const currentBranch = gitCli(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (currentBranch.startsWith('story/')) {
    // INIT_CHECK is the standard worktree-creation entry and must run from the
    // main checkout. If we are already on a story branch, dev_start would not
    // have created a main-side mirror to reconcile — leave it untouched.
    return '';
  }

  const storyRel = boundedMetadataPath(store.storyDirRel(), storyId, 'active story');
  stageBoundedMetadataPath(root, storyRel);
  const staged = gitCli(root, ['diff', '--cached', '--name-only']);
  const stagedPaths = staged.split('\n').map((line) => line.trim()).filter(Boolean);
  if (stagedPaths.length === 0) {
    // Story metadata already committed (retry / already-tracked) — nothing to
    // reconcile, the DONE merge will not collide.
    return '';
  }
  const outOfBounds = stagedPaths.filter((path) => !isPathUnderAny(path, [storyRel]));
  if (outOfBounds.length > 0) {
    throw new Error(
      `INIT_CHECK metadata commit refused out-of-bounds staged paths:\n${outOfBounds.join('\n')}`,
    );
  }

  const commitMessage = `koala: INIT_CHECK metadata ${storyId}`;
  gitCli(root, [
    '-c', 'commit.gpgsign=false',
    'commit',
    '-m', commitMessage,
  ]);
  const mainHead = gitCli(root, ['rev-parse', '--short', 'HEAD']);
  const boundedStatus = gitCli(root, ['status', '--porcelain', '--', storyRel]);
  if (boundedStatus) {
    throw new Error(
      `INIT_CHECK metadata committed, but bounded story path is still dirty (${storyRel}):\n${boundedStatus}`,
    );
  }

  const story = store.readStory(storyId);
  const worktreePath = story.worktree?.path;
  const storyBranch = story.worktree?.branch || `story/${storyId}`;
  if (!worktreePath) {
    throw new Error(`INIT_CHECK story ${storyId} has no recorded worktree path after dev_start`);
  }
  const repoRoot = gitCli(root, ['rev-parse', '--show-toplevel']);
  const worktreeAbs = isAbsolute(worktreePath) ? worktreePath : join(repoRoot, worktreePath);
  gitCli(worktreeAbs, [
    '-c', 'commit.gpgsign=false',
    'merge',
    currentBranch,
    '--no-edit',
  ]);
  gitCli(worktreeAbs, ['merge-base', '--is-ancestor', currentBranch, storyBranch]);

  return [
    `✓ INIT_CHECK metadata committed on ${currentBranch}: ${mainHead} (${commitMessage})`,
    `✓ ${currentBranch} merged into ${storyBranch}`,
  ].join('\n');
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

  let cmd = argv[0];
  let arg = argv[1];

  // Detect active story from git branch
  const root0 = resolveRootForCommand(cmd, rootOverride);
  const activeStory = detectActiveStory(root0);
  const gitReady = isGitRepository(root0);

  if (!cmd || cmd === 'help' || cmd === '--help') { printHelp(activeStory); return; }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${formatLatticeVersionLine()}\n`);
    return;
  }

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

  // Normalize nested space aliases into the flat underscore commands used by
  // the registry. Supports both primary invocations (`lattice host list`) and
  // legacy-prefixed invocations (`koala lattice host list`).
  const aliasStart = cmd === 'lattice' ? 1 : 0;
  const nested = argv.slice(aliasStart, aliasStart + 3).join(' ');
  const aliasMap: Record<string, string> = {
  'host list': 'host_list',
  'host probe': 'host_probe',
  'host status': 'host_status',
  'host install': 'host_install',
  'host dispatch': 'host_dispatch',
  'config doctor': 'lattice_config_doctor',
    'rollout check': 'rollout_check',
    'authority status': 'authority_status',
    'authority enforce policy': 'authority_enforce_policy',
    'conduit status': 'conduit_status',
    'conduit explain': 'conduit_explain',
  };
  const twoPart = argv.slice(aliasStart, aliasStart + 2).join(' ');
  const threePart = argv.slice(aliasStart, aliasStart + 3).join(' ');
  const canonicalAlias = aliasMap[threePart] || aliasMap[twoPart] || aliasMap[nested];
  if (canonicalAlias) {
    const consumed = aliasMap[threePart] ? 3 : 2;
    argv.splice(0, aliasStart + consumed, canonicalAlias);
    cmd = canonicalAlias;
    arg = argv[1];
  } else if (cmd === 'lattice' && (argv[1] === 'version' || argv[1] === '--version' || argv[1] === '-v')) {
    process.stdout.write(`${formatLatticeVersionLine()}\n`);
    return;
  }

  const tool = TOOLS.find(t => t.name === cmd);
  if (!tool) {
    console.error(`未知命令: ${cmd}`);
    const m = TOOLS.filter(t => t.name.includes(cmd) || cmd.includes(t.name.split('_')[0]));
    if (m.length) { console.error('你是不是要找:'); for (const t of m) console.error(`  lattice ${t.name}`); }
    console.error('用 lattice help 查看所有命令（legacy alias: koala）');
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

  if (cmd === 'dev_memory_finish' && activeStory) {
    const hasExplicitStory =
      (typeof parsed.story === 'string' && parsed.story.trim().length > 0) ||
      (typeof parsed.storyId === 'string' && parsed.storyId.trim().length > 0);
    if (!hasExplicitStory && parsed.scope !== 'global') {
      parsed = { ...parsed, storyId: activeStory.storyId };
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
  // Durable main-root fallback for post-command activity logging.
  // story_advance --phase=DONE removes the current story worktree mid-command.
  // Once removed, root/.git is gone, so resolveMainRootFromWorktreeRoot() can no
  // longer recover the main project root, and resolveRoot()'s cwd-walk may land
  // on (and appendActivityLog may recreate) the now-deleted ghost worktree dir.
  // Capture the main root NOW, while root/.git still exists, so writeLog can fall
  // back to a durable path that survives the deletion.
  const mainRootFallback = resolveMainRootFromWorktreeRoot(root);
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
      // Detect this by checking if `root` still has koala.config.json. If not
      // (the worktree was removed), prefer the durable main-root fallback
      // captured at command start — it was computed while root/.git still
      // existed, so it points at the real main project even after the worktree
      // is gone. Do NOT fall back to resolveRoot() first: its cwd-walk may
      // resolve to (and appendActivityLog would then recreate) the now-deleted
      // ghost worktree dir. Only use resolveRoot() if the durable fallback is
      // unavailable/stale, and skip logging entirely if neither has
      // koala.config.json rather than pollute the filesystem.
      let effectiveRoot = root;
      if (!existsSync(join(effectiveRoot, 'koala.config.json'))) {
        if (mainRootFallback && existsSync(join(mainRootFallback, 'koala.config.json'))) {
          effectiveRoot = mainRootFallback;
        } else {
          effectiveRoot = resolveRoot();
          if (!existsSync(join(effectiveRoot, 'koala.config.json'))) {
            return;
          }
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
  // transition-orchestrator can call it the same way for onPhaseChange.
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
    // B-4f15 CHK-002: read-only reviewer gate runs first — before hooks and
    // before the owner lease gate, so a blocked command cannot trigger hooks
    // or acquire/mutate lease state.
    try {
      enforceReviewerReadOnlyCommandGate(cmd, parsed, activeStory);
    } catch (e: any) {
      clearInterval(watchdog);
      log(`${cmd} failed: ${e.message}`);
      process.stderr.write(`错误: ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
    // preCommand hook — non-blocking failure, awaited so it always runs before the handler
    if (config0?.hooks?.preCommand && !READ_ONLY_COMMANDS.has(cmd)) {
      process.stderr.write(`[koala-hook] running preCommand hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
    }
    if (!READ_ONLY_COMMANDS.has(cmd)) {
      await runHooks('preCommand', cmd, buildHookEnvLocal('preCommand'), config0, root);
    }
    try {
      // B-c55d CHK-002: story owner lease GATE. This `run()` wrapper is the
      // single CLI choke-point every command flows through, so ownership is
      // decided here — NOT scattered across handlers. By effective
      // ownershipClass: readOnly / reviewerWrite / mainSharedMutating are never
      // owner-gated; an owner-gated storyScopedMutating / dangerousMutating
      // command for a story owned by THIS session acquires-or-refreshes the
      // lease, while a command targeting a story owned by ANOTHER session is
      // rejected fail-closed with owner guidance; an unclassified command is
      // also rejected fail-closed. The gate runs inside this `try` so a
      // rejection surfaces through the `catch` below as the command failure.
      enforceStoryOwnerLeaseGate(cmd, parsed, store, activeStory, root);
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
      const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      process.stdout.write(`${output}\n`);
      process.exitCode = 0;
      return;
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
      process.stderr.write(`错误: ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
  }

  // story_create: 停在 INIT 时追加下一步提示
  if (cmd === 'story_create') {
    await run(() => {
      const fromDraftName = typeof (v.data as any).fromDraft === 'string' ? (v.data as any).fromDraft : '';
      if (fromDraftName && gitReady) {
        preflightFromDraftMetadataBootstrap(root);
      }
      const result = handlers.story_create(v.data);
      if (result.includes('created from draft') && result.includes('(phase=INIT_CHECK)')) {
        const storyId = result.match(/Story\s+([\w-]+)/)?.[1];
        if (!storyId) return result;
        if (!gitReady) {
          return `${result}\n⚠ 当前目录不是 git 仓库：story 已记录，但 from-draft worktree 不能自动创建。\n→ 先 git init + 首次 commit 后重试 lattice story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}'`;
        }
        try {
          const wtResult = handlers.dev_start({ storyId });
          const syncResult = commitFromDraftMetadataAndMergeMain(root, store, storyId, fromDraftName);
          return `${result}\n\n${wtResult}\n\n${syncResult}\n\n→ 现在请 cd 到上述 worktree 路径，然后调 lattice story_advance phase=PLAN 进入 PLAN`;
        } catch (e: any) {
          throw new Error(
            `from-draft worktree bootstrap failed for ${storyId}: ${e.message}\n` +
            `→ 排查后再次执行 lattice story_advance --phase=INIT_CHECK 自动重试，或手动 lattice dev_start '{"storyId":"${storyId}"}'`,
          );
        }
      }
      if (!result.includes('(INIT)')) return result;
      const storyId = result.match(/Story\s+([\w-]+)/)?.[1];
      if (!storyId) return result;
      if (result.includes('当前目录不是 git 仓库')) return result;
      if (!gitReady) {
        return `${result}\n⚠ 当前目录不是 git 仓库：story 已记录，但 INIT_CHECK/worktree 流程还不能顺畅跑。\n→ 先在项目根执行 git init && git add . && git commit -m \"init\"，再 lattice story_advance '{\"storyId\":\"${storyId}\",\"phase\":\"INIT_CHECK\"}'`;
      }
      return `${result}\n→ Story 停在 INIT 阶段。下一步:\n  1. lattice story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}' 创建 worktree\n  2. cd 到提示的 worktree 路径\n  3. lattice story_advance '{"storyId":"${storyId}","phase":"PLAN"}' 进入 PLAN（cwd 必须是 worktree）`;
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
        // B-f60c CHK-002: close F-008. dev_start leaves an uncommitted
        // story-metadata mirror in the main checkout that blocks the DONE
        // `git merge story/<id>`. Commit it on the base branch (mirroring the
        // from-draft path) so DONE has nothing uncommitted to collide with.
        let syncResult = '';
        if (gitReady) {
          syncResult = commitInitCheckMetadataAndMergeMain(root, store, storyId);
        }
        const syncSegment = syncResult ? `\n\n${syncResult}` : '';
        return `${advanceResult}\n\n${wtResult}${syncSegment}\n\n→ 现在请 cd 到上述 worktree 路径，然后调 lattice story_advance phase=PLAN 进入 PLAN`;
      } catch (e: any) {
        return `${advanceResult}\n⚠ worktree 创建失败: ${e.message}\n→ 排查后再次执行 lattice story_advance --phase=INIT_CHECK 自动重试，或手动 lattice dev_start '{"storyId":"${storyId}"}'`;
      }
    });
    return;
  }

  // B-a2f1 CHK-003: recover_evidence — handler always returns a structured result;
  // CLI wrapper prints the result to stdout, then throws on non-pass so runCli's
  // catch branch sets process.exitCode=1. The same pattern as the validate gate
  // dispatcher (verifier.ts:482) — keeps the handler pure for in-process tests.
  if (cmd === 'recover_evidence') {
    const handler = handlers[cmd];
    if (!handler) { console.error(`handler not found: ${cmd}`); process.exit(1); }
    await run(async () => {
      const r = await handler(v.data);
      if (r && typeof r === 'object' && (r.status === 'refused' || r.status === 'fail')) {
        // Print structured result first so the user sees the refused/fail diagnosis,
        // then throw a one-line error message that runCli renders on stderr.
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        const msg = r.status === 'refused'
          ? (r.refused?.reason || 'recover_evidence refused')
          : 'recover_evidence: validate failed after refresh; inspect validateTranscript for details';
        throw new Error(msg);
      }
      return r;
    });
    return;
  }

  const handler = handlers[cmd];
  if (!handler) { console.error(`handler not found: ${cmd}`); process.exit(1); }

  await run(() => Object.keys(tool.schema).length === 0 ? handler() : handler(v.data));
}
