#!/usr/bin/env node
/**
 * done-escalation-drift-advisory-smoke (B-edf1 CHK-002)
 *
 * Regression for a soundness gap found by a Codex host-2 review of merged B-5a9a:
 * when a host verdict is DOWNGRADE-ACCEPTED — its whole-tree `materialHash`
 * drifted (e.g. an unrelated main merge) but the story's `storyFilesHash` still
 * matches the story-owned files — `evaluateReviewEscalation` keeps
 * escalation.ok=true and records a MANDATORY re-attestation advisory in
 * `report.advisories`. The DONE Review-escalation row used to put that advisory
 * only in the row `hint`. But `renderDoneChecklist` expands `hint` ONLY for
 * `warn` rows and the user-value-summary row — a PASS row prints ONLY its
 * `detail`. So on a passing DONE the advisory was DROPPED and whole-tree drift
 * passed DONE silently.
 *
 * The fix (done-oracle.ts): when escalation.ok && escalation.advisories?.length,
 * append the advisories to the Review-escalation row's `detail` (the rendered,
 * operator-visible string) while keeping status=pass and blocking unchanged.
 *
 * Proofs (real disk fixtures, cleaned up in finally):
 *   (A) Advisory-visible case — a story whose escalation report has a
 *       downgrade-accepted host verdict (host_verdict events recorded with a
 *       STALE materialDigest but a storyFilesHash that matches the current
 *       story-owned files, simulated via an unrelated main merge that drifts the
 *       whole-tree materialHash while leaving the story files untouched). The
 *       Review-escalation row MUST be PASS, AND the rendered operator-visible
 *       DONE-checklist text MUST CONTAIN the re-attestation advisory.
 *   (B) Control case — no drift (host_verdict events bound to the CURRENT
 *       materialHash). The Review-escalation row MUST be PASS, AND the rendered
 *       text MUST contain NO advisory text.
 *
 * On success prints `✓ done-escalation-drift-advisory smoke passed (N checks)`;
 * any assert failure throws -> exit 1.
 *
 * RED/GREEN: revert the done-oracle.ts detail-append in dist and the (A)
 * advisory-visible render assertion fails (the advisory is dropped on the pass
 * row); the (B) control assertion stays green either way.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildDoneChecklist, renderDoneChecklist, type DoneCheckRow } from '../core/done-oracle.js';
import { currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, ProcessEvent, StoryInfo } from '../core/types.js';

const STORY_ID = 'B-edf1-smoke';
const STORY_BRANCH = `story/${STORY_ID}`;
const ADVISORY_RE = /re-attestation advisory required/;

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'smoke',
      GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
      GIT_COMMITTER_NAME: 'smoke',
      GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
    },
  });
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf-8');
}

const CONFIG = JSON.stringify(
  {
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'light' },
  },
  null,
  2,
);

/**
 * Seed a plain git repo with a story branch carrying one committed story-owned
 * source file relative to main, so currentStoryFilesHash is non-empty. Returns
 * the repo root (== metadataRoot == gitRoot for this plain layout).
 */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'done-escalation-drift-'));
  write(root, 'proof-or-stop.config.json', CONFIG);
  write(root, 'README.md', 'done escalation drift advisory smoke\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed']);
  git(root, ['checkout', '-B', STORY_BRANCH]);
  // A story-owned source file committed on the story branch -> non-empty
  // currentStoryFilesHash (diffed against merge-base with main).
  write(root, 'packages/main/src/story.ts', 'export const story = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'story file']);
  return root;
}

/**
 * On the story branch, merge an unrelated commit from main. This drifts the
 * whole-tree materialHash (a new unrelated file enters the tree) while leaving
 * the story-owned files — and therefore currentStoryFilesHash — unchanged.
 */
function driftMainIntoStory(root: string): void {
  git(root, ['checkout', 'main']);
  write(root, 'packages/main/src/unrelated.ts', 'export const unrelated = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'unrelated main file']);
  git(root, ['checkout', STORY_BRANCH]);
  git(root, ['merge', 'main', '--no-edit']);
}

/** A minimal TEST-phase story with one done checklist item (DONE-shaped). */
function writeStory(store: StoryStore): void {
  const now = '2026-06-18T00:00:00.000Z';
  const story: StoryInfo = {
    storyId: STORY_ID,
    name: 'done-escalation-drift-fixture',
    title: 'Done escalation drift advisory fixture',
    description: 'Drive the DONE-oracle Review-escalation row over a downgrade-accepted host verdict.',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic item',
      context: 'Synthetic context',
      status: 'done',
      startTime: null,
      endTime: null,
    }],
  };
  store.writeStory(STORY_ID, story);
  store.writeChecklist(STORY_ID, checklist);
}

/** Append a passing host_verdict process event with the given material/story hashes. */
function appendVerdict(
  store: StoryStore,
  runId: string,
  host: string,
  materialDigest: string,
  storyFilesHash: string,
): void {
  const event: Omit<ProcessEvent, 'timestamp'> = {
    type: 'host_verdict',
    verdictId: `${runId}-${host}`,
    runId,
    hostId: host,
    provider: host,
    sessionId: `${host}-session`,
    keyId: `${host}-key`,
    decision: 'pass',
    materialDigest,
    storyFilesHash,
    validationDigest: `validation-${runId}`,
    promptDigest: `prompt-${runId}`,
  };
  store.appendProcessEvent(STORY_ID, event);
}

/** A full 3x2 quorum (3 rounds x 2 independent hosts), all bound to the same hashes. */
function appendFullQuorum(store: StoryStore, materialDigest: string, storyFilesHash: string): void {
  appendVerdict(store, 'round-1', 'codex-a', materialDigest, storyFilesHash);
  appendVerdict(store, 'round-1', 'claude-a', materialDigest, storyFilesHash);
  appendVerdict(store, 'round-2', 'codex-b', materialDigest, storyFilesHash);
  appendVerdict(store, 'round-2', 'claude-b', materialDigest, storyFilesHash);
  appendVerdict(store, 'round-3', 'codex-c', materialDigest, storyFilesHash);
  appendVerdict(store, 'round-3', 'claude-c', materialDigest, storyFilesHash);
}

function escalationRow(rows: DoneCheckRow[]): DoneCheckRow {
  const row = rows.find((r) => r.id === 'review-escalation');
  assert.ok(row, 'DONE checklist must include a review-escalation row');
  return row!;
}

/** Extract the rendered review-escalation line(s) from the operator-visible text. */
function escalationLine(rendered: string): string {
  const line = rendered.split('\n').find((l) => l.includes('Review escalation'));
  assert.ok(line, 'rendered DONE checklist must include a Review escalation line');
  return line!;
}

// B-6de6 CX-1: the review-assurance-floor row had the SAME dropped-advisory gap
// as the escalation row above; assert the floor row also surfaces the advisory.
function floorRow(rows: DoneCheckRow[]): DoneCheckRow {
  const row = rows.find((r) => r.id === 'review-assurance-floor');
  assert.ok(row, 'DONE checklist must include a review-assurance-floor row');
  return row!;
}

/** Extract the rendered review-assurance-floor line from the operator-visible text. */
function floorLine(rendered: string): string {
  const line = rendered.split('\n').find((l) => l.includes('Review assurance floor'));
  assert.ok(line, 'rendered DONE checklist must include a Review assurance floor line');
  return line!;
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ════════════════════════════════════════════════════════════════════════════
// (A) Advisory-visible case: downgrade-accepted host verdict -> the rendered
//     pass row must SURFACE the re-attestation advisory.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const root = makeRepo();
  try {
    const store = new StoryStore(root);
    writeStory(store);

    // Record the pre-drift hashes, then drift the whole-tree materialHash via an
    // unrelated main merge (story-owned files unchanged -> storyFilesHash stable).
    const recordedMaterial = currentMaterialHash(root);
    const recordedStoryFiles = currentStoryFilesHash(root);
    assert.ok(recordedMaterial, '(A) pre-drift materialHash must be defined');
    assert.ok(recordedStoryFiles, '(A) pre-drift storyFilesHash must be defined');

    driftMainIntoStory(root);

    const driftedMaterial = currentMaterialHash(root);
    const driftedStoryFiles = currentStoryFilesHash(root);
    assert.ok(driftedMaterial, '(A) post-drift materialHash must be defined');
    assert.notEqual(driftedMaterial, recordedMaterial, '(A) unrelated main merge must drift the whole-tree materialHash');
    assert.equal(driftedStoryFiles, recordedStoryFiles, '(A) story-owned file hash must stay stable across an unrelated main merge');

    // Verdicts recorded BEFORE the drift: stale materialDigest, but storyFilesHash
    // still matches the current story-owned files -> downgrade-accepted -> advisory.
    appendFullQuorum(store, recordedMaterial!, recordedStoryFiles!);

    const rows = buildDoneChecklist(STORY_ID, store, root, { auditWriter: null });
    const row = escalationRow(rows);
    const rendered = renderDoneChecklist(STORY_ID, rows);

    check('(A) Review-escalation row is PASS with a downgrade-accepted verdict', () => {
      assert.equal(
        row.status,
        'pass',
        `(A) downgrade-accepted (materialHash drift + storyFilesHash match) must keep the row a PASS ` +
          `(got status=${row.status}, detail=${JSON.stringify(row.detail)})`,
      );
      assert.equal(row.blocking, false, `(A) the advisory must NOT make the row blocking (got blocking=${row.blocking})`);
    });

    check('(A) the re-attestation advisory is SURFACED in the rendered pass-row detail', () => {
      assert.match(
        row.detail ?? '',
        ADVISORY_RE,
        `(A) the Review-escalation row detail must contain the re-attestation advisory ` +
          `(got detail=${JSON.stringify(row.detail)}). This is the dropped-advisory soundness gap.`,
      );
      // The operator only ever sees the rendered string, and renderDoneChecklist
      // expands hint ONLY for warn / user-value-summary rows. So the advisory MUST
      // be on the rendered Review escalation LINE (its detail), not just the hint.
      assert.match(
        escalationLine(rendered),
        ADVISORY_RE,
        `(A) the operator-visible rendered Review escalation line must contain the advisory ` +
          `(got line=${JSON.stringify(escalationLine(rendered))})`,
      );
    });

    // B-6de6 CX-1: the SAME downgrade-accepted full quorum makes the floor's
    // local rounds downgrade-accepted too, so the floor row must likewise PASS
    // and SURFACE the re-attestation advisory in its rendered detail.
    const frow = floorRow(rows);
    check('(A) Review-assurance-floor row is PASS with a downgrade-accepted verdict', () => {
      assert.equal(
        frow.status,
        'pass',
        `(A) downgrade-accepted floor must keep the row a PASS (got status=${frow.status}, detail=${JSON.stringify(frow.detail)})`,
      );
      assert.equal(frow.blocking, false, `(A) the floor advisory must NOT make the row blocking (got blocking=${frow.blocking})`);
    });

    check('(A) the floor re-attestation advisory is SURFACED in the rendered pass-row detail', () => {
      assert.match(
        frow.detail ?? '',
        ADVISORY_RE,
        `(A) the Review-assurance-floor row detail must contain the re-attestation advisory ` +
          `(got detail=${JSON.stringify(frow.detail)}). This is the dropped-advisory soundness gap (floor row).`,
      );
      assert.match(
        floorLine(rendered),
        ADVISORY_RE,
        `(A) the operator-visible rendered Review assurance floor line must contain the advisory ` +
          `(got line=${JSON.stringify(floorLine(rendered))})`,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// (B) Control case: no drift (verdicts bound to the CURRENT materialHash) -> the
//     pass row carries NO advisory text (a clean DONE stays clean).
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const root = makeRepo();
  try {
    const store = new StoryStore(root);
    writeStory(store);

    const material = currentMaterialHash(root);
    const storyFiles = currentStoryFilesHash(root);
    assert.ok(material, '(B) materialHash must be defined');
    assert.ok(storyFiles, '(B) storyFilesHash must be defined');

    // Verdicts bound to the CURRENT materialHash -> no downgrade, no advisory.
    appendFullQuorum(store, material!, storyFiles!);

    const rows = buildDoneChecklist(STORY_ID, store, root, { auditWriter: null });
    const row = escalationRow(rows);
    const rendered = renderDoneChecklist(STORY_ID, rows);

    check('(B) Review-escalation row is PASS with no drift', () => {
      assert.equal(
        row.status,
        'pass',
        `(B) verdicts bound to the current materialHash must PASS (got status=${row.status}, detail=${JSON.stringify(row.detail)})`,
      );
    });

    check('(B) a clean (no-drift) DONE carries NO advisory text', () => {
      assert.doesNotMatch(
        row.detail ?? '',
        ADVISORY_RE,
        `(B) a no-drift pass row must NOT contain advisory text (got detail=${JSON.stringify(row.detail)})`,
      );
      assert.doesNotMatch(
        rendered,
        ADVISORY_RE,
        `(B) the rendered no-drift DONE checklist must NOT contain advisory text`,
      );
    });

    // B-6de6 CX-1 control: the floor row, with no drift, must also carry NO
    // advisory text (advisory only fires on accepted drift, never on clean DONE).
    const frow = floorRow(rows);
    check('(B) a clean (no-drift) floor row carries NO advisory text', () => {
      assert.equal(frow.status, 'pass', `(B) no-drift floor row must PASS (got status=${frow.status})`);
      assert.doesNotMatch(
        frow.detail ?? '',
        ADVISORY_RE,
        `(B) a no-drift floor pass row must NOT contain advisory text (got detail=${JSON.stringify(frow.detail)})`,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

console.log(`\n✓ done-escalation-drift-advisory smoke passed (${passed} checks)`);
