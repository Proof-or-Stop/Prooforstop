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
 *   PLAN    evaluateDevMemoryPreflightGate, missingPlanScopeCheckFailure (the
 *           scope-plan reviewer launch / wait), then getGuardFailureReason(DEV);
 *   TEST single host: singleHostAssuranceReady (handlers/quorum-submit.ts) over
 *           the same escalation / floor evaluators → quorum_submit singleHost.
 * Host runs (managed reviewers, delivery, finding repair) are read from the
 * managed host-run runtime projection only.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import type { HandlerContext } from './context.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import { loadConfig, resetConfigCache } from '../core/config.js';
import { resolveWorkflowPolicy } from '../core/workflow-policy.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { withGitTreeObservation } from '../core/git-tree-observation.js';
import { evaluateDevMemoryPreflightGate, evaluateReviewVerdict, getGuardFailureReason } from '../core/machine.js';
import { missingPlanScopeCheckFailure, SCOPE_PLAN_REVIEWER } from '../core/plan-scope-check-requirement.js';
import { isTerminalChecklistStatus } from '../core/checklist-status.js';
import { unclosedBlockingFindings, resolveEffectiveBlockingSeverities, FINDING_RESOLUTION_PLACEHOLDER } from '../core/finding-closure.js';
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
import { currentPrecertFastIdentity } from './validation-identity.js';
import { evaluateEvidenceChainForStory } from './evidence-chain.js';
import type { EvidenceChainReport } from '../core/evidence-chain-check.js';
import { checklistHasFileDeclarations } from './phase-gates.js';
import { verifyCurrentReviewerDispatchBinding } from '../core/review-run.js';
import { managedHostRunsRoot, readManagedHostRunProjection, readManagedHostRunBinding, managedHostRunReceipt, verifyManagedDispatchDelivery } from '../core/managed-host-run.js';
import { isMaterialExcludedPath } from '../core/material-path-policy.js';
import { hasPersistedManagedReceiptEvidence } from './managed-review-evidence.js';
import { MANAGED_INVENTORY_CRITIC_LANE } from '../core/managed-inventory-critic.js';
import { QUALIFIED_MANAGED_REVIEWER_DEFAULTS } from '../core/managed-reviewer-qualification.js';
import { buildDoneChecklist, type DoneCheckRow } from '../core/done-oracle.js';
import { evaluateReviewAssuranceFloor, buildReviewAssuranceFloorGuidance, buildReviewEscalationGuidance, type ReviewAssuranceGuidance } from '../core/review-assurance-floor.js';
import { evaluateReviewEscalation, assessReviewHostAvailabilityForFallbackEligibility } from '../core/review-escalation.js';
import { evaluateOptionalLiveSmokeTranscript } from '../core/live-smoke-transcript-evidence.js';
import { singleHostAssuranceReady } from './quorum-submit.js';
import type { ReviewRun } from '../core/types.js';
import { OWNER_WAIT_BLOCK_MS, ownerWaitInstruction } from '../core/owner-wait-guidance.js';

type HandlerLookup = (name: string) => ((...args: any[]) => any) | undefined;

/** evaluateReviewVerdict codes that mean a required lane still lacks valid current-round evidence. */
const LANE_VERDICT_CODES = new Set(['review_evidence_missing', 'review_lane_missing', 'review_evidence_invalid', 'review_quorum']);

export const NEXT_STEP_SCHEMA = 'proof-or-stop.next_step.v1';
export const DELIVERY_REVIEWER = 'proof-or-stop-review-delivery';
export const FINDING_REPAIR_AGENT = 'proof-or-stop-finding-repair';
export const IMPLEMENTER_AGENT = 'proof-or-stop-implementer';

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
  /** True for a blocking wait on a detached managed run. */
  wait?: boolean;
  /** True once the Story is DONE. */
  done?: boolean;
}

interface NextArgs { storyId?: string; json?: boolean; run?: boolean; maxSteps?: number; concise?: boolean }

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
  extra: Partial<Pick<NextStep, 'wait' | 'done' | 'placeholders'>> = {},
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
    why,
    source,
    ...(extra.wait ? { wait: true } : {}),
    ...(extra.done ? { done: true } : {}),
  };
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
        terminal: run.terminal !== null, createdAt: run.createdAt });
    } catch { /* not a readable managed run */ }
  }
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId));
}

/** One managed finding-repair run, as the next-driver host-run views list it. */
export interface FindingRepairRunView { runId: string; agentType: string; terminal: boolean; state: string; createdAt: string }

export type FindingRepairState =
  | { repaired: true; runId: string; commit: string }
  | { repaired: false; detail: string };

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
  const bound = args.runs.filter(run => run.agentType === FINDING_REPAIR_AGENT && (!finding.createdAt || run.createdAt >= finding.createdAt))
    .filter(run => {
      try { return readManagedHostRunBinding(root, run.runId).managedDispatchTarget?.findingId === finding.id; } catch { return false; }
    });
  if (bound.length === 0) return { repaired: false, detail: `no managed finding-repair run is bound to ${finding.id}` };
  const completed = bound.filter(run => run.terminal && run.state === 'completed').reverse();
  for (const run of completed) {
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
  return { repaired: false, detail: completed.length
    ? `managed finding-repair run ${completed[0]!.runId} for ${finding.id} completed without a material commit on the Story branch`
    : `the last managed finding-repair run ${last.runId} for ${finding.id} is ${last.state}` };
}

/**
 * One blocking wait on a detached managed run. The command is the compact text
 * status (binding, state, exit, verdict, receipt, next action; never the full
 * --json record) and the step carries the long-yield wait instruction, which
 * renderNextStep prints first (core/owner-wait-guidance.ts).
 */
export function managedRunWaitStep(base: { storyId: string; phase: string }, runId: string, state: string, what: string): NextStep {
  return step(base, 'framework', 'managed_run_wait', { command: 'host_run_status', payload: { runId, untilTerminal: true } },
    `${what} ${runId} is ${state}; block until it is terminal (returns at terminal, up to ${OWNER_WAIT_BLOCK_MS / 1000} s per call).`,
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
function managedSelection(hostRuns: HostRunView[], profile: 'managed_reviewer' | 'managed_dispatch'): Record<string, string> {
  const prior = hostRuns.filter(run => run.profile === profile && run.host).at(-1) ?? hostRuns.filter(run => run.host).at(-1);
  if (prior) {
    return { host: prior.host, ...(prior.model ? { model: prior.model } : {}), ...(prior.reasoningEffort ? { reasoningEffort: prior.reasoningEffort } : {}) };
  }
  const selection = QUALIFIED_MANAGED_REVIEWER_DEFAULTS.codex;
  return { host: 'codex', model: selection.model, reasoningEffort: selection.reasoningEffort };
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
   * the plan and was the refusal nobody had surfaced (run 14). Then the DEV
   * guard's own first failure and its Next line, or story_advance DEV.
   */
  function planNext(base: { storyId: string; phase: string }): NextStep {
    const { storyId } = base;
    if (!evaluateDevMemoryPreflightGate(storyId, ctx.store)) {
      return step(base, 'agent', 'dev_memory_preflight_ack', { command: 'dev_memory_preflight_ack', payload: { storyId } },
        'The DEV-entry gate refuses without the dev-memory preflight acknowledgement [missing_dev_memory_preflight_ack]. Run it now and read the lessons it prints before planning the implementation.',
        'evaluateDevMemoryPreflightGate (DEV-entry gate)');
    }
    // Run 16: the scope-plan reviewer verdict the DEV-entry gate requires
    // (missingPlanScopeCheckFailure, the gate's own predicate). Launched with the
    // owner's own managed selection, or waited on while its run is in flight.
    const story = ctx.store.readStory(storyId);
    const scopeFailure = missingPlanScopeCheckFailure(ctx.store, story, policyOf(storyId));
    if (scopeFailure) {
      const hostRuns = listStoryHostRuns(ctx, storyId);
      const running = hostRuns.filter(run => run.agentType === SCOPE_PLAN_REVIEWER && !run.terminal).at(-1);
      if (running) return waitStep(base, running, 'Scope-plan reviewer run');
      const last = hostRuns.filter(run => run.agentType === SCOPE_PLAN_REVIEWER).at(-1);
      const previous = last && last.state !== 'completed' ? ` The previous scope-plan run ${last.runId} ended ${last.state}.` : '';
      return step(base, 'agent', 'scope_plan_review_launch', { command: 'host_run', payload: { ...managedSelection(hostRuns, 'managed_dispatch'), storyId,
        agentType: SCOPE_PLAN_REVIEWER, managedDispatch: true, detach: true, json: true } },
      `${scopeFailure.split('\n')[0]} Launch the scope-plan reviewer (managed shown); it saves scope-check.json, then rerun story_review.${previous}`,
      'missingPlanScopeCheckFailure (DEV-entry gate)');
    }
    return guardStep(base, 'DEV', 'enter_dev', 'PLAN is complete: the DEV-entry gate admits the Story.', 'getGuardFailureReason(DEV)');
  }

  // -- DEV -----------------------------------------------------------------

  function devNext(base: { storyId: string; phase: string }): NextStep {
    const { storyId } = base;
    const checklist = ctx.store.readChecklist(storyId);
    const open = checklist.items.filter(item => !isTerminalChecklistStatus(item.status));
    const hostRuns = listStoryHostRuns(ctx, storyId);
    const inFlight = (agentType: string) => hostRuns.filter(run => run.agentType === agentType && !run.terminal).at(-1);
    if (open.length > 0) {
      const item = open[0]!;
      if (item.status === 'pending') {
        return step(base, 'framework', 'checklist_item_start', { command: 'checklist_update', payload: { storyId, itemId: item.id, status: 'in_progress' } },
          `${item.id} is pending; mark it in_progress before dispatching its implementer.`, 'checklist.json');
      }
      const running = inFlight(IMPLEMENTER_AGENT);
      if (running) return waitStep(base, running, 'Implementer run');
      return step(base, 'agent', 'implement_item', { command: 'host_run', payload: { ...managedSelection(hostRuns, 'managed_dispatch'), storyId, itemId: item.id,
        agentType: IMPLEMENTER_AGENT, managedDispatch: true, detach: true, json: true } },
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
      const { finding } = findings[0]!;
      // Per finding: only a completed managed repair bound to THIS finding id
      // (with its commit) makes it resolvable; a material change made by the
      // repair of another open finding does not (run 14).
      const repair = managedFindingRepairState({ root: ctx.root, gitCwd: gitCwdOf(storyId), storyId, finding, runs: hostRuns });
      if (!repair.repaired) {
        const repairRun = hostRuns.filter(run => run.agentType === FINDING_REPAIR_AGENT && !run.terminal).at(-1);
        if (repairRun) return waitStep(base, repairRun, 'Finding repair run');
        return step(base, 'agent', 'finding_repair', { command: 'host_run', payload: { ...managedSelection(hostRuns, 'managed_dispatch'), storyId, findingId: finding.id,
          agentType: FINDING_REPAIR_AGENT, managedDispatch: true, detach: true, json: true } },
        `Verified ${finding.severity} finding ${finding.id} is open and not yet repaired (${repair.detail}): repair it in code and commit (managed finding-repair shown).`,
        'unclosedBlockingFindings (core/finding-closure.ts) + managedFindingRepairState');
      }
      const chain = chainOf();
      if (chain.blocking && chain.nextAction) {
        return evidenceChainStep(base, chain, 'The repair changed material, so pinned receipts are stale; refresh them before recording the resolution.');
      }
      return step(base, 'agent', 'finding_resolve', { command: 'finding_resolve', payload: { storyId, findingId: finding.id, resolution: FINDING_RESOLUTION_PLACEHOLDER } },
        `${finding.id} was repaired by managed finding-repair run ${repair.runId} (commit ${repair.commit.slice(0, 12)}) but is still open; closure is required whichever round raised it. Name the repair commit and its passing focused evidence.`,
        'unclosedBlockingFindings (core/finding-closure.ts) + managedFindingRepairState', { placeholders: ['resolution'] });
    }
    const chain = chainOf();
    if (chain.blocking && chain.nextAction) {
      return evidenceChainStep(base, chain, 'The DEV→REVIEW evidence-chain gate would refuse: a must/should receipt is stale or missing.');
    }
    // Advisory items (a changed test no pin selects, a missing should receipt)
    // never become a step of their own: binding a test is the agent's judgment
    // and an extra regression test needs no action (run 16).
    const advisory = evidenceChainAdvisory(chain);
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
    return step(base, 'agent', critic ? 'inventory_critic_launch' : 'review_lane_launch', { command: 'host_run', payload: { ...managedSelection(listStoryHostRuns(ctx, base.storyId), 'managed_reviewer'),
      storyId: base.storyId, agentType: lane, reviewRunId, lane, managedReview: true, detach: true, json: true } },
    critic
      ? `Launch the managed inventory-completeness critic for ReviewRun ${reviewRunId} (it dispositions every verified finding of this wave).`
      : `Launch the managed ${lane.replace('proof-or-stop-review-', '')} reviewer for ReviewRun ${reviewRunId}; launch every prepared lane before waiting.`,
    'review-runs.json + managed host-run projection');
  }

  function importStep(base: { storyId: string; phase: string }, run: HostRunView, receiptId: string): NextStep {
    return step(base, 'framework', 'review_evidence_import', { command: 'managed_review_evidence_import', payload: { runId: run.runId, receiptId } },
      `Managed review run ${run.runId} completed; import its sealed terminal receipt as review evidence.`, 'managed host-run receipt');
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
      if (!hasPersistedManagedReceiptEvidence(ctx.store, storyId, receiptId)) importable.push({ run: hostRun, receiptId });
    }
    if (toLaunch.length) return reviewLaunchStep(base, toLaunch[0]!.lane, toLaunch[0]!.run.reviewRunId, false);
    if (waiting.length) return waitStep(base, waiting[0]!, 'Managed reviewer run');
    if (importable.length) return importStep(base, importable[0]!.run, importable[0]!.receiptId);
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

  /** The inventory critic of an OPEN epoch: dispatch → review_run_start → launch → wait → import. */
  function criticNext(base: { storyId: string; phase: string }, epoch: NonNullable<ReturnType<typeof currentOpenReviewInventory>>, round: string): NextStep {
    const { storyId } = base;
    const critic = MANAGED_INVENTORY_CRITIC_LANE;
    const binding = reviewInventoryPurposeBinding(epoch);
    const criticRun = ctx.store.readReviewRuns(storyId).runs.filter(run => run.reviewRound === round && run.reviewPurpose === 'inventory-completeness'
      && run.inventoryBinding?.epochId === epoch.epochId && run.inventoryBinding?.wave === binding.wave).at(-1);
    if (!criticRun) {
      const dispatched = verifyCurrentReviewerDispatchBinding({ store: ctx.store, storyId, lane: critic, reviewRound: round,
        projectRoot: ctx.root, reviewPurpose: 'inventory-completeness', inventoryBinding: binding });
      if (!dispatched.ok) {
        return step(base, 'framework', 'inventory_critic_dispatch', { command: 'dispatch', payload: { storyId, agentType: critic,
          reviewPurpose: 'inventory-completeness', inventoryEpochId: epoch.epochId, summary: true } },
        `Every required lane of epoch ${epoch.epochId} is terminal; bind the inventory-completeness critic dispatch for wave ${binding.wave}.`, 'review_inventory_status (REVIEW_INVENTORY_CRITIC_INCOMPLETE)');
      }
      return step(base, 'framework', 'inventory_critic_run_start', { command: 'review_run_start', payload: { storyId, agent: critic, lane: critic,
        reviewPurpose: 'inventory-completeness', inventoryEpochId: epoch.epochId, summary: true } },
      `The critic dispatch for epoch ${epoch.epochId} is bound; start its ReviewRun.`, 'review_inventory_status (REVIEW_INVENTORY_CRITIC_INCOMPLETE)');
    }
    const hostRun = hostRunFor(listStoryHostRuns(ctx, storyId), criticRun.reviewRunId);
    if (!hostRun) return reviewLaunchStep(base, critic, criticRun.reviewRunId, true);
    if (!hostRun.terminal) return waitStep(base, hostRun, 'Inventory critic run');
    if (hostRun.state === 'completed') {
      try {
        const receiptId = managedHostRunReceipt(ctx.root, hostRun.runId).receiptId;
        return importStep(base, hostRun, receiptId);
      } catch (error) {
        return step(base, 'agent', 'inventory_critic_receipt_unavailable', null, `Critic run ${hostRun.runId} has no readable receipt: ${message(error)}`, 'managed host-run receipt');
      }
    }
    return step(base, 'framework', 'inventory_critic_run_start', { command: 'review_run_start', payload: { storyId, agent: critic, lane: critic,
      reviewPurpose: 'inventory-completeness', inventoryEpochId: epoch.epochId, summary: true } },
    `Critic run ${hostRun.runId} ended ${hostRun.state}; start a fresh critic ReviewRun and relaunch it.`, 'managed host-run projection');
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
    const details: string[] = [];
    for (const id of ids) {
      const finding = findings.find(row => row.id === id);
      if (!finding) continue;
      const repair = managedFindingRepairState({ root: ctx.root, gitCwd, storyId, finding, runs: hostRuns });
      if (repair.repaired) {
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
    const verdict = evaluateReviewVerdict({ storyId, store: ctx.store, projectRoot: ctx.root, gitCwd });
    if (!verdict.ok && LANE_VERDICT_CODES.has(verdict.code ?? '')) {
      const prepare = lanePrepareStep(base);
      if (prepare) return prepare;
    }
    if (!verdict.ok && verdict.code !== 'review_finding_blocking') {
      return step(base, verdict.code === 'open_review_loop' ? 'human' : 'agent', `review_verdict_${verdict.code ?? 'error'}`, null,
        `REVIEW→TEST verdict refuses [${verdict.code}] with no launchable lane: ${verdict.message ?? ''}`, 'evaluateReviewVerdict');
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
      if (!cheap) {
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
      const blocked = latestBlockedAfterCheap(storyId, cheap.createdAt);
      if (blocked) return blocked;
      return step(base, 'framework', 'certification_begin', { command: 'certification_window_begin', payload: { storyId } },
        'Saturated inventory and a current fast PASS: admit the certification window now, then run the routine suite.', 'PRE_CERT admit predicates');
    }
    // No epoch for this round yet (or it was consumed/cancelled/invalidated).
    return step(base, 'framework', 'inventory_begin', { command: 'review_inventory_begin', payload: { storyId } },
      verdict.ok
        ? `Every required lane of round ${round} has current evidence; open the inventory epoch that certification requires.`
        : `Round ${round} raised verified blocking finding(s); open the inventory epoch that authorizes remediation.`,
      `evaluateReviewVerdict + ${PRE_CERT_INVENTORY_NOT_FINALIZED} precondition`);

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
    if (delivery) {
      const running = hostRuns.filter(run => run.agentType === DELIVERY_REVIEWER && !run.terminal).at(-1);
      if (running) return waitStep(base, running, 'Delivery reviewer run');
      if (/docsPromise entries are unverified/.test(delivery.detail ?? '')) {
        return step(base, 'agent', 'delivery_unverified_promise', { command: 'story_advance', payload: { storyId, phase: 'DEV' } },
          `The delivery reviewer left docs promises unverified: ${delivery.detail}. Rework in DEV (or record a delivery_waiver_add with a >=30-char reason).`, 'buildDoneChecklist delivery-check');
      }
      const last = hostRuns.filter(run => run.agentType === DELIVERY_REVIEWER).at(-1);
      const previous = last && last.state !== 'completed' ? ` The previous delivery run ${last.runId} ended ${last.state}.` : '';
      return step(base, 'agent', 'delivery_review_launch', { command: 'host_run', payload: { ...managedSelection(hostRuns, 'managed_dispatch'), storyId, agentType: DELIVERY_REVIEWER,
        managedDispatch: true, detach: true, json: true } },
      `DONE needs a signed, current delivery-check: ${delivery.detail ?? delivery.label}. Launch the delivery reviewer (managed shown).${previous}`, 'buildDoneChecklist delivery-check');
    }
    if (failing('dev-memory-finish-decision')) {
      return step(base, 'agent', 'dev_memory_finish_decision', { command: 'dev_memory_finish_decision', payload: { storyId, decision: '<captured|no-reusable-lesson|defer-with-reason>',
        reason: '<one sentence: what was learned, or why there is no reusable lesson>' } },
      'DONE refuses without a dev-memory finish decision [missing_dev_memory_finish_decision].', 'buildDoneChecklist dev-memory-finish-decision', { placeholders: ['decision', 'reason'] });
    }
    if (failing('story-summary')) {
      return step(base, 'agent', 'summary_set', { command: 'summary_set', payload: { storyId, changes: '<what changed, >=10 chars>', usage: '<how to use, >=10 chars>',
        expectedOutcome: '<what the user expects to see>', actualTranscript: '<what was observed when run>', outcomeDiff: '<expected vs actual>',
        acceptanceVerdict: 'accepted', outcomeKind: 'success', limitations: '<known limitations or "none — fully covered">', pitfalls: '<pitfall notes, >=10 chars>' } },
      'The profile requires a full story summary before DONE.', 'buildDoneChecklist story-summary',
      { placeholders: ['changes', 'usage', 'expectedOutcome', 'actualTranscript', 'outcomeDiff', 'limitations', 'pitfalls'] });
    }
    for (const id of ['review-escalation', 'review-assurance-floor'] as const) {
      if (!failing(id)) continue;
      const args = { projectRoot: ctx.root, gitCwd, storyId, store: ctx.store };
      const guidance = id === 'review-assurance-floor'
        ? buildReviewAssuranceFloorGuidance(evaluateReviewAssuranceFloor(args))
        : buildReviewEscalationGuidance(evaluateReviewEscalation(args), storyId);
      const next = guidanceStep(base, guidance, id);
      if (next) return next;
    }
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
      case 'PLAN': return planNext(base);
      case 'DEV': return devNext(base);
      case 'REVIEW': return reviewNext(base);
      case 'TEST': return testNext(base);
      case 'DONE': return step(base, 'human', 'story_done', null, `Story ${storyId} is DONE; nothing is left in its lifecycle.`, 'story.phase', { done: true });
      default:
        return step(base, 'agent', 'phase_outside_driver', { command: 'session_brief', payload: { concise: true } },
          `next --storyId drives PLAN→DONE; ${story.phase} is authored work (INIT): follow session_brief.`, 'story.phase');
    }
  }

  return { decide };
}

// ---------------------------------------------------------------------------
// Rendering and --run

export function renderNextStep(next: NextStep): string {
  return [
    ...(next.wait ? [ownerWaitInstruction()] : []),
    `Next for ${next.storyId} (${next.phase}): ${next.kind} — ${next.reason}`,
    `Why: ${next.why}`,
    ...(next.placeholders?.length ? [`Author before running: ${next.placeholders.join(', ')}`] : []),
    next.command ? `Next: ${next.command}` : `Next: ${next.done ? 'none (DONE)' : 'none runnable (see Why)'}`,
    ...(next.kind === 'framework' && next.command ? ['(framework step: `proof-or-stop next --storyId=' + next.storyId + ' --run` runs it and prints the following step)'] : []),
  ].join('\n');
}

interface RunRecord { command: string; exit: number; ms: number; tail: string }

export function createNextDriverHandlers(ctx: HandlerContext, lookup: HandlerLookup, fallbackNext?: (args: { concise?: boolean }) => string) {
  const driver = createNextDriver(ctx, lookup);
  return {
    next(args: NextArgs = {}): string | Record<string, unknown> {
      if (!args.storyId) {
        if (!fallbackNext) throw new Error('next: storyId is required');
        return fallbackNext({ concise: args.concise ?? true });
      }
      const storyId = args.storyId.trim();
      if (!isCanonicalStoryId(storyId)) throw new Error(`next: storyId "${storyId}" is not a canonical, path-safe Proof-or-Stop story id`);
      if (!args.run) {
        const next = driver.decide(storyId);
        return args.json ? next as unknown as Record<string, unknown> : renderNextStep(next);
      }
      // --run: execute consecutive framework steps through the real CLI (every
      // gate of each command runs in its own process), stop at the first
      // agent/human step, a refused step, or maxSteps.
      const maxSteps = Math.max(1, Math.min(50, Math.floor(args.maxSteps ?? 20)));
      const cliEntry = process.argv[1];
      const executed: RunRecord[] = [];
      let next = driver.decide(storyId);
      let stopped: string | null = null;
      while (next.kind === 'framework' && next.cli && executed.length < maxSteps) {
        if (!cliEntry) { stopped = 'cli entry unavailable'; break; }
        const started = Date.now();
        const run = spawnSync(process.execPath, [cliEntry, next.cli.command, JSON.stringify(next.cli.payload)], {
          cwd: process.cwd(), env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        });
        const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
        executed.push({ command: next.command!, exit: run.status ?? -1, ms: Date.now() - started, tail: out.trim().split('\n').slice(-6).join('\n') });
        // Stream progress (and keep the CLI idle watchdog fed) instead of
        // leaving the owner to inspect a silent process with ps.
        ctx.log?.(`ran: ${next.reason} -> exit ${run.status ?? -1} (${Date.now() - started} ms)`);
        resetConfigCache();
        if (run.status !== 0) { stopped = `step refused (exit ${run.status ?? -1})`; next = driver.decide(storyId); break; }
        if (!existsSync(ctx.store.storyDirPath(storyId))) {
          // story_advance DONE merged the Story and removed this worktree.
          next = step({ storyId, phase: 'DONE' }, 'human', 'story_done', null,
            `Story ${storyId} is DONE: merged into the integration branch and its worktree was removed.`, 'story_advance DONE effects', { done: true });
          break;
        }
        next = driver.decide(storyId);
      }
      if (!stopped && next.kind === 'framework' && executed.length >= maxSteps) stopped = `maxSteps=${maxSteps} reached`;
      if (args.json) return { schemaVersion: NEXT_STEP_SCHEMA, storyId, executed, stopped, next };
      return [
        ...executed.map(row => `ran: ${row.command} -> exit ${row.exit} (${row.ms} ms)${row.exit ? `\n${row.tail}` : ''}`),
        ...(stopped ? [`stopped: ${stopped}`] : []),
        renderNextStep(next),
      ].join('\n');
    },
  };
}

