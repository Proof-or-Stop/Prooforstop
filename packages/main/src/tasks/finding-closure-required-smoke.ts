#!/usr/bin/env node
/**
 * Finding closure required (no round decay).
 *
 * Policy: every VERIFIED open critical/high/medium finding (in every profile,
 * including the default balanced; low stays advisory) must be closed (finding_resolve with repair evidence,
 * review_remediation_close, or finding_dismiss where allowed) before TEST and
 * before DONE, independent of the review round in which it was raised.
 * Findings from earlier rounds count. Suspected / disproven findings keep
 * their advisory treatment. There is no review-round limit.
 *
 * Defect (strict profile, where medium is a blocking severity): a verified
 * MEDIUM finding raised in round 1 stayed status=open; round 2 was all-pass,
 * round decay made medium advisory, REVIEW->TEST and DONE only read
 * current-round evidence, and the story could merge with no resolution record.
 * (Harness scenario D runs the balanced profile, where medium never blocks;
 * D now uses a HIGH finding to exercise the same closure rule end to end.)
 *
 * Asserted here against the real gates (getGuardFailureReason TEST, the DONE
 * review-verdict predicate):
 *   1. round-1 verified medium open + round-2 all-pass -> TEST refuses, DONE
 *      review-verdict refuses; one next action names the id and the exact
 *      finding_resolve command.
 *   2. after finding_resolve (real handler) -> TEST admitted, DONE
 *      review-verdict admitted.
 *   3. a round-1 SUSPECTED medium open finding does not block.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { getGuardFailureReason, evaluateDonePredicates } from '../core/machine.js';
import { signFinding } from '../core/finding-verify.js';
import { createFindingHandlers } from '../handlers/finding.js';
import { seedCurrentReviewFixture, bindCurrentFixtureFinding } from './current-review-fixture.js';
import { nativeReviewFixtureBrokers } from './native-review-fixture.js';
import { runIsolatedFindingFixture } from './isolated-finding-fixture.js';
import type { ChecklistData, Finding, FindingEvidenceState, StoryInfo } from '../core/types.js';

if (await runIsolatedFindingFixture(import.meta.url)) process.exit(0);

const STORY_ID = 'B-fcrq';
const ROUND_1 = '2026-09-30T10:01:00.000Z';
const ROUND_2 = '2026-09-30T11:01:00.000Z';
const REVIEWERS = ['proof-or-stop-review-concept', 'proof-or-stop-review-quality', 'proof-or-stop-review-test-coverage'];

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function story(round: string, events: StoryInfo['events']): StoryInfo {
  const now = '2026-09-30T10:00:00.000Z';
  return {
    storyId: STORY_ID, name: 'finding-closure-required-smoke', title: 'Finding closure required smoke',
    description: 'Synthetic story: a verified round-1 finding must be closed before TEST and DONE.',
    type: 'chore', phase: 'REVIEW', priority: 'medium', createdAt: now, startedAt: now, endedAt: null,
    currentReviewRound: round, events,
  };
}

function finding(opts: { suffix: string; agent: string; reviewRunId: string; round: string; severity: Finding['severity'];
  status: Finding['status']; evidenceState?: FindingEvidenceState; uncertaintyReason?: string }): Finding {
  const id = `${STORY_ID}:F-${opts.suffix}`;
  const createdAt = `${opts.round.slice(0, 17)}${opts.suffix.slice(-2)}.000Z`;
  const desc = `${opts.agent} ${opts.severity} finding ${opts.suffix}`;
  return bindCurrentFixtureFinding({
    id, desc, severity: opts.severity, category: 'edge', status: opts.status,
    ...(opts.evidenceState ? { evidenceState: opts.evidenceState } : {}),
    ...(opts.uncertaintyReason ? { uncertaintyReason: opts.uncertaintyReason } : {}),
    agent: opts.agent, createdAt, reviewRound: opts.round, reviewRunId: opts.reviewRunId,
    _hash: signFinding(STORY_ID, id, desc, opts.severity, createdAt, opts.round, opts.reviewRunId),
  });
}

/** Round 1 raises `subject` (medium, open); round 2 is all-pass (low resolved coverage per lane). */
function twoRoundRepo(subjectState: FindingEvidenceState, uncertaintyReason?: string, profile: 'strict' | 'balanced' = 'strict',
  severity: Finding['severity'] = 'medium'): { root: string; store: StoryStore; subject: Finding } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-fcrq-'));
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', testsDir: 'packages/main/tests', fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', worktreeDir: '.worktrees',
    workflow: { profile }, nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() },
  }));
  write(root, 'README.md', 'finding closure required smoke\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proof-or-Stop Smoke', 'commit', '-m', 'base']);
  resetConfigCache();
  const store = new StoryStore(root);
  const now = '2026-09-30T10:00:00.000Z';
  const checklist: ChecklistData = {
    items: ['001', '002'].map(suffix => ({
      id: `CHK-${suffix}`, title: `Done item ${suffix}`, context: 'Synthetic checklist item.',
      verificationIntent: { happy: [{ desc: 'Exercise finding closure through the real review gates.', type: 'manual' as const }], edge: [], adversarial: [] },
      verificationEvidence: [{ intentRef: `CHK-${suffix}:happy:0`, kind: 'manual_transcript' as const, result: 'pass' as const,
        note: 'Synthetic acceptance prerequisite for this isolated gate fixture; the assertions exercise the real Finding gates.' }],
      status: 'done' as const, startTime: now, endTime: now,
    })),
  };
  store.writeStory(STORY_ID, story(ROUND_1, [{ phase: 'REVIEW', action: 'advance', timestamp: ROUND_1 }]));
  store.writeChecklist(STORY_ID, checklist);
  store.writeUnderstanding(STORY_ID, { task: 'Close verified findings', outcome: 'Verified blocking findings of any round block TEST/DONE until closed',
    facts: [], constraints: [], unknowns: [], touchpoints: ['packages/main/src/core/machine.ts'], timestamp: now });
  store.writeDecision(STORY_ID, {
    principles: ['closure over decay', 'one gate source', 'no round cap'], drivers: ['harness D merged an open verified finding'],
    options: [{ name: 'A: closure required', pros: ['no silent merge'], cons: ['owner must resolve'] }, { name: 'B: round decay', pros: ['fewer blocks'], cons: ['open findings merge'] }],
    chosen: 'A: closure required', rationale: 'A verified finding must be closed, not aged out.', timestamp: now,
  });

  const r1 = seedCurrentReviewFixture(root, store, STORY_ID, REVIEWERS);
  const subject = finding({ suffix: '001', agent: 'proof-or-stop-review-test-coverage', reviewRunId: r1.get('proof-or-stop-review-test-coverage')!,
    round: ROUND_1, severity, status: 'open', evidenceState: subjectState, uncertaintyReason });
  const r1Coverage = REVIEWERS.filter(lane => lane !== 'proof-or-stop-review-test-coverage').map((lane, index) => finding({
    suffix: `01${index + 1}`, agent: lane, reviewRunId: r1.get(lane)!, round: ROUND_1, severity: 'low', status: 'resolved' }));

  // DEV repair then a second REVIEW round: all lanes pass.
  store.writeStory(STORY_ID, story(ROUND_2, [
    { phase: 'REVIEW', action: 'advance', timestamp: ROUND_1 },
    { phase: 'DEV', action: 'advance', timestamp: '2026-09-30T10:30:00.000Z' },
    { phase: 'REVIEW', action: 'advance', timestamp: ROUND_2 },
  ]));
  const r2 = seedCurrentReviewFixture(root, store, STORY_ID, REVIEWERS);
  const r2Pass = REVIEWERS.map((lane, index) => finding({
    suffix: `02${index + 1}`, agent: lane, reviewRunId: r2.get(lane)!, round: ROUND_2, severity: 'low', status: 'resolved' }));
  store.writeFindings(STORY_ID, { findings: [subject, ...r1Coverage, ...r2Pass] });
  return { root, store, subject };
}

function doneReviewVerdict(root: string, store: StoryStore): string | null {
  for (const row of evaluateDonePredicates({ storyId: STORY_ID, store, projectRoot: root })) {
    if (row.id === 'review-verdict') return row.failureReason;
  }
  throw new Error('DONE review-verdict predicate missing');
}

function resolveThroughHandler(root: string, store: StoryStore, findingId: string): string {
  const before = process.cwd();
  try {
    process.chdir(root);
    return createFindingHandlers({ root, store, scanRoot: join(root, 'packages/main') } as never).finding_resolve({
      storyId: STORY_ID, findingId,
      resolution: 'Repair commit adds TestReverseEmpty; focused go test ./strs -run TestReverseEmpty passes.',
      resolutionType: 'fixed', resolveEvidenceStrength: 'strong',
    });
  } finally { process.chdir(before); }
}

function verifiedEarlierRoundFindingMustBeClosed(profile: 'strict' | 'balanced' = 'strict'): void {
  const { root, store, subject } = twoRoundRepo('verified', undefined, profile);
  try {
    const test = getGuardFailureReason(STORY_ID, store, 'TEST', root);
    assert.ok(test, `a verified ${subject.severity} finding from an earlier round must block REVIEW->TEST under ${profile} (closure required)`);
    assert.match(test, new RegExp(subject.id), 'TEST refusal names the open finding id');
    const resolveCommand = `proof-or-stop finding_resolve --storyId=${STORY_ID} --findingId=${subject.id} --resolution=`;
    assert.ok(test.includes(resolveCommand), `TEST refusal prints the exact resolve command:\n${test}`);
    assert.equal(test.split('\n').filter(line => /Next:/.test(line)).length, 1, `TEST refusal prints exactly one next action:\n${test}`);
    const done = doneReviewVerdict(root, store);
    assert.ok(done, 'the DONE review-verdict predicate must refuse the open verified finding');
    assert.match(done, new RegExp(subject.id));
    assert.ok(done.includes(resolveCommand), `DONE refusal prints the exact resolve command:\n${done}`);
    console.log(`✓ ${profile}: round-1 verified medium open finding blocks TEST and DONE after an all-pass round 2`);

    const resolved = resolveThroughHandler(root, store, subject.id);
    assert.match(resolved, /resolved/);
    assert.equal(getGuardFailureReason(STORY_ID, store, 'TEST', root), null, 'after finding_resolve REVIEW->TEST is admitted');
    assert.equal(doneReviewVerdict(root, store), null, 'after finding_resolve the DONE review-verdict predicate is admitted');
    console.log('✓ after finding_resolve with repair evidence TEST and the DONE review verdict are admitted');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function suspectedFindingDoesNotBlock(): void {
  const { root, store } = twoRoundRepo('suspected', 'static reading only; the empty-string path was not reproduced');
  try {
    assert.equal(getGuardFailureReason(STORY_ID, store, 'TEST', root), null, 'a suspected finding keeps its advisory treatment');
    assert.equal(doneReviewVerdict(root, store), null, 'a suspected finding does not block the DONE review verdict');
    console.log('✓ round-1 suspected medium open finding does not block');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function lowFindingStaysAdvisory(): void {
  const { root, store } = twoRoundRepo('verified', undefined, 'balanced', 'low');
  try {
    assert.equal(getGuardFailureReason(STORY_ID, store, 'TEST', root), null, 'a verified low finding stays advisory');
    assert.equal(doneReviewVerdict(root, store), null, 'a verified low finding does not block the DONE review verdict');
    console.log('✓ balanced: round-1 verified low open finding stays advisory');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

verifiedEarlierRoundFindingMustBeClosed('strict');
// Every profile (incl. the default balanced) requires verified critical/high/medium closure.
verifiedEarlierRoundFindingMustBeClosed('balanced');
suspectedFindingDoesNotBlock();
lowFindingStaysAdvisory();
console.log('finding-closure-required-smoke: PASS');
