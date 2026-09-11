#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FAST_SET_ID, FAST_SET_BUDGET_MS, FAST_CONTRACTS, assertFastScriptBindings, validateFastResult } from './precert-fast-contracts.mjs';
import { verifyBuildBinding } from './full-suite-build-binding.mjs';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--list'),
  'usage: run-precert-fast.mjs [--list]; partial sets cannot grant completion');
if (args[0] === '--list') {
  console.log(JSON.stringify({suiteId:FAST_SET_ID,contracts:FAST_CONTRACTS,diagnosticOnly:true},null,2));
} else {
  const root = process.cwd();
  verifyBuildBinding(root);
  assertFastScriptBindings(JSON.parse(readFileSync('package.json','utf8')).scripts);
  const {runEntry, canonicalizeEntries, createFullSuiteRunState, interruptFullSuiteRun} =
    await import('../packages/main/dist/tasks/full-suite-runner.js');
  const state = createFullSuiteRunState();
  const started = performance.now();
  let budgetExpired = false;
  const interrupt = signal => interruptFullSuiteRun(signal, state);
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  process.once('SIGINT',onInt); process.once('SIGTERM',onTerm);
  const timer = setTimeout(() => { budgetExpired = true; interrupt('SIGTERM'); },FAST_SET_BUDGET_MS);
  const results = [];
  try {
    // Serial admission is local to this invocation; cross-process coordination is separate.
    for (const contract of FAST_CONTRACTS) {
      assert.ok(!budgetExpired && !state.interruptSignal, 'fast set interrupted before launch');
      const [entry] = canonicalizeEntries([{...contract,name:contract.script}],root);
      const result = await runEntry(entry,root,'npm',undefined,state);
      process.stdout.write(result.output);
      validateFastResult(contract,result);
      results.push({contractId:contract.contractId,assertionId:contract.assertionId,
        failureClassId:contract.failureClassId,durationMs:result.durationMs,status:'PASS'});
    }
    assert.ok(!budgetExpired && !state.interruptSignal && performance.now()-started < FAST_SET_BUDGET_MS,
      'fast set exceeded its three-minute invocation budget or was interrupted');
    verifyBuildBinding(root);
    assertFastScriptBindings(JSON.parse(readFileSync('package.json','utf8')).scripts);
    console.log(JSON.stringify({suiteId:FAST_SET_ID,status:'PASS',durationMs:performance.now()-started,
      contracts:results,authority:'diagnostic-only',writesStoryEvidence:false,
      historicalCaptureRate:null,cohortP95Ms:null}));
    console.log('PRE_CERT_FAST_SET=PASS');
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT',onInt); process.removeListener('SIGTERM',onTerm);
  }
}
