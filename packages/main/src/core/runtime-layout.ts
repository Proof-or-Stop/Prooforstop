/**
 * Single source for "where is this installation": the compiled runtime root
 * (`<packageRoot>/dist`) and the core package root (`<packageRoot>`).
 *
 * Modules used to derive these from their own `import.meta.url` with a fixed
 * number of `..` segments. That is correct only while every module runs from
 * its own per-file tsc output (`dist/core/x.js` is two levels below the package
 * root, `dist/handlers/y.js` two, `dist/cli-engine.js` one). Inside an esbuild
 * bundle every module shares the bundle file's `import.meta.url`, so each fixed
 * depth pointed at a different wrong directory (for example `templates/agents`
 * resolved above the package and the prompt registry saw 0 agents).
 *
 * This module is a leaf (node built-ins only). Unbundled it lives at
 * `dist/core/runtime-layout.js` (or `src/core/runtime-layout.ts` when run from
 * source), so the runtime root is its parent directory: exactly the value every
 * former `../..`/`..` lookup produced. The CLI bundle is emitted into the dist
 * root and defines `__PROOF_OR_STOP_BUNDLED__`, so there the runtime root is the
 * bundle's own directory. No filesystem probing is involved in either case.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

declare const __PROOF_OR_STOP_BUNDLED__: boolean | undefined;

/** True only inside the esbuild CLI bundle (`dist/cli-direct.bundle.mjs`). */
export function isBundledRuntime(): boolean {
  return typeof __PROOF_OR_STOP_BUNDLED__ !== 'undefined' && __PROOF_OR_STOP_BUNDLED__ === true;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = isBundledRuntime() ? moduleDirectory : join(moduleDirectory, '..');

/** `<packageRoot>/dist` (or `<packageRoot>/src` when running from source). */
export function runtimeDistRoot(): string {
  return runtimeRoot;
}

/** The `@proof-or-stop/core` package root (holds package.json and templates/). */
export function runtimePackageRoot(): string {
  return join(runtimeRoot, '..');
}

/** Absolute path of a per-file runtime module, e.g. `runtimeDistPath('cli', 'managed-host-run-supervisor.js')`. */
export function runtimeDistPath(...segments: string[]): string {
  return join(runtimeRoot, ...segments);
}

/** File URL of a per-file runtime module (same resolution as {@link runtimeDistPath}). */
export function runtimeDistUrl(...segments: string[]): URL {
  return pathToFileURL(runtimeDistPath(...segments));
}
