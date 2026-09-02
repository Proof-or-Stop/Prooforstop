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
  collectStoryRelevanceInput,
  type StoryRelevanceDurationEstimate,
  type StoryRelevanceInput,
} from '../core/validation-relevance-input.js';
import {
  VALIDATION_TIERS,
  resolveValidationTierPlan,
  validationWideningReasonGloss,
  type ValidationTier,
  type ValidationTierPlanResult,
  type ValidationWideningReason,
} from '../core/validation-tier-planner.js';
import {
  configuredValidationCommands,
  discoverFallbackValidationCommands,
  findValidateFile,
} from './verifier.js';
import type { RoutineValidationSourceKind, ValidationCommand } from '../core/validation-types.js';
import type { SignedValidationDurationArtifact } from '../core/validation-relevance-input.js';
import { buildValidationCommandInventory } from '../core/validation-command-identity.js';

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
  selectionDigest: string;
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
      units.push({
        id: unit.id,
        kind: unit.kind,
        label: unitLabels.get(unit.id) ?? unit.label,
        selected: selected.has(unit.id),
        inclusionReasons: includedBecause.length > 0 ? [...includedBecause] : escalationReasons.map((r) => r.code),
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
    ? `duration history could not be read (${input.durationHistory.readError ?? 'unknown error'}), so every ` +
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

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** How many units are listed without `--explain` before the list is summarised. */
const UNIT_PREVIEW_LIMIT = 5;

export function renderValidationPlanText(report: ValidationPlanReport, explain: boolean): string {
  const lines: string[] = [];
  lines.push(`validation_plan: ${report.storyId}`);
  lines.push(`storyPhase: ${report.storyPhase}`);
  lines.push(`status: ${report.status}`);
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
  return lines.join('\n');
}

export function createValidationPlanHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;
  return {
    validation_plan(rawArgs: {
      storyId: string;
      tier: string;
      explain?: boolean;
      json?: boolean;
    }): string {
      const request = resolveValidationPlanRequest(rawArgs);

      const story = store.readStory(request.storyId);
      const checklist = store.readChecklist(request.storyId);
      const routine = resolveRoutineValidationSourceForPlan(root);
      const doneRequired = store.readDoneRequiredEvidence(request.storyId);
      const artifacts: SignedValidationDurationArtifact[] = doneRequired
        ? [doneRequired as unknown as SignedValidationDurationArtifact]
        : [];

      const input = collectStoryRelevanceInput({
        projectRoot: root,
        gitCwd: root,
        metadataRoot: root,
        story: {
          storyId: request.storyId,
          phase: story.phase,
          ...(story.riskSignals ? { riskSignals: story.riskSignals } : {}),
        },
        checklist: { items: checklist.items ?? [] },
        routine,
        durationHistory: { artifacts },
      });

      const result = resolveValidationTierPlan({ input, requestedTier: request.requestedTier });

      // Display labels, resolved through the SAME canonical inventory builder the
      // ids came from, so a label can never be attached to the wrong unit. A label
      // is never an identity input; it exists so an operator recognises the row.
      const unitLabels = new Map<string, string>();
      if (routine.commands.length > 0) {
        for (const entry of buildValidationCommandInventory({ projectRoot: root, commands: routine.commands }).entries) {
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

      return request.json ? JSON.stringify(report) : renderValidationPlanText(report, request.explain);
    },
  };
}
