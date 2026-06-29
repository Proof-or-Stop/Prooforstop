/**
 * Proofbound CLI engine
 *
 * Wrap the shared dispatch, parse, log, and phase-gate logic in the callable runCli function.
 * The main package cli.ts is the binary entrypoint and calls runCli() directly.
 * Third-party bootstrap scripts can pass extraTools and extraRegister to runCli to merge utility tools
 * and handlers.
 */

import { z, type ZodType } from 'zod';
import { existsSync } from 'fs';
import { appendActivityLog } from './core/activity-log.js';
import { inferActivityRole } from './core/activity-role.js';
import { isAbsolute, join } from 'path';
import { StoryStore } from './core/store.js';
import { createMainRegistry, type Registry } from './registry.js';
import type { HandlerContext } from './handlers/context.js';
import { execFileSync, execSync } from 'child_process';
import { loadConfig, isCommandAllowed, getAllowedPatterns, hasProjectConfigFile } from './core/config.js';
import { formatCommandLifecycleHint } from './core/command-policy.js';
import { decorateResult, wantsMachineJson, type ActiveStoryInfo } from './handlers/hints.js';
import { reportHealthIssue } from './core/health.js';
import { detectStaleState } from './core/stale-detector.js';
import { runHooks, truncateForEnv, buildHookEnv as buildSharedHookEnv, HOOK_TIMEOUT_MS } from './core/hooks.js';
import { isGitRepository } from './core/git-probe.js';
import { getGuardFailureReason } from './core/machine.js';
import {
  formatLatticeVersionLine,
} from './core/lattice-brand.js';
import { LATTICE_DIR } from './core/lattice-paths.js';
import { withReentrantMainWriteLock } from './core/main-write-lock.js';
import { MAIN_TOOLS } from './cli/command-catalog.js';
import type { ToolDef } from './cli/main-tools.js';
import {
  READ_ONLY_COMMANDS,
  inferCodexEntrypoint,
  isCodexActivitySource,
  resolveActivitySource,
  shouldWriteActivityLog,
} from './cli/activity-policy.js';
import {
  ownerLeaseHelpBlock,
  storyIdFromArgs,
  enforceRetiredRootGuard,
  enforceStoryOwnerLeaseGate,
} from './cli/ownership-gate.js';
import { enforceReviewerReadOnlyCommandGate } from './cli/reviewer-readonly-gate.js';
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
import { normalizeNestedSpaceAlias } from './cli/alias-normalizer.js';
import { commitInitCheckMetadataAndMergeMain } from './cli/init-check-metadata-sync.js';
import { dispatchRecoverEvidenceWithStructuredFailure } from './cli/recover-evidence-dispatch.js';
import {
  runStoryAdvanceInitCheckLifecycleDispatch,
  runStoryCreateLifecycleDispatch,
} from './cli/lifecycle-dispatch.js';

export {
  READ_ONLY_COMMANDS,
  inferCodexEntrypoint,
  isCodexActivitySource,
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
export { commitInitCheckMetadataAndMergeMain } from './cli/init-check-metadata-sync.js';

export { MAIN_TOOLS };
export type { ToolDef };

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
 * name: 'lattice_config_doctor'
 * name: 'lattice_config_repair'
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
  return z.object(schemaWithCliMeta);
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

    const commitMessage = `lattice: from-draft metadata ${storyId}`;
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
 * runCli: Proofbound CLI runtime entry point.
 *
 * @param opts.extraTools ToolDef list from third-party packages, merged into help and dispatch.
 * @param opts.extraRegister register function from third-party packages, called after createMainRegistry.
 * (after receiving the Registry instance, inject handlers with registry.registerBatch(...))
 */
export async function runCli(opts?: {
  extraTools?: ToolDef[];
  extraRegister?: (registry: Registry, ctx: HandlerContext) => void;
}): Promise<void> {
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
  let arg = argv[1];

  // Detect active story from git branch
  const root0 = resolveRootForCommand(cmd, rootOverride);
  const activeStory = detectActiveStory(root0);
  const gitReady = isGitRepository(root0);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    printHelp({
      tools: TOOLS,
      activeStory,
      phaseTools: loadConfig(root0).phaseTools,
      ownerLeaseHelpBlock,
    });
    return;
  }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${formatLatticeVersionLine()}\n`);
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

  // Normalize nested space aliases into the flat underscore commands used by
  // the registry.
  const normalizedAlias = normalizeNestedSpaceAlias(argv);
  if (normalizedAlias.matched) {
    argv.splice(0, argv.length, ...normalizedAlias.argv);
    cmd = normalizedAlias.canonicalAlias!;
    arg = argv[1];
  } else if (cmd === 'lattice' && (argv[1] === 'version' || argv[1] === '--version' || argv[1] === '-v')) {
    process.stdout.write(`${formatLatticeVersionLine()}\n`);
    return;
  }

  if (cmd === 'codex' && (argv[1] === 'session_brief' || argv[1] === 'aux_doc_list')) {
    const ordinary = argv[1];
    console.error(`Unsupported command: lattice codex ${ordinary}`);
    console.error('The Codex adapter namespace only supports: lattice codex verify, lattice codex doctor.');
    console.error(`Use the ordinary command instead: lattice ${ordinary}`);
    process.exit(1);
  }

  const tool = TOOLS.find(t => t.name === cmd);
  if (!tool) {
    console.error(`Unknown command: ${cmd}`);
    const m = TOOLS.filter(t => t.name.includes(cmd) || cmd.includes(t.name.split('_')[0]));
    if (m.length) { console.error('Did you mean:'); for (const t of m) console.error(`  lattice ${t.name}`); }
    console.error('Use lattice help to view all commands.');
    process.exit(1);
  }

  if (arg === '--help' || arg === '-h') { printToolHelp(tool, { ownerLeaseHelpBlock }); return; }

  // Phase gate: When an active story exists, reject commands outside the allowlist.
  if (activeStory) {
    const config = loadConfig(root0);
    if (!isCommandAllowed(cmd, activeStory.phase, config.phaseTools)) {
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
  {
    const rawArgs = argv.slice(1);
    if (rawArgs.length === 0) {
      // No arguments; empty object.
    } else if (rawArgs.length === 1 && rawArgs[0].startsWith('{')) {
      // JSON body format (compatible with legacy usage).
      try { parsed = JSON.parse(rawArgs[0]); }
      catch (e) {
        console.error(`JSON parse failed: ${(e as Error).message}\nInput: ${rawArgs[0]}`);
        printToolHelp(tool, { stream: process.stderr, includeFooter: false, ownerLeaseHelpBlock });
        process.exit(1);
      }
    } else {
      // Flag-format parsing.
      parsed = parseFlags(rawArgs, tool.schema);
    }
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

  // Execute
  const root = resolveRootForCommand(cmd, rootOverride);
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

  const config0 = loadConfig(root);
  const scanRoot = join(root, config0.scanRoot);
  const ctx: HandlerContext = { store, root, scanRoot, log };
  const registry = createMainRegistry(ctx);
  if (opts?.extraRegister) opts.extraRegister(registry, ctx);
  const handlers = registry.toObject() as Record<string, Function>;

  // Stale state warnings — soft, never blocks. Print before handler dispatch
  // so the agent sees the reminder along with the command output. The captured
  // warnings are also passed into writeLog so activity.jsonl preserves them
  // for trend analysis (how often does the agent forget to advance?).
  let staleWarnings: string[] = [];
  try {
    staleWarnings = detectStaleState(ctx);
    if (staleWarnings.length > 0) {
      process.stderr.write('⚠ Proofbound stale state warnings:\n');
      for (const w of staleWarnings) process.stderr.write(`  - ${w}\n`);
    }
  } catch { /* never block */ }

  // Heartbeat: by default, 5 minutes without output means stuck; 15 minutes is the absolute safety limit.
  // Can be overridden with LATTICE_IDLE_TIMEOUT_MS / LATTICE_MAX_TIMEOUT_MS,
  // A single LLM call in real-machine smoke tests can occasionally exceed 2 minutes (non-deterministic cases such as text-adventure uninstall).
  const IDLE_TIMEOUT = Number(process.env.LATTICE_IDLE_TIMEOUT_MS) || (5 * 60 * 1000);
  const MAX_TIMEOUT = Number(process.env.LATTICE_MAX_TIMEOUT_MS) || (15 * 60 * 1000);
  const startTime = Date.now();
  let lastActivity = Date.now();
  const originalLog = log;
  log = (msg: string) => { lastActivity = Date.now(); originalLog(msg); };

  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - startTime > MAX_TIMEOUT) {
      originalLog(`${cmd} exceeded 10 minutes; forcing exit`);
      process.exit(2);
    }
    if (now - lastActivity > IDLE_TIMEOUT) {
      originalLog(`${cmd} stuck: ${IDLE_TIMEOUT / 1000} seconds without output; forcing exit`);
      process.exit(2);
    }
  }, 10000);
  watchdog.unref();

  // Unified logging: write to .lattice/activity.jsonl (dual-source module, legacy path is read-compatible only).
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
      // Detect this by checking if `root` still has lattice.config.json.
      // If not (the worktree was removed), prefer the durable main-root
      // fallback captured at command start — it was computed while root/.git
      // still existed, so it points at the real main project even after the
      // worktree is gone. Do NOT fall back to resolveRoot() first: its
      // cwd-walk may resolve to (and appendActivityLog would then recreate)
      // the now-deleted ghost worktree dir. Only use resolveRoot() if the
      // durable fallback is unavailable/stale, and skip logging entirely if
      // neither has a project config file rather than pollute the filesystem.
      let effectiveRoot = root;
      if (!hasProjectConfigFile(effectiveRoot)) {
        if (mainRootFallback && hasProjectConfigFile(mainRootFallback)) {
          effectiveRoot = mainRootFallback;
        } else {
          effectiveRoot = resolveRoot();
          if (!hasProjectConfigFile(effectiveRoot)) {
            return;
          }
        }
      }
      const record: Record<string, unknown> = {
        source: resolveActivitySource(),
        session: process.env.LATTICE_ACTIVITY_SESSION || '',
        entrypoint: inferCodexEntrypoint(),
        startTime: entry.startTime,
        endTime: entry.endTime,
        tool: entry.command,
        detail: entry.command,
        args: entry.args,
        status: entry.success ? 'ok' : 'fail',
        result: entry.success ? null : undefined,
        error: entry.error || null,
        storyId: storyIdFromArgs(entry.args as Record<string, unknown>, activeStory, {
          command: entry.command,
          projectRoot: effectiveRoot,
        }),
        phase: activeStory?.phase || null,
        role: inferActivityRole(entry.args, process.env.LATTICE_ACTIVITY_ROLE || process.env.LATTICE_AGENT),
      };
      if (entry.staleWarnings && entry.staleWarnings.length > 0) {
        record.staleWarnings = entry.staleWarnings;
      }
      appendActivityLog(effectiveRoot, record);
    } catch (e: unknown) {
      reportHealthIssue('persist:writeLog', e as Error, {
        command: entry.command,
        logDir: join(root, LATTICE_DIR),
      });
    }
  }

  function writeCodexProcessEvent(entry: {
    command: string;
    args: unknown;
    success: boolean;
    error?: string;
  }) {
    if (!isCodexActivitySource()) return;
    const argsObject = entry.args && typeof entry.args === 'object' && !Array.isArray(entry.args)
      ? entry.args as Record<string, unknown>
      : {};
    const storyId = storyIdFromArgs(argsObject, activeStory, { command: entry.command, projectRoot: root });
    if (!storyId) return;
    try {
      let phase = activeStory?.phase || '';
      if (!phase) {
        try { phase = store.readStory(storyId).phase; } catch { phase = ''; }
      }
      store.appendProcessEvent(storyId, {
        type: 'codex_cli',
        source: 'codex',
        session: process.env.LATTICE_ACTIVITY_SESSION || '',
        role: inferActivityRole(entry.args, process.env.LATTICE_ACTIVITY_ROLE || process.env.LATTICE_AGENT),
        storyId,
        phase,
        command: entry.command,
        entrypoint: inferCodexEntrypoint(),
        result: entry.success ? 'pass' : 'fail',
        ...(entry.error ? { errorSummary: entry.error.slice(0, 300) } : {}),
      });
    } catch (e: unknown) {
      reportHealthIssue('persist:codexProcessEvent', e as Error, {
        command: entry.command,
        storyId,
      });
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
      enforceReviewerReadOnlyCommandGate(cmd, parsed, activeStory);
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
      enforceRetiredRootGuard(cmd, parsed, config0, activeStory, root);
    } catch (e: any) {
      clearInterval(watchdog);
      log(`${cmd} failed: ${e.message}`);
      process.stderr.write(`Error: ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
    // preCommand hook — non-blocking failure, awaited so it always runs before the handler
    if (config0?.hooks?.preCommand && !READ_ONLY_COMMANDS.has(cmd)) {
      process.stderr.write(`[lattice-hook] running preCommand hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
    }
    if (!READ_ONLY_COMMANDS.has(cmd)) {
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
      enforceStoryOwnerLeaseGate(cmd, parsed, store, activeStory, root);
      let result = fn();
      if (result && typeof (result as any).then === 'function') result = await result;
      clearInterval(watchdog);
      log(`${cmd} done`);
      if (shouldWriteActivityLog(cmd, parsed) || staleWarnings.length > 0) {
        writeLog({ command: cmd, args: parsed, startTime: runStart, endTime: new Date().toISOString(), success: true, staleWarnings });
      }
      writeCodexProcessEvent({ command: cmd, args: parsed, success: true });
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
      if (config0?.hooks?.postCommand && !READ_ONLY_COMMANDS.has(cmd)) {
        process.stderr.write(`[lattice-hook] running postCommand hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
      }
      if (!READ_ONLY_COMMANDS.has(cmd)) {
        await runHooks('postCommand', cmd, buildHookEnvLocal('postCommand', {
          LATTICE_RESULT_JSON: truncateForEnv(resultText),
        }), config0, root);
      }
      const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      process.stdout.write(`${output}\n`);
      process.exitCode = 0;
      return;
    } catch (e: any) {
      clearInterval(watchdog);
      log(`${cmd} failed: ${e.message}`);
      if (shouldWriteActivityLog(cmd, parsed) || staleWarnings.length > 0) {
        writeLog({ command: cmd, args: parsed, startTime: runStart, endTime: new Date().toISOString(), success: false, error: e.message, staleWarnings });
      }
      writeCodexProcessEvent({ command: cmd, args: parsed, success: false, error: e.message });
      // onError hook — best-effort; always runs before exit(1).
      // Print a hint so the user knows why a failed command takes a few extra seconds.
      if (config0?.hooks?.onError) {
        process.stderr.write(`[lattice-hook] running onError hooks (timeout ${HOOK_TIMEOUT_MS / 1000}s/cmd)...\n`);
      }
      await runHooks('onError', cmd, buildHookEnvLocal('onError', {
        LATTICE_ERROR: String(e?.message || e),
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

  const handler = handlers[cmd];
  if (!handler) { console.error(`handler not found: ${cmd}`); process.exit(1); }

  await run(() => Object.keys(tool.schema).length === 0 ? handler() : handler(
    isAutopilotCommand(cmd)
      ? parsed
      : (v.data as Record<string, unknown>),
  ));
}
