#!/usr/bin/env node
/**
 * B-fb7b + B-1734 guard-bite verifier — proves the structural smoke
 * (test-suite-utils-autobuild-smoke) actually BITES on each broken variant of the CONTENT-BOUND +
 * LOCKED build wiring, and confirms the positive invariants. Parallel-safe: every destructive case
 * runs against an ISOLATED temp fixture (the smoke walks up to the project config (either spelling) and reads the
 * fixture's files), never the live worktree.
 *
 * One selector per case (pin as tool-executed verification evidence):
 *   GB-EDGE3-REGISTERED   validate.commands contains the smoke entry
 *   GB-ADV3-ABSENT        removing that entry drops it from validate dispatch
 *   GB-NOPRETEST-BIT      no "pretest" -> smoke FAILS
 *   GB-NOENSURE-BIT       pretest not running ensure-dist -> smoke FAILS
 *   GB-ENSURE-EXISTENCE-BIT   existence-based ensure-dist (existsSync, no build-*-with-binding) -> smoke FAILS
 *   GB-ENSURE-ORDER-BIT   ensure-dist builds utils BEFORE main -> smoke FAILS
 *   GB-MAIN-NOVERIFY-BIT  build-main skips on existsSync (not verifyBuildBinding) -> smoke FAILS
 *   GB-MAIN-NOLOCK-BIT    build-main rebuilds WITHOUT withBuildLock -> smoke FAILS
 *   GB-UTILS-NOVERIFY-BIT build-utils omits verifyUtilsBuildBinding -> smoke FAILS
 *   GB-LOCK-RATIO-BIT     build-lock update >= stale/2 (age-steals a live holder) -> smoke FAILS
 *   GB-LOCK-NOLIB-BIT     build-lock does not use proper-lockfile -> smoke FAILS
 *   GB-UTILSPKG-TSC-BIT   packages/utils build script is a bare `tsc` -> smoke FAILS
 *   GB-RED-NOPRETEST      no pretest -> the repro-first RED FAILS at its first assertion
 *   GB-EDGE1-CLEAN        both dist trees are gitignored (rebuild cannot dirty the tree)
 *   GB-LIFECYCLE-FIRES    bare `npm test` auto-fires the pretest via the npm lifecycle hook
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(start) {
  let dir = start;
  while (!existsSync(join(dir, 'proof-or-stop.config.json')) && !existsSync(join(dir, 'proof-or-stop.config.json')) && dir !== dirname(dir)) dir = dirname(dir);
  return dir;
}
const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const SMOKE_REL = 'packages/main/dist/tasks/test-suite-utils-autobuild-smoke.js';
const SMOKE_ABS = join(repoRoot, SMOKE_REL);
assert.ok(existsSync(SMOKE_ABS), `compiled structural smoke missing (build packages/main first): ${SMOKE_REL}`);
const RED_REL = 'packages/main/tests/red/red-fb7b-pretest-builds-utils.mjs';
const RED_ABS = join(repoRoot, RED_REL);
assert.ok(existsSync(RED_ABS), `repro-first RED missing: ${RED_REL}`);

// B-cc10 F-037: read whichever config filename repoRoot actually has. The walk-up above was
// fixed to accept both spellings, but this read still hardcoded the deprecated one, so it
// threw ENOENT in a migrated worktree. Fixing a walk-up is not enough — every read anchored
// to the resolved root has to accept the same set of names.
const realConfigPath = ['proof-or-stop.config.json', 'proof-or-stop.config.json']
  .map((name) => join(repoRoot, name))
  .find((candidate) => existsSync(candidate)) ?? join(repoRoot, 'proof-or-stop.config.json');
const realConfig = JSON.parse(readFileSync(realConfigPath, 'utf8'));
const real = rel => readFileSync(join(repoRoot, rel), 'utf8');

// Files the smoke reads from repoRoot; a fixture copies the real ones unless a case overrides them.
const SCRIPT_FILES = [
  'scripts/ensure-dist.mjs',
  'scripts/build-main-with-binding.mjs',
  'scripts/build-utils-with-binding.mjs',
  'scripts/build-lock.mjs',
  // build-lock-target.mjs holds the dep-free BUILD_LOCK_STALE_MS the smoke now reads for `stale`.
  'scripts/build-lock-target.mjs',
];

const GOOD_SCRIPTS = { pretest: 'node scripts/ensure-dist.mjs', test: 'node packages/main/dist/tasks/full-suite-runner.js', build: 'node scripts/ensure-dist.mjs' };

// Build an isolated fixture root the smoke can resolve. `overrides` maps a repo-relative path to
// replacement content (to bite a specific assertion); everything else is the real file.
function makeFixture(pkgScripts, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fb7b-guard-bite-'));
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.' }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: pkgScripts }));
  mkdirSync(join(root, 'bin'), { recursive: true });
  cpSync(join(repoRoot, 'bin', 'bootstrap-runner.js'), join(root, 'bin', 'bootstrap-runner.js'));
  mkdirSync(join(root, 'packages', 'main', 'dist', 'tasks'), { recursive: true });
  cpSync(SMOKE_ABS, join(root, 'packages', 'main', 'dist', 'tasks', 'test-suite-utils-autobuild-smoke.js'));
  mkdirSync(join(root, 'packages', 'main', 'tests', 'red'), { recursive: true });
  cpSync(RED_ABS, join(root, 'packages', 'main', 'tests', 'red', 'red-fb7b-pretest-builds-utils.mjs'));
  const put = (rel, content) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const rel of SCRIPT_FILES) put(rel, rel in overrides ? overrides[rel] : real(rel));
  put('packages/utils/package.json', 'packages/utils/package.json' in overrides ? overrides['packages/utils/package.json'] : real('packages/utils/package.json'));
  return root;
}

function runSmokeIn(root) {
  try {
    execFileSync('node', [join(root, 'packages', 'main', 'dist', 'tasks', 'test-suite-utils-autobuild-smoke.js')], { stdio: 'pipe' });
    return 0;
  } catch (e) {
    return typeof e.status === 'number' ? e.status : 1;
  }
}
function runRedIn(root) {
  try {
    execFileSync('node', [join(root, 'packages', 'main', 'tests', 'red', 'red-fb7b-pretest-builds-utils.mjs')], { stdio: 'pipe' });
    return 0;
  } catch (e) {
    return typeof e.status === 'number' ? e.status : 1;
  }
}

function biteCase(label, pkgScripts, overrides, selector) {
  const root = makeFixture(pkgScripts, overrides);
  try {
    assert.notEqual(runSmokeIn(root), 0, `${label}: structural smoke should FAIL but it passed`);
    console.log(selector);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- Positive control: real scripts + good pretest must PASS, else the bite tests are meaningless.
{
  const root = makeFixture(GOOD_SCRIPTS);
  try { assert.equal(runSmokeIn(root), 0, 'control: real content-bound + locked wiring must PASS the smoke'); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

// --- edge:3 / GB-EDGE3-REGISTERED: the smoke entry is registered in the real validate.commands.
{
  const cmds = (realConfig.validate && realConfig.validate.commands) || [];
  const registered = cmds.some((c) => (typeof c === 'string' ? c : JSON.stringify(c)).includes('test-suite-utils-autobuild-smoke'));
  assert.ok(registered, 'edge:3: validate.commands must contain the test-suite-utils-autobuild-smoke entry');
  console.log('GB-EDGE3-REGISTERED');
}

// --- adversarial:3 / GB-ADV3-ABSENT: removing the entry drops it from validate dispatch.
{
  const cmds = ((realConfig.validate && realConfig.validate.commands) || []).filter(
    (c) => !(typeof c === 'string' ? c : JSON.stringify(c)).includes('test-suite-utils-autobuild-smoke'),
  );
  const stillPresent = cmds.some((c) => (typeof c === 'string' ? c : JSON.stringify(c)).includes('test-suite-utils-autobuild-smoke'));
  assert.equal(stillPresent, false, 'adversarial:3: with the entry removed the smoke is absent from validate dispatch');
  console.log('GB-ADV3-ABSENT');
}

// --- The structural smoke bites on each broken variant of the content-bound + locked wiring.
biteCase('no pretest', { test: GOOD_SCRIPTS.test }, {}, 'GB-NOPRETEST-BIT');
biteCase('pretest not running ensure-dist', { pretest: 'echo ok', test: GOOD_SCRIPTS.test }, {}, 'GB-NOENSURE-BIT');
biteCase(
  'existence-based ensure-dist (existsSync, no build-*-with-binding)',
  GOOD_SCRIPTS,
  {
    'scripts/ensure-dist.mjs':
      "import { existsSync } from 'node:fs';\nimport { execFileSync } from 'node:child_process';\n"
      + "function ensure(pkg){ if (existsSync('packages/'+pkg+'/dist/index.js')) return; execFileSync('npm',['--prefix','packages/'+pkg,'run','build']); }\n"
      + "ensure('main'); ensure('utils');\n",
  },
  'GB-ENSURE-EXISTENCE-BIT',
);
biteCase(
  'ensure-dist builds utils before main',
  GOOD_SCRIPTS,
  {
    'scripts/ensure-dist.mjs':
      "import { execFileSync } from 'node:child_process';\n"
      + "execFileSync(process.execPath, ['scripts/build-utils-with-binding.mjs']);\n"
      + "execFileSync(process.execPath, ['scripts/build-main-with-binding.mjs']);\n",
  },
  'GB-ENSURE-ORDER-BIT',
);
biteCase(
  'build-main skips on existsSync, not verifyBuildBinding',
  GOOD_SCRIPTS,
  {
    'scripts/build-main-with-binding.mjs':
      "import { existsSync } from 'node:fs';\nif (existsSync('packages/main/dist/index.js')) process.exit(0);\n// no verifyBuildBinding, no lock — the exact B-fb7b existence-only reuse\n",
  },
  'GB-MAIN-NOVERIFY-BIT',
);
biteCase(
  'build-main rebuilds without withBuildLock',
  GOOD_SCRIPTS,
  {
    'scripts/build-main-with-binding.mjs':
      "import { verifyBuildBinding, writeBuildBinding } from './full-suite-build-binding.mjs';\n"
      + "try { verifyBuildBinding(process.cwd()); process.exit(0); } catch {}\nwriteBuildBinding(process.cwd()); // rebuild WITHOUT a mutex\n",
  },
  'GB-MAIN-NOLOCK-BIT',
);
biteCase(
  'build-utils omits verifyUtilsBuildBinding',
  GOOD_SCRIPTS,
  {
    'scripts/build-utils-with-binding.mjs':
      "import { withBuildLock } from './build-lock.mjs';\nawait withBuildLock('utils', () => {});\n// no verifyUtilsBuildBinding — always rebuilds or never skips content-bound\n",
  },
  'GB-UTILS-NOVERIFY-BIT',
);
biteCase(
  'build-lock update >= stale/2 (age-steals a live holder)',
  GOOD_SCRIPTS,
  {
    'scripts/build-lock.mjs':
      "import lockfile from 'proper-lockfile';\nexport const BUILD_LOCK_OPTIONS = { stale: 30000, update: 20000 };\n// update >= stale/2 -> a live holder is age-stolen mid-build (B-fb7b finding #1)\n",
  },
  'GB-LOCK-RATIO-BIT',
);
biteCase(
  'build-lock does not use proper-lockfile',
  GOOD_SCRIPTS,
  {
    'scripts/build-lock.mjs':
      "export const BUILD_LOCK_OPTIONS = { stale: 30000, update: 10000 };\n// hand-rolled mkdir lock, not cross-platform / not race-safe\n",
  },
  'GB-LOCK-NOLIB-BIT',
);
biteCase(
  'packages/utils build is a bare tsc',
  GOOD_SCRIPTS,
  { 'packages/utils/package.json': JSON.stringify({ name: '@proof-or-stop/utils', scripts: { build: 'tsc' } }) },
  'GB-UTILSPKG-TSC-BIT',
);

// --- GB-RED-NOPRETEST: the repro-first RED (a distinct artifact) fails at its first assertion when
// the pretest key is absent.
{
  const root = makeFixture({ test: GOOD_SCRIPTS.test });
  try {
    assert.notEqual(runRedIn(root), 0, 'the RED must FAIL at its first assertion when the pretest key is absent');
    console.log('GB-RED-NOPRETEST');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- GB-EDGE1-CLEAN: both dist trees are gitignored, so a rebuild can never dirty a tracked file.
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

// --- GB-LIFECYCLE-FIRES: a bare `npm test` auto-fires the pretest via the npm lifecycle hook.
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

console.log('GB-ALL-PASS red-fb7b-guard-bite: the content-bound + locked build guard bites on every broken variant and the invariants hold');
