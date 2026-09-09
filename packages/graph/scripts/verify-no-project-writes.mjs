/**
 * Proves the graph tool writes nothing into the repository it inspects.
 *
 * MEASURES THE EFFECT, NOT THE CALL. Four earlier versions of this guard failed, and the
 * progression is worth keeping because each failure was a different lesson:
 *
 *   v1-v3 scanned source text and were defeated by renaming. The class was never
 *   "single-letter alias" but "the guard trusts the identifier's name", so every rename
 *   moved the instance and left the trust intact. Provenance is not lexical.
 *
 *   v4 instrumented the fs APIs in-process. An independent review host showed two holes:
 *   `search/worker.ts` runs buildIndex in a WORKER THREAD, a separate isolate whose module
 *   registry the parent's patch cannot reach — and the probe never even entered that
 *   branch, because a fresh cache takes the synchronous path while the long-lived server
 *   (the primary mode) rebuilds through the worker on every content change. The guard
 *   exercised the path production never uses and was blind to the one it does.
 *
 * So this observes the filesystem itself. A real scan runs in a SUBPROCESS — so worker
 * threads, child processes, streams and sqlite's own writes are all in scope — and the
 * repository must be byte-identical afterwards. Any write primitive shows up because the
 * effect is measured rather than the call.
 *
 * Note the completeness trap this replaces: v4's fail-closed branch fired only on TOTAL
 * silence, so a partial blind spot reported OK while the probe watched its three honest
 * writes. Here the assertion is over the repository state, which has no partial form.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.resolve(here, '..');
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: pkgRoot, encoding: 'utf8' }).trim();

const STRUCTURAL_PRUNED = /(^|\/)(node_modules|dist|\.git)(\/|$)/;
const STATE_DIR_VOLATILE = /^(?:\.proof-or-stop|\.lattice)\/(?:activity\.jsonl$|(?:[^/]+\/)*[^/]+\.lock\/|(?:runtime|locks|traces|usage|learning)\/|artifacts\/baseline\/|benchmarks\/memory-playbook\/|story\/actives\/[^/]+\/(?:activity\.jsonl$|owner-lease\.json$|takeover-count\.json$|gate-failure-counts\.json$|breaker-state\.json$|causal-evidence\/))/;
const ROOT_VOLATILE = /^(?:docs\/story\/activity\.jsonl|\.proof-or-stop-serve\.json|proof-or-stop-debug\.log|browser-test\.log|\.proof-or-stop-tmp-[^/]+(?:\/.*)?)$/;
const shouldPrune = (rel) => STRUCTURAL_PRUNED.test(rel) || STATE_DIR_VOLATILE.test(rel) || ROOT_VOLATILE.test(rel);

/* Regression contract for the validator race seen in B-7abb. These files are
   runtime-owned and may change while this subprocess is running; ordinary Story
   evidence, source, and ignored graph assets must remain measured. */
const expectedRuntimePrunes = [
  '.proof-or-stop/activity.jsonl',
  '.proof-or-stop/runtime/validation-traces/B-7abb.jsonl',
  '.proof-or-stop/locks/validation-capacity.lock/heartbeat.json',
  '.proof-or-stop/story/actives/B-7abb/review-runs.json.lock/holder.json',
  '.proof-or-stop/story/actives/B-7abb/activity.jsonl',
  '.proof-or-stop/story/actives/B-7abb/owner-lease.json',
  '.proof-or-stop/story/actives/B-7abb/breaker-state.json',
  '.lattice/story/actives/B-7abb/gate-failure-counts.json',
];
const expectedMeasuredPaths = [
  '.proof-or-stop/story/actives/B-7abb/index.json',
  '.proof-or-stop/dev-memory/experience.jsonl',
  'packages/graph/assets/index.html',
  'packages/main/src/index.ts',
];
const missedRuntime = expectedRuntimePrunes.filter((rel) => !shouldPrune(rel));
const hiddenProject = expectedMeasuredPaths.filter((rel) => shouldPrune(rel));
if (missedRuntime.length || hiddenProject.length) {
  console.error('INVALID_PROJECT_WRITE_SNAPSHOT_BOUNDARY');
  for (const rel of missedRuntime) console.error(`  volatile runtime path still measured: ${rel}`);
  for (const rel of hiddenProject) console.error(`  project path incorrectly pruned: ${rel}`);
  process.exit(1);
}

/* CONTENT digest, not git status entry states. `git status` compares entry STATES: a file
   already listed as ` M` stays ` M` when its bytes change during the scan, so the review
   host appended to an already-dirty CLAUDE.md and the previous version reported
   byte-identical. Hashing every path's bytes closes that and the ignored-file gap together. */
const snapshot = () => {
  /* Two passes. `--exclude-standard` alone was a DETECTION REGRESSION the review host
     caught: it hides every gitignored path, so `.proof-or-stop/**` and this package's own
     `assets/` were not hashed at all — precisely where a write would matter. Dropping the
     flag outright is not the answer either: node_modules then floods the list past git's
     own output buffer. So pass one takes tracked plus non-ignored untracked files, and pass
     two adds ignored paths while pruning the dependency and build trees that are not part
     of the repository's meaningful state.

     KNOWN BOUNDARY: writes under dependency/build/VCS trees or paths classified as volatile
     by packages/main/src/core/runtime-artifact-registry.ts are not detected. The latter
     includes validator sidecars, locks, activity logs, owner leases, breaker counters and
     causal-receipt caches under either accepted state-directory spelling. Those paths can
     change while this command is running, so including them would attribute the surrounding
     validator's heartbeat to the graph scan. They are also excluded from material hashes and
     the DONE dirty-tree predicate; ordinary Story evidence remains measured. The executable
     contract above pins both halves so this boundary cannot silently widen to Story evidence,
     source, or ignored graph assets. */
  const run = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  const listed = [...new Set([
    ...run(['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
    ...run(['ls-files', '-z', '--others', '--ignored', '--exclude-standard']),
  ])].filter(p => !shouldPrune(p));
  const hash = createHash('sha256');
  for (const rel of listed.sort()) {
    hash.update(rel);
    hash.update('\0');
    try { hash.update(fs.readFileSync(path.join(repo, rel))) }
    catch { hash.update('<unreadable>') }
  }
  return { digest: hash.digest('hex'), count: listed.length, paths: listed };
};

/* Exercise the synchronous cold-cache build in a SUBPROCESS, so any write primitive --
   worker threads, child processes, streams, sqlite -- lands inside the measured window,
   PROVIDED it completes before the subprocess exits.

   HONEST COVERAGE BOUNDARY: this does NOT exercise the worker-thread rebuild. That branch
   needs two ensure() calls on one live instance more than statThrottleMs (1500ms) apart WITH
   a repo content change between, and this driver deliberately does not mutate the repository
   it is asserting about. An earlier version printed "both index paths exercised"; the review
   host disproved it with a canary in the compiled worker.

   Do NOT read the subprocess boundary as an unconditional promise that a worker write would
   be caught. The host identified two conditions I had left unstated: app.close() only closes
   the db handle and the worker is unref()'d, so a worker still writing at subprocess exit is
   killed and its write may never land inside the measured window; and a completed worker
   write is only visible if its path is one this digest hashes. The boundary helps, but no
   worker is spawned here, so it is an untested capability under unstated conditions -- not a
   demonstrated one. */
const driver = `
import { createApp } from ${JSON.stringify(path.join(pkgRoot, 'dist', 'index.js'))};
const repo = ${JSON.stringify(repo)};
const cache = ${JSON.stringify(path.join(os.tmpdir(), `graph-write-probe-${process.pid}`, 'index.db'))};
const app = createApp({ root: repo });
const cold = createApp({ root: repo, dbPath: cache });
const g = cold.getGraph();
cold.getGraphBuffer(); cold.getStatus();
if (g.stories.length) cold.getStoryBuffer(g.stories[0].id);
cold.getSearchBuffer('graph', 5);
app.getGraph(); app.getStatus(); app.getSearchBuffer('worker', 3);
await new Promise(r => setTimeout(r, 2500));   // let any spawned index worker finish
cold.close(); app.close();
`;
const driverPath = path.join(os.tmpdir(), `graph-write-driver-${process.pid}.mjs`);
fs.writeFileSync(driverPath, driver);

const before = snapshot();
try {
  execFileSync('node', [driverPath], { cwd: repo, encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] });
} finally {
  fs.rmSync(driverPath, { force: true });
  fs.rmSync(path.join(os.tmpdir(), `graph-write-probe-${process.pid}`), { recursive: true, force: true });
}
const after = snapshot();

if (before.digest !== after.digest) {
  const beforeSet = new Set(before.paths);
  const added = after.paths.filter(p => !beforeSet.has(p));
  console.error('UNEXPECTED_PROJECT_WRITE');
  console.error("  A real scan changed the inspected repository. The graph command must write");
  console.error("  only its index cache, outside the repo, so DONE's clean-tree gate cannot be");
  console.error('  sabotaged by the tool that reports on it.');
  if (added.length) for (const p of added) console.error(`    new file: ${p}`);
  else console.error('    content of an existing tracked/untracked file changed during the scan');
  process.exit(1);
}

console.log(`repository byte-identical across a full scan (${before.count} paths hashed)`);
console.log('coverage: synchronous cold-cache build in a subprocess; worker-thread rebuild NOT exercised');
console.log('NO_PROJECT_WRITES_OK');
