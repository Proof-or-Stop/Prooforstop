import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptanceRolloutHistoryDigest,
  acceptanceRolloutSourceRecordDigest,
  currentAcceptanceRolloutBinding,
  deriveAcceptanceRolloutReport,
  issueAcceptanceRolloutObservationFromProduction,
  issueAcceptanceRolloutArtifact,
  verifyAcceptanceRolloutArtifact,
} from '../core/acceptance-rollout.js';
import type { ProductionRolloutCaseEvidence } from '../core/acceptance-rollout.js';
import { digestCanonicalJson } from '../core/digest.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type {
  AcceptanceRolloutArtifactV1,
  AcceptanceRolloutCohortInputV1,
  AcceptanceRolloutDiagnosticCodeV1,
  AcceptanceRolloutSourceRecordV1,
  StoryInfo,
} from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { runAcceptanceRolloutGate } from '../handlers/transition-orchestrator.js';
import { STATE_DIR_NAMES } from '../core/brand-paths.js';

const projectRoot = resolve(process.cwd());
const runnerPath = join(projectRoot, 'scripts/run-proofstory-acceptance-rollout-cohort.mjs');
const issuerMutationMode = process.argv.includes('--issuer-mutations');
const cohortArgPath = process.argv.find(arg => arg.startsWith('--cohort='))?.slice('--cohort='.length);
let assertions = 0;

function ok(value: unknown, message: string): asserts value {
  assert.ok(value, message);
  assertions += 1;
}

function equal(actual: unknown, expected: unknown, message: string): void {
  assert.equal(actual, expected, message);
  assertions += 1;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function runCohort(path = runnerPath): AcceptanceRolloutCohortInputV1 {
  const frozenInputPath = cohortArgPath || process.env.PROOF_OR_STOP_ROLLOUT_COHORT_INPUT_PATH;
  if (frozenInputPath) {
    return JSON.parse(readFileSync(frozenInputPath, 'utf8')) as AcceptanceRolloutCohortInputV1;
  }
  return JSON.parse(execFileSync(process.execPath, [path], { encoding: 'utf8' })) as AcceptanceRolloutCohortInputV1;
}

function rehash(cohort: AcceptanceRolloutCohortInputV1): AcceptanceRolloutCohortInputV1 {
  for (const record of cohort.sourceRecords) {
    const { sourceDigest: _sourceDigest, ...unsigned } = record;
    record.sourceDigest = acceptanceRolloutSourceRecordDigest(unsigned);
  }
  cohort.sourceRecords.sort((a, b) =>
    a.pairId.localeCompare(b.pairId) || a.arm.localeCompare(b.arm) || a.storyId.localeCompare(b.storyId));
  cohort.sourceInventoryDigest = `sha256:${digestCanonicalJson(cohort.sourceRecords)}`;
  return cohort;
}

function mutateRecord(
  control: AcceptanceRolloutCohortInputV1,
  predicate: (record: AcceptanceRolloutSourceRecordV1) => boolean,
  mutate: (record: AcceptanceRolloutSourceRecordV1) => void,
): AcceptanceRolloutCohortInputV1 {
  const changed = clone(control);
  const record = changed.sourceRecords.find(predicate);
  if (!record) throw new Error('mutation target missing');
  mutate(record);
  return rehash(changed);
}

function report(cohort: AcceptanceRolloutCohortInputV1) {
  return deriveAcceptanceRolloutReport({
    storyId: 'B-ROLLOUT',
    cohort,
    binding: { headHash: 'head', materialHash: 'material', storyFilesHash: 'story-files' },
    gitCwd: projectRoot,
  });
}

function hasCode(cohort: AcceptanceRolloutCohortInputV1, code: AcceptanceRolloutDiagnosticCodeV1, message: string): void {
  ok(report(cohort).diagnostics.includes(code), message);
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function runIssuerMutationSmoke(): void {
  const storyId = 'B-issuer-mutation';
  const output = execFileSync(process.execPath, [
    join(projectRoot, 'packages/main/dist/tasks/proofstory-pre-review-check-smoke.js'),
    '--rollout-cohort-case',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROOF_OR_STOP_ROLLOUT_COHORT_STORY_ID: storyId,
      PROOF_OR_STOP_ROLLOUT_COHORT_ARM: 'candidate',
      PROOF_OR_STOP_ROLLOUT_COHORT_SCENARIO: 'omission',
    },
    maxBuffer: 32 * 1024 * 1024,
  });
  const line = output.split(/\r?\n/).find(row => row.startsWith('PROOFSTORY_ROLLOUT_CASE='));
  if (!line) throw new Error('issuer mutation smoke did not emit production evidence');
  const evidence = JSON.parse(line.slice('PROOFSTORY_ROLLOUT_CASE='.length)) as ProductionRolloutCaseEvidence & { evidenceGitCwd: string };
  const issue = (candidate: ProductionRolloutCaseEvidence) => issueAcceptanceRolloutObservationFromProduction({
    gitCwd: projectRoot,
    evidenceGitCwd: evidence.evidenceGitCwd,
    storyId,
    pairId: 'PAIR-ISSUER-MUTATION',
    arm: 'candidate',
    scenario: 'omission',
    issuedAt: '2026-07-23T12:00:00.000Z',
    evidence: candidate,
  });
  try {
    const receipt = issue(evidence);
    equal(receipt.mutationResults[0]?.observedCode, 'PR_NEW_PATH_UNMAPPED', 'issuer derives mutation code from production replay');
    equal(receipt.mutationResults[0]?.controlRestored, true, 'issuer derives clean restored control PASS');
    ok(receipt.mutationResults[0]?.mutationCommitSha !== receipt.mutationResults[0]?.restorationCommitSha,
      'receipt binds distinct ordered mutation and restoration commits');

    const substituted = clone(evidence);
    substituted.preReviewReport = { storyId, status: 'pass', ok: true, codes: [] };
    assert.throws(() => issue(substituted), /caller mutation pre-review report does not match production command replay/);
    assertions += 1;

    const omittedRestoration = clone(evidence) as unknown as Record<string, unknown>;
    delete omittedRestoration.restorationCommitSha;
    assert.throws(() => issue(omittedRestoration as unknown as ProductionRolloutCaseEvidence), /restoration commit is missing or malformed/);
    assertions += 1;

    const forgedRestoration = clone(evidence);
    forgedRestoration.restorationCommitSha = forgedRestoration.mutationCommitSha;
    assert.throws(() => issue(forgedRestoration), /restoration commit must be later than mutation commit/);
    assertions += 1;

    // F-006 regression: the preserved evidence repository is caller-supplied, so
    // replaying it must never execute repository-local code. Plant a real
    // post-checkout hook and prove the issuer's checkouts do not fire it. Without
    // the GIT_UNTRUSTED_REPO_ARGS overrides this hook runs inside the verifier
    // process and can tamper the files being replayed.
    const evidenceGitDir = git(evidence.evidenceGitCwd, ['rev-parse', '--absolute-git-dir']);
    const hookMarker = join(evidence.evidenceGitCwd, 'post-checkout-hook-fired.txt');
    mkdirSync(join(evidenceGitDir, 'hooks'), { recursive: true });
    writeFileSync(
      join(evidenceGitDir, 'hooks', 'post-checkout'),
      `#!/bin/sh\necho fired > ${JSON.stringify(hookMarker)}\n`,
      { encoding: 'utf8', mode: 0o755 },
    );
    issue(evidence);
    ok(!existsSync(hookMarker), 'issuer replay must not execute hooks from the caller-supplied evidence repository');
  } finally {
    rmSync(evidence.evidenceGitCwd, { recursive: true, force: true });
  }
  process.stdout.write(`ProofStory acceptance rollout issuer mutation smoke: PASS (${assertions} assertions)\n`);
}

export async function runProofStoryAcceptanceRolloutSmoke(): Promise<void> {
  const control = runCohort();
  const clean = report(control);
  equal(clean.verdict, 'pass', 'registered real temp Story cohort passes');
  equal(clean.metrics.matchedPairCount, 6, 'six frozen comparable matched pairs');
  ok(clean.metrics.baselineSampleCount >= 3 && clean.metrics.candidateSampleCount >= 3, 'at least three samples in each arm');
  equal(clean.metrics.falsePassCount, 0, 'all registered candidate seeds detected');
  equal(clean.metrics.omissionDetectionRate, 1, 'supported omission detection is 100%');
  equal(clean.metrics.falseBlockRate, 0, 'docs-only, legacy and ordinary controls are not blocked');
  equal(clean.metrics.mislabeled3x1Count, 0, 'no degraded 3x1 is mislabeled');
  ok(clean.metrics.waiverDelta <= 0, 'waiver delta is non-positive');
  equal(clean.metrics.inventoryShrankCount, 0, 'check inventory is non-shrinking');

  const omitted = clone(control);
  omitted.sourceRecords = omitted.sourceRecords.filter(record => !(record.pairId === 'PAIR-OMISSION' && record.arm === 'candidate'));
  hasCode(rehash(omitted), 'AR_MATCHED_PAIR_MISSING', 'eligible membership omission fails');

  const ineligible = mutateRecord(control, record => record.arm === 'candidate', record => {
    record.completedAt = '2000-01-01T00:00:00.000Z';
  });
  hasCode(ineligible, 'AR_INELIGIBLE_MEMBER', 'window-ineligible row cannot remain eligible');

  const windowChanged = clone(control);
  windowChanged.evaluationWindow.end = '2026-07-23T11:00:00.000Z';
  hasCode(rehash(windowChanged), 'AR_INELIGIBLE_MEMBER', 'altered evaluation window fails membership');

  const badDigest = clone(control);
  badDigest.sourceRecords[0]!.sourceDigest = 'sha256:forged';
  hasCode(badDigest, 'AR_SOURCE_RECORD_INVALID', 'source record digest forgery fails');

  const twoPairs = clone(control);
  twoPairs.sourceRecords = twoPairs.sourceRecords.filter(record => ['PAIR-OMISSION', 'PAIR-FORGERY'].includes(record.pairId));
  twoPairs.registeredSeedIds = ['seed-c2-omission', 'seed-forged-receipt'];
  hasCode(rehash(twoPairs), 'AR_SAMPLE_COUNT_LT_3', 'fewer than three matched pairs fails');

  const unsupported = mutateRecord(control, record => record.arm === 'candidate', record => {
    (record as unknown as Record<string, unknown>).adapterProfile = 'partial';
  });
  hasCode(unsupported, 'AR_SOURCE_EVIDENCE_INVALID', 'caller-authored adapter observation is rejected');

  const noTranscript = mutateRecord(control, record => record.arm === 'candidate' && record.claimClass === 'user_visible', record => {
    record.observationReceipt.transcriptRefs = [];
  });
  hasCode(noTranscript, 'AR_SOURCE_EVIDENCE_INVALID', 'unsigned transcript receipt mutation is rejected');

  const noMutation = mutateRecord(control, record => record.arm === 'candidate' && record.claimClass === 'safety', record => {
    record.observationReceipt.mutationResults[0]!.observedCode = 'MUTANT_SURVIVED';
  });
  hasCode(noMutation, 'AR_SOURCE_EVIDENCE_INVALID', 'unsigned mutation outcome is rejected');

  const incompleteCampaign = clone(control);
  incompleteCampaign.registeredSeedIds.push('seed-unexecuted');
  hasCode(rehash(incompleteCampaign), 'AR_REGISTERED_CAMPAIGN_INCOMPLETE', 'incomplete registered campaign fails');

  const missedNonOmission = mutateRecord(control, record => record.arm === 'candidate' && record.defectClass === 'forgery', record => {
    record.observationReceipt.gateArtifacts[1]!.report.status = 'pass';
  });
  hasCode(missedNonOmission, 'AR_SOURCE_EVIDENCE_INVALID', 'forged non-omission gate outcome is rejected');

  const missedOmission = mutateRecord(control, record => record.arm === 'candidate' && record.defectClass === 'omission', record => {
    record.observationReceipt.gateArtifacts[0]!.report.status = 'pass';
  });
  hasCode(missedOmission, 'AR_SOURCE_EVIDENCE_INVALID', 'forged omission gate outcome is rejected');

  const falseBlock = mutateRecord(control, record => record.arm === 'candidate' && record.claimClass === 'docs_only', record => {
    (record as unknown as Record<string, unknown>).blocked = true;
  });
  hasCode(falseBlock, 'AR_SOURCE_EVIDENCE_INVALID', 'caller-authored false-block observation is rejected');

  const mislabeled = mutateRecord(control, record => record.arm === 'candidate', record => {
    record.observationReceipt.hostVerdicts = record.observationReceipt.hostVerdicts.filter(item => item.hostId === 'codex-cli');
  });
  hasCode(mislabeled, 'AR_SOURCE_EVIDENCE_INVALID', '3x1 receipt truncation is rejected');

  const waiver = mutateRecord(control, record => record.arm === 'candidate', record => {
    record.observationReceipt.waiverRefs.push('forged-waiver');
  });
  hasCode(waiver, 'AR_SOURCE_EVIDENCE_INVALID', 'unsigned waiver telemetry is rejected');

  const inventory = mutateRecord(control, record => record.arm === 'candidate', record => {
    record.observationReceipt.checkInventory = ['acceptance_rollout_check'];
  });
  hasCode(inventory, 'AR_SOURCE_EVIDENCE_INVALID', 'unsigned check inventory shrink is rejected');

  const root = mkdtempSync(join(tmpdir(), 'proofstory-rollout-consumer-'));
  const previousCwd = process.cwd();
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'rollout-smoke@example.test']);
    git(root, ['config', 'user.name', 'Rollout Smoke']);
    const rolloutKeyName = 'proof-or-stop-acceptance-rollout-verifier-v1.key';
    const mainCommon = resolve(projectRoot, git(projectRoot, ['rev-parse', '--git-common-dir']));
    const tempCommon = resolve(root, git(root, ['rev-parse', '--git-common-dir']));
    if (existsSync(join(mainCommon, rolloutKeyName))) {
      copyFileSync(join(mainCommon, rolloutKeyName), join(tempCommon, rolloutKeyName));
    }
    write(join(root, 'proof-or-stop.config.json'), JSON.stringify({
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      scanRoot: 'packages/main',
      rootDir: 'src',
      outDir: 'packages/main/dist',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      proofStory: { acceptanceRolloutGateMode: 'observe' },
    }, null, 2));
    cpSync(runnerPath, join(root, 'scripts/run-proofstory-acceptance-rollout-cohort.mjs'));
    mkdirSync(join(root, 'packages/main'), { recursive: true });
    symlinkSync(join(projectRoot, 'packages/main/dist'), join(root, 'packages/main/dist'), 'dir');
    // The verifier replays the production gate commands with ITS OWN trusted CLI
    // (replayProductionGateState resolves `<cliRoot>/bin/proofOrStop.js`, and cliRoot is
    // the verifier project — never the evidence repo, so a preserved repo cannot
    // forge the replay with a doctored CLI). This fixture stands in for that
    // verifier project, so it needs the same bin/ bootstrap a real ProofOrStop-managed
    // repo has; without it the replay fails with MODULE_NOT_FOUND instead of
    // exercising the substitution defence.
    symlinkSync(join(projectRoot, 'bin'), join(root, 'bin'), 'dir');
    write(join(root, 'packages/main/src/control.ts'), 'export const control = true;\n');
    const store = new StoryStore(root);
    const storyId = 'B-REAL';
    const at = '2026-07-23T12:00:00.000Z';
    const story: StoryInfo = {
      storyId,
      name: 'rollout-real-consumer',
      title: 'Rollout real consumer',
      description: 'real transition consumer fixture',
      type: 'feature',
      phase: 'DEV',
      priority: 'high',
      createdAt: at,
      startedAt: at,
      endedAt: null,
      events: [],
    };
    store.writeStory(storyId, story);
    // B-cc10: `git add .` would stage the CLI-written activity log, which quorum_submit's
    // assertCleanQuorumBaseline then reports as 'M .proof-or-stop/activity.jsonl' and
    // refuses on. Ignore the runtime activity log under EVERY state-dir spelling before
    // the seed commit so only real fixture content is tracked.
    write(join(root, '.gitignore'), STATE_DIR_NAMES.map((dir) => `${dir}/activity.jsonl`).join('\n') + '\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'seed real rollout consumer']);
    git(root, ['switch', '-c', `story/${storyId}`]);
    write(join(root, 'packages/main/src/control.ts'), 'export const control = true; export const storyRevision = 1;\n');
    git(root, ['add', 'packages/main/src/control.ts']);
    git(root, ['commit', '-m', 'add story-owned rollout consumer change']);
    process.chdir(root);
    // The copied runner is byte-identical and the cohort is verifier-owned,
    // independent of the consuming repository. Reusing the already generated
    // signed cohort proves the real consumer path without repeating twelve
    // expensive production CLI scenarios.
    const tempRunnerDigest = `sha256:${createHash('sha256').update(readFileSync(join(root, 'scripts/run-proofstory-acceptance-rollout-cohort.mjs'))).digest('hex')}`;
    equal(tempRunnerDigest, control.runnerDigest, 'copied cohort runner is byte-identical before verifier-owned cohort reuse');
    const tempCohort = clone(control);
    const tempReport = deriveAcceptanceRolloutReport({
      storyId,
      cohort: tempCohort,
      binding: currentAcceptanceRolloutBinding(root, root),
      gitCwd: root,
    });
    const artifact = issueAcceptanceRolloutArtifact({ gitCwd: root, report: tempReport, issuedAt: at });
    const ctx = { root, scanRoot: join(root, 'packages/main'), store } as HandlerContext;
    resetConfigCache();
    ok(runAcceptanceRolloutGate(ctx, storyId).includes('AR_REPORT_MISSING'), 'real observe consumer reports missing receipt without blocking');
    store.writeAcceptanceRolloutReport(storyId, artifact);
    const observe = runAcceptanceRolloutGate(ctx, storyId);
    const currentBinding = currentAcceptanceRolloutBinding(root, root);
    const currentRunnerDigest = `sha256:${createHash('sha256').update(readFileSync(join(root, 'scripts/run-proofstory-acceptance-rollout-cohort.mjs'))).digest('hex')}`;
    ok(observe.includes('mode=observe; status=pass; blocking=false'),
      `real transition consumer passes clean observe control: ${observe}; ` +
      `signedBinding=${JSON.stringify(artifact.report.binding)} currentBinding=${JSON.stringify(currentBinding)} currentRunnerDigest=${currentRunnerDigest}`);
    const history = acceptanceRolloutHistoryDigest(artifact);
    write(join(root, 'proof-or-stop.config.json'), JSON.stringify({
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      scanRoot: 'packages/main',
      rootDir: 'src',
      outDir: 'packages/main/dist',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      proofStory: { acceptanceRolloutGateMode: 'warn' },
    }));
    resetConfigCache();
    const warn = runAcceptanceRolloutGate(ctx, storyId);
    ok(warn.includes('mode=warn; status=pass; blocking=false'), 'warn preserves status and diagnostics without blocking');
    write(join(root, 'proof-or-stop.config.json'), JSON.stringify({
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      scanRoot: 'packages/main',
      rootDir: 'src',
      outDir: 'packages/main/dist',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      proofStory: { acceptanceRolloutGateMode: 'enforce' },
    }));
    resetConfigCache();
    const enforce = runAcceptanceRolloutGate(ctx, storyId);
    ok(enforce.includes('mode=enforce; status=pass; blocking=false'), 'enforce accepts only current clean PASS receipt');
    equal(acceptanceRolloutHistoryDigest(store.readAcceptanceRolloutReport(storyId)!), history, 'mode changes preserve report byte-for-byte');

    const realConsumerMutations: Array<[AcceptanceRolloutCohortInputV1, AcceptanceRolloutDiagnosticCodeV1]> = [
      [twoPairs, 'AR_SAMPLE_COUNT_LT_3'],
      [unsupported, 'AR_SOURCE_EVIDENCE_INVALID'],
      [noTranscript, 'AR_SOURCE_EVIDENCE_INVALID'],
      [noMutation, 'AR_SOURCE_EVIDENCE_INVALID'],
      [incompleteCampaign, 'AR_REGISTERED_CAMPAIGN_INCOMPLETE'],
      [missedNonOmission, 'AR_SOURCE_EVIDENCE_INVALID'],
      [missedOmission, 'AR_SOURCE_EVIDENCE_INVALID'],
      [falseBlock, 'AR_SOURCE_EVIDENCE_INVALID'],
      [mislabeled, 'AR_SOURCE_EVIDENCE_INVALID'],
      [waiver, 'AR_SOURCE_EVIDENCE_INVALID'],
      [inventory, 'AR_SOURCE_EVIDENCE_INVALID'],
    ];
    for (const [mutatedCohort, code] of realConsumerMutations) {
      const mutatedReport = deriveAcceptanceRolloutReport({
        storyId,
        cohort: mutatedCohort,
        binding: currentAcceptanceRolloutBinding(root, root),
        gitCwd: projectRoot,
      });
      store.writeAcceptanceRolloutReport(storyId, issueAcceptanceRolloutArtifact({ gitCwd: root, report: mutatedReport, issuedAt: at }));
      assert.throws(() => runAcceptanceRolloutGate(ctx, storyId), new RegExp(code), `real enforce consumer rejects ${code}`);
      assertions += 1;
      store.writeAcceptanceRolloutReport(storyId, artifact);
      ok(runAcceptanceRolloutGate(ctx, storyId).includes('status=pass'), `restoration after ${code} returns clean control`);
    }
    equal(acceptanceRolloutHistoryDigest(store.readAcceptanceRolloutReport(storyId)!), history, 'all threshold mutation restorations preserve signed history');

    const tampered = clone(artifact) as AcceptanceRolloutArtifactV1;
    tampered.receipt.signature = `${tampered.receipt.signature.slice(0, -2)}AA`;
    store.writeAcceptanceRolloutReport(storyId, tampered);
    resetConfigCache();
    assert.throws(() => runAcceptanceRolloutGate(ctx, storyId), /acceptance rollout enforcement blocked/, 'real enforce consumer rejects tampered receipt');
    assertions += 1;
    store.writeAcceptanceRolloutReport(storyId, artifact);
    resetConfigCache();
    ok(runAcceptanceRolloutGate(ctx, storyId).includes('status=pass'), 'exact restoration returns clean control');

    const staleReport = deriveAcceptanceRolloutReport({
      storyId,
      cohort: tempCohort,
      binding: { headHash: 'deadbeef', materialHash: 'sha256:stale', storyFilesHash: 'sha256:stale' },
      gitCwd: root,
    });
    const staleArtifact = issueAcceptanceRolloutArtifact({ gitCwd: root, report: staleReport, issuedAt: at });
    const stale = verifyAcceptanceRolloutArtifact({
      artifact: staleArtifact,
      gitCwd: root,
      metadataRoot: root,
      expectedStoryId: storyId,
      expectedCohort: tempCohort,
      mode: 'enforce',
    });
    ok(stale.diagnostics.includes('AR_REPORT_STALE') && stale.blocking, 'stale signed receipt fails enforce');

    write(join(root, 'proof-or-stop.config.json'), JSON.stringify({
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      scanRoot: 'packages/main',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      proofStory: { acceptanceRolloutGateMode: 'observe' },
    }));
    store.writeAcceptanceRolloutReport(storyId, artifact);
    resetConfigCache();
    ok(runAcceptanceRolloutGate(ctx, storyId).includes('blocking=false'), 'rollback to observe is non-blocking');
    equal(acceptanceRolloutHistoryDigest(store.readAcceptanceRolloutReport(storyId)!), history, 'rollback preserves signed history');
  } finally {
    process.chdir(previousCwd);
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }

  process.stdout.write(`PROOF_OR_STOP_FULL_SUITE_SUMMARY=${JSON.stringify({ assertions: [`acceptance-rollout:${assertions}`], mutations: ['reviewer-host-removal', 'quorum-forgery', 'review-round-forgery', 'transcript-removal', 'waiver-forgery', 'restoration-tamper'] })}\n`);
  process.stdout.write(`ProofStory acceptance rollout smoke: PASS (${assertions} assertions)\n`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  if (issuerMutationMode) {
    try { runIssuerMutationSmoke(); }
    catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  } else {
    runProofStoryAcceptanceRolloutSmoke().catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
