/**
 * Compatibility entrypoint for evidence storage.
 *
 * Storage is still implemented by artifact-store.ts; this module only provides
 * the recommended source-structure import path.
 */

export * from '../artifact-store.js';
export type * from '../types.js';
