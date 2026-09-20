import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const contracts = [
  { name: 'process', script: 'scripts/verify-process-fact-contract.mjs', args: ['--quiet'],
    header: 'Process fact contract failed:',
    failure: '- retired vocabulary guard must enforce narrow compatibility usage: 52a283cfcdc3bfbb233feab6d31614d0eabf8470a41d3af10ad7786246905720',
    bindings: { 'packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts': '51b368943464c6703e5f9b5bdf827cbfa12f2a4c8b4cf463bfbad4eeed2d5bc2' } },
  { name: 'runtime', script: 'scripts/verify-runtime-fact-contract.mjs', args: [],
    header: 'Runtime fact contract failed:',
    failure: `- Command failed: ${process.execPath} ${join(root, 'scripts/verify-validation-snapshot-binding.mjs')}`,
    cause: 'AssertionError [ERR_ASSERTION]: VALIDATION_SNAPSHOT_BINDING_INVALID: live facts, workspace, input bytes and implementation comparison',
    bindings: {
      'packages/main/src/core/shared-validation-execution.ts': '134aa9912c2cd3cdddcd8a1714e8bcf7a3b2a09e5fe7535da55f878b72bad57e',
      'scripts/verify-validation-snapshot-binding.mjs': 'd62e918c80438130d2677d30d88cea749c4f61ad62727f37b856c2a52d9f96e8',
    } },
];
function classification(contract, result) {
  assert.equal(result.error, undefined, 'Contract command must execute without transport error');
  assert.equal(result.signal, null, 'A signaled command is not a known baseline failure');
  const output = result.stdout + result.stderr;
  if (result.status === 0) {
    assert(!output.includes(contract.header), 'Failure output cannot claim PASS');
    assert(output.includes(`${contract.name === 'process' ? 'Process' : 'Runtime'} fact contract verified`)
      && output.includes('execution_assertion_reuse_contract=PASS'), 'Require completed verifier evidence');
    return 'pass';
  }
  assert.equal(result.status, 1, 'Unexpected contract exit');
  const sections = output.split(contract.header);
  assert.equal(sections.length, 2, 'Require exactly one complete failure list');
  assert.equal(sections[1].trim(), contract.failure, 'New contract failures must block the release');
  if (contract.cause) assert(output.includes(contract.cause), 'Known command must have the same failure cause');
  for (const [file, expected] of Object.entries(contract.bindings)) {
    assert.equal(createHash('sha256').update(readFileSync(join(root, file))).digest('hex'), expected,
      `Known baseline source changed: ${file}`);
  }
  return 'known_baseline_failure';
}
for (const contract of contracts) {
  const fixture = { status: 1, signal: null, stdout: `${contract.cause ?? ''}\n${contract.header}\n${contract.failure}\n`, stderr: '' };
  assert.throws(() => classification(contract, { ...fixture, stdout: fixture.stdout + '- new failure\n' }));
  assert.throws(() => classification(contract, { ...fixture, signal: 'SIGTERM' }));
  assert.throws(() => classification(contract, { ...fixture, status: 2 }));
  assert.throws(() => classification(contract, { ...fixture, stdout: fixture.stdout + contract.header }));
  assert.throws(() => classification(contract, { ...fixture, status: 0, stdout: '' }));
  if (contract.cause) assert.throws(() => classification(contract, { ...fixture, stdout: fixture.stdout.replace(contract.cause, 'different failure') }));
  const result = spawnSync(process.execPath, [contract.script, ...contract.args], {
    cwd: root, encoding: 'utf8', timeout: 360_000, maxBuffer: 32 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  console.log(`CONTRACT_RESULT ${contract.name} ${classification(contract, result)}`);
}
console.log('BENCHMARK_CONTRACTS_CHECKED no new failures; exact source-bound baseline exceptions remain visible');
