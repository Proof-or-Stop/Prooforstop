/**
 * B-a745 CHK-005 — the read-only `validation_plan` CLI.
 *
 * Spec: `docs/requirements/decisions/story-relevance-dynamic-validation-tiers-execution-plan.md`
 * section "Proposed CLI and UX" (owned by story B-ccf4, not yet on main).
 *
 * This is the ONLY surface of Rollout Story 1 a human touches; everything else
 * in the Story is input to it. It reads Story facts, asks the CHK-004 planner
 * what would run, and PRINTS the answer. It writes nothing, executes nothing,
 * and consumes no lifecycle gate.
 *
 * Three properties are load-bearing:
 *
 *   1. READ-ONLY BY CONTRACT AND BY MEASUREMENT. There is no write, persist,
 *      execute, run or launch flag: the catalog schema declares each of them
 *      `z.never()`, and this handler refuses them AGAIN at its entry, because a
 *      schema is only reached on the CLI path. The fixture snapshots every byte
 *      under the project root before and after invocation, so adding a store
 *      write here fails the suite rather than shipping quietly.
 *   2. `finalAuthority: no`, ALWAYS. A fast or intermediate plan is planning
 *      output, never proof that anything passed. The planner types make the
 *      field a literal `false`; this renderer prints it in every mode, including
 *      the stop and no-tier-pass paths, so no reader can mistake a narrow plan
 *      for final assurance.
 *   3. NO BARE REASON CODES. Every escalation code is printed with the
 *      plain-language gloss the CHK-004 table declares alongside it. The gloss is
 *      READ from that table (`validationWideningReasonGloss`), never restated
 *      here, so a code cannot acquire a second, drifting explanation.
 *
 * Counts are derived at runtime from the resolved plan. Nothing in this file
 * knows how many validation commands a project has.
 *
 * Deliberately NOT here: the `--focus` / `--tier` mutual rejection. That rule
 * belongs to `validate --tier` in Rollout Story 4; `validation_plan` has no
 * `--focus` flag at all, so there is nothing to reject.
 *
 * Registration shape mirrors `handlers/review-incremental-context.ts`: a handler
 * factory returning one command keyed by its schema name, wired through
 * `registry.registerBatch` in `registry.ts`.
 */

import type { HandlerContext } from './context.js';
import {
  EVIDENCE_HASH_DIGEST_NAMES,
  collectStoryRelevanceInput,
  type StoryRelevanceDurationEstimate,
  type StoryRelevanceInput,
} from '../core/validation-relevance-input.js';
import {
  VALIDATION_TIERS,
  buildValidationImpactIndexFromCatalog,
  resolveValidationTierPlan,
  validationWideningReason,
  validationWideningReasonGloss,
  type ValidationTier,
  type ValidationTierPlanResult,
  type ValidationWideningReason,
  type ValidationImpactIndex,
  type ValidationCommandExclusionProof,
} from '../core/validation-tier-planner.js';
import {
  configuredValidationCommands,
  discoverFallbackValidationCommands,
  findValidateFile,
} from './verifier.js';
import type { RoutineValidationSourceKind, ValidationCommand } from '../core/validation-types.js';
import type { SignedValidationDurationArtifact } from '../core/validation-relevance-input.js';
import { buildValidationCommandInventory } from '../core/validation-command-identity.js';
import { resolveStoryWorkspace } from '../core/story-workspace.js';
import {
  compileValidationCatalog,
  discoverValidationInventory,
} from '../core/story-aware-validation.js';

export const VALIDATION_PLAN_CLI_SCHEMA = 'proofOrStop.validation-plan-cli.v1' as const;

/**
 * The operator-facing tier names and their canonical planner vocabulary. The CLI
 * short names come from the spec's usage examples; the canonical names are
 * accepted too so a script can pass through whatever the JSON report contains.
 * There is no fourth tier and no default: an omitted tier is refused.
 */
export const VALIDATION_PLAN_TIER_ALIASES = {
  fast: 'story-fast',
  intermediate: 'story-intermediate',
  full: 'repository-full',
  'story-fast': 'story-fast',
  'story-intermediate': 'story-intermediate',
  'repository-full': 'repository-full',
} as const satisfies Record<string, ValidationTier>;

export type ValidationPlanTierInput = keyof typeof VALIDATION_PLAN_TIER_ALIASES;

/** The short names shown in refusals; the canonical spellings are accepted silently. */
export const VALIDATION_PLAN_TIER_CHOICES = ['fast', 'intermediate', 'full'] as const;

/**
 * Flag names this command refuses outright. The catalog declares each of them
 * `z.never()`, and the handler refuses them again — a caller reaching the
 * handler through MCP, a test, or an internal call never met the schema.
 */
export const VALIDATION_PLAN_REFUSED_FLAGS = [
  'write',
  'persist',
  'execute',
  'run',
  'launch',
  'apply',
  'capture',
  'refresh',
  'runCommands',
  'writeEvidence',
  'advancePhase',
  'launchReviewers',
] as const;

export interface ValidationPlanRequest {
  storyId: string;
  /** Exactly what the caller typed, preserved so the output can echo it. */
  tierInput: string;
  requestedTier: ValidationTier;
  explain: boolean;
  json: boolean;
}

function isTierInput(value: string): value is ValidationPlanTierInput {
  return Object.prototype.hasOwnProperty.call(VALIDATION_PLAN_TIER_ALIASES, value);
}

/**
 * Runtime re-validation of every constrained argument, per the Handler encoding
 * convention. The catalog's zod constraints are the FIRST line of defence only:
 * this function is also reached from internal calls and fixtures with no schema
 * anywhere in the path, and each refusal NAMES the offending field or value so
 * an operator is never left guessing.
 */
export function resolveValidationPlanRequest(rawArgs: unknown): ValidationPlanRequest {
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  for (const flag of VALIDATION_PLAN_REFUSED_FLAGS) {
    if (args[flag] !== undefined && args[flag] !== false) {
      throw new Error(
        `validation_plan: ${flag} is not a supported flag. validation_plan is read-only: it executes no ` +
        'validation command, writes no artifact, and advances no phase. Use `proof-or-stop validate` to run ' +
        'validation.',
      );
    }
  }

  const rawStoryId = args.storyId;
  if (rawStoryId !== undefined && typeof rawStoryId !== 'string') {
    throw new Error(`validation_plan: storyId must be a string, got ${JSON.stringify(rawStoryId)}`);
  }
  const storyId = (rawStoryId ?? '').trim();
  if (!storyId) {
    throw new Error('validation_plan: storyId is required (for example --storyId=B-a745)');
  }

  const rawTier = args.tier;
  if (rawTier !== undefined && typeof rawTier !== 'string') {
    throw new Error(`validation_plan: tier must be a string, got ${JSON.stringify(rawTier)}`);
  }
  const tierInput = (rawTier ?? '').trim();
  if (!tierInput) {
    throw new Error(
      `validation_plan: tier is required (one of ${VALIDATION_PLAN_TIER_CHOICES.join(', ')}). ` +
      'There is no default: which tier you asked for is part of the answer.',
    );
  }
  if (!isTierInput(tierInput)) {
    throw new Error(
      `validation_plan: unknown tier ${JSON.stringify(tierInput)} ` +
      `(expected one of ${VALIDATION_PLAN_TIER_CHOICES.join(', ')})`,
    );
  }

  return {
    storyId,
    tierInput,
    requestedTier: VALIDATION_PLAN_TIER_ALIASES[tierInput],
    explain: args.explain === true,
    json: args.json === true,
  };
}

export interface RoutineValidationSourceForPlan {
  sourceKind: RoutineValidationSourceKind;
  commands: ValidationCommand[];
}

/**
 * The same resolution order `validate` itself uses: an explicit validate file
 * wins, then configured commands, then advisory fallback discovery, and a
 * project with none of those is `no-validator`. Read-only — it only looks for
 * files and parses config.
 */
export function resolveRoutineValidationSourceForPlan(projectRoot: string): RoutineValidationSourceForPlan {
  if (findValidateFile(projectRoot)) return { sourceKind: 'validate-file', commands: [] };
  const configured = configuredValidationCommands(projectRoot);
  if (configured.length > 0) return { sourceKind: 'configured', commands: configured };
  const fallback = discoverFallbackValidationCommands(projectRoot);
  if (fallback.length > 0) return { sourceKind: 'fallback', commands: fallback };
  return { sourceKind: 'no-validator', commands: [] };
}

export function projectValidationImpactIndexForPlan(
  args: {
    projectRoot: string;
    routine: RoutineValidationSourceForPlan;
    commandSetDigest: string;
    configuredImpactIndex?: ValidationImpactIndex;
  },
  dependencies: {
    discover?: typeof discoverValidationInventory;
    compile?: typeof compileValidationCatalog;
    project?: typeof buildValidationImpactIndexFromCatalog;
  } = {},
): { impactIndex?: ValidationImpactIndex; failure?: string } {
  // Legacy configured indexes are advisory only; execution owns the catalog.
  if (args.routine.sourceKind !== 'configured') return {};
  try {
    const discover = dependencies.discover ?? discoverValidationInventory;
    const compile = dependencies.compile ?? compileValidationCatalog;
    const project = dependencies.project ?? buildValidationImpactIndexFromCatalog;
    return {
      impactIndex: project({
        commandSetDigest: args.commandSetDigest,
        catalog: compile(discover(args.projectRoot)),
      }),
    };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

export function attachImpactProjectionFailure(
  result: ValidationTierPlanResult,
  failure: string | undefined,
): ValidationTierPlanResult {
  if (!failure) return result;
  const detail = `catalog projection failed: ${failure}`;
  const hasImpactReason = result.escalationReasons.some((reason) => reason.code === 'impact_index_unusable');
  return {
    ...result,
    escalationReasons: hasImpactReason
      ? result.escalationReasons.map((reason) => reason.code === 'impact_index_unusable'
        ? { ...reason, detail: `${reason.detail}; ${detail}` }
        : reason)
      : [...result.escalationReasons, validationWideningReason('impact_index_unusable', detail)],
  };
}

// ---------------------------------------------------------------------------
// Report shape. The human text and the --json object are rendered from ONE
// report, so they cannot report different facts.
// ---------------------------------------------------------------------------

export interface ValidationPlanUnitReport {
  id: string;
  kind: 'command' | 'atomic';
  label: string;
  selected: boolean;
  /** Reason CODES; the gloss for each is in `escalationReasons`. Never empty. */
  inclusionReasons: string[];
  /** Checklist evidence pins that resolved to this unit, if any. */
  pinnedBy: Array<{ itemId: string; intentRef: string; pinResolution: string }>;
  duration: { status: 'known' | 'unknown-duration'; estimateMs?: number; basis: string };
}

export interface ValidationPlanReport {
  schema: typeof VALIDATION_PLAN_CLI_SCHEMA;
  storyId: string;
  storyPhase: string;
  status: ValidationTierPlanResult['status'];
  requestedTierInput: string;
  requestedTier: ValidationTier;
  effectiveTier: ValidationTier | null;
  executionMode: 'command-set' | 'atomic' | null;
  sourceKind: RoutineValidationSourceKind;
  finalAuthority: false;
  reductionApplied: boolean;
  counts: { selected: number; total: number };
  tierSelections: Record<ValidationTier, number> | null;
  units: ValidationPlanUnitReport[];
  escalationReasons: Array<{ code: string; outcome: string; gloss: string; detail: string }>;
  unclassifiedInputs: Array<{ kind: string; value: string; detail: string }>;
  durationEstimate: {
    knownCount: number;
    unknownCount: number;
    knownTotalMs: number;
    basis: string;
  };
  commandSetDigest: string;
  /** Collector input digest; stable meaning on compatibility and indexed paths. */
  selectionDigest: string;
  /** Present only when the canonical impact-index selector made the decision. */
  selectorDecisionDigest: string | null;
  /** Positive omission evidence from the selector; never a PASS artifact. */
  exclusionProofs: ValidationCommandExclusionProof[];
  /**
   * B-a745 F-022. The freshness binding the plan was made under. `bound` carries
   * all three digests; `unbound` means the collector could not establish them,
   * and a `status: plan` report must then carry `hash_snapshot_unavailable` in
   * `escalationReasons`. There is no third shape: a null digest never renders
   * under the word "bound" (enforced by {@link assertValidationPlanStatusInvariant}).
   */
  freshnessBinding: ValidationPlanFreshnessBinding;
  /**
   * Inventory warnings exactly as the CHK-001 identity builder emitted them —
   * notably the migration warning naming how many commands still rely on a
   * provisional id. Surfaced rather than swallowed: a warning nobody prints is
   * a warning that does not exist.
   */
  inventoryWarnings: string[];
  /** No selection artifact is written by this read-only command. Ever. */
  artifact: { written: false; path: null; digest: null; note: string };
}

export type ValidationPlanFreshnessBinding =
  | { status: 'bound'; headHash: string; materialHash: string; storyFilesHash: string }
  | { status: 'unbound'; summary: string };

function freshnessBindingFor(input: StoryRelevanceInput): ValidationPlanFreshnessBinding {
  if (input.hashes.status !== 'available') {
    return { status: 'unbound', summary: input.hashes.summary };
  }
  // The collector never labels a partial snapshot available and the planner
  // re-validates that; this is the render-side copy of the same rule so the
  // report cannot carry a null under "bound" even if both were bypassed.
  const missing = EVIDENCE_HASH_DIGEST_NAMES.filter((name) => typeof input.hashes.status === 'string'
    && input.hashes.status === 'available'
    && (typeof input.hashes.head[name] !== 'string' || input.hashes.head[name]!.trim() === ''));
  if (missing.length > 0) {
    throw new Error(
      `validation_plan: the relevance input labels its hash snapshot available but carries no ${missing.join(', ')}; ` +
      'a plan may not render a binding it does not have',
    );
  }
  return {
    status: 'bound',
    headHash: input.hashes.head.headHash!,
    materialHash: input.hashes.head.materialHash!,
    storyFilesHash: input.hashes.head.storyFilesHash!,
  };
}

const WIDENING_OUTCOMES_THAT_INCLUDE = new Set(['repository-full', 'atomic-repository-full']);

function reasonEntry(reason: ValidationWideningReason) {
  return {
    code: reason.code,
    outcome: reason.outcome,
    // Read from the CHK-004 table, never restated here.
    gloss: validationWideningReasonGloss(reason.code),
    detail: reason.detail,
  };
}

function durationFor(
  unitId: string,
  estimates: readonly StoryRelevanceDurationEstimate[],
  atomic: boolean,
): ValidationPlanUnitReport['duration'] {
  const estimate = estimates.find((entry) => entry.commandId === unitId);
  if (estimate) {
    // An unknown duration carries NO numeric field: a 0 would read as "instant".
    return estimate.status === 'known' && typeof estimate.estimateMs === 'number'
      ? { status: 'known', estimateMs: estimate.estimateMs, basis: estimate.basis }
      : { status: 'unknown-duration', basis: estimate.basis };
  }
  return {
    status: 'unknown-duration',
    basis: atomic
      ? 'this source kind runs validation as one opaque unit, so no per-command duration history exists'
      : 'no prior signed validation receipt recorded for this unit',
  };
}

export function buildValidationPlanReport(args: {
  request: ValidationPlanRequest;
  storyPhase: string;
  input: StoryRelevanceInput;
  result: ValidationTierPlanResult;
  /**
   * Human-readable labels by stable command id. Display only: the planner
   * identifies a unit by its stable id, and a label is never an identity input.
   */
  unitLabels?: ReadonlyMap<string, string>;
}): ValidationPlanReport {
  const { request, storyPhase, input, result } = args;
  const unitLabels = args.unitLabels ?? new Map<string, string>();
  const escalationReasons = result.escalationReasons.map(reasonEntry);
  const includedBecause = escalationReasons
    .filter((reason) => WIDENING_OUTCOMES_THAT_INCLUDE.has(reason.outcome))
    .map((reason) => reason.code);

  const units: ValidationPlanUnitReport[] = [];
  let counts = { selected: 0, total: 0 };
  let tierSelections: Record<ValidationTier, number> | null = null;

  if (result.status === 'plan') {
    const selected = new Set(result.selectedUnitIds);
    const atomic = result.executionMode === 'atomic';
    for (const unit of result.universe) {
      const selectorReasons = result.inclusionReasonsByCommand?.[unit.id] ?? [];
      const proof = result.exclusionProofs?.find((entry) => entry.commandId === unit.id);
      const unitReasons = selectorReasons.length > 0
        ? selectorReasons
        : proof
          ? [`omitted:${proof.reason}`]
          : includedBecause.length > 0
            ? [...includedBecause]
            : escalationReasons.map((reason) => reason.code);
      units.push({
        id: unit.id,
        kind: unit.kind,
        label: unitLabels.get(unit.id) ?? unit.label,
        selected: selected.has(unit.id),
        inclusionReasons: unitReasons.length > 0 ? unitReasons : ['repository-full:compatibility'],
        pinnedBy: input.pinnedCommands
          .filter((pin) => pin.commandId === unit.id)
          .map((pin) => ({ itemId: pin.itemId, intentRef: pin.intentRef, pinResolution: pin.pinResolution })),
        duration: durationFor(unit.id, input.durationHistory.estimates, atomic),
      });
    }
    counts = { selected: result.selectedUnitIds.length, total: result.universe.length };
    tierSelections = {
      'story-fast': result.tierSelections['story-fast'].length,
      'story-intermediate': result.tierSelections['story-intermediate'].length,
      'repository-full': result.tierSelections['repository-full'].length,
    };
  }

  const selectedUnits = units.filter((unit) => unit.selected);
  const knownUnits = selectedUnits.filter((unit) => unit.duration.status === 'known');
  const knownTotalMs = knownUnits.reduce((total, unit) => total + (unit.duration.estimateMs ?? 0), 0);
  const historyBasis = input.durationHistory.status === 'unavailable'
    // B-a745 F-016: the bounded readSummary, never the raw readError.
    ? `duration history could not be read (${input.durationHistory.readSummary ?? 'unknown error'}), so every ` +
      'estimate is unknown; duration is estimate-only and never changes what runs'
    : `${knownUnits.length} of ${selectedUnits.length} selected unit(s) have prior signed validation receipts ` +
      `(${input.durationHistory.sampleCount} sample(s) read); the remaining ` +
      `${selectedUnits.length - knownUnits.length} report unknown-duration rather than zero. Duration is ` +
      'estimate-only and never changes what runs.';

  return {
    schema: VALIDATION_PLAN_CLI_SCHEMA,
    storyId: result.storyId,
    storyPhase,
    status: result.status,
    requestedTierInput: request.tierInput,
    requestedTier: result.requestedTier,
    effectiveTier: result.status === 'plan' ? result.effectiveTier : null,
    executionMode: result.status === 'plan' ? result.executionMode : null,
    sourceKind: result.sourceKind,
    finalAuthority: false,
    reductionApplied: result.status === 'plan' ? result.reductionApplied : false,
    counts,
    tierSelections,
    units,
    escalationReasons,
    unclassifiedInputs: result.unclassifiedInputs.map((entry) => ({
      kind: entry.kind,
      value: entry.value,
      detail: entry.detail,
    })),
    durationEstimate: {
      knownCount: knownUnits.length,
      unknownCount: selectedUnits.length - knownUnits.length,
      knownTotalMs,
      basis: historyBasis,
    },
    commandSetDigest: input.executionInventory.commandSetDigest,
    selectionDigest: input.selectionDigest,
    selectorDecisionDigest: result.status === 'plan' ? result.selectorDecisionDigest ?? null : null,
    exclusionProofs: result.status === 'plan' ? [...(result.exclusionProofs ?? [])] : [],
    freshnessBinding: freshnessBindingFor(input),
    inventoryWarnings: [...input.executionInventory.warnings],
    artifact: {
      written: false,
      path: null,
      digest: null,
      note:
        'validation_plan is explain-only and writes no selection artifact. A selection artifact is produced ' +
        'by executing tiers in a later Rollout Story, not by this command.',
    },
  };
}

// ---------------------------------------------------------------------------
// The status discriminator (B-a745 F-002).
// ---------------------------------------------------------------------------

/**
 * THE line a machine selector must key on to tell a produced plan from a
 * refusal. One line per outcome, stable, greppable, and mutually exclusive.
 *
 * Why this table exists at all: `finalAuthority: no` is printed on EVERY branch
 * and that is correct — a stop is not final authority either — but it therefore
 * discriminates NOTHING. A recorded receipt for this Story's own flagship claim
 * pinned exactly that string as its selector, so the selector matched while the
 * command was stopping with `selected: 0 of 0`, and the evidence was stamped
 * `result: pass` with the failing output sitting in its own `outputTail`.
 *
 * The remedy is not to drop `finalAuthority: no`; it is to guarantee that a
 * DISCRIMINATING line always exists and that nothing shared between two
 * different outcomes' renders can be mistaken for one. Pin `status: plan` (or
 * `status: stop`) to assert an outcome; never pin a line this module prints
 * unconditionally.
 */
export const VALIDATION_PLAN_STATUS_LINES = {
  plan: 'status: plan',
  stop: 'status: stop',
  'no-tier-pass': 'status: no-tier-pass',
} as const satisfies Record<ValidationTierPlanResult['status'], string>;

/**
 * Line prefixes whose VALUE depends on the outcome. No line starting with one of
 * these may ever be byte-identical across two different outcomes' renders — the
 * fixture enforces that by intersecting a plan render with a stop render. Adding
 * a new outcome-bearing line means adding its prefix here, deliberately.
 */
export const VALIDATION_PLAN_OUTCOME_BEARING_LINE_PREFIXES = [
  'status:',
  'effectiveTier:',
  'executionMode:',
  'selected:',
  'tierSelection ',
] as const;

/**
 * Runtime re-validation at the render boundary, per the Handler encoding
 * convention. It binds the status WORD to the facts that make it true, so a
 * report carrying refusal-shaped facts cannot render `status: plan`.
 *
 * Enforced at exactly ONE place: {@link renderValidationPlanReport}, the choke
 * point every consumption of a report passes through (the CLI handler's text
 * and `--json` branches, and {@link renderValidationPlanText}, which is a thin
 * alias of the text branch). It is deliberately not called from the text body
 * or the handler as well: a second call site is a second place to forget
 * (B-a745 F-006 class), and the F-024/F-025 defect was precisely a branch that
 * did not pass through the guard.
 *
 *   status === 'plan'  <=>  an effective tier, an execution mode, tier
 *                           selections and a non-empty selection all exist.
 *
 * The equivalence is checked in BOTH directions. Without the reverse direction a
 * future edit could quietly produce a `stop` that still carried a selection, and
 * the discriminator would stop meaning what a reader assumes it means.
 */
export function assertValidationPlanStatusInvariant(report: ValidationPlanReport): string {
  const statusLine = VALIDATION_PLAN_STATUS_LINES[report.status];
  if (!statusLine) {
    throw new Error(
      `validation_plan: unknown result status ${JSON.stringify(report.status)} ` +
      `(expected one of ${Object.keys(VALIDATION_PLAN_STATUS_LINES).join(', ')})`,
    );
  }
  const planShaped =
    report.effectiveTier !== null &&
    report.executionMode !== null &&
    report.tierSelections !== null &&
    report.counts.total > 0 &&
    report.counts.selected > 0;
  if (report.status === 'plan' && !planShaped) {
    throw new Error(
      'validation_plan: a report rendering "status: plan" must carry an effective tier, an execution mode, ' +
      'tier selections and a non-empty selection; this one does not, so it would render a plan discriminator ' +
      'for a result that planned nothing',
    );
  }
  if (report.status !== 'plan' && planShaped) {
    throw new Error(
      `validation_plan: a ${report.status} result may not carry plan-shaped facts (effective tier, execution ` +
      'mode and a non-empty selection); "status: plan" is the only line that may assert those',
    );
  }
  if (report.status !== 'plan' && (report.counts.selected !== 0 || report.units.length !== 0)) {
    throw new Error(`validation_plan: a ${report.status} result selects nothing at all and lists no unit`);
  }
  if (report.status === 'plan') {
    const unexplained = report.units.filter(
      (unit) => !Array.isArray(unit.inclusionReasons) || unit.inclusionReasons.length === 0,
    );
    if (unexplained.length > 0) {
      throw new Error(
        `validation_plan: every planned unit must explain its inclusion or omission; missing for ` +
        unexplained.map((unit) => unit.id).join(', '),
      );
    }
    const selectedUnits = report.units.filter((unit) => unit.selected);
    if (report.units.length !== report.counts.total || selectedUnits.length !== report.counts.selected) {
      throw new Error(
        'validation_plan: report counts must equal the rendered unit inventory and its selected flags',
      );
    }
    const expectedReduction = report.counts.selected < report.counts.total;
    if (report.reductionApplied !== expectedReduction) {
      throw new Error(
        `validation_plan: reductionApplied must equal selected < total; got ${report.reductionApplied} for ` +
        `${report.counts.selected} of ${report.counts.total}`,
      );
    }
    const omittedIds = new Set(report.units.filter((unit) => !unit.selected).map((unit) => unit.id));
    const proofCounts = new Map<string, number>();
    for (const proof of report.exclusionProofs) {
      proofCounts.set(proof.commandId, (proofCounts.get(proof.commandId) ?? 0) + 1);
      if (!omittedIds.has(proof.commandId)) {
        throw new Error(
          `validation_plan: exclusion proof for ${proof.commandId} does not identify an omitted unit`,
        );
      }
    }
    for (const unit of report.units) {
      const omissionReasons = unit.inclusionReasons.filter((reason) => reason.startsWith('omitted:'));
      if (!unit.selected && (proofCounts.get(unit.id) !== 1 || omissionReasons.length !== unit.inclusionReasons.length)) {
        throw new Error(
          `validation_plan: omitted unit ${unit.id} must carry exactly one positive exclusion proof and only ` +
          'omission-shaped reasons',
        );
      }
      if (unit.selected && (proofCounts.has(unit.id) || omissionReasons.length > 0)) {
        throw new Error(
          `validation_plan: selected unit ${unit.id} may not carry an exclusion proof or omission-shaped reason`,
        );
      }
    }
  }
  // B-a745 F-022: the binding is part of what "status: plan" asserts. A plan
  // either binds freshness (all three digests present) or SAYS it could not
  // (unbound, with hash_snapshot_unavailable disclosed). A null under "bound"
  // and an undisclosed unbound plan are both refused before any render.
  const binding = report.freshnessBinding as ValidationPlanFreshnessBinding | undefined;
  if (!binding || typeof binding !== 'object' || typeof binding.status !== 'string') {
    throw new Error(
      'validation_plan: the report carries no freshnessBinding; a plan must either bind freshness or say it could not',
    );
  }
  if (binding.status === 'bound') {
    const record = binding as unknown as Record<string, unknown>;
    const missing = EVIDENCE_HASH_DIGEST_NAMES.filter((name) => typeof record[name] !== 'string' || (record[name] as string).trim() === '');
    if (missing.length > 0) {
      throw new Error(
        `validation_plan: freshnessBinding claims "bound" but ${missing.join(', ')} is null; a report may not render ` +
        'a binding it does not have',
      );
    }
  } else if (binding.status === 'unbound') {
    if (report.status === 'plan' && !report.escalationReasons.some((reason) => reason.code === 'hash_snapshot_unavailable')) {
      throw new Error(
        'validation_plan: a "status: plan" report whose freshness binding is unbound must disclose ' +
        'hash_snapshot_unavailable among its escalation reasons',
      );
    }
  } else {
    throw new Error(`validation_plan: unknown freshnessBinding status ${JSON.stringify((binding as { status: unknown }).status)}`);
  }
  return statusLine;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** How many units are listed without `--explain` before the list is summarised. */
const UNIT_PREVIEW_LIMIT = 5;

/**
 * The ONE render entry point for a validation plan report, whichever shape is
 * asked for. The status invariant runs here, before the text/JSON branch, so a
 * report whose status word contradicts its own facts never reaches an operator,
 * a selector, or a `--json` consumer (B-a745 F-024/F-025: the JSON branch used
 * to bypass the guard). Nothing else may call the invariant; add a new output
 * shape as a branch below, not as a new caller.
 */
export function renderValidationPlanReport(
  report: ValidationPlanReport,
  options: { json: boolean; explain: boolean },
): string {
  const statusLine = assertValidationPlanStatusInvariant(report);
  return options.json ? JSON.stringify(report) : renderValidationPlanTextLines(report, options.explain, statusLine);
}

/** Text shape only; routes through {@link renderValidationPlanReport} so the invariant is not duplicated. */
export function renderValidationPlanText(report: ValidationPlanReport, explain: boolean): string {
  return renderValidationPlanReport(report, { json: false, explain });
}

/**
 * Text body. Takes the already-checked status line rather than re-deriving it,
 * so it cannot be reached with an unchecked report through any exported path.
 */
function renderValidationPlanTextLines(report: ValidationPlanReport, explain: boolean, statusLine: string): string {
  const lines: string[] = [];
  lines.push(`validation_plan: ${report.storyId}`);
  lines.push(`storyPhase: ${report.storyPhase}`);
  // THE discriminator. Read from the table so the printed text and the value a
  // selector is told to pin cannot drift apart.
  lines.push(statusLine);
  lines.push(`requestedTier: ${report.requestedTier} (requested as "${report.requestedTierInput}")`);
  if (report.effectiveTier) lines.push(`effectiveTier: ${report.effectiveTier}`);
  lines.push(`sourceKind: ${report.sourceKind}`);
  if (report.executionMode) lines.push(`executionMode: ${report.executionMode}`);
  lines.push(`selected: ${report.counts.selected} of ${report.counts.total} validation unit(s)`);
  if (report.tierSelections) {
    for (const tier of VALIDATION_TIERS) {
      lines.push(`tierSelection ${tier}: ${report.tierSelections[tier]} unit(s)`);
    }
  }
  lines.push(`reductionApplied: ${report.reductionApplied}`);
  // B-a745 F-022: the binding is disclosed on every branch. Not outcome-bearing
  // (a plan and a stop over the same tree share it), so not a discriminator.
  lines.push(
    report.freshnessBinding.status === 'bound'
      ? `freshnessBinding: bound (head ${report.freshnessBinding.headHash}, material ` +
        `${report.freshnessBinding.materialHash}, storyFiles ${report.freshnessBinding.storyFilesHash})`
      : `freshnessBinding: unbound (${report.freshnessBinding.summary})`,
  );
  // Printed on EVERY branch on purpose, and therefore NOT a discriminator: see
  // VALIDATION_PLAN_STATUS_LINES. Pinning this line proves only that the command
  // ran, never that it produced a plan.
  lines.push('finalAuthority: no');
  lines.push(
    '  This is explain-only planning output. It is not evidence that anything passed, and a fast or ' +
    'intermediate plan is never final authority.',
  );
  lines.push(`artifact: none (${report.artifact.note})`);
  lines.push('');

  lines.push(`escalation reasons (${report.escalationReasons.length}):`);
  if (report.escalationReasons.length === 0) {
    lines.push('  (none)');
  }
  for (const reason of report.escalationReasons) {
    lines.push(`  [${reason.code}] outcome=${reason.outcome}`);
    lines.push(`    gloss: ${reason.gloss}`);
    lines.push(`    detail: ${reason.detail}`);
  }
  lines.push('');

  lines.push(`inclusion reasons by unit (${report.units.length}):`);
  if (report.units.length === 0) {
    lines.push('  (none: this result plans no execution at all)');
  }
  const shown = explain ? report.units : report.units.slice(0, UNIT_PREVIEW_LIMIT);
  for (const unit of shown) {
    lines.push(`  ${unit.id} [${unit.label}]`);
    lines.push(`    ${unit.selected ? 'included' : 'excluded'}: ${unit.inclusionReasons.join(', ')}`);
    for (const pin of unit.pinnedBy) {
      lines.push(`    pinned by ${pin.itemId} ${pin.intentRef} (${pin.pinResolution})`);
    }
    lines.push(
      `    estimatedDuration: ${unit.duration.status === 'known' && unit.duration.estimateMs !== undefined
        ? formatMs(unit.duration.estimateMs)
        : 'unknown'} — ${unit.duration.basis}`,
    );
  }
  if (shown.length < report.units.length) {
    lines.push(`  ... ${report.units.length - shown.length} more unit(s); rerun with --explain to list every one`);
  }
  lines.push('');

  lines.push(`exclusion proofs (${report.exclusionProofs.length}):`);
  if (report.exclusionProofs.length === 0) {
    lines.push('  (none)');
  } else if (!explain) {
    lines.push('  available; rerun with --explain to inspect every snapshot-bound proof');
  } else {
    for (const proof of report.exclusionProofs) {
      lines.push(`  ${proof.commandId}: ${proof.reason}`);
      lines.push(
        `    requested=${proof.requestedTier}, declared=${proof.declaredSelection}, ` +
        `index=${proof.indexVersion}/${proof.indexDigest}, snapshot=${proof.snapshotDigest}`,
      );
      lines.push(`    command inputs: ${proof.commandInputPatterns.join(', ') || '(none)'}`);
    }
  }
  lines.push('');

  lines.push(`unclassified inputs (${report.unclassifiedInputs.length}):`);
  if (report.unclassifiedInputs.length === 0) {
    lines.push('  (none)');
  }
  const unclassifiedShown = explain
    ? report.unclassifiedInputs
    : report.unclassifiedInputs.slice(0, UNIT_PREVIEW_LIMIT);
  for (const entry of unclassifiedShown) {
    lines.push(`  [${entry.kind}] ${entry.value}`);
    lines.push(`    ${entry.detail}`);
  }
  if (unclassifiedShown.length < report.unclassifiedInputs.length) {
    lines.push(
      `  ... ${report.unclassifiedInputs.length - unclassifiedShown.length} more input(s); rerun with --explain ` +
      'to list every one',
    );
  }
  lines.push('');

  lines.push(
    `estimatedDuration: ${formatMs(report.durationEstimate.knownTotalMs)} across ` +
    `${report.durationEstimate.knownCount} unit(s) with history, ` +
    `${report.durationEstimate.unknownCount} unit(s) unknown`,
  );
  lines.push(`  basis: ${report.durationEstimate.basis}`);
  lines.push(`inventoryWarnings (${report.inventoryWarnings.length}):`);
  if (report.inventoryWarnings.length === 0) lines.push('  (none)');
  for (const warning of report.inventoryWarnings) lines.push(`  ${warning}`);
  lines.push(`commandSetDigest: ${report.commandSetDigest}`);
  lines.push(`selectionDigest: ${report.selectionDigest}`);
  if (report.selectorDecisionDigest) lines.push(`selectorDecisionDigest: ${report.selectorDecisionDigest}`);
  return lines.join('\n');
}

export function createValidationPlanHandlers(ctx: HandlerContext) {
  const { root } = ctx;
  return {
    validation_plan(rawArgs: {
      storyId: string;
      tier: string;
      explain?: boolean;
      json?: boolean;
    }): string {
      const request = resolveValidationPlanRequest(rawArgs);

      // B-a745 F-010: diff and hash the STORY's tree, never the tree this
      // read-only command happens to be invoked from. validation_plan is allowed
      // from any cwd (main checkout, wrapper root, the worktree itself), so the
      // story's workspace is resolved through the one owner every sibling site
      // uses (B-41c8 CHK-003, core/story-workspace.ts): gitCwd from the same
      // resolveGitCwd choke-point as verifier / done-prepare / red-evidence,
      // and — when the story's tree is a different checkout that carries its
      // own copy of the metadata — THAT checkout's store and config, because
      // the story record, checklist and command inventory evolve on the story
      // branch and main's committed copies are the stale INIT snapshot. A tree
      // without the metadata (a wrapper-root layout keeps it outside git) falls
      // back to the invocation root; nothing is written either way. No cwd gate
      // is added on purpose; the command must simply look at the right tree.
      //
      // terminalPhaseGuard=true (B-41c8 F-004, closing B-a745 F-014): a DONE /
      // DISCARDED story is never planned from a linked worktree. Before CHK-003
      // this handler applied no guard, so a just-merged story whose worktree had
      // not been cleaned up yet was still planned over that residue while
      // story_list / session_brief already refused it; the plan now agrees with
      // them and reads the invocation root (a merged-and-removed worktree
      // cannot be read and lands there either way).
      const workspace = resolveStoryWorkspace(ctx, request.storyId, { terminalPhaseGuard: true });
      const gitCwd = workspace.gitCwd;
      const storyStore = workspace.store;
      // The plan's project root is the story's tree as gitCwd spells it (its
      // canonical path) whenever that tree carries the story — a linked
      // worktree, or the invocation root itself — so the report is the same
      // from every cwd spelling (a symlinked tmpdir, a relative path). Only a
      // tree with no story copy falls back to the invocation root as given.
      const projectRoot = workspace.rootReason === 'no-story-copy' ? root : workspace.gitCwd;

      const story = workspace.story;
      const checklist = storyStore.readChecklist(request.storyId);
      const routine = resolveRoutineValidationSourceForPlan(projectRoot);
      const doneRequired = storyStore.readDoneRequiredEvidence(request.storyId);
      const artifacts: SignedValidationDurationArtifact[] = doneRequired
        ? [doneRequired as unknown as SignedValidationDurationArtifact]
        : [];

      const input = collectStoryRelevanceInput({
        projectRoot,
        gitCwd,
        metadataRoot: projectRoot,
        story: {
          storyId: request.storyId,
          phase: story.phase,
          ...(story.riskSignals ? { riskSignals: story.riskSignals } : {}),
        },
        checklist: { items: checklist.items ?? [] },
        routine,
        durationHistory: { artifacts },
      });

      const projectConfig = workspace.config;
      const validationConfig = projectConfig.validate ?? projectConfig.validation;
      const configuredImpactIndex = validationConfig?.dynamic?.impactIndex as ValidationImpactIndex | undefined;
      const projection = projectValidationImpactIndexForPlan({
        projectRoot,
        routine,
        commandSetDigest: input.executionInventory.commandSetDigest,
        configuredImpactIndex,
      });
      const impactIndex = projection.impactIndex;
      const impactProjectionFailure = projection.failure ?? '';
      const unresolvedResult = resolveValidationTierPlan({
        input,
        requestedTier: request.requestedTier,
        ...(impactIndex ? { impactIndex } : {}),
      });
      const result = attachImpactProjectionFailure(unresolvedResult, impactProjectionFailure);

      // Display labels, resolved through the SAME canonical inventory builder the
      // ids came from, so a label can never be attached to the wrong unit. A label
      // is never an identity input; it exists so an operator recognises the row.
      const unitLabels = new Map<string, string>();
      if (routine.commands.length > 0) {
        for (const entry of buildValidationCommandInventory({ commands: routine.commands }).entries) {
          unitLabels.set(entry.id, entry.label);
        }
      }

      const report = buildValidationPlanReport({
        request,
        storyPhase: story.phase,
        input,
        result,
        unitLabels,
      });
      if (configuredImpactIndex !== undefined) {
        report.inventoryWarnings.push('validate.dynamic.impactIndex is deprecated and ignored; command input ownership comes from the production validation catalog.');
      }

      return renderValidationPlanReport(report, { json: request.json, explain: request.explain });
    },
  };
}
