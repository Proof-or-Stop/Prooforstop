export interface LifecycleControlMigrationMilestone {
  /**
   * Migration milestone identifier.
   * CP-0 is the read-only canonical inventory baseline.
   */
  readonly id: 'CP-0' | 'CP-1' | 'CP-2' | 'CP-3' | 'CP-4' | 'CP-5';
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
    id: 'CP-0',
    title: 'Read-Only Control Plane Inventory',
    scope: [
      'Define a read-only report joining phase, authority, readiness, proof, and queue state.',
      'Keep lifecycle truth sourced from session, story, lock, and proof providers.',
      'Expose a stable baseline projection used by host handoff and review.',
    ],
    nonGoals: [
      'No lifecycle gate mutation.',
      'No queue cleanup enforcement.',
      'No Authority production semantics.',
    ],
  },
  {
    id: 'CP-1',
    title: 'Runtime Closure Automation',
    scope: [
      'Project worktree/runtime/gate-readiness facts from shipped runtime APIs.',
      'Preserve metadata compatibility by keeping legacy-shaped projection fields.',
      'Surface phase-mirror, lock, and freshness signals without changing gate decisions.',
    ],
    nonGoals: [
      'No CLI command registration.',
      'No lifecycle gate mutation.',
      'No evidence writes.',
    ],
  },
  {
    id: 'CP-2',
    title: 'Consumption Closure Projection',
    scope: [
      'Project admissibility consumer rows and waterline signals for story/project reporting.',
      'Keep projection read-only and consume, rather than own, proof policy.',
      'Keep projection side-effect free and evidence-neutral.',
    ],
    nonGoals: [
      'No Authority production semantics.',
      'No Proof M7 enforcement.',
    ],
  },
  {
    id: 'CP-3',
    title: 'Queue Governance And Exceptions',
    scope: [
      'Classify active stories for actionable queue health (worktree/mirror/exceptions/duplicates).',
      'Preserve existing command behavior and avoid hard cleanup outside queue governance rules.',
    ],
    nonGoals: [
      'No global lifecycle control execution.',
      'No queue cleanup enforcement.',
    ],
  },
  {
    id: 'CP-4',
    title: 'Unified Dashboard',
    scope: [
      'Assemble story-level and project-level control statuses.',
      'Show runtime + consumption + queue + readiness in one host-neutral report.',
    ],
    nonGoals: [
      'No DONE gate replacement.',
      'No automatic remediation.',
    ],
  },
  {
    id: 'CP-5',
    title: 'Runtime and Queue Enforcement Split',
    scope: [
      'Split enforcement-readiness tracks (runtime vs queue governance) while preserving warn-first rollout.',
      'Render Proof M7 and Authority-facing proof-consumer results without owning their enforcement.',
    ],
    nonGoals: [
      'No Proof M7 or Authority proof-consumer ownership.',
      'No Tier-C cleanup in the structural migration.',
    ],
    subtracks: [
      {
        id: 'CP-5A',
        title: 'Runtime Enforcement track',
        scope: [
          'Runtime enforcement covers wrong authoritative cwd, unsafe locks, dirty tree, and worktree/main misuse.',
          'Proof M7 and Authority-facing proof-consumer enforcement remain owned by Proof Admissibility and may only be rendered by the control plane.',
        ],
      },
      {
        id: 'CP-5B',
        title: 'Queue Governance Guard',
        scope: [
          'Queue cleanup enforcement remains separate from proof admissibility and Authority production semantics.',
        ],
      },
    ],
  },
] as const;
