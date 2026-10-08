/**
 * `proof-or-stop next --storyId=<id> [--json] [--run]` — the framework drives
 * the owner through PLAN → DEV → REVIEW → PRE_CERT → TEST → DONE one step at a time.
 *
 * Read-only by default. From the Story's current state it returns exactly one
 * next step: {phase, kind, reason, command, argv, cli, why, source}.
 *   - kind 'framework': a mechanical step the framework could run itself
 *     (`--run` executes these, each through the real CLI, and prints the next);
 *   - kind 'agent': needs the agent (implement/repair code, launch a managed
 *     reviewer, author a summary/decision/resolution, submit a host verdict);
 *   - kind 'human': a genuine human decision (stall resume, approval, ...).
 *
 * It never re-implements a gate. Every decision reads the gate's own
 * predicate or reader and, where the gate prints its own next command,
 * delegates to that text:
 *   DEV     checklist status, unclosedBlockingFindings (core/finding-closure),
 *           managedFindingRepairState (a finding is repaired only by a completed
 *           managed finding-repair run bound to its id, with a material commit),
 *           evaluateEvidenceChainForStory (the DEV→REVIEW evidence-chain gate),
 *           getGuardFailureReason(REVIEW) (the xstate guard);
 *   REVIEW  reviewer_batch (lane classification the REVIEW gate rows use),
 *           evaluateReviewVerdict, review_inventory_status (its Next line),
 *           finalizedUnconsumedReviewInventory / isSaturatedReviewInventoryForPrecert
 *           (the PRE_CERT admit predicates), currentPrecertCheapCheckReceipt,
 *           certification_window_status (its Next line), getGuardFailureReason(TEST);
 *   TEST    buildDoneChecklist (the DONE oracle rows, auditWriter:null) and the
 *           review-assurance floor / escalation guidance recipes.
 *   PLAN    evaluateDevMemoryPreflightGate, missingPlanScopeCheckFailure /
 *           scopePlanRerunReason (the scope-plan reviewer launch / relaunch /
 *           wait, after planPreScopeBlockers are authored), then
 *           getGuardFailureReason(DEV);
 *   TEST single host: singleHostAssuranceReady (handlers/quorum-submit.ts) over
 *           the same escalation / floor evaluators → quorum_submit singleHost.
 * Host runs (managed reviewers, delivery, finding repair) are read from the
 * managed host-run runtime projection only.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { HandlerContext } from './context.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import { loadConfig, resetConfigCache } from '../core/config.js';
import { resolveWorkflowPolicy } from '../core/workflow-policy.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { withGitTreeObservation } from '../core/git-tree-observation.js';
import { evaluateDevMemoryPreflightGate, evaluateReviewVerdict, getGuardFailureReason } from '../core/machine.js';
import { missingPlanScopeCheckFailure, SCOPE_PLAN_REVIEWER, scopePlanLaunchIsFramework, scopePlanRerunReason } from '../core/plan-scope-check-requirement.js';
import { hasPreScopeBlockers, planPreScopeBlockers, type PreScopeBlockers } from '../core/plan-pre-scope-blockers.js';
import { pendingScopePlanRun, scopeVerdictReviewEntryFailure } from '../core/scope-plan-deferral.js';
import { STORY_FOCUSED_CLASSIFICATION } from '../core/verification-intent-classification.js';
import { VERIFICATION_LANES } from '../core/verification.js';
import { isTerminalChecklistStatus } from '../core/checklist-status.js';
import { unclosedBlockingFindings, resolveEffectiveBlockingSeverities, FINDING_RESOLUTION_PLACEHOLDER } from '../core/finding-closure.js';
import { findingDuplicateOf, duplicateCoverageReceipts, duplicateOfOpenCanonical, duplicateResolveCandidate } from '../core/duplicate-finding-coverage.js';
import {
  currentOpenReviewInventory,
  finalizedUnconsumedReviewInventory,
  isInventoryCompletenessOnlyReceipt,
  reviewInventoryPurposeBinding,
} from '../core/review-inventory-epoch.js';
import {
  currentPrecertCheapCheckReceipt,
  isSaturatedReviewInventoryForPrecert,
  loadReviewInventoryAdmitApis,
  inspectCertificationWindowLineage,
  windowAuthorizesHeavyCertification,
  PRE_CERT_CHEAP_CHECK_REQUIRED,
  PRE_CERT_INVENTORY_NOT_FINALIZED,
  PRE_CERT_BLOCKING_FINDINGS_OPEN,
} from '../core/certification-window.js';
import { currentCertificationIdentity } from './certification-window.js';
import { currentPrecertFastIdentity, precertCheapCheckWaived } from './validation-identity.js';
import { evaluateEvidenceChainForStory } from './evidence-chain.js';
import type { EvidenceChainReport } from '../core/evidence-chain-check.js';
import { checklistHasFileDeclarations } from './phase-gates.js';
import { collectReviewerEvidenceState, verifyCurrentReviewerDispatchBinding } from '../core/review-run.js';
import { managedHostRunsRoot, readManagedHostRunProjection, readManagedHostRunBinding, managedHostRunReceipt, verifyManagedDispatchDelivery, isAutoReplaceableManagedLaunchFailure, MANAGED_AUTO_RELAUNCHES_PER_TARGET } from '../core/managed-host-run.js';
import { isMaterialExcludedPath } from '../core/material-path-policy.js';
import { hasPersistedManagedReceiptEvidence, refusedManagedReviewImport } from './managed-review-evidence.js';
import { MANAGED_INVENTORY_CRITIC_LANE } from '../core/managed-inventory-critic.js';
import { QUALIFIED_MANAGED_REVIEWER_DEFAULTS } from '../core/managed-reviewer-qualification.js';
import { REQUIRED_INIT_CHECK_AGENTS, initCheckAgentResults, invalidInitReviewerDeliveries, missingRequiredInitCheckAgents, recomputeInitCheckHash } from '../core/init-check-gate.js';
import { buildDoneChecklist, type DoneCheckRow } from '../core/done-oracle.js';
import { evaluateReviewAssuranceFloor, buildReviewAssuranceFloorGuidance, buildReviewEscalationGuidance, type ReviewAssuranceGuidance } from '../core/review-assurance-floor.js';
import { evaluateReviewEscalation, assessReviewHostAvailabilityForFallbackEligibility } from '../core/review-escalation.js';
import { evaluateOptionalLiveSmokeTranscript } from '../core/live-smoke-transcript-evidence.js';
import { singleHostAssuranceReady } from './quorum-submit.js';
import type { ChecklistItem, ReviewRun } from '../core/types.js';
import { commitMessageNamesFinding, implementationGroupingFiles, itemDeclaredFiles, remediationGroupingSingle, sharedFileItemGroup } from '../core/ab-dispatch-grouping.js';
import { ownerWaitBlockMs, ownerWaitInstruction } from '../core/owner-wait-guidance.js';
import { parseIntentConflicts, type IntentConflict } from '../core/request-authority.js';
import { acceptanceIntentHash } from '../core/verification-intent-amendment.js';

type HandlerLookup = (name: string) => ((...args: any[]) => any) | undefined;

/** evaluateReviewVerdict codes that mean a required lane still lacks valid current-round evidence. */
const LANE_VERDICT_CODES = new Set(['review_evidence_missing', 'review_lane_missing', 'review_evidence_invalid', 'review_quorum']);

export const NEXT_STEP_SCHEMA = 'proof-or-stop.next_step.v1';
export const DELIVERY_REVIEWER = 'proof-or-stop-review-delivery';
export const FINDING_REPAIR_AGENT = 'proof-or-stop-finding-repair';
export const IMPLEMENTER_AGENT = 'proof-or-stop-implementer';
export const DUPLICATE_COVERAGE_COMMAND_PLACEHOLDER = "<command that runs this finding's own case>";
export const DUPLICATE_COVERAGE_SELECTOR_PLACEHOLDER = '<output line its passing run prints>';
export const DUPLICATE_RESOLUTION_PLACEHOLDER = '<why the canonical repair fixes this case>';

export type NextStepKind = 'agent' | 'framework' | 'human';

export interface NextStep {
  schemaVersion: typeof NEXT_STEP_SCHEMA;
  storyId: string;
  phase: string;
  kind: NextStepKind;
  /** Stable machine code for the step, e.g. review_lane_launch. */
  reason: string;
  /** One pasteable POSIX shell line, or null when nothing is left to run. */
  command: string | null;
  /** Exact argv of the same call: ['proof-or-stop', <command>, <JSON payload>]. */
  argv: string[] | null;
  /** The same call as {command, payload}. */
  cli: { command: string; payload: Record<string, unknown> } | null;
  /** Payload fields the agent must author before running (values are '<...>' placeholders). */
  placeholders?: string[];
  /** Why this is the next step, in one or two sentences. */
  why: string;
  /** Which gate predicate / reader decided (delegation audit). */
  source: string;
  /** One-line description of each placeholder's expected content (path -> text), so no --help read is needed. */
  placeholderHints?: Record<string, string>;
  /** True for a blocking wait on a detached managed run. */
  wait?: boolean;
  /**
   * True for a managed launch whose command needs no agent judgment: the
   * host/model/effort are the owner's own earlier selection for this Story,
   * the payload has no placeholder, and no earlier run of the same target
   * exists (a relaunch after a failure stays the agent's call). `--run`
   * executes it (kind 'framework').
   */
  launch?: boolean;
  /** Authoring commands the agent runs together in one turn (the first is also command/argv/cli). */
  batch?: NextStepCall[];
  /**
   * N2 (v4.1 cost plan): independent launches run CONCURRENTLY, each in its own
   * process with exactly the command it would have alone (the first is also
   * command/argv/cli). `--run` spawns them together; an agent runs them all
   * before the next `next`.
   */
  parallel?: NextStepCall[];
  /** Optional commands that may precede the batch (e.g. dev_memory_capture before decision=captured). */
  optional?: NextStepCall[];
  /** True once the Story is DONE. */
  done?: boolean;
}

/** One exact command of a batch step. */
export interface NextStepCall {
  reason: string;
  command: string;
  argv: string[];
  cli: { command: string; payload: Record<string, unknown> };
  placeholders?: string[];
  placeholderHints?: Record<string, string>;
}

interface NextArgs { storyId?: string; json?: boolean; run?: boolean; maxSteps?: number; waitBudgetMs?: number; concise?: boolean }

// ---------------------------------------------------------------------------
// Command rendering / parsing

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * One-line descriptions of authoring placeholders, keyed `<command>.<payload path>`
 * (Q6, run 17: the owner read 17 --help pages, 3.36M tokens replayed). A
 * placeholder without an entry is described by its own '<...>' text.
 */
const PLACEHOLDER_HINTS: Record<string, string> = {
  'finding_resolve.resolution': 'the repair commit (short sha) and the focused test that now passes, e.g. "commit abc1234 adds TestX; go test ./pkg -run TestX passes"',
  'finding_resolve.coverage.command': "an allowlisted command (executable + argv, no shell) that runs THIS finding's own case, e.g. go test -v ./pkg -run TestX",
  'finding_resolve.coverage.selector': 'the exact line its passing output prints for that case, e.g. --- PASS: TestX (not a generic ok/PASS)',
  'dev_memory_finish_decision.decision': 'captured (after dev_memory_capture), no-reusable-lesson, or defer-with-reason',
  'dev_memory_finish_decision.reason': 'one sentence (>=5 chars): the lesson captured, or why there is no reusable lesson',
  'summary_set.changes': 'what changed, per file, from the user perspective (>=10 chars)',
  'summary_set.usage': 'how to use it: a command or call example (>=10 chars)',
  'summary_set.expectedOutcome': 'the user-visible result or transcript you expected (>=10 chars)',
  'summary_set.actualTranscript': 'the user-visible output actually observed, e.g. the live-smoke transcript summary (>=10 chars)',
  'summary_set.outcomeDiff': 'expected vs actual difference; write "no difference" when none (>=5 chars)',
  'summary_set.limitations': 'known limitations or deviations, or "none — fully covered"',
  'summary_set.pitfalls': 'where it got stuck, retries, what the next person should know (>=10 chars)',
  'live_smoke_transcript.capture': 'a real-machine shell command, run in the Story worktree, that shows the user-visible behavior',
  'dev_memory_capture.category': 'one of failure-mode, pattern, anti-pattern, workflow, tool-quirk, guard-bypass, debugging, communication, other',
  'dev_memory_capture.summary': 'one-sentence lesson summary (>=10 chars)',
  'dev_memory_capture.trigger': 'the situation that triggers the lesson (>=5 chars)',
  'dev_memory_capture.lesson': 'the reusable lesson itself (>=10 chars)',
  'dev_memory_capture.reusePrompt': 'how a later session should find it, e.g. a search query (>=5 chars)',
  'decision_set.principles': 'JSON array of 3-5 design principles',
  'decision_set.drivers': 'JSON array of the top 3 constraints',
  'decision_set.options': 'JSON array of >=2 {name, pros[], cons[]} options',
  'decision_set.chosen': 'the chosen option name (one of options[].name)',
  'decision_set.rationale': 'why that option (>=10 chars)',
  'decision_set.preMortem': 'JSON array of >=3 {scenario, trigger, consequence, mitigation} failure scenarios',
  'plan_set.content': 'the full plan.md: one "## CHK-xxx" section per checklist item with steps, files and verification',
  'checklist_update.verificationIntent': 'the item\'s complete revised verificationIntent JSON (happy/edge/adversarial rows, pins kept): the conflicting row states the value the request implies, or, if the intent is right, the derivation from the request sentence',
  'checklist_update.reason': 'why the intent changes (>=30 chars): the request sentence and the value it implies',
};

function valueAtPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(/\.|\[(\d+)\]/).filter(segment => segment !== undefined && segment !== '')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * One-line description per placeholder path of a command payload: the curated
 * text for `<command>.<top-level field>`, else the placeholder's own '<...>'
 * text (gate templates write their expectation there).
 */
export function placeholderHintsFor(command: string, payload: Record<string, unknown>, placeholders: readonly string[]): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const path of placeholders) {
    const curated = PLACEHOLDER_HINTS[`${command}.${path}`] ?? PLACEHOLDER_HINTS[`${command}.${path.split(/[.[]/)[0]}`];
    const raw = valueAtPath(payload, path);
    const inner = typeof raw === 'string' ? (raw.match(/<([^>]+)>/)?.[1] ?? raw.match(/\{([a-z][^}]*)\}/)?.[1]) : undefined;
    hints[path] = curated ?? inner ?? 'author this value';
  }
  return hints;
}

export function step(
  base: { storyId: string; phase: string },
  kind: NextStepKind,
  reason: string,
  call: { command: string; payload: Record<string, unknown> } | null,
  why: string,
  source: string,
  extra: Partial<Pick<NextStep, 'wait' | 'done' | 'placeholders' | 'launch' | 'batch' | 'optional' | 'parallel'>> = {},
): NextStep {
  const payload = call ? JSON.stringify(call.payload) : '';
  return {
    schemaVersion: NEXT_STEP_SCHEMA,
    storyId: base.storyId,
    phase: base.phase,
    kind,
    reason,
    command: call ? `proof-or-stop ${call.command} ${shellQuote(payload)}` : null,
    argv: call ? ['proof-or-stop', call.command, payload] : null,
    cli: call,
    ...(extra.placeholders?.length ? { placeholders: extra.placeholders } : {}),
    ...(call && extra.placeholders?.length ? { placeholderHints: placeholderHintsFor(call.command, call.payload, extra.placeholders) } : {}),
    why,
    source,
    ...(extra.wait ? { wait: true } : {}),
    ...(extra.launch ? { launch: true } : {}),
    ...(extra.batch?.length ? { batch: extra.batch } : {}),
    ...(extra.parallel && extra.parallel.length > 1 ? { parallel: extra.parallel } : {}),
    ...(extra.optional?.length ? { optional: extra.optional } : {}),
    ...(extra.done ? { done: true } : {}),
  };
}

/** One exact command of a batch step, placeholders detected from the payload. */
export function nextStepCall(reason: string, call: { command: string; payload: Record<string, unknown> }): NextStepCall {
  const payload = JSON.stringify(call.payload);
  const placeholders = placeholderPaths(call.payload);
  return {
    reason,
    command: `proof-or-stop ${call.command} ${shellQuote(payload)}`,
    argv: ['proof-or-stop', call.command, payload],
    cli: call,
    ...(placeholders.length ? { placeholders, placeholderHints: placeholderHintsFor(call.command, call.payload, placeholders) } : {}),
  };
}

/**
 * Several authoring commands as ONE agent step (Q6 (b), run 17: TEST surfaced
 * the finish decision and the summary one `next --run` at a time). The first
 * call is also the step's command/argv/cli; `batch` lists every call in order.
 */
export function batchStep(base: { storyId: string; phase: string }, reason: string, calls: NextStepCall[], why: string, source: string,
  optional: NextStepCall[] = []): NextStep {
  const first = calls[0]!;
  return step(base, 'agent', reason, first.cli, why, source, { placeholders: first.placeholders, batch: calls, optional });
}

/**
 * A managed host_run launch. Fully bound (the owner's own earlier
 * host/model/effort, no placeholder, first run of its target) it is a
 * framework step `--run` executes; otherwise the agent's.
 */
export function managedLaunchStep(base: { storyId: string; phase: string }, reason: string, payload: Record<string, unknown>,
  auto: boolean, why: string, source: string, boundNote = 'first run of this target'): NextStep {
  const bound = auto && placeholderPaths(payload).length === 0;
  return step(base, bound ? 'framework' : 'agent', reason, { command: 'host_run', payload },
    bound ? `${why} Fully bound (this Story's own host/model/effort, ${boundNote}): \`next --run\` launches it.` : why,
    source, bound ? { launch: true } : {});
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
export function parseHintedCommand(line: string): { command: string; payload: Record<string, unknown> } | null {
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

/**
 * Payload paths whose string value is an authoring placeholder ('<...>' or
 * '{name}'), nested objects and arrays included (e.g. evidences[0].command).
 */
export function placeholderPaths(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return /<[^>]+>|\{[a-z][^}]*\}/.test(value) && path ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => placeholderPaths(entry, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => placeholderPaths(entry, path ? `${path}.${key}` : key));
  }
  return [];
}

/**
 * A gate's own printed next command as a step. A command with placeholders is
 * never a framework step, whatever the caller asked for: the agent authors the
 * values, and `next --run` must never execute '<...>' literally (run 16: an
 * evidence bind with a test chosen by the framework). Human-only commands are
 * human steps.
 */
export function hintedStep(base: { storyId: string; phase: string }, kind: NextStepKind, reason: string, hint: string, why: string, source: string): NextStep {
  const call = parseHintedCommand(hint);
  const placeholders = call ? placeholderPaths(call.payload) : [];
  const humanNeeded = /story_resume|scope_budget_approve|acceptance_amendment_(approve|review)/.test(hint);
  return step(base, humanNeeded ? 'human' : placeholders.length ? 'agent' : kind, reason, call, call ? why : `${why} Gate guidance: ${hint}`, source, { placeholders });
}

const EVIDENCE_CHAIN_SOURCE = 'evaluateEvidenceChainForStory (DEV→REVIEW evidence-chain gate)';

/**
 * The DEV evidence-chain step: the chain's one next action. For intents
 * without a pin it is the agent's batch (which test proves which intent is a
 * judgment), and why carries each intent's ranked candidate tests.
 */
export function evidenceChainStep(base: { storyId: string; phase: string }, chain: EvidenceChainReport, why: string): NextStep {
  const choosing = chain.issues.filter(issue => issue.nextAction === chain.nextAction && issue.candidates);
  const guidance = choosing.length
    ? ` Which test proves which intent is your judgment: for each intent pick the test that exercises it (or name another), then author command, selector and note; never bind a test that does not exercise the intent. ${choosing.map(issue => issue.detail).join(' ')}`
    : '';
  return hintedStep(base, 'framework', 'evidence_chain', chain.nextAction ?? '', `${why}${guidance}`.slice(0, 6000), EVIDENCE_CHAIN_SOURCE);
}

/** Non-blocking evidence-chain items, as one sentence appended to the step that follows DEV work. */
export function evidenceChainAdvisory(chain: EvidenceChainReport): string {
  const advisory = chain.issues.filter(issue => !issue.blocking && issue.nextAction.includes('proof-or-stop verification_evidence_'));
  if (!advisory.length) return '';
  return ` Advisory (evidence chain, not blocking): ${advisory.slice(0, 5).map(issue => issue.detail).join('; ')}${advisory.length > 5 ? `; +${advisory.length - 5} more` : ''}. If a changed test proves an unpinned intent, bind it with the template pre_review_check prints; otherwise no action.`;
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

export interface HostRunView {
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
  /**
   * Failed before its recovery supervisor became ready, or its provider stalled
   * without leaving work product: replacing it is mechanical
   * (isAutoReplaceableManagedLaunchFailure).
   */
  autoReplaceable: boolean;
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
        autoReplaceable: isAutoReplaceableManagedLaunchFailure({ state: run.state, replacementSafe: run.replacementSafe, terminalReason: run.terminal?.reason ?? null }) });
    } catch { /* not a readable managed run */ }
  }
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId));
}

/** One managed finding-repair run, as the next-driver host-run views list it. */
export interface FindingRepairRunView { runId: string; agentType: string; terminal: boolean; state: string; createdAt: string }

export type FindingRepairState =
  | { repaired: true; runId: string; commit: string }
  | { repaired: false; detail: string; /** a managed finding-repair run is bound to this finding (any state) */ bound: boolean };

/**
 * Whether ONE verified finding is repaired and ready for finding_resolve, from
 * the records its repair path writes, never from a global material change (run
 * 14: with several open findings, the repair of one changes the material of
 * all). Repaired means: a managed finding-repair run whose immutable binding
 * targets exactly this finding id (managedDispatchTarget.findingId), created
 * after the finding was raised, completed as a safe delivery
 * (verifyManagedDispatchDelivery), and committed material on the Story branch
 * while it ran (a commit reachable from HEAD, committed inside the run's
 * window, touching a non-metadata path). This only chooses the next step;
 * finding_resolve still checks its own evidence.
 */
export function managedFindingRepairState(args: {
  root: string; gitCwd: string; storyId: string; finding: { id: string; createdAt?: string }; runs: readonly FindingRepairRunView[];
}): FindingRepairState {
  const { root, gitCwd, storyId, finding } = args;
  // remediation.grouping=single (adopted default; off under the per-finding
  // rollback): a grouped run also binds the other members of its
  // groupFindingIds (core/ab-dispatch-grouping.ts). Every member, the bound one
  // included, counts as repaired only by a commit in the run's window naming it.
  const grouping = args.runs.some(run => run.agentType === FINDING_REPAIR_AGENT) && remediationGroupingSingle(root);
  const groupOf = new Map<string, { primary: string; members: string[] }>();
  const bound = args.runs.filter(run => run.agentType === FINDING_REPAIR_AGENT && (!finding.createdAt || run.createdAt >= finding.createdAt))
    .filter(run => {
      try {
        const target = readManagedHostRunBinding(root, run.runId).managedDispatchTarget as { findingId?: string; groupFindingIds?: string[] } | null | undefined;
        if (grouping && target?.findingId && Array.isArray(target.groupFindingIds) && target.groupFindingIds.includes(finding.id)) {
          groupOf.set(run.runId, { primary: target.findingId, members: target.groupFindingIds });
          return true;
        }
        return target?.findingId === finding.id;
      } catch { return false; }
    });
  if (bound.length === 0) return { repaired: false, bound: false, detail: `no managed finding-repair run is bound to ${finding.id}` };
  const completed = bound.filter(run => run.terminal && run.state === 'completed').reverse();
  for (const run of completed) {
    const group = groupOf.get(run.runId);
    if (group) {
      const grouped = groupedRepairCommit(root, gitCwd, storyId, finding.id, group.primary, run);
      if (grouped) return { repaired: true, runId: run.runId, commit: grouped };
      continue;
    }
    if (!verifyManagedDispatchDelivery({ root, runId: run.runId, storyId, agentType: FINDING_REPAIR_AGENT, findingId: finding.id }).valid) continue;
    let terminalAt: string | undefined;
    try { terminalAt = readManagedHostRunProjection(root, run.runId).terminal?.terminalAt; } catch { terminalAt = undefined; }
    const since = Math.floor(Date.parse(run.createdAt) / 1000);
    const until = Math.ceil(Date.parse(terminalAt ?? '') / 1000);
    if (!Number.isFinite(since) || !Number.isFinite(until)) continue;
    let log = '';
    try {
      log = execFileSync('git', ['log', `--max-age=${since}`, `--min-age=${until}`, '--format=%x00%H', '--name-only', 'HEAD'],
        { cwd: gitCwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { continue; }
    for (const block of log.split('\0').filter(Boolean)) {
      const [commit, ...paths] = block.split('\n').map(row => row.trim()).filter(Boolean);
      if (commit && paths.some(path => !isMaterialExcludedPath(path, root))) return { repaired: true, runId: run.runId, commit };
    }
  }
  const last = bound.at(-1)!;
  return { repaired: false, bound: true, detail: completed.length
    ? `managed finding-repair run ${completed[0]!.runId} for ${finding.id} completed without a material commit on the Story branch`
    : `the last managed finding-repair run ${last.runId} for ${finding.id} is ${last.state}` };
}

/**
 * managedFindingRepairState of one finding of a Story, from that Story's own
 * managed runs and Git work tree (the finding_resolve batch re-check, old-PoS
 * run 24 F4: the same per-finding rule next uses to propose the step).
 */
export function storyFindingRepairState(ctx: HandlerContext, storyId: string, finding: { id: string; createdAt?: string }): FindingRepairState {
  return managedFindingRepairState({ root: ctx.root, storyId, finding, runs: listStoryHostRuns(ctx, storyId),
    gitCwd: resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root }) });
}

/**
 * remediation.grouping=single (adopted default): the commit by which a grouped
 * finding-repair run demonstrably repaired `findingId` — a material commit made
 * inside the run's window whose message names the finding id — or null.
 */
// ---------------------------------------------------------------------------
// Intent conflicts (old-PoS run 23, request-outranks-intent D1)

/** Bytes read from the end of a managed run's retained output to find its final message. */
const FINAL_MESSAGE_TAIL_BYTES = 256 * 1024;

/**
 * The last assistant message of a managed run, from its retained provider
 * output (live-output.jsonl): codex `item.completed` agent_message, claude
 * `result`. Implementer / finding-repair results are prose, so the managed
 * final-result scanner (built for review JSON envelopes) does not keep them.
 * Null when the output is unavailable.
 */
export function managedRunFinalMessage(root: string, runId: string): string | null {
  const path = join(managedHostRunsRoot(root), runId, 'live-output.jsonl');
  let raw: string;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - FINAL_MESSAGE_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(path, 'r');
    try { readSync(fd, buffer, 0, buffer.length, start); } finally { closeSync(fd); }
    raw = buffer.toString('utf8');
    if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
  } catch {
    return null;
  }
  let stdout = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const frame = JSON.parse(line) as { stream?: string; text?: string };
      if (frame.stream === 'stdout' && typeof frame.text === 'string') stdout += frame.text;
    } catch { /* a partial frame at the tail boundary */ }
  }
  let last: string | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: unknown }; result?: unknown };
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') last = event.item.text;
      else if (event.type === 'result' && typeof event.result === 'string') last = event.result;
    } catch { /* not a provider event */ }
  }
  return last;
}

/** One declared (or prose-only) intent conflict of a terminal implementer / finding-repair run that is not amended yet. */
export interface OpenIntentConflict { runId: string; agentType: string; createdAt: string; itemId: string; conflict: IntentConflict }

/**
 * acceptanceIntentHash of an item's verificationIntent in the newest commit of
 * checklist.json made before `before` (the intent the run was dispatched
 * against; intents are frozen in DEV). Undefined when no such commit exists.
 */
function committedIntentHashBefore(root: string, gitCwd: string, checklistPath: string, itemId: string, before: string): string | null | undefined {
  try {
    const rel = relative(root, checklistPath);
    const sha = execFileSync('git', ['log', '-1', '--format=%H', `--before=${before}`, '--', rel], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!sha) return undefined;
    const text = execFileSync('git', ['show', `${sha}:${rel}`], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    const item = (JSON.parse(text) as { items?: ChecklistItem[] }).items?.find(row => row.id === itemId);
    return item?.verificationIntent ? acceptanceIntentHash(item.verificationIntent) : null;
  } catch {
    return undefined;
  }
}

/**
 * Every `[intent-conflict]` a terminal managed implementer or finding-repair
 * run declared (or a deliberate deviation it stated only in prose) whose item
 * intent was not amended since that run was dispatched. Amended = the item's
 * current verificationIntent differs from the committed one the run was
 * dispatched against (the audited PLAN revision); without such a commit, a
 * later implementer run of the same item counts. A conflict naming no checklist
 * item cannot be routed and is skipped.
 */
export function openIntentConflicts(args: { root: string; gitCwd: string; store: HandlerContext['store']; storyId: string;
  runs: readonly Pick<HostRunView, 'runId' | 'agentType' | 'terminal' | 'createdAt'>[] }): OpenIntentConflict[] {
  const writers = args.runs.filter(run => run.terminal && (run.agentType === IMPLEMENTER_AGENT || run.agentType === FINDING_REPAIR_AGENT));
  if (writers.length === 0) return [];
  const boundItem = (runId: string): string | null => {
    try { return readManagedHostRunBinding(args.root, runId).managedDispatchTarget?.itemId ?? null; } catch { return null; }
  };
  const reports = writers.map(run => ({ run, bound: run.agentType === IMPLEMENTER_AGENT ? boundItem(run.runId) : null }))
    .map(row => ({ ...row, report: parseIntentConflicts(managedRunFinalMessage(args.root, row.run.runId), row.bound) }))
    .filter(row => row.report.conflicts.length > 0);
  if (reports.length === 0) return [];
  const items = args.store.readChecklist(args.storyId).items;
  const checklistPath = args.store.storyFilePath(args.storyId, 'checklist.json');
  const open: OpenIntentConflict[] = [];
  for (const { run, report } of reports) {
    for (const conflict of report.conflicts) {
      const item = items.find(row => row.id === conflict.itemId);
      if (!item) continue;
      const current = item.verificationIntent ? acceptanceIntentHash(item.verificationIntent) : null;
      const atDispatch = committedIntentHashBefore(args.root, args.gitCwd, checklistPath, item.id, run.createdAt);
      const amended = atDispatch !== undefined
        ? atDispatch !== current
        : writers.some(other => other.agentType === IMPLEMENTER_AGENT && other.createdAt > run.createdAt && boundItem(other.runId) === item.id);
      if (!amended) open.push({ runId: run.runId, agentType: run.agentType, createdAt: run.createdAt, itemId: item.id, conflict });
    }
  }
  return open;
}

function describeIntentConflict(row: OpenIntentConflict): string {
  const { conflict } = row;
  const who = `${row.agentType === IMPLEMENTER_AGENT ? 'implementer' : 'finding-repair'} run ${row.runId}`;
  if (conflict.undeclared) {
    return `${who} stated a deliberate deviation for ${row.itemId} only in prose, without an [intent-conflict] entry: "${conflict.raw}"`;
  }
  return `${who}: ${conflict.intentRef}: the request${conflict.requestSentence ? ` ("${conflict.requestSentence}")` : ''} implies ${conflict.requestImplies ?? '(not stated)'}, the intent pins ${conflict.intentPins ?? '(not stated)'}`;
}

/**
 * D1: a declared intent conflict blocks the item before anything else. Intents
 * are frozen in DEV (checklist_update refuses verificationIntent there), so the
 * owner returns to PLAN (one command); in PLAN, `next` proposes the audited
 * revision of the first conflicting item.
 */
export function intentConflictStep(base: { storyId: string; phase: string }, conflicts: readonly OpenIntentConflict[]): NextStep {
  const listed = conflicts.map(describeIntentConflict).join('; ');
  if (base.phase === 'PLAN') {
    const itemId = conflicts[0]!.itemId;
    return step(base, 'agent', 'intent_conflict_amend', { command: 'checklist_update',
      payload: { storyId: base.storyId, itemId, verificationIntent: '<complete revised verificationIntent JSON>', reason: '<why: the request sentence and the value it implies>', status: 'pending' } },
    `Open intent conflict (${listed}). The request outranks the intent: revise ${itemId}'s verificationIntent so the conflicting row states the value the request implies (if the intent is right, make the row state its derivation from the request sentence), with a reason; status pending makes DEV implement the item again. Then continue PLAN with next.`,
    'openIntentConflicts (implementer/finding-repair [intent-conflict] section) + checklist_update PLAN intent revision',
    { placeholders: ['verificationIntent', 'reason'] });
  }
  return step(base, 'agent', 'intent_conflict', { command: 'story_advance', payload: { storyId: base.storyId, phase: 'PLAN' } },
    `Intent conflict declared (${listed}). The request outranks the intent, and the item does not count done until the owner amends the intent. Intents are frozen in DEV: return to PLAN, where next proposes the audited revision (checklist_update verificationIntent + reason, item back to pending).`,
    'openIntentConflicts (implementer/finding-repair [intent-conflict] section)');
}

function groupedRepairCommit(root: string, gitCwd: string, storyId: string, findingId: string, primaryId: string,
  run: FindingRepairRunView): string | null {
  if (!verifyManagedDispatchDelivery({ root, runId: run.runId, storyId, agentType: FINDING_REPAIR_AGENT, findingId: primaryId,
    ...(primaryId === findingId ? {} : { groupMemberFindingId: findingId }) }).valid) return null;
  for (const commit of managedRunWindowCommits(root, gitCwd, run)) {
    if (commit.material && commitMessageNamesFinding(commit.message, storyId, findingId)) return commit.commit;
  }
  return null;
}

/** Commits on HEAD made inside a managed run's [created, terminal] window, with their message and material flag. */
function managedRunWindowCommits(root: string, gitCwd: string, run: { runId: string; createdAt: string }): Array<{ commit: string; message: string; paths: string[]; material: boolean }> {
  let terminalAt: string | undefined;
  try { terminalAt = readManagedHostRunProjection(root, run.runId).terminal?.terminalAt; } catch { terminalAt = undefined; }
  const since = Math.floor(Date.parse(run.createdAt) / 1000);
  const until = Math.ceil(Date.parse(terminalAt ?? '') / 1000);
  if (!Number.isFinite(since) || !Number.isFinite(until)) return [];
  let log = '';
  try {
    log = execFileSync('git', ['log', `--max-age=${since}`, `--min-age=${until}`, '--format=%x00%H%x1f%B%x1e', '--name-only', 'HEAD'],
      { cwd: gitCwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return []; }
  return log.split('\0').filter(Boolean).map(block => {
    const [head = '', rest = ''] = block.split('\x1e');
    const [commit = '', message = ''] = head.split('\x1f');
    const paths = rest.split('\n').map(row => row.trim()).filter(Boolean);
    return { commit: commit.trim(), message, paths, material: paths.some(path => !isMaterialExcludedPath(path, root)) };
  }).filter(row => row.commit);
}

/**
 * EXPERIMENTAL A/B implementation.grouping=files: a completed grouped
 * implementer run that lists `item` in its groupItemIds (not as its bound
 * item) and committed, inside its window, material touching one of the item's
 * declared files. The owner then verifies and marks the item done itself.
 */
export function groupedImplementationRun(args: { root: string; gitCwd: string; storyId: string; item: ChecklistItem; runs: readonly FindingRepairRunView[] }):
  { runId: string; commit: string } | null {
  const declared = new Set(itemDeclaredFiles(args.item));
  if (declared.size === 0) return null;
  for (const run of [...args.runs].filter(row => row.agentType === IMPLEMENTER_AGENT && row.terminal && row.state === 'completed').reverse()) {
    let target: { itemId?: string; groupItemIds?: string[] } | null | undefined;
    try { target = readManagedHostRunBinding(args.root, run.runId).managedDispatchTarget as typeof target; } catch { continue; }
    if (!target?.itemId || target.itemId === args.item.id || !Array.isArray(target.groupItemIds) || !target.groupItemIds.includes(args.item.id)) continue;
    if (!verifyManagedDispatchDelivery({ root: args.root, runId: run.runId, storyId: args.storyId, agentType: IMPLEMENTER_AGENT, itemId: target.itemId }).valid) continue;
    const commit = managedRunWindowCommits(args.root, args.gitCwd, run).find(row => row.material && row.paths.some(path => declared.has(path)));
    if (commit) return { runId: run.runId, commit: commit.commit };
  }
  return null;
}

function isBoundRepairState(state: FindingRepairState): boolean {
  return state.repaired || state.bound;
}

/**
 * remediation.grouping=single (adopted default since the detection A/B V4 arm;
 * the `per-finding` rollback returns []): the group one finding-repair run
 * covers when `primary` has no bound repair yet — the primary finding plus
 * every other open blocking finding with no bound repair run that is not a
 * duplicate (findingDuplicateOf: critic `duplicate` or superseded-run
 * restatement; duplicates keep their coverage path). Fewer than two
 * members: [] (the single-target repair). Only open BLOCKING findings are
 * grouped; an advisory (low / suspected) finding the owner chooses to repair
 * keeps its own bound run. A member the grouped run leaves without a commit
 * naming it is bound but not repaired, so it gets its own single repair.
 * Shared by the live and the reference driver.
 */
export function groupedFindingRepairIds(args: { root: string; store: HandlerContext['store']; gitCwd: string; storyId: string;
  primary: { id: string }; primaryBound: boolean; findings: ReadonlyArray<{ id: string; createdAt?: string }>; runs: readonly FindingRepairRunView[] }): string[] {
  if (args.primaryBound || args.findings.length < 2 || !remediationGroupingSingle(args.root)) return [];
  const others = args.findings.filter(row => row.id !== args.primary.id
    && !findingDuplicateOf(args.store, args.storyId, row.id)
    && !isBoundRepairState(managedFindingRepairState({ root: args.root, gitCwd: args.gitCwd, storyId: args.storyId, finding: row, runs: args.runs })));
  return others.length ? [args.primary.id, ...others.map(row => row.id)] : [];
}

/** The grouped finding-repair launch (remediation.grouping=single), shared by the live and the reference driver. */
export function groupedFindingRepairStep(root: string, base: { storyId: string; phase: string }, group: readonly string[],
  selection: Record<string, string>, bound: boolean, hostRuns: HostRunView[]): NextStep {
  return managedLaunchStep(base, 'finding_repair', { ...selection, storyId: base.storyId, findingId: group[0], groupFindingIds: [...group],
    agentType: FINDING_REPAIR_AGENT, managedDispatch: true, detach: true, json: true }, bound && targetRelaunchIsFramework(runsForTarget(root, hostRuns, FINDING_REPAIR_AGENT, { findingId: group[0] })),
  `Verified blocking findings ${group.join(', ')} are open and not yet repaired: repair them in ONE managed finding-repair run (remediation.grouping=single), one regression test and one commit naming its id per finding; each is then resolved separately, and a finding with no commit naming it gets its own repair.`,
  'unclosedBlockingFindings (core/finding-closure.ts) + managedFindingRepairState + groupedFindingRepairIds (remediation.grouping=single)');
}

/**
 * Old-PoS run 24 (F4): every open finding in `candidates` (the step's own
 * `primary` first) that managedFindingRepairState shows repaired, with its own
 * run and commit. Shared by the live and the reference driver.
 */
export function repairedFindingsForResolve(args: { root: string; gitCwd: string; storyId: string; runs: readonly FindingRepairRunView[];
  primary: { id: string }; primaryRepair: { runId: string; commit: string }; candidates: ReadonlyArray<{ id: string; createdAt?: string; status?: string }> }): Array<{ id: string; runId: string; commit: string }> {
  const rows = [{ id: args.primary.id, runId: args.primaryRepair.runId, commit: args.primaryRepair.commit }];
  for (const finding of args.candidates) {
    if (finding.id === args.primary.id || (finding.status !== undefined && finding.status !== 'open') || rows.some(row => row.id === finding.id)) continue;
    const repair = managedFindingRepairState({ root: args.root, gitCwd: args.gitCwd, storyId: args.storyId, finding, runs: args.runs });
    if (repair.repaired) rows.push({ id: finding.id, runId: repair.runId, commit: repair.commit });
  }
  return rows;
}

/**
 * Old-PoS run 24 (F4): ONE finding_resolve for several repaired findings
 * (after a grouped repair, closure was 4 next/finding_resolve cycles). Each
 * entry keeps its own evidence: finding_resolve re-checks that finding's own
 * repair (managedFindingRepairState) and records its own commit; a finding
 * failing that check is left open and reported. Shared by the live and the
 * reference driver.
 */
export function findingResolveBatchStep(base: { storyId: string; phase: string }, repaired: ReadonlyArray<{ id: string; runId: string; commit: string }>,
  why: string, source: string): NextStep {
  const resolutions = repaired.map(row => ({ findingId: row.id,
    resolution: `<${row.id}: repair commit ${row.commit.slice(0, 12)} + the focused test that now passes>` }));
  return step(base, 'agent', 'finding_resolve_batch', { command: 'finding_resolve', payload: { storyId: base.storyId, resolutions } },
    `${why} Findings ${repaired.map(row => `${row.id} (commit ${row.commit.slice(0, 12)}, run ${row.runId})`).join(', ')} are repaired and still open: close them in ONE finding_resolve; author each resolution (its own commit and the focused test that now passes). The framework re-checks each finding's own repair; one that fails is left open and reported.`,
    `${source} + managedFindingRepairState per finding (repairedFindingsForResolve)`, { placeholders: resolutions.map((_, index) => `resolutions[${index}].resolution`) });
}

/** The TEST authoring commands for the failing DONE oracle rows, in the order DONE checks them. */
export function testAuthoringCalls(storyId: string, failing: (id: string) => DoneCheckRow | undefined): NextStepCall[] {
  const calls: NextStepCall[] = [];
  if (failing('dev-memory-finish-decision')) {
    calls.push(nextStepCall('dev_memory_finish_decision', { command: 'dev_memory_finish_decision', payload: { storyId, decision: '<captured|no-reusable-lesson|defer-with-reason>',
      reason: '<one sentence: what was learned, or why there is no reusable lesson>' } }));
  }
  if (failing('story-summary')) {
    calls.push(nextStepCall('summary_set', { command: 'summary_set', payload: { storyId, changes: '<what changed, >=10 chars>', usage: '<how to use, >=10 chars>',
      expectedOutcome: '<what the user expects to see>', actualTranscript: '<what was observed when run>', outcomeDiff: '<expected vs actual>',
      acceptanceVerdict: 'accepted', outcomeKind: 'success', limitations: '<known limitations or "none — fully covered">', pitfalls: '<pitfall notes, >=10 chars>' } }));
  }
  return calls;
}

export function testAuthoringWhy(storyId: string, calls: readonly NextStepCall[]): string {
  const rows = calls.map(call => call.reason === 'summary_set'
    ? 'the profile requires a full story summary [missing story summary]'
    : 'DONE refuses without a dev-memory finish decision [missing_dev_memory_finish_decision]');
  return `${rows.join('; ')}. ${calls.length > 1 ? `Author every <...> field and run all ${calls.length} commands in this one turn, ` : 'Author every <...> field and run it, '}`
    + `then \`proof-or-stop next --storyId=${storyId} --run\` (decision=captured: run the optional dev_memory_capture first).`;
}

/** The TEST authoring step for the failing DONE oracle rows (finish decision, summary), or null. */
export function testAuthoringStep(base: { storyId: string; phase: string }, failing: (id: string) => DoneCheckRow | undefined): NextStep | null {
  const { storyId } = base;
  const authoring = testAuthoringCalls(storyId, failing);
  if (authoring.length === 1) {
    const only = authoring[0]!;
    return step(base, 'agent', only.reason, only.cli, testAuthoringWhy(storyId, authoring), `buildDoneChecklist ${only.reason === 'summary_set' ? 'story-summary' : 'dev-memory-finish-decision'}`,
      { placeholders: only.placeholders, optional: only.reason === 'dev_memory_finish_decision' ? [devMemoryCaptureCall(storyId)] : [] });
  }
  if (authoring.length > 1) {
    return batchStep(base, 'test_authoring', authoring, testAuthoringWhy(storyId, authoring),
      'buildDoneChecklist dev-memory-finish-decision + story-summary', [devMemoryCaptureCall(storyId)]);
  }
  return null;
}

export function devMemoryCaptureCall(storyId: string): NextStepCall {
  return nextStepCall('dev_memory_capture', { command: 'dev_memory_capture', payload: { category: '<lesson category>', summary: '<one-sentence summary>',
    trigger: '<trigger scenario>', lesson: '<reusable lesson>', reusePrompt: '<how to find it later>', sourceStoryId: storyId } });
}

/**
 * Q6 (c), run 17: the owner learned decision_set / plan_set from --help.
 * When the latest story_review round still has blockers and some of them
 * are fixed by those PLAN writers, one agent
 * step lists each exact command (placeholders described), then story_review.
 * Every other blocker keeps story_review's own message (most carry their command).
 */
export function planAuthoringStep(store: Pick<HandlerContext['store'], 'readReview' | 'readChecklist'>, base: { storyId: string; phase: string }): NextStep | null {
  const { storyId } = base;
  let issues: Array<{ type?: string; severity?: string; message?: string }> = [];
  try {
    const last = store.readReview(storyId).reviews.at(-1) as { blockerCount?: number; issueCount?: number; issues?: typeof issues } | undefined;
    if (!last || (last.blockerCount ?? last.issueCount ?? 0) === 0) return null;
    issues = last.issues ?? [];
  } catch { return null; }
  const types = new Set(issues.filter(issue => issue.severity === 'blocker').map(issue => issue.type ?? ''));
  const calls: NextStepCall[] = [];
  if (['missing_decision', 'missing_alternatives', 'insufficient_premortem'].some(type => types.has(type))) {
    const scenario = { scenario: '<failure scenario>', trigger: '<what triggers it>', consequence: '<what breaks>', mitigation: '<how the plan prevents it>' };
    calls.push(nextStepCall('decision_set', { command: 'decision_set', payload: { storyId, principles: ['<design principle>', '<design principle>', '<design principle>'],
      drivers: ['<key constraint>', '<key constraint>', '<key constraint>'],
      options: [{ name: '<option A>', pros: ['<pro>'], cons: ['<con>'] }, { name: '<option B>', pros: ['<pro>'], cons: ['<con>'] }],
      chosen: '<option A>', rationale: '<why this option, >=10 chars>', preMortem: [scenario, scenario, scenario] } }));
  }
  if (types.has('missing_plan_md')) {
    const ids = store.readChecklist(storyId).items.map(item => item.id);
    calls.push(nextStepCall('plan_set', { command: 'plan_set', payload: { storyId,
      content: `<full plan.md with one section per item: ${ids.map(id => `## ${id}`).join(', ')}; each with steps, files and verification>` } }));
  }
  if (!calls.length) return null;
  calls.push(nextStepCall('story_review', { command: 'story_review', payload: { storyId } }));
  const others = issues.filter(issue => issue.severity === 'blocker'
    && !['missing_decision', 'missing_alternatives', 'insufficient_premortem', 'missing_plan_md'].includes(issue.type ?? ''));
  const rest = others.length ? ` Other blockers (fix each as story_review says): ${others.slice(0, 4).map(issue => `[${issue.type}] ${(issue.message ?? '').slice(0, 240)}`).join(' ')}${others.length > 4 ? ` +${others.length - 4} more` : ''}` : '';
  return batchStep(base, 'plan_authoring', calls,
    `The latest story_review round has blockers the PLAN writers fix: author every <...> field and run these ${calls.length} commands in one turn (story_review last), then \`proof-or-stop next --storyId=${storyId} --run\`.${rest}`,
    'story_review latest round (review.json) + getGuardFailureReason(DEV)');
}

/** The classified, pinned placeholder row a pre-scope checklist_update adds. */
function placeholderIntentRow(desc: string): Record<string, unknown> {
  return { desc, type: 'logic', priority: 'must', ...STORY_FOCUSED_CLASSIFICATION,
    verification: { command: '<pinned test command, e.g. go test -v ./pkg -run ^TestName$>', selector: '<line its passing run prints, e.g. --- PASS: TestName>' } };
}

/**
 * Run 19 (P1): the deterministic PLAN blockers (core/plan-pre-scope-blockers.ts)
 * as ONE agent step, before the scope-plan reviewer is launched. One exact
 * checklist_update per item, its verificationIntent the full replacement value:
 * the item's current rows, each unpinned executable row with a pin placeholder,
 * each missing lane with a classified pinned placeholder row, and, while request
 * literals are unstated, one placeholder row per item for the literals it
 * delivers. A missing userSees is a userSees placeholder (editable in PLAN).
 * No story_review in the batch: the next round is spent after the reviewer.
 */
export function preScopeAuthoringStep(base: { storyId: string; phase: string }, blockers: PreScopeBlockers,
  items: readonly ChecklistItem[]): NextStep | null {
  if (!hasPreScopeBlockers(blockers)) return null;
  const { storyId } = base;
  const byId = new Map(blockers.items.map(row => [row.itemId, row]));
  const literals = blockers.unmappedLiterals;
  const calls: NextStepCall[] = [];
  const reasons: string[] = [];
  for (const item of items) {
    if (item.status === 'withdrawn') continue;
    const need = byId.get(item.id);
    if (!need && !literals.length) continue;
    const payload: Record<string, unknown> = { storyId, itemId: item.id };
    if (need?.missingUserSees) payload.userSees = `<exact text the user sees once ${item.id} is done (quote outputs exactly)>`;
    const touchesIntent = Boolean(need?.missingLanes.length || need?.unpinned.length || literals.length);
    if (touchesIntent) {
      const intent: Record<string, Array<Record<string, unknown>>> = {};
      for (const lane of VERIFICATION_LANES) {
        intent[lane] = (item.verificationIntent?.[lane] ?? []).map((row, index) => {
          const copy = { ...(row as unknown as Record<string, unknown>) };
          if (need?.unpinned.some(entry => entry.lane === lane && entry.index === index)) {
            copy.verification = { command: `<pinned test command for ${item.id}:${lane}:${index}, e.g. go test -v ./pkg -run ^TestName$>`,
              selector: '<line its passing run prints, e.g. --- PASS: TestName>' };
          }
          return copy;
        });
        if (need?.missingLanes.includes(lane)) intent[lane]!.push(placeholderIntentRow(`<${item.id} ${lane}: action or condition -> exact expected result>`));
      }
      if (literals.length) {
        intent.edge!.push(placeholderIntentRow(`<input -> exact output naming each unstated request literal ${item.id} delivers, quoted exactly; drop this row if ${item.id} delivers none>`));
      }
      payload.verificationIntent = intent;
    }
    calls.push(nextStepCall('checklist_update', { command: 'checklist_update', payload }));
    const parts = [
      need?.missingLanes.length ? `missing ${need.missingLanes.join('/')} intent` : '',
      need?.unpinned.length ? `unpinned ${need.unpinned.map(entry => entry.ref).join(', ')}` : '',
      need?.missingUserSees ? 'missing userSees' : '',
    ].filter(Boolean);
    if (parts.length) reasons.push(`${item.id}: ${parts.join('; ')}`);
  }
  if (!calls.length) return null;
  const literalText = literals.length
    ? ` Request literals no checklist item states yet (story_create pre-check): ${literals.slice(0, 40).map(literal => `\`${literal}\``).join(', ')}${literals.length > 40 ? ` (+${literals.length - 40} more)` : ''}. `
      + 'State each one exactly in an intent row or the userSees of the item that delivers it, or, for reference-only material, add an excludes entry "<literal>: <why>" to that item\'s checklist_update.'
    : '';
  return batchStep(base, 'plan_authoring', calls,
    `PLAN authoring before the scope-plan reviewer: these are deterministic blockers story_review reports anyway${reasons.length ? ` (${reasons.join(' | ')})` : ''}.${literalText} `
      + `Author every <...> field (keep the existing rows; type may be logic/cli/browser/manual/docs) and run these ${calls.length} checklist_update commands in one turn, `
      + `then \`proof-or-stop next --storyId=${storyId} --run\`: it launches the scope-plan reviewer once, on the final checklist.`,
    'planPreScopeBlockers (story_review missing_verification_intent / missing_verification_pin / missing_user_sees + story_create request-literal pre-check)');
}

// ---------------------------------------------------------------------------
// INIT (N4, old-PoS runs 22-24: the owner spent 30-36 of 62-97 requests in
// INIT reading --help pages, launching and polling the INIT reviewers and
// running the boundary / freeze / preflight commands one at a time).

/** The project's validate executables (e.g. `go test`), as execution-boundary command patterns. */
function validateCommandPatterns(root: string): string[] {
  try {
    const commands = (loadConfig(root) as { validate?: { commands?: Array<{ command?: unknown; args?: unknown }> } }).validate?.commands ?? [];
    return [...new Set(commands.flatMap(row => {
      if (typeof row.command !== 'string') return [];
      const sub = Array.isArray(row.args) && typeof row.args[0] === 'string' && !row.args[0].startsWith('-') ? ` ${row.args[0]}` : '';
      return [`${row.command}${sub}`];
    }))];
  } catch { return []; }
}

/** One-line hints for the INIT authoring placeholders, keyed by payload path (array index normalized to [0]). */
const INIT_AUTHORING_HINTS: Record<string, string> = {
  name: 'short kebab-case name, e.g. add-stepped-slice-indexing',
  title: 'one-line title of the user-visible outcome',
  description: 'one or two sentences: what changes for the user and why',
  type: 'feature, bug, refactor, docs or chore',
  priority: 'low, medium, high or critical',
  'keywords[0]': '3-6 domain/module/concept words (duplicate detection)',
  background: 'replace each <...> line; four sections "## Trigger Event" (names a concrete id or date, e.g. 2026-10-08), "## Key Insights", "## Solution Tradeoffs", "## Conversational Texture"; each >=50 chars, total >=300',
  'checklist[0].title': 'one deliverable per item; copy the item object once per deliverable',
  'checklist[0].context': 'root cause / where the change goes (files, functions)',
  'checklist[0].userSees': 'exact text the user sees once the item is done; quote request examples and outputs exactly',
  'checklist[0].files.modify[0]': 'repo-relative files the item changes (one entry per file)',
  'checklist[0].files.test[0]': 'repo-relative test files the item adds or changes',
  'checklist[0].verificationIntent.happy[0].desc': 'input -> exact expected output, derived from a request sentence (quote it); add edge/adversarial rows of the same shape',
  'checklist[0].verificationIntent.happy[0].verification.command': 'the pinned focused test command, e.g. go test -v ./pkg -run ^TestName$ (no env prefix: validate.env applies)',
  'checklist[0].verificationIntent.happy[0].verification.selector': 'the line its passing run prints, e.g. --- PASS: TestName',
  mode: 'feature, correctness_fix, maintenance or custom',
  'allowed[0]': 'one allowed scope entry per area the request asks for (add entries as needed)',
  'excluded[0]': 'what the request does not ask for (drop the entry if nothing)',
  confirmation: 'source of the boundary, e.g. "derived from the verbatim request (request.md)"',
  'allowedCommands[0]': 'another command pattern the work runs besides the ones listed (drop the entry if none)',
  'allowedPaths[0]': 'repo-relative directories the change may touch, e.g. parser/',
  notes: 'one line, e.g. "validate.env applies the project env; no env prefix in pinned commands"',
};

function initHint(path: string): string | undefined {
  const normalized = path.replace(/\[\d+\]/g, '[0]');
  return INIT_AUTHORING_HINTS[normalized]
    ?? INIT_AUTHORING_HINTS[normalized.replace(/^(scopeBoundary|executionBoundary)\./, '').replace(/^allowedScope/, 'allowed').replace(/^excludedScope/, 'excluded')];
}

function withInitHints<T extends { placeholderHints?: Record<string, string> }>(value: T): T {
  if (!value.placeholderHints) return value;
  return { ...value, placeholderHints: Object.fromEntries(Object.entries(value.placeholderHints).map(([path, hint]) => [path, initHint(path) ?? hint])) };
}

/**
 * The first INIT step when no Story exists yet: ONE complete story_create
 * command (scope and execution boundary inline, so no separate boundary
 * commands follow), every authored value a placeholder with a one-line hint.
 * No --help read is needed for it.
 */
export function storyCreateTemplateStep(root: string): NextStep {
  const payload: Record<string, unknown> = {
    name: '<short kebab-case name>',
    title: '<one-line title>',
    description: '<what changes for the user and why>',
    type: '<feature|bug|refactor|docs|chore>',
    priority: '<low|medium|high|critical>',
    keywords: ['<keyword>', '<keyword>', '<keyword>'],
    background: '## Trigger Event\n<what happened, with a concrete id or date>\n\n## Key Insights\n<what the code does today and what must change>\n\n'
      + '## Solution Tradeoffs\n<the approach and what it avoids>\n\n## Conversational Texture\n<how the request is phrased and what acceptance hinges on>',
    checklist: [{
      title: '<deliverable>',
      context: '<root cause / where the change goes>',
      userSees: '<exact user-visible output once done>',
      files: { modify: ['<path/to/file>'], test: ['<path/to/test file>'] },
      verificationIntent: {
        happy: [{ desc: '<input -> exact expected output>', type: 'logic', priority: 'must', ...STORY_FOCUSED_CLASSIFICATION,
          verification: { command: '<pinned focused test command>', selector: '<line its passing run prints>' } }],
        edge: [],
        adversarial: [],
      },
    }],
    scopeBoundary: { mode: '<feature|correctness_fix|maintenance|custom>', allowed: ['<allowed scope entry>'], excluded: ['<excluded scope entry>'],
      userConfirmed: true, confirmation: '<source of the boundary>' },
    executionBoundary: { allowedCommands: [...validateCommandPatterns(root), 'git', 'proof-or-stop', '<other command pattern>'], allowedPaths: ['<repo-relative directory>/'],
      excludedPaths: ['.proof-or-stop/', '.codex/', 'AGENTS.md', 'proof-or-stop.config.json'] },
  };
  return withInitHints(step({ storyId: '', phase: 'INIT' }, 'agent', 'story_create_authoring', { command: 'story_create', payload },
    'No Story exists yet. Author this ONE story_create (a staged request is recorded as request.md by itself; do not pass `request`): '
      + 'one checklist item per deliverable (copy the item object), each executable intent pinned, the scope and execution boundary inline. '
      + 'Then run the `proof-or-stop next --storyId=<id> --run` line it prints: that records the scope freeze check, launches both managed INIT reviewers, waits for them and advances to PLAN.',
    'story_create schema (command-catalog) + INIT_CHECK gate (scope boundary, execution boundary)', { placeholders: placeholderPaths(payload) }));
}

/**
 * INIT boundary authoring for a Story created without them: both commands in
 * one turn, placeholders described (story_create's inline boundary is the
 * usual path; this covers a Story created without it).
 */
export function initBoundaryAuthoringStep(root: string, base: { storyId: string; phase: string }, missing: { scope: boolean; execution: boolean }): NextStep {
  const { storyId } = base;
  const calls: NextStepCall[] = [];
  if (missing.scope) {
    calls.push(withInitHints(nextStepCall('scope_boundary_set', { command: 'scope_boundary_set', payload: { storyId, mode: '<feature|correctness_fix|maintenance|custom>',
      allowedScope: ['<allowed scope entry>'], excludedScope: ['<excluded scope entry>'], userConfirmed: true, confirmation: '<source of the boundary>' } })));
  }
  if (missing.execution) {
    calls.push(withInitHints(nextStepCall('execution_boundary_set', { command: 'execution_boundary_set', payload: { storyId,
      allowedCommands: [...validateCommandPatterns(root), 'git', 'proof-or-stop', '<other command pattern>'], allowedPaths: ['<repo-relative directory>/'],
      blockedPaths: ['.proof-or-stop/', '.codex/', 'AGENTS.md', 'proof-or-stop.config.json'], notes: '<one-line note>' } })));
  }
  const what = [missing.scope ? 'the scope boundary' : '', missing.execution ? 'the execution boundary' : ''].filter(Boolean).join(' and ');
  return withInitHints(batchStep(base, 'init_boundary_authoring', calls,
    `The INIT_CHECK gate needs ${what}, and the INIT reviewers read both, so they come first. `
      + `Author every <...> value (drop an array entry you do not need) and run ${calls.length === 1 ? 'it' : `these ${calls.length} commands in one turn`}, then \`proof-or-stop next --storyId=${storyId} --run\`.`,
    'getGuardFailureReason(INIT_CHECK) missing_scope_boundary / missing_execution_boundary'));
}

/**
 * Run 17 (Q1): the step for an open verified finding the REVIEW inventory
 * critic dispositioned `duplicate` of a canonical finding that is already
 * repaired and resolved, and that has no repair of its own and no failed
 * coverage run (duplicateResolveCandidate). Instead of a second repair cycle,
 * finding_resolve closes it with the canonical repair, but only through a
 * coverage run of its own case that the framework executes; a failing run is
 * recorded and the finding then gets its own managed repair.
 */
export function duplicateFindingResolveStep(base: { storyId: string; phase: string }, finding: { id: string; severity: string }, canonical: { id: string }, familyKey: string | null): NextStep {
  const next = step(base, 'agent', 'finding_duplicate_resolve', { command: 'finding_resolve', payload: { storyId: base.storyId, findingId: finding.id, duplicateOf: canonical.id,
    coverage: { command: DUPLICATE_COVERAGE_COMMAND_PLACEHOLDER, selector: DUPLICATE_COVERAGE_SELECTOR_PLACEHOLDER }, resolution: DUPLICATE_RESOLUTION_PLACEHOLDER } },
  `Verified ${finding.severity} finding ${finding.id} is a duplicate (critic, or a lane rerun's restatement) of ${canonical.id}${familyKey ? ` (family ${familyKey})` : ''}, which was repaired and resolved. `
    + `Close ${finding.id} with that repair only if its own case is fixed: coverage.command runs ${finding.id}'s own case (a test ${canonical.id}'s repair added for it, or its repro as a test) and coverage.selector is the line its passing output prints. `
    + `The framework runs it; exit 0 with the selector closes ${finding.id}, anything else is refused and ${finding.id} gets its own managed repair.`,
  'unclosedBlockingFindings + findingDuplicateOf (critic receipts or superseded-run restatement) + duplicateResolveCandidate', { placeholders: ['coverage.command', 'coverage.selector', 'resolution'] });
  // The generic finding_resolve.resolution hint names a repair commit; this resolution cites the canonical one.
  return next.placeholderHints
    ? { ...next, placeholderHints: { ...next.placeholderHints, resolution: `why ${canonical.id}'s repair fixes ${finding.id}'s case (its commit and the test the coverage runs)` } }
    : next;
}

/**
 * The open blocking finding DEV works on next: the first one, except that a
 * critic duplicate waits while its canonical finding is still open (the
 * canonical repair may fix both; run 17 Q1).
 */
export function nextBlockingFinding<T extends { finding: { id: string } }>(store: HandlerContext['store'], storyId: string, findings: readonly T[]): T {
  const all = store.readFindings(storyId).findings ?? [];
  return findings.find(row => !duplicateOfOpenCanonical(store, storyId, row.finding.id, all)) ?? findings[0]!;
}

/**
 * One blocking wait on a detached managed run. The command is the compact text
 * status (binding, state, exit, verdict, receipt, next action; never the full
 * --json record) and the step carries the long-yield wait instruction, which
 * renderNextStep prints first (core/owner-wait-guidance.ts).
 */
export function managedRunWaitStep(base: { storyId: string; phase: string }, runId: string, state: string, what: string): NextStep {
  return step(base, 'framework', 'managed_run_wait', { command: 'host_run_status', payload: { runId, untilTerminal: true } },
    `${what} ${runId} is ${state}; block until it is terminal (returns at terminal, up to ${ownerWaitBlockMs() / 1000} s per call).`,
    'managed host-run projection', { wait: true });
}

function waitStep(base: { storyId: string; phase: string }, run: HostRunView, what: string): NextStep {
  return managedRunWaitStep(base, run.runId, run.state, what);
}

/**
 * Host/model/effort for a managed launch: the owner's own last choice for this
 * Story and profile (e.g. a benchmark's pinned model), else the qualified
 * managed-reviewer default. host_run still validates the selection itself.
 */
/**
 * The selection plus whether it is bound: taken from the owner's own earlier
 * managed run of this Story with host, model and effort all set. A default
 * (no earlier run) is a proposal the agent confirms on its first launch.
 */
export function boundManagedSelection(hostRuns: HostRunView[], profile: 'managed_reviewer' | 'managed_dispatch'): { selection: Record<string, string>; bound: boolean } {
  const prior = hostRuns.filter(run => run.profile === profile && run.host).at(-1) ?? hostRuns.filter(run => run.host).at(-1);
  if (prior) {
    return { selection: { host: prior.host, ...(prior.model ? { model: prior.model } : {}), ...(prior.reasoningEffort ? { reasoningEffort: prior.reasoningEffort } : {}) },
      bound: Boolean(prior.host && prior.model && prior.reasoningEffort) };
  }
  const selection = QUALIFIED_MANAGED_REVIEWER_DEFAULTS.codex;
  return { selection: { host: 'codex', model: selection.model, reasoningEffort: selection.reasoningEffort }, bound: false };
}

/**
 * The managed runs of this Story that already targeted the same dispatch
 * target (item / finding). An unreadable binding counts as such a run and is
 * never auto-replaceable.
 */
export function runsForTarget(root: string, hostRuns: HostRunView[], agentType: string, target: { itemId?: string; findingId?: string }): HostRunView[] {
  return hostRuns.flatMap(run => {
    if (run.agentType !== agentType) return [];
    try {
      const bound = readManagedHostRunBinding(root, run.runId).managedDispatchTarget;
      return (target.itemId ? bound?.itemId === target.itemId : bound?.findingId === target.findingId) ? [run] : [];
    } catch { return [{ ...run, autoReplaceable: false }]; }
  });
}

/** Whether any managed run of this Story already targeted the same dispatch target (item / finding). */
export function hasRunForTarget(root: string, hostRuns: HostRunView[], agentType: string, target: { itemId?: string; findingId?: string }): boolean {
  return runsForTarget(root, hostRuns, agentType, target).length > 0;
}

/**
 * One relaunch rule for a managed target: its first launch, or a relaunch
 * after earlier runs that ALL failed auto-replaceably (supervisor never ready,
 * provider stalled with no work product), at most
 * MANAGED_AUTO_RELAUNCHES_PER_TARGET of them, is a framework step. Any other
 * earlier run keeps the launch the agent's call (no relaunch loop).
 */
export function targetRelaunchIsFramework(earlier: ReadonlyArray<Pick<HostRunView, 'autoReplaceable'>>): boolean {
  return earlier.length <= MANAGED_AUTO_RELAUNCHES_PER_TARGET && earlier.every(run => run.autoReplaceable === true);
}

// ---------------------------------------------------------------------------
// Decision

export function createNextDriver(ctx: HandlerContext, lookup: HandlerLookup) {
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

  /** A gate's own printed next command, as a step of the given kind (hintedStep). */
  const delegated = hintedStep;

  /**
   * When every invalid reviewer evidence item is an OPEN finding bound to a
   * superseded run of its lane (stale_run), their ids; otherwise null.
   */
  function supersededOpenFindingIds(storyId: string): string[] | null {
    const state = collectReviewerEvidenceState(ctx.store, storyId, ctx.root);
    if (state.invalid.length === 0) return null;
    const findings = ctx.store.readFindings(storyId).findings ?? [];
    const carried = state.invalid.every(issue => issue.kind === 'finding' && issue.code === 'stale_run'
      && findings.find(row => row.id === issue.evidenceId)?.status === 'open');
    return carried ? [...new Set(state.invalid.map(issue => issue.evidenceId))] : null;
  }

  function guardStep(base: { storyId: string; phase: string }, target: string, reason: string, why: string, source: string): NextStep {
    const failure = getGuardFailureReason(base.storyId, ctx.store, target, ctx.root, gitCwdOf(base.storyId));
    if (!failure) {
      return step(base, 'framework', reason, { command: 'story_advance', payload: { storyId: base.storyId, phase: target } }, why, source);
    }
    const hint = nextLine(failure) ?? failure.split('\n').find(row => /proof-or-stop [a-z_]+/.test(row)) ?? '';
    return delegated(base, 'agent', `guard_${target.toLowerCase()}_blocked`, hint || failure,
      `story_advance --phase=${target} would be refused: ${failure.split('\n')[0]}`, `getGuardFailureReason(${target})`);
  }

  // -- PLAN → DEV -----------------------------------------------------------

  /**
   * PLAN is authored work; next only names what the DEV-entry gate will
   * demand. The dev-memory acknowledgement comes first: it is independent of
   * the plan and was the refusal nobody had surfaced (run 14). Then, while the
   * scope-plan verdict is missing or must be rerun: the deterministic PLAN
   * authoring batch first (run 19 P1), then the reviewer launch / relaunch
   * (P2). Then the DEV guard's own first failure and its Next line, or
   * story_advance DEV.
   */
  function planNext(base: { storyId: string; phase: string }): NextStep {
    const { storyId } = base;
    // D1 (run 23): an implementer-declared intent conflict is amended first.
    const conflicts = openIntentConflicts({ root: ctx.root, gitCwd: gitCwdOf(storyId), store: ctx.store, storyId, runs: listStoryHostRuns(ctx, storyId) });
    if (conflicts.length > 0) return intentConflictStep(base, conflicts);
    if (!evaluateDevMemoryPreflightGate(storyId, ctx.store)) {
      return step(base, 'agent', 'dev_memory_preflight_ack', { command: 'dev_memory_preflight_ack', payload: { storyId } },
        'The DEV-entry gate refuses without the dev-memory preflight acknowledgement [missing_dev_memory_preflight_ack]. Run it now and read the lessons it prints before planning the implementation.',
        'evaluateDevMemoryPreflightGate (DEV-entry gate)');
    }
    // Run 16: the scope-plan reviewer verdict the DEV-entry gate requires
    // (missingPlanScopeCheckFailure, the gate's own predicate). Launched with the
    // owner's own managed selection, or waited on while its run is in flight.
    // Run 19 (P1): only after the deterministic PLAN blockers are authored, so the
    // reviewer judges the final checklist once. (P2): a verdict that must be rerun
    // (scopePlanRerunReason) is relaunched here too, not sent to story_review.
    const story = ctx.store.readStory(storyId);
    const policy = policyOf(storyId);
    const scopeFailure = missingPlanScopeCheckFailure(ctx.store, story, policy);
    const rerun = scopeFailure ? null : scopePlanRerunReason(ctx.store, story);
    // N8 (v4.1 cost plan, core/scope-plan-deferral.ts): a MISSING verdict whose
    // managed scope-plan run (launched in PLAN) is live no longer holds DEV: the
    // DEV-entry gate defers it to DEV→REVIEW, so PLAN finishes and the first
    // implementer starts beside the reviewer. A verdict that must be RERUN still
    // waits here (its gaps block story_review until the rerun judges them).
    const deferred = scopeFailure && !rerun ? pendingScopePlanRun(ctx.root, storyId) : null;
    if ((scopeFailure || rerun) && !deferred) {
      const hostRuns = listStoryHostRuns(ctx, storyId);
      const running = hostRuns.filter(run => run.agentType === SCOPE_PLAN_REVIEWER && !run.terminal).at(-1);
      if (running) return waitStep(base, running, 'Scope-plan reviewer run');
      const authoring = preScopeAuthoringStep(base, planPreScopeBlockers(ctx.store, story, policy), ctx.store.readChecklist(storyId).items);
      if (authoring) return authoring;
      const last = hostRuns.filter(run => run.agentType === SCOPE_PLAN_REVIEWER).at(-1);
      const previous = last && last.state !== 'completed' ? ` The previous scope-plan run ${last.runId} ended ${last.state}.` : '';
      const { selection, bound } = boundManagedSelection(hostRuns, 'managed_dispatch');
      // A stalled / never-ready scope-plan run is relaunched like any other
      // auto-replaceable target (the trailing streak of such failures, bounded).
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
    const authoring = planAuthoringStep(ctx.store, base);
    if (authoring) return authoring;
    return guardStep(base, 'DEV', 'enter_dev', deferred
      ? `PLAN is complete except the scope-plan verdict, whose managed run ${deferred.runId} is still ${deferred.state}: the DEV-entry gate defers it to DEV→REVIEW, so DEV starts beside the reviewer (a gap it finds sends the Story back to PLAN before REVIEW).`
      : 'PLAN is complete: the DEV-entry gate admits the Story.', 'getGuardFailureReason(DEV)');
  }

  // -- INIT → INIT_CHECK → PLAN (N4) ----------------------------------------

  /**
   * INIT is driven from the INIT_CHECK gate's own failure (getGuardFailureReason,
   * the order the gate checks): the boundaries the Story was created without
   * (one authoring batch), the deterministic scope_freeze_check (framework: the
   * core evaluates it, the caller only records it), then the two required INIT
   * reviewers. Each reviewer without a current, delivered record is launched by
   * the framework when it is its first run (the Story's own selection, else the
   * qualified managed-reviewer default the INIT guidance names), a mechanical
   * replacement, or the rerun of a verdict the owner's later edit made stale;
   * both are launched before the first wait, so they run in parallel. Then
   * story_advance INIT_CHECK and PLAN. Judgment (a failed freeze check,
   * reviewer blockers, a reviewer run that ended without its record) stays the
   * agent's, with the gate's own text.
   */
  function initNext(base: { storyId: string; phase: string }): NextStep {
    const { storyId } = base;
    const failure = getGuardFailureReason(storyId, ctx.store, 'INIT_CHECK', ctx.root, gitCwdOf(storyId));
    if (!failure) {
      return step(base, 'framework', 'enter_init_check', { command: 'story_advance', payload: { storyId, phase: 'INIT_CHECK' } },
        'Every INIT_CHECK prerequisite passes (boundaries, scope freeze check, both INIT reviewer verdicts): enter INIT_CHECK (creates the Story worktree).',
        'getGuardFailureReason(INIT_CHECK)');
    }
    const code = failure.match(/\[([a-z_]+)\]/)?.[1] ?? '';
    if (code === 'missing_scope_boundary' || code === 'missing_execution_boundary') {
      return initBoundaryAuthoringStep(ctx.root, base, { scope: !ctx.store.readScopeBoundary(storyId), execution: !ctx.store.readExecutionBoundary(storyId) });
    }
    if (code === 'missing_scope_freeze_check' || code === 'scope_freeze_check_stale') {
      return step(base, 'framework', 'scope_freeze_check', { command: 'scope_freeze_check', payload: { storyId } },
        `${failure.split('\n')[0]} The core evaluates the freeze check from the boundaries, story text and checklist; recording it is mechanical.`,
        'getGuardFailureReason(INIT_CHECK) scope freeze check');
    }
    const reviewerCodes = new Set(['missing_init_check', 'missing_init_check_agent', 'init_check_tampered', 'delivery_not_acknowledged']);
    if (!reviewerCodes.has(code)) {
      const hint = nextLine(failure) ?? failure.split('\n').find(row => /proof-or-stop [a-z_]+/.test(row)) ?? '';
      const blockers = code === 'init_check_blocking_issues';
      const next = delegated(base, 'agent', blockers ? 'init_review_blockers' : `init_check_${code || 'blocked'}`,
        blockers ? '' : hint, `story_advance --phase=INIT_CHECK would be refused: ${failure.slice(0, 1600)}`, 'getGuardFailureReason(INIT_CHECK)');
      if (!blockers) return next;
      // Reviewer blockers: fix the INIT artifacts, then rerun next: an edit to a
      // signed input stales the verdict and next relaunches the reviewer itself.
      return { ...next, why: `${next.why} Fix each issue in the Story (story_update / checklist_update / background), then run \`proof-or-stop next --storyId=${storyId} --run\`: the changed inputs stale the verdict and it reruns the reviewer.` };
    }
    const initCheck = ctx.store.readInitCheck(storyId);
    const stale = Boolean(initCheck) && initCheck!._hash !== recomputeInitCheckHash(storyId, ctx.store, ctx.root);
    const results = initCheck ? initCheckAgentResults(initCheck) : [];
    const invalid = new Set(initCheck && !stale ? invalidInitReviewerDeliveries(initCheck, ctx.root, storyId).map(row => row.agentId) : []);
    const missing = new Set<string>(initCheck && !stale ? missingRequiredInitCheckAgents(initCheck) : [...REQUIRED_INIT_CHECK_AGENTS]);
    const hostRuns = listStoryHostRuns(ctx, storyId);
    const { selection, bound } = boundManagedSelection(hostRuns, 'managed_dispatch');
    const waits: HostRunView[] = [];
    for (const agentType of REQUIRED_INIT_CHECK_AGENTS) {
      if (!missing.has(agentType) && !invalid.has(agentType)) continue;
      const runs = hostRuns.filter(run => run.agentType === agentType);
      const running = runs.find(run => !run.terminal);
      if (running) { waits.push(running); continue; }
      const last = runs.at(-1);
      const recordedBy = results.find(row => row.agentId === agentType)?.deliveryRunId?.trim();
      let streakStart = runs.length;
      while (streakStart > 0 && runs[streakStart - 1]!.autoReplaceable) streakStart -= 1;
      const autoStreak = runs.slice(streakStart);
      // First run (default selection allowed: the INIT guidance's own qualified
      // default), a mechanical replacement, or the rerun of a verdict this
      // reviewer's latest run delivered and a later edit made stale.
      const auto = !last
        || (autoStreak.length > 0 && targetRelaunchIsFramework(autoStreak))
        || (stale && last.state === 'completed' && recordedBy === last.runId);
      const why = !last
        ? `INIT_CHECK needs a delivered verdict from ${agentType}; no run of it exists yet.`
        : stale && recordedBy === last.runId
          ? `The Story's signed INIT inputs changed after ${agentType} run ${last.runId} judged them [init_check_tampered]; rerun it on the current text.`
          : `${agentType} has no current delivered verdict; its last run ${last.runId} ended ${last.state}${invalid.has(agentType) ? ' and its delivery is not acknowledged' : ''}. Inspect it (proof-or-stop host_run_status --runId=${last.runId}) before relaunching.`;
      return managedLaunchStep(base, 'init_review_launch', { ...selection, storyId, agentType, managedDispatch: true, detach: true, json: true },
        auto, `${why} Launch the managed INIT reviewer; it records its verdict with init_check_set.`,
        'getGuardFailureReason(INIT_CHECK) + init-check.json (missingRequiredInitCheckAgents / invalidInitReviewerDeliveries / recomputeInitCheckHash)',
        !last ? `first run of this reviewer${bound ? '' : ', qualified managed-reviewer default selection'}` : 'replacement of its own failed or stale run');
    }
    if (waits.length > 0) return waitStep(base, waits[0]!, 'INIT reviewer run');
    return delegated(base, 'agent', `init_check_${code}`, nextLine(failure) ?? '', `story_advance --phase=INIT_CHECK would be refused: ${failure.slice(0, 1600)}`, 'getGuardFailureReason(INIT_CHECK)');
  }

  // -- DEV -----------------------------------------------------------------

  /**
   * The first open finding outside the closure set (low, or suspected) whose
   * own managed finding-repair completed with a material commit
   * (managedFindingRepairState). Free when the Story has no repair run.
   */
  function repairedAdvisoryFinding(storyId: string, hostRuns: HostRunView[]) {
    if (!hostRuns.some(run => run.agentType === FINDING_REPAIR_AGENT)) return null;
    const blocking = new Set(openBlockingFindings(storyId).map(row => row.finding.id));
    const gitCwd = gitCwdOf(storyId);
    for (const finding of ctx.store.readFindings(storyId).findings ?? []) {
      if (finding.status !== 'open' || blocking.has(finding.id) || finding.evidenceState === 'disproven') continue;
      const repair = managedFindingRepairState({ root: ctx.root, gitCwd, storyId, finding, runs: hostRuns });
      if (repair.repaired) return { finding, repair };
    }
    return null;
  }

  function devNext(base: { storyId: string; phase: string }): NextStep {
    const { storyId } = base;
    const checklist = ctx.store.readChecklist(storyId);
    const open = checklist.items.filter(item => !isTerminalChecklistStatus(item.status));
    const hostRuns = listStoryHostRuns(ctx, storyId);
    const inFlight = (agentType: string) => hostRuns.filter(run => run.agentType === agentType && !run.terminal).at(-1);
    // D1 (run 23): a declared [intent-conflict] blocks before the next item,
    // repair or REVIEW (unless a writer run is still in flight: wait first).
    if (!inFlight(IMPLEMENTER_AGENT) && !inFlight(FINDING_REPAIR_AGENT)) {
      const conflicts = openIntentConflicts({ root: ctx.root, gitCwd: gitCwdOf(storyId), store: ctx.store, storyId, runs: hostRuns });
      if (conflicts.length > 0) return intentConflictStep(base, conflicts);
      // N8: a deferred scope-plan verdict that arrived with a gap (or never
      // arrived) is PLAN work: go back before implementing more.
      const scopeVerdict = scopeVerdictReviewEntryFailure(ctx.store, ctx.root, ctx.store.readStory(storyId), policyOf(storyId));
      if (scopeVerdict && !/\[scope_check_pending\]/.test(scopeVerdict)) {
        return guardStep(base, 'PLAN', 'scope_verdict_replan', `${scopeVerdict.split('\n')[0]} Return to PLAN to cover or exclude it and rerun the scope-plan reviewer.`,
          'scopeVerdictReviewEntryFailure (DEV→REVIEW gate, N8 deferred scope verdict)');
      }
    }
    if (open.length > 0) {
      const item = open[0]!;
      // EXPERIMENTAL A/B implementation.grouping=files (core/ab-dispatch-grouping.ts).
      const groupByFiles = open.length > 1 || hostRuns.some(run => run.agentType === IMPLEMENTER_AGENT) ? implementationGroupingFiles(ctx.root) : false;
      if (groupByFiles && item.status !== 'pending') {
        const grouped = groupedImplementationRun({ root: ctx.root, gitCwd: gitCwdOf(storyId), storyId, item, runs: hostRuns });
        if (grouped) {
          return step(base, 'agent', 'grouped_item_done', { command: 'checklist_update', payload: { storyId, itemId: item.id, status: 'done' } },
            `${item.id} (${item.title}) was implemented by grouped implementer run ${grouped.runId} (commit ${grouped.commit.slice(0, 12)} touches its declared files; A/B implementation.grouping=files). Verify its own intent (run its pinned focused evidence) and mark it done separately.`,
            'checklist.json + groupedImplementationRun (A/B implementation.grouping=files)');
        }
      }
      const group = groupByFiles ? sharedFileItemGroup(item, open) : [item];
      const pendingItem = group.find(member => member.status === 'pending');
      if (pendingItem) {
        return step(base, 'framework', 'checklist_item_start', { command: 'checklist_update', payload: { storyId, itemId: pendingItem.id, status: 'in_progress' } },
          `${pendingItem.id} is pending; mark it in_progress before dispatching its implementer.`, 'checklist.json');
      }
      const running = inFlight(IMPLEMENTER_AGENT);
      if (running) return waitStep(base, running, 'Implementer run');
      const { selection, bound } = boundManagedSelection(hostRuns, 'managed_dispatch');
      if (group.length > 1) {
        return managedLaunchStep(base, 'implement_item', { ...selection, storyId, itemId: item.id, groupItemIds: group.map(member => member.id),
          agentType: IMPLEMENTER_AGENT, managedDispatch: true, detach: true, json: true }, bound && targetRelaunchIsFramework(runsForTarget(ctx.root, hostRuns, IMPLEMENTER_AGENT, { itemId: item.id })),
        `${group.map(member => member.id).join(', ')} share declared files: implement and commit them in ONE managed implementer run bound to ${item.id} (A/B implementation.grouping=files); it marks ${item.id} done, each other item is verified and marked done separately afterwards.`,
        'checklist.json + sharedFileItemGroup (A/B implementation.grouping=files)');
      }
      return managedLaunchStep(base, 'implement_item', { ...selection, storyId, itemId: item.id,
        agentType: IMPLEMENTER_AGENT, managedDispatch: true, detach: true, json: true }, bound && targetRelaunchIsFramework(runsForTarget(ctx.root, hostRuns, IMPLEMENTER_AGENT, { itemId: item.id })),
      `${item.id} (${item.title}) is ${item.status}: implement and commit it (managed implementer shown; a native fresh-context implementer with the dispatch prompt is equivalent), then mark it done.`,
      'checklist.json');
    }

    // Verified blocking findings must be closed (finding-closure rule) before
    // REVIEW is worth re-entering.
    const findings = openBlockingFindings(storyId);
    // The evidence chain is read only by the rows below that consult it (a
    // finding still awaiting repair or its run does not).
    let chainResult: ReturnType<typeof evaluateEvidenceChainForStory> | undefined;
    const chainOf = () => (chainResult ??= evaluateEvidenceChainForStory(ctx, storyId));
    if (findings.length > 0) {
      const { finding } = nextBlockingFinding(ctx.store, storyId, findings);
      // Per finding: only a completed managed repair bound to THIS finding id
      // (with its commit) makes it resolvable; a material change made by the
      // repair of another open finding does not (run 14).
      const repair = managedFindingRepairState({ root: ctx.root, gitCwd: gitCwdOf(storyId), storyId, finding, runs: hostRuns });
      if (!repair.repaired) {
        const repairRun = hostRuns.filter(run => run.agentType === FINDING_REPAIR_AGENT && !run.terminal).at(-1);
        if (repairRun) return waitStep(base, repairRun, 'Finding repair run');
        // Run 17 (Q1): a critic duplicate of a repaired+resolved finding is
        // closed with that repair through a coverage run, not repaired again.
        const duplicate = repair.bound ? null : duplicateResolveCandidate(ctx.store, storyId, finding, ctx.store.readFindings(storyId).findings ?? []);
        if (duplicate) return duplicateFindingResolveStep(base, finding, duplicate.canonical, duplicate.familyKey);
        const failedCoverage = duplicateCoverageReceipts(ctx.store, storyId, finding.id).filter(row => !row.passed).at(-1);
        const { selection, bound } = boundManagedSelection(hostRuns, 'managed_dispatch');
        // remediation.grouping=single (adopted default): one run for every open blocking finding no repair is bound to yet.
        const group = groupedFindingRepairIds({ root: ctx.root, store: ctx.store, gitCwd: gitCwdOf(storyId), storyId, primary: finding,
          primaryBound: repair.bound, findings: findings.map(row => row.finding), runs: hostRuns });
        if (group.length > 1) return groupedFindingRepairStep(ctx.root, base, group, selection, bound, hostRuns);
        return managedLaunchStep(base, 'finding_repair', { ...selection, storyId, findingId: finding.id,
          agentType: FINDING_REPAIR_AGENT, managedDispatch: true, detach: true, json: true }, bound && targetRelaunchIsFramework(runsForTarget(ctx.root, hostRuns, FINDING_REPAIR_AGENT, { findingId: finding.id })),
        `Verified ${finding.severity} finding ${finding.id} is open and not yet repaired (${repair.detail}${failedCoverage ? `; its duplicate coverage run \`${failedCoverage.command}\` did not pass, so ${failedCoverage.canonicalFindingId}'s repair is not shown to fix it` : ''}): repair it in code and commit (managed finding-repair shown).`,
        'unclosedBlockingFindings (core/finding-closure.ts) + managedFindingRepairState');
      }
      const chain = chainOf();
      if (chain.blocking && chain.nextAction) {
        return evidenceChainStep(base, chain, 'The repair changed material, so pinned receipts are stale; refresh them before recording the resolution.');
      }
      const repaired = repairedFindingsForResolve({ root: ctx.root, gitCwd: gitCwdOf(storyId), storyId, runs: hostRuns,
        primary: finding, primaryRepair: repair, candidates: findings.map(row => row.finding) });
      if (repaired.length > 1) {
        return findingResolveBatchStep(base, repaired, 'Closure is required whichever round raised them.', 'unclosedBlockingFindings (core/finding-closure.ts)');
      }
      return step(base, 'agent', 'finding_resolve', { command: 'finding_resolve', payload: { storyId, findingId: finding.id, resolution: FINDING_RESOLUTION_PLACEHOLDER } },
        `${finding.id} was repaired by managed finding-repair run ${repair.runId} (commit ${repair.commit.slice(0, 12)}) but is still open; closure is required whichever round raised it. Name the repair commit and its passing focused evidence.`,
        'unclosedBlockingFindings (core/finding-closure.ts) + managedFindingRepairState', { placeholders: ['resolution'] });
    }
    const chain = chainOf();
    if (chain.blocking && chain.nextAction) {
      return evidenceChainStep(base, chain, 'The DEV→REVIEW evidence-chain gate would refuse: a must/should receipt is stale or missing.');
    }
    // Run 16: an advisory (low / suspected) finding stays open unless the owner
    // repairs it; once a managed finding-repair bound to it completed, close it
    // here with the same per-finding rule as a blocking one, so DONE never
    // leaves a repaired finding open. Unrepaired advisory findings stay advisory.
    const repairedAdvisory = repairedAdvisoryFinding(storyId, hostRuns);
    if (repairedAdvisory) {
      const { finding, repair } = repairedAdvisory;
      return step(base, 'agent', 'finding_resolve', { command: 'finding_resolve', payload: { storyId, findingId: finding.id, resolution: FINDING_RESOLUTION_PLACEHOLDER } },
        `Advisory ${finding.severity} finding ${finding.id} was repaired by managed finding-repair run ${repair.runId} (commit ${repair.commit.slice(0, 12)}) but is still open; resolve it before REVIEW so DONE does not leave it open. Name the repair commit and its passing focused evidence.`,
        'managedFindingRepairState (advisory finding with a completed bound repair)', { placeholders: ['resolution'] });
    }
    // Advisory items (a changed test no pin selects, a missing should receipt)
    // never become a step of their own: binding a test is the agent's judgment
    // and an extra regression test needs no action (run 16).
    const advisory = evidenceChainAdvisory(chain);
    // N8: REVIEW entry needs the deferred scope-plan verdict; wait for its live run.
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

  /**
   * A managed reviewer/critic launch for one prepared ReviewRun. Fully bound
   * unless an earlier ReviewRun of the same lane and round has a run that did
   * not complete (a replacement after a failure is the agent's call).
   */
  function reviewLaunchStep(base: { storyId: string; phase: string }, lane: string, reviewRunId: string, critic: boolean): NextStep {
    const hostRuns = listStoryHostRuns(ctx, base.storyId);
    const { selection, bound } = boundManagedSelection(hostRuns, 'managed_reviewer');
    const runs = ctx.store.readReviewRuns(base.storyId).runs;
    const round = runs.find(run => run.reviewRunId === reviewRunId)?.reviewRound;
    const failedEarlier = runs.filter(run => run.lane === lane && run.reviewRound === round && run.reviewRunId !== reviewRunId
      && (hostRunFor(hostRuns, run.reviewRunId)?.state ?? 'completed') !== 'completed').map(run => hostRunFor(hostRuns, run.reviewRunId));
    // A launch whose recovery supervisor never became ready (host load) ran
    // nothing, and a provider that stalled left nothing: the framework
    // relaunches it itself, up to MANAGED_AUTO_RELAUNCHES_PER_TARGET times
    // (targetRelaunchIsFramework); any other earlier failure keeps the
    // replacement the agent's call.
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
    for (const lane of [...new Set(runs.map(run => run.lane))]) {
      const latest = runs.filter(run => run.lane === lane).at(-1)!;
      if (evidenced(latest)) continue;
      const hostRun = hostRunFor(hostRuns, latest.reviewRunId);
      if (!hostRun) { toLaunch.push({ lane, run: latest }); continue; }
      if (!hostRun.terminal) { waiting.push(hostRun); continue; }
      if (hostRun.state !== 'completed') continue; // replacement: reviewer_batch → review_round_prepare
      let receiptId = '';
      try { receiptId = managedHostRunReceipt(ctx.root, hostRun.runId).receiptId; } catch { continue; }
      // A/B V3 R2A-r2: a receipt whose import was refused for good is never
      // proposed again; the lane then has no evidence and review_round_prepare
      // starts a fresh run of it.
      if (!hasPersistedManagedReceiptEvidence(ctx.store, storyId, receiptId)
        && !refusedManagedReviewImport(ctx.store, storyId, hostRun.runId, receiptId)) importable.push({ run: hostRun, receiptId });
    }
    if (toLaunch.length) {
      const launches = toLaunch.map(row => reviewLaunchStep(base, row.lane, row.run.reviewRunId, false));
      // N2: every prepared lane whose launch is fully bound starts in ONE step,
      // concurrently (each its own host_run process, the same command as alone).
      // A replacement or unbound launch stays a single step of its own.
      const bound = launches.filter(launch => launch.kind === 'framework' && launch.launch && launch.cli);
      if (bound.length > 1 && bound[0] === launches[0]) {
        const first = bound[0]!;
        return step(base, 'framework', 'review_lane_launch', first.cli,
          `Launch the ${bound.length} prepared managed reviewer lanes concurrently (${bound.map(launch => String(launch.cli!.payload.lane).replace('proof-or-stop-review-', '')).join(', ')}), each in its own host_run process, before waiting. Fully bound (this Story's own host/model/effort, first run of each target): \`next --run\` launches them together.`,
          'review-runs.json + managed host-run projection', { launch: true, parallel: bound.map(launch => nextStepCall(launch.reason, launch.cli!)) });
      }
      return launches[0]!;
    }
    if (waiting.length) return waitStep(base, waiting[0]!, 'Managed reviewer run');
    if (importable.length) return laneImportStep(base, importable);
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

  /**
   * N2 (v4.1 cost plan): the critic's begin → dispatch → review_run_start chain
   * as ONE framework step (review_round_prepare inventoryCritic=true runs the
   * same handlers in-process, each with its own gate; the dispatch is skipped
   * when its binding is already current, exactly as these steps were decided
   * one by one before).
   */
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
    // Lab reroute-mid-inventory: lanes of this round that reran after the
    // critic started (the round's evidence was invalidated and
    // review_round_prepare relaunched them) make that critic stale: its import
    // would be refused, so a fresh critic of the wave reviews the new lanes.
    const roundRuns = ctx.store.readReviewRuns(storyId).runs.filter(run => run.reviewRound === round);
    const criticIndex = roundRuns.findIndex(run => run.reviewRunId === criticRun.reviewRunId);
    const laneAfterCritic = roundRuns.slice(criticIndex + 1).find(run => run.reviewPurpose !== 'inventory-completeness');
    if (laneAfterCritic) {
      const why = `Lane run ${laneAfterCritic.reviewRunId} (${laneAfterCritic.lane.replace('proof-or-stop-review-', '')}) started after critic ReviewRun ${criticRun.reviewRunId}; that critic did not see the rerun lanes and its import would be refused. Start a fresh critic of wave ${binding.wave}.`;
      return criticPrepareStep(base, why, 'review-runs order (lane rerun after critic)');
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
      // A/B control D2-r3/D9-r1: the import of this critic was refused (its
      // findings are kept); proposing it again would loop forever. Run a fresh
      // critic of the same wave instead; its prompt names this refusal.
      // A/B V3 R2A-r2: the same for a refusal before any evidence persisted
      // (refusedManagedReviewImport covers both kinds).
      const refused = refusedManagedReviewImport(ctx.store, storyId, hostRun.runId, receiptId);
      if (!refused) return importStep(base, hostRun, receiptId);
      const why = `The import of critic run ${hostRun.runId} (ReviewRun ${criticRun.reviewRunId}) was refused: ${refused.slice(0, 400)}. Any findings it imported are kept; run a fresh critic of wave ${binding.wave} whose prompt names this refusal (never the same import again).`;
      return criticPrepareStep(base, why, 'process-events inventory_critic_import_refused | managed_review_import_refused');
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
    if (!verdict.ok && LANE_VERDICT_CODES.has(verdict.code ?? '')) {
      const prepare = lanePrepareStep(base);
      if (prepare) return prepare;
    }
    // Lab reroute-mid-inventory: the round was invalidated after a lane
    // reported a finding (owner reroute, broken live binding), every lane
    // reran, and the open finding of the superseded run is now stale_run. It
    // is carried forward, never dropped: it blocks like any open finding and
    // closes by repair, or by the duplicate-coverage run when the rerun
    // re-reported it (supersededRestatementOf). Before, next returned no
    // runnable step here.
    if (!verdict.ok && verdict.code === 'review_evidence_invalid') {
      const carried = supersededOpenFindingIds(storyId);
      if (carried) verdict = { ok: false, code: 'review_finding_blocking', unclosedFindingIds: carried,
        message: `open finding(s) ${carried.join(', ')} of a superseded lane run carried forward (stale_run): ${verdict.message ?? ''}` };
    }
    if (!verdict.ok && verdict.code !== 'review_finding_blocking') {
      // Never a step without a command: delegate the refusal's own command when it names one.
      const hinted = verdict.code !== 'open_review_loop' ? (verdict.message ?? '').match(/proof-or-stop [a-z_]+[^\n;)]*/)?.[0] : undefined;
      if (hinted) {
        return delegated(base, 'agent', `review_verdict_${verdict.code ?? 'error'}`, hinted,
          `REVIEW→TEST verdict refuses [${verdict.code}] with no launchable lane: ${verdict.message ?? ''}`, 'evaluateReviewVerdict');
      }
      return step(base, 'human', `review_verdict_${verdict.code ?? 'error'}`, null,
        `REVIEW→TEST verdict refuses [${verdict.code}] with no launchable lane and no framework recovery: ${verdict.message ?? ''}`, 'evaluateReviewVerdict');
    }

    // 2. A current certification window (PRE_CERT already admitted).
    const inspected = inspectCertificationWindowLineage({ store: ctx.store, storyId, current: currentCertificationIdentity(ctx, storyId) });
    if (!inspected.drift.drifted && windowAuthorizesHeavyCertification(inspected.window, inspected.receipt)) {
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
    // Run 14: one framework step replaces discover → probe → fallback_set → N x
    // autopilot_review_submit on a single host. It records exactly what the
    // escalation / floor evaluators still miss, from current reviewer passes,
    // and refuses (no write) when two review-ready hosts exist.
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
    // N1 (v4.1 cost plan): the delivery reviewer is launched as soon as its own
    // inputs exist (TEST entry + the live-smoke transcript it reads) and does not
    // block the TEST rows that cannot change what it reviews: the authoring of
    // the finish decision / summary and the review-assurance bookkeeping write
    // only material-excluded Story metadata, so the material (and story files)
    // its delivery-check binds stays the final one. Everything that may move the
    // material (done_prepare: main merge / refresh) and DONE itself still wait
    // for it, and DONE's delivery-check row re-checks that binding.
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
      const earlier = hostRuns.some(run => run.agentType === DELIVERY_REVIEWER && run.createdAt >= testEntry);
      return managedLaunchStep(base, 'delivery_review_launch', { ...selection, storyId, agentType: DELIVERY_REVIEWER,
        managedDispatch: true, detach: true, json: true }, bound && !earlier,
      `DONE needs a signed, current delivery-check: ${delivery.detail ?? delivery.label}. Launch the delivery reviewer (managed shown).${previous}`, 'buildDoneChecklist delivery-check');
    }
    // Q6 (b), run 17: every TEST authoring row the DONE oracle still misses is
    // ONE agent step listing each exact command, so the agent writes them in one turn.
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

    /** The review-escalation / assurance-floor bookkeeping step the DONE oracle still misses, or null. */
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

  /**
   * One decision is one synchronous git observation: the gates and readers it
   * consults resolve each identical read-only git probe once (HEAD, material and
   * story-files trees, merge-bases, branch and common-dir probes), exactly as a
   * single gate evaluation does. Nothing survives the call; a git mutation by a
   * consulted reader (metadata auto-commit) clears it.
   */
  function decide(storyId: string): NextStep {
    return withGitTreeObservation(() => decideObserved(storyId));
  }

  function decideObserved(storyId: string): NextStep {
    const story = ctx.store.readStory(storyId);
    const base = { storyId, phase: story.phase };
    switch (story.phase) {
      case 'INIT': return initNext(base);
      case 'INIT_CHECK': return guardStep(base, 'PLAN', 'enter_plan', 'INIT_CHECK is complete (the Story worktree exists): enter PLAN.', 'getGuardFailureReason(PLAN)');
      case 'PLAN': return planNext(base);
      case 'DEV': return devNext(base);
      case 'REVIEW': return reviewNext(base);
      case 'TEST': return testNext(base);
      case 'DONE': return step(base, 'human', 'story_done', null, `Story ${storyId} is DONE; nothing is left in its lifecycle.`, 'story.phase', { done: true });
      default:
        return step(base, 'agent', 'phase_outside_driver', { command: 'session_brief', payload: { concise: true } },
          `next --storyId drives INIT→DONE; ${story.phase} is outside it: follow session_brief.`, 'story.phase');
    }
  }

  return { decide };
}

// ---------------------------------------------------------------------------
// Rendering and --run

function renderPlaceholderHints(hints: Record<string, string> | undefined, indent: string): string[] {
  return Object.entries(hints ?? {}).map(([path, hint]) => `${indent}${path}: ${hint}`);
}

export function renderNextStep(next: NextStep): string {
  const batch = next.batch ?? [];
  return [
    ...(next.wait ? [ownerWaitInstruction()] : []),
    `Next for ${next.storyId} (${next.phase}): ${next.kind} — ${next.reason}`,
    `Why: ${next.why}`,
    ...(batch.length
      ? [
        ...(next.optional ?? []).flatMap(call => [`Optional first: ${call.command}`, ...renderPlaceholderHints(call.placeholderHints, '    ')]),
        `Run all ${batch.length} in one turn (author each <...> value):`,
        ...batch.flatMap((call, index) => [`  ${index + 1}. ${call.command}`, ...renderPlaceholderHints(call.placeholderHints, '     ')]),
      ]
      : next.parallel?.length
      ? [
        `Run all ${next.parallel.length} concurrently (each in its own process, e.g. one exec per command, then wait for all):`,
        ...next.parallel.map((call, index) => `  ${index + 1}. ${call.command}`),
      ]
      : [
        ...(next.placeholders?.length ? ['Author before running (one line each):', ...renderPlaceholderHints(next.placeholderHints, '  ')] : []),
        ...(next.optional ?? []).flatMap(call => [`Optional first: ${call.command}`, ...renderPlaceholderHints(call.placeholderHints, '    ')]),
        next.command ? `Next: ${next.command}` : `Next: ${next.done ? 'none (DONE)' : 'none runnable (see Why)'}`,
      ]),
    ...(next.kind === 'framework' && next.command ? ['(framework step: `proof-or-stop next --storyId=' + next.storyId + ' --run` runs it and prints the following step)'] : []),
  ].join('\n');
}

export interface RunRecord { command: string; reason: string; exit: number; ms: number; tail: string }

export interface RunNextStepsResult {
  executed: RunRecord[];
  /** A refusal or a guard that ended the loop early; null when it ended at an agent/human step or a pause. */
  stopped: string | null;
  /** The wait budget of this call is used while a managed run is still running: run the same command again. */
  paused: string | null;
  next: NextStep;
  /** One short line per executed step (what the text output prints). */
  lines: string[];
  /** Set when the loop ended because the Story worktree now exists outside the cwd: continue there with the budget left. */
  relocatedTo?: string;
  budgetLeftMs?: number;
}

/** The detail an executed step's line carries: a launch's runId, or a wait's first status line. */
function executedDetail(step: NextStep, out: string): string {
  if (step.launch) {
    const runId = out.match(/"runId"\s*:\s*"([^"]+)"/)?.[1];
    return runId ? ` runId=${runId}` : '';
  }
  if (step.wait) {
    const first = out.split('\n').map(line => line.trim()).find(line => line && !line.startsWith('Wait:') && !/^\[\d+(\.\d+)?s\]/.test(line));
    return first ? ` ${first.slice(0, 100)}` : '';
  }
  return '';
}

/**
 * The `next --run` loop, separated from process spawning so its budget and
 * stop rules are testable. Executes consecutive framework steps — gate steps,
 * fully bound managed launches (`launch`) and waits (`wait`) — and stops at
 * the first agent/human step, a refused step, a launch of a target already
 * launched in this call, or maxSteps. A step with `parallel` calls runs them
 * concurrently (executeParallel; N2). All waits of one call share ONE budget
 * (default 285 s, so the call returns inside one 300 s owner yield;
 * PROOF_OR_STOP_OWNER_WAIT_BLOCK_MS raises it, see owner-wait-guidance): each wait
 * gets the remaining budget as waitMs; when it is used, the loop pauses on the
 * wait step and the agent runs the same `next --run` again.
 */
export function runNextSteps(args: {
  storyId: string;
  decide: () => NextStep;
  execute: (call: { command: string; payload: Record<string, unknown> }, step: NextStep) => { exit: number; out: string };
  /** N2: run a step's `parallel` calls concurrently (default: one after another through execute). */
  executeParallel?: (calls: Array<{ command: string; payload: Record<string, unknown> }>, step: NextStep) => Array<{ exit: number; out: string }>;
  now?: () => number;
  waitBudgetMs?: number;
  maxSteps?: number;
  storyGone?: () => boolean;
  /** The Story worktree when a step just created it outside this process's cwd (INIT_CHECK): the loop ends and the caller continues there. */
  relocated?: () => string | null;
  log?: (line: string) => void;
}): RunNextStepsResult {
  const now = args.now ?? Date.now;
  const blockMs = ownerWaitBlockMs();
  const budget = Math.max(1_000, Math.min(blockMs, Math.floor(args.waitBudgetMs ?? blockMs)));
  const maxSteps = Math.max(1, Math.min(100, Math.floor(args.maxSteps ?? 40)));
  const deadline = now() + budget;
  const executed: RunRecord[] = [];
  const lines: string[] = [];
  const launched = new Set<string>();
  let stopped: string | null = null;
  let paused: string | null = null;
  let next = args.decide();
  while (next.kind === 'framework' && next.cli && executed.length < maxSteps) {
    let payload = next.cli.payload;
    if (next.wait) {
      const remaining = deadline - now();
      if (remaining < 5_000) {
        paused = `wait budget of ${budget / 1000} s used; the managed run keeps going: run \`proof-or-stop next --storyId=${args.storyId} --run\` again`;
        break;
      }
      payload = { ...payload, waitMs: remaining };
    }
    const calls = next.parallel?.length ? next.parallel.map(call => call.cli) : [{ command: next.cli.command, payload }];
    if (next.launch) {
      const keys = calls.map(call => JSON.stringify(call.payload));
      if (keys.some(key => launched.has(key))) { stopped = `${next.reason} decided again for the same target after this call launched it; inspect that run (proof-or-stop host_run_status) before relaunching`; break; }
      for (const key of keys) launched.add(key);
    }
    const started = now();
    const runs = calls.length > 1
      ? (args.executeParallel ? args.executeParallel(calls, next) : calls.map(call => args.execute(call, next)))
      : [args.execute(calls[0]!, next)];
    const ms = now() - started;
    const commands = next.parallel?.length ? next.parallel.map(call => call.command) : [next.command!];
    let refused: { exit: number } | null = null;
    runs.forEach((run, index) => {
      executed.push({ command: commands[index]!, reason: next.reason, exit: run.exit, ms, tail: run.out.trim().split('\n').slice(-6).join('\n') });
      const line = `ran: ${next.reason} (${calls[index]!.command})${runs.length > 1 ? ` [${index + 1}/${runs.length} concurrent]` : ''} -> exit ${run.exit}, ${(ms / 1000).toFixed(1)} s${executedDetail(next, run.out)}`;
      lines.push(line);
      args.log?.(line);
      if (run.exit !== 0 && !refused) refused = run;
    });
    if (refused) { stopped = `step refused (exit ${(refused as { exit: number }).exit})`; lines.push(executed.filter(row => row.exit !== 0)[0]!.tail); next = args.decide(); break; }
    if (args.storyGone?.()) {
      // story_advance DONE merged the Story and removed this worktree.
      next = step({ storyId: args.storyId, phase: 'DONE' }, 'human', 'story_done', null,
        `Story ${args.storyId} is DONE: merged into the integration branch and its worktree was removed.`, 'story_advance DONE effects', { done: true });
      break;
    }
    const moved = args.relocated?.() ?? null;
    if (moved) return { executed, stopped: null, paused: null, next, lines, relocatedTo: moved, budgetLeftMs: Math.max(0, deadline - now()) };
    next = args.decide();
  }
  if (!stopped && !paused && next.kind === 'framework' && executed.length >= maxSteps) stopped = `maxSteps=${maxSteps} reached`;
  return { executed, stopped, paused, next, lines };
}

/**
 * N2: spawn every call as its own CLI process at once and wait for all, from
 * synchronous code (the --run loop is synchronous): a tiny node child does the
 * fan-out and returns each exit code and combined output as JSON.
 */
const CONCURRENT_RUNNER = [
  "const { spawn } = require('node:child_process');",
  "const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));",
  'Promise.all(input.calls.map(call => new Promise(done => {',
  "  const child = spawn(process.execPath, [input.entry, call.command, JSON.stringify(call.payload)], { cwd: input.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });",
  "  let out = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { out += chunk; });",
  "  child.on('error', error => done({ exit: -1, out: out + String(error) }));",
  "  child.on('close', code => done({ exit: code ?? -1, out }));",
  '}))).then(results => process.stdout.write(JSON.stringify(results)));',
].join('\n');

export function runCliCallsConcurrently(cliEntry: string, calls: Array<{ command: string; payload: Record<string, unknown> }>): Array<{ exit: number; out: string }> {
  const run = spawnSync(process.execPath, ['-e', CONCURRENT_RUNNER], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 * Math.max(1, calls.length),
    input: JSON.stringify({ entry: cliEntry, cwd: process.cwd(), calls }),
  });
  try {
    const parsed = JSON.parse(run.stdout ?? '') as Array<{ exit: number; out: string }>;
    if (Array.isArray(parsed) && parsed.length === calls.length) return parsed;
  } catch { /* fall through */ }
  const detail = `concurrent runner failed (exit ${run.status ?? -1}): ${(run.stderr ?? '').slice(-400)}`;
  return calls.map(() => ({ exit: run.status || -1, out: detail }));
}

/** Whether any Story of this project is not DONE (an unreadable one counts as unfinished). */
function hasUnfinishedStory(ctx: HandlerContext): boolean {
  let ids: string[];
  try { ids = ctx.store.listStoryIds(); } catch { return true; }
  return ids.some(id => {
    try { return ctx.store.readStory(id).phase !== 'DONE'; } catch { return true; }
  });
}

export function createNextDriverHandlers(ctx: HandlerContext, lookup: HandlerLookup, fallbackNext?: (args: { concise?: boolean }) => string) {
  const driver = createNextDriver(ctx, lookup);
  /**
   * The Story worktree when it exists and this process runs outside it (N4:
   * INIT_CHECK creates it while the owner still sits in the main checkout).
   * Story state after INIT_CHECK lives there, and its gates refuse other cwds.
   */
  function worktreeOutsideCwd(storyId: string): string | null {
    try {
      const path = ctx.store.readStory(storyId).worktree?.path;
      if (!path || !existsSync(path)) return null;
      const target = realpathSync(path);
      const cwd = realpathSync(process.cwd());
      return cwd === target || cwd.startsWith(`${target}${sep}`) ? null : target;
    } catch { return null; }
  }
  /** The same `next` call in the Story worktree (stderr streams through; stdout is returned). */
  function nextIn(cwd: string, payload: NextArgs): { status: number; stdout: string } {
    const run = spawnSync(process.execPath, [process.argv[1]!, 'next', JSON.stringify(payload)], {
      cwd, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
    });
    return { status: run.status ?? -1, stdout: run.stdout ?? '' };
  }
  const worktreeNote = (path: string) => `Story worktree: ${path} (created at INIT_CHECK). Run every following command from there: cd ${path}`;
  function parseNextJson(stdout: string): Record<string, unknown> | null {
    const start = stdout.indexOf('{');
    if (start < 0) return null;
    try { return JSON.parse(stdout.slice(start)) as Record<string, unknown>; } catch { return null; }
  }
  return {
    next(args: NextArgs = {}): string | Record<string, unknown> {
      if (!args.storyId) {
        // N4: with no unfinished Story, the next step is the one story_create template.
        if (!hasUnfinishedStory(ctx)) {
          const template = storyCreateTemplateStep(ctx.root);
          return args.json ? template as unknown as Record<string, unknown> : renderNextStep(template);
        }
        if (!fallbackNext) throw new Error('next: storyId is required');
        return fallbackNext({ concise: args.concise ?? true });
      }
      const storyId = args.storyId.trim();
      if (!isCanonicalStoryId(storyId)) throw new Error(`next: storyId "${storyId}" is not a canonical, path-safe Proof-or-Stop story id`);
      const cliEntry = process.argv[1];
      // A Story with a worktree is decided (and its steps run) from that worktree.
      const outside = cliEntry ? worktreeOutsideCwd(storyId) : null;
      if (outside) {
        const child = nextIn(outside, { ...args, storyId, json: true });
        const parsed = parseNextJson(child.stdout);
        if (!parsed) throw new Error(`next: the call in the Story worktree ${outside} failed (exit ${child.status}): ${child.stdout.slice(-800)}`);
        if (args.json) return { ...parsed, worktree: outside };
        const nested = (args.run ? parsed.next : parsed) as unknown as NextStep;
        return [
          worktreeNote(outside),
          ...(args.run && Array.isArray(parsed.executed) && parsed.executed.length ? [`ran ${parsed.executed.length} step(s) in the Story worktree`] : []),
          ...(parsed.stopped ? [`stopped: ${String(parsed.stopped)}`] : []),
          ...(parsed.paused ? [`paused: ${String(parsed.paused)}`] : []),
          renderNextStep(nested),
        ].join('\n');
      }
      if (!args.run) {
        const next = driver.decide(storyId);
        return args.json ? next as unknown as Record<string, unknown> : renderNextStep(next);
      }
      // --run: execute consecutive framework steps (gate steps, fully bound
      // managed launches, waits under one budget) through the real CLI, every
      // gate of each command in its own process (runNextSteps).
      if (!cliEntry) {
        const next = driver.decide(storyId);
        return args.json ? { schemaVersion: NEXT_STEP_SCHEMA, storyId, executed: [], stopped: 'cli entry unavailable', paused: null, next } : `stopped: cli entry unavailable\n${renderNextStep(next)}`;
      }
      let result: RunNextStepsResult = runNextSteps({
        storyId,
        decide: () => driver.decide(storyId),
        execute: call => {
          const run = spawnSync(process.execPath, [cliEntry, call.command, JSON.stringify(call.payload)], {
            cwd: process.cwd(), env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
          });
          resetConfigCache();
          return { exit: run.status ?? -1, out: `${run.stdout ?? ''}${run.stderr ?? ''}` };
        },
        executeParallel: calls => {
          const results = runCliCallsConcurrently(cliEntry, calls);
          resetConfigCache();
          return results;
        },
        waitBudgetMs: args.waitBudgetMs,
        maxSteps: args.maxSteps,
        storyGone: () => !existsSync(ctx.store.storyDirPath(storyId)),
        relocated: () => worktreeOutsideCwd(storyId),
        // Stream one short line per step (and keep the CLI idle watchdog fed).
        log: ctx.log,
      });
      // N4: INIT_CHECK just created the Story worktree; the rest of this call runs there.
      const relocatedTo = result.relocatedTo;
      if (relocatedTo) {
        const left = Math.max(0, (args.maxSteps ?? 40) - result.executed.length);
        const child = left > 0 && (result.budgetLeftMs ?? 0) >= 5_000
          ? parseNextJson(nextIn(relocatedTo, { storyId, run: true, json: true, waitBudgetMs: result.budgetLeftMs, maxSteps: left }).stdout)
          : parseNextJson(nextIn(relocatedTo, { storyId, json: true }).stdout);
        if (!child) throw new Error(`next: continuing in the Story worktree ${relocatedTo} failed`);
        const running = Array.isArray(child.executed);
        result = {
          executed: [...result.executed, ...(running ? child.executed as RunRecord[] : [])],
          stopped: running ? (child.stopped as string | null) ?? null : null,
          paused: running ? (child.paused as string | null) ?? null : null,
          next: (running ? child.next : child) as unknown as NextStep,
          lines: result.lines,
          relocatedTo,
        };
      }
      if (args.json) {
        return { schemaVersion: NEXT_STEP_SCHEMA, storyId, executed: result.executed, stopped: result.stopped, paused: result.paused, next: result.next,
          ...(relocatedTo ? { worktree: relocatedTo } : {}) };
      }
      return [
        // The streamed lines already reached stderr; repeat them only without a log sink.
        ...(ctx.log ? (result.executed.length ? [`ran ${result.executed.length} step(s), ${(result.executed.reduce((sum, row) => sum + row.ms, 0) / 1000).toFixed(1)} s`] : [])
          : result.lines),
        ...(relocatedTo ? [worktreeNote(relocatedTo)] : []),
        ...(result.stopped ? [`stopped: ${result.stopped}`] : []),
        ...(result.stopped && ctx.log && result.executed.at(-1)?.exit ? [result.executed.at(-1)!.tail] : []),
        ...(result.paused ? [`paused: ${result.paused}`] : []),
        renderNextStep(result.next),
      ].join('\n');
    },
  };
}
