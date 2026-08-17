#!/usr/bin/env node
/**
 * B-cc10 CHK-005 — verify the npm package rename @lattice/core -> @proof-or-stop/core.
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
 *   adversarial the OQ-2 scope boundary still holds: the ROOT package name stays `lattice`
 *               while packages/main is `@proof-or-stop/core`. This is the assertion that
 *               would otherwise regress SILENTLY — a future sweep that "finishes the
 *               rename" by renaming the root would violate the recorded scope boundary
 *               (docs/requirements/decisions/proof-or-stop-identity-migration.md, and
 *               brand-rename-mapping.md:131 which freezes the root as a publish-level
 *               change owned by its own story). Renaming the root makes this exit non-zero.
 *
 * Read-only: asserts, never writes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CANONICAL_CORE = '@proof-or-stop/core';
const FROZEN_ROOT = 'lattice';

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
  const deps = pkg?.dependencies ?? {};
  const coreDeps = Object.keys(deps).filter(k => k.endsWith('/core'));
  console.log(`${sibling}DependsOn=${coreDeps.join(',') || '<none>'}`);
  check(
    `packages/${sibling} depends on ${CANONICAL_CORE}`,
    Object.prototype.hasOwnProperty.call(deps, CANONICAL_CORE),
  );
  check(
    `packages/${sibling} no longer references the deprecated core name`,
    !Object.prototype.hasOwnProperty.call(deps, '@lattice/core'),
  );
}

const utilsDistExists = existsSync(join(repoRoot, 'packages/utils/dist/index.js'));
console.log(`utilsDistExists=${utilsDistExists}`);
check('packages/utils built against the renamed core (cross-package resolution intact)', utilsDistExists);

// ---- adversarial: the OQ-2 boundary must NOT be "helpfully" completed ----
const rootPkg = readPackage('package.json');
const rootName = rootPkg?.name ?? '<unreadable>';
console.log(`rootPackageName=${rootName}`);
const oq2BoundaryHeld = rootName === FROZEN_ROOT && coreName === CANONICAL_CORE;
console.log(`oq2BoundaryHeld=${oq2BoundaryHeld}`);
check(
  `ROOT package name stays "${FROZEN_ROOT}" (OQ-2 exclusion) while core is renamed`,
  oq2BoundaryHeld,
);

if (failures.length > 0) {
  console.error(`\ncore package rename verification FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('\ncore package rename verified');
