import type {
  HandlerContext,
  ProofOrStopExtensionRuntime,
} from '@proof-or-stop/core/extension-api';

export function requireCoreRuntime(ctx: HandlerContext): ProofOrStopExtensionRuntime {
  if (!ctx.extensionRuntime) {
    throw new Error('@proof-or-stop/utils requires a compatible @proof-or-stop/core extension runtime');
  }
  return ctx.extensionRuntime;
}
