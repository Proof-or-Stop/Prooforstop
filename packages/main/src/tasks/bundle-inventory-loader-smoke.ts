#!/usr/bin/env node
/**
 * certification-window's Review Inventory admit APIs must resolve inside the
 * CLI bundle exactly as in the per-file graph. They used to be loaded through
 * createRequire(import.meta.url)('./review-inventory-epoch.js') to dodge an
 * import cycle; in a bundle import.meta.url is the bundle file, the sibling is
 * absent, and the loader silently returned null (PRE_CERT_INVENTORY_API_ABSENT
 * instead of the real inventory probe).
 *
 * Bundles dist/core/certification-window.js with the same esbuild settings as
 * scripts/build-cli-bundle.mjs into a temporary package directory and requires every
 * admit API to be present, per-file and bundled. Needs the repository's esbuild
 * (a root devDependency).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const distRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(distRoot, '..', '..', '..');
const ADMIT_APIS = [
  'finalizedUnconsumedReviewInventory',
  'consumeReviewInventoryCompletenessReceipt',
  'consumeReviewInventoryCompletenessReceiptUnlocked',
  'verifyReviewInventoryEpoch',
  'verifyReviewInventoryReceipt',
  'isInventoryCompletenessOnlyReceipt',
];

type Loader = { loadReviewInventoryAdmitApis(): Record<string, unknown> | null };
const describe = (apis: Record<string, unknown> | null): string[] | null =>
  apis ? ADMIT_APIS.filter(name => typeof apis[name] === 'function') : null;

const perFile = await import(pathToFileURL(join(distRoot, 'core', 'certification-window.js')).href) as Loader;
assert.deepEqual(describe(perFile.loadReviewInventoryAdmitApis()), ADMIT_APIS, 'per-file graph must load every admit API');

const { build } = await import(pathToFileURL(join(repoRoot, 'node_modules', 'esbuild', 'lib', 'main.js')).href) as {
  build(options: Record<string, unknown>): Promise<unknown>;
};
// Inside the package (not os.tmpdir) so externals resolve like dist/ does.
const temp = mkdtempSync(join(distRoot, '..', '.bundle-inventory-loader-'));
try {
  const outfile = join(temp, 'certification-window.bundle.mjs');
  await build({
    entryPoints: [join(distRoot, 'core', 'certification-window.js')],
    outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20',
    external: ['typescript', '@proof-or-stop/*', 'bufferutil', 'utf-8-validate'],
    nodePaths: [join(repoRoot, 'node_modules')],
    define: { __PROOF_OR_STOP_BUNDLED__: 'true' },
    banner: { js: "import { createRequire as __proofOrStopCreateRequire } from 'node:module';\nconst require = __proofOrStopCreateRequire(import.meta.url);" },
    logLevel: 'error',
  });
  const bundled = await import(pathToFileURL(outfile).href) as Loader;
  assert.deepEqual(describe(bundled.loadReviewInventoryAdmitApis()), ADMIT_APIS,
    'bundled certification-window must load every admit API (got null: the loader resolved a sibling file next to the bundle)');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log(`bundle-inventory-loader-smoke: PASS (${ADMIT_APIS.length} admit APIs per-file and bundled)`);
