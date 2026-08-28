/**
 * Proves the graph tool writes nothing into the repository it inspects.
 *
 * WHY THIS IS A RUNTIME CHECK, NOT A SOURCE SCAN. Three earlier versions of this guard
 * scanned the source text and each was defeated, because provenance is not a lexical
 * property. The last one required a write target to be *named* dbPath/tmpPath/tmp, which
 * an independent review host defeated with `const tmpPath = path.join(root, '.evil.json')`
 * — a name-matching, root-derived path. Worse, the rule punished honest naming (a genuine
 * cache write called `indexFile` was rejected) and so actively pressured a developer toward
 * the exact rename that defeats it. The class was never "single-letter alias"; it was "the
 * guard trusts the identifier's name."
 *
 * So this asserts the property actually being claimed: with fs write APIs instrumented, a
 * real full scan — graph build, FTS index build, story serialisation, search — must direct
 * every write under the user cache directory and none into the inspected repository.
 */
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// Patch the SAME module record the package resolves. Importing 'fs' here while the package
// imports 'node:fs' yields distinct namespaces, and the probe silently observes nothing --
// caught by the fail-closed NO_WRITES_OBSERVED branch below rather than passing vacuously.
const fs = (await import('node:fs')).default;

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const here = path.dirname(new URL(import.meta.url).pathname);
const { createApp } = await import(path.join(here, '..', 'dist', 'index.js'));

/** Every write the run attempts, as an absolute path. */
const attempted = [];
const record = (target) => {
  if (typeof target === 'string' || Buffer.isBuffer(target)) attempted.push(path.resolve(String(target)));
  else if (target instanceof URL) attempted.push(path.resolve(target.pathname));
};

// Instrument every write-shaped fs API the package could reach.
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync',
                    'renameSync', 'copyFileSync', 'createWriteStream', 'openSync', 'truncateSync']) {
  const original = fs[name];
  if (typeof original !== 'function') continue;
  fs[name] = function instrumented(...args) {
    // openSync only writes when its flag says so; everything else here is a write by nature.
    if (name !== 'openSync' || /[wa+]/.test(String(args[1] ?? ''))) record(args[0]);
    if (name === 'renameSync') record(args[1]);
    return original.apply(this, args);
  };
}

// A FRESH cache path, so the run must actually create and populate the index. Reusing an
// existing cache means no writes occur and the probe observes nothing.
const probeCache = path.join(os.tmpdir(), `graph-write-probe-${process.pid}`, 'index.db');
const app = createApp({ root: repo, dbPath: probeCache });
const graph = app.getGraph();
app.getGraphBuffer();
app.getStatus();
if (graph.stories.length > 0) app.getStoryBuffer(graph.stories[0].id);
app.getSearchBuffer('graph', 5);
app.close();

const inRepo = attempted.filter(p => p === repo || p.startsWith(repo + path.sep));
if (inRepo.length) {
  console.error('UNEXPECTED_PROJECT_WRITE');
  console.error('  A real scan wrote into the inspected repository. The graph command must');
  console.error('  write only its index cache, outside the repo, so DONE\'s clean-tree gate');
  console.error('  cannot be sabotaged by the tool that reports on it.');
  for (const p of [...new Set(inRepo)]) console.error(`    ${p}`);
  process.exit(1);
}
if (attempted.length === 0) {
  console.error('NO_WRITES_OBSERVED — the probe recorded nothing, so it proves nothing.');
  console.error('  Expected at least the index cache directory creation. Instrumentation is broken.');
  process.exit(1);
}
console.log(`observed ${attempted.length} write(s), ${new Set(attempted).size} distinct, none inside the repo`);
console.log(`repo: ${repo}`);
fs.rmSync(path.dirname(probeCache), { recursive: true, force: true });
console.log('NO_PROJECT_WRITES_OK');
