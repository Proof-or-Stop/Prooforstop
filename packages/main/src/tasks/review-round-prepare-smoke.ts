#!/usr/bin/env node
/**
 * review_round_prepare: one owner command replaces the per-round managed
 * REVIEW ceremony (reviewer_batch -> candidate_spec_route -> per-lane
 * dispatch + review_run_start -> hand ReviewRun ids to the controller).
 *
 * Real CLI fixture: a git-backed REVIEW Story with no candidate-spec route.
 * One call must route first, start one signed ReviewRun per launchable lane
 * with the matching lane binding, print the benchmark controller command
 * with every lane=reviewRunId mapping, and never print a prompt body.
 */
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StoryStore } from '../core/store.js';
import { digestCandidateRoutingValue } from '../core/candidate-spec-routing.js';

const storyId = 'B-rrp1';
const round = '2026-09-30T00:00:00.000Z';
const cliPath = fileURLToPath(new URL('../../../../bin/proof-or-stop.js', import.meta.url));
const PROMPT_MARKERS = /BEGIN EXACT|Prompt omitted by --summary|## Role|You are /;

function fixture(): { root: string; store: StoryStore } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-round-prepare-')));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  mkdirSync(join(root, 'docs/requirements/decisions'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
  }));
  writeFileSync(join(root, 'packages/main/src/subject.ts'), 'export const subject = 1;\n');
  writeFileSync(join(root, 'docs/requirements/decisions/subject.md'), '# Subject\nsubject rules\n');
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init']);
  git(['checkout', '-b', 'main']);
  git(['config', 'user.name', 'Owner']);
  git(['config', 'user.email', 'owner@noreply.local']);
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: 'rrp', title: 'Review round prepare subject', description: 'Change subject',
    type: 'chore', phase: 'REVIEW', priority: 'high', createdAt: round, startedAt: round, endedAt: null,
    currentReviewRound: round, events: [{ phase: 'REVIEW', action: 'advance', timestamp: round }],
  } as never);
  store.writeChecklist(storyId, { items: [
    { id: 'CHK-001', title: 'Subject', context: 'fixture', status: 'done', files: ['packages/main/src/subject.ts'] },
  ] } as never);
  git(['add', '-A']);
  git(['commit', '-m', 'proof-or-stop: story metadata']);
  return { root, store };
}

function cli(root: string, command: string, payload: Record<string, unknown>): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PROOF_OR_STOP_AGENT: 'main',
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'claude-code',
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'review-round-prepare-owner',
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: 'main',
  };
  delete env.PROOF_OR_STOP_SESSION_ID;
  delete env.LATTICE_SESSION_ID;
  const result = spawnSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(payload)], {
    cwd: root, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function laneRuns(store: StoryStore): Array<{ reviewRunId: string; agent: string; lane: string; reviewRound: string }> {
  return store.readReviewRuns(storyId).runs.map(run => ({
    reviewRunId: run.reviewRunId, agent: run.agent, lane: run.lane, reviewRound: run.reviewRound,
  }));
}

function main(): void {
  const { root, store } = fixture();
  try {
    assert.equal(store.readCandidateSpecSet(storyId), null, 'fixture starts without a candidate-spec route');

    // 1. One JSON call: route first, then dispatch + review_run_start per lane.
    const first = cli(root, 'review_round_prepare', { storyId, json: true });
    assert.equal(first.status, 0, `REVIEW_ROUND_PREPARE_ONE_CALL_FAILED: ${first.stderr}${first.stdout}`);
    const report = JSON.parse(first.stdout) as {
      storyId: string; round: string; head: string; worktree: string; routed: boolean;
      launchableLanes: string[]; reviewRuns: Record<string, string>; controllerCommand: string | null;
    };
    assert.equal(report.storyId, storyId);
    assert.equal(report.round, round);
    assert.match(report.head, /^[0-9a-f]{40}$/, 'head is the full commit hash');
    assert.equal(report.routed, true, 'a missing candidate route is produced before launch');
    assert.ok(store.readCandidateSpecSet(storyId), 'candidate-spec-set.json persisted by the routing step');
    assert.ok(report.launchableLanes.length >= 1, 'fixture has launchable lanes');
    assert.deepEqual(Object.keys(report.reviewRuns).sort(), [...report.launchableLanes].sort(), 'one ReviewRun per launchable lane');
    const runs = laneRuns(store);
    assert.equal(runs.length, report.launchableLanes.length, 'exactly one signed ReviewRun per lane was persisted');
    for (const lane of report.launchableLanes) {
      const id = report.reviewRuns[lane]!;
      const run = runs.find(row => row.reviewRunId === id);
      assert.ok(run, `ReviewRun ${id} persisted`);
      assert.equal(run!.lane, lane, `${id} is bound to lane ${lane}`);
      assert.equal(run!.agent, lane, `${id} is bound to agent ${lane}`);
      assert.equal(run!.reviewRound, round);
      assert.ok(report.controllerCommand!.includes(` --review-run=${lane}=${id}`), `controller command maps ${lane}=${id}`);
    }
    assert.equal(new Set(Object.values(report.reviewRuns)).size, report.launchableLanes.length, 'ReviewRun ids are distinct');
    assert.ok(report.controllerCommand!.startsWith(`python3 /tmp/pos-review-batch-controller.py --story-id=${storyId} --worktree=${report.worktree}`),
      report.controllerCommand ?? 'missing controller command');
    assert.equal(realpathSync(report.worktree), root, 'worktree resolved from the Story workspace');
    const dispatches = store.readProcessEvents(storyId).filter(row => row.type === 'dispatch');
    for (const lane of report.launchableLanes) {
      assert.ok(dispatches.some(row => row.agentType === lane), `owner dispatch recorded for ${lane}`);
    }
    assert.doesNotMatch(first.stdout, PROMPT_MARKERS, 'JSON output carries no prompt body');
    assert.ok(first.stdout.length < 4000, `compact output (${first.stdout.length} bytes)`);

    // 2. A route requiring escalation stops before any launch and names the exact command.
    const candidate = store.readCandidateSpecSet(storyId)!;
    const { artifactDigest: _drop, ...base } = candidate as unknown as Record<string, unknown>;
    const escalated = { ...base, fullScan: true, scanEscalationReason: null };
    store.writeCandidateSpecSet(storyId, { ...escalated, artifactDigest: digestCandidateRoutingValue(escalated) } as never);
    const refused = cli(root, 'review_round_prepare', { storyId });
    assert.notEqual(refused.status, 0, 'escalation without fullScanReason refuses');
    assert.match(refused.stderr + refused.stdout, /fullScanReason/, 'refusal names the missing fullScanReason');
    assert.match(refused.stderr + refused.stdout, /proof-or-stop review_round_prepare --storyId=B-rrp1 --fullScanReason=/, 'refusal prints the exact owner command');
    assert.equal(laneRuns(store).length, runs.length, 'no ReviewRun started when routing requires escalation');

    // 3. Text mode with the reason: routes with escalation, starts fresh runs, prints the controller line.
    const text = cli(root, 'review_round_prepare', { storyId, fullScanReason: 'fixture requires a justified broad decisions scan' });
    assert.equal(text.status, 0, `${text.stderr}${text.stdout}`);
    assert.equal(store.readCandidateSpecSet(storyId)?.scanEscalationReason?.length ? true : false, true, 'escalated route recorded its reason');
    const after = laneRuns(store);
    assert.equal(after.length, runs.length * 2, 'second round started one fresh ReviewRun per lane');
    for (const run of after.slice(runs.length)) {
      assert.ok(text.stdout.includes(`--review-run=${run.lane}=${run.reviewRunId}`), `text controller line maps ${run.lane}`);
    }
    assert.match(text.stdout, /python3 \/tmp\/pos-review-batch-controller\.py --story-id=B-rrp1 --worktree=/);
    assert.doesNotMatch(text.stdout, PROMPT_MARKERS, 'text output carries no prompt body');
    console.log(text.stdout.split('\n').slice(0, 12).join('\n'));
    console.log('review-round-prepare smoke: PASS');
  } finally {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
}

main();
