import type {
  ChecklistData,
  ChecklistItem,
  MilestoneLedgerData,
  MilestoneLedgerItem,
  MilestoneLedgerState,
  MilestoneStatus,
  StoryInfo,
  StoryPhase,
  StorySummaryData,
  VerificationEvidence,
  VerificationIntentItem,
  VerificationLane,
} from './types.js';
import { createHash } from 'crypto';
import {
  currentGitHead,
  currentMaterialHash,
  currentStoryFilesHash,
  EMPTY_STORY_FILES_HASH,
} from './evidence-freshness.js';
import { collectVerificationIntents } from './verification.js';

export const MILESTONE_STATUS_SCHEMA_VERSION = 'proofbound.milestone_status.v1';
export const MILESTONE_CLOSEOUT_SCHEMA_VERSION = 'proofbound.milestone_closeout.v1';
export const MILESTONE_CLOSEOUT_MISSING_SCHEMA_VERSION = 'proofbound.milestone_closeout_missing.v1';
export const MILESTONE_CLOSEOUT_FILENAME = 'milestone-closeout.json';

export type MilestoneProgressStatus = 'completed' | 'current' | 'remaining';

export interface MilestoneStatusMode {
  readOnly: true;
  runCommands: false;
  writeEvidence: false;
  advancePhase: false;
  launchReviewers: false;
}

export interface MilestoneStatusCurrentEvidenceBinding {
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
}

export interface MilestoneStatusLedgerSummary {
  present: boolean;
  state: MilestoneLedgerState | null;
  hash: string | null;
}

export interface MilestoneStatusSubObjective {
  id: string;
  kind: 'checklist' | 'verificationIntent' | 'requiredEvidence';
  label: string;
  status: string;
  risks: string[];
}

export interface MilestoneStatusEvidenceRef {
  intentRef: string;
  kind: VerificationEvidence['kind'];
  status: 'pass' | 'fail' | 'missing-result' | 'waived';
  note: string;
  command?: string;
  file?: string;
  timestamp?: string;
}

export interface MilestoneStatusRow {
  id: string;
  claim: string;
  doneMeans: string;
  ledgerStatus: MilestoneStatus;
  status: MilestoneProgressStatus;
  statusDetail: string;
  sourceRequirementId: string;
  parentLedgerId?: string;
  assignedStory?: string;
  checklistRefs: string[];
  verificationIntentRefs: string[];
  requiredEvidence: string[];
  subObjectives: MilestoneStatusSubObjective[];
  evidenceRefs: MilestoneStatusEvidenceRef[];
  risks: string[];
  nextAction: string;
}

export interface MilestoneStatusReport {
  schemaVersion: typeof MILESTONE_STATUS_SCHEMA_VERSION;
  storyId: string;
  phase: StoryPhase;
  ledger: MilestoneStatusLedgerSummary;
  mode: MilestoneStatusMode;
  milestones: MilestoneStatusRow[];
  groups: {
    completed: string[];
    current: string[];
    remaining: string[];
  };
  risks: string[];
  nextActions: string[];
  summary?: {
    acceptanceVerdict?: StorySummaryData['acceptanceVerdict'];
    outcomeKind?: StorySummaryData['outcomeKind'];
    expectedOutcome?: string;
  };
}

export interface MilestoneCloseoutSnapshotRow {
  milestone: string;
  status: string;
  solvedProblem: string;
  acceptance: string;
  evidence: string[];
  risks: string[];
  nextAction: string;
}

export interface MilestoneCloseoutSnapshot {
  schemaVersion: typeof MILESTONE_CLOSEOUT_SCHEMA_VERSION;
  storyId: string;
  phase: StoryPhase;
  generatedAt: string;
  sourceReport: {
    schemaVersion: typeof MILESTONE_STATUS_SCHEMA_VERSION;
    digest: string;
    ledger: MilestoneStatusLedgerSummary;
    groups: MilestoneStatusReport['groups'];
    risks?: string[];
    nextActions?: string[];
  };
  bindings: MilestoneStatusCurrentEvidenceBinding;
  rows: MilestoneCloseoutSnapshotRow[];
}

export interface MilestoneCloseoutMissingReport {
  schemaVersion: typeof MILESTONE_CLOSEOUT_MISSING_SCHEMA_VERSION;
  storyId: string;
  snapshotPresent: false;
  expectedPath?: string;
  diagnostic: string;
  nextAction: string;
}

export interface BuildMilestoneStatusReportInput {
  story: StoryInfo;
  checklist: ChecklistData;
  milestoneLedger: MilestoneLedgerData | null;
  summary?: StorySummaryData | null;
  currentEvidenceBinding?: MilestoneStatusCurrentEvidenceBinding | null;
}

export interface BuildMilestoneCloseoutSnapshotInput {
  report: MilestoneStatusReport;
  bindings?: MilestoneStatusCurrentEvidenceBinding | null;
  generatedAt?: string;
}

interface IntentIndexEntry {
  itemId: string;
  lane: VerificationLane;
  index: number;
  intent: VerificationIntentItem;
}

type IntentIndex = Map<string, IntentIndexEntry[]>;
type EvidenceIndex = Map<string, VerificationEvidence[]>;

const MIN_HEAD_HASH_PREFIX_LENGTH = 7;
const VERIFICATION_EVIDENCE_KINDS = new Set<string>([
  'logic_test',
  'integration_test',
  'browser_test',
  'manual_transcript',
  'docs_check',
  'waiver',
]);

const READ_ONLY_MODE: MilestoneStatusMode = {
  readOnly: true,
  runCommands: false,
  writeEvidence: false,
  advancePhase: false,
  launchReviewers: false,
};

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function stringArrayField(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function evidenceStatus(evidence: VerificationEvidence): MilestoneStatusEvidenceRef['status'] {
  if (evidence.result === 'fail') return 'fail';
  if (evidence.kind === 'waiver') return 'waived';
  if (evidence.result === 'pass') return 'pass';
  return 'missing-result';
}

function evidenceCanCover(evidence: VerificationEvidence): boolean {
  if (evidence.kind === 'waiver') {
    return evidence.waiverType === 'permanent' && evidence.result !== 'fail';
  }
  return evidence.result === 'pass';
}

function isKnownEvidenceKind(value: string): boolean {
  return VERIFICATION_EVIDENCE_KINDS.has(value);
}

function normalizedBindingValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function shortHash(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

export function currentMilestoneStatusEvidenceBinding(
  gitCwd: string,
  metadataRoot: string = gitCwd,
): MilestoneStatusCurrentEvidenceBinding | undefined {
  const headHash = currentGitHead(gitCwd);
  const materialHash = currentMaterialHash(gitCwd, 'HEAD', metadataRoot);
  const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', metadataRoot);
  const binding: MilestoneStatusCurrentEvidenceBinding = {
    ...(headHash ? { headHash } : {}),
    ...(materialHash ? { materialHash } : {}),
    ...(storyFilesHash ? { storyFilesHash } : {}),
  };
  return Object.keys(binding).length > 0 ? binding : undefined;
}

function headHashMatches(evidenceValue: string, currentValue: string): boolean {
  if (evidenceValue === currentValue) return true;
  const shorterLength = Math.min(evidenceValue.length, currentValue.length);
  return shorterLength >= MIN_HEAD_HASH_PREFIX_LENGTH
    && (evidenceValue.startsWith(currentValue) || currentValue.startsWith(evidenceValue));
}

function headHashFreshnessRisks(evidenceHeadHash: string | undefined, currentHeadHash: string): string[] {
  if (!evidenceHeadHash) {
    return [`missing headHash binding (current ${shortHash(currentHeadHash)})`];
  }
  if (!headHashMatches(evidenceHeadHash, currentHeadHash)) {
    return [`stale headHash ${shortHash(evidenceHeadHash)} (current ${shortHash(currentHeadHash)})`];
  }
  return [];
}

function evidenceFreshnessRisks(
  evidence: VerificationEvidence,
  currentBinding: MilestoneStatusCurrentEvidenceBinding | null | undefined,
): string[] {
  const risks: string[] = [];
  const headHash = normalizedBindingValue(currentBinding?.headHash);
  const materialHash = normalizedBindingValue(currentBinding?.materialHash);
  const storyFilesHash = normalizedBindingValue(currentBinding?.storyFilesHash);
  const evidenceHeadHash = normalizedBindingValue(evidence.headHash);
  const evidenceMaterialHash = normalizedBindingValue(evidence.materialHash);
  const evidenceStoryFilesHash = normalizedBindingValue(evidence.storyFilesHash);

  if (storyFilesHash && evidenceStoryFilesHash) {
    if (evidenceStoryFilesHash !== storyFilesHash) {
      risks.push(`stale storyFilesHash ${shortHash(evidenceStoryFilesHash)} (current ${shortHash(storyFilesHash)})`);
    }
    if (storyFilesHash !== EMPTY_STORY_FILES_HASH) return risks;
  }

  if (materialHash && evidenceMaterialHash) {
    if (evidenceMaterialHash !== materialHash) {
      risks.push(`stale materialHash ${shortHash(evidenceMaterialHash)} (current ${shortHash(materialHash)})`);
    }
    return risks;
  }

  if (headHash) {
    return headHashFreshnessRisks(evidenceHeadHash, headHash);
  }

  if (materialHash) {
    if (!evidenceMaterialHash) risks.push(`missing materialHash binding (current ${shortHash(materialHash)})`);
    else if (evidenceMaterialHash !== materialHash) risks.push(`stale materialHash ${shortHash(evidenceMaterialHash)} (current ${shortHash(materialHash)})`);
  }

  if (storyFilesHash) {
    if (!evidenceStoryFilesHash) risks.push(`missing storyFilesHash binding (current ${shortHash(storyFilesHash)})`);
    else if (evidenceStoryFilesHash !== storyFilesHash) risks.push(`stale storyFilesHash ${shortHash(evidenceStoryFilesHash)} (current ${shortHash(storyFilesHash)})`);
  }

  return risks;
}

function evidenceIsCovering(
  evidence: VerificationEvidence,
  currentBinding: MilestoneStatusCurrentEvidenceBinding | null | undefined,
): boolean {
  return evidenceCanCover(evidence) && evidenceFreshnessRisks(evidence, currentBinding).length === 0;
}

function buildChecklistIndex(checklist: ChecklistData): Map<string, ChecklistItem> {
  return new Map(checklist.items.map((item) => [item.id, item]));
}

function buildIntentIndex(checklist: ChecklistData): IntentIndex {
  const index: IntentIndex = new Map();
  for (const item of checklist.items) {
    for (const collected of collectVerificationIntents(item)) {
      const existing = index.get(collected.ref) ?? [];
      existing.push({
        itemId: collected.itemId,
        lane: collected.lane,
        index: collected.index,
        intent: collected.intent,
      });
      index.set(collected.ref, existing);
    }
  }
  return index;
}

function scopedEvidenceKey(itemId: string, intentRef: string): string {
  return `${itemId}\0${intentRef}`;
}

function buildEvidenceIndex(checklist: ChecklistData): EvidenceIndex {
  const index: EvidenceIndex = new Map();
  for (const item of checklist.items) {
    for (const evidence of item.verificationEvidence ?? []) {
      const key = scopedEvidenceKey(item.id, evidence.intentRef);
      const existing = index.get(key) ?? [];
      existing.push(evidence);
      index.set(key, existing);
    }
  }
  return index;
}

function summarizeEvidence(evidence: VerificationEvidence): MilestoneStatusEvidenceRef {
  const base: MilestoneStatusEvidenceRef = {
    intentRef: evidence.intentRef,
    kind: evidence.kind,
    status: evidenceStatus(evidence),
    note: evidence.note,
  };
  if (evidence.command) base.command = evidence.command;
  if (evidence.file) base.file = evidence.file;
  if (evidence.timestamp) base.timestamp = evidence.timestamp;
  return base;
}

function evidenceRefKey(evidence: MilestoneStatusEvidenceRef): string {
  return [
    evidence.intentRef,
    evidence.kind,
    evidence.status,
    evidence.note,
    evidence.command ?? '',
    evidence.file ?? '',
    evidence.timestamp ?? '',
  ].join('\0');
}

function intentLabel(ref: string, entry: IntentIndexEntry | undefined): string {
  if (!entry) return ref;
  return `${ref} (${entry.lane}) ${entry.intent.desc}`;
}

function buildMilestoneRow(
  milestone: MilestoneLedgerItem,
  checklistById: Map<string, ChecklistItem>,
  intentByRef: IntentIndex,
  evidenceByOwnerAndRef: EvidenceIndex,
  currentEvidenceBinding: MilestoneStatusCurrentEvidenceBinding | null | undefined,
): Omit<MilestoneStatusRow, 'status'> & { complete: boolean } {
  const checklistRefs = stringArrayField((milestone as { checklistRefs?: unknown }).checklistRefs);
  const verificationIntentRefs = stringArrayField((milestone as { verificationIntentRefs?: unknown }).verificationIntentRefs);
  const requiredEvidence = stringArrayField((milestone as { requiredEvidence?: unknown }).requiredEvidence);
  const subObjectives: MilestoneStatusSubObjective[] = [];
  const evidenceRefs: MilestoneStatusEvidenceRef[] = [];
  const seenEvidenceRefs = new Set<string>();
  const coveringEvidenceByKind = new Map<string, VerificationEvidence[]>();
  const risks: string[] = [];
  const nextActionCandidates: string[] = [];
  let staleEvidenceDetected = false;
  let nonCoveringEvidenceDetected = false;
  const pushEvidenceRef = (evidence: VerificationEvidence): void => {
    const summarized = summarizeEvidence(evidence);
    const key = evidenceRefKey(summarized);
    if (seenEvidenceRefs.has(key)) return;
    seenEvidenceRefs.add(key);
    evidenceRefs.push(summarized);
  };

  if (milestone.status !== 'not_applicable' && checklistRefs.length === 0) {
    risks.push('missing-checklistRefs: milestone has no checklistRefs mapped.');
    nextActionCandidates.push(`Map at least one valid checklistRef for milestone ${milestone.id}.`);
  }

  for (const checklistRef of checklistRefs) {
    const item = checklistById.get(checklistRef);
    if (!item) {
      const risk = `Checklist ref ${checklistRef} is not present in checklist.json.`;
      risks.push(risk);
      subObjectives.push({
        id: checklistRef,
        kind: 'checklist',
        label: checklistRef,
        status: 'missing',
        risks: [risk],
      });
      nextActionCandidates.push(`Restore or re-map checklist ref ${checklistRef}.`);
      continue;
    }

    const itemRisks = item.status === 'done' ? [] : [`Checklist item ${item.id} is ${item.status}.`];
    if (itemRisks.length > 0) {
      risks.push(...itemRisks);
      nextActionCandidates.push(`Complete checklist item ${item.id}: ${item.title}`);
    }
    subObjectives.push({
      id: item.id,
      kind: 'checklist',
      label: item.title,
      status: item.status,
      risks: itemRisks,
    });
  }

  if (milestone.status !== 'not_applicable' && verificationIntentRefs.length === 0) {
    risks.push('Milestone has no verificationIntentRefs mapped.');
    nextActionCandidates.push(`Map verificationIntentRefs for milestone ${milestone.id}.`);
  }

  for (const ref of verificationIntentRefs) {
    const intentEntries = intentByRef.get(ref) ?? [];
    const intent = intentEntries.length === 1 ? intentEntries[0] : undefined;
    const evidence = intent ? evidenceByOwnerAndRef.get(scopedEvidenceKey(intent.itemId, ref)) ?? [] : [];
    const evidenceFreshness = evidence.map((entry) => ({
      entry,
      staleRisks: evidenceFreshnessRisks(entry, currentEvidenceBinding),
    }));
    const staleCoveringEvidence = evidenceFreshness.filter(({ entry, staleRisks }) => {
      return evidenceCanCover(entry) && staleRisks.length > 0;
    });
    const coveringEvidence = evidence.filter((entry) => evidenceIsCovering(entry, currentEvidenceBinding));
    const intentRisks: string[] = [];
    if (staleCoveringEvidence.length > 0) staleEvidenceDetected = true;
    if (evidence.length > 0 && coveringEvidence.length === 0 && staleCoveringEvidence.length === 0) {
      nonCoveringEvidenceDetected = true;
    }
    for (const entry of coveringEvidence) {
      const existing = coveringEvidenceByKind.get(entry.kind) ?? [];
      existing.push(entry);
      coveringEvidenceByKind.set(entry.kind, existing);
    }

    if (intentEntries.length === 0) {
      intentRisks.push(`Verification intent ref ${ref} is not present in checklist verificationIntent.`);
      nextActionCandidates.push(`Restore or re-map verification intent ref ${ref}.`);
    } else if (intentEntries.length > 1) {
      intentRisks.push(`Verification intent ref ${ref} is ambiguous across ${intentEntries.length} checklist items.`);
      nextActionCandidates.push(`Give each ${ref} verification intent a unique id and re-map the milestone.`);
    } else if (intent && checklistRefs.length > 0 && !checklistRefs.includes(intent.itemId)) {
      intentRisks.push(`Verification intent ref ${ref} belongs to checklist item ${intent.itemId}, which is not linked by this milestone.`);
      nextActionCandidates.push(`Add checklist ref ${intent.itemId} to milestone ${milestone.id} or re-map verification intent ref ${ref}.`);
    }
    if (intent) {
      if (evidence.length === 0) {
        intentRisks.push(`Verification intent ${ref} has no evidence on owning checklist item ${intent.itemId}.`);
        nextActionCandidates.push(`Record passing verificationEvidence for ${ref} on checklist item ${intent.itemId}.`);
      } else if (coveringEvidence.length === 0 && staleCoveringEvidence.length > 0) {
        const staleReasons = unique(staleCoveringEvidence.flatMap(({ entry, staleRisks }) =>
          staleRisks.map((risk) => `${entry.intentRef} ${risk}`)
        ));
        intentRisks.push(
          `Verification intent ${ref} has stale passing or permanent waiver evidence on owning checklist item ${intent.itemId}: ${staleReasons.join('; ')}.`,
        );
        nextActionCandidates.push(`Re-run verificationEvidence for ${ref} on checklist item ${intent.itemId} against the current evidence binding.`);
      } else if (coveringEvidence.length === 0) {
        intentRisks.push(`Verification intent ${ref} has no passing evidence or permanent non-failing waiver on owning checklist item ${intent.itemId}.`);
        nextActionCandidates.push(`Re-run or replace verificationEvidence for ${ref} on checklist item ${intent.itemId}.`);
      }
    }

    risks.push(...intentRisks);
    subObjectives.push({
      id: ref,
      kind: 'verificationIntent',
      label: intentLabel(ref, intent),
      status: intentEntries.length > 1
        ? 'ambiguous-intent'
        : intentEntries.length === 0 ? 'missing-intent' : coveringEvidence.length > 0 ? 'covered' : staleCoveringEvidence.length > 0 ? 'stale-evidence' : evidence.length > 0 ? 'not-passing' : 'missing-evidence',
      risks: intentRisks,
    });
    for (const entry of evidence) pushEvidenceRef(entry);
  }

  for (const required of requiredEvidence) {
    const knownEvidenceKind = isKnownEvidenceKind(required);
    const requiredCovered = !knownEvidenceKind || (coveringEvidenceByKind.get(required) ?? []).length > 0;
    const requiredRisks = verificationIntentRefs.length === 0
      ? [`Required evidence "${required}" has no verificationIntentRefs mapping.`]
      : requiredCovered ? [] : [`Required evidence kind "${required}" has no fresh covering evidence on mapped verificationIntentRefs.`];
    if (requiredRisks.length > 0 && verificationIntentRefs.length > 0) {
      nextActionCandidates.push(`Record fresh passing ${required} verificationEvidence for milestone ${milestone.id}.`);
    }
    subObjectives.push({
      id: required,
      kind: 'requiredEvidence',
      label: required,
      status: requiredCovered
        ? (knownEvidenceKind ? 'covered' : 'mapped')
        : verificationIntentRefs.length > 0 ? 'missing-evidence-kind' : 'unmapped',
      risks: requiredRisks,
    });
    risks.push(...requiredRisks);
  }

  const checklistRefsComplete = checklistRefs.length > 0 && checklistRefs.every((ref) => checklistById.get(ref)?.status === 'done');
  const checklistRefsValid = checklistRefs.length > 0 && checklistRefs.every((ref) => checklistById.has(ref));
  const verificationRefsValid = verificationIntentRefs.every((ref) => {
    const entries = intentByRef.get(ref) ?? [];
    return entries.length === 1 && (checklistRefs.length === 0 || checklistRefs.includes(entries[0].itemId));
  });
  const verificationRefsCovered = verificationIntentRefs.length > 0 && verificationIntentRefs.every((ref) => {
    const entries = intentByRef.get(ref) ?? [];
    if (entries.length !== 1) return false;
    if (checklistRefs.length > 0 && !checklistRefs.includes(entries[0].itemId)) return false;
    const evidence = evidenceByOwnerAndRef.get(scopedEvidenceKey(entries[0].itemId, ref)) ?? [];
    return evidence.some((entry) => evidenceIsCovering(entry, currentEvidenceBinding));
  });
  const referencesValid =
    checklistRefsValid
    && verificationRefsValid;
  const evidenceRequirementsCovered = requiredEvidence.length === 0
    || requiredEvidence.every((required) => !isKnownEvidenceKind(required) || (coveringEvidenceByKind.get(required) ?? []).length > 0);
  const complete = milestone.status === 'not_applicable' || (
    referencesValid
    && checklistRefsComplete
    && verificationRefsCovered
    && evidenceRequirementsCovered
  );

  if (milestone.status === 'planned') {
    nextActionCandidates.push(`Start milestone ${milestone.id} by completing its linked checklist and evidence refs.`);
  } else if (milestone.status === 'covered' && risks.length === 0) {
    nextActionCandidates.push(`Review milestone ${milestone.id} and mark it done in the milestone ledger when appropriate.`);
  } else if (milestone.status === 'done' && !complete && risks.length > 0) {
    nextActionCandidates.push(`Resolve the missing or non-passing refs before treating ${milestone.id} as complete.`);
  }

  const nextAction = complete
    ? 'No action for this milestone.'
    : unique(nextActionCandidates)[0] ?? `Define the next checklist or evidence action for ${milestone.id}.`;

  return {
    id: milestone.id,
    claim: milestone.claim,
    doneMeans: milestone.doneMeans,
    ledgerStatus: milestone.status,
    statusDetail: `ledger=${milestone.status}; checklist=${milestone.status === 'not_applicable' && checklistRefs.length === 0 ? 'not-required' : checklistRefsComplete ? 'complete' : checklistRefs.length === 0 ? 'missing' : 'incomplete'}; evidence=${verificationRefsCovered ? 'covered' : staleEvidenceDetected ? 'stale' : nonCoveringEvidenceDetected ? 'not-passing' : 'missing'}; requiredEvidence=${evidenceRequirementsCovered ? 'covered' : 'missing'}`,
    sourceRequirementId: milestone.sourceRequirementId,
    ...(milestone.parentLedgerId ? { parentLedgerId: milestone.parentLedgerId } : {}),
    ...(milestone.assignedStory ? { assignedStory: milestone.assignedStory } : {}),
    checklistRefs,
    verificationIntentRefs,
    requiredEvidence,
    subObjectives,
    evidenceRefs,
    risks: unique(risks),
    nextAction,
    complete,
  };
}

function summaryProjection(summary: StorySummaryData | null | undefined): MilestoneStatusReport['summary'] | undefined {
  if (!summary) return undefined;
  const projection: NonNullable<MilestoneStatusReport['summary']> = {};
  if (summary.acceptanceVerdict) projection.acceptanceVerdict = summary.acceptanceVerdict;
  if (summary.outcomeKind) projection.outcomeKind = summary.outcomeKind;
  if (summary.expectedOutcome) projection.expectedOutcome = summary.expectedOutcome;
  return Object.keys(projection).length > 0 ? projection : undefined;
}

function summaryRisks(summary: StorySummaryData | null | undefined): string[] {
  if (!summary) return [];
  const risks: string[] = [];
  if (summary.acceptanceVerdict && summary.acceptanceVerdict !== 'accepted') {
    risks.push(`Summary acceptanceVerdict is ${summary.acceptanceVerdict}.`);
  }
  if (summary.outcomeKind && summary.outcomeKind !== 'success') {
    risks.push(`Summary outcomeKind is ${summary.outcomeKind}.`);
  }
  for (const skipped of summary.realMachineCoverage?.skipped ?? []) {
    risks.push(`Real-machine coverage skipped: ${skipped.name} (${skipped.reason}).`);
  }
  return risks;
}

function validMilestoneProgressStatus(value: string): MilestoneProgressStatus | null {
  if (value === 'completed' || value === 'current' || value === 'remaining') return value;
  return null;
}

function validMilestoneLedgerStatus(value: string | undefined): MilestoneStatus | null {
  if (
    value === 'planned'
    || value === 'covered'
    || value === 'done'
    || value === 'not_applicable'
  ) return value;
  return null;
}

function closeoutRowStatusParts(value: string): { progressStatus: MilestoneProgressStatus | null; detail: string } {
  const trimmed = value.trim();
  const match = /^([^(]+?)(?:\s+\((.*)\))?$/.exec(trimmed);
  const progressStatus = validMilestoneProgressStatus(match?.[1]?.trim() ?? '');
  return {
    progressStatus,
    detail: match?.[2]?.trim() || trimmed || 'snapshot=closeout',
  };
}

function closeoutRowStatusFromGroups(
  rowId: string,
  groups: MilestoneStatusReport['groups'],
  fallback: MilestoneProgressStatus | null,
): MilestoneProgressStatus {
  if (groups.completed.includes(rowId)) return 'completed';
  if (groups.current.includes(rowId)) return 'current';
  if (groups.remaining.includes(rowId)) return 'remaining';
  return fallback ?? 'completed';
}

function ledgerStatusFromCloseoutDetail(
  detail: string,
  progressStatus: MilestoneProgressStatus,
): MilestoneStatus {
  // Frozen completed closeout rows are final for display even when detail preserves pre-DONE ledger state.
  if (progressStatus === 'completed') return 'done';
  const ledgerStatus = validMilestoneLedgerStatus(/\bledger=([^;\s)]+)/.exec(detail)?.[1]);
  if (ledgerStatus) return ledgerStatus;
  return 'planned';
}

function closeoutEvidenceStatus(value: string | undefined): MilestoneStatusEvidenceRef['status'] {
  if (value === 'pass' || value === 'fail' || value === 'missing-result' || value === 'waived') return value;
  return 'pass';
}

function closeoutEvidenceRefFromText(text: string, index: number): MilestoneStatusEvidenceRef {
  const trimmed = text.trim();
  const match = /^(.+?) \[([^/\]]+)\/([^\]]+)\](?:\s+(.*))?$/.exec(trimmed);
  if (!match) {
    return {
      intentRef: `closeout:${index + 1}`,
      kind: 'manual_transcript',
      status: 'pass',
      note: trimmed,
    };
  }

  const [, intentRef, status, kind, rest] = match;
  return {
    intentRef,
    kind: kind as VerificationEvidence['kind'],
    status: closeoutEvidenceStatus(status),
    note: trimmed,
    ...(rest ? { command: rest } : {}),
  };
}

function closeoutStatusFromEvidence(status: MilestoneStatusEvidenceRef['status']): string {
  if (status === 'pass') return 'covered';
  if (status === 'waived') return 'waived';
  if (status === 'fail') return 'fail';
  return status;
}

function closeoutNextActionsFromRows(
  rows: MilestoneStatusRow[],
  groups: MilestoneStatusReport['groups'],
): string[] {
  if (groups.current.length > 0) {
    return unique(groups.current.map((id) => rows.find((row) => row.id === id)?.nextAction ?? '').filter(Boolean));
  }
  if (groups.remaining.length > 0) {
    const nextAction = rows.find((row) => row.id === groups.remaining[0])?.nextAction;
    return [nextAction ?? 'Start the next remaining milestone.'];
  }
  return ['No milestone action; all ledger rows are completed or not applicable.'];
}

export function buildMilestoneStatusReportFromCloseoutSnapshot(
  snapshot: MilestoneCloseoutSnapshot,
  options: { phase?: StoryPhase } = {},
): MilestoneStatusReport {
  const groups = {
    completed: [...snapshot.sourceReport.groups.completed],
    current: [...snapshot.sourceReport.groups.current],
    remaining: [...snapshot.sourceReport.groups.remaining],
  };
  const milestones: MilestoneStatusRow[] = snapshot.rows.map((row) => {
    const parsedStatus = closeoutRowStatusParts(row.status);
    const status = closeoutRowStatusFromGroups(row.milestone, groups, parsedStatus.progressStatus);
    const ledgerStatus = ledgerStatusFromCloseoutDetail(parsedStatus.detail, status);
    const evidenceRefs = row.evidence.map(closeoutEvidenceRefFromText);
    return {
      id: row.milestone,
      claim: row.solvedProblem,
      doneMeans: row.acceptance,
      ledgerStatus,
      status,
      statusDetail: parsedStatus.detail,
      sourceRequirementId: row.milestone,
      checklistRefs: [],
      verificationIntentRefs: evidenceRefs.map((evidence) => evidence.intentRef),
      requiredEvidence: [],
      subObjectives: evidenceRefs.map((evidence) => ({
        id: evidence.intentRef,
        kind: 'verificationIntent',
        label: 'Frozen closeout evidence',
        status: closeoutStatusFromEvidence(evidence.status),
        risks: [],
      })),
      evidenceRefs,
      risks: [...row.risks],
      nextAction: row.nextAction,
    };
  });
  const rowRisks = unique(milestones.flatMap((row) => row.risks.map((risk) => `${row.id}: ${risk}`)));
  const risks = snapshot.sourceReport.risks ? [...snapshot.sourceReport.risks] : rowRisks;
  const nextActions = snapshot.sourceReport.nextActions
    ? [...snapshot.sourceReport.nextActions]
    : closeoutNextActionsFromRows(milestones, groups);

  return {
    schemaVersion: MILESTONE_STATUS_SCHEMA_VERSION,
    storyId: snapshot.storyId,
    phase: options.phase ?? snapshot.phase,
    ledger: snapshot.sourceReport.ledger,
    mode: READ_ONLY_MODE,
    milestones,
    groups,
    risks,
    nextActions,
  };
}

function missingLedgerReport(input: BuildMilestoneStatusReportInput): MilestoneStatusReport {
  const risk = 'Missing milestone ledger: milestone_status cannot infer milestone progress without milestone-ledger.json.';
  const nextAction = `Create or restore the ProofStory milestone ledger with \`lattice milestone_ledger_set --storyId=${input.story.storyId} ...\`; milestone_status is read-only and will not create it.`;
  const summary = summaryProjection(input.summary);
  return {
    schemaVersion: MILESTONE_STATUS_SCHEMA_VERSION,
    storyId: input.story.storyId,
    phase: input.story.phase,
    ledger: {
      present: false,
      state: null,
      hash: null,
    },
    mode: READ_ONLY_MODE,
    milestones: [],
    groups: {
      completed: [],
      current: [],
      remaining: [],
    },
    risks: [risk, ...summaryRisks(input.summary)],
    nextActions: [nextAction],
    ...(summary ? { summary } : {}),
  };
}

export function buildMilestoneStatusReport(input: BuildMilestoneStatusReportInput): MilestoneStatusReport {
  const ledger = input.milestoneLedger;
  if (!ledger) return missingLedgerReport(input);

  const checklistById = buildChecklistIndex(input.checklist);
  const intentByRef = buildIntentIndex(input.checklist);
  const evidenceByRef = buildEvidenceIndex(input.checklist);
  const rawRows = ledger.milestones.map((milestone) =>
    buildMilestoneRow(milestone, checklistById, intentByRef, evidenceByRef, input.currentEvidenceBinding)
  );

  const completedRows = rawRows.filter((row) => row.complete);
  const incompleteRows = rawRows.filter((row) => !row.complete);
  const currentIds = incompleteRows.length > 0 ? [incompleteRows[0].id] : [];
  const currentIdSet = new Set(currentIds);

  const rows: MilestoneStatusRow[] = rawRows.map(({ complete: _complete, ...row }) => ({
    ...row,
    status: row.ledgerStatus === 'not_applicable' || completedRows.some((candidate) => candidate.id === row.id)
      ? 'completed'
      : currentIdSet.has(row.id) ? 'current' : 'remaining',
  }));

  const groups = {
    completed: rows.filter((row) => row.status === 'completed').map((row) => row.id),
    current: rows.filter((row) => row.status === 'current').map((row) => row.id),
    remaining: rows.filter((row) => row.status === 'remaining').map((row) => row.id),
  };
  const summary = summaryProjection(input.summary);

  const risks = unique([
    ...(ledger.state === 'candidate' ? ['Milestone ledger state is candidate; confirmed ledgers are required for gate consumption.'] : []),
    ...rows.flatMap((row) => row.risks.map((risk) => `${row.id}: ${risk}`)),
    ...summaryRisks(input.summary),
  ]);
  const nextActions = groups.current.length > 0
    ? unique(rows.filter((row) => row.status === 'current').map((row) => row.nextAction))
    : groups.remaining.length > 0
      ? unique([rows.find((row) => row.status === 'remaining')?.nextAction ?? 'Start the next remaining milestone.'])
      : ['No milestone action; all ledger rows are completed or not applicable.'];

  return {
    schemaVersion: MILESTONE_STATUS_SCHEMA_VERSION,
    storyId: input.story.storyId,
    phase: input.story.phase,
    ledger: {
      present: true,
      state: ledger.state ?? null,
      hash: ledger.ledgerHash ?? null,
    },
    mode: READ_ONLY_MODE,
    milestones: rows,
    groups,
    risks,
    nextActions,
    ...(summary ? { summary } : {}),
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    const entry = input[key];
    if (entry !== undefined) output[key] = canonicalize(entry);
  }
  return output;
}

export function milestoneStatusReportDigest(report: MilestoneStatusReport): string {
  return createHash('sha256').update(canonicalJson(report)).digest('hex');
}

function closeoutEvidenceText(evidence: MilestoneStatusEvidenceRef): string {
  return [
    `${evidence.intentRef} [${evidence.status}/${evidence.kind}]`,
    evidence.command,
    evidence.file ? `file=${evidence.file}` : undefined,
    evidence.note ? `note=${evidence.note}` : undefined,
  ].filter((part): part is string => Boolean(part && part.trim())).join(' ');
}

export function buildMilestoneCloseoutSnapshot(
  input: BuildMilestoneCloseoutSnapshotInput,
): MilestoneCloseoutSnapshot {
  const report = input.report;
  if (!report.ledger.present) {
    throw new Error(
      `Cannot create milestone closeout snapshot for ${report.storyId}: missing milestone ledger; ` +
      'a DONE closeout cannot fabricate success without milestone-ledger.json.',
    );
  }
  if (report.milestones.length === 0) {
    throw new Error(
      `Cannot create milestone closeout snapshot for ${report.storyId}: milestone report has no rows.`,
    );
  }

  const incomplete = report.milestones.filter((row) => row.status !== 'completed');
  if (incomplete.length > 0) {
    throw new Error(
      `Cannot create milestone closeout snapshot for ${report.storyId}: incomplete milestone rows: ` +
      incomplete.map((row) => `${row.id}=${row.status}`).join(', '),
    );
  }

  const rowRisks = report.milestones.flatMap((row) => row.risks.map((risk) => `${row.id}: ${risk}`));
  const risks = unique([...report.risks, ...rowRisks]);
  if (risks.length > 0) {
    throw new Error(
      `Cannot create milestone closeout snapshot for ${report.storyId}: milestone report has risks: ${risks.join('; ')}`,
    );
  }

  return {
    schemaVersion: MILESTONE_CLOSEOUT_SCHEMA_VERSION,
    storyId: report.storyId,
    phase: report.phase,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    sourceReport: {
      schemaVersion: report.schemaVersion,
      digest: milestoneStatusReportDigest(report),
      ledger: report.ledger,
      groups: report.groups,
      risks: report.risks,
      nextActions: report.nextActions,
    },
    bindings: input.bindings ?? {},
    rows: report.milestones.map((row) => ({
      milestone: row.id,
      status: `${row.status} (${row.statusDetail})`,
      solvedProblem: row.claim,
      acceptance: row.doneMeans,
      evidence: row.evidenceRefs.map(closeoutEvidenceText),
      risks: row.risks,
      nextAction: row.nextAction,
    })),
  };
}

export function buildMilestoneCloseoutMissingReport(
  storyId: string,
  expectedPath?: string,
): MilestoneCloseoutMissingReport {
  return {
    schemaVersion: MILESTONE_CLOSEOUT_MISSING_SCHEMA_VERSION,
    storyId,
    snapshotPresent: false,
    ...(expectedPath ? { expectedPath } : {}),
    diagnostic: `No ${MILESTONE_CLOSEOUT_FILENAME} snapshot exists for ${storyId}.`,
    nextAction:
      `Run \`lattice milestone_status --storyId=${storyId}\` to inspect the live report, then complete a risk-free DONE path so Proofbound can capture ${MILESTONE_CLOSEOUT_FILENAME}.`,
  };
}

function renderCloseoutTableRow(row: MilestoneCloseoutSnapshotRow): string {
  return `| ${[
    row.milestone,
    row.status,
    row.solvedProblem,
    row.acceptance,
    formatList(row.evidence),
    formatList(row.risks),
    row.nextAction,
  ].map(formatCell).join(' | ')} |`;
}

function renderCloseoutHeader(): string[] {
  return [
    '| Milestone | Status | Solved Problem | Acceptance | Evidence | Risks | Next Action |',
    '|---|---|---|---|---|---|---|',
  ];
}

function renderBindingSummary(bindings: MilestoneStatusCurrentEvidenceBinding): string {
  const parts = [
    bindings.headHash ? `headHash=${shortHash(bindings.headHash)}` : '',
    bindings.materialHash ? `materialHash=${shortHash(bindings.materialHash)}` : '',
    bindings.storyFilesHash ? `storyFilesHash=${shortHash(bindings.storyFilesHash)}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'none';
}

export function renderMilestoneCloseoutSnapshot(snapshot: MilestoneCloseoutSnapshot): string {
  const lines = [
    `Milestone Closeout - ${snapshot.storyId}`,
    'Mode: read-only historical snapshot',
    `Phase: ${snapshot.phase}`,
    `Generated: ${snapshot.generatedAt}`,
    `Source milestone_status digest: ${snapshot.sourceReport.digest}`,
    `Bindings: ${renderBindingSummary(snapshot.bindings)}`,
    '',
    ...renderCloseoutHeader(),
  ];
  if (snapshot.rows.length === 0) {
    lines.push('| none | none | none | none | none | none | none |');
  } else {
    for (const row of snapshot.rows) lines.push(renderCloseoutTableRow(row));
  }
  return lines.join('\n');
}

export function renderMilestoneCloseoutMissingReport(report: MilestoneCloseoutMissingReport): string {
  return [
    `Milestone Closeout - ${report.storyId}`,
    'Mode: read-only historical snapshot',
    'Snapshot: missing',
    report.expectedPath ? `Expected path: ${report.expectedPath}` : undefined,
    `Diagnostic: ${report.diagnostic}`,
    '',
    ...renderCloseoutHeader(),
    `| snapshot | missing | DONE closeout snapshot unavailable | completed risk-free milestone_status report at DONE | none | ${formatCell(report.diagnostic)} | ${formatCell(report.nextAction)} |`,
    '',
    `Next action: ${report.nextAction}`,
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join('; ') : 'none';
}

function formatCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

type DisplayStatus = 'done' | 'inProgress' | 'pendingReview' | 'notStarted' | 'blocked' | 'failed';

const DISPLAY_STATUSES: Record<DisplayStatus, { icon: string; label: string }> = {
  done: { icon: '✅', label: 'Done' },
  inProgress: { icon: '⏳', label: 'In Progress' },
  pendingReview: { icon: '🟡', label: 'Pending Review' },
  notStarted: { icon: '⬜', label: 'Not Started' },
  blocked: { icon: '🔴', label: 'Blocked' },
  failed: { icon: '❌', label: 'Failed' },
};

function displayStatusText(status: DisplayStatus, detail?: string): string {
  const display = DISPLAY_STATUSES[status];
  return `${display.icon} ${display.label}${detail ? ` (${detail})` : ''}`;
}

function normalizeDisplayStatus(status: string): string {
  return status.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function detailDisplayStatus(status: string): DisplayStatus {
  const normalized = normalizeDisplayStatus(status);
  const failedStatuses = new Set(['fail', 'failed', 'not_passing']);
  const inProgressStatuses = new Set(['in_progress', 'current', 'running', 'active', 'actively_being_developed']);
  const completedStatuses = new Set(['done', 'covered', 'pass', 'passed', 'success', 'complete', 'completed', 'not_applicable', 'mapped', 'waived']);
  const notStartedStatuses = new Set(['pending', 'planned', 'remaining', 'not_started', 'todo', 'queued']);
  const blockedStatuses = new Set([
    'missing',
    'blocked',
    'incomplete',
    'missing_result',
    'stale_evidence',
    'ambiguous_intent',
    'missing_intent',
    'missing_evidence',
    'missing_evidence_kind',
    'unmapped',
  ]);

  if (failedStatuses.has(normalized)) return 'failed';
  if (inProgressStatuses.has(normalized)) return 'inProgress';
  if (completedStatuses.has(normalized)) return 'done';
  if (notStartedStatuses.has(normalized)) return 'notStarted';
  if (blockedStatuses.has(normalized)) return 'blocked';
  if (normalized.includes('fail') || normalized.includes('not_passing')) return 'failed';
  if (normalized.includes('current') || normalized.includes('running') || normalized.includes('progress')) return 'inProgress';
  if (normalized.includes('pending') || normalized.includes('planned') || normalized.includes('remaining')) return 'notStarted';
  if (
    normalized.includes('missing')
    || normalized.includes('blocked')
    || normalized.includes('incomplete')
    || normalized.includes('stale')
    || normalized.includes('ambiguous')
    || normalized.includes('unmapped')
  ) return 'blocked';
  return 'blocked';
}

function rowHasFailedEvidence(row: MilestoneStatusRow): boolean {
  return row.evidenceRefs.some((evidence) => detailDisplayStatus(evidence.status) === 'failed')
    || row.subObjectives.some((sub) => detailDisplayStatus(sub.status) === 'failed')
    || /\bevidence=not-passing\b/.test(row.statusDetail);
}

function rowHasBlockingGap(row: MilestoneStatusRow): boolean {
  return row.subObjectives.some((sub) => {
    const normalized = normalizeDisplayStatus(sub.status);
    return normalized === 'ambiguous_intent'
      || normalized === 'missing_intent'
      || normalized === 'missing_evidence_kind'
      || normalized === 'unmapped';
  })
    || /\bchecklist=missing\b/.test(row.statusDetail)
    || /\brequiredEvidence=missing\b/.test(row.statusDetail)
    || /\bevidence=stale\b/.test(row.statusDetail)
    || row.risks.some((risk) =>
      /no verificationIntentRefs mapped|not present|ambiguous|not linked|no checklistRefs mapped|required evidence kind/i.test(risk)
    );
}

function rowAppearsPendingReview(row: MilestoneStatusRow): boolean {
  if (row.ledgerStatus === 'done' || row.ledgerStatus === 'not_applicable') return false;
  return (row.ledgerStatus === 'covered' && row.risks.length === 0)
    || (
      /\bchecklist=complete\b/.test(row.statusDetail)
      && /\bevidence=covered\b/.test(row.statusDetail)
      && /\brequiredEvidence=covered\b/.test(row.statusDetail)
    );
}

function milestoneDisplayStatus(row: MilestoneStatusRow): DisplayStatus {
  if (rowHasFailedEvidence(row)) return 'failed';
  if (rowAppearsPendingReview(row)) return 'pendingReview';
  if (rowHasBlockingGap(row)) return 'blocked';
  if (row.status === 'completed') return 'done';
  if (row.status === 'current') return 'inProgress';
  return 'notStarted';
}

function formatDetailStatus(status: string): string {
  return displayStatusText(detailDisplayStatus(status));
}

function formatMilestoneStatus(row: MilestoneStatusRow): string {
  return displayStatusText(milestoneDisplayStatus(row), row.statusDetail);
}

function renderTableRow(row: MilestoneStatusRow): string {
  const cells = [
    row.id,
    row.claim,
    formatMilestoneStatus(row),
    formatList(row.subObjectives.map((sub) => `${formatDetailStatus(sub.status)} ${sub.id} [${sub.status}] ${sub.label}`)),
    formatList(row.evidenceRefs.map((evidence) => `${formatDetailStatus(evidence.status)} ${evidence.intentRef} [${evidence.status}/${evidence.kind}]${evidence.command ? ` ${evidence.command}` : ''}`)),
    formatList(row.risks),
    row.nextAction,
  ].map(formatCell);
  return `| ${cells.join(' | ')} |`;
}

function renderSection(label: 'Completed' | 'Current' | 'Remaining', rows: MilestoneStatusRow[]): string[] {
  const lines: string[] = [
    label,
    '| Milestone | Purpose | Status: | Sub-objectives: | Evidence: | Risks: | Next action: |',
    '|---|---|---|---|---|---|---|',
  ];
  if (rows.length === 0) {
    lines.push('| none | none | none | none | none | none | none |');
    return lines;
  }
  for (const row of rows) lines.push(renderTableRow(row));
  return lines;
}

export function renderMilestoneStatusReport(report: MilestoneStatusReport): string {
  const lines = [
    `Milestone Status - ${report.storyId}`,
    'Mode: read-only',
    `Phase: ${report.phase}`,
    `Ledger: ${report.ledger.present ? `state=${report.ledger.state ?? 'unknown'} hash=${report.ledger.hash ?? 'unknown'}` : 'missing'}`,
    '',
  ];

  if (!report.ledger.present) {
    lines.push(
      'Completed',
      '| Milestone | Purpose | Status: | Sub-objectives: | Evidence: | Risks: | Next action: |',
      '|---|---|---|---|---|---|---|',
      '| none | none | none | none | none | none | none |',
      '',
      'Current',
      '| Milestone | Purpose | Status: | Sub-objectives: | Evidence: | Risks: | Next action: |',
      '|---|---|---|---|---|---|---|',
      `| ledger | milestone ledger required | ${displayStatusText('blocked', 'ledger=missing')} | ${displayStatusText('blocked')} milestone ledger missing | none | ${formatCell(formatList(report.risks))} | ${formatCell(formatList(report.nextActions))} |`,
      '',
      'Remaining',
      '| Milestone | Purpose | Status: | Sub-objectives: | Evidence: | Risks: | Next action: |',
      '|---|---|---|---|---|---|---|',
      '| none | none | none | none | none | none | none |',
    );
    return lines.join('\n');
  }

  const byId = new Map(report.milestones.map((row) => [row.id, row]));
  lines.push(
    ...renderSection('Completed', report.groups.completed.map((id) => byId.get(id)).filter((row): row is MilestoneStatusRow => Boolean(row))),
    '',
    ...renderSection('Current', report.groups.current.map((id) => byId.get(id)).filter((row): row is MilestoneStatusRow => Boolean(row))),
    '',
    ...renderSection('Remaining', report.groups.remaining.map((id) => byId.get(id)).filter((row): row is MilestoneStatusRow => Boolean(row))),
    '',
    `Risks: ${formatList(report.risks)}`,
    `Next action: ${formatList(report.nextActions)}`,
  );
  return lines.join('\n');
}
