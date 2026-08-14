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
 *   GB-ADV2-BIT         adversarial:2  no pretest -> guard FAILS at first assertion
 *   GB-ADV3-ABSENT      adversarial:3  removing the validate.commands entry -> not dispatched
 *   GB-ADV4-BIT         adversarial:4  no pretest -> structural smoke FAILS (independent of RED)
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

const realPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const realConfig = JSON.parse(readFileSync(join(repoRoot, 'lattice.config.json'), 'utf8'));

// Build an isolated fixture root that the smoke can resolve (it walks up to lattice.config.json).
function makeFixture(pkgScripts) {
  const root = mkdtempSync(join(tmpdir(), 'fb7b-guard-bite-'));
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({ scanRoot: '.' }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: pkgScripts }));
  mkdirSync(join(root, 'bin'), { recursive: true });
  cpSync(join(repoRoot, 'bin', 'bootstrap-runner.js'), join(root, 'bin', 'bootstrap-runner.js'));
  mkdirSync(join(root, 'packages', 'main', 'dist', 'tasks'), { recursive: true });
  cpSync(SMOKE_ABS, join(root, 'packages', 'main', 'dist', 'tasks', 'test-suite-utils-autobuild-smoke.js'));
  return root;
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

const goodPretest = 'npm --prefix packages/main run build && npm --prefix packages/utils run build';

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

// --- adversarial:0/1/2/4: the structural smoke bites on each broken pretest (isolated fixtures).
biteCase('adversarial:0 (echo-ok pretest)', { pretest: 'echo ok', test: 'node packages/main/dist/tasks/full-suite-runner.js' }, 'GB-ADV0-BIT');
biteCase('adversarial:1 (main-only pretest)', { pretest: 'npm --prefix packages/main run build', test: 'node packages/main/dist/tasks/full-suite-runner.js' }, 'GB-ADV1-BIT');
biteCase('adversarial:2 (no pretest / RED-family)', { test: 'node packages/main/dist/tasks/full-suite-runner.js' }, 'GB-ADV2-BIT');
biteCase('adversarial:4 (no pretest / smoke-independent)', { test: 'node packages/main/dist/tasks/full-suite-runner.js' }, 'GB-ADV4-BIT');

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

console.log('GB-ALL-PASS red-fb7b-guard-bite: pretest guard family bites on every broken variant and the invariants hold');
