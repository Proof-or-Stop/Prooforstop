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
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { StoryStore } from './story/store.js';
import { createToolHandlers } from './mcp/tools.js';
import { execSync } from 'child_process';

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
    checklist: z.array(z.object({ title: z.string(), context: z.string().optional() })).optional().describe('开发清单'),
    prefix: z.string().optional().describe('ID 前缀(默认 B)'),
    phase: z.enum(['IDEA','PLAN','DEV','TEST','DONE']).optional().describe('直接指定阶段'),
  }},
  { name: 'story_advance', description: '推进 Story 到下一阶段', schema: {
    storyId: z.string().describe('Story ID'), phase: z.enum(['IDEA','PLAN','DEV','TEST','DONE']).describe('目标阶段'),
    checklist: z.array(z.object({ id: z.string(), title: z.string() })).optional().describe('开发清单'),
  }},
  { name: 'story_update', description: '编辑 Story 信息', schema: {
    storyId: z.string().describe('Story ID'), title: z.string().optional().describe('新标题'),
    description: z.string().optional().describe('新描述'), priority: z.string().optional().describe('新优先级'),
  }},
  { name: 'story_get', description: '读取 Story 详情', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'story_list', description: '列出全部 Story', schema: { phase: z.enum(['IDEA','PLAN','DEV','TEST','DONE']).optional().describe('按阶段过滤') }},
  { name: 'story_quick', description: '一键创建+DEV+worktree', schema: {
    name: z.string().describe('短名称'), title: z.string().describe('标题'),
    description: z.string().describe('描述'), type: z.enum(['feature','bug','refactor','chore']).describe('类型'),
    priority: z.string().describe('优先级'),
    checklist: z.array(z.object({ title: z.string(), context: z.string().optional() })).describe('开发清单'),
    prefix: z.string().optional().describe('ID 前缀'),
    noWorktree: z.boolean().optional().describe('跳过 worktree（默认开）'),
  }},

  // Checklist
  { name: 'checklist_get', description: '读取 checklist', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'checklist_update', description: '更新 checklist 项状态', schema: {
    storyId: z.string().describe('Story ID'), itemId: z.string().describe('项 ID'),
    status: z.enum(['pending','in_progress','done']).describe('新状态'),
    reason: z.string().optional().describe('变更原因'), agent: z.string().optional().describe('操作者'),
  }},

  // Bug
  { name: 'bug_report', description: '报告 bug', schema: {
    storyId: z.string().describe('Story ID'), id: z.string().describe('Bug ID'),
    title: z.string().describe('描述'), checklistId: z.string().optional().describe('关联 checklist ID'),
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
  { name: 'test_auto', description: '自动执行 fixture + e2e 测试', schema: {
    storyId: z.string().optional().describe('Story ID(可选)'),
    base: z.string().optional().describe('git diff 基准'),
    full: z.boolean().optional().describe('全量模式'),
  }},

  // Task
  { name: 'task_scan', description: '扫描元数据 + 校验合规性', schema: {
    format: z.enum(['json','markdown']).optional().describe('输出格式'),
    type: z.string().optional().describe('按类型筛选'), priority: z.string().optional().describe('按优先级筛选'),
    id: z.string().optional().describe('按 task ID 筛选'),
  }},
  { name: 'task_coverage', description: 'checklist 覆盖率检查', schema: {
    storyId: z.union([z.string(), z.array(z.string())]).describe('Story ID(单个或数组)'),
  }},
  { name: 'task_locate', description: '按 ID/关键词定位代码', schema: { query: z.string().describe('关键词') }},
  { name: 'task_annotate', description: '给函数添加/更新元数据', schema: {
    sourceFile: z.string().describe('源文件路径(相对 scanRoot)'), functionName: z.string().describe('函数名'),
    projectRoot: z.string().optional().describe('项目根目录'),
    lineHint: z.number().optional().describe('行号(消歧用)'),
    action: z.enum(['add','update']).optional().describe('操作类型'),
    task: z.string().describe('Story ID'), checklist: z.string().describe('Checklist ID'),
    title: z.string().describe('标题'), type: z.string().describe('类型'), priority: z.string().describe('优先级'),
    description: z.string().describe('描述'), changes: z.array(z.string()).describe('变更列表'),
    test: z.string().optional().describe('fixture 路径'), flow: z.string().optional().describe('flow 名称'),
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

  // Flow
  { name: 'flow_trace', description: '查看业务流转链路', schema: { name: z.string().describe('Flow 名称') }},
  { name: 'flow_list', description: '列出所有流转链路', schema: {}},

  // Fixture
  { name: 'fixture_get', description: '读取 fixture cases', schema: { fixturePath: z.string().describe('路径(不含.json)') }},
  { name: 'fixture_update', description: '增删改 fixture case', schema: {
    fixturePath: z.string().describe('路径'), action: z.enum(['add','update','delete']).describe('操作'),
    case: z.object({
      name: z.string().describe('case 名'), input: z.any().optional().describe('输入'),
      expect: z.any().optional().describe('期望'), throws: z.string().optional().describe('期望错误'),
      fn: z.string().optional().describe('目标函数'),
    }).describe('case 数据'),
  }},
  { name: 'fixture_batch_add', description: '批量添加多个 case（1次替代N次）', schema: {
    fixturePath: z.string().describe('路径(不含.json)'),
    cases: z.array(z.object({
      name: z.string(), fn: z.string().optional(), input: z.any().optional(),
      expect: z.any().optional(), throws: z.string().optional(),
    })).describe('case 数组'),
  }},
  { name: 'fixture_gen', description: '自动生成基础 fixture', schema: {
    fixturePath: z.string().describe('路径'), functionName: z.string().optional().describe('函数名'),
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

  // Worktree
  { name: 'dev_start', description: '创建 worktree 开发环境', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'dev_finish', description: '开发完成，推进到 TEST', schema: { storyId: z.string().describe('Story ID') }},
  { name: 'dev_merge', description: '合并回主分支，推进到 DONE', schema: { storyId: z.string().describe('Story ID') }},
];

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
    console.log(`    ${name.padEnd(maxN + 2)} ${describeType(type).padEnd(16)} ${getDesc(type)}${req}`);
  }
  const required = entries.filter(([, t]) => !(t instanceof ZodOptional));
  const example = Object.fromEntries(required.map(([k]) => [k, '...']));
  console.log(`\n  用法: koala ${tool.name} '${JSON.stringify(example)}'`);
  console.log('  (* = 必填)\n');
}

function printHelp() {
  console.log('\n  koala — AI-driven project management CLI\n');
  console.log('  用法: koala <command> \'{"key":"value"}\'   执行命令');
  console.log('        koala <command> --help              查看参数');
  console.log('        koala help                          显示此帮助');
  console.log('        koala --root <path> ...             指定项目根目录\n');

  const groups: Record<string, ToolDef[]> = {};
  for (const t of TOOLS) {
    const p = t.name.split('_')[0];
    const g = p === 'story' ? 'Story' : p === 'checklist' ? 'Checklist' : p === 'bug' ? 'Bug'
      : p === 'test' ? 'Test' : p === 'task' ? 'Task' : p === 'flow' ? 'Flow'
      : p === 'fixture' ? 'Fixture' : p === 'browser' ? 'Browser' : p === 'truth' ? 'Truth'
      : p === 'gap' || p === 'convergence' ? 'Gap' : p === 'dev' ? 'Worktree' : 'Other';
    (groups[g] = groups[g] || []).push(t);
  }
  const maxN = Math.max(...TOOLS.map(t => t.name.length));
  for (const g of ['Story','Checklist','Bug','Test','Task','Flow','Fixture','Browser','Truth','Gap','Worktree']) {
    if (!groups[g]) continue;
    console.log(`  ${g}:`);
    for (const t of groups[g]) console.log(`    ${t.name.padEnd(maxN + 2)} ${t.description}`);
  }
  console.log(`
  开发流程:
    1. koala story_quick '{"name":"x","title":"..","description":"..","type":"feature","priority":"high","checklist":[{"title":"做什么"}]}'
    2. koala task_scan          # 先了解项目（函数、文件、描述）
    3. koala task_detail '{"files":["要改的文件.ts"]}'   # 查签名、属性、import
    4. 写代码
    5. koala task_annotate_batch '{"items":[...]}'       # 批量注解元数据
    6. koala fixture_batch_add '{"fixturePath":"x","cases":[...]}'  # 批量添加测试
    7. koala checklist_update '{"storyId":"B-xxx","itemId":"CHK-001","status":"done"}'
    8. koala story_advance '{"storyId":"B-xxx","phase":"TEST"}'
    9. koala test_auto '{"storyId":"B-xxx"}'
   10. koala story_advance '{"storyId":"B-xxx","phase":"DONE"}'
   11. koala truth_extract                                    # 从代码+Story 反向提取真相源

  出错? 用 koala <command> --help 查看完整参数说明
`);
}

// ── Resolve root ──

function resolveRoot(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.KOALA_PROJECT_ROOT) return process.env.KOALA_PROJECT_ROOT;
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

  if (!cmd || cmd === 'help' || cmd === '--help') { printHelp(); return; }

  const tool = TOOLS.find(t => t.name === cmd);
  if (!tool) {
    console.error(`未知命令: ${cmd}`);
    const m = TOOLS.filter(t => t.name.includes(cmd) || cmd.includes(t.name.split('_')[0]));
    if (m.length) { console.error('你是不是要找:'); for (const t of m) console.error(`  koala ${t.name}`); }
    console.error('用 koala help 查看所有命令');
    process.exit(1);
  }

  if (arg === '--help' || arg === '-h') { printToolHelp(tool); return; }

  // Parse JSON
  let parsed: Record<string, unknown> = {};
  if (arg) {
    try { parsed = JSON.parse(arg); }
    catch (e) {
      console.error(`JSON 解析失败: ${(e as Error).message}\n输入: ${arg}`);
      printToolHelp(tool);
      process.exit(1);
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

  // story_quick: create + advance DEV + dev_start（默认开 worktree）
  if (cmd === 'story_quick') {
    await run(() => {
      const result = handlers.story_quick(v.data);
      const storyIdMatch = result.match(/__storyId__=([\w-]+)/);
      if (!storyIdMatch) return result;
      const storyId = storyIdMatch[1];
      const noWorktree = (v.data as any).noWorktree;

      // advance to DEV
      let advResult: string;
      try { advResult = handlers.story_advance({ storyId, phase: 'DEV' }); }
      catch (e: any) { return `${result}\n推进 DEV 失败: ${e.message}`; }

      // dev_start（开 worktree）——已在 worktree 里时跳过，防止嵌套
      let alreadyInWorktree = false;
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
        alreadyInWorktree = branch.startsWith('story/') || branch.startsWith('worktree-');
      } catch {}

      if (alreadyInWorktree) {
        return `${result.replace(/__storyId__=.*/, '')}\n${advResult}\n→ 已在 worktree 中，跳过 dev_start（直接在当前目录开发）`;
      }

      if (!noWorktree) {
        try {
          const wtResult = handlers.dev_start({ storyId });
          return `${result.replace(/__storyId__=.*/, '')}\n${advResult}\n${wtResult}`;
        } catch (e: any) {
          return `${result.replace(/__storyId__=.*/, '')}\n${advResult}\nworktree 创建失败: ${e.message}（可用 noWorktree:true 跳过）`;
        }
      }
      return `${result.replace(/__storyId__=.*/, '')}\n${advResult}\n→ 已进入 DEV（无 worktree）`;
    });
    return;
  }

  const handler = handlers[cmd];
  if (!handler) { console.error(`handler not found: ${cmd}`); process.exit(1); }

  await run(() => Object.keys(tool.schema).length === 0 ? handler() : handler(v.data));
}

main().catch(e => { console.error(e); process.exit(1); });
