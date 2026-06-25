/**
 * Queue namespace for read-only queue classification.
 *
 * Queue governance enforcement and cleanup are future CP-5B work, not part of
 * this compatibility skeleton.
 */

export {
  CONTROL_QUEUE_CLASSIFICATIONS,
  DEFAULT_CONTROL_PLANE_CAPABILITIES,
} from '../control-status.js';
export type {
  ControlQueueClassification,
  ControlQueueStatus,
} from '../control-status.js';
export { isReadOnlyControlPlane } from '../global-control-service.js';
