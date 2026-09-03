#!/usr/bin/env node
/**
 * evidence-hash-snapshot-classifier-smoke (B-83aa CHK-003)
 *
 * `captureEvidenceHashSnapshot` never throws on a git or hash failure: each of
 * headHash / materialHash / storyFilesHash is OPTIONAL and simply OMITTED, and
 * `tryCaptureEvidenceHashSnapshot` only maps a *thrown* error to undefined. An
 * unborn repository (git init, zero commits), a dangling ref, or a repo with no
 * `main` therefore yields a RETURNED snapshot that binds nothing. CHK-001 added
 * the shared classifier `classifyEvidenceHashSnapshot` beside the reader; this
 * smoke pins the classifier contract and the recorded classification of EVERY
 * `tryCaptureEvidenceHashSnapshot` consumer.
 *
 * Per-site classification (one recorded classification + one regression case
 * per site):
 *
 *   site                                              classification   how it is proven here
 *   ------------------------------------------------  ---------------  ------------------------------------------------
 *   core/done-oracle.ts buildDoneChecklist            FAIL-CLOSED      unborn repo -> `evidence-hash-snapshot` row is
 *                                                                      status=fail / blocking and names headHash +
 *                                                                      materialHash; full-digest repo -> row absent and
 *                                                                      the rendered checklist is byte-identical with and
 *                                                                      without a supplied evidenceHashSnapshot
 *   handlers/phase-gates.ts runDoneOracleGate         DISCLOSED        unborn repo -> throws; the thrown text contains
 *                                                                      the classifier detail line and an explicit
 *                                                                      `Evidence hash snapshot binding (fail closed):`
 *   handlers/verifier.ts evaluateStoryRoutineReuse    TOLERABLE        the snapshot only feeds
 *                                                                      evaluateRoutineValidationReuse, which refuses
 *                                                                      reuse on any missing digest
 *                                                                      (material-hash-changed-or-missing,
 *                                                                      story-files-hash-changed-or-missing,
 *                                                                      missing-head-lineage); the log line carries the
 *                                                                      classifier detail. Driven via the exported core
 *                                                                      function with the unborn snapshot.
 *   core/lifecycle-readiness.ts buildStoryReadiness   FAIL-CLOSED for  target=DONE -> head_hash_unavailable and
 *     Report                                          DONE, DISCLOSED  material_hash_unavailable are blocked/blocking
 *                                                     (advisory) for   and carry the classifier detail; target=REVIEW /
 *                                                     REVIEW / TEST    TEST -> same rows are warn/advisory/non-blocking
 *   handlers/session.ts TEST-phase DONE pre-check     DISCLOSED        the silent `catch {}` is gone: a partial
 *                                                                      head/material binding (or a thrown probe) prints
 *                                                                      exactly one `## DONE pre-check unavailable:
 *                                                                      <reason>` line and the next-step hint says so;
 *                                                                      a full-digest story still prints the normal
 *                                                                      `## DONE pre-check` section
 *
 * Fixture note for the session site: `detectActiveStoryFromGit` shells out to
 * `git rev-parse --abbrev-ref HEAD`, which exits 128 on an UNBORN branch, so an
 * unborn repo never reaches the TEST-phase pre-check block at all (asserted
 * below as the documented reason). The "HEAD cannot be read" fixture for that
 * site is therefore a `story/<id>` branch whose ref points at a sha that is
 * absent from the object database: branch detection succeeds, `git rev-parse
 * HEAD` still yields the sha, but `git ls-tree` fails, so the captured snapshot
 * is partial (materialHash + storyFilesHash missing).
 *
 * Classifier contract pinned here (fixtures modelled on B-a745 F-022
 * `snapshotWithout`: keys OMITTED, never null; plus one hand-crafted snapshot
 * with '' and null values):
 *   - each digest missing alone and all three missing -> complete=false,
 *     `missing` lists exactly the absent keys in canonical order, detail is ONE
 *     line <= 300 chars naming every missing digest and none of the present ones
 *   - '' / whitespace / null digest values classify exactly like omitted keys
 *   - a full snapshot -> complete=true, missing=[]
 *
 * On success prints `evidence-hash-snapshot-classifier smoke passed`; any assert
 * failure throws -> exit 1.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EVIDENCE_FRESHNESS_HEAD_UNREADABLE_REASON,
  EVIDENCE_HASH_SNAPSHOT_DETAIL_MAX_CHARS,
  EVIDENCE_HASH_SNAPSHOT_DIGEST_KEYS,
  captureEvidenceHashSnapshot,
  checkEvidenceFreshnessForGit,
  classifyEvidenceHashSnapshot,
  tryCaptureEvidenceHashSnapshot,
  type EvidenceHashSnapshot,
  type EvidenceHashSnapshotDigestKey,
} from '../core/evidence-freshness.js';
import { buildDoneChecklist, renderDoneChecklist } from '../core/done-oracle.js';
import { buildStoryReadinessReport, type LifecycleReadinessTarget } from '../core/lifecycle-readiness.js';
import { evaluateRoutineValidationReuse } from '../core/validation-evidence-reuse.js';
import { runDoneOracleGate } from '../handlers/phase-gates.js';
import { createSessionHandlers } from '../handlers/session.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { assertCurrentReviewRunForEvidence, hashReviewPrompt, signReviewRun } from '../core/review-run.js';
import { PROMPT_ENVELOPE_ROLLOUT_VERSION, resolvePromptRoleBody } from '../core/prompt-role-contract-registry.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import type { ChecklistData, ReviewRun, StoryInfo, TestEvidenceData } from '../core/types.js';
import type { RoutineValidationIdentity } from '../core/validation-types.js';

type RoutineReuseArgs = Parameters<typeof evaluateRoutineValidationReuse>[0];

const MARKER = 'evidence-hash-snapshot-classifier smoke';
const STORY_ID = 'B-83aa-smoke';
const NOW = '2026-09-02T00:00:00.000Z';
const FAKE_HEAD = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const FAKE_MATERIAL = 'c0ffee'.repeat(10) + 'c0ff';
const FAKE_STORY_FILES = 'ab'.repeat(32);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'smoke',
      GIT_AUTHOR_EMAIL: 'smoke@example.com',
      GIT_COMMITTER_NAME: 'smoke',
      GIT_COMMITTER_EMAIL: 'smoke@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
}

function writeConfig(root: string): void {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'light' },
  }, null, 2) + '\n', 'utf-8');
  resetConfigCache();
}

function writeTestStory(store: StoryStore, storyId: string, evidence?: Partial<TestEvidenceData>): void {
  const story: StoryInfo = {
    storyId,
    name: 'partial-hash-fixture',
    title: 'Partial hash snapshot fixture story',
    description: 'Drive lifecycle gate consumers over a partial evidence hash snapshot.',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  };
  const checklist: ChecklistData = {
    items: [{ id: 'CHK-001', title: 'Synthetic item', context: 'Synthetic context', status: 'done', startTime: null, endTime: null }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  store.writeTestEvidence(storyId, {
    command: 'proof-or-stop validate',
    output: JSON.stringify({ allPassed: true }),
    result: 'PASS',
    timestamp: NOW,
    headHash: FAKE_HEAD,
    materialHash: FAKE_MATERIAL,
    storyFilesHash: FAKE_STORY_FILES,
    ...(evidence ?? {}),
  } as TestEvidenceData);
}

/** git init, zero commits: HEAD is unborn, every digest is underivable. */
function unbornRepo(branch: string): string {
  const root = mkdtempSync(join(tmpdir(), 'pos-hash-classifier-unborn-'));
  writeConfig(root);
  git(root, ['init', '-b', branch]);
  return root;
}

/** Plain repo on `story/<id>` with a `main` ref: every digest derivable, tree clean. */
function fullDigestRepo(storyId: string): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'pos-hash-classifier-full-'));
  writeConfig(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  git(root, ['init', '-b', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base on main']);
  git(root, ['checkout', '-b', `story/${storyId}`]);
  const store = new StoryStore(root);
  writeTestStory(store, storyId);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'story metadata']);
  return { root, store };
}

/** `story/<id>` branch whose ref points at a sha absent from the object db:
 * branch detection works, `git rev-parse HEAD` yields the sha, `git ls-tree`
 * fails -> materialHash / storyFilesHash cannot be derived. */
function danglingHeadRepo(storyId: string): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'pos-hash-classifier-dangling-'));
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# dangling\n', 'utf-8');
  git(root, ['init', '-b', `story/${storyId}`]);
  const store = new StoryStore(root);
  writeTestStory(store, storyId);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  // `git update-ref` refuses a nonexistent object, so the loose ref file is
  // overwritten directly (a fresh `git init` keeps branch refs loose).
  writeFileSync(join(root, '.git', 'refs', 'heads', 'story', storyId), `${FAKE_HEAD}\n`, 'utf-8');
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), FAKE_HEAD, 'fixture sanity: HEAD must resolve to the dangling sha');
  return { root, store };
}

/** B-83aa CHK-003: WRAPPER-ROOT layout. metadataRoot holds the config + story
 * metadata and is NOT a git repository; the real repo is the configured
 * `gitRoot: 'repo'` subdir checked out on `story/<id>` (with a `main` ref when
 * not unborn). Mirrors review-assurance-floor-smoke's makeWrapperRepo. */
function wrapperRootRepo(storyId: string, opts: { unborn: boolean }): { metadataRoot: string; gitRoot: string; store: StoryStore } {
  const metadataRoot = mkdtempSync(join(tmpdir(), 'pos-hash-classifier-wrapper-'));
  const gitRoot = join(metadataRoot, 'repo');
  mkdirSync(gitRoot, { recursive: true });
  writeFileSync(join(metadataRoot, 'proof-or-stop.config.json'), JSON.stringify({
    gitRoot: 'repo',
    workflow: { profile: 'light' },
  }, null, 2) + '\n', 'utf-8');
  resetConfigCache();
  if (opts.unborn) {
    git(gitRoot, ['init', '-b', `story/${storyId}`]);
  } else {
    mkdirSync(join(gitRoot, 'src'), { recursive: true });
    writeFileSync(join(gitRoot, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
    git(gitRoot, ['init', '-b', 'main']);
    git(gitRoot, ['add', '.']);
    git(gitRoot, ['commit', '-m', 'base on main']);
    git(gitRoot, ['checkout', '-b', `story/${storyId}`]);
    writeFileSync(join(gitRoot, 'src', 'a.ts'), 'export const a = 2;\n', 'utf-8');
    git(gitRoot, ['add', '.']);
    git(gitRoot, ['commit', '-m', 'story change']);
  }
  const store = new StoryStore(metadataRoot);
  writeTestStory(store, storyId);
  store.writeStory(storyId, { ...store.readStory(storyId), currentReviewRound: NOW });
  return { metadataRoot, gitRoot, store };
}

/** Signed review run with deliberately NO workspaceBinding (legacy shape). */
function legacyReviewRun(story: StoryInfo, headHash: string, materialHash: string, storyFilesHash: string | undefined): ReviewRun {
  const agent = 'proof-or-stop-review-concept';
  const reviewRunId = `${story.storyId}:RR-legacy-1`;
  const startedAt = NOW;
  // Legacy (pre-envelope) runs must carry the frozen legacy role-body promptHash.
  const promptHash = hashReviewPrompt(resolvePromptRoleBody(agent, {
    version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: { [agent]: 'legacy-full-context' },
  }).body);
  const _hash = signReviewRun(
    story.storyId, reviewRunId, agent, agent, story.currentReviewRound!, startedAt,
    headHash, materialHash, promptHash, undefined, undefined, storyFilesHash,
  );
  return {
    storyId: story.storyId,
    reviewRunId,
    agent,
    lane: agent,
    reviewRound: story.currentReviewRound!,
    startedAt,
    headHash,
    materialHash,
    ...(storyFilesHash ? { storyFilesHash } : {}),
    promptHash,
    _hash,
  };
}

/** F-022 fixture shape: the canonical reader's failure is an OMITTED key, never null. */
const FIXTURE_FULL: EvidenceHashSnapshot = {
  schemaVersion: 'lattice.evidence_hash_snapshot.v1',
  headHash: 'head0000000000000000000000000000000000000',
  materialHash: 'material00000000000000000000000000000000',
  storyFilesHash: 'storyfiles000000000000000000000000000000',
  gitCwd: '/fixture',
  metadataRoot: '/fixture',
  ref: 'HEAD',
  capturedAt: NOW,
  materialDirtyFiles: [],
};

function snapshotWithout(missing: EvidenceHashSnapshotDigestKey[]): EvidenceHashSnapshot {
  const snapshot: Record<string, unknown> = { ...FIXTURE_FULL };
  for (const key of missing) delete snapshot[key];
  return snapshot as unknown as EvidenceHashSnapshot;
}

function assertDetailShape(detail: string, missing: readonly EvidenceHashSnapshotDigestKey[]): void {
  assert.equal(/[\r\n]/.test(detail), false, `detail must be ONE line, got:\n${detail}`);
  assert.ok(detail.length <= EVIDENCE_HASH_SNAPSHOT_DETAIL_MAX_CHARS, `detail must be <= ${EVIDENCE_HASH_SNAPSHOT_DETAIL_MAX_CHARS} chars, got ${detail.length}`);
  assert.ok(detail.length > 0, 'detail must not be empty');
  for (const key of EVIDENCE_HASH_SNAPSHOT_DIGEST_KEYS) {
    const named = new RegExp(`(^|[^A-Za-z])${key}([^A-Za-z]|$)`).test(detail.split(';')[0] ?? detail);
    if (missing.includes(key)) {
      assert.ok(named, `detail must name the missing digest ${key}: ${detail}`);
    }
  }
}

let cases = 0;
function testCase(label: string, fn: () => void): void {
  fn();
  cases += 1;
  console.log(`${MARKER}: ok - ${label}`);
}

// ════════════════════════════════════════════════════════════════════════════
// Classifier contract
// ════════════════════════════════════════════════════════════════════════════

testCase('classifier: each digest missing alone (keys omitted) is reported alone', () => {
  for (const key of EVIDENCE_HASH_SNAPSHOT_DIGEST_KEYS) {
    const result = classifyEvidenceHashSnapshot(snapshotWithout([key]));
    assert.equal(result.complete, false, `${key} omitted must not be complete`);
    assert.deepEqual(result.missing, [key]);
    assertDetailShape(result.detail, [key]);
    for (const other of EVIDENCE_HASH_SNAPSHOT_DIGEST_KEYS.filter((k) => k !== key)) {
      assert.ok(result.detail.includes(`present: `), 'present digests are listed after the missing ones');
      assert.ok(result.detail.split('present:')[1]?.includes(other), `${other} must be listed as present: ${result.detail}`);
    }
  }
});

testCase('classifier: all three digests missing (keys omitted) lists all three in canonical order', () => {
  const result = classifyEvidenceHashSnapshot(snapshotWithout([...EVIDENCE_HASH_SNAPSHOT_DIGEST_KEYS]));
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ['headHash', 'materialHash', 'storyFilesHash']);
  assertDetailShape(result.detail, EVIDENCE_HASH_SNAPSHOT_DIGEST_KEYS);
  assert.equal(result.detail.includes('present:'), false, 'nothing is present, so nothing may be listed as present');
  // Order is canonical regardless of the `required` argument order.
  const reordered = classifyEvidenceHashSnapshot(snapshotWithout([...EVIDENCE_HASH_SNAPSHOT_DIGEST_KEYS]), ['storyFilesHash', 'headHash', 'materialHash']);
  assert.deepEqual(reordered.missing, ['headHash', 'materialHash', 'storyFilesHash']);
});

testCase('classifier: undefined snapshot (thrown capture) is fully missing and says no snapshot was captured', () => {
  const result = classifyEvidenceHashSnapshot(undefined);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ['headHash', 'materialHash', 'storyFilesHash']);
  assert.ok(result.detail.includes('no snapshot was captured'), result.detail);
  assertDetailShape(result.detail, EVIDENCE_HASH_SNAPSHOT_DIGEST_KEYS);
});

testCase('classifier (adversarial): empty-string, whitespace and null digests classify exactly like omitted keys', () => {
  const omitted = classifyEvidenceHashSnapshot(snapshotWithout(['materialHash', 'storyFilesHash']));
  const handCrafted = classifyEvidenceHashSnapshot({
    headHash: FIXTURE_FULL.headHash,
    materialHash: '',
    storyFilesHash: null,
  });
  assert.deepEqual(handCrafted, omitted, 'empty string / null must classify byte-identically to omitted keys');
  const whitespace = classifyEvidenceHashSnapshot({ headHash: '   ', materialHash: null, storyFilesHash: '' });
  assert.equal(whitespace.complete, false);
  assert.deepEqual(whitespace.missing, ['headHash', 'materialHash', 'storyFilesHash']);
  assert.deepEqual(
    whitespace,
    classifyEvidenceHashSnapshot(snapshotWithout([...EVIDENCE_HASH_SNAPSHOT_DIGEST_KEYS])),
    'whitespace / null / empty must never count as present',
  );
  for (const bad of ['', '   ', null, undefined] as const) {
    const single = classifyEvidenceHashSnapshot({ ...FIXTURE_FULL, headHash: bad });
    assert.deepEqual(single.missing, ['headHash'], `headHash=${JSON.stringify(bad)} must be missing`);
  }
});

testCase('classifier: a complete snapshot is complete with an empty missing list and a bounded one-line detail', () => {
  const result = classifyEvidenceHashSnapshot(FIXTURE_FULL);
  assert.equal(result.complete, true);
  assert.deepEqual(result.missing, []);
  assertDetailShape(result.detail, []);
  // A scoped requirement ignores digests outside the scope.
  const scoped = classifyEvidenceHashSnapshot(snapshotWithout(['storyFilesHash']), ['headHash', 'materialHash']);
  assert.equal(scoped.complete, true);
  assert.deepEqual(scoped.missing, []);
});

// ════════════════════════════════════════════════════════════════════════════
// Consumer sites
// ════════════════════════════════════════════════════════════════════════════

resetConfigCache();
const unborn = unbornRepo('main');
const unbornStore = new StoryStore(unborn);
writeTestStory(unbornStore, STORY_ID);
const unbornSnapshot = captureEvidenceHashSnapshot({ gitCwd: unborn, metadataRoot: unborn, ref: 'HEAD' });
const unbornClassification = classifyEvidenceHashSnapshot(unbornSnapshot);

try {
  testCase('reader contract: an unborn repo RETURNS a snapshot with every digest omitted (never null)', () => {
    for (const key of EVIDENCE_HASH_SNAPSHOT_DIGEST_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(unbornSnapshot, key), false, `${key} must be omitted, not null`);
    }
    assert.notEqual(tryCaptureEvidenceHashSnapshot({ gitCwd: unborn, metadataRoot: unborn, ref: 'HEAD' }), undefined, 'tryCapture returns (does not throw) on an unborn repo');
    assert.equal(unbornClassification.complete, false);
    assert.deepEqual(unbornClassification.missing, ['headHash', 'materialHash', 'storyFilesHash']);
  });

  // ── core/done-oracle.ts buildDoneChecklist — FAIL-CLOSED ──────────────────
  testCase('done-oracle (FAIL-CLOSED): unborn repo -> evidence-hash-snapshot row is fail/blocking and names headHash + materialHash', () => {
    const rows = buildDoneChecklist(STORY_ID, unbornStore, unborn, { auditWriter: null, gitCwd: unborn });
    const row = rows.find((r) => r.id === 'evidence-hash-snapshot');
    assert.ok(row, 'evidence-hash-snapshot row must be present on an unborn repo');
    assert.equal(row!.status, 'fail');
    assert.equal(row!.blocking, true);
    assert.equal(row!.detail, unbornClassification.detail, 'the row detail IS the shared classifier line');
    assert.ok(/headHash/.test(row!.detail ?? '') && /materialHash/.test(row!.detail ?? ''), row!.detail);
    // Supplying the partial snapshot explicitly must not record a binding without the missing digest names.
    const supplied = buildDoneChecklist(STORY_ID, unbornStore, unborn, { auditWriter: null, gitCwd: unborn, evidenceHashSnapshot: unbornSnapshot });
    const rendered = renderDoneChecklist(STORY_ID, supplied);
    assert.ok(/Evidence hash snapshot: .*headHash.*materialHash/.test(rendered), `rendered checklist must name the missing digests:\n${rendered}`);
  });

  // ── handlers/phase-gates.ts runDoneOracleGate — DISCLOSED ─────────────────
  testCase('phase-gates (DISCLOSED): runDoneOracleGate on the unborn repo throws with the classifier line made explicit', () => {
    let thrown: string | null = null;
    try {
      runDoneOracleGate(STORY_ID, unbornStore, unborn, { stop() { /* noop */ } }, unborn);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    assert.ok(thrown, 'the DONE gate must throw on an unborn repo');
    assert.ok(thrown!.includes(unbornClassification.detail), `thrown gate text must contain the classifier detail:\n${thrown}`);
    assert.ok(thrown!.includes('Evidence hash snapshot binding (fail closed): '), `thrown gate text must carry the explicit binding line:\n${thrown}`);
    assert.ok(thrown!.includes('Cannot enter DONE'), thrown!);
  });

  // ── handlers/verifier.ts evaluateStoryRoutineReuse — TOLERABLE ────────────
  testCase('verifier (TOLERABLE): evaluateRoutineValidationReuse refuses reuse on the unborn snapshot naming the missing digests', () => {
    const evidence = unbornStore.readTestEvidence(STORY_ID);
    assert.ok(evidence, 'fixture evidence must exist');
    const identity = { digest: 'sha256:current', commands: [] } as unknown as RoutineValidationIdentity;
    const coverage = { missingRequired: 0 } as unknown as RoutineReuseArgs['currentCoverage'];
    const evaluation = evaluateRoutineValidationReuse({
      root: unborn,
      gitCwd: unborn,
      evidence,
      currentIdentity: identity,
      currentCoverage: coverage,
      currentMaterialHash: unbornSnapshot.materialHash,
      currentStoryFilesHash: unbornSnapshot.storyFilesHash,
      clean: false,
      headBefore: unbornSnapshot.headHash,
      headAfter: unbornSnapshot.headHash,
    });
    assert.equal(evaluation.reusable, false);
    assert.equal(evaluation.lineage, 'rejected');
    for (const reason of ['material-hash-changed-or-missing', 'story-files-hash-changed-or-missing', 'missing-head-lineage', 'head-changed-during-reuse-evaluation']) {
      assert.ok(evaluation.refusalReasons.includes(reason), `refusal must include ${reason}: ${evaluation.refusalReasons.join(',')}`);
    }
  });

  // ── core/lifecycle-readiness.ts buildStoryReadinessReport ─────────────────
  testCase('lifecycle-readiness: DONE fails closed (head/material blocking with classifier detail); REVIEW/TEST disclose as advisory', () => {
    const codes = ['head_hash_unavailable', 'material_hash_unavailable', 'story_files_hash_unavailable'];
    for (const target of ['DONE', 'REVIEW', 'TEST'] as LifecycleReadinessTarget[]) {
      const report = buildStoryReadinessReport({ storyId: STORY_ID, target, store: unbornStore, root: unborn, gitCwd: unborn });
      const rows = codes.map((code) => report.readiness.find((r) => r.code === code));
      assert.ok(rows.every(Boolean), `${target}: all three *_hash_unavailable rows must be present`);
      const [head, material, storyFiles] = rows as NonNullable<typeof rows[number]>[];
      if (target === 'DONE') {
        for (const r of [head, material]) {
          assert.equal(r.blocking, true, `${target}: ${r.code} must block`);
          assert.equal(r.status, 'blocked');
          assert.equal(r.category, 'blocking');
          assert.ok(r.reason.includes('(fail closed)'), r.reason);
          assert.ok(r.reason.includes(unbornClassification.detail), `${r.code} reason must carry the classifier detail: ${r.reason}`);
        }
      } else {
        for (const r of [head, material]) {
          assert.equal(r.blocking, false, `${target}: ${r.code} must stay advisory`);
          assert.equal(r.status, 'warn');
          assert.equal(r.category, 'advisory');
        }
      }
      assert.equal(storyFiles.blocking, false, `${target}: storyFilesHash stays advisory at every target`);
      assert.equal(storyFiles.category, 'advisory');
    }
  });

  // ── handlers/session.ts TEST-phase DONE pre-check — DISCLOSED ─────────────
  testCase('session (documented limit): an unborn repo cannot be story-detected, so its brief never reaches the TEST pre-check block', () => {
    const storyBranchUnborn = unbornRepo(`story/${STORY_ID}`);
    try {
      const store = new StoryStore(storyBranchUnborn);
      writeTestStory(store, STORY_ID);
      const brief = createSessionHandlers({ store, root: storyBranchUnborn, scanRoot: join(storyBranchUnborn, 'packages/main') }).session_brief({ concise: true });
      assert.equal(brief.includes('## DONE pre-check'), false, 'no active story is detected on an unborn branch (git rev-parse --abbrev-ref HEAD exits 128)');
    } finally {
      rmSync(storyBranchUnborn, { recursive: true, force: true });
      resetConfigCache();
    }
  });

  testCase('session (DISCLOSED): a TEST story whose HEAD tree cannot be read prints one `## DONE pre-check unavailable:` line and the next step says so', () => {
    const { root, store } = danglingHeadRepo(STORY_ID);
    try {
      const snapshot = captureEvidenceHashSnapshot({ gitCwd: root, metadataRoot: root, ref: 'HEAD' });
      const binding = classifyEvidenceHashSnapshot(snapshot, ['headHash', 'materialHash']);
      assert.equal(binding.complete, false, 'fixture sanity: the dangling HEAD must yield a partial head/material binding');
      assert.ok(binding.missing.includes('materialHash'), binding.detail);
      const brief = createSessionHandlers({ store, root, scanRoot: join(root, 'packages/main') }).session_brief({ concise: true });
      const unavailableLines = brief.split('\n').filter((line) => line.startsWith('## DONE pre-check unavailable: '));
      assert.equal(unavailableLines.length, 1, `exactly one unavailable line expected:\n${brief}`);
      assert.equal(unavailableLines[0], `## DONE pre-check unavailable: ${binding.detail}`);
      assert.equal(brief.includes('\n## DONE pre-check\n'), false, 'the normal section is replaced by the disclosure, not printed alongside it');
      assert.ok(brief.includes('TEST phase, DONE pre-check unavailable: '), `next step must disclose the unavailable pre-check:\n${brief}`);
      assert.equal(brief.includes('--phase=DONE to complete the story'), false, 'DONE must not be recommended while the pre-check is unavailable');
    } finally {
      rmSync(root, { recursive: true, force: true });
      resetConfigCache();
    }
  });

  // ── evidence-freshness (F-001): readable HEAD + underivable materialHash ──
  // B-83aa:F-001 — the `if (!materialBinding.complete)` fail-closed branch of
  // checkEvidenceFreshnessForGit was never driven by a registered test: the red
  // script's C2 only reaches the unborn/!currentHead branch and the dangling-head
  // fixture above only drives session_brief. Reverting that branch to `if (false)`
  // left both pinned suites green. This case calls the function directly on the
  // dangling-head fixture (HEAD resolves, `git ls-tree` fails) with an evidence
  // materialHash set, and pins the fail-closed result: fresh=false, the reason
  // names materialHash, no currentMaterialHash, and the result is NOT the head
  // comparison fall-through (the pre-fix behaviour, which would report the
  // matching FAKE_HEAD as `evidence corresponds to current HEAD`).
  testCase('evidence-freshness (FAIL CLOSED): readable HEAD + underivable materialHash -> checkEvidenceFreshnessForGit reports fresh=false naming materialHash, never the head-comparison fall-through', () => {
    const { root } = danglingHeadRepo(STORY_ID);
    try {
      assert.throws(() => git(root, ['ls-tree', '-r', 'HEAD']), 'fixture sanity: `git ls-tree HEAD` must fail on the dangling sha');
      const result = checkEvidenceFreshnessForGit(root, FAKE_HEAD, FAKE_MATERIAL, root);
      assert.equal(result.fresh, false, `evidence bound to a materialHash that cannot be re-derived must not be fresh: ${result.reason}`);
      assert.ok(/materialHash/.test(result.reason), `reason must name materialHash: ${result.reason}`);
      assert.ok(result.reason.includes('(fail closed)'), `reason must be the explicit fail-closed line: ${result.reason}`);
      assert.equal(result.currentMaterialHash, undefined, 'no current materialHash can exist when ls-tree fails');
      assert.equal(result.currentHead, FAKE_HEAD, 'HEAD itself was readable, so the result carries it (this is NOT the unreadable-HEAD branch)');
      assert.notEqual(result.reason, EVIDENCE_FRESHNESS_HEAD_UNREADABLE_REASON, 'must not be misreported as the unreadable-HEAD branch');
      assert.notEqual(result.reason, 'evidence corresponds to current HEAD', 'must not fall through to the head comparison (pre-fix behaviour)');
      assert.equal(/metadata-only changes/.test(result.reason), false, 'must not fall through to the changed-files head comparison');
      assert.deepEqual(result.changedFiles, []);
      assert.deepEqual(result.materialFiles, []);
      // Same fixture, evidence WITHOUT a materialHash: the material branch is not
      // entered, so the head comparison legitimately applies and reports fresh.
      const headOnly = checkEvidenceFreshnessForGit(root, FAKE_HEAD, undefined, root);
      assert.equal(headOnly.fresh, true, `head-only evidence must still take the head comparison: ${headOnly.reason}`);
      assert.equal(headOnly.reason, 'evidence corresponds to current HEAD');
    } finally {
      rmSync(root, { recursive: true, force: true });
      resetConfigCache();
    }
  });

  // ── complete snapshot: byte-identical behaviour ───────────────────────────
  testCase('complete snapshot (edge): full-digest repo -> no evidence-hash-snapshot row; rendered DONE checklist byte-identical with and without a supplied snapshot; session prints the normal section', () => {
    const { root, store } = fullDigestRepo(STORY_ID);
    try {
      const captured = tryCaptureEvidenceHashSnapshot({ gitCwd: root, metadataRoot: root, ref: 'HEAD' });
      assert.ok(captured, 'full-digest repo must capture a snapshot');
      const classification = classifyEvidenceHashSnapshot(captured);
      assert.equal(classification.complete, true, classification.detail);
      const withoutSupplied = buildDoneChecklist(STORY_ID, store, root, { auditWriter: null, gitCwd: root });
      const withSupplied = buildDoneChecklist(STORY_ID, store, root, { auditWriter: null, gitCwd: root, evidenceHashSnapshot: captured });
      assert.equal(withoutSupplied.some((r) => r.id === 'evidence-hash-snapshot'), false, 'complete snapshots push no evidence-hash-snapshot row');
      assert.deepEqual(withSupplied, withoutSupplied, 'row sets must be identical with and without the supplied snapshot');
      assert.equal(renderDoneChecklist(STORY_ID, withSupplied), renderDoneChecklist(STORY_ID, withoutSupplied), 'rendered DONE checklist must be byte-identical');
      assert.equal(/Evidence hash snapshot/.test(renderDoneChecklist(STORY_ID, withSupplied)), false);
      for (const target of ['DONE', 'REVIEW', 'TEST'] as LifecycleReadinessTarget[]) {
        const report = buildStoryReadinessReport({ storyId: STORY_ID, target, store, root, gitCwd: root });
        assert.equal(report.readiness.some((r) => /_hash_unavailable$/.test(r.code)), false, `${target}: no *_hash_unavailable row on a full-digest repo`);
      }
      const brief = createSessionHandlers({ store, root, scanRoot: join(root, 'packages/main') }).session_brief({ concise: true });
      assert.ok(brief.includes('\n## DONE pre-check\n'), `full-digest story must print the normal DONE pre-check section:\n${brief}`);
      assert.equal(brief.includes('## DONE pre-check unavailable'), false);
      assert.equal(brief.includes('DONE pre-check unavailable'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      resetConfigCache();
    }
  });
  // ── B-83aa CHK-003 follow-up: wrapper-root layouts ─────────────────────────
  // metadataRoot is NOT a git repository; the real repo is the configured
  // `gitRoot` subdir. Every consumer must classify the snapshot captured from
  // the RESOLVED git cwd (B-6666 pattern), never from the bare metadataRoot —
  // otherwise the fail-closed classifier blocks a legitimately clean DONE.
  testCase('wrapper-root (edge): clean configured gitRoot -> resolved-cwd snapshot complete, no evidence-hash-snapshot row, readiness DONE has no *_hash_unavailable row, legacy review run accepted', () => {
    const { metadataRoot, gitRoot, store } = wrapperRootRepo(STORY_ID, { unborn: false });
    try {
      const gitCwd = resolveGitCwd({ store, storyId: STORY_ID, metadataRoot, projectRoot: metadataRoot });
      assert.equal(realpathSync(gitCwd), realpathSync(gitRoot), 'resolveGitCwd must resolve the configured gitRoot on a wrapper-root layout');
      assert.notEqual(realpathSync(gitCwd), realpathSync(metadataRoot), 'wrapper-root fixture sanity: resolved cwd differs from metadataRoot (no self-comparison)');

      // The bare metadataRoot is not a repo: capturing from it yields a partial
      // snapshot. That is the wrong-cwd shape the classifier must never see on
      // a clean wrapper root; the resolved cwd yields a complete one.
      const fromBareRoot = classifyEvidenceHashSnapshot(captureEvidenceHashSnapshot({ gitCwd: metadataRoot, metadataRoot, ref: 'HEAD' }));
      assert.equal(fromBareRoot.complete, false, 'bare metadataRoot capture must be partial (fixture sanity, non-tautological)');
      const resolved = captureEvidenceHashSnapshot({ gitCwd, metadataRoot, ref: 'HEAD' });
      const resolvedClassification = classifyEvidenceHashSnapshot(resolved);
      assert.equal(resolvedClassification.complete, true, `resolved-cwd snapshot must be complete: ${resolvedClassification.detail}`);
      assert.deepEqual(resolvedClassification.missing, []);

      // done-oracle with the resolved gitCwd threaded (as every B-6666 caller does).
      const rows = buildDoneChecklist(STORY_ID, store, metadataRoot, { auditWriter: null, gitCwd });
      assert.equal(rows.some((r) => r.id === 'evidence-hash-snapshot'), false, 'clean wrapper root must push no evidence-hash-snapshot row');
      assert.equal(/Evidence hash snapshot/.test(renderDoneChecklist(STORY_ID, rows)), false);

      // lifecycle-readiness resolves gitCwd itself when none is supplied.
      for (const target of ['DONE', 'REVIEW', 'TEST'] as LifecycleReadinessTarget[]) {
        const report = buildStoryReadinessReport({ storyId: STORY_ID, target, store, root: metadataRoot });
        assert.equal(report.readiness.some((r) => /_hash_unavailable$/.test(r.code)), false, `${target}: no *_hash_unavailable row on a clean wrapper root`);
      }

      // The regression: a LEGACY review run (no workspaceBinding) recomputed its
      // freshness from the bare projectRoot (== metadataRoot). With the fail-closed
      // classifier that read "HEAD unreadable" and blocked DONE. It must resolve
      // the git cwd and accept the run bound to the resolved digests.
      const story = store.readStory(STORY_ID);
      const legacyRun = legacyReviewRun(story, resolved.headHash!, resolved.materialHash!, resolved.storyFilesHash);
      store.writeReviewRuns(STORY_ID, { runs: [legacyRun] });
      const accepted = assertCurrentReviewRunForEvidence(store, story, metadataRoot, legacyRun.agent, legacyRun.reviewRunId);
      assert.equal(accepted.reviewRunId, legacyRun.reviewRunId, 'legacy run bound to the resolved-cwd digests must be accepted from the bare metadataRoot');
    } finally {
      rmSync(metadataRoot, { recursive: true, force: true });
      resetConfigCache();
    }
  });

  testCase('wrapper-root (adversarial): unborn configured gitRoot still FAILS CLOSED (row fail/blocking, readiness DONE blocking, legacy review run rejected)', () => {
    const { metadataRoot, gitRoot, store } = wrapperRootRepo(STORY_ID, { unborn: true });
    try {
      const gitCwd = resolveGitCwd({ store, storyId: STORY_ID, metadataRoot, projectRoot: metadataRoot });
      const snapshot = captureEvidenceHashSnapshot({ gitCwd, metadataRoot, ref: 'HEAD' });
      const classification = classifyEvidenceHashSnapshot(snapshot);
      assert.equal(classification.complete, false, `unborn wrapper gitRoot (${gitRoot}) must yield a partial snapshot`);
      assert.ok(classification.missing.includes('headHash') && classification.missing.includes('materialHash'), classification.detail);

      const rows = buildDoneChecklist(STORY_ID, store, metadataRoot, { auditWriter: null, gitCwd });
      const row = rows.find((r) => r.id === 'evidence-hash-snapshot');
      assert.ok(row, 'unborn wrapper gitRoot must push the evidence-hash-snapshot row');
      assert.equal(row.status, 'fail');
      assert.equal(row.blocking, true);
      assert.match(row.detail ?? '', /headHash/);
      assert.match(row.detail ?? '', /materialHash/);

      const report = buildStoryReadinessReport({ storyId: STORY_ID, target: 'DONE', store, root: metadataRoot });
      const head = report.readiness.find((r) => r.code === 'head_hash_unavailable');
      const material = report.readiness.find((r) => r.code === 'material_hash_unavailable');
      assert.ok(head && material, 'unborn wrapper gitRoot must surface head/material unavailable rows for DONE');
      assert.equal(head.blocking, true);
      assert.equal(material.blocking, true);

      const story = store.readStory(STORY_ID);
      const legacyRun = legacyReviewRun(story, FAKE_HEAD, FAKE_MATERIAL, FAKE_STORY_FILES);
      store.writeReviewRuns(STORY_ID, { runs: [legacyRun] });
      assert.throws(
        () => assertCurrentReviewRunForEvidence(store, story, metadataRoot, legacyRun.agent, legacyRun.reviewRunId),
        /fail closed/,
        'legacy run over an unborn wrapper gitRoot must still be rejected fail-closed',
      );
    } finally {
      rmSync(metadataRoot, { recursive: true, force: true });
      resetConfigCache();
    }
  });
} finally {
  rmSync(unborn, { recursive: true, force: true });
  resetConfigCache();
}

console.log(`${MARKER}: ${cases} cases`);
console.log('evidence-hash-snapshot-classifier smoke passed');
