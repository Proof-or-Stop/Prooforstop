
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { WorkflowProfile } from './types.js';
import { resolveAuditConfig as _resolveAuditConfig, type AuditConfig } from './audit-config.js';
import { getCommandLifecyclePolicy, getCommandPolicyEntries, policyAllowedPhaseLabels } from './command-policy.js';
import { LATTICE_STORY_DIR } from './lattice-paths.js';

/**
 * audit-config 扩展点（B-9bd9 CHK-004）：
 *   - profile 默认值由 `resolveAuditConfig` 接管（light=10, balanced=5, strict=3）
 *   - 项目级覆盖文件为 `<projectRoot>/.lattice/audit-config.json`
 *   - 详见 CLAUDE.md「框架自省 audit 配置」
 *
 * 这里以 re-export 的形式挂到 config 入口，**不**改动现有 `loadConfig` /
 * `isCommandAllowed` 等 profile 消费者的行为；没有用到 audit 的调用方无感知。
 */
export { _resolveAuditConfig as resolveAuditConfig };
export type { AuditConfig };

export interface LatticeFlowConfig {
  defaults: Record<string, Record<string, unknown>>;
  patterns: Array<{ field: string; regex: string }>;
}

export type DoneRequiredBuildProof = 'packages-main-build';

export interface DoneRequiredCommandConfig {
  label?: string;
  command: string;
  args?: string[];
  shell?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Explicitly require a preceding same-material proof before this command can satisfy DONE. */
  requiresBuildProof?: DoneRequiredBuildProof;
  /** Explicitly mark this command as providing a build proof. */
  providesBuildProof?: DoneRequiredBuildProof;
  /** Legacy/provider alias for providesBuildProof. */
  proof?: DoneRequiredBuildProof;
}

export interface ProofAdmissibilityConfig {
  mode?: 'warn' | 'enforce';
  enforcedConsumers?: Array<'DONE_REQUIRED' | 'REVIEW' | 'HANDOFF' | 'AUTHORITY_GATE_DECISION'>;
  highRiskConsumers?: Array<'DONE_REQUIRED' | 'REVIEW' | 'HANDOFF' | 'AUTHORITY_GATE_DECISION'>;
}

export interface ReproFirstPreflightConfig {
  mode?: 'off' | 'warn' | 'enforce';
}

export interface ProofStoryConfig {
  /** PLAN/INIT_CHECK/REVIEW rollback DEV admission ProofStory gate. Defaults to observe. */
  devGateMode?: 'observe' | 'warn' | 'enforce';
  /** REVIEW completeness diagnostic mode. Defaults to observe. */
  reviewGateMode?: 'observe' | 'warn' | 'enforce';
  /** DONE intent-equivalence diagnostic mode. Defaults to observe. */
  doneGateMode?: 'observe' | 'warn' | 'enforce';
}

export interface LifecycleControlConfig {
  runtimeEnforcement?: 'unavailable' | 'warn' | 'enforce';
}

export interface LatticeConfig {
  /**
   * Marks this checkout as a read-only legacy/evidence root. Mutating CLI
   * commands are blocked before handler dispatch and should be rerun from
   * canonicalRoot.
   */
  retiredRoot?: boolean;
  /** Canonical active project root for a retiredRoot checkout. Required when retiredRoot is true. */
  canonicalRoot?: string;
  scanRoot: string;
  /** 源码子目录（相对 scanRoot，对应 tsconfig rootDir，默认和 scanRoot 相同） */
  rootDir?: string;
  /** 编译输出目录（相对项目根，TS 项目设为 dist 所在路径） */
  outDir?: string;
  testsDir: string;
  fixturesDir: string;
  storyDir: string;
  requirementsDir: string;
  storyPrefix: string;
  flows: LatticeFlowConfig;
  wrappersDir?: string;
  /** 项目语言：js（默认）或 python */
  language?: 'js' | 'python';
  /** CLI 测试配置 */
  cli?: {
    command: string;
  };
  /** 项目级验证命令；没有 validate.ts/js 时由 lattice validate 使用 */
  validate?: {
    command?: string;
    commands?: Array<string | {
      label?: string;
      command: string;
      args?: string[];
      shell?: boolean;
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      optional?: boolean;
      focus?: string[] | string;
    }>;
  };
  /**
   * Opt-in DONE-required validation commands. Missing config is advisory only;
   * malformed opted-in config is consumed by the DONE gate as fail-closed.
   */
  doneRequiredCommands?: Array<string | DoneRequiredCommandConfig>;
  validationProfiles?: {
    done?: Array<string | DoneRequiredCommandConfig> | {
      commands?: Array<string | DoneRequiredCommandConfig>;
    };
  };
  proofAdmissibility?: ProofAdmissibilityConfig;
  /**
   * Repro-first STORY_INTAKE preflight. Default warn keeps story intake
   * available while surfacing code-changing stories that lack accepted repro
   * binding; enforce turns the same diagnostic into a lifecycle block.
   */
  reproFirstPreflight?: ReproFirstPreflightConfig;
  proofStory?: ProofStoryConfig;
  lifecycleControl?: LifecycleControlConfig;
  /** 浏览器测试配置 */
  browser?: {
    /** dev server 启动命令（如 "npx vite"） */
    devCommand: string;
    /** WS bridge 端口（默认 9876） */
    wsPort?: number;
  };
  /** trace snapshot 最大保留份数（默认 5） */
  maxTraceSnapshots?: number;
  /** 各阶段可用命令白名单（key=阶段名，value=命令名数组，支持通配符 *） */
  phaseTools?: Record<string, string[]>;
  /** Story worktree 根目录（相对 git repo root，默认 .worktrees） */
  worktreeDir?: string;
  /** Explicit git-backed material root for wrapper-root projects (relative to metadata root by default). */
  gitRoot?: string;
  /** doc_list 扫描的文档目录（相对项目根，默认 ['docs', 'requirements']） */
  docDirs?: string[];
  /** Workflow profile：治理强度配置 */
  workflow?: {
    profile?: WorkflowProfile;
  };
  /** stale-detector 阈值（分钟，缺失走 DEFAULT_STALE_THRESHOLDS） */
  staleThresholds?: {
    /** phase 没 advance 多久算卡死（默认 30） */
    phaseStale?: number;
    /** checklist item 卡 in_progress 多久算遗忘（默认 30） */
    itemStale?: number;
    /** 距离上次任意 lattice 命令多久算 idle（默认 60） */
    idleLattice?: number;
    /** open bug 多久没修算超期（默认 1440=24h） */
    bugStale?: number;
  };
  /**
   * Lifecycle hooks — spawn shell commands at Proofbound command lifecycle points.
   * 每个事件下用 commandName 或 "*" 通配匹配，value 是 shell 命令数组。
   * onPhaseChange 的 key 用 "FROM->TO" 格式（或 "*"）。
   *
   * 失败/超时不阻塞主命令，详见 core/hooks.ts 和 docs/guide-hooks.md。
   */
  hooks?: {
    preCommand?: Record<string, string[]>;
    postCommand?: Record<string, string[]>;
    onError?: Record<string, string[]>;
    onPhaseChange?: Record<string, string[]>;
  };
}

/** 默认各阶段可用命令白名单 */
export const DEFAULT_PHASE_TOOLS: Record<string, string[]> = {
  '*': [
    'session_brief', // read-only recovery entrypoint; must work in every phase
    'next',          // read-only single next action, shares session_brief authority rules
    'done_closure',  // read-only DONE closure projection; local readiness only
    'lifecycle_check', // read-only proof-or-stop readiness projection; no command execution or evidence writes
    'global_control_status', 'runtime_closure_status', 'admissibility_waterline', 'queue_governance_status', // B-eb18: read-only global lifecycle control plane projections
    'queue_exception_set', // B-eb18: guarded project-level queue exception writer; preserve-only, does not grant readiness
    'plan_skeleton', // read-only PLAN skeleton preview; --write delegates only to understanding_set/checklist_add
    'init_preflight', // B-62c8: read-only INIT→INIT_CHECK prerequisite surveyor; lists ALL prerequisites at once (vs story_advance fail-fast) + echoes the authoritative scope gate verdict; no command execution or evidence writes
    'evidence_plan', // B-09e7 (P3): read-only verification-evidence DRY planner (missing/rerun/refresh-only/fresh); no command execution or evidence writes
    'reviewer_batch', // P7: read-only reviewer-launcher PLAN producer; per-lane current-pass/scope-changed/no-receipt/blocking classification + Agent(...) launch instruction (orchestrator subagent-spawn form, not a dispatch CLI command); launches no reviewer, runs no review_run_start, writes no evidence
    'evidence_refresh', // B-4896 (P4): opt-in one-pass refresh-only orchestrator; dry default read-only, --apply re-stamps once via verification_evidence_refresh_stale; never runs a command
    'live_smoke_transcript', // B-9b5e (P5): live-smoke transcript producer; read-only status default, --capture runs ONLY the provided command, --write persists the artifact (ownership-gated); independent opt-ins
    'delivery_context_pack', // P6: delivery-review context PRODUCER (not a signer); read-only pack default, --write persists the pack artifact (ownership-gated); consumes the V1 deliveryCheckRef, never writes delivery-check.json or accepts a waiver
    'lifecycle_orchestrate', // P8 (CAPSTONE): read-only top-level lifecycle orchestration; composes the prior read-only layers (V1 + P2-P7) into one phase-aware view via their read-only default path, consolidates blockers/next-actions, emits the next story_advance as a PRINTED string (never executed); runs no command, writes no evidence, advances no phase
    'done_prepare',  // pre-DONE readiness assistant; handler fail-closes outside TEST before mutation
    'done_required_validate', // opt-in DONE-required validation evidence writer; advisory when no policy exists
    'story_get', 'story_list', 'story_reconcile', 'story_discard',
    'aux_*', // 全部辅助工具：scan/detail/coverage/locate/sync/trace/diagnose/doc_list
    'checklist_get',
    'truth_*', 'gap_*', 'convergence_check',
    'story_advance', // 任何阶段都可以推进（cwd 门禁负责保护）
    'status',        // 全局：项目全貌（story 进度 + 代码验证）
    'doctor',        // 全局：health 巡检，任何阶段都可以查
    'done_recover',  // 全局：显式恢复 partial-DONE（先检查 main clean / merge-tree）
    'check',         // 全局：Proofbound 管理资产/模板漂移检查；--apply/--upgrade 显式同步安全项
    'test_list',     // 全局：读取测试证据快照，TEST/DEV 排障都需要
    'bug_list',      // 全局：读取 bug 状态，便于复核 dashboard
    'finding_list',  // 全局：只读查看 reviewer 结果，避免阶段 UX 陷阱
    'audit',         // 全局：B-9bd9 框架自省 audit（advisory，任何阶段都可以跑）
    'decision_doc_quorum_check', // B-2c0c: read-only decision-doc quorum diagnostic; DONE uses review_escalation_status
    'decision_doc_preview', // read-only decision-doc proposal render; writes no files or metadata
    'review_escalation_status', // B-59a6: read-only view of actual DONE review escalation requirement
    'verify_codex',  // Codex adapter 资产/heartbeat 硬证据验证（优先通过本地 wrapper 调用）
    'summary_get',   // 全局：读取 summary，任何阶段都可以查
    'grill_get',     // 全局：读取 PLAN grill planning context；不会写证据
    'summary_set',   // 全局：DONE 前强制落总结，lattice short-path story 也需要
    'verification_evidence_add', 'verification_evidence_batch_add', 'verification_evidence_refresh_stale', // verification evidence is metadata, allowed across phases for reviewer/test handoff
    'verification_context_pack_create', 'verification_context_pack_expand', // read-only verifier context packets
    'recover_evidence', // B-a2f1 CHK-003: single-shot stale-evidence recovery, safe in any phase (refuses on non-metadata dirt)
    'artifact_declare', // B-cf60: per-story declared product artifact registration, safe in any phase
    'repro_*', 'spike_record', 'spike_review_set', 'red_green_relation_*', 'regression_matrix_review_set', 'story_create_from_repro', // B-0aa1: candidate-only repro-first intake commands; evidence-candidate scope only, never DONE or release proof
    'capsule_*',   // B-42c0: story handoff projection commands; evidence remains authoritative elsewhere
    'scope_contract_show', 'scope_contract_check', // B-be27: read/check scope contract; mutating commands are phase-scoped below
    'scope_diff_pack', // B-6bfd CHK-002: read-only mechanical diff context pack, useful for verifier context in any phase
    'original_intent_snapshot_get', 'milestone_ledger_get', 'slice_plan_get', 'parent_ledger_rollup_get', 'proofstory_contract_get',
    'intent_collision_get', 'scope_shrinkage_decision_get', 'red_evidence_get', 'spike_get',
    'intent_coverage_check', 'proofstory_gate_check', 'done_intent_equivalence_check', 'proofstory_review_completeness_check', // ProofStory read-only diagnostics; enforce mode exits nonzero but writes no evidence
    'parent_roadmap_status', 'parent_roadmap_evaluate', // Parent-roadmap totality diagnostics; read-only and no server-backed completion semantics
    'guard_session_status', // B-6bfd CHK-004: read-only guard session projection
    'guard_session_check', // B-6bfd CHK-004: NOT read-only — refreshes/writes guard-session.json + appends a guard_session_check process event, so it is an owner-gated storyScopedMutating write (see command-policy.ts); listed here because the check itself is allowed in every phase, while guard_session_start is phase-scoped below
    'prewrite_guard_check', // B-6bfd CHK-005: read-only pre-write scope gate for Claude Code PreToolUse hooks; called by the hook in any phase, writes nothing
    'plan_get',
    'workflow_*',    // 全局：profile 查看/设置/解释，任何阶段都可以
    'background_*',  // B-45ed CHK-007: background 是元数据，任何阶段可读写
    'dispatch',      // B-9d95 CHK-004: 统一派发入口，全阶段开放（INIT_CHECK 起）
    'reviewer_list', // B-fdcf CHK-001: 全阶段可查询 opt-in reviewer 名单
    'review_incremental_context', // B-f675 CHK-002: read-only incremental review context, any phase
    'story_draft',   // B-9975: draft 操作全阶段可用（不分配 story id）
    'story_draft_list',
    'story_draft_discard',
    'draft_check_set',      // B-9975 CHK-002: draft check 全阶段可用
    'draft_issue_resolve',
    'planner_*', 'story_resolve', // Natural-language planner and plannedStep context resolution surfaces
    'capability_list', // B-f26a M2: read-only host capability diagnostics for cross-host degradation
    'capability_probe', // B-cd31 CHK-002: productized single-host capability diagnostics
    'agent_prompt', // B-097f CHK-002: read-only host-neutral agent prompt endpoint; resolves role body from package registry in any phase
    'baseline_run', 'baseline_suite', 'baseline_suite_report', 'capability_claim_evaluate', 'capability_claim_formal_evaluate', // B-92e2/B-ce79: baseline artifact/report commands; formal claim still does not mutate lifecycle or release readiness
    'memory_benchmark_*', // B-d4dd/B-2a63: virtual benchmark + real-data export harnesses are read-only in all phases
    'host_*', // Proofbound CLI 0.3.6: host list/probe/install guidance; dry-run/read-only diagnostics only
    'host_runtime_*', // B-106b/B-d674: dispatch runtime readiness probes for fake/codex/claude-code/antigravity
    'lattice_config_doctor', // Proofbound CLI 0.3.6: CLI-first migration/config status; no Mac App dependency
    'lattice_config_repair', // B-526c: explicit confirmed gitRoot repair; command policy enforces mutating ownership semantics
    'codex_doctor',          // Codex adapter diagnostics (read-only); does not write process-event evidence
    'rollout_check', // Proofbound CLI 0.3.6: read-only cross-project rollout diagnostics
    'baseline_run', 'baseline_suite', 'baseline_suite_report', // Proofbound baseline execution and suite reporting; writes baseline artifacts only
    'conduit_*', // Proofbound CLI 0.3.6: conduit status/explain; no runner provisioning or authority mutation
    'story_export', // B-cd31 CHK-003: Canonical Story v0 export surface
    'observability_snapshot', // B-381e: read-only host-neutral observability adapter dry-run
    'handoff_create', 'handoff_inspect', // B-cd31 CHK-004: Proofbound cross-host handoff pack surface
    'handoff_accept', 'handoff_resume', // B-cd31 CHK-005: handoff accept/resume projections without authority mutation
    'handoff_receipt_submit', 'handoff_worktree_create', // B-aa98: overflow receipt/worktree diagnostic projections
    'dispatch_plan', 'dispatch_prepare', 'dispatch_run', 'overflow_auto', // B-106b: supervised dispatch runtime surfaces
    'dispatch_collect', 'dispatch_receipt_create', 'dispatch_status', 'dispatch_list', // B-106b: persisted dispatch lifecycle + receipt helpers
    'dispatch_resume', 'dispatch_cancel', 'dispatch_review', 'dispatch_merge_plan', // B-106b: lifecycle control + manual review/merge guidance
    'dispatch_policy_create', 'dispatch_policy_get', 'dispatch_policy_check', 'dispatch_auto', 'dispatch_watch', // B-a5c2: policy-authorized dispatch controls + read-only watch
    'autopilot_*', // Proofbound unattended/autopilot surfaces declare allowedPhases:all in command-policy; phaseTools must match
    'quorum_submit', // local voluntary 3x2 floor helper; handler refuses without current reviewer pass evidence
    'evidence_manifest', 'evidence_inspect', // B-cd31 CHK-006: portable evidence freshness diagnostics
    'parallel_wave_create', 'parallel_wave_inspect', 'parallel_plan', // B-29b6: read-only Proofbound Parallel Wave planning surfaces; no authority mutation
    'parallel_dispatch', 'parallel_status', 'parallel_merge_queue', 'parallel_report', // B-e70f: read-only Parallel Dispatch projections; no spawning or authority mutation
    'review_loop_status', 'review_loop_policy_show', // B-7a34: read-only review loop projections; REVIEW-only mutators are phase-scoped below
    'dev_memory_*',  // B-1148: dev_memory_capture/list/search/preflight/finish/start declared allowedPhases:all in command-policy; phaseTools must match
    'signature_registry_*',  // B-4f46 CHK-003: audit-only finding signatureTag registry (Experience Layer Phase 1b); list/set declared allowedPhases:all in command-policy; no gate reads it
    'signature_backfill',  // B-17a9: WRITING Experience Layer maintenance command; fills empty finding signatureTags from a committed map (source='backfill'); dry-run default; declared allowedPhases:all mainSharedMutating in command-policy; writes audit-only fields after _hash; never recomputes _hash; no gate reads it
    'playbook_*',  // B-8387: audit-only staged Process Playbook lifecycle (Experience Layer Phase 2); propose/diff/approve/reject declared allowedPhases:all in command-policy; never files findings/touches gates; no gate reads it
    'recall',  // B-7561: read-only structured-field Story Recall over the existing story_list scan (Experience Layer Phase 3); declared allowedPhases:all readOnly in command-policy; writes nothing / no derived index; no gate reads it
    'learning_validate',  // B-a2e3: read-only / advisory Experience Layer referential re-validation (valid-rate / drift-rate vs HEAD); declared allowedPhases:all readOnly in command-policy; writes nothing / no persist; no gate reads it
    'learning_effectiveness',  // B-c06a: read-only / advisory Experience Layer effectiveness metric (per-story hint predictive value + ON/OFF arm comparison); declared allowedPhases:all readOnly in command-policy; writes nothing / no persist; no gate reads it
    'learning_scan',  // B-4eb6: out-of-band Experience Layer ③.1 maintenance WRITER; derives + persists the advisory finding-signals cache under .lattice/learning/ for the Phase 1.5 hint loader; declared allowedPhases:all mainSharedMutating in command-policy; reads findings via store ports; no gate reads it
  ],
  INIT: [
    'dev_start', // B-804c CHK-001 / B-da89: INIT is a valid worktree bootstrap entry; reconcile config with command-policy + worktree handler 4-phase set
    'story_update', 'checklist_update',
    'init_check_set', // B-e71f CHK-003: lattice-review-story-init reviewer 在 INIT 阶段写 init-check.json
    'init_check_repair', // B-95d8 CHK-001: 受控 fallback——无 subagent 环境下显式生成签名 init-check.json
    'scope_boundary_set', 'execution_boundary_set',
    'scope_freeze_check',
    'scope_extension_proposal', 'scope_extension_decide',
    'original_intent_snapshot_set',
  ],
  INIT_CHECK: [
    // story_advance 内部会代调 dev_start 创建 worktree，无需独立白名单
    'dev_start', // B-804c CHK-002: 显式 recovery 入口——卡在 INIT_CHECK 无 worktree 的 story 可手动重建
  ],
  PLAN: [
    'dev_start', // B-804c CHK-002: 显式 recovery 入口——PLAN 阶段缺 worktree 也可重建
    'story_update', 'story_review', 'story_review_dismiss',
    'checklist_add', 'checklist_update', 'checklist_remove',
    'verification_intent_repair', // B-4e06: audited legacy intent backfill (refused in INIT/INIT_CHECK/terminal)
    'understanding_set', 'understanding_get',
    'decision_set', 'decision_get',
    'decision_doc_proposal',
    'grill_start', 'grill_record', 'grill_close',
    'plan_set',
    'testintent_handoff',
    'scope_check_save',
    'scope_question_resolve', // B-ed3e CHK-003: 主 agent 消解 OQ
    'scope_contract_set',
    'scope_contract_init_from_plan', // B-6bfd CHK-006: seed scope contract from PLAN checklist files
    'original_intent_snapshot_set',
    'milestone_ledger_set', 'milestone_ledger_add',
    'slice_plan_set', 'parent_ledger_rollup_set',
    'proofstory_contract_set',
    'intent_collision_set',
    'scope_shrinkage_decision_set',
    'red_evidence_create',
    'spike_start', 'spike_result_set', 'spike_result', 'spike_discard', 'spike_promote',
  ],
  DEV: [
    'dev_start', // B-804c CHK-002 / B-da89: explicit worktree recovery entry; reconcile config with command-policy + worktree handler 4-phase set (DEV still in the pre-REVIEW bootstrap window)
    'checklist_add', 'checklist_update', 'checklist_remove',
    'verification_intent_repair', // B-4e06: audited legacy intent backfill
    'decision_doc_proposal', 'decision_doc_save',
    'light_review',
    'finding_add',
    'validate', 'status', 'serve',
    'review_escalation_policy_set',
    'story_advance',
    // B-a4e3 CHK-005: removed dead story_dispatch / finding_dispatch alias entries; the unified `dispatch` is granted all-phase via the '*' block.
    'finding_cluster',  // B-8bb5: DEV 中已有 finding 时，允许先聚簇再派发修复
    'scope_contract_set', 'scope_contract_acknowledge',
    'scope_contract_init_from_plan', // B-6bfd CHK-006: seed scope contract from PLAN checklist files
    'scope_shrinkage_decision_set',
    'parent_ledger_rollup_set',
    'guard_session_start', // B-6bfd CHK-004: start scope-guard session during implementation
  ],
  REVIEW: [
    'review_run_start',
    'finding_add', 'finding_list', 'finding_resolve', 'finding_dismiss',
    'review_pass_set',
    'understanding_get', 'decision_get',
    // B-a4e3 CHK-005: removed dead finding_dispatch alias entry; the unified `dispatch` is granted all-phase via the '*' block.
    'finding_cluster',  // B-9d95 CHK-005: auto/merge/split 聚簇
    'validate', 'status',
    'bug_report', 'bug_update', 'bug_list',
    'delivery_check_set', 'delivery_waiver_add', // delivery reviewer 在 REVIEW 阶段写签名/豁免，TEST→DONE gate 消费
    'review_loop_start', 'review_loop_iteration_add', 'review_loop_close',
    'review_escalation_policy_set',
    'story_advance',
    'scope_contract_acknowledge',
    'scope_shrinkage_decision_set',
    'parent_ledger_rollup_set',
    'verification_intent_repair', // B-4e06: audited legacy intent backfill
    'guard_session_start', // B-6bfd CHK-004: start scope-guard session during review
  ],
  TEST: [
    'finding_list', 'finding_cluster', // B-9d95 CHK-005: 聚簇视图在 TEST 也允许查询
    'validate', 'evaluate', 'evaluate_save',
    'verification_intent_repair', // B-4e06: audited legacy intent backfill
    'bug_report', 'bug_update', 'bug_list', 'bug_analyze',
    'delivery_check_set', 'delivery_waiver_add', // B-b089: delivery reviewer 在 TEST 阶段写签名
    'review_escalation_policy_set',
    'review_escalation_fallback_set',
    'scope_shrinkage_decision_set',
    'parent_ledger_rollup_set',
    'story_advance',
  ],
  DONE: [
    'review_escalation_policy_set',
    'review_escalation_fallback_set',
  ],
};

const ALWAYS_ALLOWED_READ_ONLY_COMMANDS = new Set([
  'session_brief',
  'next',
  'done_closure',
]);

function isPhaseToolsRecord(value: unknown): value is Record<string, string[]> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function patternMatchesCommand(pattern: string, cmd: string): boolean {
  if (pattern.endsWith('*')) return cmd.startsWith(pattern.slice(0, -1));
  return cmd === pattern;
}

function commandAllowedByPatterns(cmd: string, phase: string, phaseTools: Record<string, string[]>): boolean {
  const globalList = phaseTools['*'] || [];
  const phaseList = phaseTools[phase] || [];
  const all = [...globalList, ...phaseList].filter((p): p is string => typeof p === 'string');
  return all.some(pattern => patternMatchesCommand(pattern, cmd));
}

function commandAllowedByLifecyclePolicy(cmd: string, phase: string): boolean {
  const policy = getCommandLifecyclePolicy(cmd);
  if (!policy) return true;

  const allowedPhases = policyAllowedPhaseLabels(policy);
  if (allowedPhases.length === 0) return false;
  return allowedPhases.includes(phase);
}

function patternAllowedByLifecyclePolicy(pattern: string, phase: string): boolean {
  if (!pattern.endsWith('*')) return commandAllowedByLifecyclePolicy(pattern, phase);

  return getCommandPolicyEntries().some(([command]) => (
    patternMatchesCommand(pattern, command) && commandAllowedByLifecyclePolicy(command, phase)
  ));
}

const DEFAULT_CONFIG: LatticeConfig = {
  scanRoot: 'src',
  testsDir: 'tests',
  fixturesDir: 'tests/fixtures',
  storyDir: LATTICE_STORY_DIR,
  requirementsDir: 'docs/requirements',
  storyPrefix: 'B',
  flows: {
    defaults: {},
    patterns: [],
  },
  phaseTools: DEFAULT_PHASE_TOOLS,
};

const _cache = new Map<string, LatticeConfig>();

/**
 * Canonical project config filename.
 */
export const LATTICE_CONFIG_FILENAME = 'lattice.config.json';
/** Project config filenames that define an active Proofbound project root. */
export const PROJECT_CONFIG_FILENAMES: readonly string[] = [
  LATTICE_CONFIG_FILENAME,
];

/** True if the canonical Proofbound project config file exists in dir. */
export function hasProjectConfigFile(dir: string): boolean {
  return PROJECT_CONFIG_FILENAMES.some((name) => existsSync(join(dir, name)));
}

/**
 * Pick the canonical project config file path for `dir`. Returns the first
 * matching filename in {@link PROJECT_CONFIG_FILENAMES}, or null if no active
 * config file exists.
 */
export function pickProjectConfigPath(dir: string): { path: string; filename: string; legacy: boolean } | null {
  for (const name of PROJECT_CONFIG_FILENAMES) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return { path: candidate, filename: name, legacy: false };
    }
  }
  return null;
}

function findProjectRootByMarker(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (hasProjectConfigFile(dir)) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Search upward from cwd for lattice.config.json, return the project root directory. */
function resolveProjectRoot(): string {
  if (process.env.LATTICE_PROJECT_ROOT) return process.env.LATTICE_PROJECT_ROOT;
  return findProjectRootByMarker(process.cwd()) ?? process.cwd();
}

export function loadConfig(projectRoot?: string): LatticeConfig {
  // 有参数用参数，没参数从 cwd 向上查找
  const root = projectRoot || resolveProjectRoot();
  if (_cache.has(root)) return _cache.get(root)!;

  const latticePath = join(root, LATTICE_CONFIG_FILENAME);
  const latticeExists = existsSync(latticePath);

  let userConfig: Partial<LatticeConfig> = {};
  let chosenPath: string | null = null;
  if (latticeExists) {
    chosenPath = latticePath;
    try {
      userConfig = JSON.parse(readFileSync(latticePath, 'utf-8'));
    } catch { /* ignore parse errors */ }
  }
  void chosenPath; // retained for future diagnostics; suppress unused warning

  const _cached: LatticeConfig = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    flows: {
      ...DEFAULT_CONFIG.flows,
      ...(userConfig.flows || {}),
    },
  };

  _cache.set(root, _cached);
  return _cached;
}

/** 重置缓存（测试用） */
export function resetConfigCache(): void {
  _cache.clear();
}

/**
 * 判断命令是否在指定阶段的白名单中。
 * 支持通配符：'truth_*' 匹配 truth_scan / truth_extract 等。
 * '*' key 中的命令对所有阶段可用。
 */
export function isCommandAllowed(cmd: string, phase: string, phaseTools?: Record<string, string[]>): boolean {
  if (ALWAYS_ALLOWED_READ_ONLY_COMMANDS.has(cmd)) return true;
  if (!commandAllowedByLifecyclePolicy(cmd, phase)) return false;
  if (phaseTools !== undefined && !isPhaseToolsRecord(phaseTools)) return true; // malformed config falls back to policy ceiling only
  const pt = phaseTools || DEFAULT_PHASE_TOOLS;
  return commandAllowedByPatterns(cmd, phase, pt);
}

/**
 * 获取指定阶段所有允许的命令模式列表。
 */
export function getAllowedPatterns(phase: string, phaseTools?: Record<string, string[]>): string[] {
  const pt = isPhaseToolsRecord(phaseTools) ? phaseTools : DEFAULT_PHASE_TOOLS;
  return Array.from(new Set([...ALWAYS_ALLOWED_READ_ONLY_COMMANDS, ...(pt['*'] || []), ...(pt[phase] || [])]))
    .filter(pattern => ALWAYS_ALLOWED_READ_ONLY_COMMANDS.has(pattern) || patternAllowedByLifecyclePolicy(pattern, phase));
}
