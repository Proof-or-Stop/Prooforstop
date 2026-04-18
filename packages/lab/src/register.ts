/**
 * @koala-agent/lab 的注册入口。
 */
import type { Registry } from '../../main/dist/registry.js';
import type { HandlerContext } from '../../main/dist/handlers/context.js';
import { createLabHandlers } from './handlers/lab.js';

export function register(registry: Registry, ctx: HandlerContext): void {
  registry.registerBatch(createLabHandlers(ctx));
}
