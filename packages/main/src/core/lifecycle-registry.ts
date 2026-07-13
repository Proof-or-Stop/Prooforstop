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
import { getCommandPolicyEntries, type CommandPhase } from './command-policy.js';

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

/**
 * The seven lifecycle phases in which lattice commands are gated. Mirrors
 * `CommandPhase` from command-policy.ts — these are the phases a command can
 * declare as `allowedPhases`. This is the single source of truth: the command
 * dimension (`lifecycleCommandsByPhase`) and the contract / smoke tasks all
 * consume this one constant, so a future phase add cannot diverge silently.
 */
export const COMMAND_LIFECYCLE_PHASES = [
  'INIT',
  'INIT_CHECK',
  'PLAN',
  'DEV',
  'REVIEW',
  'TEST',
  'DONE',
] as const satisfies readonly CommandPhase[];

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
    gates: ['init-check', 'scope-boundary', 'execution-boundary', 'scope-freeze-check', 'scope-extension-proposals', 'scope-discard-digest'],
    effects: ['story-worktree-create'],
    oracleRows: ['init-check', 'scope-boundary', 'execution-boundary', 'scope-freeze-check', 'scope-extension-proposals', 'scope-discard-digest'],
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
    gates: ['quick-path', 'parallel-decomposition'],
    effects: [],
    oracleRows: [],
    rendererRow: 'quick-path DEV entry',
  },
  {
    from: 'PLAN',
    to: 'DEV',
    event: 'START',
    kind: 'forward',
    gates: ['plan-review', 'scope-check', 'cwd-worktree', 'parallel-decomposition'],
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
    gates: ['reviewer-pass', 'review-cli-preflight', 'lattice-validate'],
    effects: ['test-evidence-write'],
    oracleRows: ['reviewer-evidence', 'validation-status'],
    rendererRow: 'REVIEW->TEST gate',
  },
  {
    from: 'REVIEW',
    to: 'DEV',
    event: 'START',
    kind: 'rollback',
    gates: ['cwd-worktree', 'parallel-decomposition'],
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
    oracleRows: ['validation-status', 'done-required-validation', 'bug-status', 'delivery-check', 'story-summary', 'git-working-tree'],
    rendererRow: 'DONE Final Checklist',
  },
  {
    from: 'TEST',
    to: 'DEV',
    event: 'START',
    kind: 'rollback',
    gates: ['cwd-worktree', 'parallel-decomposition'],
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

/**
 * Typed enum of known lifecycle artifact files (B-3740 CHK-001).
 *
 * Each value is a real artifact file path (relative to the story directory)
 * produced or consumed somewhere in the lifecycle. Modeling artifacts as a
 * typed enum — not free text — keeps the artifacts dimension mechanically
 * checkable: a contract test can assert every oracle/gate reference that
 * names an artifact resolves to one of these declared values (preMortem #3).
 *
 * @task B-f3db
 * @checklist CHK-001
 * @title transcript evidence lifecycle artifact
 * @type bugfix
 * @priority high
 * @description
 *   Treat the TEST user-value transcript files as narrow story-scoped
 *   lifecycle artifacts without allowing arbitrary evidence files.
 * @changes
 *   - [CHK-001] Register transcript evidence files as closed relative lifecycle artifact paths
 *   - [CHK-002] Keep artifact projections aligned with TEST transcript delivery evidence
 */
export const LIFECYCLE_ARTIFACTS = [
  'index.json',
  'review.json',
  'checklist.json',
  'init-check.json',
  'scope-boundary.json',
  'execution-boundary.json',
  'scope-freeze-check.json',
  'scope-extension-proposals.json',
  'decision-doc-proposals.json',
  'scope-discard-digest.json',
  'scope-check.json',
  'candidate-spec-set.json',
  'delivery-check.json',
  'review-runs.json',
  'findings.json',
  'review-passes.json',
  'draft-check.json',
  'summary.json',
  'test-evidence.json',
  'done-required-evidence.json',
  'declared-artifacts.json',
  'eval-evidence.json',
  'milestone-ledger.json',
  'slice-plan.json',
  'parent-ledger-rollup.json',
  'process-events.jsonl',
  'evidence/transcript-diff.md',
  'evidence/live-smoke-transcript.json',
  'evidence/delivery-context-pack.json',
] as const;

export type LifecycleArtifact = typeof LIFECYCLE_ARTIFACTS[number];

const LIFECYCLE_ARTIFACT_SET: ReadonlySet<string> = new Set(LIFECYCLE_ARTIFACTS);

/**
 * Runtime guard for the artifacts enum. Used by the consistency contract and
 * by any consumer that needs to validate an artifact name parsed from JSON or
 * an internal fn-call path that bypasses the compile-time `LifecycleArtifact`
 * type (Handler coding convention: re-check enum constraints at runtime).
 */
export function isLifecycleArtifact(value: string): value is LifecycleArtifact {
  return LIFECYCLE_ARTIFACT_SET.has(value);
}

export type LifecycleArtifactRole = 'produces' | 'consumes';

export interface LifecyclePhaseArtifacts {
  /** Artifacts written while the story is in this phase. */
  readonly produces: readonly LifecycleArtifact[];
  /** Artifacts read as evidence by gates entering/leaving this phase. */
  readonly consumes: readonly LifecycleArtifact[];
}

/**
 * Per-phase artifact dimension (B-3740 CHK-001).
 *
 * This is a SEPARATE registry data structure — deliberately NOT a new field on
 * the `LIFECYCLE_TRANSITIONS` objects that phase-flow.ts consumes (preMortem
 * #2). phase-flow.ts derives phase ordinals / transition graph purely from
 * `LIFECYCLE_TRANSITIONS`; weaving artifacts into those objects would risk
 * polluting derived values. Keeping artifacts here keeps phase-flow byte-stable.
 */
export const LIFECYCLE_PHASE_ARTIFACTS = {
  IDEA: { produces: ['index.json'], consumes: [] },
  INIT: {
    produces: ['index.json', 'init-check.json', 'draft-check.json', 'scope-boundary.json', 'execution-boundary.json', 'scope-freeze-check.json', 'scope-extension-proposals.json'],
    consumes: ['scope-discard-digest.json'],
  },
  INIT_CHECK: {
    produces: ['index.json'],
    consumes: ['init-check.json', 'scope-boundary.json', 'execution-boundary.json', 'scope-freeze-check.json', 'scope-extension-proposals.json', 'scope-discard-digest.json'],
  },
  PLAN: {
    produces: ['review.json', 'scope-check.json', 'candidate-spec-set.json', 'checklist.json', 'decision-doc-proposals.json'],
    consumes: ['init-check.json', 'review.json', 'scope-check.json', 'candidate-spec-set.json'],
  },
  DEV: {
    produces: ['checklist.json', 'candidate-spec-set.json', 'decision-doc-proposals.json'],
    consumes: ['review.json', 'scope-check.json', 'candidate-spec-set.json', 'checklist.json'],
  },
  REVIEW: {
    produces: ['candidate-spec-set.json', 'review-runs.json', 'findings.json', 'review-passes.json', 'delivery-check.json', 'test-evidence.json'],
    consumes: ['candidate-spec-set.json', 'checklist.json', 'findings.json', 'review-passes.json', 'review-runs.json'],
  },
  TEST: {
    produces: ['candidate-spec-set.json', 'test-evidence.json', 'delivery-check.json', 'eval-evidence.json', 'summary.json', 'done-required-evidence.json', 'evidence/transcript-diff.md', 'evidence/live-smoke-transcript.json'],
    consumes: ['candidate-spec-set.json', 'test-evidence.json', 'findings.json'],
  },
  DONE: {
    produces: ['summary.json'],
    consumes: ['test-evidence.json', 'delivery-check.json', 'summary.json', 'declared-artifacts.json', 'eval-evidence.json', 'done-required-evidence.json'],
  },
  DISCARDED: {
    produces: ['index.json', 'scope-discard-digest.json'],
    consumes: [],
  },
} as const satisfies Partial<Record<StoryPhase, LifecyclePhaseArtifacts>>;

export interface LifecycleTransitionArtifacts {
  readonly from: StoryPhase;
  readonly to: StoryPhase;
  readonly artifacts: readonly LifecycleArtifact[];
}

/**
 * Mapping from a lifecycle transition's `oracleRows` / `gates` ids to the
 * artifact files they reference (B-3740 CHK-001). Only ids that actually name
 * an artifact file appear here; conceptual ids (e.g. `git-working-tree`,
 * `bug-status`) are intentionally absent. The consistency contract uses this
 * to assert each named-artifact reference resolves to a declared
 * `LifecycleArtifact` value.
 */
export const LIFECYCLE_ORACLE_ARTIFACT_REFS = {
  'init-check': 'init-check.json',
  'scope-boundary': 'scope-boundary.json',
  'execution-boundary': 'execution-boundary.json',
  'scope-freeze-check': 'scope-freeze-check.json',
  'scope-extension-proposals': 'scope-extension-proposals.json',
  'scope-discard-digest': 'scope-discard-digest.json',
  'plan-review': 'review.json',
  'scope-check': 'scope-check.json',
  'verification-coverage': 'checklist.json',
  'reviewer-evidence': 'review-passes.json',
  'validation-status': 'test-evidence.json',
  'done-required-validation': 'done-required-evidence.json',
  'delivery-check': 'delivery-check.json',
  'story-summary': 'summary.json',
} as const satisfies Record<string, LifecycleArtifact>;

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

export interface LifecycleCommandsByPhase {
  /**
   * Commands legal in EVERY phase (`allowedPhases: 'all'`). Models the same
   * "wildcard bucket" resolution semantics DEFAULT_PHASE_TOOLS uses with its
   * `*` key — a contract test must resolve `wildcard` ∪ per-phase, not compare
   * raw tables (preMortem #1).
   */
  readonly wildcard: readonly string[];
  /** Commands legal only in specific phases, keyed by phase name. */
  readonly byPhase: Readonly<Record<CommandPhase, readonly string[]>>;
}

/**
 * Phase→commands projection (B-3740 CHK-001).
 *
 * Read-only projection over `COMMAND_POLICIES` — command legality (`allowedPhases`)
 * is the registry's command dimension. Returns a `wildcard` bucket (commands
 * with `allowedPhases: 'all'`) plus a `byPhase` map (commands restricted to
 * named phases). Commands with no `allowedPhases` (rootOnly / legacy without a
 * phase list) appear in neither bucket — they are not legal in any active story
 * phase. Mirrors the pure-function shape of `lifecycleForwardTransitionsByPhase`.
 */
export function lifecycleCommandsByPhase(): LifecycleCommandsByPhase {
  const wildcard: string[] = [];
  const byPhase = Object.fromEntries(
    COMMAND_LIFECYCLE_PHASES.map(phase => [phase, [] as string[]]),
  ) as Record<CommandPhase, string[]>;

  for (const [command, policy] of getCommandPolicyEntries()) {
    const allowed = policy.allowedPhases;
    if (allowed === 'all') {
      wildcard.push(command);
      continue;
    }
    if (!allowed) continue;
    for (const phase of allowed) {
      byPhase[phase].push(command);
    }
  }

  return { wildcard, byPhase };
}

/**
 * Resolves the effective set of commands legal in a phase: the wildcard bucket
 * plus that phase's specific commands. This is the registry-side equivalent of
 * DEFAULT_PHASE_TOOLS' `*` + per-phase resolution — consistency contracts
 * compare resolved effective sets, never raw tables (preMortem #1).
 */
export function lifecycleResolvedCommandsForPhase(phase: CommandPhase): readonly string[] {
  const projection = lifecycleCommandsByPhase();
  return [...new Set([...projection.wildcard, ...projection.byPhase[phase]])];
}

export type { CommandPhase } from './command-policy.js';

/**
 * Phase→artifacts projection (B-3740 CHK-001).
 *
 * Read-only projection over `LIFECYCLE_PHASE_ARTIFACTS`. Returns a stable map
 * from every lifecycle phase to the artifacts it produces / consumes. Mirrors
 * the pure-function shape of `lifecycleForwardTransitionsByPhase`. The returned
 * object is a fresh copy so callers cannot mutate the registry data.
 */
export function lifecycleArtifactsByPhase(): Record<StoryPhase, LifecyclePhaseArtifacts> {
  const out = Object.fromEntries(
    LIFECYCLE_PHASES.map(phase => [phase, { produces: [], consumes: [] } as LifecyclePhaseArtifacts]),
  ) as Record<StoryPhase, LifecyclePhaseArtifacts>;
  for (const [phase, artifacts] of Object.entries(LIFECYCLE_PHASE_ARTIFACTS)) {
    out[phase as StoryPhase] = {
      produces: [...artifacts.produces],
      consumes: [...artifacts.consumes],
    };
  }
  return out;
}

/**
 * Transition→artifacts projection (B-3740 CHK-001).
 *
 * For each lifecycle transition, resolves the artifacts named by its
 * `oracleRows` / `gates` ids via `LIFECYCLE_ORACLE_ARTIFACT_REFS`. Conceptual
 * oracle ids that do not name an artifact file are skipped. Returns one entry
 * per transition, keyed in `LIFECYCLE_TRANSITIONS` order.
 */
export function lifecycleArtifactsByTransition(): LifecycleTransitionArtifacts[] {
  return LIFECYCLE_TRANSITIONS.map(transition => {
    const refs = [...transition.oracleRows, ...transition.gates];
    const artifacts: LifecycleArtifact[] = [...new Set(
      refs
        .map(ref => LIFECYCLE_ORACLE_ARTIFACT_REFS[ref as keyof typeof LIFECYCLE_ORACLE_ARTIFACT_REFS])
        .filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== undefined),
    )];
    return { from: transition.from, to: transition.to, artifacts };
  });
}

// ── B-b9d0 CHK-001/002: lifecycle artifact scope classifier ──
//
// Narrow trust policy for command-generated story metadata. A path is
// recognized as a Proofbound-owned lifecycle artifact only when it lives under a
// known story directory prefix, the segment after that prefix is a valid
// storyId, AND either the top-level terminal filename or relative story-dir
// path is in a closed set below. Arbitrary JSON / unknown files under active docs/story/
// story dirs no longer pass scope implicitly; legacy
// `docs/story/.../<storyId>/...` still resolves for back-compat outside active
// story prefixes (returns kind 'legacy-metadata').

export const LATTICE_LIFECYCLE_ARTIFACT_FILENAMES: ReadonlySet<string> = new Set([
  ...LIFECYCLE_ARTIFACTS.filter((artifact) => !artifact.includes('/')),
  'plan.md',
  'background.md',
  'understanding.json',
  'decision.json',
  'bug.json',
  'verification-evidence.json',
  'verification-coverage.json',
  'scope-contract.json',
  'guard-session.json',
  'process-metrics.json',
  'test-runs.json',
  'owner-lease.json',
  'gap-log.json',
  'review-runs.json',
  'cluster.json',
  'context.json',
  'reviewer-list.json',
  'story-capsule.json',
  'implementation-review.json',
  'init-check-fallback.json',
  'draft-check-fallback.json',
  'risk-dismiss.json',
  'exp.json',
  // ProofStory intent-hardening artifacts (store.ts B-7287 block); B-12a1
  'original-intent-snapshot.json',
  'milestone-ledger.json',
  'milestone-closeout.json',
  'slice-plan.json',
  'parent-ledger-rollup.json',
  'proofstory.json',
  'intent-collision.json',
  'scope-shrinkage-decision.json',
  'red-evidence.json',
  'spike.json',
]);

export const LATTICE_LIFECYCLE_ARTIFACT_RELATIVE_PATHS: ReadonlySet<string> = new Set([
  ...LIFECYCLE_ARTIFACTS.filter((artifact) => artifact.includes('/')),
]);

/**
 * Canonical Proofbound story-id shape. Anchored (`^…$`) and restricted to
 * `[A-Za-z0-9_-]` body characters, so a matching id can NEVER contain a path
 * separator (`/`, `\`) or a `..` traversal segment. This is the single source
 * of truth for "is this a real story id" — it is reused both here (artifact
 * scope classification) and by the shared owner-lease gate
 * (`enforceStoryOwnerLeaseGate`) to fail closed before any filesystem path is
 * derived from a caller-supplied storyId (F-003 path-traversal fix).
 */
export const STORY_ID_RE = /^(?:B-META-[A-Za-z0-9_-]+|B-[A-Za-z0-9_-]+|ADHOC-[A-Za-z0-9_-]+|TOOL-[A-Za-z0-9_-]+|META-[A-Za-z0-9_-]+)$/;

/**
 * True when `value` is a path-safe canonical Proofbound story id. A caller that
 * is about to derive a filesystem path from a storyId (e.g. `storyDirPath`)
 * MUST gate on this first so a crafted `../../outside`-style id cannot escape
 * the story tree.
 */
export function isCanonicalStoryId(value: string): boolean {
  return STORY_ID_RE.test(value);
}

const DEFAULT_STORY_DIR_PREFIXES = [
  '.lattice/story/actives/',
  'docs/story/actives/',
] as const;

const LEGACY_STORY_DIR_PREFIX = 'docs/story/';

function normalizeArtifactPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

export interface LifecycleArtifactClassification {
  kind: 'lifecycle' | 'legacy-metadata';
  storyId: string;
  fileName: string;
  storyDir: string;
  label: string;
}

export interface LifecycleArtifactClassifyOptions {
  storyDir?: string;
  storyId?: string;
}

export function classifyLifecycleArtifact(
  path: string,
  options: LifecycleArtifactClassifyOptions = {},
): LifecycleArtifactClassification | null {
  const normalized = normalizeArtifactPath(path);
  if (!normalized) return null;
  if (normalized.includes('..')) return null;

  const customPrefix = options.storyDir
    ? ensureTrailingSlash(normalizeArtifactPath(options.storyDir))
    : null;
  const prefixes = customPrefix
    ? [customPrefix, ...DEFAULT_STORY_DIR_PREFIXES]
    : [...DEFAULT_STORY_DIR_PREFIXES];

  for (const prefix of prefixes) {
    if (!normalized.startsWith(prefix)) continue;
    const rest = normalized.slice(prefix.length);
    const segments = rest.split('/');
    if (segments.length < 2) return null;
    const storyId = segments[0];
    if (!STORY_ID_RE.test(storyId)) return null;
    if (options.storyId && options.storyId !== storyId) return null;
    const fileName = segments[segments.length - 1];
    const relativePath = segments.slice(1).join('/');
    const isTopLevelArtifact = segments.length === 2;
    if (isTopLevelArtifact && !LATTICE_LIFECYCLE_ARTIFACT_FILENAMES.has(fileName)) {
      return null;
    }
    if (!isTopLevelArtifact && !LATTICE_LIFECYCLE_ARTIFACT_RELATIVE_PATHS.has(relativePath)) {
      return null;
    }
    return {
      kind: 'lifecycle',
      storyId,
      fileName,
      storyDir: stripTrailingSlash(prefix),
      label: 'Proofbound lifecycle artifact (command-generated metadata)',
    };
  }

  if (prefixes.some((prefix) => normalized.startsWith(prefix))) {
    return null;
  }

  const legacyPrefixes = [
    { prefix: LEGACY_STORY_DIR_PREFIX, storyDir: 'docs/story' },
    { prefix: '.lattice/story/', storyDir: '.lattice/story' },
  ];
  for (const { prefix, storyDir } of legacyPrefixes) {
    if (!normalized.startsWith(prefix)) continue;
    const rest = normalized.slice(prefix.length);
    const segments = rest.split('/');
    if (segments.length < 2) continue;
    const candidateStoryId = segments.find((seg) => STORY_ID_RE.test(seg));
    if (!candidateStoryId) continue;
    if (options.storyId && options.storyId !== candidateStoryId) return null;
    const fileName = segments[segments.length - 1];
    return {
      kind: 'legacy-metadata',
      storyId: candidateStoryId,
      fileName,
      storyDir,
      label: 'Proofbound lifecycle artifact (legacy story-tree metadata)',
    };
  }

  return null;
}

export function isLatticeLifecycleArtifactPath(
  path: string,
  options: LifecycleArtifactClassifyOptions = {},
): boolean {
  const result = classifyLifecycleArtifact(path, options);
  return result?.kind === 'lifecycle';
}

export function isAnyLatticeStoryMetadataPath(
  path: string,
  options: LifecycleArtifactClassifyOptions = {},
): boolean {
  return classifyLifecycleArtifact(path, options) !== null;
}
