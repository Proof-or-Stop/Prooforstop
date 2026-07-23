#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptanceRolloutSourceRecordDigest } from '../packages/main/dist/core/acceptance-rollout.js';
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
        result: record.blocked === record.shouldBlock ? 'pass' : 'fail',
        command: 'registered temp Story cohort case',
      }],
    }],
  });
  writeJson(join(storyDir, 'review-assurance.json'), {
    class: record.quorum.class,
    rounds: record.quorum.rounds,
    hosts: record.quorum.hosts,
    providers: record.quorum.providers,
  });
  writeJson(join(storyDir, 'rollout-observation.json'), record);
  return readJson(join(storyDir, 'rollout-observation.json'));
}

function pairRecords({ pairId, index, claimClass, defectClass, seededDefectId, shouldBlock, defectPresent }) {
  const completedAt = new Date(Date.parse('2026-07-23T12:00:00.000Z') + index * 60_000).toISOString();
  const base = {
    pairId,
    completedAt,
    comparableGroup: 'high_assurance',
    eligible: true,
    adapterProfile: 'codex-cli+claude-cli',
    claimClass,
    transcriptPresent: claimClass === 'user_visible' || claimClass === 'orchestration',
    mutationRequired: ['behavior', 'lifecycle', 'proof', 'safety'].includes(claimClass),
    mutationBites: true,
    ...(seededDefectId ? { seededDefectId } : {}),
    defectClass,
    defectPresent,
    shouldBlock,
    checkInventory: ['acceptance_topology_check', 'pre_review_check', 'acceptance_rollout_check'],
    quorum: {
      class: 'full-3x2',
      rounds: 3,
      hosts: ['codex-cli', 'claude-cli'],
      providers: ['codex', 'claude'],
    },
  };
  return [
    makeSourceRecord({
      ...base,
      arm: 'baseline',
      storyId: `COHORT-B-${String(index + 1).padStart(2, '0')}`,
      detected: defectPresent ? false : true,
      blocked: false,
      reviewRounds: 5,
      waiverCount: 1,
      costUnits: 100,
    }),
    makeSourceRecord({
      ...base,
      arm: 'candidate',
      storyId: `COHORT-C-${String(index + 1).padStart(2, '0')}`,
      detected: defectPresent,
      blocked: shouldBlock,
      reviewRounds: 2,
      waiverCount: 0,
      costUnits: 60,
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
