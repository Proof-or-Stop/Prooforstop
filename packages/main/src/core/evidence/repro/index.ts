/**
 * Compatibility entrypoint for repro evidence workflows.
 *
 * The repro-first service remains in core/repro-intake.ts. This adapter keeps
 * new source layout imports pointed at the same functions and types.
 */

export * from '../../repro-intake.js';
export type * from '../types.js';
