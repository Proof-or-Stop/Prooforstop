/**
 * Proves the graph tool needs no runtime-artifact-registry entry.
 *
 * `proof-or-stop serve` writes a discovery file (.lattice-serve.json) into the project,
 * which is why that path is registered in packages/main/src/core/runtime-artifact-registry.ts
 * with materialHash:'exclude' -- otherwise it would perturb the material hash that signed
 * evidence is bound to. The graph command deliberately writes NO such file: its only
 * filesystem write is the index cache, which lives under the user cache directory.
 *
 * This check enumerates every write call in the runtime source (excluding src/tasks, which
 * are developer self-checks that never run inside the served command) and asserts each one
 * is a cache-directory write rather than a project write. It fails if a new write path is
 * introduced without revisiting the registry question.
 */
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const srcRoot = path.resolve(here, '..', 'src');

const WRITE_CALL = /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|mkdir|rmSync|unlinkSync|renameSync|copyFileSync)\s*\(/;

/* Write calls that are known-good because they target the out-of-repo index cache.
   Keyed by file AND by the argument text of the write, because a file-only allowlist is
   vacuous: an independent review host demonstrated that adding
   `fs.writeFileSync(path.join(root, '.lattice-graph.json'), ...)` to the allowed
   core/search/fn.ts passed this check while it printed "resolves under the user cache
   dir" against a write into the project root. Each entry must name a target expression
   that is derived from dbPath (the cache path), never from `root`. */
const ALLOWED = [
  { file: 'core/search/fn.ts', target: 'path.dirname(dbPath)', reason: 'creates the index cache directory' },
  { file: 'core/search/fn.ts', target: 'f', reason: 'removes a stale pid-suffixed temp file derived from dbPath' },
  { file: 'core/search/fn.ts', target: 'tmp, dbPath', reason: 'atomic rename of the pid-suffixed temp onto the cache path' },
];

/** Reject any write whose first argument mentions a project-root identifier. */
const ROOT_DERIVED = /\b(root|projectRoot|repoRoot)\b/;

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});

const found = [];
for (const abs of walk(srcRoot)) {
  const rel = path.relative(srcRoot, abs);
  if (rel.startsWith('tasks' + path.sep)) continue;   // developer self-checks, not served code
  if (!/\.(ts|mjs|js)$/.test(rel)) continue;
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
    if (WRITE_CALL.test(line)) found.push({ rel, line: i + 1, text: line.trim() });
  });
}

const unexpected = found.filter((f) => {
  // A write is acceptable only when its FILE and its TARGET ARGUMENT are both allowlisted,
  // and the target never mentions a project-root identifier.
  const args = f.text.slice(f.text.indexOf('(') + 1);
  if (ROOT_DERIVED.test(args)) return true;
  return !ALLOWED.some(a => f.rel === a.file && args.startsWith(a.target));
});

if (unexpected.length) {
  console.error('UNEXPECTED_PROJECT_WRITE');
  console.error('  A new filesystem write appeared in the served runtime source. If it writes');
  console.error('  into the inspected project, it needs a runtime-artifact-registry entry the');
  console.error('  way .lattice-serve.json has one. Confirm where it writes, then either move');
  console.error('  it under the cache dir or add it to ALLOWED with a reason.');
  for (const u of unexpected) console.error(`    ${u.rel}:${u.line}  ${u.text}`);
  process.exit(1);
}

console.log(`write paths in served runtime source: ${found.length}`);
for (const f of found) {
  const args = f.text.slice(f.text.indexOf('(') + 1);
  const why = ALLOWED.find(a => f.rel === a.file && args.startsWith(a.target))?.reason ?? '';
  console.log(`  ${f.rel}:${f.line} — ${why}`);
}
console.log('NO_PROJECT_WRITES_OK');
