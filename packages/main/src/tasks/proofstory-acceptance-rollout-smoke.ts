import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  acceptanceRolloutHistoryDigest,
  acceptanceRolloutSourceRecordDigest,
  currentAcceptanceRolloutBinding,
  deriveAcceptanceRolloutReport,
  issueAcceptanceRolloutArtifact,
  verifyAcceptanceRolloutArtifact,
} from '../core/acceptance-rollout.js';
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

const projectRoot = resolve(process.cwd());
const runnerPath = join(projectRoot, 'scripts/run-proofstory-acceptance-rollout-cohort.mjs');
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

  const unsupported = mutateRecord(control, record => record.arm === 'candidate', record => { record.adapterProfile = 'partial'; });
  hasCode(unsupported, 'AR_ADAPTER_UNSUPPORTED', 'partial adapter fails promotion');

  const noTranscript = mutateRecord(control, record => record.arm === 'candidate' && record.claimClass === 'user_visible', record => { record.transcriptPresent = false; });
  hasCode(noTranscript, 'AR_TRANSCRIPT_REQUIRED', 'user-visible claim requires transcript');

  const noMutation = mutateRecord(control, record => record.arm === 'candidate' && record.claimClass === 'safety', record => { record.mutationBites = false; });
  hasCode(noMutation, 'AR_MUTATION_REQUIRED', 'safety claim requires biting mutation');

  const incompleteCampaign = clone(control);
  incompleteCampaign.registeredSeedIds.push('seed-unexecuted');
  hasCode(rehash(incompleteCampaign), 'AR_REGISTERED_CAMPAIGN_INCOMPLETE', 'incomplete registered campaign fails');

  const missedNonOmission = mutateRecord(control, record => record.arm === 'candidate' && record.defectClass === 'forgery', record => {
    record.detected = false;
    record.blocked = false;
  });
  hasCode(missedNonOmission, 'AR_FALSE_PASS_NONZERO', 'missed non-omission seed fails zero false-pass boundary');

  const missedOmission = mutateRecord(control, record => record.arm === 'candidate' && record.defectClass === 'omission', record => {
    record.detected = false;
    record.blocked = false;
  });
  hasCode(missedOmission, 'AR_OMISSION_DETECTION_BELOW_100', 'missed omission fails 100% boundary');

  const falseBlock = mutateRecord(control, record => record.arm === 'candidate' && record.claimClass === 'docs_only', record => { record.blocked = true; });
  hasCode(falseBlock, 'AR_FALSE_BLOCK_NONZERO', 'docs-only false block fails');

  const mislabeled = mutateRecord(control, record => record.arm === 'candidate', record => {
    record.quorum.hosts = ['codex-cli'];
    record.quorum.providers = ['codex'];
  });
  hasCode(mislabeled, 'AR_MISLABELED_3X1_NONZERO', '3x1 labeled full-3x2 fails');
  hasCode(mislabeled, 'AR_QUORUM_NOT_FULL_3X2', 'degraded quorum fails full-3x2 boundary');

  const waiver = mutateRecord(control, record => record.arm === 'candidate', record => { record.waiverCount = 99; });
  hasCode(waiver, 'AR_WAIVER_DELTA_POSITIVE', 'positive waiver delta fails');

  const inventory = mutateRecord(control, record => record.arm === 'candidate', record => { record.checkInventory = ['acceptance_rollout_check']; });
  hasCode(inventory, 'AR_CHECK_INVENTORY_SHRANK', 'shrinking check inventory fails');

  const root = mkdtempSync(join(tmpdir(), 'proofstory-rollout-consumer-'));
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'rollout-smoke@example.test']);
    git(root, ['config', 'user.name', 'Rollout Smoke']);
    write(join(root, 'lattice.config.json'), JSON.stringify({
      storyDir: '.lattice/story/actives',
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
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'seed real rollout consumer']);
    const tempCohort = runCohort(join(root, 'scripts/run-proofstory-acceptance-rollout-cohort.mjs'));
    const tempReport = deriveAcceptanceRolloutReport({
      storyId,
      cohort: tempCohort,
      binding: currentAcceptanceRolloutBinding(root, root),
    });
    const artifact = issueAcceptanceRolloutArtifact({ gitCwd: root, report: tempReport, issuedAt: at });
    const ctx = { root, scanRoot: join(root, 'packages/main'), store } as HandlerContext;
    resetConfigCache();
    ok(runAcceptanceRolloutGate(ctx, storyId).includes('AR_REPORT_MISSING'), 'real observe consumer reports missing receipt without blocking');
    store.writeAcceptanceRolloutReport(storyId, artifact);
    const observe = runAcceptanceRolloutGate(ctx, storyId);
    ok(observe.includes('mode=observe; status=pass; blocking=false'), 'real transition consumer passes clean observe control');
    const history = acceptanceRolloutHistoryDigest(artifact);
    write(join(root, 'lattice.config.json'), JSON.stringify({
      storyDir: '.lattice/story/actives',
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
    write(join(root, 'lattice.config.json'), JSON.stringify({
      storyDir: '.lattice/story/actives',
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
      [unsupported, 'AR_ADAPTER_UNSUPPORTED'],
      [noTranscript, 'AR_TRANSCRIPT_REQUIRED'],
      [noMutation, 'AR_MUTATION_REQUIRED'],
      [incompleteCampaign, 'AR_REGISTERED_CAMPAIGN_INCOMPLETE'],
      [missedNonOmission, 'AR_FALSE_PASS_NONZERO'],
      [missedOmission, 'AR_OMISSION_DETECTION_BELOW_100'],
      [falseBlock, 'AR_FALSE_BLOCK_NONZERO'],
      [mislabeled, 'AR_MISLABELED_3X1_NONZERO'],
      [waiver, 'AR_WAIVER_DELTA_POSITIVE'],
      [inventory, 'AR_CHECK_INVENTORY_SHRANK'],
    ];
    for (const [mutatedCohort, code] of realConsumerMutations) {
      const mutatedReport = deriveAcceptanceRolloutReport({
        storyId,
        cohort: mutatedCohort,
        binding: currentAcceptanceRolloutBinding(root, root),
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

    write(join(root, 'lattice.config.json'), JSON.stringify({
      storyDir: '.lattice/story/actives',
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
    rmSync(root, { recursive: true, force: true });
  }

  process.stdout.write(`ProofStory acceptance rollout smoke: PASS (${assertions} assertions)\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runProofStoryAcceptanceRolloutSmoke().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
