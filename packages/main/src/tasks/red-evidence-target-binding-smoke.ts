#!/usr/bin/env node

// Trusted RED-evidence W2b acceptance smoke (B-e10d).
//
// Proves the target-binding STORE + owner-gated `red_evidence_binding_set` — the
// subsystem's first mutating command — of the RED-evidence subsystem spec
// (docs/requirements/decisions/red-evidence-subsystem-spec.md §1.1.3, §3.3, §4.1):
//   1. §1.1.3 store: exactly ONE binding per acceptanceTargetRef (duplicate
//      REJECTS, not overwrite); a different target APPENDS; StoryStore round-trips.
//   2. §1.1.3 digest TRAP: targetBindingDigest = CANON over the createdAt-STRIPPED
//      3-field subobject — CANON over a STORED entry (with createdAt) must NOT
//      equal it, CANON over the identity subobject MUST; allowlist not blocklist.
//   3. §3.3 membership: resolveExpectedRedTargets is a shared exported resolver
//      with the SAME computed set; the write-time gate rejects an out-of-set
//      acceptanceTargetRef (case-sensitively).
//   4. §1.1.3 anti-swap: the committed-tree reader resolves from a git ref
//      (git show), NEVER the live directory; a bad ref fails closed.
//   5. §4.1 owner-gated: red_evidence_binding_set is storyScopedMutating and is
//      REJECTED under a FOREIGN active owner lease; a role without the mutation
//      authority is rejected independently of the lease.
//   6. NO existing gate verdict changes: redEvidenceSatisfied / missingRedEvidence
//      for a representative story are IDENTICAL before and after a binding write.
//   7. The three pre-existing mechanical contracts (lifecycle-registry,
//      command-ownership, verify-process-fact) pass with the command fully wired.
//
// Assurance scope (§0.6 practical tier): handler-enforced consistency through the
// registered surfaces; not a defense against a hostile local agent with
// filesystem control (that is the Tier-C program).

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canon, canonDigest } from '../core/red-evidence/canon.js';
import {
  RED_TARGET_BINDINGS_SCHEMA_VERSION,
  RED_TARGET_BINDINGS_FILENAME,
  emptyRedTargetBindingsFile,
  targetBindingDigest,
  strippedBindingIdentity,
  appendTargetBinding,
  findTargetBinding,
  readCommittedTargetBindings,
  RedTargetBindingDuplicateError,
} from '../core/red-evidence/target-bindings.js';
import { resolveExpectedRedTargets, evaluateProofStoryDiagnostics, computeMilestoneLedgerHash } from '../core/proofstory.js';
import { StoryStore } from '../core/store.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';
import { proofStoryDiagnosticInput } from '../handlers/phase-gates.js';
import {
  enforceStoryOwnerLeaseGate,
  resolveEffectiveOwnershipClass,
} from '../cli-engine.js';
import {
  acquireOwnerLease,
  ownerLeasePath,
  resetSessionIdForTest,
} from '../core/story-owner-lease.js';
import { resolveAgentMutationAuthority } from '../core/agent-dispatch-registry.js';
import type { StoryInfo, MilestoneLedgerData } from '../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const repoRoot = join(pkgRoot, '..', '..');

const roots: string[] = [];
function freshRoot(label: string): string {
  const r = mkdtempSync(join(tmpdir(), `red-w2b-${label}-`));
  roots.push(r);
  return r;
}

try {
  // === 1. Store: schema + one-binding-per-target uniqueness (§1.1.3) =========
  assert.equal(RED_TARGET_BINDINGS_SCHEMA_VERSION, 'proofstory.red_target_bindings.v1');
  assert.equal(RED_TARGET_BINDINGS_FILENAME, 'red-target-bindings.json');

  const idA = { acceptanceTargetRef: 'M1', adapterId: 'node-test-runner', testCaseRef: 'test/red/a.test.ts' };
  const idB = { acceptanceTargetRef: 'M2', adapterId: 'node-test-runner', testCaseRef: 'test/red/b.test.ts' };
  const emptyFile = emptyRedTargetBindingsFile('B-smoke', '2026-07-25T00:00:00.000Z');
  assert.deepEqual(emptyFile.bindings, []);
  const oneA = appendTargetBinding(emptyFile, idA, '2026-07-25T00:00:01.000Z');
  assert.equal(oneA.bindings.length, 1);
  assert.equal(emptyFile.bindings.length, 0, 'append is pure — source not mutated');
  const twoAB = appendTargetBinding(oneA, idB, '2026-07-25T00:00:02.000Z');
  assert.equal(twoAB.bindings.length, 2, 'a different target appends');
  assert.throws(
    () => appendTargetBinding(twoAB, { acceptanceTargetRef: 'M1', adapterId: 'x', testCaseRef: 'y' }),
    (e: unknown) => e instanceof RedTargetBindingDuplicateError,
    'a duplicate acceptanceTargetRef REJECTS (§1.1.3)',
  );
  assert.ok(findTargetBinding(twoAB, 'M1'));
  assert.equal(findTargetBinding(twoAB, 'M404'), undefined);

  // StoryStore round-trip (readRedTargetBindings / writeRedTargetBindings).
  {
    const store = new StoryStore(freshRoot('store'));
    assert.equal(store.readRedTargetBindings('B-smoke'), null, 'cold-start read returns null');
    store.writeRedTargetBindings('B-smoke', twoAB);
    const back = store.readRedTargetBindings('B-smoke');
    assert.ok(back);
    assert.equal(back!.bindings.length, 2);
    assert.equal(back!.schemaVersion, 'proofstory.red_target_bindings.v1');
  }

  // === 2. createdAt-strip digest, BOTH directions (§1.1.3 digest scope) ======
  const stored = oneA.bindings[0]; // has createdAt
  const digestA = targetBindingDigest(idA);
  assert.notEqual(canonDigest(stored), digestA,
    'CANON over the STORED entry (with createdAt) must NOT equal targetBindingDigest');
  assert.equal(canonDigest({ acceptanceTargetRef: idA.acceptanceTargetRef, adapterId: idA.adapterId, testCaseRef: idA.testCaseRef }), digestA,
    'CANON over the 3-field identity subobject MUST equal targetBindingDigest');
  assert.deepEqual(strippedBindingIdentity(stored), idA, 'strip yields exactly the 3 identity fields');
  const differentCreatedAt = { ...stored, createdAt: '2099-01-01T00:00:00.000Z' };
  assert.equal(targetBindingDigest(differentCreatedAt), digestA, 'differing createdAt yields the same digest');
  const withExtraMeta = { ...stored, updatedAt: 'x', note: 'junk' };
  assert.equal(targetBindingDigest(withExtraMeta), digestA,
    'allowlist strip: extra metadata beyond createdAt is also excluded');
  assert.equal(canon(strippedBindingIdentity(stored)), canon(idA));

  // === 3. expectedRedTargets shared resolver + membership (§3.3) =============
  const repInput = {
    originalIntentSnapshot: { requestHash: 'sha256:REQ' },
    proofStoryContract: { acceptanceBindings: [{ id: 'AB-001', verificationIntentRefs: ['CHK-001:happy:0'], milestoneIds: ['M9'] }] },
    milestoneLedger: { milestones: [{ id: 'M1', verificationIntentRefs: ['CHK-002:edge:0'] }] },
  };
  const resolved = resolveExpectedRedTargets(repInput);
  assert.deepEqual([...resolved].sort(), ['AB-001', 'CHK-001:happy:0', 'CHK-002:edge:0', 'M1', 'M9', 'sha256:REQ'].sort(),
    'resolveExpectedRedTargets returns the same computed set (same-set extraction)');
  assert.equal(resolved.has('M1'), true);
  assert.equal(resolved.has('m1'), false, 'membership is CASE-SENSITIVE');
  assert.equal(resolveExpectedRedTargets({ originalIntentSnapshot: null, proofStoryContract: null, milestoneLedger: null }).size, 0);

  // === 4. Committed-tree reader — git ref, never the live dir (§1.1.3) =======
  {
    const repo = freshRoot('committed');
    const git = (args: string[]) => {
      const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout;
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'red@w2b.local']);
    git(['config', 'user.name', 'red-w2b']);
    const relPath = `.proof-or-stop/story/actives/B-smoke/${RED_TARGET_BINDINGS_FILENAME}`;
    const abs = join(repo, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    const committedFile = appendTargetBinding(emptyRedTargetBindingsFile('B-smoke', '2026-07-25T00:00:00.000Z'),
      { acceptanceTargetRef: 'M1', adapterId: 'runner-A', testCaseRef: 'test/A.ts' }, '2026-07-25T00:00:01.000Z');
    writeFileSync(abs, JSON.stringify(committedFile, null, 2) + '\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'binding-A']);
    const ref = git(['rev-parse', 'HEAD']).trim();
    // Swap the live directory to a different binding (uncommitted).
    const liveFile = appendTargetBinding(emptyRedTargetBindingsFile('B-smoke', '2026-07-25T00:00:00.000Z'),
      { acceptanceTargetRef: 'M1', adapterId: 'runner-B-SWAPPED', testCaseRef: 'test/B.ts' }, '2026-07-25T00:00:05.000Z');
    writeFileSync(abs, JSON.stringify(liveFile, null, 2) + '\n');

    const got = readCommittedTargetBindings({ gitCwd: repo, ref, relPath });
    assert.ok(got);
    assert.equal(got!.bindings[0].adapterId, 'runner-A', 'reader returns the COMMITTED binding, not the live swap (anti-swap)');
    assert.equal(readCommittedTargetBindings({ gitCwd: repo, ref, relPath: `.proof-or-stop/story/actives/B-none/${RED_TARGET_BINDINGS_FILENAME}` }), null,
      'a missing file at a valid ref returns null (no live fallback)');
    assert.throws(
      () => readCommittedTargetBindings({ gitCwd: repo, ref: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', relPath }),
      'a bad ref fails closed (throws), never reads the live dir',
    );
  }

  // === 5. Owner-lease + mutation authority (§4.1) ============================
  assert.equal(resolveEffectiveOwnershipClass('red_evidence_binding_set', {}, 'B-smoke'), 'storyScopedMutating',
    'red_evidence_binding_set flows through the owner-lease choke point as storyScopedMutating');
  // Mutation-authority is independent of the lease: an owner role is accepted,
  // a role lacking the mutation is rejected.
  assert.doesNotThrow(() => resolveAgentMutationAuthority({ command: 'red_evidence_binding_set', envActor: 'proof-or-stop-implementer' }));
  assert.throws(() => resolveAgentMutationAuthority({ command: 'red_evidence_binding_set', envActor: 'verification-intent' }),
    'a role without red_evidence_binding_set authority is rejected');
  {
    const leaseRoot = freshRoot('lease');
    const store = new StoryStore(leaseRoot);
    const storyId = 'B-lease';
    const storyDir = store.storyDirPath(storyId);
    mkdirSync(storyDir, { recursive: true });
    const savedSession = process.env.PROOF_OR_STOP_SESSION_ID;
    try {
      // A FOREIGN session holds the active lease.
      process.env.PROOF_OR_STOP_SESSION_ID = 'sess-owner';
      resetSessionIdForTest();
      acquireOwnerLease(storyDir, { command: 'checklist_update', cwd: '/tmp/owner-wt' });
      const leaseBefore = readFileSync(ownerLeasePath(storyDir), 'utf-8');
      // Act as a different session.
      process.env.PROOF_OR_STOP_SESSION_ID = 'sess-intruder';
      resetSessionIdForTest();
      assert.throws(
        () => enforceStoryOwnerLeaseGate('red_evidence_binding_set', { storyId }, store, null, leaseRoot),
        (err: Error) => err.message.includes(storyId) && err.message.includes('sess-owner') && err.message.includes('owner-gated'),
        'red_evidence_binding_set under a FOREIGN active owner lease is rejected fail-closed (§4.1)',
      );
      assert.equal(readFileSync(ownerLeasePath(storyDir), 'utf-8'), leaseBefore, 'a rejected command performs no lease write');
      // The owner's own call is allowed (acquire/refresh).
      const ownStory = 'B-lease-own';
      mkdirSync(store.storyDirPath(ownStory), { recursive: true });
      assert.doesNotThrow(() => enforceStoryOwnerLeaseGate('red_evidence_binding_set', { storyId: ownStory }, store, null, leaseRoot),
        'the owning session runs red_evidence_binding_set and acquires the lease');
    } finally {
      if (savedSession === undefined) delete process.env.PROOF_OR_STOP_SESSION_ID;
      else process.env.PROOF_OR_STOP_SESSION_ID = savedSession;
      resetSessionIdForTest();
    }
  }

  // === 5b. STALE foreign lease recovery: reject without --takeover, succeed ===
  //        with --takeover, then the registered handler binds through the
  //        recovered lease (CHK-007:adversarial:0 committed artifact, F-002).
  //
  // The §4.1 owner-lease choke point must (a) still REJECT a non-owner
  // red_evidence_binding_set when a FOREIGN lease is merely STALE and no
  // takeover flag is supplied — a stale lease is not a free-for-all — and
  // (b) let the SAME session recover that stale lease with --takeover and then
  // run the mutating command through the registered handler. This exercises the
  // exact registered-handler + choke-point path a real CLI invocation follows.
  {
    const root = freshRoot('stale-lease');
    const store = new StoryStore(root);
    const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages', 'main') };
    const registry = createMainRegistry(ctx);
    const bindingSet = registry.get('red_evidence_binding_set');
    assert.ok(bindingSet, 'red_evidence_binding_set has a registered handler');

    const storyId = 'B-stale';
    const now = '2026-07-25T00:00:00.000Z';
    const story: StoryInfo = {
      storyId, name: 'w2b-stale', title: 'W2b stale-lease takeover',
      description: 'Fix an authentication session security regression (behavior change).',
      type: 'bug', phase: 'DEV', priority: 'high', createdAt: now, startedAt: now, endedAt: null,
    };
    store.writeStory(storyId, story);
    const ledgerMilestones = [{
      id: 'M1', sourceRequirementId: 'REQ-1', claim: 'auth fix', doneMeans: 'test passes',
      requiredEvidence: [], checklistRefs: ['CHK-001'], verificationIntentRefs: ['CHK-001:happy:0'], status: 'planned' as const,
    }];
    const ledger: MilestoneLedgerData = {
      schemaVersion: 'proofstory.milestone_ledger.v1', storyId, state: 'confirmed',
      ledgerHash: computeMilestoneLedgerHash(ledgerMilestones),
      milestones: ledgerMilestones,
      createdAt: now, updatedAt: now,
    };
    store.writeMilestoneLedger(storyId, ledger);
    assert.equal(resolveExpectedRedTargets(proofStoryDiagnosticInput(store, storyId, root)).has('M1'), true,
      'M1 is an expected RED target for the stale-lease story');

    const storyDir = store.storyDirPath(storyId);
    const savedSession = process.env.PROOF_OR_STOP_SESSION_ID;
    try {
      // A FOREIGN session "sess-owner" holds a STALE lease: heartbeat 40 minutes
      // ago (> STALE_LEASE_THRESHOLD_MS of 30 min).
      const staleStamp = new Date(Date.now() - 40 * 60 * 1000).toISOString();
      process.env.PROOF_OR_STOP_SESSION_ID = 'sess-owner';
      resetSessionIdForTest();
      acquireOwnerLease(storyDir, { command: 'checklist_update', cwd: '/tmp/owner-wt', now: () => staleStamp });
      const staleLease = JSON.parse(readFileSync(ownerLeasePath(storyDir), 'utf-8'));
      assert.equal(staleLease.sessionId, 'sess-owner', 'the stale lease is owned by the foreign session');
      assert.equal(staleLease.heartbeatAt, staleStamp, 'the stale lease heartbeat is 40 minutes old');
      const leaseBefore = readFileSync(ownerLeasePath(storyDir), 'utf-8');

      // Act as a DIFFERENT session "sess-intruder".
      process.env.PROOF_OR_STOP_SESSION_ID = 'sess-intruder';
      resetSessionIdForTest();

      // (a) WITHOUT --takeover: a stale foreign lease still REJECTS the
      // owner-gated command; the rejection points at --takeover and performs no
      // lease write (no silent steal of even a stale lease).
      assert.throws(
        () => enforceStoryOwnerLeaseGate('red_evidence_binding_set', { storyId }, store, null, root),
        (err: Error) =>
          err.message.includes(storyId) &&
          err.message.includes('sess-owner') &&
          err.message.includes('STALE') &&
          err.message.includes('--takeover'),
        'a stale foreign lease still rejects red_evidence_binding_set without --takeover, pointing at --takeover recovery (§4.1)',
      );
      assert.equal(readFileSync(ownerLeasePath(storyDir), 'utf-8'), leaseBefore,
        'the rejected (no-takeover) command performed no lease write — the stale lease is untouched');

      // (b) WITH --takeover: the same session recovers the stale lease through
      // the choke point (no throw), and the lease is transferred to it.
      assert.doesNotThrow(
        () => enforceStoryOwnerLeaseGate('red_evidence_binding_set', { storyId, takeover: true }, store, null, root),
        'red_evidence_binding_set with --takeover recovers the STALE foreign lease through the owner-lease choke point',
      );
      const recovered = JSON.parse(readFileSync(ownerLeasePath(storyDir), 'utf-8'));
      assert.equal(recovered.sessionId, 'sess-intruder',
        'the stale lease was transferred to the takeover session (recovery succeeded)');
      assert.notEqual(recovered.heartbeatAt, staleStamp, 'the recovered lease carries a fresh heartbeat');

      // (c) With the lease recovered, the REGISTERED handler binds M1 — the
      // full post-gate dispatch path a real CLI invocation follows.
      const msg: string = bindingSet!({ storyId, acceptanceTargetRef: 'M1', adapterId: 'node-test-runner', testCaseRef: 'test/red/m1.test.ts', agent: 'proof-or-stop-implementer' });
      assert.match(msg, /targetBindingDigest sha256:/, 'the registered handler bound M1 after stale-lease recovery');
      const persisted = store.readRedTargetBindings(storyId);
      assert.ok(persisted && persisted.bindings.length === 1 && persisted.bindings[0].acceptanceTargetRef === 'M1',
        'the binding written through the recovered lease persisted exactly once');
    } finally {
      if (savedSession === undefined) delete process.env.PROOF_OR_STOP_SESSION_ID;
      else process.env.PROOF_OR_STOP_SESSION_ID = savedSession;
      resetSessionIdForTest();
    }
  }

  // === 6. Handler happy/reject paths + NO gate verdict change ================
  {
    const root = freshRoot('handler');
    const store = new StoryStore(root);
    const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages', 'main') };
    const registry = createMainRegistry(ctx);
    const bindingSet = registry.get('red_evidence_binding_set');
    assert.ok(bindingSet, 'red_evidence_binding_set has a registered handler');

    const storyId = 'B-hdl';
    const now = '2026-07-25T00:00:00.000Z';
    const story: StoryInfo = {
      storyId, name: 'w2b-rep', title: 'W2b representative bug',
      // description triggers the red_evidence_required ProofStory trigger.
      description: 'Fix an authentication session security regression (behavior change).',
      type: 'bug', phase: 'DEV', priority: 'high', createdAt: now, startedAt: now, endedAt: null,
    };
    store.writeStory(storyId, story);
    const ledgerMilestones = [{
      id: 'M1', sourceRequirementId: 'REQ-1', claim: 'auth fix', doneMeans: 'test passes',
      requiredEvidence: [], checklistRefs: ['CHK-001'], verificationIntentRefs: ['CHK-001:happy:0'], status: 'planned' as const,
    }];
    const ledger: MilestoneLedgerData = {
      schemaVersion: 'proofstory.milestone_ledger.v1', storyId, state: 'confirmed',
      ledgerHash: computeMilestoneLedgerHash(ledgerMilestones),
      milestones: ledgerMilestones,
      createdAt: now, updatedAt: now,
    };
    store.writeMilestoneLedger(storyId, ledger);

    // expectedRedTargets for this story includes M1 and CHK-001:happy:0.
    const expected = resolveExpectedRedTargets(proofStoryDiagnosticInput(store, storyId, root));
    assert.equal(expected.has('M1'), true, 'M1 is an expected RED target for the story');

    // Capture the red-evidence gate verdict BEFORE any binding write.
    const before = JSON.stringify(evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence);
    assert.ok(before.length > 2, 'representative story has a non-empty missingRedEvidence gate verdict to compare against');

    // Out-of-set ref REJECTS (§3.3 membership).
    assert.throws(
      () => bindingSet!({ storyId, acceptanceTargetRef: 'NOT-A-TARGET', adapterId: 'a', testCaseRef: 't', agent: 'proof-or-stop-implementer' }),
      (e: Error) => /not in expectedRedTargets/.test(e.message),
      'an out-of-expectedRedTargets ref is rejected at write time (§3.3)',
    );

    // In-set ref SUCCEEDS.
    const msg: string = bindingSet!({ storyId, acceptanceTargetRef: 'M1', adapterId: 'node-test-runner', testCaseRef: 'test/red/m1.test.ts', agent: 'proof-or-stop-implementer' });
    assert.match(msg, /targetBindingDigest sha256:/);
    const persisted = store.readRedTargetBindings(storyId);
    assert.ok(persisted && persisted.bindings.length === 1 && persisted.bindings[0].acceptanceTargetRef === 'M1');
    // The persisted digest matches CANON over the stripped identity, not the stored entry.
    assert.equal(targetBindingDigest(persisted!.bindings[0]), canonDigest({ acceptanceTargetRef: 'M1', adapterId: 'node-test-runner', testCaseRef: 'test/red/m1.test.ts' }));
    assert.notEqual(canonDigest(persisted!.bindings[0]), targetBindingDigest(persisted!.bindings[0]));

    // Duplicate target REJECTS.
    assert.throws(
      () => bindingSet!({ storyId, acceptanceTargetRef: 'M1', adapterId: 'other', testCaseRef: 'test/red/other.test.ts', agent: 'proof-or-stop-implementer' }),
      (e: Error) => e instanceof RedTargetBindingDuplicateError || /duplicate target binding/.test(e.message),
      'a second binding for the same acceptanceTargetRef is rejected (§1.1.3)',
    );

    // NO gate verdict change: missingRedEvidence is IDENTICAL after the binding write.
    const after = JSON.stringify(evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence);
    assert.equal(after, before, 'redEvidenceSatisfied/missingRedEvidence gate verdict is UNCHANGED by a binding write (CHK-009)');
  }

  // === 7. The three pre-existing mechanical contracts still pass =============
  function runContract(label: string, cmd: string, args: string[]): void {
    const r = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(r.status, 0, `${label} must pass (exit 0); status=${r.status}\n${r.stdout}\n${r.stderr}`);
  }
  const canonicalCore = process.argv.includes('--canonical-core');
  if (!canonicalCore) {
    runContract('lifecycle-registry-contract', 'node', [join(pkgRoot, 'dist', 'tasks', 'lifecycle-registry-contract.js')]);
    runContract('command-ownership-contract', 'node', [join(pkgRoot, 'dist', 'tasks', 'command-ownership-contract.js')]);
  }
  runContract('verify-process-fact-contract', 'node', [join(repoRoot, 'scripts', 'verify-process-fact-contract.mjs')]);

  console.log('red-evidence-target-binding-smoke: OK — store uniqueness, createdAt-strip digest both directions, expectedRedTargets same-set + case-sensitive membership, committed-tree anti-swap reader, owner-lease/foreign-lease + mutation-authority rejection, STALE-lease reject-without/recover-with --takeover then registered-handler bind, and NO gate verdict change; ' + (canonicalCore ? 'canonical core and process-fact contract pass; registry contracts scheduled independently.' : 'all three registry contracts pass.'));
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
