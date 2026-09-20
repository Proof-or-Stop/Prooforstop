// Verification capability implementation; shared state is imported explicitly.
import { strict as assert } from 'node:assert';

import { readFileSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';

import { PROOF_OR_STOP_DIR } from '../../core/proof-or-stop-paths.js';

import { refreshStaleEvidenceMetadataOnly } from '../../handlers/checklist.js';

import { buildVerificationCoverage } from '../../core/verification.js';

import { currentMaterialHash, currentStoryFilesHash } from '../../core/evidence-freshness.js';

import type { VerificationExecutionReceipt } from '../../core/types.js';
import { validateVerificationReceipt } from '../../core/verification-execution-evidence.js';

import { makeEnv, intent, PASS_CMD, SELECTOR, findEvidence, sha256Hex, splitReceipt, expectRejection, cleanup, NONZERO_CMD, write, git, guardVerdict, DIFFERENT_CMD, makeCliBackedEnv, runHook, CLAUDE_HOOK, CODEX_HOOK } from './support.js';

export async function partA(): Promise<void> {
  const env = makeEnv('B-runA', [
    intent('INT-RUN-OK', 'cli', { command: PASS_CMD, selector: SELECTOR }),
    intent('INT-NOPIN', 'cli'), // executable intent, no pin
  ]);
  try {
    // A1: happy — verification_run executes the PINNED command and stamps a receipt.
    await env.handlers.verification_run({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-RUN-OK', note: 'run the pinned verifier' });
    const ev = findEvidence(env, 'INT-RUN-OK');
    assert.ok(ev, 'A1: verification_run recorded an evidence row');
    assert.equal(ev.mechanical, true, 'A1: row is a mechanical tool-executed receipt');
    assert.ok(ev.receipt, 'A1: a receipt was stamped (proves the command actually ran)');
    assert.equal(ev.receipt.exitCode, 0, 'A1: receipt.exitCode is the REAL exit (0)');
    assert.equal(ev.receipt.selectorMatched, true, 'A1: receipt.selectorMatched proves the selector appeared in real output');
    assert.match(ev.receipt.outputDigest, /^[0-9a-f]{64}$/, 'A1: receipt.outputDigest is a sha256 over captured output');
    assert.match(ev.receipt.outputTail, /MARKER_OK/, 'A1: receipt.outputTail carries the real captured output');
    assert.equal(ev.receipt.outputDigest, sha256Hex(ev.receipt.outputTail), 'A1: digest == sha256(captured output) (short output)');
    const split = splitReceipt(env, 'INT-RUN-OK');
    assert.equal(
      Object.prototype.hasOwnProperty.call(split.executionReceipt, 'selectorMatched'),
      false,
      'A1: execution receipt contains no selector outcome',
    );
    assert.equal(split.assertionReceipt.intentRef, 'INT-RUN-OK', 'A1: assertion binds its intentRef');
    assert.equal(split.assertionReceipt.selectorDigest, sha256Hex(SELECTOR), 'A1: assertion binds the immutable selector digest');
    assert.equal(split.assertionReceipt.matcherVersion, 'literal-includes.v1', 'A1: assertion binds matcher semantics');
    assert.equal(
      split.assertionReceipt.executionReceiptDigest,
      split.executionReceipt.executionReceiptDigest,
      'A1: assertion binds its execution receipt',
    );
    assert.equal(split.assertionReceipt.outputDigest, split.executionReceipt.outputArtifact.outputDigest,
      'A1: assertion and execution bind the same full output');
    assert.equal(split.assertionReceipt.matched, true, 'A1: assertion records its independent match result');
    const validSplit = validateVerificationReceipt(env.root, split, {
      intentRef: 'INT-RUN-OK',
      selector: SELECTOR,
      storyId: env.storyId,
    });
    assert.equal(validSplit.ok, true, `A1: split receipt and full-output artifact validate: ${validSplit.errors.join('; ')}`);
    assert.equal(validSplit.output, 'MARKER_OK\n', 'A1: authoritative read returns complete artifact output');
    assert.equal(validSplit.reusable, false, 'A1: CHK-002 receipt has no cross-state reuse authority');

    // A1 tamper matrix: canonical artifact bytes, execution facts, assertion facts,
    // and expected selector binding all fail closed at the authoritative validator.
    const objectPath = join(
      env.root,
      '.proof-or-stop',
      'evidence',
      'objects',
      'sha256',
      `${split.executionReceipt.outputArtifact.artifactDigest}.json`,
    );
    const originalObject = readFileSync(objectPath, 'utf8');
    const tamperedObject = JSON.parse(originalObject) as { payload: { output: string } };
    tamperedObject.payload.output = 'FORGED_OUTPUT\n';
    writeFileSync(objectPath, `${JSON.stringify(tamperedObject, null, 2)}\n`);
    assert.equal(
      validateVerificationReceipt(env.root, split, { intentRef: 'INT-RUN-OK', selector: SELECTOR }).ok,
      false,
      'A1: tampered full-output artifact fails closed',
    );
    writeFileSync(objectPath, originalObject);

    const tamperedExecution = structuredClone(split);
    tamperedExecution.executionReceipt.durationMs += 1;
    assert.equal(
      validateVerificationReceipt(env.root, tamperedExecution, { intentRef: 'INT-RUN-OK', selector: SELECTOR }).ok,
      false,
      'A1: tampered execution receipt fails closed',
    );
    const tamperedAssertion = structuredClone(split);
    tamperedAssertion.assertionReceipt.matched = false;
    assert.equal(
      validateVerificationReceipt(env.root, tamperedAssertion, { intentRef: 'INT-RUN-OK', selector: SELECTOR }).ok,
      false,
      'A1: tampered assertion receipt fails closed',
    );
    assert.equal(
      validateVerificationReceipt(env.root, split, { intentRef: 'INT-RUN-OK', selector: 'FORGED_SELECTOR' }).ok,
      false,
      'A1: selector substitution fails closed',
    );
    const legacyReceipt: VerificationExecutionReceipt = {
      exitCode: 0,
      outputDigest: sha256Hex('MARKER_OK\n'),
      outputTail: 'MARKER_OK\n',
      selectorMatched: true,
      executedAt: '2026-09-03T00:00:00.000Z',
    };
    const legacyValidation = validateVerificationReceipt(env.root, legacyReceipt, {
      intentRef: 'INT-RUN-OK',
      selector: SELECTOR,
    });
    assert.equal(legacyValidation.ok, true, 'A1: legacy combined receipt remains readable');
    assert.equal(legacyValidation.kind, 'legacy-readable-only', 'A1: legacy receipt is explicitly classified');
    assert.equal(legacyValidation.reusable, false, 'A1: legacy receipt cannot authorize reuse');
    assert.equal(legacyValidation.promotable, false, 'A1: legacy receipt cannot be promoted into split evidence');
    // Result is DERIVED from the receipt, not authored by the caller (schema exposes no result field).
    assert.equal(ev.result, 'pass', 'A1: recorded result is DERIVED from the receipt (exit 0 + selector match)');
    // Gate: an executed receipt covers the executable intent.
    const cov = buildVerificationCoverage(env.store.readChecklist(env.storyId));
    const okEntry = cov.entries.find(e => e.intentRef === 'INT-RUN-OK');
    assert.equal(okEntry?.status, 'covered', 'A1: the executed receipt covers the executable intent');

    // A3: REFUSE — the intent has no pin → [verification_run_no_pin] (never mints an unexecuted row).
    await expectRejection(
      env.handlers.verification_run({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-NOPIN', note: 'no pin to run' }),
      /verification_run_no_pin/, 'A3: unpinned intent is refused',
    );
    assert.equal(findEvidence(env, 'INT-NOPIN'), undefined, 'A3: no row minted for the unpinned intent');

    // A4: REFUSE — the intentRef does not resolve to any intent → [intent_ref_unresolved].
    await expectRejection(
      env.handlers.verification_run({ storyId: env.storyId, intentRef: 'CHK-001:happy:99', note: 'unresolved ref' }),
      /intent_ref_unresolved/, 'A4: unresolved intentRef is refused',
    );
  } finally { cleanup(env); }
}

export async function partA2Refusal(): Promise<void> {
  const env = makeEnv('B-runA2', [
    intent('INT-RUN-FAIL', 'cli', { command: NONZERO_CMD, selector: SELECTOR }),
  ]);
  try {
    // The pinned command exits non-zero while verification_run's fixed internal
    // expectation is pass → [receipt_exit_nonzero]; NOTHING is minted.
    await expectRejection(
      env.handlers.verification_run({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-RUN-FAIL', note: 'nonzero pin' }),
      /receipt_exit_nonzero/, 'A2: exit-nonzero pin is refused',
    );
    assert.equal(findEvidence(env, 'INT-RUN-FAIL'), undefined, 'A2: no covered row is minted for the refused nonzero pin');
  } finally { cleanup(env); }
}

export async function partB(): Promise<void> {
  const progress: string[] = [];
  const env = makeEnv('B-refB', [
    intent('INT-REEXEC', 'cli'),  // pinned via add to PASS_CMD (always re-passes)
    intent('INT-REEXEC-DUP', 'cli'), // shares one command execution with INT-REEXEC during refresh
    intent('INT-FAIL', 'cli'),    // pinned via add to flagCountingCommand (re-fails once flag flips)
    intent('INT-PINLESS', 'cli'), // NO pin — a hand-written mechanical row (B-3b88 coexistence)
    intent('INT-DOC', 'docs'),    // docs intent with a deliberate pinned mechanical verifier
    intent('INT-MANUAL', 'manual'), // manual intent can also deliberately pin a verifier
  ], undefined, message => progress.push(message), 'production');
  try {
    // Seed a material file the flagCountingCommand pin depends on, so re-execution outcome is controllable.
    write(env.root, 'flag.txt', 'MARKER_OK');
    git(env.root, ['add', 'flag.txt']);
    git(env.root, ['commit', '-m', 'flag=MARKER_OK']);

    const refreshCountPath = join(env.root, PROOF_OR_STOP_DIR, 'runtime', 'refresh-count.log');
    const sharedCountingCommand = `node -e "const f=require('fs');f.mkdirSync('${PROOF_OR_STOP_DIR}/runtime',{recursive:true});f.appendFileSync('${PROOF_OR_STOP_DIR}/runtime/refresh-count.log','x\\n');console.log('MARKER_OK')"`;
    const flagCountingCommand = `node -e "const f=require('fs');f.mkdirSync('${PROOF_OR_STOP_DIR}/runtime',{recursive:true});f.appendFileSync('${PROOF_OR_STOP_DIR}/runtime/refresh-count.log','flag\\n');process.stdout.write(f.readFileSync('flag.txt','utf8'))"`;
    // Pin + record two PASSING mechanical rows backed by the exact same command.
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-REEXEC', kind: 'integration_test',
      command: sharedCountingCommand, selector: SELECTOR, result: 'pass', note: 'pin + pass the shared verifier',
    });
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-REEXEC-DUP', kind: 'integration_test',
      command: sharedCountingCommand, selector: SELECTOR, result: 'pass', note: 'pin + pass the shared verifier again',
    });
    // Pin + record a PASSING mechanical row for INT-FAIL (flagCountingCommand passes while flag=MARKER_OK).
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-FAIL', kind: 'integration_test',
      command: flagCountingCommand, selector: SELECTOR, result: 'pass', note: 'pin + pass the flag-dependent verifier',
    });
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-DOC', kind: 'docs_check',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'pin + pass the documentation verifier',
    });
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-MANUAL', kind: 'manual_transcript',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'pin + pass the manual intent verifier',
    });
    writeFileSync(refreshCountPath, '');

    // Hand-write a pin-LESS mechanical row bound to the CURRENT head+material. The intent
    // has NO verification pin, so refresh's re-exec loop must SKIP it → demote-only path.
    const head0 = git(env.root, ['rev-parse', 'HEAD']);
    const material0 = currentMaterialHash(env.root, 'HEAD', env.root);
    const storyFiles0 = currentStoryFilesHash(env.root, 'HEAD', env.root);
    assert.ok(storyFiles0, 'B: main-backed temp repo has a storyFilesHash for causal freshness');
    const fakeReceipt: VerificationExecutionReceipt = {
      exitCode: 0, outputDigest: sha256Hex('MARKER_OK\n'), outputTail: 'MARKER_OK\n', selectorMatched: true,
      executedAt: '2026-07-25T00:00:00.000Z',
    };
    {
      const cl = env.store.readChecklist(env.storyId);
      const rows = cl.items[0].verificationEvidence || [];
      rows.push({
        intentRef: 'INT-PINLESS', kind: 'integration_test', result: 'pass', note: 'pin-less legacy mechanical row',
        headHash: head0, ...(material0 ? { materialHash: material0 } : {}),
        mechanical: true, receipt: fakeReceipt,
      });
      cl.items[0].verificationEvidence = rows;
      env.store.writeChecklist(env.storyId, cl);
    }

    // Snapshot the pre-refresh receipt identity for INT-REEXEC.
    const reexecBefore = findEvidence(env, 'INT-REEXEC');
    assert.equal(reexecBefore?.mechanical, true, 'B: INT-REEXEC starts as a mechanical row');
    const executedAtBefore = reexecBefore!.receipt!.executedAt;
    const materialBefore = reexecBefore!.materialHash;

    // DRIFT: flip flag.txt to BROKEN and commit → material tree changes → all rows go stale.
    write(env.root, 'flag.txt', 'BROKEN');
    git(env.root, ['add', 'flag.txt']);
    git(env.root, ['commit', '-m', 'flag=BROKEN (material drift)']);
    const material1 = currentMaterialHash(env.root, 'HEAD', env.root);
    assert.ok(material1 && material1 !== materialBefore, 'B: material drift produced a NEW materialHash');

    // Reproduce the real recovery state: a metadata-only refresh cannot execute
    // commands, so it demotes and rebinds receipts to the current material.
    // The subsequent async refresh must recover these CURRENT non-mechanical
    // rows, not report that there is no stale evidence.
    refreshStaleEvidenceMetadataOnly({ store: env.store, root: env.root, scanRoot: env.root }, env.storyId);
    assert.equal(findEvidence(env, 'INT-DOC')?.mechanical, false,
      'B: metadata-only refresh demotes the pinned docs receipt before recovery');
    assert.equal(findEvidence(env, 'INT-MANUAL')?.mechanical, false,
      'B: metadata-only refresh demotes the pinned manual receipt before recovery');

    // Run the REAL async re-executing refresh.
    const out = await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
    assert.match(out, /Refreshed \d+\/\d+/, 'B: refresh reported a refresh count');
    assert.equal(
      readFileSync(refreshCountPath, 'utf8').trim().split('\n').filter(Boolean).length,
      2,
      'B0: two unique cwd+command pins execute exactly once while duplicate intents share one execution',
    );
    assert.match(progress.join('\n'), /validate progress: command 1\/3 started verification-evidence-command:/,
      'B0: refresh exposes the first unique pinned command through the shared validation progress surface');
    assert.match(progress.join('\n'), /validate progress: command 2\/3 started verification-evidence-command:/,
      'B0: refresh exposes the second unique pinned command with the exact aggregate ordinal');
    assert.match(progress.join('\n'), /validate progress: command 1\/3 ended verification-evidence-command:/);
    assert.match(progress.join('\n'), /validate progress: command 2\/3 ended verification-evidence-command:/);
    assert.match(progress.join('\n'), /validate progress: command 3\/3 started verification-evidence-command:/, 'Pinned docs/manual share a third raw command rather than being skipped');
    assert.match(progress.join('\n'), /validate progress: command 3\/3 ended verification-evidence-command:/);

    // B1: INT-REEXEC still passes on re-run → RE-EXECUTED, stays mechanical:true, bound to
    //     the NEW materialHash (NOT demoted). Reverting refresh to DEMOTE kills this.
    const reexecAfter = findEvidence(env, 'INT-REEXEC');
    assert.equal(reexecAfter?.mechanical, true, 'B1: passing re-run stays mechanical:true (NOT demoted)');
    assert.ok(reexecAfter?.receipt, 'B1: a fresh receipt is present after re-execution');
    assert.equal(reexecAfter.receipt.exitCode, 0, 'B1: re-execution receipt exit 0');
    assert.equal(reexecAfter.receipt.selectorMatched, true, 'B1: re-execution selector matched');
    assert.equal(reexecAfter.result, 'pass', 'B1: re-execution derived pass');
    assert.equal(reexecAfter.materialHash, material1, 'B1: the fresh receipt is bound to the CURRENT (new) materialHash');
    assert.notEqual(reexecAfter.receipt.executedAt, executedAtBefore, 'B1: executedAt changed → the command was genuinely RE-RUN (not a carried-forward stale receipt)');
    const duplicateAfter = findEvidence(env, 'INT-REEXEC-DUP');
    assert.equal(duplicateAfter?.mechanical, true, 'B1: a second intent sharing the execution is independently stamped mechanical:true');
    assert.equal(duplicateAfter?.receipt?.selectorMatched, true, 'B1: the shared output independently satisfies the duplicate intent selector');

    // B2: INT-FAIL now fails on re-run (flag=BROKEN → selector absent) → LEFT demoted /
    //     non-mechanical, receipt stripped (no laundering back to covered). Reverting refresh
    //     to launder a failing re-run into mechanical:true kills this.
    const failAfter = findEvidence(env, 'INT-FAIL');
    assert.equal(failAfter?.mechanical, false, 'B2: a failing re-run leaves the row demoted (mechanical:false)');
    assert.equal(failAfter?.receipt, undefined, 'B2: the stale receipt is stripped (no laundering)');
    assert.ok(failAfter?.nonMechanicalReason, 'B2: an attributable demotion reason is recorded');

    // B3: INT-PINLESS keeps demote-only behavior (B-3b88 coexistence — the re-exec change is
    //     ADDITIVE and never re-executes a pin-less row). Reverting to re-execute/keep-covered
    //     everything would keep this mechanical:true and kill the assertion.
    const pinlessAfter = findEvidence(env, 'INT-PINLESS');
    assert.equal(pinlessAfter?.mechanical, false, 'B3: pin-less stale mechanical row is DEMOTED (demote-only)');
    assert.equal(pinlessAfter?.receipt, undefined, 'B3: pin-less demotion strips the receipt');
    assert.match(pinlessAfter?.nonMechanicalReason ?? '', /not re-run here/u,
      'B3: genuinely unexecuted demotion retains the existing non-execution provenance');

    // B4: a deliberately pinned docs verifier is recovered too. This locks the
    // B3F3D-006-H3 path: docs/manual types are not skipped merely because their
    // intent type is non-executable by default.
    const manualAfter = findEvidence(env, 'INT-MANUAL');
    assert.equal(manualAfter?.mechanical, true, 'B4: pinned manual verifier re-earns mechanical authority');
    assert.equal(manualAfter?.receipt?.selectorMatched, true, 'B4: pinned manual selector matched on recovery');
    assert.equal(manualAfter?.receipt?.exitCode, 0, 'B4: pinned manual verifier actually exited zero');
    assert.equal(manualAfter?.materialHash, material1, 'B4: recovered manual receipt binds current material');
    const docAfter = findEvidence(env, 'INT-DOC');
    assert.equal(docAfter?.mechanical, true, 'B4: pinned docs verifier re-earns mechanical authority');
    assert.equal(docAfter?.receipt?.selectorMatched, true, 'B4: pinned docs selector matched on recovery');
    assert.equal(docAfter?.materialHash, material1, 'B4: recovered docs receipt binds current material');

    // Gate cross-check: only successfully re-executed rows cover; failing/pinless stay uncovered.
    const cov = buildVerificationCoverage(env.store.readChecklist(env.storyId));
    assert.equal(cov.entries.find(e => e.intentRef === 'INT-REEXEC')?.status, 'covered', 'B: re-executed row covers');
    assert.equal(cov.entries.find(e => e.intentRef === 'INT-FAIL')?.status, 'non_mechanical', 'B: demoted-fail row is uncovered');
    assert.equal(cov.entries.find(e => e.intentRef === 'INT-PINLESS')?.status, 'non_mechanical', 'B: demoted pin-less row is uncovered');
    assert.equal(cov.entries.find(e => e.intentRef === 'INT-DOC')?.status, 'covered', 'B: recovered pinned docs row covers');
    assert.equal(cov.entries.find(e => e.intentRef === 'INT-MANUAL')?.status, 'covered', 'B: recovered pinned manual row covers');
  } finally { cleanup(env); }
}

export async function partC(): Promise<void> {
  const env = makeEnv('B-guardC', [
    intent('INT-PIN', 'cli'),    // pinned via add to PASS_CMD/SELECTOR
    intent('INT-NOPIN2', 'cli'), // executable, never pinned
  ]);
  try {
    // Pin INT-PIN by recording a passing mechanical row (immutable pin thereafter).
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PIN', kind: 'integration_test',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'pin the immutable verifier',
    });

    const addBlob = (o: Record<string, unknown>) => `node bin/proof-or-stop.js verification_evidence_add ${JSON.stringify(o)}`;

    // C1: DENY — mismatched --command (JSON-blob form). selector matches; only command differs.
    const denyCmd = guardVerdict(env, {
      commandString: addBlob({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PIN', command: DIFFERENT_CMD, selector: SELECTOR, kind: 'integration_test', result: 'pass', note: 'x' }),
    });
    assert.equal(denyCmd.verdict, 'deny', 'C1: mismatched --command (JSON blob) is DENIED');

    // C2: DENY — mismatched --selector (--k=v form). No --command; only the selector differs.
    const denySel = guardVerdict(env, {
      commandString: `node bin/proof-or-stop.js verification_evidence_add --storyId=${env.storyId} --itemId=CHK-001 --intentRef=INT-PIN --selector=WRONG_SELECTOR --note=x`,
    });
    assert.equal(denySel.verdict, 'deny', 'C2: mismatched --selector (--k=v) is DENIED');

    // C3: ALLOW — command AND selector both match the pin.
    const allowMatch = guardVerdict(env, {
      commandString: addBlob({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PIN', command: PASS_CMD, selector: SELECTOR, kind: 'integration_test', result: 'pass', note: 'x' }),
    });
    assert.equal(allowMatch.verdict, 'allow', 'C3: matching command/selector is ALLOWED');

    // C4: ALLOW — verification_run derives its command from the pin (nothing to mismatch).
    const allowRun = guardVerdict(env, {
      commandString: `node bin/proof-or-stop.js verification_run --storyId=${env.storyId} --intentRef=INT-PIN`,
    });
    assert.equal(allowRun.verdict, 'allow', 'C4: verification_run is ALLOWED');

    // C5: ALLOW — an unpinned intent (the first write will pin it).
    const allowUnpinned = guardVerdict(env, {
      commandString: addBlob({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-NOPIN2', command: DIFFERENT_CMD, selector: 'ANYTHING', kind: 'integration_test', result: 'pass', note: 'x' }),
    });
    assert.equal(allowUnpinned.verdict, 'allow', 'C5: unpinned intent is ALLOWED');

    // C6: ALLOW (no-decision) — not a proof-or-stop evidence-write command at all.
    const allowNonProofOrStop = guardVerdict(env, { commandString: 'git status -s' });
    assert.equal(allowNonProofOrStop.verdict, 'allow', 'C6: non-proof-or-stop command is ALLOWED (no-decision)');
    assert.equal(allowNonProofOrStop.matched, false, 'C6: non-proof-or-stop command is not matched as an evidence write');

    // C7: FAIL-OPEN — a WOULD-BE-deny (mismatched command) against a NONEXISTENT story:
    //     the store read fails → the seatbelt allows rather than blocking legitimate work.
    const failOpenStory = guardVerdict(env, {
      commandString: addBlob({ storyId: 'B-DOESNOTEXIST', itemId: 'CHK-001', intentRef: 'INT-PIN', command: DIFFERENT_CMD, selector: SELECTOR, kind: 'integration_test', result: 'pass', note: 'x' }),
    });
    assert.equal(failOpenStory.verdict, 'allow', 'C7: nonexistent story => FAIL-OPEN allow');

    // C8: FAIL-OPEN — unparseable tool input (no command to inspect) => allow.
    const failOpenParse = guardVerdict(env, { toolInputJson: '{ this is not valid json' });
    assert.equal(failOpenParse.verdict, 'allow', 'C8: unparseable input => FAIL-OPEN allow');
    assert.equal(failOpenParse.matched, false, 'C8: unparseable input yields a no-decision allow');

    // C9: ADVERSARIAL — bypass the seatbelt entirely and hit the enforceAndStampEvidence
    //     HANDLER with the same mismatched command: the FLOOR still refuses (the guard/hook
    //     is non-load-bearing). Removing the floor refusal kills this.
    await expectRejection(
      env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PIN', kind: 'integration_test',
        command: DIFFERENT_CMD, selector: SELECTOR, result: 'pass', note: 'bypass the hook; the floor must still refuse',
      }),
      /receipt_command_mismatch/, 'C9: the handler floor refuses the mismatch even with the hook bypassed',
    );
  } finally { cleanup(env); }
}

export async function partD(): Promise<string> {
  const env = makeCliBackedEnv('B-hookD');
  const notes: string[] = [];
  try {
    // Pin INT-PIN so the real CLI resolves a real immutable pin for the deny path.
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PIN', kind: 'integration_test',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'pin for the hook e2e',
    });

    const mismatchCmd = `node bin/proof-or-stop.js verification_evidence_add ${JSON.stringify({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PIN', command: DIFFERENT_CMD, selector: SELECTOR, kind: 'integration_test', result: 'pass', note: 'e2e mismatch' })}`;
    const matchCmd = `node bin/proof-or-stop.js verification_evidence_add ${JSON.stringify({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PIN', command: PASS_CMD, selector: SELECTOR, kind: 'integration_test', result: 'pass', note: 'e2e match' })}`;

    // D1: Claude Bash matcher — FULLY asserted (the real emitted tool_name is `Bash`).
    assert.equal(runHook(CLAUDE_HOOK, env.root, 'Bash', mismatchCmd), 2, 'D1: Claude Bash hook exits 2 (deny) on a mismatched evidence write');
    assert.equal(runHook(CLAUDE_HOOK, env.root, 'Bash', matchCmd), 0, 'D1: Claude Bash hook exits 0 (allow) on a matching evidence write');
    assert.equal(runHook(CLAUDE_HOOK, env.root, 'Edit', mismatchCmd), 0, 'D1: Claude hook does NOT fire for a non-Bash tool (fail-open exit 0)');

    // D2: Codex shell matcher — the shim FIRES (exit 2) for the DOCUMENTED CANDIDATE tokens.
    //     PENDING-REAL-TOKEN: Codex's REAL emitted shell tool_name is NOT confirmable in this
    //     environment (CHK-003). We assert only that the candidate tokens the shim matches DO
    //     fire; we do NOT assert that Codex actually emits one of them — see the NOTE below.
    const CODEX_CANDIDATES = ['shell', 'local_shell', 'exec_command'];
    for (const token of CODEX_CANDIDATES) {
      assert.equal(runHook(CODEX_HOOK, env.root, token, mismatchCmd), 2, `D2: Codex hook exits 2 (deny) for candidate tool_name=${token}`);
    }
    // A non-candidate tool_name must never fire (the shim is a true no-op there).
    assert.equal(runHook(CODEX_HOOK, env.root, 'apply_patch', mismatchCmd), 0, 'D2: Codex hook does NOT fire for a non-shell tool (fail-open exit 0)');
    // Matching command allowed even for a candidate token.
    assert.equal(runHook(CODEX_HOOK, env.root, 'shell', matchCmd), 0, 'D2: Codex hook exits 0 (allow) on a matching evidence write');

    notes.push(
      'NOTE (Codex): PENDING-REAL-TOKEN — asserted the shim FIRES exit-2 on deny for the documented ' +
      `candidate tokens (${CODEX_CANDIDATES.join('|')}); Codex's REAL emitted shell tool_name is NOT confirmed ` +
      'in this environment, so Codex coverage is CANDIDATE-only, not confirmed. Claude Bash is fully asserted.',
    );
    return notes.join('\n');
  } finally { cleanup(env); }
}
