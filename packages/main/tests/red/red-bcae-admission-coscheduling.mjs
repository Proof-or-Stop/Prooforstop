#!/usr/bin/env node
/**
 * B-bcae CL-010 (F-064 + F-065) — REAL-ROOT ADMISSION CO-SCHEDULING GUARD.
 *
 * ── WHAT THE CLUSTER ASKED FOR, AND WHY THIS FILE DOES SOMETHING ELSE ───────
 *
 * F-064 and F-065 observe that this Story put the per-repository dist-import
 * mutex on EVERY real `bin/proof-or-stop.js` startup and made a real-root build
 * hold that same mutex for its whole promotion, and that four registered
 * `validate.commands` rows take it while declaring no `resources`. Both then
 * recommend DECLARING an exclusive `runtime-lock` claim on those rows, reasoning
 * from `core/keyed-scheduler.ts` `claimsConflict` — which iterates both entries'
 * `resources` arrays, so two rows with EMPTY arrays can never conflict.
 *
 * That reasoning skips the resolver that runs BEFORE the scheduler ever sees a
 * row. `core/validation-executor.ts` `resolveValidationCommandResourceClaims`
 * gives a row that declared NOTHING a single EXCLUSIVE claim on the synthetic
 * barrier key, and a row that declared something the SAME key `shared`. So an
 * undeclared row conflicts with every other entry in the plan and is scheduled
 * ALONE; the empty array never reaches `claimsConflict` as an empty array. All
 * four named rows are undeclared today, so they are already serialized against
 * everything, and applying the recommended remedy verbatim would REMOVE that
 * exclusivity and let the expensive holder (`red-1734-reader-race.mjs`, which
 * deletes the build manifest to force the slow rm+tsc path) overlap every other
 * declared row. BLOCK D below proves that reversal mechanically rather than
 * asserting it in prose.
 *
 * So the repair is not a declaration. It is this guard, which pins the property
 * the cluster actually wants — no two real-root admission takers can be
 * co-scheduled — and fails when a future edit removes it, including by adding
 * the very claim F-064 recommends.
 *
 * ── WHAT IS AND IS NOT MECHANICAL HERE ──────────────────────────────────────
 *
 * MECHANICAL: candidate detection (BLOCK A) reads every registered row's sources
 * live, so a newcomer that mentions the CLI wrapper, a build wrapper or a lock
 * function is a candidate whatever it is called; an unclassified candidate FAILS
 * (BLOCK B), a stale carve-out FAILS, each classification's cited construct must
 * still be present (BLOCK B), no non-member may spawn the real wrapper directly
 * (BLOCK C), the serialization invariant is computed from the SHIPPED resolver
 * and the SHIPPED `claimsConflict` (BLOCK D), and BLOCK D's mutation proves the
 * invariant is not vacuous.
 *
 * "Its sources" is what F-067 caught this guard being wrong about. An
 * `npm --prefix <pkg> run <script>` row names no file in its argv, so the argv
 * scan found nothing, the source text was EMPTY, and every token test against it
 * was vacuous; the only npm row that was a candidate was one whose script name
 * had been spelled into the token list by hand. `npm --prefix packages/graph run
 * check` — whose chain spawns the real `bin/proof-or-stop.js` at the real root
 * three times — was therefore not undecided but invisible: never a candidate,
 * never presented to BLOCK B, never in BLOCK D's pairwise set. BLOCK A now
 * resolves such a row through the target `package.json` and follows its script
 * chain (including nested `npm run`) to the real sources, and BLOCK E proves
 * that resolution reaches rows the argv scan cannot see, discriminates by chain
 * content rather than by script name, and puts them inside the invariant.
 *
 * NOT MECHANICAL, stated so it is not read as more than it is: membership itself
 * is PINNED, not derived. The BLOCK C window check is a ONE-WAY trip-wire — it
 * catches a non-member that starts spawning the wrapper as a literal inside a
 * spawn call, and it CANNOT see a spawn routed through a helper (two members
 * here do exactly that). It therefore does NOT establish that no member is
 * missing, and must not be read as doing so: a row that belongs in the member
 * set but reaches the wrapper through a helper passes BLOCK C silently. All
 * BLOCK C can do is catch one specific way a NON-member stops being one. What
 * keeps the set complete is BLOCK B: every candidate must be decided by a human,
 * and a new one is undecided until somebody decides it. And a row that executes
 * neither a JS file named in its argv nor a package script — a bare binary, a
 * shell one-liner — still exposes no source to read, and is decided on its
 * command line alone; the PASS line reports how many such rows there are rather
 * than counting them as inspected.
 *
 * Run from anywhere:
 *   node packages/main/tests/red/red-bcae-admission-coscheduling.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF_ABS = fileURLToPath(import.meta.url);
const here = dirname(SELF_ABS);
const pkgRoot = join(here, '..', '..'); // packages/main
const repoRoot = join(pkgRoot, '..', '..');
const SELF_REL = relative(repoRoot, SELF_ABS).split(sep).join('/');
const CONFIG_NAME = 'proof-or-stop.config.json';
const CONFIG_PATH = join(repoRoot, CONFIG_NAME);

const failures = [];
const fail = (check, why) => failures.push(`${check}: ${why}`);

// ── BLOCK A — candidates, derived live from the registered rows ─────────────
//
// A row is a CANDIDATE when its command line, the package-script chain it runs,
// or any source that chain reaches mentions the real CLI wrapper, a real build
// wrapper, the dist bootstrap helper, or either lock function. Deliberately
// wide: a candidate is only an obligation to decide, and the false positives
// below are the point — they are what BLOCK B and BLOCK C keep out of the
// member set.
//
// There is no script-NAME token here. There used to be one (`run build`), and it
// was the whole reason the `npm --prefix packages/graph run check` row escaped
// this derivation entirely (F-067): a name list only ever finds the names
// already on it. Both npm rows now qualify through what their chains execute.
const SOURCE_TOKENS = [
  /proof-or-stop(?:-codex)?\.js(?!on)/, // `(?!on)` — `proof-or-stop.json` is not the wrapper
  /build-(?:main|utils)-with-binding/,
  /ensure-dist/,
  /with(?:Build|DistImport)Lock/,
];

if (!existsSync(CONFIG_PATH)) {
  console.error(`red-bcae-admission-coscheduling: ${CONFIG_NAME} not found at ${CONFIG_PATH}`);
  process.exit(1);
}
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const rows = config?.validate?.commands;
if (!Array.isArray(rows) || rows.length === 0) {
  console.error('red-bcae-admission-coscheduling: validate.commands is missing or empty');
  process.exit(1);
}

/** Stable, readable row identity: the command line exactly as it is registered. */
const rowKeyOf = (row) => [row.command, ...(row.args ?? [])].join(' ');

const readRepoFile = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

/** A path written relative to `fromDirRel`, re-expressed relative to repoRoot. */
const repoRelative = (fromDirRel, target) => relative(repoRoot, join(repoRoot, fromDirRel, target)).split(sep).join('/');

/**
 * The file that should be READ for an executed path. A `dist/tasks/*.js` product
 * is read through its `src/tasks/*.ts` original: dist is a build product, so
 * reading it would make this guard's verdict depend on whether somebody rebuilt.
 * Returns null when neither exists — an unreadable path is not silently invented.
 */
function readablePathFor(rel) {
  if (rel.includes('/dist/tasks/')) {
    const original = rel.replace('/dist/tasks/', '/src/tasks/').replace(/\.js$/, '.ts');
    if (existsSync(join(repoRoot, original))) return original;
  }
  if (existsSync(join(repoRoot, rel))) return rel;
  const source = rel.replace(/\.js$/, '.ts');
  return source !== rel && existsSync(join(repoRoot, source)) ? source : null;
}

/** The file a row executes when it names one directly in its own argv. */
function sourcePathOf(row) {
  const argv = row.args ?? [];
  const fixtureWrapper = row.command === 'node' && argv[0] === 'scripts/run-validation-fixture-suite.mjs';
  const target = fixtureWrapper ? argv[1] : argv.find((arg) => /\.(mjs|js|cjs)$/.test(arg));
  return target ? readablePathFor(target) : null;
}

// An `npm --prefix <pkg> run <script>` row names NO file in its argv, so the
// argv scan above returns null for it and every source token test would be
// vacuous — F-067. Resolve the script out of the target `package.json` instead
// and follow the chain it runs, including nested `npm run <other>`, until the
// real JS sources are in hand. Bounded on purpose: a fixed recursion depth and a
// visited set, so a script that calls itself terminates instead of looping.
const NPM_MAX_DEPTH = 8;
const NPM_BIN = /(?:^|\/)npm(?:\.cmd)?$/;
const SCRIPT_TARGET = /\.(?:mjs|js|cjs|ts)$/;

/** `npm --prefix packages/graph run check` → `{ pkgDirRel, script }`; null otherwise. */
function npmRunTargetOf(argv, cwdRel) {
  if (!NPM_BIN.test(argv[0] ?? '')) return null;
  let pkgDirRel = cwdRel;
  let script = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--prefix' || arg === '-C') { pkgDirRel = repoRelative(cwdRel, argv[i + 1] ?? '.'); i += 1; }
    else if (arg.startsWith('--prefix=')) pkgDirRel = repoRelative(cwdRel, arg.slice('--prefix='.length));
    else if (arg === 'run' || arg === 'run-script') { script = argv[i + 1] ?? null; break; }
  }
  return script ? { pkgDirRel, script } : null;
}

/**
 * Everything running `script` in `pkgDirRel` would execute: the readable sources
 * its chain reaches, and the chain's own command lines. `unresolved` is set when
 * a link could not be read at all, so a renamed script FAILS loudly rather than
 * quietly shrinking what this guard inspects.
 */
function npmScriptChain(pkgDirRel, script) {
  const sources = [];
  const commands = [];
  const seen = new Set();
  let maxDepth = 0;
  let unresolved = null;

  const walk = (dirRel, name, depth) => {
    if (depth > NPM_MAX_DEPTH) { unresolved ??= `${dirRel}#${name} (past depth ${NPM_MAX_DEPTH})`; return; }
    const key = `${dirRel}#${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    maxDepth = Math.max(maxDepth, depth);
    const manifestRel = repoRelative(dirRel, 'package.json');
    if (!existsSync(join(repoRoot, manifestRel))) { unresolved ??= `${key} (no ${manifestRel})`; return; }
    let line;
    try { line = JSON.parse(readRepoFile(manifestRel))?.scripts?.[name]; } catch { unresolved ??= `${key} (${manifestRel} is not readable JSON)`; return; }
    if (typeof line !== 'string') { unresolved ??= `${key} (no such script in ${manifestRel})`; return; }
    commands.push(line);
    let cwdRel = dirRel;
    for (const segment of line.split(/&&|\|\||[;|&]/)) {
      const argv = segment.trim().split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, '')).filter(Boolean);
      if (argv.length === 0) continue;
      if (argv[0] === 'cd') { cwdRel = repoRelative(cwdRel, argv[1] ?? '.'); continue; }
      const nested = npmRunTargetOf(argv, cwdRel);
      if (nested) { walk(nested.pkgDirRel, nested.script, depth + 1); continue; }
      const target = argv.find((token) => SCRIPT_TARGET.test(token));
      if (!target) continue;
      const readable = readablePathFor(repoRelative(cwdRel, target));
      if (readable && !sources.some((entry) => entry.rel === readable)) sources.push({ rel: readable, text: readRepoFile(readable) });
    }
  };

  walk(pkgDirRel, script, 1);
  // A registered script may reach the real wrapper through a local helper.
  // Follow literal relative imports as well as npm links; never depend on the
  // wrapper spelling remaining inside the top-level verifier source.
  for (let index = 0; index < sources.length; index += 1) {
    if (index >= 256) { unresolved ??= 'relative import graph exceeds 256 sources'; break; }
    const source = sources[index];
    for (const match of source.text.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"](\.[^'"]+)['"]/g)) {
      const rel = readablePathFor(repoRelative(dirname(source.rel), match[1]));
      if (!rel) { unresolved ??= `${source.rel} imports missing ${match[1]}`; continue; }
      if (!sources.some(entry => entry.rel === rel)) sources.push({ rel, text: readRepoFile(rel) });
    }
  }
  return { sources, commandText: commands.join('\n'), maxDepth, unresolved };
}

/** Every source a row executes, however it names them. */
function rowSourcesOf(row) {
  const npmTarget = npmRunTargetOf([row.command, ...(row.args ?? [])], '');
  if (npmTarget) return { kind: 'npm-script', npmTarget, ...npmScriptChain(npmTarget.pkgDirRel, npmTarget.script) };
  const direct = sourcePathOf(row);
  return {
    kind: direct ? 'argv' : 'no-source',
    npmTarget: null,
    sources: [
      ...(row.command === 'node' && row.args?.[0] === 'scripts/run-validation-fixture-suite.mjs'
        ? [{ rel: row.args[0], text: readRepoFile(row.args[0]) }] : []),
      ...(direct ? [{ rel: direct, text: readRepoFile(direct) }] : []),
    ],
    commandText: '',
    maxDepth: 0,
    unresolved: null,
  };
}

/**
 * The candidacy decision itself, in ONE place — the live rows below and the
 * mutants in BLOCK E go through this same function, so a mutant cannot pass
 * against a second copy of the rule.
 */
function derivedCandidacyOf(row) {
  const resolved = rowSourcesOf(row);
  const sourceText = resolved.sources.map((entry) => entry.text).join('\n');
  const isCandidate = SOURCE_TOKENS.some((token) => token.test(rowKeyOf(row)) || token.test(resolved.commandText) || token.test(sourceText));
  return { resolved, sourceText, isCandidate };
}

const candidates = new Map();
const npmRows = [];
let sourcelessRows = 0;
for (const row of rows) {
  const rowKey = rowKeyOf(row);
  const { resolved, sourceText, isCandidate } = derivedCandidacyOf(row);
  if (resolved.kind === 'npm-script') npmRows.push({ row, rowKey, resolved });
  if (resolved.sources.length === 0) sourcelessRows += 1;
  if (!isCandidate) continue;
  if (candidates.has(rowKey)) fail('candidate', `two registered rows share the command line ${rowKey}, so a classification cannot address either one`);
  candidates.set(rowKey, { row, rowKey, sources: resolved.sources, sourceText, resolved });
}

// ── BLOCK B — every candidate is decided, and every decision cites a construct ─
//
// `role: 'real-root-admission'` means: at RUN time this row takes the real
// repository's reader admission or build lock (it spawns the real
// `bin/proof-or-stop.js`, or drives a real-root build, or calls a lock function
// on the real repoRoot). Everything else is `static-reference-only` and must say
// what the mention actually is.
//
// `evidence` must still match, so a row that stops doing what its reason claims
// becomes a failure to re-triage rather than a stale sentence. `evidenceIn`
// selects what the regex is matched against: the row's source (default), its
// command line (`rowKey`), or another repository file named by path.
const CLASSIFICATION = new Map([
  // ── members ───────────────────────────────────────────────────────────────
  ['npm --prefix packages/main run build', {
    role: 'real-root-admission',
    reason: 'the registered Wave-0 build itself; packages/main "build" runs the real build wrapper, which holds buildLockTarget and, nested inside it, distImportLockTarget for the whole promotion',
    evidenceIn: 'packages/main/package.json',
    evidence: /"build":\s*"[^"]*build-main-with-binding\.mjs/,
  }],
  ['node packages/main/dist/tasks/codex-heartbeat-timeout-smoke.js', {
    role: 'real-root-admission',
    reason: 'runs the real wrapper (verify_codex --help) from the project root, so it takes reader admission before any argv dispatch',
    evidence: /execFileSync\(process\.execPath, \['bin\/proof-or-stop\.js'/,
  }],
  ['node packages/main/tests/red/red-1734-content-binding.mjs', {
    role: 'real-root-admission',
    reason: 'executes the real build wrappers with cwd repoRoot, so it holds the real build lock and the nested reader admission',
    evidence: /build-main-with-binding\.mjs'\], \{ cwd: repoRoot/,
  }],
  ['node packages/main/tests/red/red-1734-reader-race.mjs', {
    role: 'real-root-admission',
    reason: 'the expensive holder: deletes the build manifest to force the slow rm+tsc path, spawns the real build wrapper, and keeps many real wrapper readers in flight across the whole build window',
    evidence: /spawnCapture\(\['scripts\/build-main-with-binding\.mjs'\]\)/,
  }],
  ['node packages/main/tests/red/red-bcae-bootstrap-reader-lock.mjs', {
    role: 'real-root-admission',
    reason: 'takes production reader admission on the real repoRoot for its own reads of the real packages/main/dist',
    evidence: /await withDistImportLock\(repoRoot, fn\)/,
  }],
  ['node packages/main/tests/red/red-cc10-chk006-removed-bin-aliases.mjs', {
    role: 'real-root-admission',
    reason: 'runs the real wrapper (--version) with cwd repoRoot; admission is acquired before argv dispatch, so --version takes it like any subcommand',
    evidence: /spawnSync\(process\.execPath, \['bin\/proof-or-stop\.js', '--version'\]/,
  }],
  ['npm --prefix packages/graph run check', {
    role: 'real-root-admission',
    reason: 'F-067\'s counterexample: its script chain reaches verify-serves, verify-json-no-listener and verify-missing-assets-fail, each of which spawns the real bin/proof-or-stop.js with cwd set to the real repository root, so each run takes real reader admission before any argv dispatch',
    evidenceIn: 'packages/graph/scripts/graph-process.mjs',
    evidence: /spawn\(process\.execPath,\['bin\/proof-or-stop\.js','graph'/,
  }],
  ['node packages/main/tests/red/red-bfe8f-ledger-runtime-integrity.mjs', {
    role: 'real-root-admission',
    reason: 'drives real CLI commands through the real wrapper resolved from repoRoot; the only member that currently DECLARES resources, which is why BLOCK D has a declared row to test the invariant against',
    evidence: /join\(repoRoot, 'bin', 'proof-or-stop\.js'\)/,
  }],

  // ── static references ─────────────────────────────────────────────────────
  ['node scripts/verify-lab-worktree.mjs', {
    role: 'static-reference-only',
    reason: 'writes a fixture wrapper and a fixture ensure-dist into scratch repositories under a mkdtemp root and drives those; the real root is never built and the real wrapper is never spawned',
    evidence: /mkdtempSync\(join\(tmpdir\(\), 'lab-worktree-test-'\)\)/,
  }],
  ['node packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js', {
    role: 'static-reference-only',
    reason: 'the wrapper path is an entry in the list of paths the guard SCANS as text',
    evidence: /SHIPPED_EXECUTABLE_ENTRYPOINTS/,
  }],
  ['node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/verification-run-and-guard-smoke.js', {
    role: 'static-reference-only',
    reason: 'the wrapper path appears only as commandString values handed to the guard verdict helper; its real spawns are git, a hook script and an inline snippet',
    evidence: /commandString/,
  }],
  ['node packages/main/dist/tasks/codex-adapter-gate-scope-smoke.js', {
    role: 'static-reference-only',
    reason: 'the codex wrapper path is a string in an asset list the smoke inspects',
    evidence: /'bin\/proof-or-stop-codex\.js',/,
  }],
  ['node packages/main/dist/tasks/test-suite-utils-autobuild-smoke.js', {
    role: 'static-reference-only',
    reason: 'reads the build wrapper sources as text to assert they are content-bound and take the build mutex; it never runs them',
    evidence: /const mainBuild = read\('scripts\/build-main-with-binding\.mjs'\)/,
  }],
  ['node packages/main/tests/red/red-1734-lock-liveness.mjs', {
    role: 'static-reference-only',
    reason: 'exercises the lock function against unique scratch targets under tmpdir, never against the real repository root',
    evidence: /const key = uniqueKey\(\)/,
  }],
  ['node packages/main/tests/red/red-1734-bootstrap-depfree.mjs', {
    role: 'static-reference-only',
    reason: 'asserts the bootstrap source TEXT contains the admission call; it performs no acquisition of its own',
    evidence: /bootCode\.includes\('withDistImportLock'\)/,
  }],
  ['node packages/main/tests/red/red-global-cli-exec-bit.mjs', {
    role: 'static-reference-only',
    reason: 'compiles a fixture under tmpdir with tsc and reads the build wrapper sources as text; the real wrappers are never executed',
    evidence: /const wrappers = \['scripts\/build-main-with-binding\.mjs'/,
  }],
  ['node packages/main/tests/red/red-1734-desktop-asset-manifest.mjs', {
    role: 'static-reference-only',
    reason: 'spawns a witness it writes into a scratch runtime root; the lock function name is one of the tokens it scans the bootstrap text for',
    evidence: /'importDistModules', 'withDistImportLock'/,
  }],
  ['node packages/main/dist/tasks/cli-surface-smoke.js', {
    role: 'static-reference-only',
    reason: 'runs packages/main/dist/cli.js directly, which never enters the bootstrap runner; the real wrapper is only a FALLBACK for a missing dist, a state routine validate cannot be in because Wave-0 builds first',
    evidence: /existsSync\(cliPath\) \? cliPath : cliFallback/,
  }],
  ['node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/validation-protocol-smoke.js', {
    role: 'static-reference-only',
    reason: 'spawns a generated wrapper inside a mkdtemp root; that wrapper imports dist/cli-engine.js directly and never enters the bootstrap runner, so no admission is taken',
    evidence: /mkdtempSync\(join\(tmpdir\(\), 'proof-or-stop-wrapper-cjs-'\)\)/,
  }],
  ['node scripts/verify-process-fact-contract.mjs --quiet', {
    role: 'static-reference-only',
    reason: 'the real wrapper path is an expected source token used to verify the retired-authority guard contract; this verifier reads files and does not execute that wrapper',
    evidence: /"'bin\/proof-or-stop\.js'"/,
  }],
  ['node packages/main/tests/red/red-B-e40f-quorum-submit-harness.mjs --case=inventory-bijection', {
    role: 'static-reference-only',
    reason: 'the wrapper path belongs to a generated isolated quorum runtime rooted below a harness-owned temporary directory, not the real repository root',
    evidence: /const runtimeRoot = join\(owner\.realpath, safeLabel \+ "-runtime"\)/,
  }],
  ['node packages/main/tests/canonical-new-story-artifacts.test.mjs --group=identity-cutover', {
    role: 'static-reference-only',
    reason: 'the wrapper name is canonical identity data in an assertion table; this test does not spawn the real repository wrapper',
    evidence: /\['packages\/main\/src\/cli-init\.ts', 'proof-or-stop\.js'\]/,
  }],
  [`node ${SELF_REL}`, {
    role: 'static-reference-only',
    reason: 'this guard: the wrapper and lock names appear in its token list and its classification reasons; it reads files and imports the shipped resolver in-process, spawning nothing',
    evidence: /const SOURCE_TOKENS = \[/,
  }],
]);

for (const [rowKey, entry] of CLASSIFICATION) {
  if (!candidates.has(rowKey)) {
    fail('stale-classification', `${rowKey} is classified here but is not a registered candidate; a carve-out that outlives its row silently widens itself`);
    continue;
  }
  if (entry.role !== 'real-root-admission' && entry.role !== 'static-reference-only') {
    fail('classification', `${rowKey} has unknown role ${entry.role}`);
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < 30) {
    fail('classification', `${rowKey} has no stated reason`);
  }
  const target = entry.evidenceIn && entry.evidenceIn !== 'rowKey' && entry.evidenceIn !== 'source' ? entry.evidenceIn : null;
  let haystack;
  if (entry.evidenceIn === 'rowKey') haystack = rowKey;
  else if (target) {
    if (!existsSync(join(repoRoot, target))) {
      fail('evidence', `${rowKey} cites ${target}, which does not exist`);
      continue;
    }
    haystack = readRepoFile(target);
  } else haystack = candidates.get(rowKey).sourceText;
  if (!entry.evidence.test(haystack)) {
    fail('evidence', `${rowKey} is classified ${entry.role} on a construct that is no longer present (${entry.evidence}); re-triage this row rather than editing the reason`);
  }
}

for (const rowKey of candidates.keys()) {
  if (!CLASSIFICATION.has(rowKey)) {
    fail('undecided',
      `${rowKey} mentions the real CLI wrapper, a build wrapper or a lock function and is not classified. Decide it: `
      + 'real-root-admission if it takes the real repository reader admission or build lock at run time, '
      + 'static-reference-only otherwise, with a reason and a construct to cite.');
  }
}

const memberKeys = [...CLASSIFICATION.entries()].filter(([, entry]) => entry.role === 'real-root-admission').map(([rowKey]) => rowKey);
const nonMemberKeys = [...CLASSIFICATION.entries()].filter(([, entry]) => entry.role === 'static-reference-only').map(([rowKey]) => rowKey);

// The two rows F-064 named and the two more F-065 added must all be members: the
// remedy has to cover the complete verified set, not only the adjacent pair.
for (const named of [
  'node packages/main/tests/red/red-1734-reader-race.mjs',
  'node packages/main/tests/red/red-bcae-bootstrap-reader-lock.mjs',
  'node packages/main/tests/red/red-cc10-chk006-removed-bin-aliases.mjs',
  'node packages/main/dist/tasks/codex-heartbeat-timeout-smoke.js',
]) {
  if (!memberKeys.includes(named)) fail('verified-set', `${named} is part of the verified F-064/F-065 set but is not covered as a real-root admission taker`);
}

// The two rows the topology critic checked and EXCLUDED must stay excluded: the
// set must not be broadened to whatever merely greps.
for (const excluded of [
  'node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/verification-run-and-guard-smoke.js',
  'node packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js',
]) {
  if (!nonMemberKeys.includes(excluded)) fail('false-positive', `${excluded} was checked and excluded by review; it must not be pulled into the admission set`);
}

// ── BLOCK C — one-way trip-wire on the non-members ──────────────────────────
//
// For every static-reference-only row: no spawn/exec CALL may name the real
// wrapper or a build wrapper inside its own argument list, and no lock call may
// be made on repoRoot. The window is the call's balanced parentheses, not a
// fixed character count — a fixed window matched a neighbouring line and a
// `execFileSync (D2)` heading while proving nothing.
const SPAWN_CALL = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(/g;
const REAL_TARGET = /proof-or-stop(?:-codex)?\.js(?!on)|build-(?:main|utils)-with-binding\.mjs/;
const REAL_ROOT_LOCK = /with(?:Build|DistImport)Lock\s*\(\s*repoRoot\b/;

function spawnArgumentWindows(text) {
  const windows = [];
  SPAWN_CALL.lastIndex = 0;
  let match;
  while ((match = SPAWN_CALL.exec(text)) !== null) {
    const open = match.index + match[0].length - 1;
    const hardStop = Math.min(text.length, match.index + 2000);
    let depth = 0;
    let cursor = open;
    for (; cursor < hardStop; cursor += 1) {
      const char = text[cursor];
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) { cursor += 1; break; }
      }
    }
    windows.push({ line: text.slice(0, match.index).split('\n').length, text: text.slice(match.index, cursor) });
  }
  return windows;
}

for (const rowKey of nonMemberKeys) {
  const candidate = candidates.get(rowKey);
  if (!candidate) continue; // already reported as a stale classification
  // Per source, not over the joined text: a row whose chain reaches several
  // files must report the offending file and its own line number.
  for (const source of candidate.sources) {
    for (const window of spawnArgumentWindows(source.text)) {
      if (REAL_TARGET.test(window.text)) {
        fail('non-member-spawns-real-wrapper',
          `${source.rel}:${window.line} names the real wrapper or a build wrapper inside a spawn call, so this row is no longer static-reference-only`);
      }
    }
    if (REAL_ROOT_LOCK.test(source.text)) {
      fail('non-member-takes-real-root-lock', `${source.rel} calls a lock function on repoRoot, so this row is no longer static-reference-only`);
    }
  }
}

// ── BLOCK D — the invariant, computed by the shipped code ───────────────────
//
// No two members may be co-schedulable. Both halves come from the product:
// `resolveValidationCommandResourceClaims` applies the fail-closed exclusive
// barrier default, `canonicalizeEntries` resolves the keys, and `claimsConflict`
// is the same predicate the runner admits with. Nothing about the rule is
// re-implemented here.
const executorDist = join(pkgRoot, 'dist', 'core', 'validation-executor.js');
const schedulerDist = join(pkgRoot, 'dist', 'core', 'keyed-scheduler.js');
for (const artifact of [executorDist, schedulerDist]) {
  if (!existsSync(artifact)) {
    console.error(`red-bcae-admission-coscheduling: missing build artifact ${artifact}; run npm --prefix packages/main run build first`);
    process.exit(1);
  }
}
const { resolveValidationCommandResourceClaims } = await import(pathToFileURL(executorDist).href);
const { canonicalizeEntries, claimsConflict } = await import(pathToFileURL(schedulerDist).href);

const entryFor = (rowKey, row) => canonicalizeEntries(
  [{ name: rowKey, resources: resolveValidationCommandResourceClaims(row, rowKey).claims }],
  repoRoot,
)[0];

/** Every unordered member pair that the shipped predicate would let overlap. */
function coschedulablePairs(entries) {
  const overlapping = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (!claimsConflict(entries[i], entries[j])) overlapping.push(`${entries[i].name} || ${entries[j].name}`);
    }
  }
  return overlapping;
}

const memberEntries = memberKeys
  .filter((rowKey) => candidates.has(rowKey))
  .map((rowKey) => entryFor(rowKey, candidates.get(rowKey).row));

if (memberEntries.length < 2) {
  fail('invariant', `only ${memberEntries.length} member(s) resolved, so the pairwise invariant would be vacuous`);
} else {
  for (const pair of coschedulablePairs(memberEntries)) {
    fail('coschedulable',
      `two real-root admission takers can run concurrently: ${pair}. Either restore the fail-closed default by removing the declared resources, `
      + 'or declare a claim that makes the pair conflict.');
  }
}

// Retain the original F-064 counterexample against the shipped resolver,
// independently of whether today's real rows use explicit safe declarations.
const HOLDER_KEY = 'node packages/main/tests/red/red-1734-reader-race.mjs';
const DECLARED_MEMBER_KEY = 'node packages/main/tests/red/red-bfe8f-ledger-runtime-integrity.mjs';
if (candidates.has(HOLDER_KEY) && candidates.has(DECLARED_MEMBER_KEY)) {
  const holder = candidates.get(HOLDER_KEY).row;
  const declared = candidates.get(DECLARED_MEMBER_KEY).row;
  const baselineHolder = { ...holder, resources: undefined };
  const baselineDeclared = { ...declared, resources: [{ class: 'runtime-lock', key: 'counterexample-reader', access: 'exclusive' }] };
  if (coschedulablePairs([entryFor(HOLDER_KEY, baselineHolder), entryFor(DECLARED_MEMBER_KEY, baselineDeclared)]).length !== 0) {
    fail('mutation', 'the missing-declaration baseline must retain the exclusive barrier');
  }
  const misleadingFix = { ...holder, resources: [{ class: 'runtime-lock', key: 'packages/main/dist', access: 'exclusive' }] };
  if (coschedulablePairs([entryFor(HOLDER_KEY, misleadingFix), entryFor(DECLARED_MEMBER_KEY, baselineDeclared)]).length !== 1) {
    fail('mutation', 'the old runtime-lock-only recommendation must still expose the unsafe pair');
  }
  // Removing the explicit admission lock from two otherwise independently safe
  // readers must reintroduce a pair; this prevents an inert coordination claim.
  const readerKeys = ['node packages/main/dist/tasks/codex-heartbeat-timeout-smoke.js', 'node packages/main/tests/red/red-cc10-chk006-removed-bin-aliases.mjs'];
  const unlocked = readerKeys.map(key => {
    const row = candidates.get(key)?.row;
    if (!row) { fail('mutation', `missing reader control ${key}`); return null; }
    return entryFor(key, { ...row, resources: row.resources.filter(claim => claim.key !== 'proof-or-stop-real-root-admission') });
  }).filter(Boolean);
  if (unlocked.length === 2 && coschedulablePairs(unlocked).length !== 1) fail('mutation', 'removing both reader admission claims must expose the real reader pair');
} else {
  fail('mutation', 'the mutation subjects are not both registered, so non-vacuity was not demonstrated');
}

// ── BLOCK E — npm-script rows: reached, discriminated, and inside the invariant ─
//
// F-067. Everything here is about the class, not about one row: E1 fails when a
// chain stops resolving, E2 fails when the chain resolution stops finding
// anything the argv scan could not have found, E3 mutates UNREGISTERED npm rows
// through the same `derivedCandidacyOf` the live rows use, and E4 shows the live
// npm member cannot leave BLOCK D's pairwise invariant quietly.

// E1 — a chain that stops resolving must FAIL rather than silently shrink what
// this guard inspects. A renamed script or a moved package would otherwise drop
// the row straight back into the F-067 blind spot.
for (const { rowKey, resolved } of npmRows) {
  if (resolved.unresolved) {
    fail('npm-chain', `${rowKey}: package script ${resolved.unresolved} could not be read, so this row's chain is only partly inspected and a wrapper spawn behind that link would be invisible`);
  }
  if (resolved.sources.length === 0) {
    fail('npm-chain', `${rowKey} resolved no executable source from ${resolved.npmTarget.pkgDirRel}/package.json, so every source token test against it is vacuous — this is exactly the state F-067 reported`);
  }
}

// E2 — non-vacuity of the resolution itself: at least one registered npm row
// must be a candidate that the argv scan and the row key alone could NOT have
// produced. If this stops holding, the chain resolution is unexercised.
const chainOnlyCandidates = npmRows.filter(({ row, rowKey }) => candidates.has(rowKey)
  && sourcePathOf(row) === null
  && !SOURCE_TOKENS.some((token) => token.test(rowKey)));
if (chainOnlyCandidates.length === 0) {
  fail('npm-chain', 'no registered npm-script row is a candidate through its package-script chain, so this resolution proves nothing and could rot unnoticed');
}
if (!npmRows.some(({ resolved }) => resolved.maxDepth >= 2)) {
  fail('npm-chain', 'no registered npm-script chain was followed through a nested `npm run`, so multi-level chains — the shape that hid the graph row behind `check` — are unexercised');
}

// E3 — mutation on UNREGISTERED rows: the derivation must react to what a chain
// executes, not to what its script is called. A positive whose script name
// matches no token, and negatives whose chains reach nothing relevant.
const NPM_MUTANTS = [
  {
    args: ['--prefix', 'packages/graph', 'run', 'verify-serves'],
    expect: true,
    why: 'its chain runs packages/graph/scripts/verify-serves.mjs, which spawns the real bin/proof-or-stop.js at the real root; no token matches the name "verify-serves", so only reading the chain can find it',
  },
  {
    args: ['--prefix', 'packages/graph', 'run', 'anchor-check'],
    expect: false,
    why: 'its chain runs packages/graph/src/tasks/anchor-check.mjs, which names no wrapper, build wrapper or lock function',
  },
  {
    args: ['--prefix', 'packages/graph', 'run', 'verify-engines-floor'],
    expect: false,
    why: 'its chain runs packages/graph/scripts/verify-engines-floor.mjs, which spawns node binaries directly and never the wrapper',
  },
];
for (const mutant of NPM_MUTANTS) {
  const mutantRow = { command: 'npm', args: mutant.args };
  const mutantKey = rowKeyOf(mutantRow);
  const { isCandidate, resolved } = derivedCandidacyOf(mutantRow);
  if (resolved.sources.length === 0) {
    fail('npm-mutation', `the mutation subject ${mutantKey} resolved no source, so it tests nothing; re-point it at a script that still exists`);
    continue;
  }
  if (isCandidate !== mutant.expect) {
    fail('npm-mutation', mutant.expect
      ? `${mutantKey} must be derived as a candidate (${mutant.why}) but is not: the chain resolution is not reaching npm-script rows`
      : `${mutantKey} must NOT be derived as a candidate (${mutant.why}) but is: the derivation is matching indiscriminately, so "every candidate is decided" would stop meaning anything`);
  }
}

// E4 — the live counterexample stays inside the invariant. It is undeclared, so
// it holds the fail-closed exclusive barrier today; declaring resources on it —
// the change F-067 warned this guard would sleep through — downgrades that
// barrier to shared and makes it co-schedulable with the declared member, which
// BLOCK D above now computes over a member set that contains it.
const NPM_MEMBER_KEY = 'npm --prefix packages/graph run check';
if (!candidates.has(NPM_MEMBER_KEY)) {
  fail('npm-chain', `${NPM_MEMBER_KEY} is registered but is no longer derived as a candidate; F-067's live counterexample must stay decided`);
} else if (memberKeys.includes(NPM_MEMBER_KEY) && candidates.has(DECLARED_MEMBER_KEY)) {
  const npmRow = candidates.get(NPM_MEMBER_KEY).row;
  const baselineDeclared = { ...candidates.get(DECLARED_MEMBER_KEY).row, resources: [{ class: 'runtime-lock', key: 'counterexample-reader', access: 'exclusive' }] };
  if (coschedulablePairs([entryFor(NPM_MEMBER_KEY, { ...npmRow, resources: undefined }), entryFor(DECLARED_MEMBER_KEY, baselineDeclared)]).length !== 0) {
    fail('npm-mutation', 'the undeclared npm baseline must retain its exclusive barrier');
  }
  const mutantEntries = [
    entryFor(NPM_MEMBER_KEY, { ...npmRow, resources: [{ class: 'runtime-lock', key: 'packages/main/dist', access: 'exclusive' }] }),
    entryFor(DECLARED_MEMBER_KEY, baselineDeclared),
  ];
  if (coschedulablePairs(mutantEntries).length !== 1) {
    fail('npm-mutation', 'the old runtime-lock-only npm recommendation must expose the unsafe pair');
  }
}
// If it were reclassified static-reference-only instead, BLOCK C would catch it:
// graph-process.mjs names the wrapper as a literal inside its own spawn call.

if (failures.length > 0) {
  console.error(`\nred-bcae-admission-coscheduling: ${failures.length} check(s) failed`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

const npmSourceCount = npmRows.reduce((total, { resolved }) => total + resolved.sources.length, 0);

console.log(
  `red-bcae-admission-coscheduling: OK (${candidates.size} candidate rows derived live from ${rows.length} registered ${CONFIG_NAME} validate.commands rows, `
  + `all classified: ${memberKeys.length} real-root admission takers and ${nonMemberKeys.length} static references, each citing a construct that is still present. `
  + `Sources come from each row's own argv and, for the ${npmRows.length} npm package-script rows, from following their package.json script chains `
  + `(${npmSourceCount} sources reached, nested \`npm run\` included, no script-name carve-out); ${sourcelessRows} registered rows execute no readable JS and are decided on their command line alone. `
  + `No two of the ${memberKeys.length} members are co-schedulable under the shipped resolver and claimsConflict. `
  + 'Proven non-vacuous: adding the exclusive runtime-lock claim F-064 recommends to the expensive holder makes it co-schedulable with a declared member, '
  + 'because declaring anything downgrades the fail-closed exclusive barrier to shared; the same mutation on the npm member breaks the same invariant, '
  + 'and unregistered npm rows are derived as candidates or not according to what their chains execute rather than what their scripts are called.)',
);
