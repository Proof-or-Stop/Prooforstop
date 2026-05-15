/**
 * @task B-d339
 * @checklist CHK-003
 * @title lifecycle registry foundation
 * @type refactor
 * @priority high
 * @description
 *   Read-only lifecycle fact registry for phase order, transition events,
 *   rollback edges, gate ids, side effects, and renderer oracle rows.
 * @changes
 *   - [CHK-003] Centralize lifecycle phase and transition facts
 *   - [CHK-004] Expose registry projections for consistency contracts
 */
import type { StoryPhase } from './types.js';

export type LifecycleTransitionKind = 'forward' | 'rollback' | 'terminal';

export type LifecycleEventType =
  | 'INIT'
  | 'INIT_CHECK'
  | 'PLAN'
  | 'START'
  | 'REPLAN'
  | 'CODE_REVIEW'
  | 'REVIEW_PASS'
  | 'FINISH';

export interface LifecycleTransition {
  from: StoryPhase;
  to: StoryPhase;
  event: LifecycleEventType;
  kind: LifecycleTransitionKind;
  legacy?: boolean;
  gates: readonly string[];
  effects: readonly string[];
  oracleRows: readonly string[];
  rendererRow: string;
}

export const ACTIVE_LIFECYCLE_PHASES = [
  'IDEA',
  'INIT',
  'INIT_CHECK',
  'PLAN',
  'DEV',
  'REVIEW',
  'TEST',
  'DONE',
] as const satisfies readonly StoryPhase[];

export const COMMAND_LIFECYCLE_PHASES = [
  'INIT',
  'INIT_CHECK',
  'PLAN',
  'DEV',
  'REVIEW',
  'TEST',
  'DONE',
] as const satisfies readonly StoryPhase[];

export const LEGACY_LIFECYCLE_PHASES = [
  'TEST_CASE',
  'TEST_CASE_REVIEW',
] as const satisfies readonly StoryPhase[];

export const NON_ACTIVE_LIFECYCLE_PHASES = [
  'META',
  'DISCARDED',
] as const satisfies readonly StoryPhase[];

export const LIFECYCLE_PHASES = [
  ...ACTIVE_LIFECYCLE_PHASES,
  ...LEGACY_LIFECYCLE_PHASES,
  ...NON_ACTIVE_LIFECYCLE_PHASES,
] as const satisfies readonly StoryPhase[];

export const TERMINAL_LIFECYCLE_PHASES = [
  'DONE',
  'DISCARDED',
] as const satisfies readonly StoryPhase[];

export const LEGACY_LIFECYCLE_PHASE_ALIASES = {
  TEST_CASE: 'DEV',
  TEST_CASE_REVIEW: 'REVIEW',
} as const satisfies Partial<Record<StoryPhase, StoryPhase>>;

export const PHASE_EVENT_BY_TARGET = {
  INIT: 'INIT',
  INIT_CHECK: 'INIT_CHECK',
  PLAN: 'PLAN',
  DEV: 'START',
  REVIEW: 'CODE_REVIEW',
  TEST: 'REVIEW_PASS',
  DONE: 'FINISH',
} as const satisfies Partial<Record<StoryPhase, LifecycleEventType>>;

export const CWD_GATED_LIFECYCLE_PHASES = [
  'PLAN',
  'DEV',
  'REVIEW',
  'TEST',
] as const satisfies readonly StoryPhase[];

export const LIFECYCLE_TRANSITIONS = [
  {
    from: 'IDEA',
    to: 'INIT',
    event: 'INIT',
    kind: 'forward',
    gates: [],
    effects: ['story-envelope-created'],
    oracleRows: [],
    rendererRow: 'story.phase=INIT',
  },
  {
    from: 'IDEA',
    to: 'PLAN',
    event: 'PLAN',
    kind: 'forward',
    legacy: true,
    gates: [],
    effects: ['legacy-direct-plan'],
    oracleRows: [],
    rendererRow: 'legacy story.phase=PLAN',
  },
  {
    from: 'INIT',
    to: 'INIT_CHECK',
    event: 'INIT_CHECK',
    kind: 'forward',
    gates: ['init-check'],
    effects: ['story-worktree-create'],
    oracleRows: ['init-check'],
    rendererRow: 'INIT_CHECK gate',
  },
  {
    from: 'INIT_CHECK',
    to: 'PLAN',
    event: 'PLAN',
    kind: 'forward',
    gates: ['cwd-worktree'],
    effects: [],
    oracleRows: [],
    rendererRow: 'PLAN entry',
  },
  {
    from: 'INIT_CHECK',
    to: 'DEV',
    event: 'START',
    kind: 'forward',
    gates: ['quick-path'],
    effects: [],
    oracleRows: [],
    rendererRow: 'quick-path DEV entry',
  },
  {
    from: 'PLAN',
    to: 'DEV',
    event: 'START',
    kind: 'forward',
    gates: ['plan-review', 'scope-check', 'cwd-worktree'],
    effects: [],
    oracleRows: ['plan-review', 'scope-check'],
    rendererRow: 'PLAN->DEV gate',
  },
  {
    from: 'DEV',
    to: 'REVIEW',
    event: 'CODE_REVIEW',
    kind: 'forward',
    gates: ['git-clean', 'checklist-done', 'verification-evidence'],
    effects: ['review-round-start'],
    oracleRows: ['verification-coverage'],
    rendererRow: 'DEV->REVIEW gate',
  },
  {
    from: 'DEV',
    to: 'PLAN',
    event: 'REPLAN',
    kind: 'rollback',
    gates: ['cwd-worktree'],
    effects: [],
    oracleRows: [],
    rendererRow: 'DEV rollback to PLAN',
  },
  {
    from: 'REVIEW',
    to: 'TEST',
    event: 'REVIEW_PASS',
    kind: 'forward',
    gates: ['reviewer-pass', 'review-cli-preflight', 'koala-validate'],
    effects: ['test-evidence-write'],
    oracleRows: ['reviewer-evidence', 'validation-status'],
    rendererRow: 'REVIEW->TEST gate',
  },
  {
    from: 'REVIEW',
    to: 'DEV',
    event: 'START',
    kind: 'rollback',
    gates: ['cwd-worktree'],
    effects: [],
    oracleRows: [],
    rendererRow: 'REVIEW rollback to DEV',
  },
  {
    from: 'TEST',
    to: 'DONE',
    event: 'FINISH',
    kind: 'terminal',
    gates: ['done-final-checklist'],
    effects: ['merge-main', 'worktree-cleanup'],
    oracleRows: ['validation-status', 'bug-status', 'delivery-check', 'story-summary', 'git-working-tree'],
    rendererRow: 'DONE Final Checklist',
  },
  {
    from: 'TEST',
    to: 'DEV',
    event: 'START',
    kind: 'rollback',
    gates: ['cwd-worktree'],
    effects: [],
    oracleRows: [],
    rendererRow: 'TEST rollback to DEV',
  },
  {
    from: 'TEST_CASE',
    to: 'TEST_CASE_REVIEW',
    event: 'CODE_REVIEW',
    kind: 'forward',
    legacy: true,
    gates: ['legacy-fixture-review'],
    effects: [],
    oracleRows: [],
    rendererRow: 'legacy TEST_CASE_REVIEW',
  },
  {
    from: 'TEST_CASE',
    to: 'DEV',
    event: 'START',
    kind: 'rollback',
    legacy: true,
    gates: [],
    effects: [],
    oracleRows: [],
    rendererRow: 'legacy TEST_CASE rollback',
  },
  {
    from: 'TEST_CASE_REVIEW',
    to: 'TEST',
    event: 'REVIEW_PASS',
    kind: 'forward',
    legacy: true,
    gates: ['legacy-fixture-review'],
    effects: [],
    oracleRows: [],
    rendererRow: 'legacy TEST entry',
  },
  {
    from: 'TEST_CASE_REVIEW',
    to: 'DEV',
    event: 'START',
    kind: 'rollback',
    legacy: true,
    gates: [],
    effects: [],
    oracleRows: [],
    rendererRow: 'legacy TEST_CASE_REVIEW rollback to DEV',
  },
  {
    from: 'TEST_CASE_REVIEW',
    to: 'TEST_CASE',
    event: 'REPLAN',
    kind: 'rollback',
    legacy: true,
    gates: [],
    effects: [],
    oracleRows: [],
    rendererRow: 'legacy TEST_CASE_REVIEW rollback to TEST_CASE',
  },
] as const satisfies readonly LifecycleTransition[];

export function lifecycleTransitionKey(from: StoryPhase, to: StoryPhase): string {
  return `${from}->${to}`;
}

export function isLifecyclePhase(value: string): value is StoryPhase {
  return (LIFECYCLE_PHASES as readonly string[]).includes(value);
}

export function normalizeLifecyclePhase(phase: string): StoryPhase {
  const alias = LEGACY_LIFECYCLE_PHASE_ALIASES[phase as keyof typeof LEGACY_LIFECYCLE_PHASE_ALIASES];
  if (alias) return alias;
  if (isLifecyclePhase(phase)) return phase;
  return phase as StoryPhase;
}

export function lifecyclePhaseOrder(): readonly StoryPhase[] {
  return LIFECYCLE_PHASES;
}

export function lifecycleForwardTransitionsByPhase(): Record<StoryPhase, StoryPhase[]> {
  const transitions = Object.fromEntries(
    LIFECYCLE_PHASES.map(phase => [phase, [] as StoryPhase[]]),
  ) as Record<StoryPhase, StoryPhase[]>;
  for (const transition of LIFECYCLE_TRANSITIONS) {
    transitions[transition.from].push(transition.to);
  }
  return transitions;
}

export function lifecycleRollbackTransitionKeys(): Set<string> {
  return new Set(
    LIFECYCLE_TRANSITIONS
      .filter(transition => transition.kind === 'rollback')
      .map(transition => lifecycleTransitionKey(transition.from, transition.to)),
  );
}

export function findLifecycleTransition(from: StoryPhase, to: StoryPhase): LifecycleTransition | undefined {
  return LIFECYCLE_TRANSITIONS.find(transition => transition.from === from && transition.to === to);
}
