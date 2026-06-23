/**
 * Registration entry point for @lattice/utils.
 * A bootstrap script calls register(registry, ctx) to inject all auxiliary
 * handlers into the main package's Registry.
 */
import type { Registry } from '../../main/dist/registry.js';
import type { HandlerContext } from '../../main/dist/handlers/context.js';
import { createAuxHandlers } from './handlers/auxiliary.js';
import { createAuxSyncHandlers } from './handlers/aux-sync.js';
import { createAuxTraceHandlers } from './handlers/aux-trace.js';
import { createAuxDiagnoseHandlers } from './handlers/aux-diagnose.js';
import { createAuxDocHandlers } from './handlers/aux-doc.js';
import { createTruthHandlers } from './handlers/truth.js';
import { createGapHandlers } from './handlers/gap.js';
import { createToolStatusHandlers } from './handlers/tool-status.js';

export function register(registry: Registry, ctx: HandlerContext): void {
  const registryAny = registry as Registry & { registerBatchMissing?: Registry['registerBatch'] };
  const registerBatch = registryAny.registerBatchMissing
    ? registryAny.registerBatchMissing.bind(registry)
    : registry.registerBatch.bind(registry);
  registry.registerBatch(createAuxHandlers(ctx));
  registerBatch(createAuxSyncHandlers(ctx));
  registerBatch(createAuxTraceHandlers(ctx));
  registerBatch(createAuxDiagnoseHandlers(ctx));
  registerBatch(createAuxDocHandlers(ctx));
  registerBatch(createTruthHandlers(ctx));
  registerBatch(createGapHandlers(ctx));
  registerBatch(createToolStatusHandlers(ctx));
}
