/**
 * @koala-agent/lab 的注册入口。
 */
import type { LabHandlerContext, LabRegistry } from './core/runtime-types.js';
import { createLabHandlers } from './handlers/lab.js';

export function register(registry: LabRegistry, ctx: LabHandlerContext): void {
  registry.registerBatch(createLabHandlers(ctx));
}
