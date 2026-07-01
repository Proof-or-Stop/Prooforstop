#!/usr/bin/env node
/**
 * Smoke coverage for the parent-roadmap intent-totality gate.
 *
 * M1 deliberately lands before the runtime evaluator exists. Keep the runtime
 * import dynamic and computed so this file can build in the red/repro commit.
 *
 * Supported targeted modes:
 * --expected-red=parent-overclaim
 * --expected-red=test-first
 * --case=state-model
 * --case=evaluator
 * --case=claim-consumer
 * --case=proofstory-binding
 * --case=cli
 * --case=migration
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type CaseName = 'state-model' | 'evaluator' | 'claim-consumer' | 'proofstory-binding' | 'cli' | 'migration';
type ExpectedRedMode = 'parent-overclaim' | 'test-first';

interface RuntimeModule {
  PARENT_ROADMAP_LEDGER_SCHEMA_VERSION: string;
  PARENT_ROLLUP_SCHEMA_VERSION: string;
  evaluateParentRoadmapLedger(ledger: unknown, options?: Record<string, unknown>): any;
  evaluateParentRoadmapClaim(args: { rollup: unknown; summaryText: string; mode?: string }): any;
  evaluateParentRoadmapProofStoryBinding(args: Record<string, unknown>): any;
  buildParentRoadmapSampleCase(name: string): unknown;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');
const sessionEnv = {
  ...process.env,
  LATTICE_SESSION_ID: 'parent-roadmap-totality-smoke',
  LATTICE_AGENT: 'parent-roadmap-totality-smoke',
};
const M4_M12_ROW_IDS = Array.from({ length: 9 }, (_, index) => `M${index + 4}`);
const B43DE_EXPECTED_COMMANDS: Record<string, string[]> = {
  M4: ['node scripts/verify-process-fact-contract.mjs'],
  M5: ['node packages/main/dist/tasks/verification-context-pack-smoke.js'],
  M6: [
    'node packages/main/dist/tasks/lifecycle-orchestrate-smoke.js',
    'node packages/main/dist/tasks/review-escalation-smoke.js',
  ],
  M7: [
    'node packages/main/dist/tasks/baseline-suite-smoke.js',
    'node packages/main/dist/tasks/baseline-suite-report-smoke.js',
  ],
  M8: [
    'node packages/main/dist/tasks/reviewer-quorum-smoke.js',
    'node packages/main/dist/tasks/quorum-submit-smoke.js',
    'node packages/main/dist/tasks/review-escalation-smoke.js',
  ],
  M9: ['node packages/main/dist/tasks/lifecycle-orchestrate-smoke.js'],
  M10: ['node packages/main/dist/tasks/lattice-parallel-wave-smoke.js'],
  M11: ['node packages/main/dist/tasks/rollout-check-smoke.js'],
  M12: [
    'node packages/main/dist/tasks/parent-roadmap-totality-smoke.js',
    'node packages/main/dist/tasks/lattice-handoff-smoke.js',
  ],
};
function escapedPatternTerm(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DISALLOWED_CLAIM_TERMS = [
  ['AUTHORITY', 'GATE', 'DECISION'].join('_'),
  ['authority', 'Done'].join(''),
  ['full', 'Authority', 'Done'].join(''),
  ['production', 'Done'].join(''),
  ['receipt', 'Verified'].join(''),
  ['Authority', 'Server'].join(' '),
  ['production', ['runtime', 'conformance'].join(' ')].join('/'),
  ['runtime', 'conformance'].join(' '),
];
const DISALLOWED_CLAIM_PATTERN = new RegExp(DISALLOWED_CLAIM_TERMS.map(escapedPatternTerm).join('|'), 'i');

const allCases: CaseName[] = ['state-model', 'evaluator', 'claim-consumer', 'proofstory-binding', 'cli', 'migration'];

function argValue(prefix: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseCase(): CaseName | 'all' {
  const value = argValue('--case=') ?? 'all';
  if (value === 'all') return 'all';
  assert.ok(allCases.includes(value as CaseName), `unknown --case value: ${value}`);
  return value as CaseName;
}

function parseExpectedRed(): ExpectedRedMode | undefined {
  const value = argValue('--expected-red=');
  if (!value) return undefined;
  assert.ok(value === 'parent-overclaim' || value === 'test-first', `unknown --expected-red value: ${value}`);
  return value;
}

async function loadRuntime(): Promise<RuntimeModule> {
  const modulePath = '../core/' + 'parent-roadmap-totality.js';
  return await import(modulePath) as RuntimeModule;
}

async function tryLoadRuntime(): Promise<{ ok: true; mod: RuntimeModule } | { ok: false; reason: string }> {
  try {
    return { ok: true, mod: await loadRuntime() };
  } catch (error: any) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

function initRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lattice-parent-roadmap-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'parent-roadmap@example.test']);
  git(root, ['config', 'user.name', 'Parent Roadmap Smoke']);
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  write(root, 'README.md', 'parent roadmap smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

function runCli(root: string, command: string, args: Record<string, unknown>, allowFailure = false): string {
  try {
    return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(args)], {
      cwd: root,
      env: sessionEnv,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    const text = String(error.stdout || '') + String(error.stderr || '') + String(error.message || '');
    if (allowFailure) return text;
    throw new Error(text);
  }
}

function baseLedger(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'parent_roadmap.ledger.v1',
    ledgerId: 'PR-B-43de',
    parentStoryId: 'B-43de',
    originalIntentSnapshot: 'Deliver the full Proofbound strengthening roadmap, including rows M4-M12.',
    sourceRefs: ['docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md#M4-M12'],
    createdByStoryId: 'B-43de',
    updatedByStoryIds: ['B-43de'],
    proofstoryContract: { storyId: 'B-43de', contractRef: 'proofstory.json' },
    rows: [],
    ...overrides,
  };
}

function fullLedger(): Record<string, unknown> {
  return baseLedger({
    ledgerId: 'PR-full',
    requiredRowIds: ['M1', 'M2', 'M3'],
    proofstoryContract: { storyId: 'B-43de', contractRef: 'proofstory.json', acceptanceBindings: [{ id: 'full-roadmap', milestoneIds: ['M1', 'M2', 'M3'] }] },
    rows: [
      {
        rowId: 'M1',
        title: 'Gate model',
        intentText: 'Runtime evaluator exists and is verified.',
        status: 'closed-by-implementation',
        childStoryId: 'B-child-1',
        closureEvidence: [{ kind: 'logic_test', ref: 'parent-roadmap-totality-smoke:evaluator', result: 'pass' }],
        materialRefs: ['packages/main/src/core/parent-roadmap-totality.ts'],
        updatedAt: '2026-06-30T00:00:00.000Z',
        headHash: 'H1',
        materialHash: 'M1',
        storyFilesHash: 'S1',
        claimBoundary: 'implementation row closed only',
      },
      {
        rowId: 'M2',
        title: 'Prior implementation',
        intentText: 'Existing behavior still satisfies the parent row.',
        status: 'closed-by-existing-evidence',
        childStoryId: 'B-child-2',
        closureEvidence: [{ kind: 'integration_test', ref: 'existing-evidence', result: 'pass' }],
        materialRefs: ['packages/main/src/handlers/proofstory.ts'],
        updatedAt: '2026-06-30T00:00:00.000Z',
        headHash: 'H1',
        materialHash: 'M1',
        storyFilesHash: 'S1',
        claimBoundary: 'existing evidence row closed only',
      },
      {
        rowId: 'M3',
        title: 'Not applicable row',
        intentText: 'No runtime behavior is required for this row.',
        status: 'not-applicable',
        notApplicableDecision: {
          reason: 'The row was superseded by an audited requirement decision.',
          decidedBy: 'human-reviewer',
          decidedAt: '2026-06-30T00:00:00.000Z',
        },
        closureEvidence: [{ kind: 'decision', ref: 'decision-doc', result: 'accepted' }],
        materialRefs: ['docs/requirements/decisions/parent-roadmap-intent-totality-gate-execution-plan.md'],
        updatedAt: '2026-06-30T00:00:00.000Z',
        claimBoundary: 'not applicable by audited decision',
      },
    ],
  });
}

function partialLedger(): Record<string, unknown> {
  return baseLedger({
    ledgerId: 'PR-partial',
    parentStoryId: 'B-parent-partial',
    createdByStoryId: 'B-parent-partial',
    updatedByStoryIds: ['B-parent-partial'],
    requiredRowIds: ['M4', 'M5'],
    proofstoryContract: { storyId: 'B-parent-partial', contractRef: 'proofstory.json', acceptanceBindings: [{ id: 'partial-roadmap', milestoneIds: ['M4', 'M5'] }] },
    parentLedgerRollup: { allRowsClosed: true, claimType: 'full-roadmap-claim' },
    rows: [
      {
        rowId: 'M4',
        title: 'Partial parent governance',
        intentText: 'Parent governance ledger exists but child work remains.',
        status: 'parent-governed',
        childStoryId: 'B-43de',
        closureEvidence: [{ kind: 'summary', ref: 'B-43de parent governance DONE', result: 'accepted' }],
        materialRefs: ['packages/main/src/core/proofstory.ts'],
        updatedAt: '2026-06-30T00:00:00.000Z',
        claimBoundary: 'parent governance only',
      },
      {
        rowId: 'M5',
        title: 'Implementation child needed',
        intentText: 'Runtime child milestone still needs an implementation story.',
        status: 'child-story-needed',
        materialRefs: ['packages/main/src/handlers/parent-roadmap.ts'],
        updatedAt: '2026-06-30T00:00:00.000Z',
        claimBoundary: 'no full-roadmap claim',
      },
    ],
  });
}

function shrunkenRequiredInventoryLedger(): Record<string, unknown> {
  return baseLedger({
    ledgerId: 'PR-shrunken-required',
    parentStoryId: 'B-parent-shrunken',
    createdByStoryId: 'B-parent-shrunken',
    updatedByStoryIds: ['B-parent-shrunken'],
    requiredRowIds: M4_M12_ROW_IDS,
    proofstoryContract: { storyId: 'B-parent-shrunken', contractRef: 'proofstory.json', acceptanceBindings: [{ id: 'm4-m12-roadmap', milestoneIds: M4_M12_ROW_IDS }] },
    rows: [
      {
        rowId: 'M4',
        title: 'M4 closed implementation',
        intentText: 'M4 is closed but the original M4-M12 inventory is larger.',
        status: 'closed-by-implementation',
        childStoryId: 'B-child-m4',
        closureEvidence: [{ kind: 'logic_test', ref: 'm4-closed', result: 'pass' }],
        materialRefs: ['packages/main/src/core/parent-roadmap-totality.ts'],
      },
    ],
  });
}

function externalProofStoryContractOnlyLedger(): Record<string, unknown> {
  return baseLedger({
    ledgerId: 'PR-external-proofstory-only',
    parentStoryId: 'B-parent-external-proofstory',
    createdByStoryId: 'B-parent-external-proofstory',
    updatedByStoryIds: ['B-parent-external-proofstory'],
    proofstoryContract: undefined,
    rows: [
      {
        rowId: 'M4',
        title: 'M4 closed implementation',
        intentText: 'M4 is closed but the external ProofStory inventory remains M4-M12.',
        status: 'closed-by-implementation',
        childStoryId: 'B-child-m4',
        closureEvidence: [{ kind: 'logic_test', ref: 'm4-closed', result: 'pass' }],
        materialRefs: ['packages/main/src/core/parent-roadmap-totality.ts'],
      },
    ],
  });
}

function externalM4M12ProofStoryContract(): Record<string, unknown> {
  return { acceptanceBindings: [{ id: 'm4-m12-roadmap', milestoneIds: M4_M12_ROW_IDS }] };
}

function missingClosureEvidenceLedger(): Record<string, unknown> {
  return baseLedger({
    ledgerId: 'PR-missing-closure-evidence',
    requiredRowIds: ['M9'],
    rows: [
      {
        rowId: 'M9',
        title: 'Closed row missing evidence',
        intentText: 'A closed row must still attach closure evidence.',
        status: 'closed-by-existing-evidence',
        childStoryId: 'B-child-existing',
        closureEvidence: [],
        materialRefs: ['packages/main/src/core/parent-roadmap-totality.ts'],
      },
    ],
  });
}

function blockedLedger(): Record<string, unknown> {
  return baseLedger({
    ledgerId: 'PR-blocked',
    rows: [
      {
        rowId: 'M6',
        title: 'Blocked row',
        intentText: 'A named blocker prevents completion.',
        status: 'blocked',
        childStoryId: 'B-child-blocked',
        blocker: 'Waiting for human product decision.',
        closureEvidence: [],
        materialRefs: ['docs/requirements/decisions/parent-roadmap-intent-totality-gate-execution-plan.md'],
        updatedAt: '2026-06-30T00:00:00.000Z',
        claimBoundary: 'blocked until decision exists',
      },
    ],
  });
}

function invalidLedger(): Record<string, unknown> {
  return baseLedger({
    ledgerId: 'PR-invalid',
    rows: [
      {
        rowId: 'M7',
        title: 'Invalid deferral',
        intentText: 'Deferral lacks the required human approval record.',
        status: 'deferred-with-human-approval',
        deferral: {
          reason: 'Maybe later',
        },
        closureEvidence: [],
        materialRefs: ['docs/requirements/decisions/parent-roadmap-intent-totality-gate-execution-plan.md'],
        updatedAt: '2026-06-30T00:00:00.000Z',
        claimBoundary: 'invalid deferral cannot close',
      },
    ],
  });
}

function deferredLedger(): Record<string, unknown> {
  return baseLedger({
    ledgerId: 'PR-deferred',
    parentStoryId: 'B-parent-deferred',
    createdByStoryId: 'B-parent-deferred',
    updatedByStoryIds: ['B-parent-deferred'],
    requiredRowIds: ['M10', 'M11'],
    proofstoryContract: { acceptanceBindings: [{ id: 'deferred-roadmap', milestoneIds: ['M10', 'M11'] }] },
    rows: [
      {
        rowId: 'M10',
        title: 'Closed implementation',
        intentText: 'Implementation evidence closes only this row.',
        status: 'closed-by-implementation',
        childStoryId: 'B-child-closed',
        closureEvidence: [{ kind: 'logic_test', ref: 'closed-row', result: 'pass' }],
        materialRefs: ['packages/main/src/core/parent-roadmap-totality.ts'],
        claimBoundary: 'local implementation evidence only',
      },
      {
        rowId: 'M11',
        title: 'Human-approved deferral',
        intentText: 'A valid deferral stays visible and does not close runtime work.',
        status: 'deferred-with-human-approval',
        deferral: {
          approvedBy: 'human-reviewer',
          approvedAt: '2026-07-01T00:00:00.000Z',
          reason: 'Explicitly excluded from this local runtime baseline.',
          revisitTrigger: 'Revisit when the parent roadmap expands beyond the local baseline.',
          nonRuntimeBehaviorStatement: 'This does not implement runtime behavior.',
        },
        closureEvidence: [],
        materialRefs: ['docs/requirements/decisions/parent-roadmap-intent-totality-gate-execution-plan.md'],
        claimBoundary: 'human deferral is visible; no runtime closure is claimed',
      },
    ],
  });
}

function staleLedger(): Record<string, unknown> {
  return baseLedger({
    ledgerId: 'PR-stale',
    rows: [
      {
        rowId: 'M8',
        title: 'Stale evidence row',
        intentText: 'Closed row has stale material binding.',
        status: 'closed-by-implementation',
        childStoryId: 'B-child-stale',
        closureEvidence: [{ kind: 'logic_test', ref: 'old-run', result: 'pass' }],
        materialRefs: ['packages/main/src/core/parent-roadmap-totality.ts'],
        updatedAt: '2026-06-29T00:00:00.000Z',
        headHash: 'OLD',
        materialHash: 'OLD',
        storyFilesHash: 'OLD',
        claimBoundary: 'stale evidence cannot close',
      },
    ],
  });
}

function migrationLedger(): Record<string, unknown> {
  return baseLedger({
    schemaVersion: 'legacy.parent_roadmap.candidate',
    ledgerId: 'PR-B-43de-migration',
    parentStoryId: 'B-43de',
    originalIntentSnapshot: 'Historical parent candidate: parent governance is DONE while M4 is partial and M5-M12 remain open.',
    migration: { sourceStoryId: 'B-43de', reason: 'B-43de-shaped historical parent candidate' },
    requiredRowIds: M4_M12_ROW_IDS,
    rows: [
      { rowId: 'M4', title: 'Partial M4', intentText: 'M4 is only partially represented.', status: 'parent-governed', claimBoundary: 'partial parent governance' },
      ...Array.from({ length: 8 }, (_, index) => {
        const row = `M${index + 5}`;
        return {
          rowId: row,
          title: `${row} child story needed`,
          intentText: `${row} remains open in the historical roadmap.`,
          status: 'child-story-needed',
          claimBoundary: 'migration needed before closure',
        };
      }),
    ],
  });
}

function assertB43deClosedLedger(mod: RuntimeModule): void {
  const ledger = mod.buildParentRoadmapSampleCase('b-43de') as any;
  const rollup = mod.evaluateParentRoadmapLedger(ledger);
  assert.equal(rollup.parentStoryId, 'B-43de');
  assert.equal(rollup.allRowsClosed, true, 'B-43de M4-M12 ledger is fully closed');
  assert.equal(rollup.summaryClass, 'full_roadmap_complete');
  assert.equal(rollup.claimType, 'full-roadmap-claim');
  assert.deepEqual(rollup.openRows, []);
  assert.deepEqual(rollup.migrationRows, []);
  assert.deepEqual(M4_M12_ROW_IDS.filter((rowId) => !rollup.rowResults.some((row: any) => row.rowId === rowId && row.closed)), []);

  for (const rowId of M4_M12_ROW_IDS) {
    const row = ledger.rows.find((candidate: any) => candidate.rowId === rowId);
    assert.ok(row, `${rowId} exists in the B-43de closure ledger`);
    assert.equal(row.status, 'closed-by-existing-evidence', `${rowId} is closed by evidence`);
    assert.ok(Array.isArray(row.closureEvidence) && row.closureEvidence.length > 0, `${rowId} has closureEvidence`);
    assert.equal(typeof row.claimBoundary, 'string', `${rowId} has claimBoundary`);
    assert.ok(row.claimBoundary.trim().length > 0, `${rowId} claimBoundary is non-empty`);
    const commands = row.closureEvidence.map((entry: any) => entry.command).filter(Boolean);
    for (const command of B43DE_EXPECTED_COMMANDS[rowId]) {
      assert.ok(commands.includes(command), `${rowId} closureEvidence includes command ref ${command}`);
    }
    for (const entry of row.closureEvidence) {
      assert.equal(entry.result, 'pass', `${rowId} evidence result is pass`);
      assert.ok(typeof entry.ref === 'string' && entry.ref.includes(`B-e781:${rowId}:`), `${rowId} evidence ref binds B-e781 and row id`);
    }
    assert.doesNotMatch(JSON.stringify({
      claimBoundary: row.claimBoundary,
      closureEvidence: row.closureEvidence,
    }), DISALLOWED_CLAIM_PATTERN, `${rowId} must not claim retired server-backed completion vocabulary`);
  }
}

async function expectedRedParentOverclaim(): Promise<void> {
  const loaded = await tryLoadRuntime();
  if (!loaded.ok) {
    const root = initRoot();
    try {
      const cliFailure = runCli(root, 'parent_roadmap_status', { case: 'migration', json: true }, true);
      assert.match(
        `${loaded.reason}\n${cliFailure}`,
        /Cannot find module|Unknown command|not found|No handler/i,
        'pre-runtime red proof must show no trusted parent-roadmap status surface exists',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    console.log('expected-red parent-overclaim observed: runtime/CLI cannot certify full roadmap completion yet');
    return;
  }

  const rollup = loaded.mod.evaluateParentRoadmapLedger(partialLedger());
  const claim = loaded.mod.evaluateParentRoadmapClaim({
    rollup,
    summaryText: 'The full roadmap is complete and all M4-M12 rows are done.',
    mode: 'enforce',
  });
  assert.equal(rollup.allRowsClosed, false, 'open child row keeps allRowsClosed false');
  assert.equal(claim.allowed, false, 'full-roadmap wording is blocked when rows are open');
  console.log('expected-red parent-overclaim observed: full-roadmap wording is blocked for open child rows');
}

async function expectedRedTestFirst(): Promise<void> {
  const loaded = await tryLoadRuntime();
  assert.equal(loaded.ok, false, 'M1 test-first red commit must precede the runtime module');
  assert.match(loaded.reason, /Cannot find module|not found/i, 'missing runtime module is the expected pre-implementation red condition');
  console.log('expected-red test-first observed: smoke builds before runtime implementation exists');
}

async function runStateModel(mod: RuntimeModule): Promise<void> {
  assert.equal(mod.PARENT_ROADMAP_LEDGER_SCHEMA_VERSION, 'parent_roadmap.ledger.v1');
  assert.equal(mod.PARENT_ROLLUP_SCHEMA_VERSION, 'parent_roadmap.rollup.v1');

  const full = mod.evaluateParentRoadmapLedger(fullLedger(), { currentHeadHash: 'H1', currentMaterialHash: 'M1', currentStoryFilesHash: 'S1' });
  assert.equal(full.summaryClass, 'full_roadmap_complete');
  assert.equal(full.claimType, 'full-roadmap-claim');
  assert.equal(full.allRowsClosed, true);

  const invalidStatus = mod.evaluateParentRoadmapLedger(baseLedger({
    ledgerId: 'PR-bad-status',
    rows: [{ rowId: 'M-bad', title: 'Bad status', intentText: 'Bad status is invalid.', status: 'done-ish' }],
  }));
  assert.equal(invalidStatus.summaryClass, 'invalid_parent_rollup');
  assert.deepEqual(invalidStatus.invalidRows, ['M-bad']);
}

async function runEvaluator(mod: RuntimeModule): Promise<void> {
  assertB43deClosedLedger(mod);

  const partial = mod.evaluateParentRoadmapLedger(partialLedger());
  assert.equal(partial.allRowsClosed, false, 'caller-provided allRowsClosed=true is ignored');
  assert.equal(partial.claimType, 'no-full-roadmap-claim', 'caller-provided full-roadmap claimType is ignored');
  assert.equal(partial.summaryClass, 'partial_parent_done');
  assert.deepEqual(partial.openRows, ['M4', 'M5']);
  assert.ok(partial.rowResults.some((row: any) => row.rowId === 'M5' && row.closed === false));

  const blocked = mod.evaluateParentRoadmapLedger(blockedLedger());
  assert.equal(blocked.summaryClass, 'blocked_parent');
  assert.deepEqual(blocked.blockedRows, ['M6']);
  assert.equal(blocked.claimType, 'blocked-claim');

  const invalid = mod.evaluateParentRoadmapLedger(invalidLedger());
  assert.equal(invalid.summaryClass, 'invalid_parent_rollup');
  assert.deepEqual(invalid.invalidRows, ['M7']);
  assert.equal(invalid.allRowsClosed, false);

  const deferred = mod.evaluateParentRoadmapLedger(deferredLedger());
  assert.equal(deferred.summaryClass, 'partial_parent_done');
  assert.equal(deferred.claimType, 'no-full-roadmap-claim');
  assert.equal(deferred.allRowsClosed, false);
  assert.deepEqual(deferred.deferredRows, ['M11']);
  assert.ok(deferred.openRows.includes('M11'), 'valid human-approved deferral remains open and visible');
  const deferredRow = deferred.rowResults.find((row: any) => row.rowId === 'M11');
  assert.equal(deferredRow.closed, false, 'valid deferral does not count as closed runtime work');
  assert.ok(deferredRow.reasonCodes.includes('human_approved_deferral'));

  const stale = mod.evaluateParentRoadmapLedger(staleLedger(), { currentHeadHash: 'NEW', currentMaterialHash: 'NEW', currentStoryFilesHash: 'NEW' });
  assert.equal(stale.summaryClass, 'stale_parent_rollup');
  assert.deepEqual(stale.staleEvidenceRows, ['M8']);
  assert.equal(stale.allRowsClosed, false);

  const shrunken = mod.evaluateParentRoadmapLedger(shrunkenRequiredInventoryLedger());
  assert.notEqual(shrunken.summaryClass, 'full_roadmap_complete', 'required inventory shrinkage cannot return full roadmap completion');
  assert.equal(shrunken.allRowsClosed, false);
  assert.ok(shrunken.invalidRows.includes('M5'), 'missing required rows are reported as invalid');
  assert.ok(shrunken.openRows.includes('M5'), 'missing required rows stay open');
  assert.ok(shrunken.rowResults.some((row: any) => row.rowId === 'M5' && row.reasonCodes.includes('missing_required_row')));

  const missingClosure = mod.evaluateParentRoadmapLedger(missingClosureEvidenceLedger());
  assert.equal(missingClosure.allRowsClosed, false);
  const missingClosureRow = missingClosure.rowResults.find((row: any) => row.rowId === 'M9');
  assert.equal(missingClosureRow.evidenceState, 'missing');
  assert.ok(missingClosureRow.reasonCodes.includes('missing_closure_evidence'));
  assert.ok(missingClosureRow.nextActions.some((action: string) => /attach closure evidence/i.test(action)));
}

async function runClaimConsumer(mod: RuntimeModule): Promise<void> {
  const partial = mod.evaluateParentRoadmapLedger(partialLedger());
  const overclaim = mod.evaluateParentRoadmapClaim({
    rollup: partial,
    summaryText: 'Full roadmap complete: all M4-M12 milestones are done.',
    mode: 'enforce',
  });
  assert.equal(overclaim.allowed, false, 'summary overclaim is blocked');
  assert.match(overclaim.reasons.join('\n'), /no-full-roadmap|open row|M5/i);

  const contradictory = mod.evaluateParentRoadmapClaim({
    rollup: partial,
    summaryText: 'Parent governance complete; roadmap not complete. Full roadmap complete: all M4-M12 rows are done.',
    mode: 'enforce',
  });
  assert.equal(contradictory.allowed, false, 'later full-roadmap wording is blocked even after honest partial wording');

  const disclaimer = mod.evaluateParentRoadmapClaim({
    rollup: partial,
    summaryText: 'No full-roadmap claim. Do not say the full roadmap is complete.',
    mode: 'enforce',
  });
  assert.equal(disclaimer.allowed, true, 'explicit negated/disclaimer wording is not treated as a full-roadmap claim');

  const disclaimerThenClaim = mod.evaluateParentRoadmapClaim({
    rollup: partial,
    summaryText: 'No full-roadmap claim. Full roadmap complete.',
    mode: 'enforce',
  });
  assert.equal(disclaimerThenClaim.allowed, false, 'a later explicit full-roadmap claim still blocks after a disclaimer');

  const disclaimerButClaim = mod.evaluateParentRoadmapClaim({
    rollup: partial,
    summaryText: 'No full-roadmap claim, but Full roadmap complete.',
    mode: 'enforce',
  });
  assert.equal(disclaimerButClaim.allowed, false, 'a same-sentence contrasting full-roadmap claim still blocks after a disclaimer');

  const honestPartial = mod.evaluateParentRoadmapClaim({
    rollup: partial,
    summaryText: 'Parent governance complete; roadmap not complete. Remaining child-story-needed rows: M5.',
    mode: 'enforce',
  });
  assert.equal(honestPartial.allowed, true, 'honest partial_parent_done wording is allowed');

  const full = mod.evaluateParentRoadmapLedger(fullLedger(), { currentHeadHash: 'H1', currentMaterialHash: 'M1', currentStoryFilesHash: 'S1' });
  const fullClaim = mod.evaluateParentRoadmapClaim({
    rollup: full,
    summaryText: 'Full roadmap complete; every parent roadmap row is closed.',
    mode: 'enforce',
  });
  assert.equal(fullClaim.allowed, true, 'full wording is allowed only for a full-roadmap rollup');
}

async function runProofStoryBinding(mod: RuntimeModule): Promise<void> {
  const partial = mod.evaluateParentRoadmapLedger(partialLedger());
  const binding = mod.evaluateParentRoadmapProofStoryBinding({
    ledger: partialLedger(),
    rollup: partial,
    originalIntentSnapshot: {
      requestHash: 'sha256:parent',
      sourceText: 'Deliver all parent roadmap rows M4-M12.',
      normalizedOutcome: 'All rows are complete only when every child row is closed.',
      acceptanceClaim: 'Full roadmap completion requires allRowsClosed=true.',
    },
    proofstoryContract: { acceptanceBindings: [{ id: 'parent', milestoneIds: ['M4', 'M5'] }] },
    summaryText: 'The full roadmap is complete.',
    mode: 'enforce',
  });
  assert.equal(binding.status, 'fail');
  assert.equal(binding.blocking, true);
  assert.ok(binding.gaps.some((gap: any) => gap.code === 'parent_roadmap_summary_overclaim'));

  const honest = mod.evaluateParentRoadmapProofStoryBinding({
    ledger: partialLedger(),
    rollup: partial,
    originalIntentSnapshot: {
      requestHash: 'sha256:parent',
      sourceText: 'Deliver all parent roadmap rows M4-M12.',
      normalizedOutcome: 'Parent governance is separate from full roadmap completion.',
      acceptanceClaim: 'Partial parent DONE must keep open rows visible.',
    },
    proofstoryContract: { acceptanceBindings: [{ id: 'parent', milestoneIds: ['M4', 'M5'] }] },
    summaryText: 'Parent governance complete; roadmap not complete. Remaining row: M5.',
    mode: 'enforce',
  });
  assert.equal(honest.status, 'pass');

  const externalContractLedger = externalProofStoryContractOnlyLedger();
  const shrunkenRollup = mod.evaluateParentRoadmapLedger(externalContractLedger);
  assert.equal(shrunkenRollup.summaryClass, 'full_roadmap_complete', 'the shrunken one-row ledger is unsafe without external inventory');

  const externalInventoryRollup = mod.evaluateParentRoadmapLedger(externalContractLedger, { requiredRowIds: M4_M12_ROW_IDS });
  assert.equal(externalInventoryRollup.summaryClass, 'invalid_parent_rollup');
  assert.ok(externalInventoryRollup.invalidRows.includes('M5'));
  assert.ok(externalInventoryRollup.rowResults.some((row: any) => row.rowId === 'M5' && row.reasonCodes.includes('missing_required_row')));

  const externalBinding = mod.evaluateParentRoadmapProofStoryBinding({
    ledger: externalContractLedger,
    rollup: shrunkenRollup,
    originalIntentSnapshot: {
      requestHash: 'sha256:parent-external',
      sourceText: 'Deliver all parent roadmap rows M4-M12.',
      normalizedOutcome: 'Full roadmap completion requires M4-M12 to be represented and closed.',
      acceptanceClaim: 'External ProofStory inventory M4-M12 must bind into the parent roadmap rollup.',
    },
    proofstoryContract: externalM4M12ProofStoryContract(),
    summaryText: 'Full roadmap complete.',
    mode: 'enforce',
  });
  assert.equal(externalBinding.status, 'fail', 'external ProofStory inventory blocks shrunken full-roadmap binding');
  assert.equal(externalBinding.blocking, true);
  assert.equal(externalBinding.consumedRollup.summaryClass, 'invalid_parent_rollup');
  assert.equal(externalBinding.consumedRollup.claimType, 'no-full-roadmap-claim');
  assert.ok(externalBinding.consumedRollup.invalidRows.includes('M5'));
  assert.ok(externalBinding.gaps.some((gap: any) => gap.code === 'parent_roadmap_summary_overclaim'));
}

async function runCliCase(mod: RuntimeModule): Promise<void> {
  const root = initRoot();
  try {
    const status = JSON.parse(runCli(root, 'parent_roadmap_status', { case: 'partial', json: true }));
    assert.equal(status.rollup.summaryClass, 'partial_parent_done');
    assert.equal(status.rollup.claimType, 'no-full-roadmap-claim');
    assert.equal(status.rollup.allRowsClosed, false);

    const evaluated = JSON.parse(runCli(root, 'parent_roadmap_evaluate', {
      ledger: fullLedger(),
      currentHeadHash: 'H1',
      currentMaterialHash: 'M1',
      currentStoryFilesHash: 'S1',
      summaryText: 'Full roadmap complete; every parent roadmap row is closed.',
      json: true,
    }));
    assert.equal(evaluated.rollup.summaryClass, 'full_roadmap_complete');
    assert.equal(evaluated.claim.allowed, true);

    const enforceFailure = runCli(root, 'parent_roadmap_status', {
      case: 'partial',
      summaryText: 'Parent governance complete; roadmap not complete. Full roadmap complete: all M4-M12 rows are done.',
      mode: 'enforce',
      json: true,
    }, true);
    assert.match(enforceFailure, /parent-roadmap enforce failed/i, 'enforce mode must fail closed for full-roadmap overclaims');
    assert.match(enforceFailure, /parent_roadmap_summary_overclaim|no-full-roadmap/i);

    const externalContractStatus = JSON.parse(runCli(root, 'parent_roadmap_evaluate', {
      ledger: externalProofStoryContractOnlyLedger(),
      proofstoryContract: externalM4M12ProofStoryContract(),
      summaryText: 'Full roadmap complete.',
      mode: 'warn',
      json: true,
    }));
    assert.equal(externalContractStatus.rollup.summaryClass, 'invalid_parent_rollup', 'handler rollup binds external ProofStory inventory');
    assert.equal(externalContractStatus.rollup.claimType, 'no-full-roadmap-claim');
    assert.ok(externalContractStatus.rollup.invalidRows.includes('M5'));
    assert.equal(externalContractStatus.proofstoryBinding.consumedRollup.summaryClass, 'invalid_parent_rollup');
    assert.equal(externalContractStatus.proofstoryBinding.consumedRollup.claimType, 'no-full-roadmap-claim');
    assert.ok(externalContractStatus.proofstoryBinding.consumedRollup.invalidRows.includes('M5'));

    const externalContractFailure = runCli(root, 'parent_roadmap_evaluate', {
      ledger: externalProofStoryContractOnlyLedger(),
      proofstoryContract: externalM4M12ProofStoryContract(),
      summaryText: 'Full roadmap complete.',
      mode: 'enforce',
      json: true,
    }, true);
    assert.match(externalContractFailure, /parent-roadmap enforce failed/i, 'external ProofStory inventory must fail closed in enforce mode');
    assert.match(externalContractFailure, /parent_roadmap_summary_overclaim|Invalid rows: M5|M5/i);

    const legacyMigration = JSON.parse(runCli(root, 'parent_roadmap_status', { case: 'migration', json: true }));
    assert.equal(legacyMigration.rollup.summaryClass, 'migration_needed');
    assert.equal(legacyMigration.rollup.allRowsClosed, false);
    assert.ok(legacyMigration.rollup.openRows.includes('M5'), 'explicit legacy migration sample remains open');

    const sample = mod.evaluateParentRoadmapLedger(mod.buildParentRoadmapSampleCase('migration'));
    assert.equal(sample.summaryClass, 'migration_needed');

    const b43deCase = JSON.parse(runCli(root, 'parent_roadmap_status', { case: 'b-43de', json: true }));
    assert.equal(b43deCase.rollup.summaryClass, 'full_roadmap_complete');
    assert.equal(b43deCase.rollup.allRowsClosed, true);
    assert.deepEqual(b43deCase.rollup.openRows, []);

    const b43deStoryStatus = JSON.parse(runCli(root, 'parent_roadmap_status', { storyId: 'B-43de', json: true }));
    assert.equal(b43deStoryStatus.rollup.parentStoryId, 'B-43de');
    assert.equal(b43deStoryStatus.rollup.summaryClass, 'full_roadmap_complete');
    assert.equal(b43deStoryStatus.rollup.allRowsClosed, true);
    assert.deepEqual(b43deStoryStatus.rollup.openRows, []);
    for (const rowId of M4_M12_ROW_IDS) {
      assert.ok(b43deStoryStatus.rollup.rowResults.some((row: any) => row.rowId === rowId && row.closed), `storyId B-43de closes ${rowId}`);
    }

    const unrelated = runCli(root, 'parent_roadmap_status', { storyId: 'B-unrelated', json: true }, true);
    assert.match(
      unrelated,
      /No parent roadmap ledger is registered for storyId B-unrelated/,
      'unrelated single-story work must not be auto-classified as a parent roadmap',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runMigration(mod: RuntimeModule): Promise<void> {
  const migration = mod.evaluateParentRoadmapLedger(migrationLedger());
  assert.equal(migration.summaryClass, 'migration_needed');
  assert.equal(migration.allRowsClosed, false);
  assert.equal(migration.claimType, 'no-full-roadmap-claim');
  assert.ok(migration.openRows.includes('M5'), 'B-43de-shaped M5 remains open');
  assert.ok(migration.nextActions.some((action: string) => /migration|M4|M12|child/i.test(action)));

  const claim = mod.evaluateParentRoadmapClaim({
    rollup: migration,
    summaryText: 'B-43de finished the full strengthening roadmap.',
    mode: 'enforce',
  });
  assert.equal(claim.allowed, false, 'historical migration candidate is never full');

  const migrationSample = mod.evaluateParentRoadmapLedger(mod.buildParentRoadmapSampleCase('migration'));
  assert.equal(migrationSample.summaryClass, 'migration_needed');
  assert.equal(migrationSample.allRowsClosed, false);
  assert.ok(migrationSample.openRows.includes('M5'), 'explicit migration sample keeps M5 open');
}

async function runNormal(): Promise<void> {
  const mod = await loadRuntime();
  const selected = parseCase();
  const cases = selected === 'all' ? allCases : [selected];
  for (const item of cases) {
    if (item === 'state-model') await runStateModel(mod);
    else if (item === 'evaluator') await runEvaluator(mod);
    else if (item === 'claim-consumer') await runClaimConsumer(mod);
    else if (item === 'proofstory-binding') await runProofStoryBinding(mod);
    else if (item === 'cli') await runCliCase(mod);
    else if (item === 'migration') await runMigration(mod);
  }
  console.log(`parent-roadmap totality smoke passed (${selected})`);
}

const expectedRed = parseExpectedRed();
if (expectedRed === 'parent-overclaim') await expectedRedParentOverclaim();
else if (expectedRed === 'test-first') await expectedRedTestFirst();
else await runNormal();
