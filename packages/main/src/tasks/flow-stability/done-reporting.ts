import { strict as assert } from 'node:assert';

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resetConfigCache } from '../../core/config.js';

import { currentGitHead, currentMaterialHash } from '../../core/evidence-freshness.js';

import { signDeliveryCheck } from '../../core/delivery-check-hash.js';

import type { TestEvidenceData } from '../../core/types.js';

import { buildDoneChecklist, renderDoneChecklist } from '../../core/done-oracle.js';

import { createSessionHandlers } from '../../handlers/session.js';
import { buildDoneClosureRunbook } from '../../handlers/done-closure.js';

import { ORIGINAL_TASKS_DIR } from './support.js';
import { createReviewStore, git, seedReviewRuns, makeReviewPass, write } from './support.js';

export function renderedDetails(result: { details: string[] }): string {
  return result.details.join('\n');
}

export function assertDoneChecklistUsesStableOracleRows(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-oracle-row-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'proofOrStop@example.test']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, [
      'proof-or-stop-review-concept',
      'proof-or-stop-review-quality',
      'proof-or-stop-review-test-coverage',
    ]);

    const testStory = store.readStory(storyId);
    testStory.phase = 'TEST';
    store.writeStory(storyId, testStory);
    store.writeReview(storyId, {
      reviews: [{
        timestamp: reviewRound,
        issueCount: 0,
        blockerCount: 0,
        issues: [],
      }],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'proof-or-stop-review-concept', reviewRound, '030', runIds.get('proof-or-stop-review-concept')!),
        makeReviewPass(storyId, 'proof-or-stop-review-quality', reviewRound, '031', runIds.get('proof-or-stop-review-quality')!),
        makeReviewPass(storyId, 'proof-or-stop-review-test-coverage', reviewRound, '032', runIds.get('proof-or-stop-review-test-coverage')!),
      ],
    });
    const evidence: TestEvidenceData = {
      command: 'proof-or-stop validate --json',
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: '2026-04-27T12:25:00.000Z',
    };
    store.writeTestEvidence(storyId, evidence);
    write(root, 'packages/main/src/core/dirty.ts', 'export const dirty = true;\n');
    write(root, '.proof-or-stop/activity.jsonl', '{"event":"runtime"}\n');
    write(root, '.proof-or-stop/story/actives/B-smoke/dirty-owner.json', '{}\n');
    write(root, 'packages/main/tests/fixtures/dirty-owner.json', '{}\n');
    write(root, 'packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json', '{}\n');

    const rows = buildDoneChecklist(storyId, store, root);
    const byId = new Map(rows.map(row => [row.id, row]));
    assert.deepEqual(
      ['id', 'status', 'detail', 'hint', 'source', 'blocking'].every(key => key in (byId.get('delivery-check') ?? {})),
      true,
      'delivery-check row should expose the stable oracle contract',
    );
    assert.equal(byId.get('git-working-tree')?.status, 'fail');
    assert.equal(byId.get('git-working-tree')?.source, 'git status --porcelain');
    assert.equal(byId.get('git-working-tree')?.blocking, true);
    // B-4b22: detail now follows the policy summary format:
    //   "fail: blocking=N (...); passed=M (...)"
    assert.match(byId.get('git-working-tree')?.detail ?? '', /^fail: blocking=/);
    assert.match(byId.get('git-working-tree')?.detail ?? '', /passed=/);
    assert.match(byId.get('git-working-tree')?.detail ?? '', /proof_or_stop_metadata_changes=/);
    // The three broker-backed reviewer dispatches above intentionally append
    // three runtime audit artifacts in addition to this test's activity row.
    assert.match(byId.get('git-working-tree')?.detail ?? '', /runtime_artifact_changes=4/);
    assert.match(byId.get('git-working-tree')?.detail ?? '', /fixture_changes=1/);
    assert.match(byId.get('git-working-tree')?.detail ?? '', /unexpected_dirty_files=1/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /packages\/main\/src\/core\/dirty\.ts/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /material_source_changes/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /proof_or_stop_metadata_changes/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /runtime_artifact_changes/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /fixture_changes/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /unexpected_dirty_files/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /packages\/main\/tests\/output\/bl21_lacz_ecoli_minicell\/prodenovo_viewer\.json/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /side-effect-free by default|side-effect-free|PROOF_OR_STOP_WRITE/);
    assert.match(byId.get('delivery-check')?.hint ?? '', /delivery_check_set/);
    assert.match(byId.get('delivery-check')?.hint ?? '', /agentId=proof-or-stop-review-delivery/);
    assert.match(byId.get('delivery-check')?.hint ?? '', /main agent must not self-sign/);
    assert.equal(byId.get('delivery-check')?.source, 'delivery-check.json');
    assert.equal(byId.get('story-summary')?.status, 'fail');
    assert.equal(byId.get('story-summary')?.source, 'summary.json');
    assert.equal(byId.get('story-summary')?.blocking, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertDoneClosureProjectionSeparatesAuthority(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-done-closure-projection-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'proofOrStop@example.test']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);

    const testStory = store.readStory(storyId);
    testStory.phase = 'TEST';
    store.writeStory(storyId, testStory);
    store.writeTestEvidence(storyId, {
      command: 'proof-or-stop validate --json',
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: '2026-05-15T12:25:00.000Z',
      headHash: currentGitHead(root),
      materialHash: currentMaterialHash(root),
      verificationCoverage: {
        total: 0,
        required: 0,
        covered: 0,
        missingRequired: 0,
        entries: [],
      },
    });

    const runbook = buildDoneClosureRunbook({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }, storyId);
    const byId = new Map(runbook.blockers.map(row => [row.id, row]));

    assert.equal(runbook.schemaVersion, 'proof-or-stop.done_closure.v1');
    assert.equal(runbook.phase, 'TEST');
    assert.equal(runbook.canAttemptDone, false, 'TEST PASS with missing closure artifacts must not be DONE-ready');
    assert.equal(byId.get('test-evidence')?.status, 'pass');
    assert.equal(byId.get('delivery-check')?.status, 'fail', 'missing delivery-check must be projected as blocking');
    assert.equal(byId.get('story-summary')?.status, 'fail', 'missing summary must be projected as blocking');
    assert.equal(runbook.localNonAuthorityAudit.status, 'blocked');
    assert.equal(runbook.localAssurance.admissibilityStatus, 'blocked');
    assert.equal(runbook.localAssurance.assuranceLevel, 'local');
    assert.equal(JSON.stringify(runbook).includes('"authorityDone":true'), false);
    assert.equal(JSON.stringify(runbook).includes('"productionDone":true'), false);
    assert.equal(JSON.stringify(runbook).includes('"fullAuthorityDone":true'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

export function assertDoneOracleSameSource(): void {
  // --- 2. Structural same-source check (static import grep) ---
  // At runtime this smoke runs from dist/tasks/; sources live under src/.
  // Walk up from <pkg>/dist/tasks/ to <pkg>/, then into src/.
  const srcRoot = join(resolve(ORIGINAL_TASKS_DIR, '..', '..'), 'src');
  const storyAdvanceSrc = readFileSync(join(srcRoot, 'handlers', 'story-advance.ts'), 'utf-8');
  const sessionSrc = readFileSync(join(srcRoot, 'handlers', 'session.ts'), 'utf-8');
  assert.match(
    storyAdvanceSrc,
    /buildDoneChecklist[\s\S]*?from '\.\.\/core\/done-oracle\.js'/,
    'story-advance.ts must import buildDoneChecklist from core/done-oracle.js',
  );
  assert.match(
    sessionSrc,
    /buildDoneChecklist[\s\S]*?from '\.\.\/core\/done-oracle\.js'/,
    'session.ts must import buildDoneChecklist from core/done-oracle.js',
  );
  // The DONE oracle implementation must NOT live in story-advance.ts anymore —
  // only a thin re-export plus the gate call site are allowed.
  assert.doesNotMatch(
    storyAdvanceSrc,
    /export function buildDoneChecklist\(/,
    'buildDoneChecklist must have exactly one implementation (in core/done-oracle.ts), not story-advance.ts',
  );
  // done-oracle.ts must not import story-advance.ts (no circular import — preMortem #2).
  const doneOracleSrc = readFileSync(join(srcRoot, 'core', 'done-oracle.ts'), 'utf-8');
  const doneOracleImportLines = doneOracleSrc
    .split('\n')
    .filter(l => l.trimStart().startsWith('import'))
    .join('\n');
  assert.doesNotMatch(
    doneOracleImportLines,
    /story-advance/,
    'core/done-oracle.ts must not import from handlers/story-advance.js (circular import guard)',
  );
  // B-37e9 F-001: core/ must not depend upward on handlers/. done-oracle.ts is a
  // core module; any `from '../handlers/...'` import is a layer violation. The
  // delivery-check hash primitives were extracted to core/delivery-check-hash.ts
  // precisely so this assertion can stay clean.
  assert.doesNotMatch(
    doneOracleImportLines,
    /from '\.\.\/handlers\//,
    'core/done-oracle.ts must not import from any handlers/ module (core→handlers layer violation)',
  );
  assert.match(
    doneOracleImportLines,
    /evaluateDonePredicates.*from '\.\/machine\.js'/,
    'DONE preflight must import the shared DONE predicate source',
  );
  assert.match(
    doneOracleSrc,
    /const donePredicates = completedSnapshot \? null : \[\.\.\.evaluateDonePredicates\(\{ storyId, store, projectRoot: root, gitCwd \}\)\];/,
    'Active DONE preflight must evaluate shared predicates with the current root, story and git cwd',
  );
  assert.match(
    doneOracleSrc,
    /const reviewVerdict = donePredicateValue<ReturnType<typeof evaluateReviewVerdict>>\(donePredicates, 'review-verdict'\);/,
    'DONE preflight review-verdict row must consume the already evaluated shared verdict',
  );
  assert.match(
    doneOracleSrc,
    /const finishDecisionRead = donePredicates \? donePredicateValue<ReturnType<typeof inspectDevMemoryFinishDecision>>\(donePredicates, 'dev-memory-finish-decision'\) : null;/,
    'DONE preflight finish-decision row must consume the already evaluated shared presence fact',
  );
  assert.match(doneOracleSrc, /const finishDecision = finishDecisionRead\?\.record;/, 'DONE finish decision must read the shared inspected record');
  assert.match(doneOracleSrc, /const unsupportedFinishDecision = finishDecisionRead\?\.unsupportedIdentity;/, 'unsupported finish identity must remain fail closed');
  assert.match(doneOracleSrc, /const completedSnapshot = store\.readStory\(storyId\)\.phase === 'DONE' \? options\.completedSnapshot : undefined;/,
    'Historical presentation must not exempt TEST admission');

  // --- 1 & 3. Behavioral same-source + regression baseline ---
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-done-oracle-same-source-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'proofOrStop@example.test']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    seedReviewRuns(root, store, storyId, reviewRound, [
      'proof-or-stop-review-concept',
      'proof-or-stop-review-quality',
      'proof-or-stop-review-test-coverage',
    ]);

    const testStory = store.readStory(storyId);
    testStory.phase = 'TEST';
    store.writeStory(storyId, testStory);
    const evidence: TestEvidenceData = {
      command: 'proof-or-stop validate --json',
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: '2026-05-15T12:25:00.000Z',
    };
    store.writeTestEvidence(storyId, evidence);

    // Path A: the DONE gate path (phase-gates.ts imports these from done-oracle.ts).
    const gateRows = buildDoneChecklist(storyId, store, root);
    const gateRendered = renderDoneChecklist(storyId, gateRows);
    assert.ok(gateRendered.startsWith(`DONE Gate Checklist (${storyId}):`), 'DONE gate rendering header stable');

    // Path B: the real session_brief handler (session.ts imports the same module).
    const brief = createSessionHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).session_brief({ concise: true });

    // session_brief renders the DONE pre-check section as:
    //   ## DONE pre-check
    //     [PASS|FAIL|warn] <label>[: <detail>]
    const briefLines = brief.split('\n');
    const preCheckIdx = briefLines.findIndex(l => l.trim() === '## DONE pre-check');
    assert.notEqual(preCheckIdx, -1, 'session_brief must emit a DONE pre-check section for a TEST-phase story');
    const sessionRowLines: string[] = [];
    for (let i = preCheckIdx + 1; i < briefLines.length; i++) {
      const line = briefLines[i];
      if (/^\s{2}\[(PASS|FAIL|warn)\]\s/.test(line)) {
        sessionRowLines.push(line.trim());
      } else if (line.trim().startsWith('## ')) {
        break;
      }
    }

    // The DONE gate and session_brief must emit the SAME number of rows in the
    // SAME order — both consume buildDoneChecklist from core/done-oracle.ts.
    assert.equal(
      sessionRowLines.length,
      gateRows.length,
      `session_brief DONE pre-check row count (${sessionRowLines.length}) must match the DONE gate (${gateRows.length})`,
    );
    for (let i = 0; i < gateRows.length; i++) {
      const row = gateRows[i];
      const marker = row.status === 'pass' ? 'PASS' : (row.status === 'fail' ? 'FAIL' : 'warn');
      // The git-working-tree row's detail embeds an audit-line counter that
      // grows each call (buildDoneChecklist's audit writer appends to
      // process-events.jsonl). That makes the *detail* call-order-sensitive
      // regardless of same-source — so compare its stable id/label/status only.
      if (row.id === 'git-working-tree') {
        assert.match(
          sessionRowLines[i],
          new RegExp(`^\\[${marker}\\] ${row.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
          `DONE row ${i} (${row.id}) label/status must render identically in session_brief and the DONE gate`,
        );
        continue;
      }
      const expected = `[${marker}] ${row.label}${row.detail ? `: ${row.detail}` : ''}`;
      assert.equal(
        sessionRowLines[i],
        expected,
        `DONE row ${i} (${row.id}) must render identically in session_brief and the DONE gate`,
      );
    }

    // --- 3. Regression baseline: explicit row shape for this fixture ---
    // The fixture has PASS test-evidence but is missing delivery-check.json /
    // summary.json — these stable ids/status/blocking values catch a silent
    // behavior change in the relocated function body.
    const byId = new Map(gateRows.map(r => [r.id, r]));
    assert.equal(byId.get('test-evidence')?.status, 'pass', 'baseline: test-evidence passes');
    assert.equal(byId.get('bugs-fixed')?.status, 'pass', 'baseline: no bugs → pass');
    assert.equal(byId.get('dev-memory-finish-decision')?.status, 'fail', 'baseline: missing finish decision fails preflight');
    assert.match(byId.get('dev-memory-finish-decision')?.detail ?? '', /missing_dev_memory_finish_decision/);
    assert.equal(byId.get('review-verdict')?.status, 'fail', 'baseline: reviewer runs without a pass fail the shared verdict');
    assert.match(byId.get('review-verdict')?.detail ?? '', /review_evidence_missing/);
    assert.equal(byId.get('review-verdict')?.source, 'review-runs.json + review-passes.json + findings.json');
    assert.equal(byId.get('delivery-check')?.status, 'fail', 'baseline: missing delivery-check → fail');
    assert.equal(byId.get('delivery-check')?.blocking, true, 'baseline: missing delivery-check is blocking');
    assert.equal(byId.get('story-summary')?.status, 'fail', 'baseline: missing summary → fail');
    assert.equal(byId.get('story-summary')?.blocking, true, 'baseline: missing summary is blocking');
    assert.equal(byId.get('declared-artifacts-referenced')?.status, 'pass', 'baseline: no declarations → pass');
    assert.equal(byId.get('declared-artifacts-committed')?.status, 'pass', 'baseline: no declarations → pass');

    const closingSelfCheck = {
      hasRealMachineTest: true,
      hasEdgeCaseCoverage: true,
      hasUnresolvedTodos: false,
      summary: 'DONE oracle delivery branch smoke',
    };
    const realMachineTests = [{
      featureId: 'flow-stability-smoke',
      transcript: 'npm --prefix packages/main run test:flow-stability-smoke',
    }];

    store.writeDeliveryCheck(storyId, {
      storyId,
      checkedAt: '2026-05-15T12:30:00.000Z',
      reviewRound,
      agentId: 'proof-or-stop-review-delivery',
      docsPromises: [],
      realMachineTests,
      closingSelfCheck,
      _hash: 'tampered-delivery-check-hash',
    });
    const hashMismatchRows = buildDoneChecklist(storyId, store, root);
    const hashMismatchRow = new Map(hashMismatchRows.map(r => [r.id, r])).get('delivery-check');
    assert.equal(hashMismatchRow?.status, 'fail', 'delivery-check hash mismatch must fail');
    assert.match(hashMismatchRow?.detail ?? '', /^delivery-check\.json _hash mismatch — Cannot enter DONE:/);
    assert.match(hashMismatchRow?.detail ?? '', /\[delivery_check_tampered\]/);
    assert.equal(hashMismatchRow?.source, 'delivery-check.json._hash');
    assert.match(hashMismatchRow?.hint ?? '', /Re-run the proof-or-stop-review-delivery reviewer to generate a new delivery-check\.json/);

    const docsPromises = [{
      docPath: 'docs/requirements/decisions/flow-stability-smoke.md',
      promise: 'Document the flow-stability delivery assertion.',
      status: 'unverified' as const,
    }];
    const deliveryHeadHash = currentGitHead(root);
    const deliveryMaterialHash = currentMaterialHash(root);
    assert.ok(deliveryHeadHash, 'smoke repo must have git HEAD for delivery-check freshness');
    assert.ok(deliveryMaterialHash, 'smoke repo must have material hash for delivery-check freshness');
    store.writeDeliveryCheck(storyId, {
      storyId,
      checkedAt: '2026-05-15T12:31:00.000Z',
      headHash: deliveryHeadHash,
      materialHash: deliveryMaterialHash,
      reviewRound,
      agentId: 'proof-or-stop-review-delivery',
      docsPromises,
      realMachineTests,
      closingSelfCheck,
      _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, reviewRound, deliveryMaterialHash),
    });
    const unverifiedDocsRows = buildDoneChecklist(storyId, store, root);
    const unverifiedDocsRow = new Map(unverifiedDocsRows.map(r => [r.id, r])).get('delivery-check');
    assert.equal(unverifiedDocsRow?.status, 'fail', 'unverified docsPromise must fail');
    assert.match(unverifiedDocsRow?.detail ?? '', /^1 docsPromise entries are unverified and not waived — Cannot enter DONE:/);
    assert.match(unverifiedDocsRow?.detail ?? '', /\[unverified_promise\]/);
    assert.equal(unverifiedDocsRow?.source, 'delivery-check.json.docsPromises');
    assert.match(unverifiedDocsRow?.hint ?? '', /Use delivery_waiver_add to write a waiver/);
    assert.match(unverifiedDocsRow?.hint ?? '', /re-run the proof-or-stop-review-delivery reviewer to add verification evidence/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}
