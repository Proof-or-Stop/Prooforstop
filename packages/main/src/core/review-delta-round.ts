/**
 * EXPERIMENTAL A/B switch `review.deltaRounds` (core/ab-variants.ts; default
 * `off`): true delta re-review for REVIEW rounds 2+, ported as ideas from the
 * new PoS (docs/DECISIONS.md ADR-039 "Review converges and re-reviews only the
 * repair", ADR-043 "confirmation re-reviews", ADR-054 "Reviews scale with the
 * change and never pass what they did not check"). Old-PoS cost data
 * (bench-staging/oldpos/structural-cost-analysis.md §7 item 2): each extra
 * review round costs 15.0 ± 2.4 min / 12.0 ± 2.9M tokens and rounds explain 93%
 * of wall-time variance; round 2+ ran every active lane in full plus the
 * inventory critic.
 *
 * With the switch `on`, a REVIEW round N >= 2 whose previous round ended in a
 * remediation (its `review-remediation-only` inventory receipt was consumed by
 * REVIEW->DEV) is a DELTA ROUND:
 *
 *   1. Scope = the repair diff since the previous round's reviewed candidate
 *      (the receipt cutoff head .. HEAD, material paths): its hunks, their
 *      enclosing definitions and the callers / callees of those definitions in
 *      the same file (deltaRoundScope: a deterministic, language-neutral
 *      definition-line scan, bounded), plus every finding resolved in that
 *      remediation (each re-verified by re-running its test, not by its
 *      status) and every still-open finding.
 *   2. Lanes: a lane that raised a non-duplicate, non-rejected finding in the
 *      previous round that was not closed without a repair (old-PoS run 52: a
 *      preexisting_out_of_scope / accepted_risk / duplicate closure is noise,
 *      not a raise) and any forced lane re-reviews the whole Story; every
 *      other active lane is replaced by ONE confirmation lane (the first
 *      replaced lane in roster order carries it). Its prompt lists the replaced
 *      lanes' concerns and the delta scope; its note must carry one
 *      `[checked] <item>` line per check item and one `[reverified] <finding>
 *      :: <command> :: <output line>` per resolved finding, and the framework
 *      re-runs each command (core/review-delta-confirmation.ts). A [gap] on a
 *      check item or resolved finding, an unchecked item, an unread file or a
 *      failing re-run is NOT a pass: the gap is recorded (process event
 *      delta_round_confirmation_gap) and, for a pass verdict, the round falls
 *      back to a full round (every active lane in full). Old-PoS run 52: a
 *      FINDINGS verdict with a gap imports its findings and launches no late
 *      lane in its own round (the Story goes to remediation anyway); the NEXT
 *      round is a full round (PREVIOUS_CONFIRMATION_GAP), so the replaced
 *      concerns are still reviewed before DONE. A findings verdict with
 *      complete coverage lines is not a gap at all (its note is kept in the
 *      findings proposal, core/managed-host-run.ts).
 *   3. Critic: a delta round whose lanes report no finding finalizes without
 *      the inventory critic (signed criticSkip, core/review-inventory-critic-
 *      skip.ts); a delta round with any finding runs it as before.
 *   4. Large repair fallback: the round is a full round when the repair
 *      changes more than DELTA_ROUND_LIMITS.repairShareOfStoryMax (50%) of the
 *      changed lines of the Story diff at the previous candidate (base ..
 *      cutoff head, added + deleted, material paths), touches a material file
 *      outside that Story diff, deletes a file, or the Story diff is empty or
 *      unreadable.
 *   5. No round cap and no severity decay: every verified finding still blocks
 *      until it is closed, exactly as with the switch off.
 *
 * The roster narrowing goes through the one roster chokepoint
 * (handlers/reviewer-list.ts computeFinalReviewRoster, a signed
 * PostRemediationReviewSelection with selection 'delta-round'), so the REVIEW
 * gate, the epoch requiredLanes, reviewer_batch and readiness all see the same
 * lanes. The plan depends only on facts that are stable within the round
 * (previous round's receipt and findings, the repair diff, recorded gaps), so
 * the roster does not move while the round runs.
 *
 * Lab lean (`review.deltaRounds=confirm`, implied by `pipeline.lean=on`; old-PoS runs 53-56: the raiser lane told
 * to re-review the WHOLE Story kept finding new test gaps for six rounds, run53-56-delta-ab-analysis.md §0 item 3):
 *   - NO lane re-reviews the whole Story: every active lane (the raiser too) is replaced by the ONE confirmation
 *     session (only a forced lane stays full); the framework still re-runs each resolved finding's test
 *     (`[reverified]`), and a clean round still skips the critic.
 *   - Escalation: a finding the confirmation session reports whose cited locations (file:line in its desc, else
 *     its files) all lie outside the delta scope (deltaEscalations) is recorded (DELTA_ROUND_ESCALATION_EVENT); the
 *     next round is then a FULL round (PREVIOUS_ESCALATION; under review.laneMerge a merged full round), because a
 *     defect outside the repair says the whole Story needs another full look. No round cap.
 *   - Composition with review.laneMerge (handlers/reviewer-list.ts): an eligible delta round runs the one
 *     confirmation session; any other round is a (merged) full round.
 *
 * Relation to `review.roundDelta=pack` (A4, core/review-lane-pack.ts): A4 only
 * adds the delta to a prompt pack and keeps every lane reviewing the whole
 * Story (no lane or critic is saved). Both can be on: the full lanes of a delta
 * round then also get the A4 pack; the A/B should vary one at a time.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { abVariantEvidence, deltaRoundsMode, deltaRoundsOn, resolveAbVariants, type AbVariantEvidence } from './ab-variants.js';
import { canonicalAgentRoleId } from './agent-role-identity.js';
import { loadConfig } from './config.js';
import { isMaterialExcludedPath } from './material-path-policy.js';
import { LANE_MERGE_COVERAGE_EVENT } from './review-lane-merge.js';
import { isCodeReviewLaneRun, isEarlierReviewRound } from './review-round-order.js';
import type { StoryStore } from './store.js';
import type { Finding, ReviewInventoryEpoch, ReviewInventoryReceipt, ReviewRun } from './types.js';
import { isFileStateSettled } from './file-state-conflict.js';

export const DELTA_ROUND_SCHEMA = 'proof-or-stop.review-delta-round.v1' as const;
export const DELTA_ROUND_GAP_EVENT = 'delta_round_confirmation_gap' as const;
export const DELTA_ROUND_REVERIFIED_EVENT = 'delta_round_reverified' as const;
/** Lab lean (review.deltaRounds=confirm): a confirmation finding outside the delta scope; the next round is a full round. */
export const DELTA_ROUND_ESCALATION_EVENT = 'delta_round_escalated' as const;
export const DELTA_ROUND_CRITIC_SKIP_REASON =
  'A/B review.deltaRounds=on: delta round with no finding reported by any required lane; completeness critic not run';

export const DELTA_ROUND_LIMITS = {
  /** A repair changing more than this share of the Story diff's changed lines is a full round. */
  repairShareOfStoryMax: 0.5,
  /** Lab lean escalation: a cited line within this many lines of a scope region counts as inside the delta. */
  escalationLineSlack: 3,
  maxScopeFiles: 20,
  maxRegionsPerKind: 12,
  findingTextChars: 240,
} as const;

export type DeltaRoundReason =
  | 'DELTA_ROUND'
  | 'DELTA_ROUNDS_OFF'
  | 'NO_CURRENT_ROUND'
  | 'NO_PREVIOUS_ROUND'
  | 'NO_REMEDIATION'
  | 'RECEIPT_INVALID'
  | 'CUTOFF_NOT_ANCESTOR'
  | 'BASE_UNAVAILABLE'
  | 'REPAIR_DIFF_UNAVAILABLE'
  | 'STORY_DIFF_EMPTY'
  | 'REPAIR_TOUCHES_NEW_FILES'
  | 'REPAIR_DELETES_FILES'
  | 'REPAIR_DIFF_LARGE'
  | 'CONFIRMATION_GAP'
  | 'PREVIOUS_CONFIRMATION_GAP'
  | 'PREVIOUS_ESCALATION'
  | 'NO_REPLACEABLE_LANE';

export interface DeltaScopeRegion {
  kind: 'hunk' | 'enclosing' | 'caller' | 'callee';
  name?: string;
  startLine: number;
  endLine: number;
}

export interface DeltaScopeFile {
  path: string;
  regions: DeltaScopeRegion[];
}

export interface DeltaRoundFindingRow {
  id: string;
  severity: string;
  status: string;
  desc: string;
  lane: string | null;
  resolution: string | null;
}

export interface DeltaRoundPlan {
  schema: typeof DELTA_ROUND_SCHEMA;
  storyId: string;
  eligible: boolean;
  reason: DeltaRoundReason;
  detail: string;
  reviewRound: string | null;
  previousRound: string | null;
  sourceReceiptId: string | null;
  fromHead: string | null;
  headHash: string | null;
  activeLanes: string[];
  fullLanes: string[];
  replacedLanes: string[];
  confirmationLane: string | null;
  /** Active roster order: the full lanes and the confirmation lane. */
  selectedLanes: string[];
  repair: { files: string[]; changedLines: number; storyChangedLines: number; shareMax: number } | null;
  scope: DeltaScopeFile[];
  resolvedFindings: DeltaRoundFindingRow[];
  openFindings: DeltaRoundFindingRow[];
  /** `concern:<lane>`, `file:<path>`, `finding:<id>`: one `[checked]` line each. */
  checkItems: string[];
  /** Full finding ids resolved in the previous remediation: one `[reverified]` line each. */
  reverifyFindingIds: string[];
  /** Digest of the roster-determining facts (stable within the round). */
  planDigest: string;
  abVariant?: AbVariantEvidence;
  /** The switch value: 'confirm' (lab lean) = no full lane, escalation; absent = 'on'. */
  mode?: 'on' | 'confirm';
}

/** Sealed in a managed lane run's spec (reviewBinding.deltaRound). */
export interface DeltaRoundRunBinding {
  schema: typeof DELTA_ROUND_SCHEMA;
  abVariant: AbVariantEvidence;
  role: 'confirmation' | 'full';
  reviewRound: string;
  previousRound: string;
  fromHead: string;
  planDigest: string;
  confirmationLane: string;
  replacedLanes: string[];
  fullLanes: string[];
  checkItems: string[];
  reverifyFindingIds: string[];
  /** Lab lean (confirm mode only): the arm and the delta scope the import checks a finding's location against. */
  mode?: 'confirm';
  scope?: DeltaScopeFile[];
}

export type DeltaRoundStore = Pick<StoryStore, 'readStory' | 'readReviewRuns' | 'readFindings' | 'readReviewInventoryEpochs' | 'readProcessEvents'>;

const GIT_OBJECT = /^[0-9a-f]{7,64}$/i;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const short = (lane: string): string => canonicalAgentRoleId(lane).replace(/^proof-or-stop-review-/, '');
const shortId = (storyId: string, id: string): string => id.startsWith(`${storyId}:`) ? id.slice(storyId.length + 1) : id;

/** One line per lane: what the confirmation lane checks on the delta for a replaced lane. */
export const DELTA_LANE_CONCERNS: Readonly<Record<string, string>> = {
  concept: 'concept completeness: no residue of a removed, renamed or replaced concept (names, flags, messages, comments, docs) in or around the delta',
  quality: 'code quality of the delta: edge cases and error paths of the changed code, dead code, type safety, I/O isolation, and tests that assert the right value',
  'test-coverage': 'test coverage: every behavior the delta adds or changes has a focused test that fails without it; no promised behavior is left untested',
  behavior: 'functional correctness: every userSees outcome and edge case of the checklist stays true with the delta',
  docs: 'documentation consistency: docs that describe the changed code still match it',
};
const concernOf = (lane: string): string => DELTA_LANE_CONCERNS[short(lane)] ?? `the ${short(lane)} lane's concern as its role prompt states it`;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function gitText(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 20_000 });
  } catch {
    return null;
  }
}

/** The switch as consumed here: malformed = off (production); evidence lists every non-default switch. */
export function deltaRoundsVariant(projectRoot: string): AbVariantEvidence | undefined {
  let config: unknown;
  try { config = loadConfig(projectRoot); } catch { return undefined; }
  if (!deltaRoundsOn(config)) return undefined;
  const fallback: AbVariantEvidence = { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.deltaRounds': deltaRoundsMode(config) } };
  try {
    return abVariantEvidence(resolveAbVariants(config)) ?? fallback;
  } catch {
    return fallback;
  }
}

/** The arm of a variant record: 'confirm' only when the evidence says so. */
function deltaModeOf(abVariant: AbVariantEvidence | undefined): 'on' | 'confirm' {
  return abVariant?.flags?.['review.deltaRounds'] === 'confirm' ? 'confirm' : 'on';
}

/** Story base: the frozen integration base when recorded, else the merge-base with main/master. */
function storyBase(story: unknown, gitCwd: string, head: string): string | null {
  const frozen = (story as { integrationTarget?: { parentCommitAtCreation?: unknown } } | null)?.integrationTarget?.parentCommitAtCreation;
  if (typeof frozen === 'string' && GIT_OBJECT.test(frozen) && gitText(gitCwd, ['cat-file', '-e', `${frozen}^{commit}`]) !== null) return frozen;
  for (const branch of ['main', 'master']) {
    const base = gitText(gitCwd, ['merge-base', head, branch])?.trim();
    if (base && GIT_OBJECT.test(base)) return base;
  }
  return null;
}

/** Material numstat between two commits: path -> changed lines (added + deleted; binary = Infinity). */
function materialNumstat(gitCwd: string, projectRoot: string, from: string, to: string): Map<string, number> | null {
  const out = gitText(gitCwd, ['diff', '--numstat', '--no-renames', '-z', from, to, '--']);
  if (out === null) return null;
  const rows = new Map<string, number>();
  for (const record of out.split('\0').filter(Boolean)) {
    const [added, deleted, ...rest] = record.split('\t');
    const path = rest.join('\t');
    if (!path || isMaterialExcludedPath(path, projectRoot)) continue;
    rows.set(path, added === '-' || deleted === '-' ? Number.POSITIVE_INFINITY : Number(added) + Number(deleted));
  }
  return rows;
}

function materialStatuses(gitCwd: string, projectRoot: string, from: string, to: string): Array<{ status: string; path: string }> | null {
  const out = gitText(gitCwd, ['diff', '--name-status', '--no-renames', '-z', from, to, '--']);
  if (out === null) return null;
  const parts = out.split('\0').filter(Boolean);
  const rows: Array<{ status: string; path: string }> = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const path = parts[index + 1]!;
    if (!isMaterialExcludedPath(path, projectRoot)) rows.push({ status: parts[index]!.slice(0, 1), path });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

const DEFINITION_LINE = /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:static\s+)?(?:func|function|def|fn|class|interface|type|struct|enum|trait|impl)\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/;
const CALL = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

export interface Definition { name: string; startLine: number; endLine: number }

/** Definitions of a file (start line of each recognizable definition to the line before the next one), 1-based. */
export function definitionsOf(lines: readonly string[]): Definition[] {
  const starts: Array<{ name: string; line: number }> = [];
  lines.forEach((text, index) => {
    const match = text.match(DEFINITION_LINE);
    if (match) starts.push({ name: match[1]!, line: index + 1 });
  });
  const last = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  return starts.map((row, index) => ({ name: row.name, startLine: row.line, endLine: Math.max(row.line, (starts[index + 1]?.line ?? last + 1) - 1) }));
}

/**
 * The confirmation scope of a repair: per material file the repair modified,
 * the hunks (new-side line ranges), the definitions enclosing them, and the
 * same-file callees of those definitions and callers of them. Deterministic
 * and language-neutral (a definition-line scan: func / function / def / fn /
 * class / type ...); a file with no recognizable definition keeps its hunks.
 */
export function deltaRoundScope(gitCwd: string, projectRoot: string, fromHead: string, toHead: string): DeltaScopeFile[] {
  const statuses = materialStatuses(gitCwd, projectRoot, fromHead, toHead) ?? [];
  const files: DeltaScopeFile[] = [];
  for (const { status, path } of statuses.filter(row => row.status !== 'D').slice(0, DELTA_ROUND_LIMITS.maxScopeFiles)) {
    const diff = gitText(gitCwd, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', fromHead, toHead, '--', path]) ?? '';
    const hunks: Array<{ startLine: number; endLine: number }> = [];
    for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      hunks.push(count === 0 ? { startLine: Math.max(start, 1), endLine: Math.max(start, 1) } : { startLine: start, endLine: start + count - 1 });
    }
    if (status === 'A' && hunks.length === 0) hunks.push({ startLine: 1, endLine: 1 });
    const text = gitText(gitCwd, ['show', `${toHead}:${path}`]) ?? '';
    const lines = text.split('\n');
    const defs = definitionsOf(lines);
    const regions: DeltaScopeRegion[] = hunks.slice(0, DELTA_ROUND_LIMITS.maxRegionsPerKind).map(row => ({ kind: 'hunk', ...row }));
    const enclosing = defs.filter(def => hunks.some(hunk => def.startLine <= hunk.endLine && hunk.startLine <= def.endLine));
    const touched = new Set(enclosing.map(def => def.name));
    const add = (kind: DeltaScopeRegion['kind'], def: Definition) => {
      if (regions.filter(row => row.kind === kind).length >= DELTA_ROUND_LIMITS.maxRegionsPerKind) return;
      if (regions.some(row => row.kind === kind && row.name === def.name)) return;
      regions.push({ kind, name: def.name, startLine: def.startLine, endLine: def.endLine });
    };
    for (const def of enclosing) add('enclosing', def);
    const byName = new Map(defs.map(def => [def.name, def] as const));
    for (const def of enclosing) {
      const body = lines.slice(def.startLine, def.endLine).join('\n');
      for (const match of body.matchAll(CALL)) {
        const callee = byName.get(match[1]!);
        if (callee && !touched.has(callee.name)) add('callee', callee);
      }
    }
    if (touched.size > 0) {
      const pattern = new RegExp(`\\b(?:${[...touched].join('|')})\\b`);
      for (const def of defs) {
        if (touched.has(def.name)) continue;
        const body = lines.slice(def.startLine - 1, def.endLine).join('\n').replace(DEFINITION_LINE, '');
        if (pattern.test(body)) add('caller', def);
      }
    }
    files.push({ path, regions });
  }
  return files;
}

function findingRow(finding: Finding): DeltaRoundFindingRow {
  return {
    id: finding.id,
    severity: finding.severity,
    status: finding.status,
    desc: oneLine(finding.desc ?? '', DELTA_ROUND_LIMITS.findingTextChars),
    lane: finding.agent ? short(finding.agent) : null,
    resolution: finding.resolvedReason ? oneLine(finding.resolvedReason, DELTA_ROUND_LIMITS.findingTextChars) : null,
  };
}

/** A critic `duplicate` disposition (latest per finding) or a duplicate resolution: not a finding of its own lane. */
function isDuplicateFinding(epochs: { criticReceipts?: Array<{ findingDispositions?: Array<{ findingId: string; disposition: string; canonicalFindingId?: string }> }> }, finding: Finding): boolean {
  if (finding.resolutionType === 'duplicate') return true;
  const rows = (epochs.criticReceipts ?? []).flatMap(receipt => receipt.findingDispositions ?? []).filter(row => row.findingId === finding.id);
  const latest = rows.at(-1);
  return Boolean(latest && latest.disposition === 'duplicate' && latest.canonicalFindingId && latest.canonicalFindingId !== finding.id);
}

/** A resolution that repaired nothing (old-PoS run 52): pre-existing outside the Story, an accepted risk, or a duplicate. */
function closedWithoutRepair(finding: Finding): boolean {
  return finding.status === 'resolved' && (finding.resolutionType === 'preexisting_out_of_scope'
    || finding.resolutionType === 'accepted_risk' || finding.resolutionType === 'duplicate' || isFileStateSettled(finding));
}

/** The canonical a duplicate was closed against: the closure record's `[duplicate of <id>`, else the critic's latest disposition. */
function duplicateCanonicalOf(epochs: Parameters<typeof isDuplicateFinding>[0], finding: Finding): string | null {
  const recorded = (finding.resolvedReason ?? '').match(/\[duplicate of (\S+?)(?=[\s;(\]]|$)/)?.[1];
  if (recorded) return recorded;
  const rows = (epochs.criticReceipts ?? []).flatMap(receipt => receipt.findingDispositions ?? []).filter(row => row.findingId === finding.id);
  const latest = rows.at(-1);
  return latest?.disposition === 'duplicate' && latest.canonicalFindingId ? latest.canonicalFindingId : null;
}

/**
 * The findings resolved since the remediation receipt was consumed that the
 * confirmation lane re-verifies and the framework re-runs. Never a
 * pre-existing or accepted-risk closure (nothing was repaired). Old-PoS run 52
 * (D2): a duplicate is re-verified through its canonical, never by an
 * unrelated owner-chosen coverage command: it is skipped when its canonical
 * (followed to the root of a duplicate chain) is itself re-run in this round
 * or was closed without a repair; otherwise its own closure is re-run as
 * before.
 */
export function resolvedFindingsToReverify(findings: readonly Finding[], boundary: string,
  epochs: Parameters<typeof isDuplicateFinding>[0] = {}): Finding[] {
  const nonRepair = (finding: Finding) => finding.resolutionType === 'preexisting_out_of_scope' || finding.resolutionType === 'accepted_risk' || isFileStateSettled(finding);
  const candidates = findings.filter(finding => finding.status === 'resolved' && (finding.resolvedAt ?? '') >= boundary && !nonRepair(finding));
  const rerun = new Set(candidates.filter(finding => finding.resolutionType !== 'duplicate').map(finding => finding.id));
  const byId = new Map(findings.map(finding => [finding.id, finding] as const));
  const coveredByCanonical = (finding: Finding): boolean => {
    const seen = new Set<string>([finding.id]);
    let current: Finding | undefined = finding;
    for (let depth = 0; current && current.resolutionType === 'duplicate' && depth < 16; depth += 1) {
      const canonicalId = duplicateCanonicalOf(epochs, current);
      if (!canonicalId || seen.has(canonicalId)) return false;
      seen.add(canonicalId);
      if (rerun.has(canonicalId)) return true;
      current = byId.get(canonicalId);
      if (current && current.status === 'resolved' && nonRepair(current)) return true;
    }
    return false;
  };
  return candidates.filter(finding => finding.resolutionType !== 'duplicate' || !coveredByCanonical(finding))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The delta-round plan of the Story's current REVIEW round. Ineligible plans
 * name the reason (the round is then a full round, as with the switch off).
 * `verifyReceipt` authenticates the source receipt and its epoch (production
 * callers pass the inventory signature checks); absent = trusted (unit tests).
 */
export function computeDeltaRoundPlan(args: {
  store: DeltaRoundStore;
  projectRoot: string;
  gitCwd: string;
  storyId: string;
  /** Canonical lane ids, active roster order. */
  activeLanes: readonly string[];
  forcedLanes?: readonly string[];
  verifyReceipt?: (receipt: ReviewInventoryReceipt, epoch: ReviewInventoryEpoch | undefined) => boolean;
}): DeltaRoundPlan {
  const { store, projectRoot, gitCwd, storyId } = args;
  const activeLanes = args.activeLanes.map(lane => canonicalAgentRoleId(lane));
  const abVariant = deltaRoundsVariant(projectRoot);
  const mode = abVariant ? deltaModeOf(abVariant) : undefined;
  let story: { currentReviewRound?: string } = {};
  try { story = store.readStory(storyId) as { currentReviewRound?: string }; } catch { story = {}; }
  const reviewRound = story.currentReviewRound ?? null;
  const plan: DeltaRoundPlan = {
    schema: DELTA_ROUND_SCHEMA, storyId, eligible: false, reason: 'DELTA_ROUNDS_OFF', detail: 'review.deltaRounds is off',
    reviewRound, previousRound: null, sourceReceiptId: null, fromHead: null, headHash: null,
    activeLanes, fullLanes: [], replacedLanes: [], confirmationLane: null, selectedLanes: [...activeLanes],
    repair: null, scope: [], resolvedFindings: [], openFindings: [], checkItems: [], reverifyFindingIds: [], planDigest: '',
    ...(abVariant ? { abVariant } : {}),
    ...(mode === 'confirm' ? { mode } : {}),
  };
  const fallback = (reason: DeltaRoundReason, detail: string): DeltaRoundPlan => {
    const out: DeltaRoundPlan = { ...plan, eligible: false, reason, detail, fullLanes: [], replacedLanes: [], confirmationLane: null, selectedLanes: [...activeLanes] };
    return { ...out, planDigest: digestPlan(out) };
  };
  if (!abVariant) return fallback('DELTA_ROUNDS_OFF', 'review.deltaRounds is off (absent or malformed)');
  if (!reviewRound) return fallback('NO_CURRENT_ROUND', 'REVIEW has no current round');
  let runs: ReviewRun[] = [];
  try { runs = store.readReviewRuns(storyId).runs; } catch { runs = []; }
  const earlier = runs.filter(run => isCodeReviewLaneRun(run) && run.reviewRound !== reviewRound && isEarlierReviewRound(run.reviewRound, reviewRound));
  const previousRound = earlier.at(-1)?.reviewRound ?? null;
  plan.previousRound = previousRound;
  if (!previousRound) return fallback('NO_PREVIOUS_ROUND', 'no earlier review round ran code-review lanes');
  const inventory = store.readReviewInventoryEpochs(storyId) as unknown as { epochs: ReviewInventoryEpoch[]; receipts: ReviewInventoryReceipt[];
    criticReceipts?: Array<{ findingDispositions?: Array<{ findingId: string; disposition: string; canonicalFindingId?: string }> }> };
  const receipt = (inventory.receipts ?? []).filter(row => row.reviewRound === previousRound && row.authority === 'review-remediation-only' && row.consumedAt && !row.invalidatedAt).at(-1);
  if (!receipt) return fallback('NO_REMEDIATION', `round ${previousRound} did not end in a consumed remediation receipt`);
  plan.sourceReceiptId = receipt.receiptId;
  const epoch = (inventory.epochs ?? []).find(row => row.epochId === receipt.epochId);
  if (args.verifyReceipt && !args.verifyReceipt(receipt, epoch)) return fallback('RECEIPT_INVALID', `receipt ${receipt.receiptId} or its epoch does not verify`);
  const fromHead = receipt.cutoff?.headHash ?? '';
  plan.fromHead = fromHead || null;
  const head = gitText(gitCwd, ['rev-parse', 'HEAD'])?.trim() ?? '';
  plan.headHash = head || null;
  if (!GIT_OBJECT.test(fromHead) || !GIT_OBJECT.test(head) || gitText(gitCwd, ['merge-base', '--is-ancestor', fromHead, head]) === null) {
    return fallback('CUTOFF_NOT_ANCESTOR', `previous candidate ${fromHead || '?'} is not an ancestor of HEAD`);
  }
  const base = storyBase(story, gitCwd, fromHead);
  if (!base) return fallback('BASE_UNAVAILABLE', 'the Story base is unavailable');
  const storyStat = materialNumstat(gitCwd, projectRoot, base, fromHead);
  const repairStat = materialNumstat(gitCwd, projectRoot, fromHead, head);
  const repairStatus = materialStatuses(gitCwd, projectRoot, fromHead, head);
  if (!storyStat || !repairStat || !repairStatus) return fallback('REPAIR_DIFF_UNAVAILABLE', 'git diff of the Story or the repair failed');
  const storyLines = [...storyStat.values()].reduce((sum, value) => sum + value, 0);
  const repairLines = [...repairStat.values()].reduce((sum, value) => sum + value, 0);
  const repairFiles = repairStatus.map(row => row.path);
  plan.repair = { files: repairFiles, changedLines: repairLines, storyChangedLines: storyLines, shareMax: DELTA_ROUND_LIMITS.repairShareOfStoryMax };
  if (storyLines === 0) return fallback('STORY_DIFF_EMPTY', 'the Story diff at the previous candidate changes no material line');
  const deleted = repairStatus.filter(row => row.status === 'D').map(row => row.path);
  if (deleted.length) return fallback('REPAIR_DELETES_FILES', `the repair deletes ${deleted.join(', ')}`);
  const outside = repairFiles.filter(path => !storyStat.has(path));
  if (outside.length) return fallback('REPAIR_TOUCHES_NEW_FILES', `the repair touches ${outside.join(', ')}, outside the previous material (the Story diff at ${fromHead.slice(0, 12)})`);
  if (repairLines > storyLines * DELTA_ROUND_LIMITS.repairShareOfStoryMax) {
    return fallback('REPAIR_DIFF_LARGE', `the repair has ${Number.isFinite(repairLines) ? repairLines : 'binary'} changed line(s) against ${storyLines} in the Story diff: more than the ${Math.round(DELTA_ROUND_LIMITS.repairShareOfStoryMax * 100)}% limit`);
  }
  let events: Array<{ type: string; reviewRound?: unknown; conclusion?: unknown }> = [];
  try { events = store.readProcessEvents(storyId) as Array<{ type: string; reviewRound?: unknown; conclusion?: unknown }>; } catch { events = []; }
  const gaps = events.filter(event => event.type === DELTA_ROUND_GAP_EVENT);
  // Old-PoS run 52 (D1): a findings verdict's gap launches no late lane in its own round.
  if (gaps.some(event => event.reviewRound === reviewRound && event.conclusion !== 'findings')) {
    return fallback('CONFIRMATION_GAP', `a confirmation lane of round ${reviewRound} left a gap; the round is a full round`);
  }
  if (gaps.some(event => event.reviewRound === previousRound && event.conclusion === 'findings')) {
    return fallback('PREVIOUS_CONFIRMATION_GAP', `the confirmation lane of round ${previousRound} reported findings but left part of its delta unchecked; this round is a full round`);
  }
  // Lab lean (confirm): a finding outside the delta in the previous round's confirmation escalates this round to a full round.
  if (events.some(event => event.type === DELTA_ROUND_ESCALATION_EVENT && event.reviewRound === previousRound)) {
    return fallback('PREVIOUS_ESCALATION', `the confirmation session of round ${previousRound} reported a defect outside its repair delta; this round is a full review of the whole Story`);
  }
  let findings: Finding[] = [];
  try { findings = store.readFindings(storyId).findings ?? []; } catch { findings = []; }
  const raised = new Set(findings
    .filter(finding => finding.reviewRound === previousRound && finding.agent && activeLanes.includes(canonicalAgentRoleId(finding.agent))
      && finding.status !== 'dismissed' && finding.evidenceState !== 'disproven' && !isDuplicateFinding(inventory, finding)
      && !closedWithoutRepair(finding))
    .map(finding => canonicalAgentRoleId(finding.agent!)));
  const forced = new Set((args.forcedLanes ?? []).map(lane => canonicalAgentRoleId(lane)));
  // Lab lean (confirm): a dimension the previous round's merged FINDINGS verdict left uncovered (review.laneMerge) was
  // never reviewed: it runs in full now, as the lane-merge plan would have run it on its own.
  if (mode === 'confirm') {
    for (const event of (events as Array<{ type: string; reviewRound?: unknown; conclusion?: unknown; missingLanes?: unknown }>)
      .filter(row => row.type === LANE_MERGE_COVERAGE_EVENT && row.reviewRound === previousRound && row.conclusion === 'findings')) {
      for (const lane of Array.isArray(event.missingLanes) ? event.missingLanes : []) if (typeof lane === 'string') forced.add(canonicalAgentRoleId(lane));
    }
  }
  // Lab lean (confirm): no lane re-reviews the whole Story for having raised a finding (runs 53-56); only a forced lane stays full.
  const fullLanes = activeLanes.filter(lane => (mode !== 'confirm' && raised.has(lane)) || forced.has(lane));
  const replacedLanes = activeLanes.filter(lane => !fullLanes.includes(lane));
  if (replacedLanes.length === 0) return fallback('NO_REPLACEABLE_LANE', 'every active lane raised findings in the previous round (or is forced)');
  const confirmationLane = replacedLanes[0]!;
  const boundary = receipt.consumedAt ?? receipt.issuedAt ?? '';
  const resolved = resolvedFindingsToReverify(findings, boundary, inventory);
  const open = findings.filter(finding => finding.status === 'open').sort((a, b) => a.id.localeCompare(b.id));
  const scope = deltaRoundScope(gitCwd, projectRoot, fromHead, head);
  const out: DeltaRoundPlan = {
    ...plan,
    eligible: true,
    reason: 'DELTA_ROUND',
    detail: `repair ${fromHead.slice(0, 12)}..${head.slice(0, 12)}: ${repairFiles.length} file(s), ${repairLines} of ${storyLines} Story-diff line(s); full: ${fullLanes.map(short).join(', ') || 'none'}; confirmation: ${short(confirmationLane)} for ${replacedLanes.map(short).join(', ')}${mode === 'confirm' ? ' (review.deltaRounds=confirm)' : ''}`,
    fullLanes,
    replacedLanes,
    confirmationLane,
    selectedLanes: activeLanes.filter(lane => fullLanes.includes(lane) || lane === confirmationLane),
    scope,
    resolvedFindings: resolved.map(findingRow),
    openFindings: open.map(findingRow),
    checkItems: [
      ...replacedLanes.map(lane => `concern:${short(lane)}`),
      ...scope.map(file => `file:${file.path}`),
      ...open.map(finding => `finding:${shortId(storyId, finding.id)}`),
    ],
    reverifyFindingIds: resolved.map(finding => finding.id),
  };
  return { ...out, planDigest: digestPlan(out) };
}

/** Digest of the facts that decide the roster (never live finding status or HEAD). */
function digestPlan(plan: DeltaRoundPlan): string {
  return sha256(JSON.stringify({
    schema: plan.schema, storyId: plan.storyId, eligible: plan.eligible, reason: plan.reason, reviewRound: plan.reviewRound,
    previousRound: plan.previousRound, sourceReceiptId: plan.sourceReceiptId, fromHead: plan.fromHead,
    activeLanes: plan.activeLanes, fullLanes: plan.fullLanes, replacedLanes: plan.replacedLanes, confirmationLane: plan.confirmationLane,
    repairFiles: plan.repair?.files ?? null, repairLines: plan.repair?.changedLines ?? null, storyLines: plan.repair?.storyChangedLines ?? null,
    // Lab lean: the confirm arm binds its mode (the 'on' digest is unchanged).
    ...(plan.mode === 'confirm' ? { mode: plan.mode } : {}),
  }));
}

/** The stable roster basis an inventory epoch binds for a delta round (handlers/reviewer-list.ts finalReviewRosterBasis). */
export function deltaRoundRosterBasis(plan: DeltaRoundPlan, policyVersion: string): string {
  return JSON.stringify({ policyVersion, kind: 'delta-round', sourceReceiptId: plan.sourceReceiptId, activeLanes: plan.activeLanes, selectedLanes: plan.selectedLanes, planDigest: plan.planDigest });
}

/** True when an epoch's roster basis is a delta round's (the critic skip applies only there). */
export function isDeltaRoundRosterBasis(basis: string | undefined): boolean {
  if (!basis) return false;
  try { return (JSON.parse(basis) as { kind?: unknown }).kind === 'delta-round'; } catch { return false; }
}

export function deltaRoundBinding(plan: DeltaRoundPlan, role: 'confirmation' | 'full'): DeltaRoundRunBinding {
  if (!plan.eligible || !plan.abVariant || !plan.reviewRound || !plan.previousRound || !plan.fromHead || !plan.confirmationLane) {
    throw new Error(`deltaRoundBinding: plan is not an eligible delta round (${plan.reason})`);
  }
  return {
    schema: DELTA_ROUND_SCHEMA, abVariant: plan.abVariant, role, reviewRound: plan.reviewRound, previousRound: plan.previousRound,
    fromHead: plan.fromHead, planDigest: plan.planDigest, confirmationLane: plan.confirmationLane, replacedLanes: plan.replacedLanes,
    fullLanes: plan.fullLanes, checkItems: role === 'confirmation' ? plan.checkItems : [], reverifyFindingIds: role === 'confirmation' ? plan.reverifyFindingIds : [],
    ...(plan.mode === 'confirm' ? { mode: 'confirm' as const, ...(role === 'confirmation' ? { scope: plan.scope } : {}) } : {}),
  };
}

/** The role of a lane in an eligible plan, or null (not part of this delta round). */
export function deltaRoundRole(plan: DeltaRoundPlan | null | undefined, lane: string, reviewRound: string): 'confirmation' | 'full' | null {
  if (!plan?.eligible || plan.reviewRound !== reviewRound) return null;
  const id = canonicalAgentRoleId(lane);
  if (id === plan.confirmationLane) return 'confirmation';
  return plan.fullLanes.includes(id) ? 'full' : null;
}

function renderRegion(region: DeltaScopeRegion): string {
  const range = region.startLine === region.endLine ? `line ${region.startLine}` : `lines ${region.startLine}-${region.endLine}`;
  switch (region.kind) {
    case 'hunk': return `changed ${range}`;
    case 'enclosing': return `${region.name} (enclosing the change, ${range})`;
    case 'caller': return `${region.name} (calls it, same file, ${range})`;
    case 'callee': return `${region.name} (called by it, same file, ${range})`;
  }
}

/**
 * The confirmation lane's sealed prompt block (replaces the ordinary re-review
 * block). `diffLines` is the repair diff text (bounded by the caller).
 */
export function renderDeltaConfirmationBlock(plan: DeltaRoundPlan, storyId: string, diffLines: readonly string[] = []): string[] {
  const full = plan.fullLanes.map(short);
  const confirm = plan.mode === 'confirm';
  return [
    `--- BEGIN DELTA ROUND CONFIRMATION (A/B review.deltaRounds=${confirm ? 'confirm' : 'on'}, experimental; round ${plan.reviewRound}) ---`,
    `This review round is a DELTA round: the previous round (${plan.previousRound}) ended in a remediation, and the candidate changed from ${plan.fromHead} to ${plan.headHash} (${plan.repair?.files.length ?? 0} material file(s), ${plan.repair?.changedLines ?? 0} changed line(s); the Story diff had ${plan.repair?.storyChangedLines ?? 0}).`,
    full.length
      ? `The lane(s) that raised findings last round (${full.join(', ')}) re-review the WHOLE Story in parallel with you.`
      : 'No lane re-reviews the whole Story in this round.',
    `You are the ONE confirmation lane of this round: you replace the lanes ${plan.replacedLanes.map(short).join(', ')} and review ONLY the delta scope below, for ALL of their concerns (your own role prompt above states one of them). Do not review code outside the scope; a defect you notice outside it is still reported as a finding.`,
    ...(confirm ? ['Escalation (review.deltaRounds=confirm): a defect you notice outside the delta scope is still reported as a finding citing its file:line; the framework then escalates and the next round is a full review of the whole Story. Do not widen this session to look for one.'] : []),
    'Check items (one [checked] line each):',
    ...plan.replacedLanes.map(lane => `- concern:${short(lane)} — ${concernOf(lane)}`),
    ...plan.scope.flatMap(file => [
      `- file:${file.path} — read the changed lines and the related definitions below (it must be in your read manifest)`,
      ...file.regions.map(region => `  - ${renderRegion(region)}`),
    ]),
    ...plan.openFindings.map(row => `- finding:${shortId(storyId, row.id)} — still open [severity=${row.severity}${row.lane ? `, lane=${row.lane}` : ''}]: state whether it is still present, with evidence: ${row.desc}`),
    'Resolved findings to re-verify (one [reverified] line each; status is not evidence: run the test or probe yourself):',
    ...(plan.resolvedFindings.length ? plan.resolvedFindings.map(row =>
      `- ${shortId(storyId, row.id)} [severity=${row.severity}${row.lane ? `, lane=${row.lane}` : ''}] ${row.desc}${row.resolution ? ` (resolution: ${row.resolution})` : ''}`) : ['  (none)']),
    '',
    'Never pass what you did not check. Your final note MUST contain one line per item, exactly in these forms:',
    '  [checked] <item> :: <what you read or ran and what it showed>      for every concern:, file: and finding: item above',
    '  [reverified] <finding id> :: <exact command> :: <exact output line that shows its case passes>      for every resolved finding above',
    '  [gap] <item> :: <why it was not checked>      for anything you could not check',
    'The framework re-runs every [reverified] command in the Story worktree (one executable with its arguments, no shell operators, e.g. `go test -v ./pkg -run TestX`) and requires exit 0 and that output line. A pass with any [gap] line, an item without its line, a file: item missing from your read manifest, or a re-run that fails is NOT a pass: the framework refuses it and this round falls back to a full review by every lane. Report every defect you find as a finding, as usual.',
    'Instructions:',
    '1. First re-verify each resolved finding by running its test or probe, then state whether each still-open finding is still present.',
    '2. Then review the changed lines and their enclosing, calling and called definitions for every concern listed above; apply variant analysis to each problem within the scope (one finding naming every location).',
    '3. Report every blocking problem in this one pass.',
    `Repair since the previous round: git diff ${plan.fromHead}..${plan.headHash}, material paths only.`,
    ...diffLines,
    '--- END DELTA ROUND CONFIRMATION ---',
  ];
}

const NOTE_MARKER = /\[(?:checked|reverified|gap)\]/g;
const NOTE_SEGMENT = /^\[(checked|reverified|gap)\]\s+(\S+)(?:\s*::\s*([\s\S]*)|\s[\s\S]*)?$/;
const GENERIC_SELECTOR = /^(?:ok|pass(?:ed)?|--- ?pass:?|pass:?|success|done|\d+ passing)$/i;

/** An item token as a reviewer writes it: `quoted`, *bold*, or followed by a colon / full stop. */
const cleanNoteItem = (item: string): string => item.replace(/^[`'"*(]+/, '').replace(/[`'"*),;:.]+$/, '');
/** A selector as written in prose: no trailing full stop, no Go test timing (`(0.01s)` differs on every run). */
const cleanSelector = (selector: string): string => selector.trim().replace(/[.;,]+$/, '').replace(/\s*\(\d+(?:\.\d+)?m?s\)$/, '').trim();

/**
 * Every `[checked]` / `[reverified]` / `[gap]` segment of a note. Old-PoS run 52
 * (RR-012): a lane flattened its whole note onto one line, so a marker counts
 * wherever it stands; a segment runs to the next marker or the end of its line.
 */
function noteSegments(note: string): Array<{ kind: 'checked' | 'reverified' | 'gap'; item: string; rest: string | undefined }> {
  const out: Array<{ kind: 'checked' | 'reverified' | 'gap'; item: string; rest: string | undefined }> = [];
  for (const line of note.split('\n')) {
    const starts = [...line.matchAll(NOTE_MARKER)].map(match => match.index ?? 0);
    starts.forEach((start, index) => {
      const segment = line.slice(start, starts[index + 1] ?? line.length).trim();
      const match = segment.match(NOTE_SEGMENT);
      if (!match) return;
      out.push({ kind: match[1] as 'checked' | 'reverified' | 'gap', item: cleanNoteItem(match[2]!), rest: match[3]?.trim() });
    });
  }
  return out;
}

/**
 * The deterministic half of the confirmation contract (no command runs here):
 * missing check items, reported gaps, and problems (a resolved finding with no
 * or a malformed [reverified] line, a generic selector, a file: item absent from
 * the read manifest). `reverify` lists the commands the framework must re-run.
 */
export function checkDeltaConfirmationNote(args: {
  binding: Pick<DeltaRoundRunBinding, 'checkItems' | 'reverifyFindingIds'>;
  storyId: string;
  note: string;
  readManifest?: { filesReadFully?: readonly string[]; filesTriagedByName?: readonly string[] } | null;
}): { missing: string[]; gaps: string[]; problems: string[]; reverify: Array<{ findingId: string; command: string; selector: string }> } {
  const { binding, storyId } = args;
  const checked = new Set<string>();
  const gaps: string[] = [];
  const reverified = new Map<string, string>();
  const normalizeItem = (item: string): string => {
    const finding = item.match(/^finding:(.+)$/);
    return finding ? `finding:${shortId(storyId, finding[1]!)}` : item;
  };
  const fullId = (item: string): string => item.startsWith(`${storyId}:`) ? item : `${storyId}:${item}`;
  // Old-PoS run 52 (RR-012): a [gap] counts only when it names something this lane must check (a check item,
  // bare or prefixed, or a resolved finding); a gap on another file (a stock-prompt path that does not exist) does not.
  const isOwnItem = (item: string): boolean => {
    const normalized = normalizeItem(item);
    return binding.checkItems.includes(normalized) || binding.checkItems.includes(`file:${item}`) || binding.checkItems.includes(`concern:${item}`)
      || binding.checkItems.includes(`finding:${shortId(storyId, item)}`) || binding.reverifyFindingIds.includes(fullId(item));
  };
  for (const { kind, item, rest } of noteSegments(args.note ?? '')) {
    if (kind === 'checked') checked.add(normalizeItem(item));
    else if (kind === 'gap') { if (isOwnItem(item)) gaps.push(`${item}${rest ? ` :: ${rest}` : ''}`); }
    else reverified.set(fullId(item), rest ?? '');
  }
  const missing = binding.checkItems.filter(item => !checked.has(item));
  const problems: string[] = [];
  const read = new Set([...(args.readManifest?.filesReadFully ?? []), ...(args.readManifest?.filesTriagedByName ?? [])]);
  for (const item of binding.checkItems) {
    if (!item.startsWith('file:') || !checked.has(item)) continue;
    const path = item.slice('file:'.length);
    if (!read.has(path)) problems.push(`${item}: [checked] but ${path} is not in the read manifest`);
  }
  const reverify: Array<{ findingId: string; command: string; selector: string }> = [];
  for (const findingId of binding.reverifyFindingIds) {
    const rest = reverified.get(findingId);
    if (rest === undefined) { problems.push(`${shortId(storyId, findingId)}: no [reverified] line (a resolved finding is re-verified by re-running its test)`); continue; }
    const parts = rest.split('::').map(part => part.trim());
    const command = parts[0] ?? '';
    const selector = cleanSelector(parts.slice(1).join('::'));
    if (!command || !selector) { problems.push(`${shortId(storyId, findingId)}: [reverified] needs ":: <command> :: <output line>"`); continue; }
    if (selector.length < 6 || GENERIC_SELECTOR.test(selector)) { problems.push(`${shortId(storyId, findingId)}: selector "${selector}" is generic; name the test or the output line that shows the case passes`); continue; }
    reverify.push({ findingId, command, selector });
  }
  return { missing, gaps, problems, reverify };
}

/** One cited location of a finding: `path:line` (or `path:start-end`) in its desc, or a declared file with no line. */
export interface FindingCitation { path: string; startLine: number | null; endLine: number | null }

const CITED_LINE = /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8})(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)/g;
const samePath = (a: string, b: string): boolean => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/** The locations a finding cites: every `path:line` in its desc, plus each declared file its desc cites no line of. */
export function findingCitations(finding: { desc?: string | null; files?: readonly string[] | null }): FindingCitation[] {
  const out: FindingCitation[] = [];
  for (const match of String(finding.desc ?? '').matchAll(CITED_LINE)) {
    const path = match[1]!.replace(/^\.\//, '');
    const start = Number(match[2] ?? match[4]);
    const end = Number(match[3] ?? match[5] ?? start);
    if (Number.isFinite(start) && start > 0) out.push({ path, startLine: start, endLine: Number.isFinite(end) && end >= start ? end : start });
  }
  for (const path of finding.files ?? []) {
    const clean = String(path).replace(/^\.\//, '');
    if (clean && !out.some(row => samePath(row.path, clean))) out.push({ path: clean, startLine: null, endLine: null });
  }
  return out;
}

const citationText = (row: FindingCitation): string => row.startLine === null ? row.path : `${row.path}:${row.startLine}${row.endLine !== null && row.endLine !== row.startLine ? `-${row.endLine}` : ''}`;

/**
 * Lab lean (review.deltaRounds=confirm): which findings of a confirmation session lie OUTSIDE the delta scope. A
 * finding is inside when at least one of its cited locations is: a cited line within a scope region of the same
 * file (+- DELTA_ROUND_LIMITS.escalationLineSlack), or a cited file of the scope with no line. A finding citing no
 * location cannot be placed and counts as outside (fail closed: a full round next). Deterministic, no git.
 */
export function deltaEscalations(scope: readonly DeltaScopeFile[], findings: ReadonlyArray<{ desc?: string | null; files?: readonly string[] | null }>):
  Array<{ index: number; citations: string[]; reason: string }> {
  const slack = DELTA_ROUND_LIMITS.escalationLineSlack;
  const inside = (row: FindingCitation): boolean => scope.some(file => samePath(file.path, row.path) && (row.startLine === null
    || file.regions.some(region => row.startLine! <= region.endLine + slack && (row.endLine ?? row.startLine!) >= region.startLine - slack)));
  const out: Array<{ index: number; citations: string[]; reason: string }> = [];
  findings.forEach((finding, index) => {
    const cited = findingCitations(finding);
    if (cited.some(inside)) return;
    const citations = cited.map(citationText);
    out.push({ index, citations, reason: citations.length
      ? `cites ${citations.join(', ')}, outside the delta scope (${scope.map(file => file.path).join(', ') || 'empty'})`
      : 'cites no file or line, so it cannot be placed inside the delta scope' });
  });
  return out;
}
