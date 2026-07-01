#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import {
  PARENT_ROADMAP_LEDGER_SCHEMA_VERSION,
  evaluateParentRoadmapClaim,
  evaluateParentRoadmapLedger,
  type ParentRoadmapLedger,
  type ParentRoadmapRow,
  type ParentRollupResult,
} from '../core/parent-roadmap-totality.js';

const GROUP_ID = 'G03';
const REQUIRED_ROW_COUNT = 15;
const GENERATED_ROW_COUNT = 15;
const EVALUATED_AT = '2026-07-01T00:00:00.000Z';
const CURRENT_HEAD_HASH = 'g03-head-hash';
const CURRENT_MATERIAL_HASH = 'g03-material-hash';
const CURRENT_STORY_FILES_HASH = 'g03-story-files-hash';
const SMOKE_COMMAND = 'node packages/main/dist/tasks/parent-roadmap-large-ledger-g03-baseline-smoke.js';
const BASELINE_DOC = 'docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md';
const LOCAL_CLAIM_BOUNDARY = 'Local G03 synthetic prose-only proof only; no broader release readiness or separate-host quorum is asserted.';
const CALLER_SUPPLIED_COMPLETION_TEXT = [
  'Full roadmap complete.',
  'All parent roadmap rows are closed.',
  'G03-M01 through G03-M15 are finished based on written completion summaries.',
].join(' ');

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

assert.equal(milestoneMeanings.length, REQUIRED_ROW_COUNT, 'G03 milestone template must stay at exactly 15 rows');

function escapedPatternTerm(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const disallowedClaimTerms = [
  ['Authority'].join(''),
  ['full', 'Authority'].join(''),
  ['production'].join(''),
  ['independent', 'two-host', 'completion'].join(' '),
  ['two-host', 'completion'].join(' '),
];
const disallowedClaimPattern = new RegExp(disallowedClaimTerms.map(escapedPatternTerm).join('|'), 'i');

function rowId(index: number): string {
  return `${GROUP_ID}-M${String(index + 1).padStart(2, '0')}`;
}

function requiredRowIds(): string[] {
  return Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => rowId(index));
}

function buildG03Row(index: number): ParentRoadmapRow {
  const id = rowId(index);
  const proseClosure = `${id} completion note: ${milestoneMeanings[index]} is closed and complete in prose only.`;
  return {
    rowId: id,
    title: `${id} ${milestoneMeanings[index]} prose closure claim`,
    intentText: `${GROUP_ID} prose-only negative control: ${proseClosure} No verifier, command, or evidence artifact is attached.`,
    status: 'closed-by-existing-evidence',
    childStoryId: 'B-727b',
    closureEvidence: [],
    materialRefs: [
      BASELINE_DOC,
      'packages/main/src/tasks/parent-roadmap-large-ledger-g03-baseline-smoke.ts',
      'packages/main/src/core/parent-roadmap-totality.ts',
    ],
    updatedAt: EVALUATED_AT,
    headHash: CURRENT_HEAD_HASH,
    materialHash: CURRENT_MATERIAL_HASH,
    storyFilesHash: CURRENT_STORY_FILES_HASH,
    claimBoundary: LOCAL_CLAIM_BOUNDARY,
  };
}

function buildG03Ledger(): ParentRoadmapLedger {
  const inventory = requiredRowIds();
  return {
    schemaVersion: PARENT_ROADMAP_LEDGER_SCHEMA_VERSION,
    ledgerId: 'UDM-no-false-done-G03-prose-only-negative-control',
    parentStoryId: 'UDM-no-false-done-baseline',
    originalIntentSnapshot: 'G03 prose-only negative control for the UDM no-false-DONE 10x15 baseline: all 15 rows contain written closure claims while machine closure evidence is deliberately absent.',
    sourceRefs: [`${BASELINE_DOC}#g03`],
    requiredRowIds: inventory,
    rows: Array.from({ length: GENERATED_ROW_COUNT }, (_, index) => buildG03Row(index)),
    createdByStoryId: 'B-727b',
    updatedByStoryIds: ['B-727b'],
    proofstoryContract: {
      acceptanceBindings: [
        { id: 'udm-no-false-done-g03-prose-only-negative-control', milestoneIds: inventory },
      ],
    },
    parentLedgerRollup: {
      source: 'caller-supplied prose rollup',
      allRowsClosed: true,
      closedRows: inventory,
      openRows: [],
      summaryClass: 'full_roadmap_complete',
      claimType: 'full-roadmap-claim',
      summaryText: CALLER_SUPPLIED_COMPLETION_TEXT,
    },
  };
}

function evaluate(ledger: ParentRoadmapLedger): ParentRollupResult {
  return evaluateParentRoadmapLedger(ledger, {
    evaluatedAt: EVALUATED_AT,
    currentHeadHash: CURRENT_HEAD_HASH,
    currentMaterialHash: CURRENT_MATERIAL_HASH,
    currentStoryFilesHash: CURRENT_STORY_FILES_HASH,
  });
}

function closedRowCount(rollup: ParentRollupResult): number {
  return rollup.rowResults.filter((row) => row.closed).length;
}

function assertNoElevatedClaims(label: string, value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, disallowedClaimPattern, `${label} must not contain elevated completion claim terms`);
}

function assertClaimGuardPositiveControl(): void {
  const wouldBeOverclaim = [
    ['Authority'].join(''),
    ['full', 'Authority'].join(''),
    ['production'].join(''),
    ['independent', 'two-host', 'completion'].join(' '),
  ].join(' | ');
  assert.match(wouldBeOverclaim, disallowedClaimPattern, 'claim-boundary guard must catch elevated completion vocabulary');
}

function assertG03InventoryComplete(ledger: ParentRoadmapLedger): void {
  const inventory = requiredRowIds();
  const generatedRowIds = ledger.rows.map((row) => row.rowId);

  assert.equal(ledger.requiredRowIds?.length, REQUIRED_ROW_COUNT, 'G03 required inventory has exactly 15 row ids');
  assert.equal(ledger.rows.length, GENERATED_ROW_COUNT, 'G03 generates exactly 15 ledger rows');
  assert.deepEqual(ledger.requiredRowIds, inventory, 'G03 required inventory is exactly G03-M01 through G03-M15');
  assert.deepEqual(generatedRowIds, inventory, 'G03 rows are exactly G03-M01 through G03-M15');

  for (const rowId of inventory) {
    assert.ok(ledger.requiredRowIds?.includes(rowId), `${rowId} exists in requiredRowIds`);
    assert.ok(generatedRowIds.includes(rowId), `${rowId} exists in rows`);
  }
}

function assertG03ProseOnlyNegativeControl(): void {
  const ledger = buildG03Ledger();
  const inventory = requiredRowIds();
  assertG03InventoryComplete(ledger);

  for (const row of ledger.rows) {
    assert.equal(row.closureEvidence.length, 0, `${row.rowId} has no machine closure evidence`);
    assert.match(row.intentText, /\bclosed\b/i, `${row.rowId} prose claims closure`);
    assert.match(row.intentText, /\bcomplete\b/i, `${row.rowId} prose claims completion`);
  }

  const rollup = evaluate(ledger);
  assert.equal(rollup.rowResults.length, REQUIRED_ROW_COUNT, 'rollup reports exactly 15 required rows');
  assert.equal(closedRowCount(rollup), 0, 'rollup reports zero closed rows');
  assert.deepEqual(rollup.openRows, inventory, 'G03 open rows are exactly all 15 row ids');
  assert.deepEqual(rollup.staleEvidenceRows, [], 'G03 has zero stale rows');
  assert.deepEqual(rollup.deferredRows, [], 'G03 has zero deferred rows');
  assert.deepEqual(rollup.invalidRows, [], 'G03 has zero invalid rows');
  assert.deepEqual(rollup.migrationRows, [], 'G03 has zero migration rows');
  assert.notEqual(rollup.summaryClass, 'full_roadmap_complete', 'G03 prose-only rows cannot become full completion');
  assert.equal(rollup.claimType, 'no-full-roadmap-claim', 'G03 produces no-full-roadmap-claim');
  assert.equal(rollup.allRowsClosed, false, 'G03 keeps allRowsClosed false');

  for (const row of rollup.rowResults) {
    assert.equal(row.closed, false, `${row.rowId} remains open`);
    assert.equal(row.evidenceState, 'missing', `${row.rowId} evidence is missing`);
    assert.ok(
      row.reasonCodes.includes('missing_closure_evidence'),
      `${row.rowId} reasonCodes includes missing_closure_evidence`,
    );
    assert.equal(row.claimBoundary, LOCAL_CLAIM_BOUNDARY, `${row.rowId} keeps the local claim boundary`);
  }

  const callerSuppliedRollup = ledger.parentLedgerRollup as { summaryClass: string; allRowsClosed: boolean; summaryText: string };
  assert.equal(callerSuppliedRollup.summaryClass, 'full_roadmap_complete', 'test fixture includes caller-supplied completion rollup prose');
  assert.equal(callerSuppliedRollup.allRowsClosed, true, 'test fixture includes caller-supplied allRowsClosed prose');
  assert.notEqual(rollup.summaryClass, callerSuppliedRollup.summaryClass, 'machine rollup overrides caller-supplied completion prose');
  assert.equal(rollup.allRowsClosed, false, 'machine rollup ignores caller-supplied allRowsClosed prose');

  const claim = evaluateParentRoadmapClaim({
    rollup,
    summaryText: callerSuppliedRollup.summaryText,
    mode: 'enforce',
  });
  assert.equal(claim.allowed, false, 'full completion wording is blocked for G03 prose-only rows');
  assert.equal(claim.blocking, true, 'enforce mode blocks the G03 prose-only claim');

  assertClaimGuardPositiveControl();
  assertNoElevatedClaims('G03 caller prose completion text', CALLER_SUPPLIED_COMPLETION_TEXT);
  assertNoElevatedClaims('G03 ledger', ledger);
  assertNoElevatedClaims('G03 rollup', rollup);
  assertNoElevatedClaims('G03 claim decision', claim);
}

assertG03ProseOnlyNegativeControl();

console.log('parent-roadmap large-ledger G03 baseline smoke PASS');
