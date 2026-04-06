#!/usr/bin/env node
/**
 * koala CLI — 所有工具通过 bash 直接调用
 *
 * 用法:
 *   koala <command> '{"key":"value"}'   # JSON 参数
 *   koala <command> --help              # 查看参数说明
 *   koala help                          # 列出所有命令
 *   koala --root /path/to/project ...   # 指定项目根目录
 */

import { z, ZodType, ZodOptional, ZodEnum, ZodArray, ZodUnion, ZodString, ZodBoolean, ZodNumber, ZodObject } from 'zod';
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { StoryStore } from './story/store.js';
import { createToolHandlers } from './mcp/tools.js';
import { execSync } from 'child_process';
import { loadConfig, isCommandAllowed, getAllowedPatterns } from './config.js';

// ── Tool Registry ──

interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, ZodType>;
}

const TOOLS: ToolDef[] = [
  // Story
  { name: 'story_create', description: '创建 Story 条目', schema: {
    name: z.string().describe('短名称'), title: z.string().describe('标题'),
    description: z.string().describe('描述'), type: z.enum(['feature','bug','refactor','chore']).describe('类型'),
    priority: z.string().describe('优先级'), source: z.string().optional().describe('来源'),
    depends: z.array(z.string()).optional().describe('依赖 Story ID'),
    keywords: z.array(z.string()).optional().describe('关键词（领域/模块/概念，用于查重）'),
    checklist: z.array(z.object({ title: z.string(), context: z.string().optional(), relatedDocs: z.array(z.string()).optional().describe('关联文档路径（用于三次提醒）'), testIntent: z.object({ happy: z.array(z.union([z.string(), z.object({ desc: z.string(), type: z.enum(['cli_blackbox','browser_blackbox']) })])), edge: z.array(z.union([z.string(), z.object({ desc: z.string(), type: z.enum(['cli_blackbox','browser_blackbox']) })])).optional(), adversarial: z.array(z.union([z.string(), z.object({ desc: z.string(), type: z.enum(['cli_blackbox','browser_blackbox']) })])).optional() }).optional() })).optional().describe('开发清单'),
    prefix: z.string().optional().describe('ID 前缀(默认 B)'),
    phase: z.enum(['IDEA','INIT','INIT_CHECK','PLAN','DEV','TEST_CASE','TEST_CASE_REVIEW','TEST','DONE']).optional().describe('直接指定阶段'),
  }},
  { name: 'story_advance', description: '推进 Story 到下一阶段', schema: {
    storyId: z.string().describe('Story ID'), phase: z.enum(['IDEA','INIT','INIT_CHECK','PLAN','DEV','TEST_CASE','TEST_CASE_REVIEW','TEST','DONE']).describe('目标阶段'),
    checklist: z.array(z.object({ id: z.string(), title: z.string() })).optional().describe('开发清单'),
  }},
  { name: 'story_update', description: '编辑 Story 信息', schema: {
    storyId: z.string().describe('Story ID'), title: z.string().optional().describe('新标题'),
    description: z.string().optional().describe('新描述'), priority: z.string().optional().describe('新优先级'),
  }},
  { name: 'story_get', description: '读取 Story 详情', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'story_list', description: '列出全部 Story', schema: { phase: z.enum(['IDEA','INIT','INIT_CHECK','PLAN','DEV','TEST_CASE','TEST_CASE_REVIEW','TEST','DONE']).optional().describe('按阶段过滤') }},

  // Review
  { name: 'story_review', description: '对抗审查 testIntent 完整性', schema: {
    storyId: z.string().describe('Story ID'),
  }},

  { name: 'doc_list', description: '列出项目文档（PLAN 阶段挑选 relatedDocs 用）', schema: {
    format: z.enum(['text','json']).optional().describe('输出格式（默认 text）'),
  }},

  // Checklist
  { name: 'checklist_get', description: '读取 checklist', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'checklist_add', description: '向已有 story 追加 checklist item', schema: {
    storyId: z.string().describe('Story ID'), title: z.string().describe('做什么（一句话）'),
    context: z.string().optional().describe('根因/参考方案'),
    relatedDocs: z.array(z.string()).optional().describe('关联文档路径（用于三次提醒）'),
  }},
  { name: 'checklist_update', description: '更新 checklist 项 (status/title/context/testIntent/relatedDocs)', schema: {
    storyId: z.string().describe('Story ID'), itemId: z.string().describe('项 ID'),
    status: z.enum(['pending','in_progress','done']).optional().describe('新状态'),
    title: z.string().optional().describe('新标题'),
    context: z.string().optional().describe('新 context'),
    relatedDocs: z.array(z.string()).optional().describe('关联文档路径（用于三次提醒）'),
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
  { name: 'testintent_migrate', description: '批量迁移存量 testIntent 从字符串到 {desc,type}', schema: {
    dryRun: z.boolean().optional().describe('预览模式，不实际修改'),
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

  // Test
  { name: 'test_add', description: '记录测试证据', schema: {
    storyId: z.string().describe('Story ID'), id: z.string().describe('TE ID'),
    scenario: z.string().describe('场景'), command: z.string().describe('命令'),
    output: z.string().describe('输出'), expected: z.string().describe('预期'),
    result: z.enum(['PASS','FAIL']).describe('结果'),
  }},
  { name: 'test_list', description: '查看测试证据', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'test_auto', description: '全量回归：执行所有 fixture case（CLI + Browser，含 V8 profiler）', schema: {
    storyId: z.string().optional().describe('已废弃，请用 test_story'),
    enableProfiler: z.boolean().optional().describe('启用 V8 profiler（默认 true）'),
  }},
  { name: 'test_story', description: 'story 级测试：只跑关联 case，写 bug/evidence', schema: {
    storyId: z.string().describe('Story ID'),
  }},
  { name: 'test_fixture', description: '单 case/单链测试：按 fixtureId(uuid) 定位', schema: {
    fixtureId: z.string().describe('case 的 _id (uuid)'),
  }},
  { name: 'diagnose', description: '自动诊断 case 失败根因（trace diff + git diff）', schema: {
    caseName: z.string().describe('case 名'),
    fixturePath: z.string().optional().describe('fixture 路径（可选）'),
  }},
  { name: 'arch_trace', description: '基于 trace 数据提取架构（逻辑线 + 影响图 + 盲区）', schema: {
    format: z.enum(['json', 'mermaid']).optional().describe('输出格式（默认 json）'),
  }},

  // Task
  { name: 'task_scan', description: '扫描元数据 + 校验合规性', schema: {
    format: z.enum(['json','markdown']).optional().describe('输出格式'),
    type: z.string().optional().describe('按类型筛选'), priority: z.string().optional().describe('按优先级筛选'),
    id: z.string().optional().describe('按 task ID 筛选'),
  }},
  { name: 'task_detail', description: '按文件查详情（签名、属性、import）', schema: {
    files: z.array(z.string()).describe('文件名数组（相对 scanRoot）'),
  }},
  { name: 'task_annotate_batch', description: '批量注解多个函数（1次替代N次）', schema: {
    projectRoot: z.string().optional().describe('项目根目录'),
    items: z.array(z.object({
      sourceFile: z.string(), functionName: z.string(),
      task: z.string(), checklist: z.string(), title: z.string(),
      type: z.string(), priority: z.string(), description: z.string(),
      changes: z.array(z.string()), test: z.string().optional(),
    })).describe('函数元数据数组'),
  }},
  { name: 'task_sync', description: '元数据同步：extract/validate/status', schema: {
    direction: z.enum(['extract','clean','generate','validate','status']).describe('操作方向'),
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
      expect: z.any().optional().describe('期望'), throws: z.string().optional().describe('期望错误'),
      intentRef: z.string().optional().describe('关联 testIntent（如 CHK-001:happy:0）'),
      sandbox: z.boolean().optional().describe('沙箱模式（false=允许 fs 访问）'),
    }).describe('case 数据'),
  }},
  { name: 'fixture_batch_add', description: '批量添加多个 case（1次替代N次）', schema: {
    fixturePath: z.string().describe('路径(不含.json)'),
    cases: z.array(z.object({
      name: z.string(), run_type: z.enum(['cli', 'browser']).optional(),
      file: z.string().optional(), execute: z.string().optional(),
      expect: z.any().optional(), throws: z.string().optional(),
      intentRef: z.string().optional().describe('关联 testIntent（如 CHK-001:happy:0）'),
      sandbox: z.boolean().optional(),
    })).describe('case 数组'),
  }},

  { name: 'fixture_migrate', description: '迁移旧 fixture：补写 _id 和 prevCaseId/nextCaseId', schema: {
    dryRun: z.boolean().optional().describe('仅预览不写入（默认 false）'),
  }},

  // Browser
  { name: 'browser_test', description: '浏览器真机测试', schema: {
    projectRoot: z.string().optional().describe('项目根目录'), fixture: z.string().optional().describe('fixture 路径'),
  }},

  // Truth
  { name: 'truth_scan', description: '扫描真相源', schema: { summary: z.boolean().optional().describe('摘要模式') }},
  { name: 'truth_extract', description: '从代码+Story反向提取真相源文档', schema: {}},
  { name: 'truth_nav', description: '生成导航索引', schema: {}},
  { name: 'truth_analyze', description: '分析真相源矛盾/缺失', schema: {}},
  { name: 'truth_to_story', description: '从需求拆解 Story 建议', schema: {}},

  // Gap
  { name: 'gap_analyze', description: '真相源 vs 代码差距报告', schema: {}},
  { name: 'convergence_check', description: '项目收敛检查', schema: {}},

  // Runtime
  { name: 'runtime_gen', description: '扫描 task.json 自动生成 test-runtime.js 骨架', schema: {}},

  // Worktree
  { name: 'dev_start', description: '创建 worktree 开发环境', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'dev_finish', description: '开发完成，推进到 TEST', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'dev_merge', description: '合并回主分支，推进到 DONE', schema: { storyId: z.string().describe('Story ID') }},
];

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
  console.log(`\n  koala ${tool.name} — ${tool.description}\n`);
  const entries = Object.entries(tool.schema);
  if (entries.length === 0) {
    console.log('  无参数\n');
    console.log(`  用法: koala ${tool.name}\n`);
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
  console.log(`\n  用法: koala ${tool.name} ${[...reqParts, ...optParts].join(' ')}`);
  console.log('  (* = 必填)\n');
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

  const groups: Record<string, ToolDef[]> = {};
  for (const t of TOOLS) {
    // 有 active story 时只列出当前阶段可用命令
    if (activeStory && !isCommandAllowed(t.name, activeStory.phase, phaseTools)) continue;
    const p = t.name.split('_')[0];
    const g = p === 'story' ? (t.name === 'story_review' ? 'Review' : 'Story') : p === 'checklist' ? 'Checklist' : p === 'bug' ? 'Bug'
      : p === 'test' ? 'Test' : p === 'task' ? 'Task'
      : p === 'testintent' ? 'Checklist' : p === 'fixture' ? 'Fixture' : p === 'browser' ? 'Browser' : p === 'truth' ? 'Truth'
      : p === 'gap' || p === 'convergence' ? 'Gap' : p === 'dev' ? 'Worktree' : 'Other';
    (groups[g] = groups[g] || []).push(t);
  }
  const filteredTools = activeStory ? TOOLS.filter(t => isCommandAllowed(t.name, activeStory.phase, phaseTools)) : TOOLS;
  const maxN = Math.max(...filteredTools.map(t => t.name.length), 0);
  for (const g of ['Story','Review','Checklist','Bug','Test','Task','Fixture','Browser','Truth','Gap','Worktree']) {
    if (!groups[g]) continue;
    console.log(`  ${g}:`);
    for (const t of groups[g]) console.log(`    ${t.name.padEnd(maxN + 2)} ${t.description}`);
  }
  console.log(`
  开发流程:
    ── PLAN 阶段（需求分析）──
    1. koala story_create '{"name":"x","title":"..","description":"..","type":"feature","priority":"high","checklist":[{"title":"做什么","context":"根因/参考方案"}]}'
    2. koala story_review --storyId=B-xxx                     # 对抗审查 testIntent
    3. koala dev_start '{"storyId":"B-xxx"}'                  # 进 DEV 并创建独立 worktree

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

async function main() {
  const argv = process.argv.slice(2);

  // --root flag
  let rootOverride: string | undefined;
  const ri = argv.indexOf('--root');
  if (ri !== -1 && argv[ri + 1]) { rootOverride = argv[ri + 1]; argv.splice(ri, 2); }

  const cmd = argv[0];
  const arg = argv[1];

  // Detect active story from git branch
  const root0 = resolveRoot(rootOverride);
  const activeStory = detectActiveStory(root0);

  if (!cmd || cmd === 'help' || cmd === '--help') { printHelp(activeStory); return; }

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

  // Execute
  const root = resolveRoot(rootOverride);
  const store = new StoryStore(root);
  const _cliStart = Date.now();
  let log: (msg: string) => void = (msg) => {
    const elapsed = ((Date.now() - _cliStart) / 1000).toFixed(1);
    process.stdout.write(`[${elapsed}s] ${msg}\n`);
  };
  const handlers = createToolHandlers(store, root, log) as Record<string, Function>;

  // 心跳：2 分钟无输出 = 卡死；10 分钟绝对保底
  const IDLE_TIMEOUT = 2 * 60 * 1000;
  const MAX_TIMEOUT = 10 * 60 * 1000;
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
  function writeLog(entry: { command: string; args: unknown; startTime: string; endTime: string; success: boolean; error?: string }) {
    try {
      const logDir = join(root, 'docs', 'story');
      mkdirSync(logDir, { recursive: true });
      appendFileSync(join(logDir, 'activity.jsonl'), JSON.stringify({
        source: 'cli',
        startTime: entry.startTime,
        endTime: entry.endTime,
        tool: entry.command,
        detail: entry.command,
        args: entry.args,
        status: entry.success ? 'ok' : 'fail',
        result: entry.success ? null : undefined,
        error: entry.error || null,
        storyId: null,
      }) + '\n');
    } catch { /* ignore */ }
  }

  async function run(fn: () => unknown | Promise<unknown>) {
    const runStart = new Date().toISOString();
    log(`running ${cmd}...`);
    try {
      let result = fn();
      if (result && typeof (result as any).then === 'function') result = await result;
      clearInterval(watchdog);
      log(`${cmd} done`);
      writeLog({ command: cmd, args: parsed, startTime: runStart, endTime: new Date().toISOString(), success: true });
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } catch (e: any) {
      clearInterval(watchdog);
      log(`${cmd} failed: ${e.message}`);
      writeLog({ command: cmd, args: parsed, startTime: runStart, endTime: new Date().toISOString(), success: false, error: e.message });
      console.error(`错误: ${e.message}`);
      process.exit(1);
    }
  }

  // browser_test 特殊处理
  if (cmd === 'browser_test') {
    await run(async () => {
      const { executeBrowserCases } = await import('./tasks/browser-executor.js');
      const { readFileSync, readdirSync, existsSync } = await import('fs');
      const { join } = await import('path');
      const r = (parsed.projectRoot as string) || root;
      const cp = join(r, 'koala.config.json');
      let cfg: any = {};
      if (existsSync(cp)) { try { cfg = JSON.parse(readFileSync(cp, 'utf-8')); } catch {} }
      if (!cfg.browser?.devCommand) throw new Error('未配置 browser.devCommand');
      const cases: Array<{ name: string; steps: any[] }> = [];
      const fd = join(r, cfg.fixturesDir);
      if (parsed.fixture) {
        const f = JSON.parse(readFileSync(join(fd, parsed.fixture + '.json'), 'utf-8'));
        for (const c of f.cases || []) { if (c.browser && c.steps) cases.push({ name: c.name, steps: c.steps }); }
      } else if (existsSync(fd)) {
        const scan = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) { scan(join(d, e.name)); continue; } if (!e.name.endsWith('.json')) continue; try { const f = JSON.parse(readFileSync(join(d, e.name), 'utf-8')); for (const c of f.cases || []) { if (c.browser && c.steps) cases.push({ name: c.name, steps: c.steps }); } } catch {} } };
        scan(fd);
      }
      if (!cases.length) throw new Error('没有 browser case');
      const res = await executeBrowserCases({ devCommand: cfg.browser.devCommand, projectRoot: r, onProgress: log }, cases);
      return { total: res.cases.length, passed: res.cases.filter(c => c.passed).length, trace: { calls: res.trace.length, functions: res.coveredFunctions } };
    });
    return;
  }

  // story_create: 停在 INIT 时追加下一步提示
  if (cmd === 'story_create') {
    await run(() => {
      const result = handlers.story_create(v.data);
      if (!result.includes('(INIT)')) return result;
      const storyId = result.match(/Story\s+([\w-]+)/)?.[1];
      if (!storyId) return result;
      return `${result}\n→ Story 停在 INIT 阶段。下一步:\n  1. story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}' 创建 worktree\n  2. cd 到提示的 worktree 路径\n  3. story_advance '{"storyId":"${storyId}","phase":"PLAN"}' 进入 PLAN（cwd 必须是 worktree）`;
    });
    return;
  }

  // story_advance phase=INIT_CHECK：成功后自动调 dev_start 创建 worktree
  if (cmd === 'story_advance' && (v.data as any)?.phase === 'INIT_CHECK') {
    await run(() => {
      const advanceResult = handlers.story_advance(v.data);
      const storyId = (v.data as any).storyId;
      try {
        const wtResult = handlers.dev_start({ storyId });
        return `${advanceResult}\n\n${wtResult}\n\n→ 现在请 cd 到上述 worktree 路径，然后调 story_advance phase=PLAN 进入 PLAN`;
      } catch (e: any) {
        return `${advanceResult}\n⚠ worktree 创建失败: ${e.message}\n→ 可手动 dev_start '{"storyId":"${storyId}"}' 重试`;
      }
    });
    return;
  }

  const handler = handlers[cmd];
  if (!handler) { console.error(`handler not found: ${cmd}`); process.exit(1); }

  await run(() => Object.keys(tool.schema).length === 0 ? handler() : handler(v.data));
}

// 仅在直接执行时运行（被 import 时跳过）
// test_auto 的 importAndExecute 带 ?t= cache buster，import.meta.url 含查询参数 → 非直接执行
const _isDirectRun = !import.meta.url.includes('?');
if (_isDirectRun) {
  main().catch(e => { console.error(e); process.exit(1); });
}
