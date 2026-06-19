/**
 * Lattice CLI engine
 *
 * Wrap the shared dispatch, parse, log, and phase-gate logic in the callable runCli function.
 * The main package cli.ts is the binary entrypoint and calls runCli() directly.
 * Third-party bootstrap scripts can pass extraTools and extraRegister to runCli to merge utility tools
 * and handlers.
 */

import { z, ZodType, ZodOptional, ZodEnum, ZodArray, ZodUnion, ZodString, ZodBoolean, ZodNumber, ZodObject } from 'zod';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { appendActivityLog } from './core/activity-log.js';
import { inferActivityRole } from './core/activity-role.js';
import { isAbsolute, join, relative } from 'path';
import { StoryStore } from './core/store.js';
import { createMainRegistry, type Registry } from './registry.js';
import type { HandlerContext } from './handlers/context.js';
import { execFileSync, execSync } from 'child_process';
import { loadConfig, isCommandAllowed, getAllowedPatterns, hasProjectConfigFile } from './core/config.js';
import { resolveStorySignedWorkspace } from './core/story-signed-workspace-resolution.js';
import { formatCommandLifecycleHint, type CommandPolicy } from './core/command-policy.js';
import { decorateResult, wantsMachineJson, type ActiveStoryInfo } from './handlers/hints.js';
import { reportHealthIssue } from './core/health.js';
import { detectStaleState } from './core/stale-detector.js';
import { runHooks, truncateForEnv, buildHookEnv as buildSharedHookEnv, HOOK_TIMEOUT_MS } from './core/hooks.js';
import { gitProbe, isGitRepository } from './core/git-probe.js';
import {
  acquireOrRefreshOwnerLease,
  formatLeaseAge,
  formatNonOwnerError,
  getSessionId,
  takeOverOwnerLease,
} from './core/story-owner-lease.js';
import { getCommandPolicy, isOwnershipClass, type OwnershipClass } from './core/command-policy.js';
import { getGuardFailureReason } from './core/machine.js';
import { SESSION_BRIEF_FOOTER } from './cli-prompts.js';
import {
  detectLatticeBrand,
  formatLatticeProductLine,
  formatLatticeVersionLine,
} from './core/lattice-brand.js';
import { LATTICE_DIR } from './core/lattice-paths.js';
import { withReentrantMainWriteLock } from './core/main-write-lock.js';
import { MAIN_TOOLS } from './cli/command-catalog.js';
import type { ToolDef } from './cli/main-tools.js';

export { MAIN_TOOLS };
export type { ToolDef };

// ── Command Catalog ──

/**
 * Process-fact verifier compatibility mirror. The command schema definitions
 * live in ./cli/command-catalog.ts; these text-only markers preserve the
 * existing verifier contract while the runtime catalog is extracted.
 *
 * name: 'agent_prompt'
 * name: 'artifact_declare'
 * name: 'audit'
 * name: 'authority_enforce_policy'
 * name: 'authority_enforce_runner'
 * name: 'authority_job_create'
 * name: 'authority_job_status'
 * name: 'authority_receipt_fetch'
 * name: 'authority_receipt_verify'
 * name: 'authority_status'
 * name: 'authority_verdict_list'
 * name: 'authority_verdict_submit'
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
 * name: 'done_recover'
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
 * name: 'recall'
 * name: 'recover_evidence'
 * name: 'release_approve_push'
 * name: 'review_escalation_fallback_set'
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
 * name: 'story_authority_resolve'
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

// ── Help ──

function describeType(t: ZodType): string {
  if (t instanceof ZodOptional) return describeType((t as any)._def.innerType);
  if (t instanceof ZodString) return 'string';
  if (t instanceof ZodNumber) return 'number';
  if (t instanceof ZodBoolean) return 'boolean';
  if (t instanceof ZodEnum) return ((t as any).options || []).join('|');
  if (t instanceof ZodArray) return 'array';
  if (t instanceof ZodObject) return 'object';
  if (t instanceof ZodUnion) return 'string|array';
  return 'any';
}

function getDesc(t: ZodType): string {
  return (t as any).description || '';
}

function unwrapOptional(t: ZodType): ZodType {
  return t instanceof ZodOptional ? (t as any)._def.innerType : t;
}

function objectShape(t: ZodObject<any>): Record<string, ZodType> {
  const anyType = t as any;
  const shape = anyType.shape ?? anyType._def?.shape;
  return typeof shape === 'function' ? shape() : shape || {};
}

function arrayElement(t: ZodArray<any>): ZodType | null {
  const anyType = t as any;
  return anyType.element || anyType._def?.type || null;
}

function nestedSchemaLines(t: ZodType, prefix: string, indent = '      '): string[] {
  const inner = unwrapOptional(t);
  if (inner instanceof ZodArray) {
    const element = arrayElement(inner);
    if (!element) return [];
    const elementInner = unwrapOptional(element);
    if (elementInner instanceof ZodObject) {
      return nestedSchemaLines(elementInner, `${prefix}[]`, indent);
    }
    return [`${indent}${prefix}[]: ${describeType(elementInner)} ${getDesc(elementInner)}`.trimEnd()];
  }
  if (!(inner instanceof ZodObject)) return [];
  const shape = objectShape(inner);
  const lines: string[] = [];
  for (const [key, child] of Object.entries(shape)) {
    const optional = child instanceof ZodOptional;
    const childInner = unwrapOptional(child);
    const path = prefix ? `${prefix}.${key}` : key;
    lines.push(`${indent}${path}${optional ? '?' : ''}: ${describeType(child)} ${getDesc(child)}`.trimEnd());
    if (childInner instanceof ZodObject || childInner instanceof ZodArray) {
      lines.push(...nestedSchemaLines(childInner, path, indent + '  '));
    }
  }
  return lines;
}

type HelpOutputOptions = {
  stream?: { write(chunk: string): unknown };
  includeFooter?: boolean;
};

function normalizeHelpText(text: string | undefined): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * @task B-e3d9
 * @checklist CHK-002
 * @title derive supportsDryRun help from live schema and command policy
 * @type refactor
 * @priority high
 * @description
 *   The abandoned cc-learnings supportsDryRun field is not the main CLI
 *   contract. Real dry-run behavior already lives in ToolDef schema flags
 *   (`dryRun` / `confirm`), command descriptions, and COMMAND_POLICIES
 *   operator-safety prose. Help derives the surfaced contract from those live
 *   inputs so we do not create a second supportsDryRun registry.
 * @changes
 *   - [CHK-002] Summarize supportsDryRun-equivalent behavior in lattice <command> --help
 *   - [CHK-002] Keep dry-run truth derived from schema/policy instead of speculative metadata
 * @test dangerous-command-guardrails
 */
function dryRunHelpLine(tool: ToolDef, policy?: CommandPolicy): string | null {
  const toolDescription = normalizeHelpText(tool.description);
  const policyReason = normalizeHelpText(policy?.reason);
  const policyReplacement = normalizeHelpText(policy?.replacement);
  const dryRunField = tool.schema.dryRun;
  const dryRunDescription = dryRunField ? normalizeHelpText(getDesc(dryRunField)) : '';
  const combined = [toolDescription, dryRunDescription, policyReason, policyReplacement]
    .filter(Boolean)
    .join(' ');
  const hasConfirmFlag = Object.prototype.hasOwnProperty.call(tool.schema, 'confirm');

  if (dryRunField) {
    if (/始终为 dry-run|always[- ]on|always dry[- ]run/i.test(combined)) {
      return `  Dry-run: always-on. ${dryRunDescription || 'This command is projection-only and never executes the side-effect path.'}`;
    }
    if (/默认 dry run|默认 dry-run|default dry run|default dry-run|默认 true/i.test(combined)) {
      return `  Dry-run: default-on via --dryRun=true. ${dryRunDescription || 'Pass --dryRun=false to execute the real path.'}`;
    }
    const confirmNote = hasConfirmFlag ? ' Real execution may also require --confirm.' : '';
    return `  Dry-run: optional via --dryRun. ${dryRunDescription || 'Preview the command without executing the real path.'}${confirmNote}`;
  }

  if (/dry[- ]run/i.test(combined)) {
    return '  Dry-run: always-on. This command only projects guidance and does not execute the side-effect path.';
  }

  return null;
}

/**
 * Returns a multi-line help block describing the `--takeover` / `--forceTakeover`
 * meta options for owner-gated CLI commands, or `null` for commands that are
 * not owner-gated (readOnly / reviewerWrite / mainSharedMutating).
 *
 * Owner-gated means `storyScopedMutating` or `dangerousMutating` — the gate in
 * `enforceStoryOwnerLeaseGate` checks both. `validate` is statically classified
 * `storyScopedMutating` so the block is shown, with a note that it only applies
 * when `--story` is supplied (boundary rule 2 downgrades it to readOnly without
 * a story argument).
 *
 * Exported so contract tests can assert the block is present for gated commands
 * and absent for read-only / reviewer-lane commands without spawning a subprocess.
 */
export function ownerLeaseHelpBlock(cmd: string): string | null {
  const policy = getCommandPolicy(cmd);
  if (!policy || !isOwnershipClass(policy.ownershipClass)) return null;
  const cls = policy.ownershipClass;
  if (cls === 'readOnly' || cls === 'reviewerWrite' || cls === 'mainSharedMutating') return null;
  // storyScopedMutating or dangerousMutating — owner-gated.
  const note = cmd === 'validate'
    ? ' (applies when --story is supplied; diagnostic validate without --story is always read-only)'
    : '';
  return [
    ``,
    `  Owner lease meta options${note}:`,
    `    --takeover          recover a stale foreign lease (no heartbeat for 30+ min)`,
    `    --forceTakeover     seize an active foreign lease (deliberate human override; also transfers stale)`,
  ].join('\n');
}

function printToolHelp(tool: ToolDef, options: HelpOutputOptions = {}) {
  const brand = detectLatticeBrand();
  const out = (line = '') => {
    if (options.stream) options.stream.write(`${line}\n`);
    else console.log(line);
  };
  const includeFooter = options.includeFooter !== false;
  const policy = getCommandPolicy(tool.name);
  const dryRunLine = dryRunHelpLine(tool, policy);

  out(`\n  ${brand.primaryBin} ${tool.name} — ${tool.description}\n`);
  out(`  ${formatLatticeProductLine(brand)}\n`);

  // If longHelp exists for a core command, print the full prompt first.
  if (tool.longHelp) {
    out(tool.longHelp);
    out('');
  }

  const entries = Object.entries(tool.schema);
  if (entries.length === 0) {
    out('  No arguments\n');
    out(`  Usage: ${brand.primaryBin} ${tool.name}`);
    if (dryRunLine) out(dryRunLine);
    const ownerBlock = ownerLeaseHelpBlock(tool.name);
    if (ownerBlock) out(ownerBlock);
    if (includeFooter) out(SESSION_BRIEF_FOOTER);
    return;
  }
  out('  Arguments:');
  const maxN = Math.max(...entries.map(([k]) => k.length));
  for (const [name, type] of entries) {
    const opt = type instanceof ZodOptional;
    const req = opt ? '' : ' *';
    const inner = type instanceof ZodOptional ? (type as any)._def.innerType : type;
    const isComplex = inner instanceof ZodArray || inner instanceof ZodObject;
    const flagHint = isComplex ? '(JSON)' : '';
    out(`    --${name.padEnd(maxN + 2)} ${describeType(type).padEnd(16)} ${getDesc(type)}${req} ${flagHint}`);
    if (isComplex) {
      for (const line of nestedSchemaLines(type, name)) out(line);
    }
  }
  const required = entries.filter(([, t]) => !(t instanceof ZodOptional));
  const optional = entries.filter(([, t]) => t instanceof ZodOptional);
  const reqParts = required.map(([k]) => `--${k}=value`);
  const optParts = optional.map(([k]) => {
    const inner = (entries.find(([n]) => n === k)?.[1] as any);
    const base = inner instanceof ZodOptional ? (inner as any)._def.innerType : inner;
    return base instanceof ZodBoolean ? `[--${k}]` : `[--${k}=value]`;
  });
  out(`\n  Usage: ${brand.primaryBin} ${tool.name} ${[...reqParts, ...optParts].join(' ')}`);
  out('  (* = required)');
  if (dryRunLine) out(dryRunLine);
  const ownerBlock = ownerLeaseHelpBlock(tool.name);
  if (ownerBlock) out(ownerBlock);
  if (includeFooter) out(SESSION_BRIEF_FOOTER);
}

function formatValidationIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `  ${path}: ${issue.message}`;
}

function printValidationFailure(tool: ToolDef, issues: z.ZodIssue[]) {
  const lines = issues.map(formatValidationIssue);
  process.stderr.write('Argument validation failed:\n');
  for (const line of lines) process.stderr.write(`${line}\n`);
  printToolHelp(tool, { stream: process.stderr, includeFooter: false });
  process.stderr.write('\nArgument validation failed (summary):\n');
  for (const line of lines) process.stderr.write(`${line}\n`);
}

function printHelp(activeStory?: ActiveStory | null) {
  const brand = detectLatticeBrand();
  console.log(`\n  ${formatLatticeProductLine(brand)} — CLI-first project workflow and host migration surface\n`);
  console.log(`  Entrypoint: ${brand.primaryBin}\n`);
  console.log(`  Usage: ${brand.primaryBin} <command> --key=value         Run command`);
  console.log(`        ${brand.primaryBin} <command> --help              View arguments`);
  console.log(`        ${brand.primaryBin} help                          Show this help`);
  console.log(`        ${brand.primaryBin} --version                     Show version`);
  console.log(`        ${brand.primaryBin} --root <path> ...             Specify project root directory\n`);

  if (activeStory) {
    console.log(`  Current Story: ${activeStory.storyId}  phase: ${activeStory.phase}\n`);
  }

  const config = loadConfig();
  const phaseTools = config.phaseTools;

  // Known prefix maps to display group name (special cases first).
  const KNOWN_GROUP: Record<string, string> = {
    story: 'Story',
    checklist: 'Checklist',
    bug: 'Bug',
    test: 'Test',
    validate: 'Validate',
    status: 'Status',
    serve: 'Serve',
    aux: 'Aux',
    evaluate: 'Evaluate',
    dashboard: 'Session',
    session: 'Session',
    audit: 'Audit',
    check: 'Check',
    release: 'Release',
    host: 'Host',
    lattice: 'Lattice',
    rollout: 'Lattice',
    authority: 'Authority',
    conduit: 'Conduit',
  };
  // Display order for known groups; groups not in the list (from extras) are appended alphabetically.
  const KNOWN_ORDER = ['Host', 'Lattice', 'Authority', 'Conduit', 'Story', 'Review', 'Checklist', 'Grill', 'Bug', 'Test', 'Validate', 'Evaluate', 'Workflow', 'Status', 'Check', 'Serve', 'Session', 'Aux', 'Audit'];

  const groups: Record<string, ToolDef[]> = {};
  for (const t of TOOLS) {
    // When an active story exists, list only commands available in the current phase.
    if (activeStory && !isCommandAllowed(t.name, activeStory.phase, phaseTools)) continue;
    const p = t.name.split('_')[0];
    let g: string;
    if (t.name === 'story_review' || t.name === 'story_review_dismiss') g = 'Review';
    else if (KNOWN_GROUP[p]) g = KNOWN_GROUP[p];
    else g = p.charAt(0).toUpperCase() + p.slice(1); // Unknown prefix: capitalize first letter.
    (groups[g] = groups[g] || []).push(t);
  }
  const filteredTools = activeStory ? TOOLS.filter(t => isCommandAllowed(t.name, activeStory.phase, phaseTools)) : TOOLS;
  const maxN = Math.max(...filteredTools.map(t => t.name.length), 0);

  const presentGroups = Object.keys(groups);
  const orderedGroups = [
    ...KNOWN_ORDER.filter(g => groups[g]),
    ...presentGroups.filter(g => !KNOWN_ORDER.includes(g)).sort(),
  ];
  for (const g of orderedGroups) {
    console.log(`  ${g}:`);
    for (const t of groups[g]) console.log(`    ${t.name.padEnd(maxN + 2)} ${t.description}`);
  }
  console.log(`
  Development flow:
    ── PLAN ──
    1. lattice story_create '{"name":"x","title":"..","description":"..","type":"feature","priority":"high","checklist":[{"title":"what to do","context":"context"}]}'
    2. lattice story_advance --storyId=B-xxx --phase=INIT_CHECK # Create local worktree/local branch
    3. cd .worktrees/B-xxx
    4. lattice story_review --storyId=B-xxx                     # Review passes, then enter DEV
    5. lattice story_advance --storyId=B-xxx --phase=DEV

    ── DEV ──
    6. Implement the code and its verification (fixtures, project-native tests, or optional validate.ts)
    7. lattice validate                                         # Verification (auto-detect by project language or read config)
    8. lattice checklist_update --storyId=B-xxx --itemId=CHK-001 --status=done

    ── REVIEW ──
    9. lattice story_advance --storyId=B-xxx --phase=REVIEW    # Enter code review
   10. Lattice reviewer reviews code and raises findings       # critical/high must resolve

    ── TEST → DONE ──
   11. lattice story_advance --storyId=B-xxx --phase=TEST
   12. lattice story_advance --storyId=B-xxx --phase=DONE     # Merge back to local main and clean worktree

  Parallelism and branch discipline:
    Lattice parallel development uses only local git worktrees plus local branches; do not create or push GitHub/origin feature branches.
    If remote publishing is needed, first let DONE merge back to local main, confirm main is clean, then a human explicitly runs lattice release_approve_push --confirm, and then manually runs git push origin main.

  Initialize a new project:
    lattice init                          # Initialize Lattice project state in the current directory

  Tip: use --key=value for simple arguments; use JSON format for complex arguments (array/object).
  Error? Use lattice <command> --help to view complete argument help.
`);
}

// ── Flag parser ──

/** Test entrypoint: accepts a JSON-described schema (string/number/boolean/array/object) and converts it to Zod internally. */
export function parseFlagsTest(rawArgs: string[], schemaDesc: Record<string, string>): Record<string, unknown> {
  const schema: Record<string, ZodType> = {};
  for (const [k, v] of Object.entries(schemaDesc)) {
    if (v === 'number') schema[k] = z.number();
    else if (v === 'boolean') schema[k] = z.boolean().optional();
    else if (v === 'array') schema[k] = z.array(z.string());
    else if (v === 'object') schema[k] = z.object({}).passthrough();
    else schema[k] = z.string();
  }
  return parseFlags(rawArgs, schema);
}

function normalizeFlagKey(key: string, schema: Record<string, ZodType>): string {
  if (schema[key]) return key;
  const camelKey = key.replace(/-([a-z0-9])/g, (_match, ch: string) => ch.toUpperCase());
  return schema[camelKey] ? camelKey : key;
}

export function parseFlags(rawArgs: string[], schema: Record<string, ZodType>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const arrayKeys = new Set(
    Object.entries(schema).filter(([, t]) => {
      const inner = t instanceof ZodOptional ? (t as any)._def.innerType : t;
      return inner instanceof ZodArray;
    }).map(([k]) => k),
  );

  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];

    if (arg.startsWith('--')) {
      // --key=value or --key value or --flag (boolean)
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        const key = normalizeFlagKey(arg.slice(2, eqIdx), schema);
        const val = arg.slice(eqIdx + 1);
        addValue(result, key, coerce(val, schema[key]), arrayKeys.has(key));
      } else {
        const key = normalizeFlagKey(arg.slice(2), schema);
        // Next argument is not a flag, so treat it as the value.
        if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('--')) {
          addValue(result, key, coerce(rawArgs[i + 1], schema[key]), arrayKeys.has(key));
          i++;
        } else {
          // bare --flag → true
          result[key] = true;
        }
      }
    } else if (arg.includes('=') && !arg.startsWith('{')) {
      // key=value without -- prefix, compatible with legacy format.
      const eqIdx = arg.indexOf('=');
      const key = normalizeFlagKey(arg.slice(0, eqIdx), schema);
      const val = arg.slice(eqIdx + 1);
      addValue(result, key, coerce(val, schema[key]), arrayKeys.has(key));
    }
    // Ignore unrecognized positional arguments.
    i++;
  }
  return result;
}

export function coerce(val: string, schemaDef?: ZodType): unknown {
  // JSON object/array
  if ((val.startsWith('{') || val.startsWith('[')) && val.length > 1) {
    try { return JSON.parse(val); } catch { /* fall through */ }
  }
  // boolean
  if (val === 'true') return true;
  if (val === 'false') return false;
  // number (only if schema expects it)
  const inner = schemaDef instanceof ZodOptional ? (schemaDef as any)._def.innerType : schemaDef;
  if (inner instanceof ZodNumber && /^-?\d+(\.\d+)?$/.test(val)) return Number(val);
  return val;
}

export function addValue(obj: Record<string, unknown>, key: string, val: unknown, isArray: boolean) {
  if (isArray) {
    if (!Array.isArray(obj[key])) obj[key] = obj[key] !== undefined ? [obj[key]] : [];
    if (Array.isArray(val)) {
      (obj[key] as unknown[]).push(...val);
    } else {
      (obj[key] as unknown[]).push(val);
    }
  } else {
    obj[key] = val;
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

// ── Resolve root ──

function resolveRoot(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.LATTICE_PROJECT_ROOT) return process.env.LATTICE_PROJECT_ROOT;
  // Walk upward to find lattice.config.json and determine the project root.
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (hasProjectConfigFile(dir)) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  // fallback: git worktree root
  const commonDir = gitProbe('git rev-parse --git-common-dir');
  if (commonDir.ok) {
    const cd = commonDir.output;
    if (cd !== '.git' && !cd.endsWith('/.git') && !cd.endsWith('\\.git')) {
      const wtList = gitProbe('git worktree list --porcelain');
      if (wtList.ok) {
        return wtList.output.split('\n')[0]?.replace('worktree ', '').trim() || process.cwd();
      }
    }
  }
  return process.cwd();
}

function resolveMainRootFromWorktreeRoot(root: string): string | null {
  try {
    const dotGit = join(root, '.git');
    if (!existsSync(dotGit)) return null;
    const content = readFileSync(dotGit, 'utf-8').trim();
    const m = content.match(/^gitdir:\s*(.+)$/i);
    if (!m) return null;
    const gitdir = m[1].trim();
    const absGitdir = gitdir.startsWith('/') ? gitdir : join(root, gitdir);
    const marker = `${join('.git', 'worktrees')}`;
    const normalized = absGitdir.replace(/\\/g, '/');
    const markerNormalized = marker.replace(/\\/g, '/');
    const idx = normalized.indexOf(`/${markerNormalized}/`);
    if (idx === -1) return null;
    return normalized.slice(0, idx);
  } catch {
    return null;
  }
}

function resolveRootForCommand(cmd: string, explicit?: string): string {
  const root = resolveRoot(explicit);
  if (cmd !== 'story_discard') return root;
  return resolveMainRootFromWorktreeRoot(root) || root;
}

// ── Activity log filter ──

/**
 * Read-only commands that should NOT write activity.jsonl by default.
 * These are pure queries / status checks — logging them pollutes
 * the audit trail and can cause DONE dirty-self-block (B-c622).
 * Codex wrapper sessions opt in because session_brief is their primary
 * cross-session tracking heartbeat.
 */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'session_brief',
  'next',
  'done_closure',
  'status',
  'story_get',
  'story_list',
  'checklist_get',
  'finding_list',
  'bug_list',
  'test_list',
  'aux_doc_list',
  'capability_list',
  'capability_probe',
  'agent_prompt',
  'baseline_run',
  'baseline_suite',
  'baseline_suite_report',
  'capability_claim_evaluate',
  'capability_claim_formal_evaluate',
  'memory_benchmark_run',
  'memory_benchmark_compare',
  'memory_benchmark_real_data',
  'host_list',
  'host_probe',
  'host_status',
  'host_runtime_list',
  'host_runtime_probe',
  'host_install',
  'lattice_config_doctor',
  'rollout_check',
  'baseline_suite_report',
  'authority_status',
  'conduit_status',
  'conduit_explain',
  'story_export',
  'story_authority_resolve',
  'observability_snapshot',
  'handoff_create',
  'handoff_inspect',
  'handoff_accept',
  'handoff_resume',
  'handoff_receipt_submit',
  'handoff_worktree_create',
  'host_dispatch',
  'dispatch_plan',
  'dispatch_status',
  'dispatch_list',
  'dispatch_review',
  'dispatch_merge_plan',
  'evidence_manifest',
  'evidence_inspect',
  'parallel_wave_create',
  'parallel_wave_inspect',
  'parallel_plan',
  'parallel_dispatch',
  'parallel_status',
  'parallel_merge_queue',
  'parallel_report',
  'grill_get',
  'reviewer_list',
  'review_incremental_context',
  'workflow_explain',
  'help',
  'authority_enforce_policy',
  'authority_enforce_runner',
  'dispatch_policy_get',
  'dispatch_policy_check',
  'dispatch_watch',
  'autopilot_policy_get',
  'autopilot_policy_check',
  'autopilot_status',
  'autopilot_watch',
  'autopilot_review',
  'learning_validate', // read-only Experience Layer validity instrument; writes nothing
  'learning_effectiveness', // read-only Experience Layer effectiveness instrument; writes nothing
]);

function inferCodexEntrypoint(): string {
  if (process.env.LATTICE_CODEX_ENTRYPOINT) return process.env.LATTICE_CODEX_ENTRYPOINT;
  const invoked = process.argv[1] || '';
  if (invoked.includes('lattice-codex')) return 'local-wrapper';
  if (process.env.LATTICE_ACTIVITY_SOURCE === 'codex') return 'global-fallback';
  return 'cli';
}

const AUTOPILOT_RUN_OWNER_GATED_COMMANDS = new Set([
  'autopilot_cancel',
  'autopilot_resume',
]);

function safeAutopilotRunId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(trimmed) ? trimmed : null;
}

export function storyIdFromAutopilotRunId(projectRoot: string, args: Record<string, unknown>): string | null {
  const runId = safeAutopilotRunId(args.runId ?? args.autopilotId);
  if (!runId) return null;
  const file = [
    join(projectRoot, LATTICE_DIR, 'autopilot-runs', runId, 'run.json'),
  ].find((candidate) => existsSync(candidate));
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { storyId?: unknown };
    return typeof parsed.storyId === 'string' && parsed.storyId.trim()
      ? parsed.storyId.trim()
      : null;
  } catch {
    return null;
  }
}

function storyIdFromArgs(
  args: Record<string, unknown>,
  activeStory?: ActiveStory | null,
  context?: { command?: string; projectRoot?: string },
): string | null {
  if (typeof args.storyId === 'string' && args.storyId.trim()) return args.storyId.trim();
  if (typeof args.story === 'string' && args.story.trim()) return args.story.trim();
  if (
    context?.command &&
    context.projectRoot &&
    AUTOPILOT_RUN_OWNER_GATED_COMMANDS.has(context.command)
  ) {
    const runStoryId = storyIdFromAutopilotRunId(context.projectRoot, args);
    if (runStoryId) return runStoryId;
  }
  return activeStory?.storyId || null;
}

/**
 * B-c55d CHK-002: resolve the EFFECTIVE ownership class of a single command
 * invocation.
 *
 * The static `CommandPolicy.ownershipClass` is the base classification; this
 * function applies the four dynamic boundary rules from
 * session-ownership-and-write-leases.md (and the story plan) that depend on the
 * actual invocation arguments:
 *
 *  1. `finding_resolve` / `finding_dismiss` — `storyScopedMutating` for a normal
 *     story, but `mainSharedMutating` when the target is a B-META story (the
 *     B-f60c main write lock serializes those; `finding.ts` already routes the
 *     write through `withMetaFindingLock`). So a B-META finding mutation must
 *     NOT be owner-lease-gated.
 *  2. `validate` — `storyScopedMutating` only when `--story` is supplied (it
 *     then writes story TEST/DONE gate evidence). A diagnostic `validate` with
 *     no `--story` mutates no story state → downgraded to `readOnly`.
 *  3. `delivery_check_set` — `reviewerWrite` only when the resolved actor is
 *     `lattice-review-delivery`; any other caller is treated as
 *     `storyScopedMutating` so a main agent cannot borrow it to bypass the
 *     owner lease.
 *  4. `dev_memory_finish --scope=global` with no explicit story target is
 *     `mainSharedMutating`: it promotes non-authoritative project memory to
 *     global memory and must not be owner-lease-gated by the active story.
 *
 * Returns `null` when the command has no policy entry OR its `ownershipClass`
 * is not a valid enum value — the gate treats `null` as FAIL-CLOSED (an
 * unclassified command is rejected, never default-allowed).
 */
export function resolveEffectiveOwnershipClass(
  cmd: string,
  args: Record<string, unknown>,
  storyId: string | null,
): OwnershipClass | null {
  const policy = getCommandPolicy(cmd);
  // Runtime enum re-validation (CLAUDE.md Handler coding convention): a missing policy
  // OR a policy whose `ownershipClass` is not a valid enum value is fail-closed.
  if (!policy || !isOwnershipClass(policy.ownershipClass)) return null;
  let cls: OwnershipClass = policy.ownershipClass;

  // Boundary rule 1: a B-META finding mutation is mainSharedMutating.
  if ((cmd === 'finding_resolve' || cmd === 'finding_dismiss') && storyId && storyId.startsWith('B-META-')) {
    cls = 'mainSharedMutating';
  }

  // Boundary rule 2: a diagnostic `validate` without --story is readOnly.
  if (cmd === 'validate') {
    const hasStory =
      (typeof args.story === 'string' && args.story.trim().length > 0) ||
      (typeof args.storyId === 'string' && args.storyId.trim().length > 0);
    cls = hasStory ? 'storyScopedMutating' : 'readOnly';
  }

  // Boundary rule 3: delivery_check_set is reviewerWrite ONLY for the delivery
  // reviewer actor; any other caller is owner-gated as storyScopedMutating.
  if (cmd === 'delivery_check_set') {
    cls = isDeliveryReviewerActor(args) ? 'reviewerWrite' : 'storyScopedMutating';
  }

  // Boundary rule 4: global dev-memory promotion is a main shared metadata write.
  if (cmd === 'dev_memory_finish') {
    const hasExplicitStory =
      (typeof args.story === 'string' && args.story.trim().length > 0) ||
      (typeof args.storyId === 'string' && args.storyId.trim().length > 0);
    if (!hasExplicitStory && args.scope === 'global') {
      cls = 'mainSharedMutating';
    }
  }

  return cls;
}

/**
 * B-c55d CHK-002: whether a `delivery_check_set` invocation is acting AS the
 * delivery reviewer (`lattice-review-delivery`).
 *
 * The actor is resolved from the explicit `agentId` argument first, then the
 * `LATTICE_AGENT` environment variable — the same precedence the
 * `delivery_check_set` handler records into `delivery-check.json`. Only the
 * exact `lattice-review-delivery` lane qualifies for the reviewerWrite exemption;
 * a main agent (or any other agent id) does NOT, so it cannot borrow
 * `delivery_check_set` to bypass the owner lease.
 *
 * NOTE: this only decides the owner-lease exemption. The delivery evidence's
 * own signature / phase rules are still enforced inside `delivery_check_set`
 * and by the TEST→DONE delivery-check gate — the exemption is never a free
 * pass to write.
 */
export function isDeliveryReviewerActor(args: Record<string, unknown>): boolean {
  const explicit = typeof args.agentId === 'string' ? args.agentId.trim() : '';
  const env = typeof process.env.LATTICE_AGENT === 'string' ? process.env.LATTICE_AGENT.trim() : '';
  const actor = explicit || env;
  return actor === 'lattice-review-delivery';
}

/**
 * B-c55d CHK-003: the takeover intent of a single CLI invocation.
 *
 *  - `none`          → no takeover flag; a foreign lease stays rejected.
 *  - `takeover`      → `--takeover`; transfers a STALE foreign lease only.
 *  - `forceTakeover` → `--forceTakeover`; transfers an ACTIVE foreign lease too
 *    (deliberate human override). Implies `--takeover` semantics for a stale
 *    lease as well, so `--forceTakeover` always wins when both are present.
 */
export type TakeoverIntent = 'none' | 'takeover' | 'forceTakeover';

/**
 * Resolve the takeover intent from parsed CLI args.
 *
 * `parseFlags` records a bare `--takeover` / `--forceTakeover` as boolean
 * `true`; an `=value` form may also yield a string. Runtime re-validation (per
 * "Handler coding convention"): the flag counts as set ONLY for a real boolean `true` or
 * the literal string `"true"` — any other value (a typo'd `--takeover=maybe`)
 * is treated as NOT set, so a malformed flag can never silently authorize a
 * dangerous lease transfer. `--forceTakeover` outranks `--takeover`.
 */
export function resolveTakeoverIntent(args: Record<string, unknown>): TakeoverIntent {
  const isSet = (v: unknown): boolean => v === true || v === 'true';
  if (isSet(args.forceTakeover)) return 'forceTakeover';
  if (isSet(args.takeover)) return 'takeover';
  return 'none';
}


/**
 * B-c55d CHK-002: the single CLI choke-point story owner lease GATE.
 *
 * Runs once in the `run()` wrapper for every command — ownership is NEVER
 * checked inside individual handlers. Behavior by effective ownership class
 * (see `resolveEffectiveOwnershipClass`):
 *
 *  - `readOnly` / `reviewerWrite` / `mainSharedMutating` → not owner-gated. The
 *    function returns without acquiring or rejecting. (`reviewerWrite` is
 *    exempt from the owner lease but still bound by its own reviewer-run /
 *    signature gates inside the handler; `mainSharedMutating` is serialized by
 *    the B-f60c main write lock.)
 *  - `storyScopedMutating` / `dangerousMutating` → owner-gated. With a
 *    resolvable story:
 *      · no lease on disk            → this session acquires it (becomes owner);
 *      · lease owned by this session → heartbeat is refreshed;
 *      · lease owned by ANOTHER session (`foreign`) → CHK-003: if the
 *        invocation carries an explicit takeover flag the lease may be
 *        transferred (`--takeover` for a STALE lease, `--forceTakeover` for an
 *        ACTIVE one) — the transfer rewrites the lease and records a
 *        `story-owner-lease-takeover` audit event, then the command proceeds.
 *        Without a flag (or a `--takeover` on a still-active lease) the command
 *        is REJECTED fail-closed with owner guidance.
 *  - unclassified (no policy / invalid `ownershipClass`) → REJECTED fail-closed.
 *    An unclassified command is never default-allowed.
 *
 * Throws an `Error` on rejection; the `run()` catch block surfaces it as the
 * command failure. A non-owner session performs NO write (the lease primitive
 * observes a foreign lease without stealing it).
 */
export function enforceStoryOwnerLeaseGate(
  cmd: string,
  args: Record<string, unknown>,
  store: StoryStore,
  activeStory: ActiveStory | null,
  projectRoot: string,
): void {
  const storyId = storyIdFromArgs(args, activeStory, { command: cmd, projectRoot });
  const cls = resolveEffectiveOwnershipClass(cmd, args, storyId);

  // Fail-closed: an unclassified command (no policy entry, or a policy with an
  // invalid `ownershipClass`) is rejected, never default-allowed.
  if (cls === null) {
    throw new Error(
      `Command "${cmd}" has no valid ownershipClass in command-policy.ts and is rejected fail-closed. ` +
      `Every registered command must declare a CommandPolicy.ownershipClass (readOnly / storyScopedMutating / ` +
      `reviewerWrite / mainSharedMutating / dangerousMutating). Add a classified policy entry and rerun.`,
    );
  }

  // Not owner-gated: readOnly (no story state mutated), reviewerWrite (exempt —
  // bound by its own reviewer-run/signature gates), mainSharedMutating
  // (serialized by the B-f60c main write lock, not the owner lease).
  if (cls === 'readOnly' || cls === 'reviewerWrite' || cls === 'mainSharedMutating') {
    return;
  }

  // Owner-gated: storyScopedMutating / dangerousMutating.
  if (!storyId) return; // no story resolves → nothing to own (e.g. a draft).
  const storyDir = store.storyDirPath(storyId);
  if (!existsSync(storyDir)) return; // story dir absent → command will fail on its own.

  const { lease, action } = acquireOrRefreshOwnerLease(storyDir, {
    command: cmd,
    cwd: process.cwd(),
  });

  // `acquired` / `refreshed` → the current session owns the lease; proceed.
  if (action !== 'foreign') return;

  // `foreign` → another session owns this story.
  //
  // B-c55d CHK-003: before the fail-closed rejection, check for an explicit
  // takeover flag. A takeover is a `dangerousMutating` action — it requires
  // explicit operator intent (`--takeover` / `--forceTakeover`) and always
  // records an audit event. Without a flag, NOTHING is transferred and the
  // CHK-002 fail-closed rejection stands.
  const intent = resolveTakeoverIntent(args);
  if (intent !== 'none') {
    const result = takeOverOwnerLease(storyDir, {
      kind: intent,
      command: cmd,
      cwd: process.cwd(),
      projectRoot,
    });
    if (result.transferred) {
      // The lease now belongs to this session — the takeover event was logged.
      // Proceed: the owner-gated command runs as the new owner.
      return;
    }
    // `--takeover` on an ACTIVE (non-stale) lease → refuse, and tell the
    // operator the active lease needs the explicit `--forceTakeover` override.
    if (result.reason === 'lease-active') {
      const activeAgeMs = Date.now() - Date.parse(lease.heartbeatAt);
      const activeAge = Number.isFinite(activeAgeMs) ? formatLeaseAge(activeAgeMs) : 'unknown';
      throw new Error(
        `${storyId} is owned by another Lattice session (${lease.sessionId}) whose owner lease is ` +
        `still ACTIVE (heartbeat ${activeAge} ago). --takeover only transfers a STALE lease ` +
        `(no heartbeat for 30+ minutes). To seize an active session's lock, rerun with ` +
        `--forceTakeover — a deliberate human override.`,
      );
    }
    // `no-lease` / `already-owned` are not expected here (a foreign lease was
    // just observed); fall through to the standard rejection for safety.
  }

  // No takeover flag (or a takeover that did not transfer): reject fail-closed
  // with owner guidance. The lease primitive performed NO write (no silent
  // steal). The full multi-field rejection message — story / owner sessionId /
  // owner cwd / heartbeat age / stale verdict / allowed next action — is built
  // by the single `formatNonOwnerError` pure formatter so the message can never
  // drift from the `session-ownership-and-write-leases.md` § Error UX contract.
  throw new Error(
    formatNonOwnerError(lease, {
      storyId,
      command: cmd,
      ownershipClass: cls,
      currentSessionId: getSessionId(),
      currentCwd: process.cwd(),
    }),
  );
}

// ─── B-4f15 CHK-002: read-only reviewer command guard ───────────────────────

/** Environment variable name that activates read-only reviewer mode. */
export const REVIEWER_READONLY_ENV = 'LATTICE_REVIEWER_READONLY';

/** Returns true when the process is running as a read-only reviewer. */
export function isReviewerReadOnlyModeEnabled(): boolean {
  return process.env[REVIEWER_READONLY_ENV] === '1';
}

/**
 * B-4f15 CHK-002: pre-hook, pre-lease gate for read-only reviewer mode.
 *
 * When LATTICE_REVIEWER_READONLY=1, only commands whose EFFECTIVE ownershipClass
 * is `readOnly` are permitted. All other classes — `reviewerWrite`,
 * `storyScopedMutating`, `mainSharedMutating`, `dangerousMutating`, and
 * unclassified (null) — are rejected fail-closed.
 *
 * This gate must run BEFORE preCommand hooks and before enforceStoryOwnerLeaseGate
 * so a blocked command never triggers hooks or acquires/mutates lease state.
 *
 * Throws an Error on rejection; callers surface it as a command failure.
 */
export function enforceReviewerReadOnlyCommandGate(
  cmd: string,
  args: Record<string, unknown>,
  activeStory: ActiveStory | null,
): void {
  if (!isReviewerReadOnlyModeEnabled()) return;

  const storyId = storyIdFromArgs(args, activeStory);
  const cls = resolveEffectiveOwnershipClass(cmd, args, storyId);

  if (cls === 'readOnly') return;

  const clsLabel = cls === null ? 'unclassified' : cls;
  throw new Error(
    `[${REVIEWER_READONLY_ENV}=1] Command "${cmd}" is not allowed in read-only reviewer mode ` +
    `(effective ownershipClass: ${clsLabel}). ` +
    `Advisory read-only reviewers may only run read-only Lattice commands and should return ` +
    `structured findings to the story owner. ` +
    `To run write commands, unset ${REVIEWER_READONLY_ENV} and ensure you are the story owner.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide whether a CLI invocation should be recorded in activity.jsonl.
 * Returns false for read-only commands and dry-run invocations.
 */
export function shouldWriteActivityLog(cmdName: string, args: Record<string, unknown>): boolean {
  if (READ_ONLY_COMMANDS.has(cmdName)) {
    return process.env.LATTICE_ACTIVITY_RECORD_READONLY === '1';
  }
  if (args.dryRun === true) return false;
  return true;
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

/**
 * B-f60c CHK-002 — close F-008 partial-DONE at the INIT_CHECK write side.
 *
 * Root cause (verified, B-6974 / B-ad12 real-machine repros): `story_advance
 * INIT_CHECK` runs `story_advance` (writes phase) then `dev_start` (writes
 * `story.worktree` into the MAIN repo's `.lattice/story/actives/<id>/index.json`).
 * `dev_start.createScopedStoryBootstrapCommit` commits the story dir onto the
 * `story/<id>` branch via a TEMPORARY git index — it never touches the main
 * repo's working tree or index. So the main checkout is left with an
 * UNCOMMITTED story-metadata mirror (the story dir is untracked, since
 * `story_create` only wrote files without committing them).
 *
 * At DONE, `applyDoneMergeEffects` Step 3 runs `git merge story/<id>` from the
 * main repo root. The story branch carries a committed
 * `.lattice/story/actives/<id>/index.json`; the main working tree has the SAME
 * path untracked → git aborts the merge ("untracked working tree files would
 * be overwritten by merge") → partial-DONE (story marked DONE, branch never
 * merged).
 *
 * Fix: commit that mirror on the current (main) branch right after `dev_start`,
 * exactly mirroring what `commitFromDraftMetadataAndMergeMain` already does for
 * the from-draft path, then merge the base branch into the story worktree so
 * the story branch still contains all of main. After this the DONE merge has
 * nothing uncommitted to collide with. Just serializing the DONE critical
 * section (CHK-001's lock) cannot close F-008 — the stale mirror must be
 * removed from the main working tree at its INIT_CHECK source.
 *
 * Idempotent: a retry where the story dir is already committed stages nothing
 * and returns '' (no-op) instead of throwing.
 */
/**
 * B-4e06 CHK-003: resolve the git "main checkout" root for INIT_CHECK metadata
 * reconciliation. With a configured gitRoot (wrapper-root project), the main
 * checkout IS the resolved git root, not the metadata wrapper. Reuses the shared
 * signed-workspace resolver — no second resolver. Falls back to the metadata
 * root for plain repos (byte-for-byte unchanged).
 */
function resolveInitCheckGitMainRoot(root: string, store: StoryStore, storyId: string): string {
  const configuredGitRoot = loadConfig(root).gitRoot?.trim();
  if (!configuredGitRoot) return root;
  const resolution = resolveStorySignedWorkspace({ store, storyId, metadataRoot: root });
  if (resolution.resolved && resolution.repoRoot) return resolution.repoRoot;
  throw new Error(
    `INIT_CHECK metadata reconcile: configured gitRoot is unusable (${resolution.unresolvedReason || 'unresolved'}).`,
  );
}

export function commitInitCheckMetadataAndMergeMain(root: string, store: StoryStore, storyId: string): string {
  const gitMainRoot = resolveInitCheckGitMainRoot(root, store, storyId);
  const currentBranch = gitCli(gitMainRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (currentBranch.startsWith('story/')) {
    // INIT_CHECK is the standard worktree-creation entry and must run from the
    // main checkout. If we are already on a story branch, dev_start would not
    // have created a main-side mirror to reconcile — leave it untouched.
    return '';
  }

  // storyRel must be relative to the git main root so `git add` works whether or
  // not the metadata root is the git root. Canonicalize both sides (realpath) so
  // a /var → /private/var symlink does not corrupt the relative path. When
  // gitMainRoot === root this equals the legacy bounded storyDirRel/storyId path.
  const storyAbs = join(root, store.storyDirRel(), storyId);
  const canonicalStoryAbs = existsSync(storyAbs) ? realpathSync(storyAbs) : storyAbs;
  const canonicalGitMainRoot = existsSync(gitMainRoot) ? realpathSync(gitMainRoot) : gitMainRoot;
  const storyRelRaw = relative(canonicalGitMainRoot, canonicalStoryAbs).replace(/\\/g, '/');
  if (!storyRelRaw || isAbsolute(storyRelRaw) || storyRelRaw.split('/').includes('..')) {
    throw new Error(
      `INIT_CHECK metadata reconcile: story metadata path ${storyAbs} is not inside the git root ${gitMainRoot}; ` +
      `configure storyDir so story metadata lives inside the gitRoot.`,
    );
  }
  const storyRel = storyRelRaw;
  stageBoundedMetadataPath(gitMainRoot, storyRel);
  const staged = gitCli(gitMainRoot, ['diff', '--cached', '--name-only']);
  const stagedPaths = staged.split('\n').map((line) => line.trim()).filter(Boolean);
  if (stagedPaths.length === 0) {
    // Story metadata already committed (retry / already-tracked) — nothing to
    // reconcile, the DONE merge will not collide.
    return '';
  }
  const outOfBounds = stagedPaths.filter((path) => !isPathUnderAny(path, [storyRel]));
  if (outOfBounds.length > 0) {
    throw new Error(
      `INIT_CHECK metadata commit refused out-of-bounds staged paths:\n${outOfBounds.join('\n')}`,
    );
  }

  const commitMessage = `lattice: INIT_CHECK metadata ${storyId}`;
  const story = store.readStory(storyId);
  const worktreePath = story.worktree?.path;
  const storyBranch = story.worktree?.branch || `story/${storyId}`;
  if (!worktreePath) {
    throw new Error(`INIT_CHECK story ${storyId} has no recorded worktree path after dev_start`);
  }
  const worktreeAbs = isAbsolute(worktreePath) ? worktreePath : join(gitMainRoot, worktreePath);

  // B-7365: serialize the commit-on-main + merge-into-story-worktree critical
  // section under the unified main write lock. A concurrent session committing
  // to main between our commit and our merge is exactly what produces a
  // divergent `index.json` and the merge conflict this function must survive;
  // holding the lock across BOTH steps closes that race. Reentrant variant:
  // INIT_CHECK can run inside an already-locked context (the lock is released
  // in the helper's finally even when the critical section throws).
  return withReentrantMainWriteLock(gitMainRoot, () => {
    gitCli(gitMainRoot, [
      '-c', 'commit.gpgsign=false',
      'commit',
      '-m', commitMessage,
    ]);
    const mainHead = gitCli(gitMainRoot, ['rev-parse', '--short', 'HEAD']);
    const boundedStatus = gitCli(gitMainRoot, ['status', '--porcelain', '--', storyRel]);
    if (boundedStatus) {
      throw new Error(
        `INIT_CHECK metadata committed, but bounded story path is still dirty (${storyRel}):\n${boundedStatus}`,
      );
    }

    mergeBaseBranchIntoStoryWorktreeResolvingMetadata({
      worktreeAbs,
      baseBranch: currentBranch,
      storyRel,
    });
    gitCli(worktreeAbs, ['merge-base', '--is-ancestor', currentBranch, storyBranch]);

    return [
      `✓ INIT_CHECK metadata committed on ${currentBranch}: ${mainHead} (${commitMessage})`,
      `✓ ${currentBranch} merged into ${storyBranch}`,
    ].join('\n');
  }, { label: 'INIT_CHECK reconcile' });
}

/**
 * B-7365: merge `baseBranch` (main) into the story worktree's branch, resolving
 * any conflict on the machine-generated story metadata deterministically to the
 * post-advance (base/main-committed) version — NEVER leaving or committing
 * `<<<<<<< / ======= / >>>>>>>` conflict markers in `index.json` (or any other
 * file under `storyRel`).
 *
 * Rationale: the story metadata under `storyRel` is machine-owned and
 * authoritative on the base branch right after INIT_CHECK advanced it; the
 * story branch's copy is the pre-advance bootstrap snapshot. So on a conflict
 * the correct, deterministic resolution is "take base/main's version" for every
 * conflicted path under `storyRel`. Anything conflicting OUTSIDE `storyRel` is
 * not machine-owned and cannot be silently auto-resolved — we abort the merge
 * and throw a clear recovery error rather than guess.
 *
 * The clean (no-conflict) path is byte-identical to the legacy bare
 * `git merge <base> --no-edit`: `git merge` returns 0, we return immediately.
 */
function mergeBaseBranchIntoStoryWorktreeResolvingMetadata(args: {
  worktreeAbs: string;
  baseBranch: string;
  storyRel: string;
}): void {
  const { worktreeAbs, baseBranch, storyRel } = args;

  // Run the merge WITHOUT throwing on a non-zero exit so a conflict can be
  // inspected + resolved rather than surfacing as an opaque marker corruption.
  const merge = runGitNoThrow(worktreeAbs, [
    '-c', 'commit.gpgsign=false',
    'merge', baseBranch, '--no-edit',
  ]);
  if (merge.code === 0) {
    // Clean (no-conflict) path: byte-identical to the legacy bare merge — git
    // has already created the merge commit. Return immediately.
    return;
  }

  // Non-zero exit: determine whether this is a resolvable metadata conflict.
  // `git diff --name-only --diff-filter=U` lists exactly the unmerged
  // (conflicted) paths, repo-relative with forward slashes.
  const conflicted = runGitNoThrow(worktreeAbs, ['diff', '--name-only', '--diff-filter=U'])
    .stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (conflicted.length === 0) {
    // Non-zero with no unmerged paths is NOT a content conflict (e.g. the base
    // branch is unknown, a dirty worktree blocked the merge, a hook failed).
    // Do not pretend to resolve it: abort any half-started merge and surface the
    // real git error for recovery.
    runGitNoThrow(worktreeAbs, ['merge', '--abort']);
    throw new Error(
      `INIT_CHECK reconcile: git merge ${baseBranch} into the story worktree failed and is not a ` +
      `metadata conflict (no unmerged paths). git said:\n${(merge.stderr || merge.stdout).trim()}`,
    );
  }

  // Any conflicted path OUTSIDE the machine-owned story dir cannot be safely
  // auto-resolved (it is not machine-generated metadata we own a canonical
  // version of). Abort the merge cleanly and throw a clear recovery error —
  // never leave/commit markers.
  const outOfBounds = conflicted.filter((path) => !isPathUnderAny(path, [storyRel]));
  if (outOfBounds.length > 0) {
    runGitNoThrow(worktreeAbs, ['merge', '--abort']);
    throw new Error(
      `INIT_CHECK reconcile: merge of ${baseBranch} conflicted on non-metadata paths that cannot be ` +
      `auto-resolved:\n${outOfBounds.join('\n')}\n` +
      `Aborted the merge to avoid committing conflict markers. Resolve manually in the worktree ` +
      `(git merge ${baseBranch}) and retry.`,
    );
  }

  // Every conflicted path is under the machine-owned story dir. Resolve each to
  // the post-advance (base/main) version. We merged `baseBranch` INTO the story
  // branch, so `--theirs` is the incoming base branch's version. Stage the
  // resolved content so no markers remain, then complete the merge commit.
  //
  // The throwing gitCli calls below (stage / rm / commit) can fail for reasons
  // outside our control (locked index, hook failure, disk error). If any of
  // them throws, the exception must NOT escape with the worktree left mid-merge
  // (MERGE_HEAD present) — that would require manual `git merge --abort`
  // recovery. Wrap the resolution + commit in try/catch so ANY throw aborts the
  // half-started merge before rethrowing, mirroring the out-of-bounds and
  // still-unmerged abort+throw handling above.
  try {
    for (const path of conflicted) {
      // `git checkout --theirs` takes the base/main version for content (and
      // add/add) conflicts. For a modify/delete conflict where base DELETED the
      // path there is no "theirs" stage and checkout errors — in that case the
      // deterministic "take base" resolution is to delete the path too.
      const tookTheirs = runGitNoThrow(worktreeAbs, ['checkout', '--theirs', '--', path]);
      if (tookTheirs.code === 0) {
        gitCli(worktreeAbs, ['add', '--', path]);
      } else {
        gitCli(worktreeAbs, ['rm', '-f', '--', path]);
      }
    }

    // Defensive: confirm no unmerged paths remain before committing so a marker
    // can never reach a commit object. (Re-check the same invariant rather than
    // trusting the loop above blindly — Handler coding convention.)
    const stillUnmerged = runGitNoThrow(worktreeAbs, ['diff', '--name-only', '--diff-filter=U'])
      .stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (stillUnmerged.length > 0) {
      runGitNoThrow(worktreeAbs, ['merge', '--abort']);
      throw new Error(
        `INIT_CHECK reconcile: failed to fully resolve metadata conflict; unmerged paths remain:\n` +
        `${stillUnmerged.join('\n')}\nAborted the merge to avoid committing conflict markers.`,
      );
    }

    gitCli(worktreeAbs, ['-c', 'commit.gpgsign=false', 'commit', '--no-edit']);
  } catch (e) {
    // Any failure while resolving/committing the metadata conflict must leave
    // the worktree clean rather than mid-merge. Abort the half-started merge
    // (best-effort, no-throw) before surfacing the original error.
    runGitNoThrow(worktreeAbs, ['merge', '--abort']);
    throw e;
  }
}

/**
 * Run a git command capturing stdout/stderr/exit code WITHOUT throwing on a
 * non-zero exit. Needed for `git merge`, whose conflict exit code (1) must be
 * inspected and resolved rather than surfacing as an opaque thrown error.
 */
function runGitNoThrow(cwd: string, gitArgs: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', gitArgs, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: stdout ?? '', stderr: '' };
  } catch (e: any) {
    return {
      code: typeof e?.status === 'number' ? e.status : 1,
      stdout: e?.stdout ? String(e.stdout) : '',
      stderr: e?.stderr ? String(e.stderr) : String(e?.message ?? e),
    };
  }
}

// ── Main ──

/**
 * runCli: Lattice CLI runtime entry point.
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

  if (!cmd || cmd === 'help' || cmd === '--help') { printHelp(activeStory); return; }
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
  const aliasStart = cmd === 'lattice' ? 1 : 0;
  const aliasMap: Record<string, string> = {
  'host list': 'host_list',
  'host probe': 'host_probe',
  'host status': 'host_status',
  'host runtime list': 'host_runtime_list',
  'host runtime probe': 'host_runtime_probe',
  'host install': 'host_install',
  'host dispatch': 'host_dispatch',
  'dispatch plan': 'dispatch_plan',
  'dispatch prepare': 'dispatch_prepare',
  'dispatch run': 'dispatch_run',
  'dispatch collect': 'dispatch_collect',
  'dispatch receipt create': 'dispatch_receipt_create',
  'dispatch status': 'dispatch_status',
  'dispatch list': 'dispatch_list',
  'dispatch resume': 'dispatch_resume',
  'dispatch cancel': 'dispatch_cancel',
  'dispatch review': 'dispatch_review',
  'dispatch merge plan': 'dispatch_merge_plan',
  'dispatch policy create': 'dispatch_policy_create',
  'dispatch policy get': 'dispatch_policy_get',
  'dispatch policy check': 'dispatch_policy_check',
  'dispatch auto': 'dispatch_auto',
  'dispatch watch': 'dispatch_watch',
  'autopilot policy create': 'autopilot_policy_create',
  'autopilot policy get': 'autopilot_policy_get',
  'autopilot policy check': 'autopilot_policy_check',
  'autopilot run': 'autopilot_run',
  'autopilot status': 'autopilot_status',
  'autopilot watch': 'autopilot_watch',
  'autopilot cancel': 'autopilot_cancel',
  'autopilot review': 'autopilot_review',
  'autopilot resume': 'autopilot_resume',
  'overflow auto': 'overflow_auto',
  'handoff create': 'handoff_create',
  'handoff inspect': 'handoff_inspect',
  'handoff accept': 'handoff_accept',
  'handoff resume': 'handoff_resume',
  'handoff receipt submit': 'handoff_receipt_submit',
  'handoff worktree create': 'handoff_worktree_create',
  'config doctor': 'lattice_config_doctor',
  'config repair': 'lattice_config_repair',
  'codex verify': 'verify_codex',
  'codex doctor': 'codex_doctor',
  'rollout check': 'rollout_check',
  'baseline run': 'baseline_run',
  'baseline suite': 'baseline_suite',
  'baseline suite report': 'baseline_suite_report',
  'capability claim formal evaluate': 'capability_claim_formal_evaluate',
  'authority status': 'authority_status',
  'authority enforce policy': 'authority_enforce_policy',
  'authority enforce runner': 'authority_enforce_runner',
  'authority receipt verify': 'authority_receipt_verify',
  'authority receipt fetch': 'authority_receipt_fetch',
  'authority job create': 'authority_job_create',
  'authority job status': 'authority_job_status',
  'authority verdict submit': 'authority_verdict_submit',
  'authority verdict list': 'authority_verdict_list',
  'autopilot execute': 'autopilot_execute',
  'autopilot doctor': 'autopilot_doctor',
  'autopilot review submit': 'autopilot_review_submit',
  'autopilot review status': 'autopilot_review_status',
  'decision doc quorum check': 'decision_doc_quorum_check',
  'decision doc proposal': 'decision_doc_proposal',
  'decision doc preview': 'decision_doc_preview',
  'decision doc save': 'decision_doc_save',
  'review escalation status': 'review_escalation_status',
  'review escalation fallback set': 'review_escalation_fallback_set',
  'planner draft': 'planner_draft',
  'planner review': 'planner_review',
  'planner create-story': 'planner_create_story',
  'planner create-job': 'planner_create_job',
  'planner status': 'planner_status',
  'planner answer': 'planner_answer',
  'planner decision submit': 'planner_decision_submit',
  'planner resume': 'planner_resume',
  'planner run': 'planner_run',
  'planner source-manifest': 'planner_source_manifest',
  'story resolve': 'story_resolve',
  'done closure': 'done_closure',
  'conduit status': 'conduit_status',
  'conduit explain': 'conduit_explain',
  'story authority resolve': 'story_authority_resolve',
  'observability snapshot': 'observability_snapshot',
  };
  const twoPart = argv.slice(aliasStart, aliasStart + 2).join(' ');
  const threePart = argv.slice(aliasStart, aliasStart + 3).join(' ');
  const fourPart = argv.slice(aliasStart, aliasStart + 4).join(' ');
  const canonicalAlias = aliasMap[fourPart] || aliasMap[threePart] || aliasMap[twoPart];
  if (canonicalAlias) {
    const consumed = aliasMap[fourPart] ? 4 : aliasMap[threePart] ? 3 : 2;
    argv.splice(0, aliasStart + consumed, canonicalAlias);
    cmd = canonicalAlias;
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

  if (arg === '--help' || arg === '-h') { printToolHelp(tool); return; }

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
        printToolHelp(tool, { stream: process.stderr, includeFooter: false });
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
    printValidationFailure(tool, v.error.issues);
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
      process.stderr.write('⚠ Lattice stale state warnings:\n');
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
        source: process.env.LATTICE_ACTIVITY_SOURCE || 'cli',
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
    if ((process.env.LATTICE_ACTIVITY_SOURCE || '') !== 'codex') return;
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
    await run(() => {
      const fromDraftName = typeof (v.data as any).fromDraft === 'string' ? (v.data as any).fromDraft : '';
      if (fromDraftName && gitReady) {
        preflightFromDraftMetadataBootstrap(root);
      }
      const result = handlers.story_create(v.data);
      if (result.includes('created from draft') && result.includes('(phase=INIT_CHECK)')) {
        const storyId = result.match(/Story\s+([\w-]+)/)?.[1];
        if (!storyId) return result;
        if (!gitReady) {
          return `${result}\n⚠ Current directory is not a Git repository: story was recorded, but the from-draft worktree cannot be created automatically.\nNext: Run git init and make the first commit, then retry lattice story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}'`;
        }
        try {
          const wtResult = handlers.dev_start({ storyId });
          const syncResult = commitFromDraftMetadataAndMergeMain(root, store, storyId, fromDraftName);
          return `${result}\n\n${wtResult}\n\n${syncResult}\n\nNext: Change to the worktree directory above, then run lattice story_advance phase=PLAN to enter PLAN`;
        } catch (e: any) {
          throw new Error(
            `from-draft worktree bootstrap failed for ${storyId}: ${e.message}\n` +
            `Next: After diagnosing, run lattice story_advance --phase=INIT_CHECK again to retry automatically, or manually run lattice dev_start '{"storyId":"${storyId}"}'`,
          );
        }
      }
      if (!result.includes('(INIT)')) return result;
      const storyId = result.match(/Story\s+([\w-]+)/)?.[1];
      if (!storyId) return result;
      if (result.includes('当前目录不是 git 仓库')) return result;
      let fromDraftMetadataSegment = '';
      if (fromDraftName && result.includes('created from draft') && gitReady) {
        fromDraftMetadataSegment = commitFromDraftMetadataOnMain(root, store, storyId, fromDraftName);
      }
      if (!gitReady) {
        return `${result}\n⚠ Current directory is not a Git repository: story was recorded, but the INIT_CHECK/worktree flow cannot run smoothly yet.\nNext: First run git init && git add . && git commit -m "init" at the project root, then run lattice story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}'`;
      }
      const metadataLine = fromDraftMetadataSegment ? `\n${fromDraftMetadataSegment}` : '';
      return `${result}${metadataLine}\nStory is currently in INIT.\nNext steps:\n  1. lattice story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}' create worktree\n  2. cd to the prompted worktree path\n  3. lattice story_advance '{"storyId":"${storyId}","phase":"PLAN"}' enter PLAN (cwd must be the worktree)`;
    });
    return;
  }

  // story_advance phase=INIT_CHECK: after success, automatically call dev_start to create the worktree.
  // B-5246: when phase is already INIT_CHECK (retry scenario), allow dev_start to rerun without throwing
  // "Cannot transition INIT_CHECK->INIT_CHECK". This lets an agent retry after the first worktree creation failure.
  // can call story_advance INIT_CHECK again to retry without using the hidden manual dev_start path.
  if (cmd === 'story_advance' && (v.data as any)?.phase === 'INIT_CHECK') {
    await run(async () => {
      const storyId = (v.data as any).storyId;
      if ((v.data as any).dryRun === true) {
        const story: any = handlers.story_get({ storyId, detail: true });
        const currentPhase = story?.index?.phase || 'unknown';
        return [
          `[DRY-RUN] INIT_CHECK bootstrap plan for ${storyId}`,
          `- current phase: ${currentPhase}`,
          `- would verify init-check gate without mutating story metadata`,
          `- would create/update branch story/${storyId} with scoped story bootstrap files`,
          `- would create worktree under configured worktreeDir`,
          `- no phase, branch, commit, or worktree changes were made`,
        ].join('\n');
      }
      // B-804c CHK-001: make the INIT_CHECK phase write ATOMIC with the worktree
      // bootstrap (Option A — defer the write). The old order persisted
      // phase=INIT_CHECK FIRST and only then ran dev_start; a failed bootstrap
      // left phase=INIT_CHECK with no worktree and no INIT_CHECK->INIT back-edge
      // (unrecoverable). New order: bootstrap FIRST against the still-INIT story,
      // and persist phase=INIT_CHECK ONLY after dev_start succeeds. On bootstrap
      // failure we do NOT advance, so the story stays at its prior phase (INIT).
      //
      // Detect the current phase to choose the branch:
      //   - currentPhase === INIT_CHECK (B-5246 legacy victim retry): the phase is
      //     ALREADY persisted, so we never re-advance (no INIT_CHECK->INIT_CHECK);
      //     just (re)run dev_start to bootstrap the missing worktree.
      //   - currentPhase === INIT (the normal case): run dev_start against the
      //     still-INIT story; only advance the phase AFTER bootstrap succeeds.
      // story_get returns {checklist, review} by default; phase requires
      // detail:true to appear at result.index.phase.
      let alreadyInitCheck = false;
      try {
        const story: any = handlers.story_get({ storyId, detail: true });
        alreadyInitCheck = story?.index?.phase === 'INIT_CHECK';
      } catch {
        // story_get failed: we cannot prove the phase is INIT_CHECK, so
        // alreadyInitCheck stays false and the normal path (guard pre-check +
        // bootstrap + advance) runs — the safe behavior.
      }

      // B-804c CHK-001: validate the FULL INIT→INIT_CHECK transition guard BEFORE
      // bootstrapping. Deferring the phase write must not also defer (or weaken)
      // the gate: dev_start only enforces the scope-anti-expansion freeze gate,
      // which is a STRICT SUBSET of the INIT_CHECK transition gate (it also
      // requires a valid init-check.json — the lattice-review-story-init evidence).
      // If we bootstrapped on dev_start's subset gate alone, a story with passing
      // scope-freeze but missing init-check could create a worktree (and the exact
      // failure diagnostic would regress from [missing_init_check] to a scope
      // message). getGuardFailureReason returns null for a non-INIT story, so this
      // is a no-op for the already-INIT_CHECK retry path. The gate runs whenever
      // the story is not already INIT_CHECK — including the case where story_get
      // threw and alreadyInitCheck stayed false (closing B-804c:F-002): without
      // this pre-check that path ran dev_start FIRST with no gate, so a succeeding
      // bootstrap followed by a story_advance that failed its own gate could leave
      // a worktree on disk while the phase stayed INIT — a partial bootstrap.
      // Running the full INIT_CHECK transition guard here means dev_start never
      // bootstraps ahead of the INIT_CHECK gate, so there is no path that creates a
      // worktree without the phase advancing.
      if (!alreadyInitCheck) {
        const guardFailure = getGuardFailureReason(storyId, store, 'INIT_CHECK', root);
        if (guardFailure) {
          throw new Error(
            `${guardFailure}\n\n` +
            `INIT_CHECK aborted: Story ${storyId} stays at INIT (phase not advanced; no worktree created).`,
          );
        }
      }

      // Gate passed. Bootstrap FIRST (against the still-INIT story for the normal
      // case, or the already-INIT_CHECK story for the retry case). If this throws,
      // the phase is NOT advanced and the story stays put — no partial advance. We
      // RE-THROW the abort (rather than returning a warning string) so the command
      // exits non-zero: a failed bootstrap is a real failure, and the old exit-0
      // "advanced + ⚠ warning" output is exactly what masked this bug.
      let wtResult: string;
      try {
        wtResult = handlers.dev_start({ storyId });
      } catch (e: any) {
        throw new Error(
          `INIT_CHECK aborted: ${e.message}\n` +
          `Story ${storyId} stays at ${alreadyInitCheck ? 'INIT_CHECK' : 'INIT'} (phase not advanced; no worktree created).\n` +
          `Next: fix the cause, then re-run lattice story_advance --phase=INIT_CHECK, ` +
          `or run lattice dev_start '{"storyId":"${storyId}"}' to bootstrap directly.`,
        );
      }

      // Bootstrap succeeded. Persist phase=INIT_CHECK now (only when the story is
      // not already INIT_CHECK; an already-INIT_CHECK retry must never re-advance).
      // There is no separate fallback branch: if story_get failed above,
      // alreadyInitCheck is false and we take the normal advance path here.
      let advanceResult: string;
      if (alreadyInitCheck) {
        advanceResult = `Story ${storyId} is already in INIT_CHECK; bootstrapped worktree`;
      } else {
        // Normal case: persist the phase via the real story_advance handler,
        // which re-runs the same guard.
        advanceResult = await handlers.story_advance(v.data);
      }

      // B-f60c CHK-002: close F-008. dev_start leaves an uncommitted
      // story-metadata mirror in the main checkout that blocks the DONE
      // `git merge story/<id>`. Commit it on the base branch (mirroring the
      // metadata-commit part of the from-draft path) so DONE has nothing
      // uncommitted to collide with. Final order (B-804c): dev_start (success)
      // -> story_advance (persist phase) -> commitInitCheckMetadata.
      let syncResult = '';
      if (gitReady) {
        syncResult = commitInitCheckMetadataAndMergeMain(root, store, storyId);
      }
      const syncSegment = syncResult ? `\n\n${syncResult}` : '';
      return `${advanceResult}\n\n${wtResult}${syncSegment}\n\nNext: Change to the worktree directory above, then run lattice story_advance phase=PLAN to enter PLAN`;
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
      const r = await handler(v.data);
      if (r && typeof r === 'object' && (r.status === 'refused' || r.status === 'fail')) {
        // Print structured result first so the user sees the refused/fail diagnosis,
        // then throw a one-line error message that runCli renders on stderr.
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        const msg = r.status === 'refused'
          ? (r.refused?.reason || 'recover_evidence refused')
          : 'recover_evidence: validate failed after refresh; inspect validateTranscript for details';
        throw new Error(msg);
      }
      return r;
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
