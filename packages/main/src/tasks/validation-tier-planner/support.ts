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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { buildValidationCommandInventory, buildValidationPinUniverse, resolveValidationCommandPin, type ValidationPinResolutionResult } from '../../core/validation-command-identity.js';
import { collectStoryRelevanceInput, type ChangedFileStatusReader, type StoryRelevanceChangedFiles, type StoryRelevanceInput, type StoryRelevanceInputArgs } from '../../core/validation-relevance-input.js';
import { type EvidenceHashSnapshot } from '../../core/evidence-freshness.js';
import type { ChecklistItem, StoryInfo } from '../../core/types.js';


import { assertValidationTier, resolveValidationTierPlan, type ValidationTier, type ValidationImpactIndex, type ValidationTierPlanResult } from '../../core/validation-tier-planner.js';
import type { RoutineValidationSourceKind, ValidationCommand } from '../../core/validation-types.js';
import { createValidationPlanHandlers, resolveValidationPlanRequest } from '../../handlers/validation-plan.js';
import type { HandlerContext } from '../../handlers/context.js';
import { MAIN_TOOLS } from '../../cli/command-catalog.js';



import { evaluateRedGreenCommitOrder, isStoryQualifiedRedGreenId, parseRedGreenSubject } from '../../core/red-green-commit-guard.js';
import { resetConfigCache } from '../../core/config.js';
import { StoryStore } from '../../core/store.js';






export const MARKER = 'validation-tier-planner-smoke';

export const ROOT = '/repo';

export let memoizedRepositorySourceRoot: string | undefined;

export function repositorySourceRoot(): string {
  if (memoizedRepositorySourceRoot) return memoizedRepositorySourceRoot;
  const root = (gitOutput(['rev-parse', '--show-toplevel']) ?? '').trim();
  assert.ok(
    root && existsSync(join(root, 'packages/main/src/core/validation-tier-planner.ts')),
    'validation-tier-planner-smoke source guards require a Git source checkout',
  );
  memoizedRepositorySourceRoot = root;
  return root;
}

export let failures = 0;

export const DEFAULT_STDOUT_BOUND_CHARS = 11_000;

export const VERBOSE = process.env.VALIDATION_TIER_PLANNER_VERBOSE === '1';

export let capturedStdoutChars = 0;

export let verboseOnlyChars = 0;

{
  const originalWrite = process.stdout.write;
  process.stdout.write = function (this: NodeJS.WriteStream, chunk: any, ...rest: any[]): boolean {
    capturedStdoutChars += typeof chunk === 'string' ? chunk.length : Buffer.from(chunk).toString('utf-8').length;
    return (originalWrite as any).call(this, chunk, ...rest);
  } as typeof process.stdout.write;
}

export const passedCases = new Set<string>();

export let lastCaseName = '';

export let section: { name: string; perCase: boolean; passed: number } | null = null;

export let sectionCount = 0;

export function flushSection(): void {
  if (section && !section.perCase) console.log(`  ok  ${section.passed} case${section.passed === 1 ? '' : 's'} passed`);
  section = null;
}

export function beginSection(name: string, options: { perCase?: boolean } = {}): void {
  flushSection();
  section = { name, perCase: options.perCase === true, passed: 0 };
  console.log(`${sectionCount === 0 ? '' : '\n'}${MARKER}: running ${name}`);
  sectionCount += 1;
}

export function testCase(name: string, run: () => void): void {
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

export function command(overrides: Partial<ValidationCommand> & { label: string; command: string }): ValidationCommand {
  return { args: [], ...overrides };
}

export function inventory(commands: ValidationCommand[]) {
  return buildValidationCommandInventory({ commands });
}

export function routineIdentityArgs(projectRoot: string, commands: ValidationCommand[], sourceInputs: unknown) {
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

export const temporaryRoots: string[] = [];

export function projectRootWithCommands(entries: unknown[]): string {
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

export function projectRootWithConfig(commandEntry: Record<string, unknown>): string {
  return projectRootWithCommands([commandEntry]);
}

export const F023_ROOTS = ['/repo-a', '/some/much/deeper/checkout/repo-b'];

export function inventoryUnderRoot(projectRoot: string, commands: ValidationCommand[]) {
  return buildValidationPinUniverse({ projectRoot, commands, processEnvironment: { PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv, platform: 'linux' });
}

export const PORTABILITY_PLATFORMS: NodeJS.Platform[] = ['linux', 'darwin', 'win32'];

export function universeOn(platform: NodeJS.Platform, commands: ValidationCommand[]) {
  return buildValidationPinUniverse({
    projectRoot: ROOT,
    commands,
    processEnvironment: { PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv,
    platform,
  });
}

export const PIN_ENVIRONMENT = { PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv;

export function pinUniverse(commands: ValidationCommand[], platform: NodeJS.Platform = 'linux') {
  return buildValidationPinUniverse({
    projectRoot: ROOT,
    commands,
    processEnvironment: PIN_ENVIRONMENT,
    platform,
  });
}

export function resolvePin(
  commands: ValidationCommand[],
  evidence: { commandId?: string; command?: string },
): ValidationPinResolutionResult {
  return resolveValidationCommandPin({ universe: pinUniverse(commands), evidence });
}

export function idOfLabel(universe: ReturnType<typeof pinUniverse>, label: string): string {
  return universe.entries.find((entry) => entry.label === label)!.id;
}

export const FIXTURE_HEAD_SNAPSHOT: EvidenceHashSnapshot = {
  schemaVersion: 'proof-or-stop.evidence_hash_snapshot.v1',
  headHash: 'head0000000000000000000000000000000000000',
  materialHash: 'material00000000000000000000000000000000',
  storyFilesHash: 'storyfiles000000000000000000000000000000',
  gitCwd: ROOT,
  metadataRoot: ROOT,
  ref: 'HEAD',
  capturedAt: '2026-01-01T00:00:00.000Z',
  materialDirtyFiles: [],
};

export function fixtureHashSnapshot(args: { ref?: string }): EvidenceHashSnapshot {
  return { ...FIXTURE_HEAD_SNAPSHOT, ref: args.ref ?? 'HEAD' };
}

export function checklistItem(overrides: Partial<ChecklistItem> & { id: string }): ChecklistItem {
  return {
    title: `${overrides.id} title`,
    status: 'done',
    startTime: null,
    endTime: null,
    ...overrides,
  } as ChecklistItem;
}

export function statusReader(statuses: Record<string, string>): ChangedFileStatusReader {
  return () => ({ ...statuses });
}

export const throwingStatusReader: ChangedFileStatusReader = () => {
  throw new Error('fatal: bad revision "main"');
};

export const RELEVANCE_COMMANDS: ValidationCommand[] = [
  command({ label: 'unit', command: 'npm', args: ['test'], id: 'unit-suite' }),
  command({ label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'lint-suite' }),
];

export function collect(overrides: Partial<StoryRelevanceInputArgs> = {}): StoryRelevanceInput {
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

export function seedOf(input: StoryRelevanceInput, kind: string, value: string) {
  return input.seeds.find((seed) => seed.kind === kind && seed.value === value);
}

export type UnavailableChangedFiles = Extract<StoryRelevanceChangedFiles, { status: 'changed_files_unavailable' }>;

export function unavailableChangedFiles(input: StoryRelevanceInput): UnavailableChangedFiles {
  assert.equal(input.changedFiles.status, 'changed_files_unavailable');
  return input.changedFiles as UnavailableChangedFiles;
}

export const GIT_USAGE_DUMP = [
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

export const LONG_GIT_USAGE_DUMP = [
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

export const SOURCE_KINDS: RoutineValidationSourceKind[] = ['configured', 'fallback', 'validate-file', 'no-validator'];

export function planInput(overrides: Partial<StoryRelevanceInputArgs> = {}): StoryRelevanceInput {
  return collect(overrides);
}

export function planFor(
  requestedTier: ValidationTier,
  overrides: Partial<StoryRelevanceInputArgs> = {},
): ValidationTierPlanResult {
  return resolveValidationTierPlan({ input: planInput(overrides), requestedTier });
}

export function reasonCodes(result: ValidationTierPlanResult): string[] {
  return result.escalationReasons.map((reason) => reason.code);
}

export const PLAN_CLI_STORY_ID = 'B-a745';

export function planCliRoot(options: {
  commands?: unknown[];
  impactIndex?: ValidationImpactIndex;
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
        ...(options.impactIndex ? { dynamic: { impactIndex: options.impactIndex } } : {}),
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

export function planCli(ctx: HandlerContext) {
  return createValidationPlanHandlers(ctx).validation_plan;
}

export function treeBytes(root: string): Record<string, string> {
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

export function refuseWritesStore(store: StoryStore): StoryStore {
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

export function planCliTool() {
  const tool = MAIN_TOOLS.find((entry) => entry.name === 'validation_plan');
  assert.ok(tool, 'validation_plan must be registered in the CLI command catalog');
  return tool!;
}

export const GIT_FIXTURE_IDENTITY = ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proof-or-Stop Smoke'];

export const WORKTREE_FIXTURE_STORY_ID = 'B-a745';

export const WORKTREE_FIXTURE_CHANGED_FILE = 'src/core/planner-touched.ts';

export const WORKTREE_FIXTURE_STORY_COMMAND_ID = 'planner-suite';

export function fixtureGit(cwd: string, args: string[]): string {
  return execFileSync('git', [...GIT_FIXTURE_IDENTITY, ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function writeFixtureFile(root: string, relPath: string, content: string): void {
  const absolute = join(root, relPath);
  mkdirSync(resolve(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content, 'utf-8');
}

export function buildStoryWorktreeFixture(layout: 'plain' | 'wrapper-root'): {
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

export function planFromRoot(root: string): Record<string, any> {
  resetConfigCache();
  const ctx = { store: new StoryStore(root), root, scanRoot: root } as HandlerContext;
  return JSON.parse(planCli(ctx)({ storyId: WORKTREE_FIXTURE_STORY_ID, tier: 'fast', json: true })) as Record<string, any>;
}

export function unclassifiedValues(report: Record<string, any>): string[] {
  return (report.unclassifiedInputs as Array<{ value: string }>).map((entry) => entry.value).sort();
}

export function escalationCodes(report: Record<string, any>): string[] {
  return (report.escalationReasons as Array<{ code: string }>).map((entry) => entry.code).sort();
}

export type EvidenceDigestName = 'headHash' | 'materialHash' | 'storyFilesHash';

export const EVIDENCE_DIGEST_NAMES: EvidenceDigestName[] = ['headHash', 'materialHash', 'storyFilesHash'];

export function snapshotWithout(missing: EvidenceDigestName[]): (args: { ref?: string }) => EvidenceHashSnapshot {
  return (args) => {
    const snapshot: Record<string, unknown> = { ...FIXTURE_HEAD_SNAPSHOT, ref: args.ref ?? 'HEAD' };
    for (const name of missing) delete snapshot[name];
    return snapshot as unknown as EvidenceHashSnapshot;
  };
}

export function hashEscalationDetail(input: StoryRelevanceInput): string {
  const escalation = input.escalations.find((entry) => entry.code === 'hash_snapshot_unavailable');
  assert.ok(escalation, 'an incomplete snapshot must escalate as hash_snapshot_unavailable');
  const detail = escalation!.detail;
  assert.equal(detail.includes('\n'), false, `the detail must be ONE line, got:\n${detail}`);
  assert.ok(detail.length <= 300, `the detail must be bounded, got ${detail.length} characters`);
  return detail;
}

export function gitOutputIn(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

export function gitOutput(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

export function declaredChecklistItems(repoRoot: string): string[] {
  const directory = join(repoRoot, 'packages/main/src/tasks/validation-tier-planner');
  const source = readdirSync(directory).filter(name => name.endsWith('.ts')).sort()
    .map(name => readFileSync(join(directory, name), 'utf-8')).join('\n');
  const found = new Set<string>();
  for (const line of source.split('\n')) {
    const match = /^beginSection\('(CHK-\d{3})/.exec(line);
    if (match) found.add(match[1]!);
  }
  return [...found].sort();
}

export function readRedGreenCommits(cwd: string | null, logArgs: string[]): Array<{ subject: string; body: string }> {
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

export const NO_RED_REASON = 'comment-only wording fix with no behaviour change, no fixture can fail';

export function priorRedIds(cwd: string | null): ReadonlySet<string> {
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

export const PRIOR_RED_SUBJECT_GREP = '^RED\\(B-[0-9a-f]{4}:(CHK|F)-[0-9]{3}\\):';

export const PRIOR_RED_GIT_MAX_BUFFER = 64 * 1024 * 1024;

export function gitOutputStrict(cwd: string | null, args: string[]): string {
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

export function evaluateBranchRedGreen(cwd: string | null) {
  return evaluateRedGreenCommitOrder(readRedGreenCommits(cwd, ['main..HEAD']), { priorRedIds: priorRedIds(cwd) });
}

export function redGreenFixtureRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  writeFixtureFile(root, 'README.md', '# red-green fixture\n');
  fixtureGit(root, ['init', '-q']);
  fixtureGit(root, ['checkout', '-q', '-B', 'main']);
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '-m', 'base']);
  return root;
}

export function redGreenFixtureCommit(root: string, relPath: string, subject: string): void {
  writeFixtureFile(root, relPath, `${subject}\n`);
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '-m', subject]);
}

export const QUALIFIED_RED_SUBJECT_GREP = '^RED\\(B-[0-9a-f]{4}:(CHK|F)-[0-9]{3}\\):';

export function schemaFieldIsConstrained(field: z.ZodType): boolean {
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

export const ZOD_BYPASS_COVERAGE: Record<string, () => void> = {
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

export const DONEWHEN_COVERAGE: Array<{ item: string; doneWhen: string; cases: string[] }> = [
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

export const DEFAULT_STDOUT_BOUND_CASE_NAME = 'bound (F-003): the default (VALIDATION_TIER_PLANNER_VERBOSE unset) total stdout of this smoke is under 11000 chars';

export function reportPlannerFull(): void {


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
}

export function reportPlannerPartial(capabilities: string[]): void { flushSection(); for(const root of temporaryRoots) rmSync(root,{recursive:true,force:true}); if(failures) throw new Error(MARKER+': partial failed ('+failures+')'); console.log('PLANNER_PARTIAL_PASS '+JSON.stringify({full:false,capabilities,checks:passedCases.size})); }
