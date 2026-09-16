import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {declaredValidationCapacity, withOfficialValidationExecution, withValidationCommandStage} from '../dist/core/validation-execution-lock.js';
import {canonicalizeEntries, validateResourceClaims} from '../dist/core/keyed-scheduler.js';

const root = mkdtempSync(join(tmpdir(), 'pos-resource-keys-'));
const literals = [
  {class: 'machine-cpu', key: 'heavy', access: 'exclusive'},
  {class: 'machine-process', key: 'fanout', access: 'exclusive'},
  {class: 'machine-validation', key: 'admission', access: 'shared'},
  {class: 'fixed-port', key: '43129', access: 'exclusive'},
];
try {
  execFileSync('git', ['init', '-q'], {cwd: root});
  const child = join(root, 'nested'); mkdirSync(child);
  const paths = ['fixed-path', 'runtime-lock', 'main-write-lock'].map(className =>
    ({class: className, key: 'owned', access: 'exclusive', ownership: 'runner-cleanable'}));
  const claims = [...literals, ...paths, {class: 'git-common-dir', key: '.', access: 'shared'}];
  const command = {label: 'resource-key witness', cwd: 'nested', resources: claims};
  const original = structuredClone(command);
  const capacity = declaredValidationCapacity([command, command], root);
  for (const expected of literals) {
    assert.deepEqual(capacity.resources.find(row => row.class === expected.class), expected,
      'MACHINE_CAPACITY_LITERAL_KEY_MUST_SURVIVE_NORMALIZATION');
  }
  for (const expected of paths) assert.deepEqual(capacity.resources.find(row => row.class === expected.class && row.ownership),
    {...expected, key: join(child, 'owned')}, 'path claims must still resolve against command cwd and preserve ownership');
  assert.deepEqual(command, original, 'normalization must not mutate caller declarations');
  assert.equal(capacity.resources.length, claims.length + 1, 'dedup retains the exclusive workspace claim');
  validateResourceClaims(capacity.resources, 'normalized public capacity');
  const canonical = canonicalizeEntries([{name: 'normalized', resources: capacity.resources}], root)[0];
  for (const expected of literals) assert.equal(canonical.resources.find(row => row.class === expected.class).canonicalKey,
    `${expected.class}:${expected.key}`, 'machine identities remain independent of repository paths');
  for (const bad of [
    {class: 'machine-process', key: 'other', access: 'exclusive'},
    {class: 'machine-cpu', key: 'heavy', access: 'shared'},
    {class: 'machine-validation', key: 'admission', access: 'exclusive'},
    {class: 'unknown-class', key: 'anything', access: 'shared'},
  ]) assert.throws(() => declaredValidationCapacity([{label: 'invalid', resources: [bad]}], root),
    /invalid|unknown/, 'invalid machine claims stay refused');

  // Exercise private stage normalization and real capacity acquisition directly.
  // This test proves capacity-entry keys, not descendant delegation or provider
  // execution. Those retain their independent existing contracts.
  for (const claim of literals.filter(row => row.class !== 'fixed-port')) {
    let entered = 0;
    const result = await withOfficialValidationExecution({root, workspaceRoot: root,
      command: 'resource-key witness', commandStages: true, deadlineAt: Date.now() + 60000},
    () => withValidationCommandStage({label: `live ${claim.class}`,
      resources: [claim, {class: 'fixed-path', key: root, access: 'shared'}]}, async () => {entered++; return claim.key;}));
    assert.equal(result, claim.key, `command stage must retain ${claim.class}`);
    assert.equal(entered, 1, 'valid normalized capacity must admit the callback exactly once');
  }
  console.log('VALIDATION_CAPACITY_RESOURCE_KEYS_PASS');
} finally {
  rmSync(root, {recursive: true, force: true});
}
