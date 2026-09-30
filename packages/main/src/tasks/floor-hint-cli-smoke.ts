#!/usr/bin/env node
/**
 * Review assurance floor hints must be runnable from a task repository.
 *
 * A benchmark task repo (e.g. a Go project) has no bin/proof-or-stop.js; the
 * owner has only the installed `proof-or-stop` command on PATH. The floor's
 * reviewer-host recipe and its "Stale material recovery" step 3 used to render
 * `node bin/proof-or-stop.js autopilot_review_submit ...`, which fails there
 * with MODULE_NOT_FOUND. This smoke builds such a repo (no bin/), puts a
 * `proof-or-stop` shim for this checkout's dist CLI on PATH, and executes the
 * literal hinted command: it must persist a host verdict bound to the current
 * material and clear the floor. The hint must also carry the exact current
 * digests and name the next unused runId.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROOF_OR_STOP_STATE_DIR } from '../core/brand-paths.js';
import { resetConfigCache } from '../core/config.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import {
  buildReviewAssuranceFloorGuidance,
  evaluateReviewAssuranceFloor,
  formatReviewAssuranceFloorFailure,
  type ReviewAssuranceFloorReport,
} from '../core/review-assurance-floor.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import { listVerdicts } from '../core/verdicts.js';

const STORY_ID = 'B-floor-hint';
const DIST_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
const MARKER = 'FLOOR_HINT_NOT_RUNNABLE';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function story(): StoryInfo {
  return {
    storyId: STORY_ID, name: STORY_ID, title: 'Floor hint smoke', description: 'Task-repo floor hint must be runnable',
    type: 'feature', phase: 'TEST', priority: 'medium', createdAt: '2026-09-30T09:00:00.000Z', startedAt: null, endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: '2026-09-30T09:30:00.000Z' }],
  };
}

/** Go task repo shaped like the benchmark: no bin/, no packages/. */
function makeTaskRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'floor-hint-cli-'));
  write(root, 'go.mod', 'module example.com/strs\n\ngo 1.22\n');
  write(root, 'strs/strs.go', 'package strs\n');
  write(root, '.gitignore', `${PROOF_OR_STOP_STATE_DIR}/autopilot-verdicts/\n`);
  write(root, 'proof-or-stop.config.json', `${JSON.stringify({ storyDir: '.proof-or-stop/story/actives' }, null, 2)}\n`);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'smoke@example.invalid']);
  git(root, ['config', 'user.name', 'Floor Hint Smoke']);
  git(root, ['checkout', '-qB', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'seed']);
  git(root, ['checkout', '-qB', `story/${STORY_ID}`]);
  write(root, 'strs/strs.go', 'package strs\n\nfunc Upper(s string) string { return s }\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'material change']);
  return root;
}

function evaluate(root: string): ReviewAssuranceFloorReport {
  resetConfigCache();
  const store = new StoryStore(root);
  return evaluateReviewAssuranceFloor({
    projectRoot: root, story: story(), storyId: STORY_ID, changedFiles: ['strs/strs.go'],
    processEvents: store.readProcessEvents(STORY_ID),
    materialHash: currentMaterialHash(root)!, storyFilesHash: currentStoryFilesHash(root)!,
  });
}

function submitCommands(text: string): string[] {
  return text.split('\n').map(line => line.split(' # ')[0]!)
    .map(line => line.match(/((?:node \S+ |\S*proof-or-stop )autopilot_review_submit .*)$/)?.[1]?.trim() ?? '')
    .filter(Boolean);
}

function main(): void {
  const root = makeTaskRepo();
  const shimDir = mkdtempSync(join(tmpdir(), 'floor-hint-cli-bin-'));
  try {
    const shim = join(shimDir, 'proof-or-stop');
    writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(DIST_CLI)} "$@"\n`);
    chmodSync(shim, 0o755);
    const store = new StoryStore(root);
    store.writeStory(STORY_ID, story());
    store.writeChecklist(STORY_ID, { items: [] });
    const material = currentMaterialHash(root)!;
    const storyFiles = currentStoryFilesHash(root)!;
    const coverage = { total: 0, required: 0, covered: 0, missingRequired: 0, entries: [] };
    store.writeTestEvidence(STORY_ID, {
      command: `proof-or-stop validate --story=${STORY_ID} --json`,
      output: JSON.stringify({ allPass: true, verificationCoverage: coverage }), result: 'PASS',
      timestamp: '2026-09-30T10:00:00.000Z', headHash: currentGitHead(root)!, materialHash: material,
      storyFilesHash: storyFiles, verificationCoverage: coverage,
    });

    const blocked = evaluate(root);
    assert.equal(blocked.required, true, 'material Go change requires the floor');
    assert.equal(blocked.ok, false, 'no host verdict yet: floor blocks');
    const formatted = formatReviewAssuranceFloorFailure(blocked);
    const recipes = buildReviewAssuranceFloorGuidance(blocked).legalWriterPaths.reviewerHost
      .map(recipe => recipe.command).filter(command => command.includes(' autopilot_review_submit '));
    const hinted = [...new Set([...submitCommands(formatted), ...recipes])];
    assert.ok(hinted.length >= 1, 'the floor names an autopilot_review_submit writer');
    assert.equal(existsSync(join(root, 'bin/proof-or-stop.js')), false, 'task repo has no bin/proof-or-stop.js');
    for (const command of hinted) {
      assert.ok(command.startsWith('proof-or-stop autopilot_review_submit '),
        `${MARKER}: hint does not use the installed proof-or-stop command: ${command}`);
      assert.ok(command.includes(`--materialDigest=${material}`), `${MARKER}: hint lacks the current materialDigest: ${command}`);
      assert.ok(command.includes(`--storyFilesHash=${storyFiles}`), `${MARKER}: hint lacks the current storyFilesHash: ${command}`);
      assert.ok(command.includes(`--runId=${STORY_ID}-degraded-r1 `), `${MARKER}: first hint must name round r1: ${command}`);
      for (const flag of ['--provider=local', '--decision=pass', '--deriveBindings', `--storyId=${STORY_ID}`]) {
        assert.ok(command.includes(flag), `${MARKER}: hint lacks ${flag}: ${command}`);
      }
    }

    // Execute the literal hint exactly as an owner would paste it.
    const run = spawnSync('/bin/sh', ['-c', hinted[0]!], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? '/usr/bin:/bin'}`, PROOF_OR_STOP_SESSION_ID: 'floor-hint-smoke', PROOF_OR_STOP_NO_HOOKS: '1' },
    });
    assert.equal(run.status, 0, `${MARKER}: literal hint failed in a task repo (exit ${run.status}):\n${`${run.stdout}${run.stderr}`.slice(-1500)}`);
    const verdicts = listVerdicts(root, 'local', STORY_ID);
    assert.equal(verdicts.length, 1, 'the literal hint persisted one host verdict');
    assert.equal(verdicts[0]!.materialDigest, material);
    assert.equal(verdicts[0]!.storyFilesHash, storyFiles);
    assert.equal(evaluate(root).ok, true, 'the host verdict from the literal hint clears the one-round floor');
    console.log('floor-hint-cli-smoke: PASS (hint uses installed proof-or-stop with current digests; literal hint ran in a task repo)');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
    resetConfigCache();
  }
}

main();
