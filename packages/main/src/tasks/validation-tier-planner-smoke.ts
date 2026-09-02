#!/usr/bin/env node
/**
 * B-a745 Story 1 fixture suite — stable validation command identity.
 *
 * Spec: `docs/requirements/decisions/story-relevance-dynamic-validation-tiers-execution-plan.md`
 * sections "Stable command identity" and "Compatibility with existing truth sources"
 * (owned by story B-ccf4, not yet on main). Chosen design: `A-narrow-portable-id`.
 *
 * CHK-001 cases proven here:
 *   (1) DECLARED vs PROVISIONAL — a declared `id` survives verbatim; a command that
 *       declares none receives a deterministic `prov-` id derived from the NARROW
 *       portable tuple {command, args, cwdRelative, shell}.
 *   (2) SHARED SHELL RULE — the tuple's `shell` is the same value
 *       `buildRoutineValidationIdentity` binds (`shell === true || platform === 'win32'`),
 *       across injected platforms. There must not be a second shell rule.
 *   (3) COMMAND-SET DIGEST — two independent computations over the same set agree, and
 *       mutating ANY normalized digest field changes the digest.
 *   (4) DUPLICATES — two commands with identical narrow tuples are a hard error naming
 *       BOTH entries. Never deduped, never silently coexisting. Declared duplicates too.
 *   (5) POSITION INDEPENDENCE — moving a command to another array index does not change
 *       its provisional id. Identity is never derived from the index.
 *   (6) LABEL RENAME (load-bearing) — renaming ONLY a label leaves that command's stable
 *       id UNCHANGED and CHANGES the commandSetDigest. Both halves in one case.
 *   (7) MIGRATION WARNING — present while any command still relies on a provisional id,
 *       naming the count queried at emit time; absent once every command declares one.
 *   (8) ROUTINE-IDENTITY REGRESSION GUARD (adversarial) — the optional `id` field leaves
 *       the existing routine validation identity digest BYTE-IDENTICAL, while declaring
 *       an id in the project config DOES change `source.inputDigest`. Together they prove
 *       the new identity can only ADD refusal conditions, never remove one.
 *   (9) RESERVED PREFIX + RUNTIME RE-VALIDATION — a declared id may not usurp the `prov-`
 *       namespace, and the refusal holds on schema-bypassing paths (Handler convention).
 *
 * CHK-002 cases proven here (section "Canonical legacy pin resolver"):
 *  (10) EXACT ID — evidence carrying `commandId` binds by exact id and never falls
 *       through to string matching; an unknown id is a STOP, not a silent retry.
 *  (11) LEGACY EXACT — a free-form `command` string matching exactly one command binds
 *       it, recording `pinResolution: 'legacy-exact'` plus the normalized-tuple digest.
 *  (12) AMBIGUITY (load-bearing) — two or more matches STOP as
 *       `pinned_command_ambiguous` listing EVERY candidate id, in either array order
 *       and under any labelling. A first-match or label-tiebreak resolver fails here.
 *  (13) COMPLETE TUPLE — resolved cwd, shell-versus-argv form and the effective
 *       environment each make two commands distinct, so "exactly one" means something.
 *  (14) ONE PARSER — the legacy string parse is byte-for-byte the rule
 *       `configuredValidationCommands` already uses, not a second tokenizer.
 *  (15) NO IN-PLACE MIGRATION — resolving never mutates the evidence it was handed.
 *  (16) RUNTIME RE-VALIDATION — a schema-bypassing malformed pin is still rejected.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  PROVISIONAL_VALIDATION_COMMAND_ID_PREFIX,
  buildValidationCommandInventory,
  buildValidationPinUniverse,
  narrowPortableValidationCommandTuple,
  parseLegacyValidationCommandString,
  provisionalValidationCommandId,
  resolveValidationCommandPin,
  type ValidationPinResolutionResult,
} from '../core/validation-command-identity.js';
import {
  buildRoutineValidationIdentity,
  validationCommandUsesShell,
  validationIdentityDigest,
} from '../core/validation-evidence-reuse.js';
import { configuredValidationCommands, sourceInputSnapshot } from '../handlers/verifier.js';
import type { ValidationCommand } from '../core/validation-types.js';

const MARKER = 'validation-tier-planner-smoke';
const ROOT = '/repo';

let failures = 0;

function testCase(name: string, run: () => void): void {
  try {
    run();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function command(overrides: Partial<ValidationCommand> & { label: string; command: string }): ValidationCommand {
  return { args: [], ...overrides };
}

function inventory(commands: ValidationCommand[], platform: NodeJS.Platform = 'linux') {
  return buildValidationCommandInventory({ projectRoot: ROOT, commands, platform });
}

function routineIdentityArgs(projectRoot: string, commands: ValidationCommand[], sourceInputs: unknown) {
  return {
    projectRoot,
    sourceKind: 'configured' as const,
    sourceInputs,
    commands,
    profile: 'balanced',
    verificationPolicyInputs: { fixture: true },
    processEnvironment: { PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv,
    platform: 'linux' as NodeJS.Platform,
  };
}

const temporaryRoots: string[] = [];

function projectRootWithCommands(entries: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-command-identity-'));
  temporaryRoots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'proof-or-stop.config.json'),
    `${JSON.stringify({ validate: { commands: entries } }, null, 2)}\n`,
    'utf-8',
  );
  return root;
}

function projectRootWithConfig(commandEntry: Record<string, unknown>): string {
  return projectRootWithCommands([commandEntry]);
}

console.log(`${MARKER}: running CHK-001 stable command identity cases`);

// ---------------------------------------------------------------------------
// (1) A declared id survives verbatim; an undeclared one becomes a `prov-` id.
// ---------------------------------------------------------------------------
testCase('declared id is preserved verbatim and is not marked provisional', () => {
  const result = inventory([
    command({ label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'lint-suite' }),
  ]);
  assert.equal(result.entries[0].id, 'lint-suite');
  assert.equal(result.entries[0].provisional, false);
  assert.equal(result.provisionalCount, 0);
  assert.equal(result.declaredCount, 1);
});

testCase('undeclared id becomes a deterministic prov- id over the narrow portable tuple', () => {
  const entry = command({ label: 'lint', command: 'npm', args: ['run', 'lint'] });
  const result = inventory([entry]);
  const id = result.entries[0].id;
  assert.ok(id.startsWith(PROVISIONAL_VALIDATION_COMMAND_ID_PREFIX), `expected prov- prefix, got ${id}`);
  assert.equal(result.entries[0].provisional, true);

  const tuple = narrowPortableValidationCommandTuple({ projectRoot: ROOT, command: entry, platform: 'linux' });
  assert.deepEqual(tuple, { command: 'npm', args: ['run', 'lint'], cwdRelative: '.', shell: false });
  assert.equal(id, provisionalValidationCommandId(tuple));
  // Deterministic across independent computations.
  assert.equal(id, inventory([entry]).entries[0].id);
});

testCase('the narrow tuple carries a repo-relative cwd, so an absolute and a relative cwd agree', () => {
  const relativeCwd = command({ label: 'a', command: 'npm', args: ['test'], cwd: 'packages/main' });
  const absoluteCwd = command({ label: 'b', command: 'npm', args: ['test'], cwd: resolve(ROOT, 'packages/main') });
  const left = narrowPortableValidationCommandTuple({ projectRoot: ROOT, command: relativeCwd, platform: 'linux' });
  const right = narrowPortableValidationCommandTuple({ projectRoot: ROOT, command: absoluteCwd, platform: 'linux' });
  assert.equal(left.cwdRelative, 'packages/main');
  assert.deepEqual(left, right);
  assert.equal(provisionalValidationCommandId(left), provisionalValidationCommandId(right));
});

// ---------------------------------------------------------------------------
// (2) The shell rule is the routine identity's rule, not a second one.
// ---------------------------------------------------------------------------
testCase('tuple shell matches the routine identity shell rule on every platform', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as NodeJS.Platform[]) {
    for (const shell of [undefined, true, false]) {
      const entry = command({ label: 'x', command: 'npm', args: ['test'], ...(shell === undefined ? {} : { shell }) });
      const tuple = narrowPortableValidationCommandTuple({ projectRoot: ROOT, command: entry, platform });
      assert.equal(
        tuple.shell,
        validationCommandUsesShell(entry, platform),
        `tuple shell disagrees with the shared rule on ${platform} shell=${String(shell)}`,
      );
      assert.equal(tuple.shell, entry.shell === true || platform === 'win32');
    }
  }
});

// ---------------------------------------------------------------------------
// (3) commandSetDigest: stable across computations, sensitive to every field.
// ---------------------------------------------------------------------------
testCase('commandSetDigest is identical across two independent computations', () => {
  const commands = [
    command({ label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'lint-suite' }),
    command({ label: 'test', command: 'npm', args: ['test'], cwd: 'packages/main', timeoutMs: 1000, optional: true, focus: ['fast'] }),
  ];
  assert.equal(inventory(commands).commandSetDigest, inventory(commands).commandSetDigest);
  assert.equal(inventory(commands).commandSetDigest, inventory([...commands]).commandSetDigest);
});

testCase('changing any normalized digest field changes the commandSetDigest', () => {
  const base = command({
    label: 'test',
    command: 'npm',
    args: ['test'],
    cwd: 'packages/main',
    timeoutMs: 1000,
    optional: true,
    focus: ['fast'],
    id: 'test-suite',
  });
  const baseline = inventory([base]).commandSetDigest;
  const mutations: Array<[string, ValidationCommand]> = [
    ['id', { ...base, id: 'test-suite-2' }],
    ['label', { ...base, label: 'unit test' }],
    ['command', { ...base, command: 'pnpm' }],
    ['args', { ...base, args: ['test', '--watch=false'] }],
    ['cwdRelative', { ...base, cwd: 'packages/utils' }],
    ['shell', { ...base, shell: true }],
    ['timeoutMs', { ...base, timeoutMs: 2000 }],
    ['optional', { ...base, optional: false }],
    ['focus', { ...base, focus: ['slow'] }],
  ];
  for (const [field, mutated] of mutations) {
    assert.notEqual(inventory([mutated]).commandSetDigest, baseline, `${field} must be inside the commandSetDigest`);
  }
});

// ---------------------------------------------------------------------------
// (4) Duplicates are a hard error naming both entries.
// ---------------------------------------------------------------------------
testCase('two identical narrow tuples are rejected as duplicates naming both entries', () => {
  const commands = [
    command({ label: 'lint (legacy label)', command: 'npm', args: ['run', 'lint'] }),
    command({ label: 'lint (new label)', command: 'npm', args: ['run', 'lint'] }),
  ];
  assert.throws(
    () => inventory(commands),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /lint \(legacy label\)/, 'first entry must be named');
      assert.match(message, /lint \(new label\)/, 'second entry must be named');
      assert.match(message, /\[0\]/);
      assert.match(message, /\[1\]/);
      return true;
    },
  );
});

testCase('two declared ids that collide are rejected as duplicates naming both entries', () => {
  const commands = [
    command({ label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'same' }),
    command({ label: 'test', command: 'npm', args: ['test'], id: 'same' }),
  ];
  assert.throws(
    () => inventory(commands),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /"same"/, 'the colliding id must be named');
      assert.match(message, /"lint" \(validate\.commands\[0\]\)/, 'first entry must be named');
      assert.match(message, /"test" \(validate\.commands\[1\]\)/, 'second entry must be named');
      return true;
    },
  );
});

testCase('a declared id colliding with another command provisional id is rejected', () => {
  const undeclared = command({ label: 'lint', command: 'npm', args: ['run', 'lint'] });
  const provisionalId = inventory([undeclared]).entries[0].id;
  assert.throws(
    () => inventory([undeclared, command({ label: 'test', command: 'npm', args: ['test'], id: provisionalId })]),
    /prov-/,
  );
});

// ---------------------------------------------------------------------------
// (5) Identity never comes from the array index.
// ---------------------------------------------------------------------------
testCase('moving a command to another array position does not change its provisional id', () => {
  const lint = command({ label: 'lint', command: 'npm', args: ['run', 'lint'] });
  const test = command({ label: 'test', command: 'npm', args: ['test'] });
  const forward = inventory([lint, test]);
  const reversed = inventory([test, lint]);
  const idOf = (result: ReturnType<typeof inventory>, label: string) =>
    result.entries.find((entry) => entry.label === label)!.id;
  assert.equal(idOf(forward, 'lint'), idOf(reversed, 'lint'));
  assert.equal(idOf(forward, 'test'), idOf(reversed, 'test'));
  assert.equal(forward.entries[0].index, 0);
  assert.equal(forward.entries[1].index, 1);
});

// ---------------------------------------------------------------------------
// (6) LOAD-BEARING: label rename keeps the id, changes the commandSetDigest.
// ---------------------------------------------------------------------------
testCase('renaming ONLY a label keeps the stable id and changes the commandSetDigest', () => {
  const before = command({ label: 'old label', command: 'npm', args: ['run', 'lint'] });
  const after = { ...before, label: 'new label' };
  const beforeResult = inventory([before]);
  const afterResult = inventory([after]);
  assert.equal(afterResult.entries[0].id, beforeResult.entries[0].id, 'stable id must survive a label rename');
  assert.notEqual(
    afterResult.commandSetDigest,
    beforeResult.commandSetDigest,
    'a label rename must invalidate the selection command-set digest',
  );

  // Same for a command whose id is declared: the declared id also survives.
  const declaredBefore = command({ label: 'old', command: 'npm', args: ['test'], id: 'test-suite' });
  const declaredAfter = { ...declaredBefore, label: 'new' };
  assert.equal(inventory([declaredAfter]).entries[0].id, inventory([declaredBefore]).entries[0].id);
  assert.notEqual(inventory([declaredAfter]).commandSetDigest, inventory([declaredBefore]).commandSetDigest);
});

// ---------------------------------------------------------------------------
// (7) Migration warning, with the count queried at emit time.
// ---------------------------------------------------------------------------
testCase('a migration warning names the runtime count of commands still lacking a declared id', () => {
  const declared = command({ label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'lint-suite' });
  const undeclaredA = command({ label: 'test', command: 'npm', args: ['test'] });
  const undeclaredB = command({ label: 'types', command: 'npx', args: ['tsc', '--noEmit'] });

  const twoProvisional = inventory([declared, undeclaredA, undeclaredB]);
  assert.equal(twoProvisional.provisionalCount, 2);
  assert.equal(twoProvisional.warnings.length, 1);
  assert.match(twoProvisional.warnings[0], /\b2\b/);
  assert.match(twoProvisional.warnings[0], /\b3\b/);

  const oneProvisional = inventory([declared, undeclaredA, { ...undeclaredB, id: 'type-check' }]);
  assert.equal(oneProvisional.provisionalCount, 1);
  assert.equal(oneProvisional.warnings.length, 1);
  assert.match(oneProvisional.warnings[0], /\b1\b/);
  assert.doesNotMatch(oneProvisional.warnings[0], /\b2 of\b/);
});

testCase('the migration warning is absent once every command declares an id', () => {
  const result = inventory([
    command({ label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'lint-suite' }),
    command({ label: 'test', command: 'npm', args: ['test'], id: 'test-suite' }),
  ]);
  assert.equal(result.provisionalCount, 0);
  assert.deepEqual(result.warnings, []);
});

// ---------------------------------------------------------------------------
// (9) A declared id may not usurp the reserved provisional namespace, and the
//     refusal holds on schema-bypassing paths.
// ---------------------------------------------------------------------------
testCase('a declared id in the reserved prov- namespace is rejected at both layers', () => {
  assert.throws(
    () => inventory([command({ label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'prov-forged' })]),
    /prov-/,
  );
  assert.throws(
    () => inventory([command({ label: 'lint', command: 'npm', args: ['run', 'lint'], id: '   ' })]),
    /id/,
  );
  const root = projectRootWithConfig({ label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'prov-forged' });
  assert.throws(() => configuredValidationCommands(root), /prov-/);
});

// ---------------------------------------------------------------------------
// (8) ADVERSARIAL: the routine validation identity is unchanged by the new
//     optional field, while declaring an id in config still invalidates reuse.
// ---------------------------------------------------------------------------
testCase('configuredValidationCommands parses a declared id from project config', () => {
  const root = projectRootWithConfig({ label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'lint-suite' });
  const commands = configuredValidationCommands(root);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].id, 'lint-suite');
});

testCase('the optional id leaves the routine identity digest byte-identical, while declaring it in config changes source.inputDigest', () => {
  const rootWithout = projectRootWithConfig({ label: 'lint', command: 'npm', args: ['run', 'lint'] });
  const rootWith = projectRootWithConfig({ label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'lint-suite' });

  const commandsWithout = configuredValidationCommands(rootWithout);
  const commandsWith = configuredValidationCommands(rootWith);
  assert.equal(commandsWithout[0].id, undefined);
  assert.equal(commandsWith[0].id, 'lint-suite');

  const snapshotWithout = sourceInputSnapshot(rootWithout, 'configured');
  const snapshotWith = sourceInputSnapshot(rootWith, 'configured');

  // Half 1: the per-command projection is an explicit field list with no spread,
  // so the new field cannot enter the digest. Hold the source inputs and the
  // project root fixed and vary ONLY the presence of `id` on the commands.
  const baseline = buildRoutineValidationIdentity(routineIdentityArgs(rootWithout, commandsWithout, snapshotWithout));
  const withIdField = buildRoutineValidationIdentity(routineIdentityArgs(rootWithout, commandsWith, snapshotWithout));
  assert.equal(withIdField.digest, baseline.digest, 'the optional id must not enter the routine identity digest');
  assert.deepEqual(withIdField.commands, baseline.commands);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(baseline.commands[0], 'id'),
    'the routine identity command projection must not carry an id key',
  );

  // Half 2: `sourceInputSnapshot` hashes the raw config file contents, so actually
  // declaring the id in the project config DOES change source.inputDigest — the new
  // identity can only ADD a refusal condition, never remove one.
  assert.notEqual(validationIdentityDigest(snapshotWith), validationIdentityDigest(snapshotWithout));
  const withConfig = buildRoutineValidationIdentity(routineIdentityArgs(rootWithout, commandsWith, snapshotWith));
  assert.notEqual(withConfig.source.inputDigest, baseline.source.inputDigest);
  assert.notEqual(withConfig.digest, baseline.digest);
  assert.deepEqual(withConfig.commands, baseline.commands, 'only the source input digest may differ');
});

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

console.log(`${MARKER}: running CHK-002 legacy pin resolver cases`);

const PIN_ENVIRONMENT = { PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv;

function pinUniverse(commands: ValidationCommand[], platform: NodeJS.Platform = 'linux') {
  return buildValidationPinUniverse({
    projectRoot: ROOT,
    commands,
    processEnvironment: PIN_ENVIRONMENT,
    platform,
  });
}

function resolvePin(
  commands: ValidationCommand[],
  evidence: { commandId?: string; command?: string },
): ValidationPinResolutionResult {
  return resolveValidationCommandPin({ universe: pinUniverse(commands), evidence });
}

function idOfLabel(universe: ReturnType<typeof pinUniverse>, label: string): string {
  return universe.entries.find((entry) => entry.label === label)!.id;
}

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

testCase('a legacy string matching nothing stops as pinned_command_missing with no plan', () => {
  const result = resolvePin(
    [command({ label: 'test', command: 'npm', args: ['test'] })],
    { command: 'npm run build' },
  );
  assert.equal(result.status, 'stop');
  assert.equal(result.status === 'stop' && result.reason, 'pinned_command_missing');
  assert.deepEqual(result.status === 'stop' && result.candidateIds, []);
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
  const plain = command({ label: 'test', command: 'npm', args: ['test'] });
  const overlaid = command({ label: 'test (CI)', command: 'npm', args: ['test'], env: { CI: '1' } });
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

for (const root of temporaryRoots) {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${MARKER}: FAIL (${failures} case${failures === 1 ? '' : 's'} failed)`);
  process.exit(1);
}
console.log(`\n${MARKER}: PASS`);
