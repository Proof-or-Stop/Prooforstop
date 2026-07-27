#!/usr/bin/env node
/**
 * Registration guard 2 of 2 (B-49d4, CHK-002) — POPULATION:
 * `packages/main/tests/red/*`, ENUMERATED UNFILTERED.
 *
 * ── WHAT WENT WRONG, AND WHY THE ENUMERATION HAS NO NAME PATTERN ────────────
 *
 * Thirty-three red harnesses are committed in this directory. `lattice validate`
 * ran thirteen of them. The other twenty were never registered and nothing said
 * so, because the only two guards that looked at registration each looked at a
 * NARROWER population than the one they appeared to protect:
 *
 *   - `red-w2c-validate-registration.mjs` compared the config against a
 *     hardcoded three-entry array and reported the size of that array.
 *   - `red-b2aa7-chk007-receipt.mjs` DOES derive its population from disk — the
 *     right shape — but through `/^red-b2aa7-.*\.mjs$/`. Everything named
 *     otherwise is outside its population and therefore invisible to it.
 *
 * Copying that filter one prefix over is the single most likely way to ship a
 * hollow fix here: the guard would pass, report complete coverage, and be blind
 * to the very next harness whose name does not match. So this file's membership
 * predicate is TOTAL — every directory entry is a member, whatever it is called
 * and whatever extension it carries. There is no name pattern to go stale, and
 * `POPULATION_IS_TOTAL` below asserts that the enumeration filtered nothing out.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * Every member is EITHER registered in `lattice.config.json` `validate.commands`
 * OR listed in REGISTRATION_EXCLUSIONS with a stated reason. Nothing may be
 * silently neither: an unregistered, unexcluded member lands in `undecided` and
 * this guard FAILS naming it. Silent absence is indistinguishable from an
 * oversight, which is how twenty harnesses accumulated.
 *
 * The registered side is NEVER enumerated in this file — it is whatever the
 * config actually contains, read live — so no list here can go stale and a new
 * harness is undecided until somebody decides. "It is spawned as a child by
 * something registered" is not a third state: it is a REASON, and it belongs in
 * an exclusion entry where a reader can see it.
 *
 * Exclusions are audited on every run: an entry naming a file that is not in the
 * population FAILS (a stale carve-out silently widens itself), an entry without
 * a real reason FAILS, and an entry that is also registered FAILS because the two
 * records disagree.
 *
 * ── SELF-INCLUSION AND THE SIBLING POPULATION ───────────────────────────────
 *
 * This file is a `*.mjs` in this directory, so it is inside its own population
 * with NO self-exception, and it fails if it ever appears in its own exclusion
 * map. A carve-out is exactly the exemption B-49d4 exists to remove.
 *
 * The other population — `packages/main/dist/tasks/red-evidence-*` — is governed
 * by SIBLING_GUARD_REL, which must exist. The two declared populations are
 * disjoint by directory (asserted here) and each guard witnesses the other, so
 * deleting either one is caught by the survivor instead of quietly reopening the
 * gap.
 *
 * NOTE FOR WHOEVER EDITS THIS FILE: the B-49d4 derivation artifact chooses which
 * guards to spawn by skipping any file that mentions it by name, so naming it
 * here would silently remove this guard from that check. Register it in the
 * config; do not exclude it here.
 *
 * Run from anywhere:
 *   node packages/main/tests/red/red-b49d4-harness-registration.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative, sep } from 'node:path';

const SELF_ABS = fileURLToPath(import.meta.url);
const here = dirname(SELF_ABS);
const pkgRoot = join(here, '..', '..'); // packages/main
const repoRoot = join(pkgRoot, '..', '..');
const CONFIG_PATH = join(repoRoot, 'lattice.config.json');
const SELF_REL = relative(repoRoot, SELF_ABS).split(sep).join('/');

/** POPULATION 2 — governed by this file. */
const POPULATION_DIR_REL = 'packages/main/tests/red';

/** POPULATION 1 — governed by the sibling guard, which must exist. */
const SIBLING_DIR_REL = 'packages/main/dist/tasks';
const SIBLING_GUARD_REL = `${POPULATION_DIR_REL}/red-w2c-validate-registration.mjs`;

const failures = [];
const fail = (check, why) => failures.push(`${check}: ${why}`);

/**
 * MEMBERSHIP IS TOTAL. Not `/^red-.*\.mjs$/`, not `*.mjs`, not any pattern: every
 * entry of the directory is a member. A file that needs no registration needs an
 * exclusion saying so, which is a decision somebody made and a reader can audit.
 */
const isMember = () => true;

/**
 * Exclusions are DATA and each entry must state WHY.
 *
 * The two pre-fix receipts below gate every marker they print on BLOCK A of
 * `red-b2aa7-artifact-validation.mjs` still being RED, so on the finished tree
 * they print nothing and exit 0. Registering them would add validate commands
 * that pass forever while asserting nothing — a vacuous check masquerading as
 * coverage, which is the defect class this story exists to remove.
 */
const REGISTRATION_EXCLUSIONS = new Map([
  [`${POPULATION_DIR_REL}/red-b2aa7-chk001-receipt.mjs`,
    'PRE-FIX attestation. Every marker is gated on BLOCK A of red-b2aa7-artifact-validation.mjs still being RED '
    + '(run.status !== 0 plus redCount === total), so on the finished tree it prints nothing and exits 0. Registering '
    + 'it would add a validate command that passes forever while asserting nothing. red-b2aa7-chk007-receipt.mjs, '
    + 'which IS registered, spawns it and enforces both this exclusion and its silence.'],
  [`${POPULATION_DIR_REL}/red-b2aa7-chk010-receipt.mjs`,
    'PRE-FIX attestation. Same BLOCK A gate applied through its own preFixTree guard, so it is likewise silent and '
    + 'exits 0 on the finished tree. Registering it would add a second vacuous validate command. Also spawned and '
    + 'enforced by red-b2aa7-chk007-receipt.mjs.'],
]);

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

/** Enumerate the population FROM DISK, unfiltered, so a newcomer joins it automatically. */
const rawEntries = readdirSync(here).sort();
const population = rawEntries.filter(isMember).map((name) => `${POPULATION_DIR_REL}/${name}`);
const isDirectory = (rel) => {
  try {
    return statSync(join(repoRoot, rel)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * THE CLASSIFIER (run over the real population AND over mutated ones below, so a
 * clean bill of health cannot be vacuous).
 */
function classify(pop, registered, exclusions) {
  return {
    registered: pop.filter((p) => registered.has(p)),
    excluded: pop.filter((p) => !registered.has(p) && exclusions.has(p)),
    undecided: pop.filter((p) => !registered.has(p) && !exclusions.has(p)),
    wronglyRegistered: [...exclusions.keys()].filter((p) => registered.has(p)),
  };
}

/** THE EXCLUSION AUDIT (likewise re-run over a synthetic map below). */
function auditExclusions(pop, exclusions) {
  return {
    stale: [...exclusions.keys()].filter((p) => !pop.includes(p)),
    unreasoned: [...exclusions.entries()]
      .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length < MIN_EXCLUSION_REASON_CHARS)
      .map(([p]) => p),
  };
}

const configRaw = readFileSync(CONFIG_PATH, 'utf8');
const config = JSON.parse(configRaw);
if (!Array.isArray(config?.validate?.commands) || config.validate.commands.length === 0) {
  console.error('red-b49d4-harness-registration: lattice.config.json must declare a non-empty validate.commands array');
  process.exit(1);
}

const realTokens = registeredTokens(config);
const real = classify(population, realTokens, REGISTRATION_EXCLUSIONS);

// ── 1. The enumeration filtered NOTHING out. ────────────────────────────────
if (population.length !== rawEntries.length || population.length === 0) {
  fail('population',
    `the enumeration of ${POPULATION_DIR_REL} is not total: ${rawEntries.length} entries on disk but `
    + `${population.length} members. A name pattern here is what lets a differently-named harness sit outside the `
    + 'population while this guard reports complete coverage');
}

// ── 2. THE RULE: every member is registered or explicitly excluded. ──────────
if (real.undecided.length > 0) {
  const describe = (rel) => (isDirectory(rel) ? `${rel} (a DIRECTORY — a flat enumeration cannot see harnesses inside it)` : rel);
  fail('registration',
    `these ${POPULATION_DIR_REL} members are NEITHER registered in lattice.config.json validate.commands NOR listed `
    + `in REGISTRATION_EXCLUSIONS with a reason, so \`lattice validate\` never runs them and nobody decided that it `
    + `should not: ${real.undecided.map(describe).join(', ')}. Register the harness, or exclude it here and say why.`);
}
if (real.wronglyRegistered.length > 0) {
  fail('registration', `these are BOTH excluded here and registered in validate.commands — the two records disagree: ${real.wronglyRegistered.join(', ')}`);
}

// ── 3. The exclusion list must describe the tree it is on. ───────────────────
const audit = auditExclusions(population, REGISTRATION_EXCLUSIONS);
if (audit.stale.length > 0) {
  fail('exclusion',
    `REGISTRATION_EXCLUSIONS names files that are not in the population, so the carve-out is stale and silently `
    + `widened: ${audit.stale.join(', ')}`);
}
if (audit.unreasoned.length > 0) {
  fail('exclusion', `these exclusions do not state a reason of at least ${MIN_EXCLUSION_REASON_CHARS} characters: ${audit.unreasoned.join(', ')}`);
}

// NON-VACUITY of the audit: the SAME auditor must flag a synthetic map that is
// stale in one entry and unreasoned in the other.
const SYNTHETIC_STALE = `${POPULATION_DIR_REL}/red-b49d4-deleted-last-week.mjs`;
const syntheticPresent = population[0];
const syntheticAudit = auditExclusions(population, new Map([
  [SYNTHETIC_STALE, 'a reason comfortably longer than the minimum length this auditor requires'],
  [syntheticPresent, 'too short'],
]));
if (!syntheticAudit.stale.includes(SYNTHETIC_STALE) || !syntheticAudit.unreasoned.includes(syntheticPresent)) {
  fail('exclusion',
    'the exclusion auditor did not flag a synthetic stale entry and a synthetic unreasoned entry, so an exclusion '
    + 'naming a file that no longer exists — or carrying no reason at all — would not be caught');
}

// ── 4. NON-VACUITY of the classifier, in BOTH directions. ───────────────────
// (a) An undecided NEWCOMER. Deliberately named without the `red-` prefix and
//     without the `.mjs` extension: a derivation narrowed by ANY name pattern
//     would leave it outside the population, which is the defect one prefix over.
const SYNTHETIC_NEWCOMER = `${POPULATION_DIR_REL}/newcomer-with-no-red-prefix.harness`;
if (!classify([...population, SYNTHETIC_NEWCOMER], realTokens, REGISTRATION_EXCLUSIONS).undecided.includes(SYNTHETIC_NEWCOMER)
  || !isMember(basename(SYNTHETIC_NEWCOMER))) {
  fail('registration',
    'the classifier did not place an unregistered, unexcluded newcomer in `undecided`, so it cannot detect the case '
    + 'it exists for');
}
// (b) A DE-REGISTERED member: strip each registered entry from an in-memory copy
//     of the real config and prove the SAME classifier moves it to `undecided`.
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

// ── 5. Self-inclusion, disjointness, and the sibling population's owner. ────
if (!population.includes(SELF_REL)) {
  fail('boundary', `${SELF_REL} is not inside its own derived population, so this guard would be exempt from the rule it enforces`);
}
if (REGISTRATION_EXCLUSIONS.has(SELF_REL)) {
  fail('boundary', `${SELF_REL} excludes ITSELF; a self-carve-out is exactly the exemption this guard exists to remove`);
}
if (POPULATION_DIR_REL === SIBLING_DIR_REL
  || POPULATION_DIR_REL.startsWith(`${SIBLING_DIR_REL}/`)
  || SIBLING_DIR_REL.startsWith(`${POPULATION_DIR_REL}/`)) {
  fail('boundary', `the two declared populations are not disjoint: ${POPULATION_DIR_REL} vs ${SIBLING_DIR_REL}`);
}
if (!existsSync(join(repoRoot, SIBLING_GUARD_REL))) {
  fail('boundary',
    `${SIBLING_GUARD_REL} is missing, so nothing governs the ${SIBLING_DIR_REL} red-evidence family and a member `
    + 'added there would be unregistered with no guard to say so');
}

if (failures.length > 0) {
  console.error(`\nred-b49d4-harness-registration: ${failures.length} check(s) failed`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(
  `red-b49d4-harness-registration: OK (all ${population.length} entries of ${POPULATION_DIR_REL} found ON DISK are `
  + `accounted for: ${real.registered.length} registered in lattice.config.json validate.commands and `
  + `${real.excluded.length} excluded with a stated reason. The enumeration is TOTAL — no name pattern, no extension `
  + 'filter — so a differently-prefixed newcomer is inside the population rather than invisible to it, and this file '
  + `is inside it too with no self-exception. Proven non-vacuous in both directions: an unregistered, unexcluded `
  + `newcomer lands in undecided, and de-registering any of the ${real.registered.length} registered entries is `
  + `detected. ${SIBLING_DIR_REL}/red-evidence-* is governed by ${SIBLING_GUARD_REL}, which exists)`,
);
