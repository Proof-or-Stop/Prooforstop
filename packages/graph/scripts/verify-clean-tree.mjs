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
import { createApp } from '../dist/index.js';

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const status = () => execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });

const before = status();
const app = createApp({ root: repo });

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

if (failures.length) {
  console.error('CLEAN_TREE_VIOLATED');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`scanned ${graph.stories.length} stories, ${graph.edges.length} relations`);
console.log(`index db: ${dbPath}`);
console.log('CLEAN_TREE_OK');
