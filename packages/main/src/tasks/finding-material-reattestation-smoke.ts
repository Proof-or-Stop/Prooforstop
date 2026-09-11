/** Disposable, real linked-worktree/runtime/native-review re-attestation test.
 * Fixture setup is not operational qualification or formal Story completion. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import { acquireOwnerLease } from '../core/story-owner-lease.js';
import { resetSessionIdForTest } from '../core/owner-session.js';
import { withMkdirLock, captureMkdirLockFence } from '../core/mkdir-lock.js';
import { createFindingLedgerHandlers, appendFindingLedger, findingLedgerSignerFromWorkspace, exactLedgerRecordHash } from '../handlers/finding-ledger.js';
import { createFindingApplicabilityHandlers } from '../handlers/finding-applicability.js';
import { createFindingRouteHandlers } from '../handlers/finding-route.js';
import { buildConfirmedCanonicalDefect, signIdentityEnvelope, validateCanonicalDefect } from '../core/finding-identity.js';
import { applicabilityDigest, FINDING_PROTECTED_SURFACES } from '../core/finding-applicability.js';
import { currentApplicabilityContext } from '../core/finding-applicability-projection.js';
import { prepareMaterialDriftReattestation, readMaterialDriftReattestation } from '../handlers/finding-material-reattestation.js';
import { seedCurrentReviewFixture, bindCurrentFixtureFinding } from './current-review-fixture.js';
import { nativeReviewFixtureBrokers, withNativeReviewFixtureHostIdentity, runBrokeredNativeReviewCli } from './native-review-fixture.js';
import { RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY } from '../core/evidence/artifact-store.js';
import { runIsolatedFindingFixture } from './isolated-finding-fixture.js';
import { collectFindingQualificationEvents } from '../handlers/finding-qualification-events.js';

if (await runIsolatedFindingFixture(import.meta.url)) process.exit(0);
const sandbox = mkdtempSync(join(tmpdir(), 'proof-or-stop-reattest-'));
const root = join(sandbox, 'source'); const targetRoot = join(sandbox, 'target'); mkdirSync(root);
const oldCwd = process.cwd(); const oldEnv = { ...process.env };
const gitAt = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const git = (...args: string[]) => gitAt(root, ...args);
const write = (path: string, text: string) => writeFileSync(join(root, path), text);
const headContinuity = process.argv.includes('--head-continuity');
let count = 0; const pass = (name: string) => { count++; console.log(`MATERIAL_REATTEST ${name} PASS`); };
try {
  const storyId = 'B-RETEST'; const targetId = 'B-TARGET'; const findingId = `${storyId}:F-001`;
  const agent = 'proof-or-stop-review-concept'; const reviewer = 'proof-or-stop-review-quality';
  const round = new Date().toISOString(); const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const command = `${process.execPath} witness.mjs`;
  const surfaces = FINDING_PROTECTED_SURFACES.map(surface => ({ surface, state: 'clear' as const, evidenceRefs: ['CHK-001:happy:0'] }));
  write('proof-or-stop.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' }, dynamicFinding: { mode: 'warn' },
    nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() } }));
  write('.gitignore', '.proof-or-stop/\nbuild/\n');
  write('defect.mjs', 'export const broken = true;\n');
  write('build.mjs', "import {mkdirSync,copyFileSync} from 'node:fs'; mkdirSync('build',{recursive:true}); copyFileSync('defect.mjs','build/defect.mjs');");
  write('witness.mjs', `import {broken} from './build/defect.mjs';
import {StoryStore} from ${JSON.stringify(new URL('../core/store.js', import.meta.url).href)};
import {currentApplicabilityContext} from ${JSON.stringify(new URL('../core/finding-applicability-projection.js', import.meta.url).href)};
const c=currentApplicabilityContext(new StoryStore(process.cwd()),process.cwd(),${JSON.stringify(storyId)});
console.log('FINDING_WITNESS '+JSON.stringify({schemaVersion:'proof-or-stop.finding-witness.v1',storyId:${JSON.stringify(storyId)},findingId:${JSON.stringify(findingId)},
baseHash:c.baseHash,headHash:c.headHash,scopeDigest:c.scopeDigest,acceptanceDigest:c.acceptanceDigest,evaluationScope:'target_story',
verdict:'applicable',reproduced:broken,baseReproduced:broken,introducedByCurrentStory:false,gateImpact:'does_not_block',affectedPaths:['defect.mjs'],
checkedIntentRefs:['CHK-001:happy:0'],protectedSurfaceEvaluation:${JSON.stringify(surfaces)}}));process.exitCode=broken?1:0;`);
  git('init', '-b', 'main'); git('config', 'user.name', 'Isolated Reattestation Test'); git('config', 'user.email', 'reattest@example.invalid');
  git('add', '.'); git('commit', '-m', 'fixture baseline'); git('worktree', 'add', '-b', `story/${targetId}`, targetRoot);
  git('checkout', '-b', `story/${storyId}`); process.chdir(root); resetConfigCache();
  const store = new StoryStore(root); const targetStore = new StoryStore(targetRoot);
  const ctx = { root, store, scanRoot: join(root, 'packages/main') };
  const targetCtx = { root: targetRoot, store: targetStore, scanRoot: join(targetRoot, 'packages/main') };
  const story = { storyId, name: 'retest', title: 'Reattest unrelated merged material', description: 'Disposable integration fixture.', type: 'feature' as const,
    priority: 'low' as const, phase: 'REVIEW' as const, createdAt: round, startedAt: round, endedAt: null, currentReviewRound: round, events: [] };
  const targetStory = { ...story, storyId: targetId, name: 'target', phase: 'DEV' as const,
    worktree: { path: targetRoot, branch: `story/${targetId}`, createdAt: round } };
  for (const s of [store, targetStore]) { s.writeStory(storyId, story); s.writeStory(targetId, targetStory); }
  store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'Inspect deferred regression', context: 'Unrelated current acceptance', status: 'done', startTime: round, endTime: round,
    verificationIntent: { happy: [{ desc: 'Execute checked witness', type: 'cli', verification: { command, selector: 'FINDING_WITNESS' } }], edge: [], adversarial: [] } }] });
  targetStore.writeChecklist(targetId, { items: [{ id: 'CHK-001', title: 'Repair deferred behavior', context: 'Traceable responsibility', status: 'pending', startTime: null, endTime: null,
    files: { modify: ['defect.mjs'], create: [], test: [] }, verificationIntent: { happy: [{ desc: 'Repair broken export', type: 'cli', priority: 'must' }], edge: [], adversarial: [] } }] });
  const runs = seedCurrentReviewFixture(root, store, storyId, [agent]);
  const finding = bindCurrentFixtureFinding({ id: findingId, desc: 'The deferred behavior reproduces independently of current acceptance.', severity: 'low', category: 'edge', status: 'open', evidenceState: 'verified',
    files: ['defect.mjs'], agent, createdAt: round, reviewRound: round, reviewRunId: runs.get(agent)! });
  const signer = findingLedgerSignerFromWorkspace(root);
  const appendFixture = (operation: 'append_finding' | 'append_canonical_defect', key: string, recordType: string, payload: unknown) => {
    const lock = store.runtimeLockDirPath(storyId, 'finding', 'findings');
    return withMkdirLock(lock, () => { const fence = captureMkdirLockFence(lock); return appendFindingLedger({ storyId, store, operation, idempotencyKey: key,
      records: [{ recordType, payload: payload as never }], writerSessionId: 'fixture', writerLeaseId: 'fixture', writerFenceToken: fence.writerFenceToken, fence, signer }); }, { requireHolderToken: true });
  };
  appendFixture('append_finding', 'source', 'finding', finding);
  const findingRecord = store.readFindingLedger(storyId).records.at(-1)!;
  const findingRef = { storyId, findingId, recordId: findingRecord.recordId, recordHash: exactLedgerRecordHash(findingRecord) };
  const canonical = buildConfirmedCanonicalDefect({ storyId, idempotencyKey: 'canonical', title: 'Controlled defect', triggerCondition: 'Read broken export', reproduction: 'broken is true',
    rootCauseState: 'unknown', identityEvidenceRefs: [applicabilityDigest('fixture independent reproduction')], evidenceAnchors: [{ path: 'defect.mjs', contentDigest: applicabilityDigest('export'), line: 1 }],
    affectedSymbols: ['broken'], affectedContracts: ['correct export'], memberFindingRefs: [findingRef], canonicalFindingRef: findingRef, reviewRunId: runs.get(agent)! },
    { canonicalDefectId: 'CD-RETEST', confirmedBy: agent, confirmedAt: round, sourceLineageKeys: [applicabilityDigest(findingRef)] });
  appendFixture('append_canonical_defect', 'canonical', 'canonical_defect', signIdentityEnvelope({ kind: 'canonical_defect', storyId, requestDigest: applicabilityDigest(canonical), producedAt: round, payload: canonical }, signer, validateCanonicalDefect));
  const canonicalRecord = store.readFindingLedger(storyId).records.at(-1)!;
  const runtime = createFindingLedgerHandlers(ctx); const handlers = createFindingApplicabilityHandlers(ctx);
  const runtimeArgs = { storyId, buildCommand: { executable: process.execPath, args: ['build.mjs'], cwd: '.' }, executionCommand: { executable: process.execPath, args: ['witness.mjs'], cwd: '.' },
    artifactPaths: ['build/defect.mjs'], environmentAllowlist: [], compilerVersion: 'fixture-js-v1', timeoutMs: 30000, storageCapability: RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY };
  const old = runtime.finding_runtime_evidence_run({ ...runtimeArgs, idempotencyKey: 'old' });
  const proposed = withNativeReviewFixtureHostIdentity({ agent, invoke: () => handlers.finding_assessment_propose({ storyId, findingId, idempotencyKey: 'proposal', proposal: {
    verdict: 'applicable', basis: 'direct_scope', owner: 'current_story', evaluationScope: 'target_story', currentWitness: { reproduced: true, receiptIds: [old.runtimeReceiptId] },
    runtimeReceiptIds: [old.runtimeReceiptId], protectedSurfaceEvaluation: surfaces, expiresAt } }) });
  process.chdir(targetRoot); process.env.PROOF_OR_STOP_SESSION_ID = 'target-fixture'; process.env.PROOF_OR_STOP_AGENT = 'main';
  process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER = 'codex'; resetSessionIdForTest();
  acquireOwnerLease(targetStore.storyDirPath(targetId), { command: 'fixture consent', cwd: targetRoot });
  const accepted = createFindingRouteHandlers(targetCtx).finding_route_accept({ storyId: targetId, idempotencyKey: 'consent', source: proposed.proposalRef, targetItemId: 'CHK-001',
    canonicalDefect: { storyId, recordId: canonicalRecord.recordId, recordHash: exactLedgerRecordHash(canonicalRecord) },
    subject: { sourcePaths: ['defect.mjs'], targetChecklistItemRefs: ['CHK-001'], targetAcceptanceRefs: [], affectedContractRefs: ['CHK-001:happy:0'],
      command: { executable: process.execPath, args: ['witness.mjs'], selector: 'FINDING_WITNESS' } }, expiresAt });
  const consent = accepted.rows.find(row => row.envelope.kind === 'route_receipt')!;
  process.chdir(root); process.env.PROOF_OR_STOP_SESSION_ID = 'source-fixture'; resetSessionIdForTest();
  const assessment = handlers.finding_applicability_assess({ storyId, findingId, idempotencyKey: 'assessment', verdict: 'applicable', proofStrength: 'strong',
    dispositionPlan: 'defer_with_proof', gateImpact: 'does_not_block', proposalRef: proposed.proposalRef as never,
    evidenceRefs: [old.runtimeReceiptId], recheckTriggers: ['expired', 'owner_invalid'],
    route: { storyId: targetId, receipt: { storyId: targetId, recordId: consent.record.recordId, recordHash: exactLedgerRecordHash(consent.record) } } });
  handlers.finding_deferral_record({ storyId, findingId, idempotencyKey: 'deferral', assessmentId: assessment.assessment.assessmentId! });
  assert.equal(handlers.finding_triage({ storyId }).rows[0]!.decision.dynamicBlocking, false); pass('real signed initial deferral releases shadow gate');
  const gold = collectFindingQualificationEvents(ctx, { storyId, findingId, caseId: 'isolated-deferral-gold', severity: 'low', observedAt: new Date().toISOString(),
    experiments: [], reportReceiptId: 'not-a-measurement-report', population: 'adversarial', gold: { applicable: true, eligibleDeferral: true, ownerStoryId: targetId } });
  assert.equal(gold.measurements.find(row => row.metric === 'nonblocking_precision')?.numerator, 1);
  assert.equal(gold.measurements.find(row => row.metric === 'false_deferral')?.numerator, 0);
  pass('independently eligible deferral is not a nonblocking precision error');
  if (headContinuity) {
    const before = currentApplicabilityContext(store, root, storyId, [old.runtimeReceiptId]);
    git('add', '-f', `.proof-or-stop/story/actives/${storyId}`); git('commit', '-m', 'persist original signed finding evidence');
    const after = currentApplicabilityContext(store, root, storyId, [old.runtimeReceiptId]);
    assert.notEqual(after.headHash, before.headHash);
    assert.deepEqual({ ...after, headHash: before.headHash }, before, 'only HEAD changes after committing process evidence');
    console.log('HEAD_CONTINUITY context headChanged=true materialChanged=false storyFilesChanged=false baseChanged=false scopeChanged=false acceptanceChanged=false runtimeChanged=false');
  } else {
    mkdirSync(join(root, 'docs/audits'), { recursive: true }); write('docs/audits/unrelated.md', 'An unrelated audit note.\n');
    git('add', 'docs/audits/unrelated.md'); git('commit', '-m', 'unrelated main audit'); git('branch', '-f', 'main', 'HEAD');
  }
  assert.equal(handlers.finding_triage({ storyId }).rows[0]!.decision.dynamicBlocking, true); pass('raw unproven drift remains blocked');
  const fresh = runtime.finding_runtime_evidence_run({ ...runtimeArgs, idempotencyKey: 'fresh' });
  const input = { storyId, assessmentId: assessment.assessment.assessmentId!, runtimeReceiptIds: [fresh.runtimeReceiptId], idempotencyKey: 'retest' };
  const reviewRunId = seedCurrentReviewFixture(root, store, storyId, [reviewer]).get(reviewer)!;
  let marker = '';
  try { withNativeReviewFixtureHostIdentity({ agent: reviewer, invoke: () => prepareMaterialDriftReattestation(ctx, input) }); }
  catch (error) {
    marker = String(error).match(/finding-reattest:[^\s]+/)?.[0] ?? '';
    if (!marker && headContinuity) assert.fail(`HEAD_CONTINUITY fresh equivalent execution must reach independent-review binding, not permanent drift refusal: ${String(error)}`);
    if (!marker) throw error;
  }
  assert.ok(marker); pass('fresh executions alone cannot self-attest');
  await runBrokeredNativeReviewCli({ root, store, storyId, agent: reviewer, reviewRunId, command: 'review_pass_set', payload: { storyId, agent: reviewer, reviewRunId,
    readManifest: { filesReadFully: headContinuity ? ['witness.mjs'] : ['witness.mjs', 'docs/audits/unrelated.md'], filesTriagedByName: [], scanEscalationReason: null }, note: `Independent bounded-drift audit.\n${marker}` } });
  const result = withNativeReviewFixtureHostIdentity({ agent: reviewer, invoke: () => handlers.finding_material_reattest(input) });
  assert.equal(result.replayed, false); assert.equal(readMaterialDriftReattestation(ctx, storyId, proposed.proposalRef.recordId)?.materialDriftState, 'unrelated_re_attested');
  assert.equal(handlers.finding_triage({ storyId }).rows[0]!.decision.dynamicBlocking, false); pass('fresh runtime plus independent signed dependencies restores valid deferral');
  if (headContinuity) console.log('HEAD_CONTINUITY restored=true oldAssessmentPreserved=true freshExecutionRequired=true independentReviewRequired=true');
  assert.equal(withNativeReviewFixtureHostIdentity({ agent: reviewer, invoke: () => handlers.finding_material_reattest(input) }).replayed, true); pass('replay does not append');
  assert.throws(() => withNativeReviewFixtureHostIdentity({ agent, invoke: () => prepareMaterialDriftReattestation(ctx, input) }), /self-adjudicate/); pass('observer cannot self-adjudicate');
  git('add', '-f', `.proof-or-stop/story/actives/${storyId}`); git('commit', '-m', 'persist fixture process evidence only');
  assert.equal(handlers.finding_triage({ storyId }).rows[0]!.decision.dynamicBlocking, false); pass('metadata-only evidence commit reuses exact material-bound execution');
  write('unclassified-input', 'unknown dependency\n'); git('add', 'unclassified-input'); git('commit', '-m', 'unknown dependency'); git('branch', '-f', 'main', 'HEAD');
  assert.equal(handlers.finding_triage({ storyId }).rows[0]!.decision.dynamicBlocking, true);
  assert.throws(() => withNativeReviewFixtureHostIdentity({ agent: reviewer, invoke: () => prepareMaterialDriftReattestation(ctx, input) }), /dependency changed/); pass('unknown extensionless dependency refuses release');
  console.log(`MATERIAL_REATTEST PASS ${count}`);
} finally {
  process.chdir(oldCwd); for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]; Object.assign(process.env, oldEnv); resetSessionIdForTest();
  rmSync(sandbox, { recursive: true, force: true });
}
