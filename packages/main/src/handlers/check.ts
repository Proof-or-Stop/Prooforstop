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
import { isManagedGlobalThinRoot } from '../core/config.js';
import { resolveCanonicalRuntimeProjectRoot } from '../core/runtime-artifact-registry.js';

function renderProofOrStopManagedAssetCheck(result: ReturnType<typeof runManagedAssetCheck>): string {
  // core renderManagedAssetCheck already emits Proof-or-Stop-branded output; no legacy rewrite needed.
  return renderManagedAssetCheck(result);
}

export function createCheckHandlers(ctx: HandlerContext) {
  return {
    check(args: ManagedAssetCheckOptions & { json?: boolean } = {}) {
      const assetRoot = isManagedGlobalThinRoot(ctx.root)
        ? resolveCanonicalRuntimeProjectRoot(ctx.root)
        : ctx.root;
      const isStoryWorktree = assetRoot !== ctx.root;
      if (isStoryWorktree && (args.apply || args.upgrade)) {
        const flag = args.upgrade ? '--upgrade' : '--apply';
        throw new Error(
          `Cannot run proof-or-stop check ${flag} from a global-thin Story worktree.\n`
          + `Project-level managed assets belong to the primary controller and must not be written into Story scope.\n`
          + `→ Run: cd ${JSON.stringify(assetRoot)} && proof-or-stop check ${flag}`,
        );
      }
      const runtime = runRuntimeEnvironmentChecks(assetRoot);
      const runtimeMode = runtime.runtimeMode;
      const result = runManagedAssetCheck(assetRoot, args);
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
