import { readBrandEnv } from '../core/brand-env.js';
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
  'graph',
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
  //           when PROOF_OR_STOP_ACTIVITY_RECORD_READONLY === '1'. That is not a test
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
  //      lands in .proof-or-stop/activity.jsonl, which core/runtime-artifact-registry.ts
  //      registers as the `runtime-activity-log` artifact. And on the throwing
  //      path the CLI catch block passes e.message into writeLog, which stores it
  //      in the row's `error` field — so under either bypass the full tagged
  //      rejection verdict IS recorded there.
  //   C. THE OWNER-SESSION TOKEN STORE. Before it appends that row, writeLog
  //      resolves session identity through getSessionIdentity
  //      (core/owner-session.ts). Under the generated-token adapter mode that
  //      path reaches readOrCreateOwnerSessionToken, which creates or refreshes a
  //      file under .proof-or-stop/runtime/owner-session-tokens/ — registered
  //      SEPARATELY in core/runtime-artifact-registry.ts as the
  //      `owner-session-token-store` artifact, so it is a second .proof-or-stop write
  //      the activity path can cause.
  //   D. THE HEALTH LOG. When activity or hook persistence FAILS, reportHealthIssue
  //      (core/health.ts) appends one JSONL row to the health log — ~/.proof-or-stop/health.jsonl
  //      by default, which is outside the project tree. THE DEFAULT IS THE ONLY
  //      THING THAT IS OUTSIDE IT: getHealthPath in core/health.ts returns
  //      PROOF_OR_STOP_HEALTH_PATH VERBATIM when set, with no project-tree containment
  //      check and no suffix or shape constraint, and reportHealthIssue then
  //      mkdirs the parent and appends there. So an override may name a path
  //      INSIDE .proof-or-stop/story/actives/<id>/ — including an existing gate or
  //      evidence artifact — and a matching onError hook that exits non-zero is
  //      one route that reaches reportHealthIssue. The remedy is not a claim
  //      here: describing this surface does not constrain it, and adding a
  //      containment check would be a behaviour change belonging to its own
  //      story.
  // What holds without qualification is the narrower contract in
  // core/command-policy.ts. THIS IS THE CANONICAL SCOPE SENTENCE, and it is
  // repeated word for word everywhere the guarantee is stated:
  //   Scoped to the command handler itself and the CLI story-evidence writers,
  //   it writes no RED-evidence record, chain record or story/evidence artifact,
  //   emits no process event, changes no gate verdict, and runs no preCommand or
  //   postCommand hook.
  // THOSE COPIES ARE HAND-MAINTAINED, so the set is DECLARED here: this file;
  // cli/command-catalog.ts (command description); core/command-policy.ts (policy
  // reason); core/config.ts; core/process-fact-levels.ts (level rationale);
  // core/process-fact-registry.ts; registry.ts; handlers/red-evidence.ts (handler
  // docblock, ADMISSIBLE report footer, rejection report footer, and the
  // COMMITTED-target-bindings read-failure error thrown from
  // readCommittedBindingForTarget); tasks/red-evidence-envelope-smoke.ts;
  // tests/red/red-w2d-command-readonly.mjs (file header, ownershipClass assertion
  // message) — fourteen statements in ten files when the set was last counted.
  // A SINGLE EXPORTED CONSTANT WAS CONSIDERED AND NOT TAKEN: seven of the
  // fourteen are comments, which no constant can deduplicate; three are literals
  // in registration tables whose readers need the guarantee legible at the entry
  // rather than behind an import; the remaining four are operator- or
  // reviewer-facing report and assertion text. Every copy in the list carries a
  // pointer back to this note, and tests/red/red-w2d-command-readonly.mjs pins
  // the CLASSIFICATION — not the prose — in a committed assertion.
  // WHAT THE DECLARED SET IS WORTH, WITHOUT FLATTERY: less than the paragraph
  // above reads like. It is a CONVENTION MAINTAINED BY HAND, and declaring it
  // has not prevented drift. Three separate review rounds of B-9ff1 found
  // guarantee-bearing text that had already drifted — blanket "runs no hook"
  // claims, an ordering claim that did not match the cli-engine.ts catch block,
  // and sites restating the guarantee in their own words — and the round
  // IMMEDIATELY AFTER this set was first declared found three more: a stale
  // ordering clause in the command description, a "configured" onError claim
  // that had dropped the MATCHING condition, and a rejection footer that did not
  // carry the pointer this note says every copy carries; that last round also
  // surfaced the fourteenth statement above, which the set had not listed at
  // all. So declaring the set converts drift from invisible into FINDABLE BY
  // READING one comment. It does not make drift DETECTABLE: nothing re-checks
  // these statements when one of them is edited, the count and roles above
  // describe the LAST audit rather than a live index, and a NEW site that
  // restates the guarantee in ITS OWN words is still caught by nothing.
  // Mechanical enforcement — a scanner over the wording, not a shared constant —
  // is not built here and belongs to its own change.
  // Read "the CLI story-evidence writers" as exactly what the name says: the
  // writers that put story records, chain records, evidence artifacts and story
  // process events under the story directory. That subject is a NOMINAL PROSE
  // CATEGORY — a named set of writers — and NOT a destination-decidable one:
  // you cannot settle membership by looking at where the bytes land. A-D fall
  // outside it because of WHAT WRITES THEM, not because of WHERE THEY WRITE:
  // the onError hook is arbitrary shell that the CLI only invokes, and the
  // activity log, the owner-session token store and the health log are written
  // by runtime writers, the first two registered as RUNTIME artifacts in
  // core/runtime-artifact-registry.ts. The destination argument is what breaks,
  // and D is where it breaks: the health log is outside the project tree ONLY
  // under its default path, PROOF_OR_STOP_HEALTH_PATH is unconstrained, and under
  // such an override the built-in health writer can land a row on a story
  // artifact. That override does not make the health writer a story-evidence
  // writer, so the canonical sentence still holds as stated; it does mean the
  // scope must be read as WHO WRITES, and that no reader should infer from it
  // that nothing outside the named writers can ever touch the story directory.
  // Nothing outside that scope is covered, and this note is the authoritative
  // one: A-D are the surfaces known when it was written and are not a proof of
  // exhaustiveness.
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
  'proof_or_stop_config_doctor',
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
  'review_run_list',
  'review_incremental_context',
  'validation_plan',
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
  return readBrandEnv('ACTIVITY_SOURCE') || 'cli';
}

export function isCodexActivitySource(): boolean {
  return (readBrandEnv('ACTIVITY_SOURCE') || '') === 'codex';
}

export function inferCodexEntrypoint(): string {
  const explicitEntrypoint = readBrandEnv('CODEX_ENTRYPOINT');
  if (explicitEntrypoint) return explicitEntrypoint;
  const invoked = process.argv[1] || '';
  if (invoked.includes('proof-or-stop-codex')) return 'local-wrapper';
  if (readBrandEnv('ACTIVITY_SOURCE') === 'codex') return 'global-fallback';
  return 'cli';
}

export function shouldWriteActivityLog(cmdName: string, args: Record<string, unknown>): boolean {
  // F-028: key the activity-log decision on the arg-aware read-only predicate, so
  // a plain usage_sweep writes no activity row (read-only) while a --out sweep
  // (a write) is recorded like any other mutating command.
  if (isReadOnlyCommand(cmdName, args)) {
    return readBrandEnv('ACTIVITY_RECORD_READONLY') === '1';
  }
  if (args.dryRun === true) return false;
  return true;
}
