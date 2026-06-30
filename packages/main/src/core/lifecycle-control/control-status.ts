export const CONTROL_PLANE_CAPABILITY_IDS = [
  'read-only-status-projection',
  'story-lane-statuses',
  'project-lane-statuses',
  'queue-classification',
  'runtime-closure-projection',
  'runtime-enforcement-rollout',
  'admissibility-waterline',
  'proof-m7-enforcement',
  'queue-exception-registry',
  'queue-cleanup-enforcement',
  'tier-c-cleanup',
  'structural-migration-plan',
] as const;

export type ControlPlaneCapabilityId = typeof CONTROL_PLANE_CAPABILITY_IDS[number];
export type ControlPlaneCapabilityStatus = 'implemented' | 'partial' | 'unavailable' | 'future';

export interface ControlPlaneCapability {
  readonly id: ControlPlaneCapabilityId;
  readonly status: ControlPlaneCapabilityStatus;
  readonly description: string;
  readonly evidence?: readonly string[];
}

export interface ControlPlaneCapabilities {
  readonly readOnlyStatusProjection: true;
  readonly commandRegistration: true;
  readonly lifecycleGateMutation: false;
  readonly evidenceWrites: false;
  readonly authorityProductionSemantics: false;
  readonly proofM7Enforcement: false;
  readonly queueCleanupEnforcement: false;
  readonly tierCCleanup: false;
  readonly capabilityStatus: {
    readonly proofM7Enforcement: ControlPlaneCapabilityStatus;
    readonly queueCleanupEnforcement: ControlPlaneCapabilityStatus;
    readonly tierCCleanup: ControlPlaneCapabilityStatus;
  };
  readonly capabilities: readonly ControlPlaneCapability[];
}

export const DEFAULT_CONTROL_PLANE_CAPABILITIES: ControlPlaneCapabilities = {
  readOnlyStatusProjection: true,
  commandRegistration: true,
  lifecycleGateMutation: false,
  evidenceWrites: false,
  authorityProductionSemantics: false,
  proofM7Enforcement: false,
  queueCleanupEnforcement: false,
  tierCCleanup: false,
  capabilityStatus: {
    proofM7Enforcement: 'partial',
    queueCleanupEnforcement: 'implemented',
    tierCCleanup: 'unavailable',
  },
  capabilities: [
    {
      id: 'read-only-status-projection',
      status: 'implemented',
      description: 'Expose lifecycle-control status shapes without mutating gates.',
    },
    {
      id: 'story-lane-statuses',
      status: 'implemented',
      description: 'Represent story-scoped lifecycle lanes as read-only projection data.',
    },
    {
      id: 'project-lane-statuses',
      status: 'implemented',
      description: 'Represent project-level control-plane status as read-only projection data.',
    },
    {
      id: 'queue-classification',
      status: 'implemented',
      description: 'Classify queues for visibility without cleanup enforcement.',
    },
    {
      id: 'runtime-closure-projection',
      status: 'implemented',
      description: 'Project runtime closure from existing authority, readiness, lock, and freshness surfaces.',
    },
    {
      id: 'runtime-enforcement-rollout',
      status: 'partial',
      description: 'Config-gated runtime hard blocks exist for phase-advance contexts while defaulting to warn mode.',
      evidence: [
        'lifecycleControl.runtimeEnforcement accepts warn/enforce/unavailable',
        'story_advance consumes runtime authority, dirty-state, and lock decisions',
      ],
    },
    {
      id: 'admissibility-waterline',
      status: 'partial',
      description: 'Render diagnostic-only Proof Admissibility consumer waterlines without granting readiness.',
      evidence: [
        'control plane consumes Proof Admissibility diagnostics',
        'waterline is diagnostic-only and cannot satisfy DONE',
      ],
    },
    {
      id: 'proof-m7-enforcement',
      status: 'partial',
      description: 'Proof M7 enforcement remains owned by Proof Admissibility; the control plane only reports its diagnostic/warn/enforce posture.',
      evidence: [
        'proofM7Enforcement boolean remains false in control-plane capabilities',
        'admissibility_waterline reports missing clauses but never mutates gate evidence',
      ],
    },
    {
      id: 'queue-exception-registry',
      status: 'implemented',
      description: 'Persist explicit experiment-batch queue exceptions with audit fields and preserve cleanup policy.',
    },
    {
      id: 'queue-cleanup-enforcement',
      status: 'implemented',
      description: 'Queue governance classifies duplicate/superseded cleanup risk and protects experiment exceptions, but cleanup mutation remains outside this read-only dashboard.',
      evidence: [
        'queueCleanupEnforcement boolean remains false',
        'duplicate and cleanup-required rows are surfaced as queue pressure only',
      ],
    },
    {
      id: 'tier-c-cleanup',
      status: 'unavailable',
      description: 'Tier-C provider-execution runs are preserved as experiment evidence; automated cleanup remains deliberately unavailable.',
      evidence: [
        'tierCCleanup boolean remains false',
        'experiment-batch-exception never grants lifecycle readiness',
      ],
    },
    {
      id: 'structural-migration-plan',
      status: 'implemented',
      description: 'Keep the six-milestone structural migration plan in source.',
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
  'active-worktree',
  'stale-worktree',
  'main-init',
  'experiment-batch-exception',
  'duplicate-candidate',
  'superseded',
  'cleanup-required',
] as const;

export type ControlQueueClassification = typeof CONTROL_QUEUE_CLASSIFICATIONS[number];

export interface ControlQueueStatus {
  readonly classification: ControlQueueClassification;
  readonly size?: number;
  readonly reason?: string;
  readonly exceptionId?: string;
  readonly experimentBatchId?: string;
  readonly cleanupPolicy?: 'preserve' | 'review-required' | 'cleanup-required';
}

export const CONTROL_PLANE_STATUS_LEVELS = [
  'green',
  'yellow',
  'red',
  'na',
  'unknown',
] as const;

export type ControlPlaneStatusLevel = typeof CONTROL_PLANE_STATUS_LEVELS[number];

export interface ControlPlaneSection {
  /**
   * Canonical projector status for this section.
   * green / yellow / red / na are explicit report states;
   * unknown means input sources are unavailable.
   */
  readonly status: ControlPlaneStatusLevel;

  /**
   * Human-readable reason produced by the upstream projector.
   */
  readonly reason?: string;

  /**
   * Safe next action string for UX tooling.
   */
  readonly nextSafeAction?: string;

  /**
   * Optional count of blockers in this projection section.
   */
  readonly blockerCount?: number;

  /**
   * Backward-compatible marker for old consumers.
   */
  readonly source?: 'legacy-projection' | 'runtime-projection' | 'proof-projection';
}

export interface LifecycleControlIssue {
  readonly check: string;
  readonly reason: string;
  readonly remediation?: string;
  readonly source?: string;
}

export interface RuntimeClosureRow {
  readonly lane: 'runtime';
  readonly storyId: string;
  readonly status: ControlPlaneStatusLevel;
  readonly authority: 'main' | 'worktree' | 'unknown';
  readonly authoritativeCwd: string;
  readonly phase: string;
  readonly mirrorPhase?: string;
  readonly source: 'runtime-projection';
  readonly nextSafeAction?: string;
  readonly blockingItems: readonly LifecycleControlIssue[];
  readonly advisoryItems: readonly LifecycleControlIssue[];
  readonly locks: {
    readonly ownerLease: 'owned' | 'foreign-active' | 'stale' | 'missing' | 'unknown';
    readonly mainWriteLock: 'free' | 'active' | 'stale' | 'unknown';
    readonly validationLock: 'free' | 'active' | 'stale' | 'self-reentry' | 'unknown';
  };
}

export interface RuntimeClosureReport {
  readonly schemaVersion: 'lattice.runtime_closure_status.v1';
  readonly readOnly: true;
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly source: 'runtime-projection';
  readonly stories: readonly RuntimeClosureRow[];
  readonly aggregate: ControlPlaneStatusLevel;
}

export interface AdmissibilityWaterlineRow {
  readonly consumer: string;
  readonly status: 'pass' | 'warn' | 'fail' | 'error' | 'stale' | 'legacy';
  readonly requiredClauses: readonly string[];
  readonly matchedClauses: readonly string[];
  readonly missingClauses: readonly string[];
  readonly staleRows: number;
  readonly legacyRows: number;
  readonly errorRows: number;
  readonly failRows: number;
  readonly topReasons: readonly string[];
  readonly diagnosticOnly: true;
  readonly productionDoneEligible: false;
  readonly source: 'proof-admissibility';
}

export interface AdmissibilityWaterlineReport {
  readonly schemaVersion: 'lattice.admissibility_waterline.v1';
  readonly readOnly: true;
  readonly diagnosticOnly: true;
  readonly generatedAt: string;
  readonly storyId?: string;
  readonly policyId: string;
  readonly rows: readonly AdmissibilityWaterlineRow[];
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly error: number;
    readonly stale: number;
    readonly legacy: number;
  };
  readonly note: 'diagnostic-only waterline; lifecycle gates remain authoritative elsewhere';
}

export interface QueueExceptionRecord {
  readonly exceptionId: string;
  readonly policyVersion: 'proofbound.queue_exception.v1';
  readonly class: 'experiment-batch-exception';
  readonly experimentBatchId: string;
  readonly storyIds: readonly string[];
  readonly source: 'explicit' | 'migration-title-prefix';
  readonly storyFilesHash: string;
  readonly dashboardMode: 'collapsed' | 'expanded';
  readonly cleanupPolicy: 'preserve';
  readonly actor: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface QueueGovernanceRow {
  readonly storyId: string;
  readonly title: string;
  readonly phase: string;
  readonly classification: ControlQueueClassification;
  readonly reason: string;
  readonly authoritativeCwd?: string;
  readonly experimentBatchId?: string;
  readonly exceptionId?: string;
  readonly exceptionSource?: QueueExceptionRecord['source'];
  readonly cleanupPolicy?: 'preserve' | 'review-required' | 'cleanup-required';
}

export interface QueueGovernanceReport {
  readonly schemaVersion: 'lattice.queue_governance_status.v1';
  readonly readOnly: true;
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly defaultDashboardMode: 'collapsed' | 'expanded';
  readonly rows: readonly QueueGovernanceRow[];
  readonly experimentBatches: readonly {
    readonly experimentBatchId: string;
    readonly defaultDashboardMode: 'collapsed' | 'expanded';
    readonly storyCount: number;
    readonly storyIds?: readonly string[];
  }[];
  readonly duplicateClusters: readonly {
    readonly clusterId: string;
    readonly canonicalStoryId: string;
    readonly duplicateStoryIds: readonly string[];
    readonly reason: string;
  }[];
  readonly cleanupRequired: readonly QueueGovernanceRow[];
  readonly summary: {
    readonly activeWorktree: number;
    readonly staleWorktree: number;
    readonly mainInit: number;
    readonly experimentBatchException: number;
    readonly duplicateCandidate: number;
    readonly superseded: number;
    readonly cleanupRequired: number;
  };
}

export interface QueueExceptionSetResult extends QueueExceptionRecord {
  readonly schemaVersion: 'lattice.queue_exception_set.v1';
  readonly written: true;
  readonly auditEvent: {
    readonly type: 'queue_exception_set';
    readonly storyIds: readonly string[];
    readonly timestamp: string;
  };
}

export interface StoryControlStatus {
  readonly storyId: string;
  readonly phase?: string;
  readonly title?: string;

  /**
   * Canonical sections (new contract).
   */
  readonly runtime: ControlPlaneSection;
  readonly consumption: ControlPlaneSection;
  readonly readiness: ControlPlaneSection;

  /**
   * Canonical queue summary.
   */
  readonly queue: ControlQueueStatus;

  /**
   * Compatibility fields are intentionally retained for existing projections.
   */
  readonly capabilities: ControlPlaneCapabilities;
  readonly lanes: readonly LifecycleControlLaneStatus[];
  readonly compatibilityProjection?: {
    readonly source: 'legacy-story-state';
    readonly projectedAt: string;
    readonly section: 'legacy-control-lane';
  };
  readonly cp2Projection?: {
    readonly source: 'legacy-story-state';
    readonly projectedAt?: string;
    readonly projectionKind?: 'consumption-closure';
  };
}

export interface ProjectControlStatus {
  readonly projectRoot?: string;
  /**
   * Canonical sections (project roll-up).
   */
  readonly runtime: ControlPlaneSection;
  readonly consumption: ControlPlaneSection;
  readonly readiness: ControlPlaneSection;
  readonly queueSummary: ControlQueueStatus;

  /**
   * Compatibility roll-up fields kept for older projections.
   */
  readonly capabilities: ControlPlaneCapabilities;
  readonly stories: readonly StoryControlStatus[];
  readonly lanes: readonly LifecycleControlLaneStatus[];
  readonly queues: readonly ControlQueueStatus[];
}
