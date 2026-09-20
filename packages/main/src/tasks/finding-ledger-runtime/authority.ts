import { syncClusterResolves } from '../../core/cluster-sync.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';

import { type JsonValue } from '../../core/finding-ledger.js';

import { appendFindingLedger, bindLegacyFindingLedgerReceipts, canonicalHash, canonicalJson, createAuthoritativeFindingMutation, findingLedgerSignerFromWorkspace, findingLedgerTrustFromWorkspace, signFindingLedgerReceipt, verifyFindingLedgerReceipt } from '../../handlers/finding-ledger.js';

import {
  acquireMkdirLock,
  captureMkdirLockFence,
} from '../../core/mkdir-lock.js';

import { StoryStore } from '../../core/store.js';

import { createFindingHandlers } from '../../handlers/finding.js';

import { createClusterHandlers } from '../../handlers/cluster.js';
import { createSignatureBackfillHandlers } from '../../handlers/signature-backfill.js';
import { autoResolveMissing, META_STORY_ID, upsertDrift } from '../../core/audit-meta-store.js';

import type { HandlerContext } from '../../handlers/context.js';
import type { Finding, StoryInfo } from '../../core/types.js';

import { findLifecycleTransition } from '../../core/lifecycle-registry.js';
import {
  assertPlanDevDependenciesDone,
  runStoryTransition,
} from '../../handlers/transition-orchestrator.js';

import { git, runtimeStory, request, readOnlySecuritySnapshot, runRuntimeCli, runCliCommand } from './support.js';

export function runReadOnlyColdStartRegression(repositoryRoot: string, scratch: string): void {
  const root = join(scratch, 'read-only-cold-start');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements', storyPrefix: 'B',
  }, null, 2));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', 'proof-or-stop.config.json']);
  git(root, ['-c', 'user.name=cold-start-smoke', '-c', 'user.email=cold@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'cold start']);
  const store = new StoryStore(root);
  const storyId = 'B-COLD';
  store.writeStory(storyId, runtimeStory(storyId));
  const lockDir = store.runtimeLockDirPath(storyId, 'finding', 'cold-seed');
  const lock = acquireMkdirLock(lockDir, { label: 'cold unsigned seed', requireHolderToken: true });
  try {
    const fence = captureMkdirLockFence(lockDir);
    store.appendFindingLedgerTransaction(
      storyId,
      request(fence.writerFenceToken, 'cold:unsigned', 'finding', {
        id: `${storyId}:F-001`, desc: 'cold unsigned seed', severity: 'low', category: 'edge', status: 'open',
      }),
      fence,
    );
  } finally {
    lock.release();
  }
  const gitDir = join(root, '.git');
  // The CLI wrapper appends its generic command audit trail even for read-only
  // commands. Exclude only that registered activity stream; every signing,
  // trust, Story, ledger, and git byte remains covered by this comparison.
  const before = readOnlySecuritySnapshot(root);
  chmodSync(gitDir, 0o555);
  let query: ReturnType<typeof runRuntimeCli>;
  let verifyResult: ReturnType<typeof runRuntimeCli>;
  try {
    query = runRuntimeCli(repositoryRoot, root, 'finding_ledger_query', { storyId }, {});
    verifyResult = runRuntimeCli(repositoryRoot, root, 'finding_runtime_evidence_verify', {
      storyId,
      runtimeReceiptId: 'rer_missing_cold_start',
      buildCommand: { executable: process.execPath, args: ['-e', ''], cwd: '.' },
      executionCommand: { executable: process.execPath, args: ['-e', ''], cwd: '.' },
      artifactPaths: [],
      compilerVersion: 'cold-start',
    }, {});
  } finally {
    chmodSync(gitDir, 0o755);
  }
  const after = readOnlySecuritySnapshot(root);
  assert.notEqual(query!.status, 0);
  assert.match(`${query!.stdout}\n${query!.stderr}`, /signing_key_unavailable/);
  assert.notEqual(verifyResult!.status, 0);
  assert.match(`${verifyResult!.stdout}\n${verifyResult!.stderr}`, /unknown_signing_key/);
  assert.deepEqual(after, before, 'read-only query/verify changed protected filesystem state at cold start');
  assert.equal(existsSync(join(gitDir, 'proof-or-stop-finding-ledger-v1.key')), false);
  assert.equal(existsSync(join(gitDir, 'proof-or-stop-runtime-evidence-v1.key')), false);
  assert.equal(existsSync(join(gitDir, 'proof-or-stop-runtime-evidence-trust-v1.json')), false);
  console.log('query.cold_start_read_only: PASS noKey=true writeDenied=true protectedFilesystemDelta=0');
  console.log('runtime.verify_cold_start_read_only: PASS noKey=true writeDenied=true protectedFilesystemDelta=0');
}

export async function runAuthoritativeMutationRegression(repositoryRoot: string, scratch: string): Promise<void> {
  const root = join(scratch, 'authoritative-live-mutations');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements', storyPrefix: 'B',
  }, null, 2));
  writeFileSync(join(root, 'source.txt'), 'authoritative mutation fixture\n');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', 'proof-or-stop.config.json', 'source.txt']);
  git(root, ['-c', 'user.name=mutation-smoke', '-c', 'user.email=mutation@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture baseline']);

  const gapRuns = await Promise.all(Array.from({ length: 8 }, (_, index) => runCliCommand(
    repositoryRoot,
    root,
    'gap_log',
    {
      category: 'missing', severity: 'medium',
      evidence: `concurrent authoritative gap ${index}`,
      sourceRefs: [`source-${index}.ts`],
      evidenceState: 'verified',
      agent: 'proof-or-stop-implementer',
    },
  )));
  assert.equal(gapRuns.every((run) => run.status === 0), true, gapRuns.map((run) => run.stderr || run.stdout).join('\n'));
  const store = new StoryStore(root);
  const gapProjection = store.readFindings(META_STORY_ID);
  const gapIds = gapProjection.findings.map((finding) => finding.id);
  assert.equal(gapIds.length, 8);
  assert.equal(new Set(gapIds).size, 8);
  assert.deepEqual(gapIds.slice().sort(), Array.from({ length: 8 }, (_, index) => `${META_STORY_ID}:F-${String(index + 1).padStart(3, '0')}`));
  let ledger = store.readFindingLedger<JsonValue>(META_STORY_ID);
  assert.equal(ledger.records.filter((record) => record.recordType === 'finding').length, 8);

  const ctx: HandlerContext = { root, scanRoot: root, store };
  const authoritativeMutation = createAuthoritativeFindingMutation(ctx);
  const auditFinding = upsertDrift(store, 1, {
    sectionPath: 'CLAUDE.md#authoritative', symbol: 'finding_projection', driftType: 'missing-ledger-fact',
    desc: 'authoritative audit drift', severity: 'high',
  }, META_STORY_ID, authoritativeMutation);
  assert.equal(store.readFindings(META_STORY_ID).findings.find((finding) => finding.id === auditFinding.findingId)?.status, 'open');
  const resolvedAudit = autoResolveMissing(store, 2, new Set(), META_STORY_ID, authoritativeMutation);
  assert.deepEqual(resolvedAudit, [auditFinding.findingId]);
  assert.equal(store.readFindings(META_STORY_ID).findings.find((finding) => finding.id === auditFinding.findingId)?.status, 'resolved');

  const clusterHandlers = createClusterHandlers(ctx);
  assert.match(clusterHandlers.finding_cluster({ storyId: META_STORY_ID, merge: gapIds.slice(0, 2) }), /Force-merged 2 findings/);
  const cluster = store.readClusters(META_STORY_ID).clusters.at(-1)!;
  assert.ok(cluster.clusterId);
  let projected = store.readFindings(META_STORY_ID);
  assert.equal(projected.findings.filter((finding) => gapIds.slice(0, 2).includes(finding.id))
    .every((finding) => finding.clusterId === cluster.clusterId), true);

  const signatureMap = join(root, 'signature-map.json');
  writeFileSync(signatureMap, JSON.stringify({ [gapIds[0]!]: 'ledger|projection' }));
  const backfill = createSignatureBackfillHandlers(ctx).signature_backfill({ map: signatureMap, apply: true, json: true });
  assert.equal(JSON.parse(backfill).filled, 1);
  assert.equal(store.readFindings(META_STORY_ID).findings.find((finding) => finding.id === gapIds[0])?.signatureTag, 'ledger|projection');

  // Prove the ledger, not the compatibility mirror, owns the cluster/signature projection.
  const shadow = store.readFindings(META_STORY_ID);
  for (const finding of shadow.findings) {
    if (gapIds.slice(0, 2).includes(finding.id)) delete finding.clusterId;
    if (finding.id === gapIds[0]) {
      delete finding.signatureTag;
      delete finding.signatureTagSource;
    }
  }
  store.writeFindings(META_STORY_ID, shadow);
  projected = store.readFindings(META_STORY_ID);
  assert.equal(projected.findings.find((finding) => finding.id === gapIds[0])?.signatureTag, 'ledger|projection');
  assert.equal(projected.findings.find((finding) => finding.id === gapIds[1])?.clusterId, cluster.clusterId);

  git(root, ['checkout', '-q', '-b', 'story/mutation-smoke']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=mutation-smoke', '-c', 'user.email=mutation@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `resolve fixture\n\nResolves: ${cluster.clusterId}`]);
  const beforeRead = readOnlySecuritySnapshot(root);
  createFindingHandlers(ctx).finding_list({ storyId: META_STORY_ID, full: true });
  assert.deepEqual(readOnlySecuritySnapshot(root), beforeRead, 'finding_list must not resolve commits as a read side effect');
  projected = store.readFindings(META_STORY_ID);
  assert.equal(projected.findings.filter((finding) => gapIds.slice(0, 2).includes(finding.id))
    .every((finding) => finding.status === 'open'), true);
  const synchronized = syncClusterResolves(META_STORY_ID, store, root, undefined, authoritativeMutation);
  assert.equal(synchronized.resolved, 2, 'the explicit synchronization writer resolves both cluster members');
  projected = store.readFindings(META_STORY_ID);
  assert.equal(projected.findings.filter((finding) => gapIds.slice(0, 2).includes(finding.id))
    .every((finding) => finding.status === 'resolved'), true);

  ledger = store.readFindingLedger<JsonValue>(META_STORY_ID);
  const trust = findingLedgerTrustFromWorkspace(root);
  assert.equal(ledger.records.filter((record) => record.recordType === 'finding_projection').length >= 4, true);
  assert.equal((ledger.receipts as Array<typeof ledger.receipts[number] & { findingLedgerReceipt?: ReturnType<typeof appendFindingLedger> }>)
    .filter((receipt) => receipt.operation === 'append_finding_projection')
    .every((receipt) => !!receipt.findingLedgerReceipt && verifyFindingLedgerReceipt(receipt.findingLedgerReceipt, trust)), true);
  console.log('finding.authoritative_live_mutations: PASS concurrentMeta=8 audit=true cluster=true clusterSync=true signatureBackfill=true status=true readAfterWrite=true');
}

export function runProjectionReceiptBindingRegression(scratch: string): void {
  const root = join(scratch, 'projection-receipt-binding');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements', storyPrefix: 'B',
  }));
  git(root, ['init', '-q', '-b', 'main']);
  const store = new StoryStore(root);
  const storyId = 'B-PROJECTION';
  const mutate = createAuthoritativeFindingMutation({ root, scanRoot: root, store });
  mutate(storyId, 'seed', (data) => {
    data.findings.push(...[1, 2].map((index): Finding => ({
      id: `${storyId}:F-${index}`, desc: `seed-${index}`, status: 'open', severity: 'high', category: 'missing',
    })));
    return { result: undefined };
  });
  mutate(storyId, 'two-projections', (data) => {
    data.findings.forEach((finding, index) => { finding.desc = `reviewed-${index + 1}`; });
    return { result: undefined };
  });
  const baseline = store.readFindingLedger<JsonValue>(storyId);
  const batch = baseline.receipts.at(-1)!;
  assert.equal(batch.recordIds.length, 2);
  assert.deepEqual(store.readFindings(storyId).findings.map((finding) => finding.desc), ['reviewed-1', 'reviewed-2']);
  const trust = findingLedgerTrustFromWorkspace(root);
  const signedReceipt = (batch as typeof batch & { findingLedgerReceipt: ReturnType<typeof signFindingLedgerReceipt> }).findingLedgerReceipt;
  assert.equal(verifyFindingLedgerReceipt(signedReceipt, trust), true);
  const signedBytes = canonicalJson(signedReceipt);
  const failures: string[] = [];
  const expectedSeedRows = [1, 2].map((index) => ({ id: `${storyId}:F-${index}`, status: 'open', desc: `seed-${index}` }));
  const readFiles = [store.findingLedgerPath(storyId), store.storyFilePath(storyId, 'findings.json')];
  const candidates: Array<[string, (candidate: typeof baseline) => void]> = [
    ['payload-with-recomputed-outer-hashes', (candidate) => {
      const record = candidate.records.find((entry) => entry.recordId === batch.recordIds[0])!;
      const payload = record.payload as Record<string, JsonValue>;
      payload.projection = { ...payload.projection as Record<string, JsonValue>, status: 'resolved' };
      record.payloadHash = canonicalHash(record.payload);
      candidate.committedLedgerDigest = canonicalHash(candidate.records);
      candidate.receipts.at(-1)!.committedLedgerDigest = candidate.committedLedgerDigest;
    }],
    ['prior-prefix-content', (candidate) => {
      candidate.records[0]!.payload = { ...candidate.records[0]!.payload as Record<string, JsonValue>, desc: 'altered-source' };
      candidate.records[0]!.payloadHash = canonicalHash(candidate.records[0]!.payload);
      candidate.committedLedgerDigest = canonicalHash(candidate.records);
      candidate.receipts.at(-1)!.committedLedgerDigest = candidate.committedLedgerDigest;
    }],
    ['outer-prior-digest', (candidate) => { candidate.receipts.at(-1)!.priorLedgerDigest = '0'.repeat(64); }],
    ['outer-record-subset', (candidate) => { candidate.receipts.at(-1)!.recordIds = [batch.recordIds[0]!]; }],
    ['outer-record-order', (candidate) => { candidate.receipts.at(-1)!.recordIds.reverse(); }],
    ['outer-idempotency', (candidate) => { candidate.receipts.at(-1)!.idempotencyKey = 'different-transaction'; }],
    ['outer-writer', (candidate) => { candidate.receipts.at(-1)!.writerSessionId = 'different-writer'; }],
    ['duplicate-carrier', (candidate) => {
      candidate.receipts.push({ ...structuredClone(candidate.receipts.at(-1)!), receiptId: 'duplicate-carrier', idempotencyKey: 'duplicate-carrier' });
    }],
  ];
  for (const [name, alter] of candidates) {
    const candidate = structuredClone(baseline);
    alter(candidate);
    assert.equal(canonicalJson((candidate.receipts.find((receipt) => receipt.receiptId === batch.receiptId) as typeof batch & {
      findingLedgerReceipt: ReturnType<typeof signFindingLedgerReceipt>;
    }).findingLedgerReceipt), signedBytes, `${name}: fixture changed signed receipt`);
    writeFileSync(store.findingLedgerPath(storyId), `${JSON.stringify(candidate, null, 2)}\n`);
    // The unsigned storage envelope passes; only authenticated consumption can reject this.
    assert.doesNotThrow(() => store.readFindingLedger(storyId));
    const beforeRead = readFiles.map((file) => readFileSync(file, 'utf8'));
    if (name === 'prior-prefix-content') {
      assert.throws(() => store.readFindings(storyId), /FINDING_LEDGER_AUTHORITY_INVALID/, 'corrupt base must fail closed before projection');
    } else {
      const observed = store.readFindings(storyId).findings;
      if (observed.some((finding) => finding.status !== 'open' || finding.desc.startsWith('reviewed-'))) {
        failures.push(`${name}: inconsistent projection consumed`);
      }
      assert.deepEqual(observed.map(({ id, status, desc }) => ({ id, status, desc })), expectedSeedRows,
        `${name}: invalid projection must preserve every original open Finding`);
    }
    assert.deepEqual(readFiles.map((file) => readFileSync(file, 'utf8')), beforeRead, 'readFindings wrote the ledger or mirror');
  }
  const casMutations: Array<[string, (bindings: typeof signedReceipt.casBindings) => typeof signedReceipt.casBindings]> = [
    ['missing', () => []],
    ['extra', (bindings) => [...bindings, { ...bindings[0]!, expectedRecordId: 'unexpected-source' }]],
    ['duplicate', (bindings) => [bindings[0]!, bindings[0]!]],
    ...['recordType', 'expectedRecordId', 'expectedRecordHash', 'observedChainHeadId', 'observedChainHeadHash', 'predicateDigest']
      .map((field): [string, (bindings: typeof signedReceipt.casBindings) => typeof signedReceipt.casBindings] => [
        field, (bindings) => [{ ...bindings[0]!, [field]: 'wrong-bound-value' }, ...bindings.slice(1)],
      ]),
  ];
  const withResignedCas = (change: typeof casMutations[number][1]) => {
    const candidate = structuredClone(baseline);
    const carrier = candidate.receipts.at(-1)! as typeof batch & { exactRequestDigest: string; findingLedgerReceipt: typeof signedReceipt };
    const { signature: _signature, receiptHash: _receiptHash, ...unsigned } = carrier.findingLedgerReceipt;
    unsigned.casBindings = change(unsigned.casBindings);
    const requestRecords = carrier.recordIds.map((id) => candidate.records.find((record) => record.recordId === id)!)
      .map((record) => ({ recordType: record.recordType, payload: record.payload,
        ...(record.uniqueBindingKey ? { uniqueBindingKey: record.uniqueBindingKey } : {}) }));
    unsigned.exactRequestDigest = canonicalHash({ storyId, operation: carrier.operation, idempotencyKey: carrier.idempotencyKey,
      records: requestRecords, casBindings: unsigned.casBindings });
    carrier.exactRequestDigest = unsigned.exactRequestDigest;
    carrier.findingLedgerReceipt = signFindingLedgerReceipt(unsigned, findingLedgerSignerFromWorkspace(root));
    assert.equal(verifyFindingLedgerReceipt(carrier.findingLedgerReceipt, trust), true);
    return candidate;
  };
  for (const [name, change] of casMutations) {
    writeFileSync(store.findingLedgerPath(storyId), `${JSON.stringify(withResignedCas(change))}\n`);
    const beforeRead = readFiles.map((file) => readFileSync(file, 'utf8'));
    const observed = store.readFindings(storyId).findings;
    if (observed.some((finding) => finding.desc.startsWith('reviewed-'))) failures.push(`signed-cas-${name}: invalid CAS projection consumed`);
    assert.deepEqual(observed.map(({ id, status, desc }) => ({ id, status, desc })), expectedSeedRows,
      `signed-cas-${name}: invalid CAS must preserve every original open Finding`);
    assert.deepEqual(readFiles.map((file) => readFileSync(file, 'utf8')), beforeRead, `signed-cas-${name}: readFindings wrote the ledger or mirror`);
  }
  writeFileSync(store.findingLedgerPath(storyId), `${JSON.stringify(withResignedCas((bindings) => bindings.reverse()))}\n`);
  assert.deepEqual(store.readFindings(storyId).findings.map((finding) => finding.desc), ['reviewed-1', 'reviewed-2'], 'CAS is an exact set, not an ordering requirement');
  writeFileSync(store.findingLedgerPath(storyId), `${JSON.stringify(baseline, null, 2)}\n`);
  mutate(storyId, 'mixed-new-and-projection', (data) => {
    data.findings[0]!.desc = 'mixed-projection';
    data.findings.push({ id: `${storyId}:F-3`, desc: 'new-in-mixed-batch', status: 'open', severity: 'medium', category: 'missing' });
    return { result: undefined };
  });
  const mixed = store.readFindingLedger<JsonValue>(storyId);
  const mixedReceipt = mixed.receipts.at(-1)!;
  assert.deepEqual(mixedReceipt.recordIds.map((id) => mixed.records.find((record) => record.recordId === id)!.recordType),
    ['finding_projection', 'finding']);
  assert.deepEqual(store.readFindings(storyId).findings.map((finding) => finding.desc),
    ['mixed-projection', 'reviewed-2', 'new-in-mixed-batch']);
  if (failures.length) console.error(`finding.projection_receipt_prefix: RED failures=${failures.length}\n${failures.join('\n')}`);
  assert.equal(failures.length, 0, 'Signed projection receipt must authenticate actual transaction prefix');
  console.log('finding.projection_receipt_prefix: PASS signedReceiptUnchanged=true tamperRejected=8 batchRows=2 mixedBatch=true readAfterWrite=true readWrites=0');
  console.log('finding.projection_source_cas: PASS resignedInvalid=9 exactSourceSet=true tupleFields=6 unorderedSet=accepted mixedBatch=accepted');
}

export function runBaseFindingAuthorityRegression(scratch: string): void {
  const root = join(scratch, 'base-finding-authority');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
  }));
  git(root, ['init', '-q', '-b', 'main']);
  const store = new StoryStore(root);
  const storyId = 'B-BASE';
  const signer = findingLedgerSignerFromWorkspace(root);
  const rows: Finding[] = [1, 2].map((index) => ({
    id: `${storyId}:F-${index}`, desc: `trusted-base-${index}`, status: 'open', severity: 'high',
    category: 'adversarial', evidenceState: 'verified', agent: 'proof-or-stop-review-concept',
  }));
  const lockDir = store.storyFilePath(storyId, 'findings.lock');
  const lock = acquireMkdirLock(lockDir, { label: 'base authority regression', requireHolderToken: true });
  try {
    const fence = captureMkdirLockFence(lockDir);
    appendFindingLedger({ storyId, store, operation: 'append_finding', idempotencyKey: 'base:batch',
      records: rows.map((finding) => ({ recordType: 'finding', payload: finding as unknown as JsonValue })),
      writerSessionId: 'base-smoke', writerLeaseId: 'base-smoke', writerFenceToken: fence.writerFenceToken, fence, signer });
  } finally { lock.release(); }
  const baseline = store.readFindingLedger<JsonValue>(storyId);
  assert.deepEqual(store.readFindings(storyId).findings.map((finding) => finding.status), ['open', 'open']);
  const signedBytes = canonicalJson((baseline.receipts[0] as typeof baseline.receipts[number] & {
    findingLedgerReceipt: ReturnType<typeof signFindingLedgerReceipt>;
  }).findingLedgerReceipt);
  const mutations: Array<[string, (candidate: typeof baseline) => void]> = [
    ...Object.entries({ status: 'resolved', category: 'happy', evidenceState: 'disproven', agent: 'main', id: 'B-OTHER:F-1' })
      .map(([field, value]): [string, (candidate: typeof baseline) => void] => [field, (candidate) => {
        (candidate.records[0]!.payload as Record<string, JsonValue>)[field] = value;
      }]),
    ['missing-description', (candidate) => { delete (candidate.records[0]!.payload as Record<string, JsonValue>).desc; }],
    ['null-payload', (candidate) => { candidate.records[0]!.payload = null; }],
    ['wrong-operation', (candidate) => { candidate.receipts[0]!.operation = 'append_route_receipt'; }],
    ['missing-carrier', (candidate) => { candidate.receipts = []; }],
    ['duplicate-carrier', (candidate) => { candidate.receipts.push({ ...structuredClone(candidate.receipts[0]!), receiptId: 'duplicate', idempotencyKey: 'duplicate' }); }],
  ];
  const failures: string[] = [];
  for (const [name, mutate] of mutations) {
    const candidate = structuredClone(baseline);
    mutate(candidate);
    candidate.records.forEach((record) => { record.payloadHash = canonicalHash(record.payload); });
    candidate.committedLedgerDigest = canonicalHash(candidate.records);
    if (candidate.receipts.length) candidate.receipts.at(-1)!.committedLedgerDigest = candidate.committedLedgerDigest;
    if (candidate.receipts.length) assert.equal(canonicalJson((candidate.receipts[0] as typeof baseline.receipts[number] & {
      findingLedgerReceipt: ReturnType<typeof signFindingLedgerReceipt>;
    }).findingLedgerReceipt), signedBytes);
    writeFileSync(store.findingLedgerPath(storyId), `${JSON.stringify(candidate)}\n`);
    assert.doesNotThrow(() => store.readFindingLedger(storyId), `${name}: mutation must reach authority check`);
    for (const mirror of ['empty', 'false-closed']) {
      store.writeFindings(storyId, { findings: mirror === 'empty' ? [] : rows.map((finding) => ({ ...finding, status: 'resolved' })) });
      const before = readFileSync(store.findingLedgerPath(storyId), 'utf8');
      let rejected = false;
      try { store.readFindings(storyId); } catch (error) { rejected = /FINDING_LEDGER_AUTHORITY_INVALID/.test(String(error)); }
      if (!rejected) failures.push(`${name}/${mirror}: untrusted base returned instead of explicit fail-closed refusal`);
      assert.equal(readFileSync(store.findingLedgerPath(storyId), 'utf8'), before);
    }
  }
  writeFileSync(store.findingLedgerPath(storyId), `${JSON.stringify(baseline)}\n`);
  assert.deepEqual(store.readFindings(storyId).findings.map((finding) => finding.status), ['open', 'open']);
  const oldSigned = structuredClone(baseline);
  const oldCarrier = oldSigned.receipts[0] as typeof baseline.receipts[number] & { findingLedgerReceipt: ReturnType<typeof signFindingLedgerReceipt> };
  const { signature: _oldSignature, receiptHash: _oldReceiptHash, exactRequestDigest: _oldExact, ...oldDomain } = oldCarrier.findingLedgerReceipt;
  oldCarrier.findingLedgerReceipt = signFindingLedgerReceipt(oldDomain, signer);
  assert.equal(verifyFindingLedgerReceipt(oldCarrier.findingLedgerReceipt, findingLedgerTrustFromWorkspace(root)), true);
  writeFileSync(store.findingLedgerPath(storyId), `${JSON.stringify(oldSigned)}\n`);
  assert.deepEqual(store.readFindings(storyId).findings.map((finding) => finding.status), ['open', 'open'], 'valid pre-exact signed base authenticates its full payload prefix');
  const oldTampered = structuredClone(oldSigned);
  (oldTampered.records[0]!.payload as Record<string, JsonValue>).status = 'resolved';
  oldTampered.records[0]!.payloadHash = canonicalHash(oldTampered.records[0]!.payload);
  oldTampered.committedLedgerDigest = canonicalHash(oldTampered.records);
  oldTampered.receipts[0]!.committedLedgerDigest = oldTampered.committedLedgerDigest;
  writeFileSync(store.findingLedgerPath(storyId), `${JSON.stringify(oldTampered)}\n`);
  assert.throws(() => store.readFindings(storyId), /FINDING_LEDGER_AUTHORITY_INVALID/, 'old signature compatibility still authenticates the actual prefix');
  writeFileSync(store.findingLedgerPath(storyId), `${JSON.stringify(baseline)}\n`);
  store.writeFindings('B-MIRROR-ONLY', { findings: [rows[0]!] });
  assert.deepEqual(store.readFindings('B-MIRROR-ONLY').findings, [rows[0]!]);
  const legacyId = 'B-REATTESTED';
  const legacyLockDir = store.storyFilePath(legacyId, 'findings.lock');
  const legacyLock = acquireMkdirLock(legacyLockDir, { label: 'explicit legacy base binding', requireHolderToken: true });
  try {
    const fence = captureMkdirLockFence(legacyLockDir);
    store.appendFindingLedgerTransaction(legacyId, request(fence.writerFenceToken, 'legacy-base:1', 'finding', {
      ...rows[0]!, id: `${legacyId}:F-1`,
    } as unknown as JsonValue), fence);
    assert.throws(() => store.readFindings(legacyId), /FINDING_LEDGER_AUTHORITY_INVALID/, 'unsigned base requires an explicit authenticated binding');
    bindLegacyFindingLedgerReceipts({ storyId: legacyId, store, writerSessionId: 'base-smoke', writerLeaseId: 'base-smoke',
      writerFenceToken: fence.writerFenceToken, fence, signer });
    assert.equal(store.readFindings(legacyId).findings[0]!.status, 'open');
    const oldBinding = store.readFindingLedger<JsonValue>(legacyId);
    const bindingCarrier = oldBinding.receipts.at(-1)! as typeof baseline.receipts[number] & { findingLedgerReceipt: ReturnType<typeof signFindingLedgerReceipt> };
    const { signature: _bindingSignature, receiptHash: _bindingReceiptHash, exactRequestDigest: _bindingExact, ...bindingDomain } = bindingCarrier.findingLedgerReceipt;
    bindingCarrier.findingLedgerReceipt = signFindingLedgerReceipt(bindingDomain, signer);
    assert.equal(verifyFindingLedgerReceipt(bindingCarrier.findingLedgerReceipt, findingLedgerTrustFromWorkspace(root)), true);
    writeFileSync(store.findingLedgerPath(legacyId), `${JSON.stringify(oldBinding)}\n`);
    assert.equal(store.readFindings(legacyId).findings[0]!.status, 'open', 'historical signed reattestation authenticates exact legacy bytes without signed request digest');
    bindingCarrier.findingLedgerReceipt.signature = 'invalid-signature';
    writeFileSync(store.findingLedgerPath(legacyId), `${JSON.stringify(oldBinding)}\n`);
    assert.throws(() => store.readFindings(legacyId), /FINDING_LEDGER_AUTHORITY_INVALID/);
  } finally { legacyLock.release(); }
  if (failures.length) console.error(`finding.base_receipt_authority: RED failures=${failures.length}\n${failures.join('\n')}`);
  assert.equal(failures.length, 0, 'Base Finding trust failure must never return an apparent gate result');
  console.log('finding.base_receipt_authority: PASS tamperCases=10 mirrorControls=2 refusal=explicit signedBatch=accepted legacyMirrorOnly=accepted readWrites=0');
  console.log('finding.base_legacy_binding: PASS unboundUnsigned=refused signedReattestation=accepted');
  console.log('finding.base_pre_exact_receipt: PASS signedPrefix=accepted changedPrefix=refused');
}

export function runLegacyIdentityAuthorityRegression(scratch: string): void {
  const root = join(scratch, 'legacy-identity-authority');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
  }));
  git(root, ['init', '-q', '-b', 'main']);
  const store = new StoryStore(root);
  const signer = findingLedgerSignerFromWorkspace(root);
  const failures: string[] = [];
  const terminalFields = ['resolvedAt', 'resolvedReason', 'resolutionType', 'resolveEvidenceStrength',
    'dismissedAt', 'dismissReason', 'dismissReasonType', 'dismissEvidenceStrength'];
  for (const terminal of ['resolved', 'dismissed'] as const) {
    const storyId = `B-LEGACY-${terminal}`;
    const original: Finding = { id: `${storyId}:F-1`, desc: 'authenticated original legacy finding', status: 'open', severity: 'high', category: 'missing' };
    store.writeFindings(storyId, { findings: [original] });
    const lockDir = store.storyFilePath(storyId, 'findings.lock');
    const lock = acquireMkdirLock(lockDir, { label: 'legacy identity authority', requireHolderToken: true });
    let boundOnly: ReturnType<typeof store.readFindingLedger<JsonValue>>;
    try {
      const fence = captureMkdirLockFence(lockDir);
      const appendOptions = { storyId, store, writerSessionId: 'legacy-authority-smoke', writerLeaseId: 'legacy-authority-smoke',
        writerFenceToken: fence.writerFenceToken, fence, signer };
      const findingHash = canonicalHash(original);
      appendFindingLedger({ ...appendOptions, operation: 'append_legacy_identity_binding', idempotencyKey: `legacy-finding-binding:${original.id}:${findingHash}`,
        records: [{ recordType: 'legacy_identity_binding', payload: { schemaVersion: 1, bindingType: 'legacy-finding', findingId: original.id, findingHash },
          uniqueBindingKey: `legacy-finding:${original.id}` }] });
      boundOnly = store.readFindingLedger<JsonValue>(storyId);
      const source = boundOnly.records[0]!;
      const predicateDigest = canonicalHash({ schemaVersion: 1, predicate: 'finding-open-without-terminal-transition', findingId: original.id, findingRecordId: source.recordId });
      appendFindingLedger({ ...appendOptions, operation: 'append_finding_lifecycle_transition', idempotencyKey: `finding-lifecycle:${source.recordId}:${terminal}`,
        records: [{ recordType: 'finding_lifecycle_transition', payload: { schemaVersion: 1, transitionId: 'fixture-transition', findingId: original.id,
          findingRecordId: source.recordId, fromStatus: 'open', toStatus: terminal, at: '2030-01-01T00:00:00Z', reason: 'signed reason' },
          uniqueBindingKey: `finding-lifecycle:${source.recordId}` }],
        casBindings: [{ recordType: source.recordType, expectedRecordId: source.recordId, expectedRecordHash: canonicalHash(source),
          observedChainHeadId: source.recordId, observedChainHeadHash: canonicalHash(source), predicateDigest }],
        verifyPredicate: () => ({ accepted: true, predicateDigest }) });
    } finally { lock.release(); }
    const valid = store.readFindingLedger<JsonValue>(storyId);
    const falseClosed = { ...original, status: terminal, ...Object.fromEntries(terminalFields.map((field) => [field, 'untrusted mirror value'])) } as Finding;
    const invalidTransition = structuredClone(valid);
    (invalidTransition.receipts.at(-1)! as typeof valid.receipts[number] & { findingLedgerReceipt: ReturnType<typeof signFindingLedgerReceipt> }).findingLedgerReceipt.signature = 'invalid-signature';
    for (const [name, candidate] of [['missing', boundOnly!], ['bad-signature', invalidTransition]] as const) {
      writeFileSync(store.findingLedgerPath(storyId), `${JSON.stringify(candidate)}\n`);
      store.writeFindings(storyId, { findings: [falseClosed] });
      const before = readFileSync(store.storyFilePath(storyId, 'findings.json'), 'utf8');
      const projected = store.readFindings(storyId).findings[0]!;
      if (projected.status !== 'open' || terminalFields.some((field) => Object.hasOwn(projected, field))) failures.push(`${terminal}/${name}: terminal mirror survived without trusted transition`);
      assert.equal(readFileSync(store.storyFilePath(storyId, 'findings.json'), 'utf8'), before);
    }
    writeFileSync(store.findingLedgerPath(storyId), `${JSON.stringify(valid)}\n`);
    store.writeFindings(storyId, { findings: [falseClosed] });
    const validBefore = readFileSync(store.storyFilePath(storyId, 'findings.json'), 'utf8');
    const validProjected = store.readFindings(storyId).findings[0]!;
    assert.equal(validProjected.status, terminal, 'valid signed terminal transition must survive mirror recovery');
    assert.equal(terminal === 'resolved' ? validProjected.resolvedReason : validProjected.dismissReason, 'signed reason');
    const otherPrefix = terminal === 'resolved' ? 'dismiss' : 'resolv';
    assert.equal(Object.keys(validProjected).some((key) => key.startsWith(otherPrefix)), false, 'opposite terminal fields must not survive normalization');
    assert.equal(readFileSync(store.storyFilePath(storyId, 'findings.json'), 'utf8'), validBefore);
    const invalidBinding = structuredClone(boundOnly!);
    (invalidBinding.receipts[0]! as typeof valid.receipts[number] & { findingLedgerReceipt: ReturnType<typeof signFindingLedgerReceipt> }).findingLedgerReceipt.signature = 'invalid-binding-signature';
    const mismatchMirrors = [
      { name: 'changed-description', rows: [{ ...falseClosed, desc: 'untrusted relabel' }], ledger: boundOnly! },
      { name: 'changed-category', rows: [{ ...falseClosed, category: 'edge' as const }], ledger: boundOnly! },
      { name: 'duplicate-mirror', rows: [falseClosed, falseClosed], ledger: boundOnly! },
      { name: 'invalid-binding', rows: [falseClosed], ledger: invalidBinding },
    ];
    for (const candidate of mismatchMirrors) {
      writeFileSync(store.findingLedgerPath(storyId), `${JSON.stringify(candidate.ledger)}\n`);
      store.writeFindings(storyId, { findings: candidate.rows });
      const before = [store.findingLedgerPath(storyId), store.storyFilePath(storyId, 'findings.json')].map((file) => readFileSync(file, 'utf8'));
      let refused = false;
      try { store.readFindings(storyId); } catch (error) { refused = /FINDING_LEDGER_AUTHORITY_INVALID/.test(String(error)); }
      if (!refused) failures.push(`${terminal}/${candidate.name}: untrusted bound mirror was returned`);
      assert.deepEqual([store.findingLedgerPath(storyId), store.storyFilePath(storyId, 'findings.json')].map((file) => readFileSync(file, 'utf8')), before);
    }
    writeFileSync(store.findingLedgerPath(storyId), `${JSON.stringify(boundOnly!)}\n`);
    store.writeFindings(storyId, { findings: [original] });
    const mutate = createAuthoritativeFindingMutation({ root, scanRoot: root, store });
    mutate(storyId, 'legacy-to-base', (data) => {
      data.findings[0]!.clusterId = 'C-LEGACY';
      return { result: undefined };
    });
    assert.equal(store.readFindingLedger(storyId).records.at(-1)!.recordType, 'finding', 'legacy-only mutation creates an authenticated base');
    mutate(storyId, 'legacy-base-to-projection', (data) => {
      data.findings[0]!.signatureTag = 'legacy-projection-tag';
      return { result: undefined };
    });
    assert.equal(store.readFindingLedger(storyId).records.at(-1)!.recordType, 'finding_projection');
    const currentMirror = store.readFindings(storyId);
    for (const mirror of [currentMirror, { findings: [original] }, { findings: [] }]) {
      store.writeFindings(storyId, mirror);
      const files = [store.findingLedgerPath(storyId), store.storyFilePath(storyId, 'findings.json')];
      const before = files.map((file) => readFileSync(file, 'utf8'));
      const restored = store.readFindings(storyId).findings;
      assert.equal(restored.length, 1);
      assert.equal(restored[0]!.clusterId, 'C-LEGACY');
      assert.equal(restored[0]!.signatureTag, 'legacy-projection-tag');
      assert.deepEqual(files.map((file) => readFileSync(file, 'utf8')), before);
    }
  }
  if (failures.length) console.error(`finding.legacy_identity_authority: RED failures=${failures.length}\n${failures.join('\n')}`);
  assert.equal(failures.length, 0, 'Legacy binding must reconstruct authenticated state or refuse');
  console.log('finding.legacy_identity_authority: PASS normalizedTerminalCases=4 mismatchedBindingCases=8 signedTerminals=2 strippedFields=8 mirrorWrites=0');
  console.log('finding.legacy_authoritative_mutation: PASS boundMirrorToSignedBase=true signedProjection=true mirrorControls=3 readWrites=0');
}

export function hasProtectedPathSurface(value: unknown, protectedValues: readonly string[]): boolean {
  if (typeof value === 'string') return protectedValues.some((candidate) => candidate && value.includes(candidate));
  if (Array.isArray(value)) return value.some((item) => hasProtectedPathSurface(item, protectedValues));
  if (!value || typeof value !== 'object') return false;
  const forbiddenKeys = new Set([
    'path', 'file', 'directory', 'root', 'realPath', 'absolutePath', 'ledgerPath',
    'lockPath', 'tempPath', 'artifactStoreRoot', 'storagePath',
  ]);
  return Object.entries(value).some(([key, item]) => forbiddenKeys.has(key) || hasProtectedPathSurface(item, protectedValues));
}

export function story3VerifierMutationAccepted(repositoryRoot: string, mutation: string): boolean {
  return spawnSync(process.execPath, [join(repositoryRoot, 'scripts', 'verify-process-fact-contract.mjs'), '--quiet'], {
    cwd: repositoryRoot,
    env: { ...process.env, PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION: mutation },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).status === 0;
}

export async function runStory3DependencyFixture(root: string): Promise<void> {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures',
    storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', storyPrefix: 'B',
  }, null, 2));
  const dependencyStore = new StoryStore(root);
  const plan = (storyId: string, depends: string[] = []): StoryInfo => ({
    ...runtimeStory(storyId), phase: 'PLAN', depends,
  });
  dependencyStore.writeStory('B-fe8f', plan('B-fe8f'));
  dependencyStore.writeStory('B-03b7', plan('B-03b7', ['B-fe8f']));
  dependencyStore.writeStory('B-e6d9', plan('B-e6d9', ['B-fe8f', 'B-03b7']));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=dependency-smoke', '-c', 'user.email=dependency@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial dependency plans']);
  const transitionCtx: HandlerContext = { store: dependencyStore, root, scanRoot: root };
  const beforeBlockedTransitions = new Map(['B-03b7', 'B-e6d9'].map((storyId) => [
    storyId, canonicalJson(dependencyStore.readStory(storyId)),
  ]));
  await assert.rejects(
    runStoryTransition(transitionCtx, { storyId: 'B-03b7', phase: 'DEV' }),
    /unfinished Story dependencies: B-fe8f\(PLAN\)/,
  );
  await assert.rejects(
    runStoryTransition(transitionCtx, { storyId: 'B-e6d9', phase: 'DEV' }),
    /unfinished Story dependencies: B-fe8f\(PLAN\), B-03b7\(PLAN\)/,
  );
  for (const [storyId, bytes] of beforeBlockedTransitions) {
    assert.equal(canonicalJson(dependencyStore.readStory(storyId)), bytes);
  }
  let transitionWrites = 0;
  const attempt = (storyId: string): string[] => {
    assert.ok(findLifecycleTransition('PLAN', 'DEV'), 'fixture dependency boundary must be a real lifecycle transition');
    const story = dependencyStore.readStory(storyId);
    try {
      assertPlanDevDependenciesDone(dependencyStore, story, 'DEV');
      transitionWrites += 1;
      return [];
    } catch (error) {
      return [...String((error as Error).message).matchAll(/(B-[A-Za-z0-9]+)\(/g)].map((match) => match[1]!);
    }
  };
  assert.deepEqual(attempt('B-03b7'), ['B-fe8f']);
  assert.deepEqual(attempt('B-e6d9'), ['B-fe8f', 'B-03b7']);
  assert.equal(transitionWrites, 0);
  console.log('dependency.lifecycle_gate: PASS B-03b7=blocked_by_B-fe8f B-e6d9=blocked_by_B-fe8f+B-03b7 transitionWrites=0');

  dependencyStore.writeStory('B-fe8f', { ...dependencyStore.readStory('B-fe8f'), phase: 'DONE' });
  assert.deepEqual(attempt('B-03b7'), ['B-fe8f']);
  assert.equal(transitionWrites, 0);
  git(root, ['checkout', '-q', '-b', 'story/B-fe8f']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=dependency-smoke', '-c', 'user.email=dependency@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'partial done dependency']);
  assert.deepEqual(attempt('B-03b7'), ['B-fe8f']);
  assert.equal(transitionWrites, 0);
  git(root, ['checkout', '-q', 'main']);
  git(root, ['merge', '-q', '--ff-only', 'story/B-fe8f']);
  assert.deepEqual(attempt('B-03b7'), []);
  assert.deepEqual(attempt('B-e6d9'), ['B-03b7']);
  dependencyStore.writeStory('B-03b7', { ...dependencyStore.readStory('B-03b7'), phase: 'DONE' });
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=dependency-smoke', '-c', 'user.email=dependency@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'merged second dependency']);
  assert.deepEqual(attempt('B-e6d9'), []);
  assert.equal(transitionWrites, 2);
  console.log('dependency.partial_done_gate: PASS phaseDoneOnly=reject unmergedStoryBranch=reject mergedMainFact=accept transitionWritesBeforeMerge=0');
  console.log('green.lifecycle_dependency_gate: PASS B-03b7=release_after_B-fe8f B-e6d9=release_after_B-fe8f+B-03b7');
}
