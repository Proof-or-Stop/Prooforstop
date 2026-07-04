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
import { collectVerificationIntents } from './verification.js';

export const MILESTONE_STATUS_SCHEMA_VERSION = 'proofbound.milestone_status.v1';

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

export interface BuildMilestoneStatusReportInput {
  story: StoryInfo;
  checklist: ChecklistData;
  milestoneLedger: MilestoneLedgerData | null;
  summary?: StorySummaryData | null;
  currentEvidenceBinding?: MilestoneStatusCurrentEvidenceBinding | null;
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
  const currentHasStrongBinding = Boolean(materialHash && storyFilesHash);
  const evidenceHasStrongBinding = Boolean(evidenceMaterialHash && evidenceStoryFilesHash);

  if (currentHasStrongBinding && evidenceHasStrongBinding) {
    const currentMaterialHash = materialHash as string;
    const currentStoryFilesHash = storyFilesHash as string;
    const boundMaterialHash = evidenceMaterialHash as string;
    const boundStoryFilesHash = evidenceStoryFilesHash as string;
    if (boundMaterialHash !== currentMaterialHash) {
      risks.push(`stale materialHash ${shortHash(boundMaterialHash)} (current ${shortHash(currentMaterialHash)})`);
    }
    if (boundStoryFilesHash !== currentStoryFilesHash) {
      risks.push(`stale storyFilesHash ${shortHash(boundStoryFilesHash)} (current ${shortHash(currentStoryFilesHash)})`);
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

function formatList(values: string[]): string {
  return values.length > 0 ? values.join('; ') : 'none';
}

function formatCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function renderTableRow(row: MilestoneStatusRow): string {
  const cells = [
    row.id,
    row.claim,
    `${row.status} (${row.statusDetail})`,
    formatList(row.subObjectives.map((sub) => `${sub.id} [${sub.status}] ${sub.label}`)),
    formatList(row.evidenceRefs.map((evidence) => `${evidence.intentRef} [${evidence.status}/${evidence.kind}]${evidence.command ? ` ${evidence.command}` : ''}`)),
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
      `| ledger | milestone ledger required | blocked | milestone ledger missing | none | ${formatCell(formatList(report.risks))} | ${formatCell(formatList(report.nextActions))} |`,
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
