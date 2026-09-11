import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';

const roots = new AsyncLocalStorage<string>();
/** Bind trusted target resolution to both signing and verification, including awaits. */
export function withValidationSigningRoot<T>(root: string, run: () => T): T {
  if (typeof root !== 'string' || !root.trim()) throw new Error('VALIDATION_SIGNING_ROOT_REQUIRED');
  return roots.run(resolve(root), run);
}
/** Legacy direct callers retain cwd behavior; public target-aware entries bind a scope. */
export function resolveValidationSigningRoot(): string {
  return roots.getStore() ?? process.cwd();
}
