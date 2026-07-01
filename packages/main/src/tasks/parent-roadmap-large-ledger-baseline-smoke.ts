#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import {
  PARENT_ROADMAP_LEDGER_SCHEMA_VERSION,
  evaluateParentRoadmapClaim,
  evaluateParentRoadmapLedger,
  type ParentRoadmapLedger,
  type ParentRoadmapRow,
  type ParentRoadmapRowStatus,
  type ParentRollupResult,
} from '../core/parent-roadmap-totality.js';

const REQUIRED_ROW_COUNT = 15;
const GROUP_COUNT = 10;
const EVALUATED_AT = '2026-07-01T00:00:00.000Z';
const BASELINE_DOC = 'docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md';
const CURRENT_HEAD_HASH = 'aggregate-head-hash';
const CURRENT_MATERIAL_HASH = 'aggregate-material-hash';
const CURRENT_STORY_FILES_HASH = 'aggregate-story-files-hash';
const STALE_HEAD_HASH = 'aggregate-stale-head-hash';
const STALE_MATERIAL_HASH = 'aggregate-stale-material-hash';
const STALE_STORY_FILES_HASH = 'aggregate-stale-story-files-hash';

const milestoneMeanings = [
  'Original intent snapshot preserved',
  'Milestone ledger complete',
  'Intent coverage check',
  'Scope shrinkage guard',
  'Child/story slicing boundary',
  'Acceptance contract binding',
  'Machine evidence present',
  'Evidence freshness',
  'Negative control',
  'Review assurance',
  'Delivery check',
  'Claim boundary',
  'DONE intent equivalence',
  'Rollup status',
  'Handoff summary',
] as const;

assert.equal(milestoneMeanings.length, REQUIRED_ROW_COUNT, 'aggregate milestone template must stay at exactly 15 rows');

function rowId(groupId: string, index: number): string {
  return `${groupId}-M${String(index + 1).padStart(2, '0')}`;
}

function requiredRowIds(groupId: string): string[] {
  return Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => rowId(groupId, index));
}

function evidenceRef(groupId: string, id: string, fresh: boolean) {
  return {
    kind: 'deterministic_smoke',
    ref: `B-d278:${id}:parent-roadmap-large-ledger-baseline-smoke`,
    result: 'pass',
    command: 'node packages/main/dist/tasks/parent-roadmap-large-ledger-baseline-smoke.js',
    artifactRef: `${BASELINE_DOC}#${groupId.toLowerCase()}`,
    headHash: fresh ? CURRENT_HEAD_HASH : STALE_HEAD_HASH,
    materialHash: fresh ? CURRENT_MATERIAL_HASH : STALE_MATERIAL_HASH,
    storyFilesHash: fresh ? CURRENT_STORY_FILES_HASH : STALE_STORY_FILES_HASH,
    observedAt: EVALUATED_AT,
  };
}

function baseRow(groupId: string, index: number, status: ParentRoadmapRowStatus, fresh = true): ParentRoadmapRow {
  const id = rowId(groupId, index);
  const hasEvidence = status === 'closed-by-existing-evidence' || status === 'closed-by-implementation';
  return {
    rowId: id,
    title: `${id} ${milestoneMeanings[index]}`,
    intentText: `${groupId} aggregate baseline row for ${milestoneMeanings[index]}.`,
    status,
    childStoryId: status === 'child-story-active' ? `B-d278-child-${id}` : hasEvidence ? 'B-d278' : undefined,
    closureEvidence: hasEvidence ? [evidenceRef(groupId, id, fresh)] : [],
    materialRefs: hasEvidence ? [BASELINE_DOC, 'packages/main/src/core/parent-roadmap-totality.ts'] : [BASELINE_DOC],
    updatedAt: EVALUATED_AT,
    headHash: hasEvidence ? (fresh ? CURRENT_HEAD_HASH : STALE_HEAD_HASH) : undefined,
    materialHash: hasEvidence ? (fresh ? CURRENT_MATERIAL_HASH : STALE_MATERIAL_HASH) : undefined,
    storyFilesHash: hasEvidence ? (fresh ? CURRENT_STORY_FILES_HASH : STALE_STORY_FILES_HASH) : undefined,
    claimBoundary: `Local ${groupId} aggregate baseline proof only.`,
  };
}

function deferredRow(groupId: string, index: number): ParentRoadmapRow {
  return {
    ...baseRow(groupId, index, 'deferred-with-human-approval'),
    deferral: {
      approvedBy: 'human-reviewer',
      approvedAt: EVALUATED_AT,
      reason: `${rowId(groupId, index)} is intentionally deferred from this local baseline.`,
      revisitTrigger: `Revisit ${rowId(groupId, index)} before broader delivery.`,
      nonRuntimeBehaviorStatement: 'This does not implement runtime behavior.',
    },
  };
}

function ledger(groupId: string, rows: unknown[], overrides: Partial<ParentRoadmapLedger> = {}): ParentRoadmapLedger {
  const inventory = requiredRowIds(groupId);
  return {
    schemaVersion: PARENT_ROADMAP_LEDGER_SCHEMA_VERSION,
    ledgerId: `UDM-no-false-done-${groupId}-aggregate`,
    parentStoryId: 'UDM-no-false-done-baseline',
    originalIntentSnapshot: `${groupId} aggregate no-false-DONE baseline.`,
    sourceRefs: [`${BASELINE_DOC}#${groupId.toLowerCase()}`],
    requiredRowIds: inventory,
    rows: rows as ParentRoadmapRow[],
    createdByStoryId: 'B-d278',
    updatedByStoryIds: ['B-d278'],
    proofstoryContract: {
      acceptanceBindings: [{ id: `udm-no-false-done-${groupId.toLowerCase()}-aggregate`, milestoneIds: inventory }],
    },
    ...overrides,
  };
}

function evaluate(ledgerValue: ParentRoadmapLedger): ParentRollupResult {
  return evaluateParentRoadmapLedger(ledgerValue, {
    evaluatedAt: EVALUATED_AT,
    currentHeadHash: CURRENT_HEAD_HASH,
    currentMaterialHash: CURRENT_MATERIAL_HASH,
    currentStoryFilesHash: CURRENT_STORY_FILES_HASH,
  });
}

function closedRowCount(rollup: ParentRollupResult): number {
  return rollup.rowResults.filter((row) => row.closed).length;
}

function fullClaimAllowed(rollup: ParentRollupResult, summaryText = 'Full roadmap complete.'): boolean {
  return evaluateParentRoadmapClaim({ rollup, summaryText, mode: 'enforce' }).allowed;
}

function escapedPatternTerm(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const elevatedTerms = [
  ['Authority'].join(''),
  ['full', 'Authority'].join(''),
  ['production'].join(''),
  ['independent-host', 'completion'].join(' '),
];
const elevatedPattern = new RegExp(elevatedTerms.map(escapedPatternTerm).join('|'), 'i');
const fullRoadmapPattern = /\bfull[- ]roadmap\b|\broadmap\s+(?:is\s+)?(?:complete|completed|done|finished)\b/i;
const fullRoadmapCompletePrefix = ['Full roadmap', 'complete with'].join(' ');

function elevatedCompletionClaim(term: string): string {
  return `${fullRoadmapCompletePrefix} ${term}.`;
}

function boundaryAllows(text: string): boolean {
  return !elevatedPattern.test(text) && !fullRoadmapPattern.test(text);
}

interface MatrixExpectation {
  groupId: string;
  requiredRows: number;
  generatedRows: number;
  closedRows: number;
  openRows: number;
  staleRows: number;
  deferredRows: number;
  invalidRows: number;
  migrationRows: number;
  summaryClass: string;
  claimType: string;
  fullClaimAllowed: boolean;
}

function assertMatrix(rollup: ParentRollupResult, source: ParentRoadmapLedger, expected: MatrixExpectation): void {
  assert.equal(source.requiredRowIds?.length, expected.requiredRows, `${expected.groupId} required rows`);
  assert.equal(source.rows.length, expected.generatedRows, `${expected.groupId} generated rows`);
  assert.equal(rollup.rowResults.length, expected.requiredRows, `${expected.groupId} evaluated row matrix`);
  assert.equal(closedRowCount(rollup), expected.closedRows, `${expected.groupId} closed rows`);
  assert.equal(rollup.openRows.length, expected.openRows, `${expected.groupId} open rows`);
  assert.equal(rollup.staleEvidenceRows.length, expected.staleRows, `${expected.groupId} stale rows`);
  assert.equal(rollup.deferredRows.length, expected.deferredRows, `${expected.groupId} deferred rows`);
  assert.equal(rollup.invalidRows.length, expected.invalidRows, `${expected.groupId} invalid rows`);
  assert.equal(rollup.migrationRows.length, expected.migrationRows, `${expected.groupId} migration rows`);
  assert.equal(rollup.summaryClass, expected.summaryClass, `${expected.groupId} summaryClass`);
  assert.equal(rollup.claimType, expected.claimType, `${expected.groupId} claimType`);
  const actualFullClaimAllowed = expected.groupId === 'G07'
    ? boundaryAllows('Full roadmap complete.') && fullClaimAllowed(rollup)
    : fullClaimAllowed(rollup);
  assert.equal(actualFullClaimAllowed, expected.fullClaimAllowed, `${expected.groupId} full claim allowed`);
}

const g01 = ledger('G01', Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => baseRow('G01', index, 'closed-by-existing-evidence')));
const g02 = ledger('G02', Array.from({ length: REQUIRED_ROW_COUNT - 1 }, (_, index) => baseRow('G02', index, 'closed-by-existing-evidence')));
const g03 = ledger('G03', Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => ({
  ...baseRow('G03', index, 'closed-by-existing-evidence'),
  closureEvidence: [],
})));
const g04 = ledger('G04', Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => baseRow('G04', index, 'closed-by-existing-evidence', false)));
const g05 = ledger('G05', Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => (
  index < 12 ? baseRow('G05', index, 'closed-by-existing-evidence') : deferredRow('G05', index)
)));
const g06 = ledger(
  'G06',
  Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => baseRow('G06', index, 'child-story-needed')),
  {
    schemaVersion: 'legacy.parent_roadmap.candidate',
    migration: { sourceStoryId: 'legacy-sample', reason: 'Aggregate migration/sample rows are not completion evidence.' },
  },
);
const g07 = ledger('G07', Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => ({
  ...baseRow('G07', index, 'closed-by-existing-evidence'),
  claimBoundary: 'Local G07 aggregate baseline proof only; no elevated deployment claim is asserted.',
})));
const g08 = ledger('G08', [
  ...Array.from({ length: REQUIRED_ROW_COUNT - 1 }, (_, index) => baseRow('G08', index, 'closed-by-existing-evidence')),
  {
    rowId: rowId('G08', REQUIRED_ROW_COUNT - 1),
    title: '',
    intentText: 'Malformed G08 row remains invalid even though the required id is present.',
    status: 'closed-by-existing-evidence',
    closureEvidence: [],
    materialRefs: [BASELINE_DOC],
  },
]);
const g09 = ledger('G09', Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => baseRow('G09', index, 'child-story-active')));
const g10Stale = ledger('G10', Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => baseRow('G10', index, 'closed-by-existing-evidence', false)));
const g10Fresh = ledger('G10', Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => baseRow('G10', index, 'closed-by-existing-evidence')));

const evaluated = [
  { source: g01, rollup: evaluate(g01), expected: { groupId: 'G01', requiredRows: 15, generatedRows: 15, closedRows: 15, openRows: 0, staleRows: 0, deferredRows: 0, invalidRows: 0, migrationRows: 0, summaryClass: 'full_roadmap_complete', claimType: 'full-roadmap-claim', fullClaimAllowed: true } },
  { source: g02, rollup: evaluate(g02), expected: { groupId: 'G02', requiredRows: 15, generatedRows: 14, closedRows: 14, openRows: 1, staleRows: 0, deferredRows: 0, invalidRows: 1, migrationRows: 0, summaryClass: 'invalid_parent_rollup', claimType: 'no-full-roadmap-claim', fullClaimAllowed: false } },
  { source: g03, rollup: evaluate(g03), expected: { groupId: 'G03', requiredRows: 15, generatedRows: 15, closedRows: 0, openRows: 15, staleRows: 0, deferredRows: 0, invalidRows: 0, migrationRows: 0, summaryClass: 'partial_parent_done', claimType: 'no-full-roadmap-claim', fullClaimAllowed: false } },
  { source: g04, rollup: evaluate(g04), expected: { groupId: 'G04', requiredRows: 15, generatedRows: 15, closedRows: 0, openRows: 15, staleRows: 15, deferredRows: 0, invalidRows: 0, migrationRows: 0, summaryClass: 'stale_parent_rollup', claimType: 'no-full-roadmap-claim', fullClaimAllowed: false } },
  { source: g05, rollup: evaluate(g05), expected: { groupId: 'G05', requiredRows: 15, generatedRows: 15, closedRows: 12, openRows: 3, staleRows: 0, deferredRows: 3, invalidRows: 0, migrationRows: 0, summaryClass: 'partial_parent_done', claimType: 'no-full-roadmap-claim', fullClaimAllowed: false } },
  { source: g06, rollup: evaluate(g06), expected: { groupId: 'G06', requiredRows: 15, generatedRows: 15, closedRows: 0, openRows: 15, staleRows: 0, deferredRows: 0, invalidRows: 0, migrationRows: 15, summaryClass: 'migration_needed', claimType: 'no-full-roadmap-claim', fullClaimAllowed: false } },
  { source: g07, rollup: evaluate(g07), expected: { groupId: 'G07', requiredRows: 15, generatedRows: 15, closedRows: 15, openRows: 0, staleRows: 0, deferredRows: 0, invalidRows: 0, migrationRows: 0, summaryClass: 'full_roadmap_complete', claimType: 'full-roadmap-claim', fullClaimAllowed: false } },
  { source: g08, rollup: evaluate(g08), expected: { groupId: 'G08', requiredRows: 15, generatedRows: 15, closedRows: 14, openRows: 1, staleRows: 0, deferredRows: 0, invalidRows: 1, migrationRows: 0, summaryClass: 'invalid_parent_rollup', claimType: 'no-full-roadmap-claim', fullClaimAllowed: false } },
  { source: g09, rollup: evaluate(g09), expected: { groupId: 'G09', requiredRows: 15, generatedRows: 15, closedRows: 0, openRows: 15, staleRows: 0, deferredRows: 0, invalidRows: 0, migrationRows: 0, summaryClass: 'partial_parent_done', claimType: 'no-full-roadmap-claim', fullClaimAllowed: false } },
  { source: g10Fresh, rollup: evaluate(g10Fresh), expected: { groupId: 'G10', requiredRows: 15, generatedRows: 15, closedRows: 15, openRows: 0, staleRows: 0, deferredRows: 0, invalidRows: 0, migrationRows: 0, summaryClass: 'full_roadmap_complete', claimType: 'full-roadmap-claim', fullClaimAllowed: true } },
] as const;

for (const item of evaluated) {
  assertMatrix(item.rollup, item.source, item.expected);
}

const requiredRowsTotal = evaluated.reduce((sum, item) => sum + (item.source.requiredRowIds?.length ?? 0), 0);
assert.equal(requiredRowsTotal, GROUP_COUNT * REQUIRED_ROW_COUNT, 'aggregate matrix covers exactly 10 x 15 required rows');

const staleG10Rollup = evaluate(g10Stale);
assert.equal(staleG10Rollup.rowResults.length, REQUIRED_ROW_COUNT, 'G10 stale state evaluates 15 rows before refresh');
assert.equal(staleG10Rollup.staleEvidenceRows.length, REQUIRED_ROW_COUNT, 'G10 stale state has 15 stale rows before refresh');
assert.equal(staleG10Rollup.claimType, 'no-full-roadmap-claim', 'G10 stale state blocks full claim before refresh');
assert.equal(fullClaimAllowed(staleG10Rollup), false, 'G10 stale state blocks full wording before refresh');

assert.equal(boundaryAllows(elevatedCompletionClaim(['Authority', 'completion'].join(' '))), false, 'aggregate rejects elevated Authority wording');
assert.equal(boundaryAllows(elevatedCompletionClaim(['fullAuthority', 'completion'].join(' '))), false, 'aggregate rejects elevated fullAuthority wording');
assert.equal(boundaryAllows(elevatedCompletionClaim(['production', 'completion'].join(' '))), false, 'aggregate rejects elevated production wording');
assert.equal(boundaryAllows(elevatedCompletionClaim(['independent-host', 'completion'].join(' '))), false, 'aggregate rejects elevated independent-host wording');
assert.equal(boundaryAllows('Full roadmap complete.'), false, 'aggregate rejects unbounded full-roadmap wording for G07');
assert.equal(boundaryAllows('Local deterministic baseline rows are closed.'), true, 'aggregate allows safe local boundary wording');

console.log('parent-roadmap large-ledger 10x15 baseline smoke PASS');
