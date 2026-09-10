/** B-03b7 focused candidate tests. All writes use disposable fixture stores. */
import assert from 'node:assert/strict';
import ts from 'typescript';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import { createFindingIdentityHandlers } from '../handlers/finding-identity.js';
import { assertIdentityJson, candidateAddSchema, parseIdentityInput, validateCandidate, verifyIdentityEnvelope,
  identityHash, signIdentityEnvelope, CANDIDATE_REPRODUCTION_MARKER_TOKEN, materializeCandidateReproductionCommand,
  validateCandidateReproductionAttestation } from '../core/finding-identity.js';
import { findingLedgerTrustFromWorkspace, findingLedgerSignerFromWorkspace, canonicalHash, type JsonValue } from '../core/finding-ledger.js';
import { verifiedIdentityCarrier, readIdentityRows } from '../handlers/finding-identity-store.js';
import type { StoryInfo } from '../core/types.js';
import { signFinding, verifyFinding } from '../core/finding-verify.js';
import { isFindingBlocking } from '../core/advisory.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { isCommandAllowed } from '../core/config.js';
import { PROCESS_FACT_STORY2_CANDIDATE_POLICY } from '../core/process-fact-registry.js';
import { acquireOwnerLease, releaseOwnerLease } from '../core/story-owner-lease.js';
import { createMainRegistry } from '../registry.js';
import { executeCausalEvidence, preflightCausalEvidence, DEFAULT_CAUSAL_SELECTOR_POLICY } from '../core/causal-evidence.js';
import { identitySourceSnapshot } from '../handlers/finding-identity-store.js';
import { currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resetSessionIdForTest, getSessionIdentity } from '../core/owner-session.js';
import { createFindingRouteHandlers, proposalAuthorityDigest, proposalScopeDigest, proposalFindingHash, targetRouteSnapshot, sourceRouteRecord } from '../handlers/finding-route.js';
import { exactLedgerRecordHash, signAssessmentProposal, verifyAssessmentProposal, appendAssessmentProposal, appendFindingLedger } from '../handlers/finding-ledger.js';
import { captureMkdirLockFence, withMkdirLock } from '../core/mkdir-lock.js';
import { validateCanonicalDefect, assertCauseEvidence, buildConfirmedCanonicalDefect } from '../core/finding-identity.js';
import { validateRouteReceipt, assertReceiptCurrent, type RouteReceipt, type RouteSource } from '../core/finding-route.js';
import { validateBaselineSet, validateBaseline, validateProgress, assertProgressTransition, semanticProjection, PROGRESS_KINDS, type BaselineSet, type ProgressBaseline, type ProgressBinding } from '../core/finding-progress.js';
import type { CanonicalDefect, IdentitySemanticEnvelope } from '../core/finding-identity-types.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { withIdentityLedgerLocks } from '../handlers/finding-identity-store.js';
import { signCanonical } from '../core/authority-signing.js';
import { createFindingHistoryHandlers } from '../handlers/finding-history.js';
import { readHistoryCatalog, readCanonicalCatalog, historicalStoryContext, identityCatalogContributor } from '../handlers/finding-identity-store.js';
import { buildHistoryIndex, queryHistoryIndex, canonicalCurrent, validateHistoryGraph, validateSupersession, type HistorySupersession,
  verifyIdentityScorecard, scorecardDigest, SCORECARD_KINDS, detectorAdjudicationMeasurements } from '../core/finding-history.js';
import { getGuardFailureReason as getLifecycleGuardFailureReason } from '../core/machine.js';
import { nativeReviewFixtureBrokers, withBrokeredNativeReviewInvocation } from './native-review-fixture.js';

const section = process.argv.find(arg => arg.startsWith('--section='))?.split('=')[1] ?? 'candidates';
const smokeStarted = performance.now();
assert.ok(['candidates', 'routes', 'history', 'scorecard', 'worktrees', 'delivery'].includes(section), 'only implemented smoke sections are supported');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'proof-or-stop-identity-')));
const oldCwd = process.cwd(); const oldActor = process.env.PROOF_OR_STOP_AGENT;
const oldSession = process.env.PROOF_OR_STOP_SESSION_ID;
const oldProvider = process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER;
const cliPath = fileURLToPath(new URL('../../../../bin/proof-or-stop.js', import.meta.url));
const source = 'export function observedDefect() { return 2; }\n';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
let assertions = 0;
let failures = 0;
function test(name: string, fn: () => void) {
  try { fn(); assertions++; console.log(`CANDIDATE ${name} PASS`); }
  catch (error) { failures++; console.error(`CANDIDATE ${name} FAIL: ${error instanceof Error ? error.message : error}`); }
}
function concurrentCli(command: string, input: object) {
  const script = `const {spawn}=require('node:child_process'); const [cli,command,input]=process.argv.slice(1); Promise.all([0,1].map(()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[cli,command,input],{env:process.env});let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));}))).then(rows=>console.log(JSON.stringify(rows)),error=>{console.error(error);process.exitCode=1;});`;
  const rows = JSON.parse(execFileSync(process.execPath, ['-e', script, cliPath, command, JSON.stringify(input)], { cwd: scratch, encoding: 'utf8', env: process.env, timeout: 120000, maxBuffer: 12 * 1024 * 1024 })) as { status: number; stdout: string; stderr: string }[];
  for (const row of rows) assert.equal(row.status, 0, `${command}: ${row.stdout}\n${row.stderr}`);
  return rows;
}
function publicCli(command: string, input: object) {
  const result = spawnSync(process.execPath, [cliPath, command, JSON.stringify(input)], { cwd: scratch, encoding: 'utf8', env: process.env, timeout: 120000, maxBuffer: 12 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command}: ${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.slice(result.stdout.indexOf('{'), result.stdout.lastIndexOf('}') + 1));
}

try {
  process.env.PROOF_OR_STOP_AGENT = 'main';
  process.env.PROOF_OR_STOP_SESSION_ID = `candidate-smoke-${process.pid}`;
  // The official validation runner intentionally removes inherited host facts.
  // This disposable fixture declares its synthetic host, never the real caller's.
  process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER = 'codex';
  resetSessionIdForTest();
  process.chdir(scratch);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Harmonynet'); git('config', 'user.email', '26995688+Harmonynet@users.noreply.github.com');
  writeFileSync(join(scratch, 'source.mjs'), source);
  writeFileSync(join(scratch, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
    nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() },
  }));
  writeFileSync(join(scratch, '.gitignore'), '.proof-or-stop/activity.jsonl\n.proof-or-stop/locks/\n.proof-or-stop/tmp/\n.proof-or-stop/runtime/native-review-invocations/\n.native-review-fixture-*.json\n');
  git('add', '.'); git('commit', '-m', 'synthetic candidate source');
  const store = new StoryStore(scratch); const storyId = 'B-CANDIDATES';
  store.writeStory(storyId, { storyId, name: 'candidate-fixture', title: 'Synthetic candidate fixture', description: 'Bounded candidate handler smoke fixture.',
    type: 'feature', priority: 'high', phase: 'DEV', createdAt: new Date().toISOString(), startedAt: null, endedAt: null, events: [] } as StoryInfo);
  const ctx = { root: scratch, scanRoot: scratch, store };
  const handlers = createFindingIdentityHandlers(ctx);
  const anchor = { path: 'source.mjs', contentDigest: sha(source), line: 1, symbol: 'observedDefect' };
  const reproductionSelector = 'observed-defect-returned-two';
  const reproductionContract = { executable: process.execPath, argsTemplate: ['--input-type=module', '-e',
    `import {observedDefect} from './source.mjs'; if(observedDefect() !== 2) process.exit(1); console.log(${JSON.stringify(reproductionSelector)}); console.log(${JSON.stringify(CANDIDATE_REPRODUCTION_MARKER_TOKEN)});`],
    selector: reproductionSelector };
  const add = { storyId, idempotencyKey: 'candidate-add-1', signal: { detectorId: 'synthetic-reproducer', detectorVersion: '1', sourceIds: ['independent-source-1'],
    outputDigest: sha('observed 2; contract expects 3'), matchCount: 1, anchors: [anchor], rawCategory: 'value mismatch' },
    candidate: { suspectedDefect: 'Function returns the wrong value', affectedSymbols: ['observedDefect'], affectedContracts: ['return-three'], evidenceRefs: ['source.mjs:1'], reproductionContract } };
  if (section === 'worktrees' || section === 'delivery') test('actual public CLI across linked worktrees retains signed history after source removal', () => {
    const demo = realpathSync(mkdtempSync(join(tmpdir(), 'proof-or-stop-identity-worktrees-')));
    const main = join(demo, 'main'); const from = join(demo, 'source'); const to = join(demo, 'target'); const unrelated = join(demo, 'unrelated'); mkdirSync(main);
    const sourceId = 'B-WORKTREE-SOURCE'; const targetId = 'B-WORKTREE-TARGET'; const unrelatedId = 'B-WORKTREE-UNRELATED';
    const gitAt = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const invoke = (cwd: string, session: string, command: string, input: object) => {
      const result = spawnSync(process.execPath, [cliPath, command, JSON.stringify(input)], { cwd, encoding: 'utf8', timeout: 60000,
        env: { ...process.env, PROOF_OR_STOP_AGENT: 'main', PROOF_OR_STOP_SESSION_ID: session, PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex' } });
      assert.equal(result.status, 0, `${command}: ${result.stdout}\n${result.stderr}`);
      const first = result.stdout.indexOf('{'); const last = result.stdout.lastIndexOf('}');
      if (command === 'finding_add') return { message: result.stdout };
      assert.ok(first >= 0 && last > first, `${command}: expected JSON, got ${result.stdout}`);
      return JSON.parse(result.stdout.slice(first, last + 1));
    };
    try {
      gitAt(main, 'init', '-b', 'main'); gitAt(main, 'config', 'user.name', 'Harmonynet'); gitAt(main, 'config', 'user.email', '26995688+Harmonynet@users.noreply.github.com');
      writeFileSync(join(main, 'source.mjs'), source); writeFileSync(join(main, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }));
      writeFileSync(join(main, '.gitignore'), '.proof-or-stop/activity.jsonl\n.proof-or-stop/locks/\n.proof-or-stop/tmp/\n**/owner-lease.json\n');
      const mainStore = new StoryStore(main);
      for (const [id, path] of [[sourceId, from], [targetId, to], [unrelatedId, unrelated]] as const) {
        mainStore.writeStory(id, { storyId: id, name: id, title: 'Disposable linked-worktree delivery', description: 'Real CLI candidate and signed history fixture, not a lifecycle qualification.',
          type: 'feature', priority: 'low', phase: 'DEV', createdAt: new Date().toISOString(), startedAt: null, endedAt: null, events: [], worktree: { path, branch: `story/${id}`, createdAt: new Date().toISOString() } } as StoryInfo);
        mainStore.writeChecklist(id, { items: [{ id: 'CHK-001', title: 'Repair observed value', context: 'Actual target responsibility in separate worktree.', status: 'pending', startTime: null, endTime: null,
          files: { modify: ['source.mjs'], create: [], test: [] }, verificationIntent: { happy: [{ desc: 'Returns required value', type: 'cli', priority: 'must' }], edge: [], adversarial: [] } }] });
      }
      gitAt(main, 'add', '.'); gitAt(main, 'commit', '-m', 'disposable linked worktree inputs');
      gitAt(main, 'worktree', 'add', '-b', `story/${sourceId}`, from); gitAt(main, 'worktree', 'add', '-b', `story/${targetId}`, to);
      gitAt(main, 'worktree', 'add', '-b', `story/${unrelatedId}`, unrelated);
      writeFileSync(join(unrelated, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', promptEnvelope: { version: 'proofbound.prompt-envelope-rollout.v1' } }));
      const sourceSession = `demo-source-${process.pid}`; const targetSession = `demo-target-${process.pid}`;
      const added = invoke(from, sourceSession, 'finding_candidate_add', { ...add, storyId: sourceId, idempotencyKey: 'linked-candidate' });
      const candidateRow = added.rows.find((row: { envelope: { kind: string } }) => row.envelope.kind === 'candidate');
      const sourceRef = { storyId: sourceId, recordId: candidateRow.record.recordId, recordHash: exactLedgerRecordHash(candidateRow.record),
        subjectKind: 'candidate_finding', subjectId: candidateRow.envelope.payload.candidateId, subjectHash: candidateRow.envelope.payload.currentProjectionHash };
      const consent = invoke(to, targetSession, 'finding_route_accept', { storyId: targetId, idempotencyKey: 'linked-consent', source: sourceRef, targetItemId: 'CHK-001',
        subject: { affectedContractRefs: ['CHK-001:happy:0'], targetChecklistItemRefs: ['CHK-001'], targetAcceptanceRefs: [], sourcePaths: ['source.mjs'] }, expiresAt: new Date(Date.now() + 3600000).toISOString() });
      const receipt = { storyId: targetId, recordId: consent.rows[0].record.recordId, recordHash: exactLedgerRecordHash(consent.rows[0].record) };
      assert.equal(consent.rows.length, 1);
      const route = invoke(from, sourceSession, 'finding_candidate_route', { storyId: sourceId, idempotencyKey: 'linked-route', candidate: sourceRef, receipt,
        uncertaintyReason: 'Unverified candidate for target review, no current Finding authority.', evidenceRefs: ['source.mjs:1'], severity: 'low', recheckTriggers: ['owner_invalid', 'expiry_reached'] });
      assert.equal(route.rows.length, 1); assert.equal(route.rows[0].envelope.payload.gateEvidence, false);
      invoke(from, sourceSession, 'finding_add', { storyId: sourceId, desc: 'Independent durable source observation from linked worktree: observedDefect returns two, not the required three.', severity: 'high', category: 'edge', files: ['source.mjs'], evidenceState: 'verified', idempotencyKey: 'linked-finding' });
      const sourceStore = new StoryStore(from);
      const sourceFinding = sourceStore.readFindings(sourceId).findings.at(-1)!;
      const sourceFindingRecord = sourceStore.readFindingLedger<JsonValue>(sourceId).records.find(row => row.recordId === sourceFinding.recordId)!;
      const sourceFindingRef = { storyId: sourceId, findingId: sourceFinding.id, recordId: sourceFindingRecord.recordId,
        recordHash: exactLedgerRecordHash(sourceFindingRecord) };
      const sourceSigner = findingLedgerSignerFromWorkspace(from);
      const producedAt = new Date().toISOString();
      const foreignCanonical = buildConfirmedCanonicalDefect({ storyId: sourceId, idempotencyKey: 'foreign-active-canonical-probe',
        title: 'Foreign active canonical defect', triggerCondition: 'observedDefect() returns two', reproduction: 'Observed 2 while the fixture contract requires 3',
        rootCauseState: 'unknown', identityEvidenceRefs: [sha('foreign-active-canonical-evidence')], evidenceAnchors: [{ path: 'source.mjs', contentDigest: sha(source), line: 1, symbol: 'observedDefect' }],
        affectedSymbols: ['observedDefect'], affectedContracts: ['return-three'], memberFindingRefs: [sourceFindingRef], canonicalFindingRef: sourceFindingRef,
        reviewRunId: `${sourceId}:RR-FOREIGN-ACTIVE` }, { canonicalDefectId: 'CD-FOREIGN-ACTIVE', confirmedBy: 'proof-or-stop-review-concept', confirmedAt: producedAt,
        sourceLineageKeys: [sha('foreign-active-source-lineage')] });
      const foreignEnvelope = signIdentityEnvelope({ kind: 'canonical_defect', storyId: sourceId,
        requestDigest: sha('foreign-active-canonical-request'), producedAt, payload: foreignCanonical }, sourceSigner, validateCanonicalDefect);
      const sourceLock = sourceStore.runtimeLockDirPath(sourceId, 'finding', 'findings');
      withMkdirLock(sourceLock, () => {
        const fence = captureMkdirLockFence(sourceLock);
        appendFindingLedger({ storyId: sourceId, store: sourceStore, operation: 'append_canonical_defect', idempotencyKey: 'foreign-active-canonical-probe',
          records: [{ recordType: 'canonical_defect', payload: foreignEnvelope as unknown as JsonValue }],
          writerSessionId: sourceSession, writerLeaseId: sourceSession, writerFenceToken: fence.writerFenceToken, fence, signer: sourceSigner });
      }, { requireHolderToken: true });
      const targetContext = { root: to, scanRoot: to, store: new StoryStore(to) };
      const foreignContributor = identityCatalogContributor(targetContext, sourceId, ['canonical_defect']);
      assert.ok(foreignContributor, 'F028_FOREIGN_ACTIVE_CATALOG missing signed contributor that exists only in another active Story worktree');
      assert.equal(realpathSync(foreignContributor.root), realpathSync(from), 'F028_FOREIGN_ACTIVE_CATALOG resolved the wrong signed Story workspace');
      const activeHistory = invoke(to, targetSession, 'finding_history_query', { storyId: targetId, sourceStoryIds: [sourceId] });
      assert.ok(activeHistory.rows.some((row: { canonicalIds?: string[] }) => row.canonicalIds?.includes(foreignCanonical.canonicalDefectId)));
      const activeScorecard = invoke(to, targetSession, 'finding_identity_scorecard', { storyId: targetId, sourceStoryIds: [sourceId] });
      assert.ok(activeScorecard.rows.some((row: { kind: string; envelope: { payload?: { canonicalDefectId?: string } } }) =>
        row.kind === 'canonical_defect' && row.envelope.payload?.canonicalDefectId === foreignCanonical.canonicalDefectId));
      assert.equal(activeScorecard.inputDigest,
        invoke(to, targetSession, 'finding_identity_scorecard', { storyId: targetId, sourceStoryIds: [sourceId] }).inputDigest);
      console.log('PUBLIC_FOREIGN_ACTIVE_CANONICAL PASS signed canonical row, history projection, scorecard row and stable catalog input digest');
      const before = sourceStore.readFindingLedger(sourceId);
      const key = join(main, '.git', 'proof-or-stop-finding-ledger-v1.key'); const keyBytes = readFileSync(key);
      // Fixture-only terminal transition and real Git merge/removal. This proves
      // durable history transport, not that this fixture passed lifecycle gates.
      sourceStore.writeStory(sourceId, { ...sourceStore.readStory(sourceId), phase: 'DONE', endedAt: new Date().toISOString() });
      gitAt(from, 'add', `.proof-or-stop/story/actives/${sourceId}`); gitAt(from, 'commit', '-m', 'preserve disposable signed source history');
      gitAt(main, 'merge', '--no-edit', `story/${sourceId}`); gitAt(main, 'worktree', 'remove', '--force', from);
      assert.equal(existsSync(from), false); assert.deepEqual(mainStore.readFindingLedger(sourceId), before);
      const history = invoke(to, targetSession, 'finding_history_query', { storyId: targetId, sourceStoryIds: [sourceId] });
      assert.equal(history.complete, true); assert.ok(history.rows.some((row: { ref?: { recordId?: string } }) => row.ref?.recordId === sourceFindingRecord.recordId));
      assert.ok(history.rows.some((row: { canonicalIds?: string[] }) => row.canonicalIds?.includes(foreignCanonical.canonicalDefectId))); assert.equal(history.gateEvidence, false);
      const scorecard = invoke(to, targetSession, 'finding_identity_scorecard', { storyId: targetId, sourceStoryIds: [sourceId] });
      assert.equal(scorecard.complete, true); assert.ok(scorecard.rows.some((row: { kind: string }) => row.kind === 'candidate_route'));
      assert.deepEqual(readFileSync(key), keyBytes); assert.deepEqual(mainStore.readFindingLedger(sourceId), before);
      console.log('PUBLIC_MULTIWORKTREE_DELIVERY PASS source/target sessions distinct; source removed; original signed ledger and common trust unchanged');
    } finally { rmSync(demo, { recursive: true, force: true }); }
  });
  test('missing trust read refuses without creating keys', () => {
    assert.throws(() => handlers.finding_candidate_get({ storyId }), /signing_key_unavailable/);
    assert.equal(existsSync(join(scratch, '.git', 'proof-or-stop-finding-ledger-v1.key')), false);
  });
  const beforeFindings = store.readFindings(storyId);
  test('missing owner lease refuses without creating signing key', () => { assert.throws(() => handlers.finding_candidate_add(add), /owner lease/); });
  acquireOwnerLease(store.storyDirPath(storyId), { command: 'synthetic candidate smoke', cwd: scratch });
  const first = handlers.finding_candidate_add(add);
  const candidate = first.rows.find(row => row.envelope.kind === 'candidate')!.envelope.payload;
  validateCandidate(candidate);
  test('pending immutable signal and candidate are non-gate', () => {
    assert.equal(first.rows.length, 2); assert.equal(candidate.state, 'pending_verification'); assert.equal(candidate.gateEvidence, false);
    assert.deepEqual(candidate.reproductionContract, reproductionContract);
    assert.deepEqual(store.readFindings(storyId), beforeFindings);
    assert.equal(handlers.finding_candidate_get({ storyId }).candidates.length, 1);
  });
  test('identical retry restores original signed transaction', () => {
    const retry = handlers.finding_candidate_add(structuredClone(add));
    assert.equal(retry.replayed, true); assert.deepEqual(retry.rows, first.rows); assert.deepEqual(retry.receipt, first.receipt);
    assert.equal(store.readFindingLedger(storyId).records.length, 2);
  });
  test('changed retry refuses without append', () => {
    assert.throws(() => handlers.finding_candidate_add({ ...add, candidate: { ...add.candidate, suspectedDefect: 'Different defect' } }), /IDEMPOTENCY_CONFLICT/);
    assert.equal(store.readFindingLedger(storyId).records.length, 2);
  });
  test('strict ingress rejects authority/null/unknown injection', () => {
    for (const value of [{ ...add, gateEvidence: true }, { ...add, signal: { ...add.signal, evidenceState: 'verified' } },
      { ...add, candidate: { ...add.candidate, promotionFindingRef: 'forged' } },
      { ...add, candidate: { ...add.candidate, reproductionContract: undefined } },
      { ...add, candidate: null }]) assert.throws(() => handlers.finding_candidate_add(value));
  });
  test('reproduction contract rejects zero candidate marker tokens', () => {
    assert.throws(() => handlers.finding_candidate_add({ ...add, candidate: { ...add.candidate,
      reproductionContract: { ...reproductionContract, argsTemplate: ['no marker token'] } } }), /exactly one candidate marker token/);
  });
  test('reproduction contract rejects multiple candidate marker tokens', () => {
    assert.throws(() => handlers.finding_candidate_add({ ...add, candidate: { ...add.candidate, reproductionContract: { ...reproductionContract,
      argsTemplate: [CANDIDATE_REPRODUCTION_MARKER_TOKEN, CANDIDATE_REPRODUCTION_MARKER_TOKEN] } } }), /exactly one candidate marker token/);
  });
  test('reproduction contract rejects a selector containing the candidate marker token', () => {
    assert.throws(() => handlers.finding_candidate_add({ ...add, candidate: { ...add.candidate, reproductionContract: { ...reproductionContract,
      selector: `selector-${CANDIDATE_REPRODUCTION_MARKER_TOKEN}` } } }), /selector must be candidate-independent/);
  });
  test('JSON shape rejects sparse/decorated/accessor arrays', () => {
    const sparse = new Array(2); const decorated = ['value']; Object.defineProperty(decorated, 'hidden', { value: true });
    const symbolic = ['value']; Object.defineProperty(symbolic, Symbol('hidden'), { value: true });
    const accessor = ['value']; Object.defineProperty(accessor, '0', { enumerable: true, get: () => 'value' });
    for (const value of [sparse, decorated, symbolic, accessor, { value: undefined }, { value: null }]) assert.throws(() => assertIdentityJson(value));
  });
  test('signed rows reject whitespace/null/unknown mutations', () => {
    const envelope = first.rows.find(row => row.envelope.kind === 'candidate')!.envelope;
    const trust = findingLedgerTrustFromWorkspace(scratch);
    verifyIdentityEnvelope(envelope, trust, validateCandidate);
    for (const value of [{ ...envelope, storyId: ` ${storyId}` }, { ...envelope, gateEvidence: true },
      { ...envelope, extra: null }, { ...envelope, payload: { ...candidate, suspectedDefect: `${candidate.suspectedDefect} ` } }]) assert.throws(() => verifyIdentityEnvelope(value, trust, validateCandidate));
  });
  test('actual ledger/carrier tamper is rejected', () => {
    const ledger = store.readFindingLedger(storyId); const copy = structuredClone(ledger) as any;
    delete copy.receipts[0].findingLedgerReceipt;
    assert.throws(() => verifiedIdentityCarrier(copy, storyId, first.rows[0]!.record.recordId, findingLedgerTrustFromWorkspace(scratch)), /carrier invalid/);
    const altered = structuredClone(ledger) as any; altered.records[0].payload.payload.gateEvidence = true;
    assert.throws(() => verifiedIdentityCarrier(altered, storyId, first.rows[0]!.record.recordId, findingLedgerTrustFromWorkspace(scratch)));
  });
  const second = handlers.finding_candidate_add({ ...add, idempotencyKey: 'candidate-add-2', signal: { ...add.signal, sourceIds: ['independent-source-2'] } });
  const other = second.rows.find(row => row.envelope.kind === 'candidate')!.envelope.payload; validateCandidate(other);
  test('suggestion grouping retains independent source identities', () => {
    assert.equal(candidate.candidateGroupKey, other.candidateGroupKey); assert.notEqual(candidate.candidateId, other.candidateId);
    assert.notDeepEqual(candidate.sourceLineageKeys, other.sourceLineageKeys);
  });
  test('original retry survives a later unrelated append', () => { assert.deepEqual(handlers.finding_candidate_add(add).rows, first.rows); });
  test('wrong hash and actor refuse before mutation', () => {
    assert.throws(() => handlers.finding_candidate_disprove({ storyId, idempotencyKey: 'bad-hash', candidateId: candidate.candidateId, expectedCandidateHash: '0'.repeat(64), reason: 'Counterevidence', evidenceRefs: ['source.mjs'], evidenceAnchors: [anchor] }), /hash mismatch/);
    process.env.PROOF_OR_STOP_AGENT = 'unregistered-reviewer';
    try { assert.throws(() => handlers.finding_candidate_add({ ...add, idempotencyKey: 'unauthorized' }), /unauthorized/); }
    finally { process.env.PROOF_OR_STOP_AGENT = 'main'; }
    assert.equal(store.readFindingLedger(storyId).records.length, 4);
  });
  const merge = { storyId, idempotencyKey: 'merge', candidateId: candidate.candidateId, expectedCandidateHash: candidate.currentProjectionHash,
    targetCandidateId: other.candidateId, expectedTargetHash: other.currentProjectionHash, reason: 'Same trigger evidence; merge advisory candidates only.', evidenceRefs: ['source.mjs:1'], evidenceAnchors: [anchor] };
  const merged = handlers.finding_candidate_merge(merge);
  test('merge is atomic and preserves both immutable source trails', () => {
    if (section === 'delivery') assert.deepEqual(publicCli('finding_candidate_merge', merge).rows, merged.rows);
    assert.equal(merged.rows.length, 2); assert.equal(store.readFindingLedger(storyId).records.length, 6);
    const current = handlers.finding_candidate_get({ storyId }).candidates;
    assert.equal(current.find(row => row.candidateId === candidate.candidateId)!.state, 'merged');
    assert.deepEqual(current.find(row => row.candidateId === candidate.candidateId)!.decision!.evidenceAnchors, [anchor]);
    assert.equal(current.find(row => row.candidateId === other.candidateId)!.sourceLineageKeys.length, 2);
    assert.deepEqual(handlers.finding_candidate_merge(merge).rows, merged.rows);
    assert.deepEqual(store.readFindings(storyId), beforeFindings);
  });
  const current = handlers.finding_candidate_get({ storyId, candidateId: other.candidateId }).candidates[0]!;
  const disproof = { storyId, idempotencyKey: 'disproof', candidateId: current.candidateId, expectedCandidateHash: current.currentProjectionHash,
    reason: 'Synthetic counterevidence disproves the suspicion.', evidenceRefs: ['source.mjs:1'], evidenceAnchors: [anchor] };
  const disproven = handlers.finding_candidate_disprove(disproof);
  test('disproof retains predecessor and retry; terminal transition refuses', () => {
    if (section === 'delivery') assert.deepEqual(publicCli('finding_candidate_disprove', disproof).rows, disproven.rows);
    assert.equal(handlers.finding_candidate_get({ storyId, candidateId: current.candidateId }).candidates[0]!.state, 'disproven');
    assert.deepEqual(handlers.finding_candidate_get({ storyId, candidateId: current.candidateId }).candidates[0]!.decision!.evidenceAnchors, [anchor]);
    assert.deepEqual(handlers.finding_candidate_disprove(disproof).rows, disproven.rows);
    assert.throws(() => handlers.finding_candidate_disprove({ ...disproof, idempotencyKey: 'terminal-rewrite' }), /hash mismatch|terminal transition/);
  });
  test('stale source bytes refuse before append', () => {
    const count = store.readFindingLedger(storyId).records.length; writeFileSync(join(scratch, 'source.mjs'), `${source}// drift\n`);
    try { assert.throws(() => handlers.finding_candidate_add({ ...add, idempotencyKey: 'stale-source' }), /stale source/); }
    finally { writeFileSync(join(scratch, 'source.mjs'), source); }
    assert.equal(store.readFindingLedger(storyId).records.length, count);
  });
  test('promotion refuses non-reviewer and raw caller PASS', () => {
    assert.throws(() => handlers.finding_candidate_promote({ storyId, idempotencyKey: 'bad-promotion', candidateId: current.candidateId,
      expectedCandidateHash: current.currentProjectionHash, findingId: `${storyId}:F-001`, reviewRunId: 'run', reproductionExecutionKey: 'PASS', reproductionReceiptHash: '0'.repeat(64),
      reproductionAttestation: { selector: reproductionSelector, semanticAssertion: 'The bound execution reproduced the exact semantic defect.' } }), /phase|reviewer/);
    assert.throws(() => parseIdentityInput(candidateAddSchema, { ...add, candidate: { ...add.candidate, receipt: { status: 'pass' } } }));
  });
  test('registry and real lifecycle projection preserve advisory isolation', () => {
    assert.equal(COMMAND_POLICIES.finding_candidate_get.ownershipClass, 'readOnly');
    assert.equal(COMMAND_POLICIES.finding_candidate_promote.ownershipClass, 'reviewerWrite');
    assert.equal(PROCESS_FACT_STORY2_CANDIDATE_POLICY.gateEvidence, false);
    assert.equal(PROCESS_FACT_STORY2_CANDIDATE_POLICY.lifecycleAuthority, 'none');
    assert.deepEqual(store.readFindings(storyId), beforeFindings);
    for (const phase of ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE']) {
      assert.equal(isCommandAllowed('finding_candidate_get', phase), true);
      for (const command of ['finding_candidate_add', 'finding_candidate_merge', 'finding_candidate_disprove']) {
        assert.equal(isCommandAllowed(command, phase), ['DEV', 'REVIEW', 'TEST'].includes(phase), `${command}/${phase}`);
      }
      assert.equal(isCommandAllowed('finding_candidate_promote', phase), phase === 'REVIEW');
    }
  });
  test('public CLI validates schema and reads signed candidates', () => {
    const invoke = (command: string, input: unknown) => spawnSync(process.execPath, [cliPath, command, JSON.stringify(input)], { cwd: scratch, encoding: 'utf8', env: process.env });
    const get = invoke('finding_candidate_get', { storyId });
    assert.equal(get.status, 0, get.stderr + get.stdout); assert.match(get.stdout, /non_authoritative/);
    const invalid = invoke('finding_candidate_add', { ...add, gateEvidence: true });
    assert.notEqual(invalid.status, 0, `public CLI injected gateEvidence must refuse; exit=${invalid.status}, replayed=${invalid.stdout.includes('"replayed": true')}`);
    const added = invoke('finding_candidate_add', { ...add, idempotencyKey: 'public-cli-add' });
    assert.equal(added.status, 0, added.stderr + added.stdout); assert.match(added.stdout, /pending_verification/);
  });
  const promotionSource = handlers.finding_candidate_add({ ...add, idempotencyKey: 'promotion-source' }).candidates[0]!;
  const wrongCommandSource = handlers.finding_candidate_add({ ...add, idempotencyKey: 'promotion-wrong-command-source' }).candidates[0]!;
  const wrongSelectorSource = handlers.finding_candidate_add({ ...add, idempotencyKey: 'promotion-wrong-selector-source' }).candidates[0]!;
  const markerOnlySelector = 'marker-only-contract-selector';
  const markerOnlyContract = { executable: process.execPath, argsTemplate: ['--input-type=module', '-e',
    `console.log(${JSON.stringify(markerOnlySelector)}); console.log(${JSON.stringify(CANDIDATE_REPRODUCTION_MARKER_TOKEN)});`],
    selector: markerOnlySelector };
  const markerOnlySource = handlers.finding_candidate_add({ ...add, idempotencyKey: 'promotion-marker-only-source',
    candidate: { ...add.candidate, suspectedDefect: 'Marker-only command does not reproduce the semantic defect', reproductionContract: markerOnlyContract } }).candidates[0]!;
  const round = new Date().toISOString();
  store.writeStory(storyId, { ...store.readStory(storyId), phase: 'REVIEW', currentReviewRound: round });
  store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'Synthetic candidate acceptance', context: 'Real reviewer ingress fixture.', status: 'done', startTime: null, endTime: null,
    verificationIntent: { happy: [], edge: [], adversarial: [] } }] });
  git('add', '.'); git('commit', '-m', 'synthetic review prerequisites');
  const registry = createMainRegistry(ctx); const lane = 'proof-or-stop-review-quality';
  registry.get('dispatch')!({ storyId, agentType: lane });
  process.env.PROOF_OR_STOP_AGENT = lane;
  const start = String(registry.get('review_run_start')!({ storyId, agent: lane }));
  const reviewRunId = start.match(/Review run (\S+) started/)?.[1]; assert.ok(reviewRunId, start);
  withBrokeredNativeReviewInvocation({ root: scratch, store, storyId, agent: lane, reviewRunId, invoke: () =>
    registry.get('finding_add')!({ storyId, agent: lane, reviewRunId, desc: 'Synthetic reproduced value defect: observedDefect returns 2 rather than required 3.',
      severity: 'high', category: 'edge', files: ['source.mjs'], evidenceState: 'verified', idempotencyKey: 'real-finding',
      readManifest: { filesReadFully: ['source.mjs'], filesTriagedByName: [], scanEscalationReason: null } }) });
  const finding = store.readFindings(storyId).findings.at(-1)!; assert.ok(finding.recordId);
  const marker = `candidate-reproduced:${promotionSource.candidateId}:${promotionSource.currentProjectionHash}`;
  const snapshot = identitySourceSnapshot(ctx); const storyFilesHash = currentStoryFilesHash(scratch, 'HEAD', scratch);
  async function executeReceipt(command: { executable: string; args: string[] }, selector: string, subjectStoryId = storyId) {
    const snapshot = identitySourceSnapshot(ctx); const storyFilesHash = currentStoryFilesHash(scratch, 'HEAD', scratch);
    const identity = { storyId: subjectStoryId, cwd: scratch, command, bootstrap: null, inputs: { materialHash: snapshot.materialHash }, storyFilesHash,
      effectiveEnvironment: {}, runtimeVersion: process.version, toolVersion: 'candidate-smoke-v1', selectorPolicy: DEFAULT_CAUSAL_SELECTOR_POLICY };
    const indexPath = join(scratch, '.git', 'index');
    const revalidate = () => identitySourceSnapshot(ctx).materialHash === snapshot.materialHash && readFileSync(join(scratch, 'source.mjs'), 'utf8') === source;
    const preflight = preflightCausalEvidence({ cli: { available: existsSync(process.execPath), path: process.execPath }, worktree: { expected: scratch, actual: process.cwd() },
      gitIndex: { readable: existsSync(indexPath), path: indexPath, contentDigest: createHash('sha256').update(readFileSync(indexPath)).digest('hex') },
      gitMaterial: { available: true, ...snapshot, storyFilesHash }, writerLease: { available: true, valid: true },
      providerCapability: { required: ['node'], available: ['node'] }, resources: { required: {}, available: {} },
      evidenceTarget: { writable: existsSync(store.storyDirPath(subjectStoryId)), path: store.storyDirPath(subjectStoryId) }, sideChannel: { available: true, maxOutputChars: 10000, maxProgressEvents: 10 } }, revalidate, identity);
    assert.equal(preflight.ready, true, JSON.stringify(preflight.failedChecks));
    return executeCausalEvidence({ identity, selector, preflight, revalidateBeforeRun: revalidate, receiptStore: store, run: async () => {
      const child = spawnSync(command.executable, command.args, { cwd: scratch, encoding: 'utf8' });
      return { code: child.status ?? 2, output: child.stdout + child.stderr };
    } });
  }
  async function reproduce(outputMarker: string, subjectStoryId = storyId) {
    const command = materializeCandidateReproductionCommand(reproductionContract, outputMarker);
    return executeReceipt(command, reproductionContract.selector, subjectStoryId);
  }
  const unrelated = await reproduce('unrelated-candidate'); const reproduced = await reproduce(marker);
  const markerOnly = await executeReceipt({ executable: process.execPath, args: ['-e', `console.log(${JSON.stringify(marker)})`] }, marker);
  assert.equal(reproduced.verdict.result, 'pass'); assert.equal(reproduced.disposition, 'executed');
  const semanticAssertion = 'The bound execution observed observedDefect returning 2 while the return-three contract requires 3.';
  const promote = { storyId, idempotencyKey: 'promotion', candidateId: promotionSource.candidateId, expectedCandidateHash: promotionSource.currentProjectionHash,
    findingId: finding.id, reviewRunId, reproductionExecutionKey: reproduced.key.key, reproductionReceiptHash: reproduced.receipt.receiptHash,
    reproductionAttestation: { selector: reproductionSelector, semanticAssertion } };
  test('valid review prerequisites isolate missing and wrong-subject receipt rejection', () => {
    for (const receipt of [{ reproductionExecutionKey: 'caller-PASS-no-receipt', reproductionReceiptHash: '0'.repeat(64) },
      { reproductionExecutionKey: unrelated.key.key, reproductionReceiptHash: unrelated.receipt.receiptHash },
      { reproductionExecutionKey: markerOnly.key.key, reproductionReceiptHash: markerOnly.receipt.receiptHash },
      { reproductionExecutionKey: reproduced.key.key, reproductionReceiptHash: '0'.repeat(64) }]) assert.throws(() => handlers.finding_candidate_promote({ ...promote, ...receipt }), /reproduction receipt/);
    assert.throws(() => handlers.finding_candidate_promote({ ...promote, reviewRunId: 'wrong-run' }), /reviewRun|review run/i);
  });
  const wrongCommandMarker = `candidate-reproduced:${wrongCommandSource.candidateId}:${wrongCommandSource.currentProjectionHash}`;
  const wrongCommandReceipt = await executeReceipt({ executable: process.execPath, args: ['--input-type=module', '-e',
    `console.log(${JSON.stringify(reproductionSelector)}); console.log(${JSON.stringify(wrongCommandMarker)});`] }, reproductionSelector);
  const wrongSelectorMarker = `candidate-reproduced:${wrongSelectorSource.candidateId}:${wrongSelectorSource.currentProjectionHash}`;
  const wrongSelectorCommand = materializeCandidateReproductionCommand(reproductionContract, wrongSelectorMarker);
  const wrongSelectorReceipt = await executeReceipt(wrongSelectorCommand, 'wrong-execution-selector');
  const markerOnlySemanticMarker = `candidate-reproduced:${markerOnlySource.candidateId}:${markerOnlySource.currentProjectionHash}`;
  const markerOnlySemanticCommand = materializeCandidateReproductionCommand(markerOnlyContract, markerOnlySemanticMarker);
  const markerOnlySemanticReceipt = await executeReceipt(markerOnlySemanticCommand, markerOnlySelector);
  const promotionFor = (candidateRow: typeof promotionSource, key: string, receipt: typeof reproduced, selector = reproductionSelector) => ({ storyId, idempotencyKey: key,
    candidateId: candidateRow.candidateId, expectedCandidateHash: candidateRow.currentProjectionHash, findingId: finding.id, reviewRunId,
    reproductionExecutionKey: receipt.key.key, reproductionReceiptHash: receipt.receipt.receiptHash,
    reproductionAttestation: { selector, semanticAssertion } });
  test('wrong command is rejected even when output contains exact selector and candidate marker', () => {
    const before = store.readFindingLedger(storyId).records.length;
    assert.throws(() => handlers.finding_candidate_promote(promotionFor(wrongCommandSource, 'promotion-wrong-command', wrongCommandReceipt)), /reproduction receipt/);
    assert.equal(store.readFindingLedger(storyId).records.length, before);
  });
  test('correct command with mismatched execution selector cannot promote', () => {
    const before = store.readFindingLedger(storyId).records.length;
    assert.throws(() => handlers.finding_candidate_promote(promotionFor(wrongSelectorSource, 'promotion-wrong-selector', wrongSelectorReceipt, 'wrong-execution-selector')), /selector|attestation/i);
    assert.equal(store.readFindingLedger(storyId).records.length, before);
  });
  test('preregistered marker-only no-op contract is not semantic reproduction evidence', () => {
    const before = store.readFindingLedger(storyId).records.length;
    const markerOnlyPromotion = promotionFor(markerOnlySource, 'promotion-marker-only-semantic-gap', markerOnlySemanticReceipt, markerOnlySelector);
    const { reproductionAttestation: _omitted, ...receiptOnlyPromotion } = markerOnlyPromotion;
    assert.throws(() => handlers.finding_candidate_promote(receiptOnlyPromotion), /reproductionAttestation|attestation/i);
    assert.equal(store.readFindingLedger(storyId).records.length, before);
  });
  test('current source drift refuses otherwise valid promotion', () => {
    writeFileSync(join(scratch, 'source.mjs'), source + '// drift\n');
    try { assert.throws(() => handlers.finding_candidate_promote(promote), /stale|fresh|material|source/i); }
    finally { writeFileSync(join(scratch, 'source.mjs'), source); }
  });
  const authoritativeBefore = store.readFindings(storyId);
  test('eligible actual reviewer promotes with executed receipt and immutable FindingRef', () => {
    if (section === 'delivery') {
      const before = store.readFindingLedger(storyId).records.length;
      concurrentCli('finding_candidate_promote', promote);
      assert.equal(store.readFindingLedger(storyId).records.length, before + 2);
    }
    const promoted = handlers.finding_candidate_promote(promote);
    const attestationRow = promoted.rows.find(row => row.envelope.kind === 'candidate_reproduction_attestation')!;
    const attestation = attestationRow.envelope.payload;
    validateCandidateReproductionAttestation(attestation);
    verifyIdentityEnvelope(attestationRow.envelope, findingLedgerTrustFromWorkspace(scratch), validateCandidateReproductionAttestation);
    assert.equal(attestation.candidateProjectionHash, promotionSource.currentProjectionHash);
    assert.equal(attestation.reproductionContractHash, identityHash(reproductionContract));
    assert.equal(attestation.reproductionSelector, reproductionSelector);
    assert.equal(attestation.reproductionReceiptHash, reproduced.receipt.receiptHash);
    assert.equal(attestation.findingRef.recordId, finding.recordId);
    assert.equal(attestation.reviewRunId, reviewRunId); assert.equal(attestation.reviewer, lane);
    assert.equal(promoted.candidates[0]!.state, 'promoted');
    assert.equal(promoted.candidates[0]!.promotionFindingRef!.recordId, finding.recordId);
    assert.equal(promoted.candidates[0]!.gateEvidence, false);
    assert.deepEqual(store.readFindings(storyId), authoritativeBefore);
    assert.deepEqual(handlers.finding_candidate_promote(promote).rows, promoted.rows);
  });
  test('signed semantic reproduction attestation rejects binding mutations', () => {
    const row = handlers.finding_candidate_get({ storyId, candidateId: promotionSource.candidateId }).attestations[0]!;
    for (const mutate of [
      (value: any) => { value.payload.candidateProjectionHash = '0'.repeat(64); },
      (value: any) => { value.payload.reproductionContractHash = '0'.repeat(64); },
      (value: any) => { value.payload.reproductionSelector = 'substituted-selector'; },
      (value: any) => { value.payload.reproductionExecutionKey = 'substituted-execution'; },
      (value: any) => { value.payload.reproductionReceiptHash = '0'.repeat(64); },
      (value: any) => { value.payload.findingRef.recordHash = '0'.repeat(64); },
      (value: any) => { value.payload.reviewRunId = 'substituted-run'; },
      (value: any) => { value.payload.reviewer = 'substituted-reviewer'; },
      (value: any) => { value.payload.semanticAssertion = 'Substituted semantic assertion that still satisfies the schema.'; },
    ]) {
      const changed = structuredClone(row.envelope); mutate(changed);
      assert.throws(() => verifyIdentityEnvelope(changed, findingLedgerTrustFromWorkspace(scratch), validateCandidateReproductionAttestation));
    }
  });
  test('same human Finding ID in another Story retains distinct durable identity', () => {
    const otherStoryId = 'B-CANDIDATES-OTHER';
    process.env.PROOF_OR_STOP_AGENT = 'main';
    store.writeStory(otherStoryId, { ...store.readStory(storyId), storyId: otherStoryId, name: 'other-candidate-fixture', phase: 'DEV' });
    acquireOwnerLease(store.storyDirPath(otherStoryId), { command: 'synthetic second Story', cwd: scratch });
    registry.get('finding_add')!({ storyId: otherStoryId, desc: 'Independent source observation: observedDefect returns 2 rather than required 3, using the same local ordinal.', severity: 'high', category: 'edge',
      files: ['source.mjs'], evidenceState: 'verified', idempotencyKey: 'other-real-finding' });
    const otherFinding = store.readFindings(otherStoryId).findings.at(-1)!;
    assert.equal(otherFinding.id.split(':').at(-1), finding.id.split(':').at(-1));
    assert.ok(otherFinding.recordId); assert.notEqual(otherFinding.recordId, finding.recordId);
    assert.throws(() => verifiedIdentityCarrier(store.readFindingLedger(otherStoryId), storyId, otherFinding.recordId!, findingLedgerTrustFromWorkspace(scratch)), /carrier invalid/);
    assert.throws(() => handlers.finding_candidate_get({ storyId: otherStoryId, candidateId: promotionSource.candidateId }), /not found/);
    process.env.PROOF_OR_STOP_AGENT = lane;
    assert.throws(() => handlers.finding_candidate_promote({ ...promote, findingId: otherFinding.id }), /IDEMPOTENCY_CONFLICT/);
    assert.deepEqual(store.readFindings(storyId), authoritativeBefore);
  });
  if (section === 'scorecard' || section === 'delivery') {
    const queryHandlers = createFindingHistoryHandlers(ctx);
    const query = { storyId, sourceStoryIds: [storyId] };
    test('scorecard complete signed carrier inventory is deterministic and descriptive only', () => {
      const value = queryHandlers.finding_identity_scorecard(query); const repeat = queryHandlers.finding_identity_scorecard(query);
      verifyIdentityScorecard(value, repeat); assert.deepEqual(value, repeat);
      assert.deepEqual(value.rowCounts.map(row => row.kind), [...SCORECARD_KINDS]);
      assert.equal(value.rows.length, store.readFindingLedger(storyId).records.filter(row => (SCORECARD_KINDS as readonly string[]).includes(row.recordType)).length);
      assert.ok(value.rows.every(row => row.envelope.signature && row.receipt.signature));
      assert.equal(value.detectorMeasurements[0]!.adjudicatedPromotionFraction.numerator, 1);
      assert.equal(value.detectorMeasurements[0]!.adjudicatedPromotionFraction.denominator, 3);
      assert.equal(value.qualification.precisionRecallMeasured, false); assert.equal(value.qualification.enforceEligible, false);
    });
    test('scorecard refuses missing rows, changed signatures, null laundering and stale current snapshots', () => {
      const value = queryHandlers.finding_identity_scorecard(query);
      for (const mutate of [
        (row: typeof value) => { row.rows.pop(); },
        (row: typeof value) => { row.rows[0]!.envelope.signature = 'forged'; },
        (row: typeof value) => { row.inputBindings[0]!.snapshotDigest = sha('wrong'); },
        (row: typeof value) => { row.detectorMeasurements[0]!.adjudicatedPromotionFraction.observed = 0; },
        (row: typeof value) => { (row.qualification as unknown as Record<string, unknown>).qualifyingWindow = undefined; },
        (row: typeof value) => { row.rows.reverse(); },
      ]) { const bad = structuredClone(value); mutate(bad); assert.throws(() => verifyIdentityScorecard(bad, value)); }
      const rehashed = structuredClone(value); rehashed.rows.pop(); const { digest: _old, ...base } = rehashed; rehashed.digest = scorecardDigest(base);
      assert.throws(() => verifyIdentityScorecard(rehashed, value), /incomplete|tampered/);
      const original = store.readStory(storyId); store.writeStory(storyId, { ...original, title: 'changed current target snapshot' });
      try { assert.throws(() => queryHandlers.finding_identity_scorecard({ ...query, expectedInputDigest: value.inputDigest }), /stale/); }
      finally { store.writeStory(storyId, original); }
    });
    test('zero denominator means insufficient evidence; missing provenance refuses', () => {
      const signal = first.rows.find(row => row.envelope.kind === 'detector_signal')!.envelope.payload as unknown as import('../core/finding-identity-types.js').DetectorSignal;
      const counts = detectorAdjudicationMeasurements([signal], []);
      assert.deepEqual(counts[0]!.adjudicatedPromotionFraction, { numerator: 0, denominator: 0, observed: null, status: 'insufficient_evidence' });
      assert.throws(() => detectorAdjudicationMeasurements([], [candidate]), /missing detector provenance/);
      assert.notEqual(scorecardDigest({ observed: null }), scorecardDigest({}));
      const accessor = [1]; Object.defineProperty(accessor, '0', { get: () => 1, enumerable: true }); assert.throws(() => scorecardDigest(accessor), /array/);
    });
    test('observe/warn and disabled query preserve existing lifecycle projection and immutable ledger', () => {
      const ledger = readFileSync(store.storyFilePath(storyId, 'finding-ledger.json'), 'utf8'); const findings = store.readFindings(storyId);
      const blockers = (values: typeof findings) => [1, 2, 3].map(round => values.findings.filter(row => isFindingBlocking(row, ['critical', 'high', 'medium'], round)).map(row => row.id));
      const previousBlockers = blockers(findings);
      const observed = queryHandlers.finding_identity_scorecard({ ...query, mode: 'observe' });
      const warned = queryHandlers.finding_identity_scorecard({ ...query, mode: 'warn' });
      assert.deepEqual(observed.rows, warned.rows); assert.equal(warned.gateEvidence, false);
      assert.deepEqual(store.readFindings(storyId), findings); assert.equal(readFileSync(store.storyFilePath(storyId, 'finding-ledger.json'), 'utf8'), ledger);
      // Disabling this additive reader is simply not invoking it: the old reader
      // has exactly the same Finding projection and does not consume these rows.
      assert.deepEqual(store.readFindings(storyId), findings);
      assert.deepEqual(blockers(store.readFindings(storyId)), previousBlockers);
      assert.throws(() => queryHandlers.finding_identity_scorecard({ ...query, mode: 'enforce' }));
      verifyIdentityScorecard(queryHandlers.finding_identity_scorecard(query), observed);
    });
    test('signed legacy tuple binding is additive idempotent and collision/hash fail closed', () => {
      process.env.PROOF_OR_STOP_AGENT = 'main';
      const legacyId = 'B-IDENTITY-LEGACY';
      store.writeStory(legacyId, { ...store.readStory(storyId), storyId: legacyId, name: legacyId, phase: 'DONE' });
      const original = { id: 'F-001', desc: 'Historical signed observation; deferred and superseded prose does not confer authority.', status: 'open' as const, severity: 'high' as const,
        category: 'edge' as const, files: ['source.mjs'], createdAt: '2000-01-01T00:00:00.000Z',
        _hash: signFinding(legacyId, 'F-001', 'Historical signed observation; deferred and superseded prose does not confer authority.', 'high', '2000-01-01T00:00:00.000Z', '') };
      store.writeFindings(legacyId, { findings: [original] }); const path = store.storyFilePath(legacyId, 'findings.json'); const bytes = readFileSync(path, 'utf8');
      assert.equal(verifyFinding(legacyId, original), true); assert.equal(isFindingBlocking(original, ['high'], 1), true, 'legacy missing evidenceState remains verified');
      const signer = findingLedgerSignerFromWorkspace(scratch); const lock = store.runtimeLockDirPath(legacyId, 'finding', 'findings');
      const appendBinding = (hash: string, requestKey: string) => withMkdirLock(lock, () => {
        const fence = captureMkdirLockFence(lock);
        return appendFindingLedger({ storyId: legacyId, store, signer, operation: 'append_legacy_identity_binding', idempotencyKey: requestKey,
          writerSessionId: getSessionIdentity().sessionId, writerLeaseId: getSessionIdentity().sessionId, writerFenceToken: fence.writerFenceToken, fence,
          records: [{ recordType: 'legacy_identity_binding', payload: { schemaVersion: 1, bindingType: 'legacy-finding', findingId: original.id, findingHash: hash }, uniqueBindingKey: `legacy-finding:${original.id}` }],
          verifyPredicate: () => ({ accepted: canonicalHash(store.readFindings(legacyId).findings[0]!) === canonicalHash(original), predicateDigest: canonicalHash({ storyId: legacyId, findingId: original.id, findingHash: hash }) }) });
      }, { requireHolderToken: true });
      const hash = canonicalHash(original); const bound = appendBinding(hash, 'legacy-binding');
      assert.deepEqual(appendBinding(hash, 'legacy-binding'), bound);
      assert.throws(() => appendBinding(sha('wrong tuple hash'), 'legacy-collision'), /CONFLICT|binding|predicate/i);
      const projected = store.readFindings(legacyId, { strictMirror: true }).findings[0]!;
      assert.equal(projected.recordId, bound.recordIds[0]); assert.equal(projected._hash, original._hash); assert.equal(projected.id, original.id);
      assert.equal(readFileSync(path, 'utf8'), bytes); assert.equal(isFindingBlocking(projected, ['high'], 1), true);
      const history = queryHandlers.finding_history_query({ storyId, sourceStoryIds: [legacyId] }); assert.equal(history.complete, true);
      assert.equal(history.rows[0]!.ref!.recordId, bound.recordIds[0]); assert.equal(history.rows[0]!.outcome, 'open');
      try { store.writeFindings(legacyId, { findings: [{ ...original, desc: 'changed legacy bytes' }] }); assert.throws(() => store.readFindings(legacyId, { strictMirror: true }), /not authenticated/); }
      finally { writeFileSync(path, bytes); }
      assert.equal(store.readFindingLedger(legacyId).records.length, 1);
      process.env.PROOF_OR_STOP_AGENT = lane;
    });
    test('public scorecard command accepts exact query and rejects authority injection', () => {
      const child = spawnSync(process.execPath, [cliPath, 'finding_identity_scorecard', JSON.stringify(query)], { cwd: scratch, encoding: 'utf8', env: process.env });
      assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`); assert.match(child.stdout, /"complete": true/); assert.match(child.stdout, /"inputDigest"/);
      const bad = spawnSync(process.execPath, [cliPath, 'finding_identity_scorecard', JSON.stringify({ ...query, gateEvidence: true })], { cwd: scratch, encoding: 'utf8', env: process.env });
      assert.notEqual(bad.status, 0); assert.match(bad.stdout + bad.stderr, /gateEvidence|Unrecognized/);
      assert.equal(COMMAND_POLICIES.finding_identity_scorecard!.ownershipClass, 'readOnly');
      for (const phase of ['DEV', 'REVIEW', 'TEST', 'DONE'] as const) assert.equal(isCommandAllowed('finding_identity_scorecard', phase, undefined), true);
    });
    test('delivery source invokes every promised public CLI boundary', () => {
      const deliverySource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
      for (const command of ['finding_identity_query', 'finding_candidate_route', 'finding_route_verify', 'finding_route_reject', 'finding_route_revoke', 'finding_supersession_add', 'finding_identity_supersede'])
        assert.match(deliverySource, new RegExp(`publicCli\\('${command}'`), `missing public CLI exercise for ${command}`);
    });
    test('documented scorecard kind count matches the exported inventory', () => {
      const cliDocs = readFileSync(join(resolve(cliPath, '../..'), 'docs/CLI.md'), 'utf8');
      const documented = cliDocs.match(/scorecard returns all (\d+) declared record-kind counts/);
      assert.ok(documented); assert.equal(Number(documented[1]), SCORECARD_KINDS.length);
    });

    test('frozen acceptance/corpus and measured operation trace reject favorable recount and safety mutations', () => {
      const repo = resolve(cliPath, '../..'); const file = 'packages/main/tests/red/red-b03b7-identity-lineage.mjs';
      const outsideAdapter = (source: string) => {
        const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const adapter = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'greenAdapter');
        assert.ok(adapter); return source.slice(0, adapter.getFullStart()) + '\nGREEN_ADAPTER_PLACEHOLDER\n' + source.slice(adapter.end);
      };
      // Frozen portable harness contract; this does not claim an unavailable historical Store execution.
      const frozenHarnessHash = '499a9490b8fe5bde23e6dd571eb214c91bafbaa24a8f860b3d0839d263271526';
      const actual = readFileSync(join(repo, file), 'utf8'); assert.equal(sha(outsideAdapter(actual)), frozenHarnessHash);
      assert.notEqual(sha(outsideAdapter(actual.replace('trace.baselineOperations > 0', 'true'))), frozenHarnessHash);
      const goldPath = 'packages/main/tests/data/finding-identity-gold-set.mjs';
      assert.equal(sha(readFileSync(join(repo, goldPath), 'utf8')), 'b61fbd4d056dcca4a4a7244455411ebd0e45f2cde81a5d8e8ffdef8a2baf6fe2');
      const replay = spawnSync(process.execPath, [join(repo, file)], { cwd: repo, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024, timeout: 180000 });
      assert.equal(replay.status, 0, replay.stderr + replay.stdout);
      const benchmark = JSON.parse(replay.stdout.split('\n').find(line => line.startsWith('BENCHMARK '))!.slice(10));
      const rows = replay.stdout.split('\n'); assert.ok(rows.some(row => row.startsWith('SUMMARY ') && JSON.parse(row.slice(8)).PASS === 15));
      const counts = benchmark.manualOperations;
      const accept = (value: typeof benchmark) => {
        assert.equal(value.corpusDigest, '9a0f604195d80272811d31e126841426ac0d4f4d59c38265ab6938a044cabb2d');
        assert.deepEqual(value.perDetectorFamily, [
          { detector: 'reviewer-source-reproduction', version: 'frozen-replay-v1', family: 'literal-comparison-parser',
            identityPrecision: { numerator: 40, denominator: 40, observed: 1, status: 'observed_sample_only' },
            identityRecall: { numerator: 40, denominator: 40, observed: 1, status: 'observed_sample_only' },
            retrieval: { precision: { numerator: 8, denominator: 8, observed: 1, status: 'observed_sample_only' }, recall: { numerator: 8, denominator: 8, observed: 1, status: 'observed_sample_only' } } },
          { detector: 'concept-symbol-residue', version: 'frozen-replay-v1', family: 'synthetic_noise_shape',
            precision: { numerator: 0, denominator: 0, observed: null, status: 'insufficient_evidence' },
            recall: { numerator: 0, denominator: 0, observed: null, status: 'insufficient_evidence' },
            noiseAuthorityRejections: { numerator: 3, denominator: 3, observed: 1, status: 'observed_sample_only' } },
        ]);
        assert.deepEqual(value.coarseBaseline, { resultGranularity: 'Story IDs', precision: { numerator: 0, denominator: 4, observed: 0, status: 'observed_sample_only' }, recall: { numerator: 0, denominator: 8, observed: 0, status: 'observed_sample_only' } });
        assert.deepEqual(value.exactIndex, { resultGranularity: 'Finding IDs', precision: { numerator: 8, denominator: 8, observed: 1, status: 'observed_sample_only' }, recall: { numerator: 8, denominator: 8, observed: 1, status: 'observed_sample_only' } });
        const trace = value.manualOperations;
        assert.deepEqual(trace.baselineEvents, counts.baselineEvents); assert.deepEqual(trace.groupedEvents, counts.groupedEvents);
        assert.equal(new Set(trace.groupedEvents.map((row: { id: string }) => row.id)).size, trace.groupedEvents.length);
        assert.equal(trace.baselineOperations, 64); assert.equal(trace.groupedOperations, 51);
        assert.equal(trace.groupingReduction, 13 / 64); assert.equal(trace.jointBatchOperations, null); assert.equal(trace.jointThresholdFulfilled, false);
        assert.equal(value.qualification.enforceEligible, false);
        assert.equal(value.injectedMissedHigh ?? 0, 0); assert.equal(value.injectedFalseDeferral ?? 0, 0); assert.equal(value.injectedAbnormalStall ?? 0, 0);
      };
      accept(benchmark);
      const mutations: ((value: typeof benchmark) => void)[] = [
        value => { value.corpusDigest = sha('changed labels'); },
        value => { value.perDetectorFamily[0].identityPrecision.numerator = 0; },
        value => { value.perDetectorFamily[1].noiseAuthorityRejections.denominator = 4; },
        value => { value.coarseBaseline.precision.numerator = 1; },
        value => { value.exactIndex.recall.denominator = 9; },
        value => { value.manualOperations.baselineOperations = 0; },
        value => { delete value.manualOperations.baselineOperations; },
        value => { value.manualOperations.groupedEvents = value.manualOperations.groupedEvents.filter((row: { kind: string }) => row.kind !== 'source_evidence_review'); },
        value => { value.manualOperations.groupedEvents = value.manualOperations.groupedEvents.filter((row: { kind: string }) => row.kind !== 'identity_confirmation'); },
        value => { value.manualOperations.groupedEvents.push(value.manualOperations.groupedEvents[0]); },
        value => { value.manualOperations.groupingReduction = 0.75; },
        value => { value.manualOperations.jointBatchOperations = 0; value.manualOperations.jointThresholdFulfilled = true; },
        value => { value.injectedMissedHigh = 1; }, value => { value.injectedFalseDeferral = 1; }, value => { value.injectedAbnormalStall = 1; },
      ];
      for (const mutation of mutations) { const bad = structuredClone(benchmark); mutation(bad); assert.throws(() => accept(bad)); }
      console.log(`DELIVERY_BENCHMARK ${JSON.stringify(benchmark)}`);
    });
    console.log(`FINDING_IDENTITY_SCORECARD ${failures ? 'FAIL' : 'PASS'} ${assertions} passing ${failures} failed cases`);
  }
  if (section === 'history' || section === 'delivery') {
    test('strict history mirror read distinguishes malformed mirror with populated ledger', () => {
      const strict = store.readFindings.bind(store) as unknown as (id: string, options: { strictMirror: true }) => ReturnType<StoryStore['readFindings']>;
      const path = store.storyFilePath(storyId, 'findings.json'); const original = readFileSync(path, 'utf8');
      const valid = strict(storyId, { strictMirror: true }); assert.ok(valid.findings.length > 0);
      const emptyId = 'B-HISTORY-EMPTY'; store.writeStory(emptyId, { ...store.readStory(storyId), storyId: emptyId, name: emptyId, phase: 'DONE' });
      store.writeFindings(emptyId, { findings: [] }); assert.deepEqual(strict(emptyId, { strictMirror: true }), { findings: [] });
      try {
        writeFileSync(path, '{malformed-mirror-with-valid-signed-ledger');
        assert.deepEqual(store.readFindings(storyId), valid, 'baseline default read hides mirror corruption behind identical signed ledger rows');
        assert.throws(() => strict(storyId, { strictMirror: true }), /JSON|mirror|parse|Syntax|property/);
      } finally { writeFileSync(path, original); }
      assert.deepEqual(strict(storyId, { strictMirror: true }), valid);
    });
    console.log(`FINDING_HISTORY_MIRROR_PORT ${failures ? 'FAIL' : 'PASS'}`);
  }
  if (section === 'routes' || section === 'history' || section === 'delivery') {
    const routes = createFindingRouteHandlers(ctx);
    const refOf = (row: { record: { recordId: string }; envelope: { storyId: string } }) => ({ storyId: row.envelope.storyId, recordId: row.record.recordId, recordHash: exactLedgerRecordHash(row.record as never) });
    const findingRecord = store.readFindingLedger<JsonValue>(storyId).records.find(row => row.recordId === finding.recordId)!;
    const member = { storyId, findingId: finding.id, recordId: findingRecord.recordId, recordHash: exactLedgerRecordHash(findingRecord) };
    const independentFinding = store.readFindings('B-CANDIDATES-OTHER').findings.at(-1)!;
    const independentRecord = store.readFindingLedger<JsonValue>('B-CANDIDATES-OTHER').records.find(row => row.recordId === independentFinding.recordId)!;
    const independentMember = { storyId: 'B-CANDIDATES-OTHER', findingId: independentFinding.id, recordId: independentRecord.recordId, recordHash: exactLedgerRecordHash(independentRecord) };
    const confirm = { storyId, idempotencyKey: 'confirm-identity', title: 'Observed value defect', triggerCondition: 'Call observedDefect()', reproduction: 'Observed 2, expected 3',
      rootCauseState: 'unknown', identityEvidenceRefs: [reproduced.receipt.receiptHash], evidenceAnchors: [anchor], affectedSymbols: ['observedDefect'],
      affectedContracts: ['return-three'], memberFindingRefs: [member, independentMember], canonicalFindingRef: member, reviewRunId };
    if (section === 'delivery') {
      const before = store.readFindingLedger(storyId).records.length;
      concurrentCli('finding_identity_confirm', confirm);
      assert.equal(store.readFindingLedger(storyId).records.length, before + 1);
    }
    const confirmed = handlers.finding_identity_confirm(confirm); const canonicalRow = confirmed.rows[0]!; validateCanonicalDefect(canonicalRow.envelope.payload);
    const canonical = canonicalRow.envelope.payload; const canonicalRef = refOf(canonicalRow);
    test('canonical confirmation distinguishes suggestions and forbids competing membership', () => {
      assert.equal(canonical.rootCauseState, 'unknown'); assert.equal(canonical.rootCause, undefined);
      assert.equal(canonical.memberFindingRefs.length, 2); assert.ok(canonical.sourceLineageKeys.length >= 2);
      assert.equal(handlers.finding_identity_query({ storyId }).reviewer_confirmed.length, 1);
      assert.ok(handlers.finding_identity_query({ storyId }).suggested.length);
      if (section === 'delivery') assert.deepEqual(publicCli('finding_identity_query', { storyId }).reviewer_confirmed, handlers.finding_identity_query({ storyId }).reviewer_confirmed);
      assert.deepEqual(handlers.finding_identity_confirm(confirm).rows, confirmed.rows);
      assert.throws(() => handlers.finding_identity_confirm({ ...confirm, idempotencyKey: 'conflicting-canonical' }), /already confirmed/);
      for (const input of [{ ...confirm, rootCause: 'invented' }, { ...confirm, rootCauseState: 'confirmed' }, { ...confirm, rootCauseState: 'hypothesized', rootCause: 'TBD' }, { ...confirm, identityEvidenceRefs: [] }]) assert.throws(() => handlers.finding_identity_confirm(input));
      assertCauseEvidence({ ...canonical, rootCauseState: 'hypothesized', rootCause: 'Arithmetic literal differs from contract' });
    });
    process.env.PROOF_OR_STOP_AGENT = 'main';
    const pending = handlers.finding_candidate_add({ ...add, idempotencyKey: 'route-source' });
    const pendingRow = pending.rows.find(row => row.envelope.kind === 'candidate')!; validateCandidate(pendingRow.envelope.payload);
    const sourceRef: RouteSource = { ...refOf(pendingRow), subjectKind: 'candidate_finding', subjectId: pendingRow.envelope.payload.candidateId, subjectHash: pendingRow.envelope.payload.currentProjectionHash };
    const targetId = 'B-ROUTE-TARGET'; const metaId = 'B-META-route-fixture'; const targetItemId = 'CHK-001';
    for (const id of [targetId, metaId]) {
      store.writeStory(id, { ...store.readStory(storyId), storyId: id, name: id, phase: 'DEV' });
      store.writeChecklist(id, { items: [{ id: targetItemId, title: 'Repair observed value', context: 'Defect-bound synthetic target responsibility.', status: 'pending', startTime: null, endTime: null,
        files: { modify: ['source.mjs'], create: [], test: [] }, verificationIntent: { happy: [{ desc: 'Returns 3 rather than reproduced 2', type: 'cli', priority: 'must' }], edge: [], adversarial: [] } }] });
    }
    const sourceSession = process.env.PROOF_OR_STOP_SESSION_ID!;
    const switchSession = (session: string) => { process.env.PROOF_OR_STOP_SESSION_ID = session; resetSessionIdForTest(); };
    const targetSession = `${sourceSession}-target`;
    switchSession(targetSession); acquireOwnerLease(store.storyDirPath(targetId), { command: 'synthetic target owner', cwd: scratch });
    const subject = { affectedContractRefs: ['CHK-001:happy:0'], targetChecklistItemRefs: ['CHK-001'], targetAcceptanceRefs: [], sourcePaths: ['source.mjs'] };
    const accept = { storyId: targetId, idempotencyKey: 'candidate-consent', source: sourceRef, targetItemId, subject, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
    const consent = routes.finding_route_accept(accept); const consentRow = consent.rows[0]!; validateRouteReceipt(consentRow.envelope.payload);
    const consentRef = refOf(consentRow);
    test('standalone target receipt is signed non-gate and exact-idempotent', () => {
      validateRouteReceipt(consentRow.envelope.payload);
      assert.equal(consent.rows.length, 1); assert.equal(consentRow.envelope.payload.evidenceAuthority.profile, 'candidate_route');
      assert.equal(consentRow.envelope.payload.initialProgressBaselineSet, undefined);
      assert.deepEqual(routes.finding_route_accept(accept).rows, consent.rows);
      assert.equal(routes.finding_route_verify({ storyId: targetId, receipt: consentRef }).valid, true);
      if (section === 'delivery') assert.equal(publicCli('finding_route_verify', { storyId: targetId, receipt: consentRef }).valid, true);
      switchSession(sourceSession);
      assert.throws(() => routes.finding_route_accept({ ...accept, idempotencyKey: 'source-self-sign' }), /owner/);
      switchSession(targetSession);
    });
    switchSession(sourceSession);
    const candidateRoute = { storyId, idempotencyKey: 'candidate-route', candidate: sourceRef, receipt: consentRef, uncertaintyReason: 'Suspected only; repair belongs to target.', evidenceRefs: ['source.mjs:1'], severity: 'low', recheckTriggers: ['owner_invalid', 'expiry_reached'] };
    test('candidate routes without promotion or GREEN; exact CAS leaves receipt alone on failure', () => {
      const routed = routes.finding_candidate_route(candidateRoute); assert.equal(routed.rows.length, 1);
      assert.deepEqual(routes.finding_candidate_route(candidateRoute).rows, routed.rows);
      if (section === 'delivery') assert.deepEqual(publicCli('finding_candidate_route', candidateRoute).rows, routed.rows);
      const count = store.readFindingLedger(storyId).records.length;
      assert.throws(() => routes.finding_candidate_route({ ...candidateRoute, idempotencyKey: 'wrong-receipt', receipt: { ...consentRef, recordHash: '0'.repeat(64) } }), /substituted/);
      assert.throws(() => routes.finding_candidate_route({ ...candidateRoute, uncertaintyReason: '' }));
      assert.equal(store.readFindingLedger(storyId).records.length, count);
      assert.deepEqual(store.readFindings(storyId), authoritativeBefore);
    });
    switchSession(targetSession);
    test('expiry boundary and signed receipt mutations refuse', () => {
      const receipt = consentRow.envelope.payload as RouteReceipt;
      assert.throws(() => assertReceiptCurrent(receipt, receipt.target, Date.parse(receipt.expiresAt)), /expired/);
      for (const value of [{ ...receipt, gateEvidence: true }, { ...receipt, rejectedAt: receipt.acceptedAt }, { ...receipt, target: { ...receipt.target, id: storyId } }, { ...receipt, source: { ...receipt.source, subjectKind: 'finding_assessment_proposal' } }]) assert.throws(() => validateRouteReceipt(value));
    });
    test('live target scope/state/policy and source drift invalidate exact consent', () => {
      const checklist = store.readChecklist(targetId); const story = store.readStory(targetId);
      const policy = COMMAND_POLICIES.finding_route_accept as unknown as { allowedPhases: readonly string[] }; const phases = policy.allowedPhases;
      try {
        store.writeChecklist(targetId, { ...checklist, items: checklist.items.map(item => ({ ...item, context: `${item.context} Changed scope.` })) });
        assert.throws(() => routes.finding_route_verify({ storyId: targetId, receipt: consentRef }), /stale|snapshot|moved/);
        store.writeChecklist(targetId, checklist);
        store.writeStory(targetId, { ...story, phase: 'TEST' });
        assert.throws(() => routes.finding_route_verify({ storyId: targetId, receipt: consentRef }), /stale|snapshot|moved/);
        store.writeStory(targetId, story);
        policy.allowedPhases = ['DEV'];
        assert.throws(() => routes.finding_route_verify({ storyId: targetId, receipt: consentRef }), /stale|snapshot|moved/);
        policy.allowedPhases = phases;
        writeFileSync(join(scratch, 'source.mjs'), `${source}// material/source drift\n`);
        assert.throws(() => routes.finding_route_verify({ storyId: targetId, receipt: consentRef }), /source|anchor/);
      } finally { store.writeChecklist(targetId, checklist); store.writeStory(targetId, story); policy.allowedPhases = phases; writeFileSync(join(scratch, 'source.mjs'), source); }
      assert.equal(routes.finding_route_verify({ storyId: targetId, receipt: consentRef }).valid, true);
      assert.throws(() => routes.finding_route_accept({ ...accept, idempotencyKey: 'cycle-to-source', storyId }), /cyclic|owner|responsibility/);
    });
    const revoked = routes.finding_route_revoke({ storyId: targetId, idempotencyKey: 'revoke', receipt: consentRef, reason: 'target_rejected' });
    test('revocation supersedes immutable consent and blocks later CAS', () => {
      assert.equal(revoked.rows.length, 1); switchSession(sourceSession);
      assert.throws(() => routes.finding_candidate_route({ ...candidateRoute, idempotencyKey: 'late-route' }), /superseded/);
      switchSession(targetSession);
      assert.deepEqual(routes.finding_route_revoke({ storyId: targetId, idempotencyKey: 'revoke', receipt: consentRef, reason: 'target_rejected' }).rows, revoked.rows);
      if (section === 'delivery') assert.deepEqual(publicCli('finding_route_revoke', { storyId: targetId, idempotencyKey: 'revoke', receipt: consentRef, reason: 'target_rejected' }).rows, revoked.rows);
      assert.throws(() => routes.finding_route_verify({ storyId: targetId, receipt: consentRef }), /superseded/);
    });
    test('canonical B-META public consent requires no Story owner lease', () => {
      assert.equal(existsSync(store.storyFilePath(metaId, 'owner-lease.json')), false);
      const child = spawnSync(process.execPath, [cliPath, 'finding_route_accept', JSON.stringify({ ...accept, storyId: metaId, idempotencyKey: 'meta-consent' })], { cwd: scratch, encoding: 'utf8', env: process.env });
      assert.equal(child.status, 0, child.stderr + child.stdout);
      assert.equal(existsSync(store.storyFilePath(metaId, 'owner-lease.json')), false, 'canonical main authority must not fabricate Story ownership');
    });
    switchSession(sourceSession);
    const independentCandidates = ['second', 'third'].map(label => {
      const result = handlers.finding_candidate_add({ ...add, idempotencyKey: `independent-${label}`, signal: { ...add.signal, sourceIds: [`route-${label}`] } });
      const row = result.rows.find(row => row.envelope.kind === 'candidate')!; validateCandidate(row.envelope.payload);
      return { ...refOf(row), subjectKind: 'candidate_finding' as const, subjectId: row.envelope.payload.candidateId, subjectHash: row.envelope.payload.currentProjectionHash };
    });
    switchSession(targetSession);
    const independentReceipts = independentCandidates.map((source, index) => routes.finding_route_accept({ ...accept, source, idempotencyKey: `independent-consent-${index}` }));
    test('independent candidates may share a target; rejected consent never authorizes CAS', () => {
      assert.equal(independentReceipts.length, 2);
      const rejected = routes.finding_route_reject({ ...accept, source: independentCandidates[0]!, idempotencyKey: 'reject-independent', predecessor: refOf(independentReceipts[0]!.rows[0]!) });
      const row = rejected.rows[0]!; validateRouteReceipt(row.envelope.payload); assert.equal(row.envelope.payload.decision, 'rejected');
      if (section === 'delivery') assert.deepEqual(publicCli('finding_route_reject', { ...accept, source: independentCandidates[0]!, idempotencyKey: 'reject-independent', predecessor: refOf(independentReceipts[0]!.rows[0]!) }).rows, rejected.rows);
      switchSession(sourceSession);
      assert.throws(() => routes.finding_candidate_route({ ...candidateRoute, idempotencyKey: 'rejected-cas', candidate: independentCandidates[0]!, receipt: refOf(row) }), /rejected/);
      switchSession(targetSession);
    });
    const racedReceipt = independentReceipts[1]!.rows[0]!; const raceBefore = store.readFindingLedger(storyId).records.length;
    const raceChild = withIdentityLedgerLocks([{ ctx, storyId: targetId }], () => {
      const child = spawn(process.execPath, [cliPath, 'finding_candidate_route', JSON.stringify({ ...candidateRoute, idempotencyKey: 'raced-cas', candidate: independentCandidates[1]!, receipt: refOf(racedReceipt) })],
        { cwd: scratch, env: { ...process.env, PROOF_OR_STOP_SESSION_ID: sourceSession }, stdio: ['ignore', 'pipe', 'pipe'] });
      const completion = new Promise<{ code: number | null; output: string }>(resolve => {
        let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.on('close', code => resolve({ code, output }));
      });
      routes.finding_route_revoke({ storyId: targetId, idempotencyKey: 'race-winning-revoke', receipt: refOf(racedReceipt), reason: 'target_rejected' });
      return completion;
    });
    const raced = await raceChild;
    test('controlled real CLI CAS race loses to target revocation without route publication', () => {
      assert.notEqual(raced.code, 0, raced.output); assert.match(raced.output, /superseded/);
      assert.equal(store.readFindingLedger(storyId).records.length, raceBefore);
    });
    test('commit-predicate interleavings reject supersession expiry target and source movement', () => {
      const original = StoryStore.prototype.transactFindingLedger;
      const realNow = Date.now;
      for (const mutation of ['supersession', 'expiry', 'target-state', 'source-bytes'] as const) {
        switchSession(sourceSession);
        const candidate = handlers.finding_candidate_add({ ...add, idempotencyKey: `cas-interleave-${mutation}`, signal: { ...add.signal, sourceIds: [`interleave-${mutation}`] } });
        const row = candidate.rows.find(row => row.envelope.kind === 'candidate')!; validateCandidate(row.envelope.payload);
        const candidateSource: RouteSource = { ...refOf(row), subjectKind: 'candidate_finding', subjectId: row.envelope.payload.candidateId, subjectHash: row.envelope.payload.currentProjectionHash };
        switchSession(targetSession);
        const request = { ...accept, idempotencyKey: `interleave-consent-${mutation}`, source: candidateSource, expiresAt: new Date(Date.now() + 60000).toISOString() };
        const accepted = routes.finding_route_accept(request); const receipt = refOf(accepted.rows[0]!);
        const before = store.readFindingLedger(storyId).records.filter(row => row.recordType === 'candidate_route').length;
        const priorTarget = store.readStory(targetId); const priorReceipt = accepted.rows[0]!.record;
        let injected = false;
        try {
          StoryStore.prototype.transactFindingLedger = function(id, fence, prepare, options) {
            if (id === storyId && !injected) {
              injected = true;
              if (mutation === 'supersession') {
                switchSession(targetSession);
                routes.finding_route_reject({ ...request, idempotencyKey: 'interleaved-rejection', predecessor: receipt });
                switchSession(sourceSession);
              } else if (mutation === 'expiry') Date.now = () => Date.parse(request.expiresAt) + 1;
              else if (mutation === 'target-state') store.writeStory(targetId, { ...priorTarget, phase: 'TEST' });
              else writeFileSync(join(scratch, 'source.mjs'), 'export function observedDefect() { return 999; }\n');
            }
            return original.call(this, id, fence, prepare as never, options) as never;
          };
          switchSession(sourceSession);
          assert.throws(() => routes.finding_candidate_route({ ...candidateRoute, idempotencyKey: `interleaved-cas-${mutation}`, candidate: candidateSource, receipt }), `transaction admission mutation must refuse: ${mutation}`);
          assert.equal(injected, true, 'mutation must occur after initial handler preflight at transaction admission');
          assert.equal(store.readFindingLedger(storyId).records.filter(row => row.recordType === 'candidate_route').length, before);
          assert.deepEqual(store.readFindingLedger(targetId).records.find(row => row.recordId === priorReceipt.recordId), priorReceipt);
        } finally { StoryStore.prototype.transactFindingLedger = original; Date.now = realNow; store.writeStory(targetId, priorTarget); writeFileSync(join(scratch, 'source.mjs'), source); switchSession(targetSession); }
      }
    });
    // Real 3A proposal append: no Story1 final assessment, no mocked receipt.
    switchSession(sourceSession); process.env.PROOF_OR_STOP_AGENT = lane;
    const signer = findingLedgerSignerFromWorkspace(scratch); const routeTrust = findingLedgerTrustFromWorkspace(scratch); const snapshotNow = identitySourceSnapshot(ctx);
    const authorityDigest = proposalAuthorityDigest(lane); const issuedAt = new Date().toISOString();
    const findingIdentity = { storyId, findingId: finding.id, recordId: findingRecord.recordId };
    const currentFindingHash = proposalFindingHash(ctx, member);
    const bundle = { sourceFinding: { ...findingIdentity, hash: currentFindingHash, version: 'v1' }, proofPolicyDigest: sha('synthetic-proof-policy'), reviewerAuthorityPolicyDigest: authorityDigest,
      ledgerSnapshotDigest: store.readFindingLedger(storyId).committedLedgerDigest };
    const proposal = signAssessmentProposal({ schemaVersion: 1, proposalId: 'proposal-route-fixture', findingRef: findingIdentity, findingHash: currentFindingHash, findingVersion: 'v1', evaluationScope: 'target_story', owner: 'other_story',
      issuedAt, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), freshnessPolicyVersion: 'v1', maxAgeSeconds: 3600,
      dependencyBundle: { ...bundle, digest: canonicalHash(bundle) }, evidenceRefs: [reproduced.receipt.receiptHash], historicalSourceRefs: [], protectedSurfaceEvaluation: [],
      reviewRunId, reviewRound: store.readStory(storyId).currentReviewRound, scopeDigest: proposalScopeDigest(ctx, storyId), ...snapshotNow, storyFilesHash: currentStoryFilesHash(scratch, 'HEAD', scratch),
      runtimeReceiptIds: [], assessedBy: lane, proposalSigner: { actorId: lane, authorityDigest, keyId: `assessment-proposal-${canonicalHash({ publicKey: signer.publicKey }).slice(0, 24)}`,
        algorithm: 'ed25519', trustRootDigest: canonicalHash({ profile: 'assessment-proposal-trust-root-v1', publicKey: signer.publicKey }) },
      verdict: 'out_of_scope', basis: 'decision_scope', excludedScopeProofDigest: sha('synthetic-target-scope') }, signer.privateKey);
    const proposalLock = store.runtimeLockDirPath(storyId, 'finding', 'findings');
    const proposalReceipt = withMkdirLock(proposalLock, () => appendAssessmentProposal({ storyId, store, idempotencyKey: 'real-route-proposal',
      proposal, proposalPublicKey: signer.publicKey, expectedAuthorityDigest: authorityDigest, writerSessionId: getSessionIdentity().sessionId,
      writerLeaseId: sourceSession, writerFenceToken: captureMkdirLockFence(proposalLock).writerFenceToken, fence: captureMkdirLockFence(proposalLock), signer }), { requireHolderToken: true });
    const proposalRecord = store.readFindingLedger<JsonValue>(storyId).records.find(row => row.recordId === proposalReceipt.recordIds[0])!;
    const proposalRef: RouteSource = { storyId, recordId: proposalRecord.recordId, recordHash: exactLedgerRecordHash(proposalRecord), subjectKind: 'finding_assessment_proposal', subjectId: String(proposal.proposalId), subjectHash: String(proposal.proposalDigest) };
    test('finding-route proposal exact union signature receipt and ledger carrier tamper refuse with zero target delta', () => {
      const verifyOptions = { publicKey: routeTrust.publicKey, expectedAuthorityDigest: authorityDigest,
        expectedFindingHash: currentFindingHash, expectedHeadHash: snapshotNow.headHash, expectedMaterialHash: snapshotNow.materialHash,
        expectedStoryFilesHash: currentStoryFilesHash(scratch, 'HEAD', scratch)!, receipt: proposalReceipt, receiptTrust: routeTrust,
        proposalRecord, requireReceipt: true, receiptIsCurrent: true };
      assert.equal(verifyAssessmentProposal(proposal, verifyOptions).valid, true);
      const malformedUnion = { ...proposal, verdict: 'duplicate' };
      assert.equal(verifyAssessmentProposal(malformedUnion, verifyOptions).rejection, 'proposal_exact_union_invalid');
      assert.equal(verifyAssessmentProposal({ ...proposal, proposalSignature: 'tampered' }, verifyOptions).rejection, 'proposal_signature_invalid');
      assert.equal(verifyAssessmentProposal(proposal, { ...verifyOptions, receipt: { ...proposalReceipt, signature: 'tampered' } }).rejection, 'proposal_receipt_invalid');
      assert.equal(verifyAssessmentProposal(proposal, { ...verifyOptions, proposalRecord: { ...proposalRecord, payload: { ...proposal, basis: 'canonical_duplicate' } } }).rejection, 'proposal_receipt_invalid');

      const targetLedgerBefore = store.readFindingLedger(targetId);
      const sourceLedgerPath = store.findingLedgerPath(storyId); const sourceLedgerBytes = readFileSync(sourceLedgerPath, 'utf8');
      try {
        const tamperedCarrier = JSON.parse(sourceLedgerBytes) as { records: Array<{ recordId: string; payload: Record<string, unknown> }> };
        const record = tamperedCarrier.records.find(row => row.recordId === proposalRecord.recordId)!;
        record.payload = { ...record.payload, proposalSignature: 'tampered-ledger-carrier' };
        writeFileSync(sourceLedgerPath, JSON.stringify(tamperedCarrier, null, 2));
        process.env.PROOF_OR_STOP_AGENT = 'main'; switchSession(targetSession);
        assert.throws(() => routes.finding_route_accept({ ...accept, idempotencyKey: 'tampered-proposal-carrier', source: proposalRef, canonicalDefect: canonicalRef,
          subject: { ...subject, command: { executable: process.execPath, args: [], selector: 'TARGET_TEST_PASS' } } }));
        assert.deepEqual(store.readFindingLedger(targetId), targetLedgerBefore);
      } finally {
        writeFileSync(sourceLedgerPath, sourceLedgerBytes); process.env.PROOF_OR_STOP_AGENT = 'main'; switchSession(targetSession);
      }
    });
    process.env.PROOF_OR_STOP_AGENT = 'main'; switchSession(targetSession);
    const targetMarker = `defect-progress:${canonical.canonicalDefectId}:${targetItemId}`;
    const targetCommand = { executable: process.execPath, args: ['--input-type=module', '-e', `import {observedDefect} from './source.mjs'; if(observedDefect()!==2) process.exit(1); console.log(${JSON.stringify(targetMarker)}); console.log('TARGET_TEST_PASS'); if(process.env.B03B7_FORCE_TARGET_TEST_FAILURE==='1') process.exitCode=1;`], shell: false };
    async function runTargetTest(attempt: string, forceFailure = false) {
      const snap = identitySourceSnapshot(ctx); const filesHash = currentStoryFilesHash(scratch, 'HEAD', scratch)!;
      const effectiveEnvironment: Record<string, string> = forceFailure ? { B03B7_FORCE_TARGET_TEST_FAILURE: '1' } : {};
      const identity = { storyId: targetId, cwd: scratch, command: targetCommand, bootstrap: null, inputs: { materialHash: snap.materialHash, attempt }, storyFilesHash: filesHash,
        effectiveEnvironment, runtimeVersion: process.version, toolVersion: 'route-smoke-v1', selectorPolicy: DEFAULT_CAUSAL_SELECTOR_POLICY };
      const indexPath = join(scratch, '.git', 'index');
      const revalidate = () => identitySourceSnapshot(ctx).materialHash === snap.materialHash;
      const preflight = preflightCausalEvidence({ cli: { available: true, path: process.execPath }, worktree: { expected: scratch, actual: process.cwd() },
        gitIndex: { readable: true, path: indexPath, contentDigest: createHash('sha256').update(readFileSync(indexPath)).digest('hex') }, gitMaterial: { available: true, ...snap, storyFilesHash: filesHash },
        writerLease: { available: true, valid: true }, providerCapability: { required: ['node'], available: ['node'] }, resources: { required: {}, available: {} },
        evidenceTarget: { writable: true, path: store.storyDirPath(targetId) }, sideChannel: { available: true, maxOutputChars: 10000, maxProgressEvents: 10 } }, revalidate, identity);
      return executeCausalEvidence({ identity, selector: 'TARGET_TEST_PASS', preflight, revalidateBeforeRun: revalidate, receiptStore: store, run: async () => {
        const child = spawnSync(targetCommand.executable, targetCommand.args, { cwd: scratch, encoding: 'utf8', env: { ...process.env, ...effectiveEnvironment } }); return { code: child.status ?? 2, output: child.stdout + child.stderr };
      } });
    }
    const oldTargetTest = await runTargetTest('before-baseline');
    const findingAccept = { ...accept, idempotencyKey: 'finding-consent', source: proposalRef, canonicalDefect: canonicalRef,
      subject: { ...subject, command: { executable: targetCommand.executable, args: targetCommand.args, selector: 'TARGET_TEST_PASS' } } };
    test('corrupt optional evidence refuses; unrelated genuine test evidence is not selected as this baseline', () => {
      for (const file of ['test-evidence.json', 'delivery-check.json']) {
        const path = store.storyFilePath(targetId, file);
        try {
          writeFileSync(path, '{synthetic malformed optional evidence');
          assert.throws(() => routes.finding_route_accept(findingAccept), /corrupt|untrusted/);
        } finally { rmSync(path, { force: true }); }
      }
      store.writeTestEvidence(targetId, { command: targetCommand.executable, output: oldTargetTest.receipt.outputProbe,
        result: 'PASS', timestamp: oldTargetTest.receipt.executedAt });
      // No exact checklist evidence reference selects this Story-level compatibility row.
    });
    test('six initial row-preparation fault points publish no partial receipt/baseline set', () => {
      const original = StoryStore.prototype.transactFindingLedger;
      const before = store.readFindingLedger(targetId).records.length;
      try {
        for (let fault = 0; fault < 6; fault++) {
          StoryStore.prototype.transactFindingLedger = function(id, fence, prepare, options) {
            return original.call(this, id, fence, current => {
              const prepared = prepare(current as never);
              if (id === targetId && prepared.plan.action === 'append') {
                const appended = prepared.plan.envelope.records.slice(current.records.length);
                assert.equal(appended.length, 6);
                for (let index = 0; index < appended.length; index++) {
                  assert.ok(appended[index]!.payloadHash);
                  if (index === fault) throw new Error(`synthetic-initial-row-fault-${fault}`);
                }
              }
              return prepared as never;
            }, options) as never;
          };
          assert.throws(() => routes.finding_route_accept(findingAccept), new RegExp(`synthetic-initial-row-fault-${fault}`));
          assert.equal(store.readFindingLedger(targetId).records.length, before);
        }
      } finally { StoryStore.prototype.transactFindingLedger = original; }
    });
    test('actual atomic publication failure and lost committed result preserve exact retry', () => {
      const original = StoryStore.prototype.transactFindingLedger;
      const before = store.readFindingLedger(targetId).records.length;
      try {
        StoryStore.prototype.transactFindingLedger = function(id, fence, prepare, options) {
          return original.call(this, id, fence, prepare as never, { ...options, beforeRename: () => { if (id === targetId) throw new Error('synthetic-before-rename'); } }) as never;
        };
        assert.throws(() => routes.finding_route_accept(findingAccept), /synthetic-before-rename/);
        assert.equal(store.readFindingLedger(targetId).records.length, before);
        StoryStore.prototype.transactFindingLedger = function(id, fence, prepare, options) {
          const result = original.call(this, id, fence, prepare as never, options);
          if (id === targetId) throw new Error('synthetic-result-lost-after-commit');
          return result as never;
        };
        assert.throws(() => routes.finding_route_accept(findingAccept), /synthetic-result-lost-after-commit/);
        assert.equal(store.readFindingLedger(targetId).records.length, before + 6);
      } finally { StoryStore.prototype.transactFindingLedger = original; }
      const committed = store.readFindingLedger(targetId);
      const replay = routes.finding_route_accept(findingAccept);
      assert.equal(replay.rows.length, 6);
      assert.deepEqual(store.readFindingLedger(targetId), committed);
      assert.deepEqual(routes.finding_route_accept(findingAccept).rows, replay.rows);
    });
    const findingConsent = routes.finding_route_accept(findingAccept); const findingConsentRow = findingConsent.rows.find(row => row.envelope.kind === 'route_receipt')!;
    const initialSetRow = findingConsent.rows.find(row => row.envelope.kind === 'progress_baseline_set')!;
    const findingConsentRef = refOf(findingConsentRow); const setRef = refOf(initialSetRow);
    test('initial finding acceptance atomically publishes receipt plus four signed baselines and set', () => {
      if (section === 'delivery') assert.deepEqual(publicCli('finding_route_accept', findingAccept).rows, findingConsent.rows);
      assert.equal(findingConsent.rows.length, 6); validateBaselineSet(initialSetRow.envelope.payload, findingLedgerTrustFromWorkspace(scratch));
      verifyIdentityEnvelope(initialSetRow.envelope, routeTrust, value => validateBaselineSet(value, routeTrust));
      const set = initialSetRow.envelope.payload;
      assert.deepEqual(set.baselines.map(row => (row.payload as ProgressBaseline).kind), [...PROGRESS_KINDS]);
      assert.equal((set.baselines[1]!.payload as ProgressBaseline).projectionState, 'absent');
      assert.equal((set.baselines[2]!.payload as ProgressBaseline).projectionState, 'absent');
      assert.equal(routes.finding_route_verify({ storyId: targetId, receipt: findingConsentRef }).valid, true);
      assert.deepEqual(routes.finding_route_accept(findingAccept).rows, findingConsent.rows);
      for (const value of [{ ...set, gateEvidence: true }, { ...set, baselines: set.baselines.slice(1) }, { ...set, baselines: [...set.baselines].reverse() }]) assert.throws(() => validateBaselineSet(value, routeTrust));
      const before = set.baselines[1]!.payload as ProgressBaseline;
      for (const changes of [{ absenceDigest: sha('wrong-absence') }, { projectionState: 'present' }, { capturedAt: new Date(Date.now() + 60000).toISOString() },
        { projectionDigest: sha('forbidden-absent-field') }, { signedBy: 'source-author' },
        { evidenceAuthority: { profile: 'receipt', authority: 'L4', gateEvidence: true } }]) {
        const { baselineHash: _hash, ...base } = { ...before, ...changes };
        assert.throws(() => validateBaseline({ ...base, baselineHash: identityHash(base) }));
      }
    });
    test('baseline subject entry and set hash/signature mutations refuse even when the nested subject is validly re-signed', () => {
      const originalSet = initialSetRow.envelope.payload as BaselineSet;
      const originalEntry = originalSet.baselines[0]! as unknown as IdentitySemanticEnvelope<ProgressBaseline>;
      const originalBaseline = originalEntry.payload;
      const subject = { ...originalBaseline.subject, targetChecklistItemRefs: ['CHK-999-UNRELATED'] };
      const { baselineHash: _baselineHash, ...baselineBase } = { ...originalBaseline, subject };
      const baseline = { ...baselineBase, baselineHash: identityHash(baselineBase) };
      const resignedEntry = signIdentityEnvelope({ kind: 'progress_baseline', storyId: originalEntry.storyId,
        requestDigest: originalEntry.requestDigest, producedAt: originalEntry.producedAt, payload: baseline }, signer, validateBaseline);
      verifyIdentityEnvelope(resignedEntry, routeTrust, validateBaseline);
      const { baselineSetHash: _setHash, ...setBase } = { ...originalSet,
        baselines: [resignedEntry, ...originalSet.baselines.slice(1)] };
      assert.throws(() => validateBaselineSet({ ...setBase, baselineSetHash: identityHash(setBase) }, routeTrust), /subject|capture|mismatch/);

      const badEntrySignature = structuredClone(originalSet);
      badEntrySignature.baselines[0]!.signature = 'tampered';
      assert.throws(() => validateBaselineSet(badEntrySignature, routeTrust));
      const badEntryHash = structuredClone(originalSet);
      (badEntryHash.baselines[0]!.payload as ProgressBaseline).baselineHash = sha('tampered-entry-hash');
      assert.throws(() => validateBaselineSet(badEntryHash, routeTrust));
      assert.throws(() => verifyIdentityEnvelope({ ...initialSetRow.envelope, signature: 'tampered' }, routeTrust,
        value => validateBaselineSet(value, routeTrust)));
      const badSetHash = { ...originalSet, baselineSetHash: sha('tampered-set-hash') };
      assert.throws(() => validateBaselineSet(badSetHash, routeTrust));
    });
    test('finding renewal binds fresh target progress without inventing another initial baseline', () => {
      const renewalId = 'B-ROUTE-RENEWAL';
      store.writeStory(renewalId, { ...store.readStory(targetId), storyId: renewalId, name: renewalId });
      store.writeChecklist(renewalId, store.readChecklist(targetId));
      acquireOwnerLease(store.storyDirPath(renewalId), { command: 'synthetic renewal owner', cwd: scratch });
      const request = { ...findingAccept, storyId: renewalId, idempotencyKey: 'renewal-initial' };
      const initial = routes.finding_route_accept(request);
      const receipt = refOf(initial.rows.find(row => row.envelope.kind === 'route_receipt')!);
      const baseline = refOf(initial.rows.find(row => row.envelope.kind === 'progress_baseline_set')!);
      switchSession(sourceSession);
      const prior = routes.finding_progress_predecessor({ storyId, idempotencyKey: 'renewal-source-checkpoint',
        sourceRecord: { storyId, recordId: proposalRecord.recordId, recordHash: exactLedgerRecordHash(proposalRecord) }, routeReceiptRef: receipt, baselineSetRef: baseline });
      switchSession(targetSession);
      const checklist = store.readChecklist(renewalId);
      store.writeChecklist(renewalId, { ...checklist, items: checklist.items.map(item => ({ ...item, status: 'in_progress' })) });
      const movement = routes.finding_progress_capture({ storyId: renewalId, idempotencyKey: 'renewal-status', receipt, kind: 'target_status_transition', predecessor: baseline, previousDeferralRef: refOf(prior.rows[0]!) });
      assert.throws(() => routes.finding_route_accept({ ...request, idempotencyKey: 'missing-renewal-progress', predecessor: receipt }), /requires target progress/);
      const renewalRequest = { ...request, idempotencyKey: 'renewal-accepted', predecessor: receipt, progress: refOf(movement.rows[0]!) };
      const renewed = routes.finding_route_accept(renewalRequest);
      assert.equal(renewed.rows.length, 1);
      const row = renewed.rows[0]!; validateRouteReceipt(row.envelope.payload);
      assert.equal(row.envelope.payload.initialProgressBaselineSet, undefined);
      assert.deepEqual(routes.finding_route_accept(renewalRequest).rows, renewed.rows);
      assert.equal(routes.finding_route_verify({ storyId: renewalId, receipt: refOf(row) }).valid, true);
      assert.throws(() => routes.finding_route_verify({ storyId: renewalId, receipt }), /superseded/);
    });
    switchSession(sourceSession);
    const neutral = routes.finding_progress_predecessor({ storyId, idempotencyKey: 'neutral-source-checkpoint',
      sourceRecord: { storyId, recordId: proposalRecord.recordId, recordHash: exactLedgerRecordHash(proposalRecord) }, routeReceiptRef: findingConsentRef, baselineSetRef: setRef });
    const neutralRef = refOf(neutral.rows[0]!);
    switchSession(targetSession);
    const failedTargetTest = await runTargetTest('failed-after-baseline', true);
    test('historical source review remains verifiable in TEST and DONE without material drift', () => {
      const live = store.readStory(storyId);
      for (const phase of ['TEST', 'DONE'] as const) {
        store.writeStory(storyId, { ...live, phase });
        assert.equal(routes.finding_route_verify({ storyId: targetId, receipt: findingConsentRef }).valid, true);
      }
      releaseOwnerLease(store.storyDirPath(storyId));
      // Subsequent target captures intentionally retain a closed source Story.
    });
    const priorTarget = store.readChecklist(targetId); const currentTarget = priorTarget.items[0]!;
    test('neutral source checkpoint is not a deferral and absent status still rejects no-op', () => {
      assert.equal(neutral.rows[0]!.envelope.kind, 'progress_predecessor');
      assert.throws(() => routes.finding_progress_capture({ storyId: targetId, idempotencyKey: 'no-initial-transition', receipt: findingConsentRef,
        kind: 'target_status_transition', predecessor: setRef, previousDeferralRef: neutralRef }), /no-op/);
    });
    store.writeChecklist(targetId, { ...priorTarget, items: [{ ...currentTarget, status: 'in_progress' }] });
    const progressInput = { storyId: targetId, idempotencyKey: 'status-progress', receipt: findingConsentRef, kind: 'target_status_transition', predecessor: setRef, previousDeferralRef: neutralRef };
    const progress = routes.finding_progress_capture(progressInput); const progressRow = progress.rows[0]!;
    function resignProgressMutation(projection: ProgressBinding['projection'], before: ProgressBaseline, changes: Partial<ProgressBinding> = {}): ProgressBinding {
      const original = progressRow.envelope.payload as ProgressBinding;
      const nested = original.evidence as unknown as IdentitySemanticEnvelope;
      const payload = { ...nested.payload, kind: projection.kind, projection };
      const { signature: _signature, ...unsigned } = { ...nested, payload, payloadDigest: identityHash(payload) };
      const evidence = { ...unsigned, signature: signCanonical(unsigned, signer.privateKey) };
      const { tupleDigest: _tuple, ...base } = {
        ...original,
        kind: projection.kind,
        projection,
        projectionDigest: identityHash(semanticProjection(projection)),
        evidence,
        predecessorBaselineDigest: before.baselineHash,
        predecessorProjectionDigest: before.projectionDigest ?? before.absenceDigest!,
        ...changes,
      };
      return { ...base, tupleDigest: identityHash(base) } as ProgressBinding;
    }
    test('validly re-signed absent-baseline mutations cannot substitute unrelated subjects', () => {
      const original = progressRow.envelope.payload as ProgressBinding;
      const set = initialSetRow.envelope.payload;
      validateBaselineSet(set, routeTrust);
      const mutations = [
        { kind: 'target_delivery_state', itemId: 'CHK-999-UNRELATED', signedState: 'done', stateEvidenceHash: sha('validly-signed-unrelated-delivery') },
        { kind: 'target_status_transition', itemId: 'CHK-999-UNRELATED', state: 'done', transitionPolicyDigest: identityHash(['pending', 'in_progress', 'done']) },
        { kind: 'target_test_result', commandDigest: sha('unrelated-command'), selectorDigest: identityHash('TARGET_TEST_PASS'), outcome: 'pass', executionKey: 'synthetic-wrong-command', receiptHash: sha('synthetic-receipt') },
        { kind: 'target_test_result', commandDigest: identityHash(targetCommand), selectorDigest: sha('unrelated-selector'), outcome: 'pass', executionKey: 'synthetic-wrong-selector', receiptHash: sha('synthetic-receipt') },
      ];
      for (const projection of mutations) {
        const before = set.baselines.find(row => (row.payload as ProgressBaseline).kind === projection.kind)!.payload as ProgressBaseline;
        assert.equal(before.projectionState, 'absent');
        const nested = original.evidence as unknown as IdentitySemanticEnvelope;
        const payload = { ...nested.payload, kind: projection.kind, projection };
        const { signature: _signature, ...unsigned } = { ...nested, payload, payloadDigest: identityHash(payload) };
        const evidence = { ...unsigned, signature: signCanonical(unsigned, signer.privateKey) };
        // Cryptography is deliberately valid; only semantic subject validation can reject this.
        verifyIdentityEnvelope(evidence, routeTrust, () => {});
        const { tupleDigest: _tuple, ...base } = { ...original, kind: projection.kind, projection,
          projectionDigest: identityHash(semanticProjection(projection as never)), evidence,
          predecessorBaselineDigest: before.baselineHash, predecessorProjectionDigest: before.absenceDigest! };
        const mutant = { ...base, tupleDigest: identityHash(base) };
        assert.throws(() => validateProgress(mutant, routeTrust), /subject mismatch/);
        assert.throws(() => assertProgressTransition(before, mutant as ProgressBinding), /subject mismatch/);
      }
      for (const signedState of ['pending', 'in_progress'] as const) {
        const before = set.baselines[2]!.payload as ProgressBaseline;
        const projection = { kind: 'target_delivery_state' as const, itemId: targetItemId, signedState, stateEvidenceHash: sha(`signed-incomplete-${signedState}`) };
        const nested = original.evidence as unknown as IdentitySemanticEnvelope;
        const payload = { ...nested.payload, kind: projection.kind, projection };
        const { signature: _signature, ...unsigned } = { ...nested, payload, payloadDigest: identityHash(payload) };
        const evidence = { ...unsigned, signature: signCanonical(unsigned, signer.privateKey) };
        const { tupleDigest: _tuple, ...base } = { ...original, kind: projection.kind, projection, projectionDigest: identityHash(semanticProjection(projection)), evidence,
          predecessorBaselineDigest: before.baselineHash, predecessorProjectionDigest: before.absenceDigest! };
        const mutant = { ...base, tupleDigest: identityHash(base) } as ProgressBinding;
        validateProgress(mutant, routeTrust); // Valid signed observation is not necessarily progress.
        assert.throws(() => assertProgressTransition(before, mutant), /delivery completion/);
      }
    });
    test('target status progress is signed and meaningful with unchanged source', () => {
      if (section === 'delivery') assert.deepEqual(publicCli('finding_progress_capture', progressInput).rows, progress.rows);
      validateProgress(progressRow.envelope.payload, routeTrust); assert.equal(readFileSync(join(scratch, 'source.mjs'), 'utf8'), source);
      assert.deepEqual(routes.finding_progress_capture(progressInput).rows, progress.rows);
      assert.throws(() => routes.finding_progress_capture({ ...progressInput, idempotencyKey: 'no-op-progress' }), /no-op|replay/);
      assert.throws(() => routes.finding_progress_capture({ ...progressInput, idempotencyKey: 'wrong-baseline', predecessor: findingConsentRef }), /baseline/);
      const binding = progressRow.envelope.payload;
      for (const value of [{ ...binding, evidence: {} }, { ...binding, kind: 'target_source_change' }, { ...binding, signedBy: 'source-author' }]) assert.throws(() => validateProgress(value, routeTrust));
    });
    test('failed target test outcome is valid evidence but not semantic progress', () => {
      const ledgerBefore = store.readFindingLedger(targetId).records.length;
      const before = (initialSetRow.envelope.payload as BaselineSet).baselines
        .find(row => (row.payload as ProgressBaseline).kind === 'target_test_result')!.payload as ProgressBaseline;
      const passingProjection = {
        kind: 'target_test_result' as const,
        commandDigest: identityHash({ executable: targetCommand.executable, args: targetCommand.args, shell: false }),
        selectorDigest: identityHash('TARGET_TEST_PASS'),
        outcome: 'pass' as const,
        executionKey: 'signed-test-outcome-control',
        receiptHash: sha('signed-test-outcome-control'),
      };
      const passing = resignProgressMutation(passingProjection, before);
      validateProgress(passing, routeTrust);
      assert.doesNotThrow(() => assertProgressTransition(before, passing));
      const failing = resignProgressMutation({ ...passingProjection, outcome: 'fail' }, before);
      validateProgress(failing, routeTrust);
      assert.throws(() => assertProgressTransition(before, failing), /test regression/);
      assert.equal(failedTargetTest.receipt.status, 'fail');
      assert.equal(failedTargetTest.receipt.exitCode, 1);
      assert.throws(() => routes.finding_progress_capture({ ...progressInput, idempotencyKey: 'failed-test-outcome',
        kind: 'target_test_result', executionKey: failedTargetTest.key.key }), /invalid current defect-bound execution/);
      assert.equal(store.readFindingLedger(targetId).records.length, ledgerBefore);
    });
    test('status regression from a signed present predecessor is refused', () => {
      const absent = (initialSetRow.envelope.payload as BaselineSet).baselines
        .find(row => (row.payload as ProgressBaseline).kind === 'target_status_transition')!.payload as ProgressBaseline;
      const makePresentBaseline = (state: 'in_progress' | 'done') => {
        const projection = { kind: 'target_status_transition' as const, itemId: targetItemId, state,
          transitionPolicyDigest: identityHash(['pending', 'in_progress', 'done']) };
        const { baselineHash: _baselineHash, absenceDigest: _absenceDigest, ...base } = {
          ...absent, projectionState: 'present' as const, projection, projectionDigest: identityHash(semanticProjection(projection)),
        };
        return { ...base, baselineHash: identityHash(base) } as ProgressBaseline;
      };
      const inProgress = makePresentBaseline('in_progress');
      validateBaseline(inProgress);
      const forwardProjection = { kind: 'target_status_transition' as const, itemId: targetItemId, state: 'done' as const,
        transitionPolicyDigest: identityHash(['pending', 'in_progress', 'done']) };
      const forward = resignProgressMutation(forwardProjection, inProgress);
      validateProgress(forward, routeTrust);
      assert.doesNotThrow(() => assertProgressTransition(inProgress, forward));
      const done = makePresentBaseline('done');
      validateBaseline(done);
      const regressiveProjection = { ...forwardProjection, state: 'in_progress' as const };
      const regressive = resignProgressMutation(regressiveProjection, done);
      validateProgress(regressive, routeTrust);
      assert.throws(() => assertProgressTransition(done, regressive), /progress: status regression\/no-op$/);
    });
    test('predecessor digest substitutions refuse without ledger mutation', () => {
      const ledgerBefore = store.readFindingLedger(targetId).records.length;
      const before = (initialSetRow.envelope.payload as BaselineSet).baselines
        .find(row => (row.payload as ProgressBaseline).kind === 'target_status_transition')!.payload as ProgressBaseline;
      const control = progressRow.envelope.payload as ProgressBinding;
      validateProgress(control, routeTrust);
      assert.doesNotThrow(() => assertProgressTransition(before, control));
      for (const changes of [
        { predecessorBaselineDigest: sha('substituted-predecessor-baseline') },
        { predecessorProjectionDigest: sha('substituted-predecessor-projection') },
      ]) {
        const { tupleDigest: _tuple, ...base } = { ...control, ...changes };
        const mutant = { ...base, tupleDigest: identityHash(base) } as ProgressBinding;
        validateProgress(mutant, routeTrust);
        assert.throws(() => assertProgressTransition(before, mutant), /wrong\/stale same-kind predecessor/);
      }
      for (const forbidden of [
        { predecessorBaselineDigest: sha('caller-substituted-predecessor-baseline') },
        { predecessorProjectionDigest: sha('caller-substituted-predecessor-projection') },
      ]) {
        assert.throws(() => routes.finding_progress_capture({ ...progressInput, idempotencyKey: `caller-${Object.keys(forbidden)[0]}`, ...forbidden }), /Unrecognized key|unrecognized/i);
      }
      assert.equal(store.readFindingLedger(targetId).records.length, ledgerBefore);
    });
    test('old execution cannot be laundered by a newly signed target capture', () => {
      assert.throws(() => routes.finding_progress_capture({ ...progressInput, idempotencyKey: 'old-test-progress', kind: 'target_test_result', executionKey: oldTargetTest.key.key }), /execution predates/);
    });
    const freshTest = await runTargetTest('after-baseline');
    test('absent test becomes actual executed signed progress with unchanged source', () => {
      const result = routes.finding_progress_capture({ ...progressInput, idempotencyKey: 'test-progress', kind: 'target_test_result', executionKey: freshTest.key.key });
      validateProgress(result.rows[0]!.envelope.payload, routeTrust);
      assert.equal(readFileSync(join(scratch, 'source.mjs'), 'utf8'), source);
      assert.throws(() => routes.finding_progress_capture({ ...progressInput, idempotencyKey: 're-sign-test', kind: 'target_test_result', executionKey: freshTest.key.key }), /replay|no-op/);
    });
    const checklistBeforeDelivery = store.readChecklist(targetId);
    store.writeChecklist(targetId, { ...checklistBeforeDelivery, items: checklistBeforeDelivery.items.map(item => ({ ...item, status: 'done' })) });
    const delivery = { storyId: targetId, checkedAt: new Date().toISOString(), agentId: 'synthetic-delivery-integrity', reviewRound: store.readStory(targetId).currentReviewRound!,
      materialHash: identitySourceSnapshot(ctx).materialHash, storyFilesHash: currentStoryFilesHash(scratch, 'HEAD', scratch)!,
      docsPromises: [{ docPath: 'source.mjs', promise: 'Target checklist obligation has documented evidence', status: 'met' as const, evidence: freshTest.receipt.receiptHash }],
      realMachineTests: [{ featureId: targetItemId, transcript: freshTest.receipt.outputProbe }],
      closingSelfCheck: { hasRealMachineTest: true, hasEdgeCaseCoverage: true, hasUnresolvedTodos: false, summary: 'Synthetic target evidence complete.' } };
    store.writeDeliveryCheck(targetId, { ...delivery, _hash: signDeliveryCheck(targetId, delivery.docsPromises, delivery.realMachineTests, delivery.closingSelfCheck, delivery.reviewRound, delivery.materialHash, delivery.storyFilesHash) });
    test('absent delivery becomes target-authorized progress; closed obligation cannot accept new consent', () => {
      const result = routes.finding_progress_capture({ ...progressInput, idempotencyKey: 'delivery-progress', kind: 'target_delivery_state' });
      validateProgress(result.rows[0]!.envelope.payload, routeTrust);
      assert.equal(readFileSync(join(scratch, 'source.mjs'), 'utf8'), source);
      assert.throws(() => routes.finding_route_verify({ storyId: targetId, receipt: findingConsentRef }), /closed/);
      assert.throws(() => routes.finding_route_accept({ ...findingAccept, idempotencyKey: 'closed-target' }), /closed/);
    });
    test('target lease loss and replacement invalidate previously current renewed consent', () => {
      const renewalId = 'B-ROUTE-RENEWAL';
      const rows = readIdentityRows<RouteReceipt>(ctx, renewalId, ['route_receipt'], (_kind, value) => validateRouteReceipt(value));
      const receipt = refOf(rows.at(-1)!);
      assert.equal(routes.finding_route_verify({ storyId: renewalId, receipt }).valid, true);
      releaseOwnerLease(store.storyDirPath(renewalId));
      assert.throws(() => routes.finding_route_verify({ storyId: renewalId, receipt }), /lease missing/);
      switchSession(`${targetSession}-replacement`);
      acquireOwnerLease(store.storyDirPath(renewalId), { command: 'synthetic replacement target owner', cwd: scratch });
      assert.throws(() => routes.finding_route_verify({ storyId: renewalId, receipt }), /stale|snapshot|moved/);
      switchSession(targetSession);
    });
    if (section === 'history' || section === 'delivery') {
      const history = createFindingHistoryHandlers(ctx); const currentId = 'B-HISTORY-CURRENT';
      switchSession(sourceSession); process.env.PROOF_OR_STOP_AGENT = 'main';
      const packagePath = 'packages/main/src/history-fixture.mjs'; mkdirSync(join(scratch, 'packages/main/src'), { recursive: true }); writeFileSync(join(scratch, packagePath), source);
      store.writeStory(currentId, { ...store.readStory(storyId), storyId: currentId, name: currentId, phase: 'REVIEW', currentReviewRound: new Date().toISOString() });
      store.writeChecklist(currentId, { items: [{ id: 'CHK-001', title: 'Current correction evidence', context: 'Synthetic historical correction under a real current reviewer.', status: 'done', startTime: null, endTime: null,
        files: { modify: ['source.mjs', packagePath], create: [], test: [] }, verificationIntent: { happy: [], edge: [], adversarial: [] } }] });
      acquireOwnerLease(store.storyDirPath(currentId), { command: 'synthetic current history owner', cwd: scratch });
      git('add', '.'); git('commit', '-m', 'synthetic historical correction review prerequisites');
      registry.get('dispatch')!({ storyId: currentId, agentType: lane }); process.env.PROOF_OR_STOP_AGENT = lane;
      const currentStart = String(registry.get('review_run_start')!({ storyId: currentId, agent: lane }));
      const currentRun = currentStart.match(/Review run (\S+) started/)?.[1]; assert.ok(currentRun, currentStart);
      withBrokeredNativeReviewInvocation({ root: scratch, store, storyId: currentId, agent: lane, reviewRunId: currentRun, invoke: () =>
        registry.get('finding_add')!({ storyId: currentId, agent: lane, reviewRunId: currentRun, desc: 'Corrected historical observation: the literal return value is 2 and the current contract requires 3, preserving the old observation trail.',
          severity: 'high', category: 'edge', files: ['source.mjs', packagePath], evidenceState: 'verified', idempotencyKey: 'historical-successor',
          readManifest: { filesReadFully: ['source.mjs', packagePath], filesTriagedByName: [], scanEscalationReason: null } }) });
      const successorFinding = store.readFindings(currentId).findings.at(-1)!;
      const successorRecord = store.readFindingLedger<JsonValue>(currentId).records.find(row => row.recordId === successorFinding.recordId)!;
      const successorRef = { storyId: currentId, findingId: successorFinding.id, recordId: successorRecord.recordId, recordHash: exactLedgerRecordHash(successorRecord) };
      const oldMirror = readFileSync(store.storyFilePath(storyId, 'findings.json'), 'utf8');
      const correctionHomeId = 'B-HISTORY-CORRECTION';
      store.writeStory(correctionHomeId, { ...store.readStory(currentId), storyId: correctionHomeId, name: correctionHomeId });
      store.writeChecklist(correctionHomeId, store.readChecklist(currentId));
      acquireOwnerLease(store.storyDirPath(correctionHomeId), { command: 'synthetic separate correction owner', cwd: scratch });
      registry.get('dispatch')!({ storyId: correctionHomeId, agentType: lane }); process.env.PROOF_OR_STOP_AGENT = lane;
      const correctionStart = String(registry.get('review_run_start')!({ storyId: correctionHomeId, agent: lane }));
      const correctionRun = correctionStart.match(/Review run (\S+) started/)?.[1]; assert.ok(correctionRun, correctionStart);
      const correctionInput = { storyId: correctionHomeId, idempotencyKey: 'historical-correction', predecessor: member, successor: successorRef,
        reason: 'incorrect_statement', evidenceRefs: ['source.mjs:1', `${packagePath}:1`], evidenceAnchors: [anchor], reviewRunId: correctionRun };
      const correction = history.finding_supersession_add(correctionInput);
      if (section === 'delivery') assert.deepEqual(publicCli('finding_supersession_add', correctionInput).rows, correction.rows);
      test('superseded Finding cannot remain a current proposal source while its compatibility record stays open', () => {
        assert.equal(store.readFindings(storyId).findings.find(row => row.recordId === member.recordId)!.status, 'open');
        assert.throws(() => sourceRouteRecord(ctx, proposalRef), /source Finding superseded/);
      });
      test('F030/F031-shaped DONE predecessor correction uses current reviewer and preserves exact bytes', () => {
        assert.equal(store.readStory(storyId).phase, 'DONE');
        assert.equal(successorFinding.id.split(':').at(-1), finding.id.split(':').at(-1));
        assert.notEqual(successorFinding.recordId, finding.recordId);
        assert.deepEqual(history.finding_supersession_add(correctionInput).rows, correction.rows);
        const catalog = readHistoryCatalog(ctx, identityCatalogStoryIdsForFixture());
        const lineage = canonicalCurrent(catalog.input, finding.recordId!);
        assert.equal(lineage.current.ref!.recordId, successorFinding.recordId); assert.equal(lineage.predecessors[0]!.ref!.recordId, finding.recordId);
        const bounded = readHistoryCatalog(ctx, [storyId, currentId]);
        assert.equal(canonicalCurrent(bounded.input, finding.recordId!).current.ref!.recordId, successorFinding.recordId,
          'bounded predecessor/successor query must retain a correction edge stored in a third Story');
        assert.equal(readFileSync(store.storyFilePath(storyId, 'findings.json'), 'utf8'), oldMirror);
        assert.throws(() => history.finding_supersession_add({ ...correctionInput, idempotencyKey: 'alias', predecessor: { ...member, storyId: currentId } }));
        assert.throws(() => history.finding_supersession_add({ ...correctionInput, idempotencyKey: 'missing-proof', evidenceRefs: [] }));
      });
      function identityCatalogStoryIdsForFixture() { return store.listStoryIds(); }
      const correctedInput = { ...confirm, storyId: currentId, reviewRunId: currentRun, idempotencyKey: 'cause-correction', predecessor: canonicalRef,
        reason: 'root_cause_corrected', rootCauseState: 'confirmed', rootCause: 'The implementation contains a literal return value that differs from the recorded contract.',
        evidenceAnchors: [anchor, { ...anchor, path: packagePath }] };
      const { memberFindingRefs: _members, canonicalFindingRef: _canonicalFinding, ...causeInput } = correctedInput;
      test('staged cause correction interruption leaves old current; exact retry activates only signed successor', () => {
        const scorecardBefore = section === 'delivery' ? history.finding_identity_scorecard({ storyId: currentId, sourceStoryIds: [storyId] }) : undefined;
        const transact = StoryStore.prototype.transactFindingLedger;
        try {
          StoryStore.prototype.transactFindingLedger = function(id, fence, prepare, options) {
            return transact.call(this, id, fence, current => { const prepared = prepare(current as never);
              if (id === currentId && prepared.plan.action === 'append' && prepared.plan.records.some(row => row.recordType === 'canonical_defect_supersession')) throw new Error('synthetic-between-canonical-stages');
              return prepared as never;
            }, options) as never;
          };
          assert.throws(() => history.finding_identity_supersede(causeInput), /between-canonical-stages/);
        } finally { StoryStore.prototype.transactFindingLedger = transact; }
        const pending = handlers.finding_identity_query({ storyId: currentId, canonicalDefectId: canonical.canonicalDefectId, includeSuperseded: true });
        assert.equal(pending.current[0]!.canonicalDefectId, canonical.canonicalDefectId); assert.equal(pending.pending!.length, 1);
        const stagedBytes = pending.pending![0]!.record;
        const completed = history.finding_identity_supersede(causeInput);
        assert.deepEqual(history.finding_identity_supersede(causeInput).rows, completed.rows);
        if (section === 'delivery') assert.deepEqual(publicCli('finding_identity_supersede', causeInput).rows, completed.rows);
        const now = handlers.finding_identity_query({ storyId: currentId, canonicalDefectId: canonical.canonicalDefectId, includeSuperseded: true });
        assert.notEqual(now.current[0]!.canonicalDefectId, canonical.canonicalDefectId); assert.equal(now.current[0]!.predecessors.length, 1); assert.equal(now.pending!.length, 0);
        assert.deepEqual(store.readFindingLedger(currentId).records.find(row => row.recordId === stagedBytes.recordId), stagedBytes);
        assert.equal(readFileSync(store.storyFilePath(storyId, 'findings.json'), 'utf8'), oldMirror);
        if (scorecardBefore) {
          assert.throws(() => history.finding_identity_scorecard({ storyId: currentId, sourceStoryIds: [storyId], expectedInputDigest: scorecardBefore.inputDigest }), /stale/);
          const after = history.finding_identity_scorecard({ storyId: currentId, sourceStoryIds: [storyId] });
          assert.deepEqual(after.inputBindings, scorecardBefore.inputBindings);
          assert.notEqual(after.canonicalCatalogDigest, scorecardBefore.canonicalCatalogDigest);
        }
      });
      test('known cause can be explicitly corrected back to unknown without inheriting old text', () => {
        const current = handlers.finding_identity_query({ storyId: currentId, canonicalDefectId: canonical.canonicalDefectId }).reviewer_confirmed[0]!;
        const { rootCause: _cause, ...unknown } = causeInput;
        history.finding_identity_supersede({ ...unknown, idempotencyKey: 'cause-now-unknown', predecessor: refOf(current), rootCauseState: 'unknown' });
        const now = handlers.finding_identity_query({ storyId: currentId, canonicalDefectId: canonical.canonicalDefectId }).current[0]!;
        assert.equal(now.rootCauseState, 'unknown'); assert.equal(now.rootCause, undefined); assert.equal(now.predecessors.length, 2);
      });
      test('global membership rejects a second home identity for already-confirmed immutable observations', () => {
        assert.throws(() => handlers.finding_identity_confirm({ ...confirm, storyId: currentId, reviewRunId: currentRun, idempotencyKey: 'foreign-home-alias' }), /already confirmed/);
      });
      test('deterministic exact index and filtered projection have distinct verifiable bindings', () => {
        const catalog = readHistoryCatalog(ctx, store.listStoryIds()); const index = buildHistoryIndex(catalog.input);
        assert.deepEqual(buildHistoryIndex(readHistoryCatalog(ctx, store.listStoryIds()).input), index);
        assert.equal(queryHistoryIndex(index, { storyId: currentId, recordId: finding.recordId }).length, 0);
        assert.equal(queryHistoryIndex(index, { storyId: currentId, recordId: finding.recordId, includeSuperseded: true }).length, 1);
        for (const query of [{ path: packagePath }, { package: 'packages/main' }, { symbol: 'observedDefect' }, { contract: 'return-three' },
          { canonicalDefectId: canonical.canonicalDefectId }, { outcome: 'open' }]) {
          const result = history.finding_history_query({ storyId: currentId, ...query }); assert.ok('projectionDigest' in result); assert.ok(result.rows.length > 0, JSON.stringify(query));
          const { projectionDigest, ...projection } = result; assert.equal(identityHash(projection), projectionDigest);
          assert.equal(result.sourceIndexDigest, index.indexDigest);
        }
        const lineageKey = index.rows.find(row => row.ref?.recordId === successorFinding.recordId)!.sourceLineageKeys[0]!;
        assert.ok(queryHistoryIndex(index, { storyId: currentId, sourceLineageKey: lineageKey }).length > 0);
        assert.throws(() => history.finding_history_query({ storyId: currentId, expectedIndexDigest: sha('stale') }), /stale/);
        assert.throws(() => history.finding_history_query({ storyId: currentId, sourceStoryIds: ['B-MISSING-HISTORY'] }));
      });
      test('signed graph refuses cycles forks missing nodes hash aliases and semantic tamper', () => {
        const input = readHistoryCatalog(ctx, store.listStoryIds()).input; const link = correction.rows[0]!.envelope.payload as HistorySupersession;
        for (const changes of [{ successor: link.predecessor, successorEntityId: link.predecessorEntityId },
          { successor: { ...link.successor, recordHash: sha('wrong') } }, { predecessor: { ...link.predecessor, storyId: currentId } },
          { successor: { ...link.successor, recordId: 'missing-node' } }]) {
          const { recordHash: _hash, ...base } = { ...link, ...changes }; const mutant = { ...base, recordHash: identityHash(base) };
          assert.throws(() => validateHistoryGraph({ ...input, links: [...input.links, mutant] }));
        }
        const { recordHash: _hash, ...reverseBase } = { ...link, supersessionId: 'synthetic-reverse-cycle', predecessor: link.successor, successor: link.predecessor,
          predecessorEntityId: link.successorEntityId, successorEntityId: link.predecessorEntityId };
        assert.throws(() => validateHistoryGraph({ ...input, links: [...input.links, { ...reverseBase, recordHash: identityHash(reverseBase) }] }), /cycle/);
        assert.throws(() => validateHistoryGraph({ ...input, links: [...input.links, link] }), /conflicting/);
        assert.throws(() => verifyIdentityEnvelope({ ...correction.rows[0]!.envelope, signature: 'tampered' }, routeTrust, validateSupersession));
      });
      test('unbound legacy observations remain readable byte-identical and never acquire identities on read', () => {
        const legacyId = 'B-HISTORY-LEGACY'; store.writeStory(legacyId, { ...store.readStory(currentId), storyId: legacyId, name: legacyId, phase: 'DONE' });
        store.writeFindings(legacyId, { findings: [{ id: `${legacyId}:F-030`, desc: 'Legacy observation is historical context only.', severity: 'low', category: 'edge', status: 'resolved', files: ['packages/main/legacy.ts'] }] });
        const path = store.storyFilePath(legacyId, 'findings.json'); const bytes = readFileSync(path, 'utf8');
        const result = history.finding_history_query({ storyId: currentId, sourceStoryIds: [legacyId], path: 'packages/main/legacy.ts' });
        assert.equal(result.rows.length, 1); assert.equal(result.rows[0]!.ref, undefined); assert.equal(result.gateEvidence, false);
        assert.equal(readFileSync(path, 'utf8'), bytes); assert.equal(store.readFindingLedger(legacyId).records.length, 0);
        const original = store.readFindings(legacyId);
        try {
          store.writeFindings(legacyId, { findings: original.findings.map(row => ({ ...row, recordId: 'missing-claimed-durable-id' })) });
          assert.throws(() => history.finding_history_query({ storyId: currentId, sourceStoryIds: [legacyId] }), /missing/);
        } finally { store.writeFindings(legacyId, original); }
      });
      process.env.PROOF_OR_STOP_AGENT = 'main'; switchSession(sourceSession);
      const recallTargetId = 'B-HISTORY-TARGET';
      store.writeStory(recallTargetId, { ...store.readStory(currentId), storyId: recallTargetId, name: recallTargetId, phase: 'PLAN', startedAt: null });
      store.writeChecklist(recallTargetId, { items: [{ id: targetItemId, title: 'Historical candidate responsibility', context: 'Contract-only matching is intentional: source anchor and target path are different.', status: 'pending', startTime: null, endTime: null,
        files: { modify: [packagePath], create: [], test: [] }, verificationIntent: { happy: [{ desc: 'Repair the mapped return-three contract', type: 'cli', priority: 'must' }], edge: [], adversarial: [] } }] });
      const recallCandidateResult = handlers.finding_candidate_add({ ...add, storyId: currentId, idempotencyKey: 'recall-origin' });
      const recallCandidateRow = recallCandidateResult.rows.find(row => row.envelope.kind === 'candidate')!; validateCandidate(recallCandidateRow.envelope.payload);
      const recallCandidate = recallCandidateRow.envelope.payload;
      const recallSource: RouteSource = { ...refOf(recallCandidateRow), subjectKind: 'candidate_finding', subjectId: recallCandidate.candidateId, subjectHash: recallCandidate.currentProjectionHash };
      switchSession(targetSession); acquireOwnerLease(store.storyDirPath(recallTargetId), { command: 'synthetic recall target owner', cwd: scratch });
      const recallAccept = { ...accept, storyId: recallTargetId, source: recallSource, idempotencyKey: 'history-consent', subject: { ...subject, sourcePaths: [packagePath] }, expiresAt: new Date(Date.now() + 120_000).toISOString() };
      const recallConsent = routes.finding_route_accept(recallAccept); const recallReceipt = refOf(recallConsent.rows[0]!);
      switchSession(sourceSession);
      const recallArgs = { storyId: currentId, route: recallReceipt };
      const recallGateBefore = store.readFindings(currentId); const recallTargetBefore = store.readStory(recallTargetId);
      const observeOnce = (trigger: string, label = trigger) => {
        const result = history.finding_history_recall({ ...recallArgs, trigger, idempotencyKey: `recall-${label}` });
        assert.equal(result.created, 1); assert.equal(result.gateEvidence, false);
        const again = history.finding_history_recall({ ...recallArgs, trigger, idempotencyKey: `different-key-${label}` });
        assert.equal(again.created, 0); assert.deepEqual(store.readFindings(currentId), recallGateBefore);
        return result;
      };
      test('recall target-created means first observation of the actual bound creation fact, once only', () => {
        assert.equal(observeOnce('target_created').currentConsent, true);
        assert.deepEqual(store.readStory(recallTargetId), recallTargetBefore);
      });
      test('recall scope supports contract-only match and rejects neither-path-nor-contract', () => {
        const checklist = store.readChecklist(recallTargetId);
        try {
          store.writeChecklist(recallTargetId, { ...checklist, items: checklist.items.map(item => ({ ...item, verificationIntent: { happy: [], edge: [], adversarial: [] } })) });
          assert.throws(() => history.finding_history_recall({ ...recallArgs, trigger: 'scope_contract_match', idempotencyKey: 'no-match' }), /not observed/);
        } finally { store.writeChecklist(recallTargetId, checklist); }
        assert.equal(observeOnce('scope_contract_match').currentConsent, true);
      });
      test('recall refuses caller trigger facts, unknown fields, absent movement and tampered receipt', () => {
        for (const trigger of ['target_started', 'source_hash_drift', 'runtime_drift', 'severity_escalation', 'owner_invalid', 'target_closed_unfixed', 'expired'])
          assert.throws(() => history.finding_history_recall({ ...recallArgs, trigger, idempotencyKey: `not-yet-${trigger}` }));
        assert.throws(() => history.finding_history_recall({ ...recallArgs, trigger: 'expired', idempotencyKey: 'caller-time', now: recallAccept.expiresAt }));
        assert.throws(() => history.finding_history_recall({ ...recallArgs, route: { ...recallReceipt, recordHash: sha('tamper') }, trigger: 'target_created', idempotencyKey: 'tampered-route' }));
      });
      store.writeStory(recallTargetId, { ...store.readStory(recallTargetId), phase: 'DEV', startedAt: new Date().toISOString() });
      test('recall actual target start is once-only despite already-stale consent', () => { assert.equal(observeOnce('target_started').currentConsent, false); });
      test('recall source-origin and independently affected target bytes are distinct actual drift events', () => {
        try {
          writeFileSync(join(scratch, 'source.mjs'), `${source}// actual origin change\n`);
          assert.equal(observeOnce('source_hash_drift', 'origin-drift').currentConsent, false);
          writeFileSync(join(scratch, 'source.mjs'), source);
          writeFileSync(join(scratch, packagePath), `${source}// actual target affected path change\n`);
          assert.equal(observeOnce('source_hash_drift', 'target-drift').currentConsent, false);
        } finally { writeFileSync(join(scratch, 'source.mjs'), source); writeFileSync(join(scratch, packagePath), source); }
      });
      const severityWitness = await reproduce(`candidate-reproduced:${recallCandidate.candidateId}:${recallCandidate.currentProjectionHash}`, currentId);
      assert.equal(severityWitness.verdict.result, 'pass'); assert.equal(severityWitness.disposition, 'executed');
      process.env.PROOF_OR_STOP_AGENT = lane;
      handlers.finding_candidate_promote({ storyId: currentId, idempotencyKey: 'recall-current-severity', candidateId: recallCandidate.candidateId,
        expectedCandidateHash: recallCandidate.currentProjectionHash, findingId: successorFinding.id, reviewRunId: currentRun,
        reproductionExecutionKey: severityWitness.key.key, reproductionReceiptHash: severityWitness.receipt.receiptHash,
        reproductionAttestation: { selector: reproductionSelector,
          semanticAssertion: 'The bound execution reproduced the exact successor Finding behavior for severity recall.' } });
      process.env.PROOF_OR_STOP_AGENT = 'main';
      test('recall severity comes from actual reviewer promotion, never the suspected candidate label', () => {
        const result = observeOnce('severity_escalation'); assert.equal(result.currentConsent, false);
        assert.deepEqual(store.readFindings(currentId), recallGateBefore);
      });
      test('recall runtime observes exact verified persistence reference drift without claiming runtime PASS', () => {
        const lock = store.runtimeLockDirPath(recallTargetId, 'finding', 'findings');
        withMkdirLock(lock, () => appendFindingLedger({ storyId: recallTargetId, store, operation: 'append_runtime_receipt', idempotencyKey: 'history-runtime-reference',
          records: [{ recordType: 'runtime_evidence_receipt', payload: { schemaVersion: 1, fixture: 'persistence-only reference, not semantic runtime evidence', authority: 'non_authoritative', gateEvidence: false } }],
          writerSessionId: getSessionIdentity().sessionId, writerLeaseId: targetSession, writerFenceToken: captureMkdirLockFence(lock).writerFenceToken,
          fence: captureMkdirLockFence(lock), signer }), { requireHolderToken: true });
        assert.equal(observeOnce('runtime_drift').gateEvidence, false);
      });
      test('recall owner loss and closed-unfixed target preserve historical invalidity', () => {
        const activeChecklist = store.readChecklist(recallTargetId);
        try {
          store.writeChecklist(recallTargetId, { ...activeChecklist, items: activeChecklist.items.map((item, index) => index === 0 ? { ...item, status: 'done' } : item) });
          assert.throws(() => observeOnce('target_closed_unfixed', 'active-target-with-done-item'), /closure not observed/);
        } finally { store.writeChecklist(recallTargetId, activeChecklist); }
        switchSession(targetSession); releaseOwnerLease(store.storyDirPath(recallTargetId)); switchSession(sourceSession);
        assert.equal(observeOnce('owner_invalid').currentConsent, false);
        store.writeStory(recallTargetId, { ...store.readStory(recallTargetId), phase: 'DONE' });
        assert.equal(observeOnce('target_closed_unfixed').currentConsent, false);
      });
      test('recall expiry is based on the actual signed deadline, not caller time or a new request key', () => {
        const realNow = Date.now;
        try { Date.now = () => Date.parse(recallAccept.expiresAt) + 1; assert.equal(observeOnce('expired').currentConsent, false); }
        finally { Date.now = realNow; }
      });
      test('public history CLI returns independently verifiable projection and rejects injected authority', () => {
        const child = spawnSync(process.execPath, [cliPath, 'finding_history_query', JSON.stringify({ storyId: currentId, package: 'packages/main' })], { cwd: scratch, encoding: 'utf8', env: process.env });
        assert.equal(child.status, 0, child.stderr + child.stdout); assert.match(child.stdout, /projectionDigest/);
        const bad = spawnSync(process.execPath, [cliPath, 'finding_history_recall', JSON.stringify({ ...recallArgs, trigger: 'target_created', idempotencyKey: 'injected-recall', gateEvidence: true })], { cwd: scratch, encoding: 'utf8', env: process.env });
        assert.notEqual(bad.status, 0, bad.stdout);
      });
      const concurrentTarget = 'B-HISTORY-CONCURRENT';
      store.writeStory(concurrentTarget, { ...store.readStory(currentId), storyId: concurrentTarget, name: concurrentTarget, phase: 'DEV' });
      store.writeChecklist(concurrentTarget, store.readChecklist(recallTargetId));
      const concurrentSourceRows = handlers.finding_candidate_add({ ...add, storyId: currentId, idempotencyKey: 'concurrent-recall-source', signal: { ...add.signal, sourceIds: ['independent-concurrent-recall'] } });
      const concurrentSourceRow = concurrentSourceRows.rows.find(row => row.envelope.kind === 'candidate')!; validateCandidate(concurrentSourceRow.envelope.payload);
      const concurrentSource: RouteSource = { ...refOf(concurrentSourceRow), subjectKind: 'candidate_finding', subjectId: concurrentSourceRow.envelope.payload.candidateId, subjectHash: concurrentSourceRow.envelope.payload.currentProjectionHash };
      switchSession(targetSession); acquireOwnerLease(store.storyDirPath(concurrentTarget), { command: 'synthetic concurrent recall target', cwd: scratch });
      const concurrentAccept = { ...recallAccept, storyId: concurrentTarget, source: concurrentSource, idempotencyKey: 'concurrent-recall-consent', expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() };
      const concurrentConsent = routes.finding_route_accept(concurrentAccept); const concurrentReceipt = refOf(concurrentConsent.rows[0]!);
      switchSession(sourceSession);
      const concurrentRequest = { storyId: currentId, route: concurrentReceipt, trigger: 'target_created' };
      const candidateCount = handlers.finding_candidate_get({ storyId: currentId }).candidates.length;
      const children = ['first', 'second'].map(key => new Promise<{ code: number | null; output: string }>(resolveChild => {
        const child = spawn(process.execPath, [cliPath, 'finding_history_recall', JSON.stringify({ ...concurrentRequest, idempotencyKey: `concurrent-${key}` })], { cwd: scratch, env: process.env });
        let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
        child.on('close', code => resolveChild({ code, output }));
      }));
      const concurrentResults = await Promise.all(children);
      test('two real concurrent public recalls with distinct keys produce one non-gate candidate', () => {
        for (const child of concurrentResults) assert.equal(child.code, 0, child.output);
        assert.deepEqual(concurrentResults.map(child => Number(child.output.match(/"created":\s*(\d+)/)?.[1])).sort(), [0, 1]);
        assert.equal(handlers.finding_candidate_get({ storyId: currentId }).candidates.length, candidateCount + 1);
        assert.deepEqual(store.readFindings(currentId), recallGateBefore);
      });
      test('rejected and revoked history may recall but can never be laundered into consent', () => {
        switchSession(targetSession);
        const rejected = routes.finding_route_reject({ ...concurrentAccept, idempotencyKey: 'history-rejected', predecessor: concurrentReceipt });
        switchSession(sourceSession);
        const invalid = history.finding_history_recall({ ...concurrentRequest, route: refOf(rejected.rows[0]!), trigger: 'scope_contract_match', idempotencyKey: 'rejected-recall' });
        assert.equal(invalid.created, 1); assert.equal(invalid.currentConsent, false); assert.equal(invalid.gateEvidence, false);
        const old = history.finding_history_recall({ ...concurrentRequest, idempotencyKey: 'old-accepted-is-not-consent' });
        assert.equal(old.created, 0); assert.equal(old.currentConsent, false);
        switchSession(targetSession);
        const revokedHistory = routes.finding_route_revoke({ storyId: concurrentTarget, receipt: refOf(rejected.rows[0]!), idempotencyKey: 'history-revoked', reason: 'target_rejected' });
        switchSession(sourceSession);
        const revokedResult = history.finding_history_recall({ ...concurrentRequest, route: refOf(revokedHistory.rows[0]!), idempotencyKey: 'revoked-recall' });
        assert.equal(revokedResult.created, 0); assert.equal(revokedResult.currentConsent, false);
        assert.deepEqual(store.readFindings(currentId), recallGateBefore);
      });
      test('signed historical signature-tag and playbook rows have zero blocker and REVIEW-to-TEST transition delta', () => {
        const beforeFindings = store.readFindings(currentId);
        const blockerIds = () => store.readFindings(currentId).findings
          .filter(row => isFindingBlocking(row, ['critical', 'high', 'medium'], 1)).map(row => row.id);
        const beforeBlockers = blockerIds();
        const beforeGuard = getLifecycleGuardFailureReason(currentId, store, 'TEST', scratch);
        const beforeStory = store.readStory(currentId);
        const lock = store.runtimeLockDirPath(currentId, 'finding', 'findings');
        withMkdirLock(lock, () => {
          const fence = captureMkdirLockFence(lock);
          appendFindingLedger({ storyId: currentId, store, operation: 'append_candidate', idempotencyKey: 'historical-tag-playbook-non-gate',
            records: [
              { recordType: 'historical_signature_tag_signal', payload: { schemaVersion: 1, authority: 'non_authoritative', gateEvidence: false,
                signatureTag: 'critical|ts|synthetic-history', historicalOutcome: 'DONE', severityHint: 'critical' } },
              { recordType: 'historical_playbook_signal', payload: { schemaVersion: 1, authority: 'non_authoritative', gateEvidence: false,
                playbookId: 'PB-synthetic-history', recommendation: 'block transition', historicalOutcome: 'open' } },
            ], writerSessionId: getSessionIdentity().sessionId, writerLeaseId: sourceSession, writerFenceToken: fence.writerFenceToken, fence, signer });
        }, { requireHolderToken: true });
        const appendedKinds = store.readFindingLedger<JsonValue>(currentId).records.slice(-2).map(row => row.recordType);
        assert.deepEqual(appendedKinds, ['historical_signature_tag_signal', 'historical_playbook_signal']);
        assert.deepEqual(store.readFindings(currentId), beforeFindings);
        assert.deepEqual(blockerIds(), beforeBlockers);
        assert.equal(getLifecycleGuardFailureReason(currentId, store, 'TEST', scratch), beforeGuard);
        assert.deepEqual(store.readStory(currentId), beforeStory);
      });
      test('B-META authority policy recall does not invent a Story lease', () => {
        const metaConsent = routes.finding_route_accept({ ...concurrentAccept, storyId: metaId, idempotencyKey: 'history-meta-consent', subject });
        const policy = COMMAND_POLICIES.finding_route_accept as unknown as { allowedPhases: readonly string[] }; const phases = policy.allowedPhases;
        try {
          policy.allowedPhases = ['DEV', 'TEST'];
          const invalid = history.finding_history_recall({ storyId: currentId, route: refOf(metaConsent.rows[0]!), trigger: 'owner_invalid', idempotencyKey: 'meta-policy-recall' });
          assert.equal(invalid.created, 1); assert.equal(invalid.currentConsent, false); assert.equal(invalid.gateEvidence, false);
          assert.equal(existsSync(store.storyFilePath(metaId, 'owner-lease.json')), false);
        } finally { policy.allowedPhases = phases; }
      });
      test('unrelated unresolved Story does not poison canonical discovery; contributing missing home still refuses', () => {
        const contributorSource = identityCatalogContributor.toString();
        assert.doesNotMatch(contributorSource, /readFileSync|JSON\.parse|finding-ledger\.json/,
          'catalog discovery must use signed-workspace resolution and StoryStore ports, never protected-file parsing');
        assert.match(contributorSource, /historicalStoryContext/);
        const unrelated = 'B-HISTORY-UNRESOLVED'; store.writeStory(unrelated, { ...store.readStory(currentId), storyId: unrelated, name: unrelated, phase: 'INIT_CHECK' });
        const before = readCanonicalCatalog(ctx);
        const story = store.readStory(unrelated);
        store.writeStory(unrelated, { ...story, worktree: { path: join(scratch, 'missing-worktree'), branch: `story/${unrelated}` } } as StoryInfo);
        assert.throws(() => historicalStoryContext(ctx, unrelated), /unresolved/);
        assert.equal(readCanonicalCatalog(ctx).rows.length, before.rows.length);
        assert.equal(history.finding_history_query({ storyId: currentId }).complete, true);
        assert.equal(history.finding_history_recall({ ...concurrentRequest, idempotencyKey: 'unrelated-unresolved-recall-retry' }).created, 0);
        const current = store.readStory(currentId);
        try {
          store.writeStory(currentId, { ...current, worktree: { path: join(scratch, 'missing-contributing-worktree'), branch: `story/${currentId}` } } as StoryInfo);
          assert.throws(() => readCanonicalCatalog(ctx), /unresolved/);
        } finally { store.writeStory(currentId, current); }
      });
      if (section === 'delivery') test('populated public scorecard verifies every declared semantic record kind and carrier', () => {
        const scorecard = history.finding_identity_scorecard({ storyId: currentId });
        verifyIdentityScorecard(scorecard, history.finding_identity_scorecard({ storyId: currentId }));
        for (const kind of SCORECARD_KINDS) assert.ok(scorecard.rows.some(row => row.kind === kind), `missing exercised kind ${kind}`);
        assert.ok(scorecard.rows.every(row => row.envelope.signature && row.receipt.signature));
        assert.equal(scorecard.gateEvidence, false); assert.equal(scorecard.qualification.enforceEligible, false);
        console.log(`PUBLIC_SCORECARD_DELIVERY ${JSON.stringify({ digest: scorecard.digest, inputDigest: scorecard.inputDigest, rowCounts: scorecard.rowCounts, detectorMeasurements: scorecard.detectorMeasurements })}`);
      });

      console.log(`FINDING_IDENTITY_HISTORY ${failures ? 'FAIL' : 'PASS'} ${assertions} passing ${failures} failed cases`);
    }
    console.log(`FINDING_IDENTITY_ROUTES ${failures ? 'FAIL' : 'PASS'} ${assertions} passing ${failures} failed cases`);
  }
  console.log(`FINDING_IDENTITY_CANDIDATES ${failures ? 'FAIL' : 'PASS'} ${assertions} passing ${failures} failed cases`);
  if (section === 'delivery') console.log(`FINDING_IDENTITY_DELIVERY ${failures ? 'FAIL' : 'PASS'} ${assertions} passing ${failures} failed cases elapsedMs=${Math.ceil(performance.now() - smokeStarted)}`);
  if (failures) process.exitCode = 1;
} finally {
  process.chdir(oldCwd);
  if (oldActor === undefined) delete process.env.PROOF_OR_STOP_AGENT; else process.env.PROOF_OR_STOP_AGENT = oldActor;
  if (oldSession === undefined) delete process.env.PROOF_OR_STOP_SESSION_ID; else process.env.PROOF_OR_STOP_SESSION_ID = oldSession;
  if (oldProvider === undefined) delete process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER; else process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER = oldProvider;
  resetSessionIdForTest();
  rmSync(scratch, { recursive: true, force: true });
}
