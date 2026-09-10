await import('./value-binding-diagnostics.mjs');
await import('./shared-identity-ownership.mjs');
const {spawnSync} = await import('node:child_process');
const {default:assert} = await import('node:assert/strict');
for (const group of ['identity-sites', 'identity-inventory']) {
  const result = spawnSync(process.execPath,
    ['packages/main/tests/canonical-new-story-artifacts.test.mjs', '--group='+group],
    {cwd:new URL('../../',import.meta.url),encoding:'utf8',maxBuffer:16*1024*1024});
  process.stdout.write(result.stdout ?? '');process.stderr.write(result.stderr ?? '');
  assert.equal(result.status,0,'current identity preconditions: '+group);
}
await import('./observe-reuse.mjs');
