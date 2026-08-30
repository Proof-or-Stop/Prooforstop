#!/usr/bin/env node
/**
 * RED artifact (W2c / B-506e, F-009 codex host-B D3) — the §1.1.3 binding FREEZE
 * read+write is SERIALIZED with chain appends, so a concurrent recover cannot
 * bypass the freeze.
 *
 * Pre-fix, `red_evidence_binding_set` read the chain head and wrote the binding
 * under `withBindingLock` (a red-target-bindings lock), while chain appends
 * (`red_evidence_quarantine` / `red_evidence_recover`) serialize under a DIFFERENT
 * per-(story,target) chain lock. The two locks are disjoint, so a concurrent
 * recover could reinstate an unquarantined run record BETWEEN binding_set's
 * freeze READ (which saw a quarantine head → "unfrozen") and its WRITE — the
 * binding landed on a chain that was frozen by the time it was written. That
 * freeze bypass IS the RED signal.
 *
 * Part 1 is a DETERMINISTIC bypass repro (not a timing lottery): a holder child
 * takes the chain lock, and while holding it reinstates the run record — exactly
 * the state a concurrent recover produces. The parent then calls binding_set.
 *   - WITH the fix: binding_set blocks on the SAME chain lock, so it observes the
 *     reinstated run head and REJECTS as FROZEN.
 *   - WITHOUT the fix: binding_set never takes the chain lock, reads the stale
 *     quarantine head, and WRITES the binding — the freeze is bypassed.
 * Part 2 is a genuine 2-process race with the REAL commands, asserting the store
 * is left in a serializable state (never a torn/forked chain).
 */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const DIST = join(pkgRoot, 'dist');

const { StoryStore } = await import(`${DIST}/core/store.js`);
const { createMainRegistry } = await import(`${DIST}/registry.js`);
const { computeMilestoneLedgerHash } = await import(`${DIST}/core/proofstory.js`);
const {
  RED_EVIDENCE_V2_SCHEMA_VERSION, computeRecordDigest, computeSpecDigest,
} = await import(`${DIST}/core/red-evidence/record-v2.js`);
const { controlOperationKey, redAssertOperationKey, deriveRecordId } = await import(`${DIST}/core/red-evidence/operation-key.js`);
const { partitionChain, resolveChainHead } = await import(`${DIST}/core/red-evidence/chain.js`);
const { redEvidenceChainLockDir } = await import(`${DIST}/core/red-evidence/append.js`);

const NOW = '2026-07-25T00:00:00.000Z';
const TARGET = 'M1';
const roots = [];
function freshRoot(label) { const r = mkdtempSync(join(tmpdir(), `red-w2c-frzrace-${label}-`)); roots.push(r); return r; }

function synthRedAssert(storyId, target) {
  const greenRelation = { targetRef: target, relation: 'same_acceptance' };
  const specDigest = computeSpecDigest(target, greenRelation);
  const operationKey = redAssertOperationKey({ storyId, acceptanceTargetRef: target, baselineHeadHash: 'h', baselineMaterialHash: 'm', specDigest, assertionDigest: 'sha256:a', policyDigest: 'sha256:p' });
  const draft = {
    id: deriveRecordId('red-assert', operationKey, 1), schemaVersion: RED_EVIDENCE_V2_SCHEMA_VERSION, operation: 'red-assert',
    seq: 1, priorRecordDigest: null, supersedes: null, storyId, acceptanceTargetRef: target,
    trigger: 't', observedFailure: 'f', baselineHeadHash: 'h', baselineMaterialHash: 'm', greenRelation,
    assertion: {}, policySnapshot: {}, specDigest, operationKey, runReceipt: {}, createdAt: NOW,
  };
  return { ...draft, recordDigest: computeRecordDigest(draft) };
}

function control(op, storyId, target, seq, prior, supersedes, recoversRecordId, referencedRecordDigest, reason) {
  const operationKey = controlOperationKey({ operation: op, storyId, acceptanceTargetRef: target, recoversRecordId, referencedRecordDigest, reason });
  const draft = {
    id: deriveRecordId(op, operationKey, seq), schemaVersion: RED_EVIDENCE_V2_SCHEMA_VERSION, operation: op,
    seq, priorRecordDigest: prior, supersedes, storyId, acceptanceTargetRef: target,
    recoversRecordId, referencedRecordDigest, linkKind: op === 'quarantine' ? 'quarantines' : 'recovers',
    reason, approvedBy: 'proof-or-stop-implementer@sess-test', operationKey, createdAt: NOW,
  };
  return { ...draft, recordDigest: computeRecordDigest(draft) };
}

function seedStory(root, storyId) {
  const store = new StoryStore(root);
  store.writeStory(storyId, { storyId, name: 'fr', title: 'W2c freeze race', description: 'auth security regression behavior change', type: 'bug', phase: 'DEV', priority: 'high', createdAt: NOW, startedAt: NOW, endedAt: null });
  const milestones = [{ id: TARGET, sourceRequirementId: 'REQ-1', claim: 'c', doneMeans: 'd', requiredEvidence: [], checklistRefs: ['CHK-001'], verificationIntentRefs: ['CHK-001:happy:0'], status: 'planned' }];
  store.writeMilestoneLedger(storyId, { schemaVersion: 'proofstory.milestone_ledger.v1', storyId, state: 'confirmed', ledgerHash: computeMilestoneLedgerHash(milestones), milestones, createdAt: NOW, updatedAt: NOW });
  return store;
}

function writeRecords(store, storyId, records) {
  store.writeRedEvidence(storyId, { schemaVersion: 'proofstory.red_evidence.v1', storyId, records, createdAt: NOW, updatedAt: NOW });
}

/** Condition-based wait (no fixed sleeps): poll until `pred()` or the deadline. */
async function waitFor(pred, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

try {
  // ══════════════════════════════════════════════════════════════════════════
  // Part 1 — DETERMINISTIC freeze-bypass repro.
  // ══════════════════════════════════════════════════════════════════════════
  {
    const storyId = 'B-frz';
    const root = freshRoot('det');
    const store = seedStory(root, storyId);

    // Chain: red-assert (seq 1) -> quarantine (seq 2, head). A quarantine head
    // means the binding is currently UNFROZEN (settable).
    const ra = synthRedAssert(storyId, TARGET);
    const q = control('quarantine', storyId, TARGET, 2, ra.recordDigest, ra.id, ra.id, ra.recordDigest, 'retire');
    writeRecords(store, storyId, [ra, q]);
    assert.equal(resolveChainHead(partitionChain(store.readRedEvidence(storyId).records, storyId, TARGET)).operation, 'quarantine',
      'precondition: the head is a quarantine, so the binding is UNFROZEN');

    // The recover record a concurrent red_evidence_recover would append (seq 3),
    // reinstating the run record and RE-FREEZING the binding.
    const rec = control('recover', storyId, TARGET, 3, q.recordDigest, q.id, q.id, q.recordDigest, 'undo');

    const lockDir = redEvidenceChainLockDir(store, storyId, TARGET);
    const heldMarker = join(root, 'HELD');
    const doneMarker = join(root, 'DONE');
    const holder = join(root, 'holder.mjs');
    // The holder takes the CHAIN lock and, while holding it, writes the
    // reinstated (recover-head) state — precisely the mutation a concurrent
    // recover performs under that same lock. It then releases.
    writeFileSync(holder, [
      `import { writeFileSync } from 'node:fs';`,
      `import { acquireMkdirLock } from ${JSON.stringify(join(DIST, 'core', 'mkdir-lock.js'))};`,
      `import { StoryStore } from ${JSON.stringify(join(DIST, 'core', 'store.js'))};`,
      `const lock = acquireMkdirLock(${JSON.stringify(lockDir)}, { label: 'test holder' });`,
      `writeFileSync(${JSON.stringify(heldMarker)}, 'held');`,
      `const store = new StoryStore(${JSON.stringify(root)});`,
      `const records = ${JSON.stringify([ra, q, rec])};`,
      `setTimeout(() => {`,
      `  store.writeRedEvidence(${JSON.stringify(storyId)}, { schemaVersion: 'proofstory.red_evidence.v1', storyId: ${JSON.stringify(storyId)}, records, createdAt: ${JSON.stringify(NOW)}, updatedAt: ${JSON.stringify(NOW)} });`,
      `  writeFileSync(${JSON.stringify(doneMarker)}, 'done');`,
      `  lock.release();`,
      `  process.exit(0);`,
      `}, 1200);`,
      ``,
    ].join('\n'));

    const child = spawn(process.execPath, [holder], { stdio: 'ignore' });
    const childExit = new Promise((resolve) => child.on('close', resolve));
    await waitFor(() => existsSync(heldMarker), 'the holder to acquire the chain lock');

    // The store still shows the quarantine head at this instant — a binding_set
    // that does NOT serialize with chain appends would read "unfrozen" here.
    assert.equal(resolveChainHead(partitionChain(store.readRedEvidence(storyId).records, storyId, TARGET)).operation, 'quarantine',
      'while the lock is held (pre-mutation) the visible head is still the quarantine');
    assert.equal(existsSync(doneMarker), false, 'the reinstating write has NOT happened yet');

    const registry = createMainRegistry({ store, root, scanRoot: root });
    const bindingSet = registry.get('red_evidence_binding_set');
    assert.ok(bindingSet, 'red_evidence_binding_set is registered');

    let bindingError;
    try {
      bindingSet({ storyId, acceptanceTargetRef: TARGET, adapterId: 'node-test@1', testCaseRef: 'node-test:a#b', agent: 'proof-or-stop-implementer' });
    } catch (e) {
      bindingError = e;
    }
    await childExit;

    // The binding_set must have BLOCKED on the chain lock (so it ran only after
    // the reinstating write) and therefore observed the FROZEN run head.
    assert.ok(existsSync(doneMarker), 'the holder completed its reinstating write');
    assert.ok(bindingError, 'binding_set MUST NOT succeed: a concurrent recover reinstated the run record, so the binding is FROZEN (freeze bypass otherwise)');
    assert.match(String(bindingError.message), /FROZEN/,
      `binding_set must reject as FROZEN after re-reading the reinstated run head; got: ${bindingError.message}`);

    // And nothing was bound.
    const bindings = store.readRedTargetBindings(storyId);
    const bound = (bindings?.bindings ?? []).some((b) => b.acceptanceTargetRef === TARGET);
    assert.equal(bound, false, 'no binding was written for the target on the frozen chain');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Part 2 — genuine 2-process race with the REAL commands: whichever order the
  // OS picks, the result is one of the two SERIAL outcomes and the chain is
  // never torn/forked.
  // ══════════════════════════════════════════════════════════════════════════
  {
    const storyId = 'B-frz2';
    const root = freshRoot('race');
    const store = seedStory(root, storyId);
    const ra = synthRedAssert(storyId, TARGET);
    const q = control('quarantine', storyId, TARGET, 2, ra.recordDigest, ra.id, ra.id, ra.recordDigest, 'retire');
    writeRecords(store, storyId, [ra, q]);

    const mkWorker = (name, body) => {
      const p = join(root, name);
      writeFileSync(p, [
        `import { StoryStore } from ${JSON.stringify(join(DIST, 'core', 'store.js'))};`,
        `import { createMainRegistry } from ${JSON.stringify(join(DIST, 'registry.js'))};`,
        `const root = ${JSON.stringify(root)};`,
        `const store = new StoryStore(root);`,
        `const registry = createMainRegistry({ store, root, scanRoot: root });`,
        `try { ${body} process.exit(0); }`,
        `catch (e) { process.stderr.write(String(e && e.message || e)); process.exit(3); }`,
        ``,
      ].join('\n'));
      return p;
    };
    const bindWorker = mkWorker('bind.mjs',
      `registry.get('red_evidence_binding_set')({ storyId: ${JSON.stringify(storyId)}, acceptanceTargetRef: ${JSON.stringify(TARGET)}, adapterId: 'node-test@1', testCaseRef: 'node-test:a#b', agent: 'proof-or-stop-implementer' });`);
    const recoverWorker = mkWorker('rec.mjs',
      `registry.get('red_evidence_recover')({ storyId: ${JSON.stringify(storyId)}, recordId: ${JSON.stringify(q.id)}, reason: 'undo', agent: 'proof-or-stop-implementer' });`);

    const run = (p) => new Promise((resolve) => {
      const c = spawn(process.execPath, [p], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      c.stderr.on('data', (d) => { err += d; });
      c.on('close', (code) => resolve({ code: code === null ? -1 : code, err }));
    });
    const [bindRes, recRes] = await Promise.all([run(bindWorker), run(recoverWorker)]);

    const records = store.readRedEvidence(storyId).records;
    const chain = partitionChain(records, storyId, TARGET);
    assert.equal(recRes.code, 0, `the recover must succeed (it only contends on the chain lock): ${recRes.err}`);
    assert.equal(records.length, 3, `exactly one recover record was appended (got ${records.length} records)`);
    assert.ok(resolveChainHead(chain), 'the chain head is UNIQUE after the race (never forked)');
    assert.equal(resolveChainHead(chain).operation, 'recover', 'the recover is the resolved head');

    const bindings = store.readRedTargetBindings(storyId);
    const bound = (bindings?.bindings ?? []).some((b) => b.acceptanceTargetRef === TARGET);
    // Exactly the two serial outcomes are admissible; a third (bound AND
    // rejected, or unbound AND exit 0) would mean a non-serializable interleave.
    if (bindRes.code === 0) {
      assert.ok(bound, 'binding_set reported success, so it ran BEFORE the recover and the binding IS recorded (serial order: bind -> recover)');
    } else {
      assert.match(bindRes.err, /FROZEN/, `binding_set failed, so it ran AFTER the recover and must report FROZEN; got: ${bindRes.err}`);
      assert.equal(bound, false, 'a FROZEN rejection writes no binding (serial order: recover -> bind)');
    }
  }

  console.log('red-w2c-binding-freeze-race: OK (binding_set serializes its §1.1.3 freeze read+write with chain appends under the SAME per-(story,target) chain lock — a concurrent recover reinstating the run record can no longer land between the freeze read and the binding write; deterministic bypass repro rejects as FROZEN with nothing bound, and the 2-process race leaves exactly one of the two serial outcomes with a unique head)');
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
