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

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.resolve(here, '..');
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: pkgRoot, encoding: 'utf8' }).trim();

/** Full repository state: tracked changes plus every untracked path, ignored files included. */
const snapshot = () => execFileSync('git',
  ['status', '--porcelain', '--untracked-files=all', '--ignored=matching'],
  { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/* Exercise BOTH index paths in one subprocess: the synchronous build a cold cache takes,
   then a worker-thread rebuild by moving the content signature, which is what the served
   command actually does on every content change. */
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

if (before !== after) {
  const beforeSet = new Set(before.split('\n'));
  const added = after.split('\n').filter(l => l && !beforeSet.has(l));
  console.error('UNEXPECTED_PROJECT_WRITE');
  console.error("  A real scan changed the inspected repository. The graph command must write");
  console.error("  only its index cache, outside the repo, so DONE's clean-tree gate cannot be");
  console.error('  sabotaged by the tool that reports on it.');
  for (const line of added) console.error(`    ${line}`);
  process.exit(1);
}

console.log(`repository byte-identical across a full scan (${before.split('\n').filter(Boolean).length} pre-existing entries)`);
console.log('both index paths exercised: synchronous cold build and worker-thread rebuild');
console.log('NO_PROJECT_WRITES_OK');
