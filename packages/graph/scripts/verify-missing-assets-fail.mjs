/**
 * Proves a missing browser client never results in serving a blank page.
 *
 * This is pre-mortem scenario 1 from the story's decision.json: a command that starts a
 * server but 404s on app.html looks registered and working while rendering nothing, which
 * is worse than failing. The invariant is "never serve a client-less page" -- NOT one
 * specific mechanism for upholding it.
 *
 * B-5a15: main commit 3aa57145 ("graph: fail loudly on missing d3; build the browser
 * client on demand") changed HOW that invariant is met. `graph` now rebuilds the client
 * on demand, so a stashed app.html is regenerated and the command serves correctly
 * instead of refusing. The old assertions demanded the refusal wording ("app.html" and
 * "npm --prefix packages/graph run build") and therefore failed on main itself -- the
 * commit updated the behavior but not this verifier. Verified failing on the main
 * checkout at 3aa57145 with d3 and assets present, so this was pre-existing breakage,
 * not worktree drift.
 *
 * Two admissible outcomes now satisfy the invariant:
 *   (a) rebuild-and-serve -- the asset is regenerated, exists again, and is served; or
 *   (b) refuse-before-listening -- non-zero exit, no listener, and the message names the
 *       missing file plus the build command that produces it.
 * Serving while the client is still missing remains a hard failure in both branches.
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

  // Branch (a): the client was rebuilt on demand. The asset must actually exist again --
  // "it printed that it was building" is not proof the output landed.
  const rebuilt = fs.existsSync(asset);
  let mode;
  if (rebuilt) {
    mode = 'rebuilt-on-demand';
    if (!out.includes('building browser client')) {
      failures.push('asset reappeared but the run never announced the on-demand build');
    }
  } else {
    // Branch (b): no rebuild, so the run MUST have refused before listening and said why.
    mode = 'refused';
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
  }

  if (!failures.length) console.log(`missing client handled by ${mode}: never served a client-less page`);
} finally {
  fs.renameSync(stash, asset);
}

if (failures.length) {
  console.error('MISSING_ASSET_HANDLING_BROKEN');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('MISSING_ASSETS_FAIL_LOUDLY_OK');
