import { createHash } from 'node:crypto';
import type {
  JobPlan,
  PlannedStep,
  PlannerStoreLike,
} from './planner.js';
import { sourceManifestDigest } from './planner.js';
import {
  BUDGET_EXCEEDED_STOP_REASON,
  createBudgetMeter,
  resolveBudgetLimits,
} from './budget-meter.js';
import type { BudgetReport } from './budget-meter.js';
import {
  claudeCliAvailable,
  claudeNoninteractiveAuthAvailable,
  runBoundedClaudeProvider,
  CLAUDE_NONINTERACTIVE_AUTH_ENV_VARS,
  CLAUDE_CLI_BINARY,
} from '../providers/claude-cli.js';
import {
  codexCliAvailable,
  runBoundedCodexProvider,
  CODEX_CLI_BINARY,
} from '../providers/codex-cli.js';
import {
  geminiCliAvailable,
  runBoundedGeminiProvider,
  GEMINI_CLI_BINARY,
} from '../providers/gemini-cli.js';
import type {
  BoundedProviderExecutor,
  BoundedProviderName,
  ProviderExecResult,
} from '../providers/types.js';
import {
  normalizeRepairRetryPolicy,
  runRepairRetryLoop,
  type RepairProviderOutcome,
  type RepairRetryHooks,
  type RepairRetryLoopResult,
  type RepairRetryPolicy,
  type ValidationProbeResult,
} from './repair-retry-loop.js';
import {
  type WorktreePolicyView,
  type WorktreeResolution,
  type GitRunner,
  type GitStatusEvidence,
  type WorktreeStopSummary,
  resolveWorktreePolicy,
  resolveAuthoritativeWorktree,
  defaultGitRunner,
  captureGitStatus,
  evaluateWorktreePreflight,
  evaluateForbiddenEdits,
  buildWorktreeStopSummary,
  WORKTREE_STOP_REASONS,
} from './worktree-policy.js';

export type PlannedStepExecutionStatus = 'passed' | 'failed' | 'blocked' | 'skipped';
export type PlannedStepsExecutionStatus = 'done' | 'blocked' | 'failed';

export type ProviderName = 'fake' | 'codex' | 'claude' | 'gemini';

/**
 * Provider policy consumed by the executor. It is read defensively from the
 * JobPlan (the planner does not yet emit one), so a missing or malformed policy
 * collapses to DEFAULT_FAIL_CLOSED_PROVIDER_POLICY: real providers stay disabled.
 *
 * `provider.fake` is intentionally NOT gated by this policy — it is deterministic,
 * fixtures-only, and always marks itself production-authority-ineligible.
 */
export interface ProviderPolicy {
  primaryProvider: ProviderName;
  /** Real providers (codex/claude) only run when explicitly listed here. */
  allowedProviders: ProviderName[];
  fallbackProviders: ProviderName[];
  productionDoneProviders: BoundedProviderName[];
  allowFakeProviderForProductionDone: boolean;
  /** Env var names allowed to carry provider credentials. */
  credentialsEnvAllowlist: string[];
  /** Opaque references to externally-managed secrets; never carry secret values. */
  secretRefs: string[];
  providerAvailability: 'fail_closed';
}

export const DEFAULT_FAIL_CLOSED_PROVIDER_POLICY: ProviderPolicy = {
  primaryProvider: 'fake',
  allowedProviders: ['fake'],
  fallbackProviders: [],
  productionDoneProviders: [],
  allowFakeProviderForProductionDone: false,
  credentialsEnvAllowlist: [],
  secretRefs: [],
  providerAvailability: 'fail_closed',
};

export interface PlannedStepExecution {
  stepId: string;
  type: PlannedStep['type'];
  status: PlannedStepExecutionStatus;
  evidenceBinding: string;
  evidenceDigest: string;
  startedAt: string;
  endedAt: string;
  attempts: number;
  reason?: string;
  summary: Record<string, unknown>;
}

export interface PlannedStepsExecutionResult {
  schemaVersion: 'lattice.planned_steps_execution.v1';
  plannerRunId: string;
  storyId: string;
  mode: JobPlan['mode'];
  until: JobPlan['until'];
  developmentWorkflow: JobPlan['developmentWorkflow'];
  status: PlannedStepsExecutionStatus;
  localDone: boolean;
  authorityDone: boolean;
  fullAuthorityDone: boolean;
  receiptVerified: boolean;
  multiHostVerified: boolean;
  plannedStepsDigest: string;
  providerPolicyDigest: string;
  executedStepCount: number;
  evidenceRefs: string[];
  failedStepId?: string;
  stopReason: string;
  nextActions: string[];
  /**
   * Token/cost/time budget meter snapshot (X6 + §B16 `budgetUsage`). `executePlannedSteps`
   * always populates it; optional only so synthetic/legacy result literals stay valid.
   * When `exceeded` is true the run stopped `blocked` with `stopReason=budget_exceeded`
   * (fail-closed: budget exhaustion never triggers provider fallback or extra waves).
   */
  budgetUsage?: BudgetReport;
  steps: PlannedStepExecution[];
  /**
   * Source-aligned redevelopment evidence summary, present only when
   * developmentWorkflow === 'source_aligned_redevelopment'. `doneEligible`
   * requires verified target-runnable parity plus zero open gaps, so the
   * deterministic projection is never redevelopment-DONE-eligible by itself.
   * See `C2a-projection` in the live-integration requirements doc.
   */
  redevelopment?: RedevelopmentExecutionSummary;
  /**
   * Fail-closed worktree-safety stop summary (§B2 / M7 / M9 / M11). Present only when
   * a mutating provider step was blocked by worktree enforcement (unresolved
   * authoritative worktree, missing git status evidence, dirty worktree, or a
   * forbidden-path edit). Printable and uploadable as the run's final stop summary.
   */
  worktreeStopSummary?: WorktreeStopSummary;
}

export interface RedevelopmentExecutionSummary {
  sourceLanguage: string;
  targetLanguage: string;
  sourceManifestDigest: string;
  targetManifestDigest: string;
  sourceManifestRecordCount: number;
  alignmentEntryCount: number;
  mappedToGapCount: number;
  adapterUnavailable: string[];
  targetRunnableEvidenceCaptured: boolean;
  targetParityVerified: boolean;
  gapCount: number;
  doneEligible: boolean;
}

export interface ExecutePlannedStepsOptions {
  root: string;
  store: PlannerStoreLike;
  jobPlan: JobPlan;
  now?: () => Date;
  maxSteps?: number;
  /** Local environment used for provider availability + credential preflight. */
  env?: NodeJS.ProcessEnv;
  /** Injectable bounded provider executor (tests stub this; default spawns real CLIs). */
  providerExecutor?: BoundedProviderExecutor;
  /**
   * Optional synchronous per-step hook (M8 evidence streaming seam). Invoked once
   * per executed step, in execution order, immediately after the step's record is
   * produced. It MUST NOT perform network I/O — the executor stays deterministic
   * and synchronous, so async evidence upload runs over the returned `steps[]`
   * (see `core/evidence-uploader.ts`). The hook never influences step results.
   */
  evidenceRecorder?: (step: PlannedStepExecution, index: number) => void;
  /**
   * Reduce-only budget override (X6 + §B9): CLI safety limits may only TIGHTEN the
   * JobPlan's `budgetPolicy`, never expand it. Each `<= 0` field means "no override
   * for this dimension". Wall-clock falls back to `stopPolicy.maxWallClockMs` when the
   * plan carries no `budgetPolicy`.
   */
  budget?: Partial<import('./budget-meter.js').BudgetLimits>;
  /**
   * Injectable git runner for worktree-safety enforcement (§B2 / M7 / M9 / M11).
   * Defaults to the real `git` binary. Tests stub this so worktree preflight/postflight
   * run deterministically without a real repository.
   */
  gitRunner?: GitRunner;
}

const MAX_PLANNED_STEP_EXECUTION_HARD_CAP = 100;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function boundedInteger(value: unknown, fallback: number, cap: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return Math.min(fallback, cap);
  return Math.min(Math.floor(value), cap);
}

function operation(step: PlannedStep): string {
  const op = step.args.operation;
  return typeof op === 'string' ? op : step.type;
}

function plannedStepsDigestOf(jobPlan: JobPlan): string {
  return jobPlan.localRunPlan?.plannedStepsDigest
    ?? digest(jobPlan.plannedSteps);
}

// --- Provider policy + bounded execution -------------------------------------

function isProviderName(value: unknown): value is ProviderName {
  return value === 'fake' || value === 'codex' || value === 'claude' || value === 'gemini';
}

function isRealProvider(value: unknown): value is BoundedProviderName {
  return value === 'codex' || value === 'claude' || value === 'gemini';
}

/** Defensive normalization (Handler encoding convention): never trust the raw shape. */
function resolveProviderPolicy(jobPlan: JobPlan): ProviderPolicy {
  const raw = (jobPlan as { providerPolicy?: Partial<ProviderPolicy> }).providerPolicy;
  if (!raw || typeof raw !== 'object') return DEFAULT_FAIL_CLOSED_PROVIDER_POLICY;
  const names = (v: unknown): ProviderName[] => (Array.isArray(v) ? v.filter(isProviderName) : []);
  const reals = (v: unknown): BoundedProviderName[] => (Array.isArray(v) ? v.filter(isRealProvider) : []);
  return {
    primaryProvider: isProviderName(raw.primaryProvider) ? raw.primaryProvider : 'fake',
    allowedProviders: names(raw.allowedProviders),
    fallbackProviders: names(raw.fallbackProviders),
    productionDoneProviders: reals(raw.productionDoneProviders),
    allowFakeProviderForProductionDone: raw.allowFakeProviderForProductionDone === true,
    credentialsEnvAllowlist: Array.isArray(raw.credentialsEnvAllowlist)
      ? raw.credentialsEnvAllowlist.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      : [],
    secretRefs: Array.isArray(raw.secretRefs)
      ? raw.secretRefs.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      : [],
    providerAvailability: 'fail_closed',
  };
}

const PROVIDER_BINARY: Record<BoundedProviderName, string> = {
  codex: CODEX_CLI_BINARY,
  claude: CLAUDE_CLI_BINARY,
  gemini: GEMINI_CLI_BINARY,
};

/**
 * A provider credential is "configured & present" when credentials come from
 * either source the policy allows (B3b): allowlisted env vars OR opaque secretRefs.
 * When an allowlist is declared, every listed var must resolve non-empty. A
 * secretRef-only policy (no env allowlist) is configured because the secret is
 * referenced externally and resolved by the provider's own auth mechanism — the
 * value is never inlined here. Empty on both sides → credential_unavailable.
 */
function credentialsAvailable(policy: ProviderPolicy, env: NodeJS.ProcessEnv): boolean {
  if (policy.credentialsEnvAllowlist.length === 0) return policy.secretRefs.length > 0;
  return policy.credentialsEnvAllowlist.every(name => {
    const value = env[name];
    return typeof value === 'string' && value.trim() !== '';
  });
}

/** Redacted env projection: only minimal runtime keys + explicitly allowlisted credentials reach the child. */
function redactedProviderEnv(baseEnv: NodeJS.ProcessEnv, allowlist: string[]): NodeJS.ProcessEnv {
  const runtimeKeys = ['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'LOGNAME'];
  const out: NodeJS.ProcessEnv = {};
  for (const key of runtimeKeys) {
    if (baseEnv[key] !== undefined) out[key] = baseEnv[key];
  }
  for (const key of allowlist) {
    if (baseEnv[key] !== undefined) out[key] = baseEnv[key];
  }
  return out;
}

function defaultProviderAvailable(provider: BoundedProviderName, env: NodeJS.ProcessEnv): boolean {
  // Each real provider resolves availability through its own preflight seam
  // (claude-cli.ts / codex-cli.ts / gemini-cli.ts), so the probe stays symmetric
  // and centralized.
  if (provider === 'claude') return claudeCliAvailable(env);
  if (provider === 'gemini') return geminiCliAvailable(env);
  return codexCliAvailable(env);
}

/**
 * Default bounded executor: each real provider has a dedicated bounded runner
 * (claude-cli.ts / codex-cli.ts / gemini-cli.ts) that performs a stdin-closed
 * argv spawn and captures stdout/stderr as digests + byte counts only — raw
 * output is never surfaced, so a transcript can neither leak credentials nor
 * become gate evidence.
 */
const defaultBoundedProviderExecutor: BoundedProviderExecutor = {
  available: defaultProviderAvailable,
  run(request) {
    if (request.provider === 'claude') return runBoundedClaudeProvider(request);
    if (request.provider === 'gemini') return runBoundedGeminiProvider(request);
    return runBoundedCodexProvider(request);
  },
};

interface ProviderExecContext {
  root: string;
  policy: ProviderPolicy;
  env: NodeJS.ProcessEnv;
  executor: BoundedProviderExecutor;
}

function executionRecord(
  step: PlannedStep,
  status: PlannedStepExecutionStatus,
  startedAt: string,
  endedAt: string,
  attempts: number,
  summary: Record<string, unknown>,
  reason?: string,
): PlannedStepExecution {
  return {
    stepId: step.stepId,
    type: step.type,
    status,
    evidenceBinding: step.evidenceBinding,
    evidenceDigest: digest({ stepId: step.stepId, status, summary, reason }),
    startedAt,
    endedAt,
    attempts,
    ...(reason ? { reason } : {}),
    summary,
  };
}

/**
 * Execute a real bounded provider step (codex/claude).
 *
 * Fails closed BEFORE any spawn when the provider is not policy-enabled
 * (`disabled`), the request is not a bounded argv (`provider_request_invalid`),
 * the CLI is unavailable (`provider_unavailable`), or no credential is configured
 * (`credential_unavailable`). On execution it captures stdout/stderr/exit/duration
 * as digests and NEVER promotes provider success into validation, evidence, or DONE.
 */
function executeRealProviderStep(
  step: PlannedStep,
  provider: BoundedProviderName,
  ctx: ProviderExecContext,
  startedAt: string,
  now: () => Date,
): PlannedStepExecution {
  const block = (reason: string, summary: Record<string, unknown>) =>
    executionRecord(step, 'blocked', startedAt, now().toISOString(), 1, summary, reason);

  // Gate 1 — explicit policy enablement.
  if (!ctx.policy.allowedProviders.includes(provider)) {
    return block('disabled', {
      provider,
      allowedProviders: ctx.policy.allowedProviders,
      note: 'real provider execution requires explicit providerPolicy.allowedProviders enablement',
      validationSatisfied: false,
      providerProseAcceptedAsEvidence: false,
      productionAuthorityEligible: false,
    });
  }

  // Gate 2 — bounded argv only; shell strings are rejected.
  const argv = Array.isArray(step.args.argv)
    ? step.args.argv.filter((a): a is string => typeof a === 'string')
    : null;
  if (!argv || argv.length === 0 || typeof step.args.shell === 'string') {
    return block('provider_request_invalid', {
      provider,
      note: 'provider step must declare a bounded argv array; shell strings are rejected',
      validationSatisfied: false,
    });
  }

  // Gate 3 — availability preflight (B3a).
  if (!ctx.executor.available(provider, ctx.env)) {
    return block('provider_unavailable', {
      provider,
      binary: PROVIDER_BINARY[provider],
      note: 'provider CLI is not available on this host; availability is a preflight requirement and no alternate provider is claimed automatically',
      validationSatisfied: false,
    });
  }

  // Gate 4 — credentials preflight (B3b); unattended mode never prompts for a secret.
  if (!credentialsAvailable(ctx.policy, ctx.env)) {
    return block('credential_unavailable', {
      provider,
      credentialsEnvAllowlist: ctx.policy.credentialsEnvAllowlist,
      secretRefCount: ctx.policy.secretRefs.length,
      note: 'no configured provider credential is present; credentials come only from providerPolicy.credentialsEnvAllowlist or secretRefs',
      validationSatisfied: false,
    });
  }

  // Gate 4b — Claude noninteractive auth preflight (B3b). Bounded Claude execution
  // must authenticate through a recognized credential that the redacted env carries
  // to the CLI; it must never fall back to an interactive login in unattended mode.
  // A secretRef-only policy that resolves no recognized auth env fails closed here
  // rather than hanging on a login prompt.
  if (provider === 'claude' && !claudeNoninteractiveAuthAvailable(ctx.env, ctx.policy.credentialsEnvAllowlist)) {
    return block('noninteractive_auth_unavailable', {
      provider,
      recognizedAuthEnvVars: [...CLAUDE_NONINTERACTIVE_AUTH_ENV_VARS],
      note: 'Claude bounded execution requires a recognized noninteractive auth credential (allowlisted AND present); it must not fall back to interactive login',
      validationSatisfied: false,
    });
  }

  // Bounded execution with explicit cwd, timeout, and attempt cap; capture digests only.
  const result: ProviderExecResult = ctx.executor.run({
    provider,
    argv,
    cwd: ctx.root,
    timeoutMs: step.timeoutMs,
    maxAttempts: step.maxAttempts,
    env: redactedProviderEnv(ctx.env, ctx.policy.credentialsEnvAllowlist),
  });

  const evidence: Record<string, unknown> = {
    provider,
    ...(result.model ? { model: result.model } : {}),
    argvDigest: result.argvDigest,
    exitCode: result.exitCode,
    stdoutDigest: result.stdoutDigest,
    stderrDigest: result.stderrDigest,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    durationMs: result.durationMs,
    attempts: result.attempts,
    cwd: ctx.root,
    timeoutMs: step.timeoutMs,
    maxAttempts: step.maxAttempts,
    // Env redaction summary — credential KEY NAMES / counts only, never values. The
    // child saw only the runtime keys + these allowlisted credentials; everything
    // else was stripped by redactedProviderEnv.
    envRedacted: true,
    credentialEnvKeysProjected: ctx.policy.credentialsEnvAllowlist.filter(
      name => typeof ctx.env[name] === 'string' && (ctx.env[name] as string).trim() !== '',
    ),
    secretRefCount: ctx.policy.secretRefs.length,
    // Hard invariants — provider work is never validation, prose evidence, or DONE.
    validationSatisfied: false,
    providerProseAcceptedAsEvidence: false,
    productionAuthorityEligible: false,
    productionDoneProvider: ctx.policy.productionDoneProviders.includes(provider),
  };

  if (result.spawnError) {
    return block('provider_unavailable', {
      ...evidence,
      note: 'provider CLI could not be spawned at execution time',
    });
  }
  if (result.timedOut) {
    // A single bounded attempt that times out is a retryable provider_timeout.
    // When the bounded executor has already spent more than one attempt and every
    // one timed out, the step made no progress across its retry budget — that is a
    // blocked `no_progress` stop, not an endlessly retryable failure. This is the
    // minimal single-pass projection of retryPolicy.maxNoProgressIterations; the
    // full outer repair-iteration no-progress counter remains a Stage B gap (see
    // the requirements status ledger).
    if (result.attempts > 1) {
      return executionRecord(step, 'blocked', startedAt, now().toISOString(), result.attempts, {
        ...evidence,
        note: 'provider retry budget exhausted with no progress (every bounded attempt timed out)',
      }, 'no_progress');
    }
    return executionRecord(step, 'failed', startedAt, now().toISOString(), result.attempts, {
      ...evidence,
      note: 'provider execution exceeded its bounded timeout',
    }, 'provider_timeout');
  }
  if (result.exitCode !== 0) {
    return executionRecord(step, 'failed', startedAt, now().toISOString(), result.attempts, evidence, 'provider_failed');
  }
  return executionRecord(step, 'passed', startedAt, now().toISOString(), result.attempts, evidence);
}

// --- Source-aligned redevelopment evidence (deterministic projection) --------
//
// Language-pair-agnostic: availability is keyed by a single canonical language id
// (never a source->target pair). In a live deployment this fixed known set is
// replaced by the registry that languageAdapterPolicy.adapterRegistryRef
// resolves; here it makes adapter availability a mechanical decision rather than
// provider prose. The projection emits the doc's neutral evidence shapes but
// never claims target parity it cannot back with a real target build/test.

const KNOWN_LANGUAGE_ADAPTERS = new Set<string>([
  'typescript', 'javascript', 'python', 'rust', 'go', 'swift', 'kotlin', 'java', 'csharp', 'ruby', 'cpp',
]);

const MAX_EMBEDDED_MANIFEST_RECORDS = 25;

interface RedevSpec {
  sourceRepo?: string;
  targetProjectName?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  renameMap?: Record<string, string>;
  includedPaths?: string[];
  excludedPaths?: string[];
  languageAdapterPolicy?: Record<string, unknown>;
  semanticMappingPolicy?: Record<string, unknown>;
  parityOraclePolicy?: Record<string, unknown>;
}

interface RedevOpResult {
  status: 'passed' | 'blocked';
  reason?: string;
  summary: Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

function redevSpecOf(step: PlannedStep): RedevSpec {
  const raw = step.args.sourceAlignedRedevelopmentSpec;
  return raw && typeof raw === 'object' ? raw as RedevSpec : {};
}

function policyField(policy: Record<string, unknown> | undefined, key: string): unknown {
  return policy && typeof policy === 'object' ? policy[key] : undefined;
}

function requiredAdaptersOf(spec: RedevSpec): string[] {
  const fromPolicy = asStringArray(policyField(spec.languageAdapterPolicy, 'requiredAdapters'));
  const required = fromPolicy.length > 0
    ? fromPolicy
    : [spec.sourceLanguage, spec.targetLanguage].filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  return required.map(id => id.toLowerCase());
}

function adapterAvailability(required: string[]): { available: string[]; unavailable: string[] } {
  const available: string[] = [];
  const unavailable: string[] = [];
  for (const id of required) (KNOWN_LANGUAGE_ADAPTERS.has(id) ? available : unavailable).push(id);
  return { available, unavailable };
}

function priorSummaryByOp(priorSteps: PlannedStepExecution[], op: string): Record<string, unknown> | undefined {
  return priorSteps.find(s => s.summary.operation === op)?.summary;
}

/**
 * Execute a source-aligned redevelopment `lattice.command` operation as a
 * deterministic evidence projection. Pair-agnostic, prose is never evidence, and
 * target parity is never asserted without target-runnable evidence (which the
 * projection cannot capture, so it records `not_run` + a parity gap).
 */
function executeRedevelopmentOperation(root: string, op: string, step: PlannedStep, priorSteps: PlannedStepExecution[]): RedevOpResult {
  const spec = redevSpecOf(step);
  const base = { operation: op, deterministicProjection: true, providerProseAcceptedAsEvidence: false };

  if (op === 'language.resolve_adapters') {
    const required = requiredAdaptersOf(spec);
    const { available, unavailable } = adapterAvailability(required);
    const behavior = policyField(spec.languageAdapterPolicy, 'adapterUnavailableBehavior') === 'scoped_gap' ? 'scoped_gap' : 'block';
    const resolvedAdapters = available.map(id => ({
      languageId: id,
      adapterVersion: 'projection-v1',
      adapterDigest: digest({ languageId: id, registry: 'known-language-adapters', adapterVersion: 'projection-v1' }),
    }));
    if (unavailable.length > 0) {
      if (behavior === 'block') {
        return {
          status: 'blocked',
          reason: 'adapter_unavailable',
          summary: { ...base, requiredAdapters: required, available, unavailable, adapterUnavailableBehavior: behavior, note: 'missing language adapter; redevelopment blocks before manifest extraction, provider work, or target mutation' },
        };
      }
      const gapList = unavailable.map((id, i) => ({
        gapId: `gap-adapter-${i + 1}`,
        kind: 'adapter_unavailable_scoped_gap',
        surface: id,
        rationale: `no language adapter registered for ${id}; scoped_gap narrows the run to available surfaces and records the unsupported one`,
        evidenceRefs: [],
      }));
      return {
        status: 'passed',
        summary: { ...base, requiredAdapters: required, available, unavailable, adapterUnavailableBehavior: 'scoped_gap', scopedGap: true, resolvedAdapters, gapList },
      };
    }
    return { status: 'passed', summary: { ...base, requiredAdapters: required, available, unavailable, adapterUnavailableBehavior: behavior, scopedGap: false, resolvedAdapters } };
  }

  if (op === 'source.extract_manifest') {
    const manifest = sourceManifestDigest(root, spec.sourceRepo ?? '', asStringArray(spec.includedPaths), asStringArray(spec.excludedPaths));
    if (manifest.blocked) {
      return { status: 'blocked', reason: manifest.blockedReason ?? 'source_manifest_unavailable', summary: { ...base, side: 'source', sourceRepo: spec.sourceRepo ?? '' } };
    }
    const languageId = (spec.sourceLanguage ?? '').toLowerCase();
    const records = manifest.files.slice(0, MAX_EMBEDDED_MANIFEST_RECORDS).map((file, i) => ({
      manifestRecordId: `src-${i + 1}`,
      languageId,
      sourcePath: file.path,
      moduleId: file.path.replace(/\.[^./]+$/, '').replace(/\//g, '::'),
      symbolId: null,
      kind: 'module',
      visibility: 'unknown',
      signatureShape: null,
      runtimeBoundary: null,
      dependencyRefs: [],
      sourceLocation: file.path,
      // File/module identity is deterministic; symbol shape needs a live adapter parser.
      extractionConfidence: 'partial',
    }));
    return {
      status: 'passed',
      summary: { ...base, side: 'source', languageId, sourceManifestDigest: manifest.digest, manifestRecordCount: manifest.files.length, manifestRecords: records, recordsTruncated: manifest.files.length > records.length, extractionConfidence: 'partial', symbolExtraction: 'not_performed_in_projection' },
    };
  }

  if (op === 'target.extract_manifest') {
    const languageId = (spec.targetLanguage ?? '').toLowerCase();
    return {
      status: 'passed',
      summary: { ...base, side: 'target', languageId, targetManifestDigest: digest({ target: spec.targetProjectName ?? '', records: [] }), manifestRecordCount: 0, manifestRecords: [], extractionConfidence: 'unknown', targetManifestAvailable: false, note: 'target project is not yet built in the deterministic projection; there is no target manifest to extract' },
    };
  }

  if (op === 'source.compare_alignment') {
    const srcSummary = priorSummaryByOp(priorSteps, 'source.extract_manifest');
    const tgtSummary = priorSummaryByOp(priorSteps, 'target.extract_manifest');
    const srcRecords = Array.isArray(srcSummary?.manifestRecords) ? srcSummary!.manifestRecords as Array<{ moduleId?: string }> : [];
    const sourceManifestDigestRef = typeof srcSummary?.sourceManifestDigest === 'string' ? srcSummary!.sourceManifestDigest : '';
    const targetManifestAvailable = tgtSummary?.targetManifestAvailable === true;
    const allowedMappingKinds = asStringArray(policyField(spec.semanticMappingPolicy, 'allowedMappingKinds'));
    const rationale = targetManifestAvailable
      ? 'target manifest available but the deterministic projection does not assert structural alignment without a live adapter'
      : 'target manifest unavailable in the deterministic projection; 1:1 alignment cannot be asserted, so the source module is mapped_to_gap';
    const moduleAlignmentMap = srcRecords.map((rec, i) => ({
      sourceRef: rec.moduleId ?? `src-${i + 1}`,
      targetRefs: [] as string[],
      kind: 'mapped_to_gap' as const,
      rationale,
      evidenceRefs: sourceManifestDigestRef ? [sourceManifestDigestRef] : [],
      gapRef: `gap-align-${i + 1}`,
      derivedFrom: 'manifest_extraction' as const,
    }));
    const gapList = moduleAlignmentMap.map(entry => ({ gapId: entry.gapRef, kind: 'unverified_alignment', surface: entry.sourceRef, rationale: entry.rationale, evidenceRefs: entry.evidenceRefs }));
    return {
      status: 'passed',
      summary: {
        ...base,
        allowedMappingKinds,
        supportedMappingKinds: ['1:1', '1:N', 'N:1', 'mapped_to_gap'],
        moduleAlignmentMap,
        functionAlignmentMap: [],
        alignmentEntryCount: moduleAlignmentMap.length,
        mappedToGapCount: moduleAlignmentMap.length,
        mappingsDerivedFrom: 'manifest_extraction',
        gapList,
      },
    };
  }

  if (op === 'source.verify_rename_map') {
    const renameMap = spec.renameMap && typeof spec.renameMap === 'object' ? spec.renameMap : {};
    return { status: 'passed', summary: { ...base, renameMapDigest: digest(renameMap), renameCount: Object.keys(renameMap).length, licenseLaunderingGuard: 'identifier/file renames must not remove or alter required license notices' } };
  }

  if (op === 'source.build_parity_oracles') {
    const allowedOracleKinds = asStringArray(policyField(spec.parityOraclePolicy, 'allowedOracleKinds'));
    const behaviorParityChecks = allowedOracleKinds.map((kind, i) => ({ checkId: `parity-${i + 1}`, oracleKind: kind, targetRunnable: true, status: 'planned' as const, evidenceRefs: [] as string[] }));
    return { status: 'passed', summary: { ...base, behaviorParityChecks, parityCheckCount: behaviorParityChecks.length } };
  }

  if (op === 'target.run_parity_oracles') {
    const built = priorSummaryByOp(priorSteps, 'source.build_parity_oracles');
    const plannedChecks = Array.isArray(built?.behaviorParityChecks) ? built!.behaviorParityChecks as Array<{ checkId: string; oracleKind: string }> : [];
    // Honesty boundary: requiresTargetRunnableEvidence defaults to true.
    const requiresTargetRunnableEvidence = policyField(spec.parityOraclePolicy, 'requiresTargetRunnableEvidence') !== false;
    const behaviorParityChecks = plannedChecks.map(check => ({ ...check, targetRunnable: true, status: 'not_run' as const, evidenceRefs: [] as string[] }));
    const gapList = behaviorParityChecks.map((check, i) => ({ gapId: `gap-parity-${i + 1}`, kind: 'target_runnable_parity_missing', surface: check.oracleKind, rationale: 'deterministic projection runs no target build/test, so no target-runnable parity evidence is captured', evidenceRefs: [] }));
    return {
      status: 'passed',
      summary: { ...base, behaviorParityChecks, requiresTargetRunnableEvidence, targetRunnableEvidenceCaptured: false, targetParityVerified: false, gapList, note: 'projection cannot prove target parity; real target build/test evidence is required before redevelopment DONE' },
    };
  }

  if (op === 'source.verify_license_notices') {
    const manifest = sourceManifestDigest(root, spec.sourceRepo ?? '', [], asStringArray(spec.excludedPaths));
    const licenseNoticeRefs = manifest.blocked
      ? []
      : manifest.files.filter(file => /(^|\/)(LICEN[SC]E|COPYING|NOTICE)(\.|$)/i.test(file.path)).map(file => ({ path: file.path, sha256: file.sha256 }));
    return { status: 'passed', summary: { ...base, licenseNoticeRefs, licenseNoticeCount: licenseNoticeRefs.length, note: licenseNoticeRefs.length > 0 ? 'source license/notice files detected and referenced by digest' : 'no top-level license/notice file detected in projection scope' } };
  }

  if (op === 'source.record_gaps') {
    const gapList: unknown[] = [];
    for (const prior of priorSteps) {
      if (prior.summary.operation === 'source.record_gaps') continue;
      if (Array.isArray(prior.summary.gapList)) gapList.push(...prior.summary.gapList as unknown[]);
    }
    return { status: 'passed', summary: { ...base, gapList, gapCount: gapList.length, sourceOnlyUntranslatableRoutedWithoutRepair: true, note: 'source-only / untranslatable surfaces are routed to gaps at manifest/mapping time and never enqueue repair attempts' } };
  }

  // Unknown source/target/language operation: bounded deterministic pass.
  return { status: 'passed', summary: { ...base } };
}

/**
 * Aggregate the redevelopment evidence fields from executed steps. `doneEligible`
 * is intentionally strict: verified target parity AND zero open gaps AND no
 * unavailable adapter. The projection never satisfies it, mirroring how a
 * projected standard run keeps localDone/authorityDone false.
 */
function buildRedevelopmentSummary(jobPlan: JobPlan, steps: PlannedStepExecution[]): RedevelopmentExecutionSummary | undefined {
  if (jobPlan.developmentWorkflow !== 'source_aligned_redevelopment') return undefined;
  const byOp = (op: string) => steps.find(s => s.summary.operation === op)?.summary;
  const adapters = byOp('language.resolve_adapters');
  const srcManifest = byOp('source.extract_manifest');
  const tgtManifest = byOp('target.extract_manifest');
  const alignment = byOp('source.compare_alignment');
  const parity = byOp('target.run_parity_oracles');

  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const adapterUnavailable = Array.isArray(adapters?.unavailable) ? adapters!.unavailable as string[] : [];

  let gapCount = 0;
  for (const step of steps) {
    if (step.summary.operation === 'source.record_gaps') continue; // record_gaps re-aggregates earlier gaps
    if (Array.isArray(step.summary.gapList)) gapCount += (step.summary.gapList as unknown[]).length;
  }

  const targetRunnableEvidenceCaptured = parity?.targetRunnableEvidenceCaptured === true;
  const targetParityVerified = parity?.targetParityVerified === true;
  return {
    sourceLanguage: str(srcManifest?.languageId),
    targetLanguage: str(tgtManifest?.languageId),
    sourceManifestDigest: str(srcManifest?.sourceManifestDigest),
    targetManifestDigest: str(tgtManifest?.targetManifestDigest),
    sourceManifestRecordCount: num(srcManifest?.manifestRecordCount),
    alignmentEntryCount: num(alignment?.alignmentEntryCount),
    mappedToGapCount: num(alignment?.mappedToGapCount),
    adapterUnavailable,
    targetRunnableEvidenceCaptured,
    targetParityVerified,
    gapCount,
    doneEligible: targetParityVerified && gapCount === 0 && adapterUnavailable.length === 0,
  };
}

function executeOneStep(
  root: string,
  store: PlannerStoreLike,
  jobPlan: JobPlan,
  step: PlannedStep,
  priorSteps: PlannedStepExecution[],
  now: () => Date,
  providerCtx: ProviderExecContext,
): PlannedStepExecution {
  const startedAt = now().toISOString();
  const op = operation(step);
  const pass = (summary: Record<string, unknown>) =>
    executionRecord(step, 'passed', startedAt, now().toISOString(), 1, summary);
  const block = (reason: string, summary: Record<string, unknown> = {}) =>
    executionRecord(step, 'blocked', startedAt, now().toISOString(), 1, summary, reason);

  if (step.type === 'provider.codex' || step.type === 'provider.claude') {
    const provider: BoundedProviderName = step.type === 'provider.codex' ? 'codex' : 'claude';
    return executeRealProviderStep(step, provider, providerCtx, startedAt, now);
  }

  if (step.type === 'provider.fake') {
    // Fixtures-only token/cost seam: a fake provider step may declare a deterministic
    // `tokensUsed` / `costUnits` so the budget meter (core/budget-meter.ts) can be
    // exercised over the real executor path without enabling a real provider. Real
    // provider token/cost reporting remains a Stage B gap.
    const tokensUsed = typeof step.args.tokensUsed === 'number' ? step.args.tokensUsed : undefined;
    const costUnits = typeof step.args.costUnits === 'number' ? step.args.costUnits : undefined;
    return pass({
      provider: 'fake',
      transcriptHash: digest({
        storyId: jobPlan.storyId,
        purpose: step.purpose,
        args: step.args,
      }),
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      ...(costUnits !== undefined ? { costUnits } : {}),
      productionAuthorityEligible: false,
    });
  }

  if (step.type === 'lattice.command') {
    if (op === 'story.resolve') {
      if (!store.storyExists(jobPlan.storyId)) {
        return block('story_not_found', { storyId: jobPlan.storyId });
      }
      const story = store.readStory(jobPlan.storyId);
      return pass({
        storyId: jobPlan.storyId,
        phase: story.phase,
        cwdPolicy: step.cwdPolicy,
      });
    }
    if (op === 'context.read') {
      return pass({
        root,
        relatedDocs: Array.isArray(step.args.relatedDocs) ? step.args.relatedDocs.length : 0,
      });
    }
    if (op.startsWith('language.') || op.startsWith('source.') || op.startsWith('target.')) {
      const redev = executeRedevelopmentOperation(root, op, step, priorSteps);
      return redev.status === 'blocked'
        ? block(redev.reason ?? 'redevelopment_operation_blocked', redev.summary)
        : pass(redev.summary);
    }
    return pass({ operation: op, bounded: true });
  }

  if (step.type === 'validate.run') {
    const coverageRows = jobPlan.coverageMap.length;
    const validationRows = jobPlan.coverageMap.filter(row => row.validationStepIds.includes(step.stepId)).length;
    if (coverageRows === 0 || validationRows === 0) {
      return block('validation_binding_missing', { coverageRows, validationRows });
    }
    return pass({
      validationBinding: step.validationBinding ?? null,
      coverageRows,
      validationRows,
      validationSource: 'planned-step-binding',
    });
  }

  if (step.type === 'codex.verify') {
    return pass({ adapter: 'codex', verificationProjected: true });
  }

  if (step.type === 'story.advance') {
    return block('story_advance_requires_lifecycle_gate_evidence', {
      targetPhase: jobPlan.until,
      note: 'planner execution will not bypass Proofbound lifecycle gates',
    });
  }

  if (step.type === 'gate.evaluate') {
    const failed = priorSteps.find(item => item.status !== 'passed');
    if (failed) {
      return block('prior_step_failed', { failedStepId: failed.stepId, failedStatus: failed.status });
    }
    return pass({
      gate: 'local-planned-step-gate',
      admissibilityStatus: 'local-admissible',
      assuranceLevel: 'local',
      evidenceScope: 'local-gate-evidence',
      receiptRequired: false,
    });
  }

  if (step.type === 'stop.summary') {
    const failed = priorSteps.find(item => item.status !== 'passed');
    return pass({
      priorFailure: failed ? { stepId: failed.stepId, status: failed.status, reason: failed.reason } : null,
      evidenceRefs: priorSteps.map(item => item.evidenceBinding),
    });
  }

  return block('unsupported_planned_step_type', { type: step.type });
}

export function executePlannedSteps(options: ExecutePlannedStepsOptions): PlannedStepsExecutionResult {
  const now = options.now ?? (() => new Date());
  const maxSteps = boundedInteger(
    options.maxSteps,
    options.jobPlan.plannedSteps.length,
    MAX_PLANNED_STEP_EXECUTION_HARD_CAP,
  );
  const providerPolicy = resolveProviderPolicy(options.jobPlan);
  // Worktree-safety enforcement (§B2 / M7 / M9 / M11). Active only when the JobPlan
  // carries a worktreePolicy block (real plans always do; legacy/synthetic plans keep
  // prior behavior). Resolve the authoritative story cwd BEFORE any provider work so
  // mutating provider steps run inside the story worktree, never the project root.
  const worktreePolicyView: WorktreePolicyView = resolveWorktreePolicy(options.jobPlan);
  const worktreeEnforced = options.jobPlan.worktreePolicy != null;
  const worktreeResolution: WorktreeResolution = resolveAuthoritativeWorktree(options.store, options.jobPlan.storyId, options.root);
  const gitRunner: GitRunner = options.gitRunner ?? defaultGitRunner;
  let worktreeStopSummary: WorktreeStopSummary | undefined;
  const isMutatingProviderStep = (type: PlannedStep['type']): boolean =>
    type === 'provider.codex' || type === 'provider.claude';
  const providerCtx: ProviderExecContext = {
    // Provider work runs in the authoritative story worktree when enforcement is on.
    // Only the provider exec reads providerCtx.root, so this never shifts read-only /
    // redevelopment lattice.command steps (they use options.root directly).
    root: worktreeEnforced ? worktreeResolution.authoritativeCwd : options.root,
    policy: providerPolicy,
    env: options.env ?? process.env,
    executor: options.providerExecutor ?? defaultBoundedProviderExecutor,
  };
  const steps: PlannedStepExecution[] = [];
  let stopReason = 'completed';
  let failedStepId: string | undefined;

  // Budget meter (X6): track wall-clock + provider-call + token/cost usage from the
  // executor's step events and stop fail-closed with `budget_exceeded` BEFORE the gate
  // when any bound is crossed. The meter is the single enforcement point; it never
  // triggers provider fallback or extra waves on exhaustion.
  const budgetLimits = resolveBudgetLimits(options.jobPlan, options.budget);
  const budgetMeter = createBudgetMeter(budgetLimits, now);
  let budgetReport: BudgetReport = budgetMeter.evaluate();
  let budgetExceeded = false;

  // §B5 / §B14 outer repair-retry policy, resolved once and normalized fail-closed.
  // The default planner emits `repairAllowed:false`, so the repair loop is inert on
  // the default projection path; it only engages when a JobPlan explicitly opts in.
  const repairPolicy = normalizeRepairRetryPolicy(resolveRepairRetryPolicy(options.jobPlan));

  // Single record sink used by BOTH the main pass and the inner repair-retry loop,
  // so every repair attempt + revalidation is a recorded step (evidenceRefs,
  // budget metering, and the evidenceRecorder seam all see them).
  const recordStep = (record: PlannedStepExecution): void => {
    steps.push(record);
    options.evidenceRecorder?.(record, steps.length - 1);
    budgetMeter.recordStep(record);
    budgetReport = budgetMeter.evaluate();
  };

  for (const step of options.jobPlan.plannedSteps.slice(0, maxSteps)) {
    const enforceStep = worktreeEnforced && isMutatingProviderStep(step.type);
    let gitStatusBefore: GitStatusEvidence | undefined;
    if (enforceStep) {
      // Capture git status + fail closed BEFORE the provider spawns on an unresolved
      // authoritative worktree, missing git evidence, dirty worktree, or a declared
      // forbidden-path edit (§B2 / M7 / M9).
      gitStatusBefore = captureGitStatus(worktreeResolution.authoritativeCwd, gitRunner);
      const preflight = evaluateWorktreePreflight({ policy: worktreePolicyView, resolution: worktreeResolution, gitStatus: gitStatusBefore, step });
      if (!preflight.ok && preflight.reason) {
        const blockedRecord = executionRecord(step, 'blocked', now().toISOString(), now().toISOString(), 1, preflight.summary, preflight.reason);
        worktreeStopSummary = buildWorktreeStopSummary({ storyId: options.jobPlan.storyId, stepId: step.stepId, stopReason: preflight.reason, authoritativeCwd: worktreeResolution.authoritativeCwd, gitStatusBefore, detail: preflight.summary });
        steps.push(blockedRecord);
        options.evidenceRecorder?.(blockedRecord, steps.length - 1);
        budgetMeter.recordStep(blockedRecord);
        budgetReport = budgetMeter.evaluate();
        stopReason = preflight.reason;
        failedStepId = step.stepId;
        break;
      }
    }
    let result = executeOneStep(
      options.root,
      options.store,
      options.jobPlan,
      step,
      steps,
      now,
      providerCtx,
    );
    if (enforceStep && result.status === 'passed' && gitStatusBefore) {
      // Postflight (§B2): capture the after-status as git evidence on the passing step,
      // and convert a step that INTRODUCED an edit to a forbidden path (story/fixture
      // JSON) into a fail-closed block.
      const gitStatusAfter = captureGitStatus(worktreeResolution.authoritativeCwd, gitRunner);
      const worktreeEvidence = {
        worktreeEnforced: true,
        authoritativeCwd: worktreeResolution.authoritativeCwd,
        gitStatusCaptured: gitStatusBefore.captured,
        gitStatusClean: gitStatusBefore.clean,
        gitStatusDigest: gitStatusBefore.digest,
        gitStatusAfterDigest: gitStatusAfter.digest,
      };
      const postflight = evaluateForbiddenEdits(gitStatusBefore, gitStatusAfter, worktreePolicyView.forbiddenPathGlobs);
      if (!postflight.ok && postflight.reason) {
        result = executionRecord(step, 'blocked', result.startedAt, now().toISOString(), result.attempts, { ...result.summary, ...worktreeEvidence, ...postflight.summary }, postflight.reason);
        worktreeStopSummary = buildWorktreeStopSummary({ storyId: options.jobPlan.storyId, stepId: step.stepId, stopReason: postflight.reason, authoritativeCwd: worktreeResolution.authoritativeCwd, gitStatusBefore, gitStatusAfter, detail: postflight.summary });
      } else {
        result = executionRecord(step, 'passed', result.startedAt, result.endedAt, result.attempts, { ...result.summary, ...worktreeEvidence });
      }
    }
    // §B5 / §B14 — a failing `validate.run` step that is repair-eligible drives the
    // bounded outer repair/revalidate loop instead of a single-pass stop. The loop
    // is owned by `repair-retry-loop.ts` (bounded by retryPolicy/stopPolicy), so the
    // executor never runs an ad hoc retry. Repair is STRICTLY scoped to validation
    // failures: gate.evaluate / receipt / provider failures never enter it, so a
    // local gate failure can never be "repaired" into DONE — it stops per policy.
    const repairLoop = maybeRunValidateRepairLoop({
      step,
      initialResult: result,
      jobPlan: options.jobPlan,
      store: options.store,
      root: options.root,
      now,
      providerCtx,
      repairPolicy,
      recordStep,
    });
    if (repairLoop) {
      if (repairLoop.validated) {
        // Validation passed (after one or more revalidations). Proceed to the next
        // planned step — repair never short-circuits the gate that still follows.
        if (budgetReport.exceeded) {
          budgetExceeded = true;
          stopReason = BUDGET_EXCEEDED_STOP_REASON;
          break;
        }
        continue;
      }
      stopReason = repairLoop.stopReason;
      failedStepId = repairLoop.failedStepId;
      break;
    }

    steps.push(result);
    options.evidenceRecorder?.(result, steps.length - 1);
    budgetMeter.recordStep(result);
    budgetReport = budgetMeter.evaluate();
    if (result.status !== 'passed') {
      stopReason = result.reason ?? `${result.status}_step`;
      failedStepId = result.stepId;
      break;
    }
    if (budgetReport.exceeded) {
      budgetExceeded = true;
      stopReason = BUDGET_EXCEEDED_STOP_REASON;
      break;
    }
  }

  if (options.jobPlan.plannedSteps.length > maxSteps && !failedStepId) {
    stopReason = 'max_planned_steps_reached';
    failedStepId = options.jobPlan.plannedSteps[maxSteps]?.stepId;
  }

  // Intermediate repair-retry attempts (failing validations, failed/timeout repair
  // provider rounds) are tagged `repairLoopAttempt`; they are NOT terminal step
  // outcomes. The run's terminal status is decided by untagged records only — a
  // repaired-then-passing validation must not leave a stale `failed`/`blocked` mark,
  // and a blocked loop pushes one untagged terminal `validate.run` block carrying the
  // exact loop stop reason.
  const isTerminal = (step: PlannedStepExecution): boolean => step.summary.repairLoopAttempt !== true;
  const failed = steps.find(step => step.status === 'failed' && isTerminal(step));
  const blocked = steps.find(step => step.status === 'blocked' && isTerminal(step));
  // Budget exhaustion stops `blocked` (X6), never `done` — fail-closed before the gate.
  const status: PlannedStepsExecutionStatus = failed ? 'failed' : blocked || budgetExceeded || options.jobPlan.plannedSteps.length > maxSteps ? 'blocked' : 'done';
  let finalStoryPhase: string | null = null;
  try {
    finalStoryPhase = options.store.readStory(options.jobPlan.storyId).phase;
  } catch {
    finalStoryPhase = null;
  }
  const localDone = status === 'done' && options.jobPlan.mode === 'local' && options.jobPlan.until === 'DONE' && finalStoryPhase === 'DONE';
  const receiptVerified = false;
  const authorityDone = false;
  const nextActions = new Set<string>();
  if (status !== 'done') {
    if (worktreeStopSummary && (WORKTREE_STOP_REASONS as readonly string[]).includes(stopReason)) {
      nextActions.add(worktreeStopSummary.nextAction);
    } else if (stopReason === 'disabled') {
      nextActions.add('Enable the provider in providerPolicy.allowedProviders before requesting real provider execution.');
    } else if (stopReason === 'provider_unavailable') {
      nextActions.add('Install and authenticate the exact provider CLI requested by the job providerPolicy on this host; unattended mode will not switch providers automatically.');
    } else if (stopReason === 'credential_unavailable') {
      nextActions.add('Configure provider credentials via providerPolicy.credentialsEnvAllowlist or secretRefs; unattended mode will not prompt for secrets.');
    } else if (stopReason === 'noninteractive_auth_unavailable') {
      nextActions.add('Provide a recognized Claude noninteractive auth credential (e.g. ANTHROPIC_API_KEY) via providerPolicy.credentialsEnvAllowlist; unattended Claude runs never fall back to interactive login.');
    } else if (stopReason === BUDGET_EXCEEDED_STOP_REASON) {
      if (budgetReport.nextAction) nextActions.add(budgetReport.nextAction);
    } else if (stopReason === 'no_progress') {
      nextActions.add('Validation kept failing with no material/evidence progress across repair rounds; inspect the validation failure and fix the root cause in DEV — repeated identical repair attempts are not retried.');
    } else if (stopReason === 'max_repair_attempts_exhausted') {
      nextActions.add('Repair budget (retryPolicy.maxRepairAttempts) was exhausted without validation passing; fix the failing validation in DEV before rerunning.');
    } else if (stopReason === 'repair_provider_unavailable' || stopReason === 'repair_provider_failed') {
      nextActions.add('The configured repair provider could not make progress; check providerPolicy enablement, availability, and credentials, then rerun.');
    } else if (failedStepId) {
      nextActions.add(`Resolve blocked planned step ${failedStepId}, then rerun lattice planner run.`);
    }
  }
  if (status === 'done' && options.jobPlan.mode === 'local') {
    if (!localDone && options.jobPlan.until === 'DONE') {
      nextActions.add('PlannedSteps completed, but local Story lifecycle has not reached DONE; run the normal Proofbound lifecycle gates before claiming local DONE.');
    }
    nextActions.add('Submit independent local host verdicts before claiming localReviewCertified when multi-host policy requires it.');
  }

  const redevelopment = buildRedevelopmentSummary(options.jobPlan, steps);
  if (redevelopment && !redevelopment.doneEligible) {
    nextActions.add('Source-aligned redevelopment is not DONE-eligible: capture target-runnable parity evidence and resolve open gaps/unavailable adapters before claiming redevelopment DONE.');
  }

  const result: PlannedStepsExecutionResult = {
    schemaVersion: 'lattice.planned_steps_execution.v1',
    plannerRunId: options.jobPlan.plannerRunId,
    storyId: options.jobPlan.storyId,
    mode: options.jobPlan.mode,
    until: options.jobPlan.until,
    developmentWorkflow: options.jobPlan.developmentWorkflow,
    status,
    localDone,
    authorityDone,
    fullAuthorityDone: false,
    receiptVerified,
    multiHostVerified: false,
    plannedStepsDigest: plannedStepsDigestOf(options.jobPlan),
    providerPolicyDigest: digest(providerPolicy),
    executedStepCount: steps.length,
    evidenceRefs: steps.map(step => step.evidenceBinding),
    ...(failedStepId ? { failedStepId } : {}),
    stopReason,
    nextActions: [...nextActions],
    budgetUsage: budgetReport,
    steps,
    ...(redevelopment ? { redevelopment } : {}),
    ...(worktreeStopSummary ? { worktreeStopSummary } : {}),
  };

  options.store.appendProcessEvent(options.jobPlan.storyId, {
    type: 'planner_execution',
    plannerRunId: options.jobPlan.plannerRunId,
    jobPlanDigest: options.jobPlan.jobPlanDigest,
    status: result.status,
    stopReason: result.stopReason,
    executedStepCount: result.executedStepCount,
    localDone: result.localDone,
    authorityDone: result.authorityDone,
    fullAuthorityDone: result.fullAuthorityDone,
    budgetExceeded: budgetReport.exceeded,
    budgetUsage: budgetReport.usage,
    providerPolicy,
    ...(worktreeStopSummary ? { worktreeStop: { stopReason: worktreeStopSummary.stopReason, authoritativeCwd: worktreeStopSummary.authoritativeCwd } } : {}),
  });

  return result;
}

// --- Outer repair / retry / stop loop adapter (§B5, M9) ----------------------
//
// The §B5 contract is an OUTER loop around a validation step:
// validate -> (fail) -> repair provider step -> revalidate, bounded by
// retryPolicy/stopPolicy. The loop itself lives in `repair-retry-loop.ts` as a
// pure, dependency-injected engine.
//
// Two consumers bind that engine to the real bounded provider machinery:
//   1. `executePlannedSteps` drives it INLINE (via `maybeRunValidateRepairLoop`)
//      whenever a `validate.run` step fails AND the JobPlan opts in
//      (`retryPolicy.repairAllowed` + a resolvable provider `repairBinding`). The
//      default planner emits `repairAllowed:false`, so the default single-pass
//      projection path is untouched — repair only engages on explicit opt-in.
//   2. `executeProviderBackedRepairRetry` (below) is a standalone adapter for the
//      live executor / smokes that need to drive the same loop with injected
//      validation/material hooks without an enclosing `executePlannedSteps` run.
//
// Both reuse the SAME `executeRealProviderStep` machinery for the repair step, so
// repair can never smuggle in a weaker provider path, and both inherit the engine's
// hard invariants (repair always revalidates; provider exit 0 never satisfies
// validation; authority/receipt/multi-host status stay false).

/**
 * Defensive mapping from a JobPlan's disjoint retryPolicy/stopPolicy blocks into
 * the loop engine's flat policy. Reads each side defensively (Handler encoding
 * convention) and lets `normalizeRepairRetryPolicy` clamp the result, so a
 * missing or malformed block collapses to conservative, repair-disabled defaults.
 */
export function resolveRepairRetryPolicy(jobPlan: JobPlan): Partial<RepairRetryPolicy> {
  const rp = (jobPlan as { retryPolicy?: Record<string, unknown> }).retryPolicy;
  const sp = (jobPlan as { stopPolicy?: Record<string, unknown> }).stopPolicy;
  const retry = rp && typeof rp === 'object' ? rp : {};
  const stop = sp && typeof sp === 'object' ? sp : {};
  return {
    maxAttemptsPerStep: retry.maxAttemptsPerStep as number,
    maxRepairAttempts: retry.maxRepairAttempts as number,
    maxNoProgressIterations: retry.maxNoProgressIterations as number,
    repairAllowed: retry.repairAllowed as boolean,
    retryableFailureKinds: Array.isArray(retry.retryableFailureKinds)
      ? (retry.retryableFailureKinds as string[])
      : [],
    onValidationFailure: stop.onValidationFailure as RepairRetryPolicy['onValidationFailure'],
    onProviderFailure: stop.onProviderFailure as RepairRetryPolicy['onProviderFailure'],
  };
}

/** Classify a repair provider step's execution record into a loop-level outcome. */
function classifyRepairOutcome(record: PlannedStepExecution): RepairProviderOutcome {
  if (record.status === 'passed') return 'repaired';
  switch (record.reason) {
    // Both single-attempt timeout and the executor's single-pass `no_progress`
    // (every bounded attempt timed out) are timeouts at the loop level; the OUTER
    // loop owns cross-iteration no-progress via the material/evidence hash.
    case 'provider_timeout':
    case 'no_progress':
      return 'provider_timeout';
    case 'provider_failed':
      return 'provider_failed';
    case 'disabled':
    case 'provider_unavailable':
    case 'credential_unavailable':
    case 'noninteractive_auth_unavailable':
    case 'provider_request_invalid':
      return 'provider_unavailable';
    default:
      return 'provider_failed';
  }
}

/**
 * Resolve the configured repair provider step for a failing `validate.run` step.
 * The validate step's `repairBinding` references the repair step by either its
 * `stepId` or its `evidenceBinding` (§B14 `repairBinding`). Only a real provider
 * step (codex/claude) can make repair progress; anything else is not a valid
 * repair target, so the loop never engages and the failure stops single-pass.
 */
function resolveRepairProviderStep(jobPlan: JobPlan, validateStep: PlannedStep): PlannedStep | undefined {
  const binding = validateStep.repairBinding;
  if (typeof binding !== 'string' || binding.trim() === '') return undefined;
  const match = jobPlan.plannedSteps.find(
    candidate => candidate.stepId === binding || candidate.evidenceBinding === binding,
  );
  if (!match) return undefined;
  if (match.type !== 'provider.codex' && match.type !== 'provider.claude') return undefined;
  return match;
}

/** Clone a repair-loop attempt record: tag it `repairLoopAttempt` and give it a unique stepId. */
function asAttemptRecord(record: PlannedStepExecution, stepId: string): PlannedStepExecution {
  return { ...record, stepId, summary: { ...record.summary, repairLoopAttempt: true } };
}

interface ValidateRepairLoopDeps {
  step: PlannedStep;
  initialResult: PlannedStepExecution;
  jobPlan: JobPlan;
  store: PlannerStoreLike;
  root: string;
  now: () => Date;
  providerCtx: ProviderExecContext;
  repairPolicy: RepairRetryPolicy;
  recordStep: (record: PlannedStepExecution) => void;
}

interface ValidateRepairLoopOutcome {
  validated: boolean;
  stopReason: string;
  failedStepId?: string;
}

/**
 * In-executor §B5 / §B14 repair/retry loop seam.
 *
 * Returns `undefined` when the step is NOT a repair-eligible validation failure
 * (so the caller keeps its single-pass behavior unchanged — the default planner,
 * which emits `repairAllowed:false`, always takes this path). When eligible it
 * records the initial failing validation, then drives the bounded loop in
 * `repair-retry-loop.ts`:
 *
 *   validate(fail) -> repair provider step -> revalidate -> ...
 *
 * bounded by `maxRepairAttempts` and `maxNoProgressIterations`. Every attempt is
 * recorded (tagged `repairLoopAttempt`) so evidence/budget see it, but only the
 * terminal disposition decides run status. Hard invariants are inherited from the
 * loop engine: repair always revalidates, a provider exit-0 never satisfies
 * validation, and the loop confers no authority/receipt/multi-host status.
 */
function maybeRunValidateRepairLoop(deps: ValidateRepairLoopDeps): ValidateRepairLoopOutcome | undefined {
  const { step, initialResult, jobPlan, store, root, now, providerCtx, repairPolicy, recordStep } = deps;

  // Repair is strictly scoped to validation failures.
  if (step.type !== 'validate.run' || initialResult.status === 'passed') return undefined;
  if (!repairPolicy.repairAllowed || repairPolicy.maxRepairAttempts <= 0) return undefined;
  const repairStep = resolveRepairProviderStep(jobPlan, step);
  if (!repairStep) return undefined;
  const provider: BoundedProviderName = repairStep.type === 'provider.codex' ? 'codex' : 'claude';

  // Record the initial failing validation once (iteration 0). The loop's validate(0)
  // reuses its digest below without re-executing or re-recording it.
  recordStep(asAttemptRecord(initialResult, `${step.stepId}#validate-attempt-0`));

  let lastValidationDigest = initialResult.evidenceDigest;
  let lastRepairEvidenceDigest = '';
  let repairRound = 0;

  const hooks: RepairRetryHooks = {
    validate: (iteration) => {
      if (iteration === 0) {
        // Initial validation already recorded; never re-run iteration 0.
        return { passed: false, digest: initialResult.evidenceDigest };
      }
      // Revalidate by re-executing the SAME validate.run step (repair never bypasses
      // validation). validate.run is deterministic over coverageMap, so a structural
      // validation failure stays failing — bounded to a blocked stop, never a loop.
      const record = executeOneStep(root, store, jobPlan, step, [], now, providerCtx);
      recordStep(asAttemptRecord(record, `${step.stepId}#validate-attempt-${iteration}`));
      lastValidationDigest = record.evidenceDigest;
      return { passed: record.status === 'passed', digest: record.evidenceDigest };
    },
    repair: () => {
      repairRound += 1;
      // The repair step runs through the SAME bounded provider machinery as a normal
      // provider step (policy gating, availability/credential preflight, bounded argv,
      // redacted env, digest-only evidence) — repair cannot smuggle in a weaker path.
      const startedAt = now().toISOString();
      const record = executeRealProviderStep(repairStep, provider, providerCtx, startedAt, now);
      recordStep(asAttemptRecord(record, `${repairStep.stepId}#repair-attempt-${repairRound}`));
      const attempts = typeof record.summary.attempts === 'number' ? record.summary.attempts : record.attempts;
      lastRepairEvidenceDigest = record.evidenceDigest;
      return {
        outcome: classifyRepairOutcome(record),
        attempts: Math.max(1, attempts),
        evidenceDigest: record.evidenceDigest,
      };
    },
    // Material/evidence hash: a repair that reproduces identical evidence AND leaves
    // an identical (still-failing) validation digest hashes the same, so repeated
    // identical blockers trip `maxNoProgressIterations` instead of burning the budget.
    materialHash: () => digest({ v: lastValidationDigest, r: lastRepairEvidenceDigest }),
  };

  const loop = runRepairRetryLoop(repairPolicy, hooks);
  if (loop.status === 'validated') {
    return { validated: true, stopReason: 'validation_passed_after_repair' };
  }

  // Blocked: push ONE untagged terminal block for the validate.run step carrying the
  // exact loop stop reason, so the run's terminal status is `blocked` with that reason
  // (and a verified gate is still required for any DONE — repair never grants it).
  const terminal = executionRecord(
    step,
    'blocked',
    initialResult.startedAt,
    now().toISOString(),
    loop.repairAttemptsUsed,
    {
      operation: operation(step),
      repairLoopResolved: false,
      repairAttemptsUsed: loop.repairAttemptsUsed,
      providerAttemptsUsed: loop.providerAttemptsUsed,
      noProgressStreak: loop.noProgressStreak,
      returnToDev: loop.returnToDev,
      loopDigest: loop.loopDigest,
      validationSatisfied: false,
      authorityDone: false,
      receiptVerified: false,
      multiHostVerified: false,
    },
    loop.stopReason,
  );
  recordStep(terminal);
  return { validated: false, stopReason: loop.stopReason, failedStepId: step.stepId };
}

export interface ProviderRepairRetryOptions {
  root: string;
  jobPlan: JobPlan;
  /** The configured repair step — must be a provider.codex / provider.claude step. */
  repairStep: PlannedStep;
  env?: NodeJS.ProcessEnv;
  providerExecutor?: BoundedProviderExecutor;
  now?: () => Date;
  /**
   * Validation probe. Iteration 0 is the initial validation that may open the
   * loop; 1..N are the post-repair revalidations. Repair NEVER bypasses this —
   * the engine always calls it again after each repair attempt.
   */
  validate: (iteration: number) => ValidationProbeResult;
  /**
   * Optional material/evidence hash override (e.g. a git-status digest in a live
   * run). Defaults to a digest of the latest validation + repair evidence
   * digests, so a repair that produces identical evidence counts as no-progress.
   */
  materialHash?: (probe: {
    iteration: number;
    lastValidationDigest: string;
    lastRepairEvidenceDigest: string;
  }) => string;
}

/**
 * Drive the §B5 repair/retry loop with a real bounded provider repair step.
 *
 * The repair step is executed through the SAME `executeRealProviderStep`
 * machinery as a normal provider step (policy gating, availability/credential
 * preflight, bounded argv, redacted env, digest-only evidence), so repair cannot
 * smuggle in a weaker provider path. The returned result carries the engine's
 * hard invariants unchanged: validation is always re-run, and authority / receipt
 * / multi-host status stay false.
 */
export function executeProviderBackedRepairRetry(options: ProviderRepairRetryOptions): RepairRetryLoopResult {
  const now = options.now ?? (() => new Date());
  const providerCtx: ProviderExecContext = {
    root: options.root,
    policy: resolveProviderPolicy(options.jobPlan),
    env: options.env ?? process.env,
    executor: options.providerExecutor ?? defaultBoundedProviderExecutor,
  };

  let lastValidationDigest = '';
  let lastRepairEvidenceDigest = '';

  const runRepair = (): { outcome: RepairProviderOutcome; attempts: number; evidenceDigest: string } => {
    const step = options.repairStep;
    if (step.type !== 'provider.codex' && step.type !== 'provider.claude') {
      // A repair step must be a configured provider step; anything else cannot
      // make progress and fails closed as unavailable.
      return { outcome: 'provider_unavailable', attempts: 1, evidenceDigest: '' };
    }
    const provider: BoundedProviderName = step.type === 'provider.codex' ? 'codex' : 'claude';
    const startedAt = now().toISOString();
    const record = executeRealProviderStep(step, provider, providerCtx, startedAt, now);
    const attempts = typeof record.summary.attempts === 'number' ? record.summary.attempts : record.attempts;
    return {
      outcome: classifyRepairOutcome(record),
      attempts: Math.max(1, attempts),
      evidenceDigest: record.evidenceDigest,
    };
  };

  const hooks: RepairRetryHooks = {
    validate: (iteration) => {
      const probe = options.validate(iteration);
      lastValidationDigest = probe.digest;
      return probe;
    },
    repair: () => {
      const probe = runRepair();
      lastRepairEvidenceDigest = probe.evidenceDigest;
      return probe;
    },
    materialHash: (iteration) =>
      options.materialHash
        ? options.materialHash({ iteration, lastValidationDigest, lastRepairEvidenceDigest })
        // The default hash MUST NOT include `iteration` — it reflects only the
        // material/evidence state, so a repair that reproduces identical evidence
        // and an identical (still-failing) validation digest hashes the same and
        // is correctly counted as no-progress.
        : digest({ v: lastValidationDigest, r: lastRepairEvidenceDigest }),
  };

  return runRepairRetryLoop(resolveRepairRetryPolicy(options.jobPlan), hooks);
}
