// Verification capability implementation; shared state is imported explicitly.
import { strict as assert } from 'node:assert';

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { VerificationSplitReceipt } from '../../core/types.js';
import { isSplitVerificationReceipt, planVerificationExecutionReuse, prepareVerificationExecutionIdentity, validateVerificationReceipt } from '../../core/verification-execution-evidence.js';
import { listArtifacts } from '../../core/evidence/artifact-store.js';
import { assessVerifierDependencyManifest } from '../../core/evidence-freshness.js';

import { runSingleAllowlistedCommand } from '../../core/validation-executor.js';

import {
  buildVerificationReuseCapsuleInvocation,
  verificationReuseCapsuleEnforcementSupported,
} from '../../core/verification-reuse-capsule.js';

import { makeEnv, intent, externalVerifierCommand, seedPinnedReceipt, commitRefreshDrift, git, executionCount, findEvidence, splitReceipt, sha256Hex, cleanup, write, writeCapsuleManifest, capsuleCommand, reusableReceipt, verificationFreshnessHashBinding, writeSelfAttestedDependencyManifest } from './support.js';

export async function partE(): Promise<{
  subprocessExecutionCount: number;
  executionReceiptCount: number;
  assertionReceiptCount: number;
  outputArtifactCount: number;
}> {
  const externalRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-refresh-dedupe-'));
  try {
    // E1: two intents with one exact pin/provenance key execute once. Each row
    // receives a cloned receipt whose timestamp and output digest describe that
    // one real execution, rather than a fabricated per-intent pass.
    {
      const env = makeEnv('B-refresh-dedupe-same', [
        intent('INT-SHARED-A', 'cli'),
        intent('INT-SHARED-B', 'cli'),
      ]);
      try {
        const counter = join(externalRoot, 'same-counter.txt');
        const output = join(externalRoot, 'same-output.txt');
        writeFileSync(counter, '');
        writeFileSync(output, 'SHARED_OK\n');
        // The real B-fe8f verifier runs git probes that refresh the index stat
        // cache. Force that otherwise-benign identity drift here: a per-row
        // stamper produces a second causal identity and later fails canonical
        // import, while representative-once grouping has one immutable stamp.
        const command = externalVerifierCommand(counter, output, undefined, env.root);
        await seedPinnedReceipt(env, { intentRef: 'INT-SHARED-A', command, selector: 'SHARED_OK' });
        await seedPinnedReceipt(env, { intentRef: 'INT-SHARED-B', command, selector: 'SHARED_OK' });
        writeFileSync(counter, '');
        commitRefreshDrift(env, 'same-key');
        const indexPath = resolve(env.root, git(env.root, ['rev-parse', '--git-path', 'index']));
        const indexBefore = createHash('sha256').update(readFileSync(indexPath)).digest('hex');

        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        const indexAfter = createHash('sha256').update(readFileSync(indexPath)).digest('hex');
        assert.equal(executionCount(counter), 1, 'E1: one exact execution key runs once for two stale rows');
        assert.notEqual(indexAfter, indexBefore, 'E1: verifier refreshed git index identity during the shared execution');
        const a = findEvidence(env, 'INT-SHARED-A');
        const b = findEvidence(env, 'INT-SHARED-B');
        assert.equal(a?.mechanical, true, 'E1: first shared row remains mechanical');
        assert.equal(b?.mechanical, true, 'E1: second shared row remains mechanical');
        assert.ok(a?.receipt && b?.receipt, 'E1: both rows receive receipts');
        assert.deepEqual(
          splitReceipt(env, 'INT-SHARED-A').executionReceipt,
          splitReceipt(env, 'INT-SHARED-B').executionReceipt,
          'E1: shared rows bind the same selector-free execution receipt',
        );
        assert.notEqual(
          splitReceipt(env, 'INT-SHARED-A').assertionReceipt.assertionReceiptDigest,
          splitReceipt(env, 'INT-SHARED-B').assertionReceipt.assertionReceiptDigest,
          'E1: shared execution still yields independent per-intent assertions',
        );
        assert.match(a!.receipt!.executedAt, /^\d{4}-\d{2}-\d{2}T/u, 'E1: receipt timestamp is an ISO execution time');
        assert.equal(a!.receipt!.outputDigest, sha256Hex('SHARED_OK\n'), 'E1: receipt digest binds the real shared output');
      } finally { cleanup(env); }
    }

    // E2: selectors and descriptive timeout provenance do not split execution.
    // Different effective timeouts still do: default, 5000ms, and 7000ms are
    // three executions. Per-row override reasons remain independently preserved;
    // a nonmatching selector fails closed without poisoning peer assertions.
    {
      const env = makeEnv('B-refresh-dedupe-distinct', [
        intent('INT-SELECTOR-A', 'cli'),
        intent('INT-SELECTOR-B', 'logic'),
        intent('INT-SELECTOR-MISS', 'cli'),
        intent('INT-TIMEOUT-A', 'cli'),
        intent('INT-TIMEOUT-B', 'browser'),
        intent('INT-PROVENANCE-C', 'logic'),
      ]);
      try {
        const counter = join(externalRoot, 'distinct-counter.txt');
        const output = join(externalRoot, 'distinct-output.txt');
        writeFileSync(counter, '');
        writeFileSync(output, 'SELECTOR_A SELECTOR_B SELECTOR_GONE\n');
        const command = externalVerifierCommand(counter, output, undefined, env.root);
        await seedPinnedReceipt(env, { intentRef: 'INT-SELECTOR-A', command, selector: 'SELECTOR_A' });
        await seedPinnedReceipt(env, {
          intentRef: 'INT-SELECTOR-B', command, selector: 'SELECTOR_B', kind: 'logic_test',
        });
        await seedPinnedReceipt(env, { intentRef: 'INT-SELECTOR-MISS', command, selector: 'SELECTOR_GONE' });
        await seedPinnedReceipt(env, {
          intentRef: 'INT-TIMEOUT-A', command, selector: 'SELECTOR_A', commandTimeoutMs: 5000,
          commandTimeoutReason: 'The dedupe smoke needs an attributable first timeout provenance.',
        });
        await seedPinnedReceipt(env, {
          intentRef: 'INT-TIMEOUT-B', command, selector: 'SELECTOR_A', kind: 'browser_test', commandTimeoutMs: 7000,
          commandTimeoutReason: 'The dedupe smoke needs an attributable second timeout provenance.',
        });
        await seedPinnedReceipt(env, {
          intentRef: 'INT-PROVENANCE-C', command, selector: 'SELECTOR_A', kind: 'logic_test', commandTimeoutMs: 5000,
          commandTimeoutReason: 'The dedupe smoke needs distinct provenance at the same timeout value.',
        });
        writeFileSync(counter, '');
        writeFileSync(output, 'SELECTOR_A SELECTOR_B\n');
        commitRefreshDrift(env, 'distinct-keys');
        const indexPath = resolve(env.root, git(env.root, ['rev-parse', '--git-path', 'index']));
        const indexBefore = createHash('sha256').update(readFileSync(indexPath)).digest('hex');

        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        assert.equal(executionCount(counter), 3, 'E2: only different effective timeout values split execution');
        assert.equal(
          findEvidence(env, 'INT-SELECTOR-A')?.receipt?.executedAt,
          findEvidence(env, 'INT-SELECTOR-B')?.receipt?.executedAt,
          'E2: different selectors share one execution timestamp',
        );
        const indexAfter = createHash('sha256').update(readFileSync(indexPath)).digest('hex');
        assert.notEqual(indexAfter, indexBefore, 'E2: raw verifier refreshed git index without cross-receipt identity mismatch');
        const selectorA = findEvidence(env, 'INT-SELECTOR-A');
        const selectorB = findEvidence(env, 'INT-SELECTOR-B');
        assert.equal(selectorA?.receipt?.selector, 'SELECTOR_A', 'E2: first selector owns its evidence verdict');
        assert.equal(selectorB?.receipt?.selector, 'SELECTOR_B', 'E2: second selector owns its evidence verdict');
        assert.equal(selectorA?.receipt?.selectorMatched, true, 'E2: first selector independently matched');
        assert.equal(selectorB?.receipt?.selectorMatched, true, 'E2: second selector independently matched');
        assert.notEqual(splitReceipt(env, 'INT-SELECTOR-A').assertionReceipt.assertionReceiptDigest,
          splitReceipt(env, 'INT-SELECTOR-B').assertionReceipt.assertionReceiptDigest,
          'E2: selector-specific evidence identities remain distinct over one raw run');
        assert.deepEqual(splitReceipt(env, 'INT-SELECTOR-A').executionReceipt,
          splitReceipt(env, 'INT-SELECTOR-B').executionReceipt,
          'E2: independent selector assertions preserve the same signed source execution');
        assert.equal(selectorA?.receipt?.outputDigest, selectorB?.receipt?.outputDigest,
          'E2: selector verdicts bind the same immutable raw output');
        assert.equal(findEvidence(env, 'INT-SELECTOR-MISS')?.mechanical, false,
          'E2: nonmatching selector is independently demoted');
        assert.equal(findEvidence(env, 'INT-SELECTOR-MISS')?.receipt, undefined,
          'E2: nonmatching selector receives no mechanical receipt');
        assert.equal(findEvidence(env, 'INT-TIMEOUT-A')?.receipt?.timeoutOverride?.timeoutMs, 5000,
          'E2: first timeout provenance survives refresh');
        assert.equal(findEvidence(env, 'INT-TIMEOUT-B')?.receipt?.timeoutOverride?.timeoutMs, 7000,
          'E2: second timeout provenance survives refresh');
        assert.equal(
          findEvidence(env, 'INT-TIMEOUT-A')?.receipt?.executedAt,
          findEvidence(env, 'INT-PROVENANCE-C')?.receipt?.executedAt,
          'E2: the same effective timeout shares execution despite different descriptive provenance',
        );
        assert.notEqual(
          findEvidence(env, 'INT-TIMEOUT-A')?.receipt?.timeoutOverride?.reason,
          findEvidence(env, 'INT-PROVENANCE-C')?.receipt?.timeoutOverride?.reason,
          'E2: each assertion retains its own audited timeout reason',
        );
      } finally { cleanup(env); }
    }

    // Independent selector verdicts must not turn shared execution into a false PASS.
    {
      const env = makeEnv('B-refresh-mixed-selectors', [
        intent('INT-MIX-A', 'cli'),
        intent('INT-MIX-B', 'cli'),
      ]);
      try {
        const counter = join(externalRoot, 'mixed-counter.txt');
        const output = join(externalRoot, 'mixed-output.txt');
        writeFileSync(counter, '');
        writeFileSync(output, 'MIX_A MIX_B\n');
        const command = externalVerifierCommand(counter, output);
        await seedPinnedReceipt(env, { intentRef: 'INT-MIX-A', command, selector: 'MIX_A' });
        await seedPinnedReceipt(env, { intentRef: 'INT-MIX-B', command, selector: 'MIX_B' });
        writeFileSync(counter, '');
        writeFileSync(output, 'MIX_A\n');
        commitRefreshDrift(env, 'mixed-selectors');

        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        assert.equal(executionCount(counter), 1, 'E2 mixed: selectors share one child execution');
        const a = findEvidence(env, 'INT-MIX-A');
        const b = findEvidence(env, 'INT-MIX-B');
        assert.equal(a?.mechanical, true, 'E2 mixed: matching selector retains mechanical evidence');
        assert.equal(a?.receipt?.selector, 'MIX_A', 'E2 mixed: passing receipt binds the matching selector');
        assert.equal(a?.receipt?.selectorMatched, true, 'E2 mixed: matching selector has a true verdict');
        assert.equal(b?.mechanical, false, 'E2 mixed: absent selector is demoted independently');
        assert.equal(b?.receipt, undefined, 'E2 mixed: shared execution never fabricates the absent selector PASS');
      } finally { cleanup(env); }
    }

    // E3: selectors are independent assertions over one successful execution.
    // Removing one selector demotes only that row; its sibling still passes.
    {
      const env = makeEnv('B-refresh-dedupe-failure', [
        intent('INT-KEEP', 'cli'),
        intent('INT-MISSING', 'cli'),
      ]);
      try {
        const counter = join(externalRoot, 'failure-counter.txt');
        const output = join(externalRoot, 'failure-output.txt');
        writeFileSync(counter, '');
        writeFileSync(output, `KEEP_OK MISSING_OK\n${'x'.repeat(20_000)}\n`);
        const command = externalVerifierCommand(counter, output);
        await seedPinnedReceipt(env, { intentRef: 'INT-KEEP', command, selector: 'KEEP_OK' });
        await seedPinnedReceipt(env, { intentRef: 'INT-MISSING', command, selector: 'MISSING_OK' });
        writeFileSync(counter, '');
        writeFileSync(output, `KEEP_OK\n${'x'.repeat(20_000)}\n`);
        commitRefreshDrift(env, 'independent-selector');

        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        assert.equal(executionCount(counter), 1, 'E3: two selectors share one successful execution');
        assert.equal(findEvidence(env, 'INT-KEEP')?.mechanical, true, 'E3: matching selector remains mechanical');
        assert.equal(findEvidence(env, 'INT-KEEP')?.receipt?.selectorMatched, true, 'E3: matching selector receives a receipt');
        assert.doesNotMatch(
          findEvidence(env, 'INT-KEEP')?.receipt?.outputTail ?? '',
          /KEEP_OK/u,
          'E3: selector is evaluated over complete output, not the bounded diagnostic tail',
        );
        assert.equal(findEvidence(env, 'INT-MISSING')?.mechanical, false, 'E3: absent selector demotes only its row');
        assert.equal(findEvidence(env, 'INT-MISSING')?.receipt, undefined, 'E3: absent selector receives no fabricated receipt');
      } finally { cleanup(env); }
    }

    // E3b: execution failure is shared. One nonzero subprocess produces no pass
    // stamp for any dependent assertion, even though every selector is present.
    {
      const env = makeEnv('B-refresh-dedupe-nonzero', [
        intent('INT-NONZERO-A', 'cli'),
        intent('INT-NONZERO-B', 'cli'),
      ]);
      try {
        const counter = join(externalRoot, 'nonzero-counter.txt');
        const output = join(externalRoot, 'nonzero-output.txt');
        const exitCode = join(externalRoot, 'nonzero-exit.txt');
        writeFileSync(counter, '');
        writeFileSync(output, 'NONZERO_A NONZERO_B\n');
        writeFileSync(exitCode, '0');
        const command = externalVerifierCommand(counter, output, exitCode);
        await seedPinnedReceipt(env, { intentRef: 'INT-NONZERO-A', command, selector: 'NONZERO_A' });
        await seedPinnedReceipt(env, { intentRef: 'INT-NONZERO-B', command, selector: 'NONZERO_B' });
        writeFileSync(counter, '');
        writeFileSync(exitCode, '3');
        commitRefreshDrift(env, 'shared-nonzero');

        const refreshOutput = await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        assert.equal(executionCount(counter), 1, 'E3b: one shared nonzero execution is attempted once');
        const reasons: string[] = [];
        for (const ref of ['INT-NONZERO-A', 'INT-NONZERO-B']) {
          const row = findEvidence(env, ref);
          assert.equal(row?.mechanical, false, `E3b: ${ref} is demoted after the shared nonzero execution`);
          assert.equal(row?.receipt, undefined, `E3b: ${ref} receives no pass receipt after nonzero exit`);
          assert.match(row?.nonMechanicalReason ?? '', /shared execution was attempted and exited nonzero/u,
            `E3b: ${ref} persists truthful shared nonzero execution provenance`);
          assert.match(row?.nonMechanicalReason ?? '', /executionKey=[0-9a-f]{64}; exitCode=3/u,
            `E3b: ${ref} binds the failed execution identity and exit code`);
          assert.doesNotMatch(row?.nonMechanicalReason ?? '', /not re-run here/u,
            `E3b: ${ref} must not claim the attempted subprocess was skipped`);
          reasons.push(row?.nonMechanicalReason ?? '');
        }
        assert.equal(reasons[0], reasons[1], 'E3b: every dependent assertion records the same shared execution failure');
        assert.match(refreshOutput, /\[verification_refresh_execution_nonzero\]/u,
          'E3b: handler output reports the persisted nonzero execution failure diagnostic');
      } finally { cleanup(env); }
    }

    // E3c / F-015: timeout is observed from the production executor, not a stubbed
    // result. Both rows share one execution identity, so the one killed subprocess
    // invalidates every dependent assertion and no pass receipt can survive.
    {
      const env = makeEnv('B-refresh-dedupe-timeout', [
        intent('INT-TIMEOUT-SHARED-A', 'cli'),
        intent('INT-TIMEOUT-SHARED-B', 'cli'),
      ]);
      try {
        const counter = join(externalRoot, 'timeout-counter.txt');
        const output = join(externalRoot, 'timeout-output.txt');
        const delay = join(externalRoot, 'timeout-delay.txt');
        writeFileSync(counter, '');
        writeFileSync(output, 'TIMEOUT_SHARED_A TIMEOUT_SHARED_B\n');
        writeFileSync(delay, '0');
        const script = [
          `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x')`,
          `const delay=Number(require('fs').readFileSync(${JSON.stringify(delay)}, 'utf8'))`,
          `setTimeout(()=>process.stdout.write(require('fs').readFileSync(${JSON.stringify(output)}, 'utf8')),delay)`,
        ].join(';');
        const command = `node -e ${JSON.stringify(script)}`;
        const timeoutReason = 'Exercise the production timeout fan-out path with one shared execution identity.';
        await seedPinnedReceipt(env, {
          intentRef: 'INT-TIMEOUT-SHARED-A', command, selector: 'TIMEOUT_SHARED_A',
          commandTimeoutMs: 500, commandTimeoutReason: timeoutReason,
        });
        await seedPinnedReceipt(env, {
          intentRef: 'INT-TIMEOUT-SHARED-B', command, selector: 'TIMEOUT_SHARED_B',
          commandTimeoutMs: 500, commandTimeoutReason: timeoutReason,
        });
        writeFileSync(counter, '');
        writeFileSync(delay, '1500');
        commitRefreshDrift(env, 'shared-timeout');

        const refreshOutput = await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        assert.equal(executionCount(counter), 1, 'E3c: shared execution times out through exactly one production subprocess');
        const timeoutRows = ['INT-TIMEOUT-SHARED-A', 'INT-TIMEOUT-SHARED-B']
          .map(ref => ({ ref, row: findEvidence(env, ref) }));
        const passReceiptCount = timeoutRows.filter(({ row }) => row?.mechanical === true && row.receipt !== undefined).length;
        for (const { ref, row } of timeoutRows) {
          assert.equal(row?.mechanical, false, `E3c: ${ref} is demoted after the shared timeout`);
          assert.equal(row?.receipt, undefined, `E3c: ${ref} receives no pass receipt after timeout`);
          assert.match(row?.nonMechanicalReason ?? '', /shared execution was attempted and timed out/u,
            `E3c: ${ref} persists truthful shared timeout provenance`);
          assert.match(row?.nonMechanicalReason ?? '', /executionKey=[0-9a-f]{64}; timeoutMs=500/u,
            `E3c: ${ref} binds the failed execution identity and armed timeout`);
          assert.doesNotMatch(row?.nonMechanicalReason ?? '', /not re-run here/u,
            `E3c: ${ref} must not claim the attempted subprocess was skipped`);
        }
        assert.equal(timeoutRows[0]?.row?.nonMechanicalReason, timeoutRows[1]?.row?.nonMechanicalReason,
          'E3c: every dependent assertion records the same shared timeout failure');
        assert.equal(passReceiptCount, 0, 'E3c: no dependent assertion retains a passing receipt');
        assert.match(refreshOutput, /\[verification_refresh_execution_timeout\]/u,
          'E3c: handler output reports the persisted timeout execution failure diagnostic');
        console.log(
          'baa5f-execution-failure-fans-out timeout=true subprocessExecutionCount=1 assertionsFailed=2 passReceiptCount=0 ' +
          `persistedReason=${JSON.stringify(timeoutRows[0]?.row?.nonMechanicalReason)}`,
        );
      } finally { cleanup(env); }
    }

    // E4 / B-aa5f RED: reproduce the B-fe8f amplification shape through the real
    // stale-refresh handler. Seeding intentionally runs every intent once, so reset
    // both counters before drift; the measured count below is refresh-owned only.
    // The output for each command contains every selector in its group, allowing the
    // fixture to distinguish duplicate scheduling from selector assertion failure.
    {
      const fullIntentCount = 58;
      const redIntentCount = 13;
      const intents = [
        ...Array.from({ length: fullIntentCount }, (_, index) => intent(`FULL-${index}`, 'cli')),
        ...Array.from({ length: redIntentCount }, (_, index) => intent(`RED-${index}`, 'cli')),
      ];
      const env = makeEnv('B-aa5f-fanout-71x2', intents);
      try {
        const fullCounter = join(externalRoot, 'baa5f-full-counter.txt');
        const redCounter = join(externalRoot, 'baa5f-red-counter.txt');
        const fullOutput = join(externalRoot, 'baa5f-full-output.txt');
        const redOutput = join(externalRoot, 'baa5f-red-output.txt');
        writeFileSync(fullCounter, '');
        writeFileSync(redCounter, '');
        writeFileSync(fullOutput, `${Array.from({ length: fullIntentCount }, (_, index) => `FULL_SELECTOR_${index}`).join('\n')}\n`);
        writeFileSync(redOutput, `${Array.from({ length: redIntentCount }, (_, index) => `RED_SELECTOR_${index}`).join('\n')}\n`);
        const fullCommand = externalVerifierCommand(fullCounter, fullOutput);
        const redCommand = externalVerifierCommand(redCounter, redOutput);

        await env.handlers.verification_evidence_batch_add({
          storyId: env.storyId,
          evidences: [
            ...Array.from({ length: fullIntentCount }, (_, index) => ({
              itemId: 'CHK-001',
              intentRef: `FULL-${index}`,
              kind: 'integration_test' as const,
              command: fullCommand,
              selector: `FULL_SELECTOR_${index}`,
              result: 'pass' as const,
              note: `seed FULL-${index}`,
            })),
            ...Array.from({ length: redIntentCount }, (_, index) => ({
              itemId: 'CHK-001',
              intentRef: `RED-${index}`,
              kind: 'integration_test' as const,
              command: redCommand,
              selector: `RED_SELECTOR_${index}`,
              result: 'pass' as const,
              note: `seed RED-${index}`,
            })),
          ],
        });
        assert.equal(
          executionCount(fullCounter) + executionCount(redCounter),
          2,
          'E4 fixture setup: batch fan-out seeds 71 assertions with two executions',
        );

        writeFileSync(fullCounter, '');
        writeFileSync(redCounter, '');
        commitRefreshDrift(env, 'baa5f-71x2');
        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });

        const subprocessExecutionCount = executionCount(fullCounter) + executionCount(redCounter);
        const evidence = env.store.readChecklist(env.storyId).items[0].verificationEvidence ?? [];
        const splitReceipts = evidence
          .map(row => row.receipt)
          .filter((receipt): receipt is VerificationSplitReceipt => isSplitVerificationReceipt(receipt));
        const assertionReceiptCount = splitReceipts.filter(receipt =>
          validateVerificationReceipt(env.root, receipt, {
            intentRef: receipt.assertionReceipt.intentRef,
            selector: receipt.assertionReceipt.intentRef.startsWith('FULL-')
              ? `FULL_SELECTOR_${receipt.assertionReceipt.intentRef.slice('FULL-'.length)}`
              : `RED_SELECTOR_${receipt.assertionReceipt.intentRef.slice('RED-'.length)}`,
            storyId: env.storyId,
          }).ok
          && receipt.assertionReceipt.matched
          && receipt.executionReceipt.exitCode === 0,
        ).length;
        const executionReceiptCount = new Set(
          splitReceipts.map(receipt => receipt.executionReceipt.executionReceiptDigest),
        ).size;
        const outputArtifactCount = listArtifacts(env.root, 'verification-output').length;
        assert.equal(evidence.filter(row =>
          row.mechanical === true
          && row.result === 'pass'
          && row.receipt?.exitCode === 0
          && row.receipt.selectorMatched === true,
        ).length, 71, 'E4: compatibility projection remains readable for all 71 rows');
        console.log(
          `B-aa5f fanout actualExecutionCount=${subprocessExecutionCount} ` +
          `expectedExecutionCount=2 executionReceiptCount=${executionReceiptCount} ` +
          `assertionReceiptCount=${assertionReceiptCount} outputArtifactCount=${outputArtifactCount}`,
        );
        assert.equal(executionReceiptCount, 2, 'E4: two subprocesses produce two unique execution receipts');
        assert.equal(assertionReceiptCount, 71, 'E4: all 71 immutable selectors receive independent passing receipts');
        assert.equal(outputArtifactCount, 2, 'E4: two command outputs are stored as two content-addressed artifacts');
        assert.equal(
          subprocessExecutionCount,
          2,
          'E4: 71 intents over two commands launch exactly two refresh-owned verifier executions',
        );
        return { subprocessExecutionCount, executionReceiptCount, assertionReceiptCount, outputArtifactCount };
      } finally { cleanup(env); }
    }
  } finally {
    rmSync(externalRoot, { recursive: true, force: true });
  }
}

export async function partF(): Promise<void> {
  // Two deterministic commands with disjoint closures: unrelated Story drift
  // reuses both, then changing only A's closure executes A and reuses B.
  {
    const env = makeEnv('B-aa5f-input-scoped-reuse', [
      intent('INT-REUSE-A', 'cli'),
      intent('INT-REUSE-B', 'cli'),
    ]);
    try {
      const inputA = 'packages/main/src/reuse-a.txt';
      const inputB = 'packages/main/src/reuse-b.txt';
      const manifestA = 'packages/main/reuse-a.verification-dependencies.json';
      const manifestB = 'packages/main/reuse-b.verification-dependencies.json';
      write(env.root, inputA, 'REUSE_A\n');
      write(env.root, inputB, 'REUSE_B\n');
      writeCapsuleManifest(env.root, manifestA, [inputA]);
      writeCapsuleManifest(env.root, manifestB, [inputB]);
      git(env.root, ['add', inputA, inputB, manifestA, manifestB]);
      git(env.root, ['commit', '-m', 'add verifier dependency closures']);
      const commandA = capsuleCommand(env.root, manifestA, [inputA]);
      const commandB = capsuleCommand(env.root, manifestB, [inputB]);
      const capsuleProbe = await runSingleAllowlistedCommand(commandA, env.root, { cwd: env.root, timeoutMs: 5000 });
      assert.equal(capsuleProbe.code, 0, `F1: canonical capsule seed probe failed: ${capsuleProbe.output}`);
      await seedPinnedReceipt(env, { intentRef: 'INT-REUSE-A', command: commandA, selector: 'REUSE_A', file: manifestA });
      await seedPinnedReceipt(env, { intentRef: 'INT-REUSE-B', command: commandB, selector: 'REUSE_B', file: manifestB });
      const initialA = reusableReceipt(env, 'INT-REUSE-A').executionReceipt.executionReceiptDigest;
      const initialB = reusableReceipt(env, 'INT-REUSE-B').executionReceipt.executionReceiptDigest;
      const preReuseDecision = planVerificationExecutionReuse({
        projectRoot: env.root,
        storyId: env.storyId,
        priorReceipt: reusableReceipt(env, 'INT-REUSE-A'),
        intentRef: 'INT-REUSE-A',
        selector: 'REUSE_A',
        command: commandA,
        cwd: reusableReceipt(env, 'INT-REUSE-A').executionReceipt.cwd,
        effectiveTimeoutMs: reusableReceipt(env, 'INT-REUSE-A').executionReceipt.effectiveTimeoutMs,
        manifestPath: manifestA,
        freshnessHashBinding: verificationFreshnessHashBinding(env, 'INT-REUSE-A'),
      });
      const storedPreReuse = reusableReceipt(env, 'INT-REUSE-A').executionReceipt;
      assert.equal(preReuseDecision.reusable, true,
        `F1 preflight: complete receipt should be reusable (${preReuseDecision.reason}; stored=${storedPreReuse.executionIdentityDigest}, current=${preReuseDecision.identity.executionIdentityDigest})`);

      env.launchCounter.count = 0;
      commitRefreshDrift(env, 'input-unrelated');
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      const unrelated = [reusableReceipt(env, 'INT-REUSE-A'), reusableReceipt(env, 'INT-REUSE-B')];
      const unrelatedExecutions = env.launchCounter.count;
      const unrelatedReuseReceipts = new Set(unrelated.map(receipt => receipt.reuseReceipt?.reuseReceiptDigest).filter(Boolean)).size;
      assert.equal(unrelatedExecutions, 0, 'F1: unrelated Story drift launches no verifier subprocess');
      assert.equal(unrelatedReuseReceipts, 2, 'F1: both command identities receive auditable reuse receipts');
      assert.equal(unrelated[0].executionReceipt.executionReceiptDigest, initialA, 'F1: reuse never rewrites execution A');
      assert.equal(unrelated[1].executionReceipt.executionReceiptDigest, initialB, 'F1: reuse never rewrites execution B');
      for (const [receipt, intentRef, selector] of [
        [unrelated[0], 'INT-REUSE-A', 'REUSE_A'],
        [unrelated[1], 'INT-REUSE-B', 'REUSE_B'],
      ] as const) {
        const validation = validateVerificationReceipt(env.root, receipt, { intentRef, selector, storyId: env.storyId });
        assert.equal(validation.ok, true, `F1: ${intentRef} reuse receipt and immutable artifact validate`);
        assert.equal(validation.reusable, true, `F1: ${intentRef} retains a complete reusable identity`);
      }
      const tamperedReuse = structuredClone(unrelated[0]);
      tamperedReuse.reuseReceipt!.reusedAt = '2099-01-01T00:00:00.000Z';
      assert.equal(
        validateVerificationReceipt(env.root, tamperedReuse, {
          intentRef: 'INT-REUSE-A', selector: 'REUSE_A', storyId: env.storyId,
        }).ok,
        false,
        'F1: tampering with an auditable reuse receipt fails closed',
      );
      const legacyReuse = planVerificationExecutionReuse({
        projectRoot: env.root,
        storyId: env.storyId,
        priorReceipt: {
          exitCode: 0,
          outputDigest: sha256Hex('REUSE_A\n'),
          outputTail: 'REUSE_A\n',
          selectorMatched: true,
          executedAt: '2026-09-03T00:00:00.000Z',
          timeoutMs: unrelated[0].executionReceipt.effectiveTimeoutMs,
        },
        intentRef: 'INT-REUSE-A',
        selector: 'REUSE_A',
        command: commandA,
        cwd: unrelated[0].executionReceipt.cwd,
        effectiveTimeoutMs: unrelated[0].executionReceipt.effectiveTimeoutMs,
        manifestPath: manifestA,
        freshnessHashBinding: verificationFreshnessHashBinding(env, 'INT-REUSE-A'),
      });
      assert.equal(legacyReuse.reusable, false, 'F1: a legacy combined receipt cannot be promoted into reuse');
      assert.equal(legacyReuse.reason, 'legacy_or_nonreusable_receipt', 'F1: legacy reuse denial is explicit');
      console.log(`unrelatedDrift executions=${unrelatedExecutions} reuseReceipts=${unrelatedReuseReceipts}`);

      write(env.root, inputA, 'REUSE_A changed\n');
      git(env.root, ['add', inputA]);
      git(env.root, ['commit', '-m', 'change only verifier A input closure']);
      env.launchCounter.count = 0;
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      const changedA = reusableReceipt(env, 'INT-REUSE-A');
      const unchangedB = reusableReceipt(env, 'INT-REUSE-B');
      const changed = [changedA, unchangedB];
      const changedExecutions = env.launchCounter.count;
      const changedReuseReceipts = new Set(changed.map(receipt => receipt.reuseReceipt?.reuseReceiptDigest).filter(Boolean)).size;
      assert.equal(changedExecutions, 1, 'F2: one changed input closure launches exactly one verifier subprocess');
      assert.equal(changedReuseReceipts, 1, 'F2: the unchanged command receives exactly one reuse receipt');
      assert.notEqual(changedA.executionReceipt.executionReceiptDigest, initialA, 'F2: changed closure produces a new execution');
      assert.equal(unchangedB.executionReceipt.executionReceiptDigest, initialB, 'F2: unchanged closure retains immutable prior execution');
      console.log(`oneInputChanged executions=${changedExecutions} reuseReceipts=${changedReuseReceipts}`);
    } finally { cleanup(env); }
  }

  // An explicitly partial closure executes on every stale refresh. The same
  // assessor rejects every other uncertainty class before reuse planning.
  {
    const env = makeEnv('B-aa5f-incomplete-closure', [intent('INT-INCOMPLETE', 'cli')]);
    try {
      const input = 'packages/main/src/incomplete.txt';
      const manifest = 'packages/main/incomplete.verification-dependencies.json';
      write(env.root, input, 'INCOMPLETE_OK\n');
      writeCapsuleManifest(env.root, manifest, [input, input]);
      git(env.root, ['add', input, manifest]);
      git(env.root, ['commit', '-m', 'add intentionally partial verifier closure']);
      const command = capsuleCommand(env.root, manifest, [input, input]);
      await seedPinnedReceipt(env, { intentRef: 'INT-INCOMPLETE', command, selector: 'INCOMPLETE_OK', file: manifest });
      const before = reusableReceipt(env, 'INT-INCOMPLETE').executionReceipt.executionReceiptDigest;
      env.launchCounter.count = 0;
      commitRefreshDrift(env, 'incomplete-closure');
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      const after = reusableReceipt(env, 'INT-INCOMPLETE');
      assert.equal(after.reuseReceipt, undefined, 'F3: partial closure cannot mint a reuse receipt');
      assert.equal(after.executionReceipt.reuseDeniedReason, 'incomplete_input_closure', 'F3: receipt records stable denial reason');
      assert.notEqual(after.executionReceipt.executionReceiptDigest, before, 'F3: partial closure forces a fresh execution');
      assert.equal(env.launchCounter.count, 1, 'F3: partial closure launches one real subprocess');
      console.log('reuse=denied reason=incomplete_input_closure');

      assert.equal(assessVerifierDependencyManifest({ gitCwd: env.root }).reason, 'missing_dependency_manifest');
      const missingInputManifest = 'packages/main/missing-input.verification-dependencies.json';
      writeCapsuleManifest(env.root, missingInputManifest, ['packages/main/src/does-not-exist.txt']);
      const missingInputCommand = capsuleCommand(env.root, missingInputManifest, ['packages/main/src/does-not-exist.txt']);
      const missingInputIdentity = prepareVerificationExecutionIdentity({
        command: missingInputCommand,
        cwd: env.root,
        effectiveTimeoutMs: 5000,
        manifestPath: missingInputManifest,
      });
      assert.equal(missingInputIdentity.reason, 'missing_input', 'F3: a missing capsule input denies reuse');
    } finally { cleanup(env); }
  }

  // Authority and sandbox boundary: v1 is self-attestation only, and a v2
  // manifest cannot bless arbitrary code. Only the byte-exact policy capsule
  // receives a complete input identity and the executor's closed environment.
  {
    const env = makeEnv('B-aa5f-capsule-authority', [intent('INT-CAPSULE', 'cli')]);
    let escapedAbsolutePath: string | undefined;
    // The smoke itself may be launched by runSingleAllowlistedCommand, whose
    // ordinary-command tracer arrives through NODE_OPTIONS. Permission probes
    // must exercise the requested capability, not fail earlier while preloading
    // that outer tracer under the probe's deliberately narrow read grant.
    const inheritedNodeOptions = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;
    try {
      const declared = 'packages/main/src/capsule-declared.txt';
      const hidden = 'packages/main/src/capsule-hidden.txt';
      const v1 = 'packages/main/self-attested.verification-dependencies.json';
      const v2 = 'packages/main/capsule.verification-dependencies.json';
      const preload = 'packages/main/src/capsule-preload.cjs';
      write(env.root, declared, 'CAPSULE_OK\n');
      write(env.root, hidden, 'HIDDEN\n');
      write(env.root, preload, "console.log('INJECTED_PRELOAD')\n");
      writeSelfAttestedDependencyManifest(env.root, v1, [declared]);
      writeCapsuleManifest(env.root, v2, [declared]);
      const arbitrary = `node -e ${JSON.stringify(`process.stdout.write(require('fs').readFileSync(${JSON.stringify(declared)},'utf8'))`)}`;
      const underDeclared = `node -e ${JSON.stringify(`const f=require('fs');process.stdout.write(f.readFileSync(${JSON.stringify(declared)},'utf8')+f.readFileSync(${JSON.stringify(hidden)},'utf8'))`)}`;
      const capsule = capsuleCommand(env.root, v2, [declared]);
      const identity = (command: string, manifestPath: string) => prepareVerificationExecutionIdentity({
        command, cwd: env.root, effectiveTimeoutMs: 5000, manifestPath,
      });
      assert.equal(identity(arbitrary, v1).reason, 'untrusted_dependency_manifest',
        'F4: self-attested v1 completeness has no reuse authority');
      assert.equal(identity(underDeclared, v1).reason, 'untrusted_dependency_manifest',
        'F4: an under-declared arbitrary reader cannot conceal an input');
      assert.equal(identity(arbitrary, v2).reason, 'untrusted_dependency_manifest',
        'F4: a declarative manifest cannot authorize arbitrary JavaScript');
      assert.equal(identity(capsule, v2).reusable, true, 'F4: exact policy-owned capsule is reusable');
      console.log('reuse authority selfAttested=denied arbitraryCommand=denied capsule=admitted');

      const allowedFlagsDescriptor = Object.getOwnPropertyDescriptor(process, 'allowedNodeEnvironmentFlags');
      assert.ok(allowedFlagsDescriptor, 'F4: Node exposes an allowedNodeEnvironmentFlags feature descriptor');
      try {
        Object.defineProperty(process, 'allowedNodeEnvironmentFlags', {
          configurable: true,
          value: new Set(['--permission']),
        });
        assert.equal(verificationReuseCapsuleEnforcementSupported(), false,
          'F4: a runtime missing any required permission primitive is unsupported');
        assert.throws(
          () => buildVerificationReuseCapsuleInvocation({ cwd: env.root, manifestPath: v2, files: [declared] }),
          /unsupported_capsule_enforcement/u,
          'F4: unsupported permission enforcement fails closed before constructing a capsule command',
        );
        assert.equal(identity(arbitrary, v2).reason, 'unsupported_capsule_enforcement',
          'F4: unsupported permission enforcement cannot mint reusable identity');
      } finally {
        Object.defineProperty(process, 'allowedNodeEnvironmentFlags', allowedFlagsDescriptor);
      }
      assert.equal(verificationReuseCapsuleEnforcementSupported(), true,
        'F4: this runner must provide every permission primitive required by the reusable capsule; unsupported runtimes fail closed before capsule construction');
      const restricted = (
        source: string,
        options: { readPaths?: string[]; flags?: string[] } = {},
      ) => [
        'node', '--permission',
        ...(options.flags ?? []),
        ...(options.readPaths ?? [join(env.root, declared)]).map(path => `--allow-fs-read=${path}`),
        '-e', JSON.stringify(source),
      ].join(' ');
      const assertPermissionDenial = async (
        label: string,
        source: string,
        options: { readPaths?: string[]; flags?: string[]; pattern?: RegExp } = {},
      ) => {
        const command = restricted(source, options);
        const denied = await runSingleAllowlistedCommand(command, env.root, { cwd: env.root, timeoutMs: 5000 });
        assert.equal(denied.timedOut, false, `F4: ${label} attempt completes as an explicit denial, not a timeout`);
        assert.notEqual(denied.code, 0, `F4: Node permission model denies ${label}`);
        assert.match(denied.output, options.pattern ?? /ERR_ACCESS_DENIED|Access to this API has been restricted/u,
          `F4: ${label} reports a permission denial rather than an unrelated runtime failure`);
        assert.equal(identity(command, v2).reusable, false,
          `F4: the non-canonical ${label} attempt cannot mint reusable evidence`);
      };

      await assertPermissionDenial(
        'an undeclared file read',
        `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(env.root, hidden))},'utf8'))`,
      );
      await assertPermissionDenial(
        'filesystem writes',
        `require('fs').writeFileSync(${JSON.stringify(join(env.root, declared))},'FORGED')`,
      );
      await assertPermissionDenial(
        'subprocesses',
        "require('child_process').execFileSync(process.execPath,['-e','process.exit(0)'])",
      );
      await assertPermissionDenial(
        'network access',
        "require('net').connect({host:'127.0.0.1',port:9})",
      );
      await assertPermissionDenial(
        'worker creation',
        "new (require('node:worker_threads').Worker)('0',{eval:true})",
      );

      const fakeAddon = join(env.root, 'packages/main/src/capsule-native.node');
      writeFileSync(fakeAddon, 'not a native addon');
      await assertPermissionDenial(
        'native addon loading',
        `process.dlopen({exports:{}},${JSON.stringify(fakeAddon)})`,
        { readPaths: [fakeAddon], pattern: /ERR_DLOPEN_DISABLED|loading addons is disabled/u },
      );
      await assertPermissionDenial(
        'FFI loading',
        "require('node:ffi').dlopen('/definitely/missing-proof-or-stop-library.so')",
        { flags: ['--experimental-ffi'], pattern: /ERR_ACCESS_DENIED|--allow-ffi/u },
      );
      await assertPermissionDenial(
        'WASI creation',
        "new (require('node:wasi').WASI)({version:'preview1'})",
        { pattern: /ERR_ACCESS_DENIED|--allow-wasi/u },
      );
      await assertPermissionDenial(
        'inspector activation',
        "require('node:inspector').open(0)",
        { pattern: /ERR_ACCESS_DENIED|--allow-inspector/u },
      );

      // Path traversal and symlink aliases are exercised through the exact capsule
      // command, then rejected by the mechanically validated input closure before
      // they can authorize reuse. The command may read what its explicit OS-level
      // permission grants; that never upgrades the invalid manifest into authority.
      const escapedName = `capsule-escaped-${process.pid}.txt`;
      const escaped = `../${escapedName}`;
      escapedAbsolutePath = join(env.root, escaped);
      writeFileSync(escapedAbsolutePath, 'ESCAPED\n');
      const escapedManifest = 'packages/main/escaped.verification-dependencies.json';
      writeCapsuleManifest(env.root, escapedManifest, [escaped]);
      const escapedCommand = capsuleCommand(env.root, escapedManifest, [escaped]);
      const escapedAttempt = await runSingleAllowlistedCommand(escapedCommand, env.root, { cwd: env.root, timeoutMs: 5000 });
      assert.equal(escapedAttempt.timedOut, false, 'F4: escaped-path capsule attempt actually completes');
      assert.equal(escapedAttempt.code, 0, 'F4: escaped-path attack is genuinely exercised at the process boundary');
      assert.equal(escapedAttempt.output, 'ESCAPED\n', 'F4: OS permission alone would read the escaped input');
      assert.equal(identity(escapedCommand, escapedManifest).reason, 'unsafe_input_path',
        'F4: escaped path cannot mint reusable evidence even when explicitly granted to the process');

      const symlink = 'packages/main/src/capsule-link.txt';
      symlinkSync(join(env.root, hidden), join(env.root, symlink));
      const symlinkManifest = 'packages/main/symlink.verification-dependencies.json';
      writeCapsuleManifest(env.root, symlinkManifest, [symlink]);
      const symlinkCommand = capsuleCommand(env.root, symlinkManifest, [symlink]);
      const symlinkAttempt = await runSingleAllowlistedCommand(symlinkCommand, env.root, { cwd: env.root, timeoutMs: 5000 });
      assert.equal(symlinkAttempt.timedOut, false, 'F4: symlink capsule attempt actually completes');
      assert.equal(symlinkAttempt.code, 0, 'F4: symlink-read attack is genuinely exercised at the process boundary');
      assert.equal(symlinkAttempt.output, 'HIDDEN\n', 'F4: OS permission alone follows the symlink to hidden input');
      assert.equal(identity(symlinkCommand, symlinkManifest).reason, 'non_regular_input',
        'F4: symlink input cannot mint reusable evidence');

      const dynamicImport = capsule.replace(' -e ', ` --import=${join(env.root, preload)} -e `);
      const widened = capsule.replace(' --permission ', ' --permission --allow-net --allow-child-process ');
      assert.equal(identity(dynamicImport, v2).reason, 'untrusted_dependency_manifest',
        'F4: loader/dynamic-import injection changes canonical argv and loses authority');
      assert.equal(identity(widened, v2).reason, 'untrusted_dependency_manifest',
        'F4: permission widening changes canonical argv and loses authority');

      const previousNodeOptions = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = `--require=${join(env.root, preload)}`;
      try {
        const closed = await runSingleAllowlistedCommand(capsule, env.root, { cwd: env.root, timeoutMs: 5000 });
        assert.equal(closed.code, 0, `F4: canonical capsule executes under enforced permissions (${closed.output})`);
        assert.equal(closed.output, 'CAPSULE_OK\n', 'F4: ambient NODE_OPTIONS preload is absent from closed environment');
      } finally {
        if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previousNodeOptions;
      }
      console.log('capsule sandbox undeclaredRead=denied env=closed network=denied child=denied write=denied dynamicImport=denied injection=denied');
      console.log('capsule direct attacks enforcement=supported_true_denial unsupported=fail_closed escapedPath=nonreusable symlink=nonreusable worker=denied addon=denied ffi=denied wasi=denied inspector=denied');
    } finally {
      if (inheritedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = inheritedNodeOptions;
      if (escapedAbsolutePath) rmSync(escapedAbsolutePath, { force: true });
      cleanup(env);
    }
  }
}
