import type { HandlerContext } from './context.js';
import {
  managedAssetNextAction,
  renderManagedAssetCheck,
  runManagedAssetCheck,
  type ManagedAssetCheckOptions,
} from '../core/managed-assets.js';
import {
  renderRuntimeFootprintSummary,
  runRuntimeEnvironmentChecks,
} from '../core/runtime-environment-checks.js';

function renderLatticeManagedAssetCheck(result: ReturnType<typeof runManagedAssetCheck>): string {
  return renderManagedAssetCheck(result)
    .replace(/^Koala managed asset check:/m, 'Lattice managed asset check:')
    .replace(/\bkoala check\b/g, 'lattice check');
}

export function createCheckHandlers(ctx: HandlerContext) {
  return {
    check(args: ManagedAssetCheckOptions & { json?: boolean } = {}) {
      const runtime = runRuntimeEnvironmentChecks(ctx.root);
      const runtimeMode = runtime.runtimeMode;
      const result = runManagedAssetCheck(ctx.root, args);
      if (args.json) return { runtimeMode, ...result };
      const rendered = [
        renderRuntimeFootprintSummary(runtimeMode, managedAssetNextAction(result).replace(/\bkoala check\b/g, 'lattice check')),
        renderLatticeManagedAssetCheck(result),
      ].join('\n\n');
      if (!result.ok) throw new Error(rendered);
      return rendered;
    },
  };
}
