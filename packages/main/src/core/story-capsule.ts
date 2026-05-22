/**
 * @task B-42c0
 * @checklist CHK-001
 * @title story capsule projection contract
 * @type feature
 * @priority high
 * @description
 *   Defines the story-scoped capsule projection used for resumable handoff.
 *   The capsule is intentionally not gate evidence: it references process
 *   events and evidence artifacts, while process-events.jsonl and evidence
 *   files remain authoritative.
 * @changes
 *   - [CHK-001] Add machine-readable capsule, run, and reference contracts
 *   - [CHK-003] Add rebuild/render/validation helpers for the projection layer
 *   - [CHK-005] Add reference validation so forged prose cannot masquerade as evidence
 */
import { existsSync } from 'fs';
import { isAbsolute, join } from 'path';
import type { ChecklistData, ProcessEvent, StoryInfo } from './types.js';

export const CAPSULE_DIR_NAME = 'capsule';
export const CAPSULE_LIMITS = {
  maxRunRefs: 5,
  maxProcessEventRefs: 5,
  maxEvidenceRefs: 10,
  maxOpenBlockers: 5,
  maxSummaryChars: 500,
  maxNextActionChars: 300,
  maxBlockerChars: 200,
  maxTranscriptChars: 6000,
} as const;

export type CapsuleRunRole = 'implementer' | 'reviewer' | 'tester' | 'verifier' | 'main' | 'other';
export type CapsuleRunResult = 'pass' | 'fail' | 'blocked' | 'unknown';
export type CapsuleAuthority = 'authoritative' | 'non_authoritative';

export interface CapsuleEvidenceRef {
  kind?: string;
  path?: string;
  intentRef?: string;
  receiptId?: string;
  processEventLine?: number;
  authority?: CapsuleAuthority;
  note?: string;
}

export interface CapsuleProcessEventRef {
  line?: number;
  type?: string;
  digest?: string;
  note?: string;
}

export interface CapsuleRunRef {
  runId: string;
  role?: CapsuleRunRole;
  provider?: string;
  result?: CapsuleRunResult;
  path?: string;
}

export interface StoryCapsuleData {
  storyId: string;
  phase: string;
  currentChecklistId?: string | null;
  activeRunId?: string | null;
  lastUpdatedAt: string;
  summary: string;
  nextAction: string;
  openBlockers: string[];
  evidenceRefs: CapsuleEvidenceRef[];
  processEventRefs: CapsuleProcessEventRef[];
  runRefs: CapsuleRunRef[];
  source?: 'manual' | 'rebuild' | 'run_add' | 'handoff';
  authority: 'projection';
}

export interface StoryCapsuleRunData {
  storyId: string;
  runId: string;
  checklistId?: string | null;
  provider?: string;
  model?: string;
  vendor?: string;
  role: CapsuleRunRole;
  startedAt: string;
  endedAt?: string | null;
  result: CapsuleRunResult;
  commands: string[];
  evidenceRefs: CapsuleEvidenceRef[];
  processEventRefs: CapsuleProcessEventRef[];
  metrics?: Record<string, unknown>;
  artifacts?: Record<string, unknown>;
}

export interface CapsuleValidationIssue {
  severity: 'warning' | 'error';
  refKind: 'evidence' | 'process-event' | 'capsule';
  ref: CapsuleEvidenceRef | CapsuleProcessEventRef | CapsuleRunRef | StoryCapsuleData;
  message: string;
}

export interface BuildCapsuleInput {
  story: StoryInfo;
  checklist?: ChecklistData | null;
  processEvents?: ProcessEvent[];
  existing?: StoryCapsuleData | null;
  patch?: Partial<StoryCapsuleData>;
  source?: StoryCapsuleData['source'];
}

export interface ValidateCapsuleRefsInput {
  capsule: StoryCapsuleData;
  checklist?: ChecklistData | null;
  processEvents?: ProcessEvent[];
  projectRoot: string;
  storyDir: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function deriveCurrentChecklistId(checklist?: ChecklistData | null): string | null {
  if (!checklist) return null;
  return checklist.items.find(item => item.status === 'in_progress')?.id
    ?? checklist.items.find(item => item.status === 'pending')?.id
    ?? checklist.items[0]?.id
    ?? null;
}

export function buildStoryCapsule(input: BuildCapsuleInput): StoryCapsuleData {
  const existing = input.existing;
  const checklistId = input.patch?.currentChecklistId !== undefined
    ? input.patch.currentChecklistId
    : existing?.currentChecklistId ?? deriveCurrentChecklistId(input.checklist);
  const processEventRefs = input.patch?.processEventRefs
    ?? existing?.processEventRefs
    ?? lastProcessEventRefs(input.processEvents ?? [], 5);
  return normalizeCapsuleProjection({
    storyId: input.story.storyId,
    phase: input.story.phase,
    currentChecklistId: checklistId ?? null,
    activeRunId: input.patch?.activeRunId !== undefined ? input.patch.activeRunId : existing?.activeRunId ?? null,
    lastUpdatedAt: nowIso(),
    summary: input.patch?.summary ?? existing?.summary ?? `${input.story.storyId} ${input.story.title}`,
    nextAction: input.patch?.nextAction ?? existing?.nextAction ?? defaultNextAction(input.story, checklistId ?? null),
    openBlockers: input.patch?.openBlockers ?? existing?.openBlockers ?? [],
    evidenceRefs: input.patch?.evidenceRefs ?? existing?.evidenceRefs ?? [],
    processEventRefs,
    runRefs: input.patch?.runRefs ?? existing?.runRefs ?? [],
    source: input.source ?? input.patch?.source ?? existing?.source ?? 'rebuild',
    authority: 'projection',
  });
}

export function appendRunRef(capsule: StoryCapsuleData, run: StoryCapsuleRunData): StoryCapsuleData {
  const runRef: CapsuleRunRef = {
    runId: run.runId,
    role: run.role,
    provider: run.provider,
    result: run.result,
    path: `${CAPSULE_DIR_NAME}/runs/${run.runId}`,
  };
  return normalizeCapsuleProjection({
    ...capsule,
    activeRunId: run.runId,
    currentChecklistId: run.checklistId ?? capsule.currentChecklistId ?? null,
    runRefs: [...capsule.runRefs.filter(r => r.runId !== run.runId), runRef],
    lastUpdatedAt: nowIso(),
    source: 'run_add',
  });
}

export function normalizeCapsuleProjection(capsule: StoryCapsuleData): StoryCapsuleData {
  return {
    ...capsule,
    summary: truncateField(capsule.summary, CAPSULE_LIMITS.maxSummaryChars),
    nextAction: truncateField(capsule.nextAction, CAPSULE_LIMITS.maxNextActionChars),
    openBlockers: tail(capsule.openBlockers, CAPSULE_LIMITS.maxOpenBlockers)
      .map(blocker => truncateField(blocker, CAPSULE_LIMITS.maxBlockerChars)),
    evidenceRefs: tail(capsule.evidenceRefs, CAPSULE_LIMITS.maxEvidenceRefs),
    processEventRefs: tail(capsule.processEventRefs, CAPSULE_LIMITS.maxProcessEventRefs),
    runRefs: tail(capsule.runRefs, CAPSULE_LIMITS.maxRunRefs),
  };
}

export function truncateTranscript(input: string | undefined, maxChars = CAPSULE_LIMITS.maxTranscriptChars): string {
  const text = (input ?? '').trim();
  if (!text) return 'No transcript excerpt provided.\n';
  if (text.length <= maxChars) return text.endsWith('\n') ? text : `${text}\n`;
  return `${text.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} chars omitted]\n`;
}

export function renderCapsuleBrief(capsule: StoryCapsuleData, issues: CapsuleValidationIssue[] = []): string[] {
  const lines: string[] = [];
  lines.push('## Current Story Capsule');
  lines.push(`  Story: ${capsule.storyId}`);
  lines.push(`  Phase: ${capsule.phase}`);
  if (capsule.currentChecklistId) lines.push(`  Current checklist: ${capsule.currentChecklistId}`);
  if (capsule.activeRunId) lines.push(`  Last run: ${capsule.activeRunId}`);
  lines.push(`  Next action: ${capsule.nextAction || '(none)'}`);
  if (capsule.openBlockers.length > 0) lines.push(`  Open blockers: ${capsule.openBlockers.length}`);
  lines.push(`  Runs: ${capsule.runRefs.length}/${CAPSULE_LIMITS.maxRunRefs}`);
  lines.push(`  Evidence refs: ${capsule.evidenceRefs.length}/${CAPSULE_LIMITS.maxEvidenceRefs}`);
  lines.push(`  Process-event refs: ${capsule.processEventRefs.length}/${CAPSULE_LIMITS.maxProcessEventRefs}`);
  if (issues.length > 0) {
    const errors = issues.filter(i => i.severity === 'error').length;
    const warnings = issues.length - errors;
    lines.push(`  Ref health: ${errors} errors, ${warnings} warnings`);
  } else {
    lines.push('  Ref health: ok');
  }
  return lines;
}

export function renderHandoffMarkdown(capsule: StoryCapsuleData, notes?: string): string {
  return [
    `# Handoff: ${capsule.storyId}`,
    '',
    `- Phase: ${capsule.phase}`,
    `- Current checklist: ${capsule.currentChecklistId ?? '(none)'}`,
    `- Active run: ${capsule.activeRunId ?? '(none)'}`,
    `- Next action: ${capsule.nextAction || '(none)'}`,
    `- Open blockers: ${capsule.openBlockers.length > 0 ? capsule.openBlockers.join('; ') : 'none'}`,
    `- Evidence refs: ${capsule.evidenceRefs.length}`,
    `- Process-event refs: ${capsule.processEventRefs.length}`,
    '',
    '## Notes',
    '',
    notes?.trim() || 'No additional handoff notes.',
    '',
  ].join('\n');
}

export function validateCapsuleRefs(input: ValidateCapsuleRefsInput): CapsuleValidationIssue[] {
  const issues: CapsuleValidationIssue[] = [];
  if (input.capsule.authority !== 'projection') {
    issues.push({ severity: 'error', refKind: 'capsule', ref: input.capsule, message: `capsule authority must be projection, got: ${input.capsule.authority}` });
  }
  if (input.capsule.summary.length > CAPSULE_LIMITS.maxSummaryChars) {
    issues.push({ severity: 'error', refKind: 'capsule', ref: input.capsule, message: `capsule summary exceeds ${CAPSULE_LIMITS.maxSummaryChars} chars` });
  }
  if (input.capsule.nextAction.length > CAPSULE_LIMITS.maxNextActionChars) {
    issues.push({ severity: 'error', refKind: 'capsule', ref: input.capsule, message: `capsule nextAction exceeds ${CAPSULE_LIMITS.maxNextActionChars} chars` });
  }
  if (input.capsule.runRefs.length > CAPSULE_LIMITS.maxRunRefs) {
    issues.push({ severity: 'error', refKind: 'capsule', ref: input.capsule, message: `capsule runRefs exceeds ${CAPSULE_LIMITS.maxRunRefs}; keep full history in process-events/evidence, not capsule` });
  }
  if (input.capsule.evidenceRefs.length > CAPSULE_LIMITS.maxEvidenceRefs) {
    issues.push({ severity: 'error', refKind: 'capsule', ref: input.capsule, message: `capsule evidenceRefs exceeds ${CAPSULE_LIMITS.maxEvidenceRefs}; reference only current handoff evidence` });
  }
  if (input.capsule.processEventRefs.length > CAPSULE_LIMITS.maxProcessEventRefs) {
    issues.push({ severity: 'error', refKind: 'capsule', ref: input.capsule, message: `capsule processEventRefs exceeds ${CAPSULE_LIMITS.maxProcessEventRefs}; process-events.jsonl remains the full ledger` });
  }

  const evidenceIntentRefs = new Set<string>();
  for (const item of input.checklist?.items ?? []) {
    for (const evidence of item.verificationEvidence ?? []) {
      evidenceIntentRefs.add(evidence.intentRef);
    }
  }

  for (const ref of input.capsule.evidenceRefs) {
    if (ref.authority === 'authoritative' && ref.path && pathLooksLikeCapsule(ref.path)) {
      issues.push({ severity: 'error', refKind: 'evidence', ref, message: `capsule evidence path cannot be authoritative: ${ref.path}` });
    }
    if (ref.intentRef && !evidenceIntentRefs.has(ref.intentRef)) {
      issues.push({ severity: 'error', refKind: 'evidence', ref, message: `missing verificationEvidence intentRef: ${ref.intentRef}` });
    }
    if (ref.path && !pathExists(input.projectRoot, input.storyDir, ref.path)) {
      issues.push({ severity: 'error', refKind: 'evidence', ref, message: `missing evidence path: ${ref.path}` });
    }
    if (typeof ref.processEventLine === 'number' && (ref.processEventLine < 1 || ref.processEventLine > (input.processEvents ?? []).length)) {
      issues.push({ severity: 'error', refKind: 'evidence', ref, message: `missing evidence process-event line: ${ref.processEventLine}` });
    }
  }

  const events = input.processEvents ?? [];
  for (const ref of input.capsule.processEventRefs) {
    const eventAtLine = typeof ref.line === 'number' ? events[ref.line - 1] : undefined;
    if (typeof ref.line === 'number' && !eventAtLine) {
      issues.push({ severity: 'error', refKind: 'process-event', ref, message: `missing process-event line: ${ref.line}` });
    }
    if (eventAtLine && ref.type && eventAtLine.type !== ref.type) {
      issues.push({ severity: 'error', refKind: 'process-event', ref, message: `process-event line ${ref.line} type mismatch: expected ${ref.type}, got ${eventAtLine.type}` });
    }
    if (ref.type && !events.some(event => event.type === ref.type)) {
      issues.push({ severity: 'error', refKind: 'process-event', ref, message: `missing process-event type: ${ref.type}` });
    }
  }
  return issues;
}

function tail<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return [...items];
  return items.slice(items.length - limit);
}

function truncateField(input: string, maxChars: number): string {
  const text = (input ?? '').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 15)).trimEnd()} [truncated]`;
}

function defaultNextAction(story: StoryInfo, checklistId: string | null): string {
  if (checklistId) return `Continue ${checklistId} in ${story.phase}`;
  return `Continue story ${story.storyId} in ${story.phase}`;
}

function lastProcessEventRefs(events: ProcessEvent[], limit: number): CapsuleProcessEventRef[] {
  const start = Math.max(0, events.length - limit);
  return events.slice(start).map((event, idx) => ({
    line: start + idx + 1,
    type: event.type,
  }));
}

function pathExists(projectRoot: string, storyDir: string, refPath: string): boolean {
  if (isAbsolute(refPath)) return existsSync(refPath);
  return existsSync(join(projectRoot, refPath)) || existsSync(join(storyDir, refPath));
}

function pathLooksLikeCapsule(refPath: string): boolean {
  return refPath === CAPSULE_DIR_NAME
    || refPath.startsWith(`${CAPSULE_DIR_NAME}/`)
    || refPath.includes(`/${CAPSULE_DIR_NAME}/`);
}
