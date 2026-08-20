import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const distName = existsSync(join(packageRoot, 'dist', 'core', 'managed-markers.js'))
  ? 'dist'
  : 'dist.staging';
const distRoot = join(packageRoot, distName);

const markers = await import(join(distRoot, 'core/managed-markers.js'));
const sync = await import(join(distRoot, 'claude-md-sync.js'));
const assets = await import(join(distRoot, 'init-assets.js'));

const legacy = 'before\n<!-- lattice:start -->\nold\n<!-- lattice:end -->\nafter\n';
const replacement = '<!-- proof-or-stop:start -->\nnew\n<!-- proof-or-stop:end -->';
assert.equal(markers.inspectManagedBlock(legacy, 'document').status, 'valid');
assert.match(markers.replaceManagedBlock(legacy, replacement, 'document'), /<!-- proof-or-stop:start -->/);
assert.equal(markers.inspectManagedBlock('<!-- lattice:start -->\n<!-- lattice:start -->\nold\n<!-- lattice:end -->\n<!-- lattice:end -->').status, 'malformed');
assert.equal(markers.replaceManagedBlock(legacy.replace('<!-- lattice:end -->', '<!-- proof-or-stop:end -->'), replacement, 'document'), null);

const profile = sync.generateProfileSection('balanced');
assert.match(profile, /<!-- proof-or-stop-profile:start -->/);
assert.equal(markers.inspectManagedBlock(profile, 'profile').status, 'valid');
for (const name of ['AGENTS_MD_TEMPLATE', 'LATTICE_MD_TEMPLATE', 'CLAUDE_MD_TEMPLATE', 'LATTICE_DOT_DIR_MD_TEMPLATE', 'AGENTS_MD_GLOBAL_THIN_TEMPLATE']) {
  assert.match(assets[name], /<!-- proof-or-stop:start -->/);
  assert.match(assets[name], /<!-- proof-or-stop:end -->/);
}

console.log('managed-marker migration test passed');
