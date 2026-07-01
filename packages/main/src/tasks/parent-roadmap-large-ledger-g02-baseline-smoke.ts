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

const GROUP_ID = 'G02';
const REQUIRED_ROW_COUNT = 15;
const GENERATED_ROW_COUNT = 14;
const EVALUATED_AT = '2026-07-01T00:00:00.000Z';
const CURRENT_HEAD_HASH = 'g02-head-hash';
const CURRENT_MATERIAL_HASH = 'g02-material-hash';
const CURRENT_STORY_FILES_HASH = 'g02-story-files-hash';
const SMOKE_COMMAND = 'node packages/main/dist/tasks/parent-roadmap-large-ledger-g02-baseline-smoke.js';
const BASELINE_DOC = 'docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md';
const LOCAL_CLAIM_BOUNDARY = 'Local G02 synthetic missing-row proof only; no broader release readiness or separate-host quorum is asserted.';

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

assert.equal(milestoneMeanings.length, REQUIRED_ROW_COUNT, 'G02 milestone template must stay at exactly 15 rows');

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

function buildG02Row(index: number): ParentRoadmapRow {
  const id = rowId(index);
  return {
    rowId: id,
    title: `${id} ${milestoneMeanings[index]}`,
    intentText: `${GROUP_ID} missing-row negative control coverage for ${milestoneMeanings[index]}.`,
    status: 'closed-by-existing-evidence',
    childStoryId: 'B-e891',
    closureEvidence: [
      {
        kind: 'deterministic_smoke',
        ref: `B-e891:${id}:parent-roadmap-large-ledger-g02-baseline-smoke`,
        result: 'pass',
        command: SMOKE_COMMAND,
        artifactRef: `${BASELINE_DOC}#g02`,
        headHash: CURRENT_HEAD_HASH,
        materialHash: CURRENT_MATERIAL_HASH,
        storyFilesHash: CURRENT_STORY_FILES_HASH,
        stale: false,
        observedAt: EVALUATED_AT,
      },
    ],
    materialRefs: [
      BASELINE_DOC,
      'packages/main/src/tasks/parent-roadmap-large-ledger-g02-baseline-smoke.ts',
      'packages/main/src/core/parent-roadmap-totality.ts',
    ],
    updatedAt: EVALUATED_AT,
    headHash: CURRENT_HEAD_HASH,
    materialHash: CURRENT_MATERIAL_HASH,
    storyFilesHash: CURRENT_STORY_FILES_HASH,
    claimBoundary: LOCAL_CLAIM_BOUNDARY,
  };
}

function buildG02Ledger(): ParentRoadmapLedger {
  const inventory = requiredRowIds();
  return {
    schemaVersion: PARENT_ROADMAP_LEDGER_SCHEMA_VERSION,
    ledgerId: 'UDM-no-false-done-G02-missing-row-negative-control',
    parentStoryId: 'UDM-no-false-done-baseline',
    originalIntentSnapshot: 'G02 missing-row negative control for the UDM no-false-DONE 10x15 baseline: required inventory has 15 rows while generated evidence deliberately omits G02-M15.',
    sourceRefs: [`${BASELINE_DOC}#g02`],
    requiredRowIds: inventory,
    rows: Array.from({ length: GENERATED_ROW_COUNT }, (_, index) => buildG02Row(index)),
    createdByStoryId: 'B-e891',
    updatedByStoryIds: ['B-e891'],
    proofstoryContract: {
      acceptanceBindings: [
        { id: 'udm-no-false-done-g02-missing-row-negative-control', milestoneIds: inventory },
      ],
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

function assertG02MissingRowNegativeControl(): void {
  const ledger = buildG02Ledger();
  const missingRowId = rowId(REQUIRED_ROW_COUNT - 1);

  assert.equal(ledger.rows.length, GENERATED_ROW_COUNT, 'G02 generates exactly 14 ledger rows');
  assert.equal(ledger.requiredRowIds?.length, REQUIRED_ROW_COUNT, 'G02 required inventory has exactly 15 row ids');
  assert.equal(ledger.rows.some((row) => row.rowId === missingRowId), false, 'G02-M15 is deliberately omitted from ledger.rows');

  const rollup = evaluate(ledger);
  assert.equal(rollup.rowResults.length, REQUIRED_ROW_COUNT, 'rollup reports exactly 15 required rows');
  assert.equal(closedRowCount(rollup), GENERATED_ROW_COUNT, 'rollup reports exactly 14 closed rows');
  assert.deepEqual(rollup.openRows, [missingRowId], 'G02 has exactly one open row, G02-M15');
  assert.deepEqual(rollup.invalidRows, [missingRowId], 'G02 has exactly one invalid row, G02-M15');
  assert.deepEqual(rollup.staleEvidenceRows, [], 'G02 has zero stale rows');
  assert.deepEqual(rollup.deferredRows, [], 'G02 has zero deferred rows');
  assert.deepEqual(rollup.migrationRows, [], 'G02 has zero migration rows');
  assert.notEqual(rollup.summaryClass, 'full_roadmap_complete', 'G02 missing row cannot silently become full completion');
  assert.equal(rollup.claimType, 'no-full-roadmap-claim', 'G02 missing row produces no-full-roadmap-claim');
  assert.notEqual(rollup.claimType, 'full-roadmap-claim', 'G02 missing row does not produce a full-roadmap-claim');
  assert.equal(rollup.allRowsClosed, false, 'G02 keeps allRowsClosed false');

  for (const row of rollup.rowResults) {
    if (row.rowId === missingRowId) continue;
    assert.equal(row.closed, true, `${row.rowId} is closed`);
    assert.equal(row.evidenceState, 'fresh', `${row.rowId} evidence is fresh`);
    assert.equal(row.claimBoundary, LOCAL_CLAIM_BOUNDARY, `${row.rowId} keeps the local claim boundary`);
  }

  const missingRow = rollup.rowResults.find((row) => row.rowId === missingRowId);
  assert.ok(missingRow, 'G02-M15 is represented in the evaluated row results');
  assert.equal(missingRow.closed, false, 'G02-M15 remains open');
  assert.equal(missingRow.evidenceState, 'invalid', 'G02-M15 is invalid because it is missing from ledger.rows');
  assert.ok(
    missingRow.reasonCodes.includes('missing_required_row'),
    'G02-M15 missing row reasonCodes includes missing_required_row',
  );

  const claim = evaluateParentRoadmapClaim({
    rollup,
    summaryText: 'Full roadmap complete.',
    mode: 'enforce',
  });
  assert.equal(claim.allowed, false, 'full completion wording is blocked for G02');
  assert.equal(claim.blocking, true, 'enforce mode blocks the G02 missing-row claim');

  assertClaimGuardPositiveControl();
  assertNoElevatedClaims('G02 ledger', ledger);
  assertNoElevatedClaims('G02 rollup', rollup);
  assertNoElevatedClaims('G02 claim decision', claim);
}

assertG02MissingRowNegativeControl();

console.log('parent-roadmap large-ledger G02 baseline smoke PASS');
