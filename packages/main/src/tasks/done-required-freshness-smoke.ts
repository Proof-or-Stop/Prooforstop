#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DONE_REQUIRED_EVIDENCE_SCHEMA,
  DONE_REQUIRED_EVIDENCE_VERSION,
  buildDoneRequiredCommandSpecEnvelope,
  evaluateDoneRequiredEvidence,
  resolveDoneRequiredPolicy,
} from '../core/done-required-validation.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { DoneRequiredCommandReceipt, DoneRequiredEvidenceData, StoryInfo } from '../core/types.js';

const STORY_ID = 'B-fresh';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'done-required-freshness-smoke',
      GIT_AUTHOR_EMAIL: 'done-required-freshness-smoke@example.com',
      GIT_COMMITTER_NAME: 'done-required-freshness-smoke',
      GIT_COMMITTER_EMAIL: 'done-required-freshness-smoke@example.com',
    },
  });
}

function writeConfig(root: string): void {
  writeFileSync(
    join(root, 'lattice.config.json'),
    JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      doneRequiredCommands: [
        { label: 'required pass', command: 'node', args: ['-e', 'process.exit(0)'] },
      ],
    }, null, 2),
    'utf-8',
  );
  resetConfigCache();
}

function fixture(): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-required-freshness-'));
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# done required freshness fixture\n', 'utf-8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'lattice.config.json']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  const now = '2026-06-20T00:00:00.000Z';
  const story: StoryInfo = {
    storyId: STORY_ID,
    name: 'done-required-freshness-smoke',
    title: 'DONE required freshness smoke',
    description: 'Synthetic story for DONE-required freshness smoke coverage.',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
  };
  store.writeStory(STORY_ID, story);
  store.writeChecklist(STORY_ID, {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic item',
      context: 'Synthetic context',
      status: 'done',
      startTime: now,
      endTime: now,
    }],
  });
  return { root, store };
}

function hashes(root: string): { headHash: string; materialHash: string; storyFilesHash?: string } {
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root, 'HEAD', root);
  const storyFilesHash = currentStoryFilesHash(root, 'HEAD', root);
  assert.ok(headHash, 'fixture must have a git HEAD');
  assert.ok(materialHash, 'fixture must have a materialHash');
  return {
    headHash,
    materialHash,
    ...(storyFilesHash ? { storyFilesHash } : {}),
  };
}

function writeDoneEvidence(root: string, store: StoryStore): DoneRequiredEvidenceData {
  const policy = resolveDoneRequiredPolicy(root);
  const [requiredCommand] = policy.commands;
  assert.ok(requiredCommand, 'freshness smoke requires one DONE-required command');
  const h = hashes(root);
  const now = new Date().toISOString();
  const executedCommand = {
    command: 'node',
    args: ['-e', 'process.exit(0)'],
    cwd: root,
  };
  const receipt: DoneRequiredCommandReceipt = {
    label: requiredCommand.label,
    command: executedCommand.command,
    args: executedCommand.args,
    commandSpec: buildDoneRequiredCommandSpecEnvelope(root, requiredCommand, executedCommand),
    cwd: executedCommand.cwd,
    status: 'PASS',
    exitCode: 0,
    durationMs: 1,
    outputDigest: 'synthetic',
    outputTail: '',
    startedAt: now,
    endedAt: now,
    headHash: h.headHash,
    materialHash: h.materialHash,
    ...(h.storyFilesHash ? { storyFilesHash: h.storyFilesHash } : {}),
  };
  const evidence: DoneRequiredEvidenceData = {
    schema: DONE_REQUIRED_EVIDENCE_SCHEMA,
    version: DONE_REQUIRED_EVIDENCE_VERSION,
    storyId: STORY_ID,
    status: 'PASS',
    startedAt: now,
    endedAt: now,
    durationMs: 1,
    headHash: h.headHash,
    materialHash: h.materialHash,
    ...(h.storyFilesHash ? { storyFilesHash: h.storyFilesHash } : {}),
    policyHash: policy.policyHash,
    commandSetHash: policy.commandSetHash,
    receipts: [receipt],
    reasons: [],
  };
  store.writeDoneRequiredEvidence(STORY_ID, evidence);
  return evidence;
}

function commitDoneMetadata(root: string): void {
  git(root, ['add', '.lattice/story']);
  git(root, ['commit', '-m', 'commit done-required metadata']);
}

{
  const { root, store } = fixture();
  try {
    const evidence = writeDoneEvidence(root, store);
    commitDoneMetadata(root);

    const currentHead = currentGitHead(root);
    const currentMaterial = currentMaterialHash(root, 'HEAD', root);
    assert.ok(currentHead, 'metadata commit must produce a git HEAD');
    assert.notEqual(currentHead, evidence.headHash, 'metadata-only evidence commit must move HEAD');
    assert.equal(currentMaterial, evidence.materialHash, 'story metadata commit must not change materialHash');

    const evaluation = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.equal(evaluation.ok, true, evaluation.reasons.join(', '));
    assert.equal(evaluation.reasons.includes('missing-headHash'), false, evaluation.reasons.join(', '));
    assert.equal(evaluation.reasons.includes('stale-headHash'), false, evaluation.reasons.join(', '));
    assert.equal(evaluation.reasons.includes('stale-material'), false, evaluation.reasons.join(', '));
    assert.equal(store.readDoneRequiredEvidence(STORY_ID)?.headHash, evidence.headHash, 'headHash remains recorded for audit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const { root, store } = fixture();
  try {
    const evidence = writeDoneEvidence(root, store);
    commitDoneMetadata(root);
    writeFileSync(join(root, 'README.md'), '# changed material\n', 'utf-8');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-m', 'material drift']);

    const currentMaterial = currentMaterialHash(root, 'HEAD', root);
    assert.notEqual(currentMaterial, evidence.materialHash, 'material change must change materialHash');

    const evaluation = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.equal(evaluation.blocking, true, evaluation.reasons.join(', '));
    assert.ok(evaluation.reasons.includes('stale-material'), `expected stale-material, got ${evaluation.reasons.join(', ')}`);
    assert.equal(evaluation.reasons.includes('stale-headHash'), false, evaluation.reasons.join(', '));
    assert.equal(store.readDoneRequiredEvidence(STORY_ID)?.headHash, evidence.headHash, 'headHash remains recorded for audit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('done-required-freshness smoke passed');
