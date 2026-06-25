/**
 * Compatibility entrypoint for evidence artifacts.
 *
 * Keep this as an adapter over the legacy artifact store and shared evidence
 * types. Do not define artifact schemas or registries here.
 */

export * from '../artifact-store.js';
export type * from '../types.js';
