#!/usr/bin/env node
/**
 * RED artifact (B-49d4, CHK-001) — the registration guard asserts a FIXED
 * allowlist instead of DERIVING its population, so it is structurally blind to
 * anything nobody put on the list, and `lattice validate` never runs 15 of the
 * red harnesses that are committed next to it.
 *
 * ── THE DEFECT'S UNUSUAL FAILURE MODE ───────────────────────────────────────
 *
 * The failure IS a confident success line, not an error.
 * `red-w2c-validate-registration.mjs` compares `lattice.config.json`
 * `validate.commands` against a hardcoded `REQUIRED_VALIDATE_COMMANDS` array of
 * three entries and then prints:
 *
 *   red-w2c-validate-registration: OK (... registers all 3 required
 *   red-evidence smokes ...)
 *
 * That "3" is `REQUIRED_VALIDATE_COMMANDS.length`. It is the size of the
 * EXPECTATION, never the size of the POPULATION. Add a fourth genuine member of
 * `packages/main/dist/tasks/red-evidence-*.js` and the number stays 3, the exit
 * code stays 0, and the guard reports complete coverage of a population it never
 * looked at. A check whose report cannot change when its subject changes cannot
 * ever reveal a gap.
 *
 * ── THIS FILE IS REPRO-FIRST: IT MUST FAIL ON THE PRE-FIX TREE ──────────────
 *
 * It exits NON-ZERO today. A RED artifact that passes before the fix proves
 * nothing. Every row below is printed as `[RED]` or `[GREEN]` from a MEASURED
 * observation — no row is a claim — and the process exits 1 while any row is
 * RED. On a correctly fixed tree every row goes GREEN and this file exits 0,
 * which is what makes it worth registering in `validate.commands`.
 *
 * ── THREE DEMONSTRATIONS, THREE ASSERTION SHAPES ────────────────────────────
 *
 *   A. BLINDNESS   A genuine member of the guard's OWN population is planted on
 *                  disk — `packages/main/dist/tasks/red-evidence-*.js` together
 *                  with its `packages/main/src/tasks/*.ts` counterpart, so it is
 *                  indistinguishable from a real member and cannot be dismissed
 *                  as stale build output. It is registered NOWHERE and it exits
 *                  NON-ZERO, so `lattice validate` would fail if it ran. The
 *                  REAL guard is then spawned. Two independent assertions:
 *                  (A1) it must not exit 0, and (A2) a confident success line
 *                  must never report fewer members than exist on disk. A1 is the
 *                  gap; A2 is WHY the gap can never be seen.
 *
 *   B. CONTROL     Blindness only means something if the guard is capable of
 *                  failing at all. A COPY of `lattice.config.json` with one
 *                  currently-listed command removed must make the guard exit
 *                  non-zero. The REAL config is never written to; its sha256 is
 *                  taken before anything happens and re-checked at the end, and
 *                  `git status --porcelain` on it must be empty. The sandbox is a
 *                  symlink mirror of the repository root with ONLY that one file
 *                  replaced, run through `--preserve-symlinks-main` so the
 *                  ACTUAL shipped guard file executes and resolves its root to
 *                  the sandbox. Two extra runs prove the sandbox itself:
 *                  an unmutated copy must still pass (faithful), and an
 *                  empty-commands copy must fail (the redirect really happened,
 *                  so a non-biting control can never be mistaken for a fine one).
 *
 *   C. POPULATION  How many `packages/main/tests/red/*.mjs` does `lattice
 *                  validate` never run? DERIVED, never hardcoded: enumerate the
 *                  directory UNFILTERED, subtract what `validate.commands`
 *                  registers, then subtract what is transitively REACHABLE from
 *                  a registered command (`red-b2aa7-chk007-receipt.mjs` spawns
 *                  the invariance harness and both pre-fix receipts, so those
 *                  three do get run). Whatever remains is coverage nobody has.
 *                  A number in a test goes stale; a derivation cannot.
 *
 * ── THE TRAP THIS FILE EXISTS TO CLOSE (BLOCK D) ────────────────────────────
 *
 * The obvious fix is to copy `red-b2aa7-chk007-receipt.mjs`, which DOES derive
 * its population from disk — but through `/^red-b2aa7-.*\.mjs$/`. Mirroring that
 * filter would leave a future differently-prefixed harness outside the
 * population and reproduce this very defect one prefix over. So BLOCK D plants a
 * newcomer named WITHOUT the `red-` prefix at all: its only qualifying property
 * is that it is an `*.mjs` file in `packages/main/tests/red/`, which is exactly
 * the population an unfiltered enumeration sees and exactly what any name
 * pattern narrows away.
 *
 * Crucially the newcomer is judged by SPAWNING REAL SHIPPED GUARDS — this file
 * contains no imitation of anybody's enumeration. A simulation written here
 * would let a narrowed implementation pass this test, which would defeat the
 * whole purpose. The targets are derived: the guard this story names, plus every
 * `*.mjs` in the red directory that reads `lattice.config.json` AND enumerates a
 * directory (i.e. anything that decides registration by looking). Today that set
 * also contains `red-b2aa7-chk007-receipt.mjs`, so its narrowed regex is
 * measured rather than argued about: it is a real shipped derived guard that
 * looks straight past this newcomer.
 *
 * ── SELF-INCLUSION ──────────────────────────────────────────────────────────
 *
 * The BLOCK C population is enumerated unfiltered, so THIS file and its receipt
 * are inside it with no self-exception; today they are part of what is counted
 * as never run. The only thing excluded anywhere is a spawn cycle: BLOCK D does
 * not spawn a file that spawns this one, which is a recursion break, not a
 * coverage carve-out.
 *
 * Run from anywhere:
 *   node packages/main/tests/red/red-b49d4-registration-derivation.mjs
 */
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..');            // packages/main
const repoRoot = join(pkgRoot, '..', '..');        // repository root
const SELF = basename(fileURLToPath(import.meta.url));

const RED_DIR_REL = 'packages/main/tests/red';
const DIST_TASKS_REL = 'packages/main/dist/tasks';
const SRC_TASKS_REL = 'packages/main/src/tasks';
const CONFIG_REL = 'lattice.config.json';
const CONFIG_PATH = join(repoRoot, CONFIG_REL);

/** The guard this story names. It is spawned as a REAL child process, never imitated. */
const GUARD_REL = `${RED_DIR_REL}/red-w2c-validate-registration.mjs`;
const GUARD_ABS = join(repoRoot, GUARD_REL);

/** The population the named guard governs: dist red-evidence tasks. */
const DIST_MEMBER_RE = /^red-evidence-.*\.js$/;

// ── probes ──────────────────────────────────────────────────────────────────
// Planted, measured, and removed. Names are fixed (not pid-suffixed) so the RED
// report is reproducible, and a sweep runs both before and after in case a
// previous run was killed.
const BLIND_BASE = 'red-evidence-b49d4-blindness-probe';
const BLIND_DIST_REL = `${DIST_TASKS_REL}/${BLIND_BASE}.js`;
const BLIND_SRC_REL = `${SRC_TASKS_REL}/${BLIND_BASE}.ts`;
/**
 * DELIBERATELY NOT `red-*`. The declared population is `*.mjs` in the red
 * directory; a `red-b49d4-*` name would still pass a derivation narrowed to
 * `/^red-.*\.mjs$/`, which is the same defect one prefix over.
 */
const NEWCOMER_BASE = 'b49d4-newcomer-probe-unprefixed.mjs';
const NEWCOMER_REL = `${RED_DIR_REL}/${NEWCOMER_BASE}`;
const PROBE_RELS = [BLIND_DIST_REL, BLIND_SRC_REL, NEWCOMER_REL];

const sweepProbes = () => {
  for (const rel of PROBE_RELS) rmSync(join(repoRoot, rel), { force: true });
};

// ── row reporting ───────────────────────────────────────────────────────────
const rows = [];
/** Measured side-notes that are not pass/fail rows of their own. */
const observations = [];
const row = (id, block, green, observed, required) => {
  rows.push({ id, block, green: green === true, observed, required });
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const clip = (s, n = 300) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * Integers that stand alone, so identifiers such as `b49d4` or `v1` cannot be
 * mistaken for a reported count.
 */
const standaloneIntegers = (text) => [...String(text).matchAll(/(?<![\w.-])(\d+)(?![\w.-])/g)]
  .map((m) => Number(m[1]));
const largestCount = (text) => {
  const ns = standaloneIntegers(text);
  return ns.length === 0 ? null : Math.max(...ns);
};

let spawnMs = 0;
function runNode(args, cwd = repoRoot) {
  const started = Date.now();
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  const ms = Date.now() - started;
  spawnMs += ms;
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    ms,
  };
}

// ── lattice.config.json is READ-ONLY here ───────────────────────────────────
const configBytes = readFileSync(CONFIG_PATH);
const CONFIG_DIGEST_BEFORE = sha256(configBytes);
const configRaw = configBytes.toString('utf8');
const config = JSON.parse(configRaw);

/** Normalize a validate.commands entry (bare string OR {command,args}) to its argv. */
function entryArgv(entry) {
  if (typeof entry === 'string') return entry.trim().split(/\s+/);
  if (entry && typeof entry === 'object') return [entry.command, ...(entry.args ?? [])].map(String);
  return [];
}
function registeredTokens(cfg) {
  const tokens = new Set();
  for (const entry of cfg?.validate?.commands ?? []) {
    for (const token of entryArgv(entry)) tokens.add(token);
  }
  return tokens;
}

const distMembers = () => readdirSync(join(repoRoot, DIST_TASKS_REL))
  .filter((n) => DIST_MEMBER_RE.test(n)).sort();

sweepProbes();

try {
  // ══════════════════════════════════════════════════════════════════════════
  // BLOCK 0 — the experiment's floor: the guard passes on the untouched tree.
  //           Without this, a RED result below could just be a broken tree.
  // ══════════════════════════════════════════════════════════════════════════
  const cleanDistPop = distMembers();
  const baseline = runNode([GUARD_ABS]);
  const baselineCount = largestCount(baseline.stdout);
  row(
    'GUARD_PASSES_ON_UNTOUCHED_TREE', '0',
    baseline.status === 0,
    `exit=${baseline.status} out="${clip(baseline.out, 200)}"`,
    'the guard must pass on the unmodified tree, or every RED row below is about a broken tree instead of about the guard',
  );
  row(
    'CLEAN_SUCCESS_LINE_COVERS_THE_POPULATION', '0',
    baseline.status !== 0 || baselineCount === null || baselineCount >= cleanDistPop.length,
    `largest count reported=${baselineCount} vs ${cleanDistPop.length} ${DIST_TASKS_REL}/red-evidence-*.js on disk`,
    'a success line must never claim fewer members than exist on disk',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // BLOCK A — BLINDNESS. A genuine, unregistered, non-zero-exiting member of
  //           the guard's OWN population leaves it at exit 0.
  // ══════════════════════════════════════════════════════════════════════════
  const probeBody = [
    '// PLANTED BY packages/main/tests/red/red-b49d4-registration-derivation.mjs (B-49d4 CHK-001).',
    '// A genuine member of the packages/main/dist/tasks/red-evidence-*.js population that is',
    '// registered NOWHERE in lattice.config.json validate.commands. It exits NON-ZERO, so if',
    '// `lattice validate` ran it, validate would fail. Nothing runs it, and nothing notices.',
    '// If you are reading this in a committed tree, a probe run was killed before cleanup: delete it.',
    "process.stderr.write('red-evidence-b49d4-blindness-probe: FAIL (unregistered member, deliberately non-zero)\\n');",
    'process.exit(3);',
    '',
  ].join('\n');
  writeFileSync(join(repoRoot, BLIND_DIST_REL), probeBody, 'utf8');
  writeFileSync(join(repoRoot, BLIND_SRC_REL), probeBody, 'utf8');

  const probeRun = runNode([join(repoRoot, BLIND_DIST_REL)]);
  row(
    'PLANTED_MEMBER_IS_LOAD_BEARING', 'A',
    probeRun.status !== 0 && existsSync(join(repoRoot, BLIND_SRC_REL)),
    `probe exit=${probeRun.status}, src counterpart present=${existsSync(join(repoRoot, BLIND_SRC_REL))}`,
    'the planted member must genuinely fail and must carry its src counterpart, so it is a real gap and not a stale build artifact',
  );

  const probeTokens = registeredTokens(config);
  row(
    'PLANTED_MEMBER_IS_REGISTERED_NOWHERE', 'A',
    !probeTokens.has(BLIND_DIST_REL),
    `${BLIND_DIST_REL} present in validate.commands=${probeTokens.has(BLIND_DIST_REL)}`,
    'the planted member must be absent from validate.commands, or the blindness question is not being asked',
  );

  const blinded = runNode([GUARD_ABS]);
  const withProbePop = distMembers();
  const reportedCount = largestCount(blinded.stdout);
  const successLine = blinded.stdout.split('\n').find((l) => l.trim() !== '') ?? '';

  row(
    'GUARD_DETECTS_UNREGISTERED_MEMBER', 'A',
    blinded.status !== 0 && blinded.out.includes(BLIND_BASE),
    `exit=${blinded.status}; names the probe=${blinded.out.includes(BLIND_BASE)}; `
    + `population on disk=${withProbePop.length} (${withProbePop.join(', ')})`,
    `the guard must fail and name ${BLIND_DIST_REL}: it is a member of the very population the guard reports on, `
    + 'it is registered nowhere, and it exits non-zero',
  );
  row(
    'SUCCESS_LINE_COUNTS_THE_POPULATION_NOT_THE_EXPECTATION', 'A',
    !(blinded.status === 0 && reportedCount !== null && reportedCount < withProbePop.length),
    `exit=${blinded.status}; largest count in the success line=${reportedCount} while ${withProbePop.length} members `
    + `exist on disk; line="${clip(successLine, 220)}"`,
    'a confident success line must never report fewer members than exist on disk — a count that cannot move when the '
    + 'population moves is the size of the expectation, which is why this guard can never reveal a gap',
  );

  sweepProbes();

  // ══════════════════════════════════════════════════════════════════════════
  // BLOCK B — CONTROL. De-register a currently-listed command against a COPY of
  //           the config and require the guard to bite. The real config is never
  //           written to (BLOCK E re-checks its digest).
  // ══════════════════════════════════════════════════════════════════════════
  const realTokens = registeredTokens(config);
  const victim = [...realTokens]
    .filter((t) => DIST_MEMBER_RE.test(basename(t)) && t.startsWith(`${DIST_TASKS_REL}/`))
    .sort()[0] ?? null;

  let sandboxRoot = null;
  try {
    sandboxRoot = mkdtempSync(join(tmpdir(), 'red-b49d4-control-'));
    // A faithful mirror: every repository-root entry symlinked, EXCEPT the one
    // file under test, which is a writable copy.
    for (const entry of readdirSync(repoRoot)) {
      if (entry === CONFIG_REL) continue;
      symlinkSync(join(repoRoot, entry), join(sandboxRoot, entry));
    }
    const sandboxConfig = join(sandboxRoot, CONFIG_REL);
    const sandboxGuard = join(sandboxRoot, GUARD_REL);
    // `--preserve-symlinks-main` keeps the main module's symlinked path, so the
    // REAL guard file executes yet resolves its repository root to the sandbox.
    const runSandbox = () => runNode(['--preserve-symlinks-main', sandboxGuard], sandboxRoot);

    // B1 — the sandbox is faithful: an unmutated copy still passes.
    writeFileSync(sandboxConfig, configRaw, 'utf8');
    const faithful = runSandbox();
    row(
      'SANDBOX_IS_FAITHFUL', 'B',
      faithful.status === 0,
      `exit=${faithful.status} out="${clip(faithful.out, 200)}"`,
      'with an UNMUTATED copy of the config the guard must still pass, or the sandbox — not the mutation — is what failed it',
    );

    // B2 — the redirect really happened: an empty command list must fail. This is
    //      what stops a non-biting control from being mistaken for a healthy one.
    const emptied = JSON.parse(configRaw);
    emptied.validate.commands = [];
    writeFileSync(sandboxConfig, `${JSON.stringify(emptied, null, 2)}\n`, 'utf8');
    const redirected = runSandbox();
    row(
      'SANDBOX_REDIRECTS_THE_CONFIG_READ', 'B',
      redirected.status !== 0,
      `with validate.commands=[] the guard exited ${redirected.status}: "${clip(redirected.out, 200)}"`,
      'the guard must fail when the copy it reads registers nothing; if it passes, it read the REAL config and the '
      + 'control below would prove nothing either way',
    );

    // B3 — the control proper: one currently-listed command removed.
    if (victim === null) {
      row('CONTROL_DEREGISTRATION_BITES', 'B', false,
        'no packages/main/dist/tasks/red-evidence-*.js entry found in validate.commands to de-register',
        'a currently-listed command must exist to serve as the control');
    } else {
      const mutated = JSON.parse(configRaw);
      const before = mutated.validate.commands.length;
      mutated.validate.commands = mutated.validate.commands
        .filter((entry) => !entryArgv(entry).includes(victim));
      writeFileSync(sandboxConfig, `${JSON.stringify(mutated, null, 2)}\n`, 'utf8');
      const control = runSandbox();
      row(
        'CONTROL_DEREGISTRATION_BITES', 'B',
        before > mutated.validate.commands.length
        && control.status !== 0 && control.out.includes(victim),
        `removed ${victim} (${before} → ${mutated.validate.commands.length} commands); exit=${control.status}; `
        + `names the victim=${control.out.includes(victim)}`,
        'de-registering a currently-listed command must make the guard exit non-zero AND name it, so the blindness '
        + 'result above cannot be a broken experiment',
      );
      row(
        'CONTROL_USED_A_COPY_NOT_THE_REAL_CONFIG', 'B',
        readFileSync(sandboxConfig, 'utf8') !== configRaw && sha256(readFileSync(CONFIG_PATH)) === CONFIG_DIGEST_BEFORE,
        `sandbox copy differs from the real file=${readFileSync(sandboxConfig, 'utf8') !== configRaw}; `
        + `real ${CONFIG_REL} sha256 still ${CONFIG_DIGEST_BEFORE.slice(0, 16)}…`,
        'the mutation must live in the copy while the real config stays byte-identical',
      );
    }
  } finally {
    if (sandboxRoot !== null) rmSync(sandboxRoot, { recursive: true, force: true });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BLOCK C — POPULATION. Derived, never hardcoded.
  // ══════════════════════════════════════════════════════════════════════════
  for (const rel of PROBE_RELS) {
    if (existsSync(join(repoRoot, rel))) throw new Error(`probe ${rel} still planted while deriving the population`);
  }

  /**
   * THE DERIVATION (run over the real config AND over a mutated copy below, so a
   * clean bill of health cannot be vacuous).
   *
   * Population: every `*.mjs` in the red directory, enumerated UNFILTERED — no
   * name pattern, because a pattern is what leaves a differently-prefixed
   * newcomer invisible.
   *
   * Reachable: a harness `lattice validate` never names directly can still be RUN
   * by something it does name — `red-b2aa7-chk007-receipt.mjs` spawns the
   * invariance harness and both pre-fix receipts. Reachability is followed
   * transitively from every registered command that exists on disk, by textual
   * reference to a population member's filename. That OVER-approximates (a name
   * in a comment counts), which can only SHRINK the unreached set — the
   * conservative direction for a claim that something is never run.
   */
  function derive(tokens) {
    const population = readdirSync(here).filter((n) => n.endsWith('.mjs')).sort();
    const registered = population.filter((n) => tokens.has(`${RED_DIR_REL}/${n}`));
    const roots = [...tokens].filter((t) => t.includes('/') && existsSync(join(repoRoot, t)));
    const reached = new Set();
    const seen = new Set(roots);
    const queue = [...roots];
    while (queue.length > 0) {
      const rel = queue.shift();
      let text = '';
      try {
        text = readFileSync(join(repoRoot, rel), 'utf8');
      } catch {
        continue;
      }
      for (const name of population) {
        if (name === basename(rel) || !text.includes(name)) continue;
        reached.add(name);
        const childRel = `${RED_DIR_REL}/${name}`;
        if (!seen.has(childRel)) {
          seen.add(childRel);
          queue.push(childRel);
        }
      }
    }
    const registeredSet = new Set(registered);
    const unregistered = population.filter((n) => !registeredSet.has(n));
    return {
      population,
      registered,
      unregistered,
      reachedUnregistered: unregistered.filter((n) => reached.has(n)),
      unreached: unregistered.filter((n) => !reached.has(n)),
    };
  }

  const derived = derive(realTokens);
  row(
    'EVERY_RED_HARNESS_IS_RUN_BY_VALIDATE', 'C',
    derived.unreached.length === 0,
    `${derived.population.length} *.mjs on disk (unfiltered): ${derived.registered.length} registered, `
    + `${derived.unregistered.length} unregistered, of which ${derived.reachedUnregistered.length} are spawned by a `
    + `registered command (${derived.reachedUnregistered.join(', ') || 'none'}) and ${derived.unreached.length} are `
    + `NEVER RUN: ${derived.unreached.join(', ') || 'none'}`,
    'every member of packages/main/tests/red/*.mjs must be registered in validate.commands or transitively reachable '
    + 'from something that is; a harness nobody runs is coverage nobody has',
  );
  row(
    'SELF_IS_INSIDE_THE_POPULATION', 'C',
    derived.population.includes(SELF),
    `${SELF} present in the derived population=${derived.population.includes(SELF)}`,
    'this file must be inside its own population with no self-exception; a carve-out is the exemption being removed',
  );
  row(
    'REACHABILITY_ARM_IS_LIVE', 'C',
    derived.reachedUnregistered.length > 0,
    `unregistered but spawned by a registered command: ${derived.reachedUnregistered.join(', ') || 'none'}`,
    'the reachability arm must actually classify something, or the unreached count is just "unregistered" wearing a '
    + 'different name and what red-b2aa7-chk007-receipt.mjs spawns was never accounted for',
  );

  // NON-VACUITY: de-register a registered harness that nothing else spawns and
  // require the SAME derivation to move it into `unreached`. The candidate is
  // searched for rather than named, so this survives any registration change.
  let stripProof = null;
  for (const candidate of derived.registered) {
    const stripped = new Set(realTokens);
    stripped.delete(`${RED_DIR_REL}/${candidate}`);
    const mutatedDerivation = derive(stripped);
    if (mutatedDerivation.unreached.includes(candidate)) {
      stripProof = { candidate, after: mutatedDerivation.unreached.length };
      break;
    }
  }
  row(
    'DERIVATION_IS_NON_VACUOUS', 'C',
    stripProof !== null,
    stripProof === null
      ? `de-registering any of the ${derived.registered.length} registered harnesses left the unreached set unchanged`
      : `de-registering ${stripProof.candidate} moves it into unreached (${derived.unreached.length} → ${stripProof.after})`,
    'the same derivation must detect a de-registered harness, or a clean result would mean nothing',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // BLOCK D — THE TRAP. A differently-prefixed newcomer, judged by REAL SHIPPED
  //           GUARDS spawned as child processes. No enumeration is imitated here.
  // ══════════════════════════════════════════════════════════════════════════
  writeFileSync(join(repoRoot, NEWCOMER_REL), [
    '#!/usr/bin/env node',
    '// PLANTED BY packages/main/tests/red/red-b49d4-registration-derivation.mjs (B-49d4 CHK-001).',
    '// A newly added red harness that nobody has registered and nobody has excluded. Its name',
    '// deliberately lacks the `red-` prefix: the declared population is *.mjs in this directory,',
    '// so only an UNFILTERED enumeration sees it. Any guard that narrows by name pattern will',
    '// report complete coverage while this file sits here undecided.',
    '// If you are reading this in a committed tree, a probe run was killed before cleanup: delete it.',
    "console.log('b49d4-newcomer-probe-unprefixed: OK');",
    '',
  ].join('\n'), 'utf8');

  /**
   * Targets are DERIVED and are real files on disk: the guard this story names,
   * plus every `*.mjs` here that reads `lattice.config.json` AND enumerates a
   * directory — i.e. anything that decides registration by looking rather than by
   * remembering. Files that spawn THIS one are skipped to break the cycle; that is
   * a recursion break, not a population carve-out (BLOCK C still counts them).
   */
  const targetRels = [];
  const considerTarget = (rel) => {
    if (!targetRels.includes(rel) && existsSync(join(repoRoot, rel))) targetRels.push(rel);
  };
  considerTarget(GUARD_REL);
  for (const name of readdirSync(here).filter((n) => n.endsWith('.mjs')).sort()) {
    if (name === SELF || name === NEWCOMER_BASE) continue;
    let text = '';
    try {
      text = readFileSync(join(here, name), 'utf8');
    } catch {
      continue;
    }
    if (text.includes(SELF)) continue;                       // would spawn this file back
    if (!text.includes(CONFIG_REL)) continue;                // does not read the registration source of truth
    if (!/readdirSync|opendirSync|globSync|readdir\(/.test(text)) continue; // does not enumerate
    considerTarget(`${RED_DIR_REL}/${name}`);
  }

  const targetRuns = targetRels.map((rel) => {
    const r = runNode([join(repoRoot, rel)]);
    return { rel, status: r.status, names: r.out.includes(NEWCOMER_BASE), ms: r.ms, out: r.out };
  });
  const catchers = targetRuns.filter((t) => t.status !== 0 && t.names);
  const blindTargets = targetRuns.filter((t) => t.status === 0);

  row(
    'NEWCOMER_TARGETS_ARE_REAL_SHIPPED_GUARDS', 'D',
    targetRuns.length > 0 && targetRels.every((rel) => existsSync(join(repoRoot, rel))),
    `spawned ${targetRuns.length} committed guard(s) as child processes: `
    + `${targetRuns.map((t) => `${basename(t.rel)}(exit=${t.status}, ${t.ms}ms)`).join(', ')}`,
    'the newcomer must be judged by the enumeration that actually ships, not by a copy of it written in this file',
  );
  row(
    'DIFFERENTLY_PREFIXED_NEWCOMER_IS_INSIDE_THE_POPULATION', 'D',
    catchers.length > 0,
    `${NEWCOMER_REL} planted, registered nowhere and excluded nowhere; guards that caught it: `
    + `${catchers.map((t) => basename(t.rel)).join(', ') || 'NONE'}; guards that reported success anyway: `
    + `${blindTargets.map((t) => `${basename(t.rel)}("${clip(t.out, 90)}")`).join(' | ') || 'none'}`,
    'some shipped guard must fail and name a newcomer that is registered nowhere and excluded nowhere — with the '
    + '`red-` prefix absent, only an unfiltered enumeration can see it, which is exactly what a name-pattern '
    + 'derivation would narrow away',
  );

  const narrowed = targetRuns.filter((t) => t.rel !== GUARD_REL && t.status === 0);
  if (narrowed.length > 0) {
    observations.push(
      `NARROWED_ENUMERATION_MISSES_NEWCOMER — ${narrowed.map((t) => basename(t.rel)).join(', ')} derive their `
      + 'population from disk yet reported success with the newcomer sitting undecided in the same directory, because '
      + 'their enumeration is narrowed by name. Measured on real shipped guards rather than argued: coverage of the '
      + 'whole population can only come from an UNFILTERED enumeration.',
    );
  }

  sweepProbes();

  // ══════════════════════════════════════════════════════════════════════════
  // BLOCK E — the real config was never written to.
  // ══════════════════════════════════════════════════════════════════════════
  const digestAfter = sha256(readFileSync(CONFIG_PATH));
  let gitStatus = null;
  try {
    gitStatus = execFileSync('git', ['status', '--porcelain', '--', CONFIG_REL], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    gitStatus = null;
  }
  row(
    'REAL_CONFIG_BYTE_UNMODIFIED', 'E',
    digestAfter === CONFIG_DIGEST_BEFORE && (gitStatus === null || gitStatus === ''),
    `sha256 before=${CONFIG_DIGEST_BEFORE.slice(0, 16)}… after=${digestAfter.slice(0, 16)}…; `
    + `git status --porcelain -- ${CONFIG_REL} => ${gitStatus === null ? 'unavailable' : JSON.stringify(gitStatus)}`,
    'every mutation must have happened on a copy: the real config must be byte-identical and clean afterwards',
  );
  row(
    'PROBES_CLEANED_UP', 'E',
    PROBE_RELS.every((rel) => !existsSync(join(repoRoot, rel))),
    PROBE_RELS.map((rel) => `${rel}=${existsSync(join(repoRoot, rel)) ? 'LEFT BEHIND' : 'removed'}`).join(', '),
    'no probe may survive the run',
  );
} finally {
  sweepProbes();
}

// ── report ──────────────────────────────────────────────────────────────────
const red = rows.filter((r) => !r.green);
for (const r of rows) {
  console.log(`  [${r.green ? 'GREEN' : 'RED  '}] ${r.id} (BLOCK ${r.block})`);
  console.log(`      observed: ${r.observed}`);
  if (!r.green) console.log(`      required: ${r.required}`);
}
for (const note of observations) console.log(`  [OBS  ] ${note}`);
console.log(`\n${red.length} RED / ${rows.length - red.length} GREEN of ${rows.length} rows (${spawnMs}ms in child processes)`);

if (red.length > 0) {
  console.error(
    `\nred-b49d4-registration-derivation: ${red.length} row(s) still exhibit the pre-fix defect — `
    + `${red.map((r) => r.id).join(', ')}. `
    + 'The registration guard asserts a fixed allowlist instead of deriving its population, so it reports the size of '
    + 'its own expectation and cannot see a member nobody listed.',
  );
  process.exit(1);
}

console.log(
  'red-b49d4-registration-derivation: OK (registration is DERIVED from disk: an unregistered member of '
  + `${DIST_TASKS_REL}/red-evidence-*.js is caught, every ${RED_DIR_REL}/*.mjs is registered or reachable from `
  + 'something registered, a differently-prefixed newcomer is caught by the shipped guards themselves, and the '
  + 'control bites on a config COPY while the real lattice.config.json stays byte-identical)',
);
process.exit(0);
