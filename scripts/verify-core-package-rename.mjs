#!/usr/bin/env node
/**
 * B-cc10 CHK-005 — verify the npm package rename @proof-or-stop/core -> @proof-or-stop/core.
 *
 * Three independent assertions, matching the item's three `must` verification intents:
 *
 *   happy       the renamed core package builds AND actually emits dist/cli-engine.js.
 *               Exit code alone is NOT sufficient: `npm --prefix packages/main run build`
 *               exits 0 while producing no dist when deps are missing, so the artifact is
 *               asserted separately.
 *
 *   edge        the sibling packages that declare a dependency on core resolve under the
 *               NEW name (packages/utils imports main's build output, so a stale reference
 *               would surface as a cross-package resolution break).
 *
 *   adversarial the root package identity and packages/main identity are both canonical.
 *               This catches a partial migration where the root still exposes the
 *               retired `lattice` package identity while the core package has moved.
 *
 * Read-only: asserts, never writes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CANONICAL_CORE = '@proof-or-stop/core';
const CANONICAL_ROOT = 'proof-or-stop';

const failures = [];

function readPackage(relPath) {
  const abs = join(repoRoot, relPath);
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, 'utf-8'));
  } catch {
    return null;
  }
}

function check(label, condition) {
  console.log(`${condition ? 'ok' : 'FAIL'} ${label}`);
  if (!condition) failures.push(label);
}

// ---- happy: renamed package builds and emits dist -------------------------
const corePkg = readPackage('packages/main/package.json');
const coreName = corePkg?.name ?? '<unreadable>';
console.log(`corePackageName=${coreName}`);
check('core package uses the canonical renamed name', coreName === CANONICAL_CORE);

const cliEngineExists = existsSync(join(repoRoot, 'packages/main/dist/cli-engine.js'));
console.log(`cliEngineExists=${cliEngineExists}`);
check('core build emitted dist/cli-engine.js (exit code alone is insufficient)', cliEngineExists);

// ---- edge: sibling packages resolve under the new name --------------------
for (const sibling of ['utils', 'lab']) {
  const pkg = readPackage(`packages/${sibling}/package.json`);
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.peerDependencies ?? {}) };
  const coreDeps = Object.keys(deps).filter(k => k.endsWith('/core'));
  console.log(`${sibling}DependsOn=${coreDeps.join(',') || '<none>'}`);
  check(
    `packages/${sibling} declares a dependency or peer dependency on ${CANONICAL_CORE}`,
    Object.prototype.hasOwnProperty.call(deps, CANONICAL_CORE),
  );
  check(
    `packages/${sibling} no longer references the deprecated core name`,
    !Object.prototype.hasOwnProperty.call(deps, RETIRED_CORE),
  );
}

const utilsDistExists = existsSync(join(repoRoot, 'packages/utils/dist/index.js'));
console.log(`utilsDistExists=${utilsDistExists}`);
check('packages/utils built against the renamed core (cross-package resolution intact)', utilsDistExists);

// ---- adversarial: the root package identity is migrated too ----------------
const rootPkg = readPackage('package.json');
const rootName = rootPkg?.name ?? '<unreadable>';
console.log(`rootPackageName=${rootName}`);
const rootIdentityMigrated = rootName === CANONICAL_ROOT && coreName === CANONICAL_CORE;
console.log(`rootIdentityMigrated=${rootIdentityMigrated}`);
check(
  `ROOT package name is "${CANONICAL_ROOT}" while core is renamed`,
  rootIdentityMigrated,
);

// B-cc10 F-024: the failure gate MOVED to the very end of this file. It used to sit
// here, BEFORE the repo-wide sweep below, so any failure the sweep found printed 'FAIL'
// and then fell through to 'verified' and exit 0 — a fail-OPEN witness, which is worse
// than no witness because it launders a green result. Every check must be registered
// before the single gate runs.

// B-cc10 F-009: the CHK-005 adversarial intent asks for a repo-wide check that
// @proof-or-stop/core no longer appears outside node_modules / dist / the state dirs. The
// checks above only covered dependency declarations plus the root name.
//
// IMPORTANT scoping, learned by getting it wrong first: a naive "any mention" grep
// reports 25 files, nearly all of them CORRECT. The deprecated name legitimately
// appears in (a) read-both compatibility probes that accept EITHER spelling
// (.githooks/pre-push, runtime-environment-checks, worktree, codex-adapter-checks,
// rollout-check, test-auto, init-assets), (b) guard scripts that pin the literal on
// purpose, and (c) docs/decision records that quote the old name to explain the
// rename. Banning those would delete the compatibility this story promised.
//
// So the real invariant is: the deprecated name must never appear WITHOUT the
// canonical name alongside it in the same file. A file that mentions only the old
// spelling has not been migrated; a file that mentions both is read-both by design.
{
  // maxBuffer: `git ls-files` output crossed Node's 1MB execFileSync default as the
  // repo grew (14997 files / ~1.05MB), which surfaced as `spawnSync git ENOBUFS` with
  // `status: 0` -- git itself succeeded and only the capture buffer overflowed, so the
  // failure looked like a rename regression rather than a size limit. 64MB leaves
  // decades of headroom; do not drop this back to the default.
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .trim().split('\n').filter(Boolean);
  const skip = (f) =>
    f.includes('node_modules/') || f.includes('/dist/') || f.startsWith('dist/')
    || f.startsWith('.proof-or-stop/') || f.startsWith(RETIRED_STATE_PREFIX)
    || f === 'CHANGELOG.md'             // historical release record (FROZEN)
    // brand-rename-mapping.md is the FROZEN decision record that quotes the OLD name to
    // explain why each identity was or was not renamed; rewriting it would destroy the
    // very history it exists to preserve. Exempt with a reason, not silently skipped.
    || f === 'docs/requirements/decisions/brand-rename-mapping.md';
  const deprecatedOnly = [];
  for (const f of tracked) {
    if (skip(f)) continue;
    let body = '';
    try { body = readFileSync(f, 'utf8'); } catch { continue; }
    if (!body.includes(RETIRED_CORE)) continue;
    if (!body.includes('@proof-or-stop/core')) deprecatedOnly.push(f);
  }
  console.log(`deprecatedCoreNameWithoutCanonical=${deprecatedOnly.length}`);
  if (deprecatedOnly.length > 0) {
    console.log(`  stranded: ${deprecatedOnly.join(', ')}`);
  }
  check(
    'every @proof-or-stop/core mention sits beside the canonical name (read-both), none stranded',
    deprecatedOnly.length === 0,
  );
}

if (failures.length > 0) {
  console.error(`\ncore package rename verification FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('\ncore package rename verified');
