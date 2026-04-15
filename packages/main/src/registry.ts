/**
 * @task B-6fda
 * @checklist CHK-001
 * @title registry exposes the automated interface for humans and AI
 * @type feature
 * @priority high
 * @description
 *   框架的核心不是让人或 AI 直接操作源码，而是通过统一的自动化接口管理代码：
 *   createMainRegistry / createToolHandlers 把 story、checklist、fixture、truth、gap
 *   等能力收敛成同一个 handler registry。代码仓库因此是原生高效适配 AI、可解释、
 *   可追述的；人和 AI 都通过这层接口访问项目状态和业务逻辑。
 * @changes
 *   - [CHK-001] 用统一 registry 暴露自动化接口，覆盖“代码被自动化接口管理 / 人和 AI 通过接口操作代码”
 */
/**
 * Handler Registry — koala 的工具注册中心
 *
 * 设计目的：让 main 暴露一个清晰的注册接口，外部包（如 @koala-agent/utils）
 * 可以把自己的 handler 通过 registry.register / registerBatch 注入进来，
 * 而 main 自身完全不知道这些扩展包的存在。
 *
 * main 的 cli.ts 启动时会调用 createMainRegistry(ctx) 完成内置 handler 的注册；
 * 第三方 bootstrap 脚本可以在此基础上再调用扩展包的 register 函数追加注册。
 */

import { StoryStore } from './core/store.js';
import { join } from 'path';
import { loadConfig } from './core/config.js';
import type { HandlerContext } from './handlers/context.js';
import { createStoryHandlers } from './handlers/story.js';
import { createChecklistHandlers } from './handlers/checklist.js';
import { createBugHandlers } from './handlers/bug.js';
import { createTestHandlers } from './handlers/test.js';
import { createTestAutoHandlers } from './handlers/test-auto.js';
import { createTestStoryHandlers } from './handlers/test-story.js';
import { createTestFixtureHandlers } from './handlers/test-fixture.js';
import { createWorktreeHandlers } from './handlers/worktree.js';
import { createFixtureHandlers } from './handlers/fixture.js';
import { createGapHandlers } from './handlers/gap.js';
import { createTruthHandlers } from './handlers/truth.js';
import { createUnderstandingHandlers } from './handlers/understanding.js';
import { createDecisionHandlers } from './handlers/decision.js';
import { createSummaryHandlers } from './handlers/summary.js';
import { createDoctorHandlers } from './handlers/doctor.js';
import { createSessionHandlers } from './handlers/session.js';
import { nextStoryId } from './handlers/context.js';

export type HandlerFn = (...args: any[]) => any;

/** 工具注册中心：name → handler 的映射 + 注入接口 */
export class Registry {
  private handlers = new Map<string, HandlerFn>();

  register(name: string, fn: HandlerFn): void {
    if (this.handlers.has(name)) {
      throw new Error(`Handler already registered: ${name}`);
    }
    this.handlers.set(name, fn);
  }

  registerBatch(map: Record<string, HandlerFn>): void {
    for (const [name, fn] of Object.entries(map)) this.register(name, fn);
  }

  /** 允许覆盖已存在的 handler（用于测试桩 / 替换内置实现） */
  override(name: string, fn: HandlerFn): void {
    this.handlers.set(name, fn);
  }

  get(name: string): HandlerFn | undefined { return this.handlers.get(name); }
  has(name: string): boolean { return this.handlers.has(name); }
  list(): string[] { return [...this.handlers.keys()]; }

  /** 平铺成对象，主要给 fixture runner 的 $handlers 注入用 */
  toObject(): Record<string, HandlerFn> {
    return Object.fromEntries(this.handlers);
  }
}

/**
 * 创建 main 内置的 Registry，只注册流程相关的 handler。
 *
 * 辅助工具（aux/truth/gap 等）已移到 @koala-agent/utils 包，
 * 由 bootstrap 脚本调用 utils 的 register() 函数追加注入。
 */
export function createMainRegistry(ctx: HandlerContext): Registry {
  const registry = new Registry();

  registry.registerBatch(createStoryHandlers(ctx));
  registry.registerBatch(createChecklistHandlers(ctx));
  registry.registerBatch(createBugHandlers(ctx));
  registry.registerBatch(createTestHandlers(ctx));
  registry.registerBatch(createTestAutoHandlers(ctx));
  registry.registerBatch(createTestStoryHandlers(ctx));
  registry.registerBatch(createTestFixtureHandlers(ctx));
  registry.registerBatch(createWorktreeHandlers(ctx));
  registry.registerBatch(createFixtureHandlers(ctx));
  registry.registerBatch(createGapHandlers(ctx));
  registry.registerBatch(createTruthHandlers(ctx));
  registry.registerBatch(createUnderstandingHandlers(ctx));
  registry.registerBatch(createDecisionHandlers(ctx));
  registry.registerBatch(createSummaryHandlers(ctx));
  registry.registerBatch(createDoctorHandlers(ctx));
  registry.registerBatch(createSessionHandlers(ctx));

  // 内部辅助：返回下一个 story id（fixture/测试 runner 用）
  registry.register('_nextStoryId', (prefix?: string) => nextStoryId(ctx.store, prefix));

  // 注入延迟获取器：让 story gate 能拿到完整工具名（避免循环依赖）
  ctx.getAllToolNames = () => new Set(registry.list());

  return registry;
}

/**
 * Legacy 入口：保留以兼容 fixture runner / test_auto / test-flow-e2e 等
 * 旧调用方使用平铺对象的 `$handlers.foo()` 模式。新代码请用 createMainRegistry。
 */
export function createToolHandlers(store: StoryStore, projectRoot?: string, log?: (msg: string) => void) {
  const root = projectRoot || process.env.KOALA_PROJECT_ROOT || process.cwd();
  const config = loadConfig(root);
  const scanRoot = join(root, config.scanRoot);
  const ctx: HandlerContext = { store, root, scanRoot, log };
  return createMainRegistry(ctx).toObject();
}
