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
const { runManagedAssetCheck } = await import(join(distRoot, 'core/managed-assets.js'));

const residueSelfTest = execFileSync(process.execPath, [
  join(packageRoot, '..', '..', 'scripts/verify-proof-or-stop-residue.mjs'),
  '--self-test',
], { cwd: packageRoot, encoding: 'utf8' });
assert.match(residueSelfTest, /PASS proof-or-stop-residue self-test:/, 'residue detector distinguishes historical paths from active brand residue');

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
for (const name of ['AGENTS_MD_TEMPLATE', 'PROOF_OR_STOP_MD_TEMPLATE', 'CLAUDE_MD_TEMPLATE', 'PROOF_OR_STOP_DOT_DIR_MD_TEMPLATE', 'AGENTS_MD_GLOBAL_THIN_TEMPLATE']) {
  assert.match(assets[name], /<!-- proof-or-stop:start -->/);
  assert.match(assets[name], /<!-- proof-or-stop:end -->/);
}

const checkRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-marker-freshness-'));
try {
  const agentsPath = join(checkRoot, 'AGENTS.md');
  const retiredAgents = assets.AGENTS_MD_TEMPLATE
    .replace('<!-- proof-or-stop:end -->', [
      '# AGENTS.md',
      'Current lifecycle override',
      'proof-or-stop session_brief',
      'proof-or-stop codex verify',
      'Two-Layer Process Fact Contract',
      'Story Phase Transitions',
      'Fail-fast policy',
      '<!-- proof-or-stop:end -->',
    ].join('\n'))
    .replaceAll('<!-- proof-or-stop:start -->', '<!-- lattice:start -->')
    .replaceAll('<!-- proof-or-stop:end -->', '<!-- lattice:end -->');
  writeFileSync(agentsPath, retiredAgents);
  const options = { profile: 'codex', assetMode: 'full' };
  const agentsItem = result => result.items.find(item => item.id === 'doc:AGENTS.md');
  assert.equal(agentsItem(runManagedAssetCheck(checkRoot, { ...options, assetMode: 'global-thin' }))?.status, 'STALE_SAFE', 'global-thin checking requires explicit marker migration');
  const check = runManagedAssetCheck(checkRoot, options);
  assert.equal(agentsItem(check)?.status, 'STALE_SAFE', 'normal checking never treats retired marker assets as fresh canonical assets');
  assert.equal(readFileSync(agentsPath, 'utf8'), retiredAgents, 'read-only checking preserves retired marker bytes');
  runManagedAssetCheck(checkRoot, { ...options, apply: true });
  const migratedAgents = readFileSync(agentsPath, 'utf8');
  assert.match(migratedAgents, /<!-- proof-or-stop:start -->/);
  assert.doesNotMatch(migratedAgents, /<!-- lattice:(?:start|end) -->/);
  assert.equal(agentsItem(runManagedAssetCheck(checkRoot, options))?.status, 'OK', 'explicit migration produces fresh canonical assets');

  for (const malformed of [
    retiredAgents.replace('<!-- lattice:end -->', '<!-- proof-or-stop:end -->'),
    retiredAgents.replace('<!-- lattice:start -->', '<!-- lattice:start -->\n<!-- lattice:start -->'),
  ]) {
    writeFileSync(agentsPath, malformed);
    assert.equal(agentsItem(runManagedAssetCheck(checkRoot, { ...options, apply: true }))?.status, 'INCOMPATIBLE');
    assert.equal(readFileSync(agentsPath, 'utf8'), malformed, 'explicit apply preserves malformed or mixed marker bytes');
  }
} finally {
  rmSync(checkRoot, { recursive: true, force: true });
}

console.log('managed-marker migration test passed');
