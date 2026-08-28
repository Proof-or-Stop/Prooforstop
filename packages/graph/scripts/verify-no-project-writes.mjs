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
  { file: 'core/search/fn.ts', target: 'tmpPath', reason: 'removes a stale pid-suffixed temp file derived from dbPath' },
  { file: 'core/search/fn.ts', target: 'tmp, dbPath', reason: 'atomic rename of the pid-suffixed temp onto the cache path' },
];

/* CLASS rule, not a blocklist. An allowlisted target must be SELF-EVIDENTLY cache-derived:
   its text must mention dbPath, or tmp/tmpPath (which are themselves built from dbPath one
   line below the mkdir). A previous version paired the file with an exact target string and
   additionally rejected the literal identifiers root/projectRoot/repoRoot — the review host
   showed that still passed a single-letter alias like `f` holding a root-derived path, and
   that each fix here had narrowed the demonstrated hole rather than the class. Requiring
   positive evidence of cache derivation closes the class: an alias that does not name the
   cache path cannot be allowlisted at all, whatever it is called. */
const CACHE_DERIVED = /\b(dbPath|tmpPath|tmp)\b/;

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
  /* Take the write call's own argument list, not the whole line: a call nested inside an
     `if (...)` would otherwise start at the enclosing condition and never match its entry. */
  const call = WRITE_CALL.exec(f.text);
  const args = call ? f.text.slice(f.text.indexOf('(', call.index) + 1) : f.text;
  if (!CACHE_DERIVED.test(args)) return true;          // no positive cache evidence -> reject
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
  const call = WRITE_CALL.exec(f.text);
  const args = call ? f.text.slice(f.text.indexOf('(', call.index) + 1) : f.text;
  const why = ALLOWED.find(a => f.rel === a.file && args.startsWith(a.target))?.reason ?? '';
  console.log(`  ${f.rel}:${f.line} — ${why}`);
}
console.log('NO_PROJECT_WRITES_OK');
