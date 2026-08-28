#!/usr/bin/env node
/**
 * proof-or-stop-graph — run inside any Proof-or-Stop repository.
 * Collects stories, builds the index, serves the graph, opens the browser.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../core/app.js';
import { startServer } from '../../io/http.js';
import { openBrowser } from '../../io/open-browser.js';
import { findRoot } from '../../io/find-root.js';
import { DEFAULTS } from '../../core/machine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..', '..', '..');

interface Args {
  root?: string; port?: number; open: boolean; help: boolean; json: boolean;
}

function parse(argv: readonly string[]): Args {
  const a: Args = { open: true, help: false, json: false };
  for (const t of argv) {
    if (t === '--help' || t === '-h') a.help = true;
    else if (t === '--no-open') a.open = false;
    else if (t === '--json') a.json = true;
    else if (t.startsWith('--port=')) a.port = Number(t.slice(7));
    else if (t.startsWith('--root=')) a.root = t.slice(7);
    else if (!t.startsWith('-') && !a.root) a.root = t;
  }
  return a;
}

const HELP = `
proof-or-stop-graph — interactive story + evidence graph

Usage
  proof-or-stop-graph [root] [options]

Options
  --root=<dir>   Repository to read (default: nearest Proof-or-Stop root from cwd)
  --port=<n>     HTTP port (default: ${DEFAULTS.port})
  --no-open      Do not launch a browser
  --json         Print status as JSON and exit (no server)
  -h, --help     Show this help

Reads story state from .proof-or-stop/story/actives and .lattice/story/actives,
preferring each story's linked git worktree, which holds its live state from PLAN onward.
`.trim();

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (args.help) { console.log(HELP); return }

  const probe = args.root ? { root: path.resolve(args.root), reason: 'explicit --root' } : findRoot(process.cwd());
  if (!probe.root) {
    console.error(`proof-or-stop-graph: ${probe.reason}`);
    console.error('Run it inside a Proof-or-Stop repository, or pass --root=<dir>.');
    process.exitCode = 1;
    return;
  }

  const app = createApp({ root: probe.root, onLog: m => console.log(`  ${m}`) });

  if (args.json) {
    console.log(JSON.stringify(app.getStatus(), null, 2));
    app.close();
    return;
  }

  console.log(`\n  proof-or-stop-graph`);
  console.log(`  root: ${app.root}`);
  const t0 = Date.now();
  const st = app.getStatus();
  console.log(`  ${st.stories} stories · ${st.edges} relations · ${st.indexRows} indexed rows (${Date.now() - t0}ms)`);

  const port = args.port ?? DEFAULTS.port;
  let server;
  try {
    server = await startServer({
      app, port,
      assetDir: path.join(PKG_ROOT, 'assets'),
      vendorDir: path.join(PKG_ROOT, 'node_modules'),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  cannot listen on port ${port}: ${msg}`);
    console.error(`  try --port=${port + 1}`);
    app.close();
    process.exitCode = 1;
    return;
  }

  const url = `http://localhost:${port}/`;
  console.log(`  ${url}\n`);
  if (args.open) openBrowser(url);

  const shutdown = (): void => {
    console.log('\n  stopping…');
    server.close();
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
