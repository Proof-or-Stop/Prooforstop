/**
 * Proves the served browser client actually answers, end to end.
 *
 * Starts the real CLI command on a port confirmed free, then requires the HTML
 * document and all three API routes to respond with the shapes the page depends on.
 * A free port is chosen deliberately: the default 8731 may be held by an unrelated
 * standalone server, and curling that would produce a false pass that proves nothing
 * about this build.
 */
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const PORT = Number(process.env.GRAPH_VERIFY_PORT ?? 8814);

const portFree = p => {
  try {
    execFileSync('lsof', ['-ti', `:${p}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return false;                     // lsof found a holder
  } catch { return true }             // non-zero exit: nothing listening
};

if (!portFree(PORT)) {
  console.error(`PORT_BUSY: ${PORT} is already in use; set GRAPH_VERIFY_PORT to a free port.`);
  console.error('  Refusing to curl a port held by something else — that would be a false pass.');
  process.exit(1);
}

const get = url => execFileSync('curl', ['-sS', '--max-time', '20', url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const child = spawn('node', ['bin/proof-or-stop.js', 'graph', '--no-open', `--port=${PORT}`],
  { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });

const failures = [];
try {
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (Date.now() > deadline) { failures.push('server never came up within 90s'); break }
    try { get(`http://localhost:${PORT}/`); break } catch { /* not listening yet */ }
    // Brief pause between attempts: a tight spawn loop burns CPU for no benefit
    // while the server binds.
    try { execFileSync('sleep', ['0.2']) } catch { /* best effort */ }
  }

  if (!failures.length) {
    const html = get(`http://localhost:${PORT}/`);
    if (!html.startsWith('<!doctype html')) failures.push('/ did not return an HTML document');

    const graph = JSON.parse(get(`http://localhost:${PORT}/api/graph`));
    if (!Array.isArray(graph.stories) || graph.stories.length === 0) failures.push('/api/graph returned no stories');
    if (!Array.isArray(graph.edges)) failures.push('/api/graph returned no edges array');

    const status = JSON.parse(get(`http://localhost:${PORT}/api/status`));
    if (typeof status.stories !== 'number') failures.push('/api/status has no story count');

    const search = JSON.parse(get(`http://localhost:${PORT}/api/search?q=graph`));
    if (!Array.isArray(search.rows)) failures.push('/api/search returned no rows array');

    if (!failures.length) {
      console.log(`/            → HTML document (${html.length} bytes)`);
      console.log(`/api/graph   → ${graph.stories.length} stories, ${graph.edges.length} edges`);
      console.log(`/api/status  → ${status.stories} stories, ${status.indexRows} indexed rows`);
      console.log(`/api/search  → ${search.rows.length} hits for "graph"`);
    }
  }
} catch (e) {
  failures.push(`request failed: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  child.kill('SIGINT');
}

if (failures.length) {
  console.error('SERVES_BROKEN');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('SERVES_OK');
