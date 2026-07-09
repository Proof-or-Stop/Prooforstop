import { execFileSync } from 'child_process';
import { currentMaterialHash, currentStoryFilesHash, isMaterialExcludedPath } from './evidence-freshness.js';
import {
  evaluateHostVerdictRounds,
  type HostVerdictRound,
  type IgnoredHostVerdict,
} from './host-independence.js';
import {
  REVIEW_ESCALATION_FALLBACK_ELIGIBILITIES,
  eventsWithStoryFilesHashDowngrade,
  isReviewEscalationFallbackEligibility,
  type ReviewEscalationReport,
} from './review-escalation.js';
import { isReviewerAgent } from './review-run.js';
import type { BugData, Finding, ProcessEvent, StoryInfo, TestEvidenceData, UnderstandingData } from './types.js';
import type { StoryStore } from './store.js';
import {
  buildProofAdmissibilityDiagnostic,
  proofAdmissibilityBlockingReason,
  resolveProofAdmissibilityPolicy,
  type ProofAdmissibilityDiagnostic,
} from './proof-admissibility-gates.js';

export const REVIEW_ASSURANCE_FLOOR_REQUIRED_ROUNDS = 1;
export const REVIEW_ASSURANCE_FLOOR_FAILURE_REQUIRED_ROUNDS = 3;
export const REVIEW_ASSURANCE_FLOOR_LOCAL_HOSTS_PER_ROUND = 1;
export const REVIEW_ASSURANCE_FLOOR_HIGH_RISK_REQUIRED_ROUNDS = 3;
export const REVIEW_ASSURANCE_FLOOR_HIGH_RISK_HOSTS_PER_ROUND = 2;

export type ReviewAssuranceFloorAssuranceLevel =
  | 'not-required'
  | 'local-one-round'
  | 'full-3x2'
  | 'degraded-single-host'
  | 'missing';

export type ReviewAssuranceFloorRequiredAssurance =
  | 'none'
  | 'one-local-round'
  | 'three-local-rounds'
  | 'three-round-two-hosts-or-degraded-single-host';

export interface ReviewAssuranceFloorChangedFile {
  path: string;
  materialCode: boolean;
  reason: string;
}

export interface ReviewAssuranceFloorFailureSignal {
  kind:
    | 'validation-failure'
    | 'bug'
    | 'bug-reopened'
    | 'verified-reviewer-finding'
    | 'repeated-rework';
  id?: string;
  detail: string;
}

export interface ReviewAssuranceFloorHighRiskSignal {
  kind: 'path' | 'touchpoint' | 'risk-signal' | 'priority';
  value: string;
}

export interface ReviewAssuranceFloorFallbackRecord {
  index: number;
  fallbackId?: string;
  eligibility?: string;
  reason?: string;
  evidenceRefs: string[];
  approvalRef?: string;
  materialHash?: string;
  storyFilesHash?: string;
  assuranceLevel?: string;
  valid: boolean;
  reasons: string[];
  advisories?: string[];
}

export interface ReviewAssuranceFloorReport {
  schemaVersion: 'lattice.review_assurance_floor.v1';
  storyId?: string;
  ok: boolean;
  required: boolean;
  requiredAssurance: ReviewAssuranceFloorRequiredAssurance;
  assuranceLevel: ReviewAssuranceFloorAssuranceLevel;
  materialHash: string | null;
  storyFilesHash?: string | null;
  changedFiles: ReviewAssuranceFloorChangedFile[];
  materialCodePaths: string[];
  failureSignals: ReviewAssuranceFloorFailureSignal[];
  highRiskSignals: ReviewAssuranceFloorHighRiskSignal[];
  localRounds: {
    requiredRounds: number;
    requiredPassingHostsPerRound: number;
    ok: boolean;
    validRounds: HostVerdictRound[];
    invalidRounds: HostVerdictRound[];
    ignoredVerdicts: IgnoredHostVerdict[];
  };
  degradedFallback: {
    ok: boolean;
    allowed: boolean;
    record: ReviewAssuranceFloorFallbackRecord | null;
    requiredRounds: number;
    requiredPassingHostsPerRound: number;
    validRounds: HostVerdictRound[];
    invalidRounds: HostVerdictRound[];
    ignoredVerdicts: IgnoredHostVerdict[];
  };
  authorityDone: false;
  fullAuthorityDone: false;
  productionDone: false;
  proofAdmissibility: ProofAdmissibilityDiagnostic;
  reasons: string[];
  advisories?: string[];
  diffError?: string;
}

export interface EvaluateReviewAssuranceFloorArgs {
  projectRoot: string;
  gitCwd?: string;
  storyId?: string;
  store?: Pick<StoryStore, 'readStory' | 'readFindings' | 'readProcessEvents' | 'readBugs' | 'readTestEvidence' | 'readUnderstanding'>;
  story?: StoryInfo;
  findings?: Finding[];
  processEvents?: ProcessEvent[];
  bugs?: BugData;
  testEvidence?: TestEvidenceData | null;
  understanding?: UnderstandingData | null;
  touchpoints?: string[];
  changedFiles?: string[];
  materialHash?: string;
  storyFilesHash?: string;
}

export type ReviewAssuranceGuidanceSource = 'review-escalation' | 'review-assurance-floor';
export type ReviewAssuranceGuidanceOwner = 'owner' | 'reviewer-host' | 'human-approved';

export interface ReviewAssuranceCommandRecipe {
  owner: ReviewAssuranceGuidanceOwner;
  command: string;
  purpose: string;
  writesEvidence: boolean;
  safeForStoryOwner: boolean;
}

export interface ReviewAssuranceGuidance {
  schemaVersion: 'lattice.review_assurance_guidance.v1';
  source: ReviewAssuranceGuidanceSource;
  storyId?: string;
  required: boolean;
  ok: boolean;
  reasonCode: string;
  reason: string;
  requiredAssurance: string;
  assuranceLevel: string;
  currentBinding: {
    materialHash: string | null;
    storyFilesHash: string | null;
  };
  legalWriterPaths: {
    ownerRunnable: ReviewAssuranceCommandRecipe[];
    reviewerHost: ReviewAssuranceCommandRecipe[];
    humanApprovedFallback: ReviewAssuranceCommandRecipe[];
  };
  fallback: {
    status: 'not-applicable' | 'eligible' | 'not-eligible' | 'satisfied';
    eligible: boolean;
    reasonCode: string;
    reason: string;
    eligibilityValues: readonly string[];
  };
  cannotAutoSignWarning: string;
}

interface BuildReviewAssuranceGuidanceInput {
  source: ReviewAssuranceGuidanceSource;
  storyId?: string;
  required: boolean;
  ok: boolean;
  reasonCode: string;
  reason: string;
  requiredAssurance: string;
  assuranceLevel: string;
  materialHash: string | null;
  storyFilesHash: string | null;
  fallback: ReviewAssuranceGuidance['fallback'];
  requireFullQuorumPath: boolean;
  requireSingleHostPath: boolean;
}

const REVIEW_ASSURANCE_CANNOT_AUTO_SIGN_WARNING =
  'done_prepare, story_advance, and the story owner/main session will not auto-write reviewer evidence, host verdicts, delivery checks, or degraded fallback evidence; those records must come from their legal reviewer/host or explicit human-approved writer path and bind to the current material.';

function storyRef(storyId?: string): string {
  return storyId && storyId.trim() ? storyId.trim() : '{storyId}';
}

function materialRef(materialHash: string | null): string {
  return materialHash || '{current-materialHash}';
}

function storyFilesRef(storyFilesHash: string | null): string {
  return storyFilesHash || '{current-storyFilesHash}';
}

function reviewEscalationStatusCommand(storyId?: string): string {
  return `lattice review_escalation_status '{"storyId":"${storyRef(storyId)}"}'`;
}

function autopilotReviewStatusCommand(storyId?: string): string {
  return `lattice autopilot_review_status --storyId=${storyRef(storyId)}`;
}

function validationCommand(storyId?: string): string {
  return `lattice validate --story=${storyRef(storyId)} --json`;
}

function staleEvidenceDryRunCommand(storyId?: string): string {
  return `lattice verification_evidence_refresh_stale --storyId=${storyRef(storyId)} --dryRun`;
}

function donePrepareCommand(storyId?: string): string {
  return `lattice done_prepare '{"storyId":"${storyRef(storyId)}"}'`;
}

function autopilotReviewSubmitCommand(storyId: string | undefined, materialHash: string | null, storyFilesHash: string | null): string {
  return `lattice autopilot_review_submit --storyId=${storyRef(storyId)} --runId={round-id} --hostId={host} --sessionId={session} --keyId={key} --decision=pass --materialDigest=${materialRef(materialHash)} --storyFilesHash=${storyFilesRef(storyFilesHash)} --validationDigest={fresh-validation-digest} --promptDigest={current-prompt-digest}`;
}

function quorumSubmitCommand(storyId?: string): string {
  return `lattice quorum_submit '{"storyId":"${storyRef(storyId)}","hostA":"{independent-host-a}","hostB":"{independent-host-b}"}'`;
}

function fallbackSetCommand(storyId: string | undefined, fallback: ReviewAssuranceGuidance['fallback']): string {
  const eligibility = fallback.eligibilityValues.join('|') || 'single-host-environment|temporary-host-unavailability|explicit-human-approval';
  return `lattice review_escalation_fallback_set '{"storyId":"${storyRef(storyId)}","eligibility":"{${eligibility}}","reason":"{why degraded-single-host fallback is approved}","evidenceRefs":["{supporting-ref}"]}'`;
}

export function buildReviewAssuranceGuidance(input: BuildReviewAssuranceGuidanceInput): ReviewAssuranceGuidance {
  const ownerRunnable: ReviewAssuranceCommandRecipe[] = [
    {
      owner: 'owner',
      command: reviewEscalationStatusCommand(input.storyId),
      purpose: 'Inspect the canonical review escalation and review-assurance diagnostics.',
      writesEvidence: false,
      safeForStoryOwner: true,
    },
    {
      owner: 'owner',
      command: autopilotReviewStatusCommand(input.storyId),
      purpose: 'Inspect submitted local host verdicts and ignored/stale verdict reasons.',
      writesEvidence: false,
      safeForStoryOwner: true,
    },
    {
      owner: 'owner',
      command: validationCommand(input.storyId),
      purpose: 'Refresh owner-runnable validation evidence before reviewer/host verdicts bind to current material.',
      writesEvidence: true,
      safeForStoryOwner: true,
    },
    {
      owner: 'owner',
      command: staleEvidenceDryRunCommand(input.storyId),
      purpose: 'Preview stale verificationEvidence refresh; rerun listed evidence commands before applying refresh.',
      writesEvidence: false,
      safeForStoryOwner: true,
    },
    {
      owner: 'owner',
      command: donePrepareCommand(input.storyId),
      purpose: 'Re-run the DONE preparation preflight after legal review-assurance writers have produced evidence.',
      writesEvidence: false,
      safeForStoryOwner: true,
    },
  ];

  const reviewerHost: ReviewAssuranceCommandRecipe[] = [];
  if (input.requireSingleHostPath || input.requireFullQuorumPath) {
    reviewerHost.push({
      owner: 'reviewer-host',
      command: autopilotReviewSubmitCommand(input.storyId, input.materialHash, input.storyFilesHash),
      purpose: 'Reviewer/host path: submit a PASS host verdict bound to the current material.',
      writesEvidence: true,
      safeForStoryOwner: false,
    });
  }
  if (input.requireFullQuorumPath) {
    reviewerHost.push({
      owner: 'reviewer-host',
      command: quorumSubmitCommand(input.storyId),
      purpose: 'Reviewer/host path: bulk-record local non-authority 3x2 host verdict evidence when policy permits.',
      writesEvidence: true,
      safeForStoryOwner: false,
    });
  }

  const humanApprovedFallback = input.fallback.eligible
    ? [{
        owner: 'human-approved' as const,
        command: fallbackSetCommand(input.storyId, input.fallback),
        purpose: 'Explicit human-approved degraded-single-host fallback writer; use only when the canonical status says fallback is eligible.',
        writesEvidence: true,
        safeForStoryOwner: false,
      }]
    : [];

  return {
    schemaVersion: 'lattice.review_assurance_guidance.v1',
    source: input.source,
    ...(input.storyId ? { storyId: input.storyId } : {}),
    required: input.required,
    ok: input.ok,
    reasonCode: input.reasonCode,
    reason: input.reason,
    requiredAssurance: input.requiredAssurance,
    assuranceLevel: input.assuranceLevel,
    currentBinding: {
      materialHash: input.materialHash,
      storyFilesHash: input.storyFilesHash,
    },
    legalWriterPaths: {
      ownerRunnable,
      reviewerHost,
      humanApprovedFallback,
    },
    fallback: input.fallback,
    cannotAutoSignWarning: REVIEW_ASSURANCE_CANNOT_AUTO_SIGN_WARNING,
  };
}

function reviewEscalationReasonCode(report: ReviewEscalationReport): string {
  if (!report.required) return 'review_assurance_escalation_not_required';
  if (report.ok) return 'review_assurance_escalation_satisfied';
  if (!report.materialHash) return 'review_assurance_material_hash_unavailable';
  if (report.trigger.explicitHighRiskPolicy.validPolicy?.degradedFallbackAllowed === false) {
    return 'review_assurance_escalation_3x2_only_missing';
  }
  return 'review_assurance_escalation_3x2_or_fallback_missing';
}

function reviewEscalationFallbackStatus(report: ReviewEscalationReport): ReviewAssuranceGuidance['fallback'] {
  if (!report.required) {
    return {
      status: 'not-applicable',
      eligible: false,
      reasonCode: 'fallback_not_applicable_review_escalation_not_required',
      reason: 'Review escalation is not required.',
      eligibilityValues: REVIEW_ESCALATION_FALLBACK_ELIGIBILITIES,
    };
  }
  if (report.trigger.explicitHighRiskPolicy.validPolicy?.degradedFallbackAllowed === false) {
    return {
      status: 'not-eligible',
      eligible: false,
      reasonCode: 'fallback_disallowed_by_explicit_high_risk_policy',
      reason: 'The explicit high-risk policy requires full 3x2 review assurance and disallows degraded fallback.',
      eligibilityValues: REVIEW_ESCALATION_FALLBACK_ELIGIBILITIES,
    };
  }
  if (report.degradedFallback.ok) {
    return {
      status: 'satisfied',
      eligible: true,
      reasonCode: 'fallback_satisfied',
      reason: 'A valid degraded-single-host fallback is already recorded for current material.',
      eligibilityValues: REVIEW_ESCALATION_FALLBACK_ELIGIBILITIES,
    };
  }
  return {
    status: 'eligible',
    eligible: true,
    reasonCode: 'fallback_eligible_review_escalation',
    reason: 'A degraded-single-host fallback may be recorded only through review_escalation_fallback_set when a listed eligibility applies.',
    eligibilityValues: REVIEW_ESCALATION_FALLBACK_ELIGIBILITIES,
  };
}

export function buildReviewEscalationGuidance(report: ReviewEscalationReport, storyId?: string): ReviewAssuranceGuidance {
  return buildReviewAssuranceGuidance({
    source: 'review-escalation',
    storyId,
    required: report.required,
    ok: report.ok,
    reasonCode: reviewEscalationReasonCode(report),
    reason: report.reasons[0] || (report.required ? 'Review escalation assurance is required by the canonical status.' : 'Review escalation assurance is not required.'),
    requiredAssurance: report.required ? 'three-round-two-hosts-or-degraded-single-host' : 'none',
    assuranceLevel: report.assuranceLevel,
    materialHash: report.materialHash,
    storyFilesHash: report.storyFilesHash,
    fallback: reviewEscalationFallbackStatus(report),
    requireFullQuorumPath: report.required,
    requireSingleHostPath: report.required,
  });
}

function commandNames(commands: ReviewAssuranceCommandRecipe[]): string {
  const names = commands
    .map((recipe) => recipe.command.split(/\s+/)[1] || recipe.command)
    .filter(Boolean);
  return names.length > 0 ? [...new Set(names)].join(',') : 'none';
}

export function renderReviewAssuranceGuidanceSummary(guidance: ReviewAssuranceGuidance): string {
  return [
    `reasonCode=${guidance.reasonCode}`,
    `materialHash=${guidance.currentBinding.materialHash ?? '<missing>'}`,
    `storyFilesHash=${guidance.currentBinding.storyFilesHash ?? '<missing>'}`,
    `fallback=${guidance.fallback.status}/${guidance.fallback.reasonCode}`,
    `ownerRunnable=${commandNames(guidance.legalWriterPaths.ownerRunnable)}`,
    `reviewerHostWriters=${commandNames(guidance.legalWriterPaths.reviewerHost)}`,
    `humanApprovedFallbackWriters=${commandNames(guidance.legalWriterPaths.humanApprovedFallback)}`,
    'cannotAutoSign=owner-main-session',
  ].join('; ');
}

export function renderReviewAssuranceGuidance(guidance: ReviewAssuranceGuidance, indent = ''): string {
  const lines = [
    `${indent}Review assurance guidance (${guidance.source}):`,
    `${indent}  reasonCode: ${guidance.reasonCode}`,
    `${indent}  required: ${guidance.required}`,
    `${indent}  ok: ${guidance.ok}`,
    `${indent}  requiredAssurance: ${guidance.requiredAssurance}`,
    `${indent}  assuranceLevel: ${guidance.assuranceLevel}`,
    `${indent}  currentBinding: storyId=${guidance.storyId ?? '<storyId>'} materialHash=${guidance.currentBinding.materialHash ?? '<missing>'} storyFilesHash=${guidance.currentBinding.storyFilesHash ?? '<missing>'}`,
    `${indent}  fallbackEligibility: ${guidance.fallback.status} reasonCode=${guidance.fallback.reasonCode}`,
    `${indent}  fallbackReason: ${guidance.fallback.reason}`,
    `${indent}  legalWriterPaths:`,
    `${indent}    ownerRunnable:`,
  ];
  for (const recipe of guidance.legalWriterPaths.ownerRunnable) {
    lines.push(`${indent}      - ${recipe.command} # ${recipe.purpose}`);
  }
  lines.push(`${indent}    reviewerHost:`);
  if (guidance.legalWriterPaths.reviewerHost.length === 0) {
    lines.push(`${indent}      - none`);
  } else {
    for (const recipe of guidance.legalWriterPaths.reviewerHost) {
      lines.push(`${indent}      - ${recipe.command} # ${recipe.purpose}`);
    }
  }
  lines.push(`${indent}    humanApprovedFallback:`);
  if (guidance.legalWriterPaths.humanApprovedFallback.length === 0) {
    lines.push(`${indent}      - none`);
  } else {
    for (const recipe of guidance.legalWriterPaths.humanApprovedFallback) {
      lines.push(`${indent}      - ${recipe.command} # ${recipe.purpose}`);
    }
  }
  lines.push(`${indent}  cannotAutoSign: ${guidance.cannotAutoSignWarning}`);
  return lines.join('\n');
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function fileName(path: string): string {
  const parts = normalizePath(path).split('/');
  return parts[parts.length - 1]?.toLowerCase() ?? '';
}

function hasExtension(path: string, extensions: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some(ext => lower.endsWith(ext));
}

function isPackageOrRuntimeConfigPath(path: string): boolean {
  const name = fileName(path);
  return (
    name === 'package.json' ||
    name === 'package-lock.json' ||
    name === 'pnpm-lock.yaml' ||
    name === 'yarn.lock' ||
    name === 'bun.lockb' ||
    name === 'tsconfig.json' ||
    name.startsWith('tsconfig.') ||
    name === 'lattice.config.json'
  );
}

export function classifyReviewAssuranceFloorPath(path: string, projectRoot?: string): ReviewAssuranceFloorChangedFile {
  const normalized = normalizePath(path);
  const lower = normalized.toLowerCase();

  if (!normalized) {
    return { path: normalized, materialCode: false, reason: 'empty path' };
  }
  if (isMaterialExcludedPath(normalized, projectRoot)) {
    return { path: normalized, materialCode: false, reason: 'lattice runtime/story metadata' };
  }
  if (hasExtension(lower, ['.md', '.mdx'])) {
    return { path: normalized, materialCode: false, reason: 'markdown documentation' };
  }
  if (
    lower.startsWith('packages/main/src/') ||
    lower.startsWith('packages/main/tests/') ||
    lower.startsWith('packages/main/test/') ||
    lower.startsWith('scripts/') ||
    lower.startsWith('bin/')
  ) {
    return { path: normalized, materialCode: true, reason: 'source/runtime/test/script path' };
  }
  if (isPackageOrRuntimeConfigPath(lower)) {
    return { path: normalized, materialCode: true, reason: 'package/runtime config path' };
  }
  if (hasExtension(lower, ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.sh'])) {
    return { path: normalized, materialCode: true, reason: 'code or script extension' };
  }
  return { path: normalized, materialCode: false, reason: 'non-code project material' };
}

function listChangedFiles(gitCwd: string): { files: string[]; error?: string } {
  try {
    const raw = execFileSync('git', ['diff', '--name-only', 'main...HEAD'], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { files: raw ? raw.split('\n').map(line => line.trim()).filter(Boolean) : [] };
  } catch (err) {
    return {
      files: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function readStory(args: EvaluateReviewAssuranceFloorArgs): StoryInfo | null {
  if (args.story) return args.story;
  if (!args.store || !args.storyId) return null;
  return args.store.readStory(args.storyId);
}

function readFindings(args: EvaluateReviewAssuranceFloorArgs): Finding[] {
  if (args.findings) return args.findings;
  if (!args.store || !args.storyId) return [];
  return args.store.readFindings(args.storyId).findings;
}

function readEvents(args: EvaluateReviewAssuranceFloorArgs): ProcessEvent[] {
  if (args.processEvents) return args.processEvents;
  if (!args.store || !args.storyId) return [];
  return args.store.readProcessEvents(args.storyId);
}

function readBugs(args: EvaluateReviewAssuranceFloorArgs): BugData {
  if (args.bugs) return args.bugs;
  if (!args.store || !args.storyId) return { bugs: [] };
  return args.store.readBugs(args.storyId);
}

function readTestEvidence(args: EvaluateReviewAssuranceFloorArgs): TestEvidenceData | null {
  if (args.testEvidence !== undefined) return args.testEvidence;
  if (!args.store || !args.storyId) return null;
  return args.store.readTestEvidence(args.storyId);
}

function readUnderstanding(args: EvaluateReviewAssuranceFloorArgs): UnderstandingData | null {
  if (args.understanding !== undefined) return args.understanding;
  if (!args.store || !args.storyId) return null;
  return args.store.readUnderstanding(args.storyId);
}

function isVerifiedReviewerFinding(finding: Finding): boolean {
  if (!isReviewerAgent(finding.agent)) return false;
  if (finding.evidenceState === 'suspected' || finding.evidenceState === 'disproven') return false;
  if (finding.evidenceState && finding.evidenceState !== 'verified') return false;
  return true;
}

function collectFailureSignals(args: EvaluateReviewAssuranceFloorArgs): ReviewAssuranceFloorFailureSignal[] {
  const signals: ReviewAssuranceFloorFailureSignal[] = [];
  const testEvidence = readTestEvidence(args);
  if (testEvidence?.result === 'FAIL') {
    signals.push({
      kind: 'validation-failure',
      detail: `test-evidence.json result=${testEvidence.result}`,
    });
  }

  for (const bug of readBugs(args).bugs) {
    signals.push({
      kind: 'bug',
      id: bug.id,
      detail: `${bug.id} status=${bug.status}`,
    });
  }

  for (const finding of readFindings(args).filter(isVerifiedReviewerFinding)) {
    signals.push({
      kind: 'verified-reviewer-finding',
      id: finding.id,
      detail: `${finding.id} ${finding.severity} status=${finding.status}`,
    });
  }

  for (const event of readEvents(args)) {
    const type = normalizeString(event.type);
    if (type === 'bug_reopened') {
      signals.push({
        kind: 'bug-reopened',
        id: normalizeString(event.bugId) || undefined,
        detail: `bug_reopened${normalizeString(event.bugId) ? ` ${normalizeString(event.bugId)}` : ''}`,
      });
    }
    const result = normalizeString(event.result).toLowerCase();
    const command = normalizeString(event.command).toLowerCase();
    if ((result === 'fail' || result === 'failed') && /validate|validation/.test(`${type} ${command}`)) {
      signals.push({
        kind: 'validation-failure',
        detail: `${type || 'process-event'} result=${result}`,
      });
    }
  }

  const story = readStory(args);
  const devAdvances = (story?.events ?? []).filter(event => event.phase === 'DEV' && event.action === 'advance');
  if (devAdvances.length > 1) {
    signals.push({
      kind: 'repeated-rework',
      detail: `${devAdvances.length} DEV advance events`,
    });
  }

  return signals;
}

function activeRiskSignalValues(story: StoryInfo | null): string[] {
  const dismissed = new Set((story?.riskSignalsDismissed ?? []).map(signal => signal.category));
  return (story?.riskSignals ?? [])
    .filter(signal => !dismissed.has(signal.category))
    .flatMap(signal => [signal.category, signal.matched])
    .map(value => normalizeString(value).toLowerCase())
    .filter(Boolean);
}

function priorityIsHighRisk(story: StoryInfo | null): boolean {
  const priority = normalizeString(story?.priority).toLowerCase();
  return priority === 'high' || priority === 'critical';
}

function isHighRiskLifecyclePath(path: string): boolean {
  const lower = normalizePath(path).toLowerCase();
  return (
    lower.includes('authority') ||
    lower.includes('process-fact') ||
    lower.includes('review-assurance-floor') ||
    lower.includes('review-escalation') ||
    lower.includes('done-oracle') ||
    lower.includes('transition-orchestrator') ||
    lower.includes('phase-gate') ||
    lower.includes('gate') ||
    lower.includes('guard') ||
    lower.includes('machine') ||
    lower.includes('lifecycle') ||
    lower.includes('workflow-policy') ||
    lower.includes('command-policy') ||
    lower === 'scripts/verify-process-fact-contract.mjs'
  );
}

function isHighRiskLifecycleSignal(value: string): boolean {
  return /authority|process[-_\s]?fact|lifecycle|gate|guard|machine|state[-_\s]?machine|done|review[-_\s]?(assurance|escalation)|门禁|状态机/.test(value);
}

function collectHighRiskSignals(
  args: EvaluateReviewAssuranceFloorArgs,
  materialCodePaths: string[],
): ReviewAssuranceFloorHighRiskSignal[] {
  const story = readStory(args);
  const touchpoints = args.touchpoints ?? readUnderstanding(args)?.touchpoints ?? [];
  const signals: ReviewAssuranceFloorHighRiskSignal[] = [];

  for (const path of materialCodePaths) {
    if (isHighRiskLifecyclePath(path)) {
      signals.push({ kind: 'path', value: path });
    }
  }

  for (const touchpoint of touchpoints) {
    if (typeof touchpoint === 'string' && isHighRiskLifecyclePath(touchpoint)) {
      signals.push({ kind: 'touchpoint', value: normalizePath(touchpoint) });
    }
  }

  for (const value of activeRiskSignalValues(story)) {
    if (isHighRiskLifecycleSignal(value)) {
      signals.push({ kind: 'risk-signal', value });
    }
  }

  if (priorityIsHighRisk(story) && signals.some(signal => signal.kind !== 'priority')) {
    signals.push({ kind: 'priority', value: normalizeString(story?.priority).toLowerCase() });
  }

  const seen = new Set<string>();
  return signals.filter(signal => {
    const key = `${signal.kind}:${signal.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptyRounds(requiredRounds: number) {
  return {
    requiredRounds,
    requiredPassingHostsPerRound: REVIEW_ASSURANCE_FLOOR_LOCAL_HOSTS_PER_ROUND,
    ok: requiredRounds === 0,
    validRounds: [],
    invalidRounds: [],
    ignoredVerdicts: [],
  };
}

function emptyFallbackReport() {
  return {
    ok: false,
    allowed: false,
    record: null,
    requiredRounds: REVIEW_ASSURANCE_FLOOR_HIGH_RISK_REQUIRED_ROUNDS,
    requiredPassingHostsPerRound: REVIEW_ASSURANCE_FLOOR_LOCAL_HOSTS_PER_ROUND,
    validRounds: [],
    invalidRounds: [],
    ignoredVerdicts: [],
  };
}

function reportBase(
  overrides: Partial<ReviewAssuranceFloorReport>,
): ReviewAssuranceFloorReport {
  return {
    schemaVersion: 'lattice.review_assurance_floor.v1',
    ok: true,
    required: false,
    requiredAssurance: 'none',
    assuranceLevel: 'not-required',
    materialHash: null,
    changedFiles: [],
    materialCodePaths: [],
    failureSignals: [],
    highRiskSignals: [],
    localRounds: emptyRounds(0),
    degradedFallback: emptyFallbackReport(),
    authorityDone: false,
    fullAuthorityDone: false,
    productionDone: false,
    proofAdmissibility: buildProofAdmissibilityDiagnostic({
      artifactKind: 'review-run',
      artifactId: 'review-assurance-floor',
      consumer: 'REVIEW',
      claim: 'review-pass',
      checks: {
        schemaVersion: 'lattice.review_run.v1',
        strictShapeValid: true,
        semanticDigestValid: false,
        signatureOrReceiptBindingValid: false,
        temporalAndMaterialBindingValid: false,
        subjectMatches: true,
        producerBoundaryTrusted: true,
      },
    }),
    reasons: [],
    ...overrides,
  };
}

export function evaluateReviewAssuranceFloor(args: EvaluateReviewAssuranceFloorArgs): ReviewAssuranceFloorReport {
  const gitCwd = args.gitCwd ?? args.projectRoot;
  const storyId = normalizeString(args.storyId);
  const base = (overrides: Partial<ReviewAssuranceFloorReport>): ReviewAssuranceFloorReport => reportBase({
    ...(storyId ? { storyId } : {}),
    ...overrides,
  });
  const listed = args.changedFiles ? { files: args.changedFiles } : listChangedFiles(gitCwd);
  const changedFiles = listed.files.map(path => classifyReviewAssuranceFloorPath(path, args.projectRoot));
  const materialCodePaths = changedFiles
    .filter(file => file.materialCode)
    .map(file => file.path);
  const materialHash = args.materialHash ?? currentMaterialHash(gitCwd, 'HEAD', args.projectRoot) ?? null;
  const failureSignals = collectFailureSignals(args);
  const highRiskSignals = collectHighRiskSignals(args, materialCodePaths);

  if (listed.error) {
    return base({
      ok: false,
      required: true,
      requiredAssurance: 'one-local-round',
      assuranceLevel: 'missing',
      materialHash,
      changedFiles,
      materialCodePaths,
      failureSignals,
      highRiskSignals,
      localRounds: emptyRounds(REVIEW_ASSURANCE_FLOOR_REQUIRED_ROUNDS),
      reasons: [`unable to classify git diff against main: ${listed.error}`],
      diffError: listed.error,
    });
  }

  if (materialCodePaths.length === 0) {
    return base({
      changedFiles,
      materialHash,
      failureSignals,
      highRiskSignals,
      reasons: [],
    });
  }

  const highRiskRequired = highRiskSignals.length > 0;
  const requiredRounds = highRiskRequired
    ? REVIEW_ASSURANCE_FLOOR_HIGH_RISK_REQUIRED_ROUNDS
    : failureSignals.length > 0
      ? REVIEW_ASSURANCE_FLOOR_FAILURE_REQUIRED_ROUNDS
      : REVIEW_ASSURANCE_FLOOR_REQUIRED_ROUNDS;
  const requiredHosts = highRiskRequired
    ? REVIEW_ASSURANCE_FLOOR_HIGH_RISK_HOSTS_PER_ROUND
    : REVIEW_ASSURANCE_FLOOR_LOCAL_HOSTS_PER_ROUND;
  const requiredAssurance: ReviewAssuranceFloorRequiredAssurance = highRiskRequired
    ? 'three-round-two-hosts-or-degraded-single-host'
    : requiredRounds === REVIEW_ASSURANCE_FLOOR_FAILURE_REQUIRED_ROUNDS
      ? 'three-local-rounds'
      : 'one-local-round';

  if (!materialHash) {
    return base({
      ok: false,
      required: true,
      requiredAssurance,
      assuranceLevel: 'missing',
      materialHash: null,
      changedFiles,
      materialCodePaths,
      failureSignals,
      highRiskSignals,
      localRounds: emptyRounds(requiredRounds),
      reasons: ['current material hash is unavailable'],
    });
  }

  // B-6de6: honor storyFilesHash as a secondary downgrade-accept, exactly
  // mirroring review-escalation: whole-tree materialHash stays the PRIMARY key,
  // and storyFilesHash only forgives unrelated whole-tree drift (valid-with-
  // advisory), never a real story-file change. (materialHash is non-null here.)
  const storyFilesHash = args.storyFilesHash ?? currentStoryFilesHash(gitCwd, 'HEAD', args.projectRoot) ?? null;
  const downgradeAdvisories: string[] = [];
  const rawEvents = readEvents(args);
  const effectiveEvents = storyFilesHash
    ? eventsWithStoryFilesHashDowngrade(rawEvents, materialHash, storyFilesHash, downgradeAdvisories)
    : rawEvents;

  const localRounds = evaluateHostVerdictRounds(
    effectiveEvents,
    materialHash,
    requiredHosts,
  );
  const fullOk = localRounds.validRounds.length >= requiredRounds;
  const fallback = latestFallbackRecord(effectiveEvents, materialHash, storyFilesHash);
  const degradedRounds = highRiskRequired
    ? evaluateHostVerdictRounds(effectiveEvents, materialHash, REVIEW_ASSURANCE_FLOOR_LOCAL_HOSTS_PER_ROUND)
    : null;
  const degradedRoundsOk = Boolean(degradedRounds && degradedRounds.validRounds.length >= requiredRounds);
  const degradedOk = highRiskRequired && fallback?.valid === true && degradedRoundsOk;
  const ok = fullOk || degradedOk;
  const reasons: string[] = [];
  if (!ok) {
    reasons.push(
      highRiskRequired
        ? `high-risk review assurance floor requires ${requiredRounds} rounds x ${requiredHosts} independent PASS hosts, or explicit degraded-single-host fallback with ${requiredRounds} rounds x 1 PASS host`
        : `review assurance floor requires ${requiredRounds} fresh local PASS round(s) over current material; found ${localRounds.validRounds.length}`,
    );
    if (highRiskRequired) {
      reasons.push(`high-risk signals require the stronger floor: ${highRiskSignals.map(signal => `${signal.kind}:${signal.value}`).join(', ')}`);
      if (!fallback) reasons.push('no review_escalation_fallback record found for degraded fallback');
      else if (!fallback.valid) reasons.push(...fallback.reasons.map(reason => `fallback invalid: ${reason}`));
      if (!degradedRoundsOk) reasons.push(`degraded fallback has ${degradedRounds?.validRounds.length ?? 0}/${requiredRounds} valid single-host rounds`);
    }
    if (failureSignals.length > 0) {
      reasons.push(`failure signals make the 3x1 local floor sticky: ${failureSignals.map(signal => signal.kind).join(', ')}`);
    }
  }

  // B-6de6: surface re-attestation advisories from BOTH the host-verdict
  // downgrade pass and the degraded fallback record so the storyFilesHash
  // drift-acceptance signal is never swallowed (mirrors review-escalation).
  const advisories = [...downgradeAdvisories, ...(fallback?.advisories ?? [])];
  const proofPolicy = resolveProofAdmissibilityPolicy(args.projectRoot);
  const proofAdmissibility = buildProofAdmissibilityDiagnostic({
    artifactKind: 'review-run',
    artifactId: storyId ? `${storyId}:review-assurance-floor` : 'review-assurance-floor',
    consumer: 'REVIEW',
    claim: 'review-pass',
    policy: proofPolicy,
    checks: {
      schemaVersion: 'lattice.review_run.v1',
      strictShapeValid: true,
      semanticDigestValid: ok,
      signatureOrReceiptBindingValid: fullOk || degradedOk,
      temporalAndMaterialBindingValid: ok,
      subjectMatches: true,
      producerBoundaryTrusted: true,
    },
  });
  const proofBlockReason = highRiskRequired
    ? proofAdmissibilityBlockingReason(proofAdmissibility)
    : null;
  if (proofBlockReason) reasons.push(proofBlockReason);
  const effectiveOk = ok && !proofBlockReason;

  return {
    schemaVersion: 'lattice.review_assurance_floor.v1',
    ...(storyId ? { storyId } : {}),
    ok: effectiveOk,
    required: true,
    requiredAssurance,
    assuranceLevel: effectiveOk
      ? (highRiskRequired ? (fullOk ? 'full-3x2' : 'degraded-single-host') : requiredRounds === REVIEW_ASSURANCE_FLOOR_FAILURE_REQUIRED_ROUNDS ? 'degraded-single-host' : 'local-one-round')
      : 'missing',
    materialHash,
    storyFilesHash,
    changedFiles,
    materialCodePaths,
    failureSignals,
    highRiskSignals,
    localRounds: {
      requiredRounds,
      requiredPassingHostsPerRound: requiredHosts,
      ok: fullOk,
      ...localRounds,
    },
    degradedFallback: highRiskRequired
      ? {
          ok: degradedOk,
          allowed: fallback?.valid === true,
          record: fallback,
          requiredRounds,
          requiredPassingHostsPerRound: REVIEW_ASSURANCE_FLOOR_LOCAL_HOSTS_PER_ROUND,
          validRounds: degradedRounds?.validRounds ?? [],
          invalidRounds: degradedRounds?.invalidRounds ?? [],
          ignoredVerdicts: degradedRounds?.ignoredVerdicts ?? [],
        }
      : emptyFallbackReport(),
    authorityDone: false,
    fullAuthorityDone: false,
    productionDone: false,
    proofAdmissibility,
    reasons,
    ...(advisories.length > 0 ? { advisories } : {}),
  };
}

function latestByIndex<T extends { index: number }>(items: T[]): T | null {
  return items.length === 0 ? null : [...items].sort((a, b) => b.index - a.index)[0];
}

function fallbackRecordFromEvent(
  event: ProcessEvent,
  index: number,
  expectedMaterialHash: string,
  expectedStoryFilesHash: string | null,
): ReviewAssuranceFloorFallbackRecord {
  const eligibility = normalizeString(event.eligibility);
  const reason = normalizeString(event.reason);
  const evidenceRefs = Array.isArray(event.evidenceRefs)
    ? event.evidenceRefs.map(ref => normalizeString(ref)).filter(Boolean)
    : [];
  const approvalRef = normalizeString(event.approvalRef);
  const materialHash = normalizeString(event.materialHash);
  const storyFilesHash = normalizeString(event.storyFilesHash);
  const assuranceLevel = normalizeString(event.assuranceLevel);
  const reasons: string[] = [];
  const advisories: string[] = [];

  if (!isReviewEscalationFallbackEligibility(eligibility)) {
    reasons.push(`eligibility must be one of ${REVIEW_ESCALATION_FALLBACK_ELIGIBILITIES.join('|')}`);
  }
  if (reason.length < 20) reasons.push('reason must be at least 20 characters');
  if (evidenceRefs.length === 0 && !approvalRef) reasons.push('fallback requires evidenceRefs or approvalRef');
  if (!materialHash) reasons.push('missing materialHash');
  // B-6de6: the fallback event carries event.materialHash (NOT materialDigest),
  // so eventsWithStoryFilesHashDowngrade does not rewrite it; apply the SAME
  // storyFilesHash downgrade-accept that review-escalation uses here.
  else if (materialHash !== expectedMaterialHash) {
    if (expectedStoryFilesHash && storyFilesHash && storyFilesHash === expectedStoryFilesHash) {
      advisories.push('materialHash is stale but storyFilesHash matches; re-attestation advisory required');
    } else {
      reasons.push('materialHash is stale');
    }
  }
  if (assuranceLevel !== 'degraded-single-host') {
    reasons.push('assuranceLevel must be degraded-single-host');
  }

  return {
    index,
    ...(normalizeString(event.fallbackId) ? { fallbackId: normalizeString(event.fallbackId) } : {}),
    ...(eligibility ? { eligibility } : {}),
    ...(reason ? { reason } : {}),
    evidenceRefs,
    ...(approvalRef ? { approvalRef } : {}),
    ...(materialHash ? { materialHash } : {}),
    ...(storyFilesHash ? { storyFilesHash } : {}),
    ...(assuranceLevel ? { assuranceLevel } : {}),
    valid: reasons.length === 0,
    reasons,
    ...(advisories.length > 0 ? { advisories } : {}),
  };
}

function latestFallbackRecord(events: ProcessEvent[], expectedMaterialHash: string, expectedStoryFilesHash: string | null): ReviewAssuranceFloorFallbackRecord | null {
  const records = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'review_escalation_fallback')
    .map(({ event, index }) => fallbackRecordFromEvent(event, index, expectedMaterialHash, expectedStoryFilesHash));
  return latestByIndex(records);
}

const INVALID_ROUND_DETAIL_LIMIT = 5;
const IGNORED_VERDICT_DETAIL_LIMIT = 8;
const STALE_VERDICT_SUMMARY_LIMIT = 4;

function ignoredVerdictKey(verdict: IgnoredHostVerdict): string {
  return verdict.verdictId ?? `event#${verdict.index}`;
}

function uniqueIgnoredVerdicts(verdicts: IgnoredHostVerdict[]): IgnoredHostVerdict[] {
  const seen = new Set<string>();
  const unique: IgnoredHostVerdict[] = [];
  for (const verdict of verdicts) {
    const key = `${ignoredVerdictKey(verdict)}:${verdict.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(verdict);
  }
  return unique;
}

function isStaleMaterialVerdict(verdict: IgnoredHostVerdict): boolean {
  return verdict.reasons.some(reason => /material(Digest|Hash) is stale|stale material/i.test(reason));
}

function formatIgnoredVerdictSummary(verdict: IgnoredHostVerdict): string {
  const id = ignoredVerdictKey(verdict);
  const run = verdict.runId ? `@${verdict.runId}` : '';
  const material = verdict.materialDigest ? ` materialDigest=${verdict.materialDigest}` : '';
  return `${id}${run}${material}`;
}

function reviewAssuranceFloorReasonCode(report: ReviewAssuranceFloorReport): string {
  if (!report.required) return 'review_assurance_floor_not_required';
  if (report.ok) return 'review_assurance_floor_satisfied';
  if (!report.materialHash) return 'review_assurance_material_hash_unavailable';
  if (report.requiredAssurance === 'one-local-round') return 'review_assurance_floor_one_local_round_missing';
  if (report.requiredAssurance === 'three-local-rounds') return 'review_assurance_floor_failure_3x1_missing';
  return 'review_assurance_floor_high_risk_3x2_or_fallback_missing';
}

function reviewAssuranceFloorFallbackStatus(report: ReviewAssuranceFloorReport): ReviewAssuranceGuidance['fallback'] {
  const eligibilityValues = REVIEW_ESCALATION_FALLBACK_ELIGIBILITIES;
  if (report.requiredAssurance !== 'three-round-two-hosts-or-degraded-single-host') {
    return {
      status: 'not-applicable',
      eligible: false,
      reasonCode: 'fallback_not_applicable_floor_does_not_require_high_risk_path',
      reason: 'The current floor can be satisfied by the ordinary local review path and does not use degraded fallback evidence.',
      eligibilityValues,
    };
  }
  if (report.degradedFallback.ok) {
    return {
      status: 'satisfied',
      eligible: true,
      reasonCode: 'fallback_satisfied',
      reason: 'A valid degraded-single-host fallback is already recorded for current material.',
      eligibilityValues,
    };
  }
  return {
    status: 'eligible',
    eligible: true,
    reasonCode: 'fallback_eligible_high_risk_review_assurance_floor',
    reason: 'High-risk review assurance may use explicit degraded-single-host fallback only through review_escalation_fallback_set when a listed eligibility applies.',
    eligibilityValues,
  };
}

export function buildReviewAssuranceFloorGuidance(report: ReviewAssuranceFloorReport): ReviewAssuranceGuidance {
  const highRiskPath = report.requiredAssurance === 'three-round-two-hosts-or-degraded-single-host';
  return buildReviewAssuranceGuidance({
    source: 'review-assurance-floor',
    storyId: report.storyId,
    required: report.required,
    ok: report.ok,
    reasonCode: reviewAssuranceFloorReasonCode(report),
    reason: report.reasons[0] || (report.required ? 'Review assurance floor is required by the canonical DONE status.' : 'Review assurance floor is not required.'),
    requiredAssurance: report.requiredAssurance,
    assuranceLevel: report.assuranceLevel,
    materialHash: report.materialHash,
    storyFilesHash: report.storyFilesHash ?? null,
    fallback: reviewAssuranceFloorFallbackStatus(report),
    requireFullQuorumPath: highRiskPath,
    requireSingleHostPath: report.required,
  });
}

export function formatReviewAssuranceFloorFailure(report: ReviewAssuranceFloorReport): string {
  if (report.ok) return '';
  const storyRef = report.storyId ?? '<storyId>';
  const materialRef = report.materialHash ?? '<current-materialHash>';
  const signalSummary = report.failureSignals.length > 0
    ? report.failureSignals.map(signal => `${signal.kind}${signal.id ? `:${signal.id}` : ''}`).join(', ')
    : 'none';
  const highRiskSummary = report.highRiskSignals.length > 0
    ? report.highRiskSignals.map(signal => `${signal.kind}:${signal.value}`).join(', ')
    : 'none';
  const ignoredVerdicts = uniqueIgnoredVerdicts([
    ...report.localRounds.ignoredVerdicts,
    ...report.degradedFallback.ignoredVerdicts,
  ]);
  const staleVerdicts = ignoredVerdicts.filter(isStaleMaterialVerdict);
  const lines = [
    'Cannot enter DONE: material code diff requires review assurance floor. [review_assurance_floor_missing]',
    `  - required assurance: ${report.requiredAssurance}`,
    `  - assuranceLevel: ${report.assuranceLevel}`,
    `  - materialHash: ${report.materialHash ?? '<missing>'}`,
    `  - storyFilesHash: ${report.storyFilesHash ?? '<missing>'}`,
    `  - material code paths: ${report.materialCodePaths.length === 0 ? '<unknown>' : report.materialCodePaths.slice(0, 8).join(', ')}`,
    `  - local rounds: ${report.localRounds.validRounds.length}/${report.localRounds.requiredRounds} with ${report.localRounds.requiredPassingHostsPerRound} PASS host`,
    `  - degraded fallback: ${report.degradedFallback.validRounds.length}/${report.degradedFallback.requiredRounds} rounds with ${report.degradedFallback.requiredPassingHostsPerRound} PASS host; explicit fallback=${report.degradedFallback.allowed ? 'valid' : 'missing/invalid'}`,
    `  - failure signals: ${signalSummary}`,
    `  - high-risk signals: ${highRiskSummary}`,
  ];
  // Surface accepted-drift advisories even on the FAIL path: a host verdict can
  // be downgrade-accepted (whole-tree materialHash drifted but storyFilesHash
  // matches) while the floor still fails for another reason (e.g. failure-signal
  // 3-round stickiness). Do not swallow the re-attestation signal.
  if (report.advisories?.length) {
    lines.push(`  - accepted-drift advisories: ${report.advisories.join('; ')}`);
  }
  if (staleVerdicts.length > 0) {
    const shown = staleVerdicts.slice(0, STALE_VERDICT_SUMMARY_LIMIT).map(formatIgnoredVerdictSummary).join(', ');
    const suffix = staleVerdicts.length > STALE_VERDICT_SUMMARY_LIMIT
      ? ` (+${staleVerdicts.length - STALE_VERDICT_SUMMARY_LIMIT} more)`
      : '';
    lines.push(`  - stale host verdicts: ${shown}${suffix}`);
  } else if (ignoredVerdicts.length > 0) {
    lines.push(`  - ignored host verdicts: ${ignoredVerdicts.length} (see reasons below)`);
  }
  for (const round of report.localRounds.invalidRounds.slice(0, INVALID_ROUND_DETAIL_LIMIT)) {
    lines.push(`  - invalid local round ${round.runId}: ${round.reasons.join('; ')}`);
  }
  if (report.localRounds.invalidRounds.length > INVALID_ROUND_DETAIL_LIMIT) {
    lines.push(`  - ${report.localRounds.invalidRounds.length - INVALID_ROUND_DETAIL_LIMIT} more invalid local round(s) omitted; run review_escalation_status for full diagnostics`);
  }
  for (const ignored of ignoredVerdicts.slice(0, IGNORED_VERDICT_DETAIL_LIMIT)) {
    const id = ignoredVerdictKey(ignored);
    lines.push(`  - ignored host verdict ${id}: ${ignored.reasons.join('; ')}`);
  }
  if (ignoredVerdicts.length > IGNORED_VERDICT_DETAIL_LIMIT) {
    lines.push(`  - ${ignoredVerdicts.length - IGNORED_VERDICT_DETAIL_LIMIT} more ignored host verdict(s) omitted; run autopilot_review_status for full diagnostics`);
  }
  for (const reason of report.reasons) {
    lines.push(`  - ${reason}`);
  }
  lines.push('', renderReviewAssuranceGuidance(buildReviewAssuranceFloorGuidance(report)));
  lines.push(
    'Stale material recovery:',
    `  1. Re-run validation: lattice validate --story=${storyRef} --json`,
    `  2. Refresh stale verificationEvidence: lattice verification_evidence_refresh_stale --storyId=${storyRef} --dryRun; rerun listed evidence commands; rerun without --dryRun.`,
    `  3. Legal reviewer/host only: re-submit local host verdicts over materialHash=${materialRef}: lattice autopilot_review_submit --storyId=${storyRef} --runId={round-id} --hostId={host} --sessionId={session} --keyId={key} --decision=pass --materialDigest=${materialRef} --validationDigest={fresh-validation-digest} --promptDigest={current-prompt-digest}`,
    `  4. Re-check local diagnostics: lattice autopilot_review_status --storyId=${storyRef}; lattice review_escalation_status --storyId=${storyRef}`,
    '  - Do not bypass stale material checks; stale verdicts/evidence stay ignored until refreshed or resubmitted over the current material.',
  );
  return lines.join('\n');
}
