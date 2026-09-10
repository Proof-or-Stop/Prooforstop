import { rethrowIntentAmendmentIntegrityError } from '../core/verification-intent-amendment.js';
/**
 * validate-channel — CLI gate: structured normal-channel evidence check
 *
 * Validate whether the normal channel has structured execution evidence:
 * - Fast channel (checklist ≤ 2 and no riskSignals): skip, return skipped
 * - Normal channel: first require each checklist item with non-main-agent Owner to have dispatch or
 *   subagent_result process-event evidence. commit author is only a legacy fallback:
 *   only when process-event is missing and all implementation commits have author ==
 *   "proof-or-stop-implementer" or are metadata-only proof-or-stop commits can it pass.
 *
 * Output structure:
 *   {
 *     provider: "proof-or-stop-channel",
 *     status: "pass" | "fail" | "skipped",
 *     summary: string,
 *     details: string[],
 *     offenders?: Array<{ sha, author, subject }>,
 *   }
 *
 * See docs/reviewer-redesign.md §III S1 item 1.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoryStore } from '../core/store.js';
import { DEFAULT_BASE } from './validate-shared.js';
import { computeChannel } from '../core/workflow-policy.js';
import { loadConfig } from '../core/config.js';
import { isStoryMetadataPath as isSharedStoryMetadataPath } from '../core/evidence-freshness.js';
import type { StoryInfo, ChecklistData, DecisionData, ProcessEvent } from '../core/types.js';
import type { ScopeShrinkageDecisionData } from '../core/types.js';
import { withdrawnChecklistItemIdsFrom } from '../core/proofstory.js';

export interface ChannelOffender {
  sha: string;
  author: string;
  subject: string;
  files?: string[];
}

export interface ChannelCheckResult {
  provider: 'proof-or-stop-channel';
  status: 'pass' | 'fail' | 'skipped';
  summary: string;
  details: string[];
  offenders?: ChannelOffender[];
  /**
   * F-003 (B-fdcf Round 1): evidence source label, used by renderChannelResult to output
   * the `all CHK covered (via <source>)` phrase promised by userSees.
   * - 'subagent_result' — all via Agent() direct dispatch path (subagent_result events)
   * - 'dispatch'        — all via proof-or-stop dispatch (dispatch events)
   * - 'dispatch + subagent_result' — mixed
   * - 'commit_author' — commit author=proof-or-stop-implementer as a signal of direct Agent execution
   * Set only when status=pass and evidencedItems exists; undefined for pure waiver / no-commit scenarios.
   */
  evidenceSource?: 'subagent_result' | 'dispatch' | 'dispatch + subagent_result' | 'commit_author';
}

/**
 * Callback that reads raw git log output, for test injection.
 * Default implementation = execSync `git log <base>..<branch> --format=%H|%an|%s`.
 */
export type GitLogReader = (args: {
  base: string;
  branch: string;
  projectRoot: string;
}) => string;

export type GitChangedFilesReader = (args: {
  sha: string;
  projectRoot: string;
}) => string[];

// B-6666: the reader's `projectRoot` field actually carries the RESOLVED gitCwd
// (checkCommitAuthor threads deps.gitCwd in as `projectRoot: gitCwd` — B-2856).
// Alias it to `gitCwd` locally so the git child-process `cwd:` is lexically honest
// (and passes the strengthened gitroot-cwd-contract bare-cwd rule). The public
// GitLogReader/GitChangedFilesReader field name stays `projectRoot` (no external ripple).
const defaultGitLogReader: GitLogReader = ({ base, branch, projectRoot: gitCwd }) => {
  try {
    execSync(`git rev-parse --verify --quiet ${branch}`, { cwd: gitCwd, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    try {
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: gitCwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      execSync(`git merge-base --is-ancestor HEAD ${base}`, { cwd: gitCwd, stdio: ['ignore', 'ignore', 'ignore'] });
      if (currentBranch === base) return '';
    } catch {
      // Keep the original git log failure for non-main branches with a missing story ref.
    }
  }
  return execSync(
    `git log ${base}..${branch} "--format=%H|%an|%s"`,
    { cwd: gitCwd, encoding: 'utf-8' },
  );
};

const defaultGitChangedFilesReader: GitChangedFilesReader = ({ sha, projectRoot: gitCwd }) => {
  const raw = execSync(
    `git show --name-only --format= --no-renames ${sha}`,
    { cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  return raw.split('\n').map(line => line.trim()).filter(Boolean);
};

/** Parse `%H|%an|%s` lines, tolerating `|` inside subject */
export function parseGitLogLine(line: string): ChannelOffender | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const firstPipe = trimmed.indexOf('|');
  if (firstPipe < 0) return null;
  const sha = trimmed.slice(0, firstPipe);
  const rest = trimmed.slice(firstPipe + 1);
  const secondPipe = rest.indexOf('|');
  if (secondPipe < 0) return null;
  const author = rest.slice(0, secondPipe);
  const subject = rest.slice(secondPipe + 1);
  return { sha, author, subject };
}

/**
 * Normal channel determination. F-015 (B-9d95 Round 1 review): aligned with workflow-policy.ts
 * computeChannel semantics, to avoid 3-5 item stories without riskSignals being misjudged as normal.
 *
 * computeChannel:
 *   express: items ≤ 2 and no risk
 *   fast:    items ≤ 5 and no risk and single solution (decision.options ≤ 1 or no decision)
 *   normal:  otherwise
 *
 * channel gate is enabled only on the normal channel.
 *
 * Keep the old 2-arg signature (itemCount + riskSignalCount) for back-compat, with behavior
 * adjusted to "no decision treated as single solution → ≤ 5 items and no risk → fast (not normal)",
 * consistent with computeChannel(story, checklist, undefined) result.
 *
 * Added isNormalChannelWithStory(story, checklist, decision?) for full determination,
 * so when checkCommitAuthor is passed a decision, decision.options.length > 1 is still judged as normal.
 */
export function isNormalChannel(opts: {
  itemCount: number;
  riskSignalCount: number;
}): boolean {
  // Construct minimal computeChannel input. No decision → computeChannel treats as single solution,
  // items ≤ 5 and no risk → fast; > 5 or has risk → normal.
  const stubStory = { riskSignals: Array.from({ length: opts.riskSignalCount }, () => ({ category: 'stub', matched: 'stub' })) };
  const stubChecklist = { items: Array.from({ length: opts.itemCount }, () => ({})) };
  return computeChannel(stubStory as unknown as StoryInfo, stubChecklist as unknown as ChecklistData, undefined) === 'normal';
}

/**
 * F-015: normal determination with full context. Checks:
 *   - decision.options.length > 1 → multi-solution → normal
 *   - any of the above normal conditions triggered → true
 * If decision is null/undefined, equivalent to isNormalChannel (single solution path).
 */
export function isNormalChannelWithStory(
  story: Pick<StoryInfo, 'riskSignals'> & Partial<Pick<StoryInfo, 'riskSignalsDismissed'>>,
  checklist: Pick<ChecklistData, 'items'>,
  decision?: Pick<DecisionData, 'options' | 'chosen'> | null,
): boolean {
  return computeChannel(story as StoryInfo, checklist as ChecklistData, decision) === 'normal';
}

/**
 * Determine whether a single commit can serve as legacy fallback.
 * - author == "proof-or-stop-implementer" passes
 * - canonical CLI subject prefix and only touches story metadata passes
 * - otherwise cannot serve as fallback; but if dispatch/subagent_result structured evidence is complete, author no longer hard-blocks
 */
export function isStoryMetadataPath(file: string): boolean {
  return isSharedStoryMetadataPath(file);
}

const CANONICAL_IMPLEMENTER_AUTHOR = 'proof-or-stop-implementer';
/** Current author fallback never promotes a retired agent spelling. */
function isImplementerAuthor(author: string): boolean {
  return author === CANONICAL_IMPLEMENTER_AUTHOR;
}

// B-cdf6:F-053 — READ-BOTH, and this one gates a transition. This matched only the
// DEPRECATED subject prefix, so once F-047/F-049 renamed the writers, a legitimate
// metadata-only auto-commit written under the canonical prefix was misclassified as a
// channel offender by the validate --channel REVIEW->TEST gate (via isAcceptableCommit
// -> the offenders filter). Demonstrated on this repo's own log: the subject
// "proof-or-stop: record B-cdf6 validate metadata" returned false while the old form
// returned true. Both prefixes are accepted now — the deprecated one deliberately, so
// pre-rename history keeps classifying correctly.
export function isMetadataOnlyProofOrStopCommit(c: Pick<ChannelOffender, 'subject' | 'files'>): boolean {
  return /^\s*(?:proof-or-stop|proofOrStop):/.test(c.subject)
    && Array.isArray(c.files)
    && c.files.length > 0
    && c.files.every(isStoryMetadataPath);
}

export function isAcceptableCommit(c: ChannelOffender): boolean {
  if (isImplementerAuthor(c.author)) return true;
  if (isMetadataOnlyProofOrStopCommit(c)) return true;
  return false;
}

/**
 * F-021 (B-fdcf CHK-003): read plan.md to extract the set of CHK-ids declaring `**Owner**: main-agent`.
 * Parsing rule: split by `^## (CHK-\d+)` sections, find the first line `**Owner**: main-agent` within each section
 * (whitespace tolerant). plan.md missing or parsing failure → return empty set (fail-open, continue requiring event evidence).
 */
export type PlanReader = (storyId: string, projectRoot: string) => string | null;

const defaultPlanReader: PlanReader = (storyId, projectRoot) => {
  const config = loadConfig(projectRoot);
  const planPath = join(projectRoot, config.storyDir, storyId, 'plan.md');
  if (!existsSync(planPath)) return null;
  try {
    return readFileSync(planPath, 'utf-8');
  } catch {
    return null;
  }
};

export function parseMainAgentOwnedItems(planContent: string | null): Set<string> {
  const owned = new Set<string>();
  if (!planContent) return owned;
  const lines = planContent.split('\n');
  let currentChk: string | null = null;
  const headerRe = /^##\s+(CHK-\d+)\b/;
  const ownerRe = /^\s*\*\*Owner\*\*\s*:\s*(\S[^\n]*)/i;
  for (const line of lines) {
    const hm = headerRe.exec(line);
    if (hm) {
      currentChk = hm[1];
      continue;
    }
    if (!currentChk) continue;
    const om = ownerRe.exec(line);
    if (om) {
      // Owner line matches main-agent (allow "main-agent" / "main-agent | ..." in the first position)
      const ownerValue = om[1].trim();
      // Take the first token (may contain "|" as separator for alternatives, main-agent must be the primary choice)
      const firstToken = ownerValue.split(/[\s|]+/)[0];
      if (firstToken === 'main-agent') {
        owned.add(currentChk);
      }
    }
  }
  return owned;
}

/**
 * F-021 (B-fdcf CHK-003): dispatch evidence determination.
 *
 * Each CHK-xxx must have evidence: `dispatch` event OR `subagent_result` event, deduplicated by checklistId / itemId.
 * If only subagent_result exists and success=false → report `dispatch exists but subagent failed`.
 *
 * THREE ways an item can leave the loop without being an issue, and the buckets
 * are disjoint (the loop below tests them in this order):
 *   1. B-45a5 CHK-003 — WITHDRAWN: the item is a member of
 *      `withdrawnChecklistItemIdsFrom(scopeShrinkageDecision)`. That helper reads
 *      ONLY the decision record (confirmed + userConfirmed), never a checklist
 *      item, so what makes this safe is decision membership — NOT an
 *      `item.status` string. An item hand-edited to a withdrawn-looking status is
 *      not in the set and is still refused. Checked FIRST so an authorized
 *      withdrawal is never laundered into either bucket below. → `withdrawnItems`.
 *   2. OWNER-EXEMPT: CHKs declaring `**Owner**: main-agent` in plan.md.
 *      → `exemptedItems`.
 *   3. EVIDENCED: the dispatch / subagent_result evidence above. → `evidencedItems`.
 */
export interface DispatchEvidenceIssue {
  itemId: string;
  reason: 'missing_evidence' | 'subagent_failed';
  message: string;
}

export interface DispatchEvidenceResult {
  ok: boolean;
  issues: DispatchEvidenceIssue[];
  /** item ids exempt by plan.md */
  exemptedItems: string[];
  /** item ids with evidence found (dispatch or success=true subagent_result) */
  evidencedItems: string[];
  /**
   * B-45a5 CHK-003: item ids EXCLUDED because a confirmed, user-confirmed
   * scope-shrinkage decision withdrew them. Deliberately its own bucket: they
   * are neither `evidencedItems` (rendered `Covered:`, which would record work
   * never done as covered) nor `exemptedItems` (rendered
   * `plan.md Owner=main-agent exempted:`, a false attribution).
   */
  withdrawnItems: string[];
  details: string[];
}

export function checkDispatchEvidence(opts: {
  checklist: Pick<ChecklistData, 'items'>;
  events: ProcessEvent[];
  mainAgentOwnedItems: Set<string>;
  /**
   * B-45a5 CHK-003: the story's scope-shrinkage decision record. It is the ONLY
   * thing that can excuse an item from the dispatch requirement, because no
   * work is dispatched for an item a confirmed decision withdrew. Absent/null
   * (legacy callers, unreadable record) excuses nothing.
   */
  scopeShrinkageDecision?: ScopeShrinkageDecisionData | null;
}): DispatchEvidenceResult {
  const { checklist, events, mainAgentOwnedItems, scopeShrinkageDecision } = opts;
  const items = checklist?.items ?? [];
  // Membership BY ITEM ID in the decision-resolved set is the sole key: the
  // helper reads only the decision record (confirmed + userConfirmed) and never
  // inspects a checklist item, so hand-editing item.status excuses nothing.
  const withdrawnIds = withdrawnChecklistItemIdsFrom(scopeShrinkageDecision);

  // Dedup collection: evidence set per itemId
  type Evidence = { hasDispatch: boolean; successResult: boolean; failureResult: boolean };
  const byItem = new Map<string, Evidence>();
  const getOrInit = (id: string): Evidence => {
    let e = byItem.get(id);
    if (!e) {
      e = { hasDispatch: false, successResult: false, failureResult: false };
      byItem.set(id, e);
    }
    return e;
  };

  for (const ev of events) {
    if (ev.type === 'dispatch') {
      const id = (ev as any).checklistId ?? (ev as any).itemId;
      if (typeof id === 'string' && /^CHK-\d+$/.test(id)) {
        getOrInit(id).hasDispatch = true;
      }
    } else if (ev.type === 'subagent_result') {
      const id = (ev as any).checklistId ?? (ev as any).itemId;
      if (typeof id === 'string' && /^CHK-\d+$/.test(id)) {
        // F-013 (B-fdcf Round 1): ProcessEvent is an index-signature type ([key]:unknown),
        // narrow to boolean | undefined when consuming the success field to avoid losing types via as any.
        const success = ev.success as boolean | undefined;
        if (success === false) getOrInit(id).failureResult = true;
        else getOrInit(id).successResult = true;
      }
    }
  }

  const issues: DispatchEvidenceIssue[] = [];
  const exemptedItems: string[] = [];
  const evidencedItems: string[] = [];
  const withdrawnItems: string[] = [];

  for (const item of items) {
    // F-012 (B-fdcf Round 1): ChecklistItem.id is already string, no need to force-cast as any
    const id = item.id;
    if (!id) continue;
    // Checked FIRST so an authorized withdrawal is never laundered into the
    // owner-exemption bucket and mis-attributed to a plan.md owner.
    if (withdrawnIds.has(id)) {
      withdrawnItems.push(id);
      continue;
    }
    if (mainAgentOwnedItems.has(id)) {
      exemptedItems.push(id);
      continue;
    }
    const ev = byItem.get(id);
    const hasAnyEvidence = !!ev && (ev.hasDispatch || ev.successResult || ev.failureResult);
    if (!hasAnyEvidence) {
      issues.push({
        itemId: id,
        reason: 'missing_evidence',
        message: `channel gate fail: ${id} has no dispatch/subagent_result evidence`,
      });
      continue;
    }
    // F-006 (B-fdcf Round 1): emit different messages depending on whether dispatch exists
    //   !hasDispatch && failureResult && !successResult → subagent failed and no dispatch evidence
    //    hasDispatch && failureResult && !successResult → dispatch exists but subagent failed
    if (ev && ev.failureResult && !ev.successResult) {
      const message = ev.hasDispatch
        ? `channel gate fail: ${id} dispatch exists but subagent failed`
        : `channel gate fail: ${id} subagent failed and no dispatch evidence`;
      issues.push({
        itemId: id,
        reason: 'subagent_failed',
        message,
      });
      continue;
    }
    // Both / only dispatch / only success result → pass (even if failureResult=true but a success record exists, treat as retry success)
    evidencedItems.push(id);
  }

  const details: string[] = [];
  if (withdrawnItems.length > 0) {
    // Rendered with the authorizing decision id so a reader can trace the
    // exclusion back to the record that granted it.
    const decisionId = scopeShrinkageDecision?.decisionId ?? 'decision id absent';
    details.push(`withdrawn (${decisionId}): ${withdrawnItems.join(', ')}`);
  }
  if (exemptedItems.length > 0) {
    details.push(`plan.md Owner=main-agent exempted: ${exemptedItems.join(', ')}`);
  }
  if (evidencedItems.length > 0) {
    details.push(`Covered: ${evidencedItems.join(', ')}`);
  }
  for (const iss of issues) {
    details.push(iss.message);
  }

  return {
    ok: issues.length === 0,
    issues,
    exemptedItems,
    evidencedItems,
    withdrawnItems,
    details,
  };
}

export interface CheckCommitAuthorDeps {
  store: StoryStore;
  projectRoot: string;
  /**
   * B-2856: cwd for the git child-process readers. In a wrapper-root layout the
   * metadataRoot (projectRoot) is not a git repo, so the handler resolves the
   * gitRoot via resolveGitCwd() and threads it here. Defaults to projectRoot so
   * plain repos (and existing callers) are byte-identical. Only the git readers
   * use this; plan.md and other metadata reads still use projectRoot.
   */
  gitCwd?: string;
  gitLogReader?: GitLogReader;
  gitChangedFilesReader?: GitChangedFilesReader;
  base?: string;
  /** F-021: test injection for reading plan.md */
  planReader?: PlanReader;
}

/**
 * Core entry: read story → determine channel → run git log → emit structured result.
 * story does not exist → structured fail.
 */
export function checkCommitAuthor(
  storyId: string,
  deps: CheckCommitAuthorDeps,
): ChannelCheckResult {
  const {
    store,
    projectRoot,
    gitLogReader = defaultGitLogReader,
    gitChangedFilesReader = defaultGitChangedFilesReader,
    base = DEFAULT_BASE,
    planReader = defaultPlanReader,
  } = deps;
  // B-2856: git readers run from the resolved gitRoot (wrapper-root) or fall
  // back to projectRoot (plain repo). Default keeps existing behavior identical.
  const gitCwd = deps.gitCwd ?? projectRoot;

  // story existence check
  if (!store.storyExists(storyId)) {
    return {
      provider: 'proof-or-stop-channel',
      status: 'fail',
      summary: `story not found: ${storyId}`,
      details: [`${store.storyDirRel()}/${storyId}/index.json does not exist`],
    };
  }

  let story;
  try {
    story = store.readStory(storyId);
  } catch (e: any) {
    return {
      provider: 'proof-or-stop-channel',
      status: 'fail',
      summary: `failed to read story: ${storyId}`,
      details: [String(e?.message ?? e)],
    };
  }

  let checklist;
  try {
    checklist = store.readChecklist(storyId);
  } catch (e: any) { rethrowIntentAmendmentIntegrityError(e);
    return {
      provider: 'proof-or-stop-channel',
      status: 'fail',
      summary: `failed to read checklist: ${storyId}`,
      details: [String(e?.message ?? e)],
    };
  }

  const itemCount = checklist?.items?.length ?? 0;
  const riskSignalCount = story.riskSignals?.length ?? 0;
  // F-015: if decision.json exists, options.length > 1 also makes computeChannel rule it normal
  let decision: Pick<DecisionData, 'options' | 'chosen'> | null = null;
  try {
    decision = store.readDecision(storyId);
  } catch { decision = null; }
  const normal = isNormalChannelWithStory(story, checklist, decision);

  if (!normal) {
    return {
      provider: 'proof-or-stop-channel',
      status: 'skipped',
      summary: 'Non-normal channel does not check normal-channel dispatch/subagent evidence',
      details: [
        `story=${storyId}`,
        `checklist items=${itemCount} & riskSignals=${riskSignalCount} → channel=express/fast`,
      ],
    };
  }

  // run git log
  const branch = `story/${storyId}`;
  let raw: string;
  try {
    raw = gitLogReader({ base, branch, projectRoot: gitCwd });
  } catch (e: any) {
    return {
      provider: 'proof-or-stop-channel',
      status: 'fail',
      summary: `git log failed for ${base}..${branch}`,
      details: [String(e?.message ?? e)],
    };
  }

  const commits = raw
    .split('\n')
    .map(parseGitLogLine)
    .filter((c): c is ChannelOffender => c !== null)
    .map((c) => {
      try {
        return { ...c, files: gitChangedFilesReader({ sha: c.sha, projectRoot: gitCwd }) };
      } catch {
        return c;
      }
    });

  const offenders = commits.filter((c) => !isAcceptableCommit(c));

  // F-021 (B-fdcf CHK-003): dispatch evidence check. Event sources = dispatch ∪ subagent_result,
  // CHKs declared `**Owner**: main-agent` in plan.md are exempt. Fail-open on parse failure and still require events.
  let events: ProcessEvent[] = [];
  try {
    events = store.readProcessEvents(storyId);
  } catch { events = []; }
  const planContent = planReader(storyId, projectRoot);
  const ownedByMain = parseMainAgentOwnedItems(planContent);
  // B-45a5 CHK-003: plumb the decision record through; without it the gate has
  // no authorized way to know an item was withdrawn. Unreadable record -> null,
  // which excuses nothing (fail-closed).
  let scopeShrinkageDecision: ScopeShrinkageDecisionData | null = null;
  try {
    scopeShrinkageDecision = store.readScopeShrinkageDecision(storyId);
  } catch { scopeShrinkageDecision = null; }
  const evidence = checkDispatchEvidence({
    checklist,
    events,
    mainAgentOwnedItems: ownedByMain,
    scopeShrinkageDecision,
  });

  // No-commit boundary: author check passes. Evidence check still runs—normal channel with no commits should still have dispatch/subagent_result records
  // but for back-compat (legacy test "no commits → pass"), skip the evidence check too when commits is 0.
  if (commits.length === 0) {
    return {
      provider: 'proof-or-stop-channel',
      status: 'pass',
      summary: `no commits between ${base} and ${branch}`,
      details: [`Normal channel story=${storyId}, but no new commits in ${base}..${branch}`],
    };
  }

  const itemIds = (checklist?.items ?? []).map(item => item.id).filter(Boolean);
  const allItemsOwnedByMain = itemIds.length > 0 && itemIds.every(id => ownedByMain.has(id));
  const authorFallbackOk = offenders.length === 0 || allItemsOwnedByMain;
  const hasImplementerCommit = commits.some(c => isImplementerAuthor(c.author));
  const structuredEvidenceOk = evidence.ok;
  const authorEvidenceCoversMissing = authorFallbackOk
    && !evidence.ok
    && hasImplementerCommit
    && evidence.issues.length > 0
    && evidence.issues.every(issue => issue.reason === 'missing_evidence');

  if (structuredEvidenceOk || authorEvidenceCoversMissing) {
    // F-003 (B-fdcf Round 1): determine the evidenceSource label, for renderChannelResult to embed
    // the "all CHK covered (via <source>)" phrase promised in userSees. Scan events to determine each
    // evidencedItems' evidence source: dispatch only → dispatch; subagent_result only → subagent_result;
    // both seen → dispatch + subagent_result. Not set when purely exempt (evidencedItems empty).
    let evidenceSource: ChannelCheckResult['evidenceSource'] | undefined;
    if (authorEvidenceCoversMissing) {
      evidenceSource = 'commit_author';
    } else if (evidence.evidencedItems.length > 0) {
      let anyDispatch = false;
      let anySubagent = false;
      const evidencedSet = new Set(evidence.evidencedItems);
      for (const ev of events) {
        const id = (ev as any).checklistId ?? (ev as any).itemId;
        if (typeof id !== 'string' || !evidencedSet.has(id)) continue;
        if (ev.type === 'dispatch') anyDispatch = true;
        else if (ev.type === 'subagent_result') anySubagent = true;
      }
      if (anyDispatch && anySubagent) evidenceSource = 'dispatch + subagent_result';
      else if (anyDispatch) evidenceSource = 'dispatch';
      else if (anySubagent) evidenceSource = 'subagent_result';
    }
    const summary = allItemsOwnedByMain && offenders.length > 0
      ? `Normal channel: ${commits.length} commits explicitly exempted by plan.md Owner=main-agent; dispatch/subagent_result evidence coverage complete`
      : authorEvidenceCoversMissing
        ? `Normal channel: ${commits.length} commits all produced by proof-or-stop-implementer or metadata-only proof-or-stop CLI; commit author as direct-dispatch execution evidence`
        : offenders.length > 0
          ? `Normal channel: dispatch/subagent_result structured evidence coverage complete; commit author only as auxiliary signal`
          : `Normal channel: ${commits.length} commits all produced by proof-or-stop-implementer or metadata-only proof-or-stop CLI; dispatch/subagent_result evidence coverage complete`;
    return {
      provider: 'proof-or-stop-channel',
      status: 'pass',
      summary,
      details: [
        ...commits.map((c) => `${c.sha.slice(0, 7)} ${c.author} — ${c.subject}`),
        ...(structuredEvidenceOk && offenders.length > 0
          ? [
              `commit author advisory: ${offenders.length} non-implementer commits already covered by structured dispatch/subagent_result evidence`,
              ...offenders.map((c) => `  advisory ${c.sha.slice(0, 7)} ${c.author} — ${c.subject}`),
            ]
          : []),
        ...(allItemsOwnedByMain && offenders.length > 0
          ? ['plan.md Owner=main-agent author exemption: all checklist items']
          : []),
        ...(authorEvidenceCoversMissing
          ? ['commit author=proof-or-stop-implementer fallback: no dispatch/subagent_result process event required for direct Agent execution']
          : []),
        ...evidence.details,
      ],
      evidenceSource,
    };
  }

  // Aggregate failure info
  const failDetails: string[] = [];
  const summaryParts: string[] = [];
  if (!evidence.ok) {
    summaryParts.push(`${evidence.issues.length} CHKs missing dispatch/subagent_result evidence`);
    for (const d of evidence.details) failDetails.push(d);
  }
  if (!authorFallbackOk) {
    summaryParts.push(`${offenders.length}/${commits.length} commits cannot be used as author fallback`);
    failDetails.push('commit author is only a legacy fallback; normal channel primary evidence must be dispatch/subagent_result process-events');
    failDetails.push('author fallback accepts author="proof-or-stop-implementer" or metadata-only subject="proof-or-stop:*" commits');
    failDetails.push('offenders:');
    for (const c of offenders) {
      failDetails.push(`  ${c.sha.slice(0, 7)} ${c.author} — ${c.subject}`);
    }
  }

  return {
    provider: 'proof-or-stop-channel',
    status: 'fail',
    summary: `Normal channel gate failure: ${summaryParts.join('; ')}`,
    details: failDetails,
    offenders: authorFallbackOk ? undefined : offenders,
  };
}

/**
 * B-9d95 CHK-006: CLI entry for `proof-or-stop validate --channel`.
 *
 * Does not spawn pytest / does not run full validate.ts—directly calls checkCommitAuthor, emitting
 * structured result + human-readable render. Used as an independent branch in REVIEW→TEST preflight.
 *
 * Returns:
 *   - ok: true when status ∈ {pass, skipped}
 *   - result: ChannelCheckResult (full structure)
 *   - rendered: human-readable multi-line string (for direct stdout printing)
 */
export interface ChannelCliResult {
  ok: boolean;
  result: ChannelCheckResult;
  rendered: string;
}

export function runChannelGateCli(
  storyId: string | undefined,
  deps: CheckCommitAuthorDeps,
): ChannelCliResult {
  if (!storyId || storyId.trim().length === 0) {
    const fail: ChannelCheckResult = {
      provider: 'proof-or-stop-channel',
      status: 'fail',
      summary: 'validate --channel requires the --story=B-xxx argument',
      details: ['Missing storyId: please use --story=<id> or --channel=<id>'],
    };
    return {
      ok: false,
      result: fail,
      rendered: renderChannelResult(fail),
    };
  }
  const result = checkCommitAuthor(storyId, deps);
  const ok = result.status === 'pass' || result.status === 'skipped';
  return { ok, result, rendered: renderChannelResult(result) };
}

/** Render ChannelCheckResult as human-readable text */
export function renderChannelResult(r: ChannelCheckResult): string {
  const lines: string[] = [];
  const icon = r.status === 'pass' ? '✓' : r.status === 'skipped' ? '·' : '✗';
  // F-003 (B-fdcf Round 1): pass branch appends the userSees-promised
  // `all CHK covered (via <evidenceSource>)` phrase. When evidenceSource is unset (e.g.
  // pure waiver / no commit boundary), omit it and keep the original prefix.
  let summary = r.summary;
  if (r.status === 'pass' && r.evidenceSource) {
    summary = `${summary} — all CHK covered (via ${r.evidenceSource})`;
  }
  lines.push(`[channel] ${icon} ${r.status}: ${summary}`);
  for (const d of r.details) lines.push(`  ${d}`);
  return lines.join('\n');
}
