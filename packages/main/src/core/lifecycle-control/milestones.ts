export interface LifecycleControlMigrationMilestone {
  readonly id: 'CP-1' | 'CP-2' | 'CP-3' | 'CP-4' | 'CP-5';
  readonly title: string;
  readonly scope: readonly string[];
  readonly nonGoals: readonly string[];
  readonly subtracks?: readonly LifecycleControlMigrationSubtrack[];
}

export interface LifecycleControlMigrationSubtrack {
  readonly id: 'CP-5A' | 'CP-5B';
  readonly title: string;
  readonly scope: readonly string[];
}

export const LIFECYCLE_CONTROL_MIGRATION_MILESTONES: readonly LifecycleControlMigrationMilestone[] = [
  {
    id: 'CP-1',
    title: 'Compatibility-first source structure',
    scope: [
      'Add evidence compatibility entrypoints.',
      'Add lifecycle-control read-only types and migration constants.',
      'Prove legacy and recommended imports share representative symbol identity.',
    ],
    nonGoals: [
      'No CLI command registration.',
      'No lifecycle gate mutation.',
      'No evidence writes.',
    ],
  },
  {
    id: 'CP-2',
    title: 'Read-only control status projection',
    scope: [
      'Project legacy story, lane, and queue state into StoryControlStatus and ProjectControlStatus.',
      'Keep projection side-effect free and evidence-neutral.',
    ],
    nonGoals: [
      'No Authority production semantics.',
      'No Proof M7 enforcement.',
    ],
  },
  {
    id: 'CP-3',
    title: 'Host-facing read-only surfacing',
    scope: [
      'Surface CP-2 status through an explicitly read-only host/API boundary.',
      'Preserve existing lifecycle command behavior.',
    ],
    nonGoals: [
      'No global lifecycle control execution.',
      'No queue cleanup enforcement.',
    ],
  },
  {
    id: 'CP-4',
    title: 'Control-plane readiness checks',
    scope: [
      'Add structural readiness diagnostics for missing projection inputs.',
      'Classify blockers without changing lifecycle transitions.',
    ],
    nonGoals: [
      'No DONE gate replacement.',
      'No automatic remediation.',
    ],
  },
  {
    id: 'CP-5',
    title: 'Separated enforcement tracks',
    scope: [
      'Split production-proof semantics from cleanup enforcement before any behavioral work.',
    ],
    nonGoals: [
      'No combined Authority/cleanup rollout.',
      'No Tier-C cleanup in the structural migration.',
    ],
    subtracks: [
      {
        id: 'CP-5A',
        title: 'Proof and Authority enforcement track',
        scope: [
          'Gate-consumed Proof M7 and Authority semantics are designed and reviewed separately.',
        ],
      },
      {
        id: 'CP-5B',
        title: 'Queue and cleanup enforcement track',
        scope: [
          'Queue cleanup enforcement remains separate from proof admissibility and Authority production semantics.',
        ],
      },
    ],
  },
] as const;
