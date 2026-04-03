
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync } from 'child_process';
import { StoryStore } from '../story/store.js';
import { createToolHandlers } from './tools.js';

// 检测是否在 git worktree 中运行，是则返回主工作目录，否则用 cwd
function resolveProjectRoot(): string {
  const cwd = process.cwd();
  try {
    // git rev-parse --git-common-dir 在 worktree 中返回主仓库的 .git 路径
    // 在主仓库中返回 ".git"
    const commonDir = execSync('git rev-parse --git-common-dir', { cwd, encoding: 'utf-8' }).trim();
    if (commonDir !== '.git' && !commonDir.endsWith('/.git') && !commonDir.endsWith('\\.git')) {
      // 在 worktree 中，取主工作目录
      const line = execSync('git worktree list --porcelain', { cwd, encoding: 'utf-8' })
        .split('\n')[0];
      return line?.replace('worktree ', '').trim() || cwd;
    }
  } catch { /* not a git repo, use cwd */ }
  return cwd;
}

const projectRoot = process.env.KOALA_PROJECT_ROOT || resolveProjectRoot();
const store = new StoryStore(projectRoot);

const server = new McpServer(
  { name: 'koala', version: '0.1.0' },
  { capabilities: { logging: {} } },
);

// 流式日志：通过 MCP logging notification 实时发送到 Claude Code
const mcpLog = (msg: string) => {
  server.server.sendLoggingMessage({ level: 'info', logger: 'koala', data: msg }).catch(() => {});
};

const handlers = createToolHandlers(store, projectRoot, mcpLog);

// ── Story 工具（5 个） ──

server.tool(
  'story_create',
  '创建 Story 条目（ID 自动生成，phase 可选：onboard 已完成模块直接设 DONE）',
  {
    name: z.string().describe('短名称/别名，如 auto-close-loop'),
    title: z.string().describe('Story 标题'),
    description: z.string().describe('Story 描述'),
    type: z.enum(['feature', 'bug', 'refactor', 'chore']).describe('Story 类型'),
    priority: z.string().describe('优先级'),
    source: z.string().optional().describe('来源（可选）'),
    depends: z.array(z.string()).optional().describe('依赖的 Story ID 列表（可选）'),
    checklist: z.array(z.object({
      title: z.string().describe('做什么（一句话）'),
      context: z.string().optional().describe('根因/参考方案，给执行 agent 提供上下文'),
    })).optional().describe('开发清单(可选,有则进入 PLAN,ID 自动生成)'),
    prefix: z.string().optional().describe('Story ID 前缀（默认 B，如 B-a3f7）'),
    phase: z.enum(['IDEA', 'PLAN', 'DEV', 'TEST', 'DONE']).optional().describe('直接指定阶段（onboard 用：已完成模块设 DONE，跳过门禁）'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.story_create(args) }],
  }),
);

server.tool(
  'story_advance',
  '推进 Story 生命周期到下一阶段',
  {
    storyId: z.string().describe('Story ID'),
    phase: z.enum(['IDEA', 'PLAN', 'DEV', 'TEST', 'DONE']).describe('目标阶段'),
    checklist: z.array(z.object({
      id: z.string().describe('Checklist 项 ID'),
      title: z.string().describe('功能点描述'),
    })).optional().describe('开发清单（IDEA→PLAN 时需要）'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.story_advance(args) }],
  }),
);

server.tool(
  'story_update',
  '编辑 Story 基本信息',
  {
    storyId: z.string().describe('Story ID'),
    title: z.string().optional().describe('新标题'),
    description: z.string().optional().describe('新描述'),
    priority: z.string().optional().describe('新优先级'),
    source: z.string().optional().describe('新来源'),
    depends: z.array(z.string()).optional().describe('新依赖列表'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.story_update(args) }],
  }),
);

server.tool(
  'story_get',
  '读取 Story 详情',
  {
    storyId: z.string().describe('Story ID'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(handlers.story_get(args), null, 2) }],
  }),
);

server.tool(
  'story_list',
  '列出全部 Story（支持 phase 过滤）',
  {
    phase: z.enum(['IDEA', 'PLAN', 'DEV', 'TEST', 'DONE']).optional().describe('按阶段过滤（可选）'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(handlers.story_list(args.phase ? { phase: args.phase } : undefined), null, 2) }],
  }),
);

// ── Checklist 工具（2 个） ──

server.tool(
  'checklist_get',
  '读取 checklist',
  {
    storyId: z.string().describe('Story ID'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(handlers.checklist_get(args), null, 2) }],
  }),
);

server.tool(
  'checklist_update',
  '更新 checklist 项状态（修改/删除需 reason）',
  {
    storyId: z.string().describe('Story ID'),
    itemId: z.string().describe('Checklist 项 ID'),
    status: z.enum(['pending', 'in_progress', 'done']).describe('新状态'),
    reason: z.string().optional().describe('变更原因（修改/删除时必填）'),
    agent: z.string().optional().describe('操作者/agent 标识'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.checklist_update(args) }],
  }),
);

// ── Bug 工具（3 个） ──

server.tool(
  'bug_report',
  '报告 bug',
  {
    storyId: z.string().describe('Story ID'),
    id: z.string().describe('Bug ID，如 BUG-001'),
    title: z.string().describe('Bug 描述'),
    checklistId: z.string().optional().describe('关联的 Checklist 项 ID（可选）'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.bug_report(args) }],
  }),
);

server.tool(
  'bug_update',
  '更新 bug 状态',
  {
    storyId: z.string().describe('Story ID'),
    id: z.string().describe('Bug ID'),
    status: z.enum(['open', 'fixed']).describe('新状态'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.bug_update(args) }],
  }),
);

server.tool(
  'bug_list',
  '查看 bug 列表',
  {
    storyId: z.string().describe('Story ID'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(handlers.bug_list(args), null, 2) }],
  }),
);

// ── Test 工具（2 个） ──

server.tool(
  'test_add',
  '记录测试证据',
  {
    storyId: z.string().describe('Story ID'),
    id: z.string().describe('测试证据 ID，如 TE-001'),
    scenario: z.string().describe('测试场景'),
    command: z.string().describe('执行的命令'),
    output: z.string().describe('完整终端输出'),
    expected: z.string().describe('预期结果'),
    result: z.enum(['PASS', 'FAIL']).describe('测试结果'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.test_add(args) }],
  }),
);

server.tool(
  'test_list',
  '查看测试证据',
  {
    storyId: z.string().describe('Story ID'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(handlers.test_list(args), null, 2) }],
  }),
);

// ── Task 分析工具（3 个） ──

server.tool(
  'task_scan',
  '扫描 @task 注释 + 校验合规性',
  {
    format: z.enum(['json', 'markdown']).optional().describe('输出格式，默认 json'),
    type: z.string().optional().describe('按类型筛选: feature|bugfix|refactor|chore'),
    priority: z.string().optional().describe('按优先级筛选: critical|high|medium|low'),
    version: z.string().optional().describe('按版本筛选'),
    id: z.string().optional().describe('按 task ID 筛选'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.task_scan(args) }],
  }),
);

server.tool(
  'task_coverage',
  'checklist 覆盖率检查（支持批量）',
  {
    storyId: z.union([z.string(), z.array(z.string())]).describe('Story ID，单个或数组'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(handlers.task_coverage(args), null, 2) }],
  }),
);

server.tool(
  'task_locate',
  '按 ID/关键词定位代码',
  {
    query: z.string().describe('checklist ID 或关键词'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(handlers.task_locate(args), null, 2) }],
  }),
);

// ── Flow 工具（2 个） ──

server.tool(
  'flow_trace',
  '查看某条业务流转链路的完整信息（步骤、函数、输入输出、校验）',
  {
    name: z.string().describe('Flow 链路名称'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.flow_trace(args) }],
  }),
);

server.tool(
  'flow_list',
  '列出所有业务流转链路概要',
  {},
  async () => ({
    content: [{ type: 'text' as const, text: handlers.flow_list() }],
  }),
);

// ── 自动测试工具（1 个） ──

server.tool(
  'test_auto',
  '自动执行白盒 fixture + flow e2e 测试',
  {
    storyId: z.string().optional().describe('Story ID(可选,不传则全项目测试,不写入测试证据)'),
    base: z.string().optional().describe('git diff 基准(默认 HEAD)'),
    full: z.boolean().optional().describe('全量模式:跑所有 fixture + 所有 flow e2e(默认只跑改动相关)'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: await handlers.test_auto(args) }],
  }),
);

// ── Fixture 工具（3 个） ──

server.tool(
  'fixture_get',
  '读取 fixture cases',
  {
    fixturePath: z.string().describe('fixture 路径(相对 fixturesDir,不含 .json)'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(handlers.fixture_get(args), null, 2) }],
  }),
);

server.tool(
  'fixture_update',
  '增删改 fixture case',
  {
    fixturePath: z.string().describe('fixture 路径'),
    action: z.enum(['add', 'update', 'delete']).describe('操作类型'),
    case: z.object({
      name: z.string().describe('case 名称'),
      input: z.any().optional().describe('输入参数'),
      expect: z.any().optional().describe('期望输出(与 throws 二选一)'),
      throws: z.string().optional().describe('期望错误消息片段'),
      fn: z.string().optional().describe('目标函数名(共享 fixture 时必填)'),
    }).describe('case 数据'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.fixture_update(args) }],
  }),
);

server.tool(
  'fixture_gen',
  '根据函数签名自动生成基础 fixture cases',
  {
    fixturePath: z.string().describe('fixture 路径'),
    functionName: z.string().optional().describe('目标函数名(可选)'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.fixture_gen(args) }],
  }),
);

// ── 注释管理工具（1 个） ──

server.tool(
  'task_annotate',
  '给函数添加/更新 @task 注释块（TypeScript AST 精确定位）',
  {
    sourceFile: z.string().describe('源文件路径(相对 scanRoot)'),
    functionName: z.string().describe('目标函数名'),
    projectRoot: z.string().optional().describe('项目根目录(worktree/子项目用,默认 cwd)'),
    lineHint: z.number().optional().describe('行号提示(同名函数消歧用)'),
    action: z.enum(['add', 'update']).optional().describe('操作类型(默认 add)'),
    task: z.string().describe('Story ID'),
    checklist: z.string().describe('Checklist ID'),
    title: z.string().describe('任务标题'),
    type: z.string().describe('类型: feature/bugfix/refactor/chore'),
    priority: z.string().describe('优先级: critical/high/medium/low'),
    description: z.string().describe('描述'),
    changes: z.array(z.string()).describe('变更列表'),
    test: z.string().optional().describe('@test fixture 路径'),
    flow: z.string().optional().describe('@flow 链路名称'),
    step: z.number().optional().describe('@step 步骤序号'),
    input: z.string().optional().describe('@input 输入格式'),
    output: z.string().optional().describe('@output 输出格式'),
    next: z.string().optional().describe('@next 下一步函数名'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.task_annotate(args) }],
  }),
);

server.tool(
  'task_sync',
  '元数据同步：extract/clean/validate/status',
  {
    direction: z.enum(['extract', 'clean', 'generate', 'validate', 'status']).describe('操作方向'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.task_sync(args) }],
  }),
);

// ── 浏览器测试工具（1 个） ──

server.tool(
  'browser_test',
  '浏览器真机测试：启动 dev server + 代理注入 + 执行 browser fixture cases',
  {
    projectRoot: z.string().optional().describe('项目根目录(默认 cwd)'),
    fixture: z.string().optional().describe('指定 fixture 文件路径(不传则扫描所有 browser case)'),
  },
  async (args) => {
    const { executeBrowserCases } = await import('../tasks/browser-executor.js');
    const { loadConfig } = await import('../config.js');
    const { readFileSync, readdirSync, existsSync } = await import('fs');
    const { join } = await import('path');

    const root = args.projectRoot || process.cwd();
    // 直接读项目的 koala.config.json，不用 loadConfig 缓存
    const configPath = join(root, 'koala.config.json');
    let config: any = {};
    if (existsSync(configPath)) {
      try { config = JSON.parse(readFileSync(configPath, 'utf-8')); } catch {}
    }

    if (!config.browser?.devCommand) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: '未配置 browser.devCommand' }) }] };
    }

    // 收集 browser cases
    const browserCases: Array<{ name: string; steps: any[] }> = [];
    const fixturesDir = join(root, config.fixturesDir);

    if (args.fixture) {
      const f = JSON.parse(readFileSync(join(fixturesDir, args.fixture + '.json'), 'utf-8'));
      for (const c of f.cases || []) {
        if (c.browser && c.steps) browserCases.push({ name: c.name, steps: c.steps });
      }
    } else if (existsSync(fixturesDir)) {
      const scanDir = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) { scanDir(join(dir, entry.name)); continue; }
          if (!entry.name.endsWith('.json')) continue;
          try {
            const f = JSON.parse(readFileSync(join(dir, entry.name), 'utf-8'));
            for (const c of f.cases || []) {
              if (c.browser && c.steps) browserCases.push({ name: c.name, steps: c.steps });
            }
          } catch { /* ignore */ }
        }
      };
      scanDir(fixturesDir);
    }

    if (browserCases.length === 0) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: '没有找到 browser case' }) }] };
    }

    const { cases: browserResults, trace, coveredFunctions } = await executeBrowserCases({
      devCommand: config.browser.devCommand,
      projectRoot: root,
    }, browserCases);

    const summary = {
      total: browserResults.length,
      passed: browserResults.filter(r => r.passed).length,
      failed: browserResults.filter(r => !r.passed).length,
      trace: { calls: trace.length, coveredFunctions },
      results: browserResults.map(r => ({
        name: r.name,
        passed: r.passed,
        durationMs: r.durationMs,
        ...(r.passed ? {} : { failedStep: r.steps.find(s => !s.passed) }),
        screenshots: r.screenshotPaths,
      })),
    };

    return { content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }] };
  },
);

// ── 真相源工具（4 个） ──

server.tool(
  'truth_scan',
  '扫描真相源目录，提取需求点/决策/约束/问题（summary=true 只返回统计）',
  {
    summary: z.boolean().optional().describe('摘要模式：只返回文件列表和统计，不返回全部内容'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.truth_scan(args) }],
  }),
);

server.tool(
  'truth_nav',
  '生成/更新真相源 NAV.md 导航索引',
  {},
  async () => ({
    content: [{ type: 'text' as const, text: handlers.truth_nav() }],
  }),
);

server.tool(
  'truth_analyze',
  '分析真相源中的矛盾/模糊/缺失',
  {},
  async () => ({
    content: [{ type: 'text' as const, text: handlers.truth_analyze() }],
  }),
);

server.tool(
  'truth_to_story',
  '从需求自动拆解成 Story 建议',
  {},
  async () => ({
    content: [{ type: 'text' as const, text: handlers.truth_to_story() }],
  }),
);

// ── 差距分析工具（2 个） ──

server.tool(
  'gap_analyze',
  '对比真相源 vs 代码现实，输出差距报告',
  {},
  async () => ({
    content: [{ type: 'text' as const, text: handlers.gap_analyze() }],
  }),
);

server.tool(
  'convergence_check',
  '判断项目是否收敛（需求覆盖、测试通过、无差距）',
  {},
  async () => ({
    content: [{ type: 'text' as const, text: handlers.convergence_check() }],
  }),
);

// ── Worktree 开发工具（3 个） ──

server.tool(
  'dev_start',
  '为 Story 创建 git worktree 开发环境(自动创建分支、worktree 目录,PLAN 自动推进到 DEV)',
  {
    storyId: z.string().describe('Story ID'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.dev_start(args) }],
  }),
);

server.tool(
  'dev_finish',
  '标记 Story 开发完成,推进到 TEST(worktree 保留供测试使用)',
  {
    storyId: z.string().describe('Story ID'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.dev_finish(args) }],
  }),
);

server.tool(
  'dev_merge',
  '测试全部通过后合并 worktree 分支回主分支,清理 worktree,推进到 DONE',
  {
    storyId: z.string().describe('Story ID'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: handlers.dev_merge(args) }],
  }),
);

// ── 启动 ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
