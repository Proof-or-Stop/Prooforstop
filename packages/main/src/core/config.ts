
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { WorkflowProfile } from './types.js';
import { resolveAuditConfig as _resolveAuditConfig, type AuditConfig } from './audit-config.js';
import { getCommandLifecyclePolicy, getCommandPolicyEntries, policyAllowedPhaseLabels } from './command-policy.js';
import { PROOF_OR_STOP_DIR, PROOF_OR_STOP_STORY_DIR } from './proof-or-stop-paths.js';
import { readBrandEnv } from './brand-env.js';
import {
  PROOF_OR_STOP_CONFIG_FILENAME as CANONICAL_CONFIG_FILENAME,
  CONFIG_FILENAMES,
  MANIFEST_FILENAMES,
  stateDirCandidates,
} from './brand-paths.js';

/**
 * audit-config 扩展点（B-9bd9 CHK-004）：
 *   - profile 默认值由 `resolveAuditConfig` 接管（light=10, balanced=5, strict=3）
 *   - 项目级覆盖文件为 `<projectRoot>/.proof-or-stop/audit-config.json`
 *   - 详见 CLAUDE.md「框架自省 audit 配置」
 *
 * 这里以 re-export 的形式挂到 config 入口，**不**改动现有 `loadConfig` /
 * `isCommandAllowed` 等 profile 消费者的行为；没有用到 audit 的调用方无感知。
 */
export { _resolveAuditConfig as resolveAuditConfig };
export type { AuditConfig };

export interface ProofOrStopFlowConfig {
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

export type DynamicValidationModeConfig = 'off' | 'observe' | 'shadow' | 'enforce-low-risk';

export interface DynamicValidationPolicyDefaults {
  assurance?: string;
  riskTier?: string;
  closurePolicy?: string;
  fullBaselineReusePolicy?: string;
  cpuWeight?: number;
  expectedP50Ms?: number;
}

export interface ReproFirstPreflightConfig {
  mode?: 'off' | 'warn' | 'enforce';
}

/**
 * B-956f: project-level material-code classification overrides. Resolved
 * strictly (fail-closed) by core/material-code-policy.ts — malformed entries
 * throw a diagnostic naming the offending key. Level-1 runtime/build manifests
 * stay non-excludable: an excludePaths/paths entry naming (or, via the
 * filesystem-aware preflight, covering) a manifest is rejected.
 */
export interface MaterialCodeConfig {
  /** Extra code extensions to treat as material (normalized: leading dot, lowercase). */
  addExtensions?: string[];
  /** Extensions to subtract from the default code set. */
  removeExtensions?: string[];
  /** Segment-aware non-material path exclusions (e.g. experiments/). */
  excludePaths?: string[];
  /** Extra code-extension-gated material path prefixes. */
  paths?: string[];
  /** Override the default documentation/binary (non-material) extension set. */
  docExtensions?: string[];
}

export interface ProofStoryConfig {
  /** PLAN/INIT_CHECK/REVIEW rollback DEV admission ProofStory gate. Defaults to observe. */
  devGateMode?: 'observe' | 'warn' | 'enforce';
  /** Wave 2 PLAN acceptance-topology structural gate rollout. Defaults to observe. */
  acceptanceTopologyGateMode?: 'observe' | 'warn' | 'enforce';
  /** Wave 4 flat project acceptance rollout admission. Defaults to observe. */
  acceptanceRolloutGateMode?: 'observe' | 'warn' | 'enforce';
  /** REVIEW completeness diagnostic mode. Defaults to observe. */
  reviewGateMode?: 'observe' | 'warn' | 'enforce';
  /** DONE intent-equivalence diagnostic mode. Defaults to observe. */
  doneGateMode?: 'observe' | 'warn' | 'enforce';
}

/**
 * B-c054 (W2a): optional trusted RED-evidence policy block (spec §1.2).
 * DIAGNOSTIC ONLY — surfaced by `proof-or-stop doctor` and resolved by the fail-closed
 * policy resolver (core/red-evidence/policy.ts). NO loader default is applied:
 * an absent block leaves the subsystem unconfigured, and `pinnedPath` is
 * required-with-no-default per §1.2. This interface is intentionally permissive
 * (open index signature) so an UNKNOWN key still reaches the fail-closed
 * resolver instead of being silently dropped at parse time.
 */
export interface RedEvidencePolicyConfig {
  maxMatchers?: number;
  maxMatcherLen?: number;
  minMatcherLen?: number;
  minMatcherEntropyBits?: number;
  runTimeoutMs?: number;
  prepTimeoutMs?: number;
  killGraceMs?: number;
  forbiddenCatchAlls?: string[];
  forbiddenEnvKeysExtensions?: string[];
  invarianceExcludePaths?: string[];
  pinnedPath?: string[];
  matcherClassRegistry?: unknown[];
  runnerAdapterRegistry?: unknown[];
  runnerProfileRegistry?: unknown[];
  [key: string]: unknown;
}

export type AcceptanceTopologyGateMode = NonNullable<ProofStoryConfig['acceptanceTopologyGateMode']>;
export type AcceptanceRolloutGateMode = NonNullable<ProofStoryConfig['acceptanceRolloutGateMode']>;

/** Flat project policy only; Story prose/risk/milestone text never selects it. */
export function resolveAcceptanceTopologyGateMode(config: Pick<ProofOrStopConfig, 'proofStory'>): AcceptanceTopologyGateMode {
  const mode = config.proofStory?.acceptanceTopologyGateMode;
  return mode === 'warn' || mode === 'enforce' ? mode : 'observe';
}

/** Flat project policy only. Selective Story applicability remains excluded until Wave 3A. */
export function resolveAcceptanceRolloutGateMode(config: Pick<ProofOrStopConfig, 'proofStory'>): AcceptanceRolloutGateMode {
  const mode = config.proofStory?.acceptanceRolloutGateMode;
  return mode === 'warn' || mode === 'enforce' ? mode : 'observe';
}

export interface LifecycleControlConfig {
  runtimeEnforcement?: 'unavailable' | 'warn' | 'enforce';
}

export interface ProofOrStopConfig {
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
  /** Approved reviewer and Story-6 complex-role rollouts. Missing roles remain byte-exact legacy-full-context. */
  promptEnvelope?: {
    version?: 'proof-or-stop.prompt-envelope-rollout.v1' | 'proofbound.prompt-envelope-rollout.v1';
    roles?: Partial<Record<
      | 'proof-or-stop-review-behavior'
      | 'proof-or-stop-review-concept'
      | 'proof-or-stop-review-docs'
      | 'proof-or-stop-review-quality'
      | 'proof-or-stop-review-test-coverage'
      | 'proof-or-stop-review-topology-critic'
      | 'proof-or-stop-review-story-init'
      | 'proof-or-stop-review-scope-plan'
      | 'proof-or-stop-implementer'
      | 'proof-or-stop-review-delivery'
      | 'proof-or-stop-evaluator'
      // Deprecated keys remain readable for pre-migration configurations.
      | 'lattice-review-behavior'
      | 'lattice-review-concept'
      | 'lattice-review-docs'
      | 'lattice-review-quality'
      | 'lattice-review-test-coverage'
      | 'lattice-review-topology-critic'
      | 'lattice-review-story-init'
      | 'lattice-review-scope-plan'
      | 'lattice-implementer'
      | 'lattice-review-delivery'
      | 'lattice-evaluator',
      'legacy-full-context' | 'full-envelope'
    >>;
  };
  candidateSpecRouting?: {
    mode?: 'shadow' | 'warn' | 'enforce';
    candidateBudget?: number;
    queryGroupBudget?: number;
    rawHitsPerGroup?: number;
    maxDocumentFrequencyRatio?: number;
    /** First-output budget for unattended semantic proposal hosts. */
    hostStartupTimeoutMs?: number;
    /** Independent total runtime budget for unattended semantic proposal hosts. */
    hostTotalTimeoutMs?: number;
  };
  /**
   * Independently deployable scope-contract migrations. `off` preserves the
   * signed legacy representation; `warn` reads both representations but emits
   * migration diagnostics; `enforce` writes/compares only current versions.
   */
  scopeProtection?: {
    pathCanonicalization?: 'off' | 'warn' | 'enforce';
    astAnchors?: 'off' | 'warn' | 'enforce';
  };
  storyPrefix: string;
  flows: ProofOrStopFlowConfig;
  wrappersDir?: string;
  /** 项目语言：js（默认）或 python */
  language?: 'js' | 'python';
  /** CLI 测试配置 */
  cli?: {
    command: string;
  };
  /** 项目级验证命令；没有 validate.ts/js 时由 proof-or-stop validate 使用 */
  validate?: {
    /** Exact-input result sharing is independent of dynamic test selection. */
    sharedExecution?: boolean;
    command?: string;
    dynamic?: {
      mode?: DynamicValidationModeConfig;
      policyDefaults?: DynamicValidationPolicyDefaults;
    };
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
  /** Legacy config alias accepted by the verifier for dynamic validation. */
  validation?: ProofOrStopConfig['validate'];
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
  /** B-956f: language-neutral material-code classification overrides. */
  materialCode?: MaterialCodeConfig;
  proofStory?: ProofStoryConfig;
  /** B-c054 (W2a): optional trusted RED-evidence policy block; no loader default. */
  redEvidence?: RedEvidencePolicyConfig;
  lifecycleControl?: LifecycleControlConfig;
  /**
   * B-3b05: review_pass_set writer-session provenance validation. Default warn
   * (hardcoded fallback for absent/invalid config — a same-session write is
   * flagged `same_session_write` + stderr warning, never rejected). enforce is
   * opt-in for hosts with genuine per-thread session separation and rejects
   * owner-session writes of reviewer pass evidence.
   */
  reviewPassProvenance?: {
    mode?: 'warn' | 'enforce';
  };
  /** Runtime memory health diagnostics; advisory only, never gate evidence. */
  runtimeMemory?: {
    requiredClasses?: string[];
  };
  requiredRuntimeMemoryClasses?: string[];
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
    /** 距离上次任意 proof-or-stop 命令多久算 idle（默认 60） */
    idleProofOrStop?: number;
    /** open bug 多久没修算超期（默认 1440=24h） */
    bugStale?: number;
  };
  /**
   * Lifecycle hooks — spawn shell commands at Proof-or-Stop command lifecycle points.
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

/**
 * @deprecated Use `ProofOrStopConfig`. Retained as a durable alias, not a temporary
 * migration aid: this repository is multi-developer, and a teammate branch written
 * against `ProofOrStopConfig` must keep compiling when it merges. Never remove.
 */

export const DEFAULT_CANDIDATE_HOST_STARTUP_TIMEOUT_MS = 10_000;
export const DEFAULT_CANDIDATE_HOST_TOTAL_TIMEOUT_MS = 120_000;

/** 默认各阶段可用命令白名单 */
export const DEFAULT_PHASE_TOOLS: Record<string, string[]> = {
  '*': [
    'session_brief', // read-only recovery entrypoint; must work in every phase
    'next',          // read-only single next action, shares session_brief authority rules
    'done_closure',  // read-only DONE closure projection; local readiness only
    'lifecycle_check', // read-only proof-or-stop readiness projection; no command execution or evidence writes
    'milestone_status', // read-only grouped ProofStory milestone status report; no execution, evidence writes, reviewer launch, or phase changes
    'milestone_closeout', // read-only historical DONE milestone closeout snapshot report; no live freshness recomputation or writes
    'global_control_status', 'runtime_closure_status', 'admissibility_waterline', 'queue_governance_status', // B-eb18: read-only global lifecycle control plane projections
    'queue_exception_set', // B-eb18: guarded project-level queue exception writer; preserve-only, does not grant readiness
    'plan_skeleton', // read-only PLAN skeleton preview; --write delegates only to understanding_set/checklist_add
    'init_preflight', // B-62c8: read-only INIT→INIT_CHECK prerequisite surveyor; lists ALL prerequisites at once (vs story_advance fail-fast) + echoes the authoritative scope gate verdict; no command execution or evidence writes
    'evidence_plan', // B-09e7 (P3): read-only verification-evidence DRY planner (missing/rerun/refresh-only/fresh); no command execution or evidence writes
    'reviewer_batch', // P7: read-only reviewer-launcher PLAN producer; per-lane current-pass/scope-changed/no-receipt/blocking classification + Agent(...) launch instruction (orchestrator subagent-spawn form, not a dispatch CLI command); launches no reviewer, runs no review_run_start, writes no evidence
    'review_run_list', // read-only compact signed ReviewRun recovery/inspection; never emits prompt bytes or writes review evidence
    'evidence_refresh', // B-4896 (P4): opt-in one-pass refresh-only orchestrator; dry default read-only, --apply re-stamps once via verification_evidence_refresh_stale; never runs a command
    'live_smoke_transcript', // B-9b5e (P5): live-smoke transcript producer; read-only status default, --capture runs ONLY the provided command, --write persists the artifact (ownership-gated); independent opt-ins
    'delivery_context_pack', // P6: delivery-review context PRODUCER (not a signer); read-only pack default, --write persists the pack artifact (ownership-gated); consumes the V1 deliveryCheckRef, never writes delivery-check.json or accepts a waiver
    'lifecycle_orchestrate', // P8 (CAPSTONE): read-only top-level lifecycle orchestration; composes the prior read-only layers (V1 + P2-P7) into one phase-aware view via their read-only default path, consolidates blockers/next-actions, emits the next story_advance as a PRINTED string (never executed); runs no command, writes no evidence, advances no phase
    'done_prepare',  // pre-DONE readiness assistant; handler fail-closes outside TEST before mutation
    'done_required_validate', // opt-in DONE-required validation evidence writer; advisory when no policy exists
    'story_get', 'story_list', 'story_reconcile', 'identity_state_migrate', 'story_discard',
    'aux_*', // 全部辅助工具：scan/detail/coverage/locate/sync/trace/diagnose/doc_list
    'checklist_get',
    'finding_ledger_query', // Story 3: protected read-only signed scorecard/migration projection; no payload/path exposure or lifecycle authority
    'frozen_claim_drift_check', // B-2296 CHK-003: read-only, non-blocking FROZEN_CLAIM_DRIFT advisory; allowed in any phase, writes nothing
    'truth_*', 'gap_*', 'convergence_check',
    'story_advance', // 任何阶段都可以推进（cwd 门禁负责保护）
    'status',        // 全局：项目全貌（story 进度 + 代码验证）
    'graph',         // B-3e16: read-only story + evidence graph visualizer; reads story state in any phase, writes its index cache outside the repo
    'doctor',        // 全局：health 巡检，任何阶段都可以查
    'done_recover',  // 全局：显式恢复 partial-DONE（先检查 main clean / merge-tree）
    'check',         // 全局：Proof-or-Stop 管理资产/模板漂移检查；--apply/--upgrade 显式同步安全项
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
    'summary_set',   // 全局：DONE 前强制落总结，proof-or-stop short-path story 也需要
    'verification_evidence_add', 'verification_evidence_batch_add', 'verification_evidence_refresh_stale', 'verification_run', // verification evidence is metadata, allowed across phases for reviewer/test handoff (verification_run executes the pinned verifier + writes the receipt)
    'verification_pin_narrow', // B-1482: narrowing-only re-pin of an executable intent's proof selector. Named explicitly rather than folded into a wildcard: the active-story phase gate INTERSECTS the command-policy ceiling with this table, so a command absent here is refused in EVERY phase, and choosing a name that happens to fall inside an existing wildcard bucket would dodge that gate by naming. It sits beside the sibling evidence writers above because it carries the same allowedPhases:'all' storyScopedMutating policy
    'verification_context_pack_create', 'verification_context_pack_expand', // read-only verifier context packets
    'recover_evidence', // B-a2f1 CHK-003: single-shot stale-evidence recovery, safe in any phase (refuses on non-metadata dirt)
    'artifact_declare', // B-cf60: per-story declared product artifact registration, safe in any phase
    'artifact_release_*', // read-only non-runtime artifact release provenance inspection
    'capability_release_*', // read-only non-runtime product capability release provenance inspection
    'capability_release_backfill', // B-c389 M8: intentionally all-phase MUTATING migration command (records/commits non_authoritative capability releases into .proof-or-stop/capability-releases.jsonl + enriches under-bound candidate lineage under the learning-store lock); declared allowedPhases:all mainSharedMutating in command-policy; listed explicitly so it is no longer covered only by the read-only 'capability_release_*' wildcard's (stale-for-a-writer) inspection comment; behaviour unchanged (still all-phase); non_authoritative, never gate evidence
    'repro_*', 'spike_record', 'spike_review_set', 'red_green_relation_*', 'regression_matrix_review_set', 'story_create_from_repro', // B-0aa1: candidate-only repro-first intake commands; evidence-candidate scope only, never DONE or release proof
    'capsule_*',   // B-42c0: story handoff projection commands; evidence remains authoritative elsewhere
    'scope_contract_show', 'scope_contract_check', // B-be27: read/check scope contract; mutating commands are phase-scoped below
    'scope_diff_pack', // B-6bfd CHK-002: read-only mechanical diff context pack, useful for verifier context in any phase
    'original_intent_snapshot_get', 'milestone_ledger_get', 'slice_plan_get', 'parent_ledger_rollup_get', 'proofstory_contract_get', 'acceptance_matrix', 'acceptance_topology_check', 'acceptance_basis', 'pre_review_check_read', 'acceptance_rollout_report_read', 'acceptance_rollout_check', 'topology_critic_receipt_check',
    'intent_collision_get', 'scope_shrinkage_decision_get', 'red_evidence_get', 'spike_get',
    'red_evidence_envelope_check', // W2d (B-9ff1): read-only §1.1 envelope admissibility pre-flight; command-policy declares allowedPhases:all readOnly, so every phase bucket must reach it. It executes no envelope. Canonical scope sentence, used verbatim at every site that states this guarantee: Scoped to the command handler itself and the CLI story-evidence writers, it writes no RED-evidence record, chain record or story/evidence artifact, emits no process event, changes no gate verdict, and runs no preCommand or postCommand hook. Nothing outside that scope is covered: see the red_evidence_envelope_check note in cli/activity-policy.ts, which lists the surfaces known when it was written and is not a proof of exhaustiveness

    'intent_coverage_check', 'proofstory_gate_check', 'done_intent_equivalence_check', 'proofstory_review_completeness_check', // ProofStory read-only diagnostics; enforce mode exits nonzero but writes no evidence
    'parent_roadmap_status', 'parent_roadmap_evaluate', // Parent-roadmap totality diagnostics; read-only and no server-backed completion semantics
    'guard_session_status', // B-6bfd CHK-004: read-only guard session projection
    'guard_session_check', // B-6bfd CHK-004: NOT read-only — refreshes/writes guard-session.json + appends a guard_session_check process event, so it is an owner-gated storyScopedMutating write (see command-policy.ts); listed here because the check itself is allowed in every phase, while guard_session_start is phase-scoped below
    'prewrite_guard_check', // B-6bfd CHK-005: read-only pre-write scope gate for Claude Code PreToolUse hooks; called by the hook in any phase, writes nothing
    'verification_pin_guard_check', // B-1507 CHK-003: read-only fail-open evidence-pin seatbelt for shell-tool PreToolUse hooks; called by the hook in any phase, writes nothing
    'plan_get',
    'workflow_*',    // 全局：profile 查看/设置/解释，任何阶段都可以
    'background_*',  // B-45ed CHK-007: background 是元数据，任何阶段可读写
    'dispatch',      // B-9d95 CHK-004: 统一派发入口，全阶段开放（INIT_CHECK 起）
    'reviewer_list', // B-fdcf CHK-001: 全阶段可查询 opt-in reviewer 名单
    'review_incremental_context', // B-f675 CHK-002: read-only incremental review context, any phase
    'validation_plan', // B-a745 CHK-005: read-only Story-relevance validation planner (explain-only), any phase; executes no validation command and writes nothing
    'story_draft',   // B-9975: draft 操作全阶段可用（不分配 story id）
    'story_draft_list',
    'story_draft_discard',
    'draft_check_set',      // B-9975 CHK-002: draft check 全阶段可用
    'draft_issue_resolve',
    'planner_*', 'story_resolve', // Natural-language planner and plannedStep context resolution surfaces
    'capability_list', // B-f26a M2: read-only host capability diagnostics for cross-host degradation
    'capability_probe', // B-cd31 CHK-002: productized single-host capability diagnostics
    'agent_prompt', // Host-neutral role-only read or owner-gated Story-aware Prompt Envelope audit write; available in any phase
    'prompt_measurement_report', // B-360e: read-only deterministic no-Story prompt measurement, all phases
    'baseline_run', 'baseline_suite', 'baseline_suite_report', 'capability_claim_evaluate', 'capability_claim_formal_evaluate', // B-92e2/B-ce79: baseline artifact/report commands; formal claim still does not mutate lifecycle or release readiness
    'memory_benchmark_*', // B-d4dd/B-2a63: virtual benchmark + real-data export harnesses are read-only in all phases
    'pinn_*', // B-db1b: PINN claim-admissibility check/benchmark/report commands are local read-only diagnostics in all phases
    'quantum_claim_*', // B-d1bf/B-3779: Quantum local read-only claim-admissibility diagnostics (M3 check, M4 benchmark, M5 report); no lifecycle evidence writes
    'host_*', // Proof-or-Stop 0.3.6: host list/probe/install guidance; dry-run/read-only diagnostics only
    'host_runtime_*', // B-106b/B-d674: dispatch runtime readiness probes for fake/codex/claude-code/antigravity
    'candidate_spec_rollout_check', // B-8038: read-only quality/cost promotion projection
    'usage_sweep', // B-70e9 M2: read-only NON-AUTHORITATIVE retro-attribution usage sweep over host transcript stores; streams ~/.codex + ~/.claude, no ledger backfill, no gate evidence, writes nothing unless --out is passed (inside project root)
    'proof_or_stop_config_doctor', // Proof-or-Stop 0.3.6: CLI-first migration/config status; no Mac App dependency
    'proof_or_stop_config_repair', // B-526c: explicit confirmed gitRoot repair; command policy enforces mutating ownership semantics
    'codex_doctor',          // Codex adapter diagnostics (read-only); does not write process-event evidence
    'rollout_check', // Proof-or-Stop 0.3.6: read-only cross-project rollout diagnostics
    'baseline_run', 'baseline_suite', 'baseline_suite_report', // Proof-or-Stop baseline execution and suite reporting; writes baseline artifacts only
    'conduit_*', // Proof-or-Stop 0.3.6: conduit status/explain; no runner provisioning or authority mutation
    'story_export', // B-cd31 CHK-003: Canonical Story v0 export surface
    'observability_snapshot', // B-381e: read-only host-neutral observability adapter dry-run
    'handoff_create', 'handoff_inspect', // B-cd31 CHK-004: Proof-or-Stop cross-host handoff pack surface
    'handoff_accept', 'handoff_resume', // B-cd31 CHK-005: handoff accept/resume projections without authority mutation
    'handoff_receipt_submit', 'handoff_worktree_create', // B-aa98: overflow receipt/worktree diagnostic projections
    'dispatch_plan', 'dispatch_prepare', 'dispatch_run', 'overflow_auto', // B-106b: supervised dispatch runtime surfaces
    'dispatch_collect', 'dispatch_receipt_create', 'dispatch_status', 'dispatch_list', // B-106b: persisted dispatch lifecycle + receipt helpers
    'dispatch_resume', 'dispatch_reassign', 'dispatch_cancel', 'dispatch_review', 'dispatch_merge_plan', // B-106b/B-99d4: lifecycle control + fresh-context reassignment + manual review/merge guidance
    'dispatch_policy_create', 'dispatch_policy_get', 'dispatch_policy_check', 'dispatch_auto', 'dispatch_watch', // B-a5c2: policy-authorized dispatch controls + read-only watch
    'autopilot_*', // Proof-or-Stop unattended/autopilot surfaces declare allowedPhases:all in command-policy; phaseTools must match
    'quorum_submit', // local voluntary 3x2 floor helper; handler refuses without current reviewer pass evidence
    'quorum_prune', // B-3144: official B-bf52 recovery for poisoned host-verdict rounds; dry-run default, apply:true or the equivalent dryRun:false backs up + rewrites + commits; declared allowedPhases:all storyScopedMutating in command-policy; phaseTools must match
    'cross_host_review', // B-f57a: owner-driven local cross-host verdict writer; command-policy/handler keep owner lease, review-only dispatch policy, and dirty/head guards fail-closed
    'evidence_manifest', 'evidence_inspect', // B-cd31 CHK-006: portable evidence freshness diagnostics
    'parallel_wave_create', 'parallel_wave_inspect', 'parallel_plan', // B-29b6: read-only Proof-or-Stop Parallel Wave planning surfaces; no authority mutation
    'parallel_dispatch', 'parallel_status', 'parallel_merge_queue', 'parallel_report', // B-e70f: read-only Parallel Dispatch projections; no spawning or authority mutation
    'review_loop_status', 'review_loop_policy_show', // B-7a34: read-only review loop projections; REVIEW-only mutators are phase-scoped below
    'certification_window_status', // B-1e1f: signed PRE_CERT window readout; any phase; mutating begin/cancel are phase-scoped below
    'dev_memory_*',  // B-1148: dev_memory_capture/list/search/preflight/finish/start declared allowedPhases:all in command-policy; phaseTools must match
    'memory_playbook_baseline_*', 'playbook_runtime_health', 'final_response_check',
    'signature_registry_*',  // B-4f46 CHK-003: audit-only finding signatureTag registry (Experience Layer Phase 1b); list/set declared allowedPhases:all in command-policy; no gate reads it
    'signature_backfill',  // B-17a9: WRITING Experience Layer maintenance command; fills empty finding signatureTags from a committed map (source='backfill'); dry-run default; declared allowedPhases:all mainSharedMutating in command-policy; writes audit-only fields after _hash; never recomputes _hash; no gate reads it
    'playbook_*',  // B-8387/B-cc94/B-9958: audit-only staged Process Playbook lifecycle plus deduped seed promotion diagnostics/batch writers; declared allowedPhases:all in command-policy; never files findings/touches gates; no gate reads it
    'source_lineage_audit', // B-01df M1: read-only learning source lineage audit; diagnostics only, no store creation/promotion/runtime blocking
    'recall',  // B-7561: read-only structured-field Story Recall over the existing story_list scan (Experience Layer Phase 3); declared allowedPhases:all readOnly in command-policy; writes nothing / no derived index; no gate reads it
    'learning_validate',  // B-a2e3: read-only / advisory Experience Layer referential re-validation (valid-rate / drift-rate vs HEAD); declared allowedPhases:all readOnly in command-policy; writes nothing / no persist; no gate reads it
    'learning_effectiveness',  // B-c06a: read-only / advisory Experience Layer effectiveness metric (per-story hint predictive value + ON/OFF arm comparison); declared allowedPhases:all readOnly in command-policy; writes nothing / no persist; no gate reads it
    'learning_scan',  // B-4eb6: out-of-band Experience Layer ③.1 maintenance WRITER; derives + persists the advisory finding-signals cache under .proof-or-stop/learning/ for the Phase 1.5 hint loader; declared allowedPhases:all mainSharedMutating in command-policy; reads findings via store ports; no gate reads it
    'story_resume',  // B-bbaf CHK-003: human-only ack that clears a convergence-breaker freeze; a freeze can occur at story_advance in ANY phase, so the ack must be available in every phase (declared allowedPhases:all storyScopedMutating in command-policy; refused under autopilot/non-interactive)
  ],
  INIT: [
    'dev_start', // B-804c CHK-001 / B-da89: INIT is a valid worktree bootstrap entry; reconcile config with command-policy + worktree handler 4-phase set
    'story_update', 'checklist_update',
    'init_check_set', // B-e71f CHK-003: proof-or-stop-review-story-init reviewer 在 INIT 阶段写 init-check.json
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
    'candidate_spec_route', // B-8038: bounded PLAN candidate producer
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
    'acceptance_basis_generate',
    'topology_exclusion_approval_set', 'topology_critic_receipt_set',
    'intent_collision_set',
    'scope_shrinkage_decision_set',
    'red_evidence_create',
    'spike_start', 'spike_result_set', 'spike_result', 'spike_discard', 'spike_promote',
  ],
  DEV: [
    'candidate_spec_route', // B-8038: owner development and focused verification
    'dev_start', // B-804c CHK-002 / B-da89: explicit worktree recovery entry; reconcile config with command-policy + worktree handler 4-phase set (DEV still in the pre-REVIEW bootstrap window)
    'checklist_add', 'checklist_update', 'checklist_remove',
    'verification_intent_append',
    'verification_intent_repair', // B-4e06: audited legacy intent backfill
    'decision_doc_proposal', 'decision_doc_save',
    'light_review',
    'finding_add',
    'finding_runtime_evidence_run', 'finding_runtime_evidence_verify',
    'validate', 'status', 'serve',
    'review_escalation_policy_set',
    'review_host_availability_probe',
    'story_advance',
    // B-a4e3 CHK-005: removed dead story_dispatch / finding_dispatch alias entries; the unified `dispatch` is granted all-phase via the '*' block.
    'finding_cluster',  // B-8bb5: DEV 中已有 finding 时，允许先聚簇再派发修复
    'stall_resolution_set', // B-7813: owner-driven signed structured resolution that clears the convergence-stall DEV→REVIEW mint block; command-policy declares allowedPhases:['DEV','REVIEW'] so both phase buckets must list it
    'scope_contract_set', 'scope_contract_acknowledge',
    'scope_contract_init_from_plan', // B-6bfd CHK-006: seed scope contract from PLAN checklist files
    'scope_shrinkage_decision_set',
    'parent_ledger_rollup_set',
    'guard_session_start', // B-6bfd CHK-004: start scope-guard session during implementation
    'red_evidence_binding_set', // W2b (B-e10d): register the per-story target binding before a RED run; owner-lease + mutation-authority gated, storyScopedMutating, DEV-only
    'red_evidence_quarantine', // W2c (B-506e): retire a bad chain head without mutating history; owner-lease + mutation-authority gated, storyScopedMutating, DEV-only
    'red_evidence_recover', // W2c (B-506e): undo a mistaken quarantine; owner-lease + mutation-authority gated, storyScopedMutating, DEV-only
    'acceptance_basis_generate', // Wave 1A registered verifier writer; DEV is allowed for implementation-time regeneration, without lifecycle consumption
    'certification_window_begin', 'certification_window_cancel',
    'review_inventory_finalize',
    'pre_review_check',
    'acceptance_rollout_report',
    'topology_exclusion_approval_set', 'topology_critic_receipt_set',
  ],
  REVIEW: [
    'candidate_spec_route', // B-8038: current-diff rerouting for reviewer lanes
    // B-3f3d: deadlock break. A scope-contract change during REVIEW staleness-invalidates the
    // acceptance basis -> topology critic receipt is refused -> review-inventory cannot finalize
    // -> REVIEW->DEV is refused -> the basis can never be regenerated. PLAN is unreachable from
    // REVIEW (REPLAN belongs to DEV), so REVIEW is the only place left to repair it. Safe because
    // the basis signature covers structural bindings only (scope-contract digest, closure files
    // hash, story files hash) and never reviewer verdicts, so it cannot launder a review pass.
    'acceptance_basis_generate',
    'review_run_start',
    'review_inventory_begin', 'review_inventory_status', 'review_inventory_critic_set', 'review_inventory_wave_advance', 'review_inventory_finalize', 'review_inventory_cancel',
    'finding_add', 'finding_list', 'finding_resolve', 'finding_dismiss',
    'review_pass_set',
    'understanding_get', 'decision_get',
    // B-a4e3 CHK-005: removed dead finding_dispatch alias entry; the unified `dispatch` is granted all-phase via the '*' block.
    'finding_cluster',  // B-9d95 CHK-005: auto/merge/split 聚簇
    'stall_resolution_set', // B-7813: owner-driven signed structured resolution that clears the convergence-stall DEV→REVIEW mint block; command-policy declares allowedPhases:['DEV','REVIEW'] so both phase buckets must list it
    'validate', 'status',
    'bug_report', 'bug_update', 'bug_list',
    'review_loop_start', 'review_loop_iteration_add', 'review_loop_close',
    'certification_window_begin', 'certification_window_cancel',
    'review_inventory_finalize',
    'review_escalation_policy_set',
    'review_host_availability_probe',
    'story_advance',
    'scope_contract_acknowledge',
    'scope_shrinkage_decision_set',
    'parent_ledger_rollup_set',
    'verification_intent_repair', // B-4e06: audited legacy intent backfill
    'guard_session_start', // B-6bfd CHK-004: start scope-guard session during review
    'topology_exclusion_approval_set', 'topology_critic_receipt_set',
  ],
  TEST: [
    'candidate_spec_route', // B-8038: end-to-end routing verification
    'finding_list', 'finding_cluster', // B-9d95 CHK-005: 聚簇视图在 TEST 也允许查询
    'validate', 'evaluate', 'evaluate_save',
    'verification_intent_repair', // B-4e06: audited legacy intent backfill
    'bug_report', 'bug_update', 'bug_list', 'bug_analyze',
    'delivery_check_set', 'delivery_waiver_add', // B-b089: delivery reviewer 在 TEST 阶段写签名
    'certification_window_begin', 'certification_window_cancel',
    'review_inventory_finalize',
    'review_escalation_policy_set',
    'review_host_availability_probe',
    'review_escalation_fallback_set',
    'scope_shrinkage_decision_set',
    'parent_ledger_rollup_set',
    'story_advance',
  ],
  DONE: [
    'review_escalation_policy_set',
    'review_host_availability_probe',
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

const DEFAULT_CONFIG: ProofOrStopConfig = {
  scanRoot: 'src',
  testsDir: 'tests',
  fixturesDir: 'tests/fixtures',
  storyDir: PROOF_OR_STOP_STORY_DIR,
  requirementsDir: 'docs/requirements',
  candidateSpecRouting: {
    mode: 'shadow',
    candidateBudget: 8,
    queryGroupBudget: 10,
    rawHitsPerGroup: 50,
    maxDocumentFrequencyRatio: 0.4,
    hostStartupTimeoutMs: DEFAULT_CANDIDATE_HOST_STARTUP_TIMEOUT_MS,
    hostTotalTimeoutMs: DEFAULT_CANDIDATE_HOST_TOTAL_TIMEOUT_MS,
  },
  scopeProtection: {
    pathCanonicalization: 'enforce',
    astAnchors: 'enforce',
  },
  storyPrefix: 'B',
  flows: {
    defaults: {},
    patterns: [],
  },
  phaseTools: DEFAULT_PHASE_TOOLS,
};

const _cache = new Map<string, ProofOrStopConfig>();

/**
 * Roots that have already been told their config filename is deprecated.
 *
 * B-cc10 CHK-004: the notice is emitted at most once per project root per
 * process. `loadConfig` is called from dozens of call sites per command, so an
 * uncached notice would repeat itself dozens of times in one invocation.
 */
const _deprecatedConfigNoticeShown = new Set<string>();

/**
 * B-cc10 CHK-004: one-line notice when a project still uses the DEPRECATED
 * config filename.
 *
 * STDERR, NEVER STDOUT. This is a hard constraint inherited from B-cdf6: stdout
 * is a machine-readable channel (`proof-or-stop validate --json` must parse as
 * exactly one JSON payload), so any human-facing advisory written to stdout
 * corrupts every piped consumer. `core/config.ts` is imported by effectively the
 * whole CLI, so a stray `console.log` here would contaminate the JSON output of
 * every command at once.
 *
 * The text names BOTH filenames — the deprecated one that resolved and the
 * canonical one to rename it to — so the notice is actionable without needing
 * the docs.
 */
function warnDeprecatedConfigFilename(root: string, filename: string): void {
  if (_deprecatedConfigNoticeShown.has(root)) return;
  _deprecatedConfigNoticeShown.add(root);
  process.stderr.write(
    `⚠ ${filename} is deprecated; rename it to ${PROOF_OR_STOP_CONFIG_FILENAME} `
    + `(the deprecated name is still read, but only the canonical name is written).\n`,
  );
}

/**
 * Canonical project config filename — sourced from the read-both resolver
 * (B-cc10 CHK-002). Only this name is ever WRITTEN.
 */
export const PROOF_OR_STOP_CONFIG_FILENAME = CANONICAL_CONFIG_FILENAME;
/** @deprecated Use `PROOF_OR_STOP_CONFIG_FILENAME`. */
/**
 * Project config filenames that define an active Proof-or-Stop project root,
 * canonical FIRST so canonical-wins falls out of iteration order.
 *
 * B-cc10 CHK-002: this is a read-both list rather than a single name, so a
 * project that still has only the deprecated filename keeps resolving. The list
 * comes from `core/brand-paths.ts` rather than being spelled here, so no call
 * site can end up recognizing only one of the two spellings — that is exactly
 * the B-cdf6 F-065/F-061 shape (a deprecated literal inside a membership test,
 * which made the CANONICAL name silently fail).
 */
export const PROJECT_CONFIG_FILENAMES: readonly string[] = CONFIG_FILENAMES;

/** True if the canonical Proof-or-Stop project config file exists in dir. */
export function hasProjectConfigFile(dir: string): boolean {
  return PROJECT_CONFIG_FILENAMES.some((name) => existsSync(join(dir, name)));
}

/**
 * Global-thin manifest probe locations, canonical first.
 *
 * B-cc10 CHK-002: the state-dir spelling and the manifest filename both come
 * from the read-both resolver, so this probe follows the rename automatically
 * and accepts a deprecated-spelled manifest during migration. `.proof-or-stop` stays
 * an explicit extra entry: it is a case variant kept for case-sensitive
 * filesystems, not a brand identity the resolver owns.
 */
const GLOBAL_THIN_ACTIVITY_MANIFEST_PATHS: readonly string[] = [
  ...MANIFEST_FILENAMES.flatMap((file) => stateDirCandidates(file)),
  // B-cc10 CHK-004: the case variant must accept BOTH manifest filenames too.
  // Pinning it to the deprecated filename would mean a `.proof-or-stop` root whose
  // manifest HAD been migrated stopped being recognized as global-thin — the
  // rename would break the newer layout while the older one kept working, which
  // is the backwards B-cdf6 failure direction.
  ...MANIFEST_FILENAMES.map((file) => join('.proof-or-stop', file)),
].filter((value, index, all) => all.indexOf(value) === index);

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** True for runtime-managed global-thin roots that may receive activity logs. */
export function isManagedGlobalThinRoot(dir: string): boolean {
  for (const relPath of GLOBAL_THIN_ACTIVITY_MANIFEST_PATHS) {
    const candidate = join(dir, relPath);
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf-8'));
      if (isJsonRecord(parsed) && parsed.assetMode === 'global-thin') return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Root eligibility for runtime activity logging only; not canonical config loading. */
export function isRuntimeActivityRoot(dir: string): boolean {
  return hasProjectConfigFile(dir) || isManagedGlobalThinRoot(dir);
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
      // B-cc10 CHK-002: report WHICH spelling resolved. Iteration order makes
      // the canonical name win when both exist; `legacy` is true only when the
      // deprecated filename is what actually satisfied the lookup, which is the
      // signal CHK-004's one-line stderr notice consumes. Deriving it by
      // comparing against the canonical constant (rather than hardcoding the old
      // filename in a comparison) is deliberate — a deprecated literal inside a
      // comparison is the exact B-cdf6 F-065/F-061/F-068 regression shape.
      return { path: candidate, filename: name, legacy: name !== PROOF_OR_STOP_CONFIG_FILENAME };
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

/** Search upward from cwd for proof-or-stop.config.json, return the project root directory. */
function resolveProjectRoot(): string {
  const envRoot = readBrandEnv('PROJECT_ROOT');
  if (envRoot) return envRoot;
  return findProjectRootByMarker(process.cwd()) ?? process.cwd();
}

/**
 * Prefix shared by the duplicate-key error MESSAGE and the `startsWith` filter
 * that decides whether to rethrow it.
 *
 * B-cc10 CHK-004: these two were previously two independent hardcoded
 * `proof-or-stop.config.json` literals — precisely the B-cdf6 F-065/F-061 regression
 * shape, where a brand literal inside a COMPARISON drifts away from the literal
 * used to build the value it compares against. Renaming only the message would
 * have made the filter silently stop matching, downgrading a hard duplicate-key
 * rejection into the permissive malformed-config fallback: the config would load
 * with a silently-chosen prompt body. One constant makes that drift impossible.
 */
const DUPLICATE_PROMPT_ENVELOPE_ERROR_PREFIX = `${PROOF_OR_STOP_CONFIG_FILENAME} duplicate `;

/**
 * JSON.parse silently keeps the last duplicate object key. That is unsafe for
 * per-role rollout flags because two visually contradictory entries could
 * select a different prompt body than the reviewer approved.
 */
export function assertNoDuplicatePromptEnvelopeRoleKeys(source: string): void {
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(source[index] ?? '')) index += 1;
  };
  const parseString = (): string => {
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === '\\') {
        index += 2;
        continue;
      }
      if (source[index] === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      }
      index += 1;
    }
    throw new Error('unterminated JSON string');
  };
  const parseValue = (path: readonly string[]): void => {
    skipWhitespace();
    if (source[index] === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      while (source[index] !== '}') {
        if (source[index] !== '"') throw new Error('invalid JSON object key');
        const key = parseString();
        skipWhitespace();
        if (source[index] !== ':') throw new Error('invalid JSON object separator');
        index += 1;
        const duplicatePromptEnvelopeKey = keys.has(key) && (
          (path.length === 0 && key === 'promptEnvelope')
          || (path.length === 1 && path[0] === 'promptEnvelope' && key === 'roles')
          || (path.length === 2 && path[0] === 'promptEnvelope' && path[1] === 'roles')
        );
        if (duplicatePromptEnvelopeKey) {
          const qualifiedKey = [...path, key].join('.');
          throw new Error(`${DUPLICATE_PROMPT_ENVELOPE_ERROR_PREFIX}${qualifiedKey} key`);
        }
        keys.add(key);
        parseValue([...path, key]);
        skipWhitespace();
        if (source[index] === ',') {
          index += 1;
          skipWhitespace();
          continue;
        }
        if (source[index] !== '}') throw new Error('invalid JSON object terminator');
      }
      index += 1;
      return;
    }
    if (source[index] === '[') {
      index += 1;
      skipWhitespace();
      let item = 0;
      while (source[index] !== ']') {
        parseValue([...path, String(item)]);
        item += 1;
        skipWhitespace();
        if (source[index] === ',') {
          index += 1;
          skipWhitespace();
          continue;
        }
        if (source[index] !== ']') throw new Error('invalid JSON array terminator');
      }
      index += 1;
      return;
    }
    if (source[index] === '"') {
      parseString();
      return;
    }
    const match = source.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!match) throw new Error('invalid JSON value');
    index += match[0].length;
  };
  try {
    parseValue([]);
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith(`${DUPLICATE_PROMPT_ENVELOPE_ERROR_PREFIX}promptEnvelope`)
    ) {
      throw error;
    }
    // Preserve the existing malformed-config fallback. JSON.parse below owns
    // ordinary syntax handling; this scanner owns only duplicate role flags.
  }
}

export function loadConfig(projectRoot?: string): ProofOrStopConfig {
  // 有参数用参数，没参数从 cwd 向上查找
  const root = projectRoot || resolveProjectRoot();
  if (_cache.has(root)) return _cache.get(root)!;

  // B-cc10 CHK-002: resolve the config through the read-both picker instead of
  // probing only the canonical filename. Probing one name directly is what would
  // make a deprecated-spelled config silently invisible after the rename (the
  // project would load defaults instead of erroring — a silent behaviour change).
  const picked = pickProjectConfigPath(root);
  const proofOrStopPath = picked?.path ?? join(root, PROOF_OR_STOP_CONFIG_FILENAME);
  const proofOrStopExists = picked !== null;

  // B-cc10 CHK-004: notice ONLY when the deprecated spelling is what actually
  // resolved. A project holding only the canonical filename must stay silent,
  // and a project holding BOTH resolves canonical-first (iteration order in
  // pickProjectConfigPath), so `legacy` is false and it also stays silent.
  if (picked?.legacy) warnDeprecatedConfigFilename(root, picked.filename);

  let userConfig: Partial<ProofOrStopConfig> = {};
  let chosenPath: string | null = null;
  if (proofOrStopExists) {
    chosenPath = proofOrStopPath;
    const rawConfig = readFileSync(proofOrStopPath, 'utf-8');
    assertNoDuplicatePromptEnvelopeRoleKeys(rawConfig);
    try {
      userConfig = JSON.parse(rawConfig);
    } catch { /* ignore parse errors */ }
  }
  void chosenPath; // retained for future diagnostics; suppress unused warning

  const _cached: ProofOrStopConfig = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    flows: {
      ...DEFAULT_CONFIG.flows,
      ...(userConfig.flows || {}),
    },
    scopeProtection: {
      ...DEFAULT_CONFIG.scopeProtection,
      ...(userConfig.scopeProtection || {}),
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
