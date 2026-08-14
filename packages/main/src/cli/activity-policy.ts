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
  'frozen_claim_drift_check',
  'acceptance_matrix',
  'acceptance_topology_check',
  'acceptance_basis',
  'pre_review_check_read',
  'acceptance_rollout_report_read',
  'acceptance_rollout_check',
  'topology_critic_receipt_check',
  // W2d (B-9ff1): read-only RED assertion-envelope admissibility pre-flight.
  // Membership here settles TWO of the CLI's own write surfaces outright, because
  // both are gated on isReadOnlyCommand alone with no second term: the preCommand
  // and postCommand hooks in cli-engine.ts, and the class-wide early return in
  // writeCodexProcessEvent. It settles NONE of the surfaces below, and they are
  // stated plainly because the guarantee is easy to over-read. Treat the list as
  // the surfaces known when this was written, not as a proof of exhaustiveness.
  //   A. THE onError HOOK STILL RUNS. Its call site in cli-engine.ts carries no
  //      read-only predicate at all: the `runHooks('onError', ...)` call there is
  //      UNCONDITIONAL. `config0?.hooks?.onError` guards only the informational
  //      stderr notice printed just above it, not the call. The filtering lives
  //      inside runHooks in core/hooks.ts, which returns early on absent config,
  //      on an unknown stage, and when resolveHookCommands matches no exact or
  //      wildcard key or yields no commands — so a CONFIGURED and MATCHING
  //      onError hook runs whenever the command throws. This command throws its
  //      rendered rejection report BY DESIGN, so that is its primary failure
  //      route, not an edge case. And such a hook is arbitrary: spawnHook in
  //      core/hooks.ts executes it via /bin/sh -c in the project root, so it can
  //      write RED or story evidence, append a process event, or invoke a
  //      gate-mutating command. Nothing in this file constrains what it does.
  //   B. THE ACTIVITY LOG. Membership is necessary but not sufficient there, and
  //      each of the two remaining conditions has a real operating mode that
  //      breaks it:
  //        1. shouldWriteActivityLog (below) returns true for a read-only command
  //           when LATTICE_ACTIVITY_RECORD_READONLY === '1'. That is not a test
  //           knob: it is baked into GLOBAL_CODEX_FALLBACK_COMMAND
  //           (core/codex-adapter-checks.ts) and into the generated Codex wrapper
  //           (src/init-assets.ts), so under the documented Codex heartbeat mode
  //           read-only rows ARE recorded on purpose.
  //        2. Both writeLog call sites in cli-engine.ts read
  //           `shouldWriteActivityLog(cmd, parsed) || staleWarnings.length > 0`.
  //           While the story carries an uncooled stale warning
  //           (STALE_WARNING_COOLDOWN_MS, 30 minutes, in core/stale-detector.ts)
  //           that OR appends one generic session row for ANY command, read-only
  //           included.
  //      That row is not outside this repository's own artifact taxonomy: it
  //      lands in .lattice/activity.jsonl, which core/runtime-artifact-registry.ts
  //      registers as the `runtime-activity-log` artifact. And on the throwing
  //      path the CLI catch block passes e.message into writeLog, which stores it
  //      in the row's `error` field — so under either bypass the full tagged
  //      rejection verdict IS recorded there.
  //   C. THE OWNER-SESSION TOKEN STORE. Before it appends that row, writeLog
  //      resolves session identity through getSessionIdentity
  //      (core/owner-session.ts). Under the generated-token adapter mode that
  //      path reaches readOrCreateOwnerSessionToken, which creates or refreshes a
  //      file under .lattice/runtime/owner-session-tokens/ — registered
  //      SEPARATELY in core/runtime-artifact-registry.ts as the
  //      `owner-session-token-store` artifact, so it is a second .lattice write
  //      the activity path can cause.
  //   D. THE HEALTH LOG. When activity or hook persistence FAILS, reportHealthIssue
  //      (core/health.ts) appends one JSONL row to the health log — ~/.lattice/health.jsonl
  //      by default, overridable via LATTICE_HEALTH_PATH — outside the project tree.
  // What holds without qualification is the narrower contract in
  // core/command-policy.ts, and it is scoped to the code paths this command owns:
  // THE HANDLER AND THE BUILT-IN CLI PERSISTENCE PATHS write no RED-evidence
  // record, no chain record and no story or evidence artifact under the story
  // directory, emit no process event, change no gate verdict, and run no
  // preCommand or postCommand hook. It says nothing about a configured onError
  // hook, which is arbitrary shell and is bounded by the project config alone.
  'red_evidence_envelope_check',
  'finding_list',
  'bug_list',
  'test_list',
  'aux_doc_list',
  'capability_list',
  'capability_probe',
  'prompt_measurement_report',
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
