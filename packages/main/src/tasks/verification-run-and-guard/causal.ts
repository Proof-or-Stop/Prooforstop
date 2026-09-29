// Verification capability implementation; shared state is imported explicitly.
import { strict as assert } from 'node:assert';

import { validateVerificationReceipt } from '../../core/verification-execution-evidence.js';

import {
  CAUSAL_MAX_OUTPUT_CHARS, CAUSAL_OUTPUT_TAIL_CHARS,
  DEFAULT_CAUSAL_SELECTOR_POLICY, effectiveCausalEnvironment, executeCausalEvidence, importCausalEvidenceReceipt,
  preflightCausalEvidence, verifyCausalEvidenceReceipt,
  type CausalEvidenceReceipt, type CausalExecutionIdentityInput, type CausalPreflightFacts,
} from '../../core/causal-evidence.js';

import { makeEnv, intent, splitReceipt, commitRefreshDrift, expectRejection, git, cleanup } from './support.js';

export async function partKCausalIntegration(): Promise<void> {
  const env = makeEnv('B-causal-integration', [
    intent('K-CLI', 'cli'), intent('K-DOCS', 'docs'), intent('K-MANUAL', 'manual'),
    intent('K-TIMEOUT', 'logic'),
  ]);
  // The probe retains a prefix AND suffix, in addition to its separate tail.
  // Pad both sides past either exported bound so K_DOCS is absent from all
  // bounded diagnostics while remaining present in authenticated full output.
  const diagnosticPadding = Math.max(CAUSAL_MAX_OUTPUT_CHARS, CAUSAL_OUTPUT_TAIL_CHARS) + 1;
  const command = `node -e "process.stdout.write('K_CLI K_MANUAL K_TIMEOUT '+ 'x'.repeat(${diagnosticPadding}) +' K_DOCS '+ 'y'.repeat(${diagnosticPadding}))"`;
  const signed: CausalEvidenceReceipt[] = [];
  const writeReceipt = env.store.writeCausalEvidenceReceipt.bind(env.store);
  env.store.writeCausalEvidenceReceipt = (storyId, receipt) => {
    assert.ok(verifyCausalEvidenceReceipt(receipt, receipt.executionKey), 'K: production causal receipt is genuinely signed');
    signed.push(structuredClone(receipt));
    writeReceipt(storyId, receipt);
  };
  try {
    const batchRows = [
      ['K-CLI', 'K_CLI', 'integration_test', 5000], ['K-DOCS', 'K_DOCS', 'docs_check', 5000],
      ['K-MANUAL', 'K_MANUAL', 'manual_transcript', 5000], ['K-TIMEOUT', 'K_TIMEOUT', 'logic_test', 7000],
    ] as const;
    const batchResponse = await env.handlers.verification_evidence_batch_add({
      storyId: env.storyId,
      evidences: batchRows.map(([intentRef, selector, kind, timeout]) => ({
        itemId: 'CHK-001', intentRef, command, selector, kind, result: 'pass',
        note: `CHK008 actual batch observation for ${intentRef}`,
        commandTimeoutMs: timeout,
        commandTimeoutReason: `CHK008 genuine ${intentRef} timeout provenance remains assertion-local.`,
      })),
    });
    assert.match(batchResponse, /CausalEvidence: intentCount=4 uniqueExecutionKeys=2 commandExecutions=2 cacheHitRate=50%/,
      'K: causal ledger counts every independently evaluated intent, including shared-execution followers');
    assert.equal(env.launchCounter.count, 2, 'K: per-intent ledger accounting never reruns a shared execution');
    assert.equal(signed.length, 2, 'K: followers never re-sign the source execution');
    assert.equal(new Set(batchRows.map(([id]) => splitReceipt(env, id).assertionReceipt.intentRef)).size, 4,
      'K: the four ledger intents retain independent authenticated selector assertions');
    commitRefreshDrift(env, 'causal-integration');
    signed.length = 0;
    env.launchCounter.count = 0;
    await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
    assert.equal(env.launchCounter.count, 2, 'K: selector/type/kind/provenance fan-out shares execution; effective timeouts isolate');
    assert.equal(signed.length, 2, 'K: each physical observation has one signed causal source');
    const receipts = ['K-CLI', 'K-DOCS', 'K-MANUAL', 'K-TIMEOUT'].map(id => splitReceipt(env, id));
    assert.deepEqual(receipts[0].executionReceipt, receipts[1].executionReceipt, 'K: docs fan-out retains immutable execution bytes');
    assert.deepEqual(receipts[0].executionReceipt, receipts[2].executionReceipt, 'K: manual fan-out retains immutable execution bytes');
    assert.notEqual(receipts[0].executionReceipt.executionIdentityDigest, receipts[3].executionReceipt.executionIdentityDigest,
      'K: effective-timeout separation is physical, not assertion-only');
    for (const receipt of receipts) assert.ok(validateVerificationReceipt(env.root, receipt, {
      storyId: env.storyId, intentRef: receipt.assertionReceipt.intentRef,
      selector: receipt.selector!, command,
    }).ok, 'K: current V5 assertion independently authenticates its selector and complete output');

    const identityFor = (receipt: CausalEvidenceReceipt): CausalExecutionIdentityInput => ({
      ...receipt.identity, selectorPolicy: DEFAULT_CAUSAL_SELECTOR_POLICY,
      effectiveEnvironment: effectiveCausalEnvironment(undefined, receipt.identity.cwd),
    });
    const sourceFacts = (signed[0].identity.inputs as { preflightFacts: CausalPreflightFacts }).preflightFacts;
    const boundedDiagnostic = await executeCausalEvidence({
      identity: identityFor(signed[0]), selector: 'K_DOCS', receiptStore: env.store,
      preflight: preflightCausalEvidence(sourceFacts, () => true, identityFor(signed[0])),
      revalidateBeforeRun: () => true,
      run: async () => { throw new Error('K: diagnostic replay must not launch another execution'); },
    });
    assert.equal(signed[0].outputProbe.includes('K_DOCS'), false, 'K: bounded diagnostic probe still omits the middle-of-large-output selector');
    assert.ok(signed[0].selectorOutput, 'K: causal replay binds durable complete selector output');
    assert.equal(boundedDiagnostic.disposition, 'reused', 'K: complete-output replay does not launch another execution');
    assert.equal(boundedDiagnostic.verdict.matched, true, 'K: authenticated complete causal output finds the middle-of-large-output selector');
    assert.equal(splitReceipt(env, 'K-DOCS').selectorMatched, true, 'K: authenticated complete-output V5 assertion agrees with causal replay');
    const sourceBytes = signed.map(receipt => JSON.stringify(receipt));
    let imports = 0;
    for (const receipt of signed) importCausalEvidenceReceipt({
      receipt, expectedStoryId: env.storyId, expectedExecutionKey: receipt.executionKey,
      currentIdentity: identityFor(receipt), revalidate: () => true, commit: () => { imports++; },
    });
    assert.equal(imports, 2, 'K: valid same-identity imports pass');
    assert.throws(() => importCausalEvidenceReceipt({
      receipt: signed[0], expectedStoryId: env.storyId, expectedExecutionKey: signed[0].executionKey,
      currentIdentity: identityFor(signed[1]), revalidate: () => true, commit: () => { imports++; },
    }), /causal_.*mismatch/, 'K: cross-identity cached import snapshot is refused');
    const facts = (signed[0].identity.inputs as { preflightFacts: CausalPreflightFacts }).preflightFacts;
    const crossedPreflight = preflightCausalEvidence(facts, () => true, identityFor(signed[1]));
    let crossedRuns = 0;
    await expectRejection(executeCausalEvidence({
      identity: identityFor(signed[0]), selector: 'K_CLI', preflight: crossedPreflight,
      revalidateBeforeRun: () => true,
      run: async () => { crossedRuns++; throw new Error('crossed preflight must never reach execution'); },
    }), /causal_preflight_invalid/, 'K: cross-identity cached preflight is refused before execution');
    assert.equal(crossedRuns, 0);
    assert.equal(imports, 2, 'K: invalid import never publishes');
    assert.deepEqual(signed.map(receipt => JSON.stringify(receipt)), sourceBytes, 'K: import never rewrites signed execution bytes or time');

    const timeFailures: string[] = [];
    const beforeOrdinary = signed.length;
    const beforeOrdinaryRuns = env.launchCounter.count;
    const beforeOrdinaryHead = git(env.root, ['rev-parse', 'HEAD']);
    for (let i = 0; i < 2; i++) await env.handlers.verification_run({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'K-CLI',
    });
    assert.equal(env.launchCounter.count - beforeOrdinaryRuns, 2, 'K: ordinary repeated verification really executes twice');
    assert.equal(git(env.root, ['rev-parse', 'HEAD']), beforeOrdinaryHead, 'K: repeated-observation control holds Git freshness fixed');
    if (signed.length - beforeOrdinary !== 2) timeFailures.push('new ordinary executions borrowed an older same-key CAS observation');

    const priorChecklist = env.store.readChecklist(env.storyId);
    const readReceipt = env.store.readCausalEvidenceReceipt.bind(env.store);
    env.store.readCausalEvidenceReceipt = (storyId, key) => {
      const actual = readReceipt(storyId, key);
      return actual ? signed.find(receipt => receipt.executionKey !== key) ?? actual : actual;
    };
    await expectRejection(env.handlers.verification_run({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'K-CLI' }),
      /causal_(?:receipt_tampered|commit_snapshot_invalid|import_revalidation_failed)/,
      'K: actual production import refuses substituted signed CAS receipt');
    env.store.readCausalEvidenceReceipt = readReceipt;
    assert.deepEqual(env.store.readChecklist(env.storyId), priorChecklist, 'K: cross-identity refusal leaves prior receipts and pins unchanged');

    for (const receipt of receipts) {
      const source = signed.find(candidate => candidate.timeoutMs === receipt.executionReceipt.effectiveTimeoutMs)!;
      assert.equal(source.outputDigest, receipt.outputDigest, 'K: causal and V3 receipts bind the same actual output');
      if (receipt.executedAt !== source.executedAt || receipt.executionReceipt.executedAt !== source.executedAt) {
        timeFailures.push(`${receipt.assertionReceipt.intentRef}: source=${source.executedAt} execution=${receipt.executedAt}`);
      }
    }
    assert.equal(timeFailures.length, 0, `K: fan-out retains source signed execution time, never publication time: ${timeFailures.join('; ')}`);
    console.log('CHK008 causal matrix: same-identity import, crossed preflight/CAS refusal, signed time/bytes and timeout fan-out verified');
  } finally { cleanup(env); }
}
