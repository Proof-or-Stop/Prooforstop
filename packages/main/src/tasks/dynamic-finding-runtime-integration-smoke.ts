/** Real isolated Git + native review + runtime producer + ledger adapter integration.
 * No fixture observations are submitted as operational rollout qualification. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import { collectReviewerEvidenceState } from '../core/review-run.js';
import { withMkdirLock, captureMkdirLockFence } from '../core/mkdir-lock.js';
import { createFindingLedgerHandlers, appendFindingLedger, findingLedgerSignerFromWorkspace, readCurrentFindingRuntimeEvidence } from '../handlers/finding-ledger.js';
import { createFindingApplicabilityHandlers } from '../handlers/finding-applicability.js';
import { seedCurrentReviewFixture, bindCurrentFixtureFinding } from './current-review-fixture.js';
import { nativeReviewFixtureBrokers, withNativeReviewFixtureHostIdentity, runBrokeredNativeReviewCli } from './native-review-fixture.js';
import { FINDING_PROTECTED_SURFACES } from '../core/finding-applicability.js';
import { readFindingValidationConstraints, readFindingValidationPreview, assertFindingValidationConstraintsCurrent } from '../core/finding-validation.js';
import { RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY } from '../core/evidence/artifact-store.js';
import { FINDING_QUALIFICATION_METRICS, FINDING_QUALIFICATION_POLICY } from '../core/finding-rollout-qualification.js';

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-dfec-runtime-'));
const beforeCwd = process.cwd();
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
const write = (path: string, value: string) => writeFileSync(resolve(root, path), value);
let assertions = 0;
const pass = (name: string) => { assertions++; console.log(`DFEC_RUNTIME ${name} PASS`); };
try {
  const storyId = 'B-dfec'; const findingId = `${storyId}:F-001`; const agent = 'proof-or-stop-review-concept';
  const round = new Date().toISOString();
  const command = `${process.execPath} witness.mjs`;
  const qualificationCommand = `${process.execPath} qualification.mjs`;
  write('proof-or-stop.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' }, dynamicFinding: { mode: 'warn' },
    nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() } }));
  write('.gitignore', '.proof-or-stop/\nbuild/\n');
  write('defect.mjs', 'export const broken = true;\n');
  write('build.mjs', `import {mkdirSync,copyFileSync} from 'node:fs'; mkdirSync('build',{recursive:true}); copyFileSync('defect.mjs','build/defect.mjs');`);
  write('witness.mjs', `import {broken} from './build/defect.mjs';
import {StoryStore} from ${JSON.stringify(new URL('../core/store.js', import.meta.url).href)};
import {currentApplicabilityContext} from ${JSON.stringify(new URL('../core/finding-applicability-projection.js', import.meta.url).href)};
const context=currentApplicabilityContext(new StoryStore(process.cwd()),process.cwd(),${JSON.stringify(storyId)});
console.log('finding-repair:${findingId}');
console.log('FINDING_WITNESS '+JSON.stringify({schemaVersion:'proof-or-stop.finding-witness.v1', storyId:${JSON.stringify(storyId)},findingId:${JSON.stringify(findingId)},
baseHash:context.baseHash,headHash:context.headHash,scopeDigest:context.scopeDigest,acceptanceDigest:context.acceptanceDigest,
evaluationScope:'target_story',verdict:'applicable',reproduced:broken,baseReproduced:broken,introducedByCurrentStory:false,
gateImpact:'blocks',affectedPaths:['defect.mjs'],checkedIntentRefs:['CHK-001:happy:0','CHK-001:edge:0'],
protectedSurfaceEvaluation:${JSON.stringify(FINDING_PROTECTED_SURFACES.map(surface => ({ surface, state: 'clear', evidenceRefs: ['CHK-001:happy:0'] })))} }));
process.exitCode=broken?1:0;`);
  write('qualification.mjs', `import {StoryStore} from ${JSON.stringify(new URL('../core/store.js', import.meta.url).href)};
const source=new StoryStore(process.cwd()).readFindingLedger(${JSON.stringify(storyId)}).records.filter(row=>row.recordType==='finding_applicability_assessment').at(-1).payload;
console.log('FINDING_QUALIFICATION '+JSON.stringify({schemaVersion:${JSON.stringify(FINDING_QUALIFICATION_POLICY.version)},assessmentId:source.assessmentId,
population:'adversarial',storyClass:'isolated-fixture',detectorVersion:'fixture-v1',retryPolicy:'No retries',exclusions:[],
timingSeconds:{classifier:0,triage:0,repair:0,convergence:0},prerequisites:[],simpleStoryRegression:null,timeoutRate:0,latencyCorpusSize:1,candidateBaselineExplained:true,
measurements:${JSON.stringify(FINDING_QUALIFICATION_METRICS.map(([metric, comparison]) => ({ metric, numerator: comparison === 'max' ? 0 : 1, denominator: 1, latencySeconds: 1 })))} }));`);
  git('init', '-b', 'main'); git('config', 'user.name', 'Isolated DFEC Test'); git('config', 'user.email', 'dfec@example.invalid');
  git('add', '.'); git('commit', '-m', 'fixture baseline'); resetConfigCache(); process.chdir(root);
  const store = new StoryStore(root); const ctx = { root, store, scanRoot: join(root, 'packages/main') };
  store.writeStory(storyId, { storyId, name: 'dfec', title: 'Finding runtime contract', description: 'Disposable integration corpus, never operational evidence.',
    type: 'feature', phase: 'REVIEW', priority: 'medium', createdAt: round, startedAt: round, endedAt: null, currentReviewRound: round,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: round }] });
  store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'Exercise runtime Finding witness', context: 'Actual controlled regression', status: 'done', startTime: round, endTime: round,
    verificationIntent: { happy: [{ desc: 'Execute the pinned regression witness.', type: 'cli', verification: { command, selector: 'FINDING_WITNESS' } }],
      edge: [{ desc: 'Measure the isolated qualification case, never an operational cohort.', type: 'cli', verification: { command: qualificationCommand, selector: 'FINDING_QUALIFICATION' } }], adversarial: [] } }] });
  const runs = seedCurrentReviewFixture(root, store, storyId, [agent]);
  const finding = bindCurrentFixtureFinding({ id: findingId, desc: 'The controlled defect still reproduces.', severity: 'high', category: 'edge', status: 'open', evidenceState: 'verified',
    files: ['defect.mjs'], agent, createdAt: new Date().toISOString(), reviewRound: round, reviewRunId: runs.get(agent)! });
  const lock = store.runtimeLockDirPath(storyId, 'finding', 'findings');
  withMkdirLock(lock, () => { const fence = captureMkdirLockFence(lock); appendFindingLedger({ storyId, store, operation: 'append_finding', idempotencyKey: 'native-source',
    records: [{ recordType: 'finding', payload: finding as never, uniqueBindingKey: findingId }], writerSessionId: 'isolated-fixture', writerLeaseId: 'isolated-fixture',
    writerFenceToken: fence.writerFenceToken, fence, signer: findingLedgerSignerFromWorkspace(root) }); }, { requireHolderToken: true });
  const state = collectReviewerEvidenceState(store, storyId, root);
  assert.ok(state.valid.some(row => row.id === findingId), JSON.stringify(state)); pass('native source Finding is current');
  const runtimeHandlers = createFindingLedgerHandlers(ctx);
  const runtimeArgs = { storyId, idempotencyKey: 'reproduction-red', buildCommand: { executable: process.execPath, args: ['build.mjs'], cwd: '.' },
    executionCommand: { executable: process.execPath, args: ['witness.mjs'], cwd: '.' }, artifactPaths: ['build/defect.mjs'], environmentAllowlist: [],
    compilerVersion: 'fixture-javascript-v1', timeoutMs: 30_000, storageCapability: RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY };
  const red = runtimeHandlers.finding_runtime_evidence_run(runtimeArgs);
  assert.equal(red.receipt.exitCode, 1); assert.equal(readCurrentFindingRuntimeEvidence(ctx, storyId, red.runtimeReceiptId).receipt.receiptHash, red.receipt.receiptHash);
  pass('actual RED runtime receipt passes current reader');
  const handlers = createFindingApplicabilityHandlers(ctx);
  const desired = { verdict: 'applicable', basis: 'direct_scope', owner: 'current_story', evaluationScope: 'target_story',
    runtimeReceiptIds: [red.runtimeReceiptId], currentWitness: { reproduced: true, receiptIds: [red.runtimeReceiptId] },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), protectedSurfaceEvaluation: FINDING_PROTECTED_SURFACES.map(surface => ({ surface, state: 'clear', evidenceRefs: ['CHK-001:happy:0'] })) };
  const proposalArgs = { storyId, findingId, idempotencyKey: 'proposal-once', proposal: desired };
  const proposed = withNativeReviewFixtureHostIdentity({ agent, invoke: () => handlers.finding_assessment_propose(proposalArgs) });
  const again = withNativeReviewFixtureHostIdentity({ agent, invoke: () => handlers.finding_assessment_propose(proposalArgs) });
  assert.deepEqual(again.proposalRef, proposed.proposalRef); pass('proposal is receipted and idempotent');
  const request = { storyId, findingId, idempotencyKey: 'assessment-once', verdict: 'applicable' as const, proofStrength: 'strong' as const,
    dispositionPlan: 'repair_current' as const, gateImpact: 'blocks' as const, proposalRef: proposed.proposalRef as never };
  const assessment = handlers.finding_applicability_assess(request);
  assert.equal(handlers.finding_applicability_assess(request).assessment.assessmentId, assessment.assessment.assessmentId);
  assert.equal(handlers.finding_triage({ storyId }).rows[0]!.decision.reason, 'mandatory_repair_floor'); pass('signed assessment and shared gate agree');
  assert.throws(() => handlers.finding_applicability_assess({ ...request, gateImpact: 'does_not_block' }), /IDEMPOTENCY_CONFLICT/);
  assert.throws(() => handlers.finding_applicability_assess({ ...request, idempotencyKey: 'changed-label', gateImpact: 'does_not_block' }), /gate impact/);
  pass('changed idempotency payload and caller labels cannot change proof');
  const constraints = readFindingValidationConstraints(store, root, storyId);
  const preview = readFindingValidationPreview(store, root, storyId);
  assert.deepEqual(preview.requiredCommands, [command]); assert.equal(preview.scopeExpansionAuthorized, false);
  assert.deepEqual(constraints.requiredCommands, []);
  assertFindingValidationConstraintsCurrent(store, root, constraints); pass('Finding proof proposes validation command without changing warn gate');
  const transact = StoryStore.prototype.transactFindingLedger;
  const beforeRace = store.readFindingLedger(storyId).committedLedgerDigest;
  let raced = false;
  try {
    StoryStore.prototype.transactFindingLedger = function(id, fence, prepare, options) {
      if (id === storyId && !raced) { raced = true; write('defect.mjs', 'export const broken = false; // concurrent drift\n'); }
      return transact.call(this, id, fence, prepare as never, options) as never;
    };
    assert.throws(() => handlers.finding_applicability_assess({ ...request, idempotencyKey: 'source-race' }), /CAS_CONFLICT|stale|changed|mismatch/);
    assert.equal(raced, true); assert.equal(store.readFindingLedger(storyId).committedLedgerDigest, beforeRace);
  } finally { StoryStore.prototype.transactFindingLedger = transact; write('defect.mjs', 'export const broken = true;\n'); }
  pass('transaction-boundary source race refuses with zero ledger delta');
  const before = store.readFindingLedger(storyId).committedLedgerDigest;
  assert.throws(() => handlers.finding_applicability_batch({ storyId, idempotencyKey: 'partial', items: [request, { ...request, findingId: 'missing' }] }), /required/);
  assert.equal(store.readFindingLedger(storyId).committedLedgerDigest, before); pass('batch refusal publishes no partial record');
  const batch = handlers.finding_applicability_batch({ storyId, idempotencyKey: 'valid-batch', items: [request] });
  assert.equal(batch.assessments.length, 1); assert.equal(handlers.finding_applicability_batch({ storyId, idempotencyKey: 'valid-batch', items: [request] }).manifest.manifestId, batch.manifest.manifestId);
  pass('valid batch is atomic and replayed once');
  const independent = 'proof-or-stop-review-quality';
  const independentRun = seedCurrentReviewFixture(root, store, storyId, [independent]).get(independent)!;
  const measured = runtimeHandlers.finding_runtime_evidence_run({ ...runtimeArgs, idempotencyKey: 'qualification-measurement',
    executionCommand: { executable: process.execPath, args: ['qualification.mjs'], cwd: '.' } });
  assert.equal(measured.receipt.exitCode, 0);
  const qualifierArgs = { storyId, findingId, assessmentId: (batch.assessments[0] as { assessmentId: string }).assessmentId, reviewRunId: independentRun,
    runtimeReceiptId: measured.runtimeReceiptId, idempotencyKey: 'qualification-case' };
  assert.throws(() => withNativeReviewFixtureHostIdentity({ agent: independent, invoke: () => handlers.finding_qualification_record(qualifierArgs) }), /reviewer evidence|signed PASS/);
  const marker = `finding-qualification:${qualifierArgs.assessmentId}:${measured.runtimeReceiptId}:${measured.receipt.receiptHash}`;
  await runBrokeredNativeReviewCli({ root, store, storyId, agent: independent, reviewRunId: independentRun,
    command: 'review_pass_set', payload: { storyId, agent: independent, reviewRunId: independentRun,
      readManifest: { filesReadFully: ['qualification.mjs', 'witness.mjs'], filesTriagedByName: [], scanEscalationReason: null },
      note: `Independent isolated qualification measurement audit.\n${marker}` } });
  const qualified = withNativeReviewFixtureHostIdentity({ agent: independent, invoke: () => handlers.finding_qualification_record(qualifierArgs) });
  assert.ok(qualified); assert.equal(handlers.finding_qualification_query({ storyId }).rows.length, 1);
  const measuredCase = handlers.finding_qualification_query({ storyId }).rows[0]!.payload;
  assert.equal(measuredCase.measurementAuthority, 'reported_statistics_non_qualifying');
  assert.equal(measuredCase.measurements.length, 22);
  assert.deepEqual(measuredCase.queryMeasurements, []);
  assert.equal(measuredCase.publicQueries.ledger.signedRows, true);
  pass('22 self-reported rates remain diagnostic; actual empty query cannot manufacture denominators');
  assert.throws(() => withNativeReviewFixtureHostIdentity({ agent: independent, invoke: () => handlers.finding_qualification_record({ ...qualifierArgs, idempotencyKey: 'inflate' }) }), /duplicate case/);
  assert.equal(handlers.finding_rollout_scorecard({ storyId }).qualification.qualification.eligible, false);
  pass('qualification requires exact independent native PASS; synthetic case cannot enable enforce or inflate count');
  write('defect.mjs', 'export const broken = false;\n'); git('add', 'defect.mjs'); git('commit', '-m', 'fix controlled defect');
  assert.throws(() => readCurrentFindingRuntimeEvidence(ctx, storyId, red.runtimeReceiptId), /stale/);
  assert.notEqual(readFindingValidationPreview(store, root, storyId).digest, preview.digest);
  assertFindingValidationConstraintsCurrent(store, root, constraints); pass('material drift invalidates runtime and shadow proposal, but warn never changes validation gates');
  const green = runtimeHandlers.finding_runtime_evidence_run({ ...runtimeArgs, idempotencyKey: 'repair-green' });
  assert.equal(green.receipt.exitCode, 0);
  const mandatory = (batch.manifest.entries as Array<{ mandatoryRepairId: string }>)[0]!.mandatoryRepairId;
  assert.throws(() => handlers.finding_mandatory_repair_close({ storyId, findingId, idempotencyKey: 'old-classification',
    classificationId: (assessment as { mandatoryRepair: { classificationId: string } }).mandatoryRepair.classificationId,
    rootCause: 'The controlled fixture exported the incorrect boolean.', repairCommit: git('rev-parse', 'HEAD'), closureEvidenceRefs: [red.runtimeReceiptId, green.runtimeReceiptId] }), /latest signed/);
  pass('an older repair classification cannot close a newer obligation');
  const closure = handlers.finding_mandatory_repair_close({ storyId, findingId, idempotencyKey: 'close-once', classificationId: mandatory,
    rootCause: 'The controlled fixture exported the incorrect boolean.', repairCommit: git('rev-parse', 'HEAD'), closureEvidenceRefs: [red.runtimeReceiptId, green.runtimeReceiptId] });
  assert.equal(closure.mandatoryRepair.state, 'closure_proven');
  assert.equal(handlers.finding_triage({ storyId }).rows[0]!.decision.reason, 'complete_repair_closure'); pass('actual same-command RED to GREEN closes latest mandatory obligation');
  git('commit', '--allow-empty', '-m', 'record metadata only');
  assert.equal(handlers.finding_triage({ storyId }).rows[0]!.decision.reason, 'complete_repair_closure');
  pass('metadata-only commit preserves current material repair closure');
  console.log(`DYNAMIC_FINDING_RUNTIME_INTEGRATION PASS ${assertions}`);
} finally { process.chdir(beforeCwd); rmSync(root, { recursive: true, force: true }); }
