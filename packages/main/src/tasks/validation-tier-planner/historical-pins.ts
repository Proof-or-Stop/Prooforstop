import assert from 'node:assert/strict';




import ts from 'typescript';

import { parseLegacyValidationCommandString, resolveValidationCommandPin } from '../../core/validation-command-identity.js';




import { configuredValidationCommands } from '../../handlers/verifier.js';

import type { ValidationCommand } from '../../core/validation-types.js';














import { beginSection, testCase, command, resolvePin, pinUniverse, idOfLabel, projectRootWithCommands } from "./support.js";
export function runHistoricalPins(): void {


// ===========================================================================
// CHK-002 — canonical legacy pin resolver.
//
// Spec: same document, section "Canonical legacy pin resolver". New evidence
// pins `commandId`; historical evidence only carries a free-form `command`
// string, so exactly ONE migration resolver exists and it is owned by the same
// command normalizer routine validation uses.
//
// Resolution order (the spec's, in order):
//   1. `commandId` present  -> require an EXACT id match in the current universe.
//   2. otherwise            -> parse the legacy string with the EXISTING
//      executable/argv rule (verifier's SHELL_META_RE then splitShellWords) and
//      compare the COMPLETE normalized tuple: command, args, resolved cwd, shell
//      and the effective environment digest.
//   3. exactly one match    -> bind that id, record `pinResolution: 'legacy-exact'`
//      plus the normalized-tuple digest.
//   4. zero matches         -> STOP `pinned_command_missing`.
//   5. two or more matches  -> STOP `pinned_command_ambiguous` listing EVERY
//      candidate id. Labels and array order can never break the tie.
//   6. the resolver never rewrites historical evidence in place.
//
// Note the deliberate asymmetry with CHK-001, which these cases hold apart: the
// stable ID is the NARROW portable tuple, while PIN RESOLUTION compares the
// COMPLETE tuple including the environment. An id must survive a host change; a
// pin must not silently bind a command that would execute differently.
// ===========================================================================

beginSection('CHK-002 legacy pin resolver cases');


// ---------------------------------------------------------------------------
// (10) Step 1: an exact commandId match binds that command.
// ---------------------------------------------------------------------------
testCase('an exact commandId match resolves and is recorded as a declared-id resolution', () => {
  const commands = [
    command({ label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'lint-suite' }),
    command({ label: 'test', command: 'npm', args: ['test'], id: 'test-suite' }),
  ];
  const result = resolvePin(commands, { commandId: 'test-suite', command: 'npm run lint' });
  assert.equal(result.status, 'resolved');
  assert.equal(result.status === 'resolved' && result.commandId, 'test-suite');
  assert.equal(result.status === 'resolved' && result.pinResolution, 'declared-id');
  // The id is authoritative: the free-form string naming a DIFFERENT command is
  // never consulted once an id is present.
  assert.equal(
    result.status === 'resolved' && result.normalizedTupleDigest,
    pinUniverse(commands).entries.find((entry) => entry.id === 'test-suite')!.normalizedTupleDigest,
  );
});


testCase('an unknown commandId stops as pinned_command_missing and produces no binding', () => {
  const result = resolvePin(
    [command({ label: 'test', command: 'npm', args: ['test'], id: 'test-suite' })],
    // The legacy string WOULD match, but step 1 is authoritative: an explicit id
    // that names nothing is a stop, never a silent fall-through to string matching.
    { commandId: 'renamed-test-suite', command: 'npm test' },
  );
  assert.equal(result.status, 'stop');
  assert.equal(result.status === 'stop' && result.reason, 'pinned_command_missing');
  assert.deepEqual(result.status === 'stop' && result.candidateIds, []);
  assert.match(result.status === 'stop' ? result.message : '', /renamed-test-suite/);
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'commandId'), 'a stop must not bind a command');
});


// ---------------------------------------------------------------------------
// (11) Step 2/3: a legacy string matching exactly one command resolves.
// ---------------------------------------------------------------------------
testCase('a legacy string matching exactly one command records legacy-exact and the normalized-tuple digest', () => {
  const commands = [
    command({ label: 'lint', command: 'npm', args: ['run', 'lint'] }),
    command({ label: 'test', command: 'npm', args: ['test'] }),
  ];
  const universe = pinUniverse(commands);
  const result = resolveValidationCommandPin({ universe, evidence: { command: '  npm   test  ' } });
  assert.equal(result.status, 'resolved');
  assert.equal(result.status === 'resolved' && result.commandId, idOfLabel(universe, 'test'));
  assert.equal(result.status === 'resolved' && result.pinResolution, 'legacy-exact');
  const digest = result.status === 'resolved' ? result.normalizedTupleDigest : '';
  assert.match(digest, /^[0-9a-f]{64}$/, 'the normalized-tuple digest must be recorded');
  assert.equal(digest, universe.entries.find((entry) => entry.label === 'test')!.normalizedTupleDigest);
});


// ---------------------------------------------------------------------------
// (11b) B-a745 F-001 — THE PIN-OUTCOME SPLIT, BY WHAT THE EVIDENCE CLAIMED.
//
//   * Evidence carrying an explicit `commandId` asserts an identity in the
//     inventory's OWN namespace. An absent identity means that assertion is
//     broken, and the fail-closed matrix row "Explicit command pin does not
//     resolve" applies unchanged: STOP.
//   * Evidence carrying only a legacy free-form `command` string never asserted
//     an inventory identity at all. In a real repository most recorded evidence
//     pins a test binary or a one-off script that is legitimately not a member
//     of `validate.commands`. That is a NON-INVENTORY evidence command: it is
//     classified, listed, and widens to repository-full, and it can never be a
//     basis for pruning. Nothing is omitted on its account, so fail-closed is
//     preserved in the only sense that matters — no command is left out.
// ---------------------------------------------------------------------------
testCase('a legacy string matching nothing is a non-inventory evidence command, not a stop', () => {
  const result = resolvePin(
    [command({ label: 'test', command: 'npm', args: ['test'] })],
    { command: 'npm run build' },
  );
  assert.equal(result.status, 'non-inventory', 'a free-form string was never an inventory-identity assertion');
  assert.equal(result.status === 'non-inventory' && result.reason, 'pinned_command_non_inventory');
  assert.ok(
    result.status === 'non-inventory' && !/no longer exists|re-record/i.test(result.message),
    'the message must name the real situation, not send an operator to re-record a command that is not stale',
  );
});


testCase('an explicit unresolvable commandId still stops while an unresolvable legacy string does not', () => {
  const commands = [command({ label: 'test', command: 'npm', args: ['test'], id: 'test-suite' })];

  const byId = resolvePin(commands, { commandId: 'test-suite-renamed' });
  assert.equal(byId.status, 'stop', 'an id absent from the inventory namespace stays fail-closed');
  assert.equal(byId.status === 'stop' && byId.reason, 'pinned_command_missing');
  assert.deepEqual(byId.status === 'stop' && byId.candidateIds, []);

  const byString = resolvePin(commands, { command: 'npm run build' });
  assert.notEqual(byString.status, 'stop', 'a free-form string that names nothing is not an identity failure');

  // The split changes nothing about a legacy string that DOES resolve.
  const bound = resolvePin(commands, { command: 'npm test' });
  assert.equal(bound.status, 'resolved');
  assert.equal(bound.status === 'resolved' && bound.commandId, 'test-suite');
  assert.equal(bound.status === 'resolved' && bound.pinResolution, 'legacy-exact');
});


testCase('evidence pinning nothing at all stops as pinned_command_missing', () => {
  for (const evidence of [{}, { command: '   ' }]) {
    const result = resolvePin([command({ label: 'test', command: 'npm', args: ['test'] })], evidence);
    assert.equal(result.status, 'stop');
    assert.equal(result.status === 'stop' && result.reason, 'pinned_command_missing');
  }
});


// ---------------------------------------------------------------------------
// (12) LOAD-BEARING: two matches stop, and neither a label nor array order may
//      break the tie. A first-match or label-tiebreak implementation FAILS here.
// ---------------------------------------------------------------------------
testCase('two commands with identical normalized tuples stop as pinned_command_ambiguous listing every candidate', () => {
  const first = command({ label: 'test (legacy label)', command: 'npm', args: ['test'], id: 'test-a' });
  const second = command({ label: 'test (renamed)', command: 'npm', args: ['test'], id: 'test-b' });

  const orders: Array<[string, ValidationCommand[]]> = [
    ['forward', [first, second]],
    ['reversed', [second, first]],
  ];
  for (const [order, commands] of orders) {
    const result = resolvePin(commands, { command: 'npm test' });
    assert.equal(result.status, 'stop', `${order}: an ambiguous pin must never resolve to a first match`);
    assert.equal(result.status === 'stop' && result.reason, 'pinned_command_ambiguous', order);
    assert.deepEqual(
      result.status === 'stop' ? [...result.candidateIds].sort() : [],
      ['test-a', 'test-b'],
      `${order}: every candidate id must be listed`,
    );
    assert.ok(!Object.prototype.hasOwnProperty.call(result, 'commandId'), `${order}: a stop binds nothing`);
    assert.match(result.status === 'stop' ? result.message : '', /test-a/, order);
    assert.match(result.status === 'stop' ? result.message : '', /test-b/, order);
  }

  // A label difference alone must not break the tie: swapping which entry wears
  // which label, or making both labels identical, changes nothing.
  for (const commands of [
    [{ ...first, label: 'test (renamed)' }, { ...second, label: 'test (legacy label)' }],
    [{ ...first, label: 'same' }, { ...second, label: 'same' }],
  ]) {
    const result = resolvePin(commands, { command: 'npm test' });
    assert.equal(result.status, 'stop', 'labels are never an input to pin resolution');
    assert.equal(result.status === 'stop' && result.reason, 'pinned_command_ambiguous');
    assert.deepEqual(result.status === 'stop' ? [...result.candidateIds].sort() : [], ['test-a', 'test-b']);
  }

  // The explicit-id path still works while the tuples collide: an id is exact.
  const byId = resolvePin([first, second], { commandId: 'test-b', command: 'npm test' });
  assert.equal(byId.status === 'resolved' && byId.commandId, 'test-b');
});


// ---------------------------------------------------------------------------
// (13) The COMPLETE tuple: cwd, shell-versus-argv form and environment all make
//      two commands distinct. Each case would be ambiguous under a narrower
//      comparison, so "exactly one" is doing real work here.
// ---------------------------------------------------------------------------
testCase('commands differing only by resolved cwd are distinct', () => {
  const root = command({ label: 'test (root)', command: 'npm', args: ['test'] });
  const nested = command({ label: 'test (packages/main)', command: 'npm', args: ['test'], cwd: 'packages/main' });
  const universe = pinUniverse([root, nested]);
  assert.notEqual(
    universe.entries[0].normalizedTupleDigest,
    universe.entries[1].normalizedTupleDigest,
    'resolved cwd must be inside the normalized tuple',
  );
  const result = resolveValidationCommandPin({ universe, evidence: { command: 'npm test' } });
  assert.equal(result.status, 'resolved');
  assert.equal(result.status === 'resolved' && result.commandId, idOfLabel(universe, 'test (root)'));
});


testCase('commands differing only by shell-versus-argv form are distinct', () => {
  const argvForm = command({ label: 'test (argv)', command: 'npm', args: ['test'] });
  const shellForm = command({ label: 'test (shell)', command: 'npm test', args: [], shell: true });
  const universe = pinUniverse([argvForm, shellForm]);
  assert.notEqual(universe.entries[0].normalizedTupleDigest, universe.entries[1].normalizedTupleDigest);

  const plain = resolveValidationCommandPin({ universe, evidence: { command: 'npm test' } });
  assert.equal(plain.status === 'resolved' && plain.commandId, idOfLabel(universe, 'test (argv)'));

  // A metacharacter flips the legacy parse to the whole-string shell form, per
  // the verifier rule this resolver reuses.
  const shellUniverse = pinUniverse([
    argvForm,
    command({ label: 'test (chained)', command: 'npm test && echo done', args: [], shell: true }),
  ]);
  const chained = resolveValidationCommandPin({ universe: shellUniverse, evidence: { command: 'npm test && echo done' } });
  assert.equal(chained.status === 'resolved' && chained.commandId, idOfLabel(shellUniverse, 'test (chained)'));
});


testCase('commands differing only by their environment overlay are distinct', () => {
  // Both must DECLARE an id: the environment is deliberately outside the narrow
  // portable id (CHK-001), so two commands differing only by their overlay would
  // otherwise collide as duplicate provisional ids. That is the asymmetry these
  // two items hold apart — narrow for identity, complete for pin resolution.
  const plain = command({ label: 'test', command: 'npm', args: ['test'], id: 'test-plain' });
  const overlaid = command({ label: 'test (CI)', command: 'npm', args: ['test'], env: { CI: '1' }, id: 'test-ci' });
  const universe = pinUniverse([plain, overlaid]);
  assert.notEqual(
    universe.entries[0].normalizedTupleDigest,
    universe.entries[1].normalizedTupleDigest,
    'the effective environment digest must be inside the normalized tuple',
  );
  const result = resolveValidationCommandPin({ universe, evidence: { command: 'npm test' } });
  assert.equal(result.status, 'resolved');
  assert.equal(result.status === 'resolved' && result.commandId, idOfLabel(universe, 'test'));
});


// ---------------------------------------------------------------------------
// (14) The legacy parse is the VERIFIER's parse, not a second one.
// ---------------------------------------------------------------------------
testCase('the legacy string parse is byte-for-byte the rule configuredValidationCommands uses', () => {
  const cases = ['npm test', "node -e 'hello world'", 'npm test && echo done', 'npm run lint | tee log'];
  for (const raw of cases) {
    // A raw STRING entry is what exercises verifier's commandFromString.
    const [configured] = configuredValidationCommands(projectRootWithCommands([raw]));
    const parsed = parseLegacyValidationCommandString(raw);
    assert.ok(parsed, `${raw} must parse`);
    assert.equal(parsed!.command, configured.command, raw);
    assert.deepEqual(parsed!.args, configured.args, raw);
    assert.equal(parsed!.shell, configured.shell === true, raw);
  }
  assert.deepEqual(
    parseLegacyValidationCommandString('npm test && echo done'),
    { command: 'npm test && echo done', args: [], shell: true },
    'a metacharacter makes the WHOLE string the command with no args',
  );
  assert.equal(parseLegacyValidationCommandString('   '), null);
});


// ---------------------------------------------------------------------------
// (15) The resolver never rewrites historical evidence in place.
// ---------------------------------------------------------------------------
testCase('resolving a legacy pin never mutates the evidence it was handed', () => {
  const commands = [command({ label: 'test', command: 'npm', args: ['test'], id: 'test-suite' })];
  const evidence = Object.freeze({ intentRef: 'CHK-001:happy:0', command: 'npm test' });
  const snapshot = JSON.stringify(evidence);
  const result = resolvePin(commands, evidence);
  assert.equal(result.status === 'resolved' && result.commandId, 'test-suite');
  assert.equal(JSON.stringify(evidence), snapshot, 'historical evidence must not be migrated in place');
  assert.equal((evidence as { commandId?: string }).commandId, undefined);
});


// ---------------------------------------------------------------------------
// (16) Handler encoding convention: the schema constraint is the first line of
//      defence only, so the resolver re-validates a bypassing caller's input.
// ---------------------------------------------------------------------------
testCase('a malformed commandId is rejected at the resolver entry, not silently treated as absent', () => {
  const commands = [command({ label: 'test', command: 'npm', args: ['test'], id: 'test-suite' })];
  for (const commandId of ['', '   ']) {
    assert.throws(() => resolvePin(commands, { commandId, command: 'npm test' }), /commandId/);
  }
  assert.throws(
    () => resolvePin(commands, { commandId: 7 as unknown as string, command: 'npm test' }),
    /commandId/,
    'a schema-bypassing non-string must still be rejected',
  );
  assert.throws(
    () => resolvePin(commands, { command: 7 as unknown as string }),
    /command/,
    'a schema-bypassing non-string legacy command must still be rejected',
  );
});
}
