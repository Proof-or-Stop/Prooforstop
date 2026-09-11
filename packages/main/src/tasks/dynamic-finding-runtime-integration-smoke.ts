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
import { createFindingLedgerHandlers, appendFindingLedger, findingLedgerSignerFromWorkspace, readCurrentFindingRuntimeEvidence, setRuntimeEvidenceKeyStatusForTest } from '../handlers/finding-ledger.js';
import { createFindingApplicabilityHandlers } from '../handlers/finding-applicability.js';
import { seedCurrentReviewFixture, bindCurrentFixtureFinding } from './current-review-fixture.js';
import { nativeReviewFixtureBrokers, withNativeReviewFixtureHostIdentity, runBrokeredNativeReviewCli } from './native-review-fixture.js';
import { FINDING_PROTECTED_SURFACES } from '../core/finding-applicability.js';
import { readFindingValidationConstraints, readFindingValidationPreview, assertFindingValidationConstraintsCurrent } from '../core/finding-validation.js';
import { RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY } from '../core/evidence/artifact-store.js';
import { FINDING_QUALIFICATION_METRICS, FINDING_QUALIFICATION_POLICY } from '../core/finding-rollout-qualification.js';
import { runIsolatedFindingFixture } from './isolated-finding-fixture.js';
import { findingQualificationWorkflowQuery } from '../handlers/finding-qualification-events.js';
import { collectQualificationSubjectAdjudications } from '../handlers/finding-qualification-adjudication.js';
import { collectQualificationPrerequisites, verifyQualificationPrerequisites } from '../handlers/finding-qualification-prerequisites.js';

if (await runIsolatedFindingFixture(import.meta.url)) process.exit(0);
const prerequisiteAudit = process.argv.includes('--prerequisite-proof');

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-dfec-runtime-'));
const beforeCwd = process.cwd();
const oldPrerequisiteRefs = process.env.FINDING_PREREQUISITE_REFS;
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
    requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' }, dynamicFinding: { mode: 'warn', ...(prerequisiteAudit ? { qualificationStoryIds: [storyId] } : {}) },
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
  write('prerequisite.mjs', `import assert from 'node:assert/strict';
import {isDynamicFindingBlocking} from ${JSON.stringify(new URL('../core/finding-applicability.js', import.meta.url).href)};
const decision=isDynamicFindingBlocking({finding:{status:'open',evidenceState:'verified',severity:'high'},mode:'enforce',round:3,effectiveBlockingSeverities:['critical','high']});
console.log('FINDING_PREREQUISITE '+process.argv[2]+' '+process.argv[3]);
assert.equal(decision.blocking,process.argv[4]!=='negative');`);
  write('qualification.mjs', `import {execFileSync} from 'node:child_process';
import {StoryStore} from ${JSON.stringify(new URL('../core/store.js', import.meta.url).href)};
import {exactLedgerRecordHash} from ${JSON.stringify(new URL('../handlers/finding-ledger.js', import.meta.url).href)};
const entry=new StoryStore(process.cwd()).readFindingLedger(${JSON.stringify(storyId)}).records.filter(row=>row.recordType==='finding_applicability_assessment').at(-1);const source=entry.payload;
console.log('FINDING_QUALIFICATION '+JSON.stringify({schemaVersion:${JSON.stringify(FINDING_QUALIFICATION_POLICY.version)},assessmentId:source.assessmentId,
population:'adversarial',storyClass:'isolated-fixture',detectorVersion:'fixture-v1',retryPolicy:'No retries',exclusions:[],
timingSeconds:{classifier:0,triage:0,repair:0,convergence:0},prerequisites:${prerequisiteAudit ? "JSON.parse(process.env.FINDING_PREREQUISITE_REFS??'null')??[{name:'dependency_mutation_suite',mergedCommit:execFileSync('git',['rev-parse','main'],{encoding:'utf8'}).trim()}]" : '[]'},simpleStoryRegression:null,timeoutRate:0,latencyCorpusSize:1,candidateBaselineExplained:true,
subjectAdjudications:[{ref:{storyId:${JSON.stringify(storyId)},recordId:entry.recordId,recordHash:exactLedgerRecordHash(entry)},
expected:{kind:'finding_applicability_assessment',findingId:${JSON.stringify(findingId)},verdict:'applicable',dispositionPlan:'repair_current',gateImpact:'blocks'},
rationale:'The independent fixture oracle requires repair because the controlled broken export reproduces and blocks its accepted result.'}],
measurements:${JSON.stringify(FINDING_QUALIFICATION_METRICS.map(([metric, comparison]) => ({ metric, numerator: comparison === 'max' ? 0 : 1, denominator: 1, latencySeconds: 1 })))} }));`);
  git('init', '-b', 'main'); git('config', 'user.name', 'Isolated DFEC Test'); git('config', 'user.email', 'dfec@example.invalid');
  git('add', '.'); git('commit', '-m', 'fixture baseline'); git('checkout', '-b', `story/${storyId}`); resetConfigCache(); process.chdir(root);
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
  const clock = findingQualificationWorkflowQuery(ctx, storyId);
  assert.equal(clock.timing.length, 1); assert.equal(clock.timing[0]!.outcome, 'signed');
  assert.equal(clock.timing[0]!.candidateCount, 1); assert.ok(clock.timing[0]!.durationMs! >= 0);
  assert.equal(clock.operations.filter(row => row.operation === 'append_assessment_proposal').length, 1);
  assert.equal(clock.operations.filter(row => row.operation === 'apply_manifest').length, 0);
  pass('server monotonic clock freezes actual population and excludes timing records from workflow savings');
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
  if (prerequisiteAudit) {
    const before = store.readFindingLedger(storyId).committedLedgerDigest;
    assert.throws(() => withNativeReviewFixtureHostIdentity({ agent: independent, invoke: () => handlers.finding_qualification_record(qualifierArgs) }),
      /qualification: prerequisite/, 'unrelated ancestor without a capability receipt must refuse');
    assert.equal(store.readFindingLedger(storyId).committedLedgerDigest, before);
    console.log('QUALIFICATION_PREREQUISITE PASS ancestry alone is not proof');
    // Add reviewed fixture pins before the new independent review. This is
    // disposable fixture setup, not a mutation of a real Story's frozen intent.
    const head = git('rev-parse', 'HEAD'); const name = 'dependency_mutation_suite';
    const checklist = store.readChecklist(storyId);
    checklist.items[0]!.verificationIntent!.adversarial = ['positive', 'negative'].map(scenario => ({
      desc: 'Execute the real fail-closed property and its negative control.', type: 'cli',
      verification: { command: `${process.execPath} prerequisite.mjs ${name} ${head} ${scenario}`,
        selector: `FINDING_PREREQUISITE ${name} ${head}` } }));
    store.writeChecklist(storyId, checklist);
    const runPrerequisite = (scenario: string) => runtimeHandlers.finding_runtime_evidence_run({ ...runtimeArgs,
      idempotencyKey: `prerequisite-${scenario}`, executionCommand: { executable: process.execPath, args: ['prerequisite.mjs', name, head, scenario], cwd: '.' } });
    const proof = runPrerequisite('positive'); const failed = runPrerequisite('negative');
    assert.equal(proof.receipt.exitCode, 0); assert.equal(failed.receipt.exitCode, 1);
    const ref = { name, mergedCommit: head, runtimeReceiptId: proof.runtimeReceiptId };
    const collected = collectQualificationPrerequisites(ctx, storyId, [ref], measured.runtimeReceiptId);
    verifyQualificationPrerequisites(ctx, storyId, collected);
    assert.throws(() => collectQualificationPrerequisites(ctx, storyId, [ref, ref], measured.runtimeReceiptId), /duplicated/);
    assert.throws(() => collectQualificationPrerequisites(ctx, storyId, [ref], proof.runtimeReceiptId), /invalid/);
    assert.throws(() => collectQualificationPrerequisites(ctx, storyId, [{ ...ref, name: 'targeted_adversarial_suite' }], measured.runtimeReceiptId), /selector/);
    assert.throws(() => collectQualificationPrerequisites(ctx, storyId, [{ ...ref, runtimeReceiptId: failed.runtimeReceiptId }], measured.runtimeReceiptId), /execution/);
    assert.throws(() => verifyQualificationPrerequisites(ctx, storyId, { [name]: { ...collected[name]!, proof: { ...collected[name]!.proof, runtimeReceiptHash: 'f'.repeat(64) } } }), /substituted/);
    console.log('QUALIFICATION_PREREQUISITE PASS 6 receipt and negative-control checks');
    process.env.FINDING_PREREQUISITE_REFS = JSON.stringify([ref]);
    const report = runtimeHandlers.finding_runtime_evidence_run({ ...runtimeArgs, idempotencyKey: 'qualification-with-proof',
      executionCommand: { executable: process.execPath, args: ['qualification.mjs'], cwd: '.' }, environmentAllowlist: ['FINDING_PREREQUISITE_REFS'] });
    const auditedRun = seedCurrentReviewFixture(root, store, storyId, [independent]).get(independent)!;
    await runBrokeredNativeReviewCli({ root, store, storyId, agent: independent, reviewRunId: auditedRun,
      command: 'review_pass_set', payload: { storyId, agent: independent, reviewRunId: auditedRun,
        readManifest: { filesReadFully: ['qualification.mjs', 'prerequisite.mjs'], filesTriagedByName: [], scanEscalationReason: null },
        note: `Independent review of the prerequisite assertion, negative control and exact receipt reference.\nfinding-qualification:${qualifierArgs.assessmentId}:${report.runtimeReceiptId}:${report.receipt.receiptHash}` } });
    withNativeReviewFixtureHostIdentity({ agent: independent, invoke: () => handlers.finding_qualification_record({ ...qualifierArgs,
      runtimeReceiptId: report.runtimeReceiptId, reviewRunId: auditedRun, idempotencyKey: 'qualified-with-proof' }) });
    const qualifiedRows = handlers.finding_qualification_query({ storyId }).rows;
    assert.equal(qualifiedRows.length, 1); assert.equal(qualifiedRows[0]!.payload.prerequisites[name]!.proof.runtimeReceiptId, proof.runtimeReceiptId);
    console.log('QUALIFICATION_PREREQUISITE PASS official signed write and historical query retain executed proof');
    const incompleteScorecard = handlers.finding_rollout_scorecard({ storyId }).qualification;
    assert.equal(incompleteScorecard.rows.find(row => row.metric === 'scorecard_completeness')!.denominator, 1,
      'missing performance cohort must retain independent subject denominator');
    assert.ok(incompleteScorecard.metadata);
    assert.ok(incompleteScorecard.refusalReasons.includes('qualification_timing_sources_missing'));
    assert.equal(incompleteScorecard.qualification.eligible, false);
    console.log('QUALIFICATION_PREREQUISITE PASS incomplete timing retains 22 diagnostic rows and independent subject denominator=1');
    setRuntimeEvidenceKeyStatusForTest(root, 'revoked');
    assert.throws(() => handlers.finding_qualification_query({ storyId }), /revoked_signing_key/);
    console.log('QUALIFICATION_PREREQUISITE PASS revoked runtime trust refuses historical qualification');
  } else {
  const qualified = withNativeReviewFixtureHostIdentity({ agent: independent, invoke: () => handlers.finding_qualification_record(qualifierArgs) });
  assert.ok(qualified); assert.equal(handlers.finding_qualification_query({ storyId }).rows.length, 1);
  const measuredCase = handlers.finding_qualification_query({ storyId }).rows[0]!.payload;
  assert.equal(measuredCase.measurementAuthority, 'reported_statistics_non_qualifying');
  assert.equal(measuredCase.measurements.length, 22);
  assert.equal(measuredCase.timingSeconds, null); assert.equal(measuredCase.timeoutRate, null); assert.equal(measuredCase.latencyCorpusSize, 0);
  assert.equal(measuredCase.queryMeasurements.length, 1);
  assert.equal(measuredCase.queryMeasurements[0]!.metric, 'scorecard_completeness');
  assert.equal(measuredCase.queryMeasurements[0]!.numerator, 1);
  assert.equal(measuredCase.subjectAdjudications[0]!.correct, true);
  assert.equal(measuredCase.publicQueries.ledger.signedRows, true);
  pass('22 self-reported rates remain diagnostic; only one exact independent subject receives a denominator');
  const subject = measuredCase.subjectAdjudications[0]!;
  assert.equal(collectQualificationSubjectAdjudications(ctx, [{ ...subject, expected: { ...subject.expected, gateImpact: 'does_not_block' } }], independent)[0]!.correct, false);
  assert.throws(() => collectQualificationSubjectAdjudications(ctx, [{ ...subject, expected: { kind: 'finding_applicability_assessment' } }], independent), /dimension/);
  assert.throws(() => collectQualificationSubjectAdjudications(ctx, [{ ...subject, ref: { ...subject.ref, recordHash: 'f'.repeat(64) } }], independent), /substituted/);
  assert.throws(() => collectQualificationSubjectAdjudications(ctx, [subject, subject], independent), /duplicate/);
  assert.throws(() => collectQualificationSubjectAdjudications(ctx, [subject], agent), /self-adjudicate/);
  pass('per-subject independent gold mismatch is failure; omitted substituted and duplicate subjects refuse');
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
  const metadataNote = `.proof-or-stop/story/actives/${storyId}/metadata-only-test.md`;
  write(metadataNote, 'Disposable fixture audit note, no material source change.\n');
  git('add', '--force', metadataNote); git('commit', '-m', 'record metadata only');
  assert.equal(handlers.finding_triage({ storyId }).rows[0]!.decision.reason, 'complete_repair_closure');
  pass('metadata-only commit preserves current material repair closure');
  write('build/defect.mjs', 'export const broken = true; // corrupted artifact after closure\n');
  assert.notEqual(handlers.finding_triage({ storyId }).rows[0]!.decision.reason, 'complete_repair_closure');
  pass('post-closure runtime artifact corruption cannot retain closure authority');
  write('build/defect.mjs', 'export const broken = false;\n');
  assert.equal(handlers.finding_triage({ storyId }).rows[0]!.decision.reason, 'complete_repair_closure');
  setRuntimeEvidenceKeyStatusForTest(root, 'revoked');
  assert.notEqual(handlers.finding_triage({ storyId }).rows[0]!.decision.reason, 'complete_repair_closure');
  pass('runtime key revocation reopens closure; metadata reuse never waives runtime trust');
  console.log(`DYNAMIC_FINDING_RUNTIME_INTEGRATION PASS ${assertions}`);
  }
} finally {
  if (oldPrerequisiteRefs === undefined) delete process.env.FINDING_PREREQUISITE_REFS; else process.env.FINDING_PREREQUISITE_REFS = oldPrerequisiteRefs;
  process.chdir(beforeCwd); rmSync(root, { recursive: true, force: true });
}
