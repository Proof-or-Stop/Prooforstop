#!/usr/bin/env node
/**
 * RED (repro-first) for draft `global-cli-worktree-drift` (global Proof-or-Stop
 * runtime unreliable across builds / worktrees).
 *
 * Observed on main (2026-09-02, 0.3.271):
 *   $ proof-or-stop session_brief
 *   (eval):1: permission denied: proof-or-stop
 *   $ ls -la packages/main/dist/cli.js
 *   -rw-r--r--@ 1 jek  staff  1933 Sep  2 13:29 packages/main/dist/cli.js
 *   /opt/homebrew/bin/proof-or-stop -> ../lib/node_modules/@proof-or-stop/core/dist/cli.js
 *   (the global symlink itself is correct: it resolves into this repo's main
 *    checkout; the earlier symptom from the draft was the link resolving into
 *    .worktrees/B-fe8f)
 *
 * Mechanism: packages/main/package.json declares bin.proof-or-stop = dist/cli.js.
 * `npm link` / global install chmods that target ONCE at install time. But
 * scripts/build-main-with-binding.mjs rebuilds dist by `tsc --outDir dist.staging`
 * + atomic rename (scripts/promote-dist.mjs): tsc emits fresh files with mode
 * 0644, and neither script restores the executable bit on bin targets. So every
 * rebuild that actually re-emits silently breaks the global executable until
 * someone chmods it by hand.
 *
 * DESIRED property (asserted here, hermetically):
 *   - a tsc emit of a shebang'd entry produces a NON-executable file (documents
 *     why the pipeline must restore the bit; expected to hold before and after);
 *   - the build pipeline (build-main-with-binding.mjs + promote-dist.mjs) restores
 *     the executable bit on every package.json `bin` target after promotion.
 *     Pre-fix: no such step exists -> RED. Post-fix -> GREEN.
 *   - the live dist bin target, if present, is executable (live check; may pass
 *     spuriously after a manual chmod, so the pipeline check above is primary).
 *   - HERMETIC (B-e256 CHK-002): `restoreBinExecutableBits(dist)` exported from
 *     scripts/promote-dist.mjs (a) turns a 0644 package.json `bin` target
 *     executable with byte-identical content and returns ['dist/cli.js'];
 *     (b) returns [] without throwing when the bin target is absent;
 *     (c) returns [] without throwing when package.json has no `bin`, is
 *     unparseable, or is missing. Pre-fix main has no such export: the import
 *     failure is reported as a RED case (not a crash).
 *   - HERMETIC (B-e256 CHK-001 follow-up, Codex cross-host MAJOR finding): (d) a
 *     NON-ENOENT stat/chmod failure on an existing bin target PROPAGATES (only an
 *     absent target is benign; a swallowed EACCES/EROFS left a non-executable
 *     global bin that the content-bound fast path never repaired); (e) promoteDist
 *     restores the bit on the STAGING tree, so the promoted dist bin target is
 *     executable and trash is gone; (f) when that staging restoration fails,
 *     promoteDist throws BEFORE evicting the old dist (previous working dist kept,
 *     no trash). (d)/(f) rely on a 0o000 parent directory and are skipped with a
 *     printed note when running as root (root ignores mode bits).
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-global-cli-exec-bit.mjs
 * Point it at another checkout (read-only, e.g. unfixed main) with:
 *   RED_REPO_ROOT=/path/to/checkout node packages/main/tests/red/red-global-cli-exec-bit.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = process.env.RED_REPO_ROOT ?? here;
while (!existsSync(join(repoRoot, 'proof-or-stop.config.json')) && repoRoot !== dirname(repoRoot)) repoRoot = dirname(repoRoot);
assert.ok(existsSync(join(repoRoot, 'proof-or-stop.config.json')), 'could not locate repo root (proof-or-stop.config.json)');

const pkg = JSON.parse(readFileSync(join(repoRoot, 'packages/main/package.json'), 'utf8'));
const binTargets = Object.values(pkg.bin ?? {});
assert.ok(binTargets.length > 0, 'packages/main/package.json must declare bin targets');
console.log(`bin targets: ${binTargets.join(', ')}`);

const failures = [];
function expect(label, fn) {
  try { fn(); console.log(`GREEN ${label}`); }
  catch (err) { failures.push(`${label}\n    ${String(err.message).split('\n').join('\n    ')}`); console.log(`RED   ${label}\n    ${err.message}`); }
}

// 1. tsc emit never sets the executable bit (hermetic fixture)
const tmp = mkdtempSync(join(tmpdir(), 'red-exec-bit-'));
try {
  writeFileSync(join(tmp, 'entry.ts'), '#!/usr/bin/env node\nexport const x = 1;\n');
  writeFileSync(join(tmp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'es2022', module: 'es2022', outDir: 'out' }, files: ['entry.ts'] }));
  const tsc = join(repoRoot, 'node_modules/typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', join(tmp, 'tsconfig.json')], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
  const mode = statSync(join(tmp, 'out/entry.js')).mode & 0o777;
  console.log(`tsc-emitted shebang file mode: 0${mode.toString(8)} (executable bits: ${(mode & 0o111) !== 0})`);
  assert.equal(mode & 0o111, 0, 'tsc unexpectedly emitted an executable file');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// 2. the build pipeline must restore the bit on bin targets
const pipeline = ['scripts/build-main-with-binding.mjs', 'scripts/promote-dist.mjs'];
const pipelineText = pipeline.map((rel) => readFileSync(join(repoRoot, rel), 'utf8')).join('\n');
const restoresBit = /chmod(Sync)?\s*\(/.test(pipelineText) && /\bbin\b/.test(pipelineText);
console.log(`pipeline restores bin executable bit: ${restoresBit} (${pipeline.join(' + ')})`);
expect('build pipeline restores the executable bit on package.json bin targets after promoting dist', () => {
  assert.equal(restoresBit, true, `neither ${pipeline.join(' nor ')} chmods the bin target(s) ${binTargets.join(', ')} after a rebuild; a re-emitted dist/cli.js is 0644 and the global symlink dies with "permission denied"`);
});

// 3. live check (secondary; a manual chmod can make this pass without fixing the pipeline)
for (const rel of binTargets) {
  const abs = join(repoRoot, 'packages/main', rel);
  if (!existsSync(abs)) { console.log(`live: ${rel} absent (dist not built) -- skipped`); continue; }
  const mode = statSync(abs).mode & 0o777;
  console.log(`live: packages/main/${rel} mode 0${mode.toString(8)}`);
  expect(`live: packages/main/${rel} is executable`, () => assert.notEqual(mode & 0o111, 0, `packages/main/${rel} is not executable (mode 0${mode.toString(8)})`));
}

// 4. hermetic: restoreBinExecutableBits(dist) from scripts/promote-dist.mjs (B-e256 CHK-002)
const promoteDistPath = join(repoRoot, 'scripts/promote-dist.mjs');
let restoreBinExecutableBits = null;
let promoteDist = null;
try {
  const mod = await import(pathToFileURL(promoteDistPath).href);
  restoreBinExecutableBits = typeof mod.restoreBinExecutableBits === 'function' ? mod.restoreBinExecutableBits : null;
  promoteDist = typeof mod.promoteDist === 'function' ? mod.promoteDist : null;
} catch (err) {
  console.log(`hermetic: import of ${promoteDistPath} failed: ${err.message}`);
}
console.log(`hermetic: scripts/promote-dist.mjs exports restoreBinExecutableBits: ${restoreBinExecutableBits !== null}`);
expect('hermetic: scripts/promote-dist.mjs exports restoreBinExecutableBits(dist)', () => {
  assert.notEqual(restoreBinExecutableBits, null, `${promoteDistPath} does not export a restoreBinExecutableBits function (unfixed pipeline)`);
});

// Build a throwaway package `<pkgRoot>/package.json` + `<pkgRoot>/dist/...` and call the
// export on `<pkgRoot>/dist`, mirroring how promoteDist derives packageRoot = dirname(dist).
function withTempPackage(fn) {
  const pkgRoot = mkdtempSync(join(tmpdir(), 'red-exec-bit-pkg-'));
  try { return fn(pkgRoot, join(pkgRoot, 'dist')); }
  finally { rmSync(pkgRoot, { recursive: true, force: true }); }
}
const CLI_BODY = '#!/usr/bin/env node\nconsole.log("hello from a rebuilt bin target");\n';

// (a) 0644 bin target becomes executable, content byte-identical, returned list is ['dist/cli.js']
expect('hermetic (a): a 0644 package.json bin target becomes executable with byte-identical content and is reported as restored', () => {
  assert.notEqual(restoreBinExecutableBits, null, 'restoreBinExecutableBits is not available (see the export case above)');
  withTempPackage((pkgRoot, dist) => {
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'red-exec-bit-fixture', bin: { 'red-exec-bit': 'dist/cli.js' } }));
    const target = join(dist, 'cli.js');
    writeFileSync(target, CLI_BODY);
    chmodSync(target, 0o644);
    const before = statSync(target).mode & 0o777;
    assert.equal(before & 0o111, 0, `fixture setup: expected a non-executable bin target, got 0${before.toString(8)}`);
    const restored = restoreBinExecutableBits(dist);
    const after = statSync(target).mode & 0o777;
    console.log(`hermetic (a): dist/cli.js mode 0${before.toString(8)} -> 0${after.toString(8)}; restored=${JSON.stringify(restored)}`);
    assert.deepEqual(restored, ['dist/cli.js'], 'restored list must name exactly the bin target');
    assert.equal(after & 0o111, 0o111, `bin target still lacks executable bits (mode 0${after.toString(8)})`);
    assert.equal(after & 0o644, 0o644, `original permission bits must be preserved (mode 0${after.toString(8)})`);
    assert.equal(readFileSync(target, 'utf8'), CLI_BODY, 'bin target content changed');
  });
});

// (b) absent bin target: [] without throwing
expect('hermetic (b): an absent bin target returns [] without throwing', () => {
  assert.notEqual(restoreBinExecutableBits, null, 'restoreBinExecutableBits is not available (see the export case above)');
  withTempPackage((pkgRoot, dist) => {
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'red-exec-bit-fixture', bin: { 'red-exec-bit': 'dist/cli.js' } }));
    let restored;
    assert.doesNotThrow(() => { restored = restoreBinExecutableBits(dist); }, 'absent bin target must be a no-op, not an error');
    assert.deepEqual(restored, [], `expected [] for an absent bin target, got ${JSON.stringify(restored)}`);
  });
});

// (c) package.json with no bin / unparseable / missing: [] without throwing
expect('hermetic (c): package.json with no bin field, unparseable package.json and missing package.json each return [] without throwing', () => {
  assert.notEqual(restoreBinExecutableBits, null, 'restoreBinExecutableBits is not available (see the export case above)');
  const variants = [
    ['no bin field', (pkgRoot) => writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'red-exec-bit-fixture' }))],
    ['unparseable package.json', (pkgRoot) => writeFileSync(join(pkgRoot, 'package.json'), '{ this is not json')],
    ['missing package.json', () => {}],
  ];
  for (const [label, setup] of variants) {
    withTempPackage((pkgRoot, dist) => {
      mkdirSync(dist, { recursive: true });
      setup(pkgRoot);
      // a stray dist/cli.js must NOT be touched when package.json declares nothing usable
      const stray = join(dist, 'cli.js');
      writeFileSync(stray, CLI_BODY);
      chmodSync(stray, 0o644);
      let restored;
      assert.doesNotThrow(() => { restored = restoreBinExecutableBits(dist); }, `${label}: must not throw`);
      assert.deepEqual(restored, [], `${label}: expected [], got ${JSON.stringify(restored)}`);
      const mode = statSync(stray).mode & 0o777;
      assert.equal(mode & 0o111, 0, `${label}: undeclared dist/cli.js was chmodded (mode 0${mode.toString(8)})`);
      console.log(`hermetic (c): ${label} -> ${JSON.stringify(restored)}`);
    });
  }
});

expect('hermetic (c2): string-shorthand and multiple bin declarations restore every byte-identical target', () => {
  assert.notEqual(restoreBinExecutableBits, null, 'restoreBinExecutableBits is not available');
  const manifests = [
    ['string shorthand', 'dist/cli.js', ['dist/cli.js']],
    ['multiple targets', { first: 'dist/cli.js', second: 'dist/helper.js' }, ['dist/cli.js', 'dist/helper.js']],
  ];
  for (const [label, bin, expected] of manifests) {
    withTempPackage((pkgRoot, dist) => {
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'red-exec-bit-fixture', bin }));
      for (const rel of expected) {
        writeFileSync(join(pkgRoot, rel), `${CLI_BODY}${rel}\n`);
        chmodSync(join(pkgRoot, rel), 0o644);
      }
      const before = expected.map((rel) => readFileSync(join(pkgRoot, rel), 'utf8'));
      assert.deepEqual(restoreBinExecutableBits(dist), expected, `${label}: restored list`);
      expected.forEach((rel, index) => {
        assert.notEqual(statSync(join(pkgRoot, rel)).mode & 0o111, 0, `${label}: ${rel} must be executable`);
        assert.equal(readFileSync(join(pkgRoot, rel), 'utf8'), before[index], `${label}: ${rel} content changed`);
      });
    });
  }
});

expect('hermetic (c3): an in-dist basename beginning with two dots is not mistaken for parent traversal', () => {
  assert.notEqual(restoreBinExecutableBits, null, 'restoreBinExecutableBits is not available');
  withTempPackage((pkgRoot, dist) => {
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'red-exec-bit-fixture', bin: 'dist/..cli.js' }));
    const target = join(dist, '..cli.js');
    writeFileSync(target, CLI_BODY);
    chmodSync(target, 0o644);
    assert.deepEqual(restoreBinExecutableBits(dist), ['dist/..cli.js']);
    assert.notEqual(statSync(target).mode & 0o111, 0, 'valid dot-prefixed target must become executable');
  });
});

expect('hermetic (c4): a directory declared as a bin target is rejected before promotion', () => {
  assert.notEqual(promoteDist, null, 'promoteDist is not available');
  withTempPackage((pkgRoot, dist) => {
    const staging = join(pkgRoot, 'dist.staging');
    const trash = join(pkgRoot, 'dist.trash');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'cli.js'), CLI_BODY);
    chmodSync(join(dist, 'cli.js'), 0o755);
    mkdirSync(join(staging, 'cli.js'), { recursive: true });
    chmodSync(join(staging, 'cli.js'), 0o644);
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'red-exec-bit-fixture', bin: 'dist/cli.js' }));
    assert.throws(() => promoteDist(dist, staging, trash), (error) => error?.code === 'EINVAL' && /not a regular file/.test(error.message));
    assert.equal(readFileSync(join(dist, 'cli.js'), 'utf8'), CLI_BODY, 'old dist must remain untouched');
    assert.ok(existsSync(staging), 'malformed staging tree must not be promoted');
    assert.ok(!existsSync(trash), 'old dist must not be evicted');
  });
});

expect('hermetic (c5): an in-tree symlink cannot chmod a referent outside the promoted tree', () => {
  assert.notEqual(restoreBinExecutableBits, null, 'restoreBinExecutableBits is not available');
  withTempPackage((pkgRoot, dist) => {
    mkdirSync(dist, { recursive: true });
    const outside = join(pkgRoot, 'outside.js');
    writeFileSync(outside, CLI_BODY);
    chmodSync(outside, 0o644);
    symlinkSync(outside, join(dist, 'cli.js'));
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'red-exec-bit-fixture', bin: 'dist/cli.js' }));
    assert.throws(() => restoreBinExecutableBits(dist), (error) => error?.code === 'EINVAL' && /not a regular file/.test(error.message));
    assert.equal(statSync(outside).mode & 0o777, 0o644, 'outside referent permissions must remain unchanged');
  });
});

// (d) a NON-ENOENT failure on an existing bin target must propagate (only an absent target is benign).
// Simulated hermetically: the bin target exists but its parent directory is 0o000, so stat() fails with
// EACCES (not ENOENT). Root ignores mode bits, so the case is skipped (with a note) when uid === 0.
const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : userInfo().uid === 0;
if (isRoot) console.log('hermetic (d)/(f): running as root (uid 0) — mode-bit denial cannot be simulated; skipped');
expect('hermetic (d): a non-ENOENT stat/chmod failure on an existing bin target propagates instead of being swallowed', () => {
  assert.notEqual(restoreBinExecutableBits, null, 'restoreBinExecutableBits is not available (see the export case above)');
  if (isRoot) return;
  withTempPackage((pkgRoot, dist) => {
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'red-exec-bit-fixture', bin: { 'red-exec-bit': 'dist/cli.js' } }));
    const target = join(dist, 'cli.js');
    writeFileSync(target, CLI_BODY);
    chmodSync(target, 0o644);
    chmodSync(dist, 0o000);
    try {
      let thrown = null;
      try { restoreBinExecutableBits(dist); } catch (err) { thrown = err; }
      console.log(`hermetic (d): dist 0000 -> restoreBinExecutableBits threw code=${thrown && thrown.code}`);
      assert.notEqual(thrown, null, 'an EACCES on an EXISTING bin target was swallowed; promotion would report success with a non-executable bin');
      assert.notEqual(thrown.code, 'ENOENT', `expected a non-ENOENT failure to surface, got ${thrown.code}`);
      assert.match(thrown.message, /dist\/cli\.js/, 'the propagated error must name the bin target');
    } finally {
      chmodSync(dist, 0o755);
    }
    const mode = statSync(target).mode & 0o777;
    assert.equal(mode & 0o111, 0, `fixture sanity: the target must still be 0644 (mode 0${mode.toString(8)})`);
  });
});

// (e) promoteDist restores the bit on the STAGING tree, so the promoted dist bin target is executable.
const STAGING_BODY = '#!/usr/bin/env node\nconsole.log("hello from the freshly emitted bin target");\n';
expect('hermetic (e): promoteDist restores the executable bit on the staging tree so the promoted dist bin target is executable', () => {
  assert.notEqual(promoteDist, null, `${promoteDistPath} does not export promoteDist`);
  withTempPackage((pkgRoot, dist) => {
    const staging = join(pkgRoot, 'dist.staging');
    const trash = join(pkgRoot, 'dist.trash');
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'red-exec-bit-fixture', bin: { 'red-exec-bit': 'dist/cli.js' } }));
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'cli.js'), CLI_BODY);
    chmodSync(join(dist, 'cli.js'), 0o755);
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'cli.js'), STAGING_BODY);
    chmodSync(join(staging, 'cli.js'), 0o644);
    const before = statSync(join(staging, 'cli.js')).mode & 0o777;
    assert.equal(before & 0o111, 0, `fixture setup: expected a non-executable staging bin target, got 0${before.toString(8)}`);
    promoteDist(dist, staging, trash);
    const target = join(dist, 'cli.js');
    const after = statSync(target).mode & 0o777;
    console.log(`hermetic (e): staging dist/cli.js mode 0${before.toString(8)} -> promoted 0${after.toString(8)}; staging=${existsSync(staging)} trash=${existsSync(trash)}`);
    assert.equal(readFileSync(target, 'utf8'), STAGING_BODY, 'promoted dist must contain the staging tree');
    assert.equal(after & 0o111, 0o111, `promoted bin target lacks executable bits (mode 0${after.toString(8)})`);
    assert.equal(after & 0o644, 0o644, `original permission bits must be preserved (mode 0${after.toString(8)})`);
    assert.ok(!existsSync(staging), 'staging must have been moved into place');
    assert.ok(!existsSync(trash), 'trash must be removed after a successful promotion');
  });
});

// (f) a failing staging restoration aborts promotion BEFORE the old dist is evicted (previous working dist kept).
expect('hermetic (f): a failed staging executable-bit restoration aborts promotion before the old dist is evicted', () => {
  assert.notEqual(promoteDist, null, `${promoteDistPath} does not export promoteDist`);
  if (isRoot) return;
  withTempPackage((pkgRoot, dist) => {
    const staging = join(pkgRoot, 'dist.staging');
    const trash = join(pkgRoot, 'dist.trash');
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'red-exec-bit-fixture', bin: { 'red-exec-bit': 'dist/cli.js' } }));
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'cli.js'), CLI_BODY);
    chmodSync(join(dist, 'cli.js'), 0o755);
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'cli.js'), STAGING_BODY);
    chmodSync(join(staging, 'cli.js'), 0o644);
    chmodSync(staging, 0o000);
    try {
      let thrown = null;
      try { promoteDist(dist, staging, trash); } catch (err) { thrown = err; }
      console.log(`hermetic (f): staging 0000 -> promoteDist threw code=${thrown && thrown.code}; dist=${existsSync(dist)} staging=${existsSync(staging)} trash=${existsSync(trash)}`);
      assert.notEqual(thrown, null, 'promoteDist reported success although the staging bin target could not be made executable');
      assert.notEqual(thrown.code, 'ENOENT', `expected a non-ENOENT failure to surface, got ${thrown.code}`);
      assert.ok(existsSync(dist), 'the previous working dist must still be in place');
      assert.equal(readFileSync(join(dist, 'cli.js'), 'utf8'), CLI_BODY, 'the previous dist must be untouched (never evicted)');
      const mode = statSync(join(dist, 'cli.js')).mode & 0o777;
      assert.equal(mode & 0o111, 0o111, `the previous dist bin target must stay executable (mode 0${mode.toString(8)})`);
      assert.ok(existsSync(staging), 'staging must be left where it was (promotion aborted before any rename)');
      assert.ok(!existsSync(trash), 'no trash must exist: the old dist was never evicted');
    } finally {
      chmodSync(staging, 0o755);
    }
  });
});

if (failures.length > 0) {
  console.error(`\nRED red-global-cli-exec-bit: ${failures.length} desired propert${failures.length === 1 ? 'y' : 'ies'} not met (pre-fix defect present):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\nGREEN red-global-cli-exec-bit: rebuilds keep the global bin target executable');
