import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalDigest } from './authority-signing.js';
import type { StoryInfo, StoryType, VerificationIntent } from './types.js';
import { LATTICE_DIR } from './lattice-paths.js';

/**
 * @task B-e3d9
 * @checklist CHK-003
 * @title Link planner worktree policy emission to executor enforcement
 * @type bugfix
 * @priority high
 * @description
 *   Planner linkage for requiresAuthoritativeWorktree and requiresCleanWorktree:
 *   buildJobPolicyBlocks emits the local worktree policy,
 *   assertJobPolicyConsistency rejects weakened local policy, and
 *   provider planned steps carry requiresCleanWorktree for executor preflight.
 * @changes
 *   - [CHK-003] Connect planner worktreePolicy emission to planner-unattended-smoke and worktree-policy-smoke coverage
 */

/**
 * @task B-e3d9
 * @checklist CHK-004
 * @title Link planner confirmation policy to story creation blocking
 * @type bugfix
 * @priority high
 * @description
 *   Planner policy linkage for requiresConfirmationBeforeStoryCreate:
 *   defaultPlannerPolicy controls whether a confirmationDigest is required
 *   before planner_create_story may call story_create.
 * @changes
 *   - [CHK-004] Connect requiresConfirmationBeforeStoryCreate defaults to planner_create_story blocking behavior covered by planner-unattended-smoke
 */

export const PLANNER_INTERACTION_MODES = ['autonomous', 'interview', 'decision-gated'] as const;
export type PlannerInteractionMode = typeof PLANNER_INTERACTION_MODES[number];

export const PLANNER_RUN_MODES = ['local'] as const;
export type PlannerRunMode = typeof PLANNER_RUN_MODES[number];

export const PLANNER_UNTIL_PHASES = ['PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'] as const;
export type PlannerUntilPhase = typeof PLANNER_UNTIL_PHASES[number];

export const DEVELOPMENT_WORKFLOWS = ['standard', 'source_aligned_redevelopment'] as const;
export type DevelopmentWorkflow = typeof DEVELOPMENT_WORKFLOWS[number];

export interface PlannerPolicy {
  allowUnattendedPlanning: boolean;
  allowedInteractionModes: PlannerInteractionMode[];
  allowExternalDeployment: boolean;
  allowRemotePush: boolean;
  allowDestructiveGit: boolean;
  allowMultiStoryPlanning: boolean;
  requiresConfirmationBeforeStoryCreate: boolean;
  maxStoriesPerRequest: number;
  forceNewRunAllowed: boolean;
  maxPlannerQuestions: number;
  maxPlannerAttempts: number;
  maxPlannedSteps: number;
  maxProviderCalls: number;
  maxReviewWaves: number;
  maxWallClockMs: number;
  maxTokenOrCostBudget: number;
}

export interface SourceAlignedRedevelopmentSpec {
  workflow: 'source-aligned-redevelopment';
  sourceRepo: string;
  targetProject: string;
  targetProjectName: string;
  sourceLanguage: string;
  targetLanguage: string;
  renameMap: Record<string, string>;
  includedPaths: string[];
  excludedPaths: string[];
  languageAdapterPolicy?: Record<string, unknown>;
  semanticMappingPolicy?: Record<string, unknown>;
  parityOraclePolicy?: Record<string, unknown>;
  alignmentVerificationIntent: string[];
  sourceLimits: {
    maxSourceFiles: number;
    maxSourceBytes: number;
    maxMappedModules: number;
    maxMappedFunctions: number;
    maxAlignmentPasses: number;
    maxGapRepairAttempts: number;
  };
}

export interface PlannerQuestion {
  id: string;
  question: string;
  why: string;
}

export interface PlannerDraft {
  schemaVersion: 'lattice.planner_draft.v1';
  plannerRunId: string;
  plannerDraftId: string;
  createdAt: string;
  interactionMode: PlannerInteractionMode;
  mode: PlannerRunMode;
  until: PlannerUntilPhase;
  developmentWorkflow: DevelopmentWorkflow;
  naturalLanguageDigest: string;
  request: string;
  requestFile?: string;
  storyDraft: {
    name: string;
    title: string;
    description: string;
    type: StoryType;
    priority: string;
  };
  checklist: Array<{
    title: string;
    context: string;
    relatedDocs: string[];
    verificationIntent: VerificationIntent;
  }>;
  plannerPolicy: PlannerPolicy;
  // Resolved, fail-closed provider policy that travels with the draft so the
  // emitted plannedSteps + JobPlan agree on which provider runs the bounded
  // implementation step. Defaults to fake-only; real providers require explicit opt-in.
  providerPolicy: JobProviderPolicy;
  sourceAlignedRedevelopmentSpec?: SourceAlignedRedevelopmentSpec;
  questions: PlannerQuestion[];
  requiredDecisions: PlannerQuestion[];
  assumptions: string[];
  scopeQuestions: PlannerQuestion[];
  deferredOptimizations: string[];
  status: 'drafted' | 'paused';
  pauseReason?: 'interview_questions' | 'major_decision_required';
  // When --forceNewRun is supplied the planner intake digest is unchanged
  // (naturalLanguageDigest still hashes the request verbatim), but the
  // idempotency SCOPE is forked: plannerRunId / plannerDraftId / story name all
  // mix in forceScope.scopeDigest so a forced run resolves to a distinct run,
  // Story, and job plan instead of collapsing onto the default reuse scope.
  forceNewRun?: boolean;
  forceNewRunReason?: string;
  forceScope?: { token: string; scopeDigest: string };
  plannerDigest: string;
}

export interface PlannerReviewIssue {
  id: string;
  severity: 'blocker' | 'warning';
  category: string;
  message: string;
}

export interface PlannerReviewResult {
  schemaVersion: 'lattice.planner_review.v1';
  plannerRunId: string;
  plannerDraftId: string;
  reviewedAt: string;
  status: 'pass' | 'blocked';
  issueCount: number;
  issues: PlannerReviewIssue[];
  plannerDigest: string;
}

export interface PlannedStep {
  stepId: string;
  type: 'lattice.command' | 'provider.fake' | 'provider.codex' | 'provider.claude' | 'validate.run' | 'codex.verify' | 'gate.evaluate' | 'story.advance' | 'stop.summary';
  title: string;
  purpose: string;
  cwdPolicy: 'story-worktree' | 'project-root' | 'read-only';
  timeoutMs: number;
  maxAttempts: number;
  requiresCleanWorktree: boolean;
  producesEvidence: boolean;
  blocksUntilEvidenceUploaded: boolean;
  provider?: 'fake' | 'codex' | 'claude';
  validationBinding?: string;
  repairBinding?: string;
  evidenceBinding: string;
  args: Record<string, unknown>;
}

const PROVIDER_STEP_TYPES = { 'provider.fake': 'fake', 'provider.codex': 'codex', 'provider.claude': 'claude' } as const;

const PLACEHOLDER_TEXT_PATTERN = /\b(todo|tbd|fixme|placeholder|replace me|fill me)\b|{{[^}]+}}|<[^>]+>/i;

function isPlaceholderText(value: string): boolean {
  return value.trim().length === 0 || PLACEHOLDER_TEXT_PATTERN.test(value);
}

export const PlannedStepSchema = z.object({
  stepId: z.string().min(1),
  type: z.enum(['lattice.command', 'provider.fake', 'provider.codex', 'provider.claude', 'validate.run', 'codex.verify', 'gate.evaluate', 'story.advance', 'stop.summary']),
  title: z.string().min(1),
  purpose: z.string().min(1),
  cwdPolicy: z.enum(['story-worktree', 'project-root', 'read-only']),
  timeoutMs: z.number().int().positive(),
  maxAttempts: z.number().int().min(1),
  requiresCleanWorktree: z.boolean(),
  producesEvidence: z.boolean(),
  blocksUntilEvidenceUploaded: z.boolean(),
  provider: z.enum(['fake', 'codex', 'claude']).optional(),
  validationBinding: z.string().min(1).optional(),
  repairBinding: z.string().min(1).optional(),
  evidenceBinding: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
}).superRefine((step, ctx) => {
  for (const field of ['stepId', 'title', 'purpose', 'evidenceBinding'] as const) {
    if (isPlaceholderText(step[field])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `step ${step.stepId || '<unknown>'} ${field} must be concrete and must not be a placeholder` });
    }
  }
  for (const field of ['validationBinding', 'repairBinding'] as const) {
    const value = step[field];
    if (typeof value === 'string' && isPlaceholderText(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `step ${step.stepId} ${field} must be concrete and must not be a placeholder` });
    }
  }
  const op = step.args.operation;
  if (typeof op !== 'string' || isPlaceholderText(op)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['args', 'operation'], message: `step ${step.stepId} must declare a concrete args.operation so executable plannedSteps are not prose-only` });
  }
  const expectedProvider = PROVIDER_STEP_TYPES[step.type as keyof typeof PROVIDER_STEP_TYPES];
  if (expectedProvider) {
    if (step.provider !== expectedProvider) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['provider'], message: `step ${step.stepId} (${step.type}) must declare provider="${expectedProvider}"` });
    }
  } else if (step.provider) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['provider'], message: `non-provider step ${step.stepId} (${step.type}) must not declare a provider` });
  }
  if (step.blocksUntilEvidenceUploaded && !step.producesEvidence) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['blocksUntilEvidenceUploaded'], message: `step ${step.stepId} blocks on evidence upload but does not produce evidence` });
  }
});

export const PlannedStepsSchema = z.array(PlannedStepSchema).min(1).superRefine((steps, ctx) => {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.stepId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate stepId in planned steps: ${step.stepId}` });
    }
    seen.add(step.stepId);
  }
});

// Machine-readable JobPlan policy blocks. These travel with every local JobPlan so the Stage B
// executor never has to infer provider, worktree, retry, stop, lease, evidence,
// or gate semantics from prose. The planner only ever emits the conservative
// fail-closed defaults below; `assertJobPolicyConsistency` rejects any plan whose
// blocks are missing, ambiguous, or suspicious before it is treated as planned.

export const EVIDENCE_RETENTION_CLASSES = ['short_lived_run_log', 'verification_artifact', 'receipt_bound_artifact', 'final_summary'] as const;
export type EvidenceRetentionClass = typeof EVIDENCE_RETENTION_CLASSES[number];

export type StopBehavior = 'block' | 'return_to_dev' | 'retry_then_block' | 'repair_then_reverify';

// providerPolicy is a superset of the executor's ProviderPolicy (adds secretRefs
// per the doc). The executor reads it defensively as Partial<ProviderPolicy>, so
// the extra field is inert there and the executor still resolves the same
// fail-closed behavior.
export interface JobProviderPolicy {
  primaryProvider: 'fake' | 'codex' | 'claude';
  allowedProviders: Array<'fake' | 'codex' | 'claude'>;
  fallbackProviders: Array<'fake' | 'codex' | 'claude'>;
  productionDoneProviders: Array<'codex' | 'claude'>;
  allowFakeProviderForProductionDone: boolean;
  credentialsEnvAllowlist: string[];
  secretRefs: string[];
  providerAvailability: 'fail_closed';
}

// The conservative, fail-closed provider policy the planner emits by default: only
// the deterministic `fake` provider is allowed, it is never production-DONE-eligible,
// and no credentials are projected. A caller must explicitly opt a real provider in
// (PlannerProviderPolicyInput) before the planner will emit a provider.codex /
// provider.claude step — mirroring the executor's DEFAULT_FAIL_CLOSED_PROVIDER_POLICY.
const DEFAULT_FAKE_PROVIDER_POLICY: JobProviderPolicy = {
  primaryProvider: 'fake',
  allowedProviders: ['fake'],
  fallbackProviders: [],
  productionDoneProviders: [],
  allowFakeProviderForProductionDone: false,
  credentialsEnvAllowlist: [],
  secretRefs: [],
  providerAvailability: 'fail_closed',
};

// Caller-supplied provider preference (CLI / handler input). Everything is optional;
// `resolveDraftProviderPolicy` normalizes it into a fail-closed JobProviderPolicy.
// `fake` stays the default so an unattended run never silently spawns a real provider.
export interface PlannerProviderPolicyInput {
  primaryProvider?: 'fake' | 'codex' | 'claude';
  allowedProviders?: Array<'fake' | 'codex' | 'claude'>;
  fallbackProviders?: Array<'fake' | 'codex' | 'claude'>;
  productionDoneProviders?: Array<'codex' | 'claude'>;
  allowFakeProviderForProductionDone?: boolean;
  credentialsEnvAllowlist?: string[];
  secretRefs?: string[];
}

export interface JobWorktreePolicy {
  resolver: 'lattice.story.resolve';
  requiresAuthoritativeWorktree: boolean;
  allowWorktreeRepair: boolean;
  allowedPathRoots: string[];
  forbiddenPathGlobs: string[];
  requiresCleanWorktree: boolean;
  preserveUnrelatedDirtyChanges: boolean;
  requireGitStatusEvidence: boolean;
}

export interface JobRetryPolicy {
  maxAttemptsPerStep: number;
  maxRepairAttempts: number;
  maxNoProgressIterations: number;
  retryableFailureKinds: string[];
  repairAllowed: boolean;
}

export interface JobStopPolicy {
  maxSteps: number;
  maxWallClockMs: number;
  onValidationFailure: StopBehavior;
  onProviderFailure: StopBehavior;
  onGateFailure: StopBehavior;
  onDirtyWorktree: StopBehavior;
  onLeaseUnsafe: StopBehavior;
  onMultiHostDisagreement: StopBehavior;
}

// Cost/time budget the executor meters and enforces (X6). Travels with every
// local JobPlan so the Stage B / planner executor can stop
// `budget_exceeded` without inferring limits from prose. Derived from
// plannerPolicy at emit time; consumed defensively by core/budget-meter.ts.
export interface JobBudgetPolicy {
  maxWallClockMs: number;
  maxTokenOrCostBudget: number;
  maxProviderCalls: number;
}

// Lease claim-time fields (leaseId/leasedBy*/leaseExpiresAt) are null in a plan;
// they are only populated when a runner actually claims the job. The TTL/renewal
// config is fixed at plan time so renewal-before-expiry is unambiguous.
export interface JobLease {
  leaseId: string | null;
  leasedByRunnerId: string | null;
  leasedBySessionId: string | null;
  leaseExpiresAt: string | null;
  leaseTtlMs: number;
  renewalThresholdMs: number;
  graceMs: number;
  leaseVersion: number;
}

export interface JobEvidencePolicy {
  requiredEvidenceKinds: string[];
  redactionRequired: boolean;
  retentionClassByKind: Record<string, EvidenceRetentionClass>;
  allowContinueWithoutEvidence: boolean;
  checklistCoverageRequired: boolean;
}

const LEASE_DEFAULT_TTL_MS = 300_000;
const LEASE_DEFAULT_RENEWAL_MS = 120_000;
const LEASE_DEFAULT_GRACE_MS = 30_000;

// The executor must never edit story/fixture JSON directly (Non-Goals + §B2).
const FORBIDDEN_WORKTREE_GLOBS = ['.lattice/story/**', 'docs/story/**', '**/tests/fixtures/**'] as const;

const REQUIRED_EVIDENCE_KINDS = ['run_record', 'provider_event', 'command_event', 'validation_evidence', 'git_evidence', 'gate_request', 'stop_summary'] as const;

export const DEFAULT_RETENTION_BY_KIND: Record<string, EvidenceRetentionClass> = {
  run_record: 'short_lived_run_log',
  provider_event: 'short_lived_run_log',
  command_event: 'short_lived_run_log',
  validation_evidence: 'verification_artifact',
  git_evidence: 'verification_artifact',
  gate_request: 'receipt_bound_artifact',
  stop_summary: 'final_summary',
};

// retryPolicy and stopPolicy must stay disjoint (§B5: a job that mixes the fields
// ambiguously fails validation before execution).
const RETRY_ONLY_KEYS = ['maxAttemptsPerStep', 'maxRepairAttempts', 'maxNoProgressIterations', 'retryableFailureKinds', 'repairAllowed'] as const;
const STOP_ONLY_KEYS = ['maxSteps', 'maxWallClockMs', 'onValidationFailure', 'onProviderFailure', 'onGateFailure', 'onDirtyWorktree', 'onLeaseUnsafe', 'onMultiHostDisagreement'] as const;

export interface JobPlan {
  schemaVersion: 'lattice.job_plan.v1';
  plannerRunId: string;
  storyId: string;
  mode: PlannerRunMode;
  until: PlannerUntilPhase;
  developmentWorkflow: DevelopmentWorkflow;
  // Machine-readable policy blocks. Optional on the type so legacy/test JobPlan
  // fixtures still type-check, but buildJobPlan ALWAYS emits them and
  // assertJobPolicyConsistency rejects any planner-produced plan that omits them.
  providerPolicy?: JobProviderPolicy;
  worktreePolicy?: JobWorktreePolicy;
  retryPolicy?: JobRetryPolicy;
  stopPolicy?: JobStopPolicy;
  budgetPolicy?: JobBudgetPolicy;
  lease?: JobLease;
  evidencePolicy?: JobEvidencePolicy;
  localRunPlan?: {
    runId: string;
    plannedStepsDigest: string;
  };
  plannedSteps: PlannedStep[];
  coverageMap: Array<{
    checklistItemId: string;
    verificationIntentDigest: string;
    plannedStepIds: string[];
    validationStepIds: string[];
    evidenceRefs: string[];
    expectedArtifacts: string[];
    gatePredicate: string;
  }>;
  multiHostPolicy: {
    minIndependentHosts: number;
    targetHostsPerWave: number;
    preferredHostsForReleaseCertification: number;
    preferredVerifierProviders: string[];
    // requireMultiHost / requiredHostVerdictCount mechanically reflect the
    // --requireMultiHost / --requiredHostVerdictCount planner knobs. They only
    // TIGHTEN the policy (raise the required independent-host floor); they never
    // assert that verification happened. The planned-steps executor still keeps
    // multiHostVerified=false because it collects no host verdicts itself.
    requireMultiHost: boolean;
    requiredHostVerdictCount: number;
    requiredReviewWaveCount?: number;
  };
  plannerDigest: string;
  // Forced-scope provenance copied from the draft so the forked idempotency
  // scope is visible in the job plan JSON and folded into jobPlanDigest.
  forceNewRun?: boolean;
  forceNewRunReason?: string;
  forceScope?: { token: string; scopeDigest: string };
  jobPlanDigest: string;
  status: 'planned' | 'blocked';
  blockedReason?: string;
}

export interface PlannerRunRecord {
  schemaVersion: 'lattice.planner_run_record.v1';
  plannerRunId: string;
  draft?: PlannerDraft;
  review?: PlannerReviewResult;
  storyId?: string;
  jobPlan?: JobPlan;
  execution?: unknown;
  completion?: unknown;
  answersDigest?: string;
  confirmationDigest?: string;
  decisionReceiptDigests: string[];
  finalStatus: 'drafted' | 'paused' | 'planned' | 'blocked' | 'executed';
  updatedAt: string;
}

export interface PlannerDraftArgs {
  request?: string;
  requestFile?: string;
  interactionMode?: PlannerInteractionMode;
  mode?: PlannerRunMode;
  until?: PlannerUntilPhase;
  workflow?: 'standard' | 'source-aligned-redevelopment' | 'source_aligned_redevelopment';
  sourceRepo?: string;
  targetProject?: string;
  targetProjectName?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  renameMap?: Record<string, string> | string;
  includedPaths?: string[] | string;
  excludedPaths?: string[] | string;
  languageAdapterPolicy?: Record<string, unknown> | string;
  semanticMappingPolicy?: Record<string, unknown> | string;
  parityOraclePolicy?: Record<string, unknown> | string;
  alignmentVerificationIntent?: string[] | string;
  /**
   * Explicit provider opt-in. When this selects a real provider (codex/claude) and
   * lists it in allowedProviders, the planner emits a `provider.codex` /
   * `provider.claude` bounded step instead of `provider.fake`. Accepts a parsed
   * object or a JSON string (CLI). Omitted → fail-closed fake-only policy.
   */
  providerPolicy?: PlannerProviderPolicyInput | string;
  allowUnattendedPlanning?: boolean;
  forceNewRun?: boolean;
  forceNewRunReason?: string;
}

export interface PlannerStoreLike {
  readStory(storyId: string): StoryInfo;
  storyExists(storyId: string): boolean;
  listStoryIds(): string[];
  appendProcessEvent(storyId: string, event: Record<string, unknown>): void;
}

export function plannerStateDir(root: string): string {
  return join(root, LATTICE_DIR, 'planner', 'runs');
}

export function readPlannerRun(root: string, plannerRunId: string): PlannerRunRecord {
  const filename = `${plannerRunId}.json`;
  const currentPath = join(plannerStateDir(root), filename);
  return JSON.parse(readFileSync(currentPath, 'utf8')) as PlannerRunRecord;
}

export function writePlannerRun(root: string, record: PlannerRunRecord): void {
  const dir = plannerStateDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.plannerRunId}.json`), JSON.stringify(record, null, 2) + '\n', 'utf8');
}

export function listPlannerRuns(root: string): PlannerRunRecord[] {
  const records = new Map<string, PlannerRunRecord>();
  for (const dir of [plannerStateDir(root)]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter(entry => entry.endsWith('.json'))) {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as PlannerRunRecord;
      records.set(record.plannerRunId, record);
    }
  }
  return [...records.values()]
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

function sha(value: unknown): string {
  return canonicalDigest(value);
}

function textDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function slug(text: string): string {
  const ascii = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (ascii || 'lattice-planner-run').slice(0, 52);
}

function normalizeInteractionMode(value: unknown): PlannerInteractionMode {
  return PLANNER_INTERACTION_MODES.includes(value as PlannerInteractionMode) ? value as PlannerInteractionMode : 'autonomous';
}

function normalizeRunMode(value: unknown): PlannerRunMode {
  return value === 'local' ? 'local' : 'local';
}

function normalizeUntil(value: unknown): PlannerUntilPhase {
  return PLANNER_UNTIL_PHASES.includes(value as PlannerUntilPhase) ? value as PlannerUntilPhase : 'DONE';
}

function normalizeWorkflow(value: unknown): DevelopmentWorkflow {
  if (value === 'source-aligned-redevelopment' || value === 'source_aligned_redevelopment') return 'source_aligned_redevelopment';
  return 'standard';
}

function parseMaybeJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim()) return JSON.parse(value) as Record<string, unknown>;
  return undefined;
}

function parseStringList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) return (JSON.parse(trimmed) as unknown[]).map(String).filter(Boolean);
    return trimmed.split(',').map(item => item.trim()).filter(Boolean);
  }
  return [];
}

function defaultPlannerPolicy(args: PlannerDraftArgs, mode: PlannerRunMode, interactionMode: PlannerInteractionMode): PlannerPolicy {
  const allowUnattendedPlanning = args.allowUnattendedPlanning === true || mode === 'local';
  return {
    allowUnattendedPlanning,
    allowedInteractionModes: ['autonomous', 'interview', 'decision-gated'],
    allowExternalDeployment: false,
    allowRemotePush: false,
    allowDestructiveGit: false,
    allowMultiStoryPlanning: false,
    requiresConfirmationBeforeStoryCreate: interactionMode === 'interview' || !allowUnattendedPlanning,
    maxStoriesPerRequest: 1,
    forceNewRunAllowed: false,
    maxPlannerQuestions: 10,
    maxPlannerAttempts: 3,
    maxPlannedSteps: 24,
    maxProviderCalls: 8,
    maxReviewWaves: 3,
    maxWallClockMs: 60 * 60 * 1000,
    maxTokenOrCostBudget: 0,
  };
}

function verificationIntentFor(title: string): VerificationIntent {
  return {
    happy: [{ id: `${slug(title)}:happy`, desc: `Verify the requested behavior for "${title}" succeeds on the normal path.`, type: 'cli', requiredIn: 'balanced', priority: 'must' }],
    edge: [{ id: `${slug(title)}:edge`, desc: `Verify bounded failure or missing-input handling for "${title}".`, type: 'cli', requiredIn: 'strict', priority: 'should' }],
    adversarial: [{ id: `${slug(title)}:adversarial`, desc: 'Verify the implementation does not overclaim DONE or bypass Proofbound evidence gates.', type: 'logic', requiredIn: 'strict', priority: 'must' }],
  };
}

function buildChecklist(request: string, workflow: DevelopmentWorkflow): PlannerDraft['checklist'] {
  if (workflow === 'source_aligned_redevelopment') {
    return [
      {
        title: 'Resolve source and target language adapters',
        context: 'Resolve canonical source/target language ids through languageAdapterPolicy before provider execution; missing adapters block or record scoped gaps by policy.',
        relatedDocs: ['docs/requirements/decisions/proof-admissibility.md'],
        verificationIntent: verificationIntentFor('Resolve source and target language adapters'),
      },
      {
        title: 'Extract neutral manifests and semantic alignment maps',
        context: 'Produce source/target neutral manifests plus module/function alignment maps from deterministic extraction, not provider prose.',
        relatedDocs: ['docs/requirements/decisions/proof-admissibility.md'],
        verificationIntent: verificationIntentFor('Extract neutral manifests and semantic alignment maps'),
      },
      {
        title: 'Run target-runnable parity checks and record gaps',
        context: 'Use target build/test/CLI/API/golden checks where possible; source-only behavior records gapList or blocks without burning repair loops.',
        relatedDocs: ['docs/requirements/decisions/proof-admissibility.md'],
        verificationIntent: verificationIntentFor('Run target-runnable parity checks and record gaps'),
      },
    ];
  }
  const compact = request.length > 140 ? `${request.slice(0, 137)}...` : request;
  return [
    {
      title: 'Implement the requested Proofbound change',
      context: `Implement the smallest verifiable scope for: ${compact}`,
      relatedDocs: ['docs/requirements/decisions/proof-admissibility.md'],
      verificationIntent: verificationIntentFor('Implement the requested Proofbound change'),
    },
    {
      title: 'Verify evidence and DONE boundaries',
      context: 'Run validation and prove local DONE and local proof-admissibility flags are not overclaimed.',
      relatedDocs: ['docs/requirements/decisions/proof-admissibility.md'],
      verificationIntent: verificationIntentFor('Verify evidence and DONE boundaries'),
    },
  ];
}

function interviewQuestions(): PlannerQuestion[] {
  return [
    { id: 'Q-001', question: 'What user-visible outcome must be true at DONE?', why: 'Prevents vague or engineering-only completion.' },
    { id: 'Q-002', question: 'Which files, modules, or command surfaces are in scope?', why: 'Prevents hidden scope expansion.' },
    { id: 'Q-003', question: 'Which behavior must remain unchanged?', why: 'Protects regression boundaries.' },
    { id: 'Q-004', question: 'Which validation command proves the outcome?', why: 'Binds the plan to evidence.' },
    { id: 'Q-005', question: 'Are external services, credentials, deployment, or destructive git operations required?', why: 'Routes high-risk work to decisions or blocked state.' },
    { id: 'Q-006', question: 'What should be explicitly deferred as not required now?', why: 'Applies dont optimize for the sake of optimization.' },
  ];
}

function decisionQuestions(): PlannerQuestion[] {
  return [
    { id: 'D-001', question: 'Confirm whether this run may create or mutate a Proofbound Story/job.', why: 'Story/job creation changes workflow state.' },
  ];
}

function buildSourceSpec(args: PlannerDraftArgs): SourceAlignedRedevelopmentSpec | undefined {
  if (normalizeWorkflow(args.workflow) !== 'source_aligned_redevelopment') return undefined;
  const renameMap = parseMaybeJsonObject(args.renameMap) as Record<string, string> | undefined;
  return {
    workflow: 'source-aligned-redevelopment',
    sourceRepo: args.sourceRepo ?? '',
    targetProject: args.targetProject ?? '',
    targetProjectName: args.targetProjectName ?? '',
    sourceLanguage: args.sourceLanguage ?? '',
    targetLanguage: args.targetLanguage ?? '',
    renameMap: renameMap ?? {},
    includedPaths: parseStringList(args.includedPaths),
    excludedPaths: parseStringList(args.excludedPaths),
    languageAdapterPolicy: parseMaybeJsonObject(args.languageAdapterPolicy),
    semanticMappingPolicy: parseMaybeJsonObject(args.semanticMappingPolicy),
    parityOraclePolicy: parseMaybeJsonObject(args.parityOraclePolicy),
    alignmentVerificationIntent: parseStringList(args.alignmentVerificationIntent),
    sourceLimits: {
      maxSourceFiles: 500,
      maxSourceBytes: 5_000_000,
      maxMappedModules: 200,
      maxMappedFunctions: 2_000,
      maxAlignmentPasses: 3,
      maxGapRepairAttempts: 1,
    },
  };
}

const PROVIDER_NAMES: ReadonlyArray<'fake' | 'codex' | 'claude'> = ['fake', 'codex', 'claude'];

function providerNameList(value: unknown): Array<'fake' | 'codex' | 'claude'> {
  return Array.isArray(value)
    ? value.filter((x): x is 'fake' | 'codex' | 'claude' => PROVIDER_NAMES.includes(x as never))
    : [];
}

/**
 * Normalize the caller's provider preference into a fail-closed JobProviderPolicy.
 *
 * Fail-closed rules (so an explicit opt-in can never produce an inconsistent or
 * over-claiming policy that `assertJobPolicyConsistency` would reject downstream):
 *  - no input, or an unrecognized primary → the fake-only default;
 *  - the primary provider is always forced into allowedProviders;
 *  - fallbacks must be allowed and distinct from the primary;
 *  - production-DONE providers are restricted to real providers that are allowed;
 *  - `fake` can never be a production-DONE provider unless explicitly permitted.
 */
function resolveDraftProviderPolicy(input: PlannerProviderPolicyInput | string | undefined): JobProviderPolicy {
  const raw = typeof input === 'string'
    ? (input.trim() ? JSON.parse(input) as PlannerProviderPolicyInput : undefined)
    : input;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_FAKE_PROVIDER_POLICY };

  const primaryProvider = PROVIDER_NAMES.includes(raw.primaryProvider as never)
    ? raw.primaryProvider as 'fake' | 'codex' | 'claude'
    : 'fake';

  const allowed = new Set<'fake' | 'codex' | 'claude'>(providerNameList(raw.allowedProviders));
  allowed.add(primaryProvider); // primary is always allowed
  const allowedProviders = PROVIDER_NAMES.filter(p => allowed.has(p));

  const fallbackProviders = providerNameList(raw.fallbackProviders)
    .filter(p => allowed.has(p) && p !== primaryProvider);

  const allowFakeProviderForProductionDone = raw.allowFakeProviderForProductionDone === true;
  const productionDoneProviders = (Array.isArray(raw.productionDoneProviders)
    ? raw.productionDoneProviders.filter((x): x is 'codex' | 'claude' => x === 'codex' || x === 'claude')
    : []).filter(p => allowed.has(p));

  const credentialsEnvAllowlist = Array.isArray(raw.credentialsEnvAllowlist)
    ? raw.credentialsEnvAllowlist.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : [];
  const secretRefs = Array.isArray(raw.secretRefs)
    ? raw.secretRefs.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : [];

  return {
    primaryProvider,
    allowedProviders,
    fallbackProviders,
    productionDoneProviders,
    allowFakeProviderForProductionDone,
    credentialsEnvAllowlist,
    secretRefs,
    providerAvailability: 'fail_closed',
  };
}

export function buildPlannerDraft(root: string, args: PlannerDraftArgs = {}, now = new Date()): PlannerDraft {
  const requestFile = args.requestFile ? resolve(root, args.requestFile) : undefined;
  const request = args.request ?? (requestFile ? readFileSync(requestFile, 'utf8') : '');
  const interactionMode = normalizeInteractionMode(args.interactionMode);
  const mode = normalizeRunMode(args.mode);
  const until = normalizeUntil(args.until);
  const developmentWorkflow = normalizeWorkflow(args.workflow);
  const policy = defaultPlannerPolicy(args, mode, interactionMode);
  // --forceNewRun fails closed without a non-empty reason: a forced fork must be
  // attributable, so an empty/whitespace reason is rejected before any scope is
  // computed. This is enforced here (not just in Zod) so every call path — CLI,
  // planner_run, direct buildPlannerDraft — blocks identically.
  const forceNewRun = args.forceNewRun === true;
  const forceNewRunReason = typeof args.forceNewRunReason === 'string' ? args.forceNewRunReason.trim() : '';
  if (forceNewRun && forceNewRunReason.length === 0) {
    throw new Error('forceNewRun requires a non-empty forceNewRunReason: a forced new idempotency scope must carry an attributable reason');
  }
  const digest = textDigest(request);
  // Intake digest (naturalLanguageDigest) stays request-only so identical
  // inline/requestFile requests keep collapsing onto the same default scope.
  // The forced scope digest mixes the reason in, forking plannerRunId / Story /
  // job plan WITHOUT changing the intake identity.
  const forceScopeToken = forceNewRun ? textDigest(`force:${forceNewRunReason}`).slice(0, 8) : undefined;
  const scopeDigest = forceNewRun ? textDigest(`${digest}force:${forceNewRunReason}`) : digest;
  const plannerRunId = forceNewRun
    ? `prun-${scopeDigest.slice(0, 12)}-${interactionMode}-force-${forceScopeToken}`
    : `prun-${digest.slice(0, 12)}-${interactionMode}`;
  const title = developmentWorkflow === 'source_aligned_redevelopment'
    ? `Source-aligned redevelopment to ${args.targetLanguage || 'target language'}`
    : request.split(/\n+/)[0]?.trim().slice(0, 96) || 'Proofbound planner request';
  // Fork the Story name on a forced run so story_create's normalized-name
  // idempotency does NOT reuse the default Story; a repeated forced run with the
  // same reason still collapses (deterministic), so forced scopes stay idempotent.
  const storyName = forceNewRun ? `${slug(title)}-force-${forceScopeToken}` : slug(title);
  const storyDraft = {
    name: storyName,
    title,
    description: request || 'Planner request was empty; review must block until a concrete request is provided.',
    type: 'feature' as StoryType,
    priority: 'high',
  };
  const sourceSpec = buildSourceSpec(args);
  const questions = interactionMode === 'interview' ? interviewQuestions() : [];
  const requiredDecisions = interactionMode === 'decision-gated' ? decisionQuestions() : [];
  const draftBase = {
    schemaVersion: 'lattice.planner_draft.v1' as const,
    plannerRunId,
    plannerDraftId: `pdraft-${scopeDigest.slice(0, 16)}`,
    createdAt: now.toISOString(),
    interactionMode,
    mode,
    until,
    developmentWorkflow,
    naturalLanguageDigest: digest,
    request,
    ...(args.requestFile ? { requestFile: args.requestFile } : {}),
    storyDraft,
    checklist: buildChecklist(request, developmentWorkflow),
    plannerPolicy: policy,
    providerPolicy: resolveDraftProviderPolicy(args.providerPolicy),
    ...(sourceSpec ? { sourceAlignedRedevelopmentSpec: sourceSpec } : {}),
    questions,
    requiredDecisions,
    assumptions: interactionMode === 'autonomous' ? ['Low-risk ambiguity may be recorded as explicit assumptions; high-risk ambiguity blocks or uses a host decision wave.'] : [],
    scopeQuestions: request.trim() ? [] : [{ id: 'SQ-001', question: 'Provide a concrete natural-language request.', why: 'Planner cannot create a verifiable Story from an empty request.' }],
    deferredOptimizations: ['Unrequested refactors, architecture rewrites, and nice-to-have UX/performance work are deferred unless required by verification or safety policy.'],
    ...(forceNewRun ? { forceNewRun: true, forceNewRunReason, forceScope: { token: forceScopeToken!, scopeDigest } } : {}),
    status: (questions.length > 0 || requiredDecisions.length > 0) ? 'paused' as const : 'drafted' as const,
    pauseReason: questions.length > 0 ? 'interview_questions' as const : requiredDecisions.length > 0 ? 'major_decision_required' as const : undefined,
  };
  return {
    ...draftBase,
    plannerDigest: sha(draftBase),
  };
}

function hasPlaceholder(value: string): boolean {
  return /\b(TBD|TODO|implement later|placeholder)\b/i.test(value);
}

function isTooVague(value: string): boolean {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length < 4) return true;
  return /^(build|make|create|fix|improve|optimize)\s+(app|thing|project|all|everything)$/i.test(value.trim());
}

function validateSourceSpec(spec: SourceAlignedRedevelopmentSpec | undefined): PlannerReviewIssue[] {
  if (!spec) return [];
  const issues: PlannerReviewIssue[] = [];
  const required: Array<[keyof SourceAlignedRedevelopmentSpec, string]> = [
    ['sourceRepo', 'sourceRepo is required'],
    ['targetProject', 'targetProject is required'],
    ['targetProjectName', 'targetProjectName is required'],
    ['sourceLanguage', 'sourceLanguage is required'],
    ['targetLanguage', 'targetLanguage is required'],
  ];
  for (const [key, message] of required) {
    if (!String(spec[key] ?? '').trim()) issues.push({ id: `SRC-${String(key)}`, severity: 'blocker', category: 'source-aligned-redevelopment', message });
  }
  if (!spec.languageAdapterPolicy) issues.push({ id: 'SRC-languageAdapterPolicy', severity: 'blocker', category: 'source-aligned-redevelopment', message: 'languageAdapterPolicy is required and cannot be inferred from provider prose' });
  if (!spec.semanticMappingPolicy) issues.push({ id: 'SRC-semanticMappingPolicy', severity: 'blocker', category: 'source-aligned-redevelopment', message: 'semanticMappingPolicy is required and cannot be inferred from provider prose' });
  if (!spec.parityOraclePolicy) issues.push({ id: 'SRC-parityOraclePolicy', severity: 'blocker', category: 'source-aligned-redevelopment', message: 'parityOraclePolicy is required and cannot be inferred from provider prose' });
  if (spec.alignmentVerificationIntent.length === 0) issues.push({ id: 'SRC-alignmentVerificationIntent', severity: 'blocker', category: 'source-aligned-redevelopment', message: 'alignmentVerificationIntent[] is required' });
  if (spec.includedPaths.length === 0) issues.push({ id: 'SRC-includedPaths', severity: 'warning', category: 'source-aligned-redevelopment', message: 'includedPaths[] is empty; planner should keep scope narrow and explicit' });
  return issues;
}

export function reviewPlannerDraft(draft: PlannerDraft, now = new Date()): PlannerReviewResult {
  const issues: PlannerReviewIssue[] = [];
  if (!draft.request.trim()) issues.push({ id: 'REQ-empty', severity: 'blocker', category: 'request', message: 'request is empty' });
  if (isTooVague(draft.request)) issues.push({ id: 'REQ-vague', severity: 'blocker', category: 'request', message: 'request is too vague to verify; produce scopeQuestions[] instead of guessing' });
  if (hasPlaceholder(JSON.stringify(draft))) issues.push({ id: 'REQ-placeholder', severity: 'blocker', category: 'structured-output', message: 'planner output contains placeholder/TODO wording' });
  if (!draft.plannerPolicy.allowedInteractionModes.includes(draft.interactionMode)) {
    issues.push({ id: 'POL-mode', severity: 'blocker', category: 'policy', message: `interactionMode ${draft.interactionMode} is not allowed by plannerPolicy` });
  }
  if (draft.checklist.some(item => item.verificationIntent.happy.length === 0 || item.verificationIntent.adversarial.length === 0)) {
    issues.push({ id: 'CHK-verification', severity: 'blocker', category: 'checklist', message: 'every checklist item must have happy and adversarial verification intent' });
  }
  issues.push(...validateSourceSpec(draft.sourceAlignedRedevelopmentSpec));
  const blockers = issues.filter(issue => issue.severity === 'blocker');
  return {
    schemaVersion: 'lattice.planner_review.v1',
    plannerRunId: draft.plannerRunId,
    plannerDraftId: draft.plannerDraftId,
    reviewedAt: now.toISOString(),
    status: blockers.length === 0 ? 'pass' : 'blocked',
    issueCount: issues.length,
    issues,
    plannerDigest: draft.plannerDigest,
  };
}

// Bounded, non-interactive argv the planner emits for a real provider step. It is
// intentionally minimal (it references the story, not the full request) so the
// argv carries no context that could leak — the executor digests it and never
// surfaces it raw. `fake` needs no argv (it is deterministic and spawns nothing).
function providerStepArgv(provider: 'codex' | 'claude', storyId: string): string[] {
  const prompt = `Implement the smallest scoped step for Proofbound story ${storyId} per its checklist; do not over-optimize.`;
  return provider === 'codex'
    ? ['exec', '--skip-git-repo-check', prompt]
    : ['-p', prompt, '--output-format', 'json'];
}

/**
 * Build the single bounded provider step. The step TYPE and `provider` field are
 * driven by the resolved provider policy: a real provider (codex/claude) yields a
 * `provider.codex` / `provider.claude` step with a bounded argv; `fake` yields the
 * deterministic, fixtures-only `provider.fake` step that spawns nothing.
 */
function buildProviderStep(provider: 'fake' | 'codex' | 'claude', storyId: string): PlannedStep {
  const common = {
    stepId: 'step-003-provider',
    title: 'Run bounded provider',
    cwdPolicy: 'story-worktree' as const,
    timeoutMs: 300_000,
    maxAttempts: 1,
    requiresCleanWorktree: true,
    producesEvidence: true,
    blocksUntilEvidenceUploaded: true,
    evidenceBinding: `${storyId}:provider`,
  };
  if (provider === 'fake') {
    return {
      ...common,
      type: 'provider.fake',
      purpose: 'Execute the smallest scoped implementation step; fake provider is deterministic for smoke and fixtures.',
      provider: 'fake',
      args: { operation: 'implement', antiOverOptimization: true },
    };
  }
  const stepType = provider === 'codex' ? 'provider.codex' : 'provider.claude';
  return {
    ...common,
    type: stepType,
    purpose: `Execute the smallest scoped implementation step through the bounded ${provider} provider; output is captured as digests and is never validation or gate evidence.`,
    provider,
    args: { operation: 'implement', antiOverOptimization: true, argv: providerStepArgv(provider, storyId) },
  };
}

export function buildPlannedSteps(draft: PlannerDraft, storyId: string): PlannedStep[] {
  const base: PlannedStep[] = [
    {
      stepId: 'step-001-story-resolve',
      type: 'lattice.command',
      title: 'Resolve Story context',
      purpose: 'Load Story, checklist, related docs, and current lifecycle state.',
      cwdPolicy: 'story-worktree',
      timeoutMs: 30_000,
      maxAttempts: 1,
      requiresCleanWorktree: false,
      producesEvidence: true,
      blocksUntilEvidenceUploaded: false,
      evidenceBinding: `${storyId}:context`,
      args: { operation: 'story.resolve', storyId },
    },
    {
      stepId: 'step-002-context-read',
      type: 'lattice.command',
      title: 'Read context',
      purpose: 'Read auxiliary docs and verification intent before provider execution.',
      cwdPolicy: 'read-only',
      timeoutMs: 30_000,
      maxAttempts: 1,
      requiresCleanWorktree: false,
      producesEvidence: true,
      blocksUntilEvidenceUploaded: false,
      evidenceBinding: `${storyId}:context-pack`,
      args: { operation: 'context.read', relatedDocs: draft.checklist.flatMap(item => item.relatedDocs) },
    },
  ];
  if (draft.developmentWorkflow === 'source_aligned_redevelopment') {
    if (!draft.sourceAlignedRedevelopmentSpec) {
      throw new Error('source_aligned_redevelopment workflow requires an explicit sourceAlignedRedevelopmentSpec; refusing to plan with an implicit policy');
    }
    for (const [index, operation] of [
      'language.resolve_adapters',
      'source.extract_manifest',
      'target.extract_manifest',
      'source.compare_alignment',
      'source.verify_rename_map',
      'source.build_parity_oracles',
      'target.run_parity_oracles',
      'source.verify_license_notices',
      'source.record_gaps',
    ].entries()) {
      base.push({
        stepId: `step-redev-${String(index + 1).padStart(2, '0')}`,
        type: 'lattice.command',
        title: operation,
        purpose: `Run source-aligned redevelopment operation ${operation}.`,
        cwdPolicy: 'story-worktree',
        timeoutMs: 120_000,
        maxAttempts: 1,
        requiresCleanWorktree: operation.startsWith('target.'),
        producesEvidence: true,
        blocksUntilEvidenceUploaded: true,
        evidenceBinding: `${storyId}:${operation}`,
        args: { operation, sourceAlignedRedevelopmentSpec: draft.sourceAlignedRedevelopmentSpec },
      });
    }
  }
  base.push(
    buildProviderStep(draft.providerPolicy.primaryProvider, storyId),
    {
      stepId: 'step-004-validate',
      type: 'validate.run',
      title: 'Run validation',
      purpose: 'Run validation commands bound to checklist coverage.',
      cwdPolicy: 'story-worktree',
      timeoutMs: 180_000,
      maxAttempts: 2,
      requiresCleanWorktree: false,
      producesEvidence: true,
      blocksUntilEvidenceUploaded: true,
      validationBinding: `${storyId}:validation`,
      repairBinding: `${storyId}:repair`,
      evidenceBinding: `${storyId}:validation`,
      args: { operation: 'validate', storyId },
    },
    {
      stepId: 'step-005-gate',
      type: 'gate.evaluate',
      title: 'Evaluate gate',
      purpose: 'Evaluate local proof-admissibility gate without accepting prose as evidence.',
      cwdPolicy: 'project-root',
      timeoutMs: 120_000,
      maxAttempts: 1,
      requiresCleanWorktree: false,
      producesEvidence: true,
      blocksUntilEvidenceUploaded: true,
      evidenceBinding: `${storyId}:gate`,
      args: { operation: 'gate.evaluate', mode: 'local', receiptRequired: false },
    },
    {
      stepId: 'step-006-stop-summary',
      type: 'stop.summary',
      title: 'Write stop summary',
      purpose: 'Produce auditable final status, blocked reason, local evidence refs, verdict refs, and next action.',
      cwdPolicy: 'project-root',
      timeoutMs: 30_000,
      maxAttempts: 1,
      requiresCleanWorktree: false,
      producesEvidence: true,
      blocksUntilEvidenceUploaded: false,
      evidenceBinding: `${storyId}:summary`,
      args: { operation: 'stop.summary' },
    },
  );
  return base;
}

// Cross-field guard: a JobPlan must never overclaim what was actually achieved.
function assertDoneClaimNotOverclaimed(plan: JobPlan): JobPlan {
  if (plan.mode !== 'local') {
    throw new Error('job plan mode must be local; remote server job plans are retired');
  }
  return plan;
}

/**
 * Build the conservative, fail-closed JobPlan policy blocks. The planner never
 * enables real providers, production-DONE eligibility, or worktree repair on its
 * own; those require explicit local policy and lifecycle evidence.
 */
function buildJobPolicyBlocks(draft: PlannerDraft, plannedSteps: PlannedStep[]): {
  providerPolicy: JobProviderPolicy;
  worktreePolicy: JobWorktreePolicy;
  retryPolicy: JobRetryPolicy;
  stopPolicy: JobStopPolicy;
  budgetPolicy: JobBudgetPolicy;
  lease: JobLease;
  evidencePolicy: JobEvidencePolicy;
} {
  return {
    // The provider policy is resolved once at draft time (fail-closed fake by
    // default) and reused here so the emitted provider step and the JobPlan policy
    // can never disagree about which provider is allowed to run.
    providerPolicy: { ...draft.providerPolicy },
    worktreePolicy: {
      resolver: 'lattice.story.resolve',
      requiresAuthoritativeWorktree: false,
      allowWorktreeRepair: false,
      allowedPathRoots: [],
      forbiddenPathGlobs: [...FORBIDDEN_WORKTREE_GLOBS],
      requiresCleanWorktree: false,
      preserveUnrelatedDirtyChanges: true,
      requireGitStatusEvidence: true,
    },
    retryPolicy: {
      maxAttemptsPerStep: 2,
      maxRepairAttempts: 1,
      maxNoProgressIterations: 2,
      retryableFailureKinds: ['retryable_failure'],
      repairAllowed: false,
    },
    stopPolicy: {
      maxSteps: Math.max(plannedSteps.length, 1),
      maxWallClockMs: draft.plannerPolicy.maxWallClockMs,
      onValidationFailure: 'return_to_dev',
      onProviderFailure: 'retry_then_block',
      onGateFailure: 'block',
      onDirtyWorktree: 'block',
      onLeaseUnsafe: 'block',
      onMultiHostDisagreement: 'block',
    },
    budgetPolicy: {
      maxWallClockMs: draft.plannerPolicy.maxWallClockMs,
      maxTokenOrCostBudget: draft.plannerPolicy.maxTokenOrCostBudget,
      maxProviderCalls: draft.plannerPolicy.maxProviderCalls,
    },
    lease: {
      leaseId: null,
      leasedByRunnerId: null,
      leasedBySessionId: null,
      leaseExpiresAt: null,
      leaseTtlMs: LEASE_DEFAULT_TTL_MS,
      renewalThresholdMs: LEASE_DEFAULT_RENEWAL_MS,
      graceMs: LEASE_DEFAULT_GRACE_MS,
      leaseVersion: 0,
    },
    evidencePolicy: {
      requiredEvidenceKinds: [...REQUIRED_EVIDENCE_KINDS],
      redactionRequired: true,
      retentionClassByKind: { ...DEFAULT_RETENTION_BY_KIND },
      allowContinueWithoutEvidence: false,
      checklistCoverageRequired: true,
    },
  };
}

// Reject any JobPlan whose machine-readable policy blocks are missing, ambiguous,
// or suspicious. This is the JobPlan-level "review" gate (§B5: schema validation
// before execution): provider fallback, worktree, retry/stop separation, lease
// renewal, receipt, evidence, and multi-host invariants must all be unambiguous
// before a plan is treated as planned. It throws so a bad plan can never be
// silently executed, mirroring assertDoneClaimNotOverclaimed.
export function assertJobPolicyConsistency(plan: JobPlan): JobPlan {
  function fail(msg: string): never {
    throw new Error(`job policy inconsistency: ${msg}`);
  }

  const { providerPolicy: pp, worktreePolicy: wt, retryPolicy: rpRaw, stopPolicy: spRaw, lease, evidencePolicy: ep } = plan;
  if (!pp || !wt || !rpRaw || !spRaw || !lease || !ep) {
    fail('one or more required policy blocks are missing (providerPolicy/worktreePolicy/retryPolicy/stopPolicy/lease/evidencePolicy)');
  }

  if (pp.providerAvailability !== 'fail_closed') fail('providerPolicy.providerAvailability must be fail_closed');
  if (!pp.allowedProviders.includes(pp.primaryProvider)) fail('providerPolicy.primaryProvider must be listed in allowedProviders');
  for (const fb of pp.fallbackProviders) {
    if (!pp.allowedProviders.includes(fb)) fail(`providerPolicy fallback ${fb} is not in allowedProviders; fallback is only allowed to an allowed provider`);
    if (fb === pp.primaryProvider) fail('providerPolicy.primaryProvider must not also appear in fallbackProviders');
  }
  if (!pp.allowFakeProviderForProductionDone && pp.productionDoneProviders.some(p => (p as string) === 'fake')) {
    fail('fake provider cannot be a production-DONE provider unless allowFakeProviderForProductionDone is true');
  }

  if (wt.resolver !== 'lattice.story.resolve') fail('worktreePolicy.resolver must be lattice.story.resolve');
  if (wt.preserveUnrelatedDirtyChanges !== true) fail('worktreePolicy.preserveUnrelatedDirtyChanges must remain true');
  if (wt.requireGitStatusEvidence !== true) fail('worktreePolicy.requireGitStatusEvidence must remain true');

  const rp = rpRaw as JobRetryPolicy & Record<string, unknown>;
  const sp = spRaw as JobStopPolicy & Record<string, unknown>;
  for (const key of STOP_ONLY_KEYS) {
    if (key in rp) fail(`retryPolicy must not carry stopPolicy field "${key}" (§B5: retry/stop fields must not be mixed)`);
  }
  for (const key of RETRY_ONLY_KEYS) {
    if (key in sp) fail(`stopPolicy must not carry retryPolicy field "${key}" (§B5: retry/stop fields must not be mixed)`);
  }
  if (rp.maxAttemptsPerStep < 1) fail('retryPolicy.maxAttemptsPerStep must be >= 1');
  if (rp.maxRepairAttempts < 0) fail('retryPolicy.maxRepairAttempts must be >= 0');
  if (rp.maxNoProgressIterations < 1) fail('retryPolicy.maxNoProgressIterations must be >= 1');
  if (sp.maxSteps < 1) fail('stopPolicy.maxSteps must be >= 1');
  if (sp.maxWallClockMs <= 0) fail('stopPolicy.maxWallClockMs must be > 0');

  // budgetPolicy (X6): travels with planner-built plans. Validate when present so a
  // negative / non-finite limit can never silently disable a bound (0 = no limit by
  // design, e.g. an unknown token budget). Absent block stays tolerated for legacy
  // hand-built fixtures; the executor resolves limits defensively regardless.
  const bp = plan.budgetPolicy;
  if (bp) {
    const finiteNonNeg = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (!finiteNonNeg(bp.maxWallClockMs)) fail('budgetPolicy.maxWallClockMs must be a finite number >= 0 (0 disables the wall-clock budget)');
    if (!finiteNonNeg(bp.maxTokenOrCostBudget)) fail('budgetPolicy.maxTokenOrCostBudget must be a finite number >= 0 (0 disables the token/cost budget)');
    if (!finiteNonNeg(bp.maxProviderCalls)) fail('budgetPolicy.maxProviderCalls must be a finite number >= 0 (0 disables the provider-call budget)');
  }

  if (lease.leaseTtlMs <= 0) fail('lease.leaseTtlMs must be > 0');
  if (lease.renewalThresholdMs <= 0) fail('lease.renewalThresholdMs must be > 0');
  if (lease.renewalThresholdMs >= lease.leaseTtlMs) fail('lease.renewalThresholdMs must be < leaseTtlMs so renewal happens before expiry');
  if (lease.graceMs < 0) fail('lease.graceMs must be >= 0');
  if (lease.leaseVersion < 0) fail('lease.leaseVersion must be >= 0');

  if (ep.requiredEvidenceKinds.length === 0) fail('evidencePolicy.requiredEvidenceKinds must not be empty');
  for (const [kind, cls] of Object.entries(ep.retentionClassByKind)) {
    if (!EVIDENCE_RETENTION_CLASSES.includes(cls)) fail(`evidencePolicy.retentionClassByKind["${kind}"] has unknown retention class "${cls}"`);
  }

  const mh = plan.multiHostPolicy;
  if (mh.minIndependentHosts < MULTI_HOST_FLOOR) fail(`multiHostPolicy.minIndependentHosts must be >= ${MULTI_HOST_FLOOR}`);
  if (mh.targetHostsPerWave < MULTI_HOST_FLOOR) fail(`multiHostPolicy.targetHostsPerWave must be >= ${MULTI_HOST_FLOOR}`);
  if (mh.requireMultiHost && mh.requiredHostVerdictCount < MULTI_HOST_FLOOR) fail('an active multi-host requirement must require at least the host floor');
  if (!mh.requireMultiHost && mh.requiredHostVerdictCount !== 0) fail('an inactive multi-host requirement must record zero required host verdicts');
  if (mh.requiredHostVerdictCount > mh.minIndependentHosts) fail('multiHostPolicy.requiredHostVerdictCount must not exceed minIndependentHosts');
  if (mh.requireMultiHost && (mh.requiredReviewWaveCount ?? 3) < 3) fail('an active multi-host requirement must require at least three final host-check waves');

  return plan;
}

export interface MultiHostPolicyInput {
  requireMultiHost?: boolean;
  requiredHostVerdictCount?: number;
}

// Minimum independent hosts when any multi-host requirement is active. Local
// quorum assurance fixes this floor at 2; knobs may only tighten above it.
const MULTI_HOST_FLOOR = 2;

// Mechanically project the --requireMultiHost / --requiredHostVerdictCount knobs
// onto the JobPlan.multiHostPolicy. Either an explicit --requireMultiHost flag or
// a positive --requiredHostVerdictCount activates the requirement (mirrors the
// autopilot executor's `(requireMultiHost || requiredHostVerdictCount > 0)`),
// and the required count is floored at MULTI_HOST_FLOOR once active.
function projectMultiHostPolicyKnobs(input: MultiHostPolicyInput): {
  requireMultiHost: boolean;
  requiredHostVerdictCount: number;
  minIndependentHosts: number;
} {
  const requested =
    typeof input.requiredHostVerdictCount === 'number' &&
    Number.isFinite(input.requiredHostVerdictCount) &&
    input.requiredHostVerdictCount > 0
      ? Math.floor(input.requiredHostVerdictCount)
      : 0;
  const requireMultiHost = input.requireMultiHost === true || requested > 0;
  const requiredHostVerdictCount = requireMultiHost ? Math.max(requested, MULTI_HOST_FLOOR) : 0;
  const minIndependentHosts = Math.max(MULTI_HOST_FLOOR, requiredHostVerdictCount);
  return { requireMultiHost, requiredHostVerdictCount, minIndependentHosts };
}

export function buildJobPlan(
  draft: PlannerDraft,
  storyId: string,
  _projectId = 'local-project',
  multiHostInput: MultiHostPolicyInput = {},
  _now = new Date(),
): JobPlan {
  const multiHostKnobs = projectMultiHostPolicyKnobs(multiHostInput);
  const plannedSteps = PlannedStepsSchema.parse(buildPlannedSteps(draft, storyId)) as PlannedStep[];
  if (plannedSteps.length > draft.plannerPolicy.maxPlannedSteps) {
    throw new Error(`generated ${plannedSteps.length} planned steps exceeds plannerPolicy.maxPlannedSteps=${draft.plannerPolicy.maxPlannedSteps}`);
  }
  const plannedStepsDigest = sha(plannedSteps);
  const coverageMap = draft.checklist.map((item, index) => {
    const checklistItemId = `CHK-${String(index + 1).padStart(3, '0')}`;
    return {
      checklistItemId,
      verificationIntentDigest: sha(item.verificationIntent),
      plannedStepIds: plannedSteps.map(step => step.stepId),
      validationStepIds: plannedSteps.filter(step => step.type === 'validate.run').map(step => step.stepId),
      evidenceRefs: plannedSteps.map(step => step.evidenceBinding),
      expectedArtifacts: [],
      gatePredicate: 'local validation plus required independent local verdicts when requested',
    };
  });
  const policyBlocks = buildJobPolicyBlocks(draft, plannedSteps);
  const common = {
    schemaVersion: 'lattice.job_plan.v1' as const,
    plannerRunId: draft.plannerRunId,
    storyId,
    mode: draft.mode,
    until: draft.until,
    developmentWorkflow: draft.developmentWorkflow,
    ...policyBlocks,
    plannedSteps,
    coverageMap,
    multiHostPolicy: {
      minIndependentHosts: multiHostKnobs.minIndependentHosts,
      targetHostsPerWave: 3,
      preferredHostsForReleaseCertification: 3,
      preferredVerifierProviders: ['codex', 'claude', 'gemini'],
      requireMultiHost: multiHostKnobs.requireMultiHost,
      requiredHostVerdictCount: multiHostKnobs.requiredHostVerdictCount,
      requiredReviewWaveCount: 3,
    },
    plannerDigest: draft.plannerDigest,
    ...(draft.forceNewRun ? { forceNewRun: true, forceNewRunReason: draft.forceNewRunReason, forceScope: draft.forceScope } : {}),
  };
  const jobPlanDigest = sha(common);
  return assertJobPolicyConsistency(assertDoneClaimNotOverclaimed({
    ...common,
    localRunPlan: {
      runId: `local-${draft.plannerRunId}`,
      plannedStepsDigest,
    },
    jobPlanDigest,
    status: 'planned',
  }));
}

export function sourceManifestDigest(root: string, sourceRepo: string, includedPaths: string[], excludedPaths: string[]): {
  digest: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  blocked: boolean;
  blockedReason?: string;
} {
  const sourceRoot = resolve(root, sourceRepo);
  if (!existsSync(sourceRoot)) {
    return { digest: sha({ missing: sourceRepo }), files: [], blocked: true, blockedReason: 'source_repo_missing' };
  }
  const excludes = new Set(['.git', 'node_modules', 'dist', 'build', '.env', ...excludedPaths]);
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, name.name);
      const rel = abs.slice(sourceRoot.length + 1).replace(/\\/g, '/');
      if ([...excludes].some(exclude => rel === exclude || rel.startsWith(`${exclude}/`) || name.name === exclude)) continue;
      if (name.isDirectory()) {
        walk(abs);
      } else if (name.isFile()) {
        if (includedPaths.length > 0 && !includedPaths.some(include => rel === include || rel.startsWith(`${include}/`))) continue;
        const content = readFileSync(abs);
        files.push({ path: rel, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
      }
    }
  };
  walk(sourceRoot);
  return { digest: sha(files), files, blocked: false };
}

export function writePlannerArtifact(root: string, relPath: string, value: unknown): string {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(value, null, 2) + '\n', 'utf8');
  return relPath;
}
