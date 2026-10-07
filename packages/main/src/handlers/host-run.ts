import { MANAGED_DELIVERY_DISPATCH_RUNTIME_POLICY } from '../core/runtime-fact-registry.js';
import { abVariantEvidence, resolveAbVariants, type AbVariantEvidence } from '../core/ab-variants.js';
import { loadConfig } from '../core/config.js';
import { isTerminalChecklistStatus } from '../core/checklist-status.js';
import { renderGroupedFindingRepairSection, renderGroupedItemSection, sharedFileItemGroup, shortFindingId } from '../core/ab-dispatch-grouping.js';
import { hostRunStatusBlocksUntilTerminal, OWNER_WAIT_BLOCK_MS, OWNER_WAIT_YIELD_MS } from '../core/owner-wait-guidance.js';
import { renderHostRunStatusSummary } from './host-run-status-summary.js';
/**
 * B-70e9 CHK-001 / CHK-002 / CHK-007: the `host_run` CLI command.
 *
 * This command has two execution paths. A foreground request is a thin wrapper
 * over core/host-run.ts: it validates args (exactly one of --prompt / --promptFile,
 * canonical host, story/reviewRunId binding), resolves the project-owned cwd,
 * and streams provider output through the caller's passthrough. A detached
 * request instead submits a sealed durable managed run; its independently
 * claimed worker owns provider liveness while callers may attach, poll, or
 * disappear. Formal managed-review runs additionally bind the review tuple at
 * submission; their terminal receipt is imported by the separate managed-review
 * evidence path, never inferred from foreground output.
 *
 * Passthrough routing (F-006):
 *   - text mode -> host stdout chunks go to process.stdout live, host stderr to
 *     process.stderr; the handler does NOT re-print buffered output (no
 *     double-print), so on success it returns an empty string;
 *   - json mode -> ALL host output is routed to process.stderr so process.stdout
 *     stays clean for the single JSON result; the JSON `stdout` field carries only
 *     the bounded usage-parse tail, since the full transcript already streamed to
 *     stderr.
 *
 * Output/exit contract (bounded by the CLI engine, which prints the handler
 * return and forces exit 0 on a normal return):
 *   - text mode, success -> host stdout already streamed live; RETURN '' (nothing
 *     to re-print), usage line to stderr, process exit 0;
 *   - text mode, host failure / cap refusal -> host output already streamed;
 *     usage/refusal line to stderr, THROW a concise error so the process exits
 *     nonzero (the exact host code + refusal reason are in the message);
 *   - json mode -> RETURN the structured result (exitCode, usage, refusal, the
 *     bounded stdout tail, and truncated when the 8 MiB live-output ceiling is
 *     hit are FIELDS); never throws, so machine consumers read exitCode.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { HandlerContext } from './context.js';
import type { FormatArgs } from './verdict.js';
import {
  type HostRunChunk,
  type HostRunHost,
  type HostRunPassthrough,
  type HostRunReasoningEffort,
  type HostRunResult,
  type HostRunRunner,
  type HostRunStoryResolver,
  normalizeHostRunModelSelection,
  resolveQualifiedManagedReviewerSelection,
} from '../core/host-run.js';
import {
  cancelManagedHostRun,
  getManagedHostRunStatus,
  waitManagedHostRuns,
  type ManagedHostRunWaitTarget,
  projectManagedHostRunTerminalResult,
  readManagedHostRunOutput,
  readManagedHostRunResult,
  runManagedHostRunWorker,
  submitManagedHostRun,
  type ManagedHostRunProjection,
  type ManagedHostRunWorkerLauncher,
  MANAGED_HOST_RUN_STATUS_TERMINAL_WAIT_MAX_MS,
} from '../core/managed-host-run.js';
import {
  buildManagedReviewerPrompt,
  managedInventoryCriticCoverage,
  managedReviewerPromptDigest,
  type ManagedReviewCanonicalReportCommand,
  type ManagedReviewCanonicalReportStatus,
  type ManagedReviewFullScanBinding,
} from '../core/managed-review-evidence.js';
import { assertCurrentReviewRunForEvidence } from '../core/review-run.js';
import type { ManagedInventoryCriticCoverage } from '../core/managed-inventory-critic.js';
import { candidateArtifactStaleBindingFields, isNoCorpusOnlyFullScan } from '../core/candidate-spec-routing.js';
import {
  evaluateAcceptanceRolloutForContext,
  evaluateAcceptanceTopologyForContext,
  evaluatePreReviewCheckForContext,
} from './proofstory.js';
import { createStoryDispatchHandlers } from './story-dispatch.js';

export interface HostRunCommandArgs extends FormatArgs {
  idempotencyKey?: string;
  host?: string;
  storyId?: string;
  itemId?: string;
  findingId?: string;
  /** EXPERIMENTAL A/B remediation.grouping=single: all findings of one grouped repair (findingId first). */
  groupFindingIds?: string[];
  /** EXPERIMENTAL A/B implementation.grouping=files: all items of one grouped implementer run (itemId first). */
  groupItemIds?: string[];
  agentType?: string;
  phase?: string;
  prompt?: string;
  promptFile?: string;
  reviewRunId?: string;
  lane?: string;
  timeoutMs?: number;
  deadlineMs?: number;
  detach?: boolean;
  managedReview?: boolean;
  managedDispatch?: boolean;
  model?: string;
  reasoningEffort?: HostRunReasoningEffort;
}

export interface HostRunStatusCommandArgs extends FormatArgs {
  runId?: string;
  targets?: ManagedHostRunWaitTarget[];
  afterGeneration?: number;
  afterSequence?: number;
  waitMs?: number;
  untilTerminal?: boolean;
  /** Full structured record (projection, receipt, live output), like --json. */
  full?: boolean;
}

export interface HostRunCancelCommandArgs extends FormatArgs {
  runId?: string;
  reason?: string;
}

export interface HostRunWorkerCommandArgs {
  runId?: string;
}

interface HostRunOutputStream {
  write(text: string, callback: (error?: Error | null) => void): boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  removeListener(event: 'error', listener: (error: Error) => void): this;
}

/**
 * One late-error guard per physical stream. A capped write can still emit EPIPE
 * after its foreground command returns; keeping the per-run listener would grow
 * without bound when a stream never settles. This shared guard is reference
 * counted by pending writes, so it contains that late event while retaining at
 * most one listener for any stream and disappears once the final write settles.
 */
const lateStreamErrorGuards = new WeakMap<HostRunOutputStream, {
  pending: number;
  listener: (error: Error) => void;
}>();

function retainLateStreamErrorContainment(stream: HostRunOutputStream): () => void {
  let guard = lateStreamErrorGuards.get(stream);
  if (!guard) {
    guard = { pending: 0, listener: () => { /* late EPIPE is intentionally contained */ } };
    lateStreamErrorGuards.set(stream, guard);
    stream.on('error', guard.listener);
  }
  guard.pending += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = lateStreamErrorGuards.get(stream);
    if (!current) return;
    current.pending -= 1;
    if (current.pending <= 0) {
      stream.removeListener('error', current.listener);
      lateStreamErrorGuards.delete(stream);
    }
  };
}

export interface CreateHostRunHandlersOptions {
  /**
   * Test seam: inject a fake host runner. Production uses the async streaming
   * defaultHostRunRunner (core/host-run.ts): child_process.spawn with live
   * chunk passthrough and bounded usage-line retention.
   */
  runner?: HostRunRunner;
  /** Test seam; production launches the hidden detached worker command. */
  launchWorker?: ManagedHostRunWorkerLauncher;
  /** Internal command-smoke seam; production keeps the core 30s maximum. */
  statusWaitCapMs?: number;
  /** Command-smoke seam for deterministic late-settling stream writes. */
  outputStreams?: {
    stdout?: HostRunOutputStream;
    stderr?: HostRunOutputStream;
  };
  /** Command-smoke seam; production preserves the 2s bounded drain cap. */
  streamWriteDrainCapMs?: number;
}

export interface HostRunCommandResult {
  schemaVersion: 'proof-or-stop.host_run.v1';
  host: HostRunHost;
  model: string | null;
  reasoningEffort: HostRunReasoningEffort | null;
  storyId: string | null;
  phase: string;
  agentType: string;
  spawned: boolean;
  blocked: boolean;
  refusalReason: string | null;
  liveRuns: HostRunResult['liveRuns'];
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  usage: HostRunResult['usageSummary'];
  /** F-008: non-null when the live output passthrough failed mid-run (run still completed). */
  passthroughError: string | null;
  runId: string;
  managed: true;
  /** True when the managed live-output journal hit the 8 MiB retention ceiling. */
  truncated: boolean;
}

export interface HostRunDetachResult {
  schemaVersion: 'lattice.host_run.v2';
  detached: true;
  run: ManagedHostRunProjection;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalPositiveInteger(command: string, field: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${command}: --${field} must be a finite positive integer`);
  }
  return value;
}

function optionalNonnegativeInteger(
  command: string,
  field: string,
  value: unknown,
  maximum?: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number'
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value < 0
    || (maximum !== undefined && value > maximum)) {
    const maximumClause = maximum === undefined ? '' : ` <= ${maximum}`;
    throw new Error(`${command}: --${field} must be a finite nonnegative integer${maximumClause}`);
  }
  return value;
}

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function normalizeHost(raw: string): HostRunHost {
  const value = raw.trim().toLowerCase();
  if (value === 'codex') return 'codex';
  if (value === 'grok') return 'grok';
  if (value === 'claude' || value === 'claude-code') return 'claude';
  throw new Error(`host_run: unsupported host "${raw}" (expected codex | claude | grok)`);
}

function projectRootHashFor(root: string): string {
  return `sha256:${createHash('sha256').update(root, 'utf8').digest('hex')}`;
}

/** Format the single stderr usage-summary / refusal line. */
function formatUsageLine(result: HostRunResult): string {
  const u = result.usageSummary;
  if (result.blocked) {
    if (result.refusalReason === 'concurrency_cap_exceeded') {
      const list = (result.liveRuns ?? [])
        .map((r) => `  - pid ${r.pid} ${r.host}${r.storyId ? ` story ${r.storyId}` : ''} agentType ${r.agentType} startedAt ${r.startedAt}`)
        .join('\n');
      return `host_run refused: ${u.reason ?? 'concurrency_cap_exceeded'}${list ? `\n${list}` : ''}`;
    }
    return `host_run refused: ${u.reason ?? result.refusalReason ?? 'blocked'}`;
  }
  if (u.recorded === 'disabled') return 'usage ledger disabled (PROOF_OR_STOP_USAGE_LEDGER=0); no rows recorded';
  if (u.recorded === 'provider-reported') {
    const recordId = u.recordId ? ` (recordId ${u.recordId})` : '';
    return `usage recorded: provider=${u.provider ?? 'unknown'} input=${u.input ?? 'null'} cacheRead=${u.cacheRead ?? 'null'} output=${u.output ?? 'null'}${recordId}`;
  }
  if (u.recorded === 'unavailable') {
    return `usage recorded: unavailable (${u.reason ?? 'no usage surface'})`;
  }
  return `usage: ${u.reason ?? 'not recorded'}`;
}

function syntheticManagedResult(run: ManagedHostRunProjection): HostRunResult {
  const exitCode = run.state === 'completed' ? 0 : run.state === 'cancelled' ? 130 : run.state === 'timed_out' ? 124 : 1;
  return {
    host: run.host,
    model: run.model ?? null,
    reasoningEffort: run.reasoningEffort ?? null,
    storyId: run.storyId,
    phase: run.phase,
    agentType: run.agentType,
    spawned: run.workerPid !== null,
    blocked: false,
    refusalReason: null,
    liveRuns: null,
    exitCode,
    timedOut: run.state === 'timed_out',
    timeoutKind: run.state === 'timed_out' ? 'total_timeout' : null,
    terminalReason: run.state === 'completed' ? 'completed' : run.state === 'cancelled' ? 'aborted' : run.state === 'timed_out' ? 'total_timeout' : 'child_error',
    firstOutputMs: null,
    durationMs: Math.max(0, Date.parse(run.terminal?.terminalAt ?? new Date().toISOString()) - Date.parse(run.createdAt)),
    failureKind: run.state === 'timed_out' ? 'timeout' : run.state === 'completed' ? 'none' : 'unknown',
    stdout: '',
    stderr: '',
    usageSummary: {
      recorded: 'none',
      provider: null,
      input: null,
      cacheRead: null,
      output: null,
      recordId: null,
      reason: run.terminal?.reason ?? `managed_${run.state}`,
    },
    passthroughError: null,
    processIdentity: null,
    replacementSafe: run.replacementSafe,
    residualProcessGroup: !run.replacementSafe,
    processCleanup: run.terminal?.processCleanup ?? null,
    finalAssistantResult: null,
    finalAssistantResultCount: 0,
    finalAssistantResultTruncated: false,
  };
}

function projectManagedTerminalResult(run: ManagedHostRunProjection, persisted: HostRunResult | null): HostRunResult {
  const result = persisted ?? syntheticManagedResult(run);
  return run.terminal
    ? projectManagedHostRunTerminalResult(run.terminal.state, result) ?? syntheticManagedResult(run)
    : result;
}

function reportCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(entry => typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object' && typeof (entry as { code?: unknown }).code === 'string'
        ? (entry as { code: string }).code
        : '')
    .filter(code => /^[A-Za-z0-9_.:-]{1,96}$/.test(code))
    .slice(0, 12);
}

function isManagedReviewReportStatus(
  value: string,
): value is ManagedReviewCanonicalReportStatus['status'] {
  return ['pass', 'fail', 'inconclusive', 'missing'].includes(value);
}

function managedReviewReportStatus(
  command: ManagedReviewCanonicalReportCommand,
  evaluate: () => { status: string; blocking: boolean; diagnostics?: unknown; codes?: unknown },
): ManagedReviewCanonicalReportStatus {
  try {
    const report = evaluate();
    const status = report.status;
    if (!isManagedReviewReportStatus(status)) {
      throw new Error('unsupported canonical report status');
    }
    return {
      command,
      availability: 'available',
      status,
      blocking: report.blocking,
      codes: reportCodes(report.codes ?? report.diagnostics),
    };
  } catch {
    // Do not expose thrown diagnostic text: it can include canonical filesystem
    // paths, and the scratch provider only needs the honest unavailable state.
    return {
      command,
      availability: 'unavailable',
      status: 'unavailable',
      blocking: null,
      codes: ['controller_evaluation_unavailable'],
    };
  }
}

/**
 * Evaluate canonical read-only report projections before a managed provider is
 * launched. This stays in the controller's signed primary worktree; the
 * returned snapshot is deliberately a bounded, path-free provider projection.
 */
export function collectManagedReviewCanonicalReportStatuses(
  ctx: HandlerContext,
  storyId: string,
): ManagedReviewCanonicalReportStatus[] {
  return [
    managedReviewReportStatus('acceptance_topology_check', () => evaluateAcceptanceTopologyForContext(ctx, storyId)),
    managedReviewReportStatus('pre_review_check_read', () => evaluatePreReviewCheckForContext(ctx, storyId)),
    managedReviewReportStatus('acceptance_rollout_report_read', () => evaluateAcceptanceRolloutForContext(ctx, storyId)),
    managedReviewReportStatus('acceptance_rollout_check', () => evaluateAcceptanceRolloutForContext(ctx, storyId)),
  ];
}

export function assertManagedReviewCandidateLaunchReady(
  candidateArtifact: {
    requiresEscalation?: unknown;
    fullScan?: unknown;
    scanEscalationReason?: unknown;
    corpusStatus?: unknown;
    escalationReasons?: unknown;
    materialHash?: unknown;
    storyFilesHash?: unknown;
  },
  storyId: string,
  currentBinding?: { materialHash: string | null | undefined; storyFilesHash: string | null | undefined },
): void {
  if (candidateArtifact.requiresEscalation === true && candidateArtifact.fullScan !== true) {
    const reasons = Array.isArray(candidateArtifact.escalationReasons)
      ? candidateArtifact.escalationReasons.filter((reason): reason is string => typeof reason === 'string' && reason.length > 0)
      : [];
    const renderedReasons = reasons.length > 0 ? reasons.join(', ') : 'unspecified';
    throw new Error(
      `host_run: managed_review_candidate_routing_unresolved: ${renderedReasons}; `
      + 'do not launch a reviewer whose evidence cannot be imported; '
      + `rerun proof-or-stop candidate_spec_route '{"storyId":"${storyId}","fullScanReason":"<specific justified tool-driven broad-scan reason>"}' `
      + 'and then start a fresh ReviewRun',
    );
  }
  if (currentBinding) {
    const stale = candidateArtifactStaleBindingFields({
      artifact: candidateArtifact,
      currentMaterialHash: currentBinding.materialHash,
      currentStoryFilesHash: currentBinding.storyFilesHash,
    });
    if (!currentBinding.materialHash) stale.push('materialHash');
    if (!currentBinding.storyFilesHash) stale.push('storyFilesHash');
    if (stale.length > 0) {
      const routeCommand = candidateArtifact.fullScan === true && !isNoCorpusOnlyFullScan(candidateArtifact)
        ? `proof-or-stop candidate_spec_route '{"storyId":"${storyId}","fullScanReason":"<specific justified tool-driven broad-scan reason>"}'`
        : `proof-or-stop candidate_spec_route '{"storyId":"${storyId}"}'`;
      throw new Error(
        `host_run: managed_review_candidate_binding_stale: ${stale.join(', ')}; `
        + 'do not launch a reviewer whose evidence cannot be imported; '
        + `rerun ${routeCommand} and then start a fresh ReviewRun`,
      );
    }
  }
}

export function createHostRunHandlers(ctx: HandlerContext, options: CreateHostRunHandlersOptions = {}) {
  return {
    async host_run(args: HostRunCommandArgs): Promise<HostRunCommandResult | HostRunDetachResult | string> {
      const host = normalizeHost(normalizeString(args.host));
      if (host === 'grok' && args.managedReview !== true) throw new Error('grok supports only --managedReview / acceptance_amendment_review');
      let selection = normalizeHostRunModelSelection({
        host,
        model: args.model,
        reasoningEffort: args.reasoningEffort,
      });
      const agentType = normalizeString(args.agentType);
      if (!agentType) throw new Error('host_run: --agentType is required');
      const timeoutMs = optionalPositiveInteger('host_run', 'timeoutMs', args.timeoutMs);
      const deadlineMs = optionalPositiveInteger('host_run', 'deadlineMs', args.deadlineMs);
      const storyId = normalizeString(args.storyId) || null;
      const itemId = normalizeString(args.itemId) || null;
      let findingId = normalizeString(args.findingId) || null;
      const reviewRunId = normalizeString(args.reviewRunId) || null;
      const lane = normalizeString(args.lane) || null;

      // Exactly one of --prompt / --promptFile.
      const hasPrompt = typeof args.prompt === 'string' && args.prompt.length > 0;
      const promptFilePath = normalizeString(args.promptFile);
      const hasPromptFile = promptFilePath.length > 0;
      let promptText: string;
      let formalReviewBinding: {
        headHash: string;
        materialHash: string;
        storyFilesHash: string;
        promptHash: string;
        envelopeId: string | null;
        managedPromptDigest: string;
        fullScanEscalationReason?: string;
        inventoryCriticCoverage?: ManagedInventoryCriticCoverage;
        candidateRouting?: { candidateSpecSetDigest: string; corpusDigest: string };
      } | null = null;
      let managedDispatch = false;
      let groupedTarget: { groupFindingIds?: string[]; groupItemIds?: string[]; abVariant: AbVariantEvidence } | null = null;
      if (args.managedReview === true && args.managedDispatch === true) {
        throw new Error('host_run: --managedReview and --managedDispatch are mutually exclusive');
      }
      if (itemId && !(args.managedDispatch === true && agentType === 'proof-or-stop-implementer')) {
        throw new Error(
          'host_run: --itemId is valid only with --managedDispatch and agentType=proof-or-stop-implementer',
        );
      }
      if (findingId && !(args.managedDispatch === true && agentType === 'proof-or-stop-finding-repair')) {
        throw new Error(
          'host_run: --findingId is valid only with --managedDispatch and agentType=proof-or-stop-finding-repair',
        );
      }
      const managedDispatchAgentTypes = [
        'proof-or-stop-implementer',
        'proof-or-stop-finding-repair',
        'proof-or-stop-review-story-init',
        'proof-or-stop-product-reviewer',
        'proof-or-stop-review-scope-plan',
        MANAGED_DELIVERY_DISPATCH_RUNTIME_POLICY.role,
      ];
      const managedDispatchAgentTypeSupported = managedDispatchAgentTypes.includes(agentType);
      const managedDispatchQualifiedReviewer = args.managedDispatch === true
        && agentType !== 'proof-or-stop-implementer'
        && agentType !== 'proof-or-stop-finding-repair'
        && managedDispatchAgentTypeSupported;
      if (args.managedReview === true || managedDispatchQualifiedReviewer) {
        selection = resolveQualifiedManagedReviewerSelection({ host, ...selection });
      }
      if (args.managedReview === true) {
        if (hasPrompt || hasPromptFile) {
          throw new Error('host_run: --managedReview derives the exact prompt from ReviewRun; do not pass --prompt or --promptFile');
        }
        if (!storyId || !reviewRunId || !lane || agentType !== lane) {
          throw new Error('host_run: --managedReview requires storyId, reviewRunId, lane, and agentType equal to that lane');
        }
        const story = ctx.store.readStory(storyId);
        const reviewRun = assertCurrentReviewRunForEvidence(ctx.store, story, ctx.root, lane, reviewRunId);
        const storyFilesHash = reviewRun.storyFilesHash ?? reviewRun.workspaceBinding?.storyFilesHash ?? '';
        if (!storyFilesHash) throw new Error('host_run: --managedReview requires a ReviewRun with storyFilesHash binding');
        const canonicalReportStatuses = collectManagedReviewCanonicalReportStatuses(ctx, storyId);
        const candidateArtifact = ctx.store.readCandidateSpecSet(storyId);
        if (!candidateArtifact) {
          throw new Error(
            'host_run: managed_review_candidate_spec_missing: candidate-spec-set.json is required before managed review; '
            + `run candidate_spec_route for Story ${storyId} and then start a fresh ReviewRun`,
          );
        }
        assertManagedReviewCandidateLaunchReady(candidateArtifact, storyId, {
          materialHash: reviewRun.materialHash,
          storyFilesHash,
        });
        const fullScanBinding: ManagedReviewFullScanBinding | undefined = candidateArtifact?.fullScan === true
          ? (() => {
            if (typeof candidateArtifact.scanEscalationReason !== 'string' || candidateArtifact.scanEscalationReason.length === 0) {
              throw new Error('host_run: full-scan candidate artifact is missing its exact scanEscalationReason');
            }
            return { scanEscalationReason: candidateArtifact.scanEscalationReason };
          })()
          : undefined;
        const promptRoot = reviewRun.workspaceBinding?.metadataRoot ?? ctx.root;
        promptText = buildManagedReviewerPrompt(promptRoot, reviewRun, canonicalReportStatuses, fullScanBinding);
        formalReviewBinding = {
          headHash: reviewRun.headHash,
          materialHash: reviewRun.materialHash,
          storyFilesHash,
          promptHash: reviewRun.promptHash,
          envelopeId: reviewRun.envelopeId ?? null,
          managedPromptDigest: managedReviewerPromptDigest(promptRoot, reviewRun, canonicalReportStatuses, fullScanBinding),
          ...(fullScanBinding ? { fullScanEscalationReason: fullScanBinding.scanEscalationReason } : {}),
          ...(() => { const coverage = managedInventoryCriticCoverage(promptRoot, reviewRun); return coverage ? { inventoryCriticCoverage: coverage } : {}; })(),
          // The route this run reviews against; the worker seals the proposal with it (A/B V3 R2A-r2).
          candidateRouting: { candidateSpecSetDigest: candidateArtifact.artifactDigest, corpusDigest: candidateArtifact.corpusDigest },
        };
      } else if (args.managedDispatch === true) {
        if (hasPrompt || hasPromptFile) {
          throw new Error('host_run: --managedDispatch derives the exact canonical prompt; do not pass --prompt or --promptFile');
        }
        const managedDispatchPhase = agentType === 'proof-or-stop-implementer'
          || agentType === 'proof-or-stop-finding-repair' ? 'DEV'
          : agentType === MANAGED_DELIVERY_DISPATCH_RUNTIME_POLICY.role ? MANAGED_DELIVERY_DISPATCH_RUNTIME_POLICY.phase
            : agentType === 'proof-or-stop-review-scope-plan' ? 'PLAN' : 'INIT';
        if (!managedDispatchAgentTypeSupported) {
          if (agentType.startsWith('proof-or-stop-review-')) {
            throw new Error(
              'host_run: REVIEW lanes use the formal managed-review flow: run candidate_spec_route, '
              + 'run review_run_start for the required lane, then call host_run with managedReview=true and the returned '
              + 'reviewRunId (plus storyId, lane, and agentType equal to that lane). managedDispatch is reserved for '
              + 'controller-owned INIT, PLAN scope, DEV implementer, and TEST delivery roles.',
            );
          }
          throw new Error('host_run: --managedDispatch requires storyId and a supported INIT, PLAN scope, DEV implementer/finding repair, or TEST delivery agentType');
        }
        if (!storyId) {
          throw new Error('host_run: --managedDispatch requires storyId');
        }
        if (agentType === 'proof-or-stop-implementer' && !itemId) {
          throw new Error('host_run: --managedDispatch proof-or-stop-implementer requires exactly one itemId');
        }
        if (agentType === 'proof-or-stop-finding-repair' && !findingId) {
          throw new Error('host_run: --managedDispatch proof-or-stop-finding-repair requires exactly one findingId');
        }
        if (agentType !== 'proof-or-stop-implementer' && itemId) {
          throw new Error(`host_run: --managedDispatch ${agentType} is story-scoped; do not pass itemId`);
        }
        if (agentType !== 'proof-or-stop-finding-repair' && findingId) {
          throw new Error(`host_run: --managedDispatch ${agentType} does not accept findingId`);
        }
        if (reviewRunId || lane || normalizeString(args.phase)) {
          throw new Error('host_run: --managedDispatch derives phase and role binding; do not pass reviewRunId, lane, or phase');
        }
        const story = ctx.store.readStory(storyId);
        if (story.phase !== managedDispatchPhase) {
          throw new Error(`host_run: --managedDispatch ${agentType} requires Story phase ${managedDispatchPhase}, got ${story.phase}`);
        }
        if (agentType === 'proof-or-stop-finding-repair' && findingId) {
          const shortFindingId = findingId.startsWith(`${storyId}:`)
            ? findingId.slice(storyId.length + 1)
            : findingId;
          const finding = ctx.store.readFindings(storyId).findings.find(candidate =>
            candidate.id === findingId || candidate.id === `${storyId}:${shortFindingId}`,
          );
          if (!finding) {
            throw new Error(`host_run: managed finding repair target ${findingId} does not exist in Story ${storyId}`);
          }
          if (finding.status !== 'open') {
            throw new Error(`host_run: managed finding repair target ${finding.id} is not open`);
          }
          findingId = finding.id;
        }
        promptText = createStoryDispatchHandlers(ctx).dispatch({
          storyId,
          agentType,
          ...(itemId ? { itemId } : {}),
          ...(findingId ? { findingId } : {}),
        }).prompt;
        // EXPERIMENTAL A/B grouped dispatch (core/ab-dispatch-grouping.ts); accepted only under its switch.
        const grouped = resolveGroupedManagedDispatch(ctx, { storyId, agentType, itemId, findingId, groupFindingIds: args.groupFindingIds, groupItemIds: args.groupItemIds });
        if (grouped) {
          promptText += `\n${grouped.section.join('\n')}`;
          groupedTarget = grouped.target;
        }
        managedDispatch = true;
      } else if (hasPrompt === hasPromptFile) {
        throw new Error('host_run: provide exactly one of --prompt or --promptFile (or use --managedReview with an exact ReviewRun)');
      } else if (hasPromptFile) {
        try {
          promptText = readFileSync(promptFilePath, 'utf8');
        } catch (err) {
          throw new Error(`host_run: cannot read --promptFile "${promptFilePath}": ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        promptText = args.prompt as string;
      }
      if (promptText.length === 0) {
        throw new Error('host_run: prompt is empty; refuse pre-spawn');
      }

      // Defense in depth (core enforces this too): a reviewRunId must belong to
      // --storyId so a ledger row cannot silently mis-join across stories.
      if (reviewRunId && storyId && !reviewRunId.startsWith(`${storyId}:`)) {
        throw new Error(
          `host_run: reviewRunId "${reviewRunId}" does not belong to story "${storyId}" ` +
          `(a reviewRunId must be "<storyId>:..."); refuse pre-spawn`,
        );
      }
      const json = wantsJson(args);

      // F-005: resolve story phase + existence through the CONFIGURED store, so a
      // project that configures storyDir is honored (the core stays path-free). An
      // explicit --phase never reaches this (the core skips the store entirely).
      const resolveStory: HostRunStoryResolver = (id: string) => {
        try {
          const story = ctx.store.readStory(id);
          const p = typeof story.phase === 'string' && story.phase.length > 0 ? story.phase : null;
          return { phase: p };
        } catch {
          return null; // unknown story per the configured store
        }
      };

      const explicitPhase = normalizeString(args.phase);
      let phase = explicitPhase || 'adhoc';
      if (!explicitPhase && storyId) {
        const story = resolveStory(storyId);
        if (!story) throw new Error(`host_run: unknown story "${storyId}"; refuse pre-spawn`);
        phase = story.phase || 'adhoc';
      }
      const injectedLauncher: ManagedHostRunWorkerLauncher | undefined = options.runner
        ? async request => {
          void runManagedHostRunWorker(request, { runner: options.runner, env: process.env })
            .catch(() => { /* worker persists its own terminal error where possible */ });
          return { pid: process.pid };
        }
        : undefined;
      const submitted = await submitManagedHostRun(
        {
          idempotencyKey: args.idempotencyKey,
          host,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort,
          storyId,
          ...(managedDispatch && agentType === 'proof-or-stop-implementer' && itemId
            ? { managedDispatchTarget: groupedTarget ? { itemId, groupItemIds: groupedTarget.groupItemIds!, abVariant: groupedTarget.abVariant } : { itemId } }
            : managedDispatch && agentType === 'proof-or-stop-finding-repair' && findingId
              ? { managedDispatchTarget: groupedTarget ? { findingId, groupFindingIds: groupedTarget.groupFindingIds!, abVariant: groupedTarget.abVariant } : { findingId } }
            : {}),
          agentType,
          phase,
          promptText,
          reviewRunId,
          lane,
          timeoutMs,
          deadlineMs: deadlineMs ?? timeoutMs,
          cwd: ctx.root,
          root: ctx.root,
          projectRootHash: projectRootHashFor(ctx.root),
          ...(formalReviewBinding
            ? { profile: 'managed_reviewer', reviewBinding: formalReviewBinding, isolateManagedReview: true }
            : managedDispatch ? { profile: 'managed_dispatch' } : {}),
        },
        { launchWorker: options.launchWorker ?? injectedLauncher },
      );
      // Publish the durable identity before either detach returns or foreground
      // attach begins. If the caller disappears while attached, a replacement
      // controller can recover the same worker-owned run through host_run_status
      // instead of launching a duplicate provider.
      ctx.log?.(
        `[host_run] submitted runId=${submitted.runId} state=${submitted.state} `
        + `deadlineAt=${submitted.deadlineAt} attach=${args.detach === true ? 'detached' : 'foreground'}`,
      );
      if (args.detach === true) {
        ctx.log?.(`[host_run] wait: proof-or-stop host_run_status --runId=${submitted.runId} --untilTerminal=true (blocks up to ${OWNER_WAIT_BLOCK_MS / 1000} s per call and returns at terminal; give it a tool yield/shell timeout of ${OWNER_WAIT_YIELD_MS} ms, e.g. Codex write_stdin yield_time_ms=${OWNER_WAIT_YIELD_MS}; do not poll more often)`);
        return { schemaVersion: 'lattice.host_run.v2', detached: true, run: submitted };
      }

      // F-006 / F-008 / F-020: live passthrough. text mode routes host
      // stdout->stdout / stderr->stderr; json mode routes EVERYTHING to stderr so
      // stdout stays clean for the JSON result.
      // F-008: a SYNCHRONOUS write failure is normalized and thrown to the CORE
      // guard, which flips its passthrough-broken flag: delivery stops, the run
      // still completes, and result.passthroughError surfaces the failure honestly.
      // F-020: a real EPIPE (the downstream pipe closed) usually surfaces NOT as a
      // synchronous throw but as an ASYNCHRONOUS 'error' event on process.stdout /
      // process.stderr, which the try/catch below cannot see. The 'error' listeners
      // attached for the duration of the run (below) record the first such failure
      // into `asyncStreamError`; the sink checks it and throws-through so the SAME
      // core passthrough-broken flag flips (delivery stops instead of hammering a
      // dead pipe), and the handler also merges it into the surfaced
      // passthroughError as a backstop for an error that lands after the last chunk.
      let asyncStreamError: string | null = null;
      const stdout = options.outputStreams?.stdout ?? process.stdout;
      const stderr = options.outputStreams?.stderr ?? process.stderr;
      // F-020 / F-024: track a broken STDOUT and STDERR specifically. Any chunk or
      // diagnostic write issued to a stream we already KNOW is broken would queue an
      // async EPIPE 'error' that can fire AFTER the per-call listener is removed
      // (zero listeners -> process crash). We skip those writes instead — honest
      // degradation, since passthroughError already records the failure.
      let stdoutBroken = false;
      let stderrBroken = false;

      // F-020: contain ASYNC stream 'error' events (real EPIPE) for the DURATION of
      // the run. Node terminates the process only when a stream has ZERO 'error'
      // listeners, so simply attaching ours is sufficient containment: we swallow
      // the error and record the first message. Hygiene: exactly our two named
      // listeners are added below and removed with removeListener in the finally
      // — never removeAllListeners, since other code may hold its own listeners on
      // these shared streams. F-024: a write error surfaced through a write CALLBACK
      // folds into the SAME state, so a late EPIPE reported via callback and one
      // reported via the 'error' event are handled identically.
      const recordStreamError = (streamName: 'stdout' | 'stderr') => (err: unknown): void => {
        if (streamName === 'stderr') stderrBroken = true;
        else stdoutBroken = true;
        if (asyncStreamError === null) {
          const message = err instanceof Error ? err.message : String(err);
          asyncStreamError = `host_run passthrough ${streamName} stream error: ${message}`;
        }
      };
      const onStdoutError = recordStreamError('stdout');
      const onStderrError = recordStreamError('stderr');

      // F-024: outstanding-write accounting for the live passthrough AND the final
      // diagnostics, WITHOUT serializing throughput. Every write below is issued as
      // write(text, cb) and is NOT awaited per-chunk; the callback decrements a
      // shared pending counter. drainPending() — awaited by the finally BEFORE the
      // error listeners are removed — resolves once every in-flight write has
      // settled, so a late EPIPE from the FINAL chunk(s) fires while our named
      // 'error' listeners are still attached. This closes the residual window that
      // F-020/F-023 left on fire-and-forget live passthrough writes.
      let pendingWrites = 0;
      const pendingWritesByStream: Record<'stdout' | 'stderr', number> = { stdout: 0, stderr: 0 };
      const releaseLateContainment: Record<'stdout' | 'stderr', (() => void) | null> = { stdout: null, stderr: null };
      let onDrained: (() => void) | null = null;
      let listenersAttached = false;
      let listenerCleanupRequested = false;
      const releaseStreamErrorListeners = (): void => {
        if (!listenerCleanupRequested || !listenersAttached) return;
        // The drain cap bounds command lifetime, not EPIPE containment. Move
        // each still-pending write onto the bounded shared guard before removing
        // this run's listeners; otherwise permanently wedged streams accumulate
        // two listeners per foreground command forever.
        for (const streamName of ['stdout', 'stderr'] as const) {
          if (pendingWritesByStream[streamName] > 0 && !releaseLateContainment[streamName]) {
            releaseLateContainment[streamName] = retainLateStreamErrorContainment(streamName === 'stdout' ? stdout : stderr);
          }
        }
        stdout.removeListener('error', onStdoutError);
        stderr.removeListener('error', onStderrError);
        listenersAttached = false;
      };
      const releaseLateContainmentAfterErrorEvent = (streamName: 'stdout' | 'stderr'): void => {
        const release = releaseLateContainment[streamName];
        if (!release) return;
        // A real Writable may invoke write(cb) before it emits the matching
        // EPIPE 'error' event on a later next-tick. A promise continuation can
        // run before that next-tick when the write callback settles an async
        // host_run, so retain through the next event-loop turn instead. This
        // still releases promptly for successful writes.
        setImmediate(() => {
          if (pendingWritesByStream[streamName] !== 0 || releaseLateContainment[streamName] !== release) return;
          releaseLateContainment[streamName] = null;
          release();
        });
      };
      const settleWrite = (streamName: 'stdout' | 'stderr'): void => {
        pendingWrites -= 1;
        pendingWritesByStream[streamName] -= 1;
        if (pendingWritesByStream[streamName] <= 0) {
          pendingWritesByStream[streamName] = 0;
          releaseLateContainmentAfterErrorEvent(streamName);
        }
        if (pendingWrites <= 0) {
          pendingWrites = 0;
          if (onDrained) {
            const notify = onDrained;
            onDrained = null;
            notify();
          }
          releaseStreamErrorListeners();
        }
      };
      // Defensive cap: a genuinely WEDGED stream (a write that neither flushes nor
      // errors) must never hang host_run. If the cap wins, host_run still returns
      // boundedly, but listener removal waits for the eventual write settlement so
      // a post-return EPIPE cannot crash the foreground CLI.
      const drainCapMs = options.streamWriteDrainCapMs ?? 2000;
      const drainPending = (): Promise<void> => {
        if (pendingWrites <= 0) return Promise.resolve();
        return new Promise<void>((resolve) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            onDrained = null;
            stdoutBroken = true;
            stderrBroken = true;
            resolve();
          }, drainCapMs);
          if (typeof timer.unref === 'function') timer.unref();
          onDrained = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
        });
      };

      // F-006 / F-008 / F-020 / F-024: live passthrough. text mode routes host
      // stdout->stdout / stderr->stderr; json mode routes EVERYTHING to stderr so
      // stdout stays clean for the JSON result. Each chunk write is settle-aware
      // (write + counted callback) but NOT awaited, so throughput is never
      // serialized. A SYNCHRONOUS write failure is still thrown through to the CORE
      // guard (F-008: delivery stops, the run still completes, passthroughError
      // surfaces); an ASYNCHRONOUS 'error' recorded via the callback/listener flips
      // asyncStreamError so the NEXT chunk throws through instead of hammering a dead
      // pipe (F-020).
      const passthrough: HostRunPassthrough = (chunk: HostRunChunk) => {
        if (asyncStreamError !== null) {
          // The stream already emitted an async 'error' — the pipe is gone. Throw
          // through (the same contract as a sync write failure) so the core flips
          // its passthrough-broken flag instead of writing to a broken stream.
          throw new Error(asyncStreamError);
        }
        const toStderr = json || chunk.stream === 'stderr';
        const streamName: 'stdout' | 'stderr' = toStderr ? 'stderr' : 'stdout';
        // Skip a stream already known broken (honest degradation; passthroughError
        // already records the failure) — never queue a fresh write onto a dead pipe.
        if (toStderr ? stderrBroken : stdoutBroken) return;
        const stream = toStderr ? stderr : stdout;
        pendingWrites += 1;
        pendingWritesByStream[streamName] += 1;
        try {
          stream.write(chunk.text, (err) => {
            if (err) recordStreamError(streamName)(err);
            settleWrite(streamName);
          });
        } catch (err) {
          // Rare synchronous throw (e.g. write-after-end): settle the counter, then
          // throw through so the core flips its passthrough-broken flag (F-008).
          settleWrite(streamName);
          throw err instanceof Error ? err : new Error(`host_run passthrough write failed: ${String(err)}`);
        }
      };

      // F-020 / F-023 / F-024: gated, SETTLE-AWARE stderr diagnostics that also join
      // the pendingWrites accounting. Never write to a stderr already known broken
      // (avoids a late async EPIPE 'error' firing with no listener). When we DO
      // write, the promise resolves on the write CALLBACK and the SAME callback
      // decrements the shared counter — so both the per-call await (F-023) AND the
      // unified drainPending() (F-024) cover this write. The crux F-023 case is a
      // quiet text-mode run whose stderr is already closed, where this final usage
      // line is the FIRST stderr write (stderrBroken never opened, nothing skipped
      // it). A callback/synchronous error folds into the SAME broken/async-error
      // state (recordStreamError via onStderrError) and is swallowed — best-effort
      // diagnostics must never turn a completed run into a crash (F-008 contract).
      const emitStderr = (text: string): Promise<void> => {
        if (stderrBroken) return Promise.resolve();
        return new Promise<void>((resolve) => {
          pendingWrites += 1;
          pendingWritesByStream.stderr += 1;
          try {
            stderr.write(text, (err) => {
              if (err) onStderrError(err);
              settleWrite('stderr');
              resolve();
            });
          } catch (err) {
            // Rare synchronous throw — flip broken state and settle.
            onStderrError(err);
            settleWrite('stderr');
            resolve();
          }
        });
      };

      // F-020: attach the async stream-error guards for the DURATION of the run,
      // then remove exactly them in the finally below (never removeAllListeners).
      stdout.on('error', onStdoutError);
      stderr.on('error', onStderrError);
      listenersAttached = true;
      let result: HostRunResult | undefined;
      let jsonPayload: HostRunCommandResult | null = null;
      try {
        let run = submitted;
        let afterSequence = 0;
        let managedPassthroughError: string | null = null;
        let outputTruncated = false;
        const deliverNewFrames = (): void => {
          let hasMore = true;
          while (hasMore) {
            const output = readManagedHostRunOutput({ root: ctx.root, runId: submitted.runId, afterSequence });
            afterSequence = output.nextSequence;
            hasMore = output.hasMore;
            outputTruncated ||= output.truncated;
            for (const frame of output.frames) {
              if (managedPassthroughError) break;
              try {
                passthrough({ stream: frame.stream, text: frame.text });
              } catch (error) {
                managedPassthroughError = error instanceof Error ? error.message : String(error);
              }
            }
            if (managedPassthroughError) break;
          }
        };
        while (!run.terminal) {
          deliverNewFrames();
          const status = await getManagedHostRunStatus({
            root: ctx.root,
            runId: submitted.runId,
            afterGeneration: run.generation,
            waitMs: 30_000,
          });
          run = status.run;
        }
        deliverNewFrames();
        result = projectManagedTerminalResult(run, readManagedHostRunResult(ctx.root, submitted.runId));
        if (!result.passthroughError && managedPassthroughError) result.passthroughError = managedPassthroughError;

        const usageLine = formatUsageLine(result);
        const truncatedWarning = outputTruncated
          ? 'host_run warning: live output truncated=true (8 MiB retention ceiling); omitted tail is not promised\n'
          : null;

        // F-317: do not await diagnostic writes here. A wedged stderr.write would
        // otherwise prevent drainPending's timeout from ever starting. Queue them
        // into the pending-write counter and let finally apply the bound.
        // F-316: snapshot passthroughError only after that bounded settlement.
        if (json) {
          void emitStderr(`${usageLine}\n`);
          jsonPayload = {
            schemaVersion: 'proof-or-stop.host_run.v1',
            host: result.host,
            model: result.model ?? null,
            reasoningEffort: result.reasoningEffort ?? null,
            storyId: result.storyId,
            phase: result.phase,
            agentType: result.agentType,
            spawned: result.spawned,
            blocked: result.blocked,
            refusalReason: result.refusalReason,
            liveRuns: result.liveRuns,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stdout: result.stdout,
            stderr: result.stderr,
            usage: result.usageSummary,
            passthroughError: null,
            runId: submitted.runId,
            managed: true,
            truncated: outputTruncated,
          };
          return jsonPayload;
        }

        const earlyPassthroughError = result.passthroughError ?? asyncStreamError;
        if (earlyPassthroughError) {
          void emitStderr(
            `host_run warning: live output passthrough failed (${earlyPassthroughError}); output delivery degraded but the run and usage recording completed\n`,
          );
        }
        if (truncatedWarning) void emitStderr(truncatedWarning);
        void emitStderr(`${usageLine}\n`);
        if (result.blocked || result.exitCode !== 0 || result.timedOut) {
          if (result.blocked) {
            throw new Error(`host_run refused (${result.refusalReason}); no host was launched`);
          }
          const timeoutNote = result.timedOut ? ' (timed out)' : '';
          throw new Error(`host_run: ${result.host} exited ${result.exitCode}${timeoutNote}`);
        }
        return '';
      } finally {
        // F-024 / F-152: await all in-flight passthrough + diagnostic writes
        // boundedly. If one remains after the cap, settleWrite defers listener
        // cleanup until the late write has had a chance to emit its EPIPE.
        await drainPending();
        if (jsonPayload) jsonPayload.passthroughError = (result?.passthroughError ?? null) ?? asyncStreamError;
        // F-020: listener hygiene — remove exactly our two listeners, leaving any
        // other listeners on these shared streams untouched. This releases now
        // when drained, or on the eventual pending-write callback.
        listenerCleanupRequested = true;
        releaseStreamErrorListeners();
      }
    },

    async host_run_status(args: HostRunStatusCommandArgs) {
      if (args.targets !== undefined) {
        if (args.runId !== undefined || args.afterGeneration !== undefined || args.afterSequence !== undefined) {
          throw new Error('host_run_status: targets cannot be combined with single-run arguments');
        }
        const result = await waitManagedHostRuns({ root: ctx.root, targets: args.targets,
          waitMs: optionalNonnegativeInteger('host_run_status', 'waitMs', args.waitMs, 30_000),
          maxWaitMs: options.statusWaitCapMs });
        if (wantsJson(args)) return result;
        return result.runs.map(({ run, changed }) =>
          `${run.runId} state=${run.state} stage=${run.stage.number}/${run.stage.total}:${run.stage.name} generation=${run.generation} changed=${changed}${run.supervisionDiagnostic ? ` diagnostic=${run.supervisionDiagnostic.code}: ${run.supervisionDiagnostic.action}` : ''}`).join('\n');
      }
      const runId = normalizeString(args.runId);
      if (!runId) throw new Error('host_run_status: --runId is required');
      const afterGeneration = optionalNonnegativeInteger(
        'host_run_status',
        'afterGeneration',
        args.afterGeneration,
      );
      const afterSequence = optionalNonnegativeInteger('host_run_status', 'afterSequence', args.afterSequence);
      const full = wantsJson(args) || args.full === true || String(args.full) === 'true';
      // Text status defaults to one until-terminal wait (core/owner-wait-guidance.ts);
      // machine JSON keeps the explicit 30 s progress poll unless untilTerminal is passed.
      const untilTerminal = hostRunStatusBlocksUntilTerminal(args as unknown as Record<string, unknown>);
      const waitMs = optionalNonnegativeInteger('host_run_status', 'waitMs', args.waitMs,
        untilTerminal ? MANAGED_HOST_RUN_STATUS_TERMINAL_WAIT_MAX_MS : 30_000)
        ?? (untilTerminal ? OWNER_WAIT_BLOCK_MS : undefined);
      const status = await getManagedHostRunStatus({
        root: ctx.root,
        runId,
        afterGeneration,
        waitMs,
        untilTerminal,
        maxWaitMs: options.statusWaitCapMs,
      });
      if (full) {
        const output = readManagedHostRunOutput({
          root: ctx.root,
          runId,
          afterSequence: afterSequence ?? 0,
        });
        return { ...status, output };
      }
      return renderHostRunStatusSummary(ctx.root, status);
    },

    async host_run_cancel(args: HostRunCancelCommandArgs) {
      const runId = normalizeString(args.runId);
      if (!runId) throw new Error('host_run_cancel: --runId is required');
      const run = await cancelManagedHostRun({
        root: ctx.root,
        runId,
        reason: normalizeString(args.reason) || undefined,
      });
      if (wantsJson(args)) return { schemaVersion: 'lattice.host_run_cancel.v1', run };
      return `${run.runId} state=${run.state} cancelRequestedAt=${run.cancelRequestedAt ?? 'none'} replacementSafe=${run.replacementSafe}`;
    },

    async host_run_worker(args: HostRunWorkerCommandArgs): Promise<string> {
      const runId = normalizeString(args.runId);
      if (!runId) throw new Error('host_run_worker: --runId is required');
      await runManagedHostRunWorker({ root: ctx.root, runId });
      return '';
    },
  };
}

/**
 * EXPERIMENTAL A/B grouped managed dispatch. Absent group arguments: null (the
 * production single-target launch). Present: refused unless the matching switch
 * is set (remediation.grouping=single / implementation.grouping=files), the
 * group starts with the bound target, and every member is a current open target.
 */
export function resolveGroupedManagedDispatch(ctx: HandlerContext, args: {
  storyId: string; agentType: string; itemId: string | null; findingId: string | null; groupFindingIds?: unknown; groupItemIds?: unknown;
}): { section: string[]; target: { groupFindingIds?: string[]; groupItemIds?: string[]; abVariant: AbVariantEvidence } } | null {
  const list = (value: unknown, name: string): string[] | null => {
    if (value === undefined || value === null) return null;
    const raw = typeof value === 'string' ? value.split(',') : value;
    if (!Array.isArray(raw) || raw.some(entry => typeof entry !== 'string')) throw new Error(`host_run: --${name} must be a list of ids`);
    return [...new Set(raw.map(entry => (entry as string).trim()).filter(Boolean))];
  };
  const findingGroup = list(args.groupFindingIds, 'groupFindingIds');
  const itemGroup = list(args.groupItemIds, 'groupItemIds');
  if (!findingGroup && !itemGroup) return null;
  let variants;
  try { variants = resolveAbVariants(loadConfig(ctx.root)); } catch (error) { throw new Error(`host_run: grouped dispatch refused: ${error instanceof Error ? error.message : String(error)}`); }
  const evidence = abVariantEvidence(variants);
  if (findingGroup) {
    if (itemGroup || args.agentType !== 'proof-or-stop-finding-repair' || !args.findingId) throw new Error('host_run: --groupFindingIds is valid only for a managed proof-or-stop-finding-repair with findingId');
    if (variants.remediationGrouping !== 'single' || !evidence) throw new Error('host_run: --groupFindingIds requires the experimental A/B switch remediation.grouping="single" in proof-or-stop.config.json');
    const findings = ctx.store.readFindings(args.storyId).findings;
    const resolved = findingGroup.map(id => findings.find(row => row.id === id || row.id === `${args.storyId}:${shortFindingId(args.storyId, id)}`));
    if (resolved.some(row => !row || row.status !== 'open')) throw new Error('host_run: every --groupFindingIds member must be an open finding of this Story');
    const ids = [...new Set(resolved.map(row => row!.id))];
    if (ids[0] !== args.findingId || ids.length < 2) throw new Error('host_run: --groupFindingIds must list findingId first and at least one other finding');
    return { section: renderGroupedFindingRepairSection(args.storyId, args.findingId, ids.map(id => findings.find(row => row.id === id)!)),
      target: { groupFindingIds: ids, abVariant: evidence } };
  }
  if (args.agentType !== 'proof-or-stop-implementer' || !args.itemId) throw new Error('host_run: --groupItemIds is valid only for a managed proof-or-stop-implementer with itemId');
  if (variants.implementationGrouping !== 'files' || !evidence) throw new Error('host_run: --groupItemIds requires the experimental A/B switch implementation.grouping="files" in proof-or-stop.config.json');
  const items = ctx.store.readChecklist(args.storyId).items;
  const primary = items.find(item => item.id === args.itemId);
  if (!primary || itemGroup![0] !== args.itemId || itemGroup!.length < 2) throw new Error('host_run: --groupItemIds must list itemId first and at least one other item');
  const group = sharedFileItemGroup(primary, items.filter(item => !isTerminalChecklistStatus(item.status)));
  const allowed = new Set(group.map(item => item.id));
  if (itemGroup!.some(id => !allowed.has(id))) throw new Error('host_run: every --groupItemIds member must be an open item sharing a declared file with itemId');
  return { section: renderGroupedItemSection(args.storyId, args.itemId, itemGroup!.map(id => items.find(item => item.id === id)!)),
    target: { groupItemIds: itemGroup!, abVariant: evidence } };
}
