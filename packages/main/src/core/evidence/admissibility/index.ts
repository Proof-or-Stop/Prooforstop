/**
 * Compatibility entrypoint for proof admissibility.
 *
 * This file intentionally re-exports existing proof-admissibility modules
 * instead of copying registries, proof definitions, or gate helpers.
 */

export * from '../../proof-admissibility.js';
export * from '../../proof-admissibility-binding.js';
export * from '../../proof-admissibility-gates.js';
export * from '../../proof-admissibility-handoff.js';
export * from '../../proof-admissibility-legacy.js';
export * from '../../proof-admissibility-metadata.js';
export * from '../../claim-admissibility/pack-framework.js';
