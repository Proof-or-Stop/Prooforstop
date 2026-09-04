/**
 * Index-rebuild worker.
 *
 * Rebuilding the FTS index takes ~4s of synchronous SQLite work. Running it on the
 * main thread — even deferred with setTimeout — blocks the event loop and showed up
 * as multi-second request spikes, because this repo's live stories rewrite findings
 * every few seconds. A worker keeps the server answering throughout.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { buildIndex } from './fn.js';

interface Job { readonly root: string; readonly dbPath: string; readonly sig: string }

const job = workerData as Job;
try {
  const res = buildIndex(job.root, job.dbPath, job.sig);
  parentPort?.postMessage({ ok: true, ...res });
} catch (e) {
  parentPort?.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
