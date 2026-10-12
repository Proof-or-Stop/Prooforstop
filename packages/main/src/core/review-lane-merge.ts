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
import { abVariantEvidence, laneMergeOn, resolveAbVariants, type AbVariantEvidence } from './ab-variants.js';
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

export type LaneMergeSeparateReason = 'forced' | 'dimension_gap' | 'previous_dimension_gap';

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
  /** The lane whose one session carries every merged dimension (null when not eligible). */
  carrier: string | null;
  /** Dimensions reviewed in the carrier's session (carrier first). */
  mergedLanes: string[];
  /** Dimensions reviewed by their own ordinary session in this round. */
  separateLanes: string[];
  separateReasons: Record<string, LaneMergeSeparateReason>;
  /** Roster order: the carrier and the separate lanes (all dimensions when not eligible). */
  selectedLanes: string[];
  /** `<dimension>:<checkpoint>` of every merged dimension: one `[checked]` line each. */
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
  try {
    return abVariantEvidence(resolveAbVariants(config)) ?? { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.laneMerge': 'on' } };
  } catch {
    return { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.laneMerge': 'on' } };
  }
}

interface CoverageEventRow { type: string; reviewRound?: unknown; conclusion?: unknown; missingLanes?: unknown; carrierMissing?: unknown }
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
  const base: LaneMergePlan = {
    schema: LANE_MERGE_SCHEMA, storyId, eligible: false, reason: 'LANE_MERGE_OFF', detail: 'review.laneMerge is off',
    reviewRound, previousRound: null, dimensionLanes, carrier: null, mergedLanes: [], separateLanes: [...dimensionLanes],
    separateReasons: {}, selectedLanes: [...dimensionLanes], checkItems: [], planDigest: '',
    ...(abVariant ? { abVariant } : {}),
  };
  const fallback = (reason: LaneMergeReason, detail: string, extra: Partial<LaneMergePlan> = {}): LaneMergePlan => {
    const out: LaneMergePlan = { ...base, ...extra, eligible: false, reason, detail, carrier: null, mergedLanes: [],
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
  if (current.some(row => row.carrierMissing === true)) {
    return fallback('CARRIER_GAP', `the merged session of round ${reviewRound} left its own dimension uncovered: its pass was not accepted and every dimension runs as its own lane`,
      { previousRound });
  }
  for (const event of current) for (const lane of lanesOf(event.missingLanes)) mark(lane, 'dimension_gap');
  const separateLanes = dimensionLanes.filter(lane => separateReasons[lane]);
  const mergedLanes = dimensionLanes.filter(lane => !separateReasons[lane]);
  if (mergedLanes.length < 2) {
    return fallback('FEWER_THAN_TWO_DIMENSIONS', `${mergedLanes.length} dimension(s) left to merge (${dimensionLanes.length} active, ${separateLanes.length} separate): every dimension runs as its own lane`,
      { previousRound, separateReasons });
  }
  const carrier = mergedLanes[0]!;
  const out: LaneMergePlan = {
    ...base,
    eligible: true,
    reason: 'LANE_MERGE',
    detail: `one session (${short(carrier)}) for ${mergedLanes.map(short).join(', ')}${separateLanes.length ? `; separate: ${separateLanes.map(lane => `${short(lane)} (${separateReasons[lane]})`).join(', ')}` : ''}`,
    previousRound,
    carrier,
    mergedLanes,
    separateLanes,
    separateReasons,
    selectedLanes: dimensionLanes.filter(lane => lane === carrier || separateReasons[lane]),
    checkItems: mergedLanes.flatMap(lane => laneMergeCheckpoints(lane).map(row => row.id)),
  };
  return { ...out, planDigest: digestPlan(out) };
}

/** Digest of the facts that decide the roster. */
function digestPlan(plan: LaneMergePlan): string {
  return sha256(JSON.stringify({
    schema: plan.schema, storyId: plan.storyId, eligible: plan.eligible, reason: plan.reason, reviewRound: plan.reviewRound,
    previousRound: plan.previousRound, dimensionLanes: plan.dimensionLanes, carrier: plan.carrier, mergedLanes: plan.mergedLanes,
    separateLanes: plan.separateLanes, separateReasons: plan.separateReasons, checkItems: plan.checkItems,
  }));
}

/** The stable roster basis an inventory epoch binds for a merged round (handlers/reviewer-list.ts finalReviewRosterBasis). */
export function laneMergeRosterBasis(plan: LaneMergePlan, policyVersion: string): string {
  return JSON.stringify({ policyVersion, kind: 'lane-merge', dimensionLanes: plan.dimensionLanes, selectedLanes: plan.selectedLanes, planDigest: plan.planDigest });
}

export function laneMergeBinding(plan: LaneMergePlan): LaneMergeRunBinding {
  if (!plan.eligible || !plan.abVariant || !plan.reviewRound || !plan.carrier) {
    throw new Error(`laneMergeBinding: plan is not an eligible merged round (${plan.reason})`);
  }
  return {
    schema: LANE_MERGE_SCHEMA, abVariant: plan.abVariant, role: 'merged', reviewRound: plan.reviewRound,
    planDigest: plan.planDigest, carrier: plan.carrier, mergedLanes: plan.mergedLanes, checkItems: plan.checkItems,
  };
}

/** 'merged' when this lane carries the merged session of this round; null otherwise (an ordinary lane prompt). */
export function laneMergeRole(plan: LaneMergePlan | null | undefined, lane: string, reviewRound: string): 'merged' | null {
  if (!plan?.eligible || plan.reviewRound !== reviewRound || !plan.carrier) return null;
  return canonicalAgentRoleId(lane) === plan.carrier ? 'merged' : null;
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
export function renderLaneMergeBlock(plan: LaneMergePlan, sections: readonly LaneMergeDimensionSection[]): string[] {
  const carrier = plan.carrier ?? '';
  const names = plan.mergedLanes.map(short);
  const separate = plan.separateLanes.map(short);
  const lines = [
    `${LANE_MERGE_BLOCK_BEGIN} (A/B review.laneMerge=on, experimental; round ${plan.reviewRound}) ---`,
    `This REVIEW round runs ONE review session for ${names.length} review dimensions instead of one session per lane: ${names.join(', ')}. Each section below is the full remit of the lane that would otherwise review this Story on its own: its concern, its checkpoints, its role prompt and its rules apply in full. Your own role prompt above is the ${short(carrier)} dimension.`,
    ...(separate.length ? [`Reviewed in a separate session this round (not yours): ${separate.join(', ')}.`] : []),
    'Method: read the Story diff and the files it touches ONCE, then work through EVERY dimension section below in order, as each lane would. A problem found in one dimension never excuses skipping another; do not stop after the first finding.',
    'Findings: report every finding of every dimension in the one final proposal. Begin each finding\'s desc with its dimension tag, e.g. `[dimension:quality] ...` (one of: ' + names.map(name => `[dimension:${name}]`).join(', ') + '). A problem several dimensions see is reported once, tagged with the dimension whose check found it.',
    'Coverage lines (mandatory for a pass AND for findings): your final note MUST contain one line per checkpoint listed below, exactly in these forms:',
    '  [checked] <checkpoint> :: <what you read or ran for this checkpoint and what it showed>',
    '  [gap] <checkpoint> :: <why it was not checked>',
    `A dimension with any checkpoint missing, without evidence text after "::", or marked [gap] is NOT covered: the framework never accepts it as reviewed and relaunches that dimension as its own separate review session. If your own dimension (${short(carrier)}) is not covered, nothing of a pass is accepted and every dimension is reviewed again separately.`,
  ];
  plan.mergedLanes.forEach((lane, index) => {
    const section = sections.find(row => canonicalAgentRoleId(row.lane) === lane);
    lines.push('');
    lines.push(`### Dimension ${index + 1}/${plan.mergedLanes.length}: ${short(lane)} (lane ${lane})${lane === carrier ? ' — your role prompt above' : ''}`);
    lines.push(`Concern: ${laneMergeConcern(lane)}`);
    lines.push('Checkpoints (one [checked] line each):');
    for (const row of laneMergeCheckpoints(lane)) lines.push(`- ${row.id} — ${row.text}`);
    if (section?.roleBody) {
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

const NOTE_MARKER = /\[(?:checked|gap)\]/g;
const NOTE_SEGMENT = /^\[(checked|gap)\]\s+(\S+)([\s\S]*)$/;
/** An item token as a reviewer writes it: `quoted`, *bold*, `dimension:` prefixed, or followed by a colon / full stop. */
const cleanItem = (item: string): string => item.replace(/^[`'"*(]+/, '').replace(/[`'"*),;:.]+$/, '').replace(/^dimension:/, '');

/** Every `[checked]` / `[gap]` segment of a note; a marker counts wherever it stands (a flattened one-line note parses). */
function noteSegments(note: string): Array<{ kind: 'checked' | 'gap'; item: string; evidence: string }> {
  const out: Array<{ kind: 'checked' | 'gap'; item: string; evidence: string }> = [];
  for (const line of note.split('\n')) {
    const starts = [...line.matchAll(NOTE_MARKER)].map(match => match.index ?? 0);
    starts.forEach((start, index) => {
      const segment = line.slice(start, starts[index + 1] ?? line.length).trim();
      const match = segment.match(NOTE_SEGMENT);
      if (!match) return;
      const rest = match[3]!.trim();
      const evidence = rest.startsWith('::') ? rest.slice(2).trim() : rest.replace(/^[-—:]+\s*/, '').trim();
      out.push({ kind: match[1] as 'checked' | 'gap', item: cleanItem(match[2]!), evidence });
    });
  }
  return out;
}

/** Minimum evidence text after a [checked] item: a bare `[checked] quality:edges` is not coverage. */
const MIN_EVIDENCE_CHARS = 8;

/**
 * The coverage contract of a merged session's note (deterministic, no command
 * runs): per merged dimension, every checkpoint needs a `[checked]` line with
 * evidence and no `[gap]`. Fail closed: anything else leaves the dimension
 * uncovered.
 */
export function checkLaneMergeNote(args: { binding: Pick<LaneMergeRunBinding, 'carrier' | 'mergedLanes' | 'checkItems'>; note: string }): LaneMergeCoverage {
  const checked = new Set<string>();
  const gapped = new Set<string>();
  const gaps: string[] = [];
  for (const { kind, item, evidence } of noteSegments(args.note ?? '')) {
    if (!args.binding.checkItems.includes(item)) continue;
    if (kind === 'gap') { gapped.add(item); gaps.push(`${item}${evidence ? ` :: ${evidence}` : ''}`); }
    else if (evidence.length >= MIN_EVIDENCE_CHARS) checked.add(item);
  }
  const missingItems = args.binding.checkItems.filter(item => !checked.has(item) || gapped.has(item));
  const missingLanes = args.binding.mergedLanes.filter(lane => missingItems.some(item => item.startsWith(`${short(lane)}:`)));
  return {
    coveredLanes: args.binding.mergedLanes.filter(lane => !missingLanes.includes(lane)),
    missingLanes,
    missingItems,
    gaps,
    carrierMissing: missingLanes.includes(args.binding.carrier),
  };
}

/** The dimension tag of a merged finding (`[dimension:<name>]` anywhere in its desc), or null. */
export function findingDimension(desc: string | null | undefined): string | null {
  const match = (desc ?? '').match(/\[dimension:\s*([a-z][a-z0-9-]*)\s*\]/i);
  return match ? match[1]!.toLowerCase() : null;
}
