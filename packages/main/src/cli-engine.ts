/**
 * koala CLI 引擎
 *
 * 把 dispatch / parse / log / phase gate 这些通用逻辑包成可调用的 runCli 函数。
 * main 自己的 cli.ts 是 bin 入口，直接调 runCli()；
 * 第三方 bootstrap 脚本可以在 runCli({extraTools, extraRegister}) 时把 utils
 * 的工具和 handler 一起合进来。
 */

import { z, ZodType, ZodOptional, ZodEnum, ZodArray, ZodUnion, ZodString, ZodBoolean, ZodNumber, ZodObject } from 'zod';
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { StoryStore } from './core/store.js';
import { createMainRegistry, type Registry } from './registry.js';
import type { HandlerContext } from './handlers/context.js';
import { execSync } from 'child_process';
import { loadConfig, isCommandAllowed, getAllowedPatterns } from './core/config.js';
import { decorateResult, type ActiveStoryInfo } from './handlers/hints.js';
import { reportHealthIssue } from './core/health.js';
import { detectStaleState } from './core/stale-detector.js';
import { runHooks, truncateForEnv, buildHookEnv as buildSharedHookEnv, HOOK_TIMEOUT_MS } from './core/hooks.js';
import { inferActivityRole } from './core/activity-role.js';
import {
  STORY_CREATE_LONG, STORY_ADVANCE_LONG, CHECKLIST_UPDATE_LONG, FIXTURE_BATCH_ADD_LONG,
  SESSION_BRIEF_FOOTER,
} from './cli-prompts.js';

// ── Tool Registry ──

export interface ToolDef {
  name: string;
  /** 一行描述（出现在 koala help 列表里） */
  description: string;
  /** 完整 PROMPT（出现在 koala <cmd> --help 里）。可选；缺省时只显示 description */
  longHelp?: string;
  guardrails?: {
    supportsDryRun?: boolean;
    requiresConfirm?: boolean;
  };
  schema: Record<string, ZodType>;
}

/** main 自带的 CLI 工具定义 */
export const MAIN_TOOLS: ToolDef[] = [
  // Story
  { name: 'story_create', description: '创建 Story 条目', longHelp: STORY_CREATE_LONG, schema: {
    name: z.string().describe('短名称'), title: z.string().describe('标题'),
    description: z.string().describe('描述'), type: z.enum(['feature','bug','refactor','chore']).describe('类型'),
    priority: z.string().describe('优先级'), source: z.string().optional().describe('来源'),
    depends: z.array(z.string()).optional().describe('依赖 Story ID'),
    lane: z.enum(['mainline','supporting','exploratory']).optional().describe('并行调度角色：主线/支持线/探索线'),
    parallelSafe: z.enum(['yes','no','plan_only']).optional().describe('并行安全级别：可并行/禁止并行/仅允许并行做 PLAN'),
    sharedHotspots: z.array(z.string()).optional().describe('共享热点文件或模块（用于并行冲突提示）'),
    blockingFor: z.array(z.string()).optional().describe('会阻塞的其他 Story ID（供 session_brief 显示等待关系）'),
    keywords: z.array(z.string()).optional().describe('关键词（领域/模块/概念，用于查重）'),
    checklist: z.array(z.object({ title: z.string(), context: z.string().optional(), relatedDocs: z.array(z.string()).optional().describe('关联文档路径（用于三次提醒）'), phase: z.enum(['DEV','TEST_CASE']).optional().describe('B-5010: item 所属阶段（默认 DEV）'), testIntent: z.object({ happy: z.array(z.union([z.string(), z.object({ desc: z.string(), type: z.enum(['cli_blackbox','browser_blackbox']) })])), edge: z.array(z.union([z.string(), z.object({ desc: z.string(), type: z.enum(['cli_blackbox','browser_blackbox']) })])).optional(), adversarial: z.array(z.union([z.string(), z.object({ desc: z.string(), type: z.enum(['cli_blackbox','browser_blackbox']) })])).optional() }).optional() })).optional().describe('开发清单'),
    prefix: z.string().optional().describe('ID 前缀(默认 B)'),
    phase: z.enum(['IDEA','INIT','INIT_CHECK','PLAN','DEV','TEST_CASE','TEST_CASE_REVIEW','TEST','DONE']).optional().describe('直接指定阶段'),
    forceNew: z.boolean().optional().describe('B-0af4: 绕过同名 story idempotency 强制新建（同名未完成 story 默认会被复用）'),
  }},
  { name: 'story_advance', description: '推进 Story 到下一阶段', longHelp: STORY_ADVANCE_LONG, schema: {
    storyId: z.string().describe('Story ID'), phase: z.enum(['IDEA','INIT','INIT_CHECK','PLAN','DEV','TEST_CASE','TEST_CASE_REVIEW','TEST','DONE']).describe('目标阶段'),
    checklist: z.array(z.object({ id: z.string(), title: z.string() })).optional().describe('开发清单'),
    dryRun: z.boolean().optional().describe('仅预览 DONE 路径的自动 git 变更计划，不实际推进阶段'),
    confirm: z.boolean().optional().describe('显式确认执行 DONE 路径里会自动触发的 git commit/merge 收尾'),
  }},
  { name: 'story_update', description: '编辑 Story 信息', schema: {
    storyId: z.string().describe('Story ID'), title: z.string().optional().describe('新标题'),
    description: z.string().optional().describe('新描述'), priority: z.string().optional().describe('新优先级'),
    source: z.string().optional().describe('新来源'),
    depends: z.array(z.string()).optional().describe('依赖 Story ID'),
    lane: z.enum(['mainline','supporting','exploratory']).optional().describe('并行调度角色'),
    parallelSafe: z.enum(['yes','no','plan_only']).optional().describe('并行安全级别'),
    sharedHotspots: z.array(z.string()).optional().describe('共享热点文件或模块'),
    blockingFor: z.array(z.string()).optional().describe('会阻塞的其他 Story ID'),
  }},
  { name: 'story_get', description: '读取 Story 详情', schema: { storyId: z.string().describe('Story ID'), detail: z.boolean().optional().describe('附带 index.json 全字段（phase/priority/name/description/...）到 result.index') }},
  { name: 'story_list', description: '列出全部 Story', schema: {
    phase: z.enum(['IDEA','INIT','INIT_CHECK','PLAN','DEV','TEST_CASE','TEST_CASE_REVIEW','TEST','DONE','DISCARDED']).optional().describe('按阶段过滤（与 active 互斥）'),
    active: z.boolean().optional().describe('仅列出非终态 story（排除 DONE/DISCARDED/IDEA）。B-89c7 CHK-016 新增'),
  }},
  { name: 'story_discard', description: '废弃 Story：清理 worktree/分支并标记为 DISCARDED', schema: {
    storyId: z.string().describe('Story ID'),
    reason: z.string().optional().describe('废弃原因（写入事件记录）'),
    force: z.boolean().optional().describe('强制丢弃未提交改动'),
    dryRun: z.boolean().optional().describe('仅预览将执行的操作，不实际修改 story/worktree/git'),
    confirm: z.boolean().optional().describe('显式确认执行危险操作'),
  }, guardrails: { supportsDryRun: true, requiresConfirm: true }},
  { name: 'story_reconcile', description: '检测并修复僵尸 story（分支已合并/删除但 phase 非终态）', schema: {
    dryRun: z.boolean().optional().describe('默认 true 只报告不修改，false 执行修复'),
  }},

  // Review
  { name: 'story_review', description: '对抗审查 testIntent 完整性', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  { name: 'story_review_dismiss', description: '驳回一个被误报的 riskSignal 分类（B-5010）', schema: {
    storyId: z.string().describe('Story ID'),
    category: z.string().describe('要驳回的 riskSignal.category（如 "状态机/门禁"、"test runner 框架"）'),
    reason: z.string().describe('驳回理由（≥ 5 字符，写清楚为什么该 signal 在本 story 是误报）'),
  }},

  // Checklist
  { name: 'checklist_get', description: '读取 checklist', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'checklist_add', description: '向已有 story 追加 checklist item', schema: {
    storyId: z.string().describe('Story ID'), title: z.string().describe('做什么（一句话）'),
    context: z.string().optional().describe('根因/参考方案'),
    relatedDocs: z.array(z.string()).optional().describe('关联文档路径（用于三次提醒）'),
    phase: z.enum(['DEV','TEST_CASE']).optional().describe('B-5010: item 所属阶段（默认 DEV）；TEST_CASE 表示 fixture/perf 类，不纳入 DEV→TEST_CASE 门禁'),
  }},
  { name: 'checklist_update', description: '更新 checklist 项 (status/title/context/testIntent/relatedDocs/phase)', longHelp: CHECKLIST_UPDATE_LONG, schema: {
    storyId: z.string().describe('Story ID'), itemId: z.string().describe('项 ID'),
    status: z.enum(['pending','in_progress','done']).optional().describe('新状态'),
    title: z.string().optional().describe('新标题'),
    context: z.string().optional().describe('新 context'),
    relatedDocs: z.array(z.string()).optional().describe('关联文档路径（用于三次提醒）'),
    phase: z.enum(['DEV','TEST_CASE']).optional().describe('B-5010: item 所属阶段'),
    testIntent: z.union([z.object({ happy: z.array(z.union([z.string(), z.object({ desc: z.string(), type: z.enum(['cli_blackbox','browser_blackbox']) })])).optional(), edge: z.array(z.union([z.string(), z.object({ desc: z.string(), type: z.enum(['cli_blackbox','browser_blackbox']) })])).optional(), adversarial: z.array(z.union([z.string(), z.object({ desc: z.string(), type: z.enum(['cli_blackbox','browser_blackbox']) })])).optional() }), z.null()]).optional().describe('测试意图三栏（happy 必填，edge/adversarial 选填；null=不可自动化测试）'),
    reason: z.string().optional().describe('变更原因'), agent: z.string().optional().describe('操作者'),
  }},

  // TestIntent Results
  { name: 'testintent_record', description: '追加 testIntent 审核结果', schema: {
    storyId: z.string().describe('Story ID'), itemId: z.string().describe('Checklist 项 ID'),
    lane: z.enum(['happy','edge','adversarial']).describe('栏位'),
    index: z.number().describe('条目索引（从 0 开始）'),
    pass: z.boolean().optional().describe('是否通过（不传=纯回复）'),
    note: z.string().describe('说明（格式：file:line + WHY + severity）'),
    agent: z.string().optional().describe('调用者标识（自动推断 role）'),
  }},

  { name: 'testintent_check', description: '检查 testIntent 审核通过状态', schema: {
    storyId: z.string().describe('Story ID'),
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
  { name: 'summary_set', description: 'DONE 前必须落：story 完成总结（changes/usage/limitations/pitfalls + 自动扫真机覆盖骨架）', schema: {
    storyId: z.string().describe('Story ID'),
    changes: z.string().describe('改了什么（每个文件关键改动，用户视角，≥ 10 字符）'),
    usage: z.string().describe('怎么用（slash / tool / 调用示例，≥ 10 字符）'),
    limitations: z.string().describe('已知限制 / 设计偏离（没有就写 "none — fully covered"）'),
    pitfalls: z.string().describe('踩坑记录（卡在哪、绕了几次路、下个人应该知道什么，≥ 10 字符；禁止空话）'),
    skipReasons: z.record(z.string(), z.string()).optional().describe('{case name: reason} 对每条 sandbox:false 但没跑的 case 说明原因；未提供则 koala 报错列出缺失项'),
  }},
  { name: 'summary_get', description: '读取 story summary', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  { name: 'implementation_review_result_set', description: '写入 implementation-reviewer 的结构化结果（第一版 advisory）', schema: {
    storyId: z.string().describe('Story ID'),
    verdict: z.enum(['pass','fail']).describe('实现 review 总结'),
    findings: z.array(z.object({
      file: z.string(),
      line: z.number(),
      why: z.string(),
      severity: z.enum(['info','medium','high']),
    })).describe('实现 review findings'),
    summary: z.string().describe('一段简短总结'),
  }},
  { name: 'implementation_review_result_get', description: '读取 implementation review 结果', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  { name: 'testintent_resume', description: '人类介入：重置某条 testIntent 的 5 轮 cap，开新段', schema: {
    storyId: z.string().describe('Story ID'),
    itemId: z.string().describe('Checklist 项 ID'),
    lane: z.enum(['happy','edge','adversarial']).describe('栏位'),
    index: z.number().describe('条目索引'),
    reason: z.string().describe('人类裁决理由（≥ 5 字符）'),
    human: z.boolean().describe('必须传 true，确认是人类执行而非主 agent 自动调用'),
  }},

  // Bug
  { name: 'bug_report', description: '报告 bug', schema: {
    storyId: z.string().describe('Story ID'), id: z.string().describe('Bug ID'),
    title: z.string().describe('描述'), checklistId: z.string().optional().describe('关联 checklist ID'),
    fixtureId: z.string().optional().describe('关联 fixture case uuid'),
  }},
  { name: 'bug_update', description: '更新 bug 状态', schema: {
    storyId: z.string().describe('Story ID'), id: z.string().describe('Bug ID'),
    status: z.enum(['open','fixed']).describe('新状态'),
  }},
  { name: 'bug_list', description: '查看 bug 列表', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'bug_analyze', description: '跨 story bug 质量仪表盘（markdown/json）', schema: {
    format: z.enum(['json','markdown']).optional().describe('输出格式（默认 json）'),
  }},

  // Truth
  { name: 'truth_scan', description: '扫描真相源目录，提取需求点/决策/约束/问题（summary=true 只返回统计）', schema: {
    summary: z.boolean().optional().describe('仅返回统计摘要，不展开全部 entries'),
  }},
  { name: 'truth_nav', description: '生成/更新真相源 NAV.md 导航索引', schema: {}},
  { name: 'truth_analyze', description: '分析真相源中的矛盾/模糊/缺失', schema: {}},
  { name: 'truth_to_story', description: '从需求自动拆解成 Story 建议', schema: {}},
  { name: 'truth_extract', description: '从代码+Story 反向提取真相源', schema: {}},

  // Gap / Convergence
  { name: 'gap_analyze', description: '对比真相源 vs 代码现实，输出差距报告', schema: {}},
  { name: 'convergence_check', description: '判断项目是否收敛（需求覆盖、测试通过、无差距）', schema: {}},

  // Test
  { name: 'test_add', description: '记录测试证据', schema: {
    storyId: z.string().describe('Story ID'), id: z.string().describe('TE ID'),
    scenario: z.string().describe('场景'), command: z.string().describe('命令'),
    output: z.string().describe('输出'), expected: z.string().describe('预期'),
    result: z.enum(['PASS','FAIL']).describe('结果'),
  }},
  { name: 'test_list', description: '查看测试证据', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'test_auto', description: '全量回归：执行所有 fixture case（CLI + Browser）。trace 默认关闭', guardrails: { supportsDryRun: true, requiresConfirm: true }, schema: {
    storyId: z.string().optional().describe('已废弃，请用 test_story'),
    trace: z.boolean().optional().describe('启用 V8 profiler trace（默认关闭，仅刷新 aux_trace 数据时开）'),
    enableProfiler: z.boolean().optional().describe('（兼容别名）等同于 trace'),
    dryRun: z.boolean().optional().describe('仅预览将扫描/清理/执行的范围，不真实执行全量回归'),
    confirm: z.boolean().optional().describe('显式确认执行 destructive 的全量回归'),
  }},
  { name: 'test_story', description: 'story 级测试：只跑关联 case，写 bug/evidence', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  { name: 'test_fixture', description: '单 case/单链测试：按 fixtureId(uuid) 定位', schema: {
    fixtureId: z.string().describe('case 的 _id (uuid)'),
  }},
  // Fixture
  { name: 'fixture_get', description: '读取 fixture cases', schema: { fixturePath: z.string().describe('路径(不含.json)') }},
  { name: 'fixture_update', description: '增删改 fixture case', schema: {
    fixturePath: z.string().describe('路径'), action: z.enum(['add','update','delete']).describe('操作'),
    case: z.object({
      name: z.string().describe('case 名'),
      run_type: z.enum(['cli', 'browser']).optional().describe('运行类型'),
      file: z.string().optional().describe('源文件路径'),
      execute: z.string().optional().describe('函数体'),
      expect: z.any().optional().describe('期望（对象走 subset 匹配：actual 含 expect 所有键且值等即通过）'),
      throws: z.string().optional().describe('期望错误'),
      debug: z.any().optional().describe('B-5010: 诊断字段，runner 不断言，仅在 fail 时附带打印'),
      intentRef: z.string().optional().describe('关联 testIntent（如 CHK-001:happy:0）'),
      sandbox: z.boolean().optional().describe('沙箱模式（false=允许 fs 访问）'),
      timeoutMs: z.number().optional().describe('单 case 超时（ms），默认 runner 全局超时'),
    }).describe('case 数据'),
  }},
  // Session brief (跨 session 开场简报)
  { name: 'session_brief', description: '生成本 session 的开场简报：active story + checklist + bug + activity + 推断的下一步', schema: {
    concise: z.boolean().optional().describe('B-89c7 CHK-008 简短模式：< 4KB 输出，用于 SessionStart hook 注入'),
  } },

  // Doctor (health issue 巡检)
  { name: 'doctor', description: '查看 koala 自身的 health issue（被 silent catch 接住的 PERSIST 失败）+ 扫 .worktrees/ 孤儿目录', schema: {
    format: z.enum(['text', 'json']).optional().describe('输出格式（默认 text）'),
    limit: z.number().optional().describe('最多读取条数（默认 1000）'),
    repair: z.boolean().optional().describe('rm -rf 清理 .worktrees/ 下不在 git worktree list 的孤儿目录（activity.jsonl 等 hook 残留场景）'),
  }},

  { name: 'fixture_batch_add', description: '批量添加多个 case（1次替代N次）', longHelp: FIXTURE_BATCH_ADD_LONG, schema: {
    fixturePath: z.string().describe('路径(不含.json)'),
    cases: z.array(z.object({
      name: z.string(), run_type: z.enum(['cli', 'browser']).optional(),
      file: z.string().optional(), execute: z.string().optional(),
      expect: z.any().optional().describe('期望（对象走 subset 匹配）'),
      throws: z.string().optional(),
      debug: z.any().optional().describe('B-5010: 诊断字段，fail 时附带打印'),
      intentRef: z.string().optional().describe('关联 testIntent（如 CHK-001:happy:0）'),
      sandbox: z.boolean().optional(),
      timeoutMs: z.number().optional().describe('单 case 超时（ms）'),
    })).describe('case 数组'),
    dryRun: z.boolean().optional().describe('仅预览新增/跳过/报错结果，不写入 fixture'),
  }, guardrails: { supportsDryRun: true }},

];

/**
 * 运行时工具列表 — runCli() 启动时会赋值，包括 main 自带的 + extras。
 * 之后所有 helper（printHelp、dispatch lookup 等）都通过这个变量访问，
 * 不直接引用 MAIN_TOOLS。
 */
let TOOLS: ToolDef[] = MAIN_TOOLS;

function displayCommandName(name: string): string {
  if (name.startsWith('lab_')) return `lab ${name.slice(4)}`;
  return name;
}

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

function printToolHelp(tool: ToolDef) {
  const displayName = displayCommandName(tool.name);
  console.log(`\n  koala ${displayName} — ${tool.description}\n`);

  // 如果有 longHelp（核心命令），先打印完整 PROMPT
  if (tool.longHelp) {
    console.log(tool.longHelp);
    console.log('');
  }

  const entries = Object.entries(tool.schema);
  if (entries.length === 0) {
    console.log('  无参数\n');
    console.log(`  用法: koala ${displayName}`);
    console.log(SESSION_BRIEF_FOOTER);
    return;
  }
  console.log('  参数:');
  const maxN = Math.max(...entries.map(([k]) => k.length));
  for (const [name, type] of entries) {
    const opt = type instanceof ZodOptional;
    const req = opt ? '' : ' *';
    const inner = type instanceof ZodOptional ? (type as any)._def.innerType : type;
    const isComplex = inner instanceof ZodArray || inner instanceof ZodObject;
    const flagHint = isComplex ? '(JSON)' : '';
    console.log(`    --${name.padEnd(maxN + 2)} ${describeType(type).padEnd(16)} ${getDesc(type)}${req} ${flagHint}`);
  }
  const required = entries.filter(([, t]) => !(t instanceof ZodOptional));
  const optional = entries.filter(([, t]) => t instanceof ZodOptional);
  const reqParts = required.map(([k]) => `--${k}=值`);
  const optParts = optional.map(([k]) => {
    const inner = (entries.find(([n]) => n === k)?.[1] as any);
    const base = inner instanceof ZodOptional ? (inner as any)._def.innerType : inner;
    return base instanceof ZodBoolean ? `[--${k}]` : `[--${k}=值]`;
  });
  console.log(`\n  用法: koala ${displayName} ${[...reqParts, ...optParts].join(' ')}`);
  console.log('  (* = 必填)');
  console.log(SESSION_BRIEF_FOOTER);
}

function printNamespaceHelp(namespace: 'lab') {
  const tools = TOOLS.filter((tool) => tool.name.startsWith(`${namespace}_`));
  if (tools.length === 0) {
    const reason = process.env.KOALA_LAB_IMPORT_ERROR
      ? `\n  Lab import error: ${process.env.KOALA_LAB_IMPORT_ERROR}`
      : '';
    console.log(`\n  koala lab — koala-lab 尚未构建，当前不可用。\n`);
    console.log('  Recovery:');
    console.log('    1. npm --prefix packages/main run build');
    console.log('    2. npm --prefix packages/utils run build');
    console.log('    3. npm --prefix packages/lab run build');
    console.log('    4. Retry: koala lab create --target=test-case-reviewer --profile=reviewer-quality-v1');
    if (reason) console.log(reason);
    console.log('');
    return;
  }

  const maxN = Math.max(...tools.map((tool) => displayCommandName(tool.name).length), 0);
  console.log(`\n  koala lab — 离线优化实验室\n`);
  console.log('  用法: koala lab <subcommand> [flags]\n');
  for (const tool of tools) {
    console.log(`    ${displayCommandName(tool.name).padEnd(maxN + 2)} ${tool.description}`);
  }
  console.log('\n  提示: 用 `koala lab <subcommand> --help` 查看参数\n');
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
    testintent: 'Checklist',
    bug: 'Bug',
    test: 'Test',
    fixture: 'Fixture',
    lab: 'Lab',
    aux: 'Aux',
    truth: 'Truth',
    gap: 'Gap',
    convergence: 'Gap',
  };
  // 已知分组的展示顺序；不在列表里的分组（来自 extras）按字母序追加
  const KNOWN_ORDER = ['Story', 'Review', 'Checklist', 'Bug', 'Test', 'Fixture', 'Truth', 'Gap', 'Aux', 'Lab'];

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
    for (const t of groups[g]) console.log(`    ${displayCommandName(t.name).padEnd(maxN + 2)} ${t.description}`);
  }
  console.log(`
  开发流程:
    ── PLAN 阶段（需求分析）──
    1. koala story_create '{"name":"x","title":"..","description":"..","type":"feature","priority":"high","checklist":[{"title":"做什么","context":"根因/参考方案"}]}'
    2. koala story_review --storyId=B-xxx                     # 对抗审查 testIntent
    3. koala story_advance --storyId=B-xxx --phase=INIT_CHECK # 自动创建 worktree

    ── DEV 阶段（开发）──
    4. 写代码
    5. koala fixture_batch_add '{"fixturePath":"x","cases":[...]}' # 按 testIntent 写测试
    6. koala checklist_update --storyId=B-xxx --itemId=CHK-001 --status=done

    ── TEST 阶段（测试）──
   10. koala story_advance --storyId=B-xxx --phase=TEST
   11. koala test_auto --storyId=B-xxx
   12. koala story_advance --storyId=B-xxx --phase=DONE
   13. koala truth_extract                                    # 从代码+Story 反向提取真相源

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
  const normalizeKey = (key: string) => key.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
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
        const key = normalizeKey(arg.slice(2, eqIdx));
        const val = arg.slice(eqIdx + 1);
        addValue(result, key, coerce(val, schema[key]), arrayKeys.has(key));
      } else {
        const key = normalizeKey(arg.slice(2));
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
      const key = normalizeKey(arg.slice(0, eqIdx));
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
    (obj[key] as unknown[]).push(val);
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
  try {
    const cd = execSync('git rev-parse --git-common-dir', { encoding: 'utf-8' }).trim();
    if (cd !== '.git' && !cd.endsWith('/.git') && !cd.endsWith('\\.git')) {
      return execSync('git worktree list --porcelain', { encoding: 'utf-8' }).split('\n')[0]?.replace('worktree ', '').trim() || process.cwd();
    }
  } catch {}
  return process.cwd();
}

// ── Main ──

/**
 * runCli — koala CLI 运行时入口
 *
 * @param opts.extraTools     第三方包的 ToolDef 列表，会合进 help 和 dispatch
 * @param opts.extraRegister  第三方包的 register 函数，在 createMainRegistry 之后调用
 *                            （收到 Registry 实例后用 registry.registerBatch(...) 注入 handler）
 */
/**
 * @task B-4b17
 * @checklist CHK-001
 * @title CLI dangerous command guardrails for dry-run and confirm
 * @type feature
 * @priority high
 * @description
 *   为公开 CLI 命令提供统一的危险命令护栏：支持 dry-run 预览，并对
 *   irreversible / destructive 命令默认要求 --confirm。当前覆盖
 *   story_discard、fixture_batch_add、test_auto 等会删除 worktree、批量写文件
 *   或触发 git restore / clean 的入口。
 * @changes
 *   - [CHK-001] ToolDef 增加 guardrails 元数据，标记 supportsDryRun / requiresConfirm
 *   - [CHK-001] CLI dispatch 在命令真正执行前统一拦截未确认的危险命令
 *   - [CHK-001] 兼容 --dry-run 到 dryRun 的 kebab-case 参数形式
 * @test dangerous-command-guardrails
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
  let rawArgStart = 1;

  // Detect active story from git branch
  const root0 = resolveRoot(rootOverride);
  const activeStory = detectActiveStory(root0);

  if (!cmd || cmd === 'help' || cmd === '--help') { printHelp(activeStory); return; }

  if (cmd === 'lab') {
    const hasLabTools = TOOLS.some((tool) => tool.name.startsWith('lab_'));
    if (!hasLabTools) {
      printNamespaceHelp('lab');
      process.exit(1);
    }
    if (!argv[1] || argv[1] === 'help' || argv[1] === '--help' || argv[1] === '-h') {
      printNamespaceHelp('lab');
      return;
    }
    cmd = `lab_${argv[1]}`;
    arg = argv[2];
    rawArgStart = 2;
  }

  // init 走独立脚本
  if (cmd === 'init') {
    const initPath = new URL('./cli-init.js', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
    await import(`file://${initPath}`);
    return;
  }

  const tool = TOOLS.find(t => t.name === cmd);
  if (!tool) {
    console.error(`未知命令: ${cmd}`);
    const m = TOOLS.filter(t => t.name.includes(cmd) || cmd.includes(t.name.split('_')[0]));
    if (m.length) { console.error('你是不是要找:'); for (const t of m) console.error(`  koala ${displayCommandName(t.name)}`); }
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
    const rawArgs = argv.slice(rawArgStart);
    if (rawArgs.length === 0) {
      // 无参数，空对象
    } else if (rawArgs.length === 1 && rawArgs[0].startsWith('{')) {
      // JSON body 格式（兼容旧用法）
      try { parsed = JSON.parse(rawArgs[0]); }
      catch (e) {
        console.error(`JSON 解析失败: ${(e as Error).message}\n输入: ${rawArgs[0]}`);
        printToolHelp(tool);
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
    console.error('参数校验失败:');
    for (const i of v.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`);
    printToolHelp(tool);
    process.exit(1);
  }

  const guardrails = tool.guardrails;
  if (guardrails?.requiresConfirm && !(v.data as any).confirm && !(v.data as any).dryRun) {
    console.error(
      `错误: ${cmd} 是危险命令，默认不会直接执行。\n` +
      `→ 先用 --dry-run 预览会发生什么，或加 --confirm 明确执行`
    );
    process.exit(1);
  }

  // Execute
  const root = resolveRoot(rootOverride);
  const store = new StoryStore(root);
  const _cliStart = Date.now();
  let log: (msg: string) => void = (msg) => {
    const elapsed = ((Date.now() - _cliStart) / 1000).toFixed(1);
    process.stdout.write(`[${elapsed}s] ${msg}\n`);
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

  // 统一日志：写入 docs/story/activity.jsonl（和 Claude hook 日志合并）
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
      // points at that worktree. If we mkdirSync on the now-ghost path, we
      // re-create `<ghost>/docs/story/` and leave a dangling audit log that
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
      const logDir = join(effectiveRoot, 'docs', 'story');
      mkdirSync(logDir, { recursive: true });
      const activitySource = (process.env.KOALA_ACTIVITY_SOURCE || 'cli').trim() || 'cli';
      const activitySession = process.env.KOALA_ACTIVITY_SESSION?.trim() || null;
      const activityRole = inferActivityRole(entry.args, process.env.KOALA_ACTIVITY_ROLE?.trim() || null);
      const record: Record<string, unknown> = {
        source: activitySource,
        startTime: entry.startTime,
        endTime: entry.endTime,
        tool: entry.command,
        detail: entry.command,
        args: entry.args,
        status: entry.success ? 'ok' : 'fail',
        result: entry.success ? null : undefined,
        error: entry.error || null,
        storyId: null,
      };
      if (activitySession) record.session = activitySession;
      if (activityRole) record.role = activityRole;
      if (entry.staleWarnings && entry.staleWarnings.length > 0) {
        record.staleWarnings = entry.staleWarnings;
      }
      appendFileSync(join(logDir, 'activity.jsonl'), JSON.stringify(record) + '\n');
    } catch (e: unknown) {
      reportHealthIssue('persist:writeLog', e as Error, {
        command: entry.command,
        // Note: reports the original `root`, since effectiveRoot lives
        // inside the try-block scope. Health log is diagnostic only.
        logDir: join(root, 'docs', 'story'),
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
    if (config0?.hooks?.preCommand) {
      process.stderr.write(`[koala-hook] running preCommand hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
    }
    await runHooks('preCommand', cmd, buildHookEnvLocal('preCommand'), config0, root);
    try {
      let result = fn();
      if (result && typeof (result as any).then === 'function') result = await result;
      clearInterval(watchdog);
      log(`${cmd} done`);
      writeLog({ command: cmd, args: parsed, startTime: runStart, endTime: new Date().toISOString(), success: true, staleWarnings });
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
      if (config0?.hooks?.postCommand) {
        process.stderr.write(`[koala-hook] running postCommand hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
      }
      await runHooks('postCommand', cmd, buildHookEnvLocal('postCommand', {
        KOALA_RESULT_JSON: truncateForEnv(resultText),
      }), config0, root);
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } catch (e: any) {
      clearInterval(watchdog);
      log(`${cmd} failed: ${e.message}`);
      writeLog({ command: cmd, args: parsed, startTime: runStart, endTime: new Date().toISOString(), success: false, error: e.message, staleWarnings });
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
      if (!result.includes('(INIT)')) return result;
      const storyId = result.match(/Story\s+([\w-]+)/)?.[1];
      if (!storyId) return result;
      return `${result}\n→ Story 停在 INIT 阶段。下一步:\n  1. 先 story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK","dryRun":true}' 预览 bootstrap git 变更\n  2. 若确认创建 worktree，执行 story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK","confirm":true}'\n  3. cd 到提示的 worktree 路径\n  4. story_advance '{"storyId":"${storyId}","phase":"PLAN"}' 进入 PLAN（cwd 必须是 worktree）`;
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
      const initArgs = v.data as any;
      // 探测当前 phase；若已在 INIT_CHECK 就跳过 advance 直接 dev_start 重试
      let advanceResult = '';
      let currentPhase = '';
      try { currentPhase = store.readStory(storyId).phase; } catch { /* fallback below */ }
      if (currentPhase === 'INIT' && (initArgs.dryRun || !initArgs.confirm)) {
        const preview = handlers.dev_start({
          storyId,
          dryRun: initArgs.dryRun,
          confirm: initArgs.confirm,
        });
        if (initArgs.dryRun) {
          return `Story ${storyId} 当前在 INIT。进入 INIT_CHECK 会触发 bootstrap git 变更，先预览如下：\n\n${preview}`;
        }
        if (!initArgs.confirm) {
          throw new Error(
            `Story ${storyId} 当前在 INIT。进入 INIT_CHECK 会触发 bootstrap git 变更，默认已阻止。\n\n${preview}`
          );
        }
      }
      if (currentPhase === 'INIT_CHECK') {
        advanceResult = `Story ${storyId} 已在 INIT_CHECK 阶段，重试 worktree 创建`;
      } else {
        advanceResult = await handlers.story_advance(v.data);
      }
      try {
        const wtResult = handlers.dev_start({
          storyId,
          dryRun: initArgs.dryRun,
          confirm: initArgs.confirm,
        });
        if (initArgs.dryRun) {
          return `${advanceResult}\n\n${wtResult}`;
        }
        return `${advanceResult}\n\n${wtResult}\n\n→ 现在请 cd 到上述 worktree 路径，然后调 story_advance phase=PLAN 进入 PLAN`;
      } catch (e: any) {
        if (e?.message?.includes('默认已阻止')) {
          throw e;
        }
        return `${advanceResult}\n⚠ worktree 创建失败: ${e.message}\n→ 排查后再次执行 story_advance --phase=INIT_CHECK（需要 bootstrap git 变更时先 dryRun，再 confirm），或手动 dev_start '{"storyId":"${storyId}","dryRun":true}'`;
      }
    });
    return;
  }

  const handler = handlers[cmd];
  if (!handler) { console.error(`handler not found: ${cmd}`); process.exit(1); }

  await run(() => Object.keys(tool.schema).length === 0 ? handler() : handler(v.data));
}
