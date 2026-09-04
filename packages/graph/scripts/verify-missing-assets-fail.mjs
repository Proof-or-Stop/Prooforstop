/**
 * Proves a missing browser client is never silently served as a blank page.
 *
 * Pre-mortem scenario 1 from B-3e16's decision.json is that a command which starts a
 * server but 404s on app.html looks registered and working while rendering nothing, which
 * is worse than failing. That invariant still holds; HOW it is satisfied changed.
 *
 * main commit 3aa57145d8 replaced the refuse-before-listen path with
 * `ensureGraphClientBuilt` (packages/main/src/handlers/graph.ts): a missing client is now
 * REBUILT on demand rather than reported, because packages/graph is not an npm workspace
 * and both its node_modules/ and assets/ are gitignored, so a fresh clone or worktree
 * legitimately has neither. This verifier was still asserting the old contract and so
 * failed against the new handler; it now asserts the new one.
 *
 * What is checked, and why each half matters:
 *   1. RECOVERY — with assets/app.html removed, the command must rebuild it and serve
 *      normally. This is the behavior 3aa57145d8 introduced.
 *   2. NO SILENT BLANK PAGE — the original safety property, unchanged: the command must
 *      never end up listening while the client is still missing. If recovery cannot
 *      produce app.html, the command must fail before binding a port and say so.
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
const rebuiltStash = `${asset}.rebuilt-probe`;
const PORT = Number(process.env.GRAPH_VERIFY_PORT ?? 8819);

if (!fs.existsSync(asset)) {
  console.error('PRECONDITION_FAILED: assets/app.html is not built; run the build first.');
  process.exit(1);
}

const failures = [];
fs.renameSync(asset, stash);
async function serveAndFetch() {
  const child = spawn('node', ['bin/proof-or-stop.js', 'graph', '--no-open', `--port=${PORT}`],
    { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  // B-5a15:F-379 -- without this listener a spawn-level failure (ENOENT, EACCES) is
  // emitted as an unhandled 'error' event and takes down the whole verifier, so a real
  // environment problem would surface as a crash instead of this script's own
  // MISSING_ASSET_HANDLING_BROKEN report. Capture it and let the caller decide.
  let spawnError = null;
  child.on('error', (e) => { spawnError = e; });
  try {
    const deadline = Date.now() + 90_000;
    let body = null;
    let status = 0;
    // B-5a15:F-379 -- every failure reason below quotes the child's own output, which was
    // previously captured into `log` and then discarded, making "exited early" undebuggable.
    const tail = () => {
      const t = log.trim().split('\n').slice(-6).join(' | ');
      return t ? ` -- child output: ${t}` : ' -- child produced no output';
    };
    while (Date.now() < deadline) {
      if (spawnError) return { ok: false, reason: `could not spawn the server: ${spawnError.message}` };
      if (child.exitCode !== null) {
        return { ok: false, reason: `server exited early with code ${child.exitCode}${tail()}` };
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
    if (body === null) return { ok: false, reason: `server never answered on the port${tail()}` };
    if (status !== 200) return { ok: false, reason: `GET / returned ${status}${tail()}` };
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

  // Our own listener must be stopped BEFORE sampling, and UNCONDITIONALLY.
  //
  // Two defects this ordering fixes, both found by review:
  //   - RACE: execFileSync's timeout can fire while the child is still inside its own
  //     `npm run build`, so a single fs.existsSync() sample taken immediately after can
  //     read false for a rebuild that succeeds moments later. Stopping the child first
  //     makes the sample deterministic: once it is dead, assets/app.html stops changing.
  //   - LEAK: cleanup used to be gated behind `if (rebuilt)`, so in exactly the branch
  //     where a leaked listener matters most (recovery believed impossible) the still
  //     serving process was neither killed nor reported. It is now always stopped, and
  //     separately still REPORTED as a failure in that branch.
  const ours = (pid) => {
    try {
      return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
        .includes('proof-or-stop');
    } catch { return false }
  };
  const listeners = () => {
    try {
      return execFileSync('lsof', ['-ti', `:${PORT}`], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] })
        .split('\n').filter(Boolean).filter(ours);
    } catch { return [] }
  };
  const leaked = listeners();
  for (const pid of leaked) { try { process.kill(Number(pid), 'SIGKILL') } catch { /* already gone */ } }

  // Settle UNCONDITIONALLY, and by polling rather than by a blind sleep.
  //
  // An earlier version armed the settle only `if (leaked.length)`, which review showed
  // misses the worse window. ensureGraphClientBuilt runs `npm run build` through a
  // SYNCHRONOUS spawnSync, so while that build is in flight the command has not bound the
  // port yet. If execFileSync's timeout fires during the build, the SIGTERM reaches only
  // our direct child; the nested build is orphaned and keeps writing assets/app.html. In
  // that case `leaked` is empty -- nothing was ever listening -- so the settle was skipped
  // and `rebuilt` was sampled with zero delay against a file still being written.
  //
  // Polling for the asset is both stricter and faster than a fixed sleep: it returns as
  // soon as the orphan finishes, and it waits the full budget when it never does. The
  // budget is deliberately longer than a slow rebuild's tail so a true negative (recovery
  // genuinely impossible) still costs it in full, which is the correct trade for a check
  // that must not report a working rebuild as broken.
  const settleDeadline = Date.now() + 15_000;
  while (!fs.existsSync(asset) && Date.now() < settleDeadline) {
    execFileSync('sleep', ['0.25']);
  }

  const rebuilt = fs.existsSync(asset);

  if (rebuilt) {
    // Scenario 1: on-demand recovery. The handler rebuilt the client, so the command is
    // allowed to have served. What must NOT happen is serving a client that is missing or
    // corrupt, so presence of app.html alone is NOT sufficient evidence of recovery.
    //
    // An earlier version of this branch accepted `fs.existsSync(asset)` plus an output
    // substring, which a review negative control showed would pass for a handler that
    // wrote ANY bytes to assets/app.html (truncated, stale or corrupt) and logged the
    // right words. These assertions close that: the rebuilt client must be a real built
    // page, and the d3 bundle that ensureGraphClientBuilt also requires must be present.
    if (!out.includes('building browser client') && !out.includes('graph serving')) {
      failures.push('client was rebuilt but the command never reported building or serving');
    }
    const html = fs.readFileSync(asset, 'utf8');
    if (!html.includes('<!doctype html') && !html.includes('<!DOCTYPE html')) {
      failures.push('rebuilt app.html is not an HTML document');
    }
    // The real build inlines the app shell; a stub or truncated file will not carry it.
    if (!html.includes('openStoryDossier')) {
      failures.push('rebuilt app.html does not contain the built client (no openStoryDossier)');
    }
    if (html.length < 100_000) {
      failures.push(`rebuilt app.html is implausibly small (${html.length} bytes) for a built client`);
    }
    // ensureGraphClientBuilt treats the d3 bundle as required output alongside app.html,
    // because a build without dependencies still emits app.html while omitting d3 and the
    // page then silently falls back to a different renderer.
    const d3 = path.join(pkgRoot, 'assets', 'd3.min.js');
    if (!fs.existsSync(d3)) {
      failures.push('recovery produced app.html but not the required d3.min.js bundle');
    }

    // B-5a15:F-371 -- the content assertions above prove the rebuilt FILE is a real built
    // client, but the invariant this script protects is "never SERVE a client-less page".
    // A handler that rebuilds correctly and then fails to serve it would satisfy every
    // check above, so measure serving instead of inferring it from a build log: stash the
    // regenerated asset, re-run as a live server, and GET the client over HTTP.
    // B-5a15:F-377/F-383 -- park it under its own path, never onto `stash`: renameSync
    // overwrites its destination, so reusing `stash` would discard the true pre-verifier
    // app.html and leave the finally block restoring a rebuilt copy instead.
    fs.renameSync(asset, rebuiltStash);
    const served = await serveAndFetch();
    if (!served.ok) {
      failures.push(`rebuilt-on-demand did not serve the client: ${served.reason}`);
    }
  } else {
    // Scenario 2: recovery did not produce the asset. The original invariant applies in
    // full — refuse before listening, and name the file plus the command that builds it.
    if (exitCode === 0) failures.push('command exited 0 while the browser client is still missing — it must refuse');
    for (const needle of ['app.html', 'npm --prefix packages/graph run build']) {
      if (!out.includes(needle)) failures.push(`failure message does not name ${JSON.stringify(needle)}`);
    }
  }

  // The no-silent-blank-page invariant is about OUR command, so the port check only
  // applies to the failure scenario. In the recovery scenario `graph` is a foreground
  // serve command: rebuilding and then serving is the correct outcome, so it is still
  // listening when execFileSync's timeout returns, and killing it is cleanup rather than
  // a finding. The port is also NOT a reliable identity check on its own -- an unrelated
  // process (observed here: Google Chrome, holding both 8819 and a freshly chosen 8877)
  // can occupy any high port, so a bare `lsof -ti:<port>` hit must never be reported as
  // our leaked listener. Match on the command line instead.
  // Reporting, using the pre-sample snapshot. Serving after a successful rebuild is
  // correct for a foreground serve command, so it is only a failure when the client was
  // still missing -- which is the invariant this script exists to protect.
  if (!rebuilt && leaked.length) {
    failures.push(`a listener was left on ${PORT} despite the missing client: ${leaked.join(',')}`);
  }

  if (!failures.length) {
    console.log(rebuilt
      ? `rebuilt the missing client on demand (exit ${exitCode}), left no listener on ${PORT}`
      : `refused with exit ${exitCode}, named the asset and the build command, started no listener`);
  }
} finally {
  if (fs.existsSync(rebuiltStash)) fs.rmSync(rebuiltStash);
  if (fs.existsSync(stash)) {
    // B-5a15:F-383 -- single atomic restore. An earlier version did rmSync(asset) first,
    // which opened an interruption window that did not exist before it. renameSync
    // overwrites its destination, so no pre-delete is needed.
    fs.renameSync(stash, asset);
  }
}

if (failures.length) {
  console.error('MISSING_ASSET_HANDLING_BROKEN');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('MISSING_ASSETS_HANDLED_OK');
