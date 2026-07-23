#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptanceRolloutSourceRecordDigest,
  issueAcceptanceRolloutObservationFromProduction,
} from '../packages/main/dist/core/acceptance-rollout.js';
import { canonicalJson } from '../packages/main/dist/core/digest.js';

const RUNNER_RELATIVE_PATH = 'scripts/run-proofstory-acceptance-rollout-cohort.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function makeSourceRecord(input) {
  const unsigned = {
    schemaVersion: 'proofstory.acceptance_rollout_source_record.v1',
    ...input,
  };
  return { ...unsigned, sourceDigest: acceptanceRolloutSourceRecordDigest(unsigned) };
}

function materializeStory(root, record) {
  const storyDir = join(root, '.lattice', 'story', 'actives', record.storyId);
  writeJson(join(storyDir, 'story.json'), {
    id: record.storyId,
    title: `Wave 4 cohort ${record.pairId} ${record.arm}`,
    phase: 'DONE',
    type: 'test',
    priority: 'high',
    createdAt: record.completedAt,
    updatedAt: record.completedAt,
  });
  writeJson(join(storyDir, 'checklist.json'), {
    items: [{
      id: 'CHK-001',
      title: 'Exercise registered acceptance rollout case',
      status: 'done',
      verificationIntent: {
        happy: [{ id: 'cohort:happy', desc: record.claimClass, type: 'logic', requiredIn: 'strict', priority: 'must' }],
        edge: [],
        adversarial: record.defectPresent
          ? [{ id: `cohort:seed:${record.seededDefectId ?? 'control'}`, desc: record.defectClass, type: 'logic', requiredIn: 'strict', priority: 'must' }]
          : [],
      },
      verificationEvidence: [{
        kind: 'logic_test',
        intentRef: 'cohort:happy',
        result: 'pass',
        command: 'registered verifier-owned rollout observation receipt',
      }],
    }],
  });
  writeJson(join(storyDir, 'acceptance-topology-check.json'), record.observationReceipt.gateArtifacts[0]);
  writeJson(join(storyDir, 'pre-review-check.json'), record.observationReceipt.gateArtifacts[1]);
  writeJson(join(storyDir, 'review-assurance.json'), record.observationReceipt.hostVerdicts);
  writeJson(join(storyDir, 'rollout-observation.json'), record);
  return readJson(join(storyDir, 'rollout-observation.json'));
}

function runProductionCase({ storyId, pairId, arm, scenario, completedAt }) {
  const output = execFileSync(process.execPath, [
    join(projectRoot, 'packages/main/dist/tasks/proofstory-pre-review-check-smoke.js'),
    '--rollout-cohort-case',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      LATTICE_ROLLOUT_COHORT_STORY_ID: storyId,
      LATTICE_ROLLOUT_COHORT_ARM: arm,
      LATTICE_ROLLOUT_COHORT_SCENARIO: scenario,
    },
    maxBuffer: 32 * 1024 * 1024,
  });
  const line = output.split(/\r?\n/).find(row => row.startsWith('PROOFSTORY_ROLLOUT_CASE='));
  if (!line) throw new Error(`registered production cohort case did not emit evidence for ${storyId}`);
  const evidence = JSON.parse(line.slice('PROOFSTORY_ROLLOUT_CASE='.length));
  try {
    return issueAcceptanceRolloutObservationFromProduction({
      gitCwd: projectRoot,
      evidenceGitCwd: evidence.evidenceGitCwd,
      storyId,
      pairId,
      arm,
      scenario,
      issuedAt: completedAt,
      evidence,
    });
  } finally {
    if (typeof evidence.evidenceGitCwd === 'string') {
      rmSync(evidence.evidenceGitCwd, { recursive: true, force: true });
    }
  }
}

function pairRecords({ pairId, index, claimClass, defectClass, seededDefectId, shouldBlock, defectPresent }) {
  const completedAt = new Date(Date.parse('2026-07-23T12:00:00.000Z') + index * 60_000).toISOString();
  const base = {
    pairId,
    completedAt,
    comparableGroup: 'high_assurance',
    eligible: true,
    claimClass,
    ...(seededDefectId ? { seededDefectId } : {}),
    defectClass,
    defectPresent,
    shouldBlock,
  };
  const scenario = defectClass === 'omission' || defectClass === 'forgery' || defectClass === 'freshness'
    ? defectClass
    : 'control';
  const baselineStoryId = `B-cb${String(index + 1).padStart(2, '0')}`;
  const candidateStoryId = `B-cc${String(index + 1).padStart(2, '0')}`;
  return [
    makeSourceRecord({
      ...base,
      arm: 'baseline',
      storyId: baselineStoryId,
      observationReceipt: runProductionCase({
        storyId: baselineStoryId, pairId, arm: 'baseline', scenario, completedAt,
      }),
    }),
    makeSourceRecord({
      ...base,
      arm: 'candidate',
      storyId: candidateStoryId,
      observationReceipt: runProductionCase({
        storyId: candidateStoryId, pairId, arm: 'candidate', scenario, completedAt,
      }),
    }),
  ];
}

/**
 * Reproducible verifier-owned cohort producer. Each row is read back from a
 * real temporary Story artifact tree before it enters the frozen inventory.
 */
export function runProofStoryAcceptanceRolloutCohort() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'proofstory-rollout-cohort-'));
  try {
    const registeredSeedIds = ['seed-c2-omission', 'seed-forged-receipt', 'seed-stale-binding'];
    const rows = [
      ...pairRecords({ pairId: 'PAIR-OMISSION', index: 0, claimClass: 'user_visible', defectClass: 'omission', seededDefectId: registeredSeedIds[0], shouldBlock: true, defectPresent: true }),
      ...pairRecords({ pairId: 'PAIR-FORGERY', index: 1, claimClass: 'safety', defectClass: 'forgery', seededDefectId: registeredSeedIds[1], shouldBlock: true, defectPresent: true }),
      ...pairRecords({ pairId: 'PAIR-FRESHNESS', index: 2, claimClass: 'lifecycle', defectClass: 'freshness', seededDefectId: registeredSeedIds[2], shouldBlock: true, defectPresent: true }),
      ...pairRecords({ pairId: 'PAIR-DOCS', index: 3, claimClass: 'docs_only', defectClass: 'control', shouldBlock: false, defectPresent: false }),
      ...pairRecords({ pairId: 'PAIR-LEGACY', index: 4, claimClass: 'legacy', defectClass: 'control', shouldBlock: false, defectPresent: false }),
      ...pairRecords({ pairId: 'PAIR-ORDINARY', index: 5, claimClass: 'ordinary', defectClass: 'control', shouldBlock: false, defectPresent: false }),
    ];
    const sourceRecords = rows
      .map(record => materializeStory(tempRoot, record))
      .sort((a, b) => a.pairId.localeCompare(b.pairId) || a.arm.localeCompare(b.arm) || a.storyId.localeCompare(b.storyId));
    const times = sourceRecords.map(record => Date.parse(record.completedAt));
    const evaluationWindow = {
      start: new Date(Math.min(...times) - 60_000).toISOString(),
      end: new Date(Math.max(...times) + 60_000).toISOString(),
    };
    const runnerPath = join(projectRoot, RUNNER_RELATIVE_PATH);
    return {
      schemaVersion: 'proofstory.acceptance_rollout_cohort_input.v1',
      generatedBy: 'runProofStoryAcceptanceRolloutCohort',
      evaluationWindow,
      eligibilityRuleVersion: 'proofstory.acceptance_rollout_eligibility.v1',
      thresholdVersion: 'proofstory.acceptance_rollout_thresholds.v1',
      registeredSeedIds,
      sourceRecords,
      sourceInventoryDigest: sha256(canonicalJson(sourceRecords)),
      runnerPath: RUNNER_RELATIVE_PATH,
      runnerDigest: sha256(readFileSync(runnerPath)),
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.stdout.write(`${JSON.stringify(runProofStoryAcceptanceRolloutCohort(), null, 2)}\n`);
}
