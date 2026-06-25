/**
 * Dashboard namespace for read-only control-plane display data.
 *
 * Dashboards can render these shapes, but this module performs no lifecycle
 * command registration, gate mutation, evidence write, or cleanup action.
 */

export * from '../control-status.js';
export { buildProjectControlStatus, buildStoryControlStatus, isReadOnlyControlPlane } from '../global-control-service.js';
