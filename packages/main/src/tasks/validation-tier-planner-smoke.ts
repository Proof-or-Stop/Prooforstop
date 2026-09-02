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
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  PROVISIONAL_VALIDATION_COMMAND_ID_PREFIX,
  buildValidationCommandInventory,
  narrowPortableValidationCommandTuple,
  provisionalValidationCommandId,
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

function projectRootWithConfig(commandEntry: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-command-identity-'));
  temporaryRoots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'proof-or-stop.config.json'),
    `${JSON.stringify({ validate: { commands: [commandEntry] } }, null, 2)}\n`,
    'utf-8',
  );
  return root;
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

for (const root of temporaryRoots) {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${MARKER}: FAIL (${failures} case${failures === 1 ? '' : 's'} failed)`);
  process.exit(1);
}
console.log(`\n${MARKER}: PASS`);
