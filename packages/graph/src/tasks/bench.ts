/**
 * Latency benchmark. Run against any Proof-or-Stop repo:
 *   node dist/tasks/bench.js [root]
 *
 * Every endpoint should stay in single-digit milliseconds warm. The costs this
 * guards against, all measured on a 367-story repo:
 *   - resolveStories re-running per call (47ms x3 per request)
 *   - contentHash/liveHash walking ~8k files twice (134ms + 59ms)
 *   - reading + parsing a 72MB digest file for a 3-row sample (420ms)
 *   - snippet() over the whole match set instead of the final page (56ms)
 *   - a CASE-based ORDER BY forcing a full sort of 10k matches (28ms)
 *   - rebuilding the FTS index on the main thread (4s event-loop stall)
 */
import path from 'node:path';
import { createApp } from '../core/app.js';
import { findRoot } from '../io/find-root.js';

const pct = (a: number[], p: number): number => a[Math.min(a.length - 1, Math.floor(a.length * p))]!;

function time(label: string, fn: () => unknown, n: number, budgetMs: number): boolean {
  const s: number[] = [];
  for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(); s.push(performance.now() - t0) }
  s.sort((a, b) => a - b);
  const p50 = pct(s, 0.5), p95 = pct(s, 0.95);
  const ok = p95 <= budgetMs;
  console.log(`  ${ok ? 'ok  ' : 'SLOW'} ${label.padEnd(30)} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms (budget ${budgetMs}ms)`);
  return ok;
}

function main(): void {
  const probe = process.argv[2] ? { root: path.resolve(process.argv[2]) } : findRoot(process.cwd());
  if (!probe.root) { console.error('bench: no Proof-or-Stop root found'); process.exitCode = 1; return }
  const app = createApp({ root: probe.root });
  const g = app.getGraph();               // warm
  const ids = g.stories.map(s => s.id);
  const heavy = [...g.stories].sort((a, b) => (b.nFind || 0) - (a.nFind || 0))[0]!.id;
  console.log(`bench · ${g.stories.length} stories · ${g.edges.length} edges\n`);

  let ok = true;
  ok = time('getGraph (warm)', () => app.getGraph(), 50, 5) && ok;
  ok = time('getGraphBuffer (warm)', () => app.getGraphBuffer(), 50, 5) && ok;
  ok = time('getStatus', () => app.getStatus(), 50, 5) && ok;
  ok = time('search (warm cache)', () => app.getSearchBuffer('quorum', 20), 50, 5) && ok;
  ok = time('story buffer (warm)', () => app.getStoryBuffer(heavy), 50, 10) && ok;
  let i = 0;
  ok = time('story buffer (cold sweep)', () => app.getStoryBuffer(ids[i++ % ids.length]!), Math.min(ids.length, 200), 40) && ok;
  const words = ['quorum','receipt','gate','worktree','envelope','ledger','topology','inventory',
                 'dispatch','reviewer','evidence','intent','scope','freeze','breaker','lease'];
  let j = 0;
  ok = time('search (cold, distinct)', () => app.searchStories(words[j++ % words.length]!, 20), words.length, 120) && ok;

  app.close();
  if (!ok) { console.error('\nbench: at least one budget exceeded'); process.exitCode = 1 }
  else console.log('\nbench PASS');
}

main();
