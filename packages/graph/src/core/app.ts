/**
 * Application assembly: one object that owns caching and rebuild policy.
 * Platform-agnostic — no HTTP, no process, no fs beyond the core modules.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import crypto from 'node:crypto';
import type { StoryGraph, StoryDetail, SearchHit } from './data.js';
import { DEFAULTS } from './machine.js';
import { getScan, contentHash, type Scan } from './store/fn.js';
import { buildGraph } from './graph/fn.js';
import { storyDetail } from './detail/fn.js';
import { openIndex, search, type OpenedIndex } from './search/fn.js';

export interface AppOptions {
  readonly root: string;
  readonly dbPath?: string;
  readonly onLog?: (msg: string) => void;
}

export interface Status {
  readonly root: string;
  readonly stories: number;
  readonly edges: number;
  readonly contentHash: string;
  readonly liveHash: string;
  readonly indexRows: string | null;
  readonly indexBuiltAt: string | null;
}

export function createApp(opts: AppOptions) {
  const root = path.resolve(opts.root);
  // Cache lives OUTSIDE the inspected repo: Proof-or-Stop gates DONE on a clean
  // worktree, so a tool-owned cache file must never dirty the tree it inspects.
  const dbPath = opts.dbPath ?? path.join(
    os.homedir(), '.cache', 'proof-or-stop-graph',
    `${path.basename(root)}-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 12)}`,
    'index.db',
  );
  const log = opts.onLog ?? (() => {});

  // Serialised-response caches, keyed on the signature of what they render.
  const storyCache = new Map<string, { sig: string; buf: Buffer }>();
  // Typing re-issues the same prefixes constantly, so cache serialised results
  // until the indexed content changes.
  const searchCache = new Map<string, { sig: string; buf: Buffer }>();
  let graphBuf: { sig: string; buf: Buffer } | null = null;
  let graph: StoryGraph | null = null;
  let gContent: string | null = null;
  let gLive: string | null = null;
  let ix: OpenedIndex | null = null;
  let lastCheck = 0;
  let rebuilding = false;

  /** Refresh only what actually moved. Throttled so we don't re-stat on every request. */
  function ensureScan(): Scan { return getScan(root) }

  function ensure(): { content: string; live: string } {
    const now = Date.now();
    if (graph && ix && now - lastCheck < DEFAULTS.statThrottleMs) {
      return { content: gContent!, live: gLive! };
    }
    lastCheck = now;
    const scan = ensureScan();
    const content = scan.contentHash;
    const live = scan.liveHash;

    // graph is cheap (~150-350ms): refresh when either signature moves
    if (gContent !== content || gLive !== live || !graph) {
      const t0 = Date.now();
      graph = buildGraph(root);
      gContent = content; gLive = live;
      log(`graph ${Date.now() - t0}ms (${graph.stories.length} stories, ${graph.edges.length} edges)`);
    }
    // The index costs ~2.5s to rebuild. Requests must never wait for it: on the
    // first call we build synchronously (there is nothing to serve yet), but after
    // that a content change schedules a background rebuild and the existing index
    // keeps answering. Live stories rewrite findings constantly, so a blocking
    // rebuild otherwise showed up as multi-second request spikes.
    if (!ix) {
      ix = openIndex(root, dbPath, content);
      if (ix.rebuilt && ix.built) log(`index built: ${ix.built.rows} rows in ${ix.built.ms}ms`);
    } else if (ix.contentHash !== content && !rebuilding) {
      // Rebuild in a worker: the same work on this thread blocks the event loop for
      // seconds and stalls every concurrent request.
      rebuilding = true;
      const sig = content;
      const workerUrl = new URL('./search/worker.js', import.meta.url);
      const w = new Worker(fileURLToPath(workerUrl), { workerData: { root, dbPath, sig } });
      w.once('message', (m: { ok: boolean; rows?: number; ms?: number; error?: string }) => {
        if (m.ok) {
          try {
            const prev = ix;
            ix = openIndex(root, dbPath, sig);      // cheap: the db is already built
            try { prev?.db.close() } catch { /* ignore */ }
            log(`index rebuilt: ${m.rows} rows in ${m.ms}ms (worker)`);
          } catch (e) {
            log(`index reopen failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else log(`index rebuild failed: ${m.error}`);
      });
      const done = (): void => { rebuilding = false };
      w.once('error', e => { log(`index worker error: ${e.message}`); done() });
      w.once('exit', done);
      w.unref();
    }
    return { content, live };
  }

  return {
    root,
    dbPath,
    getGraph(): StoryGraph & { contentHash: string; liveHash: string } {
      const { content, live } = ensure();
      return { ...graph!, contentHash: content, liveHash: live };
    },
    getStory(id: string, raw?: string): StoryDetail | null {
      ensure();
      return storyDetail(root, id, raw ? { raw } : {});
    },
    /** Pre-serialised story JSON, cached until that story's own files change. */
    getStoryBuffer(id: string, raw?: string): Buffer | null {
      const scan = ensureScan();
      const sig = (scan.perStory.get(id) ?? '') + (raw ?? '');
      const hit = storyCache.get(id + '|' + (raw ?? ''));
      if (hit && hit.sig === sig) return hit.buf;
      const d = storyDetail(root, id, raw ? { raw } : {});
      if (!d) return null;
      const buf = Buffer.from(JSON.stringify(d));
      storyCache.set(id + '|' + (raw ?? ''), { sig, buf });
      if (storyCache.size > 40) storyCache.delete(storyCache.keys().next().value as string);
      return buf;
    },
    /** Pre-serialised graph JSON, cached until any signature moves. */
    getGraphBuffer(): Buffer {
      const { content, live } = ensure();
      const sig = content + live;
      if (graphBuf && graphBuf.sig === sig) return graphBuf.buf;
      const buf = Buffer.from(JSON.stringify({ ...graph!, contentHash: content, liveHash: live }));
      graphBuf = { sig, buf };
      return buf;
    },
    searchStories(q: string, limit?: number): SearchHit[] {
      ensure();
      return search(ix!.db, q, limit);
    },
    /** Pre-serialised search response, cached until indexed content changes. */
    getSearchBuffer(q: string, limit: number | undefined): Buffer {
      const { content } = ensure();
      const key = `${q}|${limit ?? ''}`;
      const hit = searchCache.get(key);
      if (hit && hit.sig === content) return hit.buf;
      const t0 = Date.now();
      const rows = search(ix!.db, q, limit);
      const buf = Buffer.from(JSON.stringify({ q, ms: Date.now() - t0, n: rows.length, rows }));
      searchCache.set(key, { sig: content, buf });
      if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value as string);
      return buf;
    },
    getStatus(): Status {
      const { content, live } = ensure();
      const meta: Record<string, string> = {};
      for (const r of ix!.db.prepare('SELECT k,v FROM meta').all() as { k: string; v: string }[]) meta[r.k] = r.v;
      return {
        root, stories: graph!.stories.length, edges: graph!.edges.length,
        contentHash: content, liveHash: live,
        indexRows: meta.rows ?? null, indexBuiltAt: meta.builtAt ?? null,
      };
    },
    close(): void { try { ix?.db.close() } catch { /* noop */ } },
  };
}

export type App = ReturnType<typeof createApp>;
