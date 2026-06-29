/**
 * ProofStory progressive intent hardening.
 *
 * This module is pure: it builds story-scoped intent artifacts and evaluates
 * diagnostics. Lifecycle integration imports only the evaluators; no second
 * lifecycle state machine or child-story scheduler lives here.
 */

import { createHash } from 'node:crypto';
import type {
  ChecklistData,
  ChecklistItem,
  DoneIntentEquivalenceReport,
  IntentCollisionData,
  IntentCollisionDecision,
  MilestoneLedgerData,
  MilestoneLedgerItem,
  MilestoneLedgerState,
  MilestoneStatus,
  OriginalIntentSnapshotData,
  ProofStoryAcceptanceBinding,
  ProofStoryContractData,
  ProofStoryDiagnosticGap,
  ProofStoryDiagnosticReport,
  ProofStoryGateMode,
  ProofStoryHardeningLevel,
  ProofStoryLedgerSizing,
  ProofStoryReviewCompletenessReport,
  ProofStorySpikeData,
  ProofStorySpikeRecord,
  ProofStorySpikeStatus,
  ProofStoryTriggerReason,
  RedEvidenceData,
  RedEvidenceRecord,
  ScopeContractData,
  ScopeShrinkageDecisionData,
  StoryInfo,
  VerificationEvidence,
  VerificationLane,
} from './types.js';

export const ORIGINAL_INTENT_SNAPSHOT_SCHEMA_VERSION = 'proofstory.original_intent_snapshot.v1';
export const MILESTONE_LEDGER_SCHEMA_VERSION = 'proofstory.milestone_ledger.v1';
export const PROOFSTORY_CONTRACT_SCHEMA_VERSION = 'proofstory.contract.v1';
export const PROOFSTORY_DIAGNOSTIC_REPORT_SCHEMA_VERSION = 'proofstory.diagnostic_report.v1';
export const INTENT_COLLISION_SCHEMA_VERSION = 'proofstory.intent_collision.v1';
export const SCOPE_SHRINKAGE_DECISION_SCHEMA_VERSION = 'proofstory.scope_shrinkage_decision.v1';
export const RED_EVIDENCE_SCHEMA_VERSION = 'proofstory.red_evidence.v1';
export const SPIKE_SCHEMA_VERSION = 'proofstory.spike.v1';
export const DONE_INTENT_EQUIVALENCE_SCHEMA_VERSION = 'proofstory.done_intent_equivalence.v1';
export const REVIEW_COMPLETENESS_SCHEMA_VERSION = 'proofstory.review_completeness.v1';

const DEFAULT_KEY_REQUIREMENT_IDS = ['REQ-001'];
const VALID_MILESTONE_STATUSES = new Set<MilestoneStatus>(['planned', 'covered', 'done', 'not_applicable']);
const VERIFICATION_LANES: readonly VerificationLane[] = ['happy', 'edge', 'adversarial'];
const VALID_GATE_MODES = new Set<ProofStoryGateMode>(['observe', 'warn', 'enforce']);
const VALID_COLLISION_DECISIONS = new Set<IntentCollisionDecision>(['pass', 'revise_intent', 'human_gate', 'stop']);
const VALID_SPIKE_STATUSES = new Set<ProofStorySpikeStatus>(['active', 'resolved', 'discarded', 'promoted']);
const LEDGER_THRESHOLDS: Record<ProofStoryHardeningLevel, number> = {
  intent_mvp: 10,
  standard: 7,
  high_assurance: 5,
};

export interface BuildOriginalIntentSnapshotArgs {
  storyId: string;
  sourceText: string;
  normalizedOutcome: string;
  acceptanceClaim: string;
  keyRequirementIds?: string[];
}

export interface BuildMilestoneLedgerArgs {
  storyId: string;
  milestones: unknown[];
  existing?: MilestoneLedgerData | null;
  state?: MilestoneLedgerState;
}

export interface ProofStoryDiagnosticInput {
  story: StoryInfo;
  checklist: ChecklistData;
  originalIntentSnapshot: OriginalIntentSnapshotData | null;
  milestoneLedger: MilestoneLedgerData | null;
  proofStoryContract: Pick<ProofStoryContractData, 'acceptanceBindings'> | null;
  intentCollision: IntentCollisionData | null;
  scopeContract: ScopeContractData | null;
  scopeShrinkageDecision: ScopeShrinkageDecisionData | null;
  redEvidence: RedEvidenceData | null;
  spikeEvidence: ProofStorySpikeData | null;
}

export interface BuildProofStoryContractArgs {
  storyId: string;
  acceptanceBindings?: unknown[];
  note?: string;
}

export interface BuildIntentCollisionArgs {
  storyId: string;
  decision: IntentCollisionDecision;
  acceptedInterpretation?: string;
  notes?: string;
  id?: string;
}

export interface BuildScopeShrinkageDecisionArgs {
  storyId: string;
  decision: 'confirmed' | 'rejected';
  removedMilestoneIds?: string[];
  reason: string;
  approvedBy: string;
}

export interface AppendRedEvidenceArgs {
  storyId: string;
  trigger: string;
  observedFailure: string;
  failingCommand?: string;
  expectedGreenCommand?: string;
  note?: string;
  id?: string;
}

export interface BuildSpikeArgs {
  storyId: string;
  id?: string;
  question?: string;
  result?: string;
  note?: string;
  promotedAs?: ProofStorySpikeRecord['promotedAs'];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((key) => [key, canonicalize(obj[key])]),
    );
  }
  return value;
}

function sha256Stable(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function optionalNonEmptyString(value: unknown, fieldName: string): string | undefined {
  if (value == null) return undefined;
  return requireNonEmptyString(value, fieldName);
}

function optionalStringArray(value: unknown, fieldName: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(`${fieldName} contains an invalid value: ${JSON.stringify(entry)}`);
    }
    out.push(entry.trim());
  }
  return [...new Set(out)];
}

function normalizeGateMode(value: unknown): ProofStoryGateMode {
  if (value == null) return 'observe';
  if (typeof value !== 'string' || !VALID_GATE_MODES.has(value as ProofStoryGateMode)) {
    throw new Error('mode must be one of: observe, warn, enforce');
  }
  return value as ProofStoryGateMode;
}

function normalizeLedgerState(value: unknown, fallback: MilestoneLedgerState): MilestoneLedgerState {
  if (value == null) return fallback;
  if (value !== 'candidate' && value !== 'confirmed') throw new Error('state must be candidate or confirmed');
  return value;
}

function defaultId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
}

export function normalizeKeyRequirementIds(ids: unknown): string[] {
  const normalized = optionalStringArray(ids, 'keyRequirementIds');
  const effective = normalized.length > 0 ? normalized : DEFAULT_KEY_REQUIREMENT_IDS;
  return [...new Set(effective)].sort((a, b) => a.localeCompare(b));
}

export function computeIntentRequestHash(sourceText: string, keyRequirementIds: readonly string[]): string {
  return sha256Stable({ sourceText, keyRequirementIds: [...keyRequirementIds].sort((a, b) => a.localeCompare(b)) });
}

export function buildOriginalIntentSnapshot(
  args: BuildOriginalIntentSnapshotArgs,
  existing?: OriginalIntentSnapshotData | null,
): OriginalIntentSnapshotData {
  const sourceText = requireNonEmptyString(args.sourceText, 'sourceText');
  const normalizedOutcome = requireNonEmptyString(args.normalizedOutcome, 'normalizedOutcome');
  const acceptanceClaim = requireNonEmptyString(args.acceptanceClaim, 'acceptanceClaim');
  const keyRequirementIds = normalizeKeyRequirementIds(args.keyRequirementIds);
  const requestHash = computeIntentRequestHash(sourceText, keyRequirementIds);
  if (existing && existing.requestHash !== requestHash) {
    throw new Error(
      `original intent snapshot is immutable: existing requestHash ${existing.requestHash} does not match new requestHash ${requestHash}`,
    );
  }
  const now = new Date().toISOString();
  return {
    schemaVersion: ORIGINAL_INTENT_SNAPSHOT_SCHEMA_VERSION,
    storyId: args.storyId,
    sourceText,
    normalizedOutcome,
    acceptanceClaim,
    keyRequirementIds,
    requestHash,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function normalizeMilestone(raw: unknown, index: number): MilestoneLedgerItem {
  if (!raw || typeof raw !== 'object') throw new Error(`milestones[${index}] must be an object`);
  const obj = raw as Record<string, unknown>;
  const status = obj.status == null ? 'planned' : requireNonEmptyString(obj.status, `milestones[${index}].status`);
  if (!VALID_MILESTONE_STATUSES.has(status as MilestoneStatus)) {
    throw new Error(`milestones[${index}].status must be one of: planned, covered, done, not_applicable`);
  }
  return {
    id: requireNonEmptyString(obj.id, `milestones[${index}].id`),
    sourceRequirementId: requireNonEmptyString(obj.sourceRequirementId, `milestones[${index}].sourceRequirementId`),
    claim: requireNonEmptyString(obj.claim, `milestones[${index}].claim`),
    doneMeans: requireNonEmptyString(obj.doneMeans, `milestones[${index}].doneMeans`),
    requiredEvidence: optionalStringArray(obj.requiredEvidence, `milestones[${index}].requiredEvidence`),
    checklistRefs: optionalStringArray(obj.checklistRefs, `milestones[${index}].checklistRefs`),
    verificationIntentRefs: optionalStringArray(obj.verificationIntentRefs, `milestones[${index}].verificationIntentRefs`),
    status: status as MilestoneStatus,
  };
}

export function computeMilestoneLedgerHash(milestones: readonly MilestoneLedgerItem[]): string {
  return sha256Stable({
    milestones: [...milestones].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function buildMilestoneLedger(args: BuildMilestoneLedgerArgs): MilestoneLedgerData {
  if (!Array.isArray(args.milestones)) throw new Error('milestones must be an array');
  const milestones = args.milestones.map((raw, index) => normalizeMilestone(raw, index));
  const ids = new Set<string>();
  for (const milestone of milestones) {
    if (ids.has(milestone.id)) throw new Error(`duplicate milestone id: ${milestone.id}`);
    ids.add(milestone.id);
  }
  const ledgerHash = computeMilestoneLedgerHash(milestones);
  const existingHash = args.existing?.ledgerHash ?? computeMilestoneLedgerHash(args.existing?.milestones ?? []);
  const requestedState = normalizeLedgerState(args.state, args.existing?.state ?? 'candidate');
  const state = requestedState === 'confirmed' && args.existing?.state === 'confirmed' && existingHash === ledgerHash
    ? 'confirmed'
    : 'candidate';
  const now = new Date().toISOString();
  return {
    schemaVersion: MILESTONE_LEDGER_SCHEMA_VERSION,
    storyId: args.storyId,
    state,
    ledgerHash,
    acceptedIntentBinding: state === 'confirmed' && existingHash === ledgerHash ? args.existing?.acceptedIntentBinding : undefined,
    milestones,
    createdAt: args.existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function addMilestoneToLedger(
  storyId: string,
  rawMilestone: unknown,
  existing: MilestoneLedgerData | null,
): MilestoneLedgerData {
  const milestone = normalizeMilestone(rawMilestone, existing?.milestones.length ?? 0);
  if (existing?.milestones.some((item) => item.id === milestone.id)) {
    throw new Error(`duplicate milestone id: ${milestone.id}`);
  }
  return buildMilestoneLedger({
    storyId,
    existing: { ...(existing ?? emptyMilestoneLedger(storyId)), state: 'candidate', acceptedIntentBinding: undefined },
    milestones: [...(existing?.milestones ?? []), milestone],
    state: 'candidate',
  });
}

function emptyMilestoneLedger(storyId: string): MilestoneLedgerData {
  const now = new Date().toISOString();
  return {
    schemaVersion: MILESTONE_LEDGER_SCHEMA_VERSION,
    storyId,
    state: 'candidate',
    ledgerHash: computeMilestoneLedgerHash([]),
    milestones: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function confirmMilestoneLedger(
  storyId: string,
  ledger: MilestoneLedgerData | null,
  collision: IntentCollisionData,
): MilestoneLedgerData | null {
  if (!ledger) return null;
  if (!collisionAccepted(collision) || !collision.acceptedInterpretationHash) return ledger;
  const now = new Date().toISOString();
  return {
    ...ledger,
    storyId,
    state: 'confirmed',
    ledgerHash: ledger.ledgerHash ?? computeMilestoneLedgerHash(ledger.milestones),
    acceptedIntentBinding: {
      intentCollisionId: collision.id,
      acceptedInterpretationHash: collision.acceptedInterpretationHash,
      acceptedAt: now,
    },
    updatedAt: now,
  };
}

function normalizeAcceptanceBinding(raw: unknown, index: number): ProofStoryAcceptanceBinding {
  if (!raw || typeof raw !== 'object') throw new Error(`acceptanceBindings[${index}] must be an object`);
  const obj = raw as Record<string, unknown>;
  const binding: ProofStoryAcceptanceBinding = {
    id: requireNonEmptyString(obj.id, `acceptanceBindings[${index}].id`),
    checklistRefs: optionalStringArray(obj.checklistRefs, `acceptanceBindings[${index}].checklistRefs`),
    verificationIntentRefs: optionalStringArray(obj.verificationIntentRefs, `acceptanceBindings[${index}].verificationIntentRefs`),
    milestoneIds: optionalStringArray(obj.milestoneIds, `acceptanceBindings[${index}].milestoneIds`),
  };
  if (obj.acceptanceClaim !== undefined) {
    binding.acceptanceClaim = requireNonEmptyString(obj.acceptanceClaim, `acceptanceBindings[${index}].acceptanceClaim`);
  }
  if (obj.note !== undefined) binding.note = requireNonEmptyString(obj.note, `acceptanceBindings[${index}].note`);
  return binding;
}

function normalizeAcceptanceBindings(raw: unknown): ProofStoryAcceptanceBinding[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('acceptanceBindings must be an array');
  const bindings = raw.map((binding, index) => normalizeAcceptanceBinding(binding, index));
  const ids = new Set<string>();
  for (const binding of bindings) {
    if (ids.has(binding.id)) throw new Error(`duplicate acceptance binding id: ${binding.id}`);
    ids.add(binding.id);
  }
  return bindings;
}

function corpusFor(story: StoryInfo, snapshot: OriginalIntentSnapshotData | null): string {
  return [
    story.title,
    story.description,
    story.type,
    story.priority,
    ...(story.keywords ?? []),
    ...(story.riskSignals ?? []).map((signal) => `${signal.category} ${signal.matched}`),
    snapshot?.sourceText ?? '',
    snapshot?.normalizedOutcome ?? '',
    snapshot?.acceptanceClaim ?? '',
  ].join('\n');
}

function countStructuralRows(text: string): number {
  return text
    .split('\n')
    .filter((line) => /^\s*(?:[-*]|\d+[.)]|M\d+\b|M\d+\s*[-:])\s+/.test(line))
    .length;
}

function hasBehaviorChangeSignal(input: ProofStoryDiagnosticInput, text: string): boolean {
  const explicitBehaviorChange = /\b(?:behavior change|behaviour change|behavior-changing|behaviour-changing)\b/i.test(text)
    || /\b(?:change(?:s|d|ing)?|alter(?:s|ed|ing)?)\b[^\n.]{0,80}\bbehaviou?r\b/i.test(text);
  return input.story.type === 'bug'
    || /\b(?:bug|defect|regression|broken|failing|failures?)\b/i.test(text)
    || explicitBehaviorChange;
}

function hasScopeAmbiguitySignal(text: string): boolean {
  const broadScope = /\b(?:all|every|remaining|fully|entire|end-to-end|e2e|scope)\b/i.test(text);
  const explicitScopeChange = /\b(?:remove|removal|retire|retirement|replace|replacement|shrink|shrinkage|drop)\b/i.test(text);
  const completeScopeClaim = /\bcomplete(?:ly)?\b(?=[\s\S]{0,80}\b(?:all|every|remaining|subsystem|removal|retirement|replacement|migration|end-to-end|e2e)\b)/i.test(text);
  return broadScope || explicitScopeChange || completeScopeClaim;
}

function pushTrigger(
  triggers: ProofStoryTriggerReason[],
  code: string,
  message: string,
  requires?: ProofStoryTriggerReason['requires'],
): void {
  if (triggers.some((trigger) => trigger.code === code)) return;
  triggers.push({ code, message, requires });
}

function classifyTriggers(input: ProofStoryDiagnosticInput): { hardeningLevel: ProofStoryHardeningLevel; triggerReasons: ProofStoryTriggerReason[] } {
  const text = corpusFor(input.story, input.originalIntentSnapshot);
  const triggers: ProofStoryTriggerReason[] = [];
  const hasLedgerMilestones = (input.milestoneLedger?.milestones.length ?? 0) > 0;
  const structuralRows = countStructuralRows(text);

  const hasExplicitCount = /\b(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:milestones?|deliverables?|items?|requirements?|commands?|steps?)\b/i.test(text);
  const hasAllMilestones = /\b(?:all|every|remaining)\s+(?:milestones?|deliverables?|items?|requirements?|commands?|steps?)\b/i.test(text);
  const hasRangeMilestone = /\bM\d+\s*[-–]\s*M\d+\b/i.test(text);
  const hasMultiDeliverable = structuralRows >= 2 || hasExplicitCount || hasAllMilestones || hasRangeMilestone;
  if (hasMultiDeliverable) {
    pushTrigger(
      triggers,
      'structural_milestone_intent',
      'Request has a structural multi-deliverable signal, so milestone coverage must be countable.',
      'milestone-ledger',
    );
  }
  if (hasLedgerMilestones) {
    pushTrigger(
      triggers,
      'milestones_provided',
      'A milestone ledger exists, so every ledger row needs checklist and verificationIntent coverage.',
      'milestone-ledger',
    );
  }

  const highRisk = input.story.priority === 'high'
    || input.story.priority === 'critical'
    || (input.story.riskSignals?.length ?? 0) > 0
    || /\b(?:auth|security|credential|token|password|payment|migration|lifecycle gate|proof gate|state machine|gate)\b/i.test(text);
  if (highRisk) {
    pushTrigger(triggers, 'high_assurance_risk', 'High-risk or gate/security wording selects high-assurance intent hardening.', 'high-assurance');
    pushTrigger(triggers, 'collision_required_high_assurance', 'High-assurance work requires an independent intent-collision result.', 'intent-collision');
  }

  const ambiguity = /\b(?:ambiguous|ambiguity|unclear|unknown|maybe|or\b|choose|decision|scope|multi-path|interpretation)\b/i.test(text);
  const userImpact = /\b(?:user|ui|browser|cli|command|observable|behavior|behaviour|workflow|product)\b/i.test(text);
  const behaviorChange = hasBehaviorChangeSignal(input, text);
  if (ambiguity || userImpact || behaviorChange || hasMultiDeliverable) {
    pushTrigger(
      triggers,
      'collision_required_standard',
      'Ambiguity, user impact, behavior change, or multi-deliverable intent makes intent collision diagnostically required.',
      'intent-collision',
    );
  }
  const redEvidenceRisk = behaviorChange
    || /\b(?:auth|authentication|authorization|session|security|credential|token|password|benchmark|performance claim)\b/i.test(text);
  if (redEvidenceRisk) {
    pushTrigger(triggers, 'red_evidence_required', 'Bug, regression, security/auth/session, benchmark, or explicit behavior-change work should have red evidence.', 'red-evidence');
  }

  const codePathUnclear = /\b(?:code path (?:is )?unclear|root cause (?:is )?unclear|unknown code path|spike|investigate|explore|prototype)\b/i.test(text);
  if (codePathUnclear) {
    pushTrigger(triggers, 'spike_evidence_required', 'Unclear code path or explicit investigation wording should have spike evidence.', 'spike-evidence');
  }

  const scopeAmbiguous = hasScopeAmbiguitySignal(text);
  if (scopeAmbiguous) {
    pushTrigger(triggers, 'scope_ambiguity', 'Broad or absolute scope wording should have scope clarification before future enforcement.', 'scope-clarification');
  }

  const hardeningLevel: ProofStoryHardeningLevel = highRisk
    ? 'high_assurance'
    : triggers.length > 0
      ? 'standard'
      : 'intent_mvp';
  return { hardeningLevel, triggerReasons: triggers };
}

function gap(
  code: string,
  artifact: string,
  message: string,
  triggeredBy?: string[],
  severity: ProofStoryDiagnosticGap['severity'] = 'warn',
): ProofStoryDiagnosticGap {
  return { code, severity, artifact, message, triggeredBy };
}

function checklistIdSet(items: readonly ChecklistItem[]): Set<string> {
  return new Set(items.map((item) => item.id));
}

function verificationIntentRefSet(items: readonly ChecklistItem[]): Set<string> {
  const refs = new Set<string>();
  for (const item of items) {
    for (const lane of VERIFICATION_LANES) {
      const entries = item.verificationIntent?.[lane] ?? [];
      entries.forEach((entry, index) => {
        refs.add(`${item.id}:${lane}:${index}`);
        if (entry.id) refs.add(entry.id);
      });
    }
  }
  return refs;
}

function verificationEvidenceByRef(items: readonly ChecklistItem[]): Map<string, VerificationEvidence[]> {
  const evidence = new Map<string, VerificationEvidence[]>();
  for (const item of items) {
    for (const row of item.verificationEvidence ?? []) {
      const rows = evidence.get(row.intentRef) ?? [];
      rows.push(row);
      evidence.set(row.intentRef, rows);
    }
  }
  return evidence;
}

function evidenceCoversIntent(evidence: Map<string, VerificationEvidence[]>, ref: string): boolean {
  return (evidence.get(ref) ?? []).some((row) =>
    row.result === 'pass'
    || row.kind === 'waiver'
    || row.verdict === 'success'
    || row.verdict === 'waived'
  );
}

export function collisionAccepted(collision: IntentCollisionData | null): boolean {
  if (!collision) return false;
  return collision.decision === 'pass'
    && collision.status === 'accepted'
    && typeof collision.acceptedInterpretation === 'string'
    && collision.acceptedInterpretation.trim().length > 0;
}

function triggerCodes(triggers: readonly ProofStoryTriggerReason[], requires: ProofStoryTriggerReason['requires']): string[] {
  return triggers.filter((trigger) => trigger.requires === requires).map((trigger) => trigger.code);
}

function redEvidenceSatisfied(redEvidence: RedEvidenceData | null): boolean {
  return (redEvidence?.records ?? []).some((record) => record.observedFailure.trim().length > 0);
}

function spikeEvidenceSatisfied(spikeEvidence: ProofStorySpikeData | null): boolean {
  const spikes = spikeEvidence?.spikes ?? [];
  return spikes.length > 0 && spikes.every((spike) => spike.status !== 'active');
}

function ledgerStateOf(ledger: MilestoneLedgerData | null): MilestoneLedgerState | 'missing' {
  return ledger?.state ?? (ledger ? 'candidate' : 'missing');
}

export function buildLedgerSizing(
  hardeningLevel: ProofStoryHardeningLevel,
  ledger: MilestoneLedgerData | null,
): ProofStoryLedgerSizing {
  const milestoneCount = ledger?.milestones.length ?? 0;
  const threshold = LEDGER_THRESHOLDS[hardeningLevel];
  const thresholdState: ProofStoryLedgerSizing['thresholdState'] = milestoneCount <= threshold
    ? 'within_threshold'
    : milestoneCount <= threshold * 2
      ? 'too_broad'
      : 'slice_required';
  const suggestedSlices: ProofStoryLedgerSizing['suggestedSlices'] = [];
  if (ledger && thresholdState !== 'within_threshold') {
    for (let index = 0; index < ledger.milestones.length; index += threshold) {
      const rows = ledger.milestones.slice(index, index + threshold);
      suggestedSlices.push({
        id: `slice-${suggestedSlices.length + 1}`,
        milestoneIds: rows.map((row) => row.id),
        reason: `Keep each slice at or below ${threshold} milestone(s) for ${hardeningLevel}.`,
      });
    }
  }
  return { milestoneCount, threshold, thresholdState, suggestedSlices };
}

function reportStatus(mode: ProofStoryGateMode, gaps: readonly ProofStoryDiagnosticGap[]): Pick<ProofStoryDiagnosticReport, 'status' | 'blocking'> {
  if (mode === 'enforce' && gaps.length > 0) return { status: 'fail', blocking: true };
  if (gaps.length > 0) return { status: 'warn', blocking: false };
  return { status: 'pass', blocking: false };
}

export function evaluateProofStoryDiagnostics(
  input: ProofStoryDiagnosticInput,
  modeValue?: ProofStoryGateMode,
): ProofStoryDiagnosticReport {
  const mode = normalizeGateMode(modeValue);
  const { hardeningLevel, triggerReasons } = classifyTriggers(input);
  const milestoneTriggers = triggerCodes(triggerReasons, 'milestone-ledger');
  const collisionTriggers = triggerCodes(triggerReasons, 'intent-collision');
  const redTriggers = triggerCodes(triggerReasons, 'red-evidence');
  const spikeTriggers = triggerCodes(triggerReasons, 'spike-evidence');
  const scopeTriggers = triggerCodes(triggerReasons, 'scope-clarification');
  const ledgerSizing = buildLedgerSizing(hardeningLevel, input.milestoneLedger);

  const missingMvpArtifacts: ProofStoryDiagnosticGap[] = [];
  if (!input.originalIntentSnapshot) {
    missingMvpArtifacts.push(gap(
      'missing_original_intent_snapshot',
      'original-intent-snapshot.json',
      'Intent MVP requires original_intent_snapshot_set with sourceText, normalizedOutcome, and acceptanceClaim.',
    ));
  }

  const checklistRefs = checklistIdSet(input.checklist.items);
  const intentRefs = verificationIntentRefSet(input.checklist.items);
  const missingMilestoneCoverage: ProofStoryDiagnosticGap[] = [];
  if (milestoneTriggers.length > 0 && !input.milestoneLedger) {
    missingMilestoneCoverage.push(gap(
      'missing_milestone_ledger',
      'milestone-ledger.json',
      'Milestone triggers exist but no milestone ledger is configured.',
      milestoneTriggers,
    ));
  }
  if (input.milestoneLedger) {
    const keyRequirementIds = new Set(input.originalIntentSnapshot?.keyRequirementIds ?? []);
    for (const milestone of input.milestoneLedger.milestones) {
      if (input.originalIntentSnapshot && !keyRequirementIds.has(milestone.sourceRequirementId)) {
        missingMilestoneCoverage.push(gap(
          'milestone_source_requirement_unbound',
          'milestone-ledger.json',
          `${milestone.id} references sourceRequirementId ${milestone.sourceRequirementId}, which is not in original intent keyRequirementIds.`,
          ['milestones_provided'],
        ));
      }
      if (milestone.checklistRefs.length === 0) {
        missingMilestoneCoverage.push(gap(
          'milestone_missing_checklist_refs',
          'milestone-ledger.json',
          `${milestone.id} has no checklistRefs.`,
          ['milestones_provided'],
        ));
      }
      for (const ref of milestone.checklistRefs) {
        if (!checklistRefs.has(ref)) {
          missingMilestoneCoverage.push(gap(
            'milestone_unknown_checklist_ref',
            'milestone-ledger.json',
            `${milestone.id} references unknown checklist item ${ref}.`,
            ['milestones_provided'],
          ));
        }
      }
      if (milestone.verificationIntentRefs.length === 0) {
        missingMilestoneCoverage.push(gap(
          'milestone_missing_verification_intent_refs',
          'milestone-ledger.json',
          `${milestone.id} has no verificationIntentRefs.`,
          ['milestones_provided'],
        ));
      }
      for (const ref of milestone.verificationIntentRefs) {
        if (!intentRefs.has(ref)) {
          missingMilestoneCoverage.push(gap(
            'milestone_unknown_verification_intent_ref',
            'milestone-ledger.json',
            `${milestone.id} references unknown verificationIntent ${ref}.`,
            ['milestones_provided'],
          ));
        }
      }
    }
  }

  const missingConfirmedLedger = milestoneTriggers.length > 0
    && collisionAccepted(input.intentCollision)
    && input.milestoneLedger
    && ledgerStateOf(input.milestoneLedger) !== 'confirmed'
    ? [gap(
      'missing_confirmed_milestone_ledger',
      'milestone-ledger.json',
      'A candidate milestone ledger exists, but accepted intent interpretation has not confirmed it for gate consumption.',
      milestoneTriggers,
    )]
    : [];

  const missingAcceptanceBindings: ProofStoryDiagnosticGap[] = [];
  const bindings = input.proofStoryContract?.acceptanceBindings ?? [];
  if (input.originalIntentSnapshot && bindings.length === 0) {
    missingAcceptanceBindings.push(gap(
      'missing_acceptance_binding',
      'proofstory.json',
      'No ProofStory acceptance binding maps the snapshot acceptanceClaim to checklist/verificationIntent refs.',
    ));
  }
  for (const binding of bindings) {
    if (binding.verificationIntentRefs.length === 0) {
      missingAcceptanceBindings.push(gap(
        'acceptance_binding_missing_verification_intent_refs',
        'proofstory.json',
        `${binding.id} has no verificationIntentRefs.`,
      ));
    }
    for (const ref of binding.verificationIntentRefs) {
      if (!intentRefs.has(ref)) {
        missingAcceptanceBindings.push(gap(
          'acceptance_binding_unknown_verification_intent_ref',
          'proofstory.json',
          `${binding.id} references unknown verificationIntent ${ref}.`,
        ));
      }
    }
    for (const ref of binding.checklistRefs) {
      if (!checklistRefs.has(ref)) {
        missingAcceptanceBindings.push(gap(
          'acceptance_binding_unknown_checklist_ref',
          'proofstory.json',
          `${binding.id} references unknown checklist item ${ref}.`,
        ));
      }
    }
    for (const milestoneId of binding.milestoneIds) {
      if (input.milestoneLedger && !input.milestoneLedger.milestones.some((row) => row.id === milestoneId)) {
        missingAcceptanceBindings.push(gap(
          'acceptance_binding_unknown_milestone',
          'proofstory.json',
          `${binding.id} references unknown milestone ${milestoneId}.`,
        ));
      }
    }
  }

  const missingIntentCollision = collisionTriggers.length > 0 && !collisionAccepted(input.intentCollision)
    ? [gap(
      'missing_intent_collision',
      'intent-collision.json',
      'Intent collision is triggered but no pass decision with acceptedInterpretation is present.',
      collisionTriggers,
    )]
    : [];
  const missingRedEvidence = redTriggers.length > 0 && !redEvidenceSatisfied(input.redEvidence)
    ? [gap(
      'missing_red_evidence',
      'red-evidence.json',
      'Red evidence is triggered but no red evidence artifact records the pre-fix failure.',
      redTriggers,
    )]
    : [];
  const missingSpikeEvidence = spikeTriggers.length > 0 && !spikeEvidenceSatisfied(input.spikeEvidence)
    ? [gap(
      input.spikeEvidence ? 'unresolved_spike_evidence' : 'missing_spike_evidence',
      'spike.json',
      input.spikeEvidence
        ? 'Spike evidence is triggered but at least one spike remains active.'
        : 'Spike evidence is triggered but no spike artifact is present.',
      spikeTriggers,
    )]
    : [];
  const scopeAmbiguity = scopeTriggers.length > 0 && !input.scopeContract && !input.scopeShrinkageDecision
    ? [gap(
      'scope_ambiguity',
      'scope-contract.json',
      'Scope ambiguity is triggered but no scope contract or explicit shrinkage decision is configured.',
      scopeTriggers,
    )]
    : [];
  const oversizedLedger = ledgerSizing.thresholdState === 'within_threshold'
    ? []
    : [gap(
      ledgerSizing.thresholdState,
      'milestone-ledger.json',
      `Milestone ledger has ${ledgerSizing.milestoneCount} row(s), above the ${ledgerSizing.threshold} row threshold for ${hardeningLevel}. Suggested slicing groups are diagnostic only; no child stories are created automatically.`,
      ['milestones_provided'],
      ledgerSizing.thresholdState === 'slice_required' ? 'fail' : 'warn',
    )];

  const gaps = [
    ...missingMvpArtifacts,
    ...missingMilestoneCoverage,
    ...missingConfirmedLedger,
    ...missingAcceptanceBindings,
    ...missingIntentCollision,
    ...missingRedEvidence,
    ...missingSpikeEvidence,
    ...scopeAmbiguity,
    ...oversizedLedger,
  ];
  const status = reportStatus(mode, gaps);

  return {
    schemaVersion: PROOFSTORY_DIAGNOSTIC_REPORT_SCHEMA_VERSION,
    storyId: input.story.storyId,
    dryRun: true,
    mode,
    ...status,
    hardeningLevel,
    triggerReasons,
    ledgerState: ledgerStateOf(input.milestoneLedger),
    ledgerSizing,
    missingMvpArtifacts,
    missingMilestoneCoverage,
    missingConfirmedLedger,
    missingAcceptanceBindings,
    missingIntentCollision,
    missingRedEvidence,
    missingSpikeEvidence,
    scopeAmbiguity,
    oversizedLedger,
    gaps,
    wouldBlockFutureDevAdmission: gaps.length > 0,
  };
}

export function buildProofStoryContract(
  args: BuildProofStoryContractArgs,
  input: Omit<ProofStoryDiagnosticInput, 'proofStoryContract'>,
  existing?: ProofStoryContractData | null,
): ProofStoryContractData {
  const acceptanceBindings = normalizeAcceptanceBindings(args.acceptanceBindings);
  const diagnosticInput: ProofStoryDiagnosticInput = {
    ...input,
    proofStoryContract: { acceptanceBindings },
  };
  const report = evaluateProofStoryDiagnostics(diagnosticInput);
  const now = new Date().toISOString();
  return {
    schemaVersion: PROOFSTORY_CONTRACT_SCHEMA_VERSION,
    storyId: args.storyId,
    diagnosticOnly: false,
    hardeningLevel: report.hardeningLevel,
    triggerReasons: report.triggerReasons,
    originalIntentRequestHash: input.originalIntentSnapshot?.requestHash,
    confirmedMilestoneLedgerHash: input.milestoneLedger?.state === 'confirmed' ? input.milestoneLedger.ledgerHash : undefined,
    acceptanceBindings,
    diagnosticGaps: report.gaps,
    note: args.note?.trim() || existing?.note,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function buildIntentCollision(
  args: BuildIntentCollisionArgs,
  existing: IntentCollisionData | null,
  ledger: MilestoneLedgerData | null,
): IntentCollisionData {
  if (!VALID_COLLISION_DECISIONS.has(args.decision)) {
    throw new Error('decision must be one of: pass, revise_intent, human_gate, stop');
  }
  const acceptedInterpretation = optionalNonEmptyString(args.acceptedInterpretation, 'acceptedInterpretation');
  if (args.decision === 'pass' && !acceptedInterpretation) {
    throw new Error('acceptedInterpretation is required when decision is pass');
  }
  const now = new Date().toISOString();
  const acceptedInterpretationHash = acceptedInterpretation ? sha256Stable({ acceptedInterpretation }) : undefined;
  return {
    schemaVersion: INTENT_COLLISION_SCHEMA_VERSION,
    storyId: args.storyId,
    id: args.id?.trim() || existing?.id || defaultId('IC'),
    decision: args.decision,
    status: args.decision === 'pass' ? 'accepted' : args.decision === 'stop' ? 'stopped' : 'open',
    acceptedInterpretation,
    acceptedInterpretationHash,
    notes: args.notes?.trim() || existing?.notes,
    ledgerHashBeforeDecision: ledger?.ledgerHash ?? (ledger ? computeMilestoneLedgerHash(ledger.milestones) : undefined),
    confirmedLedgerHash: args.decision === 'pass'
      ? ledger?.ledgerHash ?? (ledger ? computeMilestoneLedgerHash(ledger.milestones) : undefined)
      : undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function buildScopeShrinkageDecision(
  args: BuildScopeShrinkageDecisionArgs,
  existing?: ScopeShrinkageDecisionData | null,
): ScopeShrinkageDecisionData {
  const decision = args.decision;
  if (decision !== 'confirmed' && decision !== 'rejected') throw new Error('decision must be confirmed or rejected');
  const removedMilestoneIds = optionalStringArray(args.removedMilestoneIds, 'removedMilestoneIds');
  if (decision === 'confirmed' && removedMilestoneIds.length === 0) {
    throw new Error('removedMilestoneIds is required when decision is confirmed');
  }
  const now = new Date().toISOString();
  return {
    schemaVersion: SCOPE_SHRINKAGE_DECISION_SCHEMA_VERSION,
    storyId: args.storyId,
    decision,
    removedMilestoneIds,
    reason: requireNonEmptyString(args.reason, 'reason'),
    approvedBy: requireNonEmptyString(args.approvedBy, 'approvedBy'),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function appendRedEvidence(
  args: AppendRedEvidenceArgs,
  existing?: RedEvidenceData | null,
): RedEvidenceData {
  const now = new Date().toISOString();
  const record: RedEvidenceRecord = {
    id: args.id?.trim() || defaultId('RED'),
    trigger: requireNonEmptyString(args.trigger, 'trigger'),
    observedFailure: requireNonEmptyString(args.observedFailure, 'observedFailure'),
    failingCommand: optionalNonEmptyString(args.failingCommand, 'failingCommand'),
    expectedGreenCommand: optionalNonEmptyString(args.expectedGreenCommand, 'expectedGreenCommand'),
    note: optionalNonEmptyString(args.note, 'note'),
    createdAt: now,
  };
  return {
    schemaVersion: RED_EVIDENCE_SCHEMA_VERSION,
    storyId: args.storyId,
    records: [...(existing?.records ?? []), record],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function updateSpike(
  storyId: string,
  existing: ProofStorySpikeData | null,
  id: string,
  update: (record: ProofStorySpikeRecord) => ProofStorySpikeRecord,
): ProofStorySpikeData {
  const current = existing?.spikes ?? [];
  const index = current.findIndex((spike) => spike.id === id);
  if (index < 0) throw new Error(`spike not found: ${id}`);
  const spikes = [...current];
  spikes[index] = update(spikes[index]);
  const now = new Date().toISOString();
  return {
    schemaVersion: SPIKE_SCHEMA_VERSION,
    storyId,
    spikes,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function startSpike(args: BuildSpikeArgs, existing?: ProofStorySpikeData | null): ProofStorySpikeData {
  const now = new Date().toISOString();
  const id = args.id?.trim() || defaultId('SPIKE');
  if (existing?.spikes.some((spike) => spike.id === id)) throw new Error(`duplicate spike id: ${id}`);
  const record: ProofStorySpikeRecord = {
    id,
    question: requireNonEmptyString(args.question, 'question'),
    status: 'active',
    note: optionalNonEmptyString(args.note, 'note'),
    createdAt: now,
    updatedAt: now,
  };
  return {
    schemaVersion: SPIKE_SCHEMA_VERSION,
    storyId: args.storyId,
    spikes: [...(existing?.spikes ?? []), record],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function setSpikeResult(args: BuildSpikeArgs, existing: ProofStorySpikeData | null): ProofStorySpikeData {
  const id = requireNonEmptyString(args.id, 'id');
  const result = requireNonEmptyString(args.result, 'result');
  const now = new Date().toISOString();
  return updateSpike(args.storyId, existing, id, (record) => ({
    ...record,
    status: 'resolved',
    result,
    note: optionalNonEmptyString(args.note, 'note') ?? record.note,
    updatedAt: now,
  }));
}

export function setSpikeStatus(
  args: BuildSpikeArgs,
  existing: ProofStorySpikeData | null,
  status: Extract<ProofStorySpikeStatus, 'discarded' | 'promoted'>,
): ProofStorySpikeData {
  if (!VALID_SPIKE_STATUSES.has(status)) throw new Error('invalid spike status');
  const id = requireNonEmptyString(args.id, 'id');
  const now = new Date().toISOString();
  return updateSpike(args.storyId, existing, id, (record) => ({
    ...record,
    status,
    promotedAs: status === 'promoted' ? args.promotedAs ?? 'implementation_note' : record.promotedAs,
    note: optionalNonEmptyString(args.note, 'note') ?? record.note,
    updatedAt: now,
  }));
}

function confirmedShrinkageIds(decision: ScopeShrinkageDecisionData | null): Set<string> {
  return new Set(decision?.decision === 'confirmed' ? decision.removedMilestoneIds : []);
}

export function evaluateDoneIntentEquivalence(
  input: ProofStoryDiagnosticInput,
  modeValue?: ProofStoryGateMode,
): DoneIntentEquivalenceReport {
  const mode = normalizeGateMode(modeValue);
  const gaps: ProofStoryDiagnosticGap[] = [];
  const acceptedShrinkageMilestoneIds = [...confirmedShrinkageIds(input.scopeShrinkageDecision)];
  const acceptedShrinkage = new Set(acceptedShrinkageMilestoneIds);
  const ledger = input.milestoneLedger;
  if (!ledger || ledgerStateOf(ledger) !== 'confirmed') {
    gaps.push(gap(
      'missing_confirmed_milestone_ledger',
      'milestone-ledger.json',
      'DONE intent equivalence requires a confirmed milestone ledger.',
      undefined,
      'fail',
    ));
  }
  const evidence = verificationEvidenceByRef(input.checklist.items);
  const uncoveredRequiredMilestoneIds: string[] = [];
  for (const milestone of ledger?.milestones ?? []) {
    if (milestone.status === 'not_applicable') continue;
    if (acceptedShrinkage.has(milestone.id)) continue;
    const refs = milestone.verificationIntentRefs;
    if (refs.length === 0 || !refs.every((ref) => evidenceCoversIntent(evidence, ref))) {
      uncoveredRequiredMilestoneIds.push(milestone.id);
    }
  }
  if (uncoveredRequiredMilestoneIds.length > 0) {
    gaps.push(gap(
      'uncovered_required_milestones',
      'milestone-ledger.json',
      `Required milestone(s) lack passing verification evidence and no confirmed shrinkage decision removes them: ${uncoveredRequiredMilestoneIds.join(', ')}.`,
      undefined,
      'fail',
    ));
  }
  const blocking = mode === 'enforce' && gaps.length > 0;
  return {
    schemaVersion: DONE_INTENT_EQUIVALENCE_SCHEMA_VERSION,
    storyId: input.story.storyId,
    mode,
    status: blocking ? 'fail' : gaps.length > 0 ? 'warn' : 'pass',
    blocking,
    checkedAt: new Date().toISOString(),
    confirmedLedgerHash: ledger?.state === 'confirmed' ? ledger.ledgerHash : undefined,
    acceptedShrinkageMilestoneIds,
    uncoveredRequiredMilestoneIds,
    gaps,
  };
}

export function evaluateReviewCompleteness(
  input: ProofStoryDiagnosticInput,
  modeValue?: ProofStoryGateMode,
): ProofStoryReviewCompletenessReport {
  const mode = normalizeGateMode(modeValue);
  const diagnostics = evaluateProofStoryDiagnostics(input, mode);
  const evidence = verificationEvidenceByRef(input.checklist.items);
  const gaps: ProofStoryDiagnosticGap[] = [
    ...diagnostics.missingConfirmedLedger,
    ...diagnostics.missingAcceptanceBindings,
    ...diagnostics.missingMilestoneCoverage,
  ];
  const refs = new Set<string>();
  for (const binding of input.proofStoryContract?.acceptanceBindings ?? []) {
    binding.verificationIntentRefs.forEach((ref) => refs.add(ref));
  }
  const shrinkageIds = confirmedShrinkageIds(input.scopeShrinkageDecision);
  for (const milestone of input.milestoneLedger?.milestones ?? []) {
    if (shrinkageIds.has(milestone.id)) continue;
    milestone.verificationIntentRefs.forEach((ref) => refs.add(ref));
  }
  for (const ref of refs) {
    if (!evidenceCoversIntent(evidence, ref)) {
      gaps.push(gap(
        'review_completeness_missing_evidence',
        'checklist.json',
        `Verification intent ${ref} is bound to ProofStory acceptance or milestone coverage but lacks passing verification evidence.`,
      ));
    }
  }
  const blocking = mode === 'enforce' && gaps.length > 0;
  return {
    schemaVersion: REVIEW_COMPLETENESS_SCHEMA_VERSION,
    storyId: input.story.storyId,
    mode,
    status: blocking ? 'fail' : gaps.length > 0 ? 'warn' : 'pass',
    blocking,
    checkedAt: new Date().toISOString(),
    gaps,
  };
}

export function renderProofStoryDiagnosticReport(report: ProofStoryDiagnosticReport): string {
  const lines = [
    `ProofStory diagnostics for ${report.storyId}`,
    `Mode: ${report.mode}`,
    `Status: ${report.status}`,
    `Blocking: ${report.blocking ? 'yes' : 'no'}`,
    `Hardening level: ${report.hardeningLevel}`,
    `Ledger: ${report.ledgerState}, ${report.ledgerSizing.milestoneCount}/${report.ledgerSizing.threshold} milestone threshold (${report.ledgerSizing.thresholdState})`,
    ...(report.ledgerSizing.suggestedSlices.length === 0
      ? []
      : [
        'Suggested slices:',
        ...report.ledgerSizing.suggestedSlices.map((slice) => `  - ${slice.id}: ${slice.milestoneIds.join(', ')}`),
      ]),
    `Trigger reasons (${report.triggerReasons.length}):`,
    ...(report.triggerReasons.length === 0
      ? ['  none']
      : report.triggerReasons.map((trigger) => `  - ${trigger.code}: ${trigger.message}`)),
    `Diagnostic gaps (${report.gaps.length}):`,
    ...(report.gaps.length === 0
      ? ['  none']
      : report.gaps.map((item) => `  - ${item.code} [${item.severity}; ${item.artifact}]: ${item.message}`)),
  ];
  return lines.join('\n');
}
