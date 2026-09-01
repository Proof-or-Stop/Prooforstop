#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
const execFileAsync = promisify(execFile);
const MAX_COHORT_JOBS = 12;
export function parseCohortJobs(value = '3') {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`PROOF_OR_STOP_ROLLOUT_COHORT_JOBS must be a finite positive integer <= ${MAX_COHORT_JOBS}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_COHORT_JOBS) throw new Error(`PROOF_OR_STOP_ROLLOUT_COHORT_JOBS must be a finite positive integer <= ${MAX_COHORT_JOBS}`);
  return parsed;
}
const productionCaseLimit = parseCohortJobs(process.env.PROOF_OR_STOP_ROLLOUT_COHORT_JOBS ?? '3');
let productionCasesActive = 0;
const productionCaseWaiters = [];

async function withProductionCaseSlot(work) {
  if (productionCasesActive >= productionCaseLimit) {
    await new Promise(resolveSlot => productionCaseWaiters.push(resolveSlot));
  }
  productionCasesActive += 1;
  try { return await work(); }
  finally {
    productionCasesActive -= 1;
    productionCaseWaiters.shift()?.();
  }
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function semanticCohortRecords(sourceRecords) {
  return sourceRecords.map(record => ({
    pairId: record.pairId,
    arm: record.arm,
    storyId: record.storyId,
    claimClass: record.claimClass,
    defectClass: record.defectClass,
    defectPresent: record.defectPresent,
    shouldBlock: record.shouldBlock,
    scenario: record.observationReceipt.scenario,
    topologyStatus: record.observationReceipt.gateArtifacts?.[0]?.status,
    topologyDiagnostics: record.observationReceipt.gateArtifacts?.[0]?.report?.diagnostics ?? [],
    preReviewStatus: record.observationReceipt.gateArtifacts?.[1]?.status,
    preReviewCodes: record.observationReceipt.gateArtifacts?.[1]?.report?.codes ?? [],
    checkInventory: record.observationReceipt.checkInventory ?? null,
    mutationInventory: record.observationReceipt.mutationInventory ?? null,
    mutationResults: (record.observationReceipt.mutationResults ?? []).map(result => ({
      mutationId: result.mutationId,
      expectedCode: result.expectedCode,
      observedCode: result.observedCode,
      controlRestored: result.controlRestored,
    })),
    controlRestored: record.observationReceipt.controlRestored ?? Boolean(record.observationReceipt.restorationCommitSha),
    reviewerFacts: {
      hostVerdicts: (record.observationReceipt.hostVerdicts ?? []).map(verdict => ({
        hostId: verdict.hostId, provider: verdict.provider, runId: verdict.runId, decision: verdict.decision,
      })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      quorum: record.observationReceipt.quorumReceipt ? {
        rounds: record.observationReceipt.quorumReceipt.rounds,
        emittedCount: record.observationReceipt.quorumReceipt.emittedCount,
        runIds: record.observationReceipt.quorumReceipt.runIds ?? [],
        reviewerPasses: (record.observationReceipt.quorumReceipt.reviewerPasses ?? []).map(pass => ({ lane: pass.lane, passId: pass.passId, reviewRunId: pass.reviewRunId })),
      } : null,
      reviewRoundIds: record.observationReceipt.reviewRoundIds ?? [],
      reviewRoundCount: (record.observationReceipt.reviewRoundIds ?? []).length,
      transcriptRefs: record.observationReceipt.transcriptRefs ?? [],
      waiverRefs: record.observationReceipt.waiverRefs ?? [],
      topologyAuthority: record.observationReceipt.gateArtifacts?.[0]?.report?.authority ?? null,
      preReviewAuthority: record.observationReceipt.gateArtifacts?.[1]?.report?.authority ?? null,
      preReviewTranscript: record.observationReceipt.gateArtifacts?.[1]?.report?.transcript ?? null,
    },
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function semanticCohortDigest(sourceRecords) {
  return sha256(canonicalJson(semanticCohortRecords(sourceRecords)));
}

export function assertSemanticDigestBitesReviewerFacts(cohort) {
  const original = semanticCohortDigest(cohort.sourceRecords);
  const trials = [
    ['host-3x1', copy => { copy.sourceRecords[0].observationReceipt.hostVerdicts = copy.sourceRecords[0].observationReceipt.hostVerdicts.filter(v => v.provider !== 'codex'); }],
    ['quorum', copy => { copy.sourceRecords[0].observationReceipt.quorumReceipt.rounds = 2; }],
    ['reviewer-round', copy => { copy.sourceRecords[0].observationReceipt.quorumReceipt.reviewerPasses[0].reviewRunId = 'forged'; }],
    ['transcript', copy => { copy.sourceRecords[0].observationReceipt.transcriptRefs = []; }],
    ['waiver', copy => { copy.sourceRecords[0].observationReceipt.waiverRefs = ['forged-waiver']; }],
    ['authority', copy => { copy.sourceRecords[0].observationReceipt.gateArtifacts[1].report.authority = 'diagnostic_only'; }],
  ];
  for (const [label, mutate] of trials) {
    const copy = structuredClone(cohort); mutate(copy);
    if (semanticCohortDigest(copy.sourceRecords) === original) throw new Error(`semantic digest failed to bite ${label}`);
  }
  return trials.map(([label]) => label);
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
  const storyDir = join(root, '.proof-or-stop', 'story', 'actives', record.storyId);
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

async function runProductionCase({ storyId, pairId, arm, scenario, completedAt }) {
  const { stdout: output } = await withProductionCaseSlot(() => execFileAsync(process.execPath, [
    join(projectRoot, 'packages/main/dist/tasks/proofstory-pre-review-check-smoke.js'),
    '--rollout-cohort-case',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROOF_OR_STOP_ROLLOUT_COHORT_STORY_ID: storyId,
      PROOF_OR_STOP_ROLLOUT_COHORT_ARM: arm,
      PROOF_OR_STOP_ROLLOUT_COHORT_SCENARIO: scenario,
    },
    maxBuffer: 32 * 1024 * 1024,
  }));
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

async function pairRecords({ pairId, index, claimClass, defectClass, seededDefectId, shouldBlock, defectPresent }) {
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
  const [baselineReceipt, candidateReceipt] = await Promise.all([
    runProductionCase({ storyId: baselineStoryId, pairId, arm: 'baseline', scenario, completedAt }),
    runProductionCase({ storyId: candidateStoryId, pairId, arm: 'candidate', scenario, completedAt }),
  ]);
  return [
    makeSourceRecord({
      ...base,
      arm: 'baseline',
      storyId: baselineStoryId,
      observationReceipt: baselineReceipt,
    }),
    makeSourceRecord({
      ...base,
      arm: 'candidate',
      storyId: candidateStoryId,
      observationReceipt: candidateReceipt,
    }),
  ];
}

/**
 * Reproducible verifier-owned cohort producer. Each row is read back from a
 * real temporary Story artifact tree before it enters the frozen inventory.
 */
export function runProofStoryAcceptanceRolloutCohort() {
  return runProofStoryAcceptanceRolloutCohortAsync();
}

async function runProofStoryAcceptanceRolloutCohortAsync() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'proofstory-rollout-cohort-'));
  try {
    const registeredSeedIds = ['seed-c2-omission', 'seed-forged-receipt', 'seed-stale-binding'];
    const rows = (await Promise.all([
      pairRecords({ pairId: 'PAIR-OMISSION', index: 0, claimClass: 'user_visible', defectClass: 'omission', seededDefectId: registeredSeedIds[0], shouldBlock: true, defectPresent: true }),
      pairRecords({ pairId: 'PAIR-FORGERY', index: 1, claimClass: 'safety', defectClass: 'forgery', seededDefectId: registeredSeedIds[1], shouldBlock: true, defectPresent: true }),
      pairRecords({ pairId: 'PAIR-FRESHNESS', index: 2, claimClass: 'lifecycle', defectClass: 'freshness', seededDefectId: registeredSeedIds[2], shouldBlock: true, defectPresent: true }),
      pairRecords({ pairId: 'PAIR-DOCS', index: 3, claimClass: 'docs_only', defectClass: 'control', shouldBlock: false, defectPresent: false }),
      pairRecords({ pairId: 'PAIR-LEGACY', index: 4, claimClass: 'legacy', defectClass: 'control', shouldBlock: false, defectPresent: false }),
      pairRecords({ pairId: 'PAIR-ORDINARY', index: 5, claimClass: 'ordinary', defectClass: 'control', shouldBlock: false, defectPresent: false }),
    ])).flat();
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
      semanticInventoryDigest: semanticCohortDigest(sourceRecords),
      cohortJobs: productionCaseLimit,
      runnerPath: RUNNER_RELATIVE_PATH,
      runnerDigest: sha256(readFileSync(runnerPath)),
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const selfTestArg = args.find(arg => arg.startsWith('--semantic-self-test='));
  if (selfTestArg) {
    if (args.length !== 1) throw new Error(`unknown or duplicate argument: ${args.join(' ')}`);
    const cohort = JSON.parse(readFileSync(resolve(selfTestArg.slice('--semantic-self-test='.length)), 'utf8'));
    const mutations = assertSemanticDigestBitesReviewerFacts(cohort);
    process.stdout.write(`COHORT_SEMANTIC_MUTATIONS=PASS ${mutations.join(',')}\n`);
    process.exit(0);
  }
  if (args.some(arg => !arg.startsWith('--out=')) || args.filter(arg => arg.startsWith('--out=')).length > 1) throw new Error(`unknown or duplicate argument: ${args.join(' ')}`);
  const outArgPath = args.find(arg => arg.startsWith('--out='))?.slice('--out='.length);
  if (args.length && !outArgPath) throw new Error('--out requires a path');
  const cohort = await runProofStoryAcceptanceRolloutCohort();
  const serialized = `${JSON.stringify(cohort, null, 2)}\n`;
  if (outArgPath) {
    const outPath = resolve(outArgPath);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, serialized);
    process.stdout.write(`acceptance rollout cohort written: ${outPath} (${cohort.sourceRecords.length} records)\n`);
  } else {
    process.stdout.write(serialized);
  }
}
