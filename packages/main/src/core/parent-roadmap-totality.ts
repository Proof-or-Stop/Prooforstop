/**
 * Parent-roadmap intent-totality evaluator.
 *
 * This is a strict local model. It does not call or emulate any server-backed
 * completion service, and it never trusts caller-provided rollup conclusions.
 */

export const PARENT_ROADMAP_LEDGER_SCHEMA_VERSION = 'parent_roadmap.ledger.v1';
export const PARENT_ROLLUP_SCHEMA_VERSION = 'parent_roadmap.rollup.v1';

export const PARENT_ROADMAP_STATUS_VALUES = [
  'parent-governed',
  'child-story-needed',
  'child-story-active',
  'closed-by-implementation',
  'closed-by-existing-evidence',
  'deferred-with-human-approval',
  'blocked',
  'not-applicable',
  'invalid',
] as const;

export type ParentRoadmapRowStatus = typeof PARENT_ROADMAP_STATUS_VALUES[number];
export type ParentRoadmapSummaryClass =
  | 'full_roadmap_complete'
  | 'partial_parent_done'
  | 'blocked_parent'
  | 'invalid_parent_rollup'
  | 'stale_parent_rollup'
  | 'migration_needed';
export type ParentRoadmapClaimType =
  | 'full-roadmap-claim'
  | 'parent-governance-claim'
  | 'no-full-roadmap-claim'
  | 'blocked-claim';
export type ParentRoadmapEvidenceState = 'fresh' | 'stale' | 'missing' | 'not-required' | 'invalid';

export interface ParentRoadmapEvidenceRef {
  kind: string;
  ref: string;
  result?: string;
  command?: string;
  artifactRef?: string;
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
  stale?: boolean;
  observedAt?: string;
}

export interface ParentRoadmapDeferral {
  approvedBy: string;
  approvedAt: string;
  reason: string;
  revisitTrigger?: string;
  expiresAt?: string;
  nonRuntimeBehaviorStatement: string;
}

export interface ParentRoadmapNotApplicableDecision {
  reason: string;
  decidedBy: string;
  decidedAt: string;
}

export interface ParentRoadmapRow {
  rowId: string;
  title: string;
  intentText: string;
  status: ParentRoadmapRowStatus;
  childStoryId?: string;
  closureEvidence: ParentRoadmapEvidenceRef[];
  materialRefs: string[];
  updatedAt?: string;
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
  claimBoundary?: string;
  blocker?: string;
  deferral?: ParentRoadmapDeferral;
  notApplicableDecision?: ParentRoadmapNotApplicableDecision;
  stale?: boolean;
}

export interface ParentRoadmapLedger {
  schemaVersion?: string;
  ledgerId: string;
  parentStoryId: string;
  originalIntentSnapshot: string;
  sourceRefs: string[];
  requiredRowIds?: string[];
  rows: ParentRoadmapRow[];
  createdByStoryId: string;
  updatedByStoryIds: string[];
  proofstoryContract?: unknown;
  parentLedgerRollup?: unknown;
  migration?: {
    sourceStoryId?: string;
    reason?: string;
  };
}

export interface ParentRowRollupResult {
  rowId: string;
  title: string;
  status: string;
  closed: boolean;
  evidenceState: ParentRoadmapEvidenceState;
  reasonCodes: string[];
  reasons: string[];
  nextActions: string[];
  claimBoundary?: string;
}

export interface ParentRollupResult {
  schemaVersion: typeof PARENT_ROLLUP_SCHEMA_VERSION;
  ledgerId: string;
  parentStoryId: string;
  allRowsClosed: boolean;
  openRows: string[];
  blockedRows: string[];
  invalidRows: string[];
  deferredRows: string[];
  staleEvidenceRows: string[];
  migrationRows: string[];
  summaryClass: ParentRoadmapSummaryClass;
  claimType: ParentRoadmapClaimType;
  allowedSummaryText: string;
  blockedSummaryText: string;
  nextActions: string[];
  rowResults: ParentRowRollupResult[];
  evaluatedAt: string;
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
}

export interface ParentRoadmapEvaluationOptions {
  evaluatedAt?: string;
  currentHeadHash?: string;
  currentMaterialHash?: string;
  currentStoryFilesHash?: string;
  requiredRowIds?: string[];
}

export interface ParentRoadmapClaimDecision {
  allowed: boolean;
  blocking: boolean;
  mode: 'observe' | 'warn' | 'enforce';
  claimDetected: 'full-roadmap' | 'partial-parent' | 'none';
  reasons: string[];
  nextActions: string[];
  allowedSummaryText: string;
  blockedSummaryText: string;
}

export interface ParentRoadmapProofStoryBindingReport {
  schemaVersion: 'parent_roadmap.proofstory_binding.v1';
  ledgerId: string;
  parentStoryId: string;
  mode: 'observe' | 'warn' | 'enforce';
  status: 'pass' | 'warn' | 'fail';
  blocking: boolean;
  checkedAt: string;
  consumedRollup: Pick<ParentRollupResult, 'summaryClass' | 'claimType' | 'allRowsClosed' | 'openRows' | 'blockedRows' | 'invalidRows' | 'staleEvidenceRows'>;
  gaps: Array<{ code: string; severity: 'info' | 'warn' | 'fail'; artifact: string; message: string }>;
}

const STATUS_SET = new Set<string>(PARENT_ROADMAP_STATUS_VALUES);
const CLOSED_STATUSES = new Set<ParentRoadmapRowStatus>([
  'closed-by-implementation',
  'closed-by-existing-evidence',
  'deferred-with-human-approval',
  'not-applicable',
]);
const B43DE_M4_M12_ROW_IDS = Array.from({ length: 9 }, (_, index) => `M${index + 4}`);
const B43DE_CLOSED_ROW_DATA: Array<{
  rowId: string;
  title: string;
  intentText: string;
  commands: string[];
  materialRefs: string[];
  claimBoundary: string;
}> = [
  {
    rowId: 'M4',
    title: 'Process fact registry coverage',
    intentText: 'Every roadmap gate-consumed process fact is covered by the registry contract verifier before it can be consumed by lifecycle gates.',
    commands: ['node scripts/verify-process-fact-contract.mjs'],
    materialRefs: [
      'packages/main/src/core/process-fact-registry.ts',
      'packages/main/src/core/process-fact-levels.ts',
      'scripts/verify-process-fact-contract.mjs',
    ],
    claimBoundary: 'Local process-fact registry and static verifier coverage for gate-consumed Proofbound CLI facts.',
  },
  {
    rowId: 'M5',
    title: 'Verification context pack and evidence envelope standardization',
    intentText: 'Context packs and evidence envelopes bind reviewer and validator evidence to required refs, commands, and digest-backed material context.',
    commands: ['node packages/main/dist/tasks/verification-context-pack-smoke.js'],
    materialRefs: [
      'docs/requirements/decisions/verification-context-pack.md',
      'packages/main/src/tasks/verification-context-pack-smoke.ts',
    ],
    claimBoundary: 'Local verification-context and evidence-envelope behavior proven by the focused smoke.',
  },
  {
    rowId: 'M6',
    title: 'Gate oracle, freshness, and negative-control matrix',
    intentText: 'Lifecycle and review gate paths expose explicit positive and negative-control outcomes instead of trusting prose conclusions.',
    commands: [
      'node packages/main/dist/tasks/lifecycle-orchestrate-smoke.js',
      'node packages/main/dist/tasks/review-escalation-smoke.js',
    ],
    materialRefs: [
      'packages/main/src/tasks/lifecycle-orchestrate-smoke.ts',
      'packages/main/src/tasks/review-escalation-smoke.ts',
    ],
    claimBoundary: 'Local lifecycle/review oracle behavior and expected-block coverage only.',
  },
  {
    rowId: 'M7',
    title: 'Baseline suite formalization',
    intentText: 'Baseline suites and reports carry structured outcome math, minimum evidence checks, and false-DONE protections.',
    commands: [
      'node packages/main/dist/tasks/baseline-suite-smoke.js',
      'node packages/main/dist/tasks/baseline-suite-report-smoke.js',
    ],
    materialRefs: [
      'packages/main/src/tasks/baseline-suite-smoke.ts',
      'packages/main/src/tasks/baseline-suite-report-smoke.ts',
    ],
    claimBoundary: 'Local baseline-suite/report contract evidence; no formal capability unlock is implied.',
  },
  {
    rowId: 'M8',
    title: 'Host identity, review-run, and quorum strengthening',
    intentText: 'Reviewer quorum, signed review submission, and review escalation predicates bind host/verdict evidence before high-assurance claims.',
    commands: [
      'node packages/main/dist/tasks/reviewer-quorum-smoke.js',
      'node packages/main/dist/tasks/quorum-submit-smoke.js',
      'node packages/main/dist/tasks/review-escalation-smoke.js',
    ],
    materialRefs: [
      'packages/main/src/tasks/reviewer-quorum-smoke.ts',
      'packages/main/src/tasks/quorum-submit-smoke.ts',
      'packages/main/src/tasks/review-escalation-smoke.ts',
    ],
    claimBoundary: 'Local reviewer quorum and escalation predicates, including degraded/fail-closed handling.',
  },
  {
    rowId: 'M9',
    title: 'Preflight command center',
    intentText: 'Lifecycle orchestration renders canonical preflight/gate rows from registered facts without inventing renderer-only rules.',
    commands: ['node packages/main/dist/tasks/lifecycle-orchestrate-smoke.js'],
    materialRefs: [
      'packages/main/src/tasks/lifecycle-orchestrate-smoke.ts',
      'packages/main/src/handlers/lifecycle-orchestrate.ts',
    ],
    claimBoundary: 'Local lifecycle orchestration projection and preflight row composition.',
  },
  {
    rowId: 'M10',
    title: 'Parallel collaboration scheduling',
    intentText: 'Parallel-wave planning remains read-only/advisory while exposing owner-lease, dependency, hotspot, and merge-queue scheduling facts.',
    commands: ['node packages/main/dist/tasks/lattice-parallel-wave-smoke.js'],
    materialRefs: [
      'docs/requirements/decisions/lattice-parallel-wave.md',
      'packages/main/src/tasks/lattice-parallel-wave-smoke.ts',
    ],
    claimBoundary: 'Read-only local parallel-wave scheduling evidence; advisory output is not lifecycle completion evidence.',
  },
  {
    rowId: 'M11',
    title: 'Rollout, migration, and operator guidance',
    intentText: 'Rollout checks expose staged policy, compatibility, and operator remediation rows for strengthening controls.',
    commands: ['node packages/main/dist/tasks/rollout-check-smoke.js'],
    materialRefs: [
      'packages/main/src/core/rollout-check.ts',
      'packages/main/src/tasks/rollout-check-smoke.ts',
    ],
    claimBoundary: 'Local rollout-check policy and operator guidance evidence.',
  },
  {
    rowId: 'M12',
    title: 'Cross-track certification and handoff',
    intentText: 'The parent roadmap rollup and handoff evidence prove every M4-M12 row is represented, closed, and bounded.',
    commands: [
      'node packages/main/dist/tasks/parent-roadmap-totality-smoke.js',
      'node packages/main/dist/tasks/lattice-handoff-smoke.js',
    ],
    materialRefs: [
      'packages/main/src/tasks/parent-roadmap-totality-smoke.ts',
      'packages/main/src/tasks/lattice-handoff-smoke.ts',
      'docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md',
    ],
    claimBoundary: 'Local parent-roadmap totality and handoff closure evidence for M4-M12.',
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function requireTopString(obj: Record<string, unknown>, field: string): string {
  const value = nonEmptyString(obj[field]);
  if (!value) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    const normalized = nonEmptyString(entry);
    if (!normalized) throw new Error(`${field}[${index}] must be a non-empty string`);
    return normalized;
  });
}

function evidenceArray(value: unknown): ParentRoadmapEvidenceRef[] {
  if (value == null) return [];
  if (!Array.isArray(value)) return [];
  const out: ParentRoadmapEvidenceRef[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) continue;
    const kind = nonEmptyString(raw.kind) ?? 'evidence';
    const ref = nonEmptyString(raw.ref) ?? nonEmptyString(raw.artifactRef) ?? `closureEvidence[${index}]`;
    out.push({
      kind,
      ref,
      result: nonEmptyString(raw.result) ?? undefined,
      command: nonEmptyString(raw.command) ?? undefined,
      artifactRef: nonEmptyString(raw.artifactRef) ?? undefined,
      headHash: nonEmptyString(raw.headHash) ?? undefined,
      materialHash: nonEmptyString(raw.materialHash) ?? undefined,
      storyFilesHash: nonEmptyString(raw.storyFilesHash) ?? undefined,
      stale: raw.stale === true,
      observedAt: nonEmptyString(raw.observedAt) ?? undefined,
    });
  }
  return out;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function normalizeDeferral(value: unknown): ParentRoadmapDeferral | undefined {
  const obj = optionalRecord(value);
  if (!obj) return undefined;
  return {
    approvedBy: nonEmptyString(obj.approvedBy) ?? '',
    approvedAt: nonEmptyString(obj.approvedAt) ?? '',
    reason: nonEmptyString(obj.reason) ?? '',
    revisitTrigger: nonEmptyString(obj.revisitTrigger) ?? undefined,
    expiresAt: nonEmptyString(obj.expiresAt) ?? undefined,
    nonRuntimeBehaviorStatement: nonEmptyString(obj.nonRuntimeBehaviorStatement) ?? '',
  };
}

function normalizeNotApplicableDecision(value: unknown): ParentRoadmapNotApplicableDecision | undefined {
  const obj = optionalRecord(value);
  if (!obj) return undefined;
  return {
    reason: nonEmptyString(obj.reason) ?? '',
    decidedBy: nonEmptyString(obj.decidedBy) ?? '',
    decidedAt: nonEmptyString(obj.decidedAt) ?? '',
  };
}

function normalizeRow(raw: unknown, index: number): ParentRoadmapRow | { invalidRowId: string; reasons: string[] } {
  if (!isRecord(raw)) {
    return { invalidRowId: `row-${index + 1}`, reasons: [`rows[${index}] must be an object`] };
  }
  const rowId = nonEmptyString(raw.rowId) ?? `row-${index + 1}`;
  const reasons: string[] = [];
  const title = nonEmptyString(raw.title);
  const intentText = nonEmptyString(raw.intentText);
  const status = nonEmptyString(raw.status);
  if (!nonEmptyString(raw.rowId)) reasons.push('rowId must be a non-empty string');
  if (!title) reasons.push('title must be a non-empty string');
  if (!intentText) reasons.push('intentText must be a non-empty string');
  if (!status || !STATUS_SET.has(status)) reasons.push(`status must be one of: ${PARENT_ROADMAP_STATUS_VALUES.join(', ')}`);
  if (reasons.length > 0) return { invalidRowId: rowId, reasons };
  return {
    rowId,
    title: title!,
    intentText: intentText!,
    status: status as ParentRoadmapRowStatus,
    childStoryId: nonEmptyString(raw.childStoryId) ?? undefined,
    closureEvidence: evidenceArray(raw.closureEvidence),
    materialRefs: Array.isArray(raw.materialRefs) ? stringArray(raw.materialRefs, `rows[${index}].materialRefs`) : [],
    updatedAt: nonEmptyString(raw.updatedAt) ?? undefined,
    headHash: nonEmptyString(raw.headHash) ?? undefined,
    materialHash: nonEmptyString(raw.materialHash) ?? undefined,
    storyFilesHash: nonEmptyString(raw.storyFilesHash) ?? undefined,
    claimBoundary: nonEmptyString(raw.claimBoundary) ?? undefined,
    blocker: nonEmptyString(raw.blocker) ?? undefined,
    deferral: normalizeDeferral(raw.deferral),
    notApplicableDecision: normalizeNotApplicableDecision(raw.notApplicableDecision),
    stale: raw.stale === true,
  };
}

export function parseParentRoadmapLedger(raw: unknown): ParentRoadmapLedger {
  if (!isRecord(raw)) throw new Error('ParentRoadmapLedger must be an object');
  if (!Array.isArray(raw.rows)) throw new Error('rows must be an array');
  const rows: ParentRoadmapRow[] = [];
  const invalidRows: ParentRoadmapRow[] = [];
  raw.rows.forEach((entry, index) => {
    const normalized = normalizeRow(entry, index);
    if ('invalidRowId' in normalized) {
      invalidRows.push({
        rowId: normalized.invalidRowId,
        title: normalized.invalidRowId,
        intentText: normalized.reasons.join('; '),
        status: 'invalid',
        closureEvidence: [],
        materialRefs: [],
        claimBoundary: 'invalid row shape',
      });
    } else {
      rows.push(normalized);
    }
  });
  return {
    schemaVersion: nonEmptyString(raw.schemaVersion) ?? undefined,
    ledgerId: requireTopString(raw, 'ledgerId'),
    parentStoryId: requireTopString(raw, 'parentStoryId'),
    originalIntentSnapshot: requireTopString(raw, 'originalIntentSnapshot'),
    sourceRefs: stringArray(raw.sourceRefs, 'sourceRefs'),
    requiredRowIds: stringArray(raw.requiredRowIds, 'requiredRowIds'),
    rows: [...rows, ...invalidRows],
    createdByStoryId: requireTopString(raw, 'createdByStoryId'),
    updatedByStoryIds: stringArray(raw.updatedByStoryIds, 'updatedByStoryIds'),
    proofstoryContract: raw.proofstoryContract,
    parentLedgerRollup: raw.parentLedgerRollup,
    migration: optionalRecord(raw.migration) ? {
      sourceStoryId: nonEmptyString((raw.migration as Record<string, unknown>).sourceStoryId) ?? undefined,
      reason: nonEmptyString((raw.migration as Record<string, unknown>).reason) ?? undefined,
    } : undefined,
  };
}

function push(reasons: string[], codes: string[], code: string, message: string): void {
  codes.push(code);
  reasons.push(message);
}

function evidenceIsStale(row: ParentRoadmapRow, options: ParentRoadmapEvaluationOptions): boolean {
  if (row.stale) return true;
  if (row.closureEvidence.some((entry) => entry.stale)) return true;
  if (options.currentHeadHash && row.headHash && row.headHash !== options.currentHeadHash) return true;
  if (options.currentMaterialHash && row.materialHash && row.materialHash !== options.currentMaterialHash) return true;
  if (options.currentStoryFilesHash && row.storyFilesHash && row.storyFilesHash !== options.currentStoryFilesHash) return true;
  return false;
}

function validDeferral(row: ParentRoadmapRow, reasons: string[], codes: string[]): boolean {
  const deferral = row.deferral;
  if (!deferral) {
    push(reasons, codes, 'missing_human_deferral', `${row.rowId} is deferred but has no human approval record.`);
    return false;
  }
  let ok = true;
  if (!deferral.approvedBy || !deferral.approvedAt) {
    push(reasons, codes, 'missing_human_approval', `${row.rowId} deferral needs approvedBy and approvedAt.`);
    ok = false;
  }
  if (!deferral.reason) {
    push(reasons, codes, 'missing_deferral_reason', `${row.rowId} deferral needs a scope reason.`);
    ok = false;
  }
  if (!deferral.revisitTrigger && !deferral.expiresAt) {
    push(reasons, codes, 'missing_revisit_condition', `${row.rowId} deferral needs a revisit trigger or expiry.`);
    ok = false;
  }
  if (!/not\s+(?:implemented\s+)?runtime\s+behaviou?r|does\s+not\s+implement\s+runtime/i.test(deferral.nonRuntimeBehaviorStatement)) {
    push(reasons, codes, 'missing_non_runtime_statement', `${row.rowId} deferral must state it is not implemented runtime behavior.`);
    ok = false;
  }
  return ok;
}

function validNotApplicable(row: ParentRoadmapRow, reasons: string[], codes: string[]): boolean {
  const decision = row.notApplicableDecision;
  if (!decision) {
    push(reasons, codes, 'missing_not_applicable_decision', `${row.rowId} needs an auditable not-applicable decision.`);
    return false;
  }
  const ok = !!decision.reason && !!decision.decidedBy && !!decision.decidedAt;
  if (!ok) {
    push(reasons, codes, 'invalid_not_applicable_decision', `${row.rowId} not-applicable decision needs reason, decidedBy, and decidedAt.`);
  }
  return ok;
}

function evaluateRow(row: ParentRoadmapRow, options: ParentRoadmapEvaluationOptions): ParentRowRollupResult {
  const reasons: string[] = [];
  const reasonCodes: string[] = [];
  const nextActions: string[] = [];
  let evidenceState: ParentRoadmapEvidenceState = 'not-required';
  let closed = false;

  if (row.status === 'invalid') {
    push(reasons, reasonCodes, 'invalid_row', `${row.rowId} is explicitly invalid or failed shape validation.`);
    evidenceState = 'invalid';
  } else if (row.status === 'parent-governed') {
    push(reasons, reasonCodes, 'parent_governance_only', `${row.rowId} is preserved by parent governance but not closed as runtime roadmap work.`);
    nextActions.push(`Assign or close child implementation evidence for ${row.rowId}.`);
  } else if (row.status === 'child-story-needed') {
    push(reasons, reasonCodes, row.childStoryId ? 'child_story_needed' : 'missing_child_story', `${row.rowId} still needs child implementation work${row.childStoryId ? ` in ${row.childStoryId}` : ' and has no child story assigned'}.`);
    nextActions.push(`Create or assign a child story for ${row.rowId}, then attach closure evidence.`);
  } else if (row.status === 'child-story-active') {
    push(reasons, reasonCodes, 'child_story_active', `${row.rowId} is assigned to an active child story${row.childStoryId ? ` ${row.childStoryId}` : ''}.`);
    if (!row.childStoryId) push(reasons, reasonCodes, 'missing_child_story', `${row.rowId} active child row needs childStoryId.`);
    nextActions.push(`Finish the active child story for ${row.rowId} and refresh parent rollup evidence.`);
  } else if (row.status === 'blocked') {
    push(reasons, reasonCodes, 'blocked', `${row.rowId} is blocked${row.blocker ? `: ${row.blocker}` : '.'}`);
    if (!row.childStoryId) push(reasons, reasonCodes, 'missing_child_story', `${row.rowId} blocked row needs childStoryId when child work exists.`);
    nextActions.push(`Resolve blocker for ${row.rowId}${row.blocker ? `: ${row.blocker}` : ''}.`);
  } else if (row.status === 'deferred-with-human-approval') {
    if (validDeferral(row, reasons, reasonCodes)) {
      closed = true;
      evidenceState = 'fresh';
      reasons.push(`${row.rowId} is closed by explicit human-approved deferral, not runtime implementation.`);
    } else {
      evidenceState = 'invalid';
      nextActions.push(`Repair ${row.rowId} deferral with human approval, reason, revisit condition, and non-runtime statement.`);
    }
  } else if (row.status === 'not-applicable') {
    if (validNotApplicable(row, reasons, reasonCodes)) {
      closed = true;
      evidenceState = 'fresh';
      reasons.push(`${row.rowId} is closed as not applicable by audited decision.`);
    } else {
      evidenceState = 'invalid';
      nextActions.push(`Repair ${row.rowId} not-applicable decision evidence.`);
    }
  } else if (row.status === 'closed-by-implementation' || row.status === 'closed-by-existing-evidence') {
    if (row.closureEvidence.length === 0) {
      evidenceState = 'missing';
      push(reasons, reasonCodes, 'missing_closure_evidence', `${row.rowId} is marked ${row.status} but has no closureEvidence.`);
      nextActions.push(`Attach closure evidence for ${row.rowId}.`);
    } else if (evidenceIsStale(row, options)) {
      evidenceState = 'stale';
      push(reasons, reasonCodes, 'stale_closure_evidence', `${row.rowId} closure evidence is stale against the current material binding.`);
      nextActions.push(`Refresh closure evidence for ${row.rowId} at current HEAD/material/story-files hash.`);
    } else {
      closed = true;
      evidenceState = 'fresh';
      reasons.push(`${row.rowId} is closed by ${row.status === 'closed-by-implementation' ? 'implementation' : 'existing'} evidence.`);
    }
  }

  if (!closed && CLOSED_STATUSES.has(row.status) && evidenceState === 'not-required') evidenceState = 'invalid';
  return {
    rowId: row.rowId,
    title: row.title,
    status: row.status,
    closed,
    evidenceState,
    reasonCodes,
    reasons,
    nextActions,
    claimBoundary: row.claimBoundary,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function acceptanceBindingMilestoneIds(value: unknown): string[] {
  const contract = optionalRecord(value);
  const bindings = Array.isArray(contract?.acceptanceBindings) ? contract.acceptanceBindings : [];
  const ids: string[] = [];
  for (const binding of bindings) {
    const obj = optionalRecord(binding);
    if (!obj || !Array.isArray(obj.milestoneIds)) continue;
    for (const id of obj.milestoneIds) {
      const normalized = nonEmptyString(id);
      if (normalized) ids.push(normalized);
    }
  }
  return unique(ids);
}

function requiredInventoryRowIds(ledger: ParentRoadmapLedger, options: ParentRoadmapEvaluationOptions = {}): string[] {
  const optionRequiredRowIds = options.requiredRowIds == null ? [] : stringArray(options.requiredRowIds, 'options.requiredRowIds');
  return unique([
    ...(ledger.requiredRowIds ?? []),
    ...acceptanceBindingMilestoneIds(ledger.proofstoryContract),
    ...optionRequiredRowIds,
  ]);
}

function missingRequiredRowResult(rowId: string): ParentRowRollupResult {
  return {
    rowId,
    title: rowId,
    status: 'missing-required-row',
    closed: false,
    evidenceState: 'invalid',
    reasonCodes: ['missing_required_row'],
    reasons: [`${rowId} is declared in requiredRowIds/proofstoryContract inventory but missing from ledger.rows.`],
    nextActions: [`Add ${rowId} to ledger.rows or record an explicit scope-shrinkage decision before claiming full roadmap completion.`],
  };
}

function appendMissingRequiredRows(
  ledger: ParentRoadmapLedger,
  rowResults: ParentRowRollupResult[],
  options: ParentRoadmapEvaluationOptions,
): ParentRowRollupResult[] {
  const presentRows = new Set(rowResults.map((row) => row.rowId));
  const missingRows = requiredInventoryRowIds(ledger, options)
    .filter((rowId) => !presentRows.has(rowId))
    .map((rowId) => missingRequiredRowResult(rowId));
  return missingRows.length > 0 ? [...rowResults, ...missingRows] : rowResults;
}

function isMigrationLedger(ledger: ParentRoadmapLedger, rowResults: readonly ParentRowRollupResult[]): boolean {
  if (ledger.migration) return true;
  if (ledger.schemaVersion && ledger.schemaVersion !== PARENT_ROADMAP_LEDGER_SCHEMA_VERSION) return true;
  if (ledger.parentStoryId === 'B-43de' && rowResults.some((row) => /^M(?:[4-9]|1[0-2])$/.test(row.rowId) && !row.closed)) return true;
  return false;
}

function summarize(
  ledger: ParentRoadmapLedger,
  rowResults: ParentRowRollupResult[],
): Pick<ParentRollupResult, 'summaryClass' | 'claimType' | 'allowedSummaryText' | 'blockedSummaryText' | 'nextActions'> {
  const invalidRows = rowResults.filter((row) => row.evidenceState === 'invalid' || row.reasonCodes.some((code) => code.startsWith('invalid_') || code === 'invalid_row'));
  const staleRows = rowResults.filter((row) => row.evidenceState === 'stale');
  const blockedRows = rowResults.filter((row) => row.reasonCodes.includes('blocked'));
  const migration = isMigrationLedger(ledger, rowResults);
  const allRowsClosed = rowResults.length > 0 && rowResults.every((row) => row.closed);
  let summaryClass: ParentRoadmapSummaryClass;
  if (rowResults.length === 0 || invalidRows.length > 0) summaryClass = 'invalid_parent_rollup';
  else if (staleRows.length > 0) summaryClass = 'stale_parent_rollup';
  else if (blockedRows.length > 0) summaryClass = 'blocked_parent';
  else if (migration) summaryClass = 'migration_needed';
  else if (allRowsClosed) summaryClass = 'full_roadmap_complete';
  else summaryClass = 'partial_parent_done';

  const claimType: ParentRoadmapClaimType = summaryClass === 'full_roadmap_complete'
    ? 'full-roadmap-claim'
    : summaryClass === 'blocked_parent'
      ? 'blocked-claim'
      : 'no-full-roadmap-claim';

  const openRows = rowResults.filter((row) => !row.closed).map((row) => row.rowId);
  const allowedSummaryText = summaryClass === 'full_roadmap_complete'
    ? 'Full roadmap complete.'
    : summaryClass === 'blocked_parent'
      ? `Parent roadmap blocked. Blocked rows: ${blockedRows.map((row) => row.rowId).join(', ')}.`
      : summaryClass === 'invalid_parent_rollup'
        ? `Parent roadmap has invalid closure evidence. Invalid rows: ${invalidRows.map((row) => row.rowId).join(', ') || 'unknown'}.`
        : summaryClass === 'stale_parent_rollup'
          ? `Parent roadmap has stale closure evidence. Refresh rows: ${staleRows.map((row) => row.rowId).join(', ')}.`
          : summaryClass === 'migration_needed'
            ? `Parent governance complete; roadmap not complete. Migration needed for rows: ${openRows.join(', ') || 'unknown'}.`
            : `Parent governance complete; roadmap not complete. Open rows: ${openRows.join(', ') || 'unknown'}.`;

  const blockedSummaryText = summaryClass === 'full_roadmap_complete'
    ? 'No full-roadmap wording is blocked by this rollup.'
    : `Do not say the full roadmap is complete. ${allowedSummaryText}`;

  const nextActions = unique([
    ...rowResults.flatMap((row) => row.nextActions),
    ...(summaryClass === 'migration_needed'
      ? [`Migrate ${ledger.parentStoryId} parent candidate into current ParentRoadmapLedger rows, then close or defer M4-M12 with row evidence.`]
      : []),
    ...(summaryClass === 'partial_parent_done'
      ? [`Keep the larger user intent open until open row(s) are closed: ${openRows.join(', ')}.`]
      : []),
  ]);
  return { summaryClass, claimType, allowedSummaryText, blockedSummaryText, nextActions };
}

export function evaluateParentRoadmapLedger(rawLedger: unknown, options: ParentRoadmapEvaluationOptions = {}): ParentRollupResult {
  const ledger = parseParentRoadmapLedger(rawLedger);
  // Caller-provided ledger.parentLedgerRollup allRowsClosed/claimType values are audit context only; row facts below recompute the rollup.
  const rowResults = appendMissingRequiredRows(ledger, ledger.rows.map((row) => evaluateRow(row, options)), options);
  const openRows = rowResults.filter((row) => !row.closed).map((row) => row.rowId);
  const blockedRows = rowResults.filter((row) => row.reasonCodes.includes('blocked')).map((row) => row.rowId);
  const invalidRows = rowResults
    .filter((row) => row.evidenceState === 'invalid' || row.reasonCodes.some((code) => code.startsWith('invalid_') || code === 'invalid_row'))
    .map((row) => row.rowId);
  const deferredRows = ledger.rows.filter((row) => row.status === 'deferred-with-human-approval').map((row) => row.rowId);
  const staleEvidenceRows = rowResults.filter((row) => row.evidenceState === 'stale').map((row) => row.rowId);
  const migrationRows = isMigrationLedger(ledger, rowResults) ? openRows : [];
  const summary = summarize(ledger, rowResults);
  return {
    schemaVersion: PARENT_ROLLUP_SCHEMA_VERSION,
    ledgerId: ledger.ledgerId,
    parentStoryId: ledger.parentStoryId,
    allRowsClosed: rowResults.length > 0 && rowResults.every((row) => row.closed) && summary.summaryClass === 'full_roadmap_complete',
    openRows,
    blockedRows,
    invalidRows,
    deferredRows,
    staleEvidenceRows,
    migrationRows,
    ...summary,
    rowResults,
    evaluatedAt: options.evaluatedAt ?? new Date().toISOString(),
    headHash: options.currentHeadHash,
    materialHash: options.currentMaterialHash,
    storyFilesHash: options.currentStoryFilesHash,
  };
}

function normalizedText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hasFullRoadmapClaim(text: string): boolean {
  const normalized = normalizedText(text);
  const claimPatterns = [
    /\bfull[- ]roadmap\s+(?:is\s+)?(?:complete|completed|done|finished)\b/ig,
    /\bfull\b(?:\s+\S+){0,4}\s+roadmap\s+(?:is\s+)?(?:complete|completed|done|finished)\b/ig,
    /\b(?:entire|whole)\s+roadmap\s+(?:is\s+)?(?:complete|completed|done|finished)\b/ig,
    /\broadmap\s+(?:is\s+)?(?:complete|completed|done|finished)\b/ig,
    /\b(?:complete|completed|done|finished)\b.{0,80}\bfull\b.{0,40}\broadmap\b/ig,
    /\ball\s+(?:parent\s+)?roadmap\s+rows\s+(?:are\s+)?(?:closed|complete|completed|done|finished)\b/ig,
    /\ball\s+M\d+\s*[-–]\s*M\d+\s+(?:rows\s+|milestones\s+)?(?:are\s+)?(?:closed|complete|completed|done|finished)\b/ig,
    /\bM\d+\s*[-–]\s*M\d+\s+(?:are\s+)?(?:closed|complete|completed|done|finished)\b/ig,
  ];
  return claimPatterns.some((pattern) => hasPositiveClaimMatch(normalized, pattern));
}

function hasPositiveClaimMatch(text: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const matched = match[0] ?? '';
    if (!isNegatedFullRoadmapClaim(text, index, index + matched.length, matched)) return true;
  }
  return false;
}

function isNegatedFullRoadmapClaim(text: string, start: number, end: number, matched: string): boolean {
  const sentenceStart = Math.max(text.lastIndexOf('.', start - 1), text.lastIndexOf('!', start - 1), text.lastIndexOf('?', start - 1), text.lastIndexOf(';', start - 1), text.lastIndexOf('\n', start - 1));
  const sentenceEndCandidates = ['.', '!', '?', ';', '\n']
    .map((separator) => text.indexOf(separator, end))
    .filter((index) => index >= 0);
  const sentenceEnd = sentenceEndCandidates.length ? Math.min(...sentenceEndCandidates) : text.length;
  const sentence = text.slice(sentenceStart + 1, sentenceEnd);
  const beforeInSentence = text.slice(sentenceStart + 1, start);
  const noClaimMatch = /\bno\s+full[- ]roadmap\s+claim\b/i.exec(sentence);
  const noClaimBeforeMatch = noClaimMatch && noClaimMatch.index < beforeInSentence.length;
  const disclaimerToClaim = noClaimBeforeMatch
    ? sentence.slice(noClaimMatch.index + noClaimMatch[0].length, beforeInSentence.length)
    : '';
  const notClaimMatch = /\b(?:not|never)\s+(?:a\s+)?(?:full[- ]roadmap\s+)?claim\b/i.exec(beforeInSentence);
  const negationToClaim = notClaimMatch
    ? beforeInSentence.slice(notClaimMatch.index + notClaimMatch[0].length)
    : '';
  return (noClaimBeforeMatch && !/\b(?:but|however|yet|though|nevertheless|then|later|also)\b/i.test(disclaimerToClaim))
    || /\b(?:do\s+not|don't|never|cannot|can't|should\s+not|must\s+not)\s+(?:say|claim|state|assert)\b.{0,80}$/i.test(beforeInSentence)
    || (!!notClaimMatch && !/\b(?:but|however|yet|though|nevertheless|then|later|also)\b/i.test(negationToClaim))
    || /\b(?:roadmap|it)\s+(?:is\s+)?not\s+(?:complete|completed|done|finished)\b/i.test(matched);
}

function hasPartialParentDisclosure(text: string): boolean {
  const normalized = normalizedText(text);
  return /\bparent governance complete\b/i.test(normalized)
    && /\broadmap\s+(?:is\s+)?not\s+complete\b/i.test(normalized)
    && /\b(?:open|remaining|child-story-needed|child story needed|no full[- ]roadmap claim|not complete)\b/i.test(normalized);
}

function hasParentDoneClaim(text: string): boolean {
  return /\bparent\s+(?:governance\s+)?(?:complete|done|finished)\b/i.test(normalizedText(text));
}

export function evaluateParentRoadmapClaim(args: {
  rollup: ParentRollupResult | unknown;
  summaryText: string;
  mode?: 'observe' | 'warn' | 'enforce' | string;
}): ParentRoadmapClaimDecision {
  const rollup = args.rollup as ParentRollupResult;
  const mode = args.mode === 'enforce' || args.mode === 'warn' ? args.mode : 'observe';
  const summaryText = args.summaryText ?? '';
  const reasons: string[] = [];
  const nextActions: string[] = [];
  const fullClaim = hasFullRoadmapClaim(summaryText);
  const partialDisclosure = hasPartialParentDisclosure(summaryText);
  const parentDone = hasParentDoneClaim(summaryText);
  let allowed = true;
  let claimDetected: ParentRoadmapClaimDecision['claimDetected'] = fullClaim ? 'full-roadmap' : parentDone ? 'partial-parent' : 'none';

  if (fullClaim && rollup.claimType !== 'full-roadmap-claim') {
    allowed = false;
    reasons.push(`no-full-roadmap-claim: ${rollup.blockedSummaryText}`);
    if (rollup.openRows?.length) reasons.push(`Open row(s): ${rollup.openRows.join(', ')}`);
    nextActions.push(...(rollup.nextActions ?? []));
  } else if (parentDone && rollup.claimType !== 'full-roadmap-claim' && !partialDisclosure) {
    allowed = false;
    reasons.push(`Parent completion wording must disclose that the full roadmap is not complete and name open rows: ${rollup.openRows?.join(', ') || 'unknown'}.`);
    nextActions.push(`Use allowed wording: ${rollup.allowedSummaryText}`);
  }

  return {
    allowed,
    blocking: mode === 'enforce' && !allowed,
    mode,
    claimDetected,
    reasons,
    nextActions: unique(nextActions),
    allowedSummaryText: rollup.allowedSummaryText,
    blockedSummaryText: rollup.blockedSummaryText,
  };
}

function proofGap(code: string, severity: 'info' | 'warn' | 'fail', artifact: string, message: string) {
  return { code, severity, artifact, message };
}

export function evaluateParentRoadmapProofStoryBinding(args: {
  ledger: unknown;
  rollup?: ParentRollupResult | unknown;
  originalIntentSnapshot?: unknown;
  proofstoryContract?: unknown;
  summaryText?: string;
  mode?: 'observe' | 'warn' | 'enforce' | string;
}): ParentRoadmapProofStoryBindingReport {
  const ledger = parseParentRoadmapLedger(args.ledger);
  const suppliedRollup = args.rollup as ParentRollupResult | undefined;
  const externalRequiredRowIds = acceptanceBindingMilestoneIds(args.proofstoryContract);
  const rollup = evaluateParentRoadmapLedger(ledger, {
    currentHeadHash: suppliedRollup?.headHash,
    currentMaterialHash: suppliedRollup?.materialHash,
    currentStoryFilesHash: suppliedRollup?.storyFilesHash,
    requiredRowIds: externalRequiredRowIds,
  });
  const mode = args.mode === 'enforce' || args.mode === 'warn' ? args.mode : 'observe';
  const gaps: ParentRoadmapProofStoryBindingReport['gaps'] = [];
  const snapshot = optionalRecord(args.originalIntentSnapshot);
  const contract = optionalRecord(args.proofstoryContract ?? ledger.proofstoryContract);
  if (!snapshot || !nonEmptyString(snapshot.requestHash) || !nonEmptyString(snapshot.sourceText)) {
    gaps.push(proofGap(
      'missing_parent_roadmap_original_intent_snapshot',
      'fail',
      'original-intent-snapshot.json',
      'Parent-roadmap totality must bind to a ProofStory original intent snapshot with source text and request hash.',
    ));
  }
  const bindings = Array.isArray(contract?.acceptanceBindings) ? contract.acceptanceBindings : [];
  if (bindings.length === 0) {
    gaps.push(proofGap(
      'missing_parent_roadmap_proofstory_binding',
      'fail',
      'proofstory.json',
      'Parent-roadmap totality must bind to a ProofStory contract acceptance binding.',
    ));
  }
  if (args.summaryText) {
    const claim = evaluateParentRoadmapClaim({ rollup, summaryText: args.summaryText, mode });
    if (!claim.allowed) {
      gaps.push(proofGap(
        'parent_roadmap_summary_overclaim',
        'fail',
        'summary.json',
        claim.reasons.join(' '),
      ));
    }
  }
  const failGaps = gaps.filter((gap) => gap.severity === 'fail');
  const blocking = mode === 'enforce' && failGaps.length > 0;
  return {
    schemaVersion: 'parent_roadmap.proofstory_binding.v1',
    ledgerId: ledger.ledgerId,
    parentStoryId: ledger.parentStoryId,
    mode,
    status: blocking ? 'fail' : gaps.length > 0 ? 'warn' : 'pass',
    blocking,
    checkedAt: new Date().toISOString(),
    consumedRollup: {
      summaryClass: rollup.summaryClass,
      claimType: rollup.claimType,
      allRowsClosed: rollup.allRowsClosed,
      openRows: rollup.openRows,
      blockedRows: rollup.blockedRows,
      invalidRows: rollup.invalidRows,
      staleEvidenceRows: rollup.staleEvidenceRows,
    },
    gaps,
  };
}

function baseSample(name: string, rows: unknown[]): ParentRoadmapLedger {
  return parseParentRoadmapLedger({
    schemaVersion: name === 'migration' ? 'legacy.parent_roadmap.candidate' : PARENT_ROADMAP_LEDGER_SCHEMA_VERSION,
    ledgerId: `PR-sample-${name}`,
    parentStoryId: name === 'migration' ? 'B-43de' : 'B-parent',
    originalIntentSnapshot: 'Sample parent roadmap intent with child rows.',
    sourceRefs: ['docs/requirements/decisions/parent-roadmap-intent-totality-gate-execution-plan.md'],
    createdByStoryId: name === 'migration' ? 'B-43de' : 'B-parent',
    updatedByStoryIds: [name === 'migration' ? 'B-43de' : 'B-parent'],
    requiredRowIds: rows.map((row: any) => row.rowId).filter(Boolean),
    proofstoryContract: { acceptanceBindings: [{ id: 'parent-roadmap-sample', milestoneIds: rows.map((row: any) => row.rowId).filter(Boolean) }] },
    migration: name === 'migration' ? { sourceStoryId: 'B-43de', reason: 'historical B-43de-shaped parent candidate' } : undefined,
    rows,
  });
}

function b43deClosedSample(): ParentRoadmapLedger {
  const rows = B43DE_CLOSED_ROW_DATA.map((row) => ({
    rowId: row.rowId,
    title: row.title,
    intentText: row.intentText,
    status: 'closed-by-existing-evidence',
    childStoryId: 'B-e781',
    closureEvidence: row.commands.map((command, index) => ({
      kind: index === 0 ? 'smoke_or_verifier' : 'supporting_smoke',
      ref: `B-e781:${row.rowId}:${command.replace(/^node\s+/, '')}`,
      result: 'pass',
      command,
      artifactRef: command,
      observedAt: '2026-06-30T00:00:00.000Z',
    })),
    materialRefs: row.materialRefs,
    updatedAt: '2026-06-30T00:00:00.000Z',
    claimBoundary: row.claimBoundary,
  }));
  return parseParentRoadmapLedger({
    schemaVersion: PARENT_ROADMAP_LEDGER_SCHEMA_VERSION,
    ledgerId: 'PR-B-43de-B-e781-closed',
    parentStoryId: 'B-43de',
    originalIntentSnapshot: 'B-43de parent roadmap M4-M12 closure requires every row to be represented, closed, evidence-backed, and claim-bounded.',
    sourceRefs: ['docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md#ProofStory-Governance-Ledger-M4-M12-Child-Story-Map'],
    createdByStoryId: 'B-43de',
    updatedByStoryIds: ['B-43de', 'B-e781'],
    requiredRowIds: B43DE_M4_M12_ROW_IDS,
    proofstoryContract: { acceptanceBindings: [{ id: 'b-43de-m4-m12-closure', milestoneIds: B43DE_M4_M12_ROW_IDS }] },
    rows,
  });
}

export function buildParentRoadmapSampleCase(name: string): ParentRoadmapLedger {
  if (name === 'b-43de') return b43deClosedSample();
  if (name === 'full') {
    return baseSample('full', [
      {
        rowId: 'M1',
        title: 'Closed implementation',
        intentText: 'Runtime work is closed by fresh implementation evidence.',
        status: 'closed-by-implementation',
        childStoryId: 'B-child-full',
        closureEvidence: [{ kind: 'logic_test', ref: 'sample-full', result: 'pass' }],
        materialRefs: ['packages/main/src/core/parent-roadmap-totality.ts'],
        updatedAt: '2026-06-30T00:00:00.000Z',
      },
    ]);
  }
  if (name === 'blocked') {
    return baseSample('blocked', [
      {
        rowId: 'M2',
        title: 'Blocked child',
        intentText: 'A row cannot close until a blocker is resolved.',
        status: 'blocked',
        childStoryId: 'B-child-blocked',
        blocker: 'human decision pending',
      },
    ]);
  }
  if (name === 'invalid') {
    return baseSample('invalid', [
      {
        rowId: 'M3',
        title: 'Invalid deferral',
        intentText: 'Human deferral is incomplete.',
        status: 'deferred-with-human-approval',
        deferral: { reason: 'later' },
      },
    ]);
  }
  if (name === 'stale') {
    return baseSample('stale', [
      {
        rowId: 'M4',
        title: 'Stale evidence',
        intentText: 'Evidence must be refreshed before closure.',
        status: 'closed-by-implementation',
        childStoryId: 'B-child-stale',
        closureEvidence: [{ kind: 'logic_test', ref: 'old', result: 'pass', stale: true }],
      },
    ]);
  }
  if (name === 'migration') {
    return baseSample('migration', [
      { rowId: 'M4', title: 'Partial M4', intentText: 'M4 is partial in the historical parent candidate.', status: 'parent-governed' },
      ...Array.from({ length: 8 }, (_, index) => {
        const rowId = `M${index + 5}`;
        return {
          rowId,
          title: `${rowId} child row`,
          intentText: `${rowId} remains open and needs child implementation evidence.`,
          status: 'child-story-needed',
        };
      }),
    ]);
  }
  if (name === 'partial') {
    return baseSample('partial', [
      { rowId: 'M4', title: 'Parent governed row', intentText: 'Parent governance exists.', status: 'parent-governed', childStoryId: 'B-parent' },
      { rowId: 'M5', title: 'Child needed row', intentText: 'Child work remains.', status: 'child-story-needed' },
    ]);
  }
  throw new Error(`unknown parent roadmap sample case: ${name}`);
}

export function renderParentRoadmapStatus(result: ParentRollupResult, claim?: ParentRoadmapClaimDecision): string {
  return [
    `Parent roadmap ${result.ledgerId}`,
    `Parent story: ${result.parentStoryId}`,
    `Summary: ${result.summaryClass}`,
    `Claim: ${result.claimType}`,
    `All rows closed: ${result.allRowsClosed ? 'yes' : 'no'}`,
    `Open rows: ${result.openRows.length ? result.openRows.join(', ') : 'none'}`,
    `Blocked rows: ${result.blockedRows.length ? result.blockedRows.join(', ') : 'none'}`,
    `Invalid rows: ${result.invalidRows.length ? result.invalidRows.join(', ') : 'none'}`,
    `Stale rows: ${result.staleEvidenceRows.length ? result.staleEvidenceRows.join(', ') : 'none'}`,
    `Allowed wording: ${result.allowedSummaryText}`,
    `Blocked wording: ${result.blockedSummaryText}`,
    ...(claim ? [
      `Claim wording allowed: ${claim.allowed ? 'yes' : 'no'}`,
      ...(claim.reasons.length ? [`Claim reasons: ${claim.reasons.join(' | ')}`] : []),
    ] : []),
    'Next actions:',
    ...(result.nextActions.length ? result.nextActions.map((action) => `  - ${action}`) : ['  - none']),
  ].join('\n');
}
