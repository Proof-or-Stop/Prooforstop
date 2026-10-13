/**
 * EXPERIMENTAL A/B switch `review.laneMerge` (core/ab-variants.ts; default
 * `off`): ONE managed review session per REVIEW round carries every active
 * lane's review dimension, ported as an idea from the new PoS (docs/DECISIONS.md
 * ADR-064 "One merged code-review lane, as an option to measure": one session
 * whose prompt asks for all methods, path-triggered checklists kept). Old-PoS
 * cost data (bench-staging/oldpos/structural-cost-analysis.md §1, §7 item 3):
 * lanes are 45% of all input tokens (13.3 lane sessions per run, each one
 * re-reading the repository) and each REVIEW round costs about 15 min / 12M.
 *
 * With the switch `on`, every REVIEW round (round 1 and later rounds):
 *
 *   1. Roster (handlers/reviewer-list.ts computeFinalReviewRoster, the one
 *      roster chokepoint: REVIEW gate, epoch requiredLanes, reviewer_batch,
 *      lifecycle readiness, quorum_submit): the active lanes are the review
 *      DIMENSIONS; the first dimension in roster order that is not run
 *      separately is the CARRIER lane. Its one managed session reviews every
 *      merged dimension (signed selection 'lane-merge'); the other merged
 *      lanes are not launched. A lane runs separately (its own ordinary
 *      session, production prompt) when it is forced, when this round's merged
 *      PASS left its dimension uncovered, or when the previous round's merged
 *      FINDINGS verdict left it uncovered. A verified dependency-closure
 *      selection still wins (it already narrows the lanes).
 *   2. Prompt (core/managed-review-evidence.ts, sealed in host_run as
 *      reviewBinding.laneMerge): the carrier's own role prompt plus a MERGED
 *      REVIEW DIMENSIONS block with one explicit section per dimension: the
 *      dimension's concern, its checkpoints, the lane's full role prompt and
 *      the lane-specific dispatch rules (exact-text rubric, sibling parity).
 *      The repository is read once; every dimension is worked through.
 *   3. Coverage contract (checkLaneMergeNote at managed_review_evidence_import):
 *      the final note carries one `[checked] <dimension>:<checkpoint> ::
 *      <evidence>` line per checkpoint. A dimension with a missing line, a line
 *      without evidence, or a `[gap]` is NOT covered and is never passed: the
 *      framework relaunches that dimension as its own lane (fail closed). If the
 *      carrier's own dimension is uncovered, the pass is refused (nothing
 *      imported) and every dimension runs separately in that round.
 *   4. Findings keep their dimension: a merged finding's desc starts with
 *      `[dimension:<name>]`. The finding is attributed to the carrier lane (its
 *      signed ReviewRun), so routing, the inventory critic, metadata routing,
 *      pre-existing disposition, the regression guard and duplicate checks work
 *      unchanged; the tag records which dimension raised it.
 *   5. The inventory critic runs as before; no round cap, no severity decay:
 *      every verified finding still blocks until it is closed.
 *
 * Depth (lab lane-split, both values; old-PoS run 64 §4.4: the merged R1 session
 * read 2 files fully and triaged 11 by name, where a separate lane read 5-7, and
 * its test-coverage / docs `[checked]` lines were generic one-liners): every
 * merged dimension also lists the files it read in full (`[read] <dimension> ::
 * <file>, ...`; at least one of them must be in the proposal's
 * readManifest.filesReadFully), and a `[checked]` line's evidence must cite a
 * file:line or a command with its output. A generic line or a missing / unbacked
 * read list leaves the dimension uncovered: the same fail-closed relaunch.
 *
 * `review.laneMerge=split` (lab lane-split; run 64: the merged session cut lane
 * input 49-64% but lane wall rose to 13.7 min vs 8.6 / 11.9, because one session
 * serialised what four did in parallel): TWO merged sessions per round, launched
 * in parallel like ordinary lanes (LANE_MERGE_SPLIT_SESSIONS): concept + quality
 * (carrier concept) and test-coverage + docs, with behavior in the second
 * (carrier test-coverage). Pairing: each session's dimensions share one
 * repository read (concept and quality both start from the changed code and its
 * readers / edge paths; test-coverage, docs and behavior all map stated promises
 * (request, userSees, verificationIntent, doc paragraphs) to their evidence), and
 * the two read sets barely overlap, so the split costs little re-reading; the
 * calibration (calibration-newpos-r1.md, indicative) found every verified defect
 * in the concept or docs lane, so those two lead different sessions instead of
 * competing for one session's attention. Same per-dimension contract, tags and
 * routing per session; a session whose carrier leaves its own dimension
 * uncovered sends only that session's dimensions to their own lanes. A session
 * left with one dimension is an ordinary lane (its own prompt).
 *
 * How this differs from the rejected A3 `review.lanePack=shared`
 * (bench-staging/oldpos/ab/results-lane-pack.md): A3 kept all four lane
 * sessions and the critic and only prepended a 46 KB shared pack to each, so
 * every request grew while the request count barely fell (lane input −0.15M,
 * critic +0.34M, wall +1.3 min per round) and two seeded-defect trials were
 * lost (13/14 → 11/14). Lane merge removes sessions instead of enlarging
 * them: one session reads the repository once (the role bodies of the other
 * dimensions add about 20 KB to ONE prompt), so the saving is the three
 * avoided cold starts, not a cache effect. Its detection risk is different
 * (attention dilution in one session, not context bloat in four), so it is
 * guarded by the per-dimension coverage contract with fail-closed relaunch,
 * and it must pass the seeded-defect / calibration replay (ab/README.md
 * "Lane merge") before any default change. review.deltaRounds is not applied
 * while lane merge is on (vary one switch at a time).
 */
import { createHash } from 'node:crypto';
import { abVariantEvidence, laneMergeMode, laneMergeOn, resolveAbVariants, type AbVariantEvidence } from './ab-variants.js';
import { canonicalAgentRoleId } from './agent-role-identity.js';
import { loadConfig } from './config.js';
import { isCodeReviewLaneRun, isEarlierReviewRound } from './review-round-order.js';
import type { StoryStore } from './store.js';
import type { ReviewRun } from './types.js';

export const LANE_MERGE_SCHEMA = 'proof-or-stop.review-lane-merge.v1' as const;
/** Process event recorded at every merged import: which dimensions the note covered. */
export const LANE_MERGE_COVERAGE_EVENT = 'review_lane_merge_coverage' as const;
export const LANE_MERGE_BLOCK_BEGIN = '--- BEGIN MERGED REVIEW DIMENSIONS';
export const LANE_MERGE_BLOCK_END = '--- END MERGED REVIEW DIMENSIONS ---';

export type LaneMergeReason =
  | 'LANE_MERGE'
  | 'LANE_MERGE_OFF'
  | 'NO_CURRENT_ROUND'
  | 'CARRIER_GAP'
  | 'FEWER_THAN_TWO_DIMENSIONS';

export type LaneMergeSeparateReason = 'forced' | 'dimension_gap' | 'previous_dimension_gap' | 'carrier_gap';

/** The switch value that produced a plan ('on' = one merged session, 'split' = two in parallel). */
export type LaneMergeMode = 'on' | 'split';

/**
 * review.laneMerge=split: the two sessions' dimensions (short lane names, in this
 * order). A dimension not listed joins the session with fewer dimensions (ties:
 * the first). Rationale in the module header.
 */
export const LANE_MERGE_SPLIT_SESSIONS: ReadonlyArray<ReadonlyArray<string>> = [['concept', 'quality'], ['test-coverage', 'behavior', 'docs']];

/** One review session of a merged round: its carrier lane and the dimensions it reviews (one dimension = an ordinary lane). */
export interface LaneMergeGroup {
  carrier: string;
  /** Dimensions reviewed in this session (carrier first, roster order). */
  mergedLanes: string[];
  /** `<dimension>:<checkpoint>` of this session ([] for a one-dimension session: an ordinary lane, no merged block). */
  checkItems: string[];
}

export interface LaneMergeCheckpoint {
  /** `<dimension>:<checkpoint>`, e.g. `quality:edges`. */
  id: string;
  text: string;
}

/** What each dimension checks; a lane without an entry gets one checkpoint covering its whole role prompt. */
export const LANE_MERGE_DIMENSIONS: Readonly<Record<string, { concern: string; checkpoints: ReadonlyArray<{ id: string; text: string }> }>> = {
  concept: {
    concern: 'concept completeness: a concept the diff removes, renames or replaces leaves no residue, and every reader of a changed meaning honours it',
    checkpoints: [
      { id: 'residue', text: 'every concept word the diff deletes, renames or replaces: grep the whole repository (code, comments, docs, messages, flags) and report each residue' },
      { id: 'readers', text: 'every reader of a field or encoding whose meaning the diff changes (render / String() / serialize / print / equality / hash) honours the new meaning; never call a reader unrelated without a reason tied to the request' },
    ],
  },
  quality: {
    concern: 'code quality of the changed code: edge and error paths, dead code, type safety, I/O isolation, tests that assert the right value',
    checkpoints: [
      { id: 'edges', text: 'edge and error paths of every changed function: absent, explicit null, empty, zero, negative and out-of-range inputs, explicit versus omitted operands; no panic or crash on any valid input (probe them)' },
      { id: 'code', text: 'dead code, type safety, I/O isolation and error handling of the changed code; changed tests assert the value the request promises' },
    ],
  },
  'test-coverage': {
    concern: 'test coverage: every behaviour the diff adds or changes has a focused test that fails without it, asserting the exact promised value',
    checkpoints: [
      { id: 'behaviours', text: 'every behaviour the diff adds or changes (each verificationIntent, userSees and request example) has a focused test that would fail without the change' },
      { id: 'assertions', text: 'assertions check the exact promised value (request-quoted text exactly, never by prefix / contains / regex); no promised edge case is left untested' },
    ],
  },
  docs: {
    concern: 'documentation consistency: docs that describe the changed code match it, and every documented promise is delivered',
    checkpoints: [
      { id: 'sections', text: 'every documentation section that names a changed symbol, flag, example or behaviour still matches the code (run the examples)' },
      { id: 'promises', text: 'every promise the diff adds to docs (README, guides, examples, CLAUDE.md) is delivered by the code' },
    ],
  },
  behavior: {
    concern: 'functional correctness: every userSees outcome and its edge cases hold on the code',
    checkpoints: [
      { id: 'outcomes', text: 'every userSees outcome of the checklist holds on the code (run it, do not infer it)' },
      { id: 'edges', text: 'the edge cases of each outcome (empty, boundary, error input) behave as the request states' },
    ],
  },
};

export interface LaneMergePlan {
  schema: typeof LANE_MERGE_SCHEMA;
  storyId: string;
  eligible: boolean;
  reason: LaneMergeReason;
  detail: string;
  reviewRound: string | null;
  previousRound: string | null;
  /** Canonical lanes, active roster order: the review dimensions of this round. */
  dimensionLanes: string[];
  /** The switch value ('on' | 'split'); absent with the switch off. */
  mode?: LaneMergeMode;
  /** The carrier of the first merged session (null when not eligible); `groups` lists every session. */
  carrier: string | null;
  /** Dimensions reviewed inside a merged session (every merged session; carrier first for 'on'). */
  mergedLanes: string[];
  /** The round's review sessions over the non-separate dimensions: one for 'on', up to two for 'split'. */
  groups: LaneMergeGroup[];
  /** Dimensions reviewed by their own ordinary session in this round. */
  separateLanes: string[];
  separateReasons: Record<string, LaneMergeSeparateReason>;
  /** Roster order: the carrier and the separate lanes (all dimensions when not eligible). */
  selectedLanes: string[];
  /** `<dimension>:<checkpoint>` of every merged dimension: one `[checked]` line each (per session: groups[].checkItems). */
  checkItems: string[];
  /** Digest of the roster-deciding facts (stable while no coverage event of the round is recorded). */
  planDigest: string;
  abVariant?: AbVariantEvidence;
}

/** Sealed in the carrier's managed run spec (reviewBinding.laneMerge). */
export interface LaneMergeRunBinding {
  schema: typeof LANE_MERGE_SCHEMA;
  abVariant: AbVariantEvidence;
  role: 'merged';
  reviewRound: string;
  planDigest: string;
  carrier: string;
  mergedLanes: string[];
  checkItems: string[];
  /** review.laneMerge=split only: the session layout (this session + the other sessions' dimensions). */
  mode?: 'split';
  otherSessions?: string[][];
}

export interface LaneMergeCoverage {
  /** Dimensions (canonical lanes) whose every checkpoint has a [checked] line with evidence and no [gap]. */
  coveredLanes: string[];
  /** Dimensions not covered (missing line, no evidence, or [gap]). */
  missingLanes: string[];
  missingItems: string[];
  gaps: string[];
  /** The carrier's own dimension is not covered: nothing of a pass is accepted. */
  carrierMissing: boolean;
  /** Checkpoints whose `[checked]` evidence cites no file:line and no command with its output (depth contract). */
  genericItems: string[];
  /** Dimensions without a `[read]` line naming a fully read file (with a read manifest: one listed in filesReadFully). */
  unreadLanes: string[];
  /** Files each dimension (short name) listed as read in full. */
  readFiles: Record<string, string[]>;
  /** `<dimension>:<file>` listed as read in full but absent from readManifest.filesReadFully. */
  unverifiedReads: string[];
}

export type LaneMergeStore = Pick<StoryStore, 'readStory' | 'readReviewRuns' | 'readProcessEvents'>;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const short = (lane: string): string => canonicalAgentRoleId(lane).replace(/^proof-or-stop-review-/, '');
const canonical = (lane: string): string => canonicalAgentRoleId(lane.startsWith('proof-or-stop-review-') ? lane : `proof-or-stop-review-${lane}`);

/** Checkpoints of one dimension (canonical or short lane id), ids prefixed with the dimension. */
export function laneMergeCheckpoints(lane: string): LaneMergeCheckpoint[] {
  const name = short(lane);
  const entry = LANE_MERGE_DIMENSIONS[name];
  if (!entry) return [{ id: `${name}:role`, text: `the full remit of the ${name} lane's role prompt below, every check it asks for` }];
  return entry.checkpoints.map(row => ({ id: `${name}:${row.id}`, text: row.text }));
}

export function laneMergeConcern(lane: string): string {
  const name = short(lane);
  return LANE_MERGE_DIMENSIONS[name]?.concern ?? `the ${name} lane's concern as its role prompt states it`;
}

/** The switch as consumed here: malformed = off (production); evidence lists every non-default switch. */
export function laneMergeVariant(projectRoot: string): AbVariantEvidence | undefined {
  let config: unknown;
  try { config = loadConfig(projectRoot); } catch { return undefined; }
  if (!laneMergeOn(config)) return undefined;
  const fallback: AbVariantEvidence = { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.laneMerge': laneMergeMode(config) } };
  try {
    return abVariantEvidence(resolveAbVariants(config)) ?? fallback;
  } catch {
    return fallback;
  }
}

/** The plan's mode from its recorded arm ('split' only when the evidence says so). */
const modeOf = (abVariant: AbVariantEvidence): LaneMergeMode => abVariant.flags['review.laneMerge'] === 'split' ? 'split' : 'on';

/**
 * The sessions of a round over `dimensionLanes` (canonical, roster order): 'on' =
 * one session, 'split' = LANE_MERGE_SPLIT_SESSIONS (an unlisted dimension joins
 * the session with fewer dimensions, ties the first). Empty sessions are dropped.
 */
export function laneMergeSessions(mode: LaneMergeMode, dimensionLanes: readonly string[]): string[][] {
  if (mode === 'on') return dimensionLanes.length ? [[...dimensionLanes]] : [];
  const sessions: string[][] = LANE_MERGE_SPLIT_SESSIONS.map(() => []);
  const unlisted: string[] = [];
  for (const lane of dimensionLanes) {
    const index = LANE_MERGE_SPLIT_SESSIONS.findIndex(names => names.includes(short(lane)));
    if (index >= 0) sessions[index]!.push(lane); else unlisted.push(lane);
  }
  for (const lane of unlisted) {
    const smallest = sessions.reduce((best, row, index) => (row.length < sessions[best]!.length ? index : best), 0);
    sessions[smallest]!.push(lane);
  }
  // Roster order inside each session (the carrier is the first one not run separately).
  return sessions.map(row => dimensionLanes.filter(lane => row.includes(lane))).filter(row => row.length > 0);
}

interface CoverageEventRow { type: string; reviewRound?: unknown; conclusion?: unknown; missingLanes?: unknown; carrierMissing?: unknown; carrier?: unknown; mergedLanes?: unknown }
const lanesOf = (value: unknown): string[] => Array.isArray(value) ? value.filter((row): row is string => typeof row === 'string').map(canonical) : [];

/**
 * The lane-merge plan of the Story's current REVIEW round. Ineligible plans
 * name the reason; the round then runs every dimension as its own lane,
 * exactly as with the switch off.
 */
export function computeLaneMergePlan(args: {
  store: LaneMergeStore;
  projectRoot: string;
  storyId: string;
  /** Canonical lane ids, active roster order. */
  dimensionLanes: readonly string[];
  forcedLanes?: readonly string[];
}): LaneMergePlan {
  const { store, projectRoot, storyId } = args;
  const dimensionLanes = [...new Set(args.dimensionLanes.map(canonical))];
  const abVariant = laneMergeVariant(projectRoot);
  let story: { currentReviewRound?: string } = {};
  try { story = store.readStory(storyId) as { currentReviewRound?: string }; } catch { story = {}; }
  const reviewRound = story.currentReviewRound ?? null;
  const mode = abVariant ? modeOf(abVariant) : undefined;
  const base: LaneMergePlan = {
    schema: LANE_MERGE_SCHEMA, storyId, eligible: false, reason: 'LANE_MERGE_OFF', detail: 'review.laneMerge is off',
    reviewRound, previousRound: null, dimensionLanes, ...(mode ? { mode } : {}), carrier: null, mergedLanes: [], groups: [], separateLanes: [...dimensionLanes],
    separateReasons: {}, selectedLanes: [...dimensionLanes], checkItems: [], planDigest: '',
    ...(abVariant ? { abVariant } : {}),
  };
  const fallback = (reason: LaneMergeReason, detail: string, extra: Partial<LaneMergePlan> = {}): LaneMergePlan => {
    const out: LaneMergePlan = { ...base, ...extra, eligible: false, reason, detail, carrier: null, mergedLanes: [], groups: [],
      separateLanes: [...dimensionLanes], selectedLanes: [...dimensionLanes], checkItems: [] };
    return { ...out, planDigest: digestPlan(out) };
  };
  if (!abVariant) return fallback('LANE_MERGE_OFF', 'review.laneMerge is off (absent or malformed)');
  if (!reviewRound) return fallback('NO_CURRENT_ROUND', 'REVIEW has no current round');
  let runs: ReviewRun[] = [];
  try { runs = store.readReviewRuns(storyId).runs; } catch { runs = []; }
  const previousRound = runs.filter(run => isCodeReviewLaneRun(run) && run.reviewRound !== reviewRound && isEarlierReviewRound(run.reviewRound, reviewRound))
    .map(run => run.reviewRound).sort((a, b) => (isEarlierReviewRound(a, b) ? -1 : isEarlierReviewRound(b, a) ? 1 : 0)).at(-1) ?? null;
  let events: CoverageEventRow[] = [];
  try { events = (store.readProcessEvents(storyId) as unknown as CoverageEventRow[]).filter(event => event.type === LANE_MERGE_COVERAGE_EVENT); } catch { events = []; }
  const separateReasons: Record<string, LaneMergeSeparateReason> = {};
  const mark = (lane: string, reason: LaneMergeSeparateReason) => { if (dimensionLanes.includes(lane) && !separateReasons[lane]) separateReasons[lane] = reason; };
  for (const lane of (args.forcedLanes ?? []).map(canonical)) mark(lane, 'forced');
  // The previous round's merged FINDINGS verdict that left a dimension uncovered: that dimension runs on its own now.
  for (const event of events.filter(row => previousRound && row.reviewRound === previousRound && row.conclusion === 'findings')) {
    for (const lane of lanesOf(event.missingLanes)) mark(lane, 'previous_dimension_gap');
  }
  const current = events.filter(row => row.reviewRound === reviewRound && row.conclusion === 'pass' && lanesOf(row.missingLanes).length > 0);
  const sessions = laneMergeSessions(mode!, dimensionLanes);
  if (mode === 'on' && current.some(row => row.carrierMissing === true)) {
    return fallback('CARRIER_GAP', `the merged session of round ${reviewRound} left its own dimension uncovered: its pass was not accepted and every dimension runs as its own lane`,
      { previousRound });
  }
  // split: a session whose carrier left its own dimension uncovered sends only ITS dimensions to their own lanes.
  for (const event of current.filter(row => row.carrierMissing === true)) {
    const recorded = lanesOf(event.mergedLanes);
    const carrierLane = typeof event.carrier === 'string' ? canonical(event.carrier) : null;
    const lanes = recorded.length ? recorded : sessions.find(row => carrierLane && row.includes(carrierLane)) ?? lanesOf(event.missingLanes);
    for (const lane of lanes) mark(lane, 'carrier_gap');
  }
  for (const event of current.filter(row => row.carrierMissing !== true)) for (const lane of lanesOf(event.missingLanes)) mark(lane, 'dimension_gap');
  const separateLanes = dimensionLanes.filter(lane => separateReasons[lane]);
  const groups: LaneMergeGroup[] = sessions.map(row => row.filter(lane => !separateReasons[lane])).filter(row => row.length > 0).map(row => ({
    carrier: row[0]!,
    mergedLanes: row,
    checkItems: row.length >= 2 ? row.flatMap(lane => laneMergeCheckpoints(lane).map(item => item.id)) : [],
  }));
  const mergedGroups = groups.filter(group => group.mergedLanes.length >= 2);
  if (mergedGroups.length === 0) {
    const left = dimensionLanes.length - separateLanes.length;
    if (Object.values(separateReasons).includes('carrier_gap')) {
      return fallback('CARRIER_GAP', `the merged sessions of round ${reviewRound} left their own dimensions uncovered: their passes were not accepted and every dimension runs as its own lane`,
        { previousRound, separateReasons });
    }
    return fallback('FEWER_THAN_TWO_DIMENSIONS', `${left} dimension(s) left to merge (${dimensionLanes.length} active, ${separateLanes.length} separate)${mode === 'split' ? ', no session with two' : ''}: every dimension runs as its own lane`,
      { previousRound, separateReasons });
  }
  const mergedLanes = dimensionLanes.filter(lane => mergedGroups.some(group => group.mergedLanes.includes(lane)));
  const carriers = groups.map(group => group.carrier);
  const describe = (group: LaneMergeGroup) => group.mergedLanes.length >= 2 ? `(${short(group.carrier)}) for ${group.mergedLanes.map(short).join(', ')}` : `${short(group.carrier)} (its own lane)`;
  const out: LaneMergePlan = {
    ...base,
    eligible: true,
    reason: 'LANE_MERGE',
    detail: `${mode === 'split' ? `${groups.length} parallel session(s): ${groups.map(describe).join(' | ')}` : `one session ${describe(groups[0]!)}`}${separateLanes.length ? `; separate: ${separateLanes.map(lane => `${short(lane)} (${separateReasons[lane]})`).join(', ')}` : ''}`,
    previousRound,
    carrier: mergedGroups[0]!.carrier,
    mergedLanes,
    groups,
    separateLanes,
    separateReasons,
    selectedLanes: dimensionLanes.filter(lane => carriers.includes(lane) || separateReasons[lane]),
    checkItems: mergedGroups.flatMap(group => group.checkItems),
  };
  return { ...out, planDigest: digestPlan(out) };
}

/** Digest of the facts that decide the roster. */
function digestPlan(plan: LaneMergePlan): string {
  return sha256(JSON.stringify({
    schema: plan.schema, storyId: plan.storyId, eligible: plan.eligible, reason: plan.reason, reviewRound: plan.reviewRound,
    previousRound: plan.previousRound, dimensionLanes: plan.dimensionLanes, carrier: plan.carrier, mergedLanes: plan.mergedLanes,
    separateLanes: plan.separateLanes, separateReasons: plan.separateReasons, checkItems: plan.checkItems,
    // 'on' keeps the digest it had before split existed; split binds its session layout too.
    ...(plan.mode === 'split' ? { mode: plan.mode, groups: plan.groups } : {}),
  }));
}

/** The stable roster basis an inventory epoch binds for a merged round (handlers/reviewer-list.ts finalReviewRosterBasis). */
export function laneMergeRosterBasis(plan: LaneMergePlan, policyVersion: string): string {
  return JSON.stringify({ policyVersion, kind: 'lane-merge', dimensionLanes: plan.dimensionLanes, selectedLanes: plan.selectedLanes, planDigest: plan.planDigest });
}

/** The merged session (two or more dimensions) a lane carries in this plan, or null. */
export function laneMergeGroupOf(plan: LaneMergePlan | null | undefined, lane: string): LaneMergeGroup | null {
  if (!plan?.eligible) return null;
  const id = canonical(lane);
  // A plan recorded before split existed has no groups: its one session is the carrier's.
  const groups = plan.groups ?? (plan.carrier ? [{ carrier: plan.carrier, mergedLanes: plan.mergedLanes, checkItems: plan.checkItems }] : []);
  return groups.find(group => group.carrier === id && group.mergedLanes.length >= 2) ?? null;
}

/** Sealed per carrier: its session's dimensions and checkpoints (`carrier` absent = the first merged session). */
export function laneMergeBinding(plan: LaneMergePlan, carrier?: string): LaneMergeRunBinding {
  if (!plan.eligible || !plan.abVariant || !plan.reviewRound || !plan.carrier) {
    throw new Error(`laneMergeBinding: plan is not an eligible merged round (${plan.reason})`);
  }
  const group = laneMergeGroupOf(plan, carrier ?? plan.carrier);
  if (!group) throw new Error(`laneMergeBinding: ${carrier} is not a carrier of a merged session of round ${plan.reviewRound}`);
  return {
    schema: LANE_MERGE_SCHEMA, abVariant: plan.abVariant, role: 'merged', reviewRound: plan.reviewRound,
    planDigest: plan.planDigest, carrier: group.carrier, mergedLanes: group.mergedLanes, checkItems: group.checkItems,
    ...(plan.mode === 'split' ? { mode: 'split' as const, otherSessions: plan.groups.filter(row => row !== group).map(row => row.mergedLanes) } : {}),
  };
}

/** 'merged' when this lane carries a merged session of this round; null otherwise (an ordinary lane prompt). */
export function laneMergeRole(plan: LaneMergePlan | null | undefined, lane: string, reviewRound: string): 'merged' | null {
  if (!plan?.eligible || plan.reviewRound !== reviewRound || !plan.carrier) return null;
  return laneMergeGroupOf(plan, lane) ? 'merged' : null;
}

/** One dimension's prompt material beyond the carrier's own role prompt (built by core/review-lane-merge-prompt.ts). */
export interface LaneMergeDimensionSection {
  lane: string;
  /** The lane's full role prompt; null for the carrier (its role prompt is the base prompt above the block). */
  roleBody: string | null;
  /** Lane-specific dispatch rules (exact-text rubric, sibling parity) the carrier's dispatch prompt does not carry. */
  extras: string[];
}

/**
 * The carrier's sealed MERGED REVIEW DIMENSIONS block: one explicit section per
 * dimension with its concern, checkpoints, role prompt and lane rules, the
 * finding tag rule, and the per-checkpoint coverage contract.
 */
export function renderLaneMergeBlock(plan: LaneMergePlan, sections: readonly LaneMergeDimensionSection[], carrierLane?: string): string[] {
  const group = laneMergeGroupOf(plan, carrierLane ?? plan.carrier ?? '')
    ?? { carrier: plan.carrier ?? '', mergedLanes: plan.mergedLanes, checkItems: plan.checkItems };
  const carrier = group.carrier;
  const names = group.mergedLanes.map(short);
  const split = plan.mode === 'split';
  const others = (plan.groups ?? []).filter(row => row.carrier !== carrier).flatMap(row => row.mergedLanes).map(short);
  const separate = plan.separateLanes.map(short);
  const lines = [
    `${LANE_MERGE_BLOCK_BEGIN} (A/B review.laneMerge=${split ? 'split' : 'on'}, experimental; round ${plan.reviewRound}) ---`,
    split
      ? `This REVIEW round runs ${plan.groups.length} review sessions in parallel instead of one session per lane; THIS session reviews ${names.length} dimensions: ${names.join(', ')}. Each section below is the full remit of the lane that would otherwise review this Story on its own: its concern, its checkpoints, its role prompt and its rules apply in full. Your own role prompt above is the ${short(carrier)} dimension.`
      : `This REVIEW round runs ONE review session for ${names.length} review dimensions instead of one session per lane: ${names.join(', ')}. Each section below is the full remit of the lane that would otherwise review this Story on its own: its concern, its checkpoints, its role prompt and its rules apply in full. Your own role prompt above is the ${short(carrier)} dimension.`,
    ...(others.length ? [`Reviewed in another session this round, in parallel (not yours): ${others.join(', ')}.`] : []),
    ...(separate.length ? [`Reviewed in a separate session this round (not yours): ${separate.join(', ')}.`] : []),
    'Method: read the Story diff and the files it touches ONCE, then work through EVERY dimension section below in order, as each lane would. Read in full every file a dimension needs (the changed files, their readers, the tests and docs it judges); a file only triaged by name is not read. A problem found in one dimension never excuses skipping another; do not stop after the first finding.',
    'Findings: report every finding of every dimension in the one final proposal. Begin each finding\'s desc with its dimension tag, e.g. `[dimension:' + names[names.length > 1 ? 1 : 0] + '] ...` (one of: ' + names.map(name => `[dimension:${name}]`).join(', ') + '). A problem several dimensions see is reported once, tagged with the dimension whose check found it.',
    'Coverage lines (mandatory for a pass AND for findings): your final note MUST contain one [checked] line per checkpoint and one [read] line per dimension listed below, exactly in these forms:',
    '  [checked] <checkpoint> :: <specific evidence: a file:line you read (e.g. pkg/file.go:42) or a command you ran with its output (`<command>` -> <what it printed>), and what it showed>',
    '  [read] <dimension> :: <file>, <file>, ... (the files you read in full for this dimension; each also in readManifest.filesReadFully)',
    '  [gap] <checkpoint> :: <why it was not checked>',
    'Evidence is specific or it does not count: a [checked] line that cites no file:line and no command with its output (e.g. "every intent mapped, all pass", "no new promises", "no issues") is generic and the checkpoint is NOT checked.',
    `A dimension with any checkpoint missing, without specific evidence after "::", or marked [gap], or without a [read] line naming a file you read in full, is NOT covered: the framework never accepts it as reviewed and relaunches that dimension as its own separate review session. If your own dimension (${short(carrier)}) is not covered, nothing of a pass is accepted and every dimension of this session is reviewed again separately.`,
  ];
  group.mergedLanes.forEach((lane, index) => {
    const section = sections.find(row => canonicalAgentRoleId(row.lane) === lane);
    lines.push('');
    lines.push(`### Dimension ${index + 1}/${group.mergedLanes.length}: ${short(lane)} (lane ${lane})${lane === carrier ? ' — your role prompt above' : ''}`);
    lines.push(`Concern: ${laneMergeConcern(lane)}`);
    lines.push('Checkpoints (one [checked] line each):');
    for (const row of laneMergeCheckpoints(lane)) lines.push(`- ${row.id} — ${row.text}`);
    // The carrier's role prompt is the base prompt above the block: never repeated here.
    if (section?.roleBody && lane !== carrier) {
      lines.push(`Role prompt of the ${short(lane)} dimension (apply its checks in full; the managed protocol above still decides how you record results: no review_run_start / finding_add / review_pass_set, one final proposal):`);
      lines.push(`<<<ROLE ${short(lane)}`);
      lines.push(section.roleBody.trim());
      lines.push(`ROLE ${short(lane)}>>>`);
    }
    if (section?.extras.length) lines.push(...section.extras);
  });
  lines.push(LANE_MERGE_BLOCK_END);
  return lines;
}

const NOTE_MARKER = /\[(?:checked|gap|read)\]/g;
const NOTE_SEGMENT = /^\[(checked|gap|read)\]\s+(\S+)([\s\S]*)$/;
type NoteKind = 'checked' | 'gap' | 'read';
/** An item token as a reviewer writes it: `quoted`, *bold*, `dimension:` prefixed, or followed by a colon / full stop. */
const cleanItem = (item: string): string => item.replace(/^[`'"*(]+/, '').replace(/[`'"*),;:.]+$/, '').replace(/^dimension:/, '');

/** Every `[checked]` / `[gap]` segment of a note; a marker counts wherever it stands (a flattened one-line note parses). */
function noteSegments(note: string): Array<{ kind: NoteKind; item: string; evidence: string }> {
  const out: Array<{ kind: NoteKind; item: string; evidence: string }> = [];
  for (const line of note.split('\n')) {
    const starts = [...line.matchAll(NOTE_MARKER)].map(match => match.index ?? 0);
    starts.forEach((start, index) => {
      const segment = line.slice(start, starts[index + 1] ?? line.length).trim();
      const match = segment.match(NOTE_SEGMENT);
      if (!match) return;
      const rest = match[3]!.trim();
      const evidence = rest.startsWith('::') ? rest.slice(2).trim() : rest.replace(/^[-—:]+\s*/, '').trim();
      out.push({ kind: match[1] as NoteKind, item: cleanItem(match[2]!), evidence });
    });
  }
  return out;
}

/** Minimum evidence text after a [checked] item: a bare `[checked] quality:edges` is not coverage. */
const MIN_EVIDENCE_CHARS = 8;

/** A file:line citation (`dir/file.ext:42`, `file.ext:42-60`, `file.ext#L42`). */
const FILE_LINE = /[A-Za-z0-9_./-]*[A-Za-z0-9_]\.[A-Za-z0-9]{1,8}(?::\d+|#L\d+)/;
/** A command in backticks followed by what it printed (`<command>` -> / → / => / printed / returned / gives / exit ...). */
const COMMAND_OUTPUT = /`[^`]{2,}`\s*(?:->|→|=>|(?:printed|prints|printing|returned|returns|gave|gives|output|outputs|exited|exits|exit|failed|fails|panicked|panics|passed|passes|ok|pass|fail|error)\b)/i;

/**
 * Depth contract: evidence is specific when it cites a file:line or a command
 * with its output; anything else ("all intents mapped, all pass") is generic.
 */
export function isSpecificEvidence(evidence: string): boolean {
  return FILE_LINE.test(evidence) || COMMAND_OUTPUT.test(evidence);
}

/** A path as a reviewer writes it in a [read] list: unquoted, no leading ./, no :line / #Lline suffix. */
function cleanPath(token: string): string {
  return token.replace(/^[`'"*(\[]+/, '').replace(/[`'"*),;.\]]+$/, '').replace(/^\.\//, '').replace(/(?::\d+(?:[-:]\d+)?|#L\d+(?:-L?\d+)?)$/, '');
}
const isPathLike = (token: string): boolean => token.length > 0 && !/\s/.test(token) && (token.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(token));
const samePath = (a: string, b: string): boolean => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/**
 * The coverage contract of a merged session's note (deterministic, no command
 * runs): per merged dimension, every checkpoint needs a `[checked]` line with
 * specific evidence (a file:line or a command with its output) and no `[gap]`,
 * and the dimension needs a `[read]` line naming at least one file it read in
 * full (with a read manifest: one of readManifest.filesReadFully). Fail closed:
 * anything else leaves the dimension uncovered.
 */
export function checkLaneMergeNote(args: {
  binding: Pick<LaneMergeRunBinding, 'carrier' | 'mergedLanes' | 'checkItems'>;
  note: string;
  /** The proposal's read manifest; its filesReadFully backs the [read] lists. */
  readManifest?: { filesReadFully?: unknown } | null;
}): LaneMergeCoverage {
  const checked = new Set<string>();
  const gapped = new Set<string>();
  const generic = new Set<string>();
  const gaps: string[] = [];
  const dims = args.binding.mergedLanes.map(short);
  const readFiles: Record<string, string[]> = {};
  for (const { kind, item, evidence } of noteSegments(args.note ?? '')) {
    if (kind === 'read') {
      if (!dims.includes(item)) continue;
      const files = evidence.split(/[\s,]+/).map(cleanPath).filter(isPathLike);
      readFiles[item] = [...new Set([...(readFiles[item] ?? []), ...files])];
      continue;
    }
    if (!args.binding.checkItems.includes(item)) continue;
    if (kind === 'gap') { gapped.add(item); gaps.push(`${item}${evidence ? ` :: ${evidence}` : ''}`); }
    else if (evidence.length >= MIN_EVIDENCE_CHARS && isSpecificEvidence(evidence)) checked.add(item);
    else if (evidence.length >= MIN_EVIDENCE_CHARS) generic.add(item);
  }
  const manifest = Array.isArray(args.readManifest?.filesReadFully)
    ? (args.readManifest!.filesReadFully as unknown[]).filter((row): row is string => typeof row === 'string').map(cleanPath).filter(Boolean) : null;
  const unverifiedReads: string[] = [];
  const unreadLanes = args.binding.mergedLanes.filter(lane => {
    const files = readFiles[short(lane)] ?? [];
    if (!manifest) return files.length === 0;
    const verified = files.filter(file => manifest.some(full => samePath(full, file)));
    unverifiedReads.push(...files.filter(file => !verified.includes(file)).map(file => `${short(lane)}:${file}`));
    return verified.length === 0;
  });
  const genericItems = args.binding.checkItems.filter(item => generic.has(item) && !checked.has(item));
  const missingItems = args.binding.checkItems.filter(item => !checked.has(item) || gapped.has(item));
  const missingLanes = args.binding.mergedLanes.filter(lane => unreadLanes.includes(lane) || missingItems.some(item => item.startsWith(`${short(lane)}:`)));
  return {
    coveredLanes: args.binding.mergedLanes.filter(lane => !missingLanes.includes(lane)),
    missingLanes,
    missingItems,
    gaps,
    carrierMissing: missingLanes.includes(args.binding.carrier),
    genericItems,
    unreadLanes,
    readFiles,
    unverifiedReads,
  };
}

/** The dimension tag of a merged finding (`[dimension:<name>]` anywhere in its desc), or null. */
export function findingDimension(desc: string | null | undefined): string | null {
  const match = (desc ?? '').match(/\[dimension:\s*([a-z][a-z0-9-]*)\s*\]/i);
  return match ? match[1]!.toLowerCase() : null;
}
