
/**
 * @task B-6fda
 * @checklist CHK-001
 * @title phase tool policy makes the automation interface explicit
 * @type feature
 * @priority high
 * @description
 *   phaseTools / isCommandAllowed / getAllowedPatterns 把“谁可以在什么阶段通过
 *   自动化接口操作代码和项目状态”变成了可计算规则。这个入口层不是文档建议，
 *   而是真正限制人和 AI 通过统一接口访问 story、truth、gap、test 等能力的
 *   自动化边界。
 * @changes
 *   - [CHK-001] 用 phase tool policy 显式约束自动化接口边界，支撑可解释、可追述的 AI-first 仓库入口
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface KoalaFlowConfig {
  defaults: Record<string, Record<string, unknown>>;
  patterns: Array<{ field: string; regex: string }>;
}

export interface KoalaConfig {
  scanRoot: string;
  /** 源码子目录（相对 scanRoot，对应 tsconfig rootDir，默认和 scanRoot 相同） */
  rootDir?: string;
  /** 编译输出目录（相对项目根，TS 项目设为 dist 所在路径） */
  outDir?: string;
  testsDir: string;
  fixturesDir: string;
  storyDir: string;
  requirementsDir: string;
  storyPrefix: string;
  flows: KoalaFlowConfig;
  wrappersDir?: string;
  /** 项目语言：js（默认）或 python */
  language?: 'js' | 'python';
  /** CLI 测试配置 */
  cli?: {
    command: string;
  };
  /** 浏览器测试配置 */
  browser?: {
    /** dev server 启动命令（如 "npx vite"） */
    devCommand: string;
    /** WS bridge 端口（默认 9876） */
    wsPort?: number;
  };
  /** trace snapshot 最大保留份数（默认 5） */
  maxTraceSnapshots?: number;
  /** 各阶段可用命令白名单（key=阶段名，value=命令名数组，支持通配符 *） */
  phaseTools?: Record<string, string[]>;
  /** Story worktree 根目录（相对 git repo root，默认 .worktrees） */
  worktreeDir?: string;
  /** doc_list 扫描的文档目录（相对项目根，默认 ['docs', 'requirements']） */
  docDirs?: string[];
  /** stale-detector 阈值（分钟，缺失走 DEFAULT_STALE_THRESHOLDS） */
  staleThresholds?: {
    /** phase 没 advance 多久算卡死（默认 30） */
    phaseStale?: number;
    /** checklist item 卡 in_progress 多久算遗忘（默认 30） */
    itemStale?: number;
    /** 距离上次任意 koala 命令多久算 idle（默认 60） */
    idleKoala?: number;
    /** open bug 多久没修算超期（默认 1440=24h） */
    bugStale?: number;
  };
  /**
   * Lifecycle hooks — spawn shell commands at koala 命令的 4 个事件点。
   * 每个事件下用 commandName 或 "*" 通配匹配，value 是 shell 命令数组。
   * onPhaseChange 的 key 用 "FROM->TO" 格式（或 "*"）。
   *
   * 失败/超时不阻塞主命令，详见 core/hooks.ts 和 packages/koala/docs/guide-hooks.md。
   */
  hooks?: {
    preCommand?: Record<string, string[]>;
    postCommand?: Record<string, string[]>;
    onError?: Record<string, string[]>;
    onPhaseChange?: Record<string, string[]>;
  };
}

/** 默认各阶段可用命令白名单 */
const DEFAULT_PHASE_TOOLS: Record<string, string[]> = {
  '*': [
    'story_get', 'story_list', 'story_discard',
    'lab_*',
    'aux_*', // 全部辅助工具：scan/detail/coverage/locate/sync/trace/diagnose/doc_list
    'checklist_get',
    'testintent_handoff', // 只读交接包：任何阶段都可生成，避免 PLAN 门禁变死胡同
    'truth_*', 'gap_*', 'convergence_check',
    'story_advance', // 任何阶段都可以推进（cwd 门禁负责保护）
    'session_brief', // 全局：开场简报，任何阶段都可以查
    'doctor',        // 全局：health 巡检，任何阶段都可以查
    'summary_get',   // 全局：读取 summary，任何阶段都可以查
    'summary_set',   // 全局：DONE 前强制落总结，koala short-path story 也需要
    'implementation_review_result_get',
    'implementation_review_result_set',
  ],
  INIT: [
    'story_update', 'checklist_update',
  ],
  INIT_CHECK: [
    // story_advance 内部会代调 dev_start 创建 worktree，无需独立白名单
  ],
  PLAN: [
    'story_update', 'story_review', 'story_review_dismiss',
    'checklist_add', 'checklist_update',
    'testintent_*',
    'understanding_set', 'understanding_get',
    'decision_set', 'decision_get',
  ],
  TEST_CASE: [
    'fixture_batch_add', 'fixture_get', 'fixture_update',
    'checklist_update',
  ],
  DEV: [
    'checklist_add', 'checklist_update',
    'test_auto', 'test_story', 'test_fixture',
    'fixture_batch_add', 'fixture_get', 'fixture_update',
    'story_advance',
  ],
  TEST_CASE_REVIEW: [
    'testintent_check', 'testintent_record', 'testintent_resume',
    'fixture_get',
    // B-5010 CHK-003: reviewer 可以只读地跑 test_fixture / test_story 实际验证
    // fixture 是否通过，避免把运行时错误留到 TEST 阶段才发现。语义上是只读
    // （bug_report/bug_update 仍被阻止），只是多一条动态验证路径
    'test_fixture', 'test_story',
    'story_advance',
  ],
  TEST: [
    'test_auto', 'test_story', 'test_fixture',
    'bug_report', 'bug_update', 'bug_list', 'bug_analyze',
    'fixture_get',
    'story_advance',
  ],
};

const DEFAULT_CONFIG: KoalaConfig = {
  scanRoot: 'src',
  testsDir: 'tests',
  fixturesDir: 'tests/fixtures',
  storyDir: 'docs/story/actives',
  requirementsDir: 'docs/requirements',
  storyPrefix: 'B',
  flows: {
    defaults: {},
    patterns: [],
  },
  phaseTools: DEFAULT_PHASE_TOOLS,
};

const _cache = new Map<string, KoalaConfig>();

/** 从 cwd 向上查找 koala.config.json，返回项目根目录 */
function resolveProjectRoot(): string {
  if (process.env.KOALA_PROJECT_ROOT) return process.env.KOALA_PROJECT_ROOT;
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'koala.config.json'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function loadConfig(projectRoot?: string): KoalaConfig {
  // 有参数用参数，没参数从 cwd 向上查找
  const root = projectRoot || resolveProjectRoot();
  if (_cache.has(root)) return _cache.get(root)!;
  const configPath = join(root, 'koala.config.json');

  let userConfig: Partial<KoalaConfig> = {};
  if (existsSync(configPath)) {
    try {
      userConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch { /* ignore parse errors */ }
  }

  const _cached: KoalaConfig = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    flows: {
      ...DEFAULT_CONFIG.flows,
      ...(userConfig.flows || {}),
    },
  };

  _cache.set(root, _cached);
  return _cached;
}

/** 重置缓存（测试用） */
export function resetConfigCache(): void {
  _cache.clear();
}

/**
 * 判断命令是否在指定阶段的白名单中。
 * 支持通配符：'truth_*' 匹配 truth_scan / truth_extract 等。
 * '*' key 中的命令对所有阶段可用。
 */
export function isCommandAllowed(cmd: string, phase: string, phaseTools?: Record<string, string[]>): boolean {
  if (phaseTools !== undefined && (phaseTools === null || typeof phaseTools !== 'object' || Array.isArray(phaseTools))) return true; // 非对象降级全量放行
  const pt = phaseTools || DEFAULT_PHASE_TOOLS;
  const globalList = pt['*'] || [];
  const phaseList = pt[phase] || [];
  const all = [...globalList, ...phaseList].filter((p): p is string => typeof p === 'string');
  return all.some(pattern => {
    if (pattern.endsWith('*')) {
      return cmd.startsWith(pattern.slice(0, -1));
    }
    return cmd === pattern;
  });
}

/**
 * 获取指定阶段所有允许的命令模式列表。
 */
export function getAllowedPatterns(phase: string, phaseTools?: Record<string, string[]>): string[] {
  const pt = phaseTools || DEFAULT_PHASE_TOOLS;
  return [...(pt['*'] || []), ...(pt[phase] || [])];
}
