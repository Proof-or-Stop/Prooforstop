/**
 * @task B-963c
 * @checklist CHK-001
 * @title Bind explicit high-risk policy 3x2 requirement to review escalation
 * @type bugfix
 * @priority high
 * @description
 *   Implements the M8 requires3x2 predicate branch
 *   explicitlyConfiguredHighRiskPolicyRequires3x2 as a structured, local
 *   process fact consumed by review_escalation_status and the DONE review
 *   escalation gate. Prose, decision-doc paths, and changed-file classification
 *   remain diagnostic-only unless this policy fact is present and valid.
 * @changes
 *   - [CHK-001] Add explicit high-risk policy fact evaluation to review escalation.
 *   - [CHK-002] Expose the exact requirement predicate in code metadata so
 *     gap_analyze can bind the roadmap requirement to runtime coverage.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';
import { currentMaterialHash, currentStoryFilesHash } from './evidence-freshness.js';
import {
  evaluateHostVerdictRounds,
  type HostVerdictRound,
  type IgnoredHostVerdict,
} from './host-independence.js';
import { isReviewerAgent } from './review-run.js';
import type { Finding, ProcessEvent, StoryInfo } from './types.js';
import type { StoryStore } from './store.js';
import {
  buildProofAdmissibilityDiagnostic,
  proofAdmissibilityBlockingReason,
  resolveProofAdmissibilityPolicy,
  type ProofAdmissibilityDiagnostic,
} from './proof-admissibility-gates.js';

export const REVIEW_ESCALATION_TRIGGER_PROBLEM_COUNT = 2;
export const REVIEW_ESCALATION_REQUIRED_ROUNDS = 3;
export const REVIEW_ESCALATION_FULL_HOSTS_PER_ROUND = 2;
export const REVIEW_ESCALATION_DEGRADED_HOSTS_PER_ROUND = 1;
export const REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_EVENT = 'review_escalation_policy';
export const REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE = 'explicitlyConfiguredHighRiskPolicyRequires3x2';
export const REVIEW_HOST_AVAILABILITY_PROBE_EVENT = 'review_host_availability_probe';
export const REVIEW_HOST_AVAILABILITY_PROBE_COMMAND = 'review_host_availability_probe';
export const REVIEW_HOST_AVAILABILITY_REQUIRED_AVAILABLE_HOSTS = 2;
export const REVIEW_HOST_AVAILABILITY_DEFAULT_TIMEOUT_MS = 5000;

export const REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS = ['codex', 'claude', 'agy'] as const;
export type ReviewHostAvailabilityCanonicalHost = typeof REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS[number];

export const REVIEW_ESCALATION_FALLBACK_ELIGIBILITIES = [
  'single-host-environment',
  'temporary-host-unavailability',
  'explicit-human-approval',
] as const;

export type ReviewEscalationFallbackEligibility = typeof REVIEW_ESCALATION_FALLBACK_ELIGIBILITIES[number];
export type ReviewEscalationAssuranceLevel =
  | 'ordinary-review'
  | 'full-3x2'
  | 'degraded-single-host';

export interface CountableFirstRoundProblem {
  findingId: string;
  agent: string;
  severity: string;
  evidenceState: 'verified' | 'legacy-missing';
  reviewRound: string;
}

export interface ReviewEscalationFallbackRecord {
  index: number;
  fallbackId?: string;
  eligibility?: string;
  reason?: string;
  evidenceRefs: string[];
  approvalRef?: string;
  hostAvailabilityProbeId?: string;
  materialHash?: string;
  storyFilesHash?: string;
  assuranceLevel?: string;
  valid: boolean;
  reasons: string[];
  advisories?: string[];
}

export interface ReviewHostAvailabilityProbeHostRow {
  host: ReviewHostAvailabilityCanonicalHost;
  command: string;
  executablePath?: string;
  versionOk: boolean;
  available: boolean;
  versionOutput?: string;
  error?: string;
}

export interface ReviewHostAvailabilityProbeRecord {
  index: number;
  probeId?: string;
  checkedAt?: string;
  materialHash?: string;
  storyFilesHash?: string;
  hosts: ReviewHostAvailabilityProbeHostRow[];
  availableHostCount?: number;
  unavailableHostCount?: number;
  valid: boolean;
  reasons: string[];
}

export interface ReviewHostAvailabilityProbeEvent {
  type: typeof REVIEW_HOST_AVAILABILITY_PROBE_EVENT;
  command: typeof REVIEW_HOST_AVAILABILITY_PROBE_COMMAND;
  storyId: string;
  probeId: string;
  checkedAt: string;
  materialHash: string;
  storyFilesHash?: string;
  hosts: ReviewHostAvailabilityProbeHostRow[];
  availableHostCount: number;
  unavailableHostCount: number;
  authorityDone: false;
  fullAuthorityDone: false;
  productionDone: false;
}

export interface ReviewHostAvailabilityEligibilityAssessment {
  required: boolean;
  ok: boolean;
  latestFreshProbe: ReviewHostAvailabilityProbeRecord | null;
  records: ReviewHostAvailabilityProbeRecord[];
  reasons: string[];
}

export interface ReviewEscalationExplicitHighRiskPolicyRecord {
  index: number;
  policyId?: string;
  policyVersion?: string;
  milestoneId?: string;
  riskClass?: string;
  sourcePolicyRef?: string;
  rolloutStage?: string;
  degradedFallbackAllowed?: boolean;
  issuer?: string;
  approver?: string;
  issuedAt?: string;
  materialHash?: string;
  headHash?: string;
  valid: boolean;
  reasons: string[];
}

export interface ReviewEscalationExplicitHighRiskPolicyStatus {
  predicate: typeof REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE;
  required: boolean;
  validPolicy: ReviewEscalationExplicitHighRiskPolicyRecord | null;
  invalidPolicies: ReviewEscalationExplicitHighRiskPolicyRecord[];
}

export interface ReviewEscalationVoluntaryLocalRounds {
  required: false;
  materialHash: string | null;
  requiredRounds: number;
  requiredPassingHostsPerRound: number;
  submittedRoundCount: number;
  validRoundCount: number;
  complete: boolean;
  validRounds: HostVerdictRound[];
  invalidRounds: HostVerdictRound[];
  ignoredVerdicts: IgnoredHostVerdict[];
}

export interface CompletedReviewEscalationSnapshot {
  materialHash: string;
  storyFilesHash: string | null;
  source: 'delivery-check.json' | 'test-evidence.json';
}

export interface ReviewEscalationReport {
  schemaVersion: 'lattice.review_escalation_status.v1';
  ok: boolean;
  required: boolean;
  trigger: {
    firstReviewRound: string | null;
    requiredProblemCount: number;
    countableProblems: CountableFirstRoundProblem[];
    ignoredCount: number;
    explicitHighRiskPolicy: ReviewEscalationExplicitHighRiskPolicyStatus;
  };
  materialHash: string | null;
  storyFilesHash: string | null;
  advisories?: string[];
  fullQuorum: {
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
    record: ReviewEscalationFallbackRecord | null;
    requiredRounds: number;
    requiredPassingHostsPerRound: number;
    validRounds: HostVerdictRound[];
    invalidRounds: HostVerdictRound[];
    ignoredVerdicts: IgnoredHostVerdict[];
  };
  voluntaryLocalRounds: ReviewEscalationVoluntaryLocalRounds;
  assuranceLevel: ReviewEscalationAssuranceLevel;
  authorityDone: false;
  fullAuthorityDone: false;
  productionDone: false;
  proofAdmissibility: ProofAdmissibilityDiagnostic;
  reasons: string[];
}

export interface EvaluateReviewEscalationArgs {
  projectRoot: string;
  gitCwd?: string;
  storyId?: string;
  store?: Pick<StoryStore, 'readStory' | 'readFindings' | 'readProcessEvents'>;
  story?: StoryInfo;
  findings?: Finding[];
  processEvents?: ProcessEvent[];
  materialHash?: string;
  storyFilesHash?: string;
}

export function resolveCompletedReviewEscalationSnapshot(args: {
  storyId: string;
  store: Pick<StoryStore, 'readStory' | 'readTestEvidence' | 'readDeliveryCheck'>;
}): CompletedReviewEscalationSnapshot | null {
  const story = args.store.readStory(args.storyId);
  if (story.phase !== 'DONE') return null;
  const deliveryCheck = args.store.readDeliveryCheck(args.storyId);
  if (deliveryCheck?.materialHash) {
    return {
      materialHash: deliveryCheck.materialHash,
      storyFilesHash: deliveryCheck.storyFilesHash ?? null,
      source: 'delivery-check.json',
    };
  }
  const testEvidence = args.store.readTestEvidence(args.storyId);
  if (!testEvidence?.materialHash) return null;
  return {
    materialHash: testEvidence.materialHash,
    storyFilesHash: testEvidence.storyFilesHash ?? null,
    source: 'test-evidence.json',
  };
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const RETIRED_COMPLETION_FALSE_FIELDS = [
  'authorityDone',
  'fullAuthorityDone',
  'productionDone',
] as const;

function requireRetiredCompletionFieldsFalse(event: ProcessEvent, reasons: string[]): void {
  for (const field of RETIRED_COMPLETION_FALSE_FIELDS) {
    if (event[field] !== false) reasons.push('retired completion flag must be false');
  }
}

function isCanonicalHost(value: unknown): value is ReviewHostAvailabilityCanonicalHost {
  return typeof value === 'string' && (REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS as readonly string[]).includes(value);
}

function canonicalHostCommand(host: ReviewHostAvailabilityCanonicalHost): string {
  return host;
}

function pathEnvValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? '';
}

function executableNames(command: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return [command];
  if (extname(command)) return [command];
  const pathext = env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  return pathext.split(';').filter(Boolean).map(ext => `${command}${ext.toLowerCase()}`);
}

function resolveExecutablePath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathValue = pathEnvValue(env);
  if (!pathValue) return null;
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of executableNames(command, env)) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return realpathSync(candidate);
      } catch {
        // keep scanning PATH
      }
    }
  }
  return null;
}

function boundedOutput(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, 500);
}

function probeCanonicalHost(args: {
  host: ReviewHostAvailabilityCanonicalHost;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): ReviewHostAvailabilityProbeHostRow {
  const command = canonicalHostCommand(args.host);
  const env = args.env ?? process.env;
  const timeoutMs = args.timeoutMs ?? REVIEW_HOST_AVAILABILITY_DEFAULT_TIMEOUT_MS;
  const executablePath = resolveExecutablePath(command, env);
  if (!executablePath) {
    return {
      host: args.host,
      command,
      versionOk: false,
      available: false,
      error: 'executable not found in PATH',
    };
  }

  const result = spawnSync(executablePath, ['--version'], {
    cwd: args.cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  const versionOutput = boundedOutput(result.stdout) || boundedOutput(result.stderr);
  const versionOk = !result.error && result.status === 0;
  const error = result.error
    ? result.error.message
    : versionOk
      ? ''
      : `--version exited ${result.status ?? result.signal ?? 'without status'}`;
  return {
    host: args.host,
    command,
    executablePath,
    versionOk,
    available: versionOk,
    ...(versionOutput ? { versionOutput } : {}),
    ...(error ? { error } : {}),
  };
}

export function probeReviewHostAvailability(args: {
  storyId: string;
  materialHash: string;
  storyFilesHash?: string | null;
  probeId?: string;
  checkedAt?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): ReviewHostAvailabilityProbeEvent {
  const hosts = REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS.map(host => probeCanonicalHost({
    host,
    cwd: args.cwd,
    env: args.env,
    timeoutMs: args.timeoutMs,
  }));
  const availableHostCount = hosts.filter(host => host.available).length;
  return {
    type: REVIEW_HOST_AVAILABILITY_PROBE_EVENT,
    command: REVIEW_HOST_AVAILABILITY_PROBE_COMMAND,
    storyId: args.storyId,
    probeId: args.probeId || `${args.storyId}:RHP-${Date.now().toString(36)}`,
    checkedAt: args.checkedAt || new Date().toISOString(),
    materialHash: args.materialHash,
    ...(args.storyFilesHash ? { storyFilesHash: args.storyFilesHash } : {}),
    hosts,
    availableHostCount,
    unavailableHostCount: REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS.length - availableHostCount,
    authorityDone: false,
    fullAuthorityDone: false,
    productionDone: false,
  };
}

function latestByIndex<T extends { index: number }>(items: T[]): T | null {
  return items.length === 0 ? null : [...items].sort((a, b) => b.index - a.index)[0];
}

function uniqueReviewRounds(story: StoryInfo | null, findings: Finding[]): string[] {
  const rounds: string[] = [];
  for (const event of story?.events ?? []) {
    if (event.phase === 'REVIEW' && event.action === 'advance' && event.timestamp) {
      rounds.push(event.timestamp);
    }
  }
  if (rounds.length === 0) {
    for (const finding of findings) {
      if (finding.reviewRound) rounds.push(finding.reviewRound);
    }
  }
  return [...new Set(rounds)].sort((a, b) => {
    const at = Date.parse(a);
    const bt = Date.parse(b);
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
    return a.localeCompare(b);
  });
}

function countableFinding(finding: Finding, firstReviewRound: string | null): CountableFirstRoundProblem | null {
  if (!firstReviewRound) return null;
  if (finding.reviewRound !== firstReviewRound) return null;
  if (!isReviewerAgent(finding.agent)) return null;
  if (!['critical', 'high', 'medium'].includes(finding.severity)) return null;
  if (finding.evidenceState === 'suspected' || finding.evidenceState === 'disproven') return null;
  if (finding.evidenceState && finding.evidenceState !== 'verified') return null;
  return {
    findingId: finding.id,
    agent: finding.agent!,
    severity: finding.severity,
    evidenceState: finding.evidenceState === 'verified' ? 'verified' : 'legacy-missing',
    reviewRound: finding.reviewRound,
  };
}

function readStory(args: EvaluateReviewEscalationArgs): StoryInfo | null {
  if (args.story) return args.story;
  if (!args.store || !args.storyId) return null;
  return args.store.readStory(args.storyId);
}

function readFindings(args: EvaluateReviewEscalationArgs): Finding[] {
  if (args.findings) return args.findings;
  if (!args.store || !args.storyId) return [];
  return args.store.readFindings(args.storyId).findings;
}

function readEvents(args: EvaluateReviewEscalationArgs): ProcessEvent[] {
  if (args.processEvents) return args.processEvents;
  if (!args.store || !args.storyId) return [];
  return args.store.readProcessEvents(args.storyId);
}

export function isReviewEscalationFallbackEligibility(value: unknown): value is ReviewEscalationFallbackEligibility {
  return typeof value === 'string' && (REVIEW_ESCALATION_FALLBACK_ELIGIBILITIES as readonly string[]).includes(value);
}

export function reviewHostAvailabilityProbeRecordFromEvent(
  event: ProcessEvent,
  index: number,
  expectedMaterialHash: string,
  expectedStoryFilesHash: string | null,
): ReviewHostAvailabilityProbeRecord {
  const probeId = normalizeString(event.probeId);
  const checkedAt = normalizeString(event.checkedAt);
  const materialHash = normalizeString(event.materialHash);
  const storyFilesHash = normalizeString(event.storyFilesHash);
  const rows = Array.isArray(event.hosts) ? event.hosts : [];
  const hosts: ReviewHostAvailabilityProbeHostRow[] = [];
  const reasons: string[] = [];
  const seenHosts = new Set<string>();

  if (normalizeString(event.command) !== REVIEW_HOST_AVAILABILITY_PROBE_COMMAND) {
    reasons.push(`command must be ${REVIEW_HOST_AVAILABILITY_PROBE_COMMAND}`);
  }
  if (!probeId) reasons.push('missing probeId');
  if (!checkedAt) reasons.push('missing checkedAt');
  else if (!Number.isFinite(Date.parse(checkedAt))) reasons.push('checkedAt must be an ISO timestamp');
  if (!materialHash) reasons.push('missing materialHash');
  else if (materialHash !== expectedMaterialHash) reasons.push('materialHash is stale');
  if (expectedStoryFilesHash) {
    if (!storyFilesHash) reasons.push('missing storyFilesHash');
    else if (storyFilesHash !== expectedStoryFilesHash) reasons.push('storyFilesHash is stale');
  }
  requireRetiredCompletionFieldsFalse(event, reasons);

  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      reasons.push('hosts rows must be objects');
      continue;
    }
    const record = row as Record<string, unknown>;
    const host = normalizeString(record.host);
    const command = normalizeString(record.command);
    const executablePath = normalizeString(record.executablePath);
    const versionOk = record.versionOk;
    const available = record.available;
    if (!isCanonicalHost(host)) {
      reasons.push(`hosts row has non-canonical host ${host || '<missing>'}`);
      continue;
    }
    if (seenHosts.has(host)) reasons.push(`duplicate host row ${host}`);
    seenHosts.add(host);
    if (command !== canonicalHostCommand(host)) reasons.push(`hosts.${host}.command must be ${canonicalHostCommand(host)}`);
    if (typeof versionOk !== 'boolean') reasons.push(`hosts.${host}.versionOk must be boolean`);
    if (typeof available !== 'boolean') reasons.push(`hosts.${host}.available must be boolean`);
    const expectedAvailable = Boolean(executablePath) && versionOk === true;
    if (available !== expectedAvailable) {
      reasons.push(`hosts.${host}.available must equal executablePath present and versionOk=true`);
    }
    if (available === true && !executablePath) reasons.push(`hosts.${host}.executablePath is required when available`);
    hosts.push({
      host,
      command,
      ...(executablePath ? { executablePath } : {}),
      versionOk: versionOk === true,
      available: available === true,
      ...(normalizeString(record.versionOutput) ? { versionOutput: normalizeString(record.versionOutput) } : {}),
      ...(normalizeString(record.error) ? { error: normalizeString(record.error) } : {}),
    });
  }

  for (const host of REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS) {
    if (!seenHosts.has(host)) reasons.push(`missing canonical host row ${host}`);
  }
  const availableHostCount = typeof event.availableHostCount === 'number' && Number.isInteger(event.availableHostCount)
    ? event.availableHostCount
    : undefined;
  const unavailableHostCount = typeof event.unavailableHostCount === 'number' && Number.isInteger(event.unavailableHostCount)
    ? event.unavailableHostCount
    : undefined;
  const computedAvailable = hosts.filter(host => host.available).length;
  const computedUnavailable = REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS.length - computedAvailable;
  if (availableHostCount === undefined) reasons.push('availableHostCount must be an integer');
  else if (availableHostCount !== computedAvailable) reasons.push('availableHostCount contradicts host rows');
  if (unavailableHostCount === undefined) reasons.push('unavailableHostCount must be an integer');
  else if (unavailableHostCount !== computedUnavailable) reasons.push('unavailableHostCount contradicts host rows');

  return {
    index,
    ...(probeId ? { probeId } : {}),
    ...(checkedAt ? { checkedAt } : {}),
    ...(materialHash ? { materialHash } : {}),
    ...(storyFilesHash ? { storyFilesHash } : {}),
    hosts,
    ...(availableHostCount !== undefined ? { availableHostCount } : {}),
    ...(unavailableHostCount !== undefined ? { unavailableHostCount } : {}),
    valid: reasons.length === 0,
    reasons,
  };
}

export function reviewHostAvailabilityProbeRecords(
  events: ProcessEvent[],
  expectedMaterialHash: string,
  expectedStoryFilesHash: string | null,
): ReviewHostAvailabilityProbeRecord[] {
  return events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === REVIEW_HOST_AVAILABILITY_PROBE_EVENT)
    .map(({ event, index }) => reviewHostAvailabilityProbeRecordFromEvent(event, index, expectedMaterialHash, expectedStoryFilesHash));
}

export function reviewHostAvailabilityProbeRequiredForEligibility(eligibility: unknown): boolean {
  return eligibility === 'single-host-environment' || eligibility === 'temporary-host-unavailability';
}

export function assessReviewHostAvailabilityForFallbackEligibility(
  events: ProcessEvent[],
  eligibility: unknown,
  expectedMaterialHash: string,
  expectedStoryFilesHash: string | null,
): ReviewHostAvailabilityEligibilityAssessment {
  const required = reviewHostAvailabilityProbeRequiredForEligibility(eligibility);
  const records = reviewHostAvailabilityProbeRecords(events, expectedMaterialHash, expectedStoryFilesHash);
  if (!required) {
    return { required, ok: true, latestFreshProbe: null, records, reasons: [] };
  }
  const validRecords = records.filter(record => record.valid);
  const latestFreshProbe = latestByIndex(validRecords);
  const reasons: string[] = [];
  if (!latestFreshProbe) {
    reasons.push('no fresh review_host_availability_probe record found for current material; run review_host_availability_probe or use explicit-human-approval');
  } else if ((latestFreshProbe.availableHostCount ?? REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS.length) >= REVIEW_HOST_AVAILABILITY_REQUIRED_AVAILABLE_HOSTS) {
    reasons.push(`fresh host availability probe ${latestFreshProbe.probeId ?? `event#${latestFreshProbe.index}`} found ${latestFreshProbe.availableHostCount}/${REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS.length} canonical hosts available; use full 3x2 or explicit-human-approval`);
  }
  return {
    required,
    ok: reasons.length === 0,
    latestFreshProbe,
    records,
    reasons,
  };
}

export function reviewEscalationFallbackRecordFromEvent(
  event: ProcessEvent,
  index: number,
  expectedMaterialHash: string,
  expectedStoryFilesHash: string | null,
  events: ProcessEvent[],
): ReviewEscalationFallbackRecord {
  const eligibility = normalizeString(event.eligibility);
  const reason = normalizeString(event.reason);
  const evidenceRefs = Array.isArray(event.evidenceRefs)
    ? event.evidenceRefs.map(ref => normalizeString(ref)).filter(Boolean)
    : [];
  const approvalRef = normalizeString(event.approvalRef);
  const hostAvailabilityProbeId = normalizeString(event.hostAvailabilityProbeId);
  const materialHash = normalizeString(event.materialHash);
  const storyFilesHash = normalizeString(event.storyFilesHash);
  const assuranceLevel = normalizeString(event.assuranceLevel);
  const reasons: string[] = [];
  const advisories: string[] = [];

  if (normalizeString(event.command) !== 'review_escalation_fallback_set') {
    reasons.push('command must be review_escalation_fallback_set');
  }
  if (!isReviewEscalationFallbackEligibility(eligibility)) {
    reasons.push(`eligibility must be one of ${REVIEW_ESCALATION_FALLBACK_ELIGIBILITIES.join('|')}`);
  }
  if (reason.length < 20) reasons.push('reason must be at least 20 characters');
  if (evidenceRefs.length === 0 && !approvalRef) reasons.push('fallback requires evidenceRefs or approvalRef');
  if (!materialHash) reasons.push('missing materialHash');
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
  requireRetiredCompletionFieldsFalse(event, reasons);

  if (reviewHostAvailabilityProbeRequiredForEligibility(eligibility)) {
    const assessment = assessReviewHostAvailabilityForFallbackEligibility(events, eligibility, expectedMaterialHash, expectedStoryFilesHash);
    const referencedProbe = assessment.records.find(record => record.probeId === hostAvailabilityProbeId);
    if (!hostAvailabilityProbeId) {
      reasons.push('hostAvailabilityProbeId is required for non-human degraded fallback eligibility');
    } else if (!referencedProbe) {
      reasons.push(`hostAvailabilityProbeId ${hostAvailabilityProbeId} was not found`);
    } else if (!referencedProbe.valid) {
      reasons.push(`hostAvailabilityProbeId ${hostAvailabilityProbeId} is not fresh/valid: ${referencedProbe.reasons.join('; ')}`);
    } else if ((referencedProbe.availableHostCount ?? REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS.length) >= REVIEW_HOST_AVAILABILITY_REQUIRED_AVAILABLE_HOSTS) {
      reasons.push(`hostAvailabilityProbeId ${hostAvailabilityProbeId} found ${referencedProbe.availableHostCount}/${REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS.length} canonical hosts available; use full 3x2 or explicit-human-approval`);
    }
    if (!assessment.ok) reasons.push(...assessment.reasons.map(reason => `host availability probe invalid: ${reason}`));
  }

  return {
    index,
    ...(normalizeString(event.fallbackId) ? { fallbackId: normalizeString(event.fallbackId) } : {}),
    ...(eligibility ? { eligibility } : {}),
    ...(reason ? { reason } : {}),
    evidenceRefs,
    ...(approvalRef ? { approvalRef } : {}),
    ...(hostAvailabilityProbeId ? { hostAvailabilityProbeId } : {}),
    ...(materialHash ? { materialHash } : {}),
    ...(storyFilesHash ? { storyFilesHash } : {}),
    ...(assuranceLevel ? { assuranceLevel } : {}),
    valid: reasons.length === 0,
    reasons,
    ...(advisories.length > 0 ? { advisories } : {}),
  };
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function policyRecordFromEvent(
  event: ProcessEvent,
  index: number,
  expectedMaterialHash: string | null,
): ReviewEscalationExplicitHighRiskPolicyRecord {
  const policyId = normalizeString(event.policyId);
  const policyVersion = normalizeString(event.policyVersion);
  const milestoneId = normalizeString(event.milestoneId);
  const riskClass = normalizeString(event.riskClass);
  const sourcePolicyRef = normalizeString(event.sourcePolicyRef);
  const rolloutStage = normalizeString(event.rolloutStage);
  const degradedFallbackAllowed = booleanField(event.degradedFallbackAllowed);
  const issuer = normalizeString(event.issuer);
  const approver = normalizeString(event.approver);
  const issuedAt = normalizeString(event.issuedAt) || normalizeString(event.timestamp);
  const materialHash = normalizeString(event.materialHash);
  const headHash = normalizeString(event.headHash);
  const predicate = normalizeString(event.predicate);
  const reasons: string[] = [];

  if (event.requires3x2 !== true) reasons.push('requires3x2 must be true');
  if (predicate !== REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE) {
    reasons.push(`predicate must be ${REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE}`);
  }
  if (!policyVersion) reasons.push('missing policyVersion');
  if (!milestoneId && !riskClass) reasons.push('missing milestoneId or riskClass');
  if (!sourcePolicyRef) reasons.push('missing sourcePolicyRef');
  if (!rolloutStage) reasons.push('missing rolloutStage');
  if (degradedFallbackAllowed === undefined) reasons.push('degradedFallbackAllowed must be boolean');
  if (!issuer) reasons.push('missing issuer');
  if (!issuedAt) reasons.push('missing issuedAt');
  if (!materialHash) reasons.push('missing materialHash');
  else if (expectedMaterialHash && materialHash !== expectedMaterialHash) reasons.push('materialHash is stale');

  return {
    index,
    ...(policyId ? { policyId } : {}),
    ...(policyVersion ? { policyVersion } : {}),
    ...(milestoneId ? { milestoneId } : {}),
    ...(riskClass ? { riskClass } : {}),
    ...(sourcePolicyRef ? { sourcePolicyRef } : {}),
    ...(rolloutStage ? { rolloutStage } : {}),
    ...(degradedFallbackAllowed !== undefined ? { degradedFallbackAllowed } : {}),
    ...(issuer ? { issuer } : {}),
    ...(approver ? { approver } : {}),
    ...(issuedAt ? { issuedAt } : {}),
    ...(materialHash ? { materialHash } : {}),
    ...(headHash ? { headHash } : {}),
    valid: reasons.length === 0,
    reasons,
  };
}

function evaluateExplicitHighRiskPolicy(
  events: ProcessEvent[],
  materialHash: string | null,
): ReviewEscalationExplicitHighRiskPolicyStatus {
  const policies = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_EVENT)
    .map(({ event, index }) => policyRecordFromEvent(event, index, materialHash));
  const validPolicy = latestByIndex(policies.filter(policy => policy.valid));
  return {
    predicate: REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE,
    required: Boolean(validPolicy),
    validPolicy,
    invalidPolicies: policies.filter(policy => !policy.valid),
  };
}

function latestFallbackRecord(events: ProcessEvent[], expectedMaterialHash: string, expectedStoryFilesHash: string | null): ReviewEscalationFallbackRecord | null {
  const records = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'review_escalation_fallback')
    .map(({ event, index }) => reviewEscalationFallbackRecordFromEvent(event, index, expectedMaterialHash, expectedStoryFilesHash, events));
  return latestByIndex(records);
}

function emptyRoundReport() {
  return {
    requiredRounds: REVIEW_ESCALATION_REQUIRED_ROUNDS,
    requiredPassingHostsPerRound: REVIEW_ESCALATION_FULL_HOSTS_PER_ROUND,
    ok: false,
    validRounds: [],
    invalidRounds: [],
    ignoredVerdicts: [],
  };
}

function emptyVoluntaryLocalRounds(materialHash: string | null): ReviewEscalationVoluntaryLocalRounds {
  return {
    required: false,
    materialHash,
    requiredRounds: REVIEW_ESCALATION_REQUIRED_ROUNDS,
    requiredPassingHostsPerRound: REVIEW_ESCALATION_FULL_HOSTS_PER_ROUND,
    submittedRoundCount: 0,
    validRoundCount: 0,
    complete: false,
    validRounds: [],
    invalidRounds: [],
    ignoredVerdicts: [],
  };
}

function evaluateVoluntaryLocalRounds(
  events: ProcessEvent[],
  materialHash: string | null,
): ReviewEscalationVoluntaryLocalRounds {
  if (!materialHash) return emptyVoluntaryLocalRounds(null);
  const rounds = evaluateHostVerdictRounds(events, materialHash, REVIEW_ESCALATION_FULL_HOSTS_PER_ROUND);
  const submittedRoundCount = new Set([
    ...rounds.validRounds.map(round => round.runId),
    ...rounds.invalidRounds.map(round => round.runId),
  ]).size;
  return {
    required: false,
    materialHash,
    requiredRounds: REVIEW_ESCALATION_REQUIRED_ROUNDS,
    requiredPassingHostsPerRound: REVIEW_ESCALATION_FULL_HOSTS_PER_ROUND,
    submittedRoundCount,
    validRoundCount: rounds.validRounds.length,
    complete: rounds.validRounds.length >= REVIEW_ESCALATION_REQUIRED_ROUNDS,
    validRounds: rounds.validRounds,
    invalidRounds: rounds.invalidRounds,
    ignoredVerdicts: rounds.ignoredVerdicts,
  };
}

export function eventsWithStoryFilesHashDowngrade(
  events: ProcessEvent[],
  currentMaterialHash: string,
  currentStoryFilesHash: string | null,
  advisories: string[],
): ProcessEvent[] {
  if (!currentStoryFilesHash) return events;
  return events.map((event, index) => {
    if (event.type !== 'host_verdict') return event;
    const materialDigest = normalizeString(event.materialDigest);
    const storyFilesHash = normalizeString(event.storyFilesHash);
    if (!materialDigest || materialDigest === currentMaterialHash) return event;
    if (!storyFilesHash || storyFilesHash !== currentStoryFilesHash) return event;
    const verdictId = normalizeString(event.verdictId) || `event#${index}`;
    advisories.push(`host verdict ${verdictId}: materialDigest drift accepted because storyFilesHash matches; re-attestation advisory required`);
    return {
      ...event,
      originalMaterialDigest: materialDigest,
      materialDigest: currentMaterialHash,
    };
  });
}

export function evaluateReviewEscalation(args: EvaluateReviewEscalationArgs): ReviewEscalationReport {
  const story = readStory(args);
  const findings = readFindings(args);
  const events = readEvents(args);
  const gitCwd = args.gitCwd ?? args.projectRoot;
  const firstReviewRound = uniqueReviewRounds(story, findings)[0] ?? null;
  const countableProblems = findings
    .map(finding => countableFinding(finding, firstReviewRound))
    .filter((problem): problem is CountableFirstRoundProblem => problem !== null);
  const materialHash = args.materialHash ?? currentMaterialHash(gitCwd, 'HEAD', args.projectRoot) ?? null;
  const storyFilesHash = args.storyFilesHash ?? currentStoryFilesHash(gitCwd, 'HEAD', args.projectRoot) ?? null;
  const explicitHighRiskPolicy = evaluateExplicitHighRiskPolicy(events, materialHash);
  const thresholdRequired = countableProblems.length >= REVIEW_ESCALATION_TRIGGER_PROBLEM_COUNT;
  const required = thresholdRequired || explicitHighRiskPolicy.required;
  const reasons: string[] = [];
  const advisories: string[] = [];
  const effectiveEvents = materialHash
    ? eventsWithStoryFilesHashDowngrade(events, materialHash, storyFilesHash, advisories)
    : events;
  const voluntaryLocalRounds = evaluateVoluntaryLocalRounds(effectiveEvents, materialHash);
  const proofPolicy = resolveProofAdmissibilityPolicy(args.projectRoot);
  const reviewEscalationProof = (bindingValid: boolean) => buildProofAdmissibilityDiagnostic({
    artifactKind: 'review-run',
    artifactId: args.storyId ? `${args.storyId}:review-escalation` : 'review-escalation',
    consumer: 'REVIEW',
    claim: 'review-pass',
    policy: proofPolicy,
    checks: {
      schemaVersion: 'lattice.review_run.v1',
      strictShapeValid: true,
      semanticDigestValid: Boolean(materialHash),
      signatureOrReceiptBindingValid: bindingValid,
      temporalAndMaterialBindingValid: Boolean(materialHash),
      subjectMatches: true,
      producerBoundaryTrusted: true,
    },
  });
  const inactiveProofAdmissibility = reviewEscalationProof(false);
  const trigger = {
    firstReviewRound,
    requiredProblemCount: REVIEW_ESCALATION_TRIGGER_PROBLEM_COUNT,
    countableProblems,
    ignoredCount: findings.length - countableProblems.length,
    explicitHighRiskPolicy,
  };

  if (!required) {
    return {
      schemaVersion: 'lattice.review_escalation_status.v1',
      ok: true,
      required: false,
      trigger,
      materialHash,
      storyFilesHash,
      ...(advisories.length > 0 ? { advisories } : {}),
      fullQuorum: { ...emptyRoundReport(), ok: true },
      degradedFallback: {
        ok: false,
        allowed: false,
        record: null,
        requiredRounds: REVIEW_ESCALATION_REQUIRED_ROUNDS,
        requiredPassingHostsPerRound: REVIEW_ESCALATION_DEGRADED_HOSTS_PER_ROUND,
        validRounds: [],
        invalidRounds: [],
        ignoredVerdicts: [],
      },
      voluntaryLocalRounds,
      assuranceLevel: 'ordinary-review',
      authorityDone: false,
      fullAuthorityDone: false,
      productionDone: false,
      proofAdmissibility: inactiveProofAdmissibility,
      reasons: [],
    };
  }

  if (!materialHash) {
    reasons.push('current material hash is unavailable');
    return {
      schemaVersion: 'lattice.review_escalation_status.v1',
      ok: false,
      required: true,
      trigger,
      materialHash: null,
      storyFilesHash,
      ...(advisories.length > 0 ? { advisories } : {}),
      fullQuorum: emptyRoundReport(),
      degradedFallback: {
        ok: false,
        allowed: false,
        record: null,
        requiredRounds: REVIEW_ESCALATION_REQUIRED_ROUNDS,
        requiredPassingHostsPerRound: REVIEW_ESCALATION_DEGRADED_HOSTS_PER_ROUND,
        validRounds: [],
        invalidRounds: [],
        ignoredVerdicts: [],
      },
      voluntaryLocalRounds,
      assuranceLevel: 'ordinary-review',
      authorityDone: false,
      fullAuthorityDone: false,
      productionDone: false,
      proofAdmissibility: inactiveProofAdmissibility,
      reasons,
    };
  }

  const fullRounds = evaluateHostVerdictRounds(effectiveEvents, materialHash, REVIEW_ESCALATION_FULL_HOSTS_PER_ROUND);
  const fullOk = fullRounds.validRounds.length >= REVIEW_ESCALATION_REQUIRED_ROUNDS;
  const fallback = latestFallbackRecord(events, materialHash, storyFilesHash);
  const degradedRounds = evaluateHostVerdictRounds(effectiveEvents, materialHash, REVIEW_ESCALATION_DEGRADED_HOSTS_PER_ROUND);
  const degradedRoundsOk = degradedRounds.validRounds.length >= REVIEW_ESCALATION_REQUIRED_ROUNDS;
  const explicitPolicyDisallowsDegraded = explicitHighRiskPolicy.validPolicy?.degradedFallbackAllowed === false;
  const degradedOk = !explicitPolicyDisallowsDegraded && fallback?.valid === true && degradedRoundsOk;
  if (fallback?.advisories?.length) advisories.push(...fallback.advisories.map(reason => `fallback advisory: ${reason}`));
  const proofAdmissibility = reviewEscalationProof(fullOk || degradedOk);
  const proofBlockReason = proofAdmissibilityBlockingReason(proofAdmissibility);

  if (!fullOk && !degradedOk) {
    reasons.push(
      `review escalation requires ${REVIEW_ESCALATION_REQUIRED_ROUNDS} rounds x ${REVIEW_ESCALATION_FULL_HOSTS_PER_ROUND} independent PASS hosts, or an explicit degraded fallback with ${REVIEW_ESCALATION_REQUIRED_ROUNDS} rounds x ${REVIEW_ESCALATION_DEGRADED_HOSTS_PER_ROUND} PASS host`,
    );
    if (explicitHighRiskPolicy.required) {
      const policy = explicitHighRiskPolicy.validPolicy;
      reasons.push(`explicit high-risk policy requires 3x2: ${policy?.policyId ?? policy?.policyVersion ?? REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE}`);
    }
    if (explicitPolicyDisallowsDegraded) reasons.push('explicit high-risk policy disallows degraded single-host fallback');
    if (!fallback) reasons.push('no review_escalation_fallback record found for degraded fallback');
    else if (!fallback.valid) reasons.push(...fallback.reasons.map(reason => `fallback invalid: ${reason}`));
    if (!degradedRoundsOk) reasons.push(`degraded fallback has ${degradedRounds.validRounds.length}/${REVIEW_ESCALATION_REQUIRED_ROUNDS} valid single-host rounds`);
  }

  const effectiveOk = (fullOk || degradedOk) && !proofBlockReason;
  const effectiveReasons = proofBlockReason
    ? [...reasons, proofBlockReason]
    : reasons;

  return {
    schemaVersion: 'lattice.review_escalation_status.v1',
    ok: effectiveOk,
    required: true,
    trigger,
    materialHash,
    storyFilesHash,
    ...(advisories.length > 0 ? { advisories } : {}),
    fullQuorum: {
      requiredRounds: REVIEW_ESCALATION_REQUIRED_ROUNDS,
      requiredPassingHostsPerRound: REVIEW_ESCALATION_FULL_HOSTS_PER_ROUND,
      ok: fullOk,
      ...fullRounds,
    },
    degradedFallback: {
      ok: degradedOk,
      allowed: !explicitPolicyDisallowsDegraded && fallback?.valid === true,
      record: fallback,
      requiredRounds: REVIEW_ESCALATION_REQUIRED_ROUNDS,
      requiredPassingHostsPerRound: REVIEW_ESCALATION_DEGRADED_HOSTS_PER_ROUND,
      ...degradedRounds,
    },
    voluntaryLocalRounds,
    assuranceLevel: fullOk ? 'full-3x2' : degradedOk ? 'degraded-single-host' : 'ordinary-review',
    authorityDone: false,
    fullAuthorityDone: false,
    productionDone: false,
    proofAdmissibility,
    reasons: effectiveReasons,
  };
}

export function formatReviewEscalationFailure(report: ReviewEscalationReport): string {
  if (report.ok) return '';
  const thresholdTriggered = report.trigger.countableProblems.length >= report.trigger.requiredProblemCount;
  const policyTriggered = report.trigger.explicitHighRiskPolicy.required;
  const triggerSummary = thresholdTriggered && policyTriggered
    ? 'first REVIEW round countable reviewer problems and an explicit high-risk policy both require review escalation quorum'
    : policyTriggered
      ? `explicit high-risk policy ${REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE} requires review escalation quorum`
      : 'first REVIEW round recorded multiple countable reviewer problems; review escalation quorum is required';
  const lines = [
    `Cannot enter DONE: ${triggerSummary}. [review_escalation_missing]`,
    `  - first review round: ${report.trigger.firstReviewRound ?? '<missing>'}`,
    `  - countable first-round problems: ${report.trigger.countableProblems.length}/${report.trigger.requiredProblemCount}`,
    `  - explicit high-risk policy: ${report.trigger.explicitHighRiskPolicy.required ? 'required' : 'not-required'}`,
    `  - materialHash: ${report.materialHash ?? '<missing>'}`,
    `  - storyFilesHash: ${report.storyFilesHash ?? '<missing>'}`,
    `  - full quorum: ${report.fullQuorum.validRounds.length}/${report.fullQuorum.requiredRounds} rounds with ${report.fullQuorum.requiredPassingHostsPerRound} independent PASS hosts`,
    `  - degraded fallback: ${report.degradedFallback.validRounds.length}/${report.degradedFallback.requiredRounds} rounds with ${report.degradedFallback.requiredPassingHostsPerRound} PASS host; explicit fallback=${report.degradedFallback.allowed ? 'valid' : 'missing/invalid'}`,
  ];
  for (const problem of report.trigger.countableProblems.slice(0, 8)) {
    lines.push(`  - problem ${problem.findingId}: ${problem.agent} [${problem.severity}] evidenceState=${problem.evidenceState}`);
  }
  if (report.trigger.explicitHighRiskPolicy.validPolicy) {
    const policy = report.trigger.explicitHighRiskPolicy.validPolicy;
    lines.push(`  - policy ${policy.policyId ?? policy.index}: version=${policy.policyVersion} source=${policy.sourcePolicyRef} degradedAllowed=${policy.degradedFallbackAllowed}`);
  }
  for (const policy of report.trigger.explicitHighRiskPolicy.invalidPolicies.slice(0, 5)) {
    lines.push(`  - ignored explicit policy ${policy.policyId ?? `event#${policy.index}`}: ${policy.reasons.join('; ')}`);
  }
  for (const round of report.fullQuorum.invalidRounds.slice(0, 5)) {
    lines.push(`  - invalid full round ${round.runId}: ${round.reasons.join('; ')}`);
  }
  for (const ignored of report.fullQuorum.ignoredVerdicts.slice(0, 8)) {
    const id = ignored.verdictId ?? `event#${ignored.index}`;
    lines.push(`  - ignored host verdict ${id}: ${ignored.reasons.join('; ')}`);
  }
  for (const reason of report.reasons) {
    lines.push(`  - ${reason}`);
  }
  for (const advisory of report.advisories || []) {
    lines.push(`  - advisory: ${advisory}`);
  }
  lines.push('→ Run review_escalation_status for diagnostics. Submit fresh host verdicts with autopilot_review_submit, or record an explicit degraded fallback with review_escalation_fallback_set.');
  return lines.join('\n');
}

export function formatReviewEscalationReport(report: ReviewEscalationReport): string {
  const lines = [
    `Review escalation (${report.schemaVersion})`,
    `required: ${report.required}`,
    `ok: ${report.ok}`,
    `assuranceLevel: ${report.assuranceLevel}`,
    `admissibilityStatus: ${report.ok ? 'local-review-satisfied' : 'local-review-incomplete'}`,
    'evidenceScope: local-review-escalation',
    `firstReviewRound: ${report.trigger.firstReviewRound ?? '<missing>'}`,
    `countableProblems: ${report.trigger.countableProblems.length}/${report.trigger.requiredProblemCount}`,
    `explicitHighRiskPolicy: ${report.trigger.explicitHighRiskPolicy.required ? 'required' : 'not-required'} (${REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE})`,
    `materialHash: ${report.materialHash ?? '<missing>'}`,
    `storyFilesHash: ${report.storyFilesHash ?? '<missing>'}`,
    `fullQuorum: ${report.fullQuorum.validRounds.length}/${report.fullQuorum.requiredRounds} rounds x ${report.fullQuorum.requiredPassingHostsPerRound} hosts`,
    `voluntaryLocalRounds: ${report.voluntaryLocalRounds.validRoundCount}/${report.voluntaryLocalRounds.requiredRounds} rounds x ${report.voluntaryLocalRounds.requiredPassingHostsPerRound} hosts (submitted=${report.voluntaryLocalRounds.submittedRoundCount}, complete=${report.voluntaryLocalRounds.complete})`,
    `degradedFallback: ${report.degradedFallback.ok ? 'pass' : 'not-satisfied'} (${report.degradedFallback.validRounds.length}/${report.degradedFallback.requiredRounds} rounds x ${report.degradedFallback.requiredPassingHostsPerRound} host)`,
  ];
  for (const round of report.voluntaryLocalRounds.invalidRounds.slice(0, 5)) {
    lines.push(`  - voluntary invalid round ${round.runId}: ${round.reasons.join('; ')}`);
  }
  for (const ignored of report.voluntaryLocalRounds.ignoredVerdicts.slice(0, 5)) {
    const id = ignored.verdictId ?? `event#${ignored.index}`;
    lines.push(`  - voluntary ignored host verdict ${id}: ${ignored.reasons.join('; ')}`);
  }
  if (report.degradedFallback.record) {
    lines.push(`fallbackRecord: ${report.degradedFallback.record.valid ? 'valid' : 'invalid'} ${report.degradedFallback.record.fallbackId ?? `event#${report.degradedFallback.record.index}`}`);
    for (const advisory of report.degradedFallback.record.advisories || []) {
      lines.push(`  - fallback advisory: ${advisory}`);
    }
  }
  for (const advisory of report.advisories || []) {
    lines.push(`  - advisory: ${advisory}`);
  }
  if (report.trigger.explicitHighRiskPolicy.validPolicy) {
    const policy = report.trigger.explicitHighRiskPolicy.validPolicy;
    lines.push(`explicitPolicy: valid ${policy.policyId ?? `event#${policy.index}`} policyVersion=${policy.policyVersion} rolloutStage=${policy.rolloutStage} degradedAllowed=${policy.degradedFallbackAllowed}`);
  }
  for (const policy of report.trigger.explicitHighRiskPolicy.invalidPolicies.slice(0, 5)) {
    lines.push(`  - ignored explicit policy ${policy.policyId ?? `event#${policy.index}`}: ${policy.reasons.join('; ')}`);
  }
  if (!report.ok && report.required) {
    lines.push('', formatReviewEscalationFailure(report).replace(/^Cannot enter DONE: /, 'Blocked: '));
  }
  return lines.join('\n');
}
