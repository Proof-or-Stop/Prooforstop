#!/usr/bin/env node

// Regression (bench run 6): a remediation inside REVIEW does not mint a new
// ReviewRun.reviewRound. The live Story had RR-001..RR-006 on the first
// candidate HEAD and RR-007..RR-009 on the repaired HEAD, all in one round, so
// the round-based re-review never triggered: the repaired-candidate lanes
// started cold with new Codex threads and the full-review prompt.
//
// "Previous review of this lane" is the newest earlier ReviewRun of the lane on
// a different candidate HEAD. A relaunch on the SAME HEAD (e.g. a failed lane
// in the same wave) still starts fresh with the unchanged prompt.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as managedHostRun from '../core/managed-host-run.js';
import { buildManagedReviewerPrompt, managedReviewerPromptDigest } from '../core/managed-review-evidence.js';
import { StoryStore } from '../core/store.js';
import type { Finding, ReviewRun } from '../core/types.js';

const MARKER = 'managed re-review ignores an earlier candidate HEAD within the same review round';
const STORY = 'B-6e6e';
const QUALITY = 'proof-or-stop-review-quality';
const BEHAVIOR = 'proof-or-stop-review-behavior';
const CRITIC = 'proof-or-stop-review-topology-critic';
const ROUND = '2026-09-29T16:58:45.484Z';
const MODEL = 'gpt-5.5';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function at(minute: number): string {
  return new Date(Date.parse(ROUND) + minute * 60_000).toISOString();
}

function reviewRun(n: number, lane: string, headHash: string, minute: number, extra: Partial<ReviewRun> = {}): ReviewRun {
  return {
    reviewRunId: `${STORY}:RR-${String(n).padStart(3, '0')}`, storyId: STORY, agent: lane, lane, reviewRound: ROUND,
    startedAt: at(minute), headHash, materialHash: 'sha256:material', storyFilesHash: 'sha256:story',
    promptHash: 'unused', assembledPrompt: `Review lane ${lane}.`, ...extra,
  };
}

function writeHostRun(root: string, runId: string, run: ReviewRun, state: string, minute: number, threadId: string): void {
  const dir = managedHostRun.managedHostRunDirectory(root, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({
    runId, host: 'codex', profile: 'managed_reviewer', storyId: STORY, agentType: run.lane,
    lane: run.lane, reviewRunId: run.reviewRunId, cwd: join(root, 'scratch', runId), model: MODEL,
  }));
  writeFileSync(join(dir, 'terminal.json'), JSON.stringify({ runId, state, terminalAt: at(minute) }));
  writeFileSync(join(dir, 'live-output.jsonl'), [
    { sequence: 1, stream: 'stdout', text: `{"type":"thread.started","thread_id":"${threadId}"}\n` },
  ].map(frame => JSON.stringify(frame)).join('\n') + '\n');
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), 'rereview-by-head-'));
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'smoke@example.invalid');
    git(root, 'config', 'user.name', 'smoke');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'queue.ts'), 'export function drain(q: number[]) {\n  return q.pop();\n}\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'first candidate');
    const head1 = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'src', 'queue.ts'), 'export function drain(q: number[]) {\n  return q.shift(); // REPAIR-LINE\n}\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'repair inside REVIEW');
    const head2 = git(root, 'rev-parse', 'HEAD');

    // One review round. Wave 1 on head1 (quality relaunched once), wave 2 on head2 after the repair.
    const q1 = reviewRun(1, QUALITY, head1, 0);
    const b1 = reviewRun(2, BEHAVIOR, head1, 0);
    const c1 = reviewRun(3, CRITIC, head1, 0, { reviewPurpose: 'topology' });
    const q1Relaunch = reviewRun(4, QUALITY, head1, 20);
    const q2 = reviewRun(7, QUALITY, head2, 60);
    const b2 = reviewRun(8, BEHAVIOR, head2, 60);
    const c2 = reviewRun(9, CRITIC, head2, 60, { reviewPurpose: 'topology' });
    const q2Relaunch = reviewRun(10, QUALITY, head2, 90);
    const store = new StoryStore(root);
    store.writeReviewRuns(STORY, { runs: [q1, b1, c1, q1Relaunch, q2, b2, c2, q2Relaunch] });
    const earlier: Finding = {
      id: `${STORY}:F-001`, desc: 'drain returns the newest item instead of the oldest', severity: 'high',
      category: 'edge', status: 'resolved', reviewRound: ROUND, agent: QUALITY, reviewRunId: q1Relaunch.reviewRunId,
    };
    const current: Finding = {
      id: `${STORY}:F-002`, desc: 'CURRENT-CANDIDATE-FINDING', severity: 'low',
      category: 'edge', status: 'open', reviewRound: ROUND, agent: BEHAVIOR, reviewRunId: b2.reviewRunId,
    };
    store.writeFindings(STORY, { findings: [earlier, current] });

    const codexHome = join(root, 'codex-home');
    const sessions = join(codexHome, 'sessions', '2026', '09', '29');
    mkdirSync(sessions, { recursive: true });
    const ids = {
      q1: '019a0000-0000-7000-8000-00000000a001',
      q1Relaunch: '019a0000-0000-7000-8000-00000000a004',
      b1: '019a0000-0000-7000-8000-00000000b002',
      c1: '019a0000-0000-7000-8000-00000000c003',
      q2: '019a0000-0000-7000-8000-00000000a007',
    };
    for (const id of Object.values(ids)) writeFileSync(join(sessions, `rollout-2026-09-29T17-00-00-${id}.jsonl`), '{}\n');
    writeHostRun(root, 'run-q1', q1, 'completed', 10, ids.q1);
    writeHostRun(root, 'run-b1', b1, 'completed', 10, ids.b1);
    writeHostRun(root, 'run-c1', c1, 'completed', 10, ids.c1);
    writeHostRun(root, 'run-q1-relaunch', q1Relaunch, 'completed', 30, ids.q1Relaunch);
    writeHostRun(root, 'run-q2', q2, 'completed', 70, ids.q2);

    const find = managedHostRun.managedResumeSessionForSpec as unknown as (spec: Record<string, unknown>, codexHome: string) => string | null;
    const spec = (run: ReviewRun) => ({
      runId: 'run-current', host: 'codex', profile: 'managed_reviewer', storyId: STORY, agentType: run.lane,
      lane: run.lane, reviewRunId: run.reviewRunId, cwd: join(root, 'scratch', 'current'), root, model: MODEL,
    });
    // Resume: same round, earlier candidate HEAD.
    assert.equal(find(spec(q2), codexHome), ids.q1Relaunch, `${MARKER}: the repaired-candidate lane does not resume its head1 session`);
    assert.equal(find(spec(b2), codexHome), ids.b1, 'each lane resumes only its own earlier-candidate session');
    assert.equal(find(spec(q2Relaunch), codexHome), ids.q1Relaunch, 'a same-head relaunch never resumes a session on its own candidate');
    assert.equal(find(spec(q1Relaunch), codexHome), null, 'a relaunch whose only earlier runs are on the same HEAD starts fresh');
    assert.equal(find(spec(q1), codexHome), null, 'the first review of a lane starts fresh');
    assert.equal(find(spec(c2), codexHome), null, 'the topology critic starts fresh');

    // Prompt: repair diff and earlier-candidate findings only; same-head relaunch unchanged.
    const round2 = buildManagedReviewerPrompt(root, q2);
    assert.match(round2, /Re-review/, `${MARKER}: the repaired-candidate prompt has no re-review section`);
    assert.ok(round2.includes('REPAIR-LINE'), 'the prompt carries the repair diff');
    assert.ok(round2.includes(`git diff ${head1}..${head2}`), 'the diff base is the previous run head');
    assert.ok(round2.includes(earlier.id) && round2.includes('drain returns the newest item'), 'earlier-candidate findings are listed');
    assert.ok(!round2.includes(current.id) && !round2.includes('CURRENT-CANDIDATE-FINDING'),
      'findings on the current candidate never enter the prompt');
    assert.equal(buildManagedReviewerPrompt(root, q2Relaunch), buildManagedReviewerPrompt(root, q2).replaceAll(q2.reviewRunId, q2Relaunch.reviewRunId),
      'a same-head relaunch after the repair gets the same re-review context');
    const emptyRoot = mkdtempSync(join(tmpdir(), 'rereview-by-head-empty-'));
    try {
      for (const run of [q1, q1Relaunch, c2]) {
        assert.equal(buildManagedReviewerPrompt(root, run), buildManagedReviewerPrompt(emptyRoot, run),
          `${run.reviewRunId} keeps the unchanged first-review prompt`);
      }
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
    const digest = managedReviewerPromptDigest(root, q2);
    store.writeFindings(STORY, { findings: [earlier, current, { ...current, id: `${STORY}:F-003`, reviewRunId: q2.reviewRunId }] });
    assert.equal(managedReviewerPromptDigest(root, q2), digest, 'data from runs on the current HEAD never changes the digest');
    console.log('rereview-by-head-smoke: PASS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
