/**
 * Proves a missing browser client fails loudly instead of serving a blank page.
 *
 * This is pre-mortem scenario 1 from the story's decision.json: a command that starts a
 * server but 404s on app.html looks registered and working while rendering nothing, which
 * is worse than failing. The command must refuse BEFORE listening, and the message must
 * name the missing file and the build command that produces it.
 *
 * The asset is moved aside and restored in a finally block, so a failure cannot leave the
 * working tree without its built client.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const pkgRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const repo = path.resolve(pkgRoot, '..', '..');
const asset = path.join(pkgRoot, 'assets', 'app.html');
const stash = path.join(pkgRoot, 'assets', '.app.html.verify-stash');
const PORT = Number(process.env.GRAPH_VERIFY_PORT ?? 8819);

if (!fs.existsSync(asset)) {
  console.error('PRECONDITION_FAILED: assets/app.html is not built; run the build first.');
  process.exit(1);
}

const failures = [];
fs.renameSync(asset, stash);
try {
  let out = '';
  let exitCode = 0;
  try {
    out = execFileSync('node', ['bin/proof-or-stop.js', 'graph', '--no-open', `--port=${PORT}`],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  } catch (e) {
    exitCode = typeof e.status === 'number' ? e.status : 1;
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
  }

  if (exitCode === 0) failures.push('command exited 0 with no browser client — it should refuse');
  for (const needle of ['app.html', 'npm --prefix packages/graph run build']) {
    if (!out.includes(needle)) failures.push(`failure message does not name ${JSON.stringify(needle)}`);
  }
  // It must refuse before listening at all.
  try {
    const held = execFileSync('lsof', ['-ti', `:${PORT}`], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] })
      .split('\n').filter(Boolean);
    if (held.length) failures.push(`a listener was left on ${PORT}: ${held.join(',')}`);
  } catch { /* nothing listening: correct */ }

  if (!failures.length) console.log(`refused with exit ${exitCode}, named the asset and the build command, started no listener`);
} finally {
  fs.renameSync(stash, asset);
}

if (failures.length) {
  console.error('MISSING_ASSET_HANDLING_BROKEN');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('MISSING_ASSETS_FAIL_LOUDLY_OK');
