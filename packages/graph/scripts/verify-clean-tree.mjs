/**
 * Proves the graph tool does not dirty the repository it inspects.
 *
 * Proof-or-Stop gates DONE on a clean worktree, so a visualizer that wrote into the
 * tree it reads would sabotage the very lifecycle it exists to display. Two claims
 * are checked against a real run:
 *
 *   1. the resolved index database path is outside the inspected repository, and
 *   2. `git status --porcelain` is byte-identical before and after a full scan.
 *
 * The run is a real one: it builds the graph, opens/builds the FTS index and
 * serialises a story, which is every write path the server exercises per request.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createApp } from '../dist/index.js';

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const status = () => execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });

const before = status();
/* A FRESH cache path, so the scan below must actually build the index rather than reading a
   warm one. With the default cache this check measured almost nothing: an existing index
   means no rebuild fires, so an independent review host found it passing with a planted
   project-root write present (B-3e16). Same defect class as the write guard's earlier
   versions -- a probe that exercises no write path proves nothing about writes. */
const probeCache = path.join(os.tmpdir(), `graph-clean-tree-probe-${process.pid}`, 'index.db');
const app = createApp({ root: repo, dbPath: probeCache });

const failures = [];

const dbPath = path.resolve(app.dbPath);
if (dbPath.startsWith(repo + path.sep)) {
  failures.push(`index db is INSIDE the inspected repo: ${dbPath}`);
}

// Exercise every write path a request touches: graph build, index build, story read.
const graph = app.getGraph();
app.getGraphBuffer();
app.getStatus();
if (graph.stories.length > 0) app.getStoryBuffer(graph.stories[0].id);
app.getSearchBuffer('graph', 5);
app.close();

const after = status();
if (before !== after) {
  failures.push('git status changed across the run');
  failures.push(`  before: ${before.length} bytes`);
  failures.push(`  after:  ${after.length} bytes`);
}

fs.rmSync(path.dirname(probeCache), { recursive: true, force: true });

const realDefault = createApp({ root: repo });
const defaultDbPath = path.resolve(realDefault.dbPath);
/* Assert the DEFAULT path, not just the probe's. The startsWith check above guards
   app.dbPath, which is the pid-scoped tmpdir probe and therefore tautologically outside the
   repo — a branch that can never fire. The review host showed the script still exited 0
   under a real violation, leaving enforcement resting entirely on the immutable evidence
   pin and invisible to anyone running this standalone. This makes the script fail on its
   own for the property it claims to check. */
if (defaultDbPath === repo || defaultDbPath.startsWith(repo + path.sep)) {
  failures.push(`default index db is INSIDE the inspected repo: ${defaultDbPath}`);
}
console.log(`index db: ${defaultDbPath}`);
realDefault.close();

if (failures.length) {
  console.error('CLEAN_TREE_VIOLATED');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`scanned ${graph.stories.length} stories, ${graph.edges.length} relations`);
/* Assert and print the PROPERTY, not the path. The evidence pin used to match the literal
   `~/.cache` prefix, which broke the moment this probe moved to a pid-scoped temp cache and
   silently demoted CHK-005's receipt to a non-mechanical attestation. A stable claim about
   the property survives changes to where the probe happens to put its cache. */
console.log(`index db resolved OUTSIDE the inspected repo: ${dbPath}`);
/* Also print the DEFAULT cache location the app would use unprobed. The evidence pin for
   CHK-005 matches this line, and the pin is immutable by design — an author who could
   rewrite a pin to fit changed output would defeat the mechanism. The probe above uses a
   pid-scoped temp cache to force a cold build, so this reports what a real run resolves. */

console.log('CLEAN_TREE_OK');
