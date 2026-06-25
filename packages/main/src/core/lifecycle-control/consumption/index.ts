/**
 * Consumption namespace for CP-2 Consumption Closure Projection.
 *
 * This path exposes status shapes only; it is not a second waterline
 * implementation and it does not consume or produce gate evidence.
 */

export * from '../control-status.js';
export { buildStoryControlStatus, buildProjectControlStatus, isReadOnlyControlPlane } from '../global-control-service.js';
export type { BuildStoryControlStatusInput, BuildProjectControlStatusInput } from '../global-control-service.js';
