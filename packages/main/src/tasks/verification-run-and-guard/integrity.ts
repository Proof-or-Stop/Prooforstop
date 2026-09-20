// Verification capability implementation; shared state is imported explicitly.
import { strict as assert } from 'node:assert';

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { refreshStaleEvidenceMetadataOnly } from '../../handlers/checklist.js';

import type { VerificationReceiptBundleV5 } from '../../core/types.js';
import { prepareVerificationExecutionIdentity, validateVerificationReceipt } from '../../core/verification-execution-evidence.js';
import { computeCanonicalDigest, listArtifacts } from '../../core/evidence/artifact-store.js';

import { runSingleAllowlistedCommand } from '../../core/validation-executor.js';

import { verificationReuseCapsuleEnforcementSupported } from '../../core/verification-reuse-capsule.js';
import {
  canonicalDigest as signingCanonicalDigest,
  generateEd25519KeyPair,
  signCanonical,
} from '../../core/authority-signing.js';
import { makeEnv, intent, write, writeCapsuleManifest, git, capsuleCommand, seedPinnedReceipt, findEvidence, cleanup, SELECTOR, splitReceipt, commitRefreshDrift, reusableReceipt, PASS_CMD, expectRejection, sha256Hex, gateCoverage, gateDiagnostic, verificationFreshnessHashBinding, doneIdentityPreview, evidenceContext, collectRepairChecks } from './support.js';

export async function partG(): Promise<void> {
  // Two REAL concurrent handler calls contend on one execution identity. The
  // waiter rereads the publisher's checklist state inside the producer lock.
  {
    const env = makeEnv('B-aa5f-concurrent-refresh', [
      intent('INT-CONCURRENT-A', 'cli'),
      intent('INT-CONCURRENT-B', 'cli'),
    ]);
    try {
      const input = 'packages/main/src/concurrent-input.txt';
      const manifest = 'packages/main/concurrent.verification-dependencies.json';
      write(env.root, input, 'CONCURRENT_A seed\nCONCURRENT_B seed\n');
      writeCapsuleManifest(env.root, manifest, [input]);
      git(env.root, ['add', input, manifest]);
      git(env.root, ['commit', '-m', 'add concurrent verifier closure']);
      const command = capsuleCommand(env.root, manifest, [input]);
      await seedPinnedReceipt(env, { intentRef: 'INT-CONCURRENT-A', command, selector: 'CONCURRENT_A', file: manifest });
      await seedPinnedReceipt(env, { intentRef: 'INT-CONCURRENT-B', command, selector: 'CONCURRENT_B', file: manifest });
      write(env.root, input, 'CONCURRENT_A current\nCONCURRENT_B current\n');
      git(env.root, ['add', input]);
      git(env.root, ['commit', '-m', 'change concurrent verifier input']);
      env.launchCounter.count = 0;
      const results = await Promise.all([
        env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId }),
        env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId }),
      ]);
      assert.equal(results.length, 2, 'G1: both concurrent handler calls complete');
      const receiptsValid = [
        ['INT-CONCURRENT-A', 'CONCURRENT_A'],
        ['INT-CONCURRENT-B', 'CONCURRENT_B'],
      ].filter(([intentRef, selector]) => {
        const receipt = findEvidence(env, intentRef)?.receipt;
        return Boolean(receipt && validateVerificationReceipt(env.root, receipt, {
          intentRef, selector, storyId: env.storyId,
        }).ok);
      }).length;
      assert.equal(env.launchCounter.count, 1, 'G1: producer lock permits exactly one subprocess');
      assert.equal(receiptsValid, 2, 'G1: both independent assertions consume valid immutable evidence');
      console.log(`concurrentRefreshCalls=2 subprocessExecutionCount=${env.launchCounter.count} receiptsValid=${receiptsValid}`);
    } finally { cleanup(env); }
  }

  // Every producer entrypoint shares the same selector-free key. These are real
  // overlapping handler calls, not receipt-derived lock proxies.
  {
    const slowCommand = `node -e "setTimeout(() => console.log('MARKER_OK'), 100)"`;
    const env = makeEnv('B-aa5f-concurrent-add', [intent('INT-ADD', 'cli')]);
    try {
      const add = () => env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-ADD', kind: 'integration_test',
        command: slowCommand, selector: SELECTOR, result: 'pass', note: 'concurrent add publication',
      });
      await Promise.all([add(), add()]);
      assert.equal(env.launchCounter.count, 1, 'G1b: add/add overlap launches one subprocess');
      assert.equal(validateVerificationReceipt(env.root, splitReceipt(env, 'INT-ADD'), {
        intentRef: 'INT-ADD', selector: SELECTOR, storyId: env.storyId,
      }).ok, true, 'G1b: add/add waiter consumes valid evidence');
    } finally { cleanup(env); }
  }
  {
    const slowCommand = `node -e "setTimeout(() => console.log('MARKER_OK'), 100)"`;
    const env = makeEnv('B-aa5f-concurrent-run', [intent('INT-RUN', 'cli', { command: slowCommand, selector: SELECTOR })]);
    try {
      await Promise.all([
        env.handlers.verification_run({ storyId: env.storyId, intentRef: 'INT-RUN' }),
        env.handlers.verification_run({ storyId: env.storyId, intentRef: 'INT-RUN' }),
      ]);
      assert.equal(env.launchCounter.count, 1, 'G1c: run/run overlap launches one subprocess');
      assert.equal(validateVerificationReceipt(env.root, splitReceipt(env, 'INT-RUN'), {
        intentRef: 'INT-RUN', selector: SELECTOR, storyId: env.storyId,
      }).ok, true, 'G1c: run/run waiter consumes valid evidence');
    } finally { cleanup(env); }
  }
  {
    const command = `node -e "setTimeout(() => console.log('CROSS_A\\nCROSS_B'), 100)"`;
    const env = makeEnv('B-aa5f-cross-intent-add-run', [
      intent('INT-A', 'cli'),
      intent('INT-B', 'cli', { command, selector: 'CROSS_B' }),
    ]);
    try {
      await Promise.all([
        env.handlers.verification_evidence_add({
          storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A', kind: 'integration_test',
          command, selector: 'CROSS_A', result: 'pass', note: 'cross-intent add producer',
        }),
        env.handlers.verification_run({ storyId: env.storyId, intentRef: 'INT-B', note: 'cross-intent run waiter' }),
      ]);
      const receiptA = splitReceipt(env, 'INT-A');
      const receiptB = splitReceipt(env, 'INT-B');
      assert.equal(env.launchCounter.count, 1, 'G1d: add(A)/run(B) same identity launches exactly once');
      assert.equal(receiptA.executionReceipt.executionReceiptDigest, receiptB.executionReceipt.executionReceiptDigest,
        'G1d: cross-intent waiter shares only the immutable execution receipt');
      assert.notEqual(receiptA.assertionReceipt.assertionReceiptDigest, receiptB.assertionReceipt.assertionReceiptDigest,
        'G1d: each selector receives an independently signed assertion');
      assert.equal(validateVerificationReceipt(env.root, receiptA, {
        intentRef: 'INT-A', selector: 'CROSS_A', storyId: env.storyId,
      }).ok, true, 'G1d: producer assertion validates independently');
      assert.equal(validateVerificationReceipt(env.root, receiptB, {
        intentRef: 'INT-B', selector: 'CROSS_B', storyId: env.storyId,
      }).ok, true, 'G1d: waiter assertion validates independently');
      console.log('crossIntent addRun launches=1 sharedExecution=true independentAssertions=true');
    } finally { cleanup(env); }
  }
  {
    const blockerCommand = `node -e "setTimeout(() => console.log('REUSE_LOCK_BLOCKER'), 100)"`;
    let releaseBlocker!: () => void;
    let reportBlockerHeld!: () => void;
    let holdBlocker = false;
    const blockerRelease = new Promise<void>(resolveRelease => { releaseBlocker = resolveRelease; });
    const blockerHeld = new Promise<void>(resolveHeld => { reportBlockerHeld = resolveHeld; });
    const env = makeEnv('B-aa5f-cross-intent-reused-publication', [
      intent('INT-REUSE-LOCK-BLOCKER', 'cli'),
      intent('INT-REUSE-PUBLISHER', 'cli'),
      intent('INT-REUSE-WAITER', 'cli'),
    ], async command => {
      if (holdBlocker && command === blockerCommand) {
        reportBlockerHeld();
        await blockerRelease;
      }
    });
    try {
      const input = 'packages/main/src/reused-publication-input.txt';
      const manifest = 'packages/main/reused-publication.verification-dependencies.json';
      write(env.root, input, 'REUSE_PUBLISHER\nREUSE_WAITER\n');
      writeCapsuleManifest(env.root, manifest, [input]);
      git(env.root, ['add', input, manifest]);
      git(env.root, ['commit', '-m', 'add reused publication closure']);
      const command = capsuleCommand(env.root, manifest, [input]);
      await seedPinnedReceipt(env, {
        intentRef: 'INT-REUSE-LOCK-BLOCKER', command: blockerCommand, selector: 'REUSE_LOCK_BLOCKER',
      });
      await seedPinnedReceipt(env, {
        intentRef: 'INT-REUSE-PUBLISHER', command, selector: 'REUSE_PUBLISHER', file: manifest,
      });
      await seedPinnedReceipt(env, {
        intentRef: 'INT-REUSE-WAITER', command, selector: 'REUSE_WAITER', file: manifest,
      });
      // Keep the waiter's immutable pin and manifest provenance, but remove its
      // receipt and mark the row failed so only the other intent is a stale-refresh
      // publisher while both calls contend on the same execution identity.
      const checklist = env.store.readChecklist(env.storyId);
      const waiterSeed = checklist.items[0].verificationEvidence
        ?.find(evidence => evidence.intentRef === 'INT-REUSE-WAITER');
      assert.ok(waiterSeed, 'G1e: waiter seed evidence exists');
      delete waiterSeed.receipt;
      waiterSeed.mechanical = false;
      waiterSeed.result = 'fail';
      env.store.writeChecklist(env.storyId, checklist);
      commitRefreshDrift(env, 'cross-intent-reused-publication');
      env.launchCounter.count = 0;
      holdBlocker = true;
      const refresh = env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      await blockerHeld;
      const waiterRun = env.handlers.verification_run({
        storyId: env.storyId, intentRef: 'INT-REUSE-WAITER', note: 'consume cross-intent reused publication',
      });
      await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
      releaseBlocker();
      await Promise.all([refresh, waiterRun]);
      const publisher = reusableReceipt(env, 'INT-REUSE-PUBLISHER');
      const waiter = reusableReceipt(env, 'INT-REUSE-WAITER');
      assert.equal(env.launchCounter.count, 1,
        'G1e: only the deliberate lock-holder launches; the reused-publication waiter does not');
      assert.equal(waiter.publicationMode, 'reused',
        'G1e: waiter preserves reused publication mode instead of relabelling it executed');
      assert.equal(waiter.reuseReceiptDigest, publisher.reuseReceiptDigest,
        'G1e: waiter binds the exact signed reuse lineage published under the shared key');
      assert.equal(waiter.executionReceipt.executionReceiptDigest, publisher.executionReceipt.executionReceiptDigest,
        'G1e: waiter shares the publisher immutable execution');
      assert.notEqual(waiter.assertionReceipt.assertionReceiptDigest, publisher.assertionReceipt.assertionReceiptDigest,
        'G1e: waiter still receives an independently signed selector assertion');
      assert.equal(validateVerificationReceipt(env.root, waiter, {
        intentRef: 'INT-REUSE-WAITER', selector: 'REUSE_WAITER', storyId: env.storyId,
      }).ok, true, 'G1e: cross-intent reused publication validates with intact lineage');
      console.log('crossIntent reusedPublication waiterLaunches=0 lineage=preserved');
    } finally { cleanup(env); }
  }
  {
    const command = `node -e "console.log('BATCH_A\\nBATCH_B')"`;
    const env = makeEnv('B-aa5f-batch-fanout-lock', [intent('INT-BATCH-A', 'cli'), intent('INT-BATCH-B', 'cli')]);
    try {
      await env.handlers.verification_evidence_batch_add({ storyId: env.storyId, evidences: [
        { itemId: 'CHK-001', intentRef: 'INT-BATCH-A', kind: 'integration_test', command, selector: 'BATCH_A', result: 'pass', note: 'batch fanout A' },
        { itemId: 'CHK-001', intentRef: 'INT-BATCH-B', kind: 'integration_test', command, selector: 'BATCH_B', result: 'pass', note: 'batch fanout B' },
      ] });
      assert.equal(env.launchCounter.count, 1, 'G1d: same-key batch fans out one subprocess');
      assert.equal(splitReceipt(env, 'INT-BATCH-A').executionReceipt.executionReceiptDigest,
        splitReceipt(env, 'INT-BATCH-B').executionReceipt.executionReceiptDigest,
        'G1d: batch assertions share the immutable execution receipt');
    } finally { cleanup(env); }
  }
  {
    const env = makeEnv('B-aa5f-concurrent-batch-refresh', [intent('INT-CROSS', 'cli')]);
    try {
      const input = 'packages/main/src/cross-input.txt';
      const manifest = 'packages/main/cross.verification-dependencies.json';
      write(env.root, input, 'CROSS_OK seed\n');
      writeCapsuleManifest(env.root, manifest, [input]);
      git(env.root, ['add', input, manifest]);
      git(env.root, ['commit', '-m', 'add cross-entry closure']);
      const command = capsuleCommand(env.root, manifest, [input]);
      await seedPinnedReceipt(env, { intentRef: 'INT-CROSS', command, selector: 'CROSS_OK', file: manifest });
      write(env.root, input, 'CROSS_OK current\n');
      git(env.root, ['add', input]);
      git(env.root, ['commit', '-m', 'change cross-entry closure']);
      env.launchCounter.count = 0;
      await Promise.all([
        env.handlers.verification_evidence_batch_add({ storyId: env.storyId, evidences: [{
          itemId: 'CHK-001', intentRef: 'INT-CROSS', kind: 'integration_test', file: manifest,
          command, selector: 'CROSS_OK', result: 'pass', note: 'cross entry batch publication',
        }] }),
        env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId }),
      ]);
      assert.equal(env.launchCounter.count, 1, 'G1e: batch/refresh overlap launches one subprocess');
      assert.equal(validateVerificationReceipt(env.root, splitReceipt(env, 'INT-CROSS'), {
        intentRef: 'INT-CROSS', selector: 'CROSS_OK', storyId: env.storyId,
      }).ok, true, 'G1e: batch/refresh consumers observe valid evidence');
      console.log('producer lock matrix addAdd=1 runRun=1 batchRefresh=1 receiptsValid=3');
    } finally { cleanup(env); }
  }

  // The command mutates its declared input only in the refresh run. The launch
  // snapshot and pre-issuance snapshot therefore differ; no artifact or receipt
  // from that run may be accepted.
  {
    let armMutation = false;
    const input = 'packages/main/src/toctou-input.txt';
    const env = makeEnv('B-aa5f-input-changed-during-run', [intent('INT-TOCTOU', 'cli')], (_command, cwd) => {
      if (armMutation) writeFileSync(join(cwd, input), 'CHANGED_DURING_EXECUTION\n');
    });
    try {
      const manifest = 'packages/main/toctou.verification-dependencies.json';
      write(env.root, input, 'MUTABLE_OK SAFE\n');
      writeCapsuleManifest(env.root, manifest, [input]);
      git(env.root, ['add', input, manifest]);
      git(env.root, ['commit', '-m', 'add toctou verifier closure']);
      const command = capsuleCommand(env.root, manifest, [input]);
      await seedPinnedReceipt(env, { intentRef: 'INT-TOCTOU', command, selector: 'MUTABLE_OK', file: manifest });
      const artifactsBefore = listArtifacts(env.root, 'verification-output').length;
      write(env.root, input, 'MUTABLE_OK TRIGGER\n');
      git(env.root, ['add', input]);
      git(env.root, ['commit', '-m', 'arm toctou mutation']);
      armMutation = true;
      const output = await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      assert.match(output, /receiptIssued=false reason=input_changed_during_execution/,
        'G2: input mutation returns the stable fail-closed diagnostic');
      assert.equal(listArtifacts(env.root, 'verification-output').length, artifactsBefore,
        'G2: changed input issues no output artifact');
      assert.equal(findEvidence(env, 'INT-TOCTOU')?.receipt, undefined,
        'G2: changed input issues no execution/assertion/reuse receipt');
      console.log('receiptIssued=false reason=input_changed_during_execution');
    } finally { cleanup(env); }
  }

  // Ordinary evidence writes remain immutable. B-1482's separately authorized
  // narrowing entry point is intentionally outside this write path.
  {
    const env = makeEnv('B-aa5f-selector-compatibility', [intent('INT-SELECTOR', 'cli')]);
    try {
      await seedPinnedReceipt(env, { intentRef: 'INT-SELECTOR', command: PASS_CMD, selector: SELECTOR });
      await expectRejection(env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-SELECTOR', kind: 'integration_test',
        command: PASS_CMD, selector: 'MARKER', result: 'pass', note: 'widen selector',
      }), /receipt_selector_mismatch/, 'G3 widening');
      await expectRejection(env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-SELECTOR', kind: 'integration_test',
        command: PASS_CMD, selector: 'UNPROVED_REPIN', result: 'pass', note: 'substitute selector',
      }), /receipt_selector_mismatch/, 'G3 substitution/unproved repin');
      assert.equal(splitReceipt(env, 'INT-SELECTOR').assertionReceipt.selectorDigest, sha256Hex(SELECTOR),
        'G3: refused transitions leave the original selector receipt immutable');
      console.log('selector compatibility PASS');
    } finally { cleanup(env); }
  }

  // Missing material/Story hashes force execution. A missing input digest makes
  // the receipt invalid and leaves the row demoted; neither path can reuse it.
  {
    const env = makeEnv('B-aa5f-partial-hash-compatibility', [intent('INT-HASH', 'cli')]);
    try {
      const input = 'packages/main/src/hash-input.txt';
      const manifest = 'packages/main/hash.verification-dependencies.json';
      write(env.root, input, 'HASH_OK\n');
      writeCapsuleManifest(env.root, manifest, [input]);
      git(env.root, ['add', input, manifest]);
      git(env.root, ['commit', '-m', 'add hash verifier closure']);
      const command = capsuleCommand(env.root, manifest, [input]);
      await seedPinnedReceipt(env, { intentRef: 'INT-HASH', command, selector: 'HASH_OK', file: manifest });

      let checklist = env.store.readChecklist(env.storyId);
      delete checklist.items[0].verificationEvidence![0].materialHash;
      env.store.writeChecklist(env.storyId, checklist);
      commitRefreshDrift(env, 'missing-material-hash');
      env.launchCounter.count = 0;
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      assert.equal(env.launchCounter.count, 1, 'G4: missing material hash cannot authorize reuse');
      assert.equal(reusableReceipt(env, 'INT-HASH').reuseReceipt, undefined, 'G4: missing material hash minted no reuse receipt');

      checklist = env.store.readChecklist(env.storyId);
      delete checklist.items[0].verificationEvidence![0].storyFilesHash;
      env.store.writeChecklist(env.storyId, checklist);
      commitRefreshDrift(env, 'missing-story-hash');
      env.launchCounter.count = 0;
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      assert.equal(env.launchCounter.count, 1, 'G4: missing Story hash cannot authorize reuse');

      for (const field of ['headHash', 'materialHash', 'storyFilesHash'] as const) {
        checklist = env.store.readChecklist(env.storyId);
        checklist.items[0].verificationEvidence![0][field] = 'f';
        env.store.writeChecklist(env.storyId, checklist);
        env.launchCounter.count = 0;
        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        assert.equal(env.launchCounter.count, 1, `G4: malformed non-empty ${field} cannot authorize reuse`);
        assert.equal(reusableReceipt(env, 'INT-HASH').reuseReceipt, undefined,
          `G4: malformed non-empty ${field} minted no reuse receipt`);
      }

      checklist = env.store.readChecklist(env.storyId);
      const receipt = checklist.items[0].verificationEvidence![0].receipt as VerificationReceiptBundleV5;
      receipt.executionReceipt.evidenceInputDigest = null;
      env.store.writeChecklist(env.storyId, checklist);
      commitRefreshDrift(env, 'missing-input-hash');
      env.launchCounter.count = 0;
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      assert.equal(env.launchCounter.count, 0, 'G4: invalid partial input binding is not promoted or executed as trusted evidence');
      assert.equal(findEvidence(env, 'INT-HASH')?.receipt, undefined, 'G4: partial input receipt remains fail-closed/demoted');
      console.log('partial-hash PASS');
    } finally { cleanup(env); }
  }
}

export async function partH(): Promise<void> {
  // Fresh real execution without a complete manifest is admissible only via
  // strict Story/material freshness. The same gate rejects prose, legacy, and
  // caller-shaped records even when they claim PASS-shaped fields.
  {
    const env = makeEnv('B-aa5f-lifecycle-strict-fallback', [
      intent('INT-GATE', 'cli', { command: PASS_CMD, selector: SELECTOR }),
    ]);
    try {
      await env.handlers.verification_run({ storyId: env.storyId, intentRef: 'INT-GATE', note: 'gate baseline' });
      assert.equal(gateCoverage(env).missingRequired, 0,
        'H1: a validated fresh real execution remains admissible under strict fallback');

      const baseline = env.store.readChecklist(env.storyId);
      const narrative = structuredClone(baseline);
      narrative.items[0].verificationEvidence![0] = {
        ...narrative.items[0].verificationEvidence![0],
        mechanical: undefined,
        receipt: undefined,
        result: 'pass',
        note: 'PASS narrative only',
      };
      assert.match(gateDiagnostic(env, narrative), /verification_receipt_missing/,
        'H1: narrative PASS cannot satisfy an executable lifecycle gate');

      const legacy = structuredClone(baseline);
      legacy.items[0].verificationEvidence![0].receipt = {
        exitCode: 0,
        outputDigest: sha256Hex('MARKER_OK\n'),
        outputTail: 'MARKER_OK\n',
        selectorMatched: true,
        executedAt: '2026-09-03T00:00:00.000Z',
      };
      assert.match(gateDiagnostic(env, legacy), /verification_receipt_legacy/,
        'H1: legacy combined receipt remains readable but cannot satisfy lifecycle admission');

      const callerShaped = structuredClone(baseline);
      callerShaped.items[0].verificationEvidence![0].receipt = {
        schemaVersion: 'proof-or-stop.verification-receipt-bundle.v4',
        exitCode: 0,
        selectorMatched: true,
      } as any;
      assert.match(gateDiagnostic(env, callerShaped), /verification_receipt_invalid/,
        'H1: caller-authored receipt-shaped object fails closed with a stable diagnostic');

      const partialHash = structuredClone(baseline);
      delete partialHash.items[0].verificationEvidence![0].storyFilesHash;
      assert.match(gateDiagnostic(env, partialHash), /verification_receipt_stale/,
        'H1: partial freshness hashes cannot satisfy strict fallback');
      for (const field of ['headHash', 'materialHash', 'storyFilesHash'] as const) {
        const malformedHash = structuredClone(baseline);
        malformedHash.items[0].verificationEvidence![0][field] = 'f';
        assert.match(gateDiagnostic(env, malformedHash), /verification_receipt_stale/,
          `H1: malformed non-empty ${field} cannot satisfy lifecycle admission`);
      }

      // F-001: change material on main, then merge it. The Story-owned hash is
      // unchanged, so the generic advisory path would accept this; strict
      // fallback must instead reject and execute the untrusted verifier once.
      git(env.root, ['checkout', 'main']);
      write(env.root, 'packages/main/src/base.ts', 'export const base = "changed-on-main";\n');
      git(env.root, ['add', 'packages/main/src/base.ts']);
      git(env.root, ['commit', '-m', 'material drift outside story diff']);
      git(env.root, ['checkout', 'work']);
      git(env.root, ['merge', '--no-edit', 'main']);
      env.launchCounter.count = 0;
      assert.ok(gateCoverage(env).missingRequired > 0,
        'H1: untrusted closure is stale when material changes even if storyFilesHash stays equal');
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      assert.equal(env.launchCounter.count, 1,
        'H1: strict material drift with equal Story hash reruns the verifier exactly once');
      assert.equal(gateCoverage(env).missingRequired, 0,
        'H1: the new strict execution becomes admissible at current material');
    } finally { cleanup(env); }
  }

  // Complete closure: gates recompute the current input identity and validate
  // artifact/execution/assertion/reuse integrity rather than trusting fields.
  {
    const env = makeEnv('B-aa5f-lifecycle-complete', [intent('INT-COMPLETE', 'cli')]);
    try {
      const input = 'packages/main/src/gate-input.txt';
      const manifest = 'packages/main/gate.verification-dependencies.json';
      write(env.root, input, 'GATE_OK\n');
      writeCapsuleManifest(env.root, manifest, [input]);
      git(env.root, ['add', input, manifest]);
      git(env.root, ['commit', '-m', 'add gate verifier closure']);
      const command = capsuleCommand(env.root, manifest, [input]);
      await seedPinnedReceipt(env, { intentRef: 'INT-COMPLETE', command, selector: 'GATE_OK', file: manifest });
      assert.equal(gateCoverage(env).missingRequired, 0, 'H2: valid V5 bundle with V3 execution and V2 assertion satisfies gate');
      const executedBaseline = structuredClone(reusableReceipt(env, 'INT-COMPLETE'));

      const recomputedGraph = structuredClone(executedBaseline) as any;
      recomputedGraph.executionReceipt.durationMs += 1;
      const { executionReceiptDigest: _executionDigest, authenticity: _executionAuth, ...executionSubject } = recomputedGraph.executionReceipt;
      recomputedGraph.executionReceipt.executionReceiptDigest = computeCanonicalDigest(executionSubject);
      recomputedGraph.assertionReceipt.executionReceiptDigest = recomputedGraph.executionReceipt.executionReceiptDigest;
      const { assertionReceiptDigest: _assertionDigest, authenticity: _assertionAuth, ...assertionSubject } = recomputedGraph.assertionReceipt;
      recomputedGraph.assertionReceipt.assertionReceiptDigest = computeCanonicalDigest(assertionSubject);
      recomputedGraph.bundleBinding.executionReceiptDigest = recomputedGraph.executionReceipt.executionReceiptDigest;
      recomputedGraph.bundleBinding.assertionReceiptDigest = recomputedGraph.assertionReceipt.assertionReceiptDigest;
      recomputedGraph.bundleReceiptDigest = computeCanonicalDigest(recomputedGraph.bundleBinding);
      const recomputedChecklist = env.store.readChecklist(env.storyId);
      recomputedChecklist.items[0].verificationEvidence![0].receipt = recomputedGraph;
      assert.match(gateDiagnostic(env, recomputedChecklist), /verification_receipt_invalid/,
        'H2: recomputing every canonical graph digest cannot forge the trusted execution/assertion signatures');

      const attacker = generateEd25519KeyPair();
      const keySwap = structuredClone(executedBaseline) as any;
      for (const [domain, record] of [
        ['execution', keySwap.executionReceipt],
        ['assertion', keySwap.assertionReceipt],
      ] as const) {
        const { authenticity: _trustedAuthenticity, ...signedRecord } = record;
        record.authenticity = {
          schemaVersion: 'proof-or-stop.verification-record-authenticity.v1',
          domain,
          keyId: `sha256:${signingCanonicalDigest(attacker.publicKey)}`,
          signerPublicKey: attacker.publicKey,
          signature: signCanonical({
            schemaVersion: 'proof-or-stop.verification-record.v1', domain, record: signedRecord,
          }, attacker.privateKey),
        };
      }
      const keySwapChecklist = env.store.readChecklist(env.storyId);
      keySwapChecklist.items[0].verificationEvidence![0].receipt = keySwap;
      assert.match(gateDiagnostic(env, keySwapChecklist), /verification_receipt_invalid/,
        'H2: a self-consistent attacker key swap cannot replace the git-common-dir trusted signer');

      const receipt = reusableReceipt(env, 'INT-COMPLETE');
      const objectPath = join(env.root, '.proof-or-stop', 'evidence', 'objects', 'sha256', `${receipt.executionReceipt.outputArtifact.artifactDigest}.json`);
      const originalObject = readFileSync(objectPath, 'utf8');
      const tamperedObject = JSON.parse(originalObject) as { payload: { output: string } };
      tamperedObject.payload.output = 'FORGED_GATE_OK\n';
      writeFileSync(objectPath, `${JSON.stringify(tamperedObject, null, 2)}\n`);
      assert.match(gateDiagnostic(env, env.store.readChecklist(env.storyId)), /verification_receipt_invalid/,
        'H2: lifecycle gate rejects tampered full-output artifact');
      writeFileSync(objectPath, originalObject);

      const assertionTamper = env.store.readChecklist(env.storyId);
      (assertionTamper.items[0].verificationEvidence![0].receipt as VerificationReceiptBundleV5)
        .assertionReceipt.matched = false;
      assert.match(gateDiagnostic(env, assertionTamper), /verification_receipt_invalid/,
        'H2: lifecycle gate rejects tampered assertion receipt');

      const executionTamper = env.store.readChecklist(env.storyId);
      (executionTamper.items[0].verificationEvidence![0].receipt as VerificationReceiptBundleV5)
        .executionReceipt.durationMs += 1;
      assert.match(gateDiagnostic(env, executionTamper), /verification_receipt_invalid/,
        'H2: lifecycle gate rejects tampered execution receipt');

      const receiptTailMismatch = env.store.readChecklist(env.storyId);
      const tailReceipt = receiptTailMismatch.items[0].verificationEvidence![0].receipt as VerificationReceiptBundleV5;
      assert.equal(validateVerificationReceipt(env.root, tailReceipt, {
        intentRef: 'INT-COMPLETE', selector: 'GATE_OK', storyId: env.storyId,
      }).ok, true, 'H2: the current receipt is valid before changing only its display summary');
      tailReceipt.outputTail += 'UNRECORDED_DISPLAY_SUMMARY\n';
      const tailValidation = validateVerificationReceipt(env.root, tailReceipt, {
        intentRef: 'INT-COMPLETE', selector: 'GATE_OK', storyId: env.storyId,
      });
      assert.equal(tailValidation.ok, false, 'H2: authoritative validator rejects a top-level outputTail mismatch');
      assert.ok(tailValidation.errors.includes('receipt outputTail compatibility mismatch'),
        'H2: display summary must equal the canonical tail of complete authenticated output');
      assert.match(gateDiagnostic(env, receiptTailMismatch), /verification_receipt_invalid/,
        'H2: lifecycle gate rejects the top-level outputTail mismatch');

      const receiptSelectorTamper = env.store.readChecklist(env.storyId);
      const tamperedSelectorReceipt = receiptSelectorTamper.items[0].verificationEvidence![0]
        .receipt as VerificationReceiptBundleV5;
      tamperedSelectorReceipt.selector = 'FORGED_SELECTOR_NEVER_EXECUTED';
      env.store.writeChecklist(env.storyId, receiptSelectorTamper);
      const persistedSelectorTamper = reusableReceipt(env, 'INT-COMPLETE');
      const selectorValidation = validateVerificationReceipt(env.root, persistedSelectorTamper, {
        intentRef: 'INT-COMPLETE', selector: 'GATE_OK', storyId: env.storyId,
      });
      assert.equal(selectorValidation.ok, false,
        'H2: authoritative validator rejects a persisted top-level selector-only tamper');
      assert.ok(selectorValidation.errors.includes('receipt selector compatibility digest mismatch'),
        'H2: selector projection is bound to the independently signed assertion selector digest');
      assert.match(gateDiagnostic(env, env.store.readChecklist(env.storyId)), /verification_receipt_invalid/,
        'H2: lifecycle gate rejects the persisted top-level selector-only tamper');
      const restoredSelectorReceipt = env.store.readChecklist(env.storyId);
      restoredSelectorReceipt.items[0].verificationEvidence![0].receipt = structuredClone(executedBaseline);
      env.store.writeChecklist(env.storyId, restoredSelectorReceipt);

      const malformedDigest = env.store.readChecklist(env.storyId);
      (malformedDigest.items[0].verificationEvidence![0].receipt as VerificationReceiptBundleV5)
        .executionReceipt.environmentDigest = 'f';
      assert.match(gateDiagnostic(env, malformedDigest), /verification_receipt_invalid/,
        'H2: lifecycle gate rejects malformed non-empty receipt digests');

      const selectorTamper = env.store.readChecklist(env.storyId);
      selectorTamper.items[0].verificationIntent!.happy![0].verification!.selector = 'FORGED_SELECTOR';
      assert.match(gateDiagnostic(env, selectorTamper), /verification_receipt_invalid/,
        'H2: lifecycle gate rejects selector substitution');

      write(env.root, 'packages/main/src/unrelated-gate-drift.ts', 'export const unrelated = true;\n');
      git(env.root, ['add', 'packages/main/src/unrelated-gate-drift.ts']);
      git(env.root, ['commit', '-m', 'unrelated gate drift']);
      env.launchCounter.count = 0;
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      assert.equal(env.launchCounter.count, 0, 'H2: unchanged complete input closure reuses without a subprocess');
      assert.ok(reusableReceipt(env, 'INT-COMPLETE').reuseReceipt, 'H2: refresh publishes an auditable reuse receipt');
      assert.equal(gateCoverage(env).missingRequired, 0, 'H2: valid reuse lineage satisfies lifecycle gate');

      const strippedReuse = env.store.readChecklist(env.storyId);
      delete (strippedReuse.items[0].verificationEvidence![0].receipt as any).reuseReceipt;
      assert.match(gateDiagnostic(env, strippedReuse), /verification_receipt_invalid/,
        'H2: deleting the complete reuseReceipt from a reused publication fails closed');

      const injectedReuse = env.store.readChecklist(env.storyId);
      injectedReuse.items[0].verificationEvidence![0].receipt = structuredClone(executedBaseline);
      (injectedReuse.items[0].verificationEvidence![0].receipt as any).reuseReceipt =
        structuredClone(reusableReceipt(env, 'INT-COMPLETE').reuseReceipt);
      assert.match(gateDiagnostic(env, injectedReuse), /verification_receipt_invalid/,
        'H2: adding reuse lineage to an executed publication fails closed');

      const reuseTamper = env.store.readChecklist(env.storyId);
      (reuseTamper.items[0].verificationEvidence![0].receipt as VerificationReceiptBundleV5)
        .reuseReceipt!.reuseReceiptDigest = '0'.repeat(64);
      assert.match(gateDiagnostic(env, reuseTamper), /verification_receipt_invalid/,
        'H2: lifecycle gate rejects tampered reuse receipt');

      const recomputedReuse = env.store.readChecklist(env.storyId);
      const recomputedBundle = recomputedReuse.items[0].verificationEvidence![0].receipt as VerificationReceiptBundleV5;
      assert.ok(recomputedBundle.reuseReceipt, 'H2: recompute attack requires reused publication');
      recomputedBundle.reuseReceipt.reusedAt = '2099-01-01T00:00:00.000Z';
      const { reuseReceiptDigest: _oldReuseDigest, authenticity: _reuseAuthenticity, ...recomputedSubject } = recomputedBundle.reuseReceipt;
      recomputedBundle.reuseReceipt.reuseReceiptDigest = computeCanonicalDigest(recomputedSubject);
      assert.match(gateDiagnostic(env, recomputedReuse), /verification_receipt_invalid/,
        'H2: recomputing a mutated reuse digest cannot repair assertion/bundle cross-links');

      const modeTamper = env.store.readChecklist(env.storyId);
      (modeTamper.items[0].verificationEvidence![0].receipt as VerificationReceiptBundleV5)
        .assertionReceipt.publicationMode = 'executed';
      assert.match(gateDiagnostic(env, modeTamper), /verification_receipt_invalid/,
        'H2: mutating an assertion publication-mode cross-link fails closed');

      write(env.root, input, 'GATE_CHANGED\n');
      assert.match(gateDiagnostic(env, env.store.readChecklist(env.storyId)), /verification_receipt_stale/,
        'H2: changed declared input invalidates prior execution evidence before refresh');
      env.launchCounter.count = 0;
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      assert.equal(env.launchCounter.count, 1,
        'H2: lost capsule authority is classified stale and forces one real execution even when Git hashes match');
      assert.equal(findEvidence(env, 'INT-COMPLETE')?.receipt, undefined,
        'H2: failed assertion after authority loss is demoted rather than freshness-restamped');
      console.log('lostCapsuleAuthority stale=true executions=1 receiptRestamped=false');
      console.log('receiptSignatures execution=PASS assertion=PASS reuse=PASS graphRecompute=denied keySwap=denied');
      console.log('lifecycle receipt admissibility PASS');
    } finally { cleanup(env); }
  }
}

export async function partLNodePathIdentity(): Promise<void> {
  const external = mkdtempSync(join(tmpdir(), 'baa5f-node-path-'));
  const bin = join(external, 'bin');
  const emptyBin = join(external, 'empty-bin');
  const log = join(external, 'children.jsonl');
  mkdirSync(bin); mkdirSync(emptyBin); writeFileSync(log, '');
  const priorPath = process.env.PATH;
  const fixedPath = `${bin}:${priorPath ?? ''}`;
  const writeWrapper = (name: string, version: string) => {
    const body = `require('fs').appendFileSync(${JSON.stringify(log)},JSON.stringify({tag:${JSON.stringify(name)},pid:process.pid})+'\\n');` +
      `console.log('NODE_PATH_A NODE_PATH_B',${JSON.stringify(version)});`;
    writeFileSync(join(bin, name), `#!${process.execPath}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  writeWrapper('node', 'NODE_CONTROL'); writeWrapper('npm', 'STABLE_CONTROL');
  process.env.PATH = fixedPath;
  const refs = ['NODE-A', 'NODE-B', 'STABLE-A', 'STABLE-B'];
  const env = makeEnv('B-aa5f-node-path', refs.map(ref => intent(ref, 'cli')));
  try {
    write(env.root, '.gitignore', '.proof-or-stop/evidence/\n.proof-or-stop/runtime/\n.proof-or-stop/locks/\n.proof-or-stop/learning/runtime-memory-pack-cache/\n');
    git(env.root, ['add', '.gitignore']); git(env.root, ['commit', '-m', 'ignore node-path fixture runtime']);
    for (let i = 0; i < refs.length; i++) await seedPinnedReceipt(env, {
      intentRef: refs[i], command: i < 2 ? 'node --version' : 'npm --version',
      selector: i % 2 ? 'NODE_PATH_B' : 'NODE_PATH_A',
    });
    const before = env.store.readChecklist(env.storyId);
    const binding = verificationFreshnessHashBinding(env, refs[0]);
    const old = splitReceipt(env, refs[0]);
    const timeoutMs = old.executionReceipt.effectiveTimeoutMs;
    assert.equal(gateCoverage(env).entries.filter(row => row.status === 'covered').length, 4,
      'F078 authentic ordinary unchanged-input controls are current');
    assert.match((await doneIdentityPreview(env)).transcript, /staleEvidenceRefresh: PASS/);
    assert.match(refreshStaleEvidenceMetadataOnly(evidenceContext(env), env.storyId, true), /No stale verification evidence/);
    const normalRun = await runSingleAllowlistedCommand('node --version', env.root, { cwd: env.root, timeoutMs });
    assert.equal(normalRun.code, 0); assert.match(normalRun.output, /NODE_CONTROL/);
    console.log('F078 normal-control authenticV5=true current=true actualOutput=NODE_CONTROL');
    writeWrapper('node', 'NODE_CHANGED');
    const changedRun = await runSingleAllowlistedCommand('node --version', env.root, { cwd: env.root, timeoutMs });
    assert.equal(changedRun.code, 0); assert.match(changedRun.output, /NODE_CHANGED/);
    assert.notEqual(changedRun.output, normalRun.output, 'F078 actual executable-byte change changes real output');
    assert.equal(process.env.PATH, fixedPath, 'F078 PATH string is unchanged across executable-byte drift');
    assert.deepEqual(env.store.readChecklist(env.storyId), before, 'F078 old receipt bytes remain unchanged');
    assert.deepEqual(verificationFreshnessHashBinding(env, refs[0]), binding, 'F078 all Git freshness bindings remain unchanged');
    assert.equal(validateVerificationReceipt(env.root, old, {
      storyId: env.storyId, intentRef: refs[0], selector: 'NODE_PATH_A', command: 'node --version',
    }).ok, true, 'F078 old signed graph retains historical authenticity after live executable drift');
    console.log('F078 drift actualOutput=NODE_CHANGED unchangedPATH=true unchangedGit=true unchangedReceipt=true');

    await collectRepairChecks(async check => {
      await check('F078 actual PATH node executable identity changes', () => {
        const current = prepareVerificationExecutionIdentity({ command: 'node --version', cwd: old.executionReceipt.cwd, effectiveTimeoutMs: timeoutMs });
        assert.notEqual(current.toolchainDigest, old.executionReceipt.toolchainDigest,
          'F078 actual PATH-selected node bytes must change the toolchain identity');
        assert.notEqual(current.executionIdentityDigest, old.executionReceipt.executionIdentityDigest);
        assert.equal(current.environmentDigest, old.executionReceipt.environmentDigest);
      });
      await check('F078 live gate rejects changed node while stable executable stays current', () => {
        const rows = gateCoverage(env).entries;
        assert.deepEqual(rows.map(row => row.status), ['stale', 'stale', 'covered', 'covered']);
      });
      await check('F078 refresh selects changed actual node', () => {
        assert.doesNotMatch(refreshStaleEvidenceMetadataOnly(evidenceContext(env), env.storyId, true), /No stale verification evidence/);
      });
      await check('F078 DONE rejects changed actual node', async () => {
        const preview = await doneIdentityPreview(env);
        assert.equal(preview.blockedAt, 'evidenceFreshness', preview.transcript);
        assert.match(preview.transcript, /staleEvidenceRefresh: BLOCKED/);
        assert.ok(preview.transcript.includes('node --version'));
      });
      writeFileSync(log, ''); env.launchCounter.count = 0;
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      await check('F078 refresh executes affected physical key once for two selectors', () => {
        const children = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { tag: string; pid: number });
        assert.equal(children.length, 1, 'F078 real refresh must execute exactly one affected node child');
        assert.equal(new Set(children.map(row => row.pid)).size, 1);
        assert.deepEqual(children.map(row => row.tag), ['node']);
        assert.equal(env.launchCounter.count, 1);
        const a = splitReceipt(env, refs[0]), b = splitReceipt(env, refs[1]);
        assert.deepEqual(a.executionReceipt, b.executionReceipt);
        assert.notEqual(a.assertionReceipt.assertionReceiptDigest, b.assertionReceipt.assertionReceiptDigest);
        assert.notEqual(a.executionReceipt.executionReceiptDigest, old.executionReceipt.executionReceiptDigest);
        assert.match(validateVerificationReceipt(env.root, a, { storyId: env.storyId, intentRef: refs[0], selector: 'NODE_PATH_A' }).output!, /NODE_CHANGED/);
        assert.equal(gateCoverage(env).entries.filter(row => row.status === 'covered').length, 4);
        for (const ref of refs) {
          assert.equal(splitReceipt(env, ref).reuseReceipt, undefined);
          assert.equal(splitReceipt(env, ref).executionReceipt.inputClosureComplete, false);
        }
      });
      writeFileSync(log, ''); env.launchCounter.count = 0;
      for (let i = 0; i < 2; i++) await env.handlers.verification_run({ storyId: env.storyId, itemId: 'CHK-001', intentRef: refs[0] });
      assert.equal(env.launchCounter.count, 2, 'F078 ordinary repeated verification still really executes twice');
      assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
      assert.equal(splitReceipt(env, refs[0]).reuseReceipt, undefined);

      // The same PATH entry resolves from the child cwd, not the agent cwd.
      const childCwd = join(external, 'child-cwd'); mkdirSync(childCwd);
      process.env.PATH = `${relative(childCwd, bin)}:${priorPath ?? ''}`;
      const relativeBefore = prepareVerificationExecutionIdentity({ command: 'node --version', cwd: childCwd, effectiveTimeoutMs: timeoutMs });
      const relativeNormal = await runSingleAllowlistedCommand('node --version', env.root, { cwd: childCwd, timeoutMs });
      assert.match(relativeNormal.output, /NODE_CHANGED/);
      writeWrapper('node', 'NODE_RELATIVE_CHANGED');
      const relativeChanged = await runSingleAllowlistedCommand('node --version', env.root, { cwd: childCwd, timeoutMs });
      assert.match(relativeChanged.output, /NODE_RELATIVE_CHANGED/);
      await check('F078 relative PATH resolves against actual child cwd', () => {
        const current = prepareVerificationExecutionIdentity({ command: 'node --version', cwd: childCwd, effectiveTimeoutMs: timeoutMs });
        assert.notEqual(current.toolchainDigest, relativeBefore.toolchainDigest);
        assert.equal(current.environmentDigest, relativeBefore.environmentDigest);
      });

      process.env.PATH = fixedPath;
      const cap = makeEnv('B-aa5f-node-path-capsule', [intent('CAP-PATH', 'cli')]);
      try {
        assert.equal(verificationReuseCapsuleEnforcementSupported(), true);
        const input = 'packages/main/src/path-cap.txt', manifest = 'packages/main/path.verification-dependencies.json';
        write(cap.root, input, 'CAPSULE_CLOSED_PATH_OK\n'); writeCapsuleManifest(cap.root, manifest, [input]);
        git(cap.root, ['add', input, manifest]); git(cap.root, ['commit', '-m', 'capsule path positive control']);
        const command = capsuleCommand(cap.root, manifest, [input]);
        await seedPinnedReceipt(cap, { intentRef: 'CAP-PATH', command, selector: 'CAPSULE_CLOSED_PATH_OK', file: manifest });
        const original = splitReceipt(cap, 'CAP-PATH');
        const identity = (withManifest: boolean) => prepareVerificationExecutionIdentity({ command, cwd: cap.root,
          effectiveTimeoutMs: original.executionReceipt.effectiveTimeoutMs, ...(withManifest ? { manifestPath: manifest } : {}) });
        const withManifest = identity(true), withoutManifest = identity(false);
        process.env.PATH = `${emptyBin}:${priorPath ?? ''}`;
        const actual = await runSingleAllowlistedCommand(command, cap.root, { cwd: cap.root, timeoutMs: original.timeoutMs });
        assert.equal(actual.code, 0); assert.equal(actual.output, 'CAPSULE_CLOSED_PATH_OK\n');
        await check('F078 exact capsule invocation ignores ambient PATH independent of metadata manifest', () => {
          for (const [provided, prior] of [[true, withManifest], [false, withoutManifest]] as const) {
            const current = identity(provided);
            assert.equal(current.toolchainDigest, prior.toolchainDigest);
            assert.equal(current.environmentDigest, prior.environmentDigest,
              'F078 actual capsule environment selection is not conditional on evidence manifest metadata');
          }
          assert.equal(gateCoverage(cap).entries[0].status, 'covered');
        });
        commitRefreshDrift(cap, 'unrelated-path-drift'); cap.launchCounter.count = 0;
        await cap.handlers.verification_evidence_refresh_stale({ storyId: cap.storyId });
        assert.equal(cap.launchCounter.count, 0, 'F078 unrelated capsule drift retains zero-execution reuse');
        assert.ok(splitReceipt(cap, 'CAP-PATH').reuseReceipt);
        assert.deepEqual(splitReceipt(cap, 'CAP-PATH').executionReceipt, original.executionReceipt);
        assert.equal(gateCoverage(cap).entries[0].status, 'covered');
      } finally { cleanup(cap); }

      process.env.PATH = emptyBin;
      const unavailable = await runSingleAllowlistedCommand('node --version', env.root, { cwd: env.root, timeoutMs });
      assert.notEqual(unavailable.code, 0, 'F078 empty search path really cannot execute node');
      await check('F078 unresolved actual executable is fail-closed', () => {
        assert.throws(() => prepareVerificationExecutionIdentity({ command: 'node --version', cwd: env.root, effectiveTimeoutMs: timeoutMs }),
          /toolchain|executable|resolution/i, 'F078 unavailable child identity cannot become a digest of null or the host runtime');
      });
    });
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    cleanup(env); rmSync(external, { recursive: true, force: true });
  }
}
