#!/usr/bin/env node
/**
 * RED artifact (W2c / B-506e, CHK-011:adversarial:1) — de-registering a critical
 * smoke from `proof-or-stop.config.json` `validate.commands` is caught by a COMMITTED
 * test.
 *
 * The intent's literal scenario: "Remove the chain-smoke from validate.commands
 * -> proof-or-stop validate no longer runs it; the regression must be caught by a
 * committed test or the validate output audit." Before this test NOTHING in the
 * repo scanned `validate.commands` for completeness, so deleting the
 * `red-evidence-chain-smoke.js` registration line silently stopped the
 * convergence anchor from ever running under `proof-or-stop validate`.
 *
 * ── WHY THIS FILE WAS REWRITTEN (B-49d4, CHK-002) ───────────────────────────
 *
 * It used to compare the config against a hardcoded `REQUIRED_VALIDATE_COMMANDS`
 * array of three entries and then print `OK (... all 3 required red-evidence
 * smokes ...)`. That "3" was `REQUIRED_VALIDATE_COMMANDS.length`: the size of the
 * EXPECTATION, never the size of the POPULATION. Adding a fourth genuine
 * `packages/main/dist/tasks/red-evidence-*.js` left the number at 3 and the exit
 * code at 0 — a confident success line reporting complete coverage of a
 * population it never looked at. A check whose report cannot change when its
 * subject changes can never reveal a gap, which is precisely how fifteen red
 * harnesses ended up committed next to it without `proof-or-stop validate` ever
 * running them.
 *
 * So the expectation is now DERIVED FROM DISK. The registered side is never
 * enumerated here — it is whatever `validate.commands` contains, read live — so
 * no list in this file can go stale, and a new member is `undecided` until
 * somebody decides. The W2c anchor is still caught, by a RULE rather than by
 * remembering its name: de-registering `red-evidence-chain-smoke.js` makes it
 * undecided and this test fails naming it (proven per entry below).
 *
 * ── TWO POPULATIONS, TWO GUARDS, DISJOINT AND MUTUALLY WITNESSED ────────────
 *
 * There are two distinct populations of committed red artifacts, and covering
 * one while leaving the other is how the next addition slips through exactly as
 * these did:
 *
 *   1. `packages/main/dist/tasks/red-evidence-*` — governed HERE.
 *   2. `packages/main/tests/red/*`              — governed by the sibling guard
 *                                                 named in SIBLING_GUARD_REL.
 *
 * They are disjoint by directory (asserted, not assumed) and their union is the
 * whole of both directories' red artifacts. Neither guard may be the last one
 * standing: this file FAILS if the sibling guard is missing, and the sibling
 * fails if this one is. This file is itself a member of population 2 — it lives
 * in `packages/main/tests/red/` — so it is governed with NO self-exception; a
 * carve-out is exactly the exemption B-49d4 exists to remove.
 *
 * Population 1 is a FAMILY inside a build directory of ~300 unrelated compiled
 * tasks, so "the whole directory" is not an available reading of it. To keep the
 * family boundary from silently hiding a sibling, every `red-evidence-*` entry
 * that the population predicate rejects must be a build sidecar (`.d.ts`,
 * `.js.map`, `.d.ts.map`); anything else — a `.mjs`, a `.cjs`, an extensionless
 * script — FAILS as a red-evidence artifact outside the declared population
 * rather than being quietly skipped.
 *
 * ── NOTE FOR WHOEVER EDITS THIS FILE ────────────────────────────────────────
 *
 * This guard is a spawn target of the B-49d4 derivation artifact, which plants a
 * differently-prefixed newcomer and requires the SHIPPED guards to judge it. That
 * artifact picks its targets by skipping any file that mentions it by name — a
 * recursion break, since a file that spawns it would loop — so writing that
 * artifact's filename into this header or body removes this guard from the check.
 *
 * It no longer does so QUIETLY: the artifact asserts that its derived target set
 * equals the set of files that genuinely qualify and contains this guard by name,
 * so a mention here makes it FAIL naming this file rather than shrink its target
 * set and stay green. That failure is deliberate and noisy, but it is still a
 * failure — describe the artifact without naming it, exactly as this note does.
 * The same applies to ceasing to qualify: this guard is a target because it reads
 * `proof-or-stop.config.json` AND enumerates a directory, and dropping either would
 * also fail there.
 *
 * Run from anywhere:
 *   node packages/main/tests/red/red-w2c-validate-registration.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const SELF_ABS = fileURLToPath(import.meta.url);
const here = dirname(SELF_ABS);
const pkgRoot = join(here, '..', '..'); // packages/main
const repoRoot = join(pkgRoot, '..', '..');
// B-cc10: resolve whichever config filename exists. The canonical name is now
// proof-or-stop.config.json, so a hardcoded deprecated name threw ENOENT here.
const CONFIG_PATH = join(repoRoot, ['proof-or-stop.config.json', 'proof-or-stop.config.json'].find((n) => existsSync(join(repoRoot, n))) ?? 'proof-or-stop.config.json');
const SELF_REL = relative(repoRoot, SELF_ABS).split(sep).join('/');

/** POPULATION 1 — governed by this file. */
const POPULATION_DIR_REL = 'packages/main/dist/tasks';
const FAMILY_PREFIX = 'red-evidence-';

/** POPULATION 2 — governed by the sibling guard, which must exist. */
const SIBLING_DIR_REL = 'packages/main/tests/red';
const SIBLING_GUARD_REL = `${SIBLING_DIR_REL}/red-b49d4-harness-registration.mjs`;

const failures = [];
const fail = (check, why) => failures.push(`${check}: ${why}`);

// ── membership, stated as predicates rather than as a list ──────────────────
/** A build sidecar cannot be a `validate.commands` entry: it is not executable. */
const isBuildSidecar = (name) => name.endsWith('.map') || name.endsWith('.d.ts');
/** What `node <path>` can actually run. */
const isExecutableModule = (name) => /\.(?:js|cjs|mjs)$/.test(name);
const inFamily = (name) => name.startsWith(FAMILY_PREFIX);
const inPopulation = (name) => inFamily(name) && isExecutableModule(name) && !isBuildSidecar(name);

/**
 * Exclusions are DATA and each entry must state WHY. Empty today: all three
 * members are registered. The machinery is still exercised on every run — see
 * the synthetic audit below — so it cannot rot while unused.
 */
const REGISTRATION_EXCLUSIONS = new Map([]);
/** A reason must actually be a reason; an empty string is not a decision. */
const MIN_EXCLUSION_REASON_CHARS = 40;

/** Normalize a validate.commands entry (bare string OR {command,args}) to its argv. */
function entryArgv(entry) {
  if (typeof entry === 'string') return entry.trim().split(/\s+/);
  if (entry && typeof entry === 'object') return [entry.command, ...(entry.args ?? [])].map(String);
  return [];
}
function registeredTokens(config) {
  const tokens = new Set();
  for (const entry of config?.validate?.commands ?? []) {
    for (const token of entryArgv(entry)) tokens.add(token);
  }
  return tokens;
}

/** Enumerate the population FROM DISK, so a new member joins it automatically. */
function discoverPopulation() {
  let entries = [];
  try {
    entries = readdirSync(join(repoRoot, POPULATION_DIR_REL));
  } catch (e) {
    fail('population', `could not read ${POPULATION_DIR_REL}: ${e?.message ?? e}`);
    return { members: [], strays: [] };
  }
  return {
    members: entries.filter(inPopulation).sort().map((n) => `${POPULATION_DIR_REL}/${n}`),
    // family members the predicate rejects that are NOT build sidecars: an
    // artifact sitting between the declared population and nothing at all.
    strays: entries.filter((n) => inFamily(n) && !inPopulation(n) && !isBuildSidecar(n))
      .sort().map((n) => `${POPULATION_DIR_REL}/${n}`),
  };
}

/**
 * THE CLASSIFIER (run over the real population AND over mutated ones below, so a
 * clean bill of health cannot be vacuous).
 */
function classify(population, registered, exclusions) {
  return {
    registered: population.filter((p) => registered.has(p)),
    excluded: population.filter((p) => !registered.has(p) && exclusions.has(p)),
    undecided: population.filter((p) => !registered.has(p) && !exclusions.has(p)),
    wronglyRegistered: [...exclusions.keys()].filter((p) => registered.has(p)),
  };
}

/** THE EXCLUSION AUDIT (likewise re-run over a synthetic map below). */
function auditExclusions(population, exclusions) {
  return {
    stale: [...exclusions.keys()].filter((p) => !population.includes(p)),
    unreasoned: [...exclusions.entries()]
      .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length < MIN_EXCLUSION_REASON_CHARS)
      .map(([p]) => p),
  };
}

const configRaw = readFileSync(CONFIG_PATH, 'utf8');
const config = JSON.parse(configRaw);
if (!Array.isArray(config?.validate?.commands) || config.validate.commands.length === 0) {
  console.error('red-w2c-validate-registration: proof-or-stop.config.json must declare a non-empty validate.commands array');
  process.exit(1);
}

const { members: population, strays } = discoverPopulation();
const realTokens = registeredTokens(config);
const real = classify(population, realTokens, REGISTRATION_EXCLUSIONS);

// ── 1. The population is real. An empty one would make everything below pass
//       vacuously, which is the failure mode this rewrite exists to remove. ───
if (population.length === 0) {
  fail('population', `no ${POPULATION_DIR_REL}/${FAMILY_PREFIX}* member found on disk, so every check below would pass vacuously`);
}

// ── 2. THE RULE: every member is registered or explicitly excluded. ──────────
if (real.undecided.length > 0) {
  fail('registration',
    `these ${POPULATION_DIR_REL}/${FAMILY_PREFIX}* members are NEITHER registered in proof-or-stop.config.json `
    + `validate.commands NOR listed in REGISTRATION_EXCLUSIONS with a reason, so \`proof-or-stop validate\` never runs them `
    + `and nobody decided that it should not: ${real.undecided.join(', ')}. Register it, or exclude it here and say why.`);
}
if (real.wronglyRegistered.length > 0) {
  fail('registration', `these are BOTH excluded here and registered in validate.commands — the two records disagree: ${real.wronglyRegistered.join(', ')}`);
}

// ── 3. The family boundary hides nothing: a red-evidence artifact that is not a
//       build sidecar must be inside the declared population. ────────────────
if (strays.length > 0) {
  fail('population',
    `these ${FAMILY_PREFIX}* artifacts are neither inside the declared population nor build sidecars, so they fall `
    + `between this guard and the sibling that governs ${SIBLING_DIR_REL}: ${strays.join(', ')}`);
}

// ── 4. The exclusion list must describe the tree it is on. ───────────────────
const audit = auditExclusions(population, REGISTRATION_EXCLUSIONS);
if (audit.stale.length > 0) {
  fail('exclusion', `REGISTRATION_EXCLUSIONS names files that are not in the population, so the carve-out is stale: ${audit.stale.join(', ')}`);
}
if (audit.unreasoned.length > 0) {
  fail('exclusion', `these exclusions do not state a reason of at least ${MIN_EXCLUSION_REASON_CHARS} characters: ${audit.unreasoned.join(', ')}`);
}

// NON-VACUITY of the audit itself: with an empty real map both arms above are
// unexercised, so run the SAME auditor over a synthetic map that is stale in one
// entry and unreasoned in the other. It must flag exactly those.
const SYNTHETIC_STALE = `${POPULATION_DIR_REL}/${FAMILY_PREFIX}deleted-last-week.js`;
const syntheticPresent = population[0] ?? `${POPULATION_DIR_REL}/${FAMILY_PREFIX}placeholder.js`;
const syntheticAudit = auditExclusions(population, new Map([
  [SYNTHETIC_STALE, 'a reason comfortably longer than the minimum length this auditor requires'],
  [syntheticPresent, 'too short'],
]));
if (!syntheticAudit.stale.includes(SYNTHETIC_STALE) || !syntheticAudit.unreasoned.includes(syntheticPresent)) {
  fail('exclusion',
    'the exclusion auditor did not flag a synthetic stale entry and a synthetic unreasoned entry, so an exclusion naming '
    + 'a file that no longer exists — or carrying no reason at all — would not be caught');
}

// ── 5. NON-VACUITY of the classifier: a newcomer nobody listed must land in
//       `undecided`, and de-registering ANY current entry must be detected. ──
const SYNTHETIC_NEWCOMER = `${POPULATION_DIR_REL}/${FAMILY_PREFIX}synthetic-newcomer.js`;
if (!classify([...population, SYNTHETIC_NEWCOMER], realTokens, REGISTRATION_EXCLUSIONS).undecided.includes(SYNTHETIC_NEWCOMER)
  || !inPopulation(`${FAMILY_PREFIX}synthetic-newcomer.js`)) {
  fail('registration', 'the classifier did not place an unregistered, unexcluded newcomer in `undecided`, so it cannot detect the case it exists for');
}
const undetected = [];
for (const script of real.registered) {
  const mutated = JSON.parse(configRaw);
  mutated.validate.commands = mutated.validate.commands.filter((entry) => !entryArgv(entry).includes(script));
  if (mutated.validate.commands.length === config.validate.commands.length
    || !classify(population, registeredTokens(mutated), REGISTRATION_EXCLUSIONS).undecided.includes(script)) {
    undetected.push(script);
  }
}
if (undetected.length > 0) {
  fail('registration', `de-registering these would NOT be detected by this committed test, so it is vacuous for them: ${undetected.join(', ')}`);
}

// ── 6. Every registered dist task entry has its committed TypeScript source, so
//       a typo'd / dangling registration path is caught as well. ─────────────
const danglingSources = [];
for (const entry of config.validate.commands) {
  for (const token of entryArgv(entry)) {
    const m = /^packages\/main\/dist\/(.+)\.js$/.exec(token);
    if (!m) continue;
    if (!existsSync(join(pkgRoot, 'src', `${m[1]}.ts`))) danglingSources.push(token);
  }
}
if (danglingSources.length > 0) {
  fail('registration', `these validate.commands entries have no committed packages/main/src/**.ts source (typo'd or dangling registration): ${danglingSources.join(', ')}`);
}

// ── 7. The two populations are disjoint, both are owned, and this file is
//       inside the OTHER one with no self-exception. ────────────────────────
if (POPULATION_DIR_REL === SIBLING_DIR_REL
  || POPULATION_DIR_REL.startsWith(`${SIBLING_DIR_REL}/`)
  || SIBLING_DIR_REL.startsWith(`${POPULATION_DIR_REL}/`)) {
  fail('boundary', `the two declared populations are not disjoint: ${POPULATION_DIR_REL} vs ${SIBLING_DIR_REL}`);
}
if (!existsSync(join(repoRoot, SIBLING_GUARD_REL))) {
  fail('boundary',
    `${SIBLING_GUARD_REL} is missing, so nothing governs ${SIBLING_DIR_REL}/* and every harness there would be `
    + 'unregistered with no guard to say so — the exact gap this pair of guards exists to close');
}
if (!SELF_REL.startsWith(`${SIBLING_DIR_REL}/`)) {
  fail('boundary',
    `this guard lives at ${SELF_REL}, which is outside ${SIBLING_DIR_REL}/ and therefore outside BOTH declared `
    + 'populations: it would be the one file no guard governs');
}

if (failures.length > 0) {
  console.error(`\nred-w2c-validate-registration: ${failures.length} check(s) failed`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(
  `red-w2c-validate-registration: OK (all ${population.length} ${POPULATION_DIR_REL}/${FAMILY_PREFIX}* members found `
  + `ON DISK are accounted for: ${real.registered.length} registered in proof-or-stop.config.json validate.commands — `
  + `including the ${FAMILY_PREFIX}chain-smoke.js convergence anchor — and ${real.excluded.length} excluded with a `
  + 'stated reason, with no stray family artifact outside the population. The expectation is DERIVED from the '
  + 'directory rather than hardcoded, so a member added without a registration decision FAILS this check; proven '
  + `non-vacuous per registered entry, against a synthetic newcomer and against a synthetic stale/unreasoned `
  + `exclusion. ${SIBLING_DIR_REL}/* is governed by ${SIBLING_GUARD_REL}, which exists and which governs this file `
  + 'too — no self-exception)',
);
