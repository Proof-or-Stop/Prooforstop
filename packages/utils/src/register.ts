/**
 * @koala-agent/utils 的注册入口。
 * Bootstrap 脚本调用 register(registry, ctx) 把所有辅助 handler 注入 main 的 Registry。
 */
import type { Registry } from '../../main/dist/registry.js';
import type { HandlerContext } from '../../main/dist/handlers/context.js';
import { createAuxHandlers } from './handlers/auxiliary.js';
import { createAuxSyncHandlers } from './handlers/aux-sync.js';
import { createAuxTraceHandlers } from './handlers/aux-trace.js';
import { createAuxDiagnoseHandlers } from './handlers/aux-diagnose.js';
import { createAuxDocHandlers } from './handlers/aux-doc.js';
import { createToolStatusHandlers } from './handlers/tool-status.js';

export function register(registry: Registry, ctx: HandlerContext): void {
  registry.registerBatch(createAuxHandlers(ctx));
  registry.registerBatch(createAuxSyncHandlers(ctx));
  registry.registerBatch(createAuxTraceHandlers(ctx));
  registry.registerBatch(createAuxDiagnoseHandlers(ctx));
  registry.registerBatch(createAuxDocHandlers(ctx));
  registry.registerBatch(createToolStatusHandlers(ctx));
}
