// The maintenance command uses current source helpers without loading the Story
// engine or relying on stale dist. Requires Node 24+ (native TS stripping).
import * as nodeModule from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
if (typeof nodeModule.registerHooks !== 'function' || !process.features.typescript) {
  throw new Error('Lab requires native TypeScript stripping and synchronous module hooks (use Node 24+).');
}
const { LAB_MAINTENANCE_RUNTIME_REQUIREMENTS: requirements } = await import('../packages/main/src/core/runtime-fact-registry.ts');
if (!requirements.nativeTypeScript || !requirements.synchronousModuleHooks || requirements.execution !== 'checkout-source') {
  throw new Error('Unsupported Lab runtime requirements.');
}
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('.ts') && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(source))) return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  },
});
