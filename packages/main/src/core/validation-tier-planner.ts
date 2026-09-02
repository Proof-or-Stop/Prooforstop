/**
 * B-a745 CHK-004 — language-neutral planner types and the fail-closed widening
 * matrix.
 *
 * Spec: `docs/requirements/decisions/story-relevance-dynamic-validation-tiers-execution-plan.md`
 * sections "Terminology and invariants", "Selection algorithm" (steps 1, 2 and
 * 5) and "Fail-closed widening matrix" (owned by story B-ccf4, not yet on main).
 *
 * THE DEFINING CONSTRAINT OF THIS INCREMENT:
 *
 *   `resolveValidationTierPlan` returns `effectiveTier: 'repository-full'` or a
 *   CLASSIFIED STOP. There is no code path that returns a reduced tier.
 *
 * There is no pruning here, no impact index, no exclusion proof, and no
 * shortcut kept "for later" — those belong to later Rollout Stories and adding
 * a dormant one now would be a narrowing nobody reviewed. The constraint is
 * enforced by the TYPE as well as by the code: `ValidationTierPlan.effectiveTier`
 * is the literal type `'repository-full'`, so an implementation that tried to
 * return `story-fast` would not compile, and neither a stop nor a skip carries
 * an effective tier at all.
 *
 * Two further rules are load-bearing:
 *
 *   1. AN EMPTY SELECTION IS NEVER A PASS. The spec is explicit: "An empty
 *      selection is never interpreted as PASS." An empty execution universe
 *      therefore produces a classified `empty_selection_unclassified` STOP.
 *      Nothing in this module has a field shaped like a pass assertion, so
 *      "nothing ran, therefore everything is fine" is not expressible.
 *   2. EVERY REASON CODE CARRIES A GLOSS. The codes are the KEYS of
 *      `VALIDATION_WIDENING_REASONS`, and every value in that table must supply
 *      a one-sentence plain-language gloss, so a code cannot be declared
 *      without one — the type of the table makes the omission a compile error
 *      rather than a silent hole. A bare `impact_index_unusable` printed at an
 *      operator is unusable to anyone who has not read the spec; the gloss is
 *      what makes the refusal actionable.
 *
 * This module reads no state, writes nothing, executes nothing, and is consumed
 * by no lifecycle gate in this Story. It is planning INPUT for an explain-only
 * CLI (CHK-005), and every result says so through `finalAuthority: false`.
 */

import { missingEvidenceHashDigests, type StoryRelevanceInput } from './validation-relevance-input.js';
import type { RoutineValidationSourceKind } from './validation-types.js';

export const VALIDATION_TIER_PLAN_SCHEMA = 'proofOrStop.validation-tier-plan.v1' as const;

// ---------------------------------------------------------------------------
// Tier vocabulary and the subset invariant.
// ---------------------------------------------------------------------------

/**
 * Ordered by CONTAINMENT, narrowest first. The order is the invariant
 *
 *     story-fast ⊆ story-intermediate ⊆ repository-full
 *
 * so `validationTierRank` and `validationTierIsSubsetOf` read it directly
 * instead of restating the relation somewhere it could drift.
 */
export const VALIDATION_TIERS = ['story-fast', 'story-intermediate', 'repository-full'] as const;

export type ValidationTier = (typeof VALIDATION_TIERS)[number];

/** The only tier this increment can conclude with. */
export const REPOSITORY_FULL_TIER = 'repository-full' as const;

/**
 * Runtime re-validation, per the Handler encoding convention: a schema
 * constraint upstream is the first line of defence only, and this core is
 * reachable from internal calls and stored JSON that never met a schema.
 */
export function assertValidationTier(value: unknown, owner: string): ValidationTier {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${owner}: tier must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (!(VALIDATION_TIERS as readonly string[]).includes(trimmed)) {
    throw new Error(
      `${owner}: unknown tier ${JSON.stringify(trimmed)} (expected one of ${VALIDATION_TIERS.join(', ')})`,
    );
  }
  return trimmed as ValidationTier;
}

/** Position in the containment order. Lower means narrower. */
export function validationTierRank(tier: ValidationTier): number {
  return VALIDATION_TIERS.indexOf(tier);
}

export function validationTierIsSubsetOf(narrower: ValidationTier, wider: ValidationTier): boolean {
  return validationTierRank(narrower) <= validationTierRank(wider);
}

export type ValidationTierSelections = Record<ValidationTier, readonly string[]>;

/**
 * Enforce the required SET invariant on a concrete selection, not just on the
 * tier names: every unit in a narrower tier must appear in every wider one. The
 * resolver calls this on its own output before returning, so a future edit that
 * broke containment would fail here rather than ship a plan whose fast set can
 * run something the full set does not.
 */
export function assertValidationTierSelectionSubsetInvariant(selections: ValidationTierSelections): void {
  for (let narrowerIndex = 0; narrowerIndex < VALIDATION_TIERS.length; narrowerIndex += 1) {
    const narrower = VALIDATION_TIERS[narrowerIndex];
    for (let widerIndex = narrowerIndex + 1; widerIndex < VALIDATION_TIERS.length; widerIndex += 1) {
      const wider = VALIDATION_TIERS[widerIndex];
      const widerSet = new Set(selections[wider] ?? []);
      for (const unitId of selections[narrower] ?? []) {
        if (!widerSet.has(unitId)) {
          throw new Error(
            `validation tier subset invariant violated: ${narrower} selects "${unitId}", which ${wider} does not. ` +
            `Required: ${VALIDATION_TIERS.join(' ⊆ ')}.`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The fail-closed widening matrix.
// ---------------------------------------------------------------------------

/** What the matrix row DOES, kept separate from why it fired. */
export const VALIDATION_WIDENING_OUTCOMES = [
  /** Run the complete canonical universe. */
  'repository-full',
  /** Run the source kind's opaque single unit, which IS its repository-full path. */
  'atomic-repository-full',
  /** Recompute the plan; repeated movement widens to repository-full. */
  'replan',
  /** Produce no plan and no PASS artifact at all. */
  'stop',
  /** Preserve the existing skip/warn; no tier PASS is produced. */
  'no-tier-pass',
  /** Select the registered docs checks for the narrow tiers. */
  'docs-policy',
  /** Run the complete selected set anyway and report the miss. */
  'report-only',
] as const;

export type ValidationWideningOutcome = (typeof VALIDATION_WIDENING_OUTCOMES)[number];

export interface ValidationWideningReasonDefinition {
  /** The matrix CONDITION, transcribed from the spec row. */
  readonly condition: string;
  readonly outcome: ValidationWideningOutcome;
  /**
   * One sentence an operator who has never read the spec can act on. Required
   * by the type, so a code cannot be added without one.
   */
  readonly gloss: string;
}

/**
 * THE fail-closed widening matrix. Every row of the spec table is here, and the
 * reason-code enum below is derived from these KEYS — the code and its gloss are
 * declared in the same place precisely so they cannot come apart.
 *
 * The matrix is intentionally conservative. Later narrowing needs its own
 * evidence-backed decision and may not be smuggled in as calibration.
 */
export const VALIDATION_WIDENING_REASONS = {
  changed_files_unavailable: {
    condition: 'Changed-file discovery fails',
    outcome: 'repository-full',
    gloss:
      'The list of files this Story changed could not be read, so nothing is known about what it touched ' +
      'and everything has to run.',
  },
  hash_snapshot_unavailable: {
    condition: 'Evidence hash snapshot (head, material or story-files digest) cannot be captured or is incomplete',
    outcome: 'repository-full',
    /**
     * B-a745 F-022. The collector escalates this for a thrown reader AND for a
     * returned snapshot that lacks any of the three digests (non-git directory,
     * unborn repository, failed hash read). Before this row existed the
     * escalation had no matrix entry, so the planner dropped it and a plan
     * rendered as if it were bound.
     */
    gloss:
      'The commit, material-tree and story-files digests that would tie this plan to the exact code it was made ' +
      'for could not all be captured, so the plan carries no freshness binding and nothing can be narrowed on ' +
      'its account.',
  },
  unclassified_material_input: {
    condition: 'Material path is unclassified',
    outcome: 'repository-full',
    gloss:
      'A changed file could not be attributed to any known validation command, so no command can be safely ' +
      'skipped on its account.',
  },
  impact_index_unusable: {
    condition: 'Index missing, stale, malformed, or digest-invalid',
    outcome: 'repository-full',
    gloss:
      'The map from files to the commands that cover them is missing or untrustworthy, so there is no basis ' +
      'for running a smaller set.',
  },
  impact_projection_incomplete: {
    condition: 'Base index cannot be completely projected to current HEAD',
    outcome: 'repository-full',
    gloss:
      'The file-to-command map was built against an older commit and cannot be carried forward completely to ' +
      'the current code, so it cannot be relied on.',
  },
  workspace_snapshot_changed: {
    condition: 'Material worktree overlay cannot be completely read or changes during plan/execute double-read',
    outcome: 'replan',
    gloss:
      'Files on disk moved while the plan was being made, so the plan is recomputed; if they keep moving, ' +
      'everything runs.',
  },
  selection_policy_changed: {
    condition: 'Command-set or selector policy digest changed',
    outcome: 'repository-full',
    gloss:
      'The set of validation commands or the rules for choosing among them changed, so any earlier narrowing ' +
      'decision no longer applies.',
  },
  validation_framework_sensitive_change: {
    condition:
      'Selector, graph adapter, validation executor, runner registry, process-fact registry, lifecycle gate, ' +
      'or validation config changes',
    outcome: 'repository-full',
    gloss:
      'This Story changed the machinery that decides what to run or how to judge it, so that machinery cannot ' +
      'be trusted to shrink its own test set.',
  },
  build_graph_change: {
    condition: 'Package manifest, lockfile, build graph, or shared compiler configuration changes',
    outcome: 'repository-full',
    gloss:
      'A dependency, lockfile or compiler setting changed, which can affect anything in the repository, so the ' +
      'blast radius is not bounded.',
  },
  runtime_edge_unresolved: {
    condition: 'Dynamic import/subprocess/generated edge unresolved',
    outcome: 'repository-full',
    gloss:
      'Some code is reached dynamically rather than through a statically visible link, so the dependency ' +
      'picture is known to be incomplete.',
  },
  pinned_command_missing: {
    condition: 'Explicit command pin does not resolve',
    outcome: 'stop',
    /**
     * B-a745 F-004. The previous wording claimed the command "no longer exists
     * in this project" and prescribed re-recording the evidence. That is a claim
     * this code cannot make: the resolver only knows the id is absent from the
     * VALIDATION COMMAND INVENTORY (`validate.commands`), which is a narrower
     * registry than "things this project can run". A command can be a real,
     * currently passing script and still not be a member. Telling an operator to
     * re-record against "a current command" then sends them looking for a
     * more-current command that does not exist. The remedy that actually applies
     * is to restore or declare the id in the inventory.
     */
    gloss:
      'Evidence pins a command id that this project\u2019s validation command inventory does not declare, so the ' +
      'command the evidence claims to prove cannot be identified and no plan is produced; restore or declare ' +
      'that id in the inventory, or re-record the evidence against an id the inventory currently declares.',
  },
  pinned_command_non_inventory: {
    condition: 'Legacy free-form evidence command normalizes to no command in the validation inventory',
    outcome: 'repository-full',
    gloss:
      'Evidence names a command that is not one of this project\u2019s registered validation commands \u2014 it may ' +
      'still be a real, runnable script, just not a member of the inventory the planner selects from \u2014 so it ' +
      'proves nothing about any command and cannot make the set smaller, and the full repository set runs.',
  },
  pinned_command_ambiguous: {
    condition: 'Legacy pin resolves to multiple command IDs',
    outcome: 'stop',
    gloss:
      'Recorded evidence matches more than one validation command equally well, so which one it proves cannot ' +
      'be decided and no plan is produced.',
  },
  command_exclusion_unproven: {
    condition: 'Any configured command lacks a positive current-head exclusion proof',
    outcome: 'repository-full',
    gloss:
      'Leaving a command out requires a positive proof that this Story cannot affect it, and no such proof ' +
      'exists, so the command runs.',
  },
  source_kind_atomic: {
    condition: 'Requested tier uses fallback discovery or an opaque validate-file without a decomposition adapter',
    outcome: 'atomic-repository-full',
    gloss:
      'This project runs validation as one opaque command, so there is nothing smaller to select and the whole ' +
      'thing runs as it always did.',
  },
  no_validator: {
    condition: 'Source kind is no-validator',
    outcome: 'no-tier-pass',
    gloss:
      'This project has no validation command configured at all, so the existing skip-with-a-warning behaviour ' +
      'is preserved and no tier can pass.',
  },
  empty_selection_unclassified: {
    condition: 'No material changes and no explicit docs/no-op policy',
    outcome: 'stop',
    gloss:
      'The plan would run nothing at all, and running nothing is never evidence that anything passed, so it ' +
      'stops instead.',
  },
  docs_only_policy: {
    condition: 'Docs-only changes with a registered docs policy',
    outcome: 'docs-policy',
    gloss:
      'Only documentation changed and the project registered a docs policy, so the narrow tiers run the docs ' +
      'checks while the full policy is unchanged.',
  },
  duration_target_exceeded: {
    condition: 'Selected set exceeds target duration',
    outcome: 'report-only',
    gloss:
      'The chosen set is expected to take longer than the target, which is reported but never used to drop a ' +
      'command from it.',
  },
} as const satisfies Record<string, ValidationWideningReasonDefinition>;

/**
 * The reason-code enum. Derived from the table KEYS, so a code that carries no
 * gloss cannot exist: there is no second list to fall out of sync with.
 */
export type ValidationWideningReasonCode = keyof typeof VALIDATION_WIDENING_REASONS;

export const VALIDATION_WIDENING_REASON_CODES = Object.keys(
  VALIDATION_WIDENING_REASONS,
) as ValidationWideningReasonCode[];

/**
 * The stop codes: rows whose outcome is to produce no plan at all. DERIVED from
 * the table, and the resolver's ONLY authority on what stops — `isValidation
 * StopReasonCode` below is how the resolver asks, so a row whose outcome becomes
 * (or stops being) `stop` changes the resolver's behaviour without anyone
 * editing the resolver. A hand-written list of code names next to a table that
 * already declares the same fact is the shape that drifts (B-a745 F-006).
 */
export const VALIDATION_STOP_REASON_CODES = VALIDATION_WIDENING_REASON_CODES.filter(
  (code) => VALIDATION_WIDENING_REASONS[code].outcome === 'stop',
);

const VALIDATION_STOP_REASON_CODE_SET: ReadonlySet<string> = new Set<string>(VALIDATION_STOP_REASON_CODES);

/**
 * Does this code produce no plan at all? Accepts `unknown` on purpose: the
 * caller's codes arrive from collected input and stored JSON that never met a
 * schema, so an unrecognised value must answer "no" rather than throw a type
 * error somewhere further down.
 */
export function isValidationStopReasonCode(code: unknown): code is ValidationWideningReasonCode {
  return typeof code === 'string' && VALIDATION_STOP_REASON_CODE_SET.has(code);
}

/**
 * Runtime re-validation of a code, and the single read path for a gloss. An
 * unknown code is REFUSED rather than glossed as an empty string, because an
 * empty gloss is exactly the unusable bare code this design exists to prevent.
 */
export function validationWideningReasonGloss(code: ValidationWideningReasonCode): string {
  const definition = VALIDATION_WIDENING_REASONS[code];
  if (!definition) {
    throw new Error(
      `unknown validation widening reason code ${JSON.stringify(code)} ` +
      `(expected one of ${VALIDATION_WIDENING_REASON_CODES.join(', ')})`,
    );
  }
  if (typeof definition.gloss !== 'string' || definition.gloss.trim() === '') {
    throw new Error(`validation widening reason ${String(code)} declares no plain-language gloss`);
  }
  return definition.gloss;
}

/** One reason, as it reaches an operator: code, what it does, why, and specifics. */
export interface ValidationWideningReason {
  code: ValidationWideningReasonCode;
  outcome: ValidationWideningOutcome;
  /** Never empty: `validationWideningReasonGloss` refuses a code that has none. */
  gloss: string;
  /** The concrete facts of THIS occurrence. */
  detail: string;
}

export function validationWideningReason(
  code: ValidationWideningReasonCode,
  detail: string,
): ValidationWideningReason {
  const gloss = validationWideningReasonGloss(code);
  const trimmedDetail = typeof detail === 'string' ? detail.trim() : '';
  if (trimmedDetail === '') {
    throw new Error(`validation widening reason ${String(code)}: detail must be a non-empty string`);
  }
  return { code, outcome: VALIDATION_WIDENING_REASONS[code].outcome, gloss, detail: trimmedDetail };
}

// ---------------------------------------------------------------------------
// Plan shapes.
// ---------------------------------------------------------------------------

export type ValidationPlanUnitKind = 'command' | 'atomic';

export interface ValidationPlanUnit {
  id: string;
  kind: ValidationPlanUnitKind;
  label: string;
}

export type ValidationTierPlanUnclassifiedKind = 'material-path' | 'evidence-pin' | 'duration-sample';

export interface ValidationTierPlanUnclassifiedInput {
  kind: ValidationTierPlanUnclassifiedKind;
  /** The path, pin or sample itself — listed, never merely counted. */
  value: string;
  detail: string;
}

interface ValidationTierPlanCommon {
  schema: typeof VALIDATION_TIER_PLAN_SCHEMA;
  storyId: string;
  /** Retained even when the plan widens away from it, per Selection step 2. */
  requestedTier: ValidationTier;
  sourceKind: RoutineValidationSourceKind;
  escalationReasons: ValidationWideningReason[];
  unclassifiedInputs: ValidationTierPlanUnclassifiedInput[];
  /** Explain-only. This module never produces final assurance. */
  finalAuthority: false;
}

export interface ValidationTierPlan extends ValidationTierPlanCommon {
  status: 'plan';
  /**
   * The LITERAL type is the guarantee: this increment cannot express a reduced
   * effective tier, so no reviewer has to trust a comment about it.
   */
  effectiveTier: typeof REPOSITORY_FULL_TIER;
  executionMode: 'command-set' | 'atomic';
  universe: ValidationPlanUnit[];
  /** Always the complete universe here, and never empty. */
  selectedUnitIds: string[];
  tierSelections: Record<ValidationTier, string[]>;
  /** Literal `false`: there is no pruning path to turn it on. */
  reductionApplied: false;
}

/** No plan and no PASS artifact. */
export interface ValidationTierStop extends ValidationTierPlanCommon {
  status: 'stop';
  reason: ValidationWideningReason;
}

/** The existing skip/warn semantics, preserved. Not a pass, not a stop. */
export interface ValidationTierNoPass extends ValidationTierPlanCommon {
  status: 'no-tier-pass';
  reason: ValidationWideningReason;
}

export type ValidationTierPlanResult = ValidationTierPlan | ValidationTierStop | ValidationTierNoPass;

export interface ResolveValidationTierPlanArgs {
  input: StoryRelevanceInput;
  requestedTier: ValidationTier;
}

const ATOMIC_SOURCE_KINDS: readonly RoutineValidationSourceKind[] = ['fallback', 'validate-file'];

function assertPlannerInput(input: StoryRelevanceInput): void {
  if (!input || typeof input !== 'object') {
    throw new Error('resolveValidationTierPlan: input must be a StoryRelevanceInput object');
  }
  if (typeof input.storyId !== 'string' || input.storyId.trim() === '') {
    throw new Error('resolveValidationTierPlan: input.storyId must be a non-empty string');
  }
  if (!input.executionInventory || typeof input.executionInventory !== 'object') {
    throw new Error('resolveValidationTierPlan: input.executionInventory is required');
  }
  if (!Array.isArray(input.executionInventory.commandIds)) {
    throw new Error('resolveValidationTierPlan: input.executionInventory.commandIds must be an array');
  }
  // B-a745 F-022: a snapshot labelled available must carry every binding. The
  // collector classifies a partial one, but a schema-bypassing input (an
  // internal caller, a fixture, an older serialized input) is re-checked here
  // so no code path plans over a null head / material / story-files binding.
  if (!input.hashes || typeof input.hashes !== 'object' || typeof input.hashes.status !== 'string') {
    throw new Error('resolveValidationTierPlan: input.hashes must classify the evidence hash snapshot');
  }
  if (input.hashes.status === 'available') {
    const missing = missingEvidenceHashDigests(input.hashes.head);
    if (missing.length > 0) {
      throw new Error(
        `resolveValidationTierPlan: input.hashes is labelled available but carries no ${missing.join(', ')}; ` +
        'a snapshot missing a digest binds nothing and must be classified hash_snapshot_unavailable, never planned over',
      );
    }
  }
}

/**
 * Everything the plan could not attribute to a command. In this increment there
 * is no impact index at all, so EVERY material seed path is unclassified — that
 * is not a defect being papered over, it is the honest reason the plan cannot
 * narrow, and listing the paths is what lets a reader check the claim.
 */
function collectUnclassifiedInputs(input: StoryRelevanceInput): ValidationTierPlanUnclassifiedInput[] {
  const entries: ValidationTierPlanUnclassifiedInput[] = [];
  for (const seed of input.seeds) {
    if (seed.kind !== 'path') continue;
    entries.push({
      kind: 'material-path',
      value: seed.value,
      detail:
        `no impact index maps ${seed.value} (provenance: ${seed.provenance.join(', ')}) to a validation ` +
        'command, so no command may be excluded on its account',
    });
  }
  for (const upstream of input.unclassifiedInputs) {
    entries.push({ kind: upstream.kind, value: upstream.detail, detail: upstream.detail });
  }
  return entries;
}

/**
 * The FIRST collected escalation whose table row says it produces no plan. The
 * membership test is the table's, so this function never needs to be edited when
 * a row's outcome changes.
 */
function firstStopEscalation(input: StoryRelevanceInput): ValidationWideningReason | null {
  for (const escalation of input.escalations) {
    if (isValidationStopReasonCode(escalation.code)) {
      return validationWideningReason(escalation.code, escalation.detail);
    }
  }
  return null;
}

/**
 * Guard on the way OUT of every stop return: the reason a stop carries must be
 * one the table declares as a stop. Without it, a stop could be returned with a
 * widening reason attached and the two facts would disagree in the artifact.
 */
function assertStopReason(reason: ValidationWideningReason): ValidationWideningReason {
  if (!isValidationStopReasonCode(reason.code) || reason.outcome !== 'stop') {
    throw new Error(
      `resolveValidationTierPlan: returned a stop carrying reason "${reason.code}" (outcome ` +
      `"${reason.outcome}"), which the widening matrix does not declare as a stop ` +
      `(stops: ${VALIDATION_STOP_REASON_CODES.join(', ')})`,
    );
  }
  return reason;
}

/**
 * Map a `StoryRelevanceInput` plus a requested tier onto an effective tier and
 * the reasons for it.
 *
 * Ordering note, deliberate and worth stating because it is the only place the
 * order is observable: `no_validator` is decided BEFORE a stop escalation. A
 * project with no validator has no commands, so every pin in it would read as
 * missing, and reporting "your pin is broken" would bury the real fact that the
 * project configured no validation at all. Neither branch can produce a PASS, so
 * the ordering cannot let anything through that the other ordering would stop.
 */
export function resolveValidationTierPlan(args: ResolveValidationTierPlanArgs): ValidationTierPlanResult {
  const requestedTier = assertValidationTier(args?.requestedTier, 'resolveValidationTierPlan');
  const input = args?.input as StoryRelevanceInput;
  assertPlannerInput(input);

  const sourceKind = input.executionInventory.sourceKind;
  const unclassifiedInputs = collectUnclassifiedInputs(input);
  const common = {
    schema: VALIDATION_TIER_PLAN_SCHEMA,
    storyId: input.storyId,
    requestedTier,
    sourceKind,
    unclassifiedInputs,
    finalAuthority: false as const,
  };

  // 1. No validator: preserve the existing skip/warn. No tier PASS, ever.
  if (sourceKind === 'no-validator') {
    const reason = validationWideningReason(
      'no_validator',
      `story ${input.storyId} resolves routine validation source kind "no-validator", so there is no ` +
      'executable unit to select and the existing skip/warn semantics are preserved unchanged',
    );
    return { ...common, status: 'no-tier-pass', reason, escalationReasons: [reason] };
  }

  // 2. A pin that does not resolve is a STOP: no plan, no PASS artifact.
  const stopReason = firstStopEscalation(input);
  if (stopReason) {
    const reason = assertStopReason(stopReason);
    return { ...common, status: 'stop', reason, escalationReasons: [reason] };
  }

  const escalationReasons: ValidationWideningReason[] = [];

  // 3. Build the universe U. Selection step 5 sets repository-full to U, and no
  //    relevance calculation may remove a command from it.
  const atomic = ATOMIC_SOURCE_KINDS.includes(sourceKind);
  const universe: ValidationPlanUnit[] = atomic
    ? [{ id: `atomic:${sourceKind}`, kind: 'atomic', label: `${sourceKind} validation (opaque single unit)` }]
    : input.executionInventory.commandIds.map((id) => ({ id, kind: 'command' as const, label: id }));

  if (atomic) {
    escalationReasons.push(
      validationWideningReason(
        'source_kind_atomic',
        `routine validation resolves through "${sourceKind}", which exposes no finer inventory than one ` +
        'opaque unit, so the requested tier executes that unit’s atomic repository-full path',
      ),
    );
  }

  // 4. An empty universe is a classified STOP. "Nothing ran" is never a pass.
  if (universe.length === 0) {
    const reason = assertStopReason(validationWideningReason(
      'empty_selection_unclassified',
      `story ${input.storyId} resolves routine source kind "${sourceKind}" with zero executable units, so a ` +
      'plan would select nothing at all; an empty selection is never interpreted as a pass',
    ));
    return { ...common, status: 'stop', reason, escalationReasons: [...escalationReasons, reason] };
  }

  // 5a. Non-inventory evidence commands. A pin is ADDITIVE, so a pin that names
  //     nothing adds nothing: it cannot subtract a command, and it is reported
  //     rather than made fatal. It widens, which is why not stopping on it omits
  //     nothing. It is deliberately NOT turned into a command seed edge upstream:
  //     an unbound pin may never become a basis for including — or excluding —
  //     any unit.
  for (const escalation of input.escalations) {
    if (escalation.code === 'pinned_command_non_inventory') {
      escalationReasons.push(validationWideningReason('pinned_command_non_inventory', escalation.detail));
    }
  }

  // 5. Why nothing was reduced. These two always hold in this increment, and
  //    saying so every time is the point: silence would read as "narrowing was
  //    considered and declined", when in fact it is not implemented at all.
  escalationReasons.push(
    validationWideningReason(
      'impact_index_unusable',
      'no versioned impact index exists yet, so no changed file can be attributed to a validation command ' +
      'and there is no basis on which to run a smaller set',
    ),
    validationWideningReason(
      'command_exclusion_unproven',
      `none of the ${universe.length} executable unit(s) carries a positive current-head exclusion proof, so ` +
      'none of them may be left out',
    ),
  );

  if (input.changedFiles.status === 'changed_files_unavailable') {
    // B-a745 F-016: render the collector's BOUNDED classification, never
    // `changedFiles.error`. The raw value can be git's entire usage block and
    // stays on the structured input for diagnosis only.
    escalationReasons.push(
      validationWideningReason(
        'changed_files_unavailable',
        `the changed-file set between ${input.changedFiles.baseRef} and ${input.changedFiles.headRef} could ` +
        `not be read (${input.changedFiles.reason}: ${input.changedFiles.summary}); this is not an empty diff, ` +
        'it is an absence of knowledge',
      ),
    );
  }

  if (input.hashes.status === 'hash_snapshot_unavailable') {
    // B-a745 F-022: disclose the missing binding in the plan itself. The
    // collector's BOUNDED summary names the missing digest(s); the raw error
    // stays on the structured input for diagnosis only.
    escalationReasons.push(
      validationWideningReason(
        'hash_snapshot_unavailable',
        `the evidence hash snapshot could not be established (${input.hashes.summary}), so this plan is bound to ` +
        'no head, material or story-files digest and cannot be re-checked for freshness; nothing may be narrowed ' +
        'on its account',
      ),
    );
  }

  if (unclassifiedInputs.length > 0) {
    escalationReasons.push(
      validationWideningReason(
        'unclassified_material_input',
        `${unclassifiedInputs.length} material input(s) could not be attributed to any validation command ` +
        `(for example ${unclassifiedInputs[0].value}), so no command may be excluded on their account`,
      ),
    );
  }

  // 6. Selection step 2: a repository-full escalation sets BOTH the fast and the
  //    intermediate effective plans to U, while the artifact keeps the tier that
  //    was actually requested.
  const selectedUnitIds = universe.map((unit) => unit.id);
  const tierSelections: Record<ValidationTier, string[]> = {
    'story-fast': [...selectedUnitIds],
    'story-intermediate': [...selectedUnitIds],
    'repository-full': [...selectedUnitIds],
  };
  // Checked on the way out, so a future edit that broke containment fails here
  // instead of shipping a plan whose narrow set escapes its wide one.
  assertValidationTierSelectionSubsetInvariant(tierSelections);

  return {
    ...common,
    status: 'plan',
    effectiveTier: REPOSITORY_FULL_TIER,
    executionMode: atomic ? 'atomic' : 'command-set',
    universe,
    selectedUnitIds,
    tierSelections,
    reductionApplied: false,
    escalationReasons,
  };
}
