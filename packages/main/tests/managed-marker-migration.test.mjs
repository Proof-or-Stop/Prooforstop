import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const distName = existsSync(join(packageRoot, 'dist', 'core', 'managed-markers.js'))
  ? 'dist'
  : 'dist.staging';
const distRoot = join(packageRoot, distName);

const markers = await import(join(distRoot, 'core/managed-markers.js'));
const sync = await import(join(distRoot, 'claude-md-sync.js'));
const assets = await import(join(distRoot, 'init-assets.js'));

const residueSelfTest = execFileSync(process.execPath, [
  join(packageRoot, '..', '..', 'scripts/verify-lattice-residue.mjs'),
  '--self-test',
], { cwd: packageRoot, encoding: 'utf8' });
assert.match(residueSelfTest, /PASS lattice-residue self-test:/, 'residue detector distinguishes historical paths from active brand residue');

const legacy = 'before\n<!-- lattice:start -->\nold\n<!-- lattice:end -->\nafter\n';
const replacement = '<!-- proof-or-stop:start -->\nnew\n<!-- proof-or-stop:end -->';
assert.equal(markers.inspectManagedBlock(legacy, 'document').status, 'valid');
assert.match(markers.replaceManagedBlock(legacy, replacement, 'document'), /<!-- proof-or-stop:start -->/);
assert.equal(markers.inspectManagedBlock('<!-- lattice:start -->\n<!-- lattice:start -->\nold\n<!-- lattice:end -->\n<!-- lattice:end -->').status, 'malformed');
assert.equal(markers.replaceManagedBlock(legacy.replace('<!-- lattice:end -->', '<!-- proof-or-stop:end -->'), replacement, 'document'), null);

const profile = sync.generateProfileSection('balanced');
assert.match(profile, /<!-- proof-or-stop-profile:start -->/);
assert.match(profile, /must use the proof-or-stop-implementer subagent/);
assert.doesNotMatch(profile, /lattice-implementer/);
assert.equal(markers.inspectManagedBlock(profile, 'profile').status, 'valid');

const malformedProfileCases = [
  {
    name: 'nested',
    content: 'before\n<!-- lattice-profile:start -->\nlegacy\n<!-- lattice-profile:start -->\ninner\n<!-- lattice-profile:end -->\n<!-- lattice-profile:end -->\nafter\n',
  },
  {
    name: 'mixed',
    content: 'before\n<!-- lattice-profile:start -->\nlegacy\n<!-- proof-or-stop-profile:end -->\nafter\n',
  },
  {
    name: 'unterminated',
    content: 'before\n<!-- proof-or-stop-profile:start -->\nnew\nafter\n',
  },
];
const syncRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-marker-sync-'));
try {
  for (const { name, content } of malformedProfileCases) {
    assert.equal(
      markers.inspectManagedBlock(content, 'profile').status,
      'malformed',
      `${name} managed profile markers are rejected by the canonical parser`,
    );
    assert.equal(
      markers.replaceManagedBlock(content, profile, 'profile'),
      null,
      `${name} managed profile markers cannot be replaced`,
    );

    const malformedPath = join(syncRoot, `${name}.md`);
    writeFileSync(malformedPath, content);
    assert.equal(sync.syncProfileSection(malformedPath, 'balanced'), false, `${name} migration is refused`);
    assert.equal(readFileSync(malformedPath, 'utf8'), content, `${name} migration leaves the file unchanged`);
  }

  const claudePath = join(syncRoot, 'CLAUDE.md');
  writeFileSync(claudePath, 'before\n<!-- lattice-profile:start -->\nlegacy\n<!-- lattice-profile:end -->\nafter\n');
  assert.equal(sync.syncProfileSection(claudePath, 'balanced'), true);
  const synced = readFileSync(claudePath, 'utf8');
  assert.match(synced, /<!-- proof-or-stop-profile:start -->/);
  assert.doesNotMatch(synced, /<!-- lattice-profile:start -->/);
  assert.equal((synced.match(/proof-or-stop-profile:start/g) ?? []).length, 1);
} finally {
  rmSync(syncRoot, { recursive: true, force: true });
}
for (const name of ['AGENTS_MD_TEMPLATE', 'LATTICE_MD_TEMPLATE', 'CLAUDE_MD_TEMPLATE', 'LATTICE_DOT_DIR_MD_TEMPLATE', 'AGENTS_MD_GLOBAL_THIN_TEMPLATE']) {
  assert.match(assets[name], /<!-- proof-or-stop:start -->/);
  assert.match(assets[name], /<!-- proof-or-stop:end -->/);
}

console.log('managed-marker migration test passed');
