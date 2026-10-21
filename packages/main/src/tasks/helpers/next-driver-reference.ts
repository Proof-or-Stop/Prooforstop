/**
 * FROZEN REFERENCE (golden oracle) for tasks/next-driver-cost-smoke.ts.
 *
 * A verbatim copy of createNextDriver from handlers/next-driver.ts as of
 * bench/speed-int a0a3f39e2c, before the next-driver-cost optimization. The
 * smoke evaluates this reference and the live driver on the same fixture
 * states and requires deep-equal NextStep results, so a cost cut can never
 * change which step `next` returns. Only import paths differ from the original.
 * A deliberate behavior change to `next` must update this copy in the same
 * commit and say why.
 *
 * Deliberate change (lab run95, bench-staging/oldpos/run93-96-analysis.md fix 2): the shared
 * preexistingDispositionStep is a framework step (its payload is complete and finding_resolve rechecks
 * the base evidence), and a duplicate the owner would close waits while another open finding still
 * needs its managed repair launch (no agent step in front of a repair launch).
 *
 * Deliberate change (supervisor-readiness, detection A/B pilot): a review
 * lane whose earlier run(s) of the round failed only because the managed
 * recovery supervisor never became ready (replacement-safe, nothing ran) is
 * relaunched by the framework (bound launch) up to
 * MANAGED_SUPERVISOR_NOT_READY_AUTO_RELAUNCHES (now MANAGED_AUTO_RELAUNCHES_PER_TARGET) times; other failures stay the agent's call.
 *
 * Deliberate change (critic-import-loop, detection A/B control D2-r3/D9-r1):
 * a completed inventory critic whose import was refused (terminal evidence
 * persisted + process event inventory_critic_import_refused for that exact
 * run/receipt) is no longer proposed for import again forever; criticNext
 * returns a fresh critic dispatch / review_run_start naming the refusal.
 *
 * Deliberate change (next-finding-repaired, run 14): a DEV finding counts as
 * repaired only through a completed managed finding-repair run bound to that
 * finding id with a material commit (managedFindingRepairState, shared with the
 * live driver), not through a global material change since its review; the
 * REVIEW-phase finding_resolve proposals (REVIEW→TEST refusal, PRE_CERT admit)
 * resolve only such a repaired finding and otherwise return to DEV.
 *
 * Deliberate change (evidence-binding-quality, run 16): which test proves which
 * intent is the agent's judgment. A gate command with placeholders (nested
 * ones included) is an agent step (hintedStep, shared with the live driver);
 * the evidence-chain step's why carries the ranked candidate tests
 * (evidenceChainStep); the advisory unbound-test bind is no longer a step of
 * its own but a sentence on the step that follows (evidenceChainAdvisory).
 *
 * Deliberate change (next-run-drives-waits, run 17 Q6): a managed launch whose
 * host/model/effort is the owner's own earlier selection, with no placeholder
 * and no earlier (failed) run of the same target, is a framework step with
 * launch:true that `next --run` executes (managedLaunchStep,
 * boundManagedSelection, hasRunForTarget; shared with the live driver); the
 * TEST finish decision and summary are ONE step (testAuthoringStep, batch);
 * PLAN blockers fixed by decision_set / plan_set are ONE step with each exact
 * command (planAuthoringStep); every placeholder carries a one-line
 * description (placeholderHints, built by the shared step()).
 *
 * Deliberate change (plan-author-before-scope, run 19 P1/P2): while the
 * scope-plan verdict is missing or must be rerun (scopePlanRerunReason), PLAN
 * first returns the deterministic authoring batch (preScopeAuthoringStep over
 * planPreScopeBlockers, shared) and only then the reviewer launch; a stale
 * verdict is relaunched (scopePlanLaunchIsFramework decides framework vs agent)
 * instead of falling to the DEV guard's story_review. The golden fixture starts
 * in DEV, so its 27 quiet states are unchanged.
 *
 * Deliberate change (provider-stall-detect, old-PoS run 20): a managed provider
 * with no stdout for the stall window fails `provider_stalled:...`; when it
 * left no work product it is auto-replaceable like a supervisor-not-ready
 * launch. One relaunch rule (targetRelaunchIsFramework, shared with the live
 * driver) now covers review lanes, implementer items, finding repairs and the
 * scope-plan reviewer: earlier runs of the target that ALL failed
 * auto-replaceably, at most MANAGED_AUTO_RELAUNCHES_PER_TARGET = 3, keep the
 * relaunch a framework step; any other earlier run stays the agent's call.
 *
 * Not mirrored (ab-variant-switches, 2026-10-06): the EXPERIMENTAL detection
 * A/B switches (core/ab-variants.ts; review.criticOnCleanRound and
 * implementation.grouping change `next`). This copy is the production arm
 * only; with every switch at its default the live driver must equal it, which
 * next-driver-cost-smoke checks.
 *
 * Deliberate change (adopt-grouped-remediation, detection A/B V4,
 * bench-staging/oldpos/ab/results-r2.md: remediation wall -48%, tokens -70%,
 * every finding fixed with its own commit and resolve, round-2 detection
 * unchanged): remediation.grouping=single is now the production default, so
 * this copy mirrors it. A DEV finding with no bound repair, while other open
 * blocking findings also have none, is repaired by ONE grouped finding_repair
 * (groupedFindingRepairIds / groupedFindingRepairStep, shared with the live
 * driver; the `per-finding` rollback returns no group). Each member still
 * needs a commit in the run's window naming its id (managedFindingRepairState)
 * before finding_resolve; a member without one gets its own single repair.
 *
 * Deliberate change (critic-final-and-batch-resolve, old-PoS run 24 F2/F4):
 * a managed run that failed with no work product because its final envelope
 * stayed missing/invalid after the same-session format repair
 * (managed_review_final_result_*), or on a provider transport error
 * (provider_transport_error:), is auto-replaceable
 * (isAutoReplaceableManagedLaunchFailure, shared), so the replacement critic or
 * lane launch is a framework step under the same <= 3-per-target rule. When the
 * finding a resolve step is about has other open findings that are repaired too
 * (a grouped repair), the step is ONE finding_resolve listing them
 * (finding_resolve_batch: repairedFindingsForResolve / findingResolveBatchStep,
 * shared); each entry keeps its own commit and re-check.
 *
 * Deliberate change (dup-routing-coverage, run 17 Q1): a critic `duplicate`
 * finding waits while its canonical finding is open (nextBlockingFinding);
 * once the canonical one is repaired and resolved and the duplicate has no
 * repair of its own and no failed coverage run, the step is
 * finding_duplicate_resolve (duplicateFindingResolveStep, shared with the live
 * driver) instead of a second finding_repair; a failed coverage run sends it
 * to its own repair, whose why names that run.
 *
 * Deliberate change (request-outranks-intent, old-PoS run 23 D1): with no
 * implementer / finding-repair in flight, an `[intent-conflict]` a terminal
 * writer run declared (or an implementer's prose-only deliberate deviation)
 * whose item intent is unchanged since the run was dispatched blocks DEV first:
 * `intent_conflict` = story_advance PLAN (openIntentConflicts /
 * intentConflictStep, shared with the live driver); it precedes every finding
 * repair / finding_resolve / finding_resolve_batch step, and the REVIEW-phase
 * finding closure returns to DEV (intent_conflict_dev) instead of resolving.
 * The golden fixture declares no conflict, so its quiet states are unchanged.
 *
 * Deliberate change (orchestration-overlap, v4.1 cost plan N1/N2/N8):
 *   N2 fully bound prepared lanes launch in ONE step whose `parallel` lists each
 *      host_run (next --run spawns them concurrently); the critic's
 *      begin → dispatch → review_run_start chain is ONE review_round_prepare
 *      {inventoryCritic:true} step (reasons inventory_begin /
 *      inventory_critic_prepare);
 *   N1 while the delivery reviewer runs, the TEST authoring step and the
 *      review-assurance step are proposed instead of waiting (they write only
 *      Story metadata); done_prepare and DONE still wait;
 *   N8 DEV waits for a live deferred scope-plan run before enter_review, and a
 *      deferred verdict with a gap returns to PLAN (scope_verdict_replan). The
 *      golden fixture starts in DEV with no scope run, so N8 changes no state.
 *
 * Deliberate change (old-PoS run 27 delivery relaunch): a delivery run of the
 * current TEST entry that failed replacement-safely (no delivery-check, e.g. a
 * stale dispatch binding) is relaunched by the framework (bound launch) up to
 * MANAGED_AUTO_RELAUNCHES_PER_TARGET times, like every other role's target;
 * any other earlier delivery run keeps the relaunch the agent's call. The
 * golden fixture never fails a delivery run, so its states are unchanged.
 *
 * Deliberate change (old-PoS run 27 per-item N8 hold): while the deferred
 * scope-plan verdict is missing, DEV does not dispatch the items its pin audit /
 * same-semantics rule concerns (scopeVerdictHeldItems); it implements the free
 * items, then waits on the scope-plan run (or returns to PLAN when none is
 * live). The golden fixture has no missing deferred verdict, so no item is held.
 *
 * Deliberate change (old-PoS run 27 owner tail): the DONE step's why ends with
 * DONE_TERMINAL_STATEMENT ("DONE — stop; no further commands ...").
 *
 * Deliberate change (old-PoS run 40 §4, bundle hygiene): step `source`
 * labels name the mechanism only, no benchmark run number (the shipped
 * strings carried "old-PoS run NN"); the which-step decision is unchanged.
 *
 * Deliberate change (old-PoS run 40 N3): the DEV guard whose hint is
 * story_review while the latest round is current returns ONE owner step
 * (plan_review_blockers, storyReviewBlockersStep, shared) that lists the
 * round's blockers and names `next --run` for the rerun, instead of a
 * hand-run story_review (run 40: the owner reran it twice and launched the
 * scope-plan reviewer by hand). The golden fixture starts in DEV, so its
 * states are unchanged; the PLAN fixtures of plan-author-before-scope and
 * run40-fixes compare both drivers on it.
 *
 * Deliberate change (old-PoS run 30, B-c201:F-005): with no finding-repair in
 * flight, an open blocking finding whose cited path:line defect sites are
 * unchanged since the Story base and that nothing in the request/scope covers
 * (evaluatePreexistingFinding) gets ONE audited disposition step
 * (preexistingDispositionStep: finding_resolve
 * disposition=preexisting_out_of_scope) instead of a repair; a finding whose
 * repair runs ended without a commit twice since PLAN returns to PLAN
 * (findingRepairReplanStep), and after one such run the relaunch's why says the
 * prompt carries the earlier report. The golden fixture's findings cite no
 * path:line site and every repair commits, so its states are unchanged.
 *
 * Deliberate change (lab run89, bench-staging/oldpos/run88-89-analysis.md §5 fix 2): the one relaunch the
 * route allows after a run without an accepted repair is a framework launch, the replan step names why each
 * run was not accepted, and a missing report line never counts (the worker asks for it). The golden fixture's
 * repairs commit and report completely, so its states are unchanged.
 *
 * Deliberate change (old-PoS run 34, bench-staging/oldpos/run34-analysis.md §4):
 * a repaired finding's finding_resolve / finding_resolve_batch is a framework
 * step with framework-authored resolutions in the resolutions[] form (one entry
 * for a single finding), unless a finding would fail the cited-change check
 * (frameworkResolveStep, shared); the golden fixture's finding_resolve_batch state
 * changed kind and payload accordingly. Lanes launch slowest-first and a finished
 * lane is imported before a wait on the rest (managedRunsWaitStep, any-terminal);
 * the fixture's lanes already came in that order and waits are not quiet states.
 * After an adopted intent amendment an item is verified (intent_amend_verify /
 * intent_amend_done) instead of relaunched; the DEV guard's Why carries its first
 * reason and a stale story_review round is rerun as a framework step. The fixture
 * starts in DEV with no conflict, so neither changes a quiet state.
 */
import { orderLanesForLaunch } from '../../core/review-lane-launch-order.js';
import { storyReviewRoundStale } from '../../core/story-review-staleness.js';
import { existsSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import type { HandlerContext } from '../../handlers/context.js';
import { loadConfig } from '../../core/config.js';
import { resolveWorkflowPolicy } from '../../core/workflow-policy.js';
import { resolveGitCwd } from '../../core/story-signed-workspace-resolution.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../../core/evidence-freshness.js';
import { evaluateDevMemoryPreflightGate, evaluateReviewVerdict, getGuardFailureReason } from '../../core/machine.js';
import { missingPlanScopeCheckFailure, SCOPE_PLAN_REVIEWER, scopePlanLaunchIsFramework, scopePlanRerunReason } from '../../core/plan-scope-check-requirement.js';
import { planPreScopeBlockers } from '../../core/plan-pre-scope-blockers.js';
import { isTerminalChecklistStatus } from '../../core/checklist-status.js';
import { unclosedBlockingFindings, resolveEffectiveBlockingSeverities, FINDING_RESOLUTION_PLACEHOLDER } from '../../core/finding-closure.js';
import {
  currentOpenReviewInventory,
  finalizedUnconsumedReviewInventory,
  isInventoryCompletenessOnlyReceipt,
  reviewInventoryPurposeBinding,
} from '../../core/review-inventory-epoch.js';
import {
  currentPrecertCheapCheckReceipt,
  isSaturatedReviewInventoryForPrecert,
  loadReviewInventoryAdmitApis,
  inspectCertificationWindowLineage,
  windowAuthorizesHeavyCertification,
  PRE_CERT_CHEAP_CHECK_REQUIRED,
  PRE_CERT_INVENTORY_NOT_FINALIZED,
  PRE_CERT_BLOCKING_FINDINGS_OPEN,
} from '../../core/certification-window.js';
import { currentCertificationIdentity } from '../../handlers/certification-window.js';
import { currentPrecertFastIdentity, precertCheapCheckWaived } from '../../handlers/validation-identity.js';
import { evaluateEvidenceChainForStory } from '../../handlers/evidence-chain.js';
import { checklistHasFileDeclarations } from '../../handlers/phase-gates.js';
import { collectReviewerEvidenceState, verifyCurrentReviewerDispatchBinding } from '../../core/review-run.js';
import { managedHostRunsRoot, readManagedHostRunProjection, managedHostRunReceipt, isAutoReplaceableManagedLaunchFailure } from '../../core/managed-host-run.js';
import { findingRepairRoute } from '../../core/finding-preexisting.js';
import { evaluatePreexistingFinding } from '../../handlers/finding-preexisting.js';
import { noCommitRepairRunsSincePlan, preexistingDispositionStep, findingRepairReplanStep, findingConflictStep, unacceptedRepairWhys, fileStateSettleStep } from '../../handlers/next-driver.js';
import { evaluateFileStateConflict } from '../../handlers/file-state-conflict.js';
import { managedFindingRepairState, hintedStep, evidenceChainStep, evidenceChainAdvisory, step as sharedStep, managedLaunchStep, boundManagedSelection,
  runsForTarget, targetRelaunchIsFramework, findingRepairRelaunchIsFramework, testAuthoringStep, planAuthoringStep, preScopeAuthoringStep, nextBlockingFinding, duplicateFindingResolveStep,
  groupedFindingRepairIds, groupedFindingRepairStep, repairedFindingsForResolve, findingResolveBatchStep, frameworkResolveStep, managedRunsWaitStep, adoptedAmendmentRun, intentAmendmentVerifyStep, guardRefusalSummary, storyReviewBlockersStep, openIntentConflicts, intentConflictStep, journalOpenIntentConflicts, laneRelaunchStep, nextStepCall, DONE_TERMINAL_STATEMENT, type NextStep } from '../../handlers/next-driver.js';
import { scopeVerdictHeldItems, scopeVerdictReviewEntryFailure } from '../../core/scope-plan-deferral.js';
import { duplicateCoverageReceipts, duplicateResolveCandidate } from '../../core/duplicate-finding-coverage.js';
import { singleHostAssuranceReady } from '../../handlers/quorum-submit.js';
import { hasPersistedManagedReceiptEvidence, refusedManagedReviewImport } from '../../handlers/managed-review-evidence.js';
import { MANAGED_INVENTORY_CRITIC_LANE } from '../../core/managed-inventory-critic.js';
import { buildDoneChecklist, type DoneCheckRow } from '../../core/done-oracle.js';
import { evaluateReviewAssuranceFloor, buildReviewAssuranceFloorGuidance, buildReviewEscalationGuidance, type ReviewAssuranceGuidance } from '../../core/review-assurance-floor.js';
import { evaluateReviewEscalation, assessReviewHostAvailabilityForFallbackEligibility } from '../../core/review-escalation.js';
import { evaluateOptionalLiveSmokeTranscript } from '../../core/live-smoke-transcript-evidence.js';
import type { ReviewRun } from '../../core/types.js';
import { maxLaneRunsOnMaterial, STALE_WAVE_STOP_LOSS } from '../../core/review-stop-loss.js';

type HandlerLookup = (name: string) => ((...args: any[]) => any) | undefined;

/** evaluateReviewVerdict codes that mean a required lane still lacks valid current-round evidence. */
const LANE_VERDICT_CODES = new Set(['review_evidence_missing', 'review_lane_missing', 'review_evidence_invalid', 'review_quorum']);

const NEXT_STEP_SCHEMA = 'proof-or-stop.next_step.v1';
const DELIVERY_REVIEWER = 'proof-or-stop-review-delivery';
const FINDING_REPAIR_AGENT = 'proof-or-stop-finding-repair';
const IMPLEMENTER_AGENT = 'proof-or-stop-implementer';

type NextStepKind = 'agent' | 'framework' | 'human';



// ---------------------------------------------------------------------------
// Command rendering / parsing

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function step(
  base: { storyId: string; phase: string },
  kind: NextStepKind,
  reason: string,
  call: { command: string; payload: Record<string, unknown> } | null,
  why: string,
  source: string,
  extra: Partial<Pick<NextStep, 'wait' | 'done' | 'placeholders' | 'launch' | 'parallel'>> = {},
): NextStep {
  return sharedStep(base, kind, reason, call, why, source, extra);
}

/** POSIX-ish word splitting: single quotes, double quotes (backslash escapes), bare words. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      current += end < 0 ? line.slice(i + 1) : line.slice(i + 1, end);
      i = end < 0 ? line.length : end;
      inWord = true;
    } else if (ch === '"') {
      i += 1;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) i += 1;
        current += line[i];
        i += 1;
      }
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

/**
 * Parse one hinted `proof-or-stop <command> ...` line (the form every gate
 * prints) into {command, payload}. Accepts a single JSON payload argument or
 * --key=value / --flag options. Returns null for anything else.
 */
function parseHintedCommand(line: string): { command: string; payload: Record<string, unknown> } | null {
  const match = line.match(/proof-or-stop\s+[a-z][a-z0-9_]*(?:\s+(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"]+)+)*/);
  if (!match) return null;
  const words = shellWords(match[0]);
  const command = words[1];
  if (!command) return null;
  const payload: Record<string, unknown> = {};
  for (const word of words.slice(2)) {
    if (word.startsWith('{')) {
      try { Object.assign(payload, JSON.parse(word) as Record<string, unknown>); continue; } catch { return null; }
    }
    const flag = word.match(/^--([A-Za-z][A-Za-z0-9_]*)(?:=(.*))?$/s);
    if (!flag) break;
    const value = flag[2];
    payload[flag[1]!] = value === undefined || value === 'true' ? true : value === 'false' ? false : value;
  }
  return { command, payload };
}

function nextLine(text: string): string | null {
  const line = text.split('\n').reverse().find(row => row.startsWith('Next: '));
  return line ? line.slice('Next: '.length).trim() : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Managed host runs of this Story (runtime projection only)

interface HostRunView {
  runId: string;
  host: string;
  model: string | null;
  reasoningEffort: string | null;
  profile: string | null;
  agentType: string;
  reviewRunId: string | null;
  state: string;
  terminal: boolean;
  createdAt: string;
  /** Failed before its recovery supervisor became ready: provably nothing ran (isAutoReplaceableManagedLaunchFailure). */
  autoReplaceable: boolean;
  replacementSafe?: boolean;
}

function listStoryHostRuns(ctx: HandlerContext, storyId: string): HostRunView[] {
  const root = managedHostRunsRoot(ctx.root);
  if (!existsSync(root)) return [];
  const rows: HostRunView[] = [];
  for (const runId of readdirSync(root)) {
    try {
      const run = readManagedHostRunProjection(ctx.root, runId);
      if (run.storyId !== storyId) continue;
      rows.push({ runId, host: run.host, model: run.model ?? null, reasoningEffort: run.reasoningEffort ?? null, profile: run.profile,
        agentType: run.agentType, reviewRunId: run.reviewRunId, state: run.state,
        terminal: run.terminal !== null, createdAt: run.createdAt,
        autoReplaceable: isAutoReplaceableManagedLaunchFailure({ state: run.state, replacementSafe: run.replacementSafe, terminalReason: run.terminal?.reason ?? null, agentType: run.agentType }),
        replacementSafe: run.replacementSafe === true });
    } catch { /* not a readable managed run */ }
  }
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId));
}

// Deliberate behavior change (Lab owner-poll-tokens, run 14): the wait step
// prints the compact text status, not the full --json record, and blocks up
// to 285 s per call (core/owner-wait-guidance.ts OWNER_WAIT_BLOCK_MS).
function waitStep(base: { storyId: string; phase: string }, run: HostRunView, what: string): NextStep {
  return step(base, 'framework', 'managed_run_wait', { command: 'host_run_status', payload: { runId: run.runId, untilTerminal: true } },
    `${what} ${run.runId} is ${run.state}; block until it is terminal (returns at terminal, up to 285 s per call).`,
    'managed host-run projection', { wait: true });
}


// ---------------------------------------------------------------------------
// Decision

export function createReferenceNextDriver(ctx: HandlerContext, lookup: HandlerLookup) {
  const handler = (name: string): ((...args: any[]) => any) => {
    const fn = lookup(name);
    if (!fn) throw new Error(`next: required handler ${name} is not registered`);
    return fn;
  };

  function gitCwdOf(storyId: string): string {
    return resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
  }

  function policyOf(storyId: string) {
    return resolveWorkflowPolicy(loadConfig(ctx.root), ctx.store.readStory(storyId));
  }

  function openBlockingFindings(storyId: string) {
    const { effectiveBlockingSeverities, roundCount } = resolveEffectiveBlockingSeverities(ctx.store, storyId, policyOf(storyId));
    return unclosedBlockingFindings({ store: ctx.store, projectRoot: ctx.root, storyId,
      findings: ctx.store.readFindings(storyId).findings ?? [], effectiveBlockingSeverities, round: roundCount });
  }

  /** A gate's own printed next command, as a step of the given kind. */
  const delegated = hintedStep;

  function guardStep(base: { storyId: string; phase: string }, target: string, reason: string, why: string, source: string): NextStep {
    const failure = getGuardFailureReason(base.storyId, ctx.store, target, ctx.root, gitCwdOf(base.storyId));
    if (!failure) {
      return step(base, 'framework', reason, { command: 'story_advance', payload: { storyId: base.storyId, phase: target } }, why, source);
    }
    const hint = nextLine(failure) ?? failure.split('\n').find(row => /proof-or-stop [a-z_]+/.test(row)) ?? '';
    // old-PoS run 34 F7: a stale story_review round is rerun by the framework; the Why carries the first reason.
    if (target === 'DEV' && /proof-or-stop story_review\b/.test(hint) && storyReviewRoundStale(ctx.store.storyDirPath(base.storyId),
      (() => { try { return (ctx.store.readReview(base.storyId).reviews.at(-1) as { timestamp?: string } | undefined)?.timestamp ?? null; } catch { return null; } })())) {
      return step(base, 'framework', 'story_review_rerun', { command: 'story_review', payload: { storyId: base.storyId } },
        `story_advance --phase=DEV would be refused: ${guardRefusalSummary(failure)}. The latest story_review round is older than the Story inputs it judged (checklist, plan, scope verdict, ...): rerun it; it records the current PLAN checks.`,
        'getGuardFailureReason(DEV) + storyReviewRoundStale (core/story-review-staleness.ts)');
    }
    // old-PoS run 40 N3: a current round's blockers are one owner step naming next --run, never a hand-run story_review.
    if (target === 'DEV' && /proof-or-stop story_review\b/.test(hint)) {
      let blockers: Array<{ type: string; message: string }> = [];
      try {
        blockers = ((ctx.store.readReview(base.storyId).reviews.at(-1)?.issues ?? []) as Array<{ type?: string; severity?: string; message?: string }>)
          .filter(issue => issue.severity === 'blocker').map(issue => ({ type: String(issue.type ?? 'blocker'), message: String(issue.message ?? '') }));
      } catch { blockers = []; }
      if (blockers.length) return storyReviewBlockersStep(base, failure, blockers);
    }
    return delegated(base, 'agent', `guard_${target.toLowerCase()}_blocked`, hint || failure,
      `story_advance --phase=${target} would be refused: ${guardRefusalSummary(failure)}`, `getGuardFailureReason(${target})`);
  }

  // -- DEV -----------------------------------------------------------------

  function devNext(base: { storyId: string; phase: string }): NextStep {
    const { storyId } = base;
    const checklist = ctx.store.readChecklist(storyId);
    const open = checklist.items.filter(item => !isTerminalChecklistStatus(item.status));
    const hostRuns = listStoryHostRuns(ctx, storyId);
    const inFlight = (agentType: string) => hostRuns.filter(run => run.agentType === agentType && !run.terminal).at(-1);
    if (!inFlight(IMPLEMENTER_AGENT) && !inFlight(FINDING_REPAIR_AGENT)) {
      const conflicts = openIntentConflicts({ root: ctx.root, gitCwd: gitCwdOf(storyId), store: ctx.store, storyId, runs: hostRuns });
      if (conflicts.length > 0) journalOpenIntentConflicts(ctx.root, storyId, conflicts);
      if (conflicts.length > 0) return intentConflictStep(base, conflicts);
      // Mirrors next-driver.ts (orchestration-overlap N8): a deferred scope verdict with a gap returns to PLAN.
      const scopeVerdict = scopeVerdictReviewEntryFailure(ctx.store, ctx.root, ctx.store.readStory(storyId), policyOf(storyId));
      if (scopeVerdict && !/\[scope_check_pending\]/.test(scopeVerdict)) {
        return guardStep(base, 'PLAN', 'scope_verdict_replan', `${scopeVerdict.split('\n')[0]} Return to PLAN to cover or exclude it; \`next --run\` then relaunches the scope-plan reviewer itself.`,
          'scopeVerdictReviewEntryFailure (DEV→REVIEW gate, N8 deferred scope verdict)');
      }
    }
    // Deliberate change (old-PoS run 27 per-item N8 hold): held items wait for the verdict.
    const hold = open.length > 0 ? scopeVerdictHeldItems(ctx.store, ctx.root, ctx.store.readStory(storyId), policyOf(storyId)) : null;
    const heldIds = new Set(hold?.heldItemIds ?? []);
    const dispatchable = open.filter(item => !heldIds.has(item.id));
    if (open.length > 0 && dispatchable.length === 0) {
      const implementing = inFlight(IMPLEMENTER_AGENT);
      if (implementing) return waitStep(base, implementing, 'Implementer run');
      const scopeRun = hostRuns.filter(run => run.agentType === SCOPE_PLAN_REVIEWER && !run.terminal).at(-1);
      if (scopeRun) return waitStep(base, scopeRun, `Scope-plan reviewer run (held until its verdict lands: ${open.map(item => item.id).join(', ')}; ${hold!.reason})`);
      return guardStep(base, 'PLAN', 'scope_verdict_replan', `The scope-plan verdict is missing and no scope-plan run is live; ${open.map(item => item.id).join(', ')} wait for it. Return to PLAN; \`next --run\` then relaunches the scope-plan reviewer itself.`,
        'scopeVerdictHeldItems (per-item N8 hold)');
    }
    if (dispatchable.length > 0) {
      const item = dispatchable[0]!;
      if (item.status === 'pending') {
        return step(base, 'framework', 'checklist_item_start', { command: 'checklist_update', payload: { storyId, itemId: item.id, status: 'in_progress' } },
          `${item.id} is pending; mark it in_progress before dispatching its implementer.`, 'checklist.json');
      }
      const running = inFlight(IMPLEMENTER_AGENT);
      if (running) return waitStep(base, running, 'Implementer run');
      const { selection, bound } = boundManagedSelection(hostRuns, 'managed_dispatch');
      // old-PoS run 34 F5: after an adopted intent amendment the framework verifies the item itself.
      const amendment = adoptedAmendmentRun({ root: ctx.root, gitCwd: gitCwdOf(storyId), item, runs: hostRuns });
      const verify = amendment ? intentAmendmentVerifyStep({ root: ctx.root, gitCwd: gitCwdOf(storyId), store: ctx.store, base, item, amendment }) : null;
      if (verify && 'schemaVersion' in verify) return verify;
      if (verify && 'refused' in verify) {
        return managedLaunchStep(base, 'implement_item', { ...selection, storyId, itemId: item.id,
          agentType: IMPLEMENTER_AGENT, managedDispatch: true, detach: true, json: true }, bound,
        `${item.id}'s intent was amended to the value implementer run ${amendment!.runId} declared, but the framework's verification of its pinned intent did not pass (${verify.refused}): relaunch the implementer for the amended intent.`,
        'adoptedAmendmentRun + verification_run_refused', 'relaunch after the framework verification of the amended intent failed');
      }
      return managedLaunchStep(base, 'implement_item', { ...selection, storyId, itemId: item.id,
        agentType: IMPLEMENTER_AGENT, managedDispatch: true, detach: true, json: true }, bound && targetRelaunchIsFramework(runsForTarget(ctx.root, hostRuns, IMPLEMENTER_AGENT, { itemId: item.id })),
      `${item.id} (${item.title}) is ${item.status}: implement and commit it (managed implementer shown; a native fresh-context implementer with the dispatch prompt is equivalent), then mark it done.`,
      'checklist.json');
    }

    // Verified blocking findings must be closed (finding-closure rule) before
    // REVIEW is worth re-entering.
    const findings = openBlockingFindings(storyId);
    const chain = evaluateEvidenceChainForStory(ctx, storyId);
    if (findings.length > 0) {
      if (!hostRuns.some(run => run.agentType === FINDING_REPAIR_AGENT && !run.terminal)) {
        for (const row of findings) {
          const verdict = evaluatePreexistingFinding({ store: ctx.store, root: ctx.root, storyId, finding: row.finding });
          if (verdict.eligible && !managedFindingRepairState({ root: ctx.root, gitCwd: gitCwdOf(storyId), storyId, finding: row.finding, runs: hostRuns }).repaired) {
            return preexistingDispositionStep(base, row.finding, verdict);
          }
        }
        // Lab run110 (shared with the live driver): the losing side of a file-state conflict is closed once, never repaired.
        const all = ctx.store.readFindings(storyId).findings ?? [];
        for (const row of findings) {
          const verdict = evaluateFileStateConflict({ store: ctx.store, root: ctx.root, storyId, finding: row.finding, findings: all });
          if (verdict?.settle && !managedFindingRepairState({ root: ctx.root, gitCwd: gitCwdOf(storyId), storyId, finding: row.finding, runs: hostRuns }).repaired) {
            return fileStateSettleStep(base, row.finding, verdict);
          }
        }
      }
      // Old-PoS run 47 (shared with the live driver): an unpinned finding conflict goes to the owner's pin.
      if (!inFlight(FINDING_REPAIR_AGENT)) {
        const conflictStep = findingConflictStep({ root: ctx.root, gitCwd: gitCwdOf(storyId), store: ctx.store, base, open: findings.map(row => row.finding),
          repaired: row => managedFindingRepairState({ root: ctx.root, gitCwd: gitCwdOf(storyId), storyId, finding: row, runs: hostRuns }).repaired });
        if (conflictStep) return conflictStep;
      }
      let { finding } = nextBlockingFinding(ctx.store, storyId, findings);
      let repair = managedFindingRepairState({ root: ctx.root, gitCwd: gitCwdOf(storyId), storyId, finding, runs: hostRuns });
      // Lab run95 (fix 2, shared rule with the live driver): an owner-closed duplicate waits while another open finding needs its repair launch.
      if (!repair.repaired && !repair.bound && !hostRuns.some(run => run.agentType === FINDING_REPAIR_AGENT && !run.terminal)) {
        const all = ctx.store.readFindings(storyId).findings ?? [];
        if (duplicateResolveCandidate(ctx.store, storyId, finding, all)) {
          const alternative = findings.find(row => row.finding.id !== finding.id
            && !managedFindingRepairState({ root: ctx.root, gitCwd: gitCwdOf(storyId), storyId, finding: row.finding, runs: hostRuns }).repaired
            && !evaluatePreexistingFinding({ store: ctx.store, root: ctx.root, storyId, finding: row.finding }).eligible
            && !duplicateResolveCandidate(ctx.store, storyId, row.finding, all));
          if (alternative) {
            finding = alternative.finding;
            repair = managedFindingRepairState({ root: ctx.root, gitCwd: gitCwdOf(storyId), storyId, finding, runs: hostRuns });
          }
        }
      }
      if (!repair.repaired) {
        const repairRun = hostRuns.filter(run => run.agentType === FINDING_REPAIR_AGENT && !run.terminal).at(-1);
        if (repairRun) return waitStep(base, repairRun, 'Finding repair run');
        const noCommit = noCommitRepairRunsSincePlan(ctx.store, storyId, repair);
        const route = findingRepairRoute({ preexistingOutOfScope: false, noCommitRunsSincePlan: noCommit.length });
        if (route.kind === 'replan') return findingRepairReplanStep(base, finding, noCommit, unacceptedRepairWhys(repair));
        const duplicate = repair.bound ? null : duplicateResolveCandidate(ctx.store, storyId, finding, ctx.store.readFindings(storyId).findings ?? []);
        if (duplicate) return duplicateFindingResolveStep(base, finding, duplicate.canonical, duplicate.familyKey);
        const failedCoverage = duplicateCoverageReceipts(ctx.store, storyId, finding.id).filter(row => !row.passed).at(-1);
        const { selection, bound } = boundManagedSelection(hostRuns, 'managed_dispatch');
        // adopt-grouped-remediation: one grouped run for every open blocking finding no repair is bound to yet.
        const group = groupedFindingRepairIds({ root: ctx.root, store: ctx.store, gitCwd: gitCwdOf(storyId), storyId, primary: finding,
          primaryBound: repair.bound, findings: findings.map(row => row.finding), runs: hostRuns });
        if (group.length > 1) return groupedFindingRepairStep(ctx.root, base, group, selection, bound, hostRuns);
        // Lab run89 (fix 2d, shared with the live driver): the one relaunch the route allows is a framework launch.
        return managedLaunchStep(base, 'finding_repair', { ...selection, storyId, findingId: finding.id,
          agentType: FINDING_REPAIR_AGENT, managedDispatch: true, detach: true, json: true }, bound && (findingRepairRelaunchIsFramework({ root: ctx.root, gitCwd: gitCwdOf(storyId), storyId, hostRuns, findingId: finding.id }) || (route.kind === 'repair' && route.relaunch)),
        `Verified ${finding.severity} finding ${finding.id} is open and not yet repaired (${repair.detail}${failedCoverage ? `; its duplicate coverage run \`${failedCoverage.command}\` did not pass, so ${failedCoverage.canonicalFindingId}'s repair is not shown to fix it` : ''}): repair it in code and commit (managed finding-repair shown).${route.kind === 'repair' && route.relaunch ? ' The relaunched run\'s prompt carries the earlier run\'s report; another run without an accepted repair returns the Story to PLAN.' : ''}`,
        'unclosedBlockingFindings (core/finding-closure.ts) + managedFindingRepairState', route.kind === 'repair' && route.relaunch ? 'relaunch after a run without an accepted repair' : undefined);
      }
      if (chain.blocking && chain.nextAction) {
        return evidenceChainStep(base, chain, 'The repair changed material, so pinned receipts are stale; refresh them before recording the resolution.');
      }
      // critic-final-and-batch-resolve (old-PoS run 24 F4): several repaired findings close in ONE finding_resolve.
      const repaired = repairedFindingsForResolve({ root: ctx.root, gitCwd: gitCwdOf(storyId), storyId, runs: hostRuns,
        primary: finding, primaryRepair: repair, candidates: findings.map(row => row.finding) });
      // old-PoS run 34 REM: the framework resolves repaired findings itself (frameworkResolveStep).
      const framework = frameworkResolveStep({ root: ctx.root, gitCwd: gitCwdOf(storyId), store: ctx.store, base, repaired,
        why: 'Closure is required whichever round raised them.', source: 'unclosedBlockingFindings (core/finding-closure.ts)', chainFresh: true });
      if (framework) return framework;
      if (repaired.length > 1) {
        return findingResolveBatchStep(base, repaired, 'Closure is required whichever round raised them.', 'unclosedBlockingFindings (core/finding-closure.ts)');
      }
      return step(base, 'agent', 'finding_resolve', { command: 'finding_resolve', payload: { storyId, findingId: finding.id, resolution: FINDING_RESOLUTION_PLACEHOLDER } },
        `${finding.id} was repaired by managed finding-repair run ${repair.runId} (commit ${repair.commit.slice(0, 12)}) but is still open; closure is required whichever round raised it. Name the repair commit and its passing focused evidence.`,
        'unclosedBlockingFindings (core/finding-closure.ts) + managedFindingRepairState', { placeholders: ['resolution'] });
    }
    if (chain.blocking && chain.nextAction) {
      return evidenceChainStep(base, chain, 'The DEV→REVIEW evidence-chain gate would refuse: a must/should receipt is stale or missing.');
    }
    // Mirrors the live driver (run 16): resolve an advisory finding whose bound repair completed.
    if (hostRuns.some(run => run.agentType === FINDING_REPAIR_AGENT)) {
      const blocking = new Set(openBlockingFindings(storyId).map(row => row.finding.id));
      for (const finding of ctx.store.readFindings(storyId).findings ?? []) {
        if (finding.status !== 'open' || blocking.has(finding.id) || finding.evidenceState === 'disproven') continue;
        const repair = managedFindingRepairState({ root: ctx.root, gitCwd: gitCwdOf(storyId), storyId, finding, runs: hostRuns });
        if (!repair.repaired) continue;
        const framework = frameworkResolveStep({ root: ctx.root, gitCwd: gitCwdOf(storyId), store: ctx.store, base, repaired: [{ id: finding.id, runId: repair.runId, commit: repair.commit }],
          why: `Advisory ${finding.severity} finding ${finding.id} was repaired; resolve it before REVIEW so DONE does not leave it open.`,
          source: 'managedFindingRepairState (advisory finding with a completed bound repair)', chainFresh: true });
        if (framework) return framework;
        return step(base, 'agent', 'finding_resolve', { command: 'finding_resolve', payload: { storyId, findingId: finding.id, resolution: FINDING_RESOLUTION_PLACEHOLDER } },
          `Advisory ${finding.severity} finding ${finding.id} was repaired by managed finding-repair run ${repair.runId} (commit ${repair.commit.slice(0, 12)}) but is still open; resolve it before REVIEW so DONE does not leave it open. Name the repair commit and its passing focused evidence.`,
          'managedFindingRepairState (advisory finding with a completed bound repair)', { placeholders: ['resolution'] });
      }
    }
    const advisory = evidenceChainAdvisory(chain);
    const scopeRunning = inFlight(SCOPE_PLAN_REVIEWER);
    if (scopeRunning && !ctx.store.readScopeCheck(storyId)) return waitStep(base, scopeRunning, 'Scope-plan reviewer run (deferred verdict, gates REVIEW)');
    if (!ctx.store.readScopeContract(storyId) && checklistHasFileDeclarations(checklist)) {
      return step(base, 'framework', 'scope_contract_init', { command: 'scope_contract_init_from_plan', payload: { storyId } },
        `Checklist items declare files but no scope contract exists; REVIEW refuses [missing_scope_contract].${advisory}`, 'runScopeTransitionGate precondition');
    }
    return guardStep(base, 'REVIEW', 'enter_review', advisory ? `DEV is complete: every item done and no evidence-chain item blocks.${advisory}` : 'DEV is complete: every item done and the evidence chain is clean.', 'getGuardFailureReason(REVIEW)');
  }

  // -- REVIEW ----------------------------------------------------------------

  function hostRunFor(hostRuns: HostRunView[], reviewRunId: string): HostRunView | undefined {
    return hostRuns.filter(run => run.reviewRunId === reviewRunId).at(-1);
  }

  function reviewLaunchStep(base: { storyId: string; phase: string }, lane: string, reviewRunId: string, critic: boolean): NextStep {
    const hostRuns = listStoryHostRuns(ctx, base.storyId);
    const { selection, bound } = boundManagedSelection(hostRuns, 'managed_reviewer');
    const runs = ctx.store.readReviewRuns(base.storyId).runs;
    const round = runs.find(run => run.reviewRunId === reviewRunId)?.reviewRound;
    const failedEarlier = runs.filter(run => run.lane === lane && run.reviewRound === round && run.reviewRunId !== reviewRunId
      && (hostRunFor(hostRuns, run.reviewRunId)?.state ?? 'completed') !== 'completed').map(run => hostRunFor(hostRuns, run.reviewRunId));
    // A launch whose recovery supervisor never became ready (host load) ran
    // nothing: the framework relaunches it itself, up to
    // MANAGED_AUTO_RELAUNCHES_PER_TARGET times (targetRelaunchIsFramework; a stalled provider with no work product too); any other earlier
    // failure keeps the replacement the agent's call.
    const replacement = !targetRelaunchIsFramework(failedEarlier.map(run => ({ autoReplaceable: run?.autoReplaceable === true })));
    return managedLaunchStep(base, critic ? 'inventory_critic_launch' : 'review_lane_launch', { ...selection,
      storyId: base.storyId, agentType: lane, reviewRunId, lane, managedReview: true, detach: true, json: true }, bound && !replacement,
    critic
      ? `Launch the managed inventory-completeness critic for ReviewRun ${reviewRunId} (it dispositions every verified finding of this wave).`
      : `Launch the managed ${lane.replace('proof-or-stop-review-', '')} reviewer for ReviewRun ${reviewRunId}; launch every prepared lane before waiting.`,
    'review-runs.json + managed host-run projection');
  }

  function importStep(base: { storyId: string; phase: string }, run: HostRunView, receiptId: string): NextStep {
    return step(base, 'framework', 'review_evidence_import', { command: 'managed_review_evidence_import', payload: { runId: run.runId, receiptId } },
      `Managed review run ${run.runId} completed; import its sealed terminal receipt as review evidence.`, 'managed host-run receipt');
  }

  /** Run 17: every completed lane of the round in ONE import process (one transaction per lane, in order). */
  function laneImportStep(base: { storyId: string; phase: string }, importable: Array<{ run: HostRunView; receiptId: string }>): NextStep {
    if (importable.length === 1) return importStep(base, importable[0]!.run, importable[0]!.receiptId);
    return step(base, 'framework', 'review_evidence_import', { command: 'managed_review_evidence_import', payload: { imports: importable.map(row => ({ runId: row.run.runId, receiptId: row.receiptId })) } },
      `Managed review runs ${importable.map(row => row.run.runId).join(', ')} completed; import their sealed terminal receipts as review evidence (one process, one transaction each).`, 'managed host-run receipt');
  }


  /**
   * Prepared lanes of the current round, from review-runs.json and the host-run
   * projection only (cheap): launch every prepared lane, then wait, then import.
   */
  function pendingLaneStep(base: { storyId: string; phase: string }, round: string): NextStep | null {
    const { storyId } = base;
    const runs = ctx.store.readReviewRuns(storyId).runs.filter(run => run.reviewRound === round && run.reviewPurpose !== 'inventory-completeness');
    if (runs.length === 0) return null;
    const passes = ctx.store.readReviewPasses(storyId).passes;
    const findings = ctx.store.readFindings(storyId).findings ?? [];
    const evidenced = (run: ReviewRun) => passes.some(pass => pass.reviewRunId === run.reviewRunId) || findings.some(finding => finding.reviewRunId === run.reviewRunId);
    const hostRuns = listStoryHostRuns(ctx, storyId);
    const toLaunch: Array<{ lane: string; run: ReviewRun }> = [];
    const waiting: HostRunView[] = [];
    const importable: Array<{ run: HostRunView; receiptId: string }> = [];
    const relaunch: string[] = [];
    for (const lane of [...new Set(runs.map(run => run.lane))]) {
      const latest = runs.filter(run => run.lane === lane).at(-1)!;
      if (evidenced(latest)) continue;
      const hostRun = hostRunFor(hostRuns, latest.reviewRunId);
      if (!hostRun) { toLaunch.push({ lane, run: latest }); continue; }
      if (!hostRun.terminal) { waiting.push(hostRun); continue; }
      if (hostRun.state !== 'completed') {
        // Lab run131 (shared rule): an auto-replaceable failure (provider stalled / supervisor never ready, no work product)
        // is relaunched now, while its sibling lanes still run; otherwise reviewer_batch → review_round_prepare after them.
        const earlier = runs.filter(run => run.lane === lane).map(run => hostRunFor(hostRuns, run.reviewRunId)).filter((run): run is HostRunView => Boolean(run));
        if (hostRun.autoReplaceable && targetRelaunchIsFramework(earlier)) relaunch.push(lane);
        continue;
      }
      let receiptId = '';
      try { receiptId = managedHostRunReceipt(ctx.root, hostRun.runId).receiptId; } catch { continue; }
      // A/B V3 R2A-r2: a receipt whose import was refused for good is never
      // proposed again; the lane then has no evidence and review_round_prepare
      // starts a fresh run of it.
      if (!hasPersistedManagedReceiptEvidence(ctx.store, storyId, receiptId)
        && !refusedManagedReviewImport(ctx.store, storyId, hostRun.runId, receiptId)) importable.push({ run: hostRun, receiptId });
    }
    if (toLaunch.length) {
      // Mirrors next-driver.ts (orchestration-overlap N2): fully bound prepared lanes launch concurrently in one step.
      // old-PoS run 34: historically slowest lanes first.
      const ordered = orderLanesForLaunch(toLaunch.map(row => row.lane)).map(lane => toLaunch.find(row => row.lane === lane)!);
      const launches = ordered.map(row => reviewLaunchStep(base, row.lane, row.run.reviewRunId, false));
      const bound = launches.filter(launch => launch.kind === 'framework' && launch.launch && launch.cli);
      if (bound.length > 1 && bound[0] === launches[0]) {
        return step(base, 'framework', 'review_lane_launch', bound[0]!.cli,
          `Launch the ${bound.length} prepared managed reviewer lanes concurrently (${bound.map(launch => String(launch.cli!.payload.lane).replace('proof-or-stop-review-', '')).join(', ')}), each in its own host_run process, before waiting. Fully bound (this Story's own host/model/effort, first run of each target): \`next --run\` launches them together.`,
          'review-runs.json + managed host-run projection', { launch: true, parallel: bound.map(launch => nextStepCall(launch.reason, launch.cli!)) });
      }
      return launches[0]!;
    }
    if (relaunch.length && waiting.length) return laneRelaunchStep(base, relaunch, waiting.length);
    // old-PoS run 34: a finished lane is imported while slower lanes run; one any-terminal wait.
    if (importable.length) return laneImportStep(base, importable);
    if (waiting.length) return waiting.length === 1 ? waitStep(base, waiting[0]!, 'Managed reviewer run') : managedRunsWaitStep(base, waiting, 'Managed reviewer runs');
    return null;
  }

  /** Lanes the REVIEW gate still misses (reviewer_batch launchable set) → one review_round_prepare. */
  function lanePrepareStep(base: { storyId: string; phase: string }): NextStep | null {
    const batch = handler('reviewer_batch')({ storyId: base.storyId, json: true }) as { executionPlan: { launchableLanes: string[] } };
    const launchable = batch.executionPlan.launchableLanes;
    if (launchable.length === 0) return null;
    return step(base, 'framework', 'review_round_prepare', { command: 'review_round_prepare', payload: { storyId: base.storyId, json: true } },
      `Lane(s) ${launchable.map(lane => lane.replace('proof-or-stop-review-', '')).join(', ')} have no valid current-round evidence: route if needed, then dispatch + review_run_start each launchable lane.`,
      'reviewer_batch executionPlan.launchableLanes');
  }

  /** Mirrors next-driver.ts (orchestration-overlap N2): begin → critic dispatch → review_run_start as ONE review_round_prepare step. */
  function criticPrepareStep(base: { storyId: string; phase: string }, why: string, source: string, reason = 'inventory_critic_prepare'): NextStep {
    return step(base, 'framework', reason, { command: 'review_round_prepare', payload: { storyId: base.storyId, inventoryCritic: true, json: true } }, why, source);
  }

  /** The inventory critic of an OPEN epoch: prepare (dispatch + review_run_start) → launch → wait → import. */
  function criticNext(base: { storyId: string; phase: string }, epoch: NonNullable<ReturnType<typeof currentOpenReviewInventory>>, round: string): NextStep {
    const { storyId } = base;
    const critic = MANAGED_INVENTORY_CRITIC_LANE;
    const binding = reviewInventoryPurposeBinding(epoch);
    const criticRun = ctx.store.readReviewRuns(storyId).runs.filter(run => run.reviewRound === round && run.reviewPurpose === 'inventory-completeness'
      && run.inventoryBinding?.epochId === epoch.epochId && run.inventoryBinding?.wave === binding.wave).at(-1);
    if (!criticRun) {
      return criticPrepareStep(base, `Every required lane of epoch ${epoch.epochId} is terminal; bind the inventory-completeness critic dispatch for wave ${binding.wave} (unless already bound) and start its ReviewRun.`,
        'review_inventory_status (REVIEW_INVENTORY_CRITIC_INCOMPLETE)');
    }
    // Mirrors next-driver.ts (lab reroute-mid-inventory): lanes rerun after the critic started make it stale; run a fresh critic.
    const roundRuns = ctx.store.readReviewRuns(storyId).runs.filter(run => run.reviewRound === round);
    const laneAfterCritic = roundRuns.slice(roundRuns.findIndex(run => run.reviewRunId === criticRun.reviewRunId) + 1).find(run => run.reviewPurpose !== 'inventory-completeness');
    if (laneAfterCritic) {
      return criticPrepareStep(base, `Lane run ${laneAfterCritic.reviewRunId} (${laneAfterCritic.lane.replace('proof-or-stop-review-', '')}) started after critic ReviewRun ${criticRun.reviewRunId}; that critic did not see the rerun lanes and its import would be refused. Start a fresh critic of wave ${binding.wave}.`,
        'review-runs order (lane rerun after critic)');
    }
    const hostRun = hostRunFor(listStoryHostRuns(ctx, storyId), criticRun.reviewRunId);
    if (!hostRun) return reviewLaunchStep(base, critic, criticRun.reviewRunId, true);
    if (!hostRun.terminal) return waitStep(base, hostRun, 'Inventory critic run');
    if (hostRun.state === 'completed') {
      let receiptId: string;
      try {
        receiptId = managedHostRunReceipt(ctx.root, hostRun.runId).receiptId;
      } catch (error) {
        return step(base, 'agent', 'inventory_critic_receipt_unavailable', null, `Critic run ${hostRun.runId} has no readable receipt: ${message(error)}`, 'managed host-run receipt');
      }
      const refused = refusedManagedReviewImport(ctx.store, storyId, hostRun.runId, receiptId);
      if (!refused) return importStep(base, hostRun, receiptId);
      return criticPrepareStep(base, `The import of critic run ${hostRun.runId} (ReviewRun ${criticRun.reviewRunId}) was refused: ${refused.slice(0, 400)}. Any findings it imported are kept; run a fresh critic of wave ${binding.wave} whose prompt names this refusal (never the same import again).`,
        'process-events inventory_critic_import_refused | managed_review_import_refused');
    }
    return criticPrepareStep(base, `Critic run ${hostRun.runId} ended ${hostRun.state}; start a fresh critic ReviewRun and relaunch it.`, 'managed host-run projection');
  }

  /**
   * A REVIEW-phase refusal naming open verified blocking findings: resolve the
   * first one a managed finding-repair bound to it repaired; when none is,
   * return to DEV, where next dispatches the repair of each (run 14: never
   * propose closing an unrepaired finding).
   */
  function reviewFindingClosureStep(base: { storyId: string; phase: string }, ids: readonly string[], why: string, source: string): NextStep {
    const { storyId } = base;
    const findings = ctx.store.readFindings(storyId).findings ?? [];
    const hostRuns = listStoryHostRuns(ctx, storyId);
    const gitCwd = gitCwdOf(storyId);
    // D1 (run 23): a finding whose repair declared an open [intent-conflict] is
    // never resolved (alone or in a batch) before the intent is amended: DEV
    // blocks on the conflict first.
    const conflicts = openIntentConflicts({ root: ctx.root, gitCwd, store: ctx.store, storyId, runs: hostRuns });
    if (conflicts.length > 0) {
      return guardStep(base, 'DEV', 'intent_conflict_dev',
        `${why} A managed writer run declared an open intent conflict (${conflicts.map(row => `${row.itemId} by ${row.runId}`).join('; ')}): return to DEV, where next routes the intent amendment before any finding is resolved.`,
        `${source} + openIntentConflicts + getGuardFailureReason(DEV)`);
    }
    const details: string[] = [];
    for (const id of ids) {
      const finding = findings.find(row => row.id === id);
      if (!finding) continue;
      const repair = managedFindingRepairState({ root: ctx.root, gitCwd, storyId, finding, runs: hostRuns });
      if (repair.repaired) {
        const repaired = repairedFindingsForResolve({ root: ctx.root, gitCwd, storyId, runs: hostRuns, primary: finding, primaryRepair: repair,
          candidates: ids.flatMap(other => findings.filter(row => row.id === other)) });
        const framework = frameworkResolveStep({ root: ctx.root, gitCwd, store: ctx.store, base, repaired, why, source, chainFresh: false });
        if (framework) return framework;
        if (repaired.length > 1) return findingResolveBatchStep(base, repaired, why, source);
        return step(base, 'agent', 'finding_resolve', { command: 'finding_resolve', payload: { storyId, findingId: id, resolution: FINDING_RESOLUTION_PLACEHOLDER } },
          `${why} ${id} was repaired by managed finding-repair run ${repair.runId} (commit ${repair.commit.slice(0, 12)}); record that commit and its passing focused evidence.`,
          `${source} + managedFindingRepairState`, { placeholders: ['resolution'] });
      }
      details.push(repair.detail);
    }
    return guardStep(base, 'DEV', 'finding_unrepaired_dev',
      `${why} None is repaired yet (${details.join('; ') || 'no readable finding'}): return to DEV, where next dispatches the managed repair of each.`,
      `${source} + managedFindingRepairState + getGuardFailureReason(DEV)`);
  }

  function reviewNext(base: { storyId: string; phase: string }): NextStep {
    const { storyId } = base;
    const story = ctx.store.readStory(storyId);
    const round = story.currentReviewRound;
    if (!round) return guardStep(base, 'TEST', 'review_round_missing', 'REVIEW has no current round.', 'story.currentReviewRound');
    const gitCwd = gitCwdOf(storyId);

    // 1. Lanes of the current round: prepared runs first, then the gate's own verdict.
    const laneStep = pendingLaneStep(base, round);
    if (laneStep) return laneStep;
    let verdict = evaluateReviewVerdict({ storyId, store: ctx.store, projectRoot: ctx.root, gitCwd });
    // Mirrors next-driver.ts (lab reroute-mid-inventory; old-PoS run 25 F4): open findings of a superseded
    // review run (stale_run / superseded_inventory_wave) are carried forward as blocking BEFORE any lane
    // relaunch; superseded critic passes alone send next to the inventory step (a fresh critic).
    let criticRefresh = false;
    if (!verdict.ok && verdict.code === 'review_evidence_invalid') {
      const state = collectReviewerEvidenceState(ctx.store, storyId, ctx.root);
      const findings = ctx.store.readFindings(storyId).findings ?? [];
      if (state.invalid.length > 0 && state.invalid.every(issue => issue.kind === 'finding' && (issue.code === 'stale_run' || issue.code === 'superseded_inventory_wave')
        && findings.find(row => row.id === issue.evidenceId)?.status === 'open')) {
        verdict = { ok: false, code: 'review_finding_blocking', unclosedFindingIds: [...new Set(state.invalid.map(issue => issue.evidenceId))], message: verdict.message };
      } else {
        criticRefresh = state.invalid.length > 0 && state.invalid.every(issue => issue.kind === 'pass' && issue.code === 'superseded_inventory_wave');
      }
    }
    if (!verdict.ok && LANE_VERDICT_CODES.has(verdict.code ?? '') && !criticRefresh) {
      // Mirrors next-driver.ts stale-wave stop-loss.
      const blocking = openBlockingFindings(storyId);
      if (blocking.length > 0 && maxLaneRunsOnMaterial(ctx.store, storyId, round, currentMaterialHash(gitCwd, 'HEAD', ctx.root)) >= STALE_WAVE_STOP_LOSS) {
        return reviewFindingClosureStep(base, blocking.map(row => row.finding.id), `Stop-loss (${verdict.code}).`, 'evaluateReviewVerdict + stale-wave stop-loss');
      }
      const prepare = lanePrepareStep(base);
      if (prepare) return prepare;
    }
    if (!verdict.ok && verdict.code !== 'review_finding_blocking' && !criticRefresh) {
      // Mirrors next-driver.ts reviewStopLossStep (never `human — none runnable`): open findings -> repair; else DEV.
      const blocking = openBlockingFindings(storyId);
      if (blocking.length > 0) return reviewFindingClosureStep(base, blocking.map(row => row.finding.id), `Stop-loss (${verdict.code}).`, 'evaluateReviewVerdict + stop-loss (open findings)');
      return step(base, verdict.code === 'open_review_loop' ? 'human' : 'agent', `review_verdict_${verdict.code ?? 'error'}`, null,
        `REVIEW→TEST verdict refuses [${verdict.code}] with no launchable lane: ${verdict.message ?? ''}`, 'evaluateReviewVerdict');
    }

    // 2. A current certification window (PRE_CERT already admitted).
    const inspected = inspectCertificationWindowLineage({ store: ctx.store, storyId, current: currentCertificationIdentity(ctx, storyId) });
    if (!criticRefresh && !inspected.drift.drifted && windowAuthorizesHeavyCertification(inspected.window, inspected.receipt)) {
      const status = String(handler('certification_window_status')({ storyId }));
      const hint = nextLine(status) ?? '';
      if (/story_advance .*--phase=TEST/.test(hint)) {
        if (!verdict.ok) {
          return reviewFindingClosureStep(base, verdict.unclosedFindingIds ?? [],
            `REVIEW→TEST refuses [${verdict.code}]: ${verdict.message ?? ''}`, 'evaluateReviewVerdict (the REVIEW→TEST guard)');
        }
        // evaluateReviewVerdict above IS the REVIEW→TEST xstate guard (canPassReviewGuard).
        return step(base, 'framework', 'enter_test', { command: 'story_advance', payload: { storyId, phase: 'TEST' } },
          'The certification window is current, the routine validation PASS is admissible and the review verdict passes.', 'certification_window_status Next + evaluateReviewVerdict');
      }
      if (inspected.window!.state === 'ADMITTED') {
        return step(base, 'framework', 'routine_validation', { command: 'validate', payload: { story: storyId, json: true } },
          'PRE_CERT admitted this window; run the one routine suite now, with no other command in between (it claims the window).', 'certification_window_status (ADMITTED)');
      }
      return step(base, 'agent', 'routine_validation_not_admissible', null,
        `The certification window is ${inspected.window!.state} but no admissible routine PASS exists; the routine suite failed or is running. Fix the code through REVIEW→DEV remediation. Gate: ${hint}`,
        'certification_window_status + assessStoredValidationPassAdmissibility');
    }

    // 3. Inventory epoch.
    const openEpoch = currentOpenReviewInventory(ctx.store, storyId);
    if (openEpoch) {
      if (openEpoch.reviewRound !== round) {
        return step(base, 'framework', 'inventory_cancel_stale', { command: 'review_inventory_cancel', payload: { storyId, reason: 'OPEN epoch belongs to an earlier review round' } },
          `OPEN epoch ${openEpoch.epochId} is from round ${openEpoch.reviewRound}, not ${round}.`, 'currentOpenReviewInventory');
      }
      const status = String(handler('review_inventory_status')({ storyId }));
      const hint = nextLine(status) ?? '';
      if (/REVIEW_INVENTORY_CRITIC_INCOMPLETE/.test(status)) return criticNext(base, openEpoch, round);
      if (/proof-or-stop dispatch /.test(hint)) {
        return step(base, 'framework', 'review_round_prepare', { command: 'review_round_prepare', payload: { storyId, json: true } },
          `Epoch ${openEpoch.epochId} still misses required lane evidence.`, 'review_inventory_status (REVIEW_INVENTORY_LANES_INCOMPLETE)');
      }
      return delegated(base, 'framework', 'inventory_status_next', hint, `Epoch ${openEpoch.epochId}: ${status.split('\n').find(row => row.startsWith('Blockers:')) ?? ''}`.trim(), 'review_inventory_status Next');
    }
    const pending = finalizedUnconsumedReviewInventory(ctx.store, storyId);
    if (pending) {
      if (pending.receipt?.authority === 'review-remediation-only') {
        return guardStep(base, 'DEV', 'enter_remediation_dev', `Epoch ${pending.epoch.epochId} finalized a remediation receipt: return to DEV to repair the verified finding(s).`, 'finalizedUnconsumedReviewInventory + getGuardFailureReason(DEV)');
      }
      if (isInventoryCompletenessOnlyReceipt(pending.epoch, pending.receipt)) {
        return step(base, 'framework', 'inventory_cancel_zero_wave', { command: 'review_inventory_cancel', payload: { storyId, reason: 'completeness-only receipt cannot enter certification' } },
          'A zero-wave completeness-only receipt never admits PRE_CERT; cancel it and open a saturated epoch.', 'inventoryRecoveryNextCommand (PRE_CERT inventory blocker)');
      }
      const apis = loadReviewInventoryAdmitApis();
      if (!apis || !isSaturatedReviewInventoryForPrecert(apis, pending, storyId)) {
        return delegated(base, 'framework', 'inventory_status_next', nextLine(String(handler('review_inventory_status')({ storyId }))) ?? '',
          `Epoch ${pending.epoch.epochId} is FINALIZED but not a saturated PRE_CERT receipt.`, 'isSaturatedReviewInventoryForPrecert + review_inventory_status Next');
      }
      // PRE_CERT admit order: cheap receipt, then open findings, then begin.
      const headHash = currentGitHead(gitCwd);
      const materialHash = currentMaterialHash(gitCwd, 'HEAD', ctx.root);
      const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', ctx.root);
      let cheap = null;
      try {
        cheap = currentPrecertCheapCheckReceipt({ currentIdentity: currentPrecertFastIdentity(ctx, storyId), data: ctx.store.readCertificationWindows(storyId),
          storyId, headHash, materialHash, storyFilesHash });
      } catch { cheap = null; }
      // Run 17: no separate fast run when the routine run the window requires executes the same plan fresh.
      if (!cheap && !precertCheapCheckWaived(ctx, storyId)) {
        return step(base, 'framework', 'precert_cheap_check', { command: 'validate', payload: { story: storyId, focus: 'fast', json: true } },
          `Saturated epoch ${pending.epoch.epochId} is finalized; certification needs a current signed fast PASS first [${PRE_CERT_CHEAP_CHECK_REQUIRED}].`, 'currentPrecertCheapCheckReceipt');
      }
      const blocking = openBlockingFindings(storyId);
      if (blocking.length > 0) {
        const ids = blocking.map(row => row.finding.id);
        return reviewFindingClosureStep(base, ids,
          `Certification refuses open verified blocking finding(s) ${ids.join(', ')} [${PRE_CERT_BLOCKING_FINDINGS_OPEN}].`,
          'unclosedBlockingFindings (PRE_CERT admit)');
      }
      // A waived cheap check: the facts date from the finalized inventory receipt instead.
      const blocked = latestBlockedAfterCheap(storyId, cheap?.createdAt ?? pending.receipt.issuedAt ?? '');
      if (blocked) return blocked;
      return step(base, 'framework', 'certification_begin', { command: 'certification_window_begin', payload: { storyId } },
        'Saturated inventory and a current fast PASS: admit the certification window now, then run the routine suite.', 'PRE_CERT admit predicates');
    }
    // No epoch for this round yet (or it was consumed/cancelled/invalidated).
    return criticPrepareStep(base,
      verdict.ok
        ? `Every required lane of round ${round} has current evidence; open the inventory epoch that certification requires (and prepare its critic when the epoch asks for one).`
        : `Round ${round} raised verified blocking finding(s); open the inventory epoch that authorizes remediation (and prepare its critic when the epoch asks for one).`,
      `evaluateReviewVerdict + ${PRE_CERT_INVENTORY_NOT_FINALIZED} precondition`, 'inventory_begin');

    /** A begin that already ran on these facts and was refused for a blocker next does not model. */
    function latestBlockedAfterCheap(id: string, cheapIssuedAt: string): NextStep | null {
      const data = ctx.store.readCertificationWindows(id);
      const window = data.windows.at(-1);
      if (!window || window.state !== 'BLOCKED' || !window.blockerCode) return null;
      if ([PRE_CERT_CHEAP_CHECK_REQUIRED, PRE_CERT_INVENTORY_NOT_FINALIZED, PRE_CERT_BLOCKING_FINDINGS_OPEN].includes(window.blockerCode)) return null;
      if (!cheapIssuedAt || (window.createdAt ?? '') < cheapIssuedAt) return null;
      const status = String(handler('certification_window_status')({ storyId: id }));
      return delegated(base, 'agent', `precert_${window.blockerCode}`, nextLine(status) ?? '',
        `certification_window_begin already refused these facts [${window.blockerCode}]: ${window.blockerDetail ?? ''}`, 'certification_window_status Next');
    }
  }

  // -- TEST ------------------------------------------------------------------

  function guidanceStep(base: { storyId: string; phase: string }, guidance: ReviewAssuranceGuidance, row: string): NextStep | null {
    const { storyId } = base;
    // Deliberate change (run 14 single-host lab): one framework step on a single host.
    const single = singleHostAssuranceReady(ctx, storyId);
    if (single.ok) {
      return step(base, 'framework', `${row}_single_host_assurance`, { command: 'quorum_submit', payload: { storyId, singleHost: true } },
        `${row}: ${guidance.reason} On a single host one step records it: probe review hosts once, the single-host-environment fallback when needed and proven, and the missing single-host rounds from the current reviewer passes of every required lane.`,
        `${row} guidance + singleHostAssuranceNeed (escalation/floor evaluators)`);
    }
    const submit = guidance.legalWriterPaths.reviewerHost.find(recipe => recipe.command.includes(' autopilot_review_submit '));
    if (submit) {
      const line = submit.command
        .replace('"$(hostname)"', JSON.stringify(hostname()))
        .replace(`"\${PROOF_OR_STOP_SESSION_ID:-local-reviewer}"`, JSON.stringify(process.env.PROOF_OR_STOP_SESSION_ID || 'local-reviewer'));
      return delegated(base, 'agent', `${row}_host_verdict`, line,
        `${row}: ${guidance.reason} Submit the next single-host PASS verdict bound to the current material (reviewer/host writer).`,
        `${row} guidance (legalWriterPaths.reviewerHost)`);
    }
    if (guidance.fallback.status === 'eligible') {
      const materialHash = guidance.currentBinding.materialHash ?? '';
      const assessment = assessReviewHostAvailabilityForFallbackEligibility(ctx.store.readProcessEvents(storyId), 'single-host-environment',
        materialHash, guidance.currentBinding.storyFilesHash);
      if (!assessment.latestFreshProbe) {
        return step(base, 'framework', `${row}_host_probe`, { command: 'review_host_availability_probe', payload: { storyId } },
          `${row}: degraded single-host fallback needs a fresh host-readiness probe for the current material.`, `${row} guidance (fallback eligible)`);
      }
      if (assessment.ok) {
        const probeId = assessment.latestFreshProbe.probeId ?? 'latest';
        return step(base, 'agent', `${row}_single_host_fallback`, { command: 'review_escalation_fallback_set', payload: { storyId, eligibility: 'single-host-environment',
          reason: `review_host_availability_probe ${probeId} found fewer than 2 review-ready canonical hosts; degraded single-host 3x1 fallback is the only available path`,
          evidenceRefs: [`process-events.jsonl:review_host_availability_probe:${probeId}`] } },
        `${row}: the probe proves a single-host environment; record the degraded fallback bound to it.`, `${row} guidance + assessReviewHostAvailabilityForFallbackEligibility`);
      }
      return step(base, 'human', `${row}_quorum_or_approval`, null,
        `${row}: ${assessment.reasons.join('; ')}. Needs a 3x2 quorum (quorum_submit with two independent hosts) or explicit human approval.`, `${row} guidance`);
    }
    return null;
  }

  function testNext(base: { storyId: string; phase: string }): NextStep {
    const { storyId } = base;
    const gitCwd = gitCwdOf(storyId);
    // Host runs first: a delivery run that finishes while the oracle is being
    // built wrote its delivery-check before sealing its terminal, so a run seen
    // terminal here is never mistaken for a missing review (no double launch).
    const hostRuns = listStoryHostRuns(ctx, storyId);
    const rows = buildDoneChecklist(storyId, ctx.store, ctx.root, { auditWriter: null, gitCwd });
    const failing = (id: string): DoneCheckRow | undefined => rows.find(row => row.id === id && row.status === 'fail' && row.blocking);

    // Review verdict first: a TEST-phase open finding sends the Story back to DEV.
    const verdictRow = failing('review-verdict');
    if (verdictRow) {
      return step(base, 'agent', 'test_review_verdict', { command: 'story_advance', payload: { storyId, phase: 'DEV' } },
        `DONE refuses the review verdict: ${verdictRow.detail ?? verdictRow.label}. Return to DEV to repair/close it (next then drives REVIEW again).`, 'buildDoneChecklist review-verdict');
    }
    const liveSmoke = evaluateOptionalLiveSmokeTranscript(ctx.store, storyId);
    if (liveSmoke.status === 'absent' || !liveSmoke.ok) {
      const command = loadConfig(ctx.root).validate?.commands?.[0];
      const capture = command && typeof command === 'object' && 'command' in command
        ? [command.command, ...((command as { args?: string[] }).args ?? [])].join(' ')
        : '<real-machine command that shows the user-visible behavior>';
      return step(base, 'agent', 'live_smoke', { command: 'live_smoke_transcript', payload: { storyId, capture, write: true } },
        liveSmoke.status === 'absent'
          ? 'Record the real-machine transcript the delivery reviewer checks (default: the project validate command; replace it with the command that shows the user-visible behavior).'
          : `The recorded live-smoke transcript does not pass (${liveSmoke.reason}); rerun it with a passing command.`,
        'evaluateOptionalLiveSmokeTranscript (DONE oracle live-smoke row)', capture.startsWith('<') ? { placeholders: ['capture'] } : {});
    }
    const delivery = failing('delivery-check');
    // Mirrors next-driver.ts (orchestration-overlap N1): metadata-only TEST rows run while the delivery reviewer works.
    const deliveryRunning = delivery ? hostRuns.filter(run => run.agentType === DELIVERY_REVIEWER && !run.terminal).at(-1) : undefined;
    if (deliveryRunning) {
      const overlap = testAuthoringStep(base, failing) ?? assuranceStep();
      if (overlap) {
        return { ...overlap, why: `${overlap.why} (Delivery reviewer run ${deliveryRunning.runId} keeps running meanwhile; this step writes only Story metadata, never reviewed material.)` };
      }
    }
    if (delivery) {
      const running = deliveryRunning;
      if (running) return waitStep(base, running, 'Delivery reviewer run');
      if (/docsPromise entries are unverified/.test(delivery.detail ?? '')) {
        return step(base, 'agent', 'delivery_unverified_promise', { command: 'story_advance', payload: { storyId, phase: 'DEV' } },
          `The delivery reviewer left docs promises unverified: ${delivery.detail}. Rework in DEV (or record a delivery_waiver_add with a >=30-char reason).`, 'buildDoneChecklist delivery-check');
      }
      const last = hostRuns.filter(run => run.agentType === DELIVERY_REVIEWER).at(-1);
      const previous = last && last.state !== 'completed' ? ` The previous delivery run ${last.runId} ended ${last.state}.` : '';
      const { selection, bound } = boundManagedSelection(hostRuns, 'managed_dispatch');
      const testEntry = (ctx.store.readStory(storyId).events ?? []).filter(event => event.phase === 'TEST').at(-1)?.timestamp ?? '';
      // Deliberate change (old-PoS run 27 delivery relaunch).
      const earlier = hostRuns.filter(run => run.agentType === DELIVERY_REVIEWER && run.createdAt >= testEntry)
        .map(run => ({ autoReplaceable: run.autoReplaceable || (run.state === 'failed' && run.replacementSafe === true) }));
      return managedLaunchStep(base, 'delivery_review_launch', { ...selection, storyId, agentType: DELIVERY_REVIEWER,
        managedDispatch: true, detach: true, json: true }, bound && targetRelaunchIsFramework(earlier),
      `DONE needs a signed, current delivery-check: ${delivery.detail ?? delivery.label}. Launch the delivery reviewer (managed shown).${previous}`, 'buildDoneChecklist delivery-check',
      earlier.length ? 'relaunch after a replacement-safe failed delivery run' : 'first run of this target');
    }
    const authoring = testAuthoringStep(base, failing);
    if (authoring) return authoring;
    const assurance = assuranceStep();
    if (assurance) return assurance;
    const recoverable = rows.find(row => row.status === 'fail' && row.blocking && ['evidence-freshness', 'done-required-validation', 'branch-synced-main'].includes(row.id));
    if (recoverable) {
      return step(base, 'framework', 'done_prepare', { command: 'done_prepare', payload: { storyId, mergeMain: true, refreshStale: true, validate: true, json: true } },
        `DONE oracle row ${recoverable.id} fails (${recoverable.detail ?? recoverable.label}); done_prepare is its ordered framework recovery.`, 'buildDoneChecklist + done_closure recovery set');
    }
    const other = rows.find(row => row.status === 'fail' && row.blocking);
    if (other) {
      return delegated(base, 'agent', `done_row_${other.id}`, other.hint ?? '', `DONE oracle row ${other.id} fails: ${other.detail ?? other.label}.`, `buildDoneChecklist ${other.id}`);
    }
    return guardStep(base, 'DONE', 'enter_done', 'Every DONE oracle row passes: advance to DONE (the framework merges the Story branch and removes the worktree).', 'buildDoneChecklist + getGuardFailureReason(DONE)');

    function assuranceStep(): NextStep | null {
      for (const id of ['review-escalation', 'review-assurance-floor'] as const) {
        if (!failing(id)) continue;
        const args = { projectRoot: ctx.root, gitCwd, storyId, store: ctx.store };
        const guidance = id === 'review-assurance-floor'
          ? buildReviewAssuranceFloorGuidance(evaluateReviewAssuranceFloor(args))
          : buildReviewEscalationGuidance(evaluateReviewEscalation(args), storyId);
        const next = guidanceStep(base, guidance, id);
        if (next) return next;
      }
      return null;
    }
  }

  function decide(storyId: string): NextStep {
    const story = ctx.store.readStory(storyId);
    const base = { storyId, phase: story.phase };
    switch (story.phase) {
      case 'PLAN':
        // Deliberate change (run 14 single-host lab): PLAN names the DEV-entry steps.
        if (!evaluateDevMemoryPreflightGate(storyId, ctx.store)) {
          return step(base, 'agent', 'dev_memory_preflight_ack', { command: 'dev_memory_preflight_ack', payload: { storyId } },
            'The DEV-entry gate refuses without the dev-memory preflight acknowledgement [missing_dev_memory_preflight_ack]. Run it now and read the lessons it prints before planning the implementation.',
            'evaluateDevMemoryPreflightGate (DEV-entry gate)');
        }
        {
          // Deliberate change (run 16 scope-check-required lab): the scope-plan reviewer
          // verdict the DEV-entry gate requires is launched (or waited on) before DEV.
          // Deliberate change (run 19 plan-author-before-scope lab): the deterministic PLAN
          // blockers come first as one authoring batch (preScopeAuthoringStep, shared), and a
          // verdict that must be rerun (scopePlanRerunReason) is relaunched here as well.
          const policy = policyOf(storyId);
          const scopeFailure = missingPlanScopeCheckFailure(ctx.store, story, policy);
          const rerun = scopeFailure ? null : scopePlanRerunReason(ctx.store, story, ctx.root);
          if (scopeFailure || rerun) {
            const hostRuns = listStoryHostRuns(ctx, storyId);
            const running = hostRuns.filter(run => run.agentType === SCOPE_PLAN_REVIEWER && !run.terminal).at(-1);
            if (running) return waitStep(base, running, 'Scope-plan reviewer run');
            const authoring = preScopeAuthoringStep(base, planPreScopeBlockers(ctx.store, story, policy), ctx.store.readChecklist(storyId).items);
            if (authoring) return authoring;
            const last = hostRuns.filter(run => run.agentType === SCOPE_PLAN_REVIEWER).at(-1);
            const previous = last && last.state !== 'completed' ? ` The previous scope-plan run ${last.runId} ended ${last.state}.` : '';
            const { selection, bound } = boundManagedSelection(hostRuns, 'managed_dispatch');
            const scopeRuns = hostRuns.filter(run => run.agentType === SCOPE_PLAN_REVIEWER);
            let streakStart = scopeRuns.length;
            while (streakStart > 0 && scopeRuns[streakStart - 1]!.autoReplaceable) streakStart -= 1;
            const autoStreak = scopeRuns.slice(streakStart);
            const auto = autoStreak.length > 0
              ? bound && targetRelaunchIsFramework(autoStreak)
              : scopePlanLaunchIsFramework({ bound, rerun: Boolean(rerun), last, verdict: ctx.store.readScopeCheck(storyId) });
            return managedLaunchStep(base, 'scope_plan_review_launch', { ...selection, storyId,
              agentType: SCOPE_PLAN_REVIEWER, managedDispatch: true, detach: true, json: true }, auto,
            scopeFailure
              ? `${scopeFailure.split('\n')[0]} Launch the scope-plan reviewer (managed shown); it saves scope-check.json, then rerun story_review.${previous}`
              : `The scope-plan verdict must be rerun: ${rerun}. Relaunch the scope-plan reviewer so it judges the current checklist (managed shown); it saves a new scope-check.json, then rerun story_review.${previous}`,
            scopeFailure ? 'missingPlanScopeCheckFailure (DEV-entry gate)' : 'scopePlanRerunReason (story_review scope_gap / scope_check_stale)',
            scopeFailure ? 'first run of this target' : 'relaunch after the completed run that delivered the stale verdict');
          }
        }
        {
          const authoring = planAuthoringStep(ctx.store, base);
          if (authoring) return authoring;
        }
        return guardStep(base, 'DEV', 'enter_dev', 'PLAN is complete: the DEV-entry gate admits the Story.', 'getGuardFailureReason(DEV)');
      case 'DEV': return devNext(base);
      case 'REVIEW': return reviewNext(base);
      case 'TEST': return testNext(base);
      // Deliberate change (old-PoS run 27 owner tail): DONE is an explicit terminal statement.
      case 'DONE': return step(base, 'human', 'story_done', null, `Story ${storyId} is DONE; nothing is left in its lifecycle. ${DONE_TERMINAL_STATEMENT}`, 'story.phase', { done: true });
      default:
        return step(base, 'agent', 'phase_outside_driver', { command: 'session_brief', payload: { concise: true } },
          `next --storyId drives PLAN→DONE; ${story.phase} is authored work (INIT): follow session_brief.`, 'story.phase');
    }
  }

  return { decide };
}
