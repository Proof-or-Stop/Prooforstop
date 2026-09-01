#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, utimes, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  EXPERIMENT_ROOT,
  STORY5_ROLE_CAMPAIGN,
  canonicalJson,
  digest,
  evaluateBoundFixture,
  evaluateStory5RoleCampaign,
  findingSetDigest,
  historicalFindingSnapshotDigest,
  loadPinnedExperiment,
  materialDigest,
  replayExperiment,
  validateExperiment,
} from './lib/replay.mjs';
import {
  appendLedgerRecord,
  makeLedgerRecord,
  readLedger,
  resolveLedgerPath,
  summarizeLedger,
  verifyLedgerRows,
} from './lib/ledger.mjs';

const repoRoot = path.resolve(EXPERIMENT_ROOT, '..', '..');
const runtimeDir = path.join(EXPERIMENT_ROOT, 'runtime');
const ledgerPath = `runtime/selfcheck-${process.pid}.jsonl`;
const execFileAsync = promisify(execFile);
let checks = 0;

async function check(name, fn) {
  await fn();
  checks += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}

async function expectCode(code, fn) {
  await assert.rejects(fn, error => error?.code === code, `expected ${code}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function reverseObjectInsertion(value) {
  if (Array.isArray(value)) return value.map(reverseObjectInsertion);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectInsertion(child)]));
}

async function snapshotTree(root, relativePaths) {
  const rows = [];
  const visit = async relative => {
    const absolute = path.join(root, relative);
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        rows.push([relative, 'absent']);
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      rows.push([relative, 'symlink', await readlink(absolute)]);
      return;
    }
    if (stat.isDirectory()) {
      const names = (await readdir(absolute)).sort();
      rows.push([relative, 'dir']);
      for (const name of names) await visit(path.posix.join(relative, name));
      return;
    }
    const bytes = await readFile(absolute);
    rows.push([relative, bytes.toString('base64'), bytes.length]);
  };
  for (const relative of relativePaths) await visit(relative);
  return rows;
}

function usage(cell, overrides = {}) {
  return {
    assembledPromptTokens: {
      availability: 'unavailable',
      reason: 'Exact content-addressed prompt snapshot bytes are not pinned for this canonical sample.',
    },
    knownDispatchInputTokens: cell.providerObservation.knownDispatchInputTokens,
    providerProcessedInputTokens: cell.providerObservation.providerProcessedInputTokens,
    uncachedInputTokens: cell.providerObservation.uncachedInputTokens,
    cacheCreationInputTokens: cell.providerObservation.cacheCreationInputTokens,
    cacheReadInputTokens: cell.providerObservation.cacheReadInputTokens,
    outputTokens: cell.providerObservation.outputTokens,
    ...overrides,
  };
}

function inputFor(result, cell, overrides = {}) {
  return {
    experimentId: result.experimentId,
    cellId: cell.cellId,
    ledgerCallId: 'selfcheck-call',
    attemptId: 'attempt-1',
    sequence: 1,
    event: 'assembled',
    disposition: null,
    observedAt: '2026-01-01T00:00:00.000Z',
    inputDigest: cell.inputDigest,
    promptDigest: cell.measurement.promptDigest,
    materialDigest: cell.materialDigest,
    findingSetDigest: cell.findingComparison.findingSetDigest,
    modelId: 'historical-observation-only.v1',
    contractVersion: cell.promptContract,
    usage: usage(cell),
    latencyMs: null,
    findingMeasurement: {
      seededOracleCount: cell.findingComparison.seededOracleCount,
      detectedCount: cell.findingComparison.detectedCount,
      status: cell.findingComparison.status,
      reasonCode: cell.findingComparison.reasonCode,
    },
    ...overrides,
  };
}

function makeHermeticFixture() {
  const oracles = [{
    id: 'HERMETIC-001',
    category: 'missing',
    severity: 'critical',
    sourceBinding: 'fixture/source.mjs',
    claimBinding: 'fixture-claim',
  }];
  const arms = [
    {
      id: 'A',
      promptContract: 'fixture-legacy.v1',
      promptSnapshot: {
        content: 'PROMPT CONTRACT: fixture-legacy.v1\nLegacy fixture instructions.\nShared fixture input.',
      },
    },
    {
      id: 'B',
      promptContract: 'fixture-modular.v1',
      promptSnapshot: {
        content: 'PROMPT CONTRACT: fixture-modular.v1\nModular fixture instructions.\nShared fixture input.',
      },
    },
  ];
  for (const arm of arms) {
    arm.promptSnapshot.contentDigest = digest(
      'role-prompt-ab.hermetic-prompt-snapshot.v1',
      arm.promptSnapshot.content,
    );
  }
  const reviewerOutputs = arms.map(arm => {
    const content = {
      findings: [{
        oracleId: 'HERMETIC-001',
        category: 'missing',
        sourceBinding: 'fixture/source.mjs',
        claimBinding: 'fixture-claim',
      }],
    };
    return {
      armId: arm.id,
      content,
      contentDigest: digest('role-prompt-ab.hermetic-reviewer-output.v1', content),
    };
  });
  const matches = arms.map(arm => ({
    armId: arm.id,
    seededOracleCount: 1,
    detectedCount: 1,
    criticalAllDetected: true,
    recall: 1,
  }));
  const adjudicationContent = { matches };
  return {
    schemaVersion: 'proofbound.role-prompt-ab.hermetic-fixture.v1',
    arms,
    oracles,
    oracleSetDigest: digest('role-prompt-ab.hermetic-oracle-set.v1', oracles),
    reviewerOutputs,
    independentAdjudication: {
      content: adjudicationContent,
      contentDigest: digest('role-prompt-ab.hermetic-independent-adjudication.v1', adjudicationContent),
    },
  };
}

async function proveIsolatedProductionEvidenceNoWrite() {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'role-prompt-evidence-root-'));
  const isolatedExperimentRoot = path.join(sandbox, 'experiments', 'role-prompt-ab-replay');
  const sentinelStoryRoot = path.join(sandbox, '.proof-or-stop', 'story', 'actives', 'B-sentinel');
  const evidencePaths = ['.proof-or-stop'];
  const sentinelFiles = new Map([
    ['review-passes.json', `${canonicalJson({
      passes: [{
        agent: 'proof-or-stop-review-quality',
        reviewRunId: 'B-sentinel:RR-001',
        reviewRound: 'round-1',
        headHash: '1'.repeat(40),
        materialHash: '2'.repeat(64),
        signature: '3'.repeat(64),
      }],
    })}\n`],
    ['findings.json', `${canonicalJson({
      findings: [{
        id: 'B-sentinel:F-001',
        severity: 'high',
        category: 'missing',
        evidenceState: 'verified',
        status: 'open',
        reviewRunId: 'B-sentinel:RR-001',
      }],
    })}\n`],
    ['review-runs.json', `${canonicalJson({
      runs: [{
        id: 'B-sentinel:RR-001',
        agent: 'proof-or-stop-review-quality',
        reviewRound: 'round-1',
        signature: '4'.repeat(64),
      }],
    })}\n`],
    ['checklist.json', `${canonicalJson({
      items: [{
        id: 'CHK-001',
        status: 'done',
        verificationEvidence: [{
          kind: 'logic_test',
          command: 'sentinel-check',
          result: 'pass',
        }],
      }],
    })}\n`],
    ['validation-evidence.json', `${canonicalJson({
      status: 'pass',
      command: 'proof-or-stop validate --story=B-sentinel',
      headHash: '1'.repeat(40),
      materialHash: '2'.repeat(64),
    })}\n`],
    ['index.json', `${canonicalJson({
      id: 'B-sentinel',
      phase: 'TEST',
      status: 'active',
      reviewRound: 'round-1',
    })}\n`],
    ['process-events.jsonl', `${canonicalJson({
      event: 'review_pass_set',
      storyId: 'B-sentinel',
      reviewRunId: 'B-sentinel:RR-001',
      gateEvidence: true,
    })}\n`],
  ]);
  try {
    await mkdir(sentinelStoryRoot, { recursive: true });
    for (const [name, bytes] of sentinelFiles) {
      await writeFile(path.join(sentinelStoryRoot, name), bytes, 'utf8');
    }
    await writeFile(
      path.join(sandbox, '.proof-or-stop', 'process-events.jsonl'),
      `${canonicalJson({
        event: 'validation',
        storyId: 'B-sentinel',
        status: 'pass',
        gateEvidence: true,
      })}\n`,
      'utf8',
    );

    await mkdir(isolatedExperimentRoot, { recursive: true });
    await cp(path.join(EXPERIMENT_ROOT, 'lib'), path.join(isolatedExperimentRoot, 'lib'), { recursive: true });
    for (const name of ['protocol.json', 'corpus.json', 'run.mjs', 'analyze.mjs']) {
      await copyFile(path.join(EXPERIMENT_ROOT, name), path.join(isolatedExperimentRoot, name));
    }
    await mkdir(path.join(isolatedExperimentRoot, 'runtime'), { recursive: true });
    await copyFile(
      path.join(EXPERIMENT_ROOT, 'runtime', '.gitignore'),
      path.join(isolatedExperimentRoot, 'runtime', '.gitignore'),
    );

    const before = await snapshotTree(sandbox, evidencePaths);
    assert.equal(before.filter(row => row.length === 3).length, sentinelFiles.size + 1);
    const run = await execFileAsync(process.execPath, [path.join(isolatedExperimentRoot, 'run.mjs')], { cwd: sandbox });
    assert.match(run.stdout, /Replay: PASS sameInput=true deterministic=true/);
    const ledgerRun = await execFileAsync(process.execPath, [
      path.join(isolatedExperimentRoot, 'run.mjs'),
      '--ledger=runtime/isolated-proof.jsonl',
      '--run-id=isolated-proof',
    ], { cwd: sandbox });
    assert.match(ledgerRun.stdout, /Experiment ledger: PASS gateEvidence=false/);
    const analysis = await execFileAsync(process.execPath, [
      path.join(isolatedExperimentRoot, 'analyze.mjs'),
      '--ledger=runtime/isolated-proof.jsonl',
    ], { cwd: sandbox });
    assert.match(analysis.stdout, /Analysis: INCONCLUSIVE ledger=EVALUABLE providerCost=UNAVAILABLE/);
    const after = await snapshotTree(sandbox, evidencePaths);
    assert.deepEqual(after, before);
    assert.deepEqual(
      (await readdir(path.join(sandbox, '.proof-or-stop'))).sort(),
      ['process-events.jsonl', 'story'],
    );

    const forgedStoryRoot = path.join(sandbox, '.proof-or-stop', 'story', 'actives', 'B-forged');
    await mkdir(forgedStoryRoot, { recursive: true });
    await writeFile(
      path.join(forgedStoryRoot, 'review-passes.json'),
      `${canonicalJson({ passes: [{ agent: 'forged', gateEvidence: true }] })}\n`,
      'utf8',
    );
    assert.notDeepEqual(await snapshotTree(sandbox, evidencePaths), before);
    await rm(forgedStoryRoot, { recursive: true, force: true });
    assert.deepEqual(await snapshotTree(sandbox, evidencePaths), before);

    const forgedUsageRoot = path.join(sandbox, '.proof-or-stop', 'usage');
    await mkdir(forgedUsageRoot, { recursive: true });
    await writeFile(
      path.join(forgedUsageRoot, 'llm-usage.jsonl'),
      `${canonicalJson({ namespace: 'production', inputTokens: 1 })}\n`,
      'utf8',
    );
    assert.notDeepEqual(await snapshotTree(sandbox, evidencePaths), before);
    return { sentinelArtifacts: sentinelFiles.size + 1, entrypoints: 3, mutationBites: 2 };
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

try {
  const { protocol, corpus } = await loadPinnedExperiment();
  let identity;
  let baseline;
  let hermeticResult;
  let isolationProof;
  let roleCampaignResult;

  await check('pinned protocol has 3 classes, 6 samples, >=3 repeats and signed historical findings', () => {
    identity = validateExperiment(protocol, corpus);
    assert.equal(identity.classes, 3);
    assert.equal(identity.samples, 6);
    assert.ok(identity.repeats >= 3);
    assert.equal(identity.seededOracleCount, 4);
    assert.equal(identity.signedHistoricalFindings, 2);
    assert.equal(identity.adjudicatedFindings, 0);
    assert.equal(identity.recallStatus, 'INCONCLUSIVE');
    assert.equal(
      corpus.historicalFindingSnapshotDigest,
      historicalFindingSnapshotDigest(corpus.historicalFindingSnapshot),
    );
  });

  await check('all pinned material and finding digests recompute exactly', () => {
    for (const sample of corpus.samples) {
      assert.equal(sample.materialDigest, materialDigest(sample));
      assert.equal(sample.findingSetDigest, findingSetDigest(sample));
    }
  });

  await check('B-235e campaign pins five roles and reports insufficient quality evidence per role', async () => {
    const roleRegistry = await import(pathToFileURL(
      path.join(repoRoot, 'packages', 'main', 'dist', 'core', 'prompt-role-contract-registry.js'),
    ).href);
    const roleBodies = Object.fromEntries(STORY5_ROLE_CAMPAIGN.roles.map(role => [
      role.roleId,
      {
        legacy: roleRegistry.resolvePromptRoleBody(role.roleId, {
          version: roleRegistry.PROMPT_ENVELOPE_ROLLOUT_VERSION,
          roles: { [role.roleId]: 'legacy-full-context' },
        }).body,
        modular: roleRegistry.resolvePromptRoleBody(role.roleId, {
          version: roleRegistry.PROMPT_ENVELOPE_ROLLOUT_VERSION,
          roles: { [role.roleId]: 'full-envelope' },
        }).body,
      },
    ]));
    roleCampaignResult = evaluateStory5RoleCampaign(STORY5_ROLE_CAMPAIGN, protocol, corpus, roleBodies);
    assert.equal(roleCampaignResult.results.length, 5);
    assert.equal(roleCampaignResult.status, 'INCONCLUSIVE');
    assert.equal(roleCampaignResult.eligibleIncrementalDenominator, 0);
    assert.equal(roleCampaignResult.savingsClaim, null);
    assert.equal(roleCampaignResult.recallClaim, null);
    for (const row of roleCampaignResult.results) {
      assert.equal(row.verdict, 'INCONCLUSIVE');
      assert.equal(row.reasonCode, 'ADJUDICATION_EVIDENCE_UNVERIFIED');
      assert.equal(row.incrementalContextReduction, null);
      assert.equal(row.assembledPromptReduction, null);
      assert.equal(row.providerUsage.claude.providerProcessedInputTokens.availability, 'unavailable');
      assert.equal(row.providerUsage.codex.providerProcessedInputTokens.availability, 'unavailable');
      assert.ok(row.roleBodyReduction > 0);
    }
    const tampered = clone(STORY5_ROLE_CAMPAIGN);
    tampered.roles.reverse();
    await expectCode('ROLE_CAMPAIGN_DIGEST_MISMATCH', async () =>
      evaluateStory5RoleCampaign(tampered, protocol, corpus, roleBodies));
    const substitutedBodies = clone(roleBodies);
    substitutedBodies['proof-or-stop-review-concept'].modular =
      substitutedBodies['proof-or-stop-review-quality'].modular;
    await expectCode('PROMPT_SNAPSHOT_DIGEST_MISMATCH', async () =>
      evaluateStory5RoleCampaign(STORY5_ROLE_CAMPAIGN, protocol, corpus, substitutedBodies));
  });

  await check('same frozen contract and corpus yield the same experiment identity', () => {
    assert.equal(validateExperiment(clone(protocol), clone(corpus)).experimentId, identity.experimentId);
  });

  await check('frozen protocol mutation changes content-addressed experiment identity', () => {
    const changed = clone(protocol);
    changed.arms[0].description += ' changed';
    assert.notEqual(validateExperiment(changed, corpus).experimentId, identity.experimentId);
  });

  await check('repeat floor regression is rejected', async () => {
    const changed = clone(protocol);
    changed.sampling.repeats = 2;
    changed.sampling.armOrderByRepeat = changed.sampling.armOrderByRepeat.slice(0, 2);
    await expectCode('REPEAT_FLOOR_INCOMPLETE', async () => validateExperiment(changed, corpus));
  });

  await check('protocol rejects locally recomputed assembledPrompt semantics without pinned prompt bytes', async () => {
    const changed = clone(protocol);
    changed.inputLayers.assembledPrompt = 'locally-recomputed';
    await expectCode('INVALID_INPUT_LAYER_SEMANTICS', async () => validateExperiment(changed, corpus));
  });

  await check('sample-class floor regression is rejected', async () => {
    const changed = clone(corpus);
    changed.samples = changed.samples.filter(sample => sample.id !== 'clean-pass-02');
    await expectCode('SAMPLE_FLOOR_INCOMPLETE', async () => validateExperiment(protocol, changed));
  });

  await check('duplicate sample identity is rejected', async () => {
    const changed = clone(corpus);
    changed.samples.push(clone(changed.samples[0]));
    await expectCode('DUPLICATE_SAMPLE', async () => validateExperiment(protocol, changed));
  });

  await check('unverified oracle rows cannot masquerade as independent adjudication', async () => {
    const changed = clone(corpus);
    changed.samples[2].oracles[0].adjudication = {
      status: 'verified',
      reason: 'unsupported prose-only claim',
    };
    changed.samples[2].findingSetDigest = findingSetDigest(changed.samples[2]);
    await expectCode('ADJUDICATION_EVIDENCE_UNVERIFIED', async () => validateExperiment(protocol, changed));
  });

  await check('forged historical finding signature is rejected even when the snapshot digest is repinned', async () => {
    const changed = clone(corpus);
    changed.historicalFindingSnapshot[0]._hash = '0'.repeat(64);
    changed.historicalFindingSnapshotDigest = historicalFindingSnapshotDigest(changed.historicalFindingSnapshot);
    await expectCode('HISTORICAL_FINDING_SIGNATURE_INVALID', async () => validateExperiment(protocol, changed));
  });

  await check('cross-story historical finding reference is rejected even when the snapshot digest is repinned', async () => {
    const changed = clone(corpus);
    changed.historicalFindingSnapshot[0].reviewRunId = 'B-other:RR-001';
    changed.historicalFindingSnapshotDigest = historicalFindingSnapshotDigest(changed.historicalFindingSnapshot);
    await expectCode('HISTORICAL_FINDING_REFERENCE_INVALID', async () => validateExperiment(protocol, changed));
  });

  await check('unavailable controls carry reasons and never masquerade as zero', () => {
    for (const key of ['temperature', 'providerSeed', 'toolChoice']) {
      assert.equal(protocol.sampling[key].availability, 'unavailable');
      assert.ok(protocol.sampling[key].reason.length > 10);
      assert.equal(Object.hasOwn(protocol.sampling[key], 'tokens'), false);
    }
  });

  await check('unbound available historical provider or dispatch metrics are rejected', async () => {
    const dispatch = clone(corpus);
    dispatch.samples[0].providerObservation.knownDispatchInputTokens = {
      availability: 'available',
      tokens: 1,
      source: 'unbound claim',
    };
    await expectCode('UNBOUND_HISTORICAL_METRIC', async () => validateExperiment(protocol, dispatch));
    const provider = clone(corpus);
    provider.samples[0].providerObservation.providerProcessedInputTokens = {
      availability: 'available',
      tokens: 0,
      source: 'unbound zero claim',
    };
    await expectCode('UNBOUND_HISTORICAL_METRIC', async () => validateExperiment(protocol, provider));
  });

  await check('inline corpus content is the exact snapshot authority and sourceHintPath is non-authoritative', async () => {
    for (const sample of corpus.samples) {
      assert.equal(sample.material.sourceKind, 'inline-corpus-snapshot');
      assert.equal(sample.material.snapshotAuthority, 'corpus-json-content-addressed.v1');
      assert.equal(sample.material.snapshotId, sample.id);
      assert.ok(sample.material.content && typeof sample.material.content === 'object');
    }
    const wrongAuthority = clone(corpus);
    wrongAuthority.samples[0].material.snapshotAuthority = 'repository-path-claim.v1';
    wrongAuthority.samples[0].materialDigest = materialDigest(wrongAuthority.samples[0]);
    await expectCode('MUTABLE_MATERIAL', async () => validateExperiment(protocol, wrongAuthority));
    const missingContent = clone(corpus);
    delete missingContent.samples[0].material.content;
    missingContent.samples[0].materialDigest = materialDigest(missingContent.samples[0]);
    await expectCode('MATERIAL_MISSING', async () => validateExperiment(protocol, missingContent));
  });

  await check('valid replay is deterministic and same-input across arms', () => {
    baseline = replayExperiment({ protocol, corpus });
    const repeated = replayExperiment({ protocol, corpus });
    assert.equal(repeated.resultDigest, baseline.resultDigest);
    assert.equal(baseline.sameInput, true);
    assert.equal(baseline.cells.length, corpus.samples.length * protocol.arms.length * protocol.sampling.repeats);
    for (const sample of corpus.samples) {
      const cells = baseline.cells.filter(cell => cell.sampleId === sample.id);
      assert.equal(new Set(cells.map(cell => cell.inputDigest)).size, 1);
      assert.deepEqual([...new Set(cells.map(cell => cell.repeat))].sort(), [1, 2, 3]);
    }
  });

  await check('reverse arm execution order preserves all canonical cell measurements', () => {
    const reversed = replayExperiment({ protocol, corpus, armOrder: ['B', 'A'] });
    assert.equal(reversed.resultDigest, baseline.resultDigest);
    assert.deepEqual(reversed.cells, baseline.cells);
  });

  await check('equivalent object insertion order preserves identities and measurements', () => {
    const reorderedProtocol = reverseObjectInsertion(protocol);
    const reorderedCorpus = reverseObjectInsertion(corpus);
    const reordered = replayExperiment({ protocol: reorderedProtocol, corpus: reorderedCorpus });
    assert.equal(reordered.experimentId, baseline.experimentId);
    assert.equal(reordered.resultDigest, baseline.resultDigest);
  });

  await check('meaningful model change changes shared input while prompt cost stays honestly unavailable', () => {
    const changedProtocol = clone(protocol);
    changedProtocol.model.modelId = 'historical-observation-only.v2';
    const changed = replayExperiment({ protocol: changedProtocol, corpus });
    assert.notEqual(changed.cells[0].inputDigest, baseline.cells[0].inputDigest);
    assert.equal(changed.cells[0].measurement.promptDigest, null);
    assert.equal(changed.cells[0].measurement.status, 'INCONCLUSIVE');
  });

  await check('arm contract mutation changes contract identity but cannot fabricate prompt bytes', () => {
    const changedProtocol = clone(protocol);
    changedProtocol.arms[0].promptContract = 'legacy-full-context.v2';
    const changed = replayExperiment({ protocol: changedProtocol, corpus });
    const baselineA = baseline.cells.find(cell => cell.armId === 'A');
    const changedA = changed.cells.find(cell => cell.armId === 'A');
    assert.notEqual(changedA.promptContractDigest, baselineA.promptContractDigest);
    assert.equal(changedA.measurement.bytes, null);
    assert.equal(changedA.measurement.promptDigest, null);
  });

  await check('hermetic bound fixture computes exact prompt metrics and semantic finding comparison', () => {
    hermeticResult = evaluateBoundFixture(makeHermeticFixture());
    assert.equal(hermeticResult.status, 'EVALUABLE');
    assert.equal(hermeticResult.evidenceScope, 'hermetic-selfcheck-only');
    assert.equal(hermeticResult.historicalEvidence, false);
    assert.ok(hermeticResult.cells.every(cell => cell.measurement.bytes > 0));
    assert.ok(hermeticResult.cells.every(cell => /^[a-f0-9]{64}$/.test(cell.measurement.promptDigest)));
    assert.ok(hermeticResult.cells.every(cell => cell.findingComparison.recall === 1));
  });

  await check('hermetic prompt contract/content and reviewer-output tamper fail closed', async () => {
    const contractOnly = makeHermeticFixture();
    contractOnly.arms[0].promptContract = 'fixture-legacy.v2';
    await expectCode('PROMPT_CONTRACT_SNAPSHOT_MISMATCH', async () => evaluateBoundFixture(contractOnly));
    const updated = makeHermeticFixture();
    const oldDigest = updated.arms[0].promptSnapshot.contentDigest;
    updated.arms[0].promptContract = 'fixture-legacy.v2';
    updated.arms[0].promptSnapshot.content =
      'PROMPT CONTRACT: fixture-legacy.v2\nLegacy fixture instructions.\nShared fixture input.';
    updated.arms[0].promptSnapshot.contentDigest = digest(
      'role-prompt-ab.hermetic-prompt-snapshot.v1',
      updated.arms[0].promptSnapshot.content,
    );
    const evaluated = evaluateBoundFixture(updated);
    assert.notEqual(evaluated.cells.find(cell => cell.armId === 'A').promptSnapshotDigest, oldDigest);
    const outputTamper = makeHermeticFixture();
    outputTamper.reviewerOutputs[0].content.findings[0].category = 'edge';
    await expectCode('FINDING_OUTPUT_DIGEST_MISMATCH', async () => evaluateBoundFixture(outputTamper));
  });

  await check('hermetic evaluator requires exact unique A/B arm and output sets', async () => {
    const duplicateArms = makeHermeticFixture();
    duplicateArms.arms[1] = clone(duplicateArms.arms[0]);
    await expectCode('HERMETIC_ARM_SET_INVALID', async () => evaluateBoundFixture(duplicateArms));

    const missingOutput = makeHermeticFixture();
    missingOutput.reviewerOutputs.pop();
    await expectCode('HERMETIC_OUTPUT_SET_INVALID', async () => evaluateBoundFixture(missingOutput));

    const duplicateOutput = makeHermeticFixture();
    duplicateOutput.reviewerOutputs[1] = clone(duplicateOutput.reviewerOutputs[0]);
    await expectCode('HERMETIC_OUTPUT_SET_INVALID', async () => evaluateBoundFixture(duplicateOutput));

    const extraOutput = makeHermeticFixture();
    extraOutput.reviewerOutputs.push(clone(extraOutput.reviewerOutputs[0]));
    await expectCode('HERMETIC_OUTPUT_SET_INVALID', async () => evaluateBoundFixture(extraOutput));
  });

  await check('meaningful material/tool change changes digests after explicit repinning', () => {
    const changedCorpus = clone(corpus);
    changedCorpus.samples[0].tools.push('Bash');
    changedCorpus.samples[0].materialDigest = materialDigest(changedCorpus.samples[0]);
    const changed = replayExperiment({ protocol, corpus: changedCorpus });
    assert.notEqual(changed.cells.find(cell => cell.cellId === 'clean-pass-01/A/repeat-1').inputDigest,
      baseline.cells.find(cell => cell.cellId === 'clean-pass-01/A/repeat-1').inputDigest);
  });

  await check('unrepinned material mutation fails closed', async () => {
    const changed = clone(corpus);
    changed.samples[0].material.content.diff += ' tampered';
    await expectCode('MATERIAL_DIGEST_MISMATCH', async () => replayExperiment({ protocol, corpus: changed }));
  });

  await check('protocol and corpus version skew fail closed', async () => {
    const changedProtocol = clone(protocol);
    changedProtocol.schemaVersion = 'proofbound.role-prompt-ab.protocol.v2';
    await expectCode('UNSUPPORTED_PROTOCOL_VERSION', async () => replayExperiment({ protocol: changedProtocol, corpus }));
    const changedCorpus = clone(corpus);
    changedCorpus.schemaVersion = 'proofbound.role-prompt-ab.corpus.v2';
    await expectCode('UNSUPPORTED_CORPUS_VERSION', async () => replayExperiment({ protocol, corpus: changedCorpus }));
  });

  await check('path traversal and mutable live Story material are rejected', async () => {
    const traversal = clone(corpus);
    traversal.samples[0].material.sourceHintPath = '../.proof-or-stop/story/actives/B-8d4b/index.json';
    traversal.samples[0].materialDigest = materialDigest(traversal.samples[0]);
    await expectCode('PATH_ESCAPE', async () => replayExperiment({ protocol, corpus: traversal }));
    const mutable = clone(corpus);
    mutable.samples[0].material.sourceKind = 'live-story';
    mutable.samples[0].materialDigest = materialDigest(mutable.samples[0]);
    await expectCode('MUTABLE_MATERIAL', async () => replayExperiment({ protocol, corpus: mutable }));
  });

  await check('caller-supplied digest or finding results are rejected', async () => {
    await expectCode('CALLER_SUBSTITUTION_REJECTED', async () => replayExperiment({
      protocol, corpus, resultDigest: '0'.repeat(64),
    }));
    await expectCode('CALLER_SUBSTITUTION_REJECTED', async () => replayExperiment({
      protocol, corpus, findingOutcomes: [],
    }));
  });

  const firstCell = baseline.cells[0];
  await check('experiment record is private, non-authoritative and identity bound', () => {
    const row = makeLedgerRecord(inputFor(baseline, firstCell));
    assert.equal(row.namespace, 'experiment-only');
    assert.equal(row.gateEvidence, false);
    assert.equal(row.privacy.contentStored, false);
    assert.equal(row.experimentId, baseline.experimentId);
    assert.equal(row.promptDigest, firstCell.measurement.promptDigest);
  });

  await check('normal usage-ledger and process-fact consumers do not admit experiment rows', async () => {
    const row = makeLedgerRecord(inputFor(baseline, firstCell));
    const normalLedger = await import(pathToFileURL(
      path.join(repoRoot, 'packages/main/dist/core/usage-ledger/record.js'),
    ).href);
    const normalValidation = normalLedger.validateUsageLedgerRecord(row);
    assert.equal(normalValidation.ok, false);
    const [factRegistry, factLevels] = await Promise.all([
      readFile(path.join(repoRoot, 'packages/main/src/core/process-fact-registry.ts'), 'utf8'),
      readFile(path.join(repoRoot, 'packages/main/src/core/process-fact-levels.ts'), 'utf8'),
    ]);
    assert.equal(factRegistry.includes('proofbound.role-prompt-ab.experiment-ledger.v1'), false);
    assert.equal(factLevels.includes('proofbound.role-prompt-ab.experiment-ledger.v1'), false);
    assert.equal(factRegistry.includes('experiments/role-prompt-ab-replay/runtime'), false);
  });

  await check('forged authority and production Story references are rejected', async () => {
    await expectCode('PRIVATE_OR_AUTHORITATIVE_FIELD', async () => makeLedgerRecord(inputFor(baseline, firstCell, {
      authority: { receiptVerified: true },
    })));
    await expectCode('PRIVATE_OR_AUTHORITATIVE_FIELD', async () => makeLedgerRecord(inputFor(baseline, firstCell, {
      storyId: 'B-forged',
    })));
  });

  await check('raw prompts, tool arguments and secrets are rejected recursively', async () => {
    await expectCode('PRIVATE_OR_AUTHORITATIVE_FIELD', async () => makeLedgerRecord(inputFor(baseline, firstCell, {
      rawPrompt: 'private',
    })));
    const poisoned = inputFor(baseline, firstCell);
    poisoned.usage.toolArguments = { authorization: 'secret' };
    await expectCode('PRIVATE_OR_AUTHORITATIVE_FIELD', async () => makeLedgerRecord(poisoned));
  });

  await check('malformed or unbound numeric metrics are rejected and unavailable is not zero', async () => {
    const negative = inputFor(baseline, firstCell);
    negative.usage.cacheReadInputTokens = { availability: 'available', tokens: -1, source: 'bad' };
    await expectCode('INVALID_LEDGER_RECORD', async () => makeLedgerRecord(negative));
    const zero = inputFor(baseline, firstCell);
    zero.usage.cacheReadInputTokens = { availability: 'available', tokens: 0, source: 'pinned provider terminal usage' };
    await expectCode('UNBOUND_HISTORICAL_METRIC', async () => makeLedgerRecord(zero));
    const unavailable = makeLedgerRecord(inputFor(baseline, firstCell)).usage.cacheReadInputTokens;
    assert.equal(unavailable.availability, 'unavailable');
    assert.equal(Object.hasOwn(unavailable, 'tokens'), false);
  });

  await check('assembled prompt tokens require both a prompt digest and reconstruction evidence', async () => {
    const zeroWithoutPrompt = inputFor(baseline, firstCell);
    zeroWithoutPrompt.usage.assembledPromptTokens = {
      availability: 'available',
      tokens: 0,
      source: 'caller assertion without reconstruction evidence',
    };
    await expectCode('UNBOUND_PROMPT_SNAPSHOT', async () => makeLedgerRecord(zeroWithoutPrompt));

    const claimedBinding = clone(zeroWithoutPrompt);
    claimedBinding.promptDigest = 'a'.repeat(64);
    await expectCode('UNBOUND_PROMPT_SNAPSHOT', async () => makeLedgerRecord(claimedBinding));

    const forgedStoredRow = makeLedgerRecord(inputFor(baseline, firstCell));
    forgedStoredRow.usage.assembledPromptTokens = clone(zeroWithoutPrompt.usage.assembledPromptTokens);
    await expectCode('UNBOUND_PROMPT_SNAPSHOT', async () => verifyLedgerRows([forgedStoredRow]));
  });

  await check('experiment ledger path cannot escape into production evidence', async () => {
    await expectCode('LEDGER_PATH_ESCAPE', async () => resolveLedgerPath('../.proof-or-stop/story/forged.jsonl'));
    await expectCode('LEDGER_PATH_ESCAPE', async () => resolveLedgerPath('runtime/../../.proof-or-stop/usage/llm-usage.jsonl'));
  });

  await check('symlink escape under the experiment runtime is rejected', async () => {
    const link = path.join(runtimeDir, 'escape-link');
    await mkdir(runtimeDir, { recursive: true });
    await rm(link, { force: true, recursive: true });
    await symlink(path.join(repoRoot, '.proof-or-stop'), link);
    try {
      await expectCode('LEDGER_PATH_ESCAPE', async () => resolveLedgerPath('runtime/escape-link/forged.jsonl'));
    } finally {
      await rm(link, { force: true });
    }
  });

  await check('symlink ledger file itself cannot redirect an fd-based append', async () => {
    const link = path.join(runtimeDir, 'file-link.jsonl');
    await mkdir(runtimeDir, { recursive: true });
    await rm(link, { force: true });
    await symlink(path.join(repoRoot, '.proof-or-stop', 'process-events.jsonl'), link);
    try {
      await expectCode('LEDGER_PATH_ESCAPE', async () => appendLedgerRecord(
        'runtime/file-link.jsonl',
        inputFor(baseline, firstCell),
      ));
    } finally {
      await rm(link, { force: true });
    }
  });

  await check('dead stale lock is reclaimed without weakening live-owner exclusion', async () => {
    const stalePath = `runtime/stale-lock-${process.pid}.jsonl`;
    const target = await resolveLedgerPath(stalePath);
    const lockPath = `${target}.lock`;
    const old = new Date(Date.now() - 60_000);
    await writeFile(lockPath, `${canonicalJson({
      pid: process.pid,
      createdAt: old.toISOString(),
      lockId: '00000000-0000-4000-8000-000000000001',
    })}\n`, { mode: 0o600 });
    await utimes(lockPath, old, old);
    await expectCode('LEDGER_LOCK_TIMEOUT', async () => appendLedgerRecord(
      stalePath,
      inputFor(baseline, firstCell, {
        ledgerCallId: 'live-owner',
        attemptId: 'live-owner-attempt',
      }),
    ));
    await rm(lockPath, { force: true });
    await writeFile(lockPath, `${canonicalJson({
      pid: 2147483647,
      createdAt: old.toISOString(),
      lockId: '00000000-0000-4000-8000-000000000000',
    })}\n`, { mode: 0o600 });
    await utimes(lockPath, old, old);
    try {
      await appendLedgerRecord(stalePath, inputFor(baseline, firstCell, {
        ledgerCallId: 'stale-recovery',
        attemptId: 'stale-attempt',
      }));
      assert.equal((await readLedger(stalePath)).length, 1);
      await assert.rejects(lstat(lockPath), error => error?.code === 'ENOENT');
    } finally {
      await rm(target, { force: true });
      await rm(lockPath, { force: true });
    }
  });

  await check('runtime parent replacement after lock acquisition cannot escape the namespace', async () => {
    const racePath = `runtime/parent-race-${process.pid}.jsonl`;
    const target = await resolveLedgerPath(racePath);
    const heldRuntime = `${runtimeDir}-held-${process.pid}`;
    const external = await mkdtemp(path.join(tmpdir(), 'role-prompt-parent-race-'));
    let swapped = false;
    try {
      await expectCode('LEDGER_PATH_ESCAPE', async () => appendLedgerRecord(
        racePath,
        inputFor(baseline, firstCell, {
          ledgerCallId: 'parent-race',
          attemptId: 'parent-race-attempt',
        }),
        {
          afterLockAcquired: async () => {
            await rename(runtimeDir, heldRuntime);
            await symlink(external, runtimeDir, 'dir');
            swapped = true;
          },
        },
      ));
      assert.deepEqual(await readdir(external), []);
    } finally {
      if (swapped) {
        await rm(runtimeDir, { force: true });
        await rename(heldRuntime, runtimeDir);
      }
      await rm(`${target}.lock`, { force: true });
      await rm(target, { force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  await check('append-only ledger records ordered events and terminal supersession', async () => {
    await appendLedgerRecord(ledgerPath, inputFor(baseline, firstCell));
    await appendLedgerRecord(ledgerPath, inputFor(baseline, firstCell, {
      sequence: 2,
      event: 'terminal',
      disposition: 'succeeded',
      observedAt: '2026-01-01T00:01:00.000Z',
    }));
    const rows = await readLedger(ledgerPath);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1].supersedesRecordIds, [rows[0].recordId]);
    verifyLedgerRows(rows);
  });

  await check('concurrent appenders serialize under one experiment-local lock', async () => {
    const concurrentPath = `runtime/concurrent-${process.pid}.jsonl`;
    const secondCell = baseline.cells[1];
    try {
      await Promise.all([
        appendLedgerRecord(concurrentPath, inputFor(baseline, firstCell, {
          ledgerCallId: 'concurrent-a',
          attemptId: 'attempt-a',
        })),
        appendLedgerRecord(concurrentPath, inputFor(baseline, secondCell, {
          ledgerCallId: 'concurrent-b',
          attemptId: 'attempt-b',
        })),
      ]);
      const rows = await readLedger(concurrentPath);
      assert.equal(rows.length, 2);
      assert.equal(rows[1].previousRecordHash, rows[0].recordHash);
      verifyLedgerRows(rows);
    } finally {
      await rm(await resolveLedgerPath(concurrentPath), { force: true });
    }
  });

  await check('duplicate/out-of-order/after-terminal writes are rejected', async () => {
    await expectCode('DUPLICATE_LEDGER_RECORD', async () => appendLedgerRecord(ledgerPath, inputFor(baseline, firstCell, {
      sequence: 2,
      event: 'terminal',
      disposition: 'succeeded',
      observedAt: '2026-01-01T00:02:00.000Z',
    })));
    await expectCode('ATTEMPT_ORDER_INVALID', async () => appendLedgerRecord(ledgerPath, inputFor(baseline, firstCell, {
      sequence: 4,
      event: 'terminal',
      disposition: 'failed',
      observedAt: '2026-01-01T00:03:00.000Z',
    })));
  });

  await check('crashed attempt and retry retain distinct attempt identities', async () => {
    const retryCell = baseline.cells.find(cell => cell.sampleId === 'closeout-01');
    await appendLedgerRecord(ledgerPath, inputFor(baseline, retryCell, {
      ledgerCallId: 'retry-call',
      attemptId: 'attempt-1',
    }));
    await appendLedgerRecord(ledgerPath, inputFor(baseline, retryCell, {
      ledgerCallId: 'retry-call',
      attemptId: 'attempt-1',
      sequence: 2,
      event: 'terminal',
      disposition: 'crashed',
      observedAt: '2026-01-01T00:01:01.000Z',
    }));
    await appendLedgerRecord(ledgerPath, inputFor(baseline, retryCell, {
      ledgerCallId: 'retry-call',
      attemptId: 'attempt-2',
    }));
    await appendLedgerRecord(ledgerPath, inputFor(baseline, retryCell, {
      ledgerCallId: 'retry-call',
      attemptId: 'attempt-2',
      sequence: 2,
      event: 'terminal',
      disposition: 'succeeded',
      observedAt: '2026-01-01T00:01:02.000Z',
    }));
    const rows = await readLedger(ledgerPath);
    const attempts = new Set(rows.filter(row => row.ledgerCallId === 'retry-call').map(row => row.attemptId));
    assert.deepEqual([...attempts].sort(), ['attempt-1', 'attempt-2']);
  });

  await check('summary counts one terminal usage row per attempt and never estimates twice', async () => {
    const rows = await readLedger(ledgerPath);
    const summary = summarizeLedger(rows);
    assert.equal(summary.records, 6);
    assert.equal(summary.attempts, 3);
    assert.equal(summary.terminalAttempts, 3);
    assert.equal(summary.incompleteAttempts, 0);
    assert.equal(summary.gateEvidence, false);
    assert.equal(summary.finalProviderInputTokens, null);
    assert.equal(summary.providerInputAvailability, 'unavailable');
    assert.equal(summary.providerInputUnavailableReason, 'PROVIDER_INPUT_TOKENS_UNAVAILABLE');
  });

  await check('empty ledger summary is unavailable with no fabricated numeric zero', async () => {
    const summary = summarizeLedger([]);
    assert.equal(summary.records, 0);
    assert.equal(summary.finalProviderInputTokens, null);
    assert.equal(summary.providerInputAvailability, 'unavailable');
    assert.equal(summary.providerInputUnavailableReason, 'NO_TERMINAL_ATTEMPTS');
    const cli = await execFileAsync(process.execPath, [
      path.join(EXPERIMENT_ROOT, 'analyze.mjs'),
      `--ledger=runtime/empty-${process.pid}.jsonl`,
      '--json',
    ]);
    const reported = JSON.parse(cli.stdout);
    assert.equal(reported.finalProviderInputTokens, null);
    assert.equal(reported.providerInputAvailability, 'unavailable');
    assert.equal(reported.providerInputUnavailableReason, 'NO_TERMINAL_ATTEMPTS');
  });

  await check('ledger chain tamper is rejected', async () => {
    const rows = await readLedger(ledgerPath);
    const changed = clone(rows);
    changed[0].observedAt = '2026-01-01T00:09:00.000Z';
    await expectCode('INVALID_LEDGER_RECORD', async () => verifyLedgerRows(changed));
  });

  await check('privacy injection with recomputed row hash is rejected before chain acceptance', async () => {
    const [row] = await readLedger(ledgerPath);
    const changed = clone(row);
    changed.rawPrompt = 'injected private bytes';
    changed.recordHash = digest('role-prompt-ab.ledger-record.v1', Object.fromEntries(
      Object.entries(changed).filter(([key]) => key !== 'recordHash'),
    ));
    await expectCode('PRIVATE_OR_AUTHORITATIVE_FIELD', async () => verifyLedgerRows([changed]));
  });

  await check('missing finding output remains INCONCLUSIVE instead of zero recall', () => {
    const changed = clone(corpus);
    for (const sample of changed.samples) {
      sample.oracles = [];
      sample.findingSetDigest = findingSetDigest(sample);
    }
    const result = replayExperiment({ protocol, corpus: changed });
    assert.equal(result.cells[0].findingComparison.status, 'INCONCLUSIVE');
    assert.equal(result.cells[0].findingComparison.reasonCode, 'FINDING_OUTPUT_UNAVAILABLE');
    assert.equal(result.cells[0].findingComparison.recall, null);
  });

  await check('partial provider observation remains unavailable, not zero', () => {
    const cell = baseline.cells.find(item => item.sampleId === 'clean-pass-01');
    assert.equal(cell.providerObservation.providerProcessedInputTokens.availability, 'unavailable');
    assert.equal(Object.hasOwn(cell.providerObservation.providerProcessedInputTokens, 'tokens'), false);
    assert.equal(cell.findingComparison.recall, null);
  });

  await check('B-235e provider/cache dimensions preserve unavailable reasons through CLI output', () => {
    for (const row of roleCampaignResult.results) {
      for (const [provider, dimensions] of Object.entries(row.providerUsage)) {
        for (const [dimension, observation] of Object.entries(dimensions)) {
          assert.equal(observation.availability, 'unavailable', `${provider}.${dimension}`);
          assert.equal(typeof observation.reason, 'string', `${provider}.${dimension} reason`);
          assert.ok(observation.reason.length > 0, `${provider}.${dimension} nonblank reason`);
          assert.equal(Object.hasOwn(observation, 'tokens'), false);
          assert.equal(Object.hasOwn(observation, 'value'), false);
        }
      }
    }
  });

  await check('isolated copied entrypoints cannot write sentinel production evidence or process events', async () => {
    isolationProof = await proveIsolatedProductionEvidenceNoWrite();
    assert.equal(isolationProof.sentinelArtifacts, 8);
    assert.equal(isolationProof.entrypoints, 3);
    assert.equal(isolationProof.mutationBites, 2);
  });

  process.stdout.write(`Protocol: PASS experimentId=${identity.experimentId} classes=${identity.classes} samples=${identity.samples} repeats>=3 seededOracles=${identity.seededOracleCount} signedHistoricalFindings=${identity.signedHistoricalFindings} adjudicatedReplayFindings=${identity.adjudicatedFindings}\n`);
  process.stdout.write('Replay: PASS sameInput=true deterministic=true\n');
  process.stdout.write('Prompt cost: INCONCLUSIVE reason=PROMPT_SNAPSHOT_UNAVAILABLE\n');
  process.stdout.write('Recall: INCONCLUSIVE reason=ADJUDICATION_EVIDENCE_UNVERIFIED\n');
  for (const row of roleCampaignResult.results) {
    process.stdout.write(
      `B-235e role=${row.roleId} verdict=${row.verdict} reason=${row.reasonCode} ` +
      `legacyRoleBodyTokens=${row.legacyRoleBodyTokens} modularRoleBodyTokens=${row.modularRoleBodyTokens} ` +
      `incrementalContextReduction=unavailable assembledReduction=unavailable ` +
      `providerUsage=${JSON.stringify(row.providerUsage)}\n`,
    );
  }
  process.stdout.write(`Hermetic fixture: EVALUABLE scope=${hermeticResult.evidenceScope} historicalEvidence=${hermeticResult.historicalEvidence} cells=${hermeticResult.cells.length}\n`);
  process.stdout.write('Experiment ledger: PASS gateEvidence=false attempts=3\n');
  process.stdout.write(`Isolated production evidence drift: NONE sentinelArtifacts=${isolationProof.sentinelArtifacts} copiedEntrypoints=${isolationProof.entrypoints} mutationBites=${isolationProof.mutationBites}\n`);
  process.stdout.write(`Selfcheck: PASS checks=${checks}\n`);
} finally {
  await rm(await resolveLedgerPath(ledgerPath), { force: true });
  try {
    const remaining = await readdir(runtimeDir);
    if (remaining.length === 0) await rm(runtimeDir, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
