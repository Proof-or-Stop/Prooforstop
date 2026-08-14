import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const BUILD_BINDING_SCHEMA = 'lattice.main-build-binding.v1';
export const BUILD_MANIFEST = 'packages/main/dist/full-suite-build-binding.json';

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

export function treeDigest(projectRoot, kind) {
  const base = join(projectRoot, 'packages/main', kind);
  const files = filesBelow(base).filter(path => kind !== 'dist' || relative(base, path) !== 'full-suite-build-binding.json');
  const hash = createHash('sha256');
  for (const path of files) hash.update(relative(base, path)).update('\0').update(readFileSync(path)).update('\0');
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

export function verifyBuildBinding(projectRoot) {
  const manifest = JSON.parse(readFileSync(join(projectRoot, BUILD_MANIFEST), 'utf8'));
  if (manifest.schema !== BUILD_BINDING_SCHEMA || manifest.sourceDigest !== treeDigest(projectRoot, 'src') || manifest.distDigest !== treeDigest(projectRoot, 'dist')) {
    throw new Error('stale full-suite dist: source/dist build binding mismatch');
  }
  return manifest;
}
