import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';

import { PROVISIONAL_VALIDATION_COMMAND_ID_PREFIX, buildValidationCommandInventory, buildValidationPinUniverse, narrowPortableValidationCommandTuple, provisionalValidationCommandId } from '../../core/validation-command-identity.js';



import {
  buildRoutineValidationIdentity,
  validationCommandUsesShell,
  validationIdentityDigest,
} from '../../core/validation-evidence-reuse.js';
import { configuredValidationCommands, sourceInputSnapshot } from '../../handlers/verifier.js';
import { buildValidationImpactIndexFromCatalog } from '../../core/validation-tier-planner.js';
import type { ValidationCommand } from '../../core/validation-types.js';









import { compileValidationCatalog, discoverValidationInventory } from '../../core/story-aware-validation.js';




import { beginSection, testCase, inventory, command, projectRootWithConfig, F023_ROOTS, inventoryUnderRoot, temporaryRoots, ROOT, gitOutput, PORTABILITY_PLATFORMS, universeOn, routineIdentityArgs } from "./support.js";
export function runCommandIdentity(): void {


beginSection('CHK-001 stable command identity cases');


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

  const tuple = narrowPortableValidationCommandTuple({ command: entry });
  assert.deepEqual(tuple, { command: 'npm', args: ['run', 'lint'], cwdRelative: '.', shell: false });
  assert.equal(id, provisionalValidationCommandId(tuple));
  assert.equal(
    provisionalValidationCommandId({ command: 'npm', args: ['test'], cwdRelative: '.', shell: false }),
    'prov-130bad3c5e1e0805ebdd86d3fa133efcc03f4dd859ace2d5aa594ee5ed735c51',
    'the portable ID canonicalization must retain this cross-module compatibility vector',
  );
  // Deterministic across independent computations.
  assert.equal(id, inventory([entry]).entries[0].id);
});


testCase('configured cwd and shell use one portable identity in planner and runtime inventories', () => {
  const root = projectRootWithConfig({
    label: 'cwd-shell', command: 'node', args: ['task.js'], cwd: 'packages/main', shell: true,
  });
  const configured = configuredValidationCommands(root);
  const planner = buildValidationCommandInventory({ commands: configured });
  const runtime = discoverValidationInventory(root);
  assert.equal(configured.length, 1, 'cwd + shell configuration must retain exactly one command');
  assert.equal(planner.entries.length, 1, 'planner inventory must retain the configured cwd + shell command');
  assert.equal(runtime.commands.length, 1, 'runtime inventory must retain the configured cwd + shell command');
  assert.deepEqual(narrowPortableValidationCommandTuple({ command: configured[0] }), {
    command: 'node', args: ['task.js'], cwdRelative: 'packages/main', shell: true,
  }, 'portable identity must bind the declared cwd and shell tuple');
  assert.equal(runtime.commands[0].id, planner.entries[0].id);
  const catalog = compileValidationCatalog(runtime);
  const index = buildValidationImpactIndexFromCatalog({ commandSetDigest: planner.commandSetDigest, catalog });
  assert.equal(index.entries.length, 1, 'impact index must retain the configured cwd + shell command');
  assert.equal(index.entries[0].commandId, planner.entries[0].id);
  assert.notEqual(index.entries[0].coverage, 'complete', 'heuristic roots remain partial even when policy fields exist');
});


testCase('F-023: the same relative declared cwd yields one provisional id and one commandSetDigest from two project roots', () => {
  const entry = command({ label: 'unit', command: 'npm', args: ['test'], cwd: 'packages/main' });
  const results = F023_ROOTS.map((projectRoot) => inventoryUnderRoot(projectRoot, [entry]));
  assert.equal(new Set(results.map((result) => result.entries[0].id)).size, 1, 'the provisional id must not depend on the project root');
  assert.equal(new Set(results.map((result) => result.commandSetDigest)).size, 1, 'the commandSetDigest must not depend on the project root');
  assert.equal(results[0].entries[0].tuple.cwdRelative, 'packages/main');
});


testCase('F-023: the declared cwd literal is posix-normalized so cosmetic spellings agree and absent means "."', () => {
  const spellings = ['packages/main', './packages/main', 'packages/main/', 'packages//main', 'packages\\main'];
  const ids = spellings.map((cwd) => inventory([command({ label: 'unit', command: 'npm', args: ['test'], cwd })]).entries[0].id);
  assert.equal(new Set(ids).size, 1, `cosmetic spellings of the same declared cwd must share one id, got ${ids.join(', ')}`);
  for (const cwd of spellings) {
    assert.equal(narrowPortableValidationCommandTuple({ command: command({ label: 'x', command: 'npm', cwd }) }).cwdRelative, 'packages/main');
  }
  assert.equal(narrowPortableValidationCommandTuple({ command: command({ label: 'x', command: 'npm' }) }).cwdRelative, '.');
  assert.equal(narrowPortableValidationCommandTuple({ command: command({ label: 'x', command: 'npm', cwd: '.' }) }).cwdRelative, '.');
  assert.equal(narrowPortableValidationCommandTuple({ command: command({ label: 'x', command: 'npm', cwd: './' }) }).cwdRelative, '.');
});


testCase('F-023: an absolute declared cwd is hashed as its literal, is location-independent, and is named in an inventory warning', () => {
  const absoluteCwd = '/opt/build/packages/main';
  const entry = command({ label: 'unit', command: 'npm', args: ['test'], cwd: absoluteCwd });
  const results = F023_ROOTS.map((projectRoot) => inventoryUnderRoot(projectRoot, [entry]));
  assert.equal(
    new Set(results.map((result) => result.entries[0].id)).size,
    1,
    `an absolute declared cwd must give ONE id regardless of where the checkout lives, got ${results.map((r) => r.entries[0].id).join(', ')}`,
  );
  assert.equal(new Set(results.map((result) => result.commandSetDigest)).size, 1, 'the commandSetDigest must not depend on the project root');
  const [reference] = results;
  assert.equal(reference.entries[0].tuple.cwdRelative, absoluteCwd, 'the portable tuple carries the declared literal, never a relativized path');
  assert.equal(
    reference.entries[0].id,
    provisionalValidationCommandId({ command: 'npm', args: ['test'], cwdRelative: absoluteCwd, shell: false }),
    'the id must equal hashing the declared literal',
  );
  for (const result of results) {
    const warning = result.warnings.find((text) => text.includes(absoluteCwd));
    assert.ok(warning, `the inventory must warn about the absolute declared cwd, got warnings: ${JSON.stringify(result.warnings)}`);
    assert.match(warning!, /"unit"/, 'the warning must name the command');
    assert.match(warning!, /validate\.commands\[0\]/, 'the warning must locate the command');
    assert.match(warning!, /absolute/i);
    assert.match(warning!, /portable/i);
  }
  // A declared id does not exempt the digest from being location-bound, so it still warns.
  const declaredId = buildValidationCommandInventory({ commands: [{ ...entry, id: 'unit-suite' }] });
  assert.ok(declaredId.warnings.some((text) => text.includes(absoluteCwd)), 'an absolute cwd warns even with a declared id');
  // A relative declaration never triggers it.
  const relativeOnly = inventory([command({ label: 'unit', command: 'npm', args: ['test'], cwd: 'packages/main', id: 'unit-suite' })]);
  assert.deepEqual(relativeOnly.warnings, []);
});


testCase('F-023: a symlinked alias of the project root yields the same provisional id and commandSetDigest', () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'proof-or-stop-f023-real-')));
  temporaryRoots.push(real);
  mkdirSync(join(real, 'packages', 'main'), { recursive: true });
  const aliasParent = mkdtempSync(join(tmpdir(), 'proof-or-stop-f023-alias-'));
  temporaryRoots.push(aliasParent);
  const alias = join(aliasParent, 'checkout');
  symlinkSync(real, alias, 'dir');
  assert.notEqual(alias, real);
  assert.equal(realpathSync(alias), real, 'the alias must reach the same checkout');

  for (const cwd of ['packages/main', join(real, 'packages', 'main')]) {
    const entry = command({ label: 'unit', command: 'npm', args: ['test'], cwd });
    const viaReal = inventoryUnderRoot(real, [entry]);
    const viaAlias = inventoryUnderRoot(alias, [entry]);
    assert.equal(viaAlias.entries[0].id, viaReal.entries[0].id, `declared cwd ${JSON.stringify(cwd)}: the id must not depend on which alias of the checkout was used`);
    assert.equal(viaAlias.commandSetDigest, viaReal.commandSetDigest, `declared cwd ${JSON.stringify(cwd)}: the commandSetDigest must not depend on the alias`);
  }
});


testCase('F-023: the COMPLETE runtime tuple still carries the resolved absolute cwd for both declaration forms', () => {
  const absoluteCwd = resolve(ROOT, 'packages', 'main');
  const relativeEntry = command({ label: 'a', command: 'npm', args: ['test'], cwd: 'packages/main' });
  const absoluteEntry = command({ label: 'b', command: 'npm', args: ['test'], cwd: absoluteCwd });
  const universe = buildValidationPinUniverse({
    projectRoot: ROOT,
    commands: [relativeEntry, absoluteEntry],
    processEnvironment: { PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv,
    platform: 'linux',
  });
  const [relativeUnit, absoluteUnit] = universe.entries;
  assert.equal(relativeUnit.completeTuple.cwd, absoluteCwd, 'a relative declaration resolves against the project root at runtime');
  assert.equal(absoluteUnit.completeTuple.cwd, absoluteCwd, 'an absolute declaration is executed exactly where it points');
  // Same executable tuple: a legacy pin naming the command would be ambiguous between them,
  // which is the runtime side saying "these run in the same place" while the portable side keeps them distinct.
  assert.equal(relativeUnit.normalizedTupleDigest, absoluteUnit.normalizedTupleDigest);
  assert.notEqual(relativeUnit.id, absoluteUnit.id, 'the portable side hashes the declared literal, so the two declarations differ');
});


// PIN MAINTENANCE: the digest below is the commandSetDigest of the REAL
// proof-or-stop.config.json validate.commands inventory, so it moves whenever
// validate.commands changes (an entry added, removed, relabelled or
// re-argued). That is expected; re-pin it to the value the current inventory
// produces through this same code path (configuredValidationCommands ->
// buildValidationCommandInventory) and say in the commit what moved it. The
// case still guards what it was written for: no declared cwd and no
// absolute-cwd warning. History: B-a745 pinned eba363ed...; B-41c8 CHK-004
// (the item that registered single-owner-extraction-smoke in validate.commands)
// added that entry, moving it to 791165cf... (B-41c8 F-006). B-dc2e CHK-001
// (the item that registered validation-protocol-smoke in validate.commands)
// added that entry, moving it to 056e47fd.... B-fe8f CHK-001 registered the
// Finding ledger/runtime integrity RED guard, while B-1482 CHK-003 registered
// test:narrowing-repin. The combined inventory retains both entries and moves
// the digest to 5da99a65.... Name the story and item here,
// Lab U01–U18 expands the registered inventory from 134 to 153 commands,
// including explicit fixture wrappers and independently registered suite members.
// Recomputed through configuredValidationCommands -> buildValidationCommandInventory.
// added that entry, moving it to 056e47fd.... B-1482 CHK-003 (the item that
// registered test:narrowing-repin in validate.commands) added that entry,
// moving it to d98a2288.... B-aa5f CHK-004 registered the process-fact and
// runtime-fact contract verifiers in validate.commands, moving it to
// 30913585.... B-fe8f CHK-001 also registers the Finding Ledger/runtime
// integrity guard; retain its entry in the union. Name the story and item here,
// never a commit hash: a branch rewrite orphans the hash and a later
// `git show` of it reports a bad object (B-41c8 F-012).
testCase('F-023: the REAL inventory stays pinned and cwd-neutral, with no absolute-cwd warning', () => {
  const repoRoot = (gitOutput(['rev-parse', '--show-toplevel']) ?? '').trim();
  assert.ok(repoRoot, 'this guard reads the real repository inventory; a missing repository is a failure, not a skip');
  const commands = configuredValidationCommands(repoRoot);
  assert.ok(commands.length > 0);
  assert.deepEqual(commands.filter((entry) => entry.cwd !== undefined).map((entry) => entry.label), [], 'this repository declares no cwd on any command');
  const real = buildValidationCommandInventory({ commands });
  // main merge 4 (B-aa5f): main's 128-command policy-annotated inventory and
  // B-aa5f's two receipt-contract verifiers were both retained, producing the
  // 130-command union. A normalized command+argv comparison confirmed zero
  // commands from either parent were dropped before this digest was repinned.
  // B-fe8f + current main merge: the Finding ledger/runtime integrity command
  // joins main's 128 commands without dropping either side, producing the
  // 129-entry union and moving the digest to 6dfd3360....
  // Absent cwd posix-normalizes to "." (see the spellings case above), so declaring "." explicitly on
  // every entry must reach the same digest: the real inventory is not bound to any checkout location.
  const explicitDot = buildValidationCommandInventory({ commands: commands.map((entry) => ({ ...entry, cwd: '.' })) });
  assert.equal(real.commandSetDigest, explicitDot.commandSetDigest, 'the real commandSetDigest must equal the digest of the same commands with an explicit "." cwd');
  // B-e256 CHK-002/F-044 contributes the stable-id global CLI executable-bit
  // regression row. The merge also retains current main's B-fe8f Finding-ledger
  // guard and B-1482 narrowing-repin command: that upstream inventory has 133 entries.
  // origin/main merge 3 (B-1482): moved again to 511e1906... because origin added one
  // more validate.commands entry; the union is now 128. Verified before repinning that
  // NO origin-only entry was dropped. Earlier notes retained below.
  // origin/main merge 2 (B-9a49): moved again to d30d7b92... because origin added one
  // more validate.commands entry, taking the union from 126 to 127. Verified before
  // repinning that NO origin-only entry was dropped this time (the check that caught the
  // previous merge losing two). Earlier note retained below.
  // origin/main merge 1: moved to f23779fb... because validate.commands really did change,
  // because validate.commands really changed. Our main carried 124 entries and
  // origin 122, diverging BOTH ways: ours had cli-surface-smoke,
  // command-ownership-contract, verify-orphan-surface and `npm --prefix packages/graph
  // run check`; origin had validation-tier-planner-smoke and single-owner-extraction-smoke.
  // The first merge kept only our four and DROPPED origin's two, which is a real
  // regression by those entries' own labels -- validate.commands is the planner's command
  // universe, so a suite missing from it makes every evidence pin naming it resolve to
  // pinned_command_missing, and one of the dropped suites is this very file. Restored
  // both, giving the 126-entry union, and repinned to what that union produces through
  // the same configuredValidationCommands -> buildValidationCommandInventory path.
  // B-212f CHK-001/CHK-003 register original parity, shared predicate proof and
  // post-DONE snapshot smoke: the complete inventory grows from 128 to 131.
  // B-aa5f CHK-008 retains those three upstream entries AND the two receipt
  // contracts plus inventory-epoch smoke. B-fe8f adds its ledger/runtime guard:
  // the earlier merged union had 135. The current local-main merge adds B-e256's
  // global CLI executable-bit guard and Lab maintenance coverage. Latest main
  // carries 139 commands; B-bcae adds its bootstrap-race and admission
  // co-scheduling rows without dropping any predecessor, yielding 141.
  // Derived through configuredValidationCommands -> buildValidationCommandInventory.
  // B-aa5f timeout remediation keeps that inventory intact while raising only
  // verification-run-and-guard-smoke from 600000ms to its audited 1200000ms budget.
  // B-03b7 CHK-001 registers the identity-lineage delivery campaign and frozen
  // RED/GREEN replay without dropping any predecessor, yielding 143 commands.
  for (const required of [
    'packages/main/tests/red/red-done-prepare-done-parity.mjs',
    'packages/main/tests/red/red-done-shared-predicates.mjs',
    'packages/main/dist/tasks/post-done-closure-snapshot-smoke.js',
    'packages/main/tests/red/red-bfe8f-ledger-runtime-integrity.mjs',
    'packages/main/tests/red/red-global-cli-exec-bit.mjs',
    'scripts/verify-process-fact-contract.mjs',
    'scripts/verify-runtime-fact-contract.mjs',
    'packages/main/dist/tasks/review-inventory-epoch-smoke.js',
    'packages/main/tests/canonical-new-story-artifacts.test.mjs',
    'packages/main/dist/tasks/evidence-hash-snapshot-classifier-smoke.js',
    'packages/main/tests/red/red-partial-hash-snapshot-binding.mjs',
  ]) assert.ok(commands.some(entry => entry.args?.includes(required)), `merged inventory retains ${required}`);
  // v0.3.300 retains the session-performance inventory and adds the Finding
  // identity delivery and RED commands. Recompute from the merged normalized
  // inventory before replacing this deliberate merge-time sentinel.
  // v0.3.317 integrates the explicitly registered dynamic-finding-evidence-closure suite.
  // The pre-sync inventory had 166 normalized command+argv tuples. v0.3.345 has
  // 168: B-83aa CHK-002 adds only red-partial-hash-snapshot-binding.mjs and
  // B-83aa CHK-003 adds only evidence-hash-snapshot-classifier-smoke.js. The
  // normalized set comparison recorded additions=2 and removals=0; the two
  // exact argv retention assertions above plus this count preserve that result.
  // The audited local-main 0.3.348 base a8240a60 recheck retained 168 entries
  // and the same e9e563a8... digest; its normalized base-to-candidate delta was
  // additions=0, removals=0. The literal production-path receipt is in the Lab evidence log.
  // Modularization baseline 9c8e8b848b already has 248 commands. The exact
  // config SHA256 stayed 4431622d24fc637a2bfd543a6cae1c73918dcac0530814fbbf9a46002a1a3d42;
  // additions=0, removals=0 in this refactor. The original 168-entry pin was stale.
  // Main sync 300ed4d08b adds two verdict-stickiness commands; no removals.
  // See planner-main-sync-inventory.json for normalized tuples and digests.
  assert.equal(real.entries.length, 250, 'the normalized inventory cardinality is part of the re-pin evidence; recount and update PIN MAINTENANCE when validate.commands changes');
  assert.equal(real.commandSetDigest, '4250a69ee84fe4a6d1586d85876a3b20dcf002ab86e5f5a14c78e3b84b98b869', 'the real commandSetDigest must not move unless validate.commands changes (see PIN MAINTENANCE above)');
  assert.equal(real.warnings.some((text) => /absolute/i.test(text)), false);
  assert.equal(explicitDot.warnings.some((text) => /absolute/i.test(text)), false);
  for (const entry of real.entries) assert.equal(entry.tuple.cwdRelative, '.');
  // Non-vacuity: ONE absolute cwd on the same command set moves the digest and is named in a warning.
  const absoluteCwd = resolve(repoRoot);
  const oneAbsolute = buildValidationCommandInventory({
    commands: commands.map((entry, index) => (index === 0 ? { ...entry, cwd: absoluteCwd } : entry)),
  });
  assert.notEqual(oneAbsolute.commandSetDigest, real.commandSetDigest, 'an absolute cwd on one command must change the commandSetDigest');
  assert.ok(
    oneAbsolute.warnings.some((text) => /absolute/i.test(text) && text.includes(absoluteCwd)),
    `the inventory must warn about the absolute declared cwd, got warnings: ${JSON.stringify(oneAbsolute.warnings)}`,
  );
  assert.equal(oneAbsolute.entries[0].tuple.cwdRelative, absoluteCwd);
});


testCase('the portable tuple shell is the declared intent, the complete runtime tuple shell is the effective rule', () => {
  for (const platform of PORTABILITY_PLATFORMS) {
    for (const shell of [undefined, true, false]) {
      const entry = command({ label: 'x', command: 'npm', args: ['test'], ...(shell === undefined ? {} : { shell }) });
      const [unit] = universeOn(platform, [entry]).entries;
      // Portable: declared intent only. `undefined` and `false` are both "not declared".
      assert.equal(
        unit.tuple.shell,
        entry.shell === true,
        `portable tuple shell must be the DECLARED intent on ${platform} shell=${String(shell)}`,
      );
      assert.equal(
        narrowPortableValidationCommandTuple({ command: entry }).shell,
        entry.shell === true,
        `narrowPortableValidationCommandTuple must not consult the host on shell=${String(shell)}`,
      );
      // Runtime: the ONE effective rule the routine identity binds, unchanged.
      assert.equal(
        unit.completeTuple.shell,
        validationCommandUsesShell(entry, platform),
        `complete tuple shell must stay the effective rule on ${platform} shell=${String(shell)}`,
      );
      assert.equal(unit.completeTuple.shell, entry.shell === true || platform === 'win32');
    }
  }
});


testCase('an undeclared-shell command has the same provisional id and commandSetDigest on linux, darwin and win32', () => {
  const entry = command({ label: 'unit', command: 'npm', args: ['test'] });
  const perPlatform = PORTABILITY_PLATFORMS.map((platform) => {
    const universe = universeOn(platform, [entry]);
    return { platform, id: universe.entries[0].id, commandSetDigest: universe.commandSetDigest };
  });
  const [reference] = perPlatform;
  assert.ok(reference.id.startsWith(PROVISIONAL_VALIDATION_COMMAND_ID_PREFIX));
  for (const observed of perPlatform) {
    assert.equal(
      observed.id,
      reference.id,
      `provisional id must be host-portable: ${observed.platform} derived ${observed.id}, ${reference.platform} derived ${reference.id}`,
    );
    assert.equal(
      observed.commandSetDigest,
      reference.commandSetDigest,
      `commandSetDigest must be host-portable: ${observed.platform} differs from ${reference.platform}`,
    );
  }
});


testCase('a declared shell: true command is portable across platforms AND distinct from the undeclared one', () => {
  const undeclared = command({ label: 'unit', command: 'npm', args: ['test'] });
  const declared = command({ label: 'unit', command: 'npm', args: ['test'], shell: true });
  const declaredIds = PORTABILITY_PLATFORMS.map((platform) => universeOn(platform, [declared]).entries[0].id);
  const declaredDigests = PORTABILITY_PLATFORMS.map((platform) => universeOn(platform, [declared]).commandSetDigest);
  assert.equal(new Set(declaredIds).size, 1, `a declared shell must give ONE id, got ${declaredIds.join(', ')}`);
  assert.equal(new Set(declaredDigests).size, 1, 'a declared shell must give ONE commandSetDigest');
  for (const platform of PORTABILITY_PLATFORMS) {
    assert.notEqual(
      universeOn(platform, [undeclared]).entries[0].id,
      declaredIds[0],
      `declaring shell: true is a real identity change and must differ from the undeclared id on ${platform}`,
    );
  }
});


testCase('the COMPLETE runtime tuple for an undeclared-shell command still differs on win32', () => {
  const entry = command({ label: 'unit', command: 'npm', args: ['test'] });
  const posix = universeOn('linux', [entry]).entries[0];
  const windows = universeOn('win32', [entry]).entries[0];
  assert.equal(posix.completeTuple.shell, false);
  assert.equal(windows.completeTuple.shell, true, 'win32 executes through a shell, and pin resolution must know');
  assert.notEqual(
    windows.normalizedTupleDigest,
    posix.normalizedTupleDigest,
    'the runtime side must NOT be flattened: what executes on win32 is a different tuple',
  );
  // While the portable side, from the very same universes, agrees.
  assert.equal(windows.id, posix.id);
});


testCase('the REAL validate.commands inventory has one commandSetDigest whether computed for darwin or win32', () => {
  const repoRoot = (gitOutput(['rev-parse', '--show-toplevel']) ?? '').trim();
  assert.ok(repoRoot, 'this guard reads the real repository inventory; a missing repository is a failure, not a skip');
  const commands = configuredValidationCommands(repoRoot);
  assert.ok(commands.length > 0, 'the real inventory must not be empty');
  const digestOn = (platform: NodeJS.Platform) => buildValidationPinUniverse({ projectRoot: repoRoot, commands, platform });
  const darwin = digestOn('darwin');
  const windows = digestOn('win32');
  assert.equal(
    windows.commandSetDigest,
    darwin.commandSetDigest,
    `the real inventory's commandSetDigest must be host-portable (darwin ${darwin.commandSetDigest}, win32 ${windows.commandSetDigest})`,
  );
  for (let index = 0; index < darwin.entries.length; index += 1) {
    assert.equal(windows.entries[index].id, darwin.entries[index].id, `entry ${index} id differs across platforms`);
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
}
