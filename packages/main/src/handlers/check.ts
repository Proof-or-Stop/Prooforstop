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

function renderProofOrStopManagedAssetCheck(result: ReturnType<typeof runManagedAssetCheck>): string {
  // core renderManagedAssetCheck already emits Proof-or-Stop-branded output; no legacy rewrite needed.
  return renderManagedAssetCheck(result);
}

export function createCheckHandlers(ctx: HandlerContext) {
  return {
    check(args: ManagedAssetCheckOptions & { json?: boolean } = {}) {
      const runtime = runRuntimeEnvironmentChecks(ctx.root);
      const runtimeMode = runtime.runtimeMode;
      const result = runManagedAssetCheck(ctx.root, args);
      if (args.json) return { runtimeMode, ...result };
      const rendered = [
        renderRuntimeFootprintSummary(runtimeMode, managedAssetNextAction(result)),
        renderProofOrStopManagedAssetCheck(result),
      ].join('\n\n');
      if (!result.ok) throw new Error(rendered);
      return rendered;
    },
  };
}
