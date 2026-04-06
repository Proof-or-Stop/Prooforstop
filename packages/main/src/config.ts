
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
  /** test-runtime 入口文件路径（导出 createTestHandlers 函数） */
  testRuntime?: string;
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
}

/** 默认各阶段可用命令白名单 */
const DEFAULT_PHASE_TOOLS: Record<string, string[]> = {
  '*': [
    'story_get', 'story_list', 'story_discard',
    'task_scan', 'task_detail',
    'checklist_get',
    'truth_*', 'gap_*', 'convergence_check', 'arch_trace',
    'story_advance', // 任何阶段都可以推进（cwd 门禁负责保护）
    'doc_list', // 列文档供 PLAN 阶段挑 relatedDocs，任意阶段都能查
  ],
  INIT: [
    'story_update', 'checklist_update',
  ],
  INIT_CHECK: [
    'dev_start',
  ],
  PLAN: [
    'story_update', 'story_review',
    'checklist_add', 'checklist_update',
    'testintent_*',
  ],
  TEST_CASE: [
    'fixture_batch_add', 'fixture_get', 'fixture_update', 'fixture_migrate',
    'checklist_update',
  ],
  DEV: [
    'checklist_add', 'checklist_update',
    'task_annotate_batch', 'task_sync',
    'test_auto', 'test_story', 'test_fixture', 'diagnose',
    'fixture_batch_add', 'fixture_get', 'fixture_update', 'fixture_migrate',
    'story_advance',
  ],
  TEST_CASE_REVIEW: [
    'testintent_check', 'testintent_record',
    'fixture_get',
    'story_advance',
  ],
  TEST: [
    'test_auto', 'test_story', 'test_fixture', 'browser_test',
    'diagnose',
    'bug_report', 'bug_update', 'bug_list',
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
