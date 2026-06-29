/**
 * ProofStory progressive intent hardening (M0-M2 MVP).
 *
 * This module is intentionally pure: it classifies intent-hardening triggers and
 * builds diagnostic reports. Lifecycle gates do not import or consume it.
 */

import { createHash } from 'node:crypto';
import type {
  ChecklistData,
  ChecklistItem,
  IntentCollisionData,
  MilestoneLedgerData,
  MilestoneLedgerItem,
  MilestoneStatus,
  OriginalIntentSnapshotData,
  ProofStoryAcceptanceBinding,
  ProofStoryContractData,
  ProofStoryDiagnosticGap,
  ProofStoryDiagnosticReport,
  ProofStoryHardeningLevel,
  ProofStoryTriggerReason,
  ScopeContractData,
  StoryInfo,
  VerificationLane,
} from './types.js';

export const ORIGINAL_INTENT_SNAPSHOT_SCHEMA_VERSION = 'proofstory.original_intent_snapshot.v1';
export const MILESTONE_LEDGER_SCHEMA_VERSION = 'proofstory.milestone_ledger.v1';
export const PROOFSTORY_CONTRACT_SCHEMA_VERSION = 'proofstory.contract.v1';
export const PROOFSTORY_DIAGNOSTIC_REPORT_SCHEMA_VERSION = 'proofstory.diagnostic_report.v1';

const DEFAULT_KEY_REQUIREMENT_IDS = ['REQ-001'];
const VALID_MILESTONE_STATUSES = new Set<MilestoneStatus>(['planned', 'covered', 'done', 'not_applicable']);
const VERIFICATION_LANES: readonly VerificationLane[] = ['happy', 'edge', 'adversarial'];

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
}

export interface ProofStoryDiagnosticInput {
  story: StoryInfo;
  checklist: ChecklistData;
  originalIntentSnapshot: OriginalIntentSnapshotData | null;
  milestoneLedger: MilestoneLedgerData | null;
  proofStoryContract: Pick<ProofStoryContractData, 'acceptanceBindings'> | null;
  intentCollision: IntentCollisionData | null;
  scopeContract: ScopeContractData | null;
  redEvidencePresent: boolean;
  spikeEvidencePresent: boolean;
}

export interface BuildProofStoryContractArgs {
  storyId: string;
  acceptanceBindings?: unknown[];
  note?: string;
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

export function buildMilestoneLedger(args: BuildMilestoneLedgerArgs): MilestoneLedgerData {
  const milestones = args.milestones.map((raw, index) => normalizeMilestone(raw, index));
  const ids = new Set<string>();
  for (const milestone of milestones) {
    if (ids.has(milestone.id)) throw new Error(`duplicate milestone id: ${milestone.id}`);
    ids.add(milestone.id);
  }
  const now = new Date().toISOString();
  return {
    schemaVersion: MILESTONE_LEDGER_SCHEMA_VERSION,
    storyId: args.storyId,
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
    existing,
    milestones: [...(existing?.milestones ?? []), milestone],
  });
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
  const lower = text.toLowerCase();
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
  const behaviorChange = input.story.type === 'bug'
    || input.story.type === 'feature'
    || /\b(?:bug|fix|regression|broken|failing|behavior change|behaviour change|change behavior|change behaviour)\b/i.test(text);
  if (ambiguity || userImpact || behaviorChange || hasMultiDeliverable) {
    pushTrigger(
      triggers,
      'collision_required_standard',
      'Ambiguity, user impact, behavior change, or multi-deliverable intent makes intent collision diagnostically required.',
      'intent-collision',
    );
  }
  if (behaviorChange) {
    pushTrigger(triggers, 'red_evidence_required', 'Bug, regression, feature, or behavior-change work should have red evidence.', 'red-evidence');
  }

  const codePathUnclear = /\b(?:code path (?:is )?unclear|root cause (?:is )?unclear|unknown code path|spike|investigate|explore|prototype)\b/i.test(text);
  if (codePathUnclear) {
    pushTrigger(triggers, 'spike_evidence_required', 'Unclear code path or explicit investigation wording should have spike evidence.', 'spike-evidence');
  }

  const scopeAmbiguous = /\b(?:all|complete|completely|fully|entire|end-to-end|e2e|remove|retire|replace|scope)\b/i.test(text);
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

function collisionAccepted(collision: IntentCollisionData | null): boolean {
  if (!collision) return false;
  const status = String(collision.status ?? collision.decision ?? collision.resolution ?? '').toLowerCase();
  return ['pass', 'passed', 'accepted', 'accept', 'resolved'].includes(status);
}

function triggerCodes(triggers: readonly ProofStoryTriggerReason[], requires: ProofStoryTriggerReason['requires']): string[] {
  return triggers.filter((trigger) => trigger.requires === requires).map((trigger) => trigger.code);
}

export function evaluateProofStoryDiagnostics(input: ProofStoryDiagnosticInput): ProofStoryDiagnosticReport {
  const { hardeningLevel, triggerReasons } = classifyTriggers(input);
  const milestoneTriggers = triggerCodes(triggerReasons, 'milestone-ledger');
  const collisionTriggers = triggerCodes(triggerReasons, 'intent-collision');
  const redTriggers = triggerCodes(triggerReasons, 'red-evidence');
  const spikeTriggers = triggerCodes(triggerReasons, 'spike-evidence');
  const scopeTriggers = triggerCodes(triggerReasons, 'scope-clarification');

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
  }

  const missingIntentCollision = collisionTriggers.length > 0 && !collisionAccepted(input.intentCollision)
    ? [gap(
      'missing_intent_collision',
      'intent-collision.json',
      'Intent collision is triggered but no accepted collision result is present. M0-M2 only reports this diagnostic gap.',
      collisionTriggers,
    )]
    : [];
  const missingRedEvidence = redTriggers.length > 0 && !input.redEvidencePresent
    ? [gap(
      'missing_red_evidence',
      'red-evidence.json',
      'Red evidence is triggered but no red evidence artifact is present. M0-M2 only reports this diagnostic gap.',
      redTriggers,
    )]
    : [];
  const missingSpikeEvidence = spikeTriggers.length > 0 && !input.spikeEvidencePresent
    ? [gap(
      'missing_spike_evidence',
      'spike.json',
      'Spike evidence is triggered but no spike artifact is present. M0-M2 only reports this diagnostic gap.',
      spikeTriggers,
    )]
    : [];
  const scopeAmbiguity = scopeTriggers.length > 0 && !input.scopeContract
    ? [gap(
      'scope_ambiguity',
      'scope-contract.json',
      'Scope ambiguity is triggered but no scope contract is configured. This is diagnostic only for ProofStory M0-M2.',
      scopeTriggers,
    )]
    : [];

  const gaps = [
    ...missingMvpArtifacts,
    ...missingMilestoneCoverage,
    ...missingAcceptanceBindings,
    ...missingIntentCollision,
    ...missingRedEvidence,
    ...missingSpikeEvidence,
    ...scopeAmbiguity,
  ];

  return {
    schemaVersion: PROOFSTORY_DIAGNOSTIC_REPORT_SCHEMA_VERSION,
    storyId: input.story.storyId,
    dryRun: true,
    hardeningLevel,
    triggerReasons,
    missingMvpArtifacts,
    missingMilestoneCoverage,
    missingAcceptanceBindings,
    missingIntentCollision,
    missingRedEvidence,
    missingSpikeEvidence,
    scopeAmbiguity,
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
    diagnosticOnly: true,
    hardeningLevel: report.hardeningLevel,
    triggerReasons: report.triggerReasons,
    originalIntentRequestHash: input.originalIntentSnapshot?.requestHash,
    acceptanceBindings,
    diagnosticGaps: report.gaps,
    note: args.note?.trim() || existing?.note,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function renderProofStoryDiagnosticReport(report: ProofStoryDiagnosticReport): string {
  const lines = [
    `ProofStory dry-run diagnostics for ${report.storyId}`,
    `Hardening level: ${report.hardeningLevel}`,
    `Would block future DEV admission: ${report.wouldBlockFutureDevAdmission ? 'yes' : 'no'}`,
    `Trigger reasons (${report.triggerReasons.length}):`,
    ...(report.triggerReasons.length === 0
      ? ['  none']
      : report.triggerReasons.map((trigger) => `  - ${trigger.code}: ${trigger.message}`)),
    `Diagnostic gaps (${report.gaps.length}):`,
    ...(report.gaps.length === 0
      ? ['  none']
      : report.gaps.map((item) => `  - ${item.code} [${item.artifact}]: ${item.message}`)),
  ];
  return lines.join('\n');
}
