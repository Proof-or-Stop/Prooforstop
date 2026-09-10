import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(pkg.scripts['precert:fast'], 'node scripts/run-precert-fast.mjs',
  'U07 requires one runnable fast set with stable contract identities');
const { FAST_CONTRACTS, validateFastResult, assertFastScriptBindings } = await import('./precert-fast-contracts.mjs');
const expected = ['selector-integrity', 'real-port-collision', 'causal-launches-zero',
  'terminal-process-cleanup', 'source-dist-launches-zero'];
assert.deepEqual(FAST_CONTRACTS.map(row => row.contractId), expected);
assert.equal(new Set(FAST_CONTRACTS.map(row => row.marker)).size, expected.length);
assertFastScriptBindings(pkg.scripts);
for (const contract of FAST_CONTRACTS) {
  assert.throws(() => assertFastScriptBindings({...pkg.scripts,[contract.script]:`echo ${contract.marker}`}), /fast contract command changed/, 'a replacement script printing the correct marker is refused before launch');
  for (const displayedCount of [25, 27, 83, 85]) {
    validateFastResult(contract, {name:contract.script, status:'PASS',
      output:`${contract.marker}\nassertions=${displayedCount}\n`});
  }
  for (const output of ['', `echo ${contract.marker}`, `${contract.marker} assertions=27`,
    `${contract.marker}\n${contract.marker}`]) {
    assert.throws(() => validateFastResult(contract, {name:contract.script, status:'PASS', output}),
      /exact terminal marker/, 'exit zero, echoed command and ambiguous markers cannot grant a contract pass');
  }
  for (const status of ['FAIL', 'TIMEOUT', 'INTERRUPTED', 'UNSUPPORTED']) {
    assert.throws(() => validateFastResult(contract, {name:contract.script, status, output:contract.marker}), /did not pass/);
  }
  assert.throws(() => validateFastResult(contract, {name:'foreign-script',status:'PASS',output:contract.marker}), /wrong member/);
}
const config = JSON.parse(readFileSync('proof-or-stop.config.json','utf8'));
assert.ok(config.validate.commands.some(row => row.command === 'node'
  && row.args?.[0] === 'scripts/run-precert-fast.mjs' && row.focus?.includes('fast')
  && row.fullBaselineReusePolicy === 'forbidden'), 'actual pre-cert validation must consume the fast set');
const unknown = spawnSync(process.execPath, ['scripts/run-precert-fast.mjs','--contract','not-a-contract'], {encoding:'utf8'});
assert.notEqual(unknown.status, 0);
assert.doesNotMatch(`${unknown.stdout}${unknown.stderr}`, /^PRE_CERT_FAST_SET=PASS$/m);
const listing = execFileSync(process.execPath, ['scripts/run-precert-fast.mjs','--list'], {encoding:'utf8'});
assert.deepEqual(JSON.parse(listing).contracts.map(row => row.contractId), expected);
assert.doesNotMatch(listing, /^PRE_CERT_FAST_SET=PASS$/m, 'listing cannot grant completion');
const output = execFileSync(process.execPath, ['scripts/run-precert-fast.mjs'],
  {encoding:'utf8',timeout:210000,maxBuffer:8*1024*1024});
process.stdout.write(output);
for (const contract of FAST_CONTRACTS) assert.ok(output.split(/\r?\n/).includes(contract.marker));
assert.ok(output.split(/\r?\n/).includes('PRE_CERT_FAST_SET=PASS'));
process.stdout.write(execFileSync(process.execPath,['scripts/verify-precert-process-containment.mjs'],{encoding:'utf8',timeout:15000}));
console.log('PASS U07 stable contracts execute real adversarial fast checks');
