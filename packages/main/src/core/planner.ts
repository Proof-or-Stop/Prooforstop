import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalDigest } from './authority-signing.js';
import type { StoryInfo, StoryType, VerificationIntent } from './types.js';

export const PLANNER_INTERACTION_MODES = ['autonomous', 'interview', 'decision-gated'] as const;
export type PlannerInteractionMode = typeof PLANNER_INTERACTION_MODES[number];

export const PLANNER_RUN_MODES = ['local', 'authority'] as const;
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
  sourceAlignedRedevelopmentSpec?: SourceAlignedRedevelopmentSpec;
  questions: PlannerQuestion[];
  requiredDecisions: PlannerQuestion[];
  assumptions: string[];
  scopeQuestions: PlannerQuestion[];
  deferredOptimizations: string[];
  status: 'drafted' | 'paused';
  pauseReason?: 'interview_questions' | 'major_decision_required';
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

export interface JobPlan {
  schemaVersion: 'lattice.job_plan.v1';
  plannerRunId: string;
  storyId: string;
  mode: PlannerRunMode;
  until: PlannerUntilPhase;
  developmentWorkflow: DevelopmentWorkflow;
  localRunPlan?: {
    runId: string;
    plannedStepsDigest: string;
  };
  jobCreateRequest?: {
    projectId: string;
    storyId: string;
    plannerRunId: string;
    plannedSteps: PlannedStep[];
    mode: 'authority';
  };
  jobCreateRequestEnvelope?: {
    kind: 'authority_job_create';
    projectId: string;
    storyId: string;
    plannerRunId: string;
    authorityMode: 'enforce';
    createdAt: string;
    actorId: string;
    actorRole: string;
    actorKeyId: string;
    canonicalPayloadDigest: string;
    storyDigest: string;
    plannerDigest: string;
    plannedStepsDigest: string;
    policyDigest: string;
    idempotencyKey: string;
    signatureAlgorithm: 'ed25519';
    signature?: string;
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
    fullAuthorityDoneRequired: boolean;
  };
  plannerDigest: string;
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
  return join(root, '.koala', 'planner', 'runs');
}

export function readPlannerRun(root: string, plannerRunId: string): PlannerRunRecord {
  return JSON.parse(readFileSync(join(plannerStateDir(root), `${plannerRunId}.json`), 'utf8')) as PlannerRunRecord;
}

export function writePlannerRun(root: string, record: PlannerRunRecord): void {
  const dir = plannerStateDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.plannerRunId}.json`), JSON.stringify(record, null, 2) + '\n', 'utf8');
}

export function listPlannerRuns(root: string): PlannerRunRecord[] {
  const dir = plannerStateDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')) as PlannerRunRecord)
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
  return PLANNER_RUN_MODES.includes(value as PlannerRunMode) ? value as PlannerRunMode : 'local';
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
    adversarial: [{ id: `${slug(title)}:adversarial`, desc: 'Verify the implementation does not overclaim DONE or bypass Lattice evidence/receipt gates.', type: 'logic', requiredIn: 'strict', priority: 'must' }],
  };
}

function buildChecklist(request: string, workflow: DevelopmentWorkflow): PlannerDraft['checklist'] {
  if (workflow === 'source_aligned_redevelopment') {
    return [
      {
        title: 'Resolve source and target language adapters',
        context: 'Resolve canonical source/target language ids through languageAdapterPolicy before provider execution; missing adapters block or record scoped gaps by policy.',
        relatedDocs: ['docs/requirements/decisions/lattice-authority-live-integration.md#c2a-source-aligned-redevelopment-workflow'],
        verificationIntent: verificationIntentFor('Resolve source and target language adapters'),
      },
      {
        title: 'Extract neutral manifests and semantic alignment maps',
        context: 'Produce source/target neutral manifests plus module/function alignment maps from deterministic extraction, not provider prose.',
        relatedDocs: ['docs/requirements/decisions/lattice-authority-live-integration.md#c2a-source-aligned-redevelopment-workflow'],
        verificationIntent: verificationIntentFor('Extract neutral manifests and semantic alignment maps'),
      },
      {
        title: 'Run target-runnable parity checks and record gaps',
        context: 'Use target build/test/CLI/API/golden checks where possible; source-only behavior records gapList or blocks without burning repair loops.',
        relatedDocs: ['docs/requirements/decisions/lattice-authority-live-integration.md#c2a-source-aligned-redevelopment-workflow'],
        verificationIntent: verificationIntentFor('Run target-runnable parity checks and record gaps'),
      },
    ];
  }
  const compact = request.length > 140 ? `${request.slice(0, 137)}...` : request;
  return [
    {
      title: 'Implement the requested Lattice change',
      context: `Implement the smallest verifiable scope for: ${compact}`,
      relatedDocs: ['docs/requirements/decisions/lattice-authority-live-integration.md'],
      verificationIntent: verificationIntentFor('Implement the requested Lattice change'),
    },
    {
      title: 'Verify evidence and DONE boundaries',
      context: 'Run validation and prove local/authority DONE flags are not overclaimed.',
      relatedDocs: ['docs/requirements/decisions/lattice-authority-live-integration.md#cross-stage-closure-requirements'],
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
    { id: 'D-001', question: 'Confirm whether this run may create or mutate a Lattice Story/job.', why: 'Story/job creation changes workflow state.' },
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

export function buildPlannerDraft(root: string, args: PlannerDraftArgs = {}, now = new Date()): PlannerDraft {
  const requestFile = args.requestFile ? resolve(root, args.requestFile) : undefined;
  const request = args.request ?? (requestFile ? readFileSync(requestFile, 'utf8') : '');
  const interactionMode = normalizeInteractionMode(args.interactionMode);
  const mode = normalizeRunMode(args.mode);
  const until = normalizeUntil(args.until);
  const developmentWorkflow = normalizeWorkflow(args.workflow);
  const policy = defaultPlannerPolicy(args, mode, interactionMode);
  const digest = textDigest(request);
  const plannerRunId = `prun-${digest.slice(0, 12)}-${interactionMode}`;
  const title = developmentWorkflow === 'source_aligned_redevelopment'
    ? `Source-aligned redevelopment to ${args.targetLanguage || 'target language'}`
    : request.split(/\n+/)[0]?.trim().slice(0, 96) || 'Lattice planner request';
  const storyDraft = {
    name: slug(title),
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
    plannerDraftId: `pdraft-${digest.slice(0, 16)}`,
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
    ...(sourceSpec ? { sourceAlignedRedevelopmentSpec: sourceSpec } : {}),
    questions,
    requiredDecisions,
    assumptions: interactionMode === 'autonomous' ? ['Low-risk ambiguity may be recorded as explicit assumptions; high-risk ambiguity blocks or uses a host decision wave.'] : [],
    scopeQuestions: request.trim() ? [] : [{ id: 'SQ-001', question: 'Provide a concrete natural-language request.', why: 'Planner cannot create a verifiable Story from an empty request.' }],
    deferredOptimizations: ['Unrequested refactors, architecture rewrites, and nice-to-have UX/performance work are deferred unless required by verification or safety policy.'],
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
  if (draft.mode === 'authority' && draft.until === 'DONE' && !draft.plannerPolicy.allowUnattendedPlanning) {
    issues.push({ id: 'POL-unattended-authority', severity: 'blocker', category: 'policy', message: 'authority unattended Story/job creation requires plannerPolicy.allowUnattendedPlanning=true' });
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
    {
      stepId: 'step-003-provider',
      type: 'provider.fake',
      title: 'Run bounded provider',
      purpose: 'Execute the smallest scoped implementation step; fake provider is deterministic for smoke and fixtures.',
      cwdPolicy: 'story-worktree',
      timeoutMs: 300_000,
      maxAttempts: 1,
      requiresCleanWorktree: true,
      producesEvidence: true,
      blocksUntilEvidenceUploaded: true,
      provider: 'fake',
      evidenceBinding: `${storyId}:provider`,
      args: { operation: 'implement', antiOverOptimization: true },
    },
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
      purpose: 'Evaluate local or Authority gate without accepting prose as evidence.',
      cwdPolicy: 'project-root',
      timeoutMs: 120_000,
      maxAttempts: 1,
      requiresCleanWorktree: false,
      producesEvidence: true,
      blocksUntilEvidenceUploaded: true,
      evidenceBinding: `${storyId}:gate`,
      args: { operation: 'gate.evaluate', mode: draft.mode, receiptRequired: draft.mode === 'authority' && draft.until === 'DONE' },
    },
    {
      stepId: 'step-006-stop-summary',
      type: 'stop.summary',
      title: 'Write stop summary',
      purpose: 'Produce auditable final status, blocked reason, receipts, verdict refs, and next action.',
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
// Local plans cannot carry an authority job-create envelope, fullAuthorityDoneRequired
// is reserved for authority+DONE, and an authority+DONE plan cannot claim "planned" without an envelope.
function assertDoneClaimNotOverclaimed(plan: JobPlan): JobPlan {
  const authorityDone = plan.mode === 'authority' && plan.until === 'DONE';
  if (plan.jobCreateRequestEnvelope && plan.mode !== 'authority') {
    throw new Error('local job plan must not carry an authority job-create envelope');
  }
  if (plan.multiHostPolicy.fullAuthorityDoneRequired && !authorityDone) {
    throw new Error('fullAuthorityDoneRequired may only be set for authority DONE plans');
  }
  if (authorityDone && plan.status === 'planned' && !plan.jobCreateRequestEnvelope) {
    throw new Error('authority DONE plan claims planned status without an authority job-create envelope');
  }
  return plan;
}

export function buildJobPlan(draft: PlannerDraft, storyId: string, projectId = 'local-project', now = new Date()): JobPlan {
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
      gatePredicate: draft.mode === 'authority' && draft.until === 'DONE'
        ? 'verified native gate_decision receipt plus complete checklist coverage'
        : 'local validation plus required independent local verdicts when requested',
    };
  });
  const common = {
    schemaVersion: 'lattice.job_plan.v1' as const,
    plannerRunId: draft.plannerRunId,
    storyId,
    mode: draft.mode,
    until: draft.until,
    developmentWorkflow: draft.developmentWorkflow,
    plannedSteps,
    coverageMap,
    multiHostPolicy: {
      minIndependentHosts: 2,
      targetHostsPerWave: 3,
      preferredHostsForReleaseCertification: 3,
      preferredVerifierProviders: ['codex', 'claude', 'gemini'],
      fullAuthorityDoneRequired: draft.mode === 'authority' && draft.until === 'DONE',
    },
    plannerDigest: draft.plannerDigest,
  };
  const jobPlanDigest = sha(common);
  if (draft.mode === 'authority') {
    const payload = {
      projectId,
      storyId,
      plannerRunId: draft.plannerRunId,
      plannedSteps,
      mode: 'authority' as const,
    };
    const envelope = {
      kind: 'authority_job_create' as const,
      projectId,
      storyId,
      plannerRunId: draft.plannerRunId,
      authorityMode: 'enforce' as const,
      createdAt: now.toISOString(),
      actorId: 'lattice-cli-planner',
      actorRole: 'planner',
      actorKeyId: 'unsigned-local-planner',
      canonicalPayloadDigest: sha(payload),
      storyDigest: sha({ storyId }),
      plannerDigest: draft.plannerDigest,
      plannedStepsDigest,
      policyDigest: sha(draft.plannerPolicy),
      idempotencyKey: sha({ storyId, plannerDigest: draft.plannerDigest, plannedStepsDigest, policyVersion: 'v1' }),
      signatureAlgorithm: 'ed25519' as const,
    };
    return assertDoneClaimNotOverclaimed({
      ...common,
      jobCreateRequest: payload,
      jobCreateRequestEnvelope: envelope,
      jobPlanDigest,
      status: draft.plannerPolicy.allowUnattendedPlanning ? 'planned' : 'blocked',
      blockedReason: draft.plannerPolicy.allowUnattendedPlanning ? undefined : 'authority unattended planning is not allowed by plannerPolicy',
    });
  }
  return assertDoneClaimNotOverclaimed({
    ...common,
    localRunPlan: {
      runId: `local-${draft.plannerRunId}`,
      plannedStepsDigest,
    },
    jobPlanDigest,
    status: 'planned',
  });
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
