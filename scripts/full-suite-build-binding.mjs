import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const BUILD_BINDING_SCHEMA = 'proof-or-stop.main-build-binding.v1';
export const BUILD_MANIFEST = 'packages/main/dist/full-suite-build-binding.json';
export const UTILS_BUILD_BINDING_SCHEMA = 'proof-or-stop.utils-build-binding.v1';
export const BUILD_UTILS_MANIFEST = 'packages/utils/dist/full-suite-build-binding.json';

// Both bindings live inside their dist tree; a tree digest never folds its own
// manifest in (it changes every write), so we always skip this basename.
const BINDING_BASENAME = 'full-suite-build-binding.json';

function filesBelow(root) {
  const result = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result.push(path);
    }
  };
  visit(root);
  return result.sort();
}

// Fold every file below `base` (relative path + content) into `hash`, skipping
// the binding manifest itself. This is the shared primitive behind both the main
// and utils digests.
function hashTreeInto(hash, base) {
  const files = filesBelow(base).filter(path => relative(base, path) !== BINDING_BASENAME);
  for (const path of files) hash.update(relative(base, path)).update('\0').update(readFileSync(path)).update('\0');
}

// packages/main src|dist digest. kind='src' also folds in tsconfig+package.json.
// Byte-identical to the pre-B-1734 implementation, so an existing valid main
// binding stays valid across this refactor.
export function treeDigest(projectRoot, kind) {
  const hash = createHash('sha256');
  hashTreeInto(hash, join(projectRoot, 'packages/main', kind));
  if (kind === 'src') {
    for (const name of ['tsconfig.json', 'package.json']) hash.update(name).update('\0').update(readFileSync(join(projectRoot, 'packages/main', name))).update('\0');
  }
  return hash.digest('hex');
}

export function writeBuildBinding(projectRoot) {
  const manifest = { schema: BUILD_BINDING_SCHEMA, sourceDigest: treeDigest(projectRoot, 'src'), distDigest: treeDigest(projectRoot, 'dist') };
  writeFileSync(join(projectRoot, BUILD_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// Read-only freshness proof for a child reusing build preparation: recompute
// source/config and output bytes; the stored manifest alone grants no freshness.
export function verifyBuildBinding(projectRoot) {
  const manifest = JSON.parse(readFileSync(join(projectRoot, BUILD_MANIFEST), 'utf8'));
  if (manifest.schema !== BUILD_BINDING_SCHEMA || manifest.sourceDigest !== treeDigest(projectRoot, 'src') || manifest.distDigest !== treeDigest(projectRoot, 'dist')) {
    throw new Error('stale full-suite dist: source/dist build binding mismatch');
  }
  return manifest;
}

// packages/utils source digest: utils/src + utils tsconfig + utils package.json,
// AND the packages/main/dist tree — because `tsc -p packages/utils/tsconfig.json`
// links against main/dist for @proof-or-stop/core types, so utils is stale whenever
// main/dist changes (edge:2 / the utils-links-main invariant).
export function utilsSourceDigest(projectRoot) {
  const hash = createHash('sha256');
  hashTreeInto(hash, join(projectRoot, 'packages/utils/src'));
  for (const name of ['tsconfig.json', 'package.json']) hash.update(`utils/${name}`).update('\0').update(readFileSync(join(projectRoot, 'packages/utils', name))).update('\0');
  hashTreeInto(hash, join(projectRoot, 'packages/main/dist')); // utils tsc links against main/dist
  return hash.digest('hex');
}

export function utilsDistDigest(projectRoot) {
  const hash = createHash('sha256');
  hashTreeInto(hash, join(projectRoot, 'packages/utils/dist'));
  return hash.digest('hex');
}

export function writeUtilsBuildBinding(projectRoot) {
  const manifest = { schema: UTILS_BUILD_BINDING_SCHEMA, sourceDigest: utilsSourceDigest(projectRoot), distDigest: utilsDistDigest(projectRoot) };
  writeFileSync(join(projectRoot, BUILD_UTILS_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// Utils also binds current main output, so a shared prerequisite must verify
// both package bindings before starting another proof body.
export function verifyUtilsBuildBinding(projectRoot) {
  const manifest = JSON.parse(readFileSync(join(projectRoot, BUILD_UTILS_MANIFEST), 'utf8'));
  if (manifest.schema !== UTILS_BUILD_BINDING_SCHEMA || manifest.sourceDigest !== utilsSourceDigest(projectRoot) || manifest.distDigest !== utilsDistDigest(projectRoot)) {
    throw new Error('stale utils dist: source/dist build binding mismatch');
  }
  return manifest;
}
