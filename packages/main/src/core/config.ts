
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { WorkflowProfile } from './types.js';
import { resolveAuditConfig as _resolveAuditConfig, type AuditConfig } from './audit-config.js';
import { getCommandLifecyclePolicy, getCommandPolicyEntries, policyAllowedPhaseLabels } from './command-policy.js';

/**
 * audit-config extension points (B-9bd9 CHK-004):
 *   - profile defaults are taken over by `resolveAuditConfig` (light=10, balanced=5, strict=3)
 *   - project-level override file is `<projectRoot>/.koala/audit-config.json`
 *   - see packages/koala/CLAUDE.md "Framework introspection audit configuration"
 *
 * Mounted at the config entry as a re-export here; does **not** change the behavior of
 * existing profile consumers like `loadConfig` / `isCommandAllowed`; callers not using audit are unaffected.
 */
export { _resolveAuditConfig as resolveAuditConfig };
export type { AuditConfig };

export interface KoalaFlowConfig {
  defaults: Record<string, Record<string, unknown>>;
  patterns: Array<{ field: string; regex: string }>;
}

export interface KoalaConfig {
  scanRoot: string;
  /** Source subdirectory (relative to scanRoot, corresponds to tsconfig rootDir, defaults to same as scanRoot) */
  rootDir?: string;
  /** Compilation output directory (relative to project root, set to the dist path for TS projects) */
  outDir?: string;
  testsDir: string;
  fixturesDir: string;
  storyDir: string;
  requirementsDir: string;
  storyPrefix: string;
  flows: KoalaFlowConfig;
  wrappersDir?: string;
  /** Project language: js (default) or python */
  language?: 'js' | 'python';
  /** CLI test configuration */
  cli?: {
    command: string;
  };
  /** Project-level validation command; used by lattice validate when validate.ts/js is absent */
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
  /** Browser test configuration */
  browser?: {
    /** dev server startup command (e.g. "npx vite") */
    devCommand: string;
    /** WS bridge port (default 9876) */
    wsPort?: number;
  };
  /** Maximum number of trace snapshots to retain (default 5) */
  maxTraceSnapshots?: number;
  /** Whitelist of available commands per phase (key=phase name, value=array of command names, wildcard * supported) */
  phaseTools?: Record<string, string[]>;
  /** Story worktree root directory (relative to git repo root, default .worktrees) */
  worktreeDir?: string;
  /** Documentation directories scanned by doc_list (relative to project root, default ['docs', 'requirements']) */
  docDirs?: string[];
  /** Workflow profile: governance strictness configuration */
  workflow?: {
    profile?: WorkflowProfile;
  };
  /** stale-detector threshold (in minutes, falls back to DEFAULT_STALE_THRESHOLDS when missing) */
  staleThresholds?: {
    /** How long before a phase that hasn't advanced is considered stuck (default 30) */
    phaseStale?: number;
    /** How long a checklist item stuck in in_progress is considered forgotten (default 30) */
    itemStale?: number;
    /** How long since the last any koala command is considered idle (default 60) */
    idleKoala?: number;
    /** How long an open bug goes unfixed before it's considered overdue (default 1440=24h) */
    bugStale?: number;
  };
  /**
   * Lifecycle hooks — spawn shell commands at the 4 event points of koala commands.
   * Under each event, match by commandName or "*" wildcard; the value is an array of shell commands.
   * The key for onPhaseChange uses the "FROM->TO" format (or "*").
   *
   * Failures/timeouts do not block the main command; see core/hooks.ts and packages/koala/docs/guide-hooks.md for details.
   */
  hooks?: {
    preCommand?: Record<string, string[]>;
    postCommand?: Record<string, string[]>;
    onError?: Record<string, string[]>;
    onPhaseChange?: Record<string, string[]>;
  };
}

/** Default whitelist of available commands per phase */
export const DEFAULT_PHASE_TOOLS: Record<string, string[]> = {
  '*': [
    'session_brief', // read-only recovery entrypoint; must work in every phase
    'next',          // read-only single next action, shares session_brief authority rules
    'story_get', 'story_list', 'story_reconcile', 'story_discard',
    'aux_*', // All auxiliary tools: scan/detail/coverage/locate/sync/trace/diagnose/doc_list
    'checklist_get',
    'truth_*', 'gap_*', 'convergence_check',
    'story_advance', // Can be advanced in any phase (the cwd gate is responsible for protection)
    'status',        // Global: project overview (story progress + code validation)
    'doctor',        // Global: health inspection, can be queried in any phase
    'done_recover',  // Global: explicitly recover partial-DONE (first check main clean / merge-tree)
    'check',         // Global: Koala managed asset/template drift check; --apply/--upgrade explicitly syncs safe items
    'test_list',     // Global: read the test evidence snapshot, needed for both TEST and DEV troubleshooting
    'bug_list',      // Global: read bug status, convenient for reviewing the dashboard
    'finding_list',  // Global: read-only view of reviewer results, avoiding phase UX traps
    'audit',         // Global: B-9bd9 framework introspection audit (advisory, can be run in any phase)
    'verify_codex',  // Codex adapter asset/heartbeat hard evidence verification (preferably invoked via the local wrapper)
    'summary_get',   // global: read summary, available in any phase
    'grill_get',     // global: read PLAN grill planning context; does not write evidence
    'summary_set',   // global: force summary before DONE, also needed for koala short-path story
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
    'workflow_*',    // global: profile view/set/explain, available in any phase
    'background_*',  // B-45ed CHK-007: background is metadata, readable/writable in any phase
    'dispatch',      // B-9d95 CHK-004: unified dispatch entry, open in all phases (from INIT_CHECK onward)
    'reviewer_list', // B-fdcf CHK-001: query opt-in reviewer list in all phases
    'story_draft',   // B-9975: draft operations available in all phases (no story id assigned)
    'story_draft_list',
    'story_draft_discard',
    'draft_check_set',      // B-9975 CHK-002: draft check available in all phases
    'draft_issue_resolve',
    'authority_enforce_policy', // B-ea92 M1: read-only authority policy discovery, no side-effects
    'authority_enforce_runner', // Lattice Authority control-plane runner; --live still avoids provider execution
    'authority_receipt_verify', // Native Lattice Authority receipt verification; read-only local inputs
    'authority_verdict_submit', 'authority_verdict_list', 'authority_job_status', // Lattice Authority multi-host verdict/status surfaces; never mint native receipts
    'planner_*', 'story_resolve', // Natural-language planner and plannedStep context resolution surfaces
    'capability_list', // B-f26a M2: read-only host capability diagnostics for cross-host degradation
    'capability_probe', // B-cd31 CHK-002: productized single-host capability diagnostics
    'host_*', // Lattice CLI 0.3.5: host list/probe/install guidance; dry-run/read-only diagnostics only
    'lattice_config_doctor', // Lattice CLI 0.3.5: CLI-first migration/config status; no Mac App dependency
    'rollout_check', // Lattice CLI 0.3.5: read-only cross-project rollout diagnostics
    'authority_status', // Lattice CLI 0.3.5: receipt-aware status only; no evidence submission
    'conduit_*', // Lattice CLI 0.3.5: conduit status/explain; no runner provisioning or authority mutation
    'story_export', // B-cd31 CHK-003: Canonical Story v0 export surface
    'handoff_create', 'handoff_inspect', // B-cd31 CHK-004: Lattice cross-host handoff pack surface
    'handoff_accept', 'handoff_resume', // B-cd31 CHK-005: handoff accept/resume projections without authority mutation
    'handoff_receipt_submit', 'handoff_worktree_create', // B-aa98: overflow receipt/worktree diagnostic projections
    'evidence_manifest', 'evidence_inspect', // B-cd31 CHK-006: portable evidence freshness diagnostics
    'parallel_wave_create', 'parallel_wave_inspect', 'parallel_plan', // B-29b6: read-only Lattice Parallel Wave planning surfaces; no authority mutation
    'parallel_dispatch', 'parallel_status', 'parallel_merge_queue', 'parallel_report', // B-e70f: read-only Parallel Dispatch projections; no spawning or authority mutation
    'autopilot_*', // Lattice autopilot surfaces; status/doctor are read-only, run is projection-first, execute is the owner-gated bounded executor
    'dev_memory_*',  // B-1148: dev_memory_capture/list/search/preflight/finish/start declared allowedPhases:all in command-policy; phaseTools must match
  ],
  INIT: [
    'story_update', 'checklist_update',
    'init_check_set', // B-e71f CHK-003: koala-review-story-init reviewer writes init-check.json in INIT phase
    'init_check_repair', // B-95d8 CHK-001: controlled fallback—explicitly generate signed init-check.json in environments without subagent
  ],
  INIT_CHECK: [
    // story_advance internally proxies dev_start to create worktree, no separate whitelist needed
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
    'scope_question_resolve', // B-ed3e CHK-003: main agent resolves OQ
    'scope_contract_set',
    'scope_contract_init_from_plan', // B-6bfd CHK-006: seed scope contract from PLAN checklist files
  ],
  DEV: [
    'checklist_add', 'checklist_update', 'checklist_remove',
    'light_review',
    'finding_add',
    'validate', 'status', 'serve',
    'story_advance',
    'story_dispatch', // B-45ed CHK-005: main agent dispatches implementer
    'finding_dispatch', // B-45ed CHK-010: main agent dispatches finding fix (findings may appear early in DEV phase)
    'finding_cluster',  // B-8bb5: when findings already exist in DEV, allow clustering before dispatching fix
    'scope_contract_set', 'scope_contract_acknowledge',
    'scope_contract_init_from_plan', // B-6bfd CHK-006: seed scope contract from PLAN checklist files
    'guard_session_start', // B-6bfd CHK-004: start scope-guard session during implementation
  ],
  REVIEW: [
    'review_run_start',
    'finding_add', 'finding_list', 'finding_resolve', 'finding_dismiss',
    'review_pass_set',
    'understanding_get', 'decision_get',
    'finding_dispatch', // B-45ed CHK-010: main agent dispatches finding fix
    'finding_cluster',  // B-9d95 CHK-005: auto/merge/split clustering
    'validate', 'status',
    'bug_report', 'bug_update', 'bug_list',
    'delivery_check_set', 'delivery_waiver_add', // delivery reviewer writes signature/waiver in REVIEW phase, consumed by TEST→DONE gate
    'story_advance',
    'scope_contract_acknowledge',
    'guard_session_start', // B-6bfd CHK-004: start scope-guard session during review
  ],
  TEST: [
    'finding_list', 'finding_cluster', // B-9d95 CHK-005: cluster view also queryable in TEST
    'validate', 'evaluate', 'evaluate_save',
    'bug_report', 'bug_update', 'bug_list', 'bug_analyze',
    'delivery_check_set', 'delivery_waiver_add', // B-b089: delivery reviewer writes signature during TEST phase
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

/** Search upward from cwd for koala.config.json, return the project root directory */
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
  // Use the argument if provided, otherwise search upward from cwd
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

/** Reset cache (for testing) */
export function resetConfigCache(): void {
  _cache.clear();
}

/**
 * Determine whether a command is in the whitelist for the specified phase.
 * Supports wildcards: 'truth_*' matches truth_scan / truth_extract, etc.
 * Commands in the '*' key are available for all phases.
 */
export function isCommandAllowed(cmd: string, phase: string, phaseTools?: Record<string, string[]>): boolean {
  if (ALWAYS_ALLOWED_READ_ONLY_COMMANDS.has(cmd)) return true;
  if (!commandAllowedByLifecyclePolicy(cmd, phase)) return false;
  if (phaseTools !== undefined && !isPhaseToolsRecord(phaseTools)) return true; // malformed config falls back to policy ceiling only
  const pt = phaseTools || DEFAULT_PHASE_TOOLS;
  return commandAllowedByPatterns(cmd, phase, pt);
}

/**
 * Get the list of all allowed command patterns for the specified phase.
 */
export function getAllowedPatterns(phase: string, phaseTools?: Record<string, string[]>): string[] {
  const pt = isPhaseToolsRecord(phaseTools) ? phaseTools : DEFAULT_PHASE_TOOLS;
  return Array.from(new Set([...ALWAYS_ALLOWED_READ_ONLY_COMMANDS, ...(pt['*'] || []), ...(pt[phase] || [])]))
    .filter(pattern => ALWAYS_ALLOWED_READ_ONLY_COMMANDS.has(pattern) || patternAllowedByLifecyclePolicy(pattern, phase));
}
