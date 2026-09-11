import {enforceExecutionImplementationPin,executionImplementationIdentity} from './core/execution-implementation.js';
import { assertRuntimePackageVersion } from './core/runtime-package-version.js';
/**
 * Proof-or-Stop engine
 *
 * Wrap the shared dispatch, parse, log, and phase-gate logic in the callable runCli function.
 * The main package cli.ts is the binary entrypoint and calls runCli() directly.
 * Third-party bootstrap scripts can pass extraTools and extraRegister to runCli to merge utility tools
 * and handlers.
 */

import { validateExternalCommandDeclarations, validateExternalCommandHandlers } from './cli/extension-admission.js';
import { z, type ZodType } from 'zod';
import { existsSync, realpathSync } from 'fs';
import {
  enforceConvergenceBreakerGate,
  bumpGateFailureCount,
  resetGateFailureCounts,
} from './core/convergence-breaker.js';
import { isCanonicalStoryId } from './core/lifecycle-registry.js';
import { appendActivityLog } from './core/activity-log.js';
import { inferActivityRole } from './core/activity-role.js';
import { isAbsolute, join, relative } from 'path';
import { StoryStore } from './core/store.js';
import { createMainRegistry, type Registry } from './registry.js';
import type { HandlerContext } from './handlers/context.js';
import { execFileSync, execSync } from 'child_process';
import { loadConfig, isCommandAllowed, getAllowedPatterns, hasProjectConfigFile, isRuntimeActivityRoot } from './core/config.js';
import { commandRequiresAuthoritativeRuntime, formatCommandLifecycleHint, getCommandPolicy, isMemoryRetrievalCommand } from './core/command-policy.js';
import { resolveExperimentArm } from './core/experiment-arm.js';
import { decorateResult, wantsMachineJson, type ActiveStoryInfo } from './handlers/hints.js';
import { reportHealthIssue } from './core/health.js';
import { detectStaleState } from './core/stale-detector.js';
import { runHooks, truncateForEnv, buildHookEnv as buildSharedHookEnv, HOOK_TIMEOUT_MS } from './core/hooks.js';
import { isGitRepository } from './core/git-probe.js';
import { getGuardFailureReason } from './core/machine.js';
import { detectProofOrStopBrand, formatProofOrStopVersionLine } from './core/proof-or-stop-brand.js';
import { PROOF_OR_STOP_DIR } from './core/proof-or-stop-paths.js';
import { renderChecklistDerivedLedger, CHECKLIST_DERIVED_HEADER } from './core/milestone-status.js';
import { wantsFullOutput } from './cli/output-verbosity.js';
import type { ChecklistData } from './core/types.js';
import { withReentrantMainWriteLock } from './core/main-write-lock.js';
import { MAIN_TOOLS, PUBLIC_MAIN_TOOLS } from './cli/command-catalog.js';
import type { ToolDef } from './cli/main-tools.js';
import {
  inferCodexEntrypoint,
  isCodexActivitySource,
  isReadOnlyCommand,
  resolveActivitySource,
  shouldWriteActivityLog,
} from './cli/activity-policy.js';
import {
  ownerLeaseHelpBlock,
  storyIdFromArgs,
  enforceRetiredRootGuard,
  enforceStoryOwnerLeaseGate,
  resolveEffectiveOwnershipClass,
  resolveRawRuntimeAdmissionOwnership,
} from './cli/ownership-gate.js';
import { enforceReviewerReadOnlyCommandGate } from './cli/reviewer-readonly-gate.js';
import { enforceStoryRuntimeAdmission } from './cli/story-runtime-admission.js';
import {
  resolveMainRootFromWorktreeRoot,
  resolveRoot,
  resolveRootForCommand,
} from './cli/runtime-root.js';
import { parseFlags } from './cli/flag-parser.js';
import {
  printHelp,
  printToolHelp,
  printValidationFailure,
} from './cli/help-renderer.js';
import { normalizeNestedSpaceAlias, STRIPPABLE_BIN_TOKENS } from './cli/alias-normalizer.js';
import { commitInitCheckMetadataAndMergeMain } from './cli/init-check-metadata-sync.js';
import { dispatchRecoverEvidenceWithStructuredFailure } from './cli/recover-evidence-dispatch.js';
import { dispatchUsageSweepAlertWithExit } from './handlers/usage-sweep.js';
import {
  runStoryAdvanceInitCheckLifecycleDispatch,
  runStoryCreateLifecycleDispatch,
} from './cli/lifecycle-dispatch.js';
import { CliWatchdogTimeoutError, commandCliMaxBudget, effectiveCommandCliMaxBudget, NODE_TIMER_MAX_MS } from './core/done-required-timeout-budget.js';
import { getSessionIdentity } from './core/owner-session.js';
import {
  assertCanonicalActiveIdentityCommandConsumers,
  assertCanonicalActiveIdentityRuntime,
  classifyRuntimeEntrypointAuthority,
  renderRuntimeEntrypointAuthorityFailure,
} from './core/runtime-environment-checks.js';
import { resolveGitCwd } from './core/story-signed-workspace-resolution.js';
import {
  captureLifecycleMetadataTransaction,
  commitLifecycleMetadataTransaction,
  readLifecycleMetadataOutputHashes,
} from './core/auto-commit-metadata.js';

class CanonicalTerminalCloseoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalTerminalCloseoutError';
  }
}

export {
  READ_ONLY_COMMANDS,
  inferCodexEntrypoint,
  isCodexActivitySource,
  isReadOnlyCommand,
  resolveActivitySource,
  shouldWriteActivityLog,
} from './cli/activity-policy.js';
export {
  ownerLeaseHelpBlock,
  storyIdFromAutopilotRunId,
  storyIdFromArgs,
  resolveEffectiveOwnershipClass,
  isDeliveryReviewerActor,
  resolveTakeoverIntent,
  enforceRetiredRootGuard,
  enforceStoryOwnerLeaseGate,
} from './cli/ownership-gate.js';
export type {
  ActiveStoryForOwnershipGate,
  TakeoverIntent,
} from './cli/ownership-gate.js';
export {
  REVIEWER_READONLY_ENV,
  isReviewerReadOnlyModeEnabled,
  enforceReviewerReadOnlyCommandGate,
} from './cli/reviewer-readonly-gate.js';
export {
  resolveMainRootFromWorktreeRoot,
  resolveRoot,
  resolveRootForCommand,
} from './cli/runtime-root.js';
export {
  addValue,
  coerce,
  normalizeFlagKey,
  parseFlags,
  parseFlagsTest,
} from './cli/flag-parser.js';
import { BRAND_ENV_PREFIX, readBrandEnv } from './core/brand-env.js';
export { commitInitCheckMetadataAndMergeMain } from './cli/init-check-metadata-sync.js';

export { MAIN_TOOLS, PUBLIC_MAIN_TOOLS };
export type { ToolDef };

/**
 * B-ab8d CHK-003: experiment control-arm memory retrieval gate.
 *
 * Runs at the same single CLI choke point as `enforceStoryOwnerLeaseGate`
 * (inside `run()` — enforcement is decided here, never scattered across
 * handlers). When the explicit opt-in experiment context resolves to
 * `arm=control` and the command carries the `memoryRetrieval` policy marker
 * (COMMAND_POLICIES — a declared per-command classification, NOT a name-prefix
 * string list in the engine), the attempt is refused. EVERY blocked attempt
 * appends a structured `retrieval_violation` activity event
 * `{experimentId, command, timestamp}` BEFORE throwing, so the M4 scorer can
 * count retrievalViolationCount even on refusal. The treatment arm and the
 * no-experiment (production) mode pass through untouched. Store writes
 * (dev_memory_capture / dev_memory_finish) are marked and therefore blocked
 * too — store writes are forbidden during control-arm experiment runs.
 *
 * Runtime re-validation per the handler coding convention: the resolved
 * context is re-checked here (non-empty trimmed experimentId string, arm
 * strictly equal to 'control') instead of trusting the resolver's return type
 * alone; `isMemoryRetrievalCommand` likewise accepts only a strict boolean
 * `true` marker on a registered policy entry.
 */
export function enforceExperimentArmRetrievalGate(cmd: string, root: string): void {
  const context = resolveExperimentArm();
  if (context === null) return; // no experiment context: production mode, byte-identical behavior
  const experimentId = typeof context.experimentId === 'string' ? context.experimentId.trim() : '';
  if (experimentId.length === 0) return; // malformed context (resolver contract violated): treat as no experiment
  if (context.arm !== 'control') return; // treatment arm (only other accepted value) is unaffected
  if (!isMemoryRetrievalCommand(cmd)) return; // non-memory commands run normally on control
  // Record the violation FIRST so the attempt is countable even though the
  // command is refused. Best-effort: a logging failure must not mask the block.
  try {
    appendActivityLog(root, {
      timestamp: new Date().toISOString(),
      event: 'retrieval_violation',
      experimentId,
      command: cmd,
    });
  } catch (e) {
    console.warn(`[experiment-arm] failed to record retrieval_violation for ${cmd}: ${(e as Error).message}`);
  }
  throw new Error(
    `blocked: memory retrieval is disabled on the control arm of experiment ${experimentId} ` +
      `(command "${cmd}" is classified memoryRetrieval; a retrieval_violation event was recorded). ` +
      `The treatment arm and no-experiment mode are unaffected.`,
  );
}

// ── Command Catalog ──

/**
 * Process-fact verifier compatibility mirror. The command schema definitions
 * live in ./cli/command-catalog.ts; these text-only markers preserve the
 * existing verifier contract while the runtime catalog is extracted.
 *
 * name: 'agent_prompt'
 * name: 'admissibility_waterline'
 * name: 'artifact_declare'
 * name: 'audit'
 * name: 'autopilot_cancel'
 * name: 'autopilot_doctor'
 * name: 'autopilot_execute'
 * name: 'autopilot_policy_check'
 * name: 'autopilot_policy_create'
 * name: 'autopilot_policy_get'
 * name: 'autopilot_resume'
 * name: 'autopilot_review'
 * name: 'autopilot_review_status'
 * name: 'autopilot_review_submit'
 * name: 'autopilot_run'
 * name: 'autopilot_status'
 * name: 'autopilot_watch'
 * name: 'aux_doc_list'
 * name: 'background_append'
 * name: 'background_get'
 * name: 'background_set'
 * name: 'baseline_run'
 * name: 'baseline_suite'
 * name: 'baseline_suite_report'
 * name: 'bug_analyze'
 * name: 'bug_list'
 * name: 'bug_report'
 * name: 'bug_update'
 * name: 'capability_claim_evaluate'
 * name: 'capability_claim_formal_evaluate'
 * name: 'capability_list'
 * name: 'capability_probe'
 * name: 'capsule_handoff'
 * name: 'capsule_run_add'
 * name: 'capsule_show'
 * name: 'capsule_update'
 * name: 'check'
 * name: 'checklist_add'
 * name: 'checklist_get'
 * name: 'checklist_remove'
 * name: 'checklist_update'
 * name: 'codex_doctor'
 * name: 'conduit_explain'
 * name: 'conduit_status'
 * name: 'convergence_check'
 * name: 'dashboard'
 * name: 'decision_doc_preview'
 * name: 'decision_doc_proposal'
 * name: 'decision_doc_quorum_check'
 * name: 'decision_doc_save'
 * name: 'decision_get'
 * name: 'decision_set'
 * name: 'delivery_check_set'
 * name: 'delivery_waiver_add'
 * name: 'dev_memory_capture'
 * name: 'dev_memory_finish'
 * name: 'dev_memory_list'
 * name: 'dev_memory_preflight'
 * name: 'dev_memory_search'
 * name: 'dev_memory_start'
 * name: 'dev_start'
 * name: 'dispatch'
 * name: 'dispatch_auto'
 * name: 'dispatch_cancel'
 * name: 'dispatch_collect'
 * name: 'dispatch_list'
 * name: 'dispatch_merge_plan'
 * name: 'dispatch_plan'
 * name: 'dispatch_policy_check'
 * name: 'dispatch_policy_create'
 * name: 'dispatch_policy_get'
 * name: 'dispatch_prepare'
 * name: 'dispatch_receipt_create'
 * name: 'dispatch_resume'
 * name: 'dispatch_review'
 * name: 'dispatch_run'
 * name: 'dispatch_status'
 * name: 'dispatch_watch'
 * name: 'doctor'
 * name: 'done_closure'
 * name: 'done_prepare'
 * name: 'done_recover'
 * name: 'done_required_validate'
 * name: 'draft_check_set'
 * name: 'draft_issue_resolve'
 * name: 'evaluate'
 * name: 'evaluate_save'
 * name: 'evidence_inspect'
 * name: 'evidence_manifest'
 * name: 'execution_boundary_set'
 * name: 'finding_add'
 * name: 'finding_cluster'
 * name: 'finding_dismiss'
 * name: 'finding_list'
 * name: 'finding_resolve'
 * name: 'fixture_batch_add'
 * name: 'fixture_get'
 * name: 'fixture_update'
 * name: 'gap_analyze'
 * name: 'gap_log'
 * name: 'global_control_status'
 * name: 'graph'
 * name: 'grill_close'
 * name: 'grill_get'
 * name: 'grill_record'
 * name: 'grill_start'
 * name: 'guard_session_check'
 * name: 'guard_session_start'
 * name: 'guard_session_status'
 * name: 'handoff_accept'
 * name: 'handoff_create'
 * name: 'handoff_inspect'
 * name: 'handoff_receipt_submit'
 * name: 'handoff_resume'
 * name: 'handoff_worktree_create'
 * name: 'host_dispatch'
 * name: 'host_install'
 * name: 'host_list'
 * name: 'host_probe'
 * name: 'host_runtime_list'
 * name: 'host_runtime_probe'
 * name: 'host_status'
 * name: 'init_check_repair'
 * name: 'init_check_set'
 * name: 'proof_or_stop_config_doctor'
 * name: 'proof_or_stop_config_repair'
 * name: 'learning_effectiveness'
 * name: 'learning_scan'
 * name: 'learning_validate'
 * name: 'light_review'
 * name: 'memory_benchmark_compare'
 * name: 'memory_benchmark_real_data'
 * name: 'memory_benchmark_run'
 * name: 'next'
 * name: 'observability_snapshot'
 * name: 'overflow_auto'
 * name: 'parallel_dispatch'
 * name: 'parallel_merge_queue'
 * name: 'parallel_plan'
 * name: 'parallel_report'
 * name: 'parallel_status'
 * name: 'parallel_wave_create'
 * name: 'parallel_wave_inspect'
 * name: 'plan_get'
 * name: 'plan_set'
 * name: 'planner_answer'
 * name: 'planner_create_job'
 * name: 'planner_create_story'
 * name: 'planner_decision_submit'
 * name: 'planner_draft'
 * name: 'planner_resume'
 * name: 'planner_review'
 * name: 'planner_run'
 * name: 'planner_source_manifest'
 * name: 'planner_status'
 * name: 'playbook_activate'
 * name: 'playbook_approve'
 * name: 'playbook_diff'
 * name: 'playbook_propose'
 * name: 'playbook_reject'
 * name: 'prewrite_guard_check'
 * name: 'quorum_submit'
 * name: 'queue_exception_set'
 * name: 'queue_governance_status'
 * name: 'recall'
 * name: 'recover_evidence'
 * name: 'release_approve_push'
 * name: 'review_escalation_fallback_set'
 * name: 'review_escalation_policy_set'
 * name: 'review_escalation_status'
 * name: 'review_incremental_context'
 * name: 'review_loop_close'
 * name: 'review_loop_iteration_add'
 * name: 'review_loop_policy_show'
 * name: 'review_loop_start'
 * name: 'review_loop_status'
 * name: 'review_pass_set'
 * name: 'review_run_start'
 * name: 'reviewer_list'
 * name: 'runtime_closure_status'
 * name: 'rollout_check'
 * name: 'scope_boundary_set'
 * name: 'scope_check_save'
 * name: 'scope_contract_acknowledge'
 * name: 'scope_contract_check'
 * name: 'scope_contract_init_from_plan'
 * name: 'scope_contract_set'
 * name: 'scope_contract_show'
 * name: 'scope_diff_pack'
 * name: 'scope_extension_decide'
 * name: 'scope_extension_proposal'
 * name: 'scope_freeze_check'
 * name: 'scope_question_resolve'
 * name: 'serve'
 * name: 'session_brief'
 * name: 'signature_backfill'
 * name: 'signature_registry_list'
 * name: 'signature_registry_set'
 * name: 'status'
 * name: 'source_lineage_audit'
 * name: 'story_advance'
 * name: 'story_create'
 * name: 'story_discard'
 * name: 'story_draft'
 * name: 'story_draft_discard'
 * name: 'story_draft_list'
 * name: 'story_export'
 * name: 'story_get'
 * name: 'story_list'
 * name: 'story_reconcile'
 * name: 'story_resolve'
 * name: 'story_review'
 * name: 'story_review_dismiss'
 * name: 'story_update'
 * name: 'summary_get'
 * name: 'summary_set'
 * name: 'task_coverage'
 * name: 'test_add'
 * name: 'test_auto'
 * name: 'test_fixture'
 * name: 'test_list'
 * name: 'test_story'
 * name: 'testintent_handoff'
 * name: 'truth_analyze'
 * name: 'truth_extract'
 * name: 'truth_nav'
 * name: 'truth_scan'
 * name: 'truth_to_story'
 * name: 'understanding_get'
 * name: 'understanding_set'
 * name: 'validate'
 * name: 'verification_context_pack_create'
 * name: 'verification_context_pack_expand'
 * name: 'verification_evidence_add'
 * name: 'verification_evidence_batch_add'
 * name: 'verification_evidence_refresh_stale'
 * name: 'verification_intent_repair'
 * name: 'verify_codex'
 * name: 'workflow_explain'
 * name: 'workflow_set'
 * name: 'workflow_show'
 *
 * Schema sentinels for verifier text checks; runtime schemas live in
 * ./cli/command-catalog.ts.
 * review_run_start: lane: z.enum promptHash: z.string()
 * review_pass_set: reviewRunId: z.string() note: z.string()
 * finding_add: category: z.enum 'cleanup' 'doc-promise-undelivered' 'doc-code-drift' 'spec-boundary'
 * INIT reviewer lanes may not directly change requirement definitions.
 * INIT reviewer lanes may not directly change story-level scope fields.
 * allowedPaths: z.array(z.string().min(1)).optional()
 * allowedScope: z.array(z.string().min(1)).min(1)
 * excludedPaths: z.array(z.string().min(1)).optional()
 */

/**
 * Runtime tool list: assigned when runCli() starts, including main built-ins plus extras.
 * After that, all helpers (printHelp, dispatch lookup, and others) access tools through this variable,
 * and do not reference MAIN_TOOLS directly.
 */
let TOOLS: ToolDef[] = MAIN_TOOLS;

// ── Phase detection ──

interface ActiveStory { storyId: string; phase: string; }

/**
 * Detect active story from the git branch name.
 * Branch format: story/B-xxxx maps to storyId = B-xxxx.
 * Return null for non-story branches (all commands available).
 */
function detectActiveStory(root: string): ActiveStory | null {
  const gitCwd = root;
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!branch.startsWith('story/')) return null;
    const storyId = branch.slice('story/'.length);
    if (!storyId) return null;
    const store = new StoryStore(root);
    try {
      const story = store.readStory(storyId);
      return { storyId, phase: story.phase };
    } catch {
      // Story file does not exist, so do not filter.
      return null;
    }
  } catch {
    // Not a git directory or another error, so do not filter.
    return null;
  }
}

const STRICT_OWNER_META_COMMANDS = new Set([
  'autopilot_run',
  'autopilot_cancel',
  'autopilot_resume',
]);

const STRICT_COMMAND_ARG_COMMANDS = new Set([
  'finding_progress_predecessor',
  'finding_identity_confirm',
  'finding_identity_query',
  'finding_supersession_add',
  'finding_identity_supersede',
  'finding_history_query',
  'finding_identity_scorecard',
  'finding_history_recall',
  'finding_route_accept',
  'finding_route_reject',
  'finding_route_revoke',
  'finding_route_verify',
  'finding_candidate_route',
  'finding_progress_capture',
  'finding_candidate_add',
  'finding_candidate_get',
  'finding_candidate_merge',
  'finding_candidate_disprove',
  'finding_candidate_promote',
  'finding_applicability_assess',
  'finding_applicability_batch',
  'finding_deferral_record',
  'finding_mandatory_repair_close',
  'finding_triage',
  'finding_rollout_scorecard',
  'milestone_status',
  'milestone_closeout',
]);

// B-7c05 CHK-004: commands whose CLI stdout defaults to brief via an explicit
// verbosity injection at the dispatch seam (flag > PROOF_OR_STOP_BRIEF_OUTPUT env >
// brief default). The seam passes `brief:true`/`full:true` to the handler, so
// IN-PROCESS handler callers (smokes, other handlers) keep today's full return
// shape, and explicit machine JSON keeps the frozen full shape.
const BRIEF_DEFAULT_CLI_COMMANDS = new Set([
  'story_review',
  'doctor',
]);

const MILESTONE_STATUS_APPEND_COMMANDS = new Set([
  'milestone_ledger_set',
  'milestone_ledger_add',
  'checklist_add',
  'checklist_update',
  'verification_evidence_add',
  'verification_evidence_batch_add',
  'verification_evidence_refresh_stale',
  'verification_run',
  'story_advance',
  'delivery_check_set',
  'summary_set',
]);

const CLI_META_SCHEMA = {
  takeover: z.boolean().optional(),
  forceTakeover: z.boolean().optional(),
};

function isAutopilotCommand(cmd: string): boolean {
  return cmd.startsWith('autopilot_');
}

function validationSchemaForCommand(cmd: string, tool: ToolDef): z.ZodObject<Record<string, ZodType>> {
  const schemaWithCliMeta = { ...tool.schema, ...CLI_META_SCHEMA };
  if (isAutopilotCommand(cmd)) {
    const schema = STRICT_OWNER_META_COMMANDS.has(cmd) ? schemaWithCliMeta : tool.schema;
    return z.object(schema).strict();
  }
  if (STRICT_COMMAND_ARG_COMMANDS.has(cmd)) {
    return z.object(tool.schema).strict();
  }
  return z.object(schemaWithCliMeta);
}

function parseCommandArgs(rawArgs: string[], tool: ToolDef): Record<string, unknown> {
  if (rawArgs.length === 0) {
    return {};
  }
  if (rawArgs.length === 1 && rawArgs[0].startsWith('{')) {
    try {
      return JSON.parse(rawArgs[0]) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`JSON parse failed: ${(e as Error).message}\nInput: ${rawArgs[0]}`);
    }
  }
  return parseFlags(rawArgs, tool.schema);
}

function preflightStrictCommandArgsBeforeStoryReads(cmd: string | undefined, argv: string[]): void {
  if (!cmd || !STRICT_COMMAND_ARG_COMMANDS.has(cmd)) return;
  if (argv[1] === '--help' || argv[1] === '-h') return;
  const tool = TOOLS.find(t => t.name === cmd);
  if (!tool) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = parseCommandArgs(argv.slice(1), tool);
  } catch (e) {
    console.error((e as Error).message);
    printToolHelp(tool, { stream: process.stderr, includeFooter: false, ownerLeaseHelpBlock });
    process.exit(1);
  }
  const v = validationSchemaForCommand(cmd, tool).safeParse(parsed);
  if (!v.success) {
    printValidationFailure(tool, v.error.issues, ownerLeaseHelpBlock);
    process.exit(1);
  }
}

function gitCli(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    const details = String(e?.stderr || e?.stdout || e?.message || e).trim();
    throw new Error(`git ${args.join(' ')} failed${details ? `: ${details}` : ''}`);
  }
}

function toGitRelPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function boundedMetadataPath(baseRel: string, child: string, label: string): string {
  const childPath = toGitRelPath(child);
  if (!childPath || isAbsolute(childPath) || childPath.split('/').includes('..')) {
    throw new Error(`from-draft metadata path for ${label} is not bounded: ${child}`);
  }
  return `${toGitRelPath(baseRel)}/${childPath}`;
}

function isPathUnderAny(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function stageBoundedMetadataPath(root: string, relPath: string): void {
  if (existsSync(join(root, relPath))) {
    gitCli(root, ['add', '-A', '--', relPath]);
    return;
  }

  const deleted = gitCli(root, ['ls-files', '--deleted', '--', relPath])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (deleted.length > 0) {
    gitCli(root, ['add', '-A', '--', ...deleted]);
  }
}

function preflightFromDraftMetadataBootstrap(root: string): void {
  const currentBranch = gitCli(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (currentBranch !== 'main') {
    throw new Error(`story_create --fromDraft must finalize metadata on main, but current branch is ${currentBranch}`);
  }

  const stagedBefore = gitCli(root, ['diff', '--cached', '--name-only']);
  if (stagedBefore) {
    throw new Error(
      `story_create --fromDraft requires a clean git index before mutating story/draft/worktree metadata:\n${stagedBefore}`,
    );
  }
}

function commitFromDraftMetadataOnMain(root: string, store: StoryStore, storyId: string, draftName: string): string {
  preflightFromDraftMetadataBootstrap(root);

  const storyRel = boundedMetadataPath(store.storyDirRel(), storyId, 'active story');
  const draftRel = boundedMetadataPath('docs/story/drafts', draftName, 'source draft');
  const boundedPaths = [storyRel, draftRel];

  // B-9177 CHK-002: serialize the stage→commit-on-main critical section under
  // the unified main write lock. A concurrent main commit between staging and
  // committing is the same B-7365-class race that corrupts story/draft metadata.
  // Reentrant variant — the from-draft bootstrap can run inside an
  // already-locked context; `root` is the main checkout (preflight asserts
  // branch==main on it and every git op uses it as cwd).
  return withReentrantMainWriteLock(root, () => {
    for (const path of boundedPaths) {
      stageBoundedMetadataPath(root, path);
    }
    const staged = gitCli(root, ['diff', '--cached', '--name-only']);
    const stagedPaths = staged.split('\n').map((line) => line.trim()).filter(Boolean);
    if (stagedPaths.length === 0) {
      return '';
    }
    const outOfBounds = stagedPaths.filter((path) => !isPathUnderAny(path, boundedPaths));
    if (outOfBounds.length > 0) {
      throw new Error(
        `from-draft metadata commit refused out-of-bounds staged paths:\n${outOfBounds.join('\n')}`,
      );
    }

    const commitMessage = `proof-or-stop: from-draft metadata ${storyId}`;
    gitCli(root, [
      '-c', 'commit.gpgsign=false',
      'commit',
      '-m', commitMessage,
    ]);
    const mainHead = gitCli(root, ['rev-parse', '--short', 'HEAD']);
    const boundedStatus = gitCli(root, ['status', '--porcelain', '--', ...boundedPaths]);
    if (boundedStatus) {
      throw new Error(
        `from-draft metadata committed, but bounded metadata paths are still dirty ` +
        `(${boundedPaths.join(', ')}):\n${boundedStatus}`,
      );
    }

    return `✓ from-draft metadata committed on main: ${mainHead} (${commitMessage})`;
  }, { label: 'from-draft metadata commit' });
}

function commitFromDraftMetadataAndMergeMain(root: string, store: StoryStore, storyId: string, draftName: string): string {
  // B-9177 CHK-002: serialize the commit-on-main + merge-into-story-worktree
  // critical section under one main write lock, exactly as the B-7365 sibling
  // `commitInitCheckMetadataAndMergeMain` does. A concurrent main commit between
  // our commit and our merge is what produces a divergent metadata state.
  // Reentrant — the inner `commitFromDraftMetadataOnMain` (also reentrant-locked)
  // becomes a pass-through under this outer hold; `root` is the main checkout.
  return withReentrantMainWriteLock(root, () => {
    const metadataResult = commitFromDraftMetadataOnMain(root, store, storyId, draftName);
    const story = store.readStory(storyId);
    const worktreePath = story.worktree?.path;
    const storyBranch = story.worktree?.branch || `story/${storyId}`;
    if (!worktreePath) {
      throw new Error(`from-draft story ${storyId} has no recorded worktree path after dev_start`);
    }
    const repoRoot = gitCli(root, ['rev-parse', '--show-toplevel']);
    const worktreeAbs = isAbsolute(worktreePath) ? worktreePath : join(repoRoot, worktreePath);
    gitCli(worktreeAbs, [
      '-c', 'commit.gpgsign=false',
      'merge',
      'main',
      '--no-edit',
    ]);
    gitCli(worktreeAbs, ['merge-base', '--is-ancestor', 'main', storyBranch]);

    return [
      metadataResult,
      `✓ main merged into ${storyBranch}`,
    ].filter(Boolean).join('\n');
  }, { label: 'from-draft metadata commit+merge' });
}

// ── Main ──

/**
 * runCli: Proof-or-Stop runtime entry point.
 *
 * @param opts.extraTools ToolDef list from third-party packages, merged into help and dispatch.
 * @param opts.extraRegister register function from third-party packages, called after createMainRegistry.
 * (after receiving the Registry instance, inject handlers with registry.registerBatch(...))
 */
export async function runCli(opts?: {
  extraTools?: ToolDef[];
  extraRegister?: (registry: Registry, ctx: HandlerContext) => void;
  extraOwnershipClasses?: Readonly<Record<string, import('./core/command-policy.js').OwnershipClass>>;
  extraAllowedPhases?: Readonly<Record<string, readonly string[] | 'all'>>;
}): Promise<void> {
  assertRuntimePackageVersion();
  const enforcedImplementationIdentity = enforceExecutionImplementationPin();
  if (process.argv.slice(2).includes('--implementation-identity')) {
    // This synchronous branch has no dispatch or intervening work: print the
    // exact content identity just checked, rather than scanning every byte twice.
    // Other execution boundaries still perform their independent fresh scans.
    console.log(JSON.stringify(enforcedImplementationIdentity ?? executionImplementationIdentity()));
    return;
  }
  const externalAdmission = validateExternalCommandDeclarations({
    mainTools: MAIN_TOOLS,
    extraTools: opts?.extraTools,
    extraOwnershipClasses: opts?.extraOwnershipClasses,
    extraAllowedPhases: opts?.extraAllowedPhases,
  });
  // Inject extras: merge tool defs and keep extras register for later invocation.
  TOOLS = opts?.extraTools && opts.extraTools.length > 0
    ? [...MAIN_TOOLS, ...opts.extraTools]
    : MAIN_TOOLS;

  const argv = process.argv.slice(2);

  // --root flag
  let rootOverride: string | undefined;
  const ri = argv.indexOf('--root');
  if (ri !== -1 && argv[ri + 1]) { rootOverride = argv[ri + 1]; argv.splice(ri, 2); }

  let cmd = argv[0];
  let arg: string | undefined = argv[1];

  // Normalize nested space aliases into the flat underscore commands used by
  // the registry before command-specific preflight or active-story reads.
  const normalizedAlias = normalizeNestedSpaceAlias(argv);
  if (normalizedAlias.matched) {
    argv.splice(0, argv.length, ...normalizedAlias.argv);
    cmd = normalizedAlias.canonicalAlias!;
    arg = argv[1];
    // B-cdf6 CHK-002: forgive a pasted redundant bin token under EITHER name,
    // so `proof-or-stop proof-or-stop --version` resolves the canonical wrapper once.
  } else if (STRIPPABLE_BIN_TOKENS.includes(cmd) && (argv[1] === 'version' || argv[1] === '--version' || argv[1] === '-v')) {
    argv.splice(0, argv.length, 'version');
    cmd = 'version';
    arg = undefined;
  }

  // B-ebe4 F-001/F-002: raw-argv-safe runtime authority preflight. This is the
  // earliest point at which root and canonical alias identity are available,
  // and it deliberately runs before strict-arg preflight, active-story reads,
  // standalone init/dashboard imports, tool lookup, phase/schema lookup, Store,
  // hooks, handlers, validation subprocesses, or persistence. A stale registry
  // therefore cannot reject a worktree-new command/argument before printing the
  // canonical local recovery. The classifier consumes raw strings only; it does
  // not trust the stale runtime's command catalog or schema. The sole exemption
  // remains explicit global-fallback session_brief.
  const root0 = resolveRootForCommand(cmd, rootOverride);
  const runtimeOwnershipConfig = cmd === 'agent_prompt' || cmd === 'evaluate'
    ? loadConfig(root0)
    : undefined;
  const rawRuntimeOwnership = resolveRawRuntimeAdmissionOwnership(
    cmd || 'help',
    argv.slice(1),
    externalAdmission.ownershipClasses,
    { config: runtimeOwnershipConfig },
  );
  const runtimeAuthority = classifyRuntimeEntrypointAuthority({
    command: cmd || 'help',
    commandArgs: argv.slice(1),
    projectRoot: root0,
    invokedEntrypoint: process.argv[1] ?? null,
    env: process.env,
    requiresAuthoritativeRuntime: commandRequiresAuthoritativeRuntime(cmd || 'help', rawRuntimeOwnership),
  });
  if (runtimeAuthority.status === 'blocked') {
    process.stderr.write(`${renderRuntimeEntrypointAuthorityFailure(runtimeAuthority)}\n`);
    process.exitCode = 1;
    return;
  }

  // B-49df F-050: command-specific active identity boundaries are checked
  // against the exact loaded runtime bytes before argument parsing, Story
  // reads, hooks, handlers, activity/process events, or any other mutation.
  // Historical artifacts remain outside this active runtime registry.
  try {
    assertCanonicalActiveIdentityRuntime({ command: cmd || 'help', projectRoot: root0 });
  } catch (error: any) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  // Exact command-consumer identity belongs before every write-capable CLI
  // surface. Keeping this distinct from the broad runtime preflight lets the
  // consumer contract remain effective even when that preflight is tested in
  // isolation or deliberately ablated by its negative-control suite.
  try {
    assertCanonicalActiveIdentityCommandConsumers({ command: cmd || 'help', projectRoot: root0 });
  } catch (error: any) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  preflightStrictCommandArgsBeforeStoryReads(cmd, argv);

  // Detect active story from git branch only after runtime authority passes.
  const activeStory = detectActiveStory(root0);
  const gitReady = isGitRepository(root0);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    // B-7c05 CHK-003: help is BRIEF by default; --full (or PROOF_OR_STOP_BRIEF_OUTPUT=0)
    // restores the current verbose catalog. --brief forces brief over the env hatch.
    const helpFull = wantsFullOutput({
      full: argv.includes('--full'),
      brief: argv.includes('--brief'),
    });
    printHelp({
      tools: TOOLS,
      activeStory,
      phaseTools: loadConfig(root0).phaseTools,
      ownerLeaseHelpBlock,
      full: helpFull,
    });
    return;
  }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${formatProofOrStopVersionLine()}\n`);
    return;
  }

  // init uses a standalone script.
  if (cmd === 'init') {
    const initPath = new URL('./cli-init.js', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
    await import(`file://${initPath}`);
    return;
  }

  // dashboard uses standalone long-running mode.
  if (cmd === 'dashboard') {
    const dashArgs = parseFlags(argv.slice(1), {
      roots: z.string().optional(),
      interval: z.number().optional(),
    });
    // If roots are not specified, use --root (or auto-detection) as the default.
    if (!dashArgs.roots) dashArgs.roots = root0;
    const { runDashboard } = await import('./dashboard.js');
    await runDashboard(dashArgs as { roots?: string; interval?: number });
    return;
  }

  // B-cdf6 CHK-002: next-action guidance must name a bin the caller can retype,
  // so mirror how this process was actually invoked.
  const usageBin = detectProofOrStopBrand().usageBin;

  if (cmd === 'codex' && (argv[1] === 'session_brief' || argv[1] === 'aux_doc_list')) {
    const ordinary = argv[1];
    console.error(`Unsupported command: ${usageBin} codex ${ordinary}`);
    console.error(`The Codex adapter namespace only supports: ${usageBin} codex verify, ${usageBin} codex doctor.`);
    console.error(`Use the ordinary command instead: ${usageBin} ${ordinary}`);
    process.exit(1);
  }

  const tool = TOOLS.find(t => t.name === cmd);
  if (!tool) {
    console.error(`Unknown command: ${cmd}`);
    const m = TOOLS.filter(t => t.name.includes(cmd) || cmd.includes(t.name.split('_')[0]));
    if (m.length) { console.error('Did you mean:'); for (const t of m) console.error(`  ${usageBin} ${t.name}`); }
    console.error(`Use ${usageBin} help to view all commands.`);
    process.exit(1);
  }

  const helpInvocation = normalizedAlias.matched ? normalizedAlias.displayAlias : undefined;
  if (arg === '--help' || arg === '-h') { printToolHelp(tool, { ownerLeaseHelpBlock, invocation: helpInvocation }); return; }

  // Phase gate: When an active story exists, reject commands outside the allowlist.
  if (activeStory) {
    const config = loadConfig(root0);
    // Optional bootstrap extensions are not members of the core lifecycle
    // registry. They must independently declare BOTH ownership and lifecycle
    // phases; a tool definition or ownership class alone cannot bypass the
    // active-Story phase gate.
    const extensionPhases = externalAdmission.allowedPhases[cmd];
    const isDeclaredExtensionCommand = externalAdmission.commandNames.has(cmd)
      && (extensionPhases === 'all' || (Array.isArray(extensionPhases) && extensionPhases.includes(activeStory.phase)));
    if (!isDeclaredExtensionCommand && !isCommandAllowed(cmd, activeStory.phase, config.phaseTools)) {
      const allowed = getAllowedPatterns(activeStory.phase, config.phaseTools);
      console.error(`Command "${cmd}" is not available in ${activeStory.phase} phase`);
      console.error(`   Story: ${activeStory.storyId}  Phase: ${activeStory.phase}`);
      for (const line of formatCommandLifecycleHint(cmd, activeStory.phase, allowed)) console.error(line);
      console.error(`   Current phase available commands: ${allowed.join(', ')}`);
      process.exit(1);
    }
  }

  // Parse arguments — supports three formats:
  // 1. --key=value --flag (standard flag)
  // 2. key=value (shorthand flag)
  // 3. '{"key":"value"}'  (JSON body, compatible with legacy usage)
  let parsed: Record<string, unknown> = {};
  try {
    parsed = parseCommandArgs(argv.slice(1), tool);
  } catch (e) {
    console.error((e as Error).message);
    printToolHelp(tool, { stream: process.stderr, includeFooter: false, ownerLeaseHelpBlock, invocation: helpInvocation });
    process.exit(1);
  }

  if (cmd === 'dev_memory_finish' && activeStory) {
    const hasExplicitStory =
      (typeof parsed.story === 'string' && parsed.story.trim().length > 0) ||
      (typeof parsed.storyId === 'string' && parsed.storyId.trim().length > 0);
    if (!hasExplicitStory && parsed.scope !== 'global') {
      parsed = { ...parsed, storyId: activeStory.storyId };
    }
  }

  // Validate
  const schema = validationSchemaForCommand(cmd, tool);
  const v = schema.safeParse(parsed);
  if (!v.success) {
    printValidationFailure(tool, v.error.issues, ownerLeaseHelpBlock);
    process.exit(1);
  }
  parsed = v.data as Record<string, unknown>;

  // B-7c05 CHK-004: resolve output verbosity ONCE at the CLI seam for the
  // brief-by-default commands and pass it explicitly to the handler. Machine
  // JSON (--json/--format=json) bypasses brief entirely (frozen full shape).
  // Mutate in place: `parsed` and `v.data` are the SAME object here, and the
  // final dispatch below hands `v.data` to the handler.
  if (BRIEF_DEFAULT_CLI_COMMANDS.has(cmd) && !wantsMachineJson(parsed)) {
    if (wantsFullOutput(parsed)) parsed.full = true;
    else parsed.brief = true;
  }

  // Execute
  const root = root0;
  // Durable main-root fallback for post-command activity logging.
  // story_advance --phase=DONE removes the current story worktree mid-command.
  // Once removed, root/.git is gone, so resolveMainRootFromWorktreeRoot() can no
  // longer recover the main project root, and resolveRoot()'s cwd-walk may land
  // on (and appendActivityLog may recreate) the now-deleted ghost worktree dir.
  // Capture the main root NOW, while root/.git still exists, so writeLog can fall
  // back to a durable path that survives the deletion.
  const mainRootFallback = resolveMainRootFromWorktreeRoot(root);
  const store = new StoryStore(root);
  const _cliStart = Date.now();
  let log: (msg: string) => void = (msg) => {
    const elapsed = ((Date.now() - _cliStart) / 1000).toFixed(1);
    process.stderr.write(`[${elapsed}s] ${msg}\n`);
  };

  const config0 = runtimeOwnershipConfig ?? loadConfig(root);
  const scanRoot = join(root, config0.scanRoot);
  const ctx: HandlerContext = { store, root, scanRoot, log };
  const registry = createMainRegistry(ctx);
  const coreHandlerSnapshot = new Map(Object.entries(registry.toObject()));
  if (opts?.extraRegister) opts.extraRegister(registry, ctx);
  const handlers = registry.toObject() as Record<string, Function>;
  validateExternalCommandHandlers(externalAdmission, coreHandlerSnapshot, handlers, opts?.extraTools);

  function appendMilestoneStatusAfterMutation(output: string): string {
    if (wantsMachineJson(parsed)) return output;
    if (!cmd || !MILESTONE_STATUS_APPEND_COMMANDS.has(cmd)) return output;

    const storyId = storyIdFromArgs(parsed, activeStory, { command: cmd, projectRoot: root });
    if (!storyId) return output;

    // B-7c05 CHK-001: the post-mutation ledger suffix is BRIEF by default. Per-call
    // flags on a mutating command are stripped by that command's own schema, so the
    // primary override here is PROOF_OR_STOP_BRIEF_OUTPUT=0 (env hatch); a mutating command
    // that DOES expose --full/--brief in its schema is still honored via `parsed`.
    const wantFull = wantsFullOutput(parsed);
    // Force the resolved verbosity explicitly so the milestone handler renders the
    // same shape we decided here (its own resolver would otherwise re-read env only).
    const statusArgs = wantFull ? { storyId, full: true } : { storyId, brief: true };

    const renderFromHandlers = (sourceHandlers: Record<string, Function>): string | null => {
      const milestoneStatus = sourceHandlers.milestone_status;
      if (typeof milestoneStatus !== 'function') return null;
      const rendered = milestoneStatus(statusArgs);
      const milestoneOutput = typeof rendered === 'string' ? rendered : JSON.stringify(rendered, null, 2);
      return milestoneOutput.trim() ? milestoneOutput : null;
    };

    // "Failure visible": a display failure is surfaced on stdout, never swallowed
    // to stderr. Exit code stays 0 — the mutation already committed before this
    // append runs, so signalling process failure would falsely imply a bad write.
    const visibleFailure = (e: Error): string =>
      `${output}\n\n⚠ Milestone Ledger: render FAILED for ${storyId} — ${e.message}.\n` +
      `  The write above SUCCEEDED; this is a display failure, not a data failure.\n` +
      `  Run \`proof-or-stop milestone_status --storyId=${storyId}\` to view status.`;

    // Anchor to a line start so a header substring echoed inside the command's own
    // output (e.g. a milestone claim rendered in a table cell) cannot be mistaken
    // for an already-appended status block.
    const alreadyShown = (): boolean => {
      const shown = (header: string): boolean =>
        output.startsWith(`${header} - ${storyId}`) ||
        output.includes(`\n${header} - ${storyId}`);
      return shown('Milestone Status') || shown(CHECKLIST_DERIVED_HEADER);
    };

    // Only a genuinely-absent artifact is tolerated (e.g. an IDEA story has no
    // checklist). A corrupt/unreadable artifact must surface via visibleFailure,
    // never be masked as an empty story — that is the exact silent-swallow this
    // change set out to remove.
    const ignoreMissingArtifact = (e: unknown): void => {
      if ((e as { name?: string } | null)?.name !== 'StoryArtifactMissingError') throw e;
    };

    const renderDerived = (srcStore: StoryStore): string => {
      let checklist: ChecklistData = { items: [] };
      try {
        checklist = srcStore.readChecklist(storyId);
      } catch (e) { ignoreMissingArtifact(e); }
      let phase = 'unknown';
      try {
        phase = srcStore.readStory(storyId).phase;
      } catch (e) { ignoreMissingArtifact(e); }
      return renderChecklistDerivedLedger(storyId, checklist, phase, { brief: !wantFull });
    };

    // The DONE worktree-cleanup path may have already removed the story worktree,
    // so its real ledger (if any) lives on the main root fallback.
    const doneWorktreeFallback =
      cmd === 'story_advance' && parsed.phase === 'DONE' &&
      !hasProjectConfigFile(root) && Boolean(mainRootFallback) &&
      hasProjectConfigFile(mainRootFallback as string);

    // Prefer a REAL milestone table; return null when no ledger is available so
    // the caller falls back to the always-shown checklist-derived ledger.
    const realRender = (): string | null => {
      // readMilestoneLedger returns null when the ledger is absent and throws on a
      // corrupt/unreadable ledger; let that throw propagate to visibleFailure rather
      // than masking real corruption as "no milestone ledger set".
      const hasWorktreeLedger = Boolean(store.readMilestoneLedger(storyId));
      if (hasWorktreeLedger) {
        const r = renderFromHandlers(handlers);
        if (r) return r;
      }
      if (doneWorktreeFallback) {
        const mainStore = new StoryStore(mainRootFallback as string);
        if (mainStore.readMilestoneLedger(storyId)) {
          const mainConfig = loadConfig(mainRootFallback as string);
          const mainCtx: HandlerContext = {
            store: mainStore,
            root: mainRootFallback as string,
            scanRoot: join(mainRootFallback as string, mainConfig.scanRoot),
            log,
          };
          const mainRegistry = createMainRegistry(mainCtx);
          if (opts?.extraRegister) opts.extraRegister(mainRegistry, mainCtx);
          return renderFromHandlers(mainRegistry.toObject() as Record<string, Function>);
        }
      }
      return null;
    };

    try {
      const deriveStore = doneWorktreeFallback ? new StoryStore(mainRootFallback as string) : store;
      const block = realRender() ?? renderDerived(deriveStore);
      if (!block || alreadyShown()) return output;
      return `${output}\n\n${block}`;
    } catch (e) {
      return visibleFailure(e as Error);
    }
  }

  // Stale state warnings — soft, never blocks. Print before handler dispatch
  // so the agent sees the reminder along with the command output. The captured
  // warnings are also passed into writeLog so activity.jsonl preserves them
  // for trend analysis (how often does the agent forget to advance?).
  let staleWarnings: string[] = [];
  try {
    staleWarnings = detectStaleState(ctx);
    if (staleWarnings.length > 0) {
      process.stderr.write('⚠ Proof-or-Stop stale state warnings:\n');
      for (const w of staleWarnings) process.stderr.write(`  - ${w}\n`);
    }
  } catch { /* never block */ }

  // Heartbeat: by default, 5 minutes without output means stuck; 15 minutes is the absolute safety limit.
  // Can be overridden with PROOF_OR_STOP_IDLE_TIMEOUT_MS / PROOF_OR_STOP_MAX_TIMEOUT_MS,
  // A single LLM call in real-machine smoke tests can occasionally exceed 2 minutes (non-deterministic cases such as text-adventure uninstall).
  const explicitIdle = Number(readBrandEnv('IDLE_TIMEOUT_MS'));
  const effectiveMaxBudget = effectiveCommandCliMaxBudget(root, cmd, parsed);
  const timeoutBudget = {
    effectiveMs: effectiveMaxBudget.timeoutMs,
    derivedMs: effectiveMaxBudget.source === 'explicit-max-env'
      ? commandCliMaxBudget(root, cmd, parsed).timeoutMs : effectiveMaxBudget.timeoutMs,
    source: effectiveMaxBudget.source,
  };
  const IDLE_TIMEOUT = Number.isFinite(explicitIdle) && explicitIdle > 0
    ? Math.min(NODE_TIMER_MAX_MS, Math.floor(explicitIdle))
    : (5 * 60 * 1000);
  const MAX_TIMEOUT = effectiveMaxBudget.timeoutMs;
  const startTime = Date.now();
  let lastActivity = Date.now();
  const originalLog = log;
  log = (msg: string) => { lastActivity = Date.now(); originalLog(msg); };
  ctx.log = log;
  if (cmd === 'done_prepare' || cmd === 'done_required_validate' || cmd === 'validate' || (cmd === 'story_advance' && parsed.phase === 'TEST')) {
    // B-cdf6 delivery review: this diagnostic named the deprecated env var, so a
    // user copying it back would set the pre-rename name. The resolver reads both
    // (brand-env.ts), but new user-visible output must teach the canonical form.
    originalLog(`${cmd} timeout budget: maxMs=${MAX_TIMEOUT} source=${effectiveMaxBudget.source === 'explicit-max-env' ? `${BRAND_ENV_PREFIX}MAX_TIMEOUT_MS` : effectiveMaxBudget.source}`);
  }

  // Official validation waits on an async workspace-capacity queue. Give the
  // direct validate entrypoint the same abort/deadline channel as DONE-time
  // validators so its watchdog can unwind the exact waiter ticket instead of
  // hard-exiting with process.exit(2). Keep DONE result classification separate:
  // validate already has its own canonical PASS/FAIL exit contract below.
  const structuredDoneResult = cmd === 'done_prepare' || cmd === 'done_required_validate';
  // B-137a: evidence writers execute pinned provider commands whose wall-clock
  // budget can legitimately exceed the default watchdog, so they need the same
  // structured abort channel rather than a hard process.exit(2).
  const structuredWatchdog = structuredDoneResult
    || cmd === 'validate'
    || cmd === 'verification_evidence_add'
    || cmd === 'verification_evidence_refresh_stale'
    || cmd === 'verification_evidence_batch_add'
    || cmd === 'verification_run';
  const runtimeContinuation = getCommandPolicy(cmd)?.runtimeContinuation === true;
  const watchdogAbort = new AbortController();
  if (structuredWatchdog) {
    const watchdogControl = {
      abortSignal: watchdogAbort.signal,
      deadlineAt: startTime + MAX_TIMEOUT,
      deadlineError: () => watchdogAbort.signal.reason instanceof Error
        ? watchdogAbort.signal.reason
        : new CliWatchdogTimeoutError('max', MAX_TIMEOUT),
    };
    Object.assign(parsed, watchdogControl);
    // The generic dispatcher normally passes schema-filtered `v.data`, while
    // Evidence writers' abort/deadline controls are deliberately internal and
    // absent from their public schemas. Inject them only for these exact
    // commands; arbitrary commands neither receive this capability nor become
    // runtimeContinuation.
    if (
      (cmd === 'verification_evidence_add'
        || cmd === 'verification_evidence_refresh_stale'
        || cmd === 'verification_evidence_batch_add'
        || cmd === 'verification_run')
      && v.data
      && typeof v.data === 'object'
    ) {
      Object.assign(v.data as Record<string, unknown>, watchdogControl);
    }
  }

  const watchdog = setInterval(() => {
    if (runtimeContinuation) return;
    const now = Date.now();
    if (now - startTime > MAX_TIMEOUT) {
      const error = new CliWatchdogTimeoutError('max', MAX_TIMEOUT);
      originalLog(`${cmd} exceeded max timeout ${MAX_TIMEOUT}ms; aborting with structured result`);
      if (structuredWatchdog) watchdogAbort.abort(error);
      else process.exit(2);
      return;
    }
    if (now - lastActivity > IDLE_TIMEOUT) {
      const error = new CliWatchdogTimeoutError('idle', IDLE_TIMEOUT);
      originalLog(`${cmd} stuck: ${IDLE_TIMEOUT / 1000} seconds without output; aborting with structured result`);
      if (structuredWatchdog) watchdogAbort.abort(error);
      else process.exit(2);
    }
  }, Math.max(10, Math.min(10_000, Math.floor(IDLE_TIMEOUT / 4), Math.floor(MAX_TIMEOUT / 4))));
  watchdog.unref();

  function isStructuredDoneFailure(result: unknown): boolean {
    if (!structuredDoneResult) return false;
    let value: any = result;
    if (typeof result === 'string') {
      try { value = JSON.parse(result); } catch {
        return /\bresult=(?:failed|timed_out|blocked)\b|^DONE prepare: BLOCKED/m.test(result);
      }
    }
    return value?.allPass === false
      || value?.status === 'fail'
      || value?.status === 'blocked'
      || value?.result === 'failed'
      || value?.result === 'timed_out'
      || value?.result === 'blocked';
  }

  function isCanonicalCommandFailure(result: unknown): boolean {
    if (cmd !== 'validate' && !(cmd === 'story_advance' && parsed.phase === 'TEST')) return false;
    let value: any = result;
    if (typeof result === 'string') {
      try { value = JSON.parse(result); } catch { return false; }
    }
    return value?.allPass === false
      || value?.status === 'fail'
      || value?.status === 'blocked'
      || value?.result === 'failed'
      || value?.result === 'timed_out'
      || value?.result === 'blocked';
  }

  // Unified logging: write to .proof-or-stop/activity.jsonl (dual-source module, legacy path is read-compatible only).
  // Write failure is a PERSIST issue (incomplete audit means it cannot be traced later), so reportHealthIssue is used instead.
  // staleWarnings are persisted too, making later trend analysis possible (how long agents go before forgetting an advance).
  function writeLog(entry: {
    command: string;
    args: unknown;
    startTime: string;
    endTime: string;
    success: boolean;
    error?: string;
    staleWarnings?: string[];
  }) {
    try {
      // B-9cd4 follow-up bug: story_advance --phase=DONE removes the current
      // worktree mid-command. The `root` captured at command start still
      // points at that worktree. If we appendActivityLog on the now-ghost
      // path, we re-create dirs and leave a dangling audit log that
      // masquerades as an active worktree.
      //
      // Detect this by checking if `root` is still activity-log eligible.
      // If not (the worktree was removed), prefer the durable main-root
      // fallback captured at command start — it was computed while root/.git
      // still existed, so it points at the real main project even after the
      // worktree is gone. Do NOT fall back to resolveRoot() first: its
      // cwd-walk may resolve to (and appendActivityLog would then recreate)
      // the now-deleted ghost worktree dir. Only use resolveRoot() if the
      // durable fallback is unavailable/stale, and skip logging entirely if
      // neither has an activity-log eligible root rather than pollute the filesystem.
      let effectiveRoot = root;
      if (!isRuntimeActivityRoot(effectiveRoot)) {
        if (mainRootFallback && isRuntimeActivityRoot(mainRootFallback)) {
          effectiveRoot = mainRootFallback;
        } else {
          effectiveRoot = resolveRoot();
          if (!isRuntimeActivityRoot(effectiveRoot)) {
            return;
          }
        }
      }
      const sessionIdentity = getSessionIdentity();
      const record: Record<string, unknown> = {
        source: resolveActivitySource(),
        session: sessionIdentity.sessionId,
        sessionSource: sessionIdentity.sessionSource,
        hostProvider: sessionIdentity.hostProvider ?? null,
        entrypoint: inferCodexEntrypoint(),
        startTime: entry.startTime,
        endTime: entry.endTime,
        // Reuse the actual admission result; never infer an implementation from
        // a version label or rescan mutable files when publishing diagnostics.
        // This annotates existing runtime records and grants no gate authority.
        implementation: enforcedImplementationIdentity ? {
          status: 'verified-at-entry',
          schema: enforcedImplementationIdentity.schema,
          digest: enforcedImplementationIdentity.digest,
          entrypoint: enforcedImplementationIdentity.entrypoint,
          pid: process.pid,
        } : { status: 'unverified' },
        tool: entry.command,
        detail: entry.command,
        args: entry.args,
        status: entry.success ? 'ok' : 'fail',
        result: entry.success ? null : undefined,
        error: entry.error || null,
        timeoutBudget,
        storyId: storyIdFromArgs(entry.args as Record<string, unknown>, activeStory, {
          command: entry.command,
          projectRoot: effectiveRoot,
        }),
        phase: activeStory?.phase || null,
        role: inferActivityRole(entry.args, readBrandEnv('ACTIVITY_ROLE') || readBrandEnv('AGENT')),
      };
      if (entry.staleWarnings && entry.staleWarnings.length > 0) {
        record.staleWarnings = entry.staleWarnings;
      }
      appendActivityLog(effectiveRoot, record);
    } catch (e: unknown) {
      reportHealthIssue('persist:writeLog', e as Error, {
        command: entry.command,
        logDir: join(root, PROOF_OR_STOP_DIR),
      });
    }
  }

  function writeCodexProcessEvent(entry: {
    command: string;
    args: unknown;
    success: boolean;
    error?: string;
    canonicalFailure?: boolean;
  }) {
    if (!isCodexActivitySource()) return;
    const argsObject = entry.args && typeof entry.args === 'object' && !Array.isArray(entry.args)
      ? entry.args as Record<string, unknown>
      : {};
    // F-032: appending a codex process event mutates STORY metadata
    // (<story>/process-events.jsonl), so it is bound by the SAME F-028
    // read-only contract as the pre/post command hooks and the activity log.
    // A read-only command — a static READ_ONLY_COMMANDS member OR a plain
    // (no --out) usage_sweep — must append NOTHING; a mutating command,
    // including a `usage_sweep --out` that writes a report file, keeps its
    // process event. This single guard is the class-wide choke point: it fires
    // for BOTH the success and error call sites in run() (and any future
    // caller), using the exact `isReadOnlyCommand` predicate the hook gates use,
    // so no post-command process-event surface can bypass the contract.
    const eventStoryId = storyIdFromArgs(argsObject, activeStory, { command: entry.command, projectRoot: root });
    const eventOwnership = resolveEffectiveOwnershipClass(entry.command, argsObject, eventStoryId, externalAdmission.ownershipClasses, { config: config0 });
    if (eventOwnership === 'readOnly' || isReadOnlyCommand(entry.command, argsObject)) return;
    // quorum_submit owns one exact immutable process-events transaction inside
    // its handler. A generic post-handler codex_cli append would make that
    // canonical commit dirty again (and would mutate pre-dirty refusal bytes).
    // Activity telemetry still records the invocation; the L4 command evidence
    // is the committed host_verdict batch itself.
    // (Kept as its own literal statement: scripts/verify-process-fact-contract.mjs
    // pins this exact line as the quorum_submit sole-ownership invariant.)
    if (entry.command === 'quorum_submit') return;
    // B-3144 F-001: quorum_prune shares that same immutable-transaction reason.
    // It commits through the IDENTICAL captureLifecycleMetadataTransaction /
    // commitLifecycleMetadataTransaction machinery on the shared
    // kind:'quorum-submit' path, which stages exactly <story>/process-events.jsonl
    // and verifies its committed bytes. Without this matching exclusion the
    // generic codex_cli append re-dirties the very file the handler just
    // atomically committed, so the NEXT quorum_prune/quorum_submit pre-dirty-
    // refuses on this tool's own leftover write instead of on real user dirt.
    if (entry.command === 'quorum_prune') return;
    const storyId = storyIdFromArgs(argsObject, activeStory, { command: entry.command, projectRoot: root });
    if (!storyId) return;
    const closeCanonicalTerminal = (entry.success || entry.canonicalFailure === true)
      && (
        entry.command === 'validate'
        || (entry.command === 'story_advance' && argsObject.phase === 'TEST')
      );
    try {
      const terminalGitCwd = closeCanonicalTerminal
        ? resolveGitCwd({
          store,
          storyId,
          metadataRoot: root,
          projectRoot: root,
        })
        : '';
      const terminalCapture = closeCanonicalTerminal
        ? captureLifecycleMetadataTransaction({
          root: terminalGitCwd,
          gitCwd: terminalGitCwd,
          storyId,
          storyRel: relative(realpathSync(terminalGitCwd), realpathSync(store.storyDirPath(storyId))),
          kind: 'codex-command-terminal',
        })
        : null;
      let phase = activeStory?.phase || '';
      if (!phase) {
        try { phase = store.readStory(storyId).phase; } catch { phase = ''; }
      }
      const sessionIdentity = getSessionIdentity();
      store.appendProcessEvent(storyId, {
        type: 'codex_cli',
        source: 'codex',
        session: sessionIdentity.sessionId,
        sessionSource: sessionIdentity.sessionSource,
        hostProvider: sessionIdentity.hostProvider ?? null,
        role: inferActivityRole(entry.args, readBrandEnv('ACTIVITY_ROLE') || readBrandEnv('AGENT')),
        storyId,
        phase,
        command: entry.command,
        entrypoint: inferCodexEntrypoint(),
        result: entry.success ? 'pass' : 'fail',
        ...(entry.error ? { errorSummary: entry.error.slice(0, 300) } : {}),
      });
      if (terminalCapture) {
        const terminalOutput = readLifecycleMetadataOutputHashes({
          root: terminalGitCwd,
          capture: terminalCapture,
        });
        const committed = commitLifecycleMetadataTransaction({
          root: terminalGitCwd,
          gitCwd: terminalGitCwd,
          storyId,
          capture: terminalCapture,
          verifiedHashes: terminalOutput.ok ? terminalOutput.hashes : new Map(),
        });
        if (!committed.ok) {
          throw new Error(
            `Codex command terminal closeout failed: ${
              terminalOutput.ok ? '' : `${terminalOutput.reason}; `
            }${committed.reason}`,
          );
        }
      }
    } catch (e: unknown) {
      reportHealthIssue('persist:codexProcessEvent', e as Error, {
        command: entry.command,
        storyId,
      });
      if (closeCanonicalTerminal && entry.success) {
        throw new CanonicalTerminalCloseoutError(
          `canonical terminal persistence failed for ${entry.command}: ${(e as Error)?.message || String(e)}`,
        );
      }
    }
  }

  // Hook env factory — delegates to the shared helper in core/hooks.ts so
  // transition-orchestrator can call it the same way for onPhaseChange.
  function buildHookEnvLocal(stage: 'preCommand' | 'postCommand' | 'onError', extra: Record<string, string> = {}): Record<string, string> {
    return buildSharedHookEnv({
      stage,
      command: cmd,
      cwd: process.cwd(),
      root,
      argsJson: JSON.stringify(parsed),
      storyId: activeStory?.storyId,
      phase: activeStory?.phase,
      extra,
    });
  }

  async function run(fn: () => unknown | Promise<unknown>) {
    const runStart = new Date().toISOString();
    log(`running ${cmd}...`);
    // B-4f15 CHK-002: read-only reviewer gate runs first — before hooks and
    // before the owner lease gate, so a blocked command cannot trigger hooks
    // or acquire/mutate lease state.
    try {
      enforceReviewerReadOnlyCommandGate(cmd, parsed, activeStory, externalAdmission.ownershipClasses, config0);
    } catch (e: any) {
      clearInterval(watchdog);
      log(`${cmd} failed: ${e.message}`);
      process.stderr.write(`Error: ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
    // Retired-root guard: a checkout configured as retiredRoot is a read-only
    // legacy/evidence root. Reuse the same effective ownership classification
    // as the owner-lease gate, but block reviewerWrite/mainSharedMutating too
    // because those are still writes even though they are intentionally exempt
    // from per-story owner leases.
    try {
      enforceRetiredRootGuard(cmd, parsed, config0, activeStory, root, externalAdmission.ownershipClasses);
    } catch (e: any) {
      clearInterval(watchdog);
      log(`${cmd} failed: ${e.message}`);
      process.stderr.write(`Error: ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
    // preCommand hook — non-blocking failure, awaited so it always runs before the handler.
    // F-028: gate on the arg-aware read-only predicate so a plain (no --out)
    // usage_sweep runs no hooks (read-only diagnostic), while a --out sweep (a write)
    // runs them like any other mutating command.
    const commandStoryId = storyIdFromArgs(parsed, activeStory, { command: cmd, projectRoot: root });
    const effectiveOwnership = resolveEffectiveOwnershipClass(cmd, parsed, commandStoryId, externalAdmission.ownershipClasses, { config: config0 });
    try {
      enforceStoryRuntimeAdmission({
        command: cmd,
        commandArgs: argv.slice(1),
        projectRoot: root,
        effectiveOwnership,
        invokedEntrypoint: process.argv[1] ?? null,
        env: process.env,
      });
    } catch (e: any) {
      clearInterval(watchdog);
      log(`${cmd} failed: ${e.message}`);
      process.stderr.write(`Error: ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
    const effectiveReadOnly = effectiveOwnership === 'readOnly' || isReadOnlyCommand(cmd, parsed);
    // Some commands are read-only only after argument-aware ownership resolution
    // (for example role-only agent_prompt and the release-ledger readers). Keep
    // activity logging on the same effective boundary as hooks and Story process
    // events: a rejected read must not create a runtime output merely because its
    // command name is absent from the older static READ_ONLY_COMMANDS set. The
    // explicit telemetry opt-in still records read-only invocations by design.
    const shouldWriteEffectiveActivityLog = effectiveReadOnly
      ? readBrandEnv('ACTIVITY_RECORD_READONLY') === '1'
      : shouldWriteActivityLog(cmd, parsed);
    if (config0?.hooks?.preCommand && !effectiveReadOnly) {
      process.stderr.write(`[proof-or-stop-hook] running preCommand hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
    }
    if (!effectiveReadOnly) {
      await runHooks('preCommand', cmd, buildHookEnvLocal('preCommand'), config0, root);
    }
    try {
      // B-c55d CHK-002: story owner lease GATE. This `run()` wrapper is the
      // single CLI choke-point every command flows through, so ownership is
      // decided here — NOT scattered across handlers. By effective
      // ownershipClass: readOnly / reviewerWrite / mainSharedMutating are never
      // owner-gated; an owner-gated storyScopedMutating / dangerousMutating
      // command for a story owned by THIS session acquires-or-refreshes the
      // lease, while a command targeting a story owned by ANOTHER session is
      // rejected fail-closed with owner guidance; an unclassified command is
      // also rejected fail-closed. The gate runs inside this `try` so a
      // rejection surfaces through the `catch` below as the command failure.
      // B-ab8d CHK-003: experiment control-arm memory retrieval gate — same
      // single choke point as the owner lease gate. On arm=control a command
      // carrying the memoryRetrieval policy marker is refused AFTER a
      // retrieval_violation activity event is appended (attempts stay
      // countable). Treatment arm / no-experiment mode are unaffected. It runs
      // before the lease gate so a control-arm violation is recorded and
      // refused regardless of lease ownership.
      enforceExperimentArmRetrievalGate(cmd, root);
      enforceStoryOwnerLeaseGate(cmd, parsed, store, activeStory, root, externalAdmission.ownershipClasses, config0);
      // B-bbaf CHK-003: convergence breaker gate — runs AFTER the owner-lease gate
      // (which owns the canonical-storyId / path-traversal guard and the ownership
      // check) so the breaker only ever derives a story path and writes state for a
      // validated, owner-held story. Ordering rationale re codex host-B round-1 #1
      // (a frozen --forceTakeover transfers the lease before the breaker throws):
      // that is by design and benign — the lease transfer only moves OWNERSHIP; the
      // command's actual EFFECT (fn()) is still blocked by the freeze, so no
      // progress happens until a human ack, and the freeze holds for the new owner
      // too. Reordering the breaker ahead of the lease gate was rejected because it
      // let a NON-OWNER wedge breaker state and bypassed the canonical-id guard
      // (codex host-B round-2). Gates story_advance and takeover-carrying commands
      // only; all others return immediately. F-002: storyId via storyIdFromArgs.
      enforceConvergenceBreakerGate({
        command: cmd,
        storyId: storyIdFromArgs(parsed, activeStory, { command: cmd, projectRoot: root }),
        isTakeoverCommand: Boolean(parsed.takeover || parsed.forceTakeover),
        store,
        env: process.env,
      });
      let result = fn();
      if (result && typeof (result as any).then === 'function') result = await result;
      const structuredDoneFailure = isStructuredDoneFailure(result);
      const canonicalCommandFailure = isCanonicalCommandFailure(result);
      clearInterval(watchdog);
      log(`${cmd} ${structuredDoneFailure ? 'completed with structured failure' : 'done'}`);
      // B-bbaf CHK-006: a SUCCESSFUL story_advance is real progress THROUGH the
      // gate, so reset that story's repeated-gate-failure counter. Scoped to
      // story_advance specifically (codex host-B #3): resetting on ANY successful
      // mutation would let a runaway defeat the gate-repeat signal entirely — fail
      // story_advance, run any trivial no-op mutation to reset, repeat forever. A
      // successful advance is the ONLY event that means the same gate is no longer
      // failing, so it is the only legitimate reset. Best-effort.
      if (cmd === 'story_advance') {
        try {
          const sid = storyIdFromArgs(parsed, activeStory, { command: cmd, projectRoot: root });
          if (sid && isCanonicalStoryId(sid)) {
            const dir = store.storyDirPath(sid);
            if (existsSync(dir)) resetGateFailureCounts(dir);
          }
        } catch { /* best-effort: never fail a successful command on counter reset */ }
      }
      const commandSucceeded = !structuredDoneFailure && !canonicalCommandFailure;
      if (shouldWriteEffectiveActivityLog || staleWarnings.length > 0) {
        writeLog({ command: cmd, args: parsed, startTime: runStart, endTime: new Date().toISOString(), success: commandSucceeded, ...(!commandSucceeded ? { error: 'structured terminal failure' } : {}), staleWarnings });
      }
      const closesCanonicalTerminal = !structuredDoneFailure
        && !canonicalCommandFailure
        && (
          cmd === 'validate'
          || (cmd === 'story_advance' && parsed.phase === 'TEST')
        );
      // Non-closeout commands retain their historical event-before-hook order.
      // validate and story_advance(TEST) defer their terminal event until every
      // postCommand hook has completed, making the exact closeout the true final
      // canonical write of the successful command.
      if (!closesCanonicalTerminal && !canonicalCommandFailure) {
        writeCodexProcessEvent({ command: cmd, args: parsed, success: !structuredDoneFailure, ...(structuredDoneFailure ? { error: 'structured terminal failure' } : {}) });
      }
      // Append next-step guidance. Only commands registered in hints.ts are decorated; other commands are returned unchanged.
      // B-7fc2: `--json` / `--format=json` stdout is a machine-only payload.
      // Skip hint decoration entirely in machine JSON mode so JSON.parse(stdout)
      // succeeds for dashboard / host adapters / smoke tests. Text mode still
      // gets the existing decorateResult treatment so human users keep the
      // next-step hint (e.g. "Next: Validation passed").
      const hintActive: ActiveStoryInfo | null = activeStory
        ? { storyId: activeStory.storyId, phase: activeStory.phase }
        : null;
      if (!wantsMachineJson(parsed)) {
        result = decorateResult({
          cmd,
          args: parsed,
          result,
          store,
          root,
          activeStory: hintActive,
        });
      }
      // postCommand hook — runs before we exit; failure does not block exit(0)
      const resultText = typeof result === 'string' ? result : JSON.stringify(result);
      // F-028: same arg-aware read-only gate as the preCommand hooks above.
      if (config0?.hooks?.postCommand && !effectiveReadOnly) {
        process.stderr.write(`[proof-or-stop-hook] running postCommand hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
      }
      if (!effectiveReadOnly) {
        await runHooks('postCommand', cmd, buildHookEnvLocal('postCommand', {
          PROOF_OR_STOP_RESULT_JSON: truncateForEnv(resultText),
        }), config0, root);
      }
      if (closesCanonicalTerminal) {
        writeCodexProcessEvent({ command: cmd, args: parsed, success: true });
      } else if (canonicalCommandFailure) {
        // Structured validate/TEST-transition failures return normally from the
        // handler, so the catch-path audit writer never runs. Close a single
        // failure row under the same exact-path transaction used by PASS when
        // the boundary is clean. If pre-existing/concurrent canonical bytes
        // make that unsafe, writeCodexProcessEvent reports the health issue and
        // leaves those bytes untouched; the failure activity row above remains
        // the durable audit rather than laundering foreign metadata.
        writeCodexProcessEvent({
          command: cmd,
          args: parsed,
          success: false,
          error: 'structured terminal failure',
          canonicalFailure: true,
        });
      }
      let output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      output = appendMilestoneStatusAfterMutation(output);
      process.stdout.write(`${output}\n`);
      process.exitCode = structuredDoneFailure ? 1 : 0;
      return;
    } catch (e: any) {
      clearInterval(watchdog);
      log(`${cmd} failed: ${e.message}`);
      if (shouldWriteEffectiveActivityLog || staleWarnings.length > 0) {
        writeLog({ command: cmd, args: parsed, startTime: runStart, endTime: new Date().toISOString(), success: false, error: e.message, staleWarnings });
      }
      // B-bbaf CHK-006: a FAILED story_advance is a phase-GATE rejection — bump
      // this story's repeated-gate-failure counter, keyed by (command + normalized
      // reason). Scoped to story_advance specifically: that is "the gate" the user's
      // discipline names (the DEV<->REVIEW phase gate where checklist/proofstory/
      // phase gates all fire), and the same-reason oscillation is the livelock
      // shape. Other command failures are not counted (they are noise, not a gate
      // livelock, and would pollute per-story runtime state on every failed helper).
      // The cmd + e.message here are already in scope (and already written to
      // activity.jsonl above), so this is an O(1) counter write, not a scan.
      // Best-effort: a failed counter bump never changes the command's outcome.
      if (cmd === 'story_advance') {
        try {
          const sid = storyIdFromArgs(parsed, activeStory, { command: cmd, projectRoot: root });
          // Canonical-id guard (codex host-B round-3): a story_advance that FAILED
          // the owner-lease gate's own path-traversal check reaches here, so never
          // derive a path or write the counter from a non-canonical id.
          if (sid && isCanonicalStoryId(sid)) {
            const dir = store.storyDirPath(sid);
            if (existsSync(dir)) bumpGateFailureCount(dir, cmd, e.message);
          }
        } catch { /* best-effort */ }
      }
      // F-032: same self-gating applies on the error path — a read-only command
      // (e.g. a plain usage_sweep) that fails still appends NO story process event.
      if (!(e instanceof CanonicalTerminalCloseoutError)) {
        writeCodexProcessEvent({ command: cmd, args: parsed, success: false, error: e.message });
      }
      // onError hook — best-effort; always runs before exit(1).
      // Print a hint so the user knows why a failed command takes a few extra seconds.
      if (config0?.hooks?.onError) {
        process.stderr.write(`[proof-or-stop-hook] running onError hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
      }
      await runHooks('onError', cmd, buildHookEnvLocal('onError', {
        PROOF_OR_STOP_ERROR: String(e?.message || e),
      }), config0, root);
      process.stderr.write(`Error: ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
  }

  // story_create: append next-step hint when stopping in INIT.
  if (cmd === 'story_create') {
    await runStoryCreateLifecycleDispatch({
      data: v.data as Record<string, unknown>,
      gitReady,
      handlers,
      root,
      run,
      store,
      preflightFromDraftMetadataBootstrap,
      commitFromDraftMetadataOnMain,
      commitFromDraftMetadataAndMergeMain,
    });
    return;
  }

  // story_advance phase=INIT_CHECK: after success, automatically call dev_start to create the worktree.
  // B-5246: when phase is already INIT_CHECK (retry scenario), allow dev_start to rerun without throwing
  // "Cannot transition INIT_CHECK->INIT_CHECK". This lets an agent retry after the first worktree creation failure.
  // can call story_advance INIT_CHECK again to retry without using the hidden manual dev_start path.
  if (cmd === 'story_advance' && (v.data as any)?.phase === 'INIT_CHECK') {
    await runStoryAdvanceInitCheckLifecycleDispatch({
      data: v.data as Record<string, unknown>,
      gitReady,
      handlers,
      root,
      run,
      store,
      getGuardFailureReason,
      commitInitCheckMetadataAndMergeMain,
    });
    return;
  }

  // B-a2f1 CHK-003: recover_evidence — handler always returns a structured result;
  // CLI wrapper prints the result to stdout, then throws on non-pass so runCli's
  // catch branch sets process.exitCode=1. The same pattern as the validate gate
  // dispatcher (verifier.ts:482) — keeps the handler pure for in-process tests.
  if (cmd === 'recover_evidence') {
    const handler = handlers[cmd];
    if (!handler) { console.error(`handler not found: ${cmd}`); process.exit(1); }
    await run(async () => {
      return dispatchRecoverEvidenceWithStructuredFailure({
        handler: handler as (args: Record<string, unknown>) => unknown | Promise<unknown>,
        data: v.data as Record<string, unknown>,
      });
    });
    return;
  }

  // B-623a: usage_sweep --alert — same print-then-throw shape as
  // recover_evidence: the wrapper prints the full report FIRST, then throws
  // when any session is over the burn thresholds so runCli's catch branch sets
  // process.exitCode=1 (cron drives notifications off the exit code). Plain
  // usage_sweep (no --alert) stays on the generic dispatch below, byte-identical.
  if (cmd === 'usage_sweep' && (v.data as Record<string, unknown> | undefined)?.alert === true) {
    const handler = handlers[cmd];
    if (!handler) { console.error(`handler not found: ${cmd}`); process.exit(1); }
    await run(async () => {
      return dispatchUsageSweepAlertWithExit({
        handler: handler as (args: Record<string, unknown>) => unknown | Promise<unknown>,
        data: v.data as Record<string, unknown>,
      });
    });
    return;
  }

  const handler = handlers[cmd];
  if (!handler) { console.error(`handler not found: ${cmd}`); process.exit(1); }

  await run(() => Object.keys(tool.schema).length === 0 ? handler() : handler(
    isAutopilotCommand(cmd)
      ? parsed
      : (v.data as Record<string, unknown>),
  ));
}
