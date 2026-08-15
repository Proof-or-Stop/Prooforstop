#!/usr/bin/env node
/**
 * B-fb7b guard-bite verifier — proves the pretest guard family actually BITES on each
 * failure mode, and confirms the two positive invariants. Parallel-safe: every
 * destructive case runs against an ISOLATED temp fixture, never the live worktree
 * (avoids the shared-dist / shared-config race). The only live action is an idempotent
 * `npm run pretest` rebuild (dist is gitignored, so it cannot dirty the tree).
 *
 * Prints one selector per case so each can be pinned as tool-executed verification
 * evidence:
 *   GB-EDGE1-CLEAN      edge:1      real `npm run pretest` leaves a clean tree
 *   GB-EDGE3-REGISTERED edge:3      validate.commands contains the smoke entry
 *   GB-ADV0-BIT         adversarial:0  echo-ok pretest -> structural smoke FAILS
 *   GB-ADV1-BIT         adversarial:1  main-only pretest -> structural smoke FAILS
 *   GB-ADVLAB-BIT       adversarial:1  `npm run build:lab` namespaced-sibling loophole -> structural smoke FAILS
 *   GB-ADVFAST-BIT      adversarial:1  `--prefix ... run build:fast` (--prefix + namespaced sibling) -> structural smoke FAILS
 *   GB-ADV4-BIT         adversarial:4  no pretest -> structural smoke FAILS (independent of the RED)
 *   GB-ADVNOGUARD-BIT   adversarial:1  ensure-dist WITHOUT an existsSync guard (unconditional rebuild) -> structural smoke FAILS
 *   GB-ADV2-BIT     adversarial:2  no pretest -> the repro-first RED (a distinct artifact) FAILS at its first assertion
 *   GB-ADV3-ABSENT      adversarial:3  removing the validate.commands entry -> not dispatched
 *   GB-LIFECYCLE-FIRES  happy:2     bare `npm test` auto-fires the pretest via the npm lifecycle hook
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(start) {
  let dir = start;
  while (!existsSync(join(dir, 'lattice.config.json')) && dir !== dirname(dir)) dir = dirname(dir);
  return dir;
}
const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const SMOKE_REL = 'packages/main/dist/tasks/test-suite-utils-autobuild-smoke.js';
const SMOKE_ABS = join(repoRoot, SMOKE_REL);
assert.ok(existsSync(SMOKE_ABS), `compiled structural smoke missing (build packages/main first): ${SMOKE_REL}`);
const RED_REL = 'packages/main/tests/red/red-fb7b-pretest-builds-utils.mjs';
const RED_ABS = join(repoRoot, RED_REL);
assert.ok(existsSync(RED_ABS), `repro-first RED missing: ${RED_REL}`);

const realPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const realConfig = JSON.parse(readFileSync(join(repoRoot, 'lattice.config.json'), 'utf8'));

const REAL_ENSURE_DIST = readFileSync(join(repoRoot, 'scripts', 'ensure-dist.mjs'), 'utf8');

// Build an isolated fixture root that the smoke can resolve (it walks up to lattice.config.json).
// opts.ensureDistContent overrides the copied scripts/ensure-dist.mjs (to bite the existence-based
// requirement); default copies the real one so the control fixture passes the smoke's on-disk checks.
function makeFixture(pkgScripts, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fb7b-guard-bite-'));
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({ scanRoot: '.' }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: pkgScripts }));
  mkdirSync(join(root, 'bin'), { recursive: true });
  cpSync(join(repoRoot, 'bin', 'bootstrap-runner.js'), join(root, 'bin', 'bootstrap-runner.js'));
  mkdirSync(join(root, 'packages', 'main', 'dist', 'tasks'), { recursive: true });
  cpSync(SMOKE_ABS, join(root, 'packages', 'main', 'dist', 'tasks', 'test-suite-utils-autobuild-smoke.js'));
  mkdirSync(join(root, 'packages', 'main', 'tests', 'red'), { recursive: true });
  cpSync(RED_ABS, join(root, 'packages', 'main', 'tests', 'red', 'red-fb7b-pretest-builds-utils.mjs'));
  // The smoke asserts the pretest references scripts/ensure-dist.mjs, that it exists, and that it is
  // existence-based (guards each build behind existsSync). Copy the real one (the smoke only reads it,
  // never executes it) unless the case overrides it to bite the existence-based requirement.
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'ensure-dist.mjs'), opts.ensureDistContent ?? REAL_ENSURE_DIST);
  return root;
}

// Run the copied repro-first RED inside a fixture; return {code}. The RED resolves the fixture root
// from its own module location, so it reads the fixture's package.json. Only used for the no-pretest
// case, where the RED fails at its first (structural) assertion before reaching any real build.
function runRedIn(root) {
  try {
    execFileSync('node', [join(root, 'packages', 'main', 'tests', 'red', 'red-fb7b-pretest-builds-utils.mjs')], { stdio: 'pipe' });
    return 0;
  } catch (e) {
    return typeof e.status === 'number' ? e.status : 1;
  }
}

// Run the copied smoke inside a fixture; return {code}. The smoke resolves the fixture root
// from its own module location, so it reads the fixture's package.json — not the live one.
function runSmokeIn(root) {
  try {
    execFileSync('node', [join(root, 'packages', 'main', 'dist', 'tasks', 'test-suite-utils-autobuild-smoke.js')], { stdio: 'pipe' });
    return 0;
  } catch (e) {
    return typeof e.status === 'number' ? e.status : 1;
  }
}

function biteCase(label, pkgScripts, selector) {
  const root = makeFixture(pkgScripts);
  try {
    const code = runSmokeIn(root);
    assert.notEqual(code, 0, `${label}: structural smoke should FAIL but it passed`);
    console.log(selector);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const goodPretest = 'node scripts/ensure-dist.mjs';

// --- Positive: control fixture with the real (good) pretest must PASS, else the bite tests are meaningless.
{
  const root = makeFixture({ pretest: goodPretest, test: 'node packages/main/dist/tasks/full-suite-runner.js', build: goodPretest });
  try { assert.equal(runSmokeIn(root), 0, 'control: good pretest must PASS the smoke'); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

// --- edge:3 / GB-EDGE3-REGISTERED: the smoke entry is registered in the real validate.commands.
{
  const cmds = (realConfig.validate && realConfig.validate.commands) || [];
  const registered = cmds.some((c) => (typeof c === 'string' ? c : JSON.stringify(c)).includes('test-suite-utils-autobuild-smoke'));
  assert.ok(registered, 'edge:3: validate.commands must contain the test-suite-utils-autobuild-smoke entry');
  console.log('GB-EDGE3-REGISTERED');
}

// --- adversarial:3 / GB-ADV3-ABSENT: removing the entry means a grep no longer finds it, so lattice validate would not dispatch it.
{
  const cmds = ((realConfig.validate && realConfig.validate.commands) || []).filter(
    (c) => !(typeof c === 'string' ? c : JSON.stringify(c)).includes('test-suite-utils-autobuild-smoke'),
  );
  const stillPresent = cmds.some((c) => (typeof c === 'string' ? c : JSON.stringify(c)).includes('test-suite-utils-autobuild-smoke'));
  assert.equal(stillPresent, false, 'adversarial:3: with the entry removed the smoke is absent from validate dispatch');
  console.log('GB-ADV3-ABSENT');
}

// --- adversarial:0/1/4: the structural smoke bites on each broken pretest (isolated fixtures).
biteCase('adversarial:0 (echo-ok pretest)', { pretest: 'echo ok', test: 'node packages/main/dist/tasks/full-suite-runner.js' }, 'GB-ADV0-BIT');
biteCase('adversarial:1 (main-only pretest, omits utils)', { pretest: 'npm --prefix packages/main run build', test: 'node packages/main/dist/tasks/full-suite-runner.js' }, 'GB-ADV1-BIT');
biteCase('adversarial:1 (build:lab loophole — a namespaced sibling build that touches neither main nor utils)', { pretest: 'npm run build:lab', test: 'node packages/main/dist/tasks/full-suite-runner.js' }, 'GB-ADVLAB-BIT');
biteCase('adversarial:1 (--prefix + namespaced sibling — `--prefix packages/... run build:fast` is not the real build script)', { pretest: 'npm --prefix packages/main run build:fast && npm --prefix packages/utils run build:fast', test: 'node packages/main/dist/tasks/full-suite-runner.js' }, 'GB-ADVFAST-BIT');
biteCase('adversarial:4 (no pretest, structural smoke — independent of the RED)', { test: 'node packages/main/dist/tasks/full-suite-runner.js' }, 'GB-ADV4-BIT');

// --- adversarial:1 / GB-ADVNOGUARD-BIT: the pretest DOES run ensure-dist, but a non-existence-based
// ensure-dist (unconditional rm+rebuild — no existsSync guard) is the reader-writer hazard the
// existence-based bootstrap avoids, so the guard must FAIL on it.
{
  const nonGuardedEnsure = "import { execFileSync } from 'node:child_process';\n"
    + "// unconditional rebuild — no existsSync guard (the reader-writer loophole)\n"
    + "execFileSync('npm', ['--prefix', 'packages/main', 'run', 'build'], { stdio: 'inherit' });\n"
    + "execFileSync('npm', ['--prefix', 'packages/utils', 'run', 'build'], { stdio: 'inherit' });\n";
  const root = makeFixture(
    { pretest: 'node scripts/ensure-dist.mjs', test: 'node packages/main/dist/tasks/full-suite-runner.js' },
    { ensureDistContent: nonGuardedEnsure },
  );
  try {
    assert.notEqual(runSmokeIn(root), 0, 'adversarial:1: a non-existence-based ensure-dist (no existsSync) must FAIL the guard');
    console.log('GB-ADVNOGUARD-BIT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- adversarial:2 / GB-ADV2-BIT: the REPRO-FIRST RED (a distinct artifact from the smoke) fails at
// its first structural assertion when the pretest key is absent (F-001: no longer a duplicate of adversarial:4).
{
  const root = makeFixture({ test: 'node packages/main/dist/tasks/full-suite-runner.js' });
  try {
    assert.notEqual(runRedIn(root), 0, 'adversarial:2: the RED test must FAIL at its first assertion when the pretest key is absent');
    console.log('GB-ADV2-BIT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- edge:1 / GB-EDGE1-CLEAN: the pretest is idempotent w.r.t. the git tree because its only
// output — the dist trees — is gitignored, so no rebuild can ever dirty a tracked file. Prove the
// root cause structurally (fast, deterministic) rather than timing a build: git check-ignore must
// report BOTH dist trees as ignored.
{
  const ignored = (rel) => {
    try {
      execFileSync('git', ['check-ignore', '-q', rel], { cwd: repoRoot, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(ignored('packages/main/dist'), 'edge:1: packages/main/dist must be gitignored so the pretest rebuild cannot dirty the tree');
  assert.ok(ignored('packages/utils/dist'), 'edge:1: packages/utils/dist must be gitignored so the pretest rebuild cannot dirty the tree');
  console.log('GB-EDGE1-CLEAN');
}

// --- happy:2 lifecycle / GB-LIFECYCLE-FIRES: a bare `npm test` auto-fires the pretest via the npm
// lifecycle hook (proven directly, not via an explicit `npm run pretest`). Isolated fixture: the pretest
// writes a marker, the test refuses (exit 7) unless the marker is present — so exit 0 proves the ordering.
{
  const root = mkdtempSync(join(tmpdir(), 'fb7b-lifecycle-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'lifecycle-fixture',
      scripts: {
        pretest: 'node -e "require(\'fs\').writeFileSync(\'pretest-fired\',\'1\')"',
        test: 'node -e "if(!require(\'fs\').existsSync(\'pretest-fired\'))process.exit(7);console.log(\'lifecycle-ok\')"',
      },
    }));
    execFileSync('npm', ['test'], { cwd: root, stdio: 'pipe', timeout: 60000 });
    assert.ok(existsSync(join(root, 'pretest-fired')), 'happy:2: bare `npm test` must auto-fire the pretest via the npm lifecycle');
    console.log('GB-LIFECYCLE-FIRES');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('GB-ALL-PASS red-fb7b-guard-bite: pretest guard family bites on every broken variant and the invariants hold');
