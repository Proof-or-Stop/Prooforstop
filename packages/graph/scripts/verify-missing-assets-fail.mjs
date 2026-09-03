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
 *   (a) rebuild-and-serve -- the asset is regenerated AND actually served over HTTP; or
 *   (b) refuse-before-listening -- non-zero exit, no listener, and the message names the
 *       missing file plus the build command that produces it.
 * Serving while the client is still missing remains a hard failure in both branches.
 *
 * B-5a15:F-371 -- an earlier version of branch (a) checked only `existsSync(asset)` plus
 * the presence of the log line "graph: building browser client...". That line is printed
 * at graph.ts:113 inside ensureGraphClientBuilt (called at :424) BEFORE startServer is
 * reached (:436), and the check issued no HTTP request at all, so a run that rebuilt the
 * asset but then failed to serve it would still have been recorded as a pass. Branch (a)
 * therefore now GETs the client from the live server and requires a 200 whose body
 * carries real client markup -- the invariant says "never serve a client-less page", so
 * "served" has to be measured, not inferred from a build log.
 *
 * The asset is moved aside and restored in a finally block, so a failure cannot leave the
 * working tree without its built client.
 */
import { execFileSync, spawn } from 'node:child_process';
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

  // Branch (a): the client was rebuilt on demand. Existence of the asset is necessary but
  // NOT sufficient (B-5a15:F-371) -- the invariant is about SERVING, so re-run the command
  // as a live server and GET the client over HTTP.
  const rebuilt = fs.existsSync(asset);
  let mode;
  if (rebuilt) {
    mode = 'rebuilt-on-demand';
    if (!out.includes('building browser client')) {
      failures.push('asset reappeared but the run never announced the on-demand build');
    }
    // Stash it again so the live run must genuinely rebuild before it can serve.
    fs.renameSync(asset, stash);
    const served = await serveAndFetch();
    if (!served.ok) {
      failures.push(`rebuilt-on-demand did not serve the client: ${served.reason}`);
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
  // The live-serve probe in branch (a) may itself have rebuilt `asset`. Restoring must
  // therefore tolerate either state: prefer the stashed original, and drop the stash if
  // a fresh build already put a real client back in place. Never leave the tree without
  // its built client, and never leave a stray stash behind.
  if (fs.existsSync(stash)) {
    if (fs.existsSync(asset)) fs.rmSync(stash);
    else fs.renameSync(stash, asset);
  }
}

if (failures.length) {
  console.error('MISSING_ASSET_HANDLING_BROKEN');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('MISSING_ASSETS_FAIL_LOUDLY_OK');

/**
 * Runs `graph` as a live server, GETs `/` once it is listening, and returns whether a
 * real client page came back. Proves the "serve" half of the invariant that an
 * existsSync check cannot: a rebuild that lands but never serves must fail.
 */
async function serveAndFetch() {
  const child = spawn('node', ['bin/proof-or-stop.js', 'graph', '--no-open', `--port=${PORT}`],
    { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  try {
    const deadline = Date.now() + 90_000;
    let body = null;
    let status = 0;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        return { ok: false, reason: `server exited early with code ${child.exitCode}` };
      }
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/`);
        status = res.status;
        body = await res.text();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (body === null) return { ok: false, reason: 'server never answered on the port' };
    if (status !== 200) return { ok: false, reason: `GET / returned ${status}` };
    // A blank/placeholder page is exactly what this verifier exists to catch.
    if (body.length < 1000 || !/<(script|div|body)/i.test(body)) {
      return { ok: false, reason: `GET / returned ${body.length} bytes with no client markup` };
    }
    if (!fs.existsSync(asset)) {
      return { ok: false, reason: 'served a page but assets/app.html was never rebuilt' };
    }
    return { ok: true };
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
