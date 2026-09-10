/** Verify on-demand client recovery through owned live servers, without a fixed wait. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
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
let interrupted = null;
const onInterrupt = signal => { interrupted = signal; };
const onSigint = () => onInterrupt('SIGINT');
const onSigterm = () => onInterrupt('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);
function checkInterrupted() { if (interrupted) throw new Error(`graph verifier interrupted by ${interrupted}`); }
assert.ok(!fs.existsSync(stash) && !fs.existsSync(rebuiltStash), 'Refusing to overwrite an interrupted verifier backup');
fs.renameSync(asset, stash);
function startOwnedServer() {
  const child = spawn(process.execPath, ['bin/proof-or-stop.js', 'graph', '--no-open', `--port=${PORT}`],
    { cwd: repo, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', error = null, closed = false;
  child.stdout.on('data', d => { log += String(d); });
  child.stderr.on('data', d => { log += String(d); });
  child.on('error', e => { error = e; });
  const close = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  const alive = () => {
    if (!child.pid) return false;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0); return true; }
    catch (e) { if (e.code === 'ESRCH') return false; throw e; }
  };
  const signal = sig => {
    if (!child.pid) return;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, sig); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
  };
  return { child, get log() { return log; }, get error() { return error; }, get closed() { return closed; },
    ready: () => log.split('\n').some(line => line.trim().replace(/^\[\d+(?:\.\d+)?s\] /, '') === `graph serving http://localhost:${PORT}/`),
    async stop() {
      signal('SIGTERM');
      const grace = Date.now() + 2000;
      while (alive() && Date.now() < grace) await new Promise(r => setTimeout(r, 25));
      if (alive()) signal('SIGKILL');
      const deadline = Date.now() + 5000;
      while ((!closed || alive()) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
      if (!closed || alive()) throw new Error('owned graph process group did not exit');
      await close;
    }
  };
}
const pause = () => new Promise(r => setTimeout(r, 50));
async function serveAndFetch() {
  const owned = startOwnedServer();
  try {
    const deadline = Date.now() + 90_000;
    let body = null, status = 0;
    const tail = () => ` -- child output: ${owned.log.trim().split('\n').slice(-6).join(' | ')}`;
    while (Date.now() < deadline) {
      checkInterrupted();
      if (owned.error) return { ok: false, reason: `could not spawn the server: ${owned.error.message}` };
      if (owned.closed || owned.child.exitCode !== null) return { ok: false, reason: `server exited early with code ${owned.child.exitCode}${tail()}` };
      if (!owned.ready()) { await pause(); continue; }
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))) });
        status = res.status; body = await res.text(); break;
      } catch { await pause(); }
    }
    if (body === null) return { ok: false, reason: `server never answered on the port${tail()}` };
    if (status !== 200) return { ok: false, reason: `GET / returned ${status}${tail()}` };
    if (body.length < 1000 || !/<(script|div|body)/i.test(body)) return { ok: false, reason: `GET / returned ${body.length} bytes with no client markup` };
    if (!fs.existsSync(asset)) return { ok: false, reason: 'served a page but assets/app.html was never rebuilt' };
    if (body !== fs.readFileSync(asset, 'utf8')) return { ok: false, reason: 'GET / does not match the rebuilt app.html bytes' };
    return { ok: true };
  } finally { await owned.stop(); }
}

try {
  const owned = startOwnedServer();
  let out = '', exitCode = 1, leaked = [];
  try {
    const deadline = Date.now() + 60_000;
    while (!owned.ready() && !owned.closed && !owned.error && Date.now() < deadline) { checkInterrupted(); await pause(); }
    checkInterrupted();
    out = owned.log;
    exitCode = owned.child.exitCode ?? 1;
    // Observe listeners BEFORE cleanup. Only this newly created process group is
    // ours; unrelated listeners on the same port must never be killed or blamed.
    if (owned.child.pid) {
      let pids = [];
      try { pids = execFileSync('lsof', ['-t', '-iTCP:' + PORT, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/).filter(Boolean); }
      catch (e) { if (e.status !== 1) throw e; }
      leaked = pids.filter(pid => {
        try { return Number(execFileSync('ps', ['-p', pid, '-o', 'pgid='], { encoding: 'utf8' }).trim()) === owned.child.pid; }
        catch { return false; }
      });
    }
    if (owned.error) failures.push(`could not spawn the server: ${owned.error.message}`);
    if (!owned.ready() && !owned.closed && !owned.error) failures.push('server startup exceeded 60000 ms');
  } finally { await owned.stop(); }

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
  // listening when readiness is observed, and stopping it is cleanup rather than
  // a finding. The port is also NOT a reliable identity check on its own -- an unrelated
  // process (observed here: Google Chrome, holding both 8819 and a freshly chosen 8877)
  // can occupy any high port, so a bare `lsof -ti:<port>` hit must never be reported as
  // our leaked listener. Match the owned process group instead.
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
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  if (fs.existsSync(rebuiltStash)) fs.rmSync(rebuiltStash);
  if (fs.existsSync(stash)) {
    // B-5a15:F-383 -- single atomic restore. An earlier version did rmSync(asset) first,
    // which opened an interruption window that did not exist before it. renameSync
    // overwrites its destination, so no pre-delete is needed.
    fs.renameSync(stash, asset);
  }
}

checkInterrupted();
if (failures.length) {
  console.error('MISSING_ASSET_HANDLING_BROKEN');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
assert.deepEqual(fs.readFileSync(asset),original,'Restore the exact original asset');
console.log('MISSING_ASSETS_HANDLED_OK');

// The refusal branch must run even after normal on-demand recovery succeeds.
await import('./verify-missing-client-no-listener.mjs');
