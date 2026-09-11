/**
 * B-a745 CHK-003 — the Story input collector.
 *
 * Spec: `docs/requirements/decisions/story-relevance-dynamic-validation-tiers-execution-plan.md`
 * section "Story input contract" (owned by story B-ccf4, not yet on main).
 *
 * This module produces ONE normalized `StoryRelevanceInput` from the sources the
 * spec's input table names. It is the only place the planner learns what a Story
 * touched, and it deliberately owns nothing else:
 *
 *   - It NEVER shells out to git. Changed paths come from
 *     `changedFileStatusesBetweenRenameAware` and hashes from
 *     `captureEvidenceHashSnapshot`, both in `core/evidence-freshness.ts`. Those
 *     readers are injectable ONLY so the read-FAILURE path can be tested
 *     honestly; the defaults are exported so a fixture can prove the shared
 *     readers are what production uses.
 *   - It NEVER writes a local path allowlist. Story metadata and registered
 *     runtime artifacts are excluded through `isStoryMetadataPath` /
 *     `isMaterialExcludedPath`, so this collector inherits every future change to
 *     that classification instead of drifting away from it.
 *   - It NEVER resolves a tier, decides a widening, or executes anything. That is
 *     CHK-004's and CHK-005's job. What it emits is INPUT.
 *
 * Three rules here are load-bearing, in the sense that a plausible-looking
 * implementation that violates them still "works" while silently lying:
 *
 *   1. A FAILURE to read changed files is `changed_files_unavailable`, NEVER an
 *      empty array. An empty array reads as "nothing changed" and would blind the
 *      planner exactly when git is least trustworthy. The two states are distinct
 *      variants of a discriminated union, so they cannot be conflated by accident.
 *   2. Command duration history is ESTIMATE-ONLY. It is excluded from
 *      `selectionDigest` by construction, so no consumer keyed on that digest can
 *      let a timing sample change what runs. A command with no history is
 *      `unknown-duration` and carries NO `estimateMs` key at all — a zero would be
 *      read as "instant".
 *   3. Verification intent is human-readable REASON CONTEXT. The spec says it is
 *      "never parsed as the only machine mapping", so it produces no
 *      command-to-seed edge and is likewise outside `selectionDigest`. The only
 *      edge origin is a pin the canonical resolver actually resolved.
 */

import {
  captureEvidenceHashSnapshot,
  changedFileStatusesBetweenRenameAware,
  isMaterialExcludedPath,
  isStoryMetadataPath,
  type EvidenceHashSnapshot,
  type EvidenceHashSnapshotCaptureArgs,
} from './evidence-freshness.js';
import { validationIdentityDigest } from './validation-evidence-reuse.js';
import {
  buildValidationPinUniverse,
  resolveValidationCommandPin,
  type ValidationPinResolutionKind,
  type ValidationPinUniverse,
} from './validation-command-identity.js';
import type { ChecklistItem, VerificationLane } from './types.js';
import type { RoutineValidationSourceKind, ValidationCommand } from './validation-types.js';

export const STORY_RELEVANCE_INPUT_SCHEMA = 'proofOrStop.story-relevance-input.v1' as const;

const ROUTINE_SOURCE_KINDS: readonly RoutineValidationSourceKind[] = [
  'configured',
  'fallback',
  'validate-file',
  'no-validator',
];

const VERIFICATION_LANES: readonly VerificationLane[] = ['happy', 'edge', 'adversarial'];

/** Where a seed came from. Every seed carries at least one. */
export type StoryRelevanceSeedProvenance =
  | 'changed-file'
  | 'checklist-modify'
  | 'checklist-create'
  | 'checklist-test'
  | 'evidence-pin'
  | 'risk-signal';

export type StoryRelevanceSeedKind = 'path' | 'command' | 'risk-signal';

export interface StoryRelevanceSeed {
  kind: StoryRelevanceSeedKind;
  /** A repo-relative path, a stable command id, or a risk-signal category. */
  value: string;
  /** Sorted, de-duplicated. Never empty. */
  provenance: StoryRelevanceSeedProvenance[];
  /** Checklist items that contributed this seed. Sorted; may be empty. */
  itemIds: string[];
  /** Raw git status letter for a changed-file seed (M/A/D/R100/...). */
  changeStatus?: string;
  /** True when the git status is a delete. A deleted file REMAINS a seed. */
  deleted?: boolean;
}

export type StoryRelevanceExcludedReason = 'story-metadata' | 'runtime-artifact';

export interface StoryRelevanceExcludedPath {
  path: string;
  provenance: StoryRelevanceSeedProvenance[];
  reason: StoryRelevanceExcludedReason;
}

/** Injectable readers. The DEFAULTS are the canonical shared readers. */
export type ChangedFileStatusReader = (
  gitCwd: string,
  fromRef: string,
  toRef: string,
) => Record<string, string>;

export type EvidenceHashSnapshotReader = (args: EvidenceHashSnapshotCaptureArgs) => EvidenceHashSnapshot;

export interface StoryRelevanceReaders {
  changedFileStatuses: ChangedFileStatusReader;
  hashSnapshot: EvidenceHashSnapshotReader;
}

export const DEFAULT_STORY_RELEVANCE_READERS: StoryRelevanceReaders = {
  changedFileStatuses: changedFileStatusesBetweenRenameAware,
  hashSnapshot: captureEvidenceHashSnapshot,
};

export type StoryRelevanceChangedFiles =
  | {
      status: 'available';
      baseRef: string;
      headRef: string;
      /** Rename-aware status map exactly as the shared reader returned it. */
      statuses: Record<string, string>;
      paths: string[];
    }
  | {
      status: 'changed_files_unavailable';
      baseRef: string;
      headRef: string;
      /**
       * Short machine classification of WHY the read failed. Operator-facing prose is
       * derived from this, never from the raw subprocess output.
       */
      reason: ChangedFilesUnavailableReason;
      /** One bounded, human-readable sentence. Never multi-line, never a stderr dump. */
      summary: string;
      /**
       * The underlying error, preserved verbatim for diagnosis only. It may be
       * arbitrarily long (git prints its whole usage block outside a repository), so it
       * must NEVER be interpolated into an escalation detail.
       */
      error: string;
    };

/**
 * Classification of a changed-file read failure. Deliberately coarse: the point is a
 * readable one-line explanation, not a taxonomy of git exit paths.
 */
export type ChangedFilesUnavailableReason =
  | 'not-a-git-repository'
  | 'unknown-revision'
  | 'git-unavailable'
  | 'reader-contract-violation'
  | 'unknown';

/** The three bindings a snapshot must carry before a plan may call it available. */
export const EVIDENCE_HASH_DIGEST_NAMES = ['headHash', 'materialHash', 'storyFilesHash'] as const;
export type EvidenceHashDigestName = (typeof EVIDENCE_HASH_DIGEST_NAMES)[number];

/**
 * B-a745 F-022. Which of the three digests a snapshot does NOT carry. The
 * canonical reader never throws for a git or hash failure: it OMITS the digest
 * and returns the rest, so "the reader returned" is not "the snapshot is
 * available". A non-git directory, an unborn repository (git init, zero commits)
 * and a failed hash read all come back through this path. One rule, shared with
 * the planner's entry re-validation and the CLI report invariant, so no consumer
 * can call an incomplete snapshot bound.
 */
export function missingEvidenceHashDigests(snapshot: unknown): EvidenceHashDigestName[] {
  const record = snapshot && typeof snapshot === 'object' ? (snapshot as Record<string, unknown>) : {};
  return EVIDENCE_HASH_DIGEST_NAMES.filter((name) => {
    const value = record[name];
    return typeof value !== 'string' || value.trim() === '';
  });
}

/**
 * Return the snapshot's material overlay only when its runtime shape is safe to
 * consume. This field participates in dynamic validation selection just as the
 * three digests participate in freshness, so an older or schema-bypassing
 * snapshot that omits it must be classified unavailable rather than treated as
 * an empty worktree.
 */
export function evidenceMaterialDirtyFiles(snapshot: unknown): string[] | null {
  const record = snapshot && typeof snapshot === 'object' ? (snapshot as Record<string, unknown>) : {};
  const value = record.materialDirtyFiles;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return null;
  return [...value];
}

export type StoryRelevanceHashes =
  | {
      status: 'available';
      /** Carries ALL of {@link EVIDENCE_HASH_DIGEST_NAMES}; the collector never labels a partial snapshot available. */
      head: EvidenceHashSnapshot;
    }
  | {
      status: 'hash_snapshot_unavailable';
      /** One bounded, human-readable sentence. Never multi-line, never a stderr dump. */
      summary: string;
      /**
       * The underlying error, verbatim, for diagnosis only. Never rendered into
       * prose. For an incomplete (non-throwing) snapshot this is a tool-owned
       * sentence naming the missing digests, since there is no thrown error.
       */
      error: string;
      /**
       * B-a745 F-022. The digests the returned snapshot lacked. Empty when the
       * reader threw instead of returning, so the two failure shapes stay
       * distinguishable on the structured result.
       */
      missingDigests: EvidenceHashDigestName[];
    };

/**
 * Input-collection escalation codes ONLY. The fail-closed widening matrix and its
 * glossed reason-code enum belong to CHK-004; these are the facts that matrix
 * consumes, not a second copy of it.
 */
export type StoryRelevanceInputEscalationCode =
  | 'changed_files_unavailable'
  | 'hash_snapshot_unavailable'
  | 'pinned_command_missing'
  | 'pinned_command_ambiguous'
  /**
   * B-a745 F-001. A legacy free-form evidence command that names nothing in the
   * inventory. Classified and widening, never a stop and never a seed.
   */
  | 'pinned_command_non_inventory';

export interface StoryRelevanceInputEscalation {
  code: StoryRelevanceInputEscalationCode;
  detail: string;
}

export interface StoryRelevancePinnedCommand {
  commandId: string;
  itemId: string;
  intentRef: string;
  pinResolution: ValidationPinResolutionKind;
  normalizedTupleDigest: string;
}

/**
 * The ONLY machine mapping from a Story fact to a command. Its origin is always a
 * pin the canonical resolver resolved; verification intent never produces one.
 */
export interface StoryRelevanceCommandSeedEdge {
  commandId: string;
  origin: 'evidence-pin';
  itemId: string;
  intentRef: string;
}

export interface StoryRelevanceUnclassifiedInput {
  kind: 'evidence-pin' | 'duration-sample';
  detail: string;
}

export interface StoryRelevanceExecutionInventory {
  sourceKind: RoutineValidationSourceKind;
  commandSetDigest: string;
  commandIds: string[];
  provisionalCommandIds: string[];
  warnings: string[];
}

export interface StoryRelevanceDurationEstimate {
  commandId: string;
  status: 'known' | 'unknown-duration';
  sampleCount: number;
  /** ABSENT (not zero, not null) whenever status is 'unknown-duration'. */
  estimateMs?: number;
  basis: string;
}

export interface StoryRelevanceDurationHistory {
  status: 'collected' | 'unavailable';
  sampleCount: number;
  /** The underlying read error, verbatim, for diagnosis only. Never rendered into prose. */
  readError?: string;
  /** One bounded sentence derived from `readError`; the ONLY form that reaches an operator. */
  readSummary?: string;
  estimates: StoryRelevanceDurationEstimate[];
  unmatchedSamples: string[];
}

export interface StoryRelevanceVerificationIntentContext {
  itemId: string;
  lane: VerificationLane;
  index: number;
  intentRef: string;
  desc: string;
  type?: string;
  priority?: string;
}

export interface StoryRelevanceInput {
  schema: typeof STORY_RELEVANCE_INPUT_SCHEMA;
  storyId: string;
  phase: string;
  hashes: StoryRelevanceHashes;
  changedFiles: StoryRelevanceChangedFiles;
  seeds: StoryRelevanceSeed[];
  excludedPaths: StoryRelevanceExcludedPath[];
  pinnedCommands: StoryRelevancePinnedCommand[];
  commandSeedEdges: StoryRelevanceCommandSeedEdge[];
  unclassifiedInputs: StoryRelevanceUnclassifiedInput[];
  riskSignals: Array<{ category: string; matched: string }>;
  executionInventory: StoryRelevanceExecutionInventory;
  /** ESTIMATE-ONLY. Excluded from `selectionDigest` by construction. */
  durationHistory: StoryRelevanceDurationHistory;
  /** REASON CONTEXT ONLY. Excluded from `selectionDigest` by construction. */
  verificationIntentContext: StoryRelevanceVerificationIntentContext[];
  escalations: StoryRelevanceInputEscalation[];
  /**
   * Digest of everything that may legitimately influence WHAT RUNS. Duration
   * history and verification intent are deliberately outside it; that exclusion
   * is the mechanical form of the spec's "estimate only" and "never parsed as the
   * only machine mapping" rules.
   */
  selectionDigest: string;
}

/** One receipt from a prior signed validation artifact. */
export interface SignedValidationDurationReceipt {
  label?: string;
  command: string;
  args?: readonly string[];
  commandId?: string;
  durationMs?: number;
}

/** A prior signed validation artifact (the done-required evidence shape). */
export interface SignedValidationDurationArtifact {
  storyId?: string;
  status?: string;
  receipts?: readonly SignedValidationDurationReceipt[];
}

export interface StoryRelevanceStoryFacts {
  storyId: string;
  phase: string;
  riskSignals?: ReadonlyArray<{ category: string; matched: string }>;
}

export interface StoryRelevanceInputArgs {
  projectRoot: string;
  gitCwd?: string;
  metadataRoot?: string;
  /** Diff base. Defaults to `main`, matching the rest of the story tooling. */
  baseRef?: string;
  headRef?: string;
  story: StoryRelevanceStoryFacts;
  checklist: { items: ReadonlyArray<ChecklistItem> };
  routine: { sourceKind: RoutineValidationSourceKind; commands: ReadonlyArray<ValidationCommand> };
  durationHistory?: {
    artifacts?: ReadonlyArray<SignedValidationDurationArtifact>;
    read?: () => ReadonlyArray<SignedValidationDurationArtifact>;
  };
  readers?: Partial<StoryRelevanceReaders>;
  processEnvironment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').trim();
}

/**
 * Seed accumulator. Merging by (kind, value) is what lets one path carry several
 * provenances — a changed file that a checklist item also declared is ONE seed
 * naming both origins, not two seeds racing to describe the same fact.
 */
class SeedCollector {
  private readonly seeds = new Map<string, StoryRelevanceSeed>();
  private readonly excluded = new Map<string, StoryRelevanceExcludedPath>();

  constructor(private readonly projectRoot: string) {}

  addPath(
    rawPath: string,
    provenance: StoryRelevanceSeedProvenance,
    extra?: { itemId?: string; changeStatus?: string },
  ): void {
    const path = normalizePath(rawPath);
    if (!path) return;
    // Canonical classifier — never a local allowlist.
    if (isMaterialExcludedPath(path, this.projectRoot)) {
      const existing = this.excluded.get(path);
      if (existing) {
        if (!existing.provenance.includes(provenance)) {
          existing.provenance = [...existing.provenance, provenance].sort();
        }
        return;
      }
      this.excluded.set(path, {
        path,
        provenance: [provenance],
        reason: isStoryMetadataPath(path, this.projectRoot) ? 'story-metadata' : 'runtime-artifact',
      });
      return;
    }
    const seed = this.upsert('path', path, provenance, extra?.itemId);
    if (extra?.changeStatus !== undefined) {
      seed.changeStatus = extra.changeStatus;
      // A deleted file REMAINS a seed; the flag is a fact about it, not a filter.
      seed.deleted = extra.changeStatus.startsWith('D');
    }
  }

  addNonPath(
    kind: 'command' | 'risk-signal',
    value: string,
    provenance: StoryRelevanceSeedProvenance,
    itemId?: string,
  ): void {
    const trimmed = value.trim();
    if (!trimmed) return;
    this.upsert(kind, trimmed, provenance, itemId);
  }

  private upsert(
    kind: StoryRelevanceSeedKind,
    value: string,
    provenance: StoryRelevanceSeedProvenance,
    itemId?: string,
  ): StoryRelevanceSeed {
    const key = `${kind} ${value}`;
    let seed = this.seeds.get(key);
    if (!seed) {
      seed = { kind, value, provenance: [provenance], itemIds: [] };
      this.seeds.set(key, seed);
    } else if (!seed.provenance.includes(provenance)) {
      seed.provenance = [...seed.provenance, provenance].sort();
    }
    if (itemId && !seed.itemIds.includes(itemId)) {
      seed.itemIds = [...seed.itemIds, itemId].sort();
    }
    return seed;
  }

  listSeeds(): StoryRelevanceSeed[] {
    return [...this.seeds.values()].sort((left, right) =>
      left.kind === right.kind ? left.value.localeCompare(right.value) : left.kind.localeCompare(right.kind),
    );
  }

  listExcluded(): StoryRelevanceExcludedPath[] {
    return [...this.excluded.values()].sort((left, right) => left.path.localeCompare(right.path));
  }
}

/**
 * Runtime re-validation at the collector entry, per the Handler encoding
 * convention: a schema constraint is only the first line of defence, and this
 * core is reachable from internal calls and legacy JSON that never met a schema.
 */
function assertCollectorArgs(args: StoryRelevanceInputArgs): void {
  if (typeof args.projectRoot !== 'string' || args.projectRoot.trim() === '') {
    throw new Error('collectStoryRelevanceInput: projectRoot must be a non-empty string');
  }
  const storyId = args.story?.storyId;
  if (typeof storyId !== 'string' || storyId.trim() === '') {
    throw new Error('collectStoryRelevanceInput: storyId must be a non-empty string');
  }
  if (typeof args.story?.phase !== 'string' || args.story.phase.trim() === '') {
    throw new Error('collectStoryRelevanceInput: phase must be a non-empty string');
  }
  const sourceKind = args.routine?.sourceKind;
  if (!ROUTINE_SOURCE_KINDS.includes(sourceKind as RoutineValidationSourceKind)) {
    throw new Error(
      `collectStoryRelevanceInput: unknown routine sourceKind ${JSON.stringify(sourceKind)} ` +
      `(expected one of ${ROUTINE_SOURCE_KINDS.join(', ')})`,
    );
  }
  if (!Array.isArray(args.routine?.commands)) {
    throw new Error('collectStoryRelevanceInput: routine.commands must be an array');
  }
  if (!Array.isArray(args.checklist?.items)) {
    throw new Error('collectStoryRelevanceInput: checklist.items must be an array');
  }
}

/** Upper bound on the one-line failure summary. Prose, not a stderr transcript. */
const CHANGED_FILES_SUMMARY_MAX_LENGTH = 120;

function firstMeaningfulLine(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // `Command failed: git diff ...` is the wrapper, not the cause; keep looking.
    if (/^command failed:/i.test(trimmed)) continue;
    return trimmed;
  }
  return raw.split(/\r?\n/)[0]?.trim() ?? '';
}

function boundSummary(text: string): string {
  const flattened = text.replace(/\s+/g, ' ').trim();
  if (flattened.length <= CHANGED_FILES_SUMMARY_MAX_LENGTH) return flattened;
  return `${flattened.slice(0, CHANGED_FILES_SUMMARY_MAX_LENGTH - 1).trimEnd()}\u2026`;
}

/**
 * B-a745 F-016: the ONE way a raw failure reaches operator prose anywhere in this
 * collector. First meaningful line, flattened, bounded. The raw value is kept on
 * the structured result by the caller; this never replaces it, it only stands in
 * for it in a detail / basis / summary string.
 */
function boundedFailureSummary(raw: string, fallback: string): string {
  return boundSummary(firstMeaningfulLine(raw)) || fallback;
}

/**
 * Turn an arbitrary reader failure into a BOUNDED one-line classification.
 *
 * Outside a git repository git prints its entire `git diff` usage block on stderr, which
 * the child-process wrapper folds into the thrown message. Interpolating that verbatim
 * into the escalation detail turns the explain output into a wall of git help and
 * destroys the interpretability the glossed escalations exist to provide. The raw error
 * is kept on the structured result for diagnosis; only this summary is rendered.
 */
function classifyChangedFilesFailure(
  raw: string,
  code: unknown,
): { reason: ChangedFilesUnavailableReason; summary: string } {
  const haystack = raw.toLowerCase();
  if (code === 'ENOENT' || /\benoent\b/.test(haystack)) {
    return { reason: 'git-unavailable', summary: 'the git executable was not found on this host' };
  }
  if (/not a git repository|not a git repo\b/.test(haystack)) {
    return { reason: 'not-a-git-repository', summary: 'the working directory is not a git repository' };
  }
  if (/bad revision|unknown revision|ambiguous argument|bad object|invalid object name/.test(haystack)) {
    return { reason: 'unknown-revision', summary: 'one of the requested revisions could not be resolved' };
  }
  return { reason: 'unknown', summary: boundSummary(firstMeaningfulLine(raw)) || 'the changed-file reader failed' };
}

function unavailableChangedFiles(
  baseRef: string,
  headRef: string,
  raw: string,
  reason: ChangedFilesUnavailableReason,
  summary: string,
): StoryRelevanceChangedFiles {
  return { status: 'changed_files_unavailable', baseRef, headRef, reason, summary: boundSummary(summary), error: raw };
}

function readChangedFiles(
  reader: ChangedFileStatusReader,
  gitCwd: string,
  baseRef: string,
  headRef: string,
): StoryRelevanceChangedFiles {
  try {
    const statuses = reader(gitCwd, baseRef, headRef);
    if (!statuses || typeof statuses !== 'object') {
      // A reader that returns a non-map has not proven "no changes" either.
      return unavailableChangedFiles(
        baseRef,
        headRef,
        'changed-file reader returned a non-object result',
        'reader-contract-violation',
        'the changed-file reader returned a non-object result',
      );
    }
    return {
      status: 'available',
      baseRef,
      headRef,
      statuses: { ...statuses },
      paths: Object.keys(statuses).sort(),
    };
  } catch (error) {
    // NEVER `return []` here. See the module header, rule 1.
    const raw = errorMessage(error);
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    const { reason, summary } = classifyChangedFilesFailure(raw, code);
    return unavailableChangedFiles(baseRef, headRef, raw, reason, summary);
  }
}

function collectVerificationIntentContext(
  items: ReadonlyArray<ChecklistItem>,
): StoryRelevanceVerificationIntentContext[] {
  const context: StoryRelevanceVerificationIntentContext[] = [];
  for (const item of items) {
    const intent = item.verificationIntent;
    if (!intent) continue;
    for (const lane of VERIFICATION_LANES) {
      const entries = intent[lane] ?? [];
      entries.forEach((entry, index) => {
        const desc = typeof entry?.desc === 'string' ? entry.desc.trim() : '';
        if (!desc) return;
        context.push({
          itemId: item.id,
          lane,
          index,
          intentRef: entry.id ?? `${item.id}:${lane}:${index}`,
          desc,
          ...(entry.type ? { type: entry.type } : {}),
          ...(entry.priority ? { priority: entry.priority } : {}),
        });
      });
    }
  }
  return context;
}

/**
 * Match one historical receipt to a stable command id through the CANONICAL pin
 * resolver, so history uses the same identity rule as everything else. An
 * unmatched sample is recorded and dropped — it may never become a seed, and a
 * failure to match may never escalate, because duration is estimate-only.
 */
function matchReceiptToCommandId(
  universe: ValidationPinUniverse,
  receipt: SignedValidationDurationReceipt,
): string | null {
  const pin =
    typeof receipt.commandId === 'string' && receipt.commandId.trim() !== ''
      ? { commandId: receipt.commandId }
      : { command: [receipt.command, ...(receipt.args ?? [])].filter(Boolean).join(' ') };
  try {
    const resolved = resolveValidationCommandPin({ universe, evidence: pin });
    return resolved.status === 'resolved' ? resolved.commandId : null;
  } catch {
    return null;
  }
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function collectDurationHistory(
  args: StoryRelevanceInputArgs,
  universe: ValidationPinUniverse,
  commandIds: string[],
): StoryRelevanceDurationHistory {
  let artifacts: ReadonlyArray<SignedValidationDurationArtifact> = args.durationHistory?.artifacts ?? [];
  let readError: string | undefined;
  let readSummary: string | undefined;
  if (args.durationHistory?.read) {
    try {
      artifacts = args.durationHistory.read() ?? [];
    } catch (error) {
      // Estimate-only input: a read failure degrades to unknown durations. It is
      // deliberately NOT an escalation, because an estimate must never widen.
      readError = errorMessage(error);
      readSummary = boundedFailureSummary(readError, 'the duration history reader failed');
      artifacts = [];
    }
  }

  const samplesById = new Map<string, number[]>();
  const unmatchedSamples: string[] = [];
  let sampleCount = 0;
  for (const artifact of artifacts) {
    for (const receipt of artifact?.receipts ?? []) {
      const durationMs = receipt?.durationMs;
      if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) continue;
      if (typeof receipt.command !== 'string' || receipt.command.trim() === '') continue;
      sampleCount += 1;
      const commandId = matchReceiptToCommandId(universe, receipt);
      if (!commandId) {
        unmatchedSamples.push([receipt.command, ...(receipt.args ?? [])].join(' ').trim());
        continue;
      }
      const existing = samplesById.get(commandId);
      if (existing) existing.push(durationMs);
      else samplesById.set(commandId, [durationMs]);
    }
  }

  const estimates: StoryRelevanceDurationEstimate[] = commandIds.map((commandId) => {
    const samples = samplesById.get(commandId) ?? [];
    if (samples.length === 0) {
      // No `estimateMs` KEY at all: a 0 would read as "instant".
      return {
        commandId,
        status: 'unknown-duration',
        sampleCount: 0,
        basis: 'no prior signed validation receipt recorded for this command',
      };
    }
    return {
      commandId,
      status: 'known',
      sampleCount: samples.length,
      estimateMs: median(samples),
      basis: `median of ${samples.length} prior signed validation receipt${samples.length === 1 ? '' : 's'}`,
    };
  });

  return {
    status: readError === undefined ? 'collected' : 'unavailable',
    sampleCount,
    ...(readError === undefined ? {} : { readError }),
    ...(readSummary === undefined ? {} : { readSummary }),
    estimates,
    unmatchedSamples: [...new Set(unmatchedSamples)].sort(),
  };
}

/**
 * The selection-relevant projection of the input. Duration history and
 * verification intent are absent BY CONSTRUCTION, which is what makes rules 2
 * and 3 in the module header mechanical rather than a convention.
 */
export function storyRelevanceSelectionDigest(input: Omit<StoryRelevanceInput, 'selectionDigest'>): string {
  return validationIdentityDigest({
    schema: STORY_RELEVANCE_INPUT_SCHEMA,
    storyId: input.storyId,
    phase: input.phase,
    hashes:
      input.hashes.status === 'available'
        ? {
            status: input.hashes.status,
            headHash: input.hashes.head.headHash ?? null,
            materialHash: input.hashes.head.materialHash ?? null,
            storyFilesHash: input.hashes.head.storyFilesHash ?? null,
          }
        : { status: input.hashes.status },
    changedFiles:
      input.changedFiles.status === 'available'
        ? { status: input.changedFiles.status, statuses: input.changedFiles.statuses }
        : { status: input.changedFiles.status },
    seeds: input.seeds,
    excludedPaths: input.excludedPaths,
    pinnedCommands: input.pinnedCommands,
    commandSeedEdges: input.commandSeedEdges,
    riskSignals: input.riskSignals,
    executionInventory: input.executionInventory,
    escalations: input.escalations,
  });
}

export function collectStoryRelevanceInput(args: StoryRelevanceInputArgs): StoryRelevanceInput {
  assertCollectorArgs(args);

  const projectRoot = args.projectRoot;
  const gitCwd = args.gitCwd ?? projectRoot;
  const baseRef = args.baseRef ?? 'main';
  const headRef = args.headRef ?? 'HEAD';
  const readers: StoryRelevanceReaders = { ...DEFAULT_STORY_RELEVANCE_READERS, ...args.readers };
  const escalations: StoryRelevanceInputEscalation[] = [];
  const unclassifiedInputs: StoryRelevanceUnclassifiedInput[] = [];

  let hashes: StoryRelevanceHashes;
  try {
    const head = readers.hashSnapshot({ gitCwd, metadataRoot: args.metadataRoot ?? projectRoot, ref: headRef });
    // B-a745 F-022: a RETURNED snapshot is not an AVAILABLE one. The canonical
    // reader swallows git and hash failures and omits the digest instead of
    // throwing, so the three bindings are checked here and a partial snapshot
    // is classified exactly like a thrown one: bounded summary in the prose,
    // the missing names on the structured result, and an escalation.
    const missingDigests = missingEvidenceHashDigests(head);
    const materialDirtyFiles = evidenceMaterialDirtyFiles(head);
    if (missingDigests.length === 0 && materialDirtyFiles !== null) {
      hashes = { status: 'available', head };
    } else {
      const summary = boundedFailureSummary(
        missingDigests.length > 0
          ? `the snapshot at ${headRef} carries no ${missingDigests.join(', ')} digest`
          : `the snapshot at ${headRef} carries no valid materialDirtyFiles list`,
        'the snapshot is missing a required selection binding',
      );
      hashes = {
        status: 'hash_snapshot_unavailable',
        summary,
        error: missingDigests.length > 0
          ? `incomplete evidence hash snapshot: missing ${missingDigests.join(', ')} (the reader returned without throwing)`
          : 'incomplete evidence hash snapshot: materialDirtyFiles is missing or malformed (the reader returned without throwing)',
        missingDigests,
      };
      escalations.push({
        code: 'hash_snapshot_unavailable',
        detail:
          `the evidence hash snapshot captured at ${headRef} is incomplete (${summary}), ` +
          'so no freshness binding can be proven for this plan',
      });
    }
  } catch (error) {
    // B-a745 F-016: the same git-failure classifier as the changed-file reader,
    // because the snapshot fails for the same reasons; the raw error stays on
    // the structured result and the prose carries the bounded summary only.
    const raw = errorMessage(error);
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    const { summary } = classifyChangedFilesFailure(raw, code);
    hashes = { status: 'hash_snapshot_unavailable', summary, error: raw, missingDigests: [] };
    escalations.push({
      code: 'hash_snapshot_unavailable',
      detail:
        `the evidence hash snapshot could not be captured at ${headRef} (${summary}), ` +
        'so no freshness binding can be proven for this plan',
    });
  }

  const changedFiles = readChangedFiles(readers.changedFileStatuses, gitCwd, baseRef, headRef);
  if (changedFiles.status === 'changed_files_unavailable') {
    escalations.push({
      code: 'changed_files_unavailable',
      // The BOUNDED summary, never `changedFiles.error`: the raw value can be git's
      // entire usage block and would make this line unreadable.
      detail:
        `the changed-file set between ${baseRef} and ${headRef} could not be read ` +
        `(${changedFiles.reason}: ${changedFiles.summary}). ` +
        'This is NOT the same as an empty diff: nothing is known about what changed.',
    });
  }

  const seeds = new SeedCollector(projectRoot);
  if (changedFiles.status === 'available') {
    for (const [path, status] of Object.entries(changedFiles.statuses)) {
      seeds.addPath(path, 'changed-file', { changeStatus: status });
    }
  }

  for (const item of args.checklist.items) {
    for (const path of item.files?.modify ?? []) seeds.addPath(path, 'checklist-modify', { itemId: item.id });
    for (const path of item.files?.create ?? []) seeds.addPath(path, 'checklist-create', { itemId: item.id });
    for (const path of item.files?.test ?? []) seeds.addPath(path, 'checklist-test', { itemId: item.id });
  }

  const riskSignals = [...(args.story.riskSignals ?? [])].map((signal) => ({
    category: signal.category,
    matched: signal.matched,
  }));
  for (const signal of riskSignals) seeds.addNonPath('risk-signal', signal.category, 'risk-signal');

  const universe = buildValidationPinUniverse({
    projectRoot,
    commands: [...args.routine.commands],
    ...(args.processEnvironment ? { processEnvironment: args.processEnvironment } : {}),
    ...(args.platform ? { platform: args.platform } : {}),
  });

  const pinnedCommands: StoryRelevancePinnedCommand[] = [];
  const commandSeedEdges: StoryRelevanceCommandSeedEdge[] = [];
  for (const item of args.checklist.items) {
    for (const evidence of item.verificationEvidence ?? []) {
      const hasPin =
        (typeof evidence.commandId === 'string' && evidence.commandId.trim() !== '') ||
        (typeof evidence.command === 'string' && evidence.command.trim() !== '');
      if (!hasPin) continue;
      const intentRef = typeof evidence.intentRef === 'string' ? evidence.intentRef : '';
      let resolved;
      try {
        resolved = resolveValidationCommandPin({
          universe,
          evidence: {
            ...(evidence.commandId === undefined ? {} : { commandId: evidence.commandId }),
            ...(evidence.command === undefined ? {} : { command: evidence.command }),
          },
        });
      } catch (error) {
        unclassifiedInputs.push({
          kind: 'evidence-pin',
          // Tool-owned message today, but bounded like every other failure prose (F-016).
          detail: `${item.id} ${intentRef}: malformed pin rejected ` +
            `(${boundedFailureSummary(errorMessage(error), 'the pin could not be read')})`,
        });
        continue;
      }
      if (resolved.status === 'resolved') {
        pinnedCommands.push({
          commandId: resolved.commandId,
          itemId: item.id,
          intentRef,
          pinResolution: resolved.pinResolution,
          normalizedTupleDigest: resolved.normalizedTupleDigest,
        });
        seeds.addNonPath('command', resolved.commandId, 'evidence-pin', item.id);
        commandSeedEdges.push({ commandId: resolved.commandId, origin: 'evidence-pin', itemId: item.id, intentRef });
        continue;
      }
      // A pin that binds to nothing is a classified fact, never a dropped one.
      // Its CODE carries the distinction the planner acts on: a broken inventory
      // identity stops, a non-inventory evidence command widens.
      escalations.push({ code: resolved.reason, detail: `${item.id} ${intentRef}: ${resolved.message}` });
      unclassifiedInputs.push({ kind: 'evidence-pin', detail: `${item.id} ${intentRef}: ${resolved.message}` });
    }
  }

  const commandIds = universe.entries.map((entry) => entry.id);
  const executionInventory: StoryRelevanceExecutionInventory = {
    sourceKind: args.routine.sourceKind,
    commandSetDigest: universe.commandSetDigest,
    commandIds,
    provisionalCommandIds: universe.entries.filter((entry) => entry.provisional).map((entry) => entry.id),
    warnings: [...universe.warnings],
  };

  const withoutDigest: Omit<StoryRelevanceInput, 'selectionDigest'> = {
    schema: STORY_RELEVANCE_INPUT_SCHEMA,
    storyId: args.story.storyId,
    phase: args.story.phase,
    hashes,
    changedFiles,
    seeds: seeds.listSeeds(),
    excludedPaths: seeds.listExcluded(),
    pinnedCommands,
    commandSeedEdges,
    unclassifiedInputs,
    riskSignals,
    executionInventory,
    durationHistory: collectDurationHistory(args, universe, commandIds),
    verificationIntentContext: collectVerificationIntentContext(args.checklist.items),
    escalations,
  };

  return { ...withoutDigest, selectionDigest: storyRelevanceSelectionDigest(withoutDigest) };
}
