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
 *   (2) PORTABLE VERSUS RUNTIME SHELL (B-a745 F-017) — the NARROW PORTABLE tuple's
 *       `shell` is the DECLARED intent only (`command.shell === true`), so the `prov-`
 *       id and the commandSetDigest are identical on linux / darwin / win32. The
 *       COMPLETE runtime tuple pin resolution compares keeps the platform-effective
 *       rule `validationCommandUsesShell` (`shell === true || platform === 'win32'`),
 *       because that is what actually executes. Two rules on purpose, for two
 *       different questions; the portable one must not be able to consume the host.
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
 *
 * CHK-003 cases proven here (section "Story input contract"):
 *  (17) POSITIVE COLLECTION — every input kind in the spec's table is gathered and
 *       every seed records its provenance.
 *  (18) DELETE + RENAME — a deleted path stays a seed; a rename contributes BOTH the
 *       old and the new path.
 *  (19) CANONICAL EXCLUSION — story metadata and registered runtime artifacts are
 *       excluded through `isStoryMetadataPath` / `isMaterialExcludedPath`, never a
 *       local allowlist.
 *  (20) READ FAILURE (load-bearing) — an unreadable changed-file set is
 *       `changed_files_unavailable` with an escalation, and an honestly EMPTY diff
 *       stays `available` with none. A `catch { return [] }` implementation fails here.
 *  (21) DURATION HISTORY — collected from prior signed validation artifacts; a command
 *       with no history reports unknown-duration and carries no numeric field at all.
 *  (22) ADVERSARIAL (duration) — mutating duration history changes neither the seed set
 *       nor the selection digest: it is estimate-only by construction.
 *  (23) ADVERSARIAL (intent) — verification intent is reason context only and produces
 *       no command-to-seed edge; every edge that exists comes from a resolved pin.
 *  (24) RUNTIME RE-VALIDATION — the collector re-checks its own inputs.
 *
 * CHK-004 cases proven here (sections "Terminology and invariants", "Selection
 * algorithm" steps 1/2/5, and "Fail-closed widening matrix"):
 *  (25) TIER VOCABULARY — exactly story-fast / story-intermediate / repository-full,
 *       with the subset invariant ENCODED: a selection that breaks it is rejected.
 *  (26) GLOSS COMPLETENESS (load-bearing) — every reason code carries a one-sentence
 *       plain-language gloss, asserted by ENUMERATING the table rather than by a
 *       hand-copied list of codes, which would rot the moment a code is added.
 *  (27) NORMAL CONFIGURED STORY — repository-full over the COMPLETE universe, with at
 *       least one glossed reason explaining why nothing was reduced.
 *  (28) ALL FOUR SOURCE KINDS — configured is the command-set path; fallback and
 *       validate-file are one atomic unit reporting source_kind_atomic; no-validator
 *       preserves the existing skip/warn and produces NO tier pass.
 *  (29) UNCLASSIFIED MATERIAL INPUT — appears BOTH as an escalation reason and in
 *       unclassifiedInputs; an upstream unresolvable pin is a classified stop.
 *  (30) EXHAUSTIVE BRANCH COVERAGE (load-bearing) — sweeping the resolver's whole
 *       input space, no result ever carries a reduced effective tier.
 *  (31) EMPTY UNIVERSE — a classified stop, never a passing empty plan. Written so an
 *       implementation returning {allPass: true, selected: []} FAILS.
 *  (32) RUNTIME RE-VALIDATION — the planner core re-checks tier and input.
 *
 * CHK-005 cases proven here (section "Proposed CLI and UX"):
 *  (33) HUMAN OUTPUT (load-bearing) — every field the spec's output list names is
 *       present and LABELLED: requested and effective tier, selected-versus-total
 *       counts, per-unit inclusion reasons grouped by unit, unclassified inputs,
 *       each escalation code followed by its gloss, an estimated duration with its
 *       basis, and `finalAuthority: no`.
 *  (34) --json — ONE parseable object carrying the same facts as the human text,
 *       including per-unit duration whose unknown state carries no numeric field.
 *  (35) REJECTION BY NAME — a missing storyId, an omitted tier and an unknown tier
 *       are each refused naming the offender. Nothing silently defaults.
 *  (36) COMMAND POLICY — the row exists and reads readOnly / none / all phases.
 *  (37) READ-ONLY BY MEASUREMENT (the load-bearing one) — every byte under the
 *       project root is snapshotted before and after invocation and asserted
 *       identical, so adding ANY store write to the handler FAILS this case; and no
 *       write/persist/execute/run-shaped flag is accepted at the schema OR the
 *       handler.
 *  (38) RUNTIME RE-VALIDATION — a schema-bypassing tier and storyId are rejected at
 *       the handler entry AND at the planner-core entry.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

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
  DEFAULT_STORY_RELEVANCE_READERS,
  collectStoryRelevanceInput,
  type ChangedFileStatusReader,
  type StoryRelevanceChangedFiles,
  type StoryRelevanceInput,
  type StoryRelevanceInputArgs,
} from '../core/validation-relevance-input.js';
import {
  captureEvidenceHashSnapshot,
  changedFileStatusesBetweenRenameAware,
  isMaterialExcludedPath,
  isStoryMetadataPath,
  type EvidenceHashSnapshot,
} from '../core/evidence-freshness.js';
import type { ChecklistItem, StoryInfo } from '../core/types.js';
import {
  buildRoutineValidationIdentity,
  validationCommandUsesShell,
  validationIdentityDigest,
} from '../core/validation-evidence-reuse.js';
import { configuredValidationCommands, sourceInputSnapshot } from '../handlers/verifier.js';
import {
  REPOSITORY_FULL_TIER,
  VALIDATION_STOP_REASON_CODES,
  VALIDATION_TIERS,
  VALIDATION_WIDENING_OUTCOMES,
  VALIDATION_WIDENING_REASONS,
  VALIDATION_WIDENING_REASON_CODES,
  assertValidationTier,
  assertValidationTierSelectionSubsetInvariant,
  isValidationStopReasonCode,
  resolveValidationTierPlan,
  validationTierIsSubsetOf,
  validationTierRank,
  validationWideningReason,
  validationWideningReasonGloss,
  type ValidationTier,
  type ValidationTierPlanResult,
  type ValidationWideningReasonCode,
} from '../core/validation-tier-planner.js';
import type { RoutineValidationSourceKind, ValidationCommand } from '../core/validation-types.js';
import {
  VALIDATION_PLAN_OUTCOME_BEARING_LINE_PREFIXES,
  VALIDATION_PLAN_STATUS_LINES,
  VALIDATION_PLAN_TIER_ALIASES,
  assertValidationPlanStatusInvariant,
  buildValidationPlanReport,
  createValidationPlanHandlers,
  renderValidationPlanReport,
  renderValidationPlanText,
  resolveValidationPlanRequest,
} from '../handlers/validation-plan.js';
import type { HandlerContext } from '../handlers/context.js';
import { MAIN_TOOLS } from '../cli/command-catalog.js';
import { FULL_SUITE_ENTRIES, entriesFromSerialReference, parseSerialReference } from './full-suite-runner.js';
import { getCommandPolicy } from '../core/command-policy.js';
import {
  describeRedGreenViolations,
  evaluateRedGreenCommitOrder,
  isStoryQualifiedRedGreenId,
  parseRedGreenSubject,
} from '../core/red-green-commit-guard.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';

const MARKER = 'validation-tier-planner-smoke';
const ROOT = '/repo';

let failures = 0;

// ---------------------------------------------------------------------------
// B-dc2e F-003: the DEFAULT output of this smoke is bounded and self-checked.
// The verification executor keeps only the first 12000 chars of a pinned
// command's stdout before matching a selector, and plan.md promises every smoke
// stays under DEFAULT_STDOUT_BOUND_CHARS with real headroom. By default a section
// prints ONE summary line for its passed cases; VALIDATION_TIER_PLANNER_VERBOSE=1
// prints every `ok` line. A FAIL always prints by name. The CHK-006 section keeps
// its per-case lines: two of them and its [PASS] line are pinned selectors.
// Every write to this process's stdout is counted (console.log goes through
// process.stdout.write; no child inherits stdout), so the last case measures the
// real output and projects the default rendering when VERBOSE is set.
// ---------------------------------------------------------------------------
const DEFAULT_STDOUT_BOUND_CHARS = 11_000;
const VERBOSE = process.env.VALIDATION_TIER_PLANNER_VERBOSE === '1';
let capturedStdoutChars = 0;
/** Chars written only because VERBOSE is set; subtracted to project the default rendering. */
let verboseOnlyChars = 0;
{
  const originalWrite = process.stdout.write;
  process.stdout.write = function (this: NodeJS.WriteStream, chunk: any, ...rest: any[]): boolean {
    capturedStdoutChars += typeof chunk === 'string' ? chunk.length : Buffer.from(chunk).toString('utf-8').length;
    return (originalWrite as any).call(this, chunk, ...rest);
  } as typeof process.stdout.write;
}

/** Case names that actually RAN and PASSED, so the CHK-006 coverage registry cannot cite a case that does not exist. */
const passedCases = new Set<string>();
/** The name of the most recently run case, so the bound case can prove it is the last one. */
let lastCaseName = '';

/** The section being run; a `perCase` section prints every ok line by default, the others one summary line. */
let section: { name: string; perCase: boolean; passed: number } | null = null;
let sectionCount = 0;

function flushSection(): void {
  if (section && !section.perCase) console.log(`  ok  ${section.passed} case${section.passed === 1 ? '' : 's'} passed`);
  section = null;
}

/** Start a section. Checklist items are DERIVED from these calls' `CHK-nnn` prefixes (see declaredChecklistItems). */
function beginSection(name: string, options: { perCase?: boolean } = {}): void {
  flushSection();
  section = { name, perCase: options.perCase === true, passed: 0 };
  console.log(`${sectionCount === 0 ? '' : '\n'}${MARKER}: running ${name}`);
  sectionCount += 1;
}

function testCase(name: string, run: () => void): void {
  lastCaseName = name;
  try {
    run();
    passedCases.add(name);
    if (section) section.passed += 1;
    const line = `  ok  ${name}`;
    if (!section || section.perCase) console.log(line);
    else if (VERBOSE) { verboseOnlyChars += line.length + 1; console.log(line); }
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function command(overrides: Partial<ValidationCommand> & { label: string; command: string }): ValidationCommand {
  return { args: [], ...overrides };
}

/** Platform-free on purpose (F-017): the inventory has no host input to inject. */
function inventory(commands: ValidationCommand[]) {
  return buildValidationCommandInventory({ commands });
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
  // Deterministic across independent computations.
  assert.equal(id, inventory([entry]).entries[0].id);
});

// ---------------------------------------------------------------------------
// B-a745 F-023 (Codex cross-host review round 3) — THE PORTABLE TUPLE HASHES THE
// DECLARED cwd, NEVER A RESOLVED ONE.
//
// The first cut resolved the declared cwd against the project root and then
// relativized it back. For a relative declaration that round-trips to the
// literal; for an ABSOLUTE declaration it makes the "portable" id and the
// commandSetDigest a function of where the checkout lives (depth, drive,
// symlink alias). Same class as F-017: an EFFECTIVE value leaking into the
// DECLARED-intent tuple. The split is the same as F-017's: the portable tuple
// hashes the declared literal (posix-normalized, absent means `.`) and takes
// no project-root input at all; the COMPLETE runtime tuple keeps the resolved
// absolute cwd because that is what executes. An absolute declaration is
// location-bound by the config author's choice, so it is named in an inventory
// warning rather than silently relativized.
// ---------------------------------------------------------------------------

const F023_ROOTS = ['/repo-a', '/some/much/deeper/checkout/repo-b'];

/**
 * F-026: the inventory builder takes no project root at all, so the only entry
 * point through which a checkout location can still reach an id or the
 * commandSetDigest is the pin universe. These cases probe THAT entry point.
 */
function inventoryUnderRoot(projectRoot: string, commands: ValidationCommand[]) {
  return buildValidationPinUniverse({ projectRoot, commands, processEnvironment: { PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv, platform: 'linux' });
}

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
// never a commit hash: a branch rewrite orphans the hash and a later
// `git show` of it reports a bad object (B-41c8 F-012).
testCase('F-023: the REAL inventory stays pinned and cwd-neutral, with no absolute-cwd warning', () => {
  const repoRoot = (gitOutput(['rev-parse', '--show-toplevel']) ?? '').trim();
  assert.ok(repoRoot, 'this guard reads the real repository inventory; a missing repository is a failure, not a skip');
  const commands = configuredValidationCommands(repoRoot);
  assert.ok(commands.length > 0);
  assert.deepEqual(commands.filter((entry) => entry.cwd !== undefined).map((entry) => entry.label), [], 'this repository declares no cwd on any command');
  const real = buildValidationCommandInventory({ commands });
  // Absent cwd posix-normalizes to "." (see the spellings case above), so declaring "." explicitly on
  // every entry must reach the same digest: the real inventory is not bound to any checkout location.
  const explicitDot = buildValidationCommandInventory({ commands: commands.map((entry) => ({ ...entry, cwd: '.' })) });
  assert.equal(real.commandSetDigest, explicitDot.commandSetDigest, 'the real commandSetDigest must equal the digest of the same commands with an explicit "." cwd');
  // B-e256 CHK-002/F-044 contributes the stable-id global CLI executable-bit
  // regression row. The merge also retains current main's B-fe8f Finding-ledger
  // guard and B-1482 narrowing-repin command: the complete union is 133 entries.
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
  // post-DONE snapshot smoke. Their 131-entry main inventory and B-fe8f's
  // 129-entry inventory form a 132-entry union without losing either side;
  // B-e256 then adds its global launcher row, and the lab-worktree guard brings
  // the merged inventory to 134 entries.
  // Current union: 153 entries; seven synthetic suites now enter through the
  // fixture wrapper. Every original leaf remains present; only their argv changed.
  assert.equal(real.commandSetDigest, '89f94becdafacd5136e82651d28e604e711169a24d9a3003fa429eeab9ed0924', 'the real commandSetDigest must not move unless validate.commands changes (see PIN MAINTENANCE above)');
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

// ---------------------------------------------------------------------------
// (2) PORTABLE versus RUNTIME shell (B-a745 F-017).
//     The story's recorded decision `A-narrow-portable-id` promises an id that is
//     stable across machines, usable as a declared-id migration target and
//     verifiable on another host. Hashing the platform-effective shell rule into
//     the portable tuple broke that: the same config produced a different
//     `prov-` id and a different commandSetDigest on Windows. The portable tuple
//     carries the DECLARED shell only; the COMPLETE runtime tuple keeps the
//     effective rule. Every case here reads BOTH tuples out of ONE
//     `buildValidationPinUniverse` call per platform, so the platform the
//     universe was normalized under is provably the same for both halves.
// ---------------------------------------------------------------------------
const PORTABILITY_PLATFORMS: NodeJS.Platform[] = ['linux', 'darwin', 'win32'];

function universeOn(platform: NodeJS.Platform, commands: ValidationCommand[]) {
  return buildValidationPinUniverse({
    projectRoot: ROOT,
    commands,
    processEnvironment: { PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv,
    platform,
  });
}

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

// ---------------------------------------------------------------------------
// CHK-003 — the Story input collector (`core/validation-relevance-input.ts`).
// Spec section "Story input contract".
// ---------------------------------------------------------------------------

const FIXTURE_HEAD_SNAPSHOT: EvidenceHashSnapshot = {
  schemaVersion: 'lattice.evidence_hash_snapshot.v1',
  headHash: 'head0000000000000000000000000000000000000',
  materialHash: 'material00000000000000000000000000000000',
  storyFilesHash: 'storyfiles000000000000000000000000000000',
  gitCwd: ROOT,
  metadataRoot: ROOT,
  ref: 'HEAD',
  capturedAt: '2026-01-01T00:00:00.000Z',
  materialDirtyFiles: [],
};

function fixtureHashSnapshot(args: { ref?: string }): EvidenceHashSnapshot {
  return { ...FIXTURE_HEAD_SNAPSHOT, ref: args.ref ?? 'HEAD' };
}

function checklistItem(overrides: Partial<ChecklistItem> & { id: string }): ChecklistItem {
  return {
    title: `${overrides.id} title`,
    status: 'done',
    startTime: null,
    endTime: null,
    ...overrides,
  } as ChecklistItem;
}

function statusReader(statuses: Record<string, string>): ChangedFileStatusReader {
  return () => ({ ...statuses });
}

const throwingStatusReader: ChangedFileStatusReader = () => {
  throw new Error('fatal: bad revision "main"');
};

const RELEVANCE_COMMANDS: ValidationCommand[] = [
  command({ label: 'unit', command: 'npm', args: ['test'], id: 'unit-suite' }),
  command({ label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'lint-suite' }),
];

function collect(overrides: Partial<StoryRelevanceInputArgs> = {}): StoryRelevanceInput {
  return collectStoryRelevanceInput({
    projectRoot: ROOT,
    gitCwd: ROOT,
    story: { storyId: 'B-a745', phase: 'DEV' },
    checklist: { items: [] },
    routine: { sourceKind: 'configured', commands: RELEVANCE_COMMANDS },
    platform: 'linux',
    processEnvironment: { PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv,
    readers: { changedFileStatuses: statusReader({}), hashSnapshot: fixtureHashSnapshot },
    ...overrides,
  });
}

function seedOf(input: StoryRelevanceInput, kind: string, value: string) {
  return input.seeds.find((seed) => seed.kind === kind && seed.value === value);
}

beginSection('CHK-003 Story input collector cases');

// ---------------------------------------------------------------------------
// (17) POSITIVE — every input kind in the spec's table is collected, and every
//      seed records where it came from.
// ---------------------------------------------------------------------------
testCase('the collector gathers every Story input kind with per-seed provenance', () => {
  const input = collect({
    story: {
      storyId: 'B-a745',
      phase: 'DEV',
      riskSignals: [{ category: 'guard', matched: 'guard' }],
    },
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          files: { modify: ['src/core/machine-x.ts'], create: ['src/core/new-x.ts'], test: ['src/tasks/x-smoke.ts'] },
          verificationIntent: {
            happy: [{ desc: 'the planner explains its selection', type: 'cli', priority: 'must' }],
            edge: [],
            adversarial: [],
          },
          verificationEvidence: [
            { intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'npm test', result: 'pass', note: 'fixture evidence' },
          ],
        }),
      ],
    },
    readers: {
      changedFileStatuses: statusReader({ 'src/core/touched.ts': 'M' }),
      hashSnapshot: fixtureHashSnapshot,
    },
  });

  assert.equal(input.storyId, 'B-a745');
  assert.equal(input.phase, 'DEV');
  assert.equal(input.hashes.status, 'available');
  assert.equal(input.hashes.status === 'available' && input.hashes.head.headHash, FIXTURE_HEAD_SNAPSHOT.headHash);
  assert.equal(input.hashes.status === 'available' && input.hashes.head.materialHash, FIXTURE_HEAD_SNAPSHOT.materialHash);
  assert.equal(input.hashes.status === 'available' && input.hashes.head.storyFilesHash, FIXTURE_HEAD_SNAPSHOT.storyFilesHash);
  assert.equal(input.changedFiles.status, 'available');

  assert.deepEqual(seedOf(input, 'path', 'src/core/touched.ts')?.provenance, ['changed-file']);
  assert.deepEqual(seedOf(input, 'path', 'src/core/machine-x.ts')?.provenance, ['checklist-modify']);
  assert.deepEqual(seedOf(input, 'path', 'src/core/new-x.ts')?.provenance, ['checklist-create']);
  assert.deepEqual(seedOf(input, 'path', 'src/tasks/x-smoke.ts')?.provenance, ['checklist-test']);
  assert.deepEqual(seedOf(input, 'command', 'unit-suite')?.provenance, ['evidence-pin']);
  assert.deepEqual(seedOf(input, 'risk-signal', 'guard')?.provenance, ['risk-signal']);
  for (const seed of input.seeds) {
    assert.ok(seed.provenance.length > 0, `seed ${seed.kind}:${seed.value} must record its provenance`);
  }

  assert.equal(input.pinnedCommands.length, 1);
  assert.equal(input.pinnedCommands[0].commandId, 'unit-suite');
  assert.equal(input.pinnedCommands[0].itemId, 'CHK-001');
  assert.equal(input.executionInventory.sourceKind, 'configured');
  assert.deepEqual(input.executionInventory.commandIds, ['unit-suite', 'lint-suite']);
  assert.ok(input.executionInventory.commandSetDigest.length === 64);
  assert.equal(input.escalations.length, 0);
});

testCase('the collector defaults to the SHARED rename-aware reader and the shared hash snapshot', () => {
  // The injectable readers exist for the failure fixture below; the DEFAULTS must
  // still be the canonical shared readers, so the collector never grows its own
  // git access path alongside `core/evidence-freshness.ts`.
  assert.equal(
    DEFAULT_STORY_RELEVANCE_READERS.changedFileStatuses,
    changedFileStatusesBetweenRenameAware,
    'changed paths must come from the shared rename-aware reader',
  );
  assert.equal(
    DEFAULT_STORY_RELEVANCE_READERS.hashSnapshot,
    captureEvidenceHashSnapshot,
    'hashes must come from the shared evidence hash snapshot reader',
  );
});

// ---------------------------------------------------------------------------
// (18) DELETE + RENAME — a deleted path stays a seed and BOTH sides of a rename
//      stay seeds. The spec states both rules explicitly.
// ---------------------------------------------------------------------------
testCase('a deleted path remains a seed and a rename contributes both old and new paths', () => {
  const input = collect({
    readers: {
      changedFileStatuses: statusReader({
        'src/core/removed.ts': 'D',
        'src/core/old-name.ts': 'R100',
        'src/core/new-name.ts': 'R100',
      }),
      hashSnapshot: fixtureHashSnapshot,
    },
  });
  const deleted = seedOf(input, 'path', 'src/core/removed.ts');
  assert.ok(deleted, 'a deleted file must remain a seed');
  assert.equal(deleted!.changeStatus, 'D');
  assert.equal(deleted!.deleted, true);
  assert.ok(seedOf(input, 'path', 'src/core/old-name.ts'), 'the rename source must remain a seed');
  assert.ok(seedOf(input, 'path', 'src/core/new-name.ts'), 'the rename destination must remain a seed');
});

// ---------------------------------------------------------------------------
// (19) EXCLUSION uses the CANONICAL classifier, never a local allowlist.
// ---------------------------------------------------------------------------
testCase('story metadata and registered runtime artifacts are excluded by the canonical classifier', () => {
  const metadataPath = '.proof-or-stop/story/actives/B-a745/index.json';
  const runtimeArtifactPath = '.proof-or-stop/activity.jsonl';
  const materialPath = 'src/core/machine-x.ts';
  // Guard the fixture itself against drifting away from the canonical rule.
  assert.equal(isStoryMetadataPath(metadataPath), true);
  assert.equal(isMaterialExcludedPath(runtimeArtifactPath), true);
  assert.equal(isMaterialExcludedPath(materialPath), false);

  const input = collect({
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          files: { modify: [metadataPath], create: [], test: [] },
        }),
      ],
    },
    readers: {
      changedFileStatuses: statusReader({ [runtimeArtifactPath]: 'M', [materialPath]: 'M' }),
      hashSnapshot: fixtureHashSnapshot,
    },
  });

  assert.equal(seedOf(input, 'path', metadataPath), undefined, 'story metadata is not a material seed');
  assert.equal(seedOf(input, 'path', runtimeArtifactPath), undefined, 'a registered runtime artifact is not a material seed');
  assert.ok(seedOf(input, 'path', materialPath), 'real material must still seed');
  const excluded = input.excludedPaths.map((entry) => entry.path).sort();
  assert.deepEqual(excluded, [runtimeArtifactPath, metadataPath].sort());
  assert.equal(input.excludedPaths.find((entry) => entry.path === metadataPath)?.reason, 'story-metadata');
  assert.equal(input.excludedPaths.find((entry) => entry.path === runtimeArtifactPath)?.reason, 'runtime-artifact');
});

// ---------------------------------------------------------------------------
// (20) READ FAILURE (load-bearing) — a failure to read changed files is
//      `changed_files_unavailable`, NEVER an empty array. The second half of the
//      case is what makes a `catch { return [] }` implementation FAIL: an
//      honestly empty diff must stay `available` with no escalation, so the two
//      states can never be conflated.
// ---------------------------------------------------------------------------
testCase('a changed-file read failure is changed_files_unavailable, never an empty seed set', () => {
  const failed = collect({
    readers: { changedFileStatuses: throwingStatusReader, hashSnapshot: fixtureHashSnapshot },
  });
  assert.equal(failed.changedFiles.status, 'changed_files_unavailable');
  assert.notEqual(failed.changedFiles.status, 'available', 'a read failure must never be reported as a clean diff');
  assert.match(
    failed.changedFiles.status === 'changed_files_unavailable' ? failed.changedFiles.error : '',
    /bad revision/,
    'the underlying reader error must be preserved',
  );
  const escalation = failed.escalations.find((entry) => entry.code === 'changed_files_unavailable');
  assert.ok(escalation, 'a read failure must escalate');
  assert.ok((escalation!.detail ?? '').length > 0, 'the escalation must carry a human-readable detail');

  const empty = collect({
    readers: { changedFileStatuses: statusReader({}), hashSnapshot: fixtureHashSnapshot },
  });
  assert.equal(empty.changedFiles.status, 'available', 'an honestly empty diff is available, not unavailable');
  assert.deepEqual(
    empty.escalations.filter((entry) => entry.code === 'changed_files_unavailable'),
    [],
    'an empty diff must not escalate',
  );
  assert.notEqual(
    failed.selectionDigest,
    empty.selectionDigest,
    'an unreadable diff and an empty diff must not produce the same planning input',
  );
});

// ---------------------------------------------------------------------------
// (20b) BOUNDED FAILURE DETAIL (load-bearing) — the operator-facing escalation
//       `detail` must be a short human-readable CLASSIFICATION of why the read
//       failed, never the subprocess's raw stderr. Running the real reader
//       outside a git repository makes git print ~40 lines of `git diff --help`
//       usage; embedding that verbatim destroys exactly the interpretability
//       guarantee the glossed escalations exist to provide. The raw error stays
//       available for diagnosis on `changedFiles.error`, but it must never reach
//       the detail line.
// ---------------------------------------------------------------------------
// Narrowed to the real union member, so deleting `reason` or `summary` from
// StoryRelevanceChangedFiles is a COMPILE error here, not merely a runtime one.
type UnavailableChangedFiles = Extract<StoryRelevanceChangedFiles, { status: 'changed_files_unavailable' }>;

function unavailableChangedFiles(input: StoryRelevanceInput): UnavailableChangedFiles {
  assert.equal(input.changedFiles.status, 'changed_files_unavailable');
  return input.changedFiles as UnavailableChangedFiles;
}

const GIT_USAGE_DUMP = [
  'Command failed: git diff --name-status -M main..HEAD',
  'warning: Not a git repository. Use --no-index to compare two paths outside a working tree',
  'usage: git diff --no-index [<options>] <path> <path>',
  '',
  'Diff output format options',
  '    -p, --patch           generate patch',
  '    --raw                 generate the diff in raw format',
  '    --numstat             machine friendly --stat',
  '    --name-status         show only names and status of changed files',
  '    --output-indicator-new <char>',
  '                          specify the character to indicate a new line',
  '',
  'Diff rename options',
  '    -M, --find-renames[=<n>]',
  '                          detect renames',
  '    --diff-filter=[(A|C|D|M|R|T|U|X|B)...[*]]',
  '                          select files by diff type',
  '    --output <file>       output to a specific file',
].join('\n');

testCase('an unreadable changed-file set escalates with a bounded classification, not a git usage dump', () => {
  const failed = collect({
    readers: {
      changedFileStatuses: () => {
        throw new Error(GIT_USAGE_DUMP);
      },
      hashSnapshot: fixtureHashSnapshot,
    },
  });
  assert.equal(failed.changedFiles.status, 'changed_files_unavailable');

  const escalation = failed.escalations.find((entry) => entry.code === 'changed_files_unavailable');
  assert.ok(escalation, 'a read failure must still escalate');
  const detail = escalation!.detail;

  assert.equal(detail.includes('\n'), false, `the operator-facing detail must be ONE line, got:\n${detail}`);
  assert.ok(detail.length <= 300, `the detail must stay readable, got ${detail.length} characters`);
  for (const leak of ['usage: git diff', '--diff-filter', '--output-indicator-new', '--numstat', '--find-renames']) {
    assert.equal(detail.includes(leak), false, `the raw git usage text leaked into the detail: ${leak}`);
  }
  assert.match(detail, /not a git repository/i, 'the detail must CLASSIFY the failure in plain language');
  assert.match(detail, /NOT the same as an empty diff|nothing is known/i, 'the detail must keep saying what the failure means');

  // The raw error is preserved for diagnosis — bounding the detail must not
  // destroy the underlying evidence.
  const changed = unavailableChangedFiles(failed);
  assert.ok(
    changed.error.includes('usage: git diff'),
    'the raw reader error must still be preserved on the structured result for diagnosis',
  );

  // The classification is a structured fact, not something re-derived from prose.
  assert.equal(changed.reason, 'not-a-git-repository');
  assert.equal(changed.summary.includes('\n'), false, 'the structured summary must itself be one line');
});

testCase('every changed-file failure classification stays one bounded sentence', () => {
  const cases: Array<{ error: unknown; reason: string; match: RegExp }> = [
    { error: new Error(GIT_USAGE_DUMP), reason: 'not-a-git-repository', match: /not a git repository/i },
    {
      error: new Error("Command failed: git diff --name-status -M main..HEAD\nfatal: bad revision 'main..HEAD'"),
      reason: 'unknown-revision',
      match: /revision/i,
    },
    {
      error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
      reason: 'git-unavailable',
      match: /git executable/i,
    },
    { error: new Error(`boom ${'x'.repeat(4000)}`), reason: 'unknown', match: /boom/ },
    { error: 'a bare string failure', reason: 'unknown', match: /bare string/ },
  ];
  for (const entry of cases) {
    const failed = collect({
      readers: {
        changedFileStatuses: () => {
          throw entry.error;
        },
        hashSnapshot: fixtureHashSnapshot,
      },
    });
    const changed = unavailableChangedFiles(failed);
    assert.equal(changed.reason, entry.reason, `misclassified: ${String(entry.error)}`);
    assert.equal(changed.summary.includes('\n'), false, 'the summary must be one line');
    assert.ok(changed.summary.length <= 200, `the summary must be bounded, got ${changed.summary.length}`);
    assert.match(changed.summary, entry.match);
    const detail = failed.escalations.find((item) => item.code === 'changed_files_unavailable')!.detail;
    assert.equal(detail.includes('\n'), false, 'the detail must be one line');
    assert.ok(detail.length <= 300, `the detail must be bounded, got ${detail.length}`);
  }

  // A reader that breaks its contract without throwing is classified too.
  const nonObject = collect({
    readers: { changedFileStatuses: (() => 'nope') as never, hashSnapshot: fixtureHashSnapshot },
  });
  assert.equal(unavailableChangedFiles(nonObject).reason, 'reader-contract-violation');
});

testCase('the REAL reader outside a git repository yields a bounded detail end to end', () => {
  const outsideRepo = mkdtempSync(join(tmpdir(), 'proof-or-stop-not-a-repo-'));
  temporaryRoots.push(outsideRepo);
  const failed = collect({
    projectRoot: outsideRepo,
    gitCwd: outsideRepo,
    readers: { changedFileStatuses: DEFAULT_STORY_RELEVANCE_READERS.changedFileStatuses, hashSnapshot: fixtureHashSnapshot },
  });
  assert.equal(
    failed.changedFiles.status,
    'changed_files_unavailable',
    'the real reader must fail outside a repository rather than report a clean diff',
  );
  const detail = failed.escalations.find((entry) => entry.code === 'changed_files_unavailable')!.detail;
  assert.equal(detail.includes('\n'), false, `the real-world detail must be ONE line, got:\n${detail}`);
  assert.ok(detail.length <= 300, `the real-world detail must stay readable, got ${detail.length} characters`);
  assert.equal(detail.includes('usage: git diff'), false, 'the real git usage dump must never reach the operator');
});

// ---------------------------------------------------------------------------
// (20c) PLANNER PROSE IS BOUNDED TOO (B-a745 F-016). The collector already
//       classifies a changed-file read failure into a bounded `reason` +
//       `summary`; the planner then writes its OWN `changed_files_unavailable`
//       escalation detail and was interpolating the raw `error` into it, so the
//       operator-facing `detail:` line of `validation_plan` still carried git's
//       whole usage dump. The raw error stays on the structured `changedFiles`
//       object for diagnosis; the prose line must render the classification only.
// ---------------------------------------------------------------------------
const LONG_GIT_USAGE_DUMP = [
  GIT_USAGE_DUMP,
  '',
  'Diff algorithm options',
  '    --minimal             produce the smallest possible diff',
  '    -w, --ignore-all-space',
  '                          ignore whitespace when comparing lines',
  '    -b, --ignore-space-change',
  '                          ignore changes in amount of whitespace',
  '    --ignore-space-at-eol',
  '                          ignore changes in whitespace at EOL',
  '    --ignore-cr-at-eol    ignore carrier-return at the end of line',
  '    --ignore-blank-lines  ignore changes whose lines are all blank',
  '    -I, --ignore-matching-lines <regex>',
  '                          ignore changes whose all lines match <regex>',
  '    --indent-heuristic    heuristic to shift diff hunk boundaries for easy reading',
  '    --patience            generate diff using the "patience diff" algorithm',
  '    --histogram           generate diff using the "histogram diff" algorithm',
  '    --diff-algorithm <algorithm>',
  '                          choose a diff algorithm',
  '    --anchored <text>     generate diff using the "anchored diff" algorithm',
  '    --word-diff[=<mode>]  show word diff, using <mode> to delimit changed words',
  '    --word-diff-regex <regex>',
  '                          use <regex> to decide what a word is',
  '    --color-words[=<regex>]',
  '                          equivalent to --word-diff=color --word-diff-regex=<regex>',
  '    --color-moved[=<mode>]',
  '                          moved lines of code are colored differently',
  '    --color-moved-ws <mode>',
  '                          how white spaces are ignored in --color-moved',
  '',
  'Other diff options',
  '    --relative[=<prefix>]',
  '                          when run from subdir, exclude changes outside and show relative paths',
  '    -a, --text            treat all files as text',
  '    -R                    swap two inputs, reverse the diff',
  '    --exit-code           exit with 1 if there were differences, 0 otherwise',
  '    --quiet               disable all output of the program',
].join('\n');

testCase('the planner renders a bounded changed_files_unavailable detail, never the raw git usage dump', () => {
  assert.ok(LONG_GIT_USAGE_DUMP.split('\n').length >= 40, 'the fixture must be a realistic multi-screen dump');
  const input = planInput({
    readers: {
      changedFileStatuses: () => {
        throw new Error(LONG_GIT_USAGE_DUMP);
      },
      hashSnapshot: fixtureHashSnapshot,
    },
  });
  const changed = unavailableChangedFiles(input);
  assert.equal(changed.reason, 'not-a-git-repository');
  assert.ok(changed.error.includes('--word-diff-regex'), 'the raw error must remain on the structured object for diagnosis');

  const result = resolveValidationTierPlan({ input, requestedTier: 'story-fast' });
  assert.equal(result.status, 'plan');
  const reason = result.escalationReasons.find((entry) => entry.code === 'changed_files_unavailable');
  assert.ok(reason, 'the planner must still escalate the unreadable changed-file set');
  const detail = reason!.detail;
  assert.equal(detail.includes('\n'), false, `the planner detail must be ONE line, got:\n${detail}`);
  assert.ok(detail.length <= 300, `the planner detail must stay readable, got ${detail.length} characters`);
  assert.ok(detail.includes(changed.summary), `the detail must carry the bounded summary "${changed.summary}", got: ${detail}`);
  assert.match(detail, /not-a-git-repository/, 'the detail must carry the machine classification');
  for (const line of LONG_GIT_USAGE_DUMP.split('\n').map((entry) => entry.trim()).filter((entry) => entry.length > 12)) {
    assert.equal(detail.includes(line), false, `a raw git usage line leaked into the planner detail: ${line}`);
  }

  // End to end through the renderer: the escalation stays one `detail:` line and
  // the status discriminator is still a line of its own.
  const request = resolveValidationPlanRequest({ storyId: 'B-a745', tier: 'fast' });
  const rendered = renderValidationPlanText(
    buildValidationPlanReport({ request, storyPhase: 'DEV', input, result }),
    true,
  );
  const lines = rendered.split('\n');
  assert.ok(lines.includes(VALIDATION_PLAN_STATUS_LINES.plan), 'the status line must remain a line of its own');
  const detailLines = lines.filter((line) => line.startsWith('    detail: '));
  assert.ok(detailLines.length >= result.escalationReasons.length, 'every escalation renders exactly one detail line');
  for (const line of detailLines) {
    assert.ok(line.length <= 320, `a rendered detail line is not one bounded line: ${line.length} characters`);
  }
  assert.equal(rendered.includes('usage: git diff'), false, 'the git usage dump must never reach the rendered output');
  assert.equal(rendered.includes('--word-diff-regex'), false, 'the git usage dump must never reach the rendered output');
});

testCase('a hash snapshot failure is classified, not silently dropped', () => {
  const input = collect({
    readers: {
      changedFileStatuses: statusReader({}),
      hashSnapshot: () => {
        throw new Error('fatal: not a git repository');
      },
    },
  });
  assert.equal(input.hashes.status, 'hash_snapshot_unavailable');
  assert.ok(input.escalations.some((entry) => entry.code === 'hash_snapshot_unavailable'));
});

// ---------------------------------------------------------------------------
// (20d) EVERY OTHER FAILURE PROSE IS BOUNDED (B-a745 F-016, second and third
//       sites). The same rule as the changed-file detail applies to the hash
//       snapshot escalation and to the duration-history read failure that the
//       report's `basis` line renders: raw error on the structured object only,
//       one bounded line in the prose.
// ---------------------------------------------------------------------------
testCase('a hash snapshot failure escalates with a bounded one-line detail, never the raw dump', () => {
  const input = planInput({
    readers: {
      changedFileStatuses: statusReader({}),
      hashSnapshot: () => {
        throw new Error(LONG_GIT_USAGE_DUMP);
      },
    },
  });
  assert.equal(input.hashes.status, 'hash_snapshot_unavailable');
  assert.ok(
    input.hashes.status === 'hash_snapshot_unavailable' && input.hashes.error.includes('--word-diff-regex'),
    'the raw error must remain on the structured hashes object for diagnosis',
  );
  const escalation = input.escalations.find((entry) => entry.code === 'hash_snapshot_unavailable');
  assert.ok(escalation, 'a hash snapshot failure must still escalate');
  const detail = escalation!.detail;
  assert.equal(detail.includes('\n'), false, `the hash snapshot detail must be ONE line, got:\n${detail}`);
  assert.ok(detail.length <= 300, `the hash snapshot detail must be bounded, got ${detail.length} characters`);
  assert.match(detail, /not a git repository/i, 'the detail must CLASSIFY the failure in plain language');
  for (const line of LONG_GIT_USAGE_DUMP.split('\n').map((entry) => entry.trim()).filter((entry) => entry.length > 12)) {
    assert.equal(detail.includes(line), false, `a raw git usage line leaked into the hash snapshot detail: ${line}`);
  }

  const result = resolveValidationTierPlan({ input, requestedTier: 'story-fast' });
  const request = resolveValidationPlanRequest({ storyId: 'B-a745', tier: 'fast' });
  const rendered = renderValidationPlanText(
    buildValidationPlanReport({ request, storyPhase: 'DEV', input, result }),
    true,
  );
  assert.ok(rendered.split('\n').includes(VALIDATION_PLAN_STATUS_LINES[result.status]), 'the status line must remain a line of its own');
  assert.equal(rendered.includes('usage: git diff'), false, 'the git usage dump must never reach the rendered output');
});

testCase('a duration-history read failure renders a bounded one-line basis, never the raw dump', () => {
  const dump = ['Error: ENOENT: no such file or directory, open \'/repo/.proof-or-stop/validation/receipts.json\'']
    .concat(Array.from({ length: 40 }, (_, index) => `    at frame${index} (/repo/node_modules/some-module/index.js:${index + 1}:1)`))
    .join('\n');
  const input = planInput({
    durationHistory: {
      read: () => {
        throw new Error(dump);
      },
    },
  });
  assert.equal(input.durationHistory.status, 'unavailable');
  assert.ok(
    (input.durationHistory.readError ?? '').includes('at frame39'),
    'the raw read error must remain on the structured duration history for diagnosis',
  );
  const result = resolveValidationTierPlan({ input, requestedTier: 'story-fast' });
  assert.equal(result.status, 'plan');
  const request = resolveValidationPlanRequest({ storyId: 'B-a745', tier: 'fast' });
  const report = buildValidationPlanReport({ request, storyPhase: 'DEV', input, result });
  const basis = report.durationEstimate.basis;
  assert.equal(basis.includes('\n'), false, `the duration basis must be ONE line, got:\n${basis}`);
  assert.ok(basis.length <= 300, `the duration basis must be bounded, got ${basis.length} characters`);
  assert.match(basis, /ENOENT|could not be read/i, 'the basis must still say what went wrong');
  assert.equal(basis.includes('at frame'), false, 'a stack frame leaked into the duration basis');

  const rendered = renderValidationPlanText(report, true);
  const lines = rendered.split('\n');
  assert.ok(lines.includes(VALIDATION_PLAN_STATUS_LINES.plan), 'the status line must remain a line of its own');
  const basisLines = lines.filter((line) => line.startsWith('  basis: '));
  assert.equal(basisLines.length, 1, 'exactly one basis line must be rendered');
  assert.ok(basisLines[0].length <= 320, `the rendered basis line is not one bounded line: ${basisLines[0].length}`);
  assert.equal(rendered.includes('at frame'), false, 'a stack frame leaked into the rendered output');
});

testCase('a malformed evidence pin is reported as one bounded unclassified-input line', () => {
  const input = planInput({
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          verificationEvidence: [
            {
              intentRef: 'CHK-001:happy:0',
              kind: 'integration_test',
              // A non-string commandId beside a real command string: the pin is
              // present, and the resolver's runtime re-validation rejects it.
              commandId: 42 as never,
              command: 'npm test',
              result: 'pass',
              note: 'fixture evidence with a malformed commandId',
            },
          ],
        }),
      ],
    },
  });
  const malformed = input.unclassifiedInputs.find((entry) => entry.kind === 'evidence-pin' && /malformed pin/.test(entry.detail));
  assert.ok(malformed, 'a non-string commandId must be reported as a malformed pin');
  assert.equal(malformed!.detail.includes('\n'), false, 'the malformed-pin detail must be one line');
  assert.ok(malformed!.detail.length <= 300, `the malformed-pin detail must be bounded, got ${malformed!.detail.length}`);
});

// ---------------------------------------------------------------------------
// (21) DURATION HISTORY — collected from prior signed validation artifacts.
//      Absent history is UNKNOWN-duration, never zero.
// ---------------------------------------------------------------------------
testCase('duration history is collected and an absent history reports unknown-duration, never zero', () => {
  const input = collect({
    durationHistory: {
      artifacts: [
        {
          storyId: 'B-a745',
          status: 'PASS',
          receipts: [
            { label: 'unit', command: 'npm', args: ['test'], durationMs: 4000 },
            { label: 'unit', command: 'npm', args: ['test'], durationMs: 6000 },
          ],
        },
      ],
    },
  });
  assert.equal(input.durationHistory.status, 'collected');
  const unit = input.durationHistory.estimates.find((entry) => entry.commandId === 'unit-suite');
  assert.ok(unit, 'the matched command must carry an estimate');
  assert.equal(unit!.status, 'known');
  assert.equal(unit!.sampleCount, 2);
  assert.equal(typeof unit!.estimateMs, 'number');
  assert.ok((unit!.basis ?? '').length > 0, 'an estimate must name its basis');

  const lint = input.durationHistory.estimates.find((entry) => entry.commandId === 'lint-suite');
  assert.ok(lint, 'a command with no history must still be reported');
  assert.equal(lint!.status, 'unknown-duration');
  assert.equal(lint!.sampleCount, 0);
  assert.equal(lint!.estimateMs, undefined, 'no history must never be reported as a duration');
  assert.equal(
    Object.prototype.hasOwnProperty.call(lint!, 'estimateMs'),
    false,
    'an unknown duration must not even carry the key, so no reader can coerce it to 0',
  );

  const none = collect();
  for (const estimate of none.durationHistory.estimates) {
    assert.equal(estimate.status, 'unknown-duration');
    assert.equal(estimate.sampleCount, 0);
  }
});

// ---------------------------------------------------------------------------
// (22) ADVERSARIAL — duration history is ESTIMATE-ONLY: mutating it can never
//      change what would be selected.
// ---------------------------------------------------------------------------
testCase('mutating duration history leaves the selected set and the selection digest unchanged', () => {
  const seedsArgs: Partial<StoryRelevanceInputArgs> = {
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          files: { modify: ['src/core/machine-x.ts'], create: [], test: [] },
          verificationEvidence: [
            { intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'npm test', result: 'pass', note: 'fixture evidence' },
          ],
        }),
      ],
    },
    readers: {
      changedFileStatuses: statusReader({ 'src/core/touched.ts': 'M' }),
      hashSnapshot: fixtureHashSnapshot,
    },
  };
  const withoutHistory = collect(seedsArgs);
  const withHistory = collect({
    ...seedsArgs,
    durationHistory: {
      artifacts: [
        {
          storyId: 'B-a745',
          status: 'PASS',
          receipts: [
            { label: 'unit', command: 'npm', args: ['test'], durationMs: 999_999 },
            { label: 'lint', command: 'npm', args: ['run', 'lint'], durationMs: 1 },
          ],
        },
      ],
    },
  });

  assert.deepEqual(withHistory.seeds, withoutHistory.seeds, 'duration data must not change the seed set');
  assert.deepEqual(
    withHistory.pinnedCommands,
    withoutHistory.pinnedCommands,
    'duration data must not change pinned commands',
  );
  assert.deepEqual(
    withHistory.executionInventory.commandIds,
    withoutHistory.executionInventory.commandIds,
    'duration data must not change the execution inventory',
  );
  assert.equal(
    withHistory.selectionDigest,
    withoutHistory.selectionDigest,
    'the selection digest must be computed WITHOUT duration history, so an estimate can never widen or narrow selection',
  );
  assert.notDeepEqual(
    withHistory.durationHistory.estimates,
    withoutHistory.durationHistory.estimates,
    'the fixture must actually vary the duration data it claims cannot matter',
  );
});

// ---------------------------------------------------------------------------
// (23) ADVERSARIAL — verification intent is REASON CONTEXT only: on its own it
//      produces no command-to-seed edge. The spec: "never parsed as the only
//      machine mapping".
// ---------------------------------------------------------------------------
testCase('verification intent is carried as reason context and produces no command-to-seed edge', () => {
  const intentOnly = collect({
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          verificationIntent: {
            happy: [{ desc: 'npm test passes for the unit suite', type: 'cli', priority: 'must' }],
            edge: [{ desc: 'lint-suite still runs when config is absent', type: 'cli', priority: 'must' }],
            adversarial: [],
          },
        }),
      ],
    },
  });
  assert.equal(intentOnly.verificationIntentContext.length, 2, 'intent must be carried for the explain output');
  assert.equal(intentOnly.verificationIntentContext[0].itemId, 'CHK-001');
  assert.equal(intentOnly.verificationIntentContext[0].lane, 'happy');
  assert.match(intentOnly.verificationIntentContext[0].desc, /unit suite/);
  assert.deepEqual(
    intentOnly.commandSeedEdges,
    [],
    'intent text naming a command must NOT create a command-to-seed edge on its own',
  );
  assert.deepEqual(intentOnly.pinnedCommands, [], 'intent is not a pin');
  assert.deepEqual(
    intentOnly.seeds.filter((seed) => seed.kind === 'command'),
    [],
    'intent must not seed a command',
  );

  const withoutIntent = collect({
    checklist: { items: [checklistItem({ id: 'CHK-001' })] },
  });
  assert.equal(
    intentOnly.selectionDigest,
    withoutIntent.selectionDigest,
    'intent must be outside the selection digest: it is reason context, never a machine mapping',
  );

  // Every edge that DOES exist must be attributable to a machine pin.
  const pinned = collect({
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          verificationEvidence: [
            { intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'npm test', result: 'pass', note: 'fixture evidence' },
          ],
        }),
      ],
    },
  });
  assert.equal(pinned.commandSeedEdges.length, 1);
  assert.equal(pinned.commandSeedEdges[0].origin, 'evidence-pin');
  assert.equal(pinned.commandSeedEdges[0].commandId, 'unit-suite');
  for (const edge of pinned.commandSeedEdges) {
    assert.equal(edge.origin, 'evidence-pin', 'the ONLY command-to-seed edge origin is a machine-resolved pin');
  }
});

testCase('an unresolvable evidence pin is classified by what it claimed, not silently dropped', () => {
  const legacy = collect({
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          verificationEvidence: [
            { intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'npm run gone', result: 'pass', note: 'fixture evidence' },
          ],
        }),
      ],
    },
  });
  assert.deepEqual(legacy.pinnedCommands, []);
  assert.ok(legacy.escalations.some((entry) => entry.code === 'pinned_command_non_inventory'));
  assert.ok(!legacy.escalations.some((entry) => entry.code === 'pinned_command_missing'));
  assert.ok(legacy.unclassifiedInputs.some((entry) => entry.kind === 'evidence-pin'));
  assert.deepEqual(legacy.commandSeedEdges, [], 'a non-inventory pin may never seed a command');

  const declared = collect({
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          verificationEvidence: [
            {
              intentRef: 'CHK-001:happy:0',
              kind: 'integration_test',
              commandId: 'gone-suite',
              command: 'npm run gone',
              result: 'pass',
              note: 'fixture evidence',
            },
          ],
        }),
      ],
    },
  });
  assert.deepEqual(declared.pinnedCommands, []);
  assert.ok(declared.escalations.some((entry) => entry.code === 'pinned_command_missing'));
  assert.deepEqual(declared.commandSeedEdges, []);
});

// ---------------------------------------------------------------------------
// (24) Handler encoding convention: the collector re-validates its own inputs,
//      because a schema is only the first line of defence.
// ---------------------------------------------------------------------------
testCase('the collector re-validates a schema-bypassing caller input', () => {
  assert.throws(
    () => collect({ story: { storyId: '   ', phase: 'DEV' } }),
    /storyId/,
    'an empty storyId must be rejected at the collector entry',
  );
  assert.throws(
    () => collect({ routine: { sourceKind: 'nonsense' as never, commands: [] } }),
    /sourceKind/,
    'an unknown routine source kind must be rejected at the collector entry',
  );
});


// ---------------------------------------------------------------------------
// CHK-004 — language-neutral planner types and the fail-closed widening matrix
// (`core/validation-tier-planner.ts`). Spec sections "Terminology and
// invariants", "Selection algorithm" steps 1/2/5, and "Fail-closed widening
// matrix".
//
// The defining constraint of this Story: the resolver returns
// `effectiveTier: 'repository-full'` or a CLASSIFIED STOP. There is no code path
// that returns a reduced tier, no pruning, no impact index, no exclusion proof,
// and an empty selection is never a pass.
// ---------------------------------------------------------------------------

beginSection('CHK-004 tier planner and widening matrix cases');

const SOURCE_KINDS: RoutineValidationSourceKind[] = ['configured', 'fallback', 'validate-file', 'no-validator'];

function planInput(overrides: Partial<StoryRelevanceInputArgs> = {}): StoryRelevanceInput {
  return collect(overrides);
}

function planFor(
  requestedTier: ValidationTier,
  overrides: Partial<StoryRelevanceInputArgs> = {},
): ValidationTierPlanResult {
  return resolveValidationTierPlan({ input: planInput(overrides), requestedTier });
}

function reasonCodes(result: ValidationTierPlanResult): string[] {
  return result.escalationReasons.map((reason) => reason.code);
}

// ---------------------------------------------------------------------------
// (25) TIER VOCABULARY AND THE SUBSET INVARIANT.
//      The vocabulary is exactly the spec's three names, and the invariant
//      story-fast ⊆ story-intermediate ⊆ repository-full is ENCODED, not
//      described in a comment: a selection that violates it is rejected.
// ---------------------------------------------------------------------------
testCase('the tier vocabulary is exactly the three spec names, ordered by containment', () => {
  assert.deepEqual([...VALIDATION_TIERS], ['story-fast', 'story-intermediate', 'repository-full']);
  assert.equal(REPOSITORY_FULL_TIER, 'repository-full');
  assert.ok(validationTierRank('story-fast') < validationTierRank('story-intermediate'));
  assert.ok(validationTierRank('story-intermediate') < validationTierRank('repository-full'));
  assert.equal(validationTierIsSubsetOf('story-fast', 'repository-full'), true);
  assert.equal(validationTierIsSubsetOf('repository-full', 'story-fast'), false);
});

testCase('a tier selection that breaks the subset invariant is rejected', () => {
  assertValidationTierSelectionSubsetInvariant({
    'story-fast': ['a'],
    'story-intermediate': ['a', 'b'],
    'repository-full': ['a', 'b', 'c'],
  });
  assert.throws(
    () =>
      assertValidationTierSelectionSubsetInvariant({
        'story-fast': ['a', 'z'],
        'story-intermediate': ['a'],
        'repository-full': ['a'],
      }),
    /story-fast/,
    'a fast unit absent from the intermediate set must be rejected',
  );
  assert.throws(
    () =>
      assertValidationTierSelectionSubsetInvariant({
        'story-fast': ['a'],
        'story-intermediate': ['a', 'q'],
        'repository-full': ['a'],
      }),
    /story-intermediate/,
    'an intermediate unit absent from the repository-full set must be rejected',
  );
});

// ---------------------------------------------------------------------------
// (26) GLOSS COMPLETENESS BY ENUMERATION (load-bearing).
//      Asserted by walking the reason-code table itself, never a hand-copied
//      list of codes: a list would rot the moment someone adds a code, which is
//      exactly the silent omission this case exists to prevent. A bare code like
//      `impact_index_unusable` is unusable to an operator who has not read the
//      spec, so a code without a plain-language gloss must not be able to exist.
// ---------------------------------------------------------------------------
testCase('every reason code carries a non-empty plain-language gloss, asserted by enumeration', () => {
  const codes = Object.keys(VALIDATION_WIDENING_REASONS) as ValidationWideningReasonCode[];
  assert.ok(codes.length > 0, 'the widening matrix must not be empty');
  assert.deepEqual([...VALIDATION_WIDENING_REASON_CODES].sort(), [...codes].sort());
  for (const code of codes) {
    const definition = VALIDATION_WIDENING_REASONS[code];
    assert.equal(typeof definition.gloss, 'string', `${code}: gloss must be a string`);
    assert.ok(definition.gloss.trim().length >= 20, `${code}: gloss must be a real sentence, got ${JSON.stringify(definition.gloss)}`);
    assert.ok(definition.condition.trim().length > 0, `${code}: the matrix condition must be recorded`);
    assert.ok(VALIDATION_WIDENING_OUTCOMES.includes(definition.outcome), `${code}: unknown outcome ${definition.outcome}`);
    assert.equal(validationWideningReasonGloss(code), definition.gloss);
    const reason = validationWideningReason(code, 'fixture detail');
    assert.equal(reason.code, code);
    assert.equal(reason.gloss, definition.gloss);
    assert.equal(reason.outcome, definition.outcome);
    assert.equal(reason.detail, 'fixture detail');
  }
});

// ---------------------------------------------------------------------------
// (26b) B-a745 F-004 — A GLOSS MUST DESCRIBE THE SITUATION IT ACTUALLY FIRES IN.
//       `pinned_command_missing` used to read "points at a validation command
//       that no longer exists in this project ... until the evidence is
//       re-recorded". In the circumstance this Story reproduced, the command DID
//       exist and DID run: it was simply absent from `validate.commands`, the
//       separate registry the pin resolver consults. Following that advice sends
//       an operator to re-record evidence against a command that is not stale,
//       which is not a fix and cannot become one. A gloss that is confidently
//       worded and factually wrong is worse than a bare code.
// ---------------------------------------------------------------------------
testCase('the pin-related glosses name the registry boundary and a remedy that exists', () => {
  const FALSE_CLAIMS = [/no longer exists/i, /has been removed from this project/i, /is stale/i];
  for (const code of VALIDATION_WIDENING_REASON_CODES) {
    const gloss = validationWideningReasonGloss(code);
    for (const claim of FALSE_CLAIMS) {
      assert.ok(
        !claim.test(gloss),
        `${code} gloss asserts a disappearance it cannot know about: ${JSON.stringify(gloss)}`,
      );
    }
  }

  for (const code of ['pinned_command_missing', 'pinned_command_non_inventory'] as ValidationWideningReasonCode[]) {
    const gloss = validationWideningReasonGloss(code);
    assert.ok(
      /validation command inventory|registered validation commands/i.test(gloss),
      `${code} gloss must name the registry the resolver actually consults: ${JSON.stringify(gloss)}`,
    );
    assert.ok(
      /declare|register|restore/i.test(gloss),
      `${code} gloss must name a remedy that exists for a command absent from that registry, not merely ` +
      `"re-record the evidence": ${JSON.stringify(gloss)}`,
    );
  }

  // The two codes must not read as paraphrases of each other: they fire on
  // different claims and prescribe different actions.
  assert.notEqual(
    validationWideningReasonGloss('pinned_command_missing'),
    validationWideningReasonGloss('pinned_command_non_inventory'),
  );
  assert.equal(VALIDATION_WIDENING_REASONS.pinned_command_missing.outcome, 'stop');
  assert.equal(VALIDATION_WIDENING_REASONS.pinned_command_non_inventory.outcome, 'repository-full');

  // The resolver MESSAGE an operator actually reads must agree with the gloss.
  const missing = resolvePin(
    [command({ label: 'test', command: 'npm', args: ['test'], id: 'test-suite' })],
    { commandId: 'test-suite-renamed' },
  );
  assert.equal(missing.status, 'stop');
  assert.ok(
    missing.status === 'stop' && !/no longer exists/i.test(missing.message),
    'the stop message may not claim the command disappeared either',
  );
  assert.ok(
    missing.status === 'stop' && /declare|restore/i.test(missing.message),
    'the stop message must offer the remedy that matches the real situation',
  );
});

testCase('an unknown reason code has no gloss and is refused rather than glossed as empty', () => {
  assert.throws(
    () => validationWideningReasonGloss('not_a_matrix_row' as ValidationWideningReasonCode),
    /not_a_matrix_row/,
    'a code outside the table must be refused, never silently glossed as empty',
  );
});

// This is a LOWER BOUND on the table, transcribed from the spec's matrix. It is
// deliberately separate from the gloss check above: this list may legitimately
// lag the table when a later Story adds a row, whereas the gloss check must
// never be allowed to lag, which is why it enumerates instead.
testCase('the table covers every row of the spec fail-closed widening matrix', () => {
  const specMatrixCodes = [
    'changed_files_unavailable',
    'unclassified_material_input',
    'impact_index_unusable',
    'impact_projection_incomplete',
    'workspace_snapshot_changed',
    'selection_policy_changed',
    'validation_framework_sensitive_change',
    'build_graph_change',
    'runtime_edge_unresolved',
    'pinned_command_missing',
    'pinned_command_ambiguous',
    'command_exclusion_unproven',
    'source_kind_atomic',
    'no_validator',
    'empty_selection_unclassified',
    'docs_only_policy',
    'duration_target_exceeded',
  ];
  for (const code of specMatrixCodes) {
    assert.ok(code in VALIDATION_WIDENING_REASONS, `spec matrix row ${code} is missing from the table`);
  }
});

// ---------------------------------------------------------------------------
// (27) THE NORMAL CONFIGURED STORY.
//      Repository-full, the COMPLETE universe selected, and at least one
//      escalation reason saying why nothing was reduced.
// ---------------------------------------------------------------------------
testCase('a normal configured story plans repository-full over the complete universe', () => {
  const result = planFor('story-fast', {
    readers: { changedFileStatuses: statusReader({ 'src/core/foo.ts': 'M' }), hashSnapshot: fixtureHashSnapshot },
  });
  assert.equal(result.status, 'plan');
  if (result.status !== 'plan') return;
  assert.equal(result.requestedTier, 'story-fast', 'the requested tier is retained in the artifact');
  assert.equal(result.effectiveTier, 'repository-full');
  assert.equal(result.reductionApplied, false);
  assert.equal(result.finalAuthority, false);
  assert.equal(result.executionMode, 'command-set');
  assert.deepEqual(result.selectedUnitIds, ['unit-suite', 'lint-suite']);
  assert.deepEqual(result.universe.map((unit) => unit.id), ['unit-suite', 'lint-suite']);
  assert.ok(result.escalationReasons.length > 0, 'at least one reason must explain why nothing was reduced');
  for (const reason of result.escalationReasons) {
    assert.ok(reason.gloss.trim().length > 0, `${reason.code} reached an operator without a gloss`);
    assert.ok(reason.detail.trim().length > 0, `${reason.code} reached an operator without a detail`);
  }
  // Step 2: a repository-full escalation sets BOTH fast and intermediate to U.
  assert.deepEqual(result.tierSelections['story-fast'], result.selectedUnitIds);
  assert.deepEqual(result.tierSelections['story-intermediate'], result.selectedUnitIds);
  assert.deepEqual(result.tierSelections['repository-full'], result.selectedUnitIds);
});

testCase('no pruning exists: a story that changed nothing still selects the complete universe', () => {
  const result = planFor('story-intermediate');
  assert.equal(result.status, 'plan');
  if (result.status !== 'plan') return;
  assert.deepEqual(result.selectedUnitIds, ['unit-suite', 'lint-suite']);
  assert.ok(
    reasonCodes(result).includes('command_exclusion_unproven'),
    'without a positive exclusion proof no command may be dropped',
  );
  assert.ok(
    reasonCodes(result).includes('impact_index_unusable'),
    'there is no impact index in this increment, and the plan must say so',
  );
});

// ---------------------------------------------------------------------------
// (28) ALL FOUR SOURCE KINDS.
// ---------------------------------------------------------------------------
testCase('configured is the command-set path', () => {
  const result = planFor('repository-full', { routine: { sourceKind: 'configured', commands: RELEVANCE_COMMANDS } });
  assert.equal(result.status, 'plan');
  if (result.status !== 'plan') return;
  assert.equal(result.executionMode, 'command-set');
  assert.ok(!reasonCodes(result).includes('source_kind_atomic'));
});

for (const atomicKind of ['fallback', 'validate-file'] as const) {
  testCase(`${atomicKind} reports source_kind_atomic and executes its atomic repository-full path`, () => {
    const result = planFor('story-fast', { routine: { sourceKind: atomicKind, commands: RELEVANCE_COMMANDS } });
    assert.equal(result.status, 'plan');
    if (result.status !== 'plan') return;
    assert.equal(result.effectiveTier, 'repository-full');
    assert.equal(result.executionMode, 'atomic');
    assert.equal(result.selectedUnitIds.length, 1, 'an opaque source kind is ONE atomic unit');
    assert.equal(result.universe[0].kind, 'atomic');
    assert.ok(reasonCodes(result).includes('source_kind_atomic'));
  });
}

testCase('no-validator preserves the existing skip/warn and produces NO tier pass', () => {
  const result = planFor('story-fast', { routine: { sourceKind: 'no-validator', commands: [] } });
  assert.equal(result.status, 'no-tier-pass');
  if (result.status !== 'no-tier-pass') return;
  assert.equal(result.reason.code, 'no_validator');
  assert.equal((result as { effectiveTier?: unknown }).effectiveTier, undefined, 'a skip must not carry an effective tier');
  assert.equal((result as { selectedUnitIds?: unknown }).selectedUnitIds, undefined);
  assert.equal(result.finalAuthority, false);
});

// ---------------------------------------------------------------------------
// (29) AN UNCLASSIFIED MATERIAL INPUT.
//      It must appear BOTH as an escalation reason and in `unclassifiedInputs`:
//      a reason with nothing behind it cannot be acted on, and an entry that
//      never escalates is a silent narrowing.
// ---------------------------------------------------------------------------
testCase('an unclassified material input escalates AND is listed', () => {
  const result = planFor('story-fast', {
    readers: {
      changedFileStatuses: statusReader({ 'src/core/unmapped-thing.ts': 'M' }),
      hashSnapshot: fixtureHashSnapshot,
    },
  });
  assert.equal(result.status, 'plan');
  if (result.status !== 'plan') return;
  assert.ok(reasonCodes(result).includes('unclassified_material_input'));
  const listed = result.unclassifiedInputs.filter((entry) => entry.value === 'src/core/unmapped-thing.ts');
  assert.equal(listed.length, 1, 'the unclassified path itself must be listed, not just counted');
  assert.equal(listed[0].kind, 'material-path');
});

testCase('an unresolvable explicit commandId collected upstream becomes a classified stop, never a plan', () => {
  const result = planFor('story-fast', {
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          verificationEvidence: [
            {
              intentRef: 'CHK-001:happy:0',
              kind: 'integration_test',
              commandId: 'gone-suite',
              command: 'npm run gone',
              result: 'pass',
              note: 'fixture evidence',
            },
          ],
        }),
      ],
    },
  });
  assert.equal(result.status, 'stop');
  if (result.status !== 'stop') return;
  assert.equal(result.reason.code, 'pinned_command_missing');
  assert.equal((result as { effectiveTier?: unknown }).effectiveTier, undefined);
});

// ---------------------------------------------------------------------------
// (29b) B-a745 F-001 — a NON-INVENTORY legacy pin widens; it never stops and it
//       never prunes. Written so the outcome is checked on both halves: the plan
//       must exist AND it must still select the complete universe, because the
//       whole justification for not stopping is that nothing is omitted.
// ---------------------------------------------------------------------------
testCase('a non-inventory legacy pin plans repository-full instead of stopping, and seeds no command', () => {
  const overrides = {
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          verificationEvidence: [
            { intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'npm run gone', result: 'pass', note: 'fixture evidence' },
          ],
        }),
      ],
    },
  };
  const input = planInput(overrides);
  assert.deepEqual(input.commandSeedEdges, [], 'a non-inventory pin adds no command-to-seed edge');

  const result = resolveValidationTierPlan({ input, requestedTier: 'story-fast' });
  assert.equal(result.status, 'plan', 'a free-form pin naming a non-inventory command must not stop the plan');
  if (result.status !== 'plan') return;
  assert.equal(result.effectiveTier, 'repository-full');
  assert.ok(
    reasonCodes(result).includes('pinned_command_non_inventory'),
    'the classification must reach the operator as a glossed escalation reason',
  );
  assert.deepEqual(
    result.selectedUnitIds,
    result.universe.map((unit) => unit.id),
    'nothing may be omitted on a non-inventory pin account: that is why it is allowed not to stop',
  );
  assert.ok(result.selectedUnitIds.length > 0);
});

// ---------------------------------------------------------------------------
// (30) EXHAUSTIVE BRANCH COVERAGE (load-bearing).
//      `story-fast` and `story-intermediate` are never returned as an EFFECTIVE
//      tier. This is proven by sweeping the resolver's whole input space, not by
//      a comment promising it.
// ---------------------------------------------------------------------------
testCase('no input in the resolver space yields a reduced effective tier', () => {
  const observedStatuses = new Set<string>();
  const observedReasons = new Set<string>();
  let combinations = 0;
  const nonInventoryPin = [
    checklistItem({
      id: 'CHK-001',
      verificationEvidence: [
        { intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'npm run gone', result: 'pass', note: 'fixture evidence' },
      ],
    }),
  ];
  const unresolvableIdPin = [
    checklistItem({
      id: 'CHK-001',
      verificationEvidence: [
        {
          intentRef: 'CHK-001:happy:0',
          kind: 'integration_test',
          commandId: 'gone-suite',
          command: 'npm run gone',
          result: 'pass',
          note: 'fixture evidence',
        },
      ],
    }),
  ];
  const pinKinds = {
    none: [] as ChecklistItem[],
    'legacy-non-inventory': nonInventoryPin,
    'unresolvable-id': unresolvableIdPin,
  };

  for (const requestedTier of VALIDATION_TIERS) {
    for (const sourceKind of SOURCE_KINDS) {
      for (const changedFilesReadable of [true, false]) {
        for (const pinKind of Object.keys(pinKinds) as Array<keyof typeof pinKinds>) {
          for (const emptyUniverse of [true, false]) {
            combinations += 1;
            const result = planFor(requestedTier, {
              routine: {
                sourceKind,
                commands: sourceKind === 'no-validator' || emptyUniverse ? [] : RELEVANCE_COMMANDS,
              },
              checklist: { items: pinKinds[pinKind] },
              readers: {
                changedFileStatuses: changedFilesReadable
                  ? statusReader({ 'src/core/foo.ts': 'M' })
                  : throwingStatusReader,
                hashSnapshot: fixtureHashSnapshot,
              },
            });
            observedStatuses.add(result.status);
            for (const code of reasonCodes(result)) observedReasons.add(code);
            const effective = (result as { effectiveTier?: unknown }).effectiveTier;
            assert.ok(
              effective === undefined || effective === 'repository-full',
              `effectiveTier ${String(effective)} escaped for ${requestedTier}/${sourceKind}`,
            );
            assert.notEqual(effective, 'story-fast');
            assert.notEqual(effective, 'story-intermediate');
            if (result.status === 'plan') {
              assert.equal(result.reductionApplied, false);
              assert.ok(result.selectedUnitIds.length > 0, 'a plan may never carry an empty selection');
              assert.deepEqual(result.selectedUnitIds, result.universe.map((unit) => unit.id));
            }
            assert.equal((result as { allPass?: unknown }).allPass, undefined, 'the planner never asserts a pass');
          }
        }
      }
    }
  }

  assert.equal(combinations, 144, 'the sweep must cover the full cartesian product');
  assert.deepEqual([...observedStatuses].sort(), ['no-tier-pass', 'plan', 'stop']);
  for (const expected of [
    'impact_index_unusable',
    'command_exclusion_unproven',
    'changed_files_unavailable',
    'source_kind_atomic',
    'pinned_command_non_inventory',
  ]) {
    assert.ok(observedReasons.has(expected), `the sweep never exercised ${expected}`);
  }
});

// ---------------------------------------------------------------------------
// (31) AN EMPTY UNIVERSE IS A CLASSIFIED STOP, NEVER A PASSING EMPTY PLAN.
//      Written so an implementation returning `{allPass: true, selected: []}`
//      fails: the status must be a stop, the reason must be named, and no
//      pass-shaped field may exist.
// ---------------------------------------------------------------------------
testCase('an empty universe stops as empty_selection_unclassified rather than passing empty', () => {
  const result = planFor('repository-full', { routine: { sourceKind: 'configured', commands: [] } });
  assert.equal(result.status, 'stop', 'an empty universe must STOP, not produce an empty plan');
  assert.notEqual(result.status, 'plan');
  if (result.status !== 'stop') return;
  assert.equal(result.reason.code, 'empty_selection_unclassified');
  assert.ok(result.reason.gloss.trim().length > 0);
  assert.equal((result as { allPass?: unknown }).allPass, undefined, 'no pass-shaped field may exist on a stop');
  assert.equal((result as { selectedUnitIds?: unknown }).selectedUnitIds, undefined, 'a stop selects nothing at all');
  assert.equal((result as { effectiveTier?: unknown }).effectiveTier, undefined);
});

// ---------------------------------------------------------------------------
// (31b) B-a745 F-006 — THE TABLE IS THE ONLY SOURCE OF TRUTH FOR "THIS STOPS".
//       The resolver used to branch on a hand-written pair of code names, which
//       is a second copy of a fact the widening matrix already declares through
//       `outcome: 'stop'`. F-001 changed which pin codes stop, so this is
//       exactly the duplication a future edit would drift. These cases drive the
//       resolver by ENUMERATING the table, so a row whose outcome becomes (or
//       stops being) `stop` is honoured without editing the resolver at all.
// ---------------------------------------------------------------------------
testCase('the stop-code list is derived from the table and the resolver consults it', () => {
  const derived = VALIDATION_WIDENING_REASON_CODES
    .filter((code) => VALIDATION_WIDENING_REASONS[code].outcome === 'stop')
    .sort();
  assert.deepEqual([...VALIDATION_STOP_REASON_CODES].sort(), derived, 'the stop list must be derived, not written');
  assert.ok(derived.length > 0, 'the table must declare at least one stop row for this case to mean anything');

  for (const code of VALIDATION_WIDENING_REASON_CODES) {
    assert.equal(
      isValidationStopReasonCode(code),
      VALIDATION_WIDENING_REASONS[code].outcome === 'stop',
      `${code}: the predicate must agree with the table row, never with a second list`,
    );
  }
  assert.equal(isValidationStopReasonCode('not_a_widening_code'), false, 'an unknown code is not a stop');
  assert.equal(isValidationStopReasonCode(undefined), false);

  // Drive the resolver through a schema-bypassing input for EVERY escalation
  // code the collector can emit, and require the outcome to follow the table.
  const collectorCodes = [
    'changed_files_unavailable',
    'hash_snapshot_unavailable',
    'pinned_command_missing',
    'pinned_command_ambiguous',
    'pinned_command_non_inventory',
  ] as const;
  for (const code of collectorCodes) {
    const input = {
      ...planInput(),
      escalations: [{ code, detail: `fixture escalation for ${code}` }],
    } as StoryRelevanceInput;
    const result = resolveValidationTierPlan({ input, requestedTier: 'story-fast' });
    if (isValidationStopReasonCode(code)) {
      assert.equal(result.status, 'stop', `${code} declares outcome stop, so the resolver must stop`);
      assert.equal(result.status === 'stop' && result.reason.code, code);
    } else {
      assert.notEqual(result.status, 'stop', `${code} does not declare outcome stop, so the resolver may not stop`);
    }
  }

  // Both stop RETURNS are bound to the table, not only the escalation branch.
  const emptyUniverse = planFor('repository-full', { routine: { sourceKind: 'configured', commands: [] } });
  assert.equal(emptyUniverse.status, 'stop');
  assert.ok(
    emptyUniverse.status === 'stop' && isValidationStopReasonCode(emptyUniverse.reason.code),
    'the empty-universe stop must carry a code the table declares as a stop',
  );
  assert.equal(emptyUniverse.status === 'stop' && emptyUniverse.reason.outcome, 'stop');
});

// ---------------------------------------------------------------------------
// (32) HANDLER ENCODING CONVENTION — the planner core re-validates its inputs,
//      because a schema constraint upstream is only the first line of defence.
// ---------------------------------------------------------------------------
testCase('the planner core rejects a schema-bypassing tier and a malformed input', () => {
  assert.throws(
    () => resolveValidationTierPlan({ input: planInput(), requestedTier: 'story-quick' as ValidationTier }),
    /story-quick/,
    'an unknown tier must be rejected by name at the core entry',
  );
  assert.throws(
    () => resolveValidationTierPlan({ input: planInput(), requestedTier: '' as ValidationTier }),
    /tier/,
    'an empty tier must be rejected at the core entry',
  );
  assert.throws(
    () => resolveValidationTierPlan({ input: undefined as unknown as StoryRelevanceInput, requestedTier: 'story-fast' }),
    /input/,
    'a missing StoryRelevanceInput must be rejected at the core entry',
  );
  assert.equal(assertValidationTier('story-fast', 'fixture'), 'story-fast');
  assert.throws(() => assertValidationTier(7, 'fixture'), /fixture/);
});


// ---------------------------------------------------------------------------
// CHK-005 — the read-only `validation_plan` CLI.
//
// Spec: section "Proposed CLI and UX" (owned by story B-ccf4, not yet on main).
//
// The CLI is the only surface of this Story a human ever touches, so these cases
// assert the OUTPUT CONTRACT, not merely that a function returns something:
// every field the spec's "Human output must show" list names has to be present
// and LABELLED, the counts have to be derived at runtime, and every escalation
// code has to arrive with its gloss attached — a bare code is exactly what the
// product review rejected.
// ---------------------------------------------------------------------------

beginSection('CHK-005 validation_plan CLI cases');

const PLAN_CLI_STORY_ID = 'B-a745';

/**
 * A complete project root: a Proof-or-Stop config declaring validate.commands, a
 * story, and a checklist. Deliberately NOT a git repository — the collector then
 * degrades to `changed_files_unavailable` / an empty hash snapshot through its
 * own classified paths, which is a real production state and keeps the case
 * deterministic on any host.
 */
function planCliRoot(options: {
  commands?: unknown[];
  phase?: string;
  items?: ChecklistItem[];
  doneRequiredEvidence?: Record<string, unknown>;
} = {}): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-validation-plan-'));
  temporaryRoots.push(root);
  writeFileSync(
    join(root, 'proof-or-stop.config.json'),
    `${JSON.stringify({
      storyDir: '.proof-or-stop/story/actives',
      validate: {
        commands: options.commands ?? [
          { label: 'unit', command: 'npm', args: ['test'], id: 'unit-suite' },
          { label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'lint-suite' },
        ],
      },
    }, null, 2)}\n`,
    'utf-8',
  );
  resetConfigCache();
  const store = new StoryStore(root);
  store.writeStory(PLAN_CLI_STORY_ID, {
    storyId: PLAN_CLI_STORY_ID,
    name: 'validation-plan-cli',
    title: 'Read-only validation planner CLI',
    description: 'Fixture story for the validation_plan CLI contract.',
    type: 'feature',
    phase: (options.phase ?? 'DEV') as StoryInfo['phase'],
    priority: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
  });
  store.writeChecklist(PLAN_CLI_STORY_ID, { items: options.items ?? [] });
  if (options.doneRequiredEvidence) {
    store.writeDoneRequiredEvidence(
      PLAN_CLI_STORY_ID,
      options.doneRequiredEvidence as unknown as Parameters<StoryStore['writeDoneRequiredEvidence']>[1],
    );
  }
  const ctx = { store, root, scanRoot: root } as HandlerContext;
  return { root, store, ctx };
}

function planCli(ctx: HandlerContext) {
  return createValidationPlanHandlers(ctx).validation_plan;
}

/** Every byte under a directory tree, so ANY write anywhere fails the comparison. */
function treeBytes(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (path: string, relativePath: string): void => {
    if (!statSync(path).isDirectory()) {
      result[relativePath] = readFileSync(path).toString('base64');
      return;
    }
    for (const name of readdirSync(path).sort()) {
      visit(join(path, name), relativePath ? `${relativePath}/${name}` : name);
    }
  };
  try {
    visit(root, '');
  } catch {
    return {};
  }
  return result;
}

/**
 * A StoryStore whose every mutating method THROWS. The byte snapshot alone is
 * not enough: a store write that happens to rewrite identical bytes would slip
 * past it. Together they close both halves — this proxy catches any store write,
 * and the snapshot catches any other filesystem write.
 */
function refuseWritesStore(store: StoryStore): StoryStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      const name = typeof property === 'string' ? property : '';
      if (/^(write|append|delete|remove|clear|save|persist)/.test(name)) {
        return () => {
          throw new Error(`validation_plan called the mutating store method ${name}; it is contractually read-only`);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as StoryStore;
}

function planCliTool() {
  const tool = MAIN_TOOLS.find((entry) => entry.name === 'validation_plan');
  assert.ok(tool, 'validation_plan must be registered in the CLI command catalog');
  return tool!;
}

// ---------------------------------------------------------------------------
// (33) HUMAN OUTPUT (load-bearing) — every labelled field the spec's output list
//      names, with runtime-derived counts and `finalAuthority: no`.
// ---------------------------------------------------------------------------
testCase('validation_plan --tier=fast prints every labelled field including finalAuthority: no', () => {
  const { ctx } = planCliRoot();
  const text = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', explain: true });

  assert.match(text, /^requestedTier: story-fast \(requested as "fast"\)$/m);
  assert.match(text, /^effectiveTier: repository-full$/m);
  assert.match(text, /^selected: 2 of 2 validation unit\(s\)$/m);
  assert.match(text, /^finalAuthority: no$/m);
  assert.match(text, /^sourceKind: configured$/m);
  assert.match(text, /^status: plan$/m);

  // Per-command inclusion reasons, GROUPED BY COMMAND.
  assert.match(text, /^inclusion reasons by unit \(2\):$/m);
  assert.match(text, /^ {2}unit-suite \[unit\]$/m);
  assert.match(text, /^ {2}lint-suite \[lint\]$/m);
  assert.match(text, /included: .*command_exclusion_unproven/);

  // Unclassified inputs are LISTED under their own label.
  assert.match(text, /^unclassified inputs \(\d+\):$/m);

  // Every escalation code is followed by its plain-language gloss.
  assert.match(text, /^escalation reasons \(\d+\):$/m);
  for (const code of ['impact_index_unusable', 'command_exclusion_unproven']) {
    const gloss = validationWideningReasonGloss(code as ValidationWideningReasonCode);
    assert.ok(text.includes(`[${code}]`), `escalation code ${code} is not printed`);
    assert.ok(text.includes(gloss.slice(0, 60)), `escalation code ${code} is printed without its gloss`);
  }

  // Estimated duration WITH its basis.
  assert.match(text, /^estimatedDuration: /m);
  assert.match(text, /^ {2}basis: /m);

  // No reader may mistake this for a written selection artifact.
  assert.match(text, /^artifact: none /m);

  // Inventory warnings are surfaced, not swallowed.
  assert.match(text, /^inventoryWarnings \(\d+\):$/m);
});

testCase('the provisional-id migration warning reaches the operator instead of being swallowed', () => {
  const { ctx } = planCliRoot({
    commands: [
      { label: 'unit', command: 'npm', args: ['test'] },
      { label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'lint-suite' },
    ],
  });
  const report = JSON.parse(planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', json: true })) as Record<string, any>;
  assert.ok(report.inventoryWarnings.length > 0, 'a project still on provisional ids must warn');
  assert.ok(
    report.inventoryWarnings.some((warning: string) => warning.includes('1')),
    'the warning must name the count of commands still lacking a declared id',
  );
  const text = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', explain: true });
  for (const warning of report.inventoryWarnings) assert.ok(text.includes(warning), 'every warning is printed');
});

testCase('without --explain the unit list is previewed, and --explain lists every unit', () => {
  const commands = Array.from({ length: 8 }, (_unused, index) => ({
    label: `suite-${index}`,
    command: 'npm',
    args: ['run', `suite-${index}`],
    id: `suite-${index}`,
  }));
  const { ctx } = planCliRoot({ commands });
  const preview = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast' });
  const full = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', explain: true });
  // Both modes label every field; only the LIST length differs.
  assert.match(preview, /^selected: 8 of 8 validation unit\(s\)$/m);
  assert.match(preview, /^finalAuthority: no$/m);
  assert.match(preview, /^ {2}\.\.\. 3 more unit\(s\); rerun with --explain to list every one$/m);
  assert.equal(preview.includes('suite-7 [suite-7]'), false, 'the preview stops at the limit');
  assert.equal(full.includes('suite-7 [suite-7]'), true, '--explain lists every unit');
  assert.doesNotMatch(full, /rerun with --explain/);
});

testCase('the printed counts are derived at runtime, not written into the renderer', () => {
  const three = planCliRoot({
    commands: [
      { label: 'unit', command: 'npm', args: ['test'], id: 'unit-suite' },
      { label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'lint-suite' },
      { label: 'types', command: 'npx', args: ['tsc', '--noEmit'], id: 'types-suite' },
    ],
  });
  const text = planCli(three.ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'intermediate', explain: true });
  assert.match(text, /^selected: 3 of 3 validation unit\(s\)$/m);
  assert.match(text, /^inclusion reasons by unit \(3\):$/m);
  assert.match(text, /^requestedTier: story-intermediate \(requested as "intermediate"\)$/m);
});

testCase('a no-validator project reports no tier pass instead of an empty plan', () => {
  const { ctx } = planCliRoot({ commands: [] });
  const text = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'full' });
  assert.match(text, /^status: no-tier-pass$/m);
  assert.match(text, /^finalAuthority: no$/m);
  assert.ok(text.includes('[no_validator]'), 'the no-validator reason code must be printed');
  assert.ok(
    text.includes(validationWideningReasonGloss('no_validator').slice(0, 60)),
    'the no-validator code must be printed with its gloss',
  );
  assert.doesNotMatch(text, /^effectiveTier: /m, 'a no-tier-pass result carries no effective tier at all');
});

// ---------------------------------------------------------------------------
// (33b) B-a745 F-002 — THE STATUS LINE IS THE DISCRIMINATOR, and it is the only
//       thing a selector may key on to tell a produced plan from a refusal.
//
//       This case exists because a real recorded receipt for this Story's own
//       flagship claim pinned the selector `finalAuthority: no`, which the
//       renderer prints on EVERY branch. The command was stopping with
//       `selected: 0 of 0`, the selector matched anyway, and the evidence was
//       stamped `result: pass` while its own outputTail contained the failure.
//
//       `finalAuthority: no` is deliberately KEPT on every branch — a stop is
//       not final authority either — so the fix is not to remove it but to
//       guarantee a discriminating line exists and that no shared line can be
//       mistaken for one.
// ---------------------------------------------------------------------------
testCase('a plan render and a stop render differ on the documented status discriminator', () => {
  const stopItems = [
    checklistItem({
      id: 'CHK-001',
      verificationEvidence: [
        {
          intentRef: 'CHK-001:happy:0',
          kind: 'integration_test',
          commandId: 'gone-suite',
          command: 'npm run gone',
          result: 'pass',
          note: 'fixture evidence',
        },
      ],
    }),
  ];
  const planText = planCli(planCliRoot().ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', explain: true });
  const stopText = planCli(planCliRoot({ items: stopItems }).ctx)(
    { storyId: PLAN_CLI_STORY_ID, tier: 'fast', explain: true },
  );

  assert.equal(VALIDATION_PLAN_STATUS_LINES.plan, 'status: plan');
  assert.equal(VALIDATION_PLAN_STATUS_LINES.stop, 'status: stop');

  const planLines = planText.split('\n');
  const stopLines = stopText.split('\n');
  assert.ok(planLines.includes(VALIDATION_PLAN_STATUS_LINES.plan), 'a produced plan must print its own status line');
  assert.ok(stopLines.includes(VALIDATION_PLAN_STATUS_LINES.stop), 'a stop must print its own status line');
  // Substring, not line membership: a naive selector greps the whole output, so
  // the other outcome's discriminator may not appear even inside prose.
  assert.ok(!stopText.includes(VALIDATION_PLAN_STATUS_LINES.plan), 'no stop render may contain "status: plan"');
  assert.ok(!planText.includes(VALIDATION_PLAN_STATUS_LINES.stop), 'no plan render may contain "status: stop"');

  // Every line the two renders SHARE is non-discriminating BY CONSTRUCTION: no
  // shared line may start with an outcome-bearing prefix. This is the mechanical
  // form of "a selector must not be able to pick a line that matches both".
  const shared = planLines.filter((line) => stopLines.includes(line));
  for (const line of shared) {
    for (const prefix of VALIDATION_PLAN_OUTCOME_BEARING_LINE_PREFIXES) {
      assert.ok(
        !line.startsWith(prefix),
        `shared line ${JSON.stringify(line)} starts with the outcome-bearing prefix ${JSON.stringify(prefix)}, ` +
        'so a selector could match it on a failing run',
      );
    }
  }

  // The exact selector that produced the false positive. It stays printed on
  // every branch on purpose, which is precisely why it may never be reachable as
  // the discriminator.
  assert.ok(shared.includes('finalAuthority: no'), 'finalAuthority: no must keep printing on every branch');
  assert.ok(
    !(Object.values(VALIDATION_PLAN_STATUS_LINES) as readonly string[]).includes('finalAuthority: no'),
    'finalAuthority: no is not, and must never become, the status discriminator',
  );
});

testCase('every planner outcome renders only its own status line, and a forged plan status is refused', () => {
  const request = resolveValidationPlanRequest({ storyId: PLAN_CLI_STORY_ID, tier: 'fast' });
  const outcomes: Array<{ label: string; overrides: Partial<StoryRelevanceInputArgs> }> = [
    { label: 'plan', overrides: {} },
    {
      label: 'stop (unresolvable commandId)',
      overrides: {
        checklist: {
          items: [
            checklistItem({
              id: 'CHK-001',
              verificationEvidence: [
                {
                  intentRef: 'CHK-001:happy:0',
                  kind: 'integration_test',
                  commandId: 'gone-suite',
                  command: 'npm run gone',
                  result: 'pass',
                  note: 'fixture evidence',
                },
              ],
            }),
          ],
        },
      },
    },
    { label: 'stop (empty universe)', overrides: { routine: { sourceKind: 'configured', commands: [] } } },
    { label: 'no-tier-pass', overrides: { routine: { sourceKind: 'no-validator', commands: [] } } },
  ];

  const seen = new Set<string>();
  for (const outcome of outcomes) {
    const input = planInput(outcome.overrides);
    const result = resolveValidationTierPlan({ input, requestedTier: 'story-fast' });
    const rendered = renderValidationPlanText(
      buildValidationPlanReport({ request, storyPhase: 'DEV', input, result }),
      true,
    );
    seen.add(result.status);
    assert.ok(
      rendered.split('\n').includes(VALIDATION_PLAN_STATUS_LINES[result.status]),
      `${outcome.label} must render ${VALIDATION_PLAN_STATUS_LINES[result.status]}`,
    );
    for (const [status, line] of Object.entries(VALIDATION_PLAN_STATUS_LINES)) {
      if (status === result.status) continue;
      assert.ok(!rendered.includes(line), `${outcome.label} leaked another outcome's discriminator: ${line}`);
    }
  }
  assert.deepEqual([...seen].sort(), ['no-tier-pass', 'plan', 'stop'], 'all three outcomes must be exercised');

  // A report that CLAIMS a plan while carrying refusal-shaped facts is refused
  // at the render boundary, so no stop branch can ever emit `status: plan`.
  const planInputForForgery = planInput();
  const planReport = buildValidationPlanReport({
    request,
    storyPhase: 'DEV',
    input: planInputForForgery,
    result: resolveValidationTierPlan({ input: planInputForForgery, requestedTier: 'story-fast' }),
  });
  assertValidationPlanStatusInvariant(planReport);
  for (const forged of [
    { ...planReport, counts: { selected: 0, total: 0 } },
    { ...planReport, effectiveTier: null },
    { ...planReport, executionMode: null },
  ]) {
    assert.throws(
      () => renderValidationPlanText(forged, true),
      /status: plan/,
      'a refusal-shaped report claiming status: plan must be refused, not rendered',
    );
  }
});

// ---------------------------------------------------------------------------
// (33b) B-a745 F-024 / F-025: the status invariant guards EVERY consumption
//       point. A schema-bypassing report that contradicts itself is refused
//       on the --json path with the same message the text path throws, and a
//       consistent report renders on both.
// ---------------------------------------------------------------------------
testCase('F-024/F-025: the --json render path refuses an inconsistent report exactly as the text path does', () => {
  const request = resolveValidationPlanRequest({ storyId: 'B-a745', tier: 'fast' });
  const input = planInput();
  const result = resolveValidationTierPlan({ input, requestedTier: 'story-fast' });
  const report = buildValidationPlanReport({ request, storyPhase: 'DEV', input, result });
  assert.equal(report.status, 'plan');

  // A consistent report renders on BOTH paths, and the JSON path emits the report itself.
  const json = renderValidationPlanReport(report, { json: true, explain: false });
  assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(report)), 'the JSON path must emit the report unchanged');
  assert.doesNotThrow(() => renderValidationPlanReport(report, { json: false, explain: true }));
  assert.equal(
    renderValidationPlanReport(report, { json: false, explain: true }),
    renderValidationPlanText(report, true),
    'the text path must be the same render whichever entry point is used',
  );

  const forgeries: Array<{ label: string; forged: unknown; expect: RegExp }> = [
    {
      label: 'status: plan over an empty universe with no escalation reason',
      forged: { ...report, counts: { selected: 0, total: 0 }, units: [], escalationReasons: [] },
      expect: /status: plan/,
    },
    {
      label: 'status: stop that still carries a selection',
      forged: { ...report, status: 'stop' },
      expect: /stop result may not carry plan-shaped facts/,
    },
    {
      label: 'freshnessBinding "bound" with a null headHash',
      forged: {
        ...report,
        freshnessBinding: {
          status: 'bound',
          headHash: null,
          materialHash: 'material00000000000000000000000000000000',
          storyFilesHash: 'storyfiles000000000000000000000000000000',
        },
      },
      expect: /headHash/,
    },
    {
      label: 'no freshnessBinding at all',
      forged: (() => { const { freshnessBinding: _dropped, ...rest } = report; return rest; })(),
      expect: /freshnessBinding/,
    },
  ];

  for (const { label, forged, expect } of forgeries) {
    let textError: unknown = null;
    try {
      renderValidationPlanReport(forged as Parameters<typeof renderValidationPlanReport>[0], { json: false, explain: true });
    } catch (error) {
      textError = error;
    }
    assert.ok(textError instanceof Error, `${label}: the text path must refuse the report`);
    assert.match(textError.message, expect, `${label}: the text path must name the contradiction`);

    let jsonError: unknown = null;
    let emitted: string | null = null;
    try {
      emitted = renderValidationPlanReport(forged as Parameters<typeof renderValidationPlanReport>[0], { json: true, explain: false });
    } catch (error) {
      jsonError = error;
    }
    assert.ok(
      jsonError instanceof Error,
      `${label}: the --json path must refuse the report instead of emitting ${emitted === null ? 'nothing' : emitted.slice(0, 80)}`,
    );
    assert.equal(jsonError.message, textError.message, `${label}: both paths must throw the SAME message`);
  }

  // ONE choke point, not one per output shape (F-006 class): the handler source
  // invokes the invariant exactly once, inside renderValidationPlanReport.
  const repoRoot = (gitOutput(['rev-parse', '--show-toplevel']) ?? '').trim();
  assert.ok(repoRoot, 'this guard reads the real handler source; a missing repository is a failure, not a skip');
  const handlerSource = readFileSync(join(repoRoot, 'packages/main/src/handlers/validation-plan.ts'), 'utf-8');
  const callSites = handlerSource
    .split('\n')
    .filter((line) => line.includes('assertValidationPlanStatusInvariant(') && !line.includes('export function assertValidationPlanStatusInvariant('));
  assert.equal(callSites.length, 1, `the invariant must be invoked from exactly one place, found:\n${callSites.join('\n')}`);
  assert.match(callSites[0], /const statusLine = assertValidationPlanStatusInvariant\(report\);/);
});

// ---------------------------------------------------------------------------
// (34) --json — one parseable object carrying the SAME facts.
// ---------------------------------------------------------------------------
testCase('validation_plan --json emits one parseable object carrying the same facts', () => {
  const { ctx } = planCliRoot();
  const raw = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', json: true });
  const report = JSON.parse(raw) as Record<string, any>;

  assert.equal(report.storyId, PLAN_CLI_STORY_ID);
  assert.equal(report.status, 'plan');
  assert.equal(report.requestedTierInput, 'fast');
  assert.equal(report.requestedTier, 'story-fast');
  assert.equal(report.effectiveTier, 'repository-full');
  assert.equal(report.finalAuthority, false);
  assert.equal(report.sourceKind, 'configured');
  assert.equal(report.counts.selected, 2);
  assert.equal(report.counts.total, 2);
  assert.equal(report.units.length, 2);
  assert.deepEqual(report.units.map((unit: any) => unit.id).sort(), ['lint-suite', 'unit-suite']);
  for (const unit of report.units) {
    assert.ok(Array.isArray(unit.inclusionReasons) && unit.inclusionReasons.length > 0);
    assert.ok(typeof unit.duration.basis === 'string' && unit.duration.basis.length > 0);
  }
  assert.ok(Array.isArray(report.unclassifiedInputs));
  assert.ok(report.escalationReasons.length > 0);
  for (const reason of report.escalationReasons) {
    assert.ok(typeof reason.gloss === 'string' && reason.gloss.trim().length > 0, `${reason.code} has no gloss`);
    assert.equal(reason.gloss, validationWideningReasonGloss(reason.code));
  }
  assert.ok(typeof report.durationEstimate.basis === 'string' && report.durationEstimate.basis.length > 0);
  assert.equal(report.artifact.written, false);
  assert.equal(report.artifact.path, null);

  // The same facts, not a second computation: the human text agrees.
  const text = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', explain: true });
  assert.match(text, new RegExp(`^selected: ${report.counts.selected} of ${report.counts.total} `, 'm'));
  assert.match(text, new RegExp(`^effectiveTier: ${report.effectiveTier}$`, 'm'));
});

testCase('duration history from prior signed validation artifacts reaches the report with its basis', () => {
  const { ctx } = planCliRoot({
    doneRequiredEvidence: {
      schema: 'proofOrStop.done-required-evidence',
      version: 1,
      storyId: PLAN_CLI_STORY_ID,
      status: 'pass',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:05:00.000Z',
      durationMs: 300000,
      policyHash: 'fixture',
      commandSetHash: 'fixture',
      reasons: [],
      receipts: [
        { label: 'unit', command: 'npm', args: ['test'], cwd: '.', status: 'pass', exitCode: 0, durationMs: 4000, outputDigest: 'x', outputTail: '', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:04.000Z' },
      ],
    },
  });
  const report = JSON.parse(planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', json: true })) as Record<string, any>;
  const unit = report.units.find((entry: any) => entry.id === 'unit-suite');
  const lint = report.units.find((entry: any) => entry.id === 'lint-suite');
  assert.equal(unit.duration.status, 'known');
  assert.equal(unit.duration.estimateMs, 4000);
  assert.match(unit.duration.basis, /prior signed validation receipt/);
  assert.equal(lint.duration.status, 'unknown-duration');
  assert.equal(
    Object.prototype.hasOwnProperty.call(lint.duration, 'estimateMs'),
    false,
    'an unknown duration carries no numeric field at all; a 0 would read as instant',
  );
  assert.equal(report.durationEstimate.knownCount, 1);
  assert.equal(report.durationEstimate.unknownCount, 1);
  assert.equal(report.durationEstimate.knownTotalMs, 4000);
});

// ---------------------------------------------------------------------------
// (35) REJECTIONS BY NAME — nothing silently defaults.
// ---------------------------------------------------------------------------
testCase('a missing storyId and an unknown tier are each rejected BY NAME, never defaulted', () => {
  const { ctx } = planCliRoot();
  const call = planCli(ctx);

  assert.throws(
    () => call({ tier: 'fast' } as never),
    /validation_plan: storyId is required/,
    'a missing storyId must be rejected naming storyId',
  );
  assert.throws(() => call({ storyId: '   ', tier: 'fast' }), /storyId is required/);
  assert.throws(
    () => call({ storyId: PLAN_CLI_STORY_ID } as never),
    /validation_plan: tier is required/,
    'an omitted tier must be rejected, never silently defaulted to fast',
  );
  assert.throws(
    () => call({ storyId: PLAN_CLI_STORY_ID, tier: 'quick' }),
    /unknown tier "quick"/,
    'an unknown tier must be rejected naming the value that was passed',
  );
  assert.throws(() => call({ storyId: PLAN_CLI_STORY_ID, tier: 'quick' }), /fast, intermediate, full/);
});

testCase('the catalog schema constrains storyId and tier as the first line of defence', () => {
  const tool = planCliTool();
  const schema = z.object(tool.schema);
  assert.equal(schema.safeParse({ storyId: PLAN_CLI_STORY_ID, tier: 'fast' }).success, true);
  assert.equal(schema.safeParse({ storyId: '', tier: 'fast' }).success, false, 'an empty storyId must fail the schema');
  assert.equal(schema.safeParse({ storyId: PLAN_CLI_STORY_ID, tier: '' }).success, false, 'an empty tier must fail the schema');
});

// ---------------------------------------------------------------------------
// (36) COMMAND POLICY — the row exists and classifies the command read-only.
// ---------------------------------------------------------------------------
testCase('validation_plan is classified readOnly / none / all phases in command-policy', () => {
  const policy = getCommandPolicy('validation_plan');
  assert.ok(policy, 'validation_plan must have a CommandPolicy row');
  assert.equal(policy!.ownershipClass, 'readOnly');
  assert.equal(policy!.destructiveRisk, 'none');
  assert.equal(policy!.allowedPhases, 'all');
  assert.match(policy!.reason, /executes no validation command/);
  assert.match(policy!.reason, /writes nothing/);
});

// ---------------------------------------------------------------------------
// (37) THE LOAD-BEARING ONE — the command is read-only BY MEASUREMENT.
//      Every byte under the project root is snapshotted before and after, so
//      adding ANY store write to the handler fails this case. And no
//      write/persist/execute/run-shaped flag is accepted, at either layer.
// ---------------------------------------------------------------------------
testCase('invoking validation_plan leaves every byte under the project root identical', () => {
  const { root, store, ctx } = planCliRoot({
    items: [
      checklistItem({
        id: 'CHK-001',
        files: { modify: ['src/core/foo.ts'], create: [], test: ['tests/foo.test.ts'] },
        verificationEvidence: [
          { intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'npm test', result: 'pass', note: 'fixture evidence' },
        ],
      }),
    ],
  });
  const before = treeBytes(root);
  const beforeStory = JSON.stringify(store.readStory(PLAN_CLI_STORY_ID));
  const beforeChecklist = JSON.stringify(store.readChecklist(PLAN_CLI_STORY_ID));

  // Two independent proofs: no store write at all, and no byte changed anywhere.
  const guardedCtx = { ...ctx, store: refuseWritesStore(store) } as HandlerContext;
  for (const tier of ['fast', 'intermediate', 'full']) {
    planCli(guardedCtx)({ storyId: PLAN_CLI_STORY_ID, tier, explain: true });
    planCli(guardedCtx)({ storyId: PLAN_CLI_STORY_ID, tier, json: true });
  }

  assert.deepEqual(treeBytes(root), before, 'validation_plan wrote to the project root; it is contractually read-only');
  assert.equal(JSON.stringify(store.readStory(PLAN_CLI_STORY_ID)), beforeStory, 'the story record must be byte-identical');
  assert.equal(JSON.stringify(store.readChecklist(PLAN_CLI_STORY_ID)), beforeChecklist, 'the checklist must be byte-identical');
});

testCase('no write / persist / execute / run flag is accepted, at the schema OR the handler', () => {
  const tool = planCliTool();
  const schema = z.object(tool.schema);
  const { ctx } = planCliRoot();
  const call = planCli(ctx);

  for (const flag of ['write', 'persist', 'execute', 'run', 'launch', 'apply', 'capture', 'refresh', 'runCommands', 'writeEvidence', 'advancePhase']) {
    assert.equal(
      schema.safeParse({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', [flag]: true }).success,
      false,
      `the catalog schema must reject --${flag}`,
    );
    // Handler encoding convention: the schema is only the FIRST line of defence.
    assert.throws(
      () => call({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', [flag]: true } as never),
      new RegExp(flag),
      `the handler must refuse ${flag} even when the schema is bypassed`,
    );
  }
});

// ---------------------------------------------------------------------------
// (38) HANDLER ENCODING CONVENTION — the zod bypass is still rejected, at BOTH
//      the handler entry and the planner-core entry.
// ---------------------------------------------------------------------------
testCase('a schema-bypassing invalid tier and empty storyId are rejected at handler AND core entry', () => {
  // Handler entry, called directly with no schema in the path at all.
  assert.throws(() => resolveValidationPlanRequest({ storyId: '', tier: 'fast' }), /storyId is required/);
  assert.throws(() => resolveValidationPlanRequest({ storyId: PLAN_CLI_STORY_ID, tier: 'story-quick' }), /unknown tier "story-quick"/);
  assert.throws(() => resolveValidationPlanRequest({ storyId: 7 as never, tier: 'fast' }), /storyId/);
  assert.throws(() => resolveValidationPlanRequest({ storyId: PLAN_CLI_STORY_ID, tier: 3 as never }), /tier/);
  assert.deepEqual(
    resolveValidationPlanRequest({ storyId: ` ${PLAN_CLI_STORY_ID} `, tier: 'full', explain: true }),
    { storyId: PLAN_CLI_STORY_ID, tierInput: 'full', requestedTier: 'repository-full', explain: true, json: false },
  );

  // Planner core entry, reached with no handler and no schema in the path.
  assert.throws(
    () => resolveValidationTierPlan({ input: planInput(), requestedTier: 'fast' as ValidationTier }),
    /unknown tier "fast"/,
    'the CLI alias is NOT the core vocabulary; the core must still reject it by name',
  );
  assert.throws(
    () => resolveValidationTierPlan({ input: { ...planInput(), storyId: '' }, requestedTier: 'story-fast' }),
    /storyId/,
    'an empty storyId must be rejected at the planner-core entry too',
  );
});

testCase('the CLI tier aliases map onto the canonical vocabulary and add no fourth tier', () => {
  assert.deepEqual(
    VALIDATION_PLAN_TIER_ALIASES,
    {
      fast: 'story-fast',
      intermediate: 'story-intermediate',
      full: 'repository-full',
      'story-fast': 'story-fast',
      'story-intermediate': 'story-intermediate',
      'repository-full': 'repository-full',
    },
  );
  const targets = new Set(Object.values(VALIDATION_PLAN_TIER_ALIASES));
  assert.deepEqual([...targets].sort(), [...VALIDATION_TIERS].sort());
});

// ---------------------------------------------------------------------------
// F-010 (cross-host review, Codex) — the planner must read Git state from the
// STORY's tree, never from the tree it happens to be invoked in.
//
// validation_plan is read-only and allowed from any cwd, so invoking it from the
// main checkout (or from a configured wrapper root) against a story whose work
// lives in a linked worktree is a supported call. Before the fix the handler
// passed the invocation root as gitCwd, so that call diffed and hashed the WRONG
// tree while still naming the story: 0 unclassified inputs from main, N from the
// worktree, and two different selectionDigests for one story. The fixtures below
// reproduce exactly that layout and require the two reports to be identical.
// No cwd gate is added: the command must simply look at the right tree.
// ---------------------------------------------------------------------------

const GIT_FIXTURE_IDENTITY = ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proof-or-Stop Smoke'];
const WORKTREE_FIXTURE_STORY_ID = 'B-a745';
const WORKTREE_FIXTURE_CHANGED_FILE = 'src/core/planner-touched.ts';
const WORKTREE_FIXTURE_STORY_COMMAND_ID = 'planner-suite';

function fixtureGit(cwd: string, args: string[]): string {
  return execFileSync('git', [...GIT_FIXTURE_IDENTITY, ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeFixtureFile(root: string, relPath: string, content: string): void {
  const absolute = join(root, relPath);
  mkdirSync(resolve(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content, 'utf-8');
}

/**
 * A story that owns its work in a linked worktree, laid out the way the real
 * lifecycle lays it out:
 *
 *   metadataRoot/                       proof-or-stop.config.json (+ gitRoot on a wrapper layout)
 *     .proof-or-stop/story/actives/     the story metadata (NO worktree binding, like story_create)
 *     [repo/]                           the git root: branch main, one base commit
 *       .worktrees/<storyId>/           linked worktree on story/<storyId> with the story's own commit
 *
 * On the plain layout metadataRoot IS the git root and the metadata is committed
 * on main, so the worktree carries it too. On the wrapper layout the metadata
 * root is deliberately NOT a git repository and `gitRoot: "repo"` points at the
 * inner repository, which is the configured wrapper-root case resolveGitCwd
 * already serves for the sibling handlers.
 */
function buildStoryWorktreeFixture(layout: 'plain' | 'wrapper-root'): {
  metadataRoot: string;
  gitRoot: string;
  worktreePath: string;
} {
  const metadataRoot = mkdtempSync(join(tmpdir(), `proof-or-stop-validation-plan-${layout}-`));
  temporaryRoots.push(metadataRoot);
  const gitRoot = layout === 'wrapper-root' ? join(metadataRoot, 'repo') : metadataRoot;
  mkdirSync(gitRoot, { recursive: true });

  const configJson = (extraCommands: unknown[]): string =>
    `${JSON.stringify({
      storyDir: '.proof-or-stop/story/actives',
      ...(layout === 'wrapper-root' ? { gitRoot: 'repo' } : {}),
      validate: {
        commands: [
          { label: 'unit', command: 'npm', args: ['test'], id: 'unit-suite' },
          { label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'lint-suite' },
          ...extraCommands,
        ],
      },
    }, null, 2)}\n`;
  writeFixtureFile(metadataRoot, 'proof-or-stop.config.json', configJson([]));
  writeFixtureFile(gitRoot, '.gitignore', '.worktrees/\n');
  writeFixtureFile(gitRoot, 'README.md', '# validation_plan worktree fixture\n');
  writeFixtureFile(gitRoot, WORKTREE_FIXTURE_CHANGED_FILE, 'export const touched = 0;\n');
  fixtureGit(gitRoot, ['init', '-q']);
  fixtureGit(gitRoot, ['checkout', '-q', '-B', 'main']);
  fixtureGit(gitRoot, ['add', '-A']);
  fixtureGit(gitRoot, ['commit', '-q', '-m', 'base']);

  resetConfigCache();
  const store = new StoryStore(metadataRoot);
  store.writeStory(WORKTREE_FIXTURE_STORY_ID, {
    storyId: WORKTREE_FIXTURE_STORY_ID,
    name: 'validation-plan-worktree',
    title: 'Planner reads the story tree',
    description: 'Fixture story whose work lives in a linked worktree.',
    type: 'feature',
    phase: 'DEV' as StoryInfo['phase'],
    priority: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    // NO worktree binding: the resolver must find the linked story branch itself.
  });
  store.writeChecklist(WORKTREE_FIXTURE_STORY_ID, { items: [] });
  if (layout === 'plain') {
    fixtureGit(gitRoot, ['add', '-A']);
    fixtureGit(gitRoot, ['commit', '-q', '-m', 'story metadata']);
  }

  const worktreePath = join(gitRoot, '.worktrees', WORKTREE_FIXTURE_STORY_ID);
  fixtureGit(gitRoot, ['branch', `story/${WORKTREE_FIXTURE_STORY_ID}`]);
  fixtureGit(gitRoot, ['worktree', 'add', '-q', worktreePath, `story/${WORKTREE_FIXTURE_STORY_ID}`]);
  // The story's OWN change, committed on the story branch only: main never sees it.
  writeFixtureFile(worktreePath, WORKTREE_FIXTURE_CHANGED_FILE, 'export const touched = 1;\n');
  if (layout === 'plain') {
    // The story's metadata AND its command inventory evolve on the story branch
    // too: the story registers a new validate.commands entry and pins evidence
    // to it, while main's committed copies are the stale INIT snapshot. This is
    // exactly the residual the owner reproduction showed once git state matched:
    // pins recorded in the worktree that main's checklist and inventory never had.
    writeFixtureFile(
      worktreePath,
      'proof-or-stop.config.json',
      configJson([{ label: 'planner', command: 'npm', args: ['run', 'planner'], id: WORKTREE_FIXTURE_STORY_COMMAND_ID }]),
    );
    resetConfigCache();
    new StoryStore(worktreePath).writeChecklist(WORKTREE_FIXTURE_STORY_ID, {
      items: [
        checklistItem({
          id: 'CHK-001',
          files: { modify: [WORKTREE_FIXTURE_CHANGED_FILE], create: [], test: [] },
          verificationEvidence: [
            { intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'npm run planner', result: 'pass', note: 'worktree-only pin' },
          ],
        }),
      ],
    });
  }
  fixtureGit(worktreePath, ['add', '-A']);
  fixtureGit(worktreePath, ['commit', '-q', '-m', 'story change']);

  return { metadataRoot, gitRoot, worktreePath };
}

function planFromRoot(root: string): Record<string, any> {
  resetConfigCache();
  const ctx = { store: new StoryStore(root), root, scanRoot: root } as HandlerContext;
  return JSON.parse(planCli(ctx)({ storyId: WORKTREE_FIXTURE_STORY_ID, tier: 'fast', json: true })) as Record<string, any>;
}

function unclassifiedValues(report: Record<string, any>): string[] {
  return (report.unclassifiedInputs as Array<{ value: string }>).map((entry) => entry.value).sort();
}

function escalationCodes(report: Record<string, any>): string[] {
  return (report.escalationReasons as Array<{ code: string }>).map((entry) => entry.code).sort();
}

testCase('F-010: validation_plan invoked from the main checkout plans the SAME tree as from the story worktree', () => {
  const { metadataRoot, worktreePath } = buildStoryWorktreeFixture('plain');

  const worktreeBytesBefore = treeBytes(worktreePath);
  const mainBytesBefore = treeBytes(metadataRoot);

  const fromWorktree = planFromRoot(worktreePath);
  const fromMainCheckout = planFromRoot(metadataRoot);

  // The fixture is only meaningful if the story really changed something that the
  // worktree view sees: the story-branch commit must surface as an input, and so
  // must the worktree-only evidence pin recorded in the story-branch checklist.
  assert.ok(
    unclassifiedValues(fromWorktree).includes(WORKTREE_FIXTURE_CHANGED_FILE),
    `the worktree view must see the story's own change (got ${JSON.stringify(unclassifiedValues(fromWorktree))})`,
  );
  assert.ok(
    (fromWorktree.units as Array<{ id: string }>).some((unit) => unit.id === WORKTREE_FIXTURE_STORY_COMMAND_ID),
    'the worktree view must select from the inventory the story branch registered',
  );
  assert.equal(
    escalationCodes(fromWorktree).includes('pinned_command_non_inventory'),
    false,
    'the worktree-only evidence pin must resolve against the story branch inventory',
  );
  assert.equal(fromWorktree.status, 'plan');

  // Reading the story's tree from the main checkout must stay read-only for BOTH trees.
  assert.deepEqual(treeBytes(worktreePath), worktreeBytesBefore, 'validation_plan wrote into the story worktree');
  assert.deepEqual(treeBytes(metadataRoot), mainBytesBefore, 'validation_plan wrote into the main checkout');

  // Same story, same dist, different cwd: the relevance input must be IDENTICAL.
  assert.deepEqual(
    unclassifiedValues(fromMainCheckout),
    unclassifiedValues(fromWorktree),
    'invoked from the main checkout, the planner must list the story worktree’s changed files, not main’s',
  );
  assert.deepEqual(escalationCodes(fromMainCheckout), escalationCodes(fromWorktree));
  assert.equal(
    fromMainCheckout.selectionDigest,
    fromWorktree.selectionDigest,
    'the selectionDigest must describe the requested story’s tree regardless of the invocation root',
  );
  assert.deepEqual(fromMainCheckout, fromWorktree, 'the whole report must be identical from both roots');
});

testCase('F-010: on a configured wrapper-root layout validation_plan reads the story worktree, not the non-git wrapper', () => {
  const { metadataRoot } = buildStoryWorktreeFixture('wrapper-root');

  // The only legitimate invocation root on this layout is the wrapper itself,
  // which is NOT a git repository. Before the fix the planner diffed and hashed
  // the wrapper and degraded to the unavailable classifications; it must instead
  // resolve the configured gitRoot's linked story worktree and read that tree.
  const fromWrapper = planFromRoot(metadataRoot);

  assert.equal(fromWrapper.status, 'plan');
  for (const code of ['changed_files_unavailable', 'hash_snapshot_unavailable']) {
    assert.equal(
      escalationCodes(fromWrapper).includes(code),
      false,
      `the wrapper root is not a git repository, but the story's tree is: ${code} must not be reported`,
    );
  }
  assert.ok(
    unclassifiedValues(fromWrapper).includes(WORKTREE_FIXTURE_CHANGED_FILE),
    `the story-branch change must be visible from the wrapper root (got ${JSON.stringify(unclassifiedValues(fromWrapper))})`,
  );
});

// ---------------------------------------------------------------------------
// B-a745 F-022 (Codex cross-host review round 3) — AN INCOMPLETE HASH SNAPSHOT
// IS NOT AN AVAILABLE ONE.
//
// `captureEvidenceHashSnapshot` never throws for a git or hash failure: it
// OMITS `headHash` / `materialHash` / `storyFilesHash` and returns the rest. The
// collector used to mark every RETURNED snapshot `available` and classified only
// the thrown path, so a non-git directory, an unborn repository (git init, zero
// commits) or a failed hash read produced an "available" snapshot whose three
// bindings were null, no `hash_snapshot_unavailable` escalation, and a plan that
// never disclosed it had bound nothing. The Story's honesty property is that a
// plan either binds freshness or SAYS it could not; these cases hold every layer
// to it: the collector classifies, the planner escalates and re-validates, and
// the CLI report carries the binding and refuses a plan that claims one it does
// not have.
// ---------------------------------------------------------------------------

beginSection('B-a745 F-022 incomplete hash snapshot cases');

type EvidenceDigestName = 'headHash' | 'materialHash' | 'storyFilesHash';
const EVIDENCE_DIGEST_NAMES: EvidenceDigestName[] = ['headHash', 'materialHash', 'storyFilesHash'];

/** The canonical reader's real failure shape: the digest keys are OMITTED, never null. */
function snapshotWithout(missing: EvidenceDigestName[]): (args: { ref?: string }) => EvidenceHashSnapshot {
  return (args) => {
    const snapshot: Record<string, unknown> = { ...FIXTURE_HEAD_SNAPSHOT, ref: args.ref ?? 'HEAD' };
    for (const name of missing) delete snapshot[name];
    return snapshot as unknown as EvidenceHashSnapshot;
  };
}

function hashEscalationDetail(input: StoryRelevanceInput): string {
  const escalation = input.escalations.find((entry) => entry.code === 'hash_snapshot_unavailable');
  assert.ok(escalation, 'an incomplete snapshot must escalate as hash_snapshot_unavailable');
  const detail = escalation!.detail;
  assert.equal(detail.includes('\n'), false, `the detail must be ONE line, got:\n${detail}`);
  assert.ok(detail.length <= 300, `the detail must be bounded, got ${detail.length} characters`);
  return detail;
}

for (const missing of [['headHash'], ['materialHash'], ['storyFilesHash'], EVIDENCE_DIGEST_NAMES] as EvidenceDigestName[][]) {
  testCase(`F-022: a returned snapshot missing ${missing.join(' + ')} is hash_snapshot_unavailable and the detail names it`, () => {
    const input = collect({ readers: { changedFileStatuses: statusReader({}), hashSnapshot: snapshotWithout(missing) } });
    assert.equal(
      input.hashes.status,
      'hash_snapshot_unavailable',
      `a snapshot without ${missing.join(', ')} binds nothing and must not be labelled available`,
    );
    assert.ok(
      input.escalations.some((entry) => entry.code === 'hash_snapshot_unavailable'),
      'the missing binding must be a classified escalation, not a silent null',
    );
    const detail = hashEscalationDetail(input);
    for (const name of EVIDENCE_DIGEST_NAMES) {
      assert.equal(
        detail.includes(name),
        missing.includes(name),
        `the detail must name exactly the missing digest(s) ${missing.join(', ')}; got: ${detail}`,
      );
    }
    // The thrown path is unchanged and still distinguishable: it carries the raw error.
    assert.ok(input.hashes.status === 'hash_snapshot_unavailable' && typeof input.hashes.error === 'string');
  });
}

testCase('F-022: the thrown-reader path is still classified exactly as before', () => {
  const input = collect({
    readers: {
      changedFileStatuses: statusReader({}),
      hashSnapshot: () => {
        throw new Error('fatal: not a git repository');
      },
    },
  });
  assert.equal(input.hashes.status, 'hash_snapshot_unavailable');
  assert.match(hashEscalationDetail(input), /not a git repository/i);
});

testCase('F-022: a complete snapshot stays available with no hash escalation (no over-classification)', () => {
  const input = collect();
  assert.equal(input.hashes.status, 'available');
  assert.equal(input.escalations.some((entry) => entry.code === 'hash_snapshot_unavailable'), false);
});

testCase('F-022: the planner escalates an incomplete snapshot with a glossed hash_snapshot_unavailable reason', () => {
  assert.ok(
    Object.prototype.hasOwnProperty.call(VALIDATION_WIDENING_REASONS, 'hash_snapshot_unavailable'),
    'hash_snapshot_unavailable must be a row of the widening matrix so it is rendered with a gloss',
  );
  const result = planFor('story-fast', {
    readers: { changedFileStatuses: statusReader({}), hashSnapshot: snapshotWithout(EVIDENCE_DIGEST_NAMES) },
  });
  assert.ok(
    reasonCodes(result).includes('hash_snapshot_unavailable'),
    `the plan must disclose the missing binding as an escalation, got ${reasonCodes(result).join(', ')}`,
  );
  const reason = result.escalationReasons.find((entry) => entry.code === 'hash_snapshot_unavailable')!;
  assert.equal(reason.detail.includes('\n'), false, 'the planner detail must be one line');
  assert.match(reason.detail, /headHash/);
  assert.equal(reason.gloss, validationWideningReasonGloss('hash_snapshot_unavailable'));
});

testCase('F-022: the planner refuses a schema-bypassing "available" snapshot that carries a null binding', () => {
  for (const missing of EVIDENCE_DIGEST_NAMES) {
    const head: Record<string, unknown> = { ...FIXTURE_HEAD_SNAPSHOT };
    delete head[missing];
    const input = { ...planInput(), hashes: { status: 'available', head } } as unknown as StoryRelevanceInput;
    assert.throws(
      () => resolveValidationTierPlan({ input, requestedTier: 'story-fast' }),
      new RegExp(missing),
      `an available snapshot without ${missing} must be rejected at the planner entry, naming ${missing}`,
    );
  }
});

testCase('F-022: the CLI report carries the freshness binding and discloses an unbound one', () => {
  // planCliRoot is deliberately NOT a git repository: the REAL reader returns a snapshot with no digests.
  const { ctx } = planCliRoot();
  const report = JSON.parse(planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', json: true })) as Record<string, any>;
  assert.equal(report.freshnessBinding?.status, 'unbound', `the report must state it bound nothing, got ${JSON.stringify(report.freshnessBinding)}`);
  assert.ok(escalationCodes(report).includes('hash_snapshot_unavailable'), 'the unbound binding must be an escalation in the report');
  const text = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', explain: true });
  assert.match(text, /^freshnessBinding: unbound/m);
  assert.ok(text.includes('[hash_snapshot_unavailable]'), 'the escalation code must be printed');
  assert.ok(text.includes(validationWideningReasonGloss('hash_snapshot_unavailable').slice(0, 60)), 'printed with its gloss');
  assert.match(text, /headHash, materialHash, storyFilesHash/, 'the detail must name every missing digest');
});

testCase('F-022: the render invariant refuses status: plan with a null head / material / storyFiles binding', () => {
  const { ctx } = planCliRoot();
  const report = JSON.parse(planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', json: true })) as Record<string, any>;
  assert.equal(report.status, 'plan');
  const bound = {
    headHash: 'head0000000000000000000000000000000000000',
    materialHash: 'material00000000000000000000000000000000',
    storyFilesHash: 'storyfiles000000000000000000000000000000',
  };
  // A genuinely bound plan renders.
  assert.doesNotThrow(() => assertValidationPlanStatusInvariant({ ...report, freshnessBinding: { status: 'bound', ...bound } } as never));
  // A "bound" binding with any digest null is refused, naming the digest.
  for (const missing of EVIDENCE_DIGEST_NAMES) {
    assert.throws(
      () => assertValidationPlanStatusInvariant({ ...report, freshnessBinding: { status: 'bound', ...bound, [missing]: null } } as never),
      new RegExp(missing),
      `status: plan with a null ${missing} binding must not render`,
    );
  }
  // An unbound plan renders ONLY when it discloses the escalation.
  const withoutEscalation = {
    ...report,
    freshnessBinding: { status: 'unbound', summary: 'fixture' },
    escalationReasons: report.escalationReasons.filter((entry: { code: string }) => entry.code !== 'hash_snapshot_unavailable'),
  };
  assert.throws(() => assertValidationPlanStatusInvariant(withoutEscalation as never), /hash_snapshot_unavailable/);
  // A report with no binding at all is not a plan either.
  const { freshnessBinding: _dropped, ...withoutBinding } = report;
  assert.throws(() => assertValidationPlanStatusInvariant(withoutBinding as never), /freshnessBinding/);
});

testCase('F-022: the REAL reader on an unborn repository (git init, zero commits) never yields a plan with null bindings', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-unborn-repo-'));
  temporaryRoots.push(root);
  writeFixtureFile(root, 'proof-or-stop.config.json', `${JSON.stringify({
    storyDir: '.proof-or-stop/story/actives',
    validate: { commands: [{ label: 'unit', command: 'npm', args: ['test'], id: 'unit-suite' }] },
  }, null, 2)}\n`);
  fixtureGit(root, ['init', '-q']);
  assert.equal(gitOutputIn(root, ['rev-parse', '--verify', 'HEAD']), null, 'the fixture must be an UNBORN repository: HEAD resolves to nothing');

  // The canonical reader really does return a snapshot with every digest omitted here.
  const snapshot = captureEvidenceHashSnapshot({ gitCwd: root, metadataRoot: root, ref: 'HEAD' });
  for (const name of EVIDENCE_DIGEST_NAMES) {
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, name), false, `the unborn repository must yield no ${name}`);
  }

  resetConfigCache();
  const store = new StoryStore(root);
  store.writeStory(PLAN_CLI_STORY_ID, {
    storyId: PLAN_CLI_STORY_ID,
    name: 'unborn-repository',
    title: 'Planner on an unborn repository',
    description: 'Fixture story in a repository with zero commits.',
    type: 'feature',
    phase: 'DEV' as StoryInfo['phase'],
    priority: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
  });
  store.writeChecklist(PLAN_CLI_STORY_ID, { items: [] });
  const ctx = { store, root, scanRoot: root } as HandlerContext;

  const report = JSON.parse(planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', json: true })) as Record<string, any>;
  const text = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast' });
  assert.ok(
    escalationCodes(report).includes('hash_snapshot_unavailable'),
    `an unborn repository binds no freshness and must say so; escalations were ${escalationCodes(report).join(', ')} and the render was:\n${text}`,
  );
  assert.notEqual(report.freshnessBinding?.status, 'bound', 'nothing was bound, so the report may not claim a binding');
  if (report.status === 'plan') {
    assert.equal(report.freshnessBinding?.status, 'unbound', 'a plan on an unborn repository must disclose an unbound freshness binding');
    assert.match(text, /^freshnessBinding: unbound/m);
  }
  assert.match(text, /headHash, materialHash, storyFilesHash/, 'the rendered detail must name every missing digest');
});

function gitOutputIn(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CHK-006 — cross-cutting acceptance guards. These do not test one item; they
// hold the Story's PROCESS and COVERAGE claims to a mechanical standard, so a
// later change cannot quietly retire one of them.
//
//  (39) RED-BEFORE-GREEN ORDERING — for every checklist item this suite declares
//       a section for, a failing-fixture commit must PRECEDE the implementing
//       commit in git history. The item list is DERIVED from the suite's own
//       section headers, so adding a seventh item without its RED commit fails
//       here instead of passing vacuously on a hardcoded count.
//  (40) ZOD-BYPASS REJECTION — every new handler field carrying a zod
//       min/max/enum constraint is DISCOVERED by probing the catalog schema, and
//       each discovered field must be refused at the handler entry AND at every
//       consuming core entry when the schema is bypassed entirely. A new
//       constrained field with no bypass coverage fails closed.
//  (41) DONEWHEN COVERAGE — every DoneWhen line of CHK-001..CHK-005 is mapped to
//       the fixture case(s) that prove it, and each cited case must have actually
//       run and passed in this process.
// ---------------------------------------------------------------------------

beginSection('CHK-006 cross-cutting acceptance guards', { perCase: true });

function gitOutput(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Checklist items DERIVED from this suite's own section headers, never a hardcoded count. */
function declaredChecklistItems(repoRoot: string): string[] {
  const source = readFileSync(join(repoRoot, 'packages/main/src/tasks/validation-tier-planner-smoke.ts'), 'utf-8');
  const found = new Set<string>();
  for (const line of source.split('\n')) {
    const match = /^beginSection\('(CHK-\d{3})/.exec(line);
    if (match) found.add(match[1]!);
  }
  return [...found].sort();
}

testCase('a RED fixture commit precedes the implementing commit for every item this suite declares', () => {
  const repoRoot = (gitOutput(['rev-parse', '--show-toplevel']) ?? '').trim();
  assert.ok(repoRoot, 'this guard needs real git history; a missing repository is a failure, not a skip');

  const items = declaredChecklistItems(repoRoot);
  assert.ok(items.length > 0, 'the item list must be derived from the suite sections, and it must not be empty');

  // Prefer the Story branch range; once merged the same commits are reachable from
  // history, so fall back to a subject-filtered whole-history scan rather than
  // passing vacuously on an empty range.
  const rangeSubjects = (gitOutput(['log', '--format=%s', 'main..HEAD']) ?? '').split('\n').filter(Boolean);
  // A later story's branch legitimately reuses CHK-nnn ids for ITS items, so
  // the range is used only while it carries a GREEN for every item declared here.
  const rangeCoversDeclared = items.every((item) => rangeSubjects.some((subject) => subject.startsWith(`GREEN(${item}):`)));
  const subjects = rangeCoversDeclared
    ? rangeSubjects
    : (gitOutput(['log', '-E', '--format=%s', '--grep=^(RED|GREEN)\\(CHK-[0-9]{3}\\):']) ?? '').split('\n').filter(Boolean);
  assert.ok(subjects.length > 0, 'no RED/GREEN commit subjects were readable; the ordering claim cannot be proven');

  // git log is newest first; read oldest first so "precedes" means what it says.
  const chronological = [...subjects].reverse();
  for (const item of items) {
    const firstRed = chronological.findIndex((subject) => subject.startsWith(`RED(${item}):`));
    const firstGreen = chronological.findIndex((subject) => subject.startsWith(`GREEN(${item}):`));
    assert.notEqual(firstGreen, -1, `${item} has no GREEN commit; the suite declares a section for it`);
    assert.notEqual(firstRed, -1, `${item} has no RED commit; a failing fixture must exist before the implementation`);
    assert.ok(
      firstRed < firstGreen,
      `${item}: the RED fixture commit must PRECEDE the implementing commit (red@${firstRed}, green@${firstGreen}); squashing them is what this guard forbids`,
    );
  }
});

// ---------------------------------------------------------------------------
// (44) RED-BEFORE-GREEN FOR FINDING FIXES (B-dc2e CHK-003, load-bearing) — the
//      guard above derives CHK ids from this suite's section headers, so a
//      `GREEN(F-nnn):` finding-fix commit with its RED squashed away was never
//      inspected (B-a745 F-012). The ordering rule now lives in the PURE helper
//      `core/red-green-commit-guard.ts` (no git I/O) over an oldest-first list of
//      {subject, body}; this smoke does the git reading and feeds it. A GREEN
//      with no RED is accepted only when its body carries the documented marker
//      line `No-RED: <reason>` with a reason of at least 30 characters, so a
//      comment-only or registration-only fix states WHY no fixture could fail.
//      A RED that sits on main before the branch point (excluded from the range)
//      satisfies a branch GREEN only when BOTH are story-qualified with the
//      same id, `RED(B-xxxx:F-nnn)` / `GREEN(B-xxxx:F-nnn)` (F-006 + F-008).
// ---------------------------------------------------------------------------

/** Oldest-first {subject, body} pairs for a git log argument list; git I/O stays here, never in the helper. */
function readRedGreenCommits(cwd: string | null, logArgs: string[]): Array<{ subject: string; body: string }> {
  const args = ['log', '--reverse', '--format=%s%x00%b%x1e', ...logArgs];
  const raw = (cwd ? gitOutputIn(cwd, args) : gitOutput(args)) ?? '';
  return raw.split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [subject = '', body = ''] = record.split('\x00');
      return { subject: subject.trim(), body };
    });
}

const NO_RED_REASON = 'comment-only wording fix with no behaviour change, no fixture can fail';

testCase('guard fixtures: GREEN without RED, squashed pair, bare marker fail; reasoned marker passes', () => {
  // (a) a GREEN(F-nnn) with no RED anywhere before it.
  const bare = evaluateRedGreenCommitOrder([
    { subject: 'RED(CHK-001): a fixture fails', body: '' },
    { subject: 'GREEN(CHK-001): the fix', body: '' },
    { subject: 'GREEN(F-004): reword a gloss', body: '' },
  ]);
  assert.equal(bare.ok, false, 'a GREEN(F-nnn) with no preceding RED must fail');
  assert.deepEqual(bare.violatingIds, ['F-004']);
  assert.match(describeRedGreenViolations(bare), /F-004/);

  // (b) the RED squashed into the GREEN: only the GREEN subject survives and the
  //     old RED subject is just a body line, which must NOT count as a RED.
  const squashed = evaluateRedGreenCommitOrder([
    { subject: 'GREEN(F-007): the fix', body: 'RED(F-007): the fixture fails before the fix\n\nsquashed\n' },
  ]);
  assert.equal(squashed.ok, false, 'a body line that looks like a RED subject is not a RED commit');
  assert.deepEqual(squashed.violatingIds, ['F-007']);

  // (c) the marker without a reason, and with a reason that is too short.
  const bareMarker = evaluateRedGreenCommitOrder([
    { subject: 'GREEN(F-011): fix a stale comment', body: 'No-RED:\n' },
  ]);
  assert.equal(bareMarker.ok, false, 'No-RED without a reason must fail');
  assert.deepEqual(bareMarker.violatingIds, ['F-011']);
  const shortMarker = evaluateRedGreenCommitOrder([
    { subject: 'GREEN(F-011): fix a stale comment', body: 'No-RED: comment only\n' },
  ]);
  assert.equal(shortMarker.ok, false, 'a No-RED reason shorter than 30 characters must fail');
  assert.deepEqual(shortMarker.violatingIds, ['F-011']);

  // (d) the marker with a real reason, on a GREEN that has no RED.
  const reasoned = evaluateRedGreenCommitOrder([
    { subject: 'GREEN(F-011): fix a stale comment', body: `Reword the comment.\n\nNo-RED: ${NO_RED_REASON}\n` },
  ]);
  assert.equal(reasoned.ok, true, `a reasoned No-RED marker must pass: ${describeRedGreenViolations(reasoned)}`);
  assert.deepEqual(reasoned.violatingIds, []);

  // A RED earlier in history but not adjacent still satisfies a later GREEN.
  const distant = evaluateRedGreenCommitOrder([
    { subject: 'RED(F-009): the fixture fails', body: '' },
    { subject: 'RED(CHK-002): another fixture', body: '' },
    { subject: 'GREEN(CHK-002): another fix', body: '' },
    { subject: 'GREEN(F-009): the fix', body: '' },
  ]);
  assert.equal(distant.ok, true, describeRedGreenViolations(distant));
  assert.equal(parseRedGreenSubject('chore: unrelated'), null, 'a non RED/GREEN subject is ignored');
});

testCase('a temp repository with RED(F-007) squashed into its GREEN fails naming F-007', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-red-green-squash-'));
  temporaryRoots.push(root);
  writeFixtureFile(root, 'README.md', '# red-green squash fixture\n');
  fixtureGit(root, ['init', '-q']);
  fixtureGit(root, ['checkout', '-q', '-B', 'main']);
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '-m', 'base']);
  fixtureGit(root, ['checkout', '-q', '-b', 'story/B-fixture']);
  writeFixtureFile(root, 'fixture.test.txt', 'expect: fails\n');
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '-m', 'RED(F-007): the fixture fails before the fix']);
  writeFixtureFile(root, 'fix.txt', 'fixed\n');
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '-m', 'GREEN(F-007): the fix']);

  // Before the squash the pair is ordered and the guard passes.
  const ordered = evaluateRedGreenCommitOrder(readRedGreenCommits(root, ['main..HEAD']));
  assert.equal(ordered.ok, true, `ordered RED then GREEN must pass: ${describeRedGreenViolations(ordered)}`);

  // Squash: one commit survives under the GREEN subject, the RED subject is a body line.
  fixtureGit(root, ['reset', '-q', '--soft', 'main']);
  fixtureGit(root, ['commit', '-q', '-m', 'GREEN(F-007): the fix', '-m', 'RED(F-007): the fixture fails before the fix\n\nsquashed']);
  const commits = readRedGreenCommits(root, ['main..HEAD']);
  assert.equal(commits.length, 1, 'the squash must leave exactly one commit on the story branch');
  const result = evaluateRedGreenCommitOrder(commits);
  assert.equal(result.ok, false, 'the squashed pair must fail the guard');
  assert.deepEqual(result.violatingIds, ['F-007']);
  assert.match(describeRedGreenViolations(result), /F-007/, 'the failure text must name the finding id');
});

/**
 * B-dc2e F-006: ids with a RED subject BEFORE the branch point, i.e. reachable
 * from the merge-base of main and HEAD. `main..HEAD` excludes those commits, so
 * a GREEN on the branch whose RED already sits on main must not be a false
 * green_without_red. Git I/O stays here; the helper receives a plain set.
 *
 * STORY-QUALIFIED ONLY (B-dc2e F-008): only `RED(B-xxxx:CHK-nnn):` and
 * `RED(B-xxxx:F-nnn):` subjects are collected, stored as the qualified id. Ids
 * restart at CHK-001 / F-001 in every story, so a bare RED(CHK-001) reachable
 * from the merge-base belongs to whichever merged story wrote it, and
 * `git merge main` (required before DONE) moves the merge-base and would flip a
 * bare GREEN's verdict. A bare GREEN with no RED in range therefore still fails
 * unless it carries the reasoned No-RED marker; the helper enforces the same
 * qualified-only rule on its side, so a bare id could not slip through here.
 */
function priorRedIds(cwd: string | null): ReadonlySet<string> {
  // F-007: both calls are STRICT. The old `gitOutput` bare catch turned a git failure
  // (ENOBUFS on this repository's ~1.39 MB subject history, a missing `main`, a
  // directory that is no repository) into null and therefore an EMPTY prior set,
  // which the guard could not tell from "no RED before the branch point".
  const base = gitOutputStrict(cwd, ['merge-base', 'main', 'HEAD']).trim();
  // Only the qualified RED subjects are asked for, and the read is bounded far above
  // the default 1 MB maxBuffer so history growth cannot overflow it.
  const subjects = gitOutputStrict(cwd, ['log', '--format=%s', '-E', `--grep=${PRIOR_RED_SUBJECT_GREP}`, base]);
  const ids = new Set<string>();
  for (const subject of subjects.split('\n')) {
    const parsed = parseRedGreenSubject(subject.trim());
    if (parsed?.phase === 'RED' && isStoryQualifiedRedGreenId(parsed.id)) ids.add(parsed.id);
  }
  return ids;
}

/** Extended-regex `git log --grep` for story-qualified RED subjects; the collector asks git for only these. */
const PRIOR_RED_SUBJECT_GREP = '^RED\\(B-[0-9a-f]{4}:(CHK|F)-[0-9]{3}\\):';
/** Explicit stdout bound for the prior-RED reads: the default is 1 MB and this repository already exceeds it (F-007). */
const PRIOR_RED_GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Git read that RAISES on failure (non-zero exit, spawn error, ENOBUFS) with the
 * git stderr in the message, so a failed read is never mistaken for an empty
 * result. `gitOutput` / `gitOutputIn` keep their null-on-failure contract for
 * callers that treat absence as a legitimate answer.
 */
function gitOutputStrict(cwd: string | null, args: string[]): string {
  try {
    return execFileSync('git', args, {
      ...(cwd ? { cwd } : {}),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: PRIOR_RED_GIT_MAX_BUFFER,
    });
  } catch (error) {
    const failure = error as { code?: unknown; status?: unknown; stderr?: unknown; message?: unknown };
    const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : '';
    const code = failure.code ?? failure.status ?? 'unknown';
    throw new Error(
      `git ${args.join(' ')} failed${cwd ? ` in ${cwd}` : ''} (code ${String(code)}): `
      + `${stderr || (typeof failure.message === 'string' ? failure.message : String(error))}`,
    );
  }
}

/** The branch range `main..HEAD` through the helper, with the branch point's RED ids, as the smoke's own guard consumes it. */
function evaluateBranchRedGreen(cwd: string | null) {
  return evaluateRedGreenCommitOrder(readRedGreenCommits(cwd, ['main..HEAD']), { priorRedIds: priorRedIds(cwd) });
}

testCase('prior-RED acceptance is story-qualified: GREEN(B-xxxx:id) with a prior RED(B-xxxx:id) passes; bare ids and other stories fail', () => {
  // The helper stays pure: the caller hands it the STORY-QUALIFIED ids that have a RED
  // subject in the branch point's history. Ids restart at CHK-001 / F-001 in every
  // story, so a bare id in the prior set would let an unrelated merged story's RED
  // satisfy this branch's GREEN (B-dc2e F-008): only an equal qualified id counts.
  const evaluate = evaluateRedGreenCommitOrder;
  const qualifiedPrior = new Set(['B-dc2e:CHK-001']);
  const inRange = [{ subject: 'GREEN(B-dc2e:CHK-001): the fix on the story branch', body: '' }];
  assert.equal(evaluate(inRange).ok, false, 'the range alone genuinely lacks the RED, so without the prior set it still fails');
  // (b) qualified GREEN with the SAME story's qualified RED before the range: accepted.
  const satisfied = evaluate(inRange, { priorRedIds: qualifiedPrior });
  assert.equal(satisfied.ok, true, `a GREEN whose qualified id has a RED before the branch point must pass: ${describeRedGreenViolations(satisfied)}`);
  assert.deepEqual(satisfied.violatingIds, []);
  assert.deepEqual(satisfied.priorRedAccepted, [{ index: 0, id: 'B-dc2e:CHK-001' }], 'the result names the GREEN satisfied by a RED before the range');
  assert.match(describeRedGreenViolations(satisfied), /1 satisfied by a RED before the range/);
  // (a) an UNQUALIFIED GREEN(CHK-001) is never satisfied by an unrelated bare RED(CHK-001) in the prior set.
  const bareCollision = evaluate([{ subject: 'GREEN(CHK-001): fabricated, never observed a failing CHK-001 fixture', body: '' }], { priorRedIds: new Set(['CHK-001']) });
  assert.equal(bareCollision.ok, false, 'a bare GREEN(CHK-001) must not be satisfied by any bare RED(CHK-001) before the range: ids restart per story');
  assert.deepEqual(bareCollision.violatingIds, ['CHK-001']);
  assert.deepEqual(bareCollision.priorRedAccepted, []);
  // (c) a qualified GREEN is not satisfied by ANOTHER story's qualified RED with the same item number.
  const otherStory = evaluate(inRange, { priorRedIds: new Set(['B-0ther:CHK-001', 'B-1234:CHK-001']) });
  assert.equal(otherStory.ok, false, 'GREEN(B-dc2e:CHK-001) must not be satisfied by RED(B-1234:CHK-001) from another story');
  assert.deepEqual(otherStory.violatingIds, ['B-dc2e:CHK-001']);
  // A bare GREEN is not rescued by a qualified RED of the same number either.
  const bareGreen = evaluate([{ subject: 'GREEN(CHK-001): bare', body: '' }], { priorRedIds: qualifiedPrior });
  assert.equal(bareGreen.ok, false, 'a bare GREEN(CHK-001) cannot borrow RED(B-dc2e:CHK-001) from the prior set');
  // An id with no RED anywhere is still a violation, prior set or not.
  const other = evaluate([{ subject: 'GREEN(B-dc2e:CHK-002): no RED anywhere', body: '' }], { priorRedIds: qualifiedPrior });
  assert.equal(other.ok, false, 'a GREEN whose id is not in the prior set and has no RED in range must still fail');
  assert.deepEqual(other.violatingIds, ['B-dc2e:CHK-002']);
  // The No-RED marker rule is unchanged: a bare marker fails even when a prior set is supplied.
  const bareMarker = evaluate([{ subject: 'GREEN(F-011): fix a stale comment', body: 'No-RED:\n' }], { priorRedIds: qualifiedPrior });
  assert.equal(bareMarker.ok, false, 'No-RED without a reason must still fail');
  assert.deepEqual(bareMarker.violatingIds, ['F-011']);
});

/** A temp repository on `main` with one base commit; returns its root (cleaned up with the other temporary roots). */
function redGreenFixtureRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  writeFixtureFile(root, 'README.md', '# red-green fixture\n');
  fixtureGit(root, ['init', '-q']);
  fixtureGit(root, ['checkout', '-q', '-B', 'main']);
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '-m', 'base']);
  return root;
}

function redGreenFixtureCommit(root: string, relPath: string, subject: string): void {
  writeFixtureFile(root, relPath, `${subject}\n`);
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '-m', subject]);
}

testCase('a temp repository with RED(B-dc2e:CHK-001) on main before the branch point accepts the branch GREEN(B-dc2e:CHK-001); a bare RED(CHK-001) there rescues nothing', () => {
  const root = redGreenFixtureRepo('proof-or-stop-red-green-prior-');
  // main carries the story's OWN qualified RED and an unrelated merged story's bare RED(CHK-001).
  redGreenFixtureCommit(root, 'fixture.test.txt', 'RED(B-dc2e:CHK-001): the fixture fails, committed on main');
  redGreenFixtureCommit(root, 'unrelated.test.txt', 'RED(CHK-001): an unrelated merged story fixture fails');
  redGreenFixtureCommit(root, 'unrelated-other.test.txt', 'RED(B-1234:CHK-002): another story fixture fails');
  fixtureGit(root, ['checkout', '-q', '-b', 'story/B-dc2e']);
  redGreenFixtureCommit(root, 'fix.txt', 'GREEN(B-dc2e:CHK-001): the fix on the story branch');

  const rangeOnly = readRedGreenCommits(root, ['main..HEAD']);
  assert.deepEqual(rangeOnly.map((commit) => commit.subject), ['GREEN(B-dc2e:CHK-001): the fix on the story branch'], 'main..HEAD excludes the RED that sits on main');
  assert.deepEqual([...priorRedIds(root)].sort(), ['B-1234:CHK-002', 'B-dc2e:CHK-001'], 'the prior set carries only STORY-QUALIFIED RED ids; the bare RED(CHK-001) is not collected');
  const accepted = evaluateBranchRedGreen(root);
  assert.equal(accepted.ok, true, `the branch GREEN must be satisfied by the same story's RED before the branch point: ${describeRedGreenViolations(accepted)}`);
  assert.deepEqual(accepted.priorRedAccepted, [{ index: 0, id: 'B-dc2e:CHK-001' }]);

  // (a) a bare GREEN(CHK-001) on the branch is NOT satisfied by main's bare RED(CHK-001).
  redGreenFixtureCommit(root, 'bare.txt', 'GREEN(CHK-001): fabricated, never observed a failing CHK-001 fixture');
  const bare = evaluateBranchRedGreen(root);
  assert.equal(bare.ok, false, 'a bare GREEN(CHK-001) must fail even though an unrelated bare RED(CHK-001) is reachable from the merge-base');
  assert.deepEqual(bare.violatingIds, ['CHK-001']);
  // (c) a qualified GREEN is not satisfied by another story's RED of the same number.
  redGreenFixtureCommit(root, 'other-story.txt', 'GREEN(B-dc2e:CHK-002): borrows RED(B-1234:CHK-002)');
  const otherStory = evaluateBranchRedGreen(root);
  assert.equal(otherStory.ok, false, 'GREEN(B-dc2e:CHK-002) must not be satisfied by RED(B-1234:CHK-002)');
  assert.deepEqual(otherStory.violatingIds, ['CHK-001', 'B-dc2e:CHK-002']);
  // Control: a branch GREEN with no RED anywhere in history still fails, naming itself.
  redGreenFixtureCommit(root, 'other.txt', 'GREEN(B-dc2e:CHK-003): no RED anywhere');
  const control = evaluateBranchRedGreen(root);
  assert.equal(control.ok, false, 'a GREEN with no RED anywhere must still fail');
  assert.deepEqual(control.violatingIds, ['CHK-001', 'B-dc2e:CHK-002', 'B-dc2e:CHK-003']);
});

testCase('merge-base movement: a RED on main after the branch point satisfies the branch GREEN only after git merge main, and only when story-qualified', () => {
  // (d) `git merge main` is required before DONE, and it MOVES merge-base(main, HEAD).
  // A RED that lands on main after the branch point is invisible before the merge and
  // must not rescue a GREEN; after the merge it counts only for the same story.
  const root = redGreenFixtureRepo('proof-or-stop-red-green-merge-base-');
  fixtureGit(root, ['checkout', '-q', '-b', 'story/B-dc2e']);
  redGreenFixtureCommit(root, 'fix-1.txt', 'GREEN(B-dc2e:CHK-001): the fix, RED still only on main');
  redGreenFixtureCommit(root, 'fix-2.txt', 'GREEN(B-dc2e:F-001): the fix, another story RED on main');
  redGreenFixtureCommit(root, 'fix-3.txt', 'GREEN(CHK-002): bare fix, bare RED on main');
  fixtureGit(root, ['checkout', '-q', 'main']);
  redGreenFixtureCommit(root, 'main-red-1.txt', 'RED(B-dc2e:CHK-001): the fixture fails, landed on main after the branch point');
  redGreenFixtureCommit(root, 'main-red-2.txt', 'RED(B-1234:F-001): another story fixture fails');
  redGreenFixtureCommit(root, 'main-red-3.txt', 'RED(CHK-002): a bare fixture fails');
  fixtureGit(root, ['checkout', '-q', 'story/B-dc2e']);

  assert.deepEqual([...priorRedIds(root)], [], 'before the merge none of main\'s new REDs is reachable from the merge-base');
  const before = evaluateBranchRedGreen(root);
  assert.equal(before.ok, false, 'before git merge main every branch GREEN lacks its RED');
  assert.deepEqual(before.violatingIds, ['B-dc2e:CHK-001', 'B-dc2e:F-001', 'CHK-002']);

  fixtureGit(root, ['merge', '-q', '--no-edit', '--no-ff', 'main']);
  assert.deepEqual([...priorRedIds(root)].sort(), ['B-1234:F-001', 'B-dc2e:CHK-001'], 'after the merge only the qualified REDs are collected; the bare RED(CHK-002) is not');
  const after = evaluateBranchRedGreen(root);
  assert.equal(after.ok, false, 'after the merge only the same-story qualified GREEN is satisfied');
  assert.deepEqual(after.priorRedAccepted, [{ index: 0, id: 'B-dc2e:CHK-001' }], 'GREEN(B-dc2e:CHK-001) is satisfied by the same story\'s RED that the merge made reachable');
  assert.deepEqual(after.violatingIds, ['B-dc2e:F-001', 'CHK-002'], 'another story\'s RED(B-1234:F-001) and the bare RED(CHK-002) rescue nothing');
});

// B-dc2e F-007: priorRedIds() read the WHOLE subject history below the merge-base
// through execFileSync's default 1 MB maxBuffer; this repository's subjects are
// already ~1.39 MB, so the call threw ENOBUFS, the bare catch turned it into null,
// and the prior set was silently EMPTY in the very repository the F-006 fix ships
// in. The cases below pin: no throw and agreement with an independent bounded
// query on this real repository, a > 1 MB matching-subject history in a temp
// repository, and a LOUD failure (never an empty set) when git itself fails.

/** The independent query in the cases below spells the pattern out on purpose rather than importing the collector's constant. */
const QUALIFIED_RED_SUBJECT_GREP = '^RED\\(B-[0-9a-f]{4}:(CHK|F)-[0-9]{3}\\):';

testCase('priorRedIds on this real repository does not throw and matches an independent bounded git query', () => {
  const base = (gitOutput(['merge-base', 'main', 'HEAD']) ?? '').trim();
  assert.ok(base, 'this case needs a real merge-base between main and HEAD');
  const independent = execFileSync(
    'git',
    ['log', '--format=%s', '-E', `--grep=${QUALIFIED_RED_SUBJECT_GREP}`, base],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 },
  ).split('\n').map((line) => parseRedGreenSubject(line.trim())).filter((parsed) => parsed?.phase === 'RED').map((parsed) => parsed!.id);
  let collected: ReadonlySet<string> | null = null;
  assert.doesNotThrow(() => { collected = priorRedIds(null); }, 'priorRedIds must not throw on the real repository');
  assert.deepEqual([...collected!].sort(), [...new Set(independent)].sort(), 'the prior set must equal the qualified RED ids reachable from the merge-base, never a silently empty set');
});

testCase('priorRedIds reads a merge-base history whose matching subjects exceed 1 MB (the default execFileSync maxBuffer)', () => {
  const root = redGreenFixtureRepo('proof-or-stop-red-green-big-history-');
  const padding = 'x'.repeat(100_000);
  const expected: string[] = [];
  for (let index = 1; index <= 12; index += 1) {
    const id = `B-f0f7:F-${String(index).padStart(3, '0')}`;
    expected.push(id);
    writeFixtureFile(root, `fixture-${index}.txt`, `${id}\n`);
    writeFixtureFile(root, 'message.txt', `RED(${id}): ${padding}\n`);
    fixtureGit(root, ['add', 'fixture-' + index + '.txt']);
    fixtureGit(root, ['commit', '-q', '-F', 'message.txt']);
  }
  for (let index = 1; index <= 4; index += 1) {
    writeFixtureFile(root, `noise-${index}.txt`, `${index}\n`);
    writeFixtureFile(root, 'message.txt', `chore: unrelated ${padding}\n`);
    fixtureGit(root, ['add', 'noise-' + index + '.txt']);
    fixtureGit(root, ['commit', '-q', '-F', 'message.txt']);
  }
  fixtureGit(root, ['checkout', '-q', '-b', 'story/B-f0f7']);
  redGreenFixtureCommit(root, 'fix.txt', 'GREEN(B-f0f7:F-001): the fix on the story branch');
  const matching = execFileSync(
    'git',
    ['log', '--format=%s', '-E', `--grep=${QUALIFIED_RED_SUBJECT_GREP}`, 'main'],
    { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 },
  );
  assert.ok(matching.length > 1024 * 1024, `the matching subjects alone must exceed 1 MB to exercise the buffer (got ${matching.length} bytes)`);
  assert.deepEqual([...priorRedIds(root)].sort(), expected.sort(), 'every qualified RED below the merge-base must be collected despite the > 1 MB subject volume');
  const accepted = evaluateBranchRedGreen(root);
  assert.equal(accepted.ok, true, `the branch GREEN must be satisfied through the large history: ${describeRedGreenViolations(accepted)}`);
});

testCase('priorRedIds raises when the git call fails instead of returning an empty set', () => {
  // A repository with no `main` branch: merge-base fails. Silence here would turn
  // every GREEN into a false green_without_red (or, with the old whole-history read,
  // hide a buffer overflow); the smoke must fail loudly naming git.
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-red-green-git-failure-'));
  temporaryRoots.push(root);
  writeFixtureFile(root, 'README.md', '# no main branch\n');
  fixtureGit(root, ['init', '-q']);
  fixtureGit(root, ['checkout', '-q', '-B', 'trunk']);
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '-m', 'base']);
  assert.throws(() => priorRedIds(root), /git/, 'a failing git call must raise, never degrade to an empty prior set');
  const notARepo = mkdtempSync(join(tmpdir(), 'proof-or-stop-red-green-not-a-repo-'));
  temporaryRoots.push(notARepo);
  assert.throws(() => priorRedIds(notARepo), /git/, 'a directory that is not a repository must raise as well');
});

testCase('main..HEAD passes the RED-before-GREEN helper', () => {
  const range = readRedGreenCommits(null, ['main..HEAD']);
  // Once merged the range is empty; fall back to the subject-filtered whole
  // history rather than passing vacuously.
  const usingRange = range.some((commit) => parseRedGreenSubject(commit.subject) !== null);
  const commits = usingRange
    ? range
    : readRedGreenCommits(null, ['-E', '--grep=^(RED|GREEN)\\(']);
  assert.ok(commits.length > 0, 'no RED/GREEN commits were readable; the ordering claim cannot be proven');
  const result = usingRange ? evaluateBranchRedGreen(null) : evaluateRedGreenCommitOrder(commits);
  assert.equal(result.ok, true, describeRedGreenViolations(result));
  console.log('[PASS] RED-before-GREEN guard: every GREEN(CHK-nnn) and GREEN(F-nnn) subject on main..HEAD has a preceding RED or a no-RED marker with a reason');
});

// ---------------------------------------------------------------------------
// (40) Handler encoding convention, applied EXHAUSTIVELY: discover the
//      constrained fields by probing rather than by listing them.
// ---------------------------------------------------------------------------

/**
 * A field is CONSTRAINED when, within one JS type, the schema accepts some values
 * and refuses others: that is exactly what a zod min/max/enum does. A pure type
 * check (`z.boolean()`) or a total refusal (`z.never()`) shows no such split.
 */
function schemaFieldIsConstrained(field: z.ZodType): boolean {
  const probesByType: unknown[][] = [
    ['x', '', '   ', 'definitely-not-a-member-value', 'x'.repeat(4096)],
    [0, -1, 1.5, 987654321],
    [true, false],
  ];
  return probesByType.some((probes) => {
    const outcomes = probes.map((probe) => field.safeParse(probe).success);
    return outcomes.includes(true) && outcomes.includes(false);
  });
}

/**
 * Bypass coverage: each assertion calls the runtime entry DIRECTLY with an invalid
 * value, so no schema is anywhere in the call path.
 */
const ZOD_BYPASS_COVERAGE: Record<string, () => void> = {
  storyId: () => {
    // Handler entry.
    assert.throws(() => resolveValidationPlanRequest({ storyId: '', tier: 'fast' }), /storyId/);
    assert.throws(() => resolveValidationPlanRequest({ storyId: '   ', tier: 'fast' }), /storyId/);
    assert.throws(() => resolveValidationPlanRequest({ storyId: 7 as never, tier: 'fast' }), /storyId/);
    assert.throws(() => resolveValidationPlanRequest({ tier: 'fast' } as never), /storyId/);
    // Consuming core entry 1: the tier planner.
    assert.throws(
      () => resolveValidationTierPlan({ input: { ...planInput(), storyId: '' }, requestedTier: 'story-fast' }),
      /storyId/,
    );
    assert.throws(
      () => resolveValidationTierPlan({ input: { ...planInput(), storyId: '  ' }, requestedTier: 'story-fast' }),
      /storyId/,
    );
    // Consuming core entry 2: the Story input collector.
    assert.throws(() => collect({ story: { storyId: '', phase: 'DEV' } }), /storyId/);
  },
  tier: () => {
    // Handler entry.
    assert.throws(() => resolveValidationPlanRequest({ storyId: PLAN_CLI_STORY_ID, tier: '' }), /tier/);
    assert.throws(() => resolveValidationPlanRequest({ storyId: PLAN_CLI_STORY_ID, tier: 'story-quick' }), /unknown tier "story-quick"/);
    assert.throws(() => resolveValidationPlanRequest({ storyId: PLAN_CLI_STORY_ID, tier: 3 as never }), /tier/);
    assert.throws(() => resolveValidationPlanRequest({ storyId: PLAN_CLI_STORY_ID } as never), /tier/);
    // Consuming core entry 1: the tier planner rejects the CLI alias vocabulary.
    assert.throws(
      () => resolveValidationTierPlan({ input: planInput(), requestedTier: 'fast' as ValidationTier }),
      /unknown tier "fast"/,
    );
    assert.throws(
      () => resolveValidationTierPlan({ input: planInput(), requestedTier: '' as ValidationTier }),
      /tier/,
    );
    // Consuming core entry 2: the shared tier assertion used by every consumer.
    assert.throws(() => assertValidationTier('fast', 'zod-bypass-probe'), /tier/);
    assert.throws(() => assertValidationTier(undefined, 'zod-bypass-probe'), /tier/);
  },
};

testCase('every zod-constrained validation_plan field is still rejected when the schema is bypassed', () => {
  const tool = planCliTool();
  const constrained = Object.entries(tool.schema as Record<string, z.ZodType>)
    .filter(([, field]) => schemaFieldIsConstrained(field))
    .map(([key]) => key)
    .sort();

  // Non-vacuity: the discovery probe must find the fields we know carry constraints.
  for (const expected of ['storyId', 'tier']) {
    assert.ok(constrained.includes(expected), `${expected} carries a zod constraint and must be discovered by probing`);
  }

  for (const key of constrained) {
    const cover = ZOD_BYPASS_COVERAGE[key];
    assert.ok(
      cover,
      `validation_plan.${key} carries a zod constraint with no schema-bypass coverage; ` +
      'the Handler encoding convention requires a runtime re-check at the handler entry AND at every consuming core entry',
    );
    cover();
  }

  // Coverage entries may not outlive their field either.
  for (const key of Object.keys(ZOD_BYPASS_COVERAGE)) {
    assert.ok(constrained.includes(key), `stale bypass coverage for a field that no longer carries a constraint: ${key}`);
  }
});

// ---------------------------------------------------------------------------
// (41) DoneWhen coverage. Each plan.md DoneWhen line names the case(s) proving
//      it; a cited case that did not run and pass fails this guard, so renaming
//      or deleting a case can never silently drop a DoneWhen.
// ---------------------------------------------------------------------------
const DONEWHEN_COVERAGE: Array<{ item: string; doneWhen: string; cases: string[] }> = [
  { item: 'CHK-001', doneWhen: 'a declared id is preserved verbatim; an undeclared one gets a prov- id', cases: [
    'declared id is preserved verbatim and is not marked provisional',
    'undeclared id becomes a deterministic prov- id over the narrow portable tuple',
  ] },
  { item: 'CHK-001', doneWhen: 'changing only a label, or an array position, leaves the id unchanged', cases: [
    'moving a command to another array position does not change its provisional id',
    'renaming ONLY a label keeps the stable id and changes the commandSetDigest',
  ] },
  { item: 'CHK-001', doneWhen: 'two commands with identical narrow tuples are rejected as duplicates', cases: [
    'two identical narrow tuples are rejected as duplicates naming both entries',
  ] },
  { item: 'CHK-001', doneWhen: 'a label rename changes commandSetDigest while the stable id survives', cases: [
    'renaming ONLY a label keeps the stable id and changes the commandSetDigest',
  ] },
  { item: 'CHK-001', doneWhen: 'a provisional-id warning names the count while any remain and is absent once none do', cases: [
    'a migration warning names the runtime count of commands still lacking a declared id',
    'the migration warning is absent once every command declares an id',
  ] },
  { item: 'CHK-001', doneWhen: 'the routine identity digest is byte-identical while no id is declared, and declaring one changes source.inputDigest', cases: [
    'the optional id leaves the routine identity digest byte-identical, while declaring it in config changes source.inputDigest',
  ] },

  { item: 'CHK-002', doneWhen: 'exact-id, legacy-exact, missing and ambiguous paths each have a fixture', cases: [
    'an exact commandId match resolves and is recorded as a declared-id resolution',
    'a legacy string matching exactly one command records legacy-exact and the normalized-tuple digest',
    'an unknown commandId stops as pinned_command_missing and produces no binding',
    'an explicit unresolvable commandId still stops while an unresolvable legacy string does not',
    'a legacy string matching nothing is a non-inventory evidence command, not a stop',
    'two commands with identical normalized tuples stop as pinned_command_ambiguous listing every candidate',
  ] },
  { item: 'CHK-002', doneWhen: 'a label difference alone does not break an otherwise ambiguous tie', cases: [
    'two commands with identical normalized tuples stop as pinned_command_ambiguous listing every candidate',
  ] },
  { item: 'CHK-002', doneWhen: 'cwd-only and shell-versus-argv differences make two commands distinct', cases: [
    'commands differing only by resolved cwd are distinct',
    'commands differing only by shell-versus-argv form are distinct',
  ] },
  { item: 'CHK-002', doneWhen: 'pinResolution and the normalized-tuple digest are recorded on a legacy resolution', cases: [
    'a legacy string matching exactly one command records legacy-exact and the normalized-tuple digest',
  ] },

  { item: 'CHK-003', doneWhen: 'rename, delete, story-metadata-exclusion and read-failure fixtures all pass', cases: [
    'a deleted path remains a seed and a rename contributes both old and new paths',
    'story metadata and registered runtime artifacts are excluded by the canonical classifier',
    'a changed-file read failure is changed_files_unavailable, never an empty seed set',
  ] },
  { item: 'CHK-003', doneWhen: 'the collector calls the shared rename-aware reader rather than duplicating git access', cases: [
    'the collector defaults to the SHARED rename-aware reader and the shared hash snapshot',
  ] },
  { item: 'CHK-003', doneWhen: 'duration history is surfaced, absent history is unknown-duration, and duration cannot change the selected set', cases: [
    'duration history is collected and an absent history reports unknown-duration, never zero',
    'mutating duration history leaves the selected set and the selection digest unchanged',
  ] },
  { item: 'CHK-003', doneWhen: 'verification intent is reason context only and produces no command-to-seed edge', cases: [
    'verification intent is carried as reason context and produces no command-to-seed edge',
  ] },

  { item: 'CHK-004', doneWhen: 'all four source kinds have fixtures', cases: [
    'configured is the command-set path',
    'fallback reports source_kind_atomic and executes its atomic repository-full path',
    'validate-file reports source_kind_atomic and executes its atomic repository-full path',
    'no-validator preserves the existing skip/warn and produces NO tier pass',
  ] },
  { item: 'CHK-004', doneWhen: 'every reason code has a non-empty gloss, asserted by enumeration', cases: [
    'the pin-related glosses name the registry boundary and a remedy that exists',
    'every reason code carries a non-empty plain-language gloss, asserted by enumeration',
  ] },
  { item: 'CHK-004', doneWhen: 'no input produces a reduced effective tier', cases: [
    'no input in the resolver space yields a reduced effective tier',
  ] },
  { item: 'CHK-004', doneWhen: 'an empty selection is a stop, not a pass', cases: [
    'the stop-code list is derived from the table and the resolver consults it',
    'an empty universe stops as empty_selection_unclassified rather than passing empty',
  ] },

  { item: 'CHK-005', doneWhen: 'human and --json outputs both carry every documented field including finalAuthority: no', cases: [
    'validation_plan --tier=fast prints every labelled field including finalAuthority: no',
    'a plan render and a stop render differ on the documented status discriminator',
    'every planner outcome renders only its own status line, and a forged plan status is refused',
    'the printed counts are derived at runtime, not written into the renderer',
    'duration history from prior signed validation artifacts reaches the report with its basis',
    'validation_plan --json emits one parseable object carrying the same facts',
  ] },
  { item: 'CHK-005', doneWhen: 'a missing storyId and an unknown tier are rejected by name', cases: [
    'a missing storyId and an unknown tier are each rejected BY NAME, never defaulted',
  ] },
  { item: 'CHK-005', doneWhen: 'every story file is byte-identical after invocation and no write-shaped flag is accepted', cases: [
    'invoking validation_plan leaves every byte under the project root identical',
    'no write / persist / execute / run flag is accepted, at the schema OR the handler',
  ] },
];

// ---------------------------------------------------------------------------
// (42) REAL REGISTRATION (load-bearing) — CHK-006's verification intent says the
//      registration is proven by the bidirectional membership check rather than
//      by inspection. `full-suite-runner-smoke` cannot prove that: it rebuilds
//      `fixtureScripts['test:serial-reference']` FROM `FULL_SUITE_ENTRIES`, so
//      the two authorities it compares are the same object and can never
//      disagree. It reported PASS while `test:validation-tier-planner` sat in the
//      real chain with no RESOURCE_POLICY row.
//
//      So this case reads the REAL root package.json chain and the REAL
//      RESOURCE_POLICY and asserts the relationship directly. Deleting the
//      `repoRead('test:validation-tier-planner')` row must fail HERE — that is
//      the exact scenario the existing smoke let through.
//
//      Scope: assert the real relationship. Repairing full-suite-runner-smoke's
//      synthetic-fixture blindness is a separately recorded item, not this one.
// ---------------------------------------------------------------------------
testCase('the REAL package.json chain and the REAL RESOURCE_POLICY both register test:validation-tier-planner', () => {
  const repoRoot = (gitOutput(['rev-parse', '--show-toplevel']) ?? '').trim();
  assert.ok(repoRoot, 'this guard reads the real repository inventory; a missing repository is a failure, not a skip');

  const scripts = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> }).scripts ?? {};

  // The prefix chain is a legitimately separate list whose members would otherwise
  // read as stalePolicy against the main chain, so compose the reference exactly the
  // way the runner does instead of naively unioning or ignoring it.
  const mainChain = scripts['test:serial-reference'];
  const prefixChain = scripts['test:serial-reference-prefix'];
  assert.ok(mainChain, 'root package.json must define test:serial-reference: it is the membership authority');
  const serialReference = [prefixChain, mainChain].filter(Boolean).join(' && ');

  // Authority 1: the real chain.
  const referenceMembers = parseSerialReference(serialReference);
  assert.ok(
    parseSerialReference(mainChain!).includes('test:validation-tier-planner'),
    'test:validation-tier-planner must be a member of the canonical test:serial-reference chain',
  );
  assert.equal(
    scripts['test:validation-tier-planner'],
    'node packages/main/dist/tasks/validation-tier-planner-smoke.js',
    'the chain member must resolve to a real npm script running this suite',
  );

  // Authority 2: the real RESOURCE_POLICY, read through the module that declares it.
  const policyNames = FULL_SUITE_ENTRIES.map((entry) => entry.name);
  assert.ok(
    policyNames.includes('test:validation-tier-planner'),
    'RESOURCE_POLICY is a SEPARATE mandatory mapping; a chain member with no policy row fails the whole suite closed',
  );

  // The bidirectional relationship, computed over the REAL pair rather than over a
  // fixture rebuilt from one of the two sides.
  const policyByName = new Set(policyNames);
  const unknownPolicy = referenceMembers.filter((name) => !policyByName.has(name));
  const missingScripts = referenceMembers.filter((name) => !scripts[name]);
  const stalePolicy = policyNames.filter((name) => !referenceMembers.includes(name));
  assert.deepEqual(unknownPolicy, [], `real chain members with no RESOURCE_POLICY row: ${unknownPolicy.join(', ')}`);
  assert.deepEqual(missingScripts, [], `real chain members with no npm script: ${missingScripts.join(', ')}`);
  assert.deepEqual(stalePolicy, [], `RESOURCE_POLICY rows absent from the real chain: ${stalePolicy.join(', ')}`);

  // End to end through the production reader, with the real policy as its default.
  const entries = entriesFromSerialReference(serialReference, scripts);
  assert.ok(
    entries.some((entry) => entry.name === 'test:validation-tier-planner'),
    'the production inventory reader must accept the real pair and yield this member',
  );
});

// ---------------------------------------------------------------------------
// (43) REAL VALIDATE.COMMANDS REGISTRATION (B-a745 F-005, load-bearing) —
//      registration has a THIRD authority beyond the serial-reference chain and
//      RESOURCE_POLICY: `proof-or-stop.config.json` `validate.commands`, which is
//      the planner's command universe. This Story's own verification evidence
//      pins `node packages/main/dist/tasks/validation-tier-planner-smoke.js`, so
//      a suite absent from that universe makes every one of its pins resolve to
//      `pinned_command_missing` and `validation_plan` stop with `0 of 0` — which
//      is exactly what happened while cases (42) and full-suite-runner-smoke both
//      reported PASS. Neither of those two reads validate.commands at all.
//
//      So this case reads the REAL configured command set through the production
//      reader and drives both the REAL pin resolver and validation_plan renderer,
//      rather than inspecting JSON text. It also proves B-e256's global-CLI RED
//      command is visible by stable id/label in actual planner output.
// ---------------------------------------------------------------------------
testCase('the real validation_plan output exposes red-global-cli-exec-bit by stable id and label', () => {
  const repoRoot = (gitOutput(['rev-parse', '--show-toplevel']) ?? '').trim();
  assert.ok(repoRoot, 'this guard reads the real repository inventory; a missing repository is a failure, not a skip');

  // The exact string every verification-evidence pin recorded by this Story names.
  const pinnedCommand = 'node packages/main/dist/tasks/validation-tier-planner-smoke.js';
  const parsedPin = parseLegacyValidationCommandString(pinnedCommand);
  assert.ok(parsedPin, 'the recorded pin must parse under the one canonical legacy string rule');

  // Authority 3: the real configured command set, read through the production reader.
  const commands = configuredValidationCommands(repoRoot);
  const matches = commands.filter((entry) => entry.command === parsedPin!.command
    && entry.args.length === parsedPin!.args.length
    && entry.args.every((arg, index) => arg === parsedPin!.args[index]));
  assert.equal(
    matches.length,
    1,
    'proof-or-stop.config.json validate.commands is the planner command universe and a SEPARATE mandatory '
    + `registration; this suite must appear there exactly once, found ${matches.length}`,
  );

  // End to end through the real resolver: the recorded pin must actually bind.
  const universe = buildValidationPinUniverse({ projectRoot: repoRoot, commands });
  const resolution = resolveValidationCommandPin({ universe, evidence: { command: pinnedCommand } });
  assert.equal(
    resolution.status,
    'resolved',
    `the recorded pin must resolve against the real universe, got ${JSON.stringify(resolution)}`,
  );

  const redPinnedCommand = 'node packages/main/tests/red/red-global-cli-exec-bit.mjs';
  const redPin = parseLegacyValidationCommandString(redPinnedCommand);
  assert.ok(redPin, 'the B-e256 RED command must parse under the canonical pin rule');
  const redMatches = commands.filter((entry) => entry.command === redPin!.command
    && entry.args.length === redPin!.args.length
    && entry.args.every((arg, index) => arg === redPin!.args[index]));
  assert.equal(redMatches.length, 1, `the B-e256 RED command must appear exactly once in the real planner universe, found ${redMatches.length}`);
  assert.equal(redMatches[0].id, 'red-global-cli-exec-bit');
  assert.equal(redMatches[0].label, 'B-e256 global CLI rebuild and promotion regression');

  // Execute the production handler over the real configured command row. A
  // config-only membership assertion is insufficient: the operator-visible
  // planner rendering itself must preserve the stable identity.
  const { ctx } = planCliRoot({ commands: redMatches });
  const rendered = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'full', explain: true });
  assert.match(rendered, /^inclusion reasons by unit \(1\):$/m);
  assert.match(rendered, /^ {2}red-global-cli-exec-bit \[B-e256 global CLI rebuild and promotion regression\]$/m);
});

testCase('every DoneWhen of CHK-001..CHK-005 is covered by a fixture case that actually ran and passed', () => {
  const declaredItems = new Set(DONEWHEN_COVERAGE.map((entry) => entry.item));
  assert.deepEqual([...declaredItems].sort(), ['CHK-001', 'CHK-002', 'CHK-003', 'CHK-004', 'CHK-005']);

  const missing: string[] = [];
  for (const entry of DONEWHEN_COVERAGE) {
    for (const name of entry.cases) {
      if (!passedCases.has(name)) missing.push(`${entry.item} "${entry.doneWhen}" cites a case that did not run and pass: "${name}"`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});

// ---------------------------------------------------------------------------
// (45) DEFAULT OUTPUT BOUND (B-dc2e F-003) — plan.md promises every smoke's
//      default output stays under 11000 chars, and the verification executor
//      keeps only the first 12000 chars of stdout before matching a pinned
//      selector. This case measures the real default rendering of THIS run and
//      fails on growth. It must stay the last case: its projection covers
//      exactly the lines printed after it.
// ---------------------------------------------------------------------------
const DEFAULT_STDOUT_BOUND_CASE_NAME = 'bound (F-003): the default (VALIDATION_TIER_PLANNER_VERBOSE unset) total stdout of this smoke is under 11000 chars';

testCase(DEFAULT_STDOUT_BOUND_CASE_NAME, () => {
  const summaryLine = (projected: number): string => `default stdout projection: ${projected} chars (bound ${DEFAULT_STDOUT_BOUND_CHARS})`;
  // Everything the default rendering has written so far, plus exactly the lines still to
  // come when every case passes: the summary line below, this case's ok line, the PASS line.
  const tail = `  ok  ${DEFAULT_STDOUT_BOUND_CASE_NAME}\n\n${MARKER}: PASS\n`;
  const base = capturedStdoutChars - verboseOnlyChars + tail.length;
  // The summary line is part of the output; its length depends only on the digit count of the projection.
  let projected = base + summaryLine(base).length + 1;
  projected = base + summaryLine(projected).length + 1;
  assert.ok(
    projected < DEFAULT_STDOUT_BOUND_CHARS,
    `default stdout is ${projected} chars, not under ${DEFAULT_STDOUT_BOUND_CHARS}: keep collapsed sections collapsed and CHK-006 case names short, `
    + 'or print new detail only under VALIDATION_TIER_PLANNER_VERBOSE=1',
  );
  console.log(summaryLine(projected));
});

if (lastCaseName !== DEFAULT_STDOUT_BOUND_CASE_NAME) {
  failures += 1;
  console.log(`  FAIL the default stdout bound case must stay the last case (add new cases before it); the last case was "${lastCaseName}"`);
}
flushSection();

for (const root of temporaryRoots) {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${MARKER}: FAIL (${failures} case${failures === 1 ? '' : 's'} failed)`);
  process.exit(1);
}
console.log(`\n${MARKER}: PASS`);
