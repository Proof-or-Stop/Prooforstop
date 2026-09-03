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

  const rebuilt = fs.existsSync(asset);

  if (rebuilt) {
    // Scenario 1: on-demand recovery. The handler rebuilt the client, so the command is
    // allowed to have served. What must NOT happen is serving without the asset.
    if (!out.includes('building browser client') && !out.includes('graph serving')) {
      failures.push('client was rebuilt but the command never reported building or serving');
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
  const ours = (pid) => {
    try {
      return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
        .includes('proof-or-stop');
    } catch { return false }
  };
  let held = [];
  try {
    held = execFileSync('lsof', ['-ti', `:${PORT}`], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] })
      .split('\n').filter(Boolean).filter(ours);
  } catch { /* nothing listening */ }

  if (rebuilt) {
    for (const pid of held) { try { process.kill(Number(pid), 'SIGKILL') } catch { /* already gone */ } }
  } else if (held.length) {
    failures.push(`a listener was left on ${PORT} despite the missing client: ${held.join(',')}`);
  }

  if (!failures.length) {
    console.log(rebuilt
      ? `rebuilt the missing client on demand (exit ${exitCode}), left no listener on ${PORT}`
      : `refused with exit ${exitCode}, named the asset and the build command, started no listener`);
  }
} finally {
  fs.renameSync(stash, asset);
}

if (failures.length) {
  console.error('MISSING_ASSET_HANDLING_BROKEN');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('MISSING_ASSETS_HANDLED_OK');
