import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { FINDING_LEDGER_LOCAL_FS_CAPABILITY, FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY, FINDING_LEDGER_SCHEMA_EPOCH, appendLedgerTransaction, type AppendRequest, type JsonValue } from '../../core/finding-ledger.js';

import { generateEd25519KeyPair } from '../../core/authority-signing.js';
import { appendAssessmentProposal, canonicalHash, canonicalJson, signAssessmentProposal, verifyAssessmentProposal } from '../../handlers/finding-ledger.js';

import {
  acquireMkdirLock,
  captureMkdirLockFence,
} from '../../core/mkdir-lock.js';

import { StoryStore } from '../../core/store.js';

import type { StoryInfo } from '../../core/types.js';

import { adapterSessionEnv } from '../adapter-session-env.js';

export const RUNTIME_CLI_TEST_SESSION_ENV = adapterSessionEnv(
  'bfe8f-runtime-evidence-smoke',
  'proof-or-stop-implementer',
);

export const require = createRequire(import.meta.url);

export interface WorkerSpec {
  ledgerFile: string;
  lockDir: string;
  prefix: string;
  count: number;
  recordType: string;
  payloadBase: Record<string, JsonValue>;
  uniqueBindingKey?: string;
}

export function request(
  fenceToken: string,
  idempotencyKey: string,
  recordType: string,
  payload: JsonValue,
  uniqueBindingKey?: string,
): AppendRequest<JsonValue> {
  return {
    operation: recordType === 'legacy_identity_binding'
      ? 'append_legacy_identity_binding'
      : `append_${recordType}`,
    idempotencyKey,
    records: [{ recordType, payload, ...(uniqueBindingKey ? { uniqueBindingKey } : {}) }],
    ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH,
    writerCapability: FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY,
    writerSessionId: `smoke-${process.pid}`,
    writerFenceToken: fenceToken,
    storageCapability: FINDING_LEDGER_LOCAL_FS_CAPABILITY,
  };
}

export function appendUnderLock(spec: WorkerSpec): Array<{ recordId: string; receiptId: string }> {
  const committed: Array<{ recordId: string; receiptId: string }> = [];
  for (let index = 0; index < spec.count; index += 1) {
    const lock = acquireMkdirLock(spec.lockDir, {
      label: 'finding ledger smoke worker',
      requireHolderToken: true,
      deadlineMs: 60_000,
      staleMs: 20_000,
    });
    try {
      const fence = captureMkdirLockFence(spec.lockDir);
      const idempotencyKey = `${spec.prefix}:${index}`;
      const payload = spec.uniqueBindingKey
        ? spec.payloadBase as JsonValue
        : { ...spec.payloadBase, writer: spec.prefix, index } as JsonValue;
      const result = appendLedgerTransaction(
        spec.ledgerFile,
        request(fence.writerFenceToken, idempotencyKey, spec.recordType, payload, spec.uniqueBindingKey),
        fence,
      );
      committed.push({ recordId: result.records[0]!.recordId, receiptId: result.receipt.receiptId });
    } finally {
      lock.release();
    }
  }
  return committed;
}

export async function runWorkers(specs: WorkerSpec[]): Promise<void> {
  const self = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'finding-ledger-runtime-smoke.js');
  await Promise.all(specs.map((spec) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [self, '--ledger-worker', JSON.stringify(spec)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ledger worker exited ${code}: ${stderr || stdout}`));
    });
  })));
}

export function signedApplicableProposal(
  privateKey: string,
  publicKey: string,
  authorityDigest: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const issuedAt = '2030-01-01T00:00:00.000Z';
  const findingRef = { storyId: 'B-CAS', findingId: 'B-CAS:F-001', recordId: 'finding-record-001' };
  const dependencyBundleUnsigned = {
    sourceFinding: { ...findingRef, hash: 'finding-hash-001', version: 'v1' },
    proofPolicyDigest: 'proof-policy',
    reviewerAuthorityPolicyDigest: 'reviewer-policy',
    ledgerSnapshotDigest: 'ledger-snapshot',
  };
  return signAssessmentProposal({
    schemaVersion: 1,
    proposalId: 'proposal-001',
    findingRef,
    findingHash: 'finding-hash-001',
    findingVersion: 'v1',
    evaluationScope: 'target_story',
    owner: 'current_story',
    issuedAt,
    expiresAt: '2030-01-01T02:00:00.000Z',
    freshnessPolicyVersion: 'v1',
    maxAgeSeconds: 7200,
    dependencyBundle: {
      digest: canonicalHash(dependencyBundleUnsigned),
      ...dependencyBundleUnsigned,
    },
    evidenceRefs: ['evidence:1'],
    historicalSourceRefs: [],
    protectedSurfaceEvaluation: [],
    reviewRunId: 'review-run-001',
    reviewRound: '1',
    scopeDigest: 'scope-001',
    headHash: 'head-001',
    materialHash: 'material-001',
    storyFilesHash: 'story-files-001',
    runtimeReceiptIds: [],
    assessedBy: 'assessment-authority',
    proposalSigner: {
      actorId: 'assessment-authority', authorityDigest,
      keyId: `assessment-proposal-${canonicalHash({ publicKey }).slice(0, 24)}`,
      algorithm: 'ed25519',
      trustRootDigest: canonicalHash({ profile: 'assessment-proposal-trust-root-v1', publicKey }),
    },
    verdict: 'applicable',
    basis: 'direct_scope',
    currentWitness: { receiptIds: ['runtime-001'], reproduced: true },
    ...overrides,
  }, privateKey);
}

export function proposalUnsignedForSmoke(proposal: Record<string, unknown>): Record<string, unknown> {
  const { proposalDigest: _digest, proposalSignature: _signature, ...unsigned } = proposal;
  return unsigned;
}

export function runProposalEnvelopeRegression(scratch: string): void {
  const pair = generateEd25519KeyPair();
  const authority = 'assessment-authority-digest';
  const baseline = proposalUnsignedForSmoke(signedApplicableProposal(pair.privateKey, pair.publicKey, authority));
  const { verdict: _verdict, basis: _basis, owner: _owner, currentWitness: _witness, ...envelope } = baseline;
  const finding = baseline.findingRef as Record<string, unknown>;
  const current = { ...finding, hash: 'canonical-finding-hash' };
  const variants: Record<string, unknown>[] = [
    baseline,
    { ...envelope, verdict: 'pre_existing_unaffected', basis: 'base_head_reproduction', owner: 'meta',
      baseHead: { baseRef: 'main~1', baseResult: 'reproduced', headRef: 'HEAD', headResult: 'reproduced',
        worsenedByStory: false, receiptIds: ['base-receipt', 'head-receipt'] } },
    { ...envelope, verdict: 'out_of_scope', basis: 'decision_scope', owner: 'other_story', excludedScopeProofDigest: 'scope-proof' },
    { ...envelope, verdict: 'duplicate', basis: 'canonical_duplicate', owner: 'meta',
      canonicalDefectRef: { canonicalDefectId: 'DEF-001', identityDigest: 'identity',
        currentCanonicalFinding: current, canonicalOwner: 'B-CAS' } },
    { ...envelope, verdict: 'not_reproduced_under_current_witness', basis: 'counter_evidence', owner: 'other_story',
      currentWitness: { reproduced: false, receiptIds: ['negative-receipt'], commandPolicyDigest: 'command-policy',
        runtimeEvidenceDigest: 'runtime-evidence', negativeWitnessDigest: 'negative-witness' } },
    { ...envelope, verdict: 'unknown', basis: 'direct_scope', owner: 'unowned' },
  ];
  const options = { publicKey: pair.publicKey, expectedAuthorityDigest: authority, now: new Date('2030-01-01T00:30:00.000Z') };
  const storyId = 'B-CAS';
  const failures: string[] = [];
  let invalidCount = 0;
  let validCount = 0;
  {
    const check = (name: string, unsigned: Record<string, unknown>, valid: boolean, recomputeBundle = true,
      tamperSigned?: (candidate: Record<string, unknown>) => void) => {
      const input = structuredClone(unsigned);
      if (recomputeBundle && input.dependencyBundle && typeof input.dependencyBundle === 'object'
        && !Array.isArray(input.dependencyBundle)) {
        const { digest: _digest, ...bundle } = input.dependencyBundle as Record<string, unknown>;
        input.dependencyBundle = { ...bundle, digest: canonicalHash(bundle) };
      }
      // Re-sign the mutant so rejection cannot be explained by a stale signature.
      const candidate = signAssessmentProposal(input, pair.privateKey);
      tamperSigned?.(candidate);
      const verified = verifyAssessmentProposal(candidate, options);
      const store = new StoryStore(join(scratch, 'proposal-envelope', String(validCount + invalidCount)));
      const lockDir = store.storyFilePath(storyId, 'findings.lock');
      const lock = acquireMkdirLock(lockDir, { label: 'proposal envelope regression', requireHolderToken: true });
      try {
        const fence = captureMkdirLockFence(lockDir);
        const ledgerPath = store.storyFilePath(storyId, 'finding-ledger.json');
        let receipt;
        let rejected = false;
        try {
          receipt = appendAssessmentProposal({
            storyId, store, idempotencyKey: 'envelope:1', writerSessionId: 'proposal-envelope-smoke',
            writerLeaseId: 'proposal-envelope-lease', writerFenceToken: fence.writerFenceToken, fence,
            signer: { privateKey: pair.privateKey, publicKey: pair.publicKey, keyId: 'ledger-smoke-key',
              trustRootDigest: 'ledger-smoke-trust', keyFreshnessPolicyDigest: 'ledger-smoke-freshness' },
            proposal: candidate, proposalPublicKey: pair.publicKey, expectedAuthorityDigest: authority, now: options.now,
          });
        } catch { rejected = true; }
        if (valid) {
          validCount++;
          if (!verified.valid || rejected || !receipt) failures.push(`${name}: legal payload rejected (${verified.rejection})`);
          else if (canonicalJson(store.readFindingLedger<JsonValue>(storyId).records
            .find((record) => record.recordId === receipt.recordIds[0])?.payload) !== canonicalJson(candidate)) failures.push(`${name}: persisted payload changed`);
        } else {
          invalidCount++;
          if (verified.valid || !rejected || existsSync(ledgerPath)) failures.push(`${name}: invalid signed payload accepted or wrote ledger`);
        }
      } finally { lock.release(); }
    };
    const mutate = (path: Array<string | number>, value: unknown, base = baseline, remove = false) => {
      const copy = structuredClone(base);
      let target: Record<string | number, unknown> = copy;
      for (const segment of path.slice(0, -1)) target = target[segment] as Record<string | number, unknown>;
      if (remove) delete target[path.at(-1)!];
      else target[path.at(-1)!] = value;
      return copy;
    };
    const invalidValues = [null, 7, [], {}, '', ' '];
    const requiredText = ['proposalId', 'findingHash', 'findingVersion', 'issuedAt', 'expiresAt', 'freshnessPolicyVersion',
      'reviewRunId', 'reviewRound', 'scopeDigest', 'headHash', 'materialHash', 'storyFilesHash', 'assessedBy'];
    for (const field of requiredText) {
      for (const value of invalidValues) check(`scalar:${field}:${JSON.stringify(value)}`, mutate([field], value), false);
      check(`scalar:${field}:missing`, mutate([field], undefined, baseline, true), false);
    }
    for (const field of ['proposalDigest', 'proposalSignature']) {
      for (const value of invalidValues) check(`signed:${field}`, baseline, false, true, (candidate) => { candidate[field] = value; });
      check(`signed:${field}:missing`, baseline, false, true, (candidate) => { delete candidate[field]; });
    }
    for (const field of ['findingRef', 'dependencyBundle', 'proposalSigner']) {
      for (const value of [null, 7, []]) check(`object:${field}:${JSON.stringify(value)}`, mutate([field], value), false);
    }
    for (const field of ['storyId', 'findingId', 'recordId']) {
      for (const value of invalidValues) check(`findingRef:${field}`, mutate(['findingRef', field], value), false);
      check(`findingRef:${field}:missing`, mutate(['findingRef', field], undefined, baseline, true), false);
    }
    for (const field of ['actorId', 'algorithm', 'authorityDigest', 'keyId', 'trustRootDigest']) {
      for (const value of invalidValues) {
        const mutant = mutate(['proposalSigner', field], value);
        if (field === 'actorId') mutant.assessedBy = value;
        check(`signer:${field}:${JSON.stringify(value)}`, mutant, false);
      }
      check(`signer:${field}:missing`, mutate(['proposalSigner', field], undefined, baseline, true), false);
    }
    for (const field of ['proofPolicyDigest', 'reviewerAuthorityPolicyDigest', 'ledgerSnapshotDigest']) {
      for (const value of invalidValues) check(`bundle:${field}:${JSON.stringify(value)}`, mutate(['dependencyBundle', field], value), false);
      check(`bundle:${field}:missing`, mutate(['dependencyBundle', field], undefined, baseline, true), false);
    }
    for (const field of ['storyId', 'findingId', 'recordId', 'hash', 'version']) {
      for (const value of invalidValues) check(`sourceFinding:${field}`, mutate(['dependencyBundle', 'sourceFinding', field], value), false);
      check(`sourceFinding:${field}:missing`, mutate(['dependencyBundle', 'sourceFinding', field], undefined, baseline, true), false);
    }
    for (const value of [null, 7, [], {}]) check('sourceFinding:shape', mutate(['dependencyBundle', 'sourceFinding'], value), false);
    for (const value of invalidValues) check('bundle:digest:type', mutate(['dependencyBundle', 'digest'], value), false, false);
    check('bundle:digest:missing', mutate(['dependencyBundle', 'digest'], undefined, baseline, true), false, false);
    for (const value of [null, '7200', 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) check('maxAgeSeconds', mutate(['maxAgeSeconds'], value), false);
    for (const field of ['schemaVersion', 'evaluationScope', 'owner']) {
      for (const value of [null, 99, [], {}, 'invalid']) check(`enum:${field}`, mutate([field], value, variants[5]), false);
    }
    for (const owner of ['current_story', 'meta', 'other_story', 'unowned']) check(`unknown-owner:${owner}`, { ...variants[5], owner }, true);
    for (const scope of ['target_story', 'canonical_owner', 'repository_release']) check(`evaluationScope:${scope}`, { ...baseline, evaluationScope: scope }, true);
    const sparse = new Array(1);
    for (const field of ['evidenceRefs', 'runtimeReceiptIds']) {
      for (const value of [null, {}, 'ref', [null], [7], [''], ['valid', null], [null, 'valid'], sparse]) check(`array:${field}`, mutate([field], value), false);
    }
    const surfaces = ['data_integrity', 'security_or_privacy', 'package_publish_or_clean_install',
      'cli_primary_entrypoint', 'agent_resolution', 'historical_evidence_integrity', 'lifecycle_gate'];
    const nested = { ...baseline,
      historicalSourceRefs: [{ ...finding, sourceFindingHash: 'historical-finding-hash' }],
      protectedSurfaceEvaluation: [{ surface: 'data_integrity', state: 'clear', evidenceRefs: ['evidence:protected'] }],
    };
    for (const field of ['historicalSourceRefs', 'protectedSurfaceEvaluation']) {
      for (const value of [null, {}, 'entry', [null], [7], [{}], sparse]) check(`array:${field}`, mutate([field], value), false);
      const validEntry = nested[field as 'historicalSourceRefs' | 'protectedSurfaceEvaluation'][0];
      for (const value of [[validEntry, null], [null, validEntry]]) check(`array:${field}:mixed`, mutate([field], value), false);
    }
    for (const field of ['storyId', 'findingId', 'recordId', 'sourceFindingHash', 'canonicalSourceKey']) {
      for (const value of invalidValues) check(`historical:${field}`, mutate(['historicalSourceRefs', 0, field], value, nested), false);
      if (field !== 'canonicalSourceKey') check(`historical:${field}:missing`, mutate(['historicalSourceRefs', 0, field], undefined, nested, true), false);
    }
    check('historical:optional-valid', mutate(['historicalSourceRefs', 0, 'canonicalSourceKey'], 'canonical-source', nested), true);
    check('historical:unknown-field', mutate(['historicalSourceRefs', 0, 'unknownField'], 'x', nested), false);
    for (const field of ['surface', 'state']) {
      for (const value of [null, 7, [], {}, '', 'invalid']) check(`protected:${field}`, mutate(['protectedSurfaceEvaluation', 0, field], value, nested), false);
      check(`protected:${field}:missing`, mutate(['protectedSurfaceEvaluation', 0, field], undefined, nested, true), false);
    }
    for (const value of [null, {}, 'ref', [null], [7], [''], ['valid', null], [null, 'valid'], sparse]) check('protected:evidenceRefs', mutate(['protectedSurfaceEvaluation', 0, 'evidenceRefs'], value, nested), false);
    check('protected:evidenceRefs:missing', mutate(['protectedSurfaceEvaluation', 0, 'evidenceRefs'], undefined, nested, true), false);
    check('protected:unknown-field', mutate(['protectedSurfaceEvaluation', 0, 'unknownField'], 'x', nested), false);
    for (const surface of surfaces) for (const state of ['clear', 'known_risk', 'unknown']) {
      check(`protected:${surface}:${state}:empty-evidence`, { ...nested, protectedSurfaceEvaluation: [{ surface, state, evidenceRefs: [] }] }, true);
    }
    for (const variant of variants) {
      check(`variant:${String(variant.verdict)}:empty-envelope-arrays`, { ...variant,
        evidenceRefs: [], runtimeReceiptIds: [], historicalSourceRefs: [], protectedSurfaceEvaluation: [] }, true);
      if (variant.currentWitness) check(`variant:${String(variant.verdict)}:sparse-witness`, mutate(['currentWitness', 'receiptIds'], sparse, variant), false);
      if (variant.baseHead) check('variant:preExisting:sparse-baseHead', mutate(['baseHead', 'receiptIds'], sparse, variant), false);
      for (const field of ['currentWitness', 'baseHead', 'canonicalDefectRef']) {
        if (variant[field]) check(`variant:${String(variant.verdict)}:array-as-${field}`, { ...variant, [field]: Object.assign([], variant[field]) }, false);
      }
    }
    const optionalBundle = { canonicalIdentityDigest: 'canonical-identity', currentCanonicalFinding: current, supersessionChainTipDigest: 'chain-tip' };
    const optionalNames = Object.keys(optionalBundle) as Array<keyof typeof optionalBundle>;
    for (let mask = 0; mask < 8; mask++) {
      const bundle = { ...baseline.dependencyBundle as Record<string, unknown> };
      optionalNames.forEach((name, bit) => { if (mask & (1 << bit)) bundle[name] = optionalBundle[name]; });
      check(`optional-bundle:combination-${mask}`, { ...baseline, dependencyBundle: bundle }, true);
    }
    for (const field of optionalNames) {
      for (const value of [null, 7, [], {}, '']) check(`optional-bundle:${field}:${JSON.stringify(value)}`, mutate(['dependencyBundle', field], value), false);
    }
    const withCurrent = mutate(['dependencyBundle', 'currentCanonicalFinding'], current);
    for (const field of ['storyId', 'findingId', 'recordId', 'hash']) {
      for (const value of invalidValues) check(`optional-current:${field}`, mutate(['dependencyBundle', 'currentCanonicalFinding', field], value, withCurrent), false);
      check(`optional-current:${field}:missing`, mutate(['dependencyBundle', 'currentCanonicalFinding', field], undefined, withCurrent, true), false);
    }
    check('optional-current:unknown-field', mutate(['dependencyBundle', 'currentCanonicalFinding', 'extra'], 'x', withCurrent), false);
    check('bundle:unknown-field', mutate(['dependencyBundle', 'unknownField'], 'x'), false);
    check('bundle:wrong-digest', mutate(['dependencyBundle', 'digest'], 'wrong-digest', withCurrent), false, false);
    if (failures.length) console.error(`ledger.assessment_envelope_contract: RED failures=${failures.length}\n${failures.join('\n')}`);
    assert.equal(failures.length, 0, 'Signed proposal envelope contract');
    console.log(`ledger.assessment_envelope_contract: PASS invalid=${invalidCount} legal=${validCount} signedMutants=true invalidSemanticWrites=0`);
    console.log('ledger.assessment_dependency_optionals: PASS combinations=8 exactDigest=true unknownFields=reject variants=6 emptyEnvelopeArrays=allowed sparseArrays=reject');
  }
}

export function runtimeStory(storyId: string): StoryInfo {
  const now = '2030-01-01T00:00:00.000Z';
  return {
    storyId,
    name: 'runtime-evidence-smoke',
    title: 'Runtime evidence smoke',
    description: 'Synthetic DEV story for RuntimeEvidenceReceipt production adapter verification.',
    type: 'chore',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now }],
  };
}

export function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

export function parseCliJson(output: string): Record<string, unknown> {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  assert.ok(start >= 0 && end > start, `runtime CLI output is not JSON: ${output.slice(0, 200)}`);
  return JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
}

export function runRuntimeCli(
  repositoryRoot: string,
  projectRoot: string,
  command: 'finding_ledger_query' | 'finding_runtime_evidence_run' | 'finding_runtime_evidence_verify',
  args: Record<string, unknown>,
  signingEnv: Record<string, string>,
): { status: number | null; stdout: string; stderr: string; json?: Record<string, unknown> } {
  const result = spawnSync(process.execPath, [join(repositoryRoot, 'packages', 'main', 'dist', 'cli.js'), command, JSON.stringify(args)], {
    cwd: projectRoot,
    env: { ...process.env, ...RUNTIME_CLI_TEST_SESSION_ENV, ...signingEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.status === 0 ? { json: parseCliJson(result.stdout ?? '') } : {}),
  };
}

export async function runCliCommand(
  repositoryRoot: string,
  projectRoot: string,
  command: string,
  args: Record<string, unknown>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      join(repositoryRoot, 'packages', 'main', 'dist', 'cli.js'),
      command,
      JSON.stringify(args),
    ], {
      cwd: projectRoot,
      env: { ...process.env, ...RUNTIME_CLI_TEST_SESSION_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

export function contentSnapshot(root: string): string[] {
  const rows: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      const relativePath = absolute.slice(root.length + 1).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        rows.push(`d:${relativePath}`);
        visit(absolute);
      } else if (entry.isFile()) {
        rows.push(`f:${relativePath}:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`);
      } else if (entry.isSymbolicLink()) {
        rows.push(`l:${relativePath}`);
      }
    }
  };
  visit(root);
  return rows;
}

export function readOnlySecuritySnapshot(root: string): string[] {
  return contentSnapshot(root).filter((row) => !row.startsWith('f:.proof-or-stop/activity.jsonl:'));
}
