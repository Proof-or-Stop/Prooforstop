import assert from 'node:assert/strict';


import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ts from 'typescript';


import { scanText, scanImportSpecifiers, scanLegacyDeliveryCompatibilityUsage, shouldScanImports, scanDynamicCodeGeneration } from "./dynamic-scan.js";
import { listFilesFromRoot } from "./file-scan.js";
import { EXECUTABLE_SOURCE_EXTENSIONS, packageAliasEdgeInventoryHash, PACKAGE_ALIAS_MANIFEST_RECORDS, PACKAGE_ALIAS_EDGE_INVENTORY, PINNED_PACKAGE_ALIAS_EDGE_INVENTORY_HASH, PACKAGE_ALIAS_EDGE_INVENTORY_ALGORITHM, RETIRED_PACKAGE_SCOPE, packageSourceTarget, repoRoot, PackageAliasManifestRecord, buildPackageAliasEdgeInventory, resolvePackageAlias, LEGACY_DELIVERY_COMPAT_MODULE, deriveShippedPackageEntrypoints, SHIPPED_EXECUTABLE_ENTRYPOINTS, isExecutableSourceFile } from "./rule-data.js";
import { normalizeModulePath } from "./module-loaders.js";

export function assertPositiveControls(): void {
  const controls = [
    'Authority Server',
    'authorityDone',
    'fullAuthorityDone',
    'productionDone',
    'production authority',
    'Authority completion',
    'production completion',
    'production DONE',
    'PROOF_OR_STOP_AUTHORITY_URL',
    'authority_status',
  ];
  const violations = scanText('<positive-control>', controls.join('\n'));
  for (const control of controls) {
    assert.ok(
      violations.some(v => v.text.includes(control) || (control === 'PROOF_OR_STOP_AUTHORITY_URL' && v.label === 'PROOF_OR_STOP_AUTHORITY_*')),
      `positive control must catch ${control}`,
    );
  }

  const activeRendererControls = [
    'lines.push(`productionDone: ${result.productionDone}`);',
    "lines.push('authorityDone: false');",
    "lines.push('fullAuthorityDone: false');",
  ];
  const rendererViolations = scanText('packages/main/src/core/active-renderer.ts', activeRendererControls.join('\n'));
  for (const control of ['productionDone:', 'authorityDone:', 'fullAuthorityDone:']) {
    assert.ok(
      rendererViolations.some(v => v.text.includes(control)),
      `active renderer positive control must catch ${control}`,
    );
  }
}

export function assertImportSpecifierPositiveControls(): void {
  const controlFile = 'packages/main/src/core/active-runtime.ts';
  const violations = scanImportSpecifiers(controlFile, [
    "import { run } from '../handlers/story-authority-resolve.js';",
    "await import('./story-authority-resolver.js');",
  ].join('\n'));
  assert.ok(
    violations.some(v => v.text === '../handlers/story-authority-resolve.js'),
    'import guard must catch the retired story-authority-resolve handler',
  );
  assert.ok(
    violations.some(v => v.text === './story-authority-resolver.js'),
    'import guard must catch the retired story-authority-resolver core module',
  );
}

export function assertHermeticTraversalPositiveControls(): void {
  const root = mkdtempSync(join(tmpdir(), 'retired-authority-traversal-'));
  try {
    const target = join(root, 'z-target');
    mkdirSync(target);
    writeFileSync(join(target, 'protected.ts'), 'export const protectedValue = true;\n');
    symlinkSync('z-target', join(root, 'a-alias'));
    symlinkSync('.', join(target, 'self-cycle'));
    symlinkSync('..', join(target, 'back-edge'));
    assert.deepEqual(
      listFilesFromRoot(root, '.', EXECUTABLE_SOURCE_EXTENSIONS),
      ['z-target/protected.ts'],
      'alias-before-target and self/back-edge symlinks must be skipped while the canonical target is traversed exactly once',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertShippedExecutableRootPositiveControls(): void {
  const actualAliasInventoryHash = packageAliasEdgeInventoryHash(PACKAGE_ALIAS_MANIFEST_RECORDS, PACKAGE_ALIAS_EDGE_INVENTORY);
  assert.equal(
    actualAliasInventoryHash,
    PINNED_PACKAGE_ALIAS_EDGE_INVENTORY_HASH,
    `${PACKAGE_ALIAS_EDGE_INVENTORY_ALGORITHM}: package imports/self-exports edge inventory drift requires explicit review`,
  );
  const shippedPackageNames = new Set(PACKAGE_ALIAS_MANIFEST_RECORDS.map(record => record.manifest.name));
  assert.ok(shippedPackageNames.has('@proof-or-stop/utils'), 'reviewed alias inventory must include canonical @proof-or-stop/utils');
  assert.ok(shippedPackageNames.has('@proof-or-stop/lab'), 'reviewed alias inventory must include canonical @proof-or-stop/lab');
  assert.equal(
    [...shippedPackageNames].some(name => typeof name === 'string' && name.startsWith(RETIRED_PACKAGE_SCOPE)),
    false,
    'reviewed alias inventory must not retain retired package identities',
  );
  for (const edge of PACKAGE_ALIAS_EDGE_INVENTORY.filter(edge => !edge.targetPattern.includes('*'))) {
    const target = packageSourceTarget(edge, '');
    assert.ok(target && EXECUTABLE_SOURCE_EXTENSIONS.some(extension => existsSync(join(repoRoot, `${target}${extension}`))), `package alias edge must resolve to a source target: ${edge.specifierPattern}`);
  }
  const hermeticRecords: PackageAliasManifestRecord[] = [{
    path: 'packages/main/package.json',
    manifest: {
      name: '@proof-or-stop/core',
      imports: {
        '#compat': { node: './src/core/legacy-delivery-claims-compat.ts', default: './src/core/legacy-delivery-claims-compat.ts' },
        '#compat/*': './src/core/*.ts',
      },
      exports: { './compat': './src/core/legacy-delivery-claims-compat.ts' },
    },
  }];
  const hermeticEdges = buildPackageAliasEdgeInventory(hermeticRecords);
  const aliasControlFile = 'packages/main/src/package-alias-control.ts';
  for (const [label, specifier] of [
    ['package imports alias', '#compat'],
    ['conditional wildcard package imports alias', '#compat/legacy-delivery-claims-compat'],
    // B-cc10 F-009 follow-through: a self-reference specifier resolves against the
    // fixture manifest's OWN name, which this story renamed to @proof-or-stop/core just
    // above (line ~4061). Leaving the deprecated spelling here made the alias
    // unresolvable, so the guard failed on a name mismatch it created itself.
    ['package self-reference alias', '@proof-or-stop/core/compat'],
  ] as const) {
    assert.ok(
      resolvePackageAlias(aliasControlFile, specifier, hermeticEdges).targets.includes(normalizeModulePath(LEGACY_DELIVERY_COMPAT_MODULE)),
      `${label} must resolve through the manifest edge inventory`,
    );
    const source = `import { createLegacyLocalOnlyDeliveryClaims } from '${specifier}';\ncreateLegacyLocalOnlyDeliveryClaims();\n`;
    assert.ok(
      scanLegacyDeliveryCompatibilityUsage(aliasControlFile, source, undefined, hermeticEdges)
        .some(violation => violation.label === 'unapproved legacy delivery compatibility import'),
      `${label} must resolve end-to-end to the protected source target`,
    );
  }
  const mutatedRecords = structuredClone(hermeticRecords);
  (mutatedRecords[0].manifest.imports as Record<string, unknown>)['#new-bypass'] = './src/core/legacy-delivery-claims-compat.ts';
  assert.notEqual(
    packageAliasEdgeInventoryHash(hermeticRecords, hermeticEdges),
    packageAliasEdgeInventoryHash(mutatedRecords, buildPackageAliasEdgeInventory(mutatedRecords)),
    'changing package imports must change the pinned manifest-derived edge inventory fingerprint',
  );
  assert.ok(
    scanImportSpecifiers(aliasControlFile, "import '#unregistered-bypass';")
      .some(violation => violation.label === 'unresolved package import/self-reference alias'),
    'unknown package imports alias must fail closed',
  );
  assert.deepEqual(
    deriveShippedPackageEntrypoints(),
    SHIPPED_EXECUTABLE_ENTRYPOINTS.filter(entrypoint => entrypoint.startsWith('packages/')).sort(),
    'every package bin/exports target must derive to an explicitly pinned scanned source entrypoint',
  );
  for (const entrypoint of SHIPPED_EXECUTABLE_ENTRYPOINTS) {
    assert.equal(existsSync(join(repoRoot, entrypoint)), true, `pinned shipped executable entrypoint must exist: ${entrypoint}`);
    assert.equal(isExecutableSourceFile(entrypoint), true, `pinned shipped executable entrypoint must use a scanned extension: ${entrypoint}`);
  }
  // B-cc10 CHK-007: `bin/proofOrStop.js` was removed by CHK-006. This loop scans a
  // SYNTHETIC source string (no filesystem read), so it did not fail — but naming a
  // deleted file would let the case rot into testing nothing meaningful.
  for (const binEntrypoint of ['bin/proof-or-stop.js', 'bin/bootstrap-runner.js']) {
    const directBypass = "import { createLegacyLocalOnlyDeliveryClaims } from '../packages/main/src/core/legacy-delivery-claims-compat.js';\ncreateLegacyLocalOnlyDeliveryClaims();\n";
    assert.ok(
      scanLegacyDeliveryCompatibilityUsage(binEntrypoint, directBypass)
        .some(violation => violation.label === 'unapproved legacy delivery compatibility import'),
      `direct bin entrypoint compatibility import must be caught: ${binEntrypoint}`,
    );
  }
  for (const newFile of ['bin/new-cli-entrypoint.js', 'packages/lab/src/new-export.mts', 'packages/utils/src/new-register.cts']) {
    assert.equal(shouldScanImports(newFile), true, `new shipped executable file must enter import scanning: ${newFile}`);
    const dynamicViolations = scanDynamicCodeGeneration(newFile, "eval(\"import('./legacy-delivery-claims-compat.js')\")");
    assert.ok(
      dynamicViolations.some(violation => violation.label === 'dynamic code generation compatibility payload'),
      `new shipped executable file must enter dynamic-code scanning: ${newFile}; got ${JSON.stringify(dynamicViolations)}`,
    );
  }
}

export function assertNormalizedSpecifierPositiveControls(): void {
  const controlFile = 'packages/main/src/core/specifier-normalization-control.ts';
  for (const [label, source] of [
    ['query suffix', "import { createLegacyLocalOnlyDeliveryClaims } from './legacy-delivery-claims-compat.js?cache=1';"],
    ['fragment suffix', "import { createLegacyLocalOnlyDeliveryClaims } from './legacy-delivery-claims-compat.js#runtime';"],
    ['percent encoding', "import { createLegacyLocalOnlyDeliveryClaims } from './legacy%2Ddelivery%2Dclaims%2Dcompat.js';"],
    ['CJS query and fragment', "require('./legacy-delivery-claims-compat.js?cache=1#runtime');"],
  ] as const) {
    assert.ok(
      scanLegacyDeliveryCompatibilityUsage(controlFile, source)
        .some(violation => violation.label === 'unapproved legacy delivery compatibility import'),
      `${label} runtime-equivalent compatibility specifier must be caught`,
    );
  }
  assert.ok(
    scanImportSpecifiers(controlFile, "import './story%2Dauthority%2Dresolver.js?cache=1#runtime';")
      .some(violation => violation.label === 'retired story resolver module'),
    'percent-encoded query/fragment retired module specifier must be caught',
  );
  assert.ok(
    scanImportSpecifiers(controlFile, "import './legacy%ZZdelivery.js';")
      .some(violation => violation.label === 'malformed encoded static module specifier'),
    'malformed percent-encoded static module specifier must fail closed',
  );
}
