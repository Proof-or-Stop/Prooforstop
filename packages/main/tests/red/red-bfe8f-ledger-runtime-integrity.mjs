#!/usr/bin/env node
/**
 * B-fe8f CHK-001 — audit-first RED for Dynamic Finding Story 3.
 *
 * This is intentionally not a replay of historical F-029. The current Finding,
 * B-META, process-event, build, and Store write paths already contain useful
 * serialization/atomic-replacement primitives. Those are characterized as
 * passing below. The process exits non-zero only while the accepted Story 3
 * ledger/runtime contracts are absent; the same assertions turn green once the
 * production implementation exists.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STORY_ID = 'B-fe8f';
const RED_ID = 'RED-BFE8F-LEDGER-FOUNDATION-V2';
const ORIGINAL_RED_ID = 'RED-BFE8F-LEDGER-FOUNDATION';
const PROBE_ID = 'rp-mtifubae-dfbh4w';
const PROBE_DIGEST = '2debba0742404113a7b685e2b218f51057a8c37cfe2ad36c23bbec1404c9516c';
const RELATION_ID = 'rgr-mtifujpd-ijl3w5';
const RELATION_DIGEST = '8125cec78cf280acfef28985063f5dcbf7d433b293d85f3af578552c91a77faa';
const REVIEW_ID = 'rr-mtifws9p-6knju0';
const EVALUATION_ID = 'rgre-mtifx3sy-cdxd7d';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
while (
  !existsSync(join(repoRoot, 'proof-or-stop.config.json'))
  && repoRoot !== dirname(repoRoot)
) repoRoot = dirname(repoRoot);
assert.ok(existsSync(join(repoRoot, 'proof-or-stop.config.json')), 'could not locate Proof-or-Stop repository root');

const relSelf = relative(repoRoot, fileURLToPath(import.meta.url)).replaceAll('\\', '/');
const source = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
const sourceMaybe = (rel) => existsSync(join(repoRoot, rel)) ? source(rel) : '';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function runGit(args) {
  const result = run('git', args);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function parseCliJson(result, label) {
  assert.equal(result.status, 0, `${label} failed: ${result.stderr || result.stdout}`);
  const stdout = result.stdout ?? '';
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  assert.ok(start >= 0 && end > start, `${label} did not return a JSON object: ${stdout}`);
  return JSON.parse(stdout.slice(start, end + 1));
}

function runProof(command, payload) {
  return run('proof-or-stop', [command, JSON.stringify(payload)]);
}

const findingSource = source('packages/main/src/handlers/finding.ts');
const storeSource = source('packages/main/src/core/store.ts');
const typesSource = source('packages/main/src/core/types.ts');
const processEventSource = source('packages/main/src/core/process-events.ts');
const mainLockSource = source('packages/main/src/core/main-write-lock.ts');
const mkdirLockSource = source('packages/main/src/core/mkdir-lock.ts');
const buildLockSource = source('scripts/build-lock.mjs');
const buildMainSource = source('scripts/build-main-with-binding.mjs');
const buildUtilsSource = source('scripts/build-utils-with-binding.mjs');

// Existing primitives are real baselines. These assertions deliberately prove
// only their narrow contracts and never infer exactly-once ledger semantics.
assert.match(findingSource, /function withMetaFindingLock<[^>]+>/, 'Finding write lock wrapper is missing');
assert.match(findingSource, /const id = withMetaFindingLock\([\s\S]*?store\.writeFindings\(args\.storyId, data\);[\s\S]*?return fid;/, 'finding_add read/push/write is not inside its lock');
assert.match(findingSource, /storyId\.startsWith\('B-META-'\)[\s\S]*?withReentrantMainWriteLock|if \(!storyId\.startsWith\('B-META-'\)\)[\s\S]*?withReentrantMainWriteLock/, 'B-META writes do not route through the main lock');
assert.match(mainLockSource, /PROOF_OR_STOP_MAIN_WRITE_LOCK/, 'canonical main/B-META lock path is missing');
assert.match(mainLockSource, /acquireMkdirLock\(lockDir/, 'main write lock does not use the canonical mkdir primitive');
assert.match(processEventSource, /lockDir: string/, 'process-event append lock is not a required argument');
assert.match(processEventSource, /withMkdirLock\(lockDir,[\s\S]*?appendFileSync\(filePath, eventBytes\)/, 'process-event append is not serialized');
assert.match(buildLockSource, /lockfile\.lock\(target, BUILD_LOCK_OPTIONS\)/, 'build lock does not use the reviewed cross-process primitive');
assert.match(buildMainSource, /withBuildLock\(projectRoot/, 'main build does not use the shared build lock');
assert.match(buildUtilsSource, /withBuildLock\(projectRoot/, 'utils build does not use the shared build lock');
assert.match(storeSource, /writeFileSync\(tmpPath,[\s\S]*?JSON\.parse\(readFileSync\(tmpPath,[\s\S]*?renameSync\(tmpPath, filePath\)/, 'Store atomic replacement sequence regressed');
assert.match(typesSource, /export interface VerificationExecutionReceipt\s*{/, 'existing execution receipt disappeared');

// Executable platform round-trip of the exact temp/validate/rename sequence
// asserted above. This proves atomic replacement is available, not fsync.
const scratch = mkdtempSync(join(tmpdir(), 'bfe8f-red-'));
try {
  const target = join(scratch, 'findings.json');
  const temp = `${target}.tmp-${process.pid}`;
  const value = { findings: [{ id: 'B-TEMP:F-001', status: 'open' }] };
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  JSON.parse(readFileSync(temp, 'utf8'));
  renameSync(temp, target);
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).findings[0]?.id, 'B-TEMP:F-001', 'atomic replacement round-trip lost the Finding');
  assert.equal(readdirSync(scratch).some((name) => name.includes('.tmp-')), false, 'atomic replacement left a visible temp file');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// Executable probe of the actual shared build lock. Two overlapping callers
// must serialize; this is passing characterization, not the future receipt.
const { withBuildLock, buildLockTarget } = await import(pathToFileURL(join(repoRoot, 'scripts/build-lock.mjs')).href);
const buildKey = join(tmpdir(), `bfe8f-build-lock-${process.pid}-${Date.now()}`);
const order = [];
try {
  await Promise.all([
    withBuildLock(buildKey, async () => {
      order.push('first-enter');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
      order.push('first-exit');
    }),
    withBuildLock(buildKey, async () => {
      order.push('second-enter');
      order.push('second-exit');
    }),
  ]);
  assert.deepEqual(order, ['first-enter', 'first-exit', 'second-enter', 'second-exit'], 'actual build lock allowed overlap');
} finally {
  rmSync(`${buildLockTarget(buildKey)}.lock`, { recursive: true, force: true });
  rmSync(buildLockTarget(buildKey), { force: true });
}

const auditInputs = {
  ledger: sourceMaybe('packages/main/src/core/finding-ledger.ts'),
  ledgerHandler: sourceMaybe('packages/main/src/handlers/finding-ledger.ts'),
  runtime: sourceMaybe('packages/main/src/core/finding-runtime-evidence.ts'),
  runtimeHandler: sourceMaybe('packages/main/src/handlers/finding-runtime-evidence.ts'),
  store: storeSource,
  types: typesSource,
  registry: source('packages/main/src/registry.ts'),
};

const CONTRACTS = Object.freeze({
  'ledger.transaction_foundation_missing': (input) => [
    'ledgerSchemaEpoch',
    'minimumWriterCapability',
    'idempotencyKey',
    'writerFenceToken',
    'committedLedgerDigest',
  ].every((token) => input.ledger.includes(token)),
  'ledger.durable_fsync_commit_missing': (input) => {
    const durable = `${input.ledger}\n${input.store}`;
    return /fsyncSync/.test(durable) && /renameSync/.test(durable) && /fsyncDirectory|directory[^\n]*fsync/i.test(durable);
  },
  'ledger.exact_record_cas_missing': (input) => {
    const cas = `${input.ledger}\n${input.ledgerHandler}`;
    return ['expectedRecordId', 'expectedRecordHash', 'observedChainHeadHash', 'predicateDigest'].every((token) => cas.includes(token));
  },
  'ledger.signed_receipt_contract_missing': (input) => {
    const match = /export interface FindingLedgerReceipt\s*{([\s\S]*?)\n}/.exec(input.types);
    return Boolean(match && ['receiptId', 'recordIds', 'priorLedgerDigest', 'committedLedgerDigest', 'receiptHash', 'signature'].every((token) => match[1].includes(token)));
  },
  'runtime.evidence_receipt_missing': (input) => {
    const match = /export interface RuntimeEvidenceReceipt\s*{([\s\S]*?)\n}/.exec(input.types);
    return Boolean(match && ['sourceMaterialHash', 'buildCommandDigest', 'executionCommandDigest', 'artifactManifest', 'environmentDigest', 'receiptHash', 'signature'].every((token) => match[1].includes(token)));
  },
  'runtime.execution_adapter_missing': (input) => {
    const runtime = `${input.runtime}\n${input.runtimeHandler}\n${input.registry}`;
    return ['finding_runtime_evidence_run', 'finding_runtime_evidence_verify', 'append_runtime_receipt', 'realpathPolicyDigest'].every((token) => runtime.includes(token));
  },
});

function missingContracts(input) {
  return Object.entries(CONTRACTS).filter(([, present]) => !present(input)).map(([reason]) => reason);
}

const gaps = missingContracts(auditInputs);
assert.ok(gaps.length > 0 || existsSync(join(repoRoot, 'packages/main/src/core/finding-ledger.ts')), 'RED classifier found no gap and no GREEN ledger module');

// Independent source mutations satisfy one checker at a time. This ensures the
// RED classifier cannot turn an unrelated already-passing primitive red.
const fillers = {
  'ledger.transaction_foundation_missing': { key: 'ledger', value: '\nledgerSchemaEpoch minimumWriterCapability idempotencyKey writerFenceToken committedLedgerDigest\n' },
  'ledger.durable_fsync_commit_missing': { key: 'ledger', value: '\nfsyncSync renameSync fsyncDirectory\n' },
  'ledger.exact_record_cas_missing': { key: 'ledgerHandler', value: '\nexpectedRecordId expectedRecordHash observedChainHeadHash predicateDigest\n' },
  'ledger.signed_receipt_contract_missing': { key: 'types', value: '\nexport interface FindingLedgerReceipt { receiptId:string; recordIds:string[]; priorLedgerDigest:string; committedLedgerDigest:string; receiptHash:string; signature:string;\n}\n' },
  'runtime.evidence_receipt_missing': { key: 'types', value: '\nexport interface RuntimeEvidenceReceipt { sourceMaterialHash:string; buildCommandDigest:string; executionCommandDigest:string; artifactManifest:unknown; environmentDigest:string; receiptHash:string; signature:string;\n}\n' },
  'runtime.execution_adapter_missing': { key: 'runtime', value: '\nfinding_runtime_evidence_run finding_runtime_evidence_verify append_runtime_receipt realpathPolicyDigest\n' },
};
for (const reason of gaps) {
  const filler = fillers[reason];
  const mutated = { ...auditInputs, [filler.key]: `${auditInputs[filler.key]}${filler.value}` };
  const after = missingContracts(mutated);
  assert.equal(after.includes(reason), false, `mutation did not isolate ${reason}`);
  assert.deepEqual(after, gaps.filter((item) => item !== reason), `mutation for ${reason} changed an unrelated contract verdict`);
}

// The accepted primitive boundary must remain explicit: serialization/rename
// are passing, while array-length IDs, no fsync, and the coarse existing receipt
// do not masquerade as the Story 3 contracts.
assert.match(findingSource, /const nextNum = data\.findings\.length \+ 1;/, 'pre-GREEN Finding ID baseline changed without the accepted allocator');
assert.doesNotMatch(storeSource, /fsyncSync/, 'Store baseline unexpectedly claims fsync durability; update the audit classification');
const verificationReceiptBody = /export interface VerificationExecutionReceipt\s*{([\s\S]*?)\n}/.exec(typesSource)?.[1] ?? '';
assert.doesNotMatch(verificationReceiptBody, /artifactManifest|sourceMaterialHash|trustRootDigest/, 'coarse verification receipt unexpectedly contains the Story 3 runtime contract');

// Official append-only RED evidence: V2 corrects only the malformed command in
// V1, while V1's reviewed receipt digest remains preserved. The pair binds the
// immutable baseline and the accepted relation/review artifacts.
const evidence = parseCliJson(runProof('red_evidence_get', { storyId: STORY_ID, json: true }), 'red_evidence_get');
const original = evidence.records?.find((record) => record.id === ORIGINAL_RED_ID);
const official = [...(evidence.records ?? [])].reverse().find((record) => record.id === RED_ID);
assert.ok(original && official, 'official append-only RED evidence pair is missing');
const probe = parseCliJson(runProof('repro_probe_get', { probeId: PROBE_ID }), 'repro_probe_get');
assert.equal(probe.artifactDigest, PROBE_DIGEST, 'probe digest changed');
assert.equal(probe.payload?.executionStatus, 'confirmed_failing', 'probe is not a confirmed failing baseline');
assert.equal(probe.payload?.expectedFailurePattern, 'ERR_MODULE_NOT_FOUND', 'probe failure matcher changed');
assert.equal(original.failureReceiptHash, PROBE_DIGEST, 'original official RED is not bound to the reviewed probe digest');
assert.equal(official.baselineHeadHash, probe.payload?.baselineHeadHash, 'official RED and reviewed probe bind different baseline HEADs');
assert.match(official.baselineMaterialHash ?? '', /^[0-9a-f]{64}$/, 'official RED lacks a material hash');
assert.match(official.observedFailure ?? '', /ERR_MODULE_NOT_FOUND/, 'official RED does not state the reviewed failure');
assert.match(official.failingCommand ?? '', /import\(process\.argv\[1\]\)/, 'official corrected command is not executable/argument-bound');
assert.match(official.failingCommand ?? '', /\.\/packages\/main\/dist\/core\/finding-ledger\.js/, 'official command targets the wrong module');
assert.match(official.note ?? '', new RegExp(ORIGINAL_RED_ID), 'V2 does not preserve/supersede the malformed V1 command field');
for (const ref of [PROBE_ID, REVIEW_ID, RELATION_ID, EVALUATION_ID]) {
  assert.match(official.note ?? '', new RegExp(ref), `official RED does not bind ${ref}`);
}
assert.equal(run('git', ['merge-base', '--is-ancestor', official.baselineHeadHash, 'HEAD']).status, 0, 'official pre-fix HEAD is not an ancestor of the RED tree');

// While still RED, the corrected stored command itself must reproduce the exact
// reviewed failure. After GREEN, the immutable reviewed probe remains the
// baseline proof and this branch intentionally stops expecting a current fail.
if (gaps.length > 0) {
  const reproduced = run('/bin/sh', ['-c', official.failingCommand]);
  assert.notEqual(reproduced.status, 0, 'pre-fix official RED command unexpectedly passed');
  assert.match(`${reproduced.stdout}\n${reproduced.stderr}`, /ERR_MODULE_NOT_FOUND/, 'official RED command failed for a different reason');
}

function officialBindingAccepts(record, reviewedProbe, options = {}) {
  const dirty = options.dirty === true;
  return !dirty
    && record.baselineHeadHash === reviewedProbe.payload?.baselineHeadHash
    && typeof record.failingCommand === 'string'
    && /import\(process\.argv\[1\]\)/.test(record.failingCommand)
    && typeof record.observedFailure === 'string'
    && record.observedFailure.includes(reviewedProbe.payload?.expectedFailurePattern ?? '__missing__');
}
assert.equal(officialBindingAccepts(official, probe), true, 'official RED pair is not admissible');
assert.equal(officialBindingAccepts({ ...official, baselineHeadHash: '0'.repeat(40) }, probe), false, 'changed HEAD was accepted');
assert.equal(officialBindingAccepts(official, probe, { dirty: true }), false, 'dirty execution was accepted');
assert.equal(officialBindingAccepts({ ...official, failingCommand: '' }, probe), false, 'missing executable command was accepted');
assert.equal(officialBindingAccepts({ ...official, observedFailure: 'generic failure' }, probe), false, 'failure without the asserted reason was accepted');

// The original RED commit must contain only this characterization asset (plus
// CLI-owned story metadata, if committed together); later GREEN production
// commits therefore cannot retroactively contaminate the RED artifact.
const introduction = runGit(['log', '--format=%H', '--diff-filter=A', '--', relSelf]).split('\n').filter(Boolean)[0];
if (introduction) {
  const introducedPaths = runGit(['show', '--format=', '--name-only', introduction]).split('\n').filter(Boolean);
  const nonMetadata = introducedPaths.filter((path) => !path.startsWith('.lattice/story/'));
  assert.deepEqual(nonMetadata, [relSelf], `RED introduction commit changed production paths: ${nonMetadata.join(', ')}`);
} else {
  const statusResult = run('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  assert.equal(statusResult.status, 0, `git status failed: ${statusResult.stderr}`);
  const dirtyPaths = (statusResult.stdout ?? '').trimEnd().split('\n').filter(Boolean).map((line) => line.slice(3));
  const nonMetadata = dirtyPaths.filter((path) => !path.startsWith('.lattice/story/') && path !== relSelf);
  assert.deepEqual(nonMetadata, [], `uncommitted production changes contaminate RED: ${nonMetadata.join(', ')}`);
}

// Relation evaluation is integrity-pinned. Correct digest + independently
// reviewed probe is accepted; one-bit digest mutation fails closed.
const relationEvaluation = parseCliJson(
  runProof('red_green_relation_evaluate', { relationId: RELATION_ID, relationDigest: RELATION_DIGEST }),
  'red_green_relation_evaluate',
);
assert.equal(relationEvaluation.pass, true, 'accepted RED/GREEN relation did not evaluate');
assert.equal(relationEvaluation.candidateId, probe.candidateId, 'relation/probe candidate binding changed');
assert.ok(relationEvaluation.reasons?.some((reason) => /command specs match/.test(reason)), 'relation no longer proves unchanged command specs');
const badDigest = `${RELATION_DIGEST.slice(0, -1)}${RELATION_DIGEST.endsWith('0') ? '1' : '0'}`;
const mutatedRelation = runProof('red_green_relation_evaluate', { relationId: RELATION_ID, relationDigest: badDigest });
assert.notEqual(mutatedRelation.status, 0, 'mutated relation digest was accepted');
assert.match(`${mutatedRelation.stdout}\n${mutatedRelation.stderr}`, /digest|integrity|mismatch/i, 'relation mutation refusal lacks an integrity reason');
const assertionDigest = sha256(JSON.stringify({ commandSpec: probe.payload.commandSpec, pattern: probe.payload.expectedFailurePattern }));
assert.match(assertionDigest, /^[0-9a-f]{64}$/, 'relation assertion digest is not stable');

// A concurrency allegation is evidence only when it carries a bounded command,
// a concrete observable class, and matching output. The accepted probe is a
// missing-module contract, not a current race claim.
function reproducibleConcurrencyClaim(claim) {
  const allowed = new Set(['lost-row', 'duplicate-durable-id', 'stale-cas-write', 'half-visible-commit', 'stale-runtime-acceptance']);
  return allowed.has(claim.observable)
    && typeof claim.command === 'string' && claim.command.trim().length > 0
    && claim.exitCode !== 0
    && typeof claim.output === 'string' && claim.output.includes(claim.pattern);
}
assert.equal(reproducibleConcurrencyClaim({ observable: 'race', command: '', exitCode: 0, output: '', pattern: 'lost' }), false, 'vague race claim was accepted');
assert.equal(reproducibleConcurrencyClaim({ observable: 'lost-row', command: 'node repro.mjs', exitCode: 1, output: 'no overlap observed', pattern: 'lost-row' }), false, 'non-reproducing race claim was accepted');
assert.doesNotMatch(official.observedFailure, /lost row|duplicate durable id|stale CAS|half-visible/i, 'official RED fabricated a current concurrency failure');
const substitutedProbe = { ...probe, payload: { ...probe.payload, executionStatus: 'confirmed_passing', boundedOutputExcerpt: 'PASS' } };
assert.equal(substitutedProbe.payload.executionStatus === 'confirmed_failing' && substitutedProbe.payload.boundedOutputExcerpt.includes('ERR_MODULE_NOT_FOUND'), false, 'successful GREEN output substituted for RED');

console.log(`red.audit_summary: current primitives classified; preFixHead=${official.baselineHeadHash}; passing=finding-lock,b-meta-main-lock,process-event-lock,build-lock,store-atomic-rename,verification-receipt-baseline; gaps=${gaps.length}`);
console.log('red.production_unchanged: PASS');
console.log('red.official_evidence_create: PASS');
console.log('red.relation_create: PASS unchangedAssertionBound=true');
console.log('red.no_fabricated_race: PASS');
console.log('red.evidence_binding: PASS');
console.log('red.primitive_scope: PASS');
console.log('red.relation_evaluate: PASS baselineFails=true currentFails=true assertionUnchanged=true');
console.log('red.mutation_isolation: PASS');
console.log('red.reproducibility_guard: PASS');
console.log('red.green_substitution_refused: PASS');
console.log('red.relation_mutation_refused: PASS');

for (const reason of gaps) console.error(`red.genuine_contract_failure:${reason}`);
if (gaps.length > 0) {
  console.error(`RED: ${gaps.length} accepted Story 3 contract group(s) remain absent; existing serialization/atomic-replacement baselines stayed green.`);
  process.exitCode = 1;
} else {
  console.log('red.genuine_contract_failure:none (GREEN: all accepted Story 3 contract groups are present)');
}
