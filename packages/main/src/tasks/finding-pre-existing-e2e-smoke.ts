/** Disposable, real linked-worktree/runtime/native-review historical acceptance.
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
import { seedCurrentReviewFixture, bindCurrentFixtureFinding } from './current-review-fixture.js';
import { nativeReviewFixtureBrokers, withNativeReviewFixtureHostIdentity } from './native-review-fixture.js';
import { RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY } from '../core/evidence/artifact-store.js';
import { runIsolatedFindingFixture } from './isolated-finding-fixture.js';

if (await runIsolatedFindingFixture(import.meta.url)) process.exit(0);
const sandbox = mkdtempSync(join(tmpdir(), 'proof-or-stop-pre-existing-'));
const root = join(sandbox, 'source'); const targetRoot = join(sandbox, 'target'); mkdirSync(root);
const oldCwd = process.cwd(); const oldEnv = { ...process.env };
const gitAt = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const git = (...args: string[]) => gitAt(root, ...args);
const write = (path: string, text: string) => writeFileSync(join(root, path), text);
let count = 0; const pass = (name: string) => { count++; console.log(`PRE_EXISTING_E2E ${name} PASS`); };
try {
  const storyId = 'B-RETEST'; const targetId = 'B-TARGET'; const findingId = `${storyId}:F-001`;
  const agent = 'proof-or-stop-review-concept';
  const round = new Date().toISOString(); const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const command = `${process.execPath} witness.mjs`;
  const surfaces = FINDING_PROTECTED_SURFACES.map(surface => ({ surface, state: 'clear' as const, evidenceRefs: ['CHK-001:happy:0'] }));
  write('proof-or-stop.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' }, dynamicFinding: { mode: 'warn' },
    nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() } }));
  write('.gitignore', '.proof-or-stop/\nbuild/\n');
  write('defect.mjs', 'export const broken = true;\n');
  write('build.mjs', "import {mkdirSync,copyFileSync} from 'node:fs'; mkdirSync('build',{recursive:true}); copyFileSync('defect.mjs','build/defect.mjs');");
  write('witness.mjs', `import {execFileSync} from 'node:child_process';\nimport {broken} from './build/defect.mjs';
const c=JSON.parse(process.env.FINDING_E2E_CONTEXT);
console.log('FINDING_WITNESS '+JSON.stringify({schemaVersion:'proof-or-stop.finding-witness.v1',storyId:${JSON.stringify(storyId)},findingId:${JSON.stringify(findingId)},
baseHash:c.baseHash,headHash:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scopeDigest:c.scopeDigest,acceptanceDigest:c.acceptanceDigest,evaluationScope:'target_story',
verdict:'pre_existing_unaffected',failureFingerprint:'controlled-defect',impactVector:{failures:Number(broken)},reproduced:broken,baseReproduced:broken,introducedByCurrentStory:false,gateImpact:'does_not_block',affectedPaths:['defect.mjs'],
checkedIntentRefs:['CHK-001:happy:0'],protectedSurfaceEvaluation:${JSON.stringify(surfaces)}}));process.exitCode=broken?1:0;`);
  git('init', '-b', 'main'); git('config', 'user.name', 'Isolated Reattestation Test'); git('config', 'user.email', 'reattest@example.invalid');
  git('add', '.'); git('commit', '-m', 'fixture baseline'); git('worktree', 'add', '-b', `story/${targetId}`, targetRoot);
  git('checkout', '-b', `story/${storyId}`); write('current.txt', 'Current Story changes an unrelated feature.\n'); git('add', 'current.txt'); git('commit', '-m', 'current unrelated feature'); process.chdir(root); resetConfigCache();
  const store = new StoryStore(root); const targetStore = new StoryStore(targetRoot);
  const ctx = { root, store, scanRoot: join(root, 'packages/main') };
  const targetCtx = { root: targetRoot, store: targetStore, scanRoot: join(targetRoot, 'packages/main') };
  const story = { storyId, name: 'pre-existing', title: 'Accept an unaffected historical defect with target consent', description: 'Disposable integration fixture.', type: 'feature' as const,
    priority: 'low' as const, phase: 'REVIEW' as const, createdAt: round, startedAt: round, endedAt: null, currentReviewRound: round, events: [] };
  const targetStory = { ...story, storyId: targetId, name: 'target', phase: 'DEV' as const,
    worktree: { path: targetRoot, branch: `story/${targetId}`, createdAt: round } };
  for (const s of [store, targetStore]) { s.writeStory(storyId, story); s.writeStory(targetId, targetStory); }
  store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'Inspect deferred regression', context: 'Unrelated current acceptance', status: 'done', startTime: round, endTime: round,
    verificationIntent: { happy: [{ desc: 'Execute checked witness', type: 'cli', verification: { command, selector: 'FINDING_WITNESS' } }], edge: [], adversarial: [] } }] });
  targetStore.writeChecklist(targetId, { items: [{ id: 'CHK-001', title: 'Repair deferred behavior', context: 'Traceable responsibility', status: 'pending', startTime: null, endTime: null,
    files: { modify: ['defect.mjs'], create: [], test: [] }, verificationIntent: { happy: [{ desc: 'Repair broken export', type: 'cli', priority: 'must' }], edge: [], adversarial: [] } }] });
  const runs = seedCurrentReviewFixture(root, store, storyId, [agent]);
  const finding = bindCurrentFixtureFinding({ id: findingId, desc: 'The deferred behavior reproduces independently of current acceptance.', severity: 'high', category: 'edge', status: 'open', evidenceState: 'verified',
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
    artifactPaths: ['build/defect.mjs'], environmentAllowlist: ['FINDING_E2E_CONTEXT'], compilerVersion: 'fixture-js-v1', timeoutMs: 30000, storageCapability: RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY };
  const current = currentApplicabilityContext(store, root, storyId);
  process.env.FINDING_E2E_CONTEXT = JSON.stringify(current);
  const base = runtime.finding_runtime_evidence_run({ ...runtimeArgs, idempotencyKey: 'base', sourceRef: current.baseHash });
  const head = runtime.finding_runtime_evidence_run({ ...runtimeArgs, idempotencyKey: 'head' });
  assert.equal(base.receipt.exitCode, 1); assert.equal(head.receipt.exitCode, 1);
  const desired = { verdict: 'pre_existing_unaffected', basis: 'base_head_reproduction', owner: 'other_story', evaluationScope: 'target_story',
    baseHead: { baseRef: current.baseHash, headRef: current.headHash, baseResult: 'reproduced', headResult: 'reproduced',
      worsenedByStory: false, receiptIds: [base.runtimeReceiptId, head.runtimeReceiptId] },
    runtimeReceiptIds: [base.runtimeReceiptId, head.runtimeReceiptId], protectedSurfaceEvaluation: surfaces, expiresAt };
  const propose = (proposal: typeof desired, key: string) => withNativeReviewFixtureHostIdentity({ agent, invoke: () =>
    handlers.finding_assessment_propose({ storyId, findingId, idempotencyKey: key, proposal }) });
  assert.throws(() => propose({ ...desired, runtimeReceiptIds: [head.runtimeReceiptId, head.runtimeReceiptId] }, 'repeated-head'), /ordered/);
  pass('two head receipts cannot replace historical execution');
  const proposed = propose(desired, 'proposal');
  const request = { storyId, findingId, idempotencyKey: 'assessment', verdict: 'pre_existing_unaffected' as const,
    proofStrength: 'strong' as const, gateImpact: 'does_not_block' as const, proposalRef: proposed.proposalRef as never,
    evidenceRefs: [base.runtimeReceiptId, head.runtimeReceiptId], recheckTriggers: ['expired', 'owner_invalid'] };
  assert.throws(() => handlers.finding_applicability_assess(request), /route|owner/);
  pass('complete execution pair alone cannot waive target consent');
  process.chdir(targetRoot); process.env.PROOF_OR_STOP_SESSION_ID = 'target-fixture'; process.env.PROOF_OR_STOP_AGENT = 'main';
  process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER = 'codex'; resetSessionIdForTest();
  acquireOwnerLease(targetStore.storyDirPath(targetId), { command: 'fixture consent', cwd: targetRoot });
  const accepted = createFindingRouteHandlers(targetCtx).finding_route_accept({ storyId: targetId, idempotencyKey: 'consent', source: proposed.proposalRef, targetItemId: 'CHK-001',
    canonicalDefect: { storyId, recordId: canonicalRecord.recordId, recordHash: exactLedgerRecordHash(canonicalRecord) },
    subject: { sourcePaths: ['defect.mjs'], targetChecklistItemRefs: ['CHK-001'], targetAcceptanceRefs: [], affectedContractRefs: ['CHK-001:happy:0'],
      command: { executable: process.execPath, args: ['witness.mjs'], selector: 'FINDING_WITNESS' } }, expiresAt });
  const consent = accepted.rows.find(row => row.envelope.kind === 'route_receipt')!;
  process.chdir(root); process.env.PROOF_OR_STOP_SESSION_ID = 'source-fixture'; resetSessionIdForTest();
  const route = { storyId: targetId, receipt: { storyId: targetId, recordId: consent.record.recordId, recordHash: exactLedgerRecordHash(consent.record) } };
  const before = store.readFindingLedger(storyId).committedLedgerDigest;
  assert.throws(() => handlers.finding_applicability_assess({ ...request, idempotencyKey: 'substituted-route',
    route: { ...route, receipt: { ...route.receipt, recordHash: 'f'.repeat(64) } } }), /route|record|substitut/);
  assert.equal(store.readFindingLedger(storyId).committedLedgerDigest, before);
  pass('substituted target receipt refuses without source ledger delta');
  const assessment = handlers.finding_applicability_assess({ ...request, route });
  assert.equal(assessment.assessment.verdict, 'pre_existing_unaffected');
  const decision = handlers.finding_triage({ storyId }).rows[0]!.decision;
  assert.equal(decision.dynamicBlocking, false, JSON.stringify(decision));
  assert.match(decision.reason, /pre_existing_unaffected/);
  pass('real pair plus target consent and signed assessment releases high-severity shadow floor');
  const again = handlers.finding_applicability_assess({ ...request, route });
  assert.equal(again.assessment.assessmentId, assessment.assessment.assessmentId);
  pass('full accepted assessment replays idempotently');
  write('defect.mjs', 'export const broken = true; // current Story now changes this surface\\n');
  git('add', 'defect.mjs'); git('commit', '-m', 'current Story touches controlled defect');
  assert.equal(handlers.finding_triage({ storyId }).rows[0]!.decision.dynamicBlocking, true);
  pass('current material drift cannot reuse non-applicable proof');
  console.log(`PRE_EXISTING_E2E PASS ${count}`);
} finally {
  process.chdir(oldCwd); for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
  Object.assign(process.env, oldEnv); resetSessionIdForTest(); rmSync(sandbox, { recursive: true, force: true });
}
