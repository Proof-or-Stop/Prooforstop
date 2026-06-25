export const CONTROL_PLANE_CAPABILITY_IDS = [
  'read-only-status-projection',
  'story-lane-statuses',
  'project-lane-statuses',
  'queue-classification',
  'structural-migration-plan',
] as const;

export type ControlPlaneCapabilityId = typeof CONTROL_PLANE_CAPABILITY_IDS[number];

export interface ControlPlaneCapability {
  readonly id: ControlPlaneCapabilityId;
  readonly status: 'available' | 'planned';
  readonly description: string;
}

export interface ControlPlaneCapabilities {
  readonly readOnlyStatusProjection: true;
  readonly commandRegistration: false;
  readonly lifecycleGateMutation: false;
  readonly evidenceWrites: false;
  readonly authorityProductionSemantics: false;
  readonly proofM7Enforcement: false;
  readonly queueCleanupEnforcement: false;
  readonly tierCCleanup: false;
  readonly capabilities: readonly ControlPlaneCapability[];
}

export const DEFAULT_CONTROL_PLANE_CAPABILITIES: ControlPlaneCapabilities = {
  readOnlyStatusProjection: true,
  commandRegistration: false,
  lifecycleGateMutation: false,
  evidenceWrites: false,
  authorityProductionSemantics: false,
  proofM7Enforcement: false,
  queueCleanupEnforcement: false,
  tierCCleanup: false,
  capabilities: [
    {
      id: 'read-only-status-projection',
      status: 'planned',
      description: 'Expose lifecycle-control status shapes without registering commands or mutating gates.',
    },
    {
      id: 'story-lane-statuses',
      status: 'planned',
      description: 'Represent story-scoped lifecycle lanes as read-only projection data.',
    },
    {
      id: 'project-lane-statuses',
      status: 'planned',
      description: 'Represent project-level control-plane status as read-only projection data.',
    },
    {
      id: 'queue-classification',
      status: 'planned',
      description: 'Classify queues for visibility without cleanup enforcement.',
    },
    {
      id: 'structural-migration-plan',
      status: 'available',
      description: 'Keep the five-milestone structural migration plan in source.',
    },
  ],
} as const;

export const LIFECYCLE_CONTROL_LANES = [
  'intake',
  'plan',
  'dev',
  'review',
  'test',
  'done',
  'authority',
] as const;

export type LifecycleControlLane = typeof LIFECYCLE_CONTROL_LANES[number];

export const LIFECYCLE_CONTROL_LANE_STATES = [
  'not-started',
  'observed',
  'ready',
  'blocked',
  'complete',
  'not-applicable',
] as const;

export type LifecycleControlLaneState = typeof LIFECYCLE_CONTROL_LANE_STATES[number];

export interface LifecycleControlLaneStatus {
  readonly lane: LifecycleControlLane;
  readonly state: LifecycleControlLaneState;
  readonly reason?: string;
  readonly source?: 'legacy-lifecycle' | 'control-plane-projection' | 'authority-projection';
}

export const CONTROL_QUEUE_CLASSIFICATIONS = [
  'none',
  'ready',
  'waiting-on-story',
  'waiting-on-review',
  'waiting-on-test',
  'blocked',
  'external',
  'cleanup-deferred',
] as const;

export type ControlQueueClassification = typeof CONTROL_QUEUE_CLASSIFICATIONS[number];

export interface ControlQueueStatus {
  readonly classification: ControlQueueClassification;
  readonly size?: number;
  readonly reason?: string;
}

export interface StoryControlStatus {
  readonly storyId: string;
  readonly phase?: string;
  readonly title?: string;
  readonly capabilities: ControlPlaneCapabilities;
  readonly lanes: readonly LifecycleControlLaneStatus[];
  readonly queue: ControlQueueStatus;
  readonly cp2Projection?: {
    readonly source: 'legacy-story-state';
    readonly projectedAt?: string;
  };
}

export interface ProjectControlStatus {
  readonly projectRoot?: string;
  readonly capabilities: ControlPlaneCapabilities;
  readonly stories: readonly StoryControlStatus[];
  readonly lanes: readonly LifecycleControlLaneStatus[];
  readonly queues: readonly ControlQueueStatus[];
}
