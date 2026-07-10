export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'session_brief',
  'next',
  'done_closure',
  'milestone_status',
  'milestone_closeout',
  'global_control_status',
  'runtime_closure_status',
  'admissibility_waterline',
  'queue_governance_status',
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
  'conduit_status',
  'conduit_explain',
  'story_export',
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
  'dispatch_policy_get',
  'dispatch_policy_check',
  'dispatch_watch',
  'autopilot_policy_get',
  'autopilot_policy_check',
  'autopilot_status',
  'autopilot_watch',
  'autopilot_review',
  'learning_validate',
  'learning_effectiveness',
  'source_lineage_audit',
  'playbook_seed_observe',
  'playbook_runtime_consumption_verify',
]);

/**
 * F-028: a non-empty --out makes usage_sweep write a JSON report file inside the
 * project root, so it is NOT read-only for that invocation. Normalized exactly as
 * the handler and the ownership gate do (typeof string + trim) so a blank /
 * whitespace-only --out is NOT a write.
 */
function usageSweepWritesReport(args: Record<string, unknown>): boolean {
  const out = args.out;
  return typeof out === 'string' && out.trim().length > 0;
}

/**
 * F-028: effective read-only classification for the CLI activity / hook layer —
 * the single predicate cli-engine consults to decide whether a command runs the
 * pre/post command hooks and writes an activity-log entry. Static
 * READ_ONLY_COMMANDS members are always read-only. usage_sweep is a read-only
 * diagnostic UNLESS an explicit non-empty --out makes it write a report file, in
 * which case it is a mutating command (runs hooks + records activity). This
 * mirrors resolveEffectiveOwnershipClass's F-014 --out boundary in
 * ownership-gate.ts: the SAME --out that dynamically escalates the ownership
 * class also flips the activity/hook classification, so a plain (no --out)
 * usage_sweep runs no hooks and writes no activity log, while --out is treated as
 * a write on both surfaces. All other commands are classified exactly as the
 * static set (arg-independent), so non-usage_sweep behaviour is unchanged.
 */
export function isReadOnlyCommand(cmdName: string, args: Record<string, unknown> = {}): boolean {
  if (READ_ONLY_COMMANDS.has(cmdName)) return true;
  if (cmdName === 'usage_sweep') return !usageSweepWritesReport(args);
  return false;
}

export function resolveActivitySource(): string {
  return process.env.LATTICE_ACTIVITY_SOURCE || 'cli';
}

export function isCodexActivitySource(): boolean {
  return (process.env.LATTICE_ACTIVITY_SOURCE || '') === 'codex';
}

export function inferCodexEntrypoint(): string {
  if (process.env.LATTICE_CODEX_ENTRYPOINT) return process.env.LATTICE_CODEX_ENTRYPOINT;
  const invoked = process.argv[1] || '';
  if (invoked.includes('lattice-codex')) return 'local-wrapper';
  if (process.env.LATTICE_ACTIVITY_SOURCE === 'codex') return 'global-fallback';
  return 'cli';
}

export function shouldWriteActivityLog(cmdName: string, args: Record<string, unknown>): boolean {
  // F-028: key the activity-log decision on the arg-aware read-only predicate, so
  // a plain usage_sweep writes no activity row (read-only) while a --out sweep
  // (a write) is recorded like any other mutating command.
  if (isReadOnlyCommand(cmdName, args)) {
    return process.env.LATTICE_ACTIVITY_RECORD_READONLY === '1';
  }
  if (args.dryRun === true) return false;
  return true;
}
