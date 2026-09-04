/** HTTP shell: routes only. All decisions live in core/app.ts. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { App } from '../core/app.js';

export interface ServeOptions {
  readonly app: App;
  readonly port: number;
  readonly assetDir: string;
  readonly vendorDir?: string;
}

const json = (res: http.ServerResponse, obj: unknown, code = 200): void => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': b.length, 'Cache-Control': 'no-store',
  });
  res.end(b);
};

const sendFile = (res: http.ServerResponse, p: string, type: string, cache: string): boolean => {
  if (!fs.existsSync(p)) return false;
  const b = fs.readFileSync(p);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': b.length, 'Cache-Control': cache });
  res.end(b);
  return true;
};

/* Browser-ready vendor bundles, served from assets/ (populated by
   scripts/build-web.mjs) and falling back to node_modules when running from a
   source checkout. Keeping them local is what makes the page work offline.

   Every entry is optional: the page feature-detects each one, so a missing
   bundle degrades a feature rather than breaking the shell. The .mjs entries
   are ES modules and are loaded with dynamic import(), not <script>. */
const VENDOR: Record<string, {
  name: string; asset: string; module?: readonly string[]; cache?: string;
}> = {
  '/vendor/d3.min.js':
    { name: 'd3', asset: 'd3.min.js', module: ['d3', 'dist', 'd3.min.js'] },
  '/vendor/mermaid.min.js':
    { name: 'mermaid', asset: 'mermaid.min.js', module: ['mermaid', 'dist', 'mermaid.min.js'] },
  '/vendor/gsap.min.js':
    { name: 'gsap', asset: 'gsap.min.js', module: ['gsap', 'dist', 'gsap.min.js'] },
  '/vendor/mediabunny.min.mjs':
    { name: 'mediabunny', asset: 'mediabunny.min.mjs', module: ['mediabunny', 'dist', 'bundles', 'mediabunny.min.mjs'] },
  '/vendor/gifenc.esm.js':
    { name: 'gifenc', asset: 'gifenc.esm.js', module: ['gifenc', 'dist', 'gifenc.esm.js'] },
  '/vendor/gif-palette.js':
    { name: 'GIF palette mapper', asset: 'gif-palette.js', cache: 'no-store' },
  '/vendor/gif-encoder.worker.js':
    { name: 'GIF encoder worker', asset: 'gif-encoder.worker.js', cache: 'no-store' },
};

export function startServer(o: ServeOptions): Promise<http.Server> {
  const { app, assetDir } = o;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    try {
      /* /story/<id> is the story-dossier deep link. It serves the same shell:
         the client reads the path at boot and opens the dossier over the graph,
         so the page needs no second HTML asset and works offline the same way. */
      if (u.pathname === '/' || u.pathname === '/index.html' || /^\/story\/[^/]+$/.test(u.pathname)) {
        if (sendFile(res, path.join(assetDir, 'app.html'), 'text/html; charset=utf-8', 'no-store')) return;
        res.writeHead(500); return res.end('app.html missing — run npm run build');
      }
      if (u.pathname === '/favicon.ico') {
        /* Inline SVG favicon. Without a handler every page load logged a 404 in
           the console, which makes real errors harder to notice. */
        const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
          '<circle cx="16" cy="16" r="13" fill="#2d5fa8"/>' +
          '<circle cx="16" cy="16" r="5" fill="#f4f5f7"/></svg>';
        res.writeHead(200, { 'content-type': 'image/svg+xml',
          'cache-control': 'public, max-age=86400' });
        return res.end(icon);
      }
      const vendored = VENDOR[u.pathname];
      if (vendored) {
        const cands = [
          path.join(assetDir, vendored.asset),
          o.vendorDir && vendored.module ? path.join(o.vendorDir, ...vendored.module) : '',
        ].filter(Boolean);
        for (const c of cands)
          if (sendFile(res, c, 'text/javascript; charset=utf-8',
            vendored.cache ?? 'public, max-age=86400')) return;
        res.writeHead(404); return res.end(`${vendored.name} not installed`);
      }
      if (u.pathname === '/api/graph') {
        const b = app.getGraphBuffer();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': b.length, 'Cache-Control': 'no-store' });
        return res.end(b);
      }
      if (u.pathname === '/api/status') return json(res, app.getStatus());
      if (u.pathname === '/api/story') {
        const id = u.searchParams.get('id') ?? '';
        const b = app.getStoryBuffer(id, u.searchParams.get('raw') ?? undefined);
        if (!b) return json(res, { error: 'unknown story', id }, 404);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': b.length, 'Cache-Control': 'no-store' });
        return res.end(b);
      }
      if (u.pathname === '/api/search') {
        const q = u.searchParams.get('q') ?? '';
        const b = app.getSearchBuffer(q, Number(u.searchParams.get('limit')) || undefined);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': b.length, 'Cache-Control': 'no-store' });
        return res.end(b);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, () => resolve(server));
  });
}
