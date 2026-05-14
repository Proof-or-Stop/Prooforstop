import type { HandlerContext } from './context.js';
import {
  renderManagedAssetCheck,
  runManagedAssetCheck,
  type ManagedAssetCheckOptions,
} from '../core/managed-assets.js';

export function createCheckHandlers(ctx: HandlerContext) {
  return {
    check(args: ManagedAssetCheckOptions & { json?: boolean } = {}) {
      const result = runManagedAssetCheck(ctx.root, args);
      if (args.json) return result;
      const rendered = renderManagedAssetCheck(result);
      if (!result.ok) throw new Error(rendered);
      return rendered;
    },
  };
}
