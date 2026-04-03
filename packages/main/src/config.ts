
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface KoalaFlowConfig {
  defaults: Record<string, Record<string, unknown>>;
  patterns: Array<{ field: string; regex: string }>;
}

export interface KoalaConfig {
  scanRoot: string;
  /** 编译输出目录（默认和 scanRoot 相同，TS 项目设为 dist） */
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
}

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
};

const _cache = new Map<string, KoalaConfig>();

export function loadConfig(projectRoot?: string): KoalaConfig {
  const root = projectRoot || process.env.KOALA_PROJECT_ROOT || process.cwd();
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
