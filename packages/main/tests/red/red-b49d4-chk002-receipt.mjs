#!/usr/bin/env node
/**
 * CHK-002 verification receipt (B-49d4).
 *
 * CHK-002's three verification intents are EXECUTABLE: per B-ec67 the tool
 * refuses a caller-authored "result: pass" and derives the verdict from a pinned
 * command's real output. This file is that pinned command.
 *
 * Every marker below is printed ONLY when its condition genuinely holds, and
 * every condition is MEASURED by spawning the two REAL shipped guards as child
 * processes. Nothing here imitates their enumeration: a simulation would let a
 * narrowed implementation pass the very check written to forbid it.
 *
 * ── THE TWO GUARDS AND THEIR DISJOINT POPULATIONS ───────────────────────────
 *
 *   guard 1  red-w2c-validate-registration.mjs   governs packages/main/dist/tasks/red-evidence-*
 *   guard 2  red-b49d4-harness-registration.mjs  governs packages/main/tests/red/*  (TOTAL enumeration)
 *
 * The populations are disjoint by directory and their union covers every member
 * of both. Both guard FILES live in `packages/main/tests/red/`, so both are
 * inside population 2: guard 2 governs guard 1 and governs itself, with no
 * self-exception. That is measured here by removing each guard's own
 * registration from a config COPY and requiring guard 2 to fail naming it.
 *
 * ── THE REAL proof-or-stop.config.json IS NEVER WRITTEN TO ────────────────────────
 *
 * CHK-003 owns registration. Every config mutation here happens on a COPY inside
 * a symlink mirror of the repository root, executed through
 * `--preserve-symlinks-main` so the REAL guard file runs while resolving its
 * repository root to the sandbox. The real file's sha256 is taken before
 * anything happens and re-checked at the end; the `basis=` field of the first
 * marker states plainly whether population 2 is decided by the REAL config
 * (after CHK-003) or only by the copy (before it).
 *
 * Run from anywhere:
 *   node packages/main/tests/red/red-b49d4-chk002-receipt.mjs
 */
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..');
const repoRoot = join(pkgRoot, '..', '..');

// B-cc10: resolve whichever config filename exists. The canonical name is now
// proof-or-stop.config.json, so a hardcoded deprecated name threw ENOENT here.
const CONFIG_REL = (['proof-or-stop.config.json', 'proof-or-stop.config.json'].find((n) => existsSync(join(repoRoot, n))) ?? 'proof-or-stop.config.json');
const CONFIG_PATH = join(repoRoot, CONFIG_REL);
const RED_DIR_REL = 'packages/main/tests/red';
const DIST_TASKS_REL = 'packages/main/dist/tasks';

const GUARD1_REL = `${RED_DIR_REL}/red-w2c-validate-registration.mjs`;
const GUARD2_REL = `${RED_DIR_REL}/red-b49d4-harness-registration.mjs`;

/** Probes: planted, measured, removed. Swept before and after in case a run was killed. */
const DIST_PROBE_REL = `${DIST_TASKS_REL}/red-evidence-chk002-receipt-probe.js`;
/** No `red-` prefix and not even `.mjs`: only a TOTAL enumeration can see it. */
const RED_PROBE_REL = `${RED_DIR_REL}/chk002-receipt-probe-unprefixed.harness`;
const PROBES = [DIST_PROBE_REL, RED_PROBE_REL];
const sweep = () => { for (const rel of PROBES) rmSync(join(repoRoot, rel), { force: true }); };

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const DIGEST_BEFORE = sha256(readFileSync(CONFIG_PATH));
const configRaw = readFileSync(CONFIG_PATH, 'utf8');

const entryArgv = (e) => {
  if (typeof e === 'string') return e.trim().split(/\s+/);
  if (e && typeof e === 'object') return [e.command, ...(e.args ?? [])].map(String);
  return [];
};
const tokensOf = (cfg) => new Set((cfg?.validate?.commands ?? []).flatMap(entryArgv));

/** The two receipts guard 2 excludes; read from guard 2 itself so this file keeps no second copy. */
const guard2Source = readFileSync(join(repoRoot, GUARD2_REL), 'utf8');
const EXCLUDED = [...guard2Source.matchAll(/\[`\$\{POPULATION_DIR_REL\}\/([^`]+)`,/g)]
  .map((m) => `${RED_DIR_REL}/${m[1]}`);

// ── disk enumerations, done independently of the guards so the guards' reported
//    population sizes can be cross-checked against them ───────────────────────
const isSidecar = (n) => n.endsWith('.map') || n.endsWith('.d.ts');
const redEntries = () => readdirSync(join(repoRoot, RED_DIR_REL)).sort();
const distFamily = () => readdirSync(join(repoRoot, DIST_TASKS_REL))
  .filter((n) => n.startsWith('red-evidence-') && /\.(?:js|cjs|mjs)$/.test(n) && !isSidecar(n)).sort();

/** The registration CHK-003 is expected to apply, computed from disk at call time. */
function completeConfig(omit = []) {
  const cfg = JSON.parse(configRaw);
  const known = tokensOf(cfg);
  for (const name of redEntries()) {
    const rel = `${RED_DIR_REL}/${name}`;
    if (known.has(rel) || EXCLUDED.includes(rel)) continue;
    cfg.validate.commands.push({ command: 'node', args: [rel], timeoutMs: 180000 });
  }
  cfg.validate.commands = cfg.validate.commands.filter((e) => !entryArgv(e).some((t) => omit.includes(t)));
  return cfg;
}

const parseGuard1 = (out) => {
  const m = /all (\d+) \S+ members found ON DISK are accounted for: (\d+) registered/.exec(out);
  const x = /and (\d+) excluded with a stated reason/.exec(out);
  return m === null || x === null ? null : { population: Number(m[1]), registered: Number(m[2]), excluded: Number(x[1]) };
};
const parseGuard2 = (out) => {
  const m = /all (\d+) entries of \S+ found ON DISK are accounted for: (\d+) registered in proofOrStop\.config\.json validate\.commands and (\d+) excluded/.exec(out);
  return m === null ? null : { population: Number(m[1]), registered: Number(m[2]), excluded: Number(m[3]) };
};

sweep();

let sandbox = null;
let M = null;
try {
  sandbox = mkdtempSync(join(tmpdir(), 'red-b49d4-chk002-'));
  for (const entry of readdirSync(repoRoot)) {
    if (entry === CONFIG_REL) continue;
    symlinkSync(join(repoRoot, entry), join(sandbox, entry));
  }
  const sandboxConfig = join(sandbox, CONFIG_REL);
  const writeConfig = (cfg) => writeFileSync(sandboxConfig, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  /** Run the REAL guard file, resolving ITS repository root to the sandbox. */
  const runSandbox = (guardRel) => {
    const r = spawnSync(process.execPath, ['--preserve-symlinks-main', join(sandbox, guardRel)], { cwd: sandbox, encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const runReal = (guardRel) => {
    const r = spawnSync(process.execPath, [join(repoRoot, guardRel)], { cwd: repoRoot, encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  const diskRed = redEntries();
  const diskDist = distFamily();

  // ── 1. both populations decided, nothing between them ─────────────────────
  const g1Real = runReal(GUARD1_REL);
  const g1RealCounts = parseGuard1(g1Real.out);

  const realTokens = tokensOf(JSON.parse(configRaw));
  const realDecidesRed = diskRed.every((n) => realTokens.has(`${RED_DIR_REL}/${n}`) || EXCLUDED.includes(`${RED_DIR_REL}/${n}`));
  writeConfig(realDecidesRed ? JSON.parse(configRaw) : completeConfig());
  const g2Complete = runSandbox(GUARD2_REL);
  const g2Counts = parseGuard2(g2Complete.out);

  // ── 2. the total enumeration sees an unprefixed, non-.mjs newcomer ────────
  writeFileSync(join(repoRoot, RED_PROBE_REL), '// planted by red-b49d4-chk002-receipt.mjs; delete if a run was killed\n', 'utf8');
  const g2Newcomer = runSandbox(GUARD2_REL);
  sweep();
  const g2Restored = runSandbox(GUARD2_REL);

  // ── 3. the bite, in both directions, for BOTH guards ──────────────────────
  writeFileSync(join(repoRoot, DIST_PROBE_REL), 'process.exit(3);\n', 'utf8');
  const g1Newcomer = runReal(GUARD1_REL);
  sweep();

  const g1Victim = diskDist.map((n) => `${DIST_TASKS_REL}/${n}`).find((rel) => realTokens.has(rel)) ?? null;
  writeConfig(completeConfig([g1Victim]));
  const g1Dereg = g1Victim === null ? { status: 0, out: '' } : runSandbox(GUARD1_REL);

  const g2Victim = diskRed.map((n) => `${RED_DIR_REL}/${n}`)
    .find((rel) => realTokens.has(rel) && rel !== GUARD1_REL && rel !== GUARD2_REL) ?? null;
  writeConfig(completeConfig([g2Victim]));
  const g2Dereg = g2Victim === null ? { status: 0, out: '' } : runSandbox(GUARD2_REL);

  // no self-exception: each guard's OWN registration removed, guard 2 must name it
  writeConfig(completeConfig([GUARD2_REL]));
  const g2Self = runSandbox(GUARD2_REL);
  writeConfig(completeConfig([GUARD1_REL]));
  const g1Governed = runSandbox(GUARD2_REL);

  M = {
    diskRed, diskDist, g1Real, g1RealCounts, g2Complete, g2Counts, realDecidesRed,
    g2Newcomer, g2Restored, g1Newcomer, g1Victim, g1Dereg, g2Victim, g2Dereg, g2Self, g1Governed,
  };
} finally {
  if (sandbox !== null) rmSync(sandbox, { recursive: true, force: true });
  sweep();
}

const configClean = sha256(readFileSync(CONFIG_PATH)) === DIGEST_BEFORE;
const probesGone = PROBES.every((rel) => !existsSync(join(repoRoot, rel)));
const measured = M !== null && configClean && probesGone;

// ════════════════════════════════════════════════════════════════════════════
// 1. happy — every member of BOTH declared populations is registered or
//    excluded, nothing is undecided, and nothing falls between the two.
// ════════════════════════════════════════════════════════════════════════════
const populationsDecided =
  measured
  // population 1, in the REAL config: complete today, and the guard's reported
  // population equals what an independent enumeration finds on disk
  && M.g1Real.status === 0 && M.g1RealCounts !== null
  && M.g1RealCounts.population === M.diskDist.length
  && M.g1RealCounts.registered + M.g1RealCounts.excluded === M.g1RealCounts.population
  // population 2: complete, with its reported population equal to the FULL
  // directory listing — no name pattern, no extension filter, nothing omitted
  && M.g2Complete.status === 0 && M.g2Counts !== null
  && M.g2Counts.population === M.diskRed.length
  && M.g2Counts.registered + M.g2Counts.excluded === M.g2Counts.population
  // nothing between them: the two directories are distinct and neither nests in
  // the other, and BOTH guard files are members of population 2, so each guard
  // is itself governed rather than exempt
  && DIST_TASKS_REL !== RED_DIR_REL
  && !DIST_TASKS_REL.startsWith(`${RED_DIR_REL}/`) && !RED_DIR_REL.startsWith(`${DIST_TASKS_REL}/`)
  && M.diskRed.includes('red-w2c-validate-registration.mjs')
  && M.diskRed.includes('red-b49d4-harness-registration.mjs');

if (populationsDecided) {
  console.log(
    'BOTH_POPULATIONS_DECIDED_NOTHING_BETWEEN (two guards with DISJOINT declared populations: '
    + `${DIST_TASKS_REL}/red-evidence-* — ${M.g1RealCounts.population} members on disk, `
    + `${M.g1RealCounts.registered} registered + ${M.g1RealCounts.excluded} excluded, 0 undecided, basis=REAL `
    + `${CONFIG_REL} — and ${RED_DIR_REL}/* — ${M.g2Counts.population} members on disk, `
    + `${M.g2Counts.registered} registered + ${M.g2Counts.excluded} excluded, 0 undecided, `
    + `basis=${M.realDecidesRed ? `REAL ${CONFIG_REL}` : `a config COPY carrying the registration CHK-003 owns; the real ${CONFIG_REL} is byte-unmodified here`}. `
    + 'Each guard\'s reported population size was cross-checked against an independent disk enumeration, so neither '
    + 'is reporting the size of its own expectation. The union covers every member: the two directories are distinct '
    + 'and neither nests in the other, and BOTH guard files are themselves members of the second population — guard 2 '
    + 'governs guard 1 and governs itself)',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 2. edge — the enumeration is unfiltered: a harness with NO `red-` prefix and
//    not even a `.mjs` extension is inside the population, not invisible to it.
// ════════════════════════════════════════════════════════════════════════════
const probeName = RED_PROBE_REL.slice(RED_DIR_REL.length + 1);
const newcomerSeen =
  measured
  && !/^red-/.test(probeName) && !probeName.endsWith('.mjs')
  // planting it flips the guard from pass to fail, and it is named
  && M.g2Complete.status === 0
  && M.g2Newcomer.status !== 0 && M.g2Newcomer.out.includes(RED_PROBE_REL)
  // and removing it flips the guard back, so the failure is attributable to the
  // newcomer alone rather than to anything else about the tree
  && M.g2Restored.status === 0;

if (newcomerSeen) {
  console.log(
    `TOTAL_ENUMERATION_SEES_AN_UNPREFIXED_NEWCOMER (${probeName} carries no red- prefix — the narrowing `
    + '/^red-b2aa7-.*\\.mjs$/ that the reference guard uses would miss it, and so would /^red-.*\\.mjs$/ or any '
    + 'other name pattern — and it is not even a .mjs, so an extension filter would miss it too. Its only '
    + `qualifying property is being an entry of ${RED_DIR_REL}, which is exactly what a TOTAL enumeration sees: `
    + `planting it flipped the real shipped guard from exit 0 to exit ${M.g2Newcomer.status} naming it, and removing `
    + 'it flipped the guard back to exit 0, so the failure is attributable to the newcomer alone)',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 3. adversarial — the bite is OBSERVED in both directions for both guards, and
//    neither guard is exempt from the rule it enforces.
// ════════════════════════════════════════════════════════════════════════════
const biteObserved =
  measured
  // guard 1 — undecided newcomer, then a de-registered member
  && M.g1Real.status === 0
  && M.g1Newcomer.status !== 0 && M.g1Newcomer.out.includes(DIST_PROBE_REL)
  && M.g1Victim !== null && M.g1Dereg.status !== 0 && M.g1Dereg.out.includes(M.g1Victim)
  // guard 2 — undecided newcomer (above), then a de-registered member
  && M.g2Victim !== null && M.g2Dereg.status !== 0 && M.g2Dereg.out.includes(M.g2Victim)
  && M.g2Newcomer.status !== 0
  // no self-exception: removing guard 2's OWN registration makes guard 2 name
  // itself, and removing guard 1's makes guard 2 name guard 1
  && M.g2Self.status !== 0 && M.g2Self.out.includes(GUARD2_REL)
  && M.g1Governed.status !== 0 && M.g1Governed.out.includes(GUARD1_REL)
  // every mutation lived on a copy
  && configClean && probesGone;

if (biteObserved) {
  console.log(
    'BITE_OBSERVED_BOTH_DIRECTIONS_NO_SELF_EXCEPTION (guard 1: an unregistered, unexcluded member planted in '
    + `${DIST_TASKS_REL} made it exit ${M.g1Newcomer.status} naming the file, and de-registering ${M.g1Victim} from a `
    + `config COPY made it exit ${M.g1Dereg.status} naming it. Guard 2: an undecided newcomer made it exit `
    + `${M.g2Newcomer.status}, and de-registering ${M.g2Victim} made it exit ${M.g2Dereg.status} naming it. NO `
    + 'SELF-EXCEPTION, measured rather than argued: removing guard 2\'s own registration made guard 2 fail naming '
    + 'ITSELF, and removing guard 1\'s made guard 2 fail naming guard 1 — so the two files that enforce registration '
    + `are themselves registered subjects of it. Every mutation lived on a copy: the real ${CONFIG_REL} is `
    + `byte-identical (sha256 ${DIGEST_BEFORE.slice(0, 16)}… before and after) and every planted probe was removed)`,
  );
}
