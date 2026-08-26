import type { HandlerContext } from '../handlers/context.js';
import type { Registry } from '../registry.js';
import type { ToolDef } from './main-tools.js';
import { setBrandEnv } from '../core/brand-env.js';
import { z } from 'zod';

const CANONICAL_LAB_PACKAGE = '@proof-or-stop/lab';

type LabModule = {
  register?: (registry: Pick<Registry, 'registerBatch'>, ctx: Pick<HandlerContext, 'root'>) => void;
  createLabToolDefs?: (zod: typeof z) => unknown;
};

export interface LabCliExtension {
  extraTools: ToolDef[];
  extraRegister: (registry: Registry, ctx: HandlerContext) => void;
}

/**
 * Load the published lab sibling through its canonical package specifier.
 *
 * The core bin must remain usable when the optional sibling is absent or
 * broken, so this is deliberately a dynamic, fail-closed extension load.
 * Repository-local bootstrap code has its own loader because it loads local
 * dist files; the published core bin must not depend on that repository path.
 */
export async function loadCanonicalLabEntrypoint(
  loadModule: () => Promise<unknown> = () => import(CANONICAL_LAB_PACKAGE),
): Promise<LabCliExtension | null> {
  try {
    const lab = (await loadModule()) as LabModule;
    if (typeof lab.register !== 'function' || typeof lab.createLabToolDefs !== 'function') {
      throw new Error(`${CANONICAL_LAB_PACKAGE} does not expose the required CLI registration API`);
    }

    const toolDefs = lab.createLabToolDefs(z);
    if (!Array.isArray(toolDefs)) {
      throw new Error(`${CANONICAL_LAB_PACKAGE} returned invalid CLI tool definitions`);
    }

    return {
      extraTools: toolDefs as ToolDef[],
      extraRegister: (registry, ctx) => lab.register!(registry, ctx),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setBrandEnv(process.env, 'LAB_IMPORT_ERROR', message);
    return null;
  }
}
