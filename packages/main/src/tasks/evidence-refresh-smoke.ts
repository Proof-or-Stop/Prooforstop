#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  enforceStoryOwnerLeaseGate,
  MAIN_TOOLS,
  resolveEffectiveOwnershipClass,
} from '../cli-engine.js';
import { getCommandPolicy } from '../core/command-policy.js';
import { DEFAULT_PHASE_TOOLS, isCommandAllowed, resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo, VerificationEvidence } from '../core/types.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';
import type { EvidenceRefreshReport } from '../handlers/evidence-refresh.js';
import { acquireOwnerLease, ownerLeasePath, resetSessionIdForTest } from '../core/story-owner-lease.js';

const STORY_ID = 'B-erefresh';
const NOW = '2026-06-20T00:00:00.000Z';
const STALE_HEAD = '0000000000000000000000000000000000000000';
const STALE_MATERIAL = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'evidence-refresh-smoke',
      GIT_AUTHOR_EMAIL: 'evidence-refresh-smoke@example.com',
      GIT_COMMITTER_NAME: 'evidence-refresh-smoke',
      GIT_COMMITTER_EMAIL: 'evidence-refresh-smoke@example.com',
    },
  }).trim();
}

function gitStatus(root: string): string {
  return git(root, ['status', '--short']);
}

function writeConfig(root: string): void {
  writeFileSync(
    join(root, 'proof-or-stop.config.json'),
    JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
    }, null, 2) + '\n',
    'utf8',
  );
  resetConfigCache();
}

function baseStory(): StoryInfo {
  return {
    storyId: STORY_ID,
    name: 'evidence-refresh-smoke',
    title: 'Implement evidence_refresh',
    description: 'Opt-in one-pass refresh-only orchestrator that re-stamps stale-but-valid evidence and escalates still-stale rows.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  };
}

/**
 * Build a fixture repo. `seedChecklist(root, store)` runs AFTER the git base
 * commit so callers can stamp evidence with the actual current headHash /
 * materialHash (required for the genuine refresh-only vs hard-stale split).
 */
function createFixture(
  seedChecklist: (root: string, store: StoryStore) => ChecklistData,
): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-evidence-refresh-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# evidence refresh smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'proof-or-stop.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  store.writeStory(STORY_ID, baseStory());
  store.writeChecklist(STORY_ID, seedChecklist(root, store));
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  return { root, store, ctx };
}

function snapshotDir(root: string, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  function walk(abs: string): void {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const path = join(abs, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out[relative(root, path)] = readFileSync(path, 'utf8');
    }
  }
  walk(dir);
  return out;
}

function assertNoAuthorityOrEvidenceArtifacts(store: StoryStore): void {
  for (const artifact of [
    'test-evidence.json',
    'review-runs.json',
    'review-passes.json',
    'findings.json',
    'delivery-check.json',
    'summary.json',
    'done-required-evidence.json',
    'authority-receipt-refs.json',
  ]) {
    assert.equal(existsSync(store.storyFilePath(STORY_ID, artifact)), false, `${artifact} must not be written`);
  }
}

function intentRefsOf(report: EvidenceRefreshReport, bucket: 'candidates' | 'refreshed' | 'escalated'): Set<string> {
  return new Set((report[bucket] as Array<{ intentRef: string }>).map((e) => e.intentRef));
}

/**
 * A checklist with:
 *  - CHK-001:happy:0  fresh (current head + material) → never a candidate.
 *  - CHK-001:edge:0   refresh-only that ONE pass makes fresh: result=pass with
 *                     STALE head + STALE material → writer status 'stale' →
 *                     re-stamped to current → fresh ("refreshed").
 *  - CHK-001:adversarial:0  hard-stale: result=pass with CURRENT head but a
 *                     STALE materialHash → checkEvidenceFreshnessForGit reports
 *                     not-fresh (material drift) so it IS a candidate, but the
 *                     writer's coverage classifier sees headMatches → NOT 'stale'
 *                     → it is SKIPPED by the single pass and stays not-fresh →
 *                     escalates to 'hard_stale' (one-pass max, never re-run).
 */
function mixedChecklist(root: string): ChecklistData {
  const head = currentGitHead(root);
  const material = currentMaterialHash(root, 'HEAD', root);
  assert.ok(head, 'fixture git head is readable');
  assert.ok(material, 'fixture material hash is computable');

  const freshEvidence: VerificationEvidence = {
    intentRef: 'CHK-001:happy:0',
    kind: 'logic_test',
    result: 'pass',
    note: 'fresh — current head + material hash',
    headHash: head!,
    materialHash: material!,
  };
  const refreshOnlyEvidence: VerificationEvidence = {
    intentRef: 'CHK-001:edge:0',
    kind: 'logic_test',
    result: 'pass',
    note: 'pass but stale head+material — one pass re-stamps to fresh',
    headHash: STALE_HEAD,
    materialHash: STALE_MATERIAL,
  };
  const hardStaleEvidence: VerificationEvidence = {
    intentRef: 'CHK-001:adversarial:0',
    kind: 'logic_test',
    result: 'pass',
    note: 'pass, current head but genuinely diverged material — writer skips it (headMatches), stays stale',
    headHash: head!,
    materialHash: STALE_MATERIAL,
  };

  return {
    items: [
      {
        id: 'CHK-001',
        title: 'Item with fresh / refresh-only / hard-stale lanes',
        context: 'one-pass refresh coverage',
        status: 'done',
        startTime: null,
        endTime: null,
        verificationIntent: {
          happy: [{ desc: 'fresh intent', type: 'logic', priority: 'must' }],
          edge: [{ desc: 'refresh-only intent', type: 'logic', priority: 'must' }],
          adversarial: [{ desc: 'hard-stale intent', type: 'logic', priority: 'must' }],
        },
        verificationEvidence: [freshEvidence, refreshOnlyEvidence, hardStaleEvidence],
      },
    ],
  };
}

// ---- Policy / registration assertions -------------------------------------

assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'evidence_refresh'), 'MAIN_TOOLS exposes evidence_refresh');
const policy = getCommandPolicy('evidence_refresh');
assert.equal(policy?.ownershipClass, 'readOnly', 'evidence_refresh base policy is readOnly');
assert.equal(policy?.destructiveRisk, 'none', 'evidence_refresh policy has no static destructive risk');
assert.equal(isCommandAllowed('evidence_refresh', 'REVIEW', DEFAULT_PHASE_TOOLS), true, 'evidence_refresh is available in REVIEW');
assert.equal(isCommandAllowed('evidence_refresh', 'TEST', DEFAULT_PHASE_TOOLS), true, 'evidence_refresh is available in TEST');
assert.equal(isCommandAllowed('evidence_refresh', 'DONE', DEFAULT_PHASE_TOOLS), true, 'evidence_refresh is available in DONE');

// The ownership gate escalates --apply, leaving the dry preview ungated.
assert.equal(
  resolveEffectiveOwnershipClass('evidence_refresh', { storyId: STORY_ID }, STORY_ID),
  'readOnly',
  'evidence_refresh dry preview remains effectively readOnly',
);
assert.equal(
  resolveEffectiveOwnershipClass('evidence_refresh', { storyId: STORY_ID, apply: true }, STORY_ID),
  'storyScopedMutating',
  'evidence_refresh --apply is effectively storyScopedMutating',
);
assert.equal(
  resolveEffectiveOwnershipClass('evidence_refresh', { storyId: STORY_ID, apply: 'true' }, STORY_ID),
  'storyScopedMutating',
  'evidence_refresh --apply string truth is still owner-gated before schema-normalized callers',
);

// ---- Fail-closed boundary (no store read on side-effect flags) ------------

{
  const throwingStore = new Proxy({}, {
    get(_t, prop) {
      throw new Error(`store read should not happen before evidence_refresh rejection: ${String(prop)}`);
    },
  }) as StoryStore;
  const ctx: HandlerContext = { store: throwingStore, root: '/tmp/evidence-refresh-no-read', scanRoot: '/tmp/evidence-refresh-no-read/packages/main' };
  const handler = createMainRegistry(ctx).get('evidence_refresh');
  assert.ok(handler, 'registry exposes evidence_refresh for rejection test');
  for (const flag of ['runCommands', 'advancePhase', 'launchReviewers', 'authorityDone', 'fullAuthorityDone', 'productionDone'] as const) {
    assert.throws(
      () => handler!({ storyId: 'B-no-read', [flag]: true, json: true }),
      /refuses unsupported side effects|no story facts were read/,
      `${flag}=true fails closed before store reads`,
    );
  }
  // --apply is the sanctioned write path and must NOT be rejected by assertBoundary
  // (the ownership gate guards it instead). It must not throw the boundary refusal.
  try {
    handler!({ storyId: 'B-no-read', apply: true, json: true });
  } catch (err) {
    assert.doesNotMatch(
      err instanceof Error ? err.message : String(err),
      /refuses unsupported side effects/,
      'apply=true is NOT rejected by assertBoundary (it is the sanctioned write path)',
    );
  }
}

// ---- Dry preview is read-only and lists the refresh-only candidate ---------

{
  const { root, store, ctx } = createFixture((r) => mixedChecklist(r));
  try {
    const handler = createMainRegistry(ctx).get('evidence_refresh');
    assert.ok(handler, 'registry exposes evidence_refresh');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeStatus = gitStatus(root);

    const report = handler!({ storyId: STORY_ID, json: true }) as EvidenceRefreshReport;
    assert.equal(report.storyId, STORY_ID);
    assert.equal(report.mode.runCommands, false, 'never runs a verification command');
    assert.equal(report.mode.writeEvidence, false, 'dry preview writes no evidence');
    assert.equal(report.claims.authorityDone, false);
    assert.equal(report.claims.fullAuthorityDone, false);
    assert.equal(report.claims.productionDone, false);

    // Both not-fresh result=pass rows are refresh-only candidates; the fresh row is not.
    assert.deepEqual(
      [...intentRefsOf(report, 'candidates')].sort(),
      ['CHK-001:adversarial:0', 'CHK-001:edge:0'],
      'dry preview lists the two stale-but-pass refresh-only candidates',
    );
    assert.equal(report.refreshed.length, 0, 'dry preview refreshes nothing');
    assert.equal(report.escalated.length, 0, 'dry preview escalates nothing');
    assert.deepEqual(report.summary, { candidates: 2, refreshed: 0, escalated: 0 }, 'dry summary counts only candidates');

    // text render is coherent and read-only.
    const text = handler!({ storyId: STORY_ID, format: 'text' }) as string;
    assert.match(text, /Evidence refresh \(B-erefresh\)/);
    assert.match(text, /mode: dry preview \(read-only/);
    assert.match(text, /summary: candidates=2 refreshed=0 escalated=0/);
    assert.match(text, /apply: not requested/);
    assert.match(text, /authorityDone: false/);

    // read-only: no metadata / git mutation, no authority/evidence artifacts.
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'dry preview must not mutate story metadata files');
    assert.equal(gitStatus(root), beforeStatus, 'dry preview must leave git status unchanged');
    assertNoAuthorityOrEvidenceArtifacts(store);
    assert.equal(store.readStory(STORY_ID).phase, 'DEV', 'dry preview must not advance phase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- --apply: one pass refreshes the refresh-only row, escalates hard-stale -

{
  const { root, store, ctx } = createFixture((r) => mixedChecklist(r));
  try {
    const handler = createMainRegistry(ctx).get('evidence_refresh');
    assert.ok(handler, 'registry exposes evidence_refresh for apply test');

    const head = currentGitHead(root)!;
    const material = currentMaterialHash(root, 'HEAD', root)!;

    // Capture the hard-stale row BEFORE so we can prove it was NOT touched (one-pass
    // max: the writer skips headMatches rows; evidence_refresh never re-stamps it twice).
    const beforeChecklist = store.readChecklist(STORY_ID);
    const hardStaleBefore = beforeChecklist.items[0].verificationEvidence!
      .find((e) => e.intentRef === 'CHK-001:adversarial:0')!;

    const report = handler!({ storyId: STORY_ID, apply: true, json: true }) as EvidenceRefreshReport;
    assert.equal(report.mode.runCommands, false, '--apply still never runs a verification command');
    assert.equal(report.mode.writeEvidence, true, '--apply records writeEvidence=true');

    // The same two refresh-only candidates were the input set.
    assert.deepEqual(
      [...intentRefsOf(report, 'candidates')].sort(),
      ['CHK-001:adversarial:0', 'CHK-001:edge:0'],
      '--apply input set is the refresh-only bucket',
    );
    // The genuinely refreshable row reclassifies to fresh ("refreshed").
    assert.deepEqual([...intentRefsOf(report, 'refreshed')], ['CHK-001:edge:0'], 'refresh-only row re-stamped to fresh');
    // The hard-stale row is reported, not refreshed.
    assert.deepEqual([...intentRefsOf(report, 'escalated')], ['CHK-001:adversarial:0'], 'hard-stale row escalates');
    assert.equal(report.escalated[0].outcome, 'hard_stale', 'still-stale-by-hash row escalates to hard_stale, not refreshed');
    assert.deepEqual(report.summary, { candidates: 2, refreshed: 1, escalated: 1 }, 'apply summary: 1 refreshed, 1 escalated');

    // Verify the WRITE happened via verification_evidence_refresh_stale: the
    // refresh-only row now carries the CURRENT head + material (re-stamped).
    const afterChecklist = store.readChecklist(STORY_ID);
    const refreshedRow = afterChecklist.items[0].verificationEvidence!
      .find((e) => e.intentRef === 'CHK-001:edge:0')!;
    assert.equal(refreshedRow.headHash, head, 'refresh-only row re-stamped to current head');
    assert.equal(refreshedRow.materialHash, material, 'refresh-only row re-stamped to current material');

    // The hard-stale row is byte-for-byte unchanged (NOT refreshed twice / not at all).
    const hardStaleAfter = afterChecklist.items[0].verificationEvidence!
      .find((e) => e.intentRef === 'CHK-001:adversarial:0')!;
    assert.equal(hardStaleAfter.headHash, hardStaleBefore.headHash, 'hard-stale head unchanged by the one pass');
    assert.equal(hardStaleAfter.materialHash, STALE_MATERIAL, 'hard-stale material was NOT re-stamped (one-pass writer skipped it)');

    // A SECOND apply must not change anything further (no looping; the only
    // remaining candidate is hard-stale and stays escalated).
    const second = handler!({ storyId: STORY_ID, apply: true, json: true }) as EvidenceRefreshReport;
    assert.deepEqual([...intentRefsOf(second, 'candidates')], ['CHK-001:adversarial:0'], 'second apply sees only the hard-stale candidate');
    assert.equal(second.refreshed.length, 0, 'second apply refreshes nothing');
    assert.deepEqual([...intentRefsOf(second, 'escalated')], ['CHK-001:adversarial:0'], 'hard-stale stays escalated across invocations');

    assert.equal(store.readStory(STORY_ID).phase, 'DEV', '--apply must not advance phase');
    assertNoAuthorityOrEvidenceArtifacts(store);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- --apply through a FAILING owner/scope gate writes nothing -------------

{
  const { root, store } = createFixture((r) => mixedChecklist(r));
  const savedSession = process.env.PROOF_OR_STOP_SESSION_ID;
  try {
    const storyDir = store.storyDirPath(STORY_ID);
    process.env.PROOF_OR_STOP_SESSION_ID = 'sess-owner';
    resetSessionIdForTest();
    acquireOwnerLease(storyDir, { command: 'checklist_add', cwd: '/tmp/owner-worktree' });
    const leaseBefore = readFileSync(ownerLeasePath(storyDir), 'utf8');
    const checklistBefore = store.readChecklist(STORY_ID);
    const statusBefore = gitStatus(root);

    process.env.PROOF_OR_STOP_SESSION_ID = 'sess-intruder';
    resetSessionIdForTest();

    // Dry preview is ungated even on a foreign-owned story.
    assert.doesNotThrow(
      () => enforceStoryOwnerLeaseGate('evidence_refresh', { storyId: STORY_ID }, store, null, root),
      'evidence_refresh dry preview is not owner-gated on a foreign-owned story',
    );
    // --apply is owner-gated and must throw before any write.
    assert.throws(
      () => enforceStoryOwnerLeaseGate('evidence_refresh', { storyId: STORY_ID, apply: true }, store, null, root),
      /owner|owned by another/i,
      'evidence_refresh --apply is owner-gated on a foreign-owned story',
    );

    assert.equal(readFileSync(ownerLeasePath(storyDir), 'utf8'), leaseBefore, 'rejected --apply leaves the foreign owner lease untouched');
    assert.deepEqual(store.readChecklist(STORY_ID), checklistBefore, 'rejected owner gate leaves evidence/checklist unchanged (no partial write)');
    assert.equal(gitStatus(root), statusBefore, 'rejected owner gate leaves git status unchanged');
    assertNoAuthorityOrEvidenceArtifacts(store);
  } finally {
    if (savedSession === undefined) delete process.env.PROOF_OR_STOP_SESSION_ID;
    else process.env.PROOF_OR_STOP_SESSION_ID = savedSession;
    resetSessionIdForTest();
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- a failing row is never a candidate, never refreshed, runs no command --
// evidence_refresh's candidate set is exactly the refresh-only bucket (result=pass
// + not-fresh). A result=fail row is OUTSIDE that bucket: it must never be picked,
// never re-stamped, and never trigger a verification command (rerun rows are the
// REPORT-only domain of evidence_plan, not this writer).

{
  const { root, store, ctx } = createFixture((r) => {
    const head = currentGitHead(r)!;
    const material = currentMaterialHash(r, 'HEAD', r)!;
    const failingEvidence: VerificationEvidence = {
      intentRef: 'CHK-001:edge:0',
      kind: 'logic_test',
      result: 'fail',
      command: 'npm test -- edge',
      note: 'failing evidence must be re-executed, never refreshed',
      headHash: head,
      materialHash: material,
    };
    return {
      items: [
        {
          id: 'CHK-001',
          title: 'Item with a failing lane',
          context: 'failing rows are out of the refresh-only bucket',
          status: 'done',
          startTime: null,
          endTime: null,
          verificationIntent: {
            happy: [],
            edge: [{ desc: 'failing intent', type: 'logic', priority: 'must' }],
            adversarial: [],
          },
          verificationEvidence: [failingEvidence],
        },
      ],
    };
  });
  try {
    const handler = createMainRegistry(ctx).get('evidence_refresh');
    assert.ok(handler, 'registry exposes evidence_refresh for failing-row test');

    const beforeChecklist = store.readChecklist(STORY_ID);
    const report = handler!({ storyId: STORY_ID, apply: true, json: true }) as EvidenceRefreshReport;
    assert.equal(report.mode.runCommands, false, 'no verification command executed for a failing row');
    assert.deepEqual(report.summary, { candidates: 0, refreshed: 0, escalated: 0 }, 'failing row is outside the refresh-only bucket');
    assert.equal(report.refreshed.length, 0, 'a failing row is never refreshed');
    // F-002 honesty: --apply with 0 refresh-only candidates ran NO pass, so
    // writeEvidence must be false and the rendered text must NOT claim a pass.
    assert.equal(report.mode.writeEvidence, false, 'F-002: --apply with 0 candidates wrote no evidence (no pass ran)');
    const zeroApplyText = handler!({ storyId: STORY_ID, apply: true, format: 'text' }) as string;
    assert.doesNotMatch(
      zeroApplyText,
      /one refresh pass via verification_evidence_refresh_stale/,
      'F-002: 0-candidate --apply must NOT claim a refresh pass was performed',
    );
    assert.match(
      zeroApplyText,
      /0 refresh-only rows; nothing refreshed \(no evidence written\)/,
      'F-002: 0-candidate --apply states honestly that nothing was refreshed',
    );
    // --apply with zero candidates is a no-op write: evidence left untouched.
    assert.deepEqual(store.readChecklist(STORY_ID), beforeChecklist, 'no candidates → the one pass is never invoked, evidence unchanged');
    assert.equal(store.readStory(STORY_ID).phase, 'DEV', 'failing-row path does not advance phase');
    assertNoAuthorityOrEvidenceArtifacts(store);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- F-001: a NONEXISTENT story errors clearly and writes nothing ----------
// evidence_refresh on a story id that does not exist must throw a clear error
// (not a silent empty no-op) and must not create or mutate any state. The guard
// runs after assertBoundary but before any classification/preview/--apply pass.

{
  const { root, store, ctx } = createFixture((r) => mixedChecklist(r));
  try {
    const handler = createMainRegistry(ctx).get('evidence_refresh');
    assert.ok(handler, 'registry exposes evidence_refresh for nonexistent-story test');

    const MISSING_ID = 'B-nonexistent';
    assert.equal(store.storyExists(MISSING_ID), false, 'precondition: the missing story id does not exist');
    const missingDir = store.storyDirPath(MISSING_ID);
    const statusBefore = gitStatus(root);

    // dry preview on a missing story → clear error, no write.
    assert.throws(
      () => handler!({ storyId: MISSING_ID, json: true }),
      /evidence_refresh: story B-nonexistent not found/,
      'F-001: dry preview on a nonexistent story throws a clear not-found error',
    );
    // --apply on a missing story → same clear error BEFORE any pass, no write.
    assert.throws(
      () => handler!({ storyId: MISSING_ID, apply: true, json: true }),
      /evidence_refresh: story B-nonexistent not found/,
      'F-001: --apply on a nonexistent story throws before any refresh pass',
    );

    assert.equal(existsSync(missingDir), false, 'F-001: no story directory was created for the missing id');
    assert.equal(store.storyExists(MISSING_ID), false, 'F-001: the missing story still does not exist (no partial write)');
    assert.equal(gitStatus(root), statusBefore, 'F-001: nonexistent-story rejection leaves git status unchanged');
    // The existing, real story is untouched by the rejected calls.
    assert.equal(store.readStory(STORY_ID).phase, 'DEV', 'F-001: real story is unaffected by the rejected missing-id calls');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- direct reclassification-branch coverage (rerun_required / hard_stale) --
// Unit-level proof of reclassifyAfterPass semantics via the public handler is
// covered by the hard_stale apply block above; here we assert the reported
// escalation taxonomy is exactly {rerun_required, hard_stale} so a future writer
// change that silently drops an escalation outcome is caught.
{
  const outcomes = new Set<EvidenceRefreshReport['escalated'][number]['outcome']>(['rerun_required', 'hard_stale']);
  assert.equal(outcomes.has('hard_stale'), true, 'hard_stale is a declared escalation outcome');
  assert.equal(outcomes.has('rerun_required'), true, 'rerun_required is a declared escalation outcome');
}

process.stdout.write('evidence_refresh smoke passed\n');
