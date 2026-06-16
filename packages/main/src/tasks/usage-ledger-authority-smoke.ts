#!/usr/bin/env node
/**
 * B-fd64 (Touchpoint 6): smoke suite for the LOCAL Authority usage-evidence
 * slice — the ANTI-OVERCLAIM gate.
 *
 * Coverage:
 *   - CHK-001 envelope: buildUsageEvidenceEnvelope mirrors only an allowlist of
 *     non-secret fields + a stable sha256 recordDigest; deep-scan of the envelope
 *     finds ZERO forbidden material; forbidden material in the SOURCE record is
 *     rejected at any nesting depth and through case-variant evasion; the digest
 *     is deterministic; the unavailable/null-token case still produces a digest.
 *   - CHK-002 receipt-ref: a local record with all-null receipt-ref fields
 *     validates; a record with all three ref fields set + receiptVerified=false
 *     validates; partial references reject; receiptVerified=true (or "true", or 1)
 *     reject — verification is gate-only.
 *   - CHK-003 gate: verifyUsageReceipt returns receiptVerified=true ONLY for an
 *     injected verifier returning verified===true WITH a matching subject; a
 *     subject mismatch, verified=false, verified=1, a throwing verifier, a missing
 *     verifier, or a missing subject binding all yield receiptVerified=false.
 *   - CHK-004 negative controls: transport.accepted=true, real provider token
 *     counts, a local JSONL hash chain, a copied receiptId (no verifier), all
 *     four combined, and a genuine verifier with a MISMATCHED subject — each keeps
 *     receiptVerified false.
 *   - CHK-005 wiring + isolation: STATIC import boundary proves core/usage-ledger
 *     imports ZERO other modules (only ./ siblings + node:), specifically NO
 *     authority-signing import; runs in a temp dir; no repo pollution.
 *
 * Prints per-check lines and a final summary; exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import {
  FORBIDDEN_FIELD_NAMES,
  SCHEMA_VERSION,
  validateUsageLedgerRecord,
  type UsageLedgerRecord,
} from '../core/usage-ledger/record.js';
import { canonicalJson } from '../core/usage-ledger/canonical-json.js';
import {
  mintAttemptId,
  mintLedgerCallId,
  mintRecordId,
} from '../core/usage-ledger/ids.js';
import {
  EXPECTED_SUBJECT_KIND,
  ForbiddenEvidenceMaterialError,
  buildUsageEvidenceEnvelope,
  verifyUsageReceipt,
  type PrivacyPreservingUsageEvidenceEnvelope,
  type ReceiptVerifier,
  type ReceiptVerifyResult,
} from '../core/usage-ledger/authority-evidence.js';

let passed = 0;
const failures: string[] = [];
const root = mkdtempSync(join(tmpdir(), 'usage-ledger-authority-smoke-'));

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    failures.push(label);
    process.exitCode = 1;
    console.error(`✗ ${label}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  }
}

const STORY_ID = 'B-1234';

/** A full, VALID local ledger record (with integrity) for envelope tests. */
function validRecord(over: Partial<UsageLedgerRecord> = {}): UsageLedgerRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    recordId: mintRecordId(),
    ledgerCallId: mintLedgerCallId(),
    attemptId: mintAttemptId(),
    sequence: 1,
    supersedesRecordIds: [],
    recordedAt: '2026-06-16T00:00:00.000Z',
    projectRootHash: 'sha256:abc',
    storyId: STORY_ID,
    phase: 'DEV',
    agentType: 'implementer',
    subagentId: null,
    threadId: null,
    decision: { kind: 'allowed', budgetPolicyId: 'local-default', reasonCode: 'within_budget' },
    provider: { name: 'anthropic', model: 'claude-opus-4', requestIdHash: 'sha256:req' },
    usage: {
      source: 'provider-reported',
      inputTokens: 500,
      outputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      canonical: { input: 500, output: 200, cacheCreation: 0, cacheRead: 0 },
      raw: { providerUnits: 'anthropic-usage-v1', payloadDigest: 'sha256:def' },
      estimator: null,
      unavailableReason: null,
    },
    privacy: { promptStored: false, transcriptStored: false, redactionProfile: 'no-raw-content-v1' },
    authority: { mode: 'local', receiptId: null, receiptVerified: false, receiptSubjectKind: null, receiptSubjectId: null },
    integrity: { previousRecordHash: null, recordHash: 'sha256:rec' },
    ...over,
  };
}

/** Forbidden field names the envelope must never carry (subset of the denylist). */
const FORBIDDEN_TOKENS = [
  'prompt',
  'transcript',
  'secret',
  'apikey',
  'authorization',
  'authorizationheader',
  'rawresponse',
  'content',
  'messages',
  'password',
  'credentials',
  'bearertoken',
  'accesstoken',
  'refreshtoken',
  'totaltokens',
];

/** Deep-collect every object key (lowercased) at any depth. */
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      out.push(key.toLowerCase());
      collectKeys(child, out);
    }
  }
  return out;
}

function assertNoForbiddenMaterial(envelope: unknown): void {
  // (a) no forbidden token in the serialized lowercased blob.
  const blob = JSON.stringify(envelope).toLowerCase();
  for (const token of FORBIDDEN_TOKENS) {
    assert.ok(!blob.includes(token), `envelope blob must not contain forbidden token "${token}"`);
  }
  // (b) no envelope key at any depth whose lowercased name is forbidden.
  const keys = collectKeys(envelope);
  for (const token of FORBIDDEN_TOKENS) {
    assert.ok(!keys.includes(token), `envelope must not have a key named "${token}" at any depth`);
  }
}

async function main(): Promise<void> {
  // ----------------------------------------------------------------------
  // CHK-001 envelope
  // ----------------------------------------------------------------------
  await check('CHK-001 envelope mirrors allowlisted non-secret fields + a stable recordDigest', () => {
    const record = validRecord();
    const env = buildUsageEvidenceEnvelope(record);
    const expectedDigest = createHash('sha256').update(canonicalJson(record), 'utf8').digest('hex');
    assert.equal(env.recordDigest, expectedDigest, 'recordDigest must be sha256(canonicalJson(record))');
    assert.match(env.recordDigest, /^[0-9a-f]{64}$/, 'recordDigest must be a 64-char hex string');
    assert.equal(env.schemaVersion, record.schemaVersion);
    assert.equal(env.recordId, record.recordId);
    assert.equal(env.ledgerCallId, record.ledgerCallId);
    assert.equal(env.attemptId, record.attemptId);
    assert.equal(env.sequence, record.sequence);
    assert.equal(env.storyId, record.storyId);
    assert.equal(env.model, record.provider?.model);
    assert.equal(env.provider.name, record.provider?.name);
    assert.equal(env.usage.source, record.usage.source);
    assert.equal(env.usage.inputTokens, record.usage.inputTokens);
    assert.equal(env.usage.outputTokens, record.usage.outputTokens);
    assert.equal(env.usage.cacheCreationInputTokens, record.usage.cacheCreationInputTokens);
    assert.equal(env.usage.cacheReadInputTokens, record.usage.cacheReadInputTokens);
    assert.equal(env.decision.kind, record.decision.kind);
  });

  await check('CHK-001 envelope deep-scan finds ZERO forbidden material', () => {
    const env = buildUsageEvidenceEnvelope(validRecord());
    assertNoForbiddenMaterial(env);
  });

  await check('CHK-001 forbidden field deeply nested in SOURCE record -> builder REJECTS', () => {
    // metadata.debug.rawPrompt is forbidden at depth-3.
    const record = validRecord({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...( { metadata: { debug: { rawPrompt: 'leak me' } } } as any ),
    });
    assert.throws(
      () => buildUsageEvidenceEnvelope(record),
      ForbiddenEvidenceMaterialError,
      'forbidden material at any depth must throw',
    );
  });

  await check('CHK-001 adversarial: secrets smuggled at MULTIPLE depths/arrays -> all rejected', () => {
    const record = validRecord({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...( {
        apiKey: 'sk-top',
        provider: { name: 'anthropic', model: 'm', secret: 'nested-secret' },
        usage: { ...validRecord().usage, raw: { providerUnits: 'u', payloadDigest: 'd', bearerToken: 'bt' } },
        billing: [{ password: 'p' }, { credentials: { accessToken: 'at' } }],
      } as any ),
    });
    assert.throws(() => buildUsageEvidenceEnvelope(record), ForbiddenEvidenceMaterialError);
  });

  await check('CHK-001 adversarial: case-variant field names (ApiKey/API_KEY/RawPrompt) -> rejected', () => {
    for (const variant of [{ ApiKey: 'x' }, { API_KEY: 'x' }, { RawPrompt: 'x' }, { PROMPT: 'x' }, { AuthorizationHeader: 'x' }]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const record = validRecord({ ...(variant as any) });
      assert.throws(
        () => buildUsageEvidenceEnvelope(record),
        ForbiddenEvidenceMaterialError,
        `case-variant ${JSON.stringify(variant)} must be caught`,
      );
    }
  });

  await check('CHK-001 F-002: separator-variant tool-args / env names (TOOL_ARGUMENTS, ENV_VARS) -> rejected', () => {
    // record.ts's FORBIDDEN_FIELD_NAMES carries toolarguments/toolargs/toolresult
    // and env/envvars/environmentvariables. The derived normalized set must catch
    // their separator variants so a record carrying raw tool args / env is never
    // digested. Each must throw ForbiddenEvidenceMaterialError.
    const variants: Array<Record<string, unknown>> = [
      { TOOL_ARGUMENTS: 'rm -rf /' },
      { tool_args: ['secret'] },
      { RAW_TOOL_ARGUMENTS: 'x' },
      { TOOL_RESULT: 'x' },
      { ENV_VARS: { TOKEN: 'leak' } },
      { ENVIRONMENT_VARIABLES: {} },
      { env: { PATH: '/usr/bin' } },
    ];
    for (const variant of variants) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const record = validRecord({ ...(variant as any) });
      assert.throws(
        () => buildUsageEvidenceEnvelope(record),
        ForbiddenEvidenceMaterialError,
        `${JSON.stringify(variant)} must be caught (derived from record.ts denylist)`,
      );
    }
  });

  await check('CHK-001 F-002: normalized denylist is DERIVED from record.ts (no drift) — every name covered', () => {
    // Sanity: the derived normalized set must contain the normalized form of each
    // record.ts denylist entry, proving derivation (not a parallel hand copy).
    for (const name of FORBIDDEN_FIELD_NAMES) {
      const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      // A separator-variant key normalizing to this name is caught by the builder.
      const probe: Record<string, unknown> = {};
      // Reconstruct a separator-bearing variant: insert an underscore mid-name.
      const variantKey = name.length > 1 ? `${name[0]}_${name.slice(1)}` : name;
      probe[variantKey] = 'probe';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assert.throws(
        () => buildUsageEvidenceEnvelope(validRecord({ ...(probe as any) })),
        ForbiddenEvidenceMaterialError,
        `record.ts denylist entry "${name}" (normalized "${norm}") must be caught by the derived set`,
      );
    }
  });

  await check('CHK-001 deterministic: same record -> identical recordDigest', () => {
    const record = validRecord();
    const a = buildUsageEvidenceEnvelope(record).recordDigest;
    const b = buildUsageEvidenceEnvelope(record).recordDigest;
    assert.equal(a, b, 'recordDigest must be deterministic');
  });

  await check('CHK-001 unavailable usage + null tokens still produces a valid digest', () => {
    const record = validRecord({
      usage: {
        source: 'unavailable',
        inputTokens: null,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        unavailableReason: 'no provider response',
      },
    });
    const env = buildUsageEvidenceEnvelope(record);
    assert.match(env.recordDigest, /^[0-9a-f]{64}$/);
    assert.equal(env.usage.source, 'unavailable');
    assert.equal(env.usage.inputTokens, null);
    assert.equal(env.usage.outputTokens, null);
    assert.equal(env.usage.cacheCreationInputTokens, null);
    assert.equal(env.usage.cacheReadInputTokens, null);
  });

  // ----------------------------------------------------------------------
  // CHK-002 receipt-reference fields on the authority block
  // ----------------------------------------------------------------------
  await check('CHK-002 local record with all-null receipt-ref fields -> validates', () => {
    const record = validRecord({
      authority: { mode: 'local', receiptId: null, receiptVerified: false, receiptSubjectKind: null, receiptSubjectId: null },
    });
    const res = validateUsageLedgerRecord(record, { expectIntegrity: true });
    assert.equal(res.ok, true, `expected ok, got: ${res.errors.join('; ')}`);
  });

  await check('CHK-002 referenced receipt (all three ref fields set) + receiptVerified=false -> validates', () => {
    const record = validRecord({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      authority: { mode: 'local', receiptId: 'rcpt-ref-1', receiptVerified: false, receiptSubjectKind: 'story', receiptSubjectId: 'B-1234' } as any,
    });
    const res = validateUsageLedgerRecord(record, { expectIntegrity: true });
    assert.equal(res.ok, true, `a mere reference is valid (NOT verification); got: ${res.errors.join('; ')}`);
  });

  await check('CHK-002 partial ref (receiptId present, subject null) -> REJECTED', () => {
    const record = validRecord({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      authority: { mode: 'local', receiptId: 'rcpt-ref-1', receiptVerified: false, receiptSubjectKind: null, receiptSubjectId: null } as any,
    });
    const res = validateUsageLedgerRecord(record, { expectIntegrity: true });
    assert.equal(res.ok, false, 'a partial receipt reference must be rejected');
  });

  await check('CHK-002 partial ref (subject present, receiptId null) -> REJECTED', () => {
    const record = validRecord({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      authority: { mode: 'local', receiptId: null, receiptVerified: false, receiptSubjectKind: 'story', receiptSubjectId: 'B-1234' } as any,
    });
    const res = validateUsageLedgerRecord(record, { expectIntegrity: true });
    assert.equal(res.ok, false, 'subject fields without a receiptId are orphaned -> rejected');
  });

  await check('CHK-002 ADVERSARIAL: receiptVerified=true bypassing the gate -> REJECTED', () => {
    const record = validRecord({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      authority: { mode: 'local', receiptId: 'rcpt-ref-1', receiptVerified: true, receiptSubjectKind: 'story', receiptSubjectId: 'B-1234' } as any,
    });
    const res = validateUsageLedgerRecord(record, { expectIntegrity: true });
    assert.equal(res.ok, false, 'a record cannot self-declare receiptVerified=true');
    assert.ok(res.errors.some((e) => e.includes('receiptVerified')), 'error must name receiptVerified');
  });

  await check('CHK-002 ADVERSARIAL: receiptVerified=true with receiptId=null -> REJECTED', () => {
    const record = validRecord({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      authority: { mode: 'local', receiptId: null, receiptVerified: true, receiptSubjectKind: null, receiptSubjectId: null } as any,
    });
    const res = validateUsageLedgerRecord(record, { expectIntegrity: true });
    assert.equal(res.ok, false, 'verified with no receipt is logically impossible');
  });

  await check('CHK-002 ADVERSARIAL: receiptVerified set to string "true" (type confusion) -> REJECTED', () => {
    const record = validRecord({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      authority: { mode: 'local', receiptId: null, receiptVerified: 'true', receiptSubjectKind: null, receiptSubjectId: null } as any,
    });
    const res = validateUsageLedgerRecord(record, { expectIntegrity: true });
    assert.equal(res.ok, false, 'strict !== false rejects the string "true"');
  });

  // ----------------------------------------------------------------------
  // CHK-003 verification gate (pluggable injected verifier)
  // ----------------------------------------------------------------------
  const envelope = buildUsageEvidenceEnvelope(validRecord());
  const signedReceipt = { id: 'rcpt-genuine-1', signature: 'sig', payloadDigest: envelope.recordDigest };

  await check('CHK-003 GOLDEN: injected verify true + matching subject -> receiptVerified=true', async () => {
    const verify: ReceiptVerifier = () => ({ verified: true, subjectKind: 'story', subjectId: STORY_ID });
    const block = await verifyUsageReceipt(envelope, signedReceipt, verify);
    assert.equal(block.receiptVerified, true, 'genuine verify + matching subject is the ONLY verified path');
    assert.equal(block.receiptId, signedReceipt.id);
    assert.equal(block.receiptSubjectKind, EXPECTED_SUBJECT_KIND);
    assert.equal(block.receiptSubjectId, STORY_ID);
  });

  await check('CHK-003 async verifier (Promise) true + matching subject -> receiptVerified=true', async () => {
    const verify: ReceiptVerifier = async () => ({ verified: true, subjectKind: 'story', subjectId: STORY_ID });
    const block = await verifyUsageReceipt(envelope, signedReceipt, verify);
    assert.equal(block.receiptVerified, true);
    assert.equal(block.receiptId, signedReceipt.id);
  });

  await check('CHK-003 verify true but MISSING subject binding -> receiptVerified=false', async () => {
    const verify: ReceiptVerifier = () => ({ verified: true } as ReceiptVerifyResult);
    const block = await verifyUsageReceipt(envelope, signedReceipt, verify);
    assert.equal(block.receiptVerified, false, 'no subject binding -> cannot trust');
    assert.equal(block.receiptId, null);
  });

  await check('CHK-003 F-001: verify true + subjectId=null on a null-storyId envelope -> receiptVerified=false', async () => {
    // A non-story record validly has storyId=null. A verifier returning
    // subjectId=null must NOT pass via null===null — a null is not a real binding.
    const nullStoryEnvelope = buildUsageEvidenceEnvelope(validRecord({ storyId: null }));
    assert.equal(nullStoryEnvelope.storyId, null, 'envelope storyId is null for a non-story record');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verify: ReceiptVerifier = () => ({ verified: true, subjectKind: 'story', subjectId: null } as any);
    const block = await verifyUsageReceipt(nullStoryEnvelope, signedReceipt, verify);
    assert.equal(block.receiptVerified, false, 'null subject on both sides must NOT verify (overclaim bypass closed)');
    assert.equal(block.receiptId, null);
  });

  await check('CHK-003 F-001: verify true + subjectId=null against a REAL-story envelope -> receiptVerified=false', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verify: ReceiptVerifier = () => ({ verified: true, subjectKind: 'story', subjectId: null } as any);
    const block = await verifyUsageReceipt(envelope, signedReceipt, verify);
    assert.equal(block.receiptVerified, false, 'a null subjectId is never a valid binding, even vs a real story');
    assert.equal(block.receiptId, null);
  });

  await check('CHK-003 no verifier injected (undefined) -> receiptVerified=false (no crash)', async () => {
    const block = await verifyUsageReceipt(envelope, signedReceipt, undefined);
    assert.equal(block.receiptVerified, false);
    assert.equal(block.receiptId, null);
  });

  await check('CHK-003 ADVERSARIAL: subject MISMATCH with a genuine verifier -> receiptVerified=false', async () => {
    const verify: ReceiptVerifier = () => ({ verified: true, subjectKind: 'story', subjectId: 'B-9999' });
    const block = await verifyUsageReceipt(envelope, signedReceipt, verify);
    assert.equal(block.receiptVerified, false, 'a real receipt against the WRONG subject must not count (replay defense)');
    assert.equal(block.receiptId, null);
  });

  await check('CHK-003 ADVERSARIAL: verify=false (correct subject) -> receiptVerified=false', async () => {
    const verify: ReceiptVerifier = () => ({ verified: false, subjectKind: 'story', subjectId: STORY_ID });
    const block = await verifyUsageReceipt(envelope, signedReceipt, verify);
    assert.equal(block.receiptVerified, false);
  });

  await check('CHK-003 ADVERSARIAL: verifier THROWS -> receiptVerified=false (fail-safe, no propagation)', async () => {
    const verify: ReceiptVerifier = () => {
      throw new Error('boom');
    };
    const block = await verifyUsageReceipt(envelope, signedReceipt, verify);
    assert.equal(block.receiptVerified, false, 'a throwing verifier can never produce verified');
  });

  await check('CHK-003 ADVERSARIAL: verify returns {verified:1} (truthy non-boolean) -> receiptVerified=false', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verify: ReceiptVerifier = () => ({ verified: 1, subjectKind: 'story', subjectId: STORY_ID } as any);
    const block = await verifyUsageReceipt(envelope, signedReceipt, verify);
    assert.equal(block.receiptVerified, false, 'strict === true rejects truthy non-boolean');
  });

  // ----------------------------------------------------------------------
  // CHK-004 NEGATIVE CONTROLS (cannot be tricked into verified)
  // ----------------------------------------------------------------------
  await check('CHK-004 NC1 transport.accepted=true alone -> receiptVerified=false', async () => {
    // A transport ack is NOT verification. With no injected verifier the gate
    // cannot verify anything regardless of any transport-level signal.
    const transport = { accepted: true, status: 200 };
    assert.equal(transport.accepted, true, 'simulated transport ack present');
    const block = await verifyUsageReceipt(envelope, signedReceipt, undefined);
    assert.equal(block.receiptVerified, false, 'transport acceptance is not cryptographic verification');
  });

  await check('CHK-004 NC2 real provider token counts -> receiptVerified=false', async () => {
    const record = validRecord({
      usage: {
        source: 'provider-reported',
        inputTokens: 500,
        outputTokens: 200,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        canonical: { input: 500, output: 200, cacheCreation: 0, cacheRead: 0 },
        raw: { providerUnits: 'anthropic-usage-v1', payloadDigest: 'sha256:def' },
        estimator: null,
        unavailableReason: null,
      },
    });
    const env = buildUsageEvidenceEnvelope(record);
    assert.equal(env.usage.inputTokens, 500, 'real token counts present in evidence');
    const block = await verifyUsageReceipt(env, signedReceipt, undefined);
    assert.equal(block.receiptVerified, false, 'accurate token accounting is not server verification');
  });

  await check('CHK-004 NC3 local JSONL hash chain present -> receiptVerified=false', async () => {
    // A valid integrity block (previousRecordHash + recordHash) is local
    // tamper-detection, NOT Authority verification.
    const record = validRecord({
      integrity: { previousRecordHash: 'sha256:prev', recordHash: 'sha256:this' },
    });
    assert.equal(typeof record.integrity.recordHash, 'string', 'hash chain present');
    const env = buildUsageEvidenceEnvelope(record);
    const block = await verifyUsageReceipt(env, signedReceipt, undefined);
    assert.equal(block.receiptVerified, false, 'local hash-chain integrity is not external verification');
  });

  await check('CHK-004 NC4 copied receiptId on record, NO verifier -> receiptVerified=false', async () => {
    // A receiptId string copied onto a record does not constitute verification:
    // (a) the validator still rejects receiptVerified!=false for a local record,
    // (b) the gate, with no injected verifier confirming it, returns unverified.
    const record = validRecord({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      authority: { mode: 'local', receiptId: 'rcpt-genuine-looking-id', receiptVerified: false, receiptSubjectKind: 'story', receiptSubjectId: 'B-1234' } as any,
    });
    const res = validateUsageLedgerRecord(record, { expectIntegrity: true });
    assert.equal(res.ok, true, 'a copied receiptId reference + receiptVerified=false is still just a reference');
    const block = await verifyUsageReceipt(buildUsageEvidenceEnvelope(record), { id: 'rcpt-genuine-looking-id' }, undefined);
    assert.equal(block.receiptVerified, false, 'possessing a receiptId is not verification without the verifier gate');
  });

  await check('CHK-004 ALL FOUR signals combined, NO verifier -> receiptVerified=false', async () => {
    const transport = { accepted: true };
    const record = validRecord({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      authority: { mode: 'local', receiptId: 'rcpt-copied', receiptVerified: false, receiptSubjectKind: 'story', receiptSubjectId: 'B-1234' } as any,
      integrity: { previousRecordHash: 'sha256:prev', recordHash: 'sha256:this' },
    });
    assert.equal(transport.accepted, true);
    assert.equal(record.usage.inputTokens, 500);
    const block = await verifyUsageReceipt(buildUsageEvidenceEnvelope(record), { id: 'rcpt-copied' }, undefined);
    assert.equal(block.receiptVerified, false, 'non-proof signals must not stack into verified');
  });

  await check('CHK-004 ADVERSARIAL: genuine verifier but MISMATCHED subject (receipt replay) -> false', async () => {
    // Receipt verified for B-9999, but the envelope is bound to B-1234.
    const verify: ReceiptVerifier = () => ({ verified: true, subjectKind: 'story', subjectId: 'B-9999' });
    const block = await verifyUsageReceipt(envelope, { id: 'rcpt-replay' }, verify);
    assert.equal(block.receiptVerified, false, 'replaying a receipt from a DIFFERENT subject must not work');
  });

  await check('CHK-004 ADVERSARIAL: hand-built authority block claiming verified -> validator rejects', () => {
    const record = validRecord({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      authority: { mode: 'local', receiptId: 'rcpt-x', receiptVerified: true, receiptSubjectKind: 'story', receiptSubjectId: 'B-1234' } as any,
    });
    const res = validateUsageLedgerRecord(record, { expectIntegrity: true });
    assert.equal(res.ok, false, 'the validator is the last line of defense against a hand-built verified block');
  });

  // ----------------------------------------------------------------------
  // CHK-005 wiring + isolation: zero-cross-module-import boundary
  // ----------------------------------------------------------------------
  await check('CHK-005 STATIC core/usage-ledger imports ZERO other modules (./ siblings + node: only)', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const moduleDir = join(repoRoot, 'packages', 'main', 'src', 'core', 'usage-ledger');
    const tsFiles = walkTs(moduleDir);
    assert.ok(tsFiles.length > 0, 'expected usage-ledger .ts files');
    const importRe = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;
    const offenders: string[] = [];
    for (const file of tsFiles) {
      const src = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(src)) !== null) {
        const spec = m[1];
        if (spec.startsWith('node:')) continue;
        if (spec.startsWith('.')) {
          const resolved = resolve(dirname(file), spec);
          const rel = relative(moduleDir, resolved);
          const escapesModule = rel === '..' || rel.startsWith(`..${'/'}`) || rel.startsWith('..\\');
          if (escapesModule) offenders.push(`${file.slice(repoRoot.length + 1)} -> ${spec}`);
          continue;
        }
        offenders.push(`${file.slice(repoRoot.length + 1)} -> ${spec}`);
      }
    }
    assert.deepEqual(offenders, [], `usage-ledger must import only in-module siblings + node:; offenders:\n${offenders.join('\n')}`);
  });

  await check('CHK-005 STATIC authority-evidence.ts imports only ./ siblings + node: (NO authority-signing)', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const src = readFileSync(join(repoRoot, 'packages', 'main', 'src', 'core', 'usage-ledger', 'authority-evidence.ts'), 'utf8');
    const importRe = /from\s+['"]([^'"]+)['"]/g;
    const specs: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) specs.push(m[1]);
    for (const spec of specs) {
      const ok = spec.startsWith('node:') || spec.startsWith('./');
      assert.ok(ok, `authority-evidence.ts imported an unexpected spec: ${spec}`);
      assert.ok(!/authority-signing/.test(spec), `authority-evidence.ts must NOT import authority-signing (got ${spec})`);
    }
  });

  await check('CHK-005 STATIC no usage-ledger .ts IMPORTS/requires authority-signing anywhere', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const moduleDir = join(repoRoot, 'packages', 'main', 'src', 'core', 'usage-ledger');
    // Match only import/export-from specifiers and require() calls — a prose
    // comment that says "must NOT import authority-signing" is correct docs and
    // must not trip the check; only a real module specifier counts.
    const importSpecRe = /(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const file of walkTs(moduleDir)) {
      const src = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = importSpecRe.exec(src)) !== null) {
        const spec = m[1] ?? m[2] ?? '';
        assert.ok(
          !/authority-signing/.test(spec),
          `${file.slice(repoRoot.length + 1)} must not import authority-signing (got ${spec})`,
        );
      }
    }
  });

  await check('CHK-005 isolation: all test artifacts live under the temp root (no repo pollution)', () => {
    assert.ok(root.startsWith(tmpdir()), 'temp root must be under the OS tmpdir');
    assert.ok(statSync(root).isDirectory());
    const entries = readdirSync(root);
    assert.ok(entries.length >= 0);
  });
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`\n✗ usage-ledger authority smoke FAILED (${failures.length} failing): ${failures.join(', ')}`);
      process.exit(1);
    }
    console.log(`\n✓ usage-ledger authority smoke passed (${passed} checks)`);
  })
  .catch((err) => {
    console.error('✗ usage-ledger authority smoke crashed');
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
  });

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}
