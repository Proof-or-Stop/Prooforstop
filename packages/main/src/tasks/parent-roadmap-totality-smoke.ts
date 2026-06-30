#!/usr/bin/env node
/**
 * Smoke coverage for the parent-roadmap intent-totality gate.
 *
 * M1 deliberately lands before the runtime evaluator exists. Keep the runtime
 * import dynamic and computed so this file can build in the red/repro commit.
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

  const stale = mod.evaluateParentRoadmapLedger(staleLedger(), { currentHeadHash: 'NEW', currentMaterialHash: 'NEW', currentStoryFilesHash: 'NEW' });
  assert.equal(stale.summaryClass, 'stale_parent_rollup');
  assert.deepEqual(stale.staleEvidenceRows, ['M8']);
  assert.equal(stale.allRowsClosed, false);
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

    const sample = mod.evaluateParentRoadmapLedger(mod.buildParentRoadmapSampleCase('migration'));
    assert.equal(sample.summaryClass, 'migration_needed');
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
