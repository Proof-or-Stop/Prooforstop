#!/usr/bin/env node
/**
 * B-253e CHK-007: smoke suite for the LLM usage ledger writer foundation.
 *
 * Integration coverage across CHK-001..CHK-006:
 *   - schema validation: valid records (4 happy variants) + every rejection
 *     (stored totalTokens at any depth, raw-content/secret injection at any
 *     depth, missing/typed/out-of-enum fields, sequence<1, supersedes omitted,
 *     undefined-vs-null);
 *   - append + hash-chain continuity across >=3 records, genesis previousHash,
 *     tampering a MIDDLE line is detected;
 *   - correlation: stable ledgerCallId+attemptId, monotonic per-attempt
 *     sequence, supersedes wiring, ids NOT derived from requestIdHash, retry
 *     reuses callId with a new attemptId;
 *   - opt-in flag OFF => strict no-op (no file, no dir, even after 10 calls);
 *     flag ON => one line written;
 *   - single write choke-point: only writer.ts performs an fs append against the
 *     ledger path (grep over src/core);
 *   - runtime-artifact classification: path resolves to materialHash=exclude +
 *     volatile + repairable + gitignored, and an adjacent prefix file matches
 *     while a story-evidence path does NOT;
 *   - summary: derived-total identity, no double-count of superseded estimates,
 *     unknown != 0, estimates kept out of provider totals.
 *
 * Runs entirely in an OS temp dir; never pollutes the repo. Prints per-check
 * lines and a final summary; exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type UsageLedgerRecordInput,
  validateUsageLedgerRecord,
} from '../core/usage-ledger/record.js';
import {
  ATTEMPT_ID_PREFIX,
  LEDGER_CALL_ID_PREFIX,
  RECORD_ID_PREFIX,
  SequenceAllocator,
  buildSupersedes,
  mintAttemptId,
  mintCallCorrelation,
  mintLedgerCallId,
  mintRecordId,
  mintRetryAttempt,
} from '../core/usage-ledger/ids.js';
import {
  USAGE_LEDGER_RELATIVE_PATH,
  appendUsageRecord,
  computeRecordHash,
  isUsageLedgerEnabled,
  resolveLedgerPath,
  verifyLedgerChain,
} from '../core/usage-ledger/writer.js';
import {
  deriveRecordTotal,
  selectLatestRecords,
  summarizeLedgerFile,
  summarizeRecords,
} from '../core/usage-ledger/summary.js';
import {
  findRuntimeArtifactEntry,
  isMaterialExcludedRuntimeArtifactPath,
  isRepairableTrackedRuntimeArtifactPath,
  isVolatileRuntimeArtifactPath,
  listRuntimeArtifactIgnorePatterns,
} from '../core/runtime-artifact-registry.js';

let passed = 0;
function check(label: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
    throw err;
  }
}

const LEDGER_ENV = { LATTICE_USAGE_LEDGER: '1' } as NodeJS.ProcessEnv;

/** Build a valid provider-reported record body (without integrity). */
function validRecord(over: Partial<UsageLedgerRecordInput> = {}): UsageLedgerRecordInput {
  const ledgerCallId = mintLedgerCallId();
  const attemptId = mintAttemptId();
  return {
    schemaVersion: 1,
    recordId: mintRecordId(),
    ledgerCallId,
    attemptId,
    sequence: 1,
    supersedesRecordIds: [],
    recordedAt: '2026-06-16T00:00:00.000Z',
    projectRootHash: 'sha256:abc',
    storyId: 'B-253e',
    phase: 'DEV',
    agentType: 'implementer',
    subagentId: null,
    threadId: null,
    decision: { kind: 'allowed', budgetPolicyId: 'local-default', reasonCode: 'within_budget' },
    usage: {
      source: 'provider-reported',
      inputTokens: 1200,
      outputTokens: 340,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      canonical: { input: 1200, output: 340, cacheCreation: 0, cacheRead: 0 },
      raw: { providerUnits: 'anthropic-usage-v1', payloadDigest: 'sha256:def' },
      estimator: null,
      unavailableReason: null,
    },
    privacy: { promptStored: false, transcriptStored: false, redactionProfile: 'no-raw-content-v1' },
    authority: { mode: 'local', receiptId: null, receiptVerified: false },
    ...over,
  };
}

const root = mkdtempSync(join(tmpdir(), 'usage-ledger-smoke-'));

try {
  // ----------------------------------------------------------------------
  // CHK-001: schema validation — happy paths
  // ----------------------------------------------------------------------
  check('CHK-001 valid provider-reported record accepted', () => {
    const res = validateUsageLedgerRecord(validRecord());
    assert.equal(res.ok, true, res.errors.join('; '));
    assert.deepEqual(res.errors, []);
  });

  check('CHK-001 unavailable source with reason + null token fields accepted', () => {
    const res = validateUsageLedgerRecord(
      validRecord({
        usage: {
          source: 'unavailable',
          inputTokens: null,
          outputTokens: null,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
          unavailableReason: 'provider returned no usage object',
        },
      }),
    );
    assert.equal(res.ok, true, res.errors.join('; '));
  });

  check('CHK-001 prompt-size-estimate with estimator{name,version,unit} accepted', () => {
    const res = validateUsageLedgerRecord(
      validRecord({
        usage: {
          source: 'prompt-size-estimate',
          inputTokens: 800,
          outputTokens: 0,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
          estimator: { name: 'char-heuristic', version: '1', unit: 'chars', confidence: 'low' },
        },
      }),
    );
    assert.equal(res.ok, true, res.errors.join('; '));
  });

  check('CHK-001 provider-reported with null cache dims accepted (per-dimension absence = null)', () => {
    const res = validateUsageLedgerRecord(
      validRecord({
        usage: {
          source: 'provider-reported',
          inputTokens: 500,
          outputTokens: 120,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
          canonical: { input: 500, output: 120, cacheCreation: null, cacheRead: null },
          raw: { providerUnits: 'openai-usage-v1', payloadDigest: 'sha256:xyz' },
        },
      }),
    );
    assert.equal(res.ok, true, res.errors.join('; '));
  });

  // ----------------------------------------------------------------------
  // CHK-001: schema validation — rejections
  // ----------------------------------------------------------------------
  check('CHK-001 stored totalTokens (top level) rejected, error mentions total', () => {
    const rec = validRecord() as Record<string, unknown>;
    rec.totalTokens = 1540;
    const res = validateUsageLedgerRecord(rec);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => /total/i.test(e)), res.errors.join('; '));
  });

  check('CHK-001 totalTokens nested in usage AND top level both rejected (deep scan)', () => {
    const rec = validRecord() as Record<string, unknown>;
    rec.totalTokens = 1;
    (rec.usage as Record<string, unknown>).totalTokens = 2;
    const res = validateUsageLedgerRecord(rec);
    assert.equal(res.ok, false);
    const totalErrors = res.errors.filter((e) => /total/i.test(e));
    assert.ok(totalErrors.length >= 2, `expected >=2 total errors, got: ${res.errors.join('; ')}`);
  });

  check('CHK-001 provider-reported 0 cache (genuine) accepted', () => {
    const res = validateUsageLedgerRecord(
      validRecord({
        usage: {
          source: 'provider-reported',
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          canonical: { input: 10, output: 5, cacheCreation: 0, cacheRead: 0 },
          raw: { providerUnits: 'anthropic-usage-v1', payloadDigest: 'sha256:zzz' },
        },
      }),
    );
    assert.equal(res.ok, true, res.errors.join('; '));
  });

  check('CHK-001 missing recordId rejected', () => {
    const rec = validRecord() as Record<string, unknown>;
    delete rec.recordId;
    assert.equal(validateUsageLedgerRecord(rec).ok, false);
  });

  check('CHK-001 usage.source out of enum rejected', () => {
    const rec = validRecord();
    (rec.usage as unknown as Record<string, unknown>).source = 'guessed';
    assert.equal(validateUsageLedgerRecord(rec).ok, false);
  });

  check('CHK-001 sequence=0 and negative rejected; sequence=1 ok', () => {
    assert.equal(validateUsageLedgerRecord(validRecord({ sequence: 0 })).ok, false);
    assert.equal(validateUsageLedgerRecord(validRecord({ sequence: -1 })).ok, false);
    assert.equal(validateUsageLedgerRecord(validRecord({ sequence: 1 })).ok, true);
  });

  check('CHK-001 supersedesRecordIds omitted entirely rejected', () => {
    const rec = validRecord() as Record<string, unknown>;
    delete rec.supersedesRecordIds;
    assert.equal(validateUsageLedgerRecord(rec).ok, false);
  });

  check('CHK-001 inputTokens as string rejected (type coercion attack)', () => {
    const rec = validRecord();
    (rec.usage as unknown as Record<string, unknown>).inputTokens = '100';
    assert.equal(validateUsageLedgerRecord(rec).ok, false);
  });

  check('CHK-001 cacheReadInputTokens=undefined rejected (undefined-vs-null attack)', () => {
    const rec = validRecord();
    (rec.usage as unknown as Record<string, unknown>).cacheReadInputTokens = undefined;
    const res = validateUsageLedgerRecord(rec);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => /cacheReadInputTokens/.test(e)), res.errors.join('; '));
  });

  check('CHK-001 storyId=null accepted (never dropped); storyId omitted rejected', () => {
    assert.equal(validateUsageLedgerRecord(validRecord({ storyId: null })).ok, true);
    const rec = validRecord() as Record<string, unknown>;
    delete rec.storyId;
    assert.equal(validateUsageLedgerRecord(rec).ok, false);
  });

  // ----------------------------------------------------------------------
  // CHK-004: privacy / secret / raw-content rejection (deep)
  // ----------------------------------------------------------------------
  check('CHK-004 record with only allowed privacy-preserving fields accepted', () => {
    const res = validateUsageLedgerRecord(
      validRecord({
        provider: { name: 'anthropic', model: 'claude-opus-4-8', requestIdHash: 'sha256:req' },
        decision: { kind: 'allowed', budgetPolicyId: 'local-default', reasonCode: 'within_budget' },
      }),
    );
    assert.equal(res.ok, true, res.errors.join('; '));
  });

  for (const field of ['rawPrompt', 'rawCompletion', 'rawTranscript', 'toolArguments', 'apiKey', 'authorizationHeader', 'providerSecret', 'providerApiKey', 'actorKey']) {
    check(`CHK-004 forbidden field "${field}" rejected`, () => {
      const rec = validRecord() as Record<string, unknown>;
      rec[field] = 'leak';
      const res = validateUsageLedgerRecord(rec);
      assert.equal(res.ok, false, `expected rejection for ${field}`);
      assert.ok(res.errors.some((e) => /privacy|secret/i.test(e)), res.errors.join('; '));
    });
  }

  check('CHK-004 secret hidden in deep nesting (metadata.debug.rawPrompt) rejected', () => {
    const rec = validRecord() as Record<string, unknown>;
    rec.metadata = { debug: { rawPrompt: 'the actual prompt text' } };
    assert.equal(validateUsageLedgerRecord(rec).ok, false);
  });

  check('CHK-004 one forbidden field poisons the whole record (allowed hash + rawPrompt)', () => {
    const rec = validRecord({ provider: { name: 'a', model: 'm', requestIdHash: 'sha256:abc' } }) as Record<string, unknown>;
    rec.rawPrompt = 'leak';
    assert.equal(validateUsageLedgerRecord(rec).ok, false);
  });

  check('CHK-004 writer REFUSES to write a poisoned record (no line appended)', () => {
    const dir = mkdtempSync(join(root, 'privacy-'));
    const rec = validRecord() as Record<string, unknown>;
    rec.rawTranscript = 'leak';
    assert.throws(() => appendUsageRecord(dir, rec as unknown as UsageLedgerRecordInput, { env: LEDGER_ENV }));
    assert.equal(existsSync(resolveLedgerPath(dir)), false, 'no file should be created for a poisoned record');
  });

  // ----------------------------------------------------------------------
  // CHK-003: correlation ids
  // ----------------------------------------------------------------------
  check('CHK-003 mintLedgerCallId prefix + unique across 100', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const id = mintLedgerCallId();
      assert.ok(id.startsWith(LEDGER_CALL_ID_PREFIX));
      ids.add(id);
    }
    assert.equal(ids.size, 100);
  });

  check('CHK-003 mintAttemptId prefix + unique across 100', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const id = mintAttemptId();
      assert.ok(id.startsWith(ATTEMPT_ID_PREFIX));
      ids.add(id);
    }
    assert.equal(ids.size, 100);
  });

  check('CHK-003 recordId prefix', () => {
    assert.ok(mintRecordId().startsWith(RECORD_ID_PREFIX));
  });

  check('CHK-003 preflight(seq1) + postflight(seq2) share call+attempt with monotonic sequence', () => {
    const { ledgerCallId, attemptId } = mintCallCorrelation();
    const alloc = new SequenceAllocator();
    const s1 = alloc.next(ledgerCallId, attemptId);
    const s2 = alloc.next(ledgerCallId, attemptId);
    assert.equal(s1, 1);
    assert.equal(s2, 2);
    assert.ok(s2 > s1);
  });

  check('CHK-003 supersedesRecordIds wiring carries exactly the preflight id', () => {
    const preId = mintRecordId();
    const sup = buildSupersedes(preId);
    assert.deepEqual(sup, [preId]);
    assert.deepEqual(buildSupersedes(), []);
    assert.deepEqual(buildSupersedes(preId, preId, null, undefined), [preId]);
  });

  check('CHK-003 ledger ids are NOT derived from provider.requestIdHash (no provider input accepted)', () => {
    // mint functions take no arguments; passing a provider hash must not change
    // the produced id (TS-level: the signature has no parameter). We assert
    // call-time uniqueness regardless of any ambient provider hash.
    const a = (mintLedgerCallId as (x?: unknown) => string)('sha256:providerhash');
    const b = (mintLedgerCallId as (x?: unknown) => string)('sha256:providerhash');
    assert.notEqual(a, b, 'ids must be freshly minted, never derived from a provider hash');
    assert.ok(!a.includes('providerhash') && !b.includes('providerhash'));
  });

  check('CHK-003 retry reuses ledgerCallId with a new attemptId; sequence restarts per attempt', () => {
    const first = mintCallCorrelation();
    const retry = mintRetryAttempt(first.ledgerCallId);
    assert.equal(retry.ledgerCallId, first.ledgerCallId);
    assert.notEqual(retry.attemptId, first.attemptId);
    const alloc = new SequenceAllocator();
    alloc.next(first.ledgerCallId, first.attemptId); // attempt1 seq1
    alloc.next(first.ledgerCallId, first.attemptId); // attempt1 seq2
    const retrySeq = alloc.next(first.ledgerCallId, retry.attemptId); // attempt2 seq1
    assert.equal(retrySeq, 1, 'sequence restarts at 1 for a new attempt');
  });

  check('CHK-003 50 parallel mints are unique (no collision)', () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintLedgerCallId()));
    assert.equal(ids.size, 50);
  });

  // ----------------------------------------------------------------------
  // CHK-006: opt-in flag gating
  // ----------------------------------------------------------------------
  check('CHK-006 flag default ON (no env) and parsing of truthy/falsy values', () => {
    assert.equal(isUsageLedgerEnabled({}), true);
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: '0' }), false);
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: '1' }), true);
    assert.equal(isUsageLedgerEnabled({ LATTICE_USAGE_LEDGER: 'true' }), true);
    assert.equal(isUsageLedgerEnabled({ KOALA_USAGE_LEDGER: 'on' }), true);
  });

  check('CHK-006 flag OFF (explicit =0) => strict no-op (no file, no dir) even after 10 calls', () => {
    const dir = mkdtempSync(join(root, 'flagoff-'));
    for (let i = 0; i < 10; i += 1) {
      const res = appendUsageRecord(dir, validRecord(), { env: { LATTICE_USAGE_LEDGER: '0' } });
      assert.equal(res.written, false);
    }
    assert.equal(existsSync(resolveLedgerPath(dir)), false);
    assert.equal(existsSync(join(dir, '.lattice')), false, 'no directory created when flag OFF');
  });

  check('CHK-006 flag ON => one line written', () => {
    const dir = mkdtempSync(join(root, 'flagon-'));
    const res = appendUsageRecord(dir, validRecord(), { env: LEDGER_ENV });
    assert.equal(res.written, true);
    const lines = readFileSync(resolveLedgerPath(dir), 'utf8').split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 1);
  });

  // ----------------------------------------------------------------------
  // CHK-002: append + hash chain
  // ----------------------------------------------------------------------
  check('CHK-002 append 3 records => 3 parseable lines, each recordHash matches sha256(content minus recordHash)', () => {
    const dir = mkdtempSync(join(root, 'chain-'));
    for (let i = 0; i < 3; i += 1) {
      appendUsageRecord(dir, validRecord({ sequence: i + 1 }), { env: LEDGER_ENV });
    }
    const lines = readFileSync(resolveLedgerPath(dir), 'utf8').split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 3);
    for (const line of lines) {
      const rec = JSON.parse(line);
      assert.equal(computeRecordHash(rec), rec.integrity.recordHash);
      // Independent recompute: sha256 over canonical record minus recordHash.
      const forHash = JSON.parse(line);
      delete forHash.integrity.recordHash;
      const sorted = sortKeys(forHash);
      const expected = `sha256:${createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex')}`;
      assert.equal(rec.integrity.recordHash, expected);
    }
  });

  check('CHK-002 hash-chain continuity: rec0.prev=null, rec1.prev=rec0.hash, rec2.prev=rec1.hash', () => {
    const dir = mkdtempSync(join(root, 'chain2-'));
    const written = [] as { integrity: { previousRecordHash: string | null; recordHash: string } }[];
    for (let i = 0; i < 3; i += 1) {
      const res = appendUsageRecord(dir, validRecord({ sequence: i + 1 }), { env: LEDGER_ENV });
      written.push(res.record!);
    }
    assert.equal(written[0].integrity.previousRecordHash, null);
    assert.equal(written[1].integrity.previousRecordHash, written[0].integrity.recordHash);
    assert.equal(written[2].integrity.previousRecordHash, written[1].integrity.recordHash);
    // verifyLedgerChain accepts an untampered file.
    assert.equal(verifyLedgerChain(resolveLedgerPath(dir)).length, 3);
  });

  check('CHK-002 writer creates .lattice/usage/ when absent', () => {
    const dir = mkdtempSync(join(root, 'mkdir-'));
    assert.equal(existsSync(join(dir, '.lattice')), false);
    appendUsageRecord(dir, validRecord(), { env: LEDGER_ENV });
    assert.equal(existsSync(resolveLedgerPath(dir)), true);
  });

  check('CHK-002 tamper a MIDDLE line => chain verification fails', () => {
    const dir = mkdtempSync(join(root, 'tamper-'));
    for (let i = 0; i < 3; i += 1) {
      appendUsageRecord(dir, validRecord({ sequence: i + 1 }), { env: LEDGER_ENV });
    }
    const path = resolveLedgerPath(dir);
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
    const middle = JSON.parse(lines[1]);
    middle.usage.inputTokens = 999999; // tamper, do not recompute hash
    lines[1] = JSON.stringify(middle);
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
    assert.throws(() => verifyLedgerChain(path), /mismatch|chain/i);
  });

  check('CHK-002 append to existing file chains from last line, does not overwrite priors', () => {
    const dir = mkdtempSync(join(root, 'existing-'));
    const r1 = appendUsageRecord(dir, validRecord(), { env: LEDGER_ENV }).record!;
    const r2 = appendUsageRecord(dir, validRecord(), { env: LEDGER_ENV }).record!;
    assert.equal(r2.integrity.previousRecordHash, r1.integrity.recordHash);
    const lines = readFileSync(resolveLedgerPath(dir), 'utf8').split('\n').filter((l) => l.trim());
    assert.equal(JSON.parse(lines[0]).recordId, r1.recordId, 'prior line preserved unchanged');
  });

  check('CHK-002 invalid record => writer throws, no line appended', () => {
    const dir = mkdtempSync(join(root, 'invalid-'));
    const bad = validRecord({ sequence: 0 });
    assert.throws(() => appendUsageRecord(dir, bad, { env: LEDGER_ENV }));
    assert.equal(existsSync(resolveLedgerPath(dir)), false);
  });

  check('CHK-002 corrupt last line => writer refuses to chain', () => {
    const dir = mkdtempSync(join(root, 'corrupt-'));
    appendUsageRecord(dir, validRecord(), { env: LEDGER_ENV });
    const path = resolveLedgerPath(dir);
    writeFileSync(path, `${readFileSync(path, 'utf8')}{not json}\n`, 'utf8');
    assert.throws(() => appendUsageRecord(dir, validRecord(), { env: LEDGER_ENV }), /corrupt|chain/i);
  });

  check('CHK-002 caller-supplied recordHash is OVERWRITTEN with the correct computed hash', () => {
    const dir = mkdtempSync(join(root, 'forge-'));
    const rec = validRecord() as UsageLedgerRecordInput;
    rec.integrity = { previousRecordHash: 'sha256:forged-prev', recordHash: 'sha256:forged' };
    const res = appendUsageRecord(dir, rec, { env: LEDGER_ENV });
    assert.notEqual(res.record!.integrity.recordHash, 'sha256:forged');
    assert.equal(res.record!.integrity.previousRecordHash, null, 'genesis prev is recomputed, not the forged value');
    assert.equal(computeRecordHash(res.record!), res.record!.integrity.recordHash);
  });

  // ----------------------------------------------------------------------
  // CHK-002 adversarial: single write choke-point (static guarantee)
  // ----------------------------------------------------------------------
  check('CHK-002 single write choke-point: only writer.ts appends to the ledger under core/', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const coreDir = join(repoRoot, 'packages', 'main', 'src', 'core');
    const tsFiles = walkTs(coreDir);
    const appenders: string[] = [];
    const filenameRefs: string[] = [];
    for (const file of tsFiles) {
      const src = readFileSync(file, 'utf8');
      const rel = file.slice(repoRoot.length + 1);
      const refsFilename = src.includes('llm-usage.jsonl') || src.includes('USAGE_LEDGER_FILENAME') || src.includes('USAGE_LEDGER_RELATIVE_PATH');
      if (refsFilename) filenameRefs.push(rel);
      // An fs append/write call co-located with a ledger filename reference.
      const writesFs = /append(File|FileSync)|write(File|FileSync)/.test(src);
      if (refsFilename && writesFs && rel.includes('usage-ledger')) appenders.push(rel);
    }
    // Only writer.ts may both reference the ledger path AND perform an fs append.
    assert.deepEqual(appenders, ['packages/main/src/core/usage-ledger/writer.ts'], `unexpected ledger appenders: ${appenders.join(', ')}`);
    // The registry may reference the filename (matcher) but must not append.
    const nonWriterRefs = filenameRefs.filter((r) => !r.endsWith('usage-ledger/writer.ts'));
    for (const ref of nonWriterRefs) {
      const src = readFileSync(join(repoRoot, ref), 'utf8');
      assert.ok(!/append(File|FileSync)/.test(src), `non-writer file ${ref} must not append to the ledger`);
    }
  });

  // ----------------------------------------------------------------------
  // CHK-005: runtime-artifact classification
  // ----------------------------------------------------------------------
  check('CHK-005 path classifies as exclude + volatile + repairable, entry id=llm-usage-ledger', () => {
    const p = '.lattice/usage/llm-usage.jsonl';
    const entry = findRuntimeArtifactEntry(p);
    assert.ok(entry, 'entry must be found');
    assert.equal(entry!.id, 'llm-usage-ledger');
    assert.equal(entry!.materialHash, 'exclude');
    assert.equal(entry!.volatile, true);
    assert.equal(entry!.repairableTrackedArtifact, true);
    assert.equal(isMaterialExcludedRuntimeArtifactPath(p), true);
    assert.equal(isVolatileRuntimeArtifactPath(p), true);
    assert.equal(isRepairableTrackedRuntimeArtifactPath(p), true);
  });

  check('CHK-005 ignorePatterns include .lattice/usage/ (gitignored)', () => {
    assert.ok(listRuntimeArtifactIgnorePatterns().includes('.lattice/usage/'));
  });

  check('CHK-005 adjacent prefix file matches; story-evidence path does NOT match the ledger entry', () => {
    assert.equal(findRuntimeArtifactEntry('.lattice/usage/other-file.jsonl')?.id, 'llm-usage-ledger');
    const story = findRuntimeArtifactEntry('.lattice/story/actives/B-253e/usage.jsonl');
    assert.notEqual(story?.id, 'llm-usage-ledger', 'matcher must not catch story evidence paths');
  });

  // ----------------------------------------------------------------------
  // CHK-006: summary correctness
  // ----------------------------------------------------------------------
  check('CHK-006 derived totals: per-record total = sum of 4 fields; aggregate = sum of per-record', () => {
    const recs = [
      finalize(validRecord({ usage: usage('provider-reported', 100, 10, 5, 2) })),
      finalize(validRecord({ usage: usage('provider-reported', 200, 20, 10, 4) })),
      finalize(validRecord({ usage: usage('provider-reported', 300, 30, 15, 6) })),
    ];
    const s = summarizeRecords(recs);
    assert.equal(s.selected[0].total, 117);
    assert.equal(s.providerReportedTotal, 117 + 234 + 351);
    assert.equal(s.providerReportedCount, 3);
  });

  check('CHK-006 superseded estimate not double-counted; final provider-reported selected', () => {
    const corr = mintCallCorrelation();
    const estimate = finalize(validRecord({
      ...corr, sequence: 1,
      usage: { source: 'prompt-size-estimate', inputTokens: 999, outputTokens: 0, cacheCreationInputTokens: null, cacheReadInputTokens: null, estimator: { name: 'h', version: '1', unit: 'tok' } },
    }));
    const final = finalize(validRecord({
      ...corr, sequence: 2, supersedesRecordIds: [estimate.recordId],
      usage: usage('provider-reported', 100, 10, 0, 0),
    }));
    const s = summarizeRecords([estimate, final]);
    assert.equal(s.selected.length, 1, 'only the latest non-superseded record selected');
    assert.equal(s.selected[0].source, 'provider-reported');
    assert.equal(s.providerReportedTotal, 110);
    assert.equal(s.estimateCount, 0, 'superseded estimate excluded entirely');
  });

  check('CHK-006 unavailable record reported as unknown, NOT 0', () => {
    const rec = finalize(validRecord({
      usage: { source: 'unavailable', inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, unavailableReason: 'no usage' },
    }));
    const d = deriveRecordTotal(rec);
    assert.equal(d.unknown, true);
    assert.equal(d.total, null);
    const s = summarizeRecords([rec]);
    assert.equal(s.unknownCount, 1);
    assert.equal(s.providerReportedTotal, 0, 'unknown contributes nothing, and is not summed as a number');
    assert.notEqual(d.total, 0);
  });

  check('CHK-006 provider-reported with null cache dim => total unknown, never 0-substituted', () => {
    const rec = finalize(validRecord({
      usage: { source: 'provider-reported', inputTokens: 50, outputTokens: 10, cacheCreationInputTokens: null, cacheReadInputTokens: null, canonical: { input: 50, output: 10, cacheCreation: null, cacheRead: null }, raw: { providerUnits: 'u', payloadDigest: 'sha256:d' } },
    }));
    const d = deriveRecordTotal(rec);
    assert.equal(d.unknown, true);
    assert.equal(d.total, null);
  });

  check('CHK-006 two records same call+attempt, neither supersedes => highest sequence selected', () => {
    const corr = mintCallCorrelation();
    const a = finalize(validRecord({ ...corr, sequence: 1, usage: usage('provider-reported', 1, 1, 0, 0) }));
    const b = finalize(validRecord({ ...corr, sequence: 2, usage: usage('provider-reported', 5, 5, 0, 0) }));
    const sel = selectLatestRecords([a, b]);
    assert.equal(sel.length, 1);
    assert.equal(sel[0].sequence, 2);
  });

  check('CHK-006 estimates kept separate from provider-reported totals', () => {
    // An estimate with all four dims known has a well-defined subtotal; it must
    // contribute to estimateSubtotal, never to providerReportedTotal.
    const prov = finalize(validRecord({ usage: usage('provider-reported', 100, 0, 0, 0) }));
    const est = finalize(validRecord({ usage: { source: 'prompt-size-estimate', inputTokens: 50, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimator: { name: 'h', version: '1', unit: 'tok' } } }));
    const s = summarizeRecords([prov, est]);
    assert.equal(s.providerReportedTotal, 100);
    assert.equal(s.providerReportedCount, 1);
    assert.equal(s.estimateSubtotal, 50);
    assert.equal(s.estimateCount, 1);
    assert.notEqual(s.providerReportedTotal, 150, 'estimate must NOT merge into provider total');
  });

  check('CHK-006 estimate with null cache dims => unknown total (null never becomes 0)', () => {
    const est = finalize(validRecord({ usage: { source: 'prompt-size-estimate', inputTokens: 50, outputTokens: 0, cacheCreationInputTokens: null, cacheReadInputTokens: null, estimator: { name: 'h', version: '1', unit: 'tok' } } }));
    const d = deriveRecordTotal(est);
    assert.equal(d.unknown, true);
    assert.equal(d.total, null);
    const s = summarizeRecords([est]);
    assert.equal(s.unknownCount, 1);
    assert.equal(s.estimateCount, 0, 'unknown-totaled estimate is reported as unknown, not summed');
  });

  check('CHK-006 summary return type carries NO gate field (informational only)', () => {
    const s = summarizeRecords([finalize(validRecord())]);
    for (const banned of ['gate', 'verdict', 'decision', 'pass', 'blocker', 'gateConsumable']) {
      assert.ok(!(banned in s), `summary must not expose a "${banned}" field`);
    }
  });

  check('CHK-006 summarizeLedgerFile on absent ledger => empty summary (no error)', () => {
    const dir = mkdtempSync(join(root, 'absent-'));
    const s = summarizeLedgerFile(resolveLedgerPath(dir));
    assert.equal(s.recordCount, 0);
    assert.equal(s.providerReportedTotal, 0);
  });

  check('CHK-006 multi-attempt mix: estimate/provider/unavailable across 3 attempts', () => {
    const callId = mintLedgerCallId();
    const att1 = mintAttemptId();
    const att2 = mintAttemptId();
    const att3 = mintAttemptId();
    const est = finalize(validRecord({ ledgerCallId: callId, attemptId: att1, sequence: 1, usage: { source: 'prompt-size-estimate', inputTokens: 70, outputTokens: 0, cacheCreationInputTokens: null, cacheReadInputTokens: null, estimator: { name: 'h', version: '1', unit: 'tok' } } }));
    const fin = finalize(validRecord({ ledgerCallId: callId, attemptId: att1, sequence: 2, supersedesRecordIds: [est.recordId], usage: usage('provider-reported', 60, 10, 0, 0) }));
    const prov2 = finalize(validRecord({ ledgerCallId: callId, attemptId: att2, sequence: 1, usage: usage('provider-reported', 20, 5, 0, 0) }));
    const unavail = finalize(validRecord({ ledgerCallId: callId, attemptId: att3, sequence: 1, usage: { source: 'unavailable', inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, unavailableReason: 'x' } }));
    const s = summarizeRecords([est, fin, prov2, unavail]);
    assert.equal(s.providerReportedTotal, 70 + 25, 'attempt1 final (70) + attempt2 (25); estimate excluded');
    assert.equal(s.providerReportedCount, 2);
    assert.equal(s.estimateCount, 0);
    assert.equal(s.unknownCount, 1);
  });

  // ----------------------------------------------------------------------
  // CHK-007 isolation: confirm no repo pollution
  // ----------------------------------------------------------------------
  check('CHK-007 all test artifacts live under the temp root (no repo pollution)', () => {
    assert.ok(root.startsWith(tmpdir()), 'temp root must be under the OS tmpdir');
    const entries = readdirSync(root);
    assert.ok(entries.length > 0, 'expected temp work to exist before cleanup');
    assert.ok(statSync(root).isDirectory());
  });

  console.log(`\n✓ usage-ledger smoke passed (${passed} checks)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// --- local helpers ---

function usage(source: 'provider-reported', input: number, output: number, cacheCreation: number, cacheRead: number) {
  return {
    source,
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    canonical: { input, output, cacheCreation, cacheRead },
    raw: { providerUnits: 'u', payloadDigest: 'sha256:d' },
  } as UsageLedgerRecordInput['usage'];
}

/** Attach a placeholder integrity block so a record can be summarized in-memory. */
function finalize(input: UsageLedgerRecordInput) {
  const rec = { ...input, integrity: { previousRecordHash: null, recordHash: '' } } as Parameters<typeof computeRecordHash>[0];
  rec.integrity.recordHash = computeRecordHash(rec);
  return rec;
}

function sortKeys(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[k];
      if (child === undefined) continue;
      out[k] = sortKeys(child);
    }
    return out;
  }
  return value;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

void USAGE_LEDGER_RELATIVE_PATH;
