/**
 * B-a745 CHK-004 — language-neutral planner types and the fail-closed widening
 * matrix.
 *
 * Design source: the branch-owned
 * `docs/requirements/decisions/story-relevance-dynamic-validation-tiers-execution-plan.md`.
 * Shipped matrix authority:
 * `docs/requirements/decisions/validation-widening-matrix-authority.md` and
 * `docs/validation-performance.md`.
 *
 * The compatibility path remains fail-closed repository-full. A configured,
 * command-set-bound impact index may now opt into the pure
 * `selectValidationTiers` path; every omitted command then carries a positive
 * exclusion proof tied to the current snapshot. Missing, stale, partial or
 * ambiguous evidence still widens all three memberships to repository-full.
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
 * This module reads no state, writes nothing, and executes nothing. The read-only
 * validation_plan CLI explains its output, while the same automatic selector is
 * consumed by the dynamic validate adapter and bound into its signed manifest.
 * A selector decision alone still grants no lifecycle authority, so every result
 * says `finalAuthority: false`; the runtime authority gate decides admission.
 */

import {
  evidenceMaterialDirtyFiles,
  missingEvidenceHashDigests,
  type StoryRelevanceInput,
} from './validation-relevance-input.js';
import type { RoutineValidationSourceKind } from './validation-types.js';
import { digestCanonicalJson } from './digest.js';
import { collectRepositoryFullProcessFactPaths } from './process-fact-registry.js';

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

/** Canonical spelling of the full tier and every fail-closed fallback. */
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
// Evidence-backed dynamic tier membership.
// ---------------------------------------------------------------------------

export const VALIDATION_IMPACT_INDEX_SCHEMA = 'proofOrStop.validation-impact-index.v1' as const;

export type ValidationImpactSelection = ValidationTier | 'always';

/**
 * One command's complete, reviewable ownership declaration. `coverage` is not
 * an estimate: `complete` asserts that `inputPatterns` names every material
 * path capable of affecting the command. A partial declaration makes the whole
 * narrowing decision fail closed; it may not be used to exclude anything.
 */
export interface ValidationImpactIndexEntry {
  commandId: string;
  selection: ValidationImpactSelection;
  inputPatterns: string[];
  coverage: 'complete' | 'partial';
  /** Required when a direct match must widen the request to repository-full. */
  fullReason?: ValidationWideningReasonCode;
}

export interface ValidationImpactIndex {
  schema: typeof VALIDATION_IMPACT_INDEX_SCHEMA;
  version: string;
  commandSetDigest: string;
  entries: ValidationImpactIndexEntry[];
}

export interface ValidationImpactCatalogEntry {
  id: string;
  assurance: 'always' | 'story-selectable' | 'full-only';
  riskTier: 'local' | 'shared' | 'gate' | 'validation-infra';
  closurePolicy?: 'static-and-traced' | 'whole-repository' | 'never-reuse';
  policySource: 'explicit' | 'default';
  inputRoots: readonly string[];
  selectionInputRoots?: readonly string[];
  selectionInputCoverage?: 'complete' | 'partial';
  selectionInputCoverageSource?: 'declared' | 'dual-revision-graph' | 'heuristic';
  triggerExtensions?: { files?: readonly string[] };
}

/**
 * Project the production validation catalog into the canonical tier selector's
 * versioned ownership map.  This is the bridge that keeps explanation and
 * execution on one membership authority instead of maintaining a second list.
 * A defaulted or pathless row is deliberately partial and therefore widens.
 */
export function buildValidationImpactIndexFromCatalog(args: {
  commandSetDigest: string;
  catalog: readonly ValidationImpactCatalogEntry[];
}): ValidationImpactIndex {
  const entries: ValidationImpactIndexEntry[] = args.catalog.map((entry) => {
    const inputPatterns = [...new Set([
      ...(entry.selectionInputRoots ?? entry.inputRoots ?? []),
      ...(entry.triggerExtensions?.files ?? []),
    ].map(normalizedPath).filter(Boolean))].sort();
    const selection: ValidationImpactSelection = entry.assurance === 'always'
      ? 'always'
      : entry.assurance === 'full-only' || entry.closurePolicy === 'whole-repository'
        || entry.riskTier === 'gate' || entry.riskTier === 'validation-infra'
        ? REPOSITORY_FULL_TIER
        : entry.riskTier === 'shared'
          ? 'story-intermediate'
          : 'story-fast';
    return {
      commandId: entry.id,
      selection,
      inputPatterns,
      coverage: entry.selectionInputCoverage === 'complete' ? 'complete' : 'partial',
      ...(selection === REPOSITORY_FULL_TIER ? { fullReason: 'command_exclusion_unproven' as const } : {}),
    };
  });
  return {
    schema: VALIDATION_IMPACT_INDEX_SCHEMA,
    version: 'production-catalog-v1',
    commandSetDigest: args.commandSetDigest,
    entries,
  };
}

export interface SelectValidationTiersInput {
  storyId: string;
  requestedTier: ValidationTier;
  universeCommandIds: string[];
  changedPaths: string[];
  pinnedCommandIds: string[];
  /** Pre-classified fail-closed facts from the change/snapshot collector. */
  forceFullReasons: ValidationWideningReasonCode[];
  commandSetDigest: string;
  snapshotDigest: string;
  impactIndex: ValidationImpactIndex | null | undefined;
}

export interface SelectValidationTiersDependencies {
  /** Internal verification seam; CLI/schema inputs never populate dependencies. */
  registryFloorProjection?: unknown;
}

export interface AutomaticValidationTierSelectionBinding {
  /** Exact catalog projection consumed to construct `input.impactIndex`. */
  catalogDigest: string;
  input: Omit<SelectValidationTiersInput, 'requestedTier'>;
  decision: ValidationTierSelectionDecision;
  bindingDigest: string;
}

export interface ValidationFloorProjectionInjection {
  /** A deliberately supplied projection; the wrapper distinguishes it from omission. */
  readonly projection: unknown;
}

export interface ValidationCommandExclusionProof {
  commandId: string;
  reason:
    | 'complete-input-set-does-not-intersect-story-change'
    | 'selected-tier-excludes-wider-tier-command';
  requestedTier: ValidationTier;
  declaredSelection: ValidationImpactSelection;
  indexVersion: string;
  indexDigest: string;
  snapshotDigest: string;
  changedPaths: string[];
  commandInputPatterns: string[];
}

export interface ValidationTierSelectionDecision {
  requestedTier: ValidationTier;
  effectiveTier: ValidationTier;
  selectedUnitIds: string[];
  tierSelections: Record<ValidationTier, string[]>;
  reductionApplied: boolean;
  escalationReasonCodes: ValidationWideningReasonCode[];
  exclusionProofs: ValidationCommandExclusionProof[];
  inclusionReasonsByCommand: Record<string, string[]>;
  impactIndexDigest: string | null;
  selectionDigest: string;
  /** Narrow tiers are iteration feedback; this selector never grants DONE authority. */
  finalAuthority: false;
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '').trim();
}

function uniqueInUniverseOrder(values: Iterable<string>, universe: readonly string[]): string[] {
  const wanted = new Set(values);
  return universe.filter((id) => wanted.has(id));
}

function globPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^$()|[\]\\{}]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

function pathMatchesImpactPattern(path: string, pattern: string): boolean {
  const normalized = normalizedPath(path);
  const normalizedPattern = normalizedPath(pattern);
  if (normalizedPattern === '' || normalized === '') return false;
  return normalized === normalizedPattern
    || normalized.startsWith(`${normalizedPattern}/`)
    || globPatternToRegExp(normalizedPattern).test(normalized);
}

const VALIDATION_SENSITIVE_PATH_PATTERNS = [
  'proof-or-stop.config.json',
  'packages/main/src/core/process-fact-registry.ts',
  'packages/main/src/core/process-fact-levels.ts',
  'packages/main/src/core/evidence-freshness.ts',
  'packages/main/src/core/material-path-policy.ts',
  'packages/main/src/core/runtime-artifact-registry.ts',
  'packages/main/src/core/digest.ts',
  'packages/main/src/core/config.ts',
  'packages/main/src/core/machine.ts',
  'packages/main/src/core/guard-utils.ts',
  'packages/main/src/core/command-policy.ts',
  'packages/main/src/handlers/phase-gates.ts',
  'packages/main/src/handlers/story-advance.ts',
  'packages/main/src/handlers/done-required-validation.ts',
  'packages/main/src/handlers/verifier.ts',
  'packages/main/src/cli-engine.ts',
  'packages/main/src/cli/command-catalog.ts',
  'packages/main/src/tasks/full-suite-runner.ts',
  '.githooks/**',
  'scripts/verify-process-fact-contract.mjs',
  'docs/validation-performance.md',
  'docs/requirements/decisions/*validation*.md',
] as const;

/** Pre-registry hardcoded sensitivity rules, retained as an additive baseline. */
export function pathIsLegacyValidationSensitive(path: string): boolean {
  if (typeof path !== 'string') {
    throw new Error('pathIsLegacyValidationSensitive: path must be a string');
  }
  const normalized = normalizedPath(path);
  const basename = normalized.split('/').pop()?.toLowerCase() ?? '';
  return (normalized.startsWith('packages/main/src/') && basename.includes('validat'))
    || VALIDATION_SENSITIVE_PATH_PATTERNS.some((pattern) => pathMatchesImpactPattern(normalized, pattern));
}

const BUILD_GRAPH_PATH_PATTERNS = [
  'package.json',
  '**/package.json',
  'package-lock.json',
  '**/package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'tsconfig.json',
  '**/tsconfig.json',
  'tsconfig.*.json',
  '**/tsconfig.*.json',
] as const;

/**
 * Merge explicit process-fact validation floors with the legacy rules. Dynamic
 * Finding uses this contract so its gate implementation cannot be labelled
 * fast, without treating every unrelated L4 reference as validation framework
 * code. An unavailable floor projection is repository-scoped and widens even
 * when the changed-path set is empty. Omit `injection` to use only the live
 * registry; wrap even an unavailable value so absence and failure are explicit.
 */
export function classifySensitiveStoryPaths(
  paths: readonly string[],
  injection?: ValidationFloorProjectionInjection,
): ValidationWideningReasonCode[] {
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string')) {
    throw new Error('classifySensitiveStoryPaths: paths must be an array of strings');
  }
  if (injection !== undefined
    && (!injection
      || typeof injection !== 'object'
      || Array.isArray(injection)
      || !Object.prototype.hasOwnProperty.call(injection, 'projection'))) {
    throw new Error('classifySensitiveStoryPaths: injection must be an object with a projection property');
  }
  const reasons = new Set<ValidationWideningReasonCode>();
  const liveProjection = collectRepositoryFullProcessFactPaths();
  const projections = [
    liveProjection,
    ...(injection === undefined ? [] : [injection.projection]),
  ];
  const liveFloorOwnerIds = new Set(liveProjection.floorOwnerIds);
  const registeredPatterns = new Set<string>();
  let registeredFloorUnavailable = false;
  for (const projection of projections) {
    const candidate = projection as {
      paths?: unknown;
      rejectedEntryCount?: unknown;
      floorOwnerIds?: unknown;
    } | null;
    const projectionShapeValid = Boolean(candidate)
      && Array.isArray(candidate?.paths)
      && candidate.paths.every((path) => typeof path === 'string')
      && Number.isInteger(candidate?.rejectedEntryCount)
      && Number(candidate?.rejectedEntryCount) >= 0
      && Array.isArray(candidate?.floorOwnerIds)
      && candidate.floorOwnerIds.every((ownerId) => typeof ownerId === 'string' && ownerId.trim() !== '');
    if (!projectionShapeValid) {
      registeredFloorUnavailable = true;
      continue;
    }
    const patterns = (candidate!.paths as string[]).map(normalizedPath).filter(Boolean);
    const projectedFloorOwnerIds = new Set(candidate!.floorOwnerIds as string[]);
    const missingLiveFloorOwner = [...liveFloorOwnerIds].some((ownerId) => !projectedFloorOwnerIds.has(ownerId));
    if (Number(candidate?.rejectedEntryCount) > 0 || patterns.length === 0 || missingLiveFloorOwner) {
      registeredFloorUnavailable = true;
    }
    for (const pattern of patterns) registeredPatterns.add(pattern);
  }
  if (registeredFloorUnavailable) reasons.add('validation_floor_registry_unavailable');
  const registeredPatternList = [...registeredPatterns];
  for (const path of paths) {
    const normalized = normalizedPath(path);
    if (
      pathIsLegacyValidationSensitive(normalized)
      || registeredPatternList.some((pattern) => pathMatchesImpactPattern(normalized, pattern))
    ) {
      reasons.add('validation_framework_sensitive_change');
    }
    if (BUILD_GRAPH_PATH_PATTERNS.some((pattern) => pathMatchesImpactPattern(path, pattern))) {
      reasons.add('build_graph_change');
    }
  }
  return [...reasons];
}

function dynamicFullDecision(
  input: SelectValidationTiersInput,
  universe: string[],
  reasons: Iterable<ValidationWideningReasonCode>,
  impactIndexDigest: string | null,
): ValidationTierSelectionDecision {
  const escalationReasonCodes = [...new Set(reasons)];
  const tierSelections: Record<ValidationTier, string[]> = {
    'story-fast': [...universe],
    'story-intermediate': [...universe],
    'repository-full': [...universe],
  };
  const decisionBody = {
    storyId: input.storyId,
    requestedTier: input.requestedTier,
    effectiveTier: REPOSITORY_FULL_TIER,
    tierSelections,
    escalationReasonCodes,
    commandSetDigest: input.commandSetDigest,
    snapshotDigest: input.snapshotDigest,
    impactIndexDigest,
  };
  return {
    requestedTier: input.requestedTier,
    effectiveTier: REPOSITORY_FULL_TIER,
    selectedUnitIds: [...universe],
    tierSelections,
    reductionApplied: false,
    escalationReasonCodes,
    exclusionProofs: [],
    inclusionReasonsByCommand: Object.fromEntries(
      universe.map((commandId) => [commandId, ['repository-full:fail-closed']]),
    ),
    impactIndexDigest,
    selectionDigest: digestCanonicalJson(decisionBody),
    finalAuthority: false,
  };
}

/**
 * Compute all three memberships from current Story facts and a versioned impact
 * index. This is deliberately fail-closed: a missing/partial/duplicate command
 * declaration, an unknown changed path, a stale command-set binding, or any
 * pre-classified sensitive fact makes every tier equal repository-full.
 */
export function selectValidationTiers(
  rawInput: SelectValidationTiersInput,
  dependencies: SelectValidationTiersDependencies = {},
): ValidationTierSelectionDecision {
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error('selectValidationTiers: dependencies must be an object');
  }
  const input = rawInput;
  const requestedTier = assertValidationTier(input?.requestedTier, 'selectValidationTiers');
  const universe = [...new Set((input?.universeCommandIds ?? []).map((id) => id.trim()).filter(Boolean))];
  const changedPaths = [...new Set((input?.changedPaths ?? []).map(normalizedPath).filter(Boolean))].sort();
  const pinnedCommandIds = [...new Set((input?.pinnedCommandIds ?? []).map((id) => id.trim()).filter(Boolean))];
  const forceFullReasons = (input?.forceFullReasons ?? []).filter(
    (code): code is ValidationWideningReasonCode => VALIDATION_WIDENING_REASON_CODES.includes(code),
  );
  const malformedForceReason = (input?.forceFullReasons ?? []).length !== forceFullReasons.length;

  if (universe.length === 0) {
    return dynamicFullDecision(input, universe, ['empty_selection_unclassified'], null);
  }

  const index = input?.impactIndex;
  if (!index || index.schema !== VALIDATION_IMPACT_INDEX_SCHEMA || typeof index.version !== 'string' || !index.version.trim()) {
    return dynamicFullDecision(input, universe, ['impact_index_unusable'], null);
  }

  const impactIndexDigest = digestCanonicalJson(index);
  const reasons = new Set<ValidationWideningReasonCode>(forceFullReasons);
  const sensitivePathReasons = Object.prototype.hasOwnProperty.call(dependencies, 'registryFloorProjection')
    ? classifySensitiveStoryPaths(changedPaths, { projection: dependencies.registryFloorProjection })
    : classifySensitiveStoryPaths(changedPaths);
  for (const reason of sensitivePathReasons) reasons.add(reason);
  if (malformedForceReason) reasons.add('impact_index_unusable');
  if (typeof input.commandSetDigest !== 'string' || input.commandSetDigest.trim() === '') reasons.add('impact_index_unusable');
  if (typeof input.snapshotDigest !== 'string' || input.snapshotDigest.trim() === '') reasons.add('hash_snapshot_unavailable');
  if (index.commandSetDigest !== input.commandSetDigest) reasons.add('selection_policy_changed');

  const universeSet = new Set(universe);
  const entriesByCommand = new Map<string, ValidationImpactIndexEntry>();
  if (!Array.isArray(index.entries)) reasons.add('impact_index_unusable');
  for (const entry of Array.isArray(index.entries) ? index.entries : []) {
    if (!entry || typeof entry.commandId !== 'string' || !universeSet.has(entry.commandId)) {
      reasons.add('impact_index_unusable');
      continue;
    }
    if (entriesByCommand.has(entry.commandId)) {
      reasons.add('impact_index_unusable');
      continue;
    }
    if (!(VALIDATION_TIERS as readonly string[]).includes(entry.selection) && entry.selection !== 'always') {
      reasons.add('impact_index_unusable');
      continue;
    }
    if (
      !Array.isArray(entry.inputPatterns)
      || entry.inputPatterns.some((pattern) => typeof pattern !== 'string')
      || !['complete', 'partial'].includes(entry.coverage)
      || (entry.fullReason !== undefined && !VALIDATION_WIDENING_REASON_CODES.includes(entry.fullReason))
    ) {
      reasons.add('impact_index_unusable');
      continue;
    }
    entriesByCommand.set(entry.commandId, {
      ...entry,
      inputPatterns: [...new Set(entry.inputPatterns.map(normalizedPath).filter(Boolean))].sort(),
    });
  }

  for (const commandId of universe) {
    const entry = entriesByCommand.get(commandId);
    if (!entry || entry.coverage !== 'complete') reasons.add('command_exclusion_unproven');
  }

  for (const pin of pinnedCommandIds) {
    if (!universeSet.has(pin)) reasons.add('pinned_command_missing');
  }

  const matchedByPath = new Map<string, ValidationImpactIndexEntry[]>();
  for (const path of changedPaths) {
    const matches = [...entriesByCommand.values()].filter(
      (entry) => entry.inputPatterns.some((pattern) => pathMatchesImpactPattern(path, pattern)),
    );
    matchedByPath.set(path, matches);
    if (matches.length === 0) reasons.add('unclassified_material_input');
  }

  const always = universe.filter((id) => entriesByCommand.get(id)?.selection === 'always');
  const fast = new Set<string>([...always, ...pinnedCommandIds]);
  const intermediate = new Set<string>([...fast]);
  const inclusionReasons = new Map<string, Set<string>>();
  const addInclusionReason = (commandId: string, reason: string): void => {
    const commandReasons = inclusionReasons.get(commandId) ?? new Set<string>();
    commandReasons.add(reason);
    inclusionReasons.set(commandId, commandReasons);
  };
  for (const commandId of always) addInclusionReason(commandId, 'declared-always');
  for (const commandId of pinnedCommandIds) addInclusionReason(commandId, 'evidence-pin');
  for (const matches of matchedByPath.values()) {
    for (const entry of matches) {
      if (entry.selection === 'story-fast') {
        fast.add(entry.commandId);
        intermediate.add(entry.commandId);
        addInclusionReason(entry.commandId, 'index-match:story-fast');
      } else if (entry.selection === 'story-intermediate') {
        intermediate.add(entry.commandId);
        addInclusionReason(entry.commandId, 'index-match:story-intermediate');
      } else if (entry.selection === REPOSITORY_FULL_TIER) {
        reasons.add(entry.fullReason ?? 'command_exclusion_unproven');
      }
    }
  }

  if (reasons.size > 0) {
    return dynamicFullDecision(input, universe, reasons, impactIndexDigest);
  }

  const tierSelections: Record<ValidationTier, string[]> = {
    'story-fast': uniqueInUniverseOrder(fast, universe),
    'story-intermediate': uniqueInUniverseOrder(intermediate, universe),
    'repository-full': [...universe],
  };
  assertValidationTierSelectionSubsetInvariant(tierSelections);
  const selectedUnitIds = [...tierSelections[requestedTier]];
  if (selectedUnitIds.length === 0) {
    return dynamicFullDecision(input, universe, ['empty_selection_unclassified'], impactIndexDigest);
  }

  const selectedSet = new Set(selectedUnitIds);
  const exclusionProofs: ValidationCommandExclusionProof[] = universe
    .filter((commandId) => !selectedSet.has(commandId))
    .map((commandId) => {
      const entry = entriesByCommand.get(commandId)!;
      const intersectsStory = changedPaths.some((path) =>
        entry.inputPatterns.some((pattern) => pathMatchesImpactPattern(path, pattern)));
      return {
        commandId,
        reason: intersectsStory
          ? 'selected-tier-excludes-wider-tier-command' as const
          : 'complete-input-set-does-not-intersect-story-change' as const,
        requestedTier,
        declaredSelection: entry.selection,
        indexVersion: index.version,
        indexDigest: impactIndexDigest,
        snapshotDigest: input.snapshotDigest,
        changedPaths: [...changedPaths],
        commandInputPatterns: [...entry.inputPatterns],
      };
    });
  const inclusionReasonsByCommand = Object.fromEntries(universe.map((commandId) => {
    if (requestedTier === REPOSITORY_FULL_TIER) return [commandId, ['repository-full:requested']];
    const commandReasons = inclusionReasons.get(commandId);
    if (selectedSet.has(commandId)) return [commandId, commandReasons && commandReasons.size > 0 ? [...commandReasons] : ['selected-by-tier']];
    const proof = exclusionProofs.find((entry) => entry.commandId === commandId)!;
    return [commandId, [`omitted:${proof.reason}`]];
  }));

  const decisionBody = {
    storyId: input.storyId,
    requestedTier,
    effectiveTier: requestedTier,
    tierSelections,
    exclusionProofs,
    inclusionReasonsByCommand,
    commandSetDigest: input.commandSetDigest,
    snapshotDigest: input.snapshotDigest,
    impactIndexDigest,
  };
  return {
    requestedTier,
    effectiveTier: requestedTier,
    selectedUnitIds,
    tierSelections,
    reductionApplied: selectedUnitIds.length < universe.length,
    escalationReasonCodes: [],
    exclusionProofs,
    inclusionReasonsByCommand,
    impactIndexDigest,
    selectionDigest: digestCanonicalJson(decisionBody),
    finalAuthority: false,
  };
}

/**
 * Choose the smallest safe tier from Story relevance.  The explicit selector
 * remains useful for operator previews; production starts at story-fast and is
 * promoted when a directly affected row declares an intermediate boundary.
 * Full-only matches and every fail-closed reason are already handled by
 * selectValidationTiers and therefore retain repository-full semantics.
 */
export function selectAutomaticValidationTier(
  input: Omit<SelectValidationTiersInput, 'requestedTier'>,
  dependencies: SelectValidationTiersDependencies = {},
): ValidationTierSelectionDecision {
  const initial = selectValidationTiers({ ...input, requestedTier: 'story-fast' }, dependencies);
  const impactEntries = Array.isArray(input.impactIndex?.entries) ? input.impactIndex.entries : [];
  const needsIntermediate = impactEntries.some((entry) =>
    entry.selection === 'story-intermediate'
    && Array.isArray(entry.inputPatterns)
    && input.changedPaths.some((path) => entry.inputPatterns.some((pattern) => pathMatchesImpactPattern(path, pattern))));
  if (initial.effectiveTier === REPOSITORY_FULL_TIER) {
    // An empty fast set is not a PASS, but it must not prevent a directly
    // affected shared/boundary command from being tried at intermediate.
    // Every other fast-tier escalation remains repository-full.
    if (needsIntermediate && initial.escalationReasonCodes.length === 1
      && initial.escalationReasonCodes[0] === 'empty_selection_unclassified') {
      return selectValidationTiers({ ...input, requestedTier: 'story-intermediate' }, dependencies);
    }
    return initial;
  }
  if (!needsIntermediate) return initial;

  return selectValidationTiers({ ...input, requestedTier: 'story-intermediate' }, dependencies);
}

/** Build the exact selector input shared by validation_plan and validate. */
export function buildAutomaticValidationTierSelectionBinding(args: {
  input: StoryRelevanceInput;
  catalog: readonly ValidationImpactCatalogEntry[];
  /** Raw executor catalog digest when selector inputs include graph augmentation. */
  executionCatalogDigest?: string;
  additionalForceFullReasons?: ValidationWideningReasonCode[];
}): AutomaticValidationTierSelectionBinding {
  const materialSeedPaths = [...new Set([
    ...args.input.seeds.filter((seed) => seed.kind === 'path').map((seed) => normalizedPath(seed.value)).filter(Boolean),
    ...(args.input.hashes.status === 'available'
      ? (evidenceMaterialDirtyFiles(args.input.hashes.head) ?? []).map(normalizedPath).filter(Boolean)
      : []),
  ])].sort();
  const forceFullReasons = [
    ...args.input.escalations.map((entry) => entry.code as ValidationWideningReasonCode),
    ...(args.additionalForceFullReasons || []),
  ];
  if (args.input.changedFiles.status === 'changed_files_unavailable') forceFullReasons.push('changed_files_unavailable');
  if (args.input.hashes.status === 'hash_snapshot_unavailable') forceFullReasons.push('hash_snapshot_unavailable');
  if (args.input.unclassifiedInputs.length > 0) forceFullReasons.push('unclassified_material_input');
  if (args.input.riskSignals.length > 0) forceFullReasons.push('story_risk_signal_present');
  const impactIndex = buildValidationImpactIndexFromCatalog({
    commandSetDigest: args.input.executionInventory.commandSetDigest,
    catalog: args.catalog,
  });
  const input: Omit<SelectValidationTiersInput, 'requestedTier'> = {
    storyId: args.input.storyId,
    universeCommandIds: [...args.input.executionInventory.commandIds],
    changedPaths: materialSeedPaths,
    pinnedCommandIds: args.input.pinnedCommands.map((pin) => pin.commandId),
    forceFullReasons,
    commandSetDigest: args.input.executionInventory.commandSetDigest,
    snapshotDigest: digestCanonicalJson({
      selectionDigest: args.input.selectionDigest,
      hashes: args.input.hashes.status === 'available'
        ? {
            headHash: args.input.hashes.head.headHash,
            materialHash: args.input.hashes.head.materialHash,
            storyFilesHash: args.input.hashes.head.storyFilesHash,
            materialDirtyFiles: [...(evidenceMaterialDirtyFiles(args.input.hashes.head) ?? [])]
              .map(normalizedPath).filter(Boolean).sort(),
          }
        : { status: args.input.hashes.status, missingDigests: args.input.hashes.missingDigests },
    }),
    impactIndex,
  };
  const decision = selectAutomaticValidationTier(input);
  const catalogDigest = args.executionCatalogDigest ?? digestCanonicalJson(args.catalog);
  return { catalogDigest, input, decision, bindingDigest: digestCanonicalJson({ catalogDigest, input, decision }) };
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
  validation_floor_registry_unavailable: {
    condition: 'Declared repository-full process-fact floors cannot be read completely or no floor is declared',
    outcome: 'repository-full',
    gloss:
      'The process-fact registry could not provide a complete repository-full floor set, or declares no floor ' +
      'at all, so no path can be cleared as insensitive and the complete validation set has to run.',
  },
  validation_framework_sensitive_change: {
    condition: 'A legacy validation-machinery pattern or a declared repository-full process-fact path changes',
    outcome: 'repository-full',
    gloss:
      'This Story changed the machinery that decides what to run or how to judge it, so that machinery cannot ' +
      'be trusted to shrink its own test set.',
  },
  story_risk_signal_present: {
    condition: 'Story risk policy marks the change as high-risk',
    outcome: 'repository-full',
    gloss:
      'The Story carries a configured risk signal, so the smaller validation tiers are not used even when ' +
      'the changed files can otherwise be mapped.',
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
  effectiveTier: ValidationTier;
  executionMode: 'command-set' | 'atomic';
  universe: ValidationPlanUnit[];
  selectedUnitIds: string[];
  tierSelections: Record<ValidationTier, string[]>;
  reductionApplied: boolean;
  /** Present only for an impact-index decision; absent on compatibility-full plans. */
  exclusionProofs?: ValidationCommandExclusionProof[];
  /** Per-unit reasons from the same selector decision; never lifecycle evidence. */
  inclusionReasonsByCommand?: Record<string, string[]>;
  /** Decision digest, distinct from the collector's input digest. */
  selectorDecisionDigest?: string;
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
  /** Optional, explicit and command-set-bound. Absence preserves compatibility-full. */
  impactIndex?: ValidationImpactIndex | null;
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
  // The resolver normalizes an older or schema-bypassing available snapshot to
  // hash_snapshot_unavailable after this structural check. That produces a
  // classified full plan instead of throwing or assuming a missing overlay is
  // an empty worktree.
  if (!input.hashes || typeof input.hashes !== 'object' || typeof input.hashes.status !== 'string') {
    throw new Error('resolveValidationTierPlan: input.hashes must classify the evidence hash snapshot');
  }
  if (!Array.isArray(input.seeds) || !Array.isArray(input.escalations) || !Array.isArray(input.unclassifiedInputs)) {
    throw new Error('resolveValidationTierPlan: input seeds, escalations and unclassifiedInputs must be arrays');
  }
}

function normalizePlannerHashSnapshot(input: StoryRelevanceInput): StoryRelevanceInput {
  if (input.hashes.status !== 'available') return input;
  const missingDigests = missingEvidenceHashDigests(input.hashes.head);
  const dirtyFiles = evidenceMaterialDirtyFiles(input.hashes.head);
  if (missingDigests.length === 0 && dirtyFiles !== null) return input;

  const missingDescription = missingDigests.length > 0
    ? `missing ${missingDigests.join(', ')}`
    : 'missing or malformed materialDirtyFiles';
  const detail =
    `the evidence hash snapshot labelled available is incomplete (${missingDescription}), so no freshness ` +
    'binding or bounded material overlay can be proven for this plan';
  return {
    ...input,
    hashes: {
      status: 'hash_snapshot_unavailable',
      summary: `the available snapshot is incomplete: ${missingDescription}`,
      error: `schema-bypassing incomplete evidence hash snapshot: ${missingDescription}`,
      missingDigests,
    },
    escalations: input.escalations.some((entry) => entry.code === 'hash_snapshot_unavailable')
      ? [...input.escalations]
      : [...input.escalations, { code: 'hash_snapshot_unavailable', detail }],
  };
}

function validationImpactIndexHasUsableShape(value: unknown): value is ValidationImpactIndex {
  if (!value || typeof value !== 'object') return false;
  const index = value as Record<string, unknown>;
  if (
    index.schema !== VALIDATION_IMPACT_INDEX_SCHEMA
    || typeof index.version !== 'string'
    || index.version.trim() === ''
    || typeof index.commandSetDigest !== 'string'
    || index.commandSetDigest.trim() === ''
    || !Array.isArray(index.entries)
  ) return false;
  return index.entries.every((rawEntry) => {
    if (!rawEntry || typeof rawEntry !== 'object') return false;
    const entry = rawEntry as Record<string, unknown>;
    return typeof entry.commandId === 'string'
      && entry.commandId.trim() !== ''
      && (entry.selection === 'always' || (VALIDATION_TIERS as readonly unknown[]).includes(entry.selection))
      && Array.isArray(entry.inputPatterns)
      && entry.inputPatterns.every((pattern) => typeof pattern === 'string')
      && (entry.coverage === 'complete' || entry.coverage === 'partial')
      && (entry.fullReason === undefined || VALIDATION_WIDENING_REASON_CODES.includes(entry.fullReason as ValidationWideningReasonCode));
  });
}

/**
 * Compatibility-path diagnostics when no usable impact index is supplied.
 * Every material seed remains unclassified on that path, and listing the paths
 * lets an operator see exactly why the fallback cannot narrow.
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

function collectIndexedUnclassifiedInputs(
  input: StoryRelevanceInput,
  impactIndex: ValidationImpactIndex,
  materialSeedPaths: readonly string[],
): ValidationTierPlanUnclassifiedInput[] {
  const validEntries = Array.isArray(impactIndex.entries)
    ? impactIndex.entries.filter((entry) => entry && Array.isArray(entry.inputPatterns))
    : [];
  const entries: ValidationTierPlanUnclassifiedInput[] = [];
  for (const path of materialSeedPaths) {
    const matched = validEntries.some((entry) => entry.inputPatterns.some(
      (pattern) => typeof pattern === 'string' && pathMatchesImpactPattern(path, pattern),
    ));
    if (matched) continue;
    const seed = input.seeds.find((candidate) => candidate.kind === 'path' && normalizedPath(candidate.value) === path);
    entries.push({
      kind: 'material-path',
      value: path,
      detail:
        `the configured impact index contains no command input pattern matching ${path}` +
        `${seed ? ` (provenance: ${seed.provenance.join(', ')})` : ''}, so the input is unclassified and ` +
        'the requested subset is refused',
    });
  }
  for (const upstream of input.unclassifiedInputs) {
    entries.push({ kind: upstream.kind, value: upstream.detail, detail: upstream.detail });
  }
  return entries;
}

function collectMalformedIndexUnclassifiedInputs(
  input: StoryRelevanceInput,
  materialSeedPaths: readonly string[],
): ValidationTierPlanUnclassifiedInput[] {
  const entries: ValidationTierPlanUnclassifiedInput[] = materialSeedPaths.map((path) => {
    const seed = input.seeds.find((candidate) => candidate.kind === 'path' && normalizedPath(candidate.value) === path);
    return {
      kind: 'material-path' as const,
      value: path,
      detail:
        `the configured impact index is malformed, so ${path}` +
        `${seed ? ` (provenance: ${seed.provenance.join(', ')})` : ''} cannot be attributed safely`,
    };
  });
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
  const rawInput = args?.input as StoryRelevanceInput;
  assertPlannerInput(rawInput);
  const input = normalizePlannerHashSnapshot(rawInput);

  const materialSeedPaths = [...new Set([
    ...input.seeds
      .filter((seed) => seed.kind === 'path')
      .map((seed) => normalizedPath(seed.value))
      .filter(Boolean),
    ...(input.hashes.status === 'available'
      ? (evidenceMaterialDirtyFiles(input.hashes.head) ?? []).map(normalizedPath).filter(Boolean)
      : []),
  ])].sort();
  const configuredImpactIndex = args.impactIndex !== null && args.impactIndex !== undefined;
  const usableImpactIndex = validationImpactIndexHasUsableShape(args.impactIndex)
    ? args.impactIndex
    : null;
  const unclassifiedInputs = configuredImpactIndex
    ? usableImpactIndex
      ? collectIndexedUnclassifiedInputs(input, usableImpactIndex, materialSeedPaths)
      : collectMalformedIndexUnclassifiedInputs(input, materialSeedPaths)
    : collectUnclassifiedInputs(input);

  const sourceKind = input.executionInventory.sourceKind;
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

  // 4b. A configured command-set may narrow only through the canonical pure
  // selector. Opaque fallback/validate-file sources have no per-command
  // inventory and therefore retain their atomic full behavior below.
  if (!atomic && configuredImpactIndex) {
    // Pass codes through to the inner validator instead of silently filtering
    // an unknown future collector code. The selector converts an unknown code
    // into impact_index_unusable.
    const forceFullReasons = input.escalations.map(
      (escalation) => escalation.code as ValidationWideningReasonCode,
    );
    if (input.changedFiles.status === 'changed_files_unavailable') forceFullReasons.push('changed_files_unavailable');
    if (input.hashes.status === 'hash_snapshot_unavailable') forceFullReasons.push('hash_snapshot_unavailable');
    if (input.unclassifiedInputs.length > 0) forceFullReasons.push('unclassified_material_input');
    if (input.riskSignals.length > 0) forceFullReasons.push('story_risk_signal_present');

    const decision = selectValidationTiers({
      storyId: input.storyId,
      requestedTier,
      universeCommandIds: universe.map((unit) => unit.id),
      changedPaths: materialSeedPaths,
      pinnedCommandIds: input.pinnedCommands.map((pin) => pin.commandId),
      forceFullReasons,
      commandSetDigest: input.executionInventory.commandSetDigest,
      snapshotDigest: digestCanonicalJson({
        selectionDigest: input.selectionDigest,
        hashes: input.hashes.status === 'available'
          ? {
              headHash: input.hashes.head.headHash,
              materialHash: input.hashes.head.materialHash,
              storyFilesHash: input.hashes.head.storyFilesHash,
              materialDirtyFiles: [...(evidenceMaterialDirtyFiles(input.hashes.head) ?? [])]
                .map(normalizedPath)
                .filter(Boolean)
                .sort(),
            }
          : { status: input.hashes.status, missingDigests: input.hashes.missingDigests },
      }),
      impactIndex: args.impactIndex,
    });
    const dynamicReasons = decision.escalationReasonCodes.map((code) => validationWideningReason(
      code,
      isValidationStopReasonCode(code)
        ? `the versioned impact-index decision for story ${input.storyId} classified ${code}; no execution plan was produced`
        : `the versioned impact-index decision for story ${input.storyId} classified ${code}; ` +
          'the requested subset was refused and the repository-full command universe was selected',
    ));
    const dynamicStop = dynamicReasons.find((reason) => isValidationStopReasonCode(reason.code));
    if (dynamicStop) {
      const reason = assertStopReason(dynamicStop);
      return {
        ...common,
        unclassifiedInputs,
        status: 'stop',
        reason,
        escalationReasons: dynamicReasons,
      };
    }
    return {
      ...common,
      unclassifiedInputs,
      status: 'plan',
      effectiveTier: decision.effectiveTier,
      executionMode: 'command-set',
      universe,
      selectedUnitIds: decision.selectedUnitIds,
      tierSelections: decision.tierSelections,
      reductionApplied: decision.reductionApplied,
      exclusionProofs: decision.exclusionProofs,
      inclusionReasonsByCommand: decision.inclusionReasonsByCommand,
      selectorDecisionDigest: decision.selectionDigest,
      escalationReasons: dynamicReasons,
    };
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

  // 5. Why nothing was reduced on the compatibility path. A configured index
  // cannot decompose an atomic source, but it does exist and must never be
  // reported as missing.
  if (!configuredImpactIndex) {
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
  } else if (atomic && !usableImpactIndex) {
    escalationReasons.push(
      validationWideningReason(
        'impact_index_unusable',
        'an impact index is configured, but its runtime shape is malformed; the atomic validation source still ' +
        'runs in full and the index must be repaired before it can explain path coverage',
      ),
    );
  }

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
        `the evidence hash snapshot could not be established (${input.hashes.summary}), so this plan lacks a ` +
        'complete digest and material-overlay binding and cannot be re-checked for freshness; nothing may be ' +
        'narrowed on its account',
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
