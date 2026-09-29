#!/usr/bin/env node

// Regression: every managed REVIEW round launched each code-review lane as a
// cold Codex session with the same full-review prompt. Each lane re-read the
// whole repository (8-10 minutes, ~1.6-1.9M input tokens) and kept reporting
// new problems in unchanged code, so rounds did not converge.
//
// A later round must (1) resume the Codex session the same lane answered in
// during an earlier round, and (2) tell that lane what changed since then:
// the material repair diff and the findings raised earlier, with instructions
// to confirm those findings and review the changed code. Round 1, other lanes
// and the topology/inventory critic keep their fresh launch and prompt.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import * as hostRun from '../core/host-run.js';
import * as managedHostRun from '../core/managed-host-run.js';
import { buildManagedReviewerPrompt, managedReviewerPromptDigest } from '../core/managed-review-evidence.js';
import { StoryStore } from '../core/store.js';
import type { Finding, ReviewRun } from '../core/types.js';

const MARKER = 'managed re-review does not resume the same-lane session with a repair-scoped prompt';
const STORY = 'B-5e5e';
const QUALITY = 'proof-or-stop-review-quality';
const BEHAVIOR = 'proof-or-stop-review-behavior';
const CRITIC = 'proof-or-stop-review-topology-critic';
const ROUND_1 = '2026-09-29T10:00:00.000Z';
const ROUND_2 = '2026-09-29T12:00:00.000Z';
const MODEL = 'gpt-5.5';

type Launch = { command: string; argv: string[] };
const materialize = hostRun.materializeHostRunLaunch as unknown as (args: Record<string, unknown>) => Launch;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function reviewerArgs(cwd: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: 'codex', model: MODEL, reasoningEffort: 'high',
    storyId: STORY, agentType: QUALITY, phase: 'REVIEW', lane: QUALITY, reviewRunId: `${STORY}:RR-004`,
    promptText: 'review', launchProfile: 'managed_reviewer',
    env: {}, cwd, root: cwd, recordedAt: new Date().toISOString(), projectRootHash: 'sha256:x',
    ...extra,
  };
}

function reviewRun(id: string, lane: string, round: string, headHash: string, extra: Partial<ReviewRun> = {}): ReviewRun {
  return {
    reviewRunId: `${STORY}:${id}`, storyId: STORY, agent: lane, lane, reviewRound: round,
    startedAt: round, headHash, materialHash: 'sha256:material', storyFilesHash: 'sha256:story',
    promptHash: 'unused', assembledPrompt: `Review lane ${lane}.`, ...extra,
  };
}

function writeHostRun(root: string, runId: string, fields: {
  lane: string; agentType?: string; reviewRunId: string; state: string; terminalAt: string; threadId: string; model?: string;
}): void {
  const dir = managedHostRun.managedHostRunDirectory(root, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({
    runId, host: 'codex', profile: 'managed_reviewer', storyId: STORY, agentType: fields.agentType ?? fields.lane,
    lane: fields.lane, reviewRunId: fields.reviewRunId, cwd: join(root, 'scratch', runId), model: fields.model ?? MODEL,
  }));
  writeFileSync(join(dir, 'terminal.json'), JSON.stringify({ runId, state: fields.state, terminalAt: fields.terminalAt }));
  writeFileSync(join(dir, 'live-output.jsonl'), [
    { sequence: 1, stream: 'stdout', text: `{"type":"thread.started","thread_id":"${fields.threadId}"}\n` },
    { sequence: 2, stream: 'stdout', text: '{"type":"turn.completed"}\n' },
  ].map(frame => JSON.stringify(frame)).join('\n') + '\n');
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), 'rereview-resume-'));
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'smoke@example.invalid');
    git(root, 'config', 'user.name', 'smoke');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'parser.ts'), 'export function parse(s: string) {\n  return s.split(",");\n}\n');
    writeFileSync(join(root, 'src', 'untouched.ts'), 'export const untouched = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'round 1 candidate');
    const head1 = git(root, 'rev-parse', 'HEAD');
    const store = new StoryStore(root);
    const storyDir = store.storyDirPath(STORY);
    mkdirSync(storyDir, { recursive: true });
    writeFileSync(join(root, 'src', 'parser.ts'), 'export function parse(s: string) {\n  return s.split(",").map(v => v.trim()); // REPAIR-LINE\n}\n');
    writeFileSync(join(storyDir, 'story-notes.md'), 'METADATA-ONLY-LINE\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'repair');
    const head2 = git(root, 'rev-parse', 'HEAD');
    const metadataPath = relative(root, join(storyDir, 'story-notes.md'));

    const q1 = reviewRun('RR-001', QUALITY, ROUND_1, head1);
    const b1 = reviewRun('RR-002', BEHAVIOR, ROUND_1, head1);
    const c1 = reviewRun('RR-003', CRITIC, ROUND_1, head1, { reviewPurpose: 'topology' });
    const q2 = reviewRun('RR-004', QUALITY, ROUND_2, head2);
    const b2 = reviewRun('RR-005', BEHAVIOR, ROUND_2, head2);
    const c2 = reviewRun('RR-006', CRITIC, ROUND_2, head2, { reviewPurpose: 'topology' });
    store.writeReviewRuns(STORY, { runs: [q1, b1, c1, q2, b2, c2] });
    const finding: Finding = {
      id: `${STORY}:F-001`, desc: 'parse keeps surrounding whitespace in every field', severity: 'high',
      category: 'edge', status: 'resolved', reviewRound: ROUND_1, agent: QUALITY, reviewRunId: q1.reviewRunId,
    };
    store.writeFindings(STORY, { findings: [finding] });

    // (1) Launch shape: a resumed reviewer continues its own Codex thread with the fresh launch's config.
    const cwd = join(root, 'scratch', 'current');
    const fresh = materialize(reviewerArgs(cwd));
    assert.deepEqual(fresh.argv.slice(0, 2), ['exec', '--json'], 'a fresh reviewer launch is unchanged');
    assert.ok(!fresh.argv.includes('--ephemeral'), 'a reviewer session is kept on disk so a later round can resume it');
    const thread = '019a0000-0000-7000-8000-00000000a001';
    const resumed = materialize(reviewerArgs(cwd, { resumeSessionId: thread }));
    assert.deepEqual(resumed.argv.slice(0, 2), ['exec', 'resume'], `${MARKER}: ${resumed.argv.join(' ')}`);
    assert.equal(resumed.argv.at(-2), thread, 'the session id precedes the stdin prompt marker');
    assert.equal(resumed.argv.at(-1), '-');
    assert.ok(resumed.argv.includes('sandbox_mode="danger-full-access"'), 'resume carries the reviewer sandbox as config');
    assert.ok(resumed.argv.includes('--model') && resumed.argv.includes(MODEL), 'resume keeps the model');
    assert.ok(resumed.argv.includes('model_reasoning_effort="high"'), 'resume keeps the reasoning effort');
    assert.ok(!resumed.argv.includes('-C') && !resumed.argv.includes('-s'), 'exec resume takes neither -C nor -s');

    // (2) Session lookup: newest completed same-lane/agent/model run from an earlier round with a kept rollout.
    const find = (managedHostRun as Record<string, unknown>).managedResumeSessionForSpec as
      | ((spec: Record<string, unknown>, codexHome: string) => string | null)
      | undefined;
    assert.equal(typeof find, 'function', `${MARKER}: no managed resume-session lookup`);
    const codexHome = join(root, 'codex-home');
    const sessions = join(codexHome, 'sessions', '2026', '09', '29');
    mkdirSync(sessions, { recursive: true });
    const ids = {
      qualityOld: '019a0000-0000-7000-8000-00000000a000',
      quality: thread,
      behavior: '019a0000-0000-7000-8000-00000000b001',
      critic: '019a0000-0000-7000-8000-00000000c001',
      sameRound: '019a0000-0000-7000-8000-00000000d001',
      otherModel: '019a0000-0000-7000-8000-00000000e001',
    };
    for (const id of Object.values(ids)) writeFileSync(join(sessions, `rollout-2026-09-29T10-00-00-${id}.jsonl`), '{}\n');
    writeHostRun(root, 'run-q1-old', { lane: QUALITY, reviewRunId: q1.reviewRunId, state: 'completed', terminalAt: '2026-09-29T10:10:00.000Z', threadId: ids.qualityOld });
    writeHostRun(root, 'run-q1', { lane: QUALITY, reviewRunId: q1.reviewRunId, state: 'completed', terminalAt: '2026-09-29T10:20:00.000Z', threadId: ids.quality });
    writeHostRun(root, 'run-q1-failed', { lane: QUALITY, reviewRunId: q1.reviewRunId, state: 'failed', terminalAt: '2026-09-29T10:30:00.000Z', threadId: ids.otherModel });
    writeHostRun(root, 'run-q1-other-model', { lane: QUALITY, reviewRunId: q1.reviewRunId, state: 'completed', terminalAt: '2026-09-29T10:40:00.000Z', threadId: ids.otherModel, model: 'other-model' });
    writeHostRun(root, 'run-b1', { lane: BEHAVIOR, reviewRunId: b1.reviewRunId, state: 'completed', terminalAt: '2026-09-29T10:50:00.000Z', threadId: ids.behavior });
    writeHostRun(root, 'run-c1', { lane: CRITIC, reviewRunId: c1.reviewRunId, state: 'completed', terminalAt: '2026-09-29T10:50:00.000Z', threadId: ids.critic });
    writeHostRun(root, 'run-q2-sibling', { lane: QUALITY, reviewRunId: q2.reviewRunId, state: 'completed', terminalAt: '2026-09-29T12:10:00.000Z', threadId: ids.sameRound });
    const spec = (run: ReviewRun, extra: Record<string, unknown> = {}) => ({
      runId: 'run-current', host: 'codex', profile: 'managed_reviewer', storyId: STORY, agentType: run.lane,
      lane: run.lane, reviewRunId: run.reviewRunId, cwd, root, model: MODEL, ...extra,
    });
    assert.equal(find!(spec(q2), codexHome), ids.quality, `${MARKER}: round 2 does not resume the lane's round-1 thread`);
    assert.equal(find!(spec(b2), codexHome), ids.behavior, 'each lane resumes only its own thread');
    assert.equal(find!(spec(q1), codexHome), null, 'round 1 starts fresh');
    assert.equal(find!(spec(c2), codexHome), null, 'the topology critic starts fresh');
    assert.equal(find!(spec(q2, { model: 'third-model' }), codexHome), null, 'a different model starts fresh');
    assert.equal(find!(spec(q2, { host: 'claude' }), codexHome), null, 'only Codex reviewer sessions resume');
    assert.equal(find!(spec(q2, { profile: 'acceptance_amendment_review' }), codexHome), null, 'acceptance review starts fresh');
    rmSync(join(sessions, `rollout-2026-09-29T10-00-00-${ids.quality}.jsonl`));
    assert.equal(find!(spec(q2), codexHome), null, 'a rollout missing from the Codex home is not resumed');

    // (3) Round-aware prompt: round 2 names the repair diff and earlier findings; round 1 is unchanged.
    const emptyRoot = mkdtempSync(join(tmpdir(), 'rereview-resume-empty-'));
    try {
      assert.equal(buildManagedReviewerPrompt(root, q1), buildManagedReviewerPrompt(emptyRoot, q1),
        'the round-1 prompt does not depend on other rounds');
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
    const round1 = buildManagedReviewerPrompt(root, q1);
    const round2 = buildManagedReviewerPrompt(root, q2);
    assert.ok(!/Re-review/.test(round1), 'the round-1 prompt has no re-review section');
    assert.match(round2, /Re-review/, `${MARKER}: the round-2 prompt has no re-review section`);
    assert.ok(round2.includes('REPAIR-LINE'), 'the round-2 prompt carries the material repair diff');
    assert.ok(round2.includes(`${head1.slice(0, 12)}`) && round2.includes(`${head2.slice(0, 12)}`), 'the diff range is named');
    assert.ok(!round2.includes('METADATA-ONLY-LINE') && !round2.includes(metadataPath), 'PoS metadata is excluded from the diff');
    assert.ok(!round2.includes('export const untouched'), 'unchanged files are not in the diff');
    assert.ok(round2.includes(finding.id) && round2.includes('high') && round2.includes('resolved')
      && round2.includes('parse keeps surrounding whitespace'), 'the round-2 prompt lists earlier findings');
    assert.match(round2, /variant analysis/i, 'the round-2 prompt asks for variant analysis');
    assert.match(round2, /confirm each listed finding/i, 'the round-2 prompt asks to confirm earlier findings');
    const behavior2 = buildManagedReviewerPrompt(root, b2);
    assert.ok(behavior2.includes('REPAIR-LINE'), 'every lane with an earlier round gets its re-review section');
    const critic2 = buildManagedReviewerPrompt(root, c2);
    assert.ok(!/Re-review/.test(critic2), 'the topology critic prompt is unchanged');
    assert.equal(buildManagedReviewerPrompt(root, q2), round2, 'the round-2 prompt is deterministic');
    assert.equal(managedReviewerPromptDigest(root, q2), managedReviewerPromptDigest(root, q2), 'the prompt digest is stable');

    // A current-round finding (raised by a sibling lane mid-round) never changes a round-2 prompt.
    store.writeFindings(STORY, { findings: [finding, {
      id: `${STORY}:F-002`, desc: 'CURRENT-ROUND-FINDING', severity: 'low', category: 'edge', status: 'open',
      reviewRound: ROUND_2, agent: BEHAVIOR, reviewRunId: b2.reviewRunId,
    }] });
    assert.equal(buildManagedReviewerPrompt(root, q2), round2, 'current-round data does not change the prompt digest');
    console.log('rereview-resume-smoke: PASS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
