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

const GROUP_ID = 'G07';
const REQUIRED_ROW_COUNT = 15;
const EVALUATED_AT = '2026-07-01T00:00:00.000Z';
const CURRENT_HEAD_HASH = 'g07-head-hash';
const CURRENT_MATERIAL_HASH = 'g07-material-hash';
const CURRENT_STORY_FILES_HASH = 'g07-story-files-hash';
const SMOKE_COMMAND = 'node packages/main/dist/tasks/parent-roadmap-large-ledger-g07-baseline-smoke.js';
const BASELINE_DOC = 'docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md';
const LOCAL_CLAIM_BOUNDARY = 'Local G07 deterministic ledger proof only; no elevated deployment or separate-host completion is asserted.';

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

assert.equal(milestoneMeanings.length, REQUIRED_ROW_COUNT, 'G07 milestone template must stay at exactly 15 rows');

function escapedPatternTerm(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const elevatedCompletionTerms = [
  ['Authority'].join(''),
  ['full', 'Authority'].join(''),
  ['production'].join(''),
  ['independent-host', 'completion'].join(' '),
  ['independent', 'two-host', 'completion'].join(' '),
];
const elevatedCompletionPattern = new RegExp(elevatedCompletionTerms.map(escapedPatternTerm).join('|'), 'i');
const fullRoadmapPattern = /\bfull[- ]roadmap\b|\broadmap\s+(?:is\s+)?(?:complete|completed|done|finished)\b/i;

function boundaryAllows(value: string): boolean {
  return !elevatedCompletionPattern.test(value) && !fullRoadmapPattern.test(value);
}

function rowId(index: number): string {
  return `${GROUP_ID}-M${String(index + 1).padStart(2, '0')}`;
}

function requiredRowIds(): string[] {
  return Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => rowId(index));
}

function buildG07Row(index: number): ParentRoadmapRow {
  const id = rowId(index);
  return {
    rowId: id,
    title: `${id} ${milestoneMeanings[index]} local closure`,
    intentText: `${GROUP_ID} local closure baseline for ${milestoneMeanings[index]}.`,
    status: 'closed-by-existing-evidence',
    childStoryId: 'B-d278',
    closureEvidence: [
      {
        kind: 'deterministic_smoke',
        ref: `B-d278:${id}:parent-roadmap-large-ledger-g07-baseline-smoke`,
        result: 'pass',
        command: SMOKE_COMMAND,
        artifactRef: `${BASELINE_DOC}#g07`,
        headHash: CURRENT_HEAD_HASH,
        materialHash: CURRENT_MATERIAL_HASH,
        storyFilesHash: CURRENT_STORY_FILES_HASH,
        observedAt: EVALUATED_AT,
      },
    ],
    materialRefs: [
      BASELINE_DOC,
      'packages/main/src/tasks/parent-roadmap-large-ledger-g07-baseline-smoke.ts',
      'packages/main/src/core/parent-roadmap-totality.ts',
    ],
    updatedAt: EVALUATED_AT,
    headHash: CURRENT_HEAD_HASH,
    materialHash: CURRENT_MATERIAL_HASH,
    storyFilesHash: CURRENT_STORY_FILES_HASH,
    claimBoundary: LOCAL_CLAIM_BOUNDARY,
  };
}

function buildG07Ledger(): ParentRoadmapLedger {
  const inventory = requiredRowIds();
  return {
    schemaVersion: PARENT_ROADMAP_LEDGER_SCHEMA_VERSION,
    ledgerId: 'UDM-no-false-done-G07-overclaim-boundary-negative-control',
    parentStoryId: 'UDM-no-false-done-baseline',
    originalIntentSnapshot: 'G07 overclaim-boundary negative control: 15 local rows close, but elevated completion wording is rejected by the boundary guard.',
    sourceRefs: [`${BASELINE_DOC}#g07`],
    requiredRowIds: inventory,
    rows: Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => buildG07Row(index)),
    createdByStoryId: 'B-d278',
    updatedByStoryIds: ['B-d278'],
    proofstoryContract: {
      acceptanceBindings: [
        { id: 'udm-no-false-done-g07-overclaim-boundary-negative-control', milestoneIds: inventory },
      ],
    },
  };
}

function closedRowCount(rollup: ParentRollupResult): number {
  return rollup.rowResults.filter((row) => row.closed).length;
}

const ledger = buildG07Ledger();
assert.equal(ledger.requiredRowIds?.length, REQUIRED_ROW_COUNT, 'G07 required inventory has exactly 15 row ids');
assert.equal(ledger.rows.length, REQUIRED_ROW_COUNT, 'G07 generates exactly 15 ledger rows');
for (const row of ledger.rows) {
  assert.equal(boundaryAllows(row.claimBoundary ?? ''), true, `${row.rowId} accepted claimBoundary remains local`);
}

const rollup = evaluateParentRoadmapLedger(ledger, {
  evaluatedAt: EVALUATED_AT,
  currentHeadHash: CURRENT_HEAD_HASH,
  currentMaterialHash: CURRENT_MATERIAL_HASH,
  currentStoryFilesHash: CURRENT_STORY_FILES_HASH,
});
assert.equal(rollup.rowResults.length, REQUIRED_ROW_COUNT, 'rollup reports exactly 15 required rows');
assert.equal(closedRowCount(rollup), REQUIRED_ROW_COUNT, 'G07 has 15 local closed rows');
assert.equal(rollup.summaryClass, 'full_roadmap_complete', 'safe local wording can still complete the local rollup');
assert.equal(rollup.claimType, 'full-roadmap-claim');
assert.equal(rollup.allRowsClosed, true);

const coreSafeLocalClaim = evaluateParentRoadmapClaim({
  rollup,
  summaryText: 'Local deterministic baseline rows are closed.',
  mode: 'enforce',
});
assert.equal(coreSafeLocalClaim.allowed, true, 'safe local non-roadmap wording is allowed for the local G07 rollup');
assert.equal(boundaryAllows('Local deterministic baseline rows are closed.'), true, 'safe local boundary wording stays inside boundary');

const rejectedOverclaimTexts = [
  'Full roadmap complete.',
  'Full roadmap complete with Authority completion.',
  'Full roadmap complete with fullAuthority completion.',
  'Full roadmap complete with production completion.',
  'Full roadmap complete with independent-host completion.',
];
for (const text of rejectedOverclaimTexts) {
  assert.equal(boundaryAllows(text), false, `boundary guard rejects elevated wording: ${text}`);
}

console.log('parent-roadmap large-ledger G07 baseline smoke PASS');
