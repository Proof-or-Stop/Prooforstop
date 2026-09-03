#!/usr/bin/env node
/**
 * CHK-001 verification receipt (B-49d4).
 *
 * CHK-001's three verification intents are EXECUTABLE: per B-ec67 the tool
 * refuses a caller-authored "result: pass" and derives the verdict from a pinned
 * command's real output. This file is that pinned command.
 *
 * It cannot BE the RED artifact, because a repro-first RED artifact exits
 * NON-ZERO by design. So this receipt RUNS
 * `red-b49d4-registration-derivation.mjs` as a child process and derives each
 * marker from that run's real stdout/stderr and exit code — the same shape
 * `red-b2aa7-chk001-receipt.mjs` used. Every marker is printed ONLY when its
 * condition genuinely holds, so a failing condition yields no marker and the
 * pinned selector cannot match.
 *
 * ── FOR CHK-003 (REGISTRATION DECISION) ─────────────────────────────────────
 *
 * This receipt is a PRE-FIX attestation: every marker is gated on the RED
 * artifact still exiting non-zero. On a fixed tree the artifact exits 0, so this
 * file prints nothing and exits 0 — a command that would pass forever while
 * asserting nothing. It belongs on the EXCLUSION side with that reason recorded,
 * exactly like `red-b2aa7-chk001-receipt.mjs` and `red-b2aa7-chk010-receipt.mjs`.
 * It is nonetheless inside the population `red-b49d4-registration-derivation.mjs`
 * enumerates, with no self-exception, so the decision has to be made rather than
 * skipped.
 *
 * ── THIS FILE IS SPENT, AND ITS ROW IDS ARE HISTORICAL (F-005 / F-006) ──────
 *
 * Measured on the finished tree: exit 0, 0 bytes on stdout AND 0 bytes on
 * stderr. `ranToCompletion` below requires `run.status !== 0`, so NO marker here
 * can ever print again — the CHK-001 intents this file was pinned to cannot be
 * re-earned by it, and they were not repointed at some other command that passes
 * for a different reason. That is recorded as a permanent waiver on those
 * intents rather than papered over with a fresh green.
 *
 * The row IDs parsed below (`EVERY_RED_HARNESS_IS_RUN_BY_VALIDATE`,
 * `REACHABILITY_ARM_IS_LIVE`) are the PRE-FIX names and are deliberately left
 * as-is: they name what the artifact printed on the tree this file attests to.
 * The F-006 fix removed both rows, because the first reported textual mentions as
 * execution edges — it counted THIS file as "spawned by a registered command"
 * when nothing spawns it. Nothing should resurrect this parse against the
 * current artifact: its successor rows are `EVERY_RED_HARNESS_IS_REGISTERED_OR_
 * DECIDED` and `DECISION_ARM_IS_LIVE`, and they assert a different, weaker and
 * true claim (accounted for, not executed).
 *
 * Run from anywhere:
 *   node packages/main/tests/red/red-b49d4-chk001-receipt.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const RED_ARTIFACT = join(here, 'red-b49d4-registration-derivation.mjs');

const run = spawnSync(process.execPath, [RED_ARTIFACT], { encoding: 'utf8' });
const stdout = run.stdout ?? '';
const stderr = run.stderr ?? '';

// ── parse the RED artifact's own row report ─────────────────────────────────
const rows = new Map();
let current = null;
for (const line of stdout.split('\n')) {
  const head = /^\s*\[(RED|GREEN)\s*\]\s+(\S+)\s+\(BLOCK (\S+)\)\s*$/.exec(line);
  if (head) {
    current = { state: head[1], id: head[2], block: head[3], observed: '', required: '' };
    rows.set(current.id, current);
    continue;
  }
  if (!current) continue;
  const field = /^\s+(observed|required)\s*:\s*(.*)$/.exec(line);
  if (field) current[field[1]] = field[2];
}

const tally = /(\d+) RED \/ (\d+) GREEN of (\d+) rows/.exec(stdout);
const redCount = tally ? Number(tally[1]) : -1;
const greenCount = tally ? Number(tally[2]) : -1;
const total = tally ? Number(tally[3]) : -1;

const isRed = (id) => rows.get(id)?.state === 'RED';
const isGreen = (id) => rows.get(id)?.state === 'GREEN';
const observed = (id) => rows.get(id)?.observed ?? '';

// The artifact must have RUN to completion rather than crashed: a crash produces
// no tally, no rows and no closing diagnosis.
const ranToCompletion =
  run.status !== 0
  && total > 0 && redCount + greenCount === total && rows.size === total
  && /still exhibit the pre-fix defect/.test(stderr);

// ════════════════════════════════════════════════════════════════════════════
// 1. happy — the committed RED artifact runs on the pre-fix tree and FAILS, and
//    the failure is the red signal (its own row tally) rather than a crash in
//    the harness. All three demonstrations are witnessed live, each by its own
//    row: blindness, the expectation-sized success line, and the population.
// ════════════════════════════════════════════════════════════════════════════
const populationRow = observed('EVERY_RED_HARNESS_IS_RUN_BY_VALIDATE');
const populationNumbers = /(\d+) \*\.mjs on disk \(unfiltered\): (\d+) registered, (\d+) unregistered, of which (\d+) are spawned by a registered command \(([^)]*)\) and (\d+) are NEVER RUN/
  .exec(populationRow);

const failedAsRed =
  ranToCompletion
  && isRed('GUARD_DETECTS_UNREGISTERED_MEMBER')
  && isRed('SUCCESS_LINE_COUNTS_THE_POPULATION_NOT_THE_EXPECTATION')
  && isRed('EVERY_RED_HARNESS_IS_RUN_BY_VALIDATE')
  && populationNumbers !== null
  && Number(populationNumbers[6]) > 0
  // the numbers are DERIVED, so they must be internally consistent rather than
  // three constants that happen to be printed next to each other
  && Number(populationNumbers[2]) + Number(populationNumbers[3]) === Number(populationNumbers[1])
  && Number(populationNumbers[4]) + Number(populationNumbers[6]) === Number(populationNumbers[3])
  // and the guard's confident success line really did under-report the population
  && /largest count in the success line=(\d+) while (\d+) members exist on disk/.test(observed('SUCCESS_LINE_COUNTS_THE_POPULATION_NOT_THE_EXPECTATION'))
  // proven against a mutated input, and this file's own subject is inside its population
  && isGreen('DERIVATION_IS_NON_VACUOUS')
  && isGreen('SELF_IS_INSIDE_THE_POPULATION')
  && isGreen('REACHABILITY_ARM_IS_LIVE');

if (failedAsRed) {
  const [, popTotal, registered, unregistered, reached, reachedNames, unreached] = populationNumbers;
  const counts = /largest count in the success line=(\d+) while (\d+) members exist on disk/
    .exec(observed('SUCCESS_LINE_COUNTS_THE_POPULATION_NOT_THE_EXPECTATION'));
  console.log(
    `RED_ARTIFACT_FAILS_ON_PRE_FIX_TREE (exit=${run.status}; ${redCount}/${total} rows red with ${greenCount} green `
    + `controls; the guard exited 0 with an unregistered, non-zero-exiting member of its own population on disk and `
    + `its success line still counted ${counts[1]} of ${counts[2]}; DERIVED population: ${popTotal} tests/red/*.mjs `
    + `enumerated unfiltered = ${registered} registered + ${unregistered} unregistered, of which ${reached} are `
    + `spawned by a registered command (${reachedNames}) leaving ${unreached} that proof-or-stop validate NEVER runs)`,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 2. edge — the newcomer is differently prefixed AND is judged by the shipped
//    guards themselves. A simulation of anybody's enumeration written inside the
//    artifact would let a narrowed implementation pass, so the marker requires
//    that real committed guard files were spawned as child processes, each with
//    a measured exit code, and that at least one of them derives its own
//    population from disk (i.e. the narrowing is what was defeated, not merely
//    the absence of any guard).
// ════════════════════════════════════════════════════════════════════════════
const newcomerRow = observed('DIFFERENTLY_PREFIXED_NEWCOMER_IS_INSIDE_THE_POPULATION');
const targetsRow = observed('NEWCOMER_TARGETS_ARE_REAL_SHIPPED_GUARDS');
const newcomerName = /packages\/main\/tests\/red\/(\S+\.mjs) planted/.exec(newcomerRow)?.[1] ?? null;
const spawnedTargets = [...targetsRow.matchAll(/(\S+\.mjs)\(exit=(-?\d+), (\d+)ms\)/g)]
  .map((m) => ({ name: m[1], exit: Number(m[2]), ms: Number(m[3]) }));

const newcomerDrivesRealGuards =
  ranToCompletion
  && isRed('DIFFERENTLY_PREFIXED_NEWCOMER_IS_INSIDE_THE_POPULATION')
  && isGreen('NEWCOMER_TARGETS_ARE_REAL_SHIPPED_GUARDS')
  && newcomerName !== null
  // differently prefixed: not red-b2aa7-*, not red-w2c-*, and in fact not red-* at all,
  // so a derivation narrowed by ANY of those patterns fails this artifact
  && !/^red-/.test(newcomerName)
  // real shipped guards were spawned, not simulated: each ran as a child process
  && spawnedTargets.length >= 2
  && spawnedTargets.every((t) => t.ms > 0)
  && spawnedTargets.some((t) => t.name === 'red-w2c-validate-registration.mjs')
  // including the reference derived-from-disk guard, whose narrowing is thereby measured
  && spawnedTargets.some((t) => t.name === 'red-b2aa7-chk007-receipt.mjs')
  && /guards that caught it: NONE/.test(newcomerRow);

if (newcomerDrivesRealGuards) {
  console.log(
    `DIFFERENTLY_PREFIXED_NEWCOMER_DRIVES_REAL_GUARDS (${newcomerName} carries neither the red-b2aa7- nor the `
    + 'red-w2c- prefix — nor any red- prefix — so only an UNFILTERED enumeration can see it; it was judged by '
    + `spawning ${spawnedTargets.length} REAL committed guards as child processes rather than by any simulation `
    + `written in the artifact (${spawnedTargets.map((t) => `${t.name} exit=${t.exit} in ${t.ms}ms`).join('; ')}), `
    + 'and NONE of them caught it — including red-b2aa7-chk007-receipt.mjs, which does derive its population from '
    + 'disk but through /^red-b2aa7-.*\\.mjs$/, the narrowing this artifact exists to forbid)',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 3. adversarial — blindness could have been a broken experiment, so the control
//    direction is asserted too: a de-registration against a COPY of the config
//    DOES make the same guard fail. And the copy really was a copy: the sandbox
//    is proven to redirect the read, and the real proof-or-stop.config.json is
//    byte-identical afterwards by sha256 and clean by git status.
// ════════════════════════════════════════════════════════════════════════════
const controlRow = observed('CONTROL_DEREGISTRATION_BITES');
const configRow = observed('REAL_CONFIG_BYTE_UNMODIFIED');
const victim = /removed (\S+) \((\d+) → (\d+) commands\)/.exec(controlRow);
const digests = /sha256 before=([0-9a-f]+)… after=([0-9a-f]+)…/.exec(configRow);

const controlBitesOnACopy =
  ranToCompletion
  // the guard IS capable of failing …
  && isGreen('CONTROL_DEREGISTRATION_BITES')
  && victim !== null && Number(victim[3]) === Number(victim[2]) - 1
  && /names the victim=true/.test(controlRow)
  // … and it passed in the same sandbox with an UNMUTATED copy, so the mutation
  //    is what failed it rather than the sandbox …
  && isGreen('SANDBOX_IS_FAITHFUL')
  // … and the sandbox provably redirected the config read, so a non-biting
  //    control could never have been mistaken for a healthy guard …
  && isGreen('SANDBOX_REDIRECTS_THE_CONFIG_READ')
  && isGreen('CONTROL_USED_A_COPY_NOT_THE_REAL_CONFIG')
  // … while the real config was never written to, and no probe survived.
  && isGreen('REAL_CONFIG_BYTE_UNMODIFIED')
  && digests !== null && digests[1] === digests[2]
  && /git status --porcelain -- proofOrStop\.config\.json => ""/.test(configRow)
  && isGreen('PROBES_CLEANED_UP')
  // the blindness run and the control run are the SAME guard, so the contrast is real
  && isGreen('GUARD_PASSES_ON_UNTOUCHED_TREE');

if (controlBitesOnACopy) {
  console.log(
    `CONTROL_BITES_ON_A_COPY_REAL_CONFIG_UNMODIFIED (de-registering ${victim[1]} from a COPY of proof-or-stop.config.json `
    + `(${victim[2]} → ${victim[3]} commands) made the SAME guard exit non-zero and name it, while an unmutated copy `
    + 'in the same sandbox still passed and an empty-commands copy still failed — so the sandbox provably redirected '
    + `the read and blindness is not a broken experiment; the real proof-or-stop.config.json is byte-identical `
    + `(sha256 ${digests[1]}… before and after), git status reports it clean, and every planted probe was removed)`,
  );
}
