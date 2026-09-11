import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const orders = [
  ['verification-execution-evidence'], ['proof-admissibility'], ['store'],
  ['validation-executor'], ['proof-admissibility-gates'], ['verification'],
  ['verification-execution-evidence', 'proof-admissibility'],
  ['proof-admissibility', 'verification-execution-evidence'],
];
let registry;
for (const order of orders) {
  const source = `
    for (const name of ${JSON.stringify(order)}) {
      await import('./packages/main/dist/core/' + name + '.js');
    }
    const evidence = await import('./packages/main/dist/core/verification-execution-evidence.js');
    const proof = await import('./packages/main/dist/core/proof-admissibility.js');
    if (typeof evidence.withVerificationExecutionLocks !== 'function') throw Error('missing public lock API');
    if (evidence.VERIFICATION_RECEIPT_BUNDLE_V5 !== 'proof-or-stop.verification-receipt-bundle.v5') throw Error('changed signature schema');
    if (proof.PROOF_SURFACE_REGISTRY[0].schemaVersions[0] !== evidence.VERIFICATION_RECEIPT_BUNDLE_V5) throw Error('registry/schema mismatch');
    console.log(JSON.stringify(proof.PROOF_SURFACE_REGISTRY));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 0, `VERIFICATION_PUBLIC_IMPORT_ORDER: ${order.join(' -> ')}\n${result.error ?? ''}\n${result.stderr}`);
  if (registry !== undefined) assert.equal(result.stdout, registry, 'entry order changed proof registry');
  registry = result.stdout;
  console.log(`PASS ${order.join(' -> ')}`);
}
console.log('VERIFICATION_PUBLIC_IMPORT_ORDER_PASS: 8 fresh-process orders');
