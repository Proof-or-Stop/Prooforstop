
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { WorkflowProfile } from './types.js';
import { resolveAuditConfig as _resolveAuditConfig, type AuditConfig } from './audit-config.js';
import { getCommandLifecyclePolicy, getCommandPolicyEntries, policyAllowedPhaseLabels } from './command-policy.js';

/**
 * audit-config 扩展点（B-9bd9 CHK-004）：
 *   - profile 默认值由 `resolveAuditConfig` 接管（light=10, balanced=5, strict=3）
 *   - 项目级覆盖文件为 `<projectRoot>/.koala/audit-config.json`
 *   - 详见 packages/koala/CLAUDE.md「框架自省 audit 配置」
 *
 * 这里以 re-export 的形式挂到 config 入口，**不**改动现有 `loadConfig` /
 * `isCommandAllowed` 等 profile 消费者的行为；没有用到 audit 的调用方无感知。
 */
export { _resolveAuditConfig as resolveAuditConfig };
export type { AuditConfig };

export interface KoalaFlowConfig {
  defaults: Record<string, Record<string, unknown>>;
  patterns: Array<{ field: string; regex: string }>;
}

export interface KoalaConfig {
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
  flows: KoalaFlowConfig;
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
    }>;
  };
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
    /** 距离上次任意 koala 命令多久算 idle（默认 60） */
    idleKoala?: number;
    /** open bug 多久没修算超期（默认 1440=24h） */
    bugStale?: number;
  };
  /**
   * Lifecycle hooks — spawn shell commands at koala 命令的 4 个事件点。
   * 每个事件下用 commandName 或 "*" 通配匹配，value 是 shell 命令数组。
   * onPhaseChange 的 key 用 "FROM->TO" 格式（或 "*"）。
   *
   * 失败/超时不阻塞主命令，详见 core/hooks.ts 和 packages/koala/docs/guide-hooks.md。
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
    'story_get', 'story_list', 'story_reconcile', 'story_discard',
    'aux_*', // 全部辅助工具：scan/detail/coverage/locate/sync/trace/diagnose/doc_list
    'checklist_get',
    'truth_*', 'gap_*', 'convergence_check',
    'story_advance', // 任何阶段都可以推进（cwd 门禁负责保护）
    'status',        // 全局：项目全貌（story 进度 + 代码验证）
    'doctor',        // 全局：health 巡检，任何阶段都可以查
    'done_recover',  // 全局：显式恢复 partial-DONE（先检查 main clean / merge-tree）
    'check',         // 全局：Koala 管理资产/模板漂移检查；--apply/--upgrade 显式同步安全项
    'test_list',     // 全局：读取测试证据快照，TEST/DEV 排障都需要
    'bug_list',      // 全局：读取 bug 状态，便于复核 dashboard
    'finding_list',  // 全局：只读查看 reviewer 结果，避免阶段 UX 陷阱
    'audit',         // 全局：B-9bd9 框架自省 audit（advisory，任何阶段都可以跑）
    'verify_codex',  // Codex adapter 资产/heartbeat 硬证据验证（优先通过本地 wrapper 调用）
    'summary_get',   // 全局：读取 summary，任何阶段都可以查
    'grill_get',     // 全局：读取 PLAN grill planning context；不会写证据
    'summary_set',   // 全局：DONE 前强制落总结，koala short-path story 也需要
    'verification_evidence_add', 'verification_evidence_batch_add', 'verification_evidence_refresh_stale', // verification evidence is metadata, allowed across phases for reviewer/test handoff
    'verification_context_pack_create', 'verification_context_pack_expand', // read-only verifier context packets for authority-backed runs
    'recover_evidence', // B-a2f1 CHK-003: single-shot stale-evidence recovery, safe in any phase (refuses on non-metadata dirt)
    'artifact_declare', // B-cf60: per-story declared product artifact registration, safe in any phase
    'capsule_*',   // B-42c0: story handoff projection commands; evidence remains authoritative elsewhere
    'scope_contract_show', 'scope_contract_check', // B-be27: read/check scope contract; mutating commands are phase-scoped below
    'scope_diff_pack', // B-6bfd CHK-002: read-only mechanical diff context pack, useful for verifier context in any phase
    'guard_session_status', // B-6bfd CHK-004: read-only guard session projection
    'guard_session_check', // B-6bfd CHK-004: NOT read-only — refreshes/writes guard-session.json + appends a guard_session_check process event, so it is an owner-gated storyScopedMutating write (see command-policy.ts); listed here because the check itself is allowed in every phase, while guard_session_start is phase-scoped below
    'plan_get',
    'workflow_*',    // 全局：profile 查看/设置/解释，任何阶段都可以
    'background_*',  // B-45ed CHK-007: background 是元数据，任何阶段可读写
    'dispatch',      // B-9d95 CHK-004: 统一派发入口，全阶段开放（INIT_CHECK 起）
    'reviewer_list', // B-fdcf CHK-001: 全阶段可查询 opt-in reviewer 名单
    'story_draft',   // B-9975: draft 操作全阶段可用（不分配 story id）
    'story_draft_list',
    'story_draft_discard',
    'draft_check_set',      // B-9975 CHK-002: draft check 全阶段可用
    'draft_issue_resolve',
    'authority_enforce_policy', // B-ea92 M1: read-only authority policy discovery, no side-effects
    'authority_enforce_runner', // B-5cdc: read-only enforce runner readiness/dry-run projection; no provider execution
    'capability_list', // B-f26a M2: read-only host capability diagnostics for cross-host degradation
    'capability_probe', // B-cd31 CHK-002: productized single-host capability diagnostics
    'host_*', // Lattice CLI 0.3.5: host list/probe/install guidance; dry-run/read-only diagnostics only
    'host_runtime_*', // B-106b: dispatch runtime readiness probes for fake/claude-code/gemini/codex
    'lattice_config_doctor', // Lattice CLI 0.3.5: CLI-first migration/config status; no Mac App dependency
    'codex_doctor',          // Codex adapter diagnostics (read-only); does not write process-event evidence
    'rollout_check', // Lattice CLI 0.3.5: read-only cross-project rollout diagnostics
    'authority_status', // Lattice CLI 0.3.5: receipt-aware status only; no evidence submission
    'conduit_*', // Lattice CLI 0.3.5: conduit status/explain; no runner provisioning or authority mutation
    'story_export', // B-cd31 CHK-003: Canonical Story v0 export surface
    'story_authority_resolve', // B-381e: read-only authority/worktree resolver for observability adapters
    'observability_snapshot', // B-381e: read-only host-neutral observability adapter dry-run
    'handoff_create', 'handoff_inspect', // B-cd31 CHK-004: Lattice cross-host handoff pack surface
    'handoff_accept', 'handoff_resume', // B-cd31 CHK-005: handoff accept/resume projections without authority mutation
    'handoff_receipt_submit', 'handoff_worktree_create', // B-aa98: overflow receipt/worktree diagnostic projections
    'dispatch_plan', 'dispatch_prepare', 'dispatch_run', 'overflow_auto', // B-106b: supervised dispatch runtime surfaces
    'dispatch_collect', 'dispatch_receipt_create', 'dispatch_status', 'dispatch_list', // B-106b: persisted dispatch lifecycle + receipt helpers
    'dispatch_resume', 'dispatch_cancel', 'dispatch_review', 'dispatch_merge_plan', // B-106b: lifecycle control + manual review/merge guidance
    'evidence_manifest', 'evidence_inspect', // B-cd31 CHK-006: portable evidence freshness diagnostics
    'parallel_wave_create', 'parallel_wave_inspect', 'parallel_plan', // B-29b6: read-only Lattice Parallel Wave planning surfaces; no authority mutation
    'parallel_dispatch', 'parallel_status', 'parallel_merge_queue', 'parallel_report', // B-e70f: read-only Parallel Dispatch projections; no spawning or authority mutation
    'dev_memory_*',  // B-1148: dev_memory_capture/list/search/preflight/finish/start declared allowedPhases:all in command-policy; phaseTools must match
  ],
  INIT: [
    'story_update', 'checklist_update',
    'init_check_set', // B-e71f CHK-003: koala-review-story-init reviewer 在 INIT 阶段写 init-check.json
    'init_check_repair', // B-95d8 CHK-001: 受控 fallback——无 subagent 环境下显式生成签名 init-check.json
  ],
  INIT_CHECK: [
    // story_advance 内部会代调 dev_start 创建 worktree，无需独立白名单
  ],
  PLAN: [
    'story_update', 'story_review', 'story_review_dismiss',
    'checklist_add', 'checklist_update', 'checklist_remove',
    'understanding_set', 'understanding_get',
    'decision_set', 'decision_get',
    'grill_start', 'grill_record', 'grill_close',
    'plan_set',
    'testintent_handoff',
    'scope_check_save',
    'scope_question_resolve', // B-ed3e CHK-003: 主 agent 消解 OQ
    'scope_contract_set',
    'scope_contract_init_from_plan', // B-6bfd CHK-006: seed scope contract from PLAN checklist files
  ],
  DEV: [
    'checklist_add', 'checklist_update', 'checklist_remove',
    'light_review',
    'finding_add',
    'validate', 'status', 'serve',
    'story_advance',
    'story_dispatch', // B-45ed CHK-005: 主 agent 派发 implementer
    'finding_dispatch', // B-45ed CHK-010: 主 agent 派发 finding 修复（DEV 阶段可能提前出现 finding）
    'finding_cluster',  // B-8bb5: DEV 中已有 finding 时，允许先聚簇再派发修复
    'scope_contract_set', 'scope_contract_acknowledge',
    'scope_contract_init_from_plan', // B-6bfd CHK-006: seed scope contract from PLAN checklist files
    'guard_session_start', // B-6bfd CHK-004: start scope-guard session during implementation
  ],
  REVIEW: [
    'review_run_start',
    'finding_add', 'finding_list', 'finding_resolve', 'finding_dismiss',
    'review_pass_set',
    'understanding_get', 'decision_get',
    'finding_dispatch', // B-45ed CHK-010: 主 agent 派发 finding 修复
    'finding_cluster',  // B-9d95 CHK-005: auto/merge/split 聚簇
    'validate', 'status',
    'bug_report', 'bug_update', 'bug_list',
    'delivery_check_set', 'delivery_waiver_add', // delivery reviewer 在 REVIEW 阶段写签名/豁免，TEST→DONE gate 消费
    'story_advance',
    'scope_contract_acknowledge',
    'guard_session_start', // B-6bfd CHK-004: start scope-guard session during review
  ],
  TEST: [
    'finding_list', 'finding_cluster', // B-9d95 CHK-005: 聚簇视图在 TEST 也允许查询
    'validate', 'evaluate', 'evaluate_save',
    'bug_report', 'bug_update', 'bug_list', 'bug_analyze',
    'delivery_check_set', 'delivery_waiver_add', // B-b089: delivery reviewer 在 TEST 阶段写签名
    'story_advance',
  ],
};

const ALWAYS_ALLOWED_READ_ONLY_COMMANDS = new Set([
  'session_brief',
  'next',
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

const DEFAULT_CONFIG: KoalaConfig = {
  scanRoot: 'src',
  testsDir: 'tests',
  fixturesDir: 'tests/fixtures',
  storyDir: 'docs/story/actives',
  requirementsDir: 'docs/requirements',
  storyPrefix: 'B',
  flows: {
    defaults: {},
    patterns: [],
  },
  phaseTools: DEFAULT_PHASE_TOOLS,
};

const _cache = new Map<string, KoalaConfig>();

/** 从 cwd 向上查找 koala.config.json，返回项目根目录 */
function resolveProjectRoot(): string {
  if (process.env.KOALA_PROJECT_ROOT) return process.env.KOALA_PROJECT_ROOT;
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'koala.config.json'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function loadConfig(projectRoot?: string): KoalaConfig {
  // 有参数用参数，没参数从 cwd 向上查找
  const root = projectRoot || resolveProjectRoot();
  if (_cache.has(root)) return _cache.get(root)!;
  const configPath = join(root, 'koala.config.json');

  let userConfig: Partial<KoalaConfig> = {};
  if (existsSync(configPath)) {
    try {
      userConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch { /* ignore parse errors */ }
  }

  const _cached: KoalaConfig = {
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
