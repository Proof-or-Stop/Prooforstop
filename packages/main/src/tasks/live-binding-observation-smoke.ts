#!/usr/bin/env node
/**
 * Lab live-binding-observed: one reviewer-evidence collection
 * (collectReviewerEvidenceState, core/review-run.ts) verifies every managed
 * lane inside one synchronous git observation. Each lane calls
 * verifyManagedReviewLiveBinding, which walks every commit between the
 * reviewed HEAD and the live HEAD (ancestry, rev-list, subject, parents,
 * changed paths, committed snapshots). Those walks bypassed observedGit, so a
 * 4-lane collection ran the identical walk 4 times; in the e2e harness
 * story_advance TEST spent ~7.7 s of 16.8 s on such repeats.
 *
 * Budget: inside one observation, lanes 2..N re-run no git command; outside
 * an observation every call still probes git, and a commit that is not a
 * permitted maintenance advance still invalidates the binding in the next
 * observation.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { verifyManagedReviewLiveBinding } from '../core/managed-review-evidence.js';
import { withGitTreeObservation } from '../core/git-tree-observation.js';

const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const git = (cwd: string, args: string[]) => execFileSync(realGit, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const storyId = 'B-live';
const LANES = 4;

const root = mkdtempSync(join(tmpdir(), 'live-binding-observation-'));
const shimDir = `${root}-shim`;
const log = join(shimDir, 'git.log');
try {
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'lab@example.test']);
  git(root, ['config', 'user.name', 'lab']);
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ storyDir: '.proof-or-stop/story/actives', storyPrefix: 'B' }));
  writeFileSync(join(root, 'main.go'), 'package main\n');
  const storyDir = join(root, '.proof-or-stop', 'story', 'actives', storyId);
  mkdirSync(storyDir, { recursive: true });
  writeFileSync(join(storyDir, 'story.json'), '{}\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'reviewed candidate']);
  const expected = { headHash: currentGitHead(root)!, materialHash: currentMaterialHash(root, 'HEAD', root)!, storyFilesHash: currentStoryFilesHash(root, 'HEAD', root)! };
  const metadataCommit = (command: string) => {
    writeFileSync(join(storyDir, 'certification-window.json'), `{"command":"${command}"}\n`);
    writeFileSync(join(storyDir, 'process-events.jsonl'), `{"event":"${command}"}\n`);
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', `proof-or-stop: record ${storyId} ${command} metadata`]);
  };
  for (const command of ['certification_window_begin', 'validate', 'TEST', 'live_smoke_transcript']) metadataCommit(command);
  writeFileSync(join(storyDir, 'review-passes.json'), '{"passes":[]}\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', `proof-or-stop: record ${storyId} managed_review_evidence_import metadata`]);

  // Count every git process the verifier starts.
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(shimDir, 'git'), 0o755);
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`;
  const spawned = () => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  const verify = () => verifyManagedReviewLiveBinding({ gitCwd: root, metadataRoot: root, storyId, expected });

  // One collection: LANES lanes in one observation.
  const perLane: number[] = [];
  withGitTreeObservation(() => {
    for (let lane = 0; lane < LANES; lane++) {
      const before = spawned();
      const result = verify();
      assert.equal(result.valid, true, `lane ${lane} live binding: ${result.reason}`);
      perLane.push(spawned() - before);
    }
  });
  console.log(`git processes per lane inside one observation: ${perLane.join(', ')}`);
  assert.ok(perLane[0] > 0, 'the first lane probes git');
  const repeated = perLane.slice(1).reduce((a, b) => a + b, 0);
  assert.equal(repeated, 0, `lanes 2..${LANES} re-ran ${repeated} identical git commands inside one observation (budget 0)`);

  // Outside an observation the live state is probed afresh (object-id-addressed
  // lineage bytes may still come from git-object-read-memo; see lineage-object-memo-smoke).
  const outsideBefore = spawned();
  assert.equal(verify().valid, true);
  const outsideRows = readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(outsideBefore);
  assert.ok(outsideRows.some(row => row.startsWith('rev-parse')), `a call outside an observation resolves the live HEAD afresh: ${outsideRows.join(' | ')}`);

  // Freshness: a commit that is not a permitted advance is seen by the next observation.
  metadataCommit('checklist_update');
  const stale = withGitTreeObservation(() => [verify(), verify()]);
  assert.deepEqual(stale.map(r => r.valid), [false, false], 'a non-permitted HEAD advance invalidates every lane in the next observation');
  console.log('live-binding-observation-smoke: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
}
