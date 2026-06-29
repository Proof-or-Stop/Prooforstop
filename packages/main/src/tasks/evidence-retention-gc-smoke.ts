#!/usr/bin/env node

// Acceptance smoke for the M8 runtime evidence redaction + retention/GC layer
// (§B4a / §B4b of lattice-authority-live-integration.md). Unlike
// planner-unattended-smoke (which pins POLICY EMISSION + the consistency gate
// only), this smoke drives the actual runtime engines and proves:
//   - content redaction removes every known secret class before upload while the
//     original digest stays recoverable for verification;
//   - the deterministic retention sweeper deletes ONLY expired non-receipt-bound
//     artifacts and protects receipt-bound / protected / final-summary records.

import assert from 'node:assert/strict';
import {
  REDACTION_PLACEHOLDER,
  mergeRedactionSummaries,
  projectEnvReferences,
  redactEvidence,
  redactText,
} from '../core/evidence-redaction.js';
import {
  DEFAULT_RETENTION_POLICY,
  classifyRetention,
  evaluateRetention,
  runRetentionSweep,
  sweepRetention,
  type RetainedArtifact,
} from '../core/evidence-retention.js';
import { createHash } from 'node:crypto';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Part 1: content redaction (§B4a)
// ---------------------------------------------------------------------------
function testRedaction(): void {
  const secrets = [
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_0123456789abcdefghijABCDEFGHIJ012345',
    'sk-abcdefghijklmnopqrstuvwxyz0123456789',
    'xoxb-12345-abcdefABCDEF',
  ];
  const dirty = [
    'Starting run...',
    `Authorization: Bearer ${'a'.repeat(40)}`,
    'export GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ012345',
    'db_password=hunter2supersecretvalue',
    'MULTI_WORD_SECRET=alpha beta gamma',
    'api-key=plainsecretvalue',
    'PROOFBOUND_TEST_ACTOR_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    '{"apiKey":"sk-abcdefghijklmnopqrstuvwxyz0123456789","ok":true}',
    'Set-Cookie: session=deadbeefcafebabe; HttpOnly',
    'short auth Basic abc',
    'lowercase bearer bearer lowercase-secret-token-1234567890',
    'lowercase basic basic abcdef123456',
    'aws id AKIAIOSFODNN7EXAMPLE used',
    'token xoxb-12345-abcdefABCDEF posted',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc\n-----END RSA PRIVATE KEY-----',
    'normal log line with no secrets',
  ].join('\n');

  const { text, summary } = redactText(dirty);

  // Every literal secret must be gone from the redacted output.
  for (const s of secrets) {
    assert(!text.includes(s), `redaction must remove secret "${s.slice(0, 12)}…"`);
  }
  assert(!text.includes('hunter2supersecretvalue'), 'password value must be redacted');
  assert(!text.includes('alpha beta gamma'), 'multi-word secret assignment must be redacted');
  assert(!text.includes('plainsecretvalue'), 'hyphenated secret key assignment must be redacted');
  assert(!text.includes('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'), 'actor key assignment must be redacted');
  assert(!text.includes('Basic abc'), 'short Basic credential must be redacted');
  assert(!text.includes('bearer lowercase-secret-token-1234567890'), 'lowercase Bearer credential must be redacted');
  assert(!text.includes('basic abcdef123456'), 'lowercase Basic credential must be redacted');
  assert(!text.includes('BEGIN RSA PRIVATE KEY') || !text.includes('MIIEowIBAA'), 'PEM key body must be redacted');
  assert(!text.includes('deadbeefcafebabe'), 'session cookie value must be redacted');
  assert(text.includes(REDACTION_PLACEHOLDER), 'redacted output must contain the placeholder');
  // Non-secret content survives.
  assert(text.includes('normal log line with no secrets'), 'clean text must be preserved');
  assert(text.includes('Starting run...'), 'clean text must be preserved');

  // Summary integrity: redacted flag, rule hits, and ORIGINAL digest recoverable.
  assert.equal(summary.redacted, true, 'summary must report redaction occurred');
  assert(summary.ruleHits.length >= 5, `expected multiple rules to fire, got ${summary.ruleHits.length}`);
  assert.equal(summary.originalDigest, sha256Hex(dirty), 'originalDigest must match the unredacted local artifact');
  assert.equal(summary.redactedDigest, sha256Hex(text), 'redactedDigest must match the uploaded text');
  assert.notEqual(summary.originalDigest, summary.redactedDigest, 'redaction changed material evidence');

  // Clean text → no-op, no false redaction.
  const clean = redactText('just a normal validation log: 42 tests passed in 1.3s');
  assert.equal(clean.summary.redacted, false, 'clean text must not be flagged as redacted');
  assert.equal(clean.text, 'just a normal validation log: 42 tests passed in 1.3s', 'clean text must pass through unchanged');
  assert.equal(clean.summary.ruleHits.length, 0, 'clean text must have zero rule hits');

  // Field-level redaction across an evidence record + merged summary.
  const ev = redactEvidence({
    stdout: 'ok',
    stderr: 'Authorization: Bearer secrettokenvalue1234567890',
    note: 'no secrets here',
    prompt: 'use API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789 please',
  });
  assert(!ev.evidence.stderr!.includes('secrettokenvalue'), 'stderr secret must be redacted');
  assert(!ev.evidence.prompt!.includes('sk-abcdefghijklmnopqrstuvwxyz0123456789'), 'prompt secret must be redacted');
  assert.equal(ev.evidence.stdout, 'ok', 'clean field unchanged');
  assert.equal(ev.summary.redacted, true, 'merged summary must report redaction');

  // mergeRedactionSummaries is associative on rule counts.
  const merged = mergeRedactionSummaries([
    redactText('Bearer aaaaaaaaaaaaaaaaaaaa').summary,
    redactText('Bearer bbbbbbbbbbbbbbbbbbbb').summary,
  ]);
  const bearerHit = merged.ruleHits.find(h => h.rule === 'bearer_scheme');
  assert.equal(bearerHit?.count, 2, 'merged summary must sum rule counts across fields');

  // Env references = names only, never values.
  const refs = projectEnvReferences({ SECRET_TOKEN: 'leakme', PATH: '/usr/bin' });
  assert.deepEqual(refs, ['PATH', 'SECRET_TOKEN'], 'env references must be sorted names only');
  assert(!JSON.stringify(refs).includes('leakme'), 'env values must never appear in references');

  console.log('  ✓ content redaction removes all secret classes, preserves digests + clean text');
}

// ---------------------------------------------------------------------------
// Part 2: retention / GC (§B4b)
// ---------------------------------------------------------------------------
const NOW = 1_900_000_000_000; // fixed clock for deterministic expiry math
const DAY = 24 * 60 * 60 * 1000;

function artifact(over: Partial<RetainedArtifact> & Pick<RetainedArtifact, 'artifactId'>): RetainedArtifact {
  return {
    kind: 'run_record',
    retentionClass: 'short_lived_run_log',
    createdAtMs: NOW - 2 * DAY,
    receiptBound: false,
    protected: false,
    ...over,
  };
}

function testRetentionGc(): void {
  const store: RetainedArtifact[] = [
    // Expired short-lived run log, not receipt-bound → DELETE.
    artifact({ artifactId: 'a-expired-log', retentionClass: 'short_lived_run_log', createdAtMs: NOW - 2 * DAY }),
    // Fresh short-lived run log, within window → RETAIN.
    artifact({ artifactId: 'b-fresh-log', retentionClass: 'short_lived_run_log', createdAtMs: NOW - 1 * 60 * 60 * 1000 }),
    // Receipt-bound artifact whose own class is short-lived and is old, but inside
    // the receipt-bound window → RETAIN (must not GC before receipt window expires).
    artifact({ artifactId: 'c-receipt-bound', kind: 'gate_request', retentionClass: 'receipt_bound_artifact', createdAtMs: NOW - 10 * DAY, receiptBound: true }),
    // Final summary, ancient → RETAIN (remains queryable forever).
    artifact({ artifactId: 'd-final-summary', kind: 'stop_summary', retentionClass: 'final_summary', createdAtMs: NOW - 4000 * DAY }),
    // Protected receipt JSON record, ancient → RETAIN (never deletable).
    artifact({ artifactId: 'e-receipt-json', kind: 'gate_decision', retentionClass: 'receipt_bound_artifact', createdAtMs: NOW - 4000 * DAY, receiptBound: true, protected: true }),
    // Expired verification artifact, not receipt-bound → DELETE.
    artifact({ artifactId: 'f-expired-verif', kind: 'validation_evidence', retentionClass: 'verification_artifact', createdAtMs: NOW - 30 * DAY }),
  ];

  const plan = sweepRetention(store, NOW, DEFAULT_RETENTION_POLICY);

  // Exactly the two genuinely-expired non-protected artifacts are deletable.
  assert.deepEqual(plan.deleted, ['a-expired-log', 'f-expired-verif'], `unexpected deletion set: ${plan.deleted.join(',')}`);
  for (const keep of ['b-fresh-log', 'c-receipt-bound', 'd-final-summary', 'e-receipt-json']) {
    assert(plan.retained.includes(keep), `${keep} must be retained`);
  }

  // Receipt-bound protection is explicit and reasoned.
  const c = evaluateRetention(store[2], NOW);
  assert.equal(c.delete, false, 'receipt-bound artifact inside window must not be deleted');
  assert.equal(c.reason, 'within_receipt_bound_window', 'reason must name the receipt-bound protection');
  assert.equal(c.effectiveWindowMs, DEFAULT_RETENTION_POLICY.receiptBoundWindowMs, 'receipt-bound floor must apply');

  // A receipt-bound artifact PAST the receipt window does become deletable —
  // unless it is also protected (receipt JSON), which never deletes.
  const expiredReceiptBound = artifact({ artifactId: 'g-old-receipt-bound', retentionClass: 'receipt_bound_artifact', createdAtMs: NOW - 200 * DAY, receiptBound: true });
  assert.equal(evaluateRetention(expiredReceiptBound, NOW).delete, true, 'receipt-bound artifact past its window is deletable');
  const protectedOld = evaluateRetention(store[4], NOW);
  assert.equal(protectedOld.delete, false, 'protected receipt JSON is never deleted even when ancient');
  assert.equal(protectedOld.reason, 'protected_record_never_deleted', 'protected reason must be explicit');

  // Determinism: same store + same clock → identical deletion order, twice.
  const again = sweepRetention([...store].reverse(), NOW, DEFAULT_RETENTION_POLICY);
  assert.deepEqual(again.deleted, plan.deleted, 'sweep must be deterministic regardless of input order');

  // Fail-closed on bad input: unknown class + negative age both retain.
  const unknown = { artifactId: 'x', kind: 'k', retentionClass: 'keep_forever' as never, createdAtMs: NOW - 9999 * DAY, receiptBound: false, protected: false };
  assert.equal(evaluateRetention(unknown, NOW).delete, false, 'unknown retention class must fail closed (retain)');
  const future = artifact({ artifactId: 'y', createdAtMs: NOW + 5 * DAY });
  assert.equal(evaluateRetention(future, NOW).delete, false, 'negative age (clock skew) must fail closed (retain)');

  // Actual deletion side effect: runRetentionSweep deletes ONLY the allowed ids.
  const live = new Map(store.map(a => [a.artifactId, a] as const));
  const result = runRetentionSweep(store, NOW, id => {
    assert(live.has(id), `deleteFn must only be called for live artifacts, got ${id}`);
    live.delete(id);
  });
  assert.deepEqual(result.deleted.sort(), ['a-expired-log', 'f-expired-verif'], 'only expired artifacts deleted from store');
  assert.equal(result.failed.length, 0, 'no deletion failures expected');
  assert(live.has('c-receipt-bound'), 'receipt-bound artifact must survive the real sweep');
  assert(live.has('d-final-summary'), 'final summary must survive the real sweep');
  assert(live.has('e-receipt-json'), 'protected receipt JSON must survive the real sweep');
  assert(!live.has('a-expired-log'), 'expired log must be gone from the store');

  // A deleteFn that throws records the failure without corrupting the kept set.
  const flaky = runRetentionSweep(store, NOW, id => {
    if (id === 'a-expired-log') throw new Error('storage offline');
  });
  assert.deepEqual(flaky.failed.map(f => f.artifactId), ['a-expired-log'], 'throwing deleteFn must surface as failed');
  assert.deepEqual(flaky.deleted, ['f-expired-verif'], 'failed deletion must not be counted as deleted');

  console.log('  ✓ retention sweep deletes only expired non-receipt-bound artifacts; protects receipt-bound/final/protected');
}

// ---------------------------------------------------------------------------
// Part 3: retention CLASSIFICATION (§B4b) — consistent kind -> class mapping
// ---------------------------------------------------------------------------
function testRetentionClassification(): void {
  // The canonical mapping the planner emits is applied consistently to the run
  // record, provider events, command/validation/git evidence, and final summary.
  assert.equal(classifyRetention('run_record'), 'short_lived_run_log');
  assert.equal(classifyRetention('provider_event'), 'short_lived_run_log');
  assert.equal(classifyRetention('command_event'), 'short_lived_run_log');
  assert.equal(classifyRetention('validation_evidence'), 'verification_artifact');
  assert.equal(classifyRetention('git_evidence'), 'verification_artifact');
  assert.equal(classifyRetention('gate_request'), 'receipt_bound_artifact');
  assert.equal(classifyRetention('stop_summary'), 'final_summary', 'the final summary is queryable forever');

  // A JobPlan policy override that names a KNOWN class wins.
  assert.equal(
    classifyRetention('validation_evidence', { validation_evidence: 'receipt_bound_artifact' }),
    'receipt_bound_artifact',
    'a policy override of a known class is honored',
  );
  // An override with an UNKNOWN class is ignored (fail-closed back to canonical default).
  assert.equal(
    classifyRetention('run_record', { run_record: 'keep_forever' as never }),
    'short_lived_run_log',
    'an unknown override class falls back to the canonical default, never crashes',
  );
  // A kind with no mapping at all gets the conservative long-window fallback.
  assert.equal(classifyRetention('totally_unknown_kind'), 'receipt_bound_artifact', 'unmapped kinds get a conservative finite window');

  console.log('  ✓ retention classification is consistent (run/provider/command/validation/git/gate/summary) + fail-closed on bad overrides');
}

function main(): void {
  console.log('evidence-retention-gc-smoke:');
  testRedaction();
  testRetentionGc();
  testRetentionClassification();
  console.log('evidence-retention-gc-smoke: PASS');
}

main();
