/**
 * Critic-duplicate finding closure (run 17, Q1).
 *
 * The REVIEW inventory critic may disposition finding B as a `duplicate` of a
 * canonical finding A (same root cause, same familyKey). Run 17 still gave B a
 * repair cycle of its own (≈2.5–3 min, 1.9M tokens); the worker found the code
 * already fixed. B must not get its own repair when A's repair fixed B's case
 * too, but the critic's label alone never closes B: closure needs a passing
 * coverage run of B's own case (a test A's repair added for it, or B's repro).
 *
 *   - duplicateResolveCandidate: B is open, the latest critic disposition of B
 *     is `duplicate` with canonical A, A is resolved, and no coverage run of B
 *     failed. `next` then proposes finding_resolve with duplicateOf + coverage
 *     instead of a finding-repair dispatch.
 *   - runDuplicateCoverage: the framework runs the agent-named allowlisted
 *     command (executable + argv, never a shell program) in the Story worktree
 *     with the project validate.env, and passes only on exit 0 with the
 *     selector in the output (the receipt rules of verification_run).
 *   - every run is recorded in duplicate-finding-coverage.json; a failed run
 *     sends B back to its own managed repair.
 *
 * Lab reroute-mid-inventory: the same closure applies when B is an open finding
 * of a superseded lane run that the lane's rerun re-reported as A
 * (supersededRestatementOf); findingDuplicateOf is the one source for both.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { StoryStore } from './store.js';
import type { DuplicateCoverageReceipt, Finding } from './types.js';
import { loadConfig } from './config.js';
import { parseAllowlistedCommand, resolveEvidenceCommandTimeoutMs } from './validation-executor.js';
import { effectiveValidationCommandEnvironment } from './validation-command-environment.js';
import { findingClaimRestates } from './managed-inventory-critic.js';
import { agentRoleIdsEqual } from './agent-role-identity.js';

export { DUPLICATE_FINDING_COVERAGE_FILE, DUPLICATE_FINDING_COVERAGE_SCHEMA } from './types.js';
export type { DuplicateCoverageReceipt, DuplicateFindingCoverageData } from './types.js';

/**
 * The latest inventory-critic disposition of this finding, when it is
 * `duplicate` with a canonical finding (a later critic receipt that
 * dispositions the finding otherwise supersedes an earlier duplicate label).
 */
export function criticDuplicateOf(store: StoryStore, storyId: string, findingId: string):
  { canonicalFindingId: string; familyKey: string | null; reason: string } | null {
  const receipts = store.readReviewInventoryEpochs(storyId).criticReceipts;
  const rows = receipts.flatMap(receipt => receipt.findingDispositions ?? []).filter(row => row.findingId === findingId);
  const latest = rows.at(-1);
  if (!latest || latest.disposition !== 'duplicate' || !latest.canonicalFindingId || latest.canonicalFindingId === findingId) return null;
  return { canonicalFindingId: latest.canonicalFindingId, familyKey: latest.familyKey ?? null, reason: latest.reason };
}

/**
 * Lab reroute-mid-inventory: an open lane finding whose ReviewRun was
 * superseded by a later run of the same lane in the same round (the round was
 * invalidated and the lanes reran) and whose claim a finding of that later run
 * restates (findingClaimRestates). The later copy is the live canonical
 * finding: it is repaired, and this one closes only by the duplicate-coverage
 * run of its own case. A superseded finding nobody restated has no canonical
 * and is repaired on its own; neither is ever dropped.
 *
 * Old-PoS run 25 (F4): the restatement may come from ANY later run of the same
 * round, not only the same lane: the wave-1 inventory critic's F-002 (its run
 * superseded by the wave-2 critic) was restated by every wave-2 lane
 * (F-003..F-005). The superseded copy is carried forward onto the live
 * canonical restatement instead of getting a repair of its own.
 */
export function supersededRestatementOf(store: StoryStore, storyId: string, findingId: string):
  { canonicalFindingId: string; familyKey: null; reason: string } | null {
  const findings = store.readFindings(storyId).findings ?? [];
  const finding = findings.find(row => row.id === findingId);
  if (!finding?.reviewRunId || !finding.agent) return null;
  const runs = store.readReviewRuns(storyId).runs;
  const index = runs.findIndex(run => run.reviewRunId === finding.reviewRunId);
  const run = runs[index];
  if (!run) return null;
  const laterRuns = runs.slice(index + 1).filter(row => row.reviewRound === run.reviewRound);
  // Superseded: a later run of its own lane (same purpose) exists in this round.
  const superseded = laterRuns.some(row => agentRoleIdsEqual(row.lane, run.lane)
    && (row.reviewPurpose === 'inventory-completeness') === (run.reviewPurpose === 'inventory-completeness'));
  if (!superseded) return null;
  const later = new Set(laterRuns.map(row => row.reviewRunId));
  const best = findings
    .filter(row => row.id !== finding.id && row.status !== 'dismissed' && row.reviewRunId && later.has(row.reviewRunId))
    .map(row => ({ row, similarity: findingClaimRestates(finding, row), duplicate: criticDuplicateOf(store, storyId, row.id) !== null }))
    .filter((entry): entry is { row: Finding; similarity: number; duplicate: boolean } => entry.similarity !== null)
    // The live canonical copy first: a restatement the critic itself marked a duplicate is never preferred.
    .sort((a, b) => Number(a.duplicate) - Number(b.duplicate) || b.similarity - a.similarity || (a.row.createdAt ?? '').localeCompare(b.row.createdAt ?? ''))[0];
  if (!best) return null;
  return { canonicalFindingId: best.row.id, familyKey: null,
    reason: `Framework: ${finding.id}'s ReviewRun ${finding.reviewRunId} was superseded by a later run of its lane, and a later review run of the round re-reported it as ${best.row.id} (claim similarity ${best.similarity.toFixed(2)}).` };
}

/**
 * The canonical finding this one duplicates: the inventory critic's latest
 * `duplicate` disposition, else a lane rerun's restatement of a superseded
 * finding (supersededRestatementOf).
 */
export function findingDuplicateOf(store: StoryStore, storyId: string, findingId: string):
  { canonicalFindingId: string; familyKey: string | null; reason: string } | null {
  return criticDuplicateOf(store, storyId, findingId) ?? supersededRestatementOf(store, storyId, findingId);
}

export function duplicateCoverageReceipts(store: StoryStore, storyId: string, findingId: string): DuplicateCoverageReceipt[] {
  return store.readDuplicateFindingCoverage(storyId).receipts.filter(row => row.findingId === findingId);
}

/**
 * Whether `next` should propose closing this open finding as a critic
 * duplicate (finding_resolve with duplicateOf + coverage) instead of a repair.
 */
export function duplicateResolveCandidate(store: StoryStore, storyId: string, finding: Pick<Finding, 'id' | 'status'>, findings: readonly Finding[]):
  { canonical: Finding; familyKey: string | null } | null {
  if (finding.status !== 'open') return null;
  const duplicate = findingDuplicateOf(store, storyId, finding.id);
  if (!duplicate) return null;
  const canonical = findings.find(row => row.id === duplicate.canonicalFindingId);
  if (!canonical || canonical.status !== 'resolved') return null;
  if (duplicateCoverageReceipts(store, storyId, finding.id).some(row => !row.passed)) return null;
  return { canonical, familyKey: duplicate.familyKey };
}

/** True when an open finding is a duplicate (critic or superseded restatement) whose canonical finding is still open (repair the canonical first). */
export function duplicateOfOpenCanonical(store: StoryStore, storyId: string, findingId: string, findings: readonly Finding[]): boolean {
  const duplicate = findingDuplicateOf(store, storyId, findingId);
  if (!duplicate) return false;
  if (duplicateCoverageReceipts(store, storyId, findingId).some(row => !row.passed)) return false;
  return findings.find(row => row.id === duplicate.canonicalFindingId)?.status === 'open';
}

const GENERIC_SELECTOR = /^(?:ok|pass(?:ed)?|--- ?pass:?|pass:?|success|done|\d+ passing)$/i;

/** A selector that names nothing specific cannot show that the duplicate's own case ran. */
export function duplicateCoverageSelectorProblem(selector: string): string | null {
  const trimmed = selector.trim();
  if (trimmed.length < 6 || GENERIC_SELECTOR.test(trimmed)) {
    return `selector "${trimmed}" is generic; name the test or the output line that proves this finding's own case (e.g. "--- PASS: TestX")`;
  }
  return null;
}

export function runDuplicateCoverage(args: { projectRoot: string; cwd: string; command: string; selector: string; headHash: string | null; findingId: string; canonicalFindingId: string }): DuplicateCoverageReceipt {
  const { executable, args: argv } = parseAllowlistedCommand(args.command);
  const timeoutMs = resolveEvidenceCommandTimeoutMs({ executable, args: argv }, loadConfig(args.projectRoot).validate?.evidenceCommandTimeoutOverrides);
  const started = Date.now();
  const run = spawnSync(executable, argv, {
    cwd: args.cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
    env: effectiveValidationCommandEnvironment(process.env, undefined, args.cwd),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const timedOut = (run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || run.signal === 'SIGTERM';
  const selectorMatched = output.includes(args.selector);
  return {
    findingId: args.findingId,
    canonicalFindingId: args.canonicalFindingId,
    command: args.command,
    selector: args.selector,
    exitCode: run.status,
    timedOut,
    selectorMatched,
    passed: run.status === 0 && !timedOut && selectorMatched,
    headHash: args.headHash,
    durationMs: Date.now() - started,
    outputDigest: createHash('sha256').update(output).digest('hex'),
    outputTail: output.trim().split('\n').slice(-8).join('\n').slice(-1200),
    executedAt: new Date().toISOString(),
  };
}
