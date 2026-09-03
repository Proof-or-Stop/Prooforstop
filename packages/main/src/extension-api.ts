/** Public contract used by optional Proof-or-Stop CLI extension packages. */
export { runCli } from './cli-engine.js';
export { Registry } from './registry.js';
export type { HandlerContext } from './handlers/context.js';
export type { ProofOrStopExtensionRuntime } from './core/extension-runtime.js';
export type { ToolDef } from './cli/main-tools.js';
export type { CoverageResult, LocateResult } from './tasks/types.js';
export type { ProfileNode } from './tasks/profiler.js';
export type { TraceDiffResult } from './tasks/trace-diff.js';
