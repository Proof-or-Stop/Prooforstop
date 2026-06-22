#!/usr/bin/env node
//
// Authority runner contracts smoke (B-1123 milestone 1).
//
// Pure in-process smoke. Proves:
//   1. canonicalJsonBytes() / canonicalDigest() are byte-stable across
//      insertion-order permutations and undefined-omission paths.
//   2. signCanonical / verifyCanonical roundtrip on signature-less bytes.
//   3. Tamper to value, signature, or public key fails verification (no throw).
//   4. signRunnerEnvelope / verifyRunnerEnvelope roundtrip for every runner
//      envelope (ActorKeyRegistration, RunnerRegistration, RunnerHeartbeat,
//      JobClaim, JobLeaseHeartbeat, JobRelease, ProviderEventsEnvelope).
//   5. Empty / missing actorId / nonce / timestamp cause sign-time throw and
//      verify-time false (Handler coding convention: runtime re-validation beyond Zod).
//   6. Same producer/verifier run id collapses
//      independentVerifierRunId in missingRunnerL2Requirements().
//   7. Adversarial invariant: signing primitives alone do NOT promote ordinary
//      local/shadow runner envelopes to receipt-backed L2+.
//   8. AuthorityReceipt sign/verify roundtrip + tamper detection.
//
// Visible pass line (consumed by reviewers / DONE summary):
//   ✓ authority runner contracts smoke passed: deterministic canonicalization, sign/verify, and L2+ boundary preserved

import assert from 'node:assert/strict';
import {
  canonicalDigest,
  canonicalJsonBytes,
  generateEd25519KeyPair,
  signCanonical,
  signEnvelope,
  stripSignature,
  verifyCanonical,
  verifySignedEnvelope,
  exportPublicKeyRaw,
  exportPrivateKeyRaw,
  importPublicKeyRaw,
  importPrivateKeyRaw,
} from '../core/authority-signing.js';
import {
  missingRunnerL2Requirements,
  parseActorKeyRegistration,
  parseAuthorityReceipt,
  parseJobClaim,
  parseJobLeaseHeartbeat,
  parseJobRelease,
  parseJobSpec,
  parseProviderEventsEnvelope,
  parseRunnerHeartbeat,
  parseRunnerRegistration,
  runnerEnvelopeIsL2PlusCandidate,
  signRunnerEnvelope,
  verifyAuthorityReceipt,
  verifyRunnerEnvelope,
  RUNNER_L2_REQUIREMENTS,
  type ActorKeyRegistration,
  type AuthorityReceipt,
  type JobClaim,
  type JobLeaseHeartbeat,
  type JobRelease,
  type PythonSignedEnvelopeHeader,
  type ProviderEventsEnvelope,
  type RunnerEnvelopeHeader,
  type RunnerHeartbeat,
  type RunnerL2Requirement,
  type RunnerRegistration,
} from '../core/authority-runner-contracts.js';
import { claimAuthorityJobForLoop } from '../core/authority-job-loop-live.js';
import { runLatticeAuthorityControlPlaneOnce } from '../core/authority-runner.js';
import { generateKeyPairSync } from 'node:crypto';

const PASS_LINE =
  '✓ authority runner contracts smoke passed: deterministic canonicalization, sign/verify, and L2+ boundary preserved';

// ─── shared key material ──────────────────────────────────────────────────────
const keypair = generateEd25519KeyPair();
const otherKeypair = generateEd25519KeyPair();
assert.notEqual(keypair.publicKey, otherKeypair.publicKey, 'distinct keypairs must produce distinct public keys');
assert.notEqual(keypair.privateKey, otherKeypair.privateKey, 'distinct keypairs must produce distinct private keys');

const NONCE = 'nonce-a';
const CREATED_AT = '2026-06-02T18:00:00.000Z';
const ACTOR_ID = 'actor-1';

// ─── 1. canonical determinism ─────────────────────────────────────────────────
{
  const a = { b: 2, a: 1, nested: { y: 'y', x: 'x' } };
  const b = { nested: { x: 'x', y: 'y' }, a: 1, b: 2 };
  assert.equal(canonicalDigest(a), canonicalDigest(b), 'insertion order must not change digest');
  assert.deepEqual(canonicalJsonBytes(a).toString('utf8'), canonicalJsonBytes(b).toString('utf8'));

  // undefined keys are dropped
  const withUndef = { a: 1, b: undefined, c: 3 };
  assert.equal(canonicalDigest(withUndef), canonicalDigest({ a: 1, c: 3 }));

  // arrays preserve order (semantic, not bug)
  assert.notEqual(canonicalDigest([1, 2, 3]), canonicalDigest([3, 2, 1]));
}

// ─── 2. canonical sign/verify roundtrip ───────────────────────────────────────
{
  const payload = { foo: 'bar', n: 42, arr: [1, 2, 3] };
  const sig = signCanonical(payload, keypair.privateKey);
  assert.ok(typeof sig === 'string' && sig.length > 0, 'signCanonical returns non-empty base64');
  assert.equal(verifyCanonical(payload, sig, keypair.publicKey), true);

  // Ed25519 is deterministic — same input + key yields same signature byte-for-byte
  const sig2 = signCanonical(payload, keypair.privateKey);
  assert.equal(sig, sig2, 'Ed25519 deterministic signature must be byte-stable');

  // wrong key fails
  assert.equal(verifyCanonical(payload, sig, otherKeypair.publicKey), false);

  // tamper to value fails
  assert.equal(verifyCanonical({ ...payload, foo: 'baz' }, sig, keypair.publicKey), false);

  // malformed signature fails (no throw)
  assert.equal(verifyCanonical(payload, 'not-base64-but-ok', keypair.publicKey), false);
  assert.equal(verifyCanonical(payload, '', keypair.publicKey), false);
  // 64-byte all-zeros signature must not verify
  assert.equal(verifyCanonical(payload, Buffer.alloc(64).toString('base64'), keypair.publicKey), false);
}

// ─── 3. key export / import roundtrip (raw 32-byte base64) ────────────────────
{
  // Native Node keypair → raw export → re-import → still produces verifying sig.
  const { publicKey: nativePub, privateKey: nativePriv } = generateKeyPairSync('ed25519');
  const pubB64 = exportPublicKeyRaw(nativePub);
  const privB64 = exportPrivateKeyRaw(nativePriv);
  assert.equal(Buffer.from(pubB64, 'base64').length, 32, 'raw Ed25519 public key is 32 bytes');
  assert.equal(Buffer.from(privB64, 'base64').length, 32, 'raw Ed25519 private seed is 32 bytes');

  const payload = { x: 1 };
  const sig = signCanonical(payload, privB64);
  assert.equal(verifyCanonical(payload, sig, pubB64), true, 'native -> raw -> import roundtrip verifies');

  // direct importer surfaces also work
  const pubObj = importPublicKeyRaw(pubB64);
  const privObj = importPrivateKeyRaw(privB64);
  assert.ok(pubObj.asymmetricKeyType === 'ed25519');
  assert.ok(privObj.asymmetricKeyType === 'ed25519');

  // garbage raw bytes throw on import
  assert.throws(() => importPublicKeyRaw('AA=='), /expected 32 raw bytes/);
  assert.throws(() => importPrivateKeyRaw(''), /expected non-empty raw-key/);
}

// ─── 4. signEnvelope / verifySignedEnvelope (generic) ─────────────────────────
{
  const env = { actorId: ACTOR_ID, nonce: NONCE, createdAt: CREATED_AT, payload: 'p' };
  const { signed, digest } = signEnvelope(env, keypair.privateKey);
  assert.ok('signature' in signed && typeof signed.signature === 'string');
  assert.equal(verifySignedEnvelope(signed, keypair.publicKey), true);
  // digest matches the canonical digest of the SIGNATURE-LESS view
  assert.equal(digest, canonicalDigest(stripSignature(signed)));

  // tamper to payload after signing fails
  const tampered = { ...signed, payload: 'evil' };
  assert.equal(verifySignedEnvelope(tampered, keypair.publicKey), false);

  // missing signature fails
  const noSig = { ...signed, signature: undefined };
  assert.equal(verifySignedEnvelope(noSig, keypair.publicKey), false);
}

// ─── 5. signRunnerEnvelope roundtrip for every runner shape ───────────────────
function header() {
  return { actorId: ACTOR_ID, nonce: NONCE, createdAt: CREATED_AT };
}

function pythonHeader() {
  return { actorId: ACTOR_ID, role: 'runner', nonce: NONCE, timestamp: CREATED_AT };
}

function checkRoundtrip<T extends RunnerEnvelopeHeader | PythonSignedEnvelopeHeader>(
  envelope: T,
  label: string,
): void {
  const { signed, digest } = signRunnerEnvelope(envelope, keypair.privateKey);
  assert.ok(typeof signed.signature === 'string' && signed.signature.length > 0, `${label}: signature attached`);
  assert.equal(verifyRunnerEnvelope(signed, keypair.publicKey), true, `${label}: verifies with correct key`);
  assert.equal(
    verifyRunnerEnvelope(signed, otherKeypair.publicKey),
    false,
    `${label}: wrong key fails`,
  );
  // digest is over the signature-less canonical form
  assert.equal(digest, canonicalDigest(stripSignature(signed)), `${label}: digest = canonicalDigest(unsigned)`);
}

// 5a. ActorKeyRegistration
{
  const env: ActorKeyRegistration = {
    ...header(),
    publicKey: keypair.publicKey,
    keyLabel: 'primary',
    capabilities: ['ed25519'],
  };
  checkRoundtrip(env, 'ActorKeyRegistration');
  parseActorKeyRegistration(signRunnerEnvelope(env, keypair.privateKey).signed);
}

// 5b. RunnerRegistration
{
  const env: RunnerRegistration = {
    ...header(),
    runnerId: 'runner-1',
    runnerName: 'mac-arm64-1',
    capabilities: ['macos-arm64', 'node22'],
    runnerVersion: '0.3.5',
    metadata: { region: 'us' },
  };
  checkRoundtrip(env, 'RunnerRegistration');
  parseRunnerRegistration(signRunnerEnvelope(env, keypair.privateKey).signed);
}

// 5c. RunnerHeartbeat
{
  const env: RunnerHeartbeat = {
    ...header(),
    runnerId: 'runner-1',
    sequence: 7,
    activeJobs: ['job-1', 'job-2'],
    health: { load1: 0.5 },
  };
  checkRoundtrip(env, 'RunnerHeartbeat');
  parseRunnerHeartbeat(signRunnerEnvelope(env, keypair.privateKey).signed);
}

// 5d. JobClaim
{
  const env: JobClaim = {
    ...header(),
    runnerId: 'runner-1',
    leaseDurationSeconds: 120,
    capabilities: ['verify'],
  };
  checkRoundtrip(env, 'JobClaim');
  parseJobClaim(signRunnerEnvelope(env, keypair.privateKey).signed);
}

// 5e. JobLeaseHeartbeat
{
  const env: JobLeaseHeartbeat = {
    ...header(),
    jobId: 'job-1',
    progress: 0.5,
    leaseDurationSeconds: 60,
    status: 'verifying',
  };
  checkRoundtrip(env, 'JobLeaseHeartbeat');
  parseJobLeaseHeartbeat(signRunnerEnvelope(env, keypair.privateKey).signed);
}

// 5f. JobRelease
{
  const env: JobRelease = {
    ...pythonHeader(),
    jobId: 'job-1',
    release: { runnerId: 'runner-1', sessionId: 'session-1', reason: 'not-completed-release' },
  };
  checkRoundtrip(env, 'JobRelease');
  parseJobRelease(signRunnerEnvelope(env, keypair.privateKey).signed);

  // Python release has no outcome; extra fields are rejected at the schema boundary.
  assert.throws(() => parseJobRelease({ ...env, outcome: 'completed' }), /outcome/);
  assert.throws(() => parseJobRelease({ ...env, release: { runnerId: 'runner-1' } }), /sessionId/);
}

// 5g. ProviderEventsEnvelope
{
  const env: ProviderEventsEnvelope = {
    ...pythonHeader(),
    providerEvent: {
      eventId: 'e1',
      runId: 'run-1',
      provider: 'codex',
      type: 'completed',
      occurredAt: CREATED_AT,
      exitCode: 0,
      transcriptHash: 'abc123',
      artifactRefs: [],
    },
  };
  checkRoundtrip(env, 'ProviderEventsEnvelope');
  parseProviderEventsEnvelope(signRunnerEnvelope(env, keypair.privateKey).signed);

  // Python accepts one providerEvent per POST; legacy events[] is rejected.
  assert.throws(() => parseProviderEventsEnvelope({ ...env, events: [] }), /events/);
  assert.throws(() => parseProviderEventsEnvelope({ ...env, runId: 'run-1' }), /runId/);
  assert.throws(() => parseProviderEventsEnvelope({ ...env, providerEvent: { ...env.providerEvent, runId: '' } }), /runId/);
}

// ─── 6. Missing actor / nonce / timestamp: runtime re-validation ─────────────
{
  // sign-time throws
  assert.throws(
    () => signRunnerEnvelope({ actorId: '', nonce: NONCE, createdAt: CREATED_AT } as any, keypair.privateKey),
    /actorId is required/,
  );
  assert.throws(
    () => signRunnerEnvelope({ actorId: ACTOR_ID, nonce: '   ', createdAt: CREATED_AT } as any, keypair.privateKey),
    /nonce is required/,
  );
  assert.throws(
    () => signRunnerEnvelope({ actorId: ACTOR_ID, role: 'runner', nonce: NONCE, timestamp: '' } as any, keypair.privateKey),
    /timestamp is required/,
  );

  // verify-time false (no throw) on a forged envelope that omits required fields
  // We sign over a legal envelope, then mutate to remove actorId before verify —
  // the verifier must refuse to even attempt the crypto check.
  const ok = signRunnerEnvelope(
    { actorId: ACTOR_ID, nonce: NONCE, createdAt: CREATED_AT } as RunnerHeartbeat as any,
    keypair.privateKey,
  );
  const tampered = { ...ok.signed, actorId: '' } as unknown as { actorId: string; nonce: string; createdAt: string; signature?: string };
  assert.equal(verifyRunnerEnvelope(tampered as any, keypair.publicKey), false, 'verify refuses empty actorId');
}

// ─── 7. Adversarial L2+ boundary: signing alone does NOT make L2+ ─────────────
{
  // A signed runner envelope with no run binding still classifies as non-L2+.
  const env: RunnerHeartbeat = { ...header(), runnerId: 'runner-1' };
  const { signed } = signRunnerEnvelope(env, keypair.privateKey);
  const missing = missingRunnerL2Requirements({ envelope: signed, runBinding: {}, receiptVerified: false });
  assert.equal(runnerEnvelopeIsL2PlusCandidate({ envelope: signed }), false, 'signed-but-unbound is NOT L2+');
  for (const req of ['producerRunId', 'verifierRunId', 'provider', 'model', 'vendor', 'commandDigest', 'transcriptHash', 'diffHash', 'verifiedAuthorityReceipt'] as RunnerL2Requirement[]) {
    assert.ok(missing.includes(req), `missing must include ${req}`);
  }
  // envelopeSignature requirement is satisfied (we did sign)
  assert.ok(!missing.includes('envelopeSignature'), 'envelopeSignature is satisfied when signature is present');

  // Same-run collapse: even with every other binding, same producer/verifier
  // run id fails independentVerifierRunId.
  const collapsedMissing = missingRunnerL2Requirements({
    envelope: signed,
    runBinding: {
      producerRunId: 'run-x',
      verifierRunId: 'run-x',
      provider: 'p',
      model: 'm',
      vendor: 'v',
      commandDigest: 'd1',
      transcriptHash: 'd2',
      diffHash: 'd3',
    },
    receiptVerified: true,
  });
  assert.ok(
    collapsedMissing.includes('independentVerifierRunId'),
    'same-run producer/verifier MUST flag independentVerifierRunId',
  );
  assert.equal(
    runnerEnvelopeIsL2PlusCandidate({
      envelope: signed,
      runBinding: {
        producerRunId: 'run-x',
        verifierRunId: 'run-x',
        provider: 'p',
        model: 'm',
        vendor: 'v',
        commandDigest: 'd1',
        transcriptHash: 'd2',
        diffHash: 'd3',
      },
      receiptVerified: true,
    }),
    false,
    'collapsed verifier CANNOT classify as L2+ candidate',
  );

  // Whitespace-only difference between run ids still collapses.
  const collapsedWs = missingRunnerL2Requirements({
    envelope: signed,
    runBinding: {
      producerRunId: 'run-x',
      verifierRunId: '  run-x  ',
      provider: 'p',
      model: 'm',
      vendor: 'v',
      commandDigest: 'd1',
      transcriptHash: 'd2',
      diffHash: 'd3',
    },
    receiptVerified: true,
  });
  assert.ok(
    collapsedWs.includes('independentVerifierRunId'),
    'whitespace-only difference MUST still flag independentVerifierRunId',
  );

  // Distinct producer / verifier run ids + every other binding + receipt
  // verified → L2+ candidate (boundary CAN be cleared, just not by CLI shape).
  const allClear = runnerEnvelopeIsL2PlusCandidate({
    envelope: signed,
    runBinding: {
      producerRunId: 'producer-run',
      verifierRunId: 'verifier-run',
      provider: 'p',
      model: 'm',
      vendor: 'v',
      commandDigest: 'd1',
      transcriptHash: 'd2',
      diffHash: 'd3',
    },
    receiptVerified: true,
  });
  assert.equal(allClear, true, 'fully bound + verified receipt is L2+ candidate');
}

// ─── 8. RUNNER_L2_REQUIREMENTS frozen list contract ───────────────────────────
{
  // Mirrors authority-boundary.l2PlusRequirements() additions for runner side.
  for (const r of [
    'actorId',
    'nonce',
    'createdAt',
    'envelopeSignature',
    'producerRunId',
    'verifierRunId',
    'independentVerifierRunId',
    'provider',
    'model',
    'vendor',
    'commandDigest',
    'transcriptHash',
    'diffHash',
    'verifiedAuthorityReceipt',
  ] as const) {
    assert.ok(RUNNER_L2_REQUIREMENTS.includes(r), `RUNNER_L2_REQUIREMENTS must include ${r}`);
  }
}

// ─── 9. AuthorityReceipt sign/verify roundtrip + tamper detection ─────────────
{
  const receipt: AuthorityReceipt = {
    receiptId: 'rcpt-1',
    subjectId: 'EV-1',
    subjectKind: 'evidence',
    issuedAt: CREATED_AT,
    authorityActorId: 'authority-1',
    subjectDigest: 'sha256:abc',
  };
  const sig = signCanonical(stripSignature(receipt), keypair.privateKey);
  const signed: AuthorityReceipt = { ...receipt, signature: sig };
  assert.equal(verifyAuthorityReceipt(signed, keypair.publicKey), true);
  const publicKeyHex = Buffer.from(keypair.publicKey, 'base64').toString('hex');
  const signatureHex = Buffer.from(sig, 'base64').toString('hex');
  assert.equal(
    verifyAuthorityReceipt({ ...receipt, signature: signatureHex }, publicKeyHex),
    true,
    'Python-style hex publicKey/signature must verify the same receipt payload',
  );

  // tamper to subjectDigest fails
  assert.equal(
    verifyAuthorityReceipt({ ...signed, subjectDigest: 'sha256:evil' }, keypair.publicKey),
    false,
  );
  assert.equal(
    verifyAuthorityReceipt({ ...receipt, subjectDigest: 'sha256:evil', signature: signatureHex }, publicKeyHex),
    false,
    'hex verification must still reject tampered payloads',
  );
  // wrong key fails
  assert.equal(verifyAuthorityReceipt(signed, otherKeypair.publicKey), false);
  // missing signature fails
  assert.equal(verifyAuthorityReceipt({ ...signed, signature: undefined }, keypair.publicKey), false);
  // missing required fields fail (no throw)
  assert.equal(
    verifyAuthorityReceipt({ ...signed, receiptId: '' } as AuthorityReceipt, keypair.publicKey),
    false,
  );

  parseAuthorityReceipt(signed); // Zod parse path
}

// ─── 10. JobSpec parse + server-signed verify path ────────────────────────────
{
  const spec = {
    jobId: 'job-1',
    runId: 'run-1',
    kind: 'verify',
    storyId: 'B-1123',
    producerRunId: 'producer-run',
    verifierRunId: 'verifier-run',
    contextPackDigest: 'sha256:pack',
    leaseExpiresAt: CREATED_AT,
  };
  const parsed = parseJobSpec(spec);
  assert.equal(parsed.jobId, 'job-1');

  // Server can attach a signature over the canonical signature-less view.
  const sig = signCanonical(spec, keypair.privateKey);
  const signedSpec = { ...spec, signature: sig };
  assert.equal(verifyCanonical(stripSignature(signedSpec), sig, keypair.publicKey), true);
  // wrong key fails
  assert.equal(verifyCanonical(stripSignature(signedSpec), sig, otherKeypair.publicKey), false);
}

// ─── 11. Live actor-key registration body omits server-forbidden top-level runnerProvider (B-3157) ───
// The staging Authority server rejects POST /v1/actors/{id}/keys bodies that carry a
// top-level `runnerProvider` with HTTP 422 extra_forbidden; the provider must travel
// only inside capabilities.runnerProvider. Drive both exported registration entrypoints
// with a recording fetchImpl and assert the captured request body shape.
await (async () => {
  const kp = generateEd25519KeyPair();
  const baseOptions = {
    baseURL: 'https://authority.smoke.invalid',
    timeoutMS: 5_000,
    actorId: 'smoke-actor',
    role: 'runner',
    actorKeyId: 'smoke-key',
    actorPrivateKey: kp.privateKey,
    actorPrivateKeyEncoding: 'auto' as const,
    runnerId: 'smoke-runner',
    sessionId: 'smoke-session',
    runnerProvider: 'codex' as const,
    projectId: 'smoke-project',
    customerApiKey: 'smoke-customer-key',
    once: true,
  };

  function recordingFetch(): {
    fetchImpl: typeof fetch;
    calls: Array<{ url: string; method: string; body: any }>;
  } {
    const calls: Array<{ url: string; method: string; body: any }> = [];
    const fetchImpl = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input);
      const method = init?.method ?? 'GET';
      let body: any;
      if (init?.body) {
        try {
          body = JSON.parse(init.body as string);
        } catch {
          body = init.body;
        }
      }
      calls.push({ url, method, body });
      // Reject after capturing so the control-plane sequence stops right after actor-key.
      return {
        ok: false,
        status: 409,
        async text() {
          return '{"detail":"smoke-stop"}';
        },
      } as any;
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  function actorKeyBody(calls: Array<{ url: string; method: string; body: any }>): any {
    const call = calls.find((c) => c.method === 'POST' && /\/v1\/actors\/[^/]+\/keys$/.test(c.url));
    assert.ok(call, 'actor-key registration POST must be issued');
    return call!.body;
  }

  function assertActorKeyBodyShape(body: any, label: string): void {
    assert.ok(
      body && typeof body === 'object' && !('runnerProvider' in body),
      `${label}: actor-key body must NOT carry a top-level runnerProvider (server rejects it with 422 extra_forbidden)`,
    );
    assert.equal(body.runnerId, 'smoke-runner', `${label}: runnerId must be retained at top level`);
    assert.equal(
      body?.capabilities?.runnerProvider,
      'codex',
      `${label}: provider must still travel inside capabilities.runnerProvider`,
    );
  }

  // path A — job-loop live runner (claimAuthorityJobForLoop)
  {
    const { fetchImpl, calls } = recordingFetch();
    await claimAuthorityJobForLoop(
      { ...baseOptions, fetchImpl, jobCreateMode: 'server_delegated' },
      { storyId: 'B-3157', mode: 'authority', until: 'DONE' },
    );
    assertActorKeyBodyShape(actorKeyBody(calls), 'job-loop-live');
  }

  // path B — control-plane runner (runLatticeAuthorityControlPlaneOnce)
  {
    const { fetchImpl, calls } = recordingFetch();
    await runLatticeAuthorityControlPlaneOnce({ ...baseOptions, fetchImpl });
    assertActorKeyBodyShape(actorKeyBody(calls), 'control-plane');
  }
})();

console.log(PASS_LINE);
